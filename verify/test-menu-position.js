/*
 * Regression: dropdowns opened while the settings dialog is up appeared at the
 * dialog's offset instead of next to their anchor.
 *
 * The menus are appended *inside* the open dialog (so they render above the
 * modal) and positioned with viewport coordinates. Giving that dialog
 * `contain: layout paint` or `will-change: transform` makes it the containing
 * block for fixed-position descendants, so every menu landed at the dialog's
 * x/y - which is what the report showed.
 *
 * This runs its own bridge with the setup already done, opens Settings, and
 * checks the instance menu (topbar anchor, appended inside the dialog), a menu
 * on an anchor created inside the dialog, and the model picker (a static
 * element in the page). Each must sit next to its anchor and inside the
 * viewport, and the dialog must not carry a containing-block property.
 *
 * Usage: node test-menu-position.js <browserPath>
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
const PORT = 24100 + (process.pid % 300);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-menupos-'));
const agentDir = path.join(scratch, 'agent');
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(path.join(scratch, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(agentDir, 'settings.json'), '{}');
// Onboarded, so the settings dialog is the one that opens (the setup dialog
// would otherwise be the `dialog[open]` the menus are appended to).
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

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-menupos-browser-'));
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
    if (await evalJs("typeof openSettings === 'function' && typeof openInstanceMenu === 'function' && typeof openMenu === 'function' ? 1 : 0")) break;
    await sleep(250);
  }

  const out = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const rect = (e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    const res = {};
    openSettings();
    await new Promise((r) => setTimeout(r, 400));
    res.dialog = rect($('settings-dialog'));
    const cs = getComputedStyle($('settings-dialog'));
    res.contain = cs.contain; res.transform = cs.transform; res.willChange = cs.willChange;

    // 1. the instance menu: anchor in the topbar, menu appended inside the dialog
    openInstanceMenu($('btn-instance'), true);
    await new Promise((r) => setTimeout(r, 200));
    const menus = [...document.querySelectorAll('.model-menu')];
    const inst = menus[menus.length - 1];
    res.instance = { btn: rect($('btn-instance')), menu: rect(inst), parent: inst.parentElement.id };
    closeAllMenus();

    // 2. a menu on an anchor created inside the dialog itself
    const anchor = document.createElement('button');
    anchor.id = 'verify-menu-anchor';
    anchor.className = 'btn small';
    anchor.textContent = 'anchor';
    document.querySelector('#settings-dialog .dialog-buttons').appendChild(anchor);
    await new Promise((r) => setTimeout(r, 100));
    openMenu(anchor, [{ label: 'one' }, { label: 'two' }], { force: true });
    await new Promise((r) => setTimeout(r, 200));
    const inside = [...document.querySelectorAll('.model-menu')].pop();
    res.inside = { btn: rect(anchor), menu: rect(inside), parent: inside.parentElement.id };
    closeAllMenus();

    // 3. the model picker (static element in the page, not appended)
    toggleModelMenu(true);
    await new Promise((r) => setTimeout(r, 200));
    res.model = { btn: rect($('model-btn')), menu: rect($('model-menu')) };
    await new Promise((r) => setTimeout(r, 250));   // past the open-grace period
    $('chat-scroll').dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 100));
    res.menuClosedOnScroll = $('model-menu').classList.contains('hidden');
    toggleModelMenu(false);

    res.viewport = { w: innerWidth, h: innerHeight };
    return res;
  })()))()`));

  const near = (name, btn, menu) => {
    // The menu hangs off the anchor: same x (within 4px), and either just below
    // it or (when there is no room) flipped just above it.
    if (Math.abs(menu.x - btn.x) > 4) fail(`${name}: the menu is ${menu.x - btn.x}px away horizontally from its anchor (${JSON.stringify({ btn, menu })})`);
    const below = Math.abs(menu.y - (btn.y + btn.h + 6)) <= 12;
    const above = Math.abs((menu.y + menu.h) - (btn.y - 6)) <= 12;
    if (!below && !above) fail(`${name}: the menu is not attached to its anchor (${JSON.stringify({ btn, menu })})`);
    if (menu.x < 0 || menu.y < 0 || menu.x + menu.w > out.viewport.w + 1 || menu.y + menu.h > out.viewport.h + 1) {
      fail(`${name}: the menu is outside the viewport (${JSON.stringify({ menu, viewport: out.viewport })})`);
    }
  };
  if (!out.contain || out.contain !== 'none') fail('the dialog carries contain again: ' + out.contain);
  if (out.transform !== 'none' || (out.willChange && out.willChange !== 'auto')) fail(`the dialog has a transform/will-change again: ${out.transform} / ${out.willChange}`);
  if (out.instance.parent !== 'settings-dialog') fail('the instance menu was not appended inside the dialog: ' + out.instance.parent);
  near('instance menu', out.instance.btn, out.instance.menu);
  if (out.inside.parent !== 'settings-dialog') fail('the dialog-anchored menu was not appended inside the dialog: ' + out.inside.parent);
  near('dialog-anchored menu', out.inside.btn, out.inside.menu);
  // The model picker opens above its button (and clamps its left edge to the
  // viewport), so it gets its own check rather than the below-the-anchor one.
  if (out.model.menu.y + out.model.menu.h > out.model.btn.y + 2 || out.model.menu.y + out.model.menu.h < out.model.btn.y - 14) {
    fail('the model picker is not sitting above its button: ' + JSON.stringify(out.model));
  }
  if (out.model.menu.x < 0 || out.model.menu.x + out.model.menu.w > out.viewport.w + 1) {
    fail('the model picker is outside the viewport: ' + JSON.stringify({ menu: out.model.menu, viewport: out.viewport }));
  }
  if (!out.menuClosedOnScroll) fail('the model picker stayed open after the page scrolled under it');
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));

  console.log(`  dialog ${JSON.stringify(out.dialog)}: instance menu ${JSON.stringify(out.instance.menu)} next to ${JSON.stringify(out.instance.btn)}; in-dialog anchor ${JSON.stringify(out.inside.menu)}; contain "${out.contain}"`);
  console.log('  PASS dropdowns opened while the settings dialog is up sit next to their anchors');
  cleanupBrowser();
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
