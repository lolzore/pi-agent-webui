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
| **Command use** | `/` opens a slash-command menu built from pi's `get_commands` (extension commands, prompt templates, `skill:` commands) **plus every pi built-in command** (`/compact`, `/new`, `/model`, `/thinking`, `/copy`, …) auto-loaded from the installed pi package — so new commands pi adds in future releases appear automatically. Built-ins with a direct RPC (`/compact`, `/new`, `/name`, `/model`, `/thinking`, `/clone`, `/copy`, `/session`) run natively in the WebUI; the rest are sent to the agent. Shell access: type `!ls -la` to run a bash command in the container via pi's `bash` RPC (output streams live). |
| **Stop generation** | A **Stop** button appears next to the (always visible) Send button while the agent is generating — click it to abort the current turn. Esc also clears the queue and aborts. |
| **Live context ring** | The context ring in the top bar shows the % used and a `[used/max]ctx` label (e.g. `[54000/131072ctx]`). It updates **live while the agent is streaming** (polled every second) and on session switch — not just when you switch sessions and back. |
| **Compaction** | `/compact` (or the ring) compacts the session. Right after a compaction the ring and label show `–` instead of a number, because the agent reports no context size until the next LLM response. |
| **Upload images** | 📎 button or drag & drop anywhere; sent as base64 image blocks on the `prompt` command. |
| **Paste images from clipboard** | Ctrl+V an image anywhere on the page — it becomes an attachment preview above the composer. |
| **Editing session text** | Hover a user message → ✏️. The text loads into the composer; sending uses pi's `fork` RPC to branch the session from that exact message and prompts with your edited text. |
| **Switching sessions** | Sidebar lists all sessions found in the pi session dir (from `/api/sessions`); click to `switch_session`, filter box, ⟳ refresh, `+ New` starts a new session, click the title bar name to rename (`set_session_name`). |
| **Voice to text** | 🎙 button uses the Web Speech API (Chrome/Edge; `localhost` is a secure context so no HTTPS needed). Speech fills the composer — review, then send manually, or enable **auto-send** (settings ⚙ or `/autosend`) for hands-free sending. |
| **TTS for agent output** | `TTS` toggle in the header (or `/tts`) auto-speaks every assistant reply via `speechSynthesis`; every assistant message also has a 🔊 button. Pick the Windows voice and speech rate in settings ⚙ (with a test button). Esc stops playback. |
| **Agent identity** | Rename the agent and give it a profile image in settings ⚙ — both show next to its messages, and the image also sits top-left in the sidebar. There is no built-in placeholder: with no image set, only the name shows, and **clear** removes it everywhere. The image can be a still, a GIF or a video, and either can be **cropped by hand** (settings → crop…: drag to move, scroll or the slider to zoom — zooming in is what unlocks sideways movement, since a picture that already fits the frame edge to edge has nothing to slide along). Its size is adjustable too. |
| **Readable over anything** | Chat text is outlined (a 1px shadow around every glyph) so it stays legible when the panels are translucent and a background image or video shows through — the outline colour comes from settings, and it can be switched off. **Chatbox transparency** fades the composer, sidebar, message bubbles, tool cards, bash/system output, code blocks and the model/thinking controls together, with a real backdrop blur behind them. Backgrounds (image / GIF / video) get the same manual crop as the profile image. |
| **Typing** | Optional **type anywhere**: with it on, any keystroke while the window is focused lands in the composer without clicking it first. |
| **Pi extensions integration** | Full `extension_ui_request` sub-protocol in the browser: `select`/`confirm`/`input`/`editor` dialogs become native modals, `notify` → toasts, `setStatus`/`setWidget` → status & widget bars above the composer, `setTitle` → tab title, `set_editor_text` → composer. Extension-registered slash commands appear in the `/` menu. |

Extras: streaming markdown rendering (code blocks, thinking collapse, live tool-call cards), model & thinking-level pickers (the model list is searchable and scrolls, however many you have), session stats (context %, cost, tokens/sec that stay on screen after the turn ends), queue display with steer/follow-up, Esc to clear-queue + abort, agent crash banner with one-click restart.

## Run it

> This machine runs Forgejo on port 3000, so the WebUI uses **http://localhost:3080**.

There are three ways in: the **browser UI** (`start-webui.bat`), the same UI in **its own window** with no build step (`start-app-window.bat`, Edge/Chrome app mode), or the **native Windows app** (`start-app.bat`, source in `pi-desktop/`).

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

Builds a container with the pi CLI installed inside (verified with pi 0.73.1) and serves on 3080, workspace mounted from `./workspace`. Connect it to a provider by putting `ANTHROPIC_API_KEY=...` / `OPENAI_API_KEY=...` etc. in `.env` next to `docker-compose.yml`, or reuse an existing pi home by replacing `- pi_data:/root/.pi` with `- ${USERPROFILE}\.pi:/root/.pi` in `docker-compose.yml`.

### Without Docker (native Windows)

```powershell
npm install -g @mariozechner/pi-coding-agent   # the pi CLI
cd pi_agent_webui/bridge
npm install
npm start                # serves http://localhost:3080 by default (set PORT to change)
```

Env vars for the bridge: `PORT` (3000), `PI_COMMAND` (default `pi --mode rpc`), `WORKSPACE_DIR` (agent cwd), `PI_SESSION_DIR` (default `~/.pi/agent/sessions`).

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

That starts the bridge if needed, installs the app's npm dependencies, builds it
when there is no build yet, and launches it. The first build compiles the C++
React Native Windows runtime and takes 5-20 minutes; afterwards
`pi-desktop\windows\x64\Release\PiAgent.exe` starts directly.

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
- **Voice input** needs Chrome or Edge and microphone permission; it only works from `http://localhost:3080` (secure context) — not from a LAN IP.
- **TTS** uses the Windows voices installed on the *client* machine (browser-side speech synthesis).
- If the header dot is red, the WebSocket is down — the banner offers a retry. If pi itself crashes, the banner offers **Restart agent** (spawns a fresh `pi --mode rpc`, same session).
- Session listing scans `PI_SESSION_DIR` for `*.jsonl` (recursively). Set it to `docker:<container>:<path>` to list sessions inside a container via `docker exec`, or a plain host path for a native pi install.
- **Renamed or moved the project folder?** Each session records the working directory it was taken in, and pi refuses to open a session whose folder is gone. When you click such a session the WebUI says which folder is missing and offers to recreate it; saying yes puts the (empty) folder back and opens the session, so nothing is lost.
- No authentication is included — keep the port bound to localhost (the default).
- RPC notes: prompts sent while the agent streams are queued with `streamingBehavior: "steer"`; `Esc` sends `clear_queue` then `abort` (queued text is restored into the composer).

## Files

```
start-webui.bat         launcher: pick native pi or a Docker container, then serve :3080
start-app-window.bat    same UI in its own app window (Edge/Chrome app mode), no toolchain needed
start-app.bat           native React Native for Windows app (builds pi-desktop/, needs Visual Studio)
switch_pi_agent_source.bat  re-run the source picker, then launch
Dockerfile              container image (node + pi CLI + bridge + web)
docker-compose.yml      alternative: dedicated container with bundled pi, port 3080
bridge/server.js        HTTP + WebSocket bridge, spawns one pi RPC process per tab
bridge/mock_agent.js    fake pi agent for UI testing
web/index.html|app.js|style.css   the UI (no build step, no framework)
```

Protocol reference: [pi RPC docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md).
