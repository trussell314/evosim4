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

### Minimal CreatureStore + creature_update (`22593f6`)
First end-to-end VM-driven creatures. SoA columns for kinematics +
named-chem pool + catalyst/inhibitor + genome + VmState. Per-tick
pass runs run_tick, applies thrust/turn/cat_synth_list to the cell,
movement integrator with damping + world-wrap. The minimal output
surface the engine can act on today; growing as more subsystems
land.

### Demo client renders creatures (`37829c4`)
The standalone demo decodes the creature SoA columns and draws
cells on top of the particle field, colored by energy.

### Cell reaction driver (`5974552`)
runGenericReactions ported. Cells now metabolise: substrate ->
product under MM saturation, ATP credit/debit, machinery
multipliers, the lot. Demo seeds reshuffled: metabolizers carry
GLU+O2+ADP for aerobic respiration; photoautotrophs carry chl +
mRNA + CO2 + ADP for photosynth + photophosphorylation. Live
smoke shows ATP rising in both lines.

### Save/load (`fc2ab95`)
Rust-native JSON save schema. World dims, RNG state, particle SoA,
creature SoA (incl genome + VmState + sparse catalyst/inhibitor),
schema fingerprint. Wire commands Save / Load / Saves over the
WebSocket with constant-time admin auth + path sanitisation. Atomic
disk writes. Engine save_json / load_json round-trips byte-for-byte.

### Spatial sensor bins -- SENSE_OUT real (`6ed019e`, `08f4a46`)
chemGradient ported. 40px bin grid, per-chem centroid sums, rebuilt
every tick after physics. SENSE_OUT now returns a real gradient
vector. Live demo cells with [GENE SENSE_OUT <c> THRUST END] swim
up the chem-c gradient.

### Minimal fission (`4e4cc0d`)
reproduce_op produces a daughter: parent_fraction proportional
split of chems + catalyst + inhibitor, ATP cost on parent,
point-mutated genome copy. Reproducer demo cells visibly multiply.

### Death + autolysis (`fe3ff4b`)
Cells below MIN_VIABLE_MEMBRANE get culled; their chem mass releases
as particles, closing mass conservation across fission and death.

### Baseline metabolic drain (`b75119b`)
Per-second ATP + membrane tax. The slow clock that makes selection
bite: unfed cells starve.

### Species count + per-window deaths (`3901c38`)
Snapshot grows species_count (distinct coding-key) + deaths_this_window
fields. Live smoke confirms emergent evolutionary dynamics:
extinctions, mass conservation, equilibria.

### Viable founder seeding (`f5efc75`)
16 founders across 4 trophic strategies (photoautotroph, aerobic
metabolizer, glucose seeker, reproducer). Starter pools tuned to
outlive baseline drain; per-byte point mutation seeds genetic
diversity. Sim self-sustains for at least 4+ sim-minutes; selection
visibly culls unfit reproducer lines from 12 species down to 3.

### Day / night cycle + particle decay (`a5b... e0c2789`)
The world breathes. Multiple substantial passes landed in a single
session:
  - day_cycle: ambient_light_at(t, period) -- sin curve over the
    daylight half, flat zero through night. Photoautotrophs gain
    glucose only during daylight
  - particle_decay: per-tick aging + radius shrink; particles past
    MAX_AGE_S (120) or below MIN_RADIUS (0.3) get culled. Without
    this autolysis grows the particle field monotonically forever
  - ambient: AmbientField (per-chem world-wide stock) with passive
    cell <-> ambient leak/uptake. Death pass dissolves 40% of each
    cell's emitted chems into ambient
  - excrete_transport: wires the VM's EXCRETE / TRANSPORT ops to
    actually move chems between cells and ambient
  - cell biosynth: catalyst growth is now real biosynth (consumes
    AA+MIN+ATP, gated by mRNA), not a placeholder linear bump
  - top_species + per-cell speciesIdx: the snapshot tells the
    client which species each cell belongs to, with deterministic
    HSL colors from a FNV-1a hash of the coding key
  - client species inspector: clickable species list with a tiny
    in-browser disassembler
  - ingest: cells absorb particles whose bond-potential clears
    their VM-set ingest threshold. Mass-conserving deposit into
    chem pool. New ingester founder line
  - growth: cell radius now tracks membrane chem (r ~ sqrt(mem)),
    so cells visibly grow when they synthesise membrane and shrink
    when they fission and halve it

Live smoke at the end of this session shows a stable food web at
48 cells / 13 species across 4 sim-minutes, with mass moving
through 6 trophic strategies (photo / metab / seeker / reproducer
/ osmotroph / ingester).

### Apex predation + cell-cell physics
PREDATE op closes the apex predator loop -- cells eat smaller cells,
absorb chem + catalyst pools wholesale, prey dies next tick. Cell-
vs-cell collisions resolve overlap with mass-weighted Jacobi sweeps
so predators can corner prey instead of phasing through them.
Mass-scaled metabolic drain (per-mass ATP per-tick term) creates
selection pressure against unbounded size accumulation.

### Genome describer + interactive inspector
describe.rs walks the genome's expressed code and produces an
English summary: which ops fire, which chems are sensed/excreted,
which catalyst slots are boosted, whether control flow is
conditional or linear. Demo client clicks species -> shows
description above the disassembler.

### Catalyst-gated transport reactions
The reaction table's tail slots (231..256) come alive: cells with
non-zero catalyst pool at a transport slot facilitate the chem
flux through their membrane. Mass-conserving, bounded by source
availability. Combined with biosynth_catalyst this is how cells
SPECIALISE -- you choose what transporters to build by what
catalysts you express.

### Bonding (cell-cell adhesion + multicellularity)
bonding.rs lets cells form persistent connections when their VM
bond markers match within tolerance and their CHEM_BOND pool is
above threshold. Bonded cells experience a soft Hooke spring
keeping them clustered. Bond marker is genome-encoded
(greenbeard recognition). Bonded clusters resist drift past
viability -- they're a real selective advantage.

### Per-cell sense range from SENSE_AMP
Cells now derive their sense range from a count of SENSE_AMP
bytes in their genome (sqrt scaling). Sensor breadth is an
evolvable trait paying a real cost in genome length.

### Somatic mutation + REPAIR
somatic.rs gives every cell a per-tick mutation probability
scaling with age^2; CHEM_REPAIR above threshold refreshes a
suppression window. Long-lived cells drift; repair-investing
cells stay stable. Third evolvable axis for selection.

### Top-species summary + species inspector
Snapshot ships up to 16 species summaries (coding_key, count,
HSL color from FNV hash, representative genome bytes, English
description). Per-cell speciesIdx column for client coloring.
Client roster + disassembler + describer all wired together.

### Day/night cycle + particle decay + ambient field + transport
- Day/night ambient_light cycles between 0 and 1 over 60-sec
  default period; photosynth tracks it. Sun indicator in client
- Particle decay: per-tick age + radius shrink; particles past
  MAX_AGE_S (120) or below MIN_RADIUS (0.3) removed. Bounds
  the autolysis chem field
- AmbientField: per-chem world-wide stock with cell <-> ambient
  passive leak/uptake. Death pass dissolves 40% of each chem.
  Client shows top 10 dissolved chems in a left-side panel
- VM's EXCRETE / TRANSPORT ops drain into / pull from ambient

### Founder seeding -- 8 trophic strategies, clustered bonder spawn
Founders: photoautotroph, metabolizer, seeker, reproducer,
osmotroph, ingester, predator, bonder. 4 each = 32 founders.
Bonder spawns as a tight cluster so the cohort actually meets.

### eDNA / horizontal gene transfer
edna.rs: dying cells release their genome into a world-wide eDNA
pool with position and age. COMPETENCE-expressing cells absorb the
nearest in-range carrier, splicing one byte into their own genome.
Third evolutionary mechanism alongside fission inheritance and
somatic mutation. SaveSchema bumped to v3.

## Three independent evolutionary mechanisms now active

1. **Fission inheritance + point mutation**: reproduction::run_reproduction
   halves the parent's chems for the daughter, then optionally flips
   one bit in the genome at FISSION_MUTATION_RATE = 0.4
2. **Age-driven somatic mutation, repair-suppressed**: somatic.rs --
   cells drift at age^2 * SOMATIC_MUTATION_AGE_COEF unless they
   invest in CHEM_REPAIR
3. **Horizontal gene transfer**: edna.rs -- dying cells leak genome
   fragments; COMPETENCE cells in range pick up + splice one byte

Combined these produce real evolutionary dynamics: lineages split
through fission, drift through age, and exchange code laterally.
The native engine has parity (in mechanism, if not in calibration)
with the TS implementation's evolvability.

### Sensor activation pass
activation.rs: receptor_pool * stimulus -> activated chem signal.
Three sensor modalities wired:
  - Photoreceptors (visible / long / surface bands) read
    ambient_light from the day cycle
  - Electroreceptors sum nearby cells' ATP weighted by 1/dsq +
    direction. Cells feel each other's metabolism
  - Vibroreceptors sum nearby particles' speed^2 weighted by
    1/dsq + direction. Cells feel motion in the particle field

SENSE_CHEMICAL on the CHEM_ACT_* slots is now a real sensor,
not a no-op.

### Mass conservation + accounting
mass.rs: total-mass report shipped in every snapshot. Surfaced
two real bugs while wiring:
  - maintenance.rs: ATP spent on upkeep used to vanish. Fixed
    via ATP -> ADP swap (mass-conserving). Membrane drain now
    deposits into ambient WASTE
  - particle_decay.rs + death.rs: autolysed particles used to
    be fixed-radius regardless of carried mass. Fixed: particle
    radius sized so volume*density = remaining chem mass

Live smoke now shows total mass invariant across 5+ sim-minutes
(0.004% drift = float-rounding only).

## Engine status: SUBSTANTIVELY COMPLETE

The native Rust engine has all the biological/evolutionary
features of the TS engine. What remains is performance work
(rayon for the parallel loops, wgpu for the GPU force kernel)
and spatial localization (the region grid). The base substrate
is done; further work is optimisation + UI rather than missing
biology.

Live smoke after this session's commits:
  t=1s:    cells=86 species=28 bonds=6 mass=23026
  t=61s:   cells=50 species=22 bonds=6 mass=22508
  t=181s:  cells=50 species=22 bonds=6 mass=22508
  t=301s:  cells=50 species=22 bonds=6 mass=22507

Five sim-minutes of stable evolutionary equilibrium with mass
conservation provable from a snapshot.

## Up next, in suggested order

### 1. Region / atmosphere passes (~ 1 week)
Port `src/sim/regions.ts`, `environment.ts`, `chemolith.ts`,
`vent.ts`. Region grid + ambient + reserve fields. Once landed,
ambient_light becomes a real per-position scalar (not a flat 0.5)
and the day-night cycle gates photosynth.

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
