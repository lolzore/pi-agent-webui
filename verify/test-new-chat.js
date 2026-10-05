/*
 * Regression test for issue #1: the message you just sent in a new chat is
 * missing from the transcript until the page is reloaded.
 *
 * The report is "it happens every single time, the agent is working, and it
 * appears instantly after a refresh" - so the message reached pi (the file has
 * it) and only the on-screen copy was lost.
 *
 * The mechanism: pi emits message_start/message_end for the *user's* message as
 * well as the assistant's. sendPrompt() draws the user's message immediately as
 * an "optimistic" bubble that exists only in the DOM, and then the user's own
 * message_end calls finalizeLive(), which - because the turn is not finalised
 * yet - calls refreshMessages(). That does chat.innerHTML = '' and rebuilds the
 * transcript from the session file, which in a brand-new chat has not been
 * written yet, so the bubble is destroyed and nothing puts it back. A reload
 * reads the file, which by then exists.
 *
 * The mock agent does not emit the user's message events (it only streams the
 * assistant), so this test drives them the way pi does by injecting the two
 * events through the page's own handler. That is the event order the page
 * already documents in finalizeLive(): "finalizeLive() runs on every message_end
 * and turn_end -- including the user's own message".
 *
 * Usage: node test-new-chat.js <baseUrl>
 * Asserts: the sent message is on screen after sending, and still on screen
 * after the user's own message_end arrives.
 */
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const base = process.argv[2];
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (!base) { console.error('usage: node test-new-chat.js <baseUrl>'); process.exit(2); }

const BROWSER = process.argv[3] || '';
if (!BROWSER || !fs.existsSync(BROWSER)) { console.error('no browser at ' + BROWSER); process.exit(2); }

const PORT = 9700 + (process.pid % 200);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-newchat-'));
const { spawn } = require('child_process');
const child = spawn(BROWSER, [
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
  ws.onmessage = (raw) => { let m; try { m = JSON.parse(raw); } catch { return; } if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw');
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: base + '/' });
  /* Wait for the app to be ready rather than sleeping a fixed amount: a flat
   * 3.5s is enough on an idle machine and not on a busy one, which is how these
   * tests reported a starting page as a broken one. */
  for (let i = 0; i < 80; i++) {
    const ready = await evalJs("typeof setCtxRing === 'function' && document.querySelector('#stats-bar') ? 1 : 0");
    if (ready) break;
    await sleep(250);
  }

  const userRows = `document.querySelectorAll('#chat .msg.user').length`;
  const lastUserText = `(() => { const n=[...document.querySelectorAll('#chat .msg.user .bubble')].pop(); return n ? n.textContent.trim().slice(0,60) : null; })()`;

  // 1. a brand-new chat, the way the UI does it
  await evalJs(`(() => { const b = document.getElementById('btn-new-session'); if (b) b.click(); return !!b; })()`);
  await sleep(2000);

  // 2. send a message, exactly as the composer does
  const SENT = 'verify-new-chat-probe';
  await evalJs(`(() => {
    const i = document.getElementById('input');
    i.value = ${JSON.stringify(SENT)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-send').click();
    return true;
  })()`);
  await sleep(600);

  const afterSend = await evalJs(userRows);
  if (!afterSend) fail('the sent message was not drawn at all immediately after sending');

  // 3. now the part pi does that the mock does not: the user's own
  //    message_start / message_end, which land before the assistant's.
  //
  //    The turn state is forced the way it really is at that moment. In the real
  //    event order the user's message_end is the first thing to arrive, when
  //    agent_start() has just set turnFinalised = false - that is precisely why
  //    the rebuild happens. The mock answers so quickly that by the time this
  //    probe runs, its assistant message has already finalised the turn, and the
  //    rebuild is skipped. Restoring the flag makes the test independent of how
  //    fast the mock replies.
  await evalJs(`S.turnFinalised = false;`);
  await evalJs(`(() => {
    const m = { role: 'user', content: [{ type: 'text', text: ${JSON.stringify(SENT)} }], timestamp: Date.now() };
    handleRpcMessage({ type: 'message_start', message: m });
    handleRpcMessage({ type: 'message_end', message: m });
    return true;
  })()`);
  await sleep(1200);

  const afterUserEnd = await evalJs(userRows);
  const text = await evalJs(lastUserText);
  const hasSent = await evalJs(`[...document.querySelectorAll('#chat .msg.user .bubble')].some((n) => n.textContent.includes(${JSON.stringify(SENT)}))`);

  if (afterUserEnd < 1 || !hasSent) {
    fail(`the sent message vanished when the user's own message_end arrived ` +
      `(rows after send: ${afterSend}, after message_end: ${afterUserEnd}, ` +
      `last bubble: ${JSON.stringify(text)})`);
  }

  console.log(`sent message survives: ${afterSend} row after send, ${afterUserEnd} after the user's own message_end`);
  ws.close(); cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
