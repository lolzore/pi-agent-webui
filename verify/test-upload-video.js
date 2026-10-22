/*
 * Issue #62: video file upload support.
 *
 * A video attachment is stored by the bridge (raw body above 8 MB, base64 JSON
 * below) and referenced by path in the prompt. What the page could not do was
 * show it: the bytes were readable by the agent's tools and by nothing else, so
 * a clip was a filename with a ▶ on it. /api/upload-file serves an uploaded
 * file back - and only files inside the upload directories, resolved through
 * realpath - with Range support because a <video> seeks with it.
 *
 * This checks both upload routes with a real (tiny) mp4, the served bytes, the
 * byte ranges, HEAD, and that paths outside the upload folder - including a
 * "starts with the upload dir" traversal - are refused.
 *
 * Usage: env PI_TEST_AGENT_DIR=<scratch agent dir> \
 *        node test-upload-video.js <baseUrl>
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const base = process.argv[2];
const agentDir = process.env.PI_TEST_AGENT_DIR || '';
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (!base) { console.error('usage: node test-upload-video.js <baseUrl>'); process.exit(2); }
if (!agentDir) { console.error('SKIP: PI_TEST_AGENT_DIR is not set (a file outside the uploads folder is needed)'); process.exit(77); }

const TINY_CLIP = Buffer.from('GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAKzEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggEeTbuMU6uEHFO7a1OsggKd7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjAuMTYuMTAwV0GNTGF2ZjYwLjE2LjEwMESJiEB5AAAAAAAAFlSua8GuAQAAAAAAADjXgQFzxYh+rbf5WDLGB5yBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhAJiWgDgibCBILqBIJqBAhJUw2f8c3OgY8CAZ8iaRaOHRU5DT0RFUkSHjUxhdmY2MC4xNi4xMDBzc9ZjwItjxYh+rbf5WDLGB2fIoUWjh0VOQ09ERVJEh5RMYXZjNjAuMzEuMTAyIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDAuNDAwMDAwMDAwAB9DtnVA+OeBAKOkgQAAgDACAJ0BKiAAIAAARwiFhYiFhIgCAgAHkPPJwP7/q1CAo5WBACgAsQEAARAQABgAGFgv9AAIcACjlYEAUACxAQABEBAAGAAYWC/0AAhwAKOVgQB4ALEBAAEQEAAYABhYL/QACHAAo5WBAKAAsQEAARAQABgAGFgv9AAIcACjlYEAyACxAQABEBAAGAAYWC/0AAhwAKOVgQDwALEBAAEQEAAYABhYL/QACHAAo5WBARgAsQEAARAQFGAAYWC/0AAhwACjlYEBQACxAQABEBAAGAAYWC/0AAhwAKOVgQFoALEBAAEQEAAYABhYL/QACHAAHFO7a5G7j7OBALeK94EB8YIBn/CBAw==', 'base64');

const post = (p, body, headers) => new Promise((res, rej) => {
  const req = http.request({ host: '127.0.0.1', port: new URL(base).port, path: p, method: 'POST', agent: false, headers: Object.assign({}, headers) }, (r) => {
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => { let j = {}; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* */ } res({ status: r.statusCode, body: j }); });
  });
  req.on('error', rej);
  req.end(body);
});
const get = (p, headers) => new Promise((res, rej) => {
  const req = http.request({ host: '127.0.0.1', port: new URL(base).port, path: p, method: 'GET', agent: false, headers: Object.assign({}, headers) }, (r) => {
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', rej);
  req.end();
});
const head = (p) => new Promise((res, rej) => {
  const req = http.request({ host: '127.0.0.1', port: new URL(base).port, path: p, method: 'HEAD', agent: false }, (r) => {
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', rej);
  req.end();
});

(async () => {
  /* 1. the base64 route, which is what a small file uses */
  const up = await post('/api/upload', JSON.stringify({
    name: 'clip.webm', mimeType: 'video/webm', data: TINY_CLIP.toString('base64'),
  }), { 'Content-Type': 'application/json' });
  if (up.status !== 200 || !up.body.path) fail('the base64 upload failed: HTTP ' + up.status + ' ' + JSON.stringify(up.body));
  if (up.body.size !== TINY_CLIP.length) fail('stored size ' + up.body.size + ' != ' + TINY_CLIP.length);
  console.log('  uploaded a ' + TINY_CLIP.length + '-byte clip through /api/upload');

  /* 2. the raw route, which is what a real video uses */
  const big = Buffer.alloc(12 * 1024 * 1024, 0x41);
  const raw = await post('/api/upload-raw?name=clip-big.webm&mimeType=video%2Fwebm', big, { 'Content-Type': 'video/webm' });
  if (raw.status !== 200 || !raw.body.path) fail('the raw upload failed: HTTP ' + raw.status + ' ' + JSON.stringify(raw.body));
  if (raw.body.size !== big.length) fail('raw stored size ' + raw.body.size + ' != ' + big.length);
  console.log('  uploaded a ' + Math.round(big.length / 1048576) + ' MB clip through /api/upload-raw');

  /* 3. served back, with the type a <video> needs */
  const q = (p) => `/api/upload-file?path=${encodeURIComponent(p)}`;
  const got = await get(q(up.body.path));
  if (got.status !== 200) fail('serving the uploaded clip failed: HTTP ' + got.status);
  if (got.headers['content-type'] !== 'video/webm') fail('wrong content type: ' + got.headers['content-type']);
  if (!/bytes/.test(String(got.headers['accept-ranges']))) fail('no Accept-Ranges on the upload');
  if (!got.body.equals(TINY_CLIP)) fail('the served bytes differ from the uploaded clip');
  console.log('  the clip is served back whole with video/webm and Accept-Ranges');

  /* 4. ranges, which is how a video seeks */
  const r1 = await get(q(up.body.path), { Range: 'bytes=10-29' });
  if (r1.status !== 206) fail('a range request answered HTTP ' + r1.status + ' (expected 206)');
  if (r1.headers['content-range'] !== `bytes 10-29/${TINY_CLIP.length}`) fail('wrong Content-Range: ' + r1.headers['content-range']);
  if (!r1.body.equals(TINY_CLIP.subarray(10, 30))) fail('the ranged bytes are wrong');
  const r2 = await get(q(up.body.path), { Range: 'bytes=-16' });
  if (r2.status !== 206 || !r2.body.equals(TINY_CLIP.subarray(TINY_CLIP.length - 16))) fail('a suffix range is wrong (HTTP ' + r2.status + ')');
  const bad = await get(q(up.body.path), { Range: 'bytes=99999-' });
  if (bad.status !== 416) fail('an unsatisfiable range answered HTTP ' + bad.status + ' (expected 416)');
  console.log('  ranges work (206 with Content-Range, suffix ranges, 416 when unsatisfiable)');

  const h = await head(q(up.body.path));
  if (h.status !== 200 || Number(h.headers['content-length']) !== TINY_CLIP.length || h.body.length) {
    fail('HEAD is wrong: HTTP ' + h.status + ' length ' + h.headers['content-length'] + ' body ' + h.body.length);
  }
  console.log('  HEAD describes the file without sending it');

  /* 5. nothing outside the uploads folder is reachable */
  const outside = await get(q(path.join(agentDir, 'settings.json')));
  if (outside.status !== 403) fail('a file outside the uploads folder answered HTTP ' + outside.status + ' (expected 403)');
  const uploadsDir = path.dirname(up.body.path);
  const escapeFile = path.join(uploadsDir, '..', 'verify-escape.txt');
  fs.writeFileSync(escapeFile, 'not yours');
  const traversal = await get(q(escapeFile));
  fs.rmSync(escapeFile, { force: true });
  if (traversal.status !== 403) fail('a path that leaves the uploads folder through .. answered HTTP ' + traversal.status + ' (expected 403)');
  const missing = await get(q(path.join(uploadsDir, 'does-not-exist.mp4')));
  if (missing.status !== 404) fail('a missing upload answered HTTP ' + missing.status + ' (expected 404)');
  console.log('  outside paths and traversal are refused, a missing file is a 404');

  console.log('  PASS #62 both upload routes store a video and the page can play it back');
  process.exit(0);
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
