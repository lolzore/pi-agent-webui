/*
 * Issue #42, reopened: "the issue has not been fixed and those items are still
 * moving while the agent is writing. Something to do with the autoscroll, since
 * when I scroll a tiny bit up it stops."
 *
 * That last sentence is what made it findable. Scrolling up clears S.stickToBottom,
 * which stops scrollBottom() being called - so the mover is in the sticky-to-bottom
 * path. It is not the text: the whole composer dock moves, and the dock is
 * `position: sticky; bottom: 0` INSIDE the transcript scroller (deliberate - that is
 * what makes the scrollbar reach the bottom of the window).
 *
 * A sticky element's position is computed from the sticky constraint, so it depends
 * on where the content ends. A transcript's height is fractional and changes with
 * every streamed token, so the required offset keeps landing on a half pixel and the
 * browser's rounding flips between the two choices. Measured while a reply streamed
 * into a 140-message transcript, recording the dock's top edge every frame:
 *
 *     bottom: 0    -> 519, 518.5, 519, ...   flipping
 *     bottom: 1px  -> 518, 518, 518, ...     stable
 *
 * This reproduces that without an agent: grow the transcript a little every frame
 * and pin, exactly as streaming does. It measures BOTH values - the one in the
 * stylesheet and the old `bottom: 0` - because the check is only worth anything if
 * the old value really does flip here. If a browser change ever makes this
 * unreproducible, the second half fails and says so rather than passing quietly.
 *
 * Usage: node test-composer-jitter.js <baseUrl> <browserPath>
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
if (!base) { console.error('usage: node test-composer-jitter.js <baseUrl> <browserPath>'); process.exit(2); }
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const PORT = 9972 + (process.pid % 12);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-jitter-'));
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
  // A viewport short enough that a tall transcript has somewhere to scroll.
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 620, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/' });
  await sleep(3000);
  for (let i = 0; i < 60; i++) {
    if (await evalJs("typeof scrollBottom === 'function' && !!document.getElementById('composer-dock') ? 1 : 0")) break;
    await sleep(250);
  }

  /* One measurement. `bottom` is null for "whatever the stylesheet says", which is
   * the shipped value; otherwise it is forced, including the old 0.
   *
   * A synthetic block is appended to the transcript so it overflows, then grown a
   * little every frame with a pin after each growth - which is what streaming does
   * to the real thing. Nothing about the app's own state is changed beyond that. */
  const measure = async (bottom) => {
    const raw = await evalJs(`(async () => {
      const dock = document.getElementById('composer-dock');
      const sc = chatScroller();
      const chat = document.getElementById('chat');
      const prevBottom = dock.style.bottom;
      const prevStick = S.stickToBottom;
      if (${JSON.stringify(bottom)} !== null) dock.style.bottom = ${JSON.stringify(bottom)};
      S.stickToBottom = true;

      const block = document.createElement('div');
      block.style.cssText = 'height:9000px;margin:0';
      chat.appendChild(block);
      sc.scrollTop = sc.scrollHeight;

      const tops = [];
      await new Promise((resolve) => {
        let n = 0;
        const step = () => {
          // grow by an odd fraction of a pixel, the way text does
          block.style.height = (9000 + n * 2.7) + 'px';
          scrollBottom(true);
          tops.push(+dock.getBoundingClientRect().top.toFixed(3));
          if (++n < 150) requestAnimationFrame(step); else resolve();
        };
        requestAnimationFrame(step);
      });

      const styledBottom = getComputedStyle(dock).bottom;
      const position = getComputedStyle(dock).position;
      block.remove();
      dock.style.bottom = prevBottom;
      S.stickToBottom = prevStick;
      sc.scrollTop = sc.scrollHeight;
      return JSON.stringify({ tops, styledBottom, position, docHeight: document.documentElement.scrollHeight });
    })()`);
    const r = JSON.parse(raw);
    r.uniq = [...new Set(r.tops)];
    return r;
  };

  const shipped = await measure(null);
  const old = await measure('0px');
  const onePx = await measure('1px');

  const show = (label, r) => `  ${label.padEnd(20)} position=${r.position} bottom=${String(r.styledBottom).padEnd(6)} ` +
    `${r.uniq.length} distinct top value(s): ${JSON.stringify(r.uniq.slice(0, 5))}`;
  console.log(show('as shipped', shipped));
  console.log(show('bottom: 1px (forced)', onePx));
  console.log(show('bottom: 0 (the old one)', old));

  if (shipped.tops.length < 100) fail(`only ${shipped.tops.length} frames measured - the check did not run`);
  if (shipped.position !== 'sticky') fail(`the dock is ${shipped.position}, not sticky - the pinned design was changed`);
  if (old.uniq.length < 2) {
    fail('bottom: 0 does NOT flip in this browser any more, so this check can no longer detect a regression. ' +
      'Fix the check (or delete it) rather than leaving it green: it is only worth having because the old value really moves.');
  }
  if (shipped.uniq.length !== 1) {
    fail(`the composer dock moved in ${shipped.uniq.length} distinct positions (${JSON.stringify(shipped.uniq.slice(0, 6))}) - ` +
      'issue #42 is back. The whole dock shifts, not just the text, and it is the sticky landing on a half pixel at bottom: 0.');
  }
  if (onePx.uniq.length !== 1) fail('bottom: 1px is not stable either, so the value in the stylesheet is not the thing keeping it still');
  ok(`the composer dock never moved (top ${shipped.uniq[0]} in all ${shipped.tops.length} frames) while the transcript grew`);

  // and it still sticks: the whole point of the element being there
  const sticks = JSON.parse(await evalJs(`(() => {
    const dock = document.getElementById('composer-dock');
    const sc = chatScroller();
    const block = document.createElement('div');
    block.style.cssText = 'height:9000px';
    document.getElementById('chat').appendChild(block);
    sc.scrollTop = sc.scrollHeight;
    const atBottom = dock.getBoundingClientRect().top;
    sc.scrollTop = 0;
    const atTop = dock.getBoundingClientRect().top;
    const visible = atTop >= 0 && atTop < window.innerHeight;
    block.remove();
    sc.scrollTop = sc.scrollHeight;
    return JSON.stringify({ atBottom, atTop, visible });
  })()`));
  if (!sticks.visible) fail('scrolled to the very top of the transcript the dock left the screen - it is not sticking any more');
  if (Math.abs(sticks.atTop - sticks.atBottom) > 1) fail(`the dock sits at ${sticks.atTop} at the top of the transcript and ${sticks.atBottom} at the bottom - it should be pinned in both`);
  ok(`the dock is still pinned while scrolling (${sticks.atTop} at the top of the transcript, ${sticks.atBottom} at the bottom)`);

  if (problems.length) fail(problems.slice(0, 3).join(' | '));
  ws.close(); cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
