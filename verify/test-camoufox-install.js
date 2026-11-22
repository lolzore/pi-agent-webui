/*
 * The first-run web-search step installs Camoufox in the background. This checks
 * the parts that are easy to get wrong without downloading anything:
 *
 *   - a failed SearXNG (no Docker) must not hide the Camoufox result;
 *   - `uv tool install camoufox` followed by `uv tool run camoufox fetch` makes
 *     the tool available even when it lands in a bin directory the bridge did
 *     not start with on PATH (the uv shim case);
 *   - the status route reports the version afterwards, not a permanent
 *     "installed: false".
 *
 * The `uv` and `camoufox` executables are shell stubs; no package is installed.
 * Usage: node test-camoufox-install.js
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (process.platform === 'win32') {
  console.log('  SKIP the uv/camoufox stub test is POSIX-only');
  process.exit(0);
}
const ROOT = path.resolve(__dirname, '..');
const PORT = 24100 + (process.pid % 300);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-camoufox-'));
const bin = path.join(scratch, 'bin');
const agentDir = path.join(scratch, 'agent');
const sessionDir = path.join(scratch, 'sessions');
const installLog = path.join(scratch, 'installs.log');
for (const d of [bin, agentDir, sessionDir, path.join(scratch, 'ws')]) fs.mkdirSync(d, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const writeExec = (name, body) => {
  const file = path.join(bin, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
};

/* A uv that records its calls and drops a working `camoufox` shim into bin/ on
 * install. `tool dir --bin` points at that same directory, and `tool run` works
 * for version and fetch. */
writeExec('uv', `#!/bin/sh
printf '%s\\n' "$*" >> "${installLog}"
case "$*" in
  "--version") echo "uv 9.9.9"; exit 0 ;;
  "tool install camoufox") printf '#!/bin/sh\\necho "camoufox 9.9.9"\\n' > "${bin}/camoufox"; chmod +x "${bin}/camoufox"; exit 0 ;;
  "tool dir --bin") echo "${bin}"; exit 0 ;;
  "tool run camoufox fetch") exit 0 ;;
  "tool run camoufox --version") [ -x "${bin}/camoufox" ] || exit 1; "${bin}/camoufox" --version; exit 0 ;;
  "tool list") if [ -x "${bin}/camoufox" ]; then printf 'camoufox v9.9.9\\n- camoufox\\n'; exit 0; else exit 1; fi ;;
  *) exit 1 ;;
esac
`);

let bridge = null;
const cleanup = () => {
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
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
      // Keep this test on the Docker/SearXNG failure path so it can observe the
      // Camoufox install that follows; a native SearXNG install is tested apart.
      PI_GIT: path.join(scratch, 'no-such-git'),
      PI_UV: path.join(scratch, 'no-such-uv'),
      PI_CAMOUFOX_CMD: 'camoufox',
      PI_SEARXNG_CONFIG: path.join(scratch, 'searxng.json'),
      PI_SEARXNG_PORT: '1',
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
  if (before.camoufox.available) fail('Camoufox was reported installed before the install ran: ' + JSON.stringify(before.camoufox));

  /* Start search. SearXNG must fail (no Docker), but Camoufox must still be
   * installed - the old UI returned before even looking at it. */
  const started = await postJson('/api/websearch-setup', { action: 'start', camoufox: true });
  if (started.ok) fail('SearXNG reported success without Docker: ' + JSON.stringify(started));
  if (!started.camoufox || !(started.camoufox.installing || started.camoufox.running)) {
    fail('a failed SearXNG did not start or report the Camoufox install: ' + JSON.stringify(started.camoufox));
  }

  let fin = null;
  for (let i = 0; i < 120; i++) {
    const d = await getJson('/api/websearch-setup');
    const c = d.camoufox || {};
    if (c.running) { await sleep(100); continue; }
    fin = c;
    break;
  }
  if (!fin) fail('Camoufox install never finished');
  if (fin.ok !== true) fail('the Camoufox install did not report success: ' + JSON.stringify(fin));
  if (!fin.available) fail('Camoufox is installed but the status route still says unavailable: ' + JSON.stringify(fin));
  if (!/9\.9\.9/.test(String(fin.version || ''))) fail('the Camoufox version was not reported: ' + JSON.stringify(fin));
  const logText = fs.readFileSync(installLog, 'utf8');
  if (!/tool install camoufox/.test(logText) || !/tool run camoufox fetch/.test(logText)) {
    fail('the installer did not run uv install + fetch: ' + JSON.stringify(logText));
  }
  console.log('  no Docker, failed SearXNG, uv install + fetch, Camoufox available at ' + fin.version);
  console.log('  PASS Camoufox installs in the background and survives a failed SearXNG');
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
