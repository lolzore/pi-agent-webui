/*
 * Issue #123: an empty browser in the split-screen pane, as an alternative to
 * the reels feeds.
 *
 * The pane's Browser tab shows a URL bar, back/forward/reload and an iframe,
 * with an "open in a tab" escape for sites that refuse to be embedded. This
 * runs its own bridge and loads a page from it (same origin, so the frame's
 * document is readable), then navigates and goes back.
 *
 * Usage: node test-browser-pane.js <browserPath>
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
const PORT = 24700 + (process.pid % 300);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-brpane-'));
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

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-brpane-browser-'));
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
    if (await evalJs("typeof setReelsFeed === 'function' && typeof toggleReelsPanel === 'function' ? 1 : 0")) break;
    await sleep(250);
  }

  const out = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const res = {};
    SET.shortsProvider = 'browser';
    toggleReelsPanel();
    await new Promise((r) => setTimeout(r, 300));
    res.browserShown = !$('reels-browser').classList.contains('hidden');
    res.videoHidden = $('reels-video').classList.contains('hidden');
    res.tabActive = !!document.querySelector('.rtab[data-feed="browser"].active');
    res.frameSrc = $('reels-frame').getAttribute('src');
    res.hasOpenTab = !!$('reels-open-tab');
    res.hasLinkRow = !!$('reels-link');
    res.hasFeedButton = !!$('btn-reels-feed');
    res.note = $('reels-browser-note') ? $('reels-browser-note').textContent : null;
    // load a page from this same bridge (same origin, so the frame is readable)
    const url = location.origin + '/';
    $('reels-url').value = url;
    $('reels-go').click();
    const t0 = Date.now();
    let loaded = false;
    while (Date.now() - t0 < 6000) {
      try { const d = $('reels-frame').contentDocument; if (d && d.querySelector('#composer')) { loaded = true; break; } } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    res.loaded = loaded;
    res.loadedUrl = $('reels-frame').contentWindow ? $('reels-frame').contentWindow.location.href : null;
    // navigate on, then back
    $('reels-url').value = location.origin + '/index.html';
    $('reels-go').click();
    await new Promise((r) => setTimeout(r, 800));
    res.second = $('reels-frame').getAttribute('src');
    $('reels-back').click();
    await new Promise((r) => setTimeout(r, 800));
    res.afterBack = $('reels-frame').getAttribute('src');
    res.remembered = SET.browserUrl || null;
    // Typing a plain search and pressing Enter goes through Google, not to
    // https://some+words.
    $('reels-url').value = 'pi agent project';
    $('reels-url').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    res.searchUrl = SET.browserUrl || null;
    $('reels-url').value = 'https://example.com/somewhere';
    // the native shell handoff: the URL goes to the shell, not the frame
    const realHost = window.webView2Host;
    window.__hostMsgs = [];
    window.webView2Host = () => ({ postMessage: (m) => window.__hostMsgs.push(m) });
    const frameBefore = $('reels-frame').getAttribute('src');
    reelsNavigate('https://example.com/somewhere');
    // A switch to the browser tab first closes the feed surface, so the handoff
    // is not necessarily the first message; find the browser open itself.
    res.hostMsg = window.__hostMsgs.find((m) => m.startsWith('piagent|browser|open|')) || null;
    res.frameUnchanged = $('reels-frame').getAttribute('src') === frameBefore;
    res.hostRemembered = SET.browserUrl || null;
    window.webView2Host = realHost;
    // reopening the pane restores the remembered URL
    $('reels-frame').removeAttribute('src');
    setReelsFeed('browser');
    res.restored = $('reels-frame').getAttribute('src');
    return res;
  })()))()`));

  if (!out.browserShown || !out.videoHidden) fail('the browser tab did not switch the pane: ' + JSON.stringify(out));
  if (!out.tabActive) fail('the browser tab is not marked active');
  if (out.frameSrc !== 'about:blank') fail('the pane did not start on a blank page: ' + JSON.stringify(out.frameSrc));
  if (out.hasOpenTab) fail('the open-in-a-tab control is still in the browser pane');
  if (out.hasLinkRow) fail('the paste-a-video-link row is still in the Reels pane');
  if (out.hasFeedButton) fail('the open-full-feed row is still in the Reels pane');
  if (out.note) fail('the X-Frame-Options note is still in the browser pane: ' + JSON.stringify(out.note));
  if (!out.loaded) fail('the pane did not render a page from the bridge: ' + JSON.stringify(out));
  if (!/^http:\/\/127\.0\.0\.1:/.test(out.loadedUrl || '')) fail('the frame is not on the bridge page: ' + JSON.stringify(out.loadedUrl));
  if (!/index\.html$/.test(out.second || '')) fail('navigating did not move the frame: ' + JSON.stringify(out.second));
  if (!/^http:\/\/127\.0\.0\.1:[0-9]+\/$/.test(out.afterBack || '')) fail('back did not return to the first page: ' + JSON.stringify(out.afterBack));
  if (!/^http:\/\/127\.0\.0\.1:/.test(out.remembered || '')) fail('the last visited URL was not remembered: ' + JSON.stringify(out.remembered));
  if (!/^https:\/\/www\.google\.com\/search\?q=pi%20agent%20project$/.test(out.searchUrl || '')) {
    fail('a plain search did not go through Google: ' + JSON.stringify(out.searchUrl));
  }
  if (!/^piagent\|browser\|open\|/.test(out.hostMsg || '') || !/example\.com/.test(out.hostMsg || '')) {
    fail('the native shell did not receive the URL: ' + JSON.stringify(out.hostMsg));
  }
  if (!out.frameUnchanged) fail('the iframe navigated even with a native shell present');
  if (!/example\.com/.test(out.hostRemembered || '')) fail('the handed-off URL was not remembered: ' + JSON.stringify(out.hostRemembered));
  if (!/example\.com/.test(out.restored || '')) fail('reopening the pane did not restore the remembered URL: ' + JSON.stringify(out.restored));
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));

  console.log(`  browser pane: blank start, loaded ${out.loadedUrl}, navigated to ${out.second}, back to ${out.afterBack}`);
  console.log('  PASS #123 the split pane hosts a browser that navigates and goes back');
  cleanupBrowser();
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
