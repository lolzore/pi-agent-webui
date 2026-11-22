/*
 * Issue #218: first-run setup should leave web search working, not install a
 * package and a to-do list.
 *
 * The wizard installed pi-searxng and then said "now set its URL in Settings and
 * get an instance running". This checks the bridge side and the wizard side:
 *
 *   - POST /api/websearch-setup {action:'url'} saves ~/.pi/searxng.json the way
 *     pi-searxng reads it, but only after the endpoint answers a JSON query;
 *   - {action:'detect'} finds an instance that is already answering;
 *   - {action:'start'} with no Docker answers with a sentence, not a crash, and
 *     with an instance already answering it uses that instead of a container;
 *   - the wizard's "set up web search now" box is on by default, and pressing
 *     next runs the setup and says what happened before moving on.
 *
 * The fake SearXNG is a local HTTP server; no container is started here.
 *
 * Usage: node test-websearch-setup.js <browserPath>
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const browser = process.argv[2];
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const ROOT = path.resolve(__dirname, '..');
const PORT = 23500 + (process.pid % 300);
const DBG_PORT = 9800 + (process.pid % 150);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-websearch-'));
const agentDir = path.join(scratch, 'agent');
const sessionDir = path.join(scratch, 'sessions');
const webuiFile = path.join(scratch, 'webui.json');
const CONFIG = path.join(os.homedir(), '.pi', 'searxng.json');
for (const d of [agentDir, sessionDir, path.join(scratch, 'ws')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(webuiFile, JSON.stringify({ onboarded: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let savedBefore = null;
try { savedBefore = fs.readFileSync(CONFIG, 'utf8'); } catch { /* none yet */ }

let bridge = null; let fake = null;
const cleanup = () => {
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
  try { if (fake) fake.close(); } catch { /* gone */ }
  try {
    // put the real config back exactly as it was
    if (savedBefore === null) fs.rmSync(CONFIG, { force: true });
    else fs.writeFileSync(CONFIG, savedBefore);
  } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);

const getJson = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
const postJson = (port, p, body) => new Promise((res, rej) => {
  const data = JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  });
  req.on('error', rej);
  req.end(data);
});

(async () => {
  /* A SearXNG that answers JSON, on a port the bridge's candidate list does not
   * contain - so detection only finds it once it is saved. */
  fake = http.createServer((req, res) => {
    // only the real path answers, so a wrong base URL fails like a real one would
    if (!req.url.startsWith('/search?') || !/format=json/.test(req.url)) { res.writeHead(403); res.end('json not enabled'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ query: 'pi', results: [{ title: 'a' }, { title: 'b' }] }));
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const fakePort = fake.address().port;
  const fakeUrl = `http://127.0.0.1:${fakePort}`;

  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir, PI_SESSION_DIR: sessionDir,
      WORKSPACE_DIR: path.join(scratch, 'ws'),
      PI_WEBUI_SETTINGS: webuiFile,
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'),
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_LLAMA_SCAN: 'off',
      PI_DOCKER: path.join(scratch, 'no-such-docker'),
      // This test is about "no Docker and no local install". A real machine with
      // uv/git would otherwise install SearXNG natively; fail the clone instead.
      PI_GIT: path.join(scratch, 'no-such-git'),
      PI_UV: path.join(scratch, 'no-such-uv'),
      // node answers --version, so the wizard sees Camoufox as present and does
      // not start a real browser download in a test
      PI_CAMOUFOX_CMD: process.execPath,
      PI_SEARXNG_PORT: '1',            // nothing is listening there on purpose
      PORT: String(PORT),
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let bridgeErr = '';
  bridge.stderr.on('data', (c) => { bridgeErr += c; });
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { const d = await getJson(PORT, '/api/health'); if (d.ok) { up = true; break; } } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('the scratch bridge never came up\n' + bridgeErr.slice(-600));

  /* 1. no instance, no Docker: a sentence, not a crash. */
  const noDocker = await postJson(PORT, '/api/websearch-setup', { action: 'start' });
  console.log('  start without Docker:', JSON.stringify(noDocker).slice(0, 220));
  if (noDocker.ok) fail('start reported success with no SearXNG and no Docker');
  if (!/docker/i.test(String(noDocker.error || ''))) fail('the failure does not mention Docker: ' + noDocker.error);
  if (!noDocker.camoufox || noDocker.camoufox.available !== true) {
    fail('a failed SearXNG hid the Camoufox result: ' + JSON.stringify(noDocker));
  }

  /* 2. an explicit URL is only saved once it answers JSON. */
  const bad = await postJson(PORT, '/api/websearch-setup', { action: 'url', url: `http://127.0.0.1:${fakePort}/nope` });
  if (bad.ok) fail('a URL that does not answer JSON was accepted');
  const wrong = await postJson(PORT, '/api/websearch-setup', { action: 'url', url: 'http://127.0.0.1:9' });
  if (wrong.ok) fail('a dead URL was accepted');

  const good = await postJson(PORT, '/api/websearch-setup', { action: 'url', url: fakeUrl + '/' });
  console.log('  explicit URL:', JSON.stringify(good).slice(0, 200));
  if (!good.ok) fail('a working SearXNG was refused: ' + JSON.stringify(good));
  if (!good.test || good.test.results !== 2) fail('the test query did not come back with the fake results: ' + JSON.stringify(good.test));
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  if (cfg.searxngUrl !== fakeUrl) fail('the config file does not point at the instance: ' + JSON.stringify(cfg));
  if (cfg.timeoutMs !== 30000 || cfg.maxResults !== 10) fail('the config is not the shape pi-searxng reads: ' + JSON.stringify(cfg));

  /* 3. detection reuses it, and `start` does too (no container needed). */
  const detected = await postJson(PORT, '/api/websearch-setup', { action: 'detect' });
  if (!detected.ok || detected.url !== fakeUrl) fail('detect did not find the saved instance: ' + JSON.stringify(detected));
  const started = await postJson(PORT, '/api/websearch-setup', { action: 'start' });
  if (!started.ok || started.url !== fakeUrl) fail('start did not reuse the answering instance: ' + JSON.stringify(started));

  const status = await getJson(PORT, '/api/websearch-setup');
  if (status.savedUrl !== fakeUrl) fail('GET does not report the saved instance: ' + JSON.stringify(status));
  if (!status.docker || status.docker.available !== false) fail('GET does not report that Docker is unavailable here: ' + JSON.stringify(status.docker));
  if (!status.camoufox || typeof status.camoufox.available !== 'boolean') fail('GET does not report the Camoufox state: ' + JSON.stringify(status.camoufox));

  /* 4. the wizard: the box is on by default, and next runs the setup. */
  fs.writeFileSync(webuiFile, JSON.stringify({ onboarded: false }));
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-websearch-browser-'));
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--remote-debugging-port=' + DBG_PORT, '--user-data-dir=' + userDir,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const cleanupBrowser = () => {
    try { child.kill(); } catch { /* gone */ }
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ }
  };
  process.on('exit', cleanupBrowser);
  let berr = '';
  child.stderr.on('data', (c) => { berr += c; });
  let ver = null;
  for (let i = 0; i < 100; i++) { try { ver = await getJson(DBG_PORT, '/json/version'); break; } catch { await sleep(150); } }
  if (!ver) fail('browser never came up\n' + berr.slice(-400));

  const WS = require('./ws-min.js');
  const page = (await getJson(DBG_PORT, '/json/list')).find((t) => t.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.open();
  let id = 0; const pending = new Map(); const problems = [];
  ws.onmessage = (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails || {};
      problems.push(((e.exception && (e.exception.description || e.exception.value)) || e.text || '?'));
    }
  };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw');
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 140; i++) {
    if (await evalJs("typeof maybeShowSetup === 'function' && document.getElementById('setup-dialog') && document.getElementById('setup-dialog').open ? 1 : 0")) break;
    await sleep(250);
  }
  const out = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const res = {};
    res.boxExists = !!document.getElementById('setup-websearch');
    res.boxChecked = !!(document.getElementById('setup-websearch') || {}).checked;
    // tick the search package, and let the install calls answer instantly: the
    // point here is the wizard's own step, not npm
    const pkg = [...document.querySelectorAll('#setup-packages-list input[data-package]')].find((c) => c.dataset.package === 'npm:pi-searxng');
    // Leave the package unchecked: clicking next with the websearch box ticked
    // must select it, not silently skip the setup.
    res.pkgInitiallyUnchecked = !!pkg && !pkg.checked;
    const realFetch = window.fetch;
    window.fetch = (u, o) => String(u).includes('/api/pi-extensions/package')
      ? Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
      : realFetch(u, o);
    document.getElementById('setup-done').click();
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      const s = (document.getElementById('setup-websearch-status') || {}).textContent || '';
      if (/SearXNG answers at|not ready|not set up/.test(s)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    res.status = (document.getElementById('setup-websearch-status') || {}).textContent || '';
    res.pkgSelected = !!pkg && pkg.checked;
    res.camoufoxReady = /Camoufox is ready/.test(res.status);
    res.prefsShown = !document.getElementById('setup-step-prefs').classList.contains('hidden');
    window.fetch = realFetch;
    return res;
  })()))()`));
  console.log('  wizard:', JSON.stringify(out));
  if (!out.boxExists) fail('the setup wizard has no "set up web search now" box');
  if (!out.boxChecked) fail('the web search box is not ticked by default');
  if (!/SearXNG answers at/.test(out.status)) fail('the wizard did not set up and report web search: ' + out.status);
  if (!/result/.test(out.status)) fail('the wizard does not report the test query result: ' + out.status);
  if (!out.pkgInitiallyUnchecked || !out.pkgSelected) {
    fail('the setup box did not select the pi-searxng package it needs: ' + JSON.stringify(out));
  }
  if (!out.camoufoxReady) fail('the wizard did not report the Camoufox state: ' + out.status);
  if (!out.prefsShown) fail('the wizard did not move on to the preferences after setting up search');
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));

  console.log('  PASS #218 first-run setup points pi-searxng at a working instance and says so');
  ws.close(); cleanupBrowser(); cleanup(); process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
