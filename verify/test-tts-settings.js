/*
 * Issue #211: "Fish audio shares the same submenus as the openai compatible
 * cloud" - the voice settings had one generic "Cloud model / Cloud voice /
 * Service URL" group for both services. Fish Audio has a model list of its own
 * (s2.1-pro is the default, s2.1-pro-free the free tier, plus s1, s2-pro and
 * drama-3), so a Fish user had to know the model strings and paste a reference
 * id into a field labelled "alloy / nova".
 *
 * This picks Fish Audio as the TTS backend and checks that the dialog shows the
 * dedicated group - a model picker with those five models, Fish-specific labels
 * and its own hint - that the choice is saved, and that switching to an
 * OpenAI-compatible service brings the free-text model field back.
 *
 * Usage: node test-tts-settings.js <browserPath>
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
const PORT = 23300 + (process.pid % 300);
const DBG_PORT = 9700 + (process.pid % 200);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-tts-ui-'));
const agentDir = path.join(scratch, 'agent');
const sessionDir = path.join(scratch, 'sessions');
const webuiFile = path.join(scratch, 'webui.json');
for (const d of [agentDir, sessionDir, path.join(scratch, 'ws')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(webuiFile, JSON.stringify({ onboarded: true, ttsBackend: 'fish' }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      WORKSPACE_DIR: path.join(scratch, 'ws'),
      PI_WEBUI_SETTINGS: webuiFile,
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
  for (let i = 0; i < 100; i++) {
    try { const d = await getJson(PORT, '/api/health'); if (d.ok) { up = true; break; } } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('the scratch bridge never came up\n' + bridgeErr.slice(-500));

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-tts-ui-browser-'));
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--remote-debugging-port=' + DBG_PORT, '--user-data-dir=' + userDir,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let berr = '';
  child.stderr.on('data', (c) => { berr += c; });
  const cleanupBrowser = () => {
    try { child.kill(); } catch { /* gone */ }
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ }
  };
  process.on('exit', cleanupBrowser);
  let ver = null;
  for (let i = 0; i < 100; i++) { try { ver = await getJson(DBG_PORT, '/json/version'); break; } catch { await sleep(150); } }
  if (!ver) fail('browser never came up\n' + berr.slice(-400));

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
  for (let i = 0; i < 120; i++) {
    if (await evalJs("typeof S !== 'undefined' && typeof openSettings === 'function' && typeof SET !== 'undefined' ? 1 : 0")) break;
    await sleep(250);
  }
  await evalJs("document.querySelectorAll('dialog[open]').forEach((d) => { try { d.close(); } catch {} }); true");

  const out = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // computed, and on the control the reader sees: a pretty select is a hidden
    // <select> plus a visible button in .pretty-wrap, so checking the select
    // alone says "hidden" no matter what the page shows (issue #216).
    const control = (el) => {
      if (!el) return null;
      const wrap = el.parentElement && el.parentElement.classList.contains('pretty-wrap') ? el.parentElement : el;
      return wrap;
    };
    const hidden = (el) => { const c = control(el); return !c || getComputedStyle(c).display === 'none'; };
    openSettings();
    await wait(200);
    // persisted backend is 'fish' in this fixture: the group must be there on a
    // cold open, without touching the select first
    const cold = { fishShown: !hidden($('set-tts-fish-model')), hintShown: !!document.querySelector('#tts-fish-model-label .help-tip') };
    const backend = $('set-tts-backend');
    backend.value = 'fish';
    backend.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(150);
    const sel = $('set-tts-fish-model');
    const fish = {
      shown: !hidden(sel),
      options: [...sel.options].map((o) => o.value),
      selected: sel.value,
      textModelHidden: hidden($('set-tts-cloud-model')),
      keyLabel: ($('tts-cloud-key-label') || {}).textContent || '',
      voiceLabel: ($('tts-cloud-voice-label') || {}).textContent || '',
      urlLabel: ($('tts-cloud-url-label') || {}).textContent || '',
      voicePlaceholder: ($('set-tts-cloud-voice') || {}).placeholder || '',
      // The note moved behind the ? on the TTS backend label (issue #219); its
      // text is still the source the tooltip reads.
      hintShown: !!document.querySelector('#tts-fish-model-label .help-tip'),
      hint: ($('tts-fish-note') || {}).textContent || '',
      cold,
    };
    sel.value = 's2.1-pro-free';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(700);
    fish.saved = SET.ttsCloudModel;
    $('settings-dialog').close();
    openSettings();
    await wait(300);
    fish.readBack = $('set-tts-fish-model').value;
    const b2 = $('set-tts-backend');
    b2.value = 'openai';
    b2.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(150);
    const other = {
      fishHidden: hidden($('set-tts-fish-model')),
      textModelShown: !hidden($('set-tts-cloud-model')),
      keyLabel: ($('tts-cloud-key-label') || {}).textContent || '',
      hintHidden: hidden($('tts-fish-note')),
    };
    /* Every backend that is not Fish must show none of it: not the picker, not
     * the hint, not the Fish-only labels. */
    const others = {};
    for (const mode of ['browser', 'endpoint', 'openai']) {
      b2.value = mode;
      b2.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(120);
      const label = $('tts-fish-model-label');
      others[mode] = {
        selectHidden: hidden($('set-tts-fish-model')),
        labelHidden: hidden(label),
        hintHidden: hidden($('tts-fish-note')),
        keyLabel: ($('tts-cloud-key-label') || {}).textContent || '',
      };
    }
    $('settings-dialog').close();
    return { fish, other, others };
  })()))()`));
  console.log('  fish: ' + JSON.stringify(out.fish).slice(0, 400) + ' …');
  console.log('  cold open: ' + JSON.stringify(out.fish.cold));
  console.log('  openai-compatible: ' + JSON.stringify(out.other));
  console.log('  other backends: ' + JSON.stringify(out.others));

  const f = out.fish;
  if (!f.cold || !f.cold.fishShown || !f.cold.hintShown) fail('a cold open with Fish Audio selected does not show the Fish group: ' + JSON.stringify(f.cold));
  if (!f.shown) fail('choosing Fish Audio does not show the dedicated group');
  if (!f.options.includes('s2.1-pro') || !f.options.includes('s2.1-pro-free')) fail('the Fish model list is missing its models: ' + JSON.stringify(f.options));
  if (f.options.length < 5) fail('the Fish model list is incomplete: ' + JSON.stringify(f.options));
  if (f.selected !== 's2.1-pro') fail('the Fish model list does not start on the default: ' + f.selected);
  if (!f.textModelHidden) fail('the OpenAI free-text model field is still shown for Fish Audio');
  if (!/fish/i.test(f.keyLabel) || !/reference id/i.test(f.voiceLabel) || !/Fish Audio service URL|fish/i.test(f.urlLabel)) {
    fail('the field labels are not Fish-specific: ' + JSON.stringify([f.keyLabel, f.voiceLabel, f.urlLabel]));
  }
  if (!/reference id/i.test(f.voicePlaceholder)) fail('the voice field still asks for an OpenAI voice: ' + f.voicePlaceholder);
  if (!f.hintShown || !/s2\.1-pro/.test(f.hint)) fail('the Fish hint (model list, where voices come from) is missing');
  if (f.saved !== 's2.1-pro-free') fail('choosing a Fish model was not saved: ' + f.saved);
  if (f.readBack !== 's2.1-pro-free') fail('reopening settings lost the Fish model: ' + f.readBack);

  let persisted = null;
  for (let i = 0; i < 40; i++) {
    try { persisted = JSON.parse(fs.readFileSync(webuiFile, 'utf8')); } catch { persisted = null; }
    if (persisted && persisted.ttsCloudModel === 's2.1-pro-free') break;
    await sleep(150);
  }
  if (!persisted || persisted.ttsCloudModel !== 's2.1-pro-free') fail('the Fish model never reached the saved settings: ' + JSON.stringify(persisted && persisted.ttsCloudModel));

  if (!out.other.fishHidden) fail('the Fish model list stays visible for an OpenAI-compatible service');
  if (!out.other.textModelShown) fail('an OpenAI-compatible service has no model field');
  if (!/cloud/i.test(out.other.keyLabel)) fail('the API key label no longer says Cloud for the OpenAI-compatible service: ' + out.other.keyLabel);
  if (!out.other.hintHidden) fail('the Fish hint is still shown for an OpenAI-compatible service');
  for (const [mode, v] of Object.entries(out.others)) {
    if (!v.selectHidden) fail(`the Fish model list is visible with the ${mode} backend`);
    if (!v.labelHidden) fail(`the Fish model label is visible with the ${mode} backend`);
    if (!v.hintHidden) fail(`the Fish hint is visible with the ${mode} backend`);
  }

  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));
  console.log('  PASS #211/#216 Fish Audio has its own model list and fields, and they are hidden for every other backend');
  ws.close(); cleanupBrowser(); cleanup(); process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
