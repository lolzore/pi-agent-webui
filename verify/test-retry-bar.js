/*
 * A provider retry is a state, not a notice (from #83; the cycle items that
 * shipped with it were removed in #107).
 *
 * pi retries a failed provider call itself and reports each attempt through
 * auto_retry_start. That used to be a toast that vanished in seconds while pi
 * kept retrying. It is a bar now (#retry-bar): the attempt, the wait and the
 * error, with Cancel sending abort_retry - pi's own command for it - and it
 * clears on auto_retry_end or agent_settled.
 *
 * This runs its own bridge and mock agent, drives the retry events directly,
 * and asserts the bar, the cancel RPC and both ways it goes away.
 *
 * Usage: node test-retry-bar.js <browserPath>
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
const PORT = 22400 + (process.pid % 300);
let DBG_PORT = 0;   // assigned from the browser's own DevTools line
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-retry-'));
fs.mkdirSync(path.join(scratch, 'agent'), { recursive: true });
fs.mkdirSync(path.join(scratch, 'sessions'), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bridge = null;
const cleanup = () => {
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);

const getJson = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

(async () => {
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_SESSION_DIR: path.join(scratch, 'sessions'),
      WORKSPACE_DIR: scratch,
      PI_SESSION_DIR: path.join(scratch, 'sessions'),
      PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'),
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_LLAMA_SCAN: 'off',
      PORT: String(PORT),
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let bridgeErr = '';
  bridge.stderr.on('data', (c) => { bridgeErr += c; });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const d = await getJson('/api/health'); if (d && d.ok) { up = true; break; } } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('the scratch bridge never came up\n' + bridgeErr.slice(-500));

  const WS = require('./ws-min.js');
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-retry-browser-'));
  const launched = WS.launchBrowser(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--user-data-dir=' + userDir,
    'about:blank',
  ]);
  const child = launched.child;
  let browserErr = '';
  child.stderr.on('data', (c) => { browserErr += c; });
  const cleanupBrowser = () => {
    try { child.kill(); } catch { /* gone */ }
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ }
  };
  process.on('exit', cleanupBrowser);

  try { DBG_PORT = await launched.port; } catch (e) { fail(e.message); }

  let page = null;
  for (let i = 0; i < 100; i++) {
    try {
      const list = await new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port: DBG_PORT, path: '/json/list' }, (r) => {
          let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
          r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
        }).on('error', rej);
      });
      if (Array.isArray(list)) { page = list.find((t) => t.type === 'page'); if (page) break; }
    } catch { /* not ready yet */ }
    await sleep(150);
  }
  if (!page) fail('browser never exposed a page on the debug port\n' + browserErr.slice(-400));
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
  for (let i = 0; i < 100; i++) {
    if (await evalJs("typeof handleRpcMessage === 'function' ? 1 : 0")) break;
    await sleep(250);
  }

  const out = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const res = {};
    const bar = () => $('retry-bar');
    // A retry is a state: the bar stays, names the attempt and the wait, and
    // Cancel sends abort_retry.
    handleRpcMessage({ type: 'auto_retry_start', attempt: 2, maxAttempts: 5, delayMs: 8000, errorMessage: 'provider 503' });
    res.visible = !bar().classList.contains('hidden');
    res.text = bar().textContent;
    res.hasCancel = !!bar().querySelector('button');
    const real = window.rpc;
    window.__rpc = [];
    window.rpc = (m, t) => { window.__rpc.push(m && m.type); return real(m, t); };
    bar().querySelector('button').click();
    await new Promise((r) => setTimeout(r, 400));
    res.cancelSent = window.__rpc.slice();
    res.hiddenAfterCancel = bar().classList.contains('hidden');
    // auto_retry_end hides it too, and agent_settled leaves nothing behind.
    handleRpcMessage({ type: 'auto_retry_start', attempt: 3, maxAttempts: 5, delayMs: 1000, errorMessage: 'again' });
    const shownAgain = !bar().classList.contains('hidden');
    handleRpcMessage({ type: 'auto_retry_end', success: false, errorMessage: 'still failing' });
    res.hiddenAfterEnd = shownAgain && bar().classList.contains('hidden');
    handleRpcMessage({ type: 'auto_retry_start', attempt: 4, maxAttempts: 5, delayMs: 1000, errorMessage: 'again' });
    handleRpcMessage({ type: 'agent_settled' });
    res.hiddenAfterSettle = bar().classList.contains('hidden');
    window.rpc = real;
    return res;
  })()))()`));

  if (!out.visible) fail('the retry bar did not appear: ' + JSON.stringify(out));
  if (!/2\/5/.test(out.text) || !/8s/.test(out.text) || !/503/.test(out.text)) fail('the retry bar does not name the attempt, the wait and the error: ' + JSON.stringify(out.text));
  if (!out.hasCancel) fail('the retry bar has no cancel control');
  if (!out.cancelSent.includes('abort_retry')) fail('cancel did not send abort_retry: ' + JSON.stringify(out.cancelSent));
  if (!out.hiddenAfterCancel) fail('the bar stayed after cancel');
  if (!out.hiddenAfterEnd) fail('auto_retry_end did not hide the bar');
  if (!out.hiddenAfterSettle) fail('agent_settled did not hide the bar');
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));

  console.log(`  retry bar: "${out.text.trim().slice(0, 60)}…", cancel sent abort_retry, end/settle hide it`);
  console.log('  PASS retry: a provider retry is a state with a cancel, and it clears on end or settle');
  cleanupBrowser();
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
