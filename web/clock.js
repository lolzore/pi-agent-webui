/*
 * The task clock: "total 1m 20s" under the composer, persisted per session so a
 * reload keeps counting. Split out of app.js (issue #263). Loaded before app.js;
 * the names stay global, so nothing else changed.
 */
'use strict';

/* ── the task clock (the number at the bottom) ───────────────────────────
 * "How long did that take?" means the whole task: from the message you sent to
 * the agent's last word, across every turn, tool call and compaction in between.
 * It is kept per session in localStorage, so a reload keeps counting instead of
 * starting over - and only sending a message starts a new one, because the
 * automatic continue after a compaction is the same task, not a new one. */
function startRunClock() {
  S.runStartTs = Date.now();
  S.runMs = null;
  saveSessionUi({ runStart: S.runStartTs, runMs: null });
  paintRunStat();
  ensureTick();
}
function finishRunClock(atMs) {
  if (!S.runStartTs) { paintRunStat(); return; }
  const end = Number(atMs) > S.runStartTs ? Number(atMs) : Date.now();
  S.runMs = Math.max(0, end - S.runStartTs);
  S.runStartTs = null;
  S.lastRun = { ms: S.runMs, ts: Date.now() };
  saveSessionUi({ runStart: null, runMs: S.runMs });
  paintRunStat();
  ensureTick();
}
function paintRunStat() {
  const stat = $('stat-turn');
  if (!stat) return;
  const live = !!S.runStartTs;
  const ms = live ? Date.now() - S.runStartTs : (S.runMs || 0);
  stat.classList.toggle('live', live);
  if (!ms && !live) { setText(stat, ''); stat.title = 'how long the task took'; return; }
  setText(stat, `total ${fmtElapsed(ms)}`);
  stat.title = live
    ? 'time since you sent your message — every turn, tool call and compaction counts'
    : 'how long the last task took, from your message to the agent’s last word';
}
/* The timestamp of the agent's last word: that is when a task ended, which is a
 * better boundary than "whenever this page noticed". */
function lastAssistantTs() {
  const b = [...chat.querySelectorAll('.msg.assistant')].pop();
  return b ? Number(b.dataset.ts) || 0 : 0;
}
/* After a reload: still running means keep counting from the same start; already
 * finished means show the number it stopped at. */
function restoreRunClock() {
  const kept = loadSessionUi();
  if (kept) {
    if (kept.runStart && !S.runStartTs) { S.runStartTs = kept.runStart; S.runMs = null; }
    else if (!S.runStartTs && !S.runMs && kept.runMs) S.runMs = kept.runMs;
  }
  // The page may have been away when it ended: the agent is idle now, so the
  // agent's last message is where the clock stopped.
  if (S.runStartTs && S.agentBusy === false && !S.compacting && !S.isStreaming) {
    const endTs = lastAssistantTs();
    if (endTs > S.runStartTs) finishRunClock(endTs);
  }
  paintRunStat();
  ensureTick();
}

function stampTurnTimer() {
  const start = S.turnStartTs;
  S.turnStartTs = null;
  if (!start) return;
  const ms = Date.now() - start;
  // Remembered so a later re-render (or a session reload) can put the total
  // back on the last message instead of losing it.
  S.lastTurn = { ms, ts: Date.now() };
  saveSessionUi({ lastTurn: S.lastTurn });
  const bubbles = chat.querySelectorAll('.msg.assistant .bubble');
  const bubble = bubbles.length ? bubbles[bubbles.length - 1] : null;
  if (!bubble) return;
  bubble.querySelectorAll('.turn-timer').forEach((n) => n.remove());
  bubble.appendChild(el('div', 'turn-timer', `turn took ${fmtElapsed(ms)}`));
}

/* The bottom indicator is the task clock now (see paintRunStat), so a turn
 * starting only has to make sure one is running. It used to be a per-turn
 * stopwatch here, which reset to zero on every assistant turn - so a task with
 * five turns never showed its real total, and a reload started over. */
function startTurnTimer() {
  paintRunStat();
  ensureTick();
  return () => {};
}
