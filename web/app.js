/* Pi Agent WebUI — talks to the bridge over WebSocket, which relays to
 * `pi --mode rpc` (JSONL over the agent's stdin/stdout). */
'use strict';

/* ───────────────────────── helpers ───────────────────────── */

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* Compact markdown renderer: fenced code, headings, lists, quotes,
 * bold/italic/inline-code/links. Everything is HTML-escaped first. */
function renderMarkdown(src) {
  const parts = [];
  const segments = String(src ?? '').split(/```/);
  segments.forEach((seg, i) => {
    if (i % 2 === 1) { // fenced code block (first line may be a language tag)
      const nl = seg.indexOf('\n');
      const body = nl >= 0 ? seg.slice(nl + 1) : seg;
      parts.push(`<div class="codebox"><button class="code-toggle" title="Collapse/expand code">&minus;</button><pre>${escapeHtml(body.replace(/\n$/, ''))}</pre></div>`);
      return;
    }
    const lines = seg.split('\n');
    let html = '', para = [], list = null, quote = [];
    const flushPara = () => {
      if (para.length) { html += `<p>${inlineMd(para.join('<br>'))}</p>`; para = []; }
    };
    const flushList = () => { if (list) { html += `<${list.tag}>${list.items.map((li) => `<li>${inlineMd(li)}</li>`).join('')}</${list.tag}>`; list = null; } };
    const flushQuote = () => { if (quote.length) { html += `<blockquote>${inlineMd(quote.join('<br>'))}</blockquote>`; quote = []; } };
    const flushAll = () => { flushPara(); flushList(); flushQuote(); };
    for (const line of lines) {
      const t = line.trimEnd();
      let m;
      if ((m = t.match(/^(#{1,3})\s+(.*)/))) { flushAll(); html += `<h${m[1].length}>${inlineMd(m[2])}</h${m[1].length}>`; }
      else if ((m = t.match(/^[-*]\s+(.*)/))) { flushPara(); flushQuote(); if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; } list.items.push(m[1]); }
      else if ((m = t.match(/^\d+[.)]\s+(.*)/))) { flushPara(); flushQuote(); if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; } list.items.push(m[1]); }
      else if ((m = t.match(/^>\s?(.*)/))) { flushPara(); flushList(); quote.push(m[1]); }
      else if (t === '') { flushAll(); }
      else { flushList(); flushQuote(); para.push(escapeHtml(t)); }
    }
    flushAll();
    parts.push(html);
  });
  return parts.join('');

  function inlineMd(s) {
    return s
      .replace(/`([^`]+)`/g, (_, c) => `<code class="inline">${c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|\W)\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(?<!["'=])(\bhttps?:\/\/[^\s<]+)(?!["'])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }
}

/* Plain text for TTS / clipboard: drop code blocks and markdown noise. */
function stripMarkdown(src) {
  return String(src ?? '')
    .replace(/```[\s\S]*?```/g, ' (code block omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[*_]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
}

function timeStr(ts) {
  try { return new Date(ts ?? Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

/* The context counter.
 *
 * This went round twice. First it held a reserved width in CSS, so the numbers
 * changing would not move its neighbours - and the reservation was wider than
 * almost every real value, which left a visible hole between the counter and the
 * token counter. Then the text itself was padded to a fixed width, which moved
 * the hole *inside* the counter: three stray spaces sitting between the number
 * and the `/` and another lot before `ctx`, which looked like a mistake.
 *
 * So it is left alone: no reservation, no padding, the numbers as they are. It
 * is set in tabular figures, so the digits keep their columns as they change,
 * and a number only changes length when it crosses a unit - `999.9K` to
 * `1.00M` - which happens once in a while rather than several times a second.
 * A counter that is quietly the right length is worth more than one that is
 * guaranteed the same length and looks spaced out. */
function ctxLabel(used, room) {
  return `[${used}/${room}ctx]`;
}

function formatTok(n) {
  if (n == null || isNaN(n)) return null;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(Math.round(n));
}

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

/* Live elapsed-time timer for a running tool card (bash etc.). */
function fmtElapsed(ms) {
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
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
  if (!settingsLoaded && !force) return;
  // authoritative copy lives in webui-settings.json next to the project
  fetch(api('/api/ui-settings'), {
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
    if (feed) {
      reels.style.display = '';
      reels.textContent = feed.label;
      const mode = SET.shortsMode || 'panel';
      const modeLabel = mode === 'tab' ? 'new tab' : mode === 'window' ? 'side window (full feed)' : 'in-app split panel';
      reels.title = `Open ${feed.label} with one tap (${modeLabel})`;
    } else {
      reels.style.display = 'none';
    }
  }
  // auto-expand state on already-rendered elements
  document.querySelectorAll('details.thinking').forEach((d) => { d.open = SET.autoExpandThinking === true; });
  document.querySelectorAll('.tool-card .tool-body').forEach((b) => {
    b.classList.toggle('hidden', SET.autoExpandTools !== true);
  });
  // Runs here, once the settings are in: ?from=<instance> from the switcher.
  absorbFromParam();
}

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
    })
    .catch(() => {
      clearTimeout(t);
      // The bridge did not answer at all: the connection is dead, and closing it
      // is what lets the onclose path reconnect.
      try { ws.close(); } catch { /* already closing */ }
    });
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

function handleRpcMessage(msg) {
  if (msg.type === 'response') {
    const p = S.pending.get(msg.id);
    if (p) {
      S.pending.delete(msg.id);
      msg.success ? p.resolve(msg.data) : p.reject(new Error(msg.error || 'request failed'));
      if (!msg.success) {
        // A session whose recorded folder is gone gets its own dialog in
        // switchToSession; the raw pi error is not useful on top of that.
        const handledElsewhere = msg.command === 'switch_session' &&
          /working directory does not exist/i.test(msg.error || '');
        // An oversized-tree stack overflow here is self-inflicted (leafPath) and
        // harmless; putting it in the transcript looked like the agent broke.
        if (/Maximum call stack size exceeded/i.test(String(msg.error))) {
          console.warn(`handled silently (${msg.command}): ${msg.error}`);
        } else if (!handledElsewhere) toast(`Agent error (${msg.command}): ${msg.error}`, 'error');
      }
    }
    return;
  }
  if (msg.type === 'extension_ui_request') { handleExtensionUi(msg); return; }
  handleEvent(msg);
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
  const open = () => {
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
    openMenu(btn, items, { title: (btn.getAttribute('data-title') || sel.title || 'choose').toLowerCase(), width: 360 });
  };
  btn.onclick = (e) => { e.stopPropagation(); open(); };
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
/* Open dropdowns, oldest first. A right-click menu stacks on top of the menu it
 * was opened from instead of replacing it: removing an instance from inside the
 * switcher used to close the list you were working in. */
const MENUS = [];
let openMenuEl = null;   // the topmost one, for the code that only reads it
function closeMenu() {
  const m = MENUS.pop();
  if (!m) { openMenuEl = null; return; }
  if (m._subagents) S.subagentMenuOpen = false;
  m.remove();
  openMenuEl = MENUS[MENUS.length - 1] || null;
}

/* Every opener goes through this, and a capture-phase pointerdown closes whatever
 * was not clicked - so two dropdowns can never sit on screen together by
 * accident, whatever route opened them. A click on an open menu, or on the
 * button that opened it, is left alone: the button's own click handler decides,
 * which is what makes a second click on the same button close its menu. That
 * check is why the model button toggled and the thinking level and the instance
 * switcher did not - this handler closed their menu on pointerdown, so by the
 * time the click arrived there was nothing left to toggle and it reopened. */
function closeAllMenus() {
  while (MENUS.length) closeMenu();
  toggleModelMenu(false);
}
document.addEventListener('pointerdown', (e) => {
  const t = e.target;
  if (!t || !t.closest) return;
  // The model picker is a menu of its own (it has a search box and its own
  // toggle), so it is not in MENUS - but its button has to be left alone for the
  // same reason: closing it here meant the click that followed reopened it, and
  // the button never closed on a second click.
  const modelAnchor = !!(t.closest('#model-btn') || t.closest('#model-menu'));
  if (!modelAnchor) toggleModelMenu(false);
  if (modelAnchor) return;
  if (MENUS.some((m) => m.contains(t) || (m._anchor && m._anchor.contains(t)))) return;
  closeAllMenus();
}, true);

function openMenu(anchor, items, opts = {}) {
  const wasOpenFor = MENUS.length > 0 && MENUS[MENUS.length - 1]._anchor === anchor;
  // A submenu (the right-click menu inside the instance switcher) keeps its
  // parent on screen; anything else replaces whatever was open.
  if (opts.sub) toggleModelMenu(false);
  else closeAllMenus();
  if (wasOpenFor && !opts.force) return null;   // clicking the same anchor again closes
  if (!anchor || !items || !items.length) return null;
  const menu = el('div', 'model-menu');
  menu._anchor = anchor;
  let search = null;
  if (opts.search) {
    search = el('input');
    search.type = 'search';
    search.placeholder = opts.search;
    search.autocomplete = 'off';
    search.spellcheck = false;
    menu.appendChild(search);
  }
  if (opts.title) menu.appendChild(el('div', 'model-group', opts.title));
  const list = el('div', 'model-list');
  const render = (q) => {
    list.replaceChildren();
    const query = (q || '').trim().toLowerCase();
    const rows = items.filter((it) => !query ||
      `${it.label || ''} ${it.hint || ''} ${it.group || ''}`.toLowerCase().includes(query));
    if (!rows.length) { list.appendChild(el('div', 'model-empty', 'Nothing matches')); return; }
    let group = null;
    for (const it of rows) {
      if (it.sep) { list.appendChild(el('div', 'menu-sep', '')); group = null; continue; }
      if (it.group && it.group !== group) { group = it.group; list.appendChild(el('div', 'model-group', group)); }
      const row = el('div', 'model-item' + (it.active ? ' sel' : '') + (it.danger ? ' danger' : ''));
      if (it.instanceUrl) row.dataset.instance = it.instanceUrl;
      if (it.id) row.dataset.menuId = String(it.id);
      if (it.avatar || it.avatarPlaceholder) {
        // an instance's own picture, so the switcher shows who is who
        const img = it.avatar ? el('img', 'menu-avatar') : el('span', 'menu-avatar empty', '');
        if (it.avatar) { img.src = it.avatar; img.alt = ''; }
        row.appendChild(img);
      }
      if (it.dot) row.appendChild(el('span', `menu-dot ${it.dot}`, ''));
      row.appendChild(el('span', 'model-label', it.label || ''));
      if (it.hint) row.appendChild(el('span', 'model-provider', it.hint));
      row.onclick = (e) => {
        e.stopPropagation();
        if (it.keepOpen) { it.onPick && it.onPick(it); return; }
        // The whole stack, not just this menu: picking "switch to X" inside an
        // instance's right-click menu must not leave the switcher open behind it.
        closeAllMenus();
        it.onPick && it.onPick(it);
      };
      if (it.onContext) {
        row.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); it.onContext(it, row); };
      }
      list.appendChild(row);
    }
  };
  menu.appendChild(list);
  render('');
  if (search) {
    search.oninput = () => render(search.value);
    search.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeAllMenus(); }
      if (e.key === 'Enter') { const first = list.querySelector('.model-item'); if (first) first.click(); }
    };
  }
  // A modal <dialog> is in the browser's top layer, so a menu appended to the
  // body renders *under* it - the settings dropdowns opened behind the dialog and
  // could not be clicked. Inside the dialog the menu stays on top, and its
  // `position: fixed` coordinates are still viewport-relative.
  (document.querySelector('dialog[open]') || document.body).appendChild(menu);
  MENUS.push(menu);
  openMenuEl = menu;
  const r = anchor.getBoundingClientRect();
  const w = Math.max(200, Math.min(opts.width || 300, window.innerWidth - 24));
  menu.style.width = `${w}px`;
  const h = menu.offsetHeight;
  if (opts.at) {
    // Right-click menus appear where the pointer is, not at the message header.
    const left = Math.max(8, Math.min(opts.at.x, window.innerWidth - w - 8));
    const top = opts.at.y + h + 8 > window.innerHeight ? Math.max(8, opts.at.y - h - 6) : opts.at.y + 6;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  } else {
    const roomBelow = window.innerHeight - r.bottom - 10;
    if (roomBelow < Math.min(h, 220) && r.top > roomBelow) menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
    else menu.style.top = `${Math.min(r.bottom + 6, Math.max(8, window.innerHeight - h - 8))}px`;
    menu.style.left = `${Math.max(8, Math.min(opts.align === 'right' ? r.right - w : r.left, window.innerWidth - w - 8))}px`;
  }
  if (search) search.focus();
  menu.addEventListener('click', (e) => e.stopPropagation());
  setTimeout(() => document.addEventListener('click', closeAllMenus, { once: true }), 0);
  return menu;
}

/* What each thinking level means - shown in the dropdown, not on the button. */
const THINKING_NOTES = {
  off: 'no thinking - fastest replies',
  minimal: 'a quick look before answering',
  low: 'brief reasoning',
  medium: 'balanced - the usual choice',
  high: 'thorough reasoning, slower on hard problems',
  max: 'the most it can do - slowest',
};

function updateThinkingBtn() {
  const btn = $('thinking-btn');
  if (!btn) return;
  const sel = $('thinking-select');
  const opt = sel.selectedOptions && sel.selectedOptions[0];
  btn.textContent = opt ? opt.value : 'off';
  btn.title = `Thinking level: ${opt ? opt.value : 'off'} - click to change`;
}

function openThinkingMenu() {
  const sel = $('thinking-select');
  const levels = [...sel.options].map((o) => o.value);
  openMenu($('thinking-btn'), levels.map((lv) => ({
    label: lv,
    hint: THINKING_NOTES[lv] || '',
    active: sel.value === lv,
    onPick: () => {
      sel.value = lv;
      sel.dispatchEvent(new Event('change'));
    },
  })), { title: 'thinking level', width: 330 });
}

/* ── model picker ─────────────────────────────────────────────────────────
 * A native <select> cannot be searched, and with enough models its popup ran
 * off the bottom of the screen. This adds a searchable, scrollable list on top
 * of it. The hidden <select> stays the source of truth (set_model, state sync,
 * llama.cpp entries) so nothing else had to change. */
function modelMenuItems() {
  const sel = $('model-select');
  const out = [];
  for (const kid of sel.children) {
    if (kid.tagName === 'OPTGROUP') {
      for (const o of kid.children) out.push({ value: o.value, label: o.textContent, group: kid.label || '' });
    } else if (kid.tagName === 'OPTION') {
      out.push({ value: kid.value, label: kid.textContent, group: '' });
    }
  }
  return out;
}

function updateModelBtn() {
  const btn = $('model-btn');
  if (!btn) return;
  const sel = $('model-select');
  const opt = sel.selectedOptions && sel.selectedOptions[0];
  const label = opt ? opt.textContent : 'no model';
  btn.textContent = label;
  btn.title = `Model: ${label} — click to search and switch`;
}

function renderModelMenu(query) {
  const list = $('model-list');
  if (!list) return;
  const q = (query || '').trim().toLowerCase();
  const sel = $('model-select').value;
  const items = modelMenuItems().filter((it) =>
    !q || it.label.toLowerCase().includes(q) || it.value.toLowerCase().includes(q) || it.group.toLowerCase().includes(q));
  list.replaceChildren();
  if (!items.length) {
    list.appendChild(el('div', 'model-empty', q ? `No model matches “${query}”` : 'No models reported yet'));
    return;
  }
  let group = null;
  for (const it of items) {
    if (it.group && it.group !== group) {
      group = it.group;
      list.appendChild(el('div', 'model-group', group));
    }
    const row = el('div', 'model-item' + (it.value === sel ? ' sel' : ''));
    row.appendChild(el('span', 'model-label', it.label));
    if (!it.group) row.appendChild(el('span', 'model-provider', it.value.split('||')[0]));
    row.onclick = () => {
      const s = $('model-select');
      s.value = it.value;
      s.dispatchEvent(new Event('change'));
      toggleModelMenu(false);
    };
    list.appendChild(row);
  }
}

function toggleModelMenu(open) {
  const menu = $('model-menu');
  if (!menu) return;
  const show = open == null ? menu.classList.contains('hidden') : open;
  if (!show) { menu.classList.add('hidden'); return; }
  closeMenu();   // one dropdown at a time - the thinking menu used to stay open behind it
  const btn = $('model-btn');
  const r = btn.getBoundingClientRect();
  const width = Math.max(280, Math.min(420, window.innerWidth - 24));
  menu.style.width = `${width}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
  menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
  $('model-search').value = '';
  renderModelMenu('');
  menu.classList.remove('hidden');
  $('model-search').focus();
  const cur = menu.querySelector('.model-item.sel');
  if (cur) cur.scrollIntoView({ block: 'center' });
}

(function wireModelMenu() {
  const btn = $('model-btn');
  const menu = $('model-menu');
  if (!btn || !menu) return;
  btn.onclick = (e) => { e.stopPropagation(); refreshLlamaGroupThrottled(); toggleModelMenu(); };
  // Any change to the select (state sync, llama.cpp entry, a pick from the list)
  // has to be reflected on the button.
  $('model-select').addEventListener('change', () => updateModelBtn());
  $('model-search').oninput = (e) => renderModelMenu(e.target.value);
  $('model-search').onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); toggleModelMenu(false); input.focus(); }
    if (e.key === 'Enter') {
      const first = menu.querySelector('.model-item:not(.sel)') || menu.querySelector('.model-item.sel') || menu.querySelector('.model-item');
      if (first) first.click();
    }
  };
  menu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => toggleModelMenu(false));
})();

/* pi-llama-cpp derives the provider id from the URL the user configured, so the
 * id for a server we discovered can differ by a trailing slash, the case of the
 * host, or localhost vs 127.0.0.1. Comparing the raw string made the UI think a
 * server was not registered: it listed a second copy of every model and selecting
 * one asked to "point pi here" and then failed with provider-not-found. Compare
 * normalised URLs instead, and use the id pi itself reported. */
function normLlamaUrl(u) {
  try {
    const x = new URL(String(u || '').trim());
    let host = x.hostname.toLowerCase();
    if (host === 'localhost') host = '127.0.0.1';
    const port = x.port || (x.protocol === 'https:' ? '443' : '80');
    return `${host}:${port}${x.pathname.replace(/\/+$/, '')}`;
  } catch (e) {
    return String(u || '').trim().replace(/\/+$/, '').toLowerCase();
  }
}

/* Every provider pi has for this server. Usually one (its base URL), but some
 * setups register one per model ("<base>/<model>") - a multi-model server, or a
 * newer pi-llama-cpp - and then a "set_model" with the bare server id is a model
 * that does not exist. */
function llamaRegisteredProviders(srv) {
  if (!srv) return [];
  const base = normLlamaUrl(srv.url);
  const out = [];
  for (const m of (S.models || [])) {
    const p = String(m.provider || '');
    if (!p.startsWith('llama-server=')) continue;
    const u = normLlamaUrl(p.slice('llama-server='.length));
    if ((u === base || u.startsWith(base + '/')) && !out.includes(p)) out.push(p);
  }
  return out;
}

/* The id to use for this server and (when given) this model: the per-model id if
 * pi has one, else the plain server id. Null when pi has nothing for the server. */
function llamaProviderFor(srv, modelId) {
  if (!srv) return null;
  const list = llamaRegisteredProviders(srv);
  // nothing registered: the id the extension *would* derive, so callers always have
  // a usable value (llamaRegistered() is what says whether pi knows the server)
  if (!list.length) return llamaSyntheticProvider(srv);
  if (modelId) {
    const want = '/' + String(modelId).toLowerCase();
    const byModel = list.find((p) => normLlamaUrl(p.slice('llama-server='.length)).toLowerCase().endsWith(want));
    if (byModel) return byModel;
  }
  return list.slice().sort((a, b) => a.length - b.length)[0];   // the plain server id
}

/* The id this server gets when pi has not registered it (what the extension
 * would derive), so the banner can still offer to point pi at it. */
function llamaSyntheticProvider(srv) {
  return srv ? (srv.providerId || `llama-server=${srv.url}`) : null;
}

function llamaRegistered(srv) {
  return llamaRegisteredProviders(srv).length > 0;
}

/* A live server that pi knows this provider id for (by URL, not by spelling). */
function llamaServerForProvider(provider) {
  const id = String(provider || '');
  if (!id.startsWith('llama-server=')) return null;
  const want = normLlamaUrl(id.slice('llama-server='.length));
  return (llamaLiveServers || []).find((x) => {
    const base = normLlamaUrl(x.url);
    return want === base || want.startsWith(base + '/');
  }) || null;
}

/* Repair a value that carries the model inside the URL - "<base>/<model>", which
 * is how a per-model provider id looks when the "||" separator was lost. Returns
 * {provider, modelId} or null when it cannot be told apart. */
function splitGluedModel(provider, modelId) {
  const glued = /:\/\//.test(String(modelId || '')) ? modelId : (/:\/\//.test(String(provider || '')) && !modelId ? provider : null);
  if (!glued) return null;
  const cut = String(glued).lastIndexOf('/');
  if (cut <= 'https://'.length) return null;
  const base = String(glued).slice(0, cut);
  const model = String(glued).slice(cut + 1);
  if (!model) return null;
  const srv = (llamaLiveServers || []).find((x) => normLlamaUrl(x.url) === normLlamaUrl(base));
  return { provider: srv ? (llamaProviderFor(srv, model) || `llama-server=${base}`) : `llama-server=${base}`, modelId: model, srv };
}

async function refreshModels() {
  try {
    const d = await rpc({ type: 'get_available_models' });
    S.models = asArray(d, 'models');
    const sel = $('model-select');
    sel.innerHTML = '';
    for (const m of S.models) {
      const o = el('option', null, `${m.name || m.id}`);
      // "||" separator: provider ids can contain colons (llama-server=http://host:8080)
      o.value = `${m.provider}||${m.id}`;
      sel.appendChild(o);
    }
    ensureLlamaGroup(); // retried in the background until the server answers
    if (S.state.model) syncSelect(sel, `${S.state.model.provider}||${S.state.model.id}`);
    updateModelBtn();
  } catch { /* agent may not implement it */ }
}

/* llama.cpp: query the router(s) directly so every model the server knows
 * about shows up — even ones pi has not registered yet. Selecting one sends
 * set_model with the "llama-server=<url>" provider id the pi-llama-cpp
 * extension uses. If pi has not registered that provider (e.g. its configured
 * URL is unreachable), a banner offers to point pi at the live server and
 * restart the agent so the model becomes selectable. */
let llamaLiveServers = [];
let llamaConfiguredUrls = [];
let llamaEnvOverride = null;   // LLAMA_SERVER_URL wins over the configured list
let llamaMismatchBanner = false;
let llamaFixInFlight = false;

async function refreshLlamaGroup() {
  const sel = $('model-select');
  const old = sel.querySelector('optgroup[data-llama]');
  if (old) old.remove();
  try {
    const [d, cfg] = await Promise.all([
      fetch(api('/api/llama-models')).then((r) => r.json()),
      fetch(api('/api/llama-config')).then((r) => r.json()),
    ]);
    llamaConfiguredUrls = Array.isArray(cfg.urls) ? cfg.urls : (cfg.url ? [cfg.url] : []);
    llamaEnvOverride = cfg.envOverride || null;
    llamaLiveServers = d.servers || [];
    if (!llamaLiveServers.length) {
      hideLlamaMismatch();
      return;
    }
    const known = new Set(S.models.map((m) => `${m.provider}||${m.id}`));
    const group = el('optgroup', null, 'llama.cpp (found on this machine or the LAN)');
    // A sweep that finishes after the menu was built left it stale - which is why
    // the models from the LAN only showed up on the second open.
    const before = ($('model-select').querySelector('optgroup[data-llama]') || {}).innerHTML || '';
    group.dataset.llama = '1';
    let unregistered = null;
    for (const srv of llamaLiveServers) {
      const short = srv.url.replace(/^https?:\/\//, '');
      const registered = llamaRegistered(srv);
      if (!registered && !unregistered) unregistered = srv;
      // the id pi registered this server under, so set_model works and the group
      // never duplicates what pi already listed
      const pid = llamaProviderFor(srv) || llamaSyntheticProvider(srv);
      for (const m of srv.models) {
        // Skip only when pi lists this model *for this server*. Matching the model
        // id alone hid the second instance's copy: two servers very often serve the
        // same file (the same model id), and the LAN one then vanished from the list
        // while its local twin was registered.
        const perModel = llamaProviderFor(srv, m.id);
        const key = `${perModel || pid}||${m.id}`;
        if (known.has(key)) continue;
        const o = el('option', null, llamaLiveServers.length > 1 ? `${m.name || m.id} · ${short}` : (m.name || m.id));
        o.value = key;
        group.appendChild(o);
      }
    }
    // A concurrent refresh (the retry loop below) can append a second group before
    // the first is removed, which showed every model twice. Keep one, and drop
    // options that repeat a value.
    const seenVals = new Set();
    group.querySelectorAll('option').forEach((o) => { if (seenVals.has(o.value)) o.remove(); else seenVals.add(o.value); });
    if (group.children.length) {
      sel.querySelectorAll('optgroup[data-llama]').forEach((g) => g.remove());
      sel.appendChild(group);
    }
    if (unregistered) showLlamaMismatch(unregistered);
    else hideLlamaMismatch();
    const after = ($('model-select').querySelector('optgroup[data-llama]') || {}).innerHTML || '';
    const menu = $('model-menu');
    if (after !== before && menu && !menu.classList.contains('hidden')) {
      renderModelMenu($('model-search') ? $('model-search').value : '');
      updateModelBtn();
    }
  } catch { /* bridge offline or no llama.cpp server */ }
}

function showLlamaMismatch(srv) {
  if (SET.llamaDismissed === srv.url) return;      // told once, not again
  const short = srv.url.replace(/^https?:\/\//, '');
  const isConfigured = llamaConfiguredUrls.some((u) => normLlamaUrl(u) === normLlamaUrl(srv.url));
  const configured = !isConfigured && llamaConfiguredUrls.length
    ? `pi is configured for ${llamaConfiguredUrls.map((u) => u.replace(/^https?:\/\//, '')).join(', ')} (the live server is not registered)`
    : 'pi has not registered it yet';
  showBanner('warn',
    `llama.cpp server found at ${short} with ${srv.models.length} models, but ${configured} — selecting its models will fail until pi is pointed at it. If pi-llama-cpp is not installed, install it with: pi install npm:pi-llama-cpp.`,
    `Point pi at ${llamaLiveServers.length > 1 ? `all ${llamaLiveServers.length} servers` : 'this server'} & reload`,
    () => fixLlamaConfig((llamaLiveServers.length ? llamaLiveServers : [srv]).map((x) => x.url)),
    () => {
      // Kept in the settings, so it does not come back for this server on the
      // next poll, reload or browser. A *different* server still gets a mention.
      SET.llamaDismissed = srv.url;
      saveSettings();
      toast('llama.cpp hint dismissed — the server is still listed in Settings → Pi providers');
    });
  llamaMismatchBanner = true;
}

function hideLlamaMismatch() {
  if (!llamaMismatchBanner) return;
  llamaMismatchBanner = false;
  hideBanner();
}

/* One-click fix: write the live URL into pi's global settings, restart the
 * agent (pi-llama-cpp resolves the URL at startup), then retry the model
 * the user was trying to select. */
/* Point pi at one server, or at all of them at once: the extension registers one
 * provider per entry of llamaSettings.servers, so a list gives every instance's
 * models in the picker without switching back and forth. */
async function fixLlamaConfig(urls) {
  if (llamaFixInFlight) return;
  const list = Array.isArray(urls) ? urls : [urls];
  llamaFixInFlight = true;
  toast(list.length > 1 ? `Pointing pi at ${list.length} servers and restarting the agent…` : 'Updating pi config and restarting the agent…');
  try {
    const r = await fetch(api('/api/llama-config'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: list }),
    });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || `failed (${r.status})`);
    const wait = waitForAgentReady(60000);
    send({ bridge: 'restart' });
    await wait;
    await initSession(true); // full re-init: resume last session + refresh models
    hideLlamaMismatch();
    if (S.pendingModel) {
      const pm = S.pendingModel;
      S.pendingModel = null;
      try {
        await rpc({ type: 'set_model', provider: pm.provider, modelId: pm.modelId });
        // applyState below picks up the model change and re-reads the levels
        await rpc({ type: 'get_state' }).then(applyState);
        toast(`Model switched: ${pm.modelId}`);
      } catch (e) {
        toast(`Agent restarted, but model switch failed: ${e.message}`, 'error');
      }
    }
  } catch (e) {
    toast(`Fix failed: ${e.message}`, 'error');
  } finally {
    llamaFixInFlight = false;
  }
}

/* The llama.cpp server may still be starting up (or pi's own 1s health check
 * at startup may have skipped it), so keep re-probing in the background until
 * at least one server answers. */
const LLAMA_RETRY_DELAYS = [3000, 5000, 10000, 15000, 20000, 30000];
async function ensureLlamaGroup(attempt = 0) {
  await refreshLlamaGroup();
  const g = $('model-select').querySelector('optgroup[data-llama]');
  // Stop retrying once every live server is registered with pi (its models
  // then appear in the main list, so the optgroup is intentionally empty).
  const allRegistered = llamaLiveServers.length > 0 &&
    llamaLiveServers.every((s) => llamaRegistered(s));
  if ((g && g.children.length) || allRegistered || attempt >= LLAMA_RETRY_DELAYS.length) return;
  const delay = LLAMA_RETRY_DELAYS[attempt] || LLAMA_RETRY_DELAYS[LLAMA_RETRY_DELAYS.length - 1];
  setTimeout(() => { ensureLlamaGroup(attempt + 1); }, delay);
}

let llamaGroupRefreshAt = 0;
$('model-select').addEventListener('focus', () => {
  const now = Date.now();
  if (now - llamaGroupRefreshAt < 10000) return; // throttle: max once per 10s
  llamaGroupRefreshAt = now;
  refreshLlamaGroup();
});
/* The select is hidden behind the model button now, so the same refresh runs
 * when the picker is opened. */
function refreshLlamaGroupThrottled() {
  const now = Date.now();
  if (now - llamaGroupRefreshAt < 10000) return;
  llamaGroupRefreshAt = now;
  refreshLlamaGroup();
  updateModelBtn();
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
function ensureForkable() {
  const key = `${S.state.sessionFile || ''}|${S.viewSession || ''}`;
  if (forkInFlight && forkSessionKey === key) return forkInFlight;
  forkSessionKey = key;
  forkInFlight = refreshForkable()
    .then(() => { resetForkQueue(); })
    .catch(() => { /* the fork buttons simply stay out until it can be asked again */ });
  return forkInFlight;
}

async function refreshForkable() {
  try {
    const d = await rpc({ type: 'get_fork_messages' });
    S.forkable = asArray(d, 'messages');
  } catch { S.forkable = []; }
  // Fork ids must come from the *active branch*. The file also holds abandoned
  // branches from earlier forks, so walking it in file order shifted every id
  // after the first fork - which is why right-clicking a turn forked somewhere
  // else. The tree plus leafId gives exactly the conversation on screen.
  try {
    const d = await rpc({ type: 'get_tree' });
    const path = leafPath(d && d.tree, d && d.leafId);
    const users = path
      .filter((e) => e && e.message && e.message.role === 'user')
      .map((e) => ({ entryId: e.id, text: (e.message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ') }));
    S.forkEntries = users.length ? users : (S.forkable || []).map((f) => ({ entryId: f.entryId, text: f.text }));
  } catch {
    S.forkEntries = (S.forkable || []).map((f) => ({ entryId: f.entryId, text: f.text }));
  }
}

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
/* ── subagents ────────────────────────────────────────────────────────────
 * pi-subagents runs child agents inside the session. They are jobs with their
 * own goal, tool, turn and status, and while they run the transcript shows one
 * tool card - so a fan-out of four looks exactly like a single slow call. The
 * extension publishes a live snapshot of every run (as a widget line) and the
 * foreground progress arrives with the tool updates; both land here.
 *
 * What the panel shows per run: what it is (agent + label), what it is doing
 * (state, current tool, turns, tools), for how long, and - on a click - what it
 * has written so far, read from the extension's own artifact file. */
/* Tool names that run a child agent inside this session (the pi-subagents
 * extension registers `subagent`; `task` is the same idea under other names). */
const SUBAGENT_TOOLS = new Set(['subagent', 'task']);

const SUBAGENT_STATES = {
  queued: 'queued', running: 'running', pending: 'waiting', complete: 'done', completed: 'done',
  failed: 'failed', partial: 'partial', paused: 'paused', stopped: 'stopped', rejected: 'rejected',
  detached: 'in the background', stopping: 'stopping',
};

function subagentList() {
  const runs = S.subagents ? [...S.subagents.values()] : [];
  // Running first, then by when they started.
  return runs.sort((a, b) => {
    const ra = /running|pending|queued|stopping/.test(a.state || '') ? 0 : 1;
    const rb = /running|pending|queued|stopping/.test(b.state || '') ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return (b.startedAt || 0) - (a.startedAt || 0);
  });
}

function updateSubagentsBtn() {
  const btn = $('btn-subagents');
  if (!btn) return;
  const runs = subagentList();
  const live = runs.filter(isLiveRun).length;
  // Only ever on the session the runs came from (and while one of theirs is open).
  btn.classList.toggle('hidden', runs.length === 0);
  btn.classList.toggle('active', !!S.viewSubagent);
  const count = $('subagents-count');
  if (count) count.textContent = live ? `${live}` : `${runs.length}`;
  btn.classList.toggle('live', live > 0);
  btn.title = live
    ? `${live} subagent${live > 1 ? 's' : ''} running — click to see them`
    : `${runs.length} subagent${runs.length > 1 ? 's' : ''} finished in this session`;
}

function noteSubagent(run) {
  if (!S.subagents) S.subagents = new Map();
  const id = String(run.id || '');
  if (!id) return;
  const cur = S.subagents.get(id) || {};
  S.subagents.set(id, { ...cur, ...run, id, updatedAt: Date.now() });
  updateSubagentsBtn();
}

function setSubagentSnapshot(d) {
  if (!d || !Array.isArray(d.runs)) return;
  const seen = new Set();
  const walk = (node, parent) => {
    if (!node || !node.id) return;
    seen.add(String(node.id));
    const act = node.activity || {};
    noteSubagent({
      id: node.id,
      label: node.label || node.name || act.label || 'subagent',
      kind: node.kind || 'subagent',
      state: node.state || act.state || 'running',
      startedAt: node.startedAt || (S.subagents.get(String(node.id)) || {}).startedAt || Date.now(),
      endedAt: node.endedAt || null,
      currentTool: act.currentTool || null,
      turnCount: act.turnCount || 0,
      toolCount: act.toolCount || 0,
      lastActivityAt: node.updatedAt || act.lastActivityAt || null,
      parent: parent || null,
      background: true,
    });
    for (const kid of node.children || []) walk(kid, String(node.id));
  };
  for (const r of d.runs) walk(r, null);
  // A background run that is no longer in the snapshot has ended (the extension
  // drops it once it is finished and delivered).
  for (const [id, run] of [...S.subagents]) {
    if (run.background && !run.fromDisk && !seen.has(id) && isLiveRun(run)) {
      noteSubagent({ id, state: run.endedAt ? run.state : 'done' });
    }
  }
  if (S.subagentMenuOpen) refreshSubagentMenu();
}

function noteSubagentInspect(d) {
  if (!d) return;
  const id = String(d.asyncId || d.runId || d.id || '');
  if (!id) return;
  noteSubagent({ id, output: d.finalOutput || d.output || '', task: d.task || '', label: d.label || d.agent || '' });
}

/* Bytes as something a person reads: KB while that is meaningful, then MB, then
 * GB. A session at 30 MB was shown as "30720.0 KB". */
function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtElapsedShort(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

function subagentHint(r) {
  const parts = [];
  const state = SUBAGENT_STATES[r.state] || r.state || 'running';
  const live = isLiveRun(r);
  if (!!S.viewSubagent && String(S.viewSubagent.id) === String(r.id)) parts.push('open');
  if (live) parts.push(state);
  else if (state !== 'done') parts.push(state);
  if (r.currentTool) parts.push(r.currentTool);
  if (r.turnCount) parts.push(`${r.turnCount} turn${r.turnCount > 1 ? 's' : ''}`);
  if (r.toolCount) parts.push(`${r.toolCount} tool${r.toolCount > 1 ? 's' : ''}`);
  // How long it has been running, or how long it took: the panel is repainted
  // once a second while a run is live, so this counts up in front of you.
  const startedAt = r.startedAt || 0;
  const endedAt = r.endedAt || 0;
  const spent = startedAt ? (live || !endedAt ? Date.now() - startedAt : endedAt - startedAt) : 0;
  if (spent > 2000) parts.push(live ? `${fmtElapsedShort(spent)} so far` : `took ${fmtElapsedShort(spent)}`);
  if (r.currentTool && r.currentToolStartedAt) parts.push(`${fmtElapsedShort(Date.now() - r.currentToolStartedAt)} on it`);
  if (r.totalTokens && r.totalTokens.total) parts.push(`${Math.round(r.totalTokens.total / 1000)}K tok`);
  if (!live && r.error) parts.push(String(r.error).slice(0, 60));
  if (r.background) parts.push('background');
  return parts.join(' · ');
}

function openSubagentsMenu(anchor) {
  S.subagentMenuOpen = true;
  refreshSubagents(true).catch(() => {});   // fresh, not from the last poll
  ensureTick();
  const runs = subagentList();
  const items = [];
  // While a child's conversation is open, this is how you get back.
  if (S.viewSubagent) {
    items.push({ label: '← back to the conversation', hint: `return to the session “${S.viewSubagent.label || 'subagent'}” belongs to`, onPick: () => backFromSubagent() });
    items.push({ sep: true });
  }
  items.push(...runs.map((r) => ({
    id: `subagent:${r.id}`,
    label: r.label || 'subagent',
    hint: subagentHint(r),
    dot: isLiveRun(r) ? 'live-dot' : (/failed|rejected/.test(r.state || '') ? 'off-dot' : null),
    keepOpen: true,
    onPick: () => openSubagentView(r),
  })));
  items.push({ sep: true });
  items.push({ label: 'refresh the list', hint: 're-read what the extension published', onPick: () => { updateSubagentsBtn(); refreshSubagentMenu(); } });
  const menu = openMenu(anchor, items, { title: `subagents (${runs.length})`, width: 460, force: true, align: 'right' });
  if (menu) {
    menu._subagents = true;
    menu.addEventListener('remove', () => { S.subagentMenuOpen = false; });
    // The menu is rebuilt from what is known now; a run that finishes while it is
    // open updates in place (see refreshSubagentMenu).
    const obs = new MutationObserver(() => { if (!menu.isConnected) { S.subagentMenuOpen = false; obs.disconnect(); } });
    obs.observe(document.body, { childList: true });
  }
}

function refreshSubagentMenu() {
  const menu = openMenuEl && openMenuEl._subagents ? openMenuEl : null;
  if (!menu) return;
  const byId = new Map(subagentList().map((r) => [`subagent:${r.id}`, r]));
  for (const row of menu.querySelectorAll('.model-item[data-menu-id]')) {
    const r = byId.get(row.dataset.menuId);
    if (!r) continue;
    const hint = row.querySelector('.model-provider');
    if (hint) hint.textContent = subagentHint(r);
    const label = row.querySelector('.model-label');
    if (label) label.textContent = r.label || 'subagent';
  }
  updateSubagentsBtn();
}

/* Turning off the thinking and tool-call blocks left their messages behind as
 * bare headers with token counts - a column of empty boxes. A message with nothing
 * visible left is marked and hidden. */
function bubbleHasVisibleText(bubble, hideThinking, hideTools) {
  for (const n of bubble.querySelectorAll('.md, .md *')) {
    if (hideThinking && n.closest('details.thinking')) continue;
    if (n.closest('.tool-card')) continue;              // cards count via the toggle below
    if (n.children.length) continue;                    // text sits in the leaves
    if ((n.textContent || '').trim()) return true;
  }
  return false;
}

function markHollowMessages() {
  const hideThinking = SET.showThinking === false;
  const hideTools = SET.showToolCalls === false;
  for (const m of chat.querySelectorAll('.msg.assistant')) {
    if (!hideThinking && !hideTools) { delete m.dataset.hollow; continue; }
    const bubble = m.querySelector('.bubble');
    if (!bubble) continue;
    const hasThinking = !!bubble.querySelector('details.thinking, .thinking');
    const hasTools = !!bubble.querySelector('.tool-card');
    const visible = bubbleHasVisibleText(bubble, hideThinking, hideTools)
      || (hasThinking && !hideThinking)
      || (hasTools && !hideTools);
    if (visible) delete m.dataset.hollow;
    else m.dataset.hollow = '1';
  }
}

/* One transcript line as a readable block. */
function subagentLineHtml(entry) {
  const msg = entry && entry.message ? entry.message : entry;
  const role = (msg && (msg.role || msg.type)) || 'entry';
  let text = '';
  const content = msg && msg.content;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content.map((c) => (typeof c === 'string' ? c : (c && (c.text || c.thinking || c.output || '')) || '')).filter(Boolean).join('\n');
  } else if (msg && msg.summary) text = msg.summary;
  if (!text && msg && msg.command) text = `$ ${msg.command}\n${msg.output || ''}`;
  if (!text) { try { text = JSON.stringify(msg).slice(0, 4000); } catch { text = ''; } }
  const who = role === 'toolResult' ? `tool: ${msg.toolName || 'result'}` : role;
  const esc = (v) => String(v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  let body;
  if (/^(assistant|toolResult)$/.test(role)) {
    try { body = renderMarkdown(text); } catch { body = `<p>${esc(text)}</p>`; }
  } else body = `<p>${esc(text).replace(/\n/g, '<br>')}</p>`;
  return `<div class="sub-msg ${esc(role)}"><div class="sub-who">${esc(who)}</div><div class="sub-body">${body}</div></div>`;
}

/* Whatever the bridge found: a child's transcript becomes a conversation, anything
 * else is shown as text. Returns how many messages were rendered. */
function renderSubagentBody(body, text) {
  const raw = String(text || '').trim();
  if (raw.startsWith('{') && raw.includes('"role"')) {
    const entries = [];
    for (const line of raw.split('\n')) {
      const l = line.trim();
      if (!l.startsWith('{')) continue;
      try { entries.push(JSON.parse(l)); } catch { /* a torn last line */ }
    }
    const msgs = entries.filter((e) => e && (e.message || e.role || e.type === 'message'));
    if (msgs.length) {
      body.innerHTML = msgs.map(subagentLineHtml).join('');
      return msgs.length;
    }
  }
  body.textContent = raw || 'Nothing here yet.';
  return 0;
}

/* What a subagent wrote. The extension keeps one output file per run next to the
 * session, which the bridge can read (also inside a container), so this needs no
 * new protocol - and it does not disturb the running agent. */
async function showSubagentOutput(run) {
  const dlg = $('subagent-dialog');
  if (!dlg) { toast('No subagent dialog available', 'error'); return; }
  $('subagent-title').textContent = run.label || 'subagent';
  $('subagent-meta').textContent = subagentHint(run) || 'no details';
  const body = $('subagent-body');
  body.innerHTML = '';
  const q = `run=${encodeURIComponent(run.id)}&label=${encodeURIComponent(run.label || '')}`
    + (run.dir ? `&dir=${encodeURIComponent(run.dir)}` : '');
  if (!run.output) body.textContent = 'Loading what it wrote…';
  dlg.showModal();
  if (run.output) { renderSubagentBody(body, run.output); return; }
  try {
    const d = await fetch(api(`/api/subagent-output?${q}`)).then((r) => r.json());
    if (d && d.error) throw new Error(d.error);
    const text = (d && d.text) || '';
    const shown = renderSubagentBody(body, text);
    if (!text.trim()) body.textContent = 'Nothing written yet — a background run writes its log as it goes, and this panel reloads it.';
    else if (shown) $('subagent-meta').textContent = `${subagentHint(run)} · ${shown} messages${d.file ? ` · ${d.file}` : ''}`;
    else if (d.notes) $('subagent-meta').textContent = `${subagentHint(run)} · ${d.notes}`;
    run.output = text;
  } catch (e) {
    body.textContent = `Could not read this run's conversation: ${e.message}`;
  }
}

/* Fallback used when the run has no session file of its own (an older run, or an
 * agent that keeps no session): the same conversation, rendered from the
 * transcript artifact into the dialog. */

/* ── which session's subagents, and keeping them live ─────────────────────
 * A subagent belongs to the conversation that started it, so the panel only
 * appears there. The list is read from the bridge (one status.json per run),
 * which also means a reload brings the runs back instead of starting empty, and
 * that a run is up to date even while the parent is idle waiting for it. While a
 * child's own session is open the panel stays put - that is the way back. */
function subagentSessionKey() {
  if (S.viewSubagent) return S.viewSubagent.sessionId || S.state.sessionFile || '';
  return S.viewSession || (S.state && S.state.sessionFile) || '';
}
function isLiveRun(r) { return /running|pending|queued|stopping/.test((r && r.state) || ''); }

let subagentFetchAt = 0;
async function refreshSubagents(force) {
  const key = subagentSessionKey();
  if (!key) {
    // No session yet: nothing to attribute runs to, and "all runs on this
    // machine" is not an answer (it put the panel on sessions that never ran
    // one). Empty until we know.
    if (S.subagents && S.subagents.size) { S.subagents = new Map(); updateSubagentsBtn(); }
    else if (S.subagents) S.subagents = new Map();
    updateSubagentsBtn();
    return null;
  }
  const now = Date.now();
  if (!force && now - subagentFetchAt < 700) return null;   // the tick is 1s; the bridge caches too
  subagentFetchAt = now;
  let d;
  try {
    d = await fetch(api(`/api/subagent-runs?session=${encodeURIComponent(key)}`)).then((r) => r.json());
  } catch { return null; }
  if (!d || !Array.isArray(d.runs)) return null;
  if (subagentSessionKey() !== key) return null;   // the view changed while this was in flight
  if (!S.subagents) S.subagents = new Map();
  const seen = new Set();
  for (const r of d.runs) {
    const id = String(r.runId || '');
    if (!id) continue;
    seen.add(id);
    const cur = S.subagents.get(id) || {};
    noteSubagent({
      id,
      fromDisk: true,
      label: r.agent || cur.label || id.slice(0, 8),
      kind: 'subagent',
      state: r.state || cur.state,
      activityState: r.activityState || cur.activityState || null,
      currentTool: r.currentTool || cur.currentTool || null,
      currentToolStartedAt: r.currentToolStartedAt || cur.currentToolStartedAt || null,
      turnCount: r.turnCount || cur.turnCount || 0,
      toolCount: r.toolCount || cur.toolCount || 0,
      startedAt: r.startedAt || cur.startedAt || Date.now(),
      endedAt: r.endedAt || null,
      lastActivityAt: r.lastActivityAt || null,
      sessionFile: r.sessionFile || null,
      sessionId: r.sessionId || null,
      model: r.model || null,
      totalTokens: r.totalTokens || null,
      error: r.error || null,
      background: r.mode ? r.mode !== 'foreground' : true,
      task: cur.task || '',
      output: cur.output || '',
    });
  }
  // Runs the disk does not know about yet (the extension's widget reported them
  // first) stay until they show up there too.
  for (const [id, run] of [...S.subagents]) if (run.fromDisk && !seen.has(id)) S.subagents.delete(id);
  updateSubagentsBtn();
  if (S.subagentMenuOpen) refreshSubagentMenu();
  ensureTick();
  return d;
}

/* One timer for everything that has to move while you watch: the task clock, a
 * running subagent's elapsed time, and a child's session as it grows. Stopped
 * again as soon as nothing needs it. */
let uiTick = null;
function tickNeeded() {
  if (S.runStartTs) return true;
  if ($('setup-dialog') && $('setup-dialog').open) return true;   // the avatar preview fills in
  if (S.subagentMenuOpen || S.viewSubagent) return true;
  // a fresh render leaves the avatars in the wrong state until the ticker fixes it
  if (avatarAnimNeeded()) return true;
  // and while a group of avatars animates, the ticker is what keeps them on the
  // same frame - a second of drift is visible when they are side by side
  if (document.querySelectorAll('video.avatar').length > 1) return true;
  return subagentList().some(isLiveRun);
}
function ensureTick() {
  if (tickNeeded() && !uiTick) uiTick = setInterval(onUiTick, 1000);
  else if (!tickNeeded() && uiTick) { clearInterval(uiTick); uiTick = null; }
}
function onUiTick() {
  paintRunStat();
  animateAvatarGroup();            // the newest messages keep the animated avatar
  syncAvatarVideos();              // and stay on the same frame
  if ($('setup-dialog') && $('setup-dialog').open) refreshSetupPreview();
  if (S.subagentMenuOpen || S.viewSubagent || subagentList().some(isLiveRun)) refreshSubagents().catch(() => {});
  if (S.subagentMenuOpen) refreshSubagentMenu();
  if (S.viewSubagent) refreshSubagentView().catch(() => {});
  ensureTick();
}

/* Nothing this page animates needs to run behind a tab nobody is looking at.
 * The 1s ticker, the video decoders and the background clip all keep going
 * otherwise, which is a third of the CPU a browser tab should be using while it
 * is parked next to a dozen others. Coming back re-reads the state that is
 * cheap to fetch and re-aligns everything that is not. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    if (uiTick) { clearInterval(uiTick); uiTick = null; }
    pauseMediaWhenHidden();
    return;
  }
  pauseMediaWhenHidden();
  ensureTick();
  if (S.isStreaming) { refreshStats().catch(() => {}); refreshSubagents(true).catch(() => {}); }
  updateJumpTop();
});

/* A subagent runs in a session of its own - the run status records the file - so
 * opening one shows that conversation read-only in the same chat, with the way
 * back one click away (and the sub-agent list still in the top bar). */
let subagentViewAt = 0;
async function openSubagentView(run) {
  if (!run) return;
  const file = run.sessionFile;
  if (!file || !/\.jsonl$/i.test(file)) { showSubagentOutput(run); return; }   // nothing to open: the text panel
  closeAllMenus();
  // The agent may be mid-answer: park its live DOM first (exactly like switching
  // sessions does), otherwise its streaming message would be written into the
  // child's conversation.
  if (S.isStreaming && S.live) {
    const frag = document.createDocumentFragment();
    frag.appendChild(S.live.root);
    S.liveDetached = { path: S.state.sessionFile, frag };
  }
  S.viewSubagent = { ...run, sessionFile: file };
  S.viewSession = file;
  S.subagentViewCount = 0;
  S.stickToBottom = true;
  subagentViewAt = 0;
  await refreshSubagentView(true);
  updateViewBanner();
  updateSubagentsBtn();
  syncSessionHighlight();
  ensureTick();
}

async function backFromSubagent() {
  S.viewSubagent = null;
  S.viewSession = null;
  S.subagentViewCount = 0;
  await refreshMessages();
  updateViewBanner();
  updateSubagentsBtn();
  syncSessionHighlight();
  ensureTick();
}

/* Re-read the child's session while it is still writing, but only redraw when it
 * actually grew: a redraw on every tick would fight with scrolling. */
async function refreshSubagentView(force) {
  if (!S.viewSubagent) return;
  if (!force && Date.now() - subagentViewAt < 2500) return;
  subagentViewAt = Date.now();
  let d;
  try { d = await fetchSession(S.viewSubagent.sessionFile); } catch { return; }
  if (!S.viewSubagent) return;
  const n = (d.messages || []).length;
  if (!force && n === S.subagentViewCount) return;
  S.subagentViewCount = n;
  const distFromBottom = chatScroller().scrollHeight - chatScroller().scrollTop - chatScroller().clientHeight;
  releaseVideosIn(chat);          // a detached <video> keeps its decoder and buffers
  chat.innerHTML = '';
  transcriptTarget = chat;
  for (const m of d.messages) {
    if (m.role === 'user') renderUserMessage(m);
    else if (m.role === 'assistant') renderAssistantMessage(m);
    else if (m.role === 'toolResult') renderToolResult(m);
    else if (m.role === 'bashExecution') renderBashExecution(m);
    else if (m.role === 'compactionSummary') renderCompactionSummary(m);
  }
  transcriptTarget = null;
  if (S.stickToBottom && distFromBottom < 80) scrollBottom(true);
  updateViewBanner();
}

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

/* pi's user messages and the forkable list are both in order, so pair them up as
 * the transcript renders; identical texts then keep working. The list comes from
 * get_entries, not get_fork_messages: get_entries keeps pre-compaction history
 * and abandoned branches, so an old message - or one before the last compaction
 * - is still forkable instead of only the tail of the session. */
let forkQueue = [];
function resetForkQueue() { forkQueue = (S.forkEntries || []).map((f) => ({ ...f, used: false })); }
function takeForkable(text) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const t = norm(text);
  let hit = forkQueue.find((f) => !f.used && norm(f.text) === t);
  if (!hit) hit = forkQueue.find((f) => !f.used);
  if (hit) hit.used = true;
  return hit || null;
}

function renderUserMessage(msg) {
  const { text, images } = messageBlock(msg.content);
  const { root, tools, bubble } = makeMsgShell('user', `you · ${timeStr(msg.timestamp)}`);
  root._msg = msg;
  /* Marked so a transcript rebuild can tell this row apart from one that came
   * from the session file. A row drawn here from a send exists only in the DOM:
   * pi has not written the message yet, so a rebuild - which renders from the
   * file - would otherwise drop it. See the carry-over in refreshMessages(). */
  if (msg.__live) root.dataset.live = '1';
  // Fork entry for this turn. A session read from disk carries its entry id;
  // for the agent's own session it is matched from the entry list. A row that
  // was just sent by this window is skipped: it is not in the file yet, so it
  // has no entry to point at, and consuming one would shift every later match.
  const fk = msg.entryId ? { entryId: msg.entryId } : (msg.__live ? null : takeForkable(text));
  if (fk) { root.dataset.fork = fk.entryId; root.dataset.forktext = text.slice(0, 300); }
  addCopyButton(tools, () => text);
  // fork index is (re)written onto the element by refreshMessages; read it at click time
  addToolButton(tools, 'edit', 'Edit & resend (forks the session from here)',
    () => startEdit(msg, root.dataset.forkIdx));

  if (images.length) {
    for (const im of images) {
      const src = imageDataUrl(im);
      if (!src) continue;
      const img = el('img', 'msg-img');
      lazySrc(img, src);
      img.onclick = () => zoomImage(img.dataset.src || src);
      // a picture the bridge named but that has since moved (a compaction
      // rewrote the file) answers 404: show that rather than a broken glyph
      img.onerror = () => { img.classList.add('img-missing'); img.removeAttribute('src'); };
      bubble.appendChild(img);
    }
  }
  if (text) {
    const body = el('div', 'md');
    body.innerHTML = renderMarkdown(text).replace(/^<p>/, '').replace(/<\/p>$/, '');
    bubble.appendChild(body);
  }
  transcriptHost().appendChild(root);
  scrollBottom();
  // Returned so a caller that drew this row optimistically can take it back if
  // the message turns out not to have been delivered (see sendPrompt).
  return root;
}

/* Estimated written tokens for a live message, used while streaming and as a
 * fallback when the provider never reports usage. */
function estWriteTokens(L) {
  if (!L) return 0;
  return Math.round((L.text.length + L.thinking.length) / 4);
}

/* Remember how long a message took so a later re-render (tool cards arriving,
 * a session re-read, a page reload) keeps the tokens/sec figure instead of
 * silently dropping it. Keyed by the message timestamp pi stores. */
function rememberTiming(msg, timing) {
  const key = msg && (msg.timestamp != null ? `t${msg.timestamp}` : (msg.id ? `i${msg.id}` : null));
  if (key && timing) S.msgTiming.set(key, timing);
  return timing;
}

function timingFor(msg, timing) {
  if (timing && (timing.elapsedSec || timing.prefillSec || timing.est)) {
    return rememberTiming(msg, timing);
  }
  const key = msg && (msg.timestamp != null ? `t${msg.timestamp}` : (msg.id ? `i${msg.id}` : null));
  if (key && S.msgTiming.has(key)) return S.msgTiming.get(key);
  return timing || null;
}

/* Messages read back from a session file have no live timings. The gap to the
 * previous message is the turn's duration, which is enough to show a rate - it
 * includes the prompt read, so the figure is a little conservative. */
function noteHistoryTiming(msg, prevTs) {
  const key = msg && msg.timestamp != null ? `t${msg.timestamp}` : null;
  if (!key || S.msgTiming.has(key)) return;
  if (prevTs == null || msg.timestamp == null) return;
  const sec = (msg.timestamp - prevTs) / 1000;
  if (sec > 0.05 && sec < 3600) S.msgTiming.set(key, { elapsedSec: sec, prefillSec: null });
}

function renderAssistantMessage(msg, timing) {
  timing = timingFor(msg, timing);
  const { root, tools, bubble } = makeMsgShell('assistant', timeStr(msg.timestamp));
  root._msg = msg;
  ensureTick();     // the newest messages take the animated avatars over from the old ones
  const textBlocks = [];
  let stats = usageStats(msg.usage, timing && timing.elapsedSec, timing && timing.prefillSec);
  if (!stats && timing && timing.est) stats = estStatsText(timing.est, timing.elapsedSec);
  if (stats) {
    const s = el('span', 'agent-stats', ` (${stats})`);
    s.title = (msg.usage
      ? 'token usage: input+cache read / output written'
      : 'estimated token usage - this provider did not report any') +
      (timing && timing.elapsedSec ? ` over ${timing.elapsedSec.toFixed(1)}s of streaming` : '');
    // Stats before the action buttons: "Pi · 04:30 PM (↑ 43.6K read · ↓ 523 write) [copy] [speak]"
    root.querySelector('.who').insertBefore(s, tools);
  }
  addCopyButton(tools, () => textBlocks.join('\n\n'));
  addSpeakButton(tools, () => stripMarkdown(textBlocks.join('\n\n')));

  /* Narration that exists only to introduce a tool call is hidden with the tool
   * calls themselves (issue #36).
   *
   * With the tool cards off, what is left of a message like "Let me check that
   * file" is text about a call the reader cannot see - and pi emits one before
   * most calls, so a turn reads as a wall of it. The text *after* the first
   * toolCall is kept: that is not narration, it is the message continuing.
   *
   * Nothing is hidden that would leave a gap: renderAssistantMessage's caller
   * already marks a message with no visible content as hollow and hides it, so a
   * message that was only narration disappears entirely rather than leaving an
   * empty bubble with a timestamp in it. */
  const blocks = msg.content || [];
  const firstToolAt = SET.showToolCalls === false ? blocks.findIndex((b) => b && b.type === 'toolCall') : -1;
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    if (block.type === 'text') {
      if (firstToolAt >= 0 && bi < firstToolAt) continue;   // narration for a hidden call
      textBlocks.push(block.text);
      const d = el('div', 'md');
      d.innerHTML = renderMarkdown(block.text);
      bubble.appendChild(d);
    } else if (block.type === 'thinking') {
      bubble.appendChild(makeThinking(block.thinking || ''));
    } else if (block.type === 'toolCall') {
      // A call can still be executing when its assistant message is finalised
      // (message_end arrives before the tool runs), and finalizeLive re-renders
      // the message from history here. Keep such a card running, timer and all,
      // instead of showing a finished-looking card for a command that is
      // literally still executing.
      const prev = S.toolCards.get(block.id);
      const wasRunning = !!(prev && prev._timer);
      const card = makeToolCard(block.name, { toolCallId: block.id, state: wasRunning ? 'running' : 'done' });
      if (wasRunning) {
        clearInterval(prev._timer);
        card._start = prev._start;
        card._timeoutMs = prev._timeoutMs || 0;
        startCardTimer(card);
      }
      noteToolTimeout(card, block.arguments);
      fillToolBody(card, block.name, block.arguments);
      bubble.appendChild(card.card);
      S.toolCards.set(block.id, card);
    }
  }
  if (!bubble.childNodes.length) bubble.appendChild(el('div', 'md', '(empty message)'));
  transcriptHost().appendChild(root);
  scrollBottom();
}

function makeThinking(text) {
  const d = el('details', 'thinking');
  d.open = SET.autoExpandThinking === true;
  d.appendChild(el('summary', null, 'thinking'));
  const body = el('div', 'th-body', text);
  d.appendChild(body);
  return d;
}

/* Three dots that bob in a wave. Used by the live message header and by the
 * "running" label on a tool card - the text itself deliberately stays still. */
function makeDots(cls) {
  const dots = el('span', cls || 'streaming-dots');
  for (let i = 0; i < 3; i++) dots.appendChild(el('span', 'dot', '.'));
  return dots;
}

/* Put a tool card back into its running state (the label is a bare "running"
 * with the animated dots after it, so only the dots move). */
function setCardRunning(card) {
  if (!card) return;
  const label = card.stateEl.querySelector('.tool-state-label');
  if (label) label.textContent = 'running';
  else card.stateEl.textContent = 'running';
  if (!card.stateEl.querySelector('.streaming-dots')) card.stateEl.appendChild(makeDots());
  card.stateEl.className = 'tool-state running';
}

function makeToolCard(name, opts = {}) {
  const card = el('div', `tool-card${name === 'bash' ? ' bash-card' : ''}`);
  const head = el('div', 'tool-head');
  head.appendChild(el('span', 'tool-name', `${name}`));
  const state = opts.state || 'running';
  // finished cards keep their colour too: the rebuilt-from-history cards used to
  // come back with no state class at all, so a done call lost its green label
  const stateCls = state === 'running' ? ' running' : (state === 'done' || state === 'error' ? ` ${state}` : '');
  const stateEl = el('span', `tool-state${stateCls}`);
  stateEl.appendChild(el('span', 'tool-state-label', state));
  if (state === 'running') stateEl.appendChild(makeDots());
  head.appendChild(stateEl);
  const timerEl = el('span', 'tool-timer hidden');
  head.appendChild(timerEl);
  const body = el('div', 'tool-body hidden');
  head.onclick = () => body.classList.toggle('hidden');
  card.append(head, body);
  return { card, head, body, stateEl, timerEl, _timer: null, _start: 0, _running: false, _timeoutMs: 0 };
}

/* pi's bash tool takes `timeout` in seconds; remember it so the card can count
 * down instead of just counting up. */
function noteToolTimeout(card, args) {
  if (!card || !args || typeof args !== 'object') return;
  const t = args.timeoutSeconds != null ? args.timeoutSeconds
    : (args.timeout_ms != null ? Number(args.timeout_ms) / 1000
      : (args.timeoutMs != null ? Number(args.timeoutMs) / 1000 : args.timeout));
  const secs = Number(t);
  if (Number.isFinite(secs) && secs > 0) card._timeoutMs = secs * 1000;
}

/* Edit-style tool calls (old text -> new text) render as a color diff. */
function editArgsPairs(args) {
  if (!args || typeof args !== 'object') return [];
  const lower = {};
  for (const k of Object.keys(args)) lower[k.toLowerCase()] = args[k];
  const out = [];
  if (Array.isArray(lower.edits)) {
    for (const e of lower.edits) {
      if (!e || typeof e !== 'object') continue;
      const o = e.oldText ?? e.old ?? e.oldStr ?? e.old_string;
      const n = e.newText ?? e.new ?? e.newStr ?? e.new_string;
      if (typeof o === 'string' || typeof n === 'string') out.push([o ?? '', n ?? '']);
    }
    return out;
  }
  let oldV = null, newV = null;
  for (const k of ['oldstr', 'oldtext', 'old_string', 'search', 'find']) {
    if (k in lower && typeof lower[k] === 'string') { oldV = lower[k]; break; }
  }
  for (const k of ['newstr', 'newtext', 'new_string', 'replace']) {
    if (k in lower && typeof lower[k] === 'string') { newV = lower[k]; break; }
  }
  if (oldV != null || newV != null) out.push([oldV ?? '', newV ?? '']);
  return out;
}


function lineDiff(a, b) {
  const A = (a || '').split('\n');
  const B = (b || '').split('\n');
  const N = A.length, M = B.length;
  if (N * M > 400000) {
    return [...A.map((s) => ({ t: 'del', s })), ...B.map((s) => ({ t: 'add', s }))];
  }
  const dp = Array.from({ length: N + 1 }, () => new Uint32Array(M + 1));
  for (let i = N - 1; i >= 0; i--) {
    for (let j = M - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < N && j < M) {
    if (A[i] === B[j]) { out.push({ t: 'same', s: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', s: A[i++] }); }
    else { out.push({ t: 'add', s: B[j++] }); }
  }
  while (i < N) out.push({ t: 'del', s: A[i++] });
  while (j < M) out.push({ t: 'add', s: B[j++] });
  return out;
}

/* Fill a tool card body: diff for edits, pretty JSON otherwise. Diff bodies
 * are shown automatically since the diff is the interesting part. */
function fillToolBody(card, name, args) {
  const filePath = args && typeof args === 'object'
    ? (args.path || args.file || args.file_path || args.filePath || '') : '';
  const lowerArgs = {};
  if (args && typeof args === 'object') for (const k of Object.keys(args)) lowerArgs[k.toLowerCase()] = args[k];
  const pairs = editArgsPairs(args);
  if (pairs.length) {
    card.body.innerHTML = '';
    // Marked so the result step knows a real diff is showing and leaves it
    // alone. A `.diffbox` alone cannot say that: the branch below makes one too,
    // for the arguments, and testing for the class meant a card still holding
    // its arguments never received its result (see the guards in
    // renderToolResult and tool_execution_end).
    card.body.dataset.kind = 'diff';
    const box = el('div', 'diffbox');
    let adds = 0, dels = 0;
    const header = (label, a, d) => {
      const h = el('div', 'diff-file');
      h.appendChild(el('span', null, label));
      const cnt = el('span', 'diff-count');
      const plus = el('span', 'c-add', `+${a}`);
      const minus = el('span', 'c-del', ` −${d}`);
      cnt.append(plus, minus);
      h.appendChild(cnt);
      box.appendChild(h);
    };
    pairs.forEach(([o, nn], idx) => {
      const lines = lineDiff(o, nn);
      const a = lines.filter((l) => l.t === 'add').length;
      const d = lines.filter((l) => l.t === 'del').length;
      adds += a; dels += d;
      header(idx === 0 ? filePath : '…', a, d);
      for (const { t, s } of lines) {
        box.appendChild(el('div', `dl ${t}`, s));
      }
    });
    if (pairs.length > 1) header('total', adds, dels);
    card.body.appendChild(box);
    card.body.classList.remove('hidden');
  } else if (args !== undefined) {
    card.body.innerHTML = '';
    card.body.dataset.kind = 'args';
    const box = el('div', 'diffbox');
    if (filePath) box.appendChild(el('div', 'diff-file', filePath));
    const pre = el('div', 'dl');
    pre.textContent = typeof lowerArgs.content === 'string'
      ? lowerArgs.content
      : JSON.stringify(args, null, 2);
    box.appendChild(pre);
    card.body.appendChild(box);
    card.body.classList.remove('hidden');
  }
}

function renderToolResult(msg) {
  const card = S.toolCards.get(msg.toolCallId);
  if (card) {
    // keep a rendered edit diff — the result line adds nothing to it
    if (card.body.dataset.kind !== 'diff') fillToolResultBody(card.body, msg);
    stopCardTimer(card, msg.isError ? 'error' : 'done');
    card.stateEl.className = `tool-state ${msg.isError ? 'error' : 'done'}`;
    if (!card.body.textContent && !card.body.firstChild) card.body.classList.add('hidden');
  } else {
    const { root, bubble } = makeMsgShell('tool', `${msg.toolName || 'tool'} result · ${timeStr(msg.timestamp)}`);
    const c = makeToolCard(msg.toolName || 'tool', { state: msg.isError ? 'error' : 'done' });
    c.stateEl.className = `tool-state ${msg.isError ? 'error' : 'done'}`;
    fillToolResultBody(c.body, msg);
    c.body.classList.remove('hidden');
    bubble.appendChild(c.card);
    root.querySelector('.who').remove();
    transcriptHost().appendChild(root);
    scrollBottom();
  }
}

/* A picture a tool returned - the agent reading an image puts the whole thing in
 * the session file as a base64 block. It used to be flattened to the text
 * "[image image/png]", which meant the only trace that a picture had been looked
 * at was a placeholder and the picture itself was unreachable from the chat.
 * It is kept here instead, behind a small eye, and clicking it opens it full
 * size (click off it, or Esc, to close - the same viewer a message image uses). */
const EYE_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';

/* Where a picture's bytes are.
 *
 * Two forms reach the chat. A message that is on screen right now comes from
 * pi over RPC, with the picture inline as base64. A message reloaded from the
 * session file comes from /api/session-messages, which *names* the pictures
 * instead of carrying them - the bytes are fetched from the bridge only for the
 * ones actually near the viewport (lazySrc puts the src on within 1200px and
 * takes it off again past 3000px), so opening a session no longer downloads
 * every picture that was ever pasted into it.
 *
 * Both are just a URL as far as the renderer is concerned: an <img src> does not
 * care whether it is a data: URL or an http one, which is the whole reason this
 * could be done without touching the message renderer. */
function imageDataUrl(block) {
  if (!block) return null;
  if (block.src) return String(block.src);          // named by the bridge
  if (!block.data) return null;                     // nothing to show
  if (/^data:/i.test(String(block.data))) return String(block.data);
  return `data:${block.mimeType || 'image/png'};base64,${block.data}`;
}

function imageChip(block) {
  const src = imageDataUrl(block);
  if (!src) return null;
  const kb = block.bytes || Math.max(1, Math.round(String(block.data || '').length * 0.75 / 1024));
  const btn = el('button', 'img-chip');
  btn.type = 'button';
  btn.title = `image · ${block.mimeType || 'unknown type'} · ${kb} KB — click to view it full size`;
  btn.setAttribute('aria-label', 'view this image full size');
  const thumb = el('img', 'img-chip-thumb');
  thumb.alt = '';
  lazySrc(thumb, src);
  const eye = el('span', 'img-chip-eye');
  eye.innerHTML = EYE_SVG;
  btn.append(thumb, eye);
  btn.onclick = (e) => { e.stopPropagation(); zoomImage(src); };
  return btn;
}

/* Fill a tool-result body from a content value: text as text, images as the
 * previews above, in the order they came. */
function fillToolResultBody(box, msg) {
  const c = msg && msg.content !== undefined ? msg.content : undefined;
  box.innerHTML = '';
  // The body holds a result now, not arguments and not a diff, so anything that
  // asks what is in here gets the right answer.
  if (box.dataset) box.dataset.kind = 'result';
  if (c == null) return;
  if (typeof c === 'string') { box.textContent = c; return; }
  if (!Array.isArray(c)) {
    // Unwrap the shapes a result actually arrives in before giving up and
    // printing JSON - see toolResultText. Issue #7: a bash result rendered as
    // `{ "content": [] }` instead of the command's output.
    if (c && typeof c === 'object') {
      if (Array.isArray(c.content)) { fillToolResultBody(box, { content: c.content }); return; }
      for (const k of ['output', 'text', 'stdout', 'result', 'message']) {
        if (typeof c[k] === 'string') { box.textContent = c[k]; return; }
      }
    }
    try { box.textContent = JSON.stringify(c, null, 2); } catch { box.textContent = String(c); }
    return;
  }
  let wrote = false;
  const sep = () => { if (wrote) box.appendChild(el('br')); wrote = true; };
  for (const b of c) {
    if (b && b.type === 'image') {
      const chip = imageChip(b);
      if (chip) { sep(); box.appendChild(chip); }
      continue;
    }
    if (b && b.type === 'text') { sep(); box.appendChild(document.createTextNode(b.text || '')); continue; }
    sep(); box.appendChild(document.createTextNode(JSON.stringify(b)));
  }
}

/* The text of a tool result, whatever shape it arrived in.
 *
 * A result is not always a string or an array of blocks. pi's bash tool answers
 * with an object ({output, exitCode, …}), and a wrapper may carry one under
 * `content`. Falling through to JSON.stringify put a literal
 *
 *     { "content": [] }
 *
 * in the card where the command's output should be - which is what "some bash
 * commands are only displayed as (image)" was (issue #7). The same unwrapping
 * applies to a partial result while a tool is still running. */
function toolResultText(msg) {
  const c = msg && msg.content;
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((b) => {
      if (!b || typeof b !== 'object') return String(b === undefined || b === null ? '' : b);
      if (b.type === 'text') return b.text;
      if (b.type === 'image') return `[image ${b.mimeType || ''}]`;
      return JSON.stringify(b);
    }).join('\n');
  }
  if (typeof c === 'object') {
    if (Array.isArray(c.content)) return toolResultText({ content: c.content });
    for (const k of ['output', 'text', 'stdout', 'result', 'message']) {
      if (typeof c[k] === 'string') return c[k];
    }
  }
  try { return JSON.stringify(c, null, 2); } catch { return String(c); }
}

/* Console/shell output renders as a plain "system" text box. */
function renderBashExecution(msg) {
  const { root, bubble } = makeMsgShell('system', `system · ${timeStr(msg.timestamp)}`);
  root.querySelector('.who').remove();
  bubble.textContent = `$ ${msg.command}\n${msg.output || '(no output)'}`;
  transcriptHost().appendChild(root);
  scrollBottom();
}

/* The compaction summary message (role: "compactionSummary") marks where the old
 * history was compressed into a summary.
 *
 * It is deliberately NOT rendered inline where it sits in the session order:
 * pi rebuilds the context as [compaction summary, kept entries…], so the marker
 * lands at the very TOP of the transcript — hundreds of messages above the
 * viewport. The user saw the live "compacting…" block appear, then vanish, with
 * nothing at the bottom to show for it.
 *
 * Instead the newest compaction is pinned to the END of the chat (right where
 * the live block was), so it is always visible and its summary expandable.
 * Older compactions still render inline so scrolling back stays accurate. */
function renderCompactionSummary(msg, extra) {
  transcriptHost().appendChild(buildCompactionSummary(msg, extra));
}

/* Build the "conversation compacted" marker WITHOUT inserting it, so callers can
 * put it exactly where the compaction happened. */
function buildCompactionSummary(msg, extra) {
  const live = !!(extra && extra.live);
  const root = el('div', 'msg compaction');
  const who = el('div', 'who');
  const before = msg.tokensBefore != null ? `${formatTok(msg.tokensBefore)} tok` : 'context';
  const after = extra && extra.estimatedTokensAfter != null
    ? ` → ${formatTok(extra.estimatedTokensAfter)} tok` : '';
  /* The reason was drawn only by renderCompactionBlock(), the live marker, so
   * even a rebuild in the same page session dropped "· manual" - not just a
   * reload. That is half of issue #47. */
  const reason = extra && extra.reason ? ` · ${extra.reason}` : '';
  who.textContent = `conversation compacted · ${before}${after}${reason}`;
  if (extra && extra.count > 1) {
    const badge = el('span', 'compaction-count', `${extra.count}✕`);
    badge.title = `${extra.count} compactions in this session`;
    who.appendChild(badge);
  }
  const detail = el('details', 'compaction-detail');
  detail.appendChild(el('summary', null, 'show compacted summary'));
  const body = el('div', 'md compaction-body');
  body.innerHTML = renderMarkdown(msg.summary || '');
  detail.appendChild(body);
  root.append(who, detail);
  return root;
}

/* Transcript images are inline data: URLs, and a long session with a few dozen
 * of them used to keep every one of them decoded for the life of the page -
 * hundreds of megabytes. The source waits in a data attribute and the element
 * only gets it while it is near the viewport; far away the bitmap is dropped
 * again, so scrolling back and forth reloads instead of hoarding. */
let mediaNear = null;
let mediaFar = null;
function lazySrc(node, src) {
  if (!node || !src) return node;
  node.dataset.src = src;
  node.decoding = 'async';
  node.setAttribute('loading', 'lazy');
  if (!mediaNear) {
    mediaNear = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const n = e.target;
        const want = n.dataset.src;
        if (!e.isIntersecting || !want) continue;
        if (n.getAttribute('src') !== want) n.setAttribute('src', want);
      }
    }, { rootMargin: '1200px 0px' });
    mediaFar = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const n = e.target;
        if (e.isIntersecting) continue;
        if (n.tagName === 'VIDEO') { try { n.pause(); } catch { } }
        n.removeAttribute('src');
        if (n.tagName === 'VIDEO') { try { n.load(); } catch { } }
      }
    }, { rootMargin: '3000px 0px' });
  }
  mediaNear.observe(node);
  mediaFar.observe(node);
  return node;
}

/* Live "compacting…" marker, shown the moment compaction_start arrives so the
 * user sees compaction happen in real time (with an elapsed timer). Replaced
 * by renderCompactionBlock() when compaction_end arrives. */
function renderCompactionLive(since) {
  const root = el('div', 'msg compaction compacting');
  const who = el('div', 'who');
  const spin = el('span', 'compaction-spin');
  who.appendChild(spin);
  who.appendChild(document.createTextNode(' compacting conversation… '));
  const timer = el('span', 'tool-timer');
  who.appendChild(timer);
  root.appendChild(who);
  transcriptHost().appendChild(root);
  // `since` is the bridge's start time when the block is restored after a reload,
  // so the elapsed time continues instead of starting from zero again.
  let start = Number(since) || Date.now();
  const tick = () => { timer.textContent = fmtElapsed(Date.now() - start); };
  const t = setInterval(tick, 500);
  tick();
  if (S.stickToBottom) scrollBottom();
  return { root, t, setSince: (s2) => { if (Number(s2)) { start = Number(s2); tick(); } } };
}
function removeCompactionLive() {
  if (S.compactionLive) {
    clearInterval(S.compactionLive.t);
    S.compactionLive.root.remove();
    S.compactionLive = null;
  }
}

/* Live compaction marker, rendered the moment compaction_end arrives so the
 * event is visible immediately (the session history only contains the marker
 * after the next full re-render, which happens on agent_settled). */
function renderCompactionBlock(result, reason) {
  removeCompactionLive();
  for (const old of chat.querySelectorAll('.msg.compaction.pinned')) old.remove();
  const root = el('div', 'msg compaction pinned');
  const who = el('div', 'who');
  const before = result.tokensBefore != null ? `${formatTok(result.tokensBefore)} tok` : 'context';
  const after = result.estimatedTokensAfter != null ? ` → ${formatTok(result.estimatedTokensAfter)} tok` : '';
  who.textContent = `conversation compacted · ${before}${after}${reason ? ` · ${reason}` : ''}`;
  const detail = el('details', 'compaction-detail');
  detail.appendChild(el('summary', null, 'show compacted summary'));
  const body = el('div', 'md compaction-body');
  body.innerHTML = renderMarkdown(result.summary || '');
  detail.appendChild(body);
  root.append(who, detail);
  transcriptHost().appendChild(root);
  if (S.stickToBottom) scrollBottom();
}

// Read a session transcript from the bridge (messages + the compaction
// entries, which are not messages and so are absent from get_messages).
/* ── the compaction facts pi does not persist ─────────────────────────
 *
 * The session file's `compaction` entry, and the compactionSummary message pi
 * builds from it, carry the summary, an id, a timestamp and tokensBefore. The
 * post-compaction size and the reason are computed by pi at the moment it
 * compacts, emitted on the compaction_end event, and never written down - so a
 * marker read back from the file could only ever say "conversation compacted ·
 * 833.3K tok", while the same marker when it happened said "... · 833.3K tok →
 * 24.4K tok · manual". That is issue #47, and it is why the type appears to be
 * "lost" on reload rather than mis-set.
 *
 * Both facts are a number and a short word, so they are kept here. The key is a
 * hash of the summary: it is the one field that survives into the file and is
 * unique per compaction. The summary text itself is NOT stored - it is already
 * on disk, it runs to tens of kilobytes, and localStorage is small and shared
 * with the drafts. */
const COMPACT_FACT_MAX = 60;

function summaryHash(s) {
  const str = String(s || '');
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return `${h.toString(36)}.${str.length.toString(36)}`;
}

function compactionFactKey(sessionPath) {
  return `piwebui-compact:${instanceKey()}:${String(sessionPath || 'none').slice(-120)}`;
}

/* Newest first wins, so an old record for the same summary cannot overwrite a
 * newer one. */
function loadCompactionFacts(sessionPath) {
  const out = new Map();
  let rows;
  try { rows = JSON.parse(localStorage.getItem(compactionFactKey(sessionPath)) || '[]'); }
  catch { return out; }
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (!r || typeof r.h !== 'string') continue;
    if (!out.has(r.h)) out.set(r.h, r);
  }
  return out;
}

function saveCompactionFact(sessionPath, mark) {
  if (!mark || !mark.summary) return;
  const key = compactionFactKey(sessionPath);
  let rows;
  try { rows = JSON.parse(localStorage.getItem(key) || '[]'); } catch { rows = []; }
  if (!Array.isArray(rows)) rows = [];
  const h = summaryHash(mark.summary);
  rows = rows.filter((r) => r && r.h !== h);
  rows.unshift({
    h,
    a: mark.estimatedTokensAfter != null ? mark.estimatedTokensAfter : null,
    r: mark.reason || null,
    t: mark.at || Date.now(),
  });
  try { localStorage.setItem(key, JSON.stringify(rows.slice(0, COMPACT_FACT_MAX))); }
  catch { /* quota or private mode: a nicety, not state */ }
}

/* A compaction mark belongs to one session. */
function markSessionPath() { return (S.state && S.state.sessionFile) || ''; }
function markBelongsTo(k, sessionPath) {
  const a = (k && k.session) || '';
  const b = sessionPath || '';
  // An unsaved new session has no path on either side; keep them together
  // rather than losing the marker, and let the summary dedupe handle the rest.
  if (!a || !b) return !a && !b;
  return sameSessionPath(a, b, S.sessionsList || []);
}

/* pi writes timestamps as ISO strings; every comparison below is numeric, and
 * Number("2026-09-20T...") is NaN - which is why every compaction marker landed
 * at the top of the transcript instead of where it happened. */
function tsMs(v) {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}

/* How many messages are built before the transcript render hands the page back
 * for a frame. Small enough that a click is answered quickly, large enough that
 * the yields themselves are not the cost. */
const RENDER_CHUNK = 40;

/* How many of the newest messages are rendered before anything else happens.
 *
 * Measured on the longest real session here - 5441 messages, 21 MB: reading the
 * file costs 214 ms and parsing the JSON another 242 ms, so neither is the
 * problem. Building the DOM is: 155 ms for the newest 200, and 62 seconds for
 * the remaining 5241 - about 12 ms a message, because a real message is markdown
 * plus a thinking block plus tool cards rather than a line of text. No amount of
 * chunking improves that arithmetic; the only thing that helps is not doing it
 * first.
 *
 * So the newest slice goes in immediately - the conversation is readable in about
 * a fifth of a second - and the rest is built above it in the background with
 * the view held, so nothing the reader is looking at moves. Nothing is dropped,
 * nothing is fetched twice, and the whole history is in place by the time anyone
 * scrolls to it. Under this count there is nothing to gain, so it renders in one
 * pass as before. */
const RENDER_NEWEST_FIRST = 250;

/* How many messages go into one batch of the *background* history fill.
 *
 * Smaller than RENDER_CHUNK on purpose. A batch is one uninterrupted block of
 * work, and a real message costs about 12 ms to build, so forty of them is half
 * a second of blocked main thread arriving repeatedly in the seconds after a
 * session opens - a stutter, every batch, while the person is trying to read.
 * Twelve is roughly 150 ms, which is short enough to stay under the threshold
 * where a frame is dropped, and it still fills the history in a couple of
 * seconds. The first pass, which is what the reader is waiting for, keeps the
 * larger chunk so the newest messages land quickly. */
const RENDER_BATCH = 12;

/* Give the browser one frame back. `scheduler.yield()` exists in Chromium and
 * hands the main thread over at a point of the *browser's* choosing (a real
 * priority split, so input wins), which is exactly what a long render wants;
 * everywhere else a frame via rAF is the next best thing. */
function yieldToPage() {
  if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
    return scheduler.yield();
  }
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function fetchSession(sessionPath, signal) {
  const r = await fetch(api(`/api/session-messages?path=${encodeURIComponent(sessionPath)}`), signal ? { signal } : undefined);
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || `failed (${r.status})`);
  return {
    messages: d.messages || [],
    compactions: (d.compactions || []).map((c) => ({
      ...c,
      at: tsMs(c.timestamp),
    })),
  };
}

async function refreshMessages(prefetched) {
  /* Which load owns the transcript. Every load takes a number; a load that is
   * superseded stops at its next yield instead of carrying on and writing over
   * the newer one.
   *
   * Without this, switching sessions quickly was not just slow, it was wrong:
   * the two renders interleaved at their yield points and fought over the same
   * chat element, so the session you asked for lost the race against the one you
   * were leaving, and you had to wait for the old one to finish before the new
   * one could start. */
  const gen = ++S.historyGen;
  const mine = () => gen === S.historyGen;
  // and the request itself is cancelled, so a session you switched away from
  // stops pulling bytes rather than finishing into the void
  if (S.historyAbort) { try { S.historyAbort.abort(); } catch { /* already gone */ } }
  const ac = new AbortController();
  S.historyAbort = ac;
  // A read-only view carries its own entry ids, and a session switch used to
  // block on the fork list before it fetched the transcript at all.
  if (!S.viewSession) ensureForkable();
  else resetForkQueue();
  // Subagent runs belong to the session you are looking at. The bridge answers
  // per session, so switching cannot show another one's jobs - and a reload gets
  // them back from disk instead of an empty panel.
  const subKey = subagentSessionKey();
  if (S.subagentsFor !== subKey) {
    S.subagents = new Map();
    S.subagentsFor = subKey;
    updateSubagentsBtn();
  }
  refreshSubagents(true).catch(() => {});
  let msgs;
  let fileMarks = [];
  // True while what we render is a window into the session rather than all of it
  // (the agent's post-compaction context view, or the newest N messages). A
  // compaction marker older than the oldest message on screen has no place to go
  // in that case - see the marker loop below.
  let partial = false;
  if (S.viewSession) {
    // Viewing another session while the agent runs in its own: read it
    // read-only from the file (the get_messages RPC only knows the agent's
    // own session).
    let d;
    try { d = await fetchSession(S.viewSession, ac.signal); }
    catch (err) { if (isCancelled(err) || !mine()) return; throw err; }
    if (!mine()) return;
    msgs = d.messages;
    fileMarks = d.compactions;  } else {
    /* The agent's own session. Two sources: the session file on disk, and pi's
     * `get_messages`.
     *
     * They used to be taken one after the other - `get_messages` first, and only
     * then the file - which made the slow one the first one. On a 21 MB session
     * pi took **nineteen seconds** to answer, because it has to serialise the
     * whole context before it says anything, and the file read sat behind it the
     * whole time.
     *
     * The file is the better source anyway: it is already on disk, and it is the
     * *more* complete of the two, since `get_messages` returns pi's current
     * context - after a compaction, the summary plus what came after it. So the
     * file is read and drawn from, and pi is not waited for. Asking for it is
     * also actively harmful: it is a many-megabyte reply, pi answers one request
     * at a time, so ask on every switch and they queue - switch three sessions
     * quickly and the fourth click's `get_state` waits behind three abandoned
     * 20 MB replies. That was the "still about a second between sessions" that
     * survived every render fix.
     *
     * pi's view therefore has one job left, and it is a small one: the messages
     * the transcript does not have. Which is either a send from seconds ago that
     * is not written yet (so: only while streaming), or a file that is behind
     * the context pi is holding in memory. In the second case - and in the
     * moment before the agent has a session at all, when the path it reports is
     * the sessions *directory* - there is nothing to draw from disk and pi is
     * the only source, and it may take twenty seconds to answer. So the screen is
     * never emptied and left blank for that long: it keeps whatever real session
     * it was showing, and pi's view is handed to the next load and drawn when it
     * lands. */
    const path = S.state.sessionFile;
    const rpcP = () => rpc({ type: 'get_messages' }).catch(() => null);

    if (adoptedMessages && mine()) {
      // pi's view, handed over by the load that waited for it
      msgs = adoptedMessages;
      adoptedMessages = null;
      partial = true;
    } else {
      const fileP = path
        ? (prefetched && prefetched.path === path ? prefetched.promise : fetchSession(path, ac.signal))
        : null;
      const rpcPromise = (fileP || S.isStreaming) ? rpcP() : null;

      let f = null;
      if (fileP) {
        try { f = await fileP; }
        catch (err) { if (isCancelled(err) || !mine()) return; f = null; }
      }
      if (!mine()) return;

      /* Anything pi holds that the transcript does not, appended rather than
       * waited for, and only if it turns out to be something. */
      const adopt = (d) => {
        if (!d) return;
        const rpcMsgs = asArray(d, 'messages');
        if (!rpcMsgs.length) return;
        const newest = msgs.reduce((acc, m) => Math.max(acc, Date.parse((m && m.timestamp) || '') || 0), 0);
        const pending = rpcMsgs.filter((m) => (Date.parse((m && m.timestamp) || '') || 0) > newest);
        if (!pending.length) return;
        // a newer load took over, a read-only view owns the screen, or a live
        // turn is already drawing the bottom of it
        if (gen !== S.historyGen || S.viewSession || S.isStreaming) return;
        const live = S.live && S.live.root.isConnected ? S.live.root : null;
        transcriptTarget = chat;
        for (const m of pending) drawMessage(m);
        transcriptTarget = null;
        if (live && live.parentNode === chat) chat.appendChild(live);
        markHollowMessages();
        if (!S.userScrolling) pinSoon();
      };

      if (f && f.messages.length) {
        fileMarks = f.compactions;
        msgs = f.messages;
        if (rpcPromise) rpcPromise.then(adopt);
      } else if (path) {
        /* Nothing on disk to draw.
         *
         * Two ways that happens, and they want opposite things.
         *
         * The agent has no session of its own: it reports the sessions
         * *directory*, and pi's view is a slow answer about a context the file
         * describes better. There is nothing to draw and no reason to empty the
         * screen, so it is left alone and pi's answer is handed to the next load.
         *
         * But a session that is simply *new* - the file is there and empty, or
         * has not been written yet - is a different thing entirely. That is the
         * one case where the old conversation has to go: "new session" that
         * leaves the previous transcript on screen looks like it did nothing.
         * So an empty session file is drawn as an empty transcript. */
        if (!isSessionFile(path)) {
          (rpcPromise || rpcP()).then((d) => {
            if (!d || gen !== S.historyGen || S.viewSession) return;
            if (!asArray(d, 'messages').length) return;
            adoptedMessages = asArray(d, 'messages');
            refreshMessages();
          });
          return;   // the screen keeps what it was showing
        }
        msgs = [];
        partial = true;
        rpcP().then(adopt);
      } else {
        // No path at all: pi's view is all there is, and there is nothing to
        // read ahead of it.
        const d = await rpcP();
        if (!mine()) return;
        msgs = asArray(d, 'messages');
        partial = true;
      }
    }
  }
  // Markers we watched happen in this page session, plus the ones already in
  // the file. Deduped by summary text so a watched compaction is not doubled.
  //
  // Only the marks belonging to THIS session, though. The list is the page's
  // memory of compactions it saw, and it was replayed into every session opened
  // afterwards - so session A's "conversation compacted" markers showed up in
  // session B until a reload. That is issue #40, and the reload fixing it is the
  // tell: a fresh page starts the list empty.
  const renderSession = S.viewSession || (S.state && S.state.sessionFile) || '';
  const facts = loadCompactionFacts(renderSession);
  const marks = S.compactionMarks.filter((k) => markBelongsTo(k, renderSession)).map((k) => ({ ...k }));
  const markSeen = new Set(marks.map((k) => k.summary));
  for (const k of fileMarks) if (k.summary && !markSeen.has(k.summary)) marks.push(k);
  // Put back the two facts pi never writes to the file (issue #47).
  for (const k of marks) {
    if (k.estimatedTokensAfter != null && k.reason) continue;
    const f = k.summary ? facts.get(summaryHash(k.summary)) : null;
    if (!f) continue;
    if (k.estimatedTokensAfter == null && f.a != null) k.estimatedTokensAfter = f.a;
    if (!k.reason && f.r) k.reason = f.r;
  }
  for (const m of msgs) {
    if (m && m.timestamp != null && typeof m.timestamp !== 'number') {
      const n = Date.parse(m.timestamp);
      if (Number.isFinite(n)) m.timestamp = n;
    }
  }
  // Keep the reading position (distance from the bottom) across the re-render.
  const distFromBottom = chatScroller().scrollHeight - chatScroller().scrollTop - chatScroller().clientHeight;
  /* Rows drawn from a send that the session file does not have yet.
   *
   * The rebuild below renders from the file, and a message that has just been
   * sent is not in it - pi writes it a moment later. Without this the row was
   * simply destroyed by the innerHTML reset and reappeared only on a reload
   * (issue #1). They are carried across and re-appended after the rebuild, and
   * dropped naturally once the file version is on screen. */
  const pendingLiveRows = [...chat.querySelectorAll('.msg.user[data-live="1"]')];
  releaseVideosIn(chat);
  chat.innerHTML = '';
  if (!S.viewSession) {
    // Only the agent's own session owns the live tool cards; a read-only
    // render of another session must not touch them. Normally this re-render
    // wipes the cards (they are rebuilt from the message content below), but
    // if a live message is in flight its cards must survive: they keep
    // receiving tool_execution_update/end events and are re-attached with
    // S.live below.
    const liveCards = S.live
      ? [...S.toolCards.entries()].filter(([, c]) => S.live.root.contains(c.card))
      : [];
    const liveIds = new Set(liveCards.map(([id]) => id));
    // Cards whose tool is still executing must keep their running state: they
    // are rebuilt from the message below, and this loop used to mark every card
    // that was not part of the live message as "done" - so a long command could
    // show done while it was still running.
    const keepCards = new Map();
    for (const [id, card] of S.toolCards) {
      if (liveIds.has(id)) continue;
      if (card._running) { keepCards.set(id, card); continue; }
      if (card._timer) stopCardTimer(card, 'done');
    }
    S.toolCards.clear();
    for (const [id, card] of liveCards) S.toolCards.set(id, card);
    for (const [id, card] of keepCards) S.toolCards.set(id, card);
    // Keep the live "compacting…" marker through a re-render: a compaction that
    // starts after the turn settled had its marker wiped here, so the status
    // only showed up once it was already over.
    if (S.compacting) {
      if (S.compactionLive) chat.appendChild(S.compactionLive.root);
    } else {
      removeCompactionLive();
    }
  }
  // session token totals summed from per-message usage
  let read = 0;
  let write = 0, prevTs = null;
  /* Every message in the session is rendered, always.
   *
   * This used to keep only the newest 400 and put a "load 812 older messages"
   * button above the rest. That was a bad trade in both directions: clicking the
   * button re-read the entire session file and re-parsed it, so reaching the top
   * of a long conversation cost one full parse per 400 messages, and a session
   * that needed three clicks was parsed three times over. One read, one parse,
   * the whole thing.
   *
   * The reason it was capped in the first place still holds, so it is handled
   * here instead of by throwing messages away: the rows are built in chunks with
   * a yield between them (RENDER_CHUNK), so a long transcript never blocks the
   * page and the composer, the scrollbar and the button keep answering while it
   * goes up. */
  S.historyPartial = !!partial;
  // Render one message the same way whichever end of the session it came from.
  const drawMessage = (m) => {
    const host = S.renderInto || chat;   // an older batch lives away from the chat
    const firstNew = host.children.length;
    if (m.role === 'user') renderUserMessage(m);
    else if (m.role === 'assistant') {
      noteHistoryTiming(m, prevTs);
      renderAssistantMessage(m);
    }
    else if (m.role === 'toolResult') renderToolResult(m);
    else if (m.role === 'bashExecution') renderBashExecution(m);
    else if (m.role === 'compactionSummary') {
      // In place, in order - a compaction marker belongs at the point in the
      // conversation where it happened, and it scrolls away with it. Pinning the
      // newest one to the bottom left a marker permanently on screen.
      // pi's version of this message carries the summary and tokensBefore and
      // nothing else, so the rest is looked up from what we kept (issue #47).
      const f = m.summary ? facts.get(summaryHash(m.summary)) : null;
      renderCompactionSummary(m, f ? { estimatedTokensAfter: f.a, reason: f.r } : undefined);
    }
    // Stamp whatever node(s) this message produced, so a compaction marker can
    // be anchored to a point in time instead of a shifting position.
    if (m.timestamp != null) {
      for (let k = firstNew; k < host.children.length; k++) host.children[k].dataset.ts = String(m.timestamp);
      prevTs = m.timestamp;
    }
    // Totals count every message, rendered or not.
    if (m.usage) {
      read += (m.usage.input || 0) + (m.usage.cacheRead || 0) + (m.usage.cacheWrite || 0);
      write += m.usage.output || 0;
    }
  };

  /* Newest first, then the history above it.
   *
   * Everything rendered in one pass means waiting for the whole conversation
   * before the newest message is readable - and on a long session that is a
   * minute of watching the transcript grow from the top down. So for anything
   * bigger than RENDER_NEWEST_FIRST, the newest slice is drawn into the chat
   * straight away, the view is put at the bottom (which is where a conversation
   * is read from), and the remaining history is built *above* it in the
   * background.
   *
   * "Above" is one insert per batch, not per message: the batch is built in a
   * detached element and moved in as a whole. That element is
   * `display: contents`, so its children lay out exactly as if they had been
   * appended to the chat directly - no wrapper, no CSS change, no second layout
   * pass. */
  const newestFirst = msgs.length > RENDER_NEWEST_FIRST;
  const anchor = newestFirst ? document.createComment('older history follows') : null;
  if (anchor) chat.appendChild(anchor);
  transcriptTarget = chat;   // this rebuild is for the transcript on screen
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (newestFirst && i < msgs.length - RENDER_NEWEST_FIRST) continue;   // drawn later, above
    drawMessage(m);
    // Hand the page back for one frame every RENDER_CHUNK messages. Without
    // this a long session is one uninterrupted block of work and the tab stops
    // answering to anything at all.
    if ((i + 1) % RENDER_CHUNK === 0 && i + 1 < msgs.length) {
      transcriptTarget = null;
      await yieldToPage();
      // A newer load took over while this one was yielding: stop touching the
      // chat. Everything below this point writes to the DOM.
      if (!mine()) return;
      if (!S.userScrolling) scrollBottom(true);
      transcriptTarget = chat;   // a live turn took over
    }
  }
  transcriptTarget = null;
  if (newestFirst) {
    // readable now; the rest is on its way in above
    if (!S.userScrolling) scrollBottom(true);
    await yieldToPage();
    if (!mine()) return;
    // The history, oldest last, in batches of RENDER_BATCH: one build off-screen
    // and one move into place per batch. (The first version of this counted the
    // messages it had built *cumulatively* and compared that to the batch size,
    // so only the very first batch was ever drawn - the transcript came out 173
    // messages long instead of 5441 and looked complete.)
    // Each batch is *older* than the one before it, so it has to go on top of it,
    // not at the anchor: inserting at the anchor stacks them newest-first at the
    // top of the history and leaves the oldest sitting next to the newest slice,
    // which is the whole transcript in blocks of forty, upside down.
    let historyTop = null;
    let from = msgs.length - RENDER_NEWEST_FIRST;
    while (from > 0) {
      const batch = document.createElement('div');
      batch.className = 'older-batch';
      S.renderInto = batch;
      transcriptTarget = batch;
      const start = Math.max(0, from - RENDER_BATCH);
      // ascending, and that matters: a tool result arrives *after* the assistant
      // message carrying its tool call, and a result rendered first finds no card
      // to update and builds one of its own - so the tool cards were doubled.
      // Batches are what get stacked in the other direction, not messages
      // within a batch.
      for (let k = start; k < from; k++) drawMessage(msgs[k]);
      from = start;
      S.renderInto = null;
      transcriptTarget = null;
      if (batch.firstChild) {
        chat.insertBefore(batch, historyTop || anchor);
        historyTop = batch;
      } else batch.remove();
      /* Keep the bottom pinned as the history arrives.
       *
       * The batches go in *above* what is already on screen, so the conversation
       * grows upward and the newest message - the one being read - should not
       * move. But a batch added above makes the content taller, and without
       * re-pinning the reader is left looking at the same part of the document
       * while it grows beneath them: the transcript appears to fill in from the
       * top downwards, which is the wrong way round for a conversation and reads
       * as the page still loading. A reader who has deliberately scrolled up is
       * left alone. */
      if (!S.userScrolling) scrollBottom(true);
      await yieldToPage();
      if (!mine()) return;
    }
    if (anchor.parentNode) anchor.remove();
    /* Pin once more now that the history is complete.
     *
     * The last batch goes in above and a frame later `restoreReading` runs and
     * can leave the view a little short of the bottom - twenty-odd pixels of
     * "still loading" sitting under the newest message after everything has
     * arrived. This is the point at which the session is, in fact, loaded. */
    if (!S.userScrolling) scrollBottom(true);
  }
  // Put the message that is being streamed right now back: it is not in the
  // session file yet, so the rebuild above could not have rendered it, and it
  // used to be dropped from the DOM - the streamed text disappeared until the
  // turn ended and it came back as a finished message.
  if (S.live && !S.live.root.isConnected && !S.viewSession && !S.liveDetached) {
    chat.appendChild(S.live.root);
    pinSoon();
  }
  markHollowMessages();
  // A rebuild (a reload, a compaction re-read, a resize) must not move the reader.
  // restoreReading() itself decides, from what was recorded, whether they were
  // following the bottom - a fresh page has no idea, so the guard cannot live here.
  requestAnimationFrame(() => restoreReading(5));
  // A compaction marker sits at the end of the transcript, so typing or a new
  // answer never pushes it out of sight.
  if (!S.viewSession) {
    // A compaction we watched happen is re-placed at the point it happened,
    // anchored by timestamp. Its entry is in the session file too once the turn
    // is saved, and that copy is rendered in order above, so skip those.
    const inFile = new Set(msgs.filter((m) => m.role === 'compactionSummary' && m.summary).map((m) => m.summary));
    const plain = [...chat.querySelectorAll('.msg:not(.compaction)')];
    for (const k of marks) {
      if (k.summary && inFile.has(k.summary)) continue;
      const at = tsMs(k.at);
      let target = null;
      let firstTs = 0;
      for (const n of plain) {
        const ts = Number(n.dataset.ts) || 0;
        if (!firstTs && ts) firstTs = ts;
        if (ts && at && ts <= at) target = n;
      }
      const node = buildCompactionSummary(k, { count: marks.length, reason: k.reason });
      // Before the first rendered message only if it really is older than it;
      // otherwise it belongs after the newest content, not at the top.
      if (target) target.after(node);
      else if (at && firstTs && at < firstTs) {
        // Older than everything on screen. That is only "at the top" when the
        // whole session is rendered: while a window is shown, the messages this
        // marker belongs between are not loaded, and pinning it to the first row
        // put every old compaction on the ceiling. Leave it out; loading the
        // older messages brings it back in its real place.
        if (!S.historyPartial) plain[0].before(node);
      } else chat.appendChild(node);
    }
    // A compaction still in flight keeps its "compacting…" indicator: the
    // re-render above wiped the DOM node it lived in.
    if (S.compacting && !S.compactionLive) S.compactionLive = renderCompactionLive();
  }
  // Totals are high-water marks: a compaction removes the older messages from
  // the session file, and recomputing the sum from what is left made the read /
  // write counters drop right after a compaction. They only reset when you
  // switch to another session.
  const base = S.sessionTotals && S.sessionTotals.path === S.state.sessionFile ? S.sessionTotals : null;
  const totals = {
    path: S.state.sessionFile,
    read: Math.max(read, (base && base.read) || 0),
    write: Math.max(write, (base && base.write) || 0),
  };
  S.sessionTotals = totals;
  S.totals = { read: totals.read, write: totals.write };
  updateTotals();
  // The last turn's total belongs on the last message: bring it back after a
  // re-render (a settle, a reload, a session re-read). A reload has no memory of
  // it, so it is read back from the per-session store first.
  if (!S.lastTurn && !S.viewSession) {
    const kept = loadSessionUi();
    if (kept && kept.lastTurn && kept.lastTurn.ms) S.lastTurn = kept.lastTurn;
  }
  if (S.lastTurn && S.lastTurn.ms) {
    const bubbles = chat.querySelectorAll('.msg.assistant .bubble');
    const b = bubbles.length ? bubbles[bubbles.length - 1] : null;
    if (b) {
      b.querySelectorAll('.turn-timer').forEach((n) => n.remove());
      b.appendChild(el('div', 'turn-timer', `turn took ${fmtElapsed(S.lastTurn.ms)}`));
    }
  }
  // Re-wire fork indexes for user messages in order.
  const userEls = [...chat.querySelectorAll('.msg.user')];
  userEls.forEach((e, i) => e.dataset.forkIdx = String(i));
  // Fork ids belong to rows by position on the active branch, not by matching
  // message text - two turns with the same wording got each other's id, so a
  // fork was taken from the wrong turn. Re-stamp after every render.
  stampForkIds().catch(() => {});
  // Back on the agent's own session mid-stream: re-attach the in-flight live
  // message (it was parked in S.liveDetached while viewing elsewhere). Only
  // when the agent is still in the session the live view belongs to.
  if (!S.viewSession && S.liveDetached && S.live && S.liveDetached.path === S.state.sessionFile) {
    chat.appendChild(S.liveDetached.frag);
  }
  S.liveDetached = null;
  /* Put back any message that was sent but is not in the file yet.
   *
   * Matched on the bubble's text against what the rebuild drew, so a row
   * disappears as soon as the file carries the same message - and until then it
   * stays on screen, through any number of rebuilds, rather than being lost the
   * moment something re-read the session (issue #1). */
  if (pendingLiveRows.length) {
    const shown = new Set([...chat.querySelectorAll('.msg.user .bubble')].map((b) => b.textContent));
    for (const row of pendingLiveRows) {
      const bubble = row.querySelector('.bubble');
      if (shown.has(bubble ? bubble.textContent : '')) continue;   // the file has it now
      chat.appendChild(row);
    }
  }
  if (S.stickToBottom) scrollBottom(true);
  else chatScroller().scrollTop = chatScroller().scrollHeight - chatScroller().clientHeight - distFromBottom;
  S.historyRender++;
  updateJumpTop();
}

/* A load that was cancelled is not a failure.
 *
 * Superseding a load aborts its fetch, and that surfaces as an AbortError thrown
 * out of refreshMessages - into whoever was awaiting it (switchToSession, the
 * /reload routine, a compaction) and, when nobody was, onto the page as an
 * unhandled rejection with a scary-looking message. It means "you asked for
 * something else", which is not something to report, so it is swallowed here and
 * only real errors are re-thrown. */
function isCancelled(e) {
  return !!e && (e.name === 'AbortError' || /aborted/i.test(String(e.message || '')));
}

/* Is this something a transcript can actually be read from?
 *
 * pi reports the sessions *directory* as the current session when it has not
 * opened one yet, and asking the bridge for a "session file" at that path quietly
 * returns no messages at all - which is how a page loaded a second after the
 * agent started sat blank for twenty seconds, waiting on the slow fallback for
 * messages it could have had immediately. */
function isSessionFile(p) {
  return !!p && /\.jsonl$/i.test(String(p));
}

/* pi's view of the agent's session, handed from one load to the next.
 *
 * `get_messages` is a slow answer about a context the session file usually
 * describes better, so it is only asked for when the file has nothing - and
 * then it can take twenty seconds. Rather than empty the transcript and leave it
 * blank for that long, the load that asked hands the answer here and returns,
 * leaving the screen as it was; the load it starts picks this up and draws it. */
let adoptedMessages = null;

/* Full-size view of an image. The old version reused the drag-and-drop overlay,
 * which is pointer-events: none, so it could never be closed. */
function zoomImage(src) {
  const ov = el('div', 'img-zoom');
  const img = el('img');
  img.src = src;
  const close = el('button', 'img-zoom-close', '✕');
  close.title = 'Close (Esc)';
  close.onclick = (e) => { e.stopPropagation(); ov.remove(); };
  ov.append(img, close);
  ov.onclick = (e) => { if (e.target !== img) ov.remove(); };
  const onKey = (e) => {
    if (!document.body.contains(ov)) { document.removeEventListener('keydown', onKey); return; }
    if (e.key === 'Escape') { ov.remove(); document.removeEventListener('keydown', onKey); }
  };
  document.addEventListener('keydown', onKey);
  document.body.appendChild(ov);
}

/* ───────────────────────── event stream ───────────────────────── */

function handleEvent(msg) {
  switch (msg.type) {
    case 'session_info_changed': {
      // pi emits this when a session is (re)named — keep the topbar in sync and
      // refresh the sidebar so a rename shows up there immediately.
      const name = (msg.name || '').trim();
      if (name) {
        const input = $('session-name');
        input.value = name;
        input.title = `${name} — click to rename`;
      }
      refreshSessions(true).catch(() => {});
      break;
    }
    case 'agent_start':
      S.ctxTurnPeak = 0;
      S.isStreaming = true;
      // a new turn: nothing about the last one is finalised yet, so turn_end will
      // have to check the session if the message never arrived
      S.turnFinalised = false;
      // The turn clock starts here (and covers thinking, tool calls and waiting).
      // It used to be set in a second `case 'agent_start'` label further down -
      // dead code, because the first matching case wins, so every turn was
      // measured as 0.0s.
      S.turnStartTs = Date.now();
      ensureTick();
      updateStreamUi();
      autoOpenShortsIfEnabled();
      break;
    case 'agent_end':
      /* This is the real agent_end arm.
       *
       * The work below used to sit inside `case 'agent_settled':` behind
       * `if (msg.type === 'agent_end')`, which can never be true - `msg.type` is
       * 'agent_settled' throughout that branch - so none of it ever ran: the turn
       * was never finalised here, extension commands registered mid-session were
       * never picked up, the fork list was never refreshed, and the sidebar was
       * not updated at the end of a turn (only by the 20 s idle poll, which skips
       * while streaming and while the tab is hidden). */
      finalizeLive();
      refreshCommands().catch(() => {});   // extensions may register commands late
      refreshStats().catch(() => {});
      ensureForkable();
      refreshSessions().catch(() => {});
      break;
    case 'agent_settled':
      if (msg.type === 'agent_settled') {
        // Only a turn that was actually running gets the chime - agent_settled
        // also arrives for bookkeeping with nothing to report.
        if (S.isStreaming) notifyTurnDone();
        S.isStreaming = false;
        autoCloseShortsIfOurs();
        // The turn total is stamped after the transcript has been finalised
        // below: stamping it here put the number into a bubble that finalizeLive()
        // then replaced, so the total never showed up.
        S.turnPendingStamp = true;
        // The turn is in the session file now: (re)attach fork ids to the rows.
        stampForkIds().catch(() => {});
        // After a compaction the session history no longer matches the chat
        // DOM (older messages were summarized away and the "compacted" marker
        // is missing) — re-render from the session so the marker shows up.
        if (S.compactionHappened) {
          S.compactionHappened = false;
          refreshMessages().catch(() => {});
        }
        // Threshold/manual compactions stop the agent; keep the task going.
        // Threshold/manual compactions stop the agent; keep the task going. When
        // that happens the task clock keeps running - the task is not finished.
        const autoContinues = S.compactionNeedsContinue && SET.autoContinueAfterCompaction !== false;
        if (S.compactionNeedsContinue) {
          S.compactionNeedsContinue = false;
          maybeAutoContinue();
        }
        if (!autoContinues) finishRunClock(lastAssistantTs());
      }
      updateStreamUi();
      // "Now that the transcript is settled…" used to follow here, wrapped in
      // `if (msg.type === 'agent_end')` - dead, because this arm only ever sees
      // 'agent_settled'. It lives in the real agent_end arm above.
      // Now that the transcript is settled, write the total time the turn took
      // (and put the compaction marker back at the end of the list).
      if (S.turnPendingStamp) {
        S.turnPendingStamp = false;
        setTimeout(stampTurnTimer, 0);
      }
      // A compaction that never reported back would otherwise leave the status
      // bar saying "compacting…" for the rest of the session.
      if (S.compacting) {
        S.compacting = false;
        removeCompactionLive();
        clearCompactLabelSoon();
      }
      // Send the next message the user queued during compaction, now that the
      // agent is idle (agent_settled). No-op when the queue is empty.
      flushCompactionQueue();
      break;
    case 'message_start':
      // A turn that begins with a tool call may not fire agent_start in some
      // versions; make sure the clock is running either way.
      if (!S.turnStartTs) S.turnStartTs = Date.now();
      /* Only the assistant's message has a live shell to stream into.
       *
       * pi emits message_start for the user's own message as well, and opening a
       * shell for it drew an empty assistant message that the matching
       * message_end then had to tear down - and that teardown was the rebuild
       * that lost the message you had just sent (issue #1). */
      if (!msg.message || msg.message.role === 'assistant') startLive();
      break;
    case 'message_update':
      if (msg.usage && S.live) S.live.lastUsage = msg.usage;
      applyDelta(msg.assistantMessageEvent || {});
      break;
    case 'message_end':
      /* Only the assistant's message_end finishes anything.
       *
       * pi sends message_end for the user's own message too, and it arrives
       * first - when the turn has only just started, so `turnFinalised` is still
       * false and finalizeLive() fell through to refreshMessages(). That
       * rebuilds the whole transcript from the session file, and in a new chat
       * the file has not been written yet, so the optimistic bubble sendPrompt()
       * had just drawn was wiped and nothing put it back: the message you sent
       * disappeared until the page was reloaded, which read the file. Reproduced
       * every time (issue #1). */
      if (msg.message && msg.message.role && msg.message.role !== 'assistant') break;
      finalizeLive(msg.message);
      break;
    case 'turn_end':
      finalizeLive();
      break;
    case 'tool_execution_start':
      startToolCard(msg);
      if (SUBAGENT_TOOLS.has(String(msg.toolName || ''))) {
        noteSubagent({
          id: msg.toolCallId || `fg-${Date.now()}`,
          label: (msg.args && (msg.args.agent || msg.args.label || msg.args.name)) || 'subagent',
          state: 'running',
          startedAt: Date.now(),
          background: false,
        });
      }
      break;
    case 'tool_execution_update': {
      const c = S.toolCards.get(msg.toolCallId);
      if (c && msg.partialResult !== undefined) {
        /* A partial with nothing in it must not blank the card (issue #37).
         *
         * This assigned unconditionally, so the first progress event whose
         * payload rendered to an empty string wiped the body and un-hid it -
         * leaving a running command as an empty strip for its whole life, which
         * for a bash call means minutes of looking at nothing. Several shapes pi
         * sends render to empty (`''`, `[]`, `{content: []}`, `{output: ''}`),
         * so this was not a rare edge.
         *
         * Ignoring the empty ones leaves what the card already had - the
         * arguments, which for bash is the command being run. That is the useful
         * thing to show while there is no output yet. */
        const text = toolResultText({ content: msg.partialResult });
        if (text.trim()) {
          c.body.textContent = text;
          if (c.body.dataset) c.body.dataset.kind = 'output';
          c.body.classList.remove('hidden');
        }
      }
      // Foreground subagents report progress inside the tool result details:
      // status, current tool, turns, tools. That is the live feed for them.
      if (SUBAGENT_TOOLS.has(String(msg.toolName || ''))) {
        const det = (msg.partialResult && msg.partialResult.details) || msg.details || {};
        for (const r of det.results || []) {
          const p2 = r.progress || {};
          noteSubagent({
            id: r.runId || r.id || msg.toolCallId || 'fg',
            label: r.label || r.agent || p2.agent || 'subagent',
            state: p2.status || 'running',
            currentTool: p2.currentTool || null,
            turnCount: p2.turnCount || 0,
            toolCount: p2.toolCount || 0,
            startedAt: (S.subagents.get(String(r.runId || r.id || msg.toolCallId || 'fg')) || {}).startedAt || Date.now(),
            background: false,
          });
        }
      }
      break;
    }
    case 'tool_execution_end': {
      if (SUBAGENT_TOOLS.has(String(msg.toolName || ''))) {
        const det = (msg.result && msg.result.details) || msg.details || {};
        const kids = (det.results || []).map((r) => ({
          id: r.runId || r.id || msg.toolCallId,
          label: r.label || r.agent || 'subagent',
          state: r.status === 'ok' || r.ok === true ? 'done' : (r.status || (r.error ? 'failed' : 'done')),
          output: typeof r.content === 'string' ? r.content : (r.output || ''),
          background: false,
        })).filter((r) => r.id);
        if (kids.length) for (const k of kids) noteSubagent(k);
        else noteSubagent({ id: msg.toolCallId || 'fg', state: msg.isError ? 'failed' : 'done' });
      }
      const c = S.toolCards.get(msg.toolCallId);
      if (c) {
        // the same renderer as history, so a picture the agent reads *during* a
        // turn gets its preview too, not just the ones reloaded from a file
        if (msg.result !== undefined && c.body.dataset.kind !== 'diff') fillToolResultBody(c.body, { content: msg.result });
        stopCardTimer(c, msg.isError ? 'error' : 'done');
        c.stateEl.className = `tool-state ${msg.isError ? 'error' : 'done'}`;
      }
      break;
    }
    case 'bash_execution_update': {
      const c = S.bashCards.get(msg.id);
      if (c) { c.body.textContent += msg.delta || ''; c.body.classList.remove('hidden'); scrollBottom(); }
      break;
    }
    case 'queue_update':
      S.queue = { steering: msg.steering || [], followUp: msg.followUp || [] };
      renderQueue();
      break;
    case 'extension_error':
      toast(`Extension error: ${msg.error}`, 'error');
      break;
    case 'auto_retry_start':
      toast(`Retrying (${msg.attempt}/${msg.maxAttempts}) in ${Math.round((msg.delayMs || 0) / 1000)}s: ${msg.errorMessage}`, 'warning');
      break;
    case 'compaction_start':
      S.compacting = true;
      toast('Compacting session…');
      // The pre-compaction token count is now stale; show a dash until the
      // next LLM response reports a real post-compaction context size.
      setCtxRing(null);
      // ...and drop the high-water marks with it, or the peak from before the
      // compaction outlives the context it measured and clamps the next number
      // back up to itself (issue #48).
      resetCtxHighWater();
      if ($('ctx-label')) $('ctx-label').textContent = ctxLabel('compacting…', '–');
      // Live "compacting…" block with an elapsed timer, removed on compaction_end.
      if (!S.compactionLive) S.compactionLive = renderCompactionLive();
      break;
    case 'compaction_end': {
      // Declared out here: these used to be consts inside the `else if (msg.result)`
      // block and read after it, so this handler threw a ReferenceError before it
      // could refresh - leaving "compacting…" in the status bar forever and the
      // compacted-to size nowhere.
      let before = null;
      let after = null;
      S.compacting = false;
      if (msg.aborted) {
        removeCompactionLive();
        clearCompactLabelSoon();
        toast('Compaction cancelled', 'warning');
      } else if (msg.errorMessage) {
        removeCompactionLive();
        clearCompactLabelSoon();
        toast(msg.errorMessage, 'error');
      } else if (msg.result) {
        before = msg.result.tokensBefore;
        after = msg.result.estimatedTokensAfter;
        toast(`Compacted: ${before != null ? formatTok(before) : '?'} → ${after != null ? formatTok(after) : '?'} tokens`);
        S.lastCompaction = msg.result;
        // Remember it so refreshMessages() can put the marker back where it
        // happened instead of re-appending it to the bottom every turn.
        if (!S.compactionMarks.some((k) => k.summary === msg.result.summary)) {
          const mark = { ...msg.result, reason: msg.reason || null, at: Date.now(), session: markSessionPath() };
          S.compactionMarks.push(mark);
          // estimatedTokensAfter and reason exist only on this event. pi computes
          // them at the moment it compacts and writes neither to the session file,
          // so they are kept aside for the reload (issue #47).
          saveCompactionFact(mark.session, mark);
        }
        renderCompactionBlock(msg.result, msg.reason);
        S.compactionHappened = true;
        // willRetry=true (overflow) → pi retries the prompt itself. A manual
        // /compact never auto-continues (the user asked for it, task was done).
        // Only auto-compactions (threshold/overflow without retry) need a nudge.
        /* Only worth continuing if the compaction actually made room.
         *
         * A compaction that barely shrank the context overflows again on the very
         * next request, so continuing straight into it is how the loop feeds
         * itself - and pi's own guard against that (one compact-and-retry per
         * turn) is reset by every new user message, which is exactly what the
         * continue below sends. */
        const useful = before == null || after == null || after < before * 0.9;
        if (!msg.willRetry && msg.reason !== 'manual') S.compactionNeedsContinue = useful;
      } else {
        removeCompactionLive();
      }
      // Context is unknown to pi right after compaction (it reports tokens:null
      // until the next response), which left the ring showing a dash until the
      // session was switched. Show the estimated size the compaction itself
      // reported, then keep asking until pi has a real number.
      if (after != null) showCompactionEstimate(after);
      clearCompactLabelSoon();
      refreshStats().catch(() => {});
      scheduleStatsRetry();
      flushCompactionQueue();
      break;
    }
    default:
      break;
  }
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

function startLive() {
  const { root, tools, bubble } = makeMsgShell('assistant streaming', '…');
  addCopyButton(tools, () => S.live ? S.live.text : '');
  addSpeakButton(tools, () => stripMarkdown(S.live ? S.live.text : ''));
  // Copy/speak only make sense once the message is final — keep the buttons
  // hidden while streaming. finalizeLive() replaces this shell with the
  // rendered message, where they are visible again.
  tools.classList.add('pending');
  const md = el('div', 'md');
  bubble.appendChild(md);
  const statsEl = el('span', 'agent-stats');
  root.querySelector('.who').insertBefore(statsEl, tools);
  // The "..." dots bob up and down in a wave (each dot delayed) while the
  // agent generates/reads.
  const dots = el('span', 'streaming-dots');
  for (let i = 0; i < 3; i++) dots.appendChild(el('span', 'dot', '.'));
  root.querySelector('.who-text').replaceChildren(document.createTextNode(' · '), dots);
  const stopTurnTimer = startTurnTimer();
  // While another session is on screen the live message stays out of it: new
  // turns used to be appended to whatever transcript was open, so the agent
  // appeared to write into the session you were reading.
  transcriptHost().appendChild(root);
  S.live = { root, md, text: '', thinking: '', thinkingEl: null, caret: el('span', 'streaming-caret'),
    stopTurnTimer,
    toolByIndex: new Map(),   // contentIndex -> tool card while a call is streaming
    toolArgChars: new Map(),  // contentIndex -> argument characters streamed so far
    // incremental paint state: text already committed to stableEl, and the two
    // elements the message is split across (see paintLive)
    paintedUpTo: 0, stableEl: null, tailEl: null,
             startTs: Date.now(), lastUsage: null, statsEl };
  scrollBottom();
}

function applyDelta(ev) {
  if (!S.live) startLive();
  const L = S.live;
  if (ev.type === 'text_delta') { if (!L.firstDeltaTs) L.firstDeltaTs = Date.now(); L.text += ev.delta || ''; }
  else if (ev.type === 'text_start') { /* noop */ }
  else if (ev.type === 'text_end') { /* noop */ }
  else if (ev.type === 'thinking_delta') { if (!L.firstDeltaTs) L.firstDeltaTs = Date.now(); L.thinking += ev.delta || ''; }
  else if (ev.type === 'toolcall_start') {
    // pi streams tool calls keyed by contentIndex and only sends {type,
    // contentIndex} at the start — the id, name and arguments arrive with the
    // deltas/end (assistantMessageEvent.partial is stripped by the RPC layer).
    // Track the card by contentIndex so it can appear and grow while the model
    // is still writing the call, instead of popping in fully formed.
    if (L.toolByIndex.has(ev.contentIndex)) {
      // duplicate start for the same block — keep the card we already have
    } else {
      const card = makeToolCard(ev.toolName || 'tool', { toolCallId: ev.id || `stream-${ev.contentIndex}` });
      card.toolName = ev.toolName || '';
      card._rawArgs = '';
      card._contentIndex = ev.contentIndex;
      L.root.querySelector('.bubble').appendChild(card.card);
      startCardTimer(card);
      L.toolByIndex.set(ev.contentIndex, card);
      if (ev.id) S.toolCards.set(ev.id, card);
      pinSoon();   // a new card above the caret — keep following
    }
  }
  else if (ev.type === 'toolcall_delta') {
    // Stream the arguments as they are written (a `write` shows the file, a
    // `bash` shows the command) — this is the "tool call being generated".
    const c = (ev.contentIndex != null && L.toolByIndex.get(ev.contentIndex)) || (ev.id && S.toolCards.get(ev.id));
    if (c) {
      c._rawArgs = (c._rawArgs || '') + (ev.delta || ev.argumentsDelta || ev.partial || ev.partialArgs || '');
      const named = toolNameFromJson(c._rawArgs);
      if (named && named !== c.toolName) {
        c.toolName = named;
        c.card.querySelector('.tool-name').textContent = named;
      }
      c.body.classList.remove('hidden');
      c.body.textContent = liveToolPreview(c.toolName, c._rawArgs);
      if (!L.toolArgChars) L.toolArgChars = new Map();
      L.toolArgChars.set(ev.contentIndex, c._rawArgs.length);
      scrollBottom();
    }
  }
  else if (ev.type === 'toolcall_end' && ev.toolCall) {
    const byIndex = ev.contentIndex != null ? L.toolByIndex.get(ev.contentIndex) : null;
    const existing = byIndex || S.toolCards.get(ev.toolCall.id);
    if (existing) {
      // Reuse the card created by toolcall_start (it already has the live
      // preview and the elapsed timer) instead of appending a duplicate.
      existing.toolName = ev.toolCall.name;
      existing.card.querySelector('.tool-name').textContent = ev.toolCall.name;
      noteToolTimeout(existing, ev.toolCall.arguments);
      if (existing._running && existing._timeoutMs) restartCardTimer(existing);
      fillToolBody(existing, ev.toolCall.name, ev.toolCall.arguments);
      // Re-key to the real tool-call id so the tool_execution_* events (which
      // are keyed by it) find this card.
      if (existing._contentIndex != null) L.toolByIndex.delete(existing._contentIndex);
      existing.toolCallId = ev.toolCall.id;
      S.toolCards.set(ev.toolCall.id, existing);
    } else {
      const card = makeToolCard(ev.toolCall.name, { toolCallId: ev.toolCall.id });
      fillToolBody(card, ev.toolCall.name, ev.toolCall.arguments);
      L.root.querySelector('.bubble').appendChild(card.card);
      S.toolCards.set(ev.toolCall.id, card);
    }
  }
  renderLive();
}

/* The streamed argument JSON sometimes carries the tool name (providers differ);
 * pull it out early so the card can be labelled while it is still being written. */
function toolNameFromJson(raw) {
  const m = /"(?:name|tool|toolName|tool_name)"\s*:\s*"([A-Za-z0-9_.-]{1,40})"/.exec(raw || '');
  return m ? m[1] : null;
}

/* Live preview while a tool call's arguments stream in: for write-like tools
 * show the decoded file content so far, otherwise the raw partial arguments. */
function liveToolPreview(name, raw) {
  if (/write|edit/i.test(name || '')) {
    const m = raw.match(/"content"\s*:\s*"((?:\\.|[^"\\])*)/);
    if (m) {
      return m[1]
        .replace(/\\n/g, '\n').replace(/\\t/g, '\t')
        .replace(/\\"/g, '"').replace(/\\\\/g, '\\')
        .slice(-4000);
    }
  }
  return raw.slice(-2000);
}

/* How often the streaming view is repainted while tokens arrive.
 *
 * This used to be "every animation frame". Each repaint re-parses the whole
 * message so far (renderMarkdown walks every line and every inline span), throws
 * the result away into innerHTML, and then reads scrollHeight to pin the bottom
 * - a forced synchronous layout at the end of every pass. Providers deliver
 * deltas far faster than 60/s, so for most of a turn that meant parsing the same
 * text two or three times to produce a frame nobody could tell apart from the
 * one before it, while the tab was pinned at 100% CPU.
 *
 * 12/s is above the rate at which a change of words is legible, and it turns a
 * long turn into a fraction of the work. The last pass is never skipped (see
 * the settle path), so the finished message is always rendered exactly. */
const LIVE_PAINT_MS = 80;

let liveRaf = null;
let liveTimer = null;
let liveLastPaint = 0;
function renderLive(force) {
  if (!S.live) return;
  // A paint is already on its way. A forced one (the turn settling) takes the
  // frame that is already queued rather than adding a second one - that frame
  // is about to run and will paint everything there is.
  if (liveRaf) return;
  if (force) {
    if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
    liveRaf = requestAnimationFrame(() => { liveRaf = null; paintLive(); });
    return;
  }
  if (liveTimer) return;                  // the tail of this window is already armed
  const since = Date.now() - liveLastPaint;
  if (since >= LIVE_PAINT_MS) {
    liveRaf = requestAnimationFrame(() => { liveRaf = null; paintLive(); });
    return;
  }
  // Too soon. Wake up exactly when the window opens instead of dropping the
  // update - otherwise the last tokens before the provider pauses would not show
  // up until something unrelated triggered a repaint.
  liveTimer = setTimeout(() => {
    liveTimer = null;
    if (!S.live) return;
    liveRaf = requestAnimationFrame(() => { liveRaf = null; paintLive(); });
  }, Math.max(1, LIVE_PAINT_MS - since));
}

/* The last place in the streamed text that is safe to split markdown at.
 *
 * A blank line, as long as it is not inside a fenced code block: a fence that
 * opens before a split and closes after it would be parsed as two different
 * things on either side, so the two halves would not add up to the whole. */
function markdownSplitPoint(text) {
  let cut = -1;
  let fences = 0;
  for (let i = 0; i < text.length - 1; i++) {
    if (text.charCodeAt(i) === 96 && text.charCodeAt(i + 1) === 96 && text.charCodeAt(i + 2) === 96) {
      fences++;
      i += 2;
      continue;
    }
    if (text.charCodeAt(i) === 10 && text.charCodeAt(i + 1) === 10 && fences % 2 === 0) cut = i + 2;
  }
  return cut;
}

function paintLive() {
  if (!S.live) return;
  if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
  liveLastPaint = Date.now();
  const L = S.live;
  if (L.thinking && !L.thinkingEl) {
    L.thinkingEl = makeThinking('');
    L.md.before(L.thinkingEl);
    pinSoon();   // the block is inserted above the caret — follow it
  }
  if (L.thinkingEl) L.thinkingEl.querySelector('.th-body').textContent = L.thinking;
  /* Only the part that changed is re-rendered.
   *
   * `L.md.innerHTML = renderMarkdown(L.text)` re-parsed and re-laid-out the whole
   * message on every paint. Measured in the browser at 12 paints a second, on a
   * message of the size a long answer reaches:
   *
   *     7 280 chars   1.72 ms per paint    2% of a core
   *    29 120 chars   6.54 ms per paint    8%
   *   116 480 chars  27.52 ms per paint   33%, and over a 16.7 ms frame
   *
   * (that is ~24x the markdown parse itself, which is why making the parser
   * faster was never the answer - the cost is the DOM replacement.)
   *
   * So the message is kept in two pieces: everything up to the last safe block
   * boundary, which is *appended* to as the boundary advances and never re-parsed,
   * and the unfinished tail, which is the only thing re-rendered each paint. The
   * work per paint is proportional to what has arrived since the last boundary
   * rather than to the length of the message. */
  if (L.text) {
    const cut = markdownSplitPoint(L.text);
    if (cut > L.paintedUpTo) {
      if (!L.stableEl) {
        L.stableEl = el('div', 'md-stable');
        L.md.appendChild(L.stableEl);
      }
      // beforeend: parses the new segment only, leaves what is already there alone
      L.stableEl.insertAdjacentHTML('beforeend', renderMarkdown(L.text.slice(L.paintedUpTo, cut)));
      L.paintedUpTo = cut;
    }
    if (!L.tailEl) {
      L.tailEl = el('div', 'md-tail');
      L.md.appendChild(L.tailEl);
    }
    L.tailEl.innerHTML = renderMarkdown(L.text.slice(L.paintedUpTo));
  } else {
    L.md.replaceChildren(el('span', 'streaming-caret'));
  }
  // live token counter, updated as tokens stream in. Until the provider
  // reports usage, estimate written tokens from streamed characters.
  const sec = (Date.now() - L.startTs) / 1000;
  const prefill = L.firstDeltaTs ? (L.firstDeltaTs - L.startTs) / 1000 : null;
  let stats;
  if (L.lastUsage) {
    stats = usageStats(L.lastUsage, sec, prefill);
  } else {
    stats = estStatsText(estWriteTokens(L), sec);
  }
  if (stats) L.statsEl.textContent = ` (${stats})`;
  // Live context ring: pi's last authoritative count + the in-flight message,
  // estimated the same way pi itself does (chars/4).
  liveCtxRing(liveExtraTokens());
  scrollBottom();
}

/* Estimate the tokens the in-flight message will add, using the ratio the
 * session has actually shown (pi itself falls back to chars/4). */
function liveExtraTokens() {
  const L = S.live;
  if (!L) return 0;
  let chars = L.text.length + L.thinking.length;
  if (L.toolArgChars) for (const n of L.toolArgChars.values()) chars += n;
  const ratio = S.tokPerChar || 0.25;
  return Math.round(chars * ratio);
}

function finalizeLive(finalMsg) {
  if (S.live) {
    const L = S.live;
    // The streaming view is painted at a fixed rate, so the last few tokens may
    // still be sitting in the buffer. One last synchronous pass before the live
    // node is torn down: whatever the reader was owed, they have seen.
    if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
    paintLive();
    if (L.stopTurnTimer) L.stopTurnTimer();
    const elapsedSec = (Date.now() - L.startTs) / 1000;
    const prefillSec = L.firstDeltaTs ? (L.firstDeltaTs - L.startTs) / 1000 : null;
    S.live.root.remove();
    S.live = null;
    if (S.liveDetached) {
      // Viewing another session: the final message is already in the session
      // file, so the read-only render will show it. Drop the live state; the
      // agent session's totals refresh when the user switches back.
    } else if (finalMsg && finalMsg.role === 'assistant') {
      const usage = finalMsg.usage || L.lastUsage;
      if (usage) {
        S.totals.read += (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
        S.totals.write += usage.output || 0;
        noteTokenRatio(usage, messageChars(finalMsg));
      }
      const timed = usage && !finalMsg.usage ? { ...finalMsg, usage } : finalMsg;
      // No usage from the provider (some endpoints never send it): keep the
      // estimated counter that was on screen while streaming, so the token rate
      // does not simply vanish when the turn ends.
      const timing = { elapsedSec, prefillSec };
      if (!usage) timing.est = estWriteTokens(L);
      rememberTiming(timed, timing);
      renderAssistantMessage(timed, timing);
      updateTotals();
      // this turn is now in the DOM and correct. turn_end arrives afterwards with
      // no message, and must not go and re-read the session to prove it.
      S.turnFinalised = true;
      if (S.autoTts) {
        const text = (finalMsg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
        if (text.trim()) speak(stripMarkdown(text));
      }
    } else {
      // No final message this time. Only worth re-reading the whole transcript
      // if the turn was never actually finalised - otherwise this ran at the end
      // of every single turn and re-read the entire session file, rebuilding the
      // whole conversation from the oldest message upwards, which on a long
      // session is the "it jumps up then slowly comes down" you were seeing.
      if (!S.turnFinalised) refreshMessages().catch(() => {});
    }
  }
  // Do NOT clear S.isStreaming here. finalizeLive() runs on every message_end
  // and turn_end -- including the user's own message -- and clearing it there
  // hid the Stop button the instant the first message ended, and made
  // sendPrompt() omit streamingBehavior, so pi rejected mid-turn sends instead
  // of steering them. The turn is only over at agent_settled (or agent_exit /
  // socket close).
  updateStreamUi();
}

function startToolCard(msg) {
  const existing = msg.toolCallId && S.toolCards.get(msg.toolCallId);
  if (existing) {
    // already created by a streaming toolcall_start — just fill in the name
    if (msg.toolName && !existing.toolName) {
      existing.toolName = msg.toolName;
      existing.card.querySelector('.tool-name').textContent = msg.toolName;
    }
    // It may have been rendered as "done" by the message finalise above; the
    // execution is starting right now, so put the running label back.
    setCardRunning(existing);
    noteToolTimeout(existing, msg.args);
    // With a timeout known, count down from the moment the command starts.
    if (existing._timeoutMs) restartCardTimer(existing);
    else startCardTimer(existing);
    return existing;
  }
  const card = makeToolCard(msg.toolName || msg.name || 'tool', { toolCallId: msg.toolCallId });
  card.toolName = msg.toolName || msg.name || '';
  card._rawArgs = '';
  noteToolTimeout(card, msg.args);
  fillToolBody(card, card.toolName, msg.args);
  startCardTimer(card);
  const parent = S.live ? S.live.root.querySelector('.bubble') : chat;
  parent.appendChild(card.card);
  S.toolCards.set(msg.toolCallId, card);
  scrollBottom();
  pinSoon();
  return card;
}

/* The ring right after a compaction: pi has no number yet, so show the estimate
 * the compaction reported instead of a dash. */
function showCompactionEstimate(tokens) {
  /* The window has to come from S.ctxWindow, and that is half of this fix.
   *
   * Every way into a compaction calls setCtxRing(null) first - compaction_start,
   * and the /compact command handler - which nulls S.ctxStats. So the old lookup
   * (S.ctxStats.contextWindow) was always null by the time this ran, the function
   * returned without drawing anything, and the size the compaction itself
   * reported was never shown. What stayed on screen was the ring's empty "–" or
   * the number from before the compaction, which is issue #48: "right after
   * compaction the counter stays the same".
   *
   * The other half is the high-water marks, which have to go with the context they
   * describe (see resetCtxHighWater). Without that, the peak from before the
   * compaction is read as a floor and this estimate is pushed back up to it.
   *
   * The previous second fallback, S.state.contextWindow, is not set anywhere in
   * this file and never was, so it is gone rather than left looking like a net. */
  const win = (S.ctxStats && S.ctxStats.contextWindow) || S.ctxWindow || null;
  if (!win) return;
  resetCtxHighWater();
  setCtxRing({ tokens, contextWindow: win, percent: Math.max(0, Math.min(100, (tokens / win) * 100)) });
}

/* pi only knows the new context size once it has answered something again, so
 * check a few times instead of leaving the estimate on screen forever. */
function scheduleStatsRetry() {
  [3000, 8000, 20000].forEach((ms) => setTimeout(() => { refreshStats().catch(() => {}); }, ms));
}

/* Put a real number back in the status bar in case the "compacting…" state is
 * left over (a compaction that was cancelled, failed, or whose end event never
 * arrived). Anything the ring has already shown is left alone. */
function clearCompactLabelSoon() {
  setTimeout(() => {
    const label = $('ctx-label');
    if (!label || label.textContent !== ctxLabel('compacting…', '–')) return;
    label.textContent = ctxLabel('–', '–');
    refreshStats().catch(() => {});
  }, 250);
}

function updateStreamUi() {
  // The Stop button appears next to the (always visible) Send button while the
  // agent is generating, so you can stop generation or steer/queue a message.
  $('btn-stop').classList.toggle('hidden', !S.isStreaming);
  // While a run is going, the widget and status lines above the composer keep
  // their space even when an extension clears them for a moment. Setting and
  // clearing a status (an MCP server connecting, the sub-agent widget updating)
  // resized the dock, which moved the composer and the stats row with it - the
  // stack is anchored now, and the space is given back when the run ends.
  document.body.classList.toggle('run-active', !!S.isStreaming);
  setConn(S.isStreaming ? 'busy' : 'on');
  // Reset the ring's high-water mark on every streaming transition so the
  // final authoritative total can settle (even if the estimate overshot), and
  // remember where this turn started so the live number can be anchored to it.
  if (S.isStreaming && S.ctxBaseTokens == null) {
    S.ctxBaseTokens = (S.ctxStats && S.ctxStats.tokens) || 0;
  }
  S.ctxDisplayTokens = null;
  if (S.isStreaming) startCtxPoll(); else { stopCtxPoll(); S.ctxBaseTokens = null; }
  renderQueue();
  updateLiveDot();
  updateViewBanner();
}

// Banner shown while the user is viewing a session other than the agent's own.
function updateViewBanner() {
  const b = $('view-banner');
  if (!b) return;
  if (!S.viewSession) {
    b.classList.add('hidden');
    b.textContent = '';
    return;
  }
  // Reading a subagent's own session: name it, say it is read-only, and keep the
  // way back to the conversation it belongs to right here.
  if (S.viewSubagent) {
    const r = S.viewSubagent;
    const parent = S.state.sessionFile;
    const p = (S.sessionsList || []).find((x) => sameSessionPath(x.path, parent, S.sessionsList || []));
    const pname = (p && p.name) || (parent ? parent.split(/[\\/]/).pop().replace(/\.jsonl$/, '') : 'the main session');
    b.classList.remove('hidden');
    b.textContent = `Subagent “${r.label || 'subagent'}” — its own session, read-only`
      + (isLiveRun(r) ? ' (still running, this follows along)' : '')
      + `. Back to “${pname}”. `;
    const back = el('button', 'btn small', 'back to the conversation');
    back.onclick = () => backFromSubagent();
    b.appendChild(back);
    return;
  }
  const base = S.viewSession.split(/[\\/]/).pop();
  const s = (S.sessionsList || []).find((x) => sameSessionPath(x.path, S.viewSession, S.sessionsList || []));
  const name = (s && s.name) || base.replace(/\.jsonl$/, '');
  b.classList.remove('hidden');
  b.textContent = S.isStreaming
    ? `Viewing “${name}” — the agent is still running in its own session (green dot in the list) and keeps going in the background. `
    : `Viewing “${name}” — read-only. The agent is in its own session; click it in the list to switch back. `;
  const btn = el('button', 'btn small', 'switch back');
  btn.onclick = () => switchToSession(S.state.sessionFile);
  b.appendChild(btn);
}

/* Keep the green "live" dot in the session list in sync with streaming state
 * immediately. A full refreshSessions only runs on session changes or while
 * idle, so without this the dot would appear late or not at all mid-stream
 * (it used to only show up after a page reload). */
function updateLiveDot() {
  const list = $('session-list');
  if (!list) return;
  /* The green dot marks the session the AGENT is running in, which is not always
   * the row that is highlighted: switching away during a turn highlights the row
   * you are reading and leaves the agent in its own session.
   *
   * This used to walk only the `.active` rows, toggle the dot on those, and never
   * take it off a row that was no longer active. So each switch during a run left
   * another green dot behind, and the session actually doing the work lost its
   * own - issue #41, "both sessions indicate that it is active, stacks with each
   * session change if the agent makes a new turn". Walking every row and deciding
   * from S.state.sessionFile fixes both halves, and matches what a full
   * renderSessions() rebuild already computes (`selfLive = isCurrent &&
   * S.isStreaming`) - which is why refreshing used to clear them. */
  const runsIn = (S.state && S.state.sessionFile) || '';
  const sessions = S.sessionsList || [];
  for (const item of list.querySelectorAll('.session-item')) {
    const live = !!S.isStreaming && !!runsIn && sameSessionPath(item.dataset.path || '', runsIn, sessions);
    item.classList.toggle('live', live);
    const nameRow = item.querySelector('.s-name');
    if (!nameRow) continue;
    const dot = nameRow.querySelector('.live-dot');
    if (live && !dot) nameRow.prepend(el('span', 'live-dot', ''));
    else if (!live && dot) dot.remove();
  }
}

/* Live context ring: while the agent is streaming, poll session stats so the
 * ring and the [used/max]ctx label track context growth in real time instead
 * of only updating when switching sessions. */
let ctxPollTimer = null;
function startCtxPoll() {
  if (ctxPollTimer) return;
  refreshStats().catch(() => {});
  ctxPollTimer = setInterval(() => {
    if (S.isStreaming) refreshStats().catch(() => {}); else stopCtxPoll();
  }, 1000);
}
function stopCtxPoll() {
  if (ctxPollTimer) { clearInterval(ctxPollTimer); ctxPollTimer = null; }
}

/* While compaction is running the agent rejects new prompts, so messages the
 * user typed are held here and sent (one at a time) once the agent is idle
 * again. flushCompactionQueue() is called on compaction_end and agent_end. */
function flushCompactionQueue() {
  if (!S.compactionQueue.length) return;
  if (S.isStreaming || S.compacting) return; // wait until the agent is idle
  const next = S.compactionQueue.shift();
  startRunClock();   // a queued message from the user is a new task
  sendPrompt(next.text, next.images, undefined, true);
  // The next agent_end/agent_settled will flush the rest of the queue.
}

/* pi only auto-retries after an *overflow* compaction. After a *threshold*
 * (or manual) compaction it stops and waits for the next user message — even
 * when the task is clearly not done. Nudge it along automatically (once per
 * cooldown) so long tasks keep going. */
/* How many compactions in a row may pull the task along by themselves before this
 * gives up and says so. Reset by the next message the user sends. */
const AUTO_CONTINUE_MAX = 3;

function maybeAutoContinue() {
  if (SET.autoContinueAfterCompaction === false) return;
  if (S.isStreaming || S.compacting) return;
  const now = Date.now();
  if (now - S.lastAutoContinueAt < 120000) return; // don't chain-continue forever
  /* "Don't chain-continue forever" is what the line above says, and it is not
   * what it does: the cooldown bounds how OFTEN the loop turns, not whether it
   * ends. If the context is still over the window after a compaction, the next
   * request overflows, pi compacts again, this continues again - every two
   * minutes, indefinitely. That is issue #38's "infinite cycle of context
   * overflow ... it compacts every time even after compaction". pi caps its own
   * recovery (one compact-and-retry per turn, _overflowRecoveryAttempted) and
   * re-arms it on every new user message; a machine that keeps sending user
   * messages keeps re-arming it. So the count is capped here as well, where the
   * messages actually come from. */
  if (S.autoContinueStreak >= AUTO_CONTINUE_MAX) {
    toast(`Compaction has been needed ${S.autoContinueStreak} times in a row — stopping the automatic continuation. Send a message to carry on.`, 'warning');
    return;
  }
  S.lastAutoContinueAt = now;
  S.autoContinueStreak++;
  toast('Compaction done — continuing the task…', 'info');
  // Deliberately not startRunClock(): this continues the task the user already
  // started, so its clock keeps running (compaction time included).
  sendPrompt('Context was just compacted into a summary. Continue the current task from where it left off — use the compaction summary and the recent messages, and keep working until the task is complete.');
}

/* ── the bars above the composer ─────────────────────────────────────────
 * Extensions set and clear their status/widget while the agent works, and a
 * widget is often cleared for a single frame between updates. Hiding and showing
 * the bar with it changed the height of the composer dock, which resized the
 * transcript area - so the whole conversation moved up and down with every
 * update. That is what "the UI jumps while the agent is running" was.
 *
 * A bar that goes empty now keeps its place for a moment (the next update is
 * usually on its way), and CSS gives it a stable height while it is up. */
const BAR_HIDE_MS = 3000;
const barHideTimers = new Map();

function setBarContent(bar, text) {
  if (!bar) return;
  const key = bar.id || 'bar';
  const pending = barHideTimers.get(key);
  if (pending) { clearTimeout(pending); barHideTimers.delete(key); }
  if (String(text || '').trim()) {
    bar.textContent = text;
    // Remember that this bar has been used at some point during this run. Only
    // such a bar keeps its height while it is momentarily empty (see the
    // data-had-content rules in the stylesheet) - a bar that never appeared
    // would otherwise reserve a block of blank dock for the whole run, which is
    // issue #6.
    bar.dataset.hadContent = '1';
    bar.classList.remove('hidden');
    return;
  }
  barHideTimers.set(key, setTimeout(() => {
    barHideTimers.delete(key);
    // Only if nothing arrived in the meantime (an extension can re-set it).
    if (!String(bar.textContent || '').trim()) {
      bar.textContent = '';
      bar.classList.add('hidden');
    }
  }, BAR_HIDE_MS));
}

function renderQueue() {
  const bar = $('queue-bar');
  const items = [...S.queue.steering.map((m) => ({ kind: 'steering', m })), ...S.queue.followUp.map((m) => ({ kind: 'after turn', m }))];
  if (!items.length) { setBarContent(bar, ''); bar.innerHTML = ''; return; }
  bar.dataset.hadContent = '1';   // see setBarContent: only a used bar keeps its height
  bar.classList.remove('hidden');
  bar.innerHTML = '';
  bar.appendChild(el('span', null, 'queued '));
  for (const { kind, m } of items) {
    const text = (typeof m === 'string' ? m : JSON.stringify(m || '')).slice(0, 120);
    const chip = el('span', 'queue-chip', `${kind}: ${text}`);
    bar.appendChild(chip);
  }
}

/* ───────────────────────── composer / sending ───────────────────────── */

const input = $('input');

function autoSize() {
  // Empty composer: back to a single line. Without this the box kept the height
  // of whatever had been typed last, leaving a tall empty frame over the chat.
  input.style.height = 'auto';
  input.style.height = input.value.trim() ? Math.min(input.scrollHeight, 200) + 'px' : '';
  syncComposerText();
  // The chat shrinks as the box grows; without this the transcript shifted up
  // and the last thing written (a compaction marker, a tool call) slid out of
  // view while typing.
  if (S.stickToBottom) pinSoon();
}
let draftSaveTimer = null;
function saveDraftSoon() {
  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => { draftSaveTimer = null; saveDraft(); }, 400);
}
input.addEventListener('input', () => { autoSize(); updateSlashMenu(); saveDraftSoon(); });
// The composer is sized to its content, so it has to be re-measured when the
// layout width changes (font size setting, window resize, phone rotation).
let resizeReadingTimer = null;
window.addEventListener('resize', () => {
  autoSize();
  if (!window.matchMedia('(max-width: 760px)').matches) $('sidebar').classList.remove('open');
  // A reflow moves the scroll position with it (the transcript's height changes).
  // Put the reader back where they were - twice, because the dock's own height
  // settles a frame later.
  if (!S.stickToBottom) {
    if (resizeReadingTimer) clearTimeout(resizeReadingTimer);
    restoreReading(1);
    resizeReadingTimer = setTimeout(() => { resizeReadingTimer = null; restoreReading(1); }, 250);
  }
  // A reflow can leave the view somewhere in the middle of a long transcript, and
  // the message being streamed (which lives in the DOM, not in the session file)
  // has to stay where it is. If we were following the bottom, come back to it.
  if (S.live && !S.live.root.isConnected && !S.viewSession && !S.liveDetached) chat.appendChild(S.live.root);
  if (S.stickToBottom) pinSoon();
});
// On a phone the sidebar is a drawer: tapping the conversation closes it.
chat.addEventListener('click', () => {
  if (window.matchMedia('(max-width: 760px)').matches) $('sidebar').classList.remove('open');
});

async function sendCurrent() {
  const text = input.value.trim();
  if (S.editMode) {
    if (!text) return;
    finishEdit(text);
    return;
  }
  if (!text && !S.attachments.length) return;

  if (text.startsWith('!') && text.length > 1) {
    sendBash(text.slice(1).trim());
    resetComposer();
    return;
  }

  // Prompts go to the agent's own session — never to the one being viewed.
  // (!bash above is session-independent and stays allowed.)
  if (S.viewSession && !text.startsWith('/')) {
    toast(S.isStreaming
      ? 'The agent is running in another session — click it in the list (green dot) to switch back before sending'
      : 'You are viewing another session — switch back before sending');
    return;
  }

  // While compaction is in flight the agent rejects new prompts. Hold the
  // message locally and send it once compaction finishes — don't lose it.
  if (S.compacting && !text.startsWith('/')) {
    S.compactionQueue.push({ text, images: S.attachments.slice() });
    toast(`Compaction in progress — queued your message (will send when it's done)`, 'info');
    resetComposer();
    return;
  }

  // What actually goes to the agent: a skill typed by its short name gets its
  // "skill:" prefix back here (and only here).
  let sendText = text;

  if (text.startsWith('/')) {
    const sp = text.indexOf(' ');
    let name = (sp >= 0 ? text.slice(1, sp) : text.slice(1)).toLowerCase();
    const arg = sp >= 0 ? text.slice(sp + 1).trim() : '';
    sendText = skillAwareCommand(text);
    if (sendText !== text) name = sendText.slice(1, sendText.indexOf(' ') > 0 ? sendText.indexOf(' ') : undefined).toLowerCase();

    /* Anything this command reports opens the notifications panel (issue #5),
     * with one exception: /compact. Its outcome is already drawn inline as the
     * "conversation compacted" marker and toasted, so throwing the panel open on
     * top of that is noise rather than a service - issue #44. The flag is cleared
     * again in the finally, so a later background notice cannot open it by
     * accident. */
    S.noticesFromCommand = name !== 'compact';
    try {

    // Client-local slash commands: executed by the UI, never sent to the agent.
    if (name === 'tts') { setAutoTts(!S.autoTts); resetComposer(); return; }
    if (name === 'autosend') {
      SET.voiceAutoSend = !SET.voiceAutoSend;
      saveSettings();
      toast(`Voice auto-send ${SET.voiceAutoSend ? 'ON — voice results send automatically' : 'OFF'}`);
      resetComposer();
      return;
    }
    if (name === 'thinking' && !arg) {
      // /thinking (no arg) toggles thinking-block visibility. /thinking <level>
      // (with an arg) falls through to the built-in set-thinking-level command.
      SET.showThinking = !(SET.showThinking !== false);
      saveSettings();
      toast(`Thinking blocks ${SET.showThinking !== false ? 'visible' : 'hidden'}`);
      resetComposer();
      return;
    }

    // Built-in pi commands that map to a direct RPC call (e.g. /compact, /new).
    let handled = false;
    try {
      handled = await handleBuiltinCommand(name, arg);
    } catch (e) {
      toast(`Command failed: ${e.message}`, 'error');
      return;
    }
    if (handled) {
      resetComposer();
      return;
    }

    // Only warn for commands not in any known list (local, agent, or pi built-in).
    const known = allCommands().find((c) => c.name.toLowerCase() === name || c.name.toLowerCase() === `skill:${name}`);
    if (!known) {
      toast(`"/${name}" is not a registered agent or UI command — sending to the model as text`, 'warning');
    }

    } finally {
      S.noticesFromCommand = false;
    }
  }

  startRunClock();
  // A real message from the user restarts the budget of automatic continuations.
  S.autoContinueStreak = 0;
  sendPrompt(sendText, S.attachments.slice(), undefined, true);
  resetComposer();
}

/* Built-in pi slash commands that have a direct RPC equivalent. Returns true
 * if the command was handled by the UI (don't send to the agent); false means
 * "send it to the agent as a normal prompt". Commands without a clean RPC
 * mapping (e.g. /tree, /settings, /fork) fall through to the agent. */
async function handleBuiltinCommand(name, arg) {
  // Agent-registered commands (extension/prompt/skill) take precedence over a
  // built-in with the same name — those are sent to the agent instead.
  if (S.commands.some((c) => c.name.toLowerCase() === name || c.name.toLowerCase() === `skill:${name}`)) {
    return false;
  }
  switch (name) {
    case 'compact': {
      if (S.compacting) { toast('Compaction already in progress…', 'warning'); return true; }
      S.compacting = true;
      toast('Compacting session…');
      setCtxRing(null);
      resetCtxHighWater();
      if ($('ctx-label')) $('ctx-label').textContent = ctxLabel('compacting…', '–');
      // Compaction makes an LLM call and can take minutes — the old 120s RPC
      // timeout fired first and reported a false failure while the agent kept
      // compacting. Don't block on the response; track progress via the
      // compaction_start / compaction_end events. The RPC promise is only a
      // backup for the case where those events never arrive.
      rpc({ type: 'compact' }, 10 * 60 * 1000)
        .catch((e) => {
          if (S.compacting) {
            S.compacting = false;
            toast(`Compact failed: ${e.message}`, 'error');
          }
        });
      return true;
    }
    case 'new': {
      try { await rpc({ type: 'new_session' }); await initSession(false); }
      catch (e) { toast(`New session failed: ${e.message}`, 'error'); }
      return true;
    }
    case 'name': {
      if (!arg) { toast('Usage: /name <name>'); return true; }
      try { await rpc({ type: 'set_session_name', name: arg }); await refreshSessions(true); }
      catch (e) { toast(`Rename failed: ${e.message}`, 'error'); }
      return true;
    }
    case 'model': {
      const slash = arg.indexOf('/');
      if (slash <= 0) { toast('Usage: /model <provider/model>'); return true; }
      try {
        await rpc({ type: 'set_model', provider: arg.slice(0, slash), modelId: arg.slice(slash + 1) });
        const st = await rpc({ type: 'get_state' }); applyState(st);
      } catch (e) { toast(`Set model failed: ${e.message}`, 'error'); }
      return true;
    }
    case 'thinking': {
      if (!arg) { toast('Usage: /thinking <level>'); return true; }
      try {
        await rpc({ type: 'set_thinking_level', level: arg.split(/\s+/)[0] });
        const st = await rpc({ type: 'get_state' }); applyState(st);
      } catch (e) { toast(`Set thinking failed: ${e.message}`, 'error'); }
      return true;
    }
    case 'clone': {
      try { await rpc({ type: 'clone' }); await refreshSessions(true); }
      catch (e) { toast(`Clone failed: ${e.message}`, 'error'); }
      return true;
    }
    case 'reload': {
      // Same routine as the Settings button: the agent is restarted (which is
      // what re-reads extensions, skills, prompts, keybindings and themes) and
      // the session is resumed afterwards, so nothing is lost.
      await reloadPi();
      return true;
    }
    case 'copy': {
      try {
        const d = await rpc({ type: 'get_last_assistant_text' });
        if (d && d.text) { await navigator.clipboard.writeText(d.text); toast('Copied last assistant message'); }
        else toast('No assistant message to copy', 'warning');
      } catch (e) { toast(`Copy failed: ${e.message}`, 'error'); }
      return true;
    }
    case 'session': {
      await refreshStats();
      try {
        const d = await rpc({ type: 'get_session_stats' });
        const cu = d && d.contextUsage;
        const toks = cu && cu.tokens != null ? `${Math.round(cu.tokens)}/${Math.round(cu.contextWindow)}` : '–';
        const cost = d && d.cost && d.cost.total != null ? `$${Number(d.cost.total).toFixed(3)}` : '–';
        toast(`Session: ${S.sessionName || '(unnamed)'} · context ${toks} · cost ${cost}`);
      } catch { /* ignore */ }
      return true;
    }
    default:
      return false; // not handled here — send to the agent as a prompt
  }
}

function sendPrompt(text, images, behavior, fromComposer) {
  const all = images || [];
  const imgs = all.filter((a) => a.type === 'image');
  const files = all.filter((a) => a.type === 'file');
  // Non-image attachments travel as path references in the prompt text so the
  // agent can open them with its tools (read, bash, etc.). Audio also carries
  // its transcript inline.
  let msg = text || '';
  if (files.length) {
    const refs = files.map((f) => {
      let line = `[Attached ${f.kind}: ${f.name} → ${f.path}]`;
      if (f.kind === 'audio' && f.transcript) line += `\nTranscript: ${f.transcript}`;
      else if (f.kind === 'audio') line += ' (no transcript available)';
      return line;
    }).join('\n');
    msg = (msg ? msg + '\n\n' : '') + refs;
  }
  const cmd = { type: 'prompt', message: msg };
  if (imgs.length) {
    cmd.images = imgs.map((a) => ({ type: 'image', data: a.data, mimeType: a.mimeType }));
  }
  if (S.isStreaming) cmd.streamingBehavior = behavior || 'steer';
  /* The bubble is drawn at once, and kept only if the agent actually took the
   * message.
   *
   * It used to be drawn unconditionally and left in the DOM whatever happened.
   * Sending while the agent is busy with a compaction is the case that bites: pi
   * rejects the prompt, a toast says so, and the row stays on screen looking
   * delivered - until the next rebuild drops it, because it is not in the session
   * file. That is issue #49, "after a manual compaction my message disappeared ...
   * and after a reload I can see that it never even happened".
   *
   * Now the row is removed and the text goes back into the composer, so a message
   * that was not sent is visibly not sent and cannot be lost. */
  let row = null;
  if (text || all.length) {
    const content = [];
    for (const a of imgs) content.push({ type: 'image', data: a.data, mimeType: a.mimeType });
    if (msg) content.push({ type: 'text', text: msg });
    row = renderUserMessage({ role: 'user', content: content.length ? content : msg, timestamp: Date.now(), __live: true });
    S.stickToBottom = true;
    scrollBottom(true);
  }
  rpc(cmd).catch((e) => {
    if (row && row.isConnected) row.remove();
    if (fromComposer) restoreComposer(text, all);
    toast(fromComposer ? `${e.message} — your message is back in the box` : e.message, 'error');
  });
}

/* Send a bash command and stream its output into the card it belongs to.
 *
 * The id has to exist BEFORE the request goes out, because it is the key the
 * card is filed under. It used to be read off the object before `rpc()` had
 * assigned it:
 *
 *     const cmd = { type: 'bash', command };
 *     S.bashCards.set(cmd.id, { body: out });   // cmd.id is undefined
 *     const d = await rpc(cmd);                  // rpc assigns cmd.id only now
 *     S.bashCards.delete(cmd.id);                // the real id - never a key
 *
 * so the card was stored under `undefined` and every `bash_execution_update`
 * (which carries the real request id) missed it - the output only ever appeared
 * at the end, and one `undefined` entry leaked per command. The id is now
 * allocated here, so both the store and the lookup see the same value, and the
 * delete happens whatever the request does. */
async function sendBash(command) {
  const { root, bubble } = makeMsgShell('system', `system · ${timeStr()}`);
  root.querySelector('.who').remove();
  const out = el('div', null, `$ ${command}\n`);
  bubble.appendChild(out);
  transcriptHost().appendChild(root);
  scrollBottom(true);
  const id = `req-${++S.reqId}`;
  try {
    S.bashCards.set(id, { body: out });
    const d = await rpc({ type: 'bash', command, id });
    out.textContent = `$ ${command}\n${(d && d.output) || '(no output)'}`;
    if (d && d.exitCode) toast(`Command exited with code ${d.exitCode}`, 'warning');
  } catch (e) {
    out.textContent += `\n[error] ${e.message}`;
  } finally {
    S.bashCards.delete(id);
  }
}

/* ── the composer's draft ────────────────────────────────────────────────
 * What you have typed but not sent is worth keeping: the UI reloads itself after
 * some webview hiccups, and a reload used to take the text and the attachments
 * with it. Kept per session (and per instance), so switching sessions does not
 * move a draft from one conversation to another. Switching *instances* still
 * starts clean - that changes everything else too. */
function draftKey() {
  const p = S.viewSession || (S.state && S.state.sessionFile) || 'none';
  return `piwebui-draft:${instanceKey()}:${String(p).slice(-120)}`;
}

function saveDraft() {
  const key = draftKey();
  const text = (typeof input !== 'undefined' && input.value) ? input.value : '';
  try {
    if (!text && !(S.attachments || []).length) { localStorage.removeItem(key); return; }
    const attachments = (S.attachments || []).map((a) => {
      /* An image has no path on disk - it IS its bytes - so the old fallthrough
       * here stored `path: a.path` for anything too big to keep, which for an
       * image is undefined. A reload then restored an attachment with no data,
       * which drew nothing and, if it was sent, carried `data: undefined` to the
       * agent. Only what can actually be restored is kept now. */
      if (a.type === 'image') {
        const keep = typeof a.data === 'string' && a.data.length < 400000;
        return keep ? { type: 'image', mimeType: a.mimeType, name: a.name, data: a.data } : null;
      }
      // Non-images are kept by their path on this machine, which is all the agent
      // needs to open them again.
      return { type: a.type, kind: a.kind, name: a.name, path: a.path, size: a.size, mimeType: a.mimeType, transcript: a.transcript };
    }).filter(Boolean);
    localStorage.setItem(key, JSON.stringify({ text, attachments, at: Date.now() }));
  } catch { /* quota or private mode: a convenience, not state */ }
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(draftKey());
    if (!raw) return;
    const d = JSON.parse(raw);
    if (!d || (!d.text && !(d.attachments || []).length)) return;
    if (typeof input !== 'undefined' && d.text) { input.value = d.text; autoSize(); }
    if ((d.attachments || []).length) { S.attachments = d.attachments; renderAttachments(); }
    toast('Restored what you had typed');
  } catch { /* nothing to restore */ }
}

function clearDraft() {
  try { localStorage.removeItem(draftKey()); } catch { /* private mode */ }
}

function resetComposer() {
  clearDraft();
  input.value = '';
  autoSize();
  clearAttachments();
  closeSlashMenu();
  updateEditBanner();
  syncComposerText();
  input.focus();
}

/* Put a message that failed to send back where it came from. The attachments
 * are handed back as they were, so an uploaded picture does not have to be
 * picked again, and the draft is saved so a reload does not lose it either. */
function restoreComposer(text, attachments) {
  if (text) input.value = text;
  if (attachments && attachments.length) { S.attachments = attachments.slice(); renderAttachments(); }
  autoSize();
  syncComposerText();
  saveDraft();
}

/* The ring around the typed text stays visible whenever the composer has
 * content, not only while it is focused, so the box never looks empty. */
function syncComposerText() {
  const row = document.querySelector('.composer-row');
  if (!row) return;
  row.classList.toggle('has-text', !!input.value.trim() || S.attachments.length > 0);
}

$('btn-send').onclick = sendCurrent;
$('btn-stop').onclick = stopAgent;

async function stopAgent() {
  if (speechSynthesis.speaking) { speechSynthesis.cancel(); S.speaking = false; return; }
  try {
    // pi's RPC has no clear_queue command — the pending queue is tracked
    // client-side via queue_update events, so restore it from there.
    const restored = [...S.queue.steering, ...S.queue.followUp]
      .map((m) => (typeof m === 'string' ? m : ''))
      .filter(Boolean);
    await rpc({ type: 'abort' });
    S.queue = { steering: [], followUp: [] };
    renderQueue();
    if (restored.length) {
      input.value = restored.join('\n---\n') + (input.value ? '\n' + input.value : '');
      autoSize();
    }
    toast('Aborted');
  } catch (e) { toast(e.message, 'error'); }
}

/* ───────────────────────── edit & resend (fork) ───────────────────────── */

function startEdit(msg, forkIdx) {
  const { text } = messageBlock(msg.content);
  const idx = parseInt(forkIdx, 10);
  const f = S.forkable[idx] && S.forkable[idx].text === text
    ? S.forkable[idx]
    : S.forkable.find((x) => x.text === text);
  if (!f) { toast('Cannot locate a fork point for this message', 'error'); return; }
  S.editMode = { entryId: f.entryId, originalText: text };
  input.value = text;
  autoSize();
  updateEditBanner();
  input.focus();
}

function updateEditBanner() {
  const b = $('edit-banner');
  if (S.editMode) {
    b.classList.remove('hidden');
    $('edit-banner-text').textContent = `Editing an earlier message — sending will fork the session from that point. Original: "${S.editMode.originalText.slice(0, 60)}${S.editMode.originalText.length > 60 ? '…' : ''}"`;
  } else {
    b.classList.add('hidden');
  }
}

$('btn-cancel-edit').onclick = () => {
  S.editMode = null;
  input.value = '';
  autoSize();
  updateEditBanner();
};

async function finishEdit(newText) {
  const edit = S.editMode;
  S.editMode = null;
  updateEditBanner();
  try {
    await rpc({ type: 'fork', entryId: edit.entryId });
    // the branch just changed, so anything cached for it is stale
    forkInFlight = null; forkSessionKey = null;
    await refreshMessages();
    await ensureForkable();
    startRunClock();
    sendPrompt(newText, S.attachments.slice(), undefined, true);
    resetComposer();
  } catch (e) {
    toast(`Fork failed: ${e.message}`, 'error');
  }
}

/* ───────────────────────── attachments (upload / paste / drop) ───────────────────────── */

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function addImageFile(file) {
  if (!file.type.startsWith('image/')) { toast(`Not an image: ${file.name}`, 'warning'); return; }
  const dataUrl = await shrinkImage(await readAsDataUrl(file), file.type);
  S.attachments.push({
    type: 'image',
    data: dataUrl.split(',')[1],
    mimeType: file.type,
    name: file.name || 'pasted-image',
  });
  renderAttachments();
}

/* A picture straight off a phone camera is 3-12 MB, and everything downstream
 * pays for it: the bytes cross this WebSocket as base64 (a third larger again),
 * they are written into the session file, and the provider is asked to look at
 * the whole thing on every turn it stays in the context.
 *
 * It is also the reason a photograph could not be kept in the composer draft -
 * localStorage holds a few megabytes for everything the page keeps, and a phone
 * picture on its own can exceed that. And when a provider rejects a request because
 * of its byte size, its error reads like a context overflow, so a picture that is
 * too big can start a compaction the picture itself can never be summarised out of:
 * pi prices an image at a flat ~1200 tokens no matter how large it is, so the
 * estimate looks small and the image stays in the kept window while each retry
 * carries the same megabytes (issue #38).
 *
 * So anything larger than a sensible viewing size is re-encoded once, on attach.
 * 2048px on the long edge loses nothing anyone can see here, and the base64 that
 * has to travel, be stored and be read is a fraction of what it was. GIFs are left
 * alone so they keep animating, and every failure path returns the original: this
 * is an optimisation and must never be the reason a picture does not arrive. */
const IMAGE_MAX_EDGE = 2048;
const IMAGE_REENCODE_OVER = 300000;   // base64 characters, roughly 225 KB

async function shrinkImage(dataUrl, mimeType) {
  if (typeof dataUrl !== 'string' || dataUrl.length < IMAGE_REENCODE_OVER) return dataUrl;
  if (/gif/i.test(mimeType || '')) return dataUrl;
  try {
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const longEdge = Math.max(bmp.width || 0, bmp.height || 0);
    const scale = longEdge > 0 ? Math.min(1, IMAGE_MAX_EDGE / longEdge) : 1;
    if (scale >= 1 && dataUrl.length < IMAGE_REENCODE_OVER * 3) { bmp.close(); return dataUrl; }
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close();
    // PNG for a screenshot (crisp text and flat colour), JPEG for a photograph.
    const type = /png|webp/i.test(mimeType || '') ? 'image/png' : 'image/jpeg';
    const blob = await new Promise((res) => cv.toBlob(res, type, 0.88));
    if (!blob) return dataUrl;
    const shrunk = await readAsDataUrl(blob);
    // Keep it only if it is genuinely smaller - a photo stored as PNG can come
    // back larger from the re-encode, and then the original is the better file.
    return shrunk.length < dataUrl.length ? shrunk : dataUrl;
  } catch {
    return dataUrl;
  }
}

/* File kind for non-image attachments. */
function fileKind(f) {
  if (f.type.startsWith('audio/')) return 'audio';
  if (f.type.startsWith('video/')) return 'video';
  if (f.type === 'application/pdf') return 'pdf';
  return 'file';
}

/* Upload a file to the workspace (bridge saves it under uploads/) so the
 * agent can read it with its tools. Returns {path, size}. */
async function uploadFile(file) {
  // Big files as a raw body: base64 inflates them by a third and the JSON body
  // cap cut the request off - which surfaced as "data (base64) is required",
  // because the server received a truncated object. A background video is often
  // the largest file anyone uploads, and it only ever gets stored, never sent to
  // the model.
  if (file.size > 8 * 1024 * 1024) {
    const q = `name=${encodeURIComponent(file.name || 'file')}&mimeType=${encodeURIComponent(file.type || '')}`;
    const d = await (await fetch(api(`/api/upload-raw?${q}`), {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    })).json();
    if (!d.ok) throw new Error(d.error || 'upload failed');
    if (d.duplicate) toast(`“${file.name}” was uploaded before — reusing it`, 'warning');
    return d;
  }
  const data = await readAsDataUrl(file);
  const d = await (await fetch(api('/api/upload'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, data: data.split(',')[1], mimeType: file.type }),
  })).json();
  if (!d.ok) throw new Error(d.error || 'upload failed');
  if (d.duplicate) toast(`“${file.name}” was uploaded before — reusing it`, 'warning');
  return d;
}

/* Transcribe an audio file. Tries the bridge's local whisper first, then the
 * user-configured STT endpoint. Audio is converted to 16 kHz mono WAV in the
 * browser first so mp3/m4a/ogg/webm all work. */
async function transcribeAudioFile(file) {
  let wavBlob = file;
  try { wavBlob = await blobToWav(file); } catch { /* not browser-decodable; send raw */ }
  const dataUrl = await readAsDataUrl(wavBlob);
  const b64 = dataUrl.split(',')[1];
  // Whisper backend: make sure the local server is actually up first (it is
  // downloaded on demand), so picking whisper in settings "just works".
  if (SET.sttBackend === 'whisper') await ensureWhisper(true);
  try {
    const d = await (await fetch(api('/api/transcribe'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: b64 }),
    })).json();
    if (d.ok && d.text) return d.text;
  } catch { /* no local STT server */ }
  if (SET.sttEndpoint) {
    const endpoint = sttEndpointUrl();
    const fd = new FormData();
    fd.append('file', wavBlob, wavBlob.name || 'speech.wav');
    if (/\/v1\/audio\/transcriptions\/?$/.test(endpoint)) {
      fd.append('model', 'whisper-1');
      fd.append('response_format', 'json');
    }
    const res = await fetch(endpoint, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`STT server ${res.status}`);
    const d = await res.json();
    return d.text || d.transcription || '';
  }
  throw new Error('no STT endpoint available');
}

/* Attach any file: images go to the model as vision input; everything else
 * (PDF / audio / video / other) is uploaded to the workspace and referenced
 * by path in the prompt. Audio is transcribed when STT is available. */
/* A picture or a video is something the user might mean as a background (the
 * wallpaper picker takes both). Used to route a dropped file that is too big for
 * the model to the wallpaper instead of refusing it outright. */
async function addFile(file) {
  if (file.type.startsWith('image/')) { await addImageFile(file); return; }
  if (file.size > 100 * 1024 * 1024) {
    // The cap is there because an attachment is base64'd into the request. It used
    // to quietly turn a too-big video into the background - which is not what
    // anyone dropping a file into the *chat* asked for, so now it just fails.
    // (The background has its own upload button, and no size limit.)
    toast(`File too large (max 100 MB): ${file.name}`, 'error');
    return;
  }
  const att = { type: 'file', kind: fileKind(file), name: file.name || 'file', mimeType: file.type, size: file.size };
  try {
    att.path = (await uploadFile(file)).path;
  } catch (e) {
    toast(`Upload failed: ${e.message}`, 'error');
    return;
  }
  if (att.kind === 'audio') {
    att.transcribing = true;
    S.attachments.push(att);
    renderAttachments();
    try { att.transcript = await transcribeAudioFile(file); }
    catch (e) { att.transcriptError = e.message; }
    att.transcribing = false;
  } else {
    S.attachments.push(att);
  }
  renderAttachments();
}

function renderAttachments() {
  saveDraft();
  const wrap = $('attachments');
  wrap.innerHTML = '';
  wrap.classList.toggle('hidden', !S.attachments.length);
  syncComposerText();
  S.attachments.forEach((a, i) => {
    const box = el('div', `attachment${a.type === 'file' ? ' file' : ''}`);
    if (a.type === 'image') {
      const dataUrl = `data:${a.mimeType};base64,${a.data}`;
      // A 64px thumbnail cannot show what you are about to send. Clicking it
      // opens the real picture; the same full-size viewer a message image uses,
      // closed by clicking off it or with Esc.
      const view = el('button', 'attachment-view');
      view.type = 'button';
      view.title = `${a.name || 'image'} — click to view it full size`;
      view.setAttribute('aria-label', `view ${a.name || 'this image'} full size`);
      const img = el('img');
      img.src = dataUrl;
      img.alt = '';
      const eye = el('span', 'attachment-eye');
      eye.innerHTML = EYE_SVG;
      view.append(img, eye);
      view.onclick = (e) => { e.stopPropagation(); zoomImage(dataUrl); };
      box.appendChild(view);
    } else {
      const icon = el('div', 'file-icon', a.kind === 'pdf' ? 'PDF' : a.kind === 'audio' ? '♪' : a.kind === 'video' ? '▶' : '·');
      const meta = el('div', 'file-meta');
      meta.appendChild(el('div', 'file-name', a.name));
      const status = a.transcribing
        ? 'transcribing…'
        : a.transcript
          ? `transcribed: ${a.transcript.slice(0, 80)}${a.transcript.length > 80 ? '…' : ''}`
          : a.transcriptError
            ? `transcript failed (${a.transcriptError})`
            : fmtSize(a.size);
      meta.appendChild(el('div', 'file-status', status));
      box.append(icon, meta);
    }
    const rm = el('button', 'rm', '×');
    rm.onclick = () => { S.attachments.splice(S.attachments.indexOf(a), 1); renderAttachments(); };
    box.appendChild(rm);
    wrap.appendChild(box);
  });
}

function clearAttachments() {
  S.attachments = [];
  renderAttachments();
  syncComposerText();
  saveDraft();
}

$('btn-attach').onclick = () => $('file-input').click();
$('file-input').onchange = async (e) => {
  for (const f of e.target.files) await addFile(f);
  e.target.value = '';
};

// paste images from clipboard
document.addEventListener('paste', (e) => {
  const items = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/'));
  if (!items.length) return;
  e.preventDefault();
  for (const item of items) {
    const file = item.getAsFile();
    if (file) addImageFile(file);
  }
  toast('Image pasted from clipboard');
});

// drag & drop images onto the window
let dragDepth = 0;
function hideDropOverlay() {
  dragDepth = 0;
  const o = $('drop-overlay');
  if (o) o.classList.add('hidden');
}
document.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  // In a dialog, and on a row that takes files itself, the "drop files to attach"
  // overlay is wrong: those spots have their own highlight. Leaving it up (and
  // having no drop event to take it down, because the row stops propagation) is
  // what left it hanging over the page.
  const t = e.target;
  if (t && t.closest && (t.closest('dialog') || t.closest('.avatar-row') || t.closest('.rate-row'))) return;
  dragDepth++;
  $('drop-overlay').classList.remove('hidden');
});
document.addEventListener('dragleave', (e) => {
  // Leaving the window (no relatedTarget) always clears it: the counter can miss
  // a leave when the drag ends inside a nested element.
  if (!e.relatedTarget) { hideDropOverlay(); return; }
  if (--dragDepth <= 0) hideDropOverlay();
});
// the drag ending anywhere - dropped, cancelled, or dropped on a row that stops
// propagation - must take the overlay down
document.addEventListener('dragend', () => hideDropOverlay());
window.addEventListener('blur', () => hideDropOverlay());
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  hideDropOverlay();
  for (const f of e.dataTransfer?.files || []) await addFile(f);
});

/* ───────────────────────── slash commands ───────────────────────── */

/* handled by the UI itself, never sent to the agent */
const LOCAL_COMMANDS = [
  { name: 'tts', description: 'Toggle text-to-speech for agent replies', source: 'local' },
  { name: 'autosend', description: 'Toggle auto-send after voice input', source: 'local' },
  { name: 'thinking', description: 'Toggle showing thinking blocks', source: 'local' },
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
  // Span the composer: from the "+" button to "send".
  const row = document.querySelector('.composer-row') || input;
  const r = row.getBoundingClientRect();
  menu.style.left = r.left + 'px';
  menu.style.width = r.width + 'px';
  menu.style.bottom = `${window.innerHeight - r.top + 8}px`;
  slash.menu = menu;
}

function closeSlashMenu() {
  if (slash.menu) slash.menu.remove();
  slash = { open: false, items: [], sel: 0, menu: null };
}

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

/* ───────────────────────── voice to text ───────────────────────── */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null, recogBase = '', recogActive = false, recogAborted = false;

if (!SR) {
  $('btn-mic').title = 'Browser voice unavailable — configure a Whisper endpoint in settings for voice input';
} else {
  recog = new SR();
  recog.interimResults = true;
  recog.continuous = true; // keep listening until the mic is clicked again
  recog.lang = navigator.language || 'en-US';

  recog.onresult = (e) => {
    let finalText = '', interim = '';
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    input.value = (recogBase + finalText + interim).replace(/\s+$/, ' ');
    autoSize();
  };
  recog.onend = () => {
    recogActive = false;
    $('btn-mic').classList.remove('recording');
    // Optional hands-free mode: send what was dictated once recognition ends.
    if (SET.voiceAutoSend && !recogAborted && input.value.trim()) sendCurrent();
  };
  recog.onerror = (e) => {
    recogActive = false;
    $('btn-mic').classList.remove('recording');
    if (e.error === 'not-allowed') toast('Microphone permission denied', 'error');
    else if (e.error === 'aborted') recogAborted = true;
    else if (e.error !== 'aborted') toast(`Voice input error: ${e.error}`, 'error');
  };
}

/* Whisper-compatible speech-to-text (whisper.cpp server /inference, or any
 * OpenAI-style /v1/audio/transcriptions). The recording is converted to
 * 16 kHz mono WAV in the browser first, so Firefox (ogg) and Chrome (webm)
 * both work. Falls back to browser SpeechRecognition without an endpoint. */
async function blobToWav(blob) {
  const buf = await blob.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const decoded = await ctx.decodeAudioData(buf);
    const src = decoded.getChannelData(0);
    const rate = 16000;
    // whisper.cpp rejects very short clips - pad to at least 1.2 s of audio
    const minSamples = Math.ceil(1.2 * rate);
    const outLen = Math.max(minSamples, Math.ceil(src.length * rate / decoded.sampleRate));
    const pcm = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const v = src[Math.min(src.length - 1, Math.floor(i * decoded.sampleRate / rate))];
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    }
    const wav = new ArrayBuffer(44 + pcm.length * 2);
    const dv = new DataView(wav);
    const wstr = (o, t) => { for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
    wstr(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); wstr(8, 'WAVE');
    wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    wstr(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
    new Int16Array(wav, 44).set(pcm);
    return new Blob([wav], { type: 'audio/wav' });
  } finally {
    // An AudioContext holds a real audio device and its own thread. close() was
    // only on the happy path, so every audio attachment the browser could not
    // decode leaked one - and the caller catches that failure and carries on, so
    // it leaked silently. 5 s of audio could do it half a dozen times.
    try { ctx.close(); } catch { /* already closed */ }
  }
}

async function transcribeWithWhisper(blob) {
  const wav = await blobToWav(blob);
  const endpoint = sttEndpointUrl();
  const isOpenAI = /\/v1\/audio\/transcriptions\/?$/.test(endpoint);
  const fd = new FormData();
  if (isOpenAI) {
    fd.append('file', wav, 'speech.wav');
    fd.append('model', 'whisper-1');
    fd.append('response_format', 'json');
  } else {
    // whisper.cpp server's /inference reads the audio from the multipart
    // field named "file" (NOT "audio_file"). Any 400 it returns is
    // overwritten by its error handler with the generic "Invalid request",
    // so a wrong field name surfaces as that cryptic message.
    fd.append('file', wav, 'speech.wav');
    fd.append('response_format', 'json');
  }
  const res = await fetch(endpoint, { method: 'POST', body: fd });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 120); } catch { /* ignore */ }
    throw new Error(`STT server ${res.status} ${detail}`);
  }
  const d = await res.json();
  return d.text || d.transcription || '';
}

let mediaRecorder = null, mediaStream = null, recAudioChunks = [], whisperBusy = false;

async function startWhisperRecording() {
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  recAudioChunks = [];
  mediaRecorder = new MediaRecorder(mediaStream);
  mediaRecorder.ondataavailable = (e) => { if (e.data.size) recAudioChunks.push(e.data); };
  mediaRecorder.onstop = async () => {
    mediaStream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(recAudioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    $('btn-mic').classList.remove('recording');
    if (blob.size < 800) return; // just a click
    whisperBusy = true;
    $('btn-mic').classList.add('recording'); // stays lit while transcribing
    try {
      const text = await transcribeWithWhisper(blob);
      if (text) {
        input.value = (input.value ? input.value.replace(/\s+$/, '') + ' ' : '') + text.trim();
        autoSize();
        if (SET.voiceAutoSend) sendCurrent();
      } else toast('Whisper heard nothing');
    } catch (e) {
      toast(`Whisper failed: ${e.message}`, 'error');
    } finally {
      whisperBusy = false;
      $('btn-mic').classList.remove('recording');
    }
  };
  mediaRecorder.start();
  $('btn-mic').classList.add('recording');
  toast('Recording… click again to transcribe with Whisper');
}

/* True for endpoints that point at this machine's own whisper server
 * (localhost): those die with the bridge, so a mic click re-checks them and
 * restarts the selected model if needed. A custom endpoint on another machine
 * is trusted as-is. */
function isLocalSttEndpoint(u) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(u || '');
}

/* The URL to actually send audio to. The local whisper server is stored as
 * http://localhost:PORT/… - but when the WebUI is browsed from another machine
 * on the LAN, that "localhost" must mean the machine the bridge runs on (this
 * page's host), not the client's own. Custom endpoints are used as-is. */
function sttEndpointUrl() {
  const u = SET.sttEndpoint;
  if (!u || !isLocalSttEndpoint(u)) return u;
  try {
    const parsed = new URL(u);
    parsed.hostname = location.hostname || 'localhost';
    return parsed.toString();
  } catch { return u; }
}

$('btn-mic').onclick = async () => {
  if (whisperBusy) return;
  const useWhisper = (SET.sttBackend || 'whisper') !== 'browser';
  if (useWhisper) {
    // Second click while recording: stop and transcribe - no server checks.
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      return;
    }
    // Automatic start: make sure the model picked in settings is actually
    // being served - reuse a running local server, switch it to the selected
    // model, or start it (first use downloads whisper.cpp + the model).
    // A custom endpoint on another machine is used as-is.
    if (!SET.sttEndpoint || isLocalSttEndpoint(SET.sttEndpoint)) {
      whisperBusy = true; // no double-clicks while a download is running
      $('btn-mic').classList.add('recording'); // lit while it comes up
      const url = await ensureWhisper(false);
      whisperBusy = false;
      $('btn-mic').classList.remove('recording');
      if (!url && isLocalSttEndpoint(SET.sttEndpoint)) SET.sttEndpoint = ''; // dead local endpoint
    }
    if (SET.sttEndpoint) {
      startWhisperRecording().catch((e) => {
        $('btn-mic').classList.remove('recording');
        toast(`Microphone error: ${e.message}`, 'error');
      });
      return;
    }
    // The local server could not be started (offline, server failed): fall
    // back to browser voice instead of a dead endpoint.
    if (recog) toast('Whisper server is not available - using browser voice instead', 'warning');
  }
  // browser SpeechRecognition fallback
  if (!recog) { toast('This browser has no built-in voice — set a Whisper endpoint in settings (⚙) for voice input', 'warning'); return; }
  if (recogActive) { recogAborted = true; recog.stop(); return; }
  recogBase = input.value ? input.value.replace(/\s+$/, '') + ' ' : '';
  recogAborted = false;
  try {
    recog.start();
    recogActive = true;
    $('btn-mic').classList.add('recording');
    if (SET.voiceAutoSend) toast('Listening… will auto-send when you stop talking');
  } catch { /* already started */ }
};

/* ───────────────────────── TTS ───────────────────────── */

function ttsVoices() {
  try { return speechSynthesis.getVoices() || []; } catch { return []; }
}

// Sensible default: prefer a natural-sounding en voice when none is chosen.
function pickDefaultVoice() {
  const voices = ttsVoices();
  if (!voices.length) return null;
  const pref = [
    (v) => /natural|neural/i.test(v.name),
    (v) => /google (us|uk) english/i.test(v.name),
    (v) => /en[-_]/i.test(v.lang) && /microsoft|apple|zira|david|aria/i.test(v.name),
    (v) => /^en/i.test(v.lang),
  ];
  for (const p of pref) {
    const hit = voices.find(p);
    if (hit) return hit;
  }
  return voices[0];
}

function currentTtsVoice() {
  if (SET.ttsVoiceURI) {
    const v = ttsVoices().find((v) => v.voiceURI === SET.ttsVoiceURI);
    if (v) return v;
  }
  return pickDefaultVoice();
}

/* Speak via a local OpenAI-compatible TTS server (/v1/audio/speech):
 * openedai-speech, speaches, alltalk, etc. — small models like Piper with
 * trainable/clonable voices. Returns a promise that resolves when done. */
/* Speech through the bridge, for a cloud voice: a browser cannot call those
 * services itself (no CORS, and the API key would sit in the page). The bridge
 * holds the key and streams the audio back. */
async function speakCloud(text) {
  return speakInBatches(text, async (chunk) => {
    const res = await fetch(api('/api/tts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: SET.ttsBackend,
        text: chunk,
        model: SET.ttsCloudModel || undefined,
        voice: SET.ttsCloudVoice || undefined,
        baseUrl: SET.ttsCloudUrl || undefined,
      }),
    });
    if (!res.ok) {
      let msg = `TTS ${res.status}`;
      try { const d = await res.json(); if (d && d.error) msg = d.error; } catch { /* not json */ }
      throw new Error(msg);
    }
    return res.blob();
  });
}

async function speakEndpoint(text) {
  return speakInBatches(text, async (chunk) => {
    const res = await fetch(SET.ttsEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: SET.ttsModel || 'piper', input: chunk, voice: SET.ttsVoiceName || undefined, response_format: 'wav' }),
    });
    if (!res.ok) throw new Error(`TTS server ${res.status}`);
    return res.blob();
  });
}

/* Split a reply into pieces a service will accept, hand each one to `getAudio`,
 * and play what comes back in order. */
async function speakInBatches(text, getAudio) {
  const chunks = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  let batch = '', buffers = [];
  const flush = async () => {
    if (!batch.trim()) return;
    buffers.push(await getAudio(batch.trim()));
    batch = '';
  };
  for (const c of chunks) {
    if ((batch + c).length > 600) await flush();
    batch += c;
  }
  await flush();
  S.speaking = true;
  $('btn-tts').classList.add('on');
  for (const b of buffers) {
    await new Promise((done) => {
      const a = new Audio(URL.createObjectURL(b));
      a.onended = done;
      a.onerror = done;
      a.play();
    });
  }
  S.speaking = false;
  $('btn-tts').classList.remove('on');
}

function speak(text) {
  if (SET.ttsBackend === 'fish' || SET.ttsBackend === 'openai') {
    return speakCloud(text).catch((e) => toast(`Speech failed: ${e.message}`, 'error'));
  }
  if (!('speechSynthesis' in window) && SET.ttsBackend !== 'endpoint') {
    toast('Speech synthesis not supported', 'warning');
    return;
  }
  const clean = stripMarkdown(text);
  if (!clean) return;
  if (SET.ttsBackend === 'endpoint') {
    if (!SET.ttsEndpoint) { toast('Set a TTS server URL in settings first', 'warning'); return; }
    speechSynthesis.cancel();
    speakEndpoint(clean).catch((e) => {
      S.speaking = false;
      $('btn-tts').classList.remove('on');
      toast(`TTS failed: ${e.message}`, 'error');
    });
    return;
  }
  speechSynthesis.cancel();
  const voice = currentTtsVoice();
  // Chunk long text: some engines truncate very long utterances.
  for (const chunk of clean.match(/[\s\S]{1,220}(?=\s|$)|[\s\S]{1,220}/g) || []) {
    const u = new SpeechSynthesisUtterance(chunk);
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    u.rate = SET.ttsRate || 1.05;
    u.onend = () => {
      if (!speechSynthesis.speaking) { S.speaking = false; $('btn-tts').classList.remove('on'); }
    };
    speechSynthesis.speak(u);
  }
  S.speaking = true;
  $('btn-tts').classList.add('on');
}

speechSynthesis?.addEventListener?.('voiceschanged', () => populateTtsVoiceSelect());

function setAutoTts(on) {
  S.autoTts = on;
  applySettings();
  $('btn-tts').title = on ? 'Auto-speak ON — click to disable (or type /tts)' : 'Speak agent replies out loud (or type /tts)';
  if (!on) speechSynthesis.cancel();
  toast(on ? `Auto-speak enabled${currentTtsVoice() ? `: ${currentTtsVoice().name}` : ''}` : 'Auto-speak disabled');
}

$('btn-tts').onclick = () => setAutoTts(!S.autoTts);

/* ───────────────────────── sessions ───────────────────────── */

/* Is this list row the session we mean? The path decides it. The file name is
 * only a fallback for the bridge reporting the same session with another
 * spelling, and only while that name is unique in the list: a subagent run
 * transcript is also called `session.jsonl`, and matching on the bare name
 * highlighted two dozen unrelated rows at once. */
function sameSessionPath(a, b, all) {
  if (!a || !b) return false;
  const A = String(a), B = String(b);
  if (A === B) return true;
  const an = A.split(/[\\/]/).pop(), bn = B.split(/[\\/]/).pop();
  if (an !== bn) return false;
  const same = (all || []).filter((s) => String((s && s.fileName) || '').split(/[\\/]/).pop() === an);
  return same.length === 1;
}

/* A cheap signature of the session list. renderSessions() throws the sidebar
 * away and builds it again, so calling it when nothing has changed is pure
 * waste - and it is called every twenty seconds by the idle poll, so most of
 * those calls changed nothing at all. */
function sessionsSignature(list) {
  let s = '';
  for (const x of list) s += `${x.path}\u0001${x.name}\u0001${x.size}\u0001${x.mtime}\u0001${x.parent || ''}\u0002`;
  return s;
}

async function refreshSessions(force) {
  try {
    const res = await fetch(api('/api/sessions'));
    const d = await res.json();
    const list = d.sessions || [];
    /* A scan the bridge could not complete says so (issue #30).
     *
     * The scan returning nothing used to be reported as an empty list, so a
     * session directory that could not be read looked exactly like an account
     * with no sessions - and in container mode that was the state for every
     * session, silently. One line above the list, shown once per distinct reason
     * rather than on every twenty-second poll. */
    if (d.scanError && S.scanErrorShown !== d.scanError) {
      S.scanErrorShown = d.scanError;
      toast(`Session list: ${d.scanError}`, 'error');
    } else if (!d.scanError) {
      S.scanErrorShown = null;
    }
    const sig = sessionsSignature(list);
    if (!force && sig === S.sessionsSig) { applyAgentStatus(d); return; }
    S.sessionsSig = sig;
    S.sessionsList = list;
    renderSessions(list);
    applyAgentStatus(d);
  } catch { /* ignore */ }
}

/* What the agent is doing, straight from the bridge: a reload in the middle of a
 * compaction used to look like a page where nothing ever happened. */
function applyAgentStatus(d) {
  if (!d) return;
  if ('busy' in d) S.agentBusy = !!d.busy;
  if (!('compacting' in d)) return;
  const c = d.compacting;
  const mine = !c || !c.session || !S.state.sessionFile || sameSessionPath(c.session, S.state.sessionFile, []);
  if (c && mine && !S.compacting) {
    S.compacting = true;
    if (!S.compactionLive) S.compactionLive = renderCompactionLive(c.since);
    else if (S.compactionLive.setSince) S.compactionLive.setSince(c.since);
    document.body.classList.add('compacting');
  } else if (!c && S.compacting) {
    // It finished while the page was away (or in another tab).
    S.compacting = false;
    S.compactionHappened = true;
    removeCompactionLive();
    document.body.classList.remove('compacting');
  }
  // The task clock: the agent is idle, so the task that was running when this page
  // was last here is done - it stopped at the agent's last message.
  if (S.agentBusy === false && S.runStartTs && !S.compacting) {
    const endTs = lastAssistantTs();
    if (endTs > S.runStartTs) finishRunClock(endTs);
    // No message after the clock started (the page was reloaded into a session
    // whose task ended long ago): there is no honest number to show, so drop it
    // rather than counting idle time.
    else if (!endTs || endTs < S.runStartTs) {
      S.runStartTs = null;
      S.runMs = null;
      saveSessionUi({ runStart: null, runMs: null });
      paintRunStat();
      ensureTick();
    }
  }
}

/* The blue highlight in the session list shows which session you are looking at,
 * so it has to be repainted the moment that changes. Switching sessions used to
 * leave the previous row highlighted (the list only re-rendered on the 20s poll),
 * which read as "the highlight is stuck on the session the agent is running in". */
/* Move the highlight without rebuilding the sidebar.
 *
 * This used to call `renderSessions()`, which throws the whole list away and
 * builds it again - every row, every folder, every fork arrow, the filter, the
 * sort - in order to move one class from one row to another. On a machine with
 * a few dozen sessions that is the difference between the highlight arriving
 * with the click and arriving a beat later, and it is the one thing in a session
 * switch that has to be instant: it is the answer to "did my click land".
 *
 * So the rows are walked and the class is moved. The rule for which row is
 * highlighted is the same one `renderSessions` uses - the session being viewed
 * when one is, otherwise the one the agent is in - so the two can never
 * disagree about where the blue edge is. */
function syncSessionHighlight() {
  const sessions = S.sessionsList || [];
  const cur = S.state.sessionFile;
  const viewed = S.viewSession || null;
  const rows = document.querySelectorAll('#session-list .session-item');
  for (const item of rows) {
    const path = item.dataset.path || '';
    const isCurrent = !!cur && sameSessionPath(path, cur, sessions);
    const isViewed = !!viewed && sameSessionPath(path, viewed, sessions);
    item.classList.toggle('active', viewed ? isViewed : isCurrent);
  }
}

/* ── folding a session's forks away ──────────────────────────────────────
 * Forks are rows under the session they came from. A parent with children gets
 * an arrow to fold them, so a session with a dozen branches still leaves the list
 * readable - and the fold is remembered per browser. */
function loadForkCollapse() {
  try { return JSON.parse(localStorage.getItem('piwebui-forks-collapsed') || '{}') || {}; } catch { return {}; }
}
function toggleForkCollapse(sessionPath) {
  if (!S.collapsedForks) S.collapsedForks = {};
  if (S.collapsedForks[sessionPath]) delete S.collapsedForks[sessionPath];
  else S.collapsedForks[sessionPath] = true;
  try { localStorage.setItem('piwebui-forks-collapsed', JSON.stringify(S.collapsedForks)); } catch { /* private mode */ }
  renderSessions(S.sessionsList || []);
}

/* What the sidebar is currently pointing at, by row identity rather than pixels.
 *
 * A pixel offset is not stable across a rebuild. Rows appear and disappear -
 * the pending row for "the session the agent is on" comes and goes as you
 * switch, a session that was just written to moves up the mtime order, a fork
 * gets added under its parent - and after any of those the same scrollTop points
 * at different content. That is issue #34: the sidebar appears to jump the moment
 * a switch lands, with the scroll position itself unchanged.
 *
 * So the anchor is the topmost visible row's path plus how far above the list's
 * top edge it is sitting. Restoring it puts that same row back under the same
 * pixel, whatever moved around it. */
function sessionListAnchor(list) {
  const top = list.getBoundingClientRect().top;
  for (const item of list.querySelectorAll('.session-item')) {
    const r = item.getBoundingClientRect();
    if (r.bottom > top + 1) return { path: item.dataset.path || null, off: Math.round(r.top - top) };
  }
  return null;
}

function restoreSessionListAnchor(list, anchor, fallbackScroll) {
  if (anchor && anchor.path) {
    const row = [...list.querySelectorAll('.session-item')].find((n) => n.dataset.path === anchor.path);
    if (row) {
      const top = list.getBoundingClientRect().top;
      const delta = Math.round(row.getBoundingClientRect().top - top) - anchor.off;
      if (delta) list.scrollTop += delta;
      return;
    }
    // The row itself is gone (deleted, filtered, or folded into a folder).
    // Falling back to the pixel position is the best available answer, and it is
    // clamped for us if the list got shorter.
  }
  list.scrollTop = fallbackScroll;
}

function renderSessions(sessions) {
  const list = $('session-list');
  const anchor = sessionListAnchor(list);
  const keepScroll = list.scrollTop;
  const filter = ($('session-filter').value || '').toLowerCase();
  // pi only writes the session file once something happens in it, so a brand
  // new session is missing from /api/sessions until the first message. Show the
  // one the agent is actually on, otherwise "new session" looks like it did
  // nothing until a reload.
  const cur = S.state.sessionFile;
  if (cur && !sessions.some((s) => s.path === cur || s.fileName === cur.split(/[\\/]/).pop())) {
    sessions = [{
      path: cur,
      fileName: cur.split(/[\\/]/).pop(),
      name: (S.state.sessionName || '').trim() || 'new session',
      mtime: Date.now(),
      size: 0,
      pending: true,
    }, ...sessions];
  }
  list.innerHTML = '';
  S.sessionsList = sessions;
  const current = S.state.sessionFile;
  // Fill the topbar name from the session's derived title (first user message)
  // when pi hasn't set an explicit session name and we're showing the raw
  // timestamp file name.
  if (current) {
    const base = current.split(/[\\/]/).pop().replace(/\.jsonl$/, '');
    const match = sessions.find((s) => s.path === current || s.fileName === base);
    const nameInput = $('session-name');
    if (match && (nameInput.value === base || nameInput.value === '')) {
      nameInput.value = match.name === base ? base : match.name;
      nameInput.title = `${match.name} — click to rename`;
    }
  }
  // Order the list so a session is followed by the forks it spawned, instead of
  // everything being sorted by time: a branch belongs under the session it came
  // from.
  const byPath = new Map(sessions.map((s) => [s.path, s]));
  /* Children by parent, built once.
   *
   * Both the ordering pass and every row used to run `sessions.filter(...)` to
   * find a session's forks - twice per row inside addRow, plus once per session
   * here - which is O(n²) over the whole list (issue #26). The cap is 200
   * sessions so it was never a hot spot, but it is one pass instead of thousands
   * of comparisons now, and the two maps are what the row builder actually
   * wants. */
  const childrenOf = new Map();
  for (const s of sessions) {
    if (!s.parent) continue;
    if (!childrenOf.has(s.parent)) childrenOf.set(s.parent, []);
    childrenOf.get(s.parent).push(s);
  }
  const kidsOf = (p) => childrenOf.get(p) || [];
  const collapsedForks = S.collapsedForks || {};
  // A search shows everything: hiding a match behind a fold would be a mystery.
  const folded = (path) => !filter && !!collapsedForks[path];
  const ordered = [];
  const placed = new Set();
  for (const s of sessions) {
    if (s.parent && byPath.has(s.parent)) continue;      // rendered with its parent
    if (placed.has(s.path)) continue;
    ordered.push(s);
    placed.add(s.path);
    if (!folded(s.path)) {
      const kids = kidsOf(s.path).slice().sort((a, b) => b.mtime - a.mtime);
      for (const k of kids) { ordered.push(k); placed.add(k.path); }
    }
  }
  for (const s of sessions) {
    if (placed.has(s.path)) continue;
    // ...but a branch whose parent is folded stays folded: this pass used to put
    // it back, so clicking the arrow appeared to do nothing.
    if (s.parent && byPath.has(s.parent) && folded(s.parent)) continue;
    ordered.push(s);
  }

  const shown = ordered.filter((s) => !filter || s.name.toLowerCase().includes(filter) || s.fileName.toLowerCase().includes(filter));
  if (!shown.length) list.appendChild(el('div', 'session-item s-meta', 'No sessions found'));
  // ── folders ─────────────────────────────────────────────────────────────
  // Sessions can live in folders (Settings and the folder menu write them into
  // the bridge's settings, so they are the same in every browser). A folder is a
  // drop target for a session row, and folders can be dragged onto each other to
  // change their order.
  const folders = sessionFolders();
  const folderOf = new Map();
  for (const f of folders) for (const p of f.paths || []) folderOf.set(p, f.id);
  const inFolder = new Set(shown.filter((x) => folderOf.has(x.path)).map((x) => x.path));
  const collapsedFolders = S.collapsedFolders || {};

  // The session the agent is actually working in (may be a fork of what is on
  // screen; when the UI shows another session, S.isStreaming still describes it).
  const runningPath = (cur) => (cur && cur.path) || (S.state && S.state.sessionFile) || null;
  const sessionHasRunningDescendant = (parentPath, all, target) => {
    if (!target) return false;
    const seen = new Set();
    const walk = (p) => {
      for (const x of all) {
        if (x.parent !== p || seen.has(x.path)) continue;
        seen.add(x.path);
        if (sameSessionPath(x.path, target, all)) return true;
        if (walk(x.path)) return true;
      }
      return false;
    };
    return walk(parentPath);
  };

  const addRow = (s) => {
      const item = el('div', 'session-item');
      // A session that was forked off another one: thinner row, smaller grey text
      // and an arrow in front, so the branch structure is visible in the list.
      const parentName = s.parent ? (byPath.get(s.parent) || {}).name : null;
      if (s.parent) {
        item.classList.add('fork');
        item.title = parentName ? `branched from "${parentName}"` : `branched from ${s.parent}`;
      }
      const kids = kidsOf(s.path);
      const isCurrent = current && sameSessionPath(s.path, current, sessions);
      const isViewed = S.viewSession ? sameSessionPath(s.path, S.viewSession, sessions) : false;
      // The blue highlight follows what you are looking at; the green pulsing dot
      // marks the session still running in the background. Highlighting both made
      // it look like two sessions were selected at once.
      if (S.viewSession ? isViewed : isCurrent) item.classList.add('active');
      // Which session the agent is running in. A fork whose parent row is folded
      // away is not in the list at all, so an ancestor carries the dot instead -
      // otherwise a running branch was invisible until you opened the forks.
      const selfLive = isCurrent && S.isStreaming;
      const branchLive = !selfLive && S.isStreaming && sessionHasRunningDescendant(s.path, sessions, runningPath(current));
      if (selfLive || branchLive) item.classList.add('live');
      const nameRow = el('div', 's-name');
      if (selfLive || branchLive) {
        const dot = el('span', 'live-dot', '');
        if (branchLive) dot.title = 'a branch forked from this session is running';
        nameRow.appendChild(dot);
      }
      // The arrow that folds this session's forks away (only where there are any).
      const forkKids = kids;
      if (forkKids.length) {
        const open = !collapsedForks[s.path];
        // Folded away with a count, so it is obvious there is something behind it.
        const arrow = el('span', 'fork-toggle', open ? '▾' : `▸ ${forkKids.length}`);
        arrow.title = open
          ? `hide the ${forkKids.length} session${forkKids.length > 1 ? 's' : ''} forked from this one`
          : `show the ${forkKids.length} session${forkKids.length > 1 ? 's' : ''} forked from this one`;
        arrow.setAttribute('role', 'button');
        arrow.setAttribute('aria-expanded', open ? 'true' : 'false');
        arrow.onclick = (e) => { e.stopPropagation(); toggleForkCollapse(s.path); };
        nameRow.appendChild(arrow);
      }
      nameRow.appendChild(el('span', 'name-text', s.name));
      item.appendChild(nameRow);
      item.appendChild(el('div', 's-meta', `${new Date(s.mtime).toLocaleString()} · ${fmtSize(s.size)}`));
      item.onclick = () => switchToSession(s.path);
      item.oncontextmenu = (e) => { e.preventDefault(); openSessionMenu(s, item); };
      // Drag a session onto a folder (or onto another session inside one) to file
      // it; drag it onto the empty part of the list to take it out again.
      item.draggable = true;
      item.dataset.path = s.path;
      item.addEventListener('dragstart', (e) => {
        dragSession = s.path;
        item.classList.add('dragging');
        try { e.dataTransfer.setData('text/plain', s.path); e.dataTransfer.effectAllowed = 'move'; } catch { /* synthetic or older browsers */ }
      });
      item.addEventListener('dragend', () => {
        dragSession = null;
        item.classList.remove('dragging');
        document.querySelectorAll('.session-folder.drop, .session-item.drop-line').forEach((n) => n.classList.remove('drop', 'drop-line'));
      });
      item.addEventListener('dragover', (e) => {
        if (!dragSession || dragSession === s.path) return;
        e.preventDefault();
        item.classList.add('drop-line');
      });
      item.addEventListener('dragleave', () => item.classList.remove('drop-line'));
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        item.classList.remove('drop-line');
        if (!dragSession || dragSession === s.path) return;
        const fid = folderOf.get(s.path) || null;
        if (fid) assignToFolder(dragSession, fid, s.path);
      });
      list.appendChild(item);
  };

  for (const f of folders) {
    const kids = shown.filter((x) => folderOf.get(x.path) === f.id);
    if (filter && !kids.length) continue;          // while searching, empty folders are noise
    list.appendChild(folderHeader(f, kids.length));
    if (!collapsedFolders[f.id]) for (const k of kids) addRow(k);
  }
  for (const x of shown) if (!inFolder.has(x.path)) addRow(x);
  // Put the reader back on the row they were looking at, not on the pixel they
  // happened to be at. See sessionListAnchor above.
  restoreSessionListAnchor(list, anchor, keepScroll);
}

/* ── session folders ──────────────────────────────────────────────────────
 * Hand-organised groups of sessions: create, rename, drag sessions in, drag the
 * folders into the order you want. The folders live in the bridge's settings, so
 * they are the same whatever browser or machine you open the UI from - and they
 * are kept *per instance*: a folder list holding this machine's session paths has
 * no meaning over another instance's sessions (they are different files), so the
 * other instance simply has its own. The sets are stored locally, keyed by that
 * instance's origin; its own settings are never written to. */
function instanceKey() { return S.remote || location.origin; }

function sessionFolders() {
  const m = SET.sessionFoldersByInstance || {};
  const list = m[instanceKey()];
  if (Array.isArray(list)) return list;
  // The single list from before folders were per instance: adopt it for this
  // machine (and only this one) rather than showing no folders at all.
  migrateFolders();
  const after = (SET.sessionFoldersByInstance || {})[instanceKey()];
  return Array.isArray(after) ? after : [];
}

function ensureFolders() {
  const key = instanceKey();
  const m = SET.sessionFoldersByInstance || (SET.sessionFoldersByInstance = {});
  if (!Array.isArray(m[key])) m[key] = [];
  return m[key];
}

function setFolders(list) {
  const m = SET.sessionFoldersByInstance || (SET.sessionFoldersByInstance = {});
  m[instanceKey()] = (list || []).filter((f) => f && f.id);
  saveSettings();
}

/* Folders used to be one list for everything. Keep them as this machine's when
 * the per-instance store is still empty. */
function migrateFolders() {
  if (SET.sessionFoldersByInstance || !Array.isArray(SET.sessionFolders) || !SET.sessionFolders.length) return;
  SET.sessionFoldersByInstance = { [location.origin]: SET.sessionFolders };
  saveSettings();
}

function saveFolders() {
  setFolders(sessionFolders().filter((f) => f && f.id));
  syncSessionHighlight();
}

function newFolder(name, beforeId) {
  const f = { id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: name || 'new folder', paths: [] };
  const list = ensureFolders();
  const at = beforeId ? list.findIndex((x) => x.id === beforeId) : -1;
  if (at >= 0) list.splice(at, 0, f); else list.push(f);
  saveFolders();
  return f;
}

async function addFolderDialog() {
  const out = await askDialog({
    title: 'New folder',
    body: 'Sessions you drag into it stay in this browser setup, not in the agent.',
    fields: [{ name: 'name', label: 'name', value: 'new folder' }],
    okLabel: 'create',
    require: ['name'],
  });
  if (!out) return;
  newFolder(out.name);
}

function toggleFolder(id) {
  const c = S.collapsedFolders || (S.collapsedFolders = {});
  c[id] = !c[id];
  try { localStorage.setItem('piwebui-folders-collapsed', JSON.stringify(c)); } catch { /* private mode */ }
  syncSessionHighlight();
}

/* One session (or none) moving into a folder, or a folder being reordered. */
function assignToFolder(path, folderId, beforePath) {
  if (!path) return;
  const folders = ensureFolders();
  for (const f of folders) f.paths = (f.paths || []).filter((p) => p !== path);
  const target = folders.find((f) => f.id === folderId);
  if (target) {
    const at = beforePath ? (target.paths || []).indexOf(beforePath) : -1;
    if (!target.paths) target.paths = [];
    if (at >= 0) target.paths.splice(at, 0, path); else target.paths.push(path);
  }
  saveFolders();
  // The folder stays exactly as it was - closed stays closed. Opening it here
  // meant a drag that was meant to file one session away rearranged the whole
  // list under the pointer, and the session you had just filed vanished into a
  // folder you were not looking at. The count badge moves instead, which is
  // the confirmation that it landed.
  toast(`Moved to “${(folders.find((f) => f.id === folderId) || {}).name || 'folder'}”`);
}

/* Dropping one folder onto another swaps the two: the dragged one lands exactly
 * where the other was, which is the one rule that is easy to predict while
 * dragging. (Inserting before it looks like nothing happened whenever the
 * dragged folder was already earlier in the list.) */
function reorderFolder(id, ontoId) {
  if (!id || !ontoId || id === ontoId) return;
  const folders = sessionFolders();
  const from = folders.findIndex((f) => f.id === id);
  const to = folders.findIndex((f) => f.id === ontoId);
  if (from < 0 || to < 0) return;
  const [moved] = folders.splice(from, 1);
  folders.splice(to, 0, moved);
  saveFolders();
}

function openFolderMenu(f, row) {
  const count = (f.paths || []).length;
  openMenu(row, [
    { label: 'rename…', hint: f.name, onPick: async () => {
      const out = await askDialog({ title: 'Rename folder', fields: [{ name: 'name', label: 'name', value: f.name }], okLabel: 'rename', require: ['name'] });
      if (!out) return;
      f.name = out.name;
      saveFolders();
    } },
    { label: 'new folder below', onPick: () => newFolder('new folder', null) },
    { label: count ? `empty it (${count} session${count > 1 ? 's' : ''})` : 'it is already empty', danger: false, onPick: () => {
      if (!count) return;
      f.paths = [];
      saveFolders();
      toast(`“${f.name}” emptied — the sessions are back in the list`);
    } },
    { sep: true },
    { label: 'delete the folder', hint: 'the sessions stay', danger: true, onPick: () => {
      setFolders(sessionFolders().filter((x) => x.id !== f.id));
      saveFolders();
      toast(`Deleted “${f.name}”`);
    } },
  ], { title: f.name, width: 340, force: true, align: 'right' });
}

/* The folder row in the sidebar: caret, name, how many, and the drop targets. */
function folderHeader(f, count) {
  const row = el('div', 'session-folder');
  row.dataset.folder = f.id;
  const open = !(S.collapsedFolders || {})[f.id];
  row.appendChild(el('span', 'folder-caret', open ? '▾' : '▸'));
  row.appendChild(el('span', 'folder-name', f.name || 'folder'));
  row.appendChild(el('span', 'folder-count', String(count)));
  row.title = `${f.name} — ${count} session${count === 1 ? '' : 's'}
click to fold, drag a session here, right-click to rename`;
  // Dragging one folder onto another reorders them.
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    dragFolder = f.id;
    row.classList.add('dragging');
    try { e.dataTransfer.setData('text/plain', `folder:${f.id}`); e.dataTransfer.effectAllowed = 'move'; } catch { /* synthetic events */ }
  });
  row.addEventListener('dragend', () => {
    dragFolder = null;
    row.classList.remove('dragging');
    document.querySelectorAll('.session-folder.drop').forEach((n) => n.classList.remove('drop'));
  });
  row.onclick = () => toggleFolder(f.id);
  row.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); openFolderMenu(f, row); };
  row.addEventListener('dragover', (e) => {
    if (!dragSession && !dragFolder) return;
    e.preventDefault();
    row.classList.add('drop');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop'));
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    row.classList.remove('drop');
    if (dragFolder) { reorderFolder(dragFolder, f.id); return; }
    if (dragSession) assignToFolder(dragSession, f.id);
  });
  return row;
}

let dragSession = null;
let dragFolder = null;

/* (updateBranchesBtn() lived here - an empty function still called from
 * applyState, left from when the sidebar kept a fork count. Forks are rows in
 * the list now and the bridge keeps subagent transcripts out of it, so there was
 * nothing to update and no reason to keep the call.) */

$('session-filter').oninput = () => refreshSessions(true);
$('btn-refresh-sessions').onclick = () => refreshSessions(true);
$('btn-new-folder').onclick = () => addFolderDialog();

/* Rapid switching.
 *
 * Two faults, and they are two halves of the same mistake - treating every click
 * as its own switch rather than as "the user wants to end up here".
 *
 *  1. Each click sent its own `switch_session`. pi answers one at a time and a
 *     switch costs it over a second on a long session, so ten clicks queued ten
 *     switches and the agent was busy for the next fifteen seconds - during which
 *     nothing else it was asked would be answered. Only the last click matters,
 *     so the intermediate ones are dropped: while a switch is running, a newer
 *     target replaces the pending one and is run when the current one finishes.
 *
 *  2. A superseded switch could still apply its result. `get_state` answers about
 *     whichever session pi is in when it gets round to answering, so an older
 *     switch landing late set S.state.sessionFile back to the older session: the
 *     highlight jumped to the wrong row and corrected itself once the newer
 *     switch finished. Reported as "visually selects a different session".
 *     Every switch carries a generation now and a stale one applies nothing.
 */
let switchGen = 0;            // who owns the view; the newest click
let switchSend = null;        // the in-flight agent-side switch loop, or null
let switchWanted = null;      // the newest target asked for while a switch was in flight

/* Move the agent into a session, one switch at a time, newest target wins.
 *
 * pi answers one request at a time, so several switches sent at once are several
 * switches it works through in order - that is what made the bridge look dead in
 * issue #34, and it is why only the newest target is sent: while one is in
 * flight the target is replaced rather than queued.
 *
 * The waiting is deliberately confined to this one call. Every earlier version
 * of the guard around it (switchRunning / switchWanted) parked the whole switch,
 * so a second click did not even move the highlight or start reading its file
 * until the first switch had finished everything - "switching sessions while one
 * is loading won't stop the first one so you have to wait for the first one to
 * finish", issue #39. Bumping the generation is what stops the first one; this
 * function only serialises the part that has to be serialised. */
function requestAgentSwitch(target) {
  switchWanted = target;
  if (!switchSend) {
    switchSend = (async () => {
      try {
        while (switchWanted) {
          const next = switchWanted;
          switchWanted = null;
          try {
            await rpc({ type: 'switch_session', sessionPath: next });
          } catch (err) {
            // A newer click has replaced this target, so this refusal is about a
            // session nobody is waiting for any more - carry on to the newest.
            if (switchWanted && switchWanted !== next) continue;
            throw err;
          }
        }
      } finally { switchSend = null; }
    })();
  }
  return switchSend;
}

async function switchToSession(sessionPath) {
  const agentSession = S.state.sessionFile;
  if (sessionPath === agentSession) {
    if (!S.viewSession) return; // already here
    // Coming back to the agent's own session: re-render it and re-attach the
    // live view (if the agent is still running).
    S.viewSubagent = null;
    S.viewSession = null;
    await refreshMessages();
    updateViewBanner();
    updateSubagentsBtn();
    syncSessionHighlight();
    return;
  }
  if (S.isStreaming) {
    // The agent is running in its own session. Keep it running in the
    // background: park the live DOM (deltas keep landing in it) and view the
    // target session read-only from its file. The green dot in the session
    // list shows which session is still running.
    if (S.live) {
      const frag = document.createDocumentFragment();
      frag.appendChild(S.live.root); // detaches it from the visible chat
      S.liveDetached = { path: agentSession, frag };
    }
    S.viewSubagent = null;
    S.viewSession = sessionPath;
    /* The same supersede rule as the idle path below: this click owns the view,
     * and the read it is about to start must bail out if another click takes
     * over. Without it two quick switches each fetched, each cleared the chat and
     * each painted, so the earlier one could finish last and win - and there was
     * no guard at all on this branch (issue #39). */
    const gen = ++switchGen;
    await renderSessionFromDisk(sessionPath, gen);
    if (switchGen !== gen) return;
    updateSubagentsBtn();
    updateViewBanner();
    syncSessionHighlight();
    return;
  }
  // Agent is idle: move it to the selected session so input works there.

  /* Take the view for this click.
   *
   * Whatever was switching before is superseded from here on: its `superseded()`
   * checks stop it drawing anything more, its transcript read is aborted by the
   * refreshMessages() below (that one already aborted the previous read), and the
   * generation it passes to initSession makes it skip applyState. The click is
   * answered now rather than after the previous switch finished - issue #39. */
  const gen = ++switchGen;
  const superseded = () => switchGen !== gen;
  try {
    /* Start reading the target file *now*, alongside the switch.
     *
     * The file is on disk and the transcript is going to be read from it either
     * way - it does not wait for the agent, and neither does anything else the
     * switch is about to do. Moving the agent into a session took half a second
     * on a long one, and that was half a second of a blank screen in which the
     * bytes could have been on their way. If the switch is refused (a working
     * directory that no longer exists) the read is simply thrown away. */
    const prefetch = { path: sessionPath, promise: fetchSession(sessionPath).catch(() => null) };
    /* Draw it straight away, and move the agent into it at the same time.
     *
     * The transcript comes from the file, and the file is on disk - it does not
     * wait for the agent, and neither does the render. But both of those were
     * queued behind `switch_session`, which on a long session costs pi a few
     * hundred milliseconds, and behind the `get_state` that followed it. That
     * was the last of the click-to-first-message delay: not the work, the
     * queueing in front of it.
     *
     * The session path is set optimistically so the render has something to
     * attribute itself to, and put back if the switch is refused. */
    const previous = S.state.sessionFile;
    S.state.sessionFile = sessionPath;
    S.viewSubagent = null;
    S.viewSession = null;
    $('session-name').value = '';
    const drawn = refreshMessages(prefetch);
    /* Answer the click straight away.
     *
     * The highlight and the confirmation used to wait for `initSession`, which is
     * eleven refreshes deep - models, levels, commands, the session list, the
     * stats, the transcript. Then they were moved ahead of it but left behind
     * `switch_session`, which on a long session costs pi a second and a half -
     * and that is the whole of the remaining delay: the sidebar sat showing the
     * old session as active and the toast arrived a second and a half later, both
     * of them trailing a transcript that had already drawn.
     *
     * Neither depends on the agent. The path is already set, so the highlight has
     * somewhere to go, and the view has already been drawn from the file. If the
     * switch is refused the error is reported on its own; the view did change,
     * which is what both of these are saying. */
    syncSessionHighlight();
    /* Say what is true at the moment it is said.
     *
     * This is the third form of these two lines, and the reasoning is worth
     * keeping because the first two were both wrong in opposite directions:
     *
     *  1. "Session switched" toasted before the switch was awaited - instant, but
     *     it claimed something that had not happened, so a refused switch
     *     reported success and then failure for the same click (#14).
     *  2. "Session switched" toasted after the await - honest, but it now waits
     *     for pi to move into the session, which on a long one is a second or
     *     more. Reported as "even the session-changed message is delayed".
     *
     * What has already happened by this point is the *view*: the highlight has
     * moved and the transcript has been drawn from the session file, both without
     * the agent. So that is what is announced, immediately, and the confirmation
     * is left to the thing that shows it - the highlight you can see and the
     * conversation that is now on screen. Nothing claims the agent has moved; if
     * it refuses, the error is reported and the view is put back. */
    toast(`Switching to “${String(sessionPath).split(/[\\/]/).pop().replace(/\.jsonl$/, '').slice(0, 48)}”`);
    try {
      await requestAgentSwitch(sessionPath);
    } catch (err) {
      // A newer switch has taken over: this failure is about a session the user
      // has already left, and undoing the guess would undo theirs.
      if (superseded()) return;
      S.state.sessionFile = previous;   // the switch was refused; undo the guess
      await drawn.catch(() => {});
      throw err;
    }
    // Do not apply state from a switch that has been overtaken - that is the
    // wrong-row highlight (see the note above requestAgentSwitch).
    if (superseded()) return;
    await initSession(false, prefetch, drawn, gen);
  } catch (e) {
    // pi refuses to switch to a session whose recorded working directory is
    // gone (usually because the project folder was renamed). Offer to put the
    // folder back so the session can be opened again, instead of dead-ending on
    // a raw error.
    const missing = /working directory does not exist:\s*(.+?)\s*$/im.exec(e.message || '');
    if (missing && missing[1]) {
      const dir = missing[1].trim();
      const ok = confirm(
        `This session was recorded in\n\n${dir}\n\n` +
        'and that folder does not exist any more - it was renamed or moved.\n\n' +
        'Create the folder again so the session can be opened?');
      if (!ok) {
        toast('Session not opened - its recorded folder is missing', 'warning');
        return;
      }
      try {
        const r = await fetch(api('/api/ensure-dir'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: dir }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'could not create it');
        await rpc({ type: 'switch_session', sessionPath });
        S.state.sessionFile = sessionPath;
        S.viewSubagent = null;
        S.viewSession = null;
        $('session-name').value = '';
        await initSession(false);
        toast('Session opened - its old folder was recreated');
      } catch (e2) {
        toast(`Still could not open it: ${e2.message}`, 'error');
      }
      return;
    }
    toast(`Switch failed: ${e.message}`, 'error');
  }
}

// Read-only render of another session's transcript straight from its file.
async function renderSessionFromDisk(sessionPath, gen) {
  // Nothing here touches the DOM until the file has arrived, and by then the
  // click that asked for it may have been replaced - in which case this read is
  // stale and must not clear the chat the new one is drawing into.
  const superseded = () => gen !== undefined && switchGen !== gen;
  try {
    const d = await fetchSession(sessionPath);
    if (superseded()) return;
    const msgs = d.messages;
    const distFromBottom = chatScroller().scrollHeight - chatScroller().scrollTop - chatScroller().clientHeight;
    chat.innerHTML = '';
    transcriptTarget = chat;
    for (const m of msgs) {
      if (m.role === 'user') renderUserMessage(m);
      else if (m.role === 'assistant') renderAssistantMessage(m);
      else if (m.role === 'toolResult') renderToolResult(m);
      else if (m.role === 'bashExecution') renderBashExecution(m);
      else if (m.role === 'compactionSummary') renderCompactionSummary(m);
    }
    transcriptTarget = null;
    // Put the file's compaction markers back where they happened.
    if (d.compactions.length) {
      const plain = [...chat.querySelectorAll('.msg:not(.compaction)')];
      for (const k of d.compactions) {
        let target = null;
        for (const n of plain) {
          const ts = Number(n.dataset.ts);
          if (k.at && ts && ts <= k.at) target = n;
        }
        const node = buildCompactionSummary(k, { live: true, count: d.compactions.length });
        if (target) target.after(node);
        else if (plain.length) plain[0].before(node);
        else chat.appendChild(node);
      }
    }
    if (S.stickToBottom) scrollBottom(true);
    else chatScroller().scrollTop = chatScroller().scrollHeight - chatScroller().clientHeight - distFromBottom;
  } catch (e) {
    toast(`Could not load session: ${e.message}`, 'error');
  }
}

$('btn-new-session').onclick = async () => {
  try {
    await rpc({ type: 'new_session' });
    await initSession(false);
    // The file for a fresh session does not exist yet, so the list has nothing
    // to show. Re-check shortly (and after the first message lands) as well.
    refreshSessions(true).catch(() => {});
    setTimeout(() => refreshSessions(true).catch(() => {}), 700);
    toast('New session started');
  } catch (e) { toast(e.message, 'error'); }
};

$('session-name').addEventListener('change', async (e) => {
  const name = e.target.value.trim();
  if (!name) return;
  try {
    await rpc({ type: 'set_session_name', name });
    await refreshSessions(true);
    toast('Session renamed');
  } catch (err) { toast(err.message, 'error'); }
});

/* ───────────────────────── model / thinking selects ───────────────────────── */

$('model-select').onchange = async (e) => {
  // llama.cpp entries use "provider||modelId" because the provider id itself
  // contains colons (llama-server=http://host:8080).
  let provider, modelId;
  const sep = e.target.value.indexOf('||');
  if (sep >= 0) {
    provider = e.target.value.slice(0, sep);
    modelId = e.target.value.slice(sep + 2);
  } else {
    [provider, ...rest] = e.target.value.split(':');
    modelId = rest.join(':');
  }
  let isLlama = provider.startsWith('llama-server=') || /:\/\//.test(String(modelId || ''));
  // A value can lose its "||" (an older page, a value from storage): then the model
  // id carries the server URL ("llama-server=http://host:8080/Model" arrived as the
  // model), and set_model answers "Model not found: llama-server=http://host:8080/Model".
  if (isLlama) {
    const repaired = splitGluedModel(provider, modelId);
    if (repaired) { provider = repaired.provider; modelId = repaired.modelId; }
    // and use the id pi actually has for this server/model (per-model ids included)
    const srv = llamaServerForProvider(provider);
    if (srv) {
      const better = llamaProviderFor(srv, modelId);
      if (better) provider = better;
    }
    isLlama = provider.startsWith('llama-server=');
  }
  // If pi has not registered this llama provider yet (its configured URL is
  // dead), point pi at the live server, restart the agent, then retry.
  if (isLlama && !S.models.some((m) => m.provider === provider)) {
    const live = llamaServerForProvider(provider);
    const all = (llamaLiveServers.length ? llamaLiveServers : [live]);
    if (live && confirm(`pi has not registered the llama.cpp server at ${live.url} yet.\n\nPoint pi at ${all.length > 1 ? `all ${all.length} live servers` : 'it'} and restart the agent? (writes llamaSettings.servers in your pi config)`)) {
      S.pendingModel = { provider, modelId };
      fixLlamaConfig(all.map((x) => x.url));
    }
    return;
  }
  if (/:\/\//.test(String(modelId || ''))) {
    toast(`That model entry is malformed (${String(modelId).slice(0, 60)}…) — the list is stale, close and reopen the model menu`, 'error');
    return;
  }
  try {
    await rpc({ type: 'set_model', provider, modelId });
    // The thinking levels are re-read by applyState, which notices the model
    // changed and refreshes the list (twice, because pi can still be settling
    // when set_model returns). Nothing to add here.
    await rpc({ type: 'get_state' }).then(applyState);
    toast(isLlama ? 'Model switched — loading into llama.cpp…' : 'Model switched');
  } catch (err) {
    toast(err.message + (isLlama
      ? ' — pi does not know this model yet. If the llama.cpp banner is showing, use "Point pi here & reload", or type /models in the chat'
      : ''), 'error');
  }
};

$('thinking-select').onchange = async (e) => {
  const wanted = e.target.value;
  try {
    const d = await rpc({ type: 'set_thinking_level', level: wanted });
    // The button is the only part of this control you can actually see (the
    // select is hidden), and it was refreshed by the full state sync alone - so
    // a new level showed up on the next page load and not before.
    if (d && d.thinkingLevel) syncSelect($('thinking-select'), d.thinkingLevel);
    updateThinkingBtn();
    toast(`Thinking level: ${$('thinking-select').value}`);
  } catch (err) {
    toast(err.message, 'error');
    // Put the old value back: the select had already been moved by the menu.
    rpc({ type: 'get_state' }).then(applyState).catch(() => {});
  }
};

/* ───────────────────────── extension UI protocol ───────────────────────── */

function handleExtensionUi(req) {
  const stripAnsi = (s) => String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  switch (req.method) {
    case 'notify':
      toast(stripAnsi(req.message), req.notifyType === 'error' ? 'error' : req.notifyType === 'warning' ? 'warning' : 'info');
      break;
    case 'setStatus': {
      const bar = $('status-bar');
      // A key cleared with an empty text removes that line; the bar stays up
      // while anything is left (and for a moment after the last line goes).
      const key = req.statusKey || 'status';
      const text = stripAnsi(req.statusText || '').trim();
      if (text) bar.dataset[key] = text; else delete bar.dataset[key];
      setBarContent(bar, Object.values(bar.dataset).join(' · '));
      break;
    }
    case 'setWidget': {
      const bar = $('widget-bar');
      // The pi-subagents extension publishes its live runs as a widget whose
      // single line is `PI_SUBAGENT_ASYNC_JSON:{…}`. It is data for the panel
      // below, not text for the widget bar (it used to be printed there as a
      // wall of JSON).
      const raw = (req.widgetLines || []).map(stripAnsi);
      for (const line of raw) {
        const i = line.indexOf('PI_SUBAGENT_ASYNC_JSON:');
        if (i >= 0) {
          try { setSubagentSnapshot(JSON.parse(line.slice(i + 'PI_SUBAGENT_ASYNC_JSON:'.length))); } catch { /* partial line */ }
        }
        const j = line.indexOf('PI_SUBAGENT_INSPECT_JSON:');
        if (j >= 0) {
          try { noteSubagentInspect(JSON.parse(line.slice(j + 'PI_SUBAGENT_INSPECT_JSON:'.length))); } catch { /* partial line */ }
        }
      }
      const lines = raw.filter((l) => l && l.trim()
        && l.indexOf('PI_SUBAGENT_ASYNC_JSON:') < 0 && l.indexOf('PI_SUBAGENT_INSPECT_JSON:') < 0);
      if (lines.length) bar.dataset[req.widgetKey] = lines.join('\n');
      else delete bar.dataset[req.widgetKey];
      setBarContent(bar, Object.values(bar.dataset).join('\n'));
      break;
    }
    case 'setTitle':
      document.title = `${stripAnsi(req.title) || 'Pi Agent'}`;
      break;
    case 'set_editor_text':
      input.value = req.text || '';
      autoSize();
      input.focus();
      break;
    case 'select':
    case 'confirm':
    case 'input':
    case 'editor':
      showExtensionDialog(req);
      break;
    default:
      // Unknown request: respond cancelled so the agent doesn't block forever.
      send({ type: 'extension_ui_response', id: req.id, cancelled: true });
  }
}

function showExtensionDialog(req) {
  const dlg = $('ext-dialog');
  const body = $('ext-dialog-body');
  const cancel = $('ext-dialog-cancel');
  const ok = $('ext-dialog-ok');
  body.innerHTML = '';
  cancel.classList.remove('hidden');
  ok.textContent = 'OK';

  $('ext-dialog-title').textContent = req.title || 'Agent';
  const message = $('ext-dialog-message');
  if (req.message) { message.textContent = req.message; message.classList.remove('hidden'); }
  else message.classList.add('hidden');

  let control = null;
  let getVal = () => undefined;

  if (req.method === 'select') {
    control = el('select');
    for (const opt of req.options || []) {
      const o = el('option', null, typeof opt === 'string' ? opt : (opt.label || opt.value));
      o.value = typeof opt === 'string' ? opt : (opt.value ?? opt.label);
      control.appendChild(o);
    }
    body.appendChild(control);
    getVal = () => ({ value: control.value });
    ok.textContent = 'Select';
  } else if (req.method === 'confirm') {
    getVal = () => ({ confirmed: true });
    ok.textContent = 'Confirm';
  } else if (req.method === 'input') {
    control = el('input');
    control.placeholder = req.placeholder || '';
    body.appendChild(control);
    getVal = () => ({ value: control.value });
  } else if (req.method === 'editor') {
    control = el('textarea');
    control.value = req.prefill || '';
    body.appendChild(control);
    getVal = () => ({ value: control.value });
    ok.textContent = 'Save';
  }

  const done = (response) => {
    dlg.close();
    send({ type: 'extension_ui_response', id: req.id, ...response });
  };
  ok.onclick = () => done(getVal());
  cancel.onclick = () => done({ cancelled: true });
  dlg.oncancel = (e) => { e.preventDefault(); done({ cancelled: true }); };

  dlg.showModal();
  if (control) control.focus();
}

/* ───────────────────────── toasts / banner / misc ───────────────────────── */

/* ── notifications and errors, kept ──────────────────────────────────────
 * A toast is gone five seconds later, and the one that mattered (the agent
 * failed, the upload was refused, another instance stopped answering) is exactly
 * the one you were not looking at. Everything the app reports also goes here,
 * with the time, and the bell in the top bar shows them. */
/* Notifications raised by a slash command open the panel (issue #5).
 *
 * "Same as issue #4" - so the rule is: a notice that the user's own slash
 * command produced opens the notifications panel, because that is the thing they
 * just asked for and a five-second toast is easy to miss. Background notices
 * (an extension erroring while a run is going, an upload being refused) do not,
 * or the panel would be opening on its own constantly. The flag is set only
 * around the slash-command handling in sendCurrent(). */
function notice(text, kind = 'info', detail) {
  try {
    if (!S.notices) S.notices = [];
    S.notices.push({ t: Date.now(), text: String(text).slice(0, 500), kind, detail: detail ? String(detail).slice(0, 800) : null });
    if (S.notices.length > 200) S.notices.splice(0, S.notices.length - 200);
    S.noticesUnread = (S.noticesUnread || 0) + 1;
    updateBell();
    if (S.noticesFromCommand) {
      S.noticesFromCommand = false;
      openNoticesDialog();
    }
  } catch { /* never let logging break the thing being logged */ }
}

function updateBell() {
  const btn = $('btn-bell');
  if (!btn) return;
  const unread = S.noticesUnread || 0;
  const badge = $('bell-count');
  if (badge) {
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.classList.toggle('hidden', unread === 0);
  }
  btn.classList.toggle('has-error', (S.notices || []).some((x) => x.kind === 'error'));
}

/* The notifications panel (issues #4 and #5).
 *
 * It was a dropdown anchored to the bell in the top-right. It is now a dialog in
 * the middle of the window with the text at the chat font size and a Done button,
 * which is what the settings dialog does - the shape that was asked for.
 *
 * Opening it no longer clears the unread badge immediately: the badge is cleared
 * when it closes, so the mark stays while you are reading rather than being spent
 * the instant the panel appears. */
function noticeRows() {
  return (S.notices || []).slice().reverse();
}

function renderNotices() {
  const list = $('notices-list');
  if (!list) return;
  list.innerHTML = '';
  const rows = noticeRows();
  if (!rows.length) {
    list.appendChild(el('div', 'notice-empty', 'Nothing yet. Notifications and errors show up here.'));
    return;
  }
  for (const n of rows.slice(0, 300)) {
    const at = new Date(n.t);
    const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const day = at.toDateString() === new Date().toDateString() ? '' : `${at.toLocaleDateString()} `;
    const row = el('div', `notice-row${n.kind === 'error' ? ' error' : ''}`);
    row.appendChild(el('span', 'n-time', `${day}${time}`));
    row.appendChild(el('span', 'n-text', n.text));
    if (n.kind && n.kind !== 'info') row.appendChild(el('span', 'n-kind', n.kind));
    row.title = n.detail ? 'Click to copy the details' : n.text;
    row.onclick = () => { if (n.detail) copyText(n.detail, 'Copied the details'); };
    list.appendChild(row);
  }
}

function openNoticesDialog() {
  const dlg = $('notices-dialog');
  if (!dlg) return;
  renderNotices();
  const sub = $('notices-sub');
  if (sub) {
    const n = (S.notices || []).length;
    sub.textContent = n
      ? `${n} notification${n === 1 ? '' : 's'}, newest first. Click a row to copy its details.`
      : 'Everything the app reports shows up here.';
  }
  if (!dlg.open) dlg.showModal();
}

function closeNoticesDialog() {
  const dlg = $('notices-dialog');
  if (dlg && dlg.open) dlg.close();
}

/* Kept for the callers that used to open the dropdown. */
function openBellMenu() { openNoticesDialog(); }

/* (The dropdown builder that lived here is replaced by renderNotices above. The
 * panel keeps every affordance it had - newest first, the time and the kind on
 * each row, click-to-copy, and a clear button - and gains the size and the Done
 * button the issue asked for.) */

/* A failure that would otherwise only reach the developer console. */
window.addEventListener('error', (e) => {
  if (e && e.target && e.target.tagName && /^(IMG|VIDEO|SCRIPT|LINK)$/.test(e.target.tagName)) {
    notice(`${e.target.tagName.toLowerCase()} failed to load: ${String(e.target.src || e.target.href || '').split('/').pop()}`, 'error');
    return;
  }
  notice(`Error: ${(e && e.message) || 'unknown'}`, 'error', (e && e.error && e.error.stack) || null);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  const text = r && r.message ? r.message : String(r);
  if (/abort/i.test(text)) return;      // our own aborted fetches
  notice(`Unhandled: ${text}`, 'error', (r && r.stack) || null);
});

/* Routine bookkeeping: worth showing in the corner, not worth keeping. Switching
 * session or instance happens constantly while you work, and each one added an
 * entry to the notification list - so the list became a log of "Session switched"
 * with the actual errors buried in it. */
const QUIET_TOASTS = [
  /^Session switched$/,
  /^Switching to /,
  /^Back to this machine$/,
  /^Looking at .+ \(through this machine\)$/,
];

function toast(text, kind = 'info') {
  if (!QUIET_TOASTS.some((r) => r.test(String(text)))) notice(text, kind);
  const t = el('div', `toast ${kind}`, text);
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

function showBanner(kind, text, btnLabel, fn, onDismiss) {
  const b = $('banner');
  b.className = `banner ${kind}`;
  b.innerHTML = '';
  b.appendChild(el('span', null, text));
  if (btnLabel) {
    const btn = el('button', 'btn small', btnLabel);
    btn.onclick = () => { hideBanner(); fn(); };
    b.appendChild(btn);
  }
  // Anything that comes back on its own has to be dismissible - and the dismissal
  // has to be remembered, or the same banner returns on the next poll.
  if (onDismiss) {
    const x = el('button', 'btn small banner-x', '✕');
    x.title = 'dismiss (it stays dismissed)';
    x.onclick = () => { hideBanner(); onDismiss(); };
    b.appendChild(x);
  }
}

function hideBanner() {
  const b = $('banner');
  b.className = 'banner hidden';
}

function setConn(mode) {
  const d = $('conn-dot');
  d.className = `conn-dot ${mode}`;
  d.title = mode === 'on' ? 'Connected' : mode === 'busy' ? 'Agent is streaming' : 'Disconnected';
}

$('btn-toggle-sidebar').onclick = () => {
  if (window.matchMedia('(max-width: 760px)').matches) $('sidebar').classList.toggle('open');
  else document.body.classList.toggle('sidebar-hidden');
};

/* collapsible code boxes: one delegated listener for all rendered markdown */
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.code-toggle');
  if (!btn) return;
  const box = btn.closest('.codebox');
  box.classList.toggle('collapsed');
  btn.textContent = box.classList.contains('collapsed') ? '+' : '\u2212';
});

/* Periodically poll the session list while idle.
 *
 * The poll itself is cheap, but what it did with the answer was not: it rebuilt
 * the whole sidebar from scratch every twenty seconds, which meant re-creating
 * every row, losing whatever was hovered or focused, and re-running layout and
 * paint over a list that had not changed by a single character. refreshSessions
 * now compares the payload first and only re-renders when the name, the size or
 * the modification time of a session actually moved, so a quiet sidebar costs
 * one JSON parse and nothing else. A hidden tab is not polled at all. */
setInterval(() => {
  if (S.isStreaming) return;
  if (document.visibilityState !== 'visible') return;
  refreshSessions();
}, 20000);

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

function openSettings() {
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
  const legacyMode = { split: 'panel', popup: 'window' }[SET.shortsMode] || SET.shortsMode;
  $('set-shorts-mode').value = (legacyMode === 'tab' || legacyMode === 'window') ? legacyMode : 'panel';
  $('set-auto-continue').checked = SET.autoContinueAfterCompaction !== false;
  populateTtsVoiceSelect();
  loadPiProviders();
  loadAuthProviders();
  loadExtensionsTab();
  prettifySettingsSelects();
  $('settings-dialog').showModal();
}

$('btn-settings').onclick = openSettings;
$('settings-close').onclick = () => $('settings-dialog').close();

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
wireVoiceSettings();
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

let cursorApplied = { src: '', size: 0, url: '' };   // what is in the CSS right now
let cursorDrawing = false;

function cursorImageLoads(src) {
  return new Promise((resolve) => {
    const img = new Image();
    const done = (ok, w, h) => { img.onload = null; img.onerror = null; resolve({ ok, w, h }); };
    img.onload = () => done((img.naturalWidth || 0) > 0, img.naturalWidth, img.naturalHeight);
    img.onerror = () => done(false, 0, 0);
    setTimeout(() => done(false, 0, 0), 5000);
    img.src = src;
  });
}

function writeCursorVar(url, hx, hy) {
  const root = document.documentElement;
  root.style.setProperty('--cursor', `url("${url}") ${hx} ${hy}, auto`);
  root.classList.add('custom-cursor');
}

function applyCustomCursor() {
  const root = document.documentElement;
  const src = (SET.cursorImage || '').trim();
  if (!src) {
    cursorApplied = { src: '', size: 0, url: '' };
    root.classList.remove('custom-cursor');
    root.style.removeProperty('--cursor');
    return;
  }
  if (/["\\\n\r]/.test(src)) {
    // a quote or a backslash would end the url("...") token and produce a rule
    // that does not parse - the same invisible nothing
    cursorApplied = { src: '', size: 0, url: '' };
    root.classList.remove('custom-cursor');
    root.style.removeProperty('--cursor');
    return;
  }
  const size = Math.max(8, Math.min(CURSOR_MAX, Number(SET.cursorSize) || 32));
  const hx = Math.max(0, Math.min(size - 1, Number(SET.cursorHotX) || 0));
  const hy = Math.max(0, Math.min(size - 1, Number(SET.cursorHotY) || 0));

  // a remote picture is used as it is: drawing a cross-origin image taints the
  // canvas and toDataURL then throws
  if (/^https?:/i.test(src)) {
    cursorApplied = { src, size, url: src };
    writeCursorVar(src, hx, hy);
    return;
  }
  // already normalised for exactly this source and size? nothing to redraw
  if (cursorApplied.url && cursorApplied.src === src && cursorApplied.size === size) return;
  // put the original up straight away, so there is no dead time while it draws
  cursorApplied = { src, size, url: src };
  writeCursorVar(src, hx, hy);
  drawNormalisedCursor(src, size, hx, hy);
}

function drawNormalisedCursor(src, size, hx, hy) {
  if (cursorDrawing) return;                 // one draw at a time; the last one wins
  cursorDrawing = true;
  const img = new Image();
  const giveUp = () => {
    cursorDrawing = false;
    // whatever is up now stays up - a remote or odd picture is still better
    // than no pointer at all
  };
  img.onload = () => {
    try {
      const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      if (!w || !h) { giveUp(); return; }
      // the source may have moved on while this was drawing
      if ((SET.cursorImage || '').trim() !== src) { cursorDrawing = false; applyCustomCursor(); return; }
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const g = c.getContext('2d');
      // letterbox rather than crop: a cursor picture is a sprite, and cutting its
      // corners off to make it square would put the wrong pixel under the pointer
      const sc = Math.min(size / w, size / h);
      const dw = w * sc, dh = h * sc;
      const offX = Math.round((size - dw) / 2), offY = Math.round((size - dh) / 2);
      g.drawImage(img, offX, offY, dw, dh);
      const out = c.toDataURL('image/png');
      // the hotspot is in the *drawn* picture, not the source, and must land
      // inside it or the engine drops the whole thing
      const rx = Math.max(0, Math.min(size - 1, Math.round(hx * sc) + offX));
      const ry = Math.max(0, Math.min(size - 1, Math.round(hy * sc) + offY));
      cursorDrawing = false;
      cursorApplied = { src, size, url: out };
      writeCursorVar(out, rx, ry);
    } catch (e) {
      giveUp();   // a tainted canvas: keep the original
    }
  };
  img.onerror = () => giveUp();
  img.src = src;
}

/* Check the picture and report. Called after every change to cursorImage, not
 * from applySettings (which runs on unrelated settings too and must not redraw
 * an image on each one). */
/* Dragging the size slider redraws the picture on every step, so the note (which
 * reports the size actually drawn) is refreshed once the dragging stops rather
 * than on each step. */
let cursorNoteTimer = null;
function cursorNoteTimerSoon() {
  if (cursorNoteTimer) clearTimeout(cursorNoteTimer);
  cursorNoteTimer = setTimeout(() => { cursorNoteTimer = null; verifyCustomCursor(); }, 350);
}

async function verifyCustomCursor() {
  const src = (SET.cursorImage || '').trim();
  const note = $('cursor-note');
  const say = (t) => { if (note) note.textContent = t; };
  if (!src) { say(''); return true; }
  const seen = await cursorImageLoads(src);
  if (!seen.ok) {
    document.documentElement.classList.remove('custom-cursor');
    cursorApplied = { src: '', size: 0, url: '' };
    say('That picture could not be loaded, so the pointer was left at the normal one. A browser only draws a cursor it can actually decode, and it says nothing when it cannot — use a PNG.');
    return false;
  }
  if (seen.w > CURSOR_MAX || seen.h > CURSOR_MAX) {
    say(`Your picture is ${seen.w}×${seen.h}. A browser drops a CSS cursor larger than ${CURSOR_MAX}×${CURSOR_MAX} without saying anything, so it is redrawn at ${cursorApplied.size || CURSOR_MAX}px and written out as a PNG.`);
  } else {
    say(`Applied — ${cursorApplied.size}px, written as a PNG so the browser will use it. The hotspot is the pixel that sits on the real pointer tip.`);
  }
  return true;
}

let cropState = null;

/* Older crops stored object-position percentages; convert them on the way in. */
function normalizeCrop(crop) {
  if (!crop) return null;
  if (crop.v === 2) return crop;
  const f = (p) => Math.max(-1, Math.min(1, ((p == null ? 50 : Number(p)) - 50) / 50));
  return { v: 2, fx: f(crop.x), fy: f(crop.y), z: Math.max(1, Number(crop.z) || 1) };
}

function cropRatios(node, frameAspect) {
  const nw = node.naturalWidth || node.videoWidth || 0;
  const nh = node.naturalHeight || node.videoHeight || 0;
  const a = frameAspect || 1;
  if (!nw || !nh) return { cw: 1, ch: 1, ready: false };
  const b = nw / nh;
  return { cw: Math.max(1, b / a), ch: Math.max(1, a / b), ready: true };
}

function applyCrop(node, crop, frameAspect) {
  if (!node) return;
  const c = normalizeCrop(crop);
  const nw = node.naturalWidth || node.videoWidth || 0;
  const nh = node.naturalHeight || node.videoHeight || 0;
  if (!c || !nw || !nh) {
    node.style.width = '';
    node.style.height = '';
    node.style.objectPosition = '';
    node.style.transform = '';
    return;
  }
  const { cw, ch } = cropRatios(node, frameAspect);
  const z = Math.max(1, Number(c.z) || 1);
  // The element is sized to the cover rect of its frame (E = cw·B) and the frame
  // wrapper clips it. object-fit content is clipped to the element box, so
  // translating a box the same size as the frame dragged it away from under its
  // own picture and left black gaps - the picture has to be bigger than the
  // frame and move inside it.
  node.style.width = `${cw * 100}%`;
  node.style.height = `${ch * 100}%`;
  node.style.objectPosition = '50% 50%';
  // Pan range at zoom z is (z·E − B)/2, which as a share of the element is
  // 50·(z − B/E) = 50·(z − 1/cw). Negative because moving the visible window to
  // the right means moving the picture to the left.
  const tx = -(Number(c.fx) || 0) * 50 * (z - 1 / cw);
  const ty = -(Number(c.fy) || 0) * 50 * (z - 1 / ch);
  node.style.transform = `translate(${tx}%, ${ty}%) scale(${z})`;
}

/* The natural size - and with it the pan ranges - only exists after load. */
function attachCrop(node, crop, frameAspect) {
  applyCrop(node, crop, frameAspect);
  const again = () => applyCrop(node, crop, frameAspect);
  node.addEventListener('load', again);
  node.addEventListener('loadedmetadata', again);
  return node;
}

/* Where the crop frame sits on the stage, and how much the picture can move.
 * Everything is in stage pixels; the frame stays put and the picture moves. */
function cropGeometry() {
  if (!cropState) return null;
  const { node, frame, fx, fy, z } = cropState;
  const stage = $('crop-stage');
  const nw = node.naturalWidth || node.videoWidth || 0;
  const nh = node.naturalHeight || node.videoHeight || 0;
  if (!stage || !nw || !nh) return null;
  const sr = stage.getBoundingClientRect();
  const s = Math.min(sr.width / nw, sr.height / nh);      // contain fit: whole picture visible
  const b = nw / nh;
  const baseW = b >= frame ? nh * frame : nw;             // biggest frame-shaped rect in the image
  const baseH = b >= frame ? nh : nw / frame;
  const cropW = baseW / z;
  const cropH = baseH / z;
  // How far the crop rect can travel inside the *picture* - using the base rect
  // here instead would leave nothing to pan at zoom 1 and only a fraction of
  // the picture to choose from further in.
  const rangeX = (nw - cropW) / 2;
  const rangeY = (nh - cropH) / 2;
  const cx = nw / 2 + (Number(fx) || 0) * rangeX;
  const cy = nh / 2 + (Number(fy) || 0) * rangeY;
  const left = (sr.width - nw * s) / 2 + (cx - cropW / 2) * s;
  const top = (sr.height - nh * s) / 2 + (cy - cropH / 2) * s;
  return { s, rangeX, rangeY, left, top, w: cropW * s, h: cropH * s };
}

function paintCrop() {
  if (!cropState) return;
  const g = cropGeometry();
  const overlay = $('crop-frame');
  if (g && overlay) {
    overlay.classList.remove('hidden');
    overlay.style.left = `${g.left}px`;
    overlay.style.top = `${g.top}px`;
    overlay.style.width = `${g.w}px`;
    overlay.style.height = `${g.h}px`;
  }
  const { fx, fy, z } = cropState;
  const zoom = $('crop-zoom');
  if (zoom) { zoom.value = String(z); $('crop-zoom-val').textContent = `${z.toFixed(2)}×`; }
  const cx = $('crop-x'); if (cx) cx.value = String(fx);
  const cy = $('crop-y'); if (cy) cy.value = String(fy);
}

/* Move the crop frame by a drag, in pixels, on the (possibly zoomed) stage.
 * The frame follows the pointer - dragging up moves it up. It used to go the
 * other way, and since the picture itself stays put, that read as the picture
 * sliding backwards. */
function cropDrag(dx, dy) {
  if (!cropState) return;
  const g = cropGeometry();
  if (!g) return;   // not loaded yet
  const halfX = g.rangeX * g.s;
  const halfY = g.rangeY * g.s;
  const clamp = (v) => Math.max(-1, Math.min(1, v));
  if (halfX > 0.5) cropState.fx = clamp(cropState.fx + dx / halfX);
  if (halfY > 0.5) cropState.fy = clamp(cropState.fy + dy / halfY);
  paintCrop();
}

/* The dialog is not laid out the moment it opens, and inside an embedded webview
 * window.innerHeight can still read 0 - paintCrop then measured a zero-sized
 * stage and drew its mask over the whole thing, so on some machines the picture
 * was invisible. Retry across a few frames until the stage has a real size. */
function schedulePaint(frames) {
  const stage = $('crop-stage');
  if (!stage) return;
  const n = frames || 0;
  const tiny = stage.clientWidth < 24 || stage.clientHeight < 24;
  // Waiting for layout is a question of time, not of frames: counting frames
  // made this give up sooner on a fast display and later on a slow one.
  if (tiny && n < 40) { requestAnimationFrame(() => schedulePaint(n + 2)); return; }
  // Normally the stylesheet sizes the stage. Only if it really has no size -
  // an embedded webview reporting a 0x0 window before layout - put pixels in.
  if (tiny) {
    const size = Math.max(150, Math.round(Math.min(320, (window.innerHeight || 600) * 0.4)));
    stage.style.width = `${size}px`;
    stage.style.height = `${size}px`;
  }
  paintCrop();
}

function openCropper(kind) {
  const isAvatar = kind === 'avatar';
  const src = isAvatar ? SET.avatar : SET.themeBg;
  if (!src) {
    toast(isAvatar ? 'Upload a profile image first' : 'Upload a background first', 'warning');
    return;
  }
  const saved = normalizeCrop(isAvatar ? SET.avatarCrop : SET.bgCrop) || {};
  const stage = $('crop-stage');
  const media = $('crop-media');
  const node = mediaNode(src, 'crop-node');
  media.replaceChildren(node);
  // If the picture cannot be decoded here, say so rather than showing an empty
  // frame - a cropper that looks "invisible" usually means this.
  setTimeout(() => {
    const hint = $('crop-hint');
    if (node.naturalWidth || node.videoWidth) return;
    if (hint && !/did not load/.test(hint.textContent)) hint.textContent += '  (the picture did not load on this device)';
  }, 1800);
  $('crop-title').textContent = isAvatar ? 'Crop profile image' : 'Crop background';
  $('crop-hint').textContent = isAvatar
    ? 'The circle is what the chat will show. Drag the picture to move it, scroll or use the slider to zoom - zooming in lets you slide it further.'
    : 'The frame is what you will see on screen. Drag the picture to move it, scroll or use the slider to zoom - zooming in lets you slide it further.';
  stage.classList.toggle('circle', isAvatar);
  const frame = isAvatar ? 1 : window.innerWidth / Math.max(1, window.innerHeight);
  cropState = {
    kind,
    node,
    frame,
    fx: saved.fx == null ? 0 : Number(saved.fx),
    fy: saved.fy == null ? 0 : Number(saved.fy),
    z: saved.z == null ? 1 : Math.max(1, Number(saved.z)),
  };
  // Show the picture at its own shape, so nothing is hidden from the start.
  const setStage = () => {
    const nw = node.naturalWidth || node.videoWidth || 0;
    const nh = node.naturalHeight || node.videoHeight || 0;
    // Sized inline, in pixels: the avatar stage is a square that always fits the
    // window, so the round crop window is a circle and the save/cancel buttons
    // can never end up below the screen. A wide picture keeps its own shape on
    // the background cropper only.
    if (isAvatar) {
      stage.style.aspectRatio = '1 / 1';
    } else if (nw && nh) {
      stage.style.aspectRatio = `${nw} / ${nh}`;
    }
    schedulePaint();
  };
  setStage();
  node.addEventListener('load', setStage);
  node.addEventListener('loadedmetadata', setStage);
  const dlg = $('crop-dialog');
  // Always leave a way out: the dialog scrolls, Escape closes it, and closing it
  // for any reason (not just the buttons) drops the crop state.
  dlg.style.maxHeight = '92vh';
  dlg.style.overflow = 'auto';
  if (!dlg.__wired) {
    dlg.__wired = true;
    dlg.addEventListener('close', () => { cropState = null; });
    // Escape has to work on the fallback overlay too, where there is no native
    // dialog behaviour to close it.
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && $('crop-dialog') && $('crop-dialog').classList.contains('cropper-open')) {
        ev.preventDefault();
        closeCropper();
      }
    });
  }
  if (!dlg.open && !dlg.classList.contains('cropper-open')) showCropDialog(dlg);
}

/* <dialog> + showModal is patchy on older mobile browsers and embedded
 * webviews. Where it does not work the crop dialog simply never appeared - the
 * click looked like it did nothing. Fall back to a plain fixed overlay, and
 * verify afterwards that the dialog is really on screen. */
function showCropDialog(dlg) {
  let modal = false;
  try {
    if (typeof dlg.showModal === 'function') { dlg.showModal(); modal = dlg.open === true; }
  } catch { modal = false; }
  dlg.classList.add('cropper-open');
  document.body.classList.add('modal-open');
  if (!modal) {
    dlg.setAttribute('open', '');
    dlg.classList.add('cropper-forced');
    return;
  }
  // Supported, but check it landed somewhere visible: if not, force the overlay.
  requestAnimationFrame(() => {
    const r = dlg.getBoundingClientRect();
    const h = window.innerHeight || 0;
    if (!r.width || !r.height || r.bottom < 8 || (h && r.top > h)) dlg.classList.add('cropper-forced');
  });
}

function closeCropper() {
  cropState = null;
  const dlg = $('crop-dialog');
  if (dlg && dlg.open) dlg.close();
  if (dlg) {
    dlg.classList.remove('cropper-open', 'cropper-forced');
    dlg.removeAttribute('open');
  }
  // A leftover Escape-opened state used to leave the dialog modal-blocking the
  // page with nothing clickable behind it.
  document.body.classList.remove('modal-open');
}

function saveCrop() {
  if (!cropState) return closeCropper();
  const crop = {
    v: 2,
    fx: Math.round(cropState.fx * 100) / 100,
    fy: Math.round(cropState.fy * 100) / 100,
    z: Math.round(cropState.z * 100) / 100,
  };
  if (cropState.kind === 'avatar') SET.avatarCrop = crop; else SET.bgCrop = crop;
  closeCropper();
  saveSettings();   // applySettings re-renders the background and every avatar
  toast('Crop saved');
}

(function wireCropper() {
  const stage = $('crop-stage');
  if (!stage) return;
  let dragging = null;
  stage.addEventListener('pointerdown', (e) => {
    if (!cropState) return;
    dragging = { x: e.clientX, y: e.clientY };
    stage.classList.add('dragging');
    try { stage.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
    e.preventDefault();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!dragging || !cropState) return;
    cropDrag(e.clientX - dragging.x, e.clientY - dragging.y);
    dragging = { x: e.clientX, y: e.clientY };
  });
  const endDrag = () => { dragging = null; stage.classList.remove('dragging'); };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('wheel', (e) => {
    if (!cropState) return;
    e.preventDefault();
    const z = cropState.z * (e.deltaY > 0 ? 0.92 : 1.08);
    cropState.z = Math.max(1, Math.min(6, z));
    paintCrop();
  }, { passive: false });
  $('crop-zoom').oninput = (e) => { if (cropState) { cropState.z = Number(e.target.value) || 1; paintCrop(); } };
  $('crop-x').oninput = (e) => { if (cropState) { cropState.fx = Number(e.target.value); paintCrop(); } };
  $('crop-y').oninput = (e) => { if (cropState) { cropState.fy = Number(e.target.value); paintCrop(); } };
  $('crop-reset').onclick = () => {
    if (!cropState) return;
    cropState.fx = 0; cropState.fy = 0; cropState.z = 1;
    paintCrop();
  };
  $('crop-cancel').onclick = closeCropper;
  $('crop-save').onclick = saveCrop;
  // A close event is queued, not immediate, so one from an earlier close can
  // land after the dialog was reopened - only clear the state when the dialog
  // is really shut, or the fresh cropper would go dead.
  $('crop-dialog').addEventListener('close', () => {
    if (!$('crop-dialog').open) cropState = null;
  });
})();

/* appearance: font + text size */
/* Searchable system-font picker: enumerate installed fonts via the bridge
 * (Windows font registry) and offer them in a datalist under the font input.
 * Preset names (System/Monospace/Serif/Rounded) stay available too. */
let systemFontsLoaded = false;
let systemFontsLoading = null;

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

/* chatbox transparency: applies live while dragging, persists on release */
$('set-chat-opacity').value = SET.chatOpacity == null ? 100 : Number(SET.chatOpacity);
$('set-chat-opacity-val').textContent = `${SET.chatOpacity == null ? 100 : Number(SET.chatOpacity)}%`;
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
$('set-shorts-mode').onchange = (e) => { SET.shortsMode = e.target.value; saveSettings(); };
$('set-auto-continue').onchange = (e) => { SET.autoContinueAfterCompaction = e.target.checked; saveSettings(); };

/* settings tabs */
document.querySelectorAll('#settings-tabs .tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('#settings-tabs .tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('#settings-dialog .tab-panel').forEach((p) => {
      p.classList.toggle('hidden', p.id !== `tab-${t.dataset.tab}`);
    });
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
  // Only touch the network switch when the answer changed (it rebinds a socket).
  if (setupLanWas !== null && wantLan !== setupLanWas) setLanAccess(wantLan, $('setup-lan'));
};

/* ───────────────────────── pi providers (models.json) ───────────────────────── */


/* ── the Extensions tab (issue #46) ──────────────────────────────────────
 *
 * Lists what pi will actually load - loose extensions, skills, the packages in
 * settings.json, and AGENTS.md - and switches or removes them through the bridge,
 * which writes pi's own +path/-path entries under ~/.pi/agent.
 *
 * Every action goes through postExt() and every one is followed by a reload of the
 * list, so what is on screen is what the file says rather than what was asked for.
 * A change only takes effect in the running agent after a reload, and the panel
 * says so rather than pretending it is live. */
async function postExt(path, payload) {
  const r = await fetch(api(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  let d = {};
  try { d = await r.json(); } catch { /* no body */ }
  if (!r.ok) throw new Error(d.error || `request failed (${r.status})`);
  return d;
}

function extRow(kind, r, reload) {
  const row = el('div', 'prov-row');
  const info = el('div', 'prov-info');
  const name = el('div', 'prov-id', r.name);
  if (!r.enabled) name.classList.add('ext-off');
  info.appendChild(name);
  const bits = [r.kind === 'dir' ? 'directory' : 'file', r.source];
  if (r.size != null) bits.push(`${Math.max(1, Math.round(r.size / 1024))} KB`);
  bits.push(r.enabled ? 'enabled' : 'disabled');
  info.appendChild(el('div', 'prov-meta', bits.join(' · ')));
  row.appendChild(info);

  const toggle = el('button', 'btn small' + (r.enabled ? '' : ' primary'), r.enabled ? 'disable' : 'enable');
  toggle.title = r.enabled
    ? `Write "-${r.rel}" into settings.json so pi stops loading it`
    : `Write "+${r.rel}" into settings.json so pi loads it again`;
  toggle.onclick = async () => {
    toggle.disabled = true;
    try {
      await postExt('/api/pi-extensions/toggle', { type: kind, name: r.name, enabled: !r.enabled });
      toast(`${r.name} ${r.enabled ? 'disabled' : 'enabled'} — reload the agent to apply it`);
      await reload();
    } catch (e) { toast(e.message, 'error'); } finally { toggle.disabled = false; }
  };

  if (r.source === 'local') {
    const del = el('button', 'btn small', 'uninstall');
    del.title = `Delete ${r.name} from disk. Only loose files under the agent dir can be removed here.`;
    del.onclick = async () => {
      if (!confirm(`Delete ${r.name} from disk?\n\nThis removes the file itself, not just the setting. It cannot be undone from here.`)) return;
      del.disabled = true;
      try {
        const d = await postExt('/api/pi-extensions/delete', { type: kind, name: r.name });
        toast(`Removed ${d.removed}`);
        await reload();
      } catch (e) { toast(e.message, 'error'); } finally { del.disabled = false; }
    };
    row.appendChild(toggle);
    row.appendChild(del);
  } else {
    row.appendChild(toggle);
  }
  return row;
}

async function loadExtensionsTab() {
  const extBox = $('ext-extensions');
  const skillBox = $('ext-skills');
  const pkgBox = $('ext-packages');
  if (!extBox || !skillBox) return;
  const reload = () => loadExtensionsTab();
  for (const box of [extBox, skillBox, pkgBox]) {
    box.innerHTML = '';
    box.appendChild(el('div', 'prov-empty', 'loading…'));
  }
  let d;
  try {
    d = await fetch(api('/api/pi-extensions')).then((r) => r.json());
  } catch (e) {
    for (const box of [extBox, skillBox, pkgBox]) { box.innerHTML = ''; box.appendChild(el('div', 'prov-empty', e.message)); }
    return;
  }
  if (d.error) {
    for (const box of [extBox, skillBox, pkgBox]) { box.innerHTML = ''; box.appendChild(el('div', 'prov-empty', d.error)); }
    return;
  }
  $('ext-agent-dir').textContent = d.agentDir || '~/.pi/agent';
  $('ext-settings-file').textContent = d.settingsFile ? String(d.settingsFile).split(/[\\/]/).pop() : 'settings.json';
  $('ext-ext-count').textContent = d.counts.extensions ? `${d.counts.extensions}` : '';
  $('ext-skill-count').textContent = d.counts.skills ? `${d.counts.skills}` : '';
  $('ext-pkg-count').textContent = d.counts.packages ? `${d.counts.packages}` : '';

  extBox.innerHTML = '';
  if (!d.extensions.length) {
    extBox.appendChild(el('div', 'prov-empty', 'nothing in ' + (d.agentDir || '') + '/extensions'));
  } else {
    for (const r of d.extensions) extBox.appendChild(extRow('extensions', r, reload));
  }

  skillBox.innerHTML = '';
  if (!d.skills.length) {
    skillBox.appendChild(el('div', 'prov-empty', 'no skill folders (a skill is a directory holding SKILL.md)'));
  } else {
    for (const r of d.skills) skillBox.appendChild(extRow('skills', r, reload));
  }

  pkgBox.innerHTML = '';
  if (!d.packages.length) {
    pkgBox.appendChild(el('div', 'prov-empty', 'no packages listed in settings.json'));
  } else {
    for (const p of d.packages) {
      const row = el('div', 'prov-row');
      const info = el('div', 'prov-info');
      info.appendChild(el('div', 'prov-id', p.source));
      const meta = [p.form === 'object' ? 'object form' : 'string form'];
      if (p.filters) {
        for (const [k, v] of Object.entries(p.filters)) meta.push(`${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`);
      }
      info.appendChild(el('div', 'prov-meta', meta.join(' · ')));
      const del = el('button', 'btn small', 'remove');
      del.title = 'Take this entry out of settings.json. The files it installed under ~/.pi stay where they are.';
      del.onclick = async () => {
        if (!confirm(`Remove ${p.source} from settings.json?\n\nThis only edits the list. Anything it installed under ~/.pi/agent stays on disk.`)) return;
        del.disabled = true;
        try {
          await postExt('/api/pi-extensions/package', { action: 'remove', source: p.source });
          toast(`Removed ${p.source} from the package list — reload the agent to apply it`);
          await reload();
        } catch (e) { toast(e.message, 'error'); } finally { del.disabled = false; }
      };
      row.append(info, del);
      pkgBox.appendChild(row);
    }
  }

  // AGENTS.md: the global file is editable, the project ones are shown as they are.
  const list = $('ext-agents-list');
  const box = $('ext-agents-text');
  list.innerHTML = '';
  try {
    const a = await fetch(api('/api/pi-agents')).then((r) => r.json());
    for (const f of a.files || []) {
      const row = el('div', 'prov-row');
      const info = el('div', 'prov-info');
      info.appendChild(el('div', 'prov-id', f.writable ? 'global — editable here' : f.scope));
      info.appendChild(el('div', 'prov-meta', f.exists ? `${f.path} · ${f.bytes} bytes${f.truncated ? ' (shown in part)' : ''}` : `${f.path} · does not exist yet`));
      row.appendChild(info);
      list.appendChild(row);
    }
    const g = (a.files || []).find((f) => f.writable);
    box.value = (g && g.content) || '';
    box.placeholder = (g && g.exists) ? '' : '# Instructions for the agent (AGENTS.md is created by saving this box)';
  } catch (e) {
    list.appendChild(el('div', 'prov-empty', e.message));
  }
}

if ($('btn-ext-pkg-add')) {
  $('btn-ext-pkg-add').onclick = async () => {
    const input = $('ext-pkg-source');
    const source = (input.value || '').trim();
    if (!source) return;
    if (source.startsWith('-')) { toast('A package source cannot start with "-"', 'warning'); return; }
    $('btn-ext-pkg-add').disabled = true;
    try {
      const d = await postExt('/api/pi-extensions/package', { action: 'add', source });
      toast(d.note || `Added ${source}`);
      input.value = '';
      await loadExtensionsTab();
    } catch (e) { toast(e.message, 'error'); } finally { $('btn-ext-pkg-add').disabled = false; }
  };
}

if ($('btn-ext-agents-save')) {
  $('btn-ext-agents-save').onclick = async () => {
    const content = $('ext-agents-text').value;
    if (content.trim() === '' && !confirm('Save an empty AGENTS.md?\n\nAn empty box deletes the global AGENTS.md.')) return;
    $('btn-ext-agents-save').disabled = true;
    try {
      const d = await postExt('/api/pi-agents', { content });
      toast(d.bytes ? `Saved AGENTS.md (${d.bytes} bytes) — reload the agent to apply it` : 'Global AGENTS.md deleted');
      await loadExtensionsTab();
    } catch (e) { toast(e.message, 'error'); } finally { $('btn-ext-agents-save').disabled = false; }
  };
}

async function loadPiProviders() {
  const list = $('pi-providers-list');
  list.innerHTML = '';
  list.appendChild(el('div', 'prov-empty', 'loading…'));

  // The llama.cpp servers found on this machine or the LAN come first: they are the
  // ones you actually point pi at, and the banner offering to do it can be
  // dismissed (or missed), so the list is where they live.
  const llamaSection = document.createDocumentFragment();
  try {
    const l = await fetch(api('/api/llama-models')).then((r) => r.json());
    const servers = (l && l.servers) || [];
    if (servers.length) {
      llamaSection.appendChild(el('div', 'prov-group', 'llama.cpp — found automatically'));
      for (const srv of servers) {
        const row = el('div', 'prov-row');
        const info = el('div', 'prov-info');
        info.appendChild(el('div', 'prov-id', srv.url.replace(/^https?:\/\//, '')));
        const registered = llamaRegistered(srv);
        info.appendChild(el('div', 'prov-meta',
          `${srv.models.length} model${srv.models.length > 1 ? 's' : ''} · ${registered ? 'registered with pi ✓' : 'not registered with pi yet'}`));
        const btn = el('button', 'btn small', registered ? 'use only this one' : 'use only this one & reload');
        btn.title = `Write ${srv.url} into pi's settings (replacing any other llama server) and restart the agent`;
        btn.onclick = () => fixLlamaConfig([srv.url]);
        row.append(info, btn);
        llamaSection.appendChild(row);
      }
      if (llamaEnvOverride) {
        llamaSection.appendChild(el('div', 'prov-empty',
          `note: LLAMA_SERVER_URL is set to ${llamaEnvOverride} in the bridge's environment, and the pi-llama-cpp extension lets that override this list`));
      }
      if (servers.length > 1) {
        // One provider per configured server: pointing pi at the list means every
        // instance's models are selectable at the same time.
        const all = el('div', 'prov-row');
        const info = el('div', 'prov-info');
        info.appendChild(el('div', 'prov-id', `all ${servers.length} servers at once`));
        const registered = servers.every((srv) => llamaRegistered(srv));
        info.appendChild(el('div', 'prov-meta', registered
          ? 'every one of them is registered with pi ✓'
          : 'pi keeps them all as separate providers, so no switching back and forth'));
        const btn = el('button', 'btn small', registered ? 'point pi at all of them again' : `point pi at all ${servers.length} & reload`);
        btn.title = `Write all ${servers.length} URLs into llamaSettings.servers and restart the agent`;
        btn.onclick = () => fixLlamaConfig(servers.map((s) => s.url));
        all.append(info, btn);
        llamaSection.appendChild(all);
      }
      if (l && l.scanning) llamaSection.appendChild(el('div', 'prov-empty', 'still looking for more on this network…'));
    }
  } catch { /* bridge offline: the list below still works */ }

  try {
    const d = await fetch(api('/api/pi-providers')).then((r) => r.json());
    list.innerHTML = '';
    list.appendChild(llamaSection);
    const provs = Object.entries(d.providers || {});
    if (!provs.length) {
      list.appendChild(el('div', 'prov-empty', llamaSection.childNodes.length ? 'no providers added by hand' : 'no custom providers yet'));
      return;
    }
    for (const [id, p] of provs) {
      const row = el('div', 'prov-row');
      const info = el('div', 'prov-info');
      info.appendChild(el('div', 'prov-id', id));
      info.appendChild(el('div', 'prov-meta',
        `${p.baseUrl || '—'} · ${p.models?.length || 0} models · key ${p.hasApiKey ? '✓' : '—'}`));
      const btn = el('button', 'btn small', 'remove');
      btn.title = `Remove provider "${id}" from pi's models.json`;
      btn.onclick = async () => {
        if (!confirm(`Remove provider "${id}" from pi's models.json?`)) return;
        try {
          const r = await fetch(api(`/api/pi-providers?id=${encodeURIComponent(id)}`), { method: 'DELETE' });
          const out = await r.json();
          if (!r.ok) throw new Error(out.error || `failed (${r.status})`);
          toast(`Provider "${id}" removed`);
          loadPiProviders();
          refreshModels();
        } catch (e) { toast(e.message, 'error'); }
      };
      row.append(info, btn);
      list.appendChild(row);
    }
  } catch {
    list.innerHTML = '';
    list.appendChild(llamaSection);
    list.appendChild(el('div', 'prov-empty', 'bridge offline'));
  }
}

$('btn-prov-discover').onclick = async () => {
  const url = $('prov-base-url').value.trim().replace(/\/+$/, '');
  if (!url) { toast('Enter the base URL first', 'warning'); return; }
  const btn = $('btn-prov-discover');
  btn.disabled = true;
  try {
    const r = await fetch(api('/api/probe-models'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `probe failed (${r.status})`);
    if (!d.models.length) { toast('No models found at that URL', 'warning'); return; }
    $('prov-models').value = d.models.map((m) => m.id).join('\n');
    toast(`Found ${d.models.length} models`);
  } catch (e) {
    toast(`Discover failed: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
};

$('btn-prov-test').onclick = async () => {
  const baseUrl = $('prov-base-url').value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) { toast('Enter a valid base URL first', 'warning'); return; }
  const btn = $('btn-prov-test');
  btn.disabled = true;
  btn.textContent = 'testing…';
  try {
    const r = await fetch(api('/api/probe-provider'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl,
        api: $('prov-api').value,
        apiKey: $('prov-api-key').value.trim(),
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `probe failed (${r.status})`);
    if (d.ok) {
      toast(`✓ Connection works — model "${d.model}" replied: ${d.sample || '(empty)'}`);
      if (d.models.length && !$('prov-models').value.trim()) {
        $('prov-models').value = d.models.join('\n');
        toast(`Filled ${d.models.length} discovered models`);
      }
    } else if (d.empty) {
      toast(`✗ Endpoint answered HTTP ${d.status} but with an EMPTY reply — check the URL path (e.g. OpenAI-style needs /v1, not /anthropic)`, 'error');
    } else {
      toast(`✗ ${d.error || `HTTP ${d.status}`}`, 'error');
    }
  } catch (e) {
    toast(`Test failed: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'test connection';
  }
};

$('btn-prov-add').onclick = async () => {
  const id = $('prov-id').value.trim();
  const baseUrl = $('prov-base-url').value.trim();
  const api = $('prov-api').value;
  const apiKey = $('prov-api-key').value.trim();
  const models = $('prov-models').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!id) { toast('Provider id is required', 'warning'); return; }
  if (!/^https?:\/\//i.test(baseUrl)) { toast('Base URL must start with http:// or https://', 'warning'); return; }
  const btn = $('btn-prov-add');
  btn.disabled = true;
  try {
    const r = await fetch(api('/api/pi-providers'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, baseUrl, api, apiKey: apiKey || undefined, models }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `failed (${r.status})`);
    toast(`Provider "${id}" saved to pi — new models appear in the model list`);
    $('prov-api-key').value = '';
    $('prov-models').value = '';
    loadPiProviders();
    refreshModels(); // pi re-reads models.json when the model list is opened
  } catch (e) {
    toast(`Save failed: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
};

/* ───────────────────────── pi /login (auth.json) ───────────────────────── */

// Credentials pi's /login saves: ~/.pi/agent/auth.json, keyed by provider id.
// "login" = store an API key, "logout" = remove it. The agent restarts after
// either, because it reads auth.json at startup.
//
// The old UI listed all ~33 known providers at once, which buried the two or
// three that actually matter. Now it is a searchable picker: type (or pick from
// the suggestions) and the state of that one provider is shown below.
let authProviders = {};

async function loadAuthProviders() {
  const dl = $('auth-provider-ids');
  const status = $('auth-status');
  const list = $('auth-logged-in');
  if (!dl || !status || !list) return;
  try {
    const d = await fetch(api('/api/auth-providers')).then((r) => r.json());
    authProviders = d.providers || {};
    dl.innerHTML = '';
    for (const id of Object.keys(authProviders)) dl.appendChild(el('option', null, id));
    renderAuthStatus();
    renderAuthLoggedIn();
  } catch {
    authProviders = {};
    status.className = 'auth-status';
    status.textContent = 'bridge offline';
    list.innerHTML = '';
  }
}

// State of the provider currently in the input (if any).
function renderAuthStatus() {
  const status = $('auth-status');
  if (!status) return;
  const id = ($('auth-provider').value || '').trim();
  status.className = 'auth-status';
  status.textContent = '';
  if (!id) {
    const n = Object.keys(authProviders).length;
    status.textContent = n
      ? 'Type or pick a provider — suggestions appear as you type.'
      : '';
    return;
  }
  const p = authProviders[id];
  const cat = p && p.models ? ` · ${p.models} models in its catalog` : '';
  if (!p) {
    status.textContent = `${id}: not a known pi provider id (any id is accepted) — no credentials stored.`;
    status.classList.add('warn');
  } else if (p.auth === 'key') {
    status.textContent = `${p.name || id} — logged in with an API key ${p.keyMasked || ''}${cat}`;
    status.classList.add('ok');
  } else if (p.auth === 'oauth') {
    status.textContent = `${p.name || id} — logged in via OAuth / subscription${cat}`;
    status.classList.add('ok');
  } else if (p.auth === 'other') {
    status.textContent = `${p.name || id} — configured in auth.json, but not an API key login (cannot be removed here)${cat}`;
    status.classList.add('warn');
  } else {
    status.textContent = `${p.name || id} — no credentials stored yet${cat}${p.custom ? ' (custom provider)' : ''}`;
  }
}

// Only the providers that actually have credentials — usually a short list.
function renderAuthLoggedIn() {
  const list = $('auth-logged-in');
  if (!list) return;
  list.innerHTML = '';
  const ids = Object.keys(authProviders).filter((id) => authProviders[id].auth !== 'none');
  if (!ids.length) {
    list.appendChild(el('div', 'prov-empty', 'no credentials stored yet'));
    return;
  }
  for (const id of ids) {
    const p = authProviders[id];
    const row = el('div', 'prov-row');
    const info = el('div', 'prov-info');
    info.appendChild(el('div', 'prov-id', p.name || id));
    const what = p.auth === 'key' ? `API key ${p.keyMasked || ''}`
      : p.auth === 'oauth' ? 'OAuth / subscription'
      : 'other configuration (protected)';
    info.appendChild(el('div', 'prov-meta', `${id} · ${what}`));
    const btn = el('button', 'btn small', p.auth === 'other' ? 'protected' : 'logout');
    if (p.auth === 'other') {
      btn.disabled = true;
      btn.title = `"${id}" holds configuration beyond a login (an env block, for example) — remove it by hand if you really mean to`;
    } else {
      btn.title = `Remove "${id}" credentials from auth.json (like /logout)`;
      btn.onclick = () => authLogout(id);
    }
    row.append(info, btn);
    row.onclick = (e) => {
      if (e.target === btn) return;
      $('auth-provider').value = id;
      renderAuthStatus();
      $('auth-key').focus();
    };
    list.appendChild(row);
  }
}

// Restart the shared agent so it re-reads auth.json (same mechanism the
// llama.cpp fix uses).
async function authRestartAgent() {
  toast('Restarting the agent to pick up the new credentials…');
  const wait = waitForAgentReady(60000);
  send({ bridge: 'restart' });
  await wait;
  await initSession(true);
}

async function authLogout(id) {
  if (!confirm(`Log out "${id}"?\nRemoves its credentials from auth.json (like /logout).`)) return;
  try {
    const r = await fetch(api(`/api/auth-login?provider=${encodeURIComponent(id)}`), { method: 'DELETE' });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || `failed (${r.status})`);
    await authRestartAgent();
    toast(`Logged out "${id}"`);
    loadAuthProviders();
    refreshModels();
  } catch (e) {
    toast(e.message, 'error');
  }
}

$('auth-provider').addEventListener('input', renderAuthStatus);
$('auth-provider').addEventListener('change', renderAuthStatus);

$('btn-auth-login').onclick = async () => {
  const id = $('auth-provider').value.trim();
  const key = $('auth-key').value.trim();
  if (!id) { toast('Enter the provider id first', 'warning'); return; }
  if (!key) { toast('Enter the API key', 'warning'); return; }
  try {
    const r = await fetch(api('/api/auth-login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: id, key }),
    });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || `failed (${r.status})`);
    $('auth-key').value = '';
    await authRestartAgent();
    toast(`Logged in "${id}" — key saved to auth.json`);
    loadAuthProviders();
    refreshModels();
  } catch (e) {
    toast(`Login failed: ${e.message}`, 'error');
  }
};
$('btn-auth-logout').onclick = () => {
  const id = $('auth-provider').value.trim();
  if (!id) { toast('Enter the provider id first', 'warning'); return; }
  authLogout(id);
};

/* ───────────────────────── shorts feed (one-tap) ───────────────────────── */

const SHORTS_FEEDS = {
  instagram: { url: 'https://www.instagram.com/reels/', label: 'Reels' },
  tiktok: { url: 'https://www.tiktok.com/', label: 'TikTok' },
  youtube: { url: 'https://www.youtube.com/shorts/', label: 'Shorts' },
};

/* ───────────────────────── Reels / Shorts ─────────────────────────
 * Three ways to watch, depending on the platform:
 *
 *  1. NATIVE (React Native app): the page runs inside a WebView, so we can
 *     hand off to the app's native shorts sheet via window.webview.postMessage.
 *     The app loads the real feed top-level (a WebView is a full browser
 *     context, so X-Frame-Options doesn't apply) — the true seamless split.
 *
 *  2. IN-APP PANEL (browser default): a split pane inside the app that plays
 *     single videos via the official embeds (YouTube /embed/<id>, Instagram
 *     /reel/<id>/embed/, TikTok /embed/v2/<id>). The infinite feed itself
 *     can't be iframed (IG/TikTok send X-Frame-Options: DENY), so for that:
 *
 *  3. SIDE WINDOW: a popup docked flush against the right edge of the app
 *     window (zero gap) that loads the full feed — plus a plain tab fallback.
 * ─────────────────────────────────────────────────────────────────── */
/* Check at call time (not load time): react-native-webview injects the
 * bridge during page load, and a lazy check is immune to load-order races. */
function nativeBridge() {
  if (window.webview && typeof window.webview.postMessage === 'function') return window.webview;
  if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') return window.ReactNativeWebView;
  return null;
}

let reelsWin = null;           // side-window (full feed) handle
let reelsFeed = 'instagram';   // active feed in the in-app panel
const reelsLinks = {};         // last pasted link per feed

function showReelsPill(label) {
  const pill = $('reels-pill');
  if (!pill) return;
  pill.querySelector('span').textContent = `◧ ${label}`;
  pill.classList.remove('hidden');
}
function hideReelsPill() {
  const pill = $('reels-pill');
  if (pill) pill.classList.add('hidden');
}

/* Build an official embed URL from a pasted share link. */
function embedUrlFor(feed, raw) {
  const u = (raw || '').trim();
  if (!u) return null;
  let m;
  if (feed === 'youtube') {
    m = u.match(/(?:youtube\.com\/(?:shorts|embed|live)\/|youtu\.be\/|youtube\.com\/watch\?(?:[^&]*&)*v=)([A-Za-z0-9_-]{6,20})/);
    return m ? `https://www.youtube.com/embed/${m[1]}?autoplay=1` : null;
  }
  if (feed === 'instagram') {
    m = u.match(/instagram\.com\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/);
    return m ? `https://www.instagram.com/reel/${m[1]}/embed/` : null;
  }
  if (feed === 'tiktok') {
    m = u.match(/tiktok\.com\/.*\/video\/(\d+)/);
    return m ? `https://www.tiktok.com/embed/v2/${m[1]}` : null;
  }
  return null;
}

function setReelsFeed(feed) {
  reelsFeed = feed;
  for (const b of $('reels-tabs').querySelectorAll('.rtab'))
    b.classList.toggle('active', b.dataset.feed === feed);
  $('reels-link').value = reelsLinks[feed] || '';
  const link = reelsLinks[feed];
  const src = link ? embedUrlFor(feed, link) : null;
  // In the app the panel is backed by a real browser surface, so switching tab
  // just repoints it -- no iframe, no popup.
  if (nativeFeedOpen) { openNativeFeed(feed); return; }
  if (src) loadReelsVideo(src);
  else {
    const v = $('reels-video');
    v.innerHTML = '';
    const ph = el('div', 'reels-placeholder');
    ph.innerHTML = `<p>Paste a ${SHORTS_FEEDS[feed].label} link above to play it right here — no new tab.</p>` +
      `<p class="hint">The full infinite feed needs its own browsing context: the sites send <code>X-Frame-Options: DENY</code>, so an iframe is refused. <b>Open the feed</b> below and it loads for real, docked beside the app.</p>` +
      `<div class="reels-placeholder-actions"><button class="btn small primary" data-reels-open="feed">open ${SHORTS_FEEDS[feed].label} feed</button></div>`;
    v.appendChild(ph);
    const openBtn = ph.querySelector('[data-reels-open="feed"]');
    if (openBtn) openBtn.onclick = () => openReelsWindow(feed);
  }
}

function loadReelsVideo(src) {
  const v = $('reels-video');
  v.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.src = src;
  iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  iframe.allowFullscreen = true;
  iframe.referrerPolicy = 'no-referrer';
  v.appendChild(iframe);
}

/* Browser 'panel' mode: the same toggle the Reels button uses, kept as a named
 * entry point because the reels pill and the settings menu call it too. */
function toggleReelsPanel() {
  const panel = $('reels-panel');
  if (panel.classList.contains('hidden')) {
    setReelsFeed(SHORTS_FEEDS[SET.shortsProvider || 'instagram'] ? (SET.shortsProvider || 'instagram') : 'instagram');
    $('reels-link').focus();
    showReels(reelsFeed);
  } else {
    hideReels();
  }
}

/* ── docked native feed (Windows app) ──────────────────────────────
 *
 * In the app the page runs inside WebView2, which gives us something a browser
 * cannot: a second real browser surface we can place anywhere in the window.
 * So instead of iframing a feed (Instagram and TikTok refuse that with
 * X-Frame-Options: DENY) or opening a popup, we park a genuine Chromium surface
 * exactly over this panel's rectangle. The panel stays the layout -- drag the
 * splitter and the feed follows -- and the site sees a top-level browsing
 * context, so the infinite feed loads normally.
 *
 * Messages go to windows/PiAgent/WebView2Module.h as
 *   piagent|shorts|open|x|y|w|h|url
 *   piagent|shorts|rect|x|y|w|h
 *   piagent|shorts|close
 * with x/y relative to the panel (straight from getBoundingClientRect).
 */
function webView2Host() {
  const c = window.chrome;
  return c && c.webview && typeof c.webview.postMessage === 'function' ? c.webview : null;
}

let nativeFeedOpen = false;

function panelRect() {
  const r = $('reels-panel').getBoundingClientRect();
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    w: Math.round(r.width),
    h: Math.round(r.height),
  };
}

function openNativeFeed(feed) {
  const host = webView2Host();
  if (!host) return false;
  const f = SHORTS_FEEDS[feed] || SHORTS_FEEDS.instagram;
  const r = panelRect();
  if (r.w < 40 || r.h < 40) return false;
  host.postMessage(`piagent|shorts|open|${r.x}|${r.y}|${r.w}|${r.h}|${f.url}`);
  nativeFeedOpen = true;
  $('reels-video').classList.add('native-feed');
  return true;
}

function syncNativeFeed() {
  const host = webView2Host();
  if (!host || !nativeFeedOpen) return;
  if ($('reels-panel').classList.contains('hidden')) { closeNativeFeed(); return; }
  const r = panelRect();
  if (r.w < 40 || r.h < 40) return;
  host.postMessage(`piagent|shorts|rect|${r.x}|${r.y}|${r.w}|${r.h}`);
}

function closeNativeFeed() {
  if (!nativeFeedOpen) return;
  nativeFeedOpen = false;
  const host = webView2Host();
  if (host) host.postMessage('piagent|shorts|close');
  const v = $('reels-video');
  if (v) v.classList.remove('native-feed');
}

/* Side window for the full infinite feed: docked flush against the right
 * edge of the app window (same height, zero gap) so it reads like a split
 * pane. A top-bar pill tracks it. Falls back to a tab when blocked. */
function openReelsWindow(feed) {
  const f = SHORTS_FEEDS[feed] || SHORTS_FEEDS.instagram;
  const w = Math.min(460, Math.max(360, Math.round(window.outerWidth * 0.42)));
  const h = Math.max(480, Math.min(window.outerHeight, window.screen.height));
  const left = Math.max(0, window.screenX + window.outerWidth - w);
  const top = Math.max(0, window.screenY);
  if (reelsWin && !reelsWin.closed) {
    try {
      const cur = reelsWin.location.href || '';
      if (!cur.startsWith(f.url.slice(0, 25))) reelsWin.location.href = f.url;
    } catch { reelsWin.location.href = f.url; }
    reelsWin.focus();
  } else {
    reelsWin = window.open(f.url, 'pi_reels_feed',
      'popup=yes,width=' + w + ',height=' + h + ',left=' + left + ',top=' + top);
    if (!reelsWin) { // popup blocked by the browser
      window.open(f.url, '_blank');
      toast('Popup blocked — opened in a tab instead', 'warning');
      return;
    }
  }
  showReelsPill(f.label);
  toast(`${f.label} feed opened in the side window`);
}

function showReels(provider) {
  const panel = $('reels-panel');
  panel.classList.remove('hidden');
  setReelsFeed(provider || 'instagram');
  // Remember it: a reload (or a native shell that rebuilds its surface) brings
  // the panel back instead of silently closing it.
  SET.reelsOpen = true;
  saveSettings();
  // Windows app: back the panel with a real Chromium surface instead of the
  // placeholder. No-op in a plain browser.
  openNativeFeed(reelsFeed);
}

function hideReels() {
  autoShortsOpened = false;   // the user (or the auto-hook) took it down
  $('reels-panel').classList.add('hidden');
  SET.reelsOpen = false;
  saveSettings();
  closeNativeFeed();
}

/* ── auto-open the feed while the agent works (settings → shorts) ──
 * Only closes what it opened itself, so a feed the user opened by hand is
 * never yanked away. Keyed off agent_start/agent_settled: settled means pi
 * will not continue on its own (no retry, compaction or queued follow-up), so
 * "the run is finished" really means finished. */
let autoShortsOpened = false;

function reelsHidden() {
  const panel = $('reels-panel');
  if (panel && !panel.classList.contains('hidden')) return false;
  if (reelsWin && !reelsWin.closed) return false;
  return true;
}

function autoOpenShortsIfEnabled() {
  if (!SET.shortsAutoOpen || autoShortsOpened) return;
  if (!SHORTS_FEEDS[SET.shortsProvider || 'instagram']) return; // 'none' → nothing to show
  if (!reelsHidden()) return;                                   // already open
  autoShortsOpened = true;
  openShorts();
}

function autoCloseShortsIfOurs() {
  if (!autoShortsOpened) return;
  autoShortsOpened = false;
  hideReels();
  if (reelsWin && !reelsWin.closed) {
    try { reelsWin.close(); } catch { /* ignore */ }
    reelsWin = null;
  }
}

/* The Reels button is a TOGGLE: first press docks the feed, second press puts it
 * away. It used to re-open (and therefore reload) the feed on every press. */
function toggleReels() {
  const panel = $('reels-panel');
  if (panel.classList.contains('hidden')) showReels(SET.shortsProvider || 'instagram');
  else hideReels();
}

function openShorts() {
  const provider = SET.shortsProvider || 'instagram';
  // Native (React Native) mode: open the app's native shorts sheet.
  const bridge = nativeBridge();
  if (bridge) {
    bridge.postMessage(JSON.stringify({ type: 'openShorts', provider }));
    return;
  }
  // WebView2 app: dock the feed inside the window, next to the chat.
  if (webView2Host()) { toggleReels(); return; }
  const mode = SET.shortsMode || 'panel';
  if (mode === 'tab') { reelsWin = window.open((SHORTS_FEEDS[provider] || SHORTS_FEEDS.instagram).url, '_blank'); return; }
  if (mode === 'window') { openReelsWindow(provider); return; }
  toggleReelsPanel();
}

$('btn-reels').onclick = openShorts;
$('btn-reels-close').addEventListener('click', hideReels);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('reels-panel').classList.contains('hidden')) hideReels();
});
for (const b of $('reels-tabs').querySelectorAll('.rtab'))
  b.addEventListener('click', () => setReelsFeed(b.dataset.feed));

function playReelsLink() {
  const link = $('reels-link').value;
  const src = embedUrlFor(reelsFeed, link);
  if (!src) { toast('Couldn\'t find a video id in that link', 'error'); return; }
  reelsLinks[reelsFeed] = link;
  loadReelsVideo(src);
}
$('btn-reels-play').addEventListener('click', playReelsLink);
$('reels-link').addEventListener('keydown', (e) => { if (e.key === 'Enter') playReelsLink(); });
$('btn-reels-feed').addEventListener('click', () => {
  if (openNativeFeed(reelsFeed)) return;
  openReelsWindow(reelsFeed);
});
// Same action from the placeholder inside the panel, so "I want the real feed"
// is one tap from where the user actually is.
const reelsFeedInline = $('btn-reels-feed-inline');
if (reelsFeedInline) {
  reelsFeedInline.addEventListener('click', () => {
    if (openNativeFeed(reelsFeed)) return;
    openReelsWindow(reelsFeed);
  });
}

/* Drag the panel's left edge to resize it. The feed is a real window surface,
 * so it has to be told the new rectangle -- that is what syncNativeFeed() is
 * for, and a ResizeObserver below catches every other layout change too. */
const reelsResize = $('reels-resize');
if (reelsResize) {
  let dragging = false;
  reelsResize.addEventListener('pointerdown', (e) => {
    dragging = true;
    try { reelsResize.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    reelsResize.classList.add('dragging');
    e.preventDefault();
  });
  const move = (e) => {
    if (!dragging) return;
    const panel = $('reels-panel');
    const max = Math.max(320, window.innerWidth - 360);
    const w = Math.max(320, Math.min(max, window.innerWidth - e.clientX));
    panel.style.width = w + 'px';
    syncNativeFeed();
  };
  reelsResize.addEventListener('pointermove', move);
  window.addEventListener('pointermove', move);
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    reelsResize.classList.remove('dragging');
    // Remember the width - the panel used to snap back to its narrow default
    // on every launch.
    SET.reelsWidth = Math.round($('reels-panel').getBoundingClientRect().width);
    saveSettings();
    syncNativeFeed();
  };
  reelsResize.addEventListener('pointerup', stop);
  window.addEventListener('pointerup', stop);
  applyReelsWidth();
}

/* The saved panel width, or a wider default than the old 400px so the feed has
 * room from the start. */
function applyReelsWidth() {
  const panel = $('reels-panel');
  if (!panel) return;
  const max = Math.max(320, window.innerWidth - 360);
  const want = Number(SET.reelsWidth) > 0 ? Number(SET.reelsWidth) : Math.round(window.innerWidth * 0.42);
  panel.style.width = `${Math.max(340, Math.min(max, want))}px`;
}

if (typeof ResizeObserver !== 'undefined') {
  const ro = new ResizeObserver(() => syncNativeFeed());
  ro.observe($('reels-panel'));
}
window.addEventListener('resize', () => syncNativeFeed());

// The docked feed is a window this page does not own, so a reload would leave it
// behind. Clear any orphan on startup, and try to close ours on the way out.
if (webView2Host()) {
  webView2Host().postMessage('piagent|shorts|close');
  window.addEventListener('beforeunload', () => {
    try { webView2Host().postMessage('piagent|shorts|close'); } catch { /* going away */ }
  });
}

$('reels-pill').addEventListener('click', () => {
  if (reelsWin && !reelsWin.closed) { try { reelsWin.close(); } catch { /* ignore */ } }
  reelsWin = null;
  hideReelsPill();
});
/* Watchdog: hide the pill when the side window is closed from its own UI. */
setInterval(() => {
  if (reelsWin && reelsWin.closed) { reelsWin = null; hideReelsPill(); }
}, 1000);

/* ── in-app dialogs ───────────────────────────────────────────────────────
 * confirm() and prompt() look like a browser warning bolted onto the page. This
 * is the same shape as the settings dialog, so confirmations read as part of the
 * app. Returns a promise: the resolved value is the field values object, or null
 * when cancelled. */
function askDialog(opts = {}) {
  return new Promise((resolve) => {
    const dlg = $('ask-dialog');
    if (!dlg) { resolve(null); return; }
    $('ask-title').textContent = opts.title || 'Are you sure?';
    const body = $('ask-body');
    body.innerHTML = '';
    if (opts.body) body.appendChild(el('p', 'ask-text', opts.body));
    const fields = opts.fields || [];
    const inputs = {};
    for (const f of fields) {
      const row = el('label', 'ask-row');
      row.appendChild(el('span', 'ask-label', f.label));
      const input = el('input');
      input.type = 'text';
      input.value = f.value || '';
      input.placeholder = f.placeholder || '';
      input.autocomplete = 'off';
      row.appendChild(input);
      body.appendChild(row);
      inputs[f.name] = input;
    }
    if (opts.hint) body.appendChild(el('p', 'ask-hint', opts.hint));
    $('ask-ok').textContent = opts.okLabel || 'ok';
    $('ask-ok').classList.toggle('danger', opts.danger === true);
    $('ask-cancel').textContent = opts.cancelLabel || 'cancel';
    const done = (value) => {
      dlg.removeEventListener('close', onClose);
      if (dlg.open) dlg.close();
      resolve(value);
    };
    const onClose = () => resolve(null);
    dlg.addEventListener('close', onClose);
    $('ask-ok').onclick = () => {
      const out = {};
      for (const f of fields) out[f.name] = inputs[f.name].value.trim();
      if (opts.require) {
        const missing = opts.require.find((n) => !out[n]);
        if (missing) { inputs[missing].focus(); return; }
      }
      done(out);
    };
    $('ask-cancel').onclick = () => done(null);
    const first = fields.length ? inputs[fields[0].name] : $('ask-ok');
    if (!dlg.open) dlg.showModal();
    setTimeout(() => first.focus(), 30);
  });
}

/* ── context menus ────────────────────────────────────────────────────────
 * Right click a session in the sidebar, or a message in the transcript. Both use
 * the same dropdown component as the model picker. */

function openSessionMenu(s, anchor) {
  const cur = S.state.sessionFile;
  const isCurrent = !!(cur && sameSessionPath(s.path, cur, S.sessionsList || []));
  openMenu(anchor, [
    { label: 'open', active: isCurrent, onPick: () => switchToSession(s.path) },
    { label: 'export…', hint: 'save the .jsonl wherever you want', onPick: () => exportSession(s) },
    // The tree comes from the agent, so it is only meaningful for the session
    // the agent has loaded - a read-only view would list the wrong branches.
    ...(isCurrent ? [{ label: 'branches…', hint: 'fork points in this session', sub: true, onPick: () => openBranchesMenu(s, anchor) }] : []),
    { sep: true },
    { label: 'delete…', hint: 'removes the file from disk', danger: true, onPick: () => deleteSession(s) },
  ], { title: 'session', width: 330, align: 'right' });
}

/* Download a session file. showSaveFilePicker is a real "where do you want it"
 * dialog; the plain anchor fallback still saves to the download folder. */
async function exportSession(s) {
  const url = `/api/session-file?path=${encodeURIComponent(s.path)}`;
  const name = String(s.fileName || 'session.jsonl');
  try {
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'pi session', accept: { 'application/jsonl': ['.jsonl'] } }],
      });
      const res = await fetch(url);
      if (!res.ok) throw new Error(`bridge said ${res.status}`);
      const blob = await res.blob();
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      toast(`Exported ${name}`);
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;   // cancelled in the dialog
  }
  const a = el('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast(`Exporting ${name}`);
}

async function deleteSession(s) {
  const ok = await askDialog({
    title: 'Delete this session?',
    body: `${s.name}\n${s.path}`,
    hint: 'The file is removed from disk. This cannot be undone.',
    okLabel: 'delete',
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await fetch(api('/api/session-delete'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: s.path }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'delete failed');
    if (S.state.sessionFile && s.path === S.state.sessionFile) {
      // Deleting a fork used to leave you on a brand new empty session. Go back
      // to where it was forked from when the file says, otherwise to the most
      // recent other session - either way, not a blank one.
      const parent = await sessionParent(s.path);
      const rest = (await fetch(api('/api/sessions')).then((x) => x.json()).catch(() => ({ sessions: [] })).then((d2) => (d2.sessions || [])))
        .filter((x) => x.path !== s.path)
        .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      const target = parent && rest.some((x) => x.path === parent) ? parent : (rest[0] && rest[0].path);
      if (target) {
        await switchToSession(target);
      } else {
        toast('That was the only session - starting a new one', 'warning');
        await rpc({ type: 'new_session' }).catch(() => {});
        await initSession(false);
      }
    }
    await refreshSessions(true);
    toast(`Deleted ${s.name}`);
  } catch (e) {
    toast(`Delete failed: ${e.message}`, 'error');
  }
}

/* The session a fork came from, if the file records it. */
async function sessionParent(sessionPath) {
  try {
    const d = await fetchSession(sessionPath);
    return d.parent || null;
  } catch { return null; }
}

/* Branch points of the open session (pi keeps branches in one file as a tree).
 * There is no RPC for moving the active leaf, so choosing a branch point means
 * forking there - which is how a branch gets started in the first place. */
/* The fork tree of the session you are in: pi knows the branch points, so this
 * is the real thing rather than a guess from the session list. Called both as
 * openBranchesMenu(anchor) and openBranchesMenu(session, anchor) depending on
 * where it is opened from, so the anchor is whichever argument is an element. */
async function openBranchesMenu(a, b) {
  const anchor = (a && a.getBoundingClientRect ? a : b) || $('session-name');
  let tree = null, leafId = null;
  try {
    const d = await rpc({ type: 'get_tree' });
    tree = d && d.tree;
    leafId = d && d.leafId;
  } catch { /* older agent */ }
  if (!tree || !tree.length) {
    toast('No branch points yet — edit an earlier message, or fork from one, to start a branch', 'warning');
    return;
  }
  const describe = (entry) => {
    const m = entry && entry.message;
    const text = m ? String((m.content || []).map((c) => c.text || '').join(' ')).replace(/\s+/g, ' ').trim() : '';
    return `${m ? m.role : (entry && entry.type) || 'entry'}: ${text.slice(0, 70) || entry.id}`;
  };
  const items = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      const kids = n.children || [];
      const isLeaf = kids.length === 0;
      if (isLeaf || kids.length > 1) {
        items.push({
          label: `${isLeaf ? (n.entry.id === leafId ? '● ' : '○ ') : '⑂ '}${describe(n.entry)}`,
          hint: isLeaf ? 'branch end' : `${kids.length} branches`,
          active: n.entry.id === leafId,
          onPick: () => forkAt(n.entry.id, describe(n.entry)),
        });
      }
      if (kids.length) walk(kids);
    }
  };
  walk(tree);
  if (!items.length) { toast('Nothing to switch between yet', 'warning'); return; }
  openMenu(anchor, items, {
    title: 'branches - picking one starts a new branch from there',
    width: 420,
    search: 'filter branch points…',
    align: 'right',
  });
}

async function forkAt(entryId, text) {
  const ok = await askDialog({
    title: 'Start a new branch?',
    body: text,
    hint: 'The conversation continues from this point. The old continuation stays in the session file.',
    okLabel: 'fork',
  });
  if (!ok) return;
  try {
    // pi forks *before* the message you picked and returns its text so the client
    // can send it again - that is what its own UI does with the reply. Ignoring
    // it left the new branch ending one turn earlier than the turn you clicked,
    // which is why every fork looked like it came from the wrong turn.
    const res = await rpc({ type: 'fork', entryId });
    await initSession(false);
    const again = res && typeof res.text === 'string' ? res.text.trim() : '';
    if (again && !res.cancelled) {
      toast('Forked - continuing from here');
      rpc({ type: 'prompt', message: res.text }).catch((e) => toast(`Continue failed: ${e.message}`, 'error'));
    } else {
      toast('Forked - continue from here');
    }
  } catch (e) {
    toast(`Fork failed: ${e.message}`, 'error');
  }
}

/* Right-click a message. On a user turn there is a fork entry for it; on an
 * assistant turn the fork point is the user message that started it, so walk
 * back to the nearest one. Reading a session the agent has not loaded cannot be
 * forked in place - the agent has to switch to it first, which the menu says. */
function openTurnMenu(node, at) {
  const m = node._msg || null;
  let forkNode = node;
  if (!forkNode.dataset.fork) {
    let prev = forkNode.previousElementSibling;
    while (prev && !prev.dataset.fork) prev = prev.previousElementSibling;
    forkNode = prev || null;
  }
  const entryId = forkNode && forkNode.dataset.fork ? forkNode.dataset.fork : null;
  const items = [];
  if (entryId) {
    const elsewhere = !!S.viewSession;
    items.push({
      label: elsewhere ? 'open this session and fork here' : 'fork from here',
      hint: elsewhere ? 'the agent has to load it first' : 'new branch at this message',
      onPick: () => (elsewhere ? forkInOtherSession(entryId, forkNode.dataset.forktext || '') : forkAt(entryId, forkNode.dataset.forktext || '')),
    });
  }
  if (m && m.role === 'assistant' && !S.viewSession) items.push({ label: 'clone session here', hint: 'copy the session up to now', onPick: () => cloneHere() });
  const md = node.querySelector('.md');
  const text = md ? md.innerText : '';
  if (text) {
    if (items.length) items.push({ sep: true });
    items.push({ label: 'copy text', onPick: () => copyText(text, 'Copied the message') });
    items.push({ label: 'speak', onPick: () => speak(stripMarkdown(text)) });
  }
  // Right-clicking a word you just dragged over is how you copy in every other
  // app. This menu replaces the browser's, so it has to offer it itself.
  const selected = selectedText();
  if (selected) {
    items.unshift({
      label: 'copy selection',
      hint: selected.length > 40 ? `${selected.slice(0, 40)}…` : selected,
      onPick: () => copyText(selected, 'Copied the selection'),
    });
    if (items.length > 1) items.splice(1, 0, { sep: true });
  }
  if (!items.length) return;
  openMenu(node.querySelector('.who') || node, items, { title: 'message', width: 320, at });
}

/* Forking in a session the agent has not loaded: switch to it, then fork. */
async function forkInOtherSession(entryId, text) {
  const target = S.viewSession;
  if (!target) return;
  const ok = await askDialog({
    title: 'Open that session and fork?',
    body: text,
    hint: 'The agent switches to it first - it can only fork in the session it has loaded.',
    okLabel: 'fork',
  });
  if (!ok) return;
  try {
    await rpc({ type: 'switch_session', sessionPath: target });
    S.state.sessionFile = target;
    S.viewSession = null;
    S.liveDetached = null;
    await initSession(false);
    const res = await rpc({ type: 'fork', entryId });
    await initSession(false);
    const again = res && typeof res.text === 'string' ? res.text.trim() : '';
    if (again && !res.cancelled) {
      toast('Forked - continuing from here');
      rpc({ type: 'prompt', message: res.text }).catch((e) => toast(`Continue failed: ${e.message}`, 'error'));
    } else {
      toast('Forked - continue from here');
    }
  } catch (e) {
    toast(`Fork failed: ${e.message}`, 'error');
  }
}

async function cloneHere() {
  try {
    await rpc({ type: 'clone' });
    await initSession(false);
    toast('Cloned into a new session');
  } catch (e) {
    toast(`Clone failed: ${e.message}`, 'error');
  }
}

/* ── instances ────────────────────────────────────────────────────────────
 * Other pi agents (other machines, or a second bridge on this one) in the
 * sidebar. Switching opens that instance's own WebUI, so its name, picture and
 * every other setting stay with it - each bridge keeps its own settings file.
 * The dot comes from /api/health, the one endpoint that answers cross-origin. */
function localInstance() { return { id: 'local', name: (SET.agentName || '').trim() || 'this machine', url: location.origin }; }
function allInstances() {
  const out = [localInstance()];
  for (const i of SET.instances || []) if (i && i.url) out.push(i);
  return out;
}
function instanceStatus(url) {
  return S.instanceStatus[url === location.origin ? 'local' : url] || null;
}

async function pollInstances() {
  await Promise.all(allInstances().map(async (inst) => {
    const key = inst.url === location.origin ? 'local' : inst.url;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 4000);
      const d = await fetch(`${inst.url}/api/health`, { signal: ctl.signal, cache: 'no-store' }).then((r) => r.json());
      clearTimeout(t);
      S.instanceStatus[key] = { ok: !!d.ok, busy: !!d.busy, name: d.name || null, at: Date.now() };
    } catch {
      S.instanceStatus[key] = { ok: false, busy: false, at: Date.now() };
    }
  }));
  updateInstanceBtn();
  if (openMenuEl && openMenuEl._instances) refreshInstanceMenuInPlace(openMenuEl);
}

/* The other instance's name and picture, for the switcher. /api/instance-card
 * answers cross-origin (like /api/health), so this works before switching. */
/* Asking each instance who it is. Concurrent calls share one round of requests:
 * the menu, the poll and the switcher itself all want this, and a call that
 * triggers another call is how this turned into an endless fetch loop (Firefox
 * said so out loud, and the page had to be closed). */
let instanceCardsPromise = null;
function refreshInstanceCards() {
  if (instanceCardsPromise) return instanceCardsPromise;
  instanceCardsPromise = loadInstanceCards().finally(() => { instanceCardsPromise = null; });
  return instanceCardsPromise;
}

async function loadInstanceCards() {
  await Promise.all(allInstances().map(async (inst) => {
    if (inst.url === location.origin) return;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 4000);
      // Through *this* bridge's proxy, not straight at the other machine: a direct
      // cross-origin fetch needs that bridge to send the right header, and an older
      // one (or a machine behind anything) simply never answers - which is why the
      // other instance's picture was missing from the switcher while switching to
      // it showed the picture fine (that path already went through the proxy).
      const via = api(`/proxy/${encodeURIComponent(inst.url)}/api/instance-card`);
      const d = await fetch(via, { signal: ctl.signal, cache: 'no-store' }).then((r) => r.json());
      clearTimeout(t);
      if (d && d.ok) S.instanceCards[inst.url] = d;
      // The card may carry no picture at all (nothing set there, or an older
      // bridge): fall back to that instance's settings, through the proxy.
      if (d && d.ok && !d.avatar && S.remote === inst.url) loadRemoteLook().catch(() => {});
    } catch { /* unreachable: keep whatever we had */ }
  }));
}

function instanceAvatar(inst) {
  if (!inst) return null;
  if (inst.url === location.origin) {
    const own = SET.avatar || null;
    // the same rule as below: these rows are <img>s
    return own && isVideoSrc(own) ? avatarStillSrc(own) : own;
  }
  const card = S.instanceCards[inst.url];
  const src = (card && card.avatar) || inst.avatar || null;
  if (!src) return null;
  // A picture stored on the other machine is a relative "/api/bg-file?name=..."
  // URL, which this page would ask *this* machine for - that is the broken image
  // in the instance list. Anything not already inline goes through the proxy, so
  // the local bridge fetches it (and an old remote, or one whose media route
  // needs a header, still shows up).
  let url = null;
  if (/^(data:|blob:)/i.test(src)) url = src;
  else if (/^https?:/i.test(src)) {
    try { const u = new URL(src); url = `/proxy/${encodeURIComponent(inst.url)}${u.pathname}${u.search}`; } catch (e) { /* odd url */ }
  }
  if (!url) url = `/proxy/${encodeURIComponent(inst.url)}${src.startsWith('/') ? src : `/${src}`}`;
  // These rows draw an <img>, and an <img> cannot show a video: a video pfp is
  // what produced the broken image in the instance list. Use the still frame the
  // avatar code captures (and re-draws once it exists).
  return isVideoSrc(url) ? avatarStillSrc(url) : url;
}

function updateInstanceBtn() {
  const btn = $('btn-instance');
  if (!btn) return;
  const nameEl = $('instance-name');
  const subEl = $('instance-sub');
  const cur = S.remote ? (S.remoteName || S.remote) : ((SET.agentName || '').trim() || 'this machine');
  if (nameEl) nameEl.textContent = cur;
  const st = instanceStatus(S.remote || location.origin);
  if (subEl) {
    const others = allInstances().length - 1;
    subEl.textContent = S.remote
      ? (st && st.busy ? 'another instance · working' : st && st.ok === false ? 'another instance · unreachable' : 'another instance')
      : `this machine${others ? ` · ${others} other${others > 1 ? 's' : ''}` : ''}`;
  }
  btn.title = S.remote
    ? `Looking at ${cur} — click to switch back or elsewhere`
    : 'pi agent instances - click to switch or add another one';
  btn.classList.toggle('remote', !!S.remote);
  updateRemoteBanner();
}

/* ── looking at another instance without leaving this one ─────────────────
 * The local bridge proxies to it (/proxy/<origin>/...), so the page stays on this
 * origin: the switcher keeps working even when that machine is off, which is the
 * difference between a dead end and a click back. */
async function enterRemoteMode(inst) {
  if (!inst) return;
  if (inst.url === location.origin) return exitRemoteMode();
  let origin;
  try { origin = new URL(inst.url).origin; } catch { toast('That instance URL does not look right', 'error'); return; }
  S.remote = origin;
  S.remoteName = inst.name || origin;
  try { sessionStorage.setItem('piwebui-remote', JSON.stringify({ url: origin, name: S.remoteName })); } catch { /* private mode */ }
  closeMenu();
  toast(`Looking at ${S.remoteName} (through this machine)`);
  await reloadForInstance();
}

function exitRemoteMode() {
  if (!S.remote) return;
  S.remote = null;
  S.remoteName = null;
  try { sessionStorage.removeItem('piwebui-remote'); } catch { /* ignore */ }
  toast('Back to this machine');
  reloadForInstance();
}

/* Everything on screen comes from whichever instance we are looking at, so the
 * socket is reopened (through the proxy) and the whole UI re-read.
 *
 * The socket *is* the agent connection, and it used to be closed through a name
 * that does not exist here - so the old (local) socket stayed open, connect()
 * saw an open socket and did nothing, and from then on the HTTP calls went to the
 * new instance while every RPC still went to the old agent. That is what made
 * "+ new" create the session on the wrong machine. Closing S.ws and clearing it
 * first is the whole fix for that; the rest is dropping the state that belonged
 * to the instance we just left. */
async function reloadForInstance() {
  try { if (S.ws) { S.ws.onclose = null; S.ws.onerror = null; S.ws.close(); } } catch { /* already gone */ }
  S.ws = null;
  // The instance's look (name, picture, background) before anything is drawn.
  S.remoteLook = null;
  S.viewSession = null;
  S.viewSubagent = null;
  S.subagents = new Map();
  S.subagentsFor = null;
  S.sessionsList = [];
  S.forkEntries = [];
  S.compactionMarks = [];
  S.compactionLive = null;
  S.compacting = false;
  S.ctxStats = null;
  S.ctxDisplayTokens = null;
  S.ctxBaseTokens = null;
  S.ctxTurnPeak = 0;
  S.totals = { read: 0, write: 0 };
  S.lastTurn = null;
  S.runStartTs = null;
  S.runMs = null;
  S.state = {};
  S.queue = { steering: [], followUp: [] };
  S.isStreaming = false;
  document.body.classList.remove('compacting');
  // The streaming message - and the parked DOM of the instance we are leaving -
  // must go with it. Keeping S.live meant the *old* agent's half-written answer
  // was re-attached to the new instance's chat (refreshMessages restores the
  // parked fragment) and kept being updated, so it looked like the other machine's
  // agent was typing into this conversation.
  try { if (S.live && S.live.root) releaseVideosIn(S.live.root); } catch { /* not rendered yet */ }
  try {
    if (S.liveDetached && S.liveDetached.frag) {
      S.liveDetached.frag.childNodes.forEach((n) => releaseVideosIn(n));
      S.liveDetached.frag.replaceChildren();
    }
  } catch { /* nothing parked */ }
  S.live = null;
  S.liveDetached = null;
  S.toolCards = new Map();
  S.thinkingEl = null;
  try { $('chat').replaceChildren(); } catch { /* nothing rendered yet */ }
  try { renderQueue(); updateStreamUi(); updateViewBanner(); } catch { /* not wired yet */ }
  updateSubagentsBtn();
  syncSessionHighlight();
  // The other instance's identity (and its background), then reconnect: the
  // socket's onopen runs the whole init against the new one.
  await loadRemoteLook().catch(() => {});
  // Unconditionally, both directions: on the way *back* loadRemoteLook() returns
  // early, and the picture and background would have stayed the other instance's.
  applySettings();
  updateInstanceBtn();
  connect();
}

function updateRemoteBanner() {
  const b = $('remote-banner');
  if (!b) return;
  if (!S.remote) { b.classList.add('hidden'); b.textContent = ''; return; }
  const st = instanceStatus(S.remote);
  // The socket is the honest signal here: an instance that is switched off has no
  // status to read (it never appears in the poll), but there is nothing connected.
  const down = (!S.ws || S.ws.readyState !== 1) || (st && st.ok === false);
  b.classList.remove('hidden');
  b.replaceChildren();
  b.appendChild(el('span', null,
    `Looking at “${S.remoteName || S.remote}” — sessions, chat and models are that machine's.`
    + (down ? ' It is not answering right now.' : '')));
  const back = el('button', 'btn small', 'switch back to this machine');
  back.onclick = () => exitRemoteMode();
  b.appendChild(back);
}

function openInstanceMenu(anchor, force) {
  const items = [];
  for (const inst of allInstances()) {
    const st = instanceStatus(inst.url);
    const here = inst.url === location.origin;
    const looking = S.remote ? inst.url === S.remote : here;
    const card = S.instanceCards[inst.url];
    items.push({
      avatar: instanceAvatar(inst),
      avatarPlaceholder: !instanceAvatar(inst),
      instanceUrl: inst.url,
      label: (looking ? '● ' : '') + inst.name + (!here && card && card.name ? `  (${card.name})` : ''),
      hint: here ? 'this machine' : String(inst.url).replace(/^https?:\/\//, ''),
      dot: st && st.busy ? 'live-dot' : (st && st.ok ? null : 'off-dot'),
      active: looking,
      onPick: () => (here ? exitRemoteMode() : enterRemoteMode(inst)),
      onContext: here ? null : (it, row) => openInstanceContextMenu(row, inst),
    });
  }
  items.push({ sep: true });
  items.push({ label: 'add another pi agent…', hint: 'other machine or port', onPick: () => addInstance() });
  const menu = openMenu(anchor, items, { title: 'pi agents', width: 360, force, hint: 'right-click an instance to remove it' });
  if (menu) menu._instances = true;
  // Names and pictures arrive after the first open; redraw once they are in.
  // Pictures arrive a moment later. Update the rows that are on screen instead of
  // opening the menu again: re-opening re-ran this function, which fetched again,
  // which re-opened again - a loop with no yield, and the page stopped responding.
  refreshInstanceCards().then(() => {
    if (menu && menu.isConnected) refreshInstanceMenuInPlace(menu);
  }).catch(() => {});
}

/* Refresh what the open instance menu shows - the status dots and the pictures -
 * without touching its structure, so nothing the user is pointing at moves. */
function refreshInstanceMenuInPlace(menu) {
  menu = menu || (openMenuEl && openMenuEl._instances ? openMenuEl : null);
  if (!menu) return;
  for (const inst of allInstances()) {
    const row = menu.querySelector(`.model-item[data-instance="${cssEscape(inst.url)}"]`);
    if (!row) continue;
    const st = instanceStatus(inst.url);
    const dot = row.querySelector('.menu-dot');
    const wantDot = st && st.busy ? 'live-dot' : (st && st.ok ? null : 'off-dot');
    if (dot) {
      if (wantDot) dot.className = `menu-dot ${wantDot}`;
      else dot.remove();
    } else if (wantDot) {
      row.insertBefore(el('span', `menu-dot ${wantDot}`), row.querySelector('.model-label'));
    }
    setRowAvatar(row, instanceAvatar(inst));
  }
}

/* Swap the circle at the front of a row for the right picture, whether it is
 * currently a placeholder span or an img with a stale source. */
function setRowAvatar(row, src) {
  const current = row.querySelector('.menu-avatar');
  if (!src) {
    if (current && current.tagName === 'IMG') {
      const span = el('span', 'menu-avatar empty', '');
      current.replaceWith(span);
    }
    return;
  }
  if (current && current.tagName === 'IMG') {
    if (current.getAttribute('src') !== src) current.src = src;
    return;
  }
  const img = el('img', 'menu-avatar');
  img.alt = '';
  // A picture that cannot be fetched must not leave the "broken image" glyph in
  // the list: fall back to the same empty slot as "no picture".
  img.onerror = () => {
    const span = el('span', 'menu-avatar empty', '');
    span.title = 'picture could not be loaded';
    img.replaceWith(span);
  };
  img.src = src;
  if (current) current.replaceWith(img);
  else row.insertBefore(img, row.firstChild);
}

/* Attribute selectors need escaping: instance URLs are full of : and / . */
function cssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

/* Right-click an instance: switch to it here, open its own page, or take it off
 * the list. Removal used to be a row at the bottom of the menu, which made the
 * list of agents double as a list of delete buttons. */
function openInstanceContextMenu(row, inst) {
  const items = [
    { label: `switch to ${inst.name} here`, hint: 'this window, through this machine', onPick: () => enterRemoteMode(inst) },
    { label: 'open its own page', hint: String(inst.url).replace(/^https?:\/\//, ''), onPick: () => openInstancePage(inst) },
    { sep: true },
    {
      label: `remove ${inst.name} from the list`,
      hint: 'stops showing up in the switcher',
      danger: true,
      onPick: async () => {
        const yes = await askDialog({
          title: `Remove “${inst.name}”?`,
          body: 'It stays reachable at its address; it just leaves this list.',
          okLabel: 'remove',
          danger: true,
        });
        if (!yes) return;
        SET.instances = (SET.instances || []).filter((x) => x.url !== inst.url);
        saveSettings();
        updateInstanceBtn();
        toast(`Removed ${inst.name}`);
      },
    },
  ];
  openMenu(row, items, { title: inst.name, width: 320, force: true, sub: true, at: { x: row.getBoundingClientRect().left, y: row.getBoundingClientRect().bottom } });
}

/* Opening the other instance's own page navigates away and hands the URL to the
 * other bridge, which adds us to its list so there is a way back. */
function openInstancePage(inst) {
  const me = (SET.agentName || '').trim() || 'this machine';
  const sep = inst.url.includes('?') ? '&' : '?';
  location.href = `${inst.url}${sep}from=${encodeURIComponent(location.origin)}&fromName=${encodeURIComponent(me)}`;
}

function switchInstance(inst) {
  if (!inst || inst.url === location.origin) return exitRemoteMode();
  return enterRemoteMode(inst);
}

/* An instance opened through the switcher arrives with ?from=… - add it to the
 * list so the switcher can go back. Runs once, from updateInstanceBtn. */
let absorbedFrom = false;
function absorbFromParam() {
  if (absorbedFrom) return;
  let params;
  try { params = new URL(location.href).searchParams; } catch { absorbedFrom = true; return; }
  const from = params.get('from');
  if (!from) { absorbedFrom = true; return; }
  // Only now is it safe to touch the list: called before the settings arrive,
  // SET was replaced wholesale a moment later and the new entry was lost.
  absorbedFrom = true;
  let base;
  try { base = new URL(from).origin; } catch { return; }
  const name = params.get('fromName') || base;
  if (base && base !== location.origin && !allInstances().some((i) => i.url === base)) {
    SET.instances = [...(SET.instances || []), { id: `i${Date.now().toString(36)}`, name, url: base }];
    saveSettings();
    toast(`Added "${name}" to the instance list so you can switch back`);
  }
  try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
}

function addInstance() {
  askDialog({
    title: 'Add another pi agent',
    body: 'Its WebUI address. Add an SSH tunnel or start that bridge with PI_WEBUI_HOST=0.0.0.0 to reach another machine.',
    fields: [
      { name: 'name', label: 'name', placeholder: 'laptop' },
      { name: 'url', label: 'address', placeholder: 'http://192.168.1.20:3080', value: 'http://' },
    ],
    require: ['name', 'url'],
    okLabel: 'add',
  }).then((res) => {
    if (!res) return;
    let url = String(res.url).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) url = `http://${url}`;
    let base;
    try { base = new URL(url).origin; } catch { toast('That is not a valid address', 'error'); return; }
    if (allInstances().some((i) => i.url === base)) { toast('That instance is already in the list', 'warning'); return; }
    SET.instances = [...(SET.instances || []), { id: `i${Date.now().toString(36)}`, name: res.name, url: base }];
    saveSettings();
    updateInstanceBtn();
    toast(`${res.name} added - click it to switch`);
    pollInstances().catch(() => {});
  });
}

/* ───────────────────────── boot ───────────────────────── */

wireTypeAnywhere();
applySettings();
populateTtsVoiceSelect();
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
if (SET.reelsOpen && SHORTS_FEEDS[SET.shortsProvider || 'instagram']) {
  setTimeout(() => { if (reelsHidden()) showReels(SET.shortsProvider); }, 600);
}
