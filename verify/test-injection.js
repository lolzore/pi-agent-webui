/*
 * Injection regression test.
 *
 * Two holes were reported and fixed, and both are checked here against the real
 * shipped source - the bridge is started with the real server.js, the payloads
 * are planted in a real container, and the assertions are about side effects
 * (a marker file appearing) rather than about strings in the response.
 *
 *   1. GET /api/sessions executed a command taken from a *session file name*.
 *      scanDockerSessions built `for f in '<paths>'` and handed it to `sh -c`, so
 *      a file called  a'; do touch PWNED; done #x.jsonl  closed the quote.
 *      It also mangled the session dir (the dot in ~/.pi was stripped, so the
 *      scan silently found nothing) and needed GNU `find -printf`.
 *
 *   2. GET /api/subagent-output?dir=… executed a command (container mode) or read
 *      an arbitrary file (local mode), because `dir` went into an `ls` script and
 *      was only checked by an unanchored regex.
 *
 * Usage:
 *   node verify/test-injection.js                 # uses $PI_TEST_CONTAINER, else skips
 *   PI_TEST_CONTAINER=t-gnu node verify/test-injection.js
 *
 * Exits 0 when every applicable check passes, 77 when there is nothing to test
 * (no container), and 1 on any failure. A skip is not a pass.
 */
'use strict';

const { execFile, spawn } = require('child_process');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONTAINER = (process.env.PI_TEST_CONTAINER || '').trim();
const PORT = parseInt(process.env.PI_TEST_INJ_PORT || '3985', 10);

// The dotted directory is deliberate: it is the shape the old sanitiser broke.
const SESSION_DIR = '/root/.pi/agent/sessions';
const MARKER = 'PWNED_INJECTION';
const TRAVERSAL_MARKER = 'LOCAL_TRAVERSAL_LEAK';

let pass = 0, fail = 0;
function ok(label, detail) { pass++; console.log(`  PASS ${label}${detail ? ' (' + detail + ')' : ''}`); }
function bad(label, detail) { fail++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }

function docker(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    execFile('docker', args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, shell: false },
      (err, stdout) => resolve({ code: err ? (err.code || 1) : 0, out: String(stdout || '') }));
  });
}
const inCtr = (script, timeoutMs) => docker(['exec', CONTAINER, 'sh', '-c', script], timeoutMs);

function get(urlPath) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: urlPath, timeout: 30000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', error: 'timeout' }); });
  });
}

// Any marker anywhere in the container - the workdir is not always "/", which is
// exactly how the first exploit hid from me for one round.
async function findMarkers(name) {
  const r = await inCtr(`find / -name '${name}' -not -path '/proc/*' -not -path '/sys/*' 2>/dev/null || true`);
  return r.out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function startBridge() {
  const env = {
    ...process.env,
    PORT: String(PORT),
    PI_WEBUI_HOST: '127.0.0.1',
    PI_SESSION_DIR: `docker:${CONTAINER}:${SESSION_DIR}`,
    PI_COMMAND: `node ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
  };
  const child = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  return { child, log: () => log };
}

async function waitForBridge(timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await get('/api/config');
    if (r.status === 200) return true;
    await new Promise((r2) => setTimeout(r2, 250));
  }
  return false;
}

(async () => {
  if (!CONTAINER) {
    console.log('  SKIP no PI_TEST_CONTAINER set — nothing to plant a payload in');
    process.exit(77);
  }
  const alive = await docker(['inspect', '-f', '{{.State.Running}}', CONTAINER]);
  if (alive.code !== 0 || !alive.out.includes('true')) {
    console.log(`  SKIP container ${CONTAINER} is not running`);
    process.exit(77);
  }

  // A clean session directory, and a payload directory for the local-file test.
  await inCtr(`rm -rf ${SESSION_DIR} && mkdir -p ${SESSION_DIR}`);
  await inCtr(`rm -f /${MARKER} /workspace/${MARKER} /tmp/${MARKER} 2>/dev/null; true`);
  await inCtr(`find / -name '${MARKER}' -not -path '/proc/*' 2>/dev/null | xargs -r rm -f; true`);

  // ── the payload ────────────────────────────────────────────────────────
  // No "/" (a filename cannot contain one), ends ".jsonl" so it survives the
  // .jsonl filter, and leaves the shell syntactically valid after the break-out.
  const payloadName = `a'; do touch ${MARKER}; done #x.jsonl`;
  const mk = [
    `printf '{"type":"session","name":"pwn"}\\n' > "${SESSION_DIR}/${payloadName}"`,
    `ls -1 "${SESSION_DIR}"`,
  ].join(' && ');
  const planted = await inCtr(mk);
  if (planted.code !== 0) {
    console.log('  FAIL could not plant the payload:', planted.out.trim().slice(0, 200));
    process.exit(1);
  }

  const bridge = startBridge();
  const cleanup = () => { try { bridge.child.kill('SIGKILL'); } catch { /* gone */ } };
  process.on('exit', cleanup);

  try {
    if (!(await waitForBridge())) {
      console.log('  FAIL bridge did not come up\n' + bridge.log().slice(-600));
      process.exit(1);
    }

    // ── 1. the session list still works at all (the dot in ~/.pi) ────────
    const sessions = await get('/api/sessions');
    let list = [];
    try { list = JSON.parse(sessions.body).sessions || []; } catch { /* handled below */ }
    if (list.length === 1 && list[0].path === `${SESSION_DIR}/${payloadName}`) {
      ok('dotted session dir is scanned (the sanitiser no longer eats ".pi")', '1 session, path intact');
    } else {
      bad('dotted session dir is scanned', `got ${list.length} sessions: ${JSON.stringify(list.map((s) => s.path))}`);
    }

    // ── 2. the headline: the filename must not have executed ─────────────
    const afterList = await findMarkers(MARKER);
    if (afterList.length === 0) {
      ok('GET /api/sessions did NOT run the command in the file name');
    } else {
      bad('GET /api/sessions did NOT run the command in the file name',
        'marker created at ' + afterList.join(', '));
    }

    // a second call, to be sure it is not just the first one being special
    await get('/api/sessions');
    const afterList2 = await findMarkers(MARKER);
    if (afterList2.length === 0) ok('a second GET /api/sessions is also clean');
    else bad('a second GET /api/sessions is also clean', afterList2.join(', '));

    // the title still comes back (the file is readable, it just is not script)
    const named = list[0] && list[0].name;
    if (named !== undefined && named !== null && String(named).length > 0) {
      ok('the odd-named session still gets a name', JSON.stringify(String(named).slice(0, 40)));
    } else {
      bad('the odd-named session still gets a name', JSON.stringify(named));
    }

    // ── 3. ?dir= in container mode must not execute ──────────────────────
    const evilDir = `/tmp/pi-subagents-x/async-subagent-runs/'; touch ${MARKER}; '`;
    const r3 = await get('/api/subagent-output?run=abcdef12&dir=' + encodeURIComponent(evilDir));
    const after3 = await findMarkers(MARKER);
    if (after3.length === 0) ok('GET /api/subagent-output?dir=… did NOT execute (container mode)', 'status ' + r3.status);
    else bad('GET /api/subagent-output?dir=… did NOT execute (container mode)', after3.join(', '));

    // ── 4. a run directory that really is one still works ────────────────
    const runDir = '/tmp/pi-subagents-x/async-subagent-runs/r1';
    await inCtr(`mkdir -p ${runDir} && printf 'a real log\\n' > ${runDir}/output-1.log`);
    const good = await get('/api/subagent-output?run=abcdef12&dir=' + encodeURIComponent(runDir));
    let goodText = '';
    try { goodText = JSON.parse(good.body).text || ''; } catch { /* handled below */ }
    if (goodText.includes('a real log')) {
      ok('a genuine run directory is still readable (the fix did not break it)');
    } else {
      bad('a genuine run directory is still readable', `body: ${good.body.slice(0, 160)}`);
    }

    // ── 5. traversal out of the run directory must be refused ────────────
    await inCtr(`mkdir -p /tmp/secret-dir && printf '{"secret":"${TRAVERSAL_MARKER}"}\\n' > /tmp/secret-dir/status.json`);
    const trav = `/tmp/pi-subagents-x/async-subagent-runs/../../../secret-dir`;
    const r5 = await get('/api/subagent-output?run=abcdef12&dir=' + encodeURIComponent(trav));
    if (r5.body.includes(TRAVERSAL_MARKER)) {
      bad('traversal out of the run dir is refused', 'the secret was returned in the response');
    } else {
      ok('traversal out of the run dir is refused', 'no secret in the response');
    }
  } finally {
    cleanup();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('test-injection crashed:', e && e.message);
  process.exit(1);
});
