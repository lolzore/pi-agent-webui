#!/usr/bin/env bash
# Pi Agent WebUI — full verification matrix.
#
#   1. syntax       every JS file parses
#   2. unit         sessionLines over a real JSONL file (multi-byte chars on read
#                   boundaries, order, laziness); the atomic JSON write; the
#                   ?dir= path validator (genuine run dir readable, ".." refused).
#                   PI_TEST_CONTAINER=<ctr> additionally plants the two injection
#                   payloads and proves neither executes.#   3. integration  a live bridge + a real session file: the session list the
#                   sidebar renders, the messages the transcript renders, the raw
#                   JSONL download, the page and its assets
#   4. docker       the same integration checks inside the image from
#                   docker-compose.yml, plus the container-facing code paths
#                   (the two injections, and docker: session mode end to end)
#                   against a throwaway container from the same image.
#
# Every check runs the shipped source: the unit checks extract the real function
# out of bridge/server.js rather than testing a copy.
#
# Usage:  ./verify-matrix.sh            (host only)
#         ./verify-matrix.sh --docker   (host, then build + run in the image)
set -uo pipefail

# ── a note on the environment ────────────────────────────────────────────
# The suite invokes `node` with POSIX-style paths (<project>/verify/...), which
# Git Bash translates for native programs. MSYS_NO_PATHCONV=1 in the caller's
# environment disables that translation, and then every test script path fails
# to resolve:
#
#     node:internal/modules/cjs/loader:1503   throw err;   ^
#
# which reads as broken code rather than a broken invocation, and cost a real
# investigation. Clearing it here means the suite behaves the same however it
# is called. (MSYS2_ARG_CONV_EXCL does the same thing on some setups.)
unset MSYS_NO_PATHCONV
unset MSYS2_ARG_CONV_EXCL

cd "$(dirname "$0")"
ROOT=$(pwd)
# Scratch lives inside the repo: node on Windows resolves a POSIX /tmp against
# the current drive, so files written by curl and read by node can disagree.
#
# One directory per run, named with the pid. It used to be a single fixed path,
# and the browser check below launches Edge - a process that can outlive the run
# and still hold files in it. The next run's `rm -rf` then failed, the directory
# kept whatever was left, and node came back with "Cannot find module" instead of
# a test result. The symptom was that the *second* run in a row failed while the
# first passed, which is the worst way for a suite to be unreliable. A unique
# name means a stale process can only damage its own run's leftovers.
TMP="$ROOT/.verify-tmp.$$"
rm -rf "$TMP" 2>/dev/null || true
mkdir -p "$TMP"
# and sweep directories from runs that died more than an hour ago
find "$ROOT" -maxdepth 1 -name '.verify-tmp.*' -mmin +60 -exec rm -rf {} + 2>/dev/null || true
SESSION_DIR="$TMP/sessions"
V="$ROOT/verify"

PORT=${BRIDGE_PORT:-3999}
PASS=0; FAIL=0; SKIP=0
RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'

ok()    { PASS=$((PASS+1)); printf '  %sPASS%s %s\n' "$GRN" "$RST" "$1"; }
bad()   { FAIL=$((FAIL+1)); printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"
          if [ -s "$TMP/err.txt" ]; then
            printf '       %s%s%s\n' "$DIM" "$(head -4 "$TMP/err.txt" | tr '\n' ' ')" "$RST"
          fi
          return 0; }
skip()  { SKIP=$((SKIP+1)); printf '  %sSKIP%s %s\n' "$YEL" "$RST" "$1"; }
head_() { printf '\n%s== %s ==%s\n' "$DIM" "$1" "$RST"; }
note()  { printf '       %s%s%s\n' "$DIM" "$1" "$RST"; }
# run <label> <cmd...> : pass/fail on the exit code, never on a text marker.
run()  { local label=$1; shift; : >"$TMP/err.txt"
         if out=$("$@" 2>"$TMP/err.txt"); then ok "$label${out:+ ($out)}"
         else bad "$label"; fi; }

# ───────────────────────────── 1. syntax ─────────────────────────────
head_ "1. syntax"
# Plain JS: node --check is the right tool.
for f in bridge/server.js web/app.js bridge/mock_agent.js verify/*.js; do
  [ -f "$f" ] || continue
  run "$f parses" node --check "$f"
done
# React Native sources: these contain JSX, and `node --check` is worse than
# useless on them — it reported exit 0 for a file with JSX *and* an unclosed
# memo( wrapper, because a .js file that fails as CommonJS gets retried as an ES
# module and the error is swallowed. A check that cannot fail is not a check, so
# these go through the project's own @babel/parser instead.
#
# Both report 77 when their tooling is not installed, which is a SKIP: on a
# machine that has not built the desktop app, pi-desktop/node_modules is absent,
# and that is not a defect in the code. The CI installs the four packages they
# need and points PI_RN_MODULES at them, so there they really do run.
skip_ok() {
  local label=$1; shift
  local out rc
  out=$("$@" 2>&1); rc=$?
  if [ "$rc" = "0" ]; then ok "$label"
  elif [ "$rc" = "77" ]; then skip "$label"
  else
    printf '  %sFAIL%s %s\n' "$RED" "$RST" "$label"
    # The *first* lines, not the last: node puts the diagnosis ("Cannot find
    # module 'x'") at the top and the stack frames underneath, so tail was
    # showing the frames and hiding the answer.
    printf '       %s%s%s\n' "$DIM" "$(printf '%s' "$out" | grep -aE 'Error|Cannot find|not installed|\[ERR_' | head -2 | tr '\n' ' ')" "$RST"
    printf '       %s%s%s\n' "$DIM" "$(printf '%s' "$out" | head -2 | tr '\n' ' ')" "$RST"
    FAIL=$((FAIL+1))
  fi
}
skip_ok "pi-desktop/*.js parses (JSX, via @babel/parser)" \
    node "$V/test-parse-rn.js" pi-desktop/App.js pi-desktop/src/*.js
# A parser cannot see an identifier that is used but never defined, and neither
# can `node --check`. Two of the bugs this caught were exactly that: a call to a
# helper that had been deleted, and a useMemo placed after an early return (which
# fails on the second render, on a device, not at build time).
skip_ok "pi-desktop/*.js lint (no-undef, rules-of-hooks, …)" \
    node "$V/test-lint-rn.js" pi-desktop/App.js pi-desktop/src/*.js

# ───────────────────────── 2. unit ─────────────────────────
head_ "2. unit"

# Big enough to span many 256 KB reads, with multi-byte characters on every
# line: a naive chunk split corrupts exactly here, and the symptom is a session
# that silently fails to open in the browser.
if SESSION_DIR="$SESSION_DIR" node -e '
const fs=require("fs"),path=require("path");
const dir=process.env.SESSION_DIR; fs.mkdirSync(dir,{recursive:true});
const L=[JSON.stringify({type:"session",version:1,sessionFile:path.join(dir,"verify.jsonl")})];
for(let i=0;i<6000;i++) L.push(JSON.stringify({type:"message",id:"m"+i,role:i%2?"assistant":"user",
  content:[{type:"text",text:"line "+i+" "+"π✓漢".repeat(40)}]}));
fs.writeFileSync(path.join(dir,"verify.jsonl"),L.join("\n")+"\n");
' 2>"$TMP/err.txt"; then
  ok "built verify.jsonl (6001 lines, multi-byte on every line)"
else bad "built verify.jsonl"; fi

run "sessionLines: byte-identical, in order, all valid JSON, lazy" \
    node "$V/test-session-lines.js" bridge/server.js "$SESSION_DIR/verify.jsonl"

run "writeJsonAtomic: whole file, no litter, failure-safe" \
    node "$V/test-atomic-write.js" bridge/server.js

# The ?dir= hole needs no container, so this one always runs. 77 means the test
# could not build its fixture, which is a skip and not a pass.
if out=$(node "$V/test-run-dir.js" 2>"$TMP/err.txt"); then
  ok "run-dir validation: genuine run dir readable, '..' and metacharacters refused ($(printf '%s' "$out" | tail -1))"
else
  rc=$?
  if [ "$rc" = "77" ]; then skip "run-dir validation (no fixture available)"
  else bad "run-dir validation: genuine run dir readable, '..' and metacharacters refused"; fi
fi

# The two injection holes both needed a container to be reachable, so this is
# only checked when one is named. It plants a real payload - a session file whose
# NAME breaks out of a shell quote - and asserts on side effects rather than on
# the shape of the response.
if [ -n "${PI_TEST_CONTAINER:-}" ]; then
  if out=$(PI_TEST_CONTAINER="$PI_TEST_CONTAINER" node "$V/test-injection.js" 2>"$TMP/err.txt"); then
    ok "injection: session-name and ?dir= payloads do not execute, feature intact ($(printf '%s' "$out" | tail -1))"
  else
    rc=$?
    if [ "$rc" = "77" ]; then skip "injection (container unavailable)"
    else bad "injection: session-name and ?dir= payloads do not execute, feature intact"; fi
  fi
else
  skip "injection (set PI_TEST_CONTAINER=<running container> to check it)"
fi

# ───────────────────── 3. integration (live bridge) ─────────────────────
head_ "3. integration — live bridge on :$PORT"

# This suite owns two ports, and a bridge from an interrupted run keeps them: it
# answers /api/health exactly like the one about to start, so without clearing it
# the suite silently tests the PREVIOUS run's bridge, with that run's environment,
# and every failure looks like a bug in the code. Found the hard way - a stale
# bridge on the second port meant the extensions checks ran against the real
# ~/.pi/agent instead of the scratch one.
#
# Killed by PORT, never by a pattern over process command lines. The ports here are
# this suite's own; nothing else uses them. (A pattern is how I once killed the
# running bridge on :3080 - its command line is just `node bridge/server.js`, so
# "every node running server.js" includes the one the user is actually using.)
port_pid() {
  netstat -ano 2>/dev/null | grep LISTENING | grep ":$1 " | awk '{print $5}' | head -1
}
kill_port() {
  local pid
  pid=$(port_pid "$1")
  [ -n "$pid" ] || return 0
  if command -v taskkill >/dev/null 2>&1; then taskkill //F //PID "$pid" >/dev/null 2>&1 || true
  else kill "$pid" 2>/dev/null || true; fi
  sleep 0.5
}
clear_leftover() {
  local pid
  pid=$(port_pid "$1")
  [ -n "$pid" ] || return 0
  printf '%s\n' "  ${YEL}note${RST} clearing a leftover listener on :$1 (pid $pid) from an earlier run"
  kill_port "$1"
}

# Before anything starts, not after: this has to run BEFORE the bridge below, and
# it did once sit in the next section instead - where it killed the bridge that had
# just started, and the failure looked like a session-list bug.
clear_leftover "$PORT"
clear_leftover "$((PORT + 1))"

PI_SESSION_DIR="$SESSION_DIR" \
PI_WEBUI_SETTINGS="$TMP/settings.json" \
PI_WEBUI_LAST_SESSION="$TMP/last.json" \
PORT=$PORT \
  node bridge/server.js >"$TMP/bridge.log" 2>&1 &
BRIDGE_PID=$!
trap 'kill_port "$PORT"; kill_port "$((PORT + 1))"' EXIT

up=0
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && { up=1; break; }
  sleep 0.2
done
if [ "$up" = 1 ]; then
  ok "bridge is up"
else
  bad "bridge is up"; head -20 "$TMP/bridge.log" | sed 's/^/       /'
  printf '\n%d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"; exit 1
fi

# ─────────────── a second bridge for the extensions tab (#46) ───────────────
# Those endpoints WRITE settings.json and DELETE files, so this bridge is pointed
# at a scratch agent dir and never at the real ~/.pi/agent. The fixture is
# synthesised rather than copied, so it behaves the same on CI.

EXT_DIR="$TMP/agent"
mkdir -p "$EXT_DIR/extensions" "$EXT_DIR/skills/fixture-skill/reference" "$TMP/workspace"
printf 'export default () => {};\n' > "$EXT_DIR/extensions/fixture-ext.ts"
printf '# Fixture skill\n' > "$EXT_DIR/skills/fixture-skill/SKILL.md"
printf 'nested\n' > "$EXT_DIR/skills/fixture-skill/reference/notes.md"
printf '# project context\n' > "$TMP/workspace/AGENTS.md"
cat > "$EXT_DIR/settings.json" <<'JSON'
{
  "defaultModel": "fixture-model",
  "packages": ["npm:pi-subagents", { "source": "npm:pi-web-access", "extensions": ["-index.ts"] }]
}
JSON
# PI_COMMAND matters more here than anywhere else: without it the bridge spawns the
# real pi, and a real pi pointed at a scratch agent dir whose settings.json lists
# packages INSTALLS them - it created npm/, pi-subagents/, auth.json and
# models-store.json in the fixture and removed the files this check needs. No agent
# is involved in any of these checks, so it gets the mock.
#
# NOTE for anyone editing this: no comment may go inside the line-continued
# assignment list below. A line that is entirely a comment ENDS the command, so the
# rest of the list runs as a separate command - which is exactly how this ran
# against the real ~/.pi/agent once, with PI_AGENT_DIR silently dropped.
PI_AGENT_DIR="$EXT_DIR" \
WORKSPACE_DIR="$TMP/workspace" \
PI_SESSION_DIR="$SESSION_DIR" \
PI_WEBUI_SETTINGS="$TMP/settings-ext.json" \
PI_WEBUI_LAST_SESSION="$TMP/last-ext.json" \
PI_COMMAND="node $ROOT/bridge/mock_agent.js" \
PORT=$((PORT + 1)) \
  node bridge/server.js >"$TMP/bridge-ext.log" 2>&1 &
EXT_BRIDGE_PID=$!
trap 'kill_port "$PORT"; kill_port "$((PORT + 1))"' EXIT
ext_up=0
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$((PORT + 1))/api/health" >/dev/null 2>&1 && { ext_up=1; break; }
  sleep 0.2
done
if [ "$ext_up" = 1 ]; then
  ok "second bridge for the extensions tab is up (agent dir: $EXT_DIR)"
else
  bad "second bridge for the extensions tab is up"; head -20 "$TMP/bridge-ext.log" | sed 's/^/       /'
fi

# The path comes from the bridge's own answer, not from a guess about where it
# put the file — that mismatch is what makes a test lie about passing.
SPATH=$(node -e '
const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
process.stdout.write(d.sessions[0].path);
' "$TMP/sessions.json" 2>/dev/null)
curl -s -o "$TMP/sessions.json" "http://127.0.0.1:$PORT/api/sessions"
SPATH=$(node -e '
const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
if(!d.sessions||!d.sessions.length) process.exit(1);
process.stdout.write(d.sessions[0].path);
' "$TMP/sessions.json" 2>/dev/null)

if [ -n "$SPATH" ]; then
  run "endpoints: page, assets, session list, messages, raw JSONL, traversal" \
      node "$V/test-endpoints.js" "http://127.0.0.1:$PORT" "$SPATH"

  # The layer that can catch a mistake in web/app.js: a real browser, a real
  # console. Everything above it can pass while the transcript renders nothing.
  BROWSER=""
  # Windows (Git Bash) first, then whatever the platform puts on PATH, so the
  # browser-driven checks also run on Linux - which is where CI would run them,
  # and previously they would have silently SKIPped there.
  for cand in \
    "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
    "/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
    "/c/Program Files/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"; do
    [ -f "$cand" ] && { BROWSER="$cand"; break; }
  done
  if [ -z "$BROWSER" ]; then
    for cand in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge microsoft-edge-stable; do
      if command -v "$cand" >/dev/null 2>&1; then BROWSER=$(command -v "$cand"); break; fi
    done
  fi
  if [ -n "$BROWSER" ]; then
    run "browser: page boots, sessions render, no console errors" \
        node "$V/test-browser.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # Issue #2: the context label moved 2px while the numbers were unchanged,
    # because the element was rewritten (and so re-shaped) on every poll. This
    # asserts the cause - the text node is reused when the value is the same - and
    # that the box cannot move for identical or for changing values.
    run "context label: text node reused when unchanged, box does not move" \
        node "$V/test-ctx-ring.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # Issue #1: the message sent in a new chat was wiped from the transcript by
    # the user's own message_end (pi emits one), because that rebuilt the
    # transcript from a session file that had not been written yet.
    run "new chat: the sent message survives the user's own message_end" \
        node "$V/test-new-chat.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # Issues #35 and #36: one dialog size for every settings tab, and the
    # narration before a hidden tool call is hidden with it.
    run "ui: settings tabs share one size, pre-tool narration hidden with the cards" \
        node "$V/test-ui-uniformity.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # Issue #37: an empty progress event must not blank a running tool card, and
    # a rendered edit diff must still survive its result.
    run "tool cards: empty progress does not blank the card, diffs survive" \
        node "$V/test-tool-card.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # Issue #34: the sidebar must stay on the row the reader was on when rows are
    # inserted, removed or reordered above it.
    run "sidebar: stays anchored on its row across a rebuild" \
        node "$V/test-sidebar-anchor.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # Issue #38: a picture on a session line larger than 8 MB. The phone pictures
    # came back as "image no longer in this session" because readLineAt() stopped
    # growing its read at 8 MB, truncated the line, and the parse failure was
    # reported as a missing image. Writes one file into the session dir and removes
    # only that file.
    run "images: a picture on a line over 8 MB is served whole" \
        env PI_BIGIMG_DIR="$SESSION_DIR" node "$V/test-big-image.js" "http://127.0.0.1:$PORT"
    # Reported as "switching fast and the server kind of dies": the heartbeat
    # asked the agent (and closed the socket when a busy agent was slow) and
    # every click queued its own switch. It reports 77 - a SKIP - when the shared
    # agent is mid-turn, because the read-only path then sends no switches to
    # count.
    skip_ok "rapid switching: heartbeat asks the bridge, clicks coalesce" \
        node "$V/test-rapid-switch.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # Issues #40, #47, #48, #42, #41 and #38's loop. All of them are decided in the
    # page, so no agent turn is needed. PI_TEST_KEEP_GOING=1 there reports every
    # failed check at once, which is how each one was shown to fail on the old code.
    # The scrollbar: Firefox needs `thin` (it is what removes the arrow buttons) and
    # Chromium must stay on `auto` (its bar is already right, and thin narrows it
    # 15px -> 10px). The two cannot share one value, so the CSS scopes it with
    # @supports. Chromium can only check that it is NOT caught by that guard; the
    # Firefox half is one reload away for a person to see.
    run "scrollbar: Firefox gets `thin`, this browser is not caught by the guard" \
        node "$V/test-scrollbar.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # Issue #45: the settings dialog must not build the 295-option system font list
    # while it is opening. It reports 77 (a SKIP) against a bridge that knows few
    # fonts, since then there is no list to keep out.
    skip_ok "settings: opening the dialog builds no font list, the font box still works" \
        node "$V/test-settings-open.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # Issue #46: the extensions tab, against the scratch agent dir - the endpoints
    # write settings.json and delete files.
    run "extensions: list, enable/disable writes pi's own format, paths stay inside" \
        env PI_TEST_AGENT_DIR="$EXT_DIR" \
        node "$V/test-extensions.js" "http://127.0.0.1:$((PORT + 1))" "$BROWSER"
    run "compaction: marks are per-session, facts survive a reload, ring shows the estimate" \
        node "$V/test-compaction.js" "http://127.0.0.1:$PORT" "$BROWSER"
  else
    skip "no Chrome/Edge found for the browser check"
  fi
else
  bad "session list returns a usable path"
fi

# Both bridges, and the trap is cleared only after both are gone. This used to kill
# $BRIDGE_PID alone and then `trap - EXIT`, which is how the extensions bridge from
# every run stayed up on its port and the next run quietly tested the old one.
kill_port "$PORT"
kill_port "$((PORT + 1))"
wait $BRIDGE_PID 2>/dev/null
wait $EXT_BRIDGE_PID 2>/dev/null
trap - EXIT

# ───────────────────────────── 4. docker ─────────────────────────────
if [ "${1:-}" = "--docker" ]; then
  head_ "4. docker — image from docker-compose.yml"
  if ! command -v docker >/dev/null 2>&1; then
    skip "docker not installed"
  elif ! docker info >/dev/null 2>&1; then
    skip "docker daemon not running"
  else
    if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi
    if $DC build pi-webui >"$TMP/build.log" 2>&1; then
      ok "image builds"
    elif grep -qiE 'no such host|docker\.io/v2|failed to do request|context deadline exceeded|TLS handshake timeout|proxy' "$TMP/build.log"; then
      # Pulling the base image needs the registry. No route to it is a property of
      # this machine, not of the code, and the container checks below still run
      # against whatever image is already present — which is a real check of the
      # Dockerfile's COPY layout, just not of the base image's freshness.
      skip "image builds (no route to the registry — base image could not be pulled)"
    else
      bad "image builds"; head -20 "$TMP/build.log" | sed 's/^/       /'
    fi

    # compose pins container_name, so a container left behind by an earlier run
    # makes "up" fail on a name conflict before it ever starts the service. Drop
    # just that one, and only when it is stopped.
    if docker ps -a --format '{{.Names}}' | grep -qx 'pi-webui'; then
      docker stop pi-webui >/dev/null 2>&1 || true
      docker rm -f pi-webui >/dev/null 2>&1 || true
      note "removed a leftover pi-webui container"
    fi

    if $DC up -d pi-webui >"$TMP/up.log" 2>&1; then
      ok "container starts"
      DP=${PI_WEBUI_PORT:-3080}      up=0
      for _ in $(seq 1 60); do
        curl -fsS "http://127.0.0.1:$DP/api/health" >/dev/null 2>&1 && { up=1; break; }
        sleep 0.5
      done
      if [ "$up" = 1 ]; then
        ok "container serves /api/health"
        # A fresh container has an empty session dir, so the message checks have
        # nothing to read; the list and the assets are still worth asserting.
        run "container: page, assets, session list" \
            node "$V/test-endpoints-container.js" "http://127.0.0.1:$DP"
      else
        bad "container serves /api/health"
        $DC logs pi-webui 2>&1 | tail -20 | sed 's/^/       /'
      fi
      $DC down -v >/dev/null 2>&1
    else
      bad "container starts"; head -20 "$TMP/up.log" | sed 's/^/       /'
    fi

    # ── the container-facing code paths, against a throwaway container ────
    #
    # Deliberately NOT the compose container: that one has a named volume with
    # real sessions in it, and both of these tests plant files by clearing the
    # session directory. A container of our own from the same image is the same
    # code with none of the data.
    if docker image inspect webui-pi-webui:latest >/dev/null 2>&1; then
      VERIFY_IMG=webui-pi-webui:latest
    else
      VERIFY_IMG=$(docker inspect -f '{{.Config.Image}}' pi-webui 2>/dev/null || echo "")
    fi
    docker rm -f pi-webui-verify >/dev/null 2>&1 || true
    if [ -n "$VERIFY_IMG" ] && docker run -d --name pi-webui-verify --entrypoint sleep "$VERIFY_IMG" 600 >/dev/null 2>&1; then
      note "throwaway container from $VERIFY_IMG for the container-facing checks"
      sleep 2
      run "container: session-name and ?dir= payloads do not execute" \
          env PI_TEST_CONTAINER=pi-webui-verify node "$V/test-injection.js"
      run "container: docker session mode - list, transcript, image, download, delete" \
          env PI_TEST_CONTAINER=pi-webui-verify node "$V/test-docker-mode.js"
      docker rm -f pi-webui-verify >/dev/null 2>&1 || true
    else
      skip "throwaway container for the injection and docker-mode checks"
    fi
  fi
fi

# ───────────────────────────── result ─────────────────────────────
printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf '%s%d passed%s, %d skipped\n' "$GRN" "$PASS" "$RST" "$SKIP"
else
  printf '%s%d passed%s, %s%d failed%s, %d skipped\n' "$GRN" "$PASS" "$RST" "$RED" "$FAIL" "$RST" "$SKIP"
fi
# Best effort: a browser process this run started may still hold a file here, and
# a failure to clean up is not a test failure.
rm -rf "$TMP" 2>/dev/null || true
[ "$FAIL" -eq 0 ] || exit 1
