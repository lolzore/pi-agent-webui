# Pi Agent — desktop app (Electron)

The WebUI in a native window, with the **real** shorts feeds beside it. One
codebase for Windows and Linux, and it replaces the React Native Windows app
(`pi-desktop/`) — that app's only extra capability, the native webview, is
exactly what this one keeps.

## Why a webview and not the browser

Instagram Reels, TikTok and YouTube Shorts send `X-Frame-Options: DENY`, so an
`<iframe>` cannot show them. A `WebContentsView` is a **top-level browsing
context**, like a browser tab — the header does not apply — so the genuine
infinite, logged-in feed plays next to the chat. That is the whole reason this
app exists; everything else is the WebUI you already know.

## What it does

- **Starts the bridge itself** if none is listening (`/api/health` check first),
  using `ELECTRON_RUN_AS_NODE` — Electron's own node — so a packaged build needs
  nothing installed. An already-running bridge (yours, or the WebUI in a
  browser) is reused and left alone.
- **One window**: the WebUI, straight from the bridge.
- **Shorts pane** (Ctrl+Shift+S, or View → Shorts pane): a `WebContentsView` per
  feed, kept mounted so switching tabs is instant and each feed keeps its
  cookies/login (`persist:shorts-<feed>`). Drag the toolbar's left edge to
  resize.
- **Per-feed identity** (`feeds.js`, shared with the native app): desktop UA for
  Instagram/TikTok, mobile UA for YouTube Shorts; scrollbars and the rubber-band
  overscroll are hidden; autoplay is unblocked with a preload that runs before
  the page's own scripts; cookie/install nags are scrubbed after load.
- **Link taps stay sane**: anything off the feed's own hosts opens in the system
  browser instead of trapping you in the pane.
- Settings live in the OS's per-user config directory (`settings.json`).
- **The agent's picture is the window icon.** The page paints its tab icon from
  the agent's profile image/GIF/video frame; the app reads that PNG and calls
  `setIcon`, then polls the bridge's instance card so a new pfp is reflected
  without restarting. With no picture set, the shipped icon is used.
- **The workspace is writable.** The bridge runs from inside the app bundle,
  which is read-only in an AppImage, so the app gives it
  `Documents/Pi Agent` (overridable with `PI_ELECTRON_WORKSPACE` or
  `workspace` in the app's `settings.json`). Uploaded backgrounds and profile
  pictures land in `<workspace>/uploads`; the agent starts there too.
- **No application menu bar.** There is no File/View/Window strip; the page's
  own controls are the interface.

## Running it

```sh
cd pi-electron
npm install        # first run only (downloads Electron)
npm start
```

`npm start` starts the bridge too, unless one is already up on the port
(`PI_WEBUI_PORT`, `PORT`, or 3080).

## Testing

```sh
npm test
```

It launches the real app with a **hidden** window, points the feed at the
bridge's own page (so no internet is needed) and asserts: the WebUI loads, the
app started its own bridge, the feed view is a separate top-level context with
the right user agent and its preload in the page's world, the toolbar's IPC
answers, and the split layout is where it should be. Exits 77 (skip) when
Electron is not installed or there is no display.

## Building releases

```sh
npm run dist:linux      # AppImage + .deb
npm run dist:win        # portable .exe (buildable from Linux, no wine needed)
npm run dist:win:nsis   # NSIS installer - needs wine on Linux
npm run dist            # the release set (Linux + the portable exe)
```

The NSIS installer is the one target that needs wine (electron-builder runs
rcedit/the uninstaller step through it), which is why the release ships the
**portable** exe: it is the self-contained one - copy it anywhere and run it.

On Fedora, electron-builder's bundled fpm Ruby links `libcrypt.so.1`; install
`libxcrypt-compat` if the `.deb` target fails with `ruby: error while loading
shared libraries: libcrypt.so.1`. The AppImage target does not use fpm.

