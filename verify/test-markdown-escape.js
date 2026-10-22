/*
 * A message must never put real HTML into the page.
 *
 * The markdown renderer escaped paragraphs but handed *raw* text to the inline
 * renderer for list items, headings, quotes and table cells. One message in this
 * session carried `<base href="about:srcdoc">` in a bullet, so the page grew a
 * real <base>: every relative URL stopped resolving, the liveness heartbeat's
 * fetch of /api/health failed, the page closed its own socket and re-read the
 * whole transcript - every 25 seconds, forever.
 *
 * This checks the renderer and the page: no element may appear from message
 * text, and the document's base must not change.
 *
 * Usage: node test-markdown-escape.js <browserPath>
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
const PORT = 29000 + (process.pid % 200);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-md-'));
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
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'), PI_WEBUI_SOURCE_FILE: path.join(scratch, 'source.txt'),
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
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-md-b-'));
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
    if (await evalJs("typeof renderMarkdown === 'function' && typeof S === 'object' && (S.historyRender || 0) > 0 ? 1 : 0")) break;
    await sleep(250);
  }
  const out = JSON.parse(await evalJs(`(() => {
    const payload = '<base href="about:srcdoc"><iframe src="https://example.com"></iframe><img src=x onerror="window.__pwned=1">';
    const cases = {
      paragraph: renderMarkdown('text ' + payload),
      list: renderMarkdown('- ' + payload),
      ordered: renderMarkdown('1. ' + payload),
      heading: renderMarkdown('## ' + payload),
      quote: renderMarkdown('> ' + payload),
      table: renderMarkdown('| a | b |\\n| --- | --- |\\n| ' + payload + ' | x |'),
      inline: renderMarkdown('text \\u0060' + payload + '\\u0060 text'),
    };
    const host = document.createElement('div');
    const before = document.baseURI;
    const raw = {};
    for (const [k, v] of Object.entries(cases)) {
      host.innerHTML = v;
      raw[k] = {
        base: !!host.querySelector('base'),
        iframe: !!host.querySelector('iframe'),
        img: !!host.querySelector('img'),
        text: host.textContent.includes('<base'),
      };
      host.replaceChildren();
    }
    // A newline in a paragraph must be a real line break, not the text "<br>".
    // The renderer used to join raw lines with '<br>' and then escape the
    // result, so multi-line messages showed a literal tag.
    const brHost = document.createElement('div');
    brHost.innerHTML = renderMarkdown(['first line','second line','.','fourth line'].join(String.fromCharCode(10)));
    const br = {
      count: brHost.querySelectorAll('br').length,
      literal: /<br>/.test(brHost.textContent),
      text: brHost.textContent,
    };
    return JSON.stringify({
      raw,
      br,
      baseUnchanged: document.baseURI === before,
      docBase: document.baseURI,
      pwned: !!window.__pwned,
      // the escaped text is still shown to the reader
      showsText: /&lt;base/.test(cases.list) && /&lt;base/.test(cases.paragraph),
    });
  })()`));
  const bad = Object.entries(out.raw).filter(([, v]) => v.base || v.iframe || v.img);
  if (bad.length) fail('message text became real HTML in: ' + JSON.stringify(bad));
  if (!out.baseUnchanged) fail('rendering a message changed the document base: ' + out.docBase);
  if (out.pwned) fail('an onerror attribute executed');
  if (!out.showsText) fail('the text is not shown to the reader at all (escaped twice?)');
  if (out.br.count !== 3) fail(`a four-line paragraph rendered ${out.br.count} line break(s), expected 3`);
  if (out.br.literal) fail('a line break was shown to the reader as the literal text "<br>"');
  if (!out.br.text.includes('first line') || !out.br.text.includes('fourth line')) {
    fail('the lines around a line break disappeared: ' + JSON.stringify(out.br.text));
  }
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));
  console.log(`  html in messages, by place: ${Object.keys(out.raw).join(', ')} - none became an element; base still ${out.docBase}`);
  console.log('  PASS a message can no longer put real HTML into the page');
  cleanupBrowser(); cleanup(); process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
