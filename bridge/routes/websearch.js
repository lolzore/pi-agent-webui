/*
 * First-run web search: a local SearXNG the agent can use, and Camoufox for the
 * pages it reads (issue #218).
 *
 * The wizard installed pi-searxng and then left the user with "now set its URL
 * in Settings and get an instance running" - which is not search working, it is
 * a checklist. This route does the part the WebUI can do: find an instance that
 * is already answering, or start one from the official image with JSON enabled
 * (SearXNG refuses `format=json` unless it is in `search.formats`, which is the
 * exact reason a hand-started container looked broken) or, on a host without
 * Docker, install the same server into a private Python venv, write
 * ~/.pi/searxng.json the way pi-searxng reads it, and prove the endpoint answers
 * with a real query.
 *
 * Camoufox is a download (a patched Firefox), so it runs as a background job and
 * the page polls its status; nothing here blocks on it, and a missing uv/pip is
 * reported instead of guessed at.
 *
 * Everything external is overridable for tests: PI_DOCKER, PI_SEARXNG_IMAGE,
 * PI_SEARXNG_CONTAINER, PI_SEARXNG_PORT, PI_SEARXNG_URL, PI_SEARXNG_CONFIG,
 * PI_SEARXNG_NATIVE_DIR, PI_SEARXNG_SOURCE, PI_GIT, PI_UV, PI_CAMOUFOX_CMD.
 */
'use strict';

const SEARXNG_PROBE = '/search?q=pi&format=json';
const { spawn } = require('child_process');
const net = require('net');

module.exports = function websearchRoutes(deps) {
  const {
    fs,
    os,
    path,
    http,
    jsonOut,
    writeJsonAtomic,
    execFile,
    PI_AGENT_DIR,
  } = deps;

  // pi-searxng reads ~/.pi/searxng.json; PI_SEARXNG_CONFIG only exists so a test
  // (or a scratch instance) can point somewhere else without touching it.
  const SEARXNG_CONFIG = process.env.PI_SEARXNG_CONFIG || path.join(os.homedir(), '.pi', 'searxng.json');
  const DOCKER = process.env.PI_DOCKER || 'docker';
  const IMAGE = process.env.PI_SEARXNG_IMAGE || 'searxng/searxng';
  const CONTAINER = process.env.PI_SEARXNG_CONTAINER || 'pi-searxng';
  const PORT = String(process.env.PI_SEARXNG_PORT || '8080');
  const CONFIG_DIR = path.join(PI_AGENT_DIR, 'searxng');
  const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.yml');
  // A Docker-less fallback: SearXNG is a Python app, so a private venv can run
  // the same server the official image runs. The venv/source stay under pi's
  // agent dir and are reused on the next start.
  const NATIVE_DIR = process.env.PI_SEARXNG_NATIVE_DIR || path.join(CONFIG_DIR, 'native');
  const NATIVE_SRC = path.join(NATIVE_DIR, 'searxng');
  const NATIVE_VENV = path.join(NATIVE_DIR, 'venv');
  const NATIVE_SOURCE_URL = process.env.PI_SEARXNG_SOURCE || 'https://github.com/searxng/searxng.git';
  const GIT = process.env.PI_GIT || 'git';
  const UV = process.env.PI_UV || 'uv';
  const nativeState = { child: null, url: '', log: [], installing: false };

  /* ── staging: where the tray button lives ─────────────────────────────────
   * Keep the wizard's real address out of the tests' generic reads: the file is
   * the same one pi-searxng reads, so a test can assert it byte-for-byte. */

  function readSearxngConfig() {
    try {
      const j = JSON.parse(fs.readFileSync(SEARXNG_CONFIG, 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch { return {}; }
  }

  function savedUrl() {
    const c = readSearxngConfig();
    return typeof c.searxngUrl === 'string' ? c.searxngUrl : '';
  }

  function writeSearxngConfig(url) {
    const cfg = {
      searxngUrl: String(url).replace(/\/$/, ''),
      timeoutMs: 30000,
      maxResults: 10,
    };
    writeJsonAtomic(SEARXNG_CONFIG, cfg);
    return cfg;
  }

  function run(cmd, args, timeoutMs = 120000) {
    return new Promise((resolve) => {
      try {
        execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
          resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || '') + (err && !stderr ? ' ' + err.message : '') });
        });
      } catch (e) {
        resolve({ ok: false, out: '', err: e.message });
      }
    });
  }

  /* Does this URL answer as a SearXNG with JSON output? That is the only shape
   * pi-searxng can use, so it is the only thing worth treating as "working". */
  async function probe(url) {
    try {
      const r = await fetch(`${url}${SEARXNG_PROBE}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const d = await r.json();
      if (!Array.isArray(d.results)) return { ok: false, error: 'not a SearXNG JSON answer' };
      return { ok: true, results: d.results.length };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  function candidateUrls() {
    const list = [];
    const saved = savedUrl();
    if (saved) list.push(saved);
    const env = process.env.PI_SEARXNG_URL;
    if (env) list.push(env);
    for (const p of [PORT, '8081', '8888', '8088']) list.push(`http://127.0.0.1:${p}`);
    return [...new Set(list.map((u) => u.replace(/\/$/, '')))];
  }

  async function detect() {
    const tried = [];
    for (const url of candidateUrls()) {
      const test = await probe(url);
      tried.push({ url, ...test });
      if (test.ok) {
        writeSearxngConfig(url);
        return { ok: true, url, test, tried };
      }
    }
    return { ok: false, error: 'no SearXNG answered', tried };
  }

  /* The official image ships a settings.yml without `json` in search.formats,
   * so a plain `docker run` answers 403 to the one request pi makes. Mount ours
   * with JSON on and a generated secret (the image warns without one). */
  function writeSettingsFile(port = PORT, bindAddress = '0.0.0.0', contactPort = port) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    let secret = '';
    try { secret = fs.readFileSync(path.join(CONFIG_DIR, 'secret'), 'utf8').trim(); } catch { /* first run */ }
    if (secret.length < 32) {
      secret = require('crypto').randomBytes(32).toString('hex');
      fs.writeFileSync(path.join(CONFIG_DIR, 'secret'), secret, { mode: 0o600 });
    }
    const yml = [
      'use_default_settings: true',
      'general:',
      `  contact_url: "http://127.0.0.1:${contactPort}/"`,
      'server:',
      `  secret_key: "${secret}"`,
      '  limiter: false',
      '  image_proxy: false',
      `  bind_address: "${bindAddress}"`,
      `  port: ${Number(port) || 8080}`,
      'search:',
      '  formats:',
      '    - html',
      '    - json',
      '',
    ].join('\n');
    fs.writeFileSync(SETTINGS_FILE, yml, { mode: 0o600 });
    try { fs.chmodSync(SETTINGS_FILE, 0o600); } catch { /* Windows */ }
    return SETTINGS_FILE;
  }

  async function dockerAvailable() {
    const r = await run(DOCKER, ['info', '--format', '{{.ServerVersion}}'], 20000);
    return { ok: r.ok, version: r.ok ? r.out.trim() : '', error: r.ok ? '' : r.err.trim().slice(0, 300) };
  }

  async function containerState() {
    const r = await run(DOCKER, ['inspect', '-f', '{{.State.Status}}', CONTAINER], 20000);
    return r.ok ? r.out.trim() : '';
  }

  async function ensureContainer() {
    const docker = await dockerAvailable();
    if (!docker.ok) return { ok: false, error: `Docker is not answering: ${docker.error}`, docker };
    // The server listens on 8080 *inside* the container; PORT is the published
    // host port and must not become server.port, or the mapping points at a
    // port nothing listens on.
    writeSettingsFile(8080, '0.0.0.0', PORT);
    const state = await containerState();
    const mount = `${SETTINGS_FILE}:/etc/searxng/settings.yml:ro`;
    if (state) {
      if (state !== 'running') {
        const started = await run(DOCKER, ['start', CONTAINER], 60000);
        if (!started.ok) return { ok: false, error: `docker start ${CONTAINER}: ${started.err.trim()}`, docker };
      }
    } else {
      const created = await run(DOCKER, [
        'run', '-d', '--name', CONTAINER, '--restart', 'unless-stopped',
        '-p', `${PORT}:8080`, '-v', mount, IMAGE,
      ], 300000);
      if (!created.ok) return { ok: false, error: `docker run ${IMAGE}: ${created.err.trim()}`, docker };
    }
    return { ok: true, docker, container: CONTAINER, port: PORT };
  }

  /* ── Docker-less SearXNG ────────────────────────────────────────────────
   * SearXNG is a Python/Flask app. Installing it into a private venv is the
   * same software the container runs, without requiring Docker on the host.
   * This is deliberately a fallback: if a container or an existing instance
   * answers, use it and never touch the network. The first native install does
   * clone the source and download Python packages, so it can take a few
   * minutes; subsequent starts reuse the venv. */
  function nativeBin(name) {
    const dir = path.join(NATIVE_VENV, process.platform === 'win32' ? 'Scripts' : 'bin');
    return path.join(dir, process.platform === 'win32' ? `${name}.exe` : name);
  }

  function nativeInstalled() {
    return fs.existsSync(nativeBin('searxng-run')) && fs.existsSync(nativeBin('python'));
  }

  function nativeLog(s) {
    nativeState.log.push(String(s).slice(0, 300));
    if (nativeState.log.length > 40) nativeState.log.shift();
  }

  function localHost(name) {
    return name === '127.0.0.1' || name === 'localhost' || name === '::1';
  }

  function savedLocalPort() {
    try {
      const u = new URL(savedUrl());
      if (localHost(u.hostname) && u.port) return Number(u.port);
    } catch { /* no saved URL */ }
    return 0;
  }

  function portFree(port) {
    return new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.once('listening', () => s.close(() => resolve(true)));
      s.listen(port, '127.0.0.1');
    });
  }

  async function nativePort() {
    const preferred = savedLocalPort() || Number(PORT) || 8080;
    const candidates = [...new Set([preferred, 8080, 8081, 8888, 8088, 8090, 8091, 8092])];
    for (const p of candidates) {
      if (p > 0 && await portFree(p)) return p;
    }
    return 0;
  }

  async function installNativeSearxng() {
    if (nativeState.installing) return { ok: false, error: 'a SearXNG install is already running' };
    nativeState.installing = true;
    try {
      fs.mkdirSync(NATIVE_DIR, { recursive: true });
      nativeLog(`installing SearXNG into ${NATIVE_DIR}`);
      if (!fs.existsSync(path.join(NATIVE_SRC, 'searx', 'webapp.py'))) {
        // A half-finished clone must not make every retry fail with
        // "destination path already exists".
        if (fs.existsSync(NATIVE_SRC)) fs.rmSync(NATIVE_SRC, { recursive: true, force: true });
        nativeLog('cloning the SearXNG source');
        const cloned = await run(GIT, ['clone', '--depth', '1', NATIVE_SOURCE_URL, NATIVE_SRC], 300000);
        if (!cloned.ok) return { ok: false, error: `git clone failed: ${cloned.err.trim().slice(0, 300)}` };
      }
      const requirements = path.join(NATIVE_SRC, 'requirements.txt');
      if (!fs.existsSync(requirements)) return { ok: false, error: `SearXNG source has no requirements.txt at ${NATIVE_SRC}` };

      const uv = await run(UV, ['--version'], 15000);
      let python = nativeBin('python');
      if (uv.ok) {
        if (!fs.existsSync(nativeBin('python'))) {
          nativeLog('creating the Python environment with uv');
          const venv = await run(UV, ['venv', NATIVE_VENV], 180000);
          if (!venv.ok) return { ok: false, error: `uv venv failed: ${venv.err.trim().slice(0, 300)}` };
        }
        nativeLog('installing SearXNG dependencies (uv)');
        const deps = await run(UV, ['pip', 'install', '--python', python, '-r', requirements], 900000);
        if (!deps.ok) return { ok: false, error: `SearXNG dependencies failed: ${deps.err.trim().slice(0, 300)}` };
        const setup = await run(UV, ['pip', 'install', '--python', python, 'setuptools', 'wheel'], 180000);
        if (!setup.ok) return { ok: false, error: `setuptools/wheel failed: ${setup.err.trim().slice(0, 300)}` };
        nativeLog('installing the SearXNG package');
        const pkg = await run(UV, ['pip', 'install', '--python', python, '--no-build-isolation', '-e', NATIVE_SRC], 300000);
        if (!pkg.ok) return { ok: false, error: `SearXNG package install failed: ${pkg.err.trim().slice(0, 300)}` };
      } else {
        const py = pythonCommands()[0];
        if (!py) return { ok: false, error: 'uv is not installed and no Python launcher was found' };
        if (!fs.existsSync(nativeBin('python'))) {
          nativeLog(`creating the Python environment with ${py.cmd}`);
          const venv = await run(py.cmd, [...py.args, '-m', 'venv', NATIVE_VENV], 180000);
          if (!venv.ok) return { ok: false, error: `python venv failed: ${venv.err.trim().slice(0, 300)}` };
        }
        python = nativeBin('python');
        nativeLog('installing SearXNG dependencies (pip)');
        const deps = await run(python, ['-m', 'pip', 'install', '-r', requirements], 900000);
        if (!deps.ok) return { ok: false, error: `SearXNG dependencies failed: ${deps.err.trim().slice(0, 300)}` };
        const setup = await run(python, ['-m', 'pip', 'install', 'setuptools', 'wheel'], 180000);
        if (!setup.ok) return { ok: false, error: `setuptools/wheel failed: ${setup.err.trim().slice(0, 300)}` };
        nativeLog('installing the SearXNG package');
        const pkg = await run(python, ['-m', 'pip', 'install', '--no-build-isolation', '-e', NATIVE_SRC], 300000);
        if (!pkg.ok) return { ok: false, error: `SearXNG package install failed: ${pkg.err.trim().slice(0, 300)}` };
      }
      if (!nativeInstalled()) return { ok: false, error: 'SearXNG installed, but its launcher is missing' };
      nativeLog('SearXNG installed');
      return { ok: true };
    } finally {
      nativeState.installing = false;
    }
  }

  async function ensureNativeSearxng() {
    const saved = savedUrl();
    if (saved) {
      const found = await probe(saved);
      if (found.ok) return { ok: true, url: saved, test: found, reused: true, native: true };
    }
    if (!nativeInstalled()) {
      const installed = await installNativeSearxng();
      if (!installed.ok) return installed;
    }
    if (nativeState.child && nativeState.child.exitCode === null && nativeState.url) {
      const running = await probe(nativeState.url);
      if (running.ok) return { ok: true, url: nativeState.url, test: running, reused: true, native: true };
    }
    const port = await nativePort();
    if (!port) return { ok: false, error: 'no free port for the local SearXNG' };
    const url = `http://127.0.0.1:${port}`;
    // Stop only the child this bridge started; an instance someone else runs is
    // detected above and never touched.
    try { nativeState.child && nativeState.child.kill(); } catch { /* already gone */ }
    writeSettingsFile(port, '127.0.0.1');
    nativeLog(`starting SearXNG on ${url}`);
    const child = spawn(nativeBin('searxng-run'), [], {
      cwd: NATIVE_SRC,
      env: Object.assign({}, process.env, { SEARXNG_SETTINGS_PATH: SETTINGS_FILE }),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    nativeState.child = child;
    nativeState.url = url;
    child.stderr.on('data', (c) => {
      const text = String(c || '').trim();
      if (text) nativeLog(text);
    });
    child.on('exit', () => {
      if (nativeState.child === child) nativeState.child = null;
    });
    const test = await waitForSearxng(url, 60000);
    if (!test.ok) {
      try { child.kill(); } catch { /* gone */ }
      return {
        ok: false,
        error: `the local SearXNG did not answer on ${url} (${test.error})${nativeState.log.length ? `. Last log: ${nativeState.log[nativeState.log.length - 1]}` : ''}`,
      };
    }
    writeSearxngConfig(url);
    return { ok: true, url, test, started: true, native: true };
  }

  async function waitForSearxng(url, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await probe(url);
      if (last.ok) return last;
      await new Promise((r) => setTimeout(r, 1500));
    }
    return last || { ok: false, error: 'timed out' };
  }

  async function ensureSearxng(action) {
    if (action === 'detect') return detect();
    // `start`: reuse anything already answering, otherwise bring up the container
    // and wait for it - the first start pulls the image and initialises the DB.
    const found = await detect();
    if (found.ok) return found;
    const up = await ensureContainer();
    if (up.ok) {
      const url = `http://127.0.0.1:${PORT}`;
      const test = await waitForSearxng(url);
      if (test.ok) {
        try { writeSearxngConfig(url); }
        catch (e) { return { ok: false, error: `could not save the SearXNG URL: ${e.message}` }; }
        return { ok: true, url, test, started: true, tried: found.tried };
      }
      // Docker was there but the container did not answer. A private Python
      // install is still worth trying rather than leaving the user with a
      // half-started container and no search.
      const dockerError = `the ${CONTAINER} container did not answer on ${url} (${test.error}). Its log: ${(await run(DOCKER, ['logs', '--tail', '20', CONTAINER], 30000)).out.slice(-800)}`;
      const native = await ensureNativeSearxng();
      if (native.ok) return { ...native, docker: up.docker, tried: found.tried };
      return { ok: false, error: `${dockerError} ${native.error || ''}`.trim(), docker: up.docker, tried: found.tried };
    }
    const native = await ensureNativeSearxng();
    if (native.ok) return { ...native, docker: up.docker, tried: found.tried };
    return {
      ok: false,
      error: `Docker: ${up.error}. A local SearXNG install also failed: ${native.error || 'unknown error'}`,
      docker: up.docker,
      tried: found.tried,
    };
  }

  /* ── Camoufox ─────────────────────────────────────────────────────────────
   * A browser download, not a config line: run it in the background and let the
   * page poll. `uv` is preferred (it keeps the tool out of the system Python);
   * pip is the fallback; neither is a clear message, not a silent failure. */
  const CAMOUFOX = process.env.PI_CAMOUFOX_CMD || 'camoufox';
  const camoufoxJob = { running: false, ok: null, version: null, log: [], startedAt: 0, finishedAt: 0 };

  /* Python is the fallback when uv is absent, and on Linux it is usually
   * `python3` - `python` was removed from several distributions years ago.
   * `py -3` is the Windows launcher. */
  function pythonCommands() {
    const out = [];
    if (process.env.PI_PYTHON) out.push({ cmd: process.env.PI_PYTHON, args: [] });
    out.push({ cmd: 'python3', args: [] }, { cmd: 'python', args: [] });
    if (process.platform === 'win32') out.push({ cmd: 'py', args: ['-3'] });
    return out;
  }

  function versionLine(r) {
    return String(r.out || r.err || '').trim().split('\n')[0];
  }

  async function pythonCamoufox() {
    for (const py of pythonCommands()) {
      const r = await run(py.cmd, [...py.args, '-m', 'camoufox', '--version'], 20000);
      if (r.ok) return { available: true, version: versionLine(r), via: `${py.cmd} -m camoufox`, python: py };
    }
    return null;
  }

  function addToPath(dir) {
    if (!dir) return;
    const parts = String(process.env.PATH || '').split(path.delimiter);
    if (!parts.includes(dir)) process.env.PATH = `${dir}${path.delimiter}${process.env.PATH || ''}`;
  }

  async function camoufoxAvailable() {
    const r = await run(CAMOUFOX, ['--version'], 20000);
    if (r.ok) return { available: true, version: versionLine(r), via: CAMOUFOX };
    // A uv tool install lives in ~/.local/bin; a shell launched from a desktop
    // icon may not have that on PATH yet.
    const shim = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'camoufox.exe' : 'camoufox');
    if (CAMOUFOX === 'camoufox' && fs.existsSync(shim)) {
      const s = await run(shim, ['--version'], 20000);
      if (s.ok) return { available: true, version: versionLine(s), via: shim };
    }
    // pip install --user: the module is importable even when the console script
    // is not on PATH.
    const py = await pythonCamoufox();
    if (py) return py;
    // uv tool install: ask uv's own environment instead of assuming its shim
    // directory is on the bridge's PATH.
    const list = await run('uv', ['tool', 'list'], 15000);
    if (list.ok && /(^|\s)camoufox\b/i.test(list.out)) {
      const v = await run('uv', ['tool', 'run', 'camoufox', '--version'], 20000);
      if (v.ok) return { available: true, version: versionLine(v), via: 'uv tool run camoufox' };
    }
    return { available: false, version: null };
  }

  async function installCamoufox() {
    if (camoufoxJob.running) return camoufoxJob;
    camoufoxJob.running = true;
    camoufoxJob.ok = null;
    camoufoxJob.version = null;
    camoufoxJob.log = [];
    camoufoxJob.startedAt = Date.now();
    camoufoxJob.finishedAt = 0;
    const log = (s) => {
      camoufoxJob.log.push(String(s).slice(0, 300));
      if (camoufoxJob.log.length > 40) camoufoxJob.log.shift();
    };
    (async () => {
      const have = await camoufoxAvailable();
      if (have.available) {
        camoufoxJob.version = have.version || null;
        log(`already installed: ${have.version || 'camoufox'}`);
        camoufoxJob.ok = true;
        return;
      }
      const uv = await run('uv', ['--version'], 15000);
      let fetched = null;
      if (uv.ok) {
        log('installing with uv (uv tool install camoufox)');
        const inst = await run('uv', ['tool', 'install', 'camoufox'], 900000);
        log(inst.ok ? 'uv install finished' : `uv install failed: ${inst.err.trim().slice(0, 200)}`);
        if (!inst.ok) { camoufoxJob.ok = false; return; }
        const bin = await run('uv', ['tool', 'dir', '--bin'], 15000);
        if (bin.ok) addToPath(bin.out.trim());
        log('fetching the Camoufox browser (uv tool run camoufox fetch)');
        fetched = await run('uv', ['tool', 'run', 'camoufox', 'fetch'], 900000);
      } else {
        const py = await pythonCamoufox();
        const chosen = py ? py.python : pythonCommands()[0];
        if (!chosen) {
          log('uv is not installed and no Python launcher was found - install uv or Python, then retry');
          camoufoxJob.ok = false;
          return;
        }
        log(`uv not found, installing with ${chosen.cmd} -m pip install --user camoufox`);
        const inst = await run(chosen.cmd, [...chosen.args, '-m', 'pip', 'install', '--user', 'camoufox'], 900000);
        log(inst.ok ? 'pip install finished' : `pip install failed: ${inst.err.trim().slice(0, 200)}`);
        if (!inst.ok) { camoufoxJob.ok = false; return; }
        log('fetching the Camoufox browser (python -m camoufox fetch)');
        fetched = await run(chosen.cmd, [...chosen.args, '-m', 'camoufox', 'fetch'], 900000);
      }
      log(fetched && fetched.ok ? 'browser downloaded' : `fetch failed: ${(fetched && fetched.err || '').trim().slice(0, 200)}`);
      const after = await camoufoxAvailable();
      camoufoxJob.version = after.version || null;
      if (after.available) log(`installed: ${after.version || 'camoufox'}`);
      // The download and the fetch both succeeded even if the command is not on
      // this process's PATH yet; the next status check will find the uv shim.
      camoufoxJob.ok = !!(fetched && fetched.ok) || after.available;
    })().catch((e) => { camoufoxJob.ok = false; camoufoxJob.log.push(String(e && e.message || e).slice(0, 200)); })
      .finally(() => { camoufoxJob.running = false; camoufoxJob.finishedAt = Date.now(); });
    return camoufoxJob;
  }

  /* ── the route ──────────────────────────────────────────────────────────*/

  function status() {
    return {
      ok: true,
      configFile: SEARXNG_CONFIG,
      savedUrl: savedUrl(),
      docker: { command: DOCKER, image: IMAGE, container: CONTAINER, port: PORT },
      native: {
        installed: nativeInstalled(),
        running: !!(nativeState.child && nativeState.child.exitCode === null),
        url: nativeState.url || null,
        installing: nativeState.installing,
        log: nativeState.log.slice(-5),
      },
      camoufox: { ...camoufoxJob },
    };
  }

  async function handlePost(req, res) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1 << 20) req.destroy(); });
    req.on('end', async () => {
      let j = null;
      try { j = JSON.parse(body || '{}'); } catch { j = null; }
      const action = j && typeof j.action === 'string' ? j.action : 'start';
      if (!['detect', 'start', 'url'].includes(action)) {
        jsonOut(res, 400, { ok: false, error: 'action must be detect, start or url' });
        return;
      }
      let result;
      if (action === 'url') {
        let url;
        try { url = new URL(String((j && j.url) || '').trim()); } catch { url = null; }
        if (!url || !/^https?:$/.test(url.protocol)) {
          jsonOut(res, 400, { ok: false, error: 'url must be an http(s) URL' });
          return;
        }
        url.hash = ''; url.search = '';
        const clean = url.toString().replace(/\/$/, '');
        const test = await probe(clean);
        if (!test.ok) { jsonOut(res, 200, { ok: false, url: clean, test, error: `no JSON answer from ${clean}: ${test.error}` }); return; }
        try { writeSearxngConfig(clean); }
        catch (e) { jsonOut(res, 500, { ok: false, error: `could not save the SearXNG URL: ${e.message}` }); return; }
        result = { ok: true, url: clean, test };
      } else {
        try { result = await ensureSearxng(action); }
        catch (e) { jsonOut(res, 500, { ok: false, error: `could not start search: ${e.message}` }); return; }
      }
      let camoufox = await camoufoxAvailable();
      if (j && j.camoufox === true && !camoufox.available && !camoufoxJob.running) {
        installCamoufox();
        camoufox = { ...camoufox, installing: true };
      } else if (camoufoxJob.running) {
        camoufox = { ...camoufox, installing: true };
      }
      jsonOut(res, 200, { ...result, camoufox, configFile: SEARXNG_CONFIG });
    });
  }

  /* If the bridge restarts while a native SearXNG is installed, bring it back
   * without waiting for the user to open Setup again. The probe above is still
   * the authority: an instance already answering is left alone. */
  setTimeout(() => {
    try {
      const saved = savedUrl();
      if (!saved || !nativeInstalled()) return;
      const u = new URL(saved);
      if (localHost(u.hostname)) ensureNativeSearxng().catch(() => {});
    } catch { /* no saved URL or no native install */ }
  }, 1500).unref?.();

  process.once('exit', () => {
    try { nativeState.child && nativeState.child.kill(); } catch { /* gone */ }
  });

  return {
    match(req) {
      return req.url.startsWith('/api/websearch-setup');
    },
    async handle(req, res) {
      const only = req.url.split('?')[0];
      if (req.method === 'POST' && only === '/api/websearch-setup') { await handlePost(req, res); return; }
      if (req.method === 'GET' && only === '/api/websearch-setup') {
        const docker = await dockerAvailable();
        const camoufox = await camoufoxAvailable();
        jsonOut(res, 200, { ...status(), docker: { ...status().docker, available: docker.ok, error: docker.error }, camoufox: { ...camoufoxJob, ...camoufox } });
        return;
      }
      jsonOut(res, 405, { ok: false, error: 'use GET or POST' });
    },
  };
};
