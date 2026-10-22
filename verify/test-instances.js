/*
 * Issue #57: "Ability to open multiple servers ... 3-5 simultaneous agents so
 * having the ability to open more servers on a single pc would be nice."
 *
 * The switcher could already hold several bridges and proxy between them; what
 * was missing was a way to run a second agent on one PC and a reason for the
 * two not to blend into each other. This starts *two* real bridges (separate
 * agent dirs, session dirs and settings files, both on this machine), checks
 * that the first one discovers the second, then drives the page through the
 * real switch: session list from B while looking at B, back to A afterwards,
 * with nothing from the other instance left on screen.
 *
 * Usage: node test-instances.js <browserPath>
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
const PORT_A = 3085;
const PORT_B = 3086;
const URL_B = `http://127.0.0.1:${PORT_B}`;
const DBG_PORT = 9300 + (process.pid % 300);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-instances-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeFixture(name) {
  const home = path.join(scratch, name);
  const dirs = {
    agent: path.join(home, 'agent'),
    ws: path.join(home, 'ws'),
    sessions: path.join(home, 'sessions'),
    webui: path.join(home, 'webui.json'),
    last: path.join(home, 'last.json'),
  };
  fs.mkdirSync(dirs.agent, { recursive: true });
  fs.mkdirSync(dirs.ws, { recursive: true });
  fs.mkdirSync(dirs.sessions, { recursive: true });
  // One session per bridge, named so the two cannot be confused.
  const file = path.join(dirs.sessions, `${name}-session.jsonl`);
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session', version: 1, sessionFile: file }),
    JSON.stringify({ type: 'message', id: 'm1', role: 'user', content: [{ type: 'text', text: `hello from ${name}` }] }),
  ].join('\n') + '\n');
  fs.writeFileSync(dirs.agent + '/settings.json', '{}');
  return dirs;
}

const bridges = [];
function startBridge(port, dirs) {
  const child = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: dirs.agent,
      PI_CODING_AGENT_DIR: dirs.agent,
      PI_CODING_AGENT_SESSION_DIR: dirs.sessions,
      WORKSPACE_DIR: dirs.ws,
      PI_SESSION_DIR: dirs.sessions,
      PI_WEBUI_SETTINGS: dirs.webui,
      PI_WEBUI_LAST_SESSION: dirs.last,
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_LLAMA_SCAN: 'off',
      PORT: String(port),
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', () => { /* kept quiet unless health fails */ });
  bridges.push(child);
  return child;
}
const cleanup = () => {
  for (const b of bridges) { try { b.kill(); } catch { /* gone */ } }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);

const getJson = (port, p) => new Promise((res, rej) => {
  const req = http.get({ host: '127.0.0.1', port, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  });
  req.on('error', rej);
});
const waitHealth = async (port) => {
  for (let i = 0; i < 80; i++) {
    try { const d = await getJson(port, '/api/health'); if (d && d.ok) return true; } catch { /* not yet */ }
    await sleep(200);
  }
  return false;
};

(async () => {
  const dirsA = makeFixture('A');
  const dirsB = makeFixture('B');
  startBridge(PORT_A, dirsA);
  startBridge(PORT_B, dirsB);
  if (!await waitHealth(PORT_A)) fail('bridge A never came up');
  if (!await waitHealth(PORT_B)) fail('bridge B never came up');

  /* ── discovery, from the bridge ────────────────────────────────────────── */
  const found = await getJson(PORT_A, '/api/local-instances');
  const urls = (found.instances || []).map((i) => i.url);
  console.log('  A discovers:', JSON.stringify(urls));
  if (!urls.includes(URL_B)) fail('bridge A did not discover bridge B on this machine');
  if (urls.includes(`http://127.0.0.1:${PORT_A}`)) fail('bridge A listed itself');

  /* ── the page: find it, add it, look at it, come back ──────────────────── */
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
  for (let i = 0; i < 100; i++) { try { ver = await getJson(DBG_PORT, '/json/version'); break; } catch { await sleep(150); } }
  if (!ver) fail('browser never came up\n' + browserErr.slice(-400));

  const WS = require('./ws-min.js');
  const page = (await getJson(DBG_PORT, '/json/list')).find((t) => t.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.open();
  let id = 0; const pending = new Map(); const problems = [];
  ws.onmessage = (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      problems.push(((d.exception && (d.exception.description || d.exception.value)) || d.text || '?'));
    }
  };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw');
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const waitFor = async (expr, ms, what) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await evalJs(expr)) return true;
      await sleep(200);
    }
    fail(what);
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT_A}/` });
  await waitFor("typeof refreshLocalInstances === 'function' && typeof openInstanceMenu === 'function' ? 1 : 0", 20000, 'the page never finished loading');
  await waitFor("settingsLoaded === true", 10000, 'the page never loaded its settings');
  await evalJs("document.querySelectorAll('dialog[open]').forEach((d) => { try { d.close(); } catch {} })");
  await sleep(500);

  // Local list is empty first, so the found row is the only way to B.
  const start = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    SET.instances = [];
    await saveSettings();
    await refreshLocalInstances(true);
    return { found: localInstances.map((i) => i.url), instances: (SET.instances || []).map((i) => i.url) };
  })()))()`));
  if (!start.found.includes(URL_B)) fail('the page did not see the local bridge: ' + JSON.stringify(start.found));
  if (start.instances.length) fail('the instance list was not empty at the start: ' + JSON.stringify(start.instances));
  console.log('  the page found', JSON.stringify(start.found), 'with an empty instance list');

  // Click the "found:" row in the real menu.
  const clicked = JSON.parse(await evalJs(`(() => JSON.stringify((() => {
    openInstanceMenu($('btn-instance'));
    const row = [...document.querySelectorAll('.model-item')].find((r) => /found:/.test(r.textContent) && r.textContent.includes('${URL_B.replace(/^https?:\/\//, '')}'));
    if (!row) return { clicked: false, rows: [...document.querySelectorAll('.model-item')].map((r) => r.textContent).slice(0, 8) };
    row.click();
    return { clicked: true };
  })()))()`));
  if (!clicked.clicked) fail('the menu has no discovered row: ' + JSON.stringify(clicked.rows));
  console.log('  the discovered row was in the instance menu and was clicked');

  await waitFor(`S.remote === ${JSON.stringify(URL_B)}`, 20000, 'the page never switched to the second bridge');
  {
    const t0 = Date.now();
    let ok = false;
    while (Date.now() - t0 < 20000) {
      ok = await evalJs("Array.isArray(S.sessionsList) && S.sessionsList.some((s) => String(s.path).includes('B-session')) && !!document.querySelector('#session-list .session-item[data-path*=\"B-session\"]')");
      if (ok) break;
      await sleep(250);
    }
    if (!ok) {
      const dbg = await evalJs("JSON.stringify({ remote: S.remote, remoteName: S.remoteName, sessions: (S.sessionsList || []).map((s) => s.path), dom: ((document.querySelector('#session-list') || {}).innerHTML || '').slice(0, 500) })");
      fail('the second bridge\'s session never appeared in the sidebar: ' + dbg);
    }
  }
  console.log('  the remote sidebar now lists B\'s session');
  const atB = JSON.parse(await evalJs(`JSON.stringify({
    remote: S.remote,
    sessions: (S.sessionsList || []).map((s) => String(s.path).split(/[\\\\/]/).pop()),
    hasB: !!document.querySelector('#session-list .session-item[data-path*="B-session"]'),
    hasA: !!document.querySelector('#session-list .session-item[data-path*="A-session"]'),
    instances: (SET.instances || []).map((i) => i.url),
  })`));
  console.log('  while looking at B:', JSON.stringify({ remote: atB.remote, sessions: atB.sessions }));
  if (atB.sessions.some((s) => s.includes('A-session'))) fail('the local session leaked into the remote view: ' + JSON.stringify(atB.sessions));
  if (!atB.hasB) fail('the sidebar does not show the remote session row');
  if (atB.hasA) fail('a local session row is on screen while looking at another instance');
  if (!atB.instances.includes(URL_B)) fail('the discovered instance was not kept in the list');

  // Back to this machine.
  await evalJs('exitRemoteMode()');
  await waitFor("!S.remote && Array.isArray(S.sessionsList) && S.sessionsList.some((s) => String(s.path).includes('A-session')) && !!document.querySelector('#session-list .session-item[data-path*=\"A-session\"]')", 20000,
    'the local session list did not come back');
  const back = JSON.parse(await evalJs(`JSON.stringify({
    remote: S.remote,
    sessions: (S.sessionsList || []).map((s) => String(s.path).split(/[\\\\/]/).pop()),
    hasB: !!document.querySelector('#session-list .session-item[data-path*="B-session"]'),
    hasA: !!document.querySelector('#session-list .session-item[data-path*="A-session"]'),
  })`));
  console.log('  back on A:', JSON.stringify({ remote: back.remote, sessions: back.sessions }));
  if (back.sessions.some((s) => s.includes('B-session'))) fail('the remote session leaked into the local view: ' + JSON.stringify(back.sessions));
  if (!back.hasA) fail('the sidebar does not show the local session row again');
  if (back.hasB) fail('a remote session row is still on screen after coming back');

  await evalJs("SET.instances = []; saveSettings();").catch(() => {});
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));
  console.log('  PASS #57 a second local bridge is discovered, added, switched to and left cleanly');
  cleanupBrowser();
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
