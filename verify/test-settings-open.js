/*
 * Issue #45: "when opening the settings menu the very first scroll bar there is
 * lagging ... switching to another tab and switching back will fix the issue ...
 * this only appears the first load after that it is fine".
 *
 * The profile attached to the issue shows openSettings() itself at 284.8 ms with a
 * 67.6 ms UpdateLayoutTree at the showModal() line - but not what inside it costs
 * that, and I could not reproduce the 285 ms with a fresh browser profile, so the
 * whole fix is not claimed here. See verify/probe-settings-open.js for the
 * measurements that were possible.
 *
 * This checks the one piece of work that had no reason to be in the open path: the
 * system font list. It is 295 options on this machine, they live in a hidden panel
 * nothing can see until the font picker drops down, and they were being built into
 * the dialog on its first open - during the layout the issue is about.
 *
 * It must still work: focusing the font box has to build the list.
 *
 * Usage: node test-settings-open.js <baseUrl> <browserPath>
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = process.argv[2];
const browser = process.argv[3];
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (!base) { console.error('usage: node test-settings-open.js <baseUrl> <browserPath>'); process.exit(2); }
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const PORT = 9985 + (process.pid % 14);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-settings-'));
const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDir,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', (c) => { stderr += c; });
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
  if (!ver) fail('browser never came up\n' + stderr.slice(-400));

  const WS = require('./ws-min.js');
  const page = (await getJson('/json/list')).find((t) => t.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.open();
  let id = 0; const pending = new Map();
  const problems = [];
  ws.onmessage = (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      problems.push(((d.exception && (d.exception.description || d.exception.value)) || d.text || '?'));
    }
  };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw');
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: base + '/' });
  await sleep(3000);
  for (let i = 0; i < 60; i++) {
    if (await evalJs("typeof openSettings === 'function' && typeof loadSystemFonts === 'function' ? 1 : 0")) break;
    await sleep(250);
  }

  const out = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const rows = { available: 0 };
    try { rows.available = ((await (await fetch(api('/api/system-fonts'))).json()).fonts || []).length; } catch {}
    openSettings();
    await new Promise((r) => setTimeout(r, 2500));
    rows.afterOpen = $('font-list').childElementCount;
    rows.dialogOpen = $('settings-dialog').open;
    $('settings-dialog').close();
    // the box the list belongs to, used the way a person would
    $('set-font').dispatchEvent(new Event('focus'));
    await new Promise((r) => setTimeout(r, 2500));
    rows.afterFocus = $('font-list').childElementCount;
    return rows;
  })()))()`));

  console.log(`  bridge offers ${out.available} system font(s); dialog opened: ${out.dialogOpen}`);
  console.log(`  font-list options: ${out.afterOpen} right after opening, ${out.afterFocus} after using the font box`);
  if (out.available < 50) {
    console.log('  (this bridge reports few fonts, so the check cannot see the list at all - skipping)');
    process.exit(77);
  }
  if (!out.dialogOpen) fail('the settings dialog did not open');
  if (out.afterOpen !== 0) {
    fail(`${out.afterOpen} font options were built while the settings dialog opened - ` +
      'that is the work this check exists to keep out of the open path (issue #45)');
  }
  if (out.afterFocus < out.available) {
    fail(`using the font box built only ${out.afterFocus} of ${out.available} fonts - the list must still work`);
  }
  console.log('  PASS opening settings builds no font list, and the font box still gets one');
  if (problems.length) fail(problems.slice(0, 3).join(' | '));
  ws.close(); cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
