# Genome archetypes & substrate-gap guide

What the current op set + chemistry actually lets you *build*, as a
partial guide for future enhancements. Each archetype lists concept,
key ops/SYNTH, behavior loop, what it probes, and feasibility. The
**substrate gaps** section at the end is the actionable part: each gap
names the single primitive that would unlock a whole branch of life.

Status: design reference. Nothing here is a committed founder genome
or implementation; it informs backlog priorities.

## Toolkit recap

Sensing is indirect: `SYNTH` a receptor (PHOTO band / CHEMO target /
MECH / THERMO / MAGNETO) so the activation pass fills the matching
`activated_*` chem, then `SENSE_CHEMICAL <id>` reads it. Effectors:
`THRUST/TURN`, `INGEST`, `PREDATE`, `ENGULF`, `EXCRETE <chem>`,
`REPRODUCE <frac>`, `SYNTH <kind,param>`, plus self-modification
(`POKE_BYTE`, `SPLICE_DUP/DEL`). 16 persistent registers give
timers / oscillators / memory. Metabolism is the reaction table
(respiration, β-ox, photosynthesis, photophosphorylation, biosynth,
biopolymer digestion, generic catalyst-gated reactions). Predation
gate is physical: `attacker.r ≥ 1.14·target.r`, with cost ∝ target
mass + membrane (armor) + cohesion (bondChem × bond count). Engulf →
the prey runs its full VM as an endosymbiont (internal division
uncapped); predate → absorb pools.

## Autotrophs

1. **Complete photoautotroph (sessile primary producer).**
   `SYNTH CHL`, `SYNTH PHOTO 0`, `SYNTH AA/FA/MRNA/BIO`. No
   INGEST/THRUST. Photophosphorylation funds carbon fixation → glu →
   aa/fa/membrane; gate `REPRODUCE` on `SELF_MEMBRANE > k`; dump
   surplus glu → biopolymer to seed the web. Probes stable primary
   production. **Fully expressible.**
2. **Phototactic / diel vertical migrator.** Add `SYNTH PHOTO 0`+`1`
   and `SYNTH MAGNETO`; THRUST toward `act_mag` when `act_photo`
   low, descend when high. Probes emergent depth-keeping. **Fully
   expressible.**
3. **Thermophile band-tracker.** `SYNTH THERMO`; THRUST to null the
   `act_thermo` offset → cells self-sort into thermal layers. **Fully
   expressible.**

## Heterotrophs / predators

4. **Chemotactic forager (honest baseline).** `SYNTH CHEMO 0` +
   `SYNTH ENZ`, `INGEST biop`; THRUST up `act_chemo_biopolymer`,
   digest (out[10]), gate REPRODUCE on membrane. **Fully
   expressible.**
5. **Size-bully predator.** `PREDATE` + heavy storage to inflate
   radius and stay above the predation size gate; roam and predate
   opportunistically. **Fully expressible.**
6. **Armored "tank" prey.** Max `SYNTH BIO` (membrane); high membrane
   makes you expensive-to-impossible to breach (cost ∝ target
   membrane). Survive by being indigestible, not by fleeing.
   Exercises the emergent grow-big-vs-grow-armor axis. **Fully
   expressible.**
7. **Greenbeard colony.** `SYNTH BOND <markerM>`; clones bond, gaining
   crossover at reproduction + cohesion predation-resistance. **Partly
   expressible** — bonded cells are genetically identical and run the
   same VM, so true division of labor can't emerge yet (see
   COLONY_GAPS).

## Endosymbiosis candidates

8. **Chloroplast analog (mutualist).** A small photoautotroph that
   also `EXCRETE glu` each tick. Engulfed, it fixes carbon from the
   host's CO₂ and excretes glucose into the host pool — a mutualist
   the host can farm. **Fully expressible.**
9. **Farmer host.** Heterotroph that `ENGULF`s #8, then *suppresses
   its own world-excretion of glucose* (keeps cytoplasm rich) and
   relies on internal division + fission partitioning to keep a
   symbiont population. Farming emerges from the indirect cytoplasm
   lever — no "feed organelle" op. **Fully expressible** (the headline
   payoff of the organelle work).
10. **Endoparasite / "Trojan".** Tiny cell that *wants* to be eaten:
    minimal soma, `EXCRETE marker0` bait, low membrane (cheap to
    engulf). Inside: `REPRODUCE` hard (uncapped internal division) and
    `INGEST` from the host pool until the host autolyzes and releases
    the brood. Closest thing to a "virus" the engine supports. **Fully
    expressible.**

## Self-modifiers (exotic, fully expressible)

11. **Stress amplifier.** Watch `SELF_ENERGY` in a register; starving
    → `SPLICE_DUP` the metabolic block (gene amplification); fat →
    `SPLICE_DEL` to streamline. Heritable size plasticity.
12. **Phenotypic bet-hedger.** A register oscillator drives
    `POKE_BYTE` to flip a `JZ` offset in its own genome, toggling
    grow/disperse programs across ticks — non-genetic switching, only
    possible because the VM rewrites live code.

## Signaling / chemical ecology (expressible, under-explored)

13. **Allelopath.** Aggressively `EXCRETE waste/co2` to push local
    ambient over toxify thresholds and damage neighbors. Emergent
    chemical warfare.
14. **Marker beacon / lure.** `EXCRETE marker0`; other lineages that
    `SYNTH CHEMO 3` sense the `act_chemo_marker0` gradient. Substrate
    for emergent aggregation, trail-following, prey luring,
    quorum-like behavior — none of it scripted.

## Substrate gaps → what each unlocks (the guide)

- **Horizontal genome injection.** No op transfers genome bytes into
  *another* live cell (`POKE`/`SPLICE` are self-only; `PREDATE` moves
  pools not code). A single "inject" primitive opens the entire
  virus / plasmid / HGT design space. Highest-leverage missing branch.
- **Death-triggered EGT (already backlogged).** Host acquires a dead
  symbiont's genome fragment/capability — the no-permission ratchet
  that lets host takeover of organelles emerge. See
  `ENDOSYMBIOSIS_NOTES.md` §5, `TODO.md`.
- **Cell differentiation substrate.** A heritable per-cell state set
  at division (position-in-colony / division count the VM can read)
  so genetically identical bonded cells can express differently —
  the prerequisite for true multicellular division of labor
  (COLONY_GAPS).
- **Dual/contested host↔organelle membrane (backlogged).** Host-side
  transport so addressed delivery and parasite/mutualist/domestication
  dynamics are reachable. `ENDOSYMBIOSIS_NOTES.md` §2/§4.
- **Standing transporters.** Continuous gradient-driven flux gated by
  chem id or signature, vs. the current imperative INGEST/EXCRETE
  pulses — the keystone for organelle integration and selective
  exchange. `ENDOSYMBIOSIS_NOTES.md` §3.

_Status: design reference only. Not scheduled, not implemented._
