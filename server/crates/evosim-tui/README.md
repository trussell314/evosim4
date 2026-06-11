# evosim-tui

Terminal client for `evosim-server`. Speaks the same WebSocket /
msgpack protocol as the browser demo, but renders into the terminal
via ratatui.

## Build / run

```sh
# From server/
cargo build --release -p evosim-tui

# Connect to a local server:
./target/release/evosim-tui

# Custom URL + admin token:
./target/release/evosim-tui \
  --url ws://my-host:8080/sim \
  --token "$(cat /etc/evosim/admin-token)"

# Token also reads from EVOSIM_ADMIN_TOKEN.
```

## Layout

```
 ┌─ status ────────────────────────────────────────────────┐
 │ t=… cells=… species=… bonds=… mass=… light=… rate=…     │
 ├─ world ─────────────────────────────┬─ species ─────────┤
 │ A . . . . . B B  . . . . . . . . .  │ glyph count mass  │
 │ . . . . . . . . A . . . . . . . . . │ A      8    1871  │
 │ . . . . . . . . . . . . . . . . . . │ B      8    3509  │
 │ . . . . . . . . . . . . . . . . . . │ C      4    2229  │
 ├─ keys ──────────────────────────────┴───────────────────┤
 │ q quit  p pause  r resume  ]/[ rate +/-  s save  x reset │
 └──────────────────────────────────────────────────────────┘
```

Cells are placed in a grid scaled to the terminal size. The letter
(`A`–`P`) identifies the species; cells outside the top-N appear as
`.`. The species panel mirrors the web client's roster.

## Keys

| Key | Effect |
|-----|--------|
| `q` / `Esc` / `Ctrl-C` / `Ctrl-D` | Quit |
| `p` | Pause |
| `r` | Resume |
| `]` / `+` / `=` | Sim rate × 2 (cap 8) |
| `[` / `-` | Sim rate ÷ 2 (floor 1/16) |
| `s` | Save (auto-named `tui-<unix-secs>`) |
| `x` | Admin Reset (requires --token) |

## Why a TUI

The browser demo is the right shape for poking at the simulation
interactively (clicking cells, browsing species, watching ambient
chems). The TUI is for the "watch this run for an hour over SSH"
use case: low bandwidth, no GUI dependency, runs over a tmux
session on the server itself.
