/*
 * Issue #34: the sidebar appears to jump when a session switch lands.
 *
 * The scroll position was never the problem - measured with a scrollbar track
 * across all 151 frames of the recording attached to the issue, the sidebar
 * scrolled exactly nine times and every one of those was the reporter scrolling
 * it by hand, and there was no re-render at all. What moves is the content: rows
 * appear and disappear at the top of the list (the pending row for "the session
 * the agent is on" comes and goes as you switch), and a session that was just
 * written to moves up the mtime order. After any of those the same scrollTop
 * points at different rows, which is what "it jumps" describes.
 *
 * So renderSessions() anchors on the topmost visible row's identity instead of
 * on a pixel offset. This tests exactly that contract, with synthetic lists, so
 * it does not depend on how many sessions happen to be on disk:
 *
 *   - a row inserted above the viewport must not move the anchored row;
 *   - a row removed above it must not either;
 *   - re-rendering the same list must not move anything at all;
 *   - if the anchored row itself is gone, it falls back to the pixel position,
 *     clamped, rather than jumping to the top.
 *
 * Usage: node test-sidebar-anchor.js <baseUrl> <browserPath>
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
if (!base) { console.error('usage: node test-sidebar-anchor.js <baseUrl> <browserPath>'); process.exit(2); }
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const PORT = 9970 + (process.pid % 28);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-anchor-'));
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
    if (await evalJs("typeof renderSessions === 'function' && document.querySelector('#session-list') ? 1 : 0")) break;
    await sleep(250);
  }

  const out = await evalJs(`(() => {
    const mk = (n, extra) => {
      const rows = [];
      if (extra) rows.push({ path: '/tmp/pending-session.jsonl', fileName: 'pending-session.jsonl',
        name: 'the session the agent is on', mtime: Date.now(), size: 0, pending: true });
      for (let i = 0; i < n; i++) {
        rows.push({ path: '/tmp/sess-' + i + '.jsonl', fileName: 'sess-' + i + '.jsonl',
          name: 'session number ' + i + ' with a long enough title to make the row full height',
          mtime: Date.now() - i * 60000, size: 1000 + i, parent: null });
      }
      return rows;
    };
    const list = document.getElementById('session-list');
    const topRow = () => {
      const t = list.getBoundingClientRect().top;
      const r = [...list.querySelectorAll('.session-item')].find((n) => n.getBoundingClientRect().bottom > t + 1);
      return r ? r.dataset.path : null;
    };
    const settle = () => { void list.scrollHeight; };
    const res = {};

    // 60 rows, scrolled well down
    renderSessions(mk(60, false)); settle();
    list.scrollTop = 500; settle();
    res.scroll = Math.round(list.scrollTop);
    res.anchor = topRow();

    // 1. the same list again must not move anything
    renderSessions(mk(60, false)); settle();
    res.sameScroll = Math.round(list.scrollTop);
    res.sameAnchor = topRow();

    // 2. a row INSERTED above the viewport (what the pending row does on a switch)
    renderSessions(mk(60, true)); settle();
    res.insertScroll = Math.round(list.scrollTop);
    res.insertAnchor = topRow();

    // 3. it REMOVED again (the pending row going away once you switch to a real
    //    session - the case measured in the repro)
    renderSessions(mk(60, false)); settle();
    res.removeScroll = Math.round(list.scrollTop);
    res.removeAnchor = topRow();

    // 4. the anchored row itself gone: fall back to the pixel position, clamped
    const fewer = mk(60, false).filter((r) => r.path !== res.anchor);
    renderSessions(fewer); settle();
    res.goneScroll = Math.round(list.scrollTop);

    document.getElementById('chat').innerHTML = '';
    return JSON.stringify(res);
  })()`);

  const r = JSON.parse(out);
  console.log(`  scrolled to ${r.scroll}, anchored on ${String(r.anchor).slice(-16)}`);
  console.log(`  same list     -> scroll ${r.sameScroll}, anchor ${String(r.sameAnchor).slice(-16)}`);
  console.log(`  row inserted  -> scroll ${r.insertScroll}, anchor ${String(r.insertAnchor).slice(-16)}`);
  console.log(`  row removed   -> scroll ${r.removeScroll}, anchor ${String(r.removeAnchor).slice(-16)}`);
  console.log(`  anchor gone   -> scroll ${r.goneScroll} (fell back, must not be 0)`);

  if (r.scroll < 100) fail(`could not scroll the list (scrollTop ${r.scroll})`);
  if (r.sameAnchor !== r.anchor) fail(`re-rendering the same list moved the anchor: ${r.anchor} -> ${r.sameAnchor}`);
  if (r.sameScroll !== r.scroll) fail(`re-rendering the same list moved the scroll: ${r.scroll} -> ${r.sameScroll}`);
  if (r.insertAnchor !== r.anchor) fail(`#34 inserting a row above the viewport moved the anchored row: ${r.anchor} -> ${r.insertAnchor}`);
  if (r.removeAnchor !== r.anchor) fail(`#34 removing a row above the viewport moved the anchored row: ${r.anchor} -> ${r.removeAnchor}`);
  if (r.goneScroll <= 0) fail(`#34 losing the anchored row jumped the list to the top (${r.goneScroll})`);

  if (problems.length) fail(problems.slice(0, 3).join(' | '));
  console.log('  PASS #34 the list stays on the row the reader was on, whatever is inserted or removed above it');
  ws.close(); cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
