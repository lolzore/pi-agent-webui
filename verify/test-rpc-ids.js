/*
 * Two clients, one request id.
 *
 * Every page numbers its own RPCs from zero (`req-1`, `req-2`, ...), so two
 * tabs always have ids in common. The bridge used to key its response routing
 * table by that id alone, so the second client overwrote the first: one caller
 * was handed the other's answer and the other timed out.
 *
 * Asserted here, against the mock-agent bridge: with both sockets sending the
 * SAME id at the same time, each one gets exactly the response to its own
 * command, with its own id preserved, and the bridge stays healthy afterwards.
 *
 * Usage: node test-rpc-ids.js <baseUrl>
 */
'use strict';
const http = require('http');
const path = require('path');
const { URL } = require('url');
const WS = require(require.resolve('ws', { paths: [path.join(__dirname, '..', 'bridge')] }));

const base = process.argv[2];
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
const ok = (m) => console.log('  ' + m);
if (!base) { console.error('usage: node test-rpc-ids.js <baseUrl>'); process.exit(2); }

const health = () => new Promise((resolve) => {
  const u = new URL('/api/health', base);
  http.get(u, (res) => {
    let b = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { b += c; });
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
  }).on('error', () => resolve(null));
});

function connect() {
  const url = new URL('/ws', base);
  url.protocol = 'ws:';
  const ws = new WS(url.toString());
  const messages = [];
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m && m.bridge === 'rpc' && m.payload && m.payload.type === 'response') {
      messages.push(m.payload);
    }
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, messages }));
    ws.once('error', reject);
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
  const a = await connect();
  const b = await connect();
  // The bridge announces the agent to every new socket; those are not responses.
  await waitFor(() => true, 100);

  const id = 'req-1';   // deliberately the same on both sockets, as two tabs do
  a.ws.send(JSON.stringify({ type: 'get_state', id }));
  b.ws.send(JSON.stringify({ type: 'get_available_models', id }));

  const got = await waitFor(() => a.messages.length >= 1 && b.messages.length >= 1, 8000);
  if (!got) {
    fail(`timed out waiting for responses (a=${a.messages.length}, b=${b.messages.length}); `
      + 'the bridge routed an answer to the wrong socket or dropped it');
  }

  const aResp = a.messages[0];
  const bResp = b.messages[0];
  if (aResp.command !== 'get_state') fail(`client A received the response to "${aResp.command}"`);
  if (bResp.command !== 'get_available_models') fail(`client B received the response to "${bResp.command}"`);
  if (aResp.id !== id) fail(`client A's response id was ${JSON.stringify(aResp.id)}, expected ${JSON.stringify(id)}`);
  if (bResp.id !== id) fail(`client B's response id was ${JSON.stringify(bResp.id)}, expected ${JSON.stringify(id)}`);
  if (!aResp.success || !bResp.success) fail('a response was not successful');
  if (!aResp.data || typeof aResp.data !== 'object') fail('client A did not get get_state data');
  if (typeof aResp.data.sessionFile !== 'string' || !aResp.data.model) fail('client A got a payload that is not get_state');
  if (!bResp.data || !Array.isArray(bResp.data.models)) fail('client B did not get get_available_models data');

  // A second round on the same sockets, with the order reversed, so the fix is
  // not just "the first one happens to win".
  a.messages.length = 0;
  b.messages.length = 0;
  const id2 = 'req-2';
  b.ws.send(JSON.stringify({ type: 'get_state', id: id2 }));
  a.ws.send(JSON.stringify({ type: 'get_available_models', id: id2 }));
  const got2 = await waitFor(() => a.messages.length >= 1 && b.messages.length >= 1, 8000);
  if (!got2) fail('the second round timed out');
  if (a.messages[0].command !== 'get_available_models') fail(`second round: A got "${a.messages[0].command}"`);
  if (b.messages[0].command !== 'get_state') fail(`second round: B got "${b.messages[0].command}"`);

  // The bridge must still be serving after two colliding rounds.
  const h = await health();
  if (!h || !h.ok) fail('the bridge is not healthy after the colliding requests');

  a.ws.close();
  b.ws.close();
  ok('two clients with the same request id each received their own response, twice');
  console.log(JSON.stringify({ rounds: 2, id, clients: 2 }));
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
