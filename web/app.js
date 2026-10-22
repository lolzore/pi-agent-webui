/* Pi Agent WebUI — talks to the bridge over WebSocket, which relays to
 * `pi --mode rpc` (JSONL over the agent's stdin/stdout). */
'use strict';

/* ───────────────────────── helpers ───────────────────────── */
/* $, el, escapeHtml, fmtSize, timeStr and cssEscape live in util.js, loaded
 * before this file - the first phase of the #54 split. */

/* Compact markdown renderer: fenced code, headings, lists, quotes,
 * bold/italic/inline-code/links. Everything is HTML-escaped first. */
/* ── speech to text ───────────────────────────────────────────────────────
 * The browser's own recognition is the default: nothing to download and it is
 * good enough for dictating a prompt. The local whisper.cpp server is opt-in -
 * it pulls ~200 MB of binaries plus the chosen model, so it never starts on a
 * plain bridge launch. With the Whisper backend selected, clicking the mic
 * starts it automatically with the model picked in settings (first use
 * downloads it); if it cannot start, browser voice takes over. */
let sttModelsLoaded = false;

async function loadSttModels() {
  const sel = $('set-stt-model');
  if (!sel) return;
  try {
    const d = await fetch(api('/api/whisper-status')).then((r) => r.json());
    sttModelsLoaded = true;
    sel.innerHTML = '';
    for (const m of d.models || []) {
      const o = el('option', null, `${m.label} - ${m.size}`);
      o.value = m.id;
      o.dataset.note = m.note || '';
      sel.appendChild(o);
    }
    syncSelect(sel, SET.sttModel || d.model);
    renderSttModelNote();
    renderSttStatus(d);
  } catch { /* offline bridge */ }
}

function renderSttModelNote() {
  const sel = $('set-stt-model');
  const note = $('stt-model-note');
  if (!sel || !note) return;
  const opt = sel.selectedOptions && sel.selectedOptions[0];
  note.textContent = opt ? (opt.dataset.note || '') : '';
}

function renderSttStatus(st) {
  const box = $('stt-status');
  if (!box || !st) return;
  box.classList.remove('hidden');
  if (st.state === 'downloading') {
    const pct = st.total ? ` ${Math.floor((st.got / st.total) * 100)}%` : '';
    box.textContent = `Downloading ${st.detail || ''}${pct}`.trim();
  } else if (st.state === 'starting') {
    box.textContent = 'Starting the whisper server…';
  } else if (st.state === 'ready') {
    box.textContent = `Ready - ${st.detail || st.model}`;
  } else if (st.state === 'failed') {
    box.textContent = `Could not start it: ${st.detail || 'unknown error'}`;
  } else {
    box.textContent = 'Not running. "download & start" fetches whisper.cpp (~200 MB) and the model once.';
  }
}

async function refreshSttStatus() {
  try {
    const d = await fetch(api('/api/whisper-status')).then((r) => r.json());
    renderSttStatus(d);
    if (d.state === 'downloading') setTimeout(refreshSttStatus, 1000);
  } catch { /* ignore */ }
}

/* Make sure the local whisper server is serving the selected model: reuse a
 * running one, switch it to the selected model, or start it - downloading the
 * binaries and model on first use. Returns the endpoint to use, or null when
 * the local server could not be started (browser voice stays available). */
async function ensureWhisper(quiet) {
  let st = null;
  try { st = await fetch(api('/api/whisper-status')).then((r) => r.json()); } catch { /* bridge offline: fall through */ }
  if (st && st.state === 'ready' && (!SET.sttModel || !st.model || st.model === SET.sttModel)) {
    if (st.url && SET.sttEndpoint !== st.url) { SET.sttEndpoint = st.url; saveSettings(); }
    return st.url || SET.sttEndpoint || null;
  }
  if (!quiet) {
    if (st && st.state === 'ready') toast('Switching the whisper server to the selected model…');
    else if (st && (st.state === 'downloading' || st.state === 'starting')) toast(`Whisper is already ${st.state === 'downloading' ? 'downloading' : 'starting'}…`);
    else toast('Starting the local whisper server - first run downloads it, this takes a while…');
  }
  const d = await fetch(api('/api/whisper-start'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: SET.sttModel || null }),
  }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
  if (d && d.ok) {
    if (d.url) { SET.sttEndpoint = d.url; saveSettings(); }
    return d.url || null;
  }
  toast(`Whisper server failed: ${(d && (d.error || d.detail)) || 'unknown error'}`, 'error');
  return null;
}

function wireVoiceSettings() {
  const backend = $('set-stt-backend');
  if (!backend) return;
  backend.onchange = () => { SET.sttBackend = backend.value; saveSettings(); syncVoiceSettingsUi(); };
  if ($('set-stt-model')) {
    $('set-stt-model').onchange = (e) => {
      SET.sttModel = e.target.value;
      renderSttModelNote();
      saveSettings();
    };
  }
  const startBtn = $('btn-stt-start');
  if (startBtn) {
    startBtn.onclick = async () => {
      startBtn.disabled = true;
      await ensureWhisper(false);
      startBtn.disabled = false;
      refreshSttStatus();
    };
  }
  syncVoiceSettingsUi();
}

/* Show only what the chosen backend needs: the browser needs nothing, whisper
 * needs a model, an endpoint and a start button. */
/* Which TTS fields belong to the chosen backend. The local-server fields are for
 * `endpoint`; the cloud ones for `fish` / `openai` (they go through the bridge,
 * which keeps the key). */
function syncTtsSettingsUi() {
  const backend = $('set-tts-backend');
  if (!backend) return;
  const mode = backend.value;
  const cloud = mode === 'fish' || mode === 'openai';
  const show = (id, on) => {
    const el = $(id);
    if (!el) return;
    el.classList.toggle('hidden', !on);
    if (id.startsWith('tts-') && id.endsWith('-label')) return;
    const wrap = el.parentElement;
    if (wrap && wrap.classList.contains('rate-row') && (id === 'set-tts-model' || id === 'set-tts-voice-name')) {
      wrap.classList.toggle('hidden', !on);
    }
  };
  show('tts-endpoint-label', mode === 'endpoint');
  show('set-tts-endpoint', mode === 'endpoint');
  show('tts-model-label', mode === 'endpoint');
  show('set-tts-model', mode === 'endpoint');
  show('set-tts-voice-name', mode === 'endpoint');
  show('tts-cloud-key-label', cloud);
  show('set-tts-apikey', cloud);
  show('tts-cloud-model-label', cloud);
  show('set-tts-cloud-model', cloud);
  show('tts-cloud-voice-label', cloud);
  show('set-tts-cloud-voice', cloud);
  show('tts-cloud-url-label', cloud);
  show('set-tts-cloud-url', cloud);
  const note = $('tts-cloud-note');
  if (note) {
    note.classList.toggle('hidden', !cloud);
    note.textContent = mode === 'fish'
      ? 'Fish Audio: paste your API key and the reference id of the voice to use (or leave it blank for the default). The bridge makes the call, so the key never travels through the page.'
      : mode === 'openai'
        ? 'Any OpenAI-compatible service: /v1/audio/speech with a model and a voice. Set the URL for anything other than OpenAI itself (Groq, DeepInfra, a self-hosted proxy).'
        : '';
  }
}

function syncVoiceSettingsUi() {
  const backend = $('set-stt-backend');
  if (!backend) return;
  backend.value = SET.sttBackend === 'whisper' ? 'whisper' : 'browser';
  const whisper = backend.value === 'whisper';
  const modelSel = $('set-stt-model');
  const modelRow = modelSel && modelSel.closest('.rate-row');
  const startBtn = $('btn-stt-start');
  const endpoint = $('set-stt-endpoint');
  const note = $('stt-model-note');
  const status = $('stt-status');
  if (modelRow) modelRow.classList.toggle('hidden', !whisper);
  if (startBtn) startBtn.classList.toggle('hidden', !whisper);
  // Hide the endpoint field itself, never its parent: it sits directly in the
  // settings grid, so hiding the parent hid the whole Voice tab - pick the
  // browser backend, save, and the tab was empty.
  if (endpoint) {
    endpoint.classList.toggle('hidden', !whisper);
    const wrap = endpoint.parentElement;
    if (wrap && wrap.classList.contains('rate-row')) wrap.classList.toggle('hidden', !whisper);
  }
  if (note) note.classList.toggle('hidden', !whisper);
  if (status) status.classList.toggle('hidden', !whisper);
  document.querySelectorAll('#tab-voice .settings-grid > label').forEach((l) => {
    const t = (l.textContent || '').trim();
    if (t === 'Whisper model' || t === 'Whisper endpoint') l.classList.toggle('hidden', !whisper);
  });
  // Fetch the list even when browser STT is selected: it is one request, and
  // otherwise the whisper choices (including the multilingual model) only
  // existed after you had already switched to whisper and back.
  if (!sttModelsLoaded) loadSttModels();
  if (whisper) { loadSttModels(); refreshSttStatus(); }
}

/* Live elapsed-time timer for a running tool card (bash etc.).
 *
 * Whole seconds: "total 15.6s" told nobody anything the "15" did not, and the
 * tenths made the number change width twice as often as the value changed. */
function fmtElapsed(ms) {
  const s = ms / 1000;
  if (s < 60) return Math.round(s) + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.round((s % 3600) / 60) + 'm';
}
/* Restart the counter from now - used when the timeout becomes known, so the
 * countdown starts with the command instead of with the card appearing. */
function restartCardTimer(card) {
  if (card._timer) { clearInterval(card._timer); card._timer = null; }
  card._running = false;
  startCardTimer(card);
}

function startCardTimer(card) {
  if (card._timer) return;
  card._running = true;
  card._start = Date.now();
  const tick = () => {
    card.timerEl.classList.remove('hidden');
    // Always counts up: the countdown a bash timeout used to produce looked
    // like a timer that was running backwards, and "3:00 left" said nothing
    // about how long the call had already been going.
    card.timerEl.textContent = fmtElapsed(Date.now() - card._start);
    if (card._timeoutMs) {
      card.timerEl.title = `timeout ${Math.round(card._timeoutMs / 1000)}s`;
      card.timerEl.classList.toggle('over-timeout', Date.now() - card._start > card._timeoutMs);
    }
  };
  tick();
  card._timer = setInterval(tick, 1000);
}
function stopCardTimer(card, stateText) {
  if (card._timer) {
    clearInterval(card._timer);
    card._timer = null;
  }
  card._running = false;
  // Always update the state text, even when no timer was running (the card
  // may have been created without one) — otherwise it stays stuck on
  // "running…" while the class already shows done/error. The label lives in
  // its own span so the "running…" text can bob while the elapsed time sits
  // still next to it.
  const label = card.stateEl.querySelector('.tool-state-label');
  const suffix = card._start ? ` · ${fmtElapsed(Date.now() - card._start)}` : '';
  if (card._start) card.timerEl.textContent = fmtElapsed(Date.now() - card._start);
  if (label) {
    label.textContent = stateText;
    card.stateEl.replaceChildren(...(suffix ? [label, document.createTextNode(suffix)] : [label]));
  } else {
    card.stateEl.textContent = stateText + suffix;
  }
  card.stateEl.classList.remove('running');
}

/* "↑ 8.8k read @ 312 t/s · ↓ 89 write @ 18.6 t/s · $0.0012"
 * writeSec = generation time, readSec = prompt-processing (prefill) time.
 * Read and write each get their own per-second metric. */
function usageStats(usage, writeSec, readSec) {
  if (!usage) return '';
  const read = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
  const write = usage.output || 0;
  const parts = [];
  if (read) {
    parts.push(`↑ ${formatTok(read)} read` +
      (readSec && readSec > 0.05 ? ` @ ${(read / readSec).toFixed(0)} t/s` : ''));
  }
  if (write) {
    parts.push(`↓ ${formatTok(write)} write` +
      (writeSec && writeSec > 0.05 ? ` @ ${(write / writeSec).toFixed(1)} t/s` : ''));
  }
  const cost = usage.cost && usage.cost.total;
  if (cost) parts.push(`$${Number(cost) < 0.01 ? Number(cost).toFixed(4) : Number(cost).toFixed(3)}`);
  return parts.join(' · ');
}

/* Same line, but from the character estimate: "↓ ~523 write @ 18.6 t/s". */
function estStatsText(est, sec) {
  if (!est) return '';
  return `↓ ~${formatTok(est) || 0} write` + (sec && sec > 0.2 ? ` @ ${(est / sec).toFixed(1)} t/s` : '');
}

/* Type anywhere: with the setting on, any printable keystroke while the window
 * is focused lands in the composer without clicking it first. Focusing on
 * keydown (rather than blocking the key) lets the browser deliver that same
 * keystroke to the newly focused box. */
function wireTypeAnywhere() {
  window.addEventListener('keydown', (e) => {
    if (SET.typeAnywhere !== true) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length !== 1 && e.key !== 'Backspace' && e.key !== 'Enter') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'Enter') { e.preventDefault(); input.focus(); return; }
    input.focus();
  });
}

const asArray = (data, key) =>
  Array.isArray(data) ? data : (data && Array.isArray(data[key]) ? data[key] : []);

/* ───────────────────────── local settings ───────────────────────── */

const DEFAULT_SETTINGS = {
  agentName: 'pi',        // display name next to the agent's messages
  avatar: null,           // dataURL shown next to the agent's name
  ttsVoiceURI: null,      // preferred browser speechSynthesis voice
  ttsRate: 1.05,
  voiceAutoSend: false,   // send the composer automatically after voice input
  showThinking: true,     // show/hide thinking blocks
  showToolCalls: true,    // show/hide tool call cards entirely
  autoExpandThinking: false, // render thinking blocks open by default
  autoExpandTools: false, // render tool call output open by default
  sttEndpoint: '',        // whisper-compatible transcription endpoint
  sttBackend: 'browser',  // 'browser' (built in, default) | 'whisper' (local server, downloaded on demand)
  sttModel: 'ggml-base.en.bin', // whisper.cpp model id
  instances: [],          // other pi agents to switch between: [{id, name, url}]
  favouriteModels: [],    // "provider||id" keys pinned to the top of the model picker
  defaultModel: '',       // "provider||id" a new chat starts on ('' = keep the last used) - issue #176
  ttsBackend: 'browser',  // 'browser' | 'endpoint' (local server) | 'fish' | 'openai' (cloud, via the bridge)
  ttsApiKey: '',          // cloud voices: kept in the bridge's settings and sent by the bridge
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
  // Appearance
  gamerMode: false,       // rainbow accent (settings > appearance)
  gamerSpeed: 16,         // seconds for one full colour cycle
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
try { Object.assign(SET, JSON.parse(localStorage.getItem('piwebui-settings') || '{}')); } catch { /* defaults */ }
let settingsLoaded = false;

function saveSettings(force) {
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
  return fetch(api('/api/ui-settings'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SET),
  }).catch(() => {});
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

/* How tall the composer dock is, so the jump-to-top button can float just above
 * it. Declared up here because applySettings() touches it and applySettings()
 * runs on the very first settings load, which is before the rest of this file
 * has been evaluated. */
let jumpTopDockH = 0;


/* ───────────────────────── state ───────────────────────── */

const S = {
  ws: null,
  reqId: 0,
  pending: new Map(),      // req id -> resolve fn
  commands: [],            // from get_commands (extension / prompt / skill)
  builtinCommands: [],     // from /api/builtin-commands (pi's built-in slash commands)
  forkable: [],            // from get_fork_messages: [{entryId, text}]
  forkEntries: [],         // from get_entries - same idea, but everything in the file
  state: {},               // last get_state payload
  isStreaming: false,
  compacting: false,        // true while a compaction is in flight
  compactionQueue: [],      // prompts queued while compacting (sent after it finishes)
  compactionHappened: false,   // a compaction completed during this run → re-render history on settle
  compactionNeedsContinue: false, // compaction finished without auto-retry → maybe auto-continue
  lastAutoContinueAt: 0,       // cooldown guard for auto-continue nudges
  turnEnded: true,             // the last turn reached agent_end (issue #63)
  outputSeq: 0,                // assistant output counter; a nudge is only for a compaction that cut a turn short
  compactionSeq: 0,            // outputSeq when the last auto-compaction finished
  userStopped: false,          // the user pressed stop; never auto-continue after that
  queue: { steering: [], followUp: [] },
  editMode: null,          // {entryId, originalText}
  attachments: [],         // [{data, mimeType, name}]
  models: [],
  levels: [],
  instanceStatus: {},       // instance url -> {ok, busy, name} for the switcher
  instanceCards: {},        // instance url -> {name, avatar} from /api/instance-card
  remote: null,             // origin of the instance this page is looking at, or null
  remoteName: null,         // its display name
  msgTiming: new Map(),    // message key -> {elapsedSec, prefillSec, est} for the t/s figure
  autoTts: false,
  speaking: false,
  stickToBottom: true,
  userScrolling: false,    // true during an active wheel/touch gesture (never pin then)
  live: null,              // in-flight assistant render {root, text, thinking, tools}
  toolCards: new Map(),    // toolCallId -> {card, body, stateEl}
  viewSession: null,       // session path being viewed (null = the agent's own session)
  viewSubagent: null,      // subagent run whose own session is open (null = none)
  subagentViewCount: 0,    // messages rendered in that child session
  runStartTs: null,        // when the task you sent started (the total clock)
  runMs: null,             // how long the last task took
  lastRun: null,           // { ms, ts } of that task
  collapsedForks: loadForkCollapse(),  // parent session path -> true when folded away
  agentBusy: null,         // last /api/sessions "busy" (null = not known yet)
  liveDetached: null,      // { path, frag } — running session's live DOM, parked while viewing another
  favNode: null,           // the off-screen node the tab icon is drawn from, until it is released
  favSource: '',           // the picture that icon was painted from
  jumpTopBusy: false,      // the jump-to-top button is waiting for a render to finish
  historyRender: 0,        // bumped by every transcript rebuild; the jump-to-top button waits for its own
  historyGen: 0,           // which transcript load is current - a superseded one stops at its next yield
  historyAbort: null,      // and the request of the load before it, so it stops pulling bytes
  turnFinalised: false,    // this turn's message is in the DOM, so turn_end need not re-read the session
  renderInto: null,        // while an older batch is being built away from the chat
  sessionsList: [],        // last /api/sessions payload (path -> name lookup for the view banner)
  sessionsSig: null,       // signature of the list above, so an unchanged poll does not rebuild the sidebar
  compactionLive: null,    // live "compacting…" block {root, t}
  lastCompaction: null,    // last compaction_end result (for the marker's "after" count)
  // Compactions we watched happen in this page session. Each is anchored to the
  // message index it sat at, so it stays put instead of being re-appended to the
  // bottom of the transcript on every turn.
  compactionMarks: [],     // [{ ...compactionResult, at, session }]  (at = ms, session = the session it happened in)
  ctxStats: null,          // last authoritative contextUsage from get_session_stats
  autoContinueStreak: 0,   // compactions in a row that dragged the task on by themselves
  ctxWindow: null,         // the model's context window, remembered across the null a compaction sets
  ctxDisplayTokens: null,  // high-water mark: the largest token count the ring has shown
  stateModelKey: '',        // provider||id of the model the thinking levels were read for
  ctxBaseTokens: null,     // authoritative count when the current turn started
  tokPerChar: null,        // measured output-tokens-per-character for this session
  bashCards: new Map(),    // bash req id -> {body}
  initialized: false,
  totals: { read: 0, write: 0 },  // session token totals
};

/* The build this page was served as (issue #89). The bridge writes it into the
 * meta tag and into every asset URL; a heartbeat that sees a different one
 * offers a reload instead of letting an old page and a new server mix. Served
 * straight from disk (no bridge) the placeholder stays and this is null. */
S.pageBuild = (() => {
  const m = document.querySelector('meta[name="build"]');
  return m && m.content && m.content !== '__BUILD__' ? m.content : null;
})();

const chat = $('chat');

/* ───────────────────────── websocket / rpc ───────────────────────── */

let reconnectTimer = null;  // auto-reconnect after a dropped connection
let reconnectDelay = 1000;  // backoff per failed attempt, capped at 15s

function connect() {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) return; // already connected
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // Another instance's socket is reached through the proxy on this origin, so a
  // host that is down cannot take the page with it.
  const wsPath = S.remote ? `/proxy/${encodeURIComponent(S.remote)}/ws` : '/ws';
  const ws = new WebSocket(`${proto}://${location.host}${wsPath}`);
  S.ws = ws;

  ws.onopen = () => {
    reconnectDelay = 1000; // a healthy connection resets the backoff
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    setConn('on');
    hideBanner();
    initSession(true);
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.bridge === 'rpc') handleRpcMessage(msg.payload);
    else if (msg.bridge === 'agent_exit') onAgentExit(msg);
    else if (msg.bridge === 'agent_started') onAgentStarted();
    else if (msg.bridge === 'session_resumed') onSessionResumed(msg.path);
    else if (msg.bridge === 'session_resume_failed') toast('Could not reopen your last session - starting in a new one', 'warning');
    else if (msg.bridge === 'agent_stderr' && msg.text.trim()) console.warn('[pi stderr]', msg.text);
  };
  ws.onclose = () => {
    // Everything in here is cleanup, and any one step throwing used to skip the
    // reconnect below - leaving the page sitting there disconnected, with the
    // whole UI quietly broken until a manual reload.
    try {
      setConn('off');
      S.isStreaming = false;
      // Connection lost mid-turn: mark any live tool cards as failed so they
      // don't sit on "running…" forever.
      markStuckToolCards('connection lost');
      removeCompactionLive();
      // In-flight RPCs will never get a response — fail them now instead of
      // making callers wait out their full timeout.
      for (const [id, p] of [...S.pending]) {
        S.pending.delete(id);
        p.reject(new Error('connection lost'));
      }
      updateStreamUi();
      showBanner('error', 'Connection to the bridge lost — reconnecting…', 'Retry now', () => connect());
    } catch (e) {
      console.warn('reconnect cleanup failed:', e && e.message);
    }
    scheduleReconnect();
  };
  ws.onerror = () => { /* onclose follows */ };
}

/* Reconnect automatically with backoff — a manual page reload used to be the
 * only way to recover from a dropped connection. onopen re-runs initSession,
 * which re-syncs the whole UI from the bridge, so the desync heals itself. */
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (S.ws && S.ws.readyState === WebSocket.OPEN) return;
    connect();
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  }, reconnectDelay);
}

/* Liveness heartbeat.
 *
 * A half-open WebSocket (sleep/wake, a WebView2 network hiccup) may never fire
 * onclose on its own, leaving the UI frozen on a dead connection - so something
 * has to notice. This used to notice with `get_state`, which goes THROUGH the
 * agent, and that was wrong in a way that caused the very outage it was meant to
 * detect.
 *
 * pi answers one request at a time. Switching session costs it over a second on a
 * long one (the comment on switchToSession has the measurements), so clicking
 * through a list quickly queued several switches and the next get_state waited
 * behind all of them. Past ten seconds the timeout fired, the page concluded the
 * connection was dead and closed its own socket - which rejected every in-flight
 * request with "connection lost", toast per click, and left the bridge with no
 * clients, so it shut the agent down. The page then reconnected to a restarted
 * agent. Reported as "switching fast and the server kind of dies".
 *
 * So the question is asked of the *bridge*, which answers it directly and without
 * touching the agent: an HTTP /api/health is about whether this page can still
 * reach the thing on the other end, which is the actual question. A busy agent is
 * not a dead connection, and this can no longer mistake one for the other. */
/* One heartbeat, as a named function so it can be called directly - the test for
 * this drives it rather than waiting out a 25 second interval. */
function heartbeat() {
  const ws = S.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  return fetch(api('/api/health'), { signal: ac.signal, cache: 'no-store' })
    .then((r) => {
      clearTimeout(t);
      if (!r.ok) throw new Error('health ' + r.status);
      return r.json().then(checkBuild).catch(() => {});
    })
    .catch(() => {
      clearTimeout(t);
      // The bridge did not answer at all: the connection is dead, and closing it
      // is what lets the onclose path reconnect.
      try { ws.close(); } catch { /* already closing */ }
    });
}

/* A bridge restart serves a new build. A long-lived tab keeps the old page, and
 * mixing an old page with a new server is how the settings dialog ended up laid
 * out by a stale stylesheet (issue #89). One comparison turns that into a
 * button instead of a mystery. */
function checkBuild(d) {
  const build = d && d.build;
  if (!build) return;
  if (!S.pageBuild) { S.pageBuild = build; return; }
  if (build === S.pageBuild || S.buildHintShown) return;
  S.buildHintShown = true;
  showBanner('warn', 'The WebUI was updated - reload to pick up the new build.', 'Reload', () => location.reload());
}
setInterval(heartbeat, 25000);

function send(obj) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(obj));
}

/* Resolve when the (re)started agent reports agent_started. */
let agentReadyWaiters = [];
function onAgentStarted() {
  // A fresh agent means the crash banner is stale - it used to sit there until
  // the page was reloaded, even after a successful restart.
  hideBanner();
  refreshCommands().catch(() => {});
  refreshBuiltinCommands().catch(() => {});
  refreshModels().catch(() => {});
  refreshLevels().catch(() => {});
  refreshStats().catch(() => {});
  const w = agentReadyWaiters;
  agentReadyWaiters = [];
  w.forEach((r) => r());
}
function waitForAgentReady(timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const i = agentReadyWaiters.indexOf(resolve);
      if (i >= 0) agentReadyWaiters.splice(i, 1);
      reject(new Error('agent did not start in time'));
    }, timeoutMs);
    agentReadyWaiters.push(() => { clearTimeout(t); resolve(); });
  });
}

function rpc(commandObj, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const id = `req-${++S.reqId}`;
    commandObj.id = id; // exposed so callers can correlate streamed events
    /* The timeout is cleared as soon as the request settles.
     *
     * It used to be left armed no matter what happened, so every answered call
     * kept a live timer and its closure until the deadline passed - and the
     * longest deadline in the app is /compact's ten minutes, which meant a
     * finished compaction still held one. Nothing was ever wiped by it (the
     * callback checks S.pending first), but it is dead weight for up to ten
     * minutes per call, and a leak is easier to prevent than to notice. */
    const timer = setTimeout(() => {
      if (S.pending.has(id)) {
        S.pending.delete(id);
        reject(new Error(`${commandObj.type}: timed out`));
      }
    }, timeoutMs);
    const settle = (fn) => (v) => { clearTimeout(timer); fn(v); };
    S.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
    send(commandObj);
  });
}


/* Mark every live tool card that is still "running" as failed — the agent
 * exited or the connection dropped, so the command can no longer be running. */
function markStuckToolCards(label) {
  for (const card of S.toolCards.values()) {
    if (card._timer || card.stateEl.textContent.startsWith('running')) {
      stopCardTimer(card, label);
      card.stateEl.className = 'tool-state error';
    }
  }
}

/* The bridge puts a restarted agent back into the session it was in. It takes a
 * moment, and it is not safely ordered against the commands this page sends on
 * connect: pi answers a get_state that arrives after a switch_session before the
 * switch has finished loading - so the first state this page sees can be the
 * fresh, empty session the agent started in, and the page then looks like the
 * session you were writing in simply vanished. When the bridge says the resume
 * is done, read the state again. It is also the only signal that a session
 * restored after a container restart is ready. */
async function onSessionResumed(path) {
  if (!path) return;
  try {
    await rpc({ type: 'get_state' }).then((d) => applyState(d));
    // Always re-read the transcript: a page that connected while the agent was
    // still switching may already hold the right session path while showing the
    // empty transcript of the fresh session the agent started in.
    if (S.viewSession) await switchToSession(path);
    else await refreshMessages();
    refreshSessions(true).catch(() => {});
    // The resume is announced as soon as the switch *starts*: an agent in a
    // container can still be reading a long session when pi answers
    // get_messages, and the answer is then the fresh, empty context it started
    // in - so the page kept an empty transcript until something else re-rendered
    // it. Keep looking for a moment, and stop as soon as there is something.
    for (let attempt = 0; !S.viewSession && attempt < 6 && !chat.children.length; attempt++) {
      await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
      if (S.isStreaming) break;
      await refreshMessages();
    }
  } catch (e) {
    console.warn('could not pick up the resumed session:', e.message);
  }
}

function onAgentExit(msg) {
  S.isStreaming = false;
  setConn('on');
  // Any tool card still showing "running…" is stuck — the agent is gone.
  markStuckToolCards('interrupted');
  removeCompactionLive();
  updateStreamUi(); // live dot, Stop button, ctx poll, view banner
  if (msg.error) {
    showBanner('error', msg.error, 'Retry', () => send({ bridge: 'restart' }));
  } else {
    showBanner('warn', `Agent process exited${msg.code !== undefined ? ` (code ${msg.code})` : ''}.`,
      'Restart agent', () => send({ bridge: 'restart' }));
  }
}

async function initSession(resumeLast, prefetched, alreadyDrawn, gen) {
  try {
    /* `gen` is set only by switchToSession. If a newer switch has started since
     * this one, nothing below may be applied: `applyState` takes the session
     * file from get_state, and answering about the wrong session is exactly how
     * the highlight ended up on the wrong row. */
    const stale = () => gen !== undefined && switchGen !== gen;
    await rpc({ type: 'get_state' }).then((d) => { if (!stale()) applyState(d); });
    if (stale()) return;
    if (resumeLast) await resumeLastSession();
    if (stale()) return;
    /* The transcript is what the person is waiting for, so it starts first and
     * the rest goes alongside it.
     *
     * This used to be eleven awaits in a row - get_state, models, levels,
     * commands, builtin commands, the transcript, the other instance's face, the
     * fork list, the session list, the stats - so a session switch paid for every
     * one of them before a message was drawn. None of them depend on each other;
     * the transcript was simply in the middle of the queue.
     *
     * `alreadyDrawn` is a session switch that started its render before waiting
     * for pi to move into the session, so there is nothing left to start - only
     * to wait for. */
    const transcript = alreadyDrawn || refreshMessages(prefetched);
    await Promise.all([
      transcript,
      refreshModels(),
      refreshLevels(),
      refreshCommands(),
      refreshBuiltinCommands(),
      loadRemoteLook().catch(() => {}),   // another instance's face and background
      refreshSessions(true),
      refreshStats(),
    ]);
    loadDraft();
    restoreRunClock();
    S.initialized = true;
  } catch (e) {
    console.error('init failed', e);
    toast(`Init failed: ${e.message}`, 'error');
  }
}

/* A fresh pi process always starts a new empty session; on page load, reopen
 * the session the user was in instead so work continues where it left off. The
 * bridge normally resumes it already, and says so in /api/sessions: in that case
 * this does nothing.
 *
 * Only one situation justifies touching the agent's session here: the agent is
 * in a session other than the one the bridge meant to resume, i.e. the bridge
 * really did start fresh. Anything broader goes wrong in a way that is hard to
 * see. A session has no file until its first message is written, so a chat you
 * just created is absent from the sidebar list - which used to look exactly like
 * a lost session. This function then picked the newest file in the list as a
 * replacement, so sending a message and reloading right away dropped you into
 * whatever session had been written last, quite possibly days old. That is the
 * "my session disappeared" report, and it was this line, not the bridge. */
async function resumeLastSession() {
  let d;
  try {
    const res = await fetch(api('/api/sessions'));
    d = await res.json();
  } catch { return; /* bridge unreachable */ }
  const sessions = d.sessions || [];
  const remembered = d.remembered || null;
  const cur = S.state.sessionFile;
  const find = (p) => (p ? sessions.find((s) => s.path === p) || null : null);
  if (find(cur)) return;                       // on screen and on disk: nothing to do
  if (!sessions.length) return;
  if (!remembered || remembered === cur) return;   // the bridge is in the session it intended
  let target = null;
  try { target = find(localStorage.getItem(lastSessionKey())); } catch { /* private mode */ }
  if (!target) target = find(remembered);
  if (!target) return;                         // nothing to go back to; stay where the agent is
  if (target.path === cur) return;
  /* The agent has no session of its own: pi reports the sessions *directory*.
   * There is nothing here to move it into, and the alternative - asking it for
   * its messages - takes twenty seconds to answer and describes a context the
   * file already describes better. So the last session is shown read-only, which
   * is what it is: the agent is not in it. */
  if (!isSessionFile(cur)) {
    S.viewSession = target.path;
    S.viewSubagent = null;
    updateViewBanner();
    return;
  }
  try {
    await rpc({ type: 'switch_session', sessionPath: target.path });
    await rpc({ type: 'get_state' }).then((st) => applyState(st));
    toast(`Resumed last session: ${(target.name || 'unnamed').slice(0, 60)}`);
  } catch (e) {
    // The switch failed (e.g. the session's working directory is gone). The
    // session is still in the sidebar - clicking it offers to recreate the
    // folder - so this is a warning, not a silent drop.
    console.warn(`could not resume last session ${target.path}: ${e.message}`);
    toast(`Could not resume last session: ${e.message}`, 'error');
  }
}

/* ── which instance is this page looking at? ──────────────────────────────
 * Switching instances used to navigate this page to the other machine. In a
 * browser that means leaving where you were, and in the packaged app there is no
 * address bar - so a host that is switched off stranded you on a network error
 * with no way back. The local bridge proxies instead (/proxy/<origin>/...), so
 * the page never leaves this origin and the switcher always works.
 *
 * Everything that belongs to the agent follows the instance you are looking at;
 * anything about this machine's own WebUI - its appearance, its network switch -
 * stays local. */
/* Endpoints that belong to *this* machine's WebUI and must never be sent to
 * another instance: the UI settings (appearance, folders, instances, the agent
 * name you edit here), the network switch, the instance card, the font list of
 * this machine, the voice backend (whisper runs here), and the proxy itself. */
const LOCAL_APIS = ['/api/ui-settings', '/api/lan', '/api/instance-card', '/api/system-fonts',
                    '/api/whisper-status', '/api/whisper-start', '/api/whisper-log', '/api/tts',
                    '/api/proxy/', '/proxy/'];
function api(path) {
  const p = String(path);
  if (!S.remote || LOCAL_APIS.some((l) => p.startsWith(l))) return path;
  return `/proxy/${encodeURIComponent(S.remote)}${p}`;
}

/* The session this page should return to belongs to one instance, not to "the
 * app": keep a separate note per instance. */
function lastSessionKey() {
  return 'piwebui-last-session' + (S.remote ? `@${S.remote}` : '');
}

/* ───────────────────────── state / config refresh ───────────────────────── */

function applyState(d) {
  S.state = d || {};
  if (d) {
    // Remember which session this browser is in, so a reload can get back to
    // it even if the bridge has no record (see resumeLastSession).
    if (d.sessionFile) {
      try { localStorage.setItem(lastSessionKey(), d.sessionFile); } catch { /* cache only */ }
    }
    if (d.sessionName) $('session-name').value = d.sessionName;
    else if (!$('session-name').value) $('session-name').value = '';
    // otherwise the derived session name (first user message) fills in via refreshSessions
    if (d.isStreaming !== undefined) S.isStreaming = d.isStreaming;
    if (d.model && d.model.id) syncSelect($('model-select'), `${d.model.provider}||${d.model.id}`);
    if (d.thinkingLevel) syncSelect($('thinking-select'), d.thinkingLevel);
    /* The list of thinking levels belongs to the MODEL. syncing the current
     * level into the select is not enough: after a switch the picker still
     * offered the previous model's levels, so a model with no reasoning kept a
     * menu of five levels that all failed, and a model with the full ladder
     * offered only "off" until something unrelated refreshed it.
     *
     * Done here rather than at each call site because this is the one place
     * every path goes through - the picker, /model, the llama.cpp fix, the
     * agent switching by itself. And done on a *change*, because a state sync
     * happens constantly during a turn. */
    if (d.model && d.model.id) {
      const key = `${d.model.provider}||${d.model.id}`;
      if (key !== S.stateModelKey) {
        S.stateModelKey = key;
        levelsForModel();
      }
    }
    updateStreamUi();
    // Reconnect while a run is already going: the feed should be open too.
    if (d.isStreaming) autoOpenShortsIfEnabled();
  }
}

/* The thinking levels for a model that has just become current.
 *
 * pi reports the new model's levels from its own config, and it has not always
 * finished applying a `set_model` when that call returns - so the first read
 * can still be the old model's, which is exactly the stale menu this is here to
 * fix. Read again once pi has had a moment, and drop the result if the model
 * changed again in the meantime so a quick A -> B -> C does not land on A's
 * levels. */
let levelsRetryTimer = null;
function levelsForModel() {
  refreshLevels().catch(() => {});
  if (levelsRetryTimer) clearTimeout(levelsRetryTimer);
  levelsRetryTimer = setTimeout(() => {
    levelsRetryTimer = null;
    refreshLevels().catch(() => {});
  }, 700);
}

/* ── pretty selects ──────────────────────────────────────────────────────
 * The settings still used the browser's own <select>, which looks nothing like
 * the dropdown the model picker opens. Each one keeps its element (every handler
 * and every `sel.value = x` in the app goes on working) but shows a button that
 * opens the shared menu instead - and the button's label follows the element,
 * including changes made from code, via a property hook. */
function prettySelect(sel) {
  if (!sel || sel._pretty) return;
  sel._pretty = true;
  const btn = el('button', 'btn pill pretty-select');
  btn.type = 'button';
  const label = () => {
    const o = sel.selectedOptions && sel.selectedOptions[0];
    const text = (o && o.textContent) || (sel.options[0] && sel.options[0].textContent) || '(none)';
    btn.textContent = text.trim();
    btn.title = text.trim();
    btn.classList.toggle('disabled', !!sel.disabled);
    btn.disabled = !!sel.disabled;
  };
  const open = (force) => {
    const items = [...sel.options].map((o) => ({
      label: (o.textContent || '').trim(),
      hint: o.value && o.value !== o.textContent ? o.value : '',
      active: o.value === sel.value,
      onPick: () => {
        sel.value = o.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        label();
      },
    }));
    openMenu(btn, items, {
      title: (btn.getAttribute('data-title') || sel.title || 'choose').toLowerCase(),
      width: 360,
      force,
      // The default-model list can be long; make that one searchable like the
      // model picker itself. The other settings selects stay a plain list.
      search: sel.id === 'set-default-model' ? 'search models…' : undefined,
    });
  };
  /* The TTS voice list is fetched when *this* dropdown is opened, never when the
   * settings dialog opens.
   *
   * speechSynthesis.getVoices() can block for a second or more the first time it
   * is called (Firefox starts its speech service there). Filling the select when
   * the dialog opened put that stall right after showModal(), so closing the
   * dialog - or anything else - waited for the speech service. The menu opens at
   * once with a note, the list is fetched off that click, and the menu reopens
   * with the voices. */
  btn.onclick = (e) => {
    e.stopPropagation();
    if (sel.id === 'set-tts-voice' && !ttsVoicesReady()) {
      openMenu(btn, [{ label: 'loading voices…', hint: 'the speech service can take a moment' }], { title: 'voices', width: 360, force: true });
      setTimeout(() => { populateTtsVoiceSelect(); open(true); }, 0);
      return;
    }
    open();
  };
  // keep the label right when the app sets the value itself
  try {
    const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(sel, 'value', {
      configurable: true,
      get() { return proto.get.call(sel); },
      set(v) { proto.set.call(sel, v); label(); },
    });
  } catch { /* a browser without the descriptor: the label still follows the user */ }
  sel.addEventListener('change', label);
  sel.classList.add('pretty-source');
  // Inside a wrapper, so the pair of them is ONE cell of the settings grid: a
  // button inserted next to the select added a second cell and shifted every
  // label/control pair below it (which is what scrambled the settings layout).
  const wrap = el('span', 'pretty-wrap');
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  wrap.appendChild(btn);
  label();
}

/* Every plain dropdown in the settings dialog, once. */
function prettifySettingsSelects() {
  const root = $('settings-dialog');
  if (!root) return;
  for (const sel of root.querySelectorAll('select')) {
    if (sel.id === 'model-select' || sel.id === 'thinking-select') continue;
    prettySelect(sel);
  }
}

function syncSelect(sel, value) {
  if (value && [...sel.options].some((o) => o.value === value)) sel.value = value;
  if (sel && sel.id === 'model-select') updateModelBtn();
  if (sel && sel.id === 'thinking-select') updateThinkingBtn();
}

/* What is highlighted right now. selection.toString() returns an empty string in
 * some frames even when a range is set, so fall back to the range itself. */
function selectedText() {
  try {
    const sel = window.getSelection && window.getSelection();
    if (!sel || !sel.rangeCount) return '';
    const t = String(sel) || (sel.getRangeAt(0) && sel.getRangeAt(0).toString()) || '';
    return t.trim();
  } catch { return ''; }
}

/* Clipboard with feedback. writeText only works on a secure origin and can be
 * rejected, which used to leave the copy buttons doing nothing at all. */
async function copyText(text, okMsg = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast(okMsg);
    } catch { toast('Could not copy to the clipboard', 'error'); }
  }
}

/* ── shared dropdown menu ─────────────────────────────────────────────────
 * The model picker's look - search box, scrollable rows, groups, accent on the
 * current entry - reused for the thinking levels, the session and turn context
 * menus and the instance switcher, so they all behave the same way. */

/* ── provider retry state (issue #83) ────────────────────────────────────
 * pi retries a failed provider call itself and reports each attempt; this bar
 * is that state, with Cancel sending abort_retry - pi's own command. */
function renderRetryBar(msg) {
  const bar = $('retry-bar');
  if (!bar) return;
  const secs = Math.max(1, Math.round((msg.delayMs || 0) / 1000));
  bar.innerHTML = '';
  bar.classList.remove('hidden');
  bar.appendChild(el('span', null, `retrying (${msg.attempt || 1}/${msg.maxAttempts || '?'}) in ${secs}s — ${msg.errorMessage || 'provider call failed'}`));
  const cancel = el('button', 'btn small', 'cancel retry');
  cancel.title = 'Send abort_retry: stop waiting for the provider and let this turn fail now';
  cancel.onclick = async () => {
    cancel.disabled = true;
    try { await rpc({ type: 'abort_retry' }); toast('Retry cancelled'); }
    catch (e) { toast(e.message, 'error'); }
    clearRetryBar();
  };
  bar.appendChild(cancel);
}
function clearRetryBar() {
  const bar = $('retry-bar');
  if (!bar) return;
  bar.classList.add('hidden');
  bar.innerHTML = '';
}


async function refreshLevels() {
  try {
    const d = await rpc({ type: 'get_available_thinking_levels' });
    S.levels = asArray(d, 'levels');
    const sel = $('thinking-select');
    sel.innerHTML = '';
    (S.levels.length ? S.levels : ['off']).forEach((lv) => {
      // The button shows the bare level ("off", "low"); the description is for
      // the dropdown only.
      const o = el('option', null, lv);
      o.value = lv;
      sel.appendChild(o);
    });
    if (S.state.thinkingLevel) syncSelect(sel, S.state.thinkingLevel);
    updateThinkingBtn();
  } catch { /* ignore */ }
}

async function refreshCommands() {
  try {
    const d = await rpc({ type: 'get_commands' });
    S.commands = asArray(d, 'commands');
  } catch { S.commands = []; }
}

/* Built-in slash commands (like /compact, /new) aren't returned by the agent's
 * get_commands RPC — the bridge reads them from the installed pi package so the
 * menu stays current automatically as pi adds commands. */
async function refreshBuiltinCommands() {
  try {
    const d = await fetch(api('/api/builtin-commands')).then((r) => r.json());
    S.builtinCommands = Array.isArray(d.commands) ? d.commands : [];
  } catch { S.builtinCommands = []; }
}

/* The fork list, fetched at most once per session and never blocking.
 *
 * This is the single most expensive thing a session switch asked pi for: on a
 * 5441-message session `get_fork_messages` plus `get_tree` took 1.86 seconds, and
 * it sat in front of the transcript, so the switch waited nearly two seconds
 * before a single message was drawn. It is also the *least* urgent thing on the
 * page - nothing shows it until a message is right-clicked, which is seconds
 * later at the earliest.
 *
 * So it runs alongside the transcript instead of in front of it, and is shared:
 * `refreshMessages` and `stampForkIds` used to each start their own, which meant
 * two of the 1.86 seconds per switch. */
let forkInFlight = null;
let forkSessionKey = null;
/* Ask for the forkable list, at most one request at a time.
 *
 * The guard used to hold on to the *settled* promise: the first call (at
 * connect, on an empty session) answered "nothing yet", and every later call
 * for the same session got that same finished promise back - so the list stayed
 * empty for the whole session and editing a message found no fork point at all
 * ("does nothing"). Only an in-flight request is reused now; a settled one is
 * forgotten, and the next turn (or stampForkIds) asks again. */
function ensureForkable() {
  const key = `${S.state.sessionFile || ''}|${S.viewSession || ''}`;
  if (forkInFlight && forkSessionKey === key) return forkInFlight;
  forkSessionKey = key;
  const mine = refreshForkable()
    .then(() => { resetForkQueue(); })
    .catch(() => { /* the fork buttons simply stay out until it can be asked again */ });
  forkInFlight = mine;
  mine.finally(() => { if (forkInFlight === mine) forkInFlight = null; });
  return mine;
}

/* The list of messages that can be forked from - cheap, and asked for whenever
 * a turn settles so the rows can carry their ids. */
async function refreshForkable() {
  try {
    const d = await rpc({ type: 'get_fork_messages' }, 15000);
    S.forkable = asArray(d, 'messages');
  } catch { S.forkable = []; }
  S.forkEntries = (S.forkable || []).map((f) => ({ entryId: f.entryId, text: f.text }));
}

/* Fork ids must come from the *active branch*: the session file also holds the
 * abandoned branches of earlier forks, so walking it in file order shifted every
 * id after the first fork, and right-clicking a turn forked somewhere else. The
 * tree plus leafId gives exactly the conversation on screen.
 *
 * Asked for **only when someone is about to fork**, and time-boxed. On a long
 * session the tree is a big answer: fetching it on every settled turn (and every
 * reload) meant parsing megabytes on the page's main thread several times a
 * minute - which is what made the liveness heartbeat time out, close the socket
 * and re-render the whole chat, over and over. A fork is a deliberate act; the
 * cheap list is enough until then. */
function ensureForkTree() {
  if (forkTreeInFlight) return forkTreeInFlight;
  forkTreeInFlight = (async () => {
    try {
      const d = await rpc({ type: 'get_tree' }, 15000);
      const path = leafPath(d && d.tree, d && d.leafId);
      const users = path
        .filter((e) => e && e.message && e.message.role === 'user')
        .map((e) => ({ entryId: e.id, text: (e.message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ') }));
      if (users.length) S.forkEntries = users;
    } catch { /* the cheap list stands: forking still works, ids may be the file's order */ }
    resetForkQueue();
  })().finally(() => { forkTreeInFlight = null; });
  return forkTreeInFlight;
}
let forkTreeInFlight = null;

/* The entries from the root down to the current leaf - the active branch. */
function leafPath(tree, leafId) {
  if (!Array.isArray(tree)) return [];
  // Iterative on purpose: a long session's branch is one node deep per message,
  // and the recursive version blew the call stack on big sessions - which pi
  // reported as "Agent error (get_tree): Maximum call stack size exceeded" at
  // the start of every turn.
  const seen = new Set();
  const stack = [];
  for (let i = tree.length - 1; i >= 0; i--) stack.push({ node: tree[i], path: [] });
  while (stack.length) {
    const { node, path } = stack.pop();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    const next = [...path, node.entry];
    if (node.entry && node.entry.id === leafId) return next;
    const kids = node.children || [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i], path: next });
  }
  return [];
}

async function refreshStats() {
  try {
    const d = await rpc({ type: 'get_session_stats' });
    const cost = d && d.cost && d.cost.total != null ? Number(d.cost.total) : null;
    setText($('stat-cost'), cost != null
      ? `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}`
      : '');
    let cu = d && d.contextUsage;
    const rawTokens = cu && cu.tokens != null ? cu.tokens : null;
    // While a turn is in flight the live number is anchored to the last real
    // count; let that anchor advance as pi reports usage between messages.
    if (S.isStreaming && rawTokens != null) {
      S.ctxBaseTokens = Math.max(S.ctxBaseTokens || 0, rawTokens);
    }
    // The 1s poll would otherwise pull the ring back to a stale base every tick
    // (the "jumping back" sawtooth), so the displayed count only climbs while a
    // turn is in flight and the authoritative value settles it at the end.
    if (S.isStreaming && cu && cu.tokens != null && S.ctxDisplayTokens != null && cu.tokens < S.ctxDisplayTokens) {
      cu = { ...cu, tokens: S.ctxDisplayTokens, percent: cu.contextWindow ? (S.ctxDisplayTokens / cu.contextWindow) * 100 : null };
    }
    setCtxRing(cu);
  } catch { /* ignore */ }
  updateTotals();
}

/* context-usage progress ring + "[used/max]ctx" label.
 * cu = { tokens, contextWindow, percent } from get_session_stats. After a
 * compaction the agent reports tokens:null until the next LLM response, in
 * which case the ring and label show a dash instead of a stale number.
 * While the model streams, liveCtxRing() feeds an estimate on top of the last
 * authoritative number so the ring fills in real time. */
/* Write to the DOM only when the value actually changed.
 *
 * Setting textContent - even to the string it already holds - replaces the text
 * node, and a fresh node is re-shaped and re-measured from scratch. That is what
 * issue #2 turned out to be: the context label was rewritten up to twelve times
 * a second while streaming and once a second from the stats poll, and every so
 * often the re-shaped run landed 2px lower than the one before it, with the
 * identical text. Measured from the recording attached to the issue: the ring,
 * the token counters and the turn clock are static to the pixel, and the label's
 * ink flips between y=42..61 and y=44..63 - same 19px of ink, same glyphs
 * (shifting one frame up 2px makes it match the other to within 0.9 of its own
 * same-state control), just displaced. So it was never the numbers changing; it
 * was the element being rewritten with the numbers unchanged.
 *
 * Comparing first costs one string comparison and removes the churn entirely. */
function setText(el, value) {
  if (el && el.textContent !== value) el.textContent = value;
}
function setAttr(el, name, value) {
  if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/* The ring's high-water marks, dropped whenever the context is replaced.
 *
 * All three exist to stop the ring walking backwards DURING a turn - the agent's
 * own count comes back a little differently each time it is asked, so polling it
 * mid-turn used to make the ring tick down and climb again. Each of them is a
 * statement about the context as it is right now, and a compaction replaces that
 * context wholesale, so after one they are all describing something that no
 * longer exists.
 *
 * Left in place they do worse than nothing: ctxTurnPeak is only cleared on
 * agent_start, so a compaction that happens mid-turn leaves the pre-compaction
 * peak behind, and the clamp in setCtxRing reads it as a floor and pushes the
 * post-compaction estimate straight back up to it. Which is issue #48 exactly as
 * reported - "right after compaction the counter stays the same" - and it is why
 * that check first failed with 26.7K where the compaction had said 25.6K. */
function resetCtxHighWater() {
  S.ctxTurnPeak = 0;
  S.ctxDisplayTokens = null;
  S.ctxBaseTokens = null;
}

function setCtxRing(cu, store = true) {
  // The window is remembered apart from the stats object it arrives in.
  // compaction_start nulls S.ctxStats on purpose - the count is about to be
  // meaningless - but the window has not changed, and showCompactionEstimate()
  // needs it a moment later to display the post-compaction size.
  if (cu && cu.contextWindow) S.ctxWindow = cu.contextWindow;
  if (store) S.ctxStats = cu && cu.tokens != null && cu.contextWindow ? { ...cu } : null;
  // The agent's own count comes back a little differently each time it is asked
  // (it recounts the conversation as tool results land), so polling it during a
  // turn made the ring and the label tick down and then climb again - a
  // sawtooth. Within one turn the number only goes up.
  if (cu && cu.tokens != null) {
    const peak = Math.max(S.ctxTurnPeak || 0, cu.tokens);
    S.ctxTurnPeak = peak;
    if (S.isStreaming && peak > cu.tokens) cu = { ...cu, tokens: peak, percent: cu.contextWindow ? (peak / cu.contextWindow) * 100 : cu.percent };
  }
  const fg = $('ctx-ring-fg');
  const txt = $('ctx-ring-text');
  const label = $('ctx-label');
  const wrap = fg.closest('.ctx-ring');
  const C = 2 * Math.PI * parseFloat(fg.getAttribute('r'));
  const tokens = cu && cu.tokens;
  const max = cu && cu.contextWindow;
  if (tokens == null || !max) {
    // Unknown or just compacted: dash + empty ring.
    setText(txt, '–');
    setAttr(fg, 'stroke-dasharray', '0 999');
    wrap.title = 'Context unknown — waiting for the next response';
    wrap.classList.remove('warn', 'critical');
    setText(label, ctxLabel('–', '–'));
    S.ctxDisplayTokens = null;
    return;
  }
  const p = cu.percent != null
    ? Math.max(0, Math.min(100, cu.percent))
    : Math.max(0, Math.min(100, (tokens / max) * 100));
  S.ctxDisplayTokens = tokens;
  setAttr(fg, 'stroke-dasharray', `${(C * p / 100).toFixed(1)} ${C.toFixed(1)}`);
  setText(txt, p >= 10 ? String(Math.round(p)) : p.toFixed(1));
  wrap.title = `Context: ${formatTok(tokens)} / ${formatTok(max)} tokens (${p.toFixed(1)}%)`;
  wrap.classList.toggle('warn', p >= 75 && p < 90);
  wrap.classList.toggle('critical', p >= 90);
  if (label) {
    /* The number as it is: no reservation, no padding.
     *
     * This comment used to say the label "pads its own text to a fixed width",
     * which it never did, and it has been corrected rather than implemented. The
     * padding idea came from wanting the counter's box to be a constant width so
     * the token counters after it could not shuffle - but padding here is written
     * as spaces, and the element is `white-space: nowrap`, so any run of spaces
     * collapses and the padding would do nothing at all. Reserving the width in
     * CSS was tried (`min-width: 19ch`) and removed on purpose: the reserve was
     * wider than almost every real value, which left a visible hole between the
     * counter and the token counter, and it is the worse of the two looks.
     *
     * What was NOT acceptable - the counter itself jumping - is fixed above by
     * not rewriting the text node when the text has not changed. */
    const used = formatTok(tokens) || '';
    const room = formatTok(max) || '';
    setText(label, ctxLabel(used, room));
  }
}

/* Estimate the in-flight context growth (≈4 chars/token) and add it to the
 * last authoritative stats so the ring climbs while the model writes. The
 * base is the high-water mark, not the raw authoritative number: when a new
 * assistant message starts its estimate restarts at 0, and using the raw
 * base would visibly snap the ring back down. */
/* Character count of a message's content, mirroring pi's own estimator
 * (text + thinking + tool-call name and arguments). */
function messageChars(m) {
  if (!m || !Array.isArray(m.content)) return 0;
  let chars = 0;
  for (const block of m.content) {
    if (block.type === 'text' && block.text) chars += block.text.length;
    else if (block.type === 'thinking' && block.thinking) chars += block.thinking.length;
    else if (block.type === 'toolCall') chars += (block.name || '').length + JSON.stringify(block.arguments || {}).length;
  }
  return chars;
}

/* Total tokens a usage record implies - the same sum pi's
 * calculateContextTokens() does (totalTokens when the provider sends it). */
function usageContextTokens(u) {
  if (!u) return null;
  if (u.totalTokens) return u.totalTokens;
  const sum = (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
  return sum > 0 ? sum : null;
}

/* The context ring during a turn.
 *
 * Prefer real numbers: once the provider reports usage for the message in
 * flight, its prompt count is the context, so base + output is exact (pi will
 * report the same value when the message ends). Only while no usage has
 * arrived yet do we fall back to an estimate, and that estimate is calibrated
 * from the tokens-per-character the session has actually shown so far instead
 * of a fixed chars/4 guess. Both paths are clamped so the ring never walks
 * backwards mid-turn. */
function liveCtxRing(estimatedExtra) {
  if (!S.ctxStats) return;
  const b = S.ctxStats;
  const peak = S.ctxTurnPeak || 0;
  let tokens;
  const real = usageContextTokens(S.live && S.live.lastUsage);
  if (real != null) {
    tokens = Math.max(real, S.ctxBaseTokens || 0, S.ctxDisplayTokens || 0, peak);
  } else {
    const estimate = (S.ctxBaseTokens != null ? S.ctxBaseTokens : (b.tokens || 0)) + (estimatedExtra || 0);
    tokens = Math.max(estimate, S.ctxDisplayTokens || 0, peak);
  }
  setCtxRing({ ...b, tokens, percent: b.contextWindow ? (tokens / b.contextWindow) * 100 : null }, false);
}

/* Tokens per character, measured from messages that already have real usage.
 * Used only for the first moments of a message, before usage arrives. */
function noteTokenRatio(usage, chars) {
  if (!usage || !chars || chars < 200) return;
  const out = usage.output || 0;
  if (!out) return;
  const ratio = out / chars;
  if (!(ratio > 0.05 && ratio < 2)) return;   // nonsense values stay out
  S.tokPerChar = S.tokPerChar ? S.tokPerChar * 0.7 + ratio * 0.3 : ratio;
}

/* session totals (↑ read / ↓ write) summed from assistant message usage */
function updateTotals(extraUsage) {
  const read = S.totals.read + ((u) => u ? (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) : 0)(extraUsage);
  const write = S.totals.write + (extraUsage ? (extraUsage.output || 0) : 0);
  setText($('stat-tokens'), `↑ ${formatTok(read) ?? 0} · ↓ ${formatTok(write) ?? 0}`);
}

/* ───────────────────────── chat rendering ───────────────────────── */

/* The conversation scrolls in #chat-scroll (see the stylesheet): the scrollbar
 * reaches the bottom of the window and does not move when the composer grows.
 * Everything that measures or moves the reading position goes through this. */
function chatScroller() { return $('chat-scroll') || chat; }

function atBottom(slack = 60) {
  const sc = chatScroller();
  return sc.scrollHeight - sc.scrollTop - sc.clientHeight < slack;
}

/* Where does a transcript node go? Normally the chat. While another session is
 * on screen the agent's own output must not be mixed into it - that is why a turn
 * running in the background used to appear in whatever session you were reading.
 * It waits in a detached fragment until you switch back. transcriptTarget is set
 * while a transcript is rebuilt for display, so re-rendering the session you are
 * looking at still lands in the chat. */
let transcriptTarget = null;
function transcriptHost() {
  if (transcriptTarget) return transcriptTarget;
  if (S.renderInto) return S.renderInto;   // an older batch, being built off-screen
  if (!S.viewSession) return chat;
  const keep = S.liveDetached && S.liveDetached.frag ? S.liveDetached.frag : document.createDocumentFragment();
  S.liveDetached = { path: S.state.sessionFile, frag: keep };
  return keep;
}

function scrollBottom(force) {
  if (!force && transcriptTarget && transcriptTarget !== chat) return; // nothing was added to what you see

  if (!force && S.liveDetached) return; // the live view is parked; don't scroll the visible session
  if (!force && S.userScrolling) return; // never pin from under an active wheel/touch gesture
  if (force || S.stickToBottom) {
    lastProgrammaticScroll = Date.now();
    const sc = chatScroller();
    sc.scrollTop = sc.scrollHeight;
  }
}
let lastProgrammaticScroll = 0;
let userScrollIdle = 0;
let readingSaveTimer = null;
function saveReadingSoon() {
  if (readingSaveTimer) clearTimeout(readingSaveTimer);
  readingSaveTimer = setTimeout(() => { readingSaveTimer = null; saveReading(); }, 400);
}
chatScroller().addEventListener('scroll', saveReadingSoon);
chatScroller().addEventListener('scroll', updateJumpTop, { passive: true });
window.addEventListener('pagehide', saveReading);

chatScroller().addEventListener('scroll', () => {
  // Only an explicit wheel/touch gesture is trusted as "the user left the
  // bottom". A scroll event that lands just after we pinned is normally the
  // browser reacting to content being inserted above the viewport (the chat
  // grows between our pin and the next layout pass), and treating that as a
  // user scroll is what stopped auto-follow when a thinking block or tool card
  // appeared mid-turn. Real gestures set S.userScrolling and are always
  // honoured, so the guard can be strict here.
  if (!S.userScrolling && Date.now() - lastProgrammaticScroll < 250) return;
  const sc = chatScroller();
  S.stickToBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 60;
});
/* Re-pin once the newly inserted content has been laid out. scrollHeight read
 * in the same frame as an insert is stale, so the first pin can land short and
 * leave the view a few pixels off the bottom. */
function pinSoon() {
  if (!S.stickToBottom || S.userScrolling || S.liveDetached) return;
  requestAnimationFrame(() => {
    if (S.stickToBottom && !S.userScrolling && !S.liveDetached) scrollBottom();
  });
}
/* Explicit intent beats the guard above: a wheel-up or a touch drag is
 * unambiguous, so stop pinning before the browser even fires the scroll event.
 * Scrollbar drags are covered by the "dist < 4" check in the scroll handler. */
chatScroller().addEventListener('wheel', (e) => {
  if (e.deltaY < 0) S.stickToBottom = false;
  else if (atBottom()) S.stickToBottom = true;
  S.userScrolling = true;
  clearTimeout(userScrollIdle);
  userScrollIdle = setTimeout(() => {
    S.userScrolling = false;
    if (atBottom()) S.stickToBottom = true; // settled back at the bottom → follow again
  }, 180);
}, { passive: true });
chatScroller().addEventListener('touchstart', () => { S.userScrolling = true; }, { passive: true });
chatScroller().addEventListener('touchmove', () => { S.stickToBottom = atBottom(); }, { passive: true });
chatScroller().addEventListener('touchend', () => {
  S.userScrolling = false;
  S.stickToBottom = atBottom();
}, { passive: true });

function messageBlock(content) {
  // user message content may be a string or a block array
  if (typeof content === 'string') return { text: content, images: [] };
  const blocks = Array.isArray(content) ? content : [];
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    images: blocks.filter((b) => b.type === 'image'),
  };
}

/* ── jump to the very top ──────────────────────────────────────────────────
 * The other end of the transcript from the composer, and on a long session it
 * is thousands of pixels away with no handle to grab: the mouse wheel would
 * need a hundred turns and the spacebar gets eaten by the text. This is the
 * missing fifth button.
 *
 * Two things it has to get right:
 *
 *  - it appears only when there is somewhere to go, and disappears again at the
 *    top, so it costs nothing in the place you actually spend your time;
 *  - it lands on the very first message, not on "close enough to the top". The
 *    transcript renders in chunks now, so a click during a rebuild is remembered
 *    and honoured the moment the render that was in flight finishes - otherwise
 *    the scroll would be undone by the rows that arrived after it. */
const JUMP_TOP_SHOW_AT = 400;   // px from the top before the button appears

/* The button floats just above the composer, so it has to know how tall the
 * composer is - and that changes with the draft, the text size and the settings.
 * It is measured when the button appears (and on a resize / settings change),
 * never inside the scroll handler: reading a box's height during a scroll forces
 * a synchronous layout, which is the one thing a scroll handler must not do. */
function measureJumpTopDock() {
  const dock = $('composer-dock');
  const btn = $('btn-jump-top');
  if (!dock || !btn) return;
  const h = Math.round(dock.getBoundingClientRect().height);
  if (h && h !== jumpTopDockH) {
    jumpTopDockH = h;
    btn.style.bottom = `${h + 14}px`;
  }
}

function updateJumpTop() {
  const btn = $('btn-jump-top');
  if (!btn) return;
  if (S.jumpTopBusy) return;    // its own state is being managed by the click
  const sc = chatScroller();
  // `scrollTop` is measured from the top of the scroller, which includes the
  // chat's own top padding - hence the generous threshold: this is about "you
  // are reading somewhere in the middle", not about 400px of exactness.
  const want = sc.scrollTop > JUMP_TOP_SHOW_AT
    && (sc.scrollHeight - sc.clientHeight > JUMP_TOP_SHOW_AT);
  const has = btn.classList.contains('show');
  if (want === has) return;
  if (want) measureJumpTopDock();
  btn.classList.toggle('show', want);
}

async function jumpToTop() {
  const btn = $('btn-jump-top');
  if (!btn) return;
  const sc = chatScroller();
  // Nothing above to reach: a short conversation, or already at the top.
  if (sc.scrollHeight - sc.clientHeight <= JUMP_TOP_SHOW_AT) { sc.scrollTop = 0; return; }
  const before = S.historyRender;
  S.jumpTopBusy = true;
  measureJumpTopDock();
  btn.classList.add('show', 'busy');
  try {
    // If a transcript render is still running, its rows land *after* this scroll
    // and would push the top away again. Wait for it - bounded, so a render that
    // never finishes cannot leave the button spinning.
    const waited = Date.now();
    while (S.historyRender === before && Date.now() - waited < 4000) {
      await yieldToPage();
    }
    S.stickToBottom = false;    // we are deliberately leaving the bottom
    S.userScrolling = false;
    lastProgrammaticScroll = Date.now();
    sc.scrollTop = 0;
    saveReading();
  } finally {
    S.jumpTopBusy = false;
    btn.classList.remove('busy');
    updateJumpTop();
  }
}
$('btn-jump-top').addEventListener('click', () => { jumpToTop(); });
window.addEventListener('resize', () => { jumpTopDockH = 0; measureJumpTopDock(); updateJumpTop(); });

/* ── profile image + manual crop ──────────────────────────────────────────
 * The avatar and the background can be a still image, a GIF or a video, and
 * either can be panned and zoomed by hand (openCropper). object-position pans
 * and transform: scale() zooms about the centre - the crop stage, the chat
 * avatar and the background all compose the same way, so the preview in the
 * cropper is what you get. */
const VIDEO_SRC = /\.(mp4|webm|mov|m4v|ogv|mkv)([?#]|$)/i;
const IMAGE_SRC = /\.(png|jpe?g|gif|webp|avif|bmp|svg)([?#]|$)/i;
function isVideoSrc(src) {
  return /^data:video\//i.test(src || '') || VIDEO_SRC.test(src || '');
}

function mediaNode(src, cls) {
  if (!src) return null;
  let node;
  if (isVideoSrc(src)) {
    node = el('video', cls);
    // A background video is muted unless the user asked for its sound; browsers
    // block audible autoplay until the page has been interacted with, so that
    // case waits for the first click instead of playing silently forever.
    const wantsSound = cls === 'bg-node' && !!SET.bgAudio;
    node.muted = !wantsSound;
    node.volume = Math.max(0, Math.min(1, (SET.bgVolume == null ? 50 : Number(SET.bgVolume)) / 100));
    node.loop = true; node.autoplay = true; node.playsInline = true;
    node.setAttribute('playsinline', '');
    // A background picture is decoration. Without this the browser offers its
    // own menu on it - speed, sound, loop, "save video as" - which is useless
    // for a file the user picked locally, and it swallows the right-click that
    // should reach the page (spell-check suggestions included).
    node.controls = false;
    node.disablePictureInPicture = true;
    node.setAttribute('disablepictureinpicture', '');
    node.setAttribute('controlslist', 'nodownload noplaybackrate noremoteplayback');
    node.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); return false; };
    if (wantsSound) armBgAudioUnlock(node);
  } else {
    node = el('img', cls);
  }
  node.src = src;
  return node;
}

/* Old object-position crops are converted by normalizeCrop; the real
definitions live with the cropper. */

/* Profile image for the chat header, the sidebar and the settings preview.
 * There is no built-in default: with no image set, only the name is shown. */
/* ── the tab icon ─────────────────────────────────────────────────────────
 * One frame, painted once.
 *
 * This used to repaint the icon every 250ms whenever the agent's picture was a
 * video or a GIF, on the theory that an animated avatar should animate in the
 * tab. It does not: a favicon is a single image as far as every browser is
 * concerned, so those four canvases a second bought nothing anybody could see.
 * What they did buy was a 64x64 canvas allocated and PNG-encoded four times a
 * second for the entire life of the page, plus a <video> that stayed in the
 * document decoding frames nobody looked at. The tab looks exactly the same
 * and the page goes quiet. */
let favIconPainted = false;
let defaultFaviconHref = null;

function updateFavicon() {
  const link = document.querySelector('link[rel="icon"]');
  if (!link) return;
  if (defaultFaviconHref == null) defaultFaviconHref = link.getAttribute('href') || '';
  const src = instanceMediaUrl(instanceLook().avatar) || '';
  if (src === S.favSource && (S.favNode || favIconPainted)) return;   // already showing it
  S.favSource = src;
  favIconPainted = false;
  if (S.favNode) { try { S.favNode.remove(); } catch { /* gone */ } S.favNode = null; }
  if (!src) { link.setAttribute('href', defaultFaviconHref); favIconPainted = true; return; }
  const media = mediaNode(src, 'fav-source');
  if (!media) return;
  // In the document, a few pixels off screen: a detached video never decodes a
  // frame, so there would be nothing to draw.
  const isVideo = media.tagName === 'VIDEO';
  if (isVideo) {
    media.muted = true;
    media.loop = false;
    media.autoplay = false;
    media.playsInline = true;
    // 'auto' and not 'metadata': a video stopped at metadata knows its size but
    // has decoded nothing, and drawing it then produces an empty canvas.
    media.preload = 'auto';
  }
  S.favNode = media;
  document.body.appendChild(media);

  /* Paint the icon from the first frame, and only if there *is* one.
   *
   * The failure this guards against is silent and total: a video that has its
   * dimensions but no decoded frame reports a perfectly good videoWidth, so the
   * draw goes ahead, paints nothing, and a fully transparent PNG replaces the
   * default icon - a black square in the tab that nothing ever repairs. Asking
   * the canvas whether it is actually empty is the only way to notice, because
   * the browser says nothing either way. */
  const paint = () => {
    try {
      const c = document.createElement('canvas');
      c.width = 64; c.height = 64;
      const g = c.getContext('2d');
      const w = media.naturalWidth || media.videoWidth || 0;
      const h = media.naturalHeight || media.videoHeight || 0;
      if (!w || !h) return false;
      // fills the square, cropped through the middle - like the avatar itself
      const sc = Math.max(64 / w, 64 / h);
      g.drawImage(media, (64 - w * sc) / 2, (64 - h * sc) / 2, w * sc, h * sc);
      // one opaque pixel is enough to know a frame really landed
      const px = g.getImageData(0, 0, 64, 64).data;
      let any = false;
      for (let i = 3; i < px.length; i += 4) { if (px[i]) { any = true; break; } }
      if (!any) return false;
      link.setAttribute('href', c.toDataURL('image/png'));
      favIconPainted = true;
      return true;
    } catch { return false; }
  };

  /* One attempt, with a few tries: decoding a frame is not instantaneous, and a
   * video only produces one once it has actually started. The icon is left
   * exactly as it was until a real frame exists, so a clip that will not decode
   * at all leaves the default icon rather than a black one. */
  let tries = 0;
  const giveUpAt = 6;
  const attempt = () => {
    if (S.favNode !== media) { drop(); return; }   // superseded by a newer avatar
    if (paint() || ++tries >= giveUpAt) {
      release();
      drop();
      return;
    }
    // a video that has metadata but no frame needs to be started before it will
    // decode one; muted, so this is allowed without a click
    if (isVideo && media.paused) media.play().catch(() => { /* retry below */ });
    setTimeout(attempt, 180);
  };
  const release = () => {
    if (S.favNode !== media) return;
    S.favNode = null;
    if (!isVideo) return;
    // a video element left in the document keeps its decoder and its decoded
    // frames alive for the rest of the session, and it is on screen for nobody
    try { media.pause(); media.removeAttribute('src'); media.load(); } catch { /* ignore */ }
  };
  /* Off the page as soon as there is nothing left to do with it - a <video> is a
   * decoder, and an <img> holding a GIF keeps animating. The timeout below is
   * only a backstop for a source that never resolves one way or the other. */
  const drop = () => { try { media.remove(); } catch { /* gone */ } };

  // The src is set when the node is built, so a decoded image (a data URL, a
  // small file) can already be there; a video usually needs the attempts above.
  if (!paint()) attempt();
  else { release(); drop(); }
  // and a backstop, for a source that never resolves one way or the other
  setTimeout(drop, giveUpAt * 180 + 900);
}

/* ── the instance's own face ─────────────────────────────────────────────
 * Agent name, picture and background belong to the *instance* you are looking
 * at, not to this browser: while you are on another machine you should see that
 * machine's agent, its picture and its background. Its card carries the name and
 * picture (fetched cross-origin, like the switcher does) and its own
 * /api/ui-settings, through the proxy, carries the background. Nothing here is
 * ever written back to that instance - its settings are its own. */
function instanceLook() {
  if (!S.remote) {
    return {
      name: (SET.agentName || '').trim() || 'pi',
      avatar: SET.avatar || null,
      avatarCrop: SET.avatarCrop || null,
      themeBg: SET.themeBg || null,
      bgCrop: SET.bgCrop || null,
      local: true,
    };
  }
  const card = S.instanceCards[S.remote] || {};
  const look = (S.remoteLook && S.remoteLook.origin === S.remote) ? S.remoteLook : {};
  return {
    name: look.agentName || card.name || S.remoteName || S.remote,
    avatar: look.avatar || card.avatar || null,
    avatarCrop: look.avatarCrop || card.avatarCrop || null,
    themeBg: look.themeBg || null,
    bgCrop: look.bgCrop || null,
    local: false,
  };
}

/* A picture stored on another instance is served by *that* bridge, so a relative
 * /api/... URL has to go through the proxy - otherwise this page (or this
 * machine's bridge) is asked for a file that only exists over there, and the
 * avatar simply does not appear. */
function instanceMediaUrl(src) {
  const v = src || '';
  if (!v || !S.remote) return v;
  if (/^(data:|https?:|blob:)/i.test(v)) return v;
  return v.startsWith('/api/') ? `/proxy/${encodeURIComponent(S.remote)}${v}` : v;
}

function displayAgentName() {
  return instanceLook().name || 'pi';
}

/* The other instance's own UI settings, read (never written) through the proxy.
 * An older bridge without the endpoint, or one that is unreachable, just leaves
 * the card's name and picture in place. */
async function loadRemoteLook() {
  if (!S.remote) { S.remoteLook = null; return null; }
  const origin = S.remote;
  if (S.remoteLook && S.remoteLook.origin === origin && Date.now() - (S.remoteLook.at || 0) < 30000) return S.remoteLook;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const d = await fetch(`/proxy/${encodeURIComponent(origin)}/api/ui-settings`, { signal: ctl.signal, cache: 'no-store' })
      .then((r) => r.json());
    clearTimeout(t);
    if (S.remote !== origin) return null;                 // switched again meanwhile
    S.remoteLook = (d && typeof d === 'object') ? { ...d, origin, at: Date.now() } : null;
  } catch {
    if (S.remote === origin) S.remoteLook = null;         // card only
  }
  // The switcher's label should read the same name the chat does.
  const look = instanceLook();
  if (S.remote && look.name) S.remoteName = look.name;
  updateInstanceBtn();
  applySettings();
  return S.remoteLook;
}

/* ── a video avatar is decoded ONCE ─────────────────────────────────────
 * An avatar can be a video. It used to be a live <video> in every place an
 * avatar appears - and the chat header exists on every assistant message, so a
 * long transcript ran 200 decoders of the same file. A GPU only hardware-decodes
 * a handful of streams, so the rest fell back to software: the whole UI went CPU
 * bound and laggy, and each element held its own buffers.
 *
 * So: the sidebar keeps the animation (one decoder), everything else shows a
 * still frame captured from that video once, as a data URL. */
const avatarStillCache = new Map();   // src -> dataURL | 'pending' | 'failed'
const avatarStillPending = new Set();

/* The picture to show for `src`: the source itself for a normal image, a still
 * for a video (null until the capture finishes, so no <video> is ever created
 * for a message header). */
function avatarStillSrc(src) {
  if (!src) return null;
  if (!isVideoSrc(src)) return src;
  const hit = avatarStillCache.get(src);
  if (hit === 'failed') return null;
  if (hit && hit !== 'pending') return hit;
  if (!avatarStillPending.has(src)) captureAvatarStill(src);
  return null;
}

/* Decode one frame off-screen, draw it square (the crop frame's default shape)
 * and keep the PNG. Never hangs: a timeout falls back to a failed mark. */
function captureAvatarStill(src) {
  avatarStillPending.add(src);
  avatarStillCache.set(src, 'pending');
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  let settled = false;
  const finish = (ok) => {
    if (settled) return;
    settled = true;
    avatarStillPending.delete(src);
    if (ok) {
      try {
        const w = v.videoWidth || 96;
        const h = v.videoHeight || 96;
        const side = Math.max(1, Math.min(w, h));
        const size = Math.min(160, side);
        const c = document.createElement('canvas');
        c.width = size;
        c.height = size;
        c.getContext('2d').drawImage(v, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
        avatarStillCache.set(src, c.toDataURL('image/png'));
      } catch (e) {
        avatarStillCache.set(src, 'failed');
      }
    } else {
      avatarStillCache.set(src, 'failed');
    }
    releaseMedia(v);
    refreshAvatars();          // swap the still in
  };
  v.addEventListener('loadeddata', () => { try { v.currentTime = 0.05; } catch (e) { finish(!!v.videoWidth); } }, { once: true });
  v.addEventListener('seeked', () => finish(!!v.videoWidth), { once: true });
  v.addEventListener('loadedmetadata', () => { if (!v.videoWidth) finish(false); }, { once: true });
  v.addEventListener('error', () => finish(false), { once: true });
  setTimeout(() => finish(!!v.videoWidth), 5000);
  v.src = src;
}

/* Detaching a <video> is not enough: it keeps its resource, decoder and
 * buffers until the source is cleared. Dropping the old avatar nodes without
 * this is what leaked memory as videos were re-rendered. */
function releaseMedia(node) {
  if (!node || node.tagName !== 'VIDEO') return;
  try { node.pause(); } catch (e) { /* ignore */ }
  node.removeAttribute('src');
  try { node.load(); } catch (e) { /* ignore */ }
}

/* Everything before a transcript rebuild: free the decoders first. */
function releaseVideosIn(root) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll('video').forEach(releaseMedia);
}

/* What an avatar slot should show right now. `still` asks for the transcript
 * version (a picture); ready=false means "leave the slot alone", not "empty". */
function avatarWant(forceLocal, still) {
  const look = forceLocal ? null : instanceLook();
  if (forceLocal ? !SET.avatar : !look.avatar) return null;
  const src = forceLocal ? SET.avatar : instanceMediaUrl(look.avatar);
  const crop = forceLocal ? SET.avatarCrop : look.avatarCrop;
  if (!still) return { src, crop, ready: true };
  const shown = avatarStillSrc(src);
  return { src: shown, crop, ready: !!shown };
}

function avatarNode(sizeClass, forceLocal, still) {
  return avatarNodeFrom(avatarWant(forceLocal, still), sizeClass);
}

function avatarNodeFrom(want, sizeClass) {
  if (!want || !want.ready) return null;
  const wrap = el('span', `avatar-wrap${sizeClass ? ' ' + sizeClass : ''}`);
  const node = attachCrop(mediaNode(want.src, 'avatar'), want.crop, 1);
  // remember which crop this node was built with, so a crop change can rebuild it
  if (node) node.dataset.crop = JSON.stringify(want.crop || null);
  if (node && node.tagName === 'VIDEO') {
    // Join the animated group's frame instead of restarting from 0. A cached file
    // can be ready before those listeners attach, and a seek issued too early is
    // dropped, so every animated avatar also checks itself while it plays - the
    // group converges within a quarter of a second whatever the timing was.
    const join = () => alignAvatarVideo(node);
    node.addEventListener('loadedmetadata', join);
    node.addEventListener('canplay', join);
    node.addEventListener('playing', join);
    node.addEventListener('timeupdate', join);
    if (node.readyState >= 1) join();
  }
  wrap.appendChild(node);
  return wrap;
}

/* Put exactly this picture (and crop) into an avatar slot, doing nothing when it
 * is already there - replacing a video node restarts it. */
function putAvatarIn(slot, want) {
  if (!slot || !want || !want.ready) return false;
  if (avatarSlotMatches(slot, want)) return false;
  const node = avatarNodeFrom(want, undefined);
  if (!node) return false;
  const old = slot.querySelector('.avatar-wrap');
  slot.insertBefore(node, slot.firstChild);
  if (old) { releaseVideosIn(old); old.remove(); }
  return true;
}

/* How many messages animate: the newest few plus the sidebar. Every one of them
 * is the same video, so they are kept on the same frame - a group of avatars each
 * playing its own copy from wherever it happened to start looks broken. Everything
 * older is a still frame.
 *
 * The count is a setting (Settings > General) rather than a constant because it
 * is a straight trade: every extra animated message is another video decoder and
 * another copy of decoded frames in RAM, decoding at the clip's frame rate for as
 * long as the tab is open.
 *
 * The left end of the slider is "all of them" and means exactly that - no hidden
 * ceiling behind the word. The numeric steps are a cap. Either way the group
 * pauses while the tab is in the background. */
const AVATAR_ANIMATE_MAX = 8;   // the top of the numeric part of the slider
/* Stored as: -2 = all of them, -1 = none, 0 = none (what the old slider wrote
 * when it was at its left end, kept meaning the same thing so nobody who
 * deliberately turned avatars off gets every message animating again after an
 * update), 1-8 = a cap.
 *
 * The two special values are negative precisely because the previous scheme
 * only ever wrote 0-8, which is what makes this migration-free: every value an
 * older build could have stored still means the same thing. */
const AVATAR_ALL = -2;
function avatarAnimateCount() {
  const n = Number(SET.avatarAnimate);
  if (n === AVATAR_ALL) return Infinity;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(1, Math.min(AVATAR_ANIMATE_MAX, Math.round(n)));
}

/* The frame every animated avatar should be showing: one wall-clock position,
 * taken from page load, wrapped by the clip's duration. All of them play the same
 * file, so aligning each to this clock is enough to keep the group together - and
 * unlike "follow the first video that is playing" it cannot be dragged off by a
 * freshly built one (a transcript rebuild creates videos at 0, and following one
 * of those pulled the whole group back to the start). */
const avatarClockAt = performance.now();
function avatarClockNow() {
  return (performance.now() - avatarClockAt) / 1000;
}
function alignAvatarVideo(v) {
  if (!v || v.readyState < 1) return;
  // A video that is still loading can report a bogus (tiny) duration, and
  // `t %= tiny` is ~0 - which pinned the whole group on the first frame. Only
  // wrap for a believable duration, and only seek inside what is really seekable.
  const d = v.duration;
  if (!isFinite(d) || d < 2) return;
  const t = Math.max(0, avatarClockNow()) % d;   // the group loops, so the position wraps
  if (Math.abs(v.currentTime - t) < 0.12) return;
  try { v.currentTime = t; } catch (e) { /* not seekable yet */ }
}

/* Keep every animated avatar on that clock. A seek only happens when one has
 * drifted, so a settled group costs nothing. */
function syncAvatarVideos() {
  const vids = [...document.querySelectorAll('video.avatar')];
  // A background tab still gets its requestAnimationFrame ticks (browsers clamp
  // them to ~1/s but do not stop them) and the browser does not skip decoding
  // for an element nobody can see. Pausing the whole group when the document is
  // hidden is the difference between an idle second tab costing nothing and
  // costing four video decoders' worth of CPU.
  const hidden = document.visibilityState !== 'visible';
  for (const v of vids) {
    if (hidden) { if (!v.paused) { try { v.pause(); } catch { /* ignore */ } } continue; }
    if (v.paused) v.play().catch(() => {});
    if (v.readyState < 2) { v.addEventListener('canplay', () => alignAvatarVideo(v), { once: true }); continue; }
    alignAvatarVideo(v);
  }
}

/* Pause every video this page owns when it is not on screen, and start it again
 * when it is. The same argument as the avatars above, applied to the background
 * clip: a decorative video behind a minimised window is a decoder and a buffer
 * for nothing. The background only plays when it is meant to be heard or seen,
 * and never on a tab nobody is looking at. */
function pauseMediaWhenHidden() {
  const hidden = document.visibilityState !== 'visible';
  if (hidden) {
    document.querySelectorAll('#bg-media video').forEach((v) => { if (!v.paused) { try { v.pause(); } catch { /* ignore */ } } });
    document.querySelectorAll('video.avatar').forEach((v) => { if (!v.paused) { try { v.pause(); } catch { /* ignore */ } } });
  } else {
    const bg = document.querySelector('#bg-media video');
    if (bg) {
      const wanted = bg.dataset.wantedPlay === '1';
      if (wanted) bg.play().catch(() => {});
    }
    syncAvatarVideos();
  }
}

/* The newest few messages animate; every older one shows the still. Called after
 * renders and from the ticker, and it only touches a slot whose picture actually
 * changed - rebuilding an avatar restarts its video. */
function animateAvatarGroup() {
  const heads = [...document.querySelectorAll('.msg.assistant .who')];
  const want = Math.min(avatarAnimateCount(), heads.length);
  const firstLive = heads.length - want;      // heads before this index are stills
  const live = avatarWant(false, false);
  const still = avatarWant(false, true);
  heads.forEach((who, i) => {
    const target = i >= firstLive ? live : still;
    if (target && target.ready) putAvatarIn(who, target);
  });
  syncAvatarVideos();
  // the sync above needs a ticker to keep running; ensureTick decides
  ensureTick();
}

/* Does the transcript still match that? Used by the ticker to start itself when
 * a render has left the avatars in the wrong state (a new message arrives with a
 * still, and the oldest animated message has to give its video back). */
function avatarAnimNeeded() {
  const heads = [...document.querySelectorAll('.msg.assistant .who')];
  if (!heads.length) return false;
  const want = Math.min(avatarAnimateCount(), heads.length);
  const tail = heads.slice(-want);
  if (!tail.every((h) => h.querySelector('video.avatar'))) return true;
  return heads.slice(0, heads.length - want).some((h) => h.querySelector('video.avatar'));
}

/* Is the slot already showing exactly this picture with exactly this crop?
 * Both matter: the source alone would ignore a new crop (the preview kept its
 * old one), and rebuilding on every settings apply is what started videos over. */
function avatarSlotMatches(slot, want) {
  if (!slot || !want || !want.ready) return false;
  const cur = slot.querySelector('.avatar-wrap, img, video');
  const media = cur ? (cur.matches('img, video') ? cur : cur.querySelector('img, video')) : null;
  if (!media) return false;
  if (media.getAttribute('src') !== want.src) return false;
  return (media.dataset.crop || '') === JSON.stringify(want.crop || null);
}

/* Re-render every avatar after the image, its crop or its size changes. */
/* Put an avatar in a slot without restarting it: a video (or GIF) avatar was
 * rebuilt on every settings apply, which sent it back to the first frame. If the
 * same picture is already there, let it keep playing. */
function putAvatar(slot, node) {
  if (!slot) return;
  const want = node && node.querySelector('img, video');
  if (want && avatarSlotMatches(slot, { src: want.getAttribute('src'), crop: JSON.parse(want.dataset.crop || 'null'), ready: true })) return;   // keep it running
  releaseVideosIn(slot);
  slot.replaceChildren(...(node ? node.childNodes : []));
}

function refreshAvatars() {
  // Compare before building: creating a node just to throw it away left a
  // detached <video> (with its own resource load) behind on every settings
  // apply, which is the avatar memory leak.
  const still = avatarWant(false, true);
  const heads = [...document.querySelectorAll('.msg.assistant .who')];
  const lastHead = heads.length ? heads[heads.length - 1] : null;
  heads.forEach((who) => {
    // the newest message is animated instead (see animateLastMsgAvatar)
    if (who === lastHead) return;
    if (!still || !still.ready) return;              // pending or unset: leave the slot as it is
    if (avatarSlotMatches(who, still)) return;       // already showing this picture and crop
    const node = avatarNode(undefined, false, true);
    if (!node) return;
    const old = who.querySelector('.avatar-wrap');
    who.insertBefore(node, who.firstChild);
    if (old) { releaseVideosIn(old); old.remove(); }
  });
  animateAvatarGroup();
  // an instance-list row may be waiting for exactly the still captured above
  const instMenu = [...document.querySelectorAll('.menu')].find((m) => m._instances && m.isConnected);
  if (instMenu) refreshInstanceMenuInPlace(instMenu);
  const side = $('sidebar-avatar');
  if (side) {
    // The sidebar is the one place that keeps an animated avatar.
    const live = avatarWant(false, false);
    if (avatarSlotMatches(side, live)) {
      side.hidden = false;
    } else {
      const node = live ? avatarNode(undefined, false, false) : null;
      putAvatar(side, node);
      side.hidden = !node;
    }
  }
  const prev = $('set-avatar-preview');
  if (prev) {
    // Only the user's own image here, so "clear" visibly clears it (the app
    // icon fallback in the RN shell is not something you can crop or delete).
    // The dialog edits this machine's own settings, so its preview shows this
    // machine's picture even while you are looking at another instance.
    const local = avatarWant(true, false);
    if (avatarSlotMatches(prev, local)) {
      prev.style.visibility = 'visible';
    } else if (local) {
      const node = avatarNode(undefined, true);
      if (node) { releaseVideosIn(prev); prev.replaceChildren(...node.childNodes); prev.style.visibility = 'visible'; }
    } else {
      releaseVideosIn(prev);
      prev.replaceChildren();
      prev.style.visibility = 'hidden';
    }
  }
}

function makeMsgShell(role, who) {
  const root = el('div', `msg ${role}`);
  const head = el('div', 'who');
  if (role.includes('assistant')) {
    // a still frame, not a live video: see the note above avatarStillSrc()
    const av = avatarNode(undefined, false, true);
    if (av) head.appendChild(av);
    head.appendChild(el('span', 'agent-name-label', displayAgentName() || 'pi'));
    head.appendChild(el('span', 'who-text', ` · ${who}`));
  } else {
    head.appendChild(el('span', 'who-text', who));
  }
  const tools = el('span', 'msg-tools');
  head.appendChild(tools);
  const bubble = el('div', 'bubble');
  root.append(head, bubble);
  return { root, head, tools, bubble };
}

function addToolButton(container, label, title, fn) {
  const b = el('button', 'btn', label);
  b.title = title;
  b.onclick = fn;
  container.appendChild(b);
  return b;
}

function addCopyButton(tools, getText) {
  addToolButton(tools, 'copy', 'Copy text', () => {
    navigator.clipboard.writeText(getText()).then(() => toast('Copied'));
  });
}

function addSpeakButton(tools, getText) {
  addToolButton(tools, 'speak', 'Speak this message (TTS)', () => speak(getText()));
}

/* Stamp fork ids onto the rendered user rows. Freshly sent rows cannot be
 * matched when they are drawn (their entry does not exist yet), so this runs
 * again whenever a turn settles: it walks the rows in order against the current
 * entry list and rewrites the ids, which makes every turn - including the very
 * first one - forkable from its right-click menu. */
async function stampForkIds() {
  if (S.viewSession) return;   // a read-only view already carries entry ids
  await ensureForkable();
  document.querySelectorAll('#chat .msg.user').forEach((row) => {
    const text = row._msg ? messageBlock(row._msg.content).text : '';
    const fk = takeForkable(text);
    if (fk) {
      row.dataset.fork = fk.entryId;
      row.dataset.forktext = String(fk.text || '').slice(0, 300);
    } else {
      delete row.dataset.fork;
      delete row.dataset.forktext;
    }
  });
}



/* live streaming render */
/* Total time the turn took, written inside the last message of that turn. It is
 * wall-clock time from agent_start to agent_settled, so tool calls and waiting
 * are included, not just the writing. */
/* Per-session bits of UI state that would otherwise only exist in memory: the
 * length of the last turn (the stats row and the "turn took…" line) and whatever
 * the agent was in the middle of. Kept in localStorage, keyed per session, so a
 * reload comes back to the same picture. */
/* ── the reading position ────────────────────────────────────────────────
 * A resize reflows the transcript and the browser leaves the scroll somewhere
 * else (measured: ~14,000px off in a long session), and a reload came back at the
 * bottom with the "load older" window reset - so it looked like everything had
 * been forgotten. The topmost message on screen and how far it sat from the top
 * is what gets remembered (an id survives content growing below it). */
function readingAnchor() {
  const sc = chatScroller();
  const nodes = [...chat.querySelectorAll('.msg')];
  for (const n of nodes) {
    const r = n.getBoundingClientRect();
    const top = sc.getBoundingClientRect().top;
    if (r.bottom > top + 4) {
      return { ts: n.dataset.ts || null, off: Math.round(r.top - top), pinned: !!S.stickToBottom };
    }
  }
  return { ts: null, off: 0, pinned: !!S.stickToBottom };
}

function saveReading() {
  if (S.viewSession || !S.state.sessionFile) return;
  const a = readingAnchor();
  saveSessionUi({ reading: { ...a, at: Date.now() } });
}

/* Where the reader was, on a fresh page: a reload does not know whether they
 * were following the bottom or reading something old, and "the bottom" is the
 * wrong guess when a position was recorded with them *not* following it. */
function restoreReading(retries = 3, force) {
  if (S.viewSession) return;
  const kept = loadSessionUi();
  const a = kept && kept.reading;
  if (!a || !a.ts) return;
  if (Date.now() - (a.at || 0) > 7 * 24 * 3600 * 1000) return;
  const wanted = force === true || a.pinned === false;
  if (!wanted) return;
  if (a.pinned === false) S.stickToBottom = false;      // we are not following the bottom
  const sc = chatScroller();
  const node = chat.querySelector(`.msg[data-ts="${CSS.escape(String(a.ts))}"]`);
  if (!node) {
    if (retries > 0) setTimeout(() => restoreReading(retries - 1, force), 300);
    return;
  }
  const top = sc.getBoundingClientRect().top;
  sc.scrollTop += Math.round(node.getBoundingClientRect().top - top) - (a.off || 0);
  // The layout keeps settling for a while (images, tool cards, the dock's height,
  // the window's own load), and every settle moves the anchor a little. Follow it
  // for a couple of seconds rather than landing short.
  const delays = [60, 200, 450, 900, 1600];
  const step = delays.length - Math.max(0, retries);
  if (retries > 0 && step >= 0) setTimeout(() => restoreReading(retries - 1, force), delays[Math.min(step, delays.length - 1)]);
  else if (retries > 0) setTimeout(() => restoreReading(retries - 1, force), 1600);
}

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

/* ── the task clock (the number at the bottom) ───────────────────────────
 * "How long did that take?" means the whole task: from the message you sent to
 * the agent's last word, across every turn, tool call and compaction in between.
 * It is kept per session in localStorage, so a reload keeps counting instead of
 * starting over - and only sending a message starts a new one, because the
 * automatic continue after a compaction is the same task, not a new one. */
function startRunClock() {
  S.runStartTs = Date.now();
  S.runMs = null;
  saveSessionUi({ runStart: S.runStartTs, runMs: null });
  paintRunStat();
  ensureTick();
}
function finishRunClock(atMs) {
  if (!S.runStartTs) { paintRunStat(); return; }
  const end = Number(atMs) > S.runStartTs ? Number(atMs) : Date.now();
  S.runMs = Math.max(0, end - S.runStartTs);
  S.runStartTs = null;
  S.lastRun = { ms: S.runMs, ts: Date.now() };
  saveSessionUi({ runStart: null, runMs: S.runMs });
  paintRunStat();
  ensureTick();
}
function paintRunStat() {
  const stat = $('stat-turn');
  if (!stat) return;
  const live = !!S.runStartTs;
  const ms = live ? Date.now() - S.runStartTs : (S.runMs || 0);
  stat.classList.toggle('live', live);
  if (!ms && !live) { setText(stat, ''); stat.title = 'how long the task took'; return; }
  setText(stat, `total ${fmtElapsed(ms)}`);
  stat.title = live
    ? 'time since you sent your message — every turn, tool call and compaction counts'
    : 'how long the last task took, from your message to the agent’s last word';
}
/* The timestamp of the agent's last word: that is when a task ended, which is a
 * better boundary than "whenever this page noticed". */
function lastAssistantTs() {
  const b = [...chat.querySelectorAll('.msg.assistant')].pop();
  return b ? Number(b.dataset.ts) || 0 : 0;
}
/* After a reload: still running means keep counting from the same start; already
 * finished means show the number it stopped at. */
function restoreRunClock() {
  const kept = loadSessionUi();
  if (kept) {
    if (kept.runStart && !S.runStartTs) { S.runStartTs = kept.runStart; S.runMs = null; }
    else if (!S.runStartTs && !S.runMs && kept.runMs) S.runMs = kept.runMs;
  }
  // The page may have been away when it ended: the agent is idle now, so the
  // agent's last message is where the clock stopped.
  if (S.runStartTs && S.agentBusy === false && !S.compacting) {
    const endTs = lastAssistantTs();
    if (endTs > S.runStartTs) finishRunClock(endTs);
  }
  paintRunStat();
  ensureTick();
}

function stampTurnTimer() {
  const start = S.turnStartTs;
  S.turnStartTs = null;
  if (!start) return;
  const ms = Date.now() - start;
  // Remembered so a later re-render (or a session reload) can put the total
  // back on the last message instead of losing it.
  S.lastTurn = { ms, ts: Date.now() };
  saveSessionUi({ lastTurn: S.lastTurn });
  const bubbles = chat.querySelectorAll('.msg.assistant .bubble');
  const bubble = bubbles.length ? bubbles[bubbles.length - 1] : null;
  if (!bubble) return;
  bubble.querySelectorAll('.turn-timer').forEach((n) => n.remove());
  bubble.appendChild(el('div', 'turn-timer', `turn took ${fmtElapsed(ms)}`));
}

/* The bottom indicator is the task clock now (see paintRunStat), so a turn
 * starting only has to make sure one is running. It used to be a per-turn
 * stopwatch here, which reset to zero on every assistant turn - so a task with
 * five turns never showed its real total, and a reload started over. */
function startTurnTimer() {
  paintRunStat();
  ensureTick();
  return () => {};
}


/* ── manual crop ──────────────────────────────────────────────────────────
 * Drag to move, scroll (or use the slider) to zoom. The crop is stored as an
 * object-position percentage plus a zoom factor, so it survives reloads and
 * applies at every size the media is shown at. */
/* ── manual crop ──────────────────────────────────────────────────────────
 * The stage shows the WHOLE picture (object-fit: contain) with the crop area
 * drawn on top as a frame, so you can see what you are cutting off. It used to
 * show the image already cover-cropped to the frame, which made every crop
 * guesswork. The frame is fixed in place and the picture moves under it.
 *
 * Stored crop: { v:2, fx, fy, z } - fx/fy are -1..1 across the available pan
 * range (0 = centred), z is the zoom relative to the cover fit. Rendering uses
 * the same maths as before (translate + scale over a centred cover layout). */
/* Gamer mode: the accent drifts through the colour wheel, one full turn every
 * 16 seconds. Slow enough to read text over, fast enough to be alive. One timer
 * for the page, and it stops the moment the setting goes off. */
let gamerTimer = null;
let gamerPhase = 0;      // where we are in the cycle, 0..1
function startGamerAccent() {
  if (gamerTimer) return;
  const root = document.documentElement.style;
  let lastPaint = 0;
  let lastTs = 0;
  // The colour is advanced by the time that actually passed, never by a tick
  // count or a frame count: an interval that fires late, a busy page or a hidden
  // tab used to change the speed of the whole thing. Changing the speed setting
  // continues from where the colour is instead of jumping, and oklch keeps the
  // perceived speed even - a linear hsl sweep races through the greens and
  // crawls through the blues.
  const tick = (ts) => {
    // A hidden tab gets no paint and no reason to recompute a colour nobody can
    // see. requestAnimationFrame keeps firing (browsers clamp it to about once a
    // second, they do not stop it), so a backgrounded tab was still walking the
    // colour wheel and re-declaring two custom properties sixteen times a
    // second. The phase advances by real elapsed time on resume, so the cycle
    // picks up where it was instead of jumping.
    if (document.visibilityState !== 'visible') { gamerTimer = requestAnimationFrame(tick); lastTs = 0; return; }
    gamerTimer = requestAnimationFrame(tick);
    const dt = lastTs ? Math.min(250, ts - lastTs) : 0;
    lastTs = ts;
    gamerPhase = (gamerPhase + dt / (Math.max(1, Number(SET.gamerSpeed) || 16) * 1000)) % 1;
    if (ts - lastPaint < 60) return;   // ~16 fps is plenty for a colour drift
    lastPaint = ts;
    const hue = gamerPhase * 360;
    root.setProperty('--accent', `oklch(68% 0.17 ${hue.toFixed(1)})`);
    root.setProperty('--accent-dim', `oklch(38% 0.09 ${hue.toFixed(1)})`);
    // The outline around the chat text follows the hue, but not at accent
    // brightness: eight 1px shadows around small numbers at 68% lightness smeared
    // the glyphs (the [573.9K/1.0Mctx] label looked doubled). Mid-lightness keeps
    // the drift visible and the text readable.
    if (SET.textOutline !== false) root.setProperty('--outline-color', `oklch(45% 0.14 ${hue.toFixed(1)})`);
  };
  gamerTimer = requestAnimationFrame(tick);
}
function stopGamerAccent() {
  if (!gamerTimer) return;
  cancelAnimationFrame(gamerTimer);
  gamerTimer = null;
  const root = document.documentElement.style;
  root.removeProperty('--accent');
  root.removeProperty('--accent-dim');
  // ...and back to the colour from settings when the drift stops.
  applyThemeColours();
}

/* ── "the agent has finished" ─────────────────────────────────────────────
 * A turn often ends while you are looking at another window entirely. A short
 * two-note chime - or a sound of your own - and an optional desktop
 * notification say so. Both stay off until they are switched on in
 * Settings > General. */

/* One <audio> element, reused. A new Audio() per notification meant a new
 * network fetch and a new decoder every time, and the old ones were only
 * collected when the tab happened to unload. */
let doneSoundEl = null;
let doneSoundSrc = null;
function doneSoundUrl() {
  const raw = (SET.doneSoundUrl || '').trim();
  if (!raw) return '';
  // A relative /api/... path is a file this bridge serves; a bare relative path
  // would be resolved against whatever page the WebUI is embedded in.
  if (raw.startsWith('/api/') || /^(https?:|data:|blob:)/i.test(raw)) return raw;
  return raw;
}
function playCustomDoneSound() {
  const src = doneSoundUrl();
  if (!src) return false;
  try {
    if (!doneSoundEl) {
      doneSoundEl = new Audio();
      doneSoundEl.preload = 'auto';
      doneSoundEl.addEventListener('error', () => {
        // A sound that will not play must not stay silent for ever: say why,
        // once, and fall back to the chime.
        if (doneSoundSrc !== src) return;         // a newer sound replaced this one
        toast(`Could not play the notification sound: ${doneSoundEl.error && doneSoundEl.error.message ? doneSoundEl.error.message : 'file not found'}. Using the built-in chime.`, 'error');
        doneSoundSrc = null;
        doneSoundEl = null;
        playBuiltInChime();
      }, { once: true });
    }
    if (doneSoundSrc !== src) { doneSoundEl.src = src; doneSoundSrc = src; }
    const vol = Math.max(0, Math.min(1, (Number(SET.doneSoundVolume) || 100) / 100));
    doneSoundEl.volume = vol;
    doneSoundEl.currentTime = 0;
    // Autoplay policy: this only ever runs after a real turn, and the page has
    // been clicked at least once by then, but a rejected play() is normal
    // enough that it falls back to the chime rather than going quiet.
    const p = doneSoundEl.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => { if (doneSoundEl) { doneSoundEl = null; doneSoundSrc = null; } playBuiltInChime(); });
    }
    return true;
  } catch { doneSoundEl = null; doneSoundSrc = null; return false; }
}

function playBuiltInChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const t = ctx.currentTime + 0.01;
    [[784, 0], [1175, 0.13]].forEach(([freq, at]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + at);
      gain.gain.exponentialRampToValueAtTime(0.16, t + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t + at);
      osc.stop(t + at + 0.34);
    });
    setTimeout(() => { ctx.close().catch(() => { /* already closed */ }); }, 1200);
  } catch { /* no audio available */ }
}

/* Your own sound if one is set, the built-in chime otherwise. This is the one
 * place that decides, so the test button in Settings and the real notification
 * are guaranteed to sound the same. */
function playDoneSound() {
  if (playCustomDoneSound()) return;
  playBuiltInChime();
}

function notifyTurnDone() {
  const hidden = !document.hasFocus() || document.visibilityState !== 'visible';
  if (SET.doneOnlyUnfocused !== false && !hidden) return;
  if (SET.doneSound) playDoneSound();
  if (!SET.doneNotify) return;
  try {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      const name = displayAgentName();
      const session = ($('session-name') && $('session-name').value.trim()) || '';
      const note = new Notification(`${name} finished`, { body: session || 'The agent finished its turn.', tag: 'piwebui-done', silent: true });
      note.onclick = () => { try { window.focus(); note.close(); } catch { /* ignore */ } };
    } else if (Notification.permission === 'default') {
      Notification.requestPermission();
    }
  } catch { /* notifications unavailable */ }
}

/* ── custom cursor ────────────────────────────────────────────────────────
 * A custom pointer is a picture, a size, and the spot inside the picture that
 * is the actual tip.
 *
 * The picture is not handed to CSS as it is. That is the whole reason this looks
 * like it does nothing:
 *
 *  - `cursor: url()` never scales. The "Cursor size" setting had no effect at
 *    all, because the size in the shorthand is the *hotspot*, not a size.
 *  - Chromium drops a CSS cursor bigger than 128x128 and uses the fallback -
 *    no error, no warning. Cursor packs ship 256 and 512 px pictures as a
 *    matter of course, so a perfectly good picture is simply ignored.
 *  - a format that decodes as a picture is not necessarily usable as a cursor.
 *    A WebP loads in an <img> (so "can this be decoded?" says yes) and is then
 *    refused as a cursor.
 *  - a hotspot past the edge of the image makes the engine drop it too.
 *
 * None of those are observable from JavaScript: getComputedStyle reports the
 * url() in every one of those cases, so there is nothing to detect and nothing
 * to warn about after the fact. So the picture is normalised instead - drawn at
 * the size you asked for, capped at 128, written out as PNG - and the CSS gets
 * the result. The hotspot is clamped to the result, so the declaration is always
 * one the engine can use.
 *
 * Only same-origin pictures and data URLs are normalised, because drawing a
 * cross-origin image taints the canvas and toDataURL then throws. A remote URL
 * is passed through untouched (and, if it is too big, still will not show -
 * which the note under the field says).
 */
const CURSOR_MAX = 128;         // Chromium's documented maximum for a CSS cursor



/* ───────────────────────── boot ───────────────────────── */

wireVoiceSettings();   // defined here; the settings tab that used to call it loads first (issue #54)
wireAgentSourceUi();   // the pi location is asked in the UI now (issue #157)
wireCodePreview();     // the eye on html/svg code blocks (issue #175)
// Registered here, not in voice.js: voiceschanged can fire before app.js has
// evaluated, and the handler reads SET (issue #54).
// The list is fetched by the settings voice dropdown (and by speak()), never at
// boot: the first getVoices() can block for a second or more on Firefox, and
// nothing on the page is waiting for it until the reader asks for it.
speechSynthesis?.addEventListener?.('voiceschanged', () => { refreshTtsVoices(); populateTtsVoiceSelect(); });
applyReelsWidth();   // reads SET; must run after this script (issue #54)
wireTypeAnywhere();
applySettings();
/* A reload keeps you on the instance you were looking at - a proxied page is
 * still this origin, and losing that on refresh would be worse than the
 * navigation this replaced. */
try {
  const remembered = JSON.parse(sessionStorage.getItem('piwebui-remote') || 'null');
  if (remembered && remembered.url && remembered.url !== location.origin) {
    S.remote = remembered.url;
    S.remoteName = remembered.name || remembered.url;
  }
} catch { /* private mode */ }
loadServerSettings().then(() => {
  // Only offer the first-run dialog when the server's settings really loaded.
  // Without them SET is this browser's defaults, and the dialog would save those
  // defaults over a real configuration.
  if (settingsLoaded) { maybeShowSetup(); return; }
  // One retry: a busy bridge (a container doing its first `docker exec`, say) can
  // miss a request, and the dialog is the one thing that must not fire on a
  // half-loaded page.
  setTimeout(() => { loadServerSettings().then(() => { if (settingsLoaded) maybeShowSetup(); }); }, 3000);
});
connect();
updateInstanceBtn();

/* thinking level: the button opens the same dropdown as the model picker */
if ($('thinking-btn')) $('thinking-btn').onclick = (e) => { e.stopPropagation(); openThinkingMenu(); };

/* right-click menus: a session row (wired in renderSessions) or a message */
chat.addEventListener('contextmenu', (e) => {
  const node = e.target.closest('.msg');
  if (!node || node.classList.contains('compaction')) return;
  e.preventDefault();
  openTurnMenu(node, { x: e.clientX, y: e.clientY });
});

/* instances: the button opens the switcher, and the dots refresh in the
 * background so a busy agent on another machine shows up on its own */
if ($('btn-subagents')) {
  $('btn-subagents').onclick = (e) => { e.stopPropagation(); openSubagentsMenu($('btn-subagents')); };
  updateSubagentsBtn();
}
if ($('subagent-close')) $('subagent-close').onclick = () => $('subagent-dialog').close();
if ($('subagent-copy')) $('subagent-copy').onclick = () => copyText($('subagent-body').textContent || '', 'Copied what it wrote');
/* ── dropping a file on a settings row ───────────────────────────────────
 * The upload buttons work, but dropping a picture straight onto the row you want
 * it in is the obvious thing to try - and it did nothing (the page only accepted
 * drops in the chat). These rows take the same files as their buttons. */
function wireDropRow(node, onFile, label) {
  if (!node) return;
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  const clear = () => node.classList.remove('drop-ok');
  node.addEventListener('dragover', (e) => {
    const types = e.dataTransfer && e.dataTransfer.types;
    if (!types || !types.includes('Files')) return;   // a session row being dragged, not a file
    stop(e);
    e.dataTransfer.dropEffect = 'copy';
    node.classList.add('drop-ok');
  });
  node.addEventListener('dragleave', clear);
  node.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return undefined;
    stop(e);
    clear();
    hideDropOverlay();          // this row stops propagation, so nothing else can
    if (label) toast(`${label}: ${f.name}`);
    return onFile(f);
  });
}

wireDropRow($('set-avatar-preview') && $('set-avatar-preview').closest('.avatar-row'), (f) => acceptAvatarFile(f), 'Profile image');
wireDropRow($('bg-input') && $('bg-input').closest('.rate-row'), (f) => setBackgroundFromFile(f), 'Background');
wireDropRow($('setup-avatar-preview') && $('setup-avatar-preview').closest('.avatar-row'), (f) => acceptAvatarFile(f), 'Profile image');
wireDropRow($('setup-bg-upload') && $('setup-bg-upload').closest('.rate-row'), (f) => setBackgroundFromFile(f), 'Background');

/* The empty part of the session list: right-click for a new folder, drop a
 * session there to take it out of its folder. */
(function wireSessionList() {
  const list = $('session-list');
  if (!list) return;
  try {
    const raw = localStorage.getItem('piwebui-folders-collapsed');
    if (raw) S.collapsedFolders = JSON.parse(raw) || {};
  } catch { /* private mode */ }
  list.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.session-item') || e.target.closest('.session-folder')) return;
    e.preventDefault();
    openMenu(e.target.closest('.session-list') || list, [
      { label: 'new folder…', hint: 'group sessions by hand', onPick: () => addFolderDialog() },
      { label: 'refresh the list', onPick: () => refreshSessions(true) },
    ], { title: 'sessions', width: 320, force: true, at: { x: e.clientX, y: e.clientY } });
  });
  list.addEventListener('dragover', (e) => {
    if (!dragSession) return;
    if (e.target.closest('.session-folder') || e.target.closest('.session-item')) return;
    e.preventDefault();
    list.classList.add('drop-here');
  });
  list.addEventListener('dragleave', () => list.classList.remove('drop-here'));
  list.addEventListener('drop', (e) => {
    list.classList.remove('drop-here');
    if (e.target.closest('.session-folder') || e.target.closest('.session-item')) return;
    if (!dragSession) return;
    e.preventDefault();
    assignToFolder(dragSession, null);   // out of every folder
  });
})();

if ($('btn-bell')) {
  $('btn-bell').onclick = (e) => { e.stopPropagation(); openNoticesDialog(); };
  const done = $('notices-done');
  if (done) done.onclick = () => closeNoticesDialog();
  const clear = $('notices-clear');
  if (clear) clear.onclick = () => { S.notices = []; renderNotices(); updateBell(); };
  const dlg = $('notices-dialog');
  if (dlg) {
    // Esc and the backdrop close it like any other dialog, and either way the
    // badge is cleared on the way out rather than on the way in - the mark should
    // survive while the panel is open and you are still reading it.
    dlg.addEventListener('close', () => { S.noticesUnread = 0; updateBell(); });
  }
  updateBell();
}

if ($('btn-instance')) {
  $('btn-instance').onclick = (e) => { e.stopPropagation(); openInstanceMenu($('btn-instance')); };
  updateInstanceBtn();
  setTimeout(() => { pollInstances().catch(() => {}); }, 1500);
  refreshGoals().catch(() => {});
  // Every eight seconds means a request to every configured instance, all day,
  // to keep one dot in a menu that is closed almost all of the time. Polled only
  // while the page is on screen (a hidden tab asking a LAN machine how it is
  // doing is both wasteful and rude), and the menu is refreshed in place when
  // it happens to be open.
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    pollInstances().catch(() => {});
  }, 8000);
}

// Reopen the shorts panel if it was open when the page last unloaded.
if (typeof shortsAreDesktopOnly === 'function' && shortsAreDesktopOnly()
  && SET.reelsOpen && SHORTS_FEEDS[SET.shortsProvider || 'instagram']) {
  setTimeout(() => { if (reelsHidden()) showReels(SET.shortsProvider); }, 600);
}
