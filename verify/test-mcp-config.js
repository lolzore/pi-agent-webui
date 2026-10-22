/*
 * Issue #92: "Configuring MCP servers in the settings."
 *
 * pi reads user servers from <agent dir>/mcp.json and project servers from
 * <workspace>/.pi/mcp.json (trusted projects only), in the mcpServers shape
 * shared by other MCP clients. The Extensions tab now lists both and writes only
 * the user file - atomically, keeping keys it does not own, enforcing pi's own
 * rules (name characters, command-or-url, -/_ name collisions) and refusing to
 * touch a file it cannot parse. Project entries are read-only here.
 *
 * This runs its own bridge with a scratch agent dir and workspace, then drives
 * the API and the rendered tab (including adding a server through the form).
 *
 * Usage: node test-mcp-config.js <browserPath>
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
const PORT = 20800 + (process.pid % 400);
const DBG_PORT = 9500 + (process.pid % 200);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-mcp-'));
const agentDir = path.join(scratch, 'agent');
const homeDir = path.join(scratch, 'home');
const projectDir = path.join(scratch, 'project');
const userFile = path.join(agentDir, 'mcp.json');
const projectFile = path.join(projectDir, '.pi', 'mcp.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(homeDir, { recursive: true });
fs.mkdirSync(path.dirname(projectFile), { recursive: true });
fs.writeFileSync(path.join(agentDir, 'settings.json'), '{}');
fs.writeFileSync(userFile, JSON.stringify({
  someOtherKey: { keep: 'me' },
  mcpServers: {
    filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
    docs: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } },
  },
}, null, 2));
fs.writeFileSync(projectFile, JSON.stringify({
  mcpServers: { 'internal-tools': { enabled: false } },
}, null, 2));

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

  /* ── the listing: user and project, with pi's own semantics ────────── */
  const d = await getJson('/api/mcp');
  const by = {};
  for (const s of d.servers) by[s.name + '/' + s.source] = s;
  if (!by['filesystem/user']) fail('the stdio server is not listed: ' + JSON.stringify(d.servers));
  if (by['filesystem/user'].transport !== 'stdio' || by['filesystem/user'].command !== 'npx') fail('the stdio server is not described as stdio: ' + JSON.stringify(by['filesystem/user']));
  if (by['filesystem/user'].args.join(' ') !== '-y @modelcontextprotocol/server-filesystem .') fail('the args are wrong: ' + JSON.stringify(by['filesystem/user'].args));
  if (!by['docs/user'] || by['docs/user'].transport !== 'http' || by['docs/user'].headerKeys.join() !== 'Authorization') fail('the http server is not described right: ' + JSON.stringify(by['docs/user']));
  if (!by['internal-tools/project'] || by['internal-tools/project'].transport !== 'override' || by['internal-tools/project'].enabled !== false) fail('the project override is not listed: ' + JSON.stringify(by['internal-tools/project']));
  if (by['internal-tools/project'].writable !== false) fail('a project server is marked writable');
  if (d.file !== userFile || d.projectFile !== projectFile) fail('the files are not reported: ' + d.file + ' / ' + d.projectFile);
  if (d.errors.length) fail('the listing reports errors on a valid file: ' + JSON.stringify(d.errors));
  console.log('  listed: filesystem (stdio, user), docs (http, user), internal-tools (project override, read-only)');

  /* ── add keeps the keys it does not own ────────────────────────────── */
  const add = await postJson('/api/mcp/save', { name: 'fetch', entry: { command: 'uvx', args: ['mcp-server-fetch'] } });
  if (add.status !== 200) fail('adding a server failed: HTTP ' + add.status + ' ' + JSON.stringify(add.body));
  let file = JSON.parse(fs.readFileSync(userFile, 'utf8'));
  if (!file.mcpServers.fetch || file.mcpServers.fetch.command !== 'uvx') fail('the new server is not in mcp.json: ' + JSON.stringify(file));
  if (JSON.stringify(file.someOtherKey) !== JSON.stringify({ keep: 'me' })) fail('an unrelated key was dropped: ' + JSON.stringify(file));
  if (!file.mcpServers.filesystem || !file.mcpServers.docs) fail('an existing server was dropped: ' + JSON.stringify(file.mcpServers));
  console.log('  add: written atomically, unrelated keys and existing servers kept');

  /* ── pi's rules are enforced, not re-invented ──────────────────────── */
  const cases = [
    ['a name with a space', { name: 'bad name', entry: { command: 'x' } }],
    ['a slash in the name', { name: 'a/b', entry: { command: 'x' } }],
    ['command and url together', { name: 'both', entry: { command: 'x', url: 'https://x/mcp' } }],
    ['neither command nor url', { name: 'neither', entry: { enabled: false } }],
    ['non-string args', { name: 'badargs', entry: { command: 'x', args: [1] } }],
  ];
  for (const [what, body] of cases) {
    const r = await postJson('/api/mcp/save', body);
    if (r.status !== 400) fail(`${what} was accepted (HTTP ${r.status})`);
  }
  /* pi counts two names that differ only in - vs _ as one server, so the second
   * one is refused - with a name that really is a pair, not two unrelated ones. */
  const under = await postJson('/api/mcp/save', { name: 'file_system', entry: { command: 'x' } });
  if (under.status !== 200) fail('a plain underscore name was refused: ' + JSON.stringify(under.body));
  const collision = await postJson('/api/mcp/save', { name: 'file-system', entry: { command: 'x' } });
  if (collision.status !== 400) fail('the -/_ collision pi treats as one name was accepted (HTTP ' + collision.status + ')');
  await postJson('/api/mcp/delete', { name: 'file_system' });
  file = JSON.parse(fs.readFileSync(userFile, 'utf8'));
  if (Object.keys(file.mcpServers).sort().join() !== 'docs,fetch,filesystem') fail('a rejected save changed the file: ' + JSON.stringify(file.mcpServers));
  console.log('  rejected: bad names, command+url, neither, non-string args, the -/_ collision - file untouched');

  /* ── toggle writes pi's own shape, remove takes it out ─────────────── */
  const off = await postJson('/api/mcp/toggle', { name: 'fetch', enabled: false });
  if (off.status !== 200) fail('disabling failed: ' + JSON.stringify(off.body));
  file = JSON.parse(fs.readFileSync(userFile, 'utf8'));
  if (file.mcpServers.fetch.enabled !== false) fail('enabled:false was not written: ' + JSON.stringify(file.mcpServers.fetch));
  const on = await postJson('/api/mcp/toggle', { name: 'fetch', enabled: true });
  if (on.status !== 200) fail('re-enabling failed: ' + JSON.stringify(on.body));
  file = JSON.parse(fs.readFileSync(userFile, 'utf8'));
  if ('enabled' in file.mcpServers.fetch) fail('enabling left the default value in the file: ' + JSON.stringify(file.mcpServers.fetch));
  const projToggle = await postJson('/api/mcp/toggle', { name: 'internal-tools', enabled: true });
  if (projToggle.status !== 400) fail('a project server was toggled from this tab (HTTP ' + projToggle.status + ')');
  const del = await postJson('/api/mcp/delete', { name: 'fetch' });
  if (del.status !== 200) fail('removing failed: ' + JSON.stringify(del.body));
  file = JSON.parse(fs.readFileSync(userFile, 'utf8'));
  if (file.mcpServers.fetch) fail('the removed server is still in the file');
  const delProj = await postJson('/api/mcp/delete', { name: 'internal-tools' });
  if (delProj.status !== 400) fail('a project server was removed (HTTP ' + delProj.status + ')');
  const delMissing = await postJson('/api/mcp/delete', { name: 'never-existed' });
  if (delMissing.status !== 404) fail('removing a missing server answered ' + delMissing.status);
  console.log('  toggle writes enabled:false and drops it on re-enable; remove works; project entries refuse both');

  /* ── a hand-edited broken file is not overwritten ──────────────────── */
  fs.writeFileSync(userFile, '{ not json');
  const broken = await postJson('/api/mcp/save', { name: 'anything', entry: { command: 'x' } });
  if (broken.status !== 400) fail('a broken mcp.json was written over (HTTP ' + broken.status + ')');
  if (fs.readFileSync(userFile, 'utf8') !== '{ not json') fail('the broken file was changed');
  fs.writeFileSync(userFile, JSON.stringify({ someOtherKey: { keep: 'me' }, mcpServers: {
    filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
    docs: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } },
  } }, null, 2));
  console.log('  a file that does not parse is refused, not replaced');

  /* ── the tab renders it and can add a server ───────────────────────── */
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-mcp-browser-'));
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
  const rendered = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    await loadExtensionsTab();
    const rows = [...$('ext-mcp').querySelectorAll('.prov-row')].map((r) => ({
      id: (r.querySelector('.prov-id') || {}).textContent || '',
      meta: (r.querySelector('.prov-meta') || {}).textContent || '',
      buttons: [...r.querySelectorAll('button')].map((b) => b.textContent),
    }));
    const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

    /* Add through the dialog, exactly as a user would (issue #92). */
    $('btn-ext-mcp-add').click();
    const openedOnAdd = $('mcp-dialog').open;
    $('mcp-name').value = 'from-the-dialog';
    $('mcp-transport').value = 'stdio';
    $('mcp-command').value = 'npx';
    $('mcp-args').value = '-y some-mcp-server';
    $('mcp-env').value = 'TOKEN=abc';
    $('mcp-save').click();
    const closedAfterSave = await waitFor(() => !$('mcp-dialog').open, 5000);
    const added = await waitFor(() => [...$('ext-mcp').querySelectorAll('.prov-id')].some((e) => e.textContent === 'from-the-dialog'), 5000);

    /* Edit it: the dialog must prefill, and saving must keep what was not touched. */
    const row = [...$('ext-mcp').querySelectorAll('.prov-row')].find((r) => (r.querySelector('.prov-id') || {}).textContent === 'from-the-dialog');
    const editBtn = row && [...row.querySelectorAll('button')].find((b) => b.textContent === 'edit');
    if (editBtn) editBtn.click();
    const openedOnEdit = $('mcp-dialog').open;
    const prefilled = { name: $('mcp-name').value, command: $('mcp-command').value, args: $('mcp-args').value, env: $('mcp-env').value };
    $('mcp-args').value = '-y some-mcp-server --extra';
    $('mcp-save').click();
    await waitFor(() => !$('mcp-dialog').open, 5000);

    /* A rejected name stays in the dialog, with the reason next to the field. */
    $('btn-ext-mcp-add').click();
    $('mcp-name').value = 'bad name';
    $('mcp-command').value = 'x';
    $('mcp-save').click();
    await new Promise((r) => setTimeout(r, 600));
    const errorShown = !$('mcp-dialog-error').classList.contains('hidden');
    const errorText = $('mcp-dialog-error').textContent;
    const stillOpen = $('mcp-dialog').open;
    $('mcp-cancel').click();

    return {
      rows,
      count: $('ext-mcp-count').textContent,
      file: $('ext-mcp-file').textContent,
      after: [...$('ext-mcp').querySelectorAll('.prov-id')].map((e) => e.textContent),
      openedOnAdd, closedAfterSave, added, openedOnEdit, prefilled, errorShown, errorText, stillOpen,
    };
  })()))()`));
  const rowOf = (n) => rendered.rows.find((r) => r.id === n);
  if (!rowOf('filesystem') || !/stdio/.test(rowOf('filesystem').meta)) fail('the tab does not show the stdio server: ' + JSON.stringify(rendered.rows));
  if (!rowOf('docs') || !/http/.test(rowOf('docs').meta)) fail('the tab does not show the http server');
  if (!rowOf('internal-tools') || !/read-only here/.test(rowOf('internal-tools').meta) || rowOf('internal-tools').buttons.length) {
    fail('the project server is not shown read-only: ' + JSON.stringify(rowOf('internal-tools')));
  }
  if (!rendered.openedOnAdd) fail('the add button did not open the dialog');
  if (!rendered.closedAfterSave) fail('the dialog stayed open after saving');
  if (!rendered.added) fail('adding through the dialog did not show up: ' + JSON.stringify(rendered.after));
  if (!rendered.openedOnEdit) fail('the edit button did not open the dialog');
  if (rendered.prefilled.name !== 'from-the-dialog' || rendered.prefilled.command !== 'npx' || rendered.prefilled.args !== '-y some-mcp-server' || rendered.prefilled.env !== 'TOKEN=abc') {
    fail('the edit dialog did not prefill from the server: ' + JSON.stringify(rendered.prefilled));
  }
  if (!rendered.errorShown || !rendered.stillOpen) fail('a rejected name closed the dialog instead of showing the reason: ' + JSON.stringify(rendered));
  if (!/name/.test(rendered.errorText || '')) fail('the dialog error does not name the problem: ' + JSON.stringify(rendered.errorText));
  const viaForm = await getJson('/api/mcp');
  const added = viaForm.servers.find((s) => s.name === 'from-the-dialog');
  if (!added || added.command !== 'npx' || added.args.join(' ') !== '-y some-mcp-server --extra') {
    fail('the dialog did not write the server pi reads: ' + JSON.stringify(added));
  }
  if (!added.env || added.env.TOKEN !== 'abc') fail('editing dropped the env the dialog prefilled: ' + JSON.stringify(added.env));
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));

  console.log(`  tab: ${rendered.rows.length} rows, count "${rendered.count}", file shown; the dialog added, edited (env kept) and rejected a bad name`);
  console.log('  PASS #92 MCP servers list, add, edit and remove in pi\'s own mcp.json; project entries stay read-only');
  cleanupBrowser();
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
