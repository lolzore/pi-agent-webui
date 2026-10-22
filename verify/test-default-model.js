/*
 * Issue #176: a default model - the one a *new* chat starts on.
 *
 * The picker's choice is per session, so a fresh chat used to begin on whatever
 * the last switch happened to be. The setting is opt-in: the empty value means
 * "same as the last used model" and changes nothing.
 *
 * Usage: node test-default-model.js <browserPath>
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
const PORT = 27900 + (process.pid % 200);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-defaultmodel-'));
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
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-defaultmodel-b-'));
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
    if (await evalJs("typeof applyDefaultModel === 'function' && typeof populateDefaultModelSelect === 'function' && typeof S === 'object' && (S.historyRender || 0) > 0 ? 1 : 0")) break;
    await sleep(250);
  }
  const out = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const res = {};
    const sel = document.getElementById('model-select');
    sel.replaceChildren();
    for (const v of ['openai||gpt-5', 'llama-server=http://127.0.0.1:8080||gemma-3-12b']) {
      const o = document.createElement('option'); o.value = v; o.textContent = v.split('||')[1]; sel.appendChild(o);
    }
    openSettings();
    await new Promise((r) => setTimeout(r, 300));
    const d = document.getElementById('set-default-model');
    res.exists = !!d;
    res.options = [...d.options].map((o) => o.value);
    res.labels = [...d.options].map((o) => o.textContent);
    // choose one, and make sure it is saved
    d.value = 'openai||gpt-5';
    d.dispatchEvent(new Event('change', { bubbles: true }));
    res.saved = SET.defaultModel;
    // a new chat must switch to it
    const real = window.rpc;
    window.__rpc = [];
    window.rpc = (m) => { window.__rpc.push(m && m.type); return Promise.resolve({}); };
    document.getElementById('btn-new-session').click();
    await new Promise((r) => setTimeout(r, 400));
    res.rpcs = window.__rpc.slice();
    window.rpc = real;
    // ...and "same as last used" applies nothing
    window.__rpc = [];
    window.rpc = (m) => { window.__rpc.push(m && m.type); return Promise.resolve({}); };
    d.value = '';
    d.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('btn-new-session').click();
    await new Promise((r) => setTimeout(r, 400));
    res.rpcsOff = window.__rpc.slice();
    window.rpc = real;
    return res;
  })()))()`));
  if (!out.exists) fail('there is no default model setting');
  if (!out.options.includes('')) fail('the setting has no "same as last used" choice: ' + JSON.stringify(out.options));
  if (!out.options.includes('openai||gpt-5')) fail('the models are not offered: ' + JSON.stringify(out.options));
  if (!out.options.includes('llama-server=http://127.0.0.1:8080||gemma-3-12b')) fail('the llama-server models are missing: ' + JSON.stringify(out.options));
  if (out.saved !== 'openai||gpt-5') fail('choosing a default did not save it: ' + JSON.stringify(out.saved));
  if (!out.rpcs.includes('new_session')) fail('the new-session button did not start a session: ' + JSON.stringify(out.rpcs));
  if (!out.rpcs.includes('set_model')) fail('a new chat did not switch to the default model: ' + JSON.stringify(out.rpcs));
  if (out.rpcsOff.includes('set_model')) fail('"same as last used" still forced a model: ' + JSON.stringify(out.rpcsOff));
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));
  console.log(`  choices: ${out.labels.join(' | ')}`);
  console.log(`  new chat rpcs with a default: ${out.rpcs.join(', ')}; without: ${out.rpcsOff.join(', ')}`);
  console.log('  PASS #176 a new chat starts on the default model, and nothing changes when unset');
  cleanupBrowser(); cleanup(); process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
