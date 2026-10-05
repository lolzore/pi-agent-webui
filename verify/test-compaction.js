/*
 * The compaction cluster: issues #40, #47, #48, #42 and #38's loop.
 *
 * All five are decided in the page, so they are checked in the page rather than
 * through the bridge - no agent turn is needed, and none of the numbers depends on
 * a model. Each assertion was checked against the old code and fails there.
 *
 * #40  A compaction watched in session A was replayed into session B, because
 *      S.compactionMarks was never scoped to the session it happened in. Refresh
 *      fixed it (a fresh page starts the list empty) - which is the tell.
 * #47  estimatedTokensAfter and reason are computed by pi when it compacts,
 *      emitted on compaction_end, and never written to the session file, so the
 *      reloaded marker lost "-> 24.4K tok · manual" and kept only tokensBefore.
 * #48  showCompactionEstimate() looked the context window up in S.ctxStats, which
 *      every path into a compaction has just set to null, so it silently drew
 *      nothing and the ring never showed the post-compaction size.
 * #42  Three counters in the composer row wrote their text through a bare
 *      textContent assignment once a second even when the value had not changed;
 *      replacing a text node re-shapes it, which is the 1-2px hop issue #2 fixed
 *      for the label and the ring only.
 * #38  maybeAutoContinue() had a cooldown but no cap, so a context still over the
 *      window after a compaction looped forever.
 *
 * Usage: node test-compaction.js <baseUrl> <browserPath>
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = process.argv[2];
const browser = process.argv[3];
/* PI_TEST_KEEP_GOING=1 reports every failed check instead of stopping at the
 * first one. It is how each assertion here was shown to fail against the old
 * code: stopping at the first would only ever prove that one of them is real,
 * and a check that cannot fail is not a check. */
const KEEP_GOING = process.env.PI_TEST_KEEP_GOING === '1';
let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
  if (!KEEP_GOING) process.exit(1);
};
const done = () => {
  if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
  process.exit(0);
};
const ok = (m) => {
  // A section can report several failures and then reach its ok() line. Printing
  // PASS there would be a lie, so a PASS is only printed when nothing failed
  // since the previous one.
  if (failures > okMark) { okMark = failures; console.log('  NOT PASSING: ' + m); return; }
  console.log('  PASS ' + m);
};
let okMark = 0;
if (!base) { console.error('usage: node test-compaction.js <baseUrl> <browserPath>'); process.exit(2); }
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const PORT = 9900 + (process.pid % 80);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-compact-'));
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
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'eval threw';
      // An expression that throws because the thing it is checking does not exist
      // is a failed check, not a broken harness - so it is reported and, when
      // asked to keep going, does not stop the rest of the run.
      if (KEEP_GOING) { failures++; console.error('FAIL (threw): ' + String(msg).split('\n')[0]); return undefined; }
      throw new Error(msg);
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const json = async (expr) => {
    const v = await evalJs(`JSON.stringify(${expr})`);
    try { return JSON.parse(v); } catch { return {}; }   // missing piece -> assertions below report it
  };
  // Same, for an expression that returns a promise: JSON.stringify cannot see
  // through one, so the stringify has to happen after the await.
  const jsonAsync = async (expr) => {
    const v = await evalJs(`(async () => JSON.stringify(await (${expr})))()`);
    try { return JSON.parse(v); } catch { return {}; }
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: base + '/' });
  await sleep(1500);
  for (let i = 0; i < 80; i++) {
    if (await evalJs("typeof showCompactionEstimate === 'function' && typeof updateLiveDot === 'function' ? 1 : 0")) break;
    await sleep(250);
  }

  // ── #40 a mark knows which session it belongs to ───────────────────────────
  const mark = await json(`(() => {
    S.compactionMarks.length = 0;
    S.state.sessionFile = 'C:/sessions/A.jsonl';
    handleRpcMessage({ type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false,
      result: { summary: 'SUMMARY-A', tokensBefore: 833300, estimatedTokensAfter: 24400 } });
    const k = S.compactionMarks[S.compactionMarks.length - 1] || {};
    return { session: k.session || '', reason: k.reason || '', after: k.estimatedTokensAfter };
  })()`);
  console.log('  mark after compaction_end: ' + JSON.stringify(mark));
  if (!/A\.jsonl$/.test(mark.session)) fail('the mark was not tagged with the session it happened in: ' + JSON.stringify(mark.session));
  if (mark.reason !== 'manual') fail('the reason was not kept on the mark: ' + JSON.stringify(mark.reason));
  ok('#40 a compaction mark records the session and the reason');

  // ── #40 it is not replayed into another session ────────────────────────────
  /* Checked by rendering, not by calling the helper: the helper being right and
   * the call site forgetting to use it is exactly the bug, and a check that only
   * exercises the helper would pass with refreshMessages unchanged. */
  const leak = await jsonAsync(`(async () => {
    const cur = S.state.sessionFile;
    S.viewSession = null;
    S.compactionMarks.length = 0;
    S.compactionMarks.push({ summary: 'FOREIGN', session: 'C:/elsewhere/OTHER.jsonl', tokensBefore: 111, at: Date.now() });
    await refreshMessages();
    const foreign = chat.querySelectorAll('.msg.compaction').length;
    S.compactionMarks.push({ summary: 'MINE', session: cur, tokensBefore: 222, at: Date.now() });
    await refreshMessages();
    const mine = chat.querySelectorAll('.msg.compaction').length;
    S.compactionMarks.length = 0;
    await refreshMessages();
    return { cur: String(cur).slice(-16), foreign, mine };
  })()`);  console.log(`  rendering session …${leak.cur}: ${leak.foreign} marker(s) with only a foreign one, ${leak.mine} with its own`);
  if (leak.foreign !== 0) fail(`a compaction from another session was drawn into this one - issue #40 (${leak.foreign} marker(s))`);
  if (!(leak.mine >= 1)) fail('a compaction belonging to this session was not drawn at all');
  ok('#40 a foreign marker is not drawn, and this session\'s own still is');

  // ── #47 the two facts pi never writes down survive a reload ────────────────
  const facts = await json(`(() => {
    const bigSummary = 'S'.repeat(30000);
    saveCompactionFact('C:/sessions/A.jsonl', { summary: bigSummary, reason: 'threshold', estimatedTokensAfter: 12345, at: Date.now() });
    saveCompactionFact('C:/sessions/A.jsonl', { summary: 'SUMMARY-A', reason: 'manual', estimatedTokensAfter: 24400, at: Date.now() });
    const rec = loadCompactionFacts('C:/sessions/A.jsonl').get(summaryHash('SUMMARY-A'));
    const raw = localStorage.getItem(compactionFactKey('C:/sessions/A.jsonl')) || '';
    return { after: rec ? rec.a : null, reason: rec ? rec.r : null, stored: raw.length, summaryLen: bigSummary.length };
  })()`);
  console.log(`  stored ${facts.stored} bytes for two compactions whose summaries total ${facts.summaryLen + 9} bytes`);
  if (facts.after !== 24400 || facts.reason !== 'manual') fail('the after-count/reason did not come back: ' + JSON.stringify(facts));
  if (facts.stored > 600) fail(`localStorage holds ${facts.stored} bytes - the summary text is being stored (issue #47 must not do that)`);
  ok('#47 the after-count and reason survive a reload, without storing the summary');

  // ── #47 the marker draws them ─────────────────────────────────────────────
  const who = await evalJs(`buildCompactionSummary(
      { summary: 'x', tokensBefore: 833300, timestamp: Date.now() },
      { reason: 'manual', estimatedTokensAfter: 24400 }).querySelector('.who').textContent`);
  console.log('  rebuilt marker reads: ' + JSON.stringify(who));
  if (!/833\.3K/.test(who)) fail('tokensBefore missing from the marker: ' + who);
  if (!/24\.4K/.test(who)) fail('the after-count is still missing from the rebuilt marker (issue #47): ' + who);
  if (!/manual/.test(who)) fail('the reason is still missing from the rebuilt marker (issue #47): ' + who);
  ok('#47 the rebuilt marker shows both counts and the reason');

  // ── #48 the post-compaction estimate is actually shown ────────────────────
  /* Two things have to be true for the ring to show it, and it was neither:
   * the window has to be findable after compaction_start nulled S.ctxStats, and
   * the high-water marks from the old context have to go - otherwise the peak is
   * read as a floor and the estimate is pushed straight back up to it. The second
   * half is what the issue describes as "the counter stays the same". */
  const est = await json(`(() => {
    // A real stats read first, so the peak is populated the way a live session
    // leaves it - this is the number the compaction is supposed to replace.
    setCtxRing({ tokens: 656000, contextWindow: 1000000, percent: 65.6 });
    const peakBefore = S.ctxTurnPeak;
    S.isStreaming = true;              // mid-turn, which is when the clamp applies
    setCtxRing(null);                  // what compaction_start does
    const before = $('ctx-ring-text').textContent;
    showCompactionEstimate(25600);
    const out = {
      peakBefore, peakAfter: S.ctxTurnPeak, isStreaming: S.isStreaming,
      before, text: $('ctx-ring-text').textContent, label: $('ctx-label').textContent,
    };
    S.isStreaming = false;
    return out;
  })()`);
  console.log(`  peak ${est.peakBefore} -> ${est.peakAfter} (streaming: ${est.isStreaming}); ring before ${JSON.stringify(est.before)} -> after ${JSON.stringify(est.text)} ${JSON.stringify(est.label)}`);
  if (est.text === '–' || est.text === '') fail('the ring still shows nothing after a compaction (issue #48)');
  if (!/25\.6K/.test(est.label)) fail('the ring does not show the size the compaction reported: ' + est.label);
  if (est.peakAfter >= est.peakBefore) fail(`the pre-compaction high-water mark survived the compaction (${est.peakBefore} -> ${est.peakAfter}), so it can clamp the next number back up (issue #48)`);
  if (est.peakAfter > 25600) fail(`the peak is anchored above the post-compaction estimate (${est.peakAfter}), so the ring cannot fall to it (issue #48)`);
  ok('#48 the ring shows the post-compaction estimate, and the old peak is gone');

  // ── #42 the counters reuse their text node ────────────────────────────────
  const reuse = await json(`(() => {
    const same = (fn, el2) => { fn(); const a = el2().firstChild; fn(); const b = el2().firstChild; return a === b; };
    S.totals = { read: 5000, write: 5000 };
    const tokens = same(() => updateTotals(), () => $('stat-tokens'));
    S.runStartTs = Date.now() - 5000;
    const turn = same(() => paintRunStat(), () => $('stat-turn'));
    S.runStartTs = null;
    return { tokens, turn };
  })()`);
  console.log('  text node reused - tokens: ' + reuse.tokens + ', turn: ' + reuse.turn);
  if (!reuse.tokens) fail('updateTotals replaces the text node every tick, which is the hop in issue #42');
  if (!reuse.turn) fail('paintRunStat replaces the text node every tick, which is the hop in issue #42');
  ok('#42 the counters rewrite only when the value changed');

  // ── #41 the green dot follows the agent, and only the agent ───────────────
  const dots = await json(`(() => {
    const list = $('session-list');
    list.innerHTML = '';
    for (const p of ['C:/sessions/A.jsonl', 'C:/sessions/B.jsonl']) {
      const it = el('div', 'session-item');
      it.dataset.path = p;
      it.appendChild(el('div', 's-name', p.split('/').pop()));
      list.appendChild(it);
    }
    S.sessionsList = [{ path: 'C:/sessions/A.jsonl', fileName: 'A.jsonl' }, { path: 'C:/sessions/B.jsonl', fileName: 'B.jsonl' }];
    S.state.sessionFile = 'C:/sessions/A.jsonl';
    S.isStreaming = true;
    updateLiveDot();
    const running = [...list.querySelectorAll('.session-item.live')].map((x) => x.dataset.path);
    const countRunning = list.querySelectorAll('.live-dot').length;
    // The user switches to B while the agent keeps running in A, and the agent
    // starts another turn - the case the issue describes as stacking.
    list.querySelectorAll('.session-item')[1].classList.add('active');
    S.viewSession = 'C:/sessions/B.jsonl';
    updateLiveDot();
    updateLiveDot();
    const afterSwitch = [...list.querySelectorAll('.session-item.live')].map((x) => x.dataset.path);
    return { running, countRunning, afterSwitch, dotCount: list.querySelectorAll('.live-dot').length,
             active: [...list.querySelectorAll('.session-item.active')].map((x) => x.dataset.path) };
  })()`);
  console.log('  running in : ' + JSON.stringify(dots.running) + '  after switching to B: ' + JSON.stringify(dots.afterSwitch));
  if (dots.running.length !== 1 || !/A\.jsonl$/.test(dots.running[0])) fail('the dot is not on the session the agent is running in: ' + JSON.stringify(dots.running));
  if (dots.afterSwitch.length !== 1 || !/A\.jsonl$/.test(dots.afterSwitch[0])) {
    fail('the green dot stacked across a switch - issue #41: ' + JSON.stringify(dots.afterSwitch));
  }
  if (dots.dotCount !== 1) fail('more than one green dot on screen: ' + dots.dotCount);
  ok('#41 the green running dot stays on the agent\'s session');

  // ── #49 a message that was not delivered must not look delivered ───────────
  /* Reported as "after a manual compaction my message disappeared ... and after a
   * reload I can see that it never even happened". The row was drawn whatever
   * happened to the send, so a rejected prompt left a bubble on screen that the
   * next rebuild destroyed - because it was never in the session file.
   *
   * S.viewSession is cleared first: while it is set, transcriptHost() hands rows
   * to a detached fragment instead of the chat (so the agent's output cannot land
   * in a session you are only reading), and asserting on #chat would then pass
   * without anything having been drawn or removed. The row is counted the moment
   * it is drawn and again after the refusal, so "never drew it" cannot pass for
   * "took it back". */
  const failed = await jsonAsync(`(async () => {
    S.viewSession = null;
    const real = rpc;
    rpc = () => Promise.reject(new Error('agent is compacting'));
    input.value = '';
    let threw = null;
    try { sendPrompt('A MESSAGE THAT FAILS TO SEND', [], undefined, true); } catch (e) { threw = e.message; }
    const drawn = chat.querySelectorAll('.msg.user[data-live="1"]').length;
    await new Promise((r) => setTimeout(r, 60));
    rpc = real;
    return {
      threw,
      drawn,
      rows: chat.querySelectorAll('.msg.user[data-live="1"]').length,
      inComposer: input.value,
    };
  })()`);
  console.log(`  send refused: drawn ${failed.drawn} row(s), left ${failed.rows}, composer holds ${JSON.stringify(failed.inComposer)}`);
  if (failed.drawn < 1) fail('the optimistically drawn row was never there, so this check proves nothing');
  if (failed.rows !== 0) fail(`a message that failed to send is still on screen as if delivered (${failed.rows} row(s)) - issue #49`);
  if (failed.inComposer !== 'A MESSAGE THAT FAILS TO SEND') fail('the message was not put back in the composer: ' + JSON.stringify(failed.inComposer));
  ok('#49 a refused send leaves no row and gives the text back');

  // the accepted case must still draw the row, or this is not a fix but a removal
  const accepted = await jsonAsync(`(async () => {
    const real = rpc;
    rpc = () => Promise.resolve({});
    input.value = '';
    sendPrompt('A MESSAGE THAT IS ACCEPTED', [], undefined, true);
    await new Promise((r) => setTimeout(r, 60));
    rpc = real;
    const n = chat.querySelectorAll('.msg.user[data-live="1"]').length;
    for (const el of chat.querySelectorAll('.msg.user[data-live="1"]')) el.remove();
    return { rows: n, inComposer: input.value };
  })()`);
  console.log('  send accepted: ' + accepted.rows + ' row(s) drawn');
  if (accepted.rows < 1) fail('an accepted send drew no row at all');
  ok('#49 an accepted send still draws its row straight away');

  // ── #38 the automatic continuation is bounded ─────────────────────────────
  const loop = await json(`(() => {
    S.isStreaming = false; S.compacting = false;
    S.lastAutoContinueAt = 0; S.autoContinueStreak = 0;
    const sent = [];
    const realSend = sendPrompt;
    sendPrompt = (...a) => { sent.push(String(a[0]).slice(0, 24)); };
    try {
      for (let i = 0; i < 4; i++) { S.lastAutoContinueAt = 0; maybeAutoContinue(); }
    } finally { sendPrompt = realSend; }
    return { sent: sent.length, streak: S.autoContinueStreak };
  })()`);
  console.log(`  four chances to continue -> ${loop.sent} prompt(s) sent, streak ${loop.streak}`);
  if (loop.sent > 3) fail(`${loop.sent} automatic continuations in a row - the loop is unbounded (issue #38)`);
  if (loop.sent < 1) fail('the automatic continuation never fired at all');
  const reset = await json(`(() => { S.autoContinueStreak = 3; return { capped: S.autoContinueStreak }; })()`);
  if (reset.capped !== 3) fail('could not set the streak');
  ok('#38 the automatic continuation stops after a few in a row');

  if (problems.length) fail(problems.slice(0, 3).join(' | '));
  ws.close(); cleanup();
  done();
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
