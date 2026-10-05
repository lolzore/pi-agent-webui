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
| **A steady picture** | The bottom strip and the message headers are laid out so that nothing moves except the text you are waiting for. An extension's widget or status appearing, changing line count or being cleared for a frame no longer resizes the composer area (a bar that goes empty keeps its place for a moment, and it has a fixed height while it is up), the scrollbar never changes the text width (`scrollbar-gutter`), and the numbers that grow as you watch — tokens, t/s, the task total — use fixed-width digits and enough reserved room that the row cannot rewrap. The **context readout** gets the same treatment: the stats row has one fixed height, the ring is a fixed-size block rather than a baseline-aligned inline `<svg>`, and `[573.9K/1.0Mctx]` has a reserved width, so the digits ticking over while the agent works no longer nudges the ring, the label or the model and thinking pills. The **edit strip and the attachment thumbnails are deliberately *not* reserved** — they only appear because you just did something, and reserving them left a permanent invisible gap of ~100px between the status bar and the composer, with the MCP status line floating at the top of it.  The **composer has one border and no slab behind it**: the strip itself has no border and no background, so the `+`, the message box and the send button are three separate outlined boxes — the only thing that grows upward as the draft gets longer is the message box. (It had a border *and* a 2 px focus ring *around the input inside it* — two or three concentric outlines, with the `+` in a box inside a box.)|
| **Scrollbars you can actually grab** | A 15 px track with a themed 9 px thumb, instead of the 11 px one that left about four usable pixels next to the window edge. Firefox gets the thick variant too (`scrollbar-width: auto`), because it would have kept rendering the narrow bar whatever the webkit rules said. (20 px was tried first and read as a slab; the thumb's border sits inside the track, so it is 3 px a side to keep 9 px of visible thumb rather than letting it shrink to 7.) |
| **Opening a long session** | The transcript is written to the browser **as it is read** — the file is read line by line and each message goes out the moment it is parsed, instead of the whole session being read, parsed, re-serialised and only then sent. Measured on a real 70 MB session: **378 ms before the first byte → 5 ms**, and peak memory for the request drops from roughly three copies of the file to about one message. A yield between batches means a long read no longer freezes every socket on the bridge, so opening a big session during a turn no longer visibly stalls the stream. In **container mode** the same applies: `docker exec` hands over a live stdout, so the file is read as it arrives instead of being collected whole (1513 ms → 1 ms before the first byte on that 70 MB session). |
| **Pictures are fetched, not shipped** | Every picture ever pasted into or read by the agent is stored as a base64 blob inside the session file, and the transcript used to send all of them: on a real session here that was **69 of 70 MB**, to render a handful of 220-pixel thumbnails, most of them far below the fold. The transcript now *names* each picture and the bytes are fetched from `/api/session-image` only for the ones near the screen — the page already defers this (an image's `src` goes on within 1200px and comes off again past 3000px, so scrolling pulls in what you pass and releases what you leave). Nothing in the renderer changed shape, because an `<img src>` does not care whether it is a `data:` URL or an `http` one. That session's transcript is **0.8 MB instead of 69.8 MB, and opens in 150 ms**. Small pictures stay inline (no request, instant), `?inline=1` puts every byte back for a self-contained transcript, and a picture whose line has since moved (a compaction rewrote the file) answers 404 and shows a placeholder rather than a broken glyph. |
| **Smaller transfers, when it helps** | A text-dominated session is gzipped on the way out — 4.5 MB becomes 1.3 MB, and it is only done for a **real** network client and a file that is mostly text. Both halves are measured: compressing on loopback was a *loss* (a 21 MB session went 275 ms → 458 ms all of it spent compressing bytes that would arrive in a millisecond anyway), and base64 image data is already entropy, so gzipping a picture-heavy session costs 1315 ms of CPU to save 17 of 70 MB. Whether a file is pictures or text is measured by sampling a few small windows across it and averaging. |
| **The whole conversation, in one piece** | The transcript is never cut short. There used to be a cap of the newest 400 messages and a *load 812 older messages* button above the rest — and clicking it re-read the **whole** session file and re-parsed it, so reaching the top of a long conversation cost one full parse per 400 messages and a session that needed three clicks was parsed three times over. One read, one parse, all of it. The reason it was capped still holds, so it is handled differently: the rows are built in chunks with a yield between them (`scheduler.yield` where it exists), so a 3000-message session takes a few seconds to appear and the composer, the scrollbar and the buttons keep answering the whole time. |
| **A long session opens at the end of the conversation** | A transcript used to be built from the oldest message upwards, so opening a session showed the beginning of the conversation and crawled down to the newest one — and you could not switch away while it did. Now the **newest slice is rendered first** and the view is put at the bottom, which is where a conversation is read from, with the rest of the history built above it in the background while you read. Measured on the longest real session here (5441 messages): the newest messages are on screen at **~290 ms** instead of waiting for a full pass, and the whole transcript is complete a few seconds later. Nothing is dropped and nothing is fetched twice. |
| **The transcript is drawn before the agent is moved** | The transcript comes from the file, and the file is on disk - it does not wait for the agent. But the render and the file read were both queued behind `switch_session` and the `get_state` after it, which is what the remaining click-to-first-message delay was: not the work, the queueing in front of it. The session path is now set optimistically so the render can start immediately, and put back if the switch is refused. On top of that, pi's `get_messages` is no longer asked for at all when the file can answer: it is a many-megabyte reply, pi answers one request at a time, and asking on every switch meant the next click's `get_state` waited behind three abandoned 20 MB ones. **2278 ms → 222 ms** to the newest message, readable. |
| **A new session clears the old conversation** | "New session" that leaves the previous transcript on screen looks like it did nothing, and that is what it did. The cause was a fix of mine: when the file could not answer, the transcript was deliberately left alone rather than emptied for the twenty seconds pi's slow answer could take. That is right for an agent with no session at all - it reports the sessions *directory* - and wrong for a session that is simply new, whose file is there and empty. The two are now told apart: a path that is not a session file keeps the screen, an empty session file is drawn as an empty transcript. |
| **The page never sits blank waiting for the slow answer** | When the file could not answer - the agent has no session yet and reports the sessions *directory*, or its file is behind the context it holds in memory - pi's view is all there is, and it can take twenty seconds. The transcript used to be emptied and left blank for that long. Now the screen keeps the real session it was showing, and pi's answer is handed to the next load and drawn when it lands. |
| **The stop button is still red** | The rule that gives every composer control a visible edge is more specific than `.btn.stop`, so it quietly repainted the one control that does something irreversible in accent blue. It is red again. |
| **No scrollbar where there is nothing to scroll** | The status line's box was `1.6em` on a 12 px font - 19.2 px, for 4 px of padding and an 18 px line. Three pixels short, and three pixels of overflow in an `auto` box is enough for Chromium to draw a scrollbar: a 15 px bar crammed into a 19 px strip across the top of the page. It also carried `scrollbar-gutter: stable`, which reserved that strip even with nothing to scroll in it. Both are gone; the line is sized to its text and clips rather than scrolls. |
| **Slimmer scrollbars** | 20 px, then 15 px, both read as a slab and a 9 px thumb on a 15 px track was still "way too big". Now 12 px with a 6 px thumb - the narrowest track that is still comfortable to grab one-handed - and Chromium's scrollbar arrows are suppressed, since no other browser draws them and they turn a slim track into a control. |
| **The context counter is just as long as its text** | This went round three times. It held a reserved width, so nothing beside it moved as the digits changed - and left a hole in front of the counter, as wide as the widest label it would ever hold, empty almost all of the time. It was then padded to a fixed width, which moved the hole *inside* it: three stray spaces around the `/` and more before `ctx`, which looked like a mistake. (Padding with ordinary spaces also fails outright at the end of a line, where they are not rendered at all: 6 px instead of 110 px.) So it is left alone - no reservation, no padding, numbers as they are - in tabular figures, so the digits keep their columns and a number only changes length when it crosses a unit, which happens once in a while rather than several times a second. |
| **The chosen font is the font of the whole window** | It was set on the transcript and the composer only, so the sidebar - the thing being read the whole time - the menus, the settings dialog and every button kept the system face: one window, two typefaces, with the chosen one on the smallest part of it. Two things caused it. Form controls do not inherit `font-family`; it is not one of the properties they take from their parent. And `dialog` named the system face outright in a `font` shorthand, so every dialog - settings, setup, crop, confirm - was in a different typeface from the rest of the page. The font is now the body font, so it reaches everything; monospace is left alone wherever it is asked for, because code, tool output, diffs and the numeric counters are read by shape and position. |
| **History fills in upward and the reader stays at the bottom** | A long session is drawn newest-first, so it should grow *upward* and leave the newest message - the one being read - where it is. But each batch was inserted above without re-pinning, so the reader was left looking at the same part of the document while it grew beneath them: the transcript appeared to fill in from the top downwards, which reads as the page still loading. Every batch re-pins now, and the view is pinned once more when the history completes, which also cleared a twenty-odd pixel gap under the newest message that `restoreReading` left a frame later. A reader who has deliberately scrolled up is left alone. |
| **The sidebar and the confirmation answer the click at once** | Two things held them back, and the second was found only after fixing the first. The highlight and the "Session switched" toast waited for `initSession`, which is eleven refreshes deep - models, levels, commands, the session list, the stats, the transcript. Moving them ahead of that was not enough: they were still behind `switch_session`, which costs pi a second and a half on a long session, so the sidebar sat showing the old session as active and the toast arrived a second and a half later, both trailing a transcript that had already drawn. Neither depends on the agent at all - the path is already set and the view is already drawn from the file - so both now fire on the click, **1689 ms → 0 ms**. The highlight also stopped rebuilding the whole sidebar to move one class: `syncSessionHighlight` threw every row, folder and fork arrow away and built them again, which on a few dozen sessions is the difference between the highlight arriving with the click and arriving a beat later. It walks the rows and moves the class now, using the same rule `renderSessions` uses, so the two cannot disagree about where the blue edge is. |
| **The queue sits with the composer** | What you have queued to send was the first thing in the dock, which put it above the status and widget lines *and* the composer and the stats row - a row about your own messages parked at the far end of everything else. It now sits directly above the box you queue it in. |
| **A session switch does the cheap things first** | Switching a session was a chain of eleven awaits, in a row: the fork list, the model list, the levels, the commands, the session list, the stats, and the transcript somewhere in the middle. On a long session that was **3.5 seconds**, of which 1.9 was `refreshForkable` — a right-click feature that shows nothing until you right-click a message — sitting in front of the transcript, and half a second more was waiting for the agent to move into the session before it would even start reading the file it was about to read anyway. The fork list now runs alongside the transcript and is shared rather than fetched twice; everything independent of the transcript runs in parallel; and the file read starts *while* the agent is being switched, because the file is on disk and does not wait for anything. Measured: the page answers in 20 ms, the transcript request starts at 3 ms, the file is down at 55 ms, the newest messages are readable at ~500 ms and the whole transcript is in place at ~1.1 s. |
| **Switching sessions is immediate** | Every load of the transcript takes a number, and a load that is superseded stops at its next yield instead of carrying on. Previously two renders interleaved and fought over the same element, so the session you asked for lost the race against the one you were leaving and you had to wait for it. The request itself is cancelled too, so a session you switched away from stops pulling bytes — and a cancelled load is not reported as an error, because "you asked for something else" is not a failure. |
| **Sending a message does not rebuild the conversation** | The end of a turn re-read the whole session file and rebuilt every message from scratch, which on a long session is the transcript jumping up and then slowly coming back down. It now only re-reads when the turn was genuinely never finalised (the case the re-read exists for); an ordinary turn leaves the DOM alone. |
| **Jump to the top** | A round ↑ above the composer, on the right, that appears as soon as you are far enough from the top for it to be worth having and disappears again when you get there. It lands on message 1, not on "near the top" — and if a render is still in flight it waits for it, because the rows that arrive after the scroll would otherwise push the top away again. |
| **/reload** | pi's own `/reload`, implemented in the WebUI: re-reads **extensions, skills, prompt templates, keybindings and themes** from disk. It is a TUI command and RPC mode has no call for it, so the agent is restarted — the same mechanism a changed model or a new `/login` already used — and the bridge resumes the session you were in before the new agent answers anything, so nothing is lost. Type `/reload` in the composer, or press the **/reload** button in Settings → General (it refuses to run mid-turn, and the button shows the progress). Commands, models and thinking levels are re-read afterwards, so a newly installed extension is usable immediately. |
| **Compaction** | `/compact` (or the ring) compacts the session. Right after a compaction the ring and label show `–` instead of a number, because the agent reports no context size until the next LLM response. |
| **Upload images and files** | 📎 button or drag & drop anywhere; images go as base64 image blocks on the `prompt` command, everything else travels as a path reference the agent can open with its tools. Anything over 8 MB is streamed to the bridge as a raw body instead of base64 (a 9 MB video used to arrive truncated, which is what produced *"data (base64) is required"*), the same file uploaded twice is stored once (the bridge keeps a hash index), and a file that is too big to attach but looks like a wallpaper becomes your background instead of an error. A picture waiting in the composer is a button: click it to see it full size, click off it (or press Esc) to close. |
| **Paste images from clipboard** | Ctrl+V an image anywhere on the page — it becomes an attachment preview above the composer. |
| **Editing session text** | Hover a user message → ✏️. The text loads into the composer; sending uses pi's `fork` RPC to branch the session from that exact message and prompts with your edited text. |
| **Switching sessions** | Sidebar lists all sessions found in the pi session dir (from `/api/sessions`); click to `switch_session`, filter box, ⟳ refresh, `+ New` starts a new session, click the title bar name to rename (`set_session_name`). |
| **Voice to text** | 🎙 button uses the browser's own speech recognition by default (Chrome/Edge; `localhost` is a secure context, so no HTTPS needed) — nothing to download. A local whisper.cpp server is the opt-in alternative: pick a model (Tiny 75 MB / Base 142 MB / Small 466 MB / Large v3 multilingual 3.1 GB, each with a note on speed vs accuracy; the list is fetched even while browser voice is selected, so the choice is there when you switch) and clicking the mic starts it automatically with the selected model — first use downloads it, *download & start* in settings does it up front. The download is verified: the binary zip and every model are checked against their published SHA-256 for a pinned revision, and a file that does not match is deleted rather than run. If it cannot start, browser voice takes over. Speech fills the composer — review, then send manually, or enable **auto-send** (settings ⚙ or `/autosend`) for hands-free sending. |
| **TTS for agent output** | `TTS` toggle in the header (or `/tts`) auto-speaks every assistant reply; every assistant message also has a 🔊 button. Voices can be the browser's own (`speechSynthesis`, pick the Windows voice and rate in settings ⚙ with a test button), a local endpoint, or a **cloud voice** — fish-audio or any OpenAI-compatible `/v1/audio/speech` server. Cloud speech goes through the bridge (`POST /api/tts`), so there is no CORS to fight and the API key stays in the bridge's settings instead of the page. Esc stops playback. |
| **Agent identity** | Rename the agent and give it a profile image in settings ⚙ — both show next to its messages, and the image also sits top-left in the sidebar. There is no built-in placeholder: with no image set, only the name shows, and **clear** removes it everywhere. The image can be a still, a GIF or a video, and either can be **cropped by hand** (settings → crop…: the whole picture is shown with the crop frame over it, so you can see what you are cutting off — drag to move, scroll or the slider to zoom, and the dimmed area is what goes away). Its size is adjustable too. A **video** picture animates in the sidebar and in the transcript, kept on one shared frame so a group of them does not drift apart. **Animated avatars** (Settings → General) says how far back, and the slider runs **none of them** → 1 … 8 → **all of them** — the last with no hidden ceiling behind it, the numbers a limit for a transcript with more messages than the machine wants decoders for. Either way the whole group pauses while the tab is in the background, and older messages fall back to a still frame captured from the clip once. |
| **The running-session dot** | The green pulsing dot next to a session in the sidebar is a fixed-size flex item with room for its halo, so a long session name cannot squeeze it into a sliver — which is what made the dot and the fold arrow look squished together. |
| **Readable over anything** | Chat text is outlined (a 1px shadow around every glyph) so it stays legible when the panels are translucent and a background image or video shows through — the outline colour comes from settings, and it can be switched off. **Chatbox transparency** fades the composer, sidebar, message bubbles, tool cards, bash/system output, code blocks and the model/thinking controls together, with a real backdrop blur behind them, and **background transparency** fades the image/GIF/video on its own (a bright photo is often too much at full strength even with the panels clear). Backgrounds get the same manual crop as the profile image and are exempt from the attachment size limit (a background is only ever shown, never sent to the model), and a background **video's audio** can be played with its own volume — the browser only allows sound after you have clicked the page once, so it starts on the first click. |
| **Seeing a picture the agent read** | When the agent reads an image, the whole thing is in the session file as a base64 block — and it used to be flattened to the text `[image image/png]`, so the only trace that a picture had been looked at was a placeholder. The image is now kept where the result is written, behind a small **eye**: a 30px thumbnail with the eye on it, sized and typed in the tooltip, and a click opens it full size (click off it, or Esc, to close — the same viewer a message image uses). Works for a run happening now and for one reloaded from the file. |
| **Typing** | Optional **type anywhere**: with it on, any keystroke while the window is focused lands in the composer without clicking it first. |
| **Pi extensions integration** | Full `extension_ui_request` sub-protocol in the browser: `select`/`confirm`/`input`/`editor` dialogs become native modals, `notify` → toasts, `setStatus`/`setWidget` → status & widget bars above the composer, `setTitle` → tab title, `set_editor_text` → composer. Extension-registered slash commands appear in the `/` menu. |

| **Instances** | The agent's face at the top of the sidebar is the switcher: it lists the pi agents you use — this one plus any others you add (another machine, another port) — each with its own picture and a green pulsing dot while that agent is working. Picking one **keeps you on this page**: the local bridge fetches for you (`/proxy/<origin>/…`, WebSocket included), so sessions, chat, models **and the agent socket** are that machine's — a new session, a prompt or a fork all happen over there. What you look at is that instance's: its **agent name, picture and background** (its picture and background are served by *its* bridge, through the proxy, so they actually load) and its own **session folders** (folders are kept per instance, because a folder of this machine's session paths means nothing over there). What stays yours is how the UI behaves: theme colour, text size, transparency, notifications, the Instances list, the network switch and the voice backend. If that host is off you get a banner saying so and a way back, instead of a dead end. Right-click an instance to remove it from the list or open its own page. |
| **Forks in the session list** | A forked branch is a row under the session it came from, with a branch marker, and any session that has forks gets a small **▾** in front of its name: click it to fold the branches away, click again to bring them back (the fold is remembered per browser). Searching still finds a folded branch. A fork whose parent was deleted stays listed — otherwise it would not be reachable at all. Children that are not sessions (a subagent's run transcript) stay out of the list entirely. |
| **Session folders** | Right-click the session list for **new folder…**, then drag sessions onto it (drag a folder onto another to change their order, drop a session on the empty part of the list to take it out). Click a folder to fold it, right-click it to rename, empty or delete it. **Dropping a session into a folded folder leaves it folded** — the count badge moves and a line at the bottom confirms where it went, rather than the folder springing open and the session you had just filed vanishing into a list you were not looking at. Folders live in the bridge's settings, so every browser and machine sees the same ones. |
| **Sub-agents** | When the pi-subagents extension runs child agents, a **sub-agents** button appears in the top bar — and only on the session those runs came from, so a session that never used one does not show it. The panel lists each run with what it is doing *now*: state, the tool it is on and how long it has been there, turns, tools, tokens and how long it has been running, counting up live (finished ones read *took 20s*) — read from the run's own `status.json`, so it keeps ticking even while the parent sits idle waiting for it, and a reload brings the list back instead of emptying it. Clicking a run opens **the session the child ran in**, read-only, in the same chat — its messages, tool calls and results — with the panel and a *back to the conversation* button always one click away; a live child is followed as it grows. Runs that have no session of their own fall back to the transcript artifact. The raw `PI_SUBAGENT_ASYNC_JSON` widget line is never printed into the UI. |
| **Notifications and errors** | 🔔 in the top bar keeps what the toasts drop: every notification and every error with the time it happened, click a row to copy its details, and the bell keeps a mark until you look. A page error no longer disappears into the console. |
| **When the agent finishes** | A turn can end while you are looking at another window. Settings → General: play a sound, show a desktop notification, and "only when this window is not focused" (on by default). The sound is the built-in two-note chime until you pick your own — **upload…** any mp3 / wav / ogg / m4a, or paste a URL, and it plays that instead (the file is stored next to your other uploads, so nothing large lands in the browser's storage and nothing is ever sent to a model). **test** plays whatever is set right now, **clear** goes back to the chime, and a sound that cannot be loaded says so instead of failing silently, then falls back to the chime. |
| **Custom cursor** | Settings → Appearance: your own pointer picture, a size, and the hotspot (which pixel of the picture is the real pointer tip, almost always the top-left corner at 0, 0). The picture is **redrawn at the size you pick and written out as a PNG** before it goes into the CSS, because a browser drops a cursor it cannot use and says nothing at all while it does — `cursor: url()` never scales, anything over 128×128 is ignored (cursor packs ship 256 and 512 px as a matter of course), a format that opens as a picture is not automatically usable as a cursor, and a hotspot past the edge kills the whole declaration. None of that is observable from JavaScript — `getComputedStyle` reports the `url()` in every one of those cases — so it is normalised rather than detected, which also makes the size slider do something for the first time. Non-square sprites are letterboxed, not cropped, and the hotspot is scaled to match. A picture that will not load at all is reported under the field and the pointer is left at the normal one. (.cur and .ico are not offered: no browser will draw those from CSS.) | Text fields keep the browser's I-beam so typing still reads as typing.
| **Not a resource hog** | The page used to keep working while nothing was happening, and that is the part that is hardest to notice. Now: the tab icon is painted **once** (it was a 64×64 canvas PNG-encoded four times a second for an animated avatar, plus a `<video>` left in the document decoding frames nobody could see — a favicon is one image to every browser, so nobody saw a thing); the frosted-glass `backdrop-filter` only exists while the panels are actually translucent (at full opacity it asked for `blur(0px)` and still made the browser composite a backdrop snapshot for every bubble and tool card in the transcript); the video decoders, the 1-second ticker and the background clip all **stop when the tab is in the background**; the streamer repaints at 12 fps instead of every animation frame (it re-parses the whole message so far on each pass and forces a synchronous layout at the end — 600 deltas went from 600 markdown re-parses to 35); the sidebar is only rebuilt when a session's name, size or time actually changed instead of every 20 seconds; and the number of messages with a moving profile picture is a setting (**Animated avatars**, 0–8, 4 by default) because each one is a live video decoder. A turn that ended while you read something else also could not take the whole bridge down any more: writing to an agent that was on its way out raised an unhandled `EPIPE` and killed the agent, every other tab and the WebSocket with it. |
| **Looking at another session** | The bar under the top bar that says the agent is still running in its own session is a real box: an opaque accent-tinted fill, a 1 px inset outline and an accent bar down its left edge, and its text follows the **outline** setting like the chat text does. It used to be accent-coloured text on a 12 %-alpha wash with nothing around it, which is unreadable over a conversation you are trying to read past. |
| **Gamer mode** | Settings → Appearance: the theme colour drifts through the rainbow, with a slider for how fast (4–60 s per cycle, 16 s by default). The colour advances by elapsed time rather than by animation frame, so it keeps its speed on a busy page or a slow machine, changing the speed continues from where the colour is, and oklch keeps the perceived speed even. Every accent-coloured thing follows it — scrollbars and the text highlight included. It also stops dead while the tab is in the background, and picks the cycle up where it was on return. |
| **Mobile and narrow windows** | Under 760px the sidebar becomes a drawer over the chat (☰ opens it, tapping the conversation closes it), the topbar wraps instead of squeezing the session name between buttons, the stats row wraps instead of overlapping, and dialogs go edge to edge. Anything tappable gets a real touch target. |
| **Local models on the network** | If you run llama.cpp servers, the WebUI finds them: settings → Pi providers lists the ones it knows about, and the bridge scans for more — the configured URL, `localhost`, this machine's own LAN addresses, then a background sweep of the local /24 on the usual ports (8080/8081), skipping virtual adapters. A banner offers a server it found; dismissing it is remembered, and the sweep can be switched off with `PI_LLAMA_SCAN=off`. |
| **Settings that cannot be lost** | The bridge keeps the settings in one JSON file and **replaces** it with what a page posts, so the page now refuses to save before it has read the server's copy — a slow or failed first load used to leave a browser on its defaults and then write those over everything (avatar, background, folders). For the same reason the first-run dialog only appears once the settings really loaded, retrying once. |
| **Coming back after a restart** | The bridge remembers the session *this WebUI* was in and resumes it when it starts the agent, so restarting the bridge and reloading puts you back where you were. That record is its own file (`webui-last-session-<source>.json` in the agent dir) — the WebUI no longer reads `last-session-native.json`, which belongs to pi's own CLI, because sharing it meant restarting the bridge resumed whatever session the terminal had used last. A record whose session is gone is dropped before the agent is asked about it — that used to be a failed switch and, with a pi that does not answer, a wedged agent that had to be restarted. A browser that has been here before also keeps its own copy and switches back by itself. |
| **Right-click menus** | On a session: open, **export…** (a real "save where you want" dialog), **branches…** (jump to a fork point) and **delete…** (asks first). On a message: **fork from here** — starts a new branch at that turn — plus copy and speak. Same look as the model picker. |
| **Model & thinking pickers** | The model list is searchable and scrolls, however many you have. The list of **thinking levels belongs to the model**, and it is re-read the moment the model actually changes — from the picker, from `/model`, from the llama.cpp fix, or by the agent switching by itself. Before, a switch left the previous model's levels in the menu: a model with no reasoning kept a full ladder of levels that all failed, and a model with the ladder offered only `off`. pi can still be applying a `set_model` when that call returns, so the list is read again a moment later, and dropped if the model changed again in between. |

Extras: streaming markdown rendering (code blocks, thinking collapse, live tool-call cards), session stats (context %, cost, tokens/sec that stay on screen after the turn ends), queue display with steer/follow-up, Esc to clear-queue + abort, agent crash banner with one-click restart.

## Run it

> The WebUI uses **http://localhost:3080**.

There are three ways in: the **browser UI** (`start-webui.bat`), the same UI in **its own window** with no build step (`start-app-window.bat`, Edge/Chrome app mode), or the **native Windows app** (`start-app.bat`, source in `pi-desktop/`).

The first time you open the UI it asks a handful of things worth deciding up front — the agent's name and picture, theme colour (and gamer mode), chat text size, background, whether to play a sound or show a desktop notification when the agent finishes, voice auto-send, the Shorts feed and whether other devices on your network may open it. Everything there is also in ⚙ Settings, and the dialog never comes back once you press *Let's go* (or *skip*).

### Choosing the agent source (first run)

`start-webui.bat` asks once whether your pi agent runs natively on Windows or in a Docker container, and (for Docker) lists your containers so you pick the right one — no name hardcoded. The answer is saved to `bridge/agent-source.txt` and reused afterwards. Run `switch_pi_agent_source.bat` at any time to erase that choice and pick again.

### Attaching to a pi agent that already runs in a container (recommended)

If your pi agent already lives in a Docker container, point the bridge at that instead of installing pi twice. pi's RPC protocol is stdio-only — it cannot be reached over the network — so the bridge attaches with `docker exec -i`:

```powershell
start-webui.bat        # asks once and remembers the answer, or manually:
cd bridge
set PI_COMMAND=docker exec -i <your-pi-container> pi --mode rpc
set PI_SESSION_DIR=docker:<your-pi-container>:/root/.pi/agent/sessions
set PORT=3080
npm install && npm start
```

Replace `<your-pi-container>` with the container your agent runs in (`docker ps` lists them, and `start-webui.bat` offers the list on first run). The agent keeps everything (model config, API endpoints, extensions, MCP servers, sessions) inside its own container — the bridge only shuttles JSON. Session listing, switching, and forking work against the container's `~/.pi/agent/sessions` via the `docker:<container>:<path>` form of `PI_SESSION_DIR`. Extension commands (`/subagents`, `/mcp`, `/council`, …) and extension UI events (MCP status bar, widgets, dialogs) come straight from your agent. The container has to be running: `docker start <your-pi-container>`.


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

## Verifying a change

```bash
./verify-matrix.sh              # host: syntax, unit, integration, real browser
./verify-matrix.sh --docker     # the above, then the image from docker-compose.yml
```

Five layers, each able to fail on its own:

| Layer | What it checks | Tool |
|---|---|---|
| 1. syntax | plain JS parses | `node --check` |
| 1. syntax | the React Native sources parse (they contain JSX) | `@babel/parser` |
| 1. lint | undefined identifiers, hooks called conditionally or in a loop | `eslint` |
| 2. unit | `sessionLines` returns a real JSONL file unchanged and in order, and stays lazy | `verify/test-session-lines.js` |
| 2. unit | the atomic JSON write is whole, leaves no temp file, and cannot destroy the previous file | `verify/test-atomic-write.js` |
| 3. integration | a live bridge: the session list, the messages, the raw JSONL, path traversal | `verify/test-endpoints.js` |
| 3. browser | the real page in headless Chrome/Edge: it boots, sessions render, no console errors | `verify/test-browser.js` |
| 4. docker | the same, against the built image | `verify/test-endpoints-container.js` |

The unit checks extract the real function out of `bridge/server.js` rather than
testing a copy, so they cannot pass while the shipped code is broken.

Two notes on why some checks are not `node --check`:

- `node --check` reports **exit 0** for a `.js` file containing JSX *and* an
  unclosed `memo(` wrapper. A file that fails to parse as CommonJS gets retried
  as an ES module and the error is swallowed. That is why the React Native files
  go through `@babel/parser`.
- A parser cannot see an identifier that is used but never defined, which is what
  a half-finished edit leaves behind. That is what the ESLint pass is for.

If Docker cannot reach the registry, the image build is reported as skipped
rather than failed — the other layers still run, and the container checks use
whatever image is already present.
