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
