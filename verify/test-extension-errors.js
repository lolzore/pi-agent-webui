/*
 * Issue #215: "Extension error: turn_end could not resolve the persisted
 * assistant entry ID" / "This extension ctx is stale after session replacement
 * or reload" - five identical toasts every turn, forever.
 *
 * What happened: pi invalidates every extension context when a session is
 * replaced or extensions are reloaded. An agent that keeps running its turns
 * against one of those dead contexts reports the same error once per extension
 * handler on every turn, and the page showed every one of them as a separate
 * toast, naming nobody. The session is otherwise fine, so nothing cleared it:
 * the runner is dead for the life of that child.
 *
 * This drives both halves with the mock agent:
 *   - PI_MOCK_EXT_ERRORS=stale emits exactly the real batch (a boundary error
 *     plus three handlers sharing one stale-context message). The page must show
 *     two toasts - one per distinct error, with the extension named - not five,
 *     and the bridge must replace the agent, which is the only repair. The next
 *     turn in that fresh agent must work and stay quiet.
 *   - PI_MOCK_EXT_ERRORS=plain emits a repeated ordinary extension error: one
 *     toast, and no restart. A failing extension is not a reason to bounce the
 *     agent.
 *
 * Usage: node test-extension-errors.js [ignoredBaseUrl] <browserPath>
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const browser = args.length > 1 ? args[1] : args[0];
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanups = [];
process.on('exit', () => { for (const fn of cleanups) { try { fn(); } catch { /* gone */ } } });

const getJson = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

async function runScenario(mode) {
  const PORT = (mode === 'stale' ? 3200 : 3260) + (process.pid % 37);
  const DBG_PORT = 9600 + (process.pid % 200) + (mode === 'stale' ? 0 : 5);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `verify-ext-${mode}-`));
  cleanups.push(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const agentDir = path.join(scratch, 'agent');
  const sessionDir = path.join(scratch, 'sessions');
  for (const d of [agentDir, sessionDir, path.join(scratch, 'ws')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(scratch, 'webui.json'), JSON.stringify({ onboarded: true }));
  const startLog = path.join(scratch, 'starts.log');

  const bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir, PI_SESSION_DIR: sessionDir,
      WORKSPACE_DIR: path.join(scratch, 'ws'),
      PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'),
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_MOCK_EXT_ERRORS: mode,
      PI_MOCK_START_LOG: startLog,
      PI_LLAMA_SCAN: 'off',
      PORT: String(PORT),
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  cleanups.push(() => { try { bridge.kill(); } catch { /* gone */ } });
  let bridgeErr = '';
  bridge.stderr.on('data', (c) => { bridgeErr += c; });

  let up = false;
  for (let i = 0; i < 120; i++) {
    try { const d = await getJson(PORT, '/api/health'); if (d.ok) { up = true; break; } } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail(`[${mode}] the scratch bridge never came up\n` + bridgeErr.slice(-600));

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-ext-browser-'));
  cleanups.push(() => fs.rmSync(userDir, { recursive: true, force: true }));
  const page = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--remote-debugging-port=' + DBG_PORT, '--user-data-dir=' + userDir,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  cleanups.push(() => { try { page.kill(); } catch { /* gone */ } });
  let pageErr = '';
  page.stderr.on('data', (c) => { pageErr += c; });
  let ver = null;
  for (let i = 0; i < 120; i++) { try { ver = await getJson(DBG_PORT, '/json/version'); break; } catch { await sleep(150); } }
  if (!ver) fail(`[${mode}] the browser never came up\n` + pageErr.slice(-400));

  const WS = require('./ws-min.js');
  const target = (await getJson(DBG_PORT, '/json/list')).find((t) => t.type === 'page');
  if (!target) fail(`[${mode}] no page target`);
  const ws = new WS(target.webSocketDebuggerUrl);
  await ws.open();
  cleanups.push(() => { try { ws.close(); } catch { /* gone */ } });

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
  const waitForBool = async (expr, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await evalJs(expr)) return true; await sleep(150); }
    return false;
  };
  const waitFor = async (expr, ms, what) => {
    if (!(await waitForBool(expr, ms))) fail(`[${mode}] ${what}`);
    return true;
  };
  const starts = () => { try { return fs.readFileSync(startLog, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  const say = async (text) => {
    await evalJs(`(() => {
      const i = document.getElementById('input');
      i.value = ${JSON.stringify(text)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btn-send').click();
      return true;
    })()`);
  };
  const extToasts = () => evalJs("JSON.stringify([...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent).filter((t) => /^Extension error/.test(t)))").then(JSON.parse);

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await waitFor("typeof S !== 'undefined' && typeof handleRpcMessage === 'function' && S.ws && S.ws.readyState === 1 ? 1 : 0", 20000, 'the page never connected to the bridge');
  await evalJs("document.querySelectorAll('dialog[open]').forEach((d) => { try { d.close(); } catch {} }); true");

  await say('hello ext-error stale ctx');
  await waitFor("document.querySelectorAll('#toasts .toast').length > 0 ? 1 : 0", 20000, 'the turn produced no toasts at all');
  await sleep(700); // the whole batch arrives within a few ms
  const shown = await extToasts();

  if (mode === 'stale') {
    if (shown.length !== 2) fail('expected two toasts (one per distinct error), got ' + shown.length + ': ' + JSON.stringify(shown));
    if (!shown.some((t) => /\(goal\.ts\)/.test(t))) fail('the toast does not name the extension that failed: ' + JSON.stringify(shown));
    if (!shown.some((t) => /\(pi\)/.test(t) && /persisted assistant entry ID/.test(t))) fail('the boundary error lost its source or text: ' + JSON.stringify(shown));
    console.log('  toasts: ' + JSON.stringify(shown));

    // The repair: the bridge must replace the agent, not leave the dead runner.
    let fixed = false;
    for (let i = 0; i < 150; i++) { if (starts() >= 2) { fixed = true; break; } await sleep(200); }
    if (!fixed) fail(`the bridge never restarted the agent (starts: ${starts()})\n` + bridgeErr.slice(-500));
    console.log(`  agent replaced (starts: ${starts()})`);

    // ... and the fresh agent is usable and quiet.
    await waitFor("typeof S !== 'undefined' && S.ws && S.ws.readyState === 1 && !S.isStreaming ? 1 : 0", 20000, 'the page never settled after the repair');
    // the new child still has to come up and the page re-init its session; a
    // prompt sent into that gap is dropped, so retry instead of racing it
    await sleep(2000);
    await evalJs("document.getElementById('toasts').innerHTML = ''; true");
    let replied = false;
    for (let attempt = 0; attempt < 3 && !replied; attempt++) {
      await say('after the repair');
      replied = await waitForBool("document.querySelectorAll('#chat .msg.assistant').length >= 2 ? 1 : 0", 15000);
    }
    if (!replied) fail('[stale] the repaired agent did not answer the next message');
    const after = await extToasts();
    if (after.length > 0) fail('the repaired agent reported extension errors again: ' + JSON.stringify(after));
    await sleep(1500);
    if (starts() !== 2) fail(`the bridge restarted a repaired agent again (starts: ${starts()})`);
    console.log('  PASS #215 a stale extension context is reported once, named, and cleared by replacing the agent');
  } else {
    if (shown.length !== 1) fail('expected the repeated error to collapse to one toast, got ' + shown.length + ': ' + JSON.stringify(shown));
    if (!/\(other\.ts\)/.test(shown[0])) fail('the toast does not name the extension that failed: ' + JSON.stringify(shown));
    await sleep(4000);
    if (starts() !== 1) fail(`an ordinary extension error restarted the agent (starts: ${starts()})`);
    console.log('  PASS #215 a repeated ordinary extension error stays one named toast and does not restart the agent');
  }

  if (problems.length) fail(`[${mode}] the page reported errors:\n` + problems.join('\n'));
  ws.close();
  try { page.kill(); } catch { /* gone */ }
  try { bridge.kill(); } catch { /* gone */ }
}

(async () => {
  await runScenario('stale');
  await runScenario('plain');
  process.exit(0);
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
