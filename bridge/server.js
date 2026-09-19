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
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile, execSync } = require('child_process');
const { pathToFileURL } = require('url');
const { WebSocketServer } = require('ws');
const { startWhisper, stopWhisper } = require('./whisper_boot');

const PORT = parseInt(process.env.PORT || '3000', 10);
const PI_COMMAND = process.env.PI_COMMAND || 'pi --mode rpc';
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || process.cwd();
// Session dir for listing. Either a normal path, or "docker:<container>:<path>"
// to list sessions inside a container via `docker exec` (used when the pi
// agent runs in an existing container, e.g. PI_COMMAND="docker exec -i ctr pi --mode rpc").
const SESSION_DIR =
  process.env.PI_SESSION_DIR || path.join(os.homedir(), '.pi', 'agent', 'sessions');
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
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

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

function execCapture(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: false },
      (err, stdout) => resolve(err ? '' : stdout));
  });
}

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

function nameFromTail(file, bytes = 64 * 1024) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(bytes, st.size);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    let text = buf.toString('utf8');
    // a tail read usually starts mid-line — drop the partial first line
    if (st.size > len) text = text.slice(text.indexOf('\n') + 1);
    return nameFromText(text);
  } catch { /* unreadable */ }
  return null;
}

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

function scanLocalSessions() {
  let files;
  try {
    files = fs.readdirSync(SESSION_DIR, { recursive: true })
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(SESSION_DIR, f));
  } catch {
    return [];
  }
  const sessions = [];
  for (const file of files) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    let title = '';
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(64 * 1024);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      title = titleFromHead(buf.toString('utf8', 0, read));
    } catch {
      /* unreadable file — fall back to file name */
    }
    const name = path.basename(file);
    // prefer an explicit rename (tail) over the derived first-message title
    const explicit = nameFromTail(file);
    sessions.push({
      path: file,
      fileName: name,
      name: explicit || title || name.replace(/\.jsonl$/, ''),
      mtime: st.mtimeMs,
      size: st.size,
    });
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions.slice(0, 200);
}

async function scanDockerSessions(container, dir) {
  // Recursive "mtime size path" lines, newest first. find -printf is GNU; the
  // sandbox images are Debian-based so this holds.
  const statOut = await execCapture('docker', ['exec', container, 'sh', '-c',
    `find '${dir}' -name '*.jsonl' -printf '%T@ %s %p\\n' 2>/dev/null | sort -rn | head -200`]);
  if (!statOut.trim()) return [];
  const files = statOut.trim().split('\n').map((l) => {
    const [mtime, size, ...rest] = l.trim().split(' ');
    return {
      path: rest.join(' '),
      fileName: rest.join(' ').split('/').pop(),
      mtime: Math.floor(parseFloat(mtime) * 1000),
      size: parseInt(size, 10) || 0,
    };
  }).filter((f) => f.path.endsWith('.jsonl'));

  // Pull a title out of each file head + any explicit renames from the tail.
  const heads = await execCapture('docker', ['exec', container, 'sh', '-c',
    `for f in ${files.map((f) => `'${f.path}'`).join(' ')}; do` +
    ` echo "===PIWEBUI $f"; head -c 32768 "$f"; echo;` +
    ` echo "===PIWEBUITAIL $f"; tail -c 65536 "$f" 2>/dev/null; echo; done`], 30000);
  const titleByFile = {};
  const explicitByFile = {};
  for (const chunk of heads.split('===PIWEBUI')) {
    const nl = chunk.indexOf('\n');
    if (nl < 0) continue;
    const marker = chunk.slice(0, nl).trim();
    const body = chunk.slice(nl + 1);
    if (marker.startsWith('TAIL ')) explicitByFile[marker.slice(5).trim()] = nameFromText(body);
    else if (marker) titleByFile[marker] = titleFromHead(body);
  }
  return files.map((f) => ({
    path: f.path,
    fileName: f.fileName,
    name: explicitByFile[f.path] || titleByFile[f.path] || f.fileName.replace(/\.jsonl$/, ''),
    mtime: f.mtime,
    size: f.size,
  }));
}

async function scanSessions() {
  const remote = parseSessionDir();
  if (remote) {
    try {
      return await scanDockerSessions(remote.container, remote.dir);
    } catch {
      return [];
    }
  }
  return scanLocalSessions();
}

// UI settings (appearance, agent name/avatar, voice). PI_WEBUI_SETTINGS lets a
// second instance - a test bridge, say - keep its own file instead of writing
// over the real one next to the source.
const SETTINGS_FILE = process.env.PI_WEBUI_SETTINGS || path.join(__dirname, '..', 'webui-settings.json');

// ---------------------------------------------------------------- llama.cpp + pi config

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/*
 * llama.cpp server URL candidates, in the same resolution order as the
 * pi-llama-cpp extension: project .pi/settings.json → $LLAMA_SERVER_URL →
 * global settings.json → auth.json (built-in provider) → default.
 */
function llamaServerCandidates() {
  const urls = [];
  const project = readJsonSafe(path.join(WORKSPACE_DIR, '.pi', 'settings.json'));
  if (project && project.llamaServerUrl) urls.push(project.llamaServerUrl);
  if (process.env.LLAMA_SERVER_URL) urls.push(process.env.LLAMA_SERVER_URL);
  const global = readJsonSafe(PI_SETTINGS_FILE);
  if (global && global.llamaServerUrl) urls.push(global.llamaServerUrl);
  const auth = readJsonSafe(PI_AUTH_FILE);
  if (auth && auth['llama.cpp'] && auth['llama.cpp'].env && auth['llama.cpp'].env.LLAMA_BASE_URL) {
    urls.push(auth['llama.cpp'].env.LLAMA_BASE_URL);
  }
  urls.push('http://127.0.0.1:8080');
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
async function fetchLlamaModels(url) {
  const parse = (d) => {
    const arr = Array.isArray(d) ? d : (Array.isArray(d.data) ? d.data : null);
    if (!arr) return null;
    return arr
      .filter((m) => m && typeof m.id === 'string')
      .map((m) => ({ id: m.id, name: m.name || m.id }));
  };
  try {
    const res = await fetch(url + '/v1/models', { signal: AbortSignal.timeout(1200) });
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

function writeModelsFile(file) {
  fs.mkdirSync(PI_AGENT_DIR, { recursive: true });
  fs.writeFileSync(PI_MODELS_FILE, JSON.stringify(file, null, 2) + '\n');
}

/* Small cache for /api/llama-models (the UI probes it on connect, focus and
 * a retry loop). */
const llamaModelsCache = { at: 0, data: null };

const server = http.createServer(async (req, res) => {
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessionDir: SESSION_DIR, sessions: await scanSessions() }));
    return;
  }
  // Read-only transcript of a session file. Lets the WebUI browse other
  // sessions while the shared agent keeps running in its own session
  // (the live view of the running session stays in the UI's DOM cache).
  // Local session dirs only — docker dirs would need `docker exec cat`.
  if (req.url.startsWith('/api/session-messages')) {
    const p = new URL(req.url, 'http://x').searchParams.get('path') || '';
    if (!p) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing path' }));
      return;
    }
    if (parseSessionDir()) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'docker session dirs are not supported here' }));
      return;
    }
    const root = path.resolve(SESSION_DIR);
    const resolved = path.resolve(root, p);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'path must stay inside the session dir' }));
      return;
    }
    try {
      const messages = [];
      const compactions = [];
      for (const line of fs.readFileSync(resolved, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e && e.type === 'message' && e.message) {
          messages.push({ ...e.message, timestamp: e.message.timestamp ?? e.timestamp });
        } else if (e && e.type === 'compaction' && e.summary) {
          // Compactions are their own entry type (not messages), so they are
          // missing from get_messages — without these the "conversation
          // compacted" markers vanished as soon as the page was reloaded.
          compactions.push({
            summary: e.summary,
            tokensBefore: e.tokensBefore != null ? e.tokensBefore : null,
            estimatedTokensAfter: e.estimatedTokensAfter != null ? e.estimatedTokensAfter : null,
            id: e.id || null,
            timestamp: e.timestamp || null,
          });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: p, messages, compactions }));
    } catch (e) {
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
  if (req.url.startsWith('/api/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
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
    const results = await Promise.all(llamaServerCandidates().map(async (url) => {
      const models = await fetchLlamaModels(url);
      return models ? { url, providerId: `llama-server=${url}`, models } : null;
    }));
    const payload = { servers: results.filter(Boolean) };
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
      try { url = JSON.parse(fs.readFileSync(PI_SETTINGS_FILE, 'utf8')).llamaServerUrl || null; } catch { /* no file */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url }));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const { url } = JSON.parse(body || '{}');
          if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
            throw new Error('url must be an http(s) base URL');
          }
          const clean = url.trim().replace(/\/+$/, '');
          let settings = {};
          try { settings = JSON.parse(fs.readFileSync(PI_SETTINGS_FILE, 'utf8')); } catch { /* defaults */ }
          const previous = settings.llamaServerUrl || null;
          settings.llamaServerUrl = clean;
          fs.mkdirSync(path.dirname(PI_SETTINGS_FILE), { recursive: true });
          fs.writeFileSync(PI_SETTINGS_FILE, JSON.stringify(settings, null, 2));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, previous, current: clean }));
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
      };
      const st = fs.statSync(file);
      res.writeHead(200, {
        'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'public, max-age=86400',
      });
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

  if (req.url.startsWith('/api/upload')) {
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
        const dir = UPLOAD_DIRS[0];
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const file = path.join(dir, `${stamp}-${safe}`);
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: file, size: fs.statSync(file).size, mimeType: mimeType || null }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Transcribe an audio file (base64 WAV) via the local whisper server.
  if (req.url.startsWith('/api/transcribe')) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    if (!whisperUrl) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no local STT server is running' }));
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ file: PI_AUTH_FILE, providers }));
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
            fs.writeFileSync(PI_AUTH_FILE, JSON.stringify(auth, null, 2));
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
        fs.writeFileSync(PI_AUTH_FILE, JSON.stringify(auth, null, 2));
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
          try {
            writeModelsFile(file);
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `write failed: ${e.message}` }));
            return;
          }
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

const wss = new WebSocketServer({ server });

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
const pendingOwner = new Map(); // rpc request id -> the ws that sent it

function broadcast(obj, except) {
  for (const ws of clients) {
    if (ws !== except) wsSend(ws, obj);
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

function startAgent() {
  if (agent) return agent;

  const child = spawn(PI_COMMAND, {
    shell: true, // pi is an npm .cmd shim on Windows; shell handles both platforms
    cwd: WORKSPACE_DIR,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: !isWin, // POSIX: own process group so killTree can kill the whole tree
  });

  let buf = '';
  child.stdout.on('data', (d) => {
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
      if (parsed && parsed.type === 'response' && parsed.id && pendingOwner.has(parsed.id)) {
        const owner = pendingOwner.get(parsed.id);
        pendingOwner.delete(parsed.id);
        wsSend(owner, { bridge: 'rpc', payload: parsed });
        continue;
      }
      broadcast({ bridge: 'rpc', payload: parsed });
    }
  });

  child.stderr.on('data', (d) => {
    broadcast({ bridge: 'agent_stderr', text: d.toString('utf8') });
  });

  child.on('error', (err) => {
    broadcast({
      bridge: 'agent_exit',
      error: `Failed to start "${PI_COMMAND}": ${err.message}. ` +
             `Is the pi coding agent installed and on PATH? (npm install -g @mariozechner/pi-coding-agent)`,
    });
  });

  child.on('exit', (code, signal) => {
    if (agent === child) agent = null;
    broadcast({ bridge: 'agent_exit', code, signal });
  });

  agent = child;
  broadcast({
    bridge: 'agent_started',
    command: PI_COMMAND,
    workspace: WORKSPACE_DIR,
    sessionDir: SESSION_DIR,
  });
  return child;
}

wss.on('connection', (ws) => {
  clients.add(ws);
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
      // Remember who asked, so the response goes back to them and not to
      // everybody (ids are only unique per client).
      if (msg.id) pendingOwner.set(msg.id, ws);
      agent.stdin.write(JSON.stringify(msg) + '\n');
    } else {
      wsSend(ws, { bridge: 'agent_stderr', text: 'Agent process is not running.' });
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    // Drop any requests this client will never read.
    for (const [id, owner] of pendingOwner) {
      if (owner === ws) pendingOwner.delete(id);
    }
    // Last one out turns off the lights, so an abandoned agent is not left
    // running in the background.
    if (clients.size === 0 && agent) {
      killTree(agent);
      agent = null;
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

server.listen(PORT, () => {
  listening = true;
  console.log(`Pi Agent WebUI`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  agent command : ${PI_COMMAND}`);
  console.log(`  workspace     : ${WORKSPACE_DIR}`);
  console.log(`  session dir   : ${SESSION_DIR}`);
  if (process.env.AUTO_WHISPER !== '0') {
    startWhisper().then((u) => { whisperUrl = u; });
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
