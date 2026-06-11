# Native engine port: progress log

Tracks the state of the TS -> Rust port. Each entry lists what's
*done* (with parity tests / commit hashes you can pull up) and what
remains. Read this when picking the port back up after a break.

The TS app on `claude/develop` is unaffected; the port lives only
under `server/`.

## Done

### Foundation (`f95c438`)
Cargo workspace, three crates, axum WebSocket binary, admin bearer
token, supervisor wrapper script.

### Cloudflare Tunnel (`8bd3f8f`)
`tunnel.sh` glue, quick + named modes, Cloudflare Access walkthrough.

### RNG + chem-ids (`2fafd12`)
Mulberry32 + mixHash with goldens; 96-slot chemical id space.

### Chemistry table (`4b74d20`)
Full 96-chem ChemTable behind a OnceLock. Generic chems generated
deterministically; goldens captured from TS pin generic 46, generic
95, bond potential math, spawn-order first/last 5.

### Genome-ABI constants (`48b4228`)
CATALYST_COUNT, N_REACTIONS, NAMED_REACTION_COUNT, etc.

### Reaction table (`626f8ee`)
Full 256-slot REACTIONS port. Procedural region from
`mulberry32(0xE2C4_BEEF)`, named head (respiration, photosynth,
synth-*, digest, photophos at slot 25), carbon-fix overlay at the
lowest-interest 8 generic slots, transport band at the tail.
Goldens for slots 100, 150, carbon-fix 39, transport layout.

### ParticleStore (`171edc3`)
SoA over Vec columns: x/y/z/vx/vy/vz/r/density/age (f32), chem_id
(u8), quiet_ticks (i32), sparse molecules + generic_chem payloads.
push / remove_swap_pop / clear with handle-fixup return value.

### World + force kernel (`43ad02a`)
World skeleton owning particles + ambient params + sim RNG.
`apply_particle_forces_range` over &mut slices, line-for-line with
TS `applyParticleForcesRange`. Buoyancy, waves, splash, updraft,
current, brownian, drag, velocity cap, integrator. Tests cover
buoyancy direction, sink direction, velocity cap.

### Engine ticks real particles (`43ad02a`)
Engine::step calls forces::apply_forces. Snapshot packs the live
SoA columns as little-endian f32 / raw u8 blobs the client decodes
via TypedArray views.

### Controller commands (`429c6cb`)
SetRunning / SetSimRate wired through to the engine task; sim rate
clamped [0.05, 8.0]. Save still nacks as unimplemented (waits on
save/load port).

### Collision pass (`8ead336`)
Particle-particle Jacobi sweeps over a GRID_CELL_SIZE=12 spatial
hash. CollisionScratch owns per-tick buffers on the Engine so the
hot path doesn't allocate. Sleep heuristic (< sqrt(25) px/s for >= 30
ticks). Tests cover overlap separation, head-on bounce, asleep
skip. Parallel two-phase row-parity dispatcher not ported (waits
on the population that warrants the rayon dispatch overhead).

### Standalone demo client (`39af532`)
`server/client-demo/`: Vite + TS app, msgpack decode, canvas
renderer. End-to-end smoke verified: Hello, auth re-Hello with
admin flag, Snapshot at tick 73 with 200 particles, AdminAck for
the status command. 25 KB JS bundle, 7.7 KB gzip. Independent
from `src/` so it ships before the main-app adapter.

### Protocol v2: chem colors (`ecd5a0c`)
Hello frame carries chem_colors + chem_names (96 each) so the
client renders particles with the real chemistry palette.

### Genome VM scaffold (`9e06c81`)
Opcode constants, the const [u8; 256] OPERANDS table, walk_genome
(full + expressed-only), coding_key / species_key / coding_bytes.

### Genome VM interpreter (`a4f857d`)
run_tick ported in full: all 256 opcodes, gene framing, per-gene
stack isolation, f64 stack (bounded-32, drops oldest), f32
registers, in-place POKE, ECMAScript ToInt32 semantics, floored
MOD. Sensors trait for world coupling. VmOutputs carries the full
per-tick output surface (thrust/turn/excrete/transport/reproduce/
predate/engulf/ingest/synth masks/bond/splice/poke/partition/emit).
11 unit tests + a TS golden captured from the identical genome.

## Up next, in suggested order

### 1. Creature store + update (~ 2 weeks)
Now unblocked -- the VM interpreter it depends on has landed.
  - Port CreatureStore (SoA) from `src/sim/core.ts`: per-cell
    chem pools, position/velocity, genome, VmState, energy/mass
  - Port updateCreatures from `src/sim.ts`: the per-cell pass that
    runs run_tick, applies VmOutputs (thrust/excrete/transport/
    reproduce/predate/engulf/synth), runs the reaction network
    against each cell's catalyst pools, handles fission + death
  - Implement the Sensors trait against the live cell + particle
    field (chem_conc from the cell pool, gradient from the
    particle grid)
  - Wire into Engine::step after the force/collision passes
This is the messiest single function in the codebase; budget
accordingly. Test against captured TS per-cell state traces.

### 2. Region / atmosphere passes (~ 1 week)
Port `src/sim/regions.ts`, `environment.ts`, `chemolith.ts`,
`vent.ts`. Pure functions over a region grid + the atmospheric
gas pools. Doesn't need the VM; can land in parallel with it.

### 3. Creature update + chemistry (~ 2 weeks)
Port `updateCreatures` from `src/sim.ts`. Depends on the VM.

### 4. Force kernel parallelism (~ 2-3 days)
rayon par_chunks_mut over the SoA columns once particle counts
warrant it. Brownian noise becomes per-chunk PCG keyed on
(tick_seed, chunk_index) to keep it parallel-safe -- matches the
GPU kernel's PCG approach.

### 5. wgpu compute force kernel (~ 1 week)
Direct port of `src/sim/gpu-forces-shader.ts`'s WGSL. Same shader
language; only the host-side bind groups, buffer encoding, and
dispatch differ.

### 6. Collision parallelism (~ 3-5 days)
Row-parity two-phase dispatch over rayon. The serial path was
written with this split in mind: every cell only enumerates its
four downstream-of-(cx,cy) neighbors, so even-y and odd-y phases
have no overlapping writes.

### 7. Save / load (~ 3 days)
Use the existing JSON save schema. Serde + a small bridge for
the parts where the TS schema names differ from the Rust struct.

### 8. Snapshot wiring for creatures (~ 2 days)
Once creatures land, populate the snapshot's creature SoA blobs
the same way particles already are.

### 9. Main TS app adapter (~ 3-5 days)
Swap `new Worker(...)` in `src/main.ts` for a WebSocket-backed
proxy that emits `WorkerOutbound` shaped messages. The renderer
stays unchanged. Activated by `?server=wss://host` URL param.
The `client-demo/` proves the wire shape works; this is the
"now use it from the existing UI" step.

### 10. Multi-client + persistence (~ 1 week)
Session model, controller-vs-observer roles, per-observer
overlays, periodic persistence, observability endpoints.

## Operator notes

- `cargo test` from `server/` runs 47+ Rust tests; `cargo clippy
  --all-targets -- -D warnings` is the project lint gate
- The TS app on `claude/develop` is unaffected. Bring the server
  up alongside and use `client-demo/` to view the Rust engine
  while the main app continues to run its in-browser sim
- `EVOSIM_BUILD_COMMIT` ends up in every Hello frame so the
  client UI can show which engine commit it's talking to. After
  `AdminCommand::Update` succeeds + the supervisor relaunches,
  the new commit hash is observable from the client
- Determinism: serial CPU path is byte-deterministic per seed
  (verified by RNG and chemistry/reaction tests). Parallel /
  GPU paths are not (matches the TS behaviour: pool workers and
  GPU PCG diverge from the serial RNG draw order). Goldens
  belong on the serial path

## Conventions for the port

- Every port commit leaves `cargo test`, `cargo clippy
  --all-targets -- -D warnings` clean
- Constants and enum variants keep TS spelling where it doesn't
  fight Rust style (e.g. `CHEM_O2` stays uppercase). Function
  names go to snake_case
- Goldens captured from the running TS implementation -- never
  guessed. The capture commands live in commit messages so they
  can be re-run if the TS source moves
- Tests pin against the strict-serial path; parallel paths get
  their own per-mode goldens later when they land
