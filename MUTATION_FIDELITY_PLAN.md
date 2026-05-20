# Evolvable Mutation Fidelity & Realistic DNA Repair — Design Note

Status: **deferred / not started**, and **partially blocked by ABI
changes**. Captured so it isn't lost while colony testing continues.
No code written yet.

**ABI note (post Phase 4a/5).** The plan references `SYNTH REPAIR`,
`SYNTH_BIT_REPAIR`, and `CHEM_REPAIR` as gating mechanisms. The
`SYNTH REPAIR` op was retired alongside the rest of the named
biosynth/receptor kinds; the bit export is gone too. When this plan
is picked up the gating mechanism needs to be reformulated — most
likely as `SYNTH CAT 23` (the named slot for the repair-chem
biosynth reaction) plus the `CHEM_REPAIR` pool that's still in the
chem table.

## Motivation

Two related ideas:

1. **Genome-encoded germline mutation rate** — let a lineage evolve its
   own reproduction error rate instead of it being a fixed global
   constant in `mutateGenome`.
2. **A realistic somatic-mutation mitigation system** — replace the
   binary "magic" `REPAIR` mechanism (`c.repairTicks` hard-zeroes
   `mutP`) with a chemistry/enzyme-pool model that has a real cost
   gradient.

Recommendation: unify both under a single `CHEM_REPAIR` enzyme-pool
mechanism. One coherent system drives both somatic mitigation and
germline fidelity — less code, biologically sensible.

## Current state (as of this note)

- Germline mutation: `mutateGenome(genome, rng)` at fission, fixed
  per-byte rate.
- Somatic mutation: `sim.ts` (~6655–6690). `mutP = min(0.02,
  SOMATIC_MUTATION_AGE_COEF * age^2 * dt)`. `SYNTH REPAIR` →
  `c.repairTicks` → hard-zeroes `mutP` while > 0. Candidate edit gated
  by `viableGenome(candidate)`.
- `SYNTH REPAIR` kind already exists and sets `SYNTH_BIT_REPAIR`
  (`genome.ts`). Codebase comments already reference an intended
  `CHEM_REPAIR` pool.
- **Determinism gotcha:** somatic mutation currently rolls
  `Math.random()` (`sim.ts:~6668`), NOT the seeded world RNG. This is
  why re-enabling somatic mutation did not break the reproducibility
  test. Any expansion MUST move this to the seeded world RNG or
  determinism / repro testing breaks. Treat this as a prerequisite.

## Part 1 — Evolvable germline mutation rate

Plumbing is small:

- Derive a per-cell "fidelity" from existing `SYNTH REPAIR`
  investment (reuse `SYNTH_BIT_REPAIR` / the `CHEM_REPAIR` pool at the
  moment of fission) rather than adding a new opcode or reserved
  register.
- Thread a per-byte rate parameter into `mutateGenome` driven by that
  fidelity state.

The hard part is **evolutionary stability**, not plumbing:

- Mutation rate is a second-order trait under weak, indirect
  selection.
- If fidelity is free to raise, selection drives mutation rate → ~0
  (**mutator collapse**); evolution freezes, sim goes static.
- Avoided only with a genuine cost gradient: higher fidelity must cost
  ATP / materials / time so there is a real tradeoff curve (fidelity
  vs. growth / reproduction).
- Needs a hard noise floor (irreducible polymerase error) and an upper
  clamp (error-catastrophe / divide-by-zero safety).

Deliverable is the **cost function**, not the wiring. Must be validated
with the A/B probe harness for the equilibrium band.

## Part 2 — Realistic somatic mitigation (replace magic REPAIR)

A small kinetic system:

1. **Damage as a state variable.** Lesions accumulate per tick, scaled
   by age AND metabolic rate (rate-of-living: fast `THRUST`/`SYNTH`
   cells take more oxidative damage). Makes repair a real life-history
   axis, not an age timer.
2. **Repair as an enzyme pool.** `SYNTH REPAIR` produces a
   `CHEM_REPAIR` chem with material + ATP cost (like other SYNTH
   kinds). Pool decays — fidelity is an ongoing investment, not
   one-shot.
3. **Saturating repair kinetics.** Lesion → mutation conversion per
   tick reduced by `CHEM_REPAIR` concentration with diminishing
   returns (Michaelis–Menten-style). Repair itself imperfect (small
   misrepair chance). Unrepaired lesions feed the existing
   `somaticMutateOnce` path, still gated by `viableGenome`.

Net: cells trade growth/reproduction against genomic stability; fast
metabolism is genuinely riskier; "repair" emerges from chemistry
instead of a flag.

## Integration points / work breakdown

- **Prereq:** move somatic mutation RNG from `Math.random()` to the
  seeded world RNG (`sim.ts:~6668`).
- `sim.ts`: replace the `repairTicks` block (~6666–6690) with pool
  dynamics — per-tick damage accrual, `CHEM_REPAIR` consumption + ATP
  cost, saturating lesion→mutation conversion. Add/confirm a
  `CHEM_REPAIR` chem id in the chem table.
- `genome.ts`: translate the `SYNTH_BIT_REPAIR` mask bit into actual
  `CHEM_REPAIR` production with cost, parallel to how other SYNTH kinds
  produce their chems. Germline path reads repair-pool/fidelity at
  fission to scale `mutateGenome`.
- `mutateGenome` signature: add per-byte rate param driven by cell
  fidelity state.
- Balance + validate via the probe harness (`scripts/probe_long_run.ts`
  and the A/B adhesion-style methodology): confirm mutation rate
  self-stabilizes (no mutator collapse, no error catastrophe) and the
  sim stays dynamic.

## Open risks

- Mutator collapse / error catastrophe if the cost curve is wrong.
- Determinism regression if the RNG prereq is skipped.
- Tuning load: the cost function is the real research problem and will
  need several probe iterations.
