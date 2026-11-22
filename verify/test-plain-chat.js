/*
 * Right-click New session -> "new plain chat".
 *
 * Plain chat must be a fresh pi process with no tools, extensions, skills or
 * AGENTS.md context: flags are asserted on the real spawned command through a
 * wrapper, and it must not resume the normal session. The page must show the
 * plain-chat banner and the way out, and leave plain mode through the same
 * endpoint.
 *
 * Usage: node test-plain-chat.js <browserPath>
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
const PORT = 24900 + (process.pid % 300);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-plain-'));
const agentDir = path.join(scratch, 'agent');
const sessionDir = path.join(scratch, 'sessions');
const ws = path.join(scratch, 'ws');
const log = path.join(scratch, 'starts.log');
for (const d of [agentDir, sessionDir, ws]) fs.mkdirSync(d, { recursive: true });
const normalSession = path.join(sessionDir, '2026-01-01T00-00-00-000Z_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl');
fs.writeFileSync(normalSession, JSON.stringify({ type: 'session', version: 3, id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', cwd: ws }) + '\n');
const plainSession = path.join(sessionDir, '2026-01-02T00-00-00-000Z_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl');
fs.writeFileSync(plainSession, JSON.stringify({ type: 'session', version: 3, id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', cwd: ws }) + '\n');
const lastFile = path.join(scratch, 'last.json');
fs.writeFileSync(lastFile, JSON.stringify({ path: normalSession, at: Date.now() }) + '\n');
const wrapper = path.join(scratch, 'pi-wrapper.sh');
fs.writeFileSync(wrapper, `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
exec "${process.execPath}" "${path.join(ROOT, 'bridge', 'mock_agent.js')}" "$@"
`, { mode: 0o755 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bridge = null;
const cleanup = () => {
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
const postJson = (port, p, body) => new Promise((res, rej) => {
  const data = JSON.stringify(body || {});
  const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res({ status: r.statusCode, body: JSON.parse(b) }); } catch (e) { rej(e); } });
  });
  req.on('error', rej);
  req.end(data);
});

(async () => {
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir, PI_SESSION_DIR: sessionDir,
      WORKSPACE_DIR: ws,
      PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: lastFile,
      PI_COMMAND: `bash ${wrapper}`,
      PI_MOCK_SESSION_FILE: normalSession,
      PI_MOCK_PLAIN_SESSION_FILE: plainSession,
      PI_LLAMA_SCAN: 'off', PI_DOCKER: path.join(scratch, 'no-such-docker'),
      PORT: String(PORT),
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let berr = '';
  bridge.stderr.on('data', (c) => { berr += c; });
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { const d = await getJson(PORT, '/api/health'); if (d && d.ok) { up = true; break; } } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('the scratch bridge never came up\n' + berr.slice(-500));

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-plain-browser-'));
  const launched = require('./ws-min.js').launchBrowser(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--user-data-dir=' + userDir, 'about:blank',
  ]);
  const child = launched.child;
  const cleanupBrowser = () => {
    try { child.kill(); } catch { /* gone */ }
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ }
  };
  process.on('exit', cleanupBrowser);
  let dbg = 0;
  try { dbg = await launched.port; } catch (e) { fail(e.message); }
  let page = null;
  for (let i = 0; i < 100; i++) {
    try { const list = await getJson(dbg, '/json/list'); if (Array.isArray(list)) { page = list.find((t) => t.type === 'page'); if (page) break; } } catch { /* not ready */ }
    await sleep(150);
  }
  if (!page) fail('browser never exposed a page');
  const WS = require('./ws-min.js');
  const wsc = new WS(page.webSocketDebuggerUrl);
  await wsc.open();
  let id = 0; const pending = new Map();
  wsc.onmessage = (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); wsc.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw');
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 120; i++) {
    if (await evalJs("typeof S !== 'undefined' && S.ws && S.ws.readyState === 1 && document.getElementById('btn-new-session') ? 1 : 0")) break;
    await sleep(200);
  }

  const picked = await evalJs(`(() => {
    const b = document.getElementById('btn-new-session');
    const r = b.getBoundingClientRect();
    b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 8, clientY: r.top + 8 }));
    return true;
  })()`);
  if (!picked) fail('could not open the New session context menu');
  await sleep(250);
  const menu = await evalJs(`(() => {
    const m = MENUS[MENUS.length - 1];
    const item = m && [...m.querySelectorAll('.model-item')].find((x) => /new plain chat/.test(x.textContent || ''));
    if (!item) return null;
    item.click();
    return item.textContent;
  })()`);
  if (!menu) fail('the New session context menu has no "new plain chat" item');

  let plain = null;
  for (let i = 0; i < 100; i++) {
    const h = await getJson(PORT, '/api/health');
    if (h.mode === 'plain') { plain = h; break; }
    await sleep(150);
  }
  if (!plain) fail('the bridge did not enter plain mode');
  let banner = false;
  for (let i = 0; i < 100; i++) {
    banner = await evalJs("!document.getElementById('plain-banner').classList.contains('hidden')");
    if (banner) break;
    await sleep(150);
  }
  if (!banner) fail('the page did not show the plain-chat banner');
  let starts = [];
  for (let i = 0; i < 100; i++) {
    starts = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
    if (starts.some((line) => line.includes('--no-tools'))) break;
    await sleep(100);
  }
  const plainStart = starts.find((line) => line.includes('--no-tools'));
  console.log('  plain start:', plainStart && plainStart.slice(0, 180));
  if (!plainStart) fail('no plain agent start was recorded: ' + JSON.stringify(starts));
  for (const flag of ['--no-tools', '--no-extensions', '--no-skills', '--no-context-files', '--no-mcp']) {
    if (!plainStart.includes(flag)) fail('the plain start is missing ' + flag + ': ' + plainStart);
  }
  if (plainStart.includes('--session')) fail('plain chat resumed a normal session: ' + plainStart);

  // The plain chat has its own outlined row in the session viewer, and it is
  // not just the normal chat wearing a banner.
  let plainRow = null;
  for (let i = 0; i < 100; i++) {
    plainRow = await evalJs("(() => { const r = document.querySelector('#session-list .session-item.plain'); return r ? { path: r.dataset.path, cls: r.className, text: r.textContent } : null; })()");
    if (plainRow && plainRow.path === plainSession) break;
    await sleep(150);
  }
  if (!plainRow) fail('the plain chat has no outlined row in the session viewer');
  if (!/\bplain\b/.test(plainRow.cls)) fail('the plain-chat row has no plain outline class: ' + JSON.stringify(plainRow));
  console.log('  plain row:', JSON.stringify(plainRow));

  // Switching to a normal session while idle restarts pi in normal mode in that
  // exact session (not a fresh one).
  await evalJs(`(async () => { await switchToSession(${JSON.stringify(normalSession)}); return true; })()`);
  let normalSwitched = false;
  for (let i = 0; i < 120; i++) {
    const h = await getJson(PORT, '/api/health');
    if (h.mode === 'normal') { normalSwitched = true; break; }
    await sleep(150);
  }
  if (!normalSwitched) fail('switching to a normal session did not restart pi in normal mode');
  let normalLine = '';
  for (let i = 0; i < 100; i++) {
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
    normalLine = lines.find((line) => line.includes('--session') && line.includes(normalSession)) || '';
    if (normalLine) break;
    await sleep(100);
  }
  if (!normalLine) fail('the normal switch did not start pi in the selected session: ' + JSON.stringify(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).slice(-3)));

  // Clicking the outlined plain row restarts pi in plain mode and in that
  // session, so a plain chat can be resumed just like any other chat.
  await evalJs(`(async () => { await switchToSession(${JSON.stringify(plainSession)}); return true; })()`);
  let plainSwitched = false;
  for (let i = 0; i < 120; i++) {
    const h = await getJson(PORT, '/api/health');
    if (h.mode === 'plain') { plainSwitched = true; break; }
    await sleep(150);
  }
  if (!plainSwitched) fail('clicking the plain row did not restart pi in plain mode');
  let plainLine = '';
  for (let i = 0; i < 100; i++) {
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
    plainLine = lines.find((line) => line.includes('--no-tools') && line.includes('--session') && line.includes(plainSession)) || '';
    if (plainLine) break;
    await sleep(100);
  }
  if (!plainLine) fail('the plain row did not resume that plain chat: ' + JSON.stringify(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).slice(-4)));
  console.log('  plain resume:', plainLine.slice(0, 220));

  await evalJs("document.getElementById('plain-exit').click(); true");
  let normal = null;
  for (let i = 0; i < 100; i++) {
    const h = await getJson(PORT, '/api/health');
    if (h.mode === 'normal') { normal = h; break; }
    await sleep(150);
  }
  if (!normal) fail('leaving plain chat did not restore normal mode');
  let hidden = false;
  for (let i = 0; i < 100; i++) {
    hidden = await evalJs("document.getElementById('plain-banner').classList.contains('hidden')");
    if (hidden) break;
    await sleep(150);
  }
  if (!hidden) fail('the plain-chat banner stayed after leaving');
  console.log('  PASS plain chat starts without tools/extensions/skills/AGENTS.md and exits cleanly');
  wsc.close(); cleanupBrowser(); cleanup(); process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
