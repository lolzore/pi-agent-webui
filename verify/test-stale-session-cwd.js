/*
 * A recorded session whose folder is gone must not take the agent down with it.
 *
 * pi refuses to open a session whose recorded working directory no longer exists
 * (`Stored session working directory does not exist`). In RPC mode it does not
 * ask what to do - started with `--session` it exits code 1. The bridge resumes
 * the last session by starting *in* it, so one stale record (the project folder
 * was renamed, or the app itself was moved) became a crash loop: every restart
 * resumed the same dead session and died the same way, the page got "the agent is
 * not running" for every command, and it never recovered.
 *
 * Two things are checked here:
 *
 *   1. the record is questioned before it is used - a session whose header names
 *      a missing cwd is skipped, the agent starts in a fresh session and the page
 *      is told why (so the old conversation does not just look deleted);
 *
 *   2. if a start *in* a session still dies immediately (a reason the bridge
 *      cannot predict), the record is dropped once and the retry starts fresh
 *      instead of resuming the same wall again.
 *
 * Usage: node test-stale-session-cwd.js
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const BASE_PORT = 27900 + (process.pid % 90);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanupDirs = [];
process.on('exit', () => {
  for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
});

/* A fake `pi --mode rpc` that behaves like pi where it matters here: given
 * `--session` it dies (that is what pi does for a session it cannot open), and
 * otherwise it answers the handful of commands the bridge sends while starting. */
const FAKE_AGENT = `'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
try { fs.appendFileSync(process.env.PI_FAKE_ARGV, JSON.stringify(args) + '\\n'); } catch { /* the test will say so */ }
if (process.env.PI_FAKE_FAIL_WITH_SESSION === '1' && args.includes('--session')) {
  process.stderr.write('Stored session working directory does not exist: /gone\\n');
  process.exit(1);
}
const sessionFile = path.join(process.env.PI_FAKE_SESSIONS, 'fake-fresh-' + process.pid + '.jsonl');
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (!m || !m.id) continue;
    const ok = (data) => send({ type: 'response', id: m.id, command: m.type, success: true, data });
    switch (m.type) {
      case 'get_state':
        ok({
          model: { id: 'fake', name: 'Fake', provider: 'fake', input: ['text'], contextWindow: 1000 },
          thinkingLevel: 'medium', isStreaming: false, isCompacting: false,
          sessionFile, sessionId: 'fake-' + process.pid, messageCount: 0,
        });
        break;
      case 'get_messages': ok({ messages: [] }); break;
      case 'get_available_models': ok({ models: [] }); break;
      case 'get_session_stats': ok({ sessionFile, sessionId: 'fake-' + process.pid }); break;
      default: ok({});
    }
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
`;

function makeScratch(label, sessionHeader) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `verify-stale-${label}-`));
  cleanupDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'webui.json'), '{}');
  fs.writeFileSync(path.join(dir, 'fake-agent.js'), FAKE_AGENT);
  const session = path.join(dir, 'sessions', '2026-01-01T00-00-00-000Z_old.jsonl');
  fs.writeFileSync(session,
    JSON.stringify(sessionHeader) + '\n' +
    '{"type":"message","message":{"role":"user","content":"hello"}}\n');
  fs.writeFileSync(path.join(dir, 'last.json'), JSON.stringify({ path: session, at: Date.now() }));
  return { dir, session };
}

async function startBridge(scratch, port) {
  const logFile = path.join(scratch.dir, 'bridge.log');
  const out = fs.openSync(logFile, 'a');
  const bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: path.join(scratch.dir, 'agent'),
      PI_CODING_AGENT_DIR: path.join(scratch.dir, 'agent'),
      PI_CODING_AGENT_SESSION_DIR: path.join(scratch.dir, 'sessions'),
      PI_SESSION_DIR: path.join(scratch.dir, 'sessions'),
      WORKSPACE_DIR: scratch.dir,
      PI_WEBUI_SETTINGS: path.join(scratch.dir, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch.dir, 'last.json'),
      PI_WEBUI_SOURCE_FILE: path.join(scratch.dir, 'source.txt'),
      PI_COMMAND: `${process.execPath} ${path.join(scratch.dir, 'fake-agent.js')}`,
      PI_FAKE_ARGV: path.join(scratch.dir, 'argv.txt'),
      PI_FAKE_SESSIONS: path.join(scratch.dir, 'sessions'),
      PI_FAKE_FAIL_WITH_SESSION: '1',
      PI_LLAMA_SCAN: 'off',
      PORT: String(port),
    }), stdio: ['ignore', out, out],
  });
  for (let i = 0; i < 100; i++) {
    try {
      await new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port, path: '/api/health' }, (r) => { r.resume(); r.on('end', res); }).on('error', rej);
      });
      return { bridge, logFile };
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('the bridge never came up:\n' + fs.readFileSync(logFile, 'utf8').slice(-600));
}

function connect(port, messages) {
  const WebSocket = require(path.join(ROOT, 'bridge', 'node_modules', 'ws'));
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.on('message', (d) => { try { messages.push(JSON.parse(d.toString())); } catch { /* not ours */ } });
  return new Promise((res, rej) => { ws.on('open', () => res(ws)); ws.on('error', rej); });
}

function readArgv(scratch) {
  const f = path.join(scratch.dir, 'argv.txt');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function askState(ws, messages, id) {
  const before = messages.length;
  ws.send(JSON.stringify({ type: 'get_state', id }));
  return (async () => {
    for (let i = 0; i < 60; i++) {
      const hit = messages.slice(before).find((m) => m.bridge === 'rpc' && m.payload && m.payload.id === id);
      if (hit) return hit.payload;
      await sleep(100);
    }
    return null;
  })();
}

const fail = (msg) => { console.error('FAIL: ' + msg); process.exitCode = 1; };

(async () => {
  /* ── 1. the record is stale: skip it before pi can be started in it ────── */
  {
    const gone = path.join(os.tmpdir(), `verify-stale-${process.pid}-gone-folder`);
    const scratch = makeScratch('gone', {
      type: 'session', version: 3, id: 'old', timestamp: '2026-01-01T00:00:00.000Z', cwd: gone,
    });
    const { bridge, logFile } = await startBridge(scratch, BASE_PORT);
    const messages = [];
    const ws = await connect(BASE_PORT, messages);
    await sleep(2500);
    const argv = readArgv(scratch);
    const log = fs.readFileSync(logFile, 'utf8');

    if (!argv.length) fail('the agent was never started');
    if (argv.some((a) => a.includes('--session'))) {
      fail('the bridge started the agent in a session whose folder is gone: ' + JSON.stringify(argv));
    }
    if (argv.length > 1) fail(`the agent was started ${argv.length} times for one stale record`);
    if (!/forgetting last session \(its folder is gone\)/.test(log)) {
      fail('the bridge did not say the record was dropped:\n' + log.slice(-400));
    }
    const failed = messages.find((m) => m.bridge === 'session_resume_failed');
    if (!failed) fail('the page was not told why it is in a new session');
    else if (failed.reason !== 'folder') fail(`the reason was ${JSON.stringify(failed.reason)}, expected "folder"`);
    const state = await askState(ws, messages, 'probe-1');
    if (!state || !state.success) fail('the agent did not answer get_state after starting: ' + JSON.stringify(state));
    const record = JSON.parse(fs.readFileSync(path.join(scratch.dir, 'last.json'), 'utf8'));
    if (record.path === scratch.session) fail('the stale session is still the recorded one');
    ws.close();
    bridge.kill();
    await sleep(300);
    console.log('  stale record: skipped before the start, agent is up, page told why');
  }

  /* ── 2. a start in a session that dies anyway is not repeated forever ──── */
  {
    const scratch = makeScratch('dies', {
      type: 'session', version: 3, id: 'old', timestamp: '2026-01-01T00:00:00.000Z', cwd: scratchCwd(),
    });
    const { bridge, logFile } = await startBridge(scratch, BASE_PORT + 1);
    const messages = [];
    const ws = await connect(BASE_PORT + 1, messages);
    await sleep(4000);

    const argv = readArgv(scratch);
    if (argv.length < 2) fail('the agent was not retried after the session start failed');
    else {
      if (!argv[0].includes('--session')) fail('the first start did not even try the recorded session');
      if (argv[argv.length - 1].includes('--session')) {
        fail('the retry resumed the same session again: ' + JSON.stringify(argv[argv.length - 1]));
      }
    }
    const failed = messages.find((m) => m.bridge === 'session_resume_failed');
    if (!failed) fail('the page was not told the session could not be reopened');
    const state = await askState(ws, messages, 'probe-2');
    if (!state || !state.success) fail('the agent did not answer get_state after the retry: ' + JSON.stringify(state));
    const log = fs.readFileSync(logFile, 'utf8');
    if (!/the agent died right after starting in/.test(log)) {
      fail('the bridge did not notice the immediate exit:\n' + log.slice(-400));
    }
    ws.close();
    bridge.kill();
    await sleep(300);
    console.log('  failed start: the record was dropped, the retry came up in a new session');
  }

  if (process.exitCode) {
    console.error('FAIL: a stale recorded session still breaks the agent');
    process.exit(1);
  }
  console.log('  PASS a session whose folder is gone no longer turns into "the agent is not running"');
})().catch((e) => { console.error('FAIL: ' + ((e && e.stack) || e)); process.exit(1); });

function scratchCwd() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-stale-cwd-'));
  cleanupDirs.push(d);
  return d;
}
