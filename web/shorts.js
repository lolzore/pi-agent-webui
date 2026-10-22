/*
 * The Shorts / Reels feed and its auto-open behaviour.
 *
 * Split out of app.js (issue #54). Loaded before app.js; the names stay
 * global, so nothing else changed. Behaviour is unchanged.
 */
'use strict';

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

/* Browser mode (issue #123): the pane is a small browser - a URL bar, history,
 * reload and an iframe - instead of a feed. Sites that refuse to be embedded
 * are one ↗ away from a tab. */
const reelsHistory = { stack: [], at: -1 };

/* The last URL the pane visited, kept in the settings so reopening it comes
 * back to the page (issue #135). */
function rememberBrowserUrl(url) {
  SET.browserUrl = url;
  saveSettings();
}

/* What the browser tab should load for what was typed. A URL keeps its scheme
 * (or gets https:// when it looks like a host); anything else is a search, with
 * Google as the default engine. */
function browserTarget(rawInput) {
  const raw = String(rawInput || '').trim();
  if (!raw) return 'about:blank';
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
  const hostLike = !/\s/.test(raw) && (
    /^[^./]+(\.[^./]+)+([/:?#].*)?$/i.test(raw) ||
    /^localhost(:\d+)?([/?#].*)?$/i.test(raw) ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#].*)?$/.test(raw) ||
    /^\[[0-9a-f:]+\](:\d+)?([/?#].*)?$/i.test(raw)
  );
  return hostLike ? `https://${raw}` : `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
}

function reelsNavigate(url, fromHistory) {
  const raw = String(url || '').trim();
  const target = browserTarget(raw);
  const frame = $('reels-frame');
  if (!frame) return;
  /* A native shell has a real browsing context, so the URL goes to it - an
   * iframe cannot show the sites that refuse to be embedded (issue #135). */
  const host = webView2Host();
  if (host) {
    closeNativeFeed();
    const r = panelRect();
    host.postMessage(`piagent|browser|open|${r.x}|${r.y}|${r.w}|${r.h}|${target}`);
    nativeBrowserOpen = true;
    rememberBrowserUrl(target);
    $('reels-url').value = raw;
    return;
  }
  const rn = nativeBridge();
  if (rn) {
    try { rn.postMessage(JSON.stringify({ type: 'openBrowser', url: target })); } catch { /* older shell */ }
    rememberBrowserUrl(target);
    $('reels-url').value = raw;
    return;
  }
  frame.setAttribute('src', target);
  $('reels-url').value = raw;
  rememberBrowserUrl(target);
  if (!fromHistory) {
    reelsHistory.stack = reelsHistory.stack.slice(0, reelsHistory.at + 1);
    reelsHistory.stack.push(target);
    reelsHistory.at = reelsHistory.stack.length - 1;
  }
  $('reels-back').disabled = reelsHistory.at <= 0;
  $('reels-forward').disabled = reelsHistory.at >= reelsHistory.stack.length - 1;
}

function reelsHistoryGo(delta) {
  const at = reelsHistory.at + delta;
  if (at < 0 || at >= reelsHistory.stack.length) return;
  reelsHistory.at = at;
  reelsNavigate(reelsHistory.stack[at], true);
}

function setReelsFeed(feed) {
  reelsFeed = feed;
  for (const b of $('reels-tabs').querySelectorAll('.rtab'))
    b.classList.toggle('active', b.dataset.feed === feed);
  const browser = feed === 'browser';
  $('reels-browser').classList.toggle('hidden', !browser);
  $('reels-video').classList.toggle('hidden', browser);
  if (browser) {
    closeNativeFeed();
    // The browser tab is a real top-level surface too. Re-navigate on every
    // switch so the surface is shown again if it was closed, and use the URL
    // bar's current value without adding a duplicate history entry.
    if (webView2Host()) reelsNavigate($('reels-url').value || SET.browserUrl || 'about:blank', true);
    else if (!$('reels-frame').getAttribute('src')) reelsNavigate($('reels-url').value || SET.browserUrl || 'about:blank');
    return;
  }
  closeNativeBrowser();
  // In the app the panel is backed by a real browser surface. If there is no
  // native host (an old shell, or a plain browser that should not have this
  // panel at all), there is nothing to embed: these sites refuse iframes.
  if (webView2Host()) { openNativeFeed(feed); return; }
  const v = $('reels-video');
  v.innerHTML = '';
  const ph = el('div', 'reels-placeholder');
  ph.innerHTML = `<p>The ${SHORTS_FEEDS[feed].label} feed opens in the app window.</p>`;
  v.appendChild(ph);
}

/* Browser 'panel' mode: the same toggle the Reels button uses, kept as a named
 * entry point because the reels pill and the settings menu call it too. */
function toggleReelsPanel() {
  const panel = $('reels-panel');
  if (panel.classList.contains('hidden')) {
    const wanted = SET.shortsProvider || 'instagram';
    setReelsFeed(wanted === 'browser' ? 'browser' : (SHORTS_FEEDS[wanted] ? wanted : 'instagram'));
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
  // Electron exposes the same one-way channel the WebView2 shell uses; see
  // pi-electron/webui-preload.cjs.
  if (window.piDesktop && typeof window.piDesktop.postMessage === 'function') return window.piDesktop;
  const c = window.chrome;
  return c && c.webview && typeof c.webview.postMessage === 'function' ? c.webview : null;
}

let nativeFeedOpen = false;
let nativeBrowserOpen = false;

/* The rectangle the native surface should cover: the feed area, or the
 * browser's page area - not the panel header or the URL bar, which stay
 * visible and usable above it. */
function panelRect() {
  const browser = !$('reels-browser').classList.contains('hidden');
  const target = browser ? $('reels-frame') : $('reels-video');
  const r = (target || $('reels-panel')).getBoundingClientRect();
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
  closeNativeBrowser();
  const r = panelRect();
  if (r.w < 40 || r.h < 40) return false;
  host.postMessage(`piagent|shorts|open|${r.x}|${r.y}|${r.w}|${r.h}|${f.url}`);
  nativeFeedOpen = true;
  $('reels-video').classList.add('native-feed');
  return true;
}

function syncNativeEmbed() {
  const host = webView2Host();
  if (!host) return;
  if ($('reels-panel').classList.contains('hidden')) { closeNativeFeed(); closeNativeBrowser(); return; }
  const r = panelRect();
  if (r.w < 40 || r.h < 40) return;
  if (nativeFeedOpen) host.postMessage(`piagent|shorts|rect|${r.x}|${r.y}|${r.w}|${r.h}`);
  else if (nativeBrowserOpen) host.postMessage(`piagent|browser|rect|${r.x}|${r.y}|${r.w}|${r.h}`);
}

// Kept as the name the older call sites use.
function syncNativeFeed() { syncNativeEmbed(); }

function closeNativeFeed() {
  nativeFeedOpen = false;
  const host = webView2Host();
  if (host) host.postMessage('piagent|shorts|close');
  const v = $('reels-video');
  if (v) v.classList.remove('native-feed');
}

function closeNativeBrowser() {
  nativeBrowserOpen = false;
  const host = webView2Host();
  if (host) host.postMessage('piagent|browser|close');
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
  if ((provider || '') === 'browser') { SET.reelsOpen = true; saveSettings(); return; }
  // Remember it: a reload (or a native shell that rebuilds its surface) brings
  // the panel back instead of silently closing it.
  SET.reelsOpen = true;
  saveSettings();
  // setReelsFeed() already opened the native surface when there is a host.
}

function hideReels() {
  autoShortsOpened = false;   // the user (or the auto-hook) took it down
  $('reels-panel').classList.add('hidden');
  SET.reelsOpen = false;
  saveSettings();
  closeNativeFeed();
  closeNativeBrowser();
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

/* The shorts feature is the desktop app's: a browser cannot play the real feeds
 * (they refuse with X-Frame-Options), and the pane the app opens is a native
 * one. So the Reels button - and the panel behind it - only exist there, the
 * same rule the settings tab follows (issue #158's follow-up). */
function shortsAreDesktopOnly() {
  return /Electron/i.test(navigator.userAgent);
}

function openShorts() {
  if (!shortsAreDesktopOnly()) return;
  const provider = SET.shortsProvider || 'instagram';
  // Native (React Native) mode: open the app's native shorts sheet.
  const bridge = nativeBridge();
  if (bridge) {
    bridge.postMessage(JSON.stringify({ type: 'openShorts', provider }));
    return;
  }
  // WebView2 app: dock the feed inside the window, next to the chat.
  if (webView2Host()) { toggleReels(); return; }
  // The browser pane only exists inside the split pane (issue #123).
  if (provider === 'browser') { toggleReelsPanel(); return; }
  const mode = SET.shortsMode || 'panel';
  if (mode === 'tab') { reelsWin = window.open((SHORTS_FEEDS[provider] || SHORTS_FEEDS.instagram).url, '_blank'); return; }
  if (mode === 'window') { openReelsWindow(provider); return; }
  toggleReelsPanel();
}

$('reels-go').onclick = () => reelsNavigate($('reels-url').value);
$('reels-url').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); reelsNavigate($('reels-url').value); } };
$('reels-back').onclick = () => reelsHistoryGo(-1);
$('reels-forward').onclick = () => reelsHistoryGo(1);
$('reels-reload').onclick = () => { const f = $('reels-frame'); if (f) f.src = f.src || 'about:blank'; };

$('btn-reels').onclick = openShorts;
$('btn-reels-close').addEventListener('click', hideReels);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('reels-panel').classList.contains('hidden')) hideReels();
});
for (const b of $('reels-tabs').querySelectorAll('.rtab'))
  b.addEventListener('click', () => setReelsFeed(b.dataset.feed));

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
    syncNativeEmbed();
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
    syncNativeEmbed();
  };
  reelsResize.addEventListener('pointerup', stop);
  window.addEventListener('pointerup', stop);
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
  const ro = new ResizeObserver(() => syncNativeEmbed());
  ro.observe($('reels-panel'));
}
window.addEventListener('resize', () => syncNativeEmbed());

// The docked feed is a window this page does not own, so a reload would leave it
// behind. Clear any orphan on startup, and try to close ours on the way out.
if (webView2Host()) {
  webView2Host().postMessage('piagent|shorts|close');
  webView2Host().postMessage('piagent|browser|close');
  window.addEventListener('beforeunload', () => {
    try {
      webView2Host().postMessage('piagent|shorts|close');
      webView2Host().postMessage('piagent|browser|close');
    } catch { /* going away */ }
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
