/*
 * Issue #106: "Settings menu takes a long time to load (about 2 seconds)."
 *
 * The dialog itself opens in milliseconds; what took seconds was the llama
 * probe. Each `/api/llama-models` waits out the unreachable servers' timeouts
 * (~1.2s here), the bridge cached an *empty* answer for only 2s, and the Pi
 * providers section retried every 2.5s for up to 10 tries - so opening Settings
 * started a probe storm that made the whole page feel busy.
 *
 * Now: an empty answer is cached for 15s (`?fresh=1` asks again now), the
 * providers retries are three at 5s, and they only run while the Pi providers
 * tab is the one on screen.
 *
 * This runs a bridge whose configured llama server is a closed port, so the
 * slow path is deterministic: it checks the cache from the bridge's side and
 * the probe count from the page's.
 *
 * Usage: node test-llama-probe.js <browserPath>
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
const PORT = 22900 + (process.pid % 300);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-llama-'));
fs.mkdirSync(path.join(scratch, 'agent'), { recursive: true });
fs.mkdirSync(path.join(scratch, 'sessions'), { recursive: true });
/* pi is pointed at a blackhole address, the way the reported machine was
 * pointed at an unreachable one: the probe waits, and the providers section has
 * something to name when nothing answers. */
fs.writeFileSync(path.join(scratch, 'agent', 'settings.json'), JSON.stringify({ llamaServerUrl: 'http://192.0.2.1:8080' }, null, 2));
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
const timed = async (p) => {
  const t0 = Date.now();
  const d = await getJson(p);
  return { ms: Date.now() - t0, d };
};

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
      // TEST-NET-1: reserved for documentation, so nothing routes it and the
      // probe waits out its timeout - the slow path the issue is about. (A
      // closed port on localhost refuses instantly and would not show it.)
      LLAMA_SERVER_URL: 'http://192.0.2.1:8080',
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

  /* ── the bridge caches the empty answer ─────────────────────────────── */
  const first = await timed('/api/llama-models');
  /* The bridge probes what is configured, loopback, and this machine's own
   * addresses - so a llama-server running here answers even with the LAN sweep
   * off. That is not a defect, it just means this check (which is about the
   * empty answer being cached) cannot run on this machine: skip, do not fail. */
  if ((first.d.servers || []).length) {
    console.error('  (a llama server is answering on this machine: ' + JSON.stringify((first.d.servers || []).map((x) => x.url)) + ' - skipping)');
    process.exit(77);
  }
  if (first.ms >= 100) {
    const second = await timed('/api/llama-models');
    if (second.ms > 150) fail('the second probe was not served from the negative cache: ' + second.ms + 'ms');
    const fresh = await timed('/api/llama-models?fresh=1');
    if (fresh.ms < 100) fail('?fresh=1 did not probe again: ' + fresh.ms + 'ms');
    console.log(`  bridge cache: first ${first.ms}ms, cached ${second.ms}ms, fresh ${fresh.ms}ms, servers=${(first.d.servers || []).length}`);
  } else {
    // A machine that refuses instantly (no route, or a firewall that answers)
    // cannot show the cache timing; the probe-count half below still runs.
    console.log(`  (the first probe was ${first.ms}ms - this machine does not make it wait - so only the probe counts are asserted)`);
  }

  /* ── the page: one probe on open, retries only on the providers tab ─── */
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-llama-browser-'));
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
  for (let i = 0; i < 100; i++) {
    if (await evalJs("typeof openSettings === 'function' && typeof loadPiProviders === 'function' ? 1 : 0")) break;
    await sleep(250);
  }

  const out = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    /* Only the *slow* llama calls are the ones that matter: the interactive
     * path asks for a fresh probe (?fresh=1, ~1.2s here), while the background
     * model-menu loop takes the bridge's cached answer (a couple of ms). */
    const calls = [];
    const real = window.fetch;
    window.fetch = (u, o) => {
      const s = String(u);
      if (!s.includes('/api/llama-models')) return real(u, o);
      const t = performance.now();
      return real(u, o).finally(() => calls.push({ url: s, ms: Math.round(performance.now() - t) }));
    };
    const slow = () => calls.filter((c) => c.ms > 500).length;
    const t0 = performance.now();
    openSettings();
    let openMs = 0;
    for (let i = 0; i < 200; i++) { if ($('settings-dialog').open) { openMs = performance.now() - t0; break; } await new Promise((r) => requestAnimationFrame(r)); }
    // The General tab is what opens; nothing there needs the llama probe, so
    // the single probe from openSettings must stay a single probe.
    await new Promise((r) => setTimeout(r, 3500));
    const afterOpen = slow();
    const tab = [...document.querySelectorAll('#settings-tabs .tab')].find((t) => t.dataset.tab === 'providers');
    if (tab) tab.click();
    await new Promise((r) => setTimeout(r, 1500));
    const afterTab = slow();
    // Bounded retries while the tab is shown: three at 5s, so in 11 more
    // seconds there can be at most two more.
    await new Promise((r) => setTimeout(r, 11000));
    const afterWait = slow();
    /* The last retry may be mid-flight when the wait ends; give the section a
     * moment to render its settled state. */
    let text = '';
    for (let i = 0; i < 40; i++) {
      const box = $('pi-providers-list');
      text = box ? box.textContent : '';
      if (/no server answered/.test(text)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    window.fetch = real;
    return {
      openMs: Math.round(openMs),
      afterOpen, afterTab, afterWait,
      text: text.slice(0, 160),
      loading: /loading/.test(text),
    };
  })()))()`));

  if (out.openMs > 300) fail('the dialog took ' + out.openMs + 'ms to open');
  if (out.afterOpen !== 1) fail(`opening Settings probed the llama server ${out.afterOpen} times, expected 1`);
  if (out.afterTab < 2) fail('clicking the Pi providers tab did not probe');
  if (out.afterWait > 1 + 1 + 3) fail(`retries are not bounded: ${out.afterWait} probes (expected <= 5)`);
  if (out.loading) fail('the providers section is still saying loading…: ' + JSON.stringify(out.text));
  if (!/no server answered/.test(out.text)) fail('the section does not report the empty result: ' + JSON.stringify(out.text));
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));

  console.log(`  page: dialog ${out.openMs}ms, probes open=${out.afterOpen}, tab=${out.afterTab}, after 11s=${out.afterWait}; "${out.text.trim().slice(0, 70)}…"`);
  console.log('  PASS #106 Settings probes once on open, the empty answer is cached, and retries stay on the providers tab');
  cleanupBrowser();
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
