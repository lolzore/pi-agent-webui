/*
 * Issue #202: Fish Audio's TTS API moved to S2.
 *
 * The old bridge sent `model: "s1"` in the JSON body. S1 is deprecated (retired
 * 2026-12-31) and the current API selects the model with a `model` request
 * header; `s2.1-pro` is the documented production model. This test runs a local
 * stand-in for api.fish.audio, points the bridge at it, and checks the request
 * the bridge actually makes and the audio it streams back - no API key and no
 * network needed.
 *
 * Usage: node test-tts-fish.js <browserPath>   (the browser is not used; the
 * second argument keeps the verify-matrix invocation uniform)
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 3092;
const TTS_PORT = PORT + 1;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-fish-'));
for (const d of ['agent', 'sessions', 'ws']) fs.mkdirSync(path.join(scratch, d), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bridge = null;
let tts = null;
const cleanup = () => {
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
  try { if (tts) tts.close(); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);
const fail = (m) => { console.error('FAIL: ' + m); cleanup(); process.exit(1); };

const requests = [];
tts = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    requests.push({ url: req.url, headers: req.headers, body: (() => { try { return JSON.parse(body); } catch { return body; } })() });
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    res.end(Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]));
  });
});

const post = (body) => new Promise((res, rej) => {
  const data = JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/tts', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (r) => {
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => res({ status: r.statusCode, type: r.headers['content-type'], body: Buffer.concat(chunks) }));
  });
  req.on('error', rej);
  req.end(data);
});

(async () => {
  await new Promise((r) => tts.listen(TTS_PORT, '127.0.0.1', r));
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: path.join(scratch, 'agent'), PI_CODING_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_SESSION_DIR: path.join(scratch, 'sessions'), WORKSPACE_DIR: path.join(scratch, 'ws'),
      PI_SESSION_DIR: path.join(scratch, 'sessions'), PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'),
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_LLAMA_SCAN: 'off', PORT: String(PORT),
    }), stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = ''; bridge.stderr.on('data', (c) => { err += c; });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { await new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: PORT, path: '/api/health' }, (r) => { r.resume(); r.on('end', res); }).on('error', rej); }); up = true; break; } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('the bridge never came up\n' + err.slice(-400));

  const base = `http://127.0.0.1:${TTS_PORT}`;
  const first = await post({
    provider: 'fish', apiKey: 'test-key', baseUrl: base,
    model: 's2.1-pro', voice: 'ref-voice-123', text: 'Hello from the test.',
  });
  if (first.status !== 200) fail('the TTS route failed: ' + first.status);
  if (!/audio\/mpeg/.test(first.type || '')) fail('the audio content type was not passed through: ' + first.type);
  if (first.body.length < 4) fail('no audio body was returned');
  if (requests.length !== 1) fail('the stand-in received ' + requests.length + ' requests, expected 1');
  const r1 = requests[0];
  if (r1.url !== '/v1/tts') fail('wrong Fish path: ' + r1.url);
  if (r1.headers.authorization !== 'Bearer test-key') fail('the API key did not reach Fish: ' + r1.headers.authorization);
  if (r1.headers.model !== 's2.1-pro') fail('the model header is wrong: ' + JSON.stringify(r1.headers.model));
  if (r1.body.text !== 'Hello from the test.' || r1.body.format !== 'mp3') fail('the Fish payload is wrong: ' + JSON.stringify(r1.body));
  if (r1.body.reference_id !== 'ref-voice-123') fail('the reference id is missing: ' + JSON.stringify(r1.body));
  if ('model' in r1.body) fail('the model is still sent in the body instead of the header: ' + JSON.stringify(r1.body));
  console.log('  Fish request:', JSON.stringify({ url: r1.url, model: r1.headers.model, body: r1.body }));

  const second = await post({
    provider: 'fish', apiKey: 'test-key', baseUrl: base, text: 'Default model.',
  });
  if (second.status !== 200) fail('the default-model request failed: ' + second.status);
  const r2 = requests[1];
  if (r2.headers.model !== 's2.1-pro') fail('the default model is not s2.1-pro: ' + JSON.stringify(r2.headers.model));
  if ('reference_id' in r2.body) fail('a reference_id was invented when none was set: ' + JSON.stringify(r2.body));
  console.log('  default Fish model:', r2.headers.model);

  console.log('  PASS #202 Fish Audio uses the s2.1-pro model header and the current payload');
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
