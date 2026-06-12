#!/usr/bin/env bash
# evosim/up -- fetch, rebuild, (re)start both the server and the static
# client host, then print every URL the LAN can reach them on.
#
# What it does (in order):
#   1. ensure an admin token exists at $EVOSIM_TOKEN_FILE (default
#      /tmp/evosim-token); does NOT regenerate if one's already there
#   2. stop the running server (pkill -x evosim-server) and any process
#      bound to the client dev-server port
#   3. git fetch + reset --hard the configured update ref (only when
#      the working tree is clean; otherwise skip the reset so local
#      edits aren't blown away)
#   4. cargo build --release for the server (and TUI for convenience)
#   5. npm ci || npm install + npm run build for client-demo
#   6. relaunch the server (via the existing supervisor in run.sh) and
#      the client dev server (`vite --host 0.0.0.0`), both bound to
#      0.0.0.0 so any LAN host can connect
#   7. print every LAN IP and the matching URLs, plus the log file
#      paths and the stop command
#
# Both relaunched processes are detached via `setsid nohup ... &` so
# closing the shell that ran this script doesn't kill them.
#
# Env knobs (all optional):
#   EVOSIM_BIND          server bind (default 0.0.0.0:8080)
#   EVOSIM_CLIENT_PORT   client dev server port (default 5174)
#   EVOSIM_TOKEN_FILE    admin token path (default /tmp/evosim-token)
#   EVOSIM_LOG_DIR       log directory (default /tmp/evosim-logs)
#   EVOSIM_UPDATE_REF    git ref to reset to (default origin/<current branch>)
#   EVOSIM_SKIP_PULL=1   skip git fetch + reset
#   EVOSIM_SKIP_BUILD=1  skip cargo + npm build
#   EVOSIM_SNAPSHOT_HZ   snapshot rate sent to the server (default 30)
#   EVOSIM_PARTICLE_CAP  particle cap (default unset -> engine default of 3000)
#   EVOSIM_GPU_FORCES=1  opt in to the wgpu force kernel
#
# Security: binds are 0.0.0.0 so a phone on the same wifi can connect.
# Admin token gates the destructive ops (Reset, Update server, Update
# client, Save, Load); engine controls (Pause, Resume, SetSimRate) are
# observer-level and unprotected. If you'd rather restrict to localhost,
# pass EVOSIM_BIND=127.0.0.1:8080 (the client dev server will still
# accept LAN connections; pass --host 127.0.0.1 in vite.config.ts or
# unset host to switch).

set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
SERVER_DIR="$( cd -- "${SCRIPT_DIR}/.." &> /dev/null && pwd )"
REPO_ROOT="$( cd -- "${SERVER_DIR}/.." &> /dev/null && pwd )"
CLIENT_DIR="${SERVER_DIR}/client-demo"

SERVER_BIND="${EVOSIM_BIND:-0.0.0.0:8080}"
CLIENT_PORT="${EVOSIM_CLIENT_PORT:-5174}"
TOKEN_FILE="${EVOSIM_TOKEN_FILE:-/tmp/evosim-token}"
LOG_DIR="${EVOSIM_LOG_DIR:-/tmp/evosim-logs}"
SNAPSHOT_HZ="${EVOSIM_SNAPSHOT_HZ:-30}"

# Derive server port from EVOSIM_BIND for the URLs we print.
SERVER_PORT="${SERVER_BIND##*:}"

mkdir -p "${LOG_DIR}"

# ------ token ------------------------------------------------------------
# Keep existing if present; only mint a new one when the file is missing
# or empty.
if [[ ! -s "${TOKEN_FILE}" ]]; then
    if command -v openssl &>/dev/null; then
        openssl rand -hex 32 > "${TOKEN_FILE}"
    else
        head -c 32 /dev/urandom | xxd -p -c 64 > "${TOKEN_FILE}"
    fi
    chmod 600 "${TOKEN_FILE}" || true
    echo "[token] minted at ${TOKEN_FILE}"
else
    echo "[token] reusing ${TOKEN_FILE}"
fi
TOKEN="$(<"${TOKEN_FILE}")"

# ------ stop existing processes -----------------------------------------
echo "[stop] killing any running server/client"
pkill -x evosim-server 2>/dev/null || true
# Client dev server: kill anything on the dev port (Vite + the node
# wrapper around it). Prefer fuser; fall back to lsof; last resort the
# pkill the script-tag pattern Vite uses.
if command -v fuser &>/dev/null; then
    fuser -k -n tcp "${CLIENT_PORT}" 2>/dev/null || true
elif command -v lsof &>/dev/null; then
    lsof -ti tcp:"${CLIENT_PORT}" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
fi
pkill -f "vite.*--port[= ]*${CLIENT_PORT}" 2>/dev/null || true
sleep 1

# ------ pull -------------------------------------------------------------
if [[ "${EVOSIM_SKIP_PULL:-0}" != "1" ]]; then
    cd "${REPO_ROOT}"
    BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"
    UPDATE_REF="${EVOSIM_UPDATE_REF:-origin/${BRANCH}}"
    echo "[pull] git fetch --prune origin"
    git fetch --prune origin
    if [[ -z "$(git status --porcelain)" ]]; then
        echo "[pull] git reset --hard ${UPDATE_REF}"
        git reset --hard "${UPDATE_REF}"
    else
        echo "[pull] working tree dirty -- skipping reset (use EVOSIM_SKIP_PULL=1 to silence)"
    fi
else
    echo "[pull] skipped (EVOSIM_SKIP_PULL=1)"
fi

# ------ build ------------------------------------------------------------
if [[ "${EVOSIM_SKIP_BUILD:-0}" != "1" ]]; then
    echo "[build] cargo build --release (server + tui)"
    (cd "${SERVER_DIR}" && cargo build --release --locked -p evosim-server -p evosim-tui)
    echo "[build] npm ci || npm install + npm run build (client-demo)"
    if [[ ! -d "${CLIENT_DIR}/node_modules" ]] || ! (cd "${CLIENT_DIR}" && npm ci --silent 2>/dev/null); then
        (cd "${CLIENT_DIR}" && npm install --silent)
    fi
    (cd "${CLIENT_DIR}" && npm run build --silent)
else
    echo "[build] skipped (EVOSIM_SKIP_BUILD=1)"
fi

# ------ start server -----------------------------------------------------
echo "[start] evosim-server (via supervisor)"
cd "${SERVER_DIR}"
env EVOSIM_BIND="${SERVER_BIND}" \
    EVOSIM_ADMIN_TOKEN="${TOKEN}" \
    EVOSIM_REPO_ROOT="${REPO_ROOT}" \
    EVOSIM_SNAPSHOT_HZ="${SNAPSHOT_HZ}" \
    ${EVOSIM_PARTICLE_CAP:+EVOSIM_PARTICLE_CAP="${EVOSIM_PARTICLE_CAP}"} \
    ${EVOSIM_GPU_FORCES:+EVOSIM_GPU_FORCES="${EVOSIM_GPU_FORCES}"} \
    setsid nohup "${SCRIPT_DIR}/run.sh" \
        > "${LOG_DIR}/server.log" 2>&1 < /dev/null &
SERVER_PID=$!
disown ${SERVER_PID} 2>/dev/null || true

# ------ start client dev server -----------------------------------------
echo "[start] vite (client-demo dev server, host 0.0.0.0)"
cd "${CLIENT_DIR}"
setsid nohup ./node_modules/.bin/vite \
    --host 0.0.0.0 --port "${CLIENT_PORT}" --strictPort \
        > "${LOG_DIR}/client.log" 2>&1 < /dev/null &
CLIENT_PID=$!
disown ${CLIENT_PID} 2>/dev/null || true

# Give them a moment to bind.
sleep 2

# ------ status -----------------------------------------------------------
SERVER_OK="no"; CLIENT_OK="no"
ps -p ${SERVER_PID} >/dev/null 2>&1 && SERVER_OK="yes"
ps -p ${CLIENT_PID} >/dev/null 2>&1 && CLIENT_OK="yes"

# Collect every LAN address (IPv4 only; phones / laptops want the
# numeric URL so they don't need DNS). `hostname -I` is the cheapest
# way on Linux. Fall back to `ip addr` if it's not present.
addrs() {
    if command -v hostname >/dev/null 2>&1 && hostname -I >/dev/null 2>&1; then
        hostname -I 2>/dev/null | tr ' ' '\n'
    elif command -v ip >/dev/null 2>&1; then
        ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1
    fi
}

mapfile -t IPS < <(addrs | grep -v '^$' | sort -u)
[[ ${#IPS[@]} -eq 0 ]] && IPS=("127.0.0.1")

printf '\n'
printf '==============================================\n'
printf 'evosim is up\n'
printf '----------------------------------------------\n'
printf '  server          %s   (pid %s)\n' "${SERVER_OK}" "${SERVER_PID}"
printf '  client          %s   (pid %s)\n' "${CLIENT_OK}" "${CLIENT_PID}"
printf '  snapshot rate   %s Hz\n' "${SNAPSHOT_HZ}"
printf '  token file      %s\n' "${TOKEN_FILE}"
printf '  token prefix    %s…\n' "${TOKEN:0:8}"
printf '\n'
printf 'Reachable URLs (open one of these in the browser, paste\n'
printf 'the matching ws://... into the server field, then the token):\n'
for ip in "${IPS[@]}"; do
    printf '  http://%s:%s/   <-->   ws://%s:%s/sim\n' \
        "${ip}" "${CLIENT_PORT}" "${ip}" "${SERVER_PORT}"
done
printf '\n'
printf 'Logs:\n'
printf '  server : %s/server.log\n' "${LOG_DIR}"
printf '  client : %s/client.log\n' "${LOG_DIR}"
printf '\n'
printf 'Stop everything:\n'
printf '  pkill -x evosim-server; fuser -k -n tcp %s 2>/dev/null || true\n' "${CLIENT_PORT}"
printf '==============================================\n'
