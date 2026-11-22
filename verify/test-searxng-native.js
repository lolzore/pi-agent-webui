/*
 * SearXNG without Docker.
 *
 * The Docker path is the normal one, but a Linux host with uv/git and no Docker
 * can run the same SearXNG from a private Python venv. This test stubs the
 * installer (`git` and `uv`) and the resulting launcher so the bridge's install
 * path can run without downloading the real project. It checks that:
 *
 *   - a failed Docker lookup falls through to the native installer;
 *   - the install creates a venv and package, starts the launcher, and proves
 *     the endpoint with a real JSON query;
 *   - ~/.pi/searxng.json is written to the chosen local port;
 *   - the status route reports the native instance.
 *
 * Usage: node test-searxng-native.js
 */
'use strict';
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (process.platform === 'win32') {
  console.log('  SKIP the native SearXNG stub test is POSIX-only');
  process.exit(0);
}
const ROOT = path.resolve(__dirname, '..');
const PORT = 24400 + (process.pid % 300);
const SEARX_PORT = 18400 + (process.pid % 300);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-searx-native-'));
const bin = path.join(scratch, 'bin');
const agentDir = path.join(scratch, 'agent');
const sessionDir = path.join(scratch, 'sessions');
const nativeDir = path.join(scratch, 'native');
const config = path.join(scratch, 'searxng.json');
const fakeRunner = path.join(nativeDir, 'venv', 'bin', 'searxng-run');
for (const d of [bin, agentDir, sessionDir, path.join(scratch, 'ws')]) fs.mkdirSync(d, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const writeExec = (file, body) => { fs.writeFileSync(file, body, { mode: 0o755 }); return file; };

writeExec(path.join(bin, 'git'), `#!/bin/sh
# git clone --depth 1 URL DEST
if [ "$1" = "clone" ]; then
  mkdir -p "$5/searx"
  echo "// stubbed searx.webapp" > "$5/searx/webapp.py"
  echo "stub" > "$5/requirements.txt"
  exit 0
fi
exit 1
`);

const node = process.execPath;
/* The stand-in is a real file, not a `node -e` string nested inside a shell
 * script inside this test: that quoting had to survive three layers, and the
 * last one silently won. printf resolved the escapes once, the shell removed the
 * remaining backslashes, and node was handed `require(http)` - so the launcher
 * died on its first line and every Linux run reported "the local SearXNG did not
 * answer". A file has no quoting to get wrong. */
const fakeSearx = path.join(scratch, 'fake-searx.js');
fs.writeFileSync(fakeSearx, `const http = require('http');
const port = Number(process.env.PI_SEARXNG_PORT);
http.createServer((req, res) => {
  if (req.url.startsWith('/search?') && req.url.includes('format=json')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'fake' }] }));
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(port, '127.0.0.1');
`);
writeExec(path.join(bin, 'uv'), `#!/bin/sh
case "$*" in
  "--version") echo "uv 9.9.9"; exit 0 ;;
  "venv "*)
    d="$2"
    mkdir -p "$d/bin"
    printf '#!/bin/sh\\nexit 0\\n' > "$d/bin/python"
    chmod +x "$d/bin/python"
    exit 0 ;;
  "pip install "*)
    # The editable install is the last pip call; it produces the launcher.
    case "$*" in
      *--no-build-isolation*)
        printf '#!/bin/sh\\nexec "%s" "%s"\\n' '${node}' '${fakeSearx}' > '${fakeRunner}'
        chmod +x "${fakeRunner}"
        exit 0 ;;
    esac
    exit 0 ;;
  *) exit 1 ;;
esac
`);

let bridge = null;
const cleanup = () => {
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
  // The bridge kills its own native child on a normal exit; if this test is
  // killed first, the fake launcher is still identifiable by its path.
  try {
    const rows = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }).split('\n');
    for (const row of rows) {
      if (!row.includes(fakeRunner)) continue;
      const pid = Number(row.trim().split(/\s+/)[0]);
      if (pid) { try { process.kill(pid); } catch { /* gone */ } }
    }
  } catch { /* no ps */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);

const getJson = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
const postJson = (p, body) => new Promise((res, rej) => {
  const data = JSON.stringify(body || {});
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  });
  req.on('error', rej);
  req.end(data);
});

(async () => {
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PATH: bin + path.delimiter + process.env.PATH,
      PI_AGENT_DIR: agentDir,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      PI_SESSION_DIR: sessionDir,
      WORKSPACE_DIR: path.join(scratch, 'ws'),
      PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'),
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_LLAMA_SCAN: 'off',
      PI_DOCKER: path.join(scratch, 'no-such-docker'),
      PI_GIT: path.join(bin, 'git'),
      PI_UV: path.join(bin, 'uv'),
      PI_SEARXNG_NATIVE_DIR: nativeDir,
      PI_SEARXNG_CONFIG: config,
      PI_SEARXNG_PORT: String(SEARX_PORT),
      PI_CAMOUFOX_CMD: process.execPath,
      PORT: String(PORT),
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let berr = '';
  bridge.stderr.on('data', (c) => { berr += c; });
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { const d = await getJson('/api/health'); if (d && d.ok) { up = true; break; } } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('the scratch bridge never came up\n' + berr.slice(-500));

  const before = await getJson('/api/websearch-setup');
  if (before.native.installed) fail('the native install was reported before it ran: ' + JSON.stringify(before.native));

  const started = await postJson('/api/websearch-setup', { action: 'start', camoufox: false });
  console.log('  start without Docker:', JSON.stringify(started).slice(0, 260));
  if (!started.ok) fail('the native SearXNG fallback did not start: ' + JSON.stringify(started));
  if (!started.native) fail('the fallback did not identify itself as native: ' + JSON.stringify(started));
  if (started.url !== `http://127.0.0.1:${SEARX_PORT}`) fail('the native instance did not use the chosen port: ' + JSON.stringify(started));
  if (!started.test || started.test.results !== 1) fail('the native instance did not answer the JSON test query: ' + JSON.stringify(started.test));
  const cfg = JSON.parse(fs.readFileSync(config, 'utf8'));
  if (cfg.searxngUrl !== started.url) fail('the pi-searxng config does not point at the native URL: ' + JSON.stringify(cfg));
  const after = await getJson('/api/websearch-setup');
  if (!after.native.installed || !after.native.running) fail('the status route does not show the native instance running: ' + JSON.stringify(after.native));
  console.log('  native SearXNG installed, configured, started and tested at ' + started.url);
  console.log('  PASS native SearXNG works without Docker');
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
