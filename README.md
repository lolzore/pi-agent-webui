# Pi Agent WebUI

A browser UI for the [pi coding agent](https://github.com/badlogic/pi-mono) running headless (`pi --mode rpc`) inside a Docker container on Windows 10.
early Work.in.progress (will have bugs)

![Project Preview](assets/preview.png)
```
Browser  ──WebSocket/HTTP──▶  bridge (Node.js)  ──stdin/stdout JSONL──▶  pi --mode rpc
     (web/ static files)         (bridge/server.js)         (inside the container)
```

A single `pi --mode rpc` subprocess is shared by every connected client; every pi RPC command is relayed to it and every event is broadcast back to all of them, so the full agent protocol (streaming, tools, bash, extensions) works — and the browser UI, the desktop app and any other window stay in lockstep in real time instead of drifting apart.

## Features

| Feature | How it works |
|---|---|
| **Command use** | `/` opens a slash-command menu built from pi's `get_commands` (extension commands, prompt templates, `skill:` commands) **plus every pi built-in command** (`/compact`, `/new`, `/model`, `/thinking`, `/copy`, …) auto-loaded from the installed pi package — so new commands pi adds in future releases appear automatically. Built-ins with a direct RPC (`/compact`, `/new`, `/name`, `/model`, `/thinking`, `/clone`, `/copy`, `/session`) run natively in the WebUI; the rest are sent to the agent. Skills are listed under their plain name (`/pdf-tools`, not `/skill:pdf-tools`) and tab-completion inserts that — the `skill:` prefix pi registers is put back only on the way out, so what you send still reaches the right command. Shell access: type `!ls -la` to run a bash command in the container via pi's `bash` RPC (output streams live). |
| **Stop generation** | A **Stop** button appears next to the (always visible) Send button while the agent is generating — click it to abort the current turn. Esc also clears the queue and aborts. |
| **Live context ring** | The context ring in the top bar shows the % used and a `[used/max]ctx` label (e.g. `[54000/131072ctx]`). It updates **live while the agent is streaming** (polled every second) and on session switch — not just when you switch sessions and back. |
| **How long did that take** | The indicator at the bottom counts the **whole task**: it starts when you send a message and stops at the agent's last word, with thinking, tool calls, every turn and any compaction in between included — not a per-turn stopwatch that resets to zero while you watch. It is kept per session in the browser, so a reload keeps counting if the agent is still working, comes back as the frozen number if it finished, and is dropped if there is no honest boundary to measure from. Only sending a message starts a new one; the automatic continue after a compaction is the same task. Each assistant message still carries its own *turn took …* line. |
| **A steady picture** | The bottom strip and the message headers are laid out so that nothing moves except the text you are waiting for. An extension's widget or status appearing, changing line count or being cleared for a frame no longer resizes the composer area (a bar that goes empty keeps its place for a moment, and it has a fixed height while it is up), the scrollbar never changes the text width (`scrollbar-gutter`), and the numbers that grow as you watch — tokens, t/s, the task total — use fixed-width digits and enough reserved room that the row cannot rewrap. Those reflows were what made the whole conversation appear to jump up and down while the agent ran. |
| **Compaction** | `/compact` (or the ring) compacts the session. Right after a compaction the ring and label show `–` instead of a number, because the agent reports no context size until the next LLM response. |
| **Upload images and files** | 📎 button or drag & drop anywhere; images go as base64 image blocks on the `prompt` command, everything else travels as a path reference the agent can open with its tools. Anything over 8 MB is streamed to the bridge as a raw body instead of base64 (a 9 MB video used to arrive truncated, which is what produced *"data (base64) is required"*), the same file uploaded twice is stored once (the bridge keeps a hash index), and a file that is too big to attach but looks like a wallpaper becomes your background instead of an error. |
| **Paste images from clipboard** | Ctrl+V an image anywhere on the page — it becomes an attachment preview above the composer. |
| **Editing session text** | Hover a user message → ✏️. The text loads into the composer; sending uses pi's `fork` RPC to branch the session from that exact message and prompts with your edited text. |
| **Switching sessions** | Sidebar lists all sessions found in the pi session dir (from `/api/sessions`); click to `switch_session`, filter box, ⟳ refresh, `+ New` starts a new session, click the title bar name to rename (`set_session_name`). |
| **Voice to text** | 🎙 button uses the browser's own speech recognition by default (Chrome/Edge; `localhost` is a secure context, so no HTTPS needed) — nothing to download. A local whisper.cpp server is the opt-in alternative: pick a model (Tiny 75 MB / Base 142 MB / Small 466 MB / Large v3 multilingual 3.1 GB, each with a note on speed vs accuracy; the list is fetched even while browser voice is selected, so the choice is there when you switch) and clicking the mic starts it automatically with the selected model — first use downloads it, *download & start* in settings does it up front. The download is verified: the binary zip and every model are checked against their published SHA-256 for a pinned revision, and a file that does not match is deleted rather than run. If it cannot start, browser voice takes over. Speech fills the composer — review, then send manually, or enable **auto-send** (settings ⚙ or `/autosend`) for hands-free sending. |
| **TTS for agent output** | `TTS` toggle in the header (or `/tts`) auto-speaks every assistant reply; every assistant message also has a 🔊 button. Voices can be the browser's own (`speechSynthesis`, pick the Windows voice and rate in settings ⚙ with a test button), a local endpoint, or a **cloud voice** — fish-audio or any OpenAI-compatible `/v1/audio/speech` server. Cloud speech goes through the bridge (`POST /api/tts`), so there is no CORS to fight and the API key stays in the bridge's settings instead of the page. Esc stops playback. |
| **Agent identity** | Rename the agent and give it a profile image in settings ⚙ — both show next to its messages, and the image also sits top-left in the sidebar. There is no built-in placeholder: with no image set, only the name shows, and **clear** removes it everywhere. The image can be a still, a GIF or a video, and either can be **cropped by hand** (settings → crop…: the whole picture is shown with the crop frame over it, so you can see what you are cutting off — drag to move, scroll or the slider to zoom, and the dimmed area is what goes away). Its size is adjustable too. A **video** picture is decoded in two places at most — the sidebar and the newest message animate, every older message shows a still frame captured from it once — because one decoder per message meant two hundred of them on a long transcript, which no GPU hardware-decodes and the rest fell back to software (all CPU, laggy, and a buffer per element). |
| **Readable over anything** | Chat text is outlined (a 1px shadow around every glyph) so it stays legible when the panels are translucent and a background image or video shows through — the outline colour comes from settings, and it can be switched off. **Chatbox transparency** fades the composer, sidebar, message bubbles, tool cards, bash/system output, code blocks and the model/thinking controls together, with a real backdrop blur behind them, and **background transparency** fades the image/GIF/video on its own (a bright photo is often too much at full strength even with the panels clear). Backgrounds get the same manual crop as the profile image and are exempt from the attachment size limit (a background is only ever shown, never sent to the model), and a background **video's audio** can be played with its own volume — the browser only allows sound after you have clicked the page once, so it starts on the first click. |
| **Typing** | Optional **type anywhere**: with it on, any keystroke while the window is focused lands in the composer without clicking it first. |
| **Pi extensions integration** | Full `extension_ui_request` sub-protocol in the browser: `select`/`confirm`/`input`/`editor` dialogs become native modals, `notify` → toasts, `setStatus`/`setWidget` → status & widget bars above the composer, `setTitle` → tab title, `set_editor_text` → composer. Extension-registered slash commands appear in the `/` menu. |

| **Instances** | The agent's face at the top of the sidebar is the switcher: it lists the pi agents you use — this one plus any others you add (another machine, another port) — each with its own picture and a green pulsing dot while that agent is working. Picking one **keeps you on this page**: the local bridge fetches for you (`/proxy/<origin>/…`, WebSocket included), so sessions, chat, models **and the agent socket** are that machine's — a new session, a prompt or a fork all happen over there. What you look at is that instance's: its **agent name, picture and background** (its picture and background are served by *its* bridge, through the proxy, so they actually load) and its own **session folders** (folders are kept per instance, because a folder of this machine's session paths means nothing over there). What stays yours is how the UI behaves: theme colour, text size, transparency, notifications, the Instances list, the network switch and the voice backend. If that host is off you get a banner saying so and a way back, instead of a dead end. Right-click an instance to remove it from the list or open its own page. |
| **Forks in the session list** | A forked branch is a row under the session it came from, with a branch marker, and any session that has forks gets a small **▾** in front of its name: click it to fold the branches away, click again to bring them back (the fold is remembered per browser). Searching still finds a folded branch. A fork whose parent was deleted stays listed — otherwise it would not be reachable at all. Children that are not sessions (a subagent's run transcript) stay out of the list entirely. |
| **Session folders** | Right-click the session list for **new folder…**, then drag sessions onto it (drag a folder onto another to change their order, drop a session on the empty part of the list to take it out). Click a folder to fold it, right-click it to rename, empty or delete it. Folders live in the bridge's settings, so every browser and machine sees the same ones. |
| **Sub-agents** | When the pi-subagents extension runs child agents, a **sub-agents** button appears in the top bar — and only on the session those runs came from, so a session that never used one does not show it. The panel lists each run with what it is doing *now*: state, the tool it is on and how long it has been there, turns, tools, tokens and how long it has been running, counting up live (finished ones read *took 20s*) — read from the run's own `status.json`, so it keeps ticking even while the parent sits idle waiting for it, and a reload brings the list back instead of emptying it. Clicking a run opens **the session the child ran in**, read-only, in the same chat — its messages, tool calls and results — with the panel and a *back to the conversation* button always one click away; a live child is followed as it grows. Runs that have no session of their own fall back to the transcript artifact. The raw `PI_SUBAGENT_ASYNC_JSON` widget line is never printed into the UI. |
| **Notifications and errors** | 🔔 in the top bar keeps what the toasts drop: every notification and every error with the time it happened, click a row to copy its details, and the bell keeps a mark until you look. A page error no longer disappears into the console. |
| **When the agent finishes** | A turn can end while you are looking at another window. Settings → General: play a short chime, show a desktop notification, and "only when this window is not focused" (on by default). |
| **Gamer mode** | Settings → Appearance: the theme colour drifts through the rainbow, with a slider for how fast (4–60 s per cycle, 16 s by default). The colour advances by elapsed time rather than by animation frame, so it keeps its speed on a busy page or a slow machine, changing the speed continues from where the colour is, and oklch keeps the perceived speed even. Every accent-coloured thing follows it — scrollbars and the text highlight included. |
| **Mobile and narrow windows** | Under 760px the sidebar becomes a drawer over the chat (☰ opens it, tapping the conversation closes it), the topbar wraps instead of squeezing the session name between buttons, the stats row wraps instead of overlapping, and dialogs go edge to edge. Anything tappable gets a real touch target. |
| **Local models on the network** | If you run llama.cpp servers, the WebUI finds them: settings → Pi providers lists the ones it knows about, and the bridge scans for more — the configured URL, `localhost`, this machine's own LAN addresses, then a background sweep of the local /24 on the usual ports (8080/8081), skipping virtual adapters. A banner offers a server it found; dismissing it is remembered, and the sweep can be switched off with `PI_LLAMA_SCAN=off`. |
| **Settings that cannot be lost** | The bridge keeps the settings in one JSON file and **replaces** it with what a page posts, so the page now refuses to save before it has read the server's copy — a slow or failed first load used to leave a browser on its defaults and then write those over everything (avatar, background, folders). For the same reason the first-run dialog only appears once the settings really loaded, retrying once. |
| **Coming back after a restart** | The bridge remembers the session *this WebUI* was in and resumes it when it starts the agent, so restarting the bridge and reloading puts you back where you were. That record is its own file (`webui-last-session-<source>.json` in the agent dir) — the WebUI no longer reads `last-session-native.json`, which belongs to pi's own CLI, because sharing it meant restarting the bridge resumed whatever session the terminal had used last. A record whose session is gone is dropped before the agent is asked about it — that used to be a failed switch and, with a pi that does not answer, a wedged agent that had to be restarted. A browser that has been here before also keeps its own copy and switches back by itself. |
| **Right-click menus** | On a session: open, **export…** (a real "save where you want" dialog), **branches…** (jump to a fork point) and **delete…** (asks first). On a message: **fork from here** — starts a new branch at that turn — plus copy and speak. Same look as the model picker. |

Extras: streaming markdown rendering (code blocks, thinking collapse, live tool-call cards), model & thinking-level pickers (the model list is searchable and scrolls, however many you have), session stats (context %, cost, tokens/sec that stay on screen after the turn ends), queue display with steer/follow-up, Esc to clear-queue + abort, agent crash banner with one-click restart.

## Run it

> This machine runs Forgejo on port 3000, so the WebUI uses **http://localhost:3080**.

There are three ways in: the **browser UI** (`start-webui.bat`), the same UI in **its own window** with no build step (`start-app-window.bat`, Edge/Chrome app mode), or the **native Windows app** (`start-app.bat`, source in `pi-desktop/`).

The first time you open the UI it asks a handful of things worth deciding up front — the agent's name and picture, theme colour (and gamer mode), chat text size, background, whether to play a sound or show a desktop notification when the agent finishes, voice auto-send, the Shorts feed and whether other devices on your network may open it. Everything there is also in ⚙ Settings, and the dialog never comes back once you press *Let's go* (or *skip*).

### Choosing the agent source (first run)

`start-webui.bat` asks once whether your pi agent runs natively on Windows or in a Docker container, and (for Docker) lists your containers so you pick the right one — no name hardcoded. The answer is saved to `bridge/agent-source.txt` and reused afterwards. Run `switch_pi_agent_source.bat` at any time to erase that choice and pick again.

### Your setup: attach to the existing pi agent container (recommended)

Your pi agent lives in the `heuristic_varahamihira` container (image `buildadatacenter`, pi home in the `pi-agent-datacenter-home` volume, workspace `C:\Users\dambi\Downloads\projects\ai\build_a_datacenter`). pi's RPC protocol is stdio-only — it cannot be reached over the network — so the bridge attaches to that exact container with `docker exec -i`:

```powershell
start-webui.bat        # or manually:
cd bridge
set PI_COMMAND=docker exec -i heuristic_varahamihira pi --mode rpc
set PI_SESSION_DIR=docker:heuristic_varahamihira:/root/.pi/agent/sessions
set PORT=3080
npm install && npm start
```

The agent keeps everything (model config, API endpoints, extensions, MCP servers, sessions) inside its own container — the bridge only shuttles JSON. Session listing, switching, and forking work against the container's `~/.pi/agent/sessions` via the `docker:<container>:<path>` form of `PI_SESSION_DIR`. Extension commands (`/subagents`, `/mcp`, `/council`, …) and extension UI events (MCP status bar, widgets, dialogs) come straight from your agent. Requires the container to be running: `docker start heuristic_varahamihira`.

### Alternative: dedicated container with pi bundled

```powershell
docker compose up -d --build
```

Builds a container with the pi CLI installed inside and serves on 3080, workspace mounted from `./workspace`. Connect it to a provider by putting `ANTHROPIC_API_KEY=...` / `OPENAI_API_KEY=...` etc. in `.env` next to `docker-compose.yml`, or reuse an existing pi home by replacing `- pi_data:/root/.pi` with `- ${USERPROFILE}\.pi:/root/.pi` in `docker-compose.yml`.

```powershell
$env:PI_WEBUI_PORT=3090; docker compose up -d --build   # when 3080 is taken
docker compose build --build-arg PI_PACKAGE=@mariozechner/pi-coding-agent
```

The host port is `PI_WEBUI_PORT` (default 3080) so a container and a native bridge can share the machine. The image installs `@earendil-works/pi-coding-agent` by default — override with `--build-arg PI_PACKAGE=… --build-arg PI_VERSION=…` to pin another one. The container binds `0.0.0.0` *inside* its own network namespace, which is what makes the published port work at all; the port mapping is the boundary. **Your WebUI settings and the session to resume live in the pi volume** (`/root/.pi`), not in the image, so rebuilding or recreating the container no longer resets them, and `.dockerignore` keeps the host's `node_modules`, sessions and settings out of the image.

### Linux / macOS

`start-webui.sh` does the same job as the Windows launcher: it works out whether
pi is installed on the machine or lives in a container, remembers the answer in
`bridge/agent-source.txt`, and serves the UI on <http://localhost:3080>.

```bash
./start-webui.sh                     # ask once, then remember
./start-webui.sh native              # pi installed here
./start-webui.sh docker <container>  # pi inside that container (sessions stay there)
PORT=3090 ./start-webui.sh           # a different port
```

Anything Node 18+ runs, so the bridge, the Docker image and the launcher all work
the same way on Linux, macOS and Windows. For a container of its own,
`docker compose up -d --build` is still the quickest route (`PI_WEBUI_PORT=3090`
if 3080 is taken).

### Without Docker (native Windows)

```powershell
npm install -g @mariozechner/pi-coding-agent   # the pi CLI
cd pi_agent_webui/bridge
npm install
npm start                # serves http://localhost:3080 by default (set PORT to change)
```

Env vars for the bridge: `PORT` (3080), `PI_COMMAND` (default `pi --mode rpc`), `WORKSPACE_DIR` (agent cwd — a path inside the container is fine when `PI_COMMAND` is a `docker exec`), `PI_SESSION_DIR` (default `~/.pi/agent/sessions`, or `docker:<container>:<path>`), `PI_AGENT_DIR` (where pi's own config lives), `PI_WEBUI_HOST` (bind address — see `bridge/lan.json` below), `PI_WEBUI_SETTINGS` / `PI_WEBUI_LAST_SESSION` (where the WebUI keeps its own state; defaults are next to the bridge, or in the pi config dir when that is where a volume is mounted), `PI_WEBUI_IDLE_KILL_MS` (how long the agent is kept alive after the last window closes, default 25000 — a reload reconnects inside it, so the agent is not restarted for nothing), `PI_WEBUI_DEBUG_RPC=1` (log every RPC in and out, and every session change, to the console).

The bridge tells pi where to keep sessions and config (`PI_CODING_AGENT_SESSION_DIR` / `PI_CODING_AGENT_DIR`), so the sidebar and the agent always look at the same directory — set `PI_SESSION_DIR` and the agent writes there, instead of the two silently diverging.

### App window, no toolchain (start-app-window.bat)

```
start-app-window.bat
```

Opens the same web UI as its own window instead of a browser tab, using
Edge/Chrome app mode (no tabs, no address bar), and starts the bridge first if
nothing is listening on port 3080. Nothing to install and nothing to compile;
the default browser is used when no Chromium browser is found.

This is the recommended way to run it as an app. The native shell below looks
slightly more native but needs the C++ toolchain described there.

### Native desktop app (pi-desktop/)

The `pi-desktop/` folder is a **React Native for Windows** app: a WebView2 host
around the same `web/` UI, plus native extras the browser cannot do — the
Instagram / TikTok / YouTube Shorts feed renders in a real WebView2 surface, so
`X-Frame-Options: DENY` does not apply, and the feed can auto-open while the
agent runs.

```
start-app.bat
```

That starts the bridge for you (quietly, in the background, no question asked),
installs the app's npm dependencies, builds it when there is no build yet, and
launches it. When you close the app window the bridge it started is stopped
too, so opening and closing the app is all there is to it - a bridge that was
already running is left alone, since a browser tab may be using it. The first
build compiles the C++ React Native Windows runtime and takes 5-20 minutes;
afterwards `pi-desktop\windows\x64\Release\PiAgent.exe` starts directly.

The WebUI lives in one native WebView2 surface that is **kept across layout
changes**: the host component is remounted whenever the window is resized (or
rotated, or the Shorts panel opens), and it used to close the surface on unmount
and then navigate it to the same URL on the next mount - which is a full page
load in WebView2, so a one-pixel resize reloaded the whole UI and restarted every
video. It now only re-bounds the surface, and only navigates when the bridge URL
really changes.

> Note: an app JS-only fix cannot be shipped by hand-building the bundle. Metro
> plus the matching Hermes compiler produces bytecode with an identical header
> that the runtime still refuses (white window). Use the real build targets.

Building needs **Visual Studio 2022 with the "Desktop development with C++"
workload and the Windows 11 SDK (10.0.26100)**, which is a few gigabytes of
download — that is the reason `start-app-window.bat` exists. The project files
are committed (only build output is ignored), so a clone builds as-is once the
toolchain is present; see `pi-desktop/README.md` for the details.

### Try it without any agent (UI smoke test)

```powershell
cd bridge; npm install
$env:PI_COMMAND="node mock_agent.js"; npm start
```

`bridge/mock_agent.js` implements a compatible subset of the RPC protocol — streaming replies, images, bash, `/echo`, `/dialog` (exercises the extension dialog flow), sessions, fork/edit.

## Notes & troubleshooting

- **Stopping the WebUI**: run `start-webui.bat` by double-clicking it (or a shortcut with *Normal* window style) so the console window stays open. Stop it with **Ctrl+C** in that window or by **closing the window** — both cleanly kill the `pi --mode rpc` agent process(es) and the whisper server, so nothing is left running in the background. If a stray agent is already running, `taskkill /F /IM node.exe` (native) or `docker stop <container>` (Docker source) clears it.
- **Voice input** needs Chrome or Edge and microphone permission; it only works from `http://localhost:3080` (secure context) — not from a LAN IP, because browsers only allow microphones on secure contexts (Chrome can be told to trust one via `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, at your own risk).
- **TTS** uses the Windows voices installed on the *client* machine (browser-side speech synthesis).
- **Sessions survive refresh, reload and restart.** A fresh `pi --mode rpc` always starts in a brand-new empty session, and a session has no file until its first message — the two together used to make a quick reload look like the session had vanished. Now: the agent is kept alive for `PI_WEBUI_IDLE_KILL_MS` (25s) after the last window closes, so a reload usually does not touch it at all; the session is remembered per agent source (`last-session-<source>.json`, plus a per-browser copy), written on every new session, fork and prompt and once more just before the agent is stopped; and the switch back into it is the *first* command on the pipe, with nothing awaited before it, so a client's own commands can never overtake it. The page re-reads the transcript when the bridge says the resume is done, and never picks a session out of its own memory unless the bridge really did start fresh. If the session's working folder is gone, the resume is skipped with a warning and the usual folder-recreate flow (click it in the sidebar) applies.
- If the header dot is red, the WebSocket is down — the banner offers a retry. If pi itself crashes, the banner offers **Restart agent** (spawns a fresh `pi --mode rpc`, same session).
- Session listing scans `PI_SESSION_DIR` for `*.jsonl` (recursively). Set it to `docker:<container>:<path>` to list sessions inside a container via `docker exec`, or a plain host path for a native pi install.
- **Renamed or moved the project folder?** Each session records the working directory it was taken in, and pi refuses to open a session whose folder is gone. When you click such a session the WebUI says which folder is missing and offers to recreate it; saying yes puts the (empty) folder back and opens the session, so nothing is lost.
- **Local only by default.** The bridge binds `127.0.0.1`, so nothing on your network can reach it. It can also drive a shell on this machine, so exposing it is a deliberate choice: **Settings → General → Network** switches it on and off live (the bridge writes `bridge/lan.json` and rebinds without a restart), or set `"lan": true` in that file by hand (`PI_WEBUI_HOST=0.0.0.0` wins over it; `"host": "192.168.x.y"` binds one specific interface). It prints a warning and the LAN address whenever it is listening on the network — only do this on a network you trust, there is no login.
- **Reaching another machine's WebUI.** The switcher does not send your browser to the other machine: this bridge fetches for it (`/proxy/<origin>/...`, WebSocket included), so the page stays on this origin and a host that is switched off is a banner with a way back rather than a dead end. The other bridge therefore only has to be reachable **from this machine** - either enable LAN on it (`"lan": true` in its `bridge/lan.json`, or the switch in Settings > General, it warns), or keep it local and forward a port over SSH (`ssh -L 3081:localhost:3080 user@otherbox`, then add `http://localhost:3081`). The tunnel is the safer of the two: nothing is exposed to the network. Only addresses already in the instance list are proxied, never arbitrary ones.
- **Something stuck on screen?** `Esc` closes any open menu (model picker, thinking levels, instance switcher, branch list) before it means "stop the agent", and a click anywhere outside a menu closes it. In a window with no reload button that is the way out.
- **A long unbroken line** (a URL, a hash, minified code) wraps instead of widening the transcript; only a code block scrolls sideways. The chat never scrolls horizontally. The conversation's scrollbar runs the full height of the window (it is the chat column that scrolls, not the message list inside it), so it does not stop at the top of the composer or shorten while you type.
- **The same file uploaded twice** is kept once: the bridge remembers the hash of what it wrote and hands back the existing path (the UI says so), instead of filling the workspace with copies.
- **Voice downloads are verified.** The whisper.cpp binaries and every model are checked against a published SHA-256 (the model hashes come from HuggingFace's LFS metadata, the binary hash from the release asset digest; models are pinned to one commit), and anything that does not match is deleted instead of executed. A model without a published hash is still allowed, with a warning in the log.
- **The tab icon is the agent's picture** (a GIF or video avatar is animated in the tab by drawing frames onto a canvas).
- RPC notes: prompts sent while the agent streams are queued with `streamingBehavior: "steer"`; `Esc` sends `clear_queue` then `abort` (queued text is restored into the composer).

## Files

```
start-webui.bat         launcher (Windows): pick native pi or a Docker container, then serve :3080
start-webui.sh          the same launcher for Linux and macOS
start-app-window.bat    same UI in its own app window (Edge/Chrome app mode), no toolchain needed
start-app.bat           native React Native for Windows app (builds pi-desktop/, needs Visual Studio)
switch_pi_agent_source.bat  re-run the source picker, then launch
Dockerfile              container image (node + pi CLI + bridge + web)
docker-compose.yml      alternative: dedicated container with bundled pi, port 3080 (PI_WEBUI_PORT)
.dockerignore           keeps node_modules, sessions and settings out of the image
bridge/server.js        HTTP + WebSocket bridge, spawns one pi RPC process per tab
bridge/lan.json         LAN access: {"lan": true} exposes the bridge to the network (ships as false: local only)
bridge/whisper_boot.js  downloads and runs the local whisper.cpp server on demand
bridge/mock_agent.js    fake pi agent for UI testing
web/index.html|app.js|style.css   the UI (no build step, no framework)
```

Protocol reference: [pi RPC docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md).
