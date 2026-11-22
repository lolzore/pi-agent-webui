/*
 * Settings that own a piece of machinery rather than a value: the notification
 * sound, /reload, and the custom cursor. Split out of settings-ui.js (issue
 * #263). Loaded before settings-ui.js; the names stay global.
 */
'use strict';

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
  }
  const size = Math.max(16, Math.min(128, Number(SET.cursorSize) || 32));
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
  applyCustomCursor();
  syncCursorUi();
  // the note reports the size that was actually drawn, so it has to be told
  cursorNoteTimerSoon();
};
$('set-cursor-size').onchange = () => saveSettings();
for (const [id, key] of [['set-cursor-hot-x', 'cursorHotX'], ['set-cursor-hot-y', 'cursorHotY']]) {
  $(id).oninput = (e) => {
    SET[key] = parseInt(e.target.value, 10) || 0;
    applyCustomCursor();
    syncCursorUi();
  };
  $(id).onchange = () => saveSettings();
}

/* chatbox transparency: applies live while dragging, persists on release.
 * The value lines live in applySettings() now - they read SET. */
$('set-chat-opacity').oninput = (e) => {
  SET.chatOpacity = parseInt(e.target.value, 10);
  $('set-chat-opacity-val').textContent = `${SET.chatOpacity}%`;
  const alpha = Math.max(0, Math.min(1, Number(SET.chatOpacity) / 100));
  document.documentElement.style.setProperty('--ui-alpha', String(alpha));
  document.body.classList.toggle('ui-blur', alpha < 0.995);
  jumpTopDockH = 0;
  measureJumpTopDock();
};
$('set-chat-opacity').onchange = () => saveSettings();

/* background transparency / sound / gamer mode / done indicators / network */
$('set-bg-opacity').oninput = (e) => {
  SET.bgOpacity = parseInt(e.target.value, 10);
  $('set-bg-opacity-val').textContent = `${SET.bgOpacity}%`;
  const host = $('bg-media');
  if (host) host.style.opacity = String(Math.max(0, Math.min(1, SET.bgOpacity / 100)));
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
