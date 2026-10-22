/*
 * pi's own resources, split out of server.js as bridge/routes/pi.js (issue #54).
 *
 * Extensions, skills, packages, AGENTS.md and providers/models.json/auth.json
 * (issue #46), the goal-x state the goal bar reads (issue #55), and pi's own
 * compaction setting (issue #56). Every route and helper was moved verbatim;
 * the factory receives the names they used from server.js and destructures
 * them back to the same identifiers, so the bodies did not change.
 */
'use strict';

const { readGoalRecord, goalSummary, setGoalTask } = require('../goals');

module.exports = function piRoutes(deps) {
  const {
    ALLOWED_APIS,
    GOALS_DIR,
    MODEL_FIELDS,
    PI_AGENT_DIR,
    PI_MODELS_FILE,
    PI_SETTINGS_FILE,
    PROVIDER_ID_RE,
    WORKSPACE_DIR,
    fs,
    http,
    jsonOut,
    maskKey,
    os,
    path,
    readJsonSafe,
    serveStatic,
    writeJsonAtomic,
    writeModelsFile,
  } = deps;

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

/* Every skill location pi 1.0+ loads. The agent dir's own `skills/` is not the
 * only one: the shared `~/.agents/skills` is read as well (package-manager.js:
 * userAgentsSkillsDir), and a *trusted* project contributes `.pi/skills` and
 * `.agents/skills` from the workspace up to its git root. The bridge used to
 * look only at the agent dir, so on Linux - where skills live in
 * ~/.agents/skills - the Extensions tab showed none at all (issue #64).
 *
 * `rel` for pi's +path/-path overrides is `skills/<name>` for every one of
 * these, because pi resolves a pattern against the base dir above `skills/`.
 * Project roots are listed read-only: toggling one is an entry in that
 * project's own settings, not the agent dir's, and pi only reads them at all
 * when the project is trusted. */
const USER_SKILLS_DIR = path.join(os.homedir(), '.agents', 'skills');
function skillRoots() {
  const roots = [
    { dir: PI_SKILLS_DIR, source: 'local', label: 'agent dir', writable: true, deletable: true },
    { dir: USER_SKILLS_DIR, source: 'agents', label: '~/.agents', writable: true, deletable: false },
  ];
  const seen = new Set([roots[0].dir, roots[1].dir]);
  let dir = path.resolve(WORKSPACE_DIR);
  for (;;) {
    for (const sub of ['.pi', '.agents']) {
      const full = path.join(dir, sub, 'skills');
      if (seen.has(full)) continue;
      seen.add(full);
      roots.push({
        dir: full, source: 'project', label: `${path.basename(dir) || dir} · ${sub}/skills`,
        writable: false, deletable: false, note: 'read-only here (project skills are enabled in the project settings)',
      });
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return roots;
}

/* The root a toggle or delete may act on. Project skills have no entry here on
 * purpose: this bridge writes the agent dir's settings.json, and a project
 * skill's override lives in the project's own file. */
function skillRootFor(source) {
  if (source === 'agents') return USER_SKILLS_DIR;
  if (source === 'local' || source == null) return PI_SKILLS_DIR;
  return null;
}

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
 * lesson from the two injection bugs this file has already had.
 *
 * `source` only ever means a *global* root (agent dir or ~/.agents); anything
 * else - a project skill, a typo - has no path here, which is what keeps the
 * toggle and delete endpoints from reaching outside the two directories the tab
 * is allowed to manage. */
function resourcePath(kind, name, source) {
  const safe = safeResourceName(name);
  if (!safe) return null;
  const root = kind === 'skills' ? skillRootFor(source) : PI_EXT_DIR;
  if (!root) return null;
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
 * a directory holding SKILL.md under a skills root. Anything else is ignored
 * rather than listed as something this tab cannot act on. Packages are entries in
 * settings.json, not files here, so they are listed separately. */
function listLooseResourcesIn(kind, root) {
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

function listLooseResources(kind) {
  return listLooseResourcesIn(kind, kind === 'skills' ? PI_SKILLS_DIR : PI_EXT_DIR);
}

/* Skills from every root pi reads, deduped by which root they came from (the
 * same name can exist in two roots and pi will load both). */
function listSkillResources() {
  const out = [];
  for (const root of skillRoots()) {
    for (const r of listLooseResourcesIn('skills', root.dir)) {
      out.push(Object.assign({}, r, {
        source: root.source, sourceLabel: root.label,
        writable: root.writable, deletable: root.deletable,
        note: root.note,
      }));
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || String(a.source).localeCompare(String(b.source)));
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
  /* Deduped case-insensitively on Windows: AGENTS.md and AGENTS.MD are one file
   * there, and listing the same file twice under two of its own spellings is the
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

  /* The goal pool: `active_goal_*` is the focused one, `goal_*` the rest. */
  function listGoals() {
    const out = { ok: true, present: false, dir: GOALS_DIR, focused: null, goals: [] };
    let names = [];
    try { names = fs.readdirSync(GOALS_DIR); } catch { /* goal-x is not installed here */ }
    for (const [focused, re] of [[true, /^active_goal_.*\.md$/], [false, /^goal_.*\.md$/]]) {
      for (const n of names.filter((x) => re.test(x))) {
        const file = path.join(GOALS_DIR, n);
        const rec = readGoalRecord(file);
        if (!rec) continue;
        out.goals.push(goalSummary(rec, focused, file));
        if (focused && !out.focused) out.focused = rec.id || n;
      }
    }
    out.goals.sort((a, b) => (b.focused ? 1 : 0) - (a.focused ? 1 : 0) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    out.present = out.goals.length > 0;
    return out;
  }

  function match(req) {
    return req.url.startsWith('/api/goals')
      || req.url.startsWith('/api/pi-config')
      || req.url.startsWith('/api/pi-extensions')
      || req.url.startsWith('/api/pi-agents')
      || req.url.startsWith('/api/pi-providers');
  }

  function handle(req, res) {
if (req.url.startsWith('/api/goals')) {
  /* Complete or reopen one task, with goal-x's own gates (issue #81). The page
   * sends /goal-refresh afterwards so the extension reloads what changed here. */
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/goals/task') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1 << 20) req.destroy(); });
    req.on('end', () => {
      let j = null;
      try { j = JSON.parse(body || '{}'); } catch { j = null; }
      if (!j || typeof j !== 'object') { jsonOut(res, 400, { ok: false, error: 'expected a JSON body' }); return; }
      const file = String(j.file == null ? '' : j.file);
      const name = path.basename(file);
      const dir = path.dirname(path.resolve(file));
      if (!/^(active_)?goal_[^/\\]*\.md$/.test(name) || dir !== path.resolve(GOALS_DIR)) {
        jsonOut(res, 400, { ok: false, error: 'not a goal file in this workspace' });
        return;
      }
      const out = setGoalTask(path.join(dir, name), String(j.taskId == null ? '' : j.taskId), String(j.status == null ? '' : j.status), j.evidence);
      if (!out.ok) { jsonOut(res, 400, { ok: false, error: out.error }); return; }
      jsonOut(res, 200, listGoals());
    });
    return;
  }
  jsonOut(res, 200, listGoals());
  return;
}

/* pi's own settings the WebUI can change live over RPC (issue #56):
 * auto-compaction is persisted by pi in settings.json, so the same file the
 * Extensions tab reads tells the checkbox what state it is in. */
if (req.url.startsWith('/api/pi-config')) {
  const settings = readPiSettings();
  jsonOut(res, 200, {
    ok: true,
    file: PI_SETTINGS_FILE,
    compaction: { enabled: !(settings.compaction && settings.compaction.enabled === false) },
  });
  return;
}

if (req.url.startsWith('/api/pi-extensions')) {
  const only = req.url.split('?')[0];
  if (req.method === 'GET' && only === '/api/pi-extensions') {
    const settings = readPiSettings();
    const extPatterns = settings[RESOURCE_ARRAYS.extensions] || [];
    const skillPatterns = settings[RESOURCE_ARRAYS.skills] || [];
    const extensions = listLooseResources('extensions')
      .map((r) => Object.assign({}, r, { enabled: resourceEnabled(extPatterns, r.rel, r.name), source: 'local', sourceLabel: 'agent dir', writable: true, deletable: true }));
    const skills = listSkillResources()
      .map((r) => Object.assign({}, r, {
        // A project's override lives in the project's settings; the state shown
        // here would be a guess, so those rows are marked read-only instead.
        enabled: r.writable ? resourceEnabled(skillPatterns, r.rel, r.name) : true,
      }));
    /* Where the tab looked, with the count each root contributed. A list that
     * comes up short is then a fact the tab states - which roots it read and how
     * many skills each held - rather than a dead end (issue #90). */
    const skillRootsInfo = skillRoots().map((r) => ({
      dir: r.dir, source: r.source, label: r.label, writable: r.writable,
      count: listLooseResourcesIn('skills', r.dir).length,
    }));
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
      skillRoots: skillRootsInfo,
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
      const source = j.source === 'agents' ? 'agents' : 'local';
      const full = name ? resourcePath(kind, name, source) : null;
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
      // Only the agent dir's own skills can be removed here. ~/.agents is
      // shared with other tools (the pi CLI reads it too), and a project skill
      // is the project's file - neither is this tab's to delete.
      const source = j.source === 'agents' ? 'agents' : 'local';
      if (kind === 'skills' && source !== 'local') {
        return jsonOut(res, 400, { error: 'only a skill in the agent dir can be removed from here' });
      }
      const full = name ? resourcePath(kind, name, source) : null;
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
  }

  return { match, handle };
};
