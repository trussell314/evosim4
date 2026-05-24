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
  CHEM_ACT_THERMO,
  CHEM_ACT_MAG_X,
  CHEM_ACT_MAG_Y,
  CHEM_ACT_MECH_X,
  CHEM_ACT_MECH_Y,
  CHEM_ACT_PH,
  CHEM_ACT_ELECTRO_X,
  CHEM_ACT_ELECTRO_Y,
  CHEM_ACT_LIGHT_X,
  CHEM_ACT_LIGHT_Y,
  CHEM_ACT_VIB_X,
  CHEM_ACT_VIB_Y,
  CHEM_BIOPOLYMER,
  CHEM_GLU,
  CHEM_CO2,
  CHEM_WASTE,
  CHEM_MRNA,
  CHEM_MARKER0,
} from "./sim/chem-ids";
import {
  TRANSPORT_ATP_SLOT,
  TRANSPORT_GLU_SLOT,
  RX_SLOT_RESPIRATION,
  RX_SLOT_PHOTOSYNTH,
  RX_SLOT_SYNTH_AA,
  RX_SLOT_SYNTH_ENZ,
  RX_SLOT_SYNTH_MEM_AAFA,
  RX_SLOT_DIGEST_BIOP,
  RX_SLOT_SYNTH_MEM_FA,
  RX_SLOT_SYNTH_PHOTO_V,
  RX_SLOT_SYNTH_ELECTRO,
  RX_SLOT_SYNTH_VIBRO,
  RX_SLOT_SYNTH_PHRECEPTOR,
  RX_SLOT_SYNTH_MECH,
  RX_SLOT_SYNTH_THERMO,
  RX_SLOT_SYNTH_MAGNETO,
  RX_SLOT_SYNTH_BOND,
  RX_SLOT_SYNTH_REPAIR,
} from "./sim/reactions";
import { CHEMOLITH_ENERGY_SLOT, CHEMOLITH_CARBON_SLOT } from "./sim/chemolith";

// INGEST now pops a bond-energy threshold off the stack (engulf any
// contacted particle with CHEM_BOND_POTENTIAL >= threshold *
// INGEST_TH_SCALE). These are the PUSH8 bytes a prog pushes before
// INGEST. ING_DETRITUS=1 -> ~0.02: eats biopolymer/glu/fa/aa/waste
// and energy-bearing generics, but excludes zero-bond inorganics
// (MIN/O2/CO2) -- the staple heterotroph/detritivore diet.
// (ING_ANY=0 -> threshold 0: would engulf anything including zero-bond
// chems; previously used by the mito archetype but retired when mito
// dropped INGEST entirely in favor of the glucose translocase pathway.)
const ING_DETRITUS = 1;

// Inert trailing cassette. stress-amp's SPLICE_DUP/DEL must target a
// non-essential region (offset 0 corrupts the SYNTH kit and shifts
// all downstream op alignment every tick). Appended after the
// reproduce gate so duplications/deletions only ever touch NOPs and
// the functional head keeps fixed addresses.
const NOP_CASSETTE: Instr[] = Array.from(
  { length: 32 },
  () => ["NOP"] as Instr,
);

// Heterotroph identity: BOOST biopolymer digestion + the enzyme that
// gates it. After Phase 4a every cell metabolizes at baseline via the
// reactions' uncatRate floor, so a "heterotroph" is no longer declared
// by SYNTH BIO/AA/FA/ENZ/MRNA (those bits set on synthMask are read by
// nothing). The functional way to say "this cell is a digester" is to
// pour catalyst into the digestion + enzyme-synth slots so it digests
// detritus faster than its neighbours. KEEP THIS KIT MINIMAL: every
// SYNTH CAT op spends aa+min+ATP per tick on its own slot's catalyst
// protein, so a 5-slot kit drained newborns dry before they could
// grow. 2 slots is enough to differentiate.
const HET_KIT: Instr[] = [
  ["SYNTH", "CAT", RX_SLOT_SYNTH_ENZ],     // build digestive enzyme faster
  ["SYNTH", "CAT", RX_SLOT_DIGEST_BIOP],   // digest biopolymer faster
];

// Photoautotroph identity: BOOST photosynthesis + the synth_aa
// bottleneck (the historical autotroph rate-limit, see commit
// 84b6f4f's vmax tune note). Same minimalism principle as HET_KIT --
// every additional catalyst slot is per-tick aa+min+ATP drain. The
// photosynth boost gets the cell's carbon-fixation moving above
// baseline; the synth_aa boost converts that glucose into amino acid
// faster than the constitutive rate. Everything else (chl, fa,
// membrane, mrna) runs at baseline -- which is enough because every
// cell already does that work.
const AUTO_KIT: Instr[] = [
  ["SYNTH", "CAT", RX_SLOT_PHOTOSYNTH],
  ["SYNTH", "CAT", RX_SLOT_SYNTH_AA],
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

// Climb the spatial gradient of a chem's PARTICLE field directly,
// no SYNTH'd receptor required. SENSE_OUT pushes [gx, gy]; scale
// both by gain then THRUST. The post-Phase-5 detritus/food-tropism
// helper -- replaces climbGradient + the chemoreceptor + activation
// pass machinery for chem particles.
function climbParticleGradient(chemId: number, gain: number): Instr[] {
  return [
    ["SENSE_OUT", chemId],   // stack: [gx, gy]
    ["PUSH8", gain], ["MUL"], // [gx, gy*gain]
    ["SWAP"],                 // [gy*gain, gx]
    ["PUSH8", gain], ["MUL"], // [gy*gain, gx*gain]
    ["SWAP"],                 // [gx*gain, gy*gain]
    ["THRUST"],
  ];
}

// Flee a chem's PARTICLE-field gradient -- thrust DOWN-gradient (away
// from the source). Mirror of climbParticleGradient with both components
// negated before THRUST. Used for avoidance/escape behaviours.
function fleeParticleGradient(chemId: number, gain: number): Instr[] {
  return [
    ["SENSE_OUT", chemId],          // [gx, gy]
    ["PUSH8", gain], ["MUL"], ["NEG"], // [gx, -gy*gain]
    ["SWAP"],                        // [-gy*gain, gx]
    ["PUSH8", gain], ["MUL"], ["NEG"], // [-gy*gain, -gx*gain]
    ["SWAP"],                        // [-gx*gain, -gy*gain]
    ["THRUST"],
  ];
}

// Frame a hand-authored archetype program as a single explicit gene
// (GENE..END) with small intron margins. Founders get the full
// multi-gene intron-gene-intron layout (makeRandomViableGenome);
// archetype SEEDS are framed as one gene each. This is behaviour-
// preserving -- the whole prog still runs as before, the VM just
// clears the stack once per cycle at the GENE codon -- and explicit
// (no implicit "un-framed genome = one gene" fallback lives in the
// VM). Evolved descendants diversify into multiple genes via mutation.
// Adding the leading bytes shifts every address equally, so asm's
// relative jump offsets are unchanged and stay in i8 range.
const INTRON_MARGIN: Instr[] = [["NOP"], ["NOP"]];
export function frameProg(prog: Instr[]): Instr[] {
  return [...INTRON_MARGIN, ["GENE"], ...prog, ["END"], ...INTRON_MARGIN];
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
      desc: "Sessile primary producer: pours catalyst into photosynthesis + chlorophyll synthesis + amino-acid + fatty-acid + membrane synthesis. No INGEST/THRUST. Divides when its structural reserve is high.",
      prog: [
        ...AUTO_KIT,
        ...reproduceWhenGrown(40, "np"),
      ],
    },
    {
      id: "phototaxis",
      label: "phototaxis",
      cls: "direct",
      desc: "Photoautotroph that swims along the magnetic axis when light is scarce (emergent depth-keeping / vertical migration). Adds a magnetoreceptor-synth catalyst boost so its compass builds faster than baseline.",
      prog: [
        ...AUTO_KIT,
        ["SYNTH", "CAT", RX_SLOT_SYNTH_PHOTO_V], // boost visible photoreceptor (signal for the dark-check)
        ["SYNTH", "CAT", RX_SLOT_SYNTH_MAGNETO], // boost magnetoreceptor (the compass)
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
      desc: "Photoautotroph with a thermoreceptor-synth catalyst boost; thrust = act_thermo^3 so the cell drives hard when it's far from the isotherm (overcomes gravity) and barely thrusts when it's close (saves ATP). Also synthesizes the heat-shock/repair chaperone (CHEM_REPAIR) so it tolerates the hot vent zone -- the same pool raises its thermal-denaturation ceiling, making it a genuine heat specialist rather than just heat-seeking.",
      prog: [
        ...AUTO_KIT,
        ["SYNTH", "CAT", RX_SLOT_SYNTH_THERMO], // boost thermoreceptor synth
        ["SYNTH", "CAT", RX_SLOT_SYNTH_REPAIR], // heat-shock chaperone -> thermal tolerance
        // Sign-preserving cube of act_thermo. Linear thrust=(a,a) with
        // |a|<=3 maxed at mag ~ 4.5 which is tiny vs gravity=60, so
        // cells sank into the dark before reaching the isotherm. Cube
        // gives ~|a|^3 magnitude: |a|=3 -> 27, enough to climb;
        // |a|<0.3 -> <0.03, effectively a deadband near the target.
        ["SENSE_CHEMICAL", CHEM_ACT_THERMO],
        ["DUP"],
        ["DUP"],
        ["MUL"], // a^2
        ["MUL"], // a^3 (sign preserved by the linear factor)
        ["DUP"], // THRUST consumes 2 stack values (x, y); same value both axes
        ["THRUST"],
        ...reproduceWhenGrown(40, "np"),
      ],
    },
    {
      id: "forager",
      label: "chemo forager",
      cls: "direct",
      desc: "Honest baseline heterotroph: catalyses biopolymer digestion + enzyme synthesis + membrane synth above baseline, climbs the food-particle gradient, ingests, divides on reserve.",
      prog: [
        ...HET_KIT,
        ["PUSH8", ING_DETRITUS], ["INGEST"],
        ...climbParticleGradient(CHEM_BIOPOLYMER, 30),
        ...reproduceWhenGrown(30, "np"),
      ],
    },
    {
      id: "predator",
      label: "size-bully",
      cls: "direct",
      desc: "Roaming predator: climbs the bulk-organic gradient into food/prey-dense regions (prey don't emit a marker to home on), ingests to bulk up past the predation size gate, and PREDATEs on contact.",
      prog: [
        ...HET_KIT,
        ["PUSH8", ING_DETRITUS], ["INGEST"],
        ...climbParticleGradient(CHEM_BIOPOLYMER, 40),
        ["PREDATE"],
        ...reproduceWhenGrown(36, "np"),
      ],
    },
    {
      id: "armored",
      label: "armored tank",
      cls: "direct",
      desc: "Indigestible prey strategy: pours additional catalyst into the two membrane-synth slots so its structural reserve builds faster (breach cost scales with membrane), grazes slowly, divides only when very large. RETAINED BUT UI-DISABLED: controlled 2x2 (SCENARIO_RESULTS.md) showed the apparent predation-resistance edge is the high reproduce gate (deferred division -> size refuge past the 1.14x breach gate), NOT the membrane investment -- armor is not a separately selectable axis. Kept for scenarios/tests; not user-spawnable.",
      uiHidden: true,
      prog: [
        ...HET_KIT,
        // Extra membrane investment: both aa+fa->mem and fa-only->mem
        // slots get an additional catalyst dose on top of HET_KIT's
        // single boost. With 3 SYNTH-CAT ticks per membrane reaction
        // the cell pours real flux into structural reserve.
        ["SYNTH", "CAT", RX_SLOT_SYNTH_MEM_AAFA],
        ["SYNTH", "CAT", RX_SLOT_SYNTH_MEM_AAFA],
        ["SYNTH", "CAT", RX_SLOT_SYNTH_MEM_FA],
        ["PUSH8", ING_DETRITUS], ["INGEST"],
        ...climbParticleGradient(CHEM_BIOPOLYMER, 12),
        ...reproduceWhenGrown(80, "np"),
      ],
    },
    {
      id: "colony",
      label: "greenbeard colony",
      cls: "seed",
      desc: "Seed: forager that also SYNTHs a BOND marker so clones adhere (greenbeard). Colony advantage emerges only over generations.",
      prog: [
        ...HET_KIT,
        ["SYNTH", "BOND", 7], // marker tag 7, inherited by the clone
        ["PUSH8", ING_DETRITUS], ["INGEST"],
        ...climbParticleGradient(CHEM_BIOPOLYMER, 30),
        ...reproduceWhenGrown(30, "np"),
      ],
    },
    {
      id: "differentiated-colony",
      label: "germ/soma colony",
      cls: "seed",
      desc: "Seed: emergent multicellularity with division of labour from ONE genome. Adheres to clonal kin (greenbeard tag) and pours catalyst into the adhesion-molecule slot (aa+fa->CHEM_BOND) so a cluster physically coheres into a body. The germ/soma determinant is mRNA -- the cell's translation capacity (every biosynthesis reaction scales with the mRNA pool), the textbook maternal-effect determinant. At each fission it PARTITIONs mRNA toward the MOTHER, so she keeps the ribosome cache (germ: high biosynthesis, keeps growing + dividing) while each daughter buds off mRNA-POOR (soma: low biosynthesis, can't grow fast, so it forages + adheres for the colony instead of dividing, slowly rebuilding its own mRNA over time). Unlike a glucose dowry -- which the cell burns to zero so the signal vanishes -- mRNA is a maintained catalytic pool, so the germ/soma spread persists across the cluster. The cell reads its own inherited cytoplasm (SENSE_CHEMICAL mrna) and switches phenotype with no engine rule forcing either; PARTITION (asymmetric determinant segregation) is the primitive no other archetype exercises. Payoff is emergent -- spawn many (clump placement) and let it run.",
      prog: [
        // Cohesion: clonal greenbeard tag + boosted CHEM_BOND pool so
        // bonds form readily and hold (slot 22 = aa+fa -> CHEM_BOND).
        ["SYNTH", "CAT", RX_SLOT_SYNTH_BOND],
        ["SYNTH", "BOND", 11], // tag inherited by clones -> kin recognise kin
        // Every cell forages; the soma does the colony's feeding while
        // the germ keeps dividing on its retained ribosome cache.
        ...HET_KIT,
        ["PUSH8", ING_DETRITUS], ["INGEST"],
        ...climbParticleGradient(CHEM_BIOPOLYMER, 25),
        // Asymmetric division: shunt the mRNA (translation-capacity)
        // determinant toward the MOTHER. The default child share is 0.6
        // (parentShare 0.4); a bias of -1 squashes to -0.5, giving the
        // daughter ~0.1 of the mRNA -- low (soma) but NONZERO, so it can
        // still slowly rebuild via synth_ribo and isn't trapped at the
        // mRNA=0 absorbing state. The mother keeps ~0.9 (germ).
        ["PUSH8", -1],
        ["PARTITION", CHEM_MRNA],
        // Role switch on the inherited determinant (own mRNA pool).
        ["SENSE_CHEMICAL", CHEM_MRNA],
        ["PUSH8", 3], // ~0.6*MRNA_REF: germ cells sit well above, fresh soma well below
        ["GT"], // mRNA-rich -> germ; else fall through to soma (forage, no division)
        ["JZ", "soma"],
        // Bloom brake. A germ divides only when it is BOTH large and
        // energy-flush. The larger size gate (50, up from 30) slows the
        // division cadence AND makes each soma daughter big enough (it
        // takes the 0.6 child share -> ~30 membrane) to coast while it
        // rebuilds mRNA back over the germ threshold -- so soma stop
        // being a pure death sink and many recover. The energy gate
        // throttles division as a growing cluster depletes local food,
        // so the colony settles near carrying capacity instead of
        // overshooting and crashing the soma caste.
        ["SELF_ENERGY"],
        ["PUSH8", 40],
        ["GT"],
        ["JZ", "soma"],
        ...reproduceWhenGrown(50, "germ"),
        ["LABEL", "soma"],
      ],
    },
    {
      id: "chloroplast",
      label: "chloroplast",
      cls: "seed",
      desc: "Seed: a small photoautotroph that leaks SURPLUS glucose (only once its structural reserve clears a floor, so it doesn't bleed carbon to death free-living). Engulfed, it can become a farmable mutualist organelle. Sized to be roughly an order of magnitude smaller than its farmer host (mass at maturity ~4 vs host ~30, divides a touch faster than the host so plastids aren't diluted out of daughter hosts) so a host can carry many plastids without being out-massed by its own organelles -- closer to the chloroplast/plant-cell ratio in nature (~1/500 volume, 10-100 per cell) than the prior mature ~45 mass which made one chloro larger than the host itself.",
      prog: [
        ...AUTO_KIT,
        // Only shed glucose when structurally healthy -- an
        // unconditional leak self-starves a slow autotroph. Gate
        // scaled with the smaller mass threshold (was > 10, now > 2).
        ["SELF_MEMBRANE"],
        ["PUSH8", 2],
        ["GT"],
        ["JZ", "noLeak"],
        ["PUSH8", 2],
        ["EXCRETE", CHEM_GLU], // bleed surplus fixed carbon to the pool
        ["LABEL", "noLeak"],
        // Internal-division gate scaled to biology: daughter mass ~2,
        // mature mass ~4 = ~1/7 host volume. Tuned DOWN from 6 to
        // divide a touch faster than the host so engulfed plastids
        // aren't diluted out of daughter hosts (at mMem>6 the host
        // out-divided the chloro and shed it -- chloro-engulfed ended
        // engSym=0 despite a 1363-cell peak). Engulfment stays
        // trivially within the 1.14x radius gate.
        ...reproduceWhenGrown(4, "np"),
      ],
    },
    {
      id: "farmer",
      label: "farmer host",
      cls: "seed",
      desc: "Seed: heterotroph that climbs into organic/prey-dense regions and engulfs RARELY (a persistent register counter gates ENGULF to ~1/127 VM passes). SELF_ENERGY gating was ineffective -- realized ATP (~165-250) is far above any sane threshold, so engulf fired unconditionally and the lineage cannibalised itself to collapse (farmer-solo 30->9 vs near-identical engulf-less forager 30->110). A rarity gate caps the kin-cannibalism rate below the reproduction rate so the host self-sustains, while engulf/farming still occurs (tandem). Relies on internal division of its captives; farming emerges from the shared cytoplasm.",
      prog: [
        ...HET_KIT,
        ["PUSH8", ING_DETRITUS], ["INGEST"],
        ...climbParticleGradient(CHEM_BIOPOLYMER, 35),
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
        ["PUSH8", 25],
        ["MOD"], // reg0 % 25
        ["JNZ", "noEngulf"], // != 0 -> skip; engulf only ~1/25 passes
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
      desc: "Seed: minimal soma, leaks a marker0 lure, low membrane (cheap to engulf). Wants to be eaten, then blooms inside the host (engulfed internal division is uncapped). Reproduces aggressively but gated on a low membrane floor so it doesn't self-lyse before a host takes it up. No catalyst kit -- a parasite that bulks up costs more to engulf, defeating the strategy.",
      prog: [
        ["PUSH8", ING_DETRITUS], ["INGEST"],
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
      desc: "Seed: true ATP-exporting endosymbiont (faithful mitochondrion). Minimal soma (low membrane = cheap to engulf), marker0 engulf-lure, respiration + digestion catalyst boosts, the ATP TRANSLOCASE (SYNTH CAT TRANSPORT_ATP_SLOT) exporting ATP across the vacuolar membrane, and a GLUCOSE TRANSPORTER (SYNTH CAT TRANSPORT_GLU_SLOT) importing glucose from the host pool (real mitos import pyruvate via inner-membrane carriers, not by phagocytosis). With glucose permeability=0, an engulfed mito MUST express the glucose carrier to feed; a free mito has no glucose source (no host, no ambient glu field) and starves -- the obligate-symbiont property modern mitos display (Rickettsia/Wolbachia analog). ATP flows organelle->host whenever the mito is respiration-richer than the host. Sized to be ~1/6 the host's mass (mature mass ~5 vs host ~30; division gate tuned to track host fission rather than out-divide and drain the shared glucose pool).",
      prog: [
        ["SYNTH", "CAT", RX_SLOT_RESPIRATION],     // respire faster than baseline
        ["SYNTH", "CAT", RX_SLOT_DIGEST_BIOP],     // digest host biopolymer faster
        ["SYNTH", "CAT", TRANSPORT_ATP_SLOT],      // ATP translocase (ANT analog)
        ["SYNTH", "CAT", TRANSPORT_GLU_SLOT],      // glucose importer (pyruvate-carrier analog)        ["THRUST"], // drift to a host during the free-living phase
        ["PUSH8", 8],
        ["EXCRETE", CHEM_CO2], // respiration waste back to shared pool
        ["PUSH8", 5],
        ["EXCRETE", CHEM_MARKER0], // engulf bait
        // Scaled to biology: daughter mass ~2.5, mature ~5 = ~1/6
        // host volume. Tuned UP from 3 to slow internal division --
        // at mMem>3 the mito divided to ~16 per host and drained the
        // shared glucose pool faster than the host could refill it,
        // collapsing the symbiosis (mito-engulfed crashed to engSym=0
        // by t=510 despite a 334-cell peak). Still clears the 1.14x
        // engulf gate trivially (host radius ~1.8x the mito's).
        ...reproduceWhenGrown(5, "np"),
      ],
    },
    {
      id: "stress-amp",
      label: "stress amplifier",
      cls: "direct",
      desc: "Heritable size plasticity: SPLICE_DUP an inert trailing cassette when ATP is low (amplify), SPLICE_DEL it when fat (streamline). Splices only ever touch the appended NOP cassette, never the functional head.",
      prog: [
        ...HET_KIT,
        ["PUSH8", ING_DETRITUS], ["INGEST"],
        ...climbParticleGradient(CHEM_BIOPOLYMER, 30),
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
      desc: "Non-genetic switching: a register oscillator drives POKE_BYTE to rewrite the first SYNTH's catalyst-slot param each tick, toggling which reaction it boosts (phenotype) across ticks.",
      prog: [
        ...HET_KIT,
        ["PUSH8", ING_DETRITUS], ["INGEST"],
        ...climbParticleGradient(CHEM_BIOPOLYMER, 30),
        ["LOAD", 0],
        ["PUSH8", 1],
        ["ADD"],
        ["STORE", 0], // reg0++ : a free-running tick counter
        ["LOAD", 0],
        ["PUSH8", 16],
        ["MOD"], // value byte to write (0..15), oscillates
        // Byte index of the first SYNTH's param. frameProg prepends
        // [NOP, NOP, GENE] (+3), so the param that sat at raw index 2 is
        // at framed index 5. (Poking index 2 would overwrite the GENE
        // start codon and render the cell inert -- never reproduces.)
        ["PUSH8", 5],
        ["POKE_BYTE"], // pops (idx, val)
        ...reproduceWhenGrown(34, "np"),
      ],
    },
    {
      id: "allelopath",
      label: "allelopath",
      cls: "direct",
      desc: "Chemical warfare: aggressively excretes WASTE + CO2 to push the local ambient over the toxify thresholds, corroding the membranes of neighbours that absorb the poison. The weapon is survivable only because of heritable toxin self-resistance: a genome that EXPRESSES `EXCRETE <toxin>` is immune to that toxin's toxify (the efflux machinery that exports it also protects the cell), so the allelopath -- and its clonal kin, who carry the same two excrete genes -- tolerate the shared poison while any susceptible victim that does not produce it still takes membrane damage. Excreting CO2 also vents the cell's own respiratory CO2, preventing self-toxification (an earlier waste-only version that stopped venting CO2 self-poisoned and went extinct).",
      prog: [
        ...HET_KIT,
        ["PUSH8", ING_DETRITUS], ["INGEST"],
        ...climbParticleGradient(CHEM_BIOPOLYMER, 30),
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
        ...HET_KIT,
        ["PUSH8", ING_DETRITUS], ["INGEST"],
        ...climbParticleGradient(CHEM_BIOPOLYMER, 30),
        ["PUSH8", 30],
        ["EXCRETE", CHEM_MARKER0],
        ...reproduceWhenGrown(34, "np"),
      ],
    },
    {
      id: "swarmer",
      label: "kin swarmer",
      cls: "direct",
      desc: "Social aggregator: emits a marker0 plume AND climbs the marker0 gradient, so clonal kin (who shed the same marker) accrete into drifting swarms. Aggregation is fully emergent from one shared chemical channel -- no group rule. Pairs well with the colony/greenbeard bonding seeds (a dense swarm is where bonds can form). Watch for quorum-like density build-up vs. dispersal.",
      prog: [
        ...HET_KIT,
        ["PUSH8", ING_DETRITUS], ["INGEST"],
        ["PUSH8", 30],
        ["EXCRETE", CHEM_MARKER0],
        ...climbParticleGradient(CHEM_MARKER0, 30),
        ...reproduceWhenGrown(34, "np"),
      ],
    },
    {
      id: "rheotroph",
      label: "current rider",
      cls: "direct",
      desc: "Mechanosensory disperser: builds a mechanoreceptor and thrusts along the net force it feels (currents, swells, gust disturbance), so it rides bulk water motion to colonise new regions instead of fighting it -- passive long-range dispersal on the back of the physics. Illustrates mechanoreception (act_mech x/y) driving behaviour rather than just gating.",
      prog: [
        ...HET_KIT,
        ["PUSH8", ING_DETRITUS], ["INGEST"],
        ["SYNTH", "CAT", RX_SLOT_SYNTH_MECH], // build the mechanoreceptor
        ...climbGradient(CHEM_ACT_MECH_X, CHEM_ACT_MECH_Y, 20),
        ...reproduceWhenGrown(32, "np"),
      ],
    },
    {
      id: "scout",
      label: "toxin scout",
      cls: "direct",
      desc: "Avoidance forager: climbs the food (biopolymer) gradient but FLEES the waste gradient, so it grazes detritus while steering clear of allelopath toxin plumes and dense-respiration dead zones. The two opposing chemotaxes sum each tick, so it threads between food and poison -- emergent risk-balanced foraging.",
      prog: [
        ...HET_KIT,
        ["PUSH8", ING_DETRITUS], ["INGEST"],
        ...climbParticleGradient(CHEM_BIOPOLYMER, 30),
        ...fleeParticleGradient(CHEM_WASTE, 30),
        ...reproduceWhenGrown(32, "np"),
      ],
    },
    {
      id: "acidophile",
      label: "acidophile",
      cls: "direct",
      desc: "pH-sensing vent specialist: builds a phreceptor (acidity sense) + the heat-shock/repair chaperone (acid/heat tolerance), then uses the acidity reading bistably -- when the water isn't acidic enough (act_ph < 20) it climbs the CO2 plume toward the vent; once it's in acidic water it settles and grows. Reproduction is effectively niche-locked to the acidic vent zone. Demonstrates the new pH sense driving habitat selection rather than just gating. Spawn it near a vent.",
      prog: [
        ...HET_KIT,
        ["PUSH8", ING_DETRITUS], ["INGEST"],
        ["SYNTH", "CAT", RX_SLOT_SYNTH_PHRECEPTOR], // build the acidity sense
        ["SYNTH", "CAT", RX_SLOT_SYNTH_REPAIR],     // chaperone -> acid/heat tolerance
        ["SENSE_CHEMICAL", CHEM_ACT_PH],
        ["PUSH8", 20],
        ["LT"], // act_ph < 20 -> not acidic enough -> migrate toward the vent
        ["JZ", "settled"],
        ...climbParticleGradient(CHEM_CO2, 30), // swim up the CO2/acid plume
        ["LABEL", "settled"],
        ...reproduceWhenGrown(32, "np"),
      ],
    },
    {
      id: "magneto-navigator",
      label: "magneto navigator",
      cls: "direct",
      desc: "Navigates by the geomagnetic MAP: builds a magnetoreceptor and swims along the local field vector (act_mag x/y). Because the field is now positional -- it tilts across x (declination) and strengthens with depth (intensity) rather than being one fixed compass -- following it produces directed migration / depth-keeping that varies with where the cell is, the substrate for homing and long-range vertical migration. Unlike the phototaxis seed it migrates always (not only when dark).",
      prog: [
        ...HET_KIT,
        ["PUSH8", ING_DETRITUS], ["INGEST"],
        ["SYNTH", "CAT", RX_SLOT_SYNTH_MAGNETO], // build the compass/map sense
        ...climbGradient(CHEM_ACT_MAG_X, CHEM_ACT_MAG_Y, 30), // swim along the field
        ...reproduceWhenGrown(32, "np"),
      ],
    },
    {
      id: "skitterer",
      label: "vib skitterer",
      cls: "direct",
      desc: "Hydroacoustic prey: builds a vibroreceptor (lateral-line-style hearing) and bolts AWAY from the bearing of any nearby moving cell -- it hears an approaching swimmer's wake and flees before contact. Forages detritus otherwise. Sets up a speed-vs-stealth arms race: fast predators are loud and easy to flee, so gliding/ambush pays. Distinct from mechanoreception (contact); this is sensing motion at range.",
      prog: [
        ...HET_KIT,
        ["PUSH8", ING_DETRITUS], ["INGEST"],
        ["SYNTH", "CAT", RX_SLOT_SYNTH_VIBRO], // build the lateral-line sense
        // flee the wake bearing (negate act_vib): ax=-vx*30, ay=-vy*30
        ["SENSE_CHEMICAL", CHEM_ACT_VIB_X], ["PUSH8", 30], ["MUL"], ["NEG"],
        ["SENSE_CHEMICAL", CHEM_ACT_VIB_Y], ["PUSH8", 30], ["MUL"], ["NEG"],
        ["THRUST"],
        ...reproduceWhenGrown(32, "np"),
      ],
    },
    {
      id: "light-shoaler",
      label: "light shoaler",
      cls: "direct",
      desc: "Sees by reflected light: boosts its visible photoreceptor and swims up the act_light bearing -- toward nearby cells lit by the sun -- so it aggregates into visible shoals in sunlit water. Pure reflected-light vision (cells are transparent for now: no shadows / no occlusion), so it only works where there IS ambient light (dark/deep = blind until bioluminescence lands). Emergent visual schooling from one shared light field.",
      prog: [
        ...HET_KIT,
        ["PUSH8", ING_DETRITUS], ["INGEST"],
        ["SYNTH", "CAT", RX_SLOT_SYNTH_PHOTO_V], // boost the visible eye
        ...climbGradient(CHEM_ACT_LIGHT_X, CHEM_ACT_LIGHT_Y, 30), // toward lit cells
        ...reproduceWhenGrown(32, "np"),
      ],
    },
    {
      id: "anglerfish",
      label: "anglerfish lure",
      cls: "direct",
      desc: "Bioluminescent ambush predator: spends ATP to EMIT visible light (a lure that shines even in the dark, where reflection is zero), then strikes (PREDATE) + engulfs whatever swims in. Light-seeing prey (light-shoaler / light-vision lineages) home on the glow and get eaten -- an emergent lure-and-ambush trap from the light field. The ATP cost of glowing is the tradeoff. Best in deep/dark water where the lure stands out.",
      prog: [
        ...HET_KIT,
        ["PUSH8", ING_DETRITUS], ["INGEST"],
        ["PUSH8", 60], ["EMIT", 1], // bioluminescent lure (channel 1 = light)
        ["PREDATE"],
        ["ENGULF"],
        ...reproduceWhenGrown(34, "np"),
      ],
    },
    {
      id: "electric-beacon",
      label: "electric beacon",
      cls: "direct",
      desc: "Deliberately broadcasts a bioelectric pulse every tick (OP.EMIT spends ATP to glow brighter than baseline metabolism on the electric channel). Substrate for emergent electrocommunication, kin signalling, prey luring, or jamming -- other lineages with an electroreceptor can home on it. The ATP cost makes loud signalling a real tradeoff (a beacon is easier for electro-hunters to find), so when/whether it pays off is left to selection.",
      prog: [
        ...HET_KIT,
        ["PUSH8", ING_DETRITUS], ["INGEST"],
        ...climbParticleGradient(CHEM_BIOPOLYMER, 30),
        ["PUSH8", 40], ["EMIT", 0], // broadcast electric magnitude 40 (channel 0)
        ...reproduceWhenGrown(34, "np"),
      ],
    },
    {
      id: "electro-hunter",
      label: "electro-hunter",
      cls: "direct",
      desc: "Electrosensory predator: builds an electroreceptor and homes on the bioelectric glow of nearby metabolically-active cells (act_electro x/y -> thrust), then strikes on contact (PREDATE) and engulfs. Hunts by electroreception -- it finds busy prey even with no chemical trail or light, in murky/dark water. Demonstrates the new electric sense: a cell is detectable simply by being metabolically alive. Predator/prey balance still emerges from size (PREDATE needs the attacker wider than the target).",
      prog: [
        ...HET_KIT,
        ["PUSH8", ING_DETRITUS], ["INGEST"],
        ["SYNTH", "CAT", RX_SLOT_SYNTH_ELECTRO], // build the electrosense
        ...climbGradient(CHEM_ACT_ELECTRO_X, CHEM_ACT_ELECTRO_Y, 30), // swim toward active cells
        ["PREDATE"],
        ["ENGULF"],
        ...reproduceWhenGrown(32, "np"),
      ],
    },
    {
      id: "virus",
      label: "true virus",
      cls: "seed",
      desc: "Seed: minimal soma that SYNTHs PACKAGE, shedding fragments of its own genome as decaying eDNA carriers. Spread needs competent victims + a long run. No catalyst kit -- a virus that bulks up costs more to engulf and replicates less efficiently.",
      prog: [
        ["SYNTH", "PACKAGE", 0], // shed self-genome carriers
        ["PUSH8", ING_DETRITUS], ["INGEST"],
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
        ...HET_KIT,
        ["PUSH8", ING_DETRITUS], ["INGEST"],
        ...climbParticleGradient(CHEM_BIOPOLYMER, 12),
        ["SENSE_CHEMICAL", CHEM_CO2], // own CO2 pool -> excretion amount
        ["EXCRETE", CHEM_CO2],
        ...reproduceWhenGrown(30, "np"),
      ],
    },
    {
      id: "chemolithoautotroph",
      label: "vent chemolith",
      cls: "direct",
      desc: "Chemosynthetic primary producer of the dark sea floor. Lives on the hydrothermal vent's reduced-fuel seep: an evolved catalyst oxidizes the abiotic fuel for ATP (energy module), a second fixes ambient CO2 into glucose paying with that ATP (carbon module) -- carbon and energy from non-living chemistry, no light, no organic food. Holds the heat-shock chaperone (CHEM_REPAIR) so it survives the scalding vent core where its fuel pools. The energy/carbon catalyst slots are auto-derived from the seeded reaction table (chemolith.ts) -- the very fuels the engine vent emits -- so the niche is the substrate's own chemistry, not a script. Spawn it on the vent.",
      prog: [
        ["SYNTH", "CAT", CHEMOLITH_ENERGY_SLOT], // abiotic fuel -> ATP
        ["SYNTH", "CAT", CHEMOLITH_CARBON_SLOT], // CO2 (+fuel) -> glucose
        ["SYNTH", "CAT", RX_SLOT_SYNTH_REPAIR],  // heat-shock chaperone -> survive the hot vent
        ["SYNTH", "CAT", RX_SLOT_SYNTH_MEM_AAFA], // boost membrane synth (growth)
        ["PUSH8", ING_DETRITUS], ["INGEST"],     // eat the reduced-fuel particles
        // Sessile: it parks on the fuel seep and lets fuel come to it.
        // Homing UP the marker0 gradient drove cells into the scalding
        // vent core (and burned ATP thrusting) -> extinction; staying put
        // in the cooler outer fuel ring sustains. The vent's marker0
        // beacon remains as an evolvable cue for descendants to exploit.
        ...reproduceWhenGrown(24, "np"),
      ],
    },
  ];
  const built: Archetype[] = list.map(
    ({ id, label, desc, cls, prog, uiHidden }) => {
      const genome = asm(frameProg(prog));
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
