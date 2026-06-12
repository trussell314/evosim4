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
# Both server + client run at the lowest CPU + I/O priority the OS
# offers (nice 19 + ionice -c 3 on Linux, taskpolicy -b on macOS) so
# other workloads on the host take precedence. If `--tmux` is used,
# the supervisor inside tmux is wrapped the same way so the niceness
# applies to every relaunch.
#
# Env knobs (all optional):
#   EVOSIM_BIND          server bind (default 0.0.0.0:8080)
#   EVOSIM_CLIENT_PORT   client dev server port (default 5174)
#   EVOSIM_TOKEN_FILE    admin token path (default /tmp/evosim-token)
#   EVOSIM_LOG_DIR       log directory (default /tmp/evosim-logs)
#   EVOSIM_UPDATE_REF    git ref to reset to (default origin/<current branch>)
#   EVOSIM_NICE          nice value for server/client (default 19, range -20..19)
#   EVOSIM_SKIP_PULL=1   skip git fetch + reset
#   EVOSIM_SKIP_BUILD=1  skip cargo + npm build
#   EVOSIM_SNAPSHOT_HZ   snapshot rate sent to the server (default 30)
#   EVOSIM_PARTICLE_CAP  particle cap (default unset -> engine default of 3000)
#   EVOSIM_GPU_FORCES=1  opt in to the wgpu force kernel
#                        (also picks the LowPower adapter so other GPU
#                         workloads on the same host aren't starved)
#
# Security: binds are 0.0.0.0 so a phone on the same wifi can connect.
# Admin token gates the destructive ops (Reset, Update server, Update
# client, Save, Load); engine controls (Pause, Resume, SetSimRate) are
# observer-level and unprotected. If you'd rather restrict to localhost,
# pass EVOSIM_BIND=127.0.0.1:8080 (the client dev server will still
# accept LAN connections; pass --host 127.0.0.1 in vite.config.ts or
# unset host to switch).

set -euo pipefail

# Portable detached-launch helper. Uses `setsid` if available (Linux),
# otherwise falls back to plain `nohup` + `disown` (macOS / BSD), which
# survives terminal closure the same way -- the controlling tty is
# discarded via I/O redirection + SIGHUP is ignored via nohup + the
# shell drops the job table entry via disown.
#
# Always exits 0 so `VAR=$(detach)` is safe under `set -e` even when
# setsid is missing (which would otherwise short-circuit to exit 1 and
# kill the script).
detach() {
    if command -v setsid >/dev/null 2>&1; then
        echo "setsid"
    fi
    return 0
}

# Background-priority prefix. Wraps a command with everything needed
# to make other workloads on the host take precedence:
#
#   - `nice -n ${EVOSIM_NICE:-19}` lowers CPU scheduling priority
#     (19 is the most generous value on every Unix; the kernel only
#     runs the process when nothing else wants the CPU).
#   - `ionice -c 3` on Linux puts disk I/O in the idle class (no
#     reads/writes while another process is waiting for the disk).
#   - `taskpolicy -b` on macOS puts the process in Darwin's
#     background priority class (lowered CPU + I/O + QoS tier).
#
# All three are *prefixes* -- the resulting string is meant to be
# stitched in front of the actual launch command. Returns 0 even when
# none of the tools are installed; we fall back to plain `nice` then
# to nothing rather than failing the launch.
nice_prefix() {
    local parts=()
    local nval="${EVOSIM_NICE:-19}"
    if command -v nice >/dev/null 2>&1; then
        parts+=("nice" "-n" "${nval}")
    fi
    case "$(uname -s 2>/dev/null)" in
        Linux)
            command -v ionice >/dev/null 2>&1 && parts+=("ionice" "-c" "3")
            ;;
        Darwin)
            command -v taskpolicy >/dev/null 2>&1 && parts+=("taskpolicy" "-b")
            ;;
    esac
    printf '%s ' "${parts[@]}"
    return 0
}

# Kill anything bound to a given TCP port. Tries lsof first (macOS +
# most Linux distros), falls back to fuser (Linux). Silent if nothing
# was bound.
kill_tcp_port() {
    local port="$1"
    if command -v lsof >/dev/null 2>&1; then
        local pids
        pids="$(lsof -ti tcp:"${port}" 2>/dev/null || true)"
        if [[ -n "${pids}" ]]; then
            kill -9 ${pids} 2>/dev/null || true
        fi
    elif command -v fuser >/dev/null 2>&1; then
        fuser -k -n tcp "${port}" 2>/dev/null || true
    fi
}

# Enumerate IPv4 addresses across all non-loopback interfaces. Linux,
# macOS, BSD all have one of these.
list_addresses() {
    if command -v hostname >/dev/null 2>&1 && hostname -I >/dev/null 2>&1; then
        # GNU hostname (Linux)
        hostname -I 2>/dev/null | tr ' ' '\n'
    elif command -v ip >/dev/null 2>&1; then
        ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1
    elif command -v ifconfig >/dev/null 2>&1; then
        # BSD ifconfig (macOS). Skip 127.* loopback + link-local 169.254/16.
        ifconfig 2>/dev/null | awk '
            /^[a-z]/ { iface=$1 }
            /inet / && $2 !~ /^127\./ && $2 !~ /^169\.254\./ { print $2 }
        '
    fi
}

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

# ------ argument parsing -------------------------------------------------
USE_TMUX=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --tmux)
            USE_TMUX=1
            shift
            ;;
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
if [[ ${USE_TMUX} == 1 ]] && ! command -v tmux >/dev/null 2>&1; then
    echo "--tmux requested but tmux is not installed" >&2
    exit 1
fi

# ------ defaults the trap depends on -----------------------------------
# Set BEFORE pull/build/launch so the EXIT-trap status banner still
# prints (with whatever we managed to do) if something later fails
# under `set -e`.
SERVER_OK="no"; CLIENT_OK="no"
SERVER_PID="?"; CLIENT_PID="?"
SERVER_PORT="${SERVER_BIND##*:}"

print_status() {
    local rc=$?
    if [[ ${USE_TMUX} == 1 ]]; then
        if command -v tmux >/dev/null 2>&1 && tmux has-session -t evosim 2>/dev/null; then
            SERVER_OK="yes"
            CLIENT_OK="yes"
        fi
    else
        ps -p "${SERVER_PID}" >/dev/null 2>&1 && SERVER_OK="yes" || true
        ps -p "${CLIENT_PID}" >/dev/null 2>&1 && CLIENT_OK="yes" || true
    fi

    local IPS=()
    local line
    while IFS= read -r line; do
        [[ -n "${line}" ]] && IPS+=("${line}")
    done < <(list_addresses 2>/dev/null | sort -u)
    if [[ ${#IPS[@]} -eq 0 ]]; then
        IPS=("127.0.0.1")
    fi

    # NB: every printf format that begins with `-` (e.g. `'----'`) is
    # passed through `'%s\n' '----'` so bash's printf builtin doesn't
    # mistake the leading dashes for option flags.
    printf '\n'
    printf '%s\n' '=============================================='
    if [[ ${rc} -ne 0 ]]; then
        printf 'evosim: setup exited with status %s\n' "${rc}"
        printf '%s\n' '(some steps may have been skipped; check log files)'
    else
        printf '%s\n' 'evosim is up'
    fi
    printf '%s\n' '----------------------------------------------'
    printf '  server          %s   (pid %s)\n' "${SERVER_OK}" "${SERVER_PID}"
    printf '  client          %s   (pid %s)\n' "${CLIENT_OK}" "${CLIENT_PID}"
    printf '  snapshot rate   %s Hz\n' "${SNAPSHOT_HZ}"
    printf '  token file      %s\n' "${TOKEN_FILE}"
    printf '  token prefix    %s...\n' "${TOKEN:0:8}"
    printf '\n'
    printf '%s\n' 'Reachable URLs (open one of these in the browser, paste'
    printf '%s\n' 'the matching ws://... into the server field, then the token):'
    local ip
    for ip in "${IPS[@]}"; do
        printf '  http://%s:%s/   <-->   ws://%s:%s/sim\n' \
            "${ip}" "${CLIENT_PORT}" "${ip}" "${SERVER_PORT}"
    done
    printf '\n'
    if [[ ${USE_TMUX} == 1 ]]; then
        printf '%s\n' 'Logs / live output:'
        printf '%s\n' '  tmux attach -t evosim         # Ctrl-b 0/1 to switch windows'
        printf '%s\n' '  tmux attach -t evosim:server  # land directly in the server window'
        printf '%s\n' '  tmux capture-pane -t evosim:server -p | tail -50'
        printf '\n'
        printf '%s\n' 'Stop everything:'
        printf '  %s/down.sh\n' "${SCRIPT_DIR}"
    else
        printf '%s\n' 'Logs:'
        printf '  server : %s/server.log\n' "${LOG_DIR}"
        printf '  client : %s/client.log\n' "${LOG_DIR}"
        printf '\n'
        printf '%s\n' 'Stop everything:'
        printf '  %s/down.sh\n' "${SCRIPT_DIR}"
    fi
    printf '%s\n' '=============================================='
}
trap print_status EXIT

# ------ stop existing processes -----------------------------------------
echo "[stop] killing any running server/client"
pkill -x evosim-server 2>/dev/null || true
# Kill the supervisor wrapper if it's running (so it doesn't relaunch
# the binary we just killed).
pkill -f "scripts/run\.sh$" 2>/dev/null || true
kill_tcp_port "${CLIENT_PORT}"
pkill -f "vite.*--port[= ]*${CLIENT_PORT}" 2>/dev/null || true
# Tear down any prior tmux session we own so the new launch starts clean.
tmux kill-session -t evosim 2>/dev/null || true
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

# ------ start server + client --------------------------------------------
SERVER_LAUNCHER="$(detach)"
# Lowest-priority CPU + I/O so other workloads on the host take
# precedence. nice 19 on every Unix, plus ionice -c 3 on Linux or
# taskpolicy -b on macOS. The supervisor is also wrapped so its child
# (the evosim-server binary) inherits the niceness on every restart.
NICE_PREFIX="$(nice_prefix)"

# Optional env vars get folded into a flat string that's safe to inline
# in either the tmux command or the detached background launch. The
# values come from this script's env so they don't need to be shell-
# quoted -- they're already valid identifiers (numeric/0/1/etc).
OPT_ENV=""
[[ -n "${EVOSIM_PARTICLE_CAP:-}" ]] && \
    OPT_ENV+="EVOSIM_PARTICLE_CAP=${EVOSIM_PARTICLE_CAP} "
[[ -n "${EVOSIM_GPU_FORCES:-}" ]] && \
    OPT_ENV+="EVOSIM_GPU_FORCES=${EVOSIM_GPU_FORCES} "

if [[ ${USE_TMUX} == 1 ]]; then
    echo "[start] tmux session 'evosim' (server + client, background-priority)"
    # Server window: cd + env + nice + supervisor wrapper. tmux holds
    # the pty for each command; logs stream live there. The session is
    # detached (-d) so this script returns immediately.
    tmux new-session -d -s evosim -n server -c "${SERVER_DIR}" \
        "EVOSIM_BIND='${SERVER_BIND}' \
         EVOSIM_ADMIN_TOKEN='${TOKEN}' \
         EVOSIM_REPO_ROOT='${REPO_ROOT}' \
         EVOSIM_SNAPSHOT_HZ='${SNAPSHOT_HZ}' \
         ${OPT_ENV} \
         exec ${NICE_PREFIX} '${SCRIPT_DIR}/run.sh'"
    tmux new-window -t evosim:1 -n client -c "${CLIENT_DIR}" \
        "exec ${NICE_PREFIX} ./node_modules/.bin/vite --host 0.0.0.0 \
         --port ${CLIENT_PORT} --strictPort"
    SERVER_PID="tmux:evosim:server"
    CLIENT_PID="tmux:evosim:client"
else
    echo "[start] evosim-server (via supervisor, detached, background-priority)"
    cd "${SERVER_DIR}"
    env EVOSIM_BIND="${SERVER_BIND}" \
        EVOSIM_ADMIN_TOKEN="${TOKEN}" \
        EVOSIM_REPO_ROOT="${REPO_ROOT}" \
        EVOSIM_SNAPSHOT_HZ="${SNAPSHOT_HZ}" \
        ${EVOSIM_PARTICLE_CAP:+EVOSIM_PARTICLE_CAP="${EVOSIM_PARTICLE_CAP}"} \
        ${EVOSIM_GPU_FORCES:+EVOSIM_GPU_FORCES="${EVOSIM_GPU_FORCES}"} \
        ${SERVER_LAUNCHER} nohup ${NICE_PREFIX} "${SCRIPT_DIR}/run.sh" \
            > "${LOG_DIR}/server.log" 2>&1 < /dev/null &
    SERVER_PID=$!
    disown ${SERVER_PID} 2>/dev/null || true

    echo "[start] vite (client-demo dev server, host 0.0.0.0, detached, background-priority)"
    cd "${CLIENT_DIR}"
    ${SERVER_LAUNCHER} nohup ${NICE_PREFIX} ./node_modules/.bin/vite \
        --host 0.0.0.0 --port "${CLIENT_PORT}" --strictPort \
            > "${LOG_DIR}/client.log" 2>&1 < /dev/null &
    CLIENT_PID=$!
    disown ${CLIENT_PID} 2>/dev/null || true
fi

# Give them a moment to bind. The status banner prints from the EXIT
# trap armed near the top, so we don't repeat it inline here.
sleep 2
