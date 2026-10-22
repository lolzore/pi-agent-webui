/*
 * Issue #174: the llama.cpp extension's models are not offered in the picker
 * any more - only the llama-server ones (the extension the reader runs).
 *
 * The provider is not removed from pi: if you are on a llama.cpp model it
 * stays visible (the menu is also where you see where you are), and everything
 * else in the list is untouched.
 *
 * Usage: node test-model-filter.js <browserPath>
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
const PORT = 27800 + (process.pid % 200);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-modelfilter-'));
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
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-modelfilter-b-'));
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
    if (await evalJs("typeof renderModelMenu === 'function' && typeof S === 'object' && (S.historyRender || 0) > 0 ? 1 : 0")) break;
    await sleep(250);
  }
  const out = JSON.parse(await evalJs(`(() => {
    const sel = document.getElementById('model-select');
    sel.replaceChildren();
    const add = (label, values) => {
      const g = document.createElement('optgroup');
      g.label = label;
      for (const v of values) { const o = document.createElement('option'); o.value = v; o.textContent = v.split('||')[1]; g.appendChild(o); }
      sel.appendChild(g);
    };
    add('llama.cpp', ['llama.cpp||Qwen3-24B', 'llama.cpp||Llama-3.2-3B']);
    add('llama-server', ['llama-server=http://127.0.0.1:8080||gemma-3-12b', 'llama-server=http://127.0.0.1:8080||qwen2.5-coder']);
    add('openai', ['openai||gpt-5', 'openai||gpt-5-mini']);
    const rows = () => [...document.querySelectorAll('#model-list .model-item')].map((r) => r.textContent.trim());
    sel.value = 'openai||gpt-5';
    renderModelMenu('');
    const listed = rows();
    // and when the model you are on *is* a llama.cpp one, it stays visible
    sel.value = 'llama.cpp||Qwen3-24B';
    renderModelMenu('');
    const currentHidden = rows();
    return JSON.stringify({ listed, currentHidden });
  })()`));
  const hasLlamaCpp = out.listed.filter((t) => /llama\.cpp/.test(t));
  if (hasLlamaCpp.length) fail('llama.cpp models are still listed: ' + JSON.stringify(hasLlamaCpp));
  if (!out.listed.some((t) => /gemma-3-12b/.test(t))) fail('the llama-server models are gone too: ' + JSON.stringify(out.listed));
  if (!out.listed.some((t) => /gpt-5/.test(t))) fail('the other providers are gone too: ' + JSON.stringify(out.listed));
  if (!out.currentHidden.some((t) => /Qwen3-24B/.test(t))) fail('the model you are on disappeared from the menu: ' + JSON.stringify(out.currentHidden));
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));
  console.log(`  listed: ${out.listed.join(' | ')}`);
  console.log(`  while on a llama.cpp model: ${out.currentHidden.join(' | ')}`);
  console.log('  PASS #174 llama.cpp models are not offered; llama-server and the rest are');
  cleanupBrowser(); cleanup(); process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
