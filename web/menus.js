/*
 * In-app dialogs and context menus.
 *
 * Split out of app.js (issue #54). Loaded before app.js; the names stay
 * global, so nothing else changed. Behaviour is unchanged.
 */
'use strict';

/* ── in-app dialogs ───────────────────────────────────────────────────────
 * confirm() and prompt() look like a browser warning bolted onto the page. This
 * is the same shape as the settings dialog, so confirmations read as part of the
 * app. Returns a promise: the resolved value is the field values object, or null
 * when cancelled. */
function askDialog(opts = {}) {
  return new Promise((resolve) => {
    const dlg = $('ask-dialog');
    if (!dlg) { resolve(null); return; }
    $('ask-title').textContent = opts.title || 'Are you sure?';
    const body = $('ask-body');
    body.innerHTML = '';
    if (opts.body) body.appendChild(el('p', 'ask-text', opts.body));
    const fields = opts.fields || [];
    const inputs = {};
    for (const f of fields) {
      const row = el('label', 'ask-row');
      row.appendChild(el('span', 'ask-label', f.label));
      const input = el('input');
      input.type = 'text';
      input.value = f.value || '';
      input.placeholder = f.placeholder || '';
      input.autocomplete = 'off';
      row.appendChild(input);
      body.appendChild(row);
      inputs[f.name] = input;
    }
    if (opts.hint) body.appendChild(el('p', 'ask-hint', opts.hint));
    $('ask-ok').textContent = opts.okLabel || 'ok';
    $('ask-ok').classList.toggle('danger', opts.danger === true);
    $('ask-cancel').textContent = opts.cancelLabel || 'cancel';
    const done = (value) => {
      dlg.removeEventListener('close', onClose);
      if (dlg.open) dlg.close();
      resolve(value);
    };
    const onClose = () => resolve(null);
    dlg.addEventListener('close', onClose);
    $('ask-ok').onclick = () => {
      const out = {};
      for (const f of fields) out[f.name] = inputs[f.name].value.trim();
      if (opts.require) {
        const missing = opts.require.find((n) => !out[n]);
        if (missing) { inputs[missing].focus(); return; }
      }
      done(out);
    };
    $('ask-cancel').onclick = () => done(null);
    const first = fields.length ? inputs[fields[0].name] : $('ask-ok');
    if (!dlg.open) dlg.showModal();
    setTimeout(() => first.focus(), 30);
  });
}

/* ── context menus ────────────────────────────────────────────────────────
 * Right click a session in the sidebar, or a message in the transcript. Both use
 * the same dropdown component as the model picker. */

function openSessionMenu(s, anchor) {
  const cur = S.state.sessionFile;
  const isCurrent = !!(cur && sameSessionPath(s.path, cur, S.sessionsList || []));
  openMenu(anchor, [
    { label: 'open', active: isCurrent, onPick: () => switchToSession(s.path) },
    { label: 'export…', hint: 'save the .jsonl wherever you want', onPick: () => exportSession(s) },
    // The tree comes from the agent, so it is only meaningful for the session
    // the agent has loaded - a read-only view would list the wrong branches.
    ...(isCurrent ? [{ label: 'branches…', hint: 'fork points in this session', sub: true, onPick: () => openBranchesMenu(s, anchor) }] : []),
    { sep: true },
    { label: 'delete…', hint: 'removes the file from disk', danger: true, onPick: () => deleteSession(s) },
  ], { title: 'session', width: 330, align: 'right' });
}

/* Download a session file. showSaveFilePicker is a real "where do you want it"
 * dialog; the plain anchor fallback still saves to the download folder. */
async function exportSession(s) {
  const url = `/api/session-file?path=${encodeURIComponent(s.path)}`;
  const name = String(s.fileName || 'session.jsonl');
  try {
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'pi session', accept: { 'application/jsonl': ['.jsonl'] } }],
      });
      const res = await fetch(url);
      if (!res.ok) throw new Error(`bridge said ${res.status}`);
      const blob = await res.blob();
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      toast(`Exported ${name}`);
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;   // cancelled in the dialog
  }
  const a = el('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast(`Exporting ${name}`);
}

async function deleteSession(s) {
  const ok = await askDialog({
    title: 'Delete this session?',
    body: `${s.name}\n${s.path}`,
    hint: 'The file is removed from disk. This cannot be undone.',
    okLabel: 'delete',
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await fetch(api('/api/session-delete'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: s.path }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'delete failed');
    if (S.state.sessionFile && s.path === S.state.sessionFile) {
      // Deleting a fork used to leave you on a brand new empty session. Go back
      // to where it was forked from when the file says, otherwise to the most
      // recent other session - either way, not a blank one.
      const parent = await sessionParent(s.path);
      const rest = (await fetch(api('/api/sessions')).then((x) => x.json()).catch(() => ({ sessions: [] })).then((d2) => (d2.sessions || [])))
        .filter((x) => x.path !== s.path)
        .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      const target = parent && rest.some((x) => x.path === parent) ? parent : (rest[0] && rest[0].path);
      if (target) {
        await switchToSession(target);
      } else {
        toast('That was the only session - starting a new one', 'warning');
        await rpc({ type: 'new_session' }).catch(() => {});
        await applyDefaultModel();
        await initSession(false);
      }
    }
    await refreshSessions(true);
    toast(`Deleted ${s.name}`);
  } catch (e) {
    toast(`Delete failed: ${e.message}`, 'error');
  }
}

/* The session a fork came from, if the file records it. */
async function sessionParent(sessionPath) {
  try {
    const d = await fetchSession(sessionPath);
    return d.parent || null;
  } catch { return null; }
}

/* Branch points of the open session (pi keeps branches in one file as a tree).
 * There is no RPC for moving the active leaf, so choosing a branch point means
 * forking there - which is how a branch gets started in the first place. */
/* The fork tree of the session you are in: pi knows the branch points, so this
 * is the real thing rather than a guess from the session list. Called both as
 * openBranchesMenu(anchor) and openBranchesMenu(session, anchor) depending on
 * where it is opened from, so the anchor is whichever argument is an element. */
async function openBranchesMenu(a, b) {
  const anchor = (a && a.getBoundingClientRect ? a : b) || $('session-name');
  let tree = null, leafId = null;
  try {
    const d = await rpc({ type: 'get_tree' });
    tree = d && d.tree;
    leafId = d && d.leafId;
  } catch { /* older agent */ }
  if (!tree || !tree.length) {
    toast('No branch points yet — edit an earlier message, or fork from one, to start a branch', 'warning');
    return;
  }
  const describe = (entry) => {
    const m = entry && entry.message;
    const text = m ? String((m.content || []).map((c) => c.text || '').join(' ')).replace(/\s+/g, ' ').trim() : '';
    return `${m ? m.role : (entry && entry.type) || 'entry'}: ${text.slice(0, 70) || entry.id}`;
  };
  const items = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      const kids = n.children || [];
      const isLeaf = kids.length === 0;
      if (isLeaf || kids.length > 1) {
        items.push({
          label: `${isLeaf ? (n.entry.id === leafId ? '● ' : '○ ') : '⑂ '}${describe(n.entry)}`,
          hint: isLeaf ? 'branch end' : `${kids.length} branches`,
          active: n.entry.id === leafId,
          onPick: () => forkAt(n.entry.id, describe(n.entry)),
        });
      }
      if (kids.length) walk(kids);
    }
  };
  walk(tree);
  if (!items.length) { toast('Nothing to switch between yet', 'warning'); return; }
  openMenu(anchor, items, {
    title: 'branches - picking one starts a new branch from there',
    width: 420,
    search: 'filter branch points…',
    align: 'right',
  });
}

async function forkAt(entryId, text) {
  const ok = await askDialog({
    title: 'Start a new branch?',
    body: text,
    hint: 'The conversation continues from this point. The old continuation stays in the session file.',
    okLabel: 'fork',
  });
  if (!ok) return;
  try {
    // pi forks *before* the message you picked and returns its text so the client
    // can send it again - that is what its own UI does with the reply. Ignoring
    // it left the new branch ending one turn earlier than the turn you clicked,
    // which is why every fork looked like it came from the wrong turn.
    const res = await rpc({ type: 'fork', entryId });
    await initSession(false);
    const again = res && typeof res.text === 'string' ? res.text.trim() : '';
    if (again && !res.cancelled) {
      toast('Forked - continuing from here');
      rpc({ type: 'prompt', message: res.text }).catch((e) => toast(`Continue failed: ${e.message}`, 'error'));
    } else {
      toast('Forked - continue from here');
    }
  } catch (e) {
    toast(`Fork failed: ${e.message}`, 'error');
  }
}

/* Right-click a message. On a user turn there is a fork entry for it; on an
 * assistant turn the fork point is the user message that started it, so walk
 * back to the nearest one. Reading a session the agent has not loaded cannot be
 * forked in place - the agent has to switch to it first, which the menu says. */
function openTurnMenu(node, at) {
  const m = node._msg || null;
  let forkNode = node;
  if (!forkNode.dataset.fork) {
    let prev = forkNode.previousElementSibling;
    while (prev && !prev.dataset.fork) prev = prev.previousElementSibling;
    forkNode = prev || null;
  }
  let entryId = forkNode && forkNode.dataset.fork ? forkNode.dataset.fork : null;
  /* No id on the row yet? Resolve it from the message's own text against
   * whichever fork list is loaded, and ask for the active-branch tree in the
   * background so the next open is exact (it is only fetched on demand - on a
   * long session it is a big answer, see ensureForkTree). */
  if (!entryId && forkNode) {
    const text = forkNode._msg ? messageBlock(forkNode._msg.content).text : '';
    const lists = [S.forkEntries || [], S.forkable || []];
    for (const list of lists) {
      if (entryId) break;
      const hit = list.find((f) => f && f.text === text);
      if (hit) entryId = hit.entryId;
    }
    if (typeof ensureForkTree === 'function') ensureForkTree().then(() => stampForkIds()).catch(() => {});
  }
  const items = [];
  if (entryId) {
    const elsewhere = !!S.viewSession;
    items.push({
      label: elsewhere ? 'open this session and fork here' : 'fork from here',
      hint: elsewhere ? 'the agent has to load it first' : 'new branch at this message',
      onPick: () => (elsewhere ? forkInOtherSession(entryId, forkNode.dataset.forktext || '') : forkAt(entryId, forkNode.dataset.forktext || '')),
    });
  }
  if (m && m.role === 'assistant' && !S.viewSession) items.push({ label: 'clone session here', hint: 'copy the session up to now', onPick: () => cloneHere() });
  const md = node.querySelector('.md');
  const text = md ? md.innerText : '';
  if (text) {
    if (items.length) items.push({ sep: true });
    items.push({ label: 'copy text', onPick: () => copyText(text, 'Copied the message') });
    items.push({ label: 'speak', onPick: () => speak(stripMarkdown(text)) });
  }
  // Right-clicking a word you just dragged over is how you copy in every other
  // app. This menu replaces the browser's, so it has to offer it itself.
  const selected = selectedText();
  if (selected) {
    items.unshift({
      label: 'copy selection',
      hint: selected.length > 40 ? `${selected.slice(0, 40)}…` : selected,
      onPick: () => copyText(selected, 'Copied the selection'),
    });
    if (items.length > 1) items.splice(1, 0, { sep: true });
  }
  if (!items.length) return;
  openMenu(node.querySelector('.who') || node, items, { title: 'message', width: 320, at });
}

/* Forking in a session the agent has not loaded: switch to it, then fork. */
async function forkInOtherSession(entryId, text) {
  const target = S.viewSession;
  if (!target) return;
  const ok = await askDialog({
    title: 'Open that session and fork?',
    body: text,
    hint: 'The agent switches to it first - it can only fork in the session it has loaded.',
    okLabel: 'fork',
  });
  if (!ok) return;
  try {
    await rpc({ type: 'switch_session', sessionPath: target });
    S.state.sessionFile = target;
    S.viewSession = null;
    S.liveDetached = null;
    await initSession(false);
    const res = await rpc({ type: 'fork', entryId });
    await initSession(false);
    const again = res && typeof res.text === 'string' ? res.text.trim() : '';
    if (again && !res.cancelled) {
      toast('Forked - continuing from here');
      rpc({ type: 'prompt', message: res.text }).catch((e) => toast(`Continue failed: ${e.message}`, 'error'));
    } else {
      toast('Forked - continue from here');
    }
  } catch (e) {
    toast(`Fork failed: ${e.message}`, 'error');
  }
}

async function cloneHere() {
  try {
    await rpc({ type: 'clone' });
    await initSession(false);
    toast('Cloned into a new session');
  } catch (e) {
    toast(`Clone failed: ${e.message}`, 'error');
  }
}
