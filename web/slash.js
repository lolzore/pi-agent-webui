/*
 * The slash-command menu.
 *
 * Split out of app.js (issue #54). Loaded before app.js; the names stay
 * global, so nothing else changed. Behaviour is unchanged.
 */
'use strict';

/* ───────────────────────── slash commands ───────────────────────── */

/* handled by the UI itself, never sent to the agent */
const LOCAL_COMMANDS = [
  { name: 'tts', description: 'Toggle text-to-speech for agent replies', source: 'local' },
  { name: 'autosend', description: 'Toggle auto-send after voice input', source: 'local' },
  { name: 'thinking', description: 'Toggle showing thinking blocks', source: 'local' },
  { name: 'statistics', description: 'Model and token usage across all sessions', source: 'local' },
];

/* pi's built-in slash commands are implemented by its TUI, not by RPC mode:
 * using them from here either did nothing or went to the model as a prompt. The
 * UI maps the useful ones (compact, name, clone, copy, session, model,
 * thinking) to their RPC equivalents itself, and the rest belong to a button
 * somewhere - so the menu only offers what actually runs. Typing a hidden one
 * still works when the UI implements it. */
/* The only built-in pi command worth a row in the menu is /compact: everything
 * else pi's TUI implements (name, clone, copy, session, model, thinking, new,
 * fork, export, ...) is a button or a right-click in this UI, and the rest do
 * nothing here. Typing one still works when the UI implements it. */
const MENU_BUILTINS = new Set(['compact']);

/* pi registers skills as `skill:<name>`. That prefix is an implementation
 * detail: the menu shows the name you type, tab-completion inserts it, and it is
 * put back only when the command is actually sent to the agent (see
 * sendCurrent), so "/myskill" runs the skill without the prefix ever being on
 * screen. */
function commandLabel(c) {
  return String(c.name || '').replace(/^skill:/i, '');
}

/* What the agent should actually receive. pi registers skills as `skill:<name>`,
 * and that prefix is an implementation detail: the menu shows the short name, tab
 * completion inserts it, and it is put back here - only on the way out. */
function skillAwareCommand(text) {
  const m = /^\/(\S+)([\s\S]*)$/.exec(text);
  if (!m) return text;
  const name = m[1].toLowerCase();
  if (/^skill:/.test(name)) return text;
  const skill = (S.commands || []).find((c) => /^skill:/i.test(c.name) && commandLabel(c).toLowerCase() === name);
  return skill ? `/${String(skill.name).toLowerCase()}${m[2]}` : text;
}

function allCommands() {
  const seen = new Set();
  const out = [];
  // Local UI commands take precedence, then agent (extension/prompt/skill)
  // commands, then pi's built-in slash commands. Deduped by name so e.g. the
  // local /thinking toggle isn't shadowed twice.
  for (const c of [...LOCAL_COMMANDS, ...S.commands, ...S.builtinCommands]) {
    const key = String(c.name || '').toLowerCase();
    const label = commandLabel(c).toLowerCase();
    if (seen.has(key) || seen.has('label:' + label)) continue;
    seen.add(key);
    seen.add('label:' + label);
    out.push(c);
  }
  return out;
}

let slash = { open: false, items: [], sel: 0, menu: null };

function updateSlashMenu() {
  const v = input.value;
  const caretInFirstWord = !v.slice(input.selectionStart).includes(' ');
  const m = v.match(/^\/(\S*)$/);
  if (!m || !caretInFirstWord || !allCommands().length) { closeSlashMenu(); return; }
  const q = m[1].toLowerCase();
  const items = allCommands()
    .filter((c) => c.source !== 'builtin' || MENU_BUILTINS.has(String(c.name || '').toLowerCase().replace(/^\//, '')))
    .filter((c) => String(c.name || '').toLowerCase().includes(q)
      || commandLabel(c).toLowerCase().includes(q)
      || (c.description || '').toLowerCase().includes(q))
    .slice(0, 300);   // the list scrolls; it used to be cut off at 12, which hid every skill
  if (!items.length) { closeSlashMenu(); return; }
  openSlashMenu(items);
}

function openSlashMenu(items) {
  closeSlashMenu();
  slash = { open: true, items, sel: 0, menu: null };
  const menu = el('div', 'slash-menu');
  items.forEach((c, i) => {
    const row = el('div', 'slash-item' + (i === 0 ? ' sel' : ''));
    row.appendChild(el('span', 'cmd', '/' + commandLabel(c)));
    if (c.description) row.appendChild(el('span', 'desc', c.description));
    if (c.source) {
      const label = c.source === 'local' ? 'ui' : c.source === 'builtin' ? 'pi' : c.source;
      row.appendChild(el('span', `src ${c.source}`, label));
    }
    row.onclick = () => pickSlash(i);
    menu.appendChild(row);
  });
  document.body.appendChild(menu);
  slash.menu = menu;
  // Span the composer: from the "+" button to "send", and sit just above it.
  positionSlashMenu();
  startSlashFollow();
}

/* Put the menu just above the composer row, inside the visible viewport.
 *
 * It used to be positioned once from `innerHeight - row.top + 8`. That is right
 * for a desktop window with the composer pinned to the bottom, but it is wrong
 * when the visual viewport is smaller or offset from the layout viewport (a
 * phone keyboard, page zoom, a short window): the menu was then laid out at the
 * bottom of the *chat window*, often below the visible area, until a reload
 * happened to recompute it (issue #203). Keep the menu inside the visual
 * viewport, and re-run this when the viewport or the transcript scroller moves
 * while it is open. */
function positionSlashMenu() {
  if (!slash.open || !slash.menu) return;
  const row = document.querySelector('.composer-row') || input;
  const r = row.getBoundingClientRect();
  const vv = window.visualViewport;
  const vw = vv ? vv.width : window.innerWidth;
  const vh = vv ? vv.height : window.innerHeight;
  const ox = vv ? vv.offsetLeft : 0;
  const oy = vv ? vv.offsetTop : 0;
  const gap = 8;
  const edge = 8;
  const spaceAbove = r.top - gap - edge;
  const spaceBelow = (oy + vh) - r.bottom - gap - edge;
  // Prefer above the composer, but if the window is short, use whichever side
  // has more room and cap the menu to it. The old clamp moved a too-tall menu
  // to the top of the window, detached from the input (the screenshot in the
  // follow-up); the menu must stay attached and scroll inside its own box.
  const preferAbove = spaceAbove >= 120 || spaceAbove >= spaceBelow;
  const room = Math.max(80, Math.min(260, preferAbove ? spaceAbove : spaceBelow));
  slash.menu.style.maxHeight = room + 'px';
  const left = Math.max(ox + edge, Math.min(r.left, ox + vw - Math.min(r.width, vw - 2 * edge) - edge));
  slash.menu.style.left = left + 'px';
  slash.menu.style.width = Math.min(r.width, vw - 2 * edge) + 'px';
  if (preferAbove) {
    const bottom = (oy + vh) - r.top + gap;
    slash.menu.style.top = 'auto';
    slash.menu.style.bottom = Math.max(edge, bottom) + 'px';
  } else {
    slash.menu.style.bottom = 'auto';
    slash.menu.style.top = Math.max(edge, r.bottom + gap) + 'px';
  }
}

/* The composer moves while the page settles: the transcript loads, a status
 * bar or attachment strip appears, the input grows, the window resizes. The
 * menu is re-positioned by the resize/scroll/visualViewport listeners below and
 * by a slow follow timer while it is open. A rAF loop measured and restyled the
 * menu every frame; removing the follow entirely (an earlier attempt) broke the
 * menu after a layout shift that is neither a resize nor a scroll. */

/* Follow the composer while the menu is open - ten checks a second, and only
 * when its position actually changed. That is enough to catch the dock settling
 * or a transform, without a layout read every frame. */
let slashFollowTimer = null;
let slashFollowTop = null;
function startSlashFollow() {
  if (slashFollowTimer) return;
  slashFollowTop = null;
  slashFollowTimer = setInterval(() => {
    if (!slash.open || !slash.menu) { stopSlashFollow(); return; }
    const row = document.querySelector('.composer-row') || input;
    if (!row) return;
    const top = row.getBoundingClientRect().top;
    if (slashFollowTop != null && Math.abs(top - slashFollowTop) < 0.5) return;
    slashFollowTop = top;
    positionSlashMenu();
  }, 100);
}
function stopSlashFollow() {
  if (slashFollowTimer) { clearInterval(slashFollowTimer); slashFollowTimer = null; }
  slashFollowTop = null;
}

/* The composer can move while the menu is open: the transcript scrolls under
 * it, the window is resized, or a phone keyboard opens. Keep the menu attached
 * instead of leaving it where it was first drawn. */
const repositionSlashMenu = () => positionSlashMenu();
window.addEventListener('resize', repositionSlashMenu);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', repositionSlashMenu);
  window.visualViewport.addEventListener('scroll', repositionSlashMenu);
}
const chatScrollerForSlash = document.getElementById('chat-scroll');
if (chatScrollerForSlash) chatScrollerForSlash.addEventListener('scroll', repositionSlashMenu, { passive: true });

function closeSlashMenu() {
  if (slash.menu) slash.menu.remove();
  stopSlashFollow();
  slash = { open: false, items: [], sel: 0, menu: null };
}

/* Clicking anywhere else closes the menu, and clicking back into the box brings it
 * back (issue #51).
 *
 * The menu is appended to <body> rather than into the composer, deliberately - it
 * spans the whole row - so nothing in the composer's own handlers ever sees a click
 * elsewhere on the page. That is why it used to stay up until the text changed or
 * Escape was pressed: there was no outside-click handling at all, only
 * updateSlashMenu() being called from the input's own events.
 *
 * Closing is not disabling. updateSlashMenu() works out whether the menu belongs
 * from the text and the caret, so focusing the box again puts it back - which is
 * exactly what the report asked for: "close it, and reopen once you start typing or
 * click back in".
 *
 * Captured, so a handler that stops propagation elsewhere cannot leave the menu
 * stranded, and pointerdown rather than click so it goes as soon as the press lands.
 * A press inside the menu is left alone: removing the node on pointerdown would tear
 * the row out from under the click that is about to pick it. */
document.addEventListener('pointerdown', (e) => {
  if (!slash.open || !slash.menu) return;
  if (slash.menu.contains(e.target) || e.target === input) return;
  closeSlashMenu();
}, true);

/* Back into the box: rebuild it if the caret is still in a `/word`. The click is
 * handled as well as the focus, because clicking into a box that already has focus
 * fires no focus event. */
const reopenSlashMenu = () => { if (!slash.open) updateSlashMenu(); };
input.addEventListener('focus', reopenSlashMenu);
input.addEventListener('click', reopenSlashMenu);

function moveSlashSel(d) {
  if (!slash.open) return;
  slash.sel = (slash.sel + d + slash.items.length) % slash.items.length;
  [...slash.menu.children].forEach((c, i) => c.classList.toggle('sel', i === slash.sel));
  slash.menu.children[slash.sel].scrollIntoView({ block: 'nearest' });
}

function pickSlash(i) {
  const c = slash.items[i];
  if (!c) return;
  // Tab/Enter completes to the name as it is shown (no "skill:" prefix)
  input.value = '/' + commandLabel(c) + ' ';
  input.focus();
  closeSlashMenu();
  autoSize();
}
