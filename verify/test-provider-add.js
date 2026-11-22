/*
 * Adding a custom provider through the WebUI.
 *
 * Two real failures this covers:
 *   1. the base URL field is usually filled with the endpoint from the
 *      provider's docs (.../v1/chat/completions), which made the connection
 *      test and model discovery probe nonsense paths;
 *   2. models.json was written as a JSON *string* of the file (the object was
 *      stringified twice), so pi could not read the provider and the second add
 *      failed with "Cannot create property 'providers' on string".
 *
 * A local fake OpenAI-compatible server requires the key, so discovery only
 * passes if the key is actually forwarded.
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 28100 + (process.pid % 200);
const UPSTREAM = 28900 + (process.pid % 200);
const KEY = 'sk-verify-provider-key';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-provider-add-'));
const agentDir = path.join(scratch, 'agent');
const sessionDir = path.join(scratch, 'sessions');
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(sessionDir, { recursive: true });
const modelsFile = path.join(agentDir, 'models.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };

let upstream = null;
let bridge = null;
const cleanup = () => {
  try { if (upstream) upstream.close(); } catch { /* gone */ }
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);

const getJson = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res({ status: r.statusCode, body: JSON.parse(b) }); } catch (e) { rej(e); } });
  }).on('error', rej);
});
const postJson = (port, p, body) => new Promise((res, rej) => {
  const data = JSON.stringify(body || {});
  const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res({ status: r.statusCode, body: JSON.parse(b) }); } catch (e) { rej(e); } });
  });
  req.on('error', rej);
  req.end(data);
});

const readModels = () => JSON.parse(fs.readFileSync(modelsFile, 'utf8'));

(async () => {
  /* Fake upstream: requires the key on both endpoints. */
  upstream = http.createServer((req, res) => {
    const u = (req.url || '').split('?')[0].replace(/\/+$/, '');
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${KEY}`) { res.statusCode = 401; res.end('{"error":{"message":"unauthorized"}}'); return; }
    if (req.method === 'GET' && (u === '/v1/models' || u === '/models')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'verify-model', name: 'Verify Model' }] }));
      return;
    }
    if (req.method === 'POST' && u === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let model = 'verify-model';
        try { model = JSON.parse(body).model || model; } catch { /* fake */ }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }], model }));
      });
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((res, rej) => { upstream.once('error', rej); upstream.listen(UPSTREAM, '127.0.0.1', res); });

  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir, PI_SESSION_DIR: sessionDir,
      WORKSPACE_DIR: scratch,
      PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'),
      PI_WEBUI_SOURCE_FILE: path.join(scratch, 'source.txt'),
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_LLAMA_SCAN: 'off', PORT: String(PORT),
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = ''; bridge.stderr.on('data', (c) => { err += c; });
  let up = false;
  for (let i = 0; i < 100; i++) {
    try { const d = await getJson(PORT, '/api/health'); if (d.body.ok) { up = true; break; } } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('the scratch bridge never came up\n' + err.slice(-500));

  const full = `http://127.0.0.1:${UPSTREAM}/v1/chat/completions`;
  const base = `http://127.0.0.1:${UPSTREAM}/v1`;

  /* 1. Discovery must forward the key and trim the endpoint suffix. */
  const discovered = await postJson(PORT, '/api/probe-models', { url: full, apiKey: KEY });
  if (discovered.status !== 200 || !discovered.body.models || !discovered.body.models.some((m) => m.id === 'verify-model')) {
    fail('full-endpoint discovery failed: ' + JSON.stringify(discovered));
  }
  if (discovered.body.url !== base) fail('discovery kept the chat endpoint as the base URL: ' + JSON.stringify(discovered.body.url));

  /* 2. The connection test does the same and reports the corrected base. */
  const tested = await postJson(PORT, '/api/probe-provider', { baseUrl: full, api: 'openai-completions', apiKey: KEY });
  if (tested.status !== 200 || !tested.body.ok || tested.body.baseUrl !== base) {
    fail('connection test failed or kept the endpoint suffix: ' + JSON.stringify(tested));
  }

  /* 3. Add the provider: the file must be a JSON object, not JSON-in-a-string. */
  const added = await postJson(PORT, '/api/pi-providers', {
    id: 'verify-provider', baseUrl: full, api: 'openai-completions', apiKey: KEY,
    models: ['verify-model'],
  });
  if (added.status !== 200) fail('provider add failed: ' + JSON.stringify(added));
  let file = readModels();
  if (typeof file !== 'object' || !file.providers || !file.providers['verify-provider']) {
    fail('models.json is not an object with the provider (double encoding?): ' + JSON.stringify(file));
  }
  const p1 = file.providers['verify-provider'];
  if (p1.baseUrl !== base) fail('saved base URL is still the chat endpoint: ' + JSON.stringify(p1.baseUrl));
  if (p1.apiKey !== KEY) fail('the API key was not saved');
  if (!p1.models || p1.models[0].id !== 'verify-model') fail('the model list was not saved: ' + JSON.stringify(p1.models));

  /* 3a. An update with a blank model list keeps the models and can apply the
   * thinking flag to them. This is the form path used by an older custom
   * provider whose models were saved before reasoning support existed. */
  const thinkingExisting = await postJson(PORT, '/api/pi-providers', {
    id: 'verify-provider', baseUrl: base, api: 'openai-completions',
    models: [], reasoning: true,
  });
  if (thinkingExisting.status !== 200) fail('thinking update failed: ' + JSON.stringify(thinkingExisting));
  const kept = readModels().providers['verify-provider'].models;
  if (!kept || kept.length !== 1 || kept[0].id !== 'verify-model' || kept[0].reasoning !== true) {
    fail('a blank model update lost the models or did not set reasoning: ' + JSON.stringify(kept));
  }
  const thinkingOff = await postJson(PORT, '/api/pi-providers', {
    id: 'verify-provider', baseUrl: base, api: 'openai-completions',
    models: [], reasoning: false,
  });
  if (thinkingOff.status !== 200 || readModels().providers['verify-provider'].models[0].reasoning !== false) {
    fail('turning thinking off again did not reach the preserved model');
  }

  /* 3b. A model can declare reasoning/thinking support. */
  const thinking = await postJson(PORT, '/api/pi-providers', {
    id: 'verify-thinking', baseUrl: base, api: 'openai-completions',
    models: [{ id: 'thinking-model', reasoning: true }],
  });
  if (thinking.status !== 200) fail('provider with a thinking model failed: ' + JSON.stringify(thinking));
  const tm = readModels().providers['verify-thinking'].models[0];
  if (tm.reasoning !== true) fail('the model reasoning flag was not saved: ' + JSON.stringify(tm));

  /* 4. A second add must read the first file back as an object. */
  const second = await postJson(PORT, '/api/pi-providers', {
    id: 'verify-second', baseUrl: `http://127.0.0.1:${UPSTREAM}/v1`, api: 'openai-completions',
  });
  if (second.status !== 200) fail('second provider add failed (legacy string read?): ' + JSON.stringify(second));
  file = readModels();
  if (typeof file !== 'object' || !file.providers['verify-provider'] || !file.providers['verify-second']) {
    fail('the second add lost the first provider: ' + JSON.stringify(file));
  }

  /* 5. A blank key on an update keeps the stored one. */
  const keep = await postJson(PORT, '/api/pi-providers', {
    id: 'verify-provider', baseUrl: base, api: 'openai-completions', models: ['verify-model'],
  });
  if (keep.status !== 200 || readModels().providers['verify-provider'].apiKey !== KEY) {
    fail('a blank key update did not keep the stored key: ' + JSON.stringify(keep));
  }

  /* 6. A file left double-encoded by the old build is still readable, and the
   * next write repairs it. */
  const legacy = { providers: { legacy: { baseUrl: base, api: 'openai-completions', apiKey: KEY, models: [{ id: 'legacy-model' }] } } };
  fs.writeFileSync(modelsFile, JSON.stringify(JSON.stringify(legacy, null, 2)));
  const listed = await getJson(PORT, '/api/pi-providers');
  if (listed.status !== 200 || !listed.body.providers || !listed.body.providers.legacy) {
    fail('a legacy double-encoded models.json is not readable: ' + JSON.stringify(listed.body));
  }
  const repaired = await postJson(PORT, '/api/pi-providers', {
    id: 'after-legacy', baseUrl: base, api: 'openai-completions',
  });
  if (repaired.status !== 200) fail('add after a legacy file failed: ' + JSON.stringify(repaired));
  file = readModels();
  if (typeof file !== 'object' || !file.providers.legacy || !file.providers['after-legacy']) {
    fail('the legacy file was not repaired: ' + JSON.stringify(file));
  }

  console.log('  full endpoint trimmed to ' + base + '; key forwarded for discovery');
  console.log('  models.json stays an object; a second add and a blank-key update work');
  console.log('  a legacy double-encoded file is readable and is repaired on the next write');
  console.log('  PASS custom providers can be added from the WebUI');
  cleanup(); process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
