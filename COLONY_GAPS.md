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
  ~26 named bootstrap + ~230 **generic** reactions with random
  substrates/products over the full 96-chem space,
  `atpDelta = Σ s.bondPotential − Σ p.bondPotential` (≈half
  exergonic), `uncatRate: 0` so they are inert **until the cell
  evolves `SYNTH CAT <slot>`** to build that catalyst.
- So catabolic strategy **is** genome-selectable: which generic
  reactions a lineage runs is exactly which catalyst slots it
  SYNTHs. Energy from non-organic, non-photic fuel is fully
  expressible today with zero engine change.
- Generic chems carry rolled `bondEnergy` (~20% in 30–90), spawn as
  particles (`GENERIC_SPAWN_ORDER` covers all generics), and are
  INGEST-able via the biopolymer sensor-slot fallback
  (`sim.ts:5625`). The only thing missing was a **world source** of
  such fuel independent of biomass recycling.

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

**The actual residual gap (precise):** the seeded table contains
**exactly one** catalyst-gated reaction that produces the
heterotroph carbon staple `GLU` from acquirable (generic/ambient-
inorganic) inputs, and it is slow (`vmax` 0.77, `atpDelta` ≈0) and
competes with the energy reaction for the same fuel chem. So
chemolitho**autotrophy** is *expressible* but *throughput-starved*:
the scarcity is **evolvable carbon-fixation routes from inorganic
inputs**, not energy and not "genome-selectability."

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
  the rare GLU route — arguably correct/realistic), or (b) widen
  the generic table's product distribution so more slots reach the
  carbon staples. (b) is determinism-sensitive; defer with the rest.

#16 (detritivore) is unaffected. #17 is no longer "inexpressible" —
it is expressible but currently non-self-sustaining for the
carbon-throughput reason above; reclassify from "blocked" to
"expressible, carbon-limited."
