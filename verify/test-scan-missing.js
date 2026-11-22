/*
 * A session directory that does not exist yet is empty, not broken.
 *
 * pi creates sessions/ on its first start; a page can ask for the list before
 * that happens. The scan used to turn ENOENT into a scanError, which the
 * sidebar showed as a failed session list on a fresh install.
 *
 * Usage: node test-scan-missing.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 4550 + (process.pid % 200);
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-scan-missing-'));
const MISSING = path.join(T, 'sessions-not-created-yet');
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
  if (fs.existsSync(MISSING)) fail('the fixture directory already exists');
  child = spawn(process.execPath, ['bridge/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PI_COMMAND: `node ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_SESSION_DIR: MISSING,
      PI_CODING_AGENT_SESSION_DIR: MISSING,
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
  if (r.d.sessions.length) fail('a missing directory returned sessions');
  if (r.d.scanError) fail('a missing directory was reported as a scan error: ' + r.d.scanError);

  cleanup();
  console.log('  a missing session directory answers 200 with sessions:[] and no scanError');
  console.log(JSON.stringify({ scanError: r.d.scanError || null, sessions: 0 }));
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
