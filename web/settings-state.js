/*
 * UI settings state: the defaults, the live SET object, and the two paths that
 * persist it. Split out of app.js (issue #263). Loaded before app.js; the names
 * stay global, so nothing else changed.
 */
'use strict';

const DEFAULT_SETTINGS = {
  agentName: 'pi',        // display name next to the agent's messages
  avatar: null,           // dataURL shown next to the agent's name
  ttsVoiceURI: null,      // preferred browser speechSynthesis voice
  ttsRate: 1.05,
  voiceAutoSend: false,   // send the composer automatically after voice input
  showThinking: true,     // show/hide thinking blocks
  showToolCalls: true,    // show/hide tool call cards entirely
  // blockImages lives in pi now (settings.json images.blockImages, issue #214)
  partyConfetti: true,    // celebrate a reply that contains a party emoji (issue #201)
  autoExpandThinking: false, // render thinking blocks open by default
  autoExpandTools: false, // render tool call output open by default
  sttEndpoint: '',        // whisper-compatible transcription endpoint
  sttBackend: 'browser',  // 'browser' (built in, default) | 'whisper' (local server, downloaded on demand)
  sttModel: 'ggml-base.en.bin', // whisper.cpp model id
  instances: [],          // other pi agents to switch between: [{id, name, url}]
  favouriteModels: [],    // "provider||id" keys pinned to the top of the model picker
  defaultModel: '',       // "provider||id" a new chat starts on ('' = keep the last used) - issue #176
  ttsBackend: 'browser',  // 'browser' | 'endpoint' (local server) | 'fish' | 'openai' (cloud, via the bridge)
  // The cloud key is stored by the bridge and set through /api/tts-key; it is
  // deliberately not part of SET (which is cached and posted by the page).
  ttsCloudModel: '',      // fish: s1 ; openai-compatible: tts-1, gpt-4o-mini-tts, …
  ttsCloudVoice: '',      // fish: reference id ; openai-compatible: alloy, nova, …
  ttsCloudUrl: '',        // blank = the service's own endpoint
  ttsEndpoint: '',        // OpenAI-compatible /v1/audio/speech server (Piper etc.)
  ttsModel: 'piper',
  ttsVoiceName: '',
  themeAccent: null,      // custom accent color
  themeBg: null,          // background image (URL or dataURL) or video URL
  onboarded: false,       // first-launch setup completed
  shortsProvider: 'instagram', // 'instagram' | 'tiktok' | 'youtube' | 'none'
  shortsAutoOpen: false,  // open the feed while the agent runs, close it when the run finishes
  shortsMode: 'panel',    // 'panel' (in-app split) | 'window' (side window, full feed) | 'tab' — legacy 'split'='panel', 'popup'='window'
  reelsWidth: null,       // px — the shorts panel width, remembered across launches
  reelsOpen: false,       // was the shorts panel open? restored on load
  forkCollapsed: {},      // parent session path -> true while its branches are folded away
  autoContinueAfterCompaction: true, // nudge the agent to keep working after a compaction
  fontFamily: '',         // '' | 'mono' | 'serif' | 'rounded' | a system font family
  chatFontSize: 14,       // px — chat + composer text size
  chatOpacity: 100,       // 0-100 — chat chrome (composer/topbar/sidebar) opacity
  textOutline: true,      // outline chat text so it stays readable over a background
  textOutlineColor: '#000000', // outline colour
  avatarSize: 34,         // px — agent profile image in the chat
  avatarCrop: null,       // {x, y, z} — manual crop of the profile image
  bgCrop: null,           // {x, y, z} — manual crop of the background
  typeAnywhere: false,    // start typing in the composer without clicking it
  // When the agent finishes a turn (all off until switched on in Settings)
  doneSound: false,       // short two-note chime
  doneSoundUrl: '',       // your own sound instead of the chime: an /api/bg-file path, a URL, or a data URL
  doneSoundVolume: 100,   // 0-100
  doneNotify: false,      // desktop / Windows notification
  doneOnlyUnfocused: true,// ...and only while this window is not the active one
  // Fun
  gamerMode: false,       // rainbow accent (settings > fun)
  gamerSpeed: 16,         // seconds for one full colour cycle
  petEnabled: false,      // the little DeepSeek whale in the corner
  petSize: 96,            // px; the pet's height and width
  petSlug: 'builtin',     // 'builtin' or a downloaded Petdex pet slug
  cursorImage: '',        // custom pointer picture (data URL, /api/bg-file path, or an http(s) URL)
  cursorSize: 32,         // px - the picture is drawn at this size
  cursorHotX: 0,          // px - the pixel of the picture that is the real pointer tip
  cursorHotY: 0,
  // How many of the newest messages keep an animated avatar. -2 = every one of
  // them, -1 (or 0, which is what the old slider wrote for "none") = none,
  // 1-8 = a cap. Each animated message is a live video decoder, which is why the
  // cap exists and why the whole group pauses while the tab is in the
  // background.
  avatarAnimate: 8,       // the slider's top; -2 ("all") is one decoder per message
  sessionFolders: [],     // the first instance's set; kept as the source for the one-time migration
  sessionFoldersByInstance: null,  // { instanceOrigin: [{ id, name, paths }] } — folders are per instance
  bgOpacity: 100,         // 0-100 — background image / video transparency
  bgAudio: false,         // play a background video's audio
  bgVolume: 50,           // 0-100
};
let SET = { ...DEFAULT_SETTINGS };
try {
  const cached = JSON.parse(localStorage.getItem('piwebui-settings') || '{}');
  Object.assign(SET, cached);
  /* Older builds cached the cloud TTS key here. Delete it from the stored copy
   * too, not only from memory: an upgraded profile would otherwise keep the key
   * in localStorage until the next settings save. */
  if (cached && Object.prototype.hasOwnProperty.call(cached, 'ttsApiKey')) {
    delete cached.ttsApiKey;
    try { localStorage.setItem('piwebui-settings', JSON.stringify(cached)); } catch { /* quota/private */ }
  }
} catch { /* defaults */ }
delete SET.ttsApiKey;
let settingsLoaded = false;

function saveSettings(force) {
  delete SET.ttsApiKey;   // bridge-owned; never cached or posted by the page
  applySettings();
  try { localStorage.setItem('piwebui-settings', JSON.stringify(SET)); } catch { /* cache only */ }
  // The server REPLACES its settings file with what is posted, so saving before
  // the server's own copy has been read would erase the user's settings (avatar,
  // wallpaper, folders, ...) and replace them with this browser's defaults. That
  // happened whenever the first settings fetch was slow or failed and the
  // first-run dialog was dismissed. `force` is only for callers that already
  // know they hold the server's copy.
  if (!settingsLoaded && !force) return Promise.resolve();
  // authoritative copy lives in webui-settings.json next to the project
  // (the promise is returned so a caller that then depends on the server's
  // copy - adding an instance and switching to it, say - can wait for it)
  return fetch(api(`/api/ui-settings?from=${encodeURIComponent(SETTINGS_CLIENT_ID)}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SET),
  }).catch(() => {});
}

/* Saved settings changed in another tab. Reload the server's copy so this
 * page's next save does not post a stale SET over the other tab's change - the
 * last-writer-wins bug. A save in flight is shared, not stacked. */
let settingsReload = null;
function reloadSettingsFromServer() {
  if (settingsReload) return settingsReload;
  settingsReload = loadServerSettings().finally(() => { settingsReload = null; });
  return settingsReload;
}

async function loadServerSettings() {
  try {
    const data = await fetch(api('/api/ui-settings')).then((r) => r.json());
    if (data && Object.keys(data).length) {
      Object.assign(SET, data);
      migrateFolders();
      applySettings();
    }
    settingsLoaded = true;
  } catch { /* offline bridge: keep cache */ }
}

/* Identifies this page in a settings save, so the broadcast that tells other
 * tabs to reload is ignored by the tab that caused it. */
const SETTINGS_CLIENT_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);

/* Per-session reading position and run clock, keyed per instance. Split out of
 * app.js with the settings state (issue #263). */
function sessionUiKey() {
  const p = S.viewSession || (S.state && S.state.sessionFile) || 'none';
  // ...and per instance: the same path on two machines is two different sessions.
  return `piwebui-session-ui:${instanceKey()}:${String(p).slice(-120)}`;
}
function saveSessionUi(patch) {
  try {
    const raw = localStorage.getItem(sessionUiKey());
    const cur = raw ? JSON.parse(raw) : {};
    localStorage.setItem(sessionUiKey(), JSON.stringify({ ...cur, ...patch, at: Date.now() }));
  } catch { /* private mode / quota */ }
}
function loadSessionUi() {
  try {
    const raw = localStorage.getItem(sessionUiKey());
    if (!raw) return null;
    const d = JSON.parse(raw);
    // old enough to be noise rather than state
    if (!d || !d.at || Date.now() - d.at > 12 * 3600 * 1000) return null;
    return d;
  } catch { return null; }
}
