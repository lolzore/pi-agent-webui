/*
 * Sessions: the sidebar, forks, folders.
 *
 * Split out of app.js (issue #54). Loaded before app.js; the names stay
 * global, so nothing else changed. Behaviour is unchanged.
 */
'use strict';

/* ───────────────────────── sessions ───────────────────────── */

/* Is this list row the session we mean? The path decides it. The file name is
 * only a fallback for the bridge reporting the same session with another
 * spelling, and only while that name is unique in the list: a subagent run
 * transcript is also called `session.jsonl`, and matching on the bare name
 * highlighted two dozen unrelated rows at once. */
function sameSessionPath(a, b, all) {
  if (!a || !b) return false;
  const A = String(a), B = String(b);
  if (A === B) return true;
  const an = A.split(/[\\/]/).pop(), bn = B.split(/[\\/]/).pop();
  if (an !== bn) return false;
  const same = (all || []).filter((s) => String((s && s.fileName) || '').split(/[\\/]/).pop() === an);
  return same.length === 1;
}

/* A cheap signature of the session list. renderSessions() throws the sidebar
 * away and builds it again, so calling it when nothing has changed is pure
 * waste - and it is called every twenty seconds by the idle poll, so most of
 * those calls changed nothing at all. */
function sessionsSignature(list) {
  let s = '';
  for (const x of list) s += `${x.path}\u0001${x.name}\u0001${x.size}\u0001${x.mtime}\u0001${x.parent || ''}\u0002`;
  return s;
}

async function refreshSessions(force) {
  try {
    const res = await fetch(api('/api/sessions'));
    const d = await res.json();
    const list = d.sessions || [];
    /* A scan the bridge could not complete says so (issue #30).
     *
     * The scan returning nothing used to be reported as an empty list, so a
     * session directory that could not be read looked exactly like an account
     * with no sessions - and in container mode that was the state for every
     * session, silently. One line above the list, shown once per distinct reason
     * rather than on every twenty-second poll. */
    if (d.scanError && S.scanErrorShown !== d.scanError) {
      S.scanErrorShown = d.scanError;
      toast(`Session list: ${d.scanError}`, 'error');
    } else if (!d.scanError) {
      S.scanErrorShown = null;
    }
    const sig = sessionsSignature(list);
    if (!force && sig === S.sessionsSig) { applyAgentStatus(d); return; }
    S.sessionsSig = sig;
    S.sessionsList = list;
    renderSessions(list);
    applyAgentStatus(d);
  } catch { /* ignore */ }
}

/* What the agent is doing, straight from the bridge: a reload in the middle of a
 * compaction used to look like a page where nothing ever happened. */
function applyAgentStatus(d) {
  if (!d) return;
  if ('busy' in d) S.agentBusy = !!d.busy;
  if (!('compacting' in d)) return;
  const c = d.compacting;
  const mine = !c || !c.session || !S.state.sessionFile || sameSessionPath(c.session, S.state.sessionFile, []);
  if (c && mine && !S.compacting) {
    S.compacting = true;
    if (!S.compactionLive) S.compactionLive = renderCompactionLive(c.since);
    else if (S.compactionLive.setSince) S.compactionLive.setSince(c.since);
    document.body.classList.add('compacting');
  } else if (!c && S.compacting) {
    // It finished while the page was away (or in another tab).
    S.compacting = false;
    S.compactionHappened = true;
    removeCompactionLive();
    document.body.classList.remove('compacting');
  }
  // The task clock: the agent is idle, so the task that was running when this page
  // was last here is done - it stopped at the agent's last message.
  if (S.agentBusy === false && S.runStartTs && !S.compacting) {
    const endTs = lastAssistantTs();
    if (endTs > S.runStartTs) finishRunClock(endTs);
    // No message after the clock started (the page was reloaded into a session
    // whose task ended long ago): there is no honest number to show, so drop it
    // rather than counting idle time.
    else if (!endTs || endTs < S.runStartTs) {
      S.runStartTs = null;
      S.runMs = null;
      saveSessionUi({ runStart: null, runMs: null });
      paintRunStat();
      ensureTick();
    }
  }
}

/* The blue highlight in the session list shows which session you are looking at,
 * so it has to be repainted the moment that changes. Switching sessions used to
 * leave the previous row highlighted (the list only re-rendered on the 20s poll),
 * which read as "the highlight is stuck on the session the agent is running in". */
/* Move the highlight without rebuilding the sidebar.
 *
 * This used to call `renderSessions()`, which throws the whole list away and
 * builds it again - every row, every folder, every fork arrow, the filter, the
 * sort - in order to move one class from one row to another. On a machine with
 * a few dozen sessions that is the difference between the highlight arriving
 * with the click and arriving a beat later, and it is the one thing in a session
 * switch that has to be instant: it is the answer to "did my click land".
 *
 * So the rows are walked and the class is moved. The rule for which row is
 * highlighted is the same one `renderSessions` uses - the session being viewed
 * when one is, otherwise the one the agent is in - so the two can never
 * disagree about where the blue edge is. */
function syncSessionHighlight() {
  const sessions = S.sessionsList || [];
  const cur = S.state.sessionFile;
  const viewed = S.viewSession || null;
  const rows = document.querySelectorAll('#session-list .session-item');
  for (const item of rows) {
    const path = item.dataset.path || '';
    const isCurrent = !!cur && sameSessionPath(path, cur, sessions);
    const isViewed = !!viewed && sameSessionPath(path, viewed, sessions);
    item.classList.toggle('active', viewed ? isViewed : isCurrent);
  }
}

/* ── folding a session's forks away ──────────────────────────────────────
 * Forks are rows under the session they came from. A parent with children gets
 * an arrow to fold them, so a session with a dozen branches still leaves the list
 * readable - and the fold is remembered per browser. */
function loadForkCollapse() {
  try { return JSON.parse(localStorage.getItem('piwebui-forks-collapsed') || '{}') || {}; } catch { return {}; }
}
function toggleForkCollapse(sessionPath) {
  if (!S.collapsedForks) S.collapsedForks = {};
  if (S.collapsedForks[sessionPath]) delete S.collapsedForks[sessionPath];
  else S.collapsedForks[sessionPath] = true;
  try { localStorage.setItem('piwebui-forks-collapsed', JSON.stringify(S.collapsedForks)); } catch { /* private mode */ }
  renderSessions(S.sessionsList || []);
}

/* What the sidebar is currently pointing at, by row identity rather than pixels.
 *
 * A pixel offset is not stable across a rebuild. Rows appear and disappear -
 * the pending row for "the session the agent is on" comes and goes as you
 * switch, a session that was just written to moves up the mtime order, a fork
 * gets added under its parent - and after any of those the same scrollTop points
 * at different content. That is issue #34: the sidebar appears to jump the moment
 * a switch lands, with the scroll position itself unchanged.
 *
 * So the anchor is the topmost visible row's path plus how far above the list's
 * top edge it is sitting. Restoring it puts that same row back under the same
 * pixel, whatever moved around it. */
function sessionListAnchor(list) {
  const top = list.getBoundingClientRect().top;
  for (const item of list.querySelectorAll('.session-item')) {
    const r = item.getBoundingClientRect();
    if (r.bottom > top + 1) return { path: item.dataset.path || null, off: Math.round(r.top - top) };
  }
  return null;
}

function restoreSessionListAnchor(list, anchor, fallbackScroll) {
  if (anchor && anchor.path) {
    const row = [...list.querySelectorAll('.session-item')].find((n) => n.dataset.path === anchor.path);
    if (row) {
      const top = list.getBoundingClientRect().top;
      const delta = Math.round(row.getBoundingClientRect().top - top) - anchor.off;
      if (delta) list.scrollTop += delta;
      return;
    }
    // The row itself is gone (deleted, filtered, or folded into a folder).
    // Falling back to the pixel position is the best available answer, and it is
    // clamped for us if the list got shorter.
  }
  list.scrollTop = fallbackScroll;
}

function renderSessions(sessions) {
  const list = $('session-list');
  const anchor = sessionListAnchor(list);
  const keepScroll = list.scrollTop;
  const filter = ($('session-filter').value || '').toLowerCase();
  // pi only writes the session file once something happens in it, so a brand
  // new session is missing from /api/sessions until the first message. Show the
  // one the agent is actually on, otherwise "new session" looks like it did
  // nothing until a reload.
  const cur = S.state.sessionFile;
  if (cur && !sessions.some((s) => s.path === cur || s.fileName === cur.split(/[\\/]/).pop())) {
    sessions = [{
      path: cur,
      fileName: cur.split(/[\\/]/).pop(),
      name: (S.state.sessionName || '').trim() || 'new session',
      mtime: Date.now(),
      size: 0,
      pending: true,
    }, ...sessions];
  }
  list.innerHTML = '';
  S.sessionsList = sessions;
  const current = S.state.sessionFile;
  // Fill the topbar name from the session's derived title (first user message)
  // when pi hasn't set an explicit session name and we're showing the raw
  // timestamp file name.
  if (current) {
    const base = current.split(/[\\/]/).pop().replace(/\.jsonl$/, '');
    const match = sessions.find((s) => s.path === current || s.fileName === base);
    const nameInput = $('session-name');
    if (match && (nameInput.value === base || nameInput.value === '')) {
      nameInput.value = match.name === base ? base : match.name;
      nameInput.title = `${match.name} — click to rename`;
    }
  }
  // Order the list so a session is followed by the forks it spawned, instead of
  // everything being sorted by time: a branch belongs under the session it came
  // from.
  const byPath = new Map(sessions.map((s) => [s.path, s]));
  /* Children by parent, built once.
   *
   * Both the ordering pass and every row used to run `sessions.filter(...)` to
   * find a session's forks - twice per row inside addRow, plus once per session
   * here - which is O(n²) over the whole list (issue #26). The cap is 200
   * sessions so it was never a hot spot, but it is one pass instead of thousands
   * of comparisons now, and the two maps are what the row builder actually
   * wants. */
  const childrenOf = new Map();
  for (const s of sessions) {
    if (!s.parent) continue;
    if (!childrenOf.has(s.parent)) childrenOf.set(s.parent, []);
    childrenOf.get(s.parent).push(s);
  }
  const kidsOf = (p) => childrenOf.get(p) || [];
  const collapsedForks = S.collapsedForks || {};
  // A search shows everything: hiding a match behind a fold would be a mystery.
  const folded = (path) => !filter && !!collapsedForks[path];
  const ordered = [];
  const placed = new Set();
  for (const s of sessions) {
    if (s.parent && byPath.has(s.parent)) continue;      // rendered with its parent
    if (placed.has(s.path)) continue;
    ordered.push(s);
    placed.add(s.path);
    if (!folded(s.path)) {
      const kids = kidsOf(s.path).slice().sort((a, b) => b.mtime - a.mtime);
      for (const k of kids) { ordered.push(k); placed.add(k.path); }
    }
  }
  for (const s of sessions) {
    if (placed.has(s.path)) continue;
    // ...but a branch whose parent is folded stays folded: this pass used to put
    // it back, so clicking the arrow appeared to do nothing.
    if (s.parent && byPath.has(s.parent) && folded(s.parent)) continue;
    ordered.push(s);
  }

  const shown = ordered.filter((s) => !filter || s.name.toLowerCase().includes(filter) || s.fileName.toLowerCase().includes(filter));
  if (!shown.length) list.appendChild(el('div', 'session-item s-meta', 'No sessions found'));
  // ── folders ─────────────────────────────────────────────────────────────
  // Sessions can live in folders (Settings and the folder menu write them into
  // the bridge's settings, so they are the same in every browser). A folder is a
  // drop target for a session row, and folders can be dragged onto each other to
  // change their order.
  const folders = sessionFolders();
  const folderOf = new Map();
  for (const f of folders) for (const p of f.paths || []) folderOf.set(p, f.id);
  const inFolder = new Set(shown.filter((x) => folderOf.has(x.path)).map((x) => x.path));
  const collapsedFolders = S.collapsedFolders || {};

  // The session the agent is actually working in (may be a fork of what is on
  // screen; when the UI shows another session, S.isStreaming still describes it).
  const runningPath = (cur) => (cur && cur.path) || (S.state && S.state.sessionFile) || null;
  const sessionHasRunningDescendant = (parentPath, all, target) => {
    if (!target) return false;
    const seen = new Set();
    const walk = (p) => {
      for (const x of all) {
        if (x.parent !== p || seen.has(x.path)) continue;
        seen.add(x.path);
        if (sameSessionPath(x.path, target, all)) return true;
        if (walk(x.path)) return true;
      }
      return false;
    };
    return walk(parentPath);
  };

  const addRow = (s) => {
      const item = el('div', 'session-item');
      // A session that was forked off another one: thinner row, smaller grey text
      // and an arrow in front, so the branch structure is visible in the list.
      const parentName = s.parent ? (byPath.get(s.parent) || {}).name : null;
      if (s.parent) {
        item.classList.add('fork');
        item.title = parentName ? `branched from "${parentName}"` : `branched from ${s.parent}`;
      }
      const kids = kidsOf(s.path);
      const isCurrent = current && sameSessionPath(s.path, current, sessions);
      const isViewed = S.viewSession ? sameSessionPath(s.path, S.viewSession, sessions) : false;
      // The blue highlight follows what you are looking at; the green pulsing dot
      // marks the session still running in the background. Highlighting both made
      // it look like two sessions were selected at once.
      if (S.viewSession ? isViewed : isCurrent) item.classList.add('active');
      // Which session the agent is running in. A fork whose parent row is folded
      // away is not in the list at all, so an ancestor carries the dot instead -
      // otherwise a running branch was invisible until you opened the forks.
      const selfLive = isCurrent && S.isStreaming;
      const branchLive = !selfLive && S.isStreaming && sessionHasRunningDescendant(s.path, sessions, runningPath(current));
      if (selfLive || branchLive) item.classList.add('live');
      const nameRow = el('div', 's-name');
      if (selfLive || branchLive) {
        const dot = el('span', 'live-dot', '');
        if (branchLive) dot.title = 'a branch forked from this session is running';
        nameRow.appendChild(dot);
      }
      // The arrow that folds this session's forks away (only where there are any).
      const forkKids = kids;
      if (forkKids.length) {
        const open = !collapsedForks[s.path];
        // Folded away with a count, so it is obvious there is something behind it.
        const arrow = el('span', 'fork-toggle', open ? '▾' : `▸ ${forkKids.length}`);
        arrow.title = open
          ? `hide the ${forkKids.length} session${forkKids.length > 1 ? 's' : ''} forked from this one`
          : `show the ${forkKids.length} session${forkKids.length > 1 ? 's' : ''} forked from this one`;
        arrow.setAttribute('role', 'button');
        arrow.setAttribute('aria-expanded', open ? 'true' : 'false');
        arrow.onclick = (e) => { e.stopPropagation(); toggleForkCollapse(s.path); };
        nameRow.appendChild(arrow);
      }
      nameRow.appendChild(el('span', 'name-text', s.name));
      item.appendChild(nameRow);
      item.appendChild(el('div', 's-meta', `${new Date(s.mtime).toLocaleString()} · ${fmtSize(s.size)}`));
      item.onclick = () => switchToSession(s.path);
      item.oncontextmenu = (e) => { e.preventDefault(); openSessionMenu(s, item); };
      // Drag a session onto a folder (or onto another session inside one) to file
      // it; drag it onto the empty part of the list to take it out again.
      item.draggable = true;
      item.dataset.path = s.path;
      item.addEventListener('dragstart', (e) => {
        dragSession = s.path;
        item.classList.add('dragging');
        try { e.dataTransfer.setData('text/plain', s.path); e.dataTransfer.effectAllowed = 'move'; } catch { /* synthetic or older browsers */ }
      });
      item.addEventListener('dragend', () => {
        dragSession = null;
        item.classList.remove('dragging');
        document.querySelectorAll('.session-folder.drop, .session-item.drop-line').forEach((n) => n.classList.remove('drop', 'drop-line'));
      });
      item.addEventListener('dragover', (e) => {
        if (!dragSession || dragSession === s.path) return;
        e.preventDefault();
        item.classList.add('drop-line');
      });
      item.addEventListener('dragleave', () => item.classList.remove('drop-line'));
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        item.classList.remove('drop-line');
        if (!dragSession || dragSession === s.path) return;
        const fid = folderOf.get(s.path) || null;
        if (fid) assignToFolder(dragSession, fid, s.path);
      });
      list.appendChild(item);
  };

  for (const f of folders) {
    const kids = shown.filter((x) => folderOf.get(x.path) === f.id);
    if (filter && !kids.length) continue;          // while searching, empty folders are noise
    list.appendChild(folderHeader(f, kids.length));
    if (!collapsedFolders[f.id]) for (const k of kids) addRow(k);
  }
  for (const x of shown) if (!inFolder.has(x.path)) addRow(x);
  // Put the reader back on the row they were looking at, not on the pixel they
  // happened to be at. See sessionListAnchor above.
  restoreSessionListAnchor(list, anchor, keepScroll);
}

/* ── session folders ──────────────────────────────────────────────────────
 * Hand-organised groups of sessions: create, rename, drag sessions in, drag the
 * folders into the order you want. The folders live in the bridge's settings, so
 * they are the same whatever browser or machine you open the UI from - and they
 * are kept *per instance*: a folder list holding this machine's session paths has
 * no meaning over another instance's sessions (they are different files), so the
 * other instance simply has its own. The sets are stored locally, keyed by that
 * instance's origin; its own settings are never written to. */
function instanceKey() { return S.remote || location.origin; }

function sessionFolders() {
  const m = SET.sessionFoldersByInstance || {};
  const list = m[instanceKey()];
  if (Array.isArray(list)) return list;
  // The single list from before folders were per instance: adopt it for this
  // machine (and only this one) rather than showing no folders at all.
  migrateFolders();
  const after = (SET.sessionFoldersByInstance || {})[instanceKey()];
  return Array.isArray(after) ? after : [];
}

function ensureFolders() {
  const key = instanceKey();
  const m = SET.sessionFoldersByInstance || (SET.sessionFoldersByInstance = {});
  if (!Array.isArray(m[key])) m[key] = [];
  return m[key];
}

function setFolders(list) {
  const m = SET.sessionFoldersByInstance || (SET.sessionFoldersByInstance = {});
  m[instanceKey()] = (list || []).filter((f) => f && f.id);
  saveSettings();
}

/* Folders used to be one list for everything. Keep them as this machine's when
 * the per-instance store is still empty. */
function migrateFolders() {
  if (SET.sessionFoldersByInstance || !Array.isArray(SET.sessionFolders) || !SET.sessionFolders.length) return;
  SET.sessionFoldersByInstance = { [location.origin]: SET.sessionFolders };
  saveSettings();
}

function saveFolders() {
  setFolders(sessionFolders().filter((f) => f && f.id));
  syncSessionHighlight();
}

function newFolder(name, beforeId) {
  const f = { id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: name || 'new folder', paths: [] };
  const list = ensureFolders();
  const at = beforeId ? list.findIndex((x) => x.id === beforeId) : -1;
  if (at >= 0) list.splice(at, 0, f); else list.push(f);
  saveFolders();
  return f;
}

async function addFolderDialog() {
  const out = await askDialog({
    title: 'New folder',
    body: 'Sessions you drag into it stay in this browser setup, not in the agent.',
    fields: [{ name: 'name', label: 'name', value: 'new folder' }],
    okLabel: 'create',
    require: ['name'],
  });
  if (!out) return;
  newFolder(out.name);
}

function toggleFolder(id) {
  const c = S.collapsedFolders || (S.collapsedFolders = {});
  c[id] = !c[id];
  try { localStorage.setItem('piwebui-folders-collapsed', JSON.stringify(c)); } catch { /* private mode */ }
  syncSessionHighlight();
}

/* One session (or none) moving into a folder, or a folder being reordered. */
function assignToFolder(path, folderId, beforePath) {
  if (!path) return;
  const folders = ensureFolders();
  for (const f of folders) f.paths = (f.paths || []).filter((p) => p !== path);
  const target = folders.find((f) => f.id === folderId);
  if (target) {
    const at = beforePath ? (target.paths || []).indexOf(beforePath) : -1;
    if (!target.paths) target.paths = [];
    if (at >= 0) target.paths.splice(at, 0, path); else target.paths.push(path);
  }
  saveFolders();
  // The folder stays exactly as it was - closed stays closed. Opening it here
  // meant a drag that was meant to file one session away rearranged the whole
  // list under the pointer, and the session you had just filed vanished into a
  // folder you were not looking at. The count badge moves instead, which is
  // the confirmation that it landed.
  toast(`Moved to “${(folders.find((f) => f.id === folderId) || {}).name || 'folder'}”`);
}

/* Dropping one folder onto another swaps the two: the dragged one lands exactly
 * where the other was, which is the one rule that is easy to predict while
 * dragging. (Inserting before it looks like nothing happened whenever the
 * dragged folder was already earlier in the list.) */
function reorderFolder(id, ontoId) {
  if (!id || !ontoId || id === ontoId) return;
  const folders = sessionFolders();
  const from = folders.findIndex((f) => f.id === id);
  const to = folders.findIndex((f) => f.id === ontoId);
  if (from < 0 || to < 0) return;
  const [moved] = folders.splice(from, 1);
  folders.splice(to, 0, moved);
  saveFolders();
}

function openFolderMenu(f, row) {
  const count = (f.paths || []).length;
  openMenu(row, [
    { label: 'rename…', hint: f.name, onPick: async () => {
      const out = await askDialog({ title: 'Rename folder', fields: [{ name: 'name', label: 'name', value: f.name }], okLabel: 'rename', require: ['name'] });
      if (!out) return;
      f.name = out.name;
      saveFolders();
    } },
    { label: 'new folder below', onPick: () => newFolder('new folder', null) },
    { label: count ? `empty it (${count} session${count > 1 ? 's' : ''})` : 'it is already empty', danger: false, onPick: () => {
      if (!count) return;
      f.paths = [];
      saveFolders();
      toast(`“${f.name}” emptied — the sessions are back in the list`);
    } },
    { sep: true },
    { label: 'delete the folder', hint: 'the sessions stay', danger: true, onPick: () => {
      setFolders(sessionFolders().filter((x) => x.id !== f.id));
      saveFolders();
      toast(`Deleted “${f.name}”`);
    } },
  ], { title: f.name, width: 340, force: true, align: 'right' });
}

/* The folder row in the sidebar: caret, name, how many, and the drop targets. */
function folderHeader(f, count) {
  const row = el('div', 'session-folder');
  row.dataset.folder = f.id;
  const open = !(S.collapsedFolders || {})[f.id];
  row.appendChild(el('span', 'folder-caret', open ? '▾' : '▸'));
  row.appendChild(el('span', 'folder-name', f.name || 'folder'));
  row.appendChild(el('span', 'folder-count', String(count)));
  row.title = `${f.name} — ${count} session${count === 1 ? '' : 's'}
click to fold, drag a session here, right-click to rename`;
  // Dragging one folder onto another reorders them.
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    dragFolder = f.id;
    row.classList.add('dragging');
    try { e.dataTransfer.setData('text/plain', `folder:${f.id}`); e.dataTransfer.effectAllowed = 'move'; } catch { /* synthetic events */ }
  });
  row.addEventListener('dragend', () => {
    dragFolder = null;
    row.classList.remove('dragging');
    document.querySelectorAll('.session-folder.drop').forEach((n) => n.classList.remove('drop'));
  });
  row.onclick = () => toggleFolder(f.id);
  row.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); openFolderMenu(f, row); };
  row.addEventListener('dragover', (e) => {
    if (!dragSession && !dragFolder) return;
    e.preventDefault();
    row.classList.add('drop');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop'));
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    row.classList.remove('drop');
    if (dragFolder) { reorderFolder(dragFolder, f.id); return; }
    if (dragSession) assignToFolder(dragSession, f.id);
  });
  return row;
}

let dragSession = null;
let dragFolder = null;

/* (updateBranchesBtn() lived here - an empty function still called from
 * applyState, left from when the sidebar kept a fork count. Forks are rows in
 * the list now and the bridge keeps subagent transcripts out of it, so there was
 * nothing to update and no reason to keep the call.) */

$('session-filter').oninput = () => refreshSessions(true);
$('btn-refresh-sessions').onclick = () => refreshSessions(true);
$('btn-new-folder').onclick = () => addFolderDialog();

/* Rapid switching.
 *
 * Two faults, and they are two halves of the same mistake - treating every click
 * as its own switch rather than as "the user wants to end up here".
 *
 *  1. Each click sent its own `switch_session`. pi answers one at a time and a
 *     switch costs it over a second on a long session, so ten clicks queued ten
 *     switches and the agent was busy for the next fifteen seconds - during which
 *     nothing else it was asked would be answered. Only the last click matters,
 *     so the intermediate ones are dropped: while a switch is running, a newer
 *     target replaces the pending one and is run when the current one finishes.
 *
 *  2. A superseded switch could still apply its result. `get_state` answers about
 *     whichever session pi is in when it gets round to answering, so an older
 *     switch landing late set S.state.sessionFile back to the older session: the
 *     highlight jumped to the wrong row and corrected itself once the newer
 *     switch finished. Reported as "visually selects a different session".
 *     Every switch carries a generation now and a stale one applies nothing.
 */
let switchGen = 0;            // who owns the view; the newest click
let switchSend = null;        // the in-flight agent-side switch loop, or null
let switchWanted = null;      // the newest target asked for while a switch was in flight

/* Move the agent into a session, one switch at a time, newest target wins.
 *
 * pi answers one request at a time, so several switches sent at once are several
 * switches it works through in order - that is what made the bridge look dead in
 * issue #34, and it is why only the newest target is sent: while one is in
 * flight the target is replaced rather than queued.
 *
 * The waiting is deliberately confined to this one call. Every earlier version
 * of the guard around it (switchRunning / switchWanted) parked the whole switch,
 * so a second click did not even move the highlight or start reading its file
 * until the first switch had finished everything - "switching sessions while one
 * is loading won't stop the first one so you have to wait for the first one to
 * finish", issue #39. Bumping the generation is what stops the first one; this
 * function only serialises the part that has to be serialised. */
function requestAgentSwitch(target) {
  switchWanted = target;
  if (!switchSend) {
    switchSend = (async () => {
      try {
        while (switchWanted) {
          const next = switchWanted;
          switchWanted = null;
          try {
            await rpc({ type: 'switch_session', sessionPath: next });
          } catch (err) {
            // A newer click has replaced this target, so this refusal is about a
            // session nobody is waiting for any more - carry on to the newest.
            if (switchWanted && switchWanted !== next) continue;
            throw err;
          }
        }
      } finally { switchSend = null; }
    })();
  }
  return switchSend;
}

async function switchToSession(sessionPath) {
  const agentSession = S.state.sessionFile;
  if (sessionPath === agentSession) {
    if (!S.viewSession) return; // already here
    // Coming back to the agent's own session: re-render it and re-attach the
    // live view (if the agent is still running).
    S.viewSubagent = null;
    S.viewSession = null;
    await refreshMessages();
    updateViewBanner();
    updateSubagentsBtn();
    syncSessionHighlight();
    return;
  }
  if (S.isStreaming) {
    // The agent is running in its own session. Keep it running in the
    // background: park the live DOM (deltas keep landing in it) and view the
    // target session read-only from its file. The green dot in the session
    // list shows which session is still running.
    if (S.live) {
      const frag = document.createDocumentFragment();
      frag.appendChild(S.live.root); // detaches it from the visible chat
      S.liveDetached = { path: agentSession, frag };
    }
    S.viewSubagent = null;
    S.viewSession = sessionPath;
    /* The same supersede rule as the idle path below: this click owns the view,
     * and the read it is about to start must bail out if another click takes
     * over. Without it two quick switches each fetched, each cleared the chat and
     * each painted, so the earlier one could finish last and win - and there was
     * no guard at all on this branch (issue #39). */
    const gen = ++switchGen;
    await renderSessionFromDisk(sessionPath, gen);
    if (switchGen !== gen) return;
    updateSubagentsBtn();
    updateViewBanner();
    syncSessionHighlight();
    return;
  }
  // Agent is idle: move it to the selected session so input works there.

  /* Take the view for this click.
   *
   * Whatever was switching before is superseded from here on: its `superseded()`
   * checks stop it drawing anything more, its transcript read is aborted by the
   * refreshMessages() below (that one already aborted the previous read), and the
   * generation it passes to initSession makes it skip applyState. The click is
   * answered now rather than after the previous switch finished - issue #39. */
  const gen = ++switchGen;
  const superseded = () => switchGen !== gen;
  try {
    /* Start reading the target file *now*, alongside the switch.
     *
     * The file is on disk and the transcript is going to be read from it either
     * way - it does not wait for the agent, and neither does anything else the
     * switch is about to do. Moving the agent into a session took half a second
     * on a long one, and that was half a second of a blank screen in which the
     * bytes could have been on their way. If the switch is refused (a working
     * directory that no longer exists) the read is simply thrown away. */
    const prefetch = { path: sessionPath, promise: fetchSession(sessionPath).catch(() => null) };
    /* Draw it straight away, and move the agent into it at the same time.
     *
     * The transcript comes from the file, and the file is on disk - it does not
     * wait for the agent, and neither does the render. But both of those were
     * queued behind `switch_session`, which on a long session costs pi a few
     * hundred milliseconds, and behind the `get_state` that followed it. That
     * was the last of the click-to-first-message delay: not the work, the
     * queueing in front of it.
     *
     * The session path is set optimistically so the render has something to
     * attribute itself to, and put back if the switch is refused. */
    const previous = S.state.sessionFile;
    S.state.sessionFile = sessionPath;
    S.viewSubagent = null;
    S.viewSession = null;
    $('session-name').value = '';
    const drawn = refreshMessages(prefetch);
    /* Answer the click straight away.
     *
     * The highlight and the confirmation used to wait for `initSession`, which is
     * eleven refreshes deep - models, levels, commands, the session list, the
     * stats, the transcript. Then they were moved ahead of it but left behind
     * `switch_session`, which on a long session costs pi a second and a half -
     * and that is the whole of the remaining delay: the sidebar sat showing the
     * old session as active and the toast arrived a second and a half later, both
     * of them trailing a transcript that had already drawn.
     *
     * Neither depends on the agent. The path is already set, so the highlight has
     * somewhere to go, and the view has already been drawn from the file. If the
     * switch is refused the error is reported on its own; the view did change,
     * which is what both of these are saying. */
    syncSessionHighlight();
    /* Say what is true at the moment it is said.
     *
     * This is the third form of these two lines, and the reasoning is worth
     * keeping because the first two were both wrong in opposite directions:
     *
     *  1. "Session switched" toasted before the switch was awaited - instant, but
     *     it claimed something that had not happened, so a refused switch
     *     reported success and then failure for the same click (#14).
     *  2. "Session switched" toasted after the await - honest, but it now waits
     *     for pi to move into the session, which on a long one is a second or
     *     more. Reported as "even the session-changed message is delayed".
     *
     * What has already happened by this point is the *view*: the highlight has
     * moved and the transcript has been drawn from the session file, both without
     * the agent. So that is what is announced, immediately, and the confirmation
     * is left to the thing that shows it - the highlight you can see and the
     * conversation that is now on screen. Nothing claims the agent has moved; if
     * it refuses, the error is reported and the view is put back. */
    toast(`Switching to “${String(sessionPath).split(/[\\/]/).pop().replace(/\.jsonl$/, '').slice(0, 48)}”`);
    try {
      await requestAgentSwitch(sessionPath);
    } catch (err) {
      // A newer switch has taken over: this failure is about a session the user
      // has already left, and undoing the guess would undo theirs.
      if (superseded()) return;
      S.state.sessionFile = previous;   // the switch was refused; undo the guess
      await drawn.catch(() => {});
      throw err;
    }
    // Do not apply state from a switch that has been overtaken - that is the
    // wrong-row highlight (see the note above requestAgentSwitch).
    if (superseded()) return;
    await initSession(false, prefetch, drawn, gen);
  } catch (e) {
    // pi refuses to switch to a session whose recorded working directory is
    // gone (usually because the project folder was renamed). Offer to put the
    // folder back so the session can be opened again, instead of dead-ending on
    // a raw error.
    const missing = /working directory does not exist:\s*(.+?)\s*$/im.exec(e.message || '');
    if (missing && missing[1]) {
      const dir = missing[1].trim();
      const ok = confirm(
        `This session was recorded in\n\n${dir}\n\n` +
        'and that folder does not exist any more - it was renamed or moved.\n\n' +
        'Create the folder again so the session can be opened?');
      if (!ok) {
        toast('Session not opened - its recorded folder is missing', 'warning');
        return;
      }
      try {
        const r = await fetch(api('/api/ensure-dir'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: dir }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'could not create it');
        await rpc({ type: 'switch_session', sessionPath });
        S.state.sessionFile = sessionPath;
        S.viewSubagent = null;
        S.viewSession = null;
        $('session-name').value = '';
        await initSession(false);
        toast('Session opened - its old folder was recreated');
      } catch (e2) {
        toast(`Still could not open it: ${e2.message}`, 'error');
      }
      return;
    }
    toast(`Switch failed: ${e.message}`, 'error');
  }
}

// Read-only render of another session's transcript straight from its file.
async function renderSessionFromDisk(sessionPath, gen) {
  // Nothing here touches the DOM until the file has arrived, and by then the
  // click that asked for it may have been replaced - in which case this read is
  // stale and must not clear the chat the new one is drawing into.
  const superseded = () => gen !== undefined && switchGen !== gen;
  try {
    const d = await fetchSession(sessionPath);
    if (superseded()) return;
    const msgs = d.messages;
    const distFromBottom = chatScroller().scrollHeight - chatScroller().scrollTop - chatScroller().clientHeight;
    chat.innerHTML = '';
    transcriptTarget = chat;
    for (const m of msgs) {
      if (m.role === 'user') renderUserMessage(m);
      else if (m.role === 'assistant') renderAssistantMessage(m);
      else if (m.role === 'toolResult') renderToolResult(m);
      else if (m.role === 'bashExecution') renderBashExecution(m);
      else if (m.role === 'compactionSummary') renderCompactionSummary(m);
    }
    transcriptTarget = null;
    // Put the file's compaction markers back where they happened.
    if (d.compactions.length) {
      const plain = [...chat.querySelectorAll('.msg:not(.compaction)')];
      for (const k of d.compactions) {
        let target = null;
        for (const n of plain) {
          const ts = Number(n.dataset.ts);
          if (k.at && ts && ts <= k.at) target = n;
        }
        const node = buildCompactionSummary(k, { live: true, count: d.compactions.length });
        if (target) target.after(node);
        else if (plain.length) plain[0].before(node);
        else chat.appendChild(node);
      }
    }
    if (S.stickToBottom) scrollBottom(true);
    else chatScroller().scrollTop = chatScroller().scrollHeight - chatScroller().clientHeight - distFromBottom;
  } catch (e) {
    toast(`Could not load session: ${e.message}`, 'error');
  }
}

$('btn-new-session').onclick = async () => {
  try {
    await rpc({ type: 'new_session' });
    await applyDefaultModel();
    await initSession(false);
    // The file for a fresh session does not exist yet, so the list has nothing
    // to show. Re-check shortly (and after the first message lands) as well.
    refreshSessions(true).catch(() => {});
    setTimeout(() => refreshSessions(true).catch(() => {}), 700);
    toast('New session started');
  } catch (e) { toast(e.message, 'error'); }
};

$('session-name').addEventListener('change', async (e) => {
  const name = e.target.value.trim();
  if (!name) return;
  try {
    await rpc({ type: 'set_session_name', name });
    await refreshSessions(true);
    toast('Session renamed');
  } catch (err) { toast(err.message, 'error'); }
});
