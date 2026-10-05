// Container integration check: the image serves the page, its assets, and a
// well-formed session list.
//
// A fresh container's session dir is empty, so unlike the host check this one
// does not assert on message payloads — there is nothing to read yet. It does
// assert that the list is an array, because "sessions is not an array" is the
// shape of the failure that leaves the sidebar permanently blank.
//
// Usage: node test-endpoints-container.js <baseUrl>

const http = require('http');
const { URL } = require('url');

const base = process.argv[2];
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };

function get(p) {
  return new Promise((resolve, reject) => {
    http.get(new URL(p, base), (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

(async () => {
  const page = await get('/');
  if (page.status !== 200) fail(`GET / returned ${page.status}`);
  if (!page.body.includes('id="session-list"')) fail('the page has no #session-list element');

  for (const asset of ['/app.js', '/style.css']) {
    const r = await get(asset);
    if (r.status !== 200) fail(`GET ${asset} returned ${r.status}`);
    if (r.body.length < 1000) fail(`GET ${asset} is suspiciously small (${r.body.length} bytes)`);
  }

  const list = await get('/api/sessions');
  if (list.status !== 200) fail(`GET /api/sessions returned ${list.status}`);
  let d;
  try { d = JSON.parse(list.body); } catch { fail('/api/sessions did not return JSON'); }
  if (!Array.isArray(d.sessions)) fail('/api/sessions has no sessions array');

  console.log(`${d.sessions.length} sessions`);
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
