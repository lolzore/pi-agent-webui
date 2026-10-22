/*
 * Issue #124: a top-bar button that shows the running terminals (bash tools) in
 * real time, opens a menu listing each one, and can close them.
 *
 * The tracker is fed by the tool-execution events. This runs its own bridge and
 * drives them directly: two bash tools start, the button shows 2, the menu lists
 * both, closing one sends abort_bash and drops it, ending the other hides the
 * button.
 *
 * Usage: node test-terminals.js <browserPath>
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
const PORT = 24400 + (process.pid % 300);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-term-'));
fs.mkdirSync(path.join(scratch, 'agent'), { recursive: true });
fs.mkdirSync(path.join(scratch, 'sessions'), { recursive: true });
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

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-term-browser-'));
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
  for (let i = 0; i < 100; i++) {
    if (await evalJs("typeof noteTerminalStart === 'function' && typeof openTerminalsMenu === 'function' ? 1 : 0")) break;
    await sleep(250);
  }

  const out = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const res = {};
    const state = () => ({ hidden: $('btn-terminals').classList.contains('hidden'), count: $('terminals-count').textContent });
    res.initial = state();
    handleEvent({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 't1', args: { command: 'sleep 100 && cd /srv/pi-agent-webui && ./verify-matrix.sh --with-a-really-long-argument-list' } });
    handleEvent({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 't2', args: { command: 'tail -f big.log' } });
    res.two = state();
    openTerminalsMenu();
    await new Promise((r) => setTimeout(r, 300));
    const rows = [...document.querySelectorAll('.model-menu .model-item')].map((r) => ({
      text: r.textContent.trim().slice(0, 70),
      close: (r.querySelector('[data-close-terminal]') || {}).dataset ? r.querySelector('[data-close-terminal]').dataset.closeTerminal : null,
    }));
    res.rows = rows;
    // Clicking a row expands it (issue #139) instead of closing it, and the
    // collapsed preview carries a live elapsed.
    const firstRow = document.querySelector('.model-menu .model-item');
    firstRow.click();
    await new Promise((r) => setTimeout(r, 300));
    res.menuStillOpen = !!document.querySelector('.model-menu .model-item');
    const expanded = [...document.querySelectorAll('.model-menu .model-item')].map((r) => r.textContent.trim());
    res.expanded = expanded.some((t) => /sleep 100/.test(t) && /click to collapse/.test(t));
    /* Issue #158: the expanded command has to show in full (it wraps), the
     * collapsed preview stays a one-line ellipsis, the list may grow past the
     * model picker's cap, and commands are set in the mono face. */
    /* The *visible* one: closing a menu leaves its element hidden in the DOM,
     * so the first .model-menu is not necessarily the one on screen. */
    const menuEl = document.querySelector('.model-menu:not(.hidden)');
    const listEl = menuEl && menuEl.querySelector('.model-list');
    const expRow = document.querySelector('.model-menu .model-item.term-expanded');
    const colRow = document.querySelector('.model-menu .model-item.term-collapsed');
    res.style = {
      cls: menuEl ? menuEl.className : null,
      listMax: listEl ? getComputedStyle(listEl).maxHeight : null,
      vh: window.innerHeight,
      expWhite: expRow ? getComputedStyle(expRow.querySelector('.model-label')).whiteSpace : null,
      expFont: expRow ? getComputedStyle(expRow.querySelector('.model-label')).fontFamily : null,
      colWhite: colRow ? getComputedStyle(colRow.querySelector('.model-label')).whiteSpace : null,
      expText: expRow ? expRow.querySelector('.model-label').textContent : null,
      colText: colRow ? colRow.querySelector('.model-label').textContent : null,
    };
    const before = expanded.join(' ');
    await new Promise((r) => setTimeout(r, 1500));
    const after = [...document.querySelectorAll('.model-menu .model-item')].map((r) => r.textContent.trim()).join(' ');
    res.ticked = before !== after;
    // close the first one: rpc is captured
    const real = window.rpc;
    window.__rpc = [];
    window.rpc = (m, t) => { window.__rpc.push(m && m.type); return real(m, t); };
    const btn = document.querySelector('[data-close-terminal="t1"]');
    if (btn) btn.click();
    await new Promise((r) => setTimeout(r, 300));
    res.afterClose = state();
    res.rpc = window.__rpc.slice();
    window.rpc = real;
    handleEvent({ type: 'tool_execution_end', toolName: 'bash', toolCallId: 't2' });
    res.afterEnd = state();
    closeAllMenus();
    return res;
  })()))()`));

  if (!out.initial.hidden) fail('the terminals button is visible with nothing running: ' + JSON.stringify(out.initial));
  if (out.two.hidden || out.two.count !== '2') fail('the button did not show two terminals: ' + JSON.stringify(out.two));
  if (!out.rows.some((r) => /sleep 100/.test(r.text)) || !out.rows.some((r) => /tail -f big\.log/.test(r.text))) {
    fail('the menu does not list both commands: ' + JSON.stringify(out.rows));
  }
  if (!out.rows.some((r) => /\d+s · /.test(r.text))) fail('the preview has no live elapsed: ' + JSON.stringify(out.rows));
  if (!out.menuStillOpen) fail('clicking a terminal closed the menu');
  if (!out.expanded) fail('clicking a terminal did not expand it: ' + JSON.stringify(out));
  if (!out.style || !/menu-terminals/.test(out.style.cls || "")) fail("the terminals menu does not carry its own class: " + JSON.stringify(out.style));
  /* the model picker's list is capped at 46vh; this one has to be able to grow
   * past that (72vh), whatever the window is */
  if (parseFloat(out.style.listMax) < 0.7 * out.style.vh) fail(`the terminals list still stops at the model picker height (${out.style.listMax} of a ${out.style.vh}px window) - the panel cannot extend`);
  if (out.style.expWhite !== 'normal') fail('an expanded command still truncates (white-space: ' + out.style.expWhite + ')');
  if (out.style.colWhite !== 'nowrap') fail('a collapsed preview should stay on one line (white-space: ' + out.style.colWhite + ')');
  if (/…/.test(out.style.expText || '')) fail('the expanded command is still ellipsized: ' + out.style.expText);
  if (!/mono/i.test(out.style.expFont || '')) fail('terminal commands are not set in the mono face: ' + out.style.expFont);
  if (!out.ticked) fail('the elapsed did not tick while the menu was open');
  if (!out.rpc.includes('abort_bash')) fail('closing a terminal did not send abort_bash: ' + JSON.stringify(out.rpc));
  if (out.afterClose.count !== '1') fail('closing one did not drop the count to 1: ' + JSON.stringify(out.afterClose));
  if (!out.afterEnd.hidden || out.afterEnd.count !== '0') fail('the button did not hide after the last end: ' + JSON.stringify(out.afterEnd));
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));

  console.log(`  terminals: 2 running -> ${JSON.stringify(out.two)}, rows ${out.rows.length}, close sent ${JSON.stringify(out.rpc)}, after end ${JSON.stringify(out.afterEnd)}`);
  console.log('  PASS #124 the terminals button counts the running bash tools and can close them');
  cleanupBrowser();
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
