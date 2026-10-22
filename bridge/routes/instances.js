/*
 * Starting and stopping a second agent on this machine, split out of server.js
 * as bridge/routes/instances.js (issue #79).
 *
 * The launcher (`INSTANCE=N ./start-webui.sh`) gives a second agent its own home
 * and its own port; the switcher already *finds* one (#57). What was missing was
 * a way to start one without a terminal. This route spawns that same launcher
 * detached, records what it started in the agent dir, and can stop only those:
 * a bridge the UI did not start is not this route's to kill.
 *
 * `GET /api/local-started` is what the menu uses to draw the stop control and to
 * say which discovered bridges came from here.
 */
'use strict';

const { spawn } = require('child_process');
const net = require('net');
const http = require('http');

module.exports = function instanceRoutes(deps) {
  const {
    fs,
    path,
    os,
    jsonOut,
    PI_AGENT_DIR,
  } = deps;

  const ROOT = path.join(__dirname, '..', '..');
  const STARTED_FILE = path.join(PI_AGENT_DIR, 'webui-started-instances.json');
  const INSTANCE_ROOT = path.join(os.homedir(), '.pi', 'webui-instances');
  const PORT_BASE = Number(process.env.PI_WEBUI_PORT_BASE || 3080);

  function readStarted() {
    try {
      const j = JSON.parse(fs.readFileSync(STARTED_FILE, 'utf8'));
      return Array.isArray(j) ? j.filter((r) => r && r.pid && r.port) : [];
    } catch { return []; }
  }
  function writeStarted(list) {
    try {
      fs.mkdirSync(path.dirname(STARTED_FILE), { recursive: true });
      fs.writeFileSync(STARTED_FILE, JSON.stringify(list, null, 2));
    } catch { /* bookkeeping is a nicety; the process is already running */ }
  }
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  function list() {
    /* A stopped record keeps `running: false` so it stays in the menu with a
     * start control (issue #119); a running one is decided by its pid, because
     * a record written by an older bridge has no flag. */
    return { ok: true, started: readStarted().map((r) => Object.assign({}, r, { running: r.running !== false && alive(r.pid) })) };
  }

  /* The smallest number no *running* instance holds. Instance directories stay
   * behind after a stop, so max+1 only ever grew (issue #119): a stopped 2 is
   * reused instead of moving on to 3. */
  function nextInstance() {
    const running = new Set(readStarted().filter((r) => r.running !== false && alive(r.pid)).map((r) => Number(r.instance) || 0));
    let n = 2;
    while (running.has(n)) n += 1;
    return n;
  }

  const inUse = (port) => new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    const done = (v) => { try { s.destroy(); } catch { /* gone */ } resolve(v); };
    s.setTimeout(400);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });

  /* Two starts in quick succession used to see the same free number and the
   * same free port and then race each other for them (issue #119's hardening
   * pass): starts are serialized through this queue. */
  let startQueue = Promise.resolve();
  function start(wanted) {
    const run = startQueue.then(() => startNow(wanted));
    startQueue = run.catch(() => {});
    return run;
  }

  async function startNow(wanted) {
    /* A restart names its instance; a plain start takes the smallest free one. */
    const asked = Number(wanted);
    let instance = Number.isFinite(asked) && asked >= 2 ? asked : nextInstance();
    let port = PORT_BASE + instance;
    for (let i = 0; i < 20 && await inUse(port); i++) { instance += 1; port = PORT_BASE + instance; }
    const sh = path.join(ROOT, 'start-webui.sh');
    const bat = path.join(ROOT, 'start-webui.bat');
    if (!fs.existsSync(sh) && !fs.existsSync(bat)) return { code: 500, error: 'no start-webui launcher next to the bridge' };
    fs.mkdirSync(INSTANCE_ROOT, { recursive: true });
    const log = path.join(INSTANCE_ROOT, `${instance}.log`);
    let fd = null;
    try { fd = fs.openSync(log, 'a'); } catch { /* start anyway, without the log */ }
    const env = Object.assign({}, process.env, { INSTANCE: String(instance), PI_WEBUI_PORT: String(port) });
    let child;
    try {
      if (process.platform === 'win32' && fs.existsSync(bat)) {
        child = spawn('cmd', ['/c', bat, 'native'], { env, cwd: ROOT, detached: true, stdio: ['ignore', fd == null ? 'ignore' : fd, fd == null ? 'ignore' : fd] });
      } else {
        child = spawn('/bin/bash', [sh, 'native'], { env, cwd: ROOT, detached: true, stdio: ['ignore', fd == null ? 'ignore' : fd, fd == null ? 'ignore' : fd] });
      }
    } catch (e) {
      if (fd != null) { try { fs.closeSync(fd); } catch { /* gone */ } }
      return { code: 500, error: 'could not run the launcher: ' + e.message };
    }
    child.unref();
    if (fd != null) { try { fs.closeSync(fd); } catch { /* gone */ } }
    const started = readStarted();
    const rec = { instance, port, pid: child.pid, startedAt: new Date().toISOString(), log, url: `http://127.0.0.1:${port}` };
    writeStarted(started.filter((r) => Number(r.instance) !== instance).concat(rec));
    return { ok: true, instance, port, pid: child.pid, url: rec.url, log };
  }

  /* Is the bridge on that port answering? A record whose pid was reused by an
   * unrelated process must not be killed, and a bridge that died on its own
   * leaves a record behind that stop() should only mark as stopped. */
  const answers = (port) => new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 800 }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(!!JSON.parse(b).ok); } catch { resolve(false); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });

  async function stop(port) {
    const wanted = Number(port);
    if (!Number.isFinite(wanted)) return { code: 400, error: 'a port is required' };
    const started = readStarted();
    const rec = started.find((r) => Number(r.port) === wanted);
    if (!rec) return { code: 400, error: 'this bridge did not start that instance' };
    const up = await answers(wanted);
    let killed = false;
    if (up) {
      // The launcher runs the bridge in its own process group and traps TERM
      // with `kill 0`, so the group signal takes the agent process with it.
      try { process.kill(-rec.pid, 'SIGTERM'); killed = true; } catch { /* no group */ }
      if (!killed) { try { process.kill(rec.pid, 'SIGTERM'); } catch { /* already gone */ } }
    }
    /* The record stays (running: false) so the menu can offer to start it
     * again with the same home and port (issue #119). */
    writeStarted(started.map((r) => (r === rec ? Object.assign({}, rec, { running: false, stoppedAt: new Date().toISOString() }) : r)));
    return { ok: true, port: wanted, pid: rec.pid, killed };
  }

  /* Forget a stopped instance's record. Its home (sessions, auth, settings) is
   * only removed when deleteHome is asked for explicitly (issue #119 hardening). */
  function forget(instance, deleteHome) {
    const wanted = Number(instance);
    if (!Number.isFinite(wanted)) return { code: 400, error: 'an instance number is required' };
    const started = readStarted();
    const rec = started.find((r) => Number(r.instance) === wanted);
    if (!rec) return { code: 404, error: `no instance ${wanted} was started from here` };
    if (rec.running !== false && alive(rec.pid)) return { code: 400, error: 'stop it first' };
    writeStarted(started.filter((r) => r !== rec));
    let home = null;
    if (deleteHome) {
      home = path.join(INSTANCE_ROOT, String(wanted));
      try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* gone */ }
    }
    return { ok: true, instance: wanted, home };
  }

  function match(req) {
    return req.url.startsWith('/api/local-started')
      || req.url.startsWith('/api/start-instance')
      || req.url.startsWith('/api/stop-instance')
      || req.url.startsWith('/api/forget-instance');
  }

  async function handle(req, res) {
    const only = req.url.split('?')[0];
    if (only === '/api/local-started' && req.method === 'GET') { jsonOut(res, 200, list()); return; }
    if (only === '/api/start-instance' && req.method === 'POST') {
      /* An optional {instance} restarts that one (its home and port); no body
       * means "the next free instance" (issue #119). */
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1 << 16) req.destroy(); });
      req.on('end', async () => {
        let j = null;
        try { j = JSON.parse(body || '{}'); } catch { j = null; }
        const out = await start(j && j.instance);
        if (out.error) { jsonOut(res, out.code || 500, { ok: false, error: out.error }); return; }
        jsonOut(res, 200, out);
      });
      return;
    }
    if (only === '/api/forget-instance' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1 << 16) req.destroy(); });
      req.on('end', () => {
        let j = null;
        try { j = JSON.parse(body || '{}'); } catch { j = null; }
        if (!j || typeof j !== 'object') { jsonOut(res, 400, { ok: false, error: 'expected a JSON body' }); return; }
        const out = forget(j.instance, j.deleteHome === true);
        if (out.error) { jsonOut(res, out.code || 400, { ok: false, error: out.error }); return; }
        jsonOut(res, 200, out);
      });
      return;
    }
    if (only === '/api/stop-instance' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1 << 16) req.destroy(); });
      req.on('end', async () => {
        let j = null;
        try { j = JSON.parse(body || '{}'); } catch { j = null; }
        if (!j || typeof j !== 'object') { jsonOut(res, 400, { ok: false, error: 'expected a JSON body' }); return; }
        const out = await stop(j.port);
        if (out.error) { jsonOut(res, out.code || 400, { ok: false, error: out.error }); return; }
        jsonOut(res, 200, out);
      });
      return;
    }
    jsonOut(res, 404, { ok: false, error: 'not found' });
  }

  return { match, handle };
};
