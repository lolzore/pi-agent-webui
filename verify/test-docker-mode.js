/*
 * Docker session-directory mode, end to end.
 *
 * The bridge can be told that pi's sessions live inside a container:
 *
 *     PI_SESSION_DIR=docker:<container>:/root/.pi/agent/sessions
 *
 * which is the documented "host bridge driving an agent in a container" setup,
 * and the one every bug found in this area lived in:
 *
 *   - the directory was "sanitised" by deleting the dot in `.pi`, so the scan
 *     looked at a path that does not exist and reported zero sessions, silently;
 *   - it needed GNU `find -printf`, so BusyBox images were silently empty too;
 *   - the file list and the session paths were interpolated into `sh -c` scripts,
 *     which was two command injections.
 *
 * This drives the whole surface against a real container: list, transcript,
 * one image out of the transcript, download, and delete - plus the argv form of
 * the tail read, with a filename that would have broken the old shell string.
 *
 * Usage: PI_TEST_CONTAINER=<running container> node verify/test-docker-mode.js
 * Exit 0 pass, 1 fail, 77 skip (no container / not running).
 */
'use strict';

const { execFile, spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const CONTAINER = (process.env.PI_TEST_CONTAINER || '').trim();
const PORT = parseInt(process.env.PI_TEST_DOCKER_PORT || '3984', 10);
const CTR_DIR = '/root/.pi/agent/sessions';
// A name that would have closed the quote in the old `for f in '<paths>'` script.
const ODD = "odd's file.jsonl";

let pass = 0, fail = 0;
const ok = (l, d) => { pass++; console.log(`  PASS ${l}${d ? ' (' + d + ')' : ''}`); };
const bad = (l, d) => { fail++; console.log(`  FAIL ${l}${d ? ' — ' + d : ''}`); };
const note = (l, d) => console.log(`       ${l}${d ? ': ' + d : ''}`);

function docker(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    execFile('docker', args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, shell: false },
      (err, stdout) => resolve({ code: err ? 1 : 0, out: String(stdout || '') }));
  });
}
const inCtr = (script, ...rest) => docker(['exec', CONTAINER, 'sh', '-c', script, 'sh', ...rest]);

/* Run a script in the container with data on stdin.
 *
 * The session files are written this way rather than interpolated into the
 * command: a 15 KB image makes the payload far too long for a command line
 * (ENAMETOOLONG, which is how the first version of this test failed), and stdin
 * has no quoting rules to get wrong either. */
function inCtrStdin(script, input) {
  return new Promise((resolve) => {
    const p = spawn('docker', ['exec', '-i', CONTAINER, 'sh', '-c', script], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code: code || 0, out }));
    p.on('error', (e) => resolve({ code: 1, out: String(e.message) }));
    p.stdin.on('error', () => { /* the child went away */ });
    p.stdin.end(input);
  });
}

function req(method, urlPath, body) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method, timeout: 30000 }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(c), headers: res.headers }));
    });
    r.on('error', (e) => resolve({ status: 0, buf: Buffer.alloc(0), error: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, buf: Buffer.alloc(0), error: 'timeout' }); });
    if (body) r.write(body);
    r.end();
  });
}
const get = (p) => req('GET', p);
const jget = async (p) => { const r = await get(p); try { return { ...r, json: JSON.parse(r.buf.toString('utf8')) }; } catch { return { ...r, json: null }; } };

function startBridge(env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PI_WEBUI_HOST: '127.0.0.1',
      PI_SESSION_DIR: `docker:${CONTAINER}:${CTR_DIR}`,
      PI_COMMAND: `node ${path.join(ROOT, 'bridge', 'mock_agent.js')}`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  return { child, log: () => log };
}

(async () => {
  if (!CONTAINER) { console.log('  SKIP no PI_TEST_CONTAINER set'); process.exit(77); }
  const alive = await docker(['inspect', '-f', '{{.State.Running}}', CONTAINER]);
  if (alive.code !== 0 || !alive.out.includes('true')) { console.log(`  SKIP ${CONTAINER} is not running`); process.exit(77); }

  // One session with an image large enough to be externalised (the threshold is
  // 8 KB of base64; anything smaller deliberately stays inline), plus one with an
  // awkward name.
  const IMG_BYTES = 15000;
  const IMG = Buffer.alloc(IMG_BYTES, 'D').toString('base64');
  const IMG_MARK = 'D'.repeat(64);
  const lines = [
    JSON.stringify({ type: 'session', name: 'docker mode' }),
    JSON.stringify({ type: 'message', id: 'e1', message: { role: 'user', timestamp: Date.now(),
      content: [{ type: 'text', text: 'hello from docker mode' }, { type: 'image', mimeType: 'image/png', data: IMG }] } }),
    JSON.stringify({ type: 'message', id: 'e2', message: { role: 'assistant', timestamp: Date.now() + 1,
      content: [{ type: 'text', text: 'and a reply' }], usage: { input: 10, output: 5 } } }),
  ].join('\n') + '\n';

  // Files are written over stdin (see inCtrStdin), so the size of the image does
  // not matter and neither do the quotes in the awkward filename.
  const made1 = await inCtr(`mkdir -p ${CTR_DIR} && rm -rf ${CTR_DIR}/* 2>/dev/null; true`);
  const made2 = await inCtrStdin(`cat > "${CTR_DIR}/mode.jsonl"`, lines);
  const made3 = await inCtrStdin(`cat > "${CTR_DIR}/${ODD}"`, lines);
  if (made1.code !== 0 || made2.code !== 0 || made3.code !== 0) {
    console.log('  FAIL could not plant sessions:', (made1.out + made2.out + made3.out).slice(0, 200));
    process.exit(1);
  }

  const bridge = startBridge();
  const cleanup = () => { try { bridge.child.kill('SIGKILL'); } catch { /* gone */ } };
  process.on('exit', cleanup);

  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      const r = await get('/api/config');
      up = r.status === 200;
      if (!up) await new Promise((r2) => setTimeout(r2, 250));
    }
    if (!up) { console.log('  FAIL bridge did not come up\n' + bridge.log().slice(-500)); process.exit(1); }

    // 1. the list, from a dotted path, with an apostrophe in one of the names
    const list = await jget('/api/sessions');
    const sessions = (list.json && list.json.sessions) || [];
    if (sessions.length === 2) ok('lists both sessions through docker exec', sessions.length + ' found');
    else bad('lists both sessions through docker exec', `${sessions.length} found: ${JSON.stringify(sessions.map((s) => s.path))}`);

    const odd = sessions.find((s) => s.path.includes("odd's"));
    if (odd) ok('a session whose name contains an apostrophe survives the scan');
    else bad('a session whose name contains an apostrophe survives the scan');

    const target = (sessions.find((s) => s.path.endsWith('/mode.jsonl')) || {}).path;

    // 2. the transcript, read line by line out of the container
    if (target) {
      const t = await jget('/api/session-messages?path=' + encodeURIComponent(target));
      const msgs = (t.json && t.json.messages) || [];
      if (t.status === 200 && msgs.length === 2) ok('transcript streams out of the container', msgs.length + ' messages');
      else bad('transcript streams out of the container', `status ${t.status}, ${msgs.length} messages`);
      if (t.json && t.json.imagesOut === 1) ok('the image was named rather than shipped', 'imagesOut=1');
      else note('imagesOut', JSON.stringify(t.json && t.json.imagesOut));

      // 3. one image, fetched by reference
      const im = await get(`/api/session-image?path=${encodeURIComponent(target)}&line=2&part=1`);
      const body = im.buf.toString('utf8');
      if (im.status === 200 && im.buf.length === IMG_BYTES && body.startsWith(IMG_MARK)) {
        ok('the image is served by reference from the container', im.buf.length + ' bytes');
      } else {
        bad('the image is served by reference from the container', `status ${im.status}, ${im.buf.length} bytes`);
      }

      // 4. download
      const dl = await get('/api/session-file?path=' + encodeURIComponent(target));
      if (dl.status === 200 && dl.buf.length > 0) ok('session download works', dl.buf.length + ' bytes');
      else bad('session download works', 'status ' + dl.status);

      // 5. delete, and confirm it is gone inside the container
      const del = await req('POST', '/api/session-delete', JSON.stringify({ path: target }));
      const after = await inCtr(`test -f "${target}" && echo STILL-THERE || echo GONE`);
      if (del.status === 200 && after.out.includes('GONE')) ok('session delete removes it inside the container');
      else bad('session delete removes it inside the container', `status ${del.status} / ${after.out.trim()}`);
    } else {
      bad('found the plain session to exercise the transcript against');
    }

    // 6. a path outside the session dir is refused (the guard that survived)
    const outside = await jget('/api/session-messages?path=' + encodeURIComponent('/etc/passwd'));
    if (outside.status === 400) ok('a path outside the session dir is refused', '400');
    else bad('a path outside the session dir is refused', 'status ' + outside.status);

    // 7. the argv form of the tail read, with the apostrophe name: the old
    //    version put this path inside `sh -c`, where the quote ended the string.
    const tail = await docker(['exec', CONTAINER, 'tail', '-c', '+1', `${CTR_DIR}/${ODD}`]);
    if (tail.code === 0 && tail.out.includes('hello from docker mode')) ok('tail reads a file whose name contains an apostrophe (argv, no shell)');
    else bad('tail reads a file whose name contains an apostrophe (argv, no shell)', tail.out.slice(0, 120));
  } finally {
    cleanup();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test-docker-mode crashed:', e && e.message); process.exit(1); });
