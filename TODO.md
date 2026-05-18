# TODO / backlog

Living list of deferred work. Newest/explicit asks at top.

## Simulation

- **Death-triggered endosymbiotic gene transfer (EGT).** Today an
  engulfed cell that dies (`innerIsDead`) is digested via
  `digestInnerIntoHost` — its *chems* move to the host but none of its
  *capability*. Add a probabilistic, no-permission transfer on inner
  death: a chance the host absorbs a fragment of the dead symbiont's
  genome (substrate-pure: raw bytes spliced into the host genome) or a
  built capability. Make it a statistical ratchet, not a rule —
  per-death probability scaled by how many symbionts of that lineage
  the host carries; reverse transfer allowed but vanishingly rare.
  This is what lets host takeover of the interface *emerge* via
  selection on the fused collective rather than be scripted. Touch
  points: the contents rebuild pass in `updateCreatures`,
  `digestInnerIntoHost`. See `ENDOSYMBIOSIS_NOTES.md` §5.

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
