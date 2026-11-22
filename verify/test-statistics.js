/*
 * Hidden /statistics tracker: fold model + usage records from every session.
 *
 * Two small sessions contain model_change entries and assistant usage; the
 * endpoint must attribute each usage to the model that produced it, total the
 * tokens and cost, and the full-screen dialog must render the table from that
 * endpoint without any header button.
 *
 * Usage: node test-statistics.js <browserPath>
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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-statistics-'));
const agentDir = path.join(scratch, 'agent');
const sessionDir = path.join(scratch, 'sessions');
const ws = path.join(scratch, 'ws');
for (const d of [agentDir, sessionDir, ws]) fs.mkdirSync(d, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeSession(name, id, rows) {
  const file = path.join(sessionDir, name);
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session', version: 3, id, cwd: ws }),
    ...rows.map((r) => JSON.stringify(r)),
  ].join('\n') + '\n');
  return file;
}
const usage = (provider, model, input, output, cacheRead = 0, reasoning = 0, cost = 0) => ({
  type: 'message',
  timestamp: '2026-01-01T00:00:00.000Z',
  message: { role: 'assistant', provider, model, usage: { input, output, cacheRead, cacheWrite: 0, reasoning, totalTokens: input + output + cacheRead, cost: { total: cost } } },
});
writeSession('2026-01-01T00-00-00-000Z_11111111-1111-1111-1111-111111111111.jsonl', '11111111-1111-1111-1111-111111111111', [
  { type: 'model_change', provider: 'alpha', modelId: 'model-a' },
  usage('alpha', 'model-a', 100, 20, 5, 2, 0.01),
  { type: 'model_change', provider: 'beta', modelId: 'model-b' },
  usage('beta', 'model-b', 50, 10, 0, 1, 0.02),
]);
writeSession('2026-01-02T00-00-00-000Z_22222222-2222-2222-2222-222222222222.jsonl', '22222222-2222-2222-2222-222222222222', [
  { type: 'model_change', provider: 'alpha', modelId: 'model-a' },
  usage('alpha', 'model-a', 30, 5, 0, 0, 0.005),
]);

let bridge = null;
const cleanup = () => {
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);
const getJson = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

(async () => {
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir, PI_SESSION_DIR: sessionDir,
      WORKSPACE_DIR: ws,
      PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'),
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_MOCK_SESSION_FILE: path.join(sessionDir, 'mock-session.jsonl'),
      PI_LLAMA_SCAN: 'off', PI_DOCKER: path.join(scratch, 'no-such-docker'),
      PORT: String(PORT),
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let berr = '';
  bridge.stderr.on('data', (c) => { berr += c; });
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { const d = await getJson(PORT, '/api/health'); if (d && d.ok) { up = true; break; } } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('the scratch bridge never came up\n' + berr.slice(-500));

  const d = await getJson(PORT, '/api/statistics');
  const byId = new Map((d.models || []).map((m) => [`${m.provider}/${m.model}`, m]));
  const a = byId.get('alpha/model-a');
  const b = byId.get('beta/model-b');
  console.log('  statistics:', JSON.stringify({ totals: d.totals, models: d.models && d.models.length }));
  if (!a || !b) fail('model totals are missing: ' + JSON.stringify(d.models));
  if (a.requests !== 2 || a.input !== 130 || a.output !== 25) fail('alpha totals are wrong: ' + JSON.stringify(a));
  if (b.requests !== 1 || b.input !== 50 || b.output !== 10) fail('beta totals are wrong: ' + JSON.stringify(b));
  if (d.totals.input !== 180 || d.totals.output !== 35 || d.totals.requests !== 3 || d.totals.sessions !== 2) {
    fail('overall totals are wrong: ' + JSON.stringify(d.totals));
  }

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-statistics-browser-'));
  const launched = require('./ws-min.js').launchBrowser(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--user-data-dir=' + userDir, 'about:blank',
  ]);
  const child = launched.child;
  const cleanupBrowser = () => {
    try { child.kill(); } catch { /* gone */ }
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ }
  };
  process.on('exit', cleanupBrowser);
  let dbg = 0;
  try { dbg = await launched.port; } catch (e) { fail(e.message); }
  let page = null;
  for (let i = 0; i < 100; i++) {
    try {
      const list = await getJson(dbg, '/json/list');
      if (Array.isArray(list)) { page = list.find((t) => t.type === 'page'); if (page) break; }
    } catch { /* not ready */ }
    await sleep(150);
  }
  if (!page) fail('browser never exposed a page');
  const WS = require('./ws-min.js');
  const wsClient = new WS(page.webSocketDebuggerUrl);
  await wsClient.open();
  let id = 0; const pending = new Map();
  wsClient.onmessage = (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); wsClient.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw');
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Runtime.enable'); await send('Page.enable');
  // A wide window proves the dialog grows with the viewport instead of being
  // stuck at one fixed width.
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 100; i++) {
    if (await evalJs("typeof openStatistics === 'function' ? 1 : 0")) break;
    await sleep(200);
  }
  const closedAtLoad = JSON.parse(await evalJs("(() => { const d = document.getElementById('statistics-dialog'); return JSON.stringify({ open: d.open, display: getComputedStyle(d).display }); })()"));
  if (closedAtLoad.open || closedAtLoad.display !== 'none') fail('the statistics dialog is visible before /statistics: ' + JSON.stringify(closedAtLoad));
  await evalJs('openStatistics(); true');
  let shown = null;
  for (let i = 0; i < 100; i++) {
    shown = await evalJs("JSON.stringify({open: document.getElementById('statistics-dialog').open, rows: document.querySelectorAll('#statistics-list tbody tr').length, text: document.getElementById('statistics-list').textContent})");
    if (shown && JSON.parse(shown).rows >= 3) break;
    await sleep(150);
  }
  const ui = JSON.parse(shown || '{}');
  console.log('  dialog:', JSON.stringify({ open: ui.open, rows: ui.rows }).slice(0, 140));
  if (!ui.open) fail('the statistics dialog did not open');
  const width = await evalJs("Math.round(document.getElementById('statistics-dialog').getBoundingClientRect().width)");
  if (!(width > 1000)) fail('the statistics dialog did not widen on a wide viewport: ' + width + 'px');
  if (ui.rows < 3) fail('the statistics table has no per-model rows: ' + JSON.stringify(ui));
  if (!/alpha/.test(ui.text) || !/model-a/.test(ui.text) || !/beta/.test(ui.text)) fail('the statistics table does not name the models: ' + ui.text);
  // The hidden view is reached by typing the command, not only by calling the
  // function behind it.
  await evalJs("document.getElementById('statistics-dialog').close(); input.value='/statistics'; sendCurrent(); true");
  let commandOpened = false;
  for (let i = 0; i < 100; i++) {
    commandOpened = await evalJs("document.getElementById('statistics-dialog').open");
    if (commandOpened) break;
    await sleep(150);
  }
  if (!commandOpened) fail('/statistics did not open the statistics dialog');
  console.log('  PASS /statistics renders per-model and overall token usage from all sessions');
  wsClient.close(); cleanupBrowser(); cleanup(); process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
