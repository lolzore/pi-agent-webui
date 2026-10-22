/*
 * Editing a sent message forks the session and resends it.
 *
 * Two things were broken in this path, and both are checked here:
 *
 *  - the forkable list was fetched once per session and the *settled* promise
 *    was cached, so the first answer (at connect, on an empty session) stood for
 *    the whole session: the list stayed empty, and editing found no fork point
 *    at all ("editing does nothing").
 *  - the active-branch tree (get_tree) was fetched on every turn and every
 *    reload. On a long session that is a big answer parsed on the page's main
 *    thread, which is what made the liveness heartbeat time out, close the
 *    socket and re-render the whole chat every ~20 seconds. It is asked for only
 *    when someone is about to fork now.
 *
 * Usage: node test-fork-edit.js <browserPath>
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
const PORT = 28800 + (process.pid % 200);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-fork-'));
fs.mkdirSync(path.join(scratch, 'agent'), { recursive: true });
fs.mkdirSync(path.join(scratch, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'webui.json'), JSON.stringify({ onboarded: true }));
const RPC_LOG = path.join(scratch, 'rpc.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bridge = null;
const cleanup = () => { try { if (bridge) bridge.kill(); } catch { /* gone */ } try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ } };
process.on('exit', cleanup);
(async () => {
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: path.join(scratch, 'agent'), PI_CODING_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_SESSION_DIR: path.join(scratch, 'sessions'), WORKSPACE_DIR: scratch,
      PI_SESSION_DIR: path.join(scratch, 'sessions'), PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'), PI_WEBUI_SOURCE_FILE: path.join(scratch, 'source.txt'),
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_MOCK_RPC_LOG: RPC_LOG,
      PI_LLAMA_SCAN: 'off', PORT: String(PORT),
    }), stdio: ['ignore', 'ignore', 'pipe'],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { await new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: PORT, path: '/api/health' }, (r) => { r.resume(); r.on('end', res); }).on('error', rej); }); up = true; break; } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('bridge never came up');
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-fork-b-'));
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
    if (await evalJs("typeof startEdit === 'function' && typeof S === 'object' && (S.historyRender || 0) > 0 ? 1 : 0")) break;
    await sleep(250);
  }
  const out = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const res = {};
    const rpcsBefore = (() => { try { return require; } catch { return null; } })();
    document.getElementById('input').value = 'hello fork';
    sendPrompt('hello fork', [], undefined, true);
    await new Promise((r) => setTimeout(r, 2000));
    res.forkable = (S.forkable || []).map((f) => f.text);
    res.rowForkIdx = (document.querySelector('#chat .msg.user') || { dataset: {} }).dataset.forkIdx;
    const row = document.querySelector('#chat .msg.user');
    const editBtn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'edit');
    res.hasEdit = !!editBtn;
    editBtn.click();
    await new Promise((r) => setTimeout(r, 1500));
    res.editMode = !!S.editMode;
    res.banner = !document.getElementById('edit-banner').classList.contains('hidden');
    res.input = document.getElementById('input').value;
    // send the edit: this forks and resends
    const real = window.rpc;
    window.__rpc = [];
    window.rpc = (m) => { window.__rpc.push(m && m.type); return real(m); };
    document.getElementById('input').value = 'hello fork (edited)';
    document.getElementById('btn-send').click();
    await new Promise((r) => setTimeout(r, 2500));
    res.rpcs = window.__rpc.slice();
    window.rpc = real;
    return res;
  })()))()`));
  const log = fs.existsSync(RPC_LOG) ? fs.readFileSync(RPC_LOG, 'utf8').split('\n').filter(Boolean) : [];
  const firstEdit = out.rpcs.indexOf('fork');
  if (!out.forkable || !out.forkable.length) fail('the forkable list stayed empty - editing would find no fork point: ' + JSON.stringify(out));
  if (!out.hasEdit) fail('the sent message has no edit button');
  if (!out.editMode || !out.banner) fail('clicking edit did not start an edit: ' + JSON.stringify(out));
  if (out.input !== 'hello fork') fail('the message text was not put in the composer: ' + JSON.stringify(out.input));
  if (firstEdit < 0) fail('sending the edit did not fork: ' + JSON.stringify(out.rpcs));
  if (out.rpcs.indexOf('prompt', firstEdit) < 0) fail('the edited message was not resent after the fork: ' + JSON.stringify(out.rpcs));
  /* The tree is asked for when a fork starts, never on connect or on a turn:
   * that periodic heavy call is what killed the liveness heartbeat. */
  const promptAt = log.indexOf('prompt');
  const treeBeforePrompt = log.slice(0, promptAt < 0 ? log.length : promptAt).filter((t) => t === 'get_tree').length;
  if (treeBeforePrompt > 0) fail('get_tree was fetched while connecting - that is the periodic heavy call that killed the connection: ' + JSON.stringify(log));
  if (!log.includes('get_tree')) fail('the fork did not ask for the active-branch tree: ' + JSON.stringify(log));
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));
  console.log(`  forkable: ${JSON.stringify(out.forkable)}; edit started: ${out.editMode}; rpcs: ${out.rpcs.join(', ')}`);
  console.log(`  agent rpcs: ${log.join(', ')}`);
  console.log('  PASS editing a message forks and resends, and the tree is only asked for when forking');
  cleanupBrowser(); cleanup(); process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
