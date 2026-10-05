/*
 * Regression test for issue #2: the context label moved vertically while the
 * agent ran, with the numbers unchanged.
 *
 * Measured from the recording on the issue: the ring, the token counters and the
 * turn clock are static to the pixel, while the label's ink flips between
 * y=42..61 and y=44..63 - same 19px of ink, same glyphs (shifting one frame up
 * 2px makes it match the other to within its own same-state noise). So the
 * numbers were not changing. The element was being rewritten with the numbers
 * unchanged, up to twelve times a second, and a replaced text node is re-shaped
 * and re-measured from scratch.
 *
 * Two things are therefore asserted, both of which are causes rather than
 * symptoms:
 *
 *   1. calling setCtxRing with the SAME value does not replace the text node
 *      (node identity is preserved) - a replaced node is what could re-shape;
 *   2. the label's bounding box does not move vertically, for identical values or
 *      for values that change, and its height comes from the stylesheet rather
 *      than from font metrics.
 *
 * Usage: node test-ctx-ring.js <baseUrl> <browserPath>
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
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const PORT = 9600 + (process.pid % 300);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-ctx-'));
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

  const res = await evalJs(`(() => {
    const label = document.getElementById('ctx-label');
    if (!label || typeof setCtxRing !== 'function') return { error: 'label or setCtxRing missing' };

    const cs = getComputedStyle(label);
    const box = () => { const r = label.getBoundingClientRect(); return { top: +r.top.toFixed(3), h: +r.height.toFixed(3), w: +r.width.toFixed(3) }; };

    const CU = (t, w, p) => ({ tokens: t, contextWindow: w, percent: p });

    // 1. identical values must not replace the text node
    setCtxRing(CU(1000, 100000, 1));
    const n1 = label.firstChild;
    setCtxRing(CU(1000, 100000, 1));
    const n2 = label.firstChild;
    setCtxRing(CU(1000, 100000, 1));
    const n3 = label.firstChild;
    const stable = n1 === n2 && n2 === n3 && n1 !== null;

    // ...but a real change must still be written
    setCtxRing(CU(2000, 100000, 2));
    const n4 = label.firstChild;
    const changed = n4 !== n3 && /2\\.0K|2K/.test(label.textContent || '');
    const afterChange = label.textContent;

    // 2. the box must not move, for identical or for changing values
    const tops = []; const heights = []; const widths = [];
    const vals = [1000,1000,1000,1001,1050,1100,1400,2000,3333,5000,9000,15000,42000,99999,120000];
    for (let i = 0; i < vals.length; i++) {
      const t = vals[i];
      setCtxRing(CU(t, 100000, Math.min(100, (t / 100000) * 100)));
      const b = box();
      tops.push(b.top); heights.push(b.h); widths.push(b.w);
    }
    return {
      stable,
      changed,
      afterChange,
      computedLineHeight: cs.lineHeight,
      computedHeight: cs.height,
      topMin: Math.min(...tops), topMax: Math.max(...tops),
      hMin: Math.min(...heights), hMax: Math.max(...heights),
      wMin: Math.min(...widths), wMax: Math.max(...widths),
      text: label.textContent,
    };
  })()`);

  if (!res || res.error) fail('could not run the probe: ' + (res && res.error));

  const problems = [];
  if (!res.stable) problems.push('the text node is replaced when the value is unchanged (that is the re-shape that moved it)');
  if (!res.changed) problems.push('a real change was not written to the label');
  if (res.topMax - res.topMin > 0.5) problems.push(`the label moves vertically by ${(res.topMax - res.topMin).toFixed(2)}px (top ${res.topMin}..${res.topMax})`);
  if (res.hMax - res.hMin > 0.5) problems.push(`the label height changes by ${(res.hMax - res.hMin).toFixed(2)}px (${res.hMin}..${res.hMax})`);
  if (res.computedLineHeight !== '16px') problems.push(`line-height is ${res.computedLineHeight}, not the pinned 16px`);
  if (res.computedHeight !== '16px') problems.push(`height is ${res.computedHeight}, not the pinned 16px`);

  if (problems.length) fail(problems.join(' | '));

  console.log(`label stable: same value reuses the text node, top ${res.topMin}px over ${res.wMin}..${res.wMax}px of width, height ${res.hMin}px, line-height ${res.computedLineHeight}`);
  ws.close(); cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
