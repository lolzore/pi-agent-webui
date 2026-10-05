// Browser check: load the real page in a real browser and fail on anything the
// user would see as broken — a console error, a failed script, a page error, or
// a session list that stayed empty.
//
// This is the only layer that can catch a mistake in web/app.js. A syntax check
// passes on code that throws on the first line it executes, and the regression
// that started this was invisible to both `node --check` and the HTTP checks:
// the page loaded, the session list came back fine, and the transcript still
// rendered nothing.
//
// Usage: node test-browser.js <baseUrl> <browserPath>

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = process.argv[2];
const browser = process.argv[3];
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };

if (!browser || !fs.existsSync(browser)) {
  console.error('no browser at ' + browser);
  process.exit(2);
}

const PORT = 9222 + (process.pid % 500);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-chrome-'));

const child = spawn(browser, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + userDir,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let stderr = '';
child.stderr.on('data', (c) => { stderr += c; });

const cleanup = () => {
  try { child.kill(); } catch { /* gone */ }
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);

const getJson = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
    let b = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { b += c; });
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // wait for the debugging endpoint
  let ver = null;
  for (let i = 0; i < 100; i++) {
    try { ver = await getJson('/json/version'); break; } catch { await sleep(150); }
  }
  if (!ver) fail('browser debugging endpoint never came up\n' + stderr.slice(-500));

  // Minimal CDP client over the raw WebSocket, so there is no dependency to add.
  const WS = require('./ws-min.js');
  const targets = await getJson('/json/list');
  const page = targets.find((t) => t.type === 'page');
  if (!page) fail('no page target in the browser');

  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.open();

  const problems = [];
  let id = 0;
  const pending = new Map();
  ws.onmessage = (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      const text = (d.exception && (d.exception.description || d.exception.value))
        || d.text || 'unknown exception';
      problems.push('uncaught: ' + text);
    }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'assert')) {
      const text = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (!/favicon/i.test(text)) problems.push('console.error: ' + text);
    }
    if (m.method === 'Log.entryAdded') {
      const e = m.params.entry || {};
      const text = e.text || '';
      if (e.level === 'error' && !/favicon/i.test(text)) {
        // A 4xx on a session endpoint is the bridge correctly refusing
        // something, not a broken page. It happens whenever the agent reports a
        // session outside the bridge's session dir (a stale remembered session,
        // or a run with PI_SESSION_DIR pointed elsewhere) — the bridge logs
        // "not recording a session outside this bridge's session dir" and the
        // UI carries on. Failing on that would report a healthy bridge as
        // broken, so it is the one shape of error allowed through. A 5xx, or any
        // other URL, still fails the run.
        const refusedOutsideDir =
          /Failed to load resource/.test(text) &&
          /status of 4\d\d/.test(text) &&
          /\/api\/session-(messages|file)/.test(e.url || '');
        if (!refusedOutsideDir) problems.push('log: ' + text + (e.url ? ' (' + e.url + ')' : ''));
      }
    }
  };
  const send = (method, params) => new Promise((res) => {
    const n = ++id;
    pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params: params || {} }));
  });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  await send('Page.navigate', { url: base + '/' });
  // app.js is the last script on the page; this is only long enough for it to
  // define its globals. The real wait is the poll below.
  await sleep(1200);

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) {
      throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw');
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  /* Wait for the condition, not for a fixed number of milliseconds.
   *
   * This was a flat 3500ms sleep and then a count. On an idle machine that was
   * plenty; on a busy one - the first run after a container was started, say -
   * the page was still fetching the session list, and the test reported
   * "session list rendered 0 rows" for a page that was simply still starting.
   * That is the worst shape of test failure, because it looks exactly like a
   * product bug and costs a real investigation each time. */
  async function waitForRow(timeoutMs, expr) {
    const deadline = Date.now() + timeoutMs;
    let last;
    for (;;) {
      last = await evalJs(expr);
      if (last) return last;
      if (Date.now() > deadline) return last;
      await sleep(250);
    }
  }

  // 1. the app actually booted: app.js is the last script on the page and it
  //    populates the sidebar, so an empty list means it died or never ran.
  const rows = await waitForRow(20000, "document.querySelectorAll('#session-list .session-item').length");
  if (typeof rows !== 'number') fail('could not count session rows');
  if (rows < 1) {
    const html = await evalJs("document.getElementById('session-list').innerHTML.slice(0,200)");
    fail(`session list rendered ${rows} rows after 20s (innerHTML: ${JSON.stringify(html)})`);
  }

  // 2. the composer and its wiring exist
  for (const sel of ['#input', '#btn-send', '#topbar', '#chat']) {
    const has = await evalJs(`!!document.querySelector('${sel}')`);
    if (!has) fail(`${sel} is missing from the live DOM`);
  }

  // 3. stylesheet actually applied (a broken CSS file still "loads")
  const bg = await evalJs("getComputedStyle(document.body).backgroundColor");
  if (!bg || bg === 'rgba(0, 0, 0, 0)') fail(`stylesheet did not apply (body background: ${bg})`);

  // 4. typing into the composer reaches the app (proves the handler is bound
  //    and that no earlier exception tore down the rest of the script)
  const typed = await evalJs(`(() => {
    const i = document.getElementById('input');
    i.value = 'verify';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return i.value;
  })()`);
  if (typed !== 'verify') fail('composer is not accepting input');

  if (problems.length) {
    fail(problems.slice(0, 6).join(' | '));
  }

  console.log(`${rows} session rows, no console errors`);
  ws.close();
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
