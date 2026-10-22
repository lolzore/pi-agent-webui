/*
 * Subagent runs: the panel, live snapshots, and which session they belong to.
 *
 * Split out of app.js (issue #54). Loaded before app.js; the names stay
 * global, so nothing else changed. Behaviour is unchanged.
 */
'use strict';

/* ── subagents ────────────────────────────────────────────────────────────
 * pi-subagents runs child agents inside the session. They are jobs with their
 * own goal, tool, turn and status, and while they run the transcript shows one
 * tool card - so a fan-out of four looks exactly like a single slow call. The
 * extension publishes a live snapshot of every run (as a widget line) and the
 * foreground progress arrives with the tool updates; both land here.
 *
 * What the panel shows per run: what it is (agent + label), what it is doing
 * (state, current tool, turns, tools), for how long, and - on a click - what it
 * has written so far, read from the extension's own artifact file. */
/* Tool names that run a child agent inside this session (the pi-subagents
 * extension registers `subagent`; `task` is the same idea under other names). */
const SUBAGENT_TOOLS = new Set(['subagent', 'task']);

const SUBAGENT_STATES = {
  queued: 'queued', running: 'running', pending: 'waiting', complete: 'done', completed: 'done',
  failed: 'failed', partial: 'partial', paused: 'paused', stopped: 'stopped', rejected: 'rejected',
  detached: 'in the background', stopping: 'stopping',
};

function subagentList() {
  const runs = S.subagents ? [...S.subagents.values()] : [];
  // Running first, then by when they started.
  return runs.sort((a, b) => {
    const ra = /running|pending|queued|stopping/.test(a.state || '') ? 0 : 1;
    const rb = /running|pending|queued|stopping/.test(b.state || '') ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return (b.startedAt || 0) - (a.startedAt || 0);
  });
}

function updateSubagentsBtn() {
  const btn = $('btn-subagents');
  if (!btn) return;
  const runs = subagentList();
  const live = runs.filter(isLiveRun).length;
  // Only ever on the session the runs came from (and while one of theirs is open).
  btn.classList.toggle('hidden', runs.length === 0);
  btn.classList.toggle('active', !!S.viewSubagent);
  const count = $('subagents-count');
  if (count) count.textContent = live ? `${live}` : `${runs.length}`;
  btn.classList.toggle('live', live > 0);
  btn.title = live
    ? `${live} subagent${live > 1 ? 's' : ''} running — click to see them`
    : `${runs.length} subagent${runs.length > 1 ? 's' : ''} finished in this session`;
}

function noteSubagent(run) {
  if (!S.subagents) S.subagents = new Map();
  const id = String(run.id || '');
  if (!id) return;
  const cur = S.subagents.get(id) || {};
  S.subagents.set(id, { ...cur, ...run, id, updatedAt: Date.now() });
  updateSubagentsBtn();
}

function setSubagentSnapshot(d) {
  if (!d || !Array.isArray(d.runs)) return;
  const seen = new Set();
  const walk = (node, parent) => {
    if (!node || !node.id) return;
    seen.add(String(node.id));
    const act = node.activity || {};
    noteSubagent({
      id: node.id,
      label: node.label || node.name || act.label || 'subagent',
      kind: node.kind || 'subagent',
      state: node.state || act.state || 'running',
      startedAt: node.startedAt || (S.subagents.get(String(node.id)) || {}).startedAt || Date.now(),
      endedAt: node.endedAt || null,
      currentTool: act.currentTool || null,
      turnCount: act.turnCount || 0,
      toolCount: act.toolCount || 0,
      lastActivityAt: node.updatedAt || act.lastActivityAt || null,
      parent: parent || null,
      background: true,
    });
    for (const kid of node.children || []) walk(kid, String(node.id));
  };
  for (const r of d.runs) walk(r, null);
  // A background run that is no longer in the snapshot has ended (the extension
  // drops it once it is finished and delivered).
  for (const [id, run] of [...S.subagents]) {
    if (run.background && !run.fromDisk && !seen.has(id) && isLiveRun(run)) {
      noteSubagent({ id, state: run.endedAt ? run.state : 'done' });
    }
  }
  if (S.subagentMenuOpen) refreshSubagentMenu();
}

function noteSubagentInspect(d) {
  if (!d) return;
  const id = String(d.asyncId || d.runId || d.id || '');
  if (!id) return;
  noteSubagent({ id, output: d.finalOutput || d.output || '', task: d.task || '', label: d.label || d.agent || '' });
}

/* Bytes as something a person reads: KB while that is meaningful, then MB, then
 * GB. A session at 30 MB was shown as "30720.0 KB". */
function fmtElapsedShort(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

function subagentHint(r) {
  const parts = [];
  const state = SUBAGENT_STATES[r.state] || r.state || 'running';
  const live = isLiveRun(r);
  if (!!S.viewSubagent && String(S.viewSubagent.id) === String(r.id)) parts.push('open');
  if (live) parts.push(state);
  else if (state !== 'done') parts.push(state);
  if (r.currentTool) parts.push(r.currentTool);
  if (r.turnCount) parts.push(`${r.turnCount} turn${r.turnCount > 1 ? 's' : ''}`);
  if (r.toolCount) parts.push(`${r.toolCount} tool${r.toolCount > 1 ? 's' : ''}`);
  // Which model the run used (issue #129): pi-subagents picks it per call/role,
  // and the bridge already reports it in the run's status.
  if (r.model) parts.push(r.model);
  // How long it has been running, or how long it took: the panel is repainted
  // once a second while a run is live, so this counts up in front of you.
  const startedAt = r.startedAt || 0;
  const endedAt = r.endedAt || 0;
  const spent = startedAt ? (live || !endedAt ? Date.now() - startedAt : endedAt - startedAt) : 0;
  if (spent > 2000) parts.push(live ? `${fmtElapsedShort(spent)} so far` : `took ${fmtElapsedShort(spent)}`);
  if (r.currentTool && r.currentToolStartedAt) parts.push(`${fmtElapsedShort(Date.now() - r.currentToolStartedAt)} on it`);
  if (r.totalTokens && r.totalTokens.total) parts.push(`${Math.round(r.totalTokens.total / 1000)}K tok`);
  if (!live && r.error) parts.push(String(r.error).slice(0, 60));
  if (r.background) parts.push('background');
  return parts.join(' · ');
}

function openSubagentsMenu(anchor) {
  S.subagentMenuOpen = true;
  refreshSubagents(true).catch(() => {});   // fresh, not from the last poll
  ensureTick();
  const runs = subagentList();
  const items = [];
  // While a child's conversation is open, this is how you get back.
  if (S.viewSubagent) {
    items.push({ label: '← back to the conversation', hint: `return to the session “${S.viewSubagent.label || 'subagent'}” belongs to`, onPick: () => backFromSubagent() });
    items.push({ sep: true });
  }
  items.push(...runs.map((r) => ({
    id: `subagent:${r.id}`,
    label: r.label || 'subagent',
    hint: subagentHint(r),
    dot: isLiveRun(r) ? 'live-dot' : (/failed|rejected/.test(r.state || '') ? 'off-dot' : null),
    keepOpen: true,
    onPick: () => openSubagentView(r),
  })));
  items.push({ sep: true });
  items.push({ label: 'refresh the list', hint: 're-read what the extension published', onPick: () => { updateSubagentsBtn(); refreshSubagentMenu(); } });
  const menu = openMenu(anchor, items, { title: `subagents (${runs.length})`, width: 460, force: true, align: 'right' });
  if (menu) {
    menu._subagents = true;
    menu.addEventListener('remove', () => { S.subagentMenuOpen = false; });
    // The menu is rebuilt from what is known now; a run that finishes while it is
    // open updates in place (see refreshSubagentMenu).
    const obs = new MutationObserver(() => { if (!menu.isConnected) { S.subagentMenuOpen = false; obs.disconnect(); } });
    obs.observe(document.body, { childList: true });
  }
}

function refreshSubagentMenu() {
  const menu = openMenuEl && openMenuEl._subagents ? openMenuEl : null;
  if (!menu) return;
  const byId = new Map(subagentList().map((r) => [`subagent:${r.id}`, r]));
  for (const row of menu.querySelectorAll('.model-item[data-menu-id]')) {
    const r = byId.get(row.dataset.menuId);
    if (!r) continue;
    const hint = row.querySelector('.model-provider');
    if (hint) hint.textContent = subagentHint(r);
    const label = row.querySelector('.model-label');
    if (label) label.textContent = r.label || 'subagent';
  }
  updateSubagentsBtn();
}

/* Turning off the thinking and tool-call blocks left their messages behind as
 * bare headers with token counts - a column of empty boxes. A message with nothing
 * visible left is marked and hidden. */
function bubbleHasVisibleText(bubble, hideThinking, hideTools) {
  // An error block is the whole content of a failed turn, and it must count as
  // visible or markHollowMessages() would hide the one thing worth reading (#59).
  if (bubble.querySelector('.msg-error')) return true;
  for (const n of bubble.querySelectorAll('.md, .md *')) {
    if (hideThinking && n.closest('details.thinking')) continue;
    if (n.closest('.tool-card')) continue;              // cards count via the toggle below
    if (n.children.length) continue;                    // text sits in the leaves
    if ((n.textContent || '').trim()) return true;
  }
  return false;
}

function markHollowMessages() {
  const hideThinking = SET.showThinking === false;
  const hideTools = SET.showToolCalls === false;
  for (const m of chat.querySelectorAll('.msg.assistant')) {
    if (!hideThinking && !hideTools) { delete m.dataset.hollow; continue; }
    const bubble = m.querySelector('.bubble');
    if (!bubble) continue;
    const hasThinking = !!bubble.querySelector('details.thinking, .thinking');
    const hasTools = !!bubble.querySelector('.tool-card');
    const visible = bubbleHasVisibleText(bubble, hideThinking, hideTools)
      || (hasThinking && !hideThinking)
      || (hasTools && !hideTools);
    if (visible) delete m.dataset.hollow;
    else m.dataset.hollow = '1';
  }
}

/* One transcript line as a readable block. */
function subagentLineHtml(entry) {
  const msg = entry && entry.message ? entry.message : entry;
  const role = (msg && (msg.role || msg.type)) || 'entry';
  let text = '';
  const content = msg && msg.content;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content.map((c) => (typeof c === 'string' ? c : (c && (c.text || c.thinking || c.output || '')) || '')).filter(Boolean).join('\n');
  } else if (msg && msg.summary) text = msg.summary;
  if (!text && msg && msg.command) text = `$ ${msg.command}\n${msg.output || ''}`;
  if (!text) { try { text = JSON.stringify(msg).slice(0, 4000); } catch { text = ''; } }
  const who = role === 'toolResult' ? `tool: ${msg.toolName || 'result'}` : role;
  const esc = (v) => String(v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  let body;
  if (/^(assistant|toolResult)$/.test(role)) {
    try { body = renderMarkdown(text); } catch { body = `<p>${esc(text)}</p>`; }
  } else body = `<p>${esc(text).replace(/\n/g, '<br>')}</p>`;
  return `<div class="sub-msg ${esc(role)}"><div class="sub-who">${esc(who)}</div><div class="sub-body">${body}</div></div>`;
}

/* Whatever the bridge found: a child's transcript becomes a conversation, anything
 * else is shown as text. Returns how many messages were rendered. */
function renderSubagentBody(body, text) {
  const raw = String(text || '').trim();
  if (raw.startsWith('{') && raw.includes('"role"')) {
    const entries = [];
    for (const line of raw.split('\n')) {
      const l = line.trim();
      if (!l.startsWith('{')) continue;
      try { entries.push(JSON.parse(l)); } catch { /* a torn last line */ }
    }
    const msgs = entries.filter((e) => e && (e.message || e.role || e.type === 'message'));
    if (msgs.length) {
      body.innerHTML = msgs.map(subagentLineHtml).join('');
      return msgs.length;
    }
  }
  body.textContent = raw || 'Nothing here yet.';
  return 0;
}

/* What a subagent wrote. The extension keeps one output file per run next to the
 * session, which the bridge can read (also inside a container), so this needs no
 * new protocol - and it does not disturb the running agent. */
async function showSubagentOutput(run) {
  const dlg = $('subagent-dialog');
  if (!dlg) { toast('No subagent dialog available', 'error'); return; }
  $('subagent-title').textContent = run.label || 'subagent';
  $('subagent-meta').textContent = subagentHint(run) || 'no details';
  const body = $('subagent-body');
  body.innerHTML = '';
  const q = `run=${encodeURIComponent(run.id)}&label=${encodeURIComponent(run.label || '')}`
    + (run.dir ? `&dir=${encodeURIComponent(run.dir)}` : '');
  if (!run.output) body.textContent = 'Loading what it wrote…';
  dlg.showModal();
  if (run.output) { renderSubagentBody(body, run.output); return; }
  try {
    const d = await fetch(api(`/api/subagent-output?${q}`)).then((r) => r.json());
    if (d && d.error) throw new Error(d.error);
    const text = (d && d.text) || '';
    const shown = renderSubagentBody(body, text);
    if (!text.trim()) body.textContent = 'Nothing written yet — a background run writes its log as it goes, and this panel reloads it.';
    else if (shown) $('subagent-meta').textContent = `${subagentHint(run)} · ${shown} messages${d.file ? ` · ${d.file}` : ''}`;
    else if (d.notes) $('subagent-meta').textContent = `${subagentHint(run)} · ${d.notes}`;
    run.output = text;
  } catch (e) {
    body.textContent = `Could not read this run's conversation: ${e.message}`;
  }
}

/* Fallback used when the run has no session file of its own (an older run, or an
 * agent that keeps no session): the same conversation, rendered from the
 * transcript artifact into the dialog. */

/* ── which session's subagents, and keeping them live ─────────────────────
 * A subagent belongs to the conversation that started it, so the panel only
 * appears there. The list is read from the bridge (one status.json per run),
 * which also means a reload brings the runs back instead of starting empty, and
 * that a run is up to date even while the parent is idle waiting for it. While a
 * child's own session is open the panel stays put - that is the way back. */
function subagentSessionKey() {
  if (S.viewSubagent) return S.viewSubagent.sessionId || S.state.sessionFile || '';
  return S.viewSession || (S.state && S.state.sessionFile) || '';
}
function isLiveRun(r) { return /running|pending|queued|stopping/.test((r && r.state) || ''); }

let subagentFetchAt = 0;
async function refreshSubagents(force) {
  const key = subagentSessionKey();
  if (!key) {
    // No session yet: nothing to attribute runs to, and "all runs on this
    // machine" is not an answer (it put the panel on sessions that never ran
    // one). Empty until we know.
    if (S.subagents && S.subagents.size) { S.subagents = new Map(); updateSubagentsBtn(); }
    else if (S.subagents) S.subagents = new Map();
    updateSubagentsBtn();
    return null;
  }
  const now = Date.now();
  if (!force && now - subagentFetchAt < 700) return null;   // the tick is 1s; the bridge caches too
  subagentFetchAt = now;
  let d;
  try {
    d = await fetch(api(`/api/subagent-runs?session=${encodeURIComponent(key)}`)).then((r) => r.json());
  } catch { return null; }
  if (!d || !Array.isArray(d.runs)) return null;
  if (subagentSessionKey() !== key) return null;   // the view changed while this was in flight
  if (!S.subagents) S.subagents = new Map();
  const seen = new Set();
  for (const r of d.runs) {
    const id = String(r.runId || '');
    if (!id) continue;
    seen.add(id);
    const cur = S.subagents.get(id) || {};
    noteSubagent({
      id,
      fromDisk: true,
      label: r.agent || cur.label || id.slice(0, 8),
      kind: 'subagent',
      state: r.state || cur.state,
      activityState: r.activityState || cur.activityState || null,
      currentTool: r.currentTool || cur.currentTool || null,
      currentToolStartedAt: r.currentToolStartedAt || cur.currentToolStartedAt || null,
      turnCount: r.turnCount || cur.turnCount || 0,
      toolCount: r.toolCount || cur.toolCount || 0,
      startedAt: r.startedAt || cur.startedAt || Date.now(),
      endedAt: r.endedAt || null,
      lastActivityAt: r.lastActivityAt || null,
      sessionFile: r.sessionFile || null,
      sessionId: r.sessionId || null,
      model: r.model || null,
      totalTokens: r.totalTokens || null,
      error: r.error || null,
      background: r.mode ? r.mode !== 'foreground' : true,
      task: cur.task || '',
      output: cur.output || '',
    });
  }
  // Runs the disk does not know about yet (the extension's widget reported them
  // first) stay until they show up there too.
  for (const [id, run] of [...S.subagents]) if (run.fromDisk && !seen.has(id)) S.subagents.delete(id);
  updateSubagentsBtn();
  if (S.subagentMenuOpen) refreshSubagentMenu();
  ensureTick();
  return d;
}

/* One timer for everything that has to move while you watch: the task clock, a
 * running subagent's elapsed time, and a child's session as it grows. Stopped
 * again as soon as nothing needs it. */
let uiTick = null;
function tickNeeded() {
  // This module loads before app.js, and transcript code can ask for the ticker
  // while the page is still parsing. S does not exist yet then; there is also
  // nothing to tick yet, so that is not an error.
  if (typeof S === 'undefined') return false;
  if (S.runStartTs) return true;
  if ($('setup-dialog') && $('setup-dialog').open) return true;   // the avatar preview fills in
  if (S.subagentMenuOpen || S.viewSubagent) return true;
  // a fresh render leaves the avatars in the wrong state until the ticker fixes it
  if (avatarAnimNeeded()) return true;
  // and while a group of avatars animates, the ticker is what keeps them on the
  // same frame - a second of drift is visible when they are side by side
  if (document.querySelectorAll('video.avatar').length > 1) return true;
  return subagentList().some(isLiveRun);
}
function ensureTick() {
  if (typeof S === 'undefined') return;
  if (tickNeeded() && !uiTick) uiTick = setInterval(onUiTick, 1000);
  else if (!tickNeeded() && uiTick) { clearInterval(uiTick); uiTick = null; }
}
function onUiTick() {
  paintRunStat();
  animateAvatarGroup();            // the newest messages keep the animated avatar
  syncAvatarVideos();              // and stay on the same frame
  if ($('setup-dialog') && $('setup-dialog').open) refreshSetupPreview();
  if (S.subagentMenuOpen || S.viewSubagent || subagentList().some(isLiveRun)) refreshSubagents().catch(() => {});
  if (S.subagentMenuOpen) refreshSubagentMenu();
  if (S.viewSubagent) refreshSubagentView().catch(() => {});
  ensureTick();
}

/* Nothing this page animates needs to run behind a tab nobody is looking at.
 * The 1s ticker, the video decoders and the background clip all keep going
 * otherwise, which is a third of the CPU a browser tab should be using while it
 * is parked next to a dozen others. Coming back re-reads the state that is
 * cheap to fetch and re-aligns everything that is not. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    if (uiTick) { clearInterval(uiTick); uiTick = null; }
    if (typeof pauseMediaWhenHidden === 'function') pauseMediaWhenHidden();
    return;
  }
  if (typeof pauseMediaWhenHidden === 'function') pauseMediaWhenHidden();
  ensureTick();
  if (typeof S !== 'undefined' && S.isStreaming) { refreshStats().catch(() => {}); refreshSubagents(true).catch(() => {}); }
  updateJumpTop();
});

/* A subagent runs in a session of its own - the run status records the file - so
 * opening one shows that conversation read-only in the same chat, with the way
 * back one click away (and the sub-agent list still in the top bar). */
let subagentViewAt = 0;
async function openSubagentView(run) {
  if (!run) return;
  const file = run.sessionFile;
  if (!file || !/\.jsonl$/i.test(file)) { showSubagentOutput(run); return; }   // nothing to open: the text panel
  closeAllMenus();
  // The agent may be mid-answer: park its live DOM first (exactly like switching
  // sessions does), otherwise its streaming message would be written into the
  // child's conversation.
  if (S.isStreaming && S.live) {
    const frag = document.createDocumentFragment();
    frag.appendChild(S.live.root);
    S.liveDetached = { path: S.state.sessionFile, frag };
  }
  S.viewSubagent = { ...run, sessionFile: file };
  S.viewSession = file;
  S.subagentViewCount = 0;
  S.stickToBottom = true;
  subagentViewAt = 0;
  await refreshSubagentView(true);
  updateViewBanner();
  updateSubagentsBtn();
  syncSessionHighlight();
  ensureTick();
}

async function backFromSubagent() {
  S.viewSubagent = null;
  S.viewSession = null;
  S.subagentViewCount = 0;
  await refreshMessages();
  updateViewBanner();
  updateSubagentsBtn();
  syncSessionHighlight();
  ensureTick();
}

/* Re-read the child's session while it is still writing, but only redraw when it
 * actually grew: a redraw on every tick would fight with scrolling. */
async function refreshSubagentView(force) {
  if (!S.viewSubagent) return;
  if (!force && Date.now() - subagentViewAt < 2500) return;
  subagentViewAt = Date.now();
  let d;
  try { d = await fetchSession(S.viewSubagent.sessionFile); } catch { return; }
  if (!S.viewSubagent) return;
  const n = (d.messages || []).length;
  if (!force && n === S.subagentViewCount) return;
  S.subagentViewCount = n;
  const distFromBottom = chatScroller().scrollHeight - chatScroller().scrollTop - chatScroller().clientHeight;
  releaseVideosIn(chat);          // a detached <video> keeps its decoder and buffers
  chat.innerHTML = '';
  transcriptTarget = chat;
  for (const m of d.messages) {
    if (m.role === 'user') renderUserMessage(m);
    else if (m.role === 'assistant') renderAssistantMessage(m);
    else if (m.role === 'toolResult') renderToolResult(m);
    else if (m.role === 'bashExecution') renderBashExecution(m);
    else if (m.role === 'compactionSummary') renderCompactionSummary(m);
  }
  transcriptTarget = null;
  if (S.stickToBottom && distFromBottom < 80) scrollBottom(true);
  updateViewBanner();
}
