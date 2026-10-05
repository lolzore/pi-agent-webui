/*
 * Rapid session switching - reported as: "when switching fast the server kind of
 * dies as it processes the session files, and it visually selects a different
 * session, then goes to the right one after it finished loading".
 *
 * Two faults, both measured here rather than described:
 *
 * 1. THE HEARTBEAT ASKED THE AGENT. The liveness check sent `get_state` over the
 *    WebSocket, but pi answers one request at a time and a session switch costs
 *    it over a second on a long session. A few rapid clicks queued several
 *    switches, the next get_state waited behind all of them, and past ten seconds
 *    the page decided the connection was dead and closed its own socket - so
 *    every in-flight request rejected with "connection lost", and the bridge,
 *    left with no clients, shut the agent down.
 *
 *    Asserted: the heartbeat reaches the bridge over HTTP and puts NOTHING on the
 *    WebSocket. That is the whole of the fix, and it is testable without an agent
 *    being busy.
 *
 * 2. EVERY CLICK WAS ITS OWN SWITCH. Ten clicks queued ten switches, which is
 *    what made the agent busy enough for (1) to fire - and a switch that arrived
 *    late could apply its state after a newer one, moving the highlight to the
 *    wrong row.
 *
 *    Asserted: four rapid clicks put at most two `switch_session` frames on the
 *    wire (the one in flight and the last target), and the socket is still open
 *    afterwards.
 *
 * Usage: node test-rapid-switch.js <baseUrl> <browserPath>
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
if (!base) { console.error('usage: node test-rapid-switch.js <baseUrl> <browserPath>'); process.exit(2); }
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const PORT = 9980 + (process.pid % 18);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-rapid-'));
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
  await sleep(1500);
  for (let i = 0; i < 80; i++) {
    if (await evalJs("typeof heartbeat === 'function' && typeof switchToSession === 'function' && S.ws && S.ws.readyState === 1 ? 1 : 0")) break;
    await sleep(250);
  }

  // watch every frame the page puts on the socket
  await evalJs(`(() => {
    window.__frames = [];
    const ws = S.ws;
    const orig = ws.send.bind(ws);
    ws.send = (data) => {
      try { window.__frames.push(JSON.parse(data)); } catch { /* not JSON */ }
      return orig(data);
    };
    // and every HTTP path the page asks for
    window.__fetches = [];
    const of = window.fetch;
    window.fetch = (u, o) => { try { window.__fetches.push(String(u)); } catch {} return of(u, o); };
    return true;
  })()`);

  /* ── 1. the heartbeat must not touch the agent ──────────────────────────
   *
   * Instrumented around the call rather than watched over a window, because the
   * page has its own traffic on the socket (the connect refreshes, the stats
   * poll) and watching a window cannot tell those apart from the heartbeat. So
   * `rpc` is wrapped for exactly as long as the heartbeat is running. */
  const hb = await evalJs(`(async () => {
    const before = window.__fetches.length;
    const origRpc = rpc;
    const calls = [];
    rpc = function (o) { calls.push(o && o.type); return origRpc.apply(this, arguments); };
    try { await Promise.resolve(heartbeat()); } finally { rpc = origRpc; }
    return JSON.stringify({ rpcCalls: calls, fetches: window.__fetches.slice(before) });
  })()`);
  const h = JSON.parse(hb);
  console.log('  heartbeat rpc calls  : ' + (h.rpcCalls.length ? JSON.stringify(h.rpcCalls) : '(none)'));
  console.log('  heartbeat HTTP paths : ' + JSON.stringify(h.fetches));
  if (h.rpcCalls.length) {
    fail('the heartbeat called ' + JSON.stringify(h.rpcCalls) + ' on the agent - it must ask the bridge over HTTP, or a busy agent closes the connection');
  }
  if (!h.fetches.some((u) => /\/api\/health/.test(u))) {
    fail('the heartbeat did not ask /api/health: ' + JSON.stringify(h.fetches));
  }
  console.log('  PASS the heartbeat asks the bridge over HTTP and sends nothing to the agent');

  // ── 2. rapid clicks must coalesce ──────────────────────────────────────
  await evalJs("window.__frames.length = 0; S.notices = [];");
  /* Wait for the agent to be idle first.
   *
   * While a turn is running, switching deliberately views the other session
   * read-only and sends nothing to the agent - correct behaviour, but it leaves
   * this check with no switches to count. The suite shares one agent between the
   * browser tests, so whether it is mid-turn when this one starts depends on how
   * long the previous test took; that is why this failed once in the suite and
   * passed alone. Waiting removes the dependence rather than papering over it,
   * and if it never goes idle the check reports a SKIP so it is visibly not a
   * pass. */
  let idle = false;
  for (let i = 0; i < 80; i++) {
    idle = await evalJs('!S.isStreaming');
    if (idle) break;
    await sleep(250);
  }
  if (!idle) {
    console.log('  SKIP the agent was still streaming after 20s - nothing to measure');
    process.exit(77);
  }
  // The state at the moment of the clicks, on stderr so `run` shows it when the
  // check fails.
  const pre = JSON.parse(await evalJs(`JSON.stringify({
    streaming: !!S.isStreaming,
    viewSession: S.viewSession,
    switchSend: !!switchSend,
  })`));
  console.error('       state before the clicks: ' + JSON.stringify(pre));
  // four clicks as fast as the UI can deliver them, in the same tick
  await evalJs(`(() => {
    for (let i = 0; i < 4; i++) switchToSession('/tmp/rapid-' + i + '.jsonl').catch(() => {});
    return true;
  })()`);
  await sleep(6000);
  const after = await evalJs(`JSON.stringify({
    switches: window.__frames.filter((m) => m.type === 'switch_session').map((m) => m.sessionPath),
    other: window.__frames.map((m) => m.type || m.bridge || '?').filter((t) => t !== 'switch_session' && t !== '?'),
    open: S.ws && S.ws.readyState,
    lost: (S.notices || []).filter((n) => /connection lost/i.test(n.text)).length,
  })`);
  const a = JSON.parse(after);
  console.log('  four rapid clicks -> ' + a.switches.length + ' switch_session frame(s): ' + JSON.stringify(a.switches));
  console.log('  socket readyState ' + a.open + ' (1 = open), "connection lost" notices: ' + a.lost);
  console.log('  other frames: ' + (a.other.length ? JSON.stringify(a.other) : '(none)'));

  if (a.switches.length > 2) {
    fail(`${a.switches.length} switches were sent for 4 clicks - they are not being coalesced, which is what queues the agent`);
  }
  if (a.switches.length < 1) fail('no switch_session was sent at all');
  if (a.open !== 1) fail('the socket did not survive the rapid clicks (readyState ' + a.open + ')');
  if (a.lost) fail('the page reported "connection lost" during rapid switching');
  console.log('  PASS four rapid clicks coalesce to at most two switches and the socket survives');

  if (pre.streaming) {
    // Not a failure of the fix: with the agent mid-turn the page deliberately
    // shows the other session read-only and sends nothing, which is correct
    // behaviour and leaves this check with nothing to measure. Saying so is
    // better than a pass that proved nothing.
    console.error('       note: the agent was streaming during the clicks, so the read-only path was taken');
  }

  if (problems.length) fail(problems.slice(0, 3).join(' | '));

  /* ── 3. a second click must take over, not queue behind the first ────────
   *
   * Reported as "switching sessions while one is loading won't stop the first one
   * so you have to wait for the first one to finish" (issue #39).
   *
   * The generation counter is what decides who owns the view, and every click has
   * to claim it. The guard that coalesced the agent-side switch used to return
   * before this point, so a second click left the generation untouched: the first
   * switch kept drawing and the second was only started once everything the first
   * one did had finished. Counting the bumps measures exactly that difference -
   * it cannot be satisfied by parking the click. */
  await evalJs('window.__frames.length = 0;');
  const gens = JSON.parse(await evalJs(`(() => {
    const before = switchGen;
    switchToSession('/tmp/supersede-1.jsonl').catch(() => {});
    switchToSession('/tmp/supersede-2.jsonl').catch(() => {});
    return JSON.stringify({ before, after: switchGen });
  })()`));
  await sleep(5000);
  const sent = JSON.parse(await evalJs(`JSON.stringify(window.__frames.filter((m) => m.type === 'switch_session').map((m) => m.sessionPath))`));
  console.log('  two clicks: generation ' + gens.before + ' -> ' + gens.after + ', frames ' + JSON.stringify(sent));
  if (gens.after - gens.before !== 2) {
    fail(`two clicks moved the generation ${gens.after - gens.before} time(s) - the second click was parked instead of taking over the view (issue #39)`);
  }
  if (sent.length > 2) fail(`${sent.length} switches sent for two clicks - the agent-side switch is no longer coalesced`);
  console.log('  PASS a second click takes over immediately, and the agent still gets at most one switch per click');
  ws.close(); cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
