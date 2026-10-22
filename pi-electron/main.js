/* Pi Agent desktop: the WebUI in a native window, with the real shorts feeds.
 *
 * The feeds are loaded in their own WebContentsView - a top-level browsing
 * context, exactly like a browser tab - so X-Frame-Options does not apply and
 * the genuine infinite feeds play next to the chat. That is the one thing a
 * browser page cannot do, and the reason this app exists.
 */
import { app, BrowserWindow, WebContentsView, session, shell, ipcMain, Menu, nativeImage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEEDS, FEED_ORDER, userAgentFor, FEED_CSS, FEED_JS_AFTER } from './feeds.js';
import { loadSettings, saveSettings } from './settings.js';
import { ensureBridge } from './bridge-manager.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST = process.argv.includes('--test');
/* The smoke test keeps its settings in a scratch directory. */
if (process.env.PI_ELECTRON_USER_DATA) app.setPath('userData', process.env.PI_ELECTRON_USER_DATA);
const TOOLBAR_H = 38;

/* Which hosts stay inside the pane; anything else opens in the system browser,
 * so a link tap in a reel never traps the reader (same rule as the native app). */
const SITE_HOSTS = {
  instagram: ['instagram.com', 'cdninstagram.com', 'facebook.com'],
  tiktok: ['tiktok.com', 'tiktokcdn.com', 'byteoversea.com', 'ibytedtos.com'],
  youtube: ['youtube.com', 'youtu.be', 'googlevideo.com', 'google.com', 'ytimg.com', 'gstatic.com'],
};

const sameSite = (url, key) => {
  try {
    const host = new URL(url).hostname;
    return (SITE_HOSTS[key] || []).some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
};

let win = null;
let toolbar = null;
let bridge = null;
let paneOpen = false;
let activeFeed = 'instagram';
const views = new Map();   // feed key -> WebContentsView (kept, so switching is instant)
/* The WebUI's own split pane asks for a real surface through the preload shim
 * (the same piagent|... messages the WebView2 shell uses). These are separate
 * from the top-level Shorts pane above: one covers #reels-video, the other
 * covers the Browser tab's #reels-frame. */
const embedViews = { feed: null, browser: null };
let lastIconAvatar = null;
let lastIconApplied = false;
let iconTimer = null;
let iconSyncing = false;

const feedUrl = (key) => (TEST && process.env.PI_ELECTRON_TEST_URL) || FEEDS[key].url;

function ensureFeedView(key) {
  const existing = views.get(key);
  if (existing) return existing;
  const view = new WebContentsView({
    webPreferences: {
      partition: `persist:shorts-${key}`,   // each feed keeps its own cookies/login
      preload: path.join(HERE, 'shorts-preload.cjs'),
      contextIsolation: false,   // the autoplay patch must run in the page's world
      nodeIntegration: false,
      sandbox: true,
    },
  });
  view.webContents.session.setUserAgent(userAgentFor(FEEDS[key]));
  view.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  view.webContents.on('will-navigate', (e, url) => {
    if (!sameSite(url, key)) {
      e.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });
  view.webContents.on('dom-ready', () => {
    view.webContents.insertCSS(FEED_CSS).catch(() => {});
  });
  view.webContents.on('did-finish-load', () => {
    view.webContents.executeJavaScript(FEED_JS_AFTER).catch(() => {});
  });
  registerContextMenu(view.webContents);
  view.webContents.loadURL(feedUrl(key));
  views.set(key, view);
  return view;
}

/* ── in-page Shorts / Browser surface ─────────────────────────────────────
 *
 * The WebUI's split pane was written for the React Native WebView2 shell: it
 * sends `piagent|shorts|open|x|y|w|h|url` (and `browser|open|...`) to a host
 * that owns a real browsing surface. Electron had no such host, so the pane
 * fell back to an iframe, Instagram/TikTok refused it, and the user saw the
 * "Paste a Reels link" placeholder. The preload below exposes the same
 * postMessage method, and these views are the host side. */
function ensureEmbedView(kind) {
  const existing = embedViews[kind];
  if (existing) return existing;
  const feed = kind === 'feed';
  const view = new WebContentsView({
    webPreferences: {
      partition: feed ? 'persist:pi-feed-embed' : 'persist:pi-browser-embed',
      preload: feed ? path.join(HERE, 'shorts-preload.cjs') : undefined,
      contextIsolation: !feed,   // the feed autoplay patch runs in the page's world
      nodeIntegration: false,
      sandbox: true,
    },
  });
  view.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  if (feed) {
    // Same treatment as the top-level feed view: hide the auto-hiding
    // scrollbars/overscroll, and scrub the cookie/app-install nags. Without the
    // after-load body overflow reset, YouTube Shorts stayed locked to the
    // viewport and ignored the wheel.
    view.webContents.on('dom-ready', () => {
      view.webContents.insertCSS(FEED_CSS).catch(() => {});
    });
    view.webContents.on('did-finish-load', () => {
      view.webContents.executeJavaScript(FEED_JS_AFTER).catch(() => {});
    });
  }
  view.setVisible(false);
  win.contentView.addChildView(view);
  registerContextMenu(view.webContents);
  embedViews[kind] = view;
  return view;
}

function embedBounds(rect) {
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.max(0, Math.round(x)) : 0;
  };
  return { x: n(rect.x), y: n(rect.y), width: Math.max(1, n(rect.w)), height: Math.max(1, n(rect.h)) };
}

function showEmbed(kind, url, rect) {
  if (!win) return;
  const view = ensureEmbedView(kind);
  const other = kind === 'feed' ? embedViews.browser : embedViews.feed;
  if (other) other.setVisible(false);
  if (kind === 'feed') {
    let key = 'instagram';
    try {
      const host = new URL(url).hostname;
      for (const k of FEED_ORDER) {
        const h = new URL(FEEDS[k].url).hostname;
        if (host === h || host.endsWith('.' + h)) { key = k; break; }
      }
    } catch { /* odd URL: keep the desktop identity */ }
    view.webContents.setUserAgent(userAgentFor(FEEDS[key]));
  } else {
    view.webContents.setUserAgent(userAgentFor({ ua: 'desktop' }));
  }
  if (url) view.webContents.loadURL(url).catch(() => {});
  view.setBounds(embedBounds(rect));
  view.setVisible(true);
  // Re-add brings it above the WebUI surface after the other view was hidden.
  win.contentView.addChildView(view);
}

function hideEmbed(kind) {
  const view = embedViews[kind];
  if (view) view.setVisible(false);
}

function handleEmbedMessage(raw) {
  const p = String(raw || '').split('|');
  if (p[0] !== 'piagent') return;
  const kind = p[1] === 'shorts' ? 'feed' : p[1] === 'browser' ? 'browser' : null;
  if (!kind) return;
  const action = p[2];
  if (action === 'open') {
    const rect = { x: p[3], y: p[4], w: p[5], h: p[6] };
    const url = p.slice(7).join('|');
    showEmbed(kind, url, rect);
  } else if (action === 'rect') {
    const view = embedViews[kind];
    if (view && view.getVisible()) view.setBounds(embedBounds({ x: p[3], y: p[4], w: p[5], h: p[6] }));
  } else if (action === 'close') {
    hideEmbed(kind);
  }
}

/* ── the window icon is the agent's picture ───────────────────────────────
 *
 * The page already paints the agent's picture into its <link rel="icon"> -
 * that code understands images, GIFs and video (it decodes a frame), which
 * nativeImage cannot do. Ask it for that PNG and use it as the window/taskbar
 * icon, then poll the bridge's instance card so changing the pfp in Settings
 * reaches the icon without a restart. No picture means the shipped app icon. */
const APP_ICON = path.join(HERE, 'assets', 'icon.png');

async function syncAgentIcon() {
  if (iconSyncing || !win || win.isDestroyed() || !bridge) return;
  iconSyncing = true;
  try {
    let card = null;
    try { card = await fetch(`${bridge.url}/api/instance-card`, { cache: 'no-store' }).then((r) => r.json()); } catch { return; }
    const avatar = (card && card.avatar) || '';
    if (avatar === lastIconAvatar && (lastIconApplied || !avatar)) return;
    lastIconAvatar = avatar;
    if (!avatar) {
      const img = nativeImage.createFromPath(APP_ICON);
      if (!img.isEmpty()) win.setIcon(img);
      lastIconApplied = false;
      return;
    }
    let href = '';
    try {
      href = await win.webContents.executeJavaScript(`(async () => {
        if (typeof updateFavicon !== 'function') return '';
        updateFavicon();
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 100));
          const l = document.querySelector('link[rel="icon"]');
          if (l && /^data:image\\/png/i.test(l.href)) return l.href;
        }
        return '';
      })()`);
    } catch { return; }
    if (!href) return;
    const img = nativeImage.createFromDataURL(href);
    if (img.isEmpty()) return;
    win.setIcon(img);
    if (process.platform === 'darwin' && app.dock) app.dock.setIcon(img);
    lastIconApplied = true;
    if (TEST) console.log('PI-ELECTRON-ICON ' + JSON.stringify({ avatar: true, applied: true }));
  } finally {
    iconSyncing = false;
  }
}

function startIconSync() {
  if (iconTimer) return;
  setTimeout(() => syncAgentIcon().catch(() => {}), 1200);
  iconTimer = setInterval(() => syncAgentIcon().catch(() => {}), 5000);
}

function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  const paneW = Math.max(280, Math.min(loadSettings().paneWidth, width - 360));
  for (const [key, view] of views) {
    view.setBounds({ x: width - paneW, y: TOOLBAR_H, width: paneW, height: Math.max(0, height - TOOLBAR_H) });
    view.setVisible(paneOpen && key === activeFeed);
  }
  if (toolbar) {
    toolbar.setBounds({ x: width - paneW, y: 0, width: paneW, height: TOOLBAR_H });
    toolbar.setVisible(paneOpen);
  }
}

const state = () => ({
  feeds: FEED_ORDER.map((k) => ({ key: k, label: FEEDS[k].label, accent: FEEDS[k].accent })),
  active: activeFeed,
  paneOpen,
  width: loadSettings().paneWidth,
});

function openPane(key) {
  if (key) activeFeed = key;
  paneOpen = true;
  saveSettings({ paneOpen: true, activeFeed });
  ensureFeedView(activeFeed);
  layout();
}

function closePane() {
  paneOpen = false;
  saveSettings({ paneOpen: false });
  layout();
}

/* Electron does not draw the browser's native context menu on its own, so a
 * right click in a text field had no spellcheck suggestions, cut/copy/paste or
 * select-all. Build the same menu for the WebUI and for the two native
 * surfaces. The page's own right-click menus (a message, a session) still
 * preventDefault and are untouched. */
function registerContextMenu(wc) {
  wc.on('context-menu', (_event, params) => {
    const edit = params.editFlags || {};
    const word = String(params.misspelledWord || '');
    /* In the WebUI, editable right-clicks go to the page's own menu component
     * (the same .model-menu the pickers use). It receives the spellcheck
     * suggestions from here and sends the chosen action back; a native GTK
     * menu cannot be themed like the rest of the window. */
    if (wc === win.webContents && (params.isEditable || word)) {
      wc.send('piagent:context-menu', {
        x: params.x,
        y: params.y,
        isEditable: !!params.isEditable,
        selectionText: params.selectionText || '',
        misspelledWord: word,
        suggestions: Array.isArray(params.dictionarySuggestions) ? params.dictionarySuggestions.slice(0, 5) : [],
        canCut: edit.canCut !== false,
        canCopy: edit.canCopy !== false,
        canPaste: edit.canPaste !== false,
        canSelectAll: edit.canSelectAll !== false,
      });
      return;
    }
    const items = [];
    if (word) {
      const suggestions = Array.isArray(params.dictionarySuggestions) ? params.dictionarySuggestions.slice(0, 5) : [];
      if (suggestions.length) {
        for (const suggestion of suggestions) {
          items.push({ label: suggestion, click: () => wc.replaceMisspelling(suggestion) });
        }
      } else {
        items.push({ label: 'No spelling suggestions', enabled: false });
      }
      items.push({ label: 'Add to dictionary', click: () => { try { wc.session.addWordToSpellCheckerDictionary(word); } catch { /* best effort */ } } });
      items.push({ type: 'separator' });
    }
    if (params.isEditable) {
      items.push(
        { label: 'Cut', enabled: edit.canCut !== false, click: () => wc.cut() },
        { label: 'Copy', enabled: edit.canCopy !== false, click: () => wc.copy() },
        { label: 'Paste', enabled: edit.canPaste !== false, click: () => wc.paste() },
        { type: 'separator' },
        { label: 'Select all', enabled: edit.canSelectAll !== false, click: () => wc.selectAll() },
      );
    } else if (params.selectionText) {
      items.push(
        { label: 'Copy', enabled: edit.canCopy !== false, click: () => wc.copy() },
        { label: 'Select all', click: () => wc.selectAll() },
      );
    }
    if (!items.length) return;
    Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(wc) || win });
  });
}

function registerIpc() {
  ipcMain.on('piagent:webview', (event, raw) => {
    if (win && event.sender === win.webContents) handleEmbedMessage(raw);
  });
  ipcMain.on('piagent:context-action', (event, action, value) => {
    if (!win || event.sender !== win.webContents) return;
    const arg = value == null ? '' : String(value);
    switch (action) {
      case 'cut': win.webContents.cut(); break;
      case 'copy': win.webContents.copy(); break;
      case 'paste': win.webContents.paste(); break;
      case 'selectAll': win.webContents.selectAll(); break;
      case 'replace': if (arg) win.webContents.replaceMisspelling(arg); break;
      case 'dictionary': if (arg) { try { win.webContents.session.addWordToSpellCheckerDictionary(arg); } catch { /* best effort */ } } break;
      default: break;
    }
  });
  ipcMain.handle('piagent:embed-state', () => ({
    feed: !!(embedViews.feed && embedViews.feed.getVisible()),
    browser: !!(embedViews.browser && embedViews.browser.getVisible()),
    feedBounds: embedViews.feed ? embedViews.feed.getBounds() : null,
    browserBounds: embedViews.browser ? embedViews.browser.getBounds() : null,
  }));
  ipcMain.handle('shorts:state', () => state());
  ipcMain.handle('shorts:set-feed', (_e, key) => {
    if (FEEDS[key]) { activeFeed = key; saveSettings({ activeFeed: key }); ensureFeedView(key); layout(); }
    return state();
  });
  ipcMain.handle('shorts:reload', () => {
    const v = views.get(activeFeed);
    if (v) v.webContents.reload();
    return true;
  });
  ipcMain.handle('shorts:open-app', () => {
    const feed = FEEDS[activeFeed];
    shell.openExternal(feed.appUrl).catch(() => shell.openExternal(feed.home).catch(() => {}));
    return true;
  });
  ipcMain.handle('shorts:open-external', () => {
    const v = views.get(activeFeed);
    const url = (v && v.webContents.getURL()) || FEEDS[activeFeed].home;
    shell.openExternal(url).catch(() => {});
    return true;
  });
  ipcMain.handle('shorts:close', () => { closePane(); return state(); });
  ipcMain.on('shorts:resize', (_e, width) => {
    const w = Math.round(Number(width));
    if (!Number.isFinite(w)) return;
    const { width: winW } = win.getContentBounds();
    saveSettings({ paneWidth: Math.max(280, Math.min(w, winW - 360)) });
    layout();
  });
}

async function main() {
  if (process.platform === 'win32') app.setAppUserModelId('org.piagent.desktop');
  // No File/View/Window menu bar: this is a single-purpose window. Do it before
  // the window exists so there is no menu strip to flash on launch.
  Menu.setApplicationMenu(null);
  const settings = loadSettings();
  activeFeed = FEEDS[settings.activeFeed] ? settings.activeFeed : 'instagram';
  paneOpen = !!settings.paneOpen;
  if (TEST) paneOpen = true;   // the smoke test checks the split layout itself

  /* The bridge must not run with its cwd inside the app bundle: a packaged
   * AppImage mount is read-only, and its uploads directory was the first thing
   * to fail ("ENOENT ... mkdir /tmp/.mount_.../resources/app-bridge/uploads").
   * Give it a writable workspace the user can find; the test gets a scratch
   * one under its own userData. */
  const workspace = process.env.PI_ELECTRON_WORKSPACE
    || (TEST ? path.join(app.getPath('userData'), 'workspace')
      : (settings.workspace || path.join(app.getPath('documents'), 'Pi Agent')));
  bridge = await ensureBridge({ host: settings.host, port: settings.port, userData: app.getPath('userData'), workspace });

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: !TEST,
    backgroundColor: '#101318',
    title: 'Pi Agent',
    icon: path.join(HERE, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(HERE, 'webui-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.on('resize', layout);
  win.on('closed', () => { win = null; });
  registerContextMenu(win.webContents);

  toolbar = new WebContentsView({
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.contentView.addChildView(toolbar);
  toolbar.webContents.loadFile(path.join(HERE, 'toolbar.html'));

  if (paneOpen) ensureFeedView(activeFeed);
  layout();
  win.loadURL(bridge.url);
  registerIpc();
  startIconSync();

  if (TEST) return runTest();
}

/* The smoke test: everything hidden, no external network (the feed URL is
 * pointed at the bridge's own page), then a verdict on stdout. */
async function runTest() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const loaded = (wc) => new Promise((res) => {
    if (!wc.isLoading()) return res(true);
    wc.once('did-finish-load', () => res(true));
    wc.once('did-fail-load', (_e, code, desc) => res(`failed: ${code} ${desc}`));
    setTimeout(() => res('timeout'), 20000);
  });
  const out = { ok: false };
  try {
    const webuiLoad = await loaded(win.webContents);
    const view = ensureFeedView(activeFeed);
    const feedLoad = await loaded(view.webContents);
    await loaded(toolbar.webContents);
    out.webuiLoad = webuiLoad;
    out.feedLoad = feedLoad;
    await wait(500);
    out.webuiUrl = win.webContents.getURL();
    out.webuiChat = await win.webContents.executeJavaScript("!!document.getElementById('chat')");
    out.webuiDesktopBridge = await win.webContents.executeJavaScript("!!(window.piDesktop && typeof window.piDesktop.postMessage === 'function')");
    /* The in-page split pane talks to a native surface. Verify both halves of
     * the bridge: the browser tab and the Reels tab each create a visible
     * WebContentsView, and close removes it. */
    const browserState = await win.webContents.executeJavaScript(`(async () => {
      window.piDesktop.postMessage('piagent|browser|open|20|20|320|240|${bridge.url}/');
      await new Promise((r) => setTimeout(r, 350));
      const s = await window.piDesktop.embedState();
      window.piDesktop.postMessage('piagent|browser|close');
      return s;
    })()`).catch(() => null);
    out.embedBrowser = !!(browserState && browserState.browser &&
      browserState.browserBounds && browserState.browserBounds.width === 320 && browserState.browserBounds.height === 240);
    const feedState = await win.webContents.executeJavaScript(`(async () => {
      window.piDesktop.postMessage('piagent|shorts|open|20|20|320|240|${bridge.url}/');
      await new Promise((r) => setTimeout(r, 350));
      const s = await window.piDesktop.embedState();
      window.piDesktop.postMessage('piagent|shorts|close');
      return s;
    })()`).catch(() => null);
    out.embedFeed = !!(feedState && feedState.feed &&
      feedState.feedBounds && feedState.feedBounds.width === 320 && feedState.feedBounds.height === 240);
    /* The embedded feed gets the same after-load body-overflow reset as the
     * top-level pane; that is what lets YouTube Shorts scroll with a wheel.
     * The load event can be slow on a cold Windows/Wine start, so poll instead
     * of measuring once. */
    out.embedFeedScrollable = false;
    for (let i = 0; i < 25; i++) {
      const overflow = await embedViews.feed.webContents
        .executeJavaScript('getComputedStyle(document.body).overflow').catch(() => '');
      if (overflow === 'auto') { out.embedFeedScrollable = true; break; }
      await wait(100);
    }
    /* The actual Reels button in the page must go through this surface, not
     * the iframe placeholder. Clicking it twice opens and closes the panel. */
    out.reelsButton = await win.webContents.executeJavaScript(`(async () => {
      const b = document.getElementById('btn-reels');
      if (!b) return { opened: false, closed: false };
      b.click();
      await new Promise((r) => setTimeout(r, 700));
      const s = await window.piDesktop.embedState();
      b.click();
      await new Promise((r) => setTimeout(r, 250));
      const c = await window.piDesktop.embedState();
      return { opened: !!s.feed, closed: !c.feed };
    })()`).catch(() => ({ opened: false, closed: false }));
    /* Uploads must land in the writable workspace, not in the read-only app
     * bundle. This is the exact path that failed in the packaged AppImage. */
    const payload = Buffer.from('smoke-upload');
    let upload = null;
    try {
      upload = await fetch(`${bridge.url}/api/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'smoke.txt', mimeType: 'text/plain', data: payload.toString('base64') }),
      }).then((r) => r.json());
    } catch { /* reported as a failed check below */ }
    out.uploadOk = !!(upload && upload.ok && upload.path);
    if (upload && upload.path) {
      const served = await fetch(`${bridge.url}/api/bg-file?name=${encodeURIComponent(path.basename(upload.path))}`);
      out.uploadServed = served.ok && (await served.text()) === 'smoke-upload';
    }
    out.feedUrl = view.webContents.getURL();
    out.feedUA = view.webContents.session.getUserAgent();
    out.feedPreloadRan = await view.webContents.executeJavaScript('window.__piShortsPreload === true');
    out.feedTitle = await view.webContents.executeJavaScript('document.title');
    out.toolbarApi = await toolbar.webContents.executeJavaScript('!!window.piShorts');
    out.toolbarState = await toolbar.webContents.executeJavaScript('window.piShorts.state().then((s) => JSON.stringify(s))');
    out.noMenuBar = !Menu.getApplicationMenu();
    /* The editable context menu is drawn by the page, not by GTK. Feed it a
     * sample event and make sure the shared menu component opens. */
    win.webContents.send('piagent:context-menu', {
      x: 220, y: 320, isEditable: true, selectionText: '',
      misspelledWord: 'sugestion', suggestions: ['suggestion'],
      canCut: true, canCopy: true, canPaste: true, canSelectAll: true,
    });
    await wait(300);
    out.contextMenuStyled = await win.webContents.executeJavaScript(`(() => {
      const menus = [...document.querySelectorAll('.model-menu')].filter((m) => m.id !== 'model-menu');
      const m = menus[menus.length - 1];
      const ok = !!(m && getComputedStyle(m).display !== 'none' && m.querySelector('input[type="search"]') === null);
      if (typeof closeAllMenus === 'function') closeAllMenus();
      return ok;
    })()`);
    /* The Shorts tab in the WebUI's settings belongs to the desktop app: the
     * page hides it unless the user agent says Electron, and this is the real
     * one, so the check is end to end rather than simulated. */
    out.desktopUa = await win.webContents.executeJavaScript('navigator.userAgent');
    out.shortsTabShown = await win.webContents.executeJavaScript("(async () => { openSettings(); await new Promise((r) => setTimeout(r, 400)); const t = document.querySelector('#settings-tabs .tab[data-tab=\"shorts\"]'); return !!(t && !t.classList.contains('hidden')); })()");
    out.reelsBtnShown = await win.webContents.executeJavaScript("(async () => { applySettings(); return !document.getElementById('btn-reels').classList.contains('hidden'); })()");
    for (let i = 0; i < 20 && !lastIconApplied; i++) {
      await syncAgentIcon().catch(() => {});
      if (!lastIconApplied) await wait(200);
    }
    out.agentIconApplied = !!lastIconApplied;
    out.bounds = {
      toolbar: toolbar.getBounds(),
      feed: view.getBounds(),
      visible: { toolbar: toolbar.getVisible(), feed: view.getVisible() },
    };
    out.ok = !!(
      /^http:\/\/127\.0\.0\.1:\d+\//.test(out.webuiUrl) &&
      out.webuiLoad === true &&
      out.feedLoad === true &&
      !!out.feedTitle &&
      out.webuiChat &&
      out.webuiDesktopBridge &&
      out.noMenuBar &&
      out.contextMenuStyled &&
      out.embedBrowser &&
      out.embedFeed &&
      out.embedFeedScrollable &&
      out.reelsButton && out.reelsButton.opened && out.reelsButton.closed &&
      out.agentIconApplied &&
      out.uploadOk &&
      out.uploadServed &&
      out.feedPreloadRan &&
      out.toolbarApi &&
      out.toolbarState &&
      /Electron/i.test(out.desktopUa || '') &&
      out.shortsTabShown &&
      out.reelsBtnShown &&
      out.bounds.toolbar.width > 200 &&
      out.bounds.feed.width > 200 &&
      out.bounds.visible.toolbar === true
    );
  } catch (e) {
    out.error = String((e && e.stack) || e);
  }
  console.log('PI-ELECTRON-TEST ' + JSON.stringify(out));
  if (bridge && bridge.started && bridge.child) {
    try { bridge.child.kill(); } catch { /* already gone */ }
  }
  app.exit(out.ok ? 0 : 1);
}

app.whenReady().then(main).catch((e) => {
  console.error('pi-agent-desktop failed to start:', e);
  app.exit(1);
});

/* Closing the last window is quitting the app. */
app.on('window-all-closed', () => {
  app.quit();
});
app.on('before-quit', () => {
  if (bridge && bridge.started && bridge.child) {
    try { bridge.child.kill(); } catch { /* already gone */ }
  }
});
