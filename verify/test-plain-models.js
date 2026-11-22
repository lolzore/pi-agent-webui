/*
 * Plain chats still have to offer every configured model.
 *
 * A plain pi child runs with --no-extensions, so providers registered by
 * extensions (llama.cpp and SchizoDev here) vanished from its model picker while
 * the normal chat still listed them. bridge/plain-models.js builds a temporary
 * agent dir whose models.json merges models.json, models-store.json and the
 * SchizoDev catalogue, with auth shared and extension packages stripped.
 *
 * This is the module-level check; test-plain-chat.js drives the real mode/UI.
 *
 * Usage: node test-plain-models.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const plainModels = require('../bridge/plain-models');

const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-plain-models-'));
const agentDir = path.join(scratch, 'agent');
fs.mkdirSync(agentDir, { recursive: true });
const write = (name, value) => fs.writeFileSync(path.join(agentDir, name), JSON.stringify(value, null, 2));
write('models.json', { providers: { custom: { baseUrl: 'https://custom.test/v1', api: 'openai-completions', apiKey: 'sk-custom', models: [{ id: 'custom-model' }] } } });
write('auth.json', { schizodev: { type: 'api_key', key: 'sk-schizo' } });
write('models-store.json', {
  'llama.cpp': { models: [
    { id: 'llama-a', name: 'Llama A', baseUrl: 'http://127.0.0.1:8080/v1', api: 'openai-completions', contextWindow: 64000, maxTokens: 64000 },
    { id: 'llama-b', name: 'Llama B', baseUrl: 'http://127.0.0.1:8080/v1', api: 'openai-completions' },
  ] },
  other: { models: [{ id: 'other-a', name: 'Other A', baseUrl: 'https://other.test/v1', api: 'openai-completions' }] },
});
write('schizodev-catalog.json', { models: [
  { id: 'schizo-a', name: 'Schizo A', context_window: 1000000, max_output_tokens: 100000, reasoning: true, input_modalities: ['text', 'image'], cost: { input: 0.1, output: 0.2 } },
  { id: 'schizo-b', name: 'Schizo B', context_window: 1000000, max_output_tokens: 100000, reasoning: false, input_modalities: ['text'], cost: {} },
] });
write('settings.json', { defaultProvider: 'llama.cpp', defaultModel: 'llama-a', packages: ['npm:never-install'], extensions: ['/never/load.ts'], compaction: { enabled: true } });

// The normal-chat snapshot is the authority: it contains exactly the providers
// the normal picker offered. models-store may hold stale/inaccessible entries.
plainModels.rememberSnapshot(agentDir, [
  { provider: 'ext-only', id: 'ext-model', name: 'Extension Model', baseUrl: 'https://ext.test/v1', api: 'openai-completions', contextWindow: 32000 },
  { provider: 'llama.cpp', id: 'llama-a', name: 'Llama A', baseUrl: 'http://127.0.0.1:8080/v1', api: 'openai-completions', contextWindow: 64000 },
  { provider: 'llama.cpp', id: 'llama-b', name: 'Llama B', baseUrl: 'http://127.0.0.1:8080/v1', api: 'openai-completions' },
  { provider: 'schizodev', id: 'schizo-a', name: 'Schizo A', baseUrl: 'https://api.schizodev.com/v1', api: 'openai-completions' },
  { provider: 'schizodev', id: 'schizo-b', name: 'Schizo B', baseUrl: 'https://api.schizodev.com/v1', api: 'openai-completions' },
]);
const providers = plainModels.mergedProviders(agentDir);
const names = Object.keys(providers);
if (!providers.custom || !providers.custom.models.some((m) => m.id === 'custom-model')) fail('the custom provider was lost: ' + JSON.stringify(names));
if (!providers['llama-server=http://127.0.0.1:8080']) fail('llama.cpp snapshot models were not registered under a usable provider: ' + JSON.stringify(names));
if (providers['llama-server=http://127.0.0.1:8080'].models.length !== 2) fail('not every accessible llama.cpp model came through: ' + JSON.stringify(providers['llama-server=http://127.0.0.1:8080']));
if (providers.other) fail('an inaccessible models-store-only provider leaked into the plain list');
if (!providers['ext-only'] || !providers['ext-only'].models.some((m) => m.id === 'ext-model')) fail('the normal-chat model snapshot was dropped');
if (!providers.schizodev || providers.schizodev.models.length !== 2) fail('SchizoDev snapshot models were dropped: ' + JSON.stringify(providers.schizodev));
if (!providers.schizodev.apiKey) fail('SchizoDev auth was not carried into the plain catalogue');
console.log('  providers:', names.join(', '));

const temp = plainModels.create(agentDir, 'pi --mode rpc');
if (!temp) fail('plain-models did not create a temporary agent dir');
try {
  const models = JSON.parse(fs.readFileSync(path.join(temp, 'models.json'), 'utf8'));
  const settings = JSON.parse(fs.readFileSync(path.join(temp, 'settings.json'), 'utf8'));
  if (!models.providers || !models.providers.custom) fail('the temporary models.json is missing the merged providers');
  if (settings.packages || settings.extensions) fail('the temporary settings still install/load extensions: ' + JSON.stringify(settings));
  if (settings.defaultProvider !== 'llama-server=http://127.0.0.1:8080') fail('the default provider was not pointed at the plain llama provider: ' + settings.defaultProvider);
  if (!fs.existsSync(path.join(temp, 'auth.json'))) fail('auth.json was not shared with the plain agent');
  console.log('  temporary agent dir:', temp);
} finally {
  plainModels.dispose(temp);
}
try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
console.log('  PASS plain chats receive the normal chat\'s accessible catalogue plus custom providers, without stale store-only entries');
