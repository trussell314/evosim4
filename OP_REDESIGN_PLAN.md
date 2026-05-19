# Op redesign — universal id-addressed substrate (plan + design note)

Status: **planning**. Phase 1 (abiotic energy landscape) is landed
and validated (see `SCENARIO_RESULTS.md` → Phase 1 `vent`, and
`COLONY_GAPS.md` GAP #6 revised). No op/ABI code written yet. This
doc is the agreed design of record; open forks are listed at the
end and must be resolved before Phase 2 code lands.

## Goal

Collapse the special-cased genome surface into a small set of
**uniformly id-addressed primitives** over the full chem space and
the full reaction-slot space. Bootstrap chemicals/reactions stay
exactly as today (named, fixed properties, fixed ids — kept for
familiarity, nothing renumbers, `CHEMICAL_COUNT` stays 96). Strategy
(chemolithotrophy, autotrophy, syntrophy, detritivory, taxis) is an
emergent program over primitives, never a dedicated verb.

## Fixed design rules (decided — do not relitigate)

1. **Reaction-slot addressing, never product.** The catalyst op is
   `CATALYST <slotId>` (0..`N_REACTIONS`-1). Addressing by product
   chem is incoherent: many slots can yield the same chem, and every
   slot is multi-substrate *and* multi-product, so "the reaction
   that makes X" is undefined. This is continuous with today's
   `SYNTH CAT param=slot` (`genome.ts:453`), just generalized +
   renamed. The named-SYNTH **aliases** bind to fixed *slot
   constants*, not products (`SYNTH BIO` ≡ `CATALYST
   <BIO_BOOTSTRAP_SLOT>`).
2. **Name = product, not action.** `CATALYST` (builds a reusable
   standing catalyst), not `CATALYZE`. Same logic flags the HGT pair
   as mis-filed under `SYNTH` (see op surface).
3. **Mutation locality is split by byte role, not made bitwise.**
   Bitwise-only gives locality in an arbitrary encoding (opcode
   numbering is not semantically ordered) and destroys the heritable
   `observedOpBias` lever. Plan: keep biased/heritable replacement
   for **opcode** bytes; graduated ±delta (or Gray-coded) drift for
   **operand** bytes. (Tracked here; not part of Phase 2.)

## Target op surface

Parameterised primitives (args = ids taken as operands; amounts/
levels/vectors from the stack so they are computed/regulated):

| Op | Arg | Notes |
|---|---|---|
| `SENSE_IN <chemId>` | chem id | own cytoplasmic pool (today's `SENSE_CHEMICAL`) |
| `SENSE_OUT <chemId>` | chem id | local ambient conc; **subsumes** the receptor/activation machinery → taxis becomes emergent |
| `TRANSPORT <chemId>` | chem id | signed-amount membrane flux; facilitated down-gradient (free), active up-gradient (ATP cost, conservation-airtight). Subsumes `EXCRETE` + transporter band |
| `CATALYST <slotId>` | reaction slot | analog level from stack; **subsumes** every named `SYNTH` biomass/pigment/repair kind via fixed-slot aliases |
| `INGEST` | **UNRESOLVED** | particulate channel — see design problem below |

Survivors that do **not** collapse (operate on genome/eDNA-particle
subsystem, not the reaction table): the HGT pair `PACKAGE` (shed
genome→eDNA carrier) and `COMPETENCE` (eDNA uptake). Candidate
rename out of the `SYNTH` family (`SHED`/`UPTAKE` or a `GENE`
family). Retired/subsumed: `CHEMO/PHOTO/MECH/THERMO/MAGNETO` SYNTH
kinds + their activation chems (→ `SENSE_OUT`, Phase 5). `BOND`
collapses to `CATALYST` *except* its kin-marker `param` — the one
non-lossless alias; marker must relocate (open).

## The INGEST / detritus design problem (the reason for this note)

**Finding.** `INGEST`'s operand is *not* a chem id. It is
`m6(b)=b%6` (`genome.ts:212,535`) → a 6-entry **sensor-bin** mask
`{minerals, biopolymer, fa, o2, co2, glu}`. Bin 1 (biopolymer) has a
load-bearing fallback (`sim.ts:5625`) that makes it catch **every
generic-chem particle + waste**. So:

- The earlier "operands 0–5 unchanged mod 96 ⇒ behavior-preserving"
  premise is **false**. Widening `INGEST` to chem-id addressing is a
  genuine behavioral change, not a free first increment.
- **Pure chem-id `INGEST` cannot express detritivory.** Marine snow
  / corpses are an *open, unbounded set* of generic chems. #16 the
  benthic detritivore lives entirely on the biopolymer-bin
  generic-catch fallback. "INGEST exactly chem N" cannot enumerate
  that set → detritivory becomes inexpressible under naive
  universalization. The current fallback is doing real work.

**Decided (this note): particle-class ingestion.** Detritus is
acquired via a particulate channel keyed to a particle **class**,
*orthogonal* to any chem-id channel — a small new primitive, not a
chem id. Detritivory stays expressible without enumerating chems,
and selective diet ("chase organic, ignore rock") remains an
evolvable trait (unlike contact-ingest-all, which was rejected for
removing dietary selectivity).

Open sub-questions for the class taxonomy (resolve before Phase 2):

- **What defines a "class"?** Candidates: phase (solid/liquid/gas),
  named-vs-generic, a bond-energy band ("anything with bond
  potential > k" = "food-like"), or particle role. Leaning: a
  small fixed enum of physically-grounded classes (e.g. `SOLID`,
  `ORGANIC`/bond-energy-bearing, `MINERAL`) so it's coarse and
  emergent, not a hidden chem list.
- **Op shape:** one op `INGEST <classId>` *or* split into
  `INGEST_CHEM <chemId>` (precise) + `INGEST_CLASS <classId>`
  (bulk)? A single op with a small operand namespace that unions
  "class ids" and "chem ids" is likely cleanest but needs a
  disjoint encoding.
- Interaction with selective predation/`PREDATE` (also particle/
  creature contact) — keep separate.

## Open forks blocking Phase 2 code

1. **INGEST addressing regime** (user chose "design-note this
   first" — still open): (a) compat remap shim — operands 0–5 keep
   legacy bin meaning incl. generic-catch, ≥6 = direct chem id, no
   determinism break, permanent two-regime wart; vs (b) clean
   chem-id break — uniform `mod CHEMICAL_COUNT`, migrate all
   archetypes, determinism re-baseline, requires the particle-class
   channel (decided above) so #16 survives. Recommendation: (b) +
   particle-class channel, since (a)'s wart is permanent and the
   class channel is needed regardless; confirm before coding.
2. Particle-class taxonomy + op shape (sub-questions above).
3. `BOND` kin-marker relocation when it collapses into `CATALYST`.
4. `PACKAGE`/`COMPETENCE` rename + whether they leave the `SYNTH`
   family now or in Phase 5.

## Phase sequence (unchanged from agreed plan)

0 scaffold · **1 abiotic source — DONE** · 2 acquisition (INGEST
resolution + `TRANSPORT`, `SAVE_SCHEMA` bump + determinism
re-baseline) · 3 `SENSE_OUT` · 4 collapse named `SYNTH` → `CATALYST`
aliases · 5 retire receptor kinds/activation chems. Every commit:
`tsc`/`vitest`/`vite build` green + archetype-viability smoke; mass
conservation green every commit; determinism re-baselined only in
behavioral phases.
