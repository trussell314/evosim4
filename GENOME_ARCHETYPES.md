# Genome archetypes & substrate-gap guide

What the current op set + chemistry actually lets you *build*, as a
partial guide for future enhancements. Each archetype lists concept,
key ops/SYNTH, behavior loop, what it probes, and feasibility. The
**substrate gaps** section at the end is the actionable part: each gap
names the single primitive that would unlock a whole branch of life.

Status: **shipped as injectable seeds.** All 15 archetypes below are
now hand-authored founder genomes (`src/genome-archetypes.ts`, built
via the `src/genome-asm.ts` assembler) and spawnable from the
collapsible "archetypes" UI panel. Substrate stance is preserved: a
founder genome is a *seed / hypothesis*, not an engine rule — a
clicked archetype injects one ordinary cell via the existing
`spawnSpeciesInstance` path, gets no special treatment, and must
survive selection on its own. The "seed"-class entries (colony,
chloroplast, farmer, endoparasite, virus) ship a deliberately modest
founder whose payoff is an emergent multi-generation / multi-cell
outcome — one click is one cell. This doc still also informs backlog
priorities.

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

Substrate additions (this round — see the gaps section, all now
resolved):

- **`PARTITION <chem>`** — pop a bias; skews that chem's mother/
  daughter split at the next division. Genetically identical daughters
  emerge with different cytoplasm; differentiation is now *evolvable*
  (the asymmetry is "blind" — a lineage must also evolve to read its
  own divergent pools via `SENSE_CHEMICAL`).
- **`SYNTH PACKAGE` / `SYNTH COMPETENCE` + eDNA carriers** — lysing or
  packaging cells shed a genome fragment as a decaying extracellular
  carrier; a competent cell integrates one append-only. The physical
  HGT / virus / plasmid / EGT vector (no addressed "inject" — a donor
  cannot target a recipient).
- **Standing transporters** — `SYNTH CAT param=slot` for a slot in the
  transport band builds a carrier protein that moves one core
  metabolite (O₂/CO₂/glu/aa/fa/min/ADP/waste) across a membrane by
  facilitated, MM-saturated, gradient-driven flux — at *both* the
  outer membrane (cell↔world) and the vacuolar membrane
  (host↔organelle, host's + organelle's catalysts summed). Replaces
  nothing; composes with `INGEST`/`EXCRETE` pulses and diffusion.

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
   crossover at reproduction + cohesion predation-resistance. **Now
   expressible (substrate complete).** The differentiation gap is
   closed by other means: `PARTITION` gives genetically identical
   bonded clones divergent cytoplasm at division, which they read via
   `SENSE_CHEMICAL` — so true division of labor is *evolvable*. Caveat:
   the asymmetry is blind (a colony must evolve to act on its own
   divergent pools; it isn't an injected positional ID), and directed
   bond-channel transfer between roles is still leaky-diffusion only
   (COLONY_GAPS #2).

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
   payoff of the organelle work). Now *also* expressible by a direct
   means: the host can `SYNTH CAT` vacuolar transporter catalysts to
   actively bias metabolite flux to/from every organelle it carries
   (farm or starve), still footprint-driven, still no addressed verb.
10. **Endoparasite / "Trojan".** Tiny cell that *wants* to be eaten:
    minimal soma, `EXCRETE marker0` bait, low membrane (cheap to
    engulf). Inside: `REPRODUCE` hard (uncapped internal division) and
    `INGEST` from the host pool until the host autolyzes and releases
    the brood. **Fully expressible.** (No longer the *closest* thing to
    a virus — see #15, now a literal one.)

15. **True virus / mobile genetic element.** `SYNTH PACKAGE` to shed
    fragments of its own genome as decaying eDNA carriers; victims that
    express `SYNTH COMPETENCE` integrate the fragment append-only. No
    soma required for the genome itself to spread — infection is the
    physical carrier + recipient competence, not a targeted op. A
    lysing carrier-rich cell is also a passive transformation source;
    a dead engulfed symbiont seeds its host's buffer (EGT). Spans
    lytic-virus, plasmid, and conjugation-like strategies depending on
    where/when shedding and competence are expressed. **Fully
    expressible** — the branch the gaps section called the
    highest-leverage missing one.

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

**All five gaps below are now RESOLVED** — each closed via a substrate
primitive rather than the originally-sketched op, so the "via other
means" note matters. Kept here as the rationale + the exact means.

- **Horizontal genome injection.** *Resolved — via a physical vector,
  not an "inject" op.* `SYNTH PACKAGE` sheds a self-genome fragment as
  a decaying eDNA carrier; `SYNTH COMPETENCE` integrates a nearby one
  append-only. A donor *cannot* address a recipient — spread is the
  carrier + competence, so virus/plasmid/conjugation are evolvable
  strategies, not a scripted transfer. (`TODO.md` "HGT/EGT DONE".)
- **Death-triggered EGT.** *Resolved — same substrate, intracellular
  locality.* A dead engulfed symbiont sheds into the host's eDNA
  buffer; the host's own `COMPETENCE` integrates it. The count-scaled
  ratchet *emerges* from death frequency (more symbionts → more deaths
  → fuller buffer) — no per-death probability formula.
- **Cell differentiation substrate.** *Resolved — but reframed.* Not
  an injected positional/division-count ID; instead `PARTITION <chem>`
  biases the per-chem mother/daughter split so identical genomes get
  divergent cytoplasm, which they read through the existing
  `SENSE_CHEMICAL`. Opens the same door (division of labor is now
  evolvable); caveat: the asymmetry is *blind* — a lineage must evolve
  to act on its own pools. (COLONY_GAPS #1; #2 directed bond transfer
  still open.)
- **Dual/contested host↔organelle membrane.** *Resolved — via the
  transporter substrate, no host-side "transport bias" verb.* Vacuolar
  transporters: the host's *and* the organelle's transporter catalysts
  act across the shared membrane (summed). Host farm/starve and
  parasite/mutualist/domestication dynamics are reachable; control
  stays footprint-driven (the host's transporter-k acts equally across
  every organelle, no addressed delivery). (`ENDOSYMBIOSIS_NOTES.md`
  RESOLVED banner.)
- **Standing transporters.** *Resolved — chem-id-gated, facilitated.*
  `SYNTH CAT` on a transport-band slot builds a carrier protein giving
  continuous, MM-saturated, gradient-driven flux of one core
  metabolite at the outer + vacuolar membranes, composing with
  `INGEST`/`EXCRETE` and diffusion. Scope lines: facilitated only
  (active/uphill `atpDelta` pumping reserved); *signature-gated*
  selectivity not built; only the 8 small-molecule metabolites
  (generic-chem transporters deferred — `TODO.md`).

_Status: all 15 archetypes are shipped as injectable founder seeds
(`src/genome-archetypes.ts` + the `src/genome-asm.ts` assembler +
the "archetypes" UI panel), authored to the author + sanity-spawn
bar (assemble well-formed, disassemble clean, spawn + step without
error; the 13 self-sufficient ones also pass `viableGenome`). The
five substrate gaps above are implemented; see `TODO.md` /
`ENDOSYMBIOSIS_NOTES.md` / `COLONY_GAPS.md` for specifics and the
remaining open colony gaps (#2/#4/#5)._
