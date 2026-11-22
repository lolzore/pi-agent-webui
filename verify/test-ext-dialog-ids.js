/*
 * Issues #274 and #275: an answer to an extension dialog must reach the agent.
 *
 * pi's RPC mode keeps the dialogs it asked for in a map keyed by the id it put
 * on the request (dist/modes/rpc/rpc-mode.js: `pendingExtensionRequests.get(
 * response.id)`). A response whose id does not match an entry is silently
 * dropped, and the extension's `await ctx.ui.select(...)` never resolves.
 *
 * The bridge rewrites the id of every client request to a unique wire id (both
 * fixes #227 - two tabs number their requests from zero). Extension responses
 * went through the same rewrite, so pi was handed `wire-7` for a request it
 * had issued as `dlg1`: the answer was dropped, and the goal menu closed
 * without the agent ever being told what was chosen (#274), or a /goal-...
 * command appeared to do nothing at all (#275).
 *
 * Asserted here against a real bridge and the mock agent's dialog flow: the
 * id on `extension_ui_response` is the extension's own id, the next step of the
 * flow arrives (which can only happen if the mock got the answer), and the flow
 * completes. The mock compares the id exactly - it is what pi does.
 *
 * Usage: node test-ext-dialog-ids.js
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
const PORT = 24700 + (process.pid % 200);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-ext-ids-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const d of ['agent', 'ws', 'sessions']) fs.mkdirSync(path.join(scratch, d), { recursive: true });

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

/* A test that waits forever takes the whole matrix with it (the suite runs each
 * check in a command substitution, with no timeout of its own). A stuck launch
 * or a dialog that never comes back is a failure, not a reason to hang. */
const watchdog = setTimeout(() => {
  console.error('FAIL: the dialog round-trip did not finish within 120s');
  process.exit(1);
}, 120000);
watchdog.unref();

(async () => {
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
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
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
  const seen = { ui: [], responses: [], assistant: [] };
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    const p = m && m.bridge === 'rpc' ? m.payload : null;
    if (!p) return;
    if (p.type === 'extension_ui_request') seen.ui.push(p);
    else if (p.type === 'response') seen.responses.push(p);
    else if (p.type === 'message_end' || p.type === 'assistant_message') seen.assistant.push(p);
  });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

  const waitFor = async (pred, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (pred()) return true;
      await sleep(25);
    }
    return false;
  };
  const uiById = (id) => seen.ui.find((r) => r.id === id);

  /* ── step 1: a dialog opens ───────────────────────────────────────────── */
  ws.send(JSON.stringify({ type: 'prompt', id: 'req-1', message: '/dialog' }));
  if (!await waitFor(() => uiById('dlg1'), 8000)) {
    fail('the mock never asked its first dialog (extension_ui_request dlg1)');
  }
  const dlg1 = uiById('dlg1');
  if (dlg1.method !== 'confirm') fail(`dlg1 has method ${JSON.stringify(dlg1.method)}, expected confirm`);
  console.log(`  dialog 1: ${dlg1.method} "${dlg1.title}"`);

  /* ── step 2: answer it with the extension's own id ────────────────────── */
  ws.send(JSON.stringify({ type: 'extension_ui_response', id: dlg1.id, confirmed: true }));
  if (!await waitFor(() => uiById('dlg2'), 8000)) {
    const ids = seen.ui.map((r) => r.id);
    fail('#274/#275: answering the extension dialog went nowhere - the agent never asked its '
      + `next question, so the response id was not the one it issued (dlg1). Requests seen: ${JSON.stringify(ids)}`);
  }
  const dlg2 = uiById('dlg2');
  if (dlg2.method !== 'input') fail(`dlg2 has method ${JSON.stringify(dlg2.method)}, expected input`);
  console.log(`  dialog 2: ${dlg2.method} "${dlg2.placeholder}" - the answer reached the agent`);

  /* ── step 3: the flow completes ───────────────────────────────────────── */
  seen.assistant.length = 0;
  ws.send(JSON.stringify({ type: 'extension_ui_response', id: dlg2.id, value: 'because the tests pass' }));
  if (!await waitFor(() => seen.ui.some((r) => r.method === 'notify'), 8000)) {
    fail('#274: the second answer was dropped too - no notify came back');
  }
  const notify = seen.ui.find((r) => r.method === 'notify');
  if (!/because the tests pass/.test(notify.message || '')) {
    fail(`the agent read the wrong value: ${JSON.stringify(notify.message)}`);
  }
  const done = await waitFor(() => seen.assistant.some((m) => JSON.stringify(m).includes('Dialog flow complete')), 8000);
  if (!done) fail('#274: the dialog flow never completed - the transcript got no final reply');
  console.log(`  notify: ${notify.message}`);
  console.log('  the whole two-step dialog round-trip completed');

  /* ── step 4: the bridge is still healthy and still answering ──────────── */
  const h = await getJson('/api/health');
  if (!h || !h.ok) fail('#276: the bridge is not healthy after an extension dialog was answered');
  seen.responses.length = 0;
  ws.send(JSON.stringify({ type: 'get_state', id: 'req-2' }));
  if (!await waitFor(() => seen.responses.some((r) => r.id === 'req-2'), 8000)) {
    fail('#276: the bridge stopped answering requests after an extension dialog was answered');
  }
  ws.close();
  console.log('  bridge still answers requests after the dialog');
  console.log(JSON.stringify({ dialogs: 2, responses: seen.responses.length }));
  // The bridge this test started is still a child process, and the socket may
  // still be closing: exit explicitly so the suite is not left waiting on it.
  process.exit(0);
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
