# evosim native server

Rust port of the evosim4 engine, served over WebSocket to a browser
client (and a terminal client). This directory is a Cargo workspace.

## Quickstart

All commands run from this `server/` directory.

### One-shot launcher (recommended)

```sh
./scripts/up.sh
```

Builds the server + web client, launches both detached (bound to
`0.0.0.0`, lowest CPU/IO priority), and prints every LAN URL plus the
admin-token path and log files. Survives closing the shell. Stop with:

```sh
./scripts/down.sh
```

Common overrides (env prefix on the same command):

| example                                   | effect |
|-------------------------------------------|--------|
| `EVOSIM_SKIP_PULL=1 ./scripts/up.sh`      | don't `git reset` — keep local edits |
| `EVOSIM_SKIP_BUILD=1 ./scripts/up.sh`     | skip rebuild, just relaunch |
| `./scripts/up.sh --tmux`                  | run under tmux so you can attach |
| `EVOSIM_PARTICLE_CAP=8000 ./scripts/up.sh`| override the particle cap |

> `up.sh` does a `git fetch + reset --hard` to `EVOSIM_UPDATE_REF`
> **only when the working tree is clean**. With uncommitted edits it
> skips the reset; use `EVOSIM_SKIP_PULL=1` to be sure.

### Manual (foreground)

```sh
# terminal 1 — server on ws://<host>:8080/sim
cargo run --release -p evosim-server

# terminal 2 — web client (default http://<host>:5174)
cd client-demo && npm install && npm run dev -- --host 0.0.0.0
```

In the client, set the **server** field to `ws://<host>:8080/sim`. The
admin token (needed for Reset / Configure / Settings / Ecology) is
written to `/tmp/evosim-token` by `up.sh`; paste it into the **token**
field. Running the server manually sets no token unless you pass
`EVOSIM_ADMIN_TOKEN` (see [Build / run](#build--run) below).

### Terminal client (no browser)

```sh
./scripts/tui.sh            # auto-connects to the running server
```

### Headless (no UI — quick behavior checks)

```sh
cargo run --release -p evosim-headless -- --ticks 36000 --report-every 3000
```

Runs the engine in-process and prints periodic population / chemistry
stats. Flags: `--load`/`--out` (save round-trip), `--mutation-rate`,
`--particle-cap`, `--width`/`--height`/`--seed`/`--day-period-s`,
`--quiet`.

## Layout

```
server/
  Cargo.toml                      # workspace
  rust-toolchain.toml             # stable + rustfmt + clippy
  scripts/run.sh                  # supervisor wrapper
  crates/
    evosim-protocol/              # wire types (Serde + msgpack)
    evosim-engine/                # ported sim; stub today
    evosim-server/                # axum binary
```

## Build / run

```sh
cd server
cargo build --release
EVOSIM_BIND=0.0.0.0:8080 \
EVOSIM_ADMIN_TOKEN="$(openssl rand -hex 32)" \
./scripts/run.sh
```

The wrapper script relaunches the binary on a clean exit so admin
restart / update work end-to-end without systemd.

## Environment

| var                  | default                              | meaning |
|----------------------|--------------------------------------|---------|
| `EVOSIM_BIND`        | `0.0.0.0:8080`                       | listen address |
| `EVOSIM_ADMIN_TOKEN` | *(unset disables admin)*             | bearer token for `ClientMessage::Auth` |
| `EVOSIM_REPO_ROOT`   | `cwd`                                | where `git pull`/`cargo build` run during update |
| `EVOSIM_UPDATE_REF`  | `origin/claude/native-engine`        | default git ref used by `AdminCommand::Update` |
| `EVOSIM_LOG`         | `info,evosim_server=debug`           | `tracing-subscriber` filter |

## Protocol overview

Binary msgpack frames in both directions. The schema is defined in
`crates/evosim-protocol/src/lib.rs`; the major in `PROTOCOL_VERSION`
bumps on any breaking change.

Server -> client (`ServerMessage`):
- `Hello { protocol, build, capabilities }` -- first frame after
  handshake (and again after a successful `Auth` to refresh the
  capabilities).
- `Snapshot(...)` -- at ~10 Hz. Contains tick, sim time, world
  dimensions, particle / creature SoA blobs, dispatch status.
- `Error { code, message }` -- non-fatal.
- `Goodbye { reason }` -- server going down.
- `AdminAck { command, message }` / `AdminNack { command, reason }`.

Client -> server (`ClientMessage`):
- `Auth { token: Option<String> }` -- optional, presents the admin
  bearer token. Server replies with a fresh `Hello`.
- `SetRunning { running }`, `SetSimRate { rate }`, `Save { name }` --
  controller commands. Today the engine task replies with an
  `unimplemented` error; they wire up with the engine port.
- `Admin { command }` -- privileged. Nacked unless the connection has
  passed `Auth` with the right token.

## Admin commands

All require a prior `Auth` carrying `EVOSIM_ADMIN_TOKEN`.

| command   | effect |
|-----------|--------|
| `Restart` | sends `Goodbye` to all clients, exits the binary cleanly; the wrapper script (or systemd) relaunches |
| `Update { branch? }` | `git fetch && git reset --hard <branch>` then `cargo build --release`. On success exits the binary; the wrapper relaunches into the new artifact. On failure surfaces a `Nack` and stays alive on the existing binary |
| `Snapshot` | forces an immediate out-of-cadence snapshot broadcast |
| `Reset`   | drops world state, starts a fresh one (no socket disruption) |
| `Status`  | returns a small JSON blob in `AdminAck::message` |

The supervisor wrapper distinguishes exit codes:
- `0`     -- clean exit, restart immediately
- `75`    -- `EX_TEMPFAIL`, an update failed mid-flight; relaunch the
  current binary (cargo only writes the artifact on success, so it's
  the old code)
- any other -- restart with exponential backoff up to 30 s

## Home-network hosting

Three layered options, none requiring Tailscale or a static IP:

1. **Cloudflare Tunnel (recommended).** Ready-to-use config and runner
   script in `server/cloudflared/`. Quick-tunnel mode gives you an
   ephemeral `*.trycloudflare.com` URL with `./server/scripts/tunnel.sh
   quick`. Named-tunnel mode adds Cloudflare Access (free; gates by
   email/Google/GitHub) as an independent second layer on top of the
   admin bearer token. No router config, no port forwarding, TLS
   terminates at Cloudflare. Full setup walkthrough in
   `server/cloudflared/README.md`.

2. **Caddy + Let's Encrypt + port forward 443.** If you control the
   router. Caddy auto-provisions a cert if you have a domain. TLS +
   HTTP/3, then `evosim-server` listens on localhost. Add a Caddy
   `basic_auth` directive on `/sim` if you want a second layer.

3. **WireGuard endpoint hosted on a $5 VPS.** Only your peers reach
   the home box. Slightly more setup than (1) but doesn't depend on
   Cloudflare.

In all three cases the admin token never crosses an untrusted hop in
the clear: TLS to the edge, then the bearer token is what the
`evosim-server` actually checks. Set `EVOSIM_ADMIN_TOKEN` to 32+
random bytes (`openssl rand -hex 32`) and store it in a secrets
manager rather than the script.

## Future commits

- Port the chemistry / VM / reaction tables into `evosim-engine`.
- Port spatial structures + force / collision kernels with rayon.
- Wire wgpu compute for the force pass.
- Replace controller-command `unimplemented` errors with real wiring.
- Save / load round-trip with the existing JSON save schema.
- Replace the `ws::ENGINE_CMD` OnceLock with an Arc on AppState once
  controller commands need it.
