# evosim client-demo

Tiny standalone TypeScript app that exercises the `evosim-server`
wire end-to-end. Connects via WebSocket, decodes msgpack frames,
renders the particle SoA to a canvas. Independent from the main
TS app at `src/` so it can ship before the main-app adapter lands.

## Run

```sh
# Terminal 1: the server.
cd server
EVOSIM_BIND=127.0.0.1:8080 \
EVOSIM_ADMIN_TOKEN="$(openssl rand -hex 32 | tee /tmp/evosim-token)" \
./scripts/run.sh

# Terminal 2: the demo client.
cd server/client-demo
npm install
npm run dev   # opens http://localhost:5174
```

In the browser: paste the token from `/tmp/evosim-token` into the
"token" field, hit Connect. Particles drawn in real time. Hit
Pause/Resume to drive the engine's running flag. Reset is admin-
only and is enabled only after the server accepts the token.

## Wire shape

The demo deliberately mirrors `crates/evosim-protocol`'s top-level
enums in TypeScript. When the main TS app's protocol layer lands,
it'll reuse the same shape (probably generated from the Rust types
via a small build step) -- this demo is what proves the shape
actually works before any of that effort goes in.

## What it shows

Server-side, the engine seeds 200 demo particles deterministically
on boot, then runs the force + collision kernels every tick. The
demo client:

- Decodes one msgpack `Snapshot` per server tick (~10 Hz)
- Pulls the `x`, `y`, `r`, `chemId` blobs as `Float32Array` /
  `Uint8Array` views over the wire payload (no extra copy)
- Renders each particle as an HSL-coloured circle scaled to fit
- Reads back snaps/second + per-snapshot lag so transport health
  is visible

## What it does NOT show (yet)

- Creatures (no creature port yet)
- Region / atmosphere visualisation
- Phylogeny strip
- Per-chem colours from the chemistry table (waits on the table
  crossing the wire as a one-shot blob -- planned with the next
  protocol bump)

## Limitations

- One snapshot, no history. The renderer just draws the latest
  Snapshot it received.
- No interpolation: at 10 Hz on a slow link the particles jump.
  Cheap fix is to lerp positions between two snapshots; the main
  TS app already does this and we'll inherit it when the adapter
  lands.
