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

function formatTok(n) {
  if (n == null || isNaN(n)) return null;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(Math.round(n));
}

/* Live elapsed-time timer for a running tool card (bash etc.). */
function fmtElapsed(ms) {
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.round((s % 3600) / 60) + 'm';
}
function startCardTimer(card) {
  if (card._timer) return;
  card._start = Date.now();
  const tick = () => {
    card.timerEl.classList.remove('hidden');
    card.timerEl.textContent = fmtElapsed(Date.now() - card._start);
  };
  tick();
  card._timer = setInterval(tick, 1000);
}
function stopCardTimer(card, stateText) {
  if (card._timer) {
    clearInterval(card._timer);
    card._timer = null;
  }
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
  autoExpandThinking: false, // render thinking blocks open by default
  autoExpandTools: false, // render tool call output open by default
  sttEndpoint: '',        // whisper-compatible transcription endpoint
  sttBackend: 'whisper',  // 'whisper' or 'browser'
  ttsBackend: 'browser',  // 'browser' | 'endpoint'
  ttsEndpoint: '',        // OpenAI-compatible /v1/audio/speech server (Piper etc.)
  ttsModel: 'piper',
  ttsVoiceName: '',
  themeAccent: null,      // custom accent color
  themeBg: null,          // background image (URL or dataURL) or video URL
  onboarded: false,       // first-launch setup completed
  shortsProvider: 'instagram', // 'instagram' | 'tiktok' | 'youtube' | 'none'
  shortsAutoOpen: false,  // open the feed while the agent runs, close it when the run finishes
  shortsMode: 'panel',    // 'panel' (in-app split) | 'window' (side window, full feed) | 'tab' — legacy 'split'='panel', 'popup'='window'
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
};
let SET = { ...DEFAULT_SETTINGS };
try { Object.assign(SET, JSON.parse(localStorage.getItem('piwebui-settings') || '{}')); } catch { /* defaults */ }
let settingsLoaded = false;

function saveSettings() {
  applySettings();
  try { localStorage.setItem('piwebui-settings', JSON.stringify(SET)); } catch { /* cache only */ }
  // authoritative copy lives in webui-settings.json next to the project
  fetch('/api/ui-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SET),
  }).catch(() => {});
}

async function loadServerSettings() {
  try {
    const data = await fetch('/api/ui-settings').then((r) => r.json());
    if (data && Object.keys(data).length) {
      Object.assign(SET, data);
      applySettings();
    }
    settingsLoaded = true;
  } catch { /* offline bridge: keep cache */ }
}

function applySettings() {
  $('agent-title').textContent = SET.agentName || 'pi agent';
  document.title = `${SET.agentName || 'Pi agent'}`;
  const tts = $('btn-tts');
  tts.textContent = S.autoTts ? 'TTS on' : 'TTS off';
  tts.classList.toggle('on', S.autoTts);
  // reflect in already-rendered "who" lines
  document.querySelectorAll('.msg.assistant .who .agent-name-label').forEach((e) => {
    e.textContent = SET.agentName || 'pi';
  });
  refreshAvatars();
  // thinking blocks visibility
  document.body.classList.toggle('hide-thinking', SET.showThinking === false);
  const st = $('set-show-thinking');
  if (st) st.checked = SET.showThinking !== false;
  // theme
  const rootStyle = document.documentElement.style;
  // text outline: a 4-way shadow keeps glyphs readable when the panels are
  // translucent and the background image shows through.
  document.body.classList.toggle('text-outline', SET.textOutline !== false);
  rootStyle.setProperty('--outline-color', SET.textOutlineColor || '#000000');
  const avSize = Math.max(16, Math.min(120, Number(SET.avatarSize) || 34));
  rootStyle.setProperty('--avatar-size', `${avSize}px`);
  if (SET.themeAccent) {
    rootStyle.setProperty('--accent', SET.themeAccent);
    rootStyle.setProperty('--accent-dim', `color-mix(in srgb, ${SET.themeAccent} 35%, #171b22)`);
  } else {
    rootStyle.removeProperty('--accent');
    rootStyle.removeProperty('--accent-dim');
  }
  applyBackgroundMedia();
  // chat-panel transparency (0 = fully transparent, 100 = solid)
  const alpha = SET.chatOpacity == null ? 1 : Math.max(0, Math.min(1, Number(SET.chatOpacity) / 100));
  rootStyle.setProperty('--ui-alpha', String(alpha));
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
  rootStyle.setProperty('--chat-size', `${Number(SET.chatFontSize) || 14}px`);
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
}

/* ───────────────────────── state ───────────────────────── */

const S = {
  ws: null,
  reqId: 0,
  pending: new Map(),      // req id -> resolve fn
  commands: [],            // from get_commands (extension / prompt / skill)
  builtinCommands: [],     // from /api/builtin-commands (pi's built-in slash commands)
  forkable: [],            // from get_fork_messages: [{entryId, text}]
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
  msgTiming: new Map(),    // message key -> {elapsedSec, prefillSec, est} for the t/s figure
  autoTts: false,
  speaking: false,
  stickToBottom: true,
  userScrolling: false,    // true during an active wheel/touch gesture (never pin then)
  live: null,              // in-flight assistant render {root, text, thinking, tools}
  toolCards: new Map(),    // toolCallId -> {card, body, stateEl}
  viewSession: null,       // session path being viewed (null = the agent's own session)
  liveDetached: null,      // { path, frag } — running session's live DOM, parked while viewing another
  sessionsList: [],        // last /api/sessions payload (path -> name lookup for the view banner)
  compactionLive: null,    // live "compacting…" block {root, t}
  lastCompaction: null,    // last compaction_end result (for the marker's "after" count)
  // Compactions we watched happen in this page session. Each is anchored to the
  // message index it sat at, so it stays put instead of being re-appended to the
  // bottom of the transcript on every turn.
  compactionMarks: [],     // [{ summary, tokensBefore, estimatedTokensAfter, at }]  (at = ms)
  ctxStats: null,          // last authoritative contextUsage from get_session_stats
  ctxDisplayTokens: null,  // high-water mark: the largest token count the ring has shown
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
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
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
    else if (msg.bridge === 'agent_stderr' && msg.text.trim()) console.warn('[pi stderr]', msg.text);
  };
  ws.onclose = () => {
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

/* Liveness heartbeat: a half-open WebSocket (sleep/wake, WebView2 network
 * hiccup) may never fire onclose on its own, leaving the UI frozen on a dead
 * connection. A cheap get_state with a short timeout detects that — if it
 * never answers, force a close so the onclose path can reconnect. */
setInterval(() => {
  const ws = S.ws;
  if (ws && ws.readyState === WebSocket.OPEN) {
    rpc({ type: 'get_state' }, 10000).catch((e) => {
      // Only a timeout means the connection is dead; an error response
      // (e.g. agent restarting) means the bridge is alive.
      if (!/timed out/.test(e.message)) return;
      try { ws.close(); } catch { /* already closing */ }
    });
  }
}, 25000);

function send(obj) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(obj));
}

/* Resolve when the (re)started agent reports agent_started. */
let agentReadyWaiters = [];
function onAgentStarted() {
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
    S.pending.set(id, { resolve, reject });
    send(commandObj);
    setTimeout(() => {
      if (S.pending.has(id)) {
        S.pending.delete(id);
        reject(new Error(`${commandObj.type}: timed out`));
      }
    }, timeoutMs);
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
        if (!handledElsewhere) toast(`Agent error (${msg.command}): ${msg.error}`, 'error');
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

async function initSession(resumeLast) {
  try {
    await rpc({ type: 'get_state' }).then((d) => applyState(d));
    if (resumeLast) await resumeLastSession();
    await refreshModels();
    await refreshLevels();
    await refreshCommands();
    await refreshBuiltinCommands();
    await refreshMessages();
    await refreshForkable();
    await refreshSessions();
    await refreshStats();
    S.initialized = true;
  } catch (e) {
    console.error('init failed', e);
    toast(`Init failed: ${e.message}`, 'error');
  }
}

/* A fresh pi process always starts a new empty session; on page load, reopen
 * the most recent session instead so work continues where it left off. */
async function resumeLastSession() {
  try {
    const res = await fetch('/api/sessions');
    const d = await res.json();
    const cur = S.state.sessionFile;
    const known = cur && d.sessions.some((s) => s.path === cur);
    if (!known && d.sessions.length && d.sessions[0].path !== cur) {
      await rpc({ type: 'switch_session', sessionPath: d.sessions[0].path });
      await rpc({ type: 'get_state' }).then((st) => applyState(st));
      toast(`Resumed last session: ${(d.sessions[0].name || 'unnamed').slice(0, 60)}`);
    }
  } catch { /* no sessions yet */ }
}

/* ───────────────────────── state / config refresh ───────────────────────── */

function applyState(d) {
  S.state = d || {};
  if (d) {
    if (d.sessionName) $('session-name').value = d.sessionName;
    else if (!$('session-name').value) $('session-name').value = '';
    // otherwise the derived session name (first user message) fills in via refreshSessions
    if (d.isStreaming !== undefined) S.isStreaming = d.isStreaming;
    if (d.model && d.model.id) syncSelect($('model-select'), `${d.model.provider}||${d.model.id}`);
    if (d.thinkingLevel) syncSelect($('thinking-select'), d.thinkingLevel);
    updateStreamUi();
    // Reconnect while a run is already going: the feed should be open too.
    if (d.isStreaming) autoOpenShortsIfEnabled();
  }
}

function syncSelect(sel, value) {
  if (value && [...sel.options].some((o) => o.value === value)) sel.value = value;
  if (sel && sel.id === 'model-select') updateModelBtn();
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
let llamaConfiguredUrl = null;
let llamaMismatchBanner = false;
let llamaFixInFlight = false;

async function refreshLlamaGroup() {
  const sel = $('model-select');
  const old = sel.querySelector('optgroup[data-llama]');
  if (old) old.remove();
  try {
    const [d, cfg] = await Promise.all([
      fetch('/api/llama-models').then((r) => r.json()),
      fetch('/api/llama-config').then((r) => r.json()),
    ]);
    llamaConfiguredUrl = cfg.url || null;
    llamaLiveServers = d.servers || [];
    if (!llamaLiveServers.length) {
      hideLlamaMismatch();
      return;
    }
    const known = new Set(S.models.map((m) => `${m.provider}||${m.id}`));
    const group = el('optgroup', null, 'llama.cpp (local)');
    group.dataset.llama = '1';
    let unregistered = null;
    for (const srv of llamaLiveServers) {
      const short = srv.url.replace(/^https?:\/\//, '');
      const registered = S.models.some((m) => m.provider === srv.providerId);
      if (!registered && !unregistered) unregistered = srv;
      for (const m of srv.models) {
        const key = `${srv.providerId}||${m.id}`;
        if (known.has(key)) continue; // already listed by the agent itself
        const o = el('option', null, llamaLiveServers.length > 1 ? `${m.name || m.id} · ${short}` : (m.name || m.id));
        o.value = key;
        group.appendChild(o);
      }
    }
    if (group.children.length) sel.appendChild(group);
    if (unregistered) showLlamaMismatch(unregistered);
    else hideLlamaMismatch();
  } catch { /* bridge offline or no llama.cpp server */ }
}

function showLlamaMismatch(srv) {
  const short = srv.url.replace(/^https?:\/\//, '');
  const configured = (llamaConfiguredUrl && llamaConfiguredUrl !== srv.url)
    ? `pi is configured for ${llamaConfiguredUrl.replace(/^https?:\/\//, '')} (unreachable)`
    : 'pi has not registered it yet';
  showBanner('warn',
    `llama.cpp server found at ${short} with ${srv.models.length} models, but ${configured} — selecting its models will fail until pi is pointed at it. pi needs the pi-llama-cpp extension to register it (install with: pi install npm:pi-llama-cpp), then point pi at this server and restart.`,
    'Point pi here & reload',
    () => fixLlamaConfig(srv.url));
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
async function fixLlamaConfig(url) {
  if (llamaFixInFlight) return;
  llamaFixInFlight = true;
  toast('Updating pi config and restarting the agent…');
  try {
    const r = await fetch('/api/llama-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
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
    llamaLiveServers.every((s) => S.models.some((m) => m.provider === s.providerId));
  if ((g && g.children.length) || allRegistered || attempt >= LLAMA_RETRY_DELAYS.length) return;
  setTimeout(() => { ensureLlamaGroup(attempt + 1); }, LLAMA_RETRY_DELAYS[attempt]);
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
      const o = el('option', null, `thinking: ${lv}`);
      o.value = lv;
      sel.appendChild(o);
    });
    if (S.state.thinkingLevel) syncSelect(sel, S.state.thinkingLevel);
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
    const d = await fetch('/api/builtin-commands').then((r) => r.json());
    S.builtinCommands = Array.isArray(d.commands) ? d.commands : [];
  } catch { S.builtinCommands = []; }
}

async function refreshForkable() {
  try {
    const d = await rpc({ type: 'get_fork_messages' });
    S.forkable = asArray(d, 'messages');
  } catch { S.forkable = []; }
}

async function refreshStats() {
  try {
    const d = await rpc({ type: 'get_session_stats' });
    const cost = d && d.cost && d.cost.total != null ? Number(d.cost.total) : null;
    $('stat-cost').textContent = cost != null
      ? `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}`
      : '';
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
function setCtxRing(cu, store = true) {
  if (store) S.ctxStats = cu && cu.tokens != null && cu.contextWindow ? { ...cu } : null;
  const fg = $('ctx-ring-fg');
  const txt = $('ctx-ring-text');
  const label = $('ctx-label');
  const wrap = fg.closest('.ctx-ring');
  const C = 2 * Math.PI * parseFloat(fg.getAttribute('r'));
  const tokens = cu && cu.tokens;
  const max = cu && cu.contextWindow;
  if (tokens == null || !max) {
    // Unknown or just compacted: dash + empty ring.
    txt.textContent = '–';
    fg.setAttribute('stroke-dasharray', '0 999');
    wrap.title = 'Context unknown — waiting for the next response';
    wrap.classList.remove('warn', 'critical');
    if (label) label.textContent = '–';
    S.ctxDisplayTokens = null;
    return;
  }
  const p = cu.percent != null
    ? Math.max(0, Math.min(100, cu.percent))
    : Math.max(0, Math.min(100, (tokens / max) * 100));
  S.ctxDisplayTokens = tokens;
  fg.setAttribute('stroke-dasharray', `${(C * p / 100).toFixed(1)} ${C.toFixed(1)}`);
  txt.textContent = p >= 10 ? String(Math.round(p)) : p.toFixed(1);
  wrap.title = `Context: ${formatTok(tokens)} / ${formatTok(max)} tokens (${p.toFixed(1)}%)`;
  wrap.classList.toggle('warn', p >= 75 && p < 90);
  wrap.classList.toggle('critical', p >= 90);
  if (label) label.textContent = `[${formatTok(tokens)}/${formatTok(max)}ctx]`;
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
  let tokens;
  const real = usageContextTokens(S.live && S.live.lastUsage);
  if (real != null) {
    tokens = Math.max(real, S.ctxBaseTokens || 0, S.ctxDisplayTokens || 0);
  } else {
    const estimate = (S.ctxBaseTokens != null ? S.ctxBaseTokens : (b.tokens || 0)) + (estimatedExtra || 0);
    tokens = Math.max(estimate, S.ctxDisplayTokens || 0);
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
  $('stat-tokens').textContent = `↑ ${formatTok(read) ?? 0} · ↓ ${formatTok(write) ?? 0}`;
}

/* ───────────────────────── chat rendering ───────────────────────── */

function atBottom(slack = 60) {
  return chat.scrollHeight - chat.scrollTop - chat.clientHeight < slack;
}

function scrollBottom(force) {
  if (!force && S.liveDetached) return; // the live view is parked; don't scroll the visible session
  if (!force && S.userScrolling) return; // never pin from under an active wheel/touch gesture
  if (force || S.stickToBottom) {
    lastProgrammaticScroll = Date.now();
    chat.scrollTop = chat.scrollHeight;
  }
}
let lastProgrammaticScroll = 0;
let userScrollIdle = 0;
chat.addEventListener('scroll', () => {
  // Only an explicit wheel/touch gesture is trusted as "the user left the
  // bottom". A scroll event that lands just after we pinned is normally the
  // browser reacting to content being inserted above the viewport (the chat
  // grows between our pin and the next layout pass), and treating that as a
  // user scroll is what stopped auto-follow when a thinking block or tool card
  // appeared mid-turn. Real gestures set S.userScrolling and are always
  // honoured, so the guard can be strict here.
  if (!S.userScrolling && Date.now() - lastProgrammaticScroll < 250) return;
  S.stickToBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60;
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
chat.addEventListener('wheel', (e) => {
  if (e.deltaY < 0) S.stickToBottom = false;
  else if (atBottom()) S.stickToBottom = true;
  S.userScrolling = true;
  clearTimeout(userScrollIdle);
  userScrollIdle = setTimeout(() => {
    S.userScrolling = false;
    if (atBottom()) S.stickToBottom = true; // settled back at the bottom → follow again
  }, 180);
}, { passive: true });
chat.addEventListener('touchstart', () => { S.userScrolling = true; }, { passive: true });
chat.addEventListener('touchmove', () => { S.stickToBottom = atBottom(); }, { passive: true });
chat.addEventListener('touchend', () => {
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
    node.muted = true; node.loop = true; node.autoplay = true; node.playsInline = true;
    node.setAttribute('playsinline', '');
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
function avatarNode(sizeClass) {
  if (!SET.avatar) return null;
  const wrap = el('span', `avatar-wrap${sizeClass ? ' ' + sizeClass : ''}`);
  const node = attachCrop(mediaNode(SET.avatar, 'avatar'), SET.avatarCrop, 1);
  wrap.appendChild(node);
  return wrap;
}

/* Re-render every avatar after the image, its crop or its size changes. */
function refreshAvatars() {
  document.querySelectorAll('.msg.assistant .who').forEach((who) => {
    const old = who.querySelector('.avatar-wrap');
    if (old) old.remove();
    const node = avatarNode();
    if (node) who.insertBefore(node, who.firstChild);
  });
  const side = $('sidebar-avatar');
  if (side) {
    const node = avatarNode();
    if (node) { side.replaceChildren(...node.childNodes); side.hidden = false; }
    else { side.replaceChildren(); side.hidden = true; }
  }
  const prev = $('set-avatar-preview');
  if (prev) {
    // Only the user's own image here, so "clear" visibly clears it (the app
    // icon fallback in the RN shell is not something you can crop or delete).
    if (SET.avatar) {
      const node = avatarNode();
      prev.replaceChildren(...node.childNodes);
      prev.style.visibility = 'visible';
    } else {
      prev.replaceChildren();
      prev.style.visibility = 'hidden';
    }
  }
}

function makeMsgShell(role, who) {
  const root = el('div', `msg ${role}`);
  const head = el('div', 'who');
  if (role.includes('assistant')) {
    const av = avatarNode();
    if (av) head.appendChild(av);
    head.appendChild(el('span', 'agent-name-label', SET.agentName || 'pi'));
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

function renderUserMessage(msg) {
  const { text, images } = messageBlock(msg.content);
  const { root, tools, bubble } = makeMsgShell('user', `you · ${timeStr(msg.timestamp)}`);
  addCopyButton(tools, () => text);
  // fork index is (re)written onto the element by refreshMessages; read it at click time
  addToolButton(tools, 'edit', 'Edit & resend (forks the session from here)',
    () => startEdit(msg, root.dataset.forkIdx));

  if (images.length) {
    for (const im of images) {
      const img = el('img', 'msg-img');
      img.src = `data:${im.mimeType || 'image/png'};base64,${im.data}`;
      img.onclick = () => zoomImage(img.src);
      bubble.appendChild(img);
    }
  }
  if (text) {
    const body = el('div', 'md');
    body.innerHTML = renderMarkdown(text).replace(/^<p>/, '').replace(/<\/p>$/, '');
    bubble.appendChild(body);
  }
  chat.appendChild(root);
  scrollBottom();
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

  for (const block of msg.content || []) {
    if (block.type === 'text') {
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
        startCardTimer(card);
      }
      fillToolBody(card, block.name, block.arguments);
      bubble.appendChild(card.card);
      S.toolCards.set(block.id, card);
    }
  }
  if (!bubble.childNodes.length) bubble.appendChild(el('div', 'md', '(empty message)'));
  chat.appendChild(root);
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
  const stateEl = el('span', `tool-state${state === 'running' ? ' running' : ''}`);
  stateEl.appendChild(el('span', 'tool-state-label', state));
  if (state === 'running') stateEl.appendChild(makeDots());
  head.appendChild(stateEl);
  const timerEl = el('span', 'tool-timer hidden');
  head.appendChild(timerEl);
  const body = el('div', 'tool-body hidden');
  head.onclick = () => body.classList.toggle('hidden');
  card.append(head, body);
  return { card, head, body, stateEl, timerEl, _timer: null, _start: 0 };
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
  const bodyText = toolResultText(msg);
  if (card) {
    // keep a rendered edit diff — the result line adds nothing to it
    if (!card.body.querySelector('.diffbox')) card.body.textContent = bodyText;
    stopCardTimer(card, msg.isError ? 'error' : 'done');
    card.stateEl.className = `tool-state ${msg.isError ? 'error' : 'done'}`;
    if (!card.body.textContent && !card.body.firstChild) card.body.classList.add('hidden');
  } else {
    const { root, bubble } = makeMsgShell('tool', `${msg.toolName || 'tool'} result · ${timeStr(msg.timestamp)}`);
    const c = makeToolCard(msg.toolName || 'tool', { state: msg.isError ? 'error' : 'done' });
    c.stateEl.className = `tool-state ${msg.isError ? 'error' : 'done'}`;
    c.body.textContent = bodyText;
    c.body.classList.remove('hidden');
    bubble.appendChild(c.card);
    root.querySelector('.who').remove();
    chat.appendChild(root);
    scrollBottom();
  }
}

function toolResultText(msg) {
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'image') return `[image ${b.mimeType || ''}]`;
      return JSON.stringify(b);
    }).join('\n');
  }
  return c ? JSON.stringify(c, null, 2) : '';
}

/* Console/shell output renders as a plain "system" text box. */
function renderBashExecution(msg) {
  const { root, bubble } = makeMsgShell('system', `system · ${timeStr(msg.timestamp)}`);
  root.querySelector('.who').remove();
  bubble.textContent = `$ ${msg.command}\n${msg.output || '(no output)'}`;
  chat.appendChild(root);
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
  chat.appendChild(buildCompactionSummary(msg, extra));
}

/* Build the "conversation compacted" marker WITHOUT inserting it, so callers can
 * put it exactly where the compaction happened. */
function buildCompactionSummary(msg, extra) {
  const live = !!(extra && extra.live);
  const root = el('div', 'msg compaction' + (live ? ' pinned' : ''));
  const who = el('div', 'who');
  const before = msg.tokensBefore != null ? `${formatTok(msg.tokensBefore)} tok` : 'context';
  const after = extra && extra.estimatedTokensAfter != null
    ? ` → ${formatTok(extra.estimatedTokensAfter)} tok` : '';
  who.textContent = `conversation compacted · ${before}${after}`;
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

/* Live "compacting…" marker, shown the moment compaction_start arrives so the
 * user sees compaction happen in real time (with an elapsed timer). Replaced
 * by renderCompactionBlock() when compaction_end arrives. */
function renderCompactionLive() {
  const root = el('div', 'msg compaction compacting');
  const who = el('div', 'who');
  const spin = el('span', 'compaction-spin');
  who.appendChild(spin);
  who.appendChild(document.createTextNode(' compacting conversation… '));
  const timer = el('span', 'tool-timer');
  who.appendChild(timer);
  root.appendChild(who);
  chat.appendChild(root);
  const start = Date.now();
  const t = setInterval(() => { timer.textContent = fmtElapsed(Date.now() - start); }, 500);
  if (S.stickToBottom) scrollBottom();
  return { root, t };
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
  chat.appendChild(root);
  if (S.stickToBottom) scrollBottom();
}

// Read a session transcript from the bridge (messages + the compaction
// entries, which are not messages and so are absent from get_messages).
async function fetchSession(sessionPath) {
  const r = await fetch(`/api/session-messages?path=${encodeURIComponent(sessionPath)}`);
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || `failed (${r.status})`);
  return {
    messages: d.messages || [],
    compactions: (d.compactions || []).map((c) => ({
      ...c,
      at: c.timestamp ? Date.parse(c.timestamp) : null,
    })),
  };
}

async function refreshMessages() {
  let msgs;
  let fileMarks = [];
  if (S.viewSession) {
    // Viewing another session while the agent runs in its own: read it
    // read-only from the file (the get_messages RPC only knows the agent's
    // own session).
    const d = await fetchSession(S.viewSession);
    msgs = d.messages;
    fileMarks = d.compactions;
  } else {
    const d = await rpc({ type: 'get_messages' });
    msgs = asArray(d, 'messages');
    // Compactions are stored as their own entries in the session file and are
    // not part of get_messages, so re-read them — otherwise every "conversation
    // compacted" marker disappears on reload.
    if (S.state.sessionFile) {
      try { fileMarks = (await fetchSession(S.state.sessionFile)).compactions; } catch { /* file may be gone */ }
    }
  }
  // Markers we watched happen in this page session, plus the ones already in
  // the file. Deduped by summary text so a watched compaction is not doubled.
  const marks = [...S.compactionMarks];
  const markSeen = new Set(marks.map((k) => k.summary));
  for (const k of fileMarks) if (k.summary && !markSeen.has(k.summary)) marks.push(k);
  // Keep the reading position (distance from the bottom) across the re-render.
  const distFromBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight;
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
    for (const [id, card] of S.toolCards) {
      if (!liveIds.has(id) && card._timer) stopCardTimer(card, 'done');
    }
    S.toolCards.clear();
    for (const [id, card] of liveCards) S.toolCards.set(id, card);
    removeCompactionLive();
  }
  // session token totals summed from per-message usage
  let read = 0, write = 0, prevTs = null;
  for (const m of msgs) {
    const firstNew = chat.children.length;
    if (m.role === 'user') renderUserMessage(m);
    else if (m.role === 'assistant') {
      noteHistoryTiming(m, prevTs);
      renderAssistantMessage(m);
      if (m.usage) {
        read += (m.usage.input || 0) + (m.usage.cacheRead || 0) + (m.usage.cacheWrite || 0);
        write += m.usage.output || 0;
      }
    }
    else if (m.role === 'toolResult') renderToolResult(m);
    else if (m.role === 'bashExecution') renderBashExecution(m);
    else if (m.role === 'compactionSummary') {
      // A compaction we watched happen gets placed at its anchor below, so the
      // marker does not jump. One that came back with the session (page reload)
      // belongs right here in the transcript.
      if (!marks.some((k) => k.summary === m.summary)) renderCompactionSummary(m);
    }
    // Stamp whatever node(s) this message produced, so a compaction marker can
    // be anchored to a point in time instead of a shifting position.
    if (m.timestamp != null) {
      for (let i = firstNew; i < chat.children.length; i++) chat.children[i].dataset.ts = String(m.timestamp);
      prevTs = m.timestamp;
    }
  }
  // Put each compaction we watched happen back where it happened: after the last
  // message that already existed when it ran. Messages produced later have a
  // newer timestamp, so they render after the marker and it stays put instead of
  // being re-appended to the bottom on every turn. (Agent-session markers only —
  // they don't belong in a read-only render of another session.)
  if (!S.viewSession) {
    const plain = [...chat.querySelectorAll('.msg:not(.compaction)')];
    for (const k of marks) {
      let target = null;
      if (k.at != null) {
        for (const n of plain) {
          const ts = Number(n.dataset.ts);
          if (ts && ts <= k.at) target = n;
        }
      }
      const node = buildCompactionSummary(k, { live: true, count: marks.length });
      if (target) target.after(node);
      else if (plain.length) plain[0].before(node);
      else chat.appendChild(node);
    }
    // A compaction still in flight keeps its "compacting…" indicator: the
    // re-render above wiped the DOM node it lived in.
    if (S.compacting && !S.compactionLive) S.compactionLive = renderCompactionLive();
  }
  S.totals = { read, write };
  updateTotals();
  // Re-wire fork indexes for user messages in order.
  const userEls = [...chat.querySelectorAll('.msg.user')];
  userEls.forEach((e, i) => e.dataset.forkIdx = String(i));
  // Back on the agent's own session mid-stream: re-attach the in-flight live
  // message (it was parked in S.liveDetached while viewing elsewhere). Only
  // when the agent is still in the session the live view belongs to.
  if (!S.viewSession && S.liveDetached && S.live && S.liveDetached.path === S.state.sessionFile) {
    chat.appendChild(S.liveDetached.frag);
  }
  S.liveDetached = null;
  if (S.stickToBottom) scrollBottom(true);
  else chat.scrollTop = chat.scrollHeight - chat.clientHeight - distFromBottom;
}

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
      refreshSessions().catch(() => {});
      break;
    }
    case 'agent_start':
      S.isStreaming = true;
      updateStreamUi();
      autoOpenShortsIfEnabled();
      break;
    case 'agent_end':
    case 'agent_settled':
      if (msg.type === 'agent_settled') {
        S.isStreaming = false;
        autoCloseShortsIfOurs();
        // After a compaction the session history no longer matches the chat
        // DOM (older messages were summarized away and the "compacted" marker
        // is missing) — re-render from the session so the marker shows up.
        if (S.compactionHappened) {
          S.compactionHappened = false;
          refreshMessages().catch(() => {});
        }
        // Threshold/manual compactions stop the agent; keep the task going.
        if (S.compactionNeedsContinue) {
          S.compactionNeedsContinue = false;
          maybeAutoContinue();
        }
      }
      updateStreamUi();
      if (msg.type === 'agent_end') {
        finalizeLive();
        refreshCommands().catch(() => {});   // extensions may register commands late
        refreshStats().catch(() => {});
        refreshForkable().catch(() => {});
        refreshSessions().catch(() => {});
      }
      // Send the next message the user queued during compaction, now that the
      // agent is idle (agent_settled). No-op when the queue is empty.
      flushCompactionQueue();
      break;
    case 'message_start':
      startLive();
      break;
    case 'message_update':
      if (msg.usage && S.live) S.live.lastUsage = msg.usage;
      applyDelta(msg.assistantMessageEvent || {});
      break;
    case 'message_end':
      finalizeLive(msg.message);
      break;
    case 'turn_end':
      finalizeLive();
      break;
    case 'tool_execution_start':
      startToolCard(msg);
      break;
    case 'tool_execution_update': {
      const c = S.toolCards.get(msg.toolCallId);
      if (c && msg.partialResult !== undefined) {
        c.body.textContent = toolResultText({ content: msg.partialResult });
        c.body.classList.remove('hidden');
      }
      break;
    }
    case 'tool_execution_end': {
      const c = S.toolCards.get(msg.toolCallId);
      if (c) {
        if (msg.result !== undefined && !c.body.querySelector('.diffbox')) c.body.textContent = toolResultText({ content: msg.result });
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
      if ($('ctx-label')) $('ctx-label').textContent = 'compacting…';
      // Live "compacting…" block with an elapsed timer, removed on compaction_end.
      if (!S.compactionLive) S.compactionLive = renderCompactionLive();
      break;
    case 'compaction_end':
      S.compacting = false;
      if (msg.aborted) {
        removeCompactionLive();
        toast('Compaction cancelled', 'warning');
      } else if (msg.errorMessage) {
        removeCompactionLive();
        toast(msg.errorMessage, 'error');
      } else if (msg.result) {
        const before = msg.result.tokensBefore;
        const after = msg.result.estimatedTokensAfter;
        toast(`Compacted: ${before != null ? formatTok(before) : '?'} → ${after != null ? formatTok(after) : '?'} tokens`);
        S.lastCompaction = msg.result;
        // Remember it so refreshMessages() can put the marker back where it
        // happened instead of re-appending it to the bottom every turn.
        if (!S.compactionMarks.some((k) => k.summary === msg.result.summary)) {
          S.compactionMarks.push({ ...msg.result, at: Date.now() });
        }
        renderCompactionBlock(msg.result, msg.reason);
        S.compactionHappened = true;
        // willRetry=true (overflow) → pi retries the prompt itself. A manual
        // /compact never auto-continues (the user asked for it, task was done).
        // Only auto-compactions (threshold/overflow without retry) need a nudge.
        if (!msg.willRetry && msg.reason !== 'manual') S.compactionNeedsContinue = true;
      }
      // Context is unknown right after compaction (agent reports tokens:null
      // until the next response) — refresh to reflect that, then send any
      // messages the user queued while compaction was running.
      refreshStats().catch(() => {});
      flushCompactionQueue();
      break;
    default:
      break;
  }
}

/* live streaming render */
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
  chat.appendChild(root);
  S.live = { root, md, text: '', thinking: '', thinkingEl: null, caret: el('span', 'streaming-caret'),
    toolByIndex: new Map(),   // contentIndex -> tool card while a call is streaming
    toolArgChars: new Map(),  // contentIndex -> argument characters streamed so far
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

let liveRaf = null;
function renderLive() {
  if (liveRaf || !S.live) return;
  liveRaf = requestAnimationFrame(() => {
    liveRaf = null;
    if (!S.live) return;
    const L = S.live;
    if (L.thinking && !L.thinkingEl) {
      L.thinkingEl = makeThinking('');
      L.md.before(L.thinkingEl);
      pinSoon();   // the block is inserted above the caret — follow it
    }
    if (L.thinkingEl) L.thinkingEl.querySelector('.th-body').textContent = L.thinking;
    L.md.innerHTML = renderMarkdown(L.text);
    if (!L.text) L.md.appendChild(el('span', 'streaming-caret'));
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
  });
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
      if (S.autoTts) {
        const text = (finalMsg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
        if (text.trim()) speak(stripMarkdown(text));
      }
    } else {
      refreshMessages().catch(() => {});
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
    startCardTimer(existing);
    return existing;
  }
  const card = makeToolCard(msg.toolName || msg.name || 'tool', { toolCallId: msg.toolCallId });
  card.toolName = msg.toolName || msg.name || '';
  card._rawArgs = '';
  fillToolBody(card, card.toolName, msg.args);
  startCardTimer(card);
  const parent = S.live ? S.live.root.querySelector('.bubble') : chat;
  parent.appendChild(card.card);
  S.toolCards.set(msg.toolCallId, card);
  scrollBottom();
  pinSoon();
  return card;
}

function updateStreamUi() {
  // The Stop button appears next to the (always visible) Send button while the
  // agent is generating, so you can stop generation or steer/queue a message.
  $('btn-stop').classList.toggle('hidden', !S.isStreaming);
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
  const base = S.viewSession.split(/[\\/]/).pop();
  const s = (S.sessionsList || []).find((x) => x.path === S.viewSession || x.fileName === base);
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
  for (const item of list.querySelectorAll('.session-item.active')) {
    item.classList.toggle('live', S.isStreaming);
    const nameRow = item.querySelector('.s-name');
    if (!nameRow) continue;
    const dot = nameRow.querySelector('.live-dot');
    if (S.isStreaming && !dot) nameRow.prepend(el('span', 'live-dot', ''));
    else if (!S.isStreaming && dot) dot.remove();
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
  sendPrompt(next.text, next.images);
  // The next agent_end/agent_settled will flush the rest of the queue.
}

/* pi only auto-retries after an *overflow* compaction. After a *threshold*
 * (or manual) compaction it stops and waits for the next user message — even
 * when the task is clearly not done. Nudge it along automatically (once per
 * cooldown) so long tasks keep going. */
function maybeAutoContinue() {
  if (SET.autoContinueAfterCompaction === false) return;
  if (S.isStreaming || S.compacting) return;
  const now = Date.now();
  if (now - S.lastAutoContinueAt < 120000) return; // don't chain-continue forever
  S.lastAutoContinueAt = now;
  toast('Compaction done — continuing the task…', 'info');
  sendPrompt('Context was just compacted into a summary. Continue the current task from where it left off — use the compaction summary and the recent messages, and keep working until the task is complete.');
}

function renderQueue() {
  const bar = $('queue-bar');
  const items = [...S.queue.steering.map((m) => ({ kind: 'steering', m })), ...S.queue.followUp.map((m) => ({ kind: 'after turn', m }))];
  if (!items.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
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
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  syncComposerText();
}
input.addEventListener('input', () => { autoSize(); updateSlashMenu(); });

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

  if (text.startsWith('/')) {
    const sp = text.indexOf(' ');
    const name = (sp >= 0 ? text.slice(1, sp) : text.slice(1)).toLowerCase();
    const arg = sp >= 0 ? text.slice(sp + 1).trim() : '';

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
    const handled = await handleBuiltinCommand(name, arg);
    if (handled) { resetComposer(); return; }

    // Only warn for commands not in any known list (local, agent, or pi built-in).
    const known = allCommands().find((c) => c.name.toLowerCase() === name || c.name.toLowerCase() === `skill:${name}`);
    if (!known) {
      toast(`"/${name}" is not a registered agent or UI command — sending to the model as text`, 'warning');
    }
  }

  sendPrompt(text, S.attachments.slice());
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
      if ($('ctx-label')) $('ctx-label').textContent = 'compacting…';
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
      try { await rpc({ type: 'set_session_name', name: arg }); await refreshSessions(); }
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
      try { await rpc({ type: 'clone' }); await refreshSessions(); }
      catch (e) { toast(`Clone failed: ${e.message}`, 'error'); }
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

function sendPrompt(text, images, behavior) {
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
  rpc(cmd).catch((e) => toast(e.message, 'error'));
  // Optimistic bubble; replaced by the authoritative history on the next agent_end.
  if (text || all.length) {
    const content = [];
    for (const a of imgs) content.push({ type: 'image', data: a.data, mimeType: a.mimeType });
    if (msg) content.push({ type: 'text', text: msg });
    renderUserMessage({ role: 'user', content: content.length ? content : msg, timestamp: Date.now() });
    S.stickToBottom = true;
    scrollBottom(true);
  }
}

async function sendBash(command) {
  const { root, bubble } = makeMsgShell('system', `system · ${timeStr()}`);
  root.querySelector('.who').remove();
  const out = el('div', null, `$ ${command}\n`);
  bubble.appendChild(out);
  chat.appendChild(root);
  scrollBottom(true);
  try {
    const cmd = { type: 'bash', command };
    S.bashCards.set(cmd.id, { body: out });
    const d = await rpc(cmd);
    S.bashCards.delete(cmd.id);
    out.textContent = `$ ${command}\n${(d && d.output) || '(no output)'}`;
    if (d && d.exitCode) toast(`Command exited with code ${d.exitCode}`, 'warning');
  } catch (e) {
    out.textContent += `\n[error] ${e.message}`;
  }
}

function resetComposer() {
  input.value = '';
  autoSize();
  clearAttachments();
  closeSlashMenu();
  updateEditBanner();
  syncComposerText();
  input.focus();
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
    await refreshMessages();
    await refreshForkable();
    sendPrompt(newText, S.attachments.slice());
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
  const dataUrl = await readAsDataUrl(file);
  S.attachments.push({
    type: 'image',
    data: dataUrl.split(',')[1],
    mimeType: file.type,
    name: file.name || 'pasted-image',
  });
  renderAttachments();
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
  const data = await readAsDataUrl(file);
  const d = await (await fetch('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, data: data.split(',')[1], mimeType: file.type }),
  })).json();
  if (!d.ok) throw new Error(d.error || 'upload failed');
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
  try {
    const d = await (await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: b64 }),
    })).json();
    if (d.ok && d.text) return d.text;
  } catch { /* no local STT server */ }
  if (SET.sttEndpoint) {
    const fd = new FormData();
    fd.append('file', wavBlob, wavBlob.name || 'speech.wav');
    if (/\/v1\/audio\/transcriptions\/?$/.test(SET.sttEndpoint)) {
      fd.append('model', 'whisper-1');
      fd.append('response_format', 'json');
    }
    const res = await fetch(SET.sttEndpoint, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`STT server ${res.status}`);
    const d = await res.json();
    return d.text || d.transcription || '';
  }
  throw new Error('no STT endpoint available');
}

/* Attach any file: images go to the model as vision input; everything else
 * (PDF / audio / video / other) is uploaded to the workspace and referenced
 * by path in the prompt. Audio is transcribed when STT is available. */
async function addFile(file) {
  if (file.type.startsWith('image/')) { await addImageFile(file); return; }
  if (file.size > 100 * 1024 * 1024) { toast(`File too large (max 100 MB): ${file.name}`, 'error'); return; }
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
  }
  S.attachments.push(att);
  renderAttachments();
}

function renderAttachments() {
  const wrap = $('attachments');
  wrap.innerHTML = '';
  wrap.classList.toggle('hidden', !S.attachments.length);
  syncComposerText();
  S.attachments.forEach((a, i) => {
    const box = el('div', `attachment${a.type === 'file' ? ' file' : ''}`);
    if (a.type === 'image') {
      const img = el('img');
      img.src = `data:${a.mimeType};base64,${a.data}`;
      img.title = a.name;
      box.appendChild(img);
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
            : `${(a.size / 1024).toFixed(0)} KB`;
      meta.appendChild(el('div', 'file-status', status));
      box.append(icon, meta);
    }
    const rm = el('button', 'rm', '×');
    rm.onclick = () => { S.attachments.splice(i, 1); renderAttachments(); };
    box.appendChild(rm);
    wrap.appendChild(box);
  });
}

function clearAttachments() {
  S.attachments = [];
  renderAttachments();
  syncComposerText();
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
document.addEventListener('dragenter', (e) => {
  if ([...(e.dataTransfer?.types || [])].includes('Files')) {
    dragDepth++;
    $('drop-overlay').classList.remove('hidden');
  }
});
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').classList.add('hidden'); }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop-overlay').classList.add('hidden');
  for (const f of e.dataTransfer?.files || []) await addFile(f);
});

/* ───────────────────────── slash commands ───────────────────────── */

/* handled by the UI itself, never sent to the agent */
const LOCAL_COMMANDS = [
  { name: 'tts', description: 'Toggle text-to-speech for agent replies', source: 'local' },
  { name: 'autosend', description: 'Toggle auto-send after voice input', source: 'local' },
  { name: 'thinking', description: 'Toggle showing thinking blocks', source: 'local' },
];

function allCommands() {
  const seen = new Set();
  const out = [];
  // Local UI commands take precedence, then agent (extension/prompt/skill)
  // commands, then pi's built-in slash commands. Deduped by name so e.g. the
  // local /thinking toggle isn't shadowed twice.
  for (const c of [...LOCAL_COMMANDS, ...S.commands, ...S.builtinCommands]) {
    const key = c.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
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
    .filter((c) => c.name.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q))
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
    row.appendChild(el('span', 'cmd', '/' + c.name));
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
  input.value = '/' + c.name + ' ';
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
  if (e.key === 'Escape' && !slash.open && !$('ext-dialog').open) {
    if (S.speaking) { speechSynthesis.cancel(); S.speaking = false; $('btn-tts').classList.remove('on'); }
    else if (S.isStreaming) stopAgent();
  }
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
  ctx.close();
  const wav = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(wav);
  const wstr = (o, t) => { for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
  wstr(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wstr(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(wav, 44).set(pcm);
  return new Blob([wav], { type: 'audio/wav' });
}

async function transcribeWithWhisper(blob) {
  const wav = await blobToWav(blob);
  const isOpenAI = /\/v1\/audio\/transcriptions\/?$/.test(SET.sttEndpoint);
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
  const res = await fetch(SET.sttEndpoint, { method: 'POST', body: fd });
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
    void blob;
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

async function ensureSttEndpoint() {
  if (SET.sttEndpoint) return;
  try {
    const cfg = await fetch('/api/config').then((r) => r.json());
    if (cfg.whisperUrl) {
      SET.sttEndpoint = cfg.whisperUrl;
      saveSettings();
      toast('Using local whisper server for voice input');
    }
  } catch { /* no endpoint */ }
}

$('btn-mic').onclick = async () => {
  if (whisperBusy) return;
  const useWhisper = (SET.sttBackend || 'whisper') !== 'browser';
  if (useWhisper && !SET.sttEndpoint) await ensureSttEndpoint();
  if (useWhisper && SET.sttEndpoint) {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      return;
    }
    startWhisperRecording().catch((e) => {
      $('btn-mic').classList.remove('recording');
      toast(`Microphone error: ${e.message}`, 'error');
    });
    return;
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
async function speakEndpoint(text) {
  const chunks = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  let batch = '', buffers = [];
  const flush = async () => {
    if (!batch.trim()) return;
    const res = await fetch(SET.ttsEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: SET.ttsModel || 'piper', input: batch.trim(), voice: SET.ttsVoiceName || undefined, response_format: 'wav' }),
    });
    if (!res.ok) throw new Error(`TTS server ${res.status}`);
    buffers.push(await res.blob());
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

async function refreshSessions() {
  try {
    const res = await fetch('/api/sessions');
    const d = await res.json();
    renderSessions(d.sessions || []);
  } catch { /* ignore */ }
}

function renderSessions(sessions) {
  const list = $('session-list');
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
  const shown = sessions.filter((s) => !filter || s.name.toLowerCase().includes(filter) || s.fileName.toLowerCase().includes(filter));
  if (!shown.length) list.appendChild(el('div', 'session-item s-meta', 'No sessions found'));
  for (const s of shown) {
    const item = el('div', 'session-item');
    const isCurrent = current && (s.path === current || s.fileName === current.split(/[\\/]/).pop());
    const isViewed = S.viewSession
      ? (s.path === S.viewSession || s.fileName === S.viewSession.split(/[\\/]/).pop())
      : false;
    if (isCurrent || isViewed) item.classList.add('active');
    if (isCurrent && S.isStreaming) item.classList.add('live');
    const nameRow = el('div', 's-name');
    if (isCurrent && S.isStreaming) nameRow.appendChild(el('span', 'live-dot', ''));
    nameRow.appendChild(document.createTextNode(s.name));
    item.appendChild(nameRow);
    item.appendChild(el('div', 's-meta', `${new Date(s.mtime).toLocaleString()} · ${(s.size / 1024).toFixed(1)} KB`));
    item.onclick = () => switchToSession(s.path);
    list.appendChild(item);
  }
}

$('session-filter').oninput = () => refreshSessions();
$('btn-refresh-sessions').onclick = () => refreshSessions();

async function switchToSession(sessionPath) {
  const agentSession = S.state.sessionFile;
  if (sessionPath === agentSession) {
    if (!S.viewSession) return; // already here
    // Coming back to the agent's own session: re-render it and re-attach the
    // live view (if the agent is still running).
    S.viewSession = null;
    await refreshMessages();
    updateViewBanner();
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
    S.viewSession = sessionPath;
    await renderSessionFromDisk(sessionPath);
    updateViewBanner();
    return;
  }
  // Agent is idle: move it to the selected session so input works there.
  try {
    await rpc({ type: 'switch_session', sessionPath });
    S.state.sessionFile = sessionPath;
    S.viewSession = null;
    $('session-name').value = '';
    await initSession(false);
    toast('Session switched');
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
        const r = await fetch('/api/ensure-dir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: dir }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'could not create it');
        await rpc({ type: 'switch_session', sessionPath });
        S.state.sessionFile = sessionPath;
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
async function renderSessionFromDisk(sessionPath) {
  try {
    const d = await fetchSession(sessionPath);
    const msgs = d.messages;
    const distFromBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight;
    chat.innerHTML = '';
    for (const m of msgs) {
      if (m.role === 'user') renderUserMessage(m);
      else if (m.role === 'assistant') renderAssistantMessage(m);
      else if (m.role === 'toolResult') renderToolResult(m);
      else if (m.role === 'bashExecution') renderBashExecution(m);
      else if (m.role === 'compactionSummary') renderCompactionSummary(m);
    }
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
    else chat.scrollTop = chat.scrollHeight - chat.clientHeight - distFromBottom;
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
    refreshSessions().catch(() => {});
    setTimeout(() => refreshSessions().catch(() => {}), 700);
    toast('New session started');
  } catch (e) { toast(e.message, 'error'); }
};

$('session-name').addEventListener('change', async (e) => {
  const name = e.target.value.trim();
  if (!name) return;
  try {
    await rpc({ type: 'set_session_name', name });
    await refreshSessions();
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
  const isLlama = provider.startsWith('llama-server=');
  // If pi has not registered this llama provider yet (its configured URL is
  // dead), point pi at the live server, restart the agent, then retry.
  if (isLlama && !S.models.some((m) => m.provider === provider)) {
    const live = llamaLiveServers.find((s) => s.providerId === provider);
    if (live && confirm(`pi has not registered the llama.cpp server at ${live.url} yet.\n\nPoint pi at it and restart the agent? (updates llamaServerUrl in your pi config)`)) {
      S.pendingModel = { provider, modelId };
      fixLlamaConfig(live.url);
    }
    return;
  }
  try {
    await rpc({ type: 'set_model', provider, modelId });
    await rpc({ type: 'get_state' }).then(applyState);
    toast(isLlama ? 'Model switched — loading into llama.cpp…' : 'Model switched');
  } catch (err) {
    toast(err.message + (isLlama
      ? ' — pi does not know this model yet. If the llama.cpp banner is showing, use "Point pi here & reload", or type /models in the chat'
      : ''), 'error');
  }
};

$('thinking-select').onchange = async (e) => {
  try {
    await rpc({ type: 'set_thinking_level', level: e.target.value });
    toast(`Thinking level: ${e.target.value}`);
  } catch (err) { toast(err.message, 'error'); }
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
      bar.classList.remove('hidden');
      bar.dataset[req.statusKey] = stripAnsi(req.statusText);
      bar.textContent = Object.values(bar.dataset).join(' · ');
      break;
    }
    case 'setWidget': {
      const bar = $('widget-bar');
      const lines = (req.widgetLines || []).map(stripAnsi).filter((l) => l && l.trim());
      if (lines.length) bar.dataset[req.widgetKey] = lines.join('\n');
      else delete bar.dataset[req.widgetKey];
      const content = Object.values(bar.dataset).join('\n');
      bar.textContent = content;
      bar.classList.toggle('hidden', !content.trim());
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

function toast(text, kind = 'info') {
  const t = el('div', `toast ${kind}`, text);
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

function showBanner(kind, text, btnLabel, fn) {
  const b = $('banner');
  b.className = `banner ${kind}`;
  b.innerHTML = '';
  b.appendChild(el('span', null, text));
  if (btnLabel) {
    const btn = el('button', 'btn small', btnLabel);
    btn.onclick = () => { hideBanner(); fn(); };
    b.appendChild(btn);
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

/* periodically poll sessions list while idle */
setInterval(() => { if (!S.isStreaming) refreshSessions(); }, 20000);

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
  $('set-agent-name').value = SET.agentName === 'pi' ? '' : SET.agentName;
  $('set-agent-name').placeholder = SET.agentName || 'pi';
  const prev = $('set-avatar-preview');
  if (SET.avatar) { prev.src = SET.avatar; prev.style.visibility = 'visible'; }
  else prev.style.visibility = 'hidden';
  $('set-voice-autosend').checked = !!SET.voiceAutoSend;
  $('set-show-thinking').checked = SET.showThinking !== false;
  $('set-expand-thinking').checked = !!SET.autoExpandThinking;
  $('set-expand-tools').checked = !!SET.autoExpandTools;
  $('set-stt-endpoint').value = SET.sttEndpoint || '';
  $('set-stt-backend').value = SET.sttBackend || 'whisper';
  $('set-tts-backend').value = SET.ttsBackend || 'browser';
  $('set-tts-endpoint').value = SET.ttsEndpoint || '';
  $('set-tts-model').value = SET.ttsModel || '';
  $('set-tts-voice-name').value = SET.ttsVoiceName || '';
  $('set-accent').value = SET.themeAccent || '#5b9dff';
  $('set-bg-url').value = SET.themeBg && !SET.themeBg.startsWith('data:') && !SET.themeBg.startsWith('/api/bg-file') ? SET.themeBg : '';
  $('set-tts-rate').value = SET.ttsRate;
  $('set-tts-rate-val').textContent = Number(SET.ttsRate).toFixed(2);
  $('set-font').value = SET.fontFamily || '';
  // System font list for the searchable font picker (loaded async).
  loadSystemFonts();
  $('set-font-size').value = Number(SET.chatFontSize) || 14;
  $('set-font-size-val').textContent = `${Number(SET.chatFontSize) || 14}px`;
  $('set-chat-opacity').value = SET.chatOpacity == null ? 100 : Number(SET.chatOpacity);
  $('set-chat-opacity-val').textContent = `${SET.chatOpacity == null ? 100 : Number(SET.chatOpacity)}%`;
  const tOut = $('set-text-outline');
  if (tOut) tOut.checked = SET.textOutline !== false;
  const tCol = $('set-outline-color');
  if (tCol) tCol.value = SET.textOutlineColor || '#000000';
  const avSize = $('set-avatar-size');
  if (avSize) {
    avSize.value = String(Number(SET.avatarSize) || 34);
    $('set-avatar-size-val').textContent = `${Number(SET.avatarSize) || 34}px`;
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
$('avatar-input').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
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
$('set-stt-backend').onchange = (e) => {
  SET.sttBackend = e.target.value;
  saveSettings();
  toast(SET.sttBackend === 'whisper'
    ? 'Voice input: Whisper server' + (SET.sttEndpoint ? ` (${SET.sttEndpoint})` : ' (auto local server)')
    : 'Voice input: browser speech recognition (Chrome/Edge only)');
};
$('set-tts-backend').onchange = (e) => { SET.ttsBackend = e.target.value; saveSettings(); };
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
function applyBackgroundMedia() {
  const host = $('bg-media');
  const src = SET.themeBg || '';
  if (!host) return;
  host.innerHTML = '';
  if (!src) { host.classList.add('hidden'); return; }
  const frame = window.innerWidth / Math.max(1, window.innerHeight);
  const node = attachCrop(mediaNode(src, 'bg-node'), SET.bgCrop, frame);
  node.onerror = () => toast(isVideoSrc(src) ? 'Background video failed to load' : 'Background image failed to load', 'error');
  host.appendChild(node);
  host.classList.remove('hidden');
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
 * Layout is always "cover, centred"; the crop rides on top of it as
 *   transform: translate(fx · range) scale(z)
 * Panning used to go through object-position, which can only move the part of a
 * cover-fitted image that already sticks out - so an image that exactly filled
 * the frame on one axis could never be moved along that axis, however far you
 * zoomed. Moving by transform instead means zooming always opens up movement on
 * both axes.
 *
 *   cw = max(1, imageAspect / frameAspect)   content width  ÷ frame width
 *   ch = max(1, frameAspect / imageAspect)   content height ÷ frame height
 *   range_x = z·cw − 1                       travel, in frame widths (×100%)
 * fx/fy are −1..1 fractions of that range, 0 = centred. */
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
  if (!c) { node.style.objectPosition = ''; node.style.transform = ''; return; }
  const { cw, ch } = cropRatios(node, frameAspect);
  const z = Math.max(1, Number(c.z) || 1);
  const tx = (Number(c.fx) || 0) * 50 * (z * cw - 1);
  const ty = (Number(c.fy) || 0) * 50 * (z * ch - 1);
  node.style.objectPosition = '50% 50%';
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

function paintCrop() {
  if (!cropState) return;
  const { node, fx, fy, z, frame } = cropState;
  applyCrop(node, { v: 2, fx, fy, z }, frame);
  const zoom = $('crop-zoom');
  if (zoom) { zoom.value = String(z); $('crop-zoom-val').textContent = `${z.toFixed(2)}×`; }
  const cx = $('crop-x'); if (cx) cx.value = String(fx);
  const cy = $('crop-y'); if (cy) cy.value = String(fy);
}

/* Move the picture by a drag, in pixels, on the (possibly zoomed) stage. */
function cropDrag(dx, dy) {
  if (!cropState) return;
  const stage = $('crop-stage');
  if (!stage) return;
  const { node, z, frame } = cropState;
  const { cw, ch, ready } = cropRatios(node, frame);
  if (!ready) return;   // not loaded yet
  const sr = stage.getBoundingClientRect();
  // Screen pixels available each way: the content is z·cw wide against a frame
  // one wide, so half of the excess in each direction.
  const halfX = ((z * cw - 1) * sr.width) / 2;
  const halfY = ((z * ch - 1) * sr.height) / 2;
  const clamp = (v) => Math.max(-1, Math.min(1, v));
  if (halfX > 0.5) cropState.fx = clamp(cropState.fx - dx / halfX);
  if (halfY > 0.5) cropState.fy = clamp(cropState.fy - dy / halfY);
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
  $('crop-title').textContent = isAvatar ? 'Crop profile image' : 'Crop background';
  $('crop-hint').textContent = isAvatar
    ? 'Drag the picture inside the circle, scroll or use the slider to zoom. Zooming in is what lets you slide it sideways. What you see here is what the chat shows.'
    : 'Drag the picture, scroll or use the slider to zoom. Zooming in is what lets you slide it sideways. The frame is your window shape.';
  stage.classList.toggle('circle', isAvatar);
  const frame = isAvatar ? 1 : window.innerWidth / Math.max(1, window.innerHeight);
  stage.style.aspectRatio = isAvatar
    ? '1 / 1'
    : `${Math.max(1, window.innerWidth)} / ${Math.max(1, window.innerHeight)}`;
  cropState = {
    kind,
    node,
    frame,
    fx: saved.fx == null ? 0 : Number(saved.fx),
    fy: saved.fy == null ? 0 : Number(saved.fy),
    z: saved.z == null ? 1 : Math.max(1, Number(saved.z)),
  };
  paintCrop();
  const dlg = $('crop-dialog');
  if (!dlg.open) dlg.showModal();
}

function closeCropper() {
  cropState = null;
  const dlg = $('crop-dialog');
  if (dlg && dlg.open) dlg.close();
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
async function loadSystemFonts() {
  const list = $('font-list');
  if (!list) return;
  if (systemFontsLoaded) return;
  try {
    const d = await (await fetch('/api/system-fonts')).json();
    const fonts = d.fonts || [];
    list.innerHTML = '';
    for (const f of fonts) list.appendChild(el('option', null, f));
    systemFontsLoaded = true;
  } catch { /* bridge may be old — picker still works with presets */ }
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

/* chatbox transparency: applies live while dragging, persists on release */
$('set-chat-opacity').value = SET.chatOpacity == null ? 100 : Number(SET.chatOpacity);
$('set-chat-opacity-val').textContent = `${SET.chatOpacity == null ? 100 : Number(SET.chatOpacity)}%`;
$('set-chat-opacity').oninput = (e) => {
  SET.chatOpacity = parseInt(e.target.value, 10);
  $('set-chat-opacity-val').textContent = `${SET.chatOpacity}%`;
  applySettings();
};
$('set-chat-opacity').onchange = () => saveSettings();

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

/* first-launch setup */
function maybeShowSetup() {
  if (SET.onboarded) return;
  $('setup-agent-name').value = SET.agentName === 'pi' ? '' : SET.agentName;
  $('setup-shorts-provider').value = SHORTS_FEEDS[SET.shortsProvider] ? SET.shortsProvider : 'instagram';
  $('setup-accent').value = SET.themeAccent || '#5b9dff';
  $('setup-dialog').showModal();
}
$('setup-skip').onclick = () => {
  SET.onboarded = true;
  saveSettings();
  $('setup-dialog').close();
};
$('setup-accent-reset').onclick = () => { $('setup-accent').value = '#5b9dff'; };
$('setup-done').onclick = () => {
  const name = $('setup-agent-name').value.trim();
  if (name) SET.agentName = name;
  const prov = $('setup-shorts-provider').value;
  if (SHORTS_FEEDS[prov] || prov === 'none') SET.shortsProvider = prov;
  const acc = $('setup-accent').value;
  SET.themeAccent = acc && acc !== '#5b9dff' ? acc : null;
  SET.onboarded = true;
  saveSettings();
  $('setup-dialog').close();
  toast(`Welcome, ${SET.agentName || 'pi'}!`);
};

/* ───────────────────────── pi providers (models.json) ───────────────────────── */

async function loadPiProviders() {
  const list = $('pi-providers-list');
  list.innerHTML = '';
  list.appendChild(el('div', 'prov-empty', 'loading…'));
  try {
    const d = await fetch('/api/pi-providers').then((r) => r.json());
    list.innerHTML = '';
    const provs = Object.entries(d.providers || {});
    if (!provs.length) {
      list.appendChild(el('div', 'prov-empty', 'no custom providers yet'));
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
          const r = await fetch(`/api/pi-providers?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
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
    list.appendChild(el('div', 'prov-empty', 'bridge offline'));
  }
}

$('btn-prov-discover').onclick = async () => {
  const url = $('prov-base-url').value.trim().replace(/\/+$/, '');
  if (!url) { toast('Enter the base URL first', 'warning'); return; }
  const btn = $('btn-prov-discover');
  btn.disabled = true;
  try {
    const r = await fetch('/api/probe-models', {
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
    const r = await fetch('/api/probe-provider', {
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
    const r = await fetch('/api/pi-providers', {
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
    const d = await fetch('/api/auth-providers').then((r) => r.json());
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
    const r = await fetch(`/api/auth-login?provider=${encodeURIComponent(id)}`, { method: 'DELETE' });
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
    const r = await fetch('/api/auth-login', {
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
  // Windows app: back the panel with a real Chromium surface instead of the
  // placeholder. No-op in a plain browser.
  openNativeFeed(reelsFeed);
}

function hideReels() {
  autoShortsOpened = false;   // the user (or the auto-hook) took it down
  $('reels-panel').classList.add('hidden');
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
    syncNativeFeed();
  };
  reelsResize.addEventListener('pointerup', stop);
  window.addEventListener('pointerup', stop);
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

/* ───────────────────────── boot ───────────────────────── */

wireTypeAnywhere();
applySettings();
populateTtsVoiceSelect();
loadServerSettings().then(() => maybeShowSetup());
connect();
