/*
 * Issue #217: "when you make a folder you have to refresh the list for it to
 * show" and "putting a session into it also won't update instantly".
 *
 * Every folder action - create, rename, empty, delete, drag a session in, drag a
 * folder onto another - ended in saveFolders(), which wrote the settings and
 * moved the highlight but never touched the list. The new folder only appeared on
 * the next 20s poll, and a session dropped into a folder stayed in the unfiled
 * list until then.
 *
 * This drives the real buttons: the sidebar's "+ folder", the real create dialog,
 * and then the function the drop handler calls, on a private bridge with two
 * fixture sessions. Nothing is fetched after the page has loaded, so a list that
 * only updates on a poll fails here.
 *
 * Usage: node test-session-folders.js [ignoredBaseUrl] <browserPath>
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
const PORT = 3130 + (process.pid % 150);
const DBG_PORT = 9550 + (process.pid % 200);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-folders-'));
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

(async () => {
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir, PI_SESSION_DIR: sessionDir,
      WORKSPACE_DIR: path.join(scratch, 'ws'),
      PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'),
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_LLAMA_SCAN: 'off',
      PORT: String(PORT),
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = ''; bridge.stderr.on('data', (c) => { err += c; });
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { const d = await getJson(PORT, '/api/health'); if (d.ok) { up = true; break; } } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('the scratch bridge never came up\n' + err.slice(-600));

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-folders-browser-'));
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--remote-debugging-port=' + DBG_PORT, '--user-data-dir=' + userDir,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const cleanupBrowser = () => {
    try { child.kill(); } catch { /* gone */ }
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ }
  };
  process.on('exit', cleanupBrowser);
  let berr = ''; child.stderr.on('data', (c) => { berr += c; });
  let ver = null;
  for (let i = 0; i < 100; i++) { try { ver = await getJson(DBG_PORT, '/json/version'); break; } catch { await sleep(150); } }
  if (!ver) fail('browser never came up\n' + berr.slice(-400));

  const WS = require('./ws-min.js');
  const page = (await getJson(DBG_PORT, '/json/list')).find((t) => t.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl);
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
  for (let i = 0; i < 140; i++) {
    if (await evalJs("typeof renderSessions === 'function' && document.querySelectorAll('#session-list .session-item').length >= 2 ? 1 : 0")) break;
    await sleep(250);
  }

  const out = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const folderCount = () => document.querySelectorAll('#session-list .session-folder').length;
    // No polling after this point: the page's own 20s timer would take us back
    // to "refresh fixes it", which is the bug.
    const beforeFolders = folderCount();
    const folderIcon = !!document.querySelector('#btn-new-folder svg path');

    // 1. the real "+ folder" button, then the real create dialog
    document.getElementById('btn-new-folder').click();
    await wait(150);
    const field = document.querySelector('#ask-body input');
    if (!field) return { fail: 'the create-folder dialog did not open', beforeFolders };
    field.value = 'probe folder';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('ask-ok').click();
    await wait(400);
    const afterCreate = folderCount();
    const folderRow = document.querySelector('#session-list .session-folder');
    const folderName = folderRow ? (folderRow.querySelector('.folder-name') || {}).textContent : '';

    // 2. file a session into the folder with real drag events, the way a reader does
    const rowOf = (name) => [...document.querySelectorAll('#session-list .session-item')]
      .find((r) => new RegExp(name).test(r.textContent || ''));
    const drag = (src, target) => {
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
    };
    const alphaRow = rowOf('Alpha session');
    const sessionPath = alphaRow ? alphaRow.dataset.path : '';
    drag(alphaRow, document.querySelector('#session-list .session-folder'));
    await wait(500);
    const rowsAfter = [...document.querySelectorAll('#session-list .session-item')].map((r) => r.dataset.path || '');
    const idxFolder = [...document.querySelectorAll('#session-list > *')].findIndex((n) => n.classList.contains('session-folder'));
    const kidsUnderFolder = idxFolder >= 0 && idxFolder + 1 < document.querySelectorAll('#session-list > *').length
      ? (document.querySelectorAll('#session-list > *')[idxFolder + 1].dataset || {}).path || ''
      : '';
    // re-query: the re-render replaced the row element captured above
    const freshFolder = document.querySelector('#session-list .session-folder');
    const countText = freshFolder ? (freshFolder.querySelector('.folder-count') || {}).textContent : '';

    // 3. fold and unfold by clicking the folder, with no reload in between
    const caret = () => (document.querySelector('#session-list .session-folder .folder-caret') || {}).textContent;
    const caretOpen = caret();
    const rowsOpen = document.querySelectorAll('#session-list .session-item').length;
    document.querySelector('#session-list .session-folder').click();
    await wait(300);
    const caretClosed = caret();
    const rowsClosed = document.querySelectorAll('#session-list .session-item').length;
    document.querySelector('#session-list .session-folder').click();
    await wait(300);
    const rowsReopened = document.querySelectorAll('#session-list .session-item').length;
    const caretReopened = caret();

    // 4. drag it back out onto a top-level session
    const unfiled = [...document.querySelectorAll('#session-list .session-item')]
      .find((r) => r.dataset.path !== sessionPath);
    const filed = [...document.querySelectorAll('#session-list .session-item')]
      .find((r) => r.dataset.path === sessionPath);
    if (unfiled && filed) drag(filed, unfiled);
    await wait(500);
    const rowsAfterOut = [...document.querySelectorAll('#session-list .session-item')].map((r) => r.dataset.path || '');
    const countAfterOut = (document.querySelector('#session-list .session-folder .folder-count') || {}).textContent || '';

    return { folderIcon, beforeFolders, afterCreate, folderName, sessionPath, rowsAfter, kidsUnderFolder, countText,
      caretOpen, rowsOpen, caretClosed, rowsClosed, rowsReopened, caretReopened,
      unfiledPath: unfiled ? unfiled.dataset.path : '', rowsAfterOut, countAfterOut };
  })()))()`));

  console.log('  folders/rows: ' + JSON.stringify(out));
  if (out.fail) fail(out.fail);
  if (!out.folderIcon) fail('the New folder button does not use the folder vector icon');
  if (out.afterCreate !== out.beforeFolders + 1) fail('the new folder is not in the list until a refresh (' + out.beforeFolders + ' -> ' + out.afterCreate + ')');
  if (!/probe folder/.test(out.folderName)) fail('the new folder row does not carry its name: ' + out.folderName);
  if (!out.sessionPath) fail('no fixture session row to file');
  if (!/1/.test(out.countText)) fail('the folder count did not update after filing a session: ' + out.countText);
  if (out.kidsUnderFolder !== out.sessionPath) fail('the filed session is not under the folder after the drop: ' + JSON.stringify(out.rowsAfter));
  if (out.rowsClosed >= out.rowsOpen) fail('folding the folder did not hide its session: ' + JSON.stringify(out));
  if (out.rowsReopened !== out.rowsOpen) fail('unfolding the folder did not bring its session back: ' + JSON.stringify(out));
  if (out.caretClosed === out.caretOpen || out.caretReopened !== out.caretOpen) fail('the folder caret does not follow the fold: ' + JSON.stringify(out));
  if (!out.rowsAfterOut.includes(out.sessionPath)) fail('the dragged-out session is missing from the list: ' + JSON.stringify(out.rowsAfterOut));
  if (out.rowsAfterOut[0] === out.sessionPath) fail('the dragged-out session is still inside the folder: ' + JSON.stringify(out.rowsAfterOut));
  if (String(out.countAfterOut).trim() !== '0') fail('filing the session back out did not update the folder count: ' + out.countAfterOut);
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));

  console.log('  PASS #217 a folder and a filed session show up, fold/unfold and drag out without a refresh');
  ws.close(); cleanupBrowser(); cleanup(); process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
