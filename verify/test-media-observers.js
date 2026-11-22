/*
 * #256, the session-switch path. renderSessionFromDisk() clears the transcript
 * after importing another session; it must unobserve the images it removes
 * BEFORE clearing (querySelectorAll on an emptied chat finds nothing). The same
 * applies to a subagent rebuild.
 *
 * Runs a scratch bridge whose mock session is a 5-image transcript, instruments
 * IntersectionObserver.observe/unobserve before the page scripts run, renders
 * that session twice through renderSessionFromDisk and once through
 * refreshMessages, and asserts nothing is retained.
 *
 * Usage: node test-media-observers.js <browserPath>
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const browser = process.argv[2];
const fail = (m) => { console.error('FAIL: ' + m); cleanup(); process.exit(1); };
if (!browser || !fs.existsSync(browser)) { console.error('usage: node test-media-observers.js <browserPath>'); process.exit(2); }

const BASE_PORT = 4197;
const DBG = 9930 + (process.pid % 9);
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-media-obs-'));
const SESSIONS = path.join(T, 'sessions');
fs.mkdirSync(SESSIONS, { recursive: true });
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SESSION = path.join(SESSIONS, 'media.jsonl');
const content = [{ type: 'text', text: 'five images' }];
for (let i = 0; i < 5; i++) content.push({ type: 'image', mimeType: 'image/png', data: PNG });
fs.writeFileSync(SESSION, JSON.stringify({ type: 'session', version: 3, id: 'media', timestamp: new Date().toISOString(), cwd: T }) + '\n' +
  JSON.stringify({ type: 'message', id: 'mm', timestamp: Date.now(), message: { role: 'user', content } }) + '\n');

let bridge = null;
let chrome = null;
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-media-br-'));
function cleanup() {
  try { chrome && chrome.kill(); } catch { /* gone */ }
  try { bridge && bridge.kill(); } catch { /* gone */ }
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ }
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* gone */ }
}
process.on('exit', cleanup);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

(async () => {
  bridge = spawn(process.execPath, ['bridge/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(BASE_PORT),
      PI_COMMAND: `node ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_MOCK_SESSION_FILE: SESSION,
      PI_SESSION_DIR: SESSIONS,
      PI_CODING_AGENT_SESSION_DIR: SESSIONS,
      PI_AGENT_DIR: path.join(T, 'agent'),
      PI_CODING_AGENT_DIR: path.join(T, 'agent'),
      WORKSPACE_DIR: path.join(T, 'workspace'),
      PI_WEBUI_SETTINGS: path.join(T, 'settings.json'),
      PI_WEBUI_LAST_SESSION: path.join(T, 'last.json'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await getJson(BASE_PORT, '/api/health')).ok) { up = true; break; } } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('the bridge never came up');

  chrome = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--remote-debugging-port=' + DBG, '--user-data-dir=' + userDir,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  chrome.stderr.on('data', (c) => { stderr += c; });
  let ver = null;
  for (let i = 0; i < 100; i++) { try { ver = await getJson(DBG, '/json/version'); break; } catch { await sleep(150); } }
  if (!ver) fail('browser never came up\n' + stderr.slice(-400));

  const WS = require('./ws-min.js');
  const page = (await getJson(DBG, '/json/list')).find((t) => t.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.open();
  let id = 0; const pending = new Map();
  ws.onmessage = (raw) => { let m; try { m = JSON.parse(raw); } catch { return; } if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw');
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__io={obs:0,unobs:0};
    const O=IntersectionObserver.prototype.observe, U=IntersectionObserver.prototype.unobserve;
    IntersectionObserver.prototype.observe=function(t){window.__io.obs++;return O.call(this,t)};
    IntersectionObserver.prototype.unobserve=function(t){window.__io.unobs++;return U.call(this,t)};
  ` });
  await send('Page.navigate', { url: `http://127.0.0.1:${BASE_PORT}/` });
  for (let i = 0; i < 100; i++) { if (await evalJs("typeof renderSessionFromDisk === 'function' && typeof refreshMessages === 'function' ? 1 : 0")) break; await sleep(200); }
  for (let i = 0; i < 50; i++) { const f = await evalJs("S && S.state && S.state.sessionFile ? S.state.sessionFile : ''"); if (/media\.jsonl/.test(f)) break; await sleep(200); }

  const r = JSON.parse(await evalJs(`(async () => {
    window.__io = { obs: 0, unobs: 0 };
    const p = S.state.sessionFile;
    await renderSessionFromDisk(p);
    await renderSessionFromDisk(p);
    await refreshMessages();
    return JSON.stringify({
      observe: __io.obs,
      unobserve: __io.unobs,
      net: __io.obs - __io.unobs,
      imagesInDom: document.querySelectorAll('#chat img').length,
    });
  })()`));
  if (r.imagesInDom < 5) fail('the image session did not render its images: ' + JSON.stringify(r));
  if (r.unobserve === 0) fail('nothing was unobserved on the session-switch path: ' + JSON.stringify(r));
  if (r.net > r.imagesInDom * 2 + 2) fail(`observer targets grew past the current DOM: ${JSON.stringify(r)}`);

  ws.close(); cleanup();
  console.log(`  two renderSessionFromDisk + one refresh: observe ${r.observe}, unobserve ${r.unobserve}, net ${r.net} for ${r.imagesInDom} images`);
  console.log('PASS #256 session-switch rebuilds do not retain detached media');
  process.exit(0);
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
