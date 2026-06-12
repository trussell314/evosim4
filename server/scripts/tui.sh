#!/usr/bin/env bash
# evosim/tui -- launch the terminal client against a running server.
#
# Reads the same defaults up.sh / down.sh use, so a typical session is:
#
#   server/scripts/up.sh --tmux       # in one shell, returns immediately
#   server/scripts/tui.sh             # in another shell, foreground UI
#   <q to quit>                       # back to the prompt
#   server/scripts/down.sh            # tear it all down
#
# Defaults to ws://127.0.0.1:8080/sim with the token from
# /tmp/evosim-token. Pass --url and --token to point elsewhere.
#
# If the binary is missing this script builds it (release) before
# launching -- so a fresh checkout just works.
#
# CLI:
#   --url WS_URL          server WebSocket URL (default ws://127.0.0.1:8080/sim)
#   --token TOKEN         admin token (default: contents of EVOSIM_TOKEN_FILE)
#   --token-file PATH     read the token from PATH instead
#   --no-token            connect anonymously (observer only)
#   --build               force a `cargo build --release` even if the
#                         binary exists
#   -h, --help            print this header and exit
#
# Env knobs:
#   EVOSIM_TOKEN_FILE     default token path (default /tmp/evosim-token)

set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
SERVER_DIR="$( cd -- "${SCRIPT_DIR}/.." &> /dev/null && pwd )"
BIN="${SERVER_DIR}/target/release/evosim-tui"

URL="ws://127.0.0.1:8080/sim"
TOKEN=""
TOKEN_FILE="${EVOSIM_TOKEN_FILE:-/tmp/evosim-token}"
USE_TOKEN=1
FORCE_BUILD=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --url) URL="$2"; shift 2 ;;
        --token) TOKEN="$2"; USE_TOKEN=1; shift 2 ;;
        --token-file) TOKEN_FILE="$2"; shift 2 ;;
        --no-token) USE_TOKEN=0; shift ;;
        --build) FORCE_BUILD=1; shift ;;
        -h|--help)
            sed -n '2,/^$/p' "${BASH_SOURCE[0]}"
            exit 0
            ;;
        *)
            echo "unknown argument: $1" >&2
            echo "try: $0 --help" >&2
            exit 2
            ;;
    esac
done

# Load the token from disk if the user didn't pass --token directly,
# unless they opted out with --no-token.
if [[ ${USE_TOKEN} == 1 && -z "${TOKEN}" ]]; then
    if [[ -s "${TOKEN_FILE}" ]]; then
        TOKEN="$(<"${TOKEN_FILE}")"
    else
        echo "no token at ${TOKEN_FILE}; connecting anonymously (observer-only)" >&2
        echo "  pass --token VALUE or --no-token to silence this." >&2
        USE_TOKEN=0
    fi
fi

# Build if missing or forced.
if [[ ${FORCE_BUILD} == 1 || ! -x "${BIN}" ]]; then
    echo "[build] cargo build --release -p evosim-tui" >&2
    (cd "${SERVER_DIR}" && cargo build --release --locked -p evosim-tui)
fi

echo "[connect] ${URL}" >&2
if [[ ${USE_TOKEN} == 1 ]]; then
    # Pass the token via env so it doesn't show up in `ps`.
    EVOSIM_ADMIN_TOKEN="${TOKEN}" exec "${BIN}" --url "${URL}"
else
    exec "${BIN}" --url "${URL}"
fi
