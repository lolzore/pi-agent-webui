/*
 * Issue #270: "agent total time doesn't appear at every screen width and
 * sometimes gets stuck and won't count up."
 *
 * Two separate faults, one test:
 *  - a narrow-screen rule hid #stat-turn entirely below 760px;
 *  - a session poll taken between agent_end and agent_settled saw busy:false
 *    while the turn was still streaming and finished the clock early, which
 *    left the last total on screen for the rest of the task.
 *
 * Usage: node test-run-clock.js <browserPath>
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
const PORT = 22900 + (process.pid % 300);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-clock-'));
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
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-clock-browser-'));
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 100; i++) {
    if (await evalJs("typeof startRunClock === 'function' && typeof applyAgentStatus === 'function' ? 1 : 0")) break;
    await sleep(250);
  }

  /* A turn is streaming (S.isStreaming true) but a poll reports busy:false,
   * exactly the agent_end/agent_settled window. The clock must keep running. */
  const midTurn = JSON.parse(await evalJs(`(() => {
    S.runStartTs = null; S.runMs = null;
    startRunClock();
    S.runStartTs = Date.now() - 5000;
    S.runMs = null;
    S.agentBusy = true;
    S.isStreaming = true;
    S.compacting = false;
    applyAgentStatus({ busy: false, compacting: null });
    paintRunStat();
    const s = $('stat-turn');
    return JSON.stringify({ kept: !!S.runStartTs, text: s.textContent, live: s.classList.contains('live') });
  })()`));
  if (!midTurn.kept) fail('a busy:false poll during a streaming turn finished the task clock (issue #270)');
  if (!/^total /.test(midTurn.text)) fail('the task clock did not paint while streaming: ' + JSON.stringify(midTurn));
  if (!midTurn.live) fail('the task clock lost its live class while streaming: ' + JSON.stringify(midTurn));

  const firstText = midTurn.text;
  await sleep(1200);
  const ticked = JSON.parse(await evalJs(`(() => { paintRunStat(); return JSON.stringify({ text: $('stat-turn').textContent, runStart: S.runStartTs }); })()`));
  if (!ticked.runStart) fail('the task clock stopped itself during the wait');
  if (ticked.text === firstText) fail(`the task clock did not count up: "${firstText}" then "${ticked.text}"`);

  /* The same guard on the reload path. */
  const restored = JSON.parse(await evalJs(`(() => {
    S.runStartTs = Date.now() - 5000; S.runMs = null;
    S.agentBusy = false; S.isStreaming = true; S.compacting = false;
    restoreRunClock();
    return JSON.stringify({ kept: !!S.runStartTs, text: $('stat-turn').textContent });
  })()`));
  if (!restored.kept) fail('restoreRunClock finished a clock for a turn that is still streaming');

  /* Issue #270, first half: the stat is visible at desktop, tablet and phone
   * widths. At 360px it is ordered first in the stats row so it cannot sit
   * off-screen inside the horizontal scroller. */
  for (const width of [1200, 700, 360]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 700, deviceScaleFactor: 1, mobile: false });
    await sleep(250);
    const vis = JSON.parse(await evalJs(`(() => {
      const s = $('stat-turn');
      const bar = $('stats-bar').getBoundingClientRect();
      const r = s.getBoundingClientRect();
      return JSON.stringify({ display: getComputedStyle(s).display, text: s.textContent, left: r.left, right: r.right, width: r.width, barLeft: bar.left, barRight: bar.right, vw: innerWidth });
    })()`));
    if (vis.display === 'none' || vis.width < 1) fail(`the task clock is hidden at ${width}px: ` + JSON.stringify(vis));
    if (vis.left < -1 || vis.right > vis.vw + 1) fail(`the task clock is off-screen at ${width}px: ` + JSON.stringify(vis));
    if (vis.right > vis.barRight + 1 || vis.left < vis.barLeft - 1) fail(`the task clock is outside the visible stats row at ${width}px: ` + JSON.stringify(vis));
  }

  /* Once the turn really settles, the clock still finishes (the guard must not
   * make it run forever). With no assistant message there is no honest end
   * timestamp, so it clears itself. */
  const settled = JSON.parse(await evalJs(`(() => {
    S.isStreaming = false;
    S.agentBusy = false;
    applyAgentStatus({ busy: false, compacting: null });
    return JSON.stringify({ runStart: S.runStartTs, text: $('stat-turn').textContent });
  })()`));
  if (settled.runStart) fail('the task clock never finished after the turn settled');
  if (settled.text) fail('the cleared task clock still shows text: ' + JSON.stringify(settled));

  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));
  console.log(`  kept the clock through busy:false, counted ${firstText} → ${ticked.text}; visible at 1200/700/360px`);
  console.log('  PASS #270 the task clock is visible at every width and never freezes mid-turn');
  cleanupBrowser();
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
