#!/usr/bin/env bash
# Run evosim-server + cloudflared together. Two modes:
#
#   ./tunnel.sh quick           -- ephemeral *.trycloudflare.com URL
#                                  (no CF account, no DNS, no Access)
#   ./tunnel.sh named [config]  -- persistent named tunnel; see
#                                  server/cloudflared/config.example.yml
#                                  for setup.
#
# Both modes spawn cloudflared as a child of this script and forward
# SIGTERM/SIGINT so ctrl-c shuts the whole pipeline down cleanly.
# server/scripts/run.sh handles supervisor-style restart for the
# evosim-server binary; this script just glues the tunnel onto whatever
# it's running.
#
# Defaults assume `EVOSIM_BIND=127.0.0.1:8080`. When using a tunnel
# you almost certainly want loopback-only -- there's no reason to
# expose the raw port to the LAN simultaneously.

set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
SERVER_DIR="$( cd -- "${SCRIPT_DIR}/.." &> /dev/null && pwd )"

MODE="${1:-quick}"
shift || true

case "${MODE}" in
    quick)
        URL="${EVOSIM_LOCAL_URL:-http://127.0.0.1:8080}"
        echo "[tunnel] quick mode: cloudflared tunnel --url ${URL}" >&2
        ;;
    named)
        CONFIG="${1:-${SERVER_DIR}/cloudflared/config.yml}"
        if [[ ! -f "${CONFIG}" ]]; then
            echo "[tunnel] config not found at ${CONFIG}" >&2
            echo "[tunnel] copy cloudflared/config.example.yml and edit it" >&2
            exit 2
        fi
        echo "[tunnel] named mode: cloudflared tunnel --config ${CONFIG} run" >&2
        ;;
    *)
        echo "usage: $0 {quick|named [config]}" >&2
        exit 2
        ;;
esac

if ! command -v cloudflared >/dev/null 2>&1; then
    cat >&2 <<EOF
[tunnel] cloudflared not on PATH.
Install:
  macOS:   brew install cloudflared
  Linux:   https://pkg.cloudflare.com/index.html
EOF
    exit 127
fi

# Default the server to loopback when running under the tunnel.
export EVOSIM_BIND="${EVOSIM_BIND:-127.0.0.1:8080}"
if [[ "${EVOSIM_BIND}" != 127.0.0.1:* && "${EVOSIM_BIND}" != localhost:* ]]; then
    echo "[tunnel] warning: EVOSIM_BIND=${EVOSIM_BIND} exposes the port directly," \
         "consider 127.0.0.1:..." >&2
fi

# Start the server (under its supervisor wrapper so restart works).
"${SERVER_DIR}/scripts/run.sh" &
SERVER_PID=$!

# Spawn cloudflared.
case "${MODE}" in
    quick)
        cloudflared tunnel --no-autoupdate --url "${URL}" &
        TUNNEL_PID=$!
        ;;
    named)
        cloudflared tunnel --no-autoupdate --config "${CONFIG}" run &
        TUNNEL_PID=$!
        ;;
esac

cleanup() {
    echo "[tunnel] shutting down" >&2
    kill "${TUNNEL_PID}" 2>/dev/null || true
    kill "${SERVER_PID}" 2>/dev/null || true
    wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# Wait on either child. If one dies, take the other down with it -- a
# tunnel without a server is useless and vice versa.
wait -n "${SERVER_PID}" "${TUNNEL_PID}"
EXIT_CODE=$?
echo "[tunnel] one of the children exited (${EXIT_CODE}); tearing down" >&2
cleanup
exit "${EXIT_CODE}"
