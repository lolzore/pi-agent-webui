/*
 * Toasts, banners, the error log, and the sidebar toggle wiring.
 *
 * Split out of app.js (issue #54). Loaded before app.js; the names stay
 * global, so nothing else changed. Behaviour is unchanged.
 */
'use strict';

/* ───────────────────────── toasts / banner / misc ───────────────────────── */

/* ── notifications and errors, kept ──────────────────────────────────────
 * A toast is gone five seconds later, and the one that mattered (the agent
 * failed, the upload was refused, another instance stopped answering) is exactly
 * the one you were not looking at. Everything the app reports also goes here,
 * with the time, and the bell in the top bar shows them. */
/* Notifications raised by a slash command open the panel (issue #5).
 *
 * "Same as issue #4" - so the rule is: a notice that the user's own slash
 * command produced opens the notifications panel, because that is the thing they
 * just asked for and a five-second toast is easy to miss. Background notices
 * (an extension erroring while a run is going, an upload being refused) do not,
 * or the panel would be opening on its own constantly. The flag is set only
 * around the slash-command handling in sendCurrent(). */
function notice(text, kind = 'info', detail) {
  try {
    if (!S.notices) S.notices = [];
    // Keep the whole notification so the expand arrow has something to show,
    // but cap it: a run that dumps a stack trace on every event must not turn
    // the log into a memory leak.
    S.notices.push({ t: Date.now(), text: String(text).slice(0, 2000), kind, detail: detail ? String(detail).slice(0, 4000) : null });
    if (S.notices.length > 200) S.notices.splice(0, S.notices.length - 200);
    S.noticesUnread = (S.noticesUnread || 0) + 1;
    updateBell();
    if (S.noticesFromCommand) {
      S.noticesFromCommand = false;
      openNoticesDialog();
    }
    return S.notices[S.notices.length - 1] || null;
  } catch { /* never let logging break the thing being logged */ }
  return null;
}

function updateBell() {
  const btn = $('btn-bell');
  if (!btn) return;
  const unread = S.noticesUnread || 0;
  const badge = $('bell-count');
  if (badge) {
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.classList.toggle('hidden', unread === 0);
  }
  btn.classList.toggle('has-error', (S.notices || []).some((x) => x.kind === 'error'));
}

/* The notifications panel (issues #4 and #5).
 *
 * It was a dropdown anchored to the bell in the top-right. It is now a dialog in
 * the middle of the window with the text at the chat font size and a Done button,
 * which is what the settings dialog does - the shape that was asked for.
 *
 * Opening it no longer clears the unread badge immediately: the badge is cleared
 * when it closes, so the mark stays while you are reading rather than being spent
 * the instant the panel appears. */
function noticeRows() {
  return (S.notices || []).slice().reverse();
}

function renderNotices() {
  const list = $('notices-list');
  if (!list) return;
  list.innerHTML = '';
  const rows = noticeRows();
  if (!rows.length) {
    list.appendChild(el('div', 'notice-empty', 'Nothing yet. Notifications and errors show up here.'));
    return;
  }
  for (const n of rows.slice(0, 300)) {
    const at = new Date(n.t);
    const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const day = at.toDateString() === new Date().toDateString() ? '' : `${at.toLocaleDateString()} `;
    const row = el('div', `notice-row${n.kind === 'error' ? ' error' : ''}`);
    const meta = el('div', 'n-meta');
    meta.appendChild(el('span', 'n-time', `${day}${time}`));
    if (n.kind && n.kind !== 'info') meta.appendChild(el('span', 'n-kind', n.kind));
    row.appendChild(meta);
    const body = el('div', 'n-body');
    body.appendChild(el('div', 'n-text', n.text));
    if (n.detail) body.appendChild(el('div', 'n-detail', n.detail));
    row.appendChild(body);
    // Most notifications are one or two lines and stay compact. The ones with
    // more text (or a separate detail block) get a small arrow, so the panel
    // can show the whole thing without every row taking half the window.
    if (n.detail || n.text.length > 150) {
      // Inline expansion still helps for a short detail, but a long stack trace
      // or provider error needs a real page: this arrow opens the notification
      // on its own, full-window, instead of squeezing it into a row.
      const toggle = el('button', 'n-toggle', '↗');
      toggle.type = 'button';
      toggle.title = 'Open this notification in a full window';
      toggle.setAttribute('aria-label', 'Open this notification in a full window');
      toggle.onclick = (e) => {
        e.stopPropagation();
        openNoticeDetail(n);
      };
      row.appendChild(toggle);
    }
    row.title = 'Click to open this notification in a full window';
    row.onclick = () => openNoticeDetail(n);
    list.appendChild(row);
  }
}

function openNoticesDialog() {
  const dlg = $('notices-dialog');
  if (!dlg) return;
  renderNotices();
  const sub = $('notices-sub');
  if (sub) {
    const n = (S.notices || []).length;
    sub.textContent = n
      ? `${n} notification${n === 1 ? '' : 's'}, newest first. Click a row or its arrow to read it in a full window with its formatting intact.`
      : 'Everything the app reports shows up here.';
  }
  if (!dlg.open) dlg.showModal();
}

function closeNoticesDialog() {
  const dlg = $('notices-dialog');
  if (dlg && dlg.open) dlg.close();
}

/* A single notification, at reading size, with its whitespace preserved. The
 * compact list is for finding the notice; this is for actually reading the
 * stack trace or the provider's HTML error page. */
let noticeDetailCurrent = null;
function openNoticeDetail(n) {
  if (!n) return;
  const dlg = $('notice-detail-dialog');
  if (!dlg) return;
  noticeDetailCurrent = n;
  const title = $('notice-detail-title');
  const meta = $('notice-detail-meta');
  const body = $('notice-detail-body');
  if (title) title.textContent = n.kind && n.kind !== 'info'
    ? `${n.kind[0].toUpperCase()}${n.kind.slice(1)} notification`
    : 'Notification';
  if (meta) {
    const at = new Date(n.t || Date.now());
    meta.textContent = `${at.toLocaleDateString()} ${at.toLocaleTimeString()}`;
  }
  if (body) {
    body.innerHTML = '';
    body.appendChild(el('div', 'notice-detail-text', n.text || ''));
    if (n.detail) body.appendChild(el('pre', 'notice-detail-code', n.detail));
  }
  if (!dlg.open) dlg.showModal();
}

function closeNoticeDetail() {
  const dlg = $('notice-detail-dialog');
  if (dlg && dlg.open) dlg.close();
}

if ($('notice-detail-done')) $('notice-detail-done').onclick = closeNoticeDetail;
if ($('notice-detail-copy')) {
  $('notice-detail-copy').onclick = () => {
    if (!noticeDetailCurrent) return;
    copyText(noticeDetailCurrent.detail || noticeDetailCurrent.text || '', 'Copied the notification');
  };
}

/* (The dropdown builder that lived here is replaced by renderNotices above. The
 * panel keeps every affordance it had - newest first, the time and the kind on
 * each row, click-to-copy, and a clear button - and gains the size and the Done
 * button the issue asked for.) */

/* A failure that would otherwise only reach the developer console. */
window.addEventListener('error', (e) => {
  if (e && e.target && e.target.tagName && /^(IMG|VIDEO|SCRIPT|LINK)$/.test(e.target.tagName)) {
    notice(`${e.target.tagName.toLowerCase()} failed to load: ${String(e.target.src || e.target.href || '').split('/').pop()}`, 'error');
    return;
  }
  notice(`Error: ${(e && e.message) || 'unknown'}`, 'error', (e && e.error && e.error.stack) || null);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  const text = r && r.message ? r.message : String(r);
  if (/abort/i.test(text)) return;      // our own aborted fetches
  notice(`Unhandled: ${text}`, 'error', (r && r.stack) || null);
});

/* Routine bookkeeping: worth showing in the corner, not worth keeping. Switching
 * session or instance happens constantly while you work, and each one added an
 * entry to the notification list - so the list became a log of "Session switched"
 * with the actual errors buried in it. */
const QUIET_TOASTS = [
  /^Session switched$/,
  /^Switching to /,
  /^Back to this machine$/,
  /^Looking at .+ \(through this machine\)$/,
];

/* Repeats of the same toast, by text (issue #215). One wedged turn reports the
 * same extension error once per handler and again on the next turn; a burst of
 * identical toasts is what hid the rest of the screen. Only verbatim repeats
 * inside a few seconds are dropped, and the notification log keeps the first. */
const RECENT_TOASTS = new Map();

function toast(text, kind = 'info') {
  const key = String(text);
  const now = Date.now();
  const last = RECENT_TOASTS.get(key);
  if (last !== undefined && now - last < 5000) return;
  RECENT_TOASTS.set(key, now);
  if (RECENT_TOASTS.size > 50) {
    for (const [k, t] of RECENT_TOASTS) if (now - t > 5000) RECENT_TOASTS.delete(k);
    if (RECENT_TOASTS.size > 50) RECENT_TOASTS.clear();
  }
  const logged = QUIET_TOASTS.some((r) => r.test(key)) ? null : notice(key, kind);
  const t = el('div', `toast ${kind}`, text);
  if (logged) {
    t.title = 'Click to open this notification in a full window';
    t.onclick = () => openNoticeDetail(logged);
  }
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

function showBanner(kind, text, btnLabel, fn, onDismiss) {
  const b = $('banner');
  b.className = `banner ${kind}`;
  b.innerHTML = '';
  b.appendChild(el('span', null, text));
  if (btnLabel) {
    const btn = el('button', 'btn small', btnLabel);
    btn.onclick = () => { hideBanner(); fn(); };
    b.appendChild(btn);
  }
  // Anything that comes back on its own has to be dismissible - and the dismissal
  // has to be remembered, or the same banner returns on the next poll.
  if (onDismiss) {
    const x = el('button', 'btn small banner-x', '✕');
    x.title = 'dismiss (it stays dismissed)';
    x.onclick = () => { hideBanner(); onDismiss(); };
    b.appendChild(x);
  }
}

function hideBanner() {
  const b = $('banner');
  b.className = 'banner hidden';
}

function setConn(mode) {
  const d = $('conn-dot');
  d.className = `conn-dot ${mode}`;
  d.title = mode === 'on' ? 'Connected' : mode === 'busy' ? 'Agent is streaming' : 'Disconnected';
}

$('btn-toggle-sidebar').onclick = () => {
  if (window.matchMedia('(max-width: 760px)').matches) $('sidebar').classList.toggle('open');
  else document.body.classList.toggle('sidebar-hidden');
};

/* collapsible code boxes: one delegated listener for all rendered markdown */
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.code-toggle');
  if (!btn) return;
  const box = btn.closest('.codebox');
  box.classList.toggle('collapsed');
  btn.textContent = box.classList.contains('collapsed') ? '+' : '\u2212';
});

/* Periodically poll the session list while idle.
 *
 * The poll itself is cheap, but what it did with the answer was not: it rebuilt
 * the whole sidebar from scratch every twenty seconds, which meant re-creating
 * every row, losing whatever was hovered or focused, and re-running layout and
 * paint over a list that had not changed by a single character. refreshSessions
 * now compares the payload first and only re-renders when the name, the size or
 * the modification time of a session actually moved, so a quiet sidebar costs
 * one JSON parse and nothing else. A hidden tab is not polled at all. */
setInterval(() => {
  if (S.isStreaming) return;
  if (document.visibilityState !== 'visible') return;
  refreshSessions();
}, 20000);
