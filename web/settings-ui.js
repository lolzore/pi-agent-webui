/*
 * The settings dialog's own logic: applying a settings object to the page,
 * the system-font picker, the done-sound UI, the agent reload, the cursor
 * preview, LAN access, pi's compaction setting and the first-run setup dialog.
 *
 * Split out of app.js (issue #54, phase 7). Loaded before app.js; the names
 * stay global, so nothing else changed. Behaviour is unchanged.
 */
'use strict';

/* ── settings notes behind a ? (issue #219) ──────────────────────────────
 * Explanatory prose used to sit under every row of the settings dialog. The
 * notes are still in the DOM - a few of them (the Extensions tab's paths) are
 * updated by other code - but they live in #settings-help-sources and are only
 * read out when their question mark is hovered, focused or pinned. */
let helpPopEl = null;
let helpAnchor = null;
let helpPinned = false;
let helpHideTimer = null;

function helpPopup() {
  if (helpPopEl && helpPopEl.isConnected) return helpPopEl;
  helpPopEl = el('div', 'help-pop hidden');
  helpPopEl.id = 'help-pop';
  helpPopEl.setAttribute('role', 'tooltip');
  document.body.appendChild(helpPopEl);
  helpPopEl.addEventListener('pointerenter', () => {
    if (helpHideTimer) { clearTimeout(helpHideTimer); helpHideTimer = null; }
  });
  helpPopEl.addEventListener('pointerleave', () => {
    if (!helpPinned) scheduleHelpHide();
  });
  return helpPopEl;
}

function positionHelp(anchor) {
  const pop = helpPopup();
  const r = anchor.getBoundingClientRect();
  pop.style.visibility = 'hidden';
  pop.style.left = '0px';
  pop.style.top = '0px';
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8));
  let top = r.bottom + 8;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 8);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.style.visibility = '';
}

function showHelp(anchor) {
  if (!anchor || !anchor._helpSrc) return;
  if (helpHideTimer) { clearTimeout(helpHideTimer); helpHideTimer = null; }
  const pop = helpPopup();
  // Read the source now, not when the icon was built: the Extensions tab's
  // paths and the done-sound note are rewritten after the dialog opens.
  pop.innerHTML = anchor._helpSrc.innerHTML;
  // A modal <dialog> is in the top layer, so a tooltip on <body> would paint
  // underneath it. Put the popup inside the dialog the icon belongs to.
  const host = anchor.closest('dialog[open]') || document.body;
  if (pop.parentElement !== host) host.appendChild(pop);
  pop.classList.remove('hidden');
  if (helpAnchor && helpAnchor !== anchor) helpAnchor.setAttribute('aria-expanded', 'false');
  helpAnchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  positionHelp(anchor);
}

function scheduleHelpHide() {
  if (helpHideTimer) clearTimeout(helpHideTimer);
  helpHideTimer = setTimeout(() => { helpHideTimer = null; hideHelp(); }, 140);
}

function hideHelp() {
  if (helpHideTimer) { clearTimeout(helpHideTimer); helpHideTimer = null; }
  if (helpAnchor) helpAnchor.setAttribute('aria-expanded', 'false');
  helpAnchor = null;
  helpPinned = false;
  if (helpPopEl) helpPopEl.classList.add('hidden');
}

function upgradeSettingsNotes() {
  const root = $('settings-dialog');
  if (!root || root.dataset.helpReady === '1') return;
  root.dataset.helpReady = '1';
  const sink = $('settings-help-sources') || (() => {
    const box = el('div', 'help-sources hidden');
    box.id = 'settings-help-sources';
    box.setAttribute('aria-hidden', 'true');
    root.appendChild(box);
    return box;
  })();
  for (const note of [...root.querySelectorAll('[data-note-help]')]) {
    const target = note.getAttribute('data-help-target')
      ? root.querySelector(note.getAttribute('data-help-target'))
      : null;
    if (!target) continue;               // leave the note visible rather than lose it
    if (note.parentElement && note.parentElement.classList.contains('settings-grid')) {
      // the empty grid label in front of a note was only there to put it on its
      // own row; keeping it would leave a permanent hole where the note was
      const prev = note.previousElementSibling;
      if (prev && prev.tagName === 'LABEL' && !prev.textContent.trim() && !prev.children.length) prev.remove();
    }
    const icon = document.createElement('button');
    icon.type = 'button';
    icon.className = 'help-tip';
    icon.textContent = '?';
    icon.setAttribute('aria-label', 'Help');
    icon.setAttribute('aria-expanded', 'false');
    icon._helpSrc = note;
    target.appendChild(icon);
    if (target.tagName === 'LABEL') target.classList.add('has-help');
    sink.appendChild(note);              // keeps its ids and its live updates
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', upgradeSettingsNotes);
else upgradeSettingsNotes();

document.addEventListener('pointerover', (e) => {
  const t = e.target && e.target.closest ? e.target.closest('.help-tip') : null;
  if (t) showHelp(t);
});
document.addEventListener('pointerout', (e) => {
  const t = e.target && e.target.closest ? e.target.closest('.help-tip') : null;
  if (!t) return;
  if (helpPinned && helpAnchor === t) return;
  if (t.contains(e.relatedTarget)) return;
  scheduleHelpHide();
});
document.addEventListener('focusin', (e) => {
  const t = e.target && e.target.closest ? e.target.closest('.help-tip') : null;
  if (t) showHelp(t);
});
document.addEventListener('focusout', (e) => {
  const t = e.target && e.target.closest ? e.target.closest('.help-tip') : null;
  if (t && !helpPinned) scheduleHelpHide();
});
document.addEventListener('click', (e) => {
  const t = e.target && e.target.closest ? e.target.closest('.help-tip') : null;
  if (t) {
    e.preventDefault();
    e.stopPropagation();
    if (helpPinned && helpAnchor === t) hideHelp();
    else { helpPinned = true; showHelp(t); }
    return;
  }
  if (helpPinned && helpPopEl && !helpPopEl.contains(e.target)) hideHelp();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !helpPopEl?.classList.contains('hidden')) { e.preventDefault(); e.stopPropagation(); hideHelp(); }
});
window.addEventListener('resize', hideHelp);
window.addEventListener('scroll', () => { if (!helpPinned) hideHelp(); }, true);
const settingsDialogEl = $('settings-dialog');
if (settingsDialogEl) settingsDialogEl.addEventListener('close', hideHelp);

function applySettings() {
  // The name lives in the instance button now (it doubles as "who you are
  // looking at"), so guard it: a page without it must not break every setting.
  const nameEl = $('instance-name') || $('agent-title');
  if (nameEl) nameEl.textContent = displayAgentName() || 'pi agent';
  updateDocumentTitle();
  const tts = $('btn-tts');
  if (tts) {
    tts.textContent = S.autoTts ? 'TTS on' : 'TTS off';
    tts.classList.toggle('on', S.autoTts);
  }
  // reflect in already-rendered "who" lines
  document.querySelectorAll('.msg.assistant .who .agent-name-label').forEach((e) => {
    e.textContent = displayAgentName() || 'pi';
  });
  refreshAvatars();
  applyPetSettings();
  // thinking blocks visibility
  document.body.classList.toggle('hide-thinking', SET.showThinking === false);
  document.body.classList.toggle('hide-tools', SET.showToolCalls === false);
  markHollowMessages();
  const stt = $('set-show-tools');
  if (stt) stt.checked = SET.showToolCalls !== false;
  const st = $('set-show-thinking');
  if (st) st.checked = SET.showThinking !== false;
  // theme
  applyThemeColours();
  const avSize = Math.max(16, Math.min(120, Number(SET.avatarSize) || 34));
  document.documentElement.style.setProperty('--avatar-size', `${avSize}px`);
  // Gamer mode takes the accent over: the wheel turns once every 16 seconds, so
  // it reads as a living theme rather than a strobe. Everything that uses
  // --accent (buttons, rings, scrollbars, highlights) follows along.
  if (SET.gamerMode) startGamerAccent(); else stopGamerAccent();
  updateFavicon();
  applyBackgroundMedia();
  // Background transparency, separate from the panels': a bright photo can be
  // unusable at full strength even with the chat itself fully transparent.
  const bgAlpha = Math.max(0, Math.min(1, (SET.bgOpacity == null ? 100 : Number(SET.bgOpacity)) / 100));
  const bgHost = $('bg-media');
  if (bgHost) bgHost.style.opacity = String(bgAlpha);
  applyBgAudio(document.querySelector('#bg-media video'));
  // chat-panel transparency (0 = fully transparent, 100 = solid)
  const alpha = SET.chatOpacity == null ? 1 : Math.max(0, Math.min(1, Number(SET.chatOpacity) / 100));
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty('--ui-alpha', String(alpha));
  // ...and the frosted-glass filters, only when there is something to see
  // through. At full opacity the blur is 0px, but a `backdrop-filter` still
  // makes the browser keep a backdrop snapshot per element and composite it -
  // on every bubble and tool card in the transcript. Asking for a blur that
  // cannot be seen was the single most expensive thing this page did while
  // nothing was happening, so the declarations are not even present then.
  document.body.classList.toggle('ui-blur', alpha < 0.995);
  applyCustomCursor();
  // the jump-to-top button is parked above the composer, and the composer's
  // height just changed (text size, transparency, a different chat font)
  jumpTopDockH = 0;
  measureJumpTopDock();
  // chat font + text size. SET.fontFamily is either a preset key ('', mono,
  // serif, rounded) or a raw system font family name from the picker.
  const FONT_MAP = {
    '': '"Segoe UI", system-ui, -apple-system, sans-serif',
    mono: 'var(--mono)',
    serif: 'Georgia, "Times New Roman", serif',
    rounded: '"Comfortaa", "Varela Round", "Trebuchet MS", "Segoe UI", sans-serif',
  };
  /* Issue #201: whatever font is chosen for the conversation, emoji keep a
     family that has colour glyphs. --chat-font is what #chat, the markdown
     blocks, the composer and the banner use, so the fallback belongs here - a
     fallback on body alone never reached the AI's own output. */
  const EMOJI_FALLBACK = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji"';
  const primary = FONT_MAP[SET.fontFamily] ?? (SET.fontFamily ? `"${SET.fontFamily}", sans-serif` : FONT_MAP['']);
  const fontCss = `${primary}, ${EMOJI_FALLBACK}`;
  rootStyle.setProperty('--chat-font', fontCss);
  const chatPx = Number(SET.chatFontSize) || 14;
  rootStyle.setProperty('--chat-size', `${chatPx}px`);
  // Chat text is written in fixed sizes all over the stylesheet (thinking
  // blocks, code, tool cards, the message header). They all multiply by this
  // ratio, so the size setting moves the whole conversation together instead of
  // only the plain paragraphs.
  rootStyle.setProperty('--chat-scale', String(chatPx / 14));
  // shorts button follows the chosen feed
  const reels = $('btn-reels');
  if (reels) {
    const feed = SHORTS_FEEDS[SET.shortsProvider || 'instagram'];
    const desktop = typeof shortsAreDesktopOnly === 'function' && shortsAreDesktopOnly();
    if (feed && desktop) {
      reels.classList.remove('hidden');
      reels.textContent = feed.label;
      reels.title = `Open ${feed.label} in the app's own pane`;
    } else {
      reels.classList.add('hidden');
    }
  }
  /* The setup screen asks for a feed too, and it is the same answer. */
  const setupFeed = $('setup-shorts-provider');
  if (setupFeed) {
    const desktop = typeof shortsAreDesktopOnly === 'function' && shortsAreDesktopOnly();
    setupFeed.classList.toggle('hidden', !desktop);
    const setupLabel = $('setup-shorts-label');
    if (setupLabel) setupLabel.classList.toggle('hidden', !desktop);
  }
  // auto-expand defaults are applied when a block is rendered (makeThinking /
  // makeToolCard) and when the setting itself changes - never here. Resetting
  // every already-rendered block made unrelated settings (opacity, font size,
  // avatar size, cursor) close a thinking block or tool body the reader had
  // opened.
  // Runs here, once the settings are in: ?from=<instance> from the switcher.
  absorbFromParam();
  // The chatbox transparency readout used to be load-time wiring; it reads SET,
  // and this file loads before app.js defines it (issue #54 phase 7).
  $('set-chat-opacity').value = SET.chatOpacity == null ? 100 : Number(SET.chatOpacity);
  $('set-chat-opacity-val').textContent = `${SET.chatOpacity == null ? 100 : Number(SET.chatOpacity)}%`;
}

/* Searchable system-font picker: enumerate installed fonts via the bridge
 * (Windows font registry) and offer them in a datalist under the font input.
 * Preset names (System/Monospace/Serif/Rounded) stay available too. */
let systemFontsLoaded = false;
let systemFontsLoading = null;
let systemFonts = [];

/* The system font list is built when the font box is actually used, not when the
 * settings dialog opens.
 *
 * It is 295 options on this machine, they live in a hidden panel, and nothing can
 * see them until the font picker drops down - but they were built on the first
 * settings open, into a dialog that was being laid out at that moment. The fetch
 * behind it answers in 130 ms warm and 347 ms cold here, and every one of those
 * options then takes part in the dialog layout.
 *
 * This is not claimed to be the whole of issue #45 - the profile attached to that
 * issue shows openSettings() itself at 285 ms, which I could not reproduce with a
 * fresh browser profile. It is the one measurable piece of work in the open path
 * with no reason to be there. See verify/probe-settings-open.js. */
function loadSystemFonts() {
  const list = $('font-list');
  if (!list) return Promise.resolve();
  if (systemFontsLoaded) return Promise.resolve();
  if (systemFontsLoading) return systemFontsLoading;
  systemFontsLoading = (async () => {
    try {
      const d = await (await fetch(api('/api/system-fonts'))).json();
      const fonts = d.fonts || [];
      systemFonts = fonts;
      list.innerHTML = '';
      for (const f of fonts) list.appendChild(el('option', null, f));
      systemFontsLoaded = true;
    } catch { /* bridge may be old - picker still works with presets */ }
    finally { systemFontsLoading = null; }
  })();
  return systemFontsLoading;
}

/* Build it the moment the font box is focused or typed in, so it is there by the
 * time the picker drops down - and never before then. */
for (const ev of ['focus', 'input', 'pointerdown']) {
  $('set-font').addEventListener(ev, () => { loadSystemFonts(); }, { passive: true });
}

function applyFontChoice(value) {
  const v = (value || '').trim();
  const preset = {
    '': '', 'system (segoe ui)': '', 'monospace': 'mono', 'serif': 'serif', 'rounded': 'rounded',
  };
  if (v.toLowerCase() in preset) SET.fontFamily = preset[v.toLowerCase()];
  else SET.fontFamily = v; // raw system font family name
  saveSettings();
}

$('set-font').oninput = (e) => { applyFontChoice(e.target.value); };
$('set-font').onchange = (e) => { applyFontChoice(e.target.value); };

/* The font box used to be a native <input list="font-list"> - the browser's
 * datalist, which has its own black dropdown and ignores the app's menu design.
 * The arrow button opens the same .model-menu component the model, thinking,
 * instance and settings dropdowns use; the input stays a free-text field for a
 * family the list does not know. */
function fontMenuItems() {
  const current = String(SET.fontFamily || '');
  const pick = (label, value) => () => {
    const input = $('set-font');
    if (input) input.value = label;
    applyFontChoice(value);
  };
  const items = [
    { label: 'System (Segoe UI)', value: '', group: 'presets', active: current === '', onPick: pick('System (Segoe UI)', '') },
    { label: 'Monospace', value: 'mono', group: 'presets', active: current === 'mono', onPick: pick('Monospace', 'mono') },
    { label: 'Serif', value: 'serif', group: 'presets', active: current === 'serif', onPick: pick('Serif', 'serif') },
    { label: 'Rounded', value: 'rounded', group: 'presets', active: current === 'rounded', onPick: pick('Rounded', 'rounded') },
  ];
  for (const f of systemFonts) {
    items.push({ label: f, value: f, group: 'installed', active: current.toLowerCase() === f.toLowerCase(), onPick: pick(f, f) });
  }
  return items;
}

async function openFontMenu() {
  await loadSystemFonts();
  openMenu($('set-font'), fontMenuItems(), { title: 'font', width: 340, search: 'search fonts…', below: true });
}

/* Clicking the font field itself opens the picker, like every other dropdown.
 * There is no separate arrow button; the field keeps its typing/combobox role. */
$('set-font').addEventListener('click', (e) => {
  e.stopPropagation();
  openFontMenu().catch(() => { /* bridge may be old; the text box still works */ });
});
$('set-font').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || (e.key === 'Enter' && !e.isComposing)) {
    e.preventDefault();
    openFontMenu().catch(() => {});
  }
});
if ($('btn-font-reset')) $('btn-font-reset').onclick = () => {
  $('set-font').value = '';
  applyFontChoice('');
  toast('Font reset to system default');
};
$('set-font-size').oninput = (e) => {
  SET.chatFontSize = parseInt(e.target.value, 10) || 14;
  $('set-font-size-val').textContent = `${SET.chatFontSize}px`;
  // size only: the rest of applySettings() sweeps the transcript and is not
  // needed on every tick of the slider
  document.documentElement.style.setProperty('--chat-size', `${SET.chatFontSize}px`);
  document.documentElement.style.setProperty('--chat-scale', String(SET.chatFontSize / 14));
  jumpTopDockH = 0;
  measureJumpTopDock();
};
$('set-font-size').onchange = () => saveSettings();

/* text outline + avatar size + typing */
$('set-text-outline').onchange = (e) => { SET.textOutline = e.target.checked; saveSettings(); };
$('set-outline-color').oninput = (e) => { SET.textOutlineColor = e.target.value; applyThemeColours(); };
$('set-outline-color').onchange = () => saveSettings();
$('set-avatar-size').oninput = (e) => {
  SET.avatarSize = parseInt(e.target.value, 10);
  $('set-avatar-size-val').textContent = `${SET.avatarSize}px`;
  const avSize = Math.max(16, Math.min(120, Number(SET.avatarSize) || 34));
  document.documentElement.style.setProperty('--avatar-size', `${avSize}px`);
  jumpTopDockH = 0;
  measureJumpTopDock();
};
$('set-avatar-size').onchange = () => saveSettings();
$('set-avatar-animate').oninput = (e) => {
  // The slider runs 0..9: 0 is "none of them", 1-8 are a cap, 9 is "all of
  // them". "All" is stored as a negative so it cannot be confused with the 0
  // an older build wrote for "none".
  const v = parseInt(e.target.value, 10) || 0;
  SET.avatarAnimate = v === 0 ? -1 : (v >= 9 ? AVATAR_ALL : v);
  $('set-avatar-animate-val').textContent =
    v === 0 ? 'none of them' : (v >= 9 ? 'all of them' : `${v} newest`);
  // The group is rebuilt straight away, so a released decoder goes now rather
  // than at the next transcript render.
  animateAvatarGroup();
};
$('set-avatar-animate').onchange = () => saveSettings();
$('set-type-anywhere').onchange = (e) => { SET.typeAnywhere = e.target.checked; saveSettings(); };

/* shorts feed */
$('set-shorts-provider').onchange = (e) => { SET.shortsProvider = e.target.value; saveSettings(); };
$('set-shorts-auto').onchange = (e) => { SET.shortsAutoOpen = e.target.checked; saveSettings(); };
$('set-auto-continue').onchange = (e) => { SET.autoContinueAfterCompaction = e.target.checked; saveSettings(); };

