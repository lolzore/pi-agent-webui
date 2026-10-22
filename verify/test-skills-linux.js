/*
 * Issue #64: "Skills are not showing on linux."
 *
 * pi loads user skills from two global places: `<agent dir>/skills` and the
 * shared `~/.agents/skills` (package-manager.js: userAgentsSkillsDir), plus
 * `<project>/.pi/skills` and `<project>/.agents/skills` from a *trusted* project.
 * The bridge listed only the agent dir, so on a Linux box whose skills live in
 * ~/.agents/skills the Extensions tab showed none at all.
 *
 * This runs its own bridge with a scratch HOME, so ~/.agents/skills is a real
 * directory this test controls - not the machine's own. It checks the listing
 * over the API and in the page, that enable/disable writes the pattern pi
 * actually resolves (`skills/<name>`), and that the two dangerous paths are
 * closed: ~/.agents and project skills cannot be deleted from this tab.
 *
 * Usage: node test-skills-linux.js <browserPath>
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const browser = process.argv[2];
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const ROOT = path.resolve(__dirname, '..');
const PORT = 20300 + (process.pid % 500);
const DBG_PORT = 9200 + (process.pid % 300);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-skills-'));
const agentDir = path.join(scratch, 'agent');
const homeDir = path.join(scratch, 'home');
const projectDir = path.join(scratch, 'project');
const settingsPath = path.join(agentDir, 'settings.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(path.join(agentDir, 'skills', 'verify-local-skill'), { recursive: true });
fs.writeFileSync(path.join(agentDir, 'skills', 'verify-local-skill', 'SKILL.md'), '# local skill\n');
fs.mkdirSync(path.join(homeDir, '.agents', 'skills', 'verify-agents-skill'), { recursive: true });
fs.writeFileSync(path.join(homeDir, '.agents', 'skills', 'verify-agents-skill', 'SKILL.md'), '# agents skill\n');
fs.mkdirSync(path.join(projectDir, '.pi', 'skills', 'verify-project-skill'), { recursive: true });
fs.writeFileSync(path.join(projectDir, '.pi', 'skills', 'verify-project-skill', 'SKILL.md'), '# project skill\n');
// A directory without SKILL.md is not a skill and must not be listed.
fs.mkdirSync(path.join(homeDir, '.agents', 'skills', 'not-a-skill'), { recursive: true });
fs.writeFileSync(path.join(agentDir, 'settings.json'), '{}');

let bridge = null;
const cleanup = () => {
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);

const getJson = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
const postJson = (p, body) => new Promise((res, rej) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { let d = {}; try { d = JSON.parse(b); } catch { /* */ } res({ status: r.statusCode, body: d }); });
  });
  req.on('error', rej);
  req.end(JSON.stringify(body));
});

(async () => {
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      HOME: homeDir,
      PI_AGENT_DIR: agentDir,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: path.join(scratch, 'sessions'),
      WORKSPACE_DIR: projectDir,
      PI_SESSION_DIR: path.join(scratch, 'sessions'),
      PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_LLAMA_SCAN: 'off',
      PORT: String(PORT),
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let bridgeErr = '';
  bridge.stderr.on('data', (c) => { bridgeErr += c; });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { await getJson('/api/health'); up = true; break; } catch { await sleep(200); }
  }
  if (!up) fail('the scratch bridge never came up\n' + bridgeErr.slice(-500));

  /* ── the listing, over the API ─────────────────────────────────────── */
  const d = await getJson('/api/pi-extensions');
  const byName = {};
  for (const s of d.skills) byName[s.name] = s;
  const names = Object.keys(byName).sort();
  console.log('  skills listed:', names.join(', ') || '(none)');
  if (!byName['verify-local-skill']) fail('the agent dir skill is not listed');
  if (!byName['verify-agents-skill']) fail('the ~/.agents/skills skill is not listed (issue #64)');
  if (byName['not-a-skill']) fail('a directory without SKILL.md was listed as a skill');
  if (byName['verify-local-skill'].source !== 'local') fail('the agent dir skill has the wrong source: ' + byName['verify-local-skill'].source);
  if (byName['verify-agents-skill'].source !== 'agents') fail('the ~/.agents skill has the wrong source: ' + byName['verify-agents-skill'].source);
  if (!byName['verify-project-skill']) fail('the project skill is not listed');
  if (byName['verify-project-skill'].writable !== false) fail('a project skill is marked writable');
  if (byName['verify-project-skill'].source !== 'project') fail('the project skill has the wrong source');
  console.log('  sources: agent dir + ~/.agents + project, and a non-skill directory is ignored');

  /* ── the roots it looked in are reported (issue #90) ──────────────── */
  if (!Array.isArray(d.skillRoots)) fail('the API does not say where it looked for skills');
  const rootLocal = d.skillRoots.find((r) => r.source === 'local');
  const rootAgents = d.skillRoots.find((r) => r.source === 'agents');
  const rootProject = d.skillRoots.find((r) => r.source === 'project' && r.dir.endsWith(path.join('.pi', 'skills')));
  if (!rootLocal || rootLocal.count !== 1) fail('the agent-dir root is not reported with its count: ' + JSON.stringify(d.skillRoots));
  if (!rootAgents || rootAgents.count !== 1) fail('the ~/.agents root is not reported with its count: ' + JSON.stringify(d.skillRoots));
  if (rootAgents.dir !== path.join(homeDir, '.agents', 'skills')) fail('the ~/.agents root path is wrong: ' + rootAgents.dir);
  if (!rootProject || rootProject.count !== 1) fail('the project .pi/skills root is not reported with its count: ' + JSON.stringify(d.skillRoots));
  console.log('  roots reported:', d.skillRoots.map((r) => `${r.label}=${r.count}`).join(' '));

  /* ── enable/disable writes the pattern pi resolves ─────────────────── */
  const off = await postJson('/api/pi-extensions/toggle', { type: 'skills', name: 'verify-agents-skill', source: 'agents', enabled: false });
  if (off.status !== 200) fail('disabling the ~/.agents skill failed: HTTP ' + off.status + ' ' + JSON.stringify(off.body));
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (!Array.isArray(settings.skills) || !settings.skills.includes('-skills/verify-agents-skill')) {
    fail('settings.json does not hold pi\'s own pattern: ' + JSON.stringify(settings.skills));
  }
  const afterOff = await getJson('/api/pi-extensions');
  const got = afterOff.skills.find((s) => s.name === 'verify-agents-skill');
  if (!got || got.enabled !== false) fail('the ~/.agents skill still reports enabled after the toggle');
  console.log('  disable wrote "skills/verify-agents-skill" and the list reports it disabled');

  /* ── the two paths that must stay closed ───────────────────────────── */
  const delAgents = await postJson('/api/pi-extensions/delete', { type: 'skills', name: 'verify-agents-skill', source: 'agents' });
  if (delAgents.status !== 400) fail('deleting a ~/.agents skill was allowed (HTTP ' + delAgents.status + ')');
  if (!fs.existsSync(path.join(homeDir, '.agents', 'skills', 'verify-agents-skill', 'SKILL.md'))) {
    fail('the ~/.agents skill was deleted even though the API answered 400');
  }
  const delProject = await postJson('/api/pi-extensions/delete', { type: 'skills', name: 'verify-project-skill', source: 'project' });
  if (delProject.status !== 400) fail('deleting a project skill was allowed (HTTP ' + delProject.status + ')');
  console.log('  ~/.agents and project skills cannot be deleted from the tab');

  /* ── the page renders all of it ────────────────────────────────────── */
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-skills-browser-'));
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--remote-debugging-port=' + DBG_PORT, '--user-data-dir=' + userDir,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let browserErr = '';
  child.stderr.on('data', (c) => { browserErr += c; });
  const cleanupBrowser = () => {
    try { child.kill(); } catch { /* gone */ }
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ }
  };
  process.on('exit', cleanupBrowser);

  let ver = null;
  for (let i = 0; i < 100; i++) {
    try {
      ver = await new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port: DBG_PORT, path: '/json/version' }, (r) => {
          let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
          r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
        }).on('error', rej);
      });
      break;
    } catch { await sleep(150); }
  }
  if (!ver) fail('browser never came up\n' + browserErr.slice(-400));

  const WS = require('./ws-min.js');
  const pages = await new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: DBG_PORT, path: '/json/list' }, (r) => {
      let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
  const ws = new WS(pages.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await ws.open();
  let id = 0; const pending = new Map(); const problems = [];
  ws.onmessage = (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails || {};
      problems.push(((e.exception && (e.exception.description || e.exception.value)) || e.text || '?'));
    }
  };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw');
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 100; i++) {
    if (await evalJs("typeof loadExtensionsTab === 'function' ? 1 : 0")) break;
    await sleep(250);
  }
  const page = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    await loadExtensionsTab();
    const box = $('ext-skills');
    const out = [...box.querySelectorAll('.prov-row')].map((r) => ({
      name: (r.querySelector('.prov-id') || {}).textContent || '',
      meta: (r.querySelector('.prov-meta') || {}).textContent || '',
      buttons: [...r.querySelectorAll('button')].map((b) => b.textContent),
    }));
    const where = box.querySelector('.prov-empty');
    return { rows: out, where: where ? where.textContent : '', whereTitle: where ? where.title : '' };
  })()))()`));
  const rows = page.rows;
  if (!/looked in:/.test(page.where)) fail('the tab does not say where it looked for skills: ' + JSON.stringify(page.where));
  if (!/~\/\.agents \(1\)/.test(page.where)) fail('the ~/.agents root is missing from the footer: ' + page.where);
  if (!page.whereTitle.includes(path.join(homeDir, '.agents', 'skills'))) fail('the footer does not name the ~/.agents path: ' + page.whereTitle);
  const row = (n) => rows.find((r) => r.name === n);
  console.log('  page rows:', JSON.stringify(rows));
  if (!row('verify-local-skill')) fail('the page does not show the agent dir skill');
  if (!row('verify-agents-skill')) fail('the page does not show the ~/.agents skill (issue #64)');
  if (!row('verify-project-skill')) fail('the page does not show the project skill');
  if (!row('verify-agents-skill').buttons.includes('enable')) {
    fail('the ~/.agents row has no enable button after the toggle: ' + JSON.stringify(row('verify-agents-skill')));
  }
  if (row('verify-project-skill').buttons.length) {
    fail('the project skill row offers buttons it cannot honour: ' + JSON.stringify(row('verify-project-skill')));
  }
  if (!/agent dir/.test(row('verify-local-skill').meta)) fail('the agent dir row does not name its source');
  if (/failed|error/i.test(rows.map((r) => r.meta).join(' '))) fail('a row reports an error state');
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));

  console.log('  PASS #64 skills load from the agent dir and ~/.agents; toggling writes pi\'s own pattern');
  cleanupBrowser();
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
