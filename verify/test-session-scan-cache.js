/*
 * #251: /api/sessions reports how many bytes the scan actually read. With the
 * per-file cache, a second scan of unchanged files must read none of them
 * (stat only) and still return the same list.
 *
 * Starts a scratch bridge with 20 session files of ~10 KB.
 *
 * Usage: node test-session-scan-cache.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 4650 + (process.pid % 200);
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-scan-cache-'));
const SESSIONS = path.join(T, 'sessions');
fs.mkdirSync(SESSIONS, { recursive: true });
for (let i = 0; i < 20; i++) {
  const f = path.join(SESSIONS, `2026-01-01T00-00-${String(i).padStart(2, '0')}-000Z_${String(i).padStart(4, '0')}.jsonl`);
  const pad = 'x'.repeat(10 * 1024);
  fs.writeFileSync(f, JSON.stringify({ type: 'session', version: 3, id: `s${i}`, timestamp: new Date().toISOString(), cwd: T }) + '\n' +
    JSON.stringify({ type: 'message', id: `m${i}`, timestamp: Date.now(), message: { role: 'user', content: [{ type: 'text', text: `session ${i} ${pad}` }] } }) + '\n');
}
const fail = (m) => { console.error('FAIL: ' + m); cleanup(); process.exit(1); };
let child = null;
function cleanup() {
  try { child && child.kill(); } catch { /* gone */ }
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* gone */ }
}
process.on('exit', cleanup);
const get = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 8000 }, (res) => {
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
      PI_SESSION_DIR: SESSIONS,
      PI_CODING_AGENT_SESSION_DIR: SESSIONS,
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

  const cold = await get('/api/sessions');
  const warm = await get('/api/sessions');
  if (cold.status !== 200 || warm.status !== 200) fail('a sessions scan did not answer 200');
  if (!cold.d || !Array.isArray(cold.d.sessions)) fail('no sessions array');
  if (cold.d.sessions.length !== 20) fail(`the first scan listed ${cold.d.sessions.length} sessions, expected 20`);
  if (!(cold.d.scanBytes > 0)) fail('the cold scan reported 0 bytes read');
  if (!warm.d || warm.d.sessions.length !== 20) fail('the warm scan returned a different list');
  if (warm.d.scanBytes !== 0) fail(`the warm scan still read ${warm.d.scanBytes} bytes; unchanged files should be stat-only`);
  const names = (d) => d.sessions.map((s) => s.name).join('|');
  if (names(cold.d) !== names(warm.d)) fail('the warm scan returned different names');
  console.log(`  cold scan read ${cold.d.scanBytes} bytes; warm scan read 0 and returned the same 20 sessions`);
  console.log(JSON.stringify({ coldBytes: cold.d.scanBytes, warmBytes: warm.d.scanBytes, sessions: warm.d.sessions.length }));
  cleanup();
  process.exit(0);
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
