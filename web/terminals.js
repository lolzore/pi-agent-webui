/*
 * Terminals (issue #124): the bash tools the agent is running right now, as a
 * top-bar button with a live count and a menu that can close one.
 *
 * The tracker is fed by the tool-execution events (and by the composer's own
 * bash RPC), so it works for a turn in any session. Closing sends pi's
 * `abort_bash`.
 */
'use strict';

const terminals = new Map();   // toolCallId -> { id, command, startedAt, session }
/* Rows the user expanded in the menu (issue #139): clicking a terminal shows
 * what it is doing; only its stop button closes it. */
const terminalsExpanded = new Set();

function noteTerminalStart(info) {
  if (!info || !info.id) return;
  terminals.set(String(info.id), {
    id: String(info.id),
    command: String(info.command || '').trim() || 'bash',
    startedAt: Number(info.startedAt) || Date.now(),
    session: info.session || null,
  });
  renderTerminalsBtn();
}

function noteTerminalEnd(id) {
  if (!id) return;
  if (terminals.delete(String(id))) renderTerminalsBtn();
}

function terminalsElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function renderTerminalsBtn() {
  const btn = $('btn-terminals');
  if (!btn) return;
  const n = terminals.size;
  btn.classList.toggle('hidden', !n);
  const c = $('terminals-count');
  if (c) c.textContent = String(n);
  btn.title = n ? `${n} terminal${n > 1 ? 's' : ''} running` : 'No terminals running';
}

async function closeTerminal(id) {
  try {
    await rpc({ type: 'abort_bash' });
    toast('Terminal closed');
  } catch (e) {
    toast(`Could not close the terminal: ${e.message}`, 'error');
  }
  noteTerminalEnd(id);
}

function toggleTerminal(id) {
  if (terminalsExpanded.has(id)) terminalsExpanded.delete(id);
  else terminalsExpanded.add(id);
  openTerminalsMenu(true);
}

function openTerminalsMenu(force) {
  const btn = $('btn-terminals');
  if (!btn) return;
  const items = [...terminals.values()].map((t) => {
    const expanded = terminalsExpanded.has(t.id);
    const elapsed = terminalsElapsed(Date.now() - t.startedAt);
    const stop = el('button', 'btn small', 'stop');
    stop.dataset.closeTerminal = t.id;
    stop.title = 'Close this terminal (abort_bash)';
    return {
      // The preview carries the live elapsed (issue #139); clicking expands to
      // the whole command instead of closing it.
      label: expanded
        ? t.command
        : `${elapsed} · ${t.command.length > 60 ? `${t.command.slice(0, 57)}…` : t.command}`,
      hint: expanded
        ? `${elapsed} · started ${new Date(t.startedAt).toLocaleTimeString()}${t.session ? ` · ${t.session}` : ''} · click to collapse`
        : `click to expand${t.session ? ` · ${t.session}` : ''}`,
      trailing: stop,
      onTrailing: () => closeTerminal(t.id),
      keepOpen: true,
      onPick: () => toggleTerminal(t.id),
      /* Issue #158: an expanded row has to show the whole command, so it is
       * marked and the stylesheet lets it wrap; the collapsed preview keeps the
       * one-line ellipsis every other menu row uses. */
      cls: expanded ? 'term-expanded' : 'term-collapsed',
    };
  });
  if (!items.length) items.push({ label: 'no terminals running', hint: 'the agent has no bash tool running' });
  const menu = openMenu(btn, items, { title: 'terminals', width: 460, force: force === true });
  if (menu) {
    menu._terminals = true;
    /* Its own class: this menu lists commands, and the stylesheet treats them
     * differently from model names (mono, wrapping, a taller list). */
    menu.classList.add('menu-terminals');
  }
}

if ($('btn-terminals')) $('btn-terminals').onclick = (e) => { e.stopPropagation(); openTerminalsMenu(); };

/* The elapsed times tick while the menu is open - updated in place, so a row
 * being clicked does not move. */
setInterval(() => {
  if (!openMenuEl || !openMenuEl._terminals) return;
  for (const t of terminals.values()) {
    const stop = openMenuEl.querySelector(`[data-close-terminal="${cssEscape(t.id)}"]`);
    const row = stop && stop.closest('.model-item');
    if (!row) continue;
    const elapsed = terminalsElapsed(Date.now() - t.startedAt);
    const label = row.querySelector('.model-label');
    if (label && !terminalsExpanded.has(t.id)) {
      label.textContent = `${elapsed} · ${t.command.length > 60 ? `${t.command.slice(0, 57)}…` : t.command}`;
    }
    const hint = row.querySelector('.model-provider');
    if (hint) {
      hint.textContent = terminalsExpanded.has(t.id)
        ? `${elapsed} · started ${new Date(t.startedAt).toLocaleTimeString()}${t.session ? ` · ${t.session}` : ''} · click to collapse`
        : `click to expand${t.session ? ` · ${t.session}` : ''}`;
    }
  }
}, 1000);

renderTerminalsBtn();
