/*
 * #238: a rejected play() (autoplay policy) fires neither onended nor onerror.
 * The TTS batch loop must treat it as "finished" instead of hanging with
 * S.speaking stuck true, and it must revoke each blob URL.
 *
 * Stubs Audio so play() rejects, calls speakInBatches, and races it against a
 * timeout.
 *
 * Usage: node test-tts-playback.js <baseUrl> <browserPath>
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = process.argv[2];
const browser = process.argv[3];
const fail = (m) => { console.error('FAIL: ' + m); cleanup(); process.exit(1); };
if (!base || !browser || !fs.existsSync(browser)) { console.error('usage: node test-tts-playback.js <baseUrl> <browserPath>'); process.exit(2); }

const DBG = 9950 + (process.pid % 9);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-ttsplay-'));
const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--remote-debugging-port=' + DBG, '--user-data-dir=' + userDir,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', (c) => { stderr += c; });
function cleanup() {
  try { child.kill(); } catch { /* gone */ }
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ }
}
process.on('exit', cleanup);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: DBG, path: p }, (r) => {
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
  ws.onmessage = (raw) => { let m; try { m = JSON.parse(raw); } catch { return; } if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw');
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: base + '/' });
  for (let i = 0; i < 100; i++) { if (await evalJs("typeof speakInBatches === 'function' && typeof S === 'object' ? 1 : 0")) break; await sleep(200); }

  const out = JSON.parse(await evalJs(`(async () => {
    const origAudio = window.Audio;
    const origCreate = URL.createObjectURL, origRevoke = URL.revokeObjectURL;
    let revoked = 0;
    URL.createObjectURL = () => 'blob:verify';
    URL.revokeObjectURL = () => { revoked++; };
    window.Audio = class {
      constructor() { this.onended = null; this.onerror = null; }
      play() { return Promise.reject(new Error('autoplay blocked')); }
    };
    let settled = false;
    try {
      const p = speakInBatches('First sentence. Second sentence.', async () => new Blob(['x']));
      await Promise.race([
        p.then(() => { settled = true; }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('speakInBatches hung')), 2000)),
      ]);
    } finally {
      window.Audio = origAudio;
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
    return JSON.stringify({
      settled, revoked,
      speaking: !!S.speaking,
      buttonOn: document.getElementById('btn-tts').classList.contains('on'),
    });
  })()`));

  if (!out.settled) fail('speakInBatches never settled after play() was rejected: ' + JSON.stringify(out));
  if (out.revoked < 1) fail('the blob URL was not revoked: ' + JSON.stringify(out));
  if (out.speaking) fail('S.speaking stayed true: ' + JSON.stringify(out));
  if (out.buttonOn) fail('the speak button stayed lit: ' + JSON.stringify(out));
  ws.close(); cleanup();
  console.log(`  play() rejected: settled, ${out.revoked} blob URL(s) revoked, S.speaking false, button off`);
  console.log('PASS #238 a refused play() settles the batch and releases the blob');
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
