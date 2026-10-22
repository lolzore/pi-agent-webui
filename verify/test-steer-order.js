/*
 * Issue #149: "After the agent finished my last sent message appeared at the
 * bottom (reload fixes it)."
 *
 * A message sent while the agent is streaming (a steer) is drawn below the live
 * assistant row, and that is also where the session file keeps it: the assistant
 * message that was streaming, then the steer, then whatever the assistant says
 * next. finalizeLive() used to re-render the finished message at the end of the
 * chat instead of where its live shell sat, so the steer ended up *above* the
 * reply it steered - and only a reload (which renders the file in order) put it
 * right.
 *
 * Usage: node test-steer-order.js <browserPath>
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
const PORT = 25500 + (process.pid % 200);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-steer-'));
fs.mkdirSync(path.join(scratch, 'agent'), { recursive: true });
fs.mkdirSync(path.join(scratch, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'webui.json'), JSON.stringify({ onboarded: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bridge = null;
const cleanup = () => { try { if (bridge) bridge.kill(); } catch { /* gone */ } try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ } };
process.on('exit', cleanup);
const getJson = (p) => new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej); });
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
  let err = ''; bridge.stderr.on('data', (c) => { err += c; });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const d = await getJson('/api/health'); if (d && d.ok) { up = true; break; } } catch { /* not yet */ } await sleep(200); }
  if (!up) fail('bridge never came up\n' + err.slice(-400));
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-steer-browser-'));
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
  /* Wait for the first transcript load to finish: injecting the live message
   * while that render is still chunking lets it clear the chat, which made this
   * test flake inside the suite (the rows came back empty). */
  for (let i = 0; i < 120; i++) {
    if (await evalJs("typeof startLive === 'function' && typeof finalizeLive === 'function' && typeof sendPrompt === 'function' && typeof applyDelta === 'function' && typeof S === 'object' && (S.historyRender || 0) > 0 ? 1 : 0")) break;
    await sleep(250);
  }
  const out = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const res = {};
    const rows = () => [...document.getElementById('chat').children].map((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160));
    // the agent is streaming its answer
    startLive();
    applyDelta({ type: 'text_delta', delta: 'streaming the answer ' });
    await new Promise((r) => setTimeout(r, 60));
    // the user steers while it streams, exactly the way the composer does
    const real = rpc; rpc = () => Promise.resolve({});
    S.viewSession = null;
    document.getElementById('input').value = '';
    sendPrompt('STEER WHILE STREAMING', [], 'steer', true);
    await new Promise((r) => setTimeout(r, 100));
    res.before = rows();
    // the streamed message finishes; the file order is assistant, then the steer
    finalizeLive({ role: 'assistant', content: [{ type: 'text', text: 'streaming the answer (final)' }], timestamp: Date.now() });
    await new Promise((r) => setTimeout(r, 80));
    res.after = rows();
    rpc = real;
    for (const r of document.querySelectorAll('#chat .msg.user[data-live="1"]')) r.remove();
    return res;
  })()))()`));
  const idx = (arr, needle) => arr.findIndex((t) => t.includes(needle));
  const a = idx(out.after, 'streaming the answer');
  const s = idx(out.after, 'STEER WHILE STREAMING');
  if (s < 0 || a < 0) fail('the steer or the finished message is missing from the transcript: ' + JSON.stringify(out.after));
  if (!(a < s)) fail('the finished message was re-rendered after the steer it streamed over - the steer sits above its own reply until a reload (issue #149): ' + JSON.stringify(out.after));
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));
  console.log('  before finalize:', JSON.stringify(out.before));
  console.log('  after finalize :', JSON.stringify(out.after));
  console.log('  PASS #149 a steer stays below the message it steered, without a reload');
  cleanupBrowser(); cleanup(); process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
