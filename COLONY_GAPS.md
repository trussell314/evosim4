# Coloniality Gaps — Tracking Note

Status: **gaps recorded**. Captured so they aren't lost while colony
testing continues. Update: the #1 differentiation *substrate* has
since landed (`PARTITION`, see that entry); GAP #3 and #2/#4/#5 remain
as recorded.

Context: the sim's adhesion system models "stick together" (greenbeard
marker match → physical spring bond, inherited at division), not "be
multicellular." Bonds are purely physical co-localization; the only
emergent colony advantage is shared-diffusion cross-feeding (confirmed
by the ADH_PREV 0.0 vs 0.5 A/B: ~2.5× cells at equal, stable particle
supply).

---

## GAP #3 — No colony/size predation refuge (VALIDATED 2026-05-18)

**Finding:** being in a colony confers zero protection from
`PREDATE` / `ENGULF`. One of the strongest real-world drivers of
grouping ("too big to eat") is entirely absent.

**Evidence (`src/sim.ts`):**

- Prey selection for both `ENGULF` (~6840) and `PREDATE` (~6867):
  scan neighbors, require contact (`c.r + other.r`), then the only
  edibility gate is the mass ratio
  `if (myMass < PREDATION_MASS_RATIO * max(0.0001, otherMass)) return;`
  with `PREDATION_MASS_RATIO = 1.5` (`sim.ts:1483`).
- `otherMass = creatureTotalMass(other)`; `creatureTotalMass`
  (`sim.ts:7416`) = own ATP + own molecules + own engulfed
  `contents`. **Bonded partners are NOT summed.**
- `c.bonds` / colony membership is **never referenced** in either
  predation path — no guard, no aggregation, no defended-unit concept.

**Consequences:**

1. A bonded cell is exactly as edible as a solitary cell of the same
   individual mass. An N-cell colony of small cells is N independently
   edible targets, not one hard-to-eat mass-N unit.
2. The mass gate only rewards individual bulk (already obtainable via
   engulfment/growth), never coloniality.
3. Hypothesis (not asserted): possibly *anti*-protective — adhesion
   springs (`sim.ts:6147–6185`) hold members at contact distance, so
   once a large predator reaches the clump every member is in scan
   range and touching, with no positional escape; the colony can be
   harvested cell-by-cell over successive ticks. The A/B's adhesive
   carrying-capacity gain therefore comes purely from cross-feeding,
   possibly against a mild predation penalty.

**Fix sketch (localized, small):** gate predation on colony-aggregate
mass — sum the bonded cluster's mass for the `PREDATION_MASS_RATIO`
test, so a predator must out-mass the *cluster*, not the individual
member. Optionally make `ENGULF` likewise require out-massing the
cluster. Validate via the existing probe / A/B harness.

**Corroboration — #6 armored 2×2 (2026-05-19).** Independent
evidence that predation resistance collapses onto *individual bulk*
with no separable axis. A controlled 2×2 (armor × reproduce-gate;
data in `SCENARIO_RESULTS.md` → "#6 armored") found the
"armored tank" (max `SYNTH BIO` → high membrane → breach cost ∝
membrane) confers **no** survival benefit over a soft forager once
the reproduce gate is matched, and a soft forager@80 *equals*
armored@80 (~t420 / ~245 predation deaths). The only working lever
is the reproduce gate: deferring division grows larger non-dividing
cells that clear the size gate. So membrane investment is not a
selectable "armor" strategy distinct from "grow big / divide late" —
the same gap as above (the mass ratio is the *only* edibility gate;
nothing rewards a defensive trait that isn't raw size). The armored
archetype is retained but `uiHidden` so it isn't presented as a real
strategy.

---

## Related, NOT yet validated (hypotheses only)

Listed for completeness; do not treat as confirmed.

- **#1 No cell differentiation.** Every cell is an identical clone
  running the same VM/state — no role specialization, so no true
  multicellularity is expressible. Suspected biggest unlock.
  **Substrate added (not yet validated):** `PARTITION <chem>` now
  biases the per-chem mother/daughter split at division, so
  genetically identical clones can emerge with divergent cytoplasm and
  read it via `SENSE_CHEMICAL` — differentiation is now *evolvable*
  and the engine no longer forces identical state. The "biggest
  unlock" hypothesis itself is unchanged and unconfirmed. The
  asymmetry is blind (no injected positional/division-count ID), and
  #2 below is still open, so a sterile-helper ↔ reproductive division
  of labor still lacks a dedicated transfer channel.
- **#2 No directed inter-cell transfer along bonds.** Sharing is
  leaky-diffusion only; a sterile helper has no channel to feed a
  reproductive cell, so division of labor can't evolve.
- **#4 No costly public goods → no cheater dynamics.** Greenbeard
  matching gives kin recognition but, with no costly shared good,
  cheater suppression (central to multicellularity evolution) can't
  be modeled.
- **#5 No colony cost / diffusion-limited interior.** Bonds are free,
  pairwise, topology-free, no upkeep, no penalty for buried core
  cells — bigger is unconditionally better; no morphology pressure.

---

## GAP #6 — chemolithotrophy: energy SOLVED in-substrate; carbon-fixation route is the real scarcity (REVISED 2026-05-19)

**The original GAP #6 finding was wrong and is retracted.** It claimed
"no non-photic energy path / chemolithotrophy inexpressible /
metabolism not genome-selectable," sourced from a shallow read that
saw only the ~26 hand-authored named reactions and missed the ~230
procedurally-generated generic ones.

**Corrected picture (deeper read + Phase-1 `vent` scenario):**

- `buildReactionTable` (`src/sim/reactions.ts`) emits 256 slots:
  **26 named bootstrap** (`NAMED_REACTION_COUNT`) + **221 generic**
  reactions + **9 transporters** (`TRANSPORT_SLOT_BASE = 247`), the
  generics with random substrates/products over the full 96-chem
  space, `atpDelta = Σ s.bondPotential − Σ p.bondPotential`. The split
  is **42% exergonic** (92/221) / 57% endergonic (125) / 4 ≈zero — a
  modest endergonic skew, with no built-in exergonic bias (the reverse
  reaction negates `atpDelta`, closed cycles telescope to zero). The
  221 generics carry `uncatRate: 0`, so they are inert **until the cell
  evolves `SYNTH CAT <slot>`** to build that catalyst. (Counts
  re-verified against the live table 2026-05-21.)
- So catabolic strategy **is** genome-selectable: which generic
  reactions a lineage runs is exactly which catalyst slots it
  SYNTHs. Energy from non-organic, non-photic fuel is fully
  expressible today with zero engine change.
- Generic chems carry rolled `bondEnergy` (verified ~20% — 10/50 — in
  30–90), spawn as particles (`GENERIC_SPAWN_ORDER` covers all
  generics), and are INGEST-able: engulf is a **bond-potential
  threshold** test (`CHEM_BOND_POTENTIAL[chem] >= ingestThreshold`,
  `sim.ts:6188`) — no sensor bins, no curated lists, selectivity is an
  evolvable scalar — so any generic whose bond potential clears the
  cell's threshold is edible. The only thing missing was a **world
  source** of such fuel independent of biomass recycling.

**Phase-1 evidence (`scripts/scenario.ts` → `vent`, no engine
change):** a bounded abiotic floor seep emits a generic "vent fluid"
cocktail; a probe genome = HET viability kit + `SYNTH CAT`(strongest
acquirable exergonic slot) + `SYNTH CAT`(a GLU-producing slot) +
`INGEST`. Result over 4 min: energy harvesting is **strong and
sustained** (mean focal ATP 100+ purely from abiotic fuel — the
original "no non-photic energy" claim is decisively false), and the
lineage **reproduces** (0→20 births once the carbon catalyst is
added). It is not yet self-sustaining (40→10) because it is
**carbon-limited, not energy-limited**.

**The actual residual gap (precise, re-verified 2026-05-21):** four
generic reactions produce the heterotroph carbon staple `GLU` (slots
68, 144, 185, 206), but **exactly one runs on an acquirable input** —
slot 185, fed by the generic chem `c35`, slow (`vmax` 0.766,
`atpDelta` +0.065 ≈0). The other three are dead ends for a free-living
cell: slot 68 needs `membrane` + `mechanoreceptor` + `minerals`, slot
206 needs `activatedChemoFaY`, and slot 144 needs `bondChem` and is
light-driven — i.e. they consume *internal cell-machinery* chems the
cell would have to synthesize first (circular), not anything it can
ingest. So the single usable route is also slow and competes for its
one fuel chem. Chemolitho**autotrophy** is therefore *expressible* but
*throughput-starved*: the scarcity is **evolvable carbon-fixation
routes from acquirable inorganic inputs**, not energy and not
"genome-selectability."

**Implications for the planned work:**

- The Phase-1 abiotic-source idea is validated and is a real,
  low-risk substrate addition (a world emitter of bounded reduced
  fuel) — it makes chemolithotrophy a discoverable niche.
- The original "add a MIN+O₂ ATP reaction" fix is unnecessary
  (energy was never the gap) and is withdrawn.
- The universal-id transport work (Option B, Phases 2–4) still
  stands on its own merits (dissolved-generic acquisition,
  uniform op surface) but is **not** required for chemolithotrophy
  and should not be justified by it.
- New design question this raised: carbon-fixation route richness.
  Either (a) accept it as an emergent bottleneck (selection favors
  the rare GLU route — arguably correct/realistic), or (b) add
  carbon-fixation capacity. See "Current state + proposed fix" below.

#16 (detritivore) is unaffected. #17 is no longer "inexpressible" —
it is expressible but currently non-self-sustaining for the
carbon-throughput reason above; reclassify from "blocked" to
"expressible, carbon-limited."

### Current state + proposed fix (2026-05-21)

**State.** *Energy* from abiotic fuel is solved in-substrate — no
engine change needed (the 92 exergonic generics + `SYNTH CAT` already
let a lineage harvest ATP 100+ from a vent cocktail). *Carbon* is the
sole remaining blocker: one usable, slow (`vmax` 0.766), fuel-contested
GLU route (slot 185). The `vent` fuel source exists only as a probe
scenario (`scripts/scenario.ts`), not a shipped world feature, and
there is **no shipped #17 chemolithoautotroph archetype**. Net: the
niche is reachable by selection in principle but throughput-starved, so
a *seeded* chemolithoautotroph cannot self-sustain.

**Decision.** Option (a) — let selection find slot 185 — is realistic
but, given that single route's rate and fuel contention, unlikely to
yield a self-sustaining lineage unaided. We favor a **narrow (b)**: add
ONE catalyst-gated **dark-carbon-fixation door** (optionally two),
modeled exactly like photosynthesis (`out[3]`) but ATP-driven instead
of light-driven. This is a *door, not a script* — the engine offers
the reaction; a cell runs it only if it evolves `SYNTH CAT <slot>`,
nothing forces chemoautotrophy. It mirrors the existing precedent that
photosynthesis is itself an engine-provided carbon-fix door gated on
evolving chlorophyll.

**Proposed layout** (`installNamedReactions`, `src/sim/reactions.ts`):

1. Bump `NAMED_REACTION_COUNT` 26 → 27 (→ 28 if both reactions).
   Named reactions overwrite the *first* N already-generated slots, and
   the rng draw order fills all 256 slots first, so this only converts
   the generic content of slot 26 (and 27); slots 27/28+ keep
   byte-identical generic content. **Determinism blast radius = the
   converted slot(s) only.**

2. New reaction — **dark carbon fixation** (the chemoautotroph's
   Calvin/RuBisCO analog), a TRUE door (`uncatRate: 0`):

   ```ts
   // CO2 -> 0.5 glu + 0.5 o2, costs ~6 ATP, NO light, catalyst-gated.
   out[26] = mk([CHEM_CO2], [1], [CHEM_GLU, CHEM_O2], [0.5, 0.5],
                -6, 1.5, { atpFloor: true });
   ```

   - Substrate `CO2`: abundant + acquirable (ambient, and the benthic
     detritivore already `EXCRETE`s it — the authored cross-feed seed).
     A *different, uncontested* input from slot 185's `c35`, so carbon
     fixation no longer competes with the energy reaction's fuel.
   - Endergonic (`atpDelta -6`, a starting value to tune in `vent`):
     fixing carbon COSTS ATP, paid from what the cell harvests off the
     exergonic vent-fuel reaction — real chemolithoautotrophy (chemical
     energy drives CO₂ fixation). `atpFloor: true` blocks it when the
     cell is ATP-broke.
   - `uncatRate: 0` (UNLIKE the other named reactions, which get a free
     baseline `uncatRate: rate`): zero free baseline, inert until
     `SYNTH CAT 26`. `vmax 1.5` lets a committed chemoautotroph fix
     carbon ~2× the lone generic route.
   - Stoichiometry mirrors photosynthesis `out[3]` (`CO2 -> 0.5 glu +
     0.5 o2`, already mass-balance-validated). If O₂-evolution in the
     dark reads wrong, swap the O₂ product for a reductant-coupled form
     (item 3) or `CHEM_WASTE`.

3. (Optional) second door — **reductant-coupled fixation** for a
   single-step chemolithoautotroph (energy + carbon in one reaction):
   `CO2 + <reduced generic fuel> -> GLU + <oxidized>` with `atpDelta`
   ~0. Higher realism, avoids O₂-in-the-dark, but harder to balance and
   more pathway-specific. Defer unless the ATP-driven door alone proves
   insufficient.

4. **Wire it (CLAUDE.md "no semantic drift"):** add a named slot
   constant (`RX_SLOT_CARBON_FIX = 26`) in `rxn-ids.ts`; update the
   disasm/summary label tables; author the #17 chemolithoautotroph
   archetype (HET viability kit + `SYNTH CAT <vent-energy slot>` +
   `SYNTH CAT 26` + `INGEST`); and promote the bounded **vent fuel
   emitter** from the `vent` scenario to a real world source.

5. **Validate:** the `vent` scenario should now show a self-sustaining
   lineage (births ≥ deaths past carbon-fix onset, ATP stable); bump
   `SAVE_SCHEMA` and re-baseline the golden test (the converted slot
   changes the table); confirm determinism + mass-conservation stay
   green.
