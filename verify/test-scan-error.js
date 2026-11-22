/*
 * A local session directory that cannot be read must be reported, not shown as
 * "no sessions" (issue #30) and must not throw the typo that killed the catch
 * block (issue #230).
 *
 * Starts a scratch bridge whose PI_SESSION_DIR is a regular FILE, so readdir
 * fails with ENOTDIR, and asserts /api/sessions answers 200 with an empty list
 * and a scanError explaining why - and that the bridge is still healthy.
 *
 * Usage: node test-scan-error.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 4350 + (process.pid % 200);
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-scan-error-'));
const BAD = path.join(T, 'not-a-directory');
fs.writeFileSync(BAD, 'this is a file, not a session directory\n');
const fail = (m) => { console.error('FAIL: ' + m); cleanup(); process.exit(1); };
let child = null;
function cleanup() {
  try { child && child.kill(); } catch { /* gone */ }
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* gone */ }
}
process.on('exit', cleanup);

const get = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 5000 }, (res) => {
    let b = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { b += c; });
    res.on('end', () => { let d = null; try { d = JSON.parse(b); } catch { /* text */ } resolve({ status: res.statusCode, body: b, d }); });
  }).on('timeout', function () { this.destroy(new Error('timeout')); }).on('error', reject);
});

(async () => {
  child = spawn(process.execPath, ['bridge/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PI_COMMAND: `node ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_SESSION_DIR: BAD,
      PI_CODING_AGENT_SESSION_DIR: BAD,
      PI_AGENT_DIR: path.join(T, 'agent'),
      PI_CODING_AGENT_DIR: path.join(T, 'agent'),
      WORKSPACE_DIR: path.join(T, 'workspace'),
      PI_WEBUI_SETTINGS: path.join(T, 'settings.json'),
      PI_WEBUI_LAST_SESSION: path.join(T, 'last.json'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (c) => { err += c; });

  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await get('/api/health')).status === 200) { up = true; break; } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) fail('the bridge never came up' + (err ? '\n' + err.slice(-500) : ''));

  const r = await get('/api/sessions');
  if (r.status !== 200) fail(`/api/sessions returned ${r.status}: ${r.body.slice(0, 200)}`);
  if (!r.d || !Array.isArray(r.d.sessions)) fail('the answer has no sessions array');
  if (r.d.sessions.length) fail('a directory that cannot be read returned sessions');
  if (!r.d.scanError || !/could not read/i.test(r.d.scanError)) {
    fail('no scanError explaining the unreadable directory: ' + JSON.stringify(r.d.scanError));
  }
  if (!/not-a-directory/.test(r.d.scanError)) fail('scanError does not name the directory: ' + r.d.scanError);

  const h = await get('/api/health');
  if (h.status !== 200 || !h.d || !h.d.ok) fail('the bridge is not healthy after the failed scan');

  cleanup();
  console.log('  an unreadable session directory answers 200 with sessions:[] and a scanError, and the bridge stays up');
  console.log(JSON.stringify({ scanError: r.d.scanError.slice(0, 120), sessions: 0 }));
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
