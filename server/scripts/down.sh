#!/usr/bin/env bash
# evosim/down -- stop everything `up.sh` started.
#
# Idempotent: safe to run when nothing's running. Doesn't touch saves
# or the token file -- next `up.sh` reuses both.
#
# What it kills:
#   - the tmux session named `evosim` (covers both launch paths)
#   - any running `evosim-server` binary
#   - the supervisor wrapper `run.sh` (so it doesn't relaunch the
#     binary we just killed)
#   - anything bound to the client dev-server TCP port (Vite + the
#     node wrapper around it)
#   - any leftover `vite` process pointing at that port
#
# Env knobs:
#   EVOSIM_CLIENT_PORT   client dev port (default 5174)

set -euo pipefail

CLIENT_PORT="${EVOSIM_CLIENT_PORT:-5174}"

# Helper: kill anything bound to the given TCP port. lsof first (macOS
# + most Linux), fuser fallback (some Linux distros without lsof).
kill_tcp_port() {
    local port="$1"
    if command -v lsof >/dev/null 2>&1; then
        local pids
        pids="$(lsof -ti tcp:"${port}" 2>/dev/null || true)"
        if [[ -n "${pids}" ]]; then
            kill -9 ${pids} 2>/dev/null || true
            echo "  killed pids on tcp:${port}: ${pids}"
        fi
    elif command -v fuser >/dev/null 2>&1; then
        fuser -k -n tcp "${port}" 2>/dev/null && echo "  freed tcp:${port}" || true
    fi
}

echo "[down] stopping evosim"

# tmux session (no-op if --tmux wasn't used)
if command -v tmux >/dev/null 2>&1 && tmux has-session -t evosim 2>/dev/null; then
    tmux kill-session -t evosim
    echo "  killed tmux session 'evosim'"
fi

# Server binary + its supervisor wrapper. Order matters: kill the
# supervisor first (it would otherwise relaunch the binary the moment
# we kill it), then the binary itself. Repeat once after a short
# settle to catch a respawn race (the supervisor sometimes manages to
# fork+exec a child between our SIGTERM-to-supervisor and the next
# kill -- after a 200 ms pause both sides are gone).
kill_server_tree() {
    if pgrep -f "scripts/run\.sh$" >/dev/null 2>&1; then
        pkill -f "scripts/run\.sh$" 2>/dev/null || true
        echo "  killed supervisor (run.sh)"
    fi
    if pgrep -x evosim-server >/dev/null 2>&1; then
        pkill -9 -x evosim-server 2>/dev/null || true
        echo "  killed evosim-server"
    fi
}
kill_server_tree
sleep 0.2
# Second pass catches anything the supervisor re-spawned in the gap.
if pgrep -x evosim-server >/dev/null 2>&1 || pgrep -f "scripts/run\.sh$" >/dev/null 2>&1; then
    kill_server_tree
fi

# Client dev server
kill_tcp_port "${CLIENT_PORT}"
if pgrep -f "vite.*--port[= ]*${CLIENT_PORT}" >/dev/null 2>&1; then
    pkill -f "vite.*--port[= ]*${CLIENT_PORT}" 2>/dev/null || true
    echo "  killed vite (port ${CLIENT_PORT})"
fi

# Settle, then verify.
sleep 1
still_up=()
pgrep -x evosim-server >/dev/null 2>&1 && still_up+=("evosim-server")
pgrep -f "scripts/run\.sh$" >/dev/null 2>&1 && still_up+=("run.sh")
pgrep -f "vite.*--port[= ]*${CLIENT_PORT}" >/dev/null 2>&1 && still_up+=("vite")
if command -v tmux >/dev/null 2>&1 && tmux has-session -t evosim 2>/dev/null; then
    still_up+=("tmux evosim")
fi

if [[ ${#still_up[@]} -gt 0 ]]; then
    echo "[down] still running: ${still_up[*]}" >&2
    exit 1
fi
echo "[down] all stopped"
