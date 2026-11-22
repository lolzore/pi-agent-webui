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
#         ./verify-matrix.sh --changed  (only tests affected by changed files)
#         ./verify-matrix.sh --changed --docker
#
# --changed compares the working tree and this branch against PI_TEST_BASE
# (default: origin/main). Each changed source path maps to the tests that cover
# it; syntax checks are limited to changed JS files. Tests that are not affected
# are counted as "not affected" rather than skipped, so the result stays honest.
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
# pi's own config variables describe the developer's real install. Run from
# inside a pi session (or any shell that exports them), a bridge that honours
# PI_CODING_AGENT_DIR would ignore the scratch PI_AGENT_DIR below and read the
# real agent dir - sessions, skills, models and all. The suite owns its paths.
unset PI_CODING_AGENT_DIR
unset PI_CODING_AGENT_SESSION_DIR

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
PASS=0; FAIL=0; SKIP=0; UNCHANGED=0
MODE_DOCKER=0; CHANGED_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --docker) MODE_DOCKER=1 ;;
    --changed) CHANGED_ONLY=1 ;;
  esac
done
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

# ── targeted testing (--changed) ─────────────────────────────────────────
# Keep this table next to the test list, not in every test: one source file maps
# to the tests that actually exercise it. A changed test always maps to itself.
CHANGED_FILES=""
TARGET_TESTS=""
DOCKER_RELEVANT=0
if [ "$CHANGED_ONLY" = 1 ]; then
  BASE=${PI_TEST_BASE:-origin/main}
  if ! git rev-parse --verify "$BASE" >/dev/null 2>&1; then
    BASE=${PI_TEST_BASE:-main}
  fi
  if git rev-parse --verify "$BASE" >/dev/null 2>&1; then
    CHANGED_FILES=$( {
      git diff --name-only "$BASE"...HEAD 2>/dev/null || true
      git diff --name-only 2>/dev/null || true
      git diff --cached --name-only 2>/dev/null || true
      git ls-files --others --exclude-standard 2>/dev/null || true
    } | sort -u)
  else
    CHANGED_FILES=$( { git diff --name-only; git diff --cached --name-only; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
  fi
  add_targets() {
    local t
    for t in $1; do
      case " $TARGET_TESTS " in *" $t "*) ;; *) TARGET_TESTS="$TARGET_TESTS $t" ;; esac
    done
  }
  for f in $CHANGED_FILES; do
    case "$f" in
      verify/test-*.js) add_targets "$(basename "$f")" ;;
      bridge/server.js) add_targets "test-stale-session-cwd.js test-plain-chat.js test-statistics.js test-endpoints-container.js test-endpoints.js test-settings-broadcast.js test-tts-key.js test-bridge-hardening.js" ;;
      bridge/session-modes.js) add_targets "test-plain-chat.js test-endpoints.js" ;;
      bridge/plain-models.js) add_targets "test-plain-models.js test-plain-chat.js" ;;
      bridge/goals.js) add_targets "test-goals.js test-goal-controls.js test-goals-session-cwd.js test-endpoints-container.js" ;;
      bridge/agent.js) add_targets "test-stale-session-cwd.js test-plain-models.js test-goals.js test-goal-controls.js test-ui-issues.js test-resume-at-start.js test-plain-chat.js test-endpoints-container.js test-rpc-ids.js test-bash-stream.js test-settings-broadcast.js test-ext-dialog-ids.js test-ext-dialog-wedge.js test-ext-dialog-page.js" ;;
      bridge/routes/pi.js) add_targets "test-goals.js test-goal-controls.js test-goals-session-cwd.js test-pi-config.js test-searxng.js test-providers-tab.js test-provider-add.js test-mcp-config.js test-endpoints-container.js" ;;
      bridge/routes/sessions.js) add_targets "test-resume-at-start.js test-ui-issues.js test-pending-row-session.js test-endpoints.js test-endpoints-container.js test-docker-mode.js test-plain-chat.js test-session-scan-cache.js" ;;
      bridge/routes/websearch.js) add_targets "test-websearch-setup.js test-camoufox-install.js test-searxng-native.js test-searxng.js" ;;
      bridge/routes/statistics.js) add_targets "test-statistics.js" ;;
      bridge/routes/pets.js) add_targets "test-pet-library.js test-pet.js" ;;
      bridge/routes/*.js) add_targets "test-endpoints.js test-endpoints-container.js test-bridge-hardening.js" ;;
      bridge/sessions.js) add_targets "test-session-lines.js test-sidebar-anchor.js test-pending-row-session.js test-statistics.js test-scan-error.js test-scan-missing.js test-session-scan-cache.js" ;;
      bridge/llama.js) add_targets "test-providers-tab.js test-provider-add.js test-llama-probe.js" ;;
      bridge/*.js) add_targets "test-endpoints.js test-endpoints-container.js" ;;
      web/extension-ui.js) add_targets "test-goals.js test-ui-issues.js test-extension-errors.js test-ext-dialog-page.js" ;;
      web/goals.js) add_targets "test-goals.js test-goal-controls.js" ;;
      web/toasts.js) add_targets "test-ui-issues.js test-stray-one.js" ;;
      web/stream.js) add_targets "test-stray-one.js test-ui-issues.js test-compaction.js test-compaction-noop.js test-tool-preview.js" ;;
      web/sessions.js) add_targets "test-ui-issues.js test-resume-at-start.js test-session-folders.js test-rapid-switch.js test-sidebar-anchor.js test-pending-row-session.js test-session-title.js test-fork-edit.js test-plain-chat.js test-run-clock.js test-ctx-sessions.js test-reload-running-tool.js" ;;
      web/style.css) add_targets "test-ui-issues.js test-stray-one.js test-goals.js test-settings-grid.js test-settings-paint.js test-pill-stability.js test-run-clock.js test-stream-scroll.js test-scrollbar.js test-ui-uniformity.js test-pet.js test-pet-frames.js" ;;
      web/clock.js) add_targets "test-run-clock.js" ;;
      web/pi-panel.js) add_targets "test-providers-tab.js test-provider-add.js test-mcp-config.js" ;;
      web/settings-ui.js) add_targets "test-ui-issues.js test-settings-grid.js test-settings-open.js test-settings-voices.js test-tts-settings.js test-tts-key.js test-websearch-setup.js test-setup-packages.js test-agent-source.js test-pi-config.js" ;;
      web/app.js|web/index.html) add_targets "test-providers-tab.js test-provider-add.js test-compaction.js test-compaction-noop.js test-ui-issues.js test-goals.js test-resume-at-start.js test-settings-open.js test-build-assets.js test-menu-position.js test-slash-menu.js test-pi-config.js test-plain-chat.js test-statistics.js test-rpc-ids.js test-bash-stream.js test-settings-broadcast.js test-tts-key.js test-pet.js test-pet-frames.js test-reload-running-tool.js test-ctx-sessions.js" ;;
      web/statistics.js) add_targets "test-statistics.js" ;;
      web/shorts.js) add_targets "test-browser-pane.js test-endpoints.js" ;;
      web/composer.js|web/slash.js) add_targets "test-statistics.js test-slash-menu.js test-bash-stream.js" ;;
      web/settings-state.js) add_targets "test-settings-open.js test-tts-key.js test-tts-key-page.js test-settings-grid.js test-pet.js" ;;
      web/pet.js) add_targets "test-pet.js test-pet-frames.js" ;;
      web/transcript.js) add_targets "test-compaction-live.js test-media-observers.js test-compaction.js test-compaction-noop.js test-reload-running-tool.js" ;;
      web/sessions.js) add_targets "test-media-observers.js test-ui-issues.js test-resume-at-start.js test-session-folders.js" ;;
      web/subagents.js) add_targets "test-media-observers.js" ;;
      web/voice.js) add_targets "test-tts-playback.js test-tts-settings.js test-tts-fish.js" ;;
      web/*) add_targets "test-endpoints.js" ;;
      pi-electron/bridge-manager.js) add_targets "test-electron-bridge.js" ;;
      start-webui.sh|start-webui.bat) add_targets "test-start-webui-firstrun.js test-start-instance.js" ;;
      Dockerfile|docker-compose.yml|package.json|package-lock.json) DOCKER_RELEVANT=1; add_targets "test-endpoints-container.js" ;;
      README.md|docs/*|*.md) : ;;
      *) [ -n "$f" ] && note "no targeted tests for $f" ;;
    esac
  done
  case "$CHANGED_FILES" in
    *Dockerfile*|*docker-compose.yml*|*bridge/*|*package.json*|*package-lock.json*) DOCKER_RELEVANT=1 ;;
  esac
  note "changed: $(printf '%s' "$CHANGED_FILES" | wc -l | tr -d ' ') file(s); tests:${TARGET_TESTS:- none}"
fi

is_changed_file() {
  local f
  for f in $CHANGED_FILES; do [ "$f" = "$1" ] && return 0; done
  return 1
}

is_target_test() {
  local a b
  for a in "$@"; do
    case "$a" in
      *test-*.js)
        b=$(basename "$a")
        case " $TARGET_TESTS " in *" $b "*) return 0 ;; esac
        ;;
    esac
  done
  return 1
}
# run <label> <cmd...> : pass/fail on the exit code, never on a text marker.
run()  { local label=$1; shift
         if [ "$CHANGED_ONLY" = 1 ] && ! is_target_test "$@"; then UNCHANGED=$((UNCHANGED+1)); return 0; fi
         : >"$TMP/err.txt"
         if out=$("$@" 2>"$TMP/err.txt"); then ok "$label${out:+ ($out)}"
         else bad "$label"; fi; }

# ───────────────────────────── 1. syntax ─────────────────────────────
head_ "1. syntax"
# Plain JS: node --check is the right tool.
for f in bridge/server.js bridge/goals.js bridge/routes/*.js web/*.js bridge/mock_agent.js verify/*.js; do
  [ -f "$f" ] || continue
  if [ "$CHANGED_ONLY" = 1 ] && ! is_changed_file "$f" && ! is_target_test "$f"; then
    UNCHANGED=$((UNCHANGED+1)); continue
  fi
  run "$f parses" node --check "$f"
done
# Checks that need an optional runtime report 77 when it is missing, which is a
# SKIP rather than a defect (the Electron smoke test has no display in headless
# CI and no electron binary before `npm ci`).
skip_ok() {
  local label=$1; shift
  if [ "$CHANGED_ONLY" = 1 ] && ! is_target_test "$@"; then UNCHANGED=$((UNCHANGED+1)); return 0; fi
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
# The desktop app (Electron): loads the WebUI, starts its own bridge on
# Electron's bundled node, and gives the shorts feed a top-level view with the
# right user agent. Skips when electron is not installed or there is no display.
skip_ok "desktop app (Electron): the WebUI and a top-level shorts feed" \
    node pi-electron/test/smoke.cjs

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
    node "$V/test-session-lines.js" bridge/sessions.js "$SESSION_DIR/verify.jsonl"

run "writeJsonAtomic: whole file, no litter, failure-safe" \
    node "$V/test-atomic-write.js" bridge/llama.js

run "electron bridge: a spawn error is reported, not timed out" \
    node "$V/test-electron-bridge.js"

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
  local pid
  # Windows (Git Bash, MSYS): the `-o` column is the PID. netstat without -o does
  # not exist there, so this branch is inert on Linux and must stay first: the
  # Linux netstat below prints the same "LISTENING" word but a different column
  # layout, and parsing that as -o yields the peer address, not a PID.
  pid=$(netstat -ano 2>/dev/null | grep LISTENING | grep ":$1 " | awk '{print $5}' | head -1)
  if [ -n "$pid" ]; then printf '%s\n' "$pid"; return 0; fi
  # Linux/macOS: lsof names the listener's PID directly.
  pid=$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1)
  if [ -n "$pid" ]; then printf '%s\n' "$pid"; return 0; fi
  # ss prints users:(("node",pid=123,fd=21)); pull the pid= out.
  pid=$(ss -ltnp 2>/dev/null | grep ":$1 " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
  [ -n "$pid" ] && printf '%s\n' "$pid"
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
  # Issue #196: a 100MB session must stream, not freeze the bridge.
  run "large session: a 100MB transcript streams and the bridge keeps answering" \
      node "$V/test-large-session.js"
  # Issue #62: both upload routes store a video and /api/upload-file serves it
  # back with Range, while paths outside the uploads folder are refused.
  run "uploads: a video goes in through both routes and is served back with ranges" \
      env PI_TEST_AGENT_DIR="$EXT_DIR" \
      node "$V/test-upload-video.js" "http://127.0.0.1:$((PORT + 1))"

  # Issue #227/#228: two pages number their RPCs from zero, so both send
  # `req-1`; each must still get its own answer. Bash output is request-scoped
  # and must carry the caller's id, before the response.
  run "rpc ids: two clients with the same id each get their own response" \
      node "$V/test-rpc-ids.js" "http://127.0.0.1:$((PORT + 1))"
  run "bash stream: updates carry the caller's id and arrive before the response" \
      node "$V/test-bash-stream.js" "http://127.0.0.1:$((PORT + 1))"
  run "settings: a save broadcasts settings_changed and persists" \
      node "$V/test-settings-broadcast.js" "http://127.0.0.1:$((PORT + 1))"
  run "tts key: bridge-owned, absent from GET, survives a save" \
      node "$V/test-tts-key.js" "http://127.0.0.1:$((PORT + 1))"
  run "scan error: an unreadable session directory is reported, not hidden" \
      node "$V/test-scan-error.js"
  run "scan missing: a session directory that does not exist yet is empty" \
      node "$V/test-scan-missing.js"
  run "pet library: Petdex search is proxied and downloads are persisted" \
      node "$V/test-pet-library.js"
  run "bridge hardening: handler failure, upload limit, image MIME" \
      node "$V/test-bridge-hardening.js"
  run "session scan cache: warm scan reads 0 bytes" \
      node "$V/test-session-scan-cache.js"

  # A recorded session whose working directory is gone must not be resumed on
  # every restart: pi exits code 1 for one, so the agent would never come up and
  # every command from the page answered "the agent is not running".
  run "resume: a session whose folder is gone does not take the agent down" \
      node "$V/test-stale-session-cwd.js"

  # The layer that can catch a mistake in web/app.js: a real browser, a real
  # console. Everything above it can pass while the transcript renders nothing.
  BROWSER=""
  # An explicit browser still wins, which is useful on a machine whose PATH
  # points at a wrapper. Normal discovery prefers the headless-shell builds:
  # they have no window to show in the first place. A GUI Chromium is the
  # fallback, and Electron is not used here - its `--headless=new` flag does not
  # hide the BrowserWindow an Electron app creates, so a path that happens to
  # symlink to Electron (or to a wrapper around it) used to open a window for
  # every browser check. `--version` tells the two apart without starting a
  # browser page.
  if [ -n "${PI_TEST_BROWSER:-}" ]; then
    version=$("$PI_TEST_BROWSER" --version 2>/dev/null | head -1)
    case "$version" in
      *Chrome*|*Chromium*|*Edge*) BROWSER="$PI_TEST_BROWSER" ;;
      *) note "skipping PI_TEST_BROWSER: it is not a Chromium browser ($version)" ;;
    esac
  else
    for cand in \
      "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
      "/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
      "/c/Program Files/Google/Chrome/Application/chrome.exe" \
      "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"; do
      [ -f "$cand" ] && { BROWSER="$cand"; break; }
    done
  fi
  if [ -z "$BROWSER" ]; then
    # `chromium`/`chrome` cover a Playwright/`chrome-linux` install on PATH (see
    # .browsers/ and the README's note on running the checks), which is how the
    # browser layer runs on a machine with no system Chromium.
    for cand in chrome-headless-shell chromium-headless-shell google-chrome google-chrome-stable chromium chromium-browser chrome microsoft-edge microsoft-edge-stable; do
      if command -v "$cand" >/dev/null 2>&1; then
        cand_path=$(command -v "$cand")
        version=$("$cand_path" --version 2>/dev/null | head -1)
        case "$version" in
          *Chrome*|*Chromium*|*Edge*) BROWSER="$cand_path"; break ;;
          *) note "skipping $cand: it is not a headless Chromium browser ($version)" ;;
        esac
      fi
    done
  fi
  if [ -z "$BROWSER" ]; then
    note "browser checks skipped: no headless Chrome/Chromium found (set PI_TEST_BROWSER to override)"
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
    # The ring follows the session on screen, including a read-only view while
    # the agent keeps running in its own session.
    run "context sessions: ring follows idle and read-only session switches" \
        node "$V/test-ctx-sessions.js" "$BROWSER"
    # Issue #1: the message sent in a new chat was wiped from the transcript by
    # the user's own message_end (pi emits one), because that rebuilt the
    # transcript from a session file that had not been written yet.
    run "new chat: the sent message survives the user's own message_end" \
        node "$V/test-new-chat.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # Issue #201: emoji fallback, party confetti, image-block placeholders.
    run "emoji/images: emoji fallback, party confetti, blocked-image placeholders" \
        node "$V/test-emoji-images.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # Issue #205: a bar that contains only a digit/pipe is a fragment, not a status.
    run "stray glyph: a bare 1 or | in a status/widget bar is not rendered" \
        node "$V/test-stray-one.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # Issue #206: the tab title follows the session, not just the agent name.
    run "session title: the tab follows new, switched and renamed sessions" \
        node "$V/test-session-title.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # Issues #35 and #36: one dialog size for every settings tab, and the
    # narration before a hidden tool call is hidden with it.
    run "ui: settings tabs share one size, pre-tool narration hidden with the cards" \
        node "$V/test-ui-uniformity.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # Issue #37: an empty progress event must not blank a running tool card, and
    # a rendered edit diff must still survive its result.
    run "tool cards: empty progress does not blank the card, diffs survive" \
        node "$V/test-tool-card.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # Issue #67: the streamed arguments preview kept only the last 4000/2000
    # characters, so a long write lost its beginning while it streamed. This
    # drives the real streaming events and checks the beginning survives, the
    # cap says what it hides, and the finished card holds everything.
    run "tool preview: a long stream keeps its beginning, names what it hides, finishes whole" \
        node "$V/test-tool-preview.js" "http://127.0.0.1:$PORT" "$BROWSER"
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
    # Issue #62: a video attachment is a player in the composer and in the
    # transcript, not a filename and a raw path line.
    run "video: a clip attaches with a playing preview and appears in the transcript" \
        node "$V/test-video-attach.js" "http://127.0.0.1:$PORT" "$BROWSER"
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
    # Issue #53: abort() does not clear pi's queue, so a queued command was
    # delivered on a later turn - pi 1.0.0 added clear_queue for exactly this. The check
    # asks the AGENT what it still holds, because the page clears its own copy
    # unconditionally and asserting on that said nothing.
    skip_ok "stopping: the agent's pending queue is cleared, not left to be delivered" \
        node "$V/test-stop-clears-queue.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # A reload must never move the agent out of the session it is in. The page used
    # to fall through to the remembered session whenever the agent's own session was
    # spelled differently from the scanned path - and the remembered session is the
    # newest one, i.e. row one - so the next prompt was written into another
    # conversation and the one on screen looked like it had been discarded. This one
    # starts its own bridge (it needs pi to report a session the scan lists under
    # another path), so it takes the browser only.
    run "reload: the agent stays in its own session, no silent switch to the newest" \
        node "$V/test-reload-session.js" "$BROWSER"
    # Issue #52: the row for a message that is not in the file yet used to be
    # re-appended to whatever session was rendered, so a steered message showed up in
    # a new chat. Both halves are checked - the same-session carry-over is issue #1.
    run "pending rows: kept in their own session, never shown in another" \
        node "$V/test-pending-row-session.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # Issue #51: the slash menu is appended to <body>, so nothing in the composer
    # ever saw a click elsewhere on the page and it stayed up until Escape.
    run "slash menu: an outside click closes it, using the box brings it back" \
        node "$V/test-slash-menu.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # Issue #60: a markdown table used to arrive as literal pipes.
    run "markdown: tables render, with alignment and inline markdown" \
        node "$V/test-markdown-tables.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # Issue #59: a failed turn has content: [] and its reason in errorMessage, which
    # the transcript never rendered - so the only trace was a toast that went away.
    run "errors: a failed turn shows the provider's reason, not (empty message)" \
        node "$V/test-error-detail.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # Issue #42 reopened: the whole composer dock shifted while the agent wrote,
    # because it is sticky inside the transcript scroller and `bottom: 0` made the
    # landing flip between two half-pixel roundings as the content height changed.
    # The check measures the old value too, so it fails loudly if it ever stops
    # being able to detect the regression.
    run "composer: the dock does not shift while the transcript grows" \
        node "$V/test-composer-jitter.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # The scrollbar: Firefox needs `thin` (it is what removes the arrow buttons) and
    # Chromium must stay on `auto` (its bar is already right, and thin narrows it
    # 15px -> 10px). The two cannot share one value, so the CSS scopes it with
    # @supports. Chromium can only check that it is NOT caught by that guard; the
    # Firefox half is one reload away for a person to see.
    run 'scrollbar: Firefox gets `thin`, this browser is not caught by the guard' \
        node "$V/test-scrollbar.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # Issue #45: the settings dialog must not build the 295-option system font list
    # while it is opening. It reports 77 (a SKIP) against a bridge that knows few
    # fonts, since then there is no list to keep out.
    skip_ok "settings: opening the dialog builds no font list, the font box still works" \
        node "$V/test-settings-open.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # Issue #246: a legacy TTS key must be gone from localStorage after load.
    run "tts key page: a legacy key is purged from localStorage on load" \
        node "$V/test-tts-key-page.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # #256/#260/#238: observer bounds on the session-switch path, the live
    # compaction marker, and a refused TTS play().
    run "media observers: session-switch rebuilds release detached media" \
        node "$V/test-media-observers.js" "$BROWSER"
    run "compaction live: the live marker keeps the after-count" \
        node "$V/test-compaction-live.js" "http://127.0.0.1:$PORT" "$BROWSER"
    run "tts playback: a refused play() settles and revokes the blob" \
        node "$V/test-tts-playback.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # Issue #46: the extensions tab, against the scratch agent dir - the endpoints
    # write settings.json and delete files.
    run "extensions: list, enable/disable writes pi's own format, paths stay inside" \
        env PI_TEST_AGENT_DIR="$EXT_DIR" \
        node "$V/test-extensions.js" "http://127.0.0.1:$((PORT + 1))" "$BROWSER"
    # Issue #64: pi also loads user skills from ~/.agents/skills (this is where
    # they live on Linux) and read-only project skills from .pi/.agents. This
    # starts its own bridge with a scratch HOME so both roots are real.
    run "skills: agent dir and ~/.agents are listed, toggles write pi's own pattern" \
        node "$V/test-skills-linux.js" "$BROWSER"
    # Issue #89: the settings layout bug was a stale stylesheet in a long-lived
    # tab - new HTML with old CSS. Assets are now versioned with the running
    # build and a changed build offers a reload; this also asserts the 510px
    # layout from the issue's screenshot is one column with no overlap.
    run "build: assets are versioned, the 510px settings layout holds, a new build offers a reload" \
        node "$V/test-build-assets.js" "$BROWSER"
    # Issue #105: the settings grid pins its columns, so a run of check-labels
    # cannot shift the rows after it into the 110px label column.
    run "settings grid: labels and controls stay in their columns at 1200px and 525px" \
        node "$V/test-settings-grid.js" "$BROWSER"
    # Issue #264/#267: Fun owns gamer/confetti, and the opt-in DeepSeek desk pet
    # follows agent state, reacts to a click, and hides again when disabled.
    run "fun: gamer/confetti live in Fun and the desk pet follows the agent" \
        node "$V/test-pet.js" "$BROWSER"
    # Issue #278: pet frames are whole cells drawn at their native 192x208
    # aspect; a percentage background-size could sample the neighbouring frame.
    run "fun: pet frames are whole native cells, not resampled across the grid" \
        node "$V/test-pet-frames.js" "$BROWSER"
    # Issue #118: the picker pills rewrite their label from every state sync; a
    # replaced text node moved their border and arrow up and down.
    run "pill stability: the model/thinking pills keep their height and arrow when the label changes" \
        node "$V/test-pill-stability.js" "$BROWSER"
    # Issue #270: the total-time stat was hidden below 760px and a session poll
    # could finish its clock between agent_end and agent_settled.
    run "run clock: the task total is visible at every width and keeps counting mid-turn" \
        node "$V/test-run-clock.js" "$BROWSER"
    # Issue #279: a reload while a bash command runs rebuilt its card from the
    # session file, where the toolCall has no result yet - and drew it as "done"
    # with no timer. It is "running" while the agent streams, "interrupted" after.
    run "reload: a running tool card stays running, with its timer, across a reload" \
        node "$V/test-reload-running-tool.js" "$BROWSER"
    # Issue #117: the settings click was fast but its first paint could lag on a
    # heavy page; the dialog is its own layer now and records the frame time.
    run "settings paint: the dialog reaches its first frame quickly over a heavy transcript" \
        node "$V/test-settings-paint.js" "$BROWSER"
    # Issue #121: the first-run wizard recommends packages before the
    # preferences and installs the ticked ones on the way out.
    run "setup packages: the wizard recommends, installs the ticked ones and finishes" \
        node "$V/test-setup-packages.js" "$BROWSER"
    # Regression: dropdowns opened while the settings dialog is up were offset
    # by the dialog (a containing block from contain/will-change on it).
    run "menu position: dropdowns inside the settings dialog sit next to their anchors" \
        node "$V/test-menu-position.js" "$BROWSER"
    # Issue #124: the top-bar terminals button (running bash tools, close).
    run "terminals: the button counts the running bash tools and can close them" \
        node "$V/test-terminals.js" "$BROWSER"
    # Issue #123: the split pane can host a browser instead of a feed.
    run "browser pane: the split pane hosts a browser that navigates and goes back" \
        node "$V/test-browser-pane.js" "$BROWSER"
    # Issue #137: a compaction that ends without a summary keeps a marker.
    run "compaction noop: a summary-less compaction keeps its marker" \
        node "$V/test-compaction-noop.js" "$BROWSER"
    # Issue #149: a message sent while the agent streams stays below the reply
    # it steered, without needing a reload.
    run "steer order: a steered message stays below the reply it steered" \
        node "$V/test-steer-order.js" "$BROWSER"
    # Message text must never become real HTML (a <base> in a bullet broke every
    # relative URL and made the page drop its own socket every 25s).
    run "markdown escape: message text cannot put HTML into the page" \
        node "$V/test-markdown-escape.js" "$BROWSER"

    # Editing a message forks the session and resends it - and the active-branch
    # tree is only fetched when a fork actually starts.
    run "fork edit: editing a sent message forks and resends" \
        node "$V/test-fork-edit.js" "$BROWSER"

    # Issue #175: html/svg code blocks can be previewed, copied and closed -
    # and the preview follows the code while the agent writes it.
    run "code preview: html and svg blocks preview, copy, close, and follow live code" \
        node "$V/test-code-preview.js" "$BROWSER"

    # Issue #176: a new chat starts on the chosen default model.
    run "default model: a new chat switches to it, and nothing changes when unset" \
        node "$V/test-default-model.js" "$BROWSER"

    # Issue #174: the llama.cpp models are not offered in the picker.
    run "model filter: llama.cpp models are hidden, llama-server stays" \
        node "$V/test-model-filter.js" "$BROWSER"

    # The bridge starts the agent in the last session instead of switching to
    # it (the stale-extension-ctx line, and the empty-transcript race).
    run "resume: the agent is started in the last session, not switched to it" \
        node "$V/test-resume-at-start.js"

    # The General/Shorts/timer tweaks: pi location last, no "Open with", the
    # Shorts tab is the desktop app's, and timers are whole seconds.
    run "ui tweaks: pi location last, no Open with, desktop-only Shorts, whole-second timers" \
        node "$V/test-ui-tweaks.js" "$BROWSER"

    # Issues #219/#220/#221/#222: notes behind a ?, compact expandable
    # notifications, "new folder…" last, and no double session switch while the
    # bridge is resuming.
    run "ui issues: settings help, compact notifications, folder menu, single resume" \
        node "$V/test-ui-issues.js" "$BROWSER"

    # Plain chat: a fresh pi process with no tools/extensions/skills/AGENTS.md,
    # started from the New session button's right-click menu.
    run "plain chat: a merged catalogue of all configured model providers" \
        node "$V/test-plain-models.js"
    run "plain chat: no tools/extensions/skills/AGENTS.md, with a banner and a way out" \
        node "$V/test-plain-chat.js" "$BROWSER"

    # Hidden model/token tracker behind /statistics.
    run "statistics: /statistics renders per-model and total usage from all sessions" \
        node "$V/test-statistics.js" "$BROWSER"

    # The Linux/macOS launcher's first-run prompt used `[ -n "$CONTAINER" ] && ...`
    # under `set -e`; the false test on the native path exited before the bridge
    # started, while still saving the answer (so the second launch worked).
    run "launcher: first run saves the pi location and starts the bridge" \
        node "$V/test-start-webui-firstrun.js"

    # Issue #157: the pi location (native/docker) is asked in the WebUI now.
    run "agent source: the pi location is asked in the WebUI" \
        node "$V/test-agent-source.js" "$BROWSER"

    # Issue #160: a long streamed answer must stay pinned, and the streaming
    # message must not have its size estimated.
    run "stream scroll: a long answer stays pinned at the bottom" \
        node "$V/test-stream-scroll.js" "$BROWSER"

    # Issue #150, real cause: a slow speech service must not delay the dialog.
    run "settings voices: a slow speech service does not delay the settings dialog" \
        node "$V/test-settings-voices.js" "$BROWSER"
    # Issue #129: a subagent run shows the model it used.
    run "subagent model: a run's row names the model it used" \
        node "$V/test-subagent-model.js" "$BROWSER"
    # Issue #92: MCP servers in the settings. Own bridge and scratch agent dir;
    # writes pi's mcp.json, so the file is the assertion.
    run "mcp: list/add/toggle/remove in pi's mcp.json, project entries read-only" \
        node "$V/test-mcp-config.js" "$BROWSER"
    # Issue #72: an uploaded video becomes frames the model can see. Two
    # bridges - the default one and PI_WEBUI_FFMPEG=off - so both paths are
    # covered whatever the host has installed.
    run "video frames: a clip reaches the model as images, and says so when ffmpeg is absent" \
        node "$V/test-video-frames.js" "$BROWSER"
    # Issue #79: the UI starts a second local agent through the real launcher.
    # A `pi` stub on PATH keeps the second instance on the mock agent; its home
    # and ports live under the scratch dir.
    run "instances: the menu starts a second agent, finds it, and stops what it started" \
        node "$V/test-start-instance.js" "$BROWSER"
    # Issue #81: the goal bar acts on goal-x - pause/resume/focus as its own
    # commands, task complete/reopen with the extension's gates, an evidence
    # dialog for contracted tasks, and /goal-refresh after a file change.
    run "goal controls: pause/resume/focus as commands, task gates, evidence dialog" \
        node "$V/test-goal-controls.js" "$BROWSER"
    # A provider retry is a state with a cancel (abort_retry). The cycle items
    # that shipped with it were removed in #107.
    run "retry bar: a provider retry is a state with a cancel, cleared on end or settle" \
        node "$V/test-retry-bar.js" "$BROWSER"
    # Issue #68: the Pi providers tab rendered only after the llama probe and
    # never retried it, and the provider picker was a native <datalist> that
    # does not open on a click. This starts a fake llama.cpp server mid-run to
    # prove a later probe shows up without reopening the dialog.
    run "providers: custom rows render, a late llama server appears, the picker opens on click" \
        env PI_TEST_AGENT_DIR="$EXT_DIR" \
        node "$V/test-providers-tab.js" "http://127.0.0.1:$((PORT + 1))" "$BROWSER"
    # A full /chat/completions URL is trimmed to the base pi needs, discovery
    # forwards the key, and models.json is written as an object (not a JSON
    # string of an object) so pi can read it and a second add works.
    run "provider add: full endpoint is trimmed, key is saved, models.json stays an object" \
        node "$V/test-provider-add.js"
    # Issue #106: opening Settings must not start a llama-probe storm. The
    # bridge caches an empty answer and the providers retries only run while
    # that tab is shown; this test runs a bridge whose llama server is a closed
    # port, so the slow path is deterministic.
    # skip_ok: the check is about the *empty* answer being cached, so a
    # llama-server running on this machine (loopback is always probed) means it
    # cannot run here - that is a skip, not a failure.
    skip_ok "llama probe: one probe on open, an empty answer cached, retries only on the providers tab" \
        node "$V/test-llama-probe.js" "$BROWSER"
    # Issue #61: a starred model is pinned to the top of the picker and the
    # setting survives a reload (the bridge's copy, not just localStorage).
    run "favourites: a starred model is pinned at the top and survives a reload" \
        node "$V/test-favourites.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # Issue #57: two real bridges on this machine. The first discovers the
    # second, the switcher adds and looks at it, its sessions replace the local
    # ones, and coming back leaves nothing of the other instance behind.
    run "instances: a second local bridge is found, switched to and left without leaks" \
        node "$V/test-instances.js" "$BROWSER"
    # Issue #55: goal-x's state rendered natively, and its TUI widget lines kept
    # out of the browser widget bar. Self-contained: own bridge, own goals dir.
    run "goals: the focused goal renders natively, refreshes, and hides when absent" \
        node "$V/test-goals.js" "$BROWSER"
    # A resumed session can belong to a different project than WORKSPACE_DIR;
    # goal-x follows the session cwd, so /api/goals must too.
    run "goals: state follows the resumed session project and keeps its origin session" \
        node "$V/test-goals-session-cwd.js"
    # Issues #274/#275/#276: an answer to an extension dialog is not an RPC of the
    # bridge's, and its id belongs to the request pi issued. Rewriting it (as every
    # client request is rewritten, so two tabs cannot collide) handed pi an id it
    # did not know: accepting a goal menu sent nothing, a /goal-... command that
    # asked a question did nothing, and the session that was waiting stopped
    # answering until the server was restarted.
    run "extension dialogs: an answer reaches the agent that asked" \
        node "$V/test-ext-dialog-ids.js"
    run "extension dialogs: accepting in the page continues the conversation" \
        node "$V/test-ext-dialog-page.js" "$BROWSER"
    run "extension dialogs: a session waiting on a dialog starts answering again" \
        node "$V/test-ext-dialog-wedge.js"
    run "compaction: marks are per-session, facts survive a reload, ring shows the estimate" \
        node "$V/test-compaction.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # Issue #63: pi's threshold/overflow compaction without retry runs after a
    # completed response or mid-turn (where pi resumes itself), so the old
    # unconditional nudge told a finished agent to continue. Only a turn the
    # compaction actually stopped should be nudged.
    run "compaction nudge: a finished agent is not told to continue, a stalled one is" \
        node "$V/test-compaction-continue.js" "http://127.0.0.1:$PORT" "$BROWSER"
    # Issue #56: pi's own auto-compaction (set_auto_compaction, persisted in
    # settings.json) exposed as a checkbox next to the WebUI's own setting.
    run "pi settings: the auto-compaction toggle reads, changes over RPC, and persists" \
        node "$V/test-pi-config.js" "$BROWSER"
    # Issue #198: pi-searxng needs ~/.pi/searxng.json and a running instance.
    run "searxng: the URL is saved, tested and read back in settings" \
        node "$V/test-searxng.js" "$BROWSER"
    # Issue #202: Fish Audio's current API selects s2.1-pro with a model header.
    run "tts: Fish Audio uses the s2.1-pro model header and current payload" \
        node "$V/test-tts-fish.js" "$BROWSER"
    # Issue #211: Fish Audio has its own model list and field names, separate
    # from the OpenAI-compatible cloud group.
    run "tts: Fish Audio has its own model list and fields" \
        node "$V/test-tts-settings.js" "$BROWSER"
    # Issue #216: first-run setup points pi-searxng at an instance that answers,
    # instead of installing the package and leaving a to-do list.
    run "websearch: first-run setup points pi-searxng at a working instance" \
        node "$V/test-websearch-setup.js" "$BROWSER"
    # The Camoufox half: a failed SearXNG must not hide it, and a `uv tool`
    # install that lands outside the bridge's PATH still has to report ready.
    run "camoufox: a failed SearXNG still installs it, and uv installs report their version" \
        node "$V/test-camoufox-install.js"
    # A Linux host with uv/git and no Docker installs SearXNG into a private
    # venv. The test stubs git/uv and the venv launcher, so nothing is downloaded.
    run "searxng native: without Docker it installs, starts and tests a private SearXNG" \
        node "$V/test-searxng-native.js"
    # Issue #217: a folder you just made, or a session you just filed, shows up
    # without waiting for the 20s list poll.
    run "sessions: a new folder and a filed session show up without a refresh" \
        node "$V/test-session-folders.js" "$BROWSER"
    # Issue #215: a stale extension context reported once per handler on every
    # turn - the page must show one named toast per distinct error, and the
    # bridge must replace the wedged agent instead of leaving it there.
    run "extension errors: one named toast per error, a stale context replaces the agent" \
        node "$V/test-extension-errors.js" "$BROWSER"
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
if [ "$MODE_DOCKER" = 1 ] && { [ "$CHANGED_ONLY" = 0 ] || [ "$DOCKER_RELEVANT" = 1 ]; }; then
  head_ "4. docker — image from docker-compose.yml"
  if ! command -v docker >/dev/null 2>&1; then
    skip "docker not installed"
  elif ! docker info >/dev/null 2>&1; then
    skip "docker daemon not running"
  else
    if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi
    # A native WebUI normally owns 3080, so the compose check must not demand
    # that exact host port. Pick a free one unless the caller chose one.
    if [ -z "${PI_WEBUI_PORT:-}" ]; then
      for candidate in 3080 3090 3091 3092 3093 3094 3095; do
        if command -v ss >/dev/null 2>&1; then
          ss -ltn 2>/dev/null | grep -q "[:.]$candidate " || { PI_WEBUI_PORT=$candidate; break; }
        else
          PI_WEBUI_PORT=$candidate; break
        fi
      done
    fi
    export PI_WEBUI_PORT
    note "container host port: ${PI_WEBUI_PORT:-3080}"
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

    # Remember which image compose actually built before bringing the service
    # down. Compose derives the image name from the checkout directory
    # (<dir>-pi-webui), so looking only for "webui-pi-webui:latest" below made
    # these checks silently skip in every checkout not named "webui". The CI
    # hides that by pre-building webui-pi-webui; a plain clone did not.
    VERIFY_IMG=""
    if $DC up -d pi-webui >"$TMP/up.log" 2>&1; then
      ok "container starts"
      VERIFY_IMG=$(docker inspect -f '{{.Config.Image}}' pi-webui 2>/dev/null || echo "")
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
    # The CI pre-builds webui-pi-webui:latest; prefer it. Otherwise use the
    # image name captured while the compose container was still up.
    if docker image inspect webui-pi-webui:latest >/dev/null 2>&1; then
      VERIFY_IMG=webui-pi-webui:latest
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
  if [ "$CHANGED_ONLY" = 1 ]; then
    printf '%s%d passed%s, %d skipped, %d not affected\n' "$GRN" "$PASS" "$RST" "$SKIP" "$UNCHANGED"
  else
    printf '%s%d passed%s, %d skipped\n' "$GRN" "$PASS" "$RST" "$SKIP"
  fi
else
  printf '%s%d passed%s, %s%d failed%s, %d skipped, %d not affected\n' "$GRN" "$PASS" "$RST" "$RED" "$FAIL" "$RST" "$SKIP" "$UNCHANGED"
fi
# Best effort: a browser process this run started may still hold a file here, and
# a failure to clean up is not a test failure.
rm -rf "$TMP" 2>/dev/null || true
[ "$FAIL" -eq 0 ] || exit 1
