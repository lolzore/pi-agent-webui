/*
 * Which part of openSettings() is slow? Issue #45.
 *
 * The Firefox/Chromium profile attached to the issue shows openSettings itself at
 * 284.8 ms with a 67.6 ms UpdateLayoutTree at the showModal() line, and 4,242 tiny
 * tasks inside one 305 ms input event. A measurement against an empty fixture said
 * 4-13 ms, so the cost scales with something the fixture does not have.
 *
 * openSettings() calls its helpers by name, so each one can be replaced with a
 * no-op before opening the dialog - the global is resolved at call time. Each
 * variant gets a fresh page, because the whole point is that the first open is the
 * expensive one.
 *
 * Usage: node probe-settings-open.js <baseUrl> <browserPath>
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = process.argv[2];
const browser = process.argv[3];
if (!base || !browser) { console.error('usage: node probe-settings-open.js <baseUrl> <browserPath>'); process.exit(2); }

const PORT = 9920 + (process.pid % 40);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-settings-open-'));
const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDir,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const cleanup = () => {
  try { child.kill(); } catch { /* gone */ }
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

(async () => {
  let ver = null;
  for (let i = 0; i < 100; i++) { try { ver = await getJson('/json/version'); break; } catch { await sleep(150); } }
  if (!ver) { console.error('browser never came up'); process.exit(1); }

  const WS = require('./ws-min.js');
  const page = (await getJson('/json/list')).find((t) => t.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.open();
  let id = 0; const pending = new Map();
  ws.onmessage = (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw');
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const jsonAsync = async (expr) => JSON.parse(await evalJs(`(async () => JSON.stringify(await (${expr})))()`));

  await send('Runtime.enable');
  await send('Page.enable');

  const settle = async (ms) => { await sleep(ms || 3000); };

  const variant = async (label, stub) => {
    await send('Page.navigate', { url: base + '/' });
    await settle(3200);
    const out = await jsonAsync(`(async () => {
      // The dialog must never have been opened on this page.
      const wasOpen = $('settings-dialog').open;
      ${stub}
      const t0 = performance.now();
      openSettings();
      const total = performance.now() - t0;
      // and the individual helpers, second time round (cheap on their own)
      const time = (fn) => { const a = performance.now(); try { fn(); } catch (e) { return 'err:' + e.message; } return performance.now() - a; };
      const parts = {
        populateTtsVoiceSelect: time(populateTtsVoiceSelect),
        prettifySettingsSelects: time(prettifySettingsSelects),
        loadPiProviders: time(loadPiProviders),
        loadAuthProviders: time(loadAuthProviders),
      };
      const fonts = $('font-list') ? $('font-list').childElementCount : -1;
      $('settings-dialog').close();
      return { wasOpen, total: +total.toFixed(1), parts, fonts, selects: $('settings-dialog').querySelectorAll('select').length };
    })()`);
    console.log(`  ${label.padEnd(34)} openSettings ${String(out.total).padStart(7)} ms   fonts=${out.fonts} selects=${out.selects}`);
    return out;
  };

  console.log('\n  first open, fresh page each time:');
  const base_ = await variant('baseline', '');
  const noTts = await variant('without populateTtsVoiceSelect', 'populateTtsVoiceSelect = () => {};');
  const noPretty = await variant('without prettifySettingsSelects', 'prettifySettingsSelects = () => {};');
  const noProv = await variant('without loadPi/AuthProviders', 'loadPiProviders = () => {}; loadAuthProviders = () => {};');
  const none = await variant('without all four', 'populateTtsVoiceSelect = () => {}; prettifySettingsSelects = () => {}; loadPiProviders = () => {}; loadAuthProviders = () => {};');

  console.log('\n  second open in the same page (what "switching a tab and back" skips):');
  await send('Page.navigate', { url: base + '/' });
  await settle(3200);
  const twice = await jsonAsync(`(async () => {
    const t = () => { const a = performance.now(); openSettings(); $('settings-dialog').close(); return performance.now() - a; };
    const first = t(); const second = t(); const third = t();
    return { first: first.toFixed(1), second: second.toFixed(1), third: third.toFixed(1) };
  })()`);
  console.log('  open1 ' + twice.first + ' ms, open2 ' + twice.second + ' ms, open3 ' + twice.third + ' ms');

  console.log('\n  ── attribution ──');
  const d = (a, b) => (a - b).toFixed(1);
  console.log('    baseline                          : ' + base_.total + ' ms');
  console.log('    minus prettifySettingsSelects      : ' + noPretty.total + ' ms  (saves ' + d(base_.total, noPretty.total) + ')');
  console.log('    minus populateTtsVoiceSelect       : ' + noTts.total + ' ms  (saves ' + d(base_.total, noTts.total) + ')');
  console.log('    minus providers                    : ' + noProv.total + ' ms  (saves ' + d(base_.total, noProv.total) + ')');
  console.log('    minus all four                     : ' + none.total + ' ms');
  console.log('    second open in the same page       : ' + twice.second + ' ms');
  ws.close(); cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); console.error('probe failed: ' + (e && e.stack || e)); process.exit(1); });
