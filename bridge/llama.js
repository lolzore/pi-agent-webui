/*
 * The pi-provider / llama.cpp block: the model and auth helpers pi's own
 * settings and auth files need, and the llama.cpp probe - URL candidates,
 * fetchLlamaModels, the LAN sweep and the models cache. Split out of
 * server.js (issue #54, phase 11); the llama code the phase is named for is
 * the probe/candidate/cache half of this file.
 */
'use strict';

module.exports = function llamaSupport(deps) {
  const {
    PI_AGENT_DIR,
    PI_AUTH_FILE,
    PI_MODELS_FILE,
    PI_SETTINGS_FILE,
    WORKSPACE_DIR,
    fs,
    os,
    path,
    readJsonSafe,
  } = deps;

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

/* Other pi bridges on this machine, for the instance switcher (issue #57). The
 * default port and its neighbours are enough to find the usual "second agent on
 * this PC" setups (PORT=3081 ./start-webui.sh), and the probe is cheap: each
 * port gets one /api/health with a short timeout. */
/* The ports a second instance could be on. The launcher puts instance N on
 * base+N, so the scan follows the same base (PI_WEBUI_PORT_BASE, 3080 by
 * default) - a test, or anyone running their instances elsewhere, still gets
 * discovery (issue #79). */

  return {
    ALLOWED_APIS,
    AUTH_KEY_FIELDS,
    AUTH_OAUTH_FIELDS,
    BUILTIN_PROVIDER_IDS,
    LLAMA_LAN_PORTS,
    LLAMA_LAN_TTL,
    LOCAL_LLAMA_PORTS,
    MODEL_FIELDS,
    PROVIDER_ID_RE,
    VIRTUAL_IFACE,
    authEntryKind,
    fetchLlamaModels,
    isLocalLlamaAddress,
    llamaConfiguredUrls,
    llamaLan,
    llamaLanEnabled,
    llamaLanUrls,
    llamaModelsCache,
    llamaServerCandidates,
    llamaServerIdentity,
    llamaSweepLan,
    localIPv4s,
    maskKey,
    readLlamaServerUrl,
    subnetHosts,
    writeJsonAtomic,
    writeModelsFile,
  };
};
