/*
 * The bridge resumes the last session by starting the agent *in* it
 * (`pi --session <file>`), not by switching to it once the agent is up.
 *
 * A switch replaces the session under pi's extensions and under commands that
 * are already in flight, so pi answers every extension that its ctx is stale -
 * the "This extension ctx is stale after session replacement or reload" line
 * that appeared several times per start - and the page could see the fresh,
 * empty session before the switch landed. Starting in it avoids both.
 *
 * Usage: node test-resume-at-start.js
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PORT = 27600 + (process.pid % 200);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-resume-'));
fs.mkdirSync(path.join(scratch, 'agent'), { recursive: true });
fs.mkdirSync(path.join(scratch, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'webui.json'), JSON.stringify({ onboarded: true }));
const SESSION = path.join(scratch, 'sessions', '2026-01-01T00-00-00-000Z_abc.jsonl');
fs.writeFileSync(SESSION, '{"type":"message","message":{"role":"user","content":"hello"}}\n');
const LAST = path.join(scratch, 'last.json');
fs.writeFileSync(LAST, JSON.stringify({ path: SESSION, at: Date.now() }));
const ARGV_FILE = path.join(scratch, 'argv.txt');
const RPC_LOG = path.join(scratch, 'rpc.log');
const BRIDGE_LOG = path.join(scratch, 'bridge.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bridge = null;
const cleanup = () => { try { if (bridge) bridge.kill(); } catch { /* gone */ } try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ } };
process.on('exit', cleanup);

const startBridge = async () => {
  const out = fs.openSync(BRIDGE_LOG, 'a');
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: path.join(scratch, 'agent'), PI_CODING_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_SESSION_DIR: path.join(scratch, 'sessions'), WORKSPACE_DIR: scratch,
      PI_SESSION_DIR: path.join(scratch, 'sessions'), PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: LAST, PI_WEBUI_SOURCE_FILE: path.join(scratch, 'source.txt'),
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_MOCK_ARGV_FILE: ARGV_FILE, PI_MOCK_RPC_LOG: RPC_LOG,
      PI_LLAMA_SCAN: 'off', PORT: String(PORT),
    }), stdio: ['ignore', out, out],
  });
  for (let i = 0; i < 80; i++) {
    try { await new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: PORT, path: '/api/health' }, (r) => { r.resume(); r.on('end', res); }).on('error', rej); }); return true; } catch { /* not yet */ }
    await sleep(200);
  }
  return false;
};

(async () => {
  if (!(await startBridge())) { console.error('FAIL: the bridge never came up\n' + fs.readFileSync(BRIDGE_LOG, 'utf8').slice(-400)); process.exit(1); }
  // a client connection is what starts the agent
  const WebSocket = require(path.join(ROOT, 'bridge', 'node_modules', 'ws'));
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await sleep(2500);

  const argv = fs.existsSync(ARGV_FILE) ? fs.readFileSync(ARGV_FILE, 'utf8').trim() : '';
  const rpcs = fs.existsSync(RPC_LOG) ? fs.readFileSync(RPC_LOG, 'utf8').split('\n').filter(Boolean) : [];
  const log = fs.readFileSync(BRIDGE_LOG, 'utf8');
  ws.close();

  if (!argv.includes('--session')) {
    console.error('FAIL: the agent was not started in the last session: ' + JSON.stringify(argv));
    process.exit(1);
  }
  if (!argv.includes(SESSION)) {
    console.error('FAIL: --session was given the wrong path: ' + JSON.stringify(argv));
    process.exit(1);
  }
  if (rpcs.includes('switch_session')) {
    console.error('FAIL: the bridge still switched sessions after starting (rpcs: ' + JSON.stringify(rpcs) + ')');
    process.exit(1);
  }
  if (!/started in the last session/.test(log)) {
    console.error('FAIL: the bridge did not say it started in the session:\n' + log.slice(-300));
    process.exit(1);
  }
  console.log(`  agent started with: ${argv.replace(process.execPath, 'node').slice(0, 120)}`);
  console.log(`  rpcs seen: ${rpcs.join(', ') || '(none)'}`);
  console.log('  PASS the bridge resumes by starting in the last session, with no switch');
  cleanup(); process.exit(0);
})().catch((e) => { cleanup(); console.error('FAIL: ' + ((e && e.stack) || e)); process.exit(1); });
