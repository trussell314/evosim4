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
   renamed. The original "named-SYNTH ≡ `CATALYST <fixed slot>`
   alias" framing was wrong (a rename), and the review's "tangled
   behavioral redesign" framing over-stated it. **Resolved framing
   (2026-05-19):** the engine has TWO cleanly separable mechanisms,
   which the named slots happen to bundle:
   - **Free enable-gate** — named bootstrap reactions (slots 0–25)
     carry `uncatRate > 0` ("bootstrap rate every cell gets free",
     `reactions.ts:257`) **plus** a `gateMask` = a `synthMask` bit
     (`:258`). The gate is an *enable flag* ("the genome ran
     `SYNTH BIO`, so this curated pathway is unlocked"), NOT the
     rate. The free rate already lives in `uncatRate`.
   - **Paid catalyst pool** — generic slots have `uncatRate:0,
     gateMask:0`; inert until a `catalystCols` pool is biosynthesized
     at `CAT_ATP_COST` (decaying, must be rebuilt), adding
     `vmax·pool/CAT_REF`.
   `CATALYST` only ever needs to be the **paid pool — one
   behavior**. The free floor does NOT belong in the op; it is
   already in the reaction table's `uncatRate`. So named `SYNTH`
   biomass/pigment kinds become **unnecessary, not aliased**: a
   do-nothing genome still metabolizes off `uncatRate`; `CATALYST`
   is purely the specialization lever on top. Phase 4 reduces to
   ONE scoped decision: keep the "must declare the pathway"
   enable-gate (preserves real selective pressure — losing
   `SYNTH BIO` by mutation currently sterilizes a lineage) or drop
   it (a do-nothing cell becomes baseline-viable; changes
   evolutionary dynamics). Still determinism-sensitive, but a single
   knob, not a multi-slot tangle. `BOND`'s kin-marker is the one
   genuinely separate loss (relocate, see below); product-driven
   machinery (membrane integrity, repair→mutation-suppression,
   adhesion, `CHL`→photosynthesis) is preserved automatically
   because those reactions/products are untouched — only the
   `synthMask` *gate path* is what's being retired.

   **Why the paid property is non-negotiable:** (1) it is the
   emergence mechanism — free catalysis ⇒ every cell expresses
   every catalyst ⇒ no opportunity cost ⇒ no selection for distinct
   metabolic strategies (substrate-not-script collapses); (2) it is
   the conservation spine — ~half the generic reactions are
   exergonic, so zero-cost activation = an unconditional energy
   fountain; the build+maintenance cost is the thermodynamic price
   against perpetual motion; (3) the free bootstrap floor is the
   deliberate bounded exception (newborn viability: can't pay for
   catalysts before metabolizing), intentionally weak and limited to
   the curated set, never the open generic space.
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
| `SENSE_OUT <chemId>` | chem id | **NOT a scalar read.** `runActivation` (`sim.ts:3398-3435`) emits *directional X/Y gradient* vectors (`CHEM_ACT_*_X/_Y`), receptor-pool-scaled and decaying. A scalar ambient read cannot express taxis. Subsuming the receptor machinery requires returning a gradient **vector** (≥2 values + receptor gating + decay) — a substantially larger primitive than one row implies |
| `TRANSPORT <chemId>` | chem id | signed-amount membrane flux; facilitated down-gradient (free), active up-gradient (ATP cost). "Conservation-airtight" is a REQUIREMENT not a freebie: the ATP debit and moved-mass credit must enter the *same* accounting the mass test checks (current transporters are `atpDelta:0`, applied via `runTransportReactions` `sim.ts:5227`). Subsumes `EXCRETE` + transporter band |
| `CATALYST <slotId>` | reaction slot | analog level from stack. **One behavior: the paid catalyst pool.** The free bootstrap floor stays in the reaction table's `uncatRate` (not the op); named `SYNTH` kinds become unnecessary, not aliased (see Rule 1) |
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

## Decisions (settled 2026-05-19)

**#1 + #2 — INGEST is a bond-energy-threshold engulf op (RESOLVED,
supersedes the compat-shim vs chem-id-break fork and the
particle-class-taxonomy sub-questions).** Particulate ingestion is
*not* chem-id addressed at all. `INGEST` pops a **bond-energy
threshold** from the stack and engulfs any contacted particle with
`CHEM_BOND_POTENTIAL ≥ threshold`. Consequences:

- Detritivory = low threshold (eats the open generic set, no
  enumeration / no fallback bin / no class enum).
- Selective feeding = high threshold (energy-rich only) — an
  evolvable scalar, not a curated list.
- "Chase organic, ignore rock" is *emergent from physics*:
  `MIN`/O₂/CO₂ are `bondEnergy 0`, so any threshold > 0 excludes
  them with no special case.
- No non-uniform operand namespace (no `INGEST <chemId>` and no
  `INGEST <classId>`) — the review's namespace-wart tension is
  eliminated, not managed. Chemical specificity moves *after*
  ingestion to internal reactions/`TRANSPORT`, which are already
  chem-id addressed.
- Trade accepted: ingestion selectivity is a coarse energy band,
  not species-level — but it was always coarse (6 bins) and is
  more substrate-honest as an emergent/internal concern.
- Migration (Phase 2b): archetype `INGEST <bin>` → `PUSH <thresh>;
  INGEST`; determinism re-baseline + viability re-check (esp. #16
  detritivore, the forager line). The `sim.ts:5625` generic-catch
  fallback and `SENSOR_BIN_BY_CHEM` are deleted, not ported.

Still open (do not block Phase 2a `TRANSPORT`, which is INGEST-
independent):

3. `BOND` kin-marker relocation when the `synthMask` gate path is
   retired (Phase 4 gate decision).
4. `PACKAGE`/`COMPETENCE` rename + whether they leave the `SYNTH`
   family now or in Phase 5.
5. Phase 4 enable-gate: keep "declare the pathway" vs drop it
   (deferrable to Phase 4; see Rule 1).

## Review findings — hard constraints (2026-05-19, code-grounded)

A critical review verified claims against source. Sound: the
slot-addressing rule (1) and the INGEST sensor-bin/generic-catch
finding. Corrected above: the SYNTH→CATALYST "alias" and SENSE_OUT
"scalar subsumption" framings. Additional hard constraints any
Phase-2+ code must satisfy:

- **RNG draw-order is load-bearing.** `buildReactionTable`'s seeded
  draws + `TRANSPORT_SLOT_BASE = N_REACTIONS - TRANSPORT_TARGETS`
  (`reactions.ts:176-203`) must stay byte-identical. Any reaction-
  slot reorganization for fixed-slot constants (Phase 4) risks
  reordering import-time draws — treat as a hard constraint.
- **256-slot budget.** Alias slot constants + the open generic
  space + the transporter band all share `CATALYST_COUNT=256`
  (`genome.ts:134`, `NAMED_REACTION_COUNT=26`). Collision/budget is
  unresolved — must be reconciled before Phase 4.
- **Active-transport conservation accounting** must be specified
  (not just asserted): ATP debit + mass credit in the mass-test
  accounting.
- **`observedOpBias` heritability shift.** Collapsing opcodes
  shrinks `OP_BYTES` (`genome.ts:1187-1221`), changing every seeded
  lineage's heritable junk-tolerance ratio — a determinism *and*
  evolutionary-dynamics change to call out, not silent.
- **Per-chem hot loops.** `SENSE_OUT`/`TRANSPORT` over 96 chems and
  catalyst dispatch (`sim.ts:5233` 256-bit loop) are per-cell-per-
  tick; size the cost.

INGEST: resolved to the bond-energy-threshold engulf op (see
Decisions #1+#2 above). The review's "continuous bond-energy
threshold over an enum" steer is adopted in full, taken one step
further: there is no chem-id ingest channel at all, so the
non-uniform-namespace tension is eliminated rather than flagged.

## Phase sequence

0 scaffold · **1 abiotic source — DONE** · 2 acquisition:
**2a-i `TRANSPORT` facilitated/down-gradient/no-ATP — DONE**
(opcode 0x56, signed `out.transport`, mass-exact applier, golden
re-baselined 11f0b56b→22e020e8, SAVE_SCHEMA 11→12, +2 unit tests) ·
**2a-ii `TRANSPORT` active/uphill + ATP cost — DONE** (down-gradient
free/facilitated; up-gradient pumps but costs
`TRANSPORT_PUMP_ATP·ln(1+C_dest/C_src)`, affordability-limited;
down-leg yields no ATP so no cycle can mint energy; SAVE_SCHEMA
12→13; golden unchanged; +1 no-free-energy A-vs-B test) ·
**2b INGEST → bond-energy-threshold engulf — DONE** (zero-operand;
pops a stack threshold ×INGEST_TH_SCALE=0.02; sensor bins +
biopolymer generic-catch fallback deleted; all archetypes + scenario
probes migrated to `PUSH8;INGEST`; SAVE_SCHEMA 13→14; golden
22e020e8→880fc7e9; forager/benthic/vent viability re-verified)
· **3 `SENSE_OUT` gradient-vector sensor — DONE** (opcode 0x6E,
operand=chemId; pushes [gx,gy] from chemGradient at the cell's
position for ANY chem with no SYNTH'd receptor — emergent taxis;
zero vector for engulfed organelles; VMSensors gained a deterministic
`gradient()` hook supplied by the engine, no per-tick alloc; legacy
receptor/activation machinery kept in parallel — forager still
viable; SAVE_SCHEMA 14→15; golden unchanged; +2 tests) · 4 retire
the `synthMask` enable-gate path; `CATALYST`
becomes the sole paid lever; ONE decision: keep or drop the
"declare the pathway" gate (free floor already in `uncatRate`) ·
5 retire receptor kinds/activation chems. **Phases 2, 3, 4 and 5 are
ALL behavioral** (determinism re-baseline + `SAVE_SCHEMA` bump +
explicit mass/RNG-order handling) — but Phase 4 is one scoped gate
decision, not a multi-slot tangle. Every
commit: `tsc`/`vitest`/`vite build` green + archetype-viability
smoke; mass conservation green every commit.
