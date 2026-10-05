/*
 * Pi Agent WebUI bridge.
 *
 * Spawns one `pi --mode rpc` subprocess per connected browser tab and relays
 * JSON lines between the browser (WebSocket) and the agent (stdin/stdout).
 * Also serves the static WebUI and a small HTTP API for session discovery.
 *
 * Env vars:
 *   PORT           HTTP/WS port                (default 3000)
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
const { StringDecoder } = require('string_decoder');
const { spawn, execFile, execSync } = require('child_process');
const { pathToFileURL } = require('url');
const { WebSocketServer, WebSocket } = require('ws');
const { startWhisper, stopWhisper, whisperStatus, WHISPER_MODELS, DEFAULT_MODEL } = require('./whisper_boot');

const PORT = parseInt(process.env.PORT || '3000', 10);
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
const PI_COMMAND = process.env.PI_COMMAND || 'pi --mode rpc';
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
// Session dir for listing. Either a normal path, or "docker:<container>:<path>"
// to list sessions inside a container via `docker exec` (used when the pi
// agent runs in an existing container, e.g. PI_COMMAND="docker exec -i ctr pi --mode rpc").
const SESSION_DIR =
  process.env.PI_SESSION_DIR || path.join(os.homedir(), '.pi', 'agent', 'sessions');
// Same thing, as a list and never a docker spec - used to bound session
// export/delete to files that really are session files.
const SESSION_DIRS = SESSION_DIR.startsWith('docker:') ? [] : [SESSION_DIR];
// pi's config dir (~/.pi/agent): models.json / settings.json / auth.json live here.
const PI_AGENT_DIR = process.env.PI_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
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
const PI_AUTH_FILE = path.join(PI_AGENT_DIR, 'auth.json');
const WEB_DIR = path.join(__dirname, '..', 'web');
let whisperUrl = null; // set once the local whisper STT server (if any) is up
const fontsCache = { list: null, at: 0 }; // GET /api/system-fonts cache

/* Decode a UTF-16 name-table string. Node has no utf16be decoder, and in
 * practice name records are found in both byte orders, so try both and pick
 * the one that yields printable text (a wrong order turns ASCII into
 * characters with a zero low byte). */
function decodeUtf16Name(raw) {
  const be = [], le = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    be.push((raw[i] << 8) | raw[i + 1]);
    le.push((raw[i + 1] << 8) | raw[i]);
  }
  const bad = (arr) => arr.filter((c) => c === 0 || (c >= 0x100 && (c & 0xff) === 0)).length;
  const codes = bad(be) <= bad(le) ? be : le;
  return codes.map((c) => String.fromCharCode(c)).join('');
}

/* Read the family name (nameID 1) from a TTF/OTF buffer. This is the name
 * CSS font-family actually matches against, and it can differ from the
 * Windows font-registry label — e.g. a font registered as
 * "RWBY-Z-Regular (TrueType)" has family "RWBY-Z", so using the label makes
 * the browser silently fall back to sans-serif. Returns null for WOFF/TTC
 * collections or malformed files. */
function ttfFamilyName(buf) {
  try {
    if (!buf || buf.length < 12) return null;
    const version = buf.readUInt32BE(0);
    // 0x00010000 = TTF, 'true' = legacy TTF, 'OTTO' = CFF/OTF; WOFF/TTC differ.
    if (version !== 0x00010000 && version !== 0x74727565 && version !== 0x4f54544f) return null;
    const numTables = buf.readUInt16BE(4);
    let off = 12;
    for (let i = 0; i < numTables; i++) {
      const tag = buf.toString('ascii', off, off + 4);
      const tOff = buf.readUInt32BE(off + 8);
      off += 16;
      if (tag !== 'name') continue;
      const count = buf.readUInt16BE(tOff + 2);
      const strBase = tOff + buf.readUInt16BE(tOff + 4);
      const candidates = [];
      for (let j = 0; j < count; j++) {
        const r = tOff + 6 + j * 12;
        const pid = buf.readUInt16BE(r);
        const nid = buf.readUInt16BE(r + 6);
        const len = buf.readUInt16BE(r + 8);
        const sOff = buf.readUInt16BE(r + 10);
        if (nid !== 1 || len < 2 || len % 2) continue;
        const raw = buf.subarray(strBase + sOff, strBase + sOff + len);
        const text = decodeUtf16Name(raw).trim();
        if (text) candidates.push({ pid, text });
      }
      // Prefer the Windows (pid 3) record, then Unicode (1), then Mac (0).
      const pick = candidates.find((c) => c.pid === 3)
        || candidates.find((c) => c.pid === 1)
        || candidates[0];
      return pick ? pick.text : null;
    }
  } catch { /* malformed */ }
  return null;
}

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

/* A session file lives either on this machine or inside a container
 * (PI_SESSION_DIR=docker:<ctr>:<dir>). Reading, downloading and deleting one go
 * through these helpers, so no endpoint has to know which of the two it is.
 * The transcript reader used to refuse outright - "docker session dirs are not
 * supported here" - and the UI showed that as "Could not load session" for every
 * session in the sidebar whenever the agent ran in a container. */
/* Run a command in a container and collect its stdout.
 *
 * The container name is validated **here** rather than at each call site (issue
 * #29). It comes from PI_SESSION_DIR, so it is operator-set and was never
 * remotely reachable - but it is an argv element alongside argument lists that
 * *are* built from untrusted data, and the next person adding a call should not
 * have to re-derive which of the two is trusted. Validating in one place means
 * every caller, present and future, inherits it. */
function dockerCapture(container, args, timeoutMs = 60000, maxBuffer = 256 * 1024 * 1024) {
  const ctr = safeContainerName(container);
  if (!ctr) return Promise.resolve('');
  return new Promise((resolve) => {
    execFile('docker', ['exec', ctr, ...args], { timeout: timeoutMs, maxBuffer, shell: false },
      (err, stdout) => resolve(err ? '' : stdout));
  });
}

/* A path from either world, or null when it is not a .jsonl inside the session
 * dir - the check that stops delete/export from being talked into touching
 * anything else. In container mode the path is validated as a container path
 * and only ever read through `docker exec`, never from the host. */
function sessionRef(raw) {
  const remote = parseSessionDir();
  if (!remote) {
    const local = safeSessionPath(raw);
    return local ? { kind: 'local', path: local } : null;
  }
  if (typeof raw !== 'string' || !raw.trim()) return null;
  // Windows paths can arrive with backslashes; inside the container it is a
  // POSIX path either way. 92 is the backslash, spelled this way so the
  // source does not depend on how many escapes survived the editor.
  const posix = (v) => path.posix.normalize(String(v).replaceAll(String.fromCharCode(92), '/'));
  const want = posix(raw.trim());
  const root = posix(remote.dir);
  if (!(want === root || want.startsWith(root === '/' ? '/' : root + '/'))) return null;
  if (path.posix.extname(want).toLowerCase() !== '.jsonl') return null;
  return { kind: 'docker', container: remote.container, path: want };
}

async function readSessionRef(ref) {
  if (ref.kind === 'docker') return (await dockerCapture(ref.container, ['cat', ref.path])) || null;
  // Promises, not readFileSync: a session file can be tens of megabytes, and the
  // synchronous read held the whole bridge's event loop for the duration - the
  // agent's RPC pipe included, so asking for a long transcript froze the agent
  // too. Nothing here needs the file before the next line anyway.
  try { return await fs.promises.readFile(ref.path, 'utf8'); } catch { return null; }
}

/* ── reading a session transcript ───────────────────────────────────────
 * This used to be: read the whole file, split it into an array, JSON.parse
 * every line, build one array of messages, stringify the lot, and only then
 * write the first byte.
 *
 * Measured on a real 70 MB session, the JSON.parse was 49 ms of a 565 ms load -
 * so making the parsing parallel would have been the wrong lever entirely. The
 * cost was elsewhere: 378 ms elapsed before the browser saw a single byte, all
 * of it one unbroken block on the event loop, and roughly 200 MB of resident
 * memory for the duration (the file as a string, the parsed objects, and the
 * re-serialised copy - three copies of the same base64).
 *
 * So: read the file line by line and write each message out as it is parsed.
 * Time-to-first-byte drops to about the cost of the first line, the transfer
 * overlaps the parsing instead of following it, peak memory falls to roughly one
 * message, and the yields between batches stop a long read from stalling the
 * agent's event stream (which is why opening a long session used to visibly
 * pause a running turn). */

/* The file's lines, as an async iterable. Backpressure-aware: the caller's
 * writes are awaited, so a slow client cannot make the bridge buffer the whole
 * transcript in memory to send it later. */
/* ── images in a session file: a reference instead of the bytes ──────────
 *
 * A session file stores every picture the agent ever looked at, or that was
 * ever pasted, as a base64 block inside its JSON line. On a real session here
 * that was 99% of the file: 69 of 70 MB on one, 25 of 221 messages carrying
 * everything. The transcript response was that file again, so opening the
 * session downloaded every picture in it - to render a handful of them as
 * 220-pixel thumbnails, most of them far below the fold.
 *
 * So the transcript now names the pictures instead of carrying them, and the
 * bytes are fetched only for the ones actually on screen. The browser already
 * defers this: lazySrc() sets an <img>'s src when it comes within 1200px of the
 * viewport and takes it away again past 3000px, so scrolling a long session
 * pulls in the pictures you pass and releases the ones you leave.
 *
 * The reference is a plain URL, which means nothing in the renderer has to
 * change shape: the same <img src> works for a URL and for a data URL, and
 * clicking one to view it full size opens the same thing.
 *
 * Two escape hatches, both deliberate:
 *  - `?inline=1` on the transcript puts the bytes back in the response, exactly
 *    as it used to be, for anything that wants a self-contained file;
 *  - pictures below the threshold stay inline, so a small icon in a message
 *    costs no extra request and still opens instantly. */
const IMAGE_INLINE_LIMIT = 8 * 1024;   // base64 characters

/* Where to fetch one picture from. The token is the file's size and mtime, so a
 * session that grows (a new turn appended) or is rewritten invalidates every
 * reference to it, and the browser's own cache does the rest. */
function imageUrl(sessionPath, line, part, stamp) {
  return `/api/session-image?path=${encodeURIComponent(sessionPath)}&line=${line}&part=${part}` +
    (stamp ? `&v=${encodeURIComponent(stamp)}` : '');
}

/* Replace the big image blocks in one message with references. Returns how many
 * were moved out and how many bytes that saved, so the endpoint can report it. */
function externaliseImages(msg, sessionPath, line, stamp) {
  const content = msg && msg.content;
  if (!Array.isArray(content)) return { n: 0, saved: 0 };
  let n = 0, saved = 0;
  for (let i = 0; i < content.length; i++) {
    const b = content[i];
    if (!b || b.type !== 'image' || typeof b.data !== 'string') continue;
    if (b.data.length <= IMAGE_INLINE_LIMIT) continue;
    const bytes = Math.round(b.data.length * 0.75);
    // the payload is replaced in place: the object is freshly parsed from the
    // file and nothing else holds it.
    // `part` is the index in the content array, not a count of pictures - a
    // message shaped [text, image, text, image] has parts 1 and 3, and counting
    // the pictures instead pointed the fetch at the wrong block (a 404, for every
    // image in every message that did not start with one).
    b.data = undefined;
    b.bytes = bytes;
    b.line = line;
    b.part = i;
    b.src = imageUrl(sessionPath, line, i, stamp);
    n++; saved += bytes;
  }
  return { n, saved };
}

/* ── where each line starts ───────────────────────────────────────────────
 *
 * `/api/session-image` has to find one line in a session file, and it used to do
 * that by reading the file from the beginning until it reached it. Cost is
 * therefore O(position of the line): measured on a 36 MB / 60-line session,
 * 6.4 ms for an image on line 2 and 44.9 ms for one on line 60. With N images
 * that is O(N x filesize) - and every image the chat shows costs one of those.
 *
 * The transcript endpoint already reads every line of the file, so it can record
 * where each one started at no extra cost. This is that record: byte offset per
 * line, keyed by the same size+mtime token the image URLs already use, so a
 * session that grows or is rewritten invalidates it exactly as it invalidates
 * the browser's cached copies.
 *
 * Bounded on purpose. These are the newest sessions in a bounded list, and a run
 * that opens hundreds of different sessions should not keep all of them. */
const LINE_INDEX_MAX = 24;
const LINE_INDEX = new Map();   // key -> { offsets: number[] }

function indexKey(ref, stamp) {
  const where = ref.kind === 'docker' ? `${ref.container}:${ref.path}` : ref.path;
  return `${where}|${stamp || ''}`;
}

function indexPut(key, offsets) {
  LINE_INDEX.delete(key);            // re-insert so it counts as most recent
  LINE_INDEX.set(key, { offsets });
  while (LINE_INDEX.size > LINE_INDEX_MAX) LINE_INDEX.delete(LINE_INDEX.keys().next().value);
}

function indexGet(key) {
  const hit = LINE_INDEX.get(key);
  return hit ? hit.offsets : null;
}

/* The size+mtime token for a session, the same one the image URLs carry. */
async function sessionStamp(ref) {
  try {
    if (ref.kind !== 'docker') {
      const s = await fs.promises.stat(ref.path);
      return `${s.size}-${Math.floor(s.mtimeMs)}`;
    }
    return String(await dockerCapture(ref.container, ['stat', '-c', '%s-%Y', ref.path], 20000) || '').trim();
  } catch { return ''; }
}

/* One line, read from a known byte offset, without reading what came before it.
 *
 * This carried a note claiming that "a line longer than the cap is reported as
 * not found, which falls back to the forward scan". That was not what the code
 * did - it returned the truncated bytes as if they were the whole line - and the
 * note has gone with the bug, because believing it is what made the failure look
 * like a missing image. */
/* One line, read from a known byte offset, for the picture endpoint.
 *
 * A session line has no size worth guessing at: a message carries its pictures
 * inline, and one off a phone camera is several megabytes of base64 on a single
 * line. This used to grow its read but stop at 8 MB - smaller than that - so the
 * line came back truncated, JSON.parse threw on it, and the caller reported the
 * image as "no longer at that line" while it sat there in the file. Which is
 * issue #38 exactly: the pictures that failed to load were the phone ones, every
 * other picture worked, and the file was fine all along.
 *
 * So the read grows until it finds the newline or reaches the end of the file.
 * maxBytes is still there for a caller that wants a ceiling; the default is the
 * file. Measured on the session from that issue: line 85 is 10,450,484 chars of
 * base64 and now serves as a 7,837,863-byte PNG.
 *
 * The chunks are joined and decoded ONCE at the end rather than per read: a
 * multi-byte character can straddle two reads, and decoding each chunk on its own
 * would corrupt it - the same reason sessionLines below decodes the way it does. */
async function readLineAt(ref, offset, maxBytes = Number.MAX_SAFE_INTEGER) {
  if (offset < 0) return null;
  if (ref.kind === 'docker') {
    // `tail -c +N` is 1-based, and the path is argv as everywhere else
    const out = await dockerCapture(ref.container, ['tail', '-c', `+${offset + 1}`, ref.path], 30000);
    const text = String(out || '');
    const nl = text.indexOf('\n');
    return nl < 0 ? (text || null) : text.slice(0, nl);
  }
  let fh;
  try { fh = await fs.promises.open(ref.path, 'r'); } catch { return null; }
  try {
    const st = await fh.stat();
    if (offset >= st.size) return null;
    const hardEnd = Math.min(offset + maxBytes, st.size);
    const chunks = [];
    let got = 0;
    let len = Math.min(65536, hardEnd - offset);
    for (;;) {
      if (len <= 0) break;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, offset + got);
      if (!bytesRead) break;
      const slice = buf.subarray(0, bytesRead);
      const nl = slice.indexOf(0x0a);
      if (nl >= 0) {
        // cut at the newline, so what is decoded holds only whole characters
        chunks.push(slice.subarray(0, nl));
        break;
      }
      chunks.push(slice);
      got += bytesRead;
      if (bytesRead < len) break;                 // the line runs to the end of the file
      if (offset + got >= hardEnd) break;         // a ceiling was asked for
      len = Math.min(len * 4, 64 * 1024 * 1024, hardEnd - offset - got);
    }
    if (!chunks.length) return null;
    return Buffer.concat(chunks).toString('utf8');
  } catch { return null; } finally {
    try { await fh.close(); } catch { /* already closed */ }
  }
}

/* Every line of a session, one at a time, with the byte offset of each.
 *
 * Streaming rather than reading the file whole, because a session can be tens of
 * megabytes; `onLine` is handed the offset before each line so a caller can build
 * the line index that readLineAt above seeks with. */
async function* sessionLines(ref, onLine) {
  if (ref.kind === 'docker') {
    // `docker exec` hands us a live stdout, so the file can be read as it
    // arrives instead of after the whole of it has crossed into this process.
    // The first version used dockerCapture, which collects the entire file into
    // one string before returning - so on the setup the bridge actually runs on
    // (a native bridge driving an agent inside a container) nothing could be
    // sent until the last byte had come back: measured 1513 ms before the first
    // byte on a 70 MB session, 3.3 s to finish.
    const child = spawn('docker', ['exec', ref.container, 'cat', ref.path], { stdio: ['ignore', 'pipe', 'ignore'] });
    // A multi-byte character can straddle two chunks, so the bytes are decoded
    // through a StringDecoder rather than with toString() per chunk - otherwise a
    // session containing any emoji or accented text would be corrupted wherever
    // it happened to fall on a buffer edge.
    const decoder = new StringDecoder('utf8');
    let buf = '';
    let failed = null;
    // bytes consumed before the line now being assembled
    let consumed = 0;
    child.on('error', (e) => { failed = e; });
    try {
      for await (const chunk of child.stdout) {
        const text = buf + decoder.write(chunk);
        const parts = text.split('\n');
        buf = parts.pop();
        for (const line of parts) {
          if (onLine) onLine(consumed);
          // +1 for the newline that was split away
          consumed += Buffer.byteLength(line, 'utf8') + 1;
          yield line;
        }
        if (failed) throw failed;
      }
      buf += decoder.end();
      if (buf) { if (onLine) onLine(consumed); yield buf; }
      if (failed) throw failed;
    } finally {
      try { child.kill(); } catch { /* already gone */ }
    }
    return;
  }
  /* Read the raw bytes and decode them here, rather than letting the stream do
   * the decoding, so that a byte offset per line can be counted. Node's own
   * decode and StringDecoder agree on utf8 - the multi-byte test that guards this
   * function is what proves it - and the docker branch above already decodes
   * this way for the same reason (a character can straddle two chunks). */
  const stream = fs.createReadStream(ref.path, { highWaterMark: 1 << 18 });
  const decoder = new StringDecoder('utf8');
  // `buf` is the partial trailing line carried between chunks. It is declared
  // per-branch on purpose: the docker branch above has its own, and sharing one
  // across both would let a docker read leak a half-line into a local read.
  let buf = '';
  // bytes consumed before the line now being assembled
  let consumed = 0;
  const emit = function* (line, bytes) {
    if (onLine) onLine(consumed);
    consumed += bytes;
    yield line;
  };
  for await (const chunk of stream) {
    const text = decoder.write(chunk);
    let start = 0, nl;
    while ((nl = text.indexOf('\n', start)) >= 0) {
      buf += text.slice(start, nl);
      // +1 for the newline itself
      for (const l of emit(buf, Buffer.byteLength(buf, 'utf8') + 1)) yield l;
      buf = '';
      start = nl + 1;
    }
    if (start < text.length) buf += text.slice(start);
  }
  buf += decoder.end();
  if (buf) { if (onLine) onLine(consumed); yield buf; }
}

/* Let the event loop have the thread back. setImmediate (not a timer) so this is
 * the very next turn of the check phase - no millisecond of latency added. */
const breathe = () => new Promise((r) => setImmediate(r));

/* Write, honouring backpressure.
 *
 * Coalescing matters more than it looks. A session line can be a quarter of a
 * megabyte (one message with a screenshot in it), and writing each one on its own
 * meant the socket buffer filled on every line, the write went async, and the
 * next line was not even read until the previous one had drained - read, parse,
 * write, wait, repeat, all strictly in series. That measured *slower* than the
 * old build-everything-first approach even though it started instantly, because
 * it gave up the memory bandwidth of one big sequential read.
 *
 * So: gather messages into a buffer and send it in reasonably large pieces, and
 * only then wait for the socket. The response is told about a big buffer so it
 * does not report "full" after 16 KB. */
const WRITE_CHUNK = 256 * 1024;
function writeStream(res) {
  const w = { res, buf: [], size: 0, wait: null };
  w.add = (s) => { w.buf.push(s); w.size += s.length; };
  w.flush = async () => {
    if (!w.size) return;
    const chunk = w.buf.length === 1 ? w.buf[0] : w.buf.join('');
    w.buf.length = 0; w.size = 0;
    if (w.res.write(chunk)) return;
    await new Promise((resolve) => w.res.once('drain', resolve));
  };
  return w;
}

/* How big the file is, without reading it.
 *
 * This one line cost more than everything else put together when it was written
 * the obvious way. Asking for the size by reading the file - which is what the
 * first version did, through readSessionRef - pulls the whole thing across
 * `docker exec` before the first line of the response exists, which is precisely
 * the wait streaming was supposed to remove: 1478 ms before the first byte on a
 * 70 MB session, with every streaming change already in place and none of it
 * mattering. `stat` answers in about a millisecond. */
async function sessionSize(ref) {
  try {
    if (ref.kind !== 'docker') return (await fs.promises.stat(ref.path)).size;
    const out = await dockerCapture(ref.container, ['stat', '-c', '%s', ref.path], 20000);
    const n = parseInt(String(out || '').trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
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

async function subagentArtifact(runId, wantLabel) {
  const remote = parseSessionDir();
  const localDir = path.join(SESSION_DIR, 'subagent-artifacts');
  let names = [];
  if (remote) {
    // the directory is argv ($1), not script text - same rule as everywhere else
    // that a path meets a shell in this file
    const ctr = safeContainerName(remote.container);
    if (!ctr) return null;
    const out = await dockerRun(ctr, ['sh', '-c',
      'ls -1 "$1" 2>/dev/null', 'sh', path.posix.join(remote.dir, 'subagent-artifacts')], 20000);
    names = out.split('\n').map((x) => x.trim()).filter(Boolean);
  } else {
    try { names = fs.readdirSync(localDir); } catch { names = []; }
  }
  let mine = names.filter((f) => f.startsWith(`${runId}_`));
  if (!mine.length && wantLabel) mine = names.filter((f) => f.includes(`_${wantLabel}_`) || f.includes(`_${wantLabel}.`));
  if (!mine.length) return null;
  // Prefer the final answer; label is the agent name when the extension put it in
  // the file name (`<runId>_<agent>_output.md`).
  const pick = (suffix) => mine.find((f) => f.endsWith(suffix)) || null;
  // The child's own conversation is the transcript; the output is only its last
  // message. Trying several spellings, because the run id in the tool result and
  // the id in the file name are not always the same thing.
  const byLabel = wantLabel ? mine.filter((f) => f.includes(`_${wantLabel}`)) : [];
  const file = pick('_transcript.jsonl')
    || (byLabel.find((f) => f.endsWith('_transcript.jsonl')) || null)
    || pick('_output.md') || (byLabel.find((f) => f.endsWith('.md')) || null)
    || pick('_resolved.md') || pick('_summary.md') || pick('_meta.json')
    || byLabel[0] || mine[0];
  if (!file) return null;
  const target = remote ? path.posix.join(remote.dir, 'subagent-artifacts', file)
    : path.join(localDir, file);
  const text = remote ? await dockerCapture(remote.container, ['cat', target], 30000)
    : (() => { try { return fs.readFileSync(target, 'utf8'); } catch { return ''; } })();
  if (!text) return null;
  return { file, text: file.endsWith('.jsonl') ? tailText(text) : text };
}

/* A pi-subagents run directory, or null.
 *
 * This value arrives in a query string, so it is a *reference* to validate, not
 * a path to use. The check used to be a regex that only had to match somewhere
 * in the string, after which the value was pasted into `ls -1t '<dir>'/…`
 * inside `sh -c`. Two things followed from that, both verified:
 *
 *   - in container mode, `dir=/tmp/pi-subagents-x/async-subagent-runs/'; touch X; '`
 *     ran `touch X` inside the container (command execution);
 *   - in local mode, `…/async-subagent-runs/../../../secret` walked out of the
 *     run directory and read an unrelated `status.json` (arbitrary file read).
 *
 * So the shape is now *anchored*, and normalisation - which is what collapses
 * `..` - happens before the test:
 *
 *   <something>/pi-subagents<scope>/async-subagent-runs/<one segment>
 *
 * One segment means nothing can be appended to it, and in local mode the path
 * must additionally sit under a run root this bridge actually uses. The
 * character allowlist then removes everything a shell or a glob treats as
 * special, so even a path that passes the shape carries no syntax. */
/* A run directory is *data*: it is always passed as argv and quoted as "$1", so
 * the quoting - not this pattern - is what stops a command running. What follows
 * is belt and braces, and it is a denylist on purpose.
 *
 * The first version of this was an allowlist, [A-Za-z0-9 ._+@:/-], and it was
 * wrong in a way the tests caught: os.tmpdir() on Windows returns the 8.3 short
 * form (C:/Users/THEBLU~1/AppData/Local/Temp), and `~` was not in the set - so
 * every genuine run directory on this machine was refused and the feature the
 * check exists to protect stopped working. An allowlist has to enumerate every
 * character a real path can contain and gets it wrong quietly; a denylist only
 * has to name the ones that are actually dangerous. */
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

async function subagentRunLog(asyncDir) {
  const ref = runDirRef(asyncDir);
  if (!ref) return null;
  if (ref.kind === 'docker') {
    // The directory is argv, quoted as `$1`, and never part of the script text.
    // (The result of `"$1"` is not re-scanned for expansions, so even a `$(` in
    // it would stay literal - and the denylist above rejects one anyway.)
    const out = await dockerRun(ref.container, ['sh', '-c',
      'ls -1t "$1"/output-*.log "$1"/status.json 2>/dev/null | head -5', 'sh', ref.dir], 20000);
    const first = out.split('\n').map((x) => x.trim()).filter(Boolean)[0];
    if (!first) return null;
    // the file we then read is a bare basename under the run dir, re-joined from
    // a validated name rather than taken as a path
    const base = path.posix.basename(first);
    if (!/^[\w.-]+$/.test(base)) return null;
    const text = await dockerRun(ref.container, ['cat', `${ref.dir}/${base}`], 30000);
    return text ? { file: base, text: tailText(text) } : null;
  }
  let files = [];
  try { files = fs.readdirSync(ref.dir); } catch { return null; }
  const logs = files.filter((f) => /^output-.*\.log$/.test(f)).sort();
  const pick = logs.length ? logs[logs.length - 1] : (files.includes('status.json') ? 'status.json' : null);
  if (!pick) return null;
  try { return { file: pick, text: tailText(fs.readFileSync(path.join(ref.dir, pick), 'utf8')) }; } catch { return null; }
}

/* ── live subagent runs ──────────────────────────────────────────────────
 * pi-subagents keeps one status.json per async run under its temp root, with the
 * fields a panel wants while a child works: state, current tool, turns, tools,
 * start and end time - and, once the child has started, the session file it is
 * running in. Reading those directly (instead of waiting for the parent
 * transcript's widget line) is what makes the panel tick in real time, and what
 * lets a click open the child's own conversation rather than a text dump.
 *
 * All of it is read in one pass per poll and cached for a moment: the panel asks
 * about once a second, and inside Docker every read is a `docker exec`. */
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

async function listSubagentRuns() {
  const now = Date.now();
  const remote = parseSessionDir();
  const ttl = remote ? 1500 : 400;
  if (RUN_CACHE.data && now - RUN_CACHE.at < ttl) return RUN_CACHE.data;
  let runs = [];
  try { runs = remote ? await readRunDirsDocker(remote) : readRunDirsLocal(); } catch { runs = []; }
  try {
    // One listing per session directory, reused for every run that came from it.
    const listing = new Map();
    for (const r of runs) {
      const dir = r.sessionId ? path.dirname(r.sessionId) : null;
      if (!dir) continue;
      if (!listing.has(dir)) listing.set(dir, await artifactNamesIn(dir).catch(() => []));
      const hit = (listing.get(dir) || []).find((n) => n.startsWith(`${r.runId}_`));
      if (hit) r.agent = hit.slice(r.runId.length + 1).split('_')[0] || r.agent;
      if (!r.mode) r.mode = 'single';
    }
  } catch { /* labels are a nicety */ }
  runs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  RUN_CACHE.at = now;
  RUN_CACHE.data = runs;
  return runs;
}

/* Path comparison for session files coming from different places (a settings
 * file, a container, a transcript). */
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
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(WEB_DIR, urlPath));
  if (!file.startsWith(WEB_DIR)) {
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

/* Run `fn` over `items` with at most `limit` in flight.
 *
 * The cost here is per-file latency, not CPU, so overlapping the I/O is most of
 * the win - but an unbounded Promise.all over a session directory with thousands
 * of files would hold thousands of descriptors open at once, so the concurrency
 * is capped. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return out;
}

const SCAN_CONCURRENCY = 24;

async function scanLocalSessions() {
  let files;
  try {
    files = await fs.promises.readdir(SESSION_DIR, { recursive: true })
      .then((f) => f.filter((f) => f.endsWith('.jsonl') && !isSubagentTranscript(f)))
      .then((f) => f.map((f) => path.join(SESSION_DIR, f)));
  } catch {
    return [];
  }
  const edges = await mapLimit(files, SCAN_CONCURRENCY, (f) => readSessionEdges(f));
  const sessions = [];
  for (let i = 0; i < files.length; i++) {
    const e = edges[i];
    if (!e) continue;                             // vanished between readdir and open
    const file = files[i];
    const name = path.basename(file);
    let parent = null;
    // The header records where a fork came from, which is what the sidebar
    // uses to show "this one branched off that one".
    try { parent = JSON.parse(e.head.split('\n')[0]).parentSession || null; } catch { /* old or odd file */ }
    let title = '';
    try { title = titleFromHead(e.head); } catch { /* unreadable */ }
    // prefer an explicit rename (tail) over the derived first-message title.
    // A tail read usually starts mid-line, so the partial first line is dropped -
    // and when there is no newline in the window there is nothing to drop.
    const tailForName = e.tailTruncated ? e.tail.slice(e.tail.indexOf('\n') + 1) : e.tail;
    let explicit = null;
    try { explicit = nameFromText(tailForName); } catch { /* odd file */ }
    sessions.push({
      path: file,
      fileName: name,
      name: explicit || title || name.replace(/\.jsonl$/, ''),
      mtime: e.mtimeMs,
      size: e.size,
      parent,
    });
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions.slice(0, 200);
}

/* A container name that is safe to hand to `docker exec`.
 *
 * The name is always an argv element, never script text, so this is not about
 * shell quoting: it only has to reject values `docker` would read as a flag
 * (leading `-`) and anything a line-oriented reader could not carry. */
function safeContainerName(name) {
  const n = String(name == null ? '' : name).trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(n) ? n : null;
}

/* Run one command in a container. Args are passed positionally - the file list
 * below is a list of argv elements, never text spliced into a script. */
function dockerRun(container, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile('docker', ['exec', container, ...args],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, shell: false },
      (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
}

/* Session discovery inside a container.
 *
 * ── why this is written the way it is ──────────────────────────────────────
 *
 * It used to build a shell script out of the file names it had just read:
 *
 *     for f in '<path1>' '<path2>'; do …; done        ->  sh -c
 *
 * A session file whose *name* contained a single quote therefore closed the
 * quote and ran a command of its own. That was not theoretical: one
 * unauthenticated `GET /api/sessions`, with a file named
 * `a'; do touch PWNED_FINAL; done #x.jsonl` in the session directory, created
 * /workspace/PWNED_FINAL inside the container. File names come from `find`, and
 * `find` is not a trusted source of shell-safe text.
 *
 * So the directory is now *data* (`$1`), the paths are *argv* (`"$@"`), and
 * nothing that arrives over the wire or off the filesystem is ever parsed as
 * shell syntax.
 *
 * Two more faults lived in the same function and are fixed with it, because
 * they are the same mistake seen from the other end - treating a path as a
 * string to be rewritten rather than a value to be carried:
 *
 *  - the directory was "sanitised" by deleting every character outside
 *    [A-Za-z0-9_-/], which deleted the dot in `~/.pi/agent/sessions` - the
 *    default session directory - so the scan looked at `/root/pi/agent/sessions`,
 *    which does not exist, and reported **zero sessions with no error at all**,
 *    for ever. Verified against a container: the dotted path listed nothing, the
 *    same directory without a dot listed the session. The container name is now
 *    validated instead, and the directory is passed through untouched.
 *
 *  - it relied on `find -printf`, which is a GNU extension. BusyBox `find`
 *    (Alpine, and many slim images) has no such option, so the listing was
 *    silently empty on those too. `find -print0` plus `stat -c` works on both -
 *    checked on Debian and on Alpine.
 *
 * A file name containing a newline or the marker text is skipped rather than
 * allowed to make the head/tail markers ambiguous. */
const DOCKER_SCAN_LIMIT = 200;
const DOCKER_LIST_BYTES = 2000000;
const TITLE_MARKER = '===PIWEBUI';

/* One warning per distinct reason.
 *
 * The session scan can fail for reasons that are all reported the same way - an
 * empty list - so anything that explains one is worth saying once, and not worth
 * repeating every twenty seconds for the rest of the run (issue #30). */
const SCAN_WARNED = new Set();
function warnScanOnce(key, message) {
  if (SCAN_WARNED.has(key)) return;
  SCAN_WARNED.add(key);
  console.warn(`session scan: ${message}`);
}

async function scanDockerSessions(container, dir) {
  const ctr = safeContainerName(container);
  if (!ctr) {
    /* Say why, once.
     *
     * Every failure in this function used to be silent: the dot-stripping bug
     * and the GNU `find -printf` dependency both presented as HTTP 200 with an
     * empty session list, no error and no log line, so an empty sidebar was
     * indistinguishable from "you have no sessions" (issue #30). A docker mode
     * that cannot be reached at all is worth one line in the console. */
    warnScanOnce('container-name', `session scan skipped: "${String(container).slice(0, 60)}" is not a usable container name`);
    return [];
  }
  const root = String(dir == null ? '' : dir).trim();
  if (!root) return [];

  // 1) the files. NUL-separated, so a space or a quote in a name is just a byte.
  const listRaw = await dockerRun(ctr, ['sh', '-c',
    `find "$1" -name '*.jsonl' -print0 2>/dev/null | head -c ${DOCKER_LIST_BYTES}`, 'sh', root]);
  const paths = listRaw.split('\u0000')
    .map((s) => s.replace(/\r?\n$/, ''))
    .filter(Boolean)
    .filter((p) => p.endsWith('.jsonl') && !isSubagentTranscript(p))
    // a name the marker line below cannot carry unambiguously
    .filter((p) => !/[\r\n]/.test(p) && !p.includes(TITLE_MARKER))
    .slice(0, DOCKER_SCAN_LIMIT);
  if (!paths.length) return [];

  // 2) mtime and size. One `stat` per file, over argv; GNU and BusyBox agree on -c.
  const statRaw = await dockerRun(ctr, ['sh', '-c',
    'for f do stat -c "%Y %s %n" "$f" 2>/dev/null || true; done', 'sh', ...paths]);
  const files = [];
  for (const line of statRaw.split('\n')) {
    const m = /^(\d+) (\d+) ([\s\S]+)$/.exec(line.trim());
    if (!m) continue;
    const p = m[3];
    if (!paths.includes(p)) continue;         // never trust a name we did not ask for
    files.push({
      path: p,
      fileName: p.split('/').pop(),
      mtime: Math.floor(parseFloat(m[1]) * 1000),
      size: parseInt(m[2], 10) || 0,
    });
  }
  if (!files.length) return [];
  files.sort((a, b) => b.mtime - a.mtime);
  const newest = files.slice(0, DOCKER_SCAN_LIMIT);

  // 3) a title from each file's head, and any explicit rename from its tail.
  //    `for f do` walks "$@", so a quote or a space in a name is inert.
  const heads = await dockerRun(ctr, ['sh', '-c',
    'for f do' +
    ` echo "${TITLE_MARKER} $f"; head -c 32768 "$f"; echo;` +
    ` echo "${TITLE_MARKER}TAIL $f"; tail -c 65536 "$f" 2>/dev/null; echo; done`, 'sh',
    ...newest.map((f) => f.path)], 60000);
  const titleByFile = {};
  const explicitByFile = {};
  for (const chunk of heads.split(TITLE_MARKER)) {
    const nl = chunk.indexOf('\n');
    if (nl < 0) continue;
    const marker = chunk.slice(0, nl).trim();
    const body = chunk.slice(nl + 1);
    if (marker.startsWith('TAIL ')) explicitByFile[marker.slice(5).trim()] = nameFromText(body);
    else if (marker) titleByFile[marker] = titleFromHead(body);
  }
  return newest.map((f) => ({
    path: f.path,
    fileName: f.fileName,
    name: explicitByFile[f.path] || titleByFile[f.path] || f.fileName.replace(/\.jsonl$/, ''),
    mtime: f.mtime,
    size: f.size,
  }));
}

/* Discover sessions, and carry the reason if it fails.
 *
 * Returning a bare [] on failure is what made an unreadable session directory
 * indistinguishable from an empty one: the page showed an empty sidebar, which
 * reads as "you have no sessions" rather than "nothing could be read". The scan
 * still returns [] so every existing caller works, but it records why, and
 * /api/sessions passes that on for the UI to show (issue #30). */
let lastScanError = null;

async function scanSessions() {
  const remote = parseSessionDir();
  if (remote) {
    const ctr = safeContainerName(remote.container);
    if (!ctr) {
      lastScanError = `"${String(remote.container).slice(0, 60)}" is not a usable container name`;
      warnScanOnce('container-name', lastScanError);
      return [];
    }
    try {
      const found = await scanDockerSessions(remote.container, remote.dir);
      lastScanError = null;
      return found;
    } catch (e) {
      lastScanError = `could not read ${remote.dir} in ${ctr}: ${e.message}`;
      warnScanOnce('docker-scan', lastScanError);
      return [];
    }
  }
  try {
    const found = await scanLocalSessions();
    lastScanError = null;
    return found;
  } catch (e) {
    lastScanError = `could not read ${SESSION_DIR}: ${e.message}`;
    warnScanOnce('local-scan', lastScanError);
    return [];
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

/*
 * llama.cpp server URL candidates, in the same resolution order as the
 * pi-llama-cpp extension: project .pi/settings.json → $LLAMA_SERVER_URL →
 * global settings.json → auth.json (built-in provider) → default.
 */
/* The addresses worth asking right away: what is configured, the loopback, and
 * this machine's own LAN addresses (a server bound to 0.0.0.0 answers on both). */
function llamaServerCandidates() {
  const urls = [];
  const project = readJsonSafe(path.join(WORKSPACE_DIR, '.pi', 'settings.json'));
  if (project) urls.push(...llamaConfiguredUrls(project));
  if (process.env.LLAMA_SERVER_URL) urls.push(process.env.LLAMA_SERVER_URL);
  const global = readJsonSafe(PI_SETTINGS_FILE);
  if (global) urls.push(...llamaConfiguredUrls(global));
  const auth = readJsonSafe(PI_AUTH_FILE);
  if (auth && auth['llama.cpp'] && auth['llama.cpp'].env && auth['llama.cpp'].env.LLAMA_BASE_URL) {
    urls.push(auth['llama.cpp'].env.LLAMA_BASE_URL);
  }
  // This machine's own instances: a handful of common llama.cpp ports is cheap to
  // probe (a few addresses) and finds a second instance running locally beside the
  // one pi is already pointed at, even on a non-default port. The LAN sweep stays
  // on 8080/8081 - scanning a /24 on five ports would take minutes.
  for (const port of LOCAL_LLAMA_PORTS) {
    urls.push(`http://127.0.0.1:${port}`);
    urls.push(`http://localhost:${port}`);
  }
  for (const ip of localIPv4s(false)) {
    for (const port of LOCAL_LLAMA_PORTS) urls.push(`http://${ip}:${port}`);
  }
  const out = [];
  for (const raw of urls) {
    for (const u of String(raw).split(';').map((s) => s.trim().replace(/\/+$/, ''))) {
      if (u && !out.includes(u)) out.push(u);
    }
  }
  return out;
}

/* Fetch the model list from one OpenAI-compatible server. Returns null when
 * the server is unreachable or has no models endpoint. A network error on the
 * first path means the host is unreachable — don't waste another timeout on
 * the second path. */
async function fetchLlamaModels(url, timeoutMs = 1200) {
  const parse = (d) => {
    const arr = Array.isArray(d) ? d : (Array.isArray(d.data) ? d.data : null);
    if (!arr) return null;
    return arr
      .filter((m) => m && typeof m.id === 'string')
      .map((m) => ({ id: m.id, name: m.name || m.id }));
  };
  try {
    const res = await fetch(url + '/v1/models', { signal: AbortSignal.timeout(Math.max(150, Number(timeoutMs) || 1200)) });
    if (res.ok) {
      const models = parse(await res.json());
      if (models) return models;
    }
    // Server answered (404/405/etc.) — try the plain /models path (llama.cpp).
    const res2 = await fetch(url + '/models', { signal: AbortSignal.timeout(1200) });
    if (res2.ok) return parse(await res2.json());
    return null;
  } catch {
    return null; // unreachable host
  }
}

/* One llama.cpp host is usually reachable at several of its own addresses at
 * once (loopback, its LAN IP, a configured name, a virtual adapter). Each one
 * answered /v1/models, so the UI listed the same server - and its models - once
 * per address. Ask the server who it is: llama.cpp reports the model file it
 * loaded, which is the same answer from every address. Servers that do not
 * report it fall back to their model list.
 *
 * Only addresses on *this* machine are merged, though. Two instances on different
 * machines very often load the same file (the same download path, the same name),
 * and merging those hid one of them completely - the local one disappeared when a
 * LAN one was already configured. A remote address therefore always keeps its own
 * entry. */
function isLocalLlamaAddress(url) {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (/^(localhost|127\.0\.0\.1|::1)$/i.test(host)) return true;
    return localIPv4s(false).includes(host);
  } catch { return false; }
}

const LOCAL_LLAMA_PORTS = [8080, 8081, 8090, 8000, 1234];   // llama.cpp, plus the usual app defaults

/* The URLs pi will actually talk to: the extension's own `llamaSettings.servers`
 * list, or the older single `llamaServerUrl`. Reading both is what lets the UI say
 * what is configured now. */
function llamaConfiguredUrls(settings) {
  const out = [];
  const add = (value) => {
    // pi-llama-cpp's supported multiple-server syntax is one semicolon-separated
    // value. Accept that syntax in either the legacy key or a list entry so the
    // bridge can read configurations written by the extension and by the UI.
    for (const raw of String(value || '').split(';')) {
      const u = raw.trim().replace(/\/+$/, '');
      if (u && !out.includes(u)) out.push(u);
    }
  };
  const list = settings && settings.llamaSettings && settings.llamaSettings.servers;
  if (Array.isArray(list)) {
    for (const entry of list) add(typeof entry === 'string' ? entry : (entry && entry.url));
  }
  add(settings && settings.llamaServerUrl);
  return out;
}

async function llamaServerIdentity(url) {
  try {
    const res = await fetch(url + '/props', { signal: AbortSignal.timeout(900) });
    if (!res.ok) return null;
    const d = await res.json();
    const gen = (d && d.default_generation_settings) || {};
    const path = d && (d.model_path || gen.model);
    if (path) return `model:${path}|ctx:${gen.n_ctx || ''}`;
  } catch { /* not llama.cpp, /props disabled, or unreachable */ }
  return null;
}

/* The URL pi itself is configured with: its providerId
 * ("llama-server=<url>") has to stay exactly this one or set_model fails, so it
 * wins over the loopback/LAN addresses that reach the same server. */
function readLlamaServerUrl() {
  const project = readJsonSafe(path.join(WORKSPACE_DIR, '.pi', 'settings.json'));
  const projectUrls = llamaConfiguredUrls(project);
  if (projectUrls.length) return projectUrls[0];
  const global = readJsonSafe(PI_SETTINGS_FILE);
  const globalUrls = llamaConfiguredUrls(global);
  return globalUrls[0] || null;
}

const ALLOWED_APIS = new Set([
  'openai-completions', 'openai-responses', 'anthropic-messages',
  'google-generative-ai', 'mistral-conversations', 'bedrock-converse-stream',
  'azure-openai-responses', 'openai-codex-responses',
]);
const MODEL_FIELDS = ['id', 'name', 'api', 'baseUrl', 'reasoning', 'input',
  'contextWindow', 'maxTokens', 'cost', 'compat', 'thinkingLevelMap', 'headers'];
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Built-in provider ids, i.e. the keys pi accepts in auth.json. Sourced from
// docs/providers.md (API-key table) plus the OAuth/subscription providers.
const BUILTIN_PROVIDER_IDS = [
  'anthropic', 'ant-ling', 'amazon-bedrock', 'azure-openai-responses', 'baseten',
  'cerebras', 'cloudflare-ai-gateway', 'cloudflare-workers-ai', 'deepseek',
  'fireworks', 'google', 'groq', 'huggingface', 'kimi-coding', 'minimax',
  'minimax-cn', 'mistral', 'nvidia', 'openai', 'openrouter', 'opencode',
  'opencode-go', 'qwen-token-plan', 'qwen-token-plan-cn',
  'qwen-token-plan-individual', 'radius', 'together', 'vercel-ai-gateway',
  'xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp', 'xai', 'zai', 'zai-coding-cn',
  // subscriptions (/login -> browser flow, stored in auth.json as oauth)
  'claude-code', 'github-copilot', 'openai-codex',
];

// Classify an auth.json entry. Only *pure* credential entries count as a login
// (and may therefore be removed from the UI). Anything carrying extra
// configuration is protected: the pi-llama-cpp extension's `llama.cpp` entry is
// `{type:"api_key", env:{...}}` — no key at all — and deleting it would wipe a
// working server URL.
const AUTH_KEY_FIELDS = new Set(['type', 'key']);
const AUTH_OAUTH_FIELDS = new Set([
  'type', 'access', 'accessToken', 'refresh', 'refreshToken', 'token', 'idToken',
  'expires', 'expiresAt', 'expiresIn', 'expires_at', 'scope', 'tokenType',
  'account', 'accountId', 'email', 'label', 'createdAt', 'updatedAt',
]);
function authEntryKind(a) {
  if (!a || typeof a !== 'object') return 'none';
  const fields = Object.keys(a);
  if (a.type === 'api_key' && typeof a.key === 'string' && a.key.trim()
      && fields.every((f) => AUTH_KEY_FIELDS.has(f))) return 'key';
  if (a.type === 'oauth' && fields.every((f) => AUTH_OAUTH_FIELDS.has(f))) return 'oauth';
  return 'other';
}

function maskKey(k) {
  if (!k) return null;
  const s = String(k);
  if (s.length <= 8) return s[0] + '…';
  return s.slice(0, 4) + '…' + s.slice(-4);
}

/* Write a JSON file atomically: full contents to a sibling .tmp, then renamed
 * over the target. Rename is atomic within a directory, so a concurrent reader
 * (pi reloading the file, or another request) sees either the old file or the
 * new one, never a half-written one. The temp name carries the pid so two
 * writes racing in the same process cannot clobber each other's staging file. */
function writeJsonAtomic(target, value) {
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw e;
  }
}

/* Write models.json atomically.
 *
 * mkdir matters here and not just for tidiness: on a machine (or in a container)
 * whose ~/.pi/agent does not exist yet, the write failed outright without it,
 * so "add provider" reported a bare ENOENT. */
function writeModelsFile(file) {
  fs.mkdirSync(PI_AGENT_DIR, { recursive: true });
  writeJsonAtomic(PI_MODELS_FILE, `${JSON.stringify(file, null, 2)}\n`);
}

/* This machine's private IPv4 addresses. A llama-server started with the default
 * host answers on these too, so they belong in the first, fast round. */
const VIRTUAL_IFACE = /(wsl|vethernet|virtual|hyper-v|vmware|loopback|docker|veth|br-|tun|tap|utun|npcap)/i;

function localIPv4s(forSweep) {
  const out = [];
  try {
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      if (forSweep && VIRTUAL_IFACE.test(name)) continue;   // WSL/Hyper-V/Docker: not the LAN
      for (const a of list || []) {
        if (a && a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(a.address)) out.push(a.address);
      }
    }
  } catch { /* no interfaces to read */ }
  return out;
}

/* ── looking for llama.cpp on the LAN ────────────────────────────────────
 * A llama-server on another machine is the whole point of having one (that is
 * where the GPU is), and only localhost was ever probed - so it was invisible
 * unless it had been typed into pi's settings by hand. This sweeps the /24 the
 * machine is on, on the two ports llama-server uses, with a short timeout and a
 * little concurrency, then remembers the answer for a few minutes. It runs in the
 * background: the first request answers with the fast candidates only, and the
 * sweep's findings appear on the next poll (the UI already retries). */
const LLAMA_LAN_TTL = 5 * 60 * 1000;
const LLAMA_LAN_PORTS = [8080, 8081];
let llamaLan = { at: 0, urls: [], scanning: false };

function subnetHosts() {
  const hosts = [];
  for (const ip of localIPv4s(true).slice(0, 2)) {
    const base = ip.split('.').slice(0, 3).join('.');
    if (hosts.includes(base)) continue;
    hosts.push(base);
  }
  const out = [];
  for (const base of hosts) for (let i = 1; i <= 254; i++) out.push(`${base}.${i}`);
  return out;
}

async function llamaSweepLan() {
  if (llamaLan.scanning) return;
  llamaLan.scanning = true;
  const found = [];
  const hosts = subnetHosts();
  const targets = [];
  for (const h of hosts) for (const port of LLAMA_LAN_PORTS) targets.push(`http://${h}:${port}`);
  let i = 0;
  const worker = async () => {
    while (i < targets.length) {
      const url = targets[i++];
      const models = await fetchLlamaModels(url, 350);
      if (models && models.length) found.push(url);
    }
  };
  try {
    await Promise.all(Array.from({ length: 48 }, worker));
  } catch { /* whatever we found is still useful */ }
  llamaLan = { at: Date.now(), urls: found, scanning: false };
  console.log(`llama.cpp on the LAN: ${found.length ? found.join(', ') : 'nothing found'}`);
}

/* The LAN sweep is opt-in.
 *
 * It used to run on any bridge start where it had not been switched off, which
 * meant every page load fired up to 1016 HTTP probes at the local subnet
 * (2 subnets x 254 hosts x 2 ports, 48 at a time, 350 ms timeout each) - measured
 * at 1.24 s for the first `/api/llama-models`, reached from `refreshModels()` on
 * connect. On a shared or office network that is both slow and rude, so it is now
 * asked for rather than assumed:
 *
 *     PI_LLAMA_SCAN=on     enable the sweep
 *     unset / anything else  no sweep
 *
 * Nothing is lost at the default: `llamaServerCandidates()` still probes what is
 * configured, loopback, and this machine's own addresses, which is where a local
 * llama-server lives. The sweep only ever added *other machines* on the subnet. */
function llamaLanEnabled() {
  const v = String(process.env.PI_LLAMA_SCAN || '').trim().toLowerCase();
  return v === 'on' || v === '1' || v === 'true' || v === 'yes';
}

function llamaLanUrls() {
  if (!llamaLanEnabled()) return [];
  if (llamaLan.urls.length && Date.now() - llamaLan.at < LLAMA_LAN_TTL) return llamaLan.urls;
  if (!llamaLan.scanning) llamaSweepLan().catch(() => {});
  // While a sweep is running the previous answer (if any) still counts.
  return llamaLan.urls;
}

/* Small cache for /api/llama-models (the UI probes it on connect, focus and
 * a retry loop). */
const llamaModelsCache = { at: 0, data: null };

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

const server = http.createServer(async (req, res) => {
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
  if (req.url.startsWith('/api/sessions')) {
    // `remembered` is the session this bridge means to be in. The WebUI needs it
    // to tell "the agent is in a chat I just created, whose file does not exist
    // yet" from "the bridge restarted and lost my session" - the two look
    // identical from the outside (a session path that is not in this list), and
    // guessing between them is what made a new chat jump somewhere else on a
    // quick reload.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      sessionDir: SESSION_DIR,
      remembered: loadLastSession(),
      sessions: await scanSessions(),
      // A scan that failed is reported alongside the empty list, so the sidebar
      // can say "the session directory could not be read" instead of looking
      // like an account with no sessions in it (issue #30).
      scanError: lastScanError,
      // What the agent is doing right now, so a page that reloads in the middle
      // of it (or a second tab) shows the same thing as the one that started it.
      busy: agentStatus.busy,
      compacting: agentStatus.compacting,
    }));
    return;
  }
  // Read-only transcript of a session file. Lets the WebUI browse other
  // sessions while the shared agent keeps running in its own session
  // (the live view of the running session stays in the UI's DOM cache).
  // Local session dirs only — docker dirs would need `docker exec cat`.
  /* One picture out of a session file, as image bytes.
   *
   * The transcript points here instead of carrying the base64, so this is called
   * for the pictures that are actually on screen and not for the rest. The browser
   * caches the result (the URL carries the file's size and mtime, so a session that
   * changed invalidates it), and it is a plain image response - which is also less
   * memory in the page than a data URL, since the decoded bitmap replaces the
   * base64 text rather than sitting alongside it. */
  if (req.url.startsWith('/api/session-image')) {
    const u = new URL(req.url, 'http://x');
    const p = u.searchParams.get('path') || '';
    const wantLine = parseInt(u.searchParams.get('line') || '', 10);
    const wantPart = parseInt(u.searchParams.get('part') || '0', 10);
    const ref = sessionRef(p);
    if (!ref || !Number.isFinite(wantLine) || wantLine < 1) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad path or line' }));
      return;
    }
    try {
      /* Straight to the line when the transcript has already indexed this file.
       *
       * The fallback is the old behaviour - read forward - which is O(position);
       * with the index it is one short read whatever the line. The index is built
       * by /api/session-messages, which is what drew the transcript the picture is
       * being requested for, so in the normal case it is already there. */
      /* Read the line, and say what actually went wrong when it cannot be used.
       *
       * `found` used to mean "a line was read" while a parse failure was swallowed
       * into entry = null, so every such failure came out as the same message -
       * "that image is no longer at that line" - which is a claim about the SESSION
       * being wrong rather than about the reader being wrong. That is what made
       * issue #38 read as a missing image: the line was there, the read of it was
       * broken, and the error blamed the file. */
      let entry = null;
      let read = false;               // a line was located and read
      let badJson = false;            // ... but it did not parse as one entry
      const stampNow = await sessionStamp(ref);
      const offsets = stampNow ? indexGet(indexKey(ref, stampNow)) : null;
      const at = offsets && offsets.length >= wantLine ? offsets[wantLine - 1] : null;
      if (at != null) {
        const raw = await readLineAt(ref, at);
        if (raw != null) {
          read = true;
          try { entry = JSON.parse(raw); } catch { entry = null; badJson = true; }
        }
      }
      if (!read) {
        // no index (or the file moved under it): read forward, as before
        let line = 0;
        for await (const raw of sessionLines(ref)) {
          if (++line !== wantLine) continue;
          read = true;
          try { entry = JSON.parse(raw); } catch { entry = null; badJson = true; }
          break;
        }
      }
      if (badJson) {
        // Neither the session's fault nor the picture's. Say which, so the next
        // person looks at the reader instead of hunting for a lost image.
        res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: `line ${wantLine} could not be read as one session entry` }));
        return;
      }
      const content = entry && entry.message && entry.message.content;
      const block = Array.isArray(content) ? content[wantPart] : null;
      if (!read || !block || block.type !== 'image' || typeof block.data !== 'string') {
        // Genuinely nothing to serve: a wrong line or part, or a session rewritten
        // under a URL that named a position in the old one.
        res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'that image is no longer at that line' }));
        return;
      }
      const mime = String(block.mimeType || 'image/png');
      const data = /^data:/i.test(block.data) ? block.data.slice(block.data.indexOf(',') + 1) : block.data;
      const bytes = Buffer.from(data, 'base64');
      const etag = `"${crypto.createHash('sha1').update(`${ref.path || ref.container}:${wantLine}:${wantPart}:${data.length}`).digest('hex')}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': 'private, max-age=31536000, immutable' });
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': bytes.length,
        ETag: etag,
        // immutable: the URL changes whenever the file does, so this can be cached
        // for as long as the browser likes and never be revalidated
        'Cache-Control': 'private, max-age=31536000, immutable',
      });
      res.end(bytes);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: `read failed: ${e.message}` }));
    }
    return;
  }

  if (req.url.startsWith('/api/session-messages')) {
    const purl = new URL(req.url, 'http://x');
    const p = purl.searchParams.get('path') || '';
    // `?inline=1` puts the picture bytes back into the response, exactly as this
    // endpoint behaved before. There is no flag for the other way round: naming
    // the pictures is the default, because it is what makes a session open in
    // under a second instead of downloading every picture ever pasted into it.
    const inlineImages = purl.searchParams.get('inline') === '1' || purl.searchParams.get('inline') === 'true';
    if (!p) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing path' }));
      return;
    }
    const ref = sessionRef(p);
    if (!ref) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'path must stay inside the session dir' }));
      return;
    }
    let gz = null;
    let w = null;
    try {
      // Both halves of that are measured, not assumed:
      //
      //  - Base64 is already high-entropy, so gzipping an image-heavy session
      //    costs seconds of CPU to save a fraction of it (1315 ms to save 17 of
      //    70 MB on a real one).
      //  - Compressing anything at all is a loss on loopback, where the transfer
      //    is free and the CPU is not. Measured on the same machine: a 21 MB
      //    session went from 275 ms to 458 ms with compression on, and a 4.5 MB
      //    one from 76 ms to 93 ms - all of it spent compressing bytes that were
      //    going to arrive in a millisecond anyway. Over the LAN the same
      //    compression is a 4x smaller transfer, which is worth far more.
      //
      // So: is the client on this machine? Is the file mostly pictures? Only then
      // is it worth a CPU core.
      //
      // Note the order, which cost a day: asking for the file's size is itself
      // work - a `docker exec stat` in container mode is ~90 ms of container
      // startup - so it happens only when the answer can change the outcome. On
      // loopback the whole question is skipped and the response starts streaming
      // immediately, which is the common case.
      const remote = String((req.socket && req.socket.remoteAddress) || '');
      const local = !remote || remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
      const wantsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
      let compress = false;
      let stamp = '';
      if (wantsGzip && !local) {
        const size = await sessionSize(ref);
        if (size > 256 * 1024) compress = (await imageDensity(ref)) < 0.35;
      }
      // the token on every image reference, so a session that changes invalidates
      // the browser's cached copies of the pictures in it
      if (!inlineImages) {
        try {
          const st = ref.kind === 'docker'
            ? String(await dockerCapture(ref.container, ['stat', '-c', '%s-%Y', ref.path], 20000) || '').trim()
            : (() => { const s = fs.statSync(ref.path); return `${s.size}-${Math.floor(s.mtimeMs)}`; })();
          stamp = st;
        } catch { /* no token: the URL still works, it is just not cache-busted */ }
      }
      if (compress) {
        gz = zlib.createGzip({ level: 1 });
        gz.on('error', () => { /* the client hung up; the socket is already gone */ });
        gz.pipe(res);
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        // no Content-Length on purpose: the length is not known until the last
        // line is parsed, and inventing one is what made this a 378 ms wait
        ...(gz ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
        'Cache-Control': 'no-store',
      });
      // A bigger socket buffer, so a chunked transcript is not reported "full"
      // every 16 KB - that alone turned streaming into a slow drip.
      try { res._writableState.highWaterMark = 1 << 20; } catch { /* older node */ }
      // Built AFTER the gzip decision, and pointed at whatever actually carries
      // the bytes. Writing to `res` while the header said gzip produced plain
      // JSON with a gzip label on it, which no browser can read.
      w = writeStream(gz || res);
      w.add(`{"path":${JSON.stringify(p)},"messages":[`);
      await w.flush();
      let first = true, n = 0, parent = null, line = 0, stripped = 0, saved = 0;
      const compactions = [];
      /* Record where each line starts while the file is being read anyway, so
       * /api/session-image can seek straight to one instead of reading up to it.
       * The stamp is taken unconditionally now: it is one stat, it keys the index,
       * and the picture URLs need it in the same form. */
      let stampKey = stamp;
      if (!stampKey) { try { stampKey = await sessionStamp(ref); } catch { /* no index */ } }
      const lineOffsets = [];
      const wantIndex = !!stampKey && !inlineImages;
      for await (const raw of sessionLines(ref, wantIndex ? (off) => lineOffsets.push(off) : undefined)) {
        line++;
        if (!raw.trim()) continue;
        let e; try { e = JSON.parse(raw); } catch { continue; }
        if (!e) continue;
        // The header records where a fork came from - deleting a fork can send
        // you back to its original session instead of a blank one.
        if (e.type === 'session' && e.parentSession) parent = e.parentSession;
        if (e.type === 'message' && e.message) {
          // entryId travels with the message so the UI can offer "fork from
          // here" while reading a session the agent has not loaded.
          const m = { ...e.message, timestamp: e.message.timestamp ?? e.timestamp, entryId: e.id || null };
          if (!inlineImages) {
            const r = externaliseImages(m, p, line, stamp);
            stripped += r.n; saved += r.saved;
          }
          w.add((first ? '' : ',') + JSON.stringify(m));
          first = false;
          if (w.size >= WRITE_CHUNK) await w.flush();
        } else if (e.type === 'compaction' && e.summary) {
          // Compactions are their own entry type (not messages), so they are
          // missing from get_messages - without these the "conversation
          // compacted" markers vanished as soon as the page was reloaded.
          compactions.push({
            summary: e.summary,
            tokensBefore: e.tokensBefore != null ? e.tokensBefore : null,
            estimatedTokensAfter: e.estimatedTokensAfter != null ? e.estimatedTokensAfter : null,
            id: e.id || null,
            timestamp: e.timestamp || null,
          });
        }
        // Hand the thread back every so often, and check whether anything was
        // waiting on us (the agent's stream, another request) before the next
        // batch. Without this a long read froze every socket on the bridge.
        if (++n % 250 === 0) {
          await breathe();
          if (res.writableEnded || res.destroyed) return;
        }
      }
      w.add(`],"compactions":${JSON.stringify(compactions)},"parent":${JSON.stringify(parent)}` +
        (stripped ? `,"imagesOut":${stripped},"imageBytes":${saved}` : '') + '}');
      await w.flush();
      // Only worth keeping if it lines up with what was actually written out.
      if (wantIndex && lineOffsets.length >= line) indexPut(indexKey(ref, stampKey), lineOffsets);
      if (gz) gz.end(); else res.end();
    } catch (e) {
      try { if (gz) gz.destroy(); } catch { /* already gone */ }
      if (w) { try { w.buf.length = 0; w.size = 0; } catch { /* gone */ } }
      if (res.headersSent) { try { res.end(); } catch { /* gone */ } return; }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `read failed: ${e.message}` }));
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
  /* Opening the WebUI to the network is a decision people should be able to make
   * in the UI rather than by editing a JSON file next to the bridge. Reading and
   * writing the same file the startup banner reads keeps one source of truth, and
   * the server rebinds live, so no restart is needed. */
  if (req.url.startsWith('/proxy/')) {
    const parsed = splitProxyPath(req.url);
    if (!parsed) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not a configured instance' }));
      return;
    }
    proxyHttp(req, res, parsed.base, parsed.path);
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
      build: (() => {
        try { const st = fs.statSync(path.join(__dirname, '..', 'web', 'app.js')); return Math.round(st.mtimeMs) + '-' + st.size; } catch { return null; }
      })(),
    }));
    return;
  }

  if (req.url.startsWith('/api/health')) {
    // Which build is this? Two machines on the same URL can be serving very
    // different copies of web/, and there was no way to tell them apart.
    let build = 'unknown';
    try {
      const st = fs.statSync(path.join(__dirname, '..', 'web', 'app.js'));
      build = Math.round(st.mtimeMs) + '-' + st.size;
    } catch { /* not a checkout */ }
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

  // Every async subagent run this bridge can see. `session` filters to the runs
  // started from that session, so a panel only ever shows its own subagents -
  // and a reload gets them back from disk instead of an empty list.
  if (req.url.startsWith('/api/subagent-runs')) {
    const q = new URL(req.url, 'http://x').searchParams;
    const want = (q.get('session') || '').trim();
    try {
      const all = await listSubagentRuns();
      const runs = want ? all.filter((r) => sameSessionFilePath(r.sessionId, want)) : all;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, runs, total: all.length }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Local speech-to-text: started on request, never on boot. The Whisper
  // backend downloads ~200 MB of whisper.cpp plus the chosen model, so it waits
  // until someone actually picks it.
  if (req.url.startsWith('/api/subagent-output')) {
    const q = new URL(req.url, 'http://x').searchParams;
    const run = (q.get('run') || '').trim();
    const label = (q.get('label') || '').trim().replace(/[^\w.-]/g, '');
    const dir = (q.get('dir') || '').trim();
    if (!/^[\w.-]{6,80}$/.test(run)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing or odd run id' }));
      return;
    }
    try {
      let got = await subagentRunLog(dir).catch(() => null);
      let notes = got ? `live log: ${got.file}` : '';
      if (!got || !got.text || !got.text.trim()) {
        const art = await subagentArtifact(run, label).catch(() => null);
        if (art) { got = art; notes = `${notes ? notes + ' · ' : ''}artifact: ${art.file}`; }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: !!got, text: got ? got.text : '', file: got ? got.file : null, notes }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
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

  // llama.cpp: list every model each reachable server knows about. The
  // providerId matches what the pi-llama-cpp extension registers
  // ("llama-server=<baseUrl>"), so the WebUI can set_model directly.
  if (req.url.startsWith('/api/llama-models')) {
    // 5s cache: the UI probes on connect, on focus, and on a retry loop —
    // don't hammer the (possibly busy) llama server with identical requests.
    // Empty results are cached for only 2s so a starting server shows up fast.
    const ttl = llamaModelsCache.data && llamaModelsCache.data.servers.length ? 5000 : 2000;
    if (llamaModelsCache.data && Date.now() - llamaModelsCache.at < ttl) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(llamaModelsCache.data));
      return;
    }
    const candidates = [...llamaServerCandidates(), ...llamaLanUrls()];
    const unique = [...new Set(candidates)];
    const configured = readLlamaServerUrl();
    const rank = (u) => (configured && u === configured ? 0
      : /\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(u) ? 1 : 2);
    const answered = (await Promise.all(unique.map(async (url, i) => {
      const models = await fetchLlamaModels(url);
      if (!models || !models.length) return null;
      return { url, i, models, key: await llamaServerIdentity(url) };
    }))).filter(Boolean);
    // best address first, so the entry that survives dedupe is the one worth using
    answered.sort((a, b) => rank(a.url) - rank(b.url) || a.i - b.i);
    const byKey = new Map();
    const servers = [];
    for (const s of answered) {
      let key = s.key || 'models:' + s.models.map((m) => m.id).sort().join(',');
      // a second machine stays its own entry even when it serves the same file
      if (!isLocalLlamaAddress(s.url)) {
        try { key += '|host:' + new URL(s.url).host.toLowerCase(); } catch (e) { key += '|host:' + s.url; }
      }
      const seen = byKey.get(key);
      if (seen) { seen.alsoAt.push(s.url); continue; }
      const entry = { url: s.url, providerId: `llama-server=${s.url}`, models: s.models, alsoAt: [] };
      byKey.set(key, entry);
      servers.push(entry);
    }
    const payload = { servers, scanning: llamaLan.scanning };
    llamaModelsCache.at = Date.now();
    llamaModelsCache.data = payload;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }

  // Read / write the llamaServerUrl in pi's global settings (~/.pi/agent/settings.json).
  // pi-llama-cpp resolves this URL at agent startup, so after a change the agent
  // must be restarted (the UI sends {bridge:'restart'}) for it to take effect.
  if (req.url.startsWith('/api/llama-config')) {
    if (req.method === 'GET') {
      let url = null;
      let urls = [];
      try {
        const st = JSON.parse(fs.readFileSync(PI_SETTINGS_FILE, 'utf8'));
        urls = llamaConfiguredUrls(st);
        url = urls[0] || null;
      } catch { /* no file */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // LLAMA_SERVER_URL overrides the configured list in the extension, so the UI
      // has to say so - otherwise "point pi at both" looks like it did nothing.
      res.end(JSON.stringify({ url, urls, envOverride: String(process.env.LLAMA_SERVER_URL || '').trim() || null }));
      return;
    }
    if (req.method === 'POST') {
      let body0 = '';
      req.on('data', (c) => { body0 += c; if (body0.length > 64 * 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const body = JSON.parse(body0 || '{}');
          // `urls` (a list) is the extension's recommended form and registers every
          // server at once; `url` is the older single-value spelling.
          const wanted = Array.isArray(body.urls) ? body.urls : (body.url != null ? [body.url] : []);
          if (!wanted.length) throw new Error('send url or urls');
          const clean = [];
          for (const raw of wanted) {
            if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw.trim())) {
              throw new Error(`"${String(raw).slice(0, 60)}" is not an http(s) base URL`);
            }
            const u = raw.trim().replace(/\/+$/, '');
            if (!clean.includes(u)) clean.push(u);
          }
          if (clean.length > 16) throw new Error('at most 16 servers');
          let settings = {};
          try { settings = JSON.parse(fs.readFileSync(PI_SETTINGS_FILE, 'utf8')); } catch { /* defaults */ }
          const previous = llamaConfiguredUrls(settings);
          // pi-llama-cpp currently resolves llamaServerUrl at startup, and its
          // documented multi-server format is semicolon-separated URLs. The
          // llamaSettings.servers list is kept for newer versions of the
          // extension, but on its own it is ignored by the installed version —
          // which made the UI say it had pointed pi at the LAN server while pi
          // continued registering only 127.0.0.1.
          settings.llamaServerUrl = clean.join(';');
          settings.llamaSettings = Object.assign({}, settings.llamaSettings, {
            servers: clean.map((url) => ({ url })),
          });
          fs.mkdirSync(path.dirname(PI_SETTINGS_FILE), { recursive: true });
          fs.writeFileSync(PI_SETTINGS_FILE, JSON.stringify(settings, null, 2));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, previous, urls: clean, format: 'semicolon-separated llamaServerUrl' }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    res.writeHead(405).end();
    return;
  }

  // Installed system fonts (Windows: font registry; fallback: font dirs).
  // Cached 5 minutes — the registry query is slow-ish.
  if (req.url.startsWith('/api/system-fonts')) {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const now = Date.now();
    if (fontsCache.list && now - fontsCache.at < 5 * 60 * 1000) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fontsCache.list));
      return;
    }
    (async () => {
      const families = new Set();
      const addFamily = (fam) => {
        if (fam && !/\.(ttf|otf|ttc|woff2?)$/i.test(fam)) families.add(fam.trim());
      };
      // Prefer the family name from the font file's own name table (what the
      // browser matches on); fall back to the registry-derived label.
      const familyOf = (file, fallback) => {
        let fam = null;
        if (file) {
          try {
            if (fs.statSync(file).size < 10 * 1024 * 1024) fam = ttfFamilyName(fs.readFileSync(file));
          } catch { /* unreadable */ }
        }
        addFamily(fam || fallback);
      };
      const windowsFonts = path.win32.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
      const userFonts = path.win32.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts');
      const regKey = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts';
      const regUser = 'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts';
      for (const key of [regKey, regUser]) {
        try {
          const out = await new Promise((resolve, reject) => {
            const { execFile } = require('child_process');
            execFile('reg', ['query', key], { timeout: 8000 }, (e, stdout) => e ? reject(e) : resolve(stdout || ''));
          });
          for (const line of out.split('\n')) {
            const m = line.trim().match(/^(.+?)\s+REG_SZ\s+(.+)$/);
            if (!m) continue;
            const label = m[1], val = m[2];
            if (val.includes(',')) {
              // Standard layout (machine fonts): key = file name, value =
              // "Family, version".
              familyOf(path.win32.join(windowsFonts, label), val.split(',')[0].trim());
            } else if (/\.(ttf|otf|ttc|woff2?)$/i.test(val)) {
              // Reversed layout (user fonts): key = "Label (TrueType)",
              // value = full file path.
              familyOf(val.trim(), label.replace(/\s*\([^)]*\)\s*$/i, '').trim());
            }
          }
        } catch { /* registry unavailable / no user fonts */ }
      }
      if (!families.size) {
        // Fallback: scan font directories (family ≈ file base name)
        for (const dir of [windowsFonts, userFonts]) {
          try {
            for (const f of fs.readdirSync(dir)) {
              if (/\.(ttf|otf|ttc|woff2?)$/i.test(f)) familyOf(path.join(dir, f), f.replace(/\.[^.]+$/, ''));
            }
          } catch { /* dir missing */ }
        }
      }
      fontsCache.list = { at: now, fonts: [...families].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fontsCache.list));
    })().catch((e) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  // Download a session file (the sidebar's right-click -> export), and delete
  // one when the user explicitly confirms. Both are restricted to files inside
  // the configured session directory.
  if (req.url.startsWith('/api/session-file')) {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const raw = new URL(req.url, 'http://localhost').searchParams.get('path') || '';
    const ref = sessionRef(raw);
    if (!ref) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'session not found' })); return; }
    const name = path.basename(ref.path);
    if (ref.kind === 'docker') {
      // Streamed straight out of the container: a long session can be tens of
      // megabytes, and buffering it here only to hand it on would double it.
      res.writeHead(200, {
        'Content-Type': 'application/jsonl',
        'Content-Disposition': `attachment; filename="${name}"`,
      });
      const child = spawn('docker', ['exec', ref.container, 'cat', ref.path], { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.pipe(res);
      child.on('error', () => res.destroy());
      return;
    }
    const st = fs.statSync(ref.path);
    res.writeHead(200, {
      'Content-Type': 'application/jsonl',
      'Content-Length': st.size,
      'Content-Disposition': `attachment; filename="${name}"`,
    });
    fs.createReadStream(ref.path).pipe(res);
    return;
  }
  if (req.url.startsWith('/api/session-delete')) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      try {
        const { path: raw } = JSON.parse(body || '{}');
        const ref = sessionRef(raw);
        if (!ref) throw new Error('session not found');
        await deleteSessionRef(ref);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: ref.path }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Save an uploaded file (PDF / audio / video / other) into the workspace so
  // the agent can read it with its tools. Body: {name, data(base64), mimeType}.
  // Serve a previously uploaded file back to the browser. Used for background
  // images / GIFs / videos, which would otherwise blow the localStorage quota
  // as data URLs. Only files inside an uploads dir are reachable (basename-only,
  // no traversal).
  if (req.url.startsWith('/api/bg-file')) {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    try {
      const raw = new URL(req.url, 'http://localhost').searchParams.get('name') || '';
      const name = path.basename(decodeURIComponent(raw));
      let file = null;
      for (const dir of UPLOAD_DIRS) {
        const cand = path.join(dir, name);
        if (name && cand.startsWith(dir + path.sep) && fs.existsSync(cand)) { file = cand; break; }
      }
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      const types = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
        '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
        '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
        '.ogv': 'video/ogg', '.mkv': 'video/x-matroska',
        // Audio: the "when the agent finishes" sound the user picked. Without a
        // correct type the browser downloads it and then refuses to decode it,
        // which shows up as a notification that silently never plays. (.webm is
        // listed once, as video: it is both, and video is what this app plays
        // far more of - an audio/webm response still decodes as audio.)
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
        '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.opus': 'audio/opus',
        '.weba': 'audio/webm',
        '.cur': 'image/x-icon', '.ico': 'image/x-icon',
      };
      const st = fs.statSync(file);
      const type = types[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const headers = {
        'Content-Type': type,
        // Videos have to be advertised as seekable: a player cannot position
        // itself in a file the server will only send from the start, and the
        // animated avatars are kept on a shared frame by seeking them.
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400',
      };
      // Range requests, so one download can feed several elements (ten animated
      // avatars of the same clip used to open ten full downloads, and the ones
      // that did not fit the connection limit stalled).
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(String(range));
        let start = m && m[1] ? Number(m[1]) : 0;
        let end = m && m[2] ? Number(m[2]) : st.size - 1;
        if (!Number.isFinite(start) || start < 0) start = 0;
        if (!Number.isFinite(end) || end >= st.size) end = st.size - 1;
        if (start > end || start >= st.size) {
          res.writeHead(416, { ...headers, 'Content-Range': `bytes */${st.size}` });
          res.end();
          return;
        }
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      fs.createReadStream(file).pipe(res);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad request' }));
    }
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

  // Exact route: "/api/upload-raw" also starts with "/api/upload", and reading a
  // raw body as JSON gave "Unexpected token '\0'" on the first big upload.
  if (req.url.startsWith('/api/upload?') || req.url === '/api/upload') {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = '';
    const MAX = 256 * 1024 * 1024; // base64 of ~190 MB
    req.on('data', (c) => { body += c; if (body.length > MAX) { req.destroy(); } });
    req.on('end', () => {
      try {
        const { name, data, mimeType } = JSON.parse(body || '{}');
        if (typeof name !== 'string' || !name) throw new Error('name is required');
        if (typeof data !== 'string' || !data) throw new Error('data (base64) is required');
        const safe = name.replace(/[^\w.\- ()\[\]]/g, '_').slice(0, 120);
        const buf = Buffer.from(data, 'base64');
        const dir = UPLOAD_DIRS[0];
        fs.mkdirSync(dir, { recursive: true });
        // The same bytes are the same file: uploading the same screenshots again
        // (the usual way this happens) used to write another copy next to the
        // first one, with a new timestamp and the same content. The hash index
        // lives in the upload directory so it survives a bridge restart.
        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        const indexFile = path.join(dir, '.uploads-by-hash.json');
        let index = {};
        try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) || {}; } catch { /* first run */ }
        const known = index[hash];
        if (known) {
          try {
            const st = fs.statSync(known);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, path: known, size: st.size, mimeType: mimeType || null, duplicate: true }));
            return;
          } catch { delete index[hash]; }   // the file was removed by hand
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const file = path.join(dir, `${stamp}-${safe}`);
        fs.writeFileSync(file, buf);
        index[hash] = file;
        try { fs.writeFileSync(indexFile, JSON.stringify(index)); } catch { /* index is a nicety */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: file, size: buf.length, mimeType: mimeType || null }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  /* Upload without base64: the file *is* the body, so a 300 MB background video
   * costs 300 MB instead of 400 and never hits a JSON body cap. The base64 route
   * above stays for the small stuff (and for old pages). */
  if (req.url.startsWith('/api/upload-raw')) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const q = new URL(req.url, 'http://x').searchParams;
    const rawName = String(q.get('name') || 'file');
    const safe = rawName.replace(/[^\w.\- ()\[\]]/g, '_').slice(0, 120);
    const dir = UPLOAD_DIRS[0];
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    const tmp = path.join(dir, `.incoming-${process.pid}-${Date.now()}`);
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(tmp);
    const MAX_RAW = Number(process.env.PI_WEBUI_MAX_UPLOAD || 4 * 1024 * 1024 * 1024);
    let got = 0;
    let failed = null;
    const cleanup = () => { try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ } };
    req.on('data', (c) => {
      got += c.length;
      if (got > MAX_RAW) { failed = `file is larger than the ${Math.round(MAX_RAW / 1073741824)} GB upload limit`; req.destroy(); return; }
      hash.update(c);
    });
    req.on('error', () => { cleanup(); });
    out.on('error', (e) => { failed = e.message; cleanup(); });
    req.pipe(out);
    out.on('finish', () => {
      if (failed) {
        if (!res.headersSent) { res.writeHead(failed.indexOf('larger') === 0 ? 413 : 500, { 'Content-Type': 'application/json' }); }
        res.end(JSON.stringify({ error: failed }));
        return;
      }
      try {
        const digest = hash.digest('hex');
        const indexFile = path.join(dir, '.uploads-by-hash.json');
        let index = {};
        try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) || {}; } catch { /* first run */ }
        const known = index[digest];
        if (known) {
          try {
            const st = fs.statSync(known);
            cleanup();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, path: known, size: st.size, duplicate: true }));
            return;
          } catch { delete index[digest]; }
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const file = path.join(dir, `${stamp}-${safe}`);
        fs.renameSync(tmp, file);
        index[digest] = file;
        try { fs.writeFileSync(indexFile, JSON.stringify(index)); } catch { /* index is a nicety */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: file, size: got }));
      } catch (e) {
        cleanup();
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

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

/* ── pi's extensions, skills, packages and AGENTS.md ──────────────────────
 *
 * The management tab (issue #46). Everything here is read or written under
 * PI_AGENT_DIR and nowhere else, and nothing runs a shell: a name off the wire is
 * data, it is reduced to a basename, and the path it produces has to be a direct
 * child of the directory it belongs to.
 *
 * Enable/disable does NOT have its own mechanism. pi stores it as +path / -path /
 * !pattern entries inside the `extensions`, `skills`, `prompts` and `themes`
 * arrays of settings.json, and resolves them in isEnabledByOverrides()
 * (core/package-manager.js): anything not matched is enabled, `-rel` and `!rel`
 * disable, `+rel` re-enables. A pattern is the path relative to the agent dir, so
 * disabling the gitea skill writes "skills": ["-skills/gitea"]. This writes the
 * same format rather than inventing a second one - pi has to agree, or the switch
 * would look on and do nothing.
 *
 * There is deliberately no install here. Adding an extension means the agent will
 * load and run it, and this bridge has no authentication - only the Host/Origin
 * gate that stops a page on another origin driving it (issue #23). "Install" over
 * an unauthenticated port is "run my code on that machine", so it is left out
 * rather than shipped behind a confirmation nobody reads. The tab says so. */
const PI_EXT_DIR = path.join(PI_AGENT_DIR, 'extensions');
const PI_SKILLS_DIR = path.join(PI_AGENT_DIR, 'skills');
const PI_AGENTS_FILE = path.join(PI_AGENT_DIR, 'AGENTS.md');
const RESOURCE_ARRAYS = { extensions: 'extensions', skills: 'skills' };

/* A name that is exactly one path segment. Rejects "", ".", "..", anything with a
 * separator or a control character, and anything unreasonably long. */
function safeResourceName(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n || n === '.' || n === '..') return null;
  if (n.length > 200) return null;
  if (/[\\/\u0000-\u001f]/.test(n)) return null;
  if (n.includes('..')) return null;
  return n;
}

/* The one path a resource of this kind is allowed to be. basename() cannot escape
 * on its own, but the check is kept anyway: this is the value that decides what a
 * delete removes, and the guard has to be visible next to the rm - which is the
 * lesson from the two injection bugs this file has already had. */
function resourcePath(kind, name) {
  const safe = safeResourceName(name);
  if (!safe) return null;
  const root = kind === 'skills' ? PI_SKILLS_DIR : PI_EXT_DIR;
  if (path.basename(safe) !== safe) return null;
  const full = path.join(root, safe);
  if (!full.startsWith(root + path.sep)) return null;
  return full;
}

function readPiSettings() {
  try {
    const j = JSON.parse(fs.readFileSync(PI_SETTINGS_FILE, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch { return {}; }
}

function writePiSettings(settings) {
  // The same shape pi's own SettingsManager writes (JSON.stringify(x, null, 2)),
  // so its loader and this writer cannot disagree about the file.
  writeJsonAtomic(PI_SETTINGS_FILE, settings);
}

/* pi's override resolution, reduced to what a single row needs: is this resource
 * enabled? `rel` is the path relative to the agent dir, posix-separated. */
function resourceEnabled(patterns, rel, name) {
  const list = Array.isArray(patterns) ? patterns.filter((p) => typeof p === 'string') : [];
  const overrides = list.filter((p) => p.startsWith('!') || p.startsWith('+') || p.startsWith('-'));
  const accepts = (p) => p === rel || p === name;
  const excludes = overrides.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  const includes = overrides.filter((p) => p.startsWith('+')).map((p) => p.slice(1));
  const forceOut = overrides.filter((p) => p.startsWith('-')).map((p) => p.slice(1));
  let enabled = true;
  if (excludes.some(accepts)) enabled = false;
  if (includes.some(accepts)) enabled = true;
  if (forceOut.some(accepts)) enabled = false;
  return enabled;
}

/* Set one resource's override, replacing any earlier entry for it - what pi's
 * config selector does, and what stops the array growing a line per click.
 * enabled === null removes the override entirely. */
function setResourceOverride(list, rel, enabled) {
  const keep = (Array.isArray(list) ? list : []).filter((p) => {
    if (typeof p !== 'string') return true;
    const body = (p.startsWith('!') || p.startsWith('+') || p.startsWith('-')) ? p.slice(1) : p;
    return body !== rel;
  });
  if (enabled === null) return keep;
  keep.push(`${enabled ? '+' : '-'}${rel}`);
  return keep;
}

/* Loose resources: a .ts/.js file (or a directory holding one) under extensions/,
 * a directory holding SKILL.md under skills/. Anything else is ignored rather than
 * listed as something this tab cannot act on. Packages are entries in
 * settings.json, not files here, so they are listed separately. */
function listLooseResources(kind) {
  const root = kind === 'skills' ? PI_SKILLS_DIR : PI_EXT_DIR;
  const out = [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      const entry = kind === 'skills'
        ? fs.existsSync(path.join(full, 'SKILL.md'))
        : (fs.existsSync(path.join(full, 'index.ts')) || fs.existsSync(path.join(full, 'index.js')));
      if (!entry) continue;
      let modified = 0;
      try { modified = fs.statSync(full).mtimeMs; } catch { /* gone */ }
      out.push({ name: e.name, kind: 'dir', rel: kind + '/' + e.name, modified });
    } else if (e.isFile()) {
      if (kind === 'skills') continue;                     // a skill is a directory holding SKILL.md
      if (!/\.(ts|js|mjs|cjs)$/i.test(e.name)) continue;
      let size = 0, modified = 0;
      try { const st = fs.statSync(full); size = st.size; modified = st.mtimeMs; } catch { /* gone */ }
      out.push({ name: e.name, kind: 'file', rel: kind + '/' + e.name, size, modified });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/* The global AGENTS.md, plus the per-project ones pi would pick up walking up from
 * the agent's working directory. The project files are read-only here: they sit at
 * arbitrary ancestor paths, and writing one would be a write anywhere on disk. */
function agentContextFiles() {
  const out = [];
  out.push({
    path: PI_AGENTS_FILE, scope: 'global', exists: fs.existsSync(PI_AGENTS_FILE),
    writable: true, name: path.basename(PI_AGENTS_FILE),
  });
  const names = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'];
  let dir = path.resolve(WORKSPACE_DIR);
  /* Deduped case-insensitively: AGENTS.md and AGENTS.MD are one file on Windows and
   * macOS, and listing the same file twice under two of its own spellings is the
   * kind of thing that makes a list look broken. */
  const seen = new Set();
  const key = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  for (let hops = 0; hops < 24; hops++) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (key(p) === key(PI_AGENTS_FILE) || seen.has(key(p))) continue;
      seen.add(key(p));
      if (!fs.existsSync(p)) continue;
      let size = 0;
      try { size = fs.statSync(p).size; } catch { /* gone */ }
      out.push({
        path: p, scope: dir === path.resolve(WORKSPACE_DIR) ? 'project' : 'parent',
        exists: true, writable: false, name: n, size,
      });
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return out;
}

function jsonOut(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

if (req.url.startsWith('/api/pi-extensions')) {
  const only = req.url.split('?')[0];
  if (req.method === 'GET' && only === '/api/pi-extensions') {
    const settings = readPiSettings();
    const extPatterns = settings[RESOURCE_ARRAYS.extensions] || [];
    const skillPatterns = settings[RESOURCE_ARRAYS.skills] || [];
    const extensions = listLooseResources('extensions')
      .map((r) => Object.assign({}, r, { enabled: resourceEnabled(extPatterns, r.rel, r.name), source: 'local' }));
    const skills = listLooseResources('skills')
      .map((r) => Object.assign({}, r, { enabled: resourceEnabled(skillPatterns, r.rel, r.name), source: 'local' }));
    const packages = (Array.isArray(settings.packages) ? settings.packages : []).map((p, i) => ({
      index: i,
      source: typeof p === 'string' ? p : ((p && p.source) || ''),
      form: typeof p === 'string' ? 'string' : 'object',
      filters: (p && typeof p === 'object')
        ? Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'source'))
        : null,
    }));
    jsonOut(res, 200, {
      agentDir: PI_AGENT_DIR,
      settingsFile: PI_SETTINGS_FILE,
      extensions: extensions, skills: skills, packages: packages,
      counts: { extensions: extensions.length, skills: skills.length, packages: packages.length },
    });
    return;
  }

  if (req.method === 'POST' && only === '/api/pi-extensions/toggle') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1 << 20) req.destroy(); });
    req.on('end', () => {
      let j = null; try { j = JSON.parse(body || '{}'); } catch { j = null; }
      const kind = j && String(j.type || '');
      if (!j || !RESOURCE_ARRAYS[kind] || typeof j.enabled !== 'boolean') {
        return jsonOut(res, 400, { error: 'need {type: "extensions"|"skills", name, enabled}' });
      }
      const name = safeResourceName(j.name);
      const full = name ? resourcePath(kind, name) : null;
      if (!full || !fs.existsSync(full)) return jsonOut(res, 400, { error: 'no such resource' });
      const rel = kind + '/' + name;
      const settings = readPiSettings();
      settings[RESOURCE_ARRAYS[kind]] = setResourceOverride(settings[RESOURCE_ARRAYS[kind]], rel, j.enabled);
      // A list that is back to nothing has no reason to stay in the file.
      if (Array.isArray(settings[RESOURCE_ARRAYS[kind]]) && settings[RESOURCE_ARRAYS[kind]].length === 0) {
        delete settings[RESOURCE_ARRAYS[kind]];
      }
      try { writePiSettings(settings); }
      catch (e) { return jsonOut(res, 500, { error: 'could not write settings.json: ' + e.message }); }
      jsonOut(res, 200, { ok: true, name: name, rel: rel, enabled: j.enabled, settingsFile: PI_SETTINGS_FILE });
    });
    return;
  }

  if (req.method === 'POST' && only === '/api/pi-extensions/delete') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1 << 20) req.destroy(); });
    req.on('end', () => {
      let j = null; try { j = JSON.parse(body || '{}'); } catch { j = null; }
      const kind = j && String(j.type || '');
      if (!j || !RESOURCE_ARRAYS[kind]) return jsonOut(res, 400, { error: 'need {type: "extensions"|"skills", name}' });
      const name = safeResourceName(j.name);
      const full = name ? resourcePath(kind, name) : null;
      if (!full || !fs.existsSync(full)) return jsonOut(res, 400, { error: 'no such resource' });
      try { fs.rmSync(full, { recursive: true, force: true }); }
      catch (e) { return jsonOut(res, 500, { error: 'could not remove it: ' + e.message }); }
      const settings = readPiSettings();
      settings[RESOURCE_ARRAYS[kind]] = setResourceOverride(settings[RESOURCE_ARRAYS[kind]], kind + '/' + name, null);
      if (Array.isArray(settings[RESOURCE_ARRAYS[kind]]) && settings[RESOURCE_ARRAYS[kind]].length === 0) {
        delete settings[RESOURCE_ARRAYS[kind]];
      }
      try { writePiSettings(settings); } catch { /* it is gone either way */ }
      jsonOut(res, 200, { ok: true, removed: full });
    });
    return;
  }

  if (req.method === 'POST' && only === '/api/pi-extensions/package') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1 << 20) req.destroy(); });
    req.on('end', () => {
      let j = null; try { j = JSON.parse(body || '{}'); } catch { j = null; }
      const action = j && String(j.action || '');
      const source = j && typeof j.source === 'string' ? j.source.trim() : '';
      if (!j || (action !== 'add' && action !== 'remove')) {
        return jsonOut(res, 400, { error: 'need {action: "add"|"remove", source}' });
      }
      if (!source || source.length > 300) return jsonOut(res, 400, { error: 'need a source' });
      /* A source beginning with "-" is read by npm as a flag rather than a package
       * once pi installs it, so it is refused here rather than stored and refused
       * later by something that does not know what it is looking at. */
      if (source.startsWith('-')) return jsonOut(res, 400, { error: 'a package source cannot start with "-"' });
      if (/[\u0000-\u001f]/.test(source)) return jsonOut(res, 400, { error: 'a package source cannot contain control characters' });
      const settings = readPiSettings();
      const list = Array.isArray(settings.packages) ? settings.packages.slice() : [];
      const sourceOf = (p) => (typeof p === 'string' ? p : ((p && p.source) || ''));
      if (action === 'remove') {
        const next = list.filter((p) => sourceOf(p) !== source);
        if (next.length === list.length) return jsonOut(res, 404, { error: 'that package is not in the list' });
        settings.packages = next;
      } else {
        if (list.some((p) => sourceOf(p) === source)) return jsonOut(res, 409, { error: 'that package is already listed' });
        list.push(source);
        settings.packages = list;
      }
      if (Array.isArray(settings.packages) && settings.packages.length === 0) delete settings.packages;
      try { writePiSettings(settings); }
      catch (e) { return jsonOut(res, 500, { error: 'could not write settings.json: ' + e.message }); }
      jsonOut(res, 200, {
        ok: true, packages: settings.packages || [],
        note: action === 'add' ? 'listed in settings.json - pi fetches it the next time it starts, not from here' : undefined,
      });
    });
    return;
  }

  res.writeHead(405).end();
  return;
}

if (req.url.startsWith('/api/pi-agents')) {
  const only = req.url.split('?')[0];
  if (req.method === 'GET' && only === '/api/pi-agents') {
    const files = agentContextFiles().map((f) => {
      let content = '';
      try { content = fs.readFileSync(f.path, 'utf8'); } catch { /* unreadable */ }
      return Object.assign({}, f, {
        content: f.writable ? content : content.slice(0, 20000),
        truncated: !f.writable && content.length > 20000,
        bytes: content.length,
      });
    });
    jsonOut(res, 200, { global: files[0], files: files, workspace: WORKSPACE_DIR });
    return;
  }
  if (req.method === 'POST' && only === '/api/pi-agents') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4 << 20) req.destroy(); });
    req.on('end', () => {
      let j = null; try { j = JSON.parse(body || '{}'); } catch { j = null; }
      if (!j || typeof j.content !== 'string') return jsonOut(res, 400, { error: 'need {content}' });
      if (j.content.length > 4 * 1024 * 1024) return jsonOut(res, 413, { error: 'too large' });
      try {
        if (j.content.trim() === '') { try { fs.rmSync(PI_AGENTS_FILE, { force: true }); } catch { /* gone */ } }
        else fs.writeFileSync(PI_AGENTS_FILE, j.content, 'utf8');
      } catch (e) { return jsonOut(res, 500, { error: 'could not write it: ' + e.message }); }
      jsonOut(res, 200, { ok: true, path: PI_AGENTS_FILE, bytes: j.content.length });
    });
    return;
  }
  res.writeHead(405).end();
  return;
}


  if (req.url.startsWith('/api/pi-providers')) {
    if (req.method === 'GET') {
      const file = readJsonSafe(PI_MODELS_FILE) || {};
      const providers = {};
      for (const [id, p] of Object.entries(file.providers || {})) {
        providers[id] = {
          name: p.name || null,
          baseUrl: p.baseUrl || null,
          api: p.api || null,
          hasApiKey: !!p.apiKey,
          apiKey: maskKey(p.apiKey),
          models: (p.models || []).map((m) => (typeof m === 'string' ? { id: m } : m)),
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ file: PI_MODELS_FILE, providers }));
      return;
    }
    if (req.method === 'DELETE') {
      const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
      if (!PROVIDER_ID_RE.test(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid provider id' }));
        return;
      }
      const file = readJsonSafe(PI_MODELS_FILE) || {};
      if (!(file.providers && file.providers[id])) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `provider "${id}" not found` }));
        return;
      }
      delete file.providers[id];
      try {
        writeModelsFile(file);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `write failed: ${e.message}` }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, file: PI_MODELS_FILE, removed: id }));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const b = JSON.parse(body || '{}');
          const id = String(b.id || '').trim();
          const baseUrl = String(b.baseUrl || '').trim().replace(/\/+$/, '');
          const api = String(b.api || '');
          const apiKey = b.apiKey != null ? String(b.apiKey).trim() : '';
          if (!PROVIDER_ID_RE.test(id)) throw new Error('provider id must be 1-64 chars: letters, digits, . _ -');
          let u;
          try { u = new URL(baseUrl); } catch { throw new Error('base URL is not a valid URL'); }
          if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('base URL must be http or https');
          if (!ALLOWED_APIS.has(api)) throw new Error(`unsupported api "${api}"`);
          const models = [];
          if (b.models != null) {
            if (!Array.isArray(b.models)) throw new Error('models must be an array');
            for (const m of b.models.slice(0, 500)) {
              const mid = typeof m === 'string' ? m.trim() : (m && String(m.id || '').trim());
              if (!mid) continue;
              const src = typeof m === 'string' ? { id: mid } : { ...m };
              const clean = {};
              for (const f of MODEL_FIELDS) if (src[f] !== undefined) clean[f] = src[f];
              models.push(clean);
            }
          }
          const provider = { baseUrl: u.toString().replace(/\/$/, ''), api };
          if (b.name) provider.name = String(b.name).trim();
          if (apiKey) provider.apiKey = apiKey;
          if (models.length) provider.models = models;
          if (b.compat && typeof b.compat === 'object') provider.compat = b.compat;

          const file = readJsonSafe(PI_MODELS_FILE) || {};
          if (!file.providers || typeof file.providers !== 'object') file.providers = {};
          // blank key on an existing provider keeps its current key
          if (!apiKey && file.providers[id] && file.providers[id].apiKey) {
            provider.apiKey = file.providers[id].apiKey;
          }
          file.providers[id] = provider;
          writeModelsFile(file);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, file: PI_MODELS_FILE, id }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    res.writeHead(405).end();
    return;
  }

  serveStatic(req, res);
});

// ---------------------------------------------------------------- agent plumbing

// noServer + one upgrade router: the bridge's own sockets answer on /ws, and
// anything on /proxy/ is forwarded to the instance it names. Letting the server
// handle every upgrade itself would have aborted the proxy connections before
// they could be routed.
const wss = new WebSocketServer({ noServer: true });

/*
 * ONE agent, shared by every connected client.
 *
 * The bridge used to spawn a `pi --mode rpc` child per WebSocket, which meant
 * the browser WebUI and the native app were two independent agents: separate
 * sessions, separate models, and events only one of them ever saw -- so the two
 * UIs drifted apart until a manual refresh.
 *
 * Now there is a single child. Every client writes its commands to it, every
 * event is broadcast to every client, and all UIs stay in lockstep in real time.
 *
 * Command ids are only unique per client, so a `response` is routed back to the
 * socket that asked (pendingOwner) rather than broadcast -- otherwise two
 * clients using "req-1" would resolve each other's requests.
 */
let agent = null;               // the shared child process
const clients = new Set();      // connected sockets
// A reload closes the old socket and opens a new one a moment later. Killing the
// agent on the first close meant every reload restarted pi, and a reload right
// after sending a message could kill it before that message's session file had
// been written - the session then looked like it had vanished. Wait for the
// reconnect instead; a browser that really is closed still kills it, a few
// seconds later.
const IDLE_KILL_MS = parseInt(process.env.PI_WEBUI_IDLE_KILL_MS || '25000', 10);
let agentIdleTimer = null;
// rpc request id -> { ws, type, sessionPath }: the socket that sent it (the
// response is routed back to it, not broadcast - ids are only unique per
// client), plus the command so the bridge can track session changes.
const pendingOwner = new Map();
// RPCs issued by the bridge itself (session bookkeeping): their responses are
// consumed here instead of being routed to a client socket.
const bridgePending = new Map(); // request id -> { resolve, reject }
let bridgeReqId = 0;

function bridgeRpc(commandObj, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    if (!agent || !agent.stdin.writable) return reject(new Error('agent not running'));
    const id = `bridge-req-${++bridgeReqId}`;
    const entry = {
      resolve: (v) => { clearTimeout(t); resolve(v); },
      reject: (e) => { clearTimeout(t); reject(e); },
    };
    const t = setTimeout(() => {
      if (bridgePending.has(id)) { bridgePending.delete(id); entry.reject(new Error(`${commandObj.type}: timed out`)); }
    }, timeoutMs);
    bridgePending.set(id, entry);
    agent.stdin.write(JSON.stringify({ ...commandObj, id }) + '\n');
  });
}

function failBridgePending(reason) {
  for (const [id, entry] of bridgePending) {
    bridgePending.delete(id);
    entry.reject(new Error(reason));
  }
}

/* Keep the "last session" record current so a restarted agent can resume it.
 * switch_session says which file directly; new_session/fork/clone create a
 * file whose path the agent only reports via get_state. Cancelled switches
 * (an extension vetoed them) leave the agent where it was, so they are not
 * recorded. */
function trackSessionChange(parsed, owner) {
  if (!parsed || !parsed.success || !owner) return;
  const cmd = parsed.command || owner.type;
  const cancelled = parsed.data && parsed.data.cancelled === true;
  if (cmd === 'switch_session' && owner.sessionPath && !cancelled) {
    saveLastSession(owner.sessionPath);
  } else if ((cmd === 'prompt' || cmd === 'new_session' || cmd === 'fork' || cmd === 'clone') && !cancelled) {
    // A prompt can be the first thing that creates a session file, and its path
    // is reported nowhere else - re-read it, so the record matches the session
    // the message actually landed in.
    bridgeRpc({ type: 'get_state' }, 15000)
      .then((st) => { if (st && st.sessionFile) saveLastSession(st.sessionFile); })
      .catch(() => { /* agent gone; nothing to record */ });
  }
}

function broadcast(obj, except) {
  for (const ws of clients) {
    if (ws !== except) wsSend(ws, obj);
  }
}

// Tiny activity tracker for /api/health, which other instances poll to show a
// pulsing dot. agent_start .. agent_settled is exactly "a turn is running".
const agentStatus = { busy: false, sessionName: null, compacting: null };
function noteAgentActivity(obj) {
  if (!obj || typeof obj !== 'object') return;
  const sf = obj.sessionFile || (obj.session && obj.session.file) || null;
  if (sf) agentStatus.sessionFile = sf;
  switch (obj.type) {
    case 'agent_start': agentStatus.busy = true; break;
    case 'agent_settled':
    case 'agent_end': agentStatus.busy = false; break;
    case 'session_info_changed': if (obj.name) agentStatus.sessionName = obj.name; break;
    case 'agent_exit': agentStatus.busy = false; break;
    // A compaction is long (it reads the whole conversation and asks a model to
    // summarise it), and the "compacting…" block only lived in the page that
    // started it: reload while it runs and the page looked idle, with no way to
    // tell a finished compaction from one that never happened.
    case 'compaction_start':
      agentStatus.compacting = { since: Date.now(), session: agentStatus.sessionFile || null, automatic: !!obj.automatic };
      break;
    case 'compaction_end':
      agentStatus.compacting = null;
      break;
    default: break;
  }
}

const isWin = process.platform === 'win32';

// Kill a child and (on Windows) its whole process tree. `shell: true` spawns
// cmd.exe which then spawns the real agent, so a plain child.kill() would
// orphan the agent and keep it running in the background. taskkill /T kills
// the entire tree; on POSIX we kill the child's process group.
function killTree(child) {
  if (!child || child.pid == null) return;
  try {
    if (isWin) {
      execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  } catch { /* already gone */ }
}

function wsSend(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch { /* dead socket; keepalive reaps it */ }
  }
}

let agentRestarts = [];
let agentRestartTimer = null;

/* Bring the agent back after it exited with clients still connected. Bounded: a
 * command that cannot start at all must not respawn in a tight loop. */
function scheduleAgentRestart() {
  const now = Date.now();
  agentRestarts = agentRestarts.filter((t) => now - t < 60000);
  if (agentRestarts.length >= 5) {
    console.error('agent keeps exiting; not restarting again for now');
    broadcast({ bridge: 'agent_stderr', text: 'The agent keeps exiting - check the console for why.' });
    return;
  }
  agentRestarts.push(now);
  if (agentRestartTimer) return;
  agentRestartTimer = setTimeout(() => {
    agentRestartTimer = null;
    if (agent || shuttingDown || clients.size === 0) return;
    console.log('restarting the agent');
    try { startAgent(); } catch (e) { console.error('restart failed:', e.message); }
  }, 800);
}

function startAgent() {
  if (agent) return agent;

  // pi keeps its own idea of where its config and sessions live, and nothing
  // was telling it about the ones this bridge was pointed at: set
  // PI_SESSION_DIR (or PI_AGENT_DIR) and the sidebar listed a directory the
  // agent never wrote to, while the models.json and the llama endpoint saved in
  // Settings were read from a file pi never looked at. pi honours both as env
  // vars - PI_CODING_AGENT_DIR and PI_CODING_AGENT_SESSION_DIR - so it is told
  // exactly what the bridge itself uses. A docker:<ctr>:<dir> session dir is a
  // host-side alias for a path inside the container; the agent is already in
  // there and has no use for it.
  const childEnv = { ...process.env };
  if (!SESSION_DIR.startsWith('docker:')) {
    childEnv.PI_CODING_AGENT_SESSION_DIR = SESSION_DIR;
    childEnv.PI_CODING_AGENT_DIR = PI_AGENT_DIR;
  }
  let child;
  try {
    child = spawn(PI_COMMAND, {
      shell: true, // pi is an npm .cmd shim on Windows; shell handles both platforms
      cwd: hostSpawnDir(),
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !isWin, // POSIX: own process group so killTree can kill the whole tree
    });
  } catch (e) {
    console.error(`could not start the agent (${PI_COMMAND}): ${e.message}`);
    broadcast({
      bridge: 'agent_exit',
      error: `Failed to start "${PI_COMMAND}": ${e.message}. ` +
             `Is the pi coding agent installed and on PATH? (npm install -g @mariozechner/pi-coding-agent)`,
    });
    return null;
  }

  // Writing to an agent that is on its way out raises EPIPE / ECONNRESET on the
  // next flush, not on the write itself - so `child.stdin.writable` is true at
  // the moment the decision is made and the failure arrives a tick later, with
  // nobody listening. That is an unhandled 'error' event and it kills the whole
  // bridge: no agent, no other tab, no WebSocket. It happens on every restart
  // (/reload, a changed model, a /login) and every idle shutdown, whenever a
  // command from a client is still in flight.
  child.stdin.on('error', (err) => {
    if (DEBUG_RPC) console.log(`[rpc] agent stdin closed: ${err.message}`);
  });

  let buf = '';
  child.stdout.on('data', (d) => {
    // Only the current agent speaks for the bridge. A previous child that has
    // been replaced can still have output in flight, and its answers are about a
    // session nobody is in any more - that is how a client ended up looking at a
    // fresh, empty session while the real one sat right there.
    if (child !== agent) return;
    // Protocol requires splitting on \n only (not U+2028/U+2029 like readline).
    buf += d.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        broadcast({ bridge: 'agent_raw', line });
        continue;
      }
      // A response belongs only to the client that issued the request; events
      // (everything without a matching owner) go to everybody.
      noteAgentActivity(parsed);
      if (parsed && parsed.type === 'response' && parsed.id) {
        const bp = bridgePending.get(parsed.id);
        if (bp) {
          bridgePending.delete(parsed.id);
          parsed.success ? bp.resolve(parsed.data) : bp.reject(new Error(parsed.error || 'request failed'));
          continue;
        }
        if (pendingOwner.has(parsed.id)) {
          const owner = pendingOwner.get(parsed.id);
          pendingOwner.delete(parsed.id);
          if (DEBUG_RPC) console.log(`[rpc] -> ${parsed.command || owner.type}${parsed.success ? '' : ' FAILED: ' + (parsed.error || '')}`);
          wsSend(owner.ws, { bridge: 'rpc', payload: parsed });
          trackSessionChange(parsed, owner);
          continue;
        }
      }
      broadcast({ bridge: 'rpc', payload: parsed });
    }
  });

  child.stderr.on('data', (d) => {
    if (child !== agent) return;
    broadcast({ bridge: 'agent_stderr', text: d.toString('utf8') });
  });

  child.on('error', (err) => {
    // Without this, a command the shell cannot run at all (a bad path, a missing
    // docker, a workspace that does not exist here) failed in complete silence:
    // the console showed the startup banner and nothing else, and the UI sat
    // there empty with no reason given.
    console.error(`could not start the agent (${PI_COMMAND}): ${err.message}`);
    broadcast({
      bridge: 'agent_exit',
      error: `Failed to start "${PI_COMMAND}": ${err.message}. ` +
             `Is the pi coding agent installed and on PATH? (npm install -g @mariozechner/pi-coding-agent)`,
    });
  });

  child.on('exit', (code, signal) => {
    const wasCurrent = agent === child;
    if (wasCurrent) agent = null;
    if (!wasCurrent) return;   // a replaced child; its exit is not the bridge's business
    agentStatus.busy = false;
    failBridgePending('agent exited');
    console.log(`agent exited (code ${code}${signal ? ', signal ' + signal : ''})`);
    broadcast({ bridge: 'agent_exit', code, signal });
    // pi can end on its own - a container settling, a provider dropping the RPC
    // loop. Waiting for somebody to press "restart" leaves the page sitting in
    // whatever empty session the next start would create; bringing it back with
    // the recorded session is what the user actually wants to see.
    if (clients.size > 0 && !shuttingDown) scheduleAgentRestart();
  });

  agent = child;
  broadcast({
    bridge: 'agent_started',
    command: PI_COMMAND,
    workspace: WORKSPACE_DIR,
    sessionDir: SESSION_DIR,
  });
  // A fresh agent starts a brand-new empty session; put it back in the one the
  // user was in. Called from here, before this start returns, so the switch is
  // the first command on the pipe and no client can get in front of it.
  resumeLastSessionOnAgent();
  return child;
}

/* Ask the agent which session it is in and remember it. This is the record a
 * restart resumes from, so it is also taken just before the agent is stopped. */
async function recordCurrentSession(timeoutMs = 15000) {
  try {
    const st = await bridgeRpc({ type: 'get_state' }, timeoutMs);
    if (st && st.sessionFile) {
      if (DEBUG_RPC) console.log(`[session] recorded ${st.sessionFile}`);
      saveLastSession(st.sessionFile);
      return st.sessionFile;
    }
  } catch { /* agent gone or too slow - the previous record still stands */ }
  return null;
}

/* Put a freshly started agent back into the session the user was in.
 *
 * The switch has to be the first thing written to the agent's pipe, with nothing
 * awaited before it. pi starts every run in a new, empty session, and that
 * session's file does not exist until the first message arrives. This used to
 * wait for an existence check first (a `docker exec test -f` in container mode,
 * easily hundreds of milliseconds), while the browser connecting in the same
 * breath sent its own get_state and prompt. Those overtook the switch: the page
 * showed the fresh session, the prompt went into it, and the switch arriving
 * afterwards moved the agent off it again. Send a message, reload immediately,
 * and the session you were writing in looked like it had disappeared.
 *
 * Now the switch is written immediately - a missing file only makes it fail, and
 * that is handled below - so a client's commands can only be processed after it.
 */
// The session the last resume landed in. A page that connects after the resume
// has finished (the usual case: the bridge resumes within a few hundred
// milliseconds of starting, while the browser is still opening its socket) never
// sees the broadcast that goes with it, and renders the empty transcript of the
// fresh session its own get_state came back with. Handing late arrivals the same
// news is what makes the transcript come back.
let lastResumed = null;

function resumeLastSessionOnAgent() {
  const last = loadLastSession();
  if (!last) { recordCurrentSession(); return; }
  // Ask whether the file is still there *before* switching: a record left behind
  // by a session that has since been deleted (or by another bridge that used a
  // different session dir) used to produce a failed switch, a "could not reopen
  // your last session" toast and - with a pi that does not answer - a wedged
  // agent that had to be restarted. None of that is a resume.
  sessionFileExists(last).then((exists) => {
    if (exists) return resumeInto(last);
    console.warn(`forgetting last session (gone): ${last}`);
    forgetLastSession();
    recordCurrentSession();
  }).catch(() => resumeInto(last));   // a docker failure: let the agent decide
}

function resumeInto(last) {
  bridgeRpc({ type: 'switch_session', sessionPath: last }, 30000)
    .then(() => {
      console.log(`resumed last session: ${last}`);
      lastResumed = last;
      broadcast({ bridge: 'session_resumed', path: last });
      recordCurrentSession();
    })
    .catch(async (e) => {
      // Gone, or its working directory is gone: the agent stays in its fresh
      // session (the WebUI offers the usual folder-recreate flow when the old
      // session is clicked in the sidebar).
      console.warn(`could not resume last session ${last}: ${e.message}`);
      const answer = await recordCurrentSession(8000);
      if (!answer && agent) {
        // The switch did not fail so much as stop: an agent that cannot even
        // say which session it is in is wedged, and every later command would
        // queue behind it. Drop the record that led here (so the restart cannot
        // hit the same wall) and give it a fresh start.
        console.warn('agent did not answer after the failed resume - restarting it');
        forgetLastSession();
        killTree(agent);
        agent = null;
        startAgent();
        return;
      }
      sessionFileExists(last)
        .then((exists) => { if (!exists) broadcast({ bridge: 'session_resume_failed', path: last }); })
        .catch(() => { /* container gone; nothing to report */ });
    });
}

server.on('upgrade', (req, socket, head) => {
  /* The socket is the whole agent: every RPC, including `bash`, goes over it. A
   * WebSocket handshake carries Origin, so a page on another site can open one to
   * this bridge - and the same-origin policy does not stop it establishing the
   * connection, only reading the result. Same two checks as an HTTP write
   * (issue #23). */
  const refused = (() => {
    const host = hostOnly(req.headers.host);
    if (!host) return 'no Host header';
    if (!allowedHostNames().has(host)) return `Host "${host}" is not an address this bridge answers on`;
    const origin = req.headers.origin;
    if (!origin) return null;                     // not a browser
    try {
      const u = new URL(String(origin));
      const selfProto = req.socket && req.socket.encrypted ? 'https:' : 'http:';
      if (hostOnly(u.host) === host && u.protocol === selfProto) return null;
    } catch { return `Origin "${String(origin).slice(0, 60)}" is not a URL`; }
    return `Origin "${String(origin).slice(0, 60)}" is not this bridge`;
  })();
  if (refused) {
    console.warn(`refused websocket ${String(req.url).slice(0, 60)}: ${refused}`);
    try {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    } catch { /* already gone */ }
    socket.destroy();
    return;
  }

  const parsed = splitProxyPath(req.url);
  if (parsed) {
    proxyWss.handleUpgrade(req, socket, head, (client) => proxyWss.emit('connection', client, req, parsed));
    return;
  }
  if ((req.url || '').startsWith('/ws')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    return;
  }
  socket.destroy();
});

wss.on('connection', (ws) => {
  clients.add(ws);
  if (agentIdleTimer) { clearTimeout(agentIdleTimer); agentIdleTimer = null; }
  // Keepalive bookkeeping: the bridge pings every 30s (see below) and a dead
  // client is terminated once it misses a round. Without this, half-open
  // connections (sleep/wake, WebView2 network hiccups) linger in `clients`
  // forever, so "last one out turns off the lights" never fires for a client
  // that is actually gone.
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // A client socket error must not take the bridge down — an unhandled
  // 'error' event would crash the process and drop every other client.
  ws.on('error', () => { /* 'close' follows */ });
  startAgent();
  // Tell the newcomer where it is, and let it pull the current state itself.
  wsSend(ws, {
    bridge: 'agent_started',
    command: PI_COMMAND,
    workspace: WORKSPACE_DIR,
    sessionDir: SESSION_DIR,
  });
  // ... and which session the agent was put back into, in case this page missed
  // the broadcast while it was still connecting.
  if (lastResumed) wsSend(ws, { bridge: 'session_resumed', path: lastResumed });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (msg.bridge === 'restart') {
      // Shared process: everyone gets the fresh agent.
      const old = agent;
      agent = null;
      if (old) killTree(old);
      setTimeout(() => startAgent(), 150);
      return;
    }
    if (msg.bridge) return; // bridge-level chatter is not forwarded
    if (agent && agent.stdin.writable) {
      // Remember who asked (and what they asked), so the response goes back
      // to them and not to everybody (ids are only unique per client), and
      // session-changing commands keep the last-session record current.
      if (DEBUG_RPC) console.log(`[rpc] <- ${msg.type}${msg.sessionPath ? ' ' + msg.sessionPath : ''}`);
      if (msg.id) pendingOwner.set(msg.id, { ws, type: msg.type, sessionPath: msg.sessionPath });
      agent.stdin.write(JSON.stringify(msg) + '\n');
    } else {
      wsSend(ws, { bridge: 'agent_stderr', text: 'Agent process is not running.' });
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    // Drop any requests this client will never read.
    for (const [id, owner] of pendingOwner) {
      if (owner.ws === ws) pendingOwner.delete(id);
    }
    // Last one out turns off the lights (after the grace period above), so an
    // abandoned agent is not left running in the background. The session is
    // recorded first: this is the last moment the agent can say which session it
    // is in, and that record is what the next start resumes from.
    if (clients.size === 0 && agent && !agentIdleTimer) {
      agentIdleTimer = setTimeout(async () => {
        agentIdleTimer = null;
        if (clients.size > 0 || !agent) return;
        await recordCurrentSession(8000);
        if (clients.size > 0) return;   // somebody came back while we waited
        killTree(agent);
        agent = null;
      }, IDLE_KILL_MS);
      if (agentIdleTimer.unref) agentIdleTimer.unref();
    }
  });
});

// Keepalive: ping every client every 30s and terminate any that miss a round.
// The browser/WebView answers pings automatically, so a pong proves the whole
// path (page -> WebView -> bridge) is alive. This is what lets both ends
// notice a half-open connection: the client side runs its own liveness
// heartbeat (web/app.js) and auto-reconnects.
setInterval(() => {
  for (const ws of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* socket already closing */ }
  }
}, 30000);

// A failed listen() (usually EADDRINUSE from an older bridge still running)
// must produce a readable message instead of a stack trace.
//
// The error is delivered on both objects: `ws` re-emits the http server's
// 'error' event on the WebSocketServer, and it registers that forwarder first -
// so without a listener on the WebSocketServer the unhandled 'error' throw
// happens before the http server's own handler ever runs.
let listening = false;
function onFatalServerError(err) {
  if (listening) {
    // Already serving - a stray socket error must not take the bridge down.
    console.error('socket error (ignored):', (err && err.message) || err);
    return;
  }
  if (err && err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  Port ${PORT} is already in use - another Pi Agent WebUI is probably`);
    console.error('  still running (maybe an old window you forgot about).');
    console.error('');
    console.error('  Either close that window, or free the port with:');
    console.error(`    netstat -ano | findstr :${PORT}`);
    console.error('    taskkill /PID <pid> /F');
    console.error('');
    console.error('  (start-webui.bat offers to stop the old one for you.)');
    console.error('');
    process.exit(1);
  }
  if (err && err.code === 'EACCES') {
    console.error(`  Cannot bind port ${PORT} - permission denied. Try a port above 1024.`);
    process.exit(1);
  }
  console.error('server error:', (err && err.message) || err);
  process.exit(1);
}

server.on('error', onFatalServerError);
wss.on('error', onFatalServerError);
// Same story one level up: a TCP connection that is reset before the request
// even parses (a browser that gave up on a slow one) arrives here. Without a
// listener Node prints it and, for some codes, tears the process down.
server.on('clientError', (err, socket) => {
  try { socket.destroy(); } catch { /* already gone */ }
});

server.listen(PORT, HOST, () => {
  listening = true;
  console.log(`Pi Agent WebUI`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  agent command : ${PI_COMMAND}`);
  console.log(`  workspace     : ${WORKSPACE_DIR}`);
  console.log(`  session dir   : ${SESSION_DIR}`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    console.log('');
    console.log('  !! reachable from your network, not just this machine.');
    const lan = lanAddress();
    if (lan) console.log(`     from other devices on the LAN:  http://${lan}:${PORT}`);
    console.log('     Anyone on the LAN can drive this agent - there is no login.');
    console.log('     Set "lan": false in bridge/lan.json (or PI_WEBUI_HOST) to keep it local again.');
    console.log('');
  }
  console.log('  speech to text: browser by default; the local whisper.cpp server is');
  console.log('                  downloaded on first use (mic click or Settings > Voice)');
  if (process.env.AUTO_WHISPER === '1') {
    startWhisper(DEFAULT_MODEL).then((u) => { whisperUrl = u; });
  }
});

// ---------------------------------------------------------------- shutdown

// Ctrl+C (SIGINT) or a stop signal (SIGTERM) should cleanly stop the agent
// subprocesses and the whisper server instead of leaving them running in the
// background. The 'exit' handler is a synchronous last resort that also covers
// "close the console window" on Windows, where the signal handlers may not get
// a chance to run.
let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nStopping Pi Agent WebUI — killing agent processes…');
  if (agent) killTree(agent);
  stopWhisper();
  try { server.close(); } catch { /* ignore */ }
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => {
  if (agent) {
    try {
      if (isWin) execSync(`taskkill /F /T /PID ${agent.pid}`, { stdio: 'ignore' });
      else agent.kill('SIGKILL');
    } catch { /* already gone */ }
  }
  try { stopWhisper(); } catch { /* ignore */ }
});
