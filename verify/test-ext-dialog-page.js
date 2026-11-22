/*
 * Issue #274: accepting an extension dialog must reach the agent.
 *
 * The report: "Accepting something in the goal menu makes the menu disappear
 * but won't send the thing to the agent." The page closed the dialog, sent the
 * answer, and nothing happened - because the bridge rewrote the id of every
 * client request (fix for #227, two tabs numbering their requests from zero),
 * including `extension_ui_response`. pi looks the answer up by the id it issued
 * (dist/modes/rpc/rpc-mode.js: `pendingExtensionRequests.get(response.id)`) and
 * silently drops an id it does not know, so the extension's await never
 * resolved and the conversation stalled.
 *
 * This drives the real page against a real bridge and the mock agent's two-step
 * dialog: send /dialog, confirm, type a reason, and the transcript must show the
 * agent's completion - which can only appear if both answers arrived. A message
 * sent afterwards must still be answered (#276: nothing is left wedged).
 *
 * Usage: node test-ext-dialog-page.js <browserPath>
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
const PORT = 24800 + (process.pid % 100);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-ext-page-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const d of ['agent', 'ws', 'sessions']) fs.mkdirSync(path.join(scratch, d), { recursive: true });

const getJson = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

let bridge = null;
const cleanup = () => {
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);

/* Same reason as the socket-level checks: the suite has no per-test timeout, so
 * a browser that never reports its debug port must fail here, not hang. */
const watchdog = setTimeout(() => {
  console.error('FAIL: the page check did not finish within 180s');
  process.exit(1);
}, 180000);
watchdog.unref();

(async () => {
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_SESSION_DIR: path.join(scratch, 'sessions'),
      WORKSPACE_DIR: path.join(scratch, 'ws'),
      PI_SESSION_DIR: path.join(scratch, 'sessions'),
      PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'),
      PI_LLAMA_SCAN: 'off',
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PORT: String(PORT),
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let bridgeErr = '';
  bridge.stderr.on('data', (c) => { bridgeErr += c; });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const d = await getJson('/api/health'); if (d && d.ok) { up = true; break; } } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('the scratch bridge never came up\n' + bridgeErr.slice(-500));

  const WS = require('./ws-min.js');
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-ext-page-browser-'));
  const launched = WS.launchBrowser(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--user-data-dir=' + userDir,
    'about:blank',
  ]);
  const child = launched.child;
  let browserErr = '';
  child.stderr.on('data', (c) => { browserErr += c; });
  const cleanupBrowser = () => {
    try { child.kill(); } catch { /* gone */ }
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ }
  };
  process.on('exit', cleanupBrowser);
  let DBG_PORT;
  try {
    DBG_PORT = await Promise.race([
      launched.port,
      new Promise((_, rej) => setTimeout(() => rej(new Error('the browser never reported its debug port')), 30000)),
    ]);
  } catch (e) { fail(e.message); }

  let page = null;
  for (let i = 0; i < 100; i++) {
    try {
      const list = await new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port: DBG_PORT, path: '/json/list' }, (r) => {
          let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
          r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
        }).on('error', rej);
      });
      if (Array.isArray(list)) { page = list.find((t) => t.type === 'page'); if (page) break; }
    } catch { /* not ready */ }
    await sleep(150);
  }
  if (!page) fail('browser never exposed a page on the debug port\n' + browserErr.slice(-400));

  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.open();
  let id = 0;
  const pending = new Map();
  const problems = [];
  ws.onmessage = (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails || {};
      problems.push((e.exception && (e.exception.description || e.exception.value)) || e.text || '?');
    }
  };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw');
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const waitFor = async (expr, ms, what) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await evalJs(expr)) return true;
      await sleep(150);
    }
    fail(`${what} (waited ${ms}ms)`);
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await waitFor("document.readyState === 'complete' && typeof sendPrompt === 'function' ? 1 : 0", 25000, 'the page never finished loading');
  /* First run offers the package setup dialog, which covers the transcript. The
   * dialog questions this test is about are not that one: close it first, the
   * way its own "skip" button does. */
  await evalJs(`(() => {
    const d = document.getElementById('setup-dialog');
    if (d && d.open) { const s = document.getElementById('setup-skip') || document.getElementById('setup-next'); if (s) s.click(); else d.close(); }
    return true;
  })()`);
  await sleep(300);

  /* ── send /dialog the way a user does ─────────────────────────────────── */
  const sendPrompt = async (text) => {
    await evalJs(`(() => {
      const box = document.getElementById('input');
      box.value = ${JSON.stringify(text)};
      box.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btn-send').click();
      return true;
    })()`);
  };
  await sendPrompt('/dialog');
  await waitFor("document.getElementById('ext-dialog').open ? 1 : 0", 10000, '#274: the extension dialog never opened');

  const first = JSON.parse(await evalJs(`JSON.stringify({
    title: document.getElementById('ext-dialog-title').textContent,
    ok: document.getElementById('ext-dialog-ok').textContent,
    body: document.getElementById('ext-dialog-body').innerHTML.length,
  })`));
  if (!/Confirm action/.test(first.title)) fail('the first dialog has the wrong title: ' + JSON.stringify(first));
  console.log(`  dialog 1: "${first.title}" with a "${first.ok}" button`);

  /* ── accept it ────────────────────────────────────────────────────────── */
  await evalJs("document.getElementById('ext-dialog-ok').click(); true");
  let second = null;
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    second = JSON.parse(await evalJs(`JSON.stringify({
      open: document.getElementById('ext-dialog').open,
      title: document.getElementById('ext-dialog-title').textContent,
      placeholder: (document.querySelector('#ext-dialog-body input') || {}).placeholder || '',
    })`));
    if (second.open && second.placeholder) break;
    await sleep(150);
  }
  if (!second || !second.open || !second.placeholder) {
    fail('#274: accepting the dialog closed the menu and nothing came back - the agent never received '
      + `the answer, so it never asked its next question. Last dialog state: ${JSON.stringify(second)}`);
  }
  console.log(`  dialog 2: "${second.placeholder}" - the answer reached the agent`);

  /* ── answer the second step and let the agent finish ──────────────────── */
  await evalJs(`(() => {
    const box = document.querySelector('#ext-dialog-body input');
    box.value = 'because the tests pass';
    document.getElementById('ext-dialog-ok').click();
    return true;
  })()`);
  const wantFinal = "/Dialog flow complete/.test(document.getElementById('chat').innerText)";
  const untilDone = Date.now() + 15000;
  let finalText = '';
  while (Date.now() < untilDone) {
    if (await evalJs(wantFinal)) break;
    finalText = await evalJs('String(document.getElementById(\'chat\').innerText).slice(-600)');
    await sleep(200);
  }
  if (!await evalJs(wantFinal)) {
    fail('#274: the agent never confirmed the dialog round-trip in the transcript; the page shows: '
      + JSON.stringify(finalText));
  }
  console.log('  the transcript shows the agent completing the two-step dialog');

  /* ── and the conversation is not wedged afterwards (#276) ─────────────── */
  await sendPrompt('still there?');
  await waitFor("/Mock reply to: \"still there\\?\"/.test(document.getElementById('chat').innerText)", 15000, '#276: the session stopped answering after a dialog was accepted');
  if (problems.length) fail('the page threw while answering the dialog: ' + problems.slice(0, 2).join(' | '));
  console.log('  a message sent afterwards is answered: nothing is wedged');
  console.log(JSON.stringify({ dialogs: 2, answered: true }));
  process.exit(0);
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
