/*
 * A reload must never move the agent into a different session.
 *
 * Reported as: "reloading the page and sending a prompt seems to have been
 * discarded" - with the token counter dropping from ~700k to almost zero, no
 * compaction message anywhere, the messages not updating and the turn timer
 * never starting. It was not compaction. The page had put the agent into another
 * conversation: `resumeLastSession()` compared the session the agent reported
 * with the session list using `===`, so any difference in spelling (a doubled
 * separator, a host path next to the container's mapping of it, a different
 * case) made it miss the session the agent was already in. The guard fell
 * through, and the page then switched the agent to the *remembered* session -
 * which is whatever was written last, i.e. normally the first row of the
 * newest-first sidebar. The next prompt was written there, so it never appeared
 * in the conversation it was typed in, and the context counter showed the other
 * session's (empty) context.
 *
 * Asserted, after a load and after a reload:
 *   1. the page did not adopt another session (`S.state.sessionFile` stays the
 *      agent's own), and
 *   2. not one `switch_session` reached the agent.
 *
 * The agent reports its session under a path the scan does not use (an alias of
 * the same file, which is what a container's path mapping or a moved session
 * directory looks like from pi's side) - the spelling drift that used to defeat
 * the exact match. The bridge refuses to record a session outside its own
 * session dir, so the remembered record stays on the newest session, which is
 * the state the page then has to reason about. Before the fix this test fails on
 * `switch_session` in the RPC log.
 *
 * Usage: node test-reload-session.js [browserPath]
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const browser = process.argv[2] ||
  path.join(ROOT, '.browsers', 'chromium-1187', 'chrome-linux', 'chrome');
const fail = (m) => { console.error('FAIL: ' + m); cleanup(); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 27900 + (process.pid % 80);
const CDP_PORT = 9970 + (process.pid % 20);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-reload-'));
const sessionsDir = path.join(scratch, 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
for (const d of ['agent']) fs.mkdirSync(path.join(scratch, d), { recursive: true });
fs.writeFileSync(path.join(scratch, 'webui.json'), JSON.stringify({ onboarded: true }));

const seed = (name, text) => {
  const p = path.join(sessionsDir, name);
  fs.writeFileSync(p, [
    JSON.stringify({ type: 'session', version: 3, id: name, timestamp: new Date().toISOString(), cwd: scratch }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: text, timestamp: Date.now() } }),
  ].join('\n') + '\n');
  return p;
};
const OLD = seed('2026-01-01T00-00-00-000Z_old.jsonl', 'the conversation the agent is actually in');
const NEW = seed('2026-01-02T00-00-00-000Z_new.jsonl', 'the newest session - row one of the sidebar');
// The remembered record points at the *newest* session, exactly as a bridge that
// has been left alone would report it.
const LAST = path.join(scratch, 'last.json');
fs.writeFileSync(LAST, JSON.stringify({ path: NEW, at: Date.now() }));
const RPC_LOG = path.join(scratch, 'rpc.log');
const BRIDGE_LOG = path.join(scratch, 'bridge.log');
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-reload-chrome-'));

let bridge = null;
let chrome = null;
function cleanup() {
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
  try { if (chrome) chrome.kill(); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ }
}
process.on('exit', cleanup);

const getJson = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => {
    let b = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { b += c; });
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

(async () => {
  if (!fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

  // The agent reports the session it is in through an alias of the same file:
  // same session, a path the scan does not list. The bridge will not record a
  // session outside its session dir, so `remembered` stays on the newest one.
  const aliasDir = path.join(scratch, 'alias');
  fs.mkdirSync(aliasDir, { recursive: true });
  const alias = path.join(aliasDir, 'sessions');
  try { fs.symlinkSync(sessionsDir, alias, 'dir'); } catch { /* windows without rights */ }
  const reported = path.join(alias, path.basename(OLD));
  const out = fs.openSync(BRIDGE_LOG, 'a');
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: path.join(scratch, 'agent'), PI_CODING_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_SESSION_DIR: sessionsDir, WORKSPACE_DIR: scratch,
      PI_SESSION_DIR: sessionsDir, PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: LAST, PI_WEBUI_SOURCE_FILE: path.join(scratch, 'source.txt'),
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_MOCK_SESSION_FILE: reported, PI_MOCK_RPC_LOG: RPC_LOG,
      PI_LLAMA_SCAN: 'off', PORT: String(PORT),
    }), stdio: ['ignore', out, out],
  });
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { await getJson(PORT, '/api/health'); up = true; } catch { await sleep(200); }
  }
  if (!up) fail('the bridge never came up\n' + fs.readFileSync(BRIDGE_LOG, 'utf8').slice(-500));

  chrome = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + userDir,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let cdpUp = false;
  for (let i = 0; i < 100 && !cdpUp; i++) {
    try { await getJson(CDP_PORT, '/json/version'); cdpUp = true; } catch { await sleep(150); }
  }
  if (!cdpUp) fail('browser debugging endpoint never came up');

  const WS = require('./ws-min.js');
  const targets = await getJson(CDP_PORT, '/json/list');
  const page = targets.find((t) => t.type === 'page');
  if (!page) fail('no page target in the browser');
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.open();

  let msgId = 0;
  const pending = new Map();
  const problems = [];
  ws.onmessage = (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      problems.push('uncaught: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    }
  };
  const send = (method, params) => new Promise((res) => {
    const n = ++msgId;
    pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params: params || {} }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const res = r.result || {};
    if (res.exceptionDetails) return { __err: (res.exceptionDetails.exception || {}).description || 'eval failed' };
    return (r.result && r.result.result && r.result.result.value);
  };
  const waitReady = async () => {
    for (let i = 0; i < 100; i++) {
      if (await evalJs('typeof S !== "undefined" && S.initialized === true')) return true;
      await sleep(150);
    }
    return false;
  };
  const sessionState = () => evalJs('JSON.stringify({ file: S.state.sessionFile || "", view: S.viewSession || "" })');
  const switches = () => {
    try { return fs.readFileSync(RPC_LOG, 'utf8').split('\n').filter((l) => l === 'switch_session').length; }
    catch { return 0; }
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  if (!(await waitReady())) fail('the page never initialised');

  const check = (when) => {
    const raw = fs.readFileSync(RPC_LOG, 'utf8');
    const n = raw.split('\n').filter((l) => l === 'switch_session').length;
    if (n) fail(`${when}: the page switched the agent's session (${n} switch_session) - ` +
      `the prompt would have gone to the wrong conversation`);
  };

  let st = JSON.parse(await sessionState());
  if (!/old\.jsonl$/.test(st.file.replace(/\/+/g, '/'))) {
    fail('load: the page adopted another session - S.state.sessionFile=' + st.file);
  }
  if (st.view) fail('load: the page put itself in a read-only view of ' + st.view);
  check('load');

  // The reported action: reload, then carry on.
  await send('Page.reload', {});
  await sleep(400);
  if (!(await waitReady())) fail('the page never came back after the reload');

  st = JSON.parse(await sessionState());
  if (!/old\.jsonl$/.test(st.file.replace(/\/+/g, '/'))) {
    fail('reload: the page adopted another session - S.state.sessionFile=' + st.file);
  }
  if (st.view) fail('reload: the page put itself in a read-only view of ' + st.view);
  check('reload');

  if (problems.length) fail(problems[0]);
  if (switches() !== 0) fail('a switch_session reached the agent');

  console.log('PASS  a reload keeps the agent in the session it is in, and sends no switch_session');
  cleanup();
  process.exit(0);
})().catch((e) => fail('threw: ' + (e && e.message)));
