/*
 * #260: the live compaction marker must show the after-count, exactly like the
 * marker rebuilt from the file. renderCompactionBlock() used to pass only the
 * reason to buildCompactionSummary(), which reads estimatedTokensAfter from its
 * second argument - so the live marker lost "→ 24.4K tok".
 *
 * Drives both renderers in the page and compares the two who-lines.
 *
 * Usage: node test-compaction-live.js <baseUrl> <browserPath>
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
if (!base || !browser || !fs.existsSync(browser)) { console.error('usage: node test-compaction-live.js <baseUrl> <browserPath>'); process.exit(2); }

const DBG = 9940 + (process.pid % 9);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-complive-'));
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
  for (let i = 0; i < 100; i++) { if (await evalJs("typeof renderCompactionBlock === 'function' && typeof buildCompactionSummary === 'function' ? 1 : 0")) break; await sleep(200); }

  const out = JSON.parse(await evalJs(`(() => {
    const result = { tokensBefore: 833300, estimatedTokensAfter: 24400, summary: 'the compacted summary' };
    for (const old of chat.querySelectorAll('.msg.compaction.pinned')) old.remove();
    renderCompactionBlock(result, 'manual');
    const live = [...chat.querySelectorAll('.msg.compaction.pinned .who')].pop().textContent;
    for (const old of chat.querySelectorAll('.msg.compaction.pinned')) old.remove();
    const rebuilt = buildCompactionSummary(result, { reason: 'manual', estimatedTokensAfter: 24400 }).querySelector('.who').textContent;
    return JSON.stringify({ live, rebuilt });
  })()`));

  if (!/833\.3K tok → 24\.4K tok · manual/.test(out.live)) {
    fail('the live marker is missing the after-count: ' + JSON.stringify(out.live));
  }
  if (out.live !== out.rebuilt) fail('live and rebuilt markers differ: ' + JSON.stringify(out));
  ws.close(); cleanup();
  console.log('  live marker: ' + out.live);
  console.log('PASS #260 the live compaction marker matches the rebuilt one, including the after-count');
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
