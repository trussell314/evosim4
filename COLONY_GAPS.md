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

## GAP #6 — No chemolithotrophy; metabolism not genome-selectable (VALIDATED 2026-05-19)

**Finding:** there is no non-photic energy path. A
chemolithotroph / anaerobic specialist (e.g. archetype #17, the
benthic CO₂/mineral cross-feeder) cannot be expressed at all, and —
more fundamentally — *which* catabolic pathway a cell uses is **not
a genetic trait**: the reactions fire automatically from whatever
substrate is present, so a genome cannot select "ferment, don't
respire" or "oxidize minerals."

**Evidence (from the 2026-05-19 substrate review):**

- Energy-yielding reactions (`src/sim/reactions.ts` ~268–283) are
  exactly three: aerobic `GLU+O₂ → 2CO₂` (+10 ATP), fermentation
  `GLU → ½CO₂+½WASTE` (+2 ATP, no O₂), β-oxidation `FA+O₂`. The only
  autotrophy is photosynthesis (`CO₂+light → GLU+O₂`, needs light).
- Nothing consumes `CHEM_MIN` or `CHEM_CO2` for ATP without light;
  minerals only feed ATP-*consuming* biosynth reactions.
- Reactions are unconditional given substrate — there is no SYNTH
  kind or op that gates respiration vs fermentation, so the choice
  is purely environmental (ambient O₂), never heritable.
- O₂ is not a life gate: no O₂-depletion death; fermentation always
  yields energy at 0 O₂. "Low-O₂ tolerant" is therefore not a
  distinguishable phenotype either.

**Consequence:** the entire chemolithotroph / syntroph / anaerobic-
specialist design space is closed. #17 deferred; #16 (detritivore)
is unaffected (it is an ordinary heterotroph + CO₂ excretion).

**Proposed engine fix (DESIGN ONLY — not implemented).** Add one
chemolithotrophic ATP reaction so dark mineral-energy becomes a real
niche, opening a door without scripting the organism:

- New reaction (catalyst-slot gated, like the existing catabolism
  slots): `MIN + O₂ → WASTE`, `+k` ATP (k small, e.g. ~3–4, between
  fermentation's 2 and aerobic's 10) — a chemolithotrophic mineral
  oxidation. Rate `vmax` modest so it is a slow, steady living, not
  a bloom fuel.
- To make it *genome-selectable* (the deeper half of the gap), gate
  it on a catalyst the cell must `SYNTH CAT <slot>` to express
  (reuse the existing `SYNTH CAT` standing-transporter/catalyst
  mechanism), so "be a chemolithotroph" is an evolved investment,
  not a free universal pathway. Aerobic/fermentation stay
  unconditional to preserve determinism + mass-conservation tests;
  the new path is additive and only active when the catalyst is
  present.
- Optional second step for a true sediment cross-feed: a reaction
  consuming `WASTE` (currently terminal) for a small ATP yield, so
  #16's fermentation `WASTE` output becomes #17's food — a real
  syntrophic loop rather than a flavor note.
- Validation gate before shipping: determinism
  (`src/__tests__/determinism.test.ts`) and mass-conservation
  (`sim.test.ts`) must stay green; the new reaction must conserve
  atoms in the chem table and draw no RNG.

This is recorded for a future chemistry pass; **do not implement
without an explicit go-ahead** (it changes the reaction table, which
is determinism- and mass-sensitive).
