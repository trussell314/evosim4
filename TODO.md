# TODO / backlog

Living list of deferred work. Newest/explicit asks at top.

## Simulation

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

- **Dual / contested host↔organelle membrane (model C).** The
  organelle currently solely controls active transport across its
  outer membrane. Add a host-side generic transport bias across a
  specific vacuole (pick chem, push/pull ±, ATP-costed) that composes
  additively with the organelle's active transport + passive
  diffusion. No "feed organelle" verb and no organelle sensor — the
  host must still act on cytoplasmic footprints, keeping recognition
  emergent. Enables addressed delivery, parasite/mutualist/
  domestication dynamics, and (with EGT above) control migrating
  hostward over generations. Touch points: `runInnerCell`, a new
  host-side transport step. See `ENDOSYMBIOSIS_NOTES.md` §2 / §4.
  NOTE: superseded by the planned **Substrate B** (transporter-as-
  membrane-reaction): rather than a bespoke host-side "transport bias"
  step, a SYNTH'd transporter is a cross-compartment MM reaction
  applied at *every* membrane the cell owns — outer (cell↔world) and
  vacuolar (host↔organelle). Host farming/starving then emerges from
  footprint-driven expression, no addressed verb. This unifies the
  dual-membrane item with the standing-transporter work.

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

- **In-app "import save from file"** button so headless-run results
  (`scripts/headless.ts` writes the save JSON) load in one click
  instead of hand-setting the `evosim4:save` localStorage key.

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
