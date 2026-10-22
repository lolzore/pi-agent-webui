/*
 * Issue #72: "let the model actually see frames from an uploaded video."
 *
 * pi has no video content block, so a vision model can only see an uploaded
 * video as pictures. On upload the bridge now takes a few evenly spaced frames
 * with ffmpeg (optional infrastructure) and returns them with the file; the page
 * sends them as image content next to the video's path reference and shows the
 * user which frames will go.
 *
 * This runs two bridges against one scratch upload dir: the default one (ffmpeg
 * when the host has it) and one with PI_WEBUI_FFMPEG=off, which is the
 * deterministic degraded path on any machine. It checks the upload responses,
 * the frame files on disk, and - in the page - the chip, the attachment and the
 * prompt that would be sent.
 *
 * Usage: node test-video-frames.js <browserPath>
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const browser = process.argv[2];
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const ROOT = path.resolve(__dirname, '..');
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.mp4'));
const FIXTURE_B64 = fixture.toString('base64');
const PORT = 21200 + (process.pid % 300);
const OFF_PORT = PORT + 1;
const DBG_PORT = 9600 + (process.pid % 200);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-vframes-'));
const agentDir = path.join(scratch, 'agent');
const homeDir = path.join(scratch, 'home');
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(homeDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, 'settings.json'), '{}');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hostHasFfmpeg = (() => {
  try { const r = spawnSync('ffmpeg', ['-version'], { timeout: 5000, stdio: 'ignore' }); return !r.error && r.status === 0; } catch { return false; }
})();

let bridgeA = null, bridgeB = null;
const cleanup = () => {
  try { if (bridgeA) bridgeA.kill(); } catch { /* gone */ }
  try { if (bridgeB) bridgeB.kill(); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);

const getJson = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
const uploadRaw = (port, name, mimeType, bytes) => new Promise((res, rej) => {
  const req = http.request({
    host: '127.0.0.1', port,
    path: `/api/upload-raw?name=${encodeURIComponent(name)}&mimeType=${encodeURIComponent(mimeType)}`,
    method: 'POST', headers: { 'Content-Type': mimeType, 'Content-Length': bytes.length },
  }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res({ status: r.statusCode, body: JSON.parse(b) }); } catch (e) { rej(e); } });
  });
  req.on('error', rej);
  req.end(bytes);
});
const startBridge = (port, extraEnv) => new Promise(async (resolve, reject) => {
  const child = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      HOME: homeDir,
      PI_AGENT_DIR: agentDir,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: path.join(scratch, 'sessions'),
      WORKSPACE_DIR: scratch,
      PI_SESSION_DIR: path.join(scratch, 'sessions'),
      PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_LLAMA_SCAN: 'off',
      PORT: String(port),
    }, extraEnv || {}),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  for (let i = 0; i < 80; i++) {
    try { await getJson(port, '/api/health'); return resolve(child); } catch { await sleep(200); }
  }
  reject(new Error('bridge on ' + port + ' never came up\n' + err.slice(-400)));
});

(async () => {
  bridgeA = await startBridge(PORT);
  bridgeB = await startBridge(OFF_PORT, { PI_WEBUI_FFMPEG: 'off' });

  /* ── the default bridge: frames, or a note saying why not ──────────── */
  const up = await uploadRaw(PORT, 'sample.mp4', 'video/mp4', fixture);
  if (up.status !== 200 || !up.body.ok) fail('the video upload failed: HTTP ' + up.status + ' ' + JSON.stringify(up.body));
  const frames = up.body.frames || [];
  if (hostHasFfmpeg) {
    if (frames.length < 3) fail('ffmpeg is installed but the upload returned ' + frames.length + ' frames: ' + JSON.stringify(up.body.frameNote || ''));
    for (const f of frames) {
      if (!/^image\/jpe?g$/.test(f.mimeType || '')) fail('a frame has the wrong type: ' + JSON.stringify(f.mimeType));
      if (!f.data || f.data.length < 100) fail('a frame carries no data');
      if (Buffer.from(f.data, 'base64').length !== f.size) fail('the frame data does not match its size');
    }
    const frameDir = up.body.path + '.frames';
    const onDisk = fs.existsSync(frameDir) ? fs.readdirSync(frameDir).filter((n) => /\.jpe?g$/i.test(n)) : [];
    if (onDisk.length !== frames.length) fail('the frames are not on disk: ' + onDisk.length + ' vs ' + frames.length);
    console.log(`  ffmpeg here: ${frames.length} frames from a 3s clip, ${Math.round(frames.reduce((n, f) => n + f.size, 0) / 1024)} KB total, also on disk`);
  } else {
    if (frames.length) fail('ffmpeg is not installed but frames were returned');
    if (!/ffmpeg/i.test(up.body.frameNote || '')) fail('no note explains the missing frames: ' + JSON.stringify(up.body.frameNote));
    console.log('  no ffmpeg here: upload still succeeds, the note says why, no frames: ' + JSON.stringify(up.body.frameNote));
  }
  if (up.body.frameNote && frames.length) fail('a successful extraction also carried a note: ' + JSON.stringify(up.body.frameNote));

  /* A non-video is not probed at all. */
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const imgUp = await uploadRaw(PORT, 'pixel.png', 'image/png', png);
  if (imgUp.body.frames !== undefined || imgUp.body.frameNote !== undefined) fail('an image upload was treated as a video: ' + JSON.stringify(imgUp.body));

  /* ── the switched-off bridge: the deterministic degraded path ──────── */
  const off = await uploadRaw(OFF_PORT, 'sample.mp4', 'video/mp4', fixture);
  if (off.status !== 200 || !off.body.ok) fail('the degraded upload failed: HTTP ' + off.status);
  if ((off.body.frames || []).length) fail('PI_WEBUI_FFMPEG=off still produced frames');
  if (!/frames/i.test(off.body.frameNote || '')) fail('the switched-off path has no note: ' + JSON.stringify(off.body.frameNote));
  console.log('  PI_WEBUI_FFMPEG=off: no frames, note: ' + JSON.stringify(off.body.frameNote));

  /* ── the page: the chip shows the frames and the prompt carries them ── */
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-vframes-browser-'));
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--remote-debugging-port=' + DBG_PORT, '--user-data-dir=' + userDir,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let browserErr = '';
  child.stderr.on('data', (c) => { browserErr += c; });
  const cleanupBrowser = () => {
    try { child.kill(); } catch { /* gone */ }
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ }
  };
  process.on('exit', cleanupBrowser);

  let ver = null;
  for (let i = 0; i < 100; i++) {
    try {
      ver = await new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port: DBG_PORT, path: '/json/version' }, (r) => {
          let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
          r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
        }).on('error', rej);
      });
      break;
    } catch { await sleep(150); }
  }
  if (!ver) fail('browser never came up\n' + browserErr.slice(-400));

  const WS = require('./ws-min.js');
  const pages = await new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: DBG_PORT, path: '/json/list' }, (r) => {
      let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
  const ws = new WS(pages.find((t) => t.type === 'page').webSocketDebuggerUrl);
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
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 100; i++) {
    if (await evalJs("typeof addFile === 'function' && typeof sendPrompt === 'function' ? 1 : 0")) break;
    await sleep(250);
  }

  const page = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const out = {};
    const bin = atob('${FIXTURE_B64}');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], 'sample.mp4', { type: 'video/mp4' });
    S.attachments = [];
    renderAttachments();
    await addFile(file);
    const att = S.attachments[0] || {};
    out.kind = att.kind;
    out.frames = (att.frames || []).length;
    out.frameNote = att.frameNote || '';
    out.thumbs = document.querySelectorAll('#attachments .attachment-frames img').length;
    out.chipNote = (document.querySelector('#attachments .attachment-note') || {}).textContent || '';
    out.chipCaption = (document.querySelector('#attachments .attachment-frames-note') || {}).textContent || '';
    // The prompt that would be sent: rpc is captured, not called.
    let sent = null;
    const real = window.rpc;
    window.rpc = (m) => { sent = m; return Promise.resolve({ ok: true }); };
    await sendPrompt('what happens in this video?', S.attachments, 'steer', true);
    window.rpc = real;
    out.sentImages = sent && sent.images ? sent.images.length : 0;
    out.sentTypes = sent && sent.images ? [...new Set(sent.images.map((i) => i.mimeType))] : [];
    out.sentMessage = sent ? String(sent.message || '') : '';
    S.attachments = [];
    renderAttachments();
    return out;
  })()))()`));

  if (page.kind !== 'video') fail('the upload was not attached as a video: ' + JSON.stringify(page));
  if (hostHasFfmpeg) {
    if (page.frames < 3) fail('the page did not keep the frames: ' + JSON.stringify(page));
    if (page.thumbs !== page.frames) fail(`the chip shows ${page.thumbs} thumbnails for ${page.frames} frames`);
    if (!/frames go to the model/.test(page.chipCaption)) fail('the chip does not say the frames go to the model: ' + JSON.stringify(page.chipCaption));
    if (page.sentImages !== page.frames) fail(`the prompt carried ${page.sentImages} images for ${page.frames} frames`);
    if (!page.sentTypes.every((t) => /^image\/jpe?g$/.test(t))) fail('a frame was sent with the wrong type: ' + JSON.stringify(page.sentTypes));
    if (!/frames attached as images/.test(page.sentMessage)) fail('the path reference does not mention the frames: ' + JSON.stringify(page.sentMessage));
    if (!/\[Attached video: sample\.mp4 → /.test(page.sentMessage)) fail('the video path reference is missing: ' + JSON.stringify(page.sentMessage));
    console.log(`  page: ${page.thumbs} thumbnails, prompt carried ${page.sentImages} image(s) plus the path reference`);
  } else {
    if (page.frames !== 0 || page.thumbs !== 0) fail('frames appeared without ffmpeg: ' + JSON.stringify(page));
    if (!/ffmpeg/i.test(page.chipNote)) fail('the chip does not explain the missing frames: ' + JSON.stringify(page.chipNote));
    if (page.sentImages !== 0) fail('images were sent without ffmpeg: ' + JSON.stringify(page.sentImages));
    if (!/no frames:/.test(page.sentMessage)) fail('the prompt does not say there are no frames: ' + JSON.stringify(page.sentMessage));
    console.log('  page (no ffmpeg): the chip explains it and the prompt carries no frames');
  }
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));

  console.log('  PASS #72 an uploaded video reaches the model as frames when ffmpeg is there, and says so when it is not');
  cleanupBrowser();
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
