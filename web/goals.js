/*
 * goal-x (issue #55): the native goal bar that reads /api/goals.
 *
 * Split out of app.js (issue #54). Loaded before app.js; the names stay
 * global, so nothing else changed. Behaviour is unchanged.
 */
'use strict';

/* ── goal-x (issue #55) ────────────────────────────────────────────────
 * The extension publishes its dashboard through the generic widget API and
 * keeps the records under <workspace>/.pi/goals. Its box-drawing does not
 * belong in the browser widget bar (one fixed height, plain text), so the
 * bridge reads the goal record and this renders the focused goal natively.
 * Click the bar for the task list. */
let goalState = null;
let goalTimer = null;
let goalSeq = 0;   // a slow older fetch must not overwrite a newer render
let goalMissRetries = 0;
let goalRetryTimer = null;

function startGoalPoll() {
  if (goalTimer) return;
  // The files change while the agent works. This used to stop as soon as the
  // page saw no goal, which made a transient miss permanent: a reload can ask
  // before the bridge can see the goal files (or while goal-x is rewriting
  // them), and then nothing ever asked again until a new goal/widget event.
  // Keep the small read going, but only while the page is visible.
  goalTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    refreshGoals().catch(() => {});
  }, 10000);
}

/* A reload can beat the bridge or goal-x to the files. Ask again a few times
 * quickly instead of waiting for the next ten-second poll, then fall back to
 * the poll - and keep polling even while no goal is present, because the goal
 * may appear (or reappear) later without an extension event. */
function retryGoalsSoon() {
  if (goalRetryTimer || goalMissRetries >= 4) return;
  goalMissRetries++;
  goalRetryTimer = setTimeout(() => {
    goalRetryTimer = null;
    if (document.visibilityState !== 'hidden') refreshGoals().catch(() => {});
  }, 400 * goalMissRetries);
}

async function refreshGoals() {
  startGoalPoll();
  const seq = ++goalSeq;
  let next = null;
  try {
    const d = await fetch(api('/api/goals'), { cache: 'no-store' }).then((r) => r.json());
    next = d && d.ok ? d : null;
  } catch { next = null; }
  // A poll and a widget event can overlap; the later call owns the bar.
  if (seq !== goalSeq) return;
  goalState = next;
  renderGoalBar();
  if (!next || !next.present) retryGoalsSoon();
  else goalMissRetries = 0;
}

/* ── goal-x controls (issue #81) ───────────────────────────────────────
 * The bar reads goal-x state; these act on it. Pause, resume and focus are the
 * extension's own commands, sent the way the composer sends any extension
 * command - a prompt pi routes to the command handler. Completing a task has no
 * command, so the bridge applies the extension's own gates to the goal file and
 * then /goal-refresh makes goal-x reload it (its supported way of picking up an
 * external change). */
function goalCommand(cmd) {
  if (typeof sendPrompt !== 'function') return;
  sendPrompt(cmd, [], undefined, false);
  toast(`${cmd} sent to the agent`);
}

async function goalTaskAction(goal, task, status) {
  let evidence = '';
  if (status === 'complete' && task.contract) {
    // A native evidence dialog, which is what the TUI tool's confirmation was
    // for: the extension requires it for a contracted task. askDialog(), not
    // window.prompt() - Electron does not implement prompt, so the desktop app
    // could never complete a contracted task.
    const out = await askDialog({
      title: `Evidence for “${task.title || task.id}”`,
      body: `Its verification contract:\n${task.contract}`,
      fields: [{ name: 'evidence', label: 'evidence', placeholder: 'how it was verified' }],
      require: ['evidence'],
      okLabel: 'complete',
    });
    if (!out) { toast('This task has a verification contract; evidence is required', 'warning'); return; }
    evidence = out.evidence;
  }
  try {
    const r = await fetch(api('/api/goals/task'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: goal.file, taskId: task.id, status, evidence }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || `request failed (${r.status})`);
    goalState = d;
    renderGoalBar();
    toast(`${task.id} ${status === 'complete' ? 'completed' : 'reopened'}`);
    goalCommand('/goal-refresh');
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* Which session owns this goal? The bridge normally resolves the full session
 * path; a comparison on the id also works in container mode, where the bridge
 * cannot list the container's session directory but the page has the path. */
function goalBelongsToSession(goal, current) {
  if (!goal || !current) return false;
  if (goal.sessionPath) return sameSessionPath(goal.sessionPath, current, S.sessionsList || []);
  return !!(goal.sessionId && String(current).includes(goal.sessionId));
}

function renderGoalBar() {
  const bar = $('goal-bar');
  if (!bar) return;
  if (S.agentMode === 'plain') {
    bar.classList.add('hidden');
    bar.classList.remove('open', 'blocked', 'paused', 'complete');
    bar.innerHTML = '';
    return;
  }
  const all = goalState && goalState.present ? (goalState.goals || []) : [];
  /* goal-x keeps a pool per project, not per session. The native surface is the
   * session's goal, so a goal recorded in another session must not follow the
   * reader around. A goal without a resolved session path is an old/foreign
   * record; keep it visible rather than hiding something we cannot classify. */
  const current = (S.state && S.state.sessionFile) || null;
  const list = all.filter((g) => goalBelongsToSession(g, current));
  const goal = list.find((g) => g.focused) || list[0] || null;
  if (!goal) {
    bar.classList.add('hidden');
    bar.classList.remove('open', 'blocked', 'paused', 'complete');
    bar.innerHTML = '';
    // Do not stop the poll: a goal can appear after this snapshot (the initial
    // read raced the bridge, or goal-x is about to write its files).
    retryGoalsSoon();
    return;
  }
  startGoalPoll();
  const c = goal.counts || {};
  const open = bar.classList.contains('open');
  bar.classList.remove('hidden', 'blocked', 'paused', 'complete');
  const status = String(goal.status || '').toLowerCase();
  if (/block/.test(status)) bar.classList.add('blocked');
  else if (/paus/.test(status)) bar.classList.add('paused');
  else if (/complete|done/.test(status)) bar.classList.add('complete');
  bar.classList.toggle('open', open);
  bar.innerHTML = '';
  const head = el('div', 'goal-head');
  head.appendChild(el('span', 'goal-status', goal.status || 'goal'));
  head.appendChild(el('span', 'goal-objective', goal.objective || '(no objective)'));
  const bits = [];
  if (c.total) bits.push(`${c.complete || 0}/${c.total} tasks`);
  if (c.inProgress) bits.push(`${c.inProgress} running`);
  if (goal.sisyphus) bits.push('sisyphus');
  head.appendChild(el('span', 'goal-count', bits.join(' · ')));
  const actions = el('div', 'goal-actions');
  const paused = /paus/i.test(status);
  const pause = el('button', 'btn small', paused ? 'resume' : 'pause');
  pause.title = paused ? 'Send /goal-resume to the agent' : 'Send /goal-pause to the agent';
  pause.onclick = (e) => { e.stopPropagation(); goalCommand(paused ? '/goal-resume' : '/goal-pause'); };
  actions.appendChild(pause);
  if (!goal.focused) {
    const focus = el('button', 'btn small', 'focus');
    focus.title = 'Send /goal-focus to the agent (goal-x picks when several are open)';
    focus.onclick = (e) => { e.stopPropagation(); goalCommand('/goal-focus'); };
    actions.appendChild(focus);
  }
  head.appendChild(actions);
  bar.appendChild(head);
  if (goal.pauseReason) bar.appendChild(el('div', 'goal-note', goal.pauseReason));
  if (goal.tasks && goal.tasks.length) {
    const tasks = el('div', 'goal-tasks');
    for (const t of goal.tasks) {
      const done = /complete/i.test(t.status || '');
      const skipped = /skip/i.test(t.status || '');
      const row = el('div', 'goal-task' + (done ? ' done' : ''));
      row.appendChild(el('span', 'gt-mark', done ? '\u2713' : skipped ? '\u2013' : '\u25cb'));
      row.appendChild(el('span', 'gt-title', t.title || t.id || ''));
      row.title = t.evidence ? `${t.title || ''}\n\n${t.evidence}` : (t.title || '');
      if (t.contract) row.title += `\n\nverification contract: ${t.contract}`;
      // goal-x's gates, shown before the click: a parent with open children
      // cannot be completed, and a contracted task needs evidence.
      const kids = (goal.tasks || []).filter((x) => x.parentId && x.parentId === t.id);
      const openKids = t.lightweightSubtasks ? [] : kids.filter((x) => !/complete|skip/i.test(x.status || ''));
      if (!done) {
        const b = el('button', 'btn small gt-action', skipped ? 'reopen' : 'done');
        b.dataset.goalTask = t.id || '';
        b.title = skipped ? 'Reopen this skipped task' : (t.contract ? 'Complete it (evidence required)' : 'Complete this task');
        if (openKids.length) {
          b.disabled = true;
          b.title = `${openKids.length} subtask${openKids.length > 1 ? 's' : ''} still open (${openKids.map((x) => x.id).join(', ')})`;
        }
        b.onclick = (e) => { e.stopPropagation(); goalTaskAction(goal, t, skipped ? 'pending' : 'complete'); };
        row.appendChild(b);
      }
      tasks.appendChild(row);
    }
    bar.appendChild(tasks);
  }
  bar.title = 'goal-x — click for the task list';
  bar.onclick = () => bar.classList.toggle('open');
}

function renderQueue() {
  const bar = $('queue-bar');
  const items = [...S.queue.steering.map((m) => ({ kind: 'steering', m })), ...S.queue.followUp.map((m) => ({ kind: 'after turn', m }))];
  if (!items.length) { setBarContent(bar, ''); bar.innerHTML = ''; return; }
  bar.dataset.hadContent = '1';   // see setBarContent: only a used bar keeps its height
  bar.classList.remove('hidden');
  bar.innerHTML = '';
  bar.appendChild(el('span', null, 'queued '));
  for (const { kind, m } of items) {
    const text = (typeof m === 'string' ? m : JSON.stringify(m || '')).slice(0, 120);
    const chip = el('span', 'queue-chip', `${kind}: ${text}`);
    bar.appendChild(chip);
  }
}
