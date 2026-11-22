/*
 * A resumed pi session can belong to a different project than the bridge's
 * WORKSPACE_DIR. goal-x reads <session cwd>/.pi/goals, so the WebUI has to read
 * the same directory or the native goal bar is empty while the extension still
 * asks "Focus open goal". The goal also records its owning session in
 * scheduler.owner; the endpoint turns that into a session path so choosing the
 * goal can open the conversation it came from.
 *
 * This starts a bridge whose WORKSPACE_DIR and PI_GOALS_DIR are a decoy, and
 * whose last-session file points at a session in another project with a real
 * goal. The endpoint must follow the session cwd.
 *
 * Usage: node test-goals-session-cwd.js
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
const ROOT = path.resolve(__dirname, '..');
const PORT = 24400 + (process.pid % 300);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-goals-cwd-'));
const sessions = path.join(scratch, 'sessions');
const ws = path.join(scratch, 'project');
const decoy = path.join(scratch, 'decoy');
const goalsDir = path.join(ws, '.pi', 'goals');
const decoyGoals = path.join(decoy, '.pi', 'goals');
const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const sessionFile = path.join(sessions, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
const lastFile = path.join(scratch, 'last.json');
for (const d of [sessions, goalsDir, decoyGoals, path.join(scratch, 'agent')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: sessionId, cwd: ws }) + '\n');
fs.writeFileSync(lastFile, JSON.stringify({ path: sessionFile, at: Date.now() }) + '\n');
const task = (id, title, status) => ({ id, title, status });
const record = {
  version: 3,
  id: 'cwd-goal-1',
  objective: 'A goal from the other project',
  status: 'paused',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:10:00.000Z',
  scheduler: { owner: sessionId },
  taskList: { tasks: [task('t1', 'One task', 'pending')] },
};
fs.writeFileSync(path.join(goalsDir, 'active_goal_20260101000000_cwdgoal1.md'), JSON.stringify(record, null, 2) + '\n');
const decoyRecord = { ...record, id: 'decoy-goal', objective: 'Should not be listed', scheduler: { owner: 'not-this-session' } };
fs.writeFileSync(path.join(decoyGoals, 'active_goal_20260101000000_decoy.md'), JSON.stringify(decoyRecord, null, 2) + '\n');

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_DIR: path.join(scratch, 'agent'),
      PI_CODING_AGENT_SESSION_DIR: sessions,
      PI_SESSION_DIR: sessions,
      WORKSPACE_DIR: decoy,
      PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: lastFile,
      // Deliberately a decoy; the session's own project must win when this is
      // absent. (The test sets it empty so the parent environment cannot leak.)
      PI_GOALS_DIR: '',
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_LLAMA_SCAN: 'off',
      PI_DOCKER: path.join(scratch, 'no-such-docker'),
      PORT: String(PORT),
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let berr = '';
  bridge.stderr.on('data', (c) => { berr += c; });
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { const d = await getJson('/api/health'); if (d && d.ok) { up = true; break; } } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('the scratch bridge never came up\n' + berr.slice(-500));
  const d = await getJson('/api/goals');
  const goal = (d.goals || []).find((g) => g.id === 'cwd-goal-1');
  console.log('  goals dir:', d.dir, 'goal:', goal && { id: goal.id, sessionId: goal.sessionId, sessionPath: goal.sessionPath });
  if (!goal) fail('the goal from the resumed session project was not listed: ' + JSON.stringify(d));
  if (d.dir !== goalsDir) fail('the endpoint read the decoy workspace instead of the session cwd: ' + d.dir);
  if (goal.sessionId !== sessionId) fail('the goal lost its scheduler owner: ' + JSON.stringify(goal.sessionId));
  if (goal.sessionPath !== sessionFile) fail('the goal does not resolve to its origin session: ' + JSON.stringify(goal.sessionPath));
  if ((d.goals || []).some((g) => g.id === 'decoy-goal')) fail('the decoy workspace goal leaked in');
  console.log('  PASS goal state follows the resumed session project and keeps its origin session');
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
