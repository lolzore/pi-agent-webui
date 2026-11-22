/*
 * Issue #206: "Title does not update when switching sessions or when in a new
 * session."
 *
 * The browser tab title was set once from the agent name and never touched
 * again, so the tab kept saying "Pi agent" after a session switch and after
 * "+ New" while the topbar showed the session actually open.
 *
 * This starts its own bridge with two real fixture sessions, so it exercises
 * the real click handlers (a session row and + New), not a direct
 * updateDocumentTitle() call. No other test can leave the agent busy or change
 * the topbar under it.
 *
 * Usage: node test-session-title.js [ignoredBaseUrl] <browserPath>
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
const PORT = 3100 + (process.pid % 150);
const DBG_PORT = 9600 + (process.pid % 200);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-title-'));
const agentDir = path.join(scratch, 'agent');
const sessionDir = path.join(scratch, 'sessions');
for (const d of [agentDir, sessionDir, path.join(scratch, 'ws')]) fs.mkdirSync(d, { recursive: true });
const writeSession = (name, text) => fs.writeFileSync(path.join(sessionDir, name), [
  JSON.stringify({ type: 'session', version: 1, sessionFile: path.join(sessionDir, name) }),
  JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text }] } }),
].join('\n') + '\n');
writeSession('alpha.jsonl', 'Alpha session');
writeSession('beta.jsonl', 'Beta session');
fs.writeFileSync(path.join(scratch, 'webui.json'), JSON.stringify({ onboarded: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bridge = null;
let child = null;
const cleanup = () => {
  try { if (child) child.kill(); } catch { /* gone */ }
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);
const getJson = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

(async () => {
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir, WORKSPACE_DIR: path.join(scratch, 'ws'),
      PI_SESSION_DIR: sessionDir, PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'),
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_LLAMA_SCAN: 'off', PORT: String(PORT),
    }), stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = ''; bridge.stderr.on('data', (c) => { err += c; });
  let up = false;
  for (let i = 0; i < 100; i++) {
    try { const d = await getJson(PORT, '/api/health'); if (d.ok) { up = true; break; } } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('the scratch bridge never came up\n' + err.slice(-500));

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-title-browser-'));
  child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--remote-debugging-port=' + DBG_PORT, '--user-data-dir=' + userDir,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let berr = ''; child.stderr.on('data', (c) => { berr += c; });
  let ver = null;
  for (let i = 0; i < 100; i++) { try { ver = await getJson(DBG_PORT, '/json/version'); break; } catch { await sleep(150); } }
  if (!ver) fail('browser never came up\n' + berr.slice(-400));

  const WS = require('./ws-min.js');
  const page = (await getJson(DBG_PORT, '/json/list')).find((t) => t.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl); await ws.open();
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
  const state = () => evalJs("JSON.stringify({ title: document.title, name: (document.getElementById('session-name') || {}).value || '' })").then((v) => JSON.parse(v));
  const waitFor = async (expr, ms, what) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await evalJs(expr)) return true; await sleep(150); }
    fail(what + ' (state: ' + JSON.stringify(await state()) + ')');
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await waitFor("typeof updateDocumentTitle === 'function' && typeof refreshSessions === 'function' ? 1 : 0", 20000, 'the page never loaded');
  await evalJs("document.querySelectorAll('dialog[open]').forEach((d) => { try { d.close(); } catch {} }); true");
  await waitFor("document.getElementById('session-name').value ? 1 : 0", 10000, 'the session name never filled in');
  await sleep(400);

  const first = await state();
  if (!first.title.includes(first.name)) fail('the initial tab title does not include the open session: ' + JSON.stringify(first));
  console.log(`  initial: ${JSON.stringify(first.title)}`);

  // A real row click. The row's derived name is "Beta session"; the topbar and
  // the title must both follow it.
  const clicked = await evalJs(`(() => {
    const rows = [...document.querySelectorAll('#session-list .session-item')];
    const r = rows.find((x) => /Beta session/.test(x.textContent || ''));
    if (!r) return false;
    r.click();
    return true;
  })()`);
  if (!clicked) fail('no "Beta session" row in the fixture list');
  await waitFor(`document.getElementById('session-name').value && document.getElementById('session-name').value !== ${JSON.stringify(first.name)} ? 1 : 0`, 15000, 'the real session switch never moved the topbar');
  const switched = await state();
  if (!switched.title.includes(switched.name)) fail('the tab title did not follow the real session switch: ' + JSON.stringify(switched));
  console.log(`  switched: ${JSON.stringify(switched.title)}`);

  // A real + New click. The mock agent is idle, so this is not queued.
  await evalJs("document.getElementById('btn-new-session').click(); true");
  await waitFor("document.getElementById('session-name').value === 'New session' ? 1 : 0", 15000, 'the real + New never made a new session');
  const fresh = await state();
  if (!/new session/i.test(fresh.title)) fail('the tab title did not follow the real + New: ' + JSON.stringify(fresh));
  console.log(`  new session: ${JSON.stringify(fresh.title)}`);

  // Rename through the real input/change handler.
  const NAME = 'verify title probe';
  await evalJs(`(() => {
    const i = document.getElementById('session-name');
    i.value = ${JSON.stringify(NAME)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitFor(`document.title.includes(${JSON.stringify(NAME)}) ? 1 : 0`, 10000, 'the tab title did not follow the rename');

  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));
  console.log('  PASS #206 the tab title follows a real session switch, a real + New, and a rename');
  ws.close(); cleanup(); process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
