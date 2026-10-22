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
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));
  console.log(`  120 chunks: worst gap to the bottom ${maxGap}px, message grew to ${out.samples[out.samples.length - 1].h}px; streaming content-visibility ${out.styles.streaming}, finished ${out.styles.finished}`);
  console.log('  PASS #160 a long answer stays pinned and the streaming message is never size-estimated');
  cleanupBrowser(); cleanup(); process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
