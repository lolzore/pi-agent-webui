/*
 * #241: a bridge spawn that fails must reject immediately with the real error,
 * not wait out the 30-second health deadline and blame /api/health.
 *
 * `ensureBridge` takes an injectable spawn (default: the real one), so this can
 * hand it a child that emits 'error' without starting anything. The port is
 * unused, so the initial health check fails fast and the spawn is attempted.
 *
 * Usage: node test-electron-bridge.js
 */
'use strict';
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = () => {};
  // After ensureBridge has attached its listeners.
  setImmediate(() => child.emit('error', new Error('spawn ENOENT')));
  return child;
}

(async () => {
  const mod = await import(path.join(__dirname, '..', 'pi-electron', 'bridge-manager.js'));
  if (typeof mod.ensureBridge !== 'function') fail('bridge-manager does not export ensureBridge');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-ebridge-'));
  const started = Date.now();
  let message = '';
  try {
    await mod.ensureBridge({
      host: '127.0.0.1',
      port: 59999,          // nothing is listening; healthy() rejects at once
      userData: tmp,
      workspace: tmp,
      spawnImpl: fakeChild,
    });
  } catch (e) {
    message = String((e && e.message) || e);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  const ms = Date.now() - started;
  if (!message) fail('ensureBridge resolved even though the child could not start');
  if (!/could not start the bridge/i.test(message)) fail('the error does not say the spawn failed: ' + message);
  if (!/spawn ENOENT/.test(message)) fail('the real spawn error is missing from the message: ' + message);
  if (ms > 5000) fail(`it took ${ms} ms to fail; the 30 s deadline was still in play`);
  console.log('  a spawn error rejects at once with the real error (' + ms + ' ms)');
  console.log('PASS #241 electron bridge spawn failure is reported, not timed out');
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
