/*
 * Issue #51: "After typing '/' into the chat the menu pops out, it would be really
 * nice if when you clicked anywhere else that menu would close (and reopen once you
 * start typing (when that setting is enabled) or click back in)".
 *
 * The menu is appended to <body> rather than into the composer - deliberately, it
 * spans the whole row - so nothing in the composer's own handlers ever sees a click
 * elsewhere on the page. It closed on Escape and on the text changing, because those
 * go through closeSlashMenu() and updateSlashMenu(), and on nothing else.
 *
 * Closing must not mean disabling: updateSlashMenu() decides whether the menu belongs
 * from the text and the caret, so using the box again has to bring it back. That is
 * the second half of the request and is checked here too.
 *
 * Usage: node test-slash-menu.js <baseUrl> <browserPath>
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
if (!base) { console.error('usage: node test-slash-menu.js <baseUrl> <browserPath>'); process.exit(2); }
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const PORT = 9916 + (process.pid % 9);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-slash-'));
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

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: base + '/' });
  await sleep(3000);
  for (let i = 0; i < 60; i++) {
    if (await evalJs("typeof updateSlashMenu === 'function' && typeof closeSlashMenu === 'function' ? 1 : 0")) break;
    await sleep(250);
  }

  /* `slash` is declared with `let` at the top of app.js, so it is a script-scoped
   * binding and NOT a property of window - window.slash is always undefined. Reading
   * it by name works because this runs in the page's own global scope. */
  const state = () => evalJs(`JSON.stringify({ open: !!(typeof slash !== 'undefined' && slash.open && slash.menu && slash.menu.isConnected), menus: document.querySelectorAll('.slash-menu').length })`);
  const act = async (body) => {
    await evalJs(`(async () => { ${body} await new Promise((r) => setTimeout(r, 80)); return true; })()`);
    return JSON.parse(await state());
  };
  const typeSlash = () => `input.focus(); input.value = '/'; input.setSelectionRange(1, 1); input.dispatchEvent(new Event('input', { bubbles: true }));`;
  const press = (sel) => `{ const el = document.querySelector(${JSON.stringify(sel)}); const r = el ? el.getBoundingClientRect() : null;
    (el || document.body).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: r ? r.left + 4 : 4, clientY: r ? r.top + 4 : 4 })); }`;

  let s = await act(typeSlash());
  console.log(`  typed "/"                    : open=${s.open} menus=${s.menus}`);
  if (!s.open) fail('the slash menu did not open on "/" at all, so nothing below means anything');

  s = await act(press('#chat'));
  console.log(`  then clicked the transcript  : open=${s.open} menus=${s.menus}`);
  if (s.open || s.menus) fail('clicking elsewhere on the page left the menu open - that is issue #51');

  s = await act(`input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); input.dispatchEvent(new MouseEvent('click', { bubbles: true }));`);
  console.log(`  then clicked back into the box: open=${s.open} menus=${s.menus}`);
  if (!s.open) fail('using the box again did not bring the menu back - closing it is not meant to disable it');
  ok('#51 an outside click closes the menu, and using the box again brings it back');

  // A click on another control in the composer closes it too.
  s = await act(press('#btn-send'));
  if (s.open || s.menus) fail('clicking the send button left the menu open');
  // ...and a press INSIDE the menu must not tear the row out before it is picked.
  await act(typeSlash());
  const inside = JSON.parse(await evalJs(`(() => {
    const row = document.querySelector('.slash-menu > *');
    if (!row) return JSON.stringify({ noRow: true });
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    return JSON.stringify({ stillThere: !!document.querySelector('.slash-menu'), rows: document.querySelectorAll('.slash-menu > *').length });
  })()`));
  if (inside.noRow) fail('the menu opened with no rows in it');
  if (!inside.stillThere) fail('a press inside the menu removed it, so the row could never be picked');
  ok('#51 pressing a row does not remove the menu before the press is handled');

  // Escape still works, and a rebuilt menu still reflects the text.
  s = await act(`document.getElementById('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
  if (s.open) fail('Escape no longer closes the menu');
  s = await act(`input.value = '/zzz-nothing-matches-this'; input.setSelectionRange(input.value.length, input.value.length); input.dispatchEvent(new Event('input', { bubbles: true }));`);
  if (s.open) fail('a query that matches no command still shows the menu');
  ok('#51 Escape still closes it, and a query with no matches shows nothing');

  if (problems.length) fail(problems.slice(0, 3).join(' | '));
  ws.close(); cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
