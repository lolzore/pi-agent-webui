/*
 * Issue #56 (pi compatibility): pi's own auto-compaction toggle.
 *
 * pi persists `compaction.enabled` in its settings.json and exposes
 * `set_auto_compaction` over RPC (1.0+). The WebUI's "auto-continue after
 * compaction" is its own feature and is separate from pi's own compaction, so
 * the two now sit next to each other with the pi one wired to the RPC. This
 * runs its own bridge and mock agent (which persists the setting the way pi
 * does) and checks the read-back both ways: bridge -> checkbox, RPC -> file.
 *
 * Usage: node test-pi-config.js <browserPath>
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
const PORT = 3089;
const DBG_PORT = 9420 + (process.pid % 200);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-piconfig-'));
const agentDir = path.join(scratch, 'agent');
const settingsPath = path.join(agentDir, 'settings.json');
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify({ compaction: { enabled: true } }, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bridge = null;
const cleanup = () => {
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);

const getJson = (port, p) => new Promise((res, rej) => {
  const req = http.get({ host: '127.0.0.1', port, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  });
  req.on('error', rej);
});

(async () => {
  const bridgeEnv = Object.assign({}, process.env, {
    // pi's own variable, not the bridge's: the bridge must read the same dir
    // pi loads from (issue #56).
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: path.join(scratch, 'sessions'),
    WORKSPACE_DIR: path.join(scratch, 'ws'),
    PI_SESSION_DIR: path.join(scratch, 'sessions'),
    PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
    PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'),
    PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
    PI_LLAMA_SCAN: 'off',
    PORT: String(PORT),
  });
  delete bridgeEnv.PI_AGENT_DIR;   // only pi's own name is set here
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], { env: bridgeEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  let bridgeErr = '';
  bridge.stderr.on('data', (c) => { bridgeErr += c; });
  for (const d of ['ws', 'sessions']) fs.mkdirSync(path.join(scratch, d), { recursive: true });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const d = await getJson(PORT, '/api/health'); if (d && d.ok) { up = true; break; } } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('the scratch bridge never came up\n' + bridgeErr.slice(-500));

  /* ── the bridge reads pi's file ───────────────────────────────────────── */
  const on = await getJson(PORT, '/api/pi-config');
  if (!on.ok || on.compaction.enabled !== true) fail('pi-config did not report enabled: ' + JSON.stringify(on));
  const ext = await getJson(PORT, '/api/pi-extensions');
  if (path.resolve(ext.agentDir || '') !== path.resolve(agentDir)) {
    fail('the bridge is not reading PI_CODING_AGENT_DIR: ' + ext.agentDir);
  }
  fs.writeFileSync(settingsPath, JSON.stringify({ compaction: { enabled: false } }, null, 2));
  const off = await getJson(PORT, '/api/pi-config');
  if (off.compaction.enabled !== false) fail('pi-config did not report disabled: ' + JSON.stringify(off));
  fs.writeFileSync(settingsPath, '{}');
  const dflt = await getJson(PORT, '/api/pi-config');
  if (dflt.compaction.enabled !== true) fail('pi-config did not default to enabled: ' + JSON.stringify(dflt));
  fs.writeFileSync(settingsPath, JSON.stringify({ compaction: { enabled: true } }, null, 2));
  console.log('  /api/pi-config reads pi\'s compaction.enabled (and defaults to on)');

  /* ── the checkbox: read-back, RPC, and the file pi would write ────────── */
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-piconfig-browser-'));
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--remote-debugging-port=' + DBG_PORT, '--user-data-dir=' + userDir,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let browserErr = '';
  child.stderr.on('data', (c) => { browserErr += c; });
  const cleanupBrowser = () => {
    try { child.kill(); } catch { /* gone */ }
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ }
  };
  process.on('exit', cleanupBrowser);
  let ver = null;
  for (let i = 0; i < 100; i++) { try { ver = await getJson(DBG_PORT, '/json/version'); break; } catch { await sleep(150); } }
  if (!ver) fail('browser never came up\n' + browserErr.slice(-400));

  const WS = require('./ws-min.js');
  const page = (await getJson(DBG_PORT, '/json/list')).find((t) => t.type === 'page');
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
  for (let i = 0; i < 100; i++) { if (await evalJs("typeof openSettings === 'function' && typeof rpc === 'function' ? 1 : 0")) break; await sleep(250); }
  await evalJs("document.querySelectorAll('dialog[open]').forEach((d) => { try { d.close(); } catch {} })");
  await evalJs("(() => { window.__rpcSent = []; const real = rpc; window.rpc = (m) => { if (m && m.type === 'set_auto_compaction') window.__rpcSent.push(m); return real(m); }; })()");

  const shown = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    openSettings();
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && $('set-pi-compaction').checked !== true) await new Promise((r) => setTimeout(r, 100));
    const before = { checked: $('set-pi-compaction').checked, disabled: $('set-pi-compaction').disabled };
    $('set-pi-compaction').checked = false;
    $('set-pi-compaction').dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const after = { checked: $('set-pi-compaction').checked, sent: window.__rpcSent.slice() };
    $('settings-dialog').close();
    openSettings();
    const t1 = Date.now();
    while (Date.now() - t1 < 5000 && $('set-pi-compaction').checked !== false) await new Promise((r) => setTimeout(r, 100));
    after.readBack = $('set-pi-compaction').checked;
    $('settings-dialog').close();
    return { before, after };
  })()))()`));
  console.log('  checkbox before:', JSON.stringify(shown.before), 'after unchecking:', JSON.stringify({ sent: shown.after.sent, readBack: shown.after.readBack }));

  if (shown.before.checked !== true || shown.before.disabled) fail('the checkbox did not load pi\'s current state: ' + JSON.stringify(shown.before));
  if (!shown.after.sent.some((m) => m.enabled === false)) fail('unchecking did not send set_auto_compaction(false): ' + JSON.stringify(shown.after.sent));
  const file = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (file.compaction.enabled !== false) fail('the mock (like pi) did not persist compaction.enabled=false: ' + JSON.stringify(file));
  if (shown.after.readBack !== false) fail('reopening the settings did not read the new state back: ' + shown.after.readBack);

  /* Issue #91: an old bridge has no /api/pi-config. The row must say what to do
   * instead of showing a checkbox that can neither read nor write. */
  const stale = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const real = window.fetch;
    window.fetch = (u, o) => String(u).includes('/api/pi-config')
      ? Promise.resolve(new Response('not found', { status: 404 }))
      : real(u, o);
    // What openSettings() runs when the dialog opens, awaited here so the
    // assertion cannot race a request from the scenario above.
    await loadPiConfig();
    const out = {
      disabled: $('set-pi-compaction').disabled,
      note: ($('set-pi-compaction-note') || {}).textContent || '',
    };
    window.fetch = real;
    return out;
  })()))()`));
  console.log('  without /api/pi-config:', JSON.stringify(stale));
  if (!stale.disabled) fail('an old bridge (no /api/pi-config) leaves the checkbox enabled');
  if (!/restart/i.test(stale.note)) fail('the row does not say what to do: ' + JSON.stringify(stale));

  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));

  console.log('  PASS #56 pi\'s auto-compaction is shown, changed over RPC, persisted and read back; an old bridge says so (#91)');
  cleanupBrowser();
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
