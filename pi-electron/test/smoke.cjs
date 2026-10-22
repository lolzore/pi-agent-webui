/*
 * The desktop app's smoke test.
 *
 * It launches the real app (hidden window), with the shorts feed pointed at the
 * bridge's own page so the check needs no internet, and asserts the machinery:
 * the WebUI loads, the feed view is a separate top-level context with the right
 * user agent and its preload in the page's world, the toolbar's IPC answers,
 * and the split layout is where it should be.
 *
 * Usage: node test/smoke.js [path-to-electron]
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '..');
const PORT = String(26100 + (process.pid % 300));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function electronBin() {
  if (process.argv[2]) return process.argv[2];
  const pkg = path.join(APP, 'node_modules', 'electron');
  if (!fs.existsSync(pkg)) return null;
  try { return require(pkg); } catch { return null; }
}

(async () => {
  /* Electron needs a display; a headless CI runner has none, and that is a
   * skip, not a defect (the same rule the browser checks follow). */
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.error('  (no DISPLAY: an X server is needed to run the desktop app - skipping)');
    process.exit(77);
  }
  const bin = electronBin();
  if (!bin || !fs.existsSync(bin)) {
    console.error('  (electron is not installed in pi-electron/node_modules - skipping)');
    process.exit(77);
  }
  const userData = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pi-desktop-test-'));
  /* A known agent picture, so the app icon path is exercised: the page paints
   * it into the favicon, main reads that PNG back and calls win.setIcon. The
   * picture must be opaque - a transparent frame is deliberately rejected. */
  const avatar = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
    '<rect width="64" height="64" fill="#5b9dff"/><circle cx="32" cy="32" r="18" fill="#ffffff"/></svg>');
  fs.writeFileSync(path.join(userData, 'webui-settings.json'), JSON.stringify({
    onboarded: true, agentName: 'Smoke Agent', avatar,
  }));
  const childEnv = {
    ...process.env,
    PORT,
    PI_WEBUI_PORT: PORT,
    PI_WEBUI_SETTINGS: path.join(userData, 'webui-settings.json'),
    PI_ELECTRON_TEST_URL: `http://127.0.0.1:${PORT}/`,
    PI_ELECTRON_USER_DATA: userData,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  };
  // A shell that already has this set (the bridge sets it for its own child)
  // would run Electron as plain node and every import in main.js would fail
  // with "does not provide an export named 'app'". The app under test is
  // Electron, not node.
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(bin, ['.', '--test', '--no-sandbox', '--disable-gpu'], {
    cwd: APP,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const done = await new Promise((res) => {
    const t = setTimeout(() => res('timeout'), 90000);
    child.on('exit', (code) => { clearTimeout(t); res(code); });
  });
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* gone */ }
  const line = out.split('\n').find((l) => l.startsWith('PI-ELECTRON-TEST '));
  if (!line) {
    console.error('FAIL: the app printed no verdict (exit ' + done + ')');
    console.error((err || out).slice(-1200));
    process.exit(1);
  }
  const r = JSON.parse(line.slice('PI-ELECTRON-TEST '.length));
  if (r.webuiUrl && !r.webuiUrl.includes(':' + PORT + '/')) {
    console.error('FAIL: the app did not use its own bridge on ' + PORT + ' (got ' + r.webuiUrl + ') - it must start one when none is listening');
    process.exit(1);
  }
  if (!r.ok) {
    console.error('FAIL: ' + JSON.stringify(r, null, 2));
    process.exit(1);
  }
  console.log(`  webui ${r.webuiUrl} (chat: ${r.webuiChat}); feed ${r.feedUrl} ua=${String(r.feedUA).slice(0, 40)}… preload=${r.feedPreloadRan}; toolbar api=${r.toolbarApi}; pane ${r.bounds.toolbar.width}x${r.bounds.toolbar.height} at x=${r.bounds.toolbar.x}`);
  console.log('  PASS the desktop app loads the WebUI and a top-level shorts feed beside it');
  process.exit(0);
})().catch((e) => { console.error('FAIL: ' + ((e && e.stack) || e)); process.exit(1); });
