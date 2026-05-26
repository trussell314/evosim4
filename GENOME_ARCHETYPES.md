# Genome archetypes & substrate-gap guide

What the current op set + chemistry actually lets you *build*, as a
partial guide for future enhancements. Each archetype lists concept,
key ops/SYNTH, behavior loop, what it probes, and feasibility. The
**substrate gaps** section at the end is the actionable part: each gap
names the single primitive that would unlock a whole branch of life.

Status: **shipped as injectable seeds.** All 33 archetypes (31 listed +
the two pre-paired composites `farmer-mito` / `farmer-chloroplast`) are
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

## Current SYNTH ABI (post Phase 4a/4b/5)

**Read this before reading the archetype descriptions below.** The op
set went through a redesign that retired most of the named SYNTH
kinds. There are now only **five live `SYNTH <kind>` values**:

- **`SYNTH CAT <slot>`** — synthesise catalyst protein for reaction
  slot `<slot>`. Multiplies that reaction's effective rate *above*
  the constitutive `uncatRate` floor. The primary differentiation
  mechanism: every "what kind of cell is this?" question is now
  "which slots is it pouring catalyst into?"
- **`SYNTH INH <slot>`** — synthesise allosteric inhibitor for slot
  `<slot>`. Damps the slot's effective rate *below* the floor. The
  off-switch dual of CAT.
- **`SYNTH BOND <marker>`** — set the cell's greenbeard adhesion tag.
- **`SYNTH COMPETENCE`** — express the eDNA-uptake competence flag
  this tick (HGT inbound).
- **`SYNTH PACKAGE`** — express the genome-shedding flag this tick
  (HGT outbound).

The named kinds `BIO/AA/FA/ENZ/CHL/MRNA/PHOTO/CHEMO/MECH/THERMO/MAGNETO/REPAIR`
**no longer exist.** Phase 4a retired the synthMask enable-gate, so
the bootstrap reactions they used to gate now fire on every cell at
`uncatRate` regardless of genome. A cell still synthesises mRNA,
membrane, fatty acid, photoreceptor, etc — it just does so at the
constitutive floor instead of being declared by a genome op.

**Named reaction slot numbers** (used as the `<slot>` byte for
`SYNTH CAT/INH`): respiration=0, ferment=1, beta-ox=2, photosynth=3,
synth_aa=4, synth_fa=5, synth_chl=6, synth_enz=7, synth_ribo=8,
synth_membrane(aa+fa)=9, digest_biopolymer=10, synth_membrane(fa)=11,
photoreceptor_visible=12, _long=13, _surface=14, electroreceptor=15,
vibroreceptor=16, phreceptor=17, mechanoreceptor=19, thermoreceptor=20,
magnetoreceptor=21, bond=22, repair=23,
ATP_translocase=TRANSPORT_ATP_SLOT (last transport-band slot).
Exported as named constants from `src/sim/reactions.ts`.

**Active emission — `OP.EMIT <channel>`** (a standalone op, not a SYNTH
kind). Pops a magnitude and deliberately spends ATP to broadcast on one
of `EMIT_CHANNELS=4`: electric=0, light=1 (bioluminescence), vibration=2,
magnetic=3. This is the emit half of the sensory substrate (detection is
the activation pass + receptors); several sense archetypes below use it.

## Toolkit recap

Sensing reads either an internal pool (`SENSE_CHEMICAL <id>`, with the
relevant activated chem populated by the activation pass once the
cell has the matching receptor — receptors are synthesised at
baseline, no genome op needed) or the spatial gradient of a chem
particle field directly (`SENSE_OUT <chemId>`, Phase-3 universal
gradient sense). Effectors: `THRUST/TURN`, `INGEST`, `PREDATE`,
`ENGULF`, `EXCRETE <chem>`, `TRANSPORT <chem>`, `REPRODUCE <frac>`,
`SYNTH <kind,param>` (see ABI above), plus self-modification
(`POKE_BYTE`, `SPLICE_DUP/DEL`). 16 persistent registers give
timers / oscillators / memory. Metabolism is the reaction table
(respiration, β-ox, photosynthesis, biosynth, biopolymer digestion,
generic catalyst-gated reactions). Predation gate is physical:
`attacker.r ≥ 1.14·target.r`, with cost ∝ target mass + membrane
(armor) + cohesion (bondChem × bond count). Engulf → the prey runs
its full VM as an endosymbiont (internal division uncapped); predate
→ absorb pools.

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
   `SYNTH CAT 3` (photosynth) + `SYNTH CAT 4/5/6` (aa/fa/chl synth) +
   `SYNTH CAT 9` (membrane). No INGEST/THRUST. Photosynthesis funds
   carbon fixation → glu → aa/fa/membrane; gate `REPRODUCE` on
   `SELF_MEMBRANE > k`. Probes stable primary production. **Fully
   expressible.**
2. **Phototactic / diel vertical migrator.** As #1 plus `SYNTH CAT 12`
   (visible photoreceptor) + `SYNTH CAT 21` (magnetoreceptor) +
   `SENSE_CHEMICAL act_photo_visible` for the gate, climb the
   activated magnetic gradient when dark. Probes emergent
   depth-keeping. **Fully expressible.**
3. **Thermophile band-tracker.** As #1 plus `SYNTH CAT 20`
   (thermoreceptor) + `SENSE_CHEMICAL act_thermo`; THRUST to null the
   offset → cells self-sort into thermal layers. **Fully
   expressible.**

## Heterotrophs / predators

4. **Chemotactic forager (honest baseline).** `SYNTH CAT 7`
   (synth_enz) + `SYNTH CAT 10` (biopolymer digestion) + `SYNTH CAT 9`
   (membrane), `INGEST` detritus, `climbParticleGradient(CHEM_BIOPOLYMER, …)`.
   **Fully expressible.**
5. **Size-bully predator.** Forager kit + `PREDATE` + heavy membrane
   storage to inflate radius past the predation size gate; roam and
   predate opportunistically. **Fully expressible.**
6. **Armored "tank" prey.** Extra `SYNTH CAT 9` and `SYNTH CAT 11`
   (both membrane-synth slots) on top of the forager kit; high
   membrane
   makes you expensive-to-impossible to breach (cost ∝ target
   membrane). Survive by being indigestible, not by fleeing.
   Exercises the emergent grow-big-vs-grow-armor axis. **Expressible,
   but RETAINED & UI-DISABLED (`uiHidden`).** A controlled 2×2
   (armor × reproduce-gate; full data in `SCENARIO_RESULTS.md` →
   "#6 armored") showed the apparent predation-resistance edge is
   the *high reproduce gate* — deferred division → larger
   non-dividing cells → size refuge past the predator's 1.14×
   breach gate — **not** the membrane investment: a soft forager@80
   matches armored@80 (~t420 / ~245 predation deaths). The
   membrane-breach-cost mechanic produces no separately selectable
   signal; "armor" is not a distinct phenotype from "divide late /
   grow big". Genome reverted to the catalogued gate 80 and kept for
   scenarios/tests/founder reproducibility, but removed from the
   spawn UI so it is not presented as a real strategy. See the
   substrate-gap note in `COLONY_GAPS.md` (predation resistance
   collapses onto body size).
7. **Greenbeard colony.** *Authored* (`id: colony`, label "greenbeard
   colony"). `SYNTH BOND <markerM>`; clones bond, gaining crossover at
   reproduction + cohesion predation-resistance. **Now expressible
   (substrate complete).** The differentiation gap is closed by other
   means: `PARTITION` gives genetically identical bonded clones
   divergent cytoplasm at division, which they read via
   `SENSE_CHEMICAL` — so true division of labor is *evolvable*. Caveat:
   the asymmetry is blind (a colony must evolve to act on its own
   divergent pools; it isn't an injected positional ID), and directed
   bond-channel transfer between roles is still leaky-diffusion only
   (COLONY_GAPS #2).
7b. **Differentiated germ/soma colony.** *Authored* (`id:
    differentiated-colony`, label "germ/soma colony"). The realization
    of #7's "division of labor is evolvable" note as an injectable seed:
    boosts the adhesion-molecule slot (`SYNTH CAT 22`) on top of the
    greenbeard tag so a cluster physically coheres, then `PARTITION
    mrna`s the translation-capacity pool toward the MOTHER at each
    fission. The mother keeps the ribosome cache and stays germ (high
    biosynthesis → keeps growing + dividing); each daughter buds off
    mRNA-poor and reads its own low `SENSE_CHEMICAL mrna` to drop into a
    soma role (forages + adheres, doesn't divide, slowly rebuilds mRNA).
    mRNA is chosen over a glucose dowry deliberately: glucose is burned
    to zero so the determinant signal vanishes, whereas mRNA is a
    maintained catalytic pool (every biosynth reaction scales on it), so
    the germ/soma spread *persists* across the cluster. The bias is
    toward the mother, not the daughter, because `synth_ribo` is itself
    mRNA-scaled — mRNA=0 is an absorbing death state, so the deprived
    daughter must keep a nonzero fraction (default child share 0.6 × a
    −1 bias → ~0.1) to recover. A **bloom brake** gates germ division on
    being both large (membrane > 50) and energy-flush (ATP > 40): the
    bigger size makes each soma daughter big enough to coast while it
    rebuilds mRNA (so soma recover instead of being a pure death sink),
    and the energy gate throttles division as the cluster depletes local
    food — without it the germ line over-divides and the colony
    bloom-crashes. One genome, two phenotypes, switched on inherited
    cytoplasm — the only archetype that exercises `PARTITION`. Payoff is
    emergent over generations.

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
10b. **Mitochondrion (faithful ATP-exporting endosymbiont).** *Authored*
    (`id: mitochondria`). Minimal soma + marker0 engulf-lure, respiration/
    digestion catalyst boosts, an **ATP translocase** (`SYNTH CAT
    TRANSPORT_ATP_SLOT`) exporting ATP across the vacuolar membrane, and a
    **glucose transporter** importing host glucose. With glucose
    permeability 0, an engulfed mito must express the carrier to feed and a
    free one starves — the obligate-symbiont property. ATP flows
    organelle→host whenever the mito is respiration-richer than the host.
    **Fully expressible.** Two pre-paired composite seeds also ship
    (`farmer-mito`, `farmer-chloroplast`): a farmer host spawned with the
    organelle already engulfed, to study whether the pairing persists and
    reproduces in tandem.

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

13. **Allelopath.** *Authored* (`id: allelopath`). Aggressively
    `EXCRETE waste + co2` to push the local ambient over the toxify
    thresholds and corrode the membranes of neighbors that absorb it.
    Survivable because of **heritable toxin self-resistance**: a genome
    that *expresses* `EXCRETE <toxin>` is immune to that toxin's toxify
    (the efflux machinery that exports it also protects the cell — a
    persistent, genome-derived property, not a per-tick exemption). So
    the allelopath and its clonal kin (same two excrete genes) tolerate
    the shared poison while any susceptible victim that does not produce
    it still takes damage. Emergent chemical warfare with self/kin
    immunity. (A waste-only variant that stopped venting CO₂
    self-poisoned on its own respiratory CO₂ and went extinct — venting
    both is what keeps it viable.)
14. **Marker beacon / lure.** `EXCRETE marker0`; other lineages
    `SENSE_OUT CHEM_MARKER0` to read the spatial gradient directly
    (Phase 3 universal gradient sense, no SYNTH-receptor needed).
    Substrate for emergent aggregation, trail-following, prey
    luring, quorum-like behavior — none of it scripted.

## Benthic / sediment niche

A sea-floor detritus loop. #16 is authored; #17 is blocked on a
confirmed substrate gap (see below + `COLONY_GAPS.md` GAP #6).

16. **Benthic detritivore / decomposer.** *Authored* (`id:
    benthic-detritivore`, label "benthic grazer"). Chemotaxes the
    *settled* bulk-organic — the "marine snow" of dead cells /
    aggregated polymers that sinks (`CHEM_BIOPOLYMER` density 1.05 >
    water) and pools on the floor — `INGEST`s it, runs heterotroph
    synthesis, and `EXCRETE`s its metabolic CO₂ back into the medium.
    **Benthic position is EMERGENT, not scripted:** there is no
    "descend" op; the cell merely climbs the detritus gradient and,
    because detritus sinks, it ends up on the floor. The CO₂ emission
    is the niche-defining seed for a future cross-feeder. **Fully
    expressible**; scenario `benthic` (scripts/scenario.ts) validates
    sustain + emergent depth + CO₂ output. (Note: the original
    "negatively-buoyant / THRUST to stay low" framing was wrong —
    creatures are water-neutral with no passive sink; the working
    mechanism is food-tropism, which is cleaner / more emergent.)
17. **Benthic chemolithotroph / cross-feeder.** *Expressible;
    chemistry no longer the blocker* (reclassified — the earlier
    "blocked / inexpressible" was retracted, then the carbon-throughput
    scarcity was closed; see `COLONY_GAPS.md` GAP #6). The reaction
    table has 221 procedurally-generated generic reactions (~41%
    exergonic) that are inert until a genome evolves `SYNTH CAT
    <slot>`, so catabolic strategy **is** genome-selectable and
    non-photic energy **is** harvestable. The Phase-1 `vent` scenario
    (bounded abiotic fuel seep, no engine change) shows a probe genome
    sustains ATP 100+ purely from abiotic fuel and reproduces once a
    carbon-fix catalyst is added. Carbon fixation used to be the
    bottleneck (one slow GLU route from acquirable inputs); the table
    now seeds **9 acquirable-input carbon routes** on an effort/yield
    gradient (`installCarbonFixReactions`, 8 graded CO₂→glucose doors +
    the original), cheap-low-yield through rare-substrate-high-yield.
    Remaining work to ship a self-sustaining seed is a world vent fuel
    source (validated, low-risk) + the archetype itself — not a
    chemistry change.

## Sensory & signaling ecology (light · vibration · electric · pH · magnetism)

The sensory substrate (detection + `OP.EMIT`) shipped a family of authored
seeds, each illustrating one channel driving behavior. All are fully
expressible and spawnable from the archetypes panel.

- **swarmer** — emits a marker0 plume AND climbs the marker0 gradient, so
  clonal kin accrete into drifting swarms. Emergent aggregation from one
  shared chemical channel.
- **scout** — climbs the food (biopolymer) gradient but FLEES the waste
  gradient, threading between food and allelopath/dead-zone poison.
- **rheotroph** — builds a mechanoreceptor and thrusts along the net force
  it feels (currents, swells), riding bulk water motion to disperse.
- **acidophile** — builds a phreceptor + heat-shock chaperone; uses the
  acidity reading bistably to seek and niche-lock to the acidic vent zone.
  pH driving habitat selection. Spawn near a vent.
- **magneto-navigator** — swims along the positional geomagnetic field
  vector (declination across x, intensity with depth) → directed
  migration / depth-keeping; substrate for homing.
- **magneto-relay** — `EMIT`s a magnetic pulse that is NOT rock-occluded
  and carries long range, so cells separated by obstacles still sense each
  other; also listens. Obstacle-spanning coordination.
- **skitterer** — builds a vibroreceptor and bolts AWAY from the bearing
  of any nearby moving cell (hears a wake, flees before contact). Sets up a
  speed-vs-stealth arms race.
- **thumper** — spends ATP to `EMIT` a vibration pulse every tick.
  Substrate for acoustic communication / alarm / luring.
- **light-shoaler** — boosts its visible photoreceptor and swims up the
  reflected-light bearing toward sunlit neighbors → visible schooling in
  lit water.
- **anglerfish** — `EMIT`s visible light (a lure that shines in the dark)
  then PREDATEs + engulfs light-seeing prey that home on the glow. Emergent
  lure-and-ambush; best in deep water.
- **electric-beacon** — broadcasts a bioelectric pulse (`EMIT` electric)
  every tick. Substrate for electrocommunication / kin signalling / luring
  / jamming; the ATP cost makes loud signalling a real tradeoff.
- **electro-hunter** — builds an electroreceptor and homes on the
  bioelectric glow of metabolically-active cells, then strikes on contact.
  Hunts by electroreception even with no chemical trail or light.

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

_Status: all 33 archetypes are shipped as injectable founder seeds
(`src/genome-archetypes.ts` + the `src/genome-asm.ts` assembler +
the "archetypes" UI panel), authored to the author + sanity-spawn
bar (assemble well-formed, disassemble clean, spawn + step without
error; the 13 self-sufficient ones also pass `viableGenome`). The
five substrate gaps above are implemented; see `TODO.md` /
`ENDOSYMBIOSIS_NOTES.md` / `COLONY_GAPS.md` for specifics and the
remaining open colony gaps (#2/#4/#5)._
