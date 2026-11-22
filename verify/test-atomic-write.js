// Unit check: the atomic JSON write must land the file whole, leave no staging
// file behind, and never destroy the previous good file when a write fails.
//
// Usage: node test-atomic-write.js <server.js>

const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const serverFile = process.argv[2];
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };

const src = execFileSync(process.execPath,
  [path.join(__dirname, 'extract.js'), serverFile, 'function writeJsonAtomic('],
  { encoding: 'utf8' });
const writeJsonAtomic = vm.compileFunction(
  src + '\nreturn writeJsonAtomic;',
  ['fs', 'process'],
)(fs, process);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
try {
  const target = path.join(dir, 'models.json');

  // 1. contents land exactly
  writeJsonAtomic(target, { a: 1, b: [2, 3] });
  const want = JSON.stringify({ a: 1, b: [2, 3] }, null, 2);
  if (fs.readFileSync(target, 'utf8') !== want) fail('contents differ from what was written');

  // 2. no staging file left behind
  const left = fs.readdirSync(dir).filter((f) => f !== 'models.json');
  if (left.length) fail(`temp files left behind: ${left.join(', ')}`);

  // 3. a write that cannot succeed must leave the old file intact
  try {
    writeJsonAtomic(path.join(dir, 'no-such-dir', 'x.json'), { a: 2 });
  } catch { /* expected */ }
  if (!fs.existsSync(target)) fail('a failed write destroyed the previous good file');
  if (fs.readFileSync(target, 'utf8') !== want) fail('a failed write modified the previous good file');

  // 4. overwrite in place works
  writeJsonAtomic(target, { a: 9 });
  if (fs.readFileSync(target, 'utf8') !== JSON.stringify({ a: 9 }, null, 2)) fail('overwrite failed');
  const left2 = fs.readdirSync(dir).filter((f) => f !== 'models.json');
  if (left2.length) fail(`temp files left behind after overwrite: ${left2.join(', ')}`);

  console.log('4');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}


/* ── the two endpoints that used to write in place (issue #236) ────────────
 * A scratch bridge is started here so the checks cover the routes, not only the
 * helper: /api/ui-settings and AGENTS.md must land complete and leave no
 * staging file behind. */
async function endpointChecks() {
  const ROOT = path.join(__dirname, '..');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-ep-'));
  const AGENT = path.join(T, 'agent');
  fs.mkdirSync(AGENT, { recursive: true });
  const PORT = 4500 + (process.pid % 200);
  const child = spawn(process.execPath, ['bridge/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PI_COMMAND: `node ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_SESSION_DIR: path.join(T, 'sessions'),
      PI_CODING_AGENT_SESSION_DIR: path.join(T, 'sessions'),
      PI_AGENT_DIR: AGENT,
      PI_CODING_AGENT_DIR: AGENT,
      WORKSPACE_DIR: path.join(T, 'workspace'),
      PI_WEBUI_SETTINGS: path.join(T, 'settings.json'),
      PI_WEBUI_LAST_SESSION: path.join(T, 'last.json'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const cleanup = () => {
    try { child.kill(); } catch { /* gone */ }
    try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* gone */ }
  };
  const req = (method, p, body) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout: 6000,
      headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let d = null; try { d = JSON.parse(b); } catch { /* text */ } resolve({ status: res.statusCode, body: b, d }); });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await req('GET', '/api/health')).status === 200) { up = true; break; } } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!up) throw new Error('the scratch bridge never came up');

    const put = await req('POST', '/api/ui-settings', JSON.stringify({ agentName: 'atomic-probe', atomicProbe: 'yes' }));
    if (put.status !== 200) throw new Error('POST /api/ui-settings returned ' + put.status);
    const got = await req('GET', '/api/ui-settings');
    if (!got.d || got.d.atomicProbe !== 'yes') throw new Error('the settings write did not persist');
    const settingsTmp = fs.readdirSync(T).filter((f) => f.includes('.tmp'));
    if (settingsTmp.length) throw new Error('settings staging files left behind: ' + settingsTmp.join(', '));

    const agents = await req('POST', '/api/pi-agents', JSON.stringify({ content: '# atomic probe\n' }));
    if (agents.status !== 200) throw new Error('POST /api/pi-agents returned ' + agents.status);
    const readBack = await req('GET', '/api/pi-agents');
    if (!readBack.d || !readBack.d.global || !/atomic probe/.test(readBack.d.global.content || '')) {
      throw new Error('AGENTS.md did not land complete');
    }
    const agentTmp = fs.readdirSync(AGENT).filter((f) => /AGENTS\.md.*\.tmp/.test(f));
    if (agentTmp.length) throw new Error('AGENTS.md staging files left behind: ' + agentTmp.join(', '));
    console.log('2 endpoints');
  } finally {
    cleanup();
  }
}

endpointChecks().then(() => process.exit(0)).catch((e) => { console.error('FAIL: ' + (e && e.stack || e)); process.exit(1); });
