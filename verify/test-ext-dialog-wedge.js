/*
 * Issue #276: a dialog the agent is waiting on must not wedge the session.
 *
 * pi runs `session_start` handlers before the session is usable, and goal-x
 * asks "Focus open goal" from one of them. The handler awaits ctx.ui.select,
 * which awaits the client's extension_ui_response. Because the bridge rewrote
 * that response's id (fix for #227), pi's `pendingExtensionRequests` lookup
 * missed, the answer was dropped, and the handler never returned: the agent
 * stopped answering anything until the server was restarted. This is #276, and
 * it is why a /goal-... command "does nothing" (#275).
 *
 * A real pi cannot run in this suite (it installs packages and needs auth), so
 * the agent here is a stand-in that models pi's contract exactly: one pending
 * request keyed by the id it issued, an unknown id silently dropped, and the
 * session gate held shut until that request is answered. The stand-in scripts
 * its own file, so there is nothing to escape.
 *
 * Asserted: the answer reaches the stand-in (it emits a notify proving it), and
 * the agent answers a prompt afterwards. On the pre-fix bridge both fail.
 *
 * Usage: node test-ext-dialog-wedge.js
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WS = require(require.resolve('ws', { paths: [path.join(__dirname, '..', 'bridge')] }));

const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
const ROOT = path.resolve(__dirname, '..');
const PORT = 24900 + (process.pid % 100);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-ext-wedge-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const d of ['agent', 'ws', 'sessions']) fs.mkdirSync(path.join(scratch, d), { recursive: true });

/* The stand-in agent. pi's own behaviour, in about forty lines. */
const STUB = `'use strict';
const readline = require('readline');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const respond = (id, command, data) => out({ type: 'response', id, command, success: true, data });
// pi: pendingExtensionRequests, keyed by the id it put on the request.
const pending = new Map();
let sessionStarted = false;
const queued = [];
let askedOnce = false;

function askFocus() {
  const id = 'focus-1';
  pending.set(id, (answer) => {
    sessionStarted = true;
    out({ type: 'extension_ui_request', id: 'notify-1', method: 'notify', notifyType: 'info',
      message: 'goal focused: ' + String(answer.value) });
    // A session that never became ready never answers anything: that is the
    // wedge this test is about.
    for (const q of queued.splice(0)) respond(q.id, 'prompt', { disposition: 'started' });
  });
  out({ type: 'extension_ui_request', id, method: 'select', title: 'Focus open goal',
    options: ['g1 | active | goal | Ship the native goal panel', 'g2 | paused | goal | An older idea'] });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  // pi's rpc-mode: an extension response with an id nothing is waiting on is
  // dropped without notice (dist/modes/rpc/rpc-mode.js).
  if (msg.type === 'extension_ui_response') {
    const p = pending.get(msg.id);
    if (!p) return;          // id rewritten by the bridge -> silent drop
    pending.delete(msg.id);
    p(msg);
    return;
  }
  if (msg.type === 'prompt') {
    if (!sessionStarted) { queued.push(msg); return; }
    respond(msg.id, 'prompt', { disposition: 'started' });
    out({ type: 'extension_ui_request', id: 'notify-2', method: 'notify', notifyType: 'info',
      message: 'answered prompt: ' + String(msg.message) });
    return;
  }
  if (msg.id) respond(msg.id, msg.type, {});
  if (!askedOnce) { askedOnce = true; askFocus(); }
});
`;

const getJson = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

let bridge = null;
const cleanup = () => {
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);

const watchdog = setTimeout(() => {
  console.error('FAIL: the wedge check did not finish within 120s');
  process.exit(1);
}, 120000);
watchdog.unref();

(async () => {
  const stub = path.join(scratch, 'stub-agent.js');
  fs.writeFileSync(stub, STUB);

  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_SESSION_DIR: path.join(scratch, 'sessions'),
      WORKSPACE_DIR: path.join(scratch, 'ws'),
      PI_SESSION_DIR: path.join(scratch, 'sessions'),
      PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'),
      PI_LLAMA_SCAN: 'off',
      PI_COMMAND: `${process.execPath} ${stub}`,
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

  const ws = new WS(`ws://127.0.0.1:${PORT}/ws`);
  const ui = [];
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m && m.bridge === 'rpc' && m.payload && m.payload.type === 'extension_ui_request') ui.push(m.payload);
  });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const waitFor = async (pred, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (pred()) return true; await sleep(25); }
    return false;
  };

  /* /goal-focus is the command that asks this menu. */
  ws.send(JSON.stringify({ type: 'prompt', id: 'req-1', message: '/goal-focus' }));
  if (!await waitFor(() => ui.find((r) => r.method === 'select'), 8000)) {
    fail('the stand-in never asked its focus menu');
  }
  const menu = ui.find((r) => r.method === 'select');
  console.log(`  menu: "${menu.title}" -> ${(menu.options || []).length} options`);

  ws.send(JSON.stringify({ type: 'extension_ui_response', id: menu.id, value: menu.options[0] }));
  if (!await waitFor(() => ui.find((r) => r.method === 'notify' && /goal focused/.test(r.message || '')), 8000)) {
    fail('#275/#276: the focus menu answered nothing - the agent never received the selection, so its '
      + `session gate stayed shut. Requests seen: ${JSON.stringify(ui.map((r) => r.id))}`);
  }
  console.log(`  answer reached the agent: ${ui.find((r) => /goal focused/.test(r.message || '')).message}`);

  /* The queued /goal-focus prompt is delivered now, and a fresh prompt works. */
  ui.length = 0;
  ws.send(JSON.stringify({ type: 'prompt', id: 'req-2', message: 'hello after the menu' }));
  if (!await waitFor(() => ui.find((r) => r.method === 'notify' && /answered prompt/.test(r.message || '')), 8000)) {
    fail('#276: the session stayed wedged after the menu was answered - a later prompt was never processed');
  }
  const h = await getJson('/api/health');
  if (!h || !h.ok) fail('#276: the bridge is not healthy after the wedge scenario');
  ws.close();
  console.log('  the session answered a later prompt: not wedged');
  console.log(JSON.stringify({ menuOptions: (menu.options || []).length, gateOpened: true }));
  process.exit(0);
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
