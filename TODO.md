# TODO / backlog

Living list of deferred work. Newest/explicit asks at top.

## Simulation

- **New sensory modalities — light/vibration/electric/pH/magnetism
  (detect + emit).** Full design in **`SENSES_PLAN.md`** (status: design
  only, under review — NOT started). Unifies five perceptual channels
  under one engine: each is a single field with both a natural
  (environmental) source and a biotic (cell-emitted) source, read by a
  receptor via the existing `runActivation` pattern. Adds a
  perceptual-field pass over `buildCreatureGrid` (no new global grids),
  one `EMIT` opcode, and 10 named chems (generic→named, `SAVE_SCHEMA`
  bump + golden rebaseline). See the plan for per-channel operation,
  scale-ups (electrolocation, biosonar, counter-illumination, colony
  action-potentials, pH stress/kinetics, magnetic map), the
  generic-chem-preservation methodology (§3.1), and the phased commit
  sequence. Open decision noted in-plan: lead magnetism with the map
  sense vs. the (invented) emittable channel.

- **Bump `dayPeriod` 90 → 600 (Earth-like day vs current cycle).**
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
  lever: nudge `MEMBRANE_DECAY_PER_SEC` 0.005 → ~0.003 so a single
  night costs ~60% instead of ~78%. Heterotrophs (forager / benthic
  / vent / predator) read no light and should be unaffected.

  **Other timescales stay sensible** under the bump (everything
  scales relatively): physical waves get more numerous per day,
  protein turnover settles to ~1-day half-life (within real
  bacterial enzyme range), currents/diffusion align with the day.
  mRNA half-life stays unrealistically slow (real mRNA: minutes;
  sim: ~1 day post-bump) -- pre-existing approximation, not caused
  by the day change.

  Touch points: `dayPeriod: 90` in `createWorld`'s defaults
  (`src/sim.ts` around line 1893); optional matching tweak to
  `MEMBRANE_DECAY_PER_SEC` (~line 809); `SAVE_SCHEMA` bump + golden
  re-baseline (photic timing shifts the seeded fingerprint); run
  photoautotroph + phototaxis scenarios to confirm post-night
  viability.

- **Path 1 — make ATP a first-class chemical (`CHEM_ATP`).** Path 2
  (ATP translocase / ANT analog, host<->organelle) is DONE & green
  (`c0c7980`); mito wired to it (`df9dcf6`). Path 1 is the general
  fix ("not having ATP first-class has caused problems") but is a
  larger, higher-risk refactor than first scoped — needs a dedicated
  effort. Findings that raise the cost: `energy` is its OWN region of
  the SoA worker shared-buffer (`o.base.energy` offset; `new
  Float32Array(b, o.base.energy, cap)`), not a chemCols column; and
  the engine has a dual store (`molCols`/`Molecules` vs the 96-wide
  `chemCols`, bridged by `CHEM_NAMED_MOL_IDX`). Staged plan:
  1. **Storage cutover (REVISED, lower-risk -- do NOT use 96->97).**
     Convert one GENERIC chem slot into the named `CHEM_ATP`:
     `NAMED_CHEMICAL_COUNT 45->46`, `GENERIC 51->50`,
     **`CHEMICAL_COUNT` stays 96**. This PRESERVES the genome ABI
     (`%CHEMICAL_COUNT` unchanged -> existing genomes' chem-addressing
     intact) and the seeded reaction-table RNG order (chem-id draws
     still 0..95). Add `Molecules.atp` (a new `m_atp` column),
     `CHEM_ATP = 45` (first ex-generic slot), update MOLECULE_IDS /
     NAMED_CHEMICALS / CHEM_NAMED_MOL_IDX; repoint `Creature.energy`
     get/set + `newCreature` init + the alloc-zero onto `m_atp`
     (chemCols[CHEM_ATP]); drop the standalone `energy` F32 column
     from CREATURE_F32_COLS. `creatureTotalMass` must STOP adding the
     explicit `c.energy` term (atp now summed once via MOLECULE_IDS --
     else double-count). Unavoidable: **`SAVE_SCHEMA` bump** (embeds
     NAMED_CHEMICAL_COUNT) + **golden re-verify/rebaseline** (named/
     generic boundary moves; likely small). Mass invariant stays
     green by the dedupe above.
  2. **Generalise transport:** retire the Path-2 `TRANSPORT_ATP`
     sentinel -> a normal chem-id transporter on `CHEM_ATP` (slot +
     `SYNTH CAT` genome expression survive; only
     `transport: TRANSPORT_ATP` -> `transport: CHEM_ATP`; update mito
     genome ref). Keep ATP non-diffusible at the OUTER membrane (a
     free cell must not bleed ATP to water — matches reality);
     vacuolar transport unchanged in behavior.
  3. **Cleanup + validate:** remove scalar-special-casing now routed
     through the chem path; unit test ATP-as-chem == prior scalar for
     spendATP/respiration/maintenance; full suite + determinism +
     mass + new golden + build.
  Touch points: `sim/core.ts` (shared-buffer layout, store,
  `Creature.energy`), `sim/chem-ids.ts`, `sim/reactions.ts`
  (transport target, table), `sim.ts` (serialize/restore, snapshot,
  every `energy` site is already behind the accessor),
  `__tests__/golden.test.ts` (rebaseline), `SAVE_SCHEMA`.

- **Add a multicellular-organism archetype.** Create a founder genome
  in `src/genome-archetypes.ts` for a multicellular organism (a
  bonded cell collective with division of labor — beyond the existing
  `colony` greenbeard seed, which only bonds clones). Should exercise
  the substrate's multicellularity primitives (`SYNTH BOND` adhesion,
  `PARTITION` for asymmetric daughter cytoplasm → differentiation,
  leaky inter-cell sharing) so distinct cell roles can emerge from
  one genome. Validate with the scenario harness (does a
  differentiated collective form and persist). See `COLONY_GAPS.md`
  (#1 differentiation substrate landed via `PARTITION`; #2/#4/#5
  open) and the `colony` archetype as the starting point.

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

- **Consider extending transporters to generic chemicals (later).**
  v1 deliberately covers only the 8 small-molecule metabolites (chem
  ids 0–7) — the species a real membrane carrier moves. The generic
  abstract chems (ids ~45–95) were excluded as transport-for-its-own-
  sake and to spare the reaction-slot budget (each transporter eats one
  procedurally-generated generic slot we overwrite post-build; 8 is
  ~3% of that band, all 96 would be ~⅓ of the whole table). Worth
  revisiting if emergent generic-chem signaling/economies appear that
  would benefit from selective cross-membrane transport — e.g. a small
  evolvable sub-band of generic-chem transporters rather than all of
  them. Constraints to preserve: overwrite a contiguous post-build
  band (keeps the seeded `buildReactionTable` rng draw order byte-
  identical → determinism), don't encroach on the named head [0,26),
  and weigh generic-reaction slots lost vs transport gained. Same
  facilitated/atpDelta model as v1. Touch points: `TRANSPORT_CHEM_IDS`
  / `installTransporters` in `sim/reactions.ts`.

- **Temperature diffusion / thermal inertia.** Region temperature is
  rebuilt every tick from a model (baseline + drifting sine patch +
  depth gradient + a surface/wave term) with no inertia, so the
  overlay shows fast wave "echoes" near the surface and reads as
  non-physical. Give region temp real behavior: either low-pass each
  region's temp per tick (thermal mass) and/or a light Jacobi diffuse
  pass like `diffuseRegions` does for the dissolved field. Touch
  points: `sampleRegionTemps`, the temp model, possibly a new
  `diffuseRegionTemps`. Persist if it becomes stateful.

- **fa flux not fully closed (accepted regime).** Necromass lipolysis
  + cheaper SYNTH_FA dented the drain (~-66% -> ~-44%) but fa still
  net-declines; the world runs at a stable lower carrying capacity.
  Reopen only if a self-sustaining equilibrium is wanted. Membrane
  decay rate was tried and reverted (regressed it).

- **ATP as a literal `CHEM_ATP`** array entry (its own chemistry-panel
  row, in `chemCols`/`ambient`). ATP is already conserved matter via
  the energy column + accounted biogenesis; the 96->97 chem reindex
  (procedural reaction table + save schema) is the deferred,
  higher-risk structural version.

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
