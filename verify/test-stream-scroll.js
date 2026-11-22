/*
 * Issue #160: "At non thinking long responses the text goes the top first and
 * after some lines it snaps to the bottom and repeats until it finishes."
 *
 * The message being streamed must never have its size estimated. It is a .msg
 * like the rest, and the transcript skips off-screen messages
 * (content-visibility: auto, issue #150) - but a message whose content is
 * replaced several times a second and whose size is remembered from an earlier
 * frame changes the transcript's height under the scroller, so the view jumps
 * between the top and the bottom of the answer.
 *
 * This drives a real stream over a heavy transcript and watches the scroller:
 * the gap to the bottom has to stay at zero (we pin it), the finished messages
 * must still skip off-screen layout (the #150 win), and the streaming one must
 * not.
 *
 * Usage: node test-stream-scroll.js <browserPath>
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const browser = process.argv[2];
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }
const ROOT = path.resolve(__dirname, '..');
const PORT = 26700 + (process.pid % 200);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-scroll-'));
fs.mkdirSync(path.join(scratch, 'agent'), { recursive: true });
fs.mkdirSync(path.join(scratch, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'webui.json'), JSON.stringify({ onboarded: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bridge = null;
const cleanup = () => { try { if (bridge) bridge.kill(); } catch { /* gone */ } try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ } };
process.on('exit', cleanup);
(async () => {
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: path.join(scratch, 'agent'), PI_CODING_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_SESSION_DIR: path.join(scratch, 'sessions'), WORKSPACE_DIR: scratch,
      PI_SESSION_DIR: path.join(scratch, 'sessions'), PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'),
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_LLAMA_SCAN: 'off', PORT: String(PORT),
    }), stdio: ['ignore', 'ignore', 'pipe'],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { await new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: PORT, path: '/api/health' }, (r) => { r.resume(); r.on('end', res); }).on('error', rej); }); up = true; break; } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('bridge never came up');
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-scroll-b-'));
  const launched = require('./ws-min.js').launchBrowser(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--window-size=1280,800', '--user-data-dir=' + userDir, 'about:blank']);
  const child = launched.child;
  const cleanupBrowser = () => { try { child.kill(); } catch { /* gone */ } try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ } };
  process.on('exit', cleanupBrowser);
  let DBG = 0; try { DBG = await launched.port; } catch (e) { fail(e.message); }
  let page = null;
  for (let i = 0; i < 100; i++) {
    try { const list = await new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: DBG, path: '/json/list' }, (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej); }); page = (list || []).find((t) => t.type === 'page'); if (page) break; } catch { /* not ready */ }
    await sleep(150);
  }
  if (!page) fail('browser never exposed a page');
  const WS = require('./ws-min.js');
  const ws = new WS(page.webSocketDebuggerUrl); await ws.open();
  let id = 0; const pending = new Map(); const problems = [];
  ws.onmessage = (raw) => { let m; try { m = JSON.parse(raw); } catch { return; } if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; } if (m.method === 'Runtime.exceptionThrown') { const e = m.params.exceptionDetails || {}; problems.push(((e.exception && (e.exception.description || e.exception.value)) || e.text || '?')); } };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw'); return r.result && r.result.result ? r.result.result.value : undefined; };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 160; i++) {
    if (await evalJs("typeof startLive === 'function' && typeof applyDelta === 'function' && typeof S === 'object' && (S.historyRender || 0) > 0 ? 1 : 0")) break;
    await sleep(250);
  }
  const out = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    // a heavy transcript, like a long-lived tab: this is what #150's skipping is for
    const chat = document.getElementById('chat');
    for (let i = 0; i < 300; i++) {
      const d = document.createElement('div');
      d.className = 'msg';
      d.innerHTML = '<div class="who">pi</div><div class="bubble">message ' + i + ' with enough text to lay out a few lines of its own.</div>';
      chat.appendChild(d);
    }
    await new Promise((r) => requestAnimationFrame(r));
    const sc = chatScroller();
    const gapAt = () => Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight);
    const samples = [];
    startLive();
    const live = S.live.root;
    const styles = { streaming: getComputedStyle(live).contentVisibility, streamingCis: getComputedStyle(live).containIntrinsicSize };
    for (let i = 0; i < 120; i++) {
      applyDelta({ type: 'text_delta', delta: 'line ' + i + ' of a long non-thinking answer that keeps going.\\n\\n' });
      await new Promise((r) => setTimeout(r, 40));
      samples.push({ gap: gapAt(), top: Math.round(live.getBoundingClientRect().top), h: Math.round(live.getBoundingClientRect().height) });
    }
    const finished = chat.querySelector('.msg:not(.streaming)');
    styles.finished = finished ? getComputedStyle(finished).contentVisibility : null;
    return { samples, styles, stick: S.stickToBottom };
  })()))()`));
  const gaps = out.samples.map((s) => s.gap);
  const maxGap = Math.max(...gaps);
  const grew = out.samples[out.samples.length - 1].h > out.samples[0].h;
  if (out.styles.streaming !== 'visible') fail('the streaming message still has its size estimated (' + out.styles.streaming + ') - that is what makes the view jump');
  if (out.styles.finished !== 'auto') fail('finished messages stopped skipping off-screen layout (issue #150 would come back): ' + out.styles.finished);
  if (!grew) fail('the streamed message never grew, so nothing was measured');
  if (maxGap > 8) fail(`the view left the bottom while streaming (worst gap ${maxGap}px) - it should stay pinned`);
  if (!out.stick) fail('stick-to-bottom turned itself off during the stream');

  /* Issue #195: content that grows after the insertion that caused it. A long
   * tool call expands when it finishes (and images/diffs land a frame later);
   * the one-shot pin at insert time left the view short of the bottom. */
  const grown = JSON.parse(await evalJs(`(async () => {
    const live = S.live && S.live.root;
    if (!live) return JSON.stringify({ missing: true });
    const bubble = live.querySelector('.bubble');
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.style.height = '600px';
    bubble.appendChild(card);
    await new Promise((r) => setTimeout(r, 180));
    const sc = chatScroller();
    return JSON.stringify({
      gap: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight),
      stick: S.stickToBottom,
    });
  })()`));
  if (grown.missing) fail('the live message disappeared before the long-tool-call check');
  if (!grown.stick) fail('stick-to-bottom turned itself off when the tool card grew');
  if (grown.gap > 8) fail(`the view did not follow a tool card that grew after insertion (gap ${grown.gap}px)`);
  console.log(`  after a 600px tool card grew in place: gap to bottom ${grown.gap}px`);
  /* Issue #199: settling the turn must not replace the row that was already on
   * screen. The live markdown element has to survive finalization; a new render
   * with the same text is still a reflow. */
  const settled = JSON.parse(await evalJs(`(async () => {
    const live = S.live && S.live.root;
    if (!live) return JSON.stringify({ missing: true });
    const bubble = live.querySelector('.bubble');
    // the synthetic growth card from the check above is not part of the message
    for (const n of [...bubble.children]) {
      if (n.classList && n.classList.contains('tool-card') && !n.querySelector('.tool-head')) n.remove();
    }
    const md = live.querySelector('.md');
    const before = md.getBoundingClientRect().top;
    const text = S.live.text;
    finalizeLive({ role: 'assistant', timestamp: Date.now(), content: [{ type: 'text', text }] });
    await new Promise((r) => setTimeout(r, 120));
    return JSON.stringify({
      same: md.isConnected && document.contains(md),
      shift: Math.round(md.getBoundingClientRect().top - before),
      streaming: live.classList.contains('streaming'),
      final: !S.live,
    });
  })()`));
  if (settled.missing) fail('the live message disappeared before the finalize check');
  if (!settled.same) fail('finalizing the turn replaced the live message with a new render (issue #199)');
  if (Math.abs(settled.shift) > 1) fail(`finalizing the turn moved the message by ${settled.shift}px`);
  if (settled.streaming) fail('the live message still has its streaming class after finalization');
  if (!settled.final) fail('S.live was not cleared after finalization');
  console.log(`  finalized in place: same .md element, vertical shift ${settled.shift}px`);
  /* Issue #266: in long, tool-heavy sessions a scroll event that the reader did
   * not cause (scroll anchoring, content-visibility realizing an off-screen
   * message) used to clear stick-to-bottom, so following stopped while the
   * user had never scrolled up. A layout scroll must re-pin; only a real
   * gesture may unfollow. */
  const follow = JSON.parse(await evalJs(`(async () => {
    const sc = chatScroller();
    S.stickToBottom = true;
    S.userScrolling = false;
    lastProgrammaticScroll = 0;
    sc.scrollTop = sc.scrollHeight;
    await new Promise((r) => setTimeout(r, 50));
    sc.scrollTop = sc.scrollHeight - sc.clientHeight - 300;
    await new Promise((r) => setTimeout(r, 150));
    const layout = { stick: S.stickToBottom, gap: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight) };
    sc.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
    sc.scrollTop = sc.scrollHeight - sc.clientHeight - 300;
    await new Promise((r) => setTimeout(r, 150));
    const user = { stick: S.stickToBottom };
    return JSON.stringify({ layout, user });
  })()`));
  if (!follow.layout.stick) fail('a layout-induced scroll cleared stick-to-bottom (issue #266)');
  if (follow.layout.gap > 8) fail(`the view did not re-pin after a layout-induced scroll (gap ${follow.layout.gap}px)`);
  if (follow.user.stick) fail('a real wheel-up did not stop following (issue #266 guard is too strict)');
  console.log(`  layout scroll re-pinned (gap ${follow.layout.gap}px); a wheel-up unfollowed`);
  /* The other way a reader scrolls: dragging the native scrollbar. That has no
   * wheel/touch event, so the pointerdown on the scroller has to mark intent -
   * the strict guard above must not fight it. A synthetic pointerdown keeps
   * this deterministic; whether the platform delivers one for its native
   * scrollbar is outside this test (a CDP drag does, but only when the headless
   * build actually paints a classic bar). */
  const drag = JSON.parse(await evalJs(`(async () => {
    const sc = chatScroller();
    S.stickToBottom = true; S.userScrolling = false; scrollbarIntent = false;
    sc.scrollTop = sc.scrollHeight;
    await new Promise((r) => setTimeout(r, 80));
    const box = sc.getBoundingClientRect();
    sc.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: box.right - 2, clientY: box.top + 40 }));
    const marked = scrollbarIntent;
    sc.scrollTop = sc.scrollHeight - sc.clientHeight - 300;
    await new Promise((r) => setTimeout(r, 120));
    const stick = S.stickToBottom;
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
    await new Promise((r) => setTimeout(r, 50));
    return JSON.stringify({ marked, stick, intent: scrollbarIntent });
  })()`));
  if (!drag.marked) fail('a pointerdown on the scrollbar was not recognised as reader intent');
  if (drag.stick) fail('a scroll after a scrollbar pointerdown did not stop following: ' + JSON.stringify(drag));
  console.log('  a scrollbar pointerdown marks reader intent and unfollows');
  /* Keyboard scrolling has no wheel/touch/scrollbar event either. PageUp (and
   * Home / the arrows) must be able to stop following too, or the strict
   * layout-scroll guard re-pins the transcript under the reader. */
  const keyboard = JSON.parse(await evalJs(`(async () => {
    const sc = chatScroller();
    S.stickToBottom = true; S.userScrolling = false; scrollbarIntent = false;
    clearTimeout(userScrollIdle);
    lastProgrammaticScroll = 0;
    sc.scrollTop = sc.scrollHeight;
    await new Promise((r) => setTimeout(r, 80));
    sc.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    const marked = S.userScrolling;
    sc.scrollTop = sc.scrollHeight - sc.clientHeight - 300;
    await new Promise((r) => setTimeout(r, 120));
    const stick = S.stickToBottom;
    return JSON.stringify({ marked, stick });
  })()`));
  if (!keyboard.marked) fail('a PageUp keydown was not recognised as reader intent');
  if (keyboard.stick) fail('a keyboard scroll did not stop following: ' + JSON.stringify(keyboard));
  console.log('  a PageUp keydown marks reader intent and unfollows');
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));
  console.log(`  120 chunks: worst gap to the bottom ${maxGap}px, message grew to ${out.samples[out.samples.length - 1].h}px; streaming content-visibility ${out.styles.streaming}, finished ${out.styles.finished}`);
  console.log('  PASS #160/#195/#199 a long answer stays pinned, growth re-pins, and the final frame does not replace the row');
  cleanupBrowser(); cleanup(); process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
