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
  CHEM_ACT_THERMO,
  CHEM_ACT_MAG_X,
  CHEM_ACT_MAG_Y,
  CHEM_GLU,
  CHEM_CO2,
  CHEM_WASTE,
  CHEM_MARKER0,
} from "./sim/chem-ids";
import { TRANSPORT_ATP_SLOT } from "./sim/reactions";

// INGEST material slots are the 6 legacy sensor bins, order
// [minerals, biopolymer, fa, o2, co2, glu]; bulk organic / generic
// debris (the staple heterotroph food) rides slot 1.
const ING_BIOPOLYMER = 1;
const ING_O2 = 3;

// Inert trailing cassette. stress-amp's SPLICE_DUP/DEL must target a
// non-essential region (offset 0 corrupts the SYNTH kit and shifts
// all downstream op alignment every tick). Appended after the
// reproduce gate so duplications/deletions only ever touch NOPs and
// the functional head keeps fixed addresses.
const NOP_CASSETTE: Instr[] = Array.from(
  { length: 32 },
  () => ["NOP"] as Instr,
);

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
  // Composite archetype: when set, `genome` is the HOST and this is a
  // symbiont that spawns already engulfed inside the host's contents
  // (the engine engulf invariant). The host is given a size/energy
  // head start so the pre-formed unit is viable for a while.
  symbiont?: Uint8Array;
  // Retained in the catalogue (scenarios/tests/founder genome) but
  // not rendered as a user spawn button -- see #6 armored: kept for
  // reproducibility, disabled from creation per SCENARIO_RESULTS.md.
  uiHidden?: boolean;
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
        // Threshold sized to the engine's realized act_photo_visible
        // range: measured <=~3.4 even at the surface in full midday,
        // so the old 6 was unreachable -> the "lit, stop migrating"
        // branch never fired and the cell thrust upward forever. 2
        // sits between the deep-dark (~0.1-0.8) and lit-surface (~3)
        // values, making it bistable: deep -> migrate up, lit -> stop.
        ["PUSH8", 2],
        ["LT"], // act_photo < 2  ->  dark, migrate
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
      desc: "Roaming predator: climbs the bulk-organic gradient into food/prey-dense regions (prey don't emit a marker to home on), ingests to bulk up past the predation size gate, and PREDATEs on contact.",
      prog: [
        ...HET_SYNTH,
        ["SYNTH", "CHEMO", 0], // target 0 = biopolymer / bulk organic
        ["INGEST", ING_BIOPOLYMER],
        ...climbGradient(
          CHEM_ACT_CHEMO_BIOPOLYMER_X,
          CHEM_ACT_CHEMO_BIOPOLYMER_Y,
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
      desc: "Indigestible prey strategy: pours synthesis into membrane (breach cost scales with membrane), grazes slowly, divides only when very large. RETAINED BUT UI-DISABLED: controlled 2x2 (SCENARIO_RESULTS.md) showed the apparent predation-resistance edge is the high reproduce gate (deferred division -> size refuge past the 1.14x breach gate), NOT the membrane investment -- armor is not a separately selectable axis. Kept for scenarios/tests; not user-spawnable.",
      uiHidden: true,
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
      desc: "Seed: a small photoautotroph that leaks SURPLUS glucose (only once its structural reserve clears a floor, so it doesn't bleed carbon to death free-living). Engulfed, it can become a farmable mutualist organelle.",
      prog: [
        ...AUTO_SYNTH,
        ["SYNTH", "PHOTO", 0],
        // Only shed glucose when structurally healthy -- an
        // unconditional leak self-starves a slow autotroph.
        ["SELF_MEMBRANE"],
        ["PUSH8", 10],
        ["GT"],
        ["JZ", "noLeak"],
        ["PUSH8", 6],
        ["EXCRETE", CHEM_GLU], // bleed surplus fixed carbon to the pool
        ["LABEL", "noLeak"],
        // High internal-division gate: an engulfed chloroplast that
        // divides too eagerly blooms inside the host (glucose flood,
        // host population thrash). Raised to the mito-validated band
        // so the plastid stays tandem-proportional to its host.
        ...reproduceWhenGrown(45, "np"),
      ],
    },
    {
      id: "farmer",
      label: "farmer host",
      cls: "seed",
      desc: "Seed: heterotroph that climbs into organic/prey-dense regions and engulfs RARELY (a persistent register counter gates ENGULF to ~1/127 VM passes). SELF_ENERGY gating was ineffective -- realized ATP (~165-250) is far above any sane threshold, so engulf fired unconditionally and the lineage cannibalised itself to collapse (farmer-solo 30->9 vs near-identical engulf-less forager 30->110). A rarity gate caps the kin-cannibalism rate below the reproduction rate so the host self-sustains, while engulf/farming still occurs (tandem). Relies on internal division of its captives; farming emerges from the shared cytoplasm.",
      prog: [
        ...HET_SYNTH,
        ["SYNTH", "CHEMO", 0],
        ["INGEST", ING_BIOPOLYMER],
        ...climbGradient(
          CHEM_ACT_CHEMO_BIOPOLYMER_X,
          CHEM_ACT_CHEMO_BIOPOLYMER_Y,
          35,
        ),
        // Rarity-gated ENGULF (register oscillator, bet-hedger
        // pattern). reg0 persists across ticks; engulf only when
        // reg0 % 127 == 0 -> ~1/127 of passes, regardless of ATP. This
        // caps the kin-cannibalism rate (every engulf converts a free
        // reproducing farmer into a captive + burdens the host) below
        // the reproduction rate so the lineage doesn't sink itself,
        // while engulf still happens often enough for the farming /
        // endosymbiosis behaviour. Genome-only -- no engine rule.
        ["LOAD", 0],
        ["PUSH8", 1],
        ["ADD"],
        ["STORE", 0], // reg0++ (free-running counter)
        ["LOAD", 0],
        ["PUSH8", 127],
        ["MOD"], // reg0 % 127
        ["JNZ", "noEngulf"], // != 0 -> skip; engulf only ~1/127 passes
        ["ENGULF"],
        ["LABEL", "noEngulf"],
        // 40 -> 28: forager (near-identical genome) only self-sustains
        // at ~30, and farmer carries extra ENGULF cost + draining
        // captives, so it must divide a bit EARLIER, not later --
        // dividing is also what partitions engulfed symbionts to the
        // daughter (the tandem-reproduction mechanism).
        ...reproduceWhenGrown(28, "np"),
      ],
    },
    {
      id: "endoparasite",
      label: "endoparasite",
      cls: "seed",
      desc: "Seed: minimal soma, leaks a marker0 lure, low membrane (cheap to engulf). Wants to be eaten, then blooms inside the host (engulfed internal division is uncapped). Reproduces aggressively but gated on a low membrane floor so it doesn't self-lyse before a host takes it up.",
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
        // Low membrane floor: still blooms hard, but won't divide
        // itself below the viable structural reserve in open water.
        ...reproduceWhenGrown(10, "np"),
      ],
    },
    {
      id: "mitochondria",
      label: "mitochondria",
      cls: "seed",
      desc: "Seed: true ATP-exporting endosymbiont (faithful mitochondrion). ATP is now a first-class chemical (CHEM_ATP), so this is the real mechanism, not a workaround. Minimal soma, low membrane (cheap to engulf), marker0 engulf-lure, ENZ+biopolymer bootstrap so it survives free-living long enough to be engulfed. Once inside a host it digests host-pool biopolymer -> glu, ingests O2, RESPIRES internally (out[0]: glu+O2 -> CO2 + ATP raising its own CHEM_ATP), and exports that ATP to the host via a SYNTH'd ATP TRANSLOCASE (ANT analog: SYNTH CAT param=TRANSPORT_ATP_SLOT -- a normal CHEM_ATP transporter, vacuolar-membrane only, facilitated/down-gradient). So ATP flows organelle->host ONLY while the mito is respiration-richer than the host -- emergent, mass-exact, never a scripted hand-off. Returns CO2 to the shared pool; slow internal division (gate 45) keeps it ~proportional to host fission (tandem).",
      prog: [
        ["SYNTH", "BIO", 0], // single -> low membrane, cheap to engulf
        ["SYNTH", "MRNA", 0],
        ["SYNTH", "FA", 0],
        ["SYNTH", "ENZ", 0], // digests host-pool biopolymer -> glu
        ["SYNTH", "AA", 0],
        ["SYNTH", "CAT", TRANSPORT_ATP_SLOT], // build the ATP translocase (ANT)
        ["INGEST", ING_BIOPOLYMER], // substrate from the host pool
        ["INGEST", ING_O2], // electron acceptor (respiration)
        ["THRUST"], // drift to a host during the free-living phase
        ["PUSH8", 8],
        ["EXCRETE", CHEM_CO2], // respiration waste back to shared pool
        ["PUSH8", 5],
        ["EXCRETE", CHEM_MARKER0], // engulf bait
        // 18 -> 45: slow division. One lever fixes two failures --
        // curbs internal overgrowth (stays ~proportional to host =
        // tandem, not bloat-and-kill) AND curbs free-living bloom so
        // "engulfed" is the stable niche, not independence.
        ...reproduceWhenGrown(45, "np"),
      ],
    },
    {
      id: "stress-amp",
      label: "stress amplifier",
      cls: "direct",
      desc: "Heritable size plasticity: SPLICE_DUP an inert trailing cassette when ATP is low (amplify), SPLICE_DEL it when fat (streamline). Splices only ever touch the appended NOP cassette, never the functional head.",
      prog: [
        ...HET_SYNTH,
        ["SYNTH", "CHEMO", 0],
        ["INGEST", ING_BIOPOLYMER],
        ...climbGradient(
          CHEM_ACT_CHEMO_BIOPOLYMER_X,
          CHEM_ACT_CHEMO_BIOPOLYMER_Y,
          30,
        ),
        // Splice offset = CASSETTE_OFF, the start of the trailing NOP
        // cassette (must stay >= the end of the reproduce gate; tracks
        // genome layout -- recompute if the head changes).
        ["SELF_ENERGY"],
        ["PUSH8", 10],
        ["LT"], // ATP < 10 -> starving
        ["JZ", "notLow"],
        ["PUSH8", 60], // splice offset -> into the NOP cassette
        ["PUSH8", 6], // splice length
        ["SPLICE_DUP"],
        ["LABEL", "notLow"],
        ["SELF_ENERGY"],
        ["PUSH8", 60],
        ["GT"], // ATP > 60 -> fat
        ["JZ", "notFat"],
        ["PUSH8", 60],
        ["PUSH8", 6],
        ["SPLICE_DEL"],
        ["LABEL", "notFat"],
        ...reproduceWhenGrown(34, "np"),
        ...NOP_CASSETTE,
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
    {
      // #16 of GENOME_ARCHETYPES.md. No hard-coded "go to the
      // floor": biopolymer is denser than water and sinks, so a
      // detritus-tropic grazer EMERGENTLY settles to the sea floor
      // by climbing the sinking-detritus gradient. EXCRETE CO2 dumps
      // the cell's metabolic CO2 as particles -- the niche-defining
      // emission that (by design intent) seeds a benthic chemocline
      // for a future cross-feeder. A door, not a script.
      id: "benthic-detritivore",
      label: "benthic grazer",
      cls: "direct",
      desc: "Sea-floor decomposer: chemotaxes the settled bulk-organic (marine-snow detritus that sinks and pools on the floor), ingests it, runs heterotroph synthesis, and excretes metabolic CO2 back into the medium. Benthic position is emergent (follows sinking food), not scripted.",
      prog: [
        ...HET_SYNTH,
        ["SYNTH", "CHEMO", 0], // target 0 = biopolymer / bulk organic
        ["INGEST", ING_BIOPOLYMER],
        ...climbGradient(
          CHEM_ACT_CHEMO_BIOPOLYMER_X,
          CHEM_ACT_CHEMO_BIOPOLYMER_Y,
          12,
        ),
        ["SENSE_CHEMICAL", CHEM_CO2], // own CO2 pool -> excretion amount
        ["EXCRETE", CHEM_CO2],
        ...reproduceWhenGrown(30, "np"),
      ],
    },
  ];
  const built: Archetype[] = list.map(
    ({ id, label, desc, cls, prog, uiHidden }) => {
      const genome = asm(prog);
      assertWellFormed(genome);
      return { id, label, desc, cls, genome, ...(uiHidden ? { uiHidden } : {}) };
    },
  );
  // Composite: a farmer host that already carries a mitochondrion
  // endosymbiont (spawned engulfed via the engine engulf invariant;
  // host given a size/energy head start so the pre-formed unit is
  // viable for a while). Reuses the validated farmer + mitochondria
  // genomes verbatim.
  const farmer = built.find((a) => a.id === "farmer")!;
  const mito = built.find((a) => a.id === "mitochondria")!;
  const chloro = built.find((a) => a.id === "chloroplast")!;
  built.push({
    id: "farmer-mito",
    label: "farmer+mito",
    cls: "seed",
    desc: "Seed: a farmer HOST spawned with a mitochondrion already engulfed in its contents (a pre-formed endosymbiotic unit). The host gets a membrane/energy head start so the relative sizes keep it viable for a time; the mito respires internally and exports ATP via its translocase. Watch whether the pairing persists + reproduces in tandem (host fission partitions the symbiont to daughters).",
    genome: farmer.genome,
    symbiont: mito.genome,
  });
  built.push({
    id: "farmer-chloroplast",
    label: "farmer+chloro",
    cls: "seed",
    desc: "Seed: a farmer HOST spawned with a chloroplast already engulfed (pre-formed plastid endosymbiosis -- the secondary-endosymbiosis analog). The engulfed chloroplast photosynthesises using the HOST's depth-light and leaks surplus glucose into the shared cytoplasm, so the heterotroph host gains fixed carbon -- but ONLY while the host stays at a lit depth (a roaming/deep host gets nothing). Host gets a membrane/energy head start (relative sizes viable for a time). Glucose is a native transferable chem -- no ATP-translocase needed (unlike mito).",
    genome: farmer.genome,
    symbiont: chloro.genome,
  });
  return built;
}

export const ARCHETYPES: ReadonlyArray<Archetype> = build();
