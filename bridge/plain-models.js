/*
 * A model catalogue for plain chats.
 *
 * A plain chat is a separate pi process started without extensions. That keeps
 * tools, skills and extension UI out of it, but it also removes the providers
 * extensions register at startup: llama.cpp and SchizoDev disappeared from the
 * plain model picker even though they were in the normal one.
 *
 * pi reads custom providers from <agent dir>/models.json. For a plain child we
 * therefore build a temporary agent directory containing:
 *   - models.json merged from models.json and the last normal-chat snapshot,
 *     which contains only providers/models the normal agent actually offers;
 *   - the user's auth.json, so the merged providers can actually authenticate;
 *   - a settings.json without packages/extensions, so pi does not install or
 *     load anything the plain process is meant to leave out.
 *
 * The real agent directory is untouched. The temporary one is discarded when
 * the plain child is replaced.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/* pi's provider schema is stricter than the extension catalogue objects. Keep
 * the fields a picker and a request need, and drop the catalogue-only ones
 * (`object`, `owned_by`, per-model `api`, video modalities). */
function modelEntry(m) {
  if (typeof m === 'string') return m.trim() ? { id: m.trim() } : null;
  if (!m || typeof m !== 'object' || !m.id) return null;
  const out = { id: String(m.id) };
  if (m.name) out.name = String(m.name);
  for (const k of ['contextWindow', 'maxTokens']) {
    if (Number.isFinite(Number(m[k])) && Number(m[k]) > 0) out[k] = Number(m[k]);
  }
  if (m.reasoning !== undefined) out.reasoning = !!m.reasoning;
  if (Array.isArray(m.input)) {
    const input = m.input.filter((x) => x === 'text' || x === 'image');
    if (input.length) out.input = input;
  }
  if (m.cost && typeof m.cost === 'object') {
    const cost = {};
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      if (Number.isFinite(Number(m.cost[k]))) cost[k] = Number(m.cost[k]);
    }
    if (Object.keys(cost).length) out.cost = cost;
  }
  return out;
}

/* The normal chat's `get_available_models` answer is the most complete catalogue
 * available: every extension has registered by then. Keep it on disk so a plain
 * child - which starts no extensions - can offer the same models. Only model
 * metadata is stored, never credentials. */
function rememberSnapshot(agentDir, models) {
  if (!agentDir || !Array.isArray(models) || !models.length) return;
  const rows = [];
  for (const m of models.slice(0, 500)) {
    if (!m || typeof m !== 'object' || !m.id || !m.provider) continue;
    rows.push({
      provider: String(m.provider),
      id: String(m.id),
      name: m.name ? String(m.name) : undefined,
      baseUrl: m.baseUrl ? String(m.baseUrl) : undefined,
      api: m.api ? String(m.api) : undefined,
      contextWindow: Number.isFinite(Number(m.contextWindow)) ? Number(m.contextWindow) : undefined,
      maxTokens: Number.isFinite(Number(m.maxTokens)) ? Number(m.maxTokens) : undefined,
      reasoning: m.reasoning === undefined ? undefined : !!m.reasoning,
      input: Array.isArray(m.input) ? m.input.filter((x) => x === 'text' || x === 'image') : undefined,
      cost: m.cost && typeof m.cost === 'object' ? m.cost : undefined,
    });
  }
  try {
    const file = path.join(agentDir, 'webui-model-cache.json');
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), models: rows }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* cache is an optimisation */ }
}

function addSnapshot(providers, agentDir) {
  const cache = readJson(path.join(agentDir, 'webui-model-cache.json'));
  if (!cache || !Array.isArray(cache.models)) return;
  const auth = readJson(path.join(agentDir, 'auth.json')) || {};
  const keyFor = (id) => {
    const a = auth[id];
    return a && typeof a === 'object' ? (a.key || a.access || a.token || null) : null;
  };
  const groups = new Map();
  for (const m of cache.models) {
    if (!m || !m.id || !m.provider) continue;
    let id = String(m.provider);
    let base = m.baseUrl || '';
    if (id === 'llama.cpp') {
      base = String(base).replace(/\/+$/, '').replace(/\/v1$/i, '');
      id = base ? `llama-server=${base}` : 'llama-cpp';
    }
    if (!groups.has(id)) groups.set(id, { base, api: m.api || 'openai-completions', models: [] });
    groups.get(id).models.push(m);
  }
  for (const [id, g] of groups) {
    addProviderModels(providers, id, g.models, g.base, g.api, keyFor(id) || 'pi-webui-local');
    if (id.startsWith('llama-server=') && providers[id]) providers[id].name = 'llama.cpp';
  }
}

function addProviderModels(providers, id, models, baseUrl, api, apiKey) {
  if (!id || !Array.isArray(models) || !models.length) return;
  const existing = providers[id] || {};
  const p = { ...existing };
  if (!p.baseUrl && baseUrl) p.baseUrl = baseUrl;
  if (!p.api && api) p.api = api;
  if (!p.apiKey && apiKey) p.apiKey = apiKey;
  const seen = new Set((p.models || []).map((m) => (typeof m === 'string' ? m : m && m.id)).filter(Boolean));
  const list = Array.isArray(p.models) ? p.models.slice() : [];
  for (const raw of models) {
    const m = modelEntry(raw);
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    list.push(m);
  }
  if (list.length) p.models = list;
  providers[id] = p;
}

/* Build the merged provider map. The caller's actual models.json is never
 * modified; this is data for the temporary file. */
function mergedProviders(agentDir) {
  const dir = agentDir || path.join(os.homedir(), '.pi', 'agent');
  const original = readJson(path.join(dir, 'models.json')) || {};
  const providers = {};
  for (const [id, p] of Object.entries(original.providers || {})) {
    if (!p || typeof p !== 'object') continue;
    providers[id] = { ...p, ...(Array.isArray(p.models) ? { models: p.models.slice() } : {}) };
  }
  // The normal-chat snapshot is the authority on what is actually available:
  // models-store catalogues include entries whose provider is not installed or
  // has no credentials, and those must not appear in a plain chat.
  addSnapshot(providers, dir);

  return providers;
}

function sanitizedSettings(agentDir, providers) {
  const s = readJson(path.join(agentDir || '', 'settings.json')) || {};
  const out = { ...s };
  // These two are what made the temp directory install/load extensions on
  // startup. The plain process must not have either.
  delete out.packages;
  delete out.extensions;
  // A saved default from the extension provider now lives under the safe
  // plain-chat provider id.
  if (out.defaultProvider === 'llama.cpp') {
    const server = Object.keys(providers || {}).find((id) => id.startsWith('llama-server='));
    out.defaultProvider = server || 'llama-cpp';
  }
  return out;
}

let activeDir = null;

/* Create the temporary agent directory for one plain child. Returns its path,
 * or null when the real directory should be used (no config, or a read-only
 * temp). */
function create(agentDir, command) {
  // In container mode PI_CODING_AGENT_DIR is a path inside the container; a
  // host temp directory cannot be mounted into the already-running container.
  if (/docker\s+exec/.test(String(command || ''))) return null;
  const dir = agentDir || path.join(os.homedir(), '.pi', 'agent');
  const providers = mergedProviders(dir);
  if (!Object.keys(providers).length) return null;
  let temp;
  try {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-webui-plain-'));
    fs.chmodSync(temp, 0o700);
    fs.writeFileSync(path.join(temp, 'models.json'), JSON.stringify({ providers }, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(temp, 'settings.json'), JSON.stringify(sanitizedSettings(dir, providers), null, 2), { mode: 0o600 });
    // Auth is shared by symlink so a key update in Settings is picked up by the
    // next plain start without copying credentials around.
    const auth = path.join(dir, 'auth.json');
    try { fs.symlinkSync(auth, path.join(temp, 'auth.json')); }
    catch {
      try { fs.copyFileSync(auth, path.join(temp, 'auth.json')); } catch { /* no auth file */ }
    }
    return temp;
  } catch {
    try { if (temp) fs.rmSync(temp, { recursive: true, force: true }); } catch { /* gone */ }
    return null;
  }
}

function dispose(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
  if (activeDir === dir) activeDir = null;
}

function setActive(dir) {
  if (activeDir && activeDir !== dir) dispose(activeDir);
  activeDir = dir || null;
}

process.on('exit', () => { try { dispose(activeDir); } catch { /* exiting */ } });

module.exports = { create, dispose, setActive, mergedProviders, rememberSnapshot };
