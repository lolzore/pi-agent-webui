/*
 * Issue #62: video file upload support, in the page.
 *
 * Attaching a video used to leave a ▶ icon and a filename in the composer, and
 * a raw "[Attached video: name → path]" line in the transcript - nothing
 * playable anywhere, because the bytes were only reachable by the agent's
 * tools. Now the bridge serves the uploads folder back and both places show a
 * real player.
 *
 * The file is a genuine (32x32, 0.4s) mp4 so the player has something to
 * decode: this checks the composer preview, the transcript player, that the
 * raw reference line is not shown as text, and that the promise of playback is
 * real (readyState advances, a videoWidth exists).
 *
 * Usage: node test-video-attach.js <baseUrl> <browserPath>
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
if (!base) { console.error('usage: node test-video-attach.js <baseUrl> <browserPath>'); process.exit(2); }
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const TINY_WEBM_B64 =
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAKzEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggEeTbuMU6uEHFO7a1OsggKd7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjAuMTYuMTAwV0GNTGF2ZjYwLjE2LjEwMESJiEB5AAAAAAAAFlSua8GuAQAAAAAAADjXgQFzxYh+rbf5WDLGB5yBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhAJiWgDgibCBILqBIJqBAhJUw2f8c3OgY8CAZ8iaRaOHRU5DT0RFUkSHjUxhdmY2MC4xNi4xMDBzc9ZjwItjxYh+rbf5WDLGB2fIoUWjh0VOQ09ERVJEh5RMYXZjNjAuMzEuMTAyIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDAuNDAwMDAwMDAwAB9DtnVA+OeBAKOkgQAAgDACAJ0BKiAAIAAARwiFhYiFhIgCAgAHkPPJwP7/q1CAo5WBACgAsQEAARAQABgAGFgv9AAIcACjlYEAUACxAQABEBAAGAAYWC/0AAhwAKOVgQB4ALEBAAEQEAAYABhYL/QACHAAo5WBAKAAsQEAARAQABgAGFgv9AAIcACjlYEAyACxAQABEBAAGAAYWC/0AAhwAKOVgQDwALEBAAEQEAAYABhYL/QACHAAo5WBARgAsQEAARAQFGAAYWC/0AAhwACjlYEBQACxAQABEBAAGAAYWC/0AAhwAKOVgQFoALEBAAEQEAAYABhYL/QACHAAHFO7a5G7j7OBALeK94EB8YIBn/CBAw==';

const PORT = 9480 + (process.pid % 40);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-video-'));
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

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: base + '/' });
  for (let i = 0; i < 100; i++) {
    if (await evalJs("typeof addFile === 'function' && typeof renderUserMessage === 'function' ? 1 : 0")) break;
    await sleep(250);
  }
  await evalJs("document.querySelectorAll('dialog[open]').forEach((d) => { try { d.close(); } catch {} })");
  await sleep(800);

  const res = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const out = {};
    const b64 = '${TINY_WEBM_B64}';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], 'clip.webm', { type: 'video/webm' });

    S.attachments = [];
    renderAttachments();
    await addFile(file);
    const att = S.attachments[0] || {};
    out.kind = att.kind;
    out.hasPath = !!att.path;

    // The composer preview is a player, and it decodes.
    const deadline = Date.now() + 8000;
    let composer = document.querySelector('#attachments video.attachment-video');
    while (Date.now() < deadline && (!composer || composer.readyState < 1)) {
      await new Promise((r) => setTimeout(r, 100));
      composer = document.querySelector('#attachments video.attachment-video');
    }
    out.composerHasVideo = !!composer;
    out.composerSrc = composer ? composer.getAttribute('src') : null;
    out.composerReady = composer ? composer.readyState : -1;
    out.composerWidth = composer ? composer.videoWidth : 0;
    out.composerControls = composer ? composer.controls : false;

    // The transcript shows the same file as a player instead of the raw line.
    const root = renderUserMessage({ role: 'user', content: [{ type: 'text', text: 'look at this\\n\\n[Attached video: clip.webm → ' + att.path + ']' }] });
    const d2 = Date.now() + 8000;
    let player = root.querySelector('video.msg-video');
    while (Date.now() < d2 && (!player || player.readyState < 1)) {
      await new Promise((r) => setTimeout(r, 100));
      player = root.querySelector('video.msg-video');
    }
    out.playerSrc = player ? player.getAttribute('src') : null;
    out.playerReady = player ? player.readyState : -1;
    out.playerWidth = player ? player.videoWidth : 0;
    out.name = (root.querySelector('.msg-attach-name') || {}).textContent || '';
    out.rawLineShown = /\\[Attached video:/.test(root.querySelector('.bubble').textContent);
    out.bodyText = root.querySelector('.bubble').textContent.trim().slice(0, 80);

    root.remove();
    S.attachments = [];
    renderAttachments();
    return out;
  })()))()`));

  console.log('  attachment: kind=' + res.kind + ' path=' + res.hasPath);
  console.log('  composer player: present=' + res.composerHasVideo + ' ready=' + res.composerReady + ' width=' + res.composerWidth + ' controls=' + res.composerControls);
  console.log('  transcript player: ready=' + res.playerReady + ' width=' + res.playerWidth + ' name=' + JSON.stringify(res.name));
  console.log('  bubble text: ' + JSON.stringify(res.bodyText));

  if (res.kind !== 'video' || !res.hasPath) fail('the attached clip is not recorded as an uploaded video');
  if (!res.composerHasVideo) fail('the composer shows no player for an attached video');
  if (!/\/api\/upload-file\?path=/.test(String(res.composerSrc))) fail('the composer player does not use the uploads endpoint: ' + res.composerSrc);
  if (!res.composerControls) fail('the composer player has no controls');
  if (res.composerReady < 1) fail('the composer player never decoded the clip (readyState ' + res.composerReady + ')');
  if (!res.composerWidth) fail('the composer player decoded no video dimensions');
  if (!res.playerSrc || !/\/api\/upload-file\?path=/.test(res.playerSrc)) fail('the transcript has no player for the upload: ' + res.playerSrc);
  if (res.playerReady < 1 || !res.playerWidth) fail('the transcript player never decoded the clip (readyState ' + res.playerReady + ')');
  if (res.name !== 'clip.webm') fail('the transcript does not name the file: ' + JSON.stringify(res.name));
  if (res.rawLineShown) fail('the transcript still shows the raw [Attached video: …] line');
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));

  console.log('  PASS #62 a video attaches with a playing preview and appears in the transcript');
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
