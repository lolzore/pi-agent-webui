/*
 * Issue #157: the pi location (native or docker) is asked in the WebUI now.
 *
 * The choice used to be a terminal prompt in start-webui.sh; it is saved to the
 * same file the scripts read, so the scripts, the WebUI and the desktop app all
 * agree. This checks both halves: the bridge's /api/agent-source (what it
 * reports, what it refuses, what it writes) and the two places the UI asks
 * (the setup screen and Settings).
 *
 * Usage: node test-agent-source.js <browserPath>
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
const PORT = 27000 + (process.pid % 200);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-source-'));
fs.mkdirSync(path.join(scratch, 'agent'), { recursive: true });
fs.mkdirSync(path.join(scratch, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'webui.json'), JSON.stringify({ onboarded: true }));
const SOURCE_FILE = path.join(scratch, 'source.txt');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bridge = null;
const cleanup = () => { try { if (bridge) bridge.kill(); } catch { /* gone */ } try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ } };
process.on('exit', cleanup);
/* A hermetic environment: the ambient PI_* of whatever started this test must
 * not leak in (the bridge reads PI_COMMAND / PI_SESSION_DIR first). */
const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^PI_/.test(k) && k !== 'PI_WEBUI_SOURCE_FILE') delete env[k];
  return env;
};
const call = (method, body) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/agent-source', method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
    let b = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { b += c; });
    res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});
(async () => {
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign(cleanEnv(), {
      PI_AGENT_DIR: path.join(scratch, 'agent'), PI_CODING_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_SESSION_DIR: path.join(scratch, 'sessions'), WORKSPACE_DIR: scratch,
      PI_SESSION_DIR: path.join(scratch, 'sessions'), PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'), PI_WEBUI_SOURCE_FILE: SOURCE_FILE,
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_LLAMA_SCAN: 'off', PORT: String(PORT),
    }), stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = ''; bridge.stderr.on('data', (c) => { err += c; });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const h = await call('GET'); if (h.status === 200) { up = true; break; } } catch { /* not yet */ } await sleep(200); }
  if (!up) fail('bridge never came up\n' + err.slice(-400));

  // 1. nothing saved yet: it says so, and reports what it can see
  const first = (await call('GET')).body;
  if (first.configured) fail('a fresh bridge should have no pi location saved: ' + JSON.stringify(first));
  if (!first.detected || typeof first.detected.pi === 'undefined') fail('no detection in the reply: ' + JSON.stringify(first));
  if (!first.effective || !first.effective.command) fail('no effective command in the reply: ' + JSON.stringify(first));
  if (!first.envCommand) fail('the test set PI_COMMAND, so the reply should say the environment wins: ' + JSON.stringify(first.envCommand));

  // 2. docker without a container is refused
  const bad = await call('POST', { source: 'docker' });
  if (bad.status !== 400 || bad.body.ok) fail('a docker source with no container was accepted: ' + JSON.stringify(bad));
  if (fs.existsSync(SOURCE_FILE)) fail('the refused write still created ' + SOURCE_FILE);

  // 3. a real choice is written to the file the scripts read
  const saved = await call('POST', { source: 'docker', container: 'pi-box' });
  if (saved.status !== 200 || !saved.body.ok) fail('saving docker failed: ' + JSON.stringify(saved));
  if (!saved.body.restartRequired) fail('the reply does not say a restart is needed: ' + JSON.stringify(saved.body));
  const text = fs.readFileSync(SOURCE_FILE, 'utf8');
  if (!/^source=docker$/m.test(text) || !/^container=pi-box$/m.test(text)) fail('the source file is wrong: ' + JSON.stringify(text));
  const after = (await call('GET')).body;
  if (after.source !== 'docker' || after.container !== 'pi-box' || !after.configured) fail('the reply does not reflect the saved choice: ' + JSON.stringify(after));

  // 4. native is just as valid, and writes the same file
  await call('POST', { source: 'native' });
  if (!/^source=native$/m.test(fs.readFileSync(SOURCE_FILE, 'utf8'))) fail('saving native did not write the file');
  const junk = await call('POST', { source: 'somewhere' });
  if (junk.status !== 400) fail('a nonsense source was accepted: ' + JSON.stringify(junk));

  // 5. the UI asks in both places, and saving goes through the bridge
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-source-b-'));
  const launched = require('./ws-min.js').launchBrowser(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--window-size=1280,800', '--user-data-dir=' + userDir, 'about:blank']);
  const child = launched.child;
  const cleanupBrowser = () => { try { child.kill(); } catch { /* gone */ } try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ } };
  process.on('exit', cleanupBrowser);
  let DBG = 0; try { DBG = await launched.port; } catch (e) { fail(e.message); }
  let page = null;
  for (let i = 0; i < 100; i++) {
    try { const list = await new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: DBG, path: '/json/list' }, (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej); }); page = (list || []).find((t) => t.type === 'page'); if (page) break; } catch { /* not ready */ }
    await sleep(150);
  }
  if (!page) fail('browser never exposed a page');
  const WS = require('./ws-min.js');
  const ws = new WS(page.webSocketDebuggerUrl); await ws.open();
  let id = 0; const pending = new Map(); const problems = [];
  ws.onmessage = (raw) => { let m; try { m = JSON.parse(raw); } catch { return; } if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; } if (m.method === 'Runtime.exceptionThrown') { const e = m.params.exceptionDetails || {}; problems.push(((e.exception && (e.exception.description || e.exception.value)) || e.text || '?')); } };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw'); return r.result && r.result.result ? r.result.result.value : undefined; };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 160; i++) {
    if (await evalJs("typeof wireAgentSourceUi === 'function' && typeof S === 'object' && (S.historyRender || 0) > 0 ? 1 : 0")) break;
    await sleep(250);
  }
  const ui = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const res = {};
    res.hasBoth = !!document.getElementById('set-pi-source') && !!document.getElementById('setup-pi-source');
    // On the first-run screen the pi location must come before the package
    // step, not buried in the preferences below it.
    const piGrid = document.getElementById('setup-pi-grid');
    const packages = document.getElementById('setup-step-packages');
    res.setupPiFirst = !!(piGrid && packages && (piGrid.compareDocumentPosition(packages) & Node.DOCUMENT_POSITION_FOLLOWING));
    openSettings();
    await new Promise((r) => setTimeout(r, 400));
    const src = document.getElementById('set-pi-source');
    const box = document.getElementById('set-pi-container');
    res.options = [...src.options].map((o) => o.value);
    res.value = src.value;
    res.hint = document.getElementById('set-pi-hint').textContent;
    /* Switch to docker and let the page save it through the bridge. This
     * machine has no docker, so the picker has no containers - give it one, the
     * way a machine with docker would. */
    const opt = document.createElement('option');
    opt.value = 'pi-box'; opt.textContent = 'pi-box';
    box.appendChild(opt);
    box.value = 'pi-box';
    src.value = 'docker';
    src.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 700));
    res.boxVisible = !box.classList.contains('hidden');
    res.saved = await fetch('/api/agent-source').then((r) => r.json());
    return res;
  })()))()`));
  if (!ui.hasBoth) fail('the pi location is not asked in both places (settings + setup): ' + JSON.stringify(ui));
  if (!ui.setupPiFirst) fail('the pi location is not the first thing on the setup screen');
  if (ui.options.join(',') !== 'native,docker') fail('the source picker offers the wrong choices: ' + JSON.stringify(ui.options));
  if (!/nothing saved|saved:|PI_COMMAND/.test(ui.hint || '')) fail('the hint does not explain the state: ' + JSON.stringify(ui.hint));
  if (!ui.boxVisible) fail('choosing docker did not reveal the container picker');
  if (!ui.saved || ui.saved.source !== 'docker') fail('the UI did not save the choice through the bridge: ' + JSON.stringify(ui.saved));
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));
  console.log(`  api: refused ${JSON.stringify(bad.body.error)}; saved docker:pi-box; UI options ${ui.options.join('/')}, hint "${(ui.hint || '').slice(0, 60)}…"`);
  console.log('  PASS #157 the pi location is asked in the WebUI and saved for the scripts');
  cleanupBrowser(); cleanup(); process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
