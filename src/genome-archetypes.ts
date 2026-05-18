// Hard-coded founder genomes for the GENOME_ARCHETYPES.md catalogue.
//
// Substrate stance: a founder genome is a *seed*, not an engine rule.
// These are authored hypotheses a user can inject and watch selection
// keep or discard -- the engine forces none of the behavior, spawned
// cells get no special treatment (see spawnSpeciesInstance: not added
// to founderIds, normal life/death). Authoring them via the assembler
// keeps them reviewable; the module is RNG-free and imports no engine
// state, so building the table has zero determinism impact.
//
// Two classes:
//   - "direct": the behavior loop is fully expressed by the founder.
//   - "seed":   the founder is modest; the archetype's payoff is an
//               emergent multi-generation / multi-cell outcome (one
//               spawn click is one cell -- the social ones need a
//               long run or repeated injection to show their point).

import { asm, assertWellFormed, type Instr } from "./genome-asm";
import {
  CHEM_ACT_PHOTO_VISIBLE,
  CHEM_ACT_CHEMO_BIOPOLYMER_X,
  CHEM_ACT_CHEMO_BIOPOLYMER_Y,
  CHEM_ACT_CHEMO_MARKER0_X,
  CHEM_ACT_CHEMO_MARKER0_Y,
  CHEM_ACT_THERMO,
  CHEM_ACT_MAG_X,
  CHEM_ACT_MAG_Y,
  CHEM_GLU,
  CHEM_CO2,
  CHEM_WASTE,
  CHEM_MARKER0,
} from "./sim/chem-ids";

// INGEST material slots are the 6 legacy sensor bins, order
// [minerals, biopolymer, fa, o2, co2, glu]; bulk organic / generic
// debris (the staple heterotroph food) rides slot 1.
const ING_BIOPOLYMER = 1;
const ING_O2 = 3;
const ING_GLU = 5;

// Universal heterotroph build kit (see viableGenome): membrane,
// mRNA, fatty acid, digestive enzyme, amino-acid synthesis.
const HET_SYNTH: Instr[] = [
  ["SYNTH", "BIO", 0],
  ["SYNTH", "MRNA", 0],
  ["SYNTH", "FA", 0],
  ["SYNTH", "ENZ", 0],
  ["SYNTH", "AA", 0],
];

// Pure-photoautotroph build kit: chlorophyll is the mandatory
// photosynth multiplier; AA is the pure-autotroph requirement.
const AUTO_SYNTH: Instr[] = [
  ["SYNTH", "CHL", 0],
  ["SYNTH", "BIO", 0],
  ["SYNTH", "MRNA", 0],
  ["SYNTH", "FA", 0],
  ["SYNTH", "AA", 0],
];

// Fission gated on the structural reserve clearing a threshold --
// the same shape makeRandomViableGenome uses, so a founder doesn't
// balloon-then-bust. `lbl` must be unique within the genome.
function reproduceWhenGrown(thresh: number, lbl: string): Instr[] {
  return [
    ["SELF_MEMBRANE"],
    ["PUSH8", thresh],
    ["GT"],
    ["JZ", lbl],
    ["REPRODUCE"],
    ["LABEL", lbl],
  ];
}

// Climb a chemoreceptor's activated x/y gradient. THRUST pops ay then
// ax, so push x then y; a constant gain amplifies the unit-ish signal.
function climbGradient(xChem: number, yChem: number, gain: number): Instr[] {
  return [
    ["SENSE_CHEMICAL", xChem],
    ["PUSH8", gain],
    ["MUL"],
    ["SENSE_CHEMICAL", yChem],
    ["PUSH8", gain],
    ["MUL"],
    ["THRUST"],
  ];
}

export interface Archetype {
  id: string;
  label: string; // short, for the spawn button
  desc: string; // tooltip
  cls: "direct" | "seed";
  genome: Uint8Array;
}

function build(): Archetype[] {
  const list: Array<Omit<Archetype, "genome"> & { prog: Instr[] }> = [
    {
      id: "photoautotroph",
      label: "photoautotroph",
      cls: "direct",
      desc: "Sessile primary producer: chlorophyll + visible-band photosynthesis, no INGEST/THRUST. Divides when its structural reserve is high.",
      prog: [
        ...AUTO_SYNTH,
        ["SYNTH", "PHOTO", 0], // band 0 = visible
        ...reproduceWhenGrown(40, "np"),
      ],
    },
    {
      id: "phototaxis",
      label: "phototaxis",
      cls: "direct",
      desc: "Photoautotroph that swims along the magnetic axis when light is scarce (emergent depth-keeping / vertical migration).",
      prog: [
        ...AUTO_SYNTH,
        ["SYNTH", "PHOTO", 0],
        ["SYNTH", "MAGNETO", 0],
        ["SENSE_CHEMICAL", CHEM_ACT_PHOTO_VISIBLE],
        ["PUSH8", 6],
        ["LT"], // light < 6 ?
        ["JZ", "lit"],
        ...climbGradient(CHEM_ACT_MAG_X, CHEM_ACT_MAG_Y, 30),
        ["LABEL", "lit"],
        ...reproduceWhenGrown(40, "np"),
      ],
    },
    {
      id: "thermophile",
      label: "thermophile",
      cls: "direct",
      desc: "Photoautotroph with a thermoreceptor; thrust scales with the sensed thermal signal so lineages self-sort into thermal layers.",
      prog: [
        ...AUTO_SYNTH,
        ["SYNTH", "THERMO", 0],
        ["SENSE_CHEMICAL", CHEM_ACT_THERMO],
        ["SENSE_CHEMICAL", CHEM_ACT_THERMO],
        ["THRUST"],
        ...reproduceWhenGrown(40, "np"),
      ],
    },
    {
      id: "forager",
      label: "chemo forager",
      cls: "direct",
      desc: "Honest baseline heterotroph: chemoreceptor for bulk organic, climbs the food gradient, ingests, digests, divides on reserve.",
      prog: [
        ...HET_SYNTH,
        ["SYNTH", "CHEMO", 0], // target 0 = biopolymer / bulk organic
        ["INGEST", ING_BIOPOLYMER],
        ...climbGradient(
          CHEM_ACT_CHEMO_BIOPOLYMER_X,
          CHEM_ACT_CHEMO_BIOPOLYMER_Y,
          30,
        ),
        ...reproduceWhenGrown(30, "np"),
      ],
    },
    {
      id: "predator",
      label: "size-bully",
      cls: "direct",
      desc: "Roaming predator: homes on cell markers, ingests bulk organic to bulk up past the predation size gate, and PREDATEs on contact.",
      prog: [
        ...HET_SYNTH,
        ["SYNTH", "CHEMO", 3], // target 3 = marker0 (other cells)
        ["INGEST", ING_BIOPOLYMER],
        ...climbGradient(
          CHEM_ACT_CHEMO_MARKER0_X,
          CHEM_ACT_CHEMO_MARKER0_Y,
          40,
        ),
        ["PREDATE"],
        ...reproduceWhenGrown(36, "np"),
      ],
    },
    {
      id: "armored",
      label: "armored tank",
      cls: "direct",
      desc: "Indigestible prey strategy: pours synthesis into membrane (breach cost scales with membrane), grazes slowly, divides only when very large.",
      prog: [
        ...HET_SYNTH,
        ["SYNTH", "BIO", 0],
        ["SYNTH", "BIO", 0],
        ["SYNTH", "BIO", 0],
        ["SYNTH", "BIO", 0],
        ["SYNTH", "CHEMO", 0],
        ["INGEST", ING_BIOPOLYMER],
        ...climbGradient(
          CHEM_ACT_CHEMO_BIOPOLYMER_X,
          CHEM_ACT_CHEMO_BIOPOLYMER_Y,
          12,
        ),
        ...reproduceWhenGrown(80, "np"),
      ],
    },
    {
      id: "colony",
      label: "greenbeard colony",
      cls: "seed",
      desc: "Seed: forager that also SYNTHs a BOND marker so clones adhere (greenbeard). Colony advantage emerges only over generations.",
      prog: [
        ...HET_SYNTH,
        ["SYNTH", "BOND", 7], // marker tag 7, inherited by the clone
        ["SYNTH", "CHEMO", 0],
        ["INGEST", ING_BIOPOLYMER],
        ...climbGradient(
          CHEM_ACT_CHEMO_BIOPOLYMER_X,
          CHEM_ACT_CHEMO_BIOPOLYMER_Y,
          30,
        ),
        ...reproduceWhenGrown(30, "np"),
      ],
    },
    {
      id: "chloroplast",
      label: "chloroplast",
      cls: "seed",
      desc: "Seed: a small photoautotroph that leaks glucose every tick. Engulfed, it can become a farmable mutualist organelle.",
      prog: [
        ...AUTO_SYNTH,
        ["SYNTH", "PHOTO", 0],
        ["PUSH8", 8],
        ["EXCRETE", CHEM_GLU], // bleed fixed carbon into the shared pool
        ...reproduceWhenGrown(36, "np"),
      ],
    },
    {
      id: "farmer",
      label: "farmer host",
      cls: "seed",
      desc: "Seed: heterotroph that ENGULFs neighbours and relies on internal division of its captives. Farming emerges from the shared cytoplasm.",
      prog: [
        ...HET_SYNTH,
        ["SYNTH", "CHEMO", 3],
        ["INGEST", ING_BIOPOLYMER],
        ...climbGradient(
          CHEM_ACT_CHEMO_MARKER0_X,
          CHEM_ACT_CHEMO_MARKER0_Y,
          35,
        ),
        ["ENGULF"],
        ...reproduceWhenGrown(40, "np"),
      ],
    },
    {
      id: "endoparasite",
      label: "endoparasite",
      cls: "seed",
      desc: "Seed: minimal soma, leaks a marker0 lure, low membrane (cheap to engulf), reproduces hard. Wants to be eaten, then blooms inside the host.",
      prog: [
        ["SYNTH", "BIO", 0],
        ["SYNTH", "MRNA", 0],
        ["SYNTH", "FA", 0],
        ["SYNTH", "ENZ", 0],
        ["SYNTH", "AA", 0],
        ["INGEST", ING_BIOPOLYMER],
        ["THRUST"],
        ["PUSH8", 6],
        ["EXCRETE", CHEM_MARKER0], // bait
        ["SELF_ENERGY"],
        ["PUSH8", 2],
        ["GT"],
        ["JZ", "np"],
        ["REPRODUCE"], // near-unconditional internal bloom
        ["LABEL", "np"],
      ],
    },
    {
      id: "mitochondria",
      label: "mitochondria",
      cls: "seed",
      desc: "Seed: respiratory endosymbiont. Minimal soma, low membrane (cheap to engulf), leaks a marker0 lure; ingests glucose + O2 and returns CO2. No digester -- specialised on aerobic respiration, not biopolymer. Honest framing: its product (ATP) does NOT cross the host membrane; any host benefit is emergent gas/substrate cycling via the shared pool, never a scripted ATP hand-off.",
      prog: [
        ["SYNTH", "BIO", 0], // single -> low membrane, cheap to engulf
        ["SYNTH", "MRNA", 0],
        ["SYNTH", "FA", 0],
        ["SYNTH", "AA", 0],
        ["INGEST", ING_GLU], // respiratory fuel
        ["INGEST", ING_O2], // electron acceptor
        ["THRUST"], // drift to substrate before engulfment
        ["PUSH8", 8],
        ["EXCRETE", CHEM_CO2], // respiration product back to shared pool
        ["PUSH8", 5],
        ["EXCRETE", CHEM_MARKER0], // engulf bait
        ...reproduceWhenGrown(18, "np"), // fission inside host is uncapped
      ],
    },
    {
      id: "stress-amp",
      label: "stress amplifier",
      cls: "direct",
      desc: "Heritable size plasticity: SPLICE_DUP the genome when ATP is low (amplify), SPLICE_DEL when fat (streamline).",
      prog: [
        ...HET_SYNTH,
        ["SYNTH", "CHEMO", 0],
        ["INGEST", ING_BIOPOLYMER],
        ...climbGradient(
          CHEM_ACT_CHEMO_BIOPOLYMER_X,
          CHEM_ACT_CHEMO_BIOPOLYMER_Y,
          30,
        ),
        ["SELF_ENERGY"],
        ["PUSH8", 10],
        ["LT"], // ATP < 10 -> starving
        ["JZ", "notLow"],
        ["PUSH8", 0], // splice offset
        ["PUSH8", 8], // splice length
        ["SPLICE_DUP"],
        ["LABEL", "notLow"],
        ["SELF_ENERGY"],
        ["PUSH8", 60],
        ["GT"], // ATP > 60 -> fat
        ["JZ", "notFat"],
        ["PUSH8", 0],
        ["PUSH8", 8],
        ["SPLICE_DEL"],
        ["LABEL", "notFat"],
        ...reproduceWhenGrown(34, "np"),
      ],
    },
    {
      id: "bet-hedger",
      label: "bet-hedger",
      cls: "direct",
      desc: "Non-genetic switching: a register oscillator drives POKE_BYTE to rewrite a byte of its own genome, toggling phenotype across ticks.",
      prog: [
        ...HET_SYNTH,
        ["SYNTH", "CHEMO", 0],
        ["INGEST", ING_BIOPOLYMER],
        ...climbGradient(
          CHEM_ACT_CHEMO_BIOPOLYMER_X,
          CHEM_ACT_CHEMO_BIOPOLYMER_Y,
          30,
        ),
        ["LOAD", 0],
        ["PUSH8", 1],
        ["ADD"],
        ["STORE", 0], // reg0++ : a free-running tick counter
        ["LOAD", 0],
        ["PUSH8", 16],
        ["MOD"], // value byte to write (0..15), oscillates
        ["PUSH8", 2], // genome byte index to poke
        ["POKE_BYTE"], // pops (idx, val)
        ...reproduceWhenGrown(34, "np"),
      ],
    },
    {
      id: "allelopath",
      label: "allelopath",
      cls: "direct",
      desc: "Chemical warfare: aggressively excretes waste + CO2 to push local ambient over toxify thresholds and damage neighbours.",
      prog: [
        ...HET_SYNTH,
        ["SYNTH", "CHEMO", 0],
        ["INGEST", ING_BIOPOLYMER],
        ...climbGradient(
          CHEM_ACT_CHEMO_BIOPOLYMER_X,
          CHEM_ACT_CHEMO_BIOPOLYMER_Y,
          30,
        ),
        ["PUSH8", 50],
        ["EXCRETE", CHEM_WASTE],
        ["PUSH8", 50],
        ["EXCRETE", CHEM_CO2],
        ...reproduceWhenGrown(34, "np"),
      ],
    },
    {
      id: "beacon",
      label: "marker beacon",
      cls: "direct",
      desc: "Emits a marker0 plume every tick: substrate for emergent aggregation, trail-following, luring and quorum-like behavior in other lineages.",
      prog: [
        ...HET_SYNTH,
        ["SYNTH", "CHEMO", 0],
        ["INGEST", ING_BIOPOLYMER],
        ...climbGradient(
          CHEM_ACT_CHEMO_BIOPOLYMER_X,
          CHEM_ACT_CHEMO_BIOPOLYMER_Y,
          30,
        ),
        ["PUSH8", 30],
        ["EXCRETE", CHEM_MARKER0],
        ...reproduceWhenGrown(34, "np"),
      ],
    },
    {
      id: "virus",
      label: "true virus",
      cls: "seed",
      desc: "Seed: minimal soma that SYNTHs PACKAGE, shedding fragments of its own genome as decaying eDNA carriers. Spread needs competent victims + a long run.",
      prog: [
        ["SYNTH", "BIO", 0],
        ["SYNTH", "MRNA", 0],
        ["SYNTH", "FA", 0],
        ["SYNTH", "ENZ", 0],
        ["SYNTH", "AA", 0],
        ["SYNTH", "PACKAGE", 0], // shed self-genome carriers
        ["INGEST", ING_BIOPOLYMER],
        ["THRUST"],
        ...reproduceWhenGrown(28, "np"),
      ],
    },
  ];
  return list.map(({ id, label, desc, cls, prog }) => {
    const genome = asm(prog);
    assertWellFormed(genome);
    return { id, label, desc, cls, genome };
  });
}

export const ARCHETYPES: ReadonlyArray<Archetype> = build();
