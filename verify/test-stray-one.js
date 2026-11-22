/*
 * Issue #205: a stray "1" above the composer.
 *
 * The screenshot's mark sits where a status/widget bar puts a single line, and
 * the report calls it a 1. A bar whose entire content is one digit (or a bare
 * `|`) is a fragment of a count whose label never arrived, not a status; it now
 * renders as nothing. A real status with the digit in context still shows.
 *
 * Usage: node test-stray-one.js <baseUrl> <browserPath>
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
if (!base) { console.error('usage: node test-stray-one.js <baseUrl> <browserPath>'); process.exit(2); }
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const PORT = 9610 + (process.pid % 200);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-stray-'));
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
  await send('Page.navigate', { url: base + '/' });
  for (let i = 0; i < 120; i++) {
    if (await evalJs("typeof handleExtensionUi === 'function' && typeof setBarContent === 'function' ? 1 : 0")) break;
    await sleep(250);
  }
  await evalJs("document.querySelectorAll('dialog[open]').forEach((d) => { try { d.close(); } catch {} }); true");

  const out = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const bar = (id) => document.getElementById(id);
    const state = (id) => ({ hidden: bar(id).classList.contains('hidden'), text: bar(id).textContent.trim(), probe: bar(id).dataset.probe || '' });
    // The live bridge may already carry an extension status (MCP, a goal). Clear
    // every key so this check is about the probe status, not what is beside it.
    for (const id of ['status-bar', 'widget-bar']) {
      const b = bar(id);
      for (const k of Object.keys(b.dataset)) delete b.dataset[k];
      b.textContent = '';
    }
    handleExtensionUi({ method: 'setStatus', statusKey: 'probe', statusText: '1' });
    await sleep(120);
    const digit = state('status-bar');
    handleExtensionUi({ method: 'setStatus', statusKey: 'probe', statusText: '|' });
    await sleep(120);
    const pipe = state('status-bar');
    handleExtensionUi({ method: 'setStatus', statusKey: 'probe', statusText: '2 running' });
    await sleep(120);
    const real = state('status-bar');
    handleExtensionUi({ method: 'setStatus', statusKey: 'probe', statusText: '' });
    handleExtensionUi({ method: 'setWidget', widgetKey: 'probe', widgetLines: ['1'] });
    await sleep(120);
    const widget = state('widget-bar');
    handleExtensionUi({ method: 'setWidget', widgetKey: 'probe', widgetLines: ['1 widget running'] });
    await sleep(120);
    const realWidget = state('widget-bar');
    // The MCP row is a status; an extension widget above it can clear after a
    // steering/image send. Once the widget has stayed empty past its grace
    // period it must release its box, or the status row floats under a blank
    // strip for the rest of the turn.
    document.body.classList.add('run-active');
    handleExtensionUi({ method: 'setStatus', statusKey: 'mcp', statusText: 'MCP: 1 server enabled' });
    handleExtensionUi({ method: 'setWidget', widgetKey: 'probe', widgetLines: [] });
    await sleep(3300);
    const dock = document.getElementById('composer-dock').getBoundingClientRect();
    const widgetRect = document.getElementById('widget-bar').getBoundingClientRect();
    const statusRect = document.getElementById('status-bar').getBoundingClientRect();
    const composerRect = document.querySelector('.composer-row').getBoundingClientRect();
    document.body.classList.remove('run-active');
    const dockReset = { widgetHeight: widgetRect.height, statusBottom: statusRect.bottom, composerTop: composerRect.top, dockBottom: dock.bottom };
    return { digit, pipe, real, widget, realWidget, dockReset };
  })()))()`));

  if (out.digit.probe) fail('a bare "1" status is still stored: ' + JSON.stringify(out.digit));
  if (out.pipe.probe) fail('a bare "|" status is still stored: ' + JSON.stringify(out.pipe));
  if (!/2 running/.test(out.real.probe)) fail('a real status was hidden: ' + JSON.stringify(out.real));
  if (out.widget.probe) fail('a bare "1" widget is still stored: ' + JSON.stringify(out.widget));
  if (!/1 widget running/.test(out.realWidget.probe)) fail('a real widget was hidden: ' + JSON.stringify(out.realWidget));
  if (out.dockReset.widgetHeight !== 0) fail('an emptied widget bar keeps a blank reserved box while the MCP status is visible: ' + JSON.stringify(out.dockReset));
  if (out.dockReset.statusBottom > out.dockReset.composerTop + 1) fail('the MCP status row does not sit next to the composer after the widget clears: ' + JSON.stringify(out.dockReset));
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));

  console.log('  bare 1/| bars: dropped per key; "2 running"/"1 widget running": shown; an emptied widget releases its space');
  console.log('  PASS #205 a lone digit/pipe in a status or widget bar is not rendered as a stray glyph');
  ws.close(); cleanup(); process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
