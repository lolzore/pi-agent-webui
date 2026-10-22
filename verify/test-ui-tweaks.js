/*
 * Four small requests from the same round of feedback:
 *
 *  1. the pi location sits at the very bottom of General (it was at the top)
 *  2. the Shorts tab no longer offers "Open with" - the choice is gone
 *  3. the whole Shorts tab only exists in the desktop (Electron) app
 *  4. the timers are whole seconds ("total 16s", not "total 15.6s")
 *
 * Usage: node test-ui-tweaks.js <browserPath>
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
const PORT = 27300 + (process.pid % 200);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-tweaks-'));
fs.mkdirSync(path.join(scratch, 'agent'), { recursive: true });
fs.mkdirSync(path.join(scratch, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'webui.json'), JSON.stringify({ onboarded: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bridge = null;
const cleanup = () => { try { if (bridge) bridge.kill(); } catch { /* gone */ } try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ } };
process.on('exit', cleanup);
(async () => {
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: path.join(scratch, 'agent'), PI_CODING_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_SESSION_DIR: path.join(scratch, 'sessions'), WORKSPACE_DIR: scratch,
      PI_SESSION_DIR: path.join(scratch, 'sessions'), PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'),
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_LLAMA_SCAN: 'off', PORT: String(PORT),
    }), stdio: ['ignore', 'ignore', 'pipe'],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { await new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: PORT, path: '/api/health' }, (r) => { r.resume(); r.on('end', res); }).on('error', rej); }); up = true; break; } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('bridge never came up');
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-tweaks-b-'));
  const launched = require('./ws-min.js').launchBrowser(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--window-size=1280,800', '--user-data-dir=' + userDir, 'about:blank']);
  const child = launched.child;
  const cleanupBrowser = () => { try { child.kill(); } catch { /* gone */ } try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ } };
  process.on('exit', cleanupBrowser);
  let DBG = 0; try { DBG = await launched.port; } catch (e) { fail(e.message); }
  let page = null;
  for (let i = 0; i < 100; i++) {
    try { const list = await new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: DBG, path: '/json/list' }, (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej); }); page = (list || []).find((t) => t.type === 'page'); if (page) break; } catch { /* not ready */ }
    await sleep(150);
  }
  if (!page) fail('browser never exposed a page');
  const WS = require('./ws-min.js');
  const ws = new WS(page.webSocketDebuggerUrl); await ws.open();
  let id = 0; const pending = new Map(); const problems = [];
  ws.onmessage = (raw) => { let m; try { m = JSON.parse(raw); } catch { return; } if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; } if (m.method === 'Runtime.exceptionThrown') { const e = m.params.exceptionDetails || {}; problems.push(((e.exception && (e.exception.description || e.exception.value)) || e.text || '?')); } };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw'); return r.result && r.result.result ? r.result.result.value : undefined; };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 160; i++) {
    if (await evalJs("typeof openSettings === 'function' && typeof fmtElapsed === 'function' && typeof S === 'object' && (S.historyRender || 0) > 0 ? 1 : 0")) break;
    await sleep(250);
  }
  const out = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const res = {};
    openSettings();
    await new Promise((r) => setTimeout(r, 300));
    const general = document.getElementById('tab-general');
    const controls = [...general.querySelectorAll('input,select,button')].map((el) => el.id).filter(Boolean);
    res.piIndex = controls.indexOf('set-pi-source');
    res.lastIndex = controls.length - 1;
    /* the row's last control: the container picker sits after the source one */
    res.piIsLast = controls[controls.length - 1] === 'set-pi-container';
    res.piAfterCursor = controls.indexOf('set-pi-source') > controls.indexOf('set-cursor-hot-y');
    res.modeGone = !document.getElementById('set-shorts-mode');
    const shorts = document.getElementById('tab-shorts');
    res.shortsProvider = !!document.getElementById('set-shorts-provider');
    res.shortsAuto = !!document.getElementById('set-shorts-auto');
    // a plain browser: the tab is not offered
    const tab = document.querySelector('#settings-tabs .tab[data-tab="shorts"]');
    res.browserTabHidden = tab.classList.contains('hidden');
    res.browserPanelHidden = shorts.classList.contains('hidden');
    /* ...and neither is the Reels button in the top bar, nor the setup
     * screen's feed row: the pane behind them is the app's. */
    applySettings();
    const reels = document.getElementById('btn-reels');
    res.browserReelsHidden = reels.classList.contains('hidden');
    reels.click();
    await new Promise((r) => setTimeout(r, 200));
    res.browserReelsStaysClosed = document.getElementById('reels-panel').classList.contains('hidden');
    res.browserSetupFeedHidden = document.getElementById('setup-shorts-provider').classList.contains('hidden');
    // the desktop app: the same page, an Electron user agent
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) PiAgent/0.1.3 Chrome/126.0.0.0 Electron/44.9.0 Safari/537.36', configurable: true });
    openSettings();
    await new Promise((r) => setTimeout(r, 200));
    res.electronTabShown = !tab.classList.contains('hidden');
    tab.click();
    await new Promise((r) => setTimeout(r, 100));
    res.electronPanelShown = !shorts.classList.contains('hidden');
    applySettings();
    res.electronReelsShown = !reels.classList.contains('hidden');
    res.electronSetupFeedShown = !document.getElementById('setup-shorts-provider').classList.contains('hidden');
    reels.click();
    await new Promise((r) => setTimeout(r, 300));
    res.electronReelsOpens = !document.getElementById('reels-panel').classList.contains('hidden');
    res.elapsed = [fmtElapsed(600), fmtElapsed(15600), fmtElapsed(59000), fmtElapsed(60000), fmtElapsed(125000), fmtElapsed(3720000)];
    return res;
  })()))()`));
  if (!out.piIsLast) fail(`the pi location is not the last row of General (index ${out.piIndex} of ${out.lastIndex}): ` + JSON.stringify(out));
  if (!out.piAfterCursor) fail('the pi location is not in General (it must come after that tab\'s own rows, not the cursor ones): ' + JSON.stringify(out));
  if (!out.modeGone) fail('the "Open with" choice is still there');
  if (!out.shortsProvider || !out.shortsAuto) fail('removing "Open with" took the rest of the tab with it: ' + JSON.stringify(out));
  if (!out.browserTabHidden || !out.browserPanelHidden) fail('the Shorts tab is offered in a plain browser: ' + JSON.stringify(out));
  if (!out.electronTabShown || !out.electronPanelShown) fail('the Shorts tab is not offered in the desktop app: ' + JSON.stringify(out));
  if (!out.browserReelsHidden) fail('the Reels button is still in the browser\'s top bar: ' + JSON.stringify(out));
  if (!out.browserReelsStaysClosed) fail('the Reels button opened the panel in a browser: ' + JSON.stringify(out));
  if (!out.browserSetupFeedHidden) fail('the setup screen still asks for a shorts feed in a browser: ' + JSON.stringify(out));
  if (!out.electronReelsShown) fail('the Reels button is missing in the desktop app: ' + JSON.stringify(out));
  if (!out.electronSetupFeedShown) fail('the desktop app\'s setup screen lost its shorts row: ' + JSON.stringify(out));
  if (!out.electronReelsOpens) fail('the Reels button does not open the panel in the desktop app: ' + JSON.stringify(out));
  if (out.elapsed.some((t) => /\\./.test(t))) fail('a timer still shows a decimal: ' + JSON.stringify(out.elapsed));
  if (problems.length) fail('the page reported errors:\n' + problems.join('\\n'));
  console.log(`  General: pi location is the last row; "Open with" gone; Shorts tab hidden in the browser, shown with Electron; timers ${out.elapsed.join(' / ')}`);
  console.log('  PASS the General/Shorts/timer tweaks behave as asked');
  cleanupBrowser(); cleanup(); process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
