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
  is **~41% exergonic** (91/221) / 57% endergonic (126) / 4 ≈zero — a
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

**The residual gap as originally found (now resolved — see
"Resolution" below):** the seeded table produced four `GLU` reactions
but **exactly one ran on an acquirable input** (slot 185, generic
`c35`, slow); the other three were circular dead ends needing internal
cell-machinery chems (`membrane`/`mechanoreceptor`, `activatedChemoFaY`,
`bondChem`) a free cell can't ingest. So chemolitho**autotrophy** was
*expressible* but *throughput-starved* — the scarcity was **evolvable
carbon-fixation routes from acquirable inorganic inputs**, not energy
and not "genome-selectability." That scarcity has since been closed.

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
  the rare GLU route — arguably correct/realistic), or (b) enrich the
  table with more carbon-fixation routes. We took (b). See
  "Resolution" below.

#16 (detritivore) is unaffected. #17 is no longer "inexpressible" —
it is expressible, and the carbon-throughput scarcity is now resolved
in-substrate (below); the remaining work to *ship* a self-sustaining
#17 is a world vent fuel source + the archetype, not the chemistry.

### Resolution — graded carbon-fixation routes (implemented 2026-05-21)

**What landed.** `installCarbonFixReactions` (`src/sim/reactions.ts`)
injects **8 procedurally-generated `GLU`-producing reactions** into the
generic band, each a catalyst-gated door (`uncatRate: 0`), all fixing
carbon from acquirable **CO₂** (ambient + the detritivore's `EXCRETE`d
CO₂ cross-feed). Together with the surviving slot 185, that is **9
usable acquirable-input carbon routes** where there was one. To hold
the table at 256, each new reaction overwrites the lowest-"interest"
generic slot (an `interest()` heuristic: substrate acquirability +
valuable product + |atpDelta| + vmax); the three circular GLU dead ends
are force-retired first. `NAMED_REACTION_COUNT` is unchanged at 26 (the
new routes are *generic* slots, not named bootstrap reactions).

**This differs from the layout proposed above** (one ATP-driven *named*
reaction). The procedural-generic approach was chosen because it (a)
gives the requested *variety* of mechanisms for evolution to discover,
(b) keeps them true doors (`uncatRate 0`) rather than a
free-to-everyone named baseline, and (c) needs no `NAMED_REACTION_COUNT`
bump.

**The effort/yield gradient** (`CARBON_FIX_TIERS`), so different niches
favor different routes:

- **Easy — common substrate, low yield, fast.** e.g. `CO2 → 0.34 glu
  + 0.66 o2` (`vmax` ~1.4) and `CO2 + 2 min → glu + waste`. Cheap to
  evolve and run, little carbon per turn.
- **Mid — a generic reductant, medium yield.** e.g. `CO2 + c3c → ~3.5
  glu + waste`; one is **light-assisted** (`lightIn` > 0, no
  chlorophyll needed — a distinct mechanism from photosynthesis).
- **Complex — rare substrate(s), multi-input, high yield.** e.g. `2 CO2
  + c3d + c3c → ~7 glu`, and the top route `3 CO2 + (rare) c5a + 2 fa →
  ~7.6 glu`, which is **exergonic** (the energy-rich fatty-acid
  reductant pays for building glucose). The rare reductants come off
  the tail of `GENERIC_SPAWN_ORDER`, so high yield is gated on a scarce
  chem a lineage must find, hoard, or cross-feed.

Net: glucose yield spans **0.34 → 7.6** per unit and effective
throughput (yield × vmax) **~0.5 → ~3.8** across the set.
`atpDelta` is bond-potential-derived as for every generic, so the
energetics fall out of the chemistry (cheap routes mildly endergonic,
the rich-reductant routes neutral-to-exergonic).

**Validated.** `npx tsc`, full `vitest` (364 pass), `vite build` all
green; mass-conservation green (every route is mass-balanced);
determinism byte-identical; the golden seed run is unchanged (no cell
in that 4 s trajectory catalyzes a converted slot). `SAVE_SCHEMA`
bumped 21 → 22.

**Still open to ship #17 as a seed:** a bounded **world vent fuel
emitter** (currently only in the `vent` scenario) + the
chemolithoautotroph archetype (HET viability kit + `SYNTH CAT
<energy slot>` + `SYNTH CAT <one of these carbon slots>` + `INGEST`).
The chemistry no longer blocks it.
