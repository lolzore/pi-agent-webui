/*
 * The extension UI protocol (dialogs, status, widgets).
 *
 * Split out of app.js (issue #54). Loaded before app.js; the names stay
 * global, so nothing else changed. Behaviour is unchanged.
 */
'use strict';

/* ───────────────────────── extension UI protocol ───────────────────────── */

function handleExtensionUi(req) {
  const stripAnsi = (s) => String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  // `hadContent` is bookkeeping for the dock's height reservation, not a line
  // of status text. Including it put a stray "1" before every later status.
  const barContent = (bar, sep) => Object.entries(bar.dataset)
    .filter(([k]) => k !== 'hadContent')
    .map(([, v]) => v)
    .join(sep);
  switch (req.method) {
    case 'notify':
      toast(stripAnsi(req.message), req.notifyType === 'error' ? 'error' : req.notifyType === 'warning' ? 'warning' : 'info');
      break;
    case 'setStatus': {
      /* goal-x uses the status line only for its unfocused hint ("goal:
       * unfocused [3 open] - /goal-focus"). The native goal bar already shows
       * that state, with the count and a focus button, so rendering both put
       * the same goal information on screen twice. Keep the goal state here:
       * refresh the bar and do not copy the hint into the status line. */
      if (req.statusKey === 'goal') { refreshGoals().catch(() => {}); break; }
      const bar = $('status-bar');
      // A key cleared with an empty text removes that line; the bar stays up
      // while anything is left (and for a moment after the last line goes).
      const key = req.statusKey || 'status';
      const text = stripAnsi(req.statusText || '').trim();
      // Drop a bare digit/pipe per key, not only when it is the whole bar. With
      // another status present (MCP) the old whole-string check let a stray "1"
      // through as "1 · MCP: …".
      if (text && !/^[0-9|]$/.test(text)) bar.dataset[key] = text; else delete bar.dataset[key];
      setBarContent(bar, barContent(bar, ' · '));
      break;
    }
    case 'setWidget': {
      // goal-x's dashboard is the goal bar (issue #55): refresh it instead of
      // printing the extension's TUI box-drawing into the browser's widget bar.
      if (req.widgetKey === 'goal') { refreshGoals().catch(() => {}); break; }
      const bar = $('widget-bar');
      // The pi-subagents extension publishes its live runs as a widget whose
      // single line is `PI_SUBAGENT_ASYNC_JSON:{…}`. It is data for the panel
      // below, not text for the widget bar (it used to be printed there as a
      // wall of JSON).
      const raw = (req.widgetLines || []).map(stripAnsi);
      for (const line of raw) {
        const i = line.indexOf('PI_SUBAGENT_ASYNC_JSON:');
        if (i >= 0) {
          try { setSubagentSnapshot(JSON.parse(line.slice(i + 'PI_SUBAGENT_ASYNC_JSON:'.length))); } catch { /* partial line */ }
        }
        const j = line.indexOf('PI_SUBAGENT_INSPECT_JSON:');
        if (j >= 0) {
          try { noteSubagentInspect(JSON.parse(line.slice(j + 'PI_SUBAGENT_INSPECT_JSON:'.length))); } catch { /* partial line */ }
        }
      }
      const lines = raw.filter((l) => l && l.trim()
        && l.indexOf('PI_SUBAGENT_ASYNC_JSON:') < 0 && l.indexOf('PI_SUBAGENT_INSPECT_JSON:') < 0);
      const meaningful = lines.filter((l) => !/^[0-9|]$/.test(String(l).trim()));
      if (meaningful.length) bar.dataset[req.widgetKey] = meaningful.join('\n');
      else delete bar.dataset[req.widgetKey];
      setBarContent(bar, barContent(bar, '\n'));
      break;
    }
    case 'setTitle':
      document.title = `${stripAnsi(req.title) || 'Pi Agent'}`;
      break;
    case 'set_editor_text':
      input.value = req.text || '';
      autoSize();
      input.focus();
      break;
    case 'select':
    case 'confirm':
    case 'input':
    case 'editor':
      showExtensionDialog(req);
      break;
    default:
      // Unknown request: respond cancelled so the agent doesn't block forever.
      send({ type: 'extension_ui_response', id: req.id, cancelled: true });
  }
}

/* Some extensions emit the same request at two session boundaries (goal-x asks
 * "Focus open goal" on every resume). Showing both dialogs made one reminder
 * appear twice and the second could overwrite the first. Keep one open dialog
 * per request shape, answer every duplicate with the same response, and collapse
 * a duplicate that arrives just after the first was answered. */
let extDialogCurrent = null;
let extDialogLast = null;

function extRequestSignature(req) {
  return JSON.stringify({
    method: req.method || '',
    title: req.title || '',
    message: req.message || '',
    options: req.options || [],
    placeholder: req.placeholder || '',
    prefill: req.prefill || '',
  });
}

function sendExtensionUiResponse(id, response) {
  if (id == null) return;
  send({ type: 'extension_ui_response', id, ...response });
}

/* The option labels are goal-x's goalSelectorLabel(), which starts with the goal
 * id. That id lets the WebUI find the session the goal came from. */
function goalForExtensionValue(value) {
  const text = String(value == null ? '' : value);
  const list = (goalState && goalState.present && Array.isArray(goalState.goals)) ? goalState.goals : [];
  return list.find((g) => g && g.id && text.includes(g.id)) || null;
}

function isGoalSelectRequest(req) {
  return req && (req.method === 'select' || req.method === 'confirm') &&
    /(focus open goal|resume or focus|pause which open goal|clear which open goal|tweak which open goal)/i.test(req.title || '');
}

/* goal-x's pool is project-wide. On a session that does not own a goal, filter
 * that goal out of the focus menu; if nothing belongs here, do not show a menu
 * at all. Goals without a resolved session path are left alone for compatibility
 * with older records. */
function goalSelectOptionsHere(req) {
  const options = req.options || [];
  const current = (S.state && S.state.sessionFile) || null;
  if (!current) return options;
  const mapped = options.map((opt) => {
    const value = typeof opt === 'string' ? opt : (opt.value ?? opt.label);
    return { opt, goal: goalForExtensionValue(value) };
  });
  /* The menu belongs on a session that owns at least one of the goals. Once it
   * is legitimately here, keep the whole list: choosing a goal from another
   * session is how the user follows it back to the conversation it started in. */
  const ownsOne = mapped.some(({ goal }) => goalBelongsToSession(goal, current));
  return ownsOne ? options : [];
}

function showExtensionDialog(req) {
  const dlg = $('ext-dialog');
  const goalSelect = isGoalSelectRequest(req);
  /* The first extension request can beat the first /api/goals read. Ask once
   * before deciding, otherwise a session with no goals would show the pooled
   * menu just because the client had no goal records yet. */
  if (goalSelect && !goalState && !req._goalStateReady) {
    refreshGoals()
      .then(() => showExtensionDialog({ ...req, _goalStateReady: true }))
      .catch(() => showExtensionDialog({ ...req, _goalStateReady: true }));
    return;
  }
  if (goalSelect && req.method === 'select') {
    const filtered = goalSelectOptionsHere(req);
    if (!filtered.length) {
      const response = { cancelled: true };
      extDialogLast = { sig: extRequestSignature(req), at: Date.now(), response };
      sendExtensionUiResponse(req.id, response);
      return;
    }
    req = { ...req, options: filtered };
  }
  const sig = extRequestSignature(req);
  const now = Date.now();

  // A duplicate while the first dialog is still open: attach its id to the
  // first request and do not open a second one.
  if (extDialogCurrent && extDialogCurrent.sig === sig) {
    extDialogCurrent.ids.push(req.id);
    return;
  }
  // A duplicate that arrives just after the first was answered (the usual
  // double session_start): replay the same answer instead of asking again.
  if (extDialogLast && extDialogLast.sig === sig && now - extDialogLast.at < 5000) {
    sendExtensionUiResponse(req.id, extDialogLast.response);
    return;
  }

  extDialogCurrent = { sig, ids: [req.id] };
  const body = $('ext-dialog-body');
  const cancel = $('ext-dialog-cancel');
  const ok = $('ext-dialog-ok');
  body.innerHTML = '';
  cancel.classList.remove('hidden');
  ok.textContent = 'OK';

  $('ext-dialog-title').textContent = req.title || 'Agent';
  const message = $('ext-dialog-message');
  if (req.message) { message.textContent = req.message; message.classList.remove('hidden'); }
  else message.classList.add('hidden');

  let control = null;
  let getVal = () => undefined;

  if (req.method === 'select') {
    control = el('select');
    for (const opt of req.options || []) {
      const original = typeof opt === 'string' ? opt : (opt.label || opt.value);
      const value = typeof opt === 'string' ? opt : (opt.value ?? opt.label);
      let label = original;
      const goal = goalForExtensionValue(value);
      if (goal && goal.sessionPath) {
        const sessionName = String(goal.sessionPath).split(/[\\/]/).pop().replace(/\.jsonl$/, '');
        label = `${original}  —  ${sessionName}`;
      }
      const o = el('option', null, label);
      o.value = value;
      control.appendChild(o);
    }
    body.appendChild(control);
    getVal = () => ({ value: control.value });
    ok.textContent = 'Select';
  } else if (req.method === 'confirm') {
    getVal = () => ({ confirmed: true });
    ok.textContent = 'Confirm';
  } else if (req.method === 'input') {
    control = el('input');
    control.placeholder = req.placeholder || '';
    body.appendChild(control);
    getVal = () => ({ value: control.value });
  } else if (req.method === 'editor') {
    control = el('textarea');
    control.value = req.prefill || '';
    body.appendChild(control);
    getVal = () => ({ value: control.value });
    ok.textContent = 'Save';
  }

  const done = (response) => {
    const ids = extDialogCurrent && extDialogCurrent.sig === sig ? extDialogCurrent.ids.slice() : [req.id];
    extDialogCurrent = null;
    extDialogLast = { sig, at: Date.now(), response };
    dlg.close();
    for (const id of ids) sendExtensionUiResponse(id, response);
    // Choosing a goal is also choosing the conversation it belongs to. The
    // extension has already applied the focus to the session it asked from;
    // switch after its response so the request is not cancelled by the move.
    const selected = req.method === 'select' ? goalForExtensionValue(response && response.value) : null;
    if (selected && selected.sessionPath && typeof switchToSession === 'function') {
      const target = selected.sessionPath;
      setTimeout(() => {
        const onAgentSession = S.state.sessionFile && sameSessionPath(target, S.state.sessionFile, S.sessionsList || []);
        if (!onAgentSession || S.viewSession) {
          switchToSession(target).catch((e) => toast(`Could not open the goal's session: ${e.message}`, 'error'));
        }
      }, 250);
    }
  };
  ok.onclick = () => done(getVal());
  cancel.onclick = () => done({ cancelled: true });
  dlg.oncancel = (e) => { e.preventDefault(); done({ cancelled: true }); };

  dlg.showModal();
  if (control) control.focus();
}
