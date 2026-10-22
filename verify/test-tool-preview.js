/*
 * Issue #67: "The write/bash tool preview has a max character limit and will
 * start deleting stuff from the preview (VISUAL)."
 *
 * While a tool call streams, liveToolPreview() fed the card from the partial
 * arguments JSON. It kept only the last 4000 characters for a write/edit and
 * the last 2000 for everything else, so the beginning of a long file silently
 * disappeared as it was written. The finished card was always repopulated from
 * the full arguments, so this was a visual deletion, not data loss - and the fix
 * has to preserve that: a large window, an explicit marker for what is not
 * shown, the newest line kept in view, and the whole argument once the call ends.
 *
 * This drives the real streaming path (message_start -> toolcall_start ->
 * toolcall_delta … -> toolcall_end) through handleRpcMessage, the same shape pi
 * sends over RPC. Under the old code the mid-stream assertion fails: the START
 * marker is gone after the first 4000 characters.
 *
 * Usage: node test-tool-preview.js <baseUrl> <browserPath>
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
if (!base) { console.error('usage: node test-tool-preview.js <baseUrl> <browserPath>'); process.exit(2); }
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const PORT = 9960 + (process.pid % 35);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-toolpreview-'));
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

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: base + '/' });
  for (let i = 0; i < 100; i++) {
    if (await evalJs("typeof handleRpcMessage === 'function' && typeof S === 'object' ? 1 : 0")) break;
    await sleep(250);
  }
  await sleep(1000);

  const res = await evalJs(`(() => {
    const out = {};
    S.live = null; S.liveDetached = null;
    document.getElementById('chat').innerHTML = '';
    const ev = (o) => handleRpcMessage(o);
    const bodyOf = (id) => {
      const c = S.toolCards.get(id);
      return c ? { text: c.body.textContent, hidden: c.body.classList.contains('hidden'),
        sticky: c._bodySticky, top: c.body.scrollTop,
        atBottom: c.body.scrollHeight - c.body.scrollTop - c.body.clientHeight < 30 } : null;
    };

    // ── a long write, streamed the way pi streams it ──────────────────────
    const BS = String.fromCharCode(92);
    const head = 'START-OF-FILE';
    const lines = [];
    for (let i = 1; i <= 2500; i++) lines.push('line ' + i + ' ' + 'x'.repeat(24));
    const content = head + '\\n' + lines.join('\\n') + '\\nEND-OF-FILE\\nliteral ' + BS + 'n here';
    const argsJson = JSON.stringify({ path: '/tmp/big.txt', content });
    ev({ type: 'message_start', message: { role: 'assistant' } });
    ev({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, toolName: 'write', id: 'tc-write' } });
    const chunk = 1000;
    let fed = 0, mid = null;
    while (fed < argsJson.length) {
      ev({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: argsJson.slice(fed, fed + chunk) } });
      fed += chunk;
      if (!mid && fed >= 6000) mid = bodyOf('tc-write');   // past the old 4000-char cap
    }
    out.mid = mid;
    out.afterStream = bodyOf('tc-write');
    out.afterStreamHasMarker = /earlier character[^\\n]*hidden while streaming/.test(out.afterStream.text);
    out.afterStreamHasLoneSlashN = out.afterStream.text.includes('literal ' + BS + 'n here');
    // the reader scrolls up; the next deltas must not drag them back down
    const card = S.toolCards.get('tc-write');
    card.body.scrollTop = 0;
    card.body.dispatchEvent(new Event('scroll'));
    out.scrolledUpSticky = card._bodySticky;
    for (let k = 0; k < 3; k++) ev({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: ' ' } });
    out.afterScrolledUp = bodyOf('tc-write');
    // finish: the card must hold the whole argument now
    ev({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: { id: 'tc-write', name: 'write', arguments: { path: '/tmp/big.txt', content } } } });
    out.afterEnd = bodyOf('tc-write');
    out.afterEndKind = card.body.dataset.kind || null;
    out.afterEndHasMarker = /earlier character[^\\n]*hidden/.test(out.afterEnd.text);

    // ── a bash command, streamed ──────────────────────────────────────────
    S.live = null; S.liveDetached = null;
    document.getElementById('chat').innerHTML = '';
    const cmd = 'echo hello && ls -la /very/long/path/that/goes/on';
    const bj = JSON.stringify({ command: cmd, timeout: 600 });
    ev({ type: 'message_start', message: { role: 'assistant' } });
    ev({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, toolName: 'bash', id: 'tc-bash' } });
    for (let i = 0; i < bj.length; i += 7) {
      ev({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: bj.slice(i, i + 7) } });
    }
    out.bash = bodyOf('tc-bash');
    return JSON.stringify(out);
  })()`);

  const r = JSON.parse(res);
  const show = (label, v) => console.log('  ' + label.padEnd(26) + (typeof v === 'string' ? JSON.stringify(v.slice(0, 90)) : JSON.stringify(v)));

  show('mid-stream has start', !!(r.mid && r.mid.text.includes('START-OF-FILE')));
  show('after stream has marker', r.afterStreamHasMarker);
  show('after stream has end', r.afterStream.text.includes('END-OF-FILE'));
  show('literal backslash-n kept', r.afterStreamHasLoneSlashN);
  show('scrolled-up sticky flag', r.scrolledUpSticky);
  show('after end kind / length', r.afterEndKind + ' / ' + r.afterEnd.text.length);

  if (!r.mid || !r.mid.text.includes('START-OF-FILE')) {
    fail('#67 the start of the file was deleted from the preview while it streamed');
  }
  if (!r.mid.atBottom) fail('#67 the preview did not follow the newest line while streaming');
  if (r.afterStream.text.includes('END-OF-FILE') === false) fail('#67 the tail of the stream is missing');
  if (!r.afterStreamHasMarker) fail('#67 a capped preview did not say how much it was hiding');
  if (!r.afterStreamHasLoneSlashN) {
    fail('#67 a literal backslash-n in the file was turned into a newline during unescaping');
  }
  if (r.scrolledUpSticky !== false) fail('#67 scrolling up did not stop the auto-follow');
  if (r.afterScrolledUp.top !== 0) fail('#67 the next delta yanked the reader back to the bottom');
  if (r.afterEndKind !== 'args') fail('#67 the finished card is not showing the arguments (kind=' + r.afterEndKind + ')');
  if (!r.afterEnd.text.includes('START-OF-FILE') || !r.afterEnd.text.includes('END-OF-FILE')) {
    fail('#67 the finished card does not hold the whole argument');
  }
  if (r.afterEndHasMarker) fail('#67 the finished card still shows a streaming marker');
  if (!r.bash || !r.bash.text.includes('echo hello && ls -la /very/long/path/that/goes/on')) {
    fail('#67 a streamed bash call does not show its command: ' + JSON.stringify(r.bash && r.bash.text.slice(0, 120)));
  }
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));

  console.log('  PASS #67 a long stream keeps its beginning, names what it hides, and finishes whole');
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
