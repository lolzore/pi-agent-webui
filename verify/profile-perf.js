/*
 * Measures the items that were filed as "plausible but unverified" (#27), plus
 * the streaming paint cost (#25). Diagnostics, not a pass/fail test - it prints
 * numbers so the decisions rest on measurements rather than on intuition, which
 * has been wrong twice in this audit already.
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = process.argv[2];
const browser = process.argv[3];
const PORT = 9840 + (process.pid % 90);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-'));
const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDir, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const cleanup = () => { try { child.kill(); } catch { } try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { } };
process.on('exit', cleanup);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

(async () => {
  let v = null;
  for (let i = 0; i < 100; i++) { try { v = await getJson('/json/version'); break; } catch { await sleep(150); } }
  const WS = require('./ws-min.js');
  const page = (await getJson('/json/list')).find((t) => t.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.open();
  let id = 0; const pend = new Map();
  ws.onmessage = (raw) => { let m; try { m = JSON.parse(raw); } catch { return; } if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (m, p) => new Promise((res) => { const n = ++id; pend.set(n, res); ws.send(JSON.stringify({ id: n, method: m, params: p || {} })); });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'threw');
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: base + '/' });
  await sleep(1200);
  for (let i = 0; i < 80; i++) { if (await ev("typeof paintLive === 'function' ? 1 : 0")) break; await sleep(250); }

  console.log('=== #25  paintLive(): one full re-render of the streaming message ===');
  const paint = await ev(`(() => {
    const out = [];
    for (const n of [500, 2000, 8000, 32000, 128000]) {
      window.startLive();
      S.live.text = ('The agent is writing a long answer with **bold** and \\\`code\\\` and https://example.com/x plus\\n\\n').repeat(Math.ceil(n/102)).slice(0, n);
      paintLive();                        // warm
      const t0 = performance.now();
      for (let k = 0; k < 5; k++) paintLive();
      out.push({ chars: S.live.text.length, ms: (performance.now() - t0) / 5 });
      S.live.root.remove(); S.live = null;
    }
    return JSON.stringify(out);
  })()`);
  for (const r of JSON.parse(paint)) {
    console.log(`  ${String(r.chars).padStart(7)} chars  ${r.ms.toFixed(2)} ms per paint   (${(12 * r.ms).toFixed(1)} ms/s at 12 paints/s)`);
  }

  console.log('\n=== #27  the RPC round-trips the page makes on a timer ===');
  const rpcs = await ev(`(async () => {
    const time = async (fn, label) => {
      const t0 = performance.now();
      for (let i = 0; i < 5; i++) { try { await fn(); } catch (e) { return { label, error: e.message }; } }
      return { label, ms: (performance.now() - t0) / 5 };
    };
    const out = [];
    out.push(await time(() => rpc({ type: 'get_session_stats' }), 'get_session_stats (1/s while streaming)'));
    out.push(await time(() => rpc({ type: 'get_available_models' }), 'get_available_models'));
    out.push(await time(() => rpc({ type: 'get_fork_messages' }), 'get_fork_messages (ensureForkable)'));
    out.push(await time(() => rpc({ type: 'get_tree' }), 'get_tree (ensureForkable)'));
    out.push(await time(() => rpc({ type: 'get_commands' }), 'get_commands'));
    return JSON.stringify(out);
  })()`);
  for (const r of JSON.parse(rpcs)) {
    console.log(`  ${r.label.padEnd(46)} ${r.error ? 'ERROR ' + r.error : r.ms.toFixed(1) + ' ms'}`);
  }

  // #26: what a full sidebar rebuild actually costs. Filed as "rebuilds every
  // row"; the question is whether that is worth a diffing layer, so measure it
  // at the cap the bridge enforces and at sizes anyone would plausibly hit.
  console.log('\n=== #26  renderSessions() over a full list ===');
  const rebuild = await ev(`(() => {
    const mk = (n) => Array.from({ length: n }, (_, i) => ({
      path: '/tmp/sess-' + i + '.jsonl', fileName: 'sess-' + i + '.jsonl',
      name: 'session number ' + i + ' with a title long enough to fill the row',
      mtime: Date.now() - i * 60000, size: 1000 + i,
      parent: i % 7 ? null : '/tmp/sess-' + (i - 1) + '.jsonl',
    }));
    const out = [];
    for (const n of [20, 60, 200]) {
      const rows = mk(n);
      renderSessions(rows);
      const t0 = performance.now();
      for (let k = 0; k < 5; k++) renderSessions(rows);
      out.push({ n, ms: (performance.now() - t0) / 5 });
    }
    return JSON.stringify(out);
  })()`);
  for (const x of JSON.parse(rebuild)) {
    console.log('  ' + String(x.n).padStart(4) + ' sessions   ' + x.ms.toFixed(2) + ' ms per rebuild');
  }

  console.log('\n=== #27  the other page-side items ===');
  const rest = await ev(`(async () => {
    const out = {};
    // saveSettings: the POST it makes on every change
    const t1 = performance.now();
    for (let i = 0; i < 5; i++) { saveSettings(true); await new Promise(r => setTimeout(r, 0)); }
    out.saveSettings = (performance.now() - t1) / 5;

    // refreshSubagents: what the 1/s subagent tick costs when there are no runs
    const t2 = performance.now();
    for (let i = 0; i < 5; i++) await refreshSubagents(true);
    out.refreshSubagents = (performance.now() - t2) / 5;

    // lazySrc: how many observers exist for the images currently on the page
    out.images = document.querySelectorAll('img[data-src], .msg-img').length;
    out.observers = (typeof mediaNear !== 'undefined' && mediaNear) ? 2 : 0;

    // the animated avatars: how many live video decoders
    out.avatarVideos = document.querySelectorAll('video.avatar').length;

    return JSON.stringify(out);
  })()`);
  const r = JSON.parse(rest);
  console.log(`  saveSettings() POST            ${r.saveSettings.toFixed(1)} ms`);
  console.log(`  refreshSubagents()             ${r.refreshSubagents.toFixed(1)} ms`);
  console.log(`  images on the page             ${r.images}`);
  console.log(`  IntersectionObservers in use   ${r.observers}`);
  console.log(`  live avatar <video> decoders   ${r.avatarVideos}`);

  ws.close(); cleanup(); process.exit(0);
})().catch((e) => { cleanup(); console.error('profiling failed:', e.message); process.exit(1); });
