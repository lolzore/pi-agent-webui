/*
 * Issue #89: "Settings menu visual bug."
 *
 * The screenshot showed the settings rows in a two-column grid with a ~90px
 * label column, squeezed text and overlapping labels - the layout a stylesheet
 * from before the dialog-sizing fix produces. The page itself was current; the
 * tab was long-lived and still had the old stylesheet, so new HTML and old CSS
 * were mixed. The bridge now versions every asset with the running build
 * (`?v=<newest mtime+size in web/>`) and writes the same build into a meta tag,
 * and the page compares it against /api/health on each heartbeat: a different
 * build offers a reload instead of leaving a mixed page in place.
 *
 * This test checks the served HTML, the meta tag, the versioned asset fetch, the
 * 510px layout (single-column grid, no overlap) and the reload hint - with a
 * screenshot at the issue's width for the PR.
 *
 * Usage: node test-build-assets.js <browserPath> [screenshotPath]
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const browser = process.argv[2];
const shotPath = process.argv[3] || '/tmp/89-settings-510.png';
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const ROOT = path.resolve(__dirname, '..');
const PORT = 20500 + (process.pid % 400);
const DBG_PORT = 9300 + (process.pid % 200);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-build-'));
const agentDir = path.join(scratch, 'agent');
const homeDir = path.join(scratch, 'home');
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(homeDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, 'settings.json'), '{}');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bridge = null;
const cleanup = () => {
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);

const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b }));
  }).on('error', rej);
});
const getJson = (p) => get(p).then((r) => { try { return JSON.parse(r.body); } catch (e) { throw e; } });

(async () => {
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      HOME: homeDir,
      PI_AGENT_DIR: agentDir,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: path.join(scratch, 'sessions'),
      WORKSPACE_DIR: ROOT,
      PI_SESSION_DIR: path.join(scratch, 'sessions'),
      PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
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
    try { await getJson('/api/health'); up = true; break; } catch { await sleep(200); }
  }
  if (!up) fail('the scratch bridge never came up\n' + bridgeErr.slice(-500));

  /* ── every asset URL carries the running build ─────────────────────── */
  const health = await getJson('/api/health');
  const build = health.build;
  if (!build) fail('/api/health reports no build');
  const page = await get('/');
  const html = page.body;
  const refs = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))(\?[^"]*)?"/g)];
  if (!refs.length) fail('index.html references no scripts or stylesheets');
  for (const m of refs) {
    if (!m[2] || !m[2].includes('v=' + build)) {
      fail(`${m[1]} is not versioned with the build (${m[2] || 'no query'}): new HTML can mix with an old file`);
    }
  }
  if (!new RegExp(`<meta name="build" content="${build}">`).test(html)) {
    fail('index.html does not carry the build in a meta tag');
  }
  const css = await get(`/style.css?v=${build}`);
  if (css.status !== 200 || !/text\/css/.test(css.headers['content-type'] || '')) {
    fail('a versioned asset does not serve: HTTP ' + css.status + ' ' + css.headers['content-type']);
  }
  console.log(`  ${refs.length} asset URLs versioned with build ${build}; the meta tag and a versioned fetch agree`);

  /* ── the page at the width from the issue screenshot ───────────────── */
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-build-browser-'));
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
  for (let i = 0; i < 100; i++) {
    try {
      ver = await new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port: DBG_PORT, path: '/json/version' }, (r) => {
          let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
          r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
        }).on('error', rej);
      });
      break;
    } catch { await sleep(150); }
  }
  if (!ver) fail('browser never came up\n' + browserErr.slice(-400));

  const WS = require('./ws-min.js');
  const pages = await new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: DBG_PORT, path: '/json/list' }, (r) => {
      let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
  const ws = new WS(pages.find((t) => t.type === 'page').webSocketDebuggerUrl);
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
  await send('Emulation.setDeviceMetricsOverride', { width: 510, height: 674, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 100; i++) {
    if (await evalJs("typeof S === 'object' && S && S.ws ? 1 : 0")) break;
    await sleep(250);
  }

  const pageBuild = await evalJs('S.pageBuild');
  if (pageBuild !== build) fail(`the page did not read the build from its meta tag: ${pageBuild} != ${build}`);

  await evalJs("$('btn-settings').click(); true");
  await sleep(400);
  const layout = JSON.parse(await evalJs(`(() => {
    const grid = $('tab-general').querySelector('.settings-grid');
    if (!grid) return JSON.stringify({ error: 'no .settings-grid in the General tab' });
    const cs = getComputedStyle(grid);
    const kids = [...grid.children];
    const overlaps = [];
    for (let i = 1; i < kids.length; i++) {
      const a = kids[i - 1].getBoundingClientRect(), b = kids[i].getBoundingClientRect();
      if (b.top < a.bottom - 2) overlaps.push((kids[i - 1].textContent || '').trim().slice(0, 20) + ' / ' + (kids[i].textContent || '').trim().slice(0, 20));
    }
    const labels = kids.filter((k) => k.tagName === 'LABEL').map((l) => Math.round(l.getBoundingClientRect().width));
    return JSON.stringify({ tracks: cs.gridTemplateColumns.split(/\\s+/).length, columns: cs.gridTemplateColumns, labels, overlaps });
  })()`));
  if (layout.error) fail(layout.error);
  if (layout.tracks !== 1) fail(`at 510px the settings grid is not one column: ${layout.columns}`);
  if (layout.overlaps.length) fail('settings rows overlap at 510px: ' + layout.overlaps.join(' | '));
  if (layout.labels.some((w) => w < 150)) fail('a settings label is squeezed into a narrow column: ' + JSON.stringify(layout.labels));
  console.log(`  510px: one grid track, no overlap, label widths ${layout.labels.join('/')}`);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'));
  console.log('  screenshot:', shotPath);

  /* ── a changed build offers a reload, the same build stays quiet ───── */
  /* Whatever the heartbeat legitimately showed for the build this test itself
   * changed is cleared first: the question here is only whether checkBuild with
   * the *same* build stays quiet. */
  await evalJs("$('banner').classList.add('hidden'); checkBuild({ build: S.pageBuild }); true");
  const quiet = await evalJs("$('banner').classList.contains('hidden')");
  if (!quiet) fail('the reload hint appears when the build has not changed');
  await evalJs("checkBuild({ build: 'stale-0000' }); true");
  const hint = JSON.parse(await evalJs(`JSON.stringify({
    hidden: $('banner').classList.contains('hidden'),
    text: $('banner').textContent,
    button: (document.querySelector('#banner button') || {}).textContent || '',
  })`));
  if (hint.hidden) fail('no reload hint after the build changed');
  if (!/reload/i.test(hint.text) || !/reload/i.test(hint.button)) fail('the hint does not offer a reload: ' + JSON.stringify(hint));
  console.log('  a changed build shows the reload hint; an unchanged one stays quiet');

  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));
  console.log('  PASS #89 assets are build-versioned, the 510px layout is single-column, a stale build offers a reload');
  cleanupBrowser();
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
