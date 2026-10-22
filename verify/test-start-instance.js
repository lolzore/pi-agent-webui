/*
 * Issue #79: "Start another local agent from the UI."
 *
 * The launcher (`INSTANCE=N ./start-webui.sh`) and the switcher's discovery
 * already covered running and finding a second agent on one machine; starting
 * one was still a terminal job. The instance menu now starts one through the
 * same launcher, lists it when it comes up, and carries a stop control for the
 * bridges it started (and only those).
 *
 * This runs the real launcher: the bridge is told to use a `pi` stub on PATH
 * that runs the mock agent, so the second instance is a real bridge with a real
 * agent process, just not a real model. Instance homes land under the scratch
 * HOME and ports under PI_WEBUI_PORT_BASE, so nothing here touches the machine's
 * own instances.
 *
 * Usage: node test-start-instance.js <browserPath>
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const browser = process.argv[2];
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const ROOT = path.resolve(__dirname, '..');
const PORT = 21800 + (process.pid % 300);
const BASE = PORT + 1000;
const DBG_PORT = 9700 + (process.pid % 200);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-instances-'));
const agentDir = path.join(scratch, 'agent');
const homeDir = path.join(scratch, 'home');
const stubBin = path.join(scratch, 'bin');
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(homeDir, { recursive: true });
fs.mkdirSync(stubBin, { recursive: true });
fs.writeFileSync(path.join(agentDir, 'settings.json'), '{}');
// The launcher insists on a `pi` on PATH; this one is the mock agent, so the
// second instance is a real bridge without a real model behind it.
fs.writeFileSync(path.join(stubBin, 'pi'), `#!/bin/sh\nexec ${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')} "$@"\n`);
fs.chmodSync(path.join(stubBin, 'pi'), 0o755);
const startedFile = path.join(agentDir, 'webui-started-instances.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bridge = null;
const killStarted = () => {
  try {
    for (const r of JSON.parse(fs.readFileSync(startedFile, 'utf8'))) {
      try { process.kill(-r.pid, 'SIGTERM'); } catch { try { process.kill(r.pid, 'SIGTERM'); } catch { /* gone */ } }
    }
  } catch { /* nothing was started */ }
};
const cleanup = () => {
  killStarted();
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);

const getJson = (port, p) => new Promise((res, rej) => {
  const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000 }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  });
  req.on('timeout', () => { req.destroy(new Error('timeout')); });
  req.on('error', rej);
});
const postJson = (port, p, body) => new Promise((res, rej) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 10000 }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { let d = {}; try { d = JSON.parse(b); } catch { /* */ } res({ status: r.statusCode, body: d }); });
  });
  req.on('timeout', () => { req.destroy(new Error('timeout')); });
  req.on('error', rej);
  req.end(JSON.stringify(body || {}));
});
const up = async (port, tries) => {
  for (let i = 0; i < (tries || 90); i++) {
    try { const d = await getJson(port, '/api/health'); if (d && d.ok) return true; } catch { /* not yet */ }
    await sleep(500);
  }
  return false;
};
const down = async (port, tries) => {
  for (let i = 0; i < (tries || 40); i++) {
    try { await getJson(port, '/api/health'); } catch { return true; }
    await sleep(500);
  }
  return false;
};

(async () => {
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      HOME: homeDir,
      PI_AGENT_DIR: agentDir,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: path.join(scratch, 'sessions'),
      WORKSPACE_DIR: scratch,
      PI_SESSION_DIR: path.join(scratch, 'sessions'),
      PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_LLAMA_SCAN: 'off',
      PI_WEBUI_PORT_BASE: String(BASE),
      PATH: `${stubBin}:${process.env.PATH || ''}`,
      PORT: String(PORT),
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let bridgeErr = '';
  bridge.stderr.on('data', (c) => { bridgeErr += c; });
  if (!await up(PORT)) fail('the scratch bridge never came up\n' + bridgeErr.slice(-500));

  /* ── start one through the API, as the menu does ───────────────────── */
  const first = await postJson(PORT, '/api/start-instance', {});
  if (first.status !== 200 || !first.body.ok) fail('start-instance failed: HTTP ' + first.status + ' ' + JSON.stringify(first.body));
  if (Number(first.body.port) !== BASE + 2) fail(`the first instance should be ${BASE + 2} (instance 2), got ${first.body.port}`);
  if (!await up(first.body.port)) fail('the started bridge never answered on port ' + first.body.port + '\n' + (() => { try { return fs.readFileSync(first.body.log, 'utf8').slice(-600); } catch { return ''; } })());
  const health = await getJson(first.body.port, '/api/health');
  if (!health.ok) fail('the started bridge is not healthy: ' + JSON.stringify(health));
  const started = await getJson(PORT, '/api/local-started');
  if (!started.started.some((r) => Number(r.port) === Number(first.body.port) && r.running)) {
    fail('the started instance is not recorded as running: ' + JSON.stringify(started));
  }
  const found = await getJson(PORT, '/api/local-instances');
  if (!found.instances.some((r) => Number(r.port) === Number(first.body.port))) {
    fail('discovery does not list the started instance: ' + JSON.stringify(found.instances));
  }
  console.log(`  started instance ${first.body.instance} on port ${first.body.port}: healthy, discovered, recorded`);

  /* ── the menu: stop control on what we started, and start another ──── */
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-instances-browser-'));
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--remote-debugging-port=' + DBG_PORT, '--user-data-dir=' + userDir,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let browserErr = '';
  child.stderr.on('data', (c) => { browserErr += c; });
  const cleanupBrowser = () => {
    try { child.kill(); } catch { /* gone */ }
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ }
  };
  process.on('exit', cleanupBrowser);

  let ver = null;
  for (let i = 0; i < 100; i++) {
    try {
      ver = await new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port: DBG_PORT, path: '/json/version' }, (r) => {
          let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
          r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
        }).on('error', rej);
      });
      break;
    } catch { await sleep(150); }
  }
  if (!ver) fail('browser never came up\n' + browserErr.slice(-400));

  const WS = require('./ws-min.js');
  const pages = await new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: DBG_PORT, path: '/json/list' }, (r) => {
      let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
  const ws = new WS(pages.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await ws.open();
  let id = 0; const pending = new Map(); const problems = [];
  ws.onmessage = (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails || {};
      problems.push(((e.exception && (e.exception.description || e.exception.value)) || e.text || '?'));
    }
  };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw');
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 100; i++) {
    if (await evalJs("typeof openInstanceMenu === 'function' ? 1 : 0")) break;
    await sleep(250);
  }

  // Open the menu and look at the row for the instance we started.
  const menu = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    window.confirm = () => true;
    await refreshLocalInstances(true);
    await refreshStartedInstances(true);
    openInstanceMenu($('btn-instance'), true);
    await new Promise((r) => setTimeout(r, 400));
    const rows = [...document.querySelectorAll('.model-menu .model-item')].map((r) => ({
      text: r.textContent.trim().slice(0, 90),
      stopPort: (r.querySelector('[data-stop-port]') || {}).dataset ? r.querySelector('[data-stop-port]').dataset.stopPort : null,
      startInstance: (r.querySelector('[data-start-instance]') || {}).dataset ? r.querySelector('[data-start-instance]').dataset.startInstance : null,
    }));
    return { rows, hasStart: rows.some((r) => /start another agent/.test(r.text)) };
  })()))()`));
  if (!menu.hasStart) fail('the menu has no "start another agent" item: ' + JSON.stringify(menu.rows));
  const stopRow = menu.rows.find((r) => String(r.stopPort) === String(first.body.port));
  if (!stopRow) fail('the started instance has no stop control in the menu: ' + JSON.stringify(menu.rows));
  if (!/started here/.test(stopRow.text)) fail('the row does not say it was started here: ' + JSON.stringify(stopRow));
  console.log('  menu: "start another agent" present; the started instance carries a stop control');

  // Stop it through that control.
  await evalJs(`document.querySelector('[data-stop-port="${first.body.port}"]').click(); true`);
  if (!await down(first.body.port)) fail('the started bridge still answers after stop');
  const afterStop = await getJson(PORT, '/api/local-started');
  const stoppedRec = afterStop.started.find((r) => Number(r.port) === Number(first.body.port));
  if (!stoppedRec) fail('the stopped instance is no longer recorded, so it cannot be restarted: ' + JSON.stringify(afterStop));
  if (stoppedRec.running !== false) fail('the stopped instance still reports running: ' + JSON.stringify(stoppedRec));
  console.log('  the stop control stopped it; the record stays (running: false) so it can be started again');

  // The stopped instance is offered again, with a start control (issue #119).
  const stoppedMenu = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    await refreshStartedInstances(true);
    openInstanceMenu($('btn-instance'), true);
    await new Promise((r) => setTimeout(r, 400));
    return [...document.querySelectorAll('.model-menu .model-item')].map((r) => ({
      text: r.textContent.trim().slice(0, 90),
      startInstance: (r.querySelector('[data-start-instance]') || {}).dataset ? r.querySelector('[data-start-instance]').dataset.startInstance : null,
    }));
  })()))()`));
  const restartRow = stoppedMenu.find((r) => String(r.startInstance) === String(first.body.instance));
  if (!restartRow) fail('the stopped instance has no start control: ' + JSON.stringify(stoppedMenu));
  if (!/stopped:/.test(restartRow.text) && !/\(stopped here\)/.test(restartRow.text)) {
    fail('the row does not say it is stopped: ' + JSON.stringify(restartRow));
  }
  if (stoppedMenu.some((r) => String(r.stopPort) === String(first.body.port))) {
    fail('a stopped instance still offers a stop control (issue #138): ' + JSON.stringify(stoppedMenu));
  }
  await evalJs(`document.querySelector('[data-start-instance="${first.body.instance}"]').click(); true`);
  if (!await up(first.body.port)) fail('the start control did not bring the instance back on port ' + first.body.port);
  const restarted = await getJson(PORT, '/api/local-started');
  const backRec = restarted.started.find((r) => Number(r.port) === Number(first.body.port));
  if (!backRec || backRec.running !== true) fail('the restarted instance is not recorded as running: ' + JSON.stringify(restarted));
  console.log('  the start control brought instance ' + first.body.instance + ' back on port ' + first.body.port);

  // Stop it again, then the menu's own start item must reuse the free number
  // instead of moving on to 3 (issue #119).
  await postJson(PORT, '/api/stop-instance', { port: first.body.port });
  if (!await down(first.body.port)) fail('the instance did not stop');
  await evalJs(`(() => {
    const row = [...document.querySelectorAll('.model-menu .model-item')].find((r) => /start another agent/.test(r.textContent));
    if (row) row.click();
    return true;
  })()`);
  let second = null;
  for (let i = 0; i < 90; i++) {
    await sleep(500);
    const d = await getJson(PORT, '/api/local-started').catch(() => ({ started: [] }));
    second = d.started.find((r) => Number(r.port) === BASE + 2 && r.running !== false);
    if (second) break;
  }
  if (!second) fail('the menu item did not reuse instance 2 on port ' + (BASE + 2));
  if (!await up(second.port)) fail('instance 3 never answered on port ' + second.port);
  console.log(`  the menu item started instance ${second.instance} on port ${second.port}`);

  /* ── what this bridge did not start, it will not stop ─────────────── */
  const foreign = await postJson(PORT, '/api/stop-instance', { port: PORT });
  if (foreign.status !== 400) fail('stop-instance accepted a port this bridge did not start (HTTP ' + foreign.status + ')');
  const still = await getJson(PORT, '/api/health');
  if (!still.ok) fail('the bridge stopped itself through stop-instance');

  // Clean up instance 3 through the API, as the menu would.
  const stop3 = await postJson(PORT, '/api/stop-instance', { port: second.port });
  if (stop3.status !== 200) fail('stopping instance 3 failed: ' + JSON.stringify(stop3.body));
  if (!await down(second.port)) fail('instance 3 still answers after stop');
  /* ── hardening (issue #119): concurrent starts, a reused pid, forgetting ── */

  // Two starts at once must not race each other onto the same instance/port.
  const [c1, c2] = await Promise.all([
    postJson(PORT, '/api/start-instance', {}),
    postJson(PORT, '/api/start-instance', {}),
  ]);
  if (c1.status !== 200 || c2.status !== 200) fail('a concurrent start failed: ' + JSON.stringify([c1.body, c2.body]));
  if (c1.body.instance === c2.body.instance || c1.body.port === c2.body.port) {
    fail('two starts at once took the same instance/port: ' + JSON.stringify([c1.body, c2.body]));
  }
  if (!await up(c1.body.port) || !await up(c2.body.port)) fail('a concurrently started instance never answered');
  for (const p of [c1.body.port, c2.body.port]) {
    const r = await postJson(PORT, '/api/stop-instance', { port: p });
    if (r.status !== 200 || r.body.killed !== true) fail('stopping a concurrent instance failed: ' + JSON.stringify(r.body));
  }
  console.log(`  two starts at once: instance ${c1.body.instance} on ${c1.body.port} and ${c2.body.instance} on ${c2.body.port}`);

  // A record whose pid was reused by an unrelated (live) process must not be
  // killed - the bridge only kills when the port actually answers.
  const startedFile = path.join(agentDir, 'webui-started-instances.json');
  const records = JSON.parse(fs.readFileSync(startedFile, 'utf8'));
  const forgedPort = BASE + 40;
  records.push({ instance: 40, port: forgedPort, pid: process.pid, startedAt: new Date().toISOString(), log: null, url: `http://127.0.0.1:${forgedPort}` });
  fs.writeFileSync(startedFile, JSON.stringify(records));
  const listed = await getJson(PORT, '/api/local-started');
  const forged = listed.started.find((r) => Number(r.port) === forgedPort);
  if (!forged || forged.running !== true) fail('a live pid did not read as running: ' + JSON.stringify(forged));
  const forgedStop = await postJson(PORT, '/api/stop-instance', { port: forgedPort });
  if (forgedStop.status !== 200 || forgedStop.body.killed !== false) fail('stop killed a reused pid: ' + JSON.stringify(forgedStop.body));
  try { process.kill(process.pid, 0); } catch { fail('the test process was killed by stop()'); }
  const afterForged = await getJson(PORT, '/api/local-started');
  const nowStopped = afterForged.started.find((r) => Number(r.port) === forgedPort);
  if (!nowStopped || nowStopped.running !== false) fail('the forged record was not marked stopped: ' + JSON.stringify(nowStopped));
  console.log('  a record with a reused pid is marked stopped, not killed');

  // Forgetting a stopped record removes it (and only it).
  const forgotten = await postJson(PORT, '/api/forget-instance', { instance: 40 });
  if (forgotten.status !== 200) fail('forget failed: ' + JSON.stringify(forgotten.body));
  const afterForget = await getJson(PORT, '/api/local-started');
  if (afterForget.started.some((r) => Number(r.instance) === 40)) fail('the forgotten record is still listed');
  const forgetAgain = await postJson(PORT, '/api/forget-instance', { instance: 40 });
  if (forgetAgain.status !== 404) fail('forgetting a missing record answered ' + forgetAgain.status);
  console.log('  forget removes the record (and only that one)');

  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));

  console.log('  PASS #79 the UI starts a second local agent, finds it, and stops only what it started');
  cleanupBrowser();
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
