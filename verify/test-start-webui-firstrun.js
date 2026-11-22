/*
 * First-run start-webui.sh must not exit after asking where pi lives.
 *
 * Reported on Linux: the very first launch prompted for the pi location, then
 * closed; reopening it worked because the answer had been saved. The function
 * that writes the answer ended with `[ -n "$CONTAINER" ] && echo ...`, and on
 * the native path that test is false - under `set -e` it terminated the script
 * before it could start the bridge.
 *
 * This runs the real launcher with a scratch source file, a fake `pi` (only
 * `command -v pi` is checked) and a fake `node` that prints a marker instead of
 * starting the server. It then sends "1" to the prompt and waits for the bridge
 * start line / marker. Before the fix the script exited at the prompt.
 *
 * Usage: node test-start-webui-firstrun.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.platform === 'win32') {
  console.log('  SKIP first-run launcher test is for the POSIX start-webui.sh');
  process.exit(0);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-start-firstrun-'));
const bin = path.join(scratch, 'bin');
const sourceFile = path.join(scratch, 'agent-source.txt');
fs.mkdirSync(bin, { recursive: true });
const writeExec = (name, body) => {
  const file = path.join(bin, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
};

// `command -v pi` is the only pi check before the bridge starts.
writeExec('pi', '#!/bin/sh\nexit 0\n');
// The real launcher runs `node server.js`; this keeps the test from opening a
// port, and the marker proves execution got past the first-run prompt.
writeExec('node', '#!/bin/sh\necho FAKE_BRIDGE_STARTED\nsleep 60\n');

let child = null;
let out = '';
const cleanup = () => {
  try { if (child) process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
  try { child && child.kill(); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);

(async () => {
  child = spawn('bash', [path.join(ROOT, 'start-webui.sh')], {
    cwd: ROOT,
    detached: true,
    env: Object.assign({}, process.env, {
      PATH: bin + path.delimiter + process.env.PATH,
      PI_WEBUI_SOURCE_FILE: sourceFile,
      PORT: '37991',
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  child.on('error', (e) => { out += `\nspawn error: ${e.message}`; });

  const waitFor = async (re, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (re.test(out)) return true;
      if (child.exitCode != null || child.signalCode) return false;
      await sleep(100);
    }
    return re.test(out);
  };

  if (!await waitFor(/Select \[1\/2\]:/, 5000)) {
    throw new Error('the launcher never asked for the pi location:\n' + out);
  }
  child.stdin.write('1\n');

  if (!await waitFor(/Starting the Pi Agent WebUI|FAKE_BRIDGE_STARTED/, 5000)) {
    const code = child.exitCode != null ? ` (exit ${child.exitCode})` : '';
    throw new Error('the launcher exited after the first-run prompt instead of starting' + code + ':\n' + out);
  }
  const saved = fs.readFileSync(sourceFile, 'utf8');
  if (!/^source=native\s*$/.test(saved)) throw new Error('the native choice was not saved: ' + JSON.stringify(saved));
  if (!/FAKE_BRIDGE_STARTED/.test(out)) throw new Error('the launcher printed the start banner but never ran the bridge:\n' + out);
  console.log('  first run: asked once, saved native, and started the bridge');
  console.log('  PASS start-webui.sh survives its own first-run prompt');
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); console.error('FAIL: ' + (e && e.message ? e.message : e)); process.exit(1); });
