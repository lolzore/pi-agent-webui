/*
 * Pi Agent WebUI bridge.
 *
 * Spawns one `pi --mode rpc` subprocess per connected browser tab and relays
 * JSON lines between the browser (WebSocket) and the agent (stdin/stdout).
 * Also serves the static WebUI and a small HTTP API for session discovery.
 *
 * Env vars:
 *   PORT           HTTP/WS port                (default 3080)
 *   PI_COMMAND     agent command line          (default "pi --mode rpc")
 *                  e.g. "node mock_agent.js" for testing without a real pi install
 *   WORKSPACE_DIR  cwd for the agent process   (default cwd, /workspace in Docker)
 *   PI_SESSION_DIR session dir for listing     (default ~/.pi/agent/sessions)
 *   PI_WEBUI_HOST  bind address                (default: bridge/lan.json, then 127.0.0.1)
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');   // streaming gzip for the session transcript response
/* Shared JSON reply. It only needs the response, so it lives at module scope
 * now that the route modules use it too (issue #54). */
function jsonOut(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
const { StringDecoder } = require('string_decoder');
const { spawn, execFile, execSync } = require('child_process');
const { pathToFileURL } = require('url');
const { WebSocketServer, WebSocket } = require('ws');
const { startWhisper, stopWhisper, whisperStatus, WHISPER_MODELS, DEFAULT_MODEL } = require('./whisper_boot');
const agentSource = require('./agent-source');

const PORT = parseInt(process.env.PORT || '3080', 10);
// Localhost by default. The agent behind this bridge runs commands on this
// machine and there is no authentication, so exposing the bridge to the LAN is
// an explicit decision, not the default. It is made in bridge/lan.json next to
// the bridge code: { "lan": true } binds every interface, { "host": "192.168.x.y" }
// binds one specific one. The PI_WEBUI_HOST env var still wins over the file
// (it is the explicit override for scripts and Docker).
const LAN_CONFIG_FILE = process.env.PI_WEBUI_LAN || path.join(__dirname, 'lan.json');

function lanHostFromConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(LAN_CONFIG_FILE, 'utf8'));
    if (typeof cfg.host === 'string' && cfg.host.trim()) return cfg.host.trim();
    if (cfg.lan === true) return '0.0.0.0';
  } catch { /* no file or bad JSON: stay local */ }
  return null;
}

// The address another device on the network should type in.
function lanUrl(port) {
  const ip = lanAddress();
  return ip ? `http://${ip}:${port}` : null;
}

// Move the listening socket between localhost and the network without a restart.
// Existing connections are dropped on purpose: they were opened on the old
// address, and the page reconnects on its own.
let rebinding = false;
let rebindTarget = null;
// Where the socket is bound right now. Comparing against HOST (the value from the
// environment at startup) made switching back to localhost a no-op: HOST was
// still 127.0.0.1 while the server was actually on 0.0.0.0.
let boundHost = null;   // set right after HOST is defined

/* Move the listening socket to another address. A request that arrives while a
 * move is already running is remembered and applied straight after it, never
 * dropped: flipping the switch twice in quick succession used to lose the second
 * flip (the config file said "off" while the socket was still on the network),
 * which is the other half of "sometimes I have to click twice". */
function rebind(host) {
  rebindTarget = host;
  if (rebinding) return;
  rebinding = true;
  const step = () => {
    const target = rebindTarget;
    rebindTarget = null;
    if (target == null) { rebinding = false; return; }
    if (target === boundHost) { step(); return; }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      server.listen(PORT, target, () => { bindNow(target); step(); });
    };
    try { if (server.closeAllConnections) server.closeAllConnections(); } catch { /* older node */ }
    server.close(() => done());
    // A socket that refuses to close must not wedge the queue.
    setTimeout(done, 2000);
  };
  step();
}
function bindNow(host) {
  boundHost = host;
  console.log(`listening on ${host}:${PORT}${host === '0.0.0.0' ? ` (network: ${lanUrl(PORT) || 'no address'})` : ' (this machine only)'}`);
}

// First non-internal IPv4 address, so the startup banner can show the other
// devices on the LAN the address to type in (null when there is none).
function lanAddress() {
  try {
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const i of ifaces || []) {
        if (i.family === 'IPv4' && !i.internal) return i.address;
      }
    }
  } catch { /* no interface info */ }
  return null;
}

const HOST = process.env.PI_WEBUI_HOST || lanHostFromConfig() || '127.0.0.1';
boundHost = HOST;
/* The agent command: PI_COMMAND wins, then the saved pi location
 * (bridge/agent-source.txt), then a native pi (issue #157). */
const PI_COMMAND = agentSource.command();
// PI_WEBUI_DEBUG_RPC=1 logs every RPC in and out together with the session
// changes around it. Off by default; it is the fastest way to see what a client
// asked for and in which session it was answered.
const DEBUG_RPC = process.env.PI_WEBUI_DEBUG_RPC === '1';
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || process.cwd();
/* The directory the agent process is *started* in on this machine. With
 * PI_COMMAND="docker exec -i <ctr> pi --mode rpc" the workspace is a path inside
 * that container ("/workspace"), and the shell this bridge spawns through cannot
 * change into it: the spawn fails with ENOENT and no agent ever starts - which
 * looked like a Docker problem with sessions, because the UI simply stayed
 * empty. The host side only needs a directory that exists. */
function hostSpawnDir() {
  try { if (fs.statSync(WORKSPACE_DIR).isDirectory()) return WORKSPACE_DIR; } catch { /* not here */ }
  return __dirname;
}
// pi's config dir (~/.pi/agent): models.json / settings.json / auth.json live
// here. pi itself names the variable PI_CODING_AGENT_DIR; this bridge grew up
// with PI_AGENT_DIR, so both are read - pi's own first, because when they
// disagree the one that decides what pi actually loads is pi's (issue #56).
const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR
  || path.join(os.homedir(), '.pi', 'agent');
// Session dir for listing. Either a normal path, or "docker:<container>:<path>"
// to list sessions inside a container via `docker exec` (used when the pi
// agent runs in an existing container, e.g. PI_COMMAND="docker exec -i ctr pi --mode rpc").
// pi's own PI_CODING_AGENT_SESSION_DIR is honoured, then the bridge's
// PI_SESSION_DIR, then the agent dir's sessions/.
const SESSION_DIR = agentSource.sessionDir() || path.join(PI_AGENT_DIR, 'sessions');
// Same thing, as a list and never a docker spec - used to bound session
// export/delete to files that really are session files.
const SESSION_DIRS = SESSION_DIR.startsWith('docker:') ? [] : [SESSION_DIR];
const PI_MODELS_FILE = path.join(PI_AGENT_DIR, 'models.json');
const PI_SETTINGS_FILE = path.join(PI_AGENT_DIR, 'settings.json');

// Where uploads (attachments + chat backgrounds) live.
// start-webui.bat runs the bridge from bridge\, while a manual `node server.js`
// from the repo root uses the root - so both are accepted, and reads look in
// both. Writes always go to the first (the primary) directory.
const UPLOAD_DIRS = (() => {
  const seen = new Set();
  const out = [];
  for (const d of [path.join(WORKSPACE_DIR, 'uploads'), path.resolve(WORKSPACE_DIR, '..', 'uploads')]) {
    if (!seen.has(d)) { seen.add(d); out.push(d); }
  }
  return out;
})();

/* What an uploaded file is served back as. A <video> will not play without a
 * type it recognises, and the filename keeps the original extension. */
const PI_AUTH_FILE = path.join(PI_AGENT_DIR, 'auth.json');
/* Where goal-x keeps its goal files for this workspace (PI_GOALS_DIR overrides
 * it for tests). See readGoalRecord() for the file format. */
const GOALS_DIR = process.env.PI_GOALS_DIR || path.join(WORKSPACE_DIR, '.pi', 'goals');
const WEB_DIR = path.join(__dirname, '..', 'web');

/* The build the page is served as: the newest (mtime, size) across web/. It is
 * the cache-buster in index.html's asset URLs and the value /api/health reports,
 * so a long-lived tab can notice the bridge was updated under it (issue #89).
 * app.js alone was not enough: a stylesheet change with app.js untouched left
 * the old CSS in the browser, which is exactly the mixed-version layout the
 * issue reported. */
function webBuild() {
  try {
    let newest = 0, total = 0;
    for (const f of fs.readdirSync(WEB_DIR)) {
      let st;
      try { st = fs.statSync(path.join(WEB_DIR, f)); } catch { continue; }
      if (!st.isFile()) continue;
      newest = Math.max(newest, Math.round(st.mtimeMs));
      total += st.size;
    }
    return newest + '-' + total;
  } catch { return null; }
}
let whisperUrl = null; // set once the local whisper STT server (if any) is up
function parseSessionDir() {
  if (SESSION_DIR.startsWith('docker:')) {
    const rest = SESSION_DIR.slice('docker:'.length);
    const i = rest.indexOf(':');
    return { container: rest.slice(0, i), dir: rest.slice(i + 1) };
  }
  return null;
}

// ---------------------------------------------------------------- builtin slash commands

// Fallback list mirroring pi's BUILTIN_SLASH_COMMANDS, used only if the installed
// pi package can't be located. The live list is loaded from the package so new
// commands pi adds in future releases show up automatically.
const FALLBACK_BUILTIN_COMMANDS = [
  { name: 'settings', description: 'Open settings menu' },
  { name: 'model', description: 'Select model', argumentHint: '<provider/model>' },
  { name: 'tree', description: 'Navigate session tree (switch branches)' },
  { name: 'thinking', description: 'Set thinking level', argumentHint: '<level>' },
  { name: 'scoped-models', description: 'Enable/disable models for Ctrl+P cycling' },
  { name: 'export', description: 'Export session (HTML default, or .jsonl)' },
  { name: 'import', description: 'Import and resume a session from JSONL' },
  { name: 'share', description: 'Share session as a secret GitHub gist' },
  { name: 'copy', description: 'Copy last agent message to clipboard' },
  { name: 'name', description: 'Set session display name', argumentHint: '<name>' },
  { name: 'session', description: 'Show session info and stats' },
  { name: 'changelog', description: 'Show changelog entries' },
  { name: 'hotkeys', description: 'Show all keyboard shortcuts' },
  { name: 'fork', description: 'Create a new fork from a previous user message' },
  { name: 'clone', description: 'Duplicate the current session' },
  { name: 'trust', description: 'Save project trust decision' },
  { name: 'login', description: 'Configure provider authentication', argumentHint: '<provider>' },
  { name: 'logout', description: 'Remove provider authentication' },
  { name: 'new', description: 'Start a new session' },
  { name: 'compact', description: 'Manually compact the session context' },
  { name: 'resume', description: 'Resume a different session' },
  { name: 'reload', description: 'Reload keybindings, extensions, skills, prompts, themes' },
  { name: 'quit', description: 'Quit pi' },
];

// Locate the installed pi package and read its BUILTIN_SLASH_COMMANDS so the
// WebUI can offer every current (and future) command. Tries a local install,
// the global npm root, and the path implied by PI_COMMAND, then falls back.
async function loadBuiltinCommands() {
  const candidates = [];
  try { candidates.push(require.resolve('@earendil-works/pi-coding-agent/dist/core/slash-commands.js')); } catch { /* not local */ }
  try {
    const g = execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (g) candidates.push(path.join(g, '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'slash-commands.js'));
  } catch { /* no npm */ }
  try {
    const cmd0 = (PI_COMMAND.split(/\s+/)[0] || '').trim();
    if (cmd0 && !cmd0.includes(' ') && !cmd0.startsWith('docker')) {
      const which = isWin ? 'where' : 'which';
      const bin = execSync(`${which} ${JSON.stringify(cmd0)}`, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim().split(/\r?\n/)[0];
      if (bin) candidates.push(path.resolve(path.dirname(bin), '..', '..', 'dist', 'core', 'slash-commands.js'));
    }
  } catch { /* not a direct binary */ }
  for (const file of candidates) {
    try {
      const m = await import(pathToFileURL(file).href);
      if (m && Array.isArray(m.BUILTIN_SLASH_COMMANDS) && m.BUILTIN_SLASH_COMMANDS.length) {
        return m.BUILTIN_SLASH_COMMANDS.map((c) => ({
          name: c.name, description: c.description, argumentHint: c.argumentHint, source: 'builtin',
        }));
      }
    } catch { /* try next candidate */ }
  }
  return FALLBACK_BUILTIN_COMMANDS.map((c) => ({ ...c, source: 'builtin' }));
}
let builtinCommandsCache = null;

// ---------------------------------------------------------------- static + api

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/* Resolve a session path for export/delete: only real .jsonl files inside the
 * configured session directory, so a crafted request cannot read or remove
 * anything else on the machine. Returns null when it does not check out. */
function safeSessionPath(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const want = path.resolve(raw.trim());
  const roots = SESSION_DIRS.length ? SESSION_DIRS : [SESSION_DIR];
  const inside = roots.some((r) => {
    const root = path.resolve(String(r));
    return want === root || want.startsWith(root + path.sep);
  });
  if (!inside || path.extname(want).toLowerCase() !== '.jsonl') return null;
  try {
    if (!fs.statSync(want).isFile()) return null;
  } catch { return null; }
  return want;
}

/* How much of a session is base64 image data, estimated from a few windows
 * spread across the whole file.
 *
 * The windows are averaged, which is what makes this an estimate of the file
 * rather than of its worst moment. "Worst window" was the first version and it
 * turned out to be too frightened: a 21 MB session that is 77% text and whose
 * gzip saves 12 MB had one window that landed inside a picture, and taking the
 * maximum threw the compression away. The mean lands within a few percent of the
 * real figure on every real session measured, and the decision that follows
 * (which is only "is it worth the CPU") is nowhere near that precise.
 *
 * The windows are read with seek, so the file is not read twice. */
const DENSITY_WINDOWS = 8;
const DENSITY_SPAN = 48 * 1024;

async function sessionSample(ref, from, len) {
  try {
    if (ref.kind === 'docker') {
      // no seeking inside the container: take a prefix for the start of the
      // file and a suffix for the rest, which is a coarse estimate but costs two
      // small execs rather than a copy of the file.
      //
      // The suffix used to be a script - `tail -c +N '<path>' | head -c L` - which
      // put the session path inside shell text a second time (see
      // scanDockerSessions for what that cost). `tail` takes the offset as an
      // argument and the length is applied here, so there is no pipeline and no
      // script: the path is only ever argv.
      const head = from === 0
        ? await dockerCapture(ref.container, ['head', '-c', String(len), ref.path], 20000)
        : String(await dockerCapture(ref.container, ['tail', '-c', `+${from + 1}`, ref.path], 20000) || '').slice(0, len);
      return String(head || '');
    }
    const fh = await fs.promises.open(ref.path, 'r');
    try {
      const st = await fh.stat();
      const buf = Buffer.alloc(Math.min(len, Math.max(0, st.size - from)));
      if (!buf.length) return '';
      const { bytesRead } = await fh.read(buf, 0, buf.length, from);
      return buf.slice(0, bytesRead).toString('utf8');
    } finally { await fh.close(); }
  } catch { return ''; }
}

function base64Share(text) {
  if (!text) return 1;                 // cannot tell: assume the worst
  let bytes = 0;
  // Two ways to recognise image data, and the second one matters more:
  //
  //  - the marked form, "data": "<base64>", which is how it looks in the
  //    beginning of an image block;
  //  - a long unbroken run of base64 characters with no JSON punctuation in it.
  //
  // The original probe only looked for the marker, which made it useless: the
  // sampling windows are 48 KB and an image block is megabytes, so a window
  // almost always lands *inside* one, with the key thousands of kilobytes away in
  // a part of the file that window never saw. Measured on a real 70 MB session,
  // seven of eight windows were pure base64 and all eight reported "no images".
  //
  // 400 characters is far longer than any ordinary token - a hash is 64 hex
  // characters, a JSON key is tens - so a run that long is image data and nothing
  // else.
  const re = /"data"\s*:\s*"([A-Za-z0-9+/=]{200,})"|([A-Za-z0-9+/=]{400,})/g;
  let m;
  while ((m = re.exec(text)) !== null) bytes += (m[1] || m[2]).length;
  // base64 carries 3 bytes in 4 characters, so the source bytes are 3/4 of the
  // character count. Measured against the sample that over-counts, which is the
  // safe direction: it declines to compress rather than compressing in vain.
  return bytes ? Math.min(1, (bytes * 0.75) / text.length) : 0;
}

async function imageDensity(ref) {
  const size = await sessionSize(ref);
  if (!size) return 1;
  const span = Math.min(DENSITY_SPAN, size);
  const step = size > span ? Math.floor((size - span) / (DENSITY_WINDOWS - 1)) : 0;
  let total = 0, seen = 0;
  for (let i = 0; i < DENSITY_WINDOWS; i++) {
    const at = Math.min(Math.max(0, size - span), i * step);
    const text = await sessionSample(ref, at, span);
    if (!text) return 1;            // cannot read it: assume the worst
    total += base64Share(text);
    seen++;
  }
  return seen ? total / seen : 1;
}

async function deleteSessionRef(ref) {
  if (ref.kind === 'docker') { await dockerCapture(ref.container, ['rm', '-f', ref.path], 30000); return; }
  fs.rmSync(ref.path);
}

/* ── what a subagent wrote ───────────────────────────────────────────────
 * pi-subagents keeps one artifact set per run inside the session directory
 * (`subagent-artifacts/<runId>_<agent>_output.md`, plus `_meta.json` and a
 * transcript), and a background run keeps its working files in a run directory
 * (`…/async-subagent-runs/<runId>/output-N.log`) whose path reaches us through
 * the tool result's details.asyncDir. Both are read here, through `docker exec`
 * when the agent lives in a container, so the panel works the same either way.
 *
 * The run id is a uuid and the run directory has to sit under a pi-subagents run
 * root, so this cannot be pointed at an arbitrary file. */
const SUBAGENT_TAIL = 200 * 1024;

function tailText(text, bytes = SUBAGENT_TAIL) {
  if (!text) return '';
  if (text.length <= bytes) return text;
  const cut = text.slice(text.length - bytes);
  const nl = cut.indexOf('\n');
  return `… (showing the end of ${Math.round(text.length / 1024)} KB)
${nl >= 0 ? cut.slice(nl + 1) : cut}`;
}
const RUN_DIR_UNSAFE = /["'`$\\;|&<>(){}\[\]*?!#\r\n\u0000]/;
const RUN_DIR_SHAPE = /\/pi-subagents[^/]*\/async-subagent-runs\/[^/]+$/;

function runDirOk(p) {
  if (RUN_DIR_UNSAFE.test(p)) return false;
  if (p.split('/').includes('..')) return false;   // normalise() already removed these
  return RUN_DIR_SHAPE.test(p);
}

function runDirRef(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const remote = parseSessionDir();
  if (remote) {
    const ctr = safeContainerName(remote.container);
    if (!ctr) return null;
    const p = path.posix.normalize(raw.trim().replaceAll(String.fromCharCode(92), '/'));
    if (!p.startsWith('/') || !runDirOk(p)) return null;
    return { kind: 'docker', container: ctr, dir: p };
  }
  let p;
  try { p = path.resolve(raw.trim()); } catch { return null; }
  const asPosix = p.replaceAll(String.fromCharCode(92), '/');
  if (!runDirOk(asPosix)) return null;
  // ...and under a root this bridge would itself create
  const roots = asyncRunRoots()
    .map((r) => path.resolve(r).replaceAll(String.fromCharCode(92), '/').replace(/\/+$/, ''))
    .filter(Boolean);
  if (!roots.some((r) => asPosix.startsWith(r + '/'))) return null;
  return { kind: 'local', dir: p };
}
const RUN_CACHE = { at: 0, data: null };
const ARTIFACT_CACHE = { at: 0, names: null };
const RUN_ARTIFACT_TTL = 5000;

function runStateFromStatus(s) {
  if (!s || typeof s !== 'object') return null;
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const id = str(s.runId);
  if (!id) return null;
  const tok = s.totalTokens && typeof s.totalTokens === 'object' ? num(s.totalTokens.total) : null;
  return {
    runId: id,
    agent: str(s.agent),
    mode: str(s.mode),
    state: str(s.state),
    activityState: str(s.activityState),
    currentTool: str(s.currentTool),
    currentToolStartedAt: num(s.currentToolStartedAt),
    turnCount: num(s.turnCount) || 0,
    toolCount: num(s.toolCount) || 0,
    startedAt: num(s.startedAt),
    endedAt: num(s.endedAt),
    lastActivityAt: num(s.lastActivityAt),
    // sessionFile is the child's own session, sessionId the one it came from.
    sessionFile: str(s.sessionFile),
    sessionId: str(s.sessionId),
    sessionName: str(s.sessionName),
    model: str(s.model),
    error: str(s.error),
    totalTokens: tok ? { total: tok } : null,
    asyncDir: null,
  };
}

/* The temp root pi-subagents uses: "pi-subagents-<scope>" directories under the
 * system temp dir, or whatever PI_SUBAGENTS_TEMP_ROOT was set to. */
function asyncRunRoots() {
  const roots = [];
  const configured = (process.env.PI_SUBAGENTS_TEMP_ROOT || '').trim();
  if (configured) roots.push(path.join(configured, 'async-subagent-runs'));
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!/^pi-subagents-/.test(name)) continue;
      roots.push(path.join(os.tmpdir(), name, 'async-subagent-runs'));
    }
  } catch { /* nothing to look in */ }
  return roots;
}

/* The run status does not carry the agent name for every kind of run (workflow
 * children leave it empty); the recovery descriptor beside it always does, and
 * it repeats the child's own session file. */
function runStateFromDescriptor(st, d) {
  if (!st || !d || typeof d !== 'object') return st;
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  if (!st.agent) st.agent = str(d.agent);
  if (!st.sessionFile) st.sessionFile = str(d.sessionFile);
  return st;
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readRunDirsLocal() {
  const runs = [];
  for (const root of asyncRunRoots()) {
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { continue; }
    for (const name of dirs) {
      const dir = path.join(root, name);
      const st = runStateFromStatus(readJsonFile(path.join(dir, 'status.json')));
      if (!st) continue;
      runStateFromDescriptor(st, readJsonFile(path.join(dir, 'recovery-descriptor.json')));
      st.asyncDir = dir;
      runs.push(st);
    }
  }
  return runs;
}

async function readRunDirsDocker(remote) {
  // One exec for all of them: the loop prints a marker per file (and for the
  // recovery descriptor beside it), so the output can be split apart again.
  const sh = 'for f in /tmp/pi-subagents-*/async-subagent-runs/*/status.json; do '
    + '[ -f "$f" ] || continue; d=${f%/status.json}; printf "@@FILE %s\\n" "$d"; cat "$f"; printf "\\n"; '
    + 'if [ -f "$d/recovery-descriptor.json" ]; then printf "@@REC %s\\n" "$d"; cat "$d/recovery-descriptor.json"; printf "\\n"; fi; done 2>/dev/null';
  const out = await dockerCapture(remote.container, ['sh', '-c', sh], 20000).catch(() => '');
  const states = new Map();
  for (const chunk of String(out || '').split('@@').slice(1)) {
    const nl = chunk.indexOf(String.fromCharCode(10));
    if (nl < 0) continue;
    const head = chunk.slice(0, nl).trim();          // "FILE <dir>" or "REC <dir>"
    // The markers are not the same length ("FILE " is five characters, "REC " is
    // four) - slicing a fixed five cut the leading slash off the REC path, so the
    // descriptor was looked up under a different directory and never merged.
    const kind = head.startsWith('REC') ? 'REC' : 'FILE';
    const dir = head.slice(kind === 'REC' ? 4 : 5).trim();
    if (!dir) continue;
    const body = chunk.slice(nl + 1).split('@@')[0];
    let json = null;
    try { json = JSON.parse(body); } catch { continue; }
    if (kind === 'FILE') {
      const st = runStateFromStatus(json);
      if (st) states.set(dir, st);
    } else if (kind === 'REC') {
      const st = states.get(dir);
      if (st) runStateFromDescriptor(st, json);
    }
  }
  const runs = [];
  for (const [dir, st] of states) { st.asyncDir = dir; runs.push(st); }
  return runs;
}

/* Artifact file names are the only place the agent name of a run appears
 * (<runId>_<agent>_transcript.jsonl), so they label the rows. */
/* pi-subagents writes the artifact set next to the session it belongs to
 * (<session dir>/subagent-artifacts), which is where the agent name in
 * "<runId>_<agent>_transcript.jsonl" can be read from. */
async function artifactNamesIn(dir) {
  if (!dir) return [];
  const now = Date.now();
  const hit = ARTIFACT_CACHE.names && ARTIFACT_CACHE.names.get(dir);
  if (hit && now - hit.at < RUN_ARTIFACT_TTL) return hit.names;
  const remote = parseSessionDir();
  let names = [];
  if (remote) {
    const ctr = safeContainerName(remote.container);
    if (!ctr) return [];
    // argv again: this path is derived from a run's status.json, which lives in
    // the container and is not trusted text
    const out = await dockerRun(ctr, ['sh', '-c',
      'ls -1 "$1" 2>/dev/null', 'sh', path.posix.join(dir, 'subagent-artifacts')], 20000).catch(() => '');
    names = String(out || '').split('\n').map((x) => x.trim()).filter(Boolean);
  } else {
    try { names = fs.readdirSync(path.join(dir, 'subagent-artifacts')); } catch { names = []; }
  }
  if (!ARTIFACT_CACHE.names) ARTIFACT_CACHE.names = new Map();
  ARTIFACT_CACHE.names.set(dir, { at: now, names });
  return names;
}
function sameSessionFilePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const norm = (v) => String(v).replaceAll(String.fromCharCode(92), '/').replace(/\/+$/, '').toLowerCase();
  return !!a && !!b && norm(a) === norm(b);
}

/* ── reaching another instance from this one ─────────────────────────────
 * Switching instances used to navigate this page to the other machine. In a
 * browser that means leaving where you were; in the packaged app there is no
 * address bar, so a host that is switched off leaves you on a network error with
 * no way back. Instead the local bridge fetches on the page's behalf:
 * /proxy/<origin>/<path> is forwarded to that instance, WebSocket included, so
 * the page stays on this origin and the switcher always works.
 *
 * Only origins already listed as instances in this bridge's own settings are
 * proxied - otherwise the bridge would be an open relay for the whole network. */
function proxyTargets() {
  try {
    const st = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return (st.instances || []).map((i) => (i && i.url) || '').filter(Boolean);
  } catch { return []; }
}

function proxyBaseFor(origin) {
  let want;
  try { want = new URL(origin).origin; } catch { return null; }
  for (const u of proxyTargets()) {
    try { if (new URL(u).origin === want) return want; } catch { /* skip a bad entry */ }
  }
  return null;
}

/* "/proxy/<encoded origin>/rest" -> { base, path: "/rest" }, or null when the
 * target is not one of ours. */
function splitProxyPath(url) {
  if (typeof url !== 'string' || !url.startsWith('/proxy/')) return null;
  const rest = url.slice('/proxy/'.length);
  const i = rest.indexOf('/');
  if (i < 0) return null;
  let origin;
  try { origin = decodeURIComponent(rest.slice(0, i)); } catch { return null; }
  const base = proxyBaseFor(origin);
  return base ? { base, path: rest.slice(i) } : null;
}

// Headers that belong to one hop of a connection and must not be forwarded.
const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authorization', 'proxy-connection', 'te', 'trailer']);

function proxyHttp(req, res, base, pathAndQuery) {
  let target;
  try { target = new URL(pathAndQuery, base); } catch { res.writeHead(400).end('bad proxy target'); return; }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP_HEADERS.has(k.toLowerCase())) headers[k] = v;
  const secure = target.protocol === 'https:';
  const send = secure ? https : http;
  const upstream = send.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (secure ? 443 : 80),
    path: target.pathname + target.search,
    method: req.method,
    headers,
  }, (down) => {
    const out = {};
    for (const [k, v] of Object.entries(down.headers)) if (!HOP_HEADERS.has(k.toLowerCase())) out[k] = v;
    try { res.writeHead(down.statusCode || 502, out); } catch { /* headers already sent */ }
    down.pipe(res);
  });
  upstream.on('error', (e) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `instance unreachable: ${e.message}` }));
  });
  req.pipe(upstream);
}

/* WebSocket side of the same idea. Messages are forwarded one by one rather than
 * tunnelling bytes, which keeps ping/pong and close frames correct at both ends. */
const proxyWss = new WebSocketServer({ noServer: true });
proxyWss.on('connection', (client, req, parsed) => {
  const url = new URL(parsed.path, parsed.base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const upstream = new WebSocket(url.toString());
  const queue = [];
  upstream.on('open', () => {
    for (const m of queue) { try { upstream.send(m.data, { binary: m.binary }); } catch { /* gone */ } }
    queue.length = 0;
  });
  upstream.on('message', (data, isBinary) => {
    if (client.readyState === client.OPEN) { try { client.send(data, { binary: isBinary }); } catch { /* gone */ } }
  });
  upstream.on('close', () => { try { client.close(); } catch { /* already closing */ } });
  upstream.on('error', (e) => {
    console.warn(`proxy: ${url.origin} websocket failed: ${e.message}`);
    try { client.close(1011, 'instance unreachable'); } catch { /* already closing */ }
  });
  client.on('message', (data, isBinary) => {
    if (upstream.readyState === 1) { try { upstream.send(data, { binary: isBinary }); } catch { /* gone */ } }
    else queue.push({ data, binary: isBinary });
  });
  client.on('close', () => { try { upstream.close(); } catch { /* already closing */ } });
  client.on('error', () => { try { upstream.terminate(); } catch { /* already closed */ } });
});

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    /* decodeURIComponent throws on a malformed escape (/%ZZ, /%E0%A4%A, ...).
     * The request listener runs async, so a synchronous throw here used to
     * become an unhandled rejection that killed the whole bridge - every tab
     * and the agent. A bad URL is a 400, not a reason to stop serving. */
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('bad request');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  /* A decoded path can still contain NUL or ".." from an encoded separator:
   * "/..%2fwebui-settings.json" decodes to "/../webui-settings.json", which
   * path.normalize() turns into a sibling of WEB_DIR. A plain startsWith()
   * check accepts that sibling when its name starts with "web" (the old
   * settings file was named webui-settings.json). Compare the relative path
   * instead, so only real children of the web root are served. */
  if (!urlPath || urlPath.includes('\0')) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('bad request');
    return;
  }
  const file = path.normalize(path.join(WEB_DIR, urlPath));
  const rel = path.relative(WEB_DIR, file);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    // The UI is edited live from disk, so a stale app.js/style.css would
    // silently hide new features. Revalidate on every load: the files are tiny
    // and served from localhost, and a 304 keeps repeat loads cheap.
    if (path.extname(file) === '.html') {
      const build = webBuild();
      if (build) {
        data = Buffer.from(String(data)
          .replace(/(href|src)="([^"?/:][^"]*\.(?:css|js))"/g, `$1="$2?v=${build}"`)
          .replace('content="__BUILD__"', `content="${build}"`));
      }
    }
    const etag = `"${data.length.toString(16)}-${crypto.createHash('sha1').update(data).digest('hex').slice(0, 12)}"`;
    const headers = {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache, must-revalidate',
      'ETag': etag,
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers).end();
      return;
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

/*
 * Best-effort session discovery. Session file format may evolve, so every
 * step is defensive — worst case the file name is the title.
 */

/* (execCapture lived here - a docker helper with no callers left once
 * scanDockerSessions stopped building shell scripts. dockerRun() above is the
 * one to use: same shape, but sized for a session directory's worth of output.) */

// Extract a display title from the head of one session file's content.
/* Latest `session_info` name found scanning lines backwards (pi appends these
 * to the end of the session file, latest wins). Empty name clears the title. */
function nameFromText(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line[0] !== '{') continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e && e.type === 'session_info') {
      const n = typeof e.name === 'string' ? e.name.trim() : '';
      return n || null; // empty clears the title
    }
  }
  return null;
}

/* (nameFromTail lived here. It stat'ed and opened every session file a second
 * time just to read the tail. readSessionEdges() above reads head and tail from
 * one open, so the function went with the second read.) */

function titleFromHead(head) {
  let title = '';
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry && (entry.type === 'session' || entry.type === 'sessionStart')) {
      if (entry.name) title = entry.name;
      continue;
    }
    if (entry && entry.type === 'session_info') {
      title = typeof entry.name === 'string' ? entry.name.trim() : '';
      continue;
    }
    const msg = entry && (entry.message || entry.payload || entry);
    if (msg && msg.role === 'user') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : (Array.isArray(msg.content)
            ? msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ')
            : '');
      if (text && !title) return text.replace(/\s+/g, ' ').trim().slice(0, 80);
    }
  }
  return title;
}

/* A transcript that belongs to a subagent run rather than to a conversation:
 * pi-subagents writes one per child under `subagent-artifacts/`, and a
 * background run keeps its own `…/run-N/session.jsonl` in the temp root. They
 * are reached through the extension's own panel, not by switching to them - and
 * in the sidebar they buried every real session (all of them are called
 * `session.jsonl`, so they also matched each other on name). */
function isSubagentTranscript(p) {
  return /(^|[\\/])(subagent-artifacts|async-subagent-runs|chain-runs|subagent-results)([\\/]|$)/.test(p) || /(^|[\\/])(run|step)-\d+[\\/]/.test(p);
}

/* Read a file's head and its tail from ONE open.
 *
 * Two things were wrong with doing this the obvious way. Every session file was
 * opened twice - once for the head, once inside nameFromTail - and the whole loop
 * was strictly sequential. Profiled over 200 session files: 19.8 ms of separate
 * stat() calls, 91.9 ms for the head reads and 105.9 ms for the tail reads, which
 * is the entire ~210 ms that `GET /api/sessions` measured per call. mtime and size
 * now come from fstat on the handle already held, and the caller overlaps the
 * files instead of walking them one at a time. */
async function readSessionEdges(file, bytes = 64 * 1024) {
  let fh;
  try { fh = await fs.promises.open(file, 'r'); } catch { return null; }
  try {
    const st = await fh.stat();
    const headLen = Math.min(bytes, st.size);
    const headBuf = Buffer.alloc(headLen);
    const headRead = await fh.read(headBuf, 0, headLen, 0);
    const head = headBuf.toString('utf8', 0, headRead.bytesRead);
    // a file smaller than one window IS its own tail, exactly as nameFromTail
    // treated it - otherwise a session under 64 KB would lose its explicit name
    let tail = head;
    let tailTruncated = false;
    if (st.size > headLen) {
      const tailLen = Math.min(bytes, st.size);
      const tailBuf = Buffer.alloc(tailLen);
      const r = await fh.read(tailBuf, 0, tailLen, st.size - tailLen);
      tail = tailBuf.toString('utf8', 0, r.bytesRead);
      tailTruncated = true;
    }
    return { head, tail, tailTruncated, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  } finally {
    try { await fh.close(); } catch { /* already closed */ }
  }
}


// UI settings (appearance, agent name/avatar, voice). PI_WEBUI_SETTINGS lets a
// second instance - a test bridge, say - keep its own file instead of writing
// over the real one next to the source.
/* Where the WebUI keeps state of its own: its settings, and (below) the session
 * it was last in. Both used to live next to the bridge, which inside a container
 * is the image's writable layer - so `docker compose up` after a rebuild reset
 * every UI setting and forgot where the user was, with nothing to show for it.
 * The agent's config dir is the right home: in Docker that is exactly the
 * directory people mount as a volume (and where pi keeps its own settings), and
 * for a native bridge it is ~/.pi/agent. A file that already exists next to the
 * bridge still wins, so nobody's settings move out from under them. */
function stateFile(name) {
  const legacy = path.join(__dirname, '..', name);
  try { if (fs.existsSync(legacy)) return legacy; } catch { /* then the agent dir */ }
  try {
    fs.mkdirSync(PI_AGENT_DIR, { recursive: true });
    fs.accessSync(PI_AGENT_DIR, fs.constants.W_OK);
    return path.join(PI_AGENT_DIR, name);
  } catch { return legacy; }
}

const SETTINGS_FILE = process.env.PI_WEBUI_SETTINGS || stateFile('webui-settings.json');

// The session the agent was last in, persisted across bridge/agent restarts.
// A fresh `pi --mode rpc` always starts a brand-new empty session, and the
// bridge kills the agent when the last client leaves - so without this, every
// page refresh (old socket closes, new one opens) dropped the user into a new
// session. The bridge resumes this session whenever the agent (re)starts, and
// the WebUI keeps its own copy in localStorage as a fallback.
/* One record per agent source. A native pi and a pi inside a container keep
 * their sessions in different places and neither path means anything to the
 * other, so a single shared file made each of them try to resume into a session
 * that only existed for the other one. */
function agentSourceLabel() {
  const remote = parseSessionDir();
  if (remote) return 'docker-' + remote.container.replace(/[^A-Za-z0-9_.-]/g, '_');
  return 'native';
}
const LAST_SESSION_FILE = process.env.PI_WEBUI_LAST_SESSION
  || stateFile(`webui-last-session-${agentSourceLabel()}.json`);
// Why this is not `last-session-<source>.json` any more: that name belongs to pi
// itself. pi's CLI/TUI keeps its own "where was I" record under exactly that
// name in the agent dir, so the bridge and the CLI were writing over each other.
// Restarting the bridge then resumed whatever session the CLI last used - which
// is not the session this WebUI was in, and was sometimes a session another pi
// had open. The WebUI now keeps its own file; a browser that has been here
// before still recovers its session from localStorage, and the bridge records it
// again from the first switch.
const LEGACY_LAST_SESSION_FILE = path.join(__dirname, '..', 'last-session.json');

function readSessionRecord(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof d.path === 'string' && d.path ? d.path : null;
  } catch { return null; }
}

/* Sync check for a local path, null when it is a container path (those can only
 * be asked about with an exec, which is why the async version exists). */
function sessionFileExistsNow(p) {
  if (typeof p !== 'string' || !p.trim()) return false;
  if (parseSessionDir()) return null;
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function loadLastSession() {
  const own = readSessionRecord(LAST_SESSION_FILE);
  if (own) {
    // A record whose session is gone is worse than no record: resuming it fails,
    // and with a pi that does not answer the failed switch wedges the agent until
    // it is restarted. Drop it here instead, before anything is asked of the agent.
    if (sessionFileExistsNow(own) === false) {
      console.warn(`forgetting last session (gone): ${own}`);
      forgetLastSession();
      return null;
    }
    return own;
  }
  // If the record file was named explicitly (PI_WEBUI_LAST_SESSION), that name is
  // the whole answer: reading other names as well mixed two configurations - a
  // test bridge picking up the desktop's session, a second bridge on another port
  // resuming the first one's.
  if (process.env.PI_WEBUI_LAST_SESSION) return null;
  // Container records are ours alone (a pi inside a container keeps its own file
  // in the container's agent dir), so the old per-source name is still worth
  // reading there. The native one is skipped deliberately: it is pi's own CLI
  // record, and resuming from it is what dropped the WebUI into whichever session
  // the terminal used last instead of the one this WebUI was in.
  if (!parseSessionDir()) return null;
  // The single file used before records were split per source. Only worth reading
  // when the path in it belongs to this world: a container path means nothing to
  // a native pi, and the switch_session that followed did not fail, it hung.
  const legacy = readSessionRecord(LEGACY_LAST_SESSION_FILE);
  if (!legacy) return null;
  const containerPath = legacy.startsWith('/');
  return containerPath === !!parseSessionDir() ? legacy : null;
}

function forgetLastSession() {
  try { fs.rmSync(LAST_SESSION_FILE, { force: true }); } catch { /* nothing to forget */ }
}

function saveLastSession(p) {
  if (typeof p !== 'string' || !p) return;
  // Only ever a session belonging to *this* bridge. The record is what the agent
  // is resumed into, and it used to be able to hold a path from another world -
  // pi's own CLI session, a test bridge's file, another instance's session - and
  // resuming one of those is "it opened the wrong session" (or two pis in the
  // same session). A path outside this bridge's session dir is never recorded.
  const remote = parseSessionDir();
  const roots = remote ? [remote.dir] : SESSION_DIRS;
  const norm = (v) => String(v).replaceAll(String.fromCharCode(92), '/').replace(/\/+$/, '');
  const want = norm(p);
  const inside = roots.some((r) => {
    const root = norm(r);
    return !!root && (want === root || want.startsWith(root + '/'));
  });
  if (!inside) {
    console.warn(`not recording a session outside this bridge's session dir: ${p}`);
    return;
  }
  try {
    fs.writeFileSync(LAST_SESSION_FILE, JSON.stringify({ path: p, at: Date.now() }, null, 2) + '\n');
  } catch (e) {
    console.warn('could not save last session:', e.message);
  }
}

// Does a session file exist - locally, or inside a "docker:<ctr>:<dir>" session
// dir (the path is an absolute path inside the container)? A docker failure
// (container stopped, daemon down) reports "not found": the agent cannot start
// either in that case, so starting fresh is the right fallback.
async function sessionFileExists(p) {
  if (typeof p !== 'string' || !p.trim()) return false;
  const remote = parseSessionDir();
  if (remote) {
    const ctr = safeContainerName(remote.container);
    if (!ctr) return false;
    // This one escaped its quotes by hand - `p.replace(/'/g, "'\\''")` is the
    // correct POSIX trick, and it was the only place in the file that got it
    // right. It is still quoting to be read by a shell when it does not have to:
    // the path goes in as argv, so there is nothing left to escape. */
    return await new Promise((resolve) => {
      execFile('docker', ['exec', ctr, 'sh', '-c', 'test -f "$1"', 'sh', p],
        { timeout: 15000 }, (err) => resolve(!err));
    });
  }
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// ---------------------------------------------------------------- llama.cpp + pi config

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const LOCAL_BRIDGE_PORT_BASE = Number(process.env.PI_WEBUI_PORT_BASE || 3080);
const LOCAL_BRIDGE_PORTS = Array.from({ length: 16 }, (_, i) => LOCAL_BRIDGE_PORT_BASE + i);
const localBridgesCache = { at: 0, data: [] };

/* ── who is allowed to talk to this bridge ─────────────────────────────────
 *
 * There is no authentication, so when the bridge is on the network anyone who
 * can reach it can drive the agent - including its `bash` RPC, which is a shell on
 * this machine. That is a deliberate trade for a single-user tool, but two classes
 * of attack do not need to be able to *reach* the port at all, and both arrive
 * through a browser the user is already using (issue #23):
 *
 *  - **Cross-site request forgery.** Any page you visit can POST to
 *    http://<this-machine>:<port>/api/session-delete. CORS stops it *reading* the
 *    reply, but a POST with a side effect needs no reply. Same for the endpoints
 *    that write auth.json and models.json, and for /api/upload-raw.
 *  - **DNS rebinding.** A hostname the attacker controls, resolved to this
 *    machine's LAN address, makes the bridge same-origin with their page - so the
 *    same-origin policy stops protecting anything and they can read every session.
 *
 * Both are fixed the same way and neither needs a login:
 *
 *  - the `Host` header must be an address this bridge actually answers on, which
 *    is what rebinding cannot forge;
 *  - a write (anything but GET/HEAD/OPTIONS) must not carry an `Origin` from
 *    somewhere else. Browsers send Origin on every cross-site write, including
 *    plain form posts, so its absence means a non-browser client - curl, the
 *    desktop shell - which is not what CSRF is about.
 *
 * This is not a substitute for authentication if the machine is on a network you
 * do not trust; it closes the two holes that need no credentials to exploit.
 * PI_WEBUI_ALLOWED_HOSTS adds names for setups this cannot guess (a DNS name, a
 * reverse proxy). */
const EXTRA_ALLOWED_HOSTS = String(process.env.PI_WEBUI_ALLOWED_HOSTS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

let hostCache = { at: 0, names: null };
function allowedHostNames() {
  const now = Date.now();
  if (hostCache.names && now - hostCache.at < 30000) return hostCache.names;
  const names = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::']);
  for (const n of EXTRA_ALLOWED_HOSTS) names.add(n);
  // the machine's own names and addresses: how someone actually reaches it
  try { names.add(String(os.hostname()).toLowerCase()); } catch { /* none */ }
  try { names.add(String(os.hostname()).toLowerCase() + '.local'); } catch { /* none */ }
  try { names.add(String(os.hostname()).toLowerCase() + '.localhost'); } catch { /* none */ }
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a && a.address) names.add(String(a.address).toLowerCase());
  }
  hostCache = { at: now, names };
  return names;
}

/* The host part of a Host header, without the port and without IPv6 brackets. */
function hostOnly(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (!h) return '';
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end < 0 ? h : h.slice(1, end);
  }
  const colon = h.lastIndexOf(':');
  // a lone colon means a port; several mean an IPv6 literal without brackets
  return colon >= 0 && h.indexOf(':') === colon ? h.slice(0, colon) : h;
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/* null when the request is fine, or a short reason to log and refuse with. */
function requestRefused(req) {
  const host = hostOnly(req.headers.host);
  // A missing Host means HTTP/1.0. Browsers always send one, and it is the header
  // a rebinding attack cannot get right, so its absence is not accepted.
  if (!host) return 'no Host header';
  if (!allowedHostNames().has(host)) return `Host "${host}" is not an address this bridge answers on`;

  if (!WRITE_METHODS.has(String(req.method || '').toUpperCase())) return null;

  const origin = req.headers.origin;
  if (!origin) return null;                       // not a browser (curl, the desktop shell)
  let oHost, oProto;
  try {
    const u = new URL(String(origin));
    oHost = hostOnly(u.host);
    oProto = u.protocol;
  } catch { return `Origin "${String(origin).slice(0, 60)}" is not a URL`; }
  // Same origin as the request itself, which covers every way the UI is reached
  // (loopback, LAN address, hostname, a proxy) without having to list them.
  const selfProto = req.socket && req.socket.encrypted ? 'https:' : 'http:';
  if (oHost === host && oProto === selfProto) return null;
  return `Origin "${String(origin).slice(0, 60)}" is not this bridge`;
}

/* The endpoints that exist to be read by *another* instance's page - they are
 * declared cross-origin on purpose and say nothing private (a name, a picture, a
 * busy flag, a build id). They are still subject to the Host check, which is what
 * actually stops rebinding. */
const CROSS_ORIGIN_OK = ['/api/health', '/api/instance-card'];

/* Windows vs POSIX, shared with bridge/agent.js (issue #54 phase 11). */
const isWin = process.platform === 'win32';

/* goal-x record reading lives in goals.js (the #54 split). */
const { readGoalRecord, goalSummary } = require('./goals');

/* Route modules (issue #54): each exports { match, handle }; the handler below
 * asks them before its own routes. */
const llamaSupport = require('./llama')({
  PI_AGENT_DIR: PI_AGENT_DIR,
  PI_AUTH_FILE: PI_AUTH_FILE,
  PI_MODELS_FILE: PI_MODELS_FILE,
  PI_SETTINGS_FILE: PI_SETTINGS_FILE,
  WORKSPACE_DIR: WORKSPACE_DIR,
  fs: fs,
  os: os,
  path: path,
  readJsonSafe: readJsonSafe,
});
const {
  ALLOWED_APIS, BUILTIN_PROVIDER_IDS, MODEL_FIELDS, PROVIDER_ID_RE, authEntryKind, fetchLlamaModels,
  isLocalLlamaAddress, llamaConfiguredUrls, llamaLan, llamaLanUrls, llamaModelsCache,
  llamaServerCandidates, llamaServerIdentity, maskKey, readLlamaServerUrl,
  writeJsonAtomic, writeModelsFile,
} = llamaSupport;

const piRoutes = require('./routes/pi')({
  ALLOWED_APIS: ALLOWED_APIS,
  GOALS_DIR: GOALS_DIR,
  MODEL_FIELDS: MODEL_FIELDS,
  PI_AGENT_DIR: PI_AGENT_DIR,
  PI_MODELS_FILE: PI_MODELS_FILE,
  PI_SETTINGS_FILE: PI_SETTINGS_FILE,
  PROVIDER_ID_RE: PROVIDER_ID_RE,
  WORKSPACE_DIR: WORKSPACE_DIR,
  fs: fs,
  http: http,
  jsonOut: jsonOut,
  maskKey: maskKey,
  os: os,
  path: path,
  readJsonSafe: readJsonSafe,
  serveStatic: serveStatic,
  writeJsonAtomic: writeJsonAtomic,
  writeModelsFile: writeModelsFile,
});
const uploadRoutes = require('./routes/uploads')({
  UPLOAD_DIRS: UPLOAD_DIRS,
  crypto: crypto,
  fs: fs,
  http: http,
  path: path,
});
const mcpRoutes = require('./routes/mcp')({
  PI_AGENT_DIR: PI_AGENT_DIR,
  WORKSPACE_DIR: WORKSPACE_DIR,
  fs: fs,
  jsonOut: jsonOut,
  path: path,
  readJsonSafe: readJsonSafe,
  writeJsonAtomic: writeJsonAtomic,
});
const instanceRoutes = require('./routes/instances')({
  PI_AGENT_DIR: PI_AGENT_DIR,
  fs: fs,
  jsonOut: jsonOut,
  os: os,
  path: path,
});
/* The agent's live status, shared with the route modules (issue #54 phase 9):
 * bridge/agent.js fills this same object in when it is required at the end of
 * the file, and the session routes read it while handling a request. Declared
 * here so requiring them cannot hit its temporal dead zone. */
const agentStatus = { busy: false, sessionName: null, compacting: null };

/* The last session-scan error, shared the same way: bridge/sessions.js fills
 * this object in, /api/sessions reads it (issue #54 phase 10). */
const scanState = { lastScanError: null };

const sessionStore = require('./sessions')({
  SESSION_DIR: SESSION_DIR,
  StringDecoder: StringDecoder,
  execFile: execFile,
  fs: fs,
  isSubagentTranscript: isSubagentTranscript,
  nameFromText: nameFromText,
  parseSessionDir: parseSessionDir,
  path: path,
  readSessionEdges: readSessionEdges,
  safeSessionPath: safeSessionPath,
  spawn: spawn,
  titleFromHead: titleFromHead,
  scanState: scanState,
});
const {
  WRITE_CHUNK, breathe, dockerCapture, dockerRun, externaliseImages,
  indexGet, indexKey, indexPut, readLineAt, safeContainerName,
  scanDockerSessions, scanSessions, sessionLines, sessionRef, sessionSize,
  sessionStamp, writeStream,
} = sessionStore;

const sessionRoutes = require('./routes/sessions')({
  SESSION_DIR: SESSION_DIR,
  WRITE_CHUNK: WRITE_CHUNK,
  agentStatus: agentStatus,
  breathe: breathe,
  crypto: crypto,
  deleteSessionRef: deleteSessionRef,
  dockerCapture: dockerCapture,
  externaliseImages: externaliseImages,
  fs: fs,
  imageDensity: imageDensity,
  indexGet: indexGet,
  indexKey: indexKey,
  indexPut: indexPut,
  scanState: scanState,
  loadLastSession: loadLastSession,
  path: path,
  readLineAt: readLineAt,
  scanSessions: scanSessions,
  sessionLines: sessionLines,
  sessionRef: sessionRef,
  sessionSize: sessionSize,
  sessionStamp: sessionStamp,
  spawn: spawn,
  writeStream: writeStream,
  zlib: zlib,
});
const mediaRoutes = require('./routes/media')({
  UPLOAD_DIRS: UPLOAD_DIRS,
  fs: fs,
  path: path,
  proxyHttp: proxyHttp,
  splitProxyPath: splitProxyPath,
});
const llamaRoutes = require('./routes/llama')({
  PI_SETTINGS_FILE: PI_SETTINGS_FILE,
  fetchLlamaModels: fetchLlamaModels,
  fs: fs,
  isLocalLlamaAddress: isLocalLlamaAddress,
  llamaConfiguredUrls: llamaConfiguredUrls,
  llamaLan: llamaLan,
  llamaLanUrls: llamaLanUrls,
  llamaModelsCache: llamaModelsCache,
  llamaServerCandidates: llamaServerCandidates,
  llamaServerIdentity: llamaServerIdentity,
  path: path,
  readLlamaServerUrl: readLlamaServerUrl,
});
const subagentRoutes = require('./routes/subagents')({
  RUN_CACHE: RUN_CACHE,
  SESSION_DIR: SESSION_DIR,
  artifactNamesIn: artifactNamesIn,
  dockerCapture: dockerCapture,
  dockerRun: dockerRun,
  fs: fs,
  parseSessionDir: parseSessionDir,
  path: path,
  readRunDirsDocker: readRunDirsDocker,
  readRunDirsLocal: readRunDirsLocal,
  runDirRef: runDirRef,
  safeContainerName: safeContainerName,
  sameSessionFilePath: sameSessionFilePath,
  tailText: tailText,
});
const sourceRoutes = require('./routes/source')({
  agentSource: agentSource,
  execFile: execFile,
  jsonOut: jsonOut,
});
const systemRoutes = require('./routes/system')({
  execFile: execFile,
  fs: fs,
  path: path,
});
async function handleRequest(req, res) {
  // A client that goes away mid-response (a closed tab, a laptop lid, a Ctrl-C on
  // a long download) makes the socket's next write raise EPIPE / ECONNRESET.
  // Unhandled, that is an 'error' event on the socket with no listener, and Node
  // takes the *whole bridge* down with it - the agent, every other tab, the
  // WebSocket the agent was streaming on. It happened for real on a large
  // session-messages response, which is exactly the payload a browser abandons
  // most often: it re-requests on every reload. Nothing to do about a client
  // that left; just do not let it stop anything else.
  //
  // The listener goes on the socket, not on the response: the error is raised by
  // Socket._writeGeneric and emitted on the Socket, and a res.on('error') does
  // not see it.
  if (req.socket && !req.socket.__guarded) {
    req.socket.__guarded = true;
    req.socket.on('error', () => { /* the client went away mid-response */ });
  }
  req.on('error', () => { /* client aborted the request */ });
  req.on('aborted', () => { /* ditto */ });
  res.on('error', () => { /* ditto */ });

  /* Refuse before anything else looks at the request: a cross-site write or a
   * rebound hostname must not reach a handler, whatever the endpoint is. */
  const refused = requestRefused(req);
  if (refused) {
    const why = String(refused);
    const noisy = !/^Host /.test(why);           // a wrong Host is usually a scanner
    if (noisy) console.warn(`refused ${req.method} ${String(req.url).slice(0, 80)}: ${why}`);
    res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      error: `refused: ${why}`,
      hint: 'If you reach this bridge by a name or address not listed here, add it to PI_WEBUI_ALLOWED_HOSTS.',
    }));
    return;
  }

  if (req.url.startsWith('/api/ui-settings')) {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 2 * 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        try {
          JSON.parse(body); // validate
          fs.writeFileSync(SETTINGS_FILE, body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    } else {
      let data = {};
      try { data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { /* defaults */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    }
    return;
  }
  if (req.url.startsWith('/api/config')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      workspace: WORKSPACE_DIR,
      sessionDir: SESSION_DIR,
      command: PI_COMMAND,
      whisperUrl: whisperUrl || null,
    }));
    return;
  }
  if (req.url.startsWith('/api/builtin-commands')) {
    if (!builtinCommandsCache) builtinCommandsCache = loadBuiltinCommands();
    const commands = await builtinCommandsCache;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ commands }));
    return;
  }

  if (req.url.startsWith('/api/lan')) {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        try {
          const { lan } = JSON.parse(body || '{}');
          const cfg = { lan: !!lan };
          fs.mkdirSync(path.dirname(LAN_CONFIG_FILE), { recursive: true });
          fs.writeFileSync(LAN_CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
          const host = lan ? '0.0.0.0' : '127.0.0.1';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, lan: !!lan, host, url: lan ? lanUrl(PORT) : null,
            note: process.env.PI_WEBUI_HOST ? 'PI_WEBUI_HOST is set, so it wins on the next start' : null }));
          // Rebind only after this response is on the wire: moving the socket
          // closes the connection, and doing it first killed the answer that was
          // telling the page it had worked.
          setTimeout(() => rebind(host), 250);
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    const bound = boundHost === '0.0.0.0' || boundHost === '::' || boundHost === '::0';
    // Report what the switch was *set* to, not only what the socket is bound to
    // right now: moving the socket takes a moment, and answering from `boundHost`
    // during it told the page "it is still off" - so the checkbox flipped back
    // and the switch needed a second click. `bound` still tells the truth about
    // the socket, for anyone who needs it.
    let wanted = null;
    try { wanted = !!JSON.parse(fs.readFileSync(LAN_CONFIG_FILE, 'utf8')).lan; } catch { /* no file yet */ }
    const enabled = wanted == null ? bound : wanted;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      lan: enabled,
      bound,
      host: boundHost,
      url: enabled ? lanUrl(PORT) : null,
      pending: enabled !== bound,
      envOverride: process.env.PI_WEBUI_HOST || null,
    }));
    return;
  }

  /* One small card per instance for the switcher: the agent's name and picture, so
   * the menu can show who is who. Answers cross-origin requests (like /api/health)
   * because that is exactly how another instance is reached. */
  if (req.url.startsWith('/api/instance-card')) {
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { /* defaults */ }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({
      ok: true,
      name: settings.agentName || 'pi agent',
      avatar: settings.avatar || null,
      avatarCrop: settings.avatarCrop || null,
      session: agentStatus.sessionName || null,
      busy: agentStatus.busy,
      build: webBuild(),
    }));
    return;
  }

  /* Which other pi bridges are running on this machine (issue #57). A second
   * agent is a second bridge on another port with its own agent dir; the
   * switcher lists what it finds here so the address does not have to be typed.
   * The bridge's own port is excluded by comparing the Host header, and the
   * answer is cached for a few seconds because the UI asks on every poll. */
  if (req.url.startsWith('/api/local-instances')) {
    const ttl = 4000;
    if (localBridgesCache.at && Date.now() - localBridgesCache.at < ttl) {
      return jsonOut(res, 200, { instances: localBridgesCache.data });
    }
    const selfPort = (() => {
      try { return String(new URL('http://' + String(req.headers.host || '')).port || (req.socket && req.socket.localPort) || PORT); }
      catch { return String((req.socket && req.socket.localPort) || PORT); }
    })();
    const found = await Promise.all(LOCAL_BRIDGE_PORTS
      .filter((p) => String(p) !== selfPort)
      .map(async (p) => {
        try {
          const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(700) });
          if (!r.ok) return null;
          const d = await r.json();
          if (!d || !d.ok) return null;
          return { url: `http://127.0.0.1:${p}`, port: p, name: d.name || null, busy: !!d.busy, build: d.build || null };
        } catch { return null; }
      }));
    localBridgesCache.at = Date.now();
    localBridgesCache.data = found.filter(Boolean);
    return jsonOut(res, 200, { instances: localBridgesCache.data });
  }

  if (req.url.startsWith('/api/health')) {
    // Which build is this? Two machines on the same URL can be serving very
    // different copies of web/, and there was no way to tell them apart. The
    // whole directory is folded in, not just app.js, so a stylesheet change
    // alone also reads as a new build (issue #89).
    const build = webBuild() || 'unknown';
    // `busy` is the whole point for the multi-instance switcher: every other
    // instance polls this to show a pulsing dot while that agent is working.
    // It is the one endpoint that also answers cross-origin requests (see CORS
    // below) - it says nothing but "alive" and "working".
    const url = new URL(req.url, 'http://localhost');
    const payload = {
      ok: true,
      build,
      busy: agentStatus.busy,
      name: agentStatus.sessionName || null,
    };
    if (url.searchParams.get('verbose')) payload.whisper = whisperStatus().state;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(payload));
    return;
  }

  /* Speech through a cloud service. The browser cannot call these itself (no
   * CORS, and the API key would be in the page), so the bridge does it: it reads
   * the key from its own settings and streams the audio straight back. */
  if (req.url.startsWith('/api/tts')) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 512 * 1024) req.destroy(); });
    req.on('end', async () => {
      let inBody = {};
      try { inBody = JSON.parse(body || '{}'); } catch { /* error below */ }
      const text = String(inBody.text || '').slice(0, 8000);
      if (!text.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no text' }));
        return;
      }
      let settings = {};
      try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { /* defaults */ }
      const provider = String(inBody.provider || settings.ttsBackend || '').toLowerCase();
      const key = String(inBody.apiKey || settings.ttsApiKey || '').trim();
      const model = String(inBody.model || settings.ttsCloudModel || '').trim();
      const voice = String(inBody.voice || settings.ttsCloudVoice || '').trim();
      const base = String(inBody.baseUrl || settings.ttsCloudUrl || '').trim().replace(/\/+$/, '');
      try {
        if (!key) throw new Error('no API key set for this voice');
        let url, payload, headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
        if (provider === 'fish') {
          // Fish Audio: text + a reference id (a voice you made or picked), or the
          // model's default voice when none is given.
          url = `${base || 'https://api.fish.audio'}/v1/tts`;
          payload = { text, format: 'mp3', model: model || 's1' };
          if (voice) payload.reference_id = voice;
        } else {
          // Anything OpenAI-compatible: /v1/audio/speech with model + voice.
          url = `${base || 'https://api.openai.com'}/v1/audio/speech`;
          payload = { model: model || 'tts-1', input: text, voice: voice || 'alloy', response_format: 'mp3' };
        }
        const up = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!up.ok) {
          const detail = await up.text().catch(() => '');
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `${provider} said ${up.status}${detail ? ': ' + detail.slice(0, 300) : ''}` }));
          return;
        }
        const buf = Buffer.from(await up.arrayBuffer());
        res.writeHead(200, { 'Content-Type': up.headers.get('content-type') || 'audio/mpeg', 'Content-Length': buf.length });
        res.end(buf);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url.startsWith('/api/whisper-status')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(whisperStatus()));
    return;
  }
  if (req.url.startsWith('/api/whisper-start')) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      try {
        const { model } = JSON.parse(body || '{}');
        const url = await startWhisper(model || DEFAULT_MODEL);
        whisperUrl = url;
        res.writeHead(url ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: !!url, url, ...whisperStatus() }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }



  // Recreate a directory pi needs. A session stores the working directory it
  // was recorded in; renaming the project folder leaves that path missing and
  // pi then refuses to open the session. Allowing the folder to be put back
  // makes those sessions reachable again. Only absolute paths, and the request
  // has to come from the local UI.
  if (req.url.startsWith('/api/ensure-dir')) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      try {
        const { path: dir } = JSON.parse(body || '{}');
        if (typeof dir !== 'string' || !dir.trim()) throw new Error('path is required');
        const abs = path.resolve(dir.trim());
        if (!path.isAbsolute(abs)) throw new Error('an absolute path is required');
        const existed = fs.existsSync(abs);
        fs.mkdirSync(abs, { recursive: true });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: abs, created: !existed }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (uploadRoutes.match(req)) { await uploadRoutes.handle(req, res); return; }
  if (mcpRoutes.match(req)) { await mcpRoutes.handle(req, res); return; }
  if (instanceRoutes.match(req)) { await instanceRoutes.handle(req, res); return; }
  if (sessionRoutes.match(req)) { await sessionRoutes.handle(req, res); return; }
  if (mediaRoutes.match(req)) { await mediaRoutes.handle(req, res); return; }
  if (llamaRoutes.match(req)) { await llamaRoutes.handle(req, res); return; }
  if (subagentRoutes.match(req)) { await subagentRoutes.handle(req, res); return; }
  if (sourceRoutes.match(req)) { await sourceRoutes.handle(req, res); return; }
  if (systemRoutes.match(req)) { await systemRoutes.handle(req, res); return; }
  // Transcribe an audio file (base64 WAV) via the local whisper server.
  if (req.url.startsWith('/api/transcribe')) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    if (!whisperUrl) {
      // Started on demand: the UI may have asked for Whisper before the server
      // was up (or the bridge was restarted under it).
      whisperUrl = await startWhisper(DEFAULT_MODEL).catch(() => null);
    }
    if (!whisperUrl) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no local STT server is running', whisper: whisperStatus() }));
      return;
    }
    let body = '';
    const MAX = 256 * 1024 * 1024;
    req.on('data', (c) => { body += c; if (body.length > MAX) { req.destroy(); } });
    req.on('end', async () => {
      try {
        const { data } = JSON.parse(body || '{}');
        if (typeof data !== 'string' || !data) throw new Error('data (base64 wav) is required');
        const wav = Buffer.from(data, 'base64');
        const boundary = '----piwebui' + Date.now().toString(16);
        const head = Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\n` +
          `Content-Type: audio/wav\r\n\r\n`);
        const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
        const resp = await fetch(`${whisperUrl}/inference`, {
          method: 'POST',
          headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
          body: Buffer.concat([head, wav, tail]),
        });
        if (!resp.ok) throw new Error(`STT server ${resp.status}`);
        const d = await resp.json();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, text: d.text || d.transcription || '' }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Test a provider config (url + api + key) with a minimal completion so the
  // user can verify a provider before saving it. Reports empty responses too
  // (that was the DeepSeek /anthropic-endpoint failure mode).
  if (req.url.startsWith('/api/probe-provider')) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', async () => {
      try {
        const { baseUrl, api, apiKey, modelId } = JSON.parse(body || '{}');
        if (typeof baseUrl !== 'string' || !/^https?:\/\//i.test(baseUrl.trim())) {
          throw new Error('baseUrl must be an http(s) URL');
        }
        const base = baseUrl.trim().replace(/\/+$/, '');
        const key = apiKey || '';
        const headers = { 'Content-Type': 'application/json' };
        if (key) headers['Authorization'] = `Bearer ${key}`;
        const timeout = (ms) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return { signal: c.signal, done: () => clearTimeout(t) }; };
        // 1) model list (OpenAI-style)
        let models = [];
        try {
          const t = timeout(8000);
          const r = await fetch(`${base}/models`, { headers, signal: t.signal });
          t.done();
          if (r.ok) {
            const d = await r.json();
            models = (d.data || d.models || []).map((m) => m.id).filter(Boolean);
          }
        } catch { /* model list optional */ }
        // 2) minimal completion. No max_tokens: reasoning models (e.g.
        // deepseek-flash) spend a small budget on reasoning_content and come
        // back with empty content + finish_reason "length".
        const model = modelId || models[0] || 'gpt-4o-mini';
        let text = '', status = 0, err = null;
        try {
          const t = timeout(30000);
          const r = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers,
            signal: t.signal,
            body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with exactly: OK' }] }),
          });
          t.done();
          status = r.status;
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(`HTTP ${status}: ${(d.error && (d.error.message || d.error.type)) || r.statusText}`);
          const m0 = (d.choices && d.choices[0]) || {};
          const msg0 = m0.message || {};
          text = msg0.content || (msg0.reasoning_content ? '(reasoning only)' : '');
        } catch (e) { err = e.message; }
        const empty = !err && status === 200 && !text.trim();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: !err && !empty,
          status, error: err, empty,
          model,
          sample: text.trim().slice(0, 120) || null,
          models: models.slice(0, 50),
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Probe an arbitrary OpenAI-compatible base URL for its model list
  // (used by the "discover models" button in settings).
  if (req.url.startsWith('/api/probe-models')) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', async () => {
      try {
        const { url } = JSON.parse(body || '{}');
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
          throw new Error('url must be an http(s) base URL');
        }
        const clean = url.trim().replace(/\/+$/, '');
        const models = await fetchLlamaModels(clean);
        if (!models) throw new Error(`no models found at ${clean} (tried /v1/models and /models)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: clean, models }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // pi custom providers: read / upsert / remove entries in ~/.pi/agent/models.json
  // pi's /login stores API keys (and OAuth tokens) in auth.json, keyed by
  // provider id. Storing a key here logs the provider in; removing it logs
  // out. The agent must restart to pick up credential changes (the client
  // does that after a successful login/logout).
  if (req.url.startsWith('/api/auth-providers')) {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const auth = readJsonSafe(PI_AUTH_FILE) || {};
    // models-store.json is keyed by provider id directly (no wrapper object),
    // and mirrors the catalogs pi has cached: { "deepseek": { models: [...],
    // checkedAt, etag }, ... }. Reading it as store.providers found nothing, so
    // known providers showed up as raw ids with no catalog behind them.
    const store = readJsonSafe(path.join(PI_AGENT_DIR, 'models-store.json')) || {};
    const modelsFile = readJsonSafe(PI_MODELS_FILE) || {};
    const cached = (store && typeof store === 'object' && !Array.isArray(store)) ? store : {};
    const ids = new Set([
      ...Object.keys(auth),
      ...Object.keys(cached),
      ...Object.keys(modelsFile.providers || {}),
      ...BUILTIN_PROVIDER_IDS,
    ]);
    const providers = {};
    for (const id of ids) {
      const a = auth[id];
      const custom = (modelsFile.providers || {})[id];
      const entry = {
        name: (custom && custom.name) || (cached[id] && cached[id].name) || null,
        models: (cached[id] && Array.isArray(cached[id].models)) ? cached[id].models.length : null,
        auth: authEntryKind(a),
        keyMasked: a && typeof a.key === 'string' && a.key.length >= 4 ? `•••${a.key.slice(-4)}` : null,
        custom: !!custom,
      };
      providers[id] = entry;
    }
    const response = { file: PI_AUTH_FILE, providers };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
    return;
  }
  if (req.url.startsWith('/api/auth-login')) {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const b = JSON.parse(body || '{}');
          const id = String(b.provider || '').trim();
          const key = String(b.key || '').trim();
          if (!PROVIDER_ID_RE.test(id)) throw new Error('provider id must be 1-64 chars: letters, digits, . _ -');
          if (!key) throw new Error('API key is empty');
          const auth = readJsonSafe(PI_AUTH_FILE) || {};
          auth[id] = { type: 'api_key', key };
          try {
            writeJsonAtomic(PI_AUTH_FILE, auth);
          } catch (e) {
            throw new Error(`write failed: ${e.message}`);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, file: PI_AUTH_FILE, provider: id }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    if (req.method === 'DELETE') {
      const id = new URL(req.url, 'http://x').searchParams.get('provider') || '';
      if (!PROVIDER_ID_RE.test(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid provider id' }));
        return;
      }
      const auth = readJsonSafe(PI_AUTH_FILE) || {};
      if (!(id in auth)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `no credentials for "${id}" in auth.json` }));
        return;
      }
      // Refuse to delete entries that are not plain credentials (env blocks,
      // extra config) — deleting those would silently remove working setup.
      const kind = authEntryKind(auth[id]);
      if (kind !== 'key' && kind !== 'oauth') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `"${id}" is not an API key or OAuth login (it holds other configuration) — remove it by hand if you really mean to` }));
        return;
      }
      delete auth[id];
      try {
        writeJsonAtomic(PI_AUTH_FILE, auth);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `write failed: ${e.message}` }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, provider: id }));
      return;
    }
    res.writeHead(405).end();
    return;
  }
  if (piRoutes.match(req)) { await piRoutes.handle(req, res); return; }


  serveStatic(req, res);
}

/* One request must never be able to stop the bridge. Every route is async, and
 * an exception thrown after the await (or a synchronous throw in a helper such
 * as serveStatic's decodeURIComponent) would otherwise become an unhandled
 * rejection: Node prints it and exits, taking every tab and the agent with it.
 * Answer 500 when the response has not started, and drop the socket when it
 * has; the server keeps running either way. */
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    console.error(`request failed (${req.method} ${String(req.url).slice(0, 80)}):`, (e && e.stack) || e);
    if (!res.headersSent) {
      try { res.writeHead(500, { 'Content-Type': 'text/plain' }).end('internal error'); } catch { /* gone */ }
    } else {
      try { res.destroy(); } catch { /* gone */ }
    }
  });
});

// ---------------------------------------------------------------- agent plumbing

// noServer + one upgrade router: the bridge's own sockets answer on /ws, and
// anything on /proxy/ is forwarded to the instance it names. Letting the server
// handle every upgrade itself would have aborted the proxy connections before
// they could be routed.
/* ── agent supervision ──────────────────────────────────────────────────────
 * Split out to bridge/agent.js (issue #54, phase 6): the child process, the
 * RPC pipe, the WebSocket fan-out and the restart/idle bookkeeping. */
require('./agent')({
  agentStatus: agentStatus,
  isWin: isWin,
  fs: fs,
  DEBUG_RPC,
  DEFAULT_MODEL,
  HOST,
  PI_AGENT_DIR,
  PI_COMMAND,
  PORT,
  SESSION_DIR,
  WORKSPACE_DIR,
  WebSocketServer,
  allowedHostNames,
  execSync,
  forgetLastSession,
  hostOnly,
  hostSpawnDir,
  http,
  lanAddress,
  loadLastSession,
  path,
  proxyWss,
  saveLastSession,
  server,
  sessionFileExists,
  spawn,
  splitProxyPath,
  startWhisper,
  stopWhisper,
  whisperUrl,
});
