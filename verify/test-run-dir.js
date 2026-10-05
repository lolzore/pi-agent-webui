/*
 * Local-mode check for the ?dir= hole (and for the same validator in general).
 *
 * This one needs no container, so it always runs. It plants a directory that
 * really looks like a pi-subagents run root under the system temp dir, plus a
 * sibling directory holding a secret, then asks the bridge to read both.
 *
 *   - the genuine run directory must still be readable (the fix must not break
 *     the feature it is protecting);
 *   - a path that walks out of it with ".." must be refused, and the secret must
 *     not appear in the response.
 *
 * Before the fix, `<tmp>/pi-subagents-x/async-subagent-runs/../../../secret`
 * normalised to the secret directory and its status.json was returned.
 *
 * Usage: node verify/test-run-dir.js
 * Exit 0 = pass, 1 = fail, 77 = could not set up (reported as a skip).
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.env.PI_TEST_DIR_PORT || '3986', 10);
const SECRET = 'LOCAL_TRAVERSAL_LEAK';

let pass = 0, fail = 0;
const ok = (l, d) => { pass++; console.log(`  PASS ${l}${d ? ' (' + d + ')' : ''}`); };
const bad = (l, d) => { fail++; console.log(`  FAIL ${l}${d ? ' — ' + d : ''}`); };

function get(urlPath) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: urlPath, timeout: 20000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', error: 'timeout' }); });
  });
}

(async () => {
  const tmp = os.tmpdir();
  const scope = `pi-subagents-injtest-${process.pid}`;
  const runRoot = path.join(tmp, scope, 'async-subagent-runs');
  const runDir = path.join(runRoot, 'run-1');
  const secretDir = path.join(tmp, `injtest-secret-${process.pid}`);
  let child = null;
  const cleanup = () => {
    try { if (child) child.kill('SIGKILL'); } catch { /* gone */ }
    for (const d of [path.join(tmp, scope), secretDir]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ }
    }
  };
  process.on('exit', cleanup);

  try {
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'output-1.log'), 'the real run log\n');
    fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(path.join(secretDir, 'status.json'), JSON.stringify({ secret: SECRET }) + '\n');
  } catch (e) {
    console.log('  SKIP could not build the run tree:', e.message);
    process.exit(77);
  }

  // No PI_SESSION_DIR -> local mode, which is the branch that had the read hole.
  child = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PI_WEBUI_HOST: '127.0.0.1',
      PI_COMMAND: `node ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    const r = await get('/api/config');
    up = r.status === 200;
    if (!up) await new Promise((r2) => setTimeout(r2, 250));
  }
  if (!up) {
    console.log('  FAIL bridge did not come up\n' + log.slice(-500));
    process.exit(1);
  }

  // 1) a genuine run directory is still readable
  const good = await get('/api/subagent-output?run=abcdef12&dir=' + encodeURIComponent(runDir));
  let text = '';
  try { text = JSON.parse(good.body).text || ''; } catch { /* handled below */ }
  if (text.includes('the real run log')) ok('a genuine run directory is still readable');
  else bad('a genuine run directory is still readable', `body: ${good.body.slice(0, 160)}`);

  // 2) walking out of it is refused
  const trav = `${runRoot}${path.sep}..${path.sep}..${path.sep}${path.basename(secretDir)}`;
  const r2 = await get('/api/subagent-output?run=abcdef12&dir=' + encodeURIComponent(trav));
  if (r2.body.includes(SECRET)) bad('".." out of the run root is refused', 'the secret was returned');
  else ok('".." out of the run root is refused', 'no secret in the response');

  // 3) a directory that is not a run root at all is refused
  const r3 = await get('/api/subagent-output?run=abcdef12&dir=' + encodeURIComponent(secretDir));
  if (r3.body.includes(SECRET)) bad('a non-run directory is refused', 'the secret was returned');
  else ok('a non-run directory is refused');

  // 4) shell metacharacters cannot get through the validator
  const meta = `${runRoot}${path.sep}run-1; echo hi`;
  const r4 = await get('/api/subagent-output?run=abcdef12&dir=' + encodeURIComponent(meta));
  if (r4.body.includes(SECRET)) bad('metacharacters are refused', 'unexpected content');
  else ok('metacharacters are refused', 'status ' + r4.status);

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('test-run-dir crashed:', e && e.message);
  process.exit(1);
});
