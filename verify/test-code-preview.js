/*
 * Issue #175: an eye on html/svg code blocks that shows what they render -
 * a page in a sandboxed frame, an svg as the picture itself - with a copy
 * button and an X, and for a block the agent is still writing, a preview that
 * keeps up with the code.
 *
 * Usage: node test-code-preview.js <browserPath>
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
const PORT = 28000 + (process.pid % 200);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-codepreview-'));
fs.mkdirSync(path.join(scratch, 'agent'), { recursive: true });
fs.mkdirSync(path.join(scratch, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'webui.json'), JSON.stringify({ onboarded: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bridge = null;
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
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { await new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: PORT, path: '/api/health' }, (r) => { r.resume(); r.on('end', res); }).on('error', rej); }); up = true; break; } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('bridge never came up');
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-codepreview-b-'));
  const launched = require('./ws-min.js').launchBrowser(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--window-size=1280,800', '--user-data-dir=' + userDir, 'about:blank']);
  const child = launched.child;
  const cleanupBrowser = () => { try { child.kill(); } catch { /* gone */ } try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ } };
  process.on('exit', cleanupBrowser);
  let DBG = 0; try { DBG = await launched.port; } catch (e) { fail(e.message); }
  let page = null;
  for (let i = 0; i < 100; i++) {
    try { const list = await new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: DBG, path: '/json/list' }, (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej); }); page = (list || []).find((t) => t.type === 'page'); if (page) break; } catch { /* not ready */ }
    await sleep(150);
  }
  if (!page) fail('browser never exposed a page');
  const WS = require('./ws-min.js');
  const ws = new WS(page.webSocketDebuggerUrl); await ws.open();
  let id = 0; const pending = new Map(); const problems = [];
  ws.onmessage = (raw) => { let m; try { m = JSON.parse(raw); } catch { return; } if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; } if (m.method === 'Runtime.exceptionThrown') { const e = m.params.exceptionDetails || {}; problems.push(((e.exception && (e.exception.description || e.exception.value)) || e.text || '?')); } };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw'); return r.result && r.result.result ? r.result.result.value : undefined; };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 160; i++) {
    if (await evalJs("typeof wireCodePreview === 'function' && typeof startLive === 'function' && typeof S === 'object' && (S.historyRender || 0) > 0 ? 1 : 0")) break;
    await sleep(250);
  }
  const out = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const res = {};
    // a finished message with the three kinds of block
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown('before\\n\\n\`\`\`html\\n<h1>Hello preview</h1>\\n\`\`\`\\n\\n\`\`\`svg\\n<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="red"/></svg>\\n\`\`\`\\n\\n\`\`\`js\\nconst x = 1;\\n\`\`\`\\n\\n\`\`\`xml\\n<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><circle r="3"/></svg>\\n\`\`\`\\n\\n\`\`\`\\n<svg xmlns="http://www.w3.org/2000/svg" width="5" height="5"><rect width="5" height="5"/></svg>\\n\`\`\`\\n');
    document.getElementById('chat').appendChild(host);
    const boxes = [...host.querySelectorAll('.codebox')];
    res.eyes = boxes.map((b) => !!b.querySelector('.code-eye'));
    res.copies = boxes.map((b) => !!b.querySelector('.code-copy'));
    res.langs = boxes.map((b) => b.dataset.lang || null);
    // open the html one
    boxes[0].querySelector('.code-eye').click();
    await new Promise((r) => setTimeout(r, 300));
    const dialog = document.getElementById('code-preview');
    res.open = dialog.open;
    /* And *visible*: a modal dialog that is not rendered still makes the page
     * inert, so "open" is not the question - this is. (The preview used to be
     * nested inside the settings dialog, which is display:none when closed:
     * showModal() worked, nothing appeared, and the page was frozen.) */
    const rect = dialog.getBoundingClientRect();
    res.visible = getComputedStyle(dialog).display !== 'none' && rect.width > 200 && rect.height > 150;
    res.parentIsBody = dialog.parentElement === document.body;
    res.dialogExists = !!dialog;
    res.directOpen = (() => { try { openCodePreview(boxes[0]); return dialog.open; } catch (e) { return 'threw: ' + e.message; } })();
    const frame = dialog.querySelector('iframe.code-preview-frame');
    res.srcdocHasHeading = !!frame && /Hello preview/.test(frame.getAttribute('srcdoc') || '');
    res.frameSandboxed = !!frame && !/allow-same-origin/.test(frame.getAttribute('sandbox') || '');
    const srcdoc = (frame && frame.getAttribute('srcdoc')) || '';
    res.srcdocPinned = /about:srcdoc/.test(srcdoc);
    res.srcdocGuarded = /preventDefault/.test(srcdoc);
    res.title = document.getElementById('code-preview-title').textContent;
    // copy
    let copied = null;
    const realClip = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { copied = t; } }, configurable: true });
    document.getElementById('code-preview-copy').click();
    await new Promise((r) => setTimeout(r, 150));
    res.copied = copied;
    // ...and the block itself has a copy button, next to the eye
    document.getElementById('code-preview-close').click();
    await new Promise((r) => setTimeout(r, 100));
    copied = null;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { copied = t; } }, configurable: true });
    boxes[1].querySelector('.code-copy').click();
    await new Promise((r) => setTimeout(r, 150));
    res.blockCopy = copied;
    Object.defineProperty(navigator, 'clipboard', { value: realClip, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: realClip, configurable: true });
    // close with the X
    document.getElementById('code-preview-close').click();
    await new Promise((r) => setTimeout(r, 100));
    res.closed = !dialog.open;
    // the svg one: the picture itself
    boxes[1].querySelector('.code-eye').click();
    await new Promise((r) => setTimeout(r, 300));
    const img = dialog.querySelector('img.code-preview-svg');
    res.svgEmbedded = !!img && /^data:image\\/svg\\+xml/.test(img.getAttribute('src') || '');
    res.svgTitle = document.getElementById('code-preview-title').textContent;
    document.getElementById('code-preview-close').click();
    await new Promise((r) => setTimeout(r, 100));
    // and a live one: the preview follows the code as it streams
    startLive();
    applyDelta({ type: 'text_delta', delta: '\`\`\`svg\\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' });
    await new Promise((r) => setTimeout(r, 600));
    const liveBox = S.live.root.querySelector('.codebox.viewable');
    res.liveBoxFound = !!liveBox;
    if (liveBox) liveBox.querySelector('.code-eye').click();
    await new Promise((r) => setTimeout(r, 300));
    const liveImg = dialog.querySelector('img.code-preview-svg');
    res.liveBefore = liveImg ? liveImg.getAttribute('src').length : 0;
    /* the code itself grows: the picture has to redraw */
    applyDelta({ type: 'text_delta', delta: '<circle r="4" fill="blue"/><rect width="3" height="3" fill="green"/></svg>\\n\`\`\`\\n' });
    await new Promise((r) => setTimeout(r, 900));
    res.liveAfter = liveImg ? liveImg.getAttribute('src').length : 0;
    res.liveUpdated = res.liveAfter > res.liveBefore;
    res.liveText = (S.live && S.live.root ? S.live.root.textContent : '').slice(-70);
    res.watch = typeof codePreviewWatch === 'object' && codePreviewWatch ? JSON.stringify(codePreviewWatch) : null;
    res.timer = !!codePreviewTimer;
    res.liveBoxes = S.live && S.live.root ? S.live.root.querySelectorAll('.codebox.viewable').length : -1;
    document.getElementById('code-preview-close').click();
    host.remove();
    return res;
  })()))()`));
  if (!out.open && problems.length) fail('the preview threw: ' + problems.join(' | '));
  /* html, svg, js, xml-fenced svg, bare svg */
  if (out.eyes.join(',') !== 'true,true,false,true,true') fail('the eye is not on exactly the html and svg-shaped blocks (whatever the fence said): ' + JSON.stringify(out.eyes));
  if (out.copies.join(',') !== 'true,true,true,true,true') fail('a code block has no copy button: ' + JSON.stringify(out.copies));
  if (!/rect width="40"/.test(out.blockCopy || '')) fail('the block copy button did not copy that block: ' + JSON.stringify((out.blockCopy || '').slice(0, 40)));
  if (!out.srcdocPinned) fail('the preview document is not pinned to itself - a link would load this page into the frame');
  if (!out.srcdocGuarded) fail('the preview document has no click guard');
  if (!out.open) fail('the eye did not open a preview');
  if (!out.visible) fail('the preview is open but not visible (that freezes the page): ' + JSON.stringify({ visible: out.visible, parentIsBody: out.parentIsBody }));
  if (!out.parentIsBody) fail('the preview dialog is not at the body level, so a closed dialog can hide it: ' + JSON.stringify(out.parentIsBody));
  if (!out.srcdocHasHeading) fail('the html preview does not contain the page: ' + JSON.stringify(out));
  if (!out.frameSandboxed) fail('the preview frame is not sandboxed from this origin');
  if (!/html/.test(out.title)) fail('the preview does not say what it is showing: ' + JSON.stringify(out.title));
  if (!/Hello preview/.test(out.copied || '')) fail('copy did not copy the code: ' + JSON.stringify(out.copied));
  if (!out.closed) fail('the X did not close the preview');
  if (!out.svgEmbedded) fail('an svg preview is not embedded as a picture: ' + JSON.stringify(out.svgEmbedded));
  if (!/svg/.test(out.svgTitle)) fail('the svg preview is mislabelled: ' + JSON.stringify(out.svgTitle));
  if (!out.liveBoxFound) fail('the streaming svg block has no eye: ' + JSON.stringify(out));
  if (!out.liveUpdated) fail('the preview did not follow the code while the agent wrote it: ' + JSON.stringify(out));
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));
  console.log(`  blocks: html=${out.eyes[0]} svg=${out.eyes[1]} js=${out.eyes[2]}; sandboxed=${out.frameSandboxed}; copy=${JSON.stringify((out.copied || '').slice(0, 20))}`);
  console.log(`  live svg preview: ${out.liveBefore} -> ${out.liveAfter} chars as the code streamed`);
  console.log('  PASS #175 html and svg blocks can be previewed, copied, closed - and follow live code');
  cleanupBrowser(); cleanup(); process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
