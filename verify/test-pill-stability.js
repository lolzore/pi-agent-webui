/*
 * Issue #118: the model/thinking pills and their arrows moved up and down while
 * the agent worked, while the counters beside them stayed put.
 *
 * The pills rewrite their label from every state sync, and a replaced text node
 * is re-shaped from scratch - the resulting line box can be a fraction taller or
 * shorter, which moved the pill's border and the ::after arrow. The writers now
 * only write when the text changed, and the pills' height/line box is pinned
 * (the arrow sits on the baseline).
 *
 * This runs its own bridge and checks both halves: the text node survives
 * repeated syncs, and the pill's height and the arrow's alignment stay the same
 * for very different labels.
 *
 * Usage: node test-pill-stability.js <browserPath>
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
const PORT = 23200 + (process.pid % 300);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-pills-'));
fs.mkdirSync(path.join(scratch, 'agent'), { recursive: true });
fs.mkdirSync(path.join(scratch, 'sessions'), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bridge = null;
const cleanup = () => {
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);

const getJson = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

(async () => {
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_SESSION_DIR: path.join(scratch, 'sessions'),
      WORKSPACE_DIR: scratch,
      PI_SESSION_DIR: path.join(scratch, 'sessions'),
      PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'),
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_LLAMA_SCAN: 'off',
      PORT: String(PORT),
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let bridgeErr = '';
  bridge.stderr.on('data', (c) => { bridgeErr += c; });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const d = await getJson('/api/health'); if (d && d.ok) { up = true; break; } } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('the scratch bridge never came up\n' + bridgeErr.slice(-500));

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-pills-browser-'));
  const launched = require('./ws-min.js').launchBrowser(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--user-data-dir=' + userDir,
    'about:blank',
  ]);
  const child = launched.child;
  let browserErr = '';
  child.stderr.on('data', (c) => { browserErr += c; });
  const cleanupBrowser = () => {
    try { child.kill(); } catch { /* gone */ }
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ }
  };
  process.on('exit', cleanupBrowser);

  let DBG_PORT = 0;
  try { DBG_PORT = await launched.port; } catch (e) { fail(e.message); }
  let page = null;
  for (let i = 0; i < 100; i++) {
    try {
      const list = await new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port: DBG_PORT, path: '/json/list' }, (r) => {
          let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
          r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
        }).on('error', rej);
      });
      if (Array.isArray(list)) { page = list.find((t) => t.type === 'page'); if (page) break; }
    } catch { /* not ready yet */ }
    await sleep(150);
  }
  if (!page) fail('browser never exposed a page on the debug port\n' + browserErr.slice(-400));

  const WS = require('./ws-min.js');
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.open();
  let id = 0; const pending = new Map(); const problems = [];
  ws.onmessage = (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails || {};
      problems.push(((e.exception && (e.exception.description || e.exception.value)) || e.text || '?'));
    }
  };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw');
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 100; i++) {
    if (await evalJs("typeof updateModelBtn === 'function' && typeof updateThinkingBtn === 'function' ? 1 : 0")) break;
    await sleep(250);
  }

  const out = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const res = {};
    const measure = (id) => {
      const b = $(id);
      const r = b.getBoundingClientRect();
      const af = getComputedStyle(b, '::after');
      /* The label is its own span now, with a fixed 16px line box. Measure the
       * text's own rect as well as the pill's: the bug this guards against moved
       * the text *inside* a pill whose border and arrow stood still, so a check
       * that only looks at the pill cannot see it. */
      const label = b.querySelector('.pill-label');
      let text = null;
      if (label) {
        const rg = document.createRange();
        rg.selectNodeContents(label);
        const tb = rg.getBoundingClientRect();
        text = { y: tb.y, h: tb.height };
      }
      /* Issue #151: the arrow must not be part of the text's line box at all -
       * that is what let it move while the pill stood still. Its painted place
       * is fixed by the pill: absolute, right 8px, 2px above the middle. */
      return { y: r.y, h: r.height, text, after: af.verticalAlign, lineH: getComputedStyle(b).lineHeight, afPos: af.position, afRight: af.right, afTop: af.top, afMarginTop: af.marginTop, padRight: getComputedStyle(b).paddingRight };
    };
    // 1. the label span and its text node survive repeated syncs (it used to be
    //    replaced every time, and a replaced text node is re-shaped from scratch)
    const node = $('model-btn').firstChild;
    const textNode = node && node.firstChild;
    for (let i = 0; i < 10; i++) updateModelBtn();
    for (let i = 0; i < 10; i++) updateThinkingBtn();
    res.sameNode = $('model-btn').firstChild === node && !!node && node.classList.contains('pill-label');
    res.sameTextNode = !!node && node.firstChild === textNode && textNode && textNode.nodeType === 3;
    // 2. very different labels must not change the pill's height or the arrow's place
    const sel = $('model-select');
    const opt = sel.options[sel.selectedIndex] || sel.options[0];
    const original = opt ? opt.textContent : '';
    if (opt) opt.textContent = 'A very long model name that would wrap if the box let it';
    updateModelBtn();
    const long = measure('model-btn');
    if (opt) opt.textContent = 'max';
    updateModelBtn();
    const short = measure('model-btn');
    if (opt) opt.textContent = original;
    updateModelBtn();
    res.long = long; res.short = short;
    // 3. the same for the thinking pill with different levels
    const tsel = $('thinking-select');
    const topt = tsel.options[tsel.selectedIndex] || tsel.options[0];
    const torig = topt ? topt.value : '';
    if (topt) topt.value = 'high';
    updateThinkingBtn();
    const high = measure('thinking-btn');
    if (topt) topt.value = 'off';
    updateThinkingBtn();
    const off = measure('thinking-btn');
    if (topt) topt.value = torig;
    updateThinkingBtn();
    res.high = high; res.off = off;
    /* Issue #136: drive the real writers with changing values and sample the
     * fractional y/height of the pills, the turn timer and the ctx label. */
    const samples = [];
    for (let i = 0; i < 30; i++) {
      if (typeof paintRunStat === 'function') { S.runStartTs = Date.now() - i * 1700; paintRunStat(); }
      const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
      set('stat-tokens', 'up ' + i + '.' + i + 'k down ' + (i * 3) + '.' + i + 'M');
      set('stat-cost', i ? '$' + i + '.' + i + i : '');
      set('ctx-label', i + '.' + i + 'k / 1.0M (' + i + '%)');
      set('stat-turn', 'total ' + i + 'm ' + i + 's');
      updateModelBtn(); updateThinkingBtn();
      const box = (id) => { const b = $(id).getBoundingClientRect(); return b.y.toFixed(2) + '/' + b.height.toFixed(2); };
      const labelBox = (id) => {
        const label = $(id).querySelector('.pill-label');
        if (!label) return 'missing';
        const rg = document.createRange(); rg.selectNodeContents(label);
        const b = rg.getBoundingClientRect();
        return b.y.toFixed(2) + '/' + b.height.toFixed(2);
      };
      samples.push({ m: box('model-btn'), t: box('thinking-btn'), mt: labelBox('model-btn'), tt: labelBox('thinking-btn'), turn: box('stat-turn'), ctx: box('ctx-label') });
      await new Promise((r) => setTimeout(r, 40));
    }
    const uniq = (f) => [...new Set(samples.map(f))];
    res.drift = {
      model: uniq((s) => s.m), think: uniq((s) => s.t),
      modelText: uniq((s) => s.mt), thinkText: uniq((s) => s.tt),
      turn: uniq((s) => s.turn), ctx: uniq((s) => s.ctx),
    };
    /* Issue #151: every child's offset inside the row must be a whole pixel.
     * The 23px pill centered in the 46px row sat at 11.5, and Firefox rounds a
     * half-pixel differently as the page's fractional scroll offset drifts -
     * the pills hopped while the rest of the row stood still. */
    const barTop = $('stats-bar').getBoundingClientRect().y;
    res.offsets = Array.from($('stats-bar').children).map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.id || el.className, off: +(r.y - barTop).toFixed(3), h: +r.height.toFixed(3) };
    });
    return res;
  })()))()`));

  if (!out.sameNode) fail('updateModelBtn replaced the label span on every sync - the jitter can come back');
  if (!out.sameTextNode) fail('updateModelBtn replaced the text node on every sync - the jitter can come back');
  if (out.long.h !== out.short.h) fail(`the pill height changed with the label: ${out.long.h} vs ${out.short.h}`);
  for (const [name, a, b] of [['model', out.long, out.short], ['thinking', out.high, out.off]]) {
    if (!a.text || !b.text) fail(`the ${name} pill has no .pill-label span`);
    if (a.text.y !== b.text.y) fail(`the ${name} text moved inside its pill: ${a.text.y} vs ${b.text.y}`);
    if (a.text.h !== b.text.h) fail(`the ${name} text's line box changed: ${a.text.h} vs ${b.text.h}`);
    const offset = a.text.y - a.y;
    if (Math.abs(offset - Math.round(offset)) > 0.01) {
      fail(`the ${name} label sits on a half-pixel inside its pill (offset ${offset.toFixed(2)}px) - Firefox re-rounds that while the dock scrolls`);
    }
  }
  for (const [name, a, b] of [['model', out.long, out.short], ['thinking', out.high, out.off]]) {
    if (a.afPos !== 'absolute') fail(`the ${name} pill's arrow is still in the text flow (${a.afPos}) - it moves whenever the label re-shapes`);
    if (a.afRight !== '8px' || a.afMarginTop !== '-2px') fail(`the ${name} pill's arrow is not pinned: ${JSON.stringify([a.afRight, a.afMarginTop])}`);
    /* getComputedStyle resolves top: 50% to the used pixels; what matters is
     * that it is the same for every label (the arrow cannot hop). */
    if (a.afTop !== b.afTop) fail(`the ${name} pill's arrow moved with the label: top ${a.afTop} vs ${b.afTop}`);
    if (parseFloat(a.padRight) < 17) fail(`the ${name} pill leaves no room for its arrow (padding-right ${a.padRight}) - a long label would run under it`);
  }
  if (out.long.after !== out.short.after) fail(`the arrow alignment changed with the label: ${out.long.after} vs ${out.short.after}`);
  if (out.high.h !== out.off.h) fail(`the thinking pill height changed with the level: ${out.high.h} vs ${out.off.h}`);
  if (out.long.y !== out.short.y || out.high.y !== out.off.y) fail('the pill moved with the label: ' + JSON.stringify(out));
  const half = (out.offsets || []).filter((o) => Math.abs(o.off - Math.round(o.off)) > 0.01 || Math.abs(o.h - Math.round(o.h)) > 0.01);
  if (half.length) fail('a stats-row child sits on a half-pixel, which Firefox rounds differently while the page scrolls: ' + JSON.stringify(half));
  for (const [name, values] of Object.entries(out.drift || {})) {
    if (values.length !== 1) fail(`the ${name} moved while the values changed: ${JSON.stringify(values)}`);
  }
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));

  console.log(`  text node kept: ${out.sameNode}; height ${out.short.h}px for "max" and ${out.long.h}px for the long name; arrow ${out.short.after}; thinking ${out.off.h}px`);
  console.log('  PASS #118 the picker pills keep their height and their arrow when the label changes');
  cleanupBrowser();
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
