/*
 * Issue #59: "More detailed error messages. For example 'Provider network error' is
 * the only thing I see in the webui, meanwhile in pi agent I can see the exact reason
 * for it."
 *
 * A failed turn arrives from pi as an assistant message with
 *
 *     stopReason:  "error"
 *     errorMessage: <the actual reason>
 *     content:     []          <- nothing to render
 *
 * The transcript rendered the blocks (none) and fell through to the literal text
 * "(empty message)", and the reason was only ever shown in a toast that goes away -
 * so a reload lost it as well. Across the sessions on this machine there are 548 of
 * these messages, and the reasons are exactly the detail worth having:
 *
 *     "Provider finish_reason: network_error"
 *     "429: {\"message\":\"Concurrent request limit exceeded. Try again later.\"}"
 *     "502 <html><head><title>502 Bad Gateway</title></head>..."
 *     "Request timed out."
 *     "400: {\"code\":400,\"message\":\"request (65188 tokens) exceeds the available..."
 *
 * pi writes errorMessage into the session file, so this is about rendering what is
 * already there - not about inventing message text. The check therefore drives a
 * message shaped exactly like the real ones (taken from those sessions) through the
 * renderer and asserts the reason is on screen, is not swallowed by the
 * "(empty message)" fallback, survives being marked hollow, and can be copied.
 *
 * Usage: node test-error-detail.js <baseUrl> <browserPath>
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
const ok = (m) => console.log('  PASS ' + m);
if (!base) { console.error('usage: node test-error-detail.js <baseUrl> <browserPath>'); process.exit(2); }
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const PORT = 9994 + (process.pid % 5);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-err-'));
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

/* Real failures, verbatim from the session files on this machine. */
const CASES = [
  { name: 'network_error', provider: 'schizodev-router', model: 'cyankiwi/Qwen3.8-27B-AWQ-INT4', errorMessage: 'Provider finish_reason: network_error' },
  { name: 'rate limit', provider: 'llama.cpp', model: 'Qwen3.6-35B-A3B-IQ4_XS', errorMessage: '429: {"message":"Concurrent request limit exceeded. Try again later.","type":"rate_limit_error"}' },
  { name: 'html gateway page', provider: 'llama.cpp', model: 'Qwen3.8-27B-UD-IQ3_XXS', errorMessage: '502 <html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>' },
];

(async () => {
  let ver = null;
  for (let i = 0; i < 100; i++) { try { ver = await getJson('/json/version'); break; } catch { await sleep(150); } }
  if (!ver) fail('browser never came up\n' + stderr.slice(-400));

  const WS = require('./ws-min.js');
  const page = (await getJson('/json/list')).find((t) => t.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.open();
  let id = 0; const pending = new Map();
  const problems = [];
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
  await sleep(3000);
  for (let i = 0; i < 60; i++) {
    if (await evalJs("typeof renderAssistantMessage === 'function' && !!document.getElementById('chat') ? 1 : 0")) break;
    await sleep(250);
  }

  const res = JSON.parse(await evalJs(`(() => {
    const out = [];
    for (const c of ${JSON.stringify(CASES)}) {
      document.getElementById('chat').innerHTML = '';
      // exactly the shape pi writes for a failed turn
      const msg = {
        role: 'assistant', content: [], stopReason: 'error', errorMessage: c.errorMessage,
        provider: c.provider, model: c.model, timestamp: Date.now(),
        usage: { input: 0, output: 0, totalTokens: 0 },
      };
      renderAssistantMessage(msg);
      markHollowMessages();
      const row = document.querySelector('#chat .msg.assistant');
      const blk = row && row.querySelector('.msg-error');
      const body = row && row.querySelector('.msg-error-body');
      out.push({
        name: c.name,
        rendered: !!blk,
        hollow: row ? row.dataset.hollow === '1' : null,
        open: blk ? blk.open : null,
        bodyText: body ? body.textContent : '',
        headText: row && row.querySelector('.msg-error-head') ? row.querySelector('.msg-error-head').textContent : '',
        where: row && row.querySelector('.msg-error-where') ? row.querySelector('.msg-error-where').textContent : '',
        hasEmptyMessageText: !!(row && row.textContent.includes('(empty message)')),
        copyButton: !!(row && [...row.querySelectorAll('.msg-error-tools .btn')].find((b) => /copy/i.test(b.textContent))),
      });
    }
    document.getElementById('chat').innerHTML = '';
    return JSON.stringify(out);
  })()`));

  for (const r of res) {
    console.log(`  ${r.name.padEnd(18)} rendered=${r.rendered} open=${r.open} hollow=${r.hollow} copy=${r.copyButton} ` +
      `body=${JSON.stringify(r.bodyText.slice(0, 46))}… where=${JSON.stringify(r.where)}`);
  }

  for (const r of res) {
    if (!r.rendered) fail(`a failed turn with "${r.bodyText}" rendered no error block - it is back to "(empty message)"`);
    if (r.hasEmptyMessageText) fail(`"(empty message)" is still on screen for "${r.bodyText}"`);
    if (!r.copyButton) fail('the error block has no way to copy the reason');
    if (!r.where) fail(`the provider/model was not shown, so there is no way to tell which one failed (${r.name})`);
  }
  ok('every real failure renders its reason, with the provider and model that failed');

  // The exact text matters, not a paraphrase of it.
  const net = res[0];
  if (net.bodyText !== CASES[0].errorMessage) {
    fail(`the reason is not shown verbatim: ${JSON.stringify(net.bodyText)} vs ${JSON.stringify(CASES[0].errorMessage)}`);
  }
  ok('the reason is shown verbatim, not summarised');

  // A short reason is open; a whole HTML page is folded so it cannot flood the chat.
  if (net.open !== true) fail('a short reason should be expanded, not folded');
  if (res[2].open !== false) fail('a long reason (a whole HTML error page) should start folded');
  if (!res[2].bodyText.includes('502 Bad Gateway')) fail('the folded reason does not hold the real text');
  if (!/502 Bad Gateway/.test(res[2].headText)) fail('the folded HTML page does not name itself in the headline: ' + JSON.stringify(res[2].headText));
  ok('short reasons are expanded and long ones start folded');

  /* Nothing above is worth anything if it disappears when a rebuild reads the same
   * message back out of the session file - which is where pi keeps errorMessage. */
  const afterRebuild = JSON.parse(await evalJs(`(() => {
    document.getElementById('chat').innerHTML = '';
    const fromFile = { role: 'assistant', content: [], stopReason: 'error',
      errorMessage: 'Provider finish_reason: network_error', provider: 'schizod', model: 'm',
      timestamp: Date.now(), entryId: 'e1' };
    renderAssistantMessage(fromFile);          // exactly what refreshMessages does per message
    markHollowMessages();
    const row = document.querySelector('#chat .msg.assistant');
    document.getElementById('chat').innerHTML = '';
    return JSON.stringify({ shown: !!(row && row.querySelector('.msg-error-body')), hollow: row ? row.dataset.hollow === '1' : null });
  })()`));
  if (!afterRebuild.shown) fail('after a re-render from the session file the reason is gone again');
  if (afterRebuild.hollow) fail('the error row is marked hollow, so hiding thinking or tool calls would hide the reason');
  ok('it survives a re-render from the session file, which is where pi keeps it');

  if (problems.length) fail(problems.slice(0, 3).join(' | '));
  ws.close(); cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
