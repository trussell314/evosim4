# Chemistry overhaul

Direction-setting doc for the chemistry refactor. This is the canonical
description of where the simulation's chemistry layer is going; revise
in place as decisions land. Branch: `claude/chemistry-overhaul` off
`claude/fix-cross-origin-isolated-f5VyU`.

## Goal

The simulation is a biology sim. It should replicate the spirit of the
processes cells evolved to leverage without prescribing what those
processes are. A few real chemicals and pathways bootstrap the world;
everything else is fictional-but-plausible. All non-bootstrap behavior
must be **emergent** — the engine provides primitives, evolution finds
the strategies.

## Guiding principles

1. **One unified concept: "chemical."** Every substance in the
   simulation — bootstrap or procedural, particle or dissolved or
   inside a cell — is the same kind of thing: a row in a chemical
   table. There are no parallel "material" and "molecule" universes.
2. **Reactions are the only chemistry primitive.** Catabolism,
   respiration, photosynthesis, biosynthesis, dissolution: all of it
   either *is* a reaction or piggybacks on the reaction engine. No
   bespoke hardcoded pathways.
3. **Thermodynamic accounting.** Each reaction balances mass and
   energy. Inputs and outputs may include chemicals, ATP, photons,
   and heat. Exergonic reactions release heat to the local water;
   endergonic ones pull from ATP or absorbed light. Temperature
   feeds back into rate.
4. **Phases matter.** Solubility, density, vapor pressure are
   real properties; gases dissolve in water, condensed liquids
   float or sink, solids settle. The engine cares about phase
   when deciding what becomes a particle vs. what becomes
   dissolved.
5. **Emergence over prescription.** Cellular processes that aren't
   on the explicit bootstrap list (signaling, storage, defense,
   sensing-via-chemistry) must arise from evolution composing
   primitives. The engine should not name or hardwire them.
6. **Senses are molecule-gated.** A genome can read a sensor op
   directly, but the reading is gated by a corresponding **sensor
   chemical** in the cell's pool. No pigment → no light reading;
   no chemoreceptor → no chemical gradient reading; no
   mechanoreceptor → no pressure reading. Cells synthesize
   receptors via biosynth reactions like any other catalyst.
   This makes the *capacity* to sense an evolved investment, not
   a free primitive.
7. **Performance is non-negotiable.** Chemistry runs inside
   per-tick hot loops over every cell. Any phase that lands has
   to leave the simulation running at comparable steady-state
   FPS / sim-ratio to the pre-refactor branch on the same
   hardware. New per-cell or per-particle costs must be paid in
   indexed Float32Array work, not allocations or string lookups.

## Current state (one-paragraph summary)

Three overlapping concepts: `MaterialId` (6 particle types with
density + color), `Molecules` (12 named per-cell pools wired into
hand-coded pathways), and `genericChem` (56 abstract chemicals the
procedural reaction table addresses). Free particles carry a single
material; on ingestion a fixed material→molecule table
(`CATAB_FRACTIONS`) translates material mass into molecule mass.
Catabolism, gas diffusion, and the named pathways are all bespoke
functions; the 256-slot reaction engine is bolted on for the
generic 56. `Creature.energy` is ATP and lives outside `chemCols`.
Ambient O₂/CO₂ are two scalar constants.

## Target model

### Chemicals

A single `Chemical` table indexed `0..N-1`. Each row:

| field            | type    | purpose                                                       |
|------------------|---------|---------------------------------------------------------------|
| `id`             | uint8   | engine identity                                                |
| `name`           | string  | HUD / logs                                                     |
| `molarMass`      | float   | mass per unit; conserved across reactions                      |
| `density`        | float   | when condensed (liquid/solid); drives particle physics         |
| `defaultPhase`   | enum    | solid / liquid / gas at standard conditions                    |
| `solubility`     | float   | saturation concentration in water (0 = insoluble)              |
| `vaporPressure`  | float   | proxy: tendency to go gas as temperature rises                 |
| `meltingPoint`   | float   | proxy: solid ↔ liquid transition temp                          |
| `bondEnergy`     | float   | stored potential energy per unit; informational                |
| `permeability`   | float   | rate of passive diffusion across the cell membrane              |
| `role`           | flags   | `none` / `energyCarrier` (ATP) / `energyEmpty` (ADP) /          |
|                  |         | `membrane` / `mrna` / `pigment` / `digester` / `marker`        |
| `color`          | string  | dominant-component color when this is the bulk of a particle    |

A reaction's `catalystOf` is no longer a flag on the chemical;
instead, **a chemical's role + a reaction's `catalystChem` field**
determine catalysis. Today's "build catalyst slot k" semantics
become "build chemical X, which is the catalyst of reaction Y."

### Particles

A particle is a **chemical blob**:
- Common case: single chemical, `(chemId, mass)`. Same memory as today.
- Rare case (corpses, mixed sediment): a sparse `(id, mass)[]` payload,
  already supported by the existing `genericChem` particle slot —
  generalized to cover everything, not just generic-chem corpses.

On ingestion, a particle's content is deposited directly into the
cell's chem pool — no translation layer. The cell then decides (via
catalysts it has built or bootstrap reactions it gets free) what to
do with whatever it just ate.

The current `MaterialId` type and the `CATAB_FRACTIONS` table go
away entirely. The cell's `reserves` SoA columns go away. Particle
density and color come from the dominant chemical (or a weighted
blend) rather than from a separate material table.

### Reactions

Each reaction:

```
substrates: [(chemId, count), ...]     // 1..3 inputs
products:   [(chemId, count), ...]     // 1..3 outputs
dH:         float                       // enthalpy: <0 exothermic, >0 endothermic
atpDelta:   float                       // ATP made (>0) or consumed (<0); bounded by |dH|*efficiency
lightIn:    float                       // photon energy absorbed per unit; required for the reaction to fire
heatOut:    float                       // (derived) leftover energy → local water temperature
catalystChem: chemId | -1               // chemical whose pool multiplies rate (1 = catalyst-free)
gateChem:    chemId | -1                // required cofactor; rate = 0 if pool empty (mRNA for biosynth, pigment for photo)
vmax, KM:   floats                      // kinetics (existing Michaelis-Menten)
phase:      "any" | "aqueous" | "gas"   // where the reaction can proceed (mostly aqueous)
```

Energy invariant at construction:

```
|dH| ≥ |atpDelta| + heatOut + lightCaptured
```

i.e. the reaction can't release more energy than the bond change
provides. The procedural generator picks atpDelta and lightIn to
satisfy this; the residual is heat. Exergonic reactions that put no
ATP into the cell still warm the water.

Catalysts (specific chemicals — not abstract slots) accelerate
specific reactions. Building a catalyst chemical costs ATP and
substrate just like any biosynthesis. Catalysts decay over time
(today: `CAT_DECAY_PER_SEC`).

### Bootstrap reactions (replace today's 10 named entries)

| # | Reaction                                       | Notes                              |
|---|------------------------------------------------|------------------------------------|
| 1 | glucose + 6 O₂ → 6 CO₂                         | exo; large ATP yield               |
| 2 | glucose → 2 waste + 2 CO₂                      | fermentation; small ATP yield      |
| 3 | fatty acid + 8 O₂ → 8 CO₂                      | beta-ox; large ATP yield           |
| 4 | 6 CO₂ + light → glucose + 6 O₂                 | photosynth; requires pigment       |
| 5 | amino acid → biomass                           | requires mRNA, ATP                 |
| 6 | glucose + minerals → amino acid                | requires mRNA, ATP                 |
| 7 | glucose → fatty acid                           | requires mRNA, ATP                 |
| 8 | amino acid + minerals → pigment (chlorophyll)  | requires mRNA, ATP                 |
| 9 | amino acid + minerals → digester (enzyme)      | requires mRNA, ATP                 |
| 10| amino acid → mRNA                              | requires mRNA (autocatalytic)      |
| 11| fatty acid → membrane lipid                    | requires mRNA, ATP                 |
| 12| biopolymer → glucose + amino acid + fatty acid | requires digester (catabolism)     |

Pathway 12 is the **catabolism replacement**. The world's "food
particles" are bulk biopolymer chemicals; cells digest them via a
real reaction gated on the digester catalyst, instead of via the
hardcoded `catabolize()` function. Eating raw rock or minerals
deposits minerals directly (no digestion needed); eating biomass
yields biopolymer that then gets digested.

### Phases & ambient pool

The world gains `world.ambient: Float32Array(N_CHEMICALS)` — the
concentration of each chemical dissolved in the water column. Cells
exchange with `ambient` via passive diffusion (current
`diffuseGases` generalized to any chemical with `permeability > 0`,
driven by gradient between cell pool and ambient).

Phase-driven behaviors:

- **Gas dissolution.** A free-floating gas particle whose chemical's
  `solubility > ambient[chemId]` slowly dissolves: particle shrinks,
  ambient grows, until saturation. Once saturated, particles persist
  and rise as bubbles.
- **Liquid evaporation / outgassing.** Ambient above saturation
  spawns bubble particles. High temperature lowers effective
  saturation (vapor pressure).
- **Solid settling.** High-density chemicals form particles that
  sink to the seabed (same as today's rock/sand).
- **Aeration.** Atmospheric O₂ has effectively infinite supply at
  the surface; the existing aerator process becomes "top up
  `ambient[O2]` toward an equilibrium set by surface activity."
  Other gases can be wired the same way.

MVP: `ambient` is a single scalar per chemical (well-mixed water
column). Future: coarse 2D grid for spatial gradients. Same API
either way.

### Bootstrap chemical set

Numbered slots; ids stable across runs (genome operands depend on
them being stable). 16 entries reserved for bootstrap; ids 16..N
generated. Approximate phases / densities listed.

| id | name             | role         | phase  | density | solubility | notes                       |
|----|------------------|--------------|--------|---------|------------|-----------------------------|
| 0  | ATP              | energyCarrier| aqueous| 1.0     | high       | replaces `Creature.energy`  |
| 1  | ADP              | energyEmpty  | aqueous| 1.0     | high       | discharged form             |
| 2  | O₂               | none         | gas    | 0.14    | moderate   | aerated from surface        |
| 3  | CO₂              | none         | gas    | 0.20    | high       | offgases / dissolves        |
| 4  | H₂O              | none         | liquid | 1.0     | n/a        | solvent, mostly implicit    |
| 5  | Glucose          | none         | aqueous| 1.5     | high       | universal substrate         |
| 6  | Amino acid       | none         | aqueous| 1.2     | high       | universal substrate         |
| 7  | Fatty acid       | none         | liquid | 0.9     | low        | hydrophobic                 |
| 8  | Mineral          | none         | solid  | 2.4     | very low   | rock/sand-like              |
| 9  | Biomass          | none         | solid  | 1.1     | none       | structural cell material    |
| 10 | Waste            | none         | aqueous| 1.0     | high       | byproduct                   |
| 11 | Chlorophyll      | pigment      | aqueous| 1.1     | low        | photosynth gate             |
| 12 | Enzyme           | digester     | aqueous| 1.1     | low        | catabolism gate             |
| 13 | mRNA             | mrna         | aqueous| 1.1     | low        | biosynth gate (was ribosome)|
| 14 | Membrane lipid   | membrane     | liquid | 0.8     | none       | structural; fission cost    |
| 15 | Biopolymer       | none         | solid  | 1.05    | low        | bulk food substrate         |
| 16-19 | Markers (×4)  | marker       | aqueous| 1.0     | high       | identity-only; no reactions |
| 20 | Photoreceptor    | sensor-light | aqueous| 1.1     | low        | gates SENSE_LIGHT / pheromone / EM |
| 21 | Chemoreceptor    | sensor-chem  | aqueous| 1.1     | low        | gates SENSE_CHEMICAL / GRAD / DENSITY / KIN |
| 22 | Mechanoreceptor  | sensor-mech  | aqueous| 1.1     | low        | gates SENSE_PRESSURE / WALL / HEAD |
| 23 | Thermoreceptor   | sensor-temp  | aqueous| 1.1     | low        | gates SENSE_TEMP |

### Procedural mock chemicals

`N - 20` chemicals generated deterministically from a fixed seed.
Each one rolls:

- `molarMass`: 0.5 .. 5.0, skewed low (matches current generator).
- `density`: 0.5 .. 3.0 (covers floaters, neutral, sinkers).
- `defaultPhase`: weighted roll — 60% aqueous/liquid, 25% solid, 15% gas.
- `solubility`: log-uniform, broad range.
- `vaporPressure` / `meltingPoint`: rolled jointly with phase for
  internal consistency (a "gas" has high vapor pressure; a "solid"
  has high melting point).
- `permeability`: small molecules (low molarMass) more permeable;
  decided at roll time and stable across the sim.
- `bondEnergy`: rolled per chemical to inform reaction energy
  budgets (so reactions involving "high-energy" chemicals tend to
  yield more ATP).
- `role`: always `none` for procedural chems.

Target: 80 procedural chemicals on top of the 16-slot bootstrap
reservation, for a total of 96. Surface fingerprint widens from
64 bits to 128 bits (already a `(lo, hi)` Uint32 pair — extends to
four words). Genome operands continue to be mod `CHEMICAL_COUNT`.

### Other modeled processes

- **DNA transcription** stays as an op (`SYNTH_*` family rebuilt to
  reference catalyst chemicals instead of slot indices).
- **Mitosis** continues to be a single-step op (`REPRODUCE`), but
  gains a hard requirement on a minimum membrane lipid pool (real
  fission needs surface area). Insufficient lipid → attempt fails
  cheaply.
- **Mutation & DNA repair** unchanged. (Repair op remains an ATP
  spend.)
- **Sensor chemicals.** A handful of bootstrap chems act as
  receptor proxies for the SENSE_* ops. Each sensor op consults
  a specific receptor chemical's pool in the cell; below a small
  floor the op returns zero. Cells synthesize receptors via
  biosynth reactions and pay the same ATP/substrate cost they
  pay for chlorophyll / enzyme / mRNA. The mapping (kept
  minimal):
  - **photoreceptor** → light, pheromone, EM-band ops
  - **chemoreceptor** → gradient / density / chemical / kin ops
  - **mechanoreceptor** → pressure, wall, head-position ops
  - **thermoreceptor** → temperature op

  These are catalysts-of-perception. A blind cell (no
  photoreceptor) can still execute SENSE_LIGHT, but reads 0;
  the genome's compiled response will be no-op. The signal
  amplitude scales with receptor concentration up to a
  saturation, mirroring real cell biology where receptor density
  sets sensitivity.

### Not modeled (must emerge if at all)

- Proteins. The mRNA chemical is a catalyst proxy for the whole
  transcription/translation machinery; there is no separate
  protein species.
- Receptors, signaling cascades, transporters, ion channels,
  storage organelles, defensive toxins. These can emerge if the
  engine's primitives (chemicals + reactions + ops) support
  evolving them.

## Migration plan

Eight phases. Each phase ends with a green test suite and a working
sim; no phase introduces an intermediate state that's broken end-to-end.

### Phase A — Doc & branch ✅

This document, on `claude/chemistry-overhaul`. No code yet.

### Phase B — Chemical table v2

Replace `ChemicalDef` with the expanded shape (`density`, `phase`,
`solubility`, `vaporPressure`, `meltingPoint`, `permeability`,
`bondEnergy`, `role`, `color`). For bootstrap chemicals, populate
from a static table; for generics, roll deterministically. No
behavioral change yet: existing reactions still reference the same
chem ids, and the new fields are unused.

Tests: chem table builds, mass conservation invariant still holds
in the reaction engine.

### Phase C — Unify materials with chemicals

Each old `MaterialId` maps to a specific bootstrap chemical:
- `rock` → Mineral (id 8) at high density
- `sand` → Mineral (id 8) at high density (visual only differs)
- `clay` → Mineral (id 8) at moderate density
- `organic` → Biopolymer (id 15)
- `lipid` → Fatty acid (id 7) / Membrane lipid (id 14)
- `gas` → split: O₂ particles (id 2), CO₂ particles (id 3)

Internally, `Particle.material: MaterialId` becomes `Particle.chemId:
uint8`. Density lookups switch to chem table. Color comes from chem
table. `MATERIALS` / `MATERIAL_IDS` / `MaterialId` deleted.

Pebbles stay — they're rendered terrain visuals, not chemistry.
The obstacle generator (rocks on the seabed) stays — it's not a
particle system, it's terrain.

Tests: render snapshot keys change but density-driven physics
should be identical for the bootstrap mapping above.

### Phase D — Particle ingestion via chemicals

Particles deposit their content directly into the cell's chem pool
on ingestion. Remove `Creature.reserves` and the `r_*` SoA
columns. Remove `catabolize()` and the `CATAB_FRACTIONS` table.
Add the Biopolymer-digestion bootstrap reaction (entry 12 above)
so cells still need an enzyme to break down the food they ingest.

Update `releaseReservesAsParticles` → only releases the chem pool;
no separate reserve dump.

Tests: a creature that eats glucose particles can run aerobic
respiration. A creature with zero enzyme can't process biopolymer.

### Phase E — ATP into chem pool

`Creature.energy` becomes `chemCols[ATP_ID]`. The reaction engine
already treats ATP as a chemical for accounting purposes; this
change makes it literally a chemical column. ATP-cost ops
(`THRUST`, `REPRODUCE`, etc.) read/write the column.

Tests: existing behavior preserved; energy conservation in
reactions unchanged.

### Phase F — Ambient pool & generalized diffusion

Add `world.ambient: Float32Array(N)`. Replace
`O2_AMBIENT`/`CO2_AMBIENT` constants with entries in `ambient`.
Generalize `diffuseGases` to a single loop over chemicals with
`permeability > 0`, exchanging mass between cell and ambient down
the gradient. Surface aeration → maintains `ambient[O₂]` toward a
target driven by surface activity.

Tests: no-cell ambient is stable; cells passively absorb O₂ as
today; CO₂ offgases as today.

### Phase G — Phase model

Free particles of soluble chemicals dissolve when local
`ambient[chemId] < solubility`; saturated ambient outgasses
into bubble particles for gas-phase chems. Solid-phase chems
sink; gas-phase chems rise (uses existing density-driven
buoyancy, no new code).

Temperature scales effective solubility (lower at high temp).
Tie reaction `heatOut` into local water temp (depends on
temperature-as-a-field, which is on the existing TODO).

Tests: an ocean of pure O₂ particles equilibrates into a steady
mix of dissolved + bubbled.

### Phase H — Thermodynamics polish

Add `dH` and `heatOut` to the reaction table; regenerate procedural
reactions with consistent energy budgets. ATP yield bounded by
|dH| × efficiency. Heat output recorded; couples into temperature
once temperature field lands. Existing `atpDelta` semantics
preserved as a derived quantity.

Tests: every reaction satisfies the energy invariant. ATP gain in
practice tracks expected efficiency for the bootstrap pathways.

### Phase H2 — Sensor chemicals

Add the four receptor chemicals to bootstrap. Each `SENSE_*` op
reads `cell.chemCols[receptor]` and scales / gates its return
value: at pool 0 the op returns 0; the response rises with
receptor concentration to a saturation. Add corresponding
biosynth reactions (amino acid + minerals → receptor, mRNA-gated,
ATP cost). Cells that don't invest can't sense.

Performance: each SENSE op gains one `chemCols[id][i]` read +
multiply. The hot path is per-tick per-cell per-executed-sense-op,
already bounded by VM instr budget; this is a 1-2 ns addition.

Tests: a cell with zero photoreceptor returns 0 from
SENSE_LIGHT regardless of ambient. Synthesizing receptor restores
the signal.

### Phase I — Marker chems & fingerprint

Promote 4 procedural chems to `role: marker`. They are produced
by a biosynth reaction (substrate: amino acid + small ATP cost,
gated by mRNA, no reaction consumes them). Surface fingerprint
prioritizes markers — a cell that synthesizes marker chems is
broadcasting identity, and another cell's `SENSE_KIN` reads
overlap on those broadcasts. (Pure emergence: cells that diverge
in marker biosynth diverge in apparent kinship.)

If chem count > 64, the fingerprint mask needs to widen. Two
options: (a) move to 128-bit fingerprint (two Uint32 pairs); or
(b) keep 64 chemicals total and dedicate slots tighter. Decision
deferred to phase I planning.

### Phase J — Cleanup

Retire dead concepts: `MaterialId`, `Molecules` interface,
`CATAB_*` tables, hand-coded `aerobic`/`ferment`/`photosynth`
functions if any remain. Final tests: smoke scenario runs to
completion, a population stabilizes.

## Locked decisions

User-confirmed before implementation starts. Revise here if any
flip mid-migration.

1. **Total chemical count: 96.** Headroom past the doc's
   bootstrap+50 mock target. Surface fingerprint widens from
   64-bit to 128-bit (two `Uint32` pairs already pattern).
2. **ATP is `chemCols[0]`.** `Creature.energy` is retired in
   phase E; all ATP-cost ops read/write the chem column. Energy
   accounting is plain chemistry from that phase on.
3. **Mitosis hard-gates on membrane lipid.** A minimum pool of
   chemical 14 (membrane lipid) is required for `REPRODUCE` to
   succeed. Below the floor: attempt fails cheaply, like any
   other failed fission today. Floor is tuned in phase D.
4. **Ambient is a global scalar per chemical (MVP).** Mass
   conservation across cell ↔ ambient ↔ particle ↔ atmosphere
   exchanges is a hard invariant — covered by a dedicated test
   that sums total mass per chemical across all containers and
   asserts it's preserved across a tick. Spatial resolution
   (two-layer or 2D grid) lands later without API changes.
5. **Save format breaks; no migration shim.** `SAVE_SCHEMA`
   bumps; loading an old save shows an error. Consequence: old
   genome operands reference different chem/catalyst ids, so
   any leftover saved populations would be nonsense anyway —
   not worth the migration cost.
6. **Bootstrap chemistry is the doc's 12 reactions and 16
   chemicals — nothing more.** No built-in toxin, signaling,
   or storage chemistry. Those must emerge if at all.
7. **DNA stays as bytes on the creature.** Not a chemical
   pool. mRNA remains the single chemical proxy for the whole
   nucleic-acid machinery.
8. **Pebbles stay as visual-only terrain.** No chemistry; no
   ingestion; no density-driven behavior beyond what they do
   today.

## Mass conservation invariant

Made explicit because it's the load-bearing assumption in the
new model. For every chemical `c`:

```
sum(cell_pool[c] for cell in world)
  + sum(particle.mass[c] for particle in world)
  + world.ambient[c]
  + world.atmosphere[c]                    // for aerated gases
  = total[c]                               // conserved across each tick
```

Reactions don't violate this because stoichiometry is
mass-balanced at construction (existing engine guarantee).
Ingestion / excretion / dissolution / aeration are the
exchange events; each one moves mass between containers
without creating or destroying it. A test in phase D asserts
the invariant directly.

## Performance bar

The simulation's steady-state profile on the pre-refactor branch
sits around 5.7x sim ratio at np≈2300 / pop≈25 (per
`PERF_NEXT_STEPS.md`). Every phase that lands must:

- Run the existing `scenario.smoke.test.ts` in comparable wall time
  (within ~10% of pre-phase baseline).
- Not add any per-tick allocation in the hot path (chemistry,
  forces, collisions, VM). All work is indexed Float32Array math.
- Not introduce string-keyed lookups in per-cell or per-particle
  loops.
- Keep the catalyst-pool fast path (skip when pool ≤ 0 and
  uncatRate ≤ 0).

If a phase regresses perf by more than the bar, it doesn't merge
into the migration; the offending pattern gets profiled and
reworked first.

## Out of scope for this overhaul

- Reaction kinetics beyond Michaelis-Menten (no allosteric
  regulation, no second-order rate laws).
- Compartments inside the cell (no organelles other than the
  existing endosymbiont mechanic).
- pH, ionic strength, redox state as separate axes (folded into
  generic chemical behavior).
- Multi-step "metabolic networks" planning by the genome.
  Cells still pick reactions one at a time via catalysts and
  ops; pathways are emergent, not encoded.
