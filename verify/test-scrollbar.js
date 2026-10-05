/*
 * The scrollbar: Firefox drew the classic control - a wide track, a square thumb
 * and an arrow button at each end - while Chromium drew the rounded accent-coloured
 * pill. Reported with a screenshot of both, wanting the Chromium one everywhere.
 *
 * The two engines need different values out of the same two properties:
 *
 *   - Firefox ignores ::-webkit-scrollbar entirely and draws whatever
 *     scrollbar-width says. `auto` gives it the bar with the arrow buttons; `thin`
 *     takes the buttons away and narrows it.
 *   - Chromium is already off the ::-webkit-scrollbar path, because setting
 *     `scrollbar-color` switches it to the standard bar (measured below: a custom
 *     bar asking for 30px reserves 30px on its own, and 15px once scrollbar-color
 *     is set). `thin` there would only narrow that bar from 15px to 10px.
 *
 * So the fix is `auto` globally with `thin` behind
 * `@supports not selector(::-webkit-scrollbar)`, which is Firefox. Firefox loses
 * its arrow buttons; Chromium does not change at all - deliberately, since the bar
 * it draws is the one worth keeping.
 *
 * Chromium cannot test Firefox. What it CAN test is that this browser is not caught
 * by the guard - which is how this breaks: the guarded block becomes a plain
 * `* { scrollbar-width: thin }` and Chromium's bar silently changes width. The
 * Firefox half is one reload away for a person; the CSS is checked structurally
 * here so CI cannot let it disappear unnoticed.
 *
 * Usage: node test-scrollbar.js <baseUrl> <browserPath>
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
if (!base) { console.error('usage: node test-scrollbar.js <baseUrl> <browserPath>'); process.exit(2); }
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const PORT = 9930 + (process.pid % 18);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-sb-'));
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
  await sleep(3000);
  for (let i = 0; i < 60; i++) {
    if (await evalJs("typeof S !== 'undefined' && !document.getElementById('settings-dialog')?.open ? 1 : 0")) break;
    await sleep(250);
  }

  const out = JSON.parse(await evalJs(`(() => {
    /* Walk the stylesheets, but count a bare '*' rule only at the TOP level of a
     * sheet - a rule inside @supports is the whole point and must not be counted as
     * if it were applied everywhere. The first version of this walked into the
     * @supports block and reported its own inner rule as unguarded. */
    const supports = [];      // { condition, setsThin }
    let bareThin = 0, bareAuto = 0;
    const top = (sheet) => {
      let rules; try { rules = sheet.cssRules; } catch { return; }
      for (const r of rules) {
        if (r.constructor && r.constructor.name === 'CSSSupportsRule') {
          const inner = [...r.cssRules].map((x) => x.cssText || '').join(';');
          supports.push({ condition: r.conditionText || '', setsThin: /scrollbar-width:\\s*thin/.test(inner) });
        } else if (r.selectorText === '*') {
          const t = r.style.cssText || '';
          if (/scrollbar-width:\\s*thin/.test(t)) bareThin++;
          if (/scrollbar-width:\\s*auto/.test(t)) bareAuto++;
        }
      }
    };
    for (const sheet of document.styleSheets) top(sheet);

    // What a plain element in this page actually computes to.
    const probe = document.createElement('div');
    probe.style.cssText = 'width:120px;height:40px;overflow-y:scroll';
    probe.innerHTML = '<div style="height:300px"></div>';
    document.body.appendChild(probe);
    const probeWidth = getComputedStyle(probe).scrollbarWidth;
    const reserved = probe.offsetWidth - probe.clientWidth;
    probe.remove();

    return JSON.stringify({
      supportsWebkit: CSS.supports('selector(::-webkit-scrollbar)'),
      bodyWidth: getComputedStyle(document.body).scrollbarWidth,
      probeWidth, reserved,
      supports, bareThin, bareAuto,
    });
  })()`));

  const firefoxGuard = out.supports.find((s) => /webkit-scrollbar/.test(s.condition) && s.setsThin);
  console.log(`  this browser supports ::-webkit-scrollbar: ${out.supportsWebkit}`);
  console.log(`  computed scrollbar-width on <body>: ${out.bodyWidth}, on a plain div: ${out.probeWidth} (reserved ${out.reserved}px)`);
  console.log(`  @supports rules seen: ${JSON.stringify(out.supports)}`);
  console.log(`  bare '*' rules setting thin/auto: ${out.bareThin}/${out.bareAuto}`);

  if (!out.supportsWebkit) {
    // Firefox: the guarded block is exactly what should apply here.
    if (out.bodyWidth !== 'thin') {
      fail(`Firefox is on scrollbar-width: ${out.bodyWidth} - the guarded block did not apply, so the bar keeps its arrow buttons`);
    }
    ok('this browser takes the guarded `thin`, which is what removes the arrow buttons');
  } else {
    if (!firefoxGuard) {
      fail('no @supports rule setting scrollbar-width: thin for browsers without ::-webkit-scrollbar - the Firefox fix has no home');
    }
    if (out.bareThin) {
      fail(`${out.bareThin} bare '*' rule(s) set scrollbar-width: thin outside that guard - applied here too, it narrows this browser's bar from 15px to 10px`);
    }
    if (out.bodyWidth !== 'auto' || out.probeWidth !== 'auto') {
      fail(`this browser computes scrollbar-width: body=${out.bodyWidth}, div=${out.probeWidth} - expected auto, so the guarded block is leaking`);
    }
    if (!out.bareAuto) fail('nothing sets scrollbar-width: auto, so the default is whatever the engine feels like');
    ok('this browser keeps scrollbar-width: auto and is not caught by the Firefox guard');
    ok('the Firefox-only `thin` lives inside an @supports guard and nowhere else');
  }

  if (problems.length) fail(problems.slice(0, 3).join(' | '));
  ws.close(); cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
