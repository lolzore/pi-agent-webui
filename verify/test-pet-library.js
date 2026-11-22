/*
 * Petdex search/download on the bridge. The upstream is faked locally so the
 * check is deterministic and does not need the public network.
 *
 * Usage: node test-pet-library.js
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 4550 + (process.pid % 160);
const UP = 4750 + (process.pid % 160);
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-petlib-'));
const AGENT = path.join(T, 'agent');
fs.mkdirSync(AGENT, { recursive: true });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==', 'base64');
const SLUG = 'verify-pet';
const SPRITE = `http://127.0.0.1:${UP}/sprite.png`;
let bridge = null; let upstream = null;
const fail = (m) => { console.error('FAIL: ' + m); cleanup(); process.exit(1); };
function cleanup() {
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
  try { if (upstream) upstream.close(); } catch { /* gone */ }
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* gone */ }
}
process.on('exit', cleanup);

const request = (port, method, p, body) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path: p, timeout: 8000 }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', reject);
  if (body) req.end(body); else req.end();
});

(async () => {
  upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/sprite.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length });
      res.end(PNG);
      return;
    }
    if (u.pathname === '/api/pets/search') {
      const q = u.searchParams.get('q') || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pets: [{ slug: SLUG, displayName: 'Verify Pet', description: `matches ${q}`,
        spritesheetPath: SPRITE, spriteVersionNumber: 1 }] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => upstream.listen(UP, '127.0.0.1', r));

  bridge = spawn(process.execPath, ['bridge/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PI_COMMAND: `node ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_AGENT_DIR: AGENT, PI_CODING_AGENT_DIR: AGENT,
      PI_SESSION_DIR: path.join(T, 'sessions'), PI_CODING_AGENT_SESSION_DIR: path.join(T, 'sessions'),
      WORKSPACE_DIR: T, PI_WEBUI_SETTINGS: path.join(T, 'settings.json'),
      PI_WEBUI_LAST_SESSION: path.join(T, 'last.json'),
      PI_PETDEX_BASE: `http://127.0.0.1:${UP}`,
      PI_LLAMA_SCAN: 'off',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '';
  bridge.stderr.on('data', (c) => { err += c; });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { if ((await request(PORT, 'GET', '/api/health')).status === 200) { up = true; break; } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) fail('bridge never came up\n' + err.slice(-500));

  const search = await request(PORT, 'GET', '/api/petdex-search?q=whale');
  if (search.status !== 200) fail('search returned ' + search.status + ': ' + search.body.toString().slice(0, 300));
  const sd = JSON.parse(search.body);
  if (!sd.pets || sd.pets.length !== 1 || sd.pets[0].slug !== SLUG) fail('search result is wrong: ' + search.body);
  if (sd.pets[0].description !== 'matches whale') fail('search query was not forwarded: ' + JSON.stringify(sd.pets[0]));

  const dl = await request(PORT, 'POST', '/api/pets/download', JSON.stringify({
    slug: SLUG, displayName: 'Verify Pet', description: 'downloaded', spritesheetPath: SPRITE, spriteVersionNumber: 1,
  }));
  if (dl.status !== 200) fail('download returned ' + dl.status + ': ' + dl.body.toString().slice(0, 300));
  const dd = JSON.parse(dl.body);
  if (!dd.ok || !dd.pet || dd.pet.slug !== SLUG) fail('download answer is wrong: ' + dl.body);

  const lib = JSON.parse((await request(PORT, 'GET', '/api/pets')).body);
  if (!lib.pets || !lib.pets.some((p) => p.slug === SLUG)) fail('downloaded pet is not listed: ' + JSON.stringify(lib));
  const raw = await request(PORT, 'GET', `/api/pet-file?name=${SLUG}.png`);
  if (raw.status !== 200 || raw.body.compare(PNG) !== 0) fail('downloaded sprite is not served back byte-for-byte');

  const bad = await request(PORT, 'POST', '/api/pets/download', JSON.stringify({
    slug: 'bad-pet', displayName: 'Bad', spritesheetPath: 'https://example.com/sprite.png',
  }));
  if (bad.status !== 400) fail('a non-Petdex sprite URL was accepted: ' + bad.status);

  cleanup();
  console.log(`  search -> ${SLUG}; download -> ${raw.body.length} bytes; library lists it`);
  console.log('  PASS #267 Petdex search and download are proxied and persisted');
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
