#!/usr/bin/env bash
# Pi Agent WebUI launcher for Linux and macOS.
#
# Same job as start-webui.bat: work out where the pi agent lives (installed
# natively, or inside a Docker container), then start the bridge that serves the
# browser UI on http://localhost:3080.
#
# Usage:
#   ./start-webui.sh                     # reuse the saved choice, or ask
#   ./start-webui.sh native              # pi installed on this machine
#   ./start-webui.sh docker <container>  # pi inside that container
#   ./start-webui.sh reset               # forget the choice and ask again
#   PORT=3090 ./start-webui.sh           # a different port (a busy one is fine too)
#   INSTANCE=2 ./start-webui.sh          # a second, separate agent on this PC
#                                        #   (its own pi home, its own port: 3082)
#   INSTANCE=2 PI_WEBUI_PORT=3090 ./start-webui.sh   # …on a port you pick
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$ROOT/bridge"
SOURCE_FILE="${PI_WEBUI_SOURCE_FILE:-$BRIDGE_DIR/agent-source.txt}"
PORT="${PORT:-}"
INSTANCE="${INSTANCE:-}"

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# ── a second agent on this PC ──────────────────────────────────────────────
# pi keeps everything it owns under $HOME/.pi/agent - sessions, auth.json,
# skills, models, settings.json - and the bridge's defaults follow HOME the same
# way. So one variable gives a genuinely separate agent: INSTANCE=2 runs it on
# port 3082 with its home under ~/.pi/webui-instances/2. Nothing is shared
# unless it is linked in on purpose (auth.json or models.json, for one), and
# the instance switcher in the UI finds it on its own once it is up.
if [ -n "$INSTANCE" ]; then
  case "$INSTANCE" in *[!0-9]*|'') die "INSTANCE must be a number (1, 2, 3 …)." ;; esac
  [ "$INSTANCE" -gt 0 ] || die "INSTANCE must be a number (1, 2, 3 …)."
  REAL_HOME="$HOME"
  export HOME="${PI_WEBUI_INSTANCE_HOME:-$REAL_HOME/.pi/webui-instances/$INSTANCE}"
  mkdir -p "$HOME"
  # The pi launcher looks for its managed Node under $HOME. A new instance has
  # no copy there, so without this it falls back to the system Node 18, which is
  # too old for this pi release (enableCompileCache is missing) and the agent
  # exits code 1 while the bridge keeps restarting it. Put the real managed Node
  # on PATH before anything invokes pi.
  for _nodebin in "$REAL_HOME/.local/share/pi-node/current/bin" "${XDG_DATA_HOME:-$REAL_HOME/.local/share}/pi-node/current/bin"; do
    if [ -x "$_nodebin/node" ]; then
      PATH="$_nodebin:$PATH"
      export PATH
      break
    fi
  done
  # HOME is not always enough: pi's own variables override it, and a shell that
  # has them exported (PI_CODING_AGENT_DIR) would point the second agent at the
  # first one's config. Pin every name the two programs read to this home.
  export PI_CODING_AGENT_DIR="$HOME/.pi/agent"
  export PI_CODING_AGENT_SESSION_DIR="$PI_CODING_AGENT_DIR/sessions"
  export PI_AGENT_DIR="$PI_CODING_AGENT_DIR"
  export PI_SESSION_DIR="$PI_CODING_AGENT_SESSION_DIR"
  mkdir -p "$PI_CODING_AGENT_DIR"
  # Share the main agent's configuration and resources - extensions, skills,
  # prompts, themes, packages, MCP servers, models and settings - while keeping
  # sessions and the managed install private. A new instance otherwise starts
  # with none of the extensions the main one has and looks like a different app.
  # A regular file that is already identical to the main one is migrated to a
  # symlink; a file the instance deliberately changed is left alone.
  for _shared in auth.json models.json models-store.json schizodev-catalog.json \
                 settings.json mcp.json mcp-auth.json mcp-cache.json AGENTS.md \
                 extensions skills prompts themes npm pets \
                 webui-settings.json webui-session-modes.json webui-model-cache.json; do
    _src="$REAL_HOME/.pi/agent/$_shared"
    _dst="$PI_CODING_AGENT_DIR/$_shared"
    [ -e "$_src" ] || continue
    if [ -L "$_dst" ]; then continue; fi
    if [ -e "$_dst" ]; then
      if [ -f "$_dst" ] && [ -f "$_src" ] && cmp -s "$_src" "$_dst" 2>/dev/null; then
        rm -f "$_dst"
        ln -s "$_src" "$_dst" 2>/dev/null || cp -R "$_src" "$_dst" 2>/dev/null || true
      fi
      continue
    fi
    ln -s "$_src" "$_dst" 2>/dev/null || cp -R "$_src" "$_dst" 2>/dev/null || true
  done
  # Keep the managed installer pointed at the install this launcher already
  # uses; a fresh HOME has no version cache of its own.
  export PI_MANAGED_INSTALL_ROOT="${PI_MANAGED_INSTALL_ROOT:-$REAL_HOME/.pi/agent/install}"
  PI_INSTANCE_NOTE="instance $INSTANCE — separate home at $HOME"
  # The instance port is its own: an inherited PORT (people export it for their
  # first WebUI) must not put the second agent on top of the first. Pick a port
  # with PI_WEBUI_PORT when the default does not suit.
  PORT="${PI_WEBUI_PORT:-$((3080 + INSTANCE))}"
fi
PORT="${PORT:-3080}"

# ── dependencies ───────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "node is not installed (Node 18+ is needed to run the bridge)."
if [ ! -d "$BRIDGE_DIR/node_modules" ]; then
  say "Installing bridge dependencies…"
  (cd "$BRIDGE_DIR" && npm install --no-fund --no-audit)
fi

# ── which pi? ──────────────────────────────────────────────────────────────
SOURCE=""; CONTAINER=""
case "${1:-}" in
  reset) rm -f "$SOURCE_FILE"; shift || true ;;
  native) SOURCE=native; shift || true ;;
  docker) SOURCE=docker; CONTAINER="${2:-}"; [ -n "$CONTAINER" ] || die "which container? ./start-webui.sh docker <name>"; shift 2 || true ;;
esac

if [ -z "$SOURCE" ] && [ -f "$SOURCE_FILE" ]; then
  # shellcheck disable=SC1090
  . <(sed 's/^/SAVED_/; s/=/="/; s/$/"/' "$SOURCE_FILE")
  SOURCE="${SAVED_source:-}"; CONTAINER="${SAVED_container:-}"
fi

choose_source() {
  say ""
  say " Where does your pi agent run?"
  say "   1. Natively on this machine  (pi CLI installed)"
  say "   2. Inside a Docker container"
  printf 'Select [1/2]: '
  read -r pick || die "no selection made."
  case "$pick" in
    1) SOURCE=native ;;
    2)
      command -v docker >/dev/null 2>&1 || die "docker is not installed, or not on PATH."
      local names
      mapfile -t names < <(docker ps -a --format '{{.Names}}')
      [ "${#names[@]}" -gt 0 ] || die "no Docker containers found."
      say " Containers on this machine:"
      local i=1
      for n in "${names[@]}"; do say "   $i. $n"; i=$((i + 1)); done
      printf 'Pick container number [1-%d]: ' "${#names[@]}"
      read -r num || die "no selection made."
      [[ "$num" =~ ^[0-9]+$ ]] || die "not a number."
      CONTAINER="${names[$((num - 1))]:-}"
      [ -n "$CONTAINER" ] || die "invalid selection."
      SOURCE=docker
      ;;
    *) die "no selection made." ;;
  esac
  # Do not use `[ -n "$CONTAINER" ] && echo ...` here: with `set -e`, the
  # failed test on the native path made the whole launcher exit on the very
  # first run, right after asking where pi lives. The saved file appeared, so
  # the next launch skipped the prompt and worked - exactly the "it closes
  # once, then is fine when reopened" report.
  if [ -n "$CONTAINER" ]; then
    { echo "source=$SOURCE"; echo "container=$CONTAINER"; } > "$SOURCE_FILE"
  else
    echo "source=$SOURCE" > "$SOURCE_FILE"
  fi
}

[ -n "$SOURCE" ] || choose_source

if [ "$SOURCE" = native ]; then
  command -v pi >/dev/null 2>&1 || die "\"pi\" was not found on PATH. Install it with: npm install -g @earendil-works/pi-coding-agent"
  PI_COMMAND="pi --mode rpc"
  PI_SESSION_DIR="${HOME}/.pi/agent/sessions"
  say "Using the pi CLI installed on this machine."
else
  command -v docker >/dev/null 2>&1 || die "docker is not installed, or not on PATH."
  docker start "$CONTAINER" >/dev/null 2>&1 || true
  PI_COMMAND="docker exec -i $CONTAINER pi --mode rpc"
  # The sessions stay inside the container; the bridge reads them through
  # docker exec (listing, transcripts, export and delete all understand this).
  PI_SESSION_DIR="docker:$CONTAINER:/root/.pi/agent/sessions"
  say "Using pi inside the container \"$CONTAINER\"."
fi

# ── is the port already taken? ─────────────────────────────────────────────
if command -v ss >/dev/null 2>&1; then
  HOLDER="$(ss -ltnp 2>/dev/null | grep ":${PORT} " | head -1 || true)"
elif command -v lsof >/dev/null 2>&1; then
  HOLDER="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -1 || true)"
else
  HOLDER=""
fi
if [ -n "$HOLDER" ]; then
  say ""
  say " Something is already listening on port ${PORT}:"
  say "   $HOLDER"
  printf 'Stop it and start a fresh WebUI? [y/N]: '
  read -r answer || answer=''
  case "$answer" in
    y|Y)
      if command -v fuser >/dev/null 2>&1; then fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true; fi
      if command -v lsof >/dev/null 2>&1; then
        pid="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
        [ -n "$pid" ] && kill "$pid" >/dev/null 2>&1 || true
      fi
      sleep 1
      ;;
    *) say "Leaving the running WebUI alone."; exit 0 ;;
  esac
fi

# ── start ──────────────────────────────────────────────────────────────────
# The workspace the agent works in is the repo root: this is the project the
# WebUI is meant to drive.
export PORT PI_COMMAND PI_SESSION_DIR
export WORKSPACE_DIR="${WORKSPACE_DIR:-$ROOT}"

say ""
say "Starting the Pi Agent WebUI on http://localhost:${PORT}"
if [ -n "${PI_INSTANCE_NOTE:-}" ]; then say "  ${PI_INSTANCE_NOTE}"; fi
say "  agent     : $PI_COMMAND"
say "  workspace : $WORKSPACE_DIR"
say "  sessions  : $PI_SESSION_DIR"
say ""
say "Press Ctrl+C to stop (the agent process and the whisper server go with it)."
say "Network access is off unless bridge/lan.json says otherwise - Settings >"
say "General has a switch for it, and the bridge prints the address it binds."

cd "$BRIDGE_DIR"
trap 'kill 0 2>/dev/null || true' INT TERM
node server.js
