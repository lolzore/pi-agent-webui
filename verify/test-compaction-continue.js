/*
 * Issue #63: "Agent finished at high context and after compaction it was told
 * to continue even though it finished."
 *
 * pi's threshold/overflow compaction without retry runs either after a
 * completed response ("compact without retrying the completed response") or
 * mid-turn before the next assistant response - and in the mid-turn case pi
 * continues the turn itself. The WebUI mapped every non-manual willRetry:false
 * compaction to "continue the current task", so an agent that had finished was
 * sent a prompt of its own.
 *
 * The fix keeps the nudge for the one case it can help with - a turn that a
 * compaction stopped and that produced nothing afterwards - and drops it when
 * the turn had already ended, when the agent resumed, or when the user pressed
 * stop.
 *
 * This drives the real events through handleRpcMessage and records what
 * sendPrompt/rpc were asked to send, so the assertions are about prompts, not
 * about the UI that would have carried them.
 *
 * Usage: node test-compaction-continue.js <baseUrl> <browserPath>
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
if (!base) { console.error('usage: node test-compaction-continue.js <baseUrl> <browserPath>'); process.exit(2); }
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const PORT = 9970 + (process.pid % 25);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-compaction-continue-'));
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
    const sends = [];          // what sendPrompt was asked to send
    const rpcSends = [];       // what reached rpc as a prompt
    const realSend = sendPrompt;
    window.sendPrompt = (t, ...rest) => { sends.push(String(t || '')); return realSend(t, ...rest); };
    const realRpc = rpc;
    window.rpc = (m) => {
      if (m && m.type === 'prompt') { rpcSends.push(String(m.message || '')); return Promise.resolve({ ok: true }); }
      if (m && (m.type === 'clear_queue' || m.type === 'abort')) return Promise.resolve({ steering: [], followUp: [] });
      return realRpc(m);
    };
    const ev = (o) => handleRpcMessage(o);
    const reset = () => {
      S.live = null; S.liveDetached = null;
      S.compactionNeedsContinue = false; S.lastAutoContinueAt = 0; S.autoContinueStreak = 0;
      S.userStopped = false; S.turnEnded = true; S.outputSeq = 0; S.compactionSeq = 0;
      S.isStreaming = false; S.compacting = false; S.compactionHappened = false;
      sends.length = 0; rpcSends.length = 0;
    };
    const turn = (text) => {
      ev({ type: 'agent_start' });
      ev({ type: 'message_start', message: { role: 'assistant' } });
      if (text) ev({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
    };
    const finishTurn = () => {
      ev({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
      ev({ type: 'agent_end' });
      ev({ type: 'agent_settled' });
    };
    const compact = (reason, willRetry) => {
      ev({ type: 'compaction_start' });
      ev({ type: 'compaction_end', reason: reason, willRetry: !!willRetry, aborted: false,
           result: { summary: 's', tokensBefore: 100000, estimatedTokensAfter: 20000 } });
    };
    const settle = (extra) => ev(Object.assign({ type: 'agent_settled' }, extra || {}));
    const snap = () => ({ sends: sends.slice(), rpc: rpcSends.slice(), streak: S.autoContinueStreak });

    // A: the reported bug - the agent finished its turn, then a threshold
    //    compaction ran after it (pi's case 3), then the agent settled.
    reset();
    turn('all done'); finishTurn();
    compact('threshold', false);
    settle();
    out.finished = snap();

    // B: mid-turn compaction and the turn really stopped producing anything.
    //    This is the case the nudge exists for.
    reset();
    turn('partial work');
    compact('threshold', false);
    settle();
    out.stalled = snap();

    // C: mid-turn compaction, then the agent resumes and finishes.
    reset();
    turn('partial work');
    compact('threshold', false);
    turn('the rest of the work'); finishTurn();
    out.resumed = snap();

    // D: manual compaction never auto-continues.
    reset();
    turn('x');
    compact('manual', false);
    settle();
    out.manual = snap();

    // E: the user pressed stop - do not resurrect the task.
    reset();
    turn('x');
    compact('threshold', false);
    S.userStopped = true;
    settle();
    out.stopped = snap();

    // F: overflow with retry - pi continues itself.
    reset();
    turn('x');
    compact('overflow', true);
    settle();
    out.overflowRetry = snap();

    // G: pi 1.1.0 marks a cancelled run on agent_settled - never nudge it.
    reset();
    turn('x');
    compact('threshold', false);
    settle({ aborted: true });
    out.aborted = snap();

    window.sendPrompt = realSend;
    window.rpc = realRpc;
    return JSON.stringify(out);
  })()`);

  const r = JSON.parse(res);
  const show = (label, v) => console.log('  ' + label.padEnd(18) + JSON.stringify({ sendPrompt: v.sends.length, rpcPrompt: v.rpc.length, streak: v.streak }));
  show('finished turn', r.finished);
  show('stalled turn', r.stalled);
  show('resumed turn', r.resumed);
  show('manual', r.manual);
  show('user stopped', r.stopped);
  show('overflow retry', r.overflowRetry);
  show('aborted', r.aborted);

  if (r.finished.sends.length || r.finished.rpc.length) {
    fail('#63 a finished agent was told to continue after a threshold compaction: ' + JSON.stringify(r.finished));
  }
  if (r.stalled.sends.length !== 1 || r.stalled.rpc.length !== 1) {
    fail('the nudge for a turn a compaction really stopped is gone: ' + JSON.stringify(r.stalled));
  }
  if (!/Context was just compacted/.test(r.stalled.rpc[0])) {
    fail('the nudge text changed: ' + JSON.stringify(r.stalled.rpc[0]));
  }
  if (r.stalled.streak !== 1) fail('the auto-continue streak did not advance');
  if (r.resumed.sends.length || r.resumed.rpc.length) {
    fail('a turn that resumed after compaction was nudged anyway: ' + JSON.stringify(r.resumed));
  }
  if (r.manual.sends.length || r.manual.rpc.length) fail('a manual compaction auto-continued');
  if (r.stopped.sends.length || r.stopped.rpc.length) fail('a user stop was followed by an auto-continue');
  if (r.overflowRetry.sends.length || r.overflowRetry.rpc.length) fail('an overflow-with-retry compaction auto-continued');
  if (r.aborted.sends.length || r.aborted.rpc.length) fail('a run pi reported as aborted was auto-continued');
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));

  // Issue #56: Stop also cancels an in-flight retry and a running bash tool.
  const stopTypes = await evalJs(`(async () => {
    window.__rpcTypes = [];
    const real = rpc;
    window.rpc = (m) => {
      window.__rpcTypes.push(m && m.type);
      if (m && ['clear_queue', 'abort', 'abort_bash', 'abort_retry'].includes(m.type)) return Promise.resolve({ steering: [], followUp: [] });
      return real(m);
    };
    await stopAgent();
    window.rpc = real;
    return window.__rpcTypes;
  })()`);
  if (!stopTypes.includes('abort_bash') || !stopTypes.includes('abort_retry')) {
    fail('stop did not cancel the retry/bash tool: ' + JSON.stringify(stopTypes));
  }

  console.log('  PASS #63 a finished, resumed, manual or stopped turn is not nudged; a stalled one still is');
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
