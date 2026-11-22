/*
 * Issue #201: the emoji / image requests from the screenshot.
 *
 *  - emoji get an emoji font in the stack, so a theme font without a colour
 *    emoji glyph does not render them as monochrome text;
 *  - a reply containing 🎉/🥳 gets one short confetti burst, unless the setting
 *    is off or the reader prefers reduced motion;
 *  - "block images" hides pictures in chat and shows a placeholder instead,
 *    both for a message image and for a picture in a tool result.
 *
 * Uses the suite's shared page (no own bridge); it renders messages through the
 * real renderers and checks the DOM the page would show.
 *
 * Usage: node test-emoji-images.js <baseUrl> <browserPath>
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
if (!base) { console.error('usage: node test-emoji-images.js <baseUrl> <browserPath>'); process.exit(2); }
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const PORT = 9630 + (process.pid % 200);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-emoji-'));
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
  await send('Page.navigate', { url: base + '/' });
  for (let i = 0; i < 120; i++) {
    // app.js is a separate script and defines SET/S last: without waiting for
    // them the scenario below can run against a page that has the renderers but
    // no state yet ("SET is not defined").
    if (await evalJs("typeof SET !== 'undefined' && typeof S !== 'undefined' && typeof renderAssistantMessage === 'function' && typeof renderUserMessage === 'function' && typeof maybeCelebrate === 'function' ? 1 : 0")) break;
    await sleep(250);
  }
  await evalJs("document.querySelectorAll('dialog[open]').forEach((d) => { try { d.close(); } catch {} }); document.querySelectorAll('.party-layer').forEach((n) => n.remove()); true");

  const out = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const font = getComputedStyle(document.body).fontFamily;
    const img = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==';
    const stackOf = (el) => (el && getComputedStyle(el).fontFamily) || '';

    /* Issue #201 is about emojis in the AI's own output, so the stacks that
     * matter are the transcript's: #chat and the .md block inside a bubble. A
     * fallback only on <body> is invisible here, because #chat sets
     * font-family: var(--chat-font) itself. */
    renderAssistantMessage({ role: 'assistant', provider: 'mock', model: 'mock-large', stopReason: 'stop', timestamp: 111222337, content: [{ type: 'text', text: 'An emoji in the answer 🎉 and a second one 🥳' }] });
    // a busy page can take a beat to paint the bubble; poll rather than assume
    let mdEl = null;
    for (let i = 0; i < 40 && !mdEl; i++) {
      mdEl = [...document.querySelectorAll('#chat .msg.assistant .md')].pop() || null;
      if (!mdEl) await wait(50);
    }
    const stacks = {
      body: stackOf(document.body),
      chat: stackOf(document.getElementById('chat')),
      md: stackOf(mdEl),
    };
    // ...and a chosen chat font must not drop it
    const prevFont = SET.fontFamily;
    SET.fontFamily = 'Georgia';
    applySettings();
    const customChat = stackOf(document.getElementById('chat'));
    SET.fontFamily = prevFont;
    applySettings();


    SET.partyConfetti = true;
    partySeen.clear();
    document.querySelectorAll('.party-layer').forEach((n) => n.remove());
    const msg = { role: 'assistant', timestamp: 111222333, content: [{ type: 'text', text: 'Party time 🎉' }] };
    renderAssistantMessage(msg);
    await wait(80);
    const confettiOn = !!document.querySelector('.party-layer');
    document.querySelectorAll('.party-layer').forEach((n) => n.remove());

    SET.partyConfetti = false;
    partySeen.clear();
    renderAssistantMessage({ role: 'assistant', timestamp: 111222334, content: [{ type: 'text', text: 'Party time again 🎉' }] });
    await wait(80);
    const confettiOff = !!document.querySelector('.party-layer');
    SET.partyConfetti = true;

    /* Issue #214: blocking images is pi's own setting now. The page has no
     * toggle of its own, and pictures always render whatever that setting says. */
    const ownToggle = !!document.getElementById('set-block-images');
    const piToggle = !!document.getElementById('set-pi-block-images');
    renderUserMessage({ role: 'user', timestamp: 111222336, content: [{ type: 'image', mimeType: 'image/png', data: img }] });
    const allowedMsg = !!document.querySelector('.msg.user .msg-img');
    const box = document.createElement('div');
    fillToolResultBody(box, { content: [{ type: 'image', mimeType: 'image/png', data: img }] });
    const allowedChip = !!box.querySelector('.img-chip');
    return { font, reduced, confettiOn, confettiOff, ownToggle, piToggle, allowedMsg, allowedChip, stacks, customChat };
  })()))()`));

  const EMOJI = /Segoe UI Emoji|Apple Color Emoji|Noto Color Emoji/i;
  if (!EMOJI.test(out.font)) fail('the page font stack has no emoji family: ' + out.font);
  for (const [where, stack] of Object.entries(out.stacks)) {
    if (!EMOJI.test(stack)) fail(`the ${where} font stack has no emoji family, so AI output renders emoji from the text font: ${stack}`);
  }
  if (!/georgia/i.test(out.customChat)) fail('setting a chat font did not reach #chat: ' + out.customChat);
  if (!EMOJI.test(out.customChat)) fail('a chosen chat font dropped the emoji fallback: ' + out.customChat);
  if (!out.reduced && !out.confettiOn) fail('a 🎉 reply did not create the confetti layer');
  if (out.confettiOff) fail('confetti fired with the setting off');
  if (out.ownToggle) fail("the WebUI still has its own block-images toggle (issue #214: it is pi's setting now)");
  if (!out.piToggle) fail("pi's image setting has no row in the settings dialog");
  if (!out.allowedMsg) fail('a user image does not render');
  if (!out.allowedChip) fail('a tool-result image does not render');
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));

  console.log(`  emoji stacks: chat=${out.stacks.chat.slice(-70)} | md ok, custom font keeps it; confetti=${out.confettiOn} (reduced motion=${out.reduced}); images render, blocking is pi's setting`);
  console.log('  PASS #201/#214 emoji keep their colour in the transcript, and pi owns image blocking');
  ws.close(); cleanup(); process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
