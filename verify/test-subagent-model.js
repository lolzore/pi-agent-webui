/*
 * Issue #129: pi-subagents picks the model per subagent call/role (its
 * docs/models.md), so the WebUI has nothing to configure - but it should show
 * which model a run used. The bridge already reports `model` from the run's
 * status.json; this checks it reaches the row's hint and the rendered panel.
 *
 * Usage: node test-subagent-model.js <browserPath>
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
const PORT = 25300 + (process.pid % 200);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-submodel-'));
fs.mkdirSync(path.join(scratch, 'agent'), { recursive: true });
fs.mkdirSync(path.join(scratch, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'webui.json'), JSON.stringify({ onboarded: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bridge = null;
const cleanup = () => { try { if (bridge) bridge.kill(); } catch { /* gone */ } try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ } };
process.on('exit', cleanup);
const getJson = (p) => new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej); });
(async () => {
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: path.join(scratch, 'agent'), PI_CODING_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_SESSION_DIR: path.join(scratch, 'sessions'), WORKSPACE_DIR: scratch,
      PI_SESSION_DIR: path.join(scratch, 'sessions'), PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'),
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_LLAMA_SCAN: 'off', PORT: String(PORT),
    }), stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = ''; bridge.stderr.on('data', (c) => { err += c; });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const d = await getJson('/api/health'); if (d && d.ok) { up = true; break; } } catch { /* not yet */ } await sleep(200); }
  if (!up) fail('bridge never came up\n' + err.slice(-400));
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-submodel-browser-'));
  const launched = require('./ws-min.js').launchBrowser(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--user-data-dir=' + userDir, 'about:blank']);
  const child = launched.child;
  const cleanupBrowser = () => { try { child.kill(); } catch { /* gone */ } try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ } };
  process.on('exit', cleanupBrowser);
  let DBG = 0; try { DBG = await launched.port; } catch (e) { fail(e.message); }
  let page = null;
  for (let i = 0; i < 100; i++) {
    try { const list = await new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: DBG, path: '/json/list' }, (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej); }); if (Array.isArray(list)) { page = list.find((t) => t.type === 'page'); if (page) break; } } catch { /* not ready */ }
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
  for (let i = 0; i < 100; i++) { if (await evalJs("typeof subagentHint === 'function' && typeof refreshSubagents === 'function' ? 1 : 0")) break; await sleep(250); }
  const out = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const run = { id: 'r1', runId: 'r1', label: 'reviewer', state: 'done', startedAt: Date.now() - 5000, endedAt: Date.now(), toolCount: 2, model: 'anthropic/claude-x' };
    // The row's hint is what the panel and the menu render (subagentHint).
    const hint = subagentHint(run);
    const noModel = subagentHint({ id: 'r2', state: 'done', startedAt: Date.now() - 1000, endedAt: Date.now() });
    return { hint, noModel };
  })()))()`));
  if (!/anthropic\/claude-x/.test(out.hint)) fail('the row hint does not name the model: ' + JSON.stringify(out.hint));
  if (/undefined|null/.test(out.hint)) fail('the hint has an empty model: ' + JSON.stringify(out.hint));
  if (/anthropic/.test(out.noModel)) fail('a run without a model invented one: ' + JSON.stringify(out.noModel));
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));
  console.log('  hint:', JSON.stringify(out.hint));
  console.log('  PASS #129 a subagent run shows which model it used');
  cleanupBrowser(); cleanup(); process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
