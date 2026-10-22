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
SOURCE_FILE="$BRIDGE_DIR/agent-source.txt"
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
  # HOME is not always enough: pi's own variables override it, and a shell that
  # has them exported (PI_CODING_AGENT_DIR) would point the second agent at the
  # first one's config. Pin every name the two programs read to this home.
  export PI_CODING_AGENT_DIR="$HOME/.pi/agent"
  export PI_CODING_AGENT_SESSION_DIR="$PI_CODING_AGENT_DIR/sessions"
  export PI_AGENT_DIR="$PI_CODING_AGENT_DIR"
  export PI_SESSION_DIR="$PI_CODING_AGENT_SESSION_DIR"
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
  read -r pick
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
      read -r num
      [[ "$num" =~ ^[0-9]+$ ]] || die "not a number."
      CONTAINER="${names[$((num - 1))]:-}"
      [ -n "$CONTAINER" ] || die "invalid selection."
      SOURCE=docker
      ;;
    *) die "no selection made." ;;
  esac
  { echo "source=$SOURCE"; [ -n "$CONTAINER" ] && echo "container=$CONTAINER"; } > "$SOURCE_FILE"
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
  read -r answer
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
[ -n "${PI_INSTANCE_NOTE:-}" ] && say "  ${PI_INSTANCE_NOTE}"
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
