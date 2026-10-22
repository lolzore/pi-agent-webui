/*
 * Global keyboard shortcuts.
 *
 * Split out of app.js (issue #54). Loaded before app.js; the names stay
 * global, so nothing else changed. Behaviour is unchanged.
 */
'use strict';

/* ───────────────────────── keyboard ───────────────────────── */

input.addEventListener('keydown', (e) => {
  if (slash.open) {
    if (e.key === 'ArrowDown') { moveSlashSel(1); e.preventDefault(); return; }
    if (e.key === 'ArrowUp') { moveSlashSel(-1); e.preventDefault(); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { pickSlash(slash.sel); e.preventDefault(); return; }
    if (e.key === 'Escape') { closeSlashMenu(); e.preventDefault(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { sendCurrent(); e.preventDefault(); }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Menus open from all over - the model picker, the thinking levels, the
  // instance switcher, the branch list - and until now Escape only closed one of
  // them, and only while its search box had focus. Escape closes whatever is
  // open, first, before it means "stop the agent": in a window with no reload
  // button, a dropdown you cannot dismiss is a trap.
  const modelMenuOpen = $('model-menu') && !$('model-menu').classList.contains('hidden');
  if (openMenuEl || modelMenuOpen || slash.open) {
    closeAllMenus();
    closeSlashMenu();
    e.preventDefault();
    return;
  }
  // A modal dialog closes itself on Escape, and without this the key also reached
  // the code below: the settings, crop, ask and subagent dialogs all closed *and*
  // aborted a running agent, and the new notifications dialog would have too. Any
  // open dialog means Escape belonged to it.
  if (document.querySelector('dialog[open]')) return;
  if (S.speaking) { speechSynthesis.cancel(); S.speaking = false; $('btn-tts').classList.remove('on'); }
  else if (S.isStreaming) stopAgent();
});
