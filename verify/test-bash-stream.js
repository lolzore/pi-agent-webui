/*
 * Bash output is request-scoped: the card is filed under the id the page chose
 * BEFORE the command runs, so every `bash_execution_update` has to carry that
 * same id. It used to carry the bridge's wire id instead, so no update ever
 * matched a card and output appeared only when the command finished.
 *
 * Asserted here, against the mock-agent bridge: the updates carry the caller's
 * id and arrive BEFORE the response, and the bridge stays healthy.
 *
 * Usage: node test-bash-stream.js <baseUrl>
 */
'use strict';
const http = require('http');
const path = require('path');
const { URL } = require('url');
const WS = require(require.resolve('ws', { paths: [path.join(__dirname, '..', 'bridge')] }));

const base = process.argv[2];
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (!base) { console.error('usage: node test-bash-stream.js <baseUrl>'); process.exit(2); }

const u = new URL('/ws', base);
u.protocol = 'ws:';
const ws = new WS(u.toString());
const frames = [];
ws.on('message', (raw) => {
  let m;
  try { m = JSON.parse(String(raw)); } catch { return; }
  if (m && m.bridge === 'rpc' && m.payload) frames.push(m.payload);
});

const waitFor = async (pred, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

ws.once('open', async () => {
  const id = 'req-1';
  ws.send(JSON.stringify({ type: 'bash', id, command: 'echo streamed' }));

  const done = await waitFor(() => frames.some((f) => f.type === 'response' && f.id === id), 8000);
  if (!done) fail('no response to the bash request');

  const updates = frames.filter((f) => f.type === 'bash_execution_update');
  if (!updates.length) fail('no bash_execution_update arrived at all');
  for (const f of updates) {
    if (f.id !== id) fail(`a bash update carried id ${JSON.stringify(f.id)}, expected ${JSON.stringify(id)}`);
  }
  const firstUpdate = frames.findIndex((f) => f.type === 'bash_execution_update');
  const response = frames.findIndex((f) => f.type === 'response' && f.id === id);
  if (firstUpdate < 0 || response < 0) fail('missing update or response');
  if (firstUpdate > response) fail('the updates arrived after the response - nothing streamed');

  // A second command on the same socket must be just as well behaved.
  const before = frames.length;
  const id2 = 'req-2';
  ws.send(JSON.stringify({ type: 'bash', id: id2, command: 'echo again' }));
  const done2 = await waitFor(() => frames.slice(before).some((f) => f.type === 'response' && f.id === id2), 8000);
  if (!done2) fail('no response to the second bash request');
  const updates2 = frames.slice(before).filter((f) => f.type === 'bash_execution_update');
  if (!updates2.length) fail('the second command produced no updates');
  for (const f of updates2) if (f.id !== id2) fail(`second command update carried ${JSON.stringify(f.id)}`);

  const health = await new Promise((resolve) => {
    http.get(new URL('/api/health', base), (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
  if (!health || !health.ok) fail('the bridge is not healthy after the bash requests');

  ws.close();
  console.log('  bash updates carried the caller\'s id and arrived before the response, twice');
  console.log(JSON.stringify({ updates: updates.length, order: 'update<response' }));
});
ws.once('error', (e) => fail(e && e.stack ? e.stack : String(e)));
