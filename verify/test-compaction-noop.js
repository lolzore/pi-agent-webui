/*
 * Issue #137: "compaction(manual) disappeared after it finished. Context is
 * still the same."
 *
 * pi can end a manual compaction without a result (nothing to cut). The handler
 * used to delete the live "compacting…" block and draw nothing, so the
 * compaction appeared to vanish while the context - correctly - stayed the
 * same. It now keeps a marker ("pi reported no summary") and records a mark so
 * a rebuild puts it back.
 *
 * This runs its own bridge and drives both shapes: a no-result end and a normal
 * result end.
 *
 * Usage: node test-compaction-noop.js <browserPath>
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
const PORT = 25000 + (process.pid % 300);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-cnoop-'));
fs.mkdirSync(path.join(scratch, 'agent'), { recursive: true });
fs.mkdirSync(path.join(scratch, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'webui.json'), JSON.stringify({ onboarded: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bridge = null;
const cleanup = () => {
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);

const getJson = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

(async () => {
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_SESSION_DIR: path.join(scratch, 'sessions'),
      WORKSPACE_DIR: scratch,
      PI_SESSION_DIR: path.join(scratch, 'sessions'),
      PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'),
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_LLAMA_SCAN: 'off',
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

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-cnoop-browser-'));
  const launched = require('./ws-min.js').launchBrowser(browser, [
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

  let DBG_PORT = 0;
  try { DBG_PORT = await launched.port; } catch (e) { fail(e.message); }
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
    } catch { /* not ready yet */ }
    await sleep(150);
  }
  if (!page) fail('browser never exposed a page on the debug port\n' + browserErr.slice(-400));

  const WS = require('./ws-min.js');
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
  /* Wait for the first transcript load to finish, not just for the functions to
   * exist: a marker injected while that render is still chunking gets wiped when
   * it clears the chat, which made this test flake inside the suite. */
  for (let i = 0; i < 100; i++) {
    if (await evalJs("typeof handleEvent === 'function' && typeof refreshMessages === 'function' && (S.historyRender || 0) > 0 ? 1 : 0")) break;
    await sleep(250);
  }

  const out = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const res = {};
    const markers = () => [...document.querySelectorAll('.msg.compaction')].map((n) => n.textContent.trim().slice(0, 220));
    // 1. a manual compaction that ends without a result must not vanish
    handleEvent({ type: 'compaction_start' });
    res.liveDuring = !!S.compactionLive;
    handleEvent({ type: 'compaction_end', reason: 'manual' });
    await new Promise((r) => setTimeout(r, 300));
    res.liveAfter = !!S.compactionLive;
    res.markersAfterNoop = markers();
    res.noopMark = S.compactionMarks.some((k) => k.noop);
    await refreshMessages();
    await new Promise((r) => setTimeout(r, 300));
    res.markersAfterRebuild = markers();
    // 2. a normal compaction still renders its summary
    handleEvent({ type: 'compaction_start' });
    handleEvent({ type: 'compaction_end', reason: 'manual', result: { summary: 'VERIFY SUMMARY BODY', tokensBefore: 100000, estimatedTokensAfter: 20000 } });
    await new Promise((r) => setTimeout(r, 300));
    res.markersAfterResult = markers();
    res.resultMark = S.compactionMarks.some((k) => !k.noop && /VERIFY SUMMARY BODY/.test(k.summary || ''));
    return res;
  })()))()`));

  if (!out.liveDuring) fail('no live compaction block appeared');
  if (out.liveAfter) fail('the live block stayed after the end');
  if (!out.noopMark) fail('no noop mark was recorded: ' + JSON.stringify(out));
  if (!out.markersAfterNoop.some((m) => /no summary/.test(m))) fail('the no-result compaction left no marker: ' + JSON.stringify(out.markersAfterNoop));
  if (!out.markersAfterRebuild.some((m) => /no summary/.test(m))) fail('the marker vanished after a rebuild: ' + JSON.stringify(out.markersAfterRebuild));
  if (!out.markersAfterResult.some((m) => /conversation compacted/.test(m) && /VERIFY SUMMARY BODY/.test(m))) {
    fail('the summary compaction did not render its body: ' + JSON.stringify(out.markersAfterResult));
  }
  if (!out.resultMark) fail('the result mark was not recorded: ' + JSON.stringify(out));
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));

  console.log(`  no-result compaction keeps "${out.markersAfterNoop[0]}" (and after a rebuild); a result compaction renders its summary`);
  console.log('  PASS #137 a compaction that ends without a summary no longer vanishes');
  cleanupBrowser();
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
