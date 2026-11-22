/*
 * Issue #279: "Timer is broken, bash script with timer went to 'done' after page
 * reload."
 *
 * pi writes an assistant message (with its toolCall blocks) as soon as the model
 * finishes writing the call; the toolResult only arrives when the tool ends. A
 * page reloaded while a command runs therefore rebuilds the card from the
 * session file with no result to match it - and the transcript drew every such
 * card as "done", without a timer. A bash command that takes minutes looked
 * finished the whole time it kept running.
 *
 * The renderer now treats the newest message's unanswered calls as running while
 * the agent is streaming (with the timer continuing from the message's
 * timestamp), and as interrupted - never "done" - once the run is over.
 *
 * Usage: node test-reload-running-tool.js <browserPath>
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
const PORT = 26200 + (process.pid % 300);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-reload-tool-'));
fs.mkdirSync(path.join(scratch, 'agent'), { recursive: true });
fs.mkdirSync(path.join(scratch, 'sessions'), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bridge = null;
const cleanup = () => {
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);

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
  for (let i = 0; i < 100; i++) {
    try {
      await new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port: PORT, path: '/api/health' }, (r) => { r.resume(); r.on('end', res); }).on('error', rej);
      });
      up = true; break;
    } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('the scratch bridge never came up\n' + bridgeErr.slice(-500));

  const WS = require('./ws-min.js');
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-reload-tool-browser-'));
  const launched = WS.launchBrowser(browser, [
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

  const port = await launched.port.catch((e) => fail('browser never reported a debug port\n' + e.message));
  const getJson = (p) => new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: p }, (r) => {
      let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
  let targets = [];
  for (let i = 0; i < 80; i++) {
    try { targets = await getJson('/json/list'); if (targets.length) break; } catch { /* not yet */ }
    await sleep(150);
  }
  const page = targets.find((t) => t.type === 'page');
  if (!page) fail('no page target in the browser\n' + browserErr.slice(-400));

  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.open();
  let id = 0;
  const pending = new Map();
  const problems = [];
  ws.onmessage = (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      problems.push((d.exception && (d.exception.description || d.exception.value)) || d.text || 'exception');
    }
  };
  const send = (method, params) => new Promise((res) => {
    const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw');
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 160; i++) {
    if (await evalJs("typeof refreshMessages === 'function' && typeof openToolCalls === 'function' ? 1 : 0")) break;
    await sleep(200);
  }
  await evalJs("(async()=>{ document.querySelectorAll('dialog[open]').forEach((d)=>d.close()); await new Promise((r)=>setTimeout(r,300)); })()");

  const raw = await evalJs(`(async () => {
    const res = {};
    const now = Date.now();
    const msgs = [
      { role: 'user', content: 'run the long one', timestamp: now - 200000 },
      { role: 'assistant', content: [
        { type: 'text', text: 'starting it' },
        { type: 'toolCall', id: 'call_live', name: 'bash', arguments: { command: 'sleep 300' } },
      ], timestamp: now - 120000 },
    ];
    // Only the newest message's unanswered calls are open: an older one belongs
    // to a run that died before its tool did.
    const withOld = [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'call_old', name: 'bash', arguments: { command: 'echo old' } }], timestamp: now - 400000 },
      ...msgs,
    ];
    res.open = [...(openToolCalls(withOld) || new Map()).keys()].join(',');
    // A multi-call assistant message can have a result already written while
    // another call in the same message is still running. The newest assistant
    // message is still the batch; a literal last-message check would miss it.
    const multi = [
      { role: 'user', content: 'run both', timestamp: now - 220000 },
      { role: 'assistant', content: [
        { type: 'toolCall', id: 'call_early', name: 'bash', arguments: { command: 'echo early' } },
        { type: 'toolCall', id: 'call_late', name: 'bash', arguments: { command: 'sleep 300' } },
      ], timestamp: now - 120000 },
      { role: 'toolResult', toolCallId: 'call_early', content: [{ type: 'text', text: 'early' }], timestamp: now - 100000 },
    ];
    res.multiOpen = [...(openToolCalls(multi) || new Map()).keys()].join(',');
    const fake = '/tmp/none/session.jsonl';
    S.state.sessionFile = fake;
    S.viewSession = null;
    S.isStreaming = true;
    await refreshMessages({ path: fake, promise: Promise.resolve({ messages: withOld, compactions: [] }) });
    const live = [...document.querySelectorAll('.tool-card')].pop();
    res.running = live && live.querySelector('.tool-state-label').textContent;
    res.runningClass = live && live.querySelector('.tool-state').className;
    res.timer = live && live.querySelector('.tool-timer').textContent;
    res.timerHidden = live && live.querySelector('.tool-timer').classList.contains('hidden');
    res.cardCount = document.querySelectorAll('.tool-card').length;
    // A fresh page (S.toolCards empty) whose run is over: the same dangling call
    // is interrupted, not "done".
    S.isStreaming = false;
    for (const c of S.toolCards.values()) { if (c._timer) { clearInterval(c._timer); c._timer = null; } }
    S.toolCards.clear();
    await refreshMessages({ path: fake, promise: Promise.resolve({ messages: msgs, compactions: [] }) });
    const dead = [...document.querySelectorAll('.tool-card')].pop();
    res.idle = dead && dead.querySelector('.tool-state-label').textContent;
    res.idleClass = dead && dead.querySelector('.tool-state').className;
    return JSON.stringify(res);
  })()`);
  let out;
  try { out = JSON.parse(raw); } catch (e) { fail('the in-page check did not return JSON: ' + String(raw).slice(0, 300)); }

  if (out.open !== 'call_live') fail('openToolCalls did not limit itself to the newest assistant message: ' + JSON.stringify(out.open));
  if (out.multiOpen !== 'call_late') fail('a pending call after an earlier result in the same batch was missed: ' + JSON.stringify(out.multiOpen));
  if (!out.cardCount) fail('the reloaded transcript drew no tool card: ' + JSON.stringify(out));
  if (out.running !== 'running') fail('a still-running tool was rebuilt as "' + out.running + '" after a reload: ' + JSON.stringify(out));
  if (!/tool-state running/.test(out.runningClass)) fail('the running card lost its running class: ' + JSON.stringify(out.runningClass));
  if (out.timerHidden || !out.timer) fail('the rebuilt running card has no timer: ' + JSON.stringify(out));
  if (!/^\d+m \d+s$|^\d+s$/.test(out.timer)) fail('the rebuilt timer does not show the real elapsed time: ' + JSON.stringify(out.timer));
  if (out.idle !== 'interrupted') fail('an unanswered call from a finished run should be interrupted, not "' + out.idle + '": ' + JSON.stringify(out));
  if (!/tool-state error/.test(out.idleClass)) fail('the interrupted card is not marked as an error: ' + JSON.stringify(out.idleClass));
  if (problems.length) fail('the page threw: ' + problems.join(' | '));

  console.log(`  rebuilt card: ${out.running} · ${out.timer}; finished run: ${out.idle}`);
  console.log('  PASS a tool that is still running survives a reload as running, with its timer');
  cleanup();
  cleanupBrowser();
  process.exit(0);
})().catch((e) => { cleanup(); console.error('FAIL: ' + ((e && e.stack) || e)); process.exit(1); });
