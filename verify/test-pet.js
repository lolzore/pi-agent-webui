/*
 * Issue #267: the Fun tab owns gamer mode and confetti, and the opt-in DeepSeek
 * desk pet is a real fixed overlay (not part of the transcript) that follows the
 * agent state, can be dragged, and remembers its corner.
 *
 * Usage: node test-pet.js <browserPath>
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
const PORT = 23000 + (process.pid % 300);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-pet-'));
fs.mkdirSync(path.join(scratch, 'agent'), { recursive: true });
fs.mkdirSync(path.join(scratch, 'sessions'), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bridge = null;
let cleanupBrowser = () => {};
const cleanup = () => { try { if (bridge) bridge.kill(); } catch { /* gone */ } try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ } };
process.on('exit', cleanup);

(async () => {
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: path.join(scratch, 'agent'), PI_CODING_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_SESSION_DIR: path.join(scratch, 'sessions'), WORKSPACE_DIR: scratch,
      PI_SESSION_DIR: path.join(scratch, 'sessions'), PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'),
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_LLAMA_SCAN: 'off', PORT: String(PORT),
    }), stdio: ['ignore', 'ignore', 'pipe'],
  });
  let bridgeErr = '';
  bridge.stderr.on('data', (c) => { bridgeErr += c; });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { await new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: PORT, path: '/api/health' }, (r) => { r.resume(); r.on('end', res); }).on('error', rej); }); up = true; break; } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('bridge never came up\n' + bridgeErr.slice(-400));

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-pet-b-'));
  const WS = require('./ws-min.js');
  const launched = WS.launchBrowser(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--window-size=1280,800', '--user-data-dir=' + userDir, 'about:blank']);
  const child = launched.child;
  cleanupBrowser = () => { try { child.kill(); } catch { /* gone */ } try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ } };
  process.on('exit', cleanupBrowser);
  let DBG = 0; try { DBG = await launched.port; } catch (e) { fail(e.message); }
  let page = null;
  for (let i = 0; i < 100; i++) {
    try { const list = await new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: DBG, path: '/json/list' }, (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej); }); page = (list || []).find((t) => t.type === 'page'); if (page) break; } catch { /* not ready */ }
    await sleep(150);
  }
  if (!page) fail('browser never exposed a page');
  const ws = new WS(page.webSocketDebuggerUrl); await ws.open();
  let id = 0; const pending = new Map(); const problems = [];
  ws.onmessage = (raw) => { let m; try { m = JSON.parse(raw); } catch { return; } if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; } if (m.method === 'Runtime.exceptionThrown') { const e = m.params.exceptionDetails || {}; problems.push(((e.exception && (e.exception.description || e.exception.value)) || e.text || '?')); } };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw'); return r.result && r.result.result ? r.result.result.value : undefined; };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 160; i++) {
    if (await evalJs("typeof openSettings === 'function' && typeof petSetState === 'function' ? 1 : 0")) break;
    await sleep(250);
  }

  const out = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const res = {};
    openSettings();
    const funTab = document.querySelector('#settings-tabs .tab[data-tab="fun"]');
    if (funTab) funTab.click();
    await new Promise((r) => setTimeout(r, 300));
    res.funTab = !!funTab;
    res.funPanel = !document.getElementById('tab-fun').classList.contains('hidden');
    res.gamerInFun = !!(document.getElementById('set-gamer') || {}).closest && document.getElementById('set-gamer').closest('#tab-fun') != null;
    res.confettiInFun = !!(document.getElementById('set-party-confetti') || {}).closest && document.getElementById('set-party-confetti').closest('#tab-fun') != null;
    res.petControl = !!document.getElementById('set-pet-enabled');
    res.helpTip = !!document.querySelector('#label-pet-enabled .help-tip');
    res.toggleText = document.querySelector('#set-pet-enabled')?.closest('label')?.textContent || '';
    res.optionsHiddenBefore = [...document.querySelectorAll('[data-pet-option]')].every((e) => e.classList.contains('hidden'));
    res.hiddenBefore = document.getElementById('pet-overlay') ? document.getElementById('pet-overlay').classList.contains('hidden') : true;
    const box = document.getElementById('set-pet-enabled');
    /* Stub the bridge endpoints so the browser check can exercise the library
     * and download flow without reaching petdex.dev. */
    const realFetch = window.fetch;
    // A tiny 8-column sprite whose first row has ink in only 6 frames. This
    // catches the DeepSeek pet's blank trailing cells, which made it flicker.
    const sheet = document.createElement('canvas');
    sheet.width = 64; sheet.height = 9;
    const sg = sheet.getContext('2d');
    sg.fillStyle = '#4d6bfe';
    for (let i = 0; i < 6; i++) sg.fillRect(i * 8, 0, 8, 1);
    const demoUrl = sheet.toDataURL('image/png');
    const installed = [
      { slug: 'demo-pet', name: 'Demo Pet', description: 'a downloaded pet', url: demoUrl, spriteVersionNumber: 1 },
    ];
    window.fetch = (u, o) => {
      const url = String(u);
      if (url.includes('/api/pets/download')) {
        installed.push({ slug: 'new-pet', name: 'New Pet', description: 'freshly downloaded', url: '/api/pet-file?name=new.webp', spriteVersionNumber: 2 });
        return Promise.resolve(new Response(JSON.stringify({ ok: true, pet: installed[installed.length - 1] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/api/pets')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, pets: installed }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/api/petdex-search')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, pets: [
          { slug: 'new-pet', displayName: 'New Pet', description: 'freshly downloaded', spritesheetPath: 'https://assets.petdex.dev/new.webp', spriteVersionNumber: 2 },
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return realFetch(u, o);
    };
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    res.optionsVisible = [...document.querySelectorAll('[data-pet-option]')].every((e) => !e.classList.contains('hidden'));
    const pet = document.getElementById('pet-overlay');
    res.visible = !!pet && !pet.classList.contains('hidden');
    res.state = pet && pet.dataset.state;
    res.width = pet ? getComputedStyle(pet).width : null;
    res.hasSvg = !!pet && !!pet.querySelector('svg');
    // Clicking should produce a transient bubble; dragging should persist a position.
    if (pet) {
      const r = pet.getBoundingClientRect();
      pet.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, clientX: r.left + 20, clientY: r.top + 20, button: 0 }));
      pet.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, clientX: r.left + 20, clientY: r.top + 20, button: 0 }));
    }
    await new Promise((r) => setTimeout(r, 80));
    res.clickState = pet && pet.dataset.state;
    res.clickBubble = pet && pet.querySelector('.pet-bubble') && pet.querySelector('.pet-bubble').textContent;
    petSetState('inferring');
    res.agentState = pet && pet.dataset.state;
    await loadPetLibrary(true);
    res.libraryOptions = [...document.getElementById('set-pet-skin').options].map((o) => o.value);
    petSetState('idle'); // the synthetic 6-frame row is the idle row
    const skin = document.getElementById('set-pet-skin');
    skin.value = 'demo-pet';
    skin.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    res.spriteKind = pet && pet.dataset.kind;
    res.hasSprite = !!pet && !!pet.querySelector('.pet-sprite');
    res.spriteFrames = pet && pet.querySelector('.pet-sprite') && pet.querySelector('.pet-sprite').dataset.frameCounts;
    res.spriteBg1 = pet && pet.querySelector('.pet-sprite') && pet.querySelector('.pet-sprite').style.backgroundPosition;
    await new Promise((r) => setTimeout(r, 260));
    res.spriteBg2 = pet && pet.querySelector('.pet-sprite') && pet.querySelector('.pet-sprite').style.backgroundPosition;
    res.downloadedBubble = petBubbleForState();
    document.getElementById('pet-search').value = 'new';
    document.getElementById('btn-pet-search').click();
    await new Promise((r) => setTimeout(r, 200));
    res.searchNames = [...document.querySelectorAll('#pet-results .pet-result-name')].map((n) => n.textContent);
    const dlbtn = [...document.querySelectorAll('#pet-results .pet-result button')].find((b) => b.textContent === 'download');
    if (dlbtn) dlbtn.click();
    await new Promise((r) => setTimeout(r, 300));
    res.afterDownloadSkin = document.getElementById('set-pet-skin').value;
    res.afterDownloadKind = pet && pet.dataset.kind;
    window.fetch = realFetch;
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    res.hiddenAfter = pet && pet.classList.contains('hidden');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    res.reenabledSprite = pet && pet.dataset.kind === 'sprite' && !!pet.querySelector('.pet-sprite');
    res.reenabledAnimated = typeof petSpriteTimer !== 'undefined' && !!petSpriteTimer;
    // Switching must still work while the agent is producing a turn.
    await rpc({ type: 'prompt', message: 'A longer mock answer so the pet switch happens mid-run. '.repeat(12) });
    await new Promise((r) => setTimeout(r, 80));
    res.busy = !!S.isStreaming;
    const skinBusy = document.getElementById('set-pet-skin');
    skinBusy.value = 'demo-pet';
    skinBusy.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    res.busySlug = SET.petSlug;
    res.busyKind = pet && pet.dataset.kind;
    const settledAt = Date.now();
    while (S.isStreaming && Date.now() - settledAt < 6000) await new Promise((r) => setTimeout(r, 100));
    document.querySelectorAll('dialog[open]').forEach((d) => { try { d.close(); } catch { /* already closed */ } });
    petCancelWander();
    petSetState('idle');
    const realRandom = Math.random;
    Math.random = () => 0.1;
    const before = pet.getBoundingClientRect().left;
    petWander();
    await new Promise((r) => setTimeout(r, 120));
    res.wanderState = pet.dataset.state;
    res.wandering = pet.classList.contains('wandering');
    res.wanderMoved = Math.abs(pet.getBoundingClientRect().left - before) > 1;
    Math.random = realRandom;
    petCancelWander();
    petScheduleWander(60000);
    return res;
  })()))()`));

  if (!out.funTab || !out.funPanel) fail('the Fun tab or its panel is missing');
  if (!out.gamerInFun) fail('gamer mode is not in the Fun tab');
  if (!out.confettiInFun) fail('confetti is not in the Fun tab');
  if (!out.petControl) fail('the desktop-pet control is missing from Fun');
  if (!out.helpTip) fail('the pet help icon is not attached to the Desktop pet label');
  if (!/desktop pet/i.test(out.toggleText) || /whale/i.test(out.toggleText)) fail('the pet toggle copy still claims it is only a whale: ' + JSON.stringify(out.toggleText));
  if (!out.optionsHiddenBefore) fail('the pet settings are visible while the pet is switched off');
  if (!out.optionsVisible) fail('the pet settings did not appear when the pet was switched on');
  if (!out.hiddenBefore) fail('the pet is visible before it is enabled');
  if (!out.visible || !out.hasSvg) fail('enabling the pet did not create the whale overlay: ' + JSON.stringify(out));
  if (out.width !== '96px') fail('the default pet size is not 96px: ' + JSON.stringify(out.width));
  if (out.state !== 'idle') fail('the new pet did not start idle: ' + JSON.stringify(out.state));
  if (out.clickState !== 'click' || !out.clickBubble) fail('clicking the pet did not show a reaction: ' + JSON.stringify(out));
  if (out.agentState !== 'inferring') fail('the pet did not follow the agent state: ' + JSON.stringify(out.agentState));
  if (!out.libraryOptions || !out.libraryOptions.includes('demo-pet')) fail('the downloaded library did not populate the pet picker: ' + JSON.stringify(out.libraryOptions));
  if (out.spriteKind !== 'sprite' || !out.hasSprite) fail('selecting a downloaded Petdex sprite did not replace the built-in whale: ' + JSON.stringify(out));
  if (!out.spriteFrames || out.spriteFrames.split(',')[0] !== '6') fail('the sprite did not measure the blank trailing frames: ' + JSON.stringify(out.spriteFrames));
  if (out.downloadedBubble) fail('a downloaded pet still shows the built-in whale speech bubble: ' + JSON.stringify(out.downloadedBubble));
  // Frames are whole-cell pixel offsets now (issue #278); a percentage was
  // resolved in floats and could sample a sliver of the neighbouring frame.
  const bgPos = (s) => {
    const m = /^(-?\d+(?:\.\d+)?)px (-?\d+(?:\.\d+)?)px$/.exec(String(s || ''));
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  };
  const b1 = bgPos(out.spriteBg1);
  const b2 = bgPos(out.spriteBg2);
  if (!b1 || !b2 || b1.x > 0 || b2.x > 0 || b1.x === b2.x) fail('the sprite is not moving through whole-cell pixel positions: ' + JSON.stringify({ a: out.spriteBg1, b: out.spriteBg2 }));
  if (!out.searchNames || !out.searchNames.includes('New Pet')) fail('the Petdex search results did not render: ' + JSON.stringify(out.searchNames));
  if (out.afterDownloadSkin !== 'new-pet' || out.afterDownloadKind !== 'sprite') fail('downloading a pet did not select its sprite: ' + JSON.stringify(out));
  if (!out.hiddenAfter) fail('disabling the pet did not hide it');
  if (!out.reenabledSprite || !out.reenabledAnimated) fail('re-enabling a downloaded sprite did not restart its animation: ' + JSON.stringify(out));
  if (!out.busy) fail('the mock turn did not start; the busy switch case was not exercised');
  if (out.busySlug !== 'demo-pet' || out.busyKind !== 'sprite') fail('the pet could not be switched while the agent was running: ' + JSON.stringify(out));
  if (!out.wandering || !/^run-/.test(out.wanderState || '') || !out.wanderMoved) fail('the pet did not start a wandering run: ' + JSON.stringify(out));
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));
  console.log(`  Fun: gamer/confetti/pet controls; whale ${out.width}, click state ${out.clickState}, agent state ${out.agentState}`);
  console.log('  PASS #267 the Fun tab and the DeepSeek desk pet are wired up');
  cleanupBrowser(); cleanup(); process.exit(0);
})().catch((e) => { cleanupBrowser(); cleanup(); fail(e && e.stack ? e.stack : String(e)); });
