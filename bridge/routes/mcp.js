/*
 * MCP servers from Settings, split out of server.js as bridge/routes/mcp.js
 * (issue #92).
 *
 * pi reads user servers from <agent dir>/mcp.json and project servers from
 * <workspace>/.pi/mcp.json (project files only in a trusted project), in the
 * `mcpServers` shape shared by other MCP clients. This route lists both and
 * writes only the user file - atomically, and without dropping keys it does not
 * own. Project entries are read-only here for the same reason AGENTS.md is: the
 * file can sit at an arbitrary ancestor path, and pi has its own project
 * override rules (`enabled`/`exposure`/`toolExposure`) for them.
 *
 * pi's own rules are enforced rather than re-invented: names are letters,
 * digits, `_` and `-` (and a name that differs from another only in `-` vs `_`
 * is the same server), an entry needs `command` (stdio) or `url` (http), and a
 * project entry may be a bare override of a user entry.
 */
'use strict';

module.exports = function mcpRoutes(deps) {
  const {
    fs,
    path,
    jsonOut,
    readJsonSafe,
    writeJsonAtomic,
    PI_AGENT_DIR,
    WORKSPACE_DIR,
  } = deps;

  const USER_FILE = path.join(PI_AGENT_DIR, 'mcp.json');
  const PROJECT_FILE = path.join(WORKSPACE_DIR, '.pi', 'mcp.json');
  const NAME_RE = /^[A-Za-z0-9_-]+$/;
  const OVERRIDE_KEYS = ['enabled', 'exposure', 'toolExposure'];
  const sameServer = (a, b) => a.replace(/_/g, '-') === b.replace(/_/g, '-');

  /* One file, its servers and what pi would complain about. A missing file is
   * not an error - it is the normal state before the first server is added. */
  function readServers(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
      return { missing: e.code === 'ENOENT', servers: {}, errors: [] };
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { return { servers: {}, errors: [`${file}: ${e.message}`] }; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { servers: {}, errors: [`${file}: expected a JSON object`] };
    }
    if (parsed.mcpServers !== undefined && (!parsed.mcpServers || typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers))) {
      return { servers: {}, errors: [`${file}: expected an "mcpServers" object`] };
    }
    const servers = parsed.mcpServers || {};
    const errors = [];
    for (const [name, v] of Object.entries(servers)) {
      if (!NAME_RE.test(name)) errors.push(`"${name}": names may hold only letters, digits, "_" and "-"`);
      else if (!v || typeof v !== 'object' || Array.isArray(v)) errors.push(`"${name}": expected an object`);
      else if (!v.command && !v.url && !isOverride(v)) errors.push(`"${name}": needs "command" or "url", or a user server to override`);
    }
    return { servers, errors };
  }

  const isOverride = (v) => !v.command && !v.url && !v.type
    && Object.keys(v).length > 0 && Object.keys(v).every((k) => OVERRIDE_KEYS.includes(k));

  function row(name, v, source, note) {
    const transport = v.command ? 'stdio' : v.url ? 'http' : 'override';
    return {
      name,
      source,
      sourceLabel: source === 'project' ? '.pi/mcp.json' : 'mcp.json',
      transport,
      command: v.command || null,
      args: Array.isArray(v.args) ? v.args : [],
      url: v.url || null,
      description: v.description || null,
      cwd: v.cwd || null,
      envKeys: v.env && typeof v.env === 'object' ? Object.keys(v.env) : [],
      headerKeys: v.headers && typeof v.headers === 'object' ? Object.keys(v.headers) : [],
      /* The values too (issue #92): the edit dialog prefills from them, and
       * saving without them would silently drop an env var. This is the same
       * file pi reads on this machine, served on this machine. */
      env: v.env && typeof v.env === 'object' ? v.env : null,
      headers: v.headers && typeof v.headers === 'object' ? v.headers : null,
      timeout: typeof v.timeout === 'number' ? v.timeout : null,
      enabled: v.enabled !== false,
      exposure: v.exposure || null,
      override: transport === 'override',
      writable: source === 'user',
      note: note || null,
    };
  }

  function list() {
    const user = readServers(USER_FILE);
    const project = readServers(PROJECT_FILE);
    const rows = [];
    for (const [name, v] of Object.entries(user.servers)) rows.push(row(name, v, 'user'));
    for (const [name, v] of Object.entries(project.servers)) {
      const over = user.servers[name] ? 'overrides the user entry' : (isOverride(v) ? 'overrides a user entry' : null);
      rows.push(row(name, v, 'project', over));
    }
    rows.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
    return {
      ok: true,
      file: USER_FILE,
      projectFile: PROJECT_FILE,
      projectExists: !project.missing,
      servers: rows,
      errors: user.errors.concat(project.errors),
    };
  }

  /* Validate one entry the way pi reads it, and keep only the keys pi knows.
   * Anything else in the body is dropped rather than written to pi's file. */
  function cleanEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('the server must be an object');
    const out = {};
    for (const k of ['command', 'url', 'cwd', 'description']) {
      if (entry[k] === undefined) continue;
      if (typeof entry[k] !== 'string' || !entry[k].trim()) throw new Error(`"${k}" must be a non-empty string`);
      out[k] = entry[k].trim();
    }
    if (!out.command && !out.url) throw new Error('a server needs a "command" (stdio) or a "url" (http)');
    if (out.command && out.url) throw new Error('a server takes either "command" or "url", not both');
    if (entry.args !== undefined) {
      if (!Array.isArray(entry.args) || entry.args.some((a) => typeof a !== 'string')) throw new Error('"args" must be a list of strings');
      out.args = entry.args.slice();
    }
    for (const k of ['env', 'headers']) {
      if (entry[k] === undefined) continue;
      if (!entry[k] || typeof entry[k] !== 'object' || Array.isArray(entry[k])) throw new Error(`"${k}" must be an object`);
      for (const [kk, vv] of Object.entries(entry[k])) {
        if (typeof vv !== 'string') throw new Error(`"${k}.${kk}" must be a string`);
      }
      out[k] = entry[k];
    }
    if (entry.timeout !== undefined) {
      const n = Number(entry.timeout);
      if (!Number.isFinite(n) || n <= 0) throw new Error('"timeout" must be a positive number of seconds');
      out.timeout = n;
    }
    if (entry.enabled !== undefined) {
      if (typeof entry.enabled !== 'boolean') throw new Error('"enabled" must be true or false');
      out.enabled = entry.enabled;
    }
    for (const k of ['exposure', 'toolExposure']) {
      if (entry[k] === undefined) continue;
      if (typeof entry[k] !== 'string') throw new Error(`"${k}" must be a string`);
      out[k] = entry[k];
    }
    return out;
  }

  /* The user file with its unrelated keys intact. Refuses to write over a file
   * that does not parse: it is hand-edited sometimes, and silently replacing it
   * would drop whatever pi was configured with. */
  function userConfigForWrite() {
    let text = null;
    try { text = fs.readFileSync(USER_FILE, 'utf8'); } catch { /* first write */ }
    let parsed = {};
    if (text !== null) {
      try { parsed = JSON.parse(text); } catch (e) { return { error: `${USER_FILE} is not valid JSON (${e.message}) - fix it by hand first` }; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: `${USER_FILE} is not a JSON object` };
      if (parsed.mcpServers !== undefined && (!parsed.mcpServers || typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers))) {
        return { error: `${USER_FILE} has a non-object "mcpServers"` };
      }
    }
    if (!parsed.mcpServers) parsed.mcpServers = {};
    return { parsed };
  }

  function save(name, entry) {
    if (!NAME_RE.test(name)) return { code: 400, error: 'a server name holds only letters, digits, "_" and "-"' };
    let clean;
    try { clean = cleanEntry(entry); } catch (e) { return { code: 400, error: e.message }; }
    const got = userConfigForWrite();
    if (got.error) return { code: 400, error: got.error };
    const servers = got.parsed.mcpServers;
    const clash = Object.keys(servers).find((n) => n !== name && sameServer(n, name));
    if (clash) return { code: 400, error: `"${clash}" is the same server name to pi - it treats "-" and "_" alike` };
    servers[name] = clean;
    try { writeJsonAtomic(USER_FILE, got.parsed); } catch (e) { return { code: 500, error: 'could not write ' + USER_FILE + ': ' + e.message }; }
    return { ok: true };
  }

  function remove(name) {
    const got = userConfigForWrite();
    if (got.error) return { code: 400, error: got.error };
    const servers = got.parsed.mcpServers;
    if (!servers[name]) {
      const project = readServers(PROJECT_FILE);
      if (project.servers[name]) return { code: 400, error: 'this server comes from the project\'s .pi/mcp.json - edit that file to change it' };
      return { code: 404, error: `no server named "${name}" in ${USER_FILE}` };
    }
    delete servers[name];
    try { writeJsonAtomic(USER_FILE, got.parsed); } catch (e) { return { code: 500, error: 'could not write ' + USER_FILE + ': ' + e.message }; }
    return { ok: true };
  }

  function toggle(name, enabled) {
    if (typeof enabled !== 'boolean') return { code: 400, error: '"enabled" must be true or false' };
    const got = userConfigForWrite();
    if (got.error) return { code: 400, error: got.error };
    const servers = got.parsed.mcpServers;
    const entry = servers[name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      const project = readServers(PROJECT_FILE);
      if (project.servers[name]) return { code: 400, error: 'this server comes from the project\'s .pi/mcp.json - edit that file to change it' };
      return { code: 404, error: `no server named "${name}" in ${USER_FILE}` };
    }
    // pi deletes a default-valued `enabled` rather than keeping `enabled: true`.
    if (enabled) delete entry.enabled;
    else entry.enabled = false;
    try { writeJsonAtomic(USER_FILE, got.parsed); } catch (e) { return { code: 500, error: 'could not write ' + USER_FILE + ': ' + e.message }; }
    return { ok: true };
  }

  function match(req) {
    return req.url.startsWith('/api/mcp');
  }

  function handle(req, res) {
    const only = req.url.split('?')[0];
    if (req.method === 'GET' && only === '/api/mcp') {
      jsonOut(res, 200, list());
      return;
    }
    if (req.method === 'POST' && (only === '/api/mcp/save' || only === '/api/mcp/delete' || only === '/api/mcp/toggle')) {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1 << 20) req.destroy(); });
      req.on('end', () => {
        let j = null;
        try { j = JSON.parse(body || '{}'); } catch { j = null; }
        if (!j || typeof j !== 'object') { jsonOut(res, 400, { ok: false, error: 'expected a JSON body' }); return; }
        const out = only === '/api/mcp/save' ? save(String(j.name == null ? '' : j.name).trim(), j.entry)
          : only === '/api/mcp/delete' ? remove(String(j.name == null ? '' : j.name).trim())
            : toggle(String(j.name == null ? '' : j.name).trim(), j.enabled);
        if (out.error) { jsonOut(res, out.code || 400, { ok: false, error: out.error }); return; }
        jsonOut(res, 200, Object.assign({ ok: true }, list()));
      });
      return;
    }
    jsonOut(res, 404, { ok: false, error: 'not found' });
  }

  return { match, handle };
};
