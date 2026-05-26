# TODO / backlog

Living list of deferred work. Newest/explicit asks at top.

## Simulation

- **DONE — New sensory modalities — light/vibration/electric/pH/
  magnetism (detect + emit).** All five channels shipped with symmetric
  detection + active emission (`OP.EMIT`, `EMIT_CHANNELS=4`). The chems
  were carried by REPURPOSING the 12 retired chemoreceptor chems (ids
  19–30) + dead synth slots 15–18 rather than appending — so
  `NAMED_CHEMICAL_COUNT` stayed 46 and no chem-layout schema bump was
  needed. Includes reflected-light vision, bioluminescence, column-shade
  occlusion, positional magnetic map, and ~12 sense archetypes (see
  `GENOME_ARCHETYPES.md`). Full record in **`SENSES_PLAN.md`** (status:
  IMPLEMENTED). Only deferred remainder: path/line-of-sight occlusion of
  cell-emitted light. Sense overlays in the UI are also still pending
  (see Gradient overlay modes below).

- **DONE — Bump `dayPeriod` 90 → 600 (Earth-like day vs current cycle).**
  Shipped: `createWorld` default is now 600 (`src/sim.ts`), golden
  rebaselined, vent-schedule comments updated. The night-stress lever
  (`MEMBRANE_DECAY_PER_SEC` 0.003) was already in place. Analysis kept
  below as the rationale.
  Analysis (2026-05-19) of the engine's full timescale ladder:
  ingest cooldowns (0.15s) ≪ surface waves (7s) ≪ swells/updraft
  (18-28s) ≈ cell generation (~46s; benthic doubled in ~46s in the
  60s smoke) < temp-patch (38s) < **day (90s)** < membrane / catalyst
  / inhibitor half-life (138s) ≪ current cycle = region ambient
  diffusion half-life (600s) ≈ enzyme/chl/mRNA half-life (693s).
  The ordering is internally consistent and matches a plankton-pace
  microbe: ~2 generations per day, currents/diffusion ~6.7 days
  apart, photic and protein-decay timescales chain reasonably.
  The only off-Earth bit is the day-vs-current ratio: in reality
  currents/eddies/tides vary on day-to-many-day scales, NOT 6.7×
  faster than a day. Bumping `dayPeriod` to 600 aligns the day with
  the existing current/diffusion cycle (1 day per current cycle,
  Earth-like) and moves cells to bacterium-pace (~13 generations
  per day).

  **One real dynamics consequence** (the reason this is deferred,
  not a one-line drive-by): under day=90 the night is only 45s and
  costs ~20% of membrane; under day=600 the night is 300s and at
  `MEMBRANE_DECAY_PER_SEC = 0.005` costs **~78% of membrane**
  (`(1-0.005)^300 ≈ 0.22`). Photoautotroph archetypes' `reproduceWhenGrown(40, …)`
  thresholds were tuned for the short-pulse cycle. Under the long
  cycle they get a much longer growth burst by day (good) but a
  real night-stress to survive (some lineages may not). Re-balance
  lever (ALREADY APPLIED): `MEMBRANE_DECAY_PER_SEC` is now **0.003**
  (was 0.005), so a single 300s night would cost ~60% instead of ~78%
  — i.e. the decay half of this item already shipped; only the
  `dayPeriod` bump itself remains. Heterotrophs (forager / benthic /
  vent / predator) read no light and should be unaffected.

  **Other timescales stay sensible** under the bump (everything
  scales relatively): physical waves get more numerous per day,
  protein turnover settles to ~1-day half-life (within real
  bacterial enzyme range), currents/diffusion align with the day.
  mRNA half-life stays unrealistically slow (real mRNA: minutes;
  sim: ~1 day post-bump) -- pre-existing approximation, not caused
  by the day change.

  Touch points: `dayPeriod: 90` in `createWorld`'s defaults
  (`src/sim.ts:2352`); `MEMBRANE_DECAY_PER_SEC` (`src/sim.ts:850`,
  already 0.003); `SAVE_SCHEMA` bump + golden re-baseline (photic timing
  shifts the seeded fingerprint); run photoautotroph + phototaxis
  scenarios to confirm post-night viability.

- **DONE — make ATP a first-class chemical (`CHEM_ATP`).** Both paths
  shipped. Path 2 (ATP translocase / ANT analog, host↔organelle) green
  (`c0c7980`), mito wired (`df9dcf6`). Path 1 (the storage cutover) is
  also done: `CHEM_ATP = 45` (`src/sim/chem-ids.ts:194`),
  `NAMED_CHEMICAL_COUNT = 46` / `GENERIC = 50` with `CHEMICAL_COUNT`
  still 96, a real `m_atp` molecule column with `store.energy` aliased
  onto it (`src/sim/core.ts:447,571,709`), and `TRANSPORT_ATP` is now a
  normal chem-id transporter (`= CHEM_ATP`, `src/sim/reactions.ts:324`).
  `SAVE_SCHEMA` is at 22 and the golden was rebaselined.

- **DONE — multicellular-organism archetype.** Added `metazoan`
  ("metazoan tissue") to `src/genome-archetypes.ts`, extending the
  germ/soma `differentiated-colony` from two phenotypes to THREE plus
  metabolic sharing: greenbeard cohesion + `PARTITION mrna` toward the
  mother, then a multi-threshold caste switch — GERM (divides),
  FEEDER (forages + leaks surplus glucose to bonded kin = leaky
  inter-cell sharing via the shared medium), STRUCTURAL (builds body
  membrane, holds). Cells cycle through roles as they rebuild mRNA.
  Exercises `SYNTH BOND` + multi-threshold `PARTITION` + leaky sharing
  together; assembles, spawns, and steps clean (archetype test). Still
  open (COLONY_GAPS #2/#4/#5): directed bond-channel transfer, etc.

- **WATCH — unbounded genome growth (pre-existing, latent).** Long
  headless runs grow a pathological lineage's genome into the tens–
  hundreds of KB while the population median stays ~40 bytes. Measured
  via `scripts/instrument20.ts` at 15 sim-min: pre-HGT baseline
  (`c6910f8`) max genome **322,647** B (median 39, mean 17,396);
  post-Substrate-A max **84,411** B (median 36) — i.e. the bloat is
  **pre-existing and orthogonal to the eDNA/PARTITION work** (HGT did
  not cause or worsen it). Root cause is almost certainly `SPLICE_DUP`
  / mutation having no *total* genome-length cap — `GENE_FRAGMENT_CAP`
  only bounds per-event size, not cumulative length. Risk: memory/perf
  in long runs, and a single lineage distorting ecology. Not fixing
  now (it predates this work and a cap is a behavior change needing
  its own golden re-baseline + design call on where to clamp). Revisit
  if long-run perf/memory becomes a concern. Touch points:
  `applyGenomeSplice`, `mutateGenome`, `eDnaUptakePass` (all share the
  append-only growth path).

- **DONE — Horizontal gene transfer + death-triggered EGT (unified
  eDNA substrate).** Resolved not as a special-cased per-death
  probability but as one physical substrate: lysing cells (and cells
  expressing `SYNTH PACKAGE`) shed genome fragments as decaying
  extracellular-DNA carriers; cells expressing `SYNTH COMPETENCE`
  integrate a fragment append-only via `appendGenomeBytes`. EGT is the
  same substrate at the intracellular locality — a dead symbiont sheds
  into the host's `eDnaBuffer` in `digestInnerIntoHost`, and the host's
  own competence integrates from it. The count-scaled ratchet *emerges*
  (more symbionts → more deaths → fuller buffer → more integration
  opportunities) with **no `1-(1-p0)^k` formula anywhere**. Virus /
  plasmid / conjugation are evolvable strategies over the shared
  substrate, none scripted. All stochastic choices use the
  deterministic `hashUnit`/`mixHash` (never the world RNG), so
  determinism stays byte-identical. Touch points: `releaseChemsAsParticles`,
  `digestInnerIntoHost`, `eDnaUptakePass`, `EDnaCarrier`. (No `INJECT`
  op was added — a donor cannot address a recipient.)

- **DONE — Standing transporters + dual/contested host↔organelle
  membrane (unified transporter-as-reaction substrate).** Gaps 5 and 4,
  resolved as one substrate rather than a bespoke "host-side transport
  bias" verb. Key realization: `N_REACTIONS === CATALYST_COUNT` and
  reaction slot k is catalyzed by `catalystCols[k]`, so a transporter
  *is* the existing enzyme machinery — `SYNTH CAT param=slot` builds
  the transporter protein. The last band of procedurally-generated
  generic slots is repurposed as transporters for the core small-
  molecule metabolites (O2, CO2, glu, aa, fa, min, ADP, waste);
  `buildReactionTable`'s seeded rng still draws for every slot so
  determinism is byte-identical. A cross-compartment applier
  (`runTransportReactions`) moves the chem with the same MM kinetics as
  metabolism across **every membrane the cell owns**: the outer
  membrane (cell↔world, via the region-ambient surface) and the
  vacuolar membrane (host↔organelle — both the organelle's *and* the
  host's transporter catalysts act, summed). Host farming/starving and
  domestication/parasitism become reachable because the host's
  transporter-k acts equally across *every* organelle it carries (no
  addressed delivery; control stays footprint-driven). v1 is
  facilitated (down-gradient); `Reaction.atpDelta` is the reserved hook
  for future active/uphill pumping. No new opcode, no new SYNTH kind,
  no new persisted field, **zero `SAVE_SCHEMA` bump**. Mass-exact (1:1
  across the membrane, both sides in the ledger) and deterministic (no
  `simRng`). The substrate is evolutionarily latent in short runs (a
  genome must evolve a high catalyst slot) — correct "opens a door"
  behavior; correctness is guarded by unit tests. Touch points:
  `sim/reactions.ts` (transport `Reaction` flavor + band install),
  `runGenericReactions` (skips transport slots),
  `runTransportReactions`, `runInnerCell` (vacuolar wiring).

- **DONE — extend transporters to generic chemicals.** Added a
  generic-chem transporter sub-band (`GENERIC_TRANSPORT_CHEM_IDS`,
  `GENERIC_TRANSPORT_COUNT = 16`, ids 46–61) folded into
  `TRANSPORT_TARGETS` between the 8 metabolites and the ATP translocase
  (so `TRANSPORT_GLU_SLOT`/`TRANSPORT_ATP_SLOT` invariants hold). A cell
  can now evolve a carrier to import/leak a generic token to/from the
  medium or a bonded neighbour — opening emergent generic-chem
  economies/signalling. Kept a conservative sub-band (not all 50) to
  spare the procedural reaction-slot budget; widen by raising the
  constant. Same facilitated/down-gradient model; latent until the
  catalyst is SYNTHed. RNG draw order preserved (contiguous post-build
  overwrite) → golden unchanged + determinism byte-identical; no
  schema change. Test: "a GENERIC chem can also be transported".

- **DONE — Temperature diffusion / thermal inertia.** `sampleRegionTemps`
  (`src/sim.ts`) steps a stateful `regionTemp` field every tick: a
  4-neighbour Laplacian diffusion (`TEMP_DIFF_RATE`), relaxation toward
  the analytical baseline (`TEMP_RELAX_RATE` — the thermal-mass / inertia
  term, so it no longer snaps to the model each tick), and a vent source
  term (`TEMP_VENT_INJECT_RATE`). The field re-seeds from the analytical
  baseline on first call / dim change and re-converges, so it is not
  persisted (acceptable — bounded transient on load).

- **fa flux not fully closed (accepted regime).** Necromass lipolysis
  + cheaper SYNTH_FA dented the drain (~-66% -> ~-44%) but fa still
  net-declines; the world runs at a stable lower carrying capacity.
  Reopen only if a self-sustaining equilibrium is wanted. Membrane
  decay rate was tried and reverted (regressed it).

- **CO2 vent strength.** Creeps up slightly late-run (arrested, not
  runaway) now autotrophs are established. Possible lever: raise the
  CO2 surface-exchange multiplier toward O2's if tighter carbon
  balance is wanted.

## UI

- **Gradient overlay modes.** The overlay `<select>` is the extension
  point (None/Temperature/Particle density today). Add per-chemical
  ambient-field gradient mode(s) — pick a chem, tint by
  `world.ambient` concentration (snapshot already has per-region PE;
  per-chem would need per-region-per-chem or a selected-chem field).

- **Panel-internal reorg.** "Full reorg" was chosen but panel/HUD DOM
  restructuring (merge controls into a settings panel, header/tab
  hierarchy) was deferred — unverifiable without a browser. Do with
  live visual feedback. Shared style tokens / `mkDockBtn`-style
  factory could extend to the side panels for visual coherence.

- **Spawn ×N for social archetypes.** The archetypes panel spawns
  one cell per click. The "seed"-class founders whose payoff is
  multi-cell (greenbeard colony, chloroplast/farmer endosymbiosis,
  virus spread) need a population to show their point — repeated
  clicking works but is tedious. Consider a small count selector or a
  "spawn ×5/×10" affordance. Deliberately out of scope for the
  initial archetypes feature. Touch points: the `archPanel` block in
  `main.ts`, `spawnSpeciesInstance` (already supports repeated calls).

- **DSLs for creatures + scenarios, and creation dialogs (UI).** A
  creature DSL already exists at the assembly level (`src/genome-asm.ts`:
  `asm(Instr[])` with named ops/labels, used by `genome-archetypes.ts`),
  and a scenario *harness* exists (`scripts/scenario.ts`, founders-off
  per-archetype probe) -- but neither is user-facing or high-level.
  Consider: (a) a higher-level creature DSL (named behaviors/traits ->
  genome bytes, above raw asm) so cells can be authored without hand-
  writing op tuples; (b) a declarative scenario DSL (world size, seeded
  populations, environment knobs, success metrics) that the smoke/scenario
  harness consumes. Add-on: **in-app dialogs for creating new cells and
  worlds** -- a cell-builder (pick senses/behaviors/metabolism -> compiled
  genome, spawn it) layered on the creature DSL, and a world-builder
  (dimensions, vents, light/wind, founder mix) layered on the scenario
  DSL. Pairs with the existing archetypes panel + the new sensory
  substrate (SENSES_PLAN.md). Touch points: `genome-asm.ts`,
  `genome-archetypes.ts`, `scripts/scenario.ts`, `main.ts` (panels/dialogs).

- **In-app "import save from file"** button so headless-run results
  (`scripts/headless.ts` writes the save JSON) load in one click
  instead of hand-setting the `evosim4:save` localStorage key.

- **Move save persistence to IndexedDB (future-proofing).** Saves are
  gzip-compressed into `localStorage` (`c600127`), which bought ~3x
  (a 5MB-raw world → ~1.65MB stored), so this is NOT urgent — do it
  the day a real world hits the compressed cap. What's involved: a
  small dependency-free async IDB wrapper (`open` + `onupgradeneeded`
  to create a one-key store + promise-wrapped `get`/`put`) replacing
  the two `localStorage` calls; store the gzip **bytes** (`Blob`/
  `Uint8Array`) directly via structured clone, dropping the base64
  step (~33% overhead) and its encode/decode; the load bootstrap is
  already async so it slots in; one-time migration reading the
  existing `localStorage` save on first load so worlds aren't lost.
  Tradeoffs: **no synchronous `pagehide` flush** (IDB writes are
  async and may not commit on unload) — but the 60s autosave cadence
  already bounds loss to ≤60s, so it's a non-regression; eviction
  risk (mitigate with a one-time `navigator.storage.persist()`);
  more Safari/private-mode quirk surface; more boilerplate, harder to
  unit-test. Win: removes the storage ceiling (IDB quota is disk-
  fraction, hundreds of MB–GB). Touch points: the save/load block in
  `src/main.ts` (`SAVE_KEY`, `storedSave`, `decodeStoredSave`,
  `maybeAutosave`, `forceSave`).

## Engine decomposition (sim.ts split) — paused

Behavior-preserving split of the `sim.ts` monolith. **Paused at a
clean, fully-green checkpoint** (golden hash, determinism
byte-identical, mass conservation, `madge --circular` all green;
pushed to `claude/develop`).

- **Done.** `sim.ts` 9559 → 7444 lines; 12 cycle-free modules under
  `src/sim/`: `genome-id`, `rxn-ids`, `rxn-stats`, `chem-ids`,
  `chemistry`, `reactions`, `labels`, `profile`, and the keystone
  `core` (SoA `ParticleStore`/`CreatureStore`, the
  `Particle`/`Creature`/`MoleculesView` value classes, worker
  shared-buffer layouts, and the `World`/`Species`/`SimStats`/
  `Obstacle`/`FadingGhost` type graph). Two back-edges into `sim.ts`
  were inverted to keep the dependency one-directional:
  `setParticleSlotReusedHook` (collision-asleep clear, mirrors the
  force/collision dispatcher pattern) and `resetCreatureIdCounter()`
  (imported bindings are read-only).

- **Blocked on one decision.** Every remaining stage has a back-edge
  into `sim.ts`'s environment / world-construction layer. Pick an
  approach before continuing:
  - **(A) Keep chaining cohesive extractions** — pull the environment
    + world-construction subsystem (`WorldEnv`, `createWorld`,
    `generateObstacles`, surface/temperature/light) into its own
    module next; then `snapshot`, `serialize`, `regions`, `step` fall
    out cleanly.
  - **(B) Switch the cycle gate to ESLint `import/no-cycle`** —
    permits lean `import type` back-edges, enabling smaller modules
    without the chained mega-extractions.

- **Concrete back-edges to resolve:** `snapshot` →
  `RenderSnapshot extends WorldEnv`; `serialize` → `applySavedWorld`
  calls `createWorld`/`generateObstacles`; `regions`/`step` →
  `simRng` + environment helpers.

- **Invariant for every future step:** golden hash + determinism
  (byte-identical) + mass conservation + `madge --circular` must all
  stay green; refactor in small individually-green commits.

## Hygiene / before merge

- **Prune one-off probe scripts.** `scripts/probe_*.ts` are throwaway
  instrumentation committed during the chemistry overhaul. Keep
  `scripts/headless.ts`; decide which probes (if any) to keep.

- **Live-verify the parallel Jacobi collision path.** Correct by
  construction + serial tests pass, but the worker-pool
  (crossOriginIsolated) path can't be exercised headless/in CI —
  sanity-check collisions look right in the live app with the pool
  active.

- **No PR opened.** All work is on `claude/chemistry-overhaul`.
