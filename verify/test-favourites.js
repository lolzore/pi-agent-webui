/*
 * Issue #61: "Ability to select a favourite model."
 *
 * The model picker is rebuilt from <select> on every refresh, so a favourite
 * has to survive that: the star lives in the row, the keys live in the WebUI
 * settings (localStorage + the bridge's copy), and the favourites get their
 * own group at the top of the picker - including one whose model is no longer
 * reported, so it can still be unstarred.
 *
 * Usage: node test-favourites.js <baseUrl> <browserPath>
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
if (!base) { console.error('usage: node test-favourites.js <baseUrl> <browserPath>'); process.exit(2); }
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const PORT = 9490 + (process.pid % 40);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-favs-'));
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

(async () => {
  let ver = null;
  for (let i = 0; i < 100; i++) { try { ver = await getJson('/json/version'); break; } catch { await sleep(150); } }
  if (!ver) fail('browser never came up\n' + stderr.slice(-400));

  const WS = require('./ws-min.js');
  const page = (await getJson('/json/list')).find((t) => t.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.open();
  let id = 0; const pending = new Map(); const problems = [];
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
  const load = async () => {
    await send('Page.navigate', { url: base + '/' });
    for (let i = 0; i < 100; i++) {
      if (await evalJs("typeof renderModelMenu === 'function' && typeof toggleModelMenu === 'function' ? 1 : 0")) break;
      await sleep(250);
    }
    await evalJs("document.querySelectorAll('dialog[open]').forEach((d) => { try { d.close(); } catch {} })");
    await sleep(600);
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await load();

  /* ── star two models, and check the group, the order and the filter ───── */
  const res = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const out = {};
    settingsLoaded = true;                 // this page owns the settings now
    SET.favouriteModels = [];
    saveSettings();

    // Deterministic rows: the picker is built from the hidden <select>.
    const sel = $('model-select');
    sel.innerHTML = '';
    for (const [v, l] of [['mock-a||model-a', 'Model A'], ['mock-b||model-b', 'Model B'], ['mock-c||model-c', 'Model C']]) {
      const o = el('option', null, l); o.value = v; sel.appendChild(o);
    }
    sel.value = 'mock-c||model-c';

    toggleModelMenu(true);
    const rowFor = (label) => [...$('model-list').querySelectorAll('.model-item:not(.cycle-item)')]
      .find((r) => (r.querySelector('.model-label') || {}).textContent === label);
    const groupTexts = () => [...$('model-list').querySelectorAll('.model-group')].map((g) => g.textContent);
    out.initialGroups = groupTexts();
    out.initialStars = $('model-list').querySelectorAll('.fav-star.on').length;

    // star Model A
    rowFor('Model A').querySelector('.fav-star').click();
    out.afterStarFavs = (SET.favouriteModels || []).slice();
    out.afterStarGroups = groupTexts();
    out.afterStarFirst = [...$('model-list').querySelectorAll('.model-item:not(.cycle-item)')][0].querySelector('.model-label').textContent;
    out.afterStarOn = rowFor('Model A').querySelector('.fav-star').classList.contains('on');
    out.menuOpenAfterStar = !$('model-menu').classList.contains('hidden');
    out.selectUnchangedByStar = sel.value;

    // star Model B: favourites keep the order they were starred in
    rowFor('Model B').querySelector('.fav-star').click();
    out.favOrder = [...$('model-list').querySelectorAll('.model-item:not(.cycle-item)')].slice(0, 2).map((r) => r.querySelector('.model-label').textContent);
    out.starCount = $('model-list').querySelectorAll('.fav-star.on').length;

    // the filter applies to the favourites too
    const search = $('model-search');
    search.value = 'zzz'; search.dispatchEvent(new Event('input', { bubbles: true }));
    out.noMatchText = ($('model-list').querySelector('.model-empty') || {}).textContent || '';
    search.value = 'model a'; search.dispatchEvent(new Event('input', { bubbles: true }));
    out.filtered = [...$('model-list').querySelectorAll('.model-item:not(.cycle-item)')].map((r) => r.querySelector('.model-label').textContent);
    search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true }));

    // a click on the row (not the star) still picks the model and closes the menu
    rowFor('Model A').click();
    out.picked = sel.value;
    out.menuClosedByPick = $('model-menu').classList.contains('hidden');
    return out;
  })()))()`));

  console.log('  groups at first:', JSON.stringify(res.initialGroups), 'stars:', res.initialStars);
  console.log('  after starring A:', JSON.stringify(res.afterStarGroups), res.afterStarFirst, 'on=' + res.afterStarOn, 'favs=' + JSON.stringify(res.afterStarFavs));
  console.log('  favourites order:', JSON.stringify(res.favOrder), 'filtered:', JSON.stringify(res.filtered));

  if (res.initialStars !== 0 || res.initialGroups.some((g) => /favourites/i.test(g))) fail('the picker started with favourites before anything was starred');
  if (!(res.afterStarFavs || []).includes('mock-a||model-a')) fail('starring did not record the model key: ' + JSON.stringify(res.afterStarFavs));
  if (!res.afterStarGroups.some((g) => /^favourites$/i.test(g))) fail('no favourites group after starring: ' + JSON.stringify(res.afterStarGroups));
  if (res.afterStarFirst !== 'Model A') fail('the starred model is not at the top: ' + res.afterStarFirst);
  if (!res.afterStarOn) fail('the star did not light up');
  if (!res.menuOpenAfterStar) fail('starring closed the picker');
  if (res.selectUnchangedByStar !== 'mock-c||model-c') fail('starring selected the model it was supposed to only pin');
  if (JSON.stringify(res.favOrder) !== JSON.stringify(['Model A', 'Model B'])) fail('favourites are not in the order they were starred: ' + JSON.stringify(res.favOrder));
  if (res.starCount !== 2) fail('expected two lit stars, got ' + res.starCount);
  if (!/No model matches/.test(res.noMatchText)) fail('the no-match state is wrong: ' + JSON.stringify(res.noMatchText));
  if (JSON.stringify(res.filtered) !== JSON.stringify(['Model A'])) fail('the filter does not apply to favourites: ' + JSON.stringify(res.filtered));
  if (res.picked !== 'mock-a||model-a') fail('a row click no longer picks the model: ' + res.picked);
  if (!res.menuClosedByPick) fail('picking a model left the picker open');

  /* ── the favourites survive a reload (bridge copy, not just localStorage) ── */
  await sleep(500);      // let the fire-and-forget settings POST land
  await load();
  const after = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && !(Array.isArray(SET.favouriteModels) && SET.favouriteModels.length === 2)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    // this reload's <select> comes from the agent; the keys must still be known
    toggleModelMenu(true);
    const beforeUnstar = (SET.favouriteModels || []).slice();
    const groups = [...$('model-list').querySelectorAll('.model-group')].map((g) => g.textContent);
    const rows = [...$('model-list').querySelectorAll('.model-item:not(.cycle-item)')].map((r) => ({
      label: r.querySelector('.model-label').textContent,
      on: r.querySelector('.fav-star').classList.contains('on'),
      missing: r.classList.contains('missing'),
    }));
    // unstar both, and confirm the setting empties
    for (const b of [...$('model-list').querySelectorAll('.fav-star.on')]) b.click();
    const left = (SET.favouriteModels || []).slice();
    toggleModelMenu(false);
    return { favs: (SET.favouriteModels || []).slice(), beforeUnstar, groups, rows, left };
  })()))()`));
  console.log('  after reload: keys=' + JSON.stringify(after.beforeUnstar) + ' groups=' + JSON.stringify(after.groups) + ' rows=' + JSON.stringify(after.rows.slice(0, 4)));
  console.log('  after unstarring everything: ' + JSON.stringify(after.left));

  if (!(after.groups || []).some((g) => /^favourites$/i.test(g))) fail('no favourites group after a reload: ' + JSON.stringify(after.groups));
  if (JSON.stringify(after.beforeUnstar) !== JSON.stringify(['mock-a||model-a', 'mock-b||model-b'])) {
    // the mock agent renames its model on set_model, so labels are not the key here
    fail('the favourites did not survive the reload intact: ' + JSON.stringify(after.beforeUnstar));
  }
  if ((after.rows || []).filter((r) => r.on).length !== 2) {
    fail('the stars did not survive the reload: ' + JSON.stringify(after.rows));
  }
  if ((after.left || []).length) fail('unstarring everything left keys behind: ' + JSON.stringify(after.left));
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));

  console.log('  PASS #61 a starred model is pinned, survives a reload, and unstars cleanly');
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
