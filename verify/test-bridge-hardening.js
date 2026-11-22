/*
 * Three failure paths that used to take the bridge or the page with them:
 *
 *  - #237: a write failure inside the async `req.on('end')` websearch handler
 *    was an unhandled rejection, which exits Node. It must answer 500 and the
 *    bridge must keep serving.
 *  - #240: an oversized /api/upload-raw had no response (the request was
 *    destroyed before out.on('finish')) and left a temp file. It must answer a
 *    JSON 413 and clean up.
 *  - #244: /api/session-image served whatever MIME the session file named. A
 *    text/html "image" must be refused; a real image still works with nosniff.
 *
 * Starts one scratch bridge with an unwritable SearXNG config, a small upload
 * limit, and a crafted session file.
 *
 * Usage: node test-bridge-hardening.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 4400 + (process.pid % 200);
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-hardening-'));
const SESSIONS = path.join(T, 'sessions');
const WORKSPACE = path.join(T, 'workspace');
const AGENT = path.join(T, 'agent');
fs.mkdirSync(SESSIONS, { recursive: true });
fs.mkdirSync(WORKSPACE, { recursive: true });
fs.mkdirSync(AGENT, { recursive: true });

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SESSION = path.join(SESSIONS, 'crafted-image-mime.jsonl');
fs.writeFileSync(SESSION,
  JSON.stringify({ type: 'session', id: 'hardening', timestamp: new Date().toISOString(), cwd: T }) + '\n' +
  JSON.stringify({
    type: 'message', id: 'm1', timestamp: Date.now(),
    message: { role: 'user', content: [
      { type: 'image', mimeType: 'text/html', data: Buffer.from('<script>alert(1)</script>').toString('base64') },
      { type: 'image', mimeType: 'image/png', data: PNG },
    ] },
  }) + '\n');

const fail = (m) => { console.error('FAIL: ' + m); cleanup(); process.exit(1); };
let child = null;
function cleanup() {
  try { child && child.kill(); } catch { /* gone */ }
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* gone */ }
}
process.on('exit', cleanup);

function request(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout: 8000, headers }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let d = null;
        try { d = JSON.parse(b); } catch { /* binary/text */ }
        resolve({ status: res.statusCode, headers: res.headers, body: b, d });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const postJson = (p, obj) => request('POST', p, JSON.stringify(obj), { 'Content-Type': 'application/json' });

(async () => {
  child = spawn(process.execPath, ['bridge/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PI_COMMAND: `node ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_SESSION_DIR: SESSIONS,
      PI_CODING_AGENT_SESSION_DIR: SESSIONS,
      PI_AGENT_DIR: AGENT,
      PI_CODING_AGENT_DIR: AGENT,
      WORKSPACE_DIR: WORKSPACE,
      PI_WEBUI_SETTINGS: path.join(T, 'settings.json'),
      PI_WEBUI_LAST_SESSION: path.join(T, 'last.json'),
      // Parent directory does not exist, so the atomic write throws.
      PI_SEARXNG_CONFIG: path.join(T, 'missing-dir', 'searxng.json'),
      PI_WEBUI_MAX_UPLOAD: '1024',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (c) => { err += c; });

  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await request('GET', '/api/health')).status === 200) { up = true; break; } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) fail('the bridge never came up' + (err ? '\n' + err.slice(-600) : ''));

  /* #237: the async /api/websearch-setup handler writes the SearXNG config
   * after probing the URL. Point it at a fake answering instance so it reaches
   * the write, which fails (no parent directory) - the handler must answer 500
   * and the process must survive. */
  const fakeSearx = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: [] }));
  });
  await new Promise((r) => fakeSearx.listen(0, '127.0.0.1', r));
  const fakePort = fakeSearx.address().port;
  const cfg = await postJson('/api/websearch-setup', { action: 'url', url: `http://127.0.0.1:${fakePort}/` });
  fakeSearx.close();
  if (cfg.status !== 500) fail(`a failed websearch write returned ${cfg.status}, expected 500: ${cfg.body.slice(0, 200)}`);
  if (!cfg.d || !/save|ENOENT|no such|searxng/i.test(String(cfg.d.error || ''))) fail('the 500 did not explain the write failure: ' + cfg.body.slice(0, 200));
  const healthyAfterCfg = await request('GET', '/api/health');
  if (healthyAfterCfg.status !== 200) fail('the bridge died after the failed websearch write');
  console.log('  #237 a failed async handler answers 500 and the bridge keeps running');

  // #240: an oversized raw upload answers 413 and leaves no staging file.
  const tooBig = await request('POST', '/api/upload-raw?name=too-big.bin', Buffer.alloc(4096, 0x61),
    { 'Content-Type': 'application/octet-stream' });
  if (tooBig.status !== 413) fail(`an oversized upload returned ${tooBig.status}, expected 413`);
  if (!tooBig.d || !/larger than|limit/i.test(String(tooBig.d.error || ''))) fail('the 413 did not explain the limit: ' + tooBig.body.slice(0, 200));
  const uploads = path.join(WORKSPACE, 'uploads');
  const staging = fs.existsSync(uploads) ? fs.readdirSync(uploads).filter((n) => n.startsWith('.incoming-')) : [];
  if (staging.length) fail('the oversized upload left staging files: ' + staging.join(', '));
  const healthyAfterUpload = await request('GET', '/api/health');
  if (healthyAfterUpload.status !== 200) fail('the bridge died after the oversized upload');
  console.log('  #240 an oversized upload answers a JSON 413 and cleans up its temp file');

  // #244: an "image" that claims text/html is refused; a real one is served.
  const q = (part) => `/api/session-image?path=${encodeURIComponent(SESSION)}&line=2&part=${part}`;
  const bad = await request('GET', q(0));
  if (bad.status !== 415) fail(`a text/html image block answered ${bad.status}, expected 415`);
  const good = await request('GET', q(1));
  if (good.status !== 200) fail(`a real image block answered ${good.status}, expected 200`);
  if (good.headers['content-type'] !== 'image/png') fail('the served type is not image/png: ' + good.headers['content-type']);
  if (good.headers['x-content-type-options'] !== 'nosniff') fail('the image response has no nosniff header');
  console.log('  #244 a non-image MIME is refused and a real image is served with nosniff');

  cleanup();
  console.log('PASS bridge hardening: handler failure, upload limit and image MIME');
  process.exit(0);
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
