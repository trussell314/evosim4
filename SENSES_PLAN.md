# Sensory-substrate plan: light · vibration · electric · pH · magnetism

Status: **design + reachability landed; modality substrate not yet built.**

Progress:
- DONE — every procedural founder now gets 1–3 distinct wired senses
  (chemo/thermo/magneto/mechano/photo taxis + life-history), via a new
  sense+behavior gene pool in `genome.ts` (`7f0388f`).
- DONE — sensory-behavior archetypes: kin-swarmer, current-rider (mechano),
  toxin-scout (chemo seek+flee) (`887d77e`).
- KEY DE-RISK — the new sense chems should REPURPOSE the 12 retired
  chemoreceptor chems (ids 19–30) + their dead synth slots (15–18) rather
  than append new named chems: no schema bump, no SoA column surgery, no
  reaction-slot additions, and old saves survive. See §3.0.
- DONE — **pH/acidity sense.** Repurposed `chemoreceptorFa`(21)→`phreceptor`
  + `activatedChemoFaX`(27)→`activatedPh`; synth slot 17 live. `runActivation`
  writes `act_ph = phreceptor·(cellCO2 + ambientCO2 − baseline)`. Added a pH
  founder life-history gene + an `acidophile` archetype (bistable vent-
  seeker). No schema bump; old saves load; golden rebaselined; pH activation
  test added.
- DONE — **electric / electroreception (passive).** Repurposed
  `chemoreceptorBiopolymer`(19)→`electroreceptor` + `activatedChemoBiopolymerX/Y`
  (23/24)→`activatedElectroX/Y`; synth slot 15 live. Added the shared
  emission infra (first piece): `atpSpentTick` + `electricEmission` SoA
  columns, a pre-loop pass materializing each cell's bioelectric output
  from last-tick metabolic ATP spend (order-independent), and a grid
  neighbour scan in `runActivation` summing it into an `act_electro` bearing
  (1/r² falloff). Cells are detectable simply by metabolizing. Added an
  electrotaxis founder gene + an `electro-hunter` archetype. No schema bump;
  determinism byte-identical; mass conserved; golden rebaselined; activation
  test added.
- NEXT — `OP.EMIT` opcode (active emission, shared by all channels) routing
  to `electricEmission` first; then vibration → light → magnetism (repurpose
  the remaining dead chems: minerals/marker0 → vibro/light).

Unifies five perceptual channels under one engine, each with symmetric
**detection + emission**, consistent with the substrate philosophy
("provide the channel; let selection decide whether/how lineages exploit
it"). Builds on the existing receptor→activation pattern in
`runActivation` (`src/sim.ts`).

---

## 0. Guiding principles

- **Substrate, not script.** Each modality adds a physical channel (a
  stimulus cells can detect + a way to inject into it). Whether
  predators hunt by electrosense, whether colonies signal, whether
  acidophiles colonize vents — all must *emerge* from selection. Test:
  "does this open a door?", never "does this make X happen?".
- **One pattern, five channels.** Every channel is
  `stimulus × receptor → activated chem (decayed)`, read by the genome
  via `SENSE_CHEMICAL <id>`. Channels differ only in their *source*.
- **Emission costs ATP.** Active emission spends ATP→ADP (mass-
  conserving), so signalling/electrolocation is a real tradeoff, never
  free. Reflection (light) and passive radiance are side-effects of
  state and cost nothing extra.
- **Invariant discipline.** New named chems use the generic→named
  conversion the ATP migration uses (keep `CHEMICAL_COUNT = 96`, bump
  `NAMED_CHEMICAL_COUNT` + `SAVE_SCHEMA`, rebaseline golden). Determinism
  (byte-identical) and mass conservation stay green at every commit; the
  reaction-table RNG draw order must not move (named installs *overwrite*
  post-draw, exactly like `installNamedReactions`/`installTransporters`).

---

## 1. The core realization

**Each channel is ONE field with both natural and biotic sources** — not
a cells-only field. Sunlight and a glowing cell are the *same* light
field; ambient sea-noise and a swimming cell's wake are the *same*
vibration field; the geomagnetic field and an emitted magnetic pulse are
the *same* magnetic field. The receptor reads the **total**, indifferent
to origin:

```
stimulus(channel, i) = environmental(channel, x, y, t)     // natural: sun, sea-state, geomag, vent chemistry, ambient acidity
                     + Σ_j emission_j · atten(d, channel)  // other cells (via the creature grid)
                     [+ own emission]                       // self (electrolocation / active echo)
activated_chem(i)    = receptor_i · stimulus, decayed by ACT_DECAY
```

This is the existing receptor→activation shape (today it computes *only*
the environmental term, and only for light/temperature/geomagnetism). The
new work is two additions, both folded into the same field:

1. a **biotic Σ-term** (cells emitting into the field), summed over the
   per-tick `buildCreatureGrid` — **no new global diffusion grids**, plus
   **one new opcode** (`EMIT`); and
2. **richer environmental terms** for the channels that lack them, tied to
   the systems that already exist (sun, wind/waves, currents, vents,
   ambient chemistry).

The payoff of unifying: the same receptor a cell uses to find prey or
signal kin *also* lets it navigate the abiotic world (climb toward the
surface light, toward a vent's electric/acid/thermal gradient, hold a
magnetic heading), and biotic signals compete against a **natural noise
floor** — so masking, stealth, and signal-to-noise become evolvable
(a wake is hard to hear in a rough sea; a glow is invisible at the
sunlit surface but a beacon in the deep). Light's reflection term is
itself recursive — a cell reflects the *ambient* field
(`albedo · environmental_light`), so it's only visible when something
(sun or another cell) is lighting it.

---

## 2. Unified architecture

### 2.1 Emission columns (per-cell SoA, `src/sim/core.ts`)

Four `Float32Array`s holding each cell's current output into each
neighbour-sourced field:

```
lightEmission[i]     = albedo[i] · ambientLightAt(c)        // reflection (free, fresh)
                     + activeEmitLightPrev[i]               // bioluminescence (ATP, 1-tick lag)
vibrationEmission[i] = VIB_GAIN · speed(c)                  // wake from motion (fresh)
                     + activeEmitVibPrev[i]                 // deliberate sound (ATP, lag)
electricEmission[i]  = ELEC_GAIN · (atpSpentPrev[i]/dt)     // metabolic glow (lag)
                     + activeEmitElecPrev[i]                // discharge (ATP, lag)
magneticEmission[i]  = activeEmitMagPrev[i]                 // emitted moment only (ATP, lag)
```

Passive terms depending on position/velocity (reflection, vibration-from-
motion) are computed **fresh**; terms produced by the VM (`EMIT`, ATP
throughput) inherently lag **one tick**. The whole column is filled
*before* the per-cell loop, so every neighbour read is **order-
independent and parallel-safe** (the code explicitly wants this —
`src/sim.ts` "prerequisite for any per-cell parallel dispatch").

### 2.2 The perceptual-field pass (NEW; runs right after `buildCreatureGrid`)

Each channel accumulates the **biotic** contribution over the grid, then
`runActivation` adds the **environmental** term before gating by the
receptor — so the activated chem reflects the *total* field:

```
// pre-loop pass: biotic term per channel per cell
for each channel:
  for cell i with that receptor > 0:
    ax = ay = intensity = 0
    for neighbour j in grid within RANGE[channel] (j alive, not engulfed, d>0):
      w = emission_j[channel] · atten(d, channel)
      intensity += w
      ax += w · (xj-xi)/d ;  ay += w · (yj-yi)/d        // bearing toward source
    bioticIntensity[ch][i] = intensity ;  bioticVec[ch][i] = (ax, ay)

// in runActivation (per cell): total = environmental + biotic
envScalar, envVec = environmental(channel, c.x, c.y, world.t)   // sun / sea-state / geomag / vent / ambient acidity
total = envScalar + bioticIntensity[ch][i]   (and envVec + bioticVec[ch][i] for vector channels)
activated[ch][i] = activated[ch][i]·k + receptor_i · total · dt   // k = max(0, 1 - ACT_DECAY·dt)
```

`atten` + `RANGE` (biotic) and `environmental(...)` (natural) together
make each channel a distinct physical niche (§4). Vector channels write
`activated_*_x/y` (a bearing the genome climbs with `THRUST`, like the
existing chemo `climbGradient`); scalar channels write one activated chem.
`ACT_DECAY = 2.0` (~0.35 s half-life).

### 2.3 One new opcode: `EMIT <channel:u8>`

```
channel = operand % 4            // 0 light, 1 vibration, 2 electric, 3 magnetic
mag     = max(0, vmPop(stack))   // magnitude from stack (per-gene cleared stack: PUSH first)
out.emit[channel] += min(mag, EMIT_CAP)
```

Apply (per-cell loop): `cost = EMIT_ATP_PER_UNIT · out.emit[ch] · dt`;
`spent = spendATP(c, cost, ATP_EMIT)`; **emission scales by
affordability** (`out.emit[ch] · spent/cost`) and is stashed into
`activeEmit*Next`. You can't emit louder than you can power; ATP→ADP
keeps mass conserved. pH "emission" needs no op — respiration/`EXCRETE`
already inject CO₂/acid.

---

## 3. The 10 new named chemicals

Three receptor proteins (built via `SYNTH CAT <slot>`), seven activated
signal chems (written by `runActivation`, read via `SENSE_CHEMICAL`).
Light reuses the existing visible photoreceptor; magnetism reuses the
existing magnetoreceptor.

| Molecule key | `CHEM_*` const | Kind | Channel | Used for |
|---|---|---|---|---|
| `activatedLightX` | `CHEM_ACT_LIGHT_X` | signal | light | bearing-X to cell-emitted/reflected light |
| `activatedLightY` | `CHEM_ACT_LIGHT_Y` | signal | light | bearing-Y → "see" a glowing/lit cell |
| `vibroreceptor` | `CHEM_VIBRORECEPTOR` | receptor | vibration | build distance-hearing organ |
| `activatedVibX` | `CHEM_ACT_VIB_X` | signal | vibration | bearing-X to a moving/sounding cell |
| `activatedVibY` | `CHEM_ACT_VIB_Y` | signal | vibration | bearing-Y → "hear the wake" |
| `electroreceptor` | `CHEM_ELECTRORECEPTOR` | receptor | electric | build the electrosense |
| `activatedElectroX` | `CHEM_ACT_ELECTRO_X` | signal | electric | bearing-X to a metabolizing/discharging cell |
| `activatedElectroY` | `CHEM_ACT_ELECTRO_Y` | signal | electric | bearing-Y → electrolocation |
| `phreceptor` | `CHEM_PHRECEPTOR` | receptor | pH | build the acidity sense |
| `activatedPh` | `CHEM_ACT_PH` | signal | pH | scalar local acidity (CO₂/acid − baseline) |

Appended at ids 46–55 (after `atp`=45): `NAMED_CHEMICAL_COUNT 46→56`,
generic band `50→40` (ids 56–95), `CHEMICAL_COUNT` stays 96 (genome ABI
`%96` unchanged).

### 3.0 De-risking: REPURPOSE the retired chemoreceptor chems (REVISED — preferred)

The retired CHEMO branch left **12 inert named chems at ids 19–30** (4
`chemoreceptor*` + 8 `activatedChemo*X/Y`) plus their **synth reactions at
slots 15–18 (rate 0, never fire)**. Per the repo's "delete dead surface /
no inert members" rule, the new senses should **repurpose these** rather
than append 10 brand-new named chems. This collapses the risk of the whole
effort:

- **No `NAMED_CHEMICAL_COUNT` change, no new `core.ts` SoA columns, no new
  reaction slots, no `NAMED_HEAD` bump** — the columns, ids, and synth
  slots already exist; we rename + rewire them.
- **No `SAVE_SCHEMA` bump for the chem layout** — counts/ids are unchanged.
  Old saves still load: a renamed dead chem's key is absent in old saves so
  it reads 0 (which it always was). The user's in-progress world survives.
- Cells **build a receptor via `SYNTH CAT <slot 15..18>`** (those slots
  already produce chems 19–22; just raise their rate 0→0.15 like
  mech/thermo/magneto).

Proposed mapping (10 of the 12 dead chems; 2 spare):

| New chem | Reuses dead chem (id) | Built by synth slot |
|---|---|---|
| `electroreceptor` | `chemoreceptorBiopolymer` (19) | 15 |
| `activatedElectroX/Y` | `activatedChemoBiopolymerX/Y` (23/24) | — |
| `vibroreceptor` | `chemoreceptorMinerals` (20) | 16 |
| `activatedVibX/Y` | `activatedChemoMineralsX/Y` (25/26) | — |
| `phreceptor` | `chemoreceptorFa` (21) | 17 |
| `activatedPh` | `activatedChemoFaX` (27) | — |
| `activatedLightX/Y` | `activatedChemoMarker0X/Y` (29/30) | — (reuses visible photoreceptor) |
| spare | `chemoreceptorMarker0` (22), `activatedChemoFaY` (28) | 18 |

Magnetism reuses the existing magnetoreceptor/`activatedMag`. Still NEW:
`OP.EMIT` + 4 emission columns + the perceptual-field pass (for the
neighbour-sourced channels). pH needs NONE of that (purely chemical) — so
**pH is the cheapest first modality**: rename Fa→ph, raise slot-17 rate,
add one `runActivation` term, add a founder gene + an acidophile archetype.

This supersedes appending 10 new chems (§3, §6). Recommended commit order:
pH (no new infra) → EMIT op + emission columns + pass + electric →
vibration → light (emission/reflection) → magnetism map/emit. Each repurposes
its chems, each its own golden rebaseline.

### 3.1 Preserving interesting generic-chem pathways (IMPORTANT — only if appending new chems)

Generic reactions draw substrate/product ids from the **full 0–95 space**
(`buildReactionTable`, `pickInt(CHEMICAL_COUNT)`), so the abstract generic
slots are woven into emergent pathways. Converting ids 46–55 to named
chems **repurposes** those slots (the procedural reactions referencing
them now point at sensing chems). Genome ABI is preserved (no crashes);
only the meaning of those slots changes → accepted behavior change.
To avoid closing interesting doors:

1. **Static pick.** The table is built from a fixed seed (`0xE2C4BEEF`),
   so reference counts per generic id are known at import. Convert the
   **least-referenced contiguous band** (contiguity required — the named
   block is `0..NAMED-1`).
2. **Empirical verification.** Golden only guards the determinism
   fingerprint, not ecology. Run the headless + scenario/smoke harness
   **before vs. after** (population, diversity, niche occupancy) and
   instrument realized generic-chem flux with `scripts/probe_all_chems.ts`
   / `probe_chem_drift.ts` to confirm the sacrificed slots weren't load-
   bearing in evolved worlds.
3. **Crosstalk decision.** Generic reactions can spuriously produce an
   `activated*` chem (fake a sense) or consume a receptor — this already
   exists for the current activation chems (ids 16–18, 32–38). Accept it
   (metabolic/sensory crosstalk is arguably a door) or add a post-build
   filter excluding activation ids from generic product draws.
4. **Reassurance.** 40 abstract generic chems remain — still a large
   palette — and the modulo ABI is intact.

---

## 4. Per-channel operation + scale-ups

**Sensory-physics table** — one field per channel, each with a natural
source and a biotic (cell) source. This shared structure is what keeps
the channels meaningfully distinct rather than five copies of one sense:

| Channel | Natural (environmental) source | Biotic (cell) source | Biotic range / falloff | Rock blocks? | Receptor | Activated |
|---|---|---|---|---|---|---|
| **Light** | sun (depth-attenuated, day/night) + faint vent glow | reflection (`albedo·ambient`) + `EMIT` biolum | short / `1/r²` | yes (sun); LOS deferred | photoreceptor×3 | act_photo scalars + act_light x/y |
| **Vibration** | sea-state noise (wind/waves/gusts, depth-damped) + vent rumble | motion wake + `EMIT` | long / `1/r` | mostly no | vibroreceptor | act_vib x/y |
| **Electric** | vent/redox & gradient field (near vents/boundaries) | metabolic glow + `EMIT` discharge | short / `1/r²` | no (conducts) | electroreceptor | act_electro x/y |
| **Magnetism** | geomagnetic field (positional: compass + map) | `EMIT` moment (very long / `1/r`, **no rock block**) | very long / `1/r` | no | magnetoreceptor | act_mag x/y (+ optional signal) |
| **pH** | ambient water acidity (baseline + vent acidity + buffering) | respiration↑ / photosynth↓ / `EXCRETE` | local / diffusion | n/a | phreceptor | act_ph scalar |

### 4.0 Natural sources & emergent consequences

Folding the natural term into each field (rather than treating these as
cells-only) is what makes the senses double as **environmental
navigation** and creates **signal-vs-noise** dynamics:

- **Light** — env term reuses `ambientLightAt` (solar × depth ×
  rock-occlusion); add a faint **vent-glow** point source so the deep/dark
  isn't pure black. Consequence: bioluminescent signals are invisible at
  the sunlit surface but loud in the deep → depth-dependent signalling.
- **Vibration** — env term = **sea-state**, derived from the existing
  `advanceWind` / wave / `disturbanceIntensity` system (loud near the
  surface and during gusts, quiet in calm deep water). Consequence: a
  predator's approach or a prey's wake must beat the **ambient noise
  floor** → stealth (gliding/freezing) and rough-water masking emerge.
- **Electric** — env term = a weak **vent/boundary field** (real vents
  are natural geobatteries). Consequence: electrotaxis can home on vents
  *and* on other cells through one receptor.
- **Magnetism** — env term is the positional geomagnetic field (compass +
  map); emitted moments superpose. Consequence: navigation and
  through-rock signalling share the channel.
- **pH** — env term is the ambient acidity already present in `world.ambient`
  (baseline CO₂ + vent acidity); biotic term is respiration/excretion.
  Consequence: acid niches around vents/dense mats are both a hazard and
  a navigable cue.

For vector channels the natural term can carry a faint **direction** too
(light → toward the surface; sea-noise → toward the wave field; electric
→ toward the vent gradient), giving cells an abiotic bearing on the same
chem the biotic bearing uses.

### 4.1 Light — bioluminescence + reflected-light vision
- **Reflection (free):** `lightEmission = albedo × ambientLightAt(c)`
  (reuses the already-computed `ambientLight`, no ATP). Sunlit cells
  scatter light others can see → predators hunt by prey glow/silhouette;
  transparency/low-albedo camouflage is the counter.
- **Bioluminescence (active):** `EMIT light` glows in the dark for ATP.
- **Detection:** neighbour light brightens scalar `act_photo_visible` and
  writes a **bearing** `act_light_x/y` → phototaxis toward conspecific
  light (aggregation) or prey-glow (hunting).
- **Scale-ups:** anglerfish-style lures; counter-illumination camouflage
  (emit light matching the ambient to erase your silhouette);
  marker-tagged flash signatures (species/mate recognition, startle
  flashes); plant shade-avoidance (a cell in another's shadow reads less
  ambient → an occlusion term where cells dim the sky-light beneath them).

### 4.2 Vibration — distance hearing (separate from contact pressure)
Keeps the existing **mechanoreception** (force+velocity+depth =
touch/pressure) intact; adds a true **lateral-line / hydroacoustic**
sense.
- **Emission:** moving cells radiate `VIB_GAIN × speed`; `EMIT vibration`
  for deliberate pulses. Long range, `1/r`, largely rock-transparent.
- **Detection:** `act_vib x/y` = bearing to moving/sounding neighbours,
  gated by `vibroreceptor`.
- **Emergent dynamic:** a still predator detects a swimming prey's wake;
  prey detects an approaching predator → speed-vs-stealth arms race
  (gliding/freezing to go silent).
- **Scale-ups:** rheotaxis; startle/escape on vibration spikes; biosonar
  (active-echo: `EMIT` a pulse, read its reflection off neighbour
  biomass); courtship/colony vibration signalling.

### 4.3 Electric — electroreception + electrogenesis
- **Passive emission** ∝ metabolic ATP throughput (sharks sensing prey
  metabolism); **active** `EMIT electric`. Short-range `1/r²` vector
  `act_electro x/y`.
- **Scale-ups:** active electrolocation (read self-field distortion by
  neighbour conductivity → "electric vision" of inert objects);
  electrocommunication (marker-tagged discharges, jamming-avoidance);
  electrogenic predation/defense (high-magnitude stun, big ATP cost);
  plant-style action potentials propagating along **bonds** (damage →
  pulse → colony-wide response = a nervous system for multicellularity);
  galvanotaxis (orient growth/migration along the E-vector).

### 4.4 pH — acidity sense + niche construction
- `act_ph = phreceptor × (localAcidity − PH_BASELINE)`,
  `localAcidity = co2_pool + w·ambientCO2`. Emission already emergent
  (respiration↑, photosynthesis↓, `EXCRETE`). Gradient form free via
  `SENSE_OUT co2`.
- **Scale-ups:** pH stress axis (out-of-band acidity drives denaturation
  via the existing `CHEM_REPAIR` machinery → acidophile/alkaliphile vent
  niches); pH-gated reaction kinetics (enzyme optima scale
  `Reaction.rate`); acid niche construction (excreted acid dissolves
  minerals via `dissolveParticles` → self-fertilization & public-good
  dynamics); carbonate↔photosynthesis feedback; extracellular acid
  digestion.

### 4.5 Magnetism — map + (invented) emittable channel
- **Map (recommended lead):** replace the constant `MAG_FIELD` with a
  positional function (inclination tilts with depth, intensity gradient
  across the world). Yields magneto-aerotaxis / depth-keeping (real
  magnetotactic-bacteria behavior) and homing/migration from a position
  fix.
- **Emit (flagged invented):** `EMIT magnetic`, detected long-range with
  **no rock occlusion** — its one unique door is through-obstacle
  signalling (coordinate a colony split by a rock wall). Superpose onto
  `act_mag` for MVP (note compass/signal ambiguity; a separate
  `act_mag_signal` pair is the clean-up if wanted).

---

## 5. Operational detail

### 5.1 Tick ordering (`step → updateCreatures`)
1. `buildCreatureGrid` → **`computePerceptualEmission`** (NEW): fill the
   4 emission columns from fresh state + last-tick active emit.
2. Per-cell loop: `runActivation` reads neighbours' emission columns via
   the grid → writes all `activated_*` chems → `populateSensors` snapshots
   the pool → VM runs (`EMIT`/`THRUST`/`EXCRETE` set `vmOut`) → apply:
   spend ATP for emission, stash `activeEmit*Next`, accumulate
   `atpSpentPrev`.

### 5.2 Determinism, mass, persistence
- No world RNG; pure arithmetic over deterministic grid order. The
  one-tick lag is the order-independence guarantee → add a determinism-
  test assertion over the new columns.
- Mass exact: `EMIT` only converts ATP→ADP; fields carry no mass;
  reflection consumes nothing; pH is CO₂ (already tracked).
- New molecule columns serialize automatically via `MOLECULE_IDS`;
  `SAVE_SCHEMA` bumped.

### 5.3 Genome-level expression (concrete VM programs; per-gene cleared stack)
```
electro-predator : [SYNTH CAT <electro-slot>]
                   [SENSE_CHEMICAL act_electro_x, SENSE_CHEMICAL act_electro_y, THRUST]
                   [PREDATE]
biolum-lure      : [PUSH8 50, EMIT 0]
phototaxis-school: [SENSE_CHEMICAL act_light_x, SENSE_CHEMICAL act_light_y, THRUST]
hydroacoustic-flee:[SYNTH CAT <vib-slot>]
                   [SENSE_CHEMICAL act_vib_x, PUSH8 -1, MUL, SENSE_CHEMICAL act_vib_y, PUSH8 -1, MUL, THRUST]
acid-avoider     : [SYNTH CAT <ph-slot>]
                   [SENSE_CHEMICAL act_ph, PUSH8 thresh, GT, JZ +1, <flee>]
magneto-homing   : [SYNTH CAT <magneto-slot>] + hold a target |act_mag| (thrust = f(error))
```
Seed these into `FOUNDER_GENES` and 2–3 new `ARCHETYPES` (electrosensory
predator, acidophile vent producer, biolum/acoustic colony) so the doors
are reachable — demonstrations, not engine rules.

### 5.4 Engulfment / organelles
The emission pass iterates top-level `world.creatures` only → engulfed
organelles don't emit into the world. Inner `runActivation` already runs
at `senseRange 0`, so distance channels read zero inside a vacuole; pH
still reads vacuolar CO₂ (a real internal signal).

### 5.5 Observability (essential for tuning emergent behavior)
- Overlay modes (extend the existing `<select>`): Bioluminescence/Light,
  Vibration, Electric, pH, Magnetic — tint by field intensity, optionally
  draw the vector field.
- Inspector: selected cell's receptor pools, current `activated_*`
  magnitudes+bearings, and per-channel emission output.

### 5.6 Calibration
Gains (`*_GAIN`, `RANGE[]`, `EMIT_ATP_PER_UNIT`, `PH_BASELINE`, mag
gradients) tuned so `activated_*` lands in the 1–100 band genomes can
threshold with `PUSH8` — same approach the photoreceptor archetypes use
(their dark-check threshold ~2 was sized to the realized act_photo). Use
throwaway `scripts/probe_*` to measure realized distributions, then set
founder/archetype thresholds to match.

### 5.7 Edge cases
No receptor → channel decays to 0 (blind). Can't afford `EMIT` → scaled
toward 0. `d==0`/NaN guarded (grid dumps NaN cells to bucket 0,0). Dense
clusters bounded by `RANGE` (cap neighbours scanned if needed).

---

## 6. Foundation changes (one commit, one schema bump)

| Area | Change |
|---|---|
| `sim/chem-ids.ts` | +10 named chems (ids 46–55); `NAMED_CHEMICAL_COUNT 46→56`, generic `50→40`; new `CHEM_*` consts. |
| `sim/chemistry.ts` | 10 `NamedChemSpec` rows (`RECEPTOR_BASE` template). |
| `sim/reactions.ts` | 3 receptor-synth reactions (`vibroreceptor`/`electroreceptor`/`phreceptor`) at `out[26..28]`; `NAMED_HEAD 26→29`. |
| `genome.ts` | `OP.EMIT` (+`OPERANDS=1`); `emit[4]` on `VMOutputs`; `OP_BYTES`/disasm/viability updated. |
| `sim/core.ts` | 4 emission columns + `activeEmit*Next` + `atpSpentPrev`. |
| `sim.ts` | `computePerceptualEmission()`; `runActivation` cell-light/vibration/electric/pH/emitted-magnetic terms; `EMIT` apply; bump `SAVE_SCHEMA`. |
| Docs/tests | `CHEM_IO_REFERENCE.md`, `GENOME_ARCHETYPES.md`, `CHEMISTRY_OVERHAUL.md` (move from backlog→implemented); golden rebaseline. |

---

## 7. Sequencing & risks

**Commits (each green: `tsc` + full `vitest` + `vite build` + `madge`):**
1. Foundation — all 10 chems, `EMIT` op, emission columns,
   `computePerceptualEmission` skeleton, schema bump, docs, golden
   rebaseline.
2. Light (reflection + biolum + vision) + archetype.
3. Vibration (distance hearing) + archetype.
4. Electric (electroreception + electrogenesis) + archetype.
5. pH (acidity sense) + acidophile archetype.
6. Magnetism map (+ optional emit).
7. Scale-ups, each its own effort with its own golden rebaseline
   (electrolocation, biosonar, colony action-potentials, pH kinetics,
   counter-illumination, …).

**Risks/tradeoffs:** the perceptual-field pass adds a per-cell neighbour
scan per active channel (bounded by `RANGE`, reuses the grid) — the main
perf cost; keep ranges modest. One new opcode shifts the mutation
landscape (golden rebaseline). +10 named chems is a real `SAVE_SCHEMA`
break (existing saves won't load). Balance levers: per-channel
gains/ranges; active emission costing ATP keeps signalling honest.
Generic-chem repurposing must be verified per §3.1.
