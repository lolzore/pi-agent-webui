/*
 * Issue #278: "the animation could show the other sprites texture for some
 * frames."
 *
 * The pet used to scale the whole spritesheet with a percentage background-size
 * and percentage background positions. Two things came out of that: the cell was
 * drawn square (192x208 squashed to NxN), and at a fractional size the sampler
 * could reach across a cell boundary, so some frames showed a sliver of the next
 * sprite - a hat tip or a braid from the neighbouring cell.
 *
 * The cell is now drawn at its own 192x208 with width-only sizing and exact
 * pixel offsets, and the layer is zoomed to the chosen pet size. This checks the
 * geometry the fix relies on, on a synthetic 8x9 sheet where every cell is a
 * different flat colour.
 *
 * Usage: node test-pet-frames.js <browserPath>
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
const PORT = 26500 + (process.pid % 300);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-pet-frames-'));
fs.mkdirSync(path.join(scratch, 'agent'), { recursive: true });
fs.mkdirSync(path.join(scratch, 'sessions'), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bridge = null;
const cleanup = () => {
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);

(async () => {
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_DIR: path.join(scratch, 'agent'),
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
  for (let i = 0; i < 100; i++) {
    try {
      await new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port: PORT, path: '/api/health' }, (r) => { r.resume(); r.on('end', res); }).on('error', rej);
      });
      up = true; break;
    } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('the scratch bridge never came up\n' + bridgeErr.slice(-500));

  const WS = require('./ws-min.js');
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-pet-frames-browser-'));
  const launched = WS.launchBrowser(browser, [
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

  const port = await launched.port.catch((e) => fail('browser never reported a debug port\n' + e.message));
  const getJson = (p) => new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: p }, (r) => {
      let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
  let targets = [];
  for (let i = 0; i < 80; i++) {
    try { targets = await getJson('/json/list'); if (targets.length) break; } catch { /* not yet */ }
    await sleep(150);
  }
  const page = targets.find((t) => t.type === 'page');
  if (!page) fail('no page target in the browser\n' + browserErr.slice(-400));

  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.open();
  let id = 0;
  const pending = new Map();
  const problems = [];
  ws.onmessage = (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      problems.push((d.exception && (d.exception.description || d.exception.value)) || d.text || 'exception');
    }
  };
  const send = (method, params) => new Promise((res) => {
    const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw');
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 160; i++) {
    if (await evalJs("typeof applyPetSettings === 'function' && typeof petSetState === 'function' ? 1 : 0")) break;
    await sleep(200);
  }
  await evalJs("(async()=>{ document.querySelectorAll('dialog[open]').forEach((d)=>d.close()); await new Promise((r)=>setTimeout(r,200)); })()");

  const raw = await evalJs(`(async () => {
    const res = {};
    // A canonical 1536x1872 v1 sheet: 8 columns x 9 rows, every cell a different
    // flat colour with a 1px outline. Any bleed from a neighbouring cell would
    // be a clearly different colour.
    const sheet = document.createElement('canvas');
    sheet.width = 1536; sheet.height = 1872;
    const g = sheet.getContext('2d');
    const colors = ['#ff0000','#00ff00','#0000ff','#ffff00','#ff00ff','#00ffff','#ff8000','#8000ff'];
    for (let row = 0; row < 9; row++) {
      for (let col = 0; col < 8; col++) {
        g.fillStyle = colors[(row + col) % colors.length];
        g.fillRect(col * 192, row * 208, 192, 208);
        g.strokeStyle = '#000';
        g.lineWidth = 2;
        g.strokeRect(col * 192 + 1, row * 208 + 1, 190, 206);
      }
    }
    const sheetUrl = sheet.toDataURL('image/png');
    const installed = [{ slug: 'frame-pet', name: 'Frame Pet', description: '', url: sheetUrl, spriteVersionNumber: 1 }];
    const realFetch = window.fetch;
    window.fetch = (u, o) => {
      const url = String(u);
      if (url.includes('/api/pets')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, pets: installed }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return realFetch(u, o);
    };
    SET.petEnabled = true;
    SET.petSlug = 'frame-pet';
    SET.petSize = 160;
    applyPetSettings();
    await loadPetLibrary();
    petSetState('idle');
    await new Promise((r) => setTimeout(r, 600));
    const pet = document.getElementById('pet-overlay');
    const sprite = pet.querySelector('.pet-sprite');
    res.kind = pet.dataset.kind;
    res.rows = sprite && sprite.dataset.rows;
    res.frames = sprite && sprite.dataset.frameCounts;
    res.bgSize = sprite && sprite.style.backgroundSize;
    res.rect = sprite ? (() => { const r = sprite.getBoundingClientRect(); return [r.width, r.height]; })() : null;
    res.zoom = sprite ? getComputedStyle(sprite).zoom : null;
    // Collect what the animation applies for a second: every value must be a
    // whole-cell pixel offset (no percentages, no half-pixel positions).
    const seen = new Set();
    const t0 = Date.now();
    while (Date.now() - t0 < 1300) {
      seen.add(sprite.style.backgroundPosition);
      await new Promise((r) => setTimeout(r, 45));
    }
    res.pos = [...seen];
    return JSON.stringify(res);
  })()`);
  let out;
  try { out = JSON.parse(raw); } catch (e) { fail('the in-page check did not return JSON: ' + String(raw).slice(0, 300)); }

  if (out.kind !== 'sprite' || !out.rows) fail('the downloaded pet did not become a sprite: ' + JSON.stringify(out));
  if (out.rows !== '9') fail('a v1 sheet was read as ' + out.rows + ' rows, expected 9');
  if (out.frames !== '8,8,8,8,8,8,8,8,8') fail('frame measurement changed the synthetic sheet: ' + JSON.stringify(out.frames));
  if (out.bgSize !== '1536px auto') fail('the sheet is not sized width-only (got ' + JSON.stringify(out.bgSize) + '); a forced height squashes/cross-samples the cells');
  if (!out.rect) fail('no sprite box');
  if (Math.abs(out.rect[0] - 160) > 0.6) fail('the pet is ' + out.rect[0] + 'px wide at size 160');
  const aspect = out.rect[1] / out.rect[0];
  if (Math.abs(aspect - 208 / 192) > 0.02) fail('the cell aspect is ' + aspect.toFixed(3) + ', expected 1.083 (192x208), so the art is squashed');
  if (!(Math.abs(Number(out.zoom) - 160 / 192) < 0.003)) fail('the sprite is not zoomed by size/192 (zoom ' + out.zoom + ')');
  if (!out.pos.length || out.pos.length < 2) fail('the sprite never moved: ' + JSON.stringify(out.pos));
  for (const p of out.pos) {
    const m = /^(-?\d+(?:\.\d+)?)px (-?\d+(?:\.\d+)?)px$/.exec(String(p));
    if (!m) fail('a frame position is not a whole-cell pixel offset: ' + JSON.stringify(p) + ' (all: ' + JSON.stringify(out.pos) + ')');
    const x = Number(m[1]);
    const y = Number(m[2]);
    if (x > 0 || y > 0) fail('a frame position is positive (the sheet would show blank space): ' + JSON.stringify(p));
    if (Math.abs(x % 192) > 0.001 || Math.abs(y % 208) > 0.001) fail('a frame position is off the 192x208 grid: ' + JSON.stringify(p));
  }
  if (problems.length) fail('the page threw: ' + problems.join(' | '));

  console.log(`  cell ${out.rect[0].toFixed(2)}x${out.rect[1].toFixed(2)}px at size 160, frames ${out.pos.length}, grid-aligned`);
  console.log('  PASS pet frames are whole cells drawn at their native aspect, not resampled across the grid');
  cleanup();
  cleanupBrowser();
  process.exit(0);
})().catch((e) => { cleanup(); console.error('FAIL: ' + ((e && e.stack) || e)); process.exit(1); });
