/*
 * Issue #198: pre-installed SearXNG failed because pi-searxng has no bundled
 * server. It reads ~/.pi/searxng.json and defaults to localhost:8080. This
 * stands up a fake SearXNG, points the bridge at it, and checks the config file,
 * the test endpoint and the settings row. Camoufox is intentionally not part of
 * this: pi-searxng only searches; camoufox is for browsing other extensions.
 *
 * Usage: node test-searxng.js <browserPath>
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
const PORT = 3099;
const SEARX_PORT = 3098;
const DBG_PORT = 9550 + (process.pid % 200);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-searx-'));
for (const d of ['agent', 'sessions', 'ws', '.pi']) fs.mkdirSync(path.join(scratch, d), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bridge = null;
let searx = null;
const cleanup = () => {
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
  try { if (searx) searx.close(); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);

const json = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res({ status: r.statusCode, body: JSON.parse(b) }); } catch (e) { rej(e); } });
  }).on('error', rej);
});
const post = (body) => new Promise((res, rej) => {
  const data = JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/searxng-config', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res({ status: r.statusCode, body: JSON.parse(b) }); } catch (e) { rej(e); } });
  });
  req.on('error', rej); req.end(data);
});

(async () => {
  searx = http.createServer((req, res) => {
    if (!/^\/search\?/.test(req.url || '') || !/[?&]format=json/.test(req.url || '')) { res.writeHead(400); res.end('bad'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'A', url: 'https://a.example', content: 'one' }, { title: 'B', url: 'https://b.example', content: 'two' }] }));
  });
  await new Promise((r) => searx.listen(SEARX_PORT, '127.0.0.1', r));

  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      USERPROFILE: scratch, HOME: scratch,
      PI_AGENT_DIR: path.join(scratch, 'agent'), PI_CODING_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_SESSION_DIR: path.join(scratch, 'sessions'), WORKSPACE_DIR: path.join(scratch, 'ws'),
      PI_SESSION_DIR: path.join(scratch, 'sessions'), PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'),
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_LLAMA_SCAN: 'off', PORT: String(PORT),
    }), stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = ''; bridge.stderr.on('data', (c) => { err += c; });
  let up = false;
  for (let i = 0; i < 100; i++) {
    try { await json(PORT, '/api/health'); up = true; break; } catch { await sleep(200); }
  }
  if (!up) fail('the bridge never came up\n' + err.slice(-500));

  const before = await json(PORT, '/api/searxng-config');
  if (!before.body.ok || before.body.url !== 'http://localhost:8080') fail('the default URL is wrong: ' + JSON.stringify(before.body));
  const saved = await post({ searxngUrl: `http://127.0.0.1:${SEARX_PORT}/`, test: true });
  if (saved.status !== 200 || !saved.body.ok || !saved.body.test || !saved.body.test.ok) fail('the test request failed: ' + JSON.stringify(saved.body));
  if (saved.body.test.results !== 2) fail('the test did not report both results: ' + JSON.stringify(saved.body.test));
  const cfg = JSON.parse(fs.readFileSync(path.join(scratch, '.pi', 'searxng.json'), 'utf8'));
  if (cfg.searxngUrl !== `http://127.0.0.1:${SEARX_PORT}`) fail('the config file is wrong: ' + JSON.stringify(cfg));
  console.log('  config:', JSON.stringify(cfg), 'test:', JSON.stringify(saved.body.test));

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-searx-browser-'));
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-default-browser-check', '--disable-extensions', '--remote-debugging-port=' + DBG_PORT, '--user-data-dir=' + userDir, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const cleanupBrowser = () => { try { child.kill(); } catch { /* gone */ } try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ } };
  process.on('exit', cleanupBrowser);
  let ver = null;
  for (let i = 0; i < 100; i++) { try { ver = await new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: DBG_PORT, path: '/json/version' }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej); }); break; } catch { await sleep(150); } }
  if (!ver) fail('the browser never came up');
  const WS = require('./ws-min.js');
  const page = (await new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: DBG_PORT, path: '/json/list' }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej); })).find((t) => t.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl); await ws.open();
  let id = 0; const pending = new Map(); const problems = [];
  ws.onmessage = (raw) => { let m; try { m = JSON.parse(raw); } catch { return; } if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; } if (m.method === 'Runtime.exceptionThrown') { const e = m.params.exceptionDetails || {}; problems.push(((e.exception && (e.exception.description || e.exception.value)) || e.text || '?')); } };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw'); return r.result && r.result.result ? r.result.result.value : undefined; };
  await send('Runtime.enable'); await send('Page.enable'); await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 100; i++) { if (await evalJs("typeof openSettings === 'function' ? 1 : 0")) break; await sleep(250); }
  const ui = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    document.querySelectorAll('dialog[open]').forEach((d) => { try { d.close(); } catch {} });
    openSettings();
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && $('set-searxng-url').value !== ${JSON.stringify(`http://127.0.0.1:${SEARX_PORT}`)}) await new Promise((r) => setTimeout(r, 100));
    const loaded = $('set-searxng-url').value;
    $('set-searxng-url').value = ${JSON.stringify(`http://127.0.0.1:${SEARX_PORT}`)};
    $('btn-searxng-test').click();
    await new Promise((r) => setTimeout(r, 900));
    return { loaded, note: $('set-searxng-note').textContent, disabled: $('set-searxng-url').disabled };
  })()))()`));
  if (ui.loaded !== `http://127.0.0.1:${SEARX_PORT}`) fail('the settings row did not load the saved URL: ' + JSON.stringify(ui));
  if (!/answered/i.test(ui.note)) fail('the test note does not report a working endpoint: ' + JSON.stringify(ui.note));
  if (ui.disabled) fail('the URL field stayed disabled');
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));

  console.log(`  settings row loaded and tested: ${JSON.stringify(ui.note)}`);
  console.log('  PASS #198 SearXNG config is saved, tested and surfaced in settings; Camoufox is not required for search');
  ws.close(); cleanupBrowser(); cleanup(); process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
