/*
 * Two tabs and one settings file.
 *
 * Every settings save posted the whole object and the bridge replaced the file
 * with it, so a tab that had been open for a while silently undid a change made
 * in another tab. The bridge now broadcasts a settings_changed signal (with the
 * saving client's id) after a successful write; every other page reloads the
 * server copy.
 *
 * Asserted here: the signal arrives, it names the sender, and the file still
 * contains the setting that was posted. The page-side reload is covered by the
 * browser checks when a browser is available.
 *
 * Usage: node test-settings-broadcast.js <baseUrl>
 */
'use strict';
const http = require('http');
const path = require('path');
const { URL } = require('url');
const WS = require(require.resolve('ws', { paths: [path.join(__dirname, '..', 'bridge')] }));

const base = process.argv[2];
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (!base) { console.error('usage: node test-settings-broadcast.js <baseUrl>'); process.exit(2); }

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

const waitFor = async (pred, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

(async () => {
  const got = await request('GET', '/api/ui-settings');
  if (got.status !== 200) fail(`GET /api/ui-settings returned ${got.status}`);
  const snapshot = JSON.parse(got.body);
  // A harmless key of our own, so the assertion is about this write and not
  // about whatever the scratch settings already had.
  const marker = `probe-${Date.now()}`;

  const u = new URL('/ws', base);
  u.protocol = 'ws:';
  const ws = new WS(u.toString());
  const signals = [];
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m && m.bridge === 'settings_changed') signals.push(m);
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const posted = { ...snapshot, settingsBroadcastProbe: marker };
  const from = 'probe-tab';
  const save = await request('POST', `/api/ui-settings?from=${encodeURIComponent(from)}`, JSON.stringify(posted));
  if (save.status !== 200) fail(`POST /api/ui-settings returned ${save.status}: ${save.body.slice(0, 200)}`);

  const arrived = await waitFor(() => signals.length > 0, 5000);
  if (!arrived) fail('no settings_changed signal after a save');
  if (signals[0].from !== from) fail(`the signal carried from=${JSON.stringify(signals[0].from)}, expected ${JSON.stringify(from)}`);

  const after = JSON.parse((await request('GET', '/api/ui-settings')).body);
  if (after.settingsBroadcastProbe !== marker) fail('the saved settings were not persisted');

  // Put the scratch file back the way it was.
  await request('POST', '/api/ui-settings', JSON.stringify(snapshot));
  ws.close();
  console.log('  settings save broadcast {bridge:settings_changed, from} and persisted the change');
  console.log(JSON.stringify({ from, signals: signals.length }));
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
