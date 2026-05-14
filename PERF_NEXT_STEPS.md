# Performance: next steps

State of play as of the `claude/fix-cross-origin-isolated-f5VyU` branch.
Sim ratio at normal density (~2300 particles, pop ~25) plateaus around
**5.7x**. The pool engages at np ≥ 4000 with concurrent-creature-work
overlap to hide barrier latency.

## How to measure

Two log lines fire every 3 seconds in dev console:

- `[prof]` — sim worker per-tick: `step`, `force[disp,bar]`,
  `coll[disp,bar]`, `creature`, `snap`, `tick`.
- `[prof.sub]` — in-engine sub-step buckets inside `creature`:
  `pher`, `bonds`, `forces`, `creatures` (= updateCreatures),
  `pColl`, `cColl`, `sColl`, `oColl`, `walls`, `aerate`,
  `replenish`, `prune`.
- `[main-prof]` — main thread: snapshots/s, intake ms/snap,
  frames/s, frame sub-buckets (render, inspector, tooltip,
  analyze, diag).

Set `PROFILE_LOG_MS` / `MAIN_PROFILE_LOG_MS` to 0 to disable.

## Current per-tick budget (np=2350, pop=25, steady state)

| Bucket          | ms     | Share | Notes                          |
| --------------- | ------ | ----- | ------------------------------ |
| `creatures`     | 1.12   | 39%   | updateCreatures: sensors+VM+actions |
| `pColl`         | 0.86   | 30%   | particle-particle, serial (pool dormant at this density) |
| `oColl`         | 0.65   | 22%   | drifting up; per-cell lobe list would attack this |
| `walls`         | 0.30   | 10%   | already cheap                  |
| `forces`        | 0.28   | 10%   | already cheap                  |
| `snap`          | 0.20   | 7%    | small after MessageChannel fix |
| `step` total    | 2.89   |       | → sim ratio 5.77x at 60 Hz     |

Main thread renders at full 60 fps with ~1.8ms of work per frame.
Not bound by anything on the main side at this density.

## Concrete next steps (ranked)

### 1. Per-cell lobe lists for obstacle collisions
Targets: `oColl` (currently 0.5-0.7ms, growing).
Effort: small.
Expected: cut `oColl` to ~0.1-0.2ms.

The cell bitmap (`OBSTACLE_CELL_GRID`) only tells us *if* an
obstacle is in a cell. The inner loop still walks ~30 lobes per
hit obstacle even if only 1-2 are within reach. Build a parallel
structure mapping each cell to the *specific* lobes overlapping
it (flat `Float32Array` of `[x, y, r]` triples plus a per-cell
`[start, count]` index). The inner loop becomes 1-3 distance
checks instead of 30.

### 2. Sub-profile and optimize `updateCreatures`
Targets: `creatures` bucket (1.12ms — largest single).
Effort: small (instrumentation), medium-large (fixes).
Expected: 0.3-0.6ms savings if sensors or VM dominate.

Add `updateCreaturesProfile = { sensors, vm, actions, writeBack }`
on `WorldProfile` and instrument the per-creature loop. The
`[prof.sub]` log already does this pattern — extend it. Once
the dominant sub-phase is known:

- If **sensors** (gradient sampling, pheromone reads, neighbour
  scans), see if the spatial index can be reused or cached.
- If **VM**, look for allocation or repeated property reads
  inside the instruction hot loop; instruction budget caps and
  pre-decoded program arrays are the usual wins.
- If **actions**, batch eating/excretion/spawning to avoid
  per-tick allocations.

### 3. Parallelize obstacle collisions on the pool
Targets: `oColl` at higher densities.
Effort: medium.
Expected: 4x at np ≥ 4000 (matches existing pool parallelism).

Same shape as particle force/collision dispatch: split particles
into chunks, each worker processes its chunk against the obstacle
index. Index is read-only inside the step so no synchronization
between workers. Skip if step #1 dropped `oColl` low enough that
the pool's barrier cost (~0.4ms) wouldn't pay back.

### 4. Parallelize `updateCreatures` on the pool
Targets: `creatures` bucket, especially as `pop` grows.
Effort: medium-large.
Expected: pop-dependent; could be 3-4x on large worlds.

Creatures touch each other (predation, bonding) and particles
(eating, excreting). The dispatch boundary needs to either:
- Process sensors-only in parallel (read-mostly), then actions
  serially; or
- Use double-buffering for creature state so writes don't race.
Sensor read parallelism alone could remove ~50% of the bucket
if sensor sampling is the dominant sub-phase.

### 5. Snapshot via SAB-backed views
Targets: `snap` (0.2ms at normal density, climbs at high density).
Effort: medium.
Expected: snapshot cost essentially zero.

Particle SoA columns are already in SharedArrayBuffer (the pool's
particle store). Main thread can read directly through a typed
array view of the same SAB — no serialization, no postMessage
copy. Needs careful versioning so main doesn't read mid-write.
Pairs well with #4 (puts creature columns in SAB too).

### 6. WebGPU compute for particle physics
Targets: particle force pass + collisions.
Effort: large.
Expected: 10-100x at very high densities; effectively unlimited.

Forces are embarrassingly parallel and map directly to a compute
shader. Collisions need spatial hashing; doable on GPU but more
work. The CPU becomes free for creature logic. Requires WebGPU
(Chrome/Edge solid, Safari rolling out, Firefox still behind a
flag). The current Atomics-based pool can be left in place as
the WebGPU-absent fallback.

## Does this work open up further parallelism?

Yes — the dispatcher contract is now async (fire-only,
returns wait fn) and the call sites in `step()` already use the
fire→do-other-work→wait pattern. That's the foundational primitive
for everything below:

- **Pool can absorb non-particle work.** The same Atomics +
  worker-pool plumbing can be repurposed for obstacle collisions
  (#3), creature sensors (#4), or any future per-element kernel.
  Each new kernel needs a `CMD_*` value + worker handler + a
  fire-only dispatcher. No changes to the synchronization
  primitives.

- **Sim worker has spare cycles during barriers** on the pool
  path. The barrier wait is currently consumed by hooks for
  creature/sediment collisions. As more work moves to the pool,
  the sim worker can be loaded with the remaining serial
  pre/post-physics work (lineage tracking, day cycle, species
  pruning) at zero extra cost.

- **Snapshot is now off the critical path of the sim** —
  serialization runs in the sim worker between ticks. Moving
  snapshot itself onto a dedicated worker (or eliminating it
  via #5) frees that gap for sim work.

- **Multiple particle force passes per worker dispatch** is now
  cheap. The current API dispatches one pass per tick; if
  collision iters > 1 (e.g., for tougher convergence) the workers
  can repeat without paying per-iteration setup cost. This was
  blocked by the synchronous dispatcher contract.

The main constraint left is the **dependency graph between
sub-phases**: `applyForces` must complete before `updateCreatures`
reads particle positions, `resolveCollisions` writes them, etc.
Anything that breaks those orderings needs either double-buffering
(snapshot positions at frame start) or careful read-only/write-only
partitioning. The current overlap design captures the easy
"obviously independent" wins; deeper parallelism needs that data-
dependency analysis done deliberately.

## Profiling additions to keep

The `[prof]`, `[prof.sub]`, and `[main-prof]` log lines stay on by
default at `PROFILE_LOG_MS = 3000`. They are cheap (~6
`performance.now()` per tick on the worker, 4-6 per frame on main)
and have been essential for catching:

- The `obstacleColl` leak (sediment never going asleep)
- The 4ms setTimeout clamp eating budget
- Confirming that overlap was actually hiding barriers (or not)
- Identifying when the bottleneck moved from worker to main

Removing them prematurely will make the next optimization round
guesswork. Leave them in unless they're shown to be a measurable
overhead.
