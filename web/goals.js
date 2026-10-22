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

function startGoalPoll() {
  if (goalTimer) return;
  // The files change while the agent works. The poll is one small read on the
  // bridge, and it stops as soon as no goal is present.
  goalTimer = setInterval(() => { refreshGoals().catch(() => {}); }, 10000);
}

function stopGoalPoll() {
  if (goalTimer) { clearInterval(goalTimer); goalTimer = null; }
}

async function refreshGoals() {
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
    // for: the extension requires it for a contracted task.
    evidence = prompt(`Evidence for "${task.title || task.id}"\n\nIts verification contract:\n${task.contract}`, '') || '';
    if (!evidence.trim()) { toast('This task has a verification contract; evidence is required', 'warning'); return; }
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

function renderGoalBar() {
  const bar = $('goal-bar');
  if (!bar) return;
  const list = goalState && goalState.present ? (goalState.goals || []) : [];
  const goal = list.find((g) => g.focused) || list[0] || null;
  if (!goal) {
    bar.classList.add('hidden');
    bar.classList.remove('open', 'blocked', 'paused', 'complete');
    bar.innerHTML = '';
    stopGoalPoll();
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
