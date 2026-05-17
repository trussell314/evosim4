# TODO / backlog

Living list of deferred work. Newest/explicit asks at top.

## Simulation

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
