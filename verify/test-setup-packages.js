/*
 * Issue #121: the first-run wizard should recommend packages to install, before
 * the preferences, and install the ticked ones (then restart the agent) when it
 * finishes.
 *
 * This runs its own bridge with a fresh (un-onboarded) settings file and one
 * package already listed, so the checklist has both states to show. It walks
 * the wizard: packages step first -> tick pi-subagents -> next -> preferences
 * -> Let's go -> the package is in pi's settings.json and the setup is done.
 *
 * Usage: node test-setup-packages.js <browserPath>
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
const PORT = 23800 + (process.pid % 300);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-setup-'));
const agentDir = path.join(scratch, 'agent');
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(path.join(scratch, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ packages: ['npm:pi-goal-x'] }, null, 2));
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
      PI_AGENT_DIR: agentDir,
      PI_CODING_AGENT_DIR: agentDir,
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

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-setup-browser-'));
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
  for (let i = 0; i < 120; i++) {
    if (await evalJs("typeof $ === 'function' && $('setup-dialog') && $('setup-dialog').open ? 1 : 0")) break;
    await sleep(250);
  }

  const out = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const res = {};
    res.packagesShown = !$('setup-step-packages').classList.contains('hidden');
    res.prefsHidden = $('setup-step-prefs').classList.contains('hidden');
    res.button = $('setup-done').textContent;
    /* The recommendations come from the bridge's package scan, which is
     * asynchronous: reading the list the moment the dialog opens made this test
     * flake inside the suite (an empty checklist). Wait for it. */
    for (let i = 0; i < 60; i++) {
      if (document.querySelectorAll('#setup-packages-list input[data-package]').length) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const boxes = [...document.querySelectorAll('#setup-packages-list input[data-package]')];
    res.sources = boxes.map((b) => b.dataset.package);
    const goal = boxes.find((b) => b.dataset.package === 'npm:pi-goal-x');
    const sub = boxes.find((b) => b.dataset.package === 'npm:pi-subagents');
    res.goal = goal ? { checked: goal.checked, disabled: goal.disabled } : null;
    res.sub = sub ? { checked: sub.checked, disabled: sub.disabled } : null;
    res.hasLinks = [...document.querySelectorAll('#setup-packages-list a')].map((a) => a.href);
    // tick the subagents package and go through the wizard
    if (sub) sub.checked = true;
    $('setup-done').click();
    await new Promise((r) => setTimeout(r, 300));
    res.prefsShown = !$('setup-step-prefs').classList.contains('hidden');
    res.packagesHidden = $('setup-step-packages').classList.contains('hidden');
    res.button2 = $('setup-done').textContent;
    $('setup-done').click();
    const t0 = Date.now();
    while (Date.now() - t0 < 6000 && $('setup-dialog').open) await new Promise((r) => setTimeout(r, 100));
    res.closed = !$('setup-dialog').open;
    res.onboarded = SET.onboarded === true;
    return res;
  })()))()`));

  if (!out.packagesShown || !out.prefsHidden) fail('the wizard did not start on the packages step: ' + JSON.stringify(out));
  if (out.button !== 'next') fail('the packages step button is not "next": ' + JSON.stringify(out.button));
  for (const s of ['npm:pi-searxng', 'npm:pi-llama-cpp', 'npm:pi-goal-x', 'npm:pi-subagents']) {
    if (!out.sources.includes(s)) fail('the checklist is missing ' + s + ': ' + JSON.stringify(out.sources));
  }
  if (!out.goal || out.goal.checked !== true || out.goal.disabled !== true) fail('an installed package is not ticked and locked: ' + JSON.stringify(out.goal));
  if (!out.sub || out.sub.checked !== false || out.sub.disabled !== false) fail('an uninstalled package is not offerable: ' + JSON.stringify(out.sub));
  if (out.hasLinks.length < 2) fail('the external tools have no links: ' + JSON.stringify(out.hasLinks));
  if (!out.prefsShown || !out.packagesHidden) fail('next did not move to the preferences: ' + JSON.stringify(out));
  if (out.button2 !== "Let's go") fail('the preferences step button is wrong: ' + JSON.stringify(out.button2));
  if (!out.closed || !out.onboarded) fail('finishing did not close the wizard and mark it done: ' + JSON.stringify(out));
  // The dialog closes before the install request finishes, so wait for the file.
  let settings = null;
  for (let i = 0; i < 40; i++) {
    try { settings = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')); } catch { settings = null; }
    if (settings && Array.isArray(settings.packages) && settings.packages.includes('npm:pi-subagents')) break;
    await sleep(150);
  }
  if (!settings || !Array.isArray(settings.packages) || !settings.packages.includes('npm:pi-subagents')) {
    fail('the ticked package was not added to pi\'s settings.json: ' + JSON.stringify(settings));
  }
  if (!settings.packages.includes('npm:pi-goal-x')) fail('the existing package was dropped: ' + JSON.stringify(settings));
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));

  console.log(`  wizard: packages first (${out.sources.length} rows, goal-x locked), next -> preferences, done -> pi-subagents written`);
  console.log('  PASS #121 the first-run wizard recommends packages, installs the ticked ones and finishes');
  cleanupBrowser();
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
