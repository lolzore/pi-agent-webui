/*
 * Issue #38: "image no longer in session" when uploading images from a phone.
 *
 * The pictures that failed were the phone ones and every other picture worked, so
 * the file was never the problem. A session line has no size bound worth guessing
 * at - a message carries its pictures inline, and one off a phone camera is
 * several megabytes of base64 on ONE line - and readLineAt() grew its read but
 * stopped at 8 MB. The line came back truncated, JSON.parse threw on it, and the
 * handler turned that into "that image is no longer at that line".
 *
 * So this builds a session whose image line is larger than that cap and asks the
 * bridge for it the way the transcript does. On the old code the request 404s.
 *
 * Usage: node test-big-image.js <baseUrl>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const base = process.argv[2];
if (!base) { console.error('usage: node test-big-image.js <baseUrl>'); process.exit(2); }
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
const ok = (m) => console.log('  PASS ' + m);

const dir = process.env.PI_BIGIMG_DIR;
if (!dir) { console.error('usage: PI_BIGIMG_DIR=<the bridge session dir> node test-big-image.js <baseUrl>'); process.exit(2); }
/* Only this one file is ever removed. The directory is the bridge's session dir
 * and holds the fixture sessions other checks use - deleting it would look like a
 * pass here and a mystery failure three checks later. */
const file = path.join(dir, 'big-image-session.jsonl');
fs.mkdirSync(dir, { recursive: true });
const cleanup = () => { try { fs.rmSync(file, { force: true }); } catch { /* gone */ } };
process.on('exit', cleanup);

/* A real PNG of the right size, made by repeating a valid 1x1 PNG's chunks is not
 * worth the effort - the endpoint only base64-decodes the payload and hands it
 * back, so what matters is that it is a valid base64 string of a size over the
 * old cap, and that the byte count round-trips. The file must parse as JSON, which
 * is the part that used to fail. */
const PAYLOAD = 9 * 1024 * 1024;            // base64 chars: over the old 8 MB cap
const buf = Buffer.alloc(Math.floor(PAYLOAD * 0.75));
// PNG signature so the served bytes are recognisable as an image
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
for (let i = 8; i < buf.length; i++) buf[i] = (i * 31) & 0xff;      // not all one byte: no accidental compression
const b64 = buf.toString('base64');

const lines = [
  JSON.stringify({ type: 'session', name: 'big image', version: 1 }),
  JSON.stringify({ type: 'message', id: 'm1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'before' } }),
];
// The big one: a user message with a text block then the picture, so `part` is 1
// and is not the same as the picture count - the other bug that lived here.
lines.push(JSON.stringify({
  type: 'message', id: 'm2', timestamp: new Date().toISOString(),
  message: { role: 'user', content: [{ type: 'text', text: 'look at this' }, { type: 'image', data: b64, mimeType: 'image/png' }] },
}));
lines.push(JSON.stringify({ type: 'message', id: 'm3', timestamp: new Date().toISOString(), message: { role: 'assistant', content: 'ok', usage: { input: 1, output: 1 } } }));
fs.writeFileSync(file, lines.join('\n') + '\n');

console.log(`  session: ${lines.length} lines, ${fs.statSync(file).size} bytes, image line ${PAYLOAD} base64 chars`);

const get = (p) => new Promise((res, rej) => {
  http.get(base + p, (r) => {
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => res({ status: r.statusCode, type: r.headers['content-type'], body: Buffer.concat(chunks) }));
  }).on('error', rej);
});
const getJson = async (p) => { const r = await get(p); return { status: r.status, json: JSON.parse(r.body.toString('utf8')) }; };

(async () => {
  const enc = encodeURIComponent(file);
  /* The transcript first: this is what the page renders, and it is where the
   * picture URL comes from. It must also survive, which is its own check - the
   * line is 9 MB and it is not the only line in the file. */
  const sm = await getJson(`/api/session-messages?path=${enc}`);
  if (sm.status !== 200) fail('session-messages answered ' + sm.status);
  let src = null, part = null, line = null;
  for (const m of sm.json.messages || []) {
    const c = m.content;
    if (!Array.isArray(c)) continue;
    for (let i = 0; i < c.length; i++) {
      const b = c[i];
      if (b && b.type === 'image' && b.src) { src = b.src; part = i; }
    }
  }
  if (!src) fail('the transcript did not externalise the big picture at all');
  const q = new URL(src, 'http://x').searchParams;
  line = q.get('line');
  console.log(`  transcript points at line=${line} part=${q.get('part')} (content index, not picture count)`);
  if (q.get('part') !== '1' || part !== 1) fail(`part should be the content-array index 1, got ${q.get('part')}`);
  if (line !== '3') fail(`the picture is on line 3, the URL says ${line}`);

  const img = await get(src);
  console.log(`  fetch it: HTTP ${img.status}, ${img.body.length} bytes, ${img.type}`);
  if (img.status !== 200) {
    fail(`the picture the transcript just pointed at answered ${img.status}: ` +
      JSON.stringify(img.body.toString('utf8').slice(0, 120)) +
      ' - the line is in the file, so this is the reader failing on a long line');
  }
  if (img.body.length !== buf.length) fail(`served ${img.body.length} bytes, the file holds ${buf.length} - the line was truncated`);
  if (img.body.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') fail('the served bytes are not the picture');
  ok('#38 a picture on a line larger than 8 MB is served whole');

  /* And a line that genuinely is not an image must still say so plainly, rather
   * than being confused with a read that failed. */
  const wrong = await getJson(`/api/session-image?path=${enc}&line=4&part=1`);
  if (wrong.status !== 404) fail(`a line with no image answered ${wrong.status}, expected 404`);
  if (!/no longer at that line/.test(String(wrong.json.error || ''))) fail('unexpected 404 text: ' + wrong.json.error);
  ok('#38 a line with no picture still reports 404');

  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
