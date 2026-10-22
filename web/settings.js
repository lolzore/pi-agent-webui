/*
 * The settings dialog: general, voice, appearance and shorts tabs.
 *
 * Split out of app.js (issue #54). Loaded before app.js; the names stay
 * global, so nothing else changed. Behaviour is unchanged.
 */
'use strict';

/* ───────────────────────── settings dialog ───────────────────────── */

function populateTtsVoiceSelect() {
  const sel = $('set-tts-voice');
  if (!sel) return;
  const voices = ttsVoices();
  const current = currentTtsVoice();
  sel.innerHTML = '';
  for (const v of voices) {
    const o = el('option', null, `${v.name} (${v.lang})`);
    o.value = v.voiceURI;
    sel.appendChild(o);
  }
  if (voices.length) {
    sel.value = (SET.ttsVoiceURI && voices.some((v) => v.voiceURI === SET.ttsVoiceURI))
      ? SET.ttsVoiceURI
      : (current ? current.voiceURI : voices[0].voiceURI);
  } else {
    sel.appendChild(el('option', null, '(no voices installed)'));
  }
}

/* The Shorts tab is the desktop app's: it configures the pane that only exists
 * there (a browser cannot embed the real feeds - they refuse with
 * X-Frame-Options), so the browser's settings do not offer it. */
function applyDesktopOnlyTabs() {
  const desktop = /Electron/i.test(navigator.userAgent);
  const tab = document.querySelector('#settings-tabs .tab[data-tab="shorts"]');
  const panel = $('tab-shorts');
  if (tab) tab.classList.toggle('hidden', !desktop);
  if (!panel) return;
  if (desktop) return;
  const wasActive = !!(tab && tab.classList.contains('active'));
  panel.classList.add('hidden');
  if (wasActive) {
    const general = document.querySelector('#settings-tabs .tab[data-tab="general"]');
    if (general) general.click();
  }
}

function openSettings() {
  applyDesktopOnlyTabs();
  const note = $('remote-settings-note');
  if (note) {
    if (S.remote) {
      note.classList.remove('hidden');
      note.textContent = `You are looking at ${S.remoteName || S.remote}. Its agent name, picture and background come from that instance — the settings here are this machine's own UI.`;
    } else note.classList.add('hidden');
  }
  $('set-agent-name').value = SET.agentName === 'pi' ? '' : SET.agentName;
  $('set-agent-name').placeholder = SET.agentName || 'pi';
  const prev = $('set-avatar-preview');
  if (SET.avatar) { prev.src = SET.avatar; prev.style.visibility = 'visible'; }
  else prev.style.visibility = 'hidden';
  $('set-voice-autosend').checked = !!SET.voiceAutoSend;
  $('set-font').value = SET.fontFamily || '';
  $('set-show-thinking').checked = SET.showThinking !== false;
  $('set-expand-thinking').checked = !!SET.autoExpandThinking;
  $('set-expand-tools').checked = !!SET.autoExpandTools;
  $('set-stt-endpoint').value = SET.sttEndpoint || '';
  syncVoiceSettingsUi();
  $('set-tts-backend').value = SET.ttsBackend || 'browser';
  if ($('set-tts-apikey')) $('set-tts-apikey').value = SET.ttsApiKey || '';
  if ($('set-tts-cloud-model')) $('set-tts-cloud-model').value = SET.ttsCloudModel || '';
  if ($('set-tts-cloud-voice')) $('set-tts-cloud-voice').value = SET.ttsCloudVoice || '';
  if ($('set-tts-cloud-url')) $('set-tts-cloud-url').value = SET.ttsCloudUrl || '';
  syncTtsSettingsUi();
  $('set-tts-endpoint').value = SET.ttsEndpoint || '';
  $('set-tts-model').value = SET.ttsModel || '';
  $('set-tts-voice-name').value = SET.ttsVoiceName || '';
  $('set-accent').value = SET.themeAccent || '#5b9dff';
  $('set-bg-url').value = SET.themeBg && !SET.themeBg.startsWith('data:') && !SET.themeBg.startsWith('/api/bg-file') ? SET.themeBg : '';
  $('set-tts-rate').value = SET.ttsRate;
  $('set-tts-rate-val').textContent = Number(SET.ttsRate).toFixed(2);
  // The system font list is NOT loaded here. It is 295 options in a hidden
  // panel, it has no reason to be in the dialog layout, and it belongs to the
  // font box - loadSystemFonts() is wired to that box instead.
  $('set-font-size').value = Number(SET.chatFontSize) || 14;
  $('set-font-size-val').textContent = `${Number(SET.chatFontSize) || 14}px`;
  $('set-chat-opacity').value = SET.chatOpacity == null ? 100 : Number(SET.chatOpacity);
  $('set-chat-opacity-val').textContent = `${SET.chatOpacity == null ? 100 : Number(SET.chatOpacity)}%`;
  $('set-bg-opacity').value = SET.bgOpacity == null ? 100 : Number(SET.bgOpacity);
  $('set-bg-opacity-val').textContent = `${SET.bgOpacity == null ? 100 : Number(SET.bgOpacity)}%`;
  $('set-bg-volume').value = SET.bgVolume == null ? 50 : Number(SET.bgVolume);
  $('set-bg-volume-val').textContent = `${SET.bgVolume == null ? 50 : Number(SET.bgVolume)}%`;
  $('set-bg-audio').checked = !!SET.bgAudio;
  $('set-gamer').checked = !!SET.gamerMode;
  if ($('set-gamer-speed')) {
    $('set-gamer-speed').value = String(Number(SET.gamerSpeed) || 16);
    $('set-gamer-speed-val').textContent = `${Number(SET.gamerSpeed) || 16}s`;
    setGamerSpeedVisible(!!SET.gamerMode);
  }
  $('set-done-sound').checked = !!SET.doneSound;
  $('set-done-notify').checked = !!SET.doneNotify;
  $('set-done-only-unfocused').checked = SET.doneOnlyUnfocused !== false;
  syncDoneSoundUi();
  syncCursorUi();
  // Say whether the stored picture is one the browser can actually draw. A
  // cursor the browser cannot decode is accepted by the CSS and then silently
  // ignored at paint time, so without this the setting looks on and the screen
  // shows the ordinary arrow - which reads as "the custom cursor does not work".
  if ((SET.cursorImage || '').trim()) verifyCustomCursor();
  refreshLanSetting().catch(() => {});
  const tOut = $('set-text-outline');
  if (tOut) tOut.checked = SET.textOutline !== false;
  const tCol = $('set-outline-color');
  if (tCol) tCol.value = SET.textOutlineColor || '#000000';
  const avSize = $('set-avatar-size');
  if (avSize) {
    avSize.value = String(Number(SET.avatarSize) || 34);
    $('set-avatar-size-val').textContent = `${Number(SET.avatarSize) || 34}px`;
  }
  const avAnim = $('set-avatar-animate');
  if (avAnim) {
    // avatarAnimateCount() is the authority - it is what the ticker will use.
    // The slider runs "none" .. 1-8 .. "all", so it has to be read back out of
    // the stored value rather than shown raw.
    const n = avatarAnimateCount();
    avAnim.value = String(n === 0 ? 0 : (n === Infinity ? 9 : n));
    $('set-avatar-animate-val').textContent =
      n === 0 ? 'none of them' : (n === Infinity ? 'all of them' : `${n} newest`);
  }
  const ta = $('set-type-anywhere');
  if (ta) ta.checked = SET.typeAnywhere === true;
  $('set-shorts-provider').value = SHORTS_FEEDS[SET.shortsProvider] ? SET.shortsProvider : 'none';
  $('set-shorts-auto').checked = SET.shortsAutoOpen === true;
  $('set-auto-continue').checked = SET.autoContinueAfterCompaction !== false;
  populateDefaultModelSelect();
  loadPiConfig();
  loadPiProviders();
  loadAuthProviders();
  loadExtensionsTab();
  prettifySettingsSelects();
  const t0 = performance.now();
  $('settings-dialog').showModal();
  /* The voice select is filled when the reader opens *it*, not here: the first
   * speechSynthesis.getVoices() can block for a second or more (Firefox starts
   * its speech service there), and filling it on open made even closing the
   * dialog wait for the speech service (issue #150). The dropdown's own open
   * handler in prettySelect() does it. */
  /* Issue #117: the click is handled synchronously, but the dialog's first
   * paint can lag behind a busy page. The frame time and any long tasks in
   * that window are recorded on S (and warned about when they are bad), so the
   * question "is it the page or the browser?" has a number instead of a
   * feeling. */
  const long = [];
  let po = null;
  try {
    po = new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(Math.round(e.duration)); });
    po.observe({ entryTypes: ['longtask'] });
  } catch { /* older browser: no longtask observer */ }
  requestAnimationFrame(() => {
    S.settingsOpenMs = Math.round(performance.now() - t0);
    if (po) { try { po.disconnect(); } catch { /* already gone */ } }
    S.settingsLongTasks = long.slice(0, 8);
    if (S.settingsOpenMs > 500) {
      console.warn(`[pi] the settings dialog took ${S.settingsOpenMs}ms to reach a frame; long tasks: ${S.settingsLongTasks.join(', ') || 'none'}`);
    }
  });
}

$('btn-settings').onclick = openSettings;
$('settings-close').onclick = () => $('settings-dialog').close();
// The providers retry and the auth dropdown both belong to the dialog: stop
// them when it closes (the X, Escape, or a programmatic close).
$('settings-dialog').addEventListener('close', () => { stopPiProvidersRetry(); closeAuthProviderMenu(); });

$('set-agent-name').addEventListener('change', (e) => {
  SET.agentName = e.target.value.trim() || 'pi';
  saveSettings();
  toast(`Agent renamed to "${SET.agentName}"`);
});

$('btn-avatar-upload').onclick = () => $('avatar-input').click();
async function acceptAvatarFile(f) {
  if (!f) return;
  const isVideo = f.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv|mkv)$/i.test(f.name);
  const isImage = f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(f.name);
  if (!isVideo && !isImage) { toast('Pick an image, GIF or video file', 'warning'); return; }
  toast(isVideo ? 'Uploading profile video…' : 'Uploading profile image…');
  try {
    // Uploaded like the background rather than inlined: a GIF or a short video
    // as a data URL would blow the localStorage quota.
    const up = await uploadFile(f);
    SET.avatar = `/api/bg-file?name=${encodeURIComponent(up.path.split(/[\\/]/).pop())}`;
    SET.avatarCrop = null;
    saveSettings();
    toast('Profile image updated — adjust the framing if needed');
    openCropper('avatar');
  } catch (err) {
    if (isImage && f.size < 1.5 * 1024 * 1024) {
      try {
        SET.avatar = await readAsDataUrl(f);
        SET.avatarCrop = null;
        saveSettings();
        toast('Profile image set for this session (bridge not reachable to store it)');
        return;
      } catch { /* fall through */ }
    }
    toast(`Upload failed: ${err.message}`, 'error');
  }
}

$('avatar-input').onchange = (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  return acceptAvatarFile(f);
};
$('btn-avatar-crop').onclick = () => openCropper('avatar');
$('btn-avatar-clear').onclick = () => {
  SET.avatar = null;
  SET.avatarCrop = null;
  saveSettings();
  toast('Profile image removed');
};

$('set-tts-voice').onchange = (e) => { SET.ttsVoiceURI = e.target.value || null; saveSettings(); };
$('set-tts-rate').oninput = (e) => {
  SET.ttsRate = parseFloat(e.target.value);
  $('set-tts-rate-val').textContent = SET.ttsRate.toFixed(2);
};
$('set-tts-rate').onchange = () => saveSettings();
$('btn-tts-test').onclick = () => speak('This is how the agent will sound.');
$('set-voice-autosend').onchange = (e) => {
  SET.voiceAutoSend = e.target.checked;
  saveSettings();
};
$('set-show-thinking').onchange = (e) => {
  SET.showThinking = e.target.checked;
  saveSettings();
};
$('set-show-tools').onchange = (e) => {
  SET.showToolCalls = e.target.checked;
  saveSettings();
};
$('set-expand-thinking').onchange = (e) => {
  SET.autoExpandThinking = e.target.checked;
  saveSettings();
};
$('set-expand-tools').onchange = (e) => {
  SET.autoExpandTools = e.target.checked;
  saveSettings();
};
$('set-stt-endpoint').addEventListener('change', (e) => {
  SET.sttEndpoint = e.target.value.trim();
  saveSettings();
  toast(SET.sttEndpoint ? 'Whisper endpoint set — the mic will use it' : 'Whisper endpoint cleared — using browser voice');
});
$('set-stt-backend').onchange = async (e) => {
  SET.sttBackend = e.target.value;
  saveSettings();
  // Show what this backend needs immediately. Waiting for the dialog to be
  // reopened (save + ⚙ again) made it look like the choice had not taken.
  syncVoiceSettingsUi();
  if (!sttModelsLoaded) await loadSttModels().catch(() => {});
  toast(SET.sttBackend === 'whisper'
    ? 'Voice input: Whisper server' + (SET.sttEndpoint ? ` (${SET.sttEndpoint})` : ' (auto local server)')
    : 'Voice input: browser speech recognition (Chrome/Edge only)');
};
$('set-tts-backend').onchange = (e) => { SET.ttsBackend = e.target.value; saveSettings(); syncTtsSettingsUi(); };
$('set-tts-apikey').onchange = (e) => { SET.ttsApiKey = e.target.value.trim(); saveSettings(); toast('Voice key saved (it lives in the bridge settings)'); };
$('set-tts-cloud-model').onchange = (e) => { SET.ttsCloudModel = e.target.value.trim(); saveSettings(); };
$('set-tts-cloud-voice').onchange = (e) => { SET.ttsCloudVoice = e.target.value.trim(); saveSettings(); };
$('set-tts-cloud-url').onchange = (e) => { SET.ttsCloudUrl = e.target.value.trim(); saveSettings(); };
$('set-tts-endpoint').addEventListener('change', (e) => { SET.ttsEndpoint = e.target.value.trim(); saveSettings(); });
$('set-tts-model').addEventListener('change', (e) => { SET.ttsModel = e.target.value.trim(); saveSettings(); });
$('set-tts-voice-name').addEventListener('change', (e) => { SET.ttsVoiceName = e.target.value.trim(); saveSettings(); });
$('set-accent').addEventListener('input', (e) => { SET.themeAccent = e.target.value || null; saveSettings(); });
$('btn-accent-reset').onclick = () => { SET.themeAccent = null; saveSettings(); toast('Theme color reset'); };
$('set-bg-url').addEventListener('change', (e) => { SET.themeBg = e.target.value.trim() || null; saveSettings(); });
$('btn-bg-upload').onclick = () => $('bg-input').click();
$('bg-input').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  // Anything the user picks is uploaded to the bridge and referenced by URL —
  // a multi-MB GIF/video as a data URL would overflow localStorage.
  const isVideo = f.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv|mkv)$/i.test(f.name);
  const isImage = f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(f.name);
  if (!isVideo && !isImage) { toast('Pick an image, GIF or video file', 'warning'); return; }
  await setBackgroundFromFile(f);
}

/* Store a picked file as the background. No size limit here on purpose: this
 * file is never sent to the model, it is only written to the workspace and shown
 * behind the UI. */
async function setBackgroundFromFile(f) {
  const isVideo = f.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv|mkv)$/i.test(f.name);
  const isImage = f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(f.name);
  toast(isVideo ? 'Uploading background video…' : 'Uploading background…');
  try {
    const up = await uploadFile(f);
    SET.themeBg = `/api/bg-file?name=${encodeURIComponent(up.path.split(/[\\/]/).pop())}`;
    SET.bgCrop = null;
    saveSettings();
    toast(isVideo ? 'Video background set' : 'Background set');
    openCropper('bg');
  } catch (err) {
    // offline bridge: fall back to inlining small images so it still works
    if (isImage && f.size < 1.5 * 1024 * 1024) {
      try {
        SET.themeBg = await readAsDataUrl(f);
        saveSettings();
        toast('Background set for this session (bridge not reachable to store it)');
        return;
      } catch { /* fall through */ }
    }
    toast(`Upload failed: ${err.message}`, 'error');
  }
};
$('btn-bg-clear').onclick = () => { SET.themeBg = null; SET.bgCrop = null; saveSettings(); };
$('btn-bg-crop').onclick = () => openCropper('bg');

/* Apply SET.themeBg to the page. Images, GIFs and videos all render as a real
 * element behind the app, so one code path (and one crop) covers all three -
 * a body background-image could not be zoomed or panned by hand. */
/* The accent, the outline colour and the avatar size: everything that gamer mode
 * (or a settings change) has to be able to put back on its own. */
function applyThemeColours() {
  const rootStyle = document.documentElement.style;
  // text outline: a 4-way shadow keeps glyphs readable when the panels are
  // translucent and the background image shows through.
  document.body.classList.toggle('text-outline', SET.textOutline !== false);
  rootStyle.setProperty('--outline-color', SET.textOutlineColor || '#000000');
  if (SET.themeAccent) {
    rootStyle.setProperty('--accent', SET.themeAccent);
    rootStyle.setProperty('--accent-dim', `color-mix(in srgb, ${SET.themeAccent} 35%, #171b22)`);
  } else {
    rootStyle.removeProperty('--accent');
    rootStyle.removeProperty('--accent-dim');
  }
}

function applyBackgroundMedia() {
  const host = $('bg-media');
  // Another instance brings its own background (its own file, served by its own
  // bridge) - showing this machine's picture behind another machine's chat was
  // the "background carries over" report. How it is shown (volume, crop applied)
  // stays this machine's preference.
  const look = instanceLook();
  const src = instanceMediaUrl(look.themeBg) || '';
  if (!host) return;
  const frame = window.innerWidth / Math.max(1, window.innerHeight);
  const current = host.querySelector('img, video');
  // Same source: keep the element. Rebuilding it restarted a background video
  // from the beginning every time any unrelated setting was saved.
  if (current && current.getAttribute('src') === src) {
    applyCrop(current, look.bgCrop, frame);
    applyBgAudio(current);
    return;
  }
  // If the element does have to be rebuilt, the video must not start over: keep
  // the playhead, the mute state and whether it was playing (a resize, a settings
  // save or a theme change used to send it back to the beginning, audio and all).
  const before = current && current.tagName === 'VIDEO'
    ? { at: current.currentTime, playing: !current.paused, muted: current.muted }
    : null;
  host.innerHTML = '';
  if (!src) { host.classList.add('hidden'); return; }
  const node = attachCrop(mediaNode(src, 'bg-node'), look.bgCrop, frame);
  if (before && node.tagName === 'VIDEO') {
    try { node.currentTime = before.at; } catch { /* not seekable yet */ }
    node.muted = before.muted;
    if (before.playing) node.addEventListener('loadeddata', () => node.play().catch(() => {}), { once: true });
  }
  node.onerror = () => toast(isVideoSrc(src) ? 'Background video failed to load' : 'Background image failed to load', 'error');
  host.appendChild(node);
  host.classList.remove('hidden');
}

/* Volume and mute live on the element, so changing them must not rebuild the
 * video (which would restart it from the beginning). */
function applyBgAudio(node) {
  if (!node || node.tagName !== 'VIDEO') return;
  node.volume = Math.max(0, Math.min(1, (SET.bgVolume == null ? 50 : Number(SET.bgVolume)) / 100));
  // `wantedPlay` is what the background *should* be doing, so the tab going
  // hidden can pause it and coming back can resume it without having to guess.
  node.dataset.wantedPlay = SET.bgAudio ? '1' : '0';
  // A background clip nobody is looking at is a decoder and a buffer for
  // nothing, so it is held while the tab is in the background and let go when
  // the tab comes back.
  if (document.visibilityState !== 'visible') { try { node.pause(); } catch { /* ignore */ } return; }
  if (!SET.bgAudio) { node.muted = true; return; }
  if (!node.muted && !node.paused) return;
  node.muted = false;
  node.play().catch(() => { node.muted = true; armBgAudioUnlock(node); });
}

/* Audible playback needs a user gesture: wait for the first click or key, then
 * unmute - the setting asked for sound, so it should actually be heard. */
function armBgAudioUnlock(node) {
  const unlock = () => {
    document.removeEventListener('pointerdown', unlock, true);
    document.removeEventListener('keydown', unlock, true);
    if (!SET.bgAudio) return;
    node.muted = false;
    node.play().catch(() => { /* still blocked; leave it muted */ });
  };
  document.addEventListener('pointerdown', unlock, true);
  document.addEventListener('keydown', unlock, true);
}

/* The frame aspect is the window's, so a resize changes how much of a cropped
 * background fits. Re-apply instead of rebuilding - rebuilding would restart a
 * background video. */
window.addEventListener('resize', () => {
  const n = document.querySelector('#bg-media img, #bg-media video');
  if (n) applyCrop(n, SET.bgCrop, window.innerWidth / Math.max(1, window.innerHeight));
});
