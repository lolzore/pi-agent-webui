/*
 * Issue #46: a settings tab for pi's extensions, skills, packages and AGENTS.md.
 *
 * This exercises the bridge endpoints against a SCRATCH agent dir - the suite
 * starts a second bridge with PI_AGENT_DIR pointed at one, because these endpoints
 * write settings.json and delete files, and the real ~/.pi/agent is not a test
 * fixture. The UI half is checked in the page at the same time.
 *
 * What is being asserted is mostly what it REFUSES. Enable/disable has no mechanism
 * of its own - pi stores it as +path/-path entries in settings.json and this writes
 * the same format - so the checks are that the file ends up saying what pi would
 * have written, that a name off the wire can never become a path outside the two
 * directories, and that a cross-origin write is still refused.
 *
 * Usage: node test-extensions.js <baseUrl> <browserPath>
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = process.argv[2];
const browser = process.argv[3];
const agentDir = process.env.PI_TEST_AGENT_DIR;
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
const ok = (m) => console.log('  PASS ' + m);
if (!base) { console.error('usage: node test-extensions.js <baseUrl> <browserPath>'); process.exit(2); }
if (!agentDir) { console.error('PI_TEST_AGENT_DIR must name the scratch agent dir the bridge was pointed at'); process.exit(2); }
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }
const settingsFile = path.join(agentDir, 'settings.json');
const settings = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));

const PORT = 9960 + (process.pid % 14);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-ext-'));
const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDir,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', (c) => { stderr += c; });
const cleanup = () => {
  try { child.kill(); } catch { /* gone */ }
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

/* One request helper for the endpoints under test: keep the status, so a refusal
 * can be asserted as a refusal rather than as a missing field. */
function apiCall(method, p, body, headers) {
  return new Promise((res, rej) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: Number(new URL(base).port), path: p, method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, payload ? { 'Content-Length': payload.length } : {}, headers || {}) },
      (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
          res({ status: r.statusCode, json, text });
        });
      });
    req.on('error', rej);
    if (payload) req.write(payload);
    req.end();
  });
}
const get = (p) => apiCall('GET', p);
const post = (p, body, headers) => apiCall('POST', p, body, headers);

(async () => {
  let ver = null;
  for (let i = 0; i < 100; i++) { try { ver = await getJson('/json/version'); break; } catch { await sleep(150); } }
  if (!ver) fail('browser never came up\n' + stderr.slice(-400));

  // ── the list ────────────────────────────────────────────────────────────
  const list = await get('/api/pi-extensions');
  if (list.status !== 200 || !list.json) fail('GET /api/pi-extensions answered ' + list.status + ': ' + list.text.slice(0, 120));
  const L = list.json;
  console.error(`  agent dir: ${L.agentDir}  extensions=${L.counts.extensions} skills=${L.counts.skills} packages=${L.counts.packages}`);
  const extNames = L.extensions.map((r) => r.name);
  const skillNames = L.skills.map((r) => r.name);
  if (!extNames.includes('fixture-ext.ts')) fail('the loose extension was not listed: ' + JSON.stringify(extNames));
  if (!skillNames.includes('fixture-skill')) fail('the skill folder was not listed: ' + JSON.stringify(skillNames));
  if (L.skills.some((r) => r.kind !== 'dir')) fail('a skill must be a directory holding SKILL.md');
  if (!L.extensions.every((r) => r.enabled === true)) fail('a fresh resource must read as enabled');
  if (L.packages.length !== 2) fail('expected the two fixture packages, got ' + L.packages.length);
  const objForm = L.packages.find((p) => p.form === 'object');
  if (!objForm || !objForm.filters || !objForm.filters.extensions) fail('the object-form package lost its filters: ' + JSON.stringify(objForm));
  ok('#46 the tab lists loose extensions, skills and packages with their state');

  // ── enable/disable writes pi's own format ───────────────────────────────
  const off = await post('/api/pi-extensions/toggle', { type: 'skills', name: 'fixture-skill', enabled: false });
  if (off.status !== 200 || !off.json.ok) fail('toggle off answered ' + off.status + ' ' + off.text.slice(0, 120));
  let s = settings();
  if (JSON.stringify(s.skills) !== JSON.stringify(['-skills/fixture-skill'])) {
    fail('settings.json does not hold pi\'s own "-skills/x" form: ' + JSON.stringify(s.skills));
  }
  if (!s.packages || s.packages.length !== 2) fail('the toggle damaged the package list: ' + JSON.stringify(s.packages));
  if (s.defaultModel !== 'fixture-model') fail('the toggle dropped unrelated settings keys: ' + JSON.stringify(Object.keys(s)));
  const after = await get('/api/pi-extensions');
  const skill = after.json.skills.find((r) => r.name === 'fixture-skill');
  if (!skill || skill.enabled !== false) fail('the list still reports it enabled after disabling it');
  ok('#46 disabling writes "-skills/x" into settings.json and the list follows it');

  // re-enabling, repeatedly, must not grow the array
  for (let i = 0; i < 3; i++) {
    await post('/api/pi-extensions/toggle', { type: 'skills', name: 'fixture-skill', enabled: true });
    await post('/api/pi-extensions/toggle', { type: 'skills', name: 'fixture-skill', enabled: false });
  }
  s = settings();
  if (s.skills.length !== 1) fail(`six toggles left ${s.skills.length} entries: ` + JSON.stringify(s.skills));
  await post('/api/pi-extensions/toggle', { type: 'skills', name: 'fixture-skill', enabled: true });
  s = settings();
  if (JSON.stringify(s.skills) !== JSON.stringify(['+skills/fixture-skill'])) {
    fail('re-enabling should write "+skills/x" (it overrides a "!" from a project settings.json): ' + JSON.stringify(s.skills));
  }
  ok('#46 toggling repeatedly replaces the entry instead of accumulating it');

  // ── a name off the wire can never become a path ─────────────────────────
  const nasty = ['../settings.json', 'a/b', '..', '', 'skills/fixture-skill', 'fixture-skill/../../../../etc', 'x\\y', 'a\u0000b'];
  const before = fs.readFileSync(settingsFile, 'utf8');
  for (const name of nasty) {
    const r = await post('/api/pi-extensions/toggle', { type: 'skills', name, enabled: false });
    if (r.status === 200) fail(`a toggle with name ${JSON.stringify(name)} was accepted`);
    const r2 = await post('/api/pi-extensions/delete', { type: 'skills', name });
    if (r2.status === 200) fail(`a delete with name ${JSON.stringify(name)} was accepted`);
  }
  if (fs.readFileSync(settingsFile, 'utf8') !== before) fail('a refused request still wrote to settings.json');
  if (!fs.existsSync(path.join(agentDir, 'settings.json'))) fail('settings.json disappeared');
  const outside = ['fixture-ext.ts'].filter((n) => fs.existsSync(path.join(path.dirname(agentDir), n)));
  if (outside.length) fail('a refused delete reached outside the agent dir: ' + JSON.stringify(outside));
  ok('#46 every path-shaped name is refused, and nothing was written');

  // an unknown type must not be able to name an arbitrary directory
  const badType = await post('/api/pi-extensions/delete', { type: '../../', name: 'x' });
  if (badType.status === 200) fail('an unknown type was accepted');
  ok('#46 an unknown resource type is refused');

  // ── cross-site writes are still refused (the issue #23 gate) ────────────
  const cross = await post('/api/pi-extensions/toggle', { type: 'skills', name: 'fixture-skill', enabled: false }, { Origin: 'http://evil.example' });
  if (cross.status !== 403) fail('a cross-origin write was not refused: ' + cross.status);
  const crossPkg = await post('/api/pi-extensions/package', { action: 'add', source: 'npm:evil' }, { Origin: 'http://evil.example' });
  if (crossPkg.status !== 403) fail('a cross-origin package add was not refused: ' + crossPkg.status);
  ok('#46 cross-origin writes to the new endpoints are refused');

  // ── packages ───────────────────────────────────────────────────────────
  const dup = await post('/api/pi-extensions/package', { action: 'add', source: 'npm:pi-subagents' });
  if (dup.status !== 409) fail('a duplicate package add was not refused: ' + dup.status);
  const flag = await post('/api/pi-extensions/package', { action: 'add', source: '-evil-flag' });
  if (flag.status !== 400) fail('a package source starting with "-" was accepted (npm would read it as a flag)');
  const add = await post('/api/pi-extensions/package', { action: 'add', source: 'npm:some-new-package' });
  if (add.status !== 200) fail('adding a package failed: ' + add.text.slice(0, 120));
  if (!settings().packages.includes('npm:some-new-package')) fail('the package was not written to settings.json');
  const rem = await post('/api/pi-extensions/package', { action: 'remove', source: 'npm:some-new-package' });
  if (rem.status !== 200) fail('removing a package failed');
  if (settings().packages.length !== 2) fail('the package list is wrong after add+remove: ' + JSON.stringify(settings().packages));
  ok('#46 packages can be listed, added and removed, and a flag-shaped source is refused');

  // ── AGENTS.md ──────────────────────────────────────────────────────────
  const a0 = await get('/api/pi-agents');
  if (a0.status !== 200) fail('GET /api/pi-agents answered ' + a0.status);
  const g0 = a0.json.files.find((f) => f.writable);
  if (!g0) fail('no writable global AGENTS.md row');
  if (g0.exists) fail('the fixture global AGENTS.md should not exist yet');
  if (!a0.json.files.every((f) => f.writable || f.scope === 'project' || f.scope === 'parent')) fail('unexpected AGENTS.md scopes');
  const saw = await post('/api/pi-agents', { content: '# fixture\n\nbe nice\n' });
  if (saw.status !== 200) fail('saving AGENTS.md failed: ' + saw.text.slice(0, 120));
  const written = path.join(agentDir, 'AGENTS.md');
  if (!fs.existsSync(written)) fail('AGENTS.md was not written to the agent dir');
  if (!/be nice/.test(fs.readFileSync(written, 'utf8'))) fail('AGENTS.md holds the wrong content');
  const a1 = await get('/api/pi-agents');
  if (!a1.json.files.find((f) => f.writable).exists) fail('the saved AGENTS.md still reads as missing');
  const blank = await post('/api/pi-agents', { content: '   \n' });
  if (blank.status !== 200) fail('blanking AGENTS.md failed');
  if (fs.existsSync(written)) fail('a blank save should delete the global AGENTS.md, not write whitespace into it');
  ok('#46 the global AGENTS.md can be read, saved and deleted, and is the only writable one');

  // ── the uninstall half, on a copy so the list still has something ───────
  fs.mkdirSync(path.join(agentDir, 'skills', 'doomed'), { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'skills', 'doomed', 'SKILL.md'), '# doomed\n');
  fs.mkdirSync(path.join(agentDir, 'skills', 'doomed', 'reference'), { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'skills', 'doomed', 'reference', 'notes.md'), 'nested\n');
  const del = await post('/api/pi-extensions/delete', { type: 'skills', name: 'doomed' });
  if (del.status !== 200) fail('deleting a loose skill failed: ' + del.text.slice(0, 120));
  if (fs.existsSync(path.join(agentDir, 'skills', 'doomed'))) fail('the skill directory (with its nesting) was not removed');
  if (!fs.existsSync(path.join(agentDir, 'skills', 'fixture-skill'))) fail('deleting one skill removed another');
  ok('#46 uninstall removes the file or the whole directory, and only that one');

  // ── the tab itself ─────────────────────────────────────────────────────
  const WS = require('./ws-min.js');
  const page = (await getJson('/json/list')).find((t) => t.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.open();
  let id = 0; const pending = new Map(); const problems = [];
  ws.onmessage = (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      problems.push(((d.exception && (d.exception.description || d.exception.value)) || d.text || '?'));
    }
  };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw');
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: base + '/' });
  await sleep(3000);
  const ui = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    openSettings();
    const tab = [...document.querySelectorAll('#settings-tabs .tab')].find((t) => t.dataset.tab === 'extensions');
    if (!tab) return { missingTab: true };
    tab.click();
    await new Promise((r) => setTimeout(r, 2500));
    const panel = $('tab-extensions');
    const ids = (sel) => [...panel.querySelectorAll(sel + ' .prov-id')].map((n) => n.textContent);
    const buttons = [...panel.querySelectorAll('.prov-row .btn')].map((b) => b.textContent);
    return {
      visible: !panel.classList.contains('hidden'),
      otherPanelsHidden: [...document.querySelectorAll('#settings-dialog .tab-panel')].filter((p) => p !== panel && !p.classList.contains('hidden')).length,
      extensions: ids('#ext-extensions'),
      skills: ids('#ext-skills'),
      packages: ids('#ext-packages'),
      agents: ids('#ext-agents-list'),
      buttons,
      dialogHeight: Math.round($('settings-dialog').getBoundingClientRect().height),
      showedDir: $('ext-agent-dir').textContent.length > 0,
    };
  })()))()`));
  if (ui.missingTab) fail('the Extensions tab button is not in the settings dialog');
  if (!ui.visible) fail('clicking the Extensions tab did not show its panel');
  if (ui.otherPanelsHidden) fail(ui.otherPanelsHidden + ' other panel(s) stayed visible - the tab switch is broken');
  if (!ui.extensions.length || !ui.skills.length || !ui.packages.length) {
    fail('the tab rendered an empty list: ' + JSON.stringify(ui));
  }
  if (ui.buttons.some((b) => /^install/i.test(b))) fail('there is an install button, which this deliberately does not ship');
  if (!ui.buttons.includes('disable') || !ui.buttons.includes('uninstall')) fail('the rows are missing their actions: ' + JSON.stringify(ui.buttons));
  if (!ui.showedDir) fail('the tab did not name the agent dir it is working in');
  console.log('  tab rendered: ' + ui.extensions.length + ' extension(s), ' + ui.skills.length + ' skill(s), ' +
    ui.packages.length + ' package(s), ' + ui.agents.length + ' AGENTS.md row(s); height ' + ui.dialogHeight + 'px');
  ok('#46 the tab renders its sections through the same dialog as the other tabs');

  if (problems.length) fail(problems.slice(0, 3).join(' | '));
  ws.close(); cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
