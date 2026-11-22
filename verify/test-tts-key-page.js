/*
 * #246, the browser half: the cloud TTS key must not stay in this page's
 * localStorage. A profile that ran an older build still has it in the cached
 * settings JSON; settings-state.js must delete it from the stored copy on load
 * (not only from the in-memory SET), and the rest of the cached settings must
 * survive.
 *
 * Usage: node test-tts-key-page.js <baseUrl> <browserPath>
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
if (!base) { console.error('usage: node test-tts-key-page.js <baseUrl> <browserPath>'); process.exit(2); }
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const PORT = 9925 + (process.pid % 9);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-ttskey-'));
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
  const waitLoaded = async () => {
    for (let i = 0; i < 100; i++) {
      if (await evalJs("typeof settingsLoaded !== 'undefined' && settingsLoaded === true ? 1 : 0")) return true;
      await sleep(200);
    }
    return false;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: base + '/' });
  if (!await waitLoaded()) fail('the page never loaded its settings');

  // Plant what an older build cached, then reload so the load path sees it.
  await evalJs(`localStorage.setItem('piwebui-settings', JSON.stringify({ ttsApiKey: 'sk-legacy', agentName: 'Legacy Name', ttsBackend: 'fish' })); true`);
  await send('Page.reload');
  if (!await waitLoaded()) fail('the page did not reload its settings');

  const state = JSON.parse(await evalJs(`(() => {
    const raw = localStorage.getItem('piwebui-settings') || '';
    let parsed = null; try { parsed = JSON.parse(raw); } catch { /* keep null */ }
    return JSON.stringify({
      rawHasKey: /"ttsApiKey"/.test(raw),
      parsedHasKey: !!(parsed && Object.prototype.hasOwnProperty.call(parsed, 'ttsApiKey')),
      setHasKey: typeof SET !== 'undefined' && typeof SET.ttsApiKey !== 'undefined',
      agentName: parsed && parsed.agentName,
      backend: parsed && parsed.ttsBackend,
    });
  })()`));
  if (state.rawHasKey || state.parsedHasKey) fail('the legacy TTS key is still in localStorage: ' + JSON.stringify(state));
  if (state.setHasKey) fail('the legacy TTS key is still in SET: ' + JSON.stringify(state));
  if (state.agentName !== 'Legacy Name' || state.backend !== 'fish') fail('purging the key damaged the rest of the cached settings: ' + JSON.stringify(state));

  ws.close(); cleanup();
  console.log('  a legacy ttsApiKey is gone from localStorage and SET after load; other cached settings survive');
  console.log(JSON.stringify({ rawHasKey: false, setHasKey: false, agentName: state.agentName }));
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
