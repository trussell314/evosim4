# Eliminating discrete particles: dissolved-field + reserve only

Analysis of what it would take to remove distinct visible **particles**
from the world and keep only the **dissolved ambient field** + the
**reserve** (both already exist). Status: design analysis, not yet
implemented.

## Why this is even feasible

The metabolic core already runs on dissolved chems — internal pools that
exchange with the per-region ambient field via passive permeability,
`TRANSPORT`, and excrete-to-field. Photosynthesis (light + dissolved
CO2), respiration (dissolved O2 + internal glucose), digestion (internal
biopolymer), and all `SYNTH CAT/INH` biosynthesis are field/pool based.

Particles are essentially just the **food-and-prey intake layer**: inert
matter that gets eaten by `INGEST`, plus the discrete entities cells
shed/sense. Only a handful of code paths touch them.

## The 5 particle dependencies, and what each becomes

1. **`INGEST` (main intake)** — today consumes a discrete particle whose
   center falls inside the cell's body sphere (`dist² < c.r²`,
   sim.ts:6142), scanning `world.particles` linearly per ingesting cell.
   → Becomes **uptake from the local dissolved field** at the cell's
   region — essentially what `TRANSPORT` already does. The bond-energy
   threshold selectivity maps directly to "which dissolved chems do I
   draw." This is the biggest semantic shift: **phagotrophy →
   osmotrophy** (absorb dissolved nutrients vs. swallow discrete food on
   contact).

2. **`SENSE_OUT`** — its gradient reads **particle-position bins**
   (`SENSOR_BIN_COUNT/SUMX/SUMY`, via `chemGradient`), not the field.
   → Must switch the gradient source to the **ambient/reserve grid**.
   The grid already exists; rebuild `chemGradient` to read field
   concentration instead of binned particle positions. Arguably cleaner
   (a true concentration gradient).

3. **`EXCRETE` (free cells)** — today spawns a discrete particle.
   → **Deposit into the local ambient field** instead. Engulfed cells
   already deposit to the host pool, so this just makes free cells
   behave the same toward the field.

4. **Death / autolysis** — today converts a dead cell's mass to corpse
   particles (mass conservation).
   → **Dump the mass into the local field / reserve** instead.
   Conservation preserved by depositing into the field.

5. **Seeding / chemostat** — today spawns food particles; scenarios
   maintain particle counts (`topUpBiopolymer`, etc.).
   → **Inject concentration into the field / reserve** instead; scenario
   helpers set field levels.

## Also touched

- **Rendering** — drop particle sprites; visualize the field as a
  concentration overlay (ambient overlays likely already exist).
- **Mass-conservation invariant** — the particle term disappears; mass
  lives in cells + ambient + reserve. Determinism/golden + mass tests
  get rebaselined.
- **Particle physics** — buoyancy / settling / sediment / terrain
  collision for particles all go away. The **reserve already does
  density-based vertical drift** (`diffuseReserve`), so resource spatial
  structure (dense matter sinks) survives at the field level.
- **eDNA carriers** — already region/buffer-based for uptake, so they
  could fold into a field-eDNA concentration, or remain the one
  remaining discrete type.

## Unaffected

Cells stay discrete, so `PREDATE` / `ENGULF` / `BOND` and all cell-vs-cell
interaction keep working unchanged. Reactions, transport, and diffusion
are already field-based.

## The real trade-off (ecological, not technical)

You lose **patchy, discrete resources** — food clumps and sediment beds
you chase and contact — in favor of **smooth diffusion gradients** you
climb toward high-concentration regions. That removes the
particle-feeding / contact niche but unifies the whole resource economy
into one reaction-diffusion field.

Acquisition currently requires **physical contact** (the thing must be
inside your radius); sensing reaches out to `senseRange`. Going
field-only collapses that distinction — a cell takes up nutrients
wherever it sits in a rich region, no contact step.

## Upside

Simpler and faster: no per-particle physics, no O(particles) ingest scan
per cell, no particle-cap management. The substrate becomes a clean
reaction-diffusion field + reserve + discrete cells.

## Rough scope

Mostly **rerouting the 5 paths above into machinery that already exists**
(ambient field + reserve), plus rebuilding the `SENSE_OUT` gradient
source and the renderer, and removing particle physics/seeding. Not new
subsystems. Determinism/golden + mass-conservation tests rebaseline.
