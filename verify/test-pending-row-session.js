/*
 * Issue #52: "Steered message winds up in a new chat too (visually)".
 *
 * A message that has just been sent exists only in the DOM until pi writes it to the
 * session file, so refreshMessages() re-appends it after every rebuild - that is the
 * fix for issue #1, and it works. What it did not know was WHICH session the row was
 * sent to: the carry-over appended every pending row to whatever transcript was being
 * rendered. So steering a message and then starting a new chat showed the steered
 * message in the new chat as well.
 *
 * Rows now carry the session they were sent to, and the carry-over only re-appends the
 * ones belonging to the session on screen.
 *
 * Both halves are checked, because the fix for one issue is exactly the behaviour the
 * other depends on: a row from the SAME session must still survive a rebuild (or #1
 * comes back), and a row from another session must not be shown (#52). A check that
 * only did the second would pass by breaking the first.
 *
 * Usage: node test-pending-row-session.js <baseUrl> <browserPath>
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = process.argv[2];
const browser = process.argv[3];
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
const ok = (m) => console.log('  PASS ' + m);
if (!base) { console.error('usage: node test-pending-row-session.js <baseUrl> <browserPath>'); process.exit(2); }
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const PORT = 9934 + (process.pid % 7);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-pending-'));
const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDir,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', (c) => { stderr += c; });
const cleanup = () => {
  try { child.kill(); } catch { /* gone */ }
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
const getText = (p) => new Promise((res, rej) => {
  http.get(base + p, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => res({ status: r.statusCode, body: b }));
  }).on('error', rej);
});

(async () => {
  let ver = null;
  for (let i = 0; i < 100; i++) { try { ver = await getJson('/json/version'); break; } catch { await sleep(150); } }
  if (!ver) fail('browser never came up\n' + stderr.slice(-400));

  /* Two real session files, because the check is about which one is being rendered.
   * Their directory comes from the bridge, not from a guess. */
  const cfg = await getText('/api/config');
  let sessionDir = null;
  try { sessionDir = JSON.parse(cfg.body).sessionDir; } catch { /* reported below */ }
  if (!sessionDir) fail('could not ask the bridge where its session dir is: ' + cfg.body.slice(0, 120));
  const A = path.join(sessionDir, 'pending-row-a.jsonl');
  const B = path.join(sessionDir, 'pending-row-b.jsonl');
  const head = (name) => JSON.stringify({ type: 'session', name }) + '\n' +
    JSON.stringify({ type: 'message', id: 'm1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'existing line in ' + name } }) + '\n';
  fs.writeFileSync(A, head('A'));
  fs.writeFileSync(B, head('B'));
  const removeFiles = () => { for (const f of [A, B]) { try { fs.rmSync(f, { force: true }); } catch { /* gone */ } } };
  process.on('exit', removeFiles);

  const WS = require('./ws-min.js');
  const page = (await getJson('/json/list')).find((t) => t.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.open();
  let id = 0; const pending = new Map();
  const problems = [];
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
  const jsonAsync = async (expr) => JSON.parse(await evalJs(`(async () => JSON.stringify(await (${expr})))()`));

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: base + '/' });
  await sleep(3000);
  for (let i = 0; i < 60; i++) {
    if (await evalJs("typeof sendPrompt === 'function' && typeof refreshMessages === 'function' ? 1 : 0")) break;
    await sleep(250);
  }

  const out = await jsonAsync(`(async () => {
    const A = ${JSON.stringify(A)}, B = ${JSON.stringify(B)};
    const rows = () => [...document.querySelectorAll('#chat .msg.user[data-live="1"]')].map((r) => r.textContent.trim());
    const real = rpc;
    rpc = () => Promise.resolve({});                  // accept the send; nothing goes to the agent

    // Send while in A, the way a steer does.
    S.viewSession = null;
    S.state.sessionFile = A;
    await refreshMessages();
    document.getElementById('input').value = '';
    sendPrompt('STEERED MESSAGE SENT WHILE IN A', [], 'steer', true);
    await new Promise((r) => setTimeout(r, 80));
    const afterSend = rows();

    // A rebuild in the same session must keep it - that is issue #1, still fixed.
    await refreshMessages();
    const afterSameSessionRebuild = rows();

    // Now the session changes, which is what starting a new chat does.
    S.state.sessionFile = B;
    await refreshMessages();
    const afterSwitch = rows();
    const chatTextAfterSwitch = document.getElementById('chat').textContent;
    const tag = (document.querySelector('#chat .msg.user[data-live="1"]') || { dataset: {} }).dataset.liveSession;

    // And back to A. The row was dropped when B was rendered, so it does not come
    // back from the DOM - the file is the source of truth from here, and pi has the
    // message because the send was accepted. What must not happen is the row being
    // there TWICE, or the text of A's transcript being wrong in some other way.
    S.state.sessionFile = A;
    await refreshMessages();
    const backInA = rows();
    const backInAText = document.getElementById('chat').textContent;
    const countInA = (backInAText.match(/STEERED MESSAGE SENT WHILE IN A/g) || []).length;

    rpc = real;
    for (const r of document.querySelectorAll('#chat .msg.user[data-live="1"]')) r.remove();
    return { afterSend, afterSameSessionRebuild, afterSwitch, chatTextAfterSwitch, backInA, backInAText, countInA, tag };
  })()`);

  console.log('  sent while in A            : ' + JSON.stringify(out.afterSend));
  console.log('  rebuild, still in A        : ' + JSON.stringify(out.afterSameSessionRebuild));
  console.log('  now in B (a new chat)      : ' + JSON.stringify(out.afterSwitch));
  console.log('  back in A                  : ' + JSON.stringify(out.backInA));

  if (out.afterSend.length !== 1) fail('the sent message was not drawn at all, so nothing below means anything');
  if (!out.afterSameSessionRebuild.length) {
    fail('the row did not survive a rebuild in its own session - that is issue #1 coming back, and the reason the carry-over exists');
  }
  ok('#1 a row sent to this session is still carried across a rebuild');

  if (out.afterSwitch.length) {
    fail(`the steered message is still on screen after switching to another session (${JSON.stringify(out.afterSwitch)}) - that is issue #52`);
  }
  if (/STEERED MESSAGE SENT WHILE IN A/.test(out.chatTextAfterSwitch)) {
    fail('the steered message appears in the other session\'s transcript - issue #52');
  }
  ok('#52 a row sent to another session is not shown in this one');

  if (out.countInA > 1) fail(`the message is on screen ${out.countInA} times in its own session`);
  console.log(`  back in A: the row is no longer carried from the DOM (${out.backInA.length} pending row(s), ${out.countInA} mention(s) of the text) - the file is the source of truth once it is dropped`);
  ok('#52 returning to a session does not duplicate the message');

  if (problems.length) fail(problems.slice(0, 3).join(' | '));
  ws.close(); cleanup(); removeFiles();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
