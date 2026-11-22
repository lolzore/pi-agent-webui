/*
 * Issue #55: "Native integration for the 'goal-x' extension."
 *
 * goal-x publishes its dashboard through the generic widget API - box-drawing
 * meant for a terminal - and keeps its records under <workspace>/.pi/goals as
 * JSON followed by a markdown rendering. The WebUI used to print those TUI
 * lines into the browser widget bar. This runs its own bridge with a scratch
 * goals dir and checks the native surface: the focused goal, its task counts
 * and task list, a live refresh driven by the extension's own widget event, the
 * raw widget lines kept out of the bar, and a clean "no goals here" state.
 *
 * Usage: node test-goals.js <browserPath>
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
const PORT = 3088;
const DBG_PORT = 9380 + (process.pid % 200);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-goals-'));
const goalsDir = path.join(scratch, 'goals');
const goalSessionId = '11111111-2222-3333-4444-555555555555';
fs.mkdirSync(goalsDir, { recursive: true });
fs.mkdirSync(path.join(scratch, 'sessions'), { recursive: true });
const goalSessionFile = path.join(scratch, 'sessions', `2026-01-01T00-00-00-000Z_${goalSessionId}.jsonl`);
fs.writeFileSync(goalSessionFile, JSON.stringify({ type: 'session', id: goalSessionId, cwd: path.join(scratch, 'ws') }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const task = (id, title, status, extra) => Object.assign({ id, title, status }, extra || {});
function writeGoal(file, record) {
  // Exactly the shape serializeGoalFile() writes: the JSON record, then a
  // human-readable markdown tail. The tail deliberately contains braces and
  // quotes - the reader must stop at the record's own closing brace.
  const tail = '\n\n# Goal Prompt\n\n' + (record.objective || '') +
    '\n\n## Notes\n\nUse {curly} braces and "quotes" in prose - they are not JSON.\n';
  fs.writeFileSync(path.join(goalsDir, file), JSON.stringify(Object.assign({ version: 3 }, record), null, 2) + tail);
}

writeGoal('active_goal_20260101000000_goaltest1.md', {
  id: 'goaltest1',
  objective: 'Ship the native goal panel',
  status: 'active',
  autoContinue: true,
  sisyphus: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:10:00.000Z',
  usage: { tokensUsed: 1234, activeSeconds: 60 },
  scheduler: { owner: goalSessionId },
  taskList: {
    blockCompletion: false,
    tasks: [
      task('t1', 'Design the bar', 'complete', { completedAt: '2026-01-01T00:05:00.000Z', evidence: 'looks right in the screenshot', verificationContract: 'screenshot attached' }),
      task('t2', 'Wire the poll', 'pending', { verificationContract: 'the bar updates' }),
      task('t3', 'Write the test', 'skipped'),
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
  const req = http.get({ host: '127.0.0.1', port, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  });
  req.on('error', rej);
});

(async () => {
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_SESSION_DIR: path.join(scratch, 'sessions'),
      WORKSPACE_DIR: path.join(scratch, 'ws'),
      PI_SESSION_DIR: path.join(scratch, 'sessions'),
      PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'),
      PI_GOALS_DIR: goalsDir,
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      // The goal belongs to this session; the page must still show its bar and
      // focus menu only here.
      PI_MOCK_SESSION_FILE: goalSessionFile,
      PI_LLAMA_SCAN: 'off',
      PORT: String(PORT),
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let bridgeErr = '';
  bridge.stderr.on('data', (c) => { bridgeErr += c; });
  fs.mkdirSync(path.join(scratch, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(scratch, 'ws'), { recursive: true });
  fs.mkdirSync(path.join(scratch, 'sessions'), { recursive: true });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const d = await getJson(PORT, '/api/health'); if (d && d.ok) { up = true; break; } } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('the scratch bridge never came up\n' + bridgeErr.slice(-500));

  /* ── the API shape ────────────────────────────────────────────────────── */
  const d = await getJson(PORT, '/api/goals');
  const goal = (d.goals || []).find((g) => g.id === 'goaltest1');
  const other = (d.goals || []).find((g) => g.id === 'other1');
  console.log('  api: present=' + d.present + ' focused=' + d.focused + ' goals=' + (d.goals || []).length);
  if (!d.ok || !d.present) fail('the goals endpoint reports no goal-x state: ' + JSON.stringify(d).slice(0, 200));
  if (d.focused !== 'goaltest1') fail('the focused goal is wrong: ' + d.focused);
  if (!goal) fail('the focused goal record is missing');
  if (goal.objective !== 'Ship the native goal panel') fail('the objective is wrong: ' + JSON.stringify(goal.objective));
  if (JSON.stringify(goal.counts) !== JSON.stringify({ total: 3, complete: 1, pending: 1, skipped: 1, inProgress: 0 })) {
    fail('the task counts are wrong: ' + JSON.stringify(goal.counts));
  }
  if (!goal.tasks.find((t) => t.id === 't1' && t.status === 'complete' && /looks right/.test(t.evidence || ''))) {
    fail('a completed task lost its evidence: ' + JSON.stringify(goal.tasks));
  }
  if (goal.focused !== true || !other || other.focused !== false) fail('focused flags are wrong');
  if (goal.sessionId !== goalSessionId || goal.sessionPath !== goalSessionFile) {
    fail('the goal does not point back at the session it was started in: ' + JSON.stringify({ id: goal.sessionId, path: goal.sessionPath }));
  }
  console.log('  api: objective, counts (1/3 + 1 skipped), evidence and origin session parsed');

  /* ── the page ─────────────────────────────────────────────────────────── */
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-goals-browser-'));
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
  for (let i = 0; i < 100; i++) { try { ver = await getJson(DBG_PORT, '/json/version'); break; } catch { await sleep(150); } }
  if (!ver) fail('browser never came up\n' + browserErr.slice(-400));

  const WS = require('./ws-min.js');
  const page = (await getJson(DBG_PORT, '/json/list')).find((t) => t.type === 'page');
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
  const waitFor = async (expr, ms, what) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await evalJs(expr)) return true;
      await sleep(200);
    }
    fail(what);
  };
  await send('Runtime.enable'); await send('Page.enable');
  /* Issue #207 is a breakpoint bug: at the default headless width the two
   * boxes are identical, so exercise the <760px layout where the composer
   * padding (and therefore the goal bar) changes. */
  await send('Emulation.setDeviceMetricsOverride', { width: 756, height: 700, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await waitFor("typeof refreshGoals === 'function' && typeof handleRpcMessage === 'function' ? 1 : 0", 20000, 'the page never loaded');
  await evalJs("document.querySelectorAll('dialog[open]').forEach((d) => { try { d.close(); } catch {} })");
  await waitFor("(() => { const b = document.getElementById('goal-bar'); return b && !b.classList.contains('hidden'); })()", 15000, 'the goal bar never appeared');

  const shown = JSON.parse(await evalJs(`JSON.stringify({
    text: document.getElementById('goal-bar').textContent,
    status: (document.querySelector('#goal-bar .goal-status') || {}).textContent,
    tasksHidden: document.querySelector('#goal-bar .goal-tasks').offsetParent === null,
    boxes: (() => {
      const g = document.getElementById('goal-bar').getBoundingClientRect();
      const s = document.getElementById('stats-bar').getBoundingClientRect();
      return { gx: Math.round(g.x), gw: Math.round(g.width), sx: Math.round(s.x), sw: Math.round(s.width) };
    })(),
  })`));
  console.log('  the bar reads:', JSON.stringify(shown.text.slice(0, 90)));
  if (!/Ship the native goal panel/.test(shown.text)) fail('the objective is not on the bar');
  if (!/1\/3 tasks/.test(shown.text)) fail('the task count is wrong on the bar: ' + JSON.stringify(shown.text));
  if (!/active/i.test(shown.status || '')) fail('the status is wrong on the bar: ' + JSON.stringify(shown.status));
  if (!shown.tasksHidden) fail('the task list was open before it was clicked');
  /* Issue #127: the bar shares the composer row's box, not the whole dock. */
  if (shown.boxes.sw > 0 && (Math.abs(shown.boxes.gx - shown.boxes.sx) > 2 || Math.abs(shown.boxes.gw - shown.boxes.sw) > 2)) {
    fail('the goal bar does not line up with the stats/composer row: ' + JSON.stringify(shown.boxes));
  }

  const opened = JSON.parse(await evalJs(`(() => {
    document.getElementById('goal-bar').click();
    const rows = [...document.querySelectorAll('#goal-bar .goal-task')];
    return JSON.stringify({
      count: rows.length,
      done: rows.filter((r) => r.classList.contains('done')).length,
      evidenceInTitle: /looks right/.test((rows[0] || {}).title || ''),
    });
  })()`));
  console.log('  clicking the bar shows', opened.count, 'tasks,', opened.done, 'marked done');
  if (opened.count !== 3) fail('the task list does not show all three tasks');
  if (opened.done !== 1) fail('the completed task is not marked done');
  if (!opened.evidenceInTitle) fail('the evidence is not available on the completed row');

  /* A live update: goal-x rewrites the file and emits its widget event. */
  const record2 = {
    version: 3, id: 'goaltest1', objective: 'Ship the native goal panel', status: 'active', autoContinue: true,
    scheduler: { owner: goalSessionId },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:20:00.000Z',
    taskList: { blockCompletion: false, tasks: [
      task('t1', 'Design the bar', 'complete', { evidence: 'looks right in the screenshot' }),
      task('t2', 'Wire the poll', 'complete', { evidence: 'the bar updates' }),
      task('t3', 'Write the test', 'pending'),
    ] },
  };
  writeGoal('active_goal_20260101000000_goaltest1.md', record2);
  // The real shape pi delivers: an extension_ui_request whose method is
  // setWidget (handleExtensionUi switches on req.method).
  await evalJs("handleRpcMessage({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'goal', widgetLines: ['\\u250c\\u2500\\u2500\\u2500\\u2500\\u2510', '\\u2502 goal 2/3 \\u2502', '\\u2514\\u2500\\u2500\\u2500\\u2500\\u2518'] })");
  let refreshed = false;
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 10000) {
      if (await evalJs("document.getElementById('goal-bar').textContent.includes('2/3 tasks')")) { refreshed = true; break; }
      await sleep(250);
    }
  }
  if (!refreshed) {
    const dbg = await evalJs(`(async () => JSON.stringify({
      bar: document.getElementById('goal-bar').textContent,
      hidden: document.getElementById('goal-bar').classList.contains('hidden'),
      state: goalState ? goalState.goals.map((g) => ({ id: g.id, focused: g.focused, counts: g.counts })) : null,
      fresh: await fetch('/api/goals', { cache: 'no-store' }).then((r) => r.json()).then((d) => d.goals.map((g) => ({ id: g.id, focused: g.focused, counts: g.counts }))),
    }))()`);
    fail('the bar did not refresh when goal-x emitted its widget event: ' + dbg);
  }
  const after = JSON.parse(await evalJs(`JSON.stringify({
    bar: document.getElementById('goal-bar').textContent,
    widget: (document.getElementById('widget-bar') || {}).textContent || '',
    widgetHidden: !document.getElementById('widget-bar') || document.getElementById('widget-bar').classList.contains('hidden'),
  })`));
  console.log('  after the widget event, the bar reads:', JSON.stringify(after.bar.slice(0, 70)));
  if (/[\\u250c\\u2502\\u2514]/.test(after.widget)) fail('the raw TUI widget lines reached the widget bar: ' + JSON.stringify(after.widget));
  if (!after.widgetHidden) fail('the widget bar is showing goal-x output it should not: ' + JSON.stringify(after.widget));

  /* goal-x also publishes the unfocused state as a status line. The native bar
   * already shows the same goal, count and focus control, so the hint must not
   * be copied into the status bar - that is the goal appearing twice. */
  await evalJs("handleRpcMessage({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'goal', statusText: 'goal: unfocused [3 open] - /goal-focus' })");
  await sleep(250);
  const goalStatus = JSON.parse(await evalJs(`JSON.stringify({
    text: (document.getElementById('status-bar') || {}).textContent || '',
    hidden: !document.getElementById('status-bar') || document.getElementById('status-bar').classList.contains('hidden'),
  })`));
  if (!goalStatus.hidden || /unfocused|goal:/i.test(goalStatus.text)) {
    fail('the unfocused goal hint was rendered in the status bar as well as the goal bar: ' + JSON.stringify(goalStatus));
  }
  console.log('  goal status stays in the native bar; no duplicate status line');

  /* A goal-select request that is delivered twice shows one menu; the answer
   * goes to both extension requests, and choosing a goal follows its session. */
  const selectResult = JSON.parse(await evalJs(`(async () => {
    const sent = [];
    const realSend = window.send;
    const realSwitch = window.switchToSession;
    let switched = null;
    window.send = (obj) => {
      if (obj && obj.type === 'extension_ui_response') sent.push(obj);
      else return realSend(obj);
    };
    window.switchToSession = async (p) => { switched = p; };
    await refreshGoals();
    const goal = (goalState.goals || []).find((g) => g.id === 'goaltest1');
    const label = '* goaltest1 | active | goal | Ship the native goal panel';
    handleRpcMessage({ type: 'extension_ui_request', id: 'goal-select-1', method: 'select', title: 'Focus open goal', options: [label] });
    handleRpcMessage({ type: 'extension_ui_request', id: 'goal-select-2', method: 'select', title: 'Focus open goal', options: [label] });
    const openAfterTwo = document.getElementById('ext-dialog').open;
    const select = document.querySelector('#ext-dialog-body select');
    select.value = label;
    // Reading another session read-only is the case where the goal's own
    // session is already the agent session but the view is elsewhere.
    S.viewSession = '/tmp/ui-goals-view.jsonl';
    document.getElementById('ext-dialog-ok').click();
    await new Promise((r) => setTimeout(r, 500));
    S.viewSession = null;
    window.send = realSend;
    window.switchToSession = realSwitch;
    return JSON.stringify({
      openAfterTwo,
      openAfterPick: document.getElementById('ext-dialog').open,
      sent,
      switched,
      expected: goal && goal.sessionPath,
    });
  })()`));
  if (!selectResult.openAfterTwo) fail('the duplicate goal select did not show its first dialog');
  if (selectResult.openAfterPick) fail('the goal select dialog stayed open after choosing');
  if (selectResult.sent.length !== 2 || selectResult.sent.some((r) => r.id !== 'goal-select-1' && r.id !== 'goal-select-2')) {
    fail('the duplicate goal select did not answer both extension requests: ' + JSON.stringify(selectResult.sent));
  }
  if (selectResult.sent.some((r) => r.value !== '* goaltest1 | active | goal | Ship the native goal panel')) {
    fail('the duplicate goal select answered with a different value: ' + JSON.stringify(selectResult.sent));
  }
  if (selectResult.switched !== selectResult.expected || !/2026-01-01T00-00-00-000Z_11111111/.test(selectResult.switched || '')) {
    fail('choosing a goal did not open the session it was started in: ' + JSON.stringify(selectResult));
  }
  console.log('  duplicate goal select: one dialog, both responses, and the goal\'s origin session opened');

  /* The same pool menu must not follow us into a session that does not own the
   * goal. The bar disappears too; the extension request is answered cancelled
   * so goal-x is not left waiting. */
  const awayResult = JSON.parse(await evalJs(`(async () => {
    const realSend = window.send;
    const sent = [];
    window.send = (obj) => {
      if (obj && obj.type === 'extension_ui_response') sent.push(obj);
      else return realSend(obj);
    };
    const was = S.state.sessionFile;
    S.state.sessionFile = '/tmp/ui-goals-other-session.jsonl';
    S.viewSession = null;
    // Render from the state we just set; a concurrent poll must not be part of
    // what this assertion is testing.
    renderGoalBar();
    const barHidden = document.getElementById('goal-bar').classList.contains('hidden');
    handleRpcMessage({ type: 'extension_ui_request', id: 'goal-away', method: 'select', title: 'Focus open goal',
      options: ['* goaltest1 | active | goal | Ship the native goal panel'] });
    await new Promise((r) => setTimeout(r, 250));
    const out = { barHidden, dialogOpen: document.getElementById('ext-dialog').open, sent };
    S.state.sessionFile = was;
    window.send = realSend;
    await refreshGoals();
    return JSON.stringify(out);
  })()`));
  if (!awayResult.barHidden) fail('the goal bar followed the goal into another session: ' + JSON.stringify(awayResult));
  if (awayResult.dialogOpen) fail('the goal focus menu followed the goal into another session: ' + JSON.stringify(awayResult));
  if (awayResult.sent.length !== 1 || awayResult.sent[0].cancelled !== true) {
    fail('the goal menu in the wrong session was not cancelled cleanly: ' + JSON.stringify(awayResult.sent));
  }
  console.log('  goal bar and goal menu stay on the session that owns the goal');

  /* No goal-x here: the bar goes away and nothing errors. */
  fs.renameSync(goalsDir, goalsDir + '-gone');
  await evalJs('refreshGoals()');
  await sleep(400);
  const absent = await evalJs("document.getElementById('goal-bar').classList.contains('hidden')");
  if (!absent) fail('the goal bar stayed up with no goals on disk');

  /* Issue #204: a reload must not need a new goal or a widget event to see the
   * goal again. Once the page had seen "no goals", the poll stopped, so a goal
   * that appeared (or reappeared) afterwards was invisible until something else
   * refreshed it. Put a goal back without calling refreshGoals() or emitting a
   * widget event, and wait for the page's own retry/poll. */
  fs.mkdirSync(goalsDir, { recursive: true });
  writeGoal('active_goal_20260101000100_reappeared.md', {
    id: 'reappeared',
    objective: 'Come back after a reload',
    status: 'active',
    scheduler: { owner: goalSessionId },
    updatedAt: '2026-01-01T00:11:00.000Z',
    taskList: { tasks: [task('r1', 'Notice the file', 'pending')] },
  });
  let reappeared = false;
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) {
      if (await evalJs("document.getElementById('goal-bar').textContent.includes('Come back after a reload')")) { reappeared = true; break; }
      await sleep(250);
    }
  }
  if (!reappeared) {
    const dbg = await evalJs(`(async () => JSON.stringify({
      bar: document.getElementById('goal-bar').textContent,
      hidden: document.getElementById('goal-bar').classList.contains('hidden'),
      state: goalState ? goalState.present : null,
      api: await fetch('/api/goals', { cache: 'no-store' }).then((r) => r.json()).then((d) => ({ present: d.present, ids: (d.goals || []).map((g) => g.id) })),
    }))()`);
    fail('a goal that appeared after a no-goal snapshot never showed up: ' + dbg);
  }
  console.log('  a goal written after the no-goal snapshot was picked up without an event');

  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));

  console.log('  PASS #55/#204 the goal bar renders goal-x state, updates live, recovers after a miss, and hides cleanly');
  cleanupBrowser();
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
