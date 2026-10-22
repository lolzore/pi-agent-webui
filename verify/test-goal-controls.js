/*
 * Issue #81: interactive goal controls in the WebUI.
 *
 * The goal bar reads goal-x state (#55); these controls act on it. Pause,
 * resume and focus are goal-x's own commands, sent the way the composer sends
 * an extension command (a prompt pi routes to the command handler). Completing
 * or reopening a task has no command, so the bridge applies the extension's own
 * gates to the goal file - an active goal, evidence for a contracted task,
 * resolved non-lightweight children, completed tasks immutable - and then
 * /goal-refresh makes goal-x reload the file, which is its supported way of
 * picking up an external change.
 *
 * The mock agent emulates the four commands (pause/resume really change the
 * status in the workspace), so the RPC effect and the file effect are both
 * observable. This runs its own bridge with a scratch goals dir.
 *
 * Usage: node test-goal-controls.js <browserPath>
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
const PORT = 22200 + (process.pid % 300);
let DBG_PORT = 0;   // assigned from the browser's own DevTools line (see ws-min.js)
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-goalctl-'));
const wsDir = path.join(scratch, 'ws');
const goalsDir = path.join(wsDir, '.pi', 'goals');
const activeFile = path.join(goalsDir, 'active_goal_20260101000000_goaltest1.md');
fs.mkdirSync(goalsDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const task = (id, title, status, extra) => Object.assign({ id, title, status }, extra || {});
function writeGoal(file, record) {
  // The shape serializeGoalFile() writes: the JSON record, then a markdown tail
  // that deliberately contains braces and quotes.
  const tail = '\n\n# Goal Prompt\n\n' + (record.objective || '') +
    '\n\n## Notes\n\nUse {curly} braces and "quotes" in prose - they are not JSON.\n';
  fs.writeFileSync(path.join(goalsDir, file), JSON.stringify(Object.assign({ version: 3 }, record), null, 2) + tail);
}
writeGoal('active_goal_20260101000000_goaltest1.md', {
  id: 'goaltest1',
  objective: 'Ship the interactive goal controls',
  status: 'active',
  autoContinue: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:10:00.000Z',
  taskList: {
    blockCompletion: false,
    tasks: [
      task('t1', 'Add the controls', 'pending', { verificationContract: 'the buttons work' }),
      task('t2', 'Skipped earlier', 'skipped', { skipReason: 'not needed' }),
      task('t3', 'Already done', 'complete', { completedAt: '2026-01-01T00:05:00.000Z', evidence: 'done long ago' }),
      task('t4', 'Skipped for the bar', 'skipped', { skipReason: 'later' }),
      task('t5', 'Contracted, for the dialog', 'pending', { verificationContract: 'a screenshot' }),
      task('p1', 'Parent with open child', 'pending'),
      task('c1', 'Open child', 'pending', { parentId: 'p1' }),
      task('p2', 'Lightweight parent', 'pending', { lightweightSubtasks: true }),
      task('c2', 'Child of a lightweight parent', 'pending', { parentId: 'p2' }),
      task('p3', 'Lightweight parent for the bar', 'pending', { lightweightSubtasks: true }),
      task('c3', 'Open child of a lightweight parent', 'pending', { parentId: 'p3' }),
    ],
  },
});
writeGoal('goal_20260101000000_other1.md', {
  id: 'other1', objective: 'An older idea, not focused', status: 'paused', updatedAt: '2025-12-31T00:00:00.000Z',
  taskList: { tasks: [task('o1', 'Something else', 'pending')] },
});

let bridge = null;
const cleanup = () => {
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);

const getJson = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
const postJson = (port, p, body) => new Promise((res, rej) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { let d = {}; try { d = JSON.parse(b); } catch { /* */ } res({ status: r.statusCode, body: d }); });
  });
  req.on('error', rej);
  req.end(JSON.stringify(body || {}));
});
const record = () => {
  const t = fs.readFileSync(activeFile, 'utf8');
  const end = t.indexOf('\n}\n');
  return { rec: JSON.parse(t.slice(0, end + 2)), text: t };
};
const taskOf = (rec, id) => rec.taskList.tasks.find((x) => x.id === id) || {};

(async () => {
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_SESSION_DIR: path.join(scratch, 'sessions'),
      WORKSPACE_DIR: wsDir,
      PI_SESSION_DIR: path.join(scratch, 'sessions'),
      PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'),
      PI_GOALS_DIR: goalsDir,
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_LLAMA_SCAN: 'off',
      PORT: String(PORT),
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let bridgeErr = '';
  bridge.stderr.on('data', (c) => { bridgeErr += c; });
  fs.mkdirSync(path.join(scratch, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(scratch, 'sessions'), { recursive: true });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const d = await getJson(PORT, '/api/health'); if (d && d.ok) { up = true; break; } } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('the scratch bridge never came up\n' + bridgeErr.slice(-500));

  /* ── the gates, over the API ───────────────────────────────────────── */
  const noEv = await postJson(PORT, '/api/goals/task', { file: activeFile, taskId: 't1', status: 'complete' });
  if (noEv.status !== 400 || !/contract/i.test(noEv.body.error || '')) fail('a contracted task completed without evidence: ' + JSON.stringify(noEv));
  const done = await postJson(PORT, '/api/goals/task', { file: activeFile, taskId: 't1', status: 'complete', evidence: 'the buttons work - verified in the browser test' });
  if (done.status !== 200) fail('completing with evidence failed: ' + JSON.stringify(done.body));
  let { rec, text } = record();
  if (taskOf(rec, 't1').status !== 'complete' || !/buttons work/.test(taskOf(rec, 't1').evidence || '')) fail('the task was not completed in the file: ' + JSON.stringify(taskOf(rec, 't1')));
  if (!taskOf(rec, 't1').completedAt) fail('completedAt was not set');
  if (!/\{curly\} braces and "quotes"/.test(text)) fail('the markdown tail was lost');
  const again = await postJson(PORT, '/api/goals/task', { file: activeFile, taskId: 't3', status: 'complete' });
  if (again.status !== 400 || !/already complete/i.test(again.body.error || '')) fail('an already-complete task was completed again: ' + JSON.stringify(again));
  const reopen = await postJson(PORT, '/api/goals/task', { file: activeFile, taskId: 't2', status: 'pending' });
  if (reopen.status !== 200) fail('reopening a skipped task failed: ' + JSON.stringify(reopen.body));
  ({ rec } = record());
  if (taskOf(rec, 't2').status !== 'pending' || taskOf(rec, 't2').skipReason) fail('the skipped task was not reopened cleanly: ' + JSON.stringify(taskOf(rec, 't2')));
  const reDone = await postJson(PORT, '/api/goals/task', { file: activeFile, taskId: 't3', status: 'pending' });
  if (reDone.status !== 400 || !/skipped task can be reopened/i.test(reDone.body.error || '')) fail('a completed task was reopened: ' + JSON.stringify(reDone));
  const parent = await postJson(PORT, '/api/goals/task', { file: activeFile, taskId: 'p1', status: 'complete' });
  if (parent.status !== 400 || !/subtask/i.test(parent.body.error || '')) fail('a parent with an open child was completed: ' + JSON.stringify(parent));
  const light = await postJson(PORT, '/api/goals/task', { file: activeFile, taskId: 'p2', status: 'complete' });
  if (light.status !== 200) fail('a lightweight parent was refused: ' + JSON.stringify(light.body));
  const outside = await postJson(PORT, '/api/goals/task', { file: '/etc/passwd', taskId: 't1', status: 'complete' });
  if (outside.status !== 400) fail('a path outside the goals dir was accepted: ' + JSON.stringify(outside));
  writeGoal('goal_paused.md', { id: 'paused1', objective: 'Paused one', status: 'paused', taskList: { tasks: [task('x1', 'x', 'pending')] } });
  const notActive = await postJson(PORT, '/api/goals/task', { file: path.join(goalsDir, 'goal_paused.md'), taskId: 'x1', status: 'complete' });
  if (notActive.status !== 400 || !/active goal/i.test(notActive.body.error || '')) fail('a task in a paused goal was completed: ' + JSON.stringify(notActive));
  console.log('  gates: evidence for contracts, immutable completed tasks, reopen only skipped, resolved children, active goal only, no path escape');

  /* ── the controls in the bar ───────────────────────────────────────── */
  const WS = require('./ws-min.js');
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-goalctl-browser-'));
  const launched = WS.launchBrowser(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--user-data-dir=' + userDir,
    'about:blank',
  ]);
  const child = launched.child;
  let browserErr = '';
  child.stderr.on('data', (c) => { browserErr += c; });
  const cleanupBrowser = () => {
    try { child.kill(); } catch { /* gone */ }
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ }
  };
  process.on('exit', cleanupBrowser);
  try { DBG_PORT = await launched.port; } catch (e) { fail(e.message); }

  let page = null;
  for (let i = 0; i < 100; i++) {
    try {
      const list = await new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port: DBG_PORT, path: '/json/list' }, (r) => {
          let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
          r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
        }).on('error', rej);
      });
      if (Array.isArray(list)) { page = list.find((t) => t.type === 'page'); if (page) break; }
    } catch { /* not ready yet */ }
    await sleep(150);
  }
  if (!page) fail('browser never exposed a page on the debug port\n' + browserErr.slice(-400));
  const ws = new WS(page.webSocketDebuggerUrl);
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
    if (await evalJs("typeof refreshGoals === 'function' && typeof goalCommand === 'function' ? 1 : 0")) break;
    await sleep(250);
  }
  // Capture the commands the bar sends without sending them to the agent.
  await evalJs("(() => { window.__cmds = []; const real = window.sendPrompt; window.sendPrompt = (t, ...rest) => { window.__cmds.push(t); return real(t, ...rest); }; return true; })()");

  const bar = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    await refreshGoals();
    const b = $('goal-bar');
    if (!b.classList.contains('open')) b.click();
    const row = (id) => [...b.querySelectorAll('.goal-task')].find((r) => (r.querySelector('[data-goal-task]') || {}).dataset && r.querySelector('[data-goal-task]').dataset.goalTask === id);
    return {
      hidden: b.classList.contains('hidden'),
      status: (b.querySelector('.goal-status') || {}).textContent || '',
      pause: [...b.querySelectorAll('.goal-actions .btn')].map((x) => x.textContent),
      t1: row('t1') ? row('t1').textContent : null,
      t2: row('t2') ? row('t2').textContent : null,
      t3Button: row('t3') ? !!row('t3').querySelector('[data-goal-task]') : null,
      t4: row('t4') ? row('t4').textContent : null,
      t5: row('t5') ? row('t5').textContent : null,
      p1Disabled: row('p1') ? row('p1').querySelector('[data-goal-task]').disabled : null,
      p3Disabled: row('p3') ? row('p3').querySelector('[data-goal-task]').disabled : null,
    };
  })()))()`));
  if (bar.hidden) fail('the goal bar is hidden with a goal present');
  if (!/active/i.test(bar.status)) fail('the bar does not show the active status: ' + JSON.stringify(bar.status));
  if (!bar.pause.includes('pause')) fail('there is no pause control: ' + JSON.stringify(bar.pause));
  if (bar.t3Button) fail('a completed task still offers a button: ' + JSON.stringify(bar.t3Button));
  if (bar.p1Disabled !== true) fail('a parent with an open child is not disabled: ' + JSON.stringify(bar.p1Disabled));
  if (bar.p3Disabled !== false) fail('a lightweight parent is disabled: ' + JSON.stringify(bar.p3Disabled));
  if (!/reopen/.test(bar.t4 || '')) fail('a skipped task does not offer reopen: ' + JSON.stringify(bar.t4));
  if (!/done/.test(bar.t5 || '')) fail('a contracted task does not offer done: ' + JSON.stringify(bar.t5));
  console.log('  bar: pause control, done/reopen per task, completed task without a button, children gating shown');

  // pause -> the mock applies it to the file -> the bar shows paused -> resume.
  await evalJs("[...$('goal-bar').querySelectorAll('.goal-actions .btn')].find((b) => b.textContent === 'pause').click(); true");
  await sleep(800);
  const pausedCmd = await evalJs("window.__cmds.slice()");
  if (!pausedCmd.includes('/goal-pause')) fail('the pause control did not send /goal-pause: ' + JSON.stringify(pausedCmd));
  if (!/"status":\s*"paused"/.test(fs.readFileSync(activeFile, 'utf8'))) fail('the mock did not pause the goal file');
  await evalJs("(async () => { await refreshGoals(); return true; })()");
  const pausedBar = await evalJs("$('goal-bar').classList.contains('paused') ? 'paused' : $('goal-bar').querySelector('.goal-status').textContent");
  if (!/paus/i.test(pausedBar)) fail('the bar does not show paused after /goal-pause: ' + JSON.stringify(pausedBar));
  await evalJs("[...$('goal-bar').querySelectorAll('.goal-actions .btn')].find((b) => b.textContent === 'resume').click(); true");
  await sleep(800);
  const cmds2 = await evalJs("window.__cmds.slice()");
  if (!cmds2.includes('/goal-resume')) fail('the resume control did not send /goal-resume: ' + JSON.stringify(cmds2));
  if (!/"status":\s*"active"/.test(fs.readFileSync(activeFile, 'utf8'))) fail('the mock did not resume the goal file');
  console.log('  pause/resume: sent as goal-x commands, applied by the agent, reflected in the bar');

  // Reopen a skipped task from the bar.
  await evalJs("[...document.querySelectorAll('#goal-bar .goal-task')].map((r) => r.querySelector('[data-goal-task]')).find((b) => b && b.dataset.goalTask === 't4').click(); true");
  await sleep(600);
  if (taskOf(record().rec, 't4').status !== 'pending') fail('reopen from the bar did not change the file: ' + JSON.stringify(taskOf(record().rec, 't4')));
  // Complete one with no contract: no dialog.
  await evalJs("[...document.querySelectorAll('#goal-bar .goal-task')].map((r) => r.querySelector('[data-goal-task]')).find((b) => b && b.dataset.goalTask === 't2').click(); true");
  await sleep(600);
  if (taskOf(record().rec, 't2').status !== 'complete') fail('complete from the bar did not change the file: ' + JSON.stringify(taskOf(record().rec, 't2')));
  const cmds3 = await evalJs("window.__cmds.slice()");
  if (!cmds3.includes('/goal-refresh')) fail('no /goal-refresh after the task change: ' + JSON.stringify(cmds3));
  // A contracted task opens the native evidence dialog; the text lands in the file.
  await evalJs("window.__prompts = []; window.prompt = (q) => { window.__prompts.push(q); return 'evidence from the native dialog'; }; true");
  await evalJs("[...document.querySelectorAll('#goal-bar .goal-task')].map((r) => r.querySelector('[data-goal-task]')).find((b) => b && b.dataset.goalTask === 't5').click(); true");
  await sleep(600);
  const t5 = taskOf(record().rec, 't5');
  if (t5.status !== 'complete' || !/native dialog/.test(t5.evidence || '')) fail('the evidence dialog did not reach the file: ' + JSON.stringify(t5));
  const asked = await evalJs("window.__prompts.slice()");
  if (!asked.length || !/contract/i.test(asked[0])) fail('the dialog did not name the contract: ' + JSON.stringify(asked));
  console.log('  task controls: reopen, complete, and the native evidence dialog all wrote the file; /goal-refresh sent');

  // Focus: with no active_goal file the bar shows a pool goal and offers focus.
  fs.renameSync(activeFile, path.join(goalsDir, 'goal_goaltest1.md'));
  await evalJs("(async () => { await refreshGoals(); return true; })()");
  const focusBtn = await evalJs("(() => { const b = [...$('goal-bar').querySelectorAll('.goal-actions .btn')].find((x) => x.textContent === 'focus'); if (!b) return null; b.click(); return true; })()");
  if (!focusBtn) fail('no focus control when the shown goal is not focused');
  await sleep(300);
  const cmds4 = await evalJs("window.__cmds.slice()");
  if (!cmds4.includes('/goal-focus')) fail('the focus control did not send /goal-focus: ' + JSON.stringify(cmds4));
  console.log('  focus: sent /goal-focus for a goal that is not the focused one');

  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));
  console.log('  PASS #81 goal-x controls act on the file and the agent through goal-x\'s own commands');
  cleanupBrowser();
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
