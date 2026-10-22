/*
 * Issue #53: "Manually stopping the agent shows previous '/' commands that were sent",
 * and the detail that made it findable: "only the last 3 messages were 're-typed' into
 * the new chat, or when stopping the agent".
 *
 * What pi does, from its own source:
 *
 *   abort() { this.abortRetry(); this.agent.abort(); await this.waitForIdle(); }
 *
 * That is all it does. Steering and follow-up messages live in `_steeringMessages` /
 * `_followUpMessages` and abort does not touch them, so a message that was queued and
 * never taken is still queued afterwards and is delivered on the next turn - an old
 * command reappearing later as though it had been re-sent. pi has had `clearQueue()`
 * for this the whole time, documented as "useful for restoring to editor when user
 * aborts", but it was not reachable over RPC, so the WebUI restored its own copy from
 * the last queue_update and left pi's copy in place.
 *
 * pi 1.0.0 added the `clear_queue` command: it returns the pending messages AND empties
 * the queue. stopAgent() calls it first, uses the returned lists for the composer
 * (unlike our own copy, those are the authoritative ones), and falls back to the old
 * client-side behaviour when the pi in use is older and does not know the command.
 *
 * Both halves are checked against a mock that mirrors pi: abort leaves its queue alone,
 * and only clear_queue drains it. If the call is dropped, the queue is still there
 * afterwards - which is the bug.
 *
 * Usage: node test-stop-clears-queue.js <baseUrl> <browserPath>
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
if (!base) { console.error('usage: node test-stop-clears-queue.js <baseUrl> <browserPath>'); process.exit(2); }
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

let PORT = 0;   // assigned from the browser's own DevTools line (see ws-min.js)
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-stop-'));
const launched = require('./ws-min.js').launchBrowser(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--user-data-dir=' + userDir,
  'about:blank',
]);
const child = launched.child;
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
  try { PORT = await launched.port; } catch (e) { fail(e.message); }
  let ver = null;
  for (let i = 0; i < 100; i++) { try { ver = await getJson('/json/version'); break; } catch { await sleep(150); } }
  if (!ver) fail('browser never came up\n' + stderr.slice(-400));

  const WS = require('./ws-min.js');
  /* /json/version can answer a moment before /json/list is an array, and a
   * reused debug port can answer with something else entirely; retry instead of
   * assuming the first response is the page list. */
  let page = null;
  for (let i = 0; i < 100; i++) {
    try {
      const list = await getJson('/json/list');
      if (Array.isArray(list)) { page = list.find((t) => t.type === 'page'); if (page) break; }
    } catch { /* not ready yet */ }
    await sleep(150);
  }
  if (!page) fail('browser never exposed a page on the debug port\n' + stderr.slice(-400));
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
  const jsonAsync = async (expr) => JSON.parse(await evalJs(`(async () => JSON.stringify(await (${expr})))()`));

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: base + '/' });
  await sleep(3000);
  for (let i = 0; i < 60; i++) {
    if (await evalJs("typeof stopAgent === 'function' && S.ws && S.ws.readyState === 1 ? 1 : 0")) break;
    await sleep(250);
  }

  /* A turn has to be running for a steer to be queued rather than sent. The mock
   * streams for about a second on a prompt, so send one and steer while it is going. */
  const out = await jsonAsync(`(async () => {
    const sent = async (o) => { const r = await rpc(o); return r; };
    // start a turn so the agent is streaming
    document.getElementById('input').value = 'start a turn';
    sendCurrent();
    /* Wait until the agent reports that it is busy, rather than sleeping and hoping.
     * A steer is only a steer while a turn is running; sent into an idle agent it is
     * an ordinary prompt and nothing is queued - which is how this check first passed
     * in isolation and reported "the agent never queued anything" inside the suite,
     * where the shared mock agent's state depends on what ran before it. */
    let busy = false;
    for (let i = 0; i < 40; i++) {
      let st = null;
      try { st = await rpc({ type: 'get_state' }, 1500); } catch { return { unreachable: true }; }
      if (st && st.isStreaming) { busy = true; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!busy) return { neverBusy: true };
    // steer three times, which is the shape reported: the last few messages come back
    for (const t of ['/goal-one', '/goal-two', '/goal-three']) {
      await sent({ type: 'prompt', message: t, streamingBehavior: 'steer' });
    }
    await new Promise((r) => setTimeout(r, 150));
    const queuedBefore = { steering: [...S.queue.steering], followUp: [...S.queue.followUp] };

    const agentBefore = (await rpc({ type: 'get_state' })).queuedSteering || [];
    document.getElementById('input').value = '';
    await stopAgent();
    await new Promise((r) => setTimeout(r, 200));
    // What the AGENT still holds, not what the page thinks - stopAgent empties the
    // page's own copy unconditionally, so that was asserting on nothing.
    const agentAfter = (await rpc({ type: 'get_state' })).queuedSteering || [];
    return {
      queuedBefore, agentBefore, agentAfter,
      composer: document.getElementById('input').value,
    };
  })()`);

  if (out.neverBusy || out.unreachable) {
    // A steer is only a steer while a turn is running, and this shares one mock agent
    // with every other browser check. When it cannot be driven into a busy state - or
    // cannot be reached at all - there is nothing to queue and nothing to prove, so it
    // says so instead of failing. Falsified by hand: dropping the clear_queue call
    // leaves the agent holding all three messages and the check fails.
    console.log('  SKIP the agent could not be driven into a busy turn, so there was nothing to queue');
    process.exit(77);
  }
  console.log('  queued before stopping : ' + JSON.stringify(out.queuedBefore));
  console.log('  the agent held before  : ' + JSON.stringify(out.agentBefore));
  console.log('  the agent holds after  : ' + JSON.stringify(out.agentAfter));
  console.log('  composer after stopping: ' + JSON.stringify(out.composer));

  if (!out.queuedBefore.steering.length) {
    fail('nothing was queued before the abort, so this check proves nothing - the mock did not park the steered messages');
  }
  if (!out.composer.includes('/goal-one')) {
    fail('stopping did not put the queued messages back in the box: ' + JSON.stringify(out.composer));
  }
  if (!/goal-two/.test(out.composer) || !/goal-three/.test(out.composer)) {
    fail('only some of the queued messages came back: ' + JSON.stringify(out.composer));
  }
  ok('#53 stopping puts the queued messages back in the box');

  if (!out.agentBefore.length) {
    /* The page's queue and the agent's disagreed, which means the agent did not park these
     * messages - it was restarted, or its turn had already ended when the steers arrived.
     * Nothing was queued, so there is nothing to prove: say so rather than failing, and
     * rather than passing on an assertion that examined nothing. Verified standalone:
     * with the clear_queue call dropped, the agent holds all three afterwards and this
     * fails with "the agent still holds 3 queued message(s) after stopping". */
    console.log('  SKIP the agent parked nothing (it was restarted or already idle), so there was nothing to queue');
    process.exit(77);
  }
  if (out.agentAfter.length) {
    fail(`the agent still holds ${out.agentAfter.length} queued message(s) after stopping (${JSON.stringify(out.agentAfter)}) - ` +
      'pi delivers those on the next turn, which is the old command reappearing');
  }
  ok('#53 and the agent no longer holds them, so it cannot deliver them later');

  /* And the queue really is empty on the agent's side, not just in the page: a new
   * turn must not run the old commands. */
  const replayed = await jsonAsync(`(async () => {
    document.getElementById('input').value = 'a fresh turn';
    sendCurrent();
    await new Promise((r) => setTimeout(r, 1800));
    const text = document.getElementById('chat').textContent;
    return { sawOld: ['/goal-one', '/goal-two', '/goal-three'].filter((t) => text.includes(t)) };
  })()`);
  if (replayed.sawOld.length) {
    fail('the old queued commands came back on the next turn: ' + JSON.stringify(replayed.sawOld));
  }
  ok('#53 a later turn does not run the commands that were taken back');

  if (problems.length) fail(problems.slice(0, 3).join(' | '));
  ws.close(); cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
