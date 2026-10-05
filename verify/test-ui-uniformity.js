/*
 * Regression tests for two reported UI issues, both asserted against the live
 * page rather than by reading the code.
 *
 * #35 - the settings dialog resized with every tab, because it was sized by its
 *       content and the tabs hold very different amounts of it. Asserted: the
 *       dialog and its Done button are in the same place on every tab, and the
 *       strip that varies is the panel, which scrolls.
 *
 * #36 - with tool calls hidden, the narration that precedes a call was left
 *       behind: text about a card the reader cannot see, which pi emits before
 *       most calls. Asserted: with the setting off, an assistant message of
 *       narration + toolCall is not shown; with it on, both are.
 *
 * Usage: node test-ui-uniformity.js <baseUrl> <browserPath>
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
if (!base) { console.error('usage: node test-ui-uniformity.js <baseUrl> <browserPath>'); process.exit(2); }
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const PORT = 9920 + (process.pid % 70);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-ui-'));
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
      problems.push('uncaught: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text || '?'));
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
  await sleep(1500);
  for (let i = 0; i < 80; i++) {
    const ready = await evalJs("typeof renderAssistantMessage === 'function' && document.querySelector('#settings-dialog') ? 1 : 0");
    if (ready) break;
    await sleep(250);
  }

  // ── #35 ────────────────────────────────────────────────────────────────
  const geo = await evalJs(`(async () => {
    const dlg = document.getElementById('settings-dialog');
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    await new Promise((r) => requestAnimationFrame(r));
    const tabs = [...document.querySelectorAll('#settings-tabs .tab')];
    const out = [];
    for (const t of tabs) {
      t.click();
      await new Promise((r) => requestAnimationFrame(r));
      const d = document.getElementById('settings-dialog').getBoundingClientRect();
      const done = document.getElementById('settings-close').getBoundingClientRect();
      const panel = document.querySelector('.tab-panel:not(.hidden)');
      const pr = panel ? panel.getBoundingClientRect() : null;
      out.push({
        tab: t.dataset.tab || t.textContent.trim(),
        dh: +d.height.toFixed(1), dy: +d.top.toFixed(1),
        doneY: +done.top.toFixed(1),
        panelH: pr ? +pr.height.toFixed(1) : null,
        scrolls: panel ? (panel.scrollHeight > panel.clientHeight + 1) : false,
      });
    }
    document.getElementById('settings-dialog').close();
    return JSON.stringify(out);
  })()`);
  const g = JSON.parse(geo);
  const heights = [...new Set(g.map((x) => x.dh))];
  const doneYs = [...new Set(g.map((x) => x.doneY))];
  console.log('  #35 dialog height per tab : ' + g.map((x) => `${x.tab}=${x.dh}`).join('  '));
  if (heights.length !== 1) fail(`#35 the dialog is ${heights.length} different heights across tabs: ${JSON.stringify(heights)}`);
  if (doneYs.length !== 1) fail(`#35 the Done button moves between tabs: ${JSON.stringify(doneYs)}`);
  if (!g.every((x) => x.panelH > 200)) fail(`#35 a tab panel has almost no height: ${JSON.stringify(g.map((x) => [x.tab, x.panelH]))}`);
  console.log(`  PASS #35 one dialog height (${heights[0]}px) and a fixed Done button across ${g.length} tabs; the panel is what varies`);
  const scrolling = g.filter((x) => x.scrolls).map((x) => x.tab);
  if (scrolling.length) console.log(`       (scrolling inside the panel: ${scrolling.join(', ')})`);

  // ── #36 ────────────────────────────────────────────────────────────────
  const r36 = await evalJs(`(async () => {
    const msg = { role: 'assistant', timestamp: Date.now(), content: [
      { type: 'text', text: 'Let me check that file for you.' },
      { type: 'toolCall', id: 'tc-verify-1', name: 'read', arguments: { path: '/tmp/x' } },
    ] };
    const before = SET.showToolCalls;
    // off: the narration should not be drawn
    SET.showToolCalls = false;
    document.getElementById('chat').innerHTML = '';
    renderAssistantMessage(msg);
    markHollowMessages();
    const hiddenRow = document.querySelector('#chat .msg.assistant');
    const offVisible = hiddenRow ? !hiddenRow.hasAttribute('data-hollow') : false;
    const offText = [...document.querySelectorAll('#chat .msg.assistant .bubble')].map((b) => b.textContent).join(' ').trim();

    // on: both the narration and the card should be there
    SET.showToolCalls = true;
    document.getElementById('chat').innerHTML = '';
    renderAssistantMessage(msg);
    markHollowMessages();
    const onRow = document.querySelector('#chat .msg.assistant');
    const onVisible = onRow ? !onRow.hasAttribute('data-hollow') : false;
    const onText = [...document.querySelectorAll('#chat .msg.assistant .bubble')].map((b) => b.textContent).join(' ').trim();
    const onHasCard = !!document.querySelector('#chat .tool-card');

    SET.showToolCalls = before;
    document.getElementById('chat').innerHTML = '';
    return JSON.stringify({ offVisible, offText, onVisible, onText, onHasCard });
  })()`);
  const s = JSON.parse(r36);
  console.log(`  #36 tools off -> message shown: ${s.offVisible}  text: ${JSON.stringify(s.offText)}`);
  console.log(`  #36 tools on  -> message shown: ${s.onVisible}  card: ${s.onHasCard}  text: ${JSON.stringify(s.onText.slice(0, 44))}`);
  if (s.offVisible) fail('#36 narration before a tool call is still visible with tool calls hidden');
  if (!s.onVisible) fail('#36 the message is hidden even with tool calls shown');
  if (!s.onHasCard) fail('#36 the tool card is missing with tool calls shown');
  if (!/Let me check that file/.test(s.onText)) fail('#36 the narration is missing with tool calls shown');
  console.log('  PASS #36 narration hidden with the tool calls, kept when they are shown');

  if (problems.length) fail(problems.slice(0, 3).join(' | '));
  ws.close(); cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
