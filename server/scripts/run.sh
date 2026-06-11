#!/usr/bin/env bash
# Supervisor wrapper for evosim-server. Restarts the binary unless it
# exits with EX_TEMPFAIL (75 -- update failed; old binary is still in
# place so we relaunch it). Any other non-zero exit (e.g. panic) also
# restarts, with a small backoff to avoid a crash loop.
#
# Run this from anywhere; the binary path is computed from the script
# location. Configure via the environment:
#   EVOSIM_BIND=0.0.0.0:8080
#   EVOSIM_ADMIN_TOKEN=...        # leave unset to disable admin
#   EVOSIM_REPO_ROOT=/path/to/repo
#   EVOSIM_UPDATE_REF=origin/claude/native-engine
#   EVOSIM_LOG=info,evosim_server=debug

set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
SERVER_DIR="$( cd -- "${SCRIPT_DIR}/.." &> /dev/null && pwd )"
BIN="${SERVER_DIR}/target/release/evosim-server"

if [[ ! -x "${BIN}" ]]; then
    echo "evosim-server binary missing; building..." >&2
    (cd "${SERVER_DIR}" && cargo build --release --locked)
fi

# Repo root defaults to two levels above the server dir, the normal
# layout when the script is run from a checkout.
export EVOSIM_REPO_ROOT="${EVOSIM_REPO_ROOT:-$(cd "${SERVER_DIR}/.." && pwd)}"

backoff=1
while true; do
    set +e
    "${BIN}"
    code=$?
    set -e

    case "${code}" in
        0)
            # Clean exit (restart / update succeeded). Relaunch
            # immediately; reset backoff.
            backoff=1
            ;;
        75)
            # Update failed; the binary on disk may have been
            # clobbered, but the build aborted. Relaunch the current
            # binary (which is still the old one because cargo only
            # writes the artifact on success).
            backoff=1
            ;;
        *)
            echo "evosim-server exited ${code}; restarting in ${backoff}s" >&2
            sleep "${backoff}"
            backoff=$(( backoff * 2 ))
            if (( backoff > 30 )); then backoff=30; fi
            ;;
    esac
done
