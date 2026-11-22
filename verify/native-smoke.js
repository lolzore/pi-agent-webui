/*
 * Native headless smoke test for the installed pi CLI.
 *
 * The host matrix uses bridge/mock_agent.js so it can run anywhere. This one
 * starts the real `pi --mode rpc` (the headless mode the WebUI drives), opens
 * the bridge's own WebSocket, and asks pi for its session state and command
 * list. It does not call a model or spend tokens; get_state/get_commands are
 * the two RPCs every page uses on connect.
 *
 * Usage: node native-smoke.js [piCommand]
 *   PI_AGENT_DIR defaults to the real agent dir (models/auth), sessions and the
 *   WebUI's own state go to a scratch directory, and the port is 3096.
 */
'use strict';
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 3096;
const command = process.argv[2] || 'pi --mode rpc';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-native-'));
for (const d of ['sessions', 'ws']) fs.mkdirSync(path.join(scratch, d), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bridge = null;
const cleanup = () => {
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);
const fail = (m) => { console.error('FAIL: ' + m); cleanup(); process.exit(1); };

const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

(async () => {
  const agentDir = process.env.PI_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: agentDir,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: path.join(scratch, 'sessions'),
      WORKSPACE_DIR: path.join(scratch, 'ws'),
      PI_SESSION_DIR: path.join(scratch, 'sessions'),
      PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'),
      PI_COMMAND: command,
      PI_LLAMA_SCAN: 'off',
      PORT: String(PORT),
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = ''; bridge.stderr.on('data', (c) => { err += c; });
  let up = false;
  for (let i = 0; i < 150; i++) {
    try { await get('/api/health'); up = true; break; } catch { await sleep(200); }
  }
  if (!up) fail('the native bridge never came up\n' + err.slice(-800));

  const WS = require(path.join(ROOT, 'bridge', 'node_modules', 'ws'));
  const ws = new WS(`ws://127.0.0.1:${PORT}/ws`);
  const messages = [];
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WebSocket open timed out')), 15000);
  });
  ws.on('message', (d) => { try { messages.push(JSON.parse(d.toString('utf8'))); } catch { /* ignore */ } });
  const waitFor = async (pred, ms, what) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = messages.find(pred);
      if (hit) return hit;
      await sleep(100);
    }
    fail(`pi did not answer ${what}\n` + JSON.stringify(messages.slice(-5)).slice(0, 1200) + '\n' + err.slice(-500));
  };
  const send = (type, id) => ws.send(JSON.stringify({ type, id }));
  send('get_state', 'smoke-state');
  const state = await waitFor((m) => m.bridge === 'rpc' && m.payload && m.payload.type === 'response' && m.payload.id === 'smoke-state', 30000, 'get_state');
  if (!state.payload.success) fail('get_state failed: ' + JSON.stringify(state.payload));
  const data = state.payload.data || {};
  if (!data.sessionFile && !data.sessionName) fail('get_state returned no session: ' + JSON.stringify(data).slice(0, 500));
  console.log('  native pi session:', JSON.stringify({ sessionFile: data.sessionFile, sessionName: data.sessionName, model: data.model && data.model.id }));

  send('get_commands', 'smoke-commands');
  const cmds = await waitFor((m) => m.bridge === 'rpc' && m.payload && m.payload.type === 'response' && m.payload.id === 'smoke-commands', 30000, 'get_commands');
  if (!cmds.payload.success) fail('get_commands failed: ' + JSON.stringify(cmds.payload));
  const list = (cmds.payload.data && cmds.payload.data.commands) || [];
  if (!Array.isArray(list) || !list.length) fail('get_commands returned no commands');
  console.log(`  native pi commands: ${list.length} (${list.slice(0, 4).map((c) => c.name).join(', ')}…)`);

  const health = await get('/api/health');
  if (!health.ok) fail('the bridge is not healthy after the native RPCs');
  console.log('  PASS native pi 1.4.0 headless: bridge + get_state + get_commands');
  ws.close(); cleanup(); process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
