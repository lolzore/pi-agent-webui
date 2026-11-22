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
const postJson = (port, p, body) => new Promise((res, rej) => {
  const data = JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  });
  req.on('error', rej);
  req.end(data);
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

  /* Issue #194: the threshold is pi's compaction.reserveTokens. There is no RPC
   * for it, so the bridge writes the file pi reads. */
  const posted = await postJson(PORT, '/api/pi-config', { compaction: { reserveTokens: 48000 } });
  if (!posted.ok || posted.compaction.reserveTokens !== 48000) fail('POST /api/pi-config did not set reserveTokens: ' + JSON.stringify(posted));
  let thresholdFile = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (thresholdFile.compaction.reserveTokens !== 48000) fail('the threshold was not written to settings.json: ' + JSON.stringify(thresholdFile));
  const bad = await postJson(PORT, '/api/pi-config', { compaction: { reserveTokens: -1 } });
  if (bad.ok) fail('a negative threshold was accepted');
  thresholdFile = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (thresholdFile.compaction.reserveTokens !== 48000) fail('a refused threshold changed the file: ' + JSON.stringify(thresholdFile));
  await postJson(PORT, '/api/pi-config', { compaction: { reserveTokens: 16384 } });
  console.log('  /api/pi-config writes and validates compaction.reserveTokens');

  /* Issue #214: blocking images is pi's own images.blockImages, not a WebUI
   * display toggle. Same route, same validation and read-back. */
  const imgDefault = await getJson(PORT, '/api/pi-config');
  if (!imgDefault.images || imgDefault.images.blockImages !== false) fail('pi-config did not report images.blockImages=false by default: ' + JSON.stringify(imgDefault));
  const imgPosted = await postJson(PORT, '/api/pi-config', { images: { blockImages: true } });
  if (!imgPosted.ok || !imgPosted.images || imgPosted.images.blockImages !== true) fail('POST /api/pi-config did not set images.blockImages: ' + JSON.stringify(imgPosted));
  let imgFile = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (!imgFile.images || imgFile.images.blockImages !== true) fail('images.blockImages was not written to settings.json: ' + JSON.stringify(imgFile));
  const imgBad = await postJson(PORT, '/api/pi-config', { images: { blockImages: 'yes' } });
  if (imgBad.ok) fail('a non-boolean images.blockImages was accepted');
  imgFile = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (imgFile.images.blockImages !== true) fail('a refused image setting changed the file: ' + JSON.stringify(imgFile));
  console.log('  /api/pi-config writes and validates images.blockImages');

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

  /* Issue #194: the threshold slider reads, saves and reads back the same value.
   * The slider is now a sparse position list; the label is the actual tokens. */
  const threshold = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    openSettings();
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && !/16,384 tokens free/.test(($('set-pi-compaction-threshold-val') || {}).textContent || '')) await new Promise((r) => setTimeout(r, 100));
    const before = {
      value: $('set-pi-compaction-threshold').value,
      label: ($('set-pi-compaction-threshold-val') || {}).textContent || '',
      max: $('set-pi-compaction-threshold').max,
      disabled: $('set-pi-compaction-threshold').disabled,
    };
    const s = $('set-pi-compaction-threshold');
    s.value = '4';  // 32,768 in the sparse list
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    const after = { value: s.value, label: ($('set-pi-compaction-threshold-val') || {}).textContent || '', disabled: s.disabled };
    $('settings-dialog').close();
    openSettings();
    const t1 = Date.now();
    while (Date.now() - t1 < 5000 && !/32,768 tokens free/.test(($('set-pi-compaction-threshold-val') || {}).textContent || '')) await new Promise((r) => setTimeout(r, 100));
    const readBack = { value: $('set-pi-compaction-threshold').value, label: ($('set-pi-compaction-threshold-val') || {}).textContent || '' };
    $('settings-dialog').close();
    return { before, after, readBack };
  })()))()`));
  console.log('  threshold before:', JSON.stringify(threshold.before), 'after:', JSON.stringify(threshold.after), 'read back:', threshold.readBack);
  if (threshold.before.value !== '3' || threshold.before.disabled) fail('the sparse threshold slider did not load pi\'s reserveTokens: ' + JSON.stringify(threshold.before));
  if (threshold.before.max !== '9') fail('the threshold slider is not the sparse ten-position list: ' + JSON.stringify(threshold.before));
  if (!/16,384 tokens free/.test(threshold.before.label)) fail('the threshold label is wrong: ' + JSON.stringify(threshold.before.label));
  if (threshold.after.value !== '4' || !/32,768 tokens free/.test(threshold.after.label)) fail('the threshold slider did not update: ' + JSON.stringify(threshold.after));
  if (threshold.readBack.value !== '4' || !/32,768 tokens free/.test(threshold.readBack.label)) fail('the threshold did not survive reopening settings: ' + JSON.stringify(threshold.readBack));
  const thresholdSaved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (thresholdSaved.compaction.reserveTokens !== 32768) fail('the slider did not persist reserveTokens=32768: ' + JSON.stringify(thresholdSaved));

  /* Issue #212: the slider used to stop at 131,072, which read as pi's limit.
   * Exercise a value above that old ceiling, so a reintroduced cap fails here
   * instead of only being visible in the markup. */
  const big = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    openSettings();
    const s = $('set-pi-compaction-threshold');
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && !/32,768 tokens free/.test(($('set-pi-compaction-threshold-val') || {}).textContent || '')) await new Promise((r) => setTimeout(r, 100));
    const max = Number(s.max);
    s.value = '7';  // 262,144
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    const after = { value: s.value, label: ($('set-pi-compaction-threshold-val') || {}).textContent || '', max };
    $('settings-dialog').close();
    openSettings();
    const t1 = Date.now();
    while (Date.now() - t1 < 5000 && !/262,144 tokens free/.test(($('set-pi-compaction-threshold-val') || {}).textContent || '')) await new Promise((r) => setTimeout(r, 100));
    after.readBack = { value: $('set-pi-compaction-threshold').value, label: ($('set-pi-compaction-threshold-val') || {}).textContent || '' };
    $('settings-dialog').close();
    return after;
  })()))()`));
  console.log('  threshold above the old 131k ceiling:', JSON.stringify(big));
  if (Number(big.max) !== 9) fail('the threshold slider still stops at 131,072 (the ceiling from issue #212): max=' + big.max);
  if (big.value !== '7') fail('the sparse slider clamped a value above the old ceiling: ' + JSON.stringify(big));
  if (!/262,144 tokens free/.test(big.label)) fail('the label did not follow the bigger threshold: ' + big.label);
  if (big.readBack.value !== '7' || !/262,144 tokens free/.test(big.readBack.label)) fail('a threshold above 131k did not survive reopening settings: ' + JSON.stringify(big.readBack));
  const bigSaved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (bigSaved.compaction.reserveTokens !== 262144) fail('a threshold above 131k was not written to settings.json: ' + JSON.stringify(bigSaved));

  /* The label beside the slider is editable: click it, type an exact value the
   * sparse steps do not contain, press Enter, and read it back from pi's file. */
  const manualThreshold = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    openSettings();
    const label = $('set-pi-compaction-threshold-val');
    const manual = $('set-pi-compaction-threshold-manual');
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && label.classList.contains('hidden')) await new Promise((r) => setTimeout(r, 100));
    label.click();
    const opened = { manualVisible: !manual.classList.contains('hidden'), value: manual.value, focused: document.activeElement === manual };
    manual.value = '48000';
    manual.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    const after = { label: label.textContent, hidden: manual.classList.contains('hidden'), slider: $('set-pi-compaction-threshold').value };
    $('settings-dialog').close();
    openSettings();
    const t1 = Date.now();
    while (Date.now() - t1 < 5000 && !/48,000 tokens free/.test(label.textContent || '')) await new Promise((r) => setTimeout(r, 100));
    after.readBack = label.textContent;
    $('settings-dialog').close();
    return { opened, after };
  })()))()`));
  console.log('  manual threshold:', JSON.stringify(manualThreshold));
  if (!manualThreshold.opened.manualVisible || !manualThreshold.opened.focused || manualThreshold.opened.value !== '262144') {
    fail('clicking the threshold value did not open an editable exact field: ' + JSON.stringify(manualThreshold.opened));
  }
  if (!manualThreshold.after.hidden || !/48,000 tokens free/.test(manualThreshold.after.label) || manualThreshold.after.slider !== '4') {
    fail('a typed threshold did not update the label and nearest slider position: ' + JSON.stringify(manualThreshold.after));
  }
  if (!/48,000 tokens free/.test(manualThreshold.after.readBack || '')) fail('a typed threshold did not survive reopening settings: ' + JSON.stringify(manualThreshold.after));
  const manualSaved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (manualSaved.compaction.reserveTokens !== 48000) fail('the typed threshold was not written to settings.json: ' + JSON.stringify(manualSaved));
  await postJson(PORT, '/api/pi-config', { compaction: { reserveTokens: 16384 } });

  /* Issue #214: the row reads pi's setting, writes it, and reads it back; the
   * page has no image toggle of its own any more. */
  const imgRow = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    openSettings();
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && $('set-pi-block-images').checked !== true) await new Promise((r) => setTimeout(r, 100));
    const before = {
      checked: $('set-pi-block-images').checked,
      disabled: $('set-pi-block-images').disabled,
      own: !!document.getElementById('set-block-images'),
    };
    $('set-pi-block-images').checked = false;
    $('set-pi-block-images').dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    $('settings-dialog').close();
    openSettings();
    const t1 = Date.now();
    while (Date.now() - t1 < 5000 && $('set-pi-block-images').checked !== false) await new Promise((r) => setTimeout(r, 100));
    const after = { checked: $('set-pi-block-images').checked };
    $('settings-dialog').close();
    return { before, after };
  })()))()`));
  console.log('  image row before:', JSON.stringify(imgRow.before), 'after unchecking:', JSON.stringify(imgRow.after));
  if (imgRow.before.own) fail('the WebUI still has a block-images toggle of its own (issue #214)');
  if (imgRow.before.disabled || imgRow.before.checked !== true) fail("pi's image checkbox did not load images.blockImages: " + JSON.stringify(imgRow.before));
  const imgSaved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (imgSaved.images.blockImages !== false) fail('unchecking did not write images.blockImages=false: ' + JSON.stringify(imgSaved));
  if (imgRow.after.checked !== false) fail('reopening settings did not read the image setting back: ' + JSON.stringify(imgRow.after));

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
      imgDisabled: $('set-pi-block-images').disabled,
      note: ($('set-pi-compaction-note') || {}).textContent || '',
    };
    window.fetch = real;
    return out;
  })()))()`));
  console.log('  without /api/pi-config:', JSON.stringify(stale));
  if (!stale.disabled) fail('an old bridge (no /api/pi-config) leaves the checkbox enabled');
  if (!stale.imgDisabled) fail("an old bridge leaves pi's image checkbox enabled");
  if (!/restart/i.test(stale.note)) fail('the row does not say what to do: ' + JSON.stringify(stale));

  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));

  console.log('  PASS #56 pi\'s auto-compaction is shown, changed over RPC, persisted and read back; an old bridge says so (#91)');
  cleanupBrowser();
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
