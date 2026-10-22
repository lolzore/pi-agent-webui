/*
 * The Electron app's editable right-click menu.
 *
 * Electron does not draw a context menu on its own, and the native GTK menu it
 * can draw looks nothing like the rest of the window. The main process forwards
 * an editable context-menu event here with the spellcheck suggestions; this
 * renders the same .model-menu component the model/thinking/settings pickers
 * use, then sends the chosen action back.
 */
'use strict';

(function () {
  if (!window.piDesktop || typeof window.piDesktop.onContextMenu !== 'function') return;

  let anchor = null;
  function menuAnchor() {
    if (anchor && anchor.isConnected) return anchor;
    anchor = document.createElement('span');
    anchor.id = 'pi-context-anchor';
    anchor.style.cssText = 'position:fixed;width:1px;height:1px;pointer-events:none;left:-9999px;top:-9999px;';
    document.body.appendChild(anchor);
    return anchor;
  }

  window.piDesktop.onContextMenu((data) => {
    if (!data || !Number.isFinite(Number(data.x)) || !Number.isFinite(Number(data.y))) return;
    const x = Number(data.x), y = Number(data.y);
    /* Right-clicking an input does not always focus it; refocus before the
     * action so cut/copy/paste and replaceMisspelling hit the field the menu
     * was opened on. */
    let target = null;
    try {
      target = document.elementFromPoint(x, y);
      if (target && (target.matches('input, textarea, select') || target.isContentEditable)) target.focus();
      else target = null;
    } catch { target = null; }

    const act = (action, value) => () => {
      try { if (target && target.isConnected) target.focus(); } catch { /* gone */ }
      try { window.piDesktop.contextAction(action, value); } catch { /* bridge gone */ }
    };
    const items = [];
    const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
    if (data.misspelledWord) {
      for (const s of suggestions) items.push({ label: s, onPick: act('replace', s) });
      if (!suggestions.length) items.push({ label: 'No spelling suggestions', cls: 'disabled' });
      items.push({ label: 'Add to dictionary', onPick: act('dictionary', data.misspelledWord) });
      items.push({ sep: true });
    }
    if (data.isEditable) {
      if (data.canCut !== false) items.push({ label: 'Cut', onPick: act('cut') });
      if (data.canCopy !== false) items.push({ label: 'Copy', onPick: act('copy') });
      if (data.canPaste !== false) items.push({ label: 'Paste', onPick: act('paste') });
      items.push({ sep: true });
      if (data.canSelectAll !== false) items.push({ label: 'Select all', onPick: act('selectAll') });
    } else if (data.selectionText) {
      items.push({ label: 'Copy', onPick: act('copy') });
      items.push({ label: 'Select all', onPick: act('selectAll') });
    }
    if (!items.length) return;
    const a = menuAnchor();
    a.style.left = `${x}px`;
    a.style.top = `${y}px`;
    openMenu(a, items, { at: { x, y }, width: 220 });
  });
})();
