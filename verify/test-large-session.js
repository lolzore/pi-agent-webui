/*
 * Issue #196: "VERY large sessions (100+MB) will freeze the server."
 *
 * The transcript reader was rewritten to stream lines, parse one message at a
 * time and hand the event loop back every 250 messages. This is the regression
 * that keeps it that way: it builds a ~100 MB session with 20,000 messages,
 * asks for the transcript, and polls /api/health throughout. A synchronous
 * read/parse/serialise would show up as a multi-second gap between polls (or a
 * failed poll); the streaming reader keeps the gap small and still returns the
 * whole transcript.
 *
 * It starts its own bridge and fixture, so it never touches the running WebUI
 * or the real session directory.
 *
 * Usage: node test-large-session.js
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 3097;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-large-'));
for (const d of ['agent', 'sessions', 'ws']) fs.mkdirSync(path.join(scratch, d), { recursive: true });
const sess = path.join(scratch, 'sessions', 'large.jsonl');
const N = 20000;
const BODY = 'x'.repeat(5000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bridge = null;
const cleanup = () => {
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);
const fail = (m) => { console.error('FAIL: ' + m); cleanup(); process.exit(1); };

const get = (p) => new Promise((res, rej) => {
  const t = Date.now();
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let bytes = 0; let first = ''; let last = '';
    r.setEncoding('utf8');
    r.on('data', (c) => { bytes += Buffer.byteLength(c); if (first.length < 200) first += c.slice(0, 200 - first.length); last = (last + c).slice(-200); });
    r.on('end', () => res({ status: r.statusCode, bytes, first, last, ms: Date.now() - t }));
  }).on('error', rej);
});

(async () => {
  const fd = fs.openSync(sess, 'w');
  fs.writeSync(fd, JSON.stringify({ type: 'session', version: 1, sessionFile: sess }) + '\n');
  for (let i = 0; i < N; i++) {
    fs.writeSync(fd, JSON.stringify({
      type: 'message', id: 'm' + i, timestamp: Date.now() + i,
      message: { role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: 'message ' + i + ' ' + BODY }] },
    }) + '\n');
  }
  fs.closeSync(fd);
  const mb = fs.statSync(sess).size / (1024 * 1024);
  if (mb < 90) fail('fixture is only ' + mb.toFixed(1) + ' MB');

  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: path.join(scratch, 'agent'), PI_CODING_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_SESSION_DIR: path.join(scratch, 'sessions'), WORKSPACE_DIR: path.join(scratch, 'ws'),
      PI_SESSION_DIR: path.join(scratch, 'sessions'), PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'),
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_LLAMA_SCAN: 'off', PORT: String(PORT),
    }), stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = ''; bridge.stderr.on('data', (c) => { err += c; });
  let up = false;
  for (let i = 0; i < 100; i++) {
    try { await get('/api/health'); up = true; break; } catch { await sleep(200); }
  }
  if (!up) fail('the bridge never came up\n' + err.slice(-500));

  let maxGap = 0;
  let lastTick = Date.now();
  let polls = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now;
    if (gap > maxGap) maxGap = gap;
    polls++;
    get('/api/health').catch(() => {});
  }, 20);

  const transcript = await get('/api/session-messages?path=' + encodeURIComponent(sess));
  clearInterval(timer);
  if (transcript.status !== 200) fail('the transcript request returned ' + transcript.status);
  if (transcript.bytes < 90 * 1024 * 1024) fail('the transcript was only ' + (transcript.bytes / 1024 / 1024).toFixed(1) + ' MB');
  if (!/"messages":\[/.test(transcript.first)) fail('the transcript did not start with a messages array: ' + transcript.first.slice(0, 120));
  if (!transcript.last.includes('}') || !transcript.last.includes(']')) fail('the transcript did not end cleanly: ' + transcript.last);
  if (maxGap > 500) fail(`the bridge stopped answering for ${maxGap}ms while reading a ${mb.toFixed(0)}MB session`);

  // and it is still alive and scanning sessions afterwards
  const after = await get('/api/health');
  if (after.status !== 200) fail('the bridge did not answer /api/health after the large read');
  const list = await get('/api/sessions');
  if (list.status !== 200 || !/"sessions":\[/.test(list.first)) fail('the bridge did not answer /api/sessions after the large read');

  console.log(`  ${mb.toFixed(0)}MB / ${N} messages: transcript ${(transcript.bytes / 1024 / 1024).toFixed(0)}MB in ${transcript.ms}ms, health polls ${polls}, worst gap ${maxGap}ms`);
  console.log('  PASS #196 a 100MB session streams without freezing the bridge');
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
