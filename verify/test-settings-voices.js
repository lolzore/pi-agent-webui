/*
 * Issue #150, the real cause: "settings menu takes 2 seconds to appear".
 *
 * speechSynthesis.getVoices() can block for a second or more the first time a
 * page calls it - Firefox starts its speech service there - and openSettings()
 * called it twice (the select's list and the current voice) *before*
 * showModal(). The dialog therefore waited on the speech service, which is what
 * the reporter's "2 seconds" was (the Chromium measurements that said 20ms
 * never saw it because Chromium's getVoices is instant).
 *
 * The test injects a slow getVoices before the page's own scripts run, so the
 * very first call (the boot warm-up) is the slow one, and then asserts that the
 * settings click still reaches its first frame promptly - the list is cached and
 * fetched after paint, never on the click.
 *
 * Usage: node test-settings-voices.js <browserPath>
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
const PORT = 25800 + (process.pid % 200);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-voices-'));
fs.mkdirSync(path.join(scratch, 'agent'), { recursive: true });
fs.mkdirSync(path.join(scratch, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'webui.json'), JSON.stringify({ onboarded: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bridge = null;
const cleanup = () => { try { if (bridge) bridge.kill(); } catch { /* gone */ } try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ } };
process.on('exit', cleanup);
const getJson = (p) => new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej); });
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
  let err = ''; bridge.stderr.on('data', (c) => { err += c; });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const d = await getJson('/api/health'); if (d && d.ok) { up = true; break; } } catch { /* not yet */ } await sleep(200); }
  if (!up) fail('bridge never came up\n' + err.slice(-400));
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-voices-browser-'));
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
  // the slow speech service, installed before any page script runs
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const real = speechSynthesis.getVoices.bind(speechSynthesis);
    window.__voiceCalls = 0;
    speechSynthesis.getVoices = function () {
      const t0 = performance.now();
      while (performance.now() - t0 < 1200) { /* the speech service starting */ }
      window.__voiceCalls++;
      return real();
    };
  })();` });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 120; i++) {
    if (await evalJs("typeof openSettings === 'function' && (S.historyRender || 0) > 0 ? 1 : 0")) break;
    await sleep(250);
  }
  await sleep(3000);   // let the boot warm-up (a slow one) finish
  const out = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const d = document.getElementById('settings-dialog');
    const t0 = performance.now();
    openSettings();
    const sync = Math.round(performance.now() - t0);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const paint = Math.round(performance.now() - t0);
    const callsAfterOpen = window.__voiceCalls;
    // closing must not wait for the speech service either
    const c0 = performance.now();
    d.close();
    const closeMs = Math.round(performance.now() - c0);
    // the voices are fetched when the reader opens the dropdown, not before
    openSettings();
    await new Promise((r) => setTimeout(r, 80));
    const sel = document.getElementById('set-tts-voice');
    const btn = sel.parentElement.querySelector('button.pretty-select');
    const b0 = performance.now();
    btn.click();
    const clickMs = Math.round(performance.now() - b0);
    await new Promise((r) => setTimeout(r, 1800));
    const callsAfterDropdown = window.__voiceCalls;
    return { sync, paint, open: d.open, openMs: S.settingsOpenMs, closeMs, clickMs, callsAfterOpen, callsAfterDropdown, menuOpen: !!document.querySelector('.model-menu') };
  })()))()`));

  if (!out.open) fail('the dialog did not open');
  if (out.sync > 150) fail(`the settings click waited ${out.sync}ms on the speech service - opening the dialog must not touch it`);
  if (out.paint > 400) fail(`the dialog reached its first frame after ${out.paint}ms`);
  if (out.callsAfterOpen !== 0) fail(`opening the dialog fetched the voice list (${out.callsAfterOpen} call(s)) - it must wait until the dropdown is opened`);
  if (out.closeMs > 100) fail(`closing the dialog took ${out.closeMs}ms - the speech service was still being fetched`);
  if (out.clickMs > 150) fail(`opening the voice dropdown blocked for ${out.clickMs}ms - it must show its note and fetch behind it`);
  if (out.callsAfterDropdown < 1) fail('opening the voice dropdown never fetched the voice list');
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));
  console.log(`  slow getVoices (1200ms each): open ${out.sync}ms (${out.callsAfterOpen} calls), close ${out.closeMs}ms, dropdown click ${out.clickMs}ms then ${out.callsAfterDropdown} call(s)`);
  console.log('  PASS #150 the voice list loads when its dropdown is opened, never with the dialog');
  cleanupBrowser(); cleanup(); process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
