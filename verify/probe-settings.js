/*
 * Probe for issue #45: "When opening the settings menu the very first scroll bar
 * there is lagging. Switching to another tab and switching back will fix the
 * issue. Additionally this only appears the first load after that it is fine."
 *
 * The scout could not decide this from the source, and it is right: nothing in
 * the settings path writes scrollTop, and scrollbar-gutter: stable is already
 * set. So this measures the things that would produce that description.
 *
 *  1. Does the visible panel keep changing height after the dialog opens? A thumb
 *     that moves under the cursor while you are dragging it is felt as lag, it
 *     would be a once-per-page-load effect (the work that causes it is one-time),
 *     and switching tabs would hide it - the three things the report describes.
 *  2. Is there a long task at open time, in a specific function?
 *  3. What does one scroll of the panel cost, first against later?
 *  4. Does scrollbar-width: thin (the working-tree value) change any of it?
 *
 * Usage: node probe-settings.js <baseUrl> <browserPath>
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = process.argv[2];
const browser = process.argv[3];
if (!base || !browser) { console.error('usage: node probe-settings.js <baseUrl> <browserPath>'); process.exit(2); }

const PORT = 9910 + (process.pid % 60);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-settings-'));
const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDir,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
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
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length / 2)].toFixed(2) : null; };

(async () => {
  let ver = null;
  for (let i = 0; i < 100; i++) { try { ver = await getJson('/json/version'); break; } catch { await sleep(150); } }
  if (!ver) { console.error('browser never came up'); process.exit(1); }

  const WS = require('./ws-min.js');
  const page = (await getJson('/json/list')).find((t) => t.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.open();
  let id = 0; const pending = new Map();
  ws.onmessage = (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw');
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const json = async (expr) => JSON.parse(await evalJs(`JSON.stringify(${expr})`));
  // JSON.stringify cannot see through a promise, so for an async body the
  // stringify has to happen after the await.
  const jsonAsync = async (expr) => JSON.parse(await evalJs(`(async () => JSON.stringify(await (${expr})))()`));

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: base + '/' });
  await sleep(2000);

  const run = async (label, thin) => {
    // A fresh page load each time: the whole point is that this happens once.
    await send('Page.navigate', { url: base + '/' });
    await sleep(2500);
    await evalJs(`(() => {
      window.__long = [];
      try {
        new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); })
          .observe({ entryTypes: ['longtask'] });
      } catch {}
      ${thin === null ? '' : `const st = document.createElement('style'); st.textContent = '* { scrollbar-width: ${thin} !important }'; document.head.appendChild(st);`}
      return true;
    })()`);
    const out = await jsonAsync(`(async () => {
      const samples = [];
      const panelOf = () => document.querySelector('#settings-dialog .tab-panel:not(.hidden)');
      const t0 = performance.now();
      openSettings();
      const openMs = performance.now() - t0;
      const p = panelOf();
      const dialog = $('settings-dialog');
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const q = panelOf();
        if (q) samples.push({ t: Math.round(performance.now() - t0), h: q.scrollHeight, c: q.clientHeight, d: dialog.getBoundingClientRect().height });
      }
      const p2 = panelOf();
      // what one scroll of the panel costs while the content settles, and after
      const cost = () => { const s = performance.now(); p2.scrollTop = 400; void p2.scrollHeight; return +(performance.now() - s).toFixed(2); };
      const first = [cost(), cost(), cost()];
      await new Promise((r) => setTimeout(r, 1500));
      const later = [cost(), cost(), cost()];
      const hs = samples.map((x) => x.h);
      const ds = samples.map((x) => Math.round(x.d));
      return {
        openMs: +openMs.toFixed(1),
        visible: !!p,
        scrollHeightFirst: hs[0], scrollHeightLast: hs[hs.length - 1],
        scrollHeightChanged: new Set(hs).size,
        dialogHeightChanged: new Set(ds).size,
        scrollable: p2 ? p2.scrollHeight > p2.clientHeight : null,
        first: first, later: later,
        longTasks: window.__long.slice(0, 8),
        computedScrollbarWidth: getComputedStyle(document.documentElement).scrollbarWidth,
      };
    })()`);
    out.first = median(out.first);
    out.later = median(out.later);
    console.log(`\n  [${label}] scrollbar-width: ${out.computedScrollbarWidth}`);
    console.log(`    openSettings() itself        : ${out.openMs} ms`);
    console.log(`    visible panel found          : ${out.visible}   scrollable: ${out.scrollable}`);
    console.log(`    panel scrollHeight over 2.4s : ${out.scrollHeightFirst} -> ${out.scrollHeightLast} (${out.scrollHeightChanged} distinct value(s))`);
    console.log(`    dialog height distinct values: ${out.dialogHeightChanged}`);
    console.log(`    one scroll, first / later    : ${out.first} ms / ${out.later} ms`);
    console.log(`    long tasks at open (ms)      : ${JSON.stringify(out.longTasks)}`);
    return out;
  };

  const a = await run('as shipped', null);
  const b = await run('forced auto', 'auto');
  const c = await run('forced thin', 'thin');

  console.log('\n  ── what this says ──');
  console.log(`    content settling after open : ${a.scrollHeightChanged > 1 ? 'YES - the panel keeps changing height, which moves the thumb while you drag' : 'no'}`);
  console.log(`    long task at open           : ${a.longTasks.length ? 'yes, ' + Math.max(...a.longTasks) + ' ms' : 'none'}`);
  console.log(`    scroll cost first vs later  : ${a.first} ms vs ${a.later} ms`);
  console.log(`    thin vs auto                : ${c.first} ms vs ${b.first} ms (first scroll)`);
  ws.close(); cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); console.error('probe failed: ' + (e && e.stack || e)); process.exit(1); });
