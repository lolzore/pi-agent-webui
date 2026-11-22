/*
 * Switching sessions must move the context counter with the transcript.
 *
 * Two cases, and the second is the one that was broken:
 *
 *  1. an idle switch moves the agent, so get_session_stats answers about the
 *     new session - that path already worked, but it is the control;
 *  2. a switch while the agent is running is read-only: pi is still in the old
 *     session, so asking it for stats would return the old session's number.
 *     The read-only transcript records the usage each assistant answer ran
 *     against, and the ring has to use that instead - including while the
 *     stats poll keeps ticking in the background.
 *
 * The mock is copied and patched to answer with a different context per session;
 * the stock mock returns one fixed number and cannot test this. The session
 * files carry the usage records the read-only view reads.
 *
 * Usage: node test-ctx-sessions.js <browserPath>
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const browser = process.argv[2];
const fail = (m) => { console.error('FAIL: ' + m); cleanup(); process.exit(1); };
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const ROOT = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-ctx-sessions-'));
const agentDir = path.join(scratch, 'agent');
const sessionDir = path.join(scratch, 'sessions');
const wsDir = path.join(scratch, 'ws');
for (const d of [agentDir, sessionDir, wsDir]) fs.mkdirSync(d, { recursive: true });

const alpha = path.join(sessionDir, 'alpha.jsonl');
const beta = path.join(sessionDir, 'beta.jsonl');
function writeSession(file, label, tokens) {
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session', version: 1, sessionFile: file }),
    JSON.stringify({ type: 'message', id: 'u-' + label, message: { role: 'user', content: [{ type: 'text', text: 'hello ' + label }], timestamp: Date.now() } }),
    JSON.stringify({ type: 'message', id: 'a-' + label, message: {
      role: 'assistant', content: [{ type: 'text', text: 'answer ' + label }],
      usage: { input: tokens, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: tokens },
      timestamp: Date.now(),
    } }),
  ].join('\n') + '\n');
}
writeSession(alpha, 'alpha', 7000);
writeSession(beta, 'beta', 9000);
fs.writeFileSync(path.join(scratch, 'webui.json'), JSON.stringify({ onboarded: true }));

/* Same mock, one changed answer: the context depends on the session file. */
const mockSrc = fs.readFileSync(path.join(ROOT, 'bridge', 'mock_agent.js'), 'utf8');
const mock = mockSrc.replace(
  "contextUsage: { tokens: 180, contextWindow: 200000, percent: 0.09 },",
  "contextUsage: { tokens: (state.sessionFile || '').includes('alpha.jsonl') ? 11111 : (state.sessionFile || '').includes('beta.jsonl') ? 22222 : 33333, contextWindow: 200000, percent: 0.1 },");
if (mock === mockSrc) fail('the mock has no fixed contextUsage line to patch');
const mockFile = path.join(scratch, 'mock-stats.js');
fs.writeFileSync(mockFile, mock);

const PORT = 3180 + (process.pid % 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bridge = null;
let launched = null;
function cleanup() {
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
  try { if (launched && launched.child) launched.child.kill(); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
}
process.on('exit', cleanup);
const getJson = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

(async () => {
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir, PI_SESSION_DIR: sessionDir,
      WORKSPACE_DIR: wsDir,
      PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'),
      PI_MOCK_SESSION_FILE: alpha,
      PI_COMMAND: `${process.execPath} ${mockFile}`,
      PI_LLAMA_SCAN: 'off', PORT: String(PORT),
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let berr = ''; bridge.stderr.on('data', (c) => { berr += c; });
  let up = false;
  for (let i = 0; i < 100; i++) {
    try { const d = await getJson(PORT, '/api/health'); if (d.ok) { up = true; break; } } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('the scratch bridge never came up\n' + berr.slice(-600));

  launched = require('./ws-min.js').launchBrowser(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--window-size=1200,900', 'about:blank',
  ]);
  const DBG = await launched.port;
  let ver = null;
  for (let i = 0; i < 100; i++) { try { ver = await getJson(DBG, '/json/version'); break; } catch { await sleep(150); } }
  if (!ver) fail('browser never came up\n' + launched.stderr().slice(-400));

  const WS = require('./ws-min.js');
  const page = (await getJson(DBG, '/json/list')).find((t) => t.type === 'page');
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
    if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || r.result.exceptionDetails.text || 'eval threw');
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const state = async () => JSON.parse(await evalJs("JSON.stringify({label:($('ctx-label')||{}).textContent||'', view:S.viewSession, file:S.state.sessionFile, stats:S.ctxStats, peak:S.ctxTurnPeak||0, streaming:S.isStreaming})"));
  const waitLabel = async (want, what) => {
    for (let i = 0; i < 50; i++) {
      const s = await state();
      if ((s.label || '').includes(want)) return s;
      await sleep(100);
    }
    const s = await state();
    fail(`${what}: expected the context label to contain ${want}, got ${JSON.stringify(s)}`);
  };
  const switchTo = async (target) => {
    await evalJs(`switchToSession(${JSON.stringify(target)})`);
    await sleep(250);
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 120; i++) {
    if (await evalJs("typeof switchToSession === 'function' && typeof refreshStats === 'function' ? 1 : 0")) break;
    await sleep(200);
  }
  await sleep(500);

  // Control: an idle switch moves the agent, and its stats answer changes with it.
  await switchTo(beta);
  let s = await waitLabel('22.2K', 'idle switch to beta');
  if (s.stats.tokens !== 22222) fail('idle switch did not take the new session stats: ' + JSON.stringify(s));

  /* Read-only: the agent stays in beta, but the view and ring must be alpha.
   * This is the report: the old number stayed on screen because pi was still
   * answering for the session it had not left. */
  await evalJs("S.isStreaming = true; updateStreamUi();");
  await switchTo(alpha);
  s = await waitLabel('7.0K', 'read-only switch to alpha');
  if (s.view !== alpha) fail('read-only switch did not set the viewed session: ' + JSON.stringify(s));
  if (s.stats.tokens !== 7000) fail('read-only switch did not use the transcript usage: ' + JSON.stringify(s));

  // The background stats poll must not put beta's 22.2K back.
  await evalJs("refreshStats()");
  await sleep(350);
  s = await state();
  if (!s.label.includes('7.0K')) fail('a stats poll overwrote the read-only context: ' + JSON.stringify(s));

  // A stale high-water mark from the old view must not clamp the new one.
  await evalJs("S.ctxTurnPeak = 999999; S.ctxDisplayTokens = 999999;");
  await switchTo(alpha);
  s = await waitLabel('7.0K', 'read-only switch with a stale high-water mark');
  if (s.peak !== 7000) fail('the high-water mark survived the session change: ' + JSON.stringify(s));

  // Returning to the agent's own session restores the agent's real stats.
  await evalJs("S.isStreaming = false; updateStreamUi();");
  await switchTo(beta);
  s = await waitLabel('22.2K', 'return to the agent session');
  if (s.view !== null) fail('returning to the agent session left a read-only view: ' + JSON.stringify(s));

  // And the next idle switch updates again, rather than staying on beta.
  await switchTo(alpha);
  s = await waitLabel('11.1K', 'idle switch back to alpha');
  if (s.stats.tokens !== 11111) fail('idle switch back did not update the context: ' + JSON.stringify(s));

  console.log('  PASS session contexts: 22.2K idle, 7.0K read-only, poll did not overwrite, 11.1K back');
  ws.close();
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
