/*
 * Issue #105: "Settings broken, too much empty space."
 *
 * The settings grid placed its children by alternation (label, control, label,
 * control…). #56 added the `pi auto-compaction` check-label directly after
 * `auto-continue`, with no label between them, so from that row on every
 * check-label landed in the 110px label column - the text wrapped into a strip
 * and the right half of the dialog sat empty. The grid now pins the columns:
 * labels are column 1, everything they control (check-labels included) is
 * column 2, and a row without a label leaves column 1 empty.
 *
 * This runs its own bridge and checks every tab at the dialog's two layouts:
 * two columns at 1200px (labels in the label column, controls full width of the
 * control column, no check-label squeezed) and one full-width column at 525px.
 *
 * Usage: node test-settings-grid.js <browserPath> [screenshotPath]
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const browser = process.argv[2];
const shotPath = process.argv[3] || '/tmp/105-settings-grid.png';
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const ROOT = path.resolve(__dirname, '..');
const PORT = 22600 + (process.pid % 300);
const DBG_PORT_FALLBACK = 0;   // real value comes from the browser's DevTools line
let DBG_PORT = 0;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-grid-'));
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

// The measurement, run inside the page for one viewport: every visible
// settings-grid child, with its column and width.
const MEASURE = `(() => {
  const out = [];
  for (const grid of document.querySelectorAll('#settings-dialog .settings-grid')) {
    const panel = grid.closest('.tab-panel');
    if (!panel || panel.classList.contains('hidden')) continue;
    const g = grid.getBoundingClientRect();
    const cs = getComputedStyle(grid);
    const kids = [...grid.children].map((k) => {
      const b = k.getBoundingClientRect();
      return { tag: k.tagName, cls: k.className, text: (k.textContent || '').trim().slice(0, 44), x: Math.round(b.x), w: Math.round(b.width), h: Math.round(b.height) };
    }).filter((k) => k.h > 0);
    out.push({ tab: panel.id, tracks: cs.gridTemplateColumns.split(/\\s+/).length, columns: cs.gridTemplateColumns, gx: Math.round(g.x), gw: Math.round(g.width), kids });
  }
  return JSON.stringify(out);
})()`;

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
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-grid-browser-'));
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

  /* Same guard as the other tests: /json/list can lag /json/version. */
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

  const measureAllTabs = async () => {
    // Open Settings, then visit every tab so each panel is measured while shown.
    await evalJs("(async () => { openSettings(); await new Promise((r) => setTimeout(r, 500)); return true; })()");
    const tabs = await evalJs("[...document.querySelectorAll('#settings-tabs .tab')].map((t) => t.textContent.trim())");
    const out = [];
    for (const label of tabs) {
      await evalJs(`(async () => {
        const t = [...document.querySelectorAll('#settings-tabs .tab')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
        if (t) t.click();
        await new Promise((r) => setTimeout(r, 250));
        return true;
      })()`);
      const m = JSON.parse(await evalJs(MEASURE));
      for (const panel of m) out.push({ ...panel, tab: label });
    }
    return out;
  };

  /* ── 1200px: two columns, pinned ───────────────────────────────────── */
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 100; i++) {
    if (await evalJs("typeof openSettings === 'function' ? 1 : 0")) break;
    await sleep(250);
  }
  const wide = await measureAllTabs();
  if (!wide.length) fail('no visible settings grid found at 1200px');
  for (const panel of wide) {
    if (panel.tracks !== 2) fail(`${panel.tab}: expected two columns at 1200px, got ${panel.columns}`);
    const labelX = Math.min(...panel.kids.map((k) => k.x));
    const controlX = Math.max(...panel.kids.map((k) => k.x));
    if (controlX === labelX) fail(`${panel.tab}: every row is in one column: ${JSON.stringify(panel.kids.slice(0, 6))}`);
    for (const k of panel.kids) {
      const isSectionLabel = k.tag === 'LABEL' && !/check-label/.test(k.cls);
      if (isSectionLabel) {
        if (k.x !== labelX) fail(`${panel.tab}: "${k.text}" is a section label but sits at x=${k.x} (label column is ${labelX})`);
      } else {
        if (k.x !== controlX) fail(`${panel.tab}: "${k.text}" is a control but sits at x=${k.x} (control column is ${controlX})`);
        if (k.w < 200) fail(`${panel.tab}: "${k.text}" is only ${k.w}px wide - it landed in the label column`);
      }
    }
  }
  // The row from the screenshot, specifically (a tab can hold several grids).
  const compaction = wide.filter((p) => p.tab === 'General').flatMap((p) => p.kids).find((k) => /pi auto-compaction/.test(k.text));
  if (!compaction) fail('the pi auto-compaction row is not in the General tab');
  if (compaction.w < 200) fail(`pi auto-compaction is ${compaction.w}px wide - the #105 bug is back`);
  console.log(`  1200px: ${wide.length} grids, ${wide.reduce((n, p) => n + p.kids.length, 0)} rows - labels col 1, controls col 2, pi auto-compaction ${compaction.w}px`);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'));
  console.log('  screenshot:', shotPath);

  /* ── 525px: one full-width column ──────────────────────────────────── */
  await send('Emulation.setDeviceMetricsOverride', { width: 525, height: 700, deviceScaleFactor: 1, mobile: false });
  await evalJs("document.getElementById('settings-dialog').close(); true");
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 100; i++) {
    if (await evalJs("typeof openSettings === 'function' ? 1 : 0")) break;
    await sleep(250);
  }
  const narrow = await measureAllTabs();
  for (const panel of narrow) {
    if (panel.tracks !== 1) fail(`${panel.tab}: expected one column at 525px, got ${panel.columns}`);
    for (const k of panel.kids) {
      if (k.w < 300) fail(`${panel.tab}: "${k.text}" is only ${k.w}px wide at 525px - it is in a squeezed column`);
    }
  }
  console.log(`  525px: ${narrow.length} grids, every row full width`);

  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));
  console.log('  PASS #105 settings rows are pinned to their columns at both widths');
  cleanupBrowser();
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
