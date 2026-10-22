/*
 * The settings dialog's own logic: applying a settings object to the page,
 * the system-font picker, the done-sound UI, the agent reload, the cursor
 * preview, LAN access, pi's compaction setting and the first-run setup dialog.
 *
 * Split out of app.js (issue #54, phase 7). Loaded before app.js; the names
 * stay global, so nothing else changed. Behaviour is unchanged.
 */
'use strict';

function applySettings() {
  // The name lives in the instance button now (it doubles as "who you are
  // looking at"), so guard it: a page without it must not break every setting.
  const nameEl = $('instance-name') || $('agent-title');
  if (nameEl) nameEl.textContent = displayAgentName() || 'pi agent';
  document.title = `${displayAgentName() || 'Pi agent'}`;
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
  const fontCss = FONT_MAP[SET.fontFamily] ?? (SET.fontFamily ? `"${SET.fontFamily}", sans-serif` : FONT_MAP['']);
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
  // auto-expand state on already-rendered elements
  document.querySelectorAll('details.thinking').forEach((d) => { d.open = SET.autoExpandThinking === true; });
  document.querySelectorAll('.tool-card .tool-body').forEach((b) => {
    b.classList.toggle('hidden', SET.autoExpandTools !== true);
  });
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
  applySettings();
};
$('set-font-size').onchange = () => saveSettings();

/* ── your own notification sound ────────────────────────────────────────────
 * The built-in chime is two sine tones; plenty of people want the one from
 * their phone, their stream deck, or nothing at all that sounds like an alert.
 * The file is stored through the bridge next to the other uploads and the
 * settings only ever hold its path, so nothing large lands in localStorage and
 * nothing is ever sent to a model.
 *
 * The same field also takes a plain URL, which is the escape hatch for people
 * who host their sounds somewhere already. */
/* What to show in the settings field for a stored file. An upload is a path
 * into the bridge's own uploads dir, and that path is not something to read or
 * edit by hand - the file's name is. A data URL has no name at all, so it says
 * so. Anything else (a plain http(s) URL the user typed) is shown as typed. */
function storedFileLabel(src) {
  if (!src) return '';
  const m = /\/api\/bg-file\?name=([^&]+)/.exec(src);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
  if (/^data:/i.test(src)) return 'embedded picture (this browser)';
  if (/^blob:/i.test(src)) return 'temporary file';
  return src;
}
/* The field never shows the real value of a stored upload, so the stored value
 * is kept alongside it - otherwise re-saving the dialog would store the label
 * instead of the path. */
function fieldToStored(value, previous) {
  const v = (value || '').trim();
  if (!v) return '';
  if (v === storedFileLabel(v)) return previous || '';   // they typed the label back
  return v;
}

function syncDoneSoundUi() {
  const inp = $('set-done-sound-file');
  if (!inp) return;
  const src = (SET.doneSoundUrl || '').trim();
  inp.value = storedFileLabel(src);
  inp.dataset.src = src;
  const clear = $('btn-done-sound-clear');
  if (clear) clear.disabled = !src;
  const note = $('done-sound-note');
  if (note) {
    note.textContent = src
      ? `Using “${storedFileLabel(src)}”. Clear it to go back to the built-in chime.`
      : 'mp3 / wav / ogg / m4a — stored on this machine, never sent to the model. The built-in two-note chime is used until you pick one.';
  }
}
if ($('set-done-sound-file')) $('set-done-sound-file').onchange = (e) => {
  SET.doneSoundUrl = fieldToStored(e.target.value, e.target.dataset.src);
  doneSoundEl = null; doneSoundSrc = null;    // force the next play to re-read it
  saveSettings();
  syncDoneSoundUi();
};
$('btn-done-sound-upload').onclick = () => $('done-sound-input').click();
$('done-sound-input').onchange = async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const up = await uploadFile(f);
    SET.doneSoundUrl = `/api/bg-file?name=${encodeURIComponent(String(up.path).split(/[\\/]/).pop())}`;
    doneSoundEl = null; doneSoundSrc = null;
    saveSettings();
    syncDoneSoundUi();
    if (SET.doneSound) playDoneSound();   // hear it immediately, not at the next finish
  } catch (err) {
    toast(`Could not store that sound: ${err.message}`, 'error');
  }
};
$('btn-done-sound-test').onclick = () => playDoneSound();
$('btn-done-sound-clear').onclick = () => {
  SET.doneSoundUrl = '';
  doneSoundEl = null; doneSoundSrc = null;
  saveSettings();
  syncDoneSoundUi();
  playBuiltInChime();
};

/* ── /reload ──────────────────────────────────────────────────────────────
 * pi's own /reload re-reads everything it loads from disk: extensions, skills,
 * prompt templates, keybindings and themes. It is a TUI command, and in RPC mode
 * there is no RPC call for it - the agent has to be started again, which is
 * exactly what pi does when the command changes something. The bridge resumes
 * the session the user was in before the new agent answers anything, so
 * restarting loses no conversation and no scroll position.
 *
 * This is the button in Settings > General; the same routine backs typing
 * /reload in the composer. */
let reloadPiBusy = false;
async function reloadPi(why) {
  if (reloadPiBusy) { toast('A reload is already running…', 'warning'); return; }
  if (S.isStreaming || S.compacting) {
    toast('The agent is busy — /reload after the turn ends (or press Stop first)', 'warning');
    return;
  }
  reloadPiBusy = true;
  const btn = $('btn-reload-pi');
  if (btn) { btn.disabled = true; btn.textContent = 'reloading…'; }
  toast('Reloading pi: extensions, skills, prompts, keybindings, themes…');
  try {
    const wait = waitForAgentReady(90000);
    send({ bridge: 'restart' });
    await wait;
    // The agent is back; read everything it now knows about off disk.
    await initSession(true);
    await Promise.all([
      refreshCommands().catch(() => {}),
      refreshBuiltinCommands().catch(() => {}),
      refreshModels().catch(() => {}),
      refreshLevels().catch(() => {}),
      refreshStats().catch(() => {}),
    ]);
    toast(why || 'pi reloaded — extensions, skills, prompts, keybindings and themes were re-read');
  } catch (err) {
    toast(`Reload failed: ${err.message}`, 'error');
  } finally {
    reloadPiBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = '/reload'; }
  }
}
$('btn-reload-pi').onclick = () => reloadPi();

/* ── custom cursor ─────────────────────────────────────────────────────────
 * Picture, size, hotspot. All three are applied the moment they change, so the
 * pointer is the new one while the dialog is still open - the alternative is
 * having to close the dialog to find out whether the value was any good. */
function syncCursorUi() {
  const f = $('set-cursor-file');
  if (f) {
    const src = (SET.cursorImage || '').trim();
    f.value = storedFileLabel(src);
    f.dataset.src = src;
  }  const size = Math.max(16, Math.min(128, Number(SET.cursorSize) || 32));
  if ($('set-cursor-size')) $('set-cursor-size').value = String(size);
  if ($('set-cursor-size-val')) $('set-cursor-size-val').textContent = `${size}px`;
  const hx = Math.max(0, Math.min(size, Number(SET.cursorHotX) || 0));
  const hy = Math.max(0, Math.min(size, Number(SET.cursorHotY) || 0));
  if ($('set-cursor-hot-x')) $('set-cursor-hot-x').value = String(hx);
  if ($('set-cursor-hot-y')) $('set-cursor-hot-y').value = String(hy);
  if ($('set-cursor-hot-val')) $('set-cursor-hot-val').textContent = `${hx}, ${hy}`;
  if ($('btn-cursor-clear')) $('btn-cursor-clear').disabled = !(SET.cursorImage || '').trim();
}
if ($('set-cursor-file')) $('set-cursor-file').onchange = (e) => {
  SET.cursorImage = fieldToStored(e.target.value, e.target.dataset.src);
  applySettings();
  syncCursorUi();
  verifyCustomCursor();
};
$('btn-cursor-upload').onclick = () => $('cursor-input').click();
$('cursor-input').onchange = async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const up = await uploadFile(f);
    SET.cursorImage = `/api/bg-file?name=${encodeURIComponent(String(up.path).split(/[\\/]/).pop())}`;
    applySettings();
    syncCursorUi();
    if (await verifyCustomCursor()) toast('Cursor applied. If the hotspot is in the wrong place, drag the X / Y sliders.');
  } catch (err) {
    toast(`Could not store that cursor: ${err.message}`, 'error');
  }
};
$('btn-cursor-clear').onclick = () => {
  SET.cursorImage = '';
  applySettings();
  syncCursorUi();
  verifyCustomCursor();
};
$('set-cursor-size').oninput = (e) => {
  SET.cursorSize = parseInt(e.target.value, 10) || 32;
  // The hotspot is a pixel inside the picture, so it can never be past its edge.
  SET.cursorHotX = Math.min(SET.cursorHotX, SET.cursorSize);
  SET.cursorHotY = Math.min(SET.cursorHotY, SET.cursorSize);
  applySettings();
  syncCursorUi();
  // the note reports the size that was actually drawn, so it has to be told
  cursorNoteTimerSoon();
};
$('set-cursor-size').onchange = () => saveSettings();
for (const [id, key] of [['set-cursor-hot-x', 'cursorHotX'], ['set-cursor-hot-y', 'cursorHotY']]) {
  $(id).oninput = (e) => {
    SET[key] = parseInt(e.target.value, 10) || 0;
    applySettings();
    syncCursorUi();
  };
  $(id).onchange = () => saveSettings();
}

/* chatbox transparency: applies live while dragging, persists on release.
 * The value lines live in applySettings() now - they read SET. */
$('set-chat-opacity').oninput = (e) => {
  SET.chatOpacity = parseInt(e.target.value, 10);
  $('set-chat-opacity-val').textContent = `${SET.chatOpacity}%`;
  applySettings();
};
$('set-chat-opacity').onchange = () => saveSettings();

/* background transparency / sound / gamer mode / done indicators / network */
$('set-bg-opacity').oninput = (e) => {
  SET.bgOpacity = parseInt(e.target.value, 10);
  $('set-bg-opacity-val').textContent = `${SET.bgOpacity}%`;
  applySettings();
};
$('set-bg-opacity').onchange = () => saveSettings();
$('set-bg-volume').oninput = (e) => {
  SET.bgVolume = parseInt(e.target.value, 10);
  $('set-bg-volume-val').textContent = `${SET.bgVolume}%`;
  applyBgAudio(document.querySelector('#bg-media video'));
};
$('set-bg-volume').onchange = () => saveSettings();
$('set-bg-audio').onchange = (e) => {
  SET.bgAudio = e.target.checked;
  saveSettings();
  applyBgAudio(document.querySelector('#bg-media video'));
  if (SET.bgAudio) toast('Background sound follows the volume slider — browsers only allow it after you click the page');
};
$('set-gamer').onchange = (e) => {
  SET.gamerMode = e.target.checked;
  setGamerSpeedVisible(SET.gamerMode);
  saveSettings();
};
/* The speed row is a label plus its slider in the settings grid: hiding only one
 * half left a stray label (or a stray slider) in the middle of the tab. */
function setGamerSpeedVisible(on) {
  const row = $('gamer-speed-row');
  const label = $('gamer-speed-label');
  if (row) row.classList.toggle('hidden', !on);
  if (label) label.classList.toggle('hidden', !on);
}

/* The cycle is driven by the clock, so a new speed only has to be stored: the
 * next frame picks it up (no restart, no visible jump). */
$('set-gamer-speed').oninput = (e) => {
  SET.gamerSpeed = parseInt(e.target.value, 10) || 16;
  $('set-gamer-speed-val').textContent = `${SET.gamerSpeed}s`;
  startGamerAccent();   // already running: the next frame just uses the new speed
};
$('set-gamer-speed').onchange = () => saveSettings();
$('set-done-sound').onchange = (e) => {
  SET.doneSound = e.target.checked;
  saveSettings();
  if (SET.doneSound) playDoneSound();   // so you can hear what you just enabled
};
$('set-done-notify').onchange = (e) => {
  SET.doneNotify = e.target.checked;
  saveSettings();
  if (SET.doneNotify && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().then((perm) => {
      toast(perm === 'granted' ? 'Notifications enabled' : 'Notifications are blocked in this browser', perm === 'granted' ? undefined : 'warning');
    });
  }
};
$('set-done-only-unfocused').onchange = (e) => {
  SET.doneOnlyUnfocused = e.target.checked;
  saveSettings();
};
/* Flip the network switch. Both the Settings checkbox and the first-run dialog call
 * this: moving the listening socket drops the connections open on it, so the request
 * can be lost even though it was on its way - which is why the retry lives here and
 * not in either caller. */
async function setLanAccess(on, box) {
  const cb = box || null;
  if (cb) cb.disabled = true;
  lanBusy = true;
  const post = () => fetch(api('/api/lan'), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ lan: on }),
  }).then((r) => r.json());
  try {
  let d = null;
  let lastErr = null;
  // Moving the listening socket drops the connections open on it, so a request
  // can be lost even though it was on its way - and a second flip made while
  // the first is still moving hits exactly that window, which is why the switch
  // sometimes had to be clicked twice. Keep asking: what the user asked for is
  // what happens, as soon as the socket is there to hear it.
  for (let attempt = 0; attempt < 6 && !d; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 300 * attempt));
    try { d = await post(); } catch (err) { lastErr = err; }
  }
  if (!d) throw lastErr || new Error('the bridge did not answer');
  if (d.error) throw new Error(d.error);
  // The bridge's answer is the state it ended up in. Asking again right away
  // raced the socket rebind (it happens 250ms later), so the box was read back
  // as "off" and clicked straight back off - which is why it sometimes took two
  // clicks to switch it either way.
  if (cb) cb.checked = !!d.lan;
  toast(d.lan ? `Network access on${d.url ? ` — ${d.url}` : ''}` : 'Network access off (this machine only)');
  if (d.note) toast(d.note, 'warning');
  renderLanHint(d, cb);            // the IP line, immediately - no second round trip
  } catch (err) {
  // Moving the listening socket closes connections, so the answer can be lost
  // even though the switch worked; ask the bridge before calling it a failure.
  await new Promise((r) => setTimeout(r, 600));
  try {
    const d = await fetch(api('/api/lan')).then((r) => r.json());
    if (!!d.lan === on) { renderLanHint(d, cb); toast(on ? 'Network access on' : 'Network access off (this machine only)'); return; }
  } catch { /* still unreachable */ }
  if (cb) cb.checked = !on;
  toast(`Could not change network access: ${err.message}`, 'error');
  } finally {
  if (cb) cb.disabled = false;
  lanBusy = false;
  }

  }

$('set-lan').onchange = (e) => setLanAccess(e.target.checked, e.target);

/* Network access is a file the bridge reads at startup (bridge/lan.json) and
 * rewrites live, so this reports the bridge's own view rather than a guess. */
/* True while the switch is being flipped: the answer that is still coming can
 * describe the state before the flip, and letting it write over the checkbox is
 * the other half of "sometimes it takes two clicks". */
let lanBusy = false;
/* The IP line under the switch, from the bridge's own answer. */
function renderLanHint(d, box) {
  const hint = $('lan-hint');
  if (box && !lanBusy) box.checked = !!d.lan;
  if (!hint || !d) return;
  hint.textContent = d.lan
    ? `Reachable from your network${d.url ? ` at ${d.url}` : ''}. Anyone who can reach it can drive this agent — there is no login.`
      + (d.envOverride ? ' (PI_WEBUI_HOST is set, so it wins on the next start.)' : '')
    : 'Local only. Turning this on lets every device on your network drive this agent — there is no login.';
}

/* Flipping the switch moves the listening socket, which drops the connections
 * open on it - so this read can fail for a moment even though nothing is wrong,
 * and it used to give up right there and leave "Could not read the bridge
 * setting." on screen until the dialog was reopened. Ask again instead. */
async function refreshLanSetting(attempts = 4) {
  const box = $('set-lan');
  const hint = $('lan-hint');
  if (!box && !hint) return null;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, 250 * i));
    try {
      const d = await fetch(api('/api/lan'), { cache: 'no-store' }).then((r) => r.json());
      if (d && 'lan' in d) { renderLanHint(d, box); return d; }
      lastErr = new Error('unexpected answer');
    } catch (e) { lastErr = e; }
  }
  // The toggle's own answer is better information than this, so only say so when
  // there is nothing else on screen.
  if (hint && !lanBusy && !hint.textContent) hint.textContent = 'Could not read the bridge setting.';
  return lastErr;
}

/* text outline + avatar size + typing */
$('set-text-outline').onchange = (e) => { SET.textOutline = e.target.checked; saveSettings(); };
$('set-outline-color').oninput = (e) => { SET.textOutlineColor = e.target.value; applySettings(); };
$('set-outline-color').onchange = () => saveSettings();
$('set-avatar-size').oninput = (e) => {
  SET.avatarSize = parseInt(e.target.value, 10);
  $('set-avatar-size-val').textContent = `${SET.avatarSize}px`;
  applySettings();
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

/* pi's own auto-compaction, changed over RPC (issue #56). pi persists it in
 * settings.json, so the checkbox reads the bridge's copy of that file and the
 * RPC is what applies it live. */
async function loadPiConfig() {
  const box = $('set-pi-compaction');
  if (!box) return;
  try {
    const d = await fetch(api('/api/pi-config'), { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
    box.checked = !(d && d.compaction && d.compaction.enabled === false);
    box.disabled = false;
    box.title = 'pi compacts the context itself when it passes the threshold (set_auto_compaction) — this is separate from the auto-continue above';
    setPiCompactionNote('');
  } catch {
    /* An old bridge has no /api/pi-config at all (issue #91): the checkbox
     * could neither read nor write, and a disabled control with no explanation
     * is exactly the "random not working button" from the report. Say what to
     * do instead. */
    box.checked = false;
    box.disabled = true;
    box.title = '';
    setPiCompactionNote('this bridge is running an older build — restart it to use this setting');
  }
}
function setPiCompactionNote(text) {
  const n = $('set-pi-compaction-note');
  if (n) n.textContent = text || '';
}
$('set-pi-compaction').onchange = async (e) => {
  const enabled = e.target.checked;
  e.target.disabled = true;
  try {
    await rpc({ type: 'set_auto_compaction', enabled });
    toast(`pi auto-compaction ${enabled ? 'enabled' : 'disabled'}`);
  } catch (err) {
    e.target.checked = !enabled;   // pi refused: do not show a state that is not there
    toast(`Could not change pi's auto-compaction: ${err.message}`, 'error');
  } finally { e.target.disabled = false; }
};

/* settings tabs */
document.querySelectorAll('#settings-tabs .tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('#settings-tabs .tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('#settings-dialog .tab-panel').forEach((p) => {
      p.classList.toggle('hidden', p.id !== `tab-${t.dataset.tab}`);
    });
    /* Only this tab wants the llama probe; asking for it when the tab is
     * actually shown is what keeps Settings from probing on every open
     * (issue #106). */
    if (t.dataset.tab === 'providers' && typeof loadPiProviders === 'function') loadPiProviders();
  };
});

/* ── first-launch setup ──────────────────────────────────────────────────
 * The one dialog everybody sees once: who the agent is, how it looks, how it
 * should tell you it is done, and whether other devices may reach it. Everything
 * here is also in Settings - the point is not to make people configure a UI
 * before they can type, it is that the handful of things worth choosing up front
 * (a name, a face, a readable text size, notifications, network access) are
 * actually offered. */
let setupLanWas = null;

function setSetupGamerVisible(on) {
  const row = $('setup-gamer-speed-row');
  const label = $('setup-gamer-speed-label');
  if (row) row.classList.toggle('hidden', !on);
  if (label) label.classList.toggle('hidden', !on);
}

function refreshSetupPreview() {
  const prev = $('setup-avatar-preview');
  if (!prev) return;
  if (SET.avatar) {
    const node = avatarNode(undefined, true);
    prev.replaceChildren(...node.childNodes);
    prev.style.visibility = 'visible';
  } else {
    prev.replaceChildren();
    prev.style.visibility = 'hidden';
  }
}

/* The first-run packages step (issue #121): what each package is for, with the
 * ones already in settings.json ticked and locked. The ticked ones are installed
 * when the wizard finishes, and the agent is restarted to pick them up. */
const SETUP_PACKAGES = [
  { source: 'npm:pi-searxng', label: 'Web search', note: 'search with searxng and browse with camoufox - install those two separately:', links: [['searxng', 'https://github.com/searxng/searxng'], ['camoufox', 'https://github.com/daijro/camoufox']] },
  { source: 'npm:pi-llama-cpp', label: 'Local AI', note: 'point pi at a llama.cpp server - recommended when one is running' },
  { source: 'npm:pi-goal-x', label: 'Goals', note: 'the goal bar, goal records and the goal tools' },
  { source: 'npm:pi-subagents', label: 'Subagents', note: 'run delegated child agents' },
];

function setupShowStep(step) {
  const packages = step === 'packages';
  $('setup-step-packages').classList.toggle('hidden', !packages);
  $('setup-step-prefs').classList.toggle('hidden', packages);
  $('setup-done').textContent = packages ? 'next' : "Let's go";
}

async function renderSetupPackages() {
  const box = $('setup-packages-list');
  if (!box) return;
  box.innerHTML = '';
  let installed = [];
  try {
    const d = await fetch(api('/api/pi-extensions'), { cache: 'no-store' }).then((r) => r.json());
    installed = (d.packages || []).map((p) => String(p.source || ''));
  } catch { /* offline: show them all as not installed */ }
  for (const p of SETUP_PACKAGES) {
    const isIn = installed.includes(p.source);
    const row = el('label', 'check-label');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = isIn;
    cb.disabled = isIn;
    cb.dataset.package = p.source;
    row.appendChild(cb);
    row.appendChild(el('span', null, `${p.label} — ${p.source}${isIn ? ' (installed)' : ''}`));
    box.appendChild(row);
    const note = el('div', 'hint', p.note);
    for (const [text, href] of p.links || []) {
      const a = el('a', null, text);
      a.href = href;
      a.target = '_blank';
      a.rel = 'noreferrer';
      note.appendChild(document.createTextNode(' '));
      note.appendChild(a);
    }
    box.appendChild(note);
  }
}

/* Install what the wizard ticked. Returns how many were added. */
async function installSetupPackages() {
  const picked = [...document.querySelectorAll('#setup-packages-list input[data-package]')]
    .filter((c) => c.checked && !c.disabled)
    .map((c) => c.dataset.package);
  let added = 0;
  for (const source of picked) {
    try {
      const r = await fetch(api('/api/pi-extensions/package'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', source }),
      });
      if (r.ok) added += 1;
    } catch { /* the count below tells the story */ }
  }
  return added;
}

function maybeShowSetup() {
  if (SET.onboarded) return;
  $('setup-agent-name').value = SET.agentName === 'pi' ? '' : SET.agentName;
  $('setup-shorts-provider').value = SHORTS_FEEDS[SET.shortsProvider] ? SET.shortsProvider : 'instagram';
  $('setup-accent').value = SET.themeAccent || '#5b9dff';
  $('setup-gamer').checked = !!SET.gamerMode;
  $('setup-gamer-speed').value = String(Number(SET.gamerSpeed) || 16);
  $('setup-gamer-speed-val').textContent = `${Number(SET.gamerSpeed) || 16}s`;
  setSetupGamerVisible(!!SET.gamerMode);
  $('setup-font-size').value = String(Number(SET.chatFontSize) || 14);
  $('setup-font-size-val').textContent = `${Number(SET.chatFontSize) || 14}px`;
  $('setup-done-sound').checked = !!SET.doneSound;
  $('setup-done-notify').checked = !!SET.doneNotify;
  $('setup-voice-autosend').checked = !!SET.voiceAutoSend;
  $('setup-lan').checked = false;
  setupLanWas = null;
  // The bridge's own view of the network switch (it lives in a file, not in the
  // UI settings), so the box starts on the truth rather than on "off".
  fetch(api('/api/lan')).then((r) => r.json()).then((d) => {
    setupLanWas = !!d.lan;
    if ($('setup-lan') && $('setup-dialog').open) $('setup-lan').checked = !!d.lan;
  }).catch(() => { /* no bridge answer: leave it off */ });
  refreshSetupPreview();
  setupShowStep('packages');
  renderSetupPackages().catch(() => {});
  $('setup-dialog').showModal();
}
$('setup-skip').onclick = () => {
  SET.onboarded = true;
  saveSettings();
  $('setup-dialog').close();
};
$('setup-accent-reset').onclick = () => { $('setup-accent').value = '#5b9dff'; };
$('setup-gamer').onchange = (e) => {
  setSetupGamerVisible(e.target.checked);
  SET.gamerMode = e.target.checked;
  applySettings();     // so the drift starts (or stops) while you look at it
};
$('setup-gamer-speed').oninput = (e) => {
  SET.gamerSpeed = parseInt(e.target.value, 10) || 16;
  $('setup-gamer-speed-val').textContent = `${SET.gamerSpeed}s`;
};
$('setup-font-size').oninput = (e) => {
  SET.chatFontSize = parseInt(e.target.value, 10) || 14;
  $('setup-font-size-val').textContent = `${SET.chatFontSize}px`;
  applySettings();     // picked to be read, so show it while it is picked
};
$('setup-done-sound').onchange = (e) => { SET.doneSound = e.target.checked; if (e.target.checked) playDoneSound(); };
$('setup-done-notify').onchange = (e) => {
  SET.doneNotify = e.target.checked;
  if (e.target.checked && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
};
// The two uploads reuse the Settings inputs (and their upload, crop and clear
// paths) instead of growing a second copy of them.
$('setup-avatar-upload').onclick = () => $('avatar-input').click();
$('setup-bg-upload').onclick = () => $('bg-input').click();
$('setup-avatar-clear').onclick = () => $('btn-avatar-clear').click();
$('setup-bg-clear').onclick = () => $('btn-bg-clear').click();
$('setup-done').onclick = async () => {
  // Step one is the package checklist; "next" moves on to the preferences.
  if (!$('setup-step-packages').classList.contains('hidden')) { setupShowStep('prefs'); return; }
  const name = $('setup-agent-name').value.trim();
  if (name) SET.agentName = name;
  const prov = $('setup-shorts-provider').value;
  if (SHORTS_FEEDS[prov] || prov === 'none') SET.shortsProvider = prov;
  const acc = $('setup-accent').value;
  SET.themeAccent = acc && acc !== '#5b9dff' ? acc : null;
  SET.gamerMode = $('setup-gamer').checked;
  SET.gamerSpeed = parseInt($('setup-gamer-speed').value, 10) || 16;
  SET.chatFontSize = parseInt($('setup-font-size').value, 10) || 14;
  SET.doneSound = $('setup-done-sound').checked;
  SET.doneNotify = $('setup-done-notify').checked;
  SET.voiceAutoSend = $('setup-voice-autosend').checked;
  SET.onboarded = true;
  saveSettings();
  $('setup-dialog').close();
  const wantLan = $('setup-lan').checked;
  toast(`Welcome, ${SET.agentName || 'pi'}!`);
  const added = await installSetupPackages();
  if (added) {
    toast(`${added} package${added > 1 ? 's' : ''} added — restarting the agent to pick them up`);
    send({ bridge: 'restart' });
  }
  // Only touch the network switch when the answer changed (it rebinds a socket).
  if (setupLanWas !== null && wantLan !== setupLanWas) setLanAccess(wantLan, $('setup-lan'));
};
