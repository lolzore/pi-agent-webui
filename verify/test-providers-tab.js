/*
 * Issue #68: "The providers list does not appear when clicked, or something has
 * been typed."
 *
 * Two things in the Pi providers tab could look like an empty list:
 *
 *   1. The custom providers were rendered only after the llama.cpp probe
 *      resolved. A slow probe parked "loading…" over a list the bridge had
 *      already answered. The list must render while the probe is still out.
 *   2. The llama.cpp section came from a single probe and was never retried; a
 *      server that answered a moment later (or a sweep still running) stayed
 *      missing until the dialog was closed and reopened.
 *
 * And the provider picker next to it was a native <datalist>, which does not
 * open on a click and only matches what is already typed. It must open on
 * click with the full list, filter as you type, and answer the keyboard.
 *
 * Runs against the extensions bridge (PI_TEST_AGENT_DIR) so the files this
 * test writes - models.json, and a llamaSettings.servers entry it restores
 * afterwards - never touch the real agent dir.
 *
 * Usage: env PI_TEST_AGENT_DIR=<scratch agent dir> \
 *        node test-providers-tab.js <baseUrl> <browserPath>
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = process.argv[2];
const browser = process.argv[3];
const agentDir = process.env.PI_TEST_AGENT_DIR || '';
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (!base) { console.error('usage: node test-providers-tab.js <baseUrl> <browserPath>'); process.exit(2); }
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }
if (!agentDir) { console.error('SKIP: PI_TEST_AGENT_DIR is not set (this check writes into a scratch agent dir)'); process.exit(77); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── a fake llama.cpp server, so the llama section has something to show ── */
const FAKE_PORT = 18100 + (process.pid % 800);
const FAKE_URL = `http://127.0.0.1:${FAKE_PORT}`;
const FAKE_MODELS = [{ id: 'verify-llama-a', name: 'Verify Llama A' }, { id: 'verify-llama-b', name: 'Verify Llama B' }];
let fakeServer = null;
function startFakeLlama() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
      res.setHeader('Content-Type', 'application/json');
      if (u === '/v1/models' || u === '/models') { res.end(JSON.stringify({ data: FAKE_MODELS })); return; }
      if (u === '/props') { res.end(JSON.stringify({ default_generation_settings: { model: 'verify.gguf', n_ctx: 4096 }, model_path: 'verify.gguf' })); return; }
      res.statusCode = 404; res.end('{}');
    });
    srv.once('error', reject);
    srv.listen(FAKE_PORT, '127.0.0.1', () => { fakeServer = srv; resolve(); });
  });
}
const stopFakeLlama = () => { if (fakeServer) { try { fakeServer.close(); } catch { /* gone */ } fakeServer = null; } };

/* ── scratch files, restored no matter how the test ends ── */
const settingsPath = path.join(agentDir, 'settings.json');
const modelsPath = path.join(agentDir, 'models.json');
const hadSettings = fs.existsSync(settingsPath);
const settingsBackup = hadSettings ? fs.readFileSync(settingsPath, 'utf8') : null;
const hadModels = fs.existsSync(modelsPath);
const modelsBackup = hadModels ? fs.readFileSync(modelsPath, 'utf8') : null;

function setLlamaSetting(url) {
  let s = {};
  if (settingsBackup) { try { s = JSON.parse(settingsBackup) || {}; } catch { s = {}; } }
  if (url) { s.llamaSettings = { servers: [{ url }] }; s.llamaServerUrl = url; }
  else { delete s.llamaSettings; delete s.llamaServerUrl; }
  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));
}
function restoreScratch() {
  stopFakeLlama();
  try { if (hadSettings) fs.writeFileSync(settingsPath, settingsBackup); else fs.rmSync(settingsPath, { force: true }); } catch { /* */ }
  try { if (hadModels) fs.writeFileSync(modelsPath, modelsBackup); else fs.rmSync(modelsPath, { force: true }); } catch { /* */ }
}
process.on('exit', restoreScratch);

fs.writeFileSync(modelsPath, JSON.stringify({
  providers: {
    'verify-provider': {
      baseUrl: 'https://api.verify.test/v1',
      api: 'openai-completions',
      apiKey: 'sk-verify-test',
      models: [{ id: 'verify-model' }],
    },
  },
}, null, 2));

/* ── browser harness (same shape as the other checks) ── */
const PORT = 9444 + (process.pid % 400);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-providers-'));
const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDir,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', (c) => { stderr += c; });
const cleanupBrowser = () => {
  try { child.kill(); } catch { /* gone */ }
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanupBrowser);

const getJson = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

(async () => {
  /* the bridge has to be the extensions one, with a scratch agent dir, or this
   * test would rewrite the real ~/.pi/agent/models.json */
  const bridgeOk = await new Promise((res) => {
    http.get(base + '/api/health', (r) => { r.resume(); res(r.statusCode === 200); }).on('error', () => res(false));
  });
  if (!bridgeOk) { console.error('SKIP: the scratch bridge is not up'); process.exit(77); }

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
  const waitFor = async (expr, ms, what) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await evalJs(expr)) return true;
      await sleep(150);
    }
    fail(what + ' (waited ' + ms + 'ms)');
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: base + '/' });
  for (let i = 0; i < 120; i++) {
    if (await evalJs("typeof loadPiProviders === 'function' && typeof openSettings === 'function' ? 1 : 0")) break;
    await sleep(250);
  }
  await sleep(1500);

  /* 1. The custom providers must render while the llama probe is still out. */
  const early = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    openSettings();
    const real = window.fetch;
    window.fetch = (u, o) => String(u).includes('/api/llama-models') ? new Promise(() => {}) : real(u, o);
    loadPiProviders();
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      const id = $('pi-providers-list').querySelector('.prov-row .prov-id');
      if (id && id.textContent === 'verify-provider') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const row = $('pi-providers-list').querySelector('.prov-row .prov-id');
    const out = { found: row ? row.textContent : null, llamaGroups: $('pi-providers-list').querySelectorAll('.prov-group').length };
    window.fetch = real;
    return out;
  })()))()`));
  if (early.found !== 'verify-provider') fail('the custom provider row did not render while the llama probe was pending');
  if (early.llamaGroups !== 0) fail('a llama group rendered from a pending probe');
  console.log('  custom providers render while /api/llama-models is still pending');

  /* 2. The llama section must appear when the server answers, without closing
   *    and reopening the dialog: the probe retry has to pick it up. */
  setLlamaSetting(FAKE_URL);
  /* The probe retries belong to the Pi providers tab (issue #106): they run
   * while it is the one on screen, which is the case whenever someone is
   * watching this list. */
  await evalJs("(() => { const t = [...document.querySelectorAll('#settings-tabs .tab')].find((x) => x.dataset.tab === 'providers'); if (t) t.click(); return true; })()");
  const beforeStart = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    loadPiProviders();
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      if (/looking for llama/.test($('pi-providers-list').textContent)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return { text: $('pi-providers-list').textContent.slice(0, 200) };
  })()))()`));
  if (!/looking for llama/.test(beforeStart.text)) {
    fail('the tab did not say it was looking for llama servers while none answered: ' + JSON.stringify(beforeStart.text));
  }
  console.log('  the tab says it is looking while no server has answered');
  await startFakeLlama().catch((e) => fail('the fake llama server did not start: ' + e.message));
  await waitFor(
    `(() => { const g = [...$('pi-providers-list').querySelectorAll('.prov-group')].map((x) => x.textContent); return g.some((t) => /llama\\.cpp/.test(t)); })()`,
    15000, 'the llama.cpp server did not show up on a later probe (without reopening the dialog)');
  const llamaRow = JSON.parse(await evalJs(`JSON.stringify({
    row: [...$('pi-providers-list').querySelectorAll('.prov-row')].map((r) => r.textContent),
  })`));
  if (!llamaRow.row.some((t) => t.includes(String(FAKE_PORT)) && /2 models/.test(t))) {
    fail('the llama row does not describe the live server: ' + JSON.stringify(llamaRow.row));
  }
  console.log('  a server that answers later appears on the probe retry');

  /* 3. The provider picker: opens on click with the full list, filters, keyboard. */
  const picker = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const out = {};
    const inp = $('auth-provider');
    // the bridge's provider list has to have arrived before the list can open
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && Object.keys(authProviders).length < 10) await new Promise((r) => setTimeout(r, 100));
    out.providerCount = Object.keys(authProviders).length;
    out.noDatalist = !inp.getAttribute('list') && !document.getElementById('auth-provider-ids');
    out.closedAtStart = !document.querySelector('.suggest-menu');
    inp.click();
    await new Promise((r) => setTimeout(r, 200));
    const menu = document.querySelector('.suggest-menu');
    out.openedOnClick = !!menu;
    out.allRows = menu ? menu.querySelectorAll('.model-item').length : 0;
    // A substring, not a prefix: the old datalist only matched what was typed,
    // and "pen" is exactly the case a prefix-only filter would miss.
    inp.value = 'pen';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const m2 = document.querySelector('.suggest-menu');
    out.filteredRows = m2 ? [...m2.querySelectorAll('.model-item')].map((r) => r.textContent) : [];
    out.stillOpen = !!m2;
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    out.picked = inp.value;
    out.pickedStatus = $('auth-status').textContent.slice(0, 80);
    out.closedAfterPick = !document.querySelector('.suggest-menu');
    document.body.click();
    await new Promise((r) => setTimeout(r, 100));
    inp.click();
    await new Promise((r) => setTimeout(r, 200));
    out.reopened = !!document.querySelector('.suggest-menu');
    document.body.click();
    await new Promise((r) => setTimeout(r, 100));
    out.closedOnOutside = !document.querySelector('.suggest-menu');
    return out;
  })()))()`));
  if (!picker.noDatalist) fail('the native datalist is still attached to the provider input');
  if (picker.providerCount < 20) fail(`the bridge sent only ${picker.providerCount} providers`);
  if (!picker.closedAtStart) fail('a suggestion menu was open before anything was clicked');
  if (!picker.openedOnClick) fail('clicking the provider field opened no list (issue #68)');
  if (picker.allRows < 20) fail(`the list opened with only ${picker.allRows} providers`);
  if (!picker.stillOpen) fail('typing into the field closed the list');
  if (!picker.filteredRows.length || !picker.filteredRows.every((t) => /pen/i.test(t))) {
    fail('typing did not filter to the providers containing "pen": ' + JSON.stringify(picker.filteredRows));
  }
  if (!/openai/i.test(picker.picked)) {
    fail('Enter did not pick the first filtered provider (input is ' + JSON.stringify(picker.picked) + ')');
  }
  if (!picker.closedAfterPick) fail('the list stayed open after picking a provider');
  if (!picker.reopened || !picker.closedOnOutside) fail('clicking outside the field did not close the list');
  console.log(`  the provider picker opens on click (${picker.allRows} providers), filters, picks, closes`);

  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));
  console.log('  PASS #68 providers tab renders and the picker opens on click');
  await evalJs(`$('settings-dialog').close()`).catch(() => {});
  stopFakeLlama();
  child.kill();
  process.exit(0);
})().catch((e) => { console.error('FAIL: ' + (e && e.message || e)); process.exit(1); });
