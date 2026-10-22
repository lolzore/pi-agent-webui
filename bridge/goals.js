/*
 * goal-x record reader (issue #55), split out of server.js as the first module
 * of the monolith break-up (issue #54).
 *
 * The extension keeps its goals under <workspace>/.pi/goals, one file per goal:
 * `active_goal_*` is the focused one, `goal_*` the rest of the pool. Each file
 * is the JSON record followed by the markdown rendering its own
 * serializeGoalFile() writes, so reading the leading JSON object is enough -
 * the tail is for people.
 */
'use strict';

const fs = require('fs');

/* The end of the first {...}, tracking strings and escapes: objectives
 * legitimately contain braces and quotes. Returns -1 for a file that does
 * not start with a record. */
function jsonEnd(text) {
  let depth = 0, inStr = false, esc = false, started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { started = true; depth++; continue; }
    if (ch === '}' && started && --depth === 0) return i;
  }
  return -1;
}

function readGoalRecord(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const end = jsonEnd(text);
  if (end < 0) return null;
  try { return JSON.parse(text.slice(0, end + 1)); } catch { return null; }
}

/* A compact shape for the page: counts and the task list without the auditor,
 * scheduler and ledger machinery the record also carries. */
function goalSummary(rec, focused, file) {
  const tasks = Array.isArray(rec && rec.taskList && rec.taskList.tasks) ? rec.taskList.tasks : [];
  const counts = { total: tasks.length, complete: 0, pending: 0, skipped: 0, inProgress: 0 };
  for (const t of tasks) {
    const s = String((t && t.status) || 'pending');
    if (s === 'complete') counts.complete++;
    else if (s === 'skipped') counts.skipped++;
    else if (s === 'in_progress' || s === 'in-progress') counts.inProgress++;
    else counts.pending++;
  }
  return {
    id: rec.id || null,
    objective: String(rec.objective || '').trim(),
    status: rec.status || 'unknown',
    focused: !!focused,
    sisyphus: !!rec.sisyphus,
    autoContinue: rec.autoContinue !== false,
    createdAt: rec.createdAt || null,
    updatedAt: rec.updatedAt || null,
    usage: rec.usage || null,
    pauseReason: rec.pauseReason || null,
    pauseSuggestedAction: rec.pauseSuggestedAction || null,
    blockCompletion: !!(rec.taskList && rec.taskList.blockCompletion),
    counts,
    tasks: tasks.map((t) => ({
      id: t.id || null,
      title: t.title || '',
      status: t.status || 'pending',
      completedAt: t.completedAt || null,
      evidence: t.evidence || null,
      contract: t.verificationContract || null,
      parentId: t.parentId || null,
      lightweightSubtasks: t.lightweightSubtasks === true,
    })),
    file,
  };
}

/* Change one task's status the way goal-x's own update_goal_task does (issue
 * #81). The gates are the extension's: an active goal, a real task, evidence
 * for a task with a verification contract, resolved children unless they are
 * lightweight, and "completed tasks are immutable" - pending only reopens a
 * skipped task.
 *
 * The record is rewritten in place: the JSON object is replaced, the markdown
 * tail the extension writes for people is kept, and the caller tells goal-x to
 * reload (/goal-refresh), which is the extension's own way of picking up an
 * external change. */
function setGoalTask(file, taskId, status, evidence) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { ok: false, error: 'goal file not found' }; }
  const end = jsonEnd(text);
  if (end < 0) return { ok: false, error: 'the goal file does not start with a JSON record' };
  let rec;
  try { rec = JSON.parse(text.slice(0, end + 1)); } catch { return { ok: false, error: 'the goal record does not parse' }; }
  if (String(rec.status || '') !== 'active') {
    return { ok: false, error: `the goal is ${rec.status || 'unknown'}; tasks can be changed on an active goal only` };
  }
  const tasks = rec && rec.taskList && Array.isArray(rec.taskList.tasks) ? rec.taskList.tasks : null;
  if (!tasks) return { ok: false, error: 'the goal has no task list' };
  const task = tasks.find((t) => t && t.id === taskId);
  if (!task) return { ok: false, error: `no task "${taskId}"` };
  const now = new Date().toISOString();
  const cur = String(task.status || 'pending');
  if (status === 'complete') {
    if (cur === 'complete') return { ok: false, error: `task "${taskId}" is already complete` };
    if (cur === 'skipped') return { ok: false, error: `task "${taskId}" was skipped; reopen it before completing it` };
    if (task.verificationContract && !String(evidence || '').trim()) {
      return { ok: false, error: `task "${taskId}" has a verification contract; evidence is required to complete it` };
    }
    if (task.lightweightSubtasks !== true) {
      const open = tasks.filter((t) => t && t.parentId === taskId && !['complete', 'skipped'].includes(String(t.status || 'pending')));
      if (open.length) return { ok: false, error: `${open.length} subtask${open.length > 1 ? 's' : ''} still open (${open.map((t) => t.id).join(', ')})` };
    }
    task.status = 'complete';
    task.completedAt = now;
    const ev = String(evidence || '').trim().slice(0, 200);
    if (ev) task.evidence = ev; else delete task.evidence;
  } else if (status === 'pending') {
    if (cur !== 'skipped') return { ok: false, error: `task "${taskId}" is ${cur}; only a skipped task can be reopened` };
    task.status = 'pending';
    delete task.completedAt;
    delete task.skippedAt;
    delete task.skipReason;
  } else {
    return { ok: false, error: 'status must be complete or pending' };
  }
  rec.updatedAt = now;
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + text.slice(end + 1));
    fs.renameSync(tmp, file);
  } catch (e) {
    return { ok: false, error: 'could not write the goal file: ' + e.message };
  }
  return { ok: true };
}

module.exports = { readGoalRecord, goalSummary, setGoalTask };
