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
  switch (req.method) {
    case 'notify':
      toast(stripAnsi(req.message), req.notifyType === 'error' ? 'error' : req.notifyType === 'warning' ? 'warning' : 'info');
      break;
    case 'setStatus': {
      const bar = $('status-bar');
      // A key cleared with an empty text removes that line; the bar stays up
      // while anything is left (and for a moment after the last line goes).
      const key = req.statusKey || 'status';
      const text = stripAnsi(req.statusText || '').trim();
      if (text) bar.dataset[key] = text; else delete bar.dataset[key];
      setBarContent(bar, Object.values(bar.dataset).join(' · '));
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
      if (lines.length) bar.dataset[req.widgetKey] = lines.join('\n');
      else delete bar.dataset[req.widgetKey];
      setBarContent(bar, Object.values(bar.dataset).join('\n'));
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

function showExtensionDialog(req) {
  const dlg = $('ext-dialog');
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
      const o = el('option', null, typeof opt === 'string' ? opt : (opt.label || opt.value));
      o.value = typeof opt === 'string' ? opt : (opt.value ?? opt.label);
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
    dlg.close();
    send({ type: 'extension_ui_response', id: req.id, ...response });
  };
  ok.onclick = () => done(getVal());
  cancel.onclick = () => done({ cancelled: true });
  dlg.oncancel = (e) => { e.preventDefault(); done({ cancelled: true }); };

  dlg.showModal();
  if (control) control.focus();
}
