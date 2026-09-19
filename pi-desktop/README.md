# Pi Agent — native app (React Native, Windows + Android + iOS)

A standalone native client for the Pi Agent WebUI bridge. It speaks the exact
same WebSocket RPC protocol as the browser UI, so it can drive the same agent,
sessions and models — plus it does the thing a browser fundamentally cannot:
**play the real shorts feeds next to the chat.**

One React Native codebase, three targets:

| target | status on this machine |
| --- | --- |
| **Windows** (primary) | built and running — `start-app.bat` |
| Android / iOS | code in place, needs the Android SDK / macOS + Xcode |

---

## Why this exists (the shorts problem)

Browsers cannot embed Instagram Reels / TikTok / YouTube Shorts feeds:

- Instagram and TikTok send `X-Frame-Options: DENY`, so an `<iframe>` refuses to
  render their feeds.
- Only *single-video* official embeds work in a browser.

A native `WebView` does not have that limitation. It is a **top-level browser
context**, not a nested frame — `X-Frame-Options` simply does not apply. So the
app would load the genuine, infinite, logged-in feed inside the app, next to the
chat. No new tabs, no popups, no "open in app" round-trips.

**On Windows this is not yet possible** — see [Shorts on Windows](#shorts-on-windows).
On Android/iOS it works fully.

---

## Running it

### Windows

```bat
start-app.bat
```

That checks the bridge is up, builds the app if needed, and launches it. The
first build takes a while (it compiles the C++ React Native Windows runtime).

Or by hand:

```bat
cd pi-desktop
npm install
npm run windows:release     :: Release + JS bundle, runs standalone
npm run windows             :: Debug, needs "npm start" (Metro) in another shell
```

The Release build lands in `pi-desktop\windows\x64\Release\PiAgent.exe` and
embeds the JS bundle (`Bundle\index.windows.bundle`), so it needs no dev server.

### Android / iOS

```bash
cd pi-desktop
npm start                   # Metro, then press "a" for Android
npm run android
npm run ios                 # macOS only
```

### Connecting

On first launch the app asks for:

| field | value |
| --- | --- |
| Host / IP | your PC's LAN IP, e.g. `192.168.1.39` (not `localhost` — on a phone that means the phone) |
| Port | `3080` (the default in `start-webui.bat`) |

The choice is stored with AsyncStorage and reused on every later launch; change
it any time from the ⚙ button. On Windows you can use `localhost`.

The bridge must be running (`start-webui.bat`), and for a phone the PC firewall
must allow inbound TCP on the bridge port.

---

## What the app does

**Chat**
- Live streaming assistant output, including thinking blocks
- Tool-call cards (expandable) and tool results
- Markdown rendering (headings, code fences, lists, quotes, links)
- User / assistant / tool / system message styling

**Agent control**
- Model picker, grouped by provider with the active model ticked
- Session list, switch, and **new session**
- **Rename the current session** (updates the WebUI sidebar too — pi writes a
  `session_info` entry that the bridge reads from the file tail)
- **Stop** button (`clear_queue` + `abort`)
- Send while streaming → sent with `streamingBehavior: 'steer'`, so it steers the
  running turn instead of being swallowed
- Live context percentage pill in the header: green → amber (≥75%) → red (≥90%)

**Shorts**
- One tap on ▶ opens the panel; landscape docks it to the right, portrait opens
  a bottom sheet you can drag open to ~92% height
- Tabs for **Reels / TikTok / Shorts**; one WebView per provider stays mounted, so
  switching tabs is instant and each feed keeps its own state
- Cookies, DOM storage and cache are shared with the platform browser engine, so
  a login made once inside the panel persists
- `setSupportMultipleWindows={false}` keeps `target=_blank` and `window.open()`
  inside the panel instead of spawning blank windows
- Off-site link taps are handed to the OS (`Linking.openURL`) so a reel can never
  trap you in the panel
- Loading progress bar, error state with **Retry**, an **Open in app** fallback
  that deep-links into the native Instagram / TikTok / YouTube app, and hidden
  providers have their `<video>` paused so two feeds never play audio at once

**Other**
- Android hardware back closes the shorts panel / modals instead of exiting
- Setup screen, dark theme, safe-area aware

---

## WebView2 on Windows (in-app feeds, and a UI identical to the WebUI)

`react-native-webview` ships a `windows/` target, but it is a **legacy UWP
project** (`ApplicationType: Windows Store`, CppWinRT pulled from a
packages.config layout) and cannot be linked into a React Native Windows
**WinAppSDK / New Architecture** app. React Native Windows 0.84 itself exports no
WebView component either. So `react-native-webview` is excluded from the Windows
build in [`react-native.config.js`](react-native.config.js) and the app carries
its own surface instead:

| piece | what it does |
| --- | --- |
| `windows/PiAgent/WebView2Module.h` | the native module: one child HWND + one `CoreWebView2Controller`, DPI-scaled, with a shared user-data folder so logins persist |
| `src/webview2.js` | JS binding: renders a placeholder, measures it with `measureInWindow`, and hands the rect to the module |
| `src/WebUIHost.windows.js` | points that surface at the bridge's own WebUI |
| `src/ShortsPanel.windows.js` | points it at Instagram / TikTok / YouTube |

The surface is a **top-level browsing context**, so the `X-Frame-Options: DENY`
header Instagram and TikTok send does not apply and their real, infinite,
logged-in feeds load inside the app — the same behaviour the mobile app gets
from `react-native-webview`.

Because it is a real Chromium surface, the app can also host the **actual WebUI**
(`web/`) instead of reimplementing it, which is how the Windows UI stays
identical to the browser one: same HTML, same CSS, same `app.js`. Toggle it with
the ▤ button in the header.

### Things to know

- The child HWND **paints on top of the React Native surface**. Anything drawn
  over the placeholder rect is hidden, so controls (tab bars, buttons) must sit
  outside the WebView rect — that is why the header stays above it.
- The native module owns **one** surface process-wide. `src/webview2.js` gives it
  a lease: the last component to mount owns it, `open`/`setBounds` take a rect
  object (`{x, y, width, height}`) or positional numbers, and only the owner may
  navigate or close it.
- `WebView2Loader.dll` is copied next to the exe by the vcxproj, because
  `CreateCoreWebView2EnvironmentWithOptions` is a hard import once referenced.

---

## Project layout

```
pi-desktop/
├── App.js                     # app shell, chat, modals, event wiring
├── index.js                   # AppRegistry entry
├── app.json                   # app name / display name
├── react-native.config.js     # excludes react-native-webview from Windows
├── babel.config.js
├── metro.config.js
├── windows/                   # React Native Windows C++ project (generated)
│   ├── PiAgent.sln
│   ├── PiAgent/               # the app (PiAgent.vcxproj)
│   │   └── WebView2Module.h   # the WebView2 native module
│   └── ExperimentalFeatures.props
└── src/
    ├── bridge.js              # WS client: connect / rpc / events / auto-reconnect
    ├── webview2.js            # WebView2 binding for Windows
    ├── WebUIHost.windows.js   # hosts the real WebUI (identical UI)

    ├── config.js              # ws:// and http:// URL builders
    ├── store.js               # AsyncStorage-backed settings
    ├── feeds.js               # feed URLs, user agents, injected CSS/JS
    ├── ShortsPanel.js         # seamless in-app shorts feed  (mobile)
    ├── ShortsPanel.windows.js # browser fallback            (Windows)
    ├── safearea.js            # re-exports react-native-safe-area-context
    ├── safearea.windows.js    # no-op shims (desktop has no insets)
    ├── MessageBubble.js       # chat message rendering
    └── Markdown.js            # minimal markdown renderer
```

`*.windows.js` files are picked automatically by Metro when bundling for Windows.

---

## Building for Windows — what this machine needed

React Native Windows 0.84 predates Visual Studio 2026, and two community modules
predate the New Architecture. Five things had to be worked around; all of them
live in `windows/ExperimentalFeatures.props` and
`windows/PiAgent/PiAgent.vcxproj`, so they survive a clean rebuild.

1. **`.NET SDK` + `PowerShell 7`** — `@react-native-windows/cli` refuses to
   register its commands without them (`dotnet nuget locals` and `pwsh.exe`).
   Installed via winget: `Microsoft.DotNet.SDK.10`, `Microsoft.PowerShell`.

2. **`PlatformToolsetVersion` is empty on VS 2026.** RNW's
   `Microsoft.ReactNative.vcxproj` and `PropertySheets\React.Cpp.props` compare
   `$(PlatformToolsetVersion) < 145` before `Microsoft.Cpp.props` has defined it
   (VS 2022 defined it earlier), giving `MSB4086`. `ExperimentalFeatures.props`
   is imported first, so it sets the value there.

3. **`UseFabric` / `UseHermes` / `UseWinUI3`.** `ReactNativeArchitecture.props`
   sets these, but it is imported around line 40 while modules such as
   `@react-native-async-storage/async-storage` pick their Win32 vs legacy-UWP
   layout with a `<Choose>` on `$(UseFabric)` at the top of the project. The
   property was still empty, so they took the UWP branch
   (`AppContainerApplication=true`) and died with *"The BaseOutputPath/OutputPath
   property is not set"*. Set early in `ExperimentalFeatures.props`.

4. **`WindowsAppSDKVerifyTransitiveDependencies=false`.** WinAppSDK 1.8 fails the
   build of any project that only references the umbrella package.

5. **Unpackaged deployment.** The MSIX wrapper project (`PiAgent.Package`) needs
   the *Windows Application Packaging Project* VS component, which is not
   installed, so it is removed from `PiAgent.sln` and the app runs unpackaged —
   which requires `WindowsPackageType=None` on the **app** project (libraries
   must not get it, or they fail to link `MddBootstrapInitialize2`) plus
   `WindowsAppSDKSelfContained=true`, because the installed
   `Microsoft.WindowsAppRuntime.1.8` is older than the NuGet RNW 0.84 pulls in and
   the unpackaged bootstrapper fail-fasts (`0xc0000409` in `ucrtbase.dll`)
   otherwise.

Two build-time overrides are passed on the command line (see the `windows*`
scripts in `package.json`) because module projects set them unconditionally and
only a global MSBuild property can win:

```
WindowsTargetPlatformVersion=10.0.26100.0   # async-storage pins 10.0.22621.0
PlatformToolset=v145                        # async-storage pins v143 (VS 2022)
```

To get an MSIX installable instead of the loose exe, install the
*Windows Application Packaging Project* component, restore `PiAgent.Package` in
`PiAgent.sln`, and drop `WindowsPackageType=None` /
`WindowsAppSDKSelfContained`.

---

## Protocol notes

The bridge spawns one `pi --mode rpc` child per WebSocket client, so the app is
fully independent of any browser session. Requests are `{ id, type, ... }` and
correlate to `{ type: 'response', id, success, data }`. Agent events
(`message_start`, `message_update`, `message_end`, `agent_start`, `agent_settled`,
`compaction_end`, `session_info_changed`, …) arrive unsolicited.

REST endpoints used by the app:

| endpoint | purpose |
| --- | --- |
| `GET /api/sessions` | session list (names include explicit renames) |
