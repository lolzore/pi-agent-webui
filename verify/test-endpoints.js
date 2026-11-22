// Integration check: given a running bridge, the endpoints the UI depends on to
// show a chat actually return the data the UI needs.
//
// Usage: node test-endpoints.js <baseUrl> <sessionPath>

const http = require('http');
const fs = require('fs');
const { URL } = require('url');

const base = process.argv[2];
const sessionPath = process.argv[3];
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };

function get(pathAndQuery) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathAndQuery, base);
    http.get(u, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] || '' }));
    }).on('error', reject);
  });
}

function post(pathAndQuery, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathAndQuery, base);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  // The page and its two assets. If app.js 404s the UI is a blank window.
  const page = await get('/');
  if (page.status !== 200) fail(`GET / returned ${page.status}`);
  if (!page.body.includes('id="session-list"')) fail('the page has no #session-list element');

  for (const asset of ['/app.js', '/style.css']) {
    const r = await get(asset);
    if (r.status !== 200) fail(`GET ${asset} returned ${r.status}`);
    if (r.body.length < 1000) fail(`GET ${asset} is suspiciously small (${r.body.length} bytes)`);
  }

  // A malformed percent escape used to throw URIError out of serveStatic and
  // kill the whole bridge. It must be a 400, and the bridge must still answer.
  const malformed = await get('/%ZZ');
  if (malformed.status !== 400) fail(`GET /%ZZ returned ${malformed.status}, expected 400`);
  const afterMalformed = await get('/api/health');
  if (afterMalformed.status !== 200) fail('the bridge died after a malformed URL');

  // Static traversal: an encoded slash survives URL normalisation and used to
  // let /..%2fwebui-settings.json read a sibling whose name starts with "web".
  for (const path of ['/..%2fwebui-settings.json', '/%2e%2e%2fwebui-settings.json']) {
    const r = await get(path);
    if (r.status !== 403) fail(`GET ${path} returned ${r.status}, expected 403`);
    if (r.body.includes('TRAVERSAL_MARKER')) fail(`GET ${path} served a sibling file`);
  }

  // The list the sidebar renders. An empty array here is the "no chats" symptom.
  const list = await get('/api/sessions');
  if (list.status !== 200) fail(`GET /api/sessions returned ${list.status}`);
  let d;
  try { d = JSON.parse(list.body); } catch { fail('/api/sessions did not return JSON'); }
  if (!Array.isArray(d.sessions)) fail('/api/sessions has no sessions array');
  if (!d.sessions.length) fail('/api/sessions returned zero sessions — the sidebar would be blank');
  if (!d.sessions[0].path) fail('a listed session has no path');
  if (!d.sessions[0].name) fail('a listed session has no name');

  // The messages the transcript renders.
  const enc = encodeURIComponent(sessionPath);
  const msgs = await get(`/api/session-messages?path=${enc}`);
  if (msgs.status !== 200) fail(`GET /api/session-messages returned ${msgs.status}`);
  let m;
  try { m = JSON.parse(msgs.body); } catch { fail('/api/session-messages did not return JSON'); }
  if (!m || typeof m !== 'object') fail('/api/session-messages did not return an object');
  if (!Object.keys(m).length) fail('/api/session-messages returned an empty payload');

  // The raw JSONL. This is the endpoint whose reader was broken, so it is
  // checked for what the download actually promises: JSONL, header first.
  const raw = await get(`/api/session-file?path=${enc}`);
  if (raw.status !== 200) fail(`GET /api/session-file returned ${raw.status}`);
  if (/^\s*</.test(raw.body)) fail('/api/session-file returned HTML, not JSONL');
  const lines = raw.body.split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) fail('/api/session-file returned no lines');
  for (let i = 0; i < lines.length; i++) {
    try { JSON.parse(lines[i]); }
    catch (e) { fail(`/api/session-file line ${i} is not valid JSON: ${e.message}`); }
  }
  if (JSON.parse(lines[0]).type !== 'session') {
    fail(`/api/session-file starts with "${JSON.parse(lines[0]).type}", not the session header`);
  }

  /* /api/ensure-dir may only recreate the working directory recorded in the
   * session that is being opened. Anything else is refused and not created.
   * (The generated fixture has no cwd; the refusal is the security half and is
   * checked either way.) */
  const header = JSON.parse(lines[0]);
  if (header.cwd) {
    const allowed = await post('/api/ensure-dir', JSON.stringify({ path: header.cwd, session: sessionPath }));
    if (allowed.status !== 200) fail(`ensure-dir for the recorded cwd returned ${allowed.status}`);
  }
  const evil = `/tmp/pi-verify-not-a-session-dir-${process.pid}`;
  const refused = await post('/api/ensure-dir', JSON.stringify({ path: evil, session: sessionPath }));
  if (refused.status !== 400) fail(`ensure-dir for an unrelated path returned ${refused.status}, expected 400`);
  if (fs.existsSync(evil)) fail('ensure-dir created a directory that no session records');

  // Traversal must stay refused.
  const trav = await get(`/api/session-file?path=${encodeURIComponent('../../../../etc/passwd')}`);
  if (trav.status === 200) fail('path traversal was served a file');

  console.log(JSON.stringify({ sessions: d.sessions.length, messageKeys: Object.keys(m).length, rawLines: lines.length }));
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
