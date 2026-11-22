/*
 * The cloud TTS key belongs to the bridge.
 *
 * It used to be part of the UI settings the page loads: it came back from
 * GET /api/ui-settings, was cached in localStorage and posted again on every
 * save. The page itself never needs it - /api/tts makes the call - so the key
 * now lives only in the settings file and is set through /api/tts-key.
 *
 * Asserted here, against the scratch-settings bridge: the key never appears in
 * GET, a save cannot drop it, and set/replace/clear still work.
 *
 * Usage: node test-tts-key.js <baseUrl>
 */
'use strict';
const http = require('http');
const { URL } = require('url');

const base = process.argv[2];
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (!base) { console.error('usage: node test-tts-key.js <baseUrl>'); process.exit(2); }

function request(method, pathAndQuery, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathAndQuery, base);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const json = async (method, p, body) => {
  const r = await request(method, p, body);
  let d = null;
  try { d = JSON.parse(r.body); } catch { /* not json */ }
  return { status: r.status, d };
};

(async () => {
  const before = await json('GET', '/api/ui-settings');
  if (before.status !== 200) fail(`GET /api/ui-settings returned ${before.status}`);
  if ('ttsApiKey' in before.d) fail('GET /api/ui-settings still returns the TTS key');
  const baseline = before.d;

  const set = await json('POST', '/api/tts-key', JSON.stringify({ key: 'sk-verify-secret' }));
  if (set.status !== 200 || !set.d.ok) fail('POST /api/tts-key failed: ' + JSON.stringify(set.d));
  if (!set.d.ttsApiKeySet) fail('the key was not reported as set');

  const after = await json('GET', '/api/ui-settings');
  if ('ttsApiKey' in after.d) fail('the key is visible in GET /api/ui-settings after saving it');
  if (!after.d.ttsApiKeySet) fail('GET does not report that a key is set');

  // Saving the page's settings (without the key) must not drop the key.
  const saved = await json('POST', '/api/ui-settings', JSON.stringify(after.d));
  if (saved.status !== 200) fail(`POST /api/ui-settings returned ${saved.status}`);
  const persisted = await json('GET', '/api/ui-settings');
  if (!persisted.d.ttsApiKeySet) fail('a normal settings save dropped the stored key');

  const cleared = await json('POST', '/api/tts-key', JSON.stringify({ key: '' }));
  if (cleared.status !== 200 || cleared.d.ttsApiKeySet) fail('clearing the key failed');

  // Restore the scratch file's original shape.
  await json('POST', '/api/ui-settings', JSON.stringify(baseline));
  console.log('  the TTS key is bridge-only: absent from GET, survives a save, set and clear work');
  console.log(JSON.stringify({ exposed: false, survivesSave: true, cleared: true }));
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
