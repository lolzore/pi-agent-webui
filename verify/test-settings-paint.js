/*
 * Issue #117: "the click registers but visually it is delayed by around 2
 * seconds."
 *
 * The click handler is fast (measured 15-100ms even with 40k nodes and under a
 * 6x CPU throttle), so the delay is the dialog's first *paint* competing with a
 * heavy page. The dialog is now its own layer and contains its layout
 * (`contain: layout paint; will-change: transform`), and openSettings records
 * the click-to-frame time in `S.settingsOpenMs` so the number is observable.
 *
 * This runs its own bridge, loads a deliberately heavy transcript, opens
 * Settings and asserts the frame time and the style that keeps the paint
 * independent of the page.
 *
 * Usage: node test-settings-paint.js <browserPath>
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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-paint-'));
fs.mkdirSync(path.join(scratch, 'agent'), { recursive: true });
fs.mkdirSync(path.join(scratch, 'sessions'), { recursive: true });
// Onboarded: otherwise the setup dialog is open under the settings dialog and
// the live paint is (correctly) deferred behind it.
fs.writeFileSync(path.join(scratch, 'webui.json'), JSON.stringify({ onboarded: true }));
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

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-paint-browser-'));
  const launched = require('./ws-min.js').launchBrowser(browser, [
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

  let DBG_PORT = 0;
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

  const WS = require('./ws-min.js');
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
  /* Wait for the first transcript load to finish: injecting the heavy messages
   * while that render is still chunking lets it clear them, which made this
   * test flake inside the suite (the message lookup came back empty). */
  for (let i = 0; i < 100; i++) {
    if (await evalJs("typeof openSettings === 'function' && (S.historyRender || 0) > 0 ? 1 : 0")) break;
    await sleep(250);
  }

  const out = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    // a deliberately heavy transcript, like a long-lived tab
    const chat = document.getElementById('chat');
    for (let i = 0; i < 1500; i++) {
      const d = document.createElement('div');
      d.className = 'msg';
      d.innerHTML = '<div class="bubble">message ' + i + ' with enough text to lay out a line</div>';
      chat.appendChild(d);
    }
    await new Promise((r) => requestAnimationFrame(r));
    const t0 = performance.now();
    $('btn-settings').click();
    const sync = performance.now() - t0;
    await new Promise((r) => requestAnimationFrame(r));
    const frame = performance.now() - t0;
    const cs = getComputedStyle($('settings-dialog'));
    const firstMsg = chat.querySelector('.msg');
    return {
      msgCv: firstMsg ? getComputedStyle(firstMsg).contentVisibility : null,
      msgCis: firstMsg ? getComputedStyle(firstMsg).containIntrinsicSize : null,
      chatLayer: getComputedStyle(document.getElementById('chat')).willChange,
      nodes: document.getElementsByTagName('*').length,
      sync: Math.round(sync),
      frame: Math.round(frame),
      reported: S.settingsOpenMs,
      contain: cs.contain,
      willChange: cs.willChange,
      open: $('settings-dialog').open,
    };
  })()))()`));

  if (!out.open) fail('the dialog did not open');
  if (typeof out.reported !== 'number') fail('S.settingsOpenMs was not recorded: ' + JSON.stringify(out));
  if (out.frame > 1000 || out.reported > 1000) fail(`the dialog took ${out.frame}ms to reach a frame with ${out.nodes} nodes (reported ${out.reported})`);
  /* Issue #150: the fix is not a layer on the chat (that made it worse - the
   * measured cost is laying out and painting the whole transcript behind the
   * modal), it is skipping the messages that are off screen. */
  if (out.msgCv !== 'auto') fail('the transcript messages do not skip off-screen layout/paint: ' + JSON.stringify(out.msgCv));
  if (!/800px/.test(out.msgCis || '')) fail('a message has no intrinsic placeholder size, so the scrollbar would collapse: ' + JSON.stringify(out.msgCis));
  if (out.sync > 80) fail(`opening the dialog blocked the main thread for ${out.sync}ms with ${out.nodes} nodes (measured ~20ms with off-screen messages skipped)`);
  /* No contain/will-change assertion here: those properties are exactly what
   * made the dropdowns land at the dialog's offset (the menus are appended
   * inside it). verify/test-menu-position.js asserts they stay away. */
  /* While a dialog is open the live streaming paint is deferred (issue #117):
   * the dialog's first paint is what the user is waiting for, and the text
   * behind the modal keeps accumulating - the close handler draws it. */
  const stream = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    $('settings-dialog').close();
    await new Promise((r) => setTimeout(r, 100));
    if (typeof startLive === 'function') startLive();
    applyDelta({ type: 'text_delta', delta: 'visible before the dialog ' });
    await new Promise((r) => setTimeout(r, 250));
    const dom = () => (S.live && (S.live.md || S.live.root)) ? (S.live.md || S.live.root).textContent : '';
    const before = dom();
    openSettings();
    await new Promise((r) => setTimeout(r, 100));
    applyDelta({ type: 'text_delta', delta: 'deferred while the dialog is open ' });
    await new Promise((r) => setTimeout(r, 400));
    const during = dom();
    $('settings-dialog').close();
    await new Promise((r) => setTimeout(r, 300));
    const after = dom();
    return { before, during, after, longTasks: Array.isArray(S.settingsLongTasks) ? S.settingsLongTasks.length : null };
  })()))()`));
  if (!/visible before/.test(stream.before)) fail('the live message did not paint before the dialog: ' + JSON.stringify(stream));
  if (/deferred while/.test(stream.during)) fail('the live message repainted behind the open dialog: ' + JSON.stringify(stream));
  if (!/deferred while/.test(stream.after)) fail('the deferred live paint did not happen after the dialog closed: ' + JSON.stringify(stream));
  if (stream.longTasks === null) fail('S.settingsLongTasks was not recorded: ' + JSON.stringify(stream));
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));

  console.log(`  ${out.nodes} nodes: click ${out.sync}ms, first frame ${out.frame}ms (S.settingsOpenMs ${out.reported}); messages skip off-screen layout (${out.msgCv}, ${out.msgCis}); live paint deferred behind the dialog and flushed on close`);
  console.log('  PASS #117/#150 the settings dialog opens without re-laying out the whole transcript');
  cleanupBrowser();
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
