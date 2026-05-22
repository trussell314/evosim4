// The 256-slot reaction table: procedurally-generated mass-balanced
// generics (atpDelta derived from bond potential -- conservative, no
// free energy) with the 26 hand-authored named reactions overwriting
// the head. Built once at import from fixed seeds. Pure: depends only
// on rng + chem-ids + chemistry + genome's reaction/synth constants,
// so no value cycle back through sim.ts. The hot per-cell driver
// (runGenericReactions) and the UI catalog stay in sim.ts since they
// touch Creature state / the rxn-stats recorder.

import { mulberry32 } from "../rng";
import { CHEMICAL_COUNT } from "./chem-ids";
import {
  CHEM_GLU, CHEM_O2, CHEM_CO2, CHEM_FA, CHEM_AA, CHEM_MIN, CHEM_CHL,
  CHEM_ENZ, CHEM_MRNA, CHEM_MEMBRANE, CHEM_BIOPOLYMER, CHEM_WASTE,
  CHEM_ADP,
  CHEM_PHOTORECEPTOR_VISIBLE, CHEM_PHOTORECEPTOR_LONG,
  CHEM_PHOTORECEPTOR_SURFACE, CHEM_CHEMORECEPTOR_BIOPOLYMER,
  CHEM_CHEMORECEPTOR_MINERALS, CHEM_CHEMORECEPTOR_FA,
  CHEM_CHEMORECEPTOR_MARKER0, CHEM_MECHANORECEPTOR,
  CHEM_THERMORECEPTOR, CHEM_MAGNETORECEPTOR, CHEM_BOND, CHEM_REPAIR,
  CHEM_ATP,
} from "./chem-ids";
import { CHEMICALS, CHEM_BOND_POTENTIAL, GENERIC_SPAWN_ORDER } from "./chemistry";
import { N_REACTIONS } from "../genome";

export interface Reaction {
  sChem: Uint8Array;    // length 1..3, substrate chem ids
  sCount: Float32Array; // parallel, mass-units per unit reaction
  pChem: Uint8Array;    // length 1..3, product chem ids
  pCount: Float32Array; // parallel
  atpDelta: number;     // signed energy delta per unit reaction (>0 = exergonic)
  lightIn: number;      // 0 if not light-driven; else units of light per unit
  vmax: number;         // boost rate added on top of uncatRate per (pool/CAT_REF)
  // Baseline rate when catalyst pool is 0. Named reactions set this > 0
  // (the bootstrap chemistry every cell gets free); generic reactions
  // leave it 0 -- they only fire when a cell has built the catalyst.
  uncatRate: number;
  // If true, rate also scales with cell surface area (r / MIN_R) -- only
  // photosynth uses this today, modeling pigment membrane area.
  surfaceScale: boolean;
  // Apply BIOSYNTH_ATP_FLOOR when this reaction consumes ATP. True for
  // biosynth slots so newborns don't burn their starting ATP on growth.
  atpFloor: boolean;
  // Rate multiplied by chemCols[CHEM_MRNA][i] / MRNA_REF. Set on
  // every biosynth reaction (real mRNA drive protein synthesis).
  // Mandatory -- zero mRNA means zero biosynth.
  mrnaScale: boolean;
  // Rate multiplied by chemCols[CHEM_CHL][i] / CHL_REF. Set only on
  // photosynth (real chlorophyll absorbs the photon). Mandatory --
  // zero chlorophyll means no carbon fixation.
  chlScale: boolean;
  // Rate multiplied by chemCols[CHEM_ENZ][i] / ENZ_REF. Set only on
  // biopolymer digestion (catabolism replacement). Mandatory -- zero
  // enzyme means no biopolymer breakdown. The cell can still hold
  // biopolymer in its pool, but can't extract glu/aa/fa from it
  // without building enzymes.
  enzScale: boolean;
  // Transport reaction: when set, this slot does NOT run as an intra-
  // pool reaction. Instead its catalyst (catalystCols[slot], built by
  // SYNTH CAT param=slot -- a transporter IS an enzyme) facilitates
  // movement of this one chem across a membrane the cell owns (outer:
  // cell<->world; vacuolar: host<->organelle). Handled by the cross-
  // compartment applier (runTransportReactions), skipped by
  // runGenericReactions. v1 is facilitated (down-gradient, atpDelta=0);
  // the atpDelta field is reserved for future active/uphill pumping.
  transport?: number;
}

// Named reactions occupy the first NAMED_HEAD slots (re-exported below
// as NAMED_REACTION_COUNT). Defined here, pre-build, so the table
// builder can address the generic region without tripping the temporal
// dead zone on the export const.
const NAMED_HEAD = 26;

function buildReactionTable(): Reaction[] {
  const rng = mulberry32(0xE2C4_BEEF);
  const COUNT_POOL = [1, 1, 1, 1, 2, 2, 3, 5, 10];
  const pickInt = (n: number): number => Math.floor(rng() * n);
  const pickFrom = <T>(arr: ReadonlyArray<T>): T => arr[pickInt(arr.length)];
  const out: Reaction[] = [];
  for (let i = 0; i < N_REACTIONS; i++) {
    const nS = 1 + pickInt(3); // 1..3
    const nP = 1 + pickInt(3);
    // Substrates: unique chem ids
    const sChem = new Uint8Array(nS);
    {
      const used = new Set<number>();
      for (let j = 0; j < nS; j++) {
        let id: number;
        do { id = pickInt(CHEMICAL_COUNT); } while (used.has(id));
        used.add(id); sChem[j] = id;
      }
    }
    // Products: unique chem ids, disjoint from substrates (no A -> A)
    const pChem = new Uint8Array(nP);
    {
      const used = new Set<number>(Array.from(sChem));
      for (let j = 0; j < nP; j++) {
        let id: number;
        do { id = pickInt(CHEMICAL_COUNT); } while (used.has(id));
        used.add(id); pChem[j] = id;
      }
    }
    // Substrate counts (raw small integers)
    const sCount = new Float32Array(nS);
    let sMass = 0;
    for (let j = 0; j < nS; j++) {
      const c = pickFrom(COUNT_POOL);
      sCount[j] = c;
      sMass += c * CHEMICALS[sChem[j]].molarMass;
    }
    // Product counts: pick raw integers, then scale so total product
    // mass equals total substrate mass (mass conservation). The scale
    // factor pushes counts away from integer values; that's fine --
    // chemistry runs on floats anyway.
    const pCountRaw = new Float32Array(nP);
    let pMassRaw = 0;
    for (let j = 0; j < nP; j++) {
      const c = pickFrom(COUNT_POOL);
      pCountRaw[j] = c;
      pMassRaw += c * CHEMICALS[pChem[j]].molarMass;
    }
    const scale = sMass / pMassRaw;
    const pCount = new Float32Array(nP);
    for (let j = 0; j < nP; j++) pCount[j] = pCountRaw[j] * scale;
    // ATP delta: NOT a free draw. Energy released = bond potential
    // liberated = (Σ substrate potential) − (Σ product potential).
    // Mass is already balanced above, so this is conservative by
    // construction: the exact reverse reaction has the negated
    // atpDelta, and any closed cycle of generics telescopes to zero
    // net ATP -- no perpetual-motion reservoir, no exergonic bias.
    // Sign follows composition: a reaction that breaks high-bond-
    // energy substrates into low-energy products is exergonic
    // (yields ATP); building energy-rich products costs ATP.
    // The three rng() draws that formerly *were* atpDelta are still
    // consumed (and discarded) so every other generated field --
    // here and in all later slots -- stays bit-identical to before.
    rng(); rng(); rng();
    let sBondE = 0;
    for (let j = 0; j < nS; j++) sBondE += sCount[j] * CHEM_BOND_POTENTIAL[sChem[j]];
    let pBondE = 0;
    for (let j = 0; j < nP; j++) pBondE += pCount[j] * CHEM_BOND_POTENTIAL[pChem[j]];
    const atpDelta = sBondE - pBondE;
    // Light: ~15% of reactions are light-driven, requiring 0.2..1.5
    // units of ambient light to proceed (caps the rate).
    const lightIn = rng() < 0.15 ? 0.2 + rng() * 1.3 : 0;
    // VMAX: log-uniform 0.05 .. 1.5, so a few reactions are fast,
    // most are middling. Cells that build the right catalyst can
    // make the slow ones useful too.
    const vmax = Math.exp(Math.log(0.05) + rng() * (Math.log(1.5) - Math.log(0.05)));
    out.push({
      sChem, sCount, pChem, pCount, atpDelta, lightIn, vmax,
      uncatRate: 0, surfaceScale: false, atpFloor: false,
      mrnaScale: false, chlScale: false, enzScale: false,
    });
  }
  // Overwrite the first NAMED_REACTION_COUNT generated entries with the
  // named reactions. Catalyst slots 0..N-1 correspond to the named
  // reactions, so a cell that builds catalyst[k] is boosting one of
  // these specific pathways. Subsequent slots remain the generated
  // generics.
  installNamedReactions(out);
  installTransporters(out);
  installCarbonFixReactions(out, rng);
  return out;
}

// ---------------------------------------------------------------------
// Carbon-fixation enrichment (COLONY_GAPS GAP #6). The procedural table
// seeds only ONE glucose route from an acquirable input, so a non-photic
// autotroph is carbon-throughput-starved. Inject a graded set of
// catalyst-gated (uncatRate 0) GLU-producing reactions -- all fixing
// carbon from acquirable CO2 -- spanning an effort/yield gradient: cheap
// routes on common substrates with low glucose yield, up through
// rare-substrate, multi-input routes with high yield (a scarce reductant
// pays the cost of building energy-dense glucose). Each overwrites the
// lowest-"interest" generic slot, so the 256-slot table size is
// unchanged. These are DOORS, not scripts: a lineage runs one only by
// evolving SYNTH CAT <its slot>; the variety exists for evolution to
// discover, nothing seeds it.
const CARBON_FIX_COUNT = 8;

interface CarbonFixTier {
  extra: number[];   // substrates besides CO2 (the carbon source)
  gluShare: number;  // fraction of product MASS that is glucose (== yield)
  vmaxLo: number;
  vmaxHi: number;
  byproduct: number; // oxidized/waste product carrying the non-glucose mass
  light: number;     // ambient light units required (0 = dark)
  co2: number;       // CO2 substrate count (bigger reaction -> more glucose)
}

// Generic substrates picked by spawn rarity (GENERIC_SPAWN_ORDER rank 0
// = most-seeded). High-yield routes hang off the rare tail, so they are
// gated on a scarce reductant a cell must find, hoard, or cross-feed.
const CF_RARE = GENERIC_SPAWN_ORDER.length - 1;
const CARBON_FIX_TIERS: CarbonFixTier[] = [
  // Easy -- common substrates, low yield, fast.
  { extra: [],                                  gluShare: 0.35, vmaxLo: 1.1, vmaxHi: 1.6, byproduct: CHEM_O2,    light: 0,   co2: 1 },
  { extra: [CHEM_MIN],                          gluShare: 0.42, vmaxLo: 0.9, vmaxHi: 1.3, byproduct: CHEM_WASTE, light: 0,   co2: 1 },
  { extra: [GENERIC_SPAWN_ORDER[0]],            gluShare: 0.48, vmaxLo: 0.8, vmaxHi: 1.1, byproduct: CHEM_O2,    light: 0.8, co2: 1 }, // light-assisted, no chlorophyll
  // Mid -- a generic reductant, medium yield.
  { extra: [GENERIC_SPAWN_ORDER[12]],           gluShare: 0.60, vmaxLo: 0.60, vmaxHi: 0.90, byproduct: CHEM_WASTE, light: 0, co2: 1 },
  { extra: [CHEM_MIN, GENERIC_SPAWN_ORDER[18]], gluShare: 0.66, vmaxLo: 0.55, vmaxHi: 0.80, byproduct: CHEM_WASTE, light: 0, co2: 2 },
  // Complex -- rare substrates, high yield, slow.
  { extra: [GENERIC_SPAWN_ORDER[CF_RARE]],                              gluShare: 0.80, vmaxLo: 0.40, vmaxHi: 0.60, byproduct: CHEM_WASTE, light: 0, co2: 2 },
  { extra: [GENERIC_SPAWN_ORDER[CF_RARE - 1], GENERIC_SPAWN_ORDER[12]], gluShare: 0.88, vmaxLo: 0.40, vmaxHi: 0.55, byproduct: CHEM_WASTE, light: 0, co2: 2 },
  { extra: [GENERIC_SPAWN_ORDER[CF_RARE - 2], CHEM_FA],                 gluShare: 0.95, vmaxLo: 0.35, vmaxHi: 0.50, byproduct: CHEM_WASTE, light: 0, co2: 3 }, // FA = energy-rich reductant
];

function buildCarbonFixReaction(tier: CarbonFixTier, rng: () => number): Reaction {
  const sChemA = [CHEM_CO2, ...tier.extra];
  // CO2 count from the tier; each extra reductant 1..2 (procedural jitter).
  const sCountA = sChemA.map((_, i) => (i === 0 ? tier.co2 : 1 + (rng() < 0.5 ? 0 : 1)));
  let sMass = 0;
  for (let j = 0; j < sChemA.length; j++) sMass += sCountA[j] * CHEMICALS[sChemA[j]].molarMass;
  // Glucose carries `gluShare` of the substrate mass, the byproduct the
  // remainder -- so yield scales with both gluShare and reaction size.
  const share = Math.min(0.98, Math.max(0.2, tier.gluShare + (rng() - 0.5) * 0.04));
  const gluMass = share * sMass;
  const bpMass = sMass - gluMass;
  const pChemA = [CHEM_GLU];
  const pCountA = [gluMass / CHEMICALS[CHEM_GLU].molarMass];
  if (bpMass > 1e-3) {
    pChemA.push(tier.byproduct);
    pCountA.push(bpMass / CHEMICALS[tier.byproduct].molarMass);
  }
  // atpDelta from bond potential (conservative, as for every generic):
  // a rich reductant offsets the cost of building energy-dense glucose,
  // so the rare/complex routes are cheaper per unit than the cheap ones.
  let sBondE = 0;
  for (let j = 0; j < sChemA.length; j++) sBondE += sCountA[j] * CHEM_BOND_POTENTIAL[sChemA[j]];
  let pBondE = 0;
  for (let j = 0; j < pChemA.length; j++) pBondE += pCountA[j] * CHEM_BOND_POTENTIAL[pChemA[j]];
  const vmax = Math.exp(Math.log(tier.vmaxLo) + rng() * (Math.log(tier.vmaxHi) - Math.log(tier.vmaxLo)));
  return {
    sChem: new Uint8Array(sChemA),
    sCount: new Float32Array(sCountA),
    pChem: new Uint8Array(pChemA),
    pCount: new Float32Array(pCountA),
    atpDelta: sBondE - pBondE,
    lightIn: tier.light,
    vmax,
    uncatRate: 0,
    surfaceScale: false,
    atpFloor: true,
    mrnaScale: false,
    chlScale: false,
    enzScale: false,
  };
}

// Interest heuristic for retiring generic slots: a reaction scores low
// when it cannot run for a free-living cell (substrates not world-
// acquirable), makes nothing valuable, moves little energy, and is slow.
// Overwriting the lowest CARBON_FIX_COUNT generics removes the redundant
// dead ends -- including the circular GLU routes that need internal
// machinery chems as inputs -- and keeps the table size fixed.
function installCarbonFixReactions(out: Reaction[], rng: () => number): void {
  const acquirable = new Set<number>([
    CHEM_CO2, CHEM_O2, CHEM_MIN, CHEM_FA, CHEM_ADP, CHEM_BIOPOLYMER,
    CHEM_GLU, CHEM_AA, CHEM_WASTE,
  ]);
  for (const g of GENERIC_SPAWN_ORDER) acquirable.add(g);
  const valuable = new Set<number>([
    CHEM_GLU, CHEM_AA, CHEM_FA, CHEM_ATP, CHEM_MEMBRANE, CHEM_BIOPOLYMER,
    CHEM_CHL, CHEM_ENZ, CHEM_MRNA,
  ]);
  const interest = (r: Reaction): number => {
    let runnable = true;
    for (const s of r.sChem) if (!acquirable.has(s)) runnable = false;
    let makesValue = false;
    let makesGlu = false;
    for (const p of r.pChem) {
      if (valuable.has(p)) makesValue = true;
      if (p === CHEM_GLU) makesGlu = true;
    }
    // Retire first: the pre-existing circular GLU routes that "produce"
    // glucose only from internal-machinery chems a free cell cannot
    // acquire -- redundant now that the graded acquirable-input routes
    // below replace them.
    if (makesGlu && !runnable) return -1;
    return (
      (runnable ? 2 : 0) +
      (makesValue ? 2 : 0) +
      Math.min(2, Math.abs(r.atpDelta) * 3) +
      Math.min(1, r.vmax)
    );
  };
  // Rank the generic region (named head + transport tail excluded) by
  // interest, ascending; overwrite the least-interesting slots.
  const slots: number[] = [];
  for (let s = NAMED_HEAD; s < TRANSPORT_SLOT_BASE; s++) slots.push(s);
  slots.sort((a, b) => interest(out[a]) - interest(out[b]) || a - b);
  for (let k = 0; k < CARBON_FIX_COUNT; k++) {
    out[slots[k]] = buildCarbonFixReaction(CARBON_FIX_TIERS[k], rng);
  }
}

// Standing transporters (Substrate B): the core small-molecule
// metabolites. A transporter is the existing "enzyme = SYNTH'd
// catalyst" machinery -- SYNTH CAT param=slot builds the transporter
// protein for that chem. We REPURPOSE the last band of procedurally-
// generated generic slots (exactly as installNamedReactions overwrites
// the head): buildReactionTable's seeded rng has already drawn for all
// N_REACTIONS slots, so draw order is byte-identical and determinism
// is preserved; only the (deliberate) loss of those random generics +
// the new transport behavior moves the golden hash. No table-size /
// catalyst-count / save-schema change.
export const TRANSPORT_CHEM_IDS: readonly number[] = [
  CHEM_O2, CHEM_CO2, CHEM_GLU, CHEM_AA,
  CHEM_FA, CHEM_MIN, CHEM_ADP, CHEM_WASTE,
];
// ATP translocase sentinel (NOT a chem id -- ATP is the per-creature
// ATP translocase target. Path 1: ATP is now a real chemical
// (CHEM_ATP, == the aliased `energy` column), so this is a normal
// chem-id transporter -- no sentinel/special-case needed. It is the
// faithful ADP/ATP translocase (ANT): ATP has permeability 0 so it
// never passively crosses a membrane (no free bleed to water, no
// passive organelle<->host); it moves ONLY via this dedicated
// carrier, and (like real ANT, an inner-membrane protein) it acts at
// the VACUOLAR membrane only -- the outer-membrane applier skips
// CHEM_ATP (there is no ambient ATP).
export const TRANSPORT_ATP = CHEM_ATP;
// The transport band: the 8 small-molecule metabolites plus the ATP
// translocase. One contiguous post-build-overwritten band so the
// seeded buildReactionTable draw order stays byte-identical.
export const TRANSPORT_TARGETS: readonly number[] = [
  ...TRANSPORT_CHEM_IDS,
  TRANSPORT_ATP,
];
export const TRANSPORT_SLOT_BASE = N_REACTIONS - TRANSPORT_TARGETS.length;
// Catalyst slot a genome SYNTHs (SYNTH CAT param=this) to build the
// ATP translocase (ANT). It is the last slot of the transport band.
export const TRANSPORT_ATP_SLOT =
  TRANSPORT_SLOT_BASE + TRANSPORT_TARGETS.length - 1;
// Glucose transport slot -- the mito's substrate-import carrier
// analog (real mitos receive pyruvate via inner-membrane carriers
// since they can't ingest particles). With glucose permeability=0
// passive diffusion across the vacuolar membrane is blocked, so an
// engulfed mito needs this catalyst to draw glucose from the host
// pool. Index matches TRANSPORT_TARGETS.indexOf(CHEM_GLU) = 2.
export const TRANSPORT_GLU_SLOT = TRANSPORT_SLOT_BASE + 2;

// Named reaction slots, exported for use by archetypes / scenarios that
// want to BOOST a specific bootstrap reaction via `SYNTH CAT <slot>`.
// After Phase 4a these named reactions all fire at uncatRate
// unconditionally on every cell; CAT/INH per slot are the only way a
// genome influences their rates. Slots match installNamedReactions
// indices in this file -- keep in sync if you renumber.
export const RX_SLOT_RESPIRATION    = 0;  // glu+o2 -> co2 + atp
export const RX_SLOT_FERMENT        = 1;  // glu -> co2+waste + atp
export const RX_SLOT_BETA_OX        = 2;  // fa+o2 -> co2 + atp
export const RX_SLOT_PHOTOSYNTH     = 3;  // co2 -> glu+o2 (light, chl)
export const RX_SLOT_SYNTH_AA       = 4;
export const RX_SLOT_SYNTH_FA       = 5;
export const RX_SLOT_SYNTH_CHL      = 6;
export const RX_SLOT_SYNTH_ENZ      = 7;
export const RX_SLOT_SYNTH_MRNA     = 8;
export const RX_SLOT_SYNTH_MEM_AAFA = 9;  // aa+fa -> membrane
export const RX_SLOT_DIGEST_BIOP    = 10; // biopolymer -> glu+aa+fa
export const RX_SLOT_SYNTH_MEM_FA   = 11; // fa -> membrane
export const RX_SLOT_SYNTH_PHOTO_V  = 12; // visible photoreceptor
export const RX_SLOT_SYNTH_PHOTO_L  = 13; // long photoreceptor
export const RX_SLOT_SYNTH_PHOTO_S  = 14; // surface photoreceptor
export const RX_SLOT_SYNTH_MECH     = 19;
export const RX_SLOT_SYNTH_THERMO   = 20;
export const RX_SLOT_SYNTH_MAGNETO  = 21;
export const RX_SLOT_SYNTH_BOND     = 22;
export const RX_SLOT_SYNTH_REPAIR   = 23;
// Facilitated permeability scaler at full catalyst pool (analogous to
// a generic reaction's vmax). Net flux also scales with the cross-
// membrane concentration gap, the catalyst pool, and cell surface.
const TRANSPORT_VMAX = 0.6;
function installTransporters(out: Reaction[]): void {
  const empty = new Uint8Array(0);
  const emptyF = new Float32Array(0);
  for (let n = 0; n < TRANSPORT_TARGETS.length; n++) {
    out[TRANSPORT_SLOT_BASE + n] = {
      sChem: empty, sCount: emptyF, pChem: empty, pCount: emptyF,
      atpDelta: 0, lightIn: 0, vmax: TRANSPORT_VMAX, uncatRate: 0,
      surfaceScale: false, atpFloor: false,
      mrnaScale: false, chlScale: false, enzScale: false,
      transport: TRANSPORT_TARGETS[n],
    };
  }
}

export const REACTIONS: Reaction[] = buildReactionTable();
// Number of named reactions installed at the head of REACTIONS. Phase
// D added slots 10 (biopolymer-digest) and 11 (membrane-synth). Phase
// H2 adds slots 12..15 (receptor biosynth). Exported so HUD /
// disassembler can label catalyst slots by their bootstrap pathway.
export const NAMED_REACTION_COUNT = NAMED_HEAD;

// Stoichiometric coefficients mirror the previously hand-coded reaction
// functions. Mass conservation is handled implicitly: substrates +
// products + (atpDelta worth of ADP <-> ATP conversion) sum to zero,
// because the engine deducts |atpDelta| ADP and credits |atpDelta|
// ATP (energy) on every exergonic reaction (and vice versa).
function installNamedReactions(out: Reaction[]): void {
  const mk = (
    sChem: number[], sCount: number[],
    pChem: number[], pCount: number[],
    atpDelta: number,
    rate: number,
    opts: {
      lightIn?: number;
      surfaceScale?: boolean; atpFloor?: boolean;
      mrnaScale?: boolean; chlScale?: boolean; enzScale?: boolean;
    } = {},
  ): Reaction => ({
    sChem: new Uint8Array(sChem),
    sCount: new Float32Array(sCount),
    pChem: new Uint8Array(pChem),
    pCount: new Float32Array(pCount),
    atpDelta,
    lightIn: opts.lightIn ?? 0,
    vmax: rate,             // catalyst boost: another `rate` at full pool
    uncatRate: rate,         // bootstrap rate every cell gets free
    surfaceScale: opts.surfaceScale ?? false,
    atpFloor: opts.atpFloor ?? false,
    mrnaScale: opts.mrnaScale ?? false,
    chlScale: opts.chlScale ?? false,
    enzScale: opts.enzScale ?? false,
  });
  // Slot index in NAMED_CHEMICALS: o2=0 co2=1 glu=2 aa=3 fa=4 min=5
  // biomass=6 adp=7 waste=8 chl=9 enz=10 rib=11 biop=12 memb=13.
  // Energy reactions: no mrnaScale (these aren't protein synthesis).
  out[0] = mk([CHEM_GLU, CHEM_O2], [1, 1], [CHEM_CO2], [2], +10, 16);                          // aerobic: glu+o2 -> 2 co2 + 10 atp
  // Anaerobic glycolysis: the only O2-free ATP route. Kept deliberately
  // poor (+2 ATP vs aerobic's +10 = 5:1, toward nature's ~15:1 aerobic
  // advantage) so anaerobic coasting can't rival autotrophy/respiration
  // -- there must be real energetic pressure to be aerobic. It's still a
  // last-resort lifeline in anoxic pockets, not a comfortable strategy.
  out[1] = mk([CHEM_GLU], [1], [CHEM_CO2, CHEM_WASTE], [0.5, 0.5], +2, 1.5);                   // ferment: glu -> 0.5 co2 + 0.5 waste + 2 atp
  out[2] = mk([CHEM_FA, CHEM_O2], [1, 1], [CHEM_CO2], [2], +14, 1.5);                          // betaOx: fa+o2 -> 2 co2 + 14 atp
  // Photosynth: requires chlorophyll molecule (mandatory multiplier).
  // vmax 1.2 -> 5.0, DERIVED (not guessed) from the glu mass balance:
  // a growing autotroph's glu sinks at vmax are synth_aa 0.7*1.2=0.84
  // + synth_fa 0.9*1.5=1.35 + glu->biopolymer 1.0*0.5=0.50 ~= 2.69
  // glu/s. Photosynth yields 0.5 glu per reaction unit, so the rate
  // needed to cover that is 2.69/0.5 ~= 5.4; 5.0 is a touch under (the
  // sinks are rarely all at vmax at once) and well above the old 1.2,
  // which made carbon fixation the binding constraint once synth_aa
  // was relieved (measured: mGLU pinned ~0 in every autotroph run,
  // weak growth even aa-replete). Validated empirically by the
  // unfed photoautotroph/phototaxis controlled runs. Global,
  // intended behavior change; golden re-baselined.
  // vmax 5.0 -> 6.5: part of thickening the autotrophic surplus so a
  // SEEDLESS cell (not just a seed-subsidized founder) can fix enough
  // carbon to fund growth-to-reproduction. Pairs with the photophos-
  // phorylation (out[25]) boost and the reduced membrane-decay tax.
  out[3] = mk([CHEM_CO2], [1], [CHEM_GLU, CHEM_O2], [0.5, 0.5], -1, 6.5, { lightIn: 1, surfaceScale: true, chlScale: true });
  // Biosynth (gated by VM_OUT.synthMask bits 1/2/4/3/5/0). All scale
  // with mrna / mRNA count (mandatory) -- this is the cell's
  // protein synthesis machinery, and zero mRNA means zero growth.
  // synth_aa vmax 0.4 -> 1.2: the de-novo amino-acid route real
  // autotrophs use. At 0.4 it was structurally below a cell's own aa
  // demand at vmax (synth_membrane 0.8*0.5=0.40 + synth_chl 0.10 +
  // synth_ribo 0.075 + receptor 0.075 ~= 0.65), so a pure
  // photoautotroph could never close its own aa budget on
  // light+CO2+minerals (measured: declined with aa-death dominant
  // unless aa was fed exogenously). 1.2 covers summed sink demand
  // with headroom for reproduction/maintenance, so primary producers
  // are self-sufficient as in nature. Deliberate global behavior
  // change (every aa-making cell); golden re-baselined intentionally.
  out[4] = mk([CHEM_GLU, CHEM_MIN], [0.7, 0.3], [CHEM_AA], [1], -2, 1.2, { atpFloor: true, mrnaScale: true }); // synth_aa
  // synth_fa: lipogenesis from photosynthate. Cheapened (-6 -> -3 ATP)
  // and sped up (0.2 -> 0.6, ~in line with membrane synth that
  // consumes fa) so living autotrophs/mixotrophs top up fatty acid
  // from abundant glucose instead of relying on necromass recycling.
  // synth_fa rate 0.6 -> 1.5: with light-driven ATP (out[25]) an
  // autotroph can finally afford this, and it is the ONLY renewable
  // fa source (photosynthesis makes glu, not fa). Membrane synth
  // (out[9]=0.8, out[11]=0.6) consumes fa faster than 0.6 could
  // supply, so phototrophs strip-mined the finite fa seed and died
  // of mass membrane failure when it ran out. 1.5 gives renewable
  // headroom for the CO2->glu->fa->membrane primary-production chain.
  out[5] = mk([CHEM_GLU, CHEM_MIN], [0.9, 0.1], [CHEM_FA], [1], -3, 1.5, { atpFloor: true, mrnaScale: true });
  out[6] = mk([CHEM_AA, CHEM_MIN], [0.5, 0.5], [CHEM_CHL], [1], -8, 0.2, { atpFloor: true, mrnaScale: true }); // synth_chl
  out[7] = mk([CHEM_AA, CHEM_MIN], [0.5, 0.5], [CHEM_ENZ], [1], -4, 0.4, { atpFloor: true, mrnaScale: true }); // synth_enz
  out[8] = mk([CHEM_AA, CHEM_MIN], [0.5, 0.5], [CHEM_MRNA], [1], -10, 0.15, { atpFloor: true, mrnaScale: true }); // synth_ribo
  // synth_membrane via the SYNTH_BIO bit: aa + fa -> membrane lipid.
  // Replaces the retired synth_biomass; SYNTH_BIO now triggers
  // membrane growth instead of generic structural biomass.
  out[9] = mk([CHEM_AA, CHEM_FA], [0.5, 0.5], [CHEM_MEMBRANE], [1], -1, 0.8, { atpFloor: true, mrnaScale: true });
  // Biopolymer digestion. Mass-balanced split mirroring the old
  // CATAB_FRACTIONS for "organic": 0.5 glu + 0.3 aa + 0.2 fa per
  // biopolymer unit. Slightly exergonic (+1 ATP) to model the small
  // payoff a heterotroph gets from breaking polysaccharides /
  // proteins. Gated on enzyme: no enz, no digestion.
  out[10] = mk([CHEM_BIOPOLYMER], [1], [CHEM_GLU, CHEM_AA, CHEM_FA], [0.5, 0.3, 0.2], +1, 6, { enzScale: true });
  // Membrane biosynth. fa -> membrane lipid, endergonic, mRNA-gated.
  // Driven by the same SYNTH bits as synth_biomass so a cell that
  // biosynths a body also lays down membrane. Cheaper than chl/ribo
  // so a growing cell can afford it.
  out[11] = mk([CHEM_FA], [1], [CHEM_MEMBRANE], [1], -2, 0.6, { atpFloor: true, mrnaScale: true }); // synth_memb
  // Receptor biosynth, K-4 unified-SYNTH layout. Each receptor variant
  // gates on its own bit so genome op param picks exactly which
  // chemoreceptor / photoreceptor / etc the cell builds. All cost
  // aa+min, are mRNA-gated, and decay (handled in K-3 activation /
  // base metabolism). Sense modality emerges from which receptor
  // chems the cell carries -- no hardcoded modality table.
  out[12] = mk([CHEM_AA, CHEM_MIN], [0.5, 0.5], [CHEM_PHOTORECEPTOR_VISIBLE], [1], -3, 0.15, { atpFloor: true, mrnaScale: true });
  out[13] = mk([CHEM_AA, CHEM_MIN], [0.5, 0.5], [CHEM_PHOTORECEPTOR_LONG], [1], -3, 0.15, { atpFloor: true, mrnaScale: true });
  out[14] = mk([CHEM_AA, CHEM_MIN], [0.5, 0.5], [CHEM_PHOTORECEPTOR_SURFACE], [1], -3, 0.15, { atpFloor: true, mrnaScale: true });
  // Phase 5 cleanup: chemoreceptor synth slots inertized (rate 0).
  // The receptor chems were inputs to the now-retired chemo branch
  // of runActivation; producing them is pure waste. Slots kept (not
  // deleted) to preserve named-slot indices for everything past 18.
  out[15] = mk([CHEM_AA, CHEM_MIN], [0.5, 0.5], [CHEM_CHEMORECEPTOR_BIOPOLYMER], [1], -3, 0, { atpFloor: true, mrnaScale: true });
  out[16] = mk([CHEM_AA, CHEM_MIN], [0.5, 0.5], [CHEM_CHEMORECEPTOR_MINERALS], [1], -3, 0, { atpFloor: true, mrnaScale: true });
  out[17] = mk([CHEM_AA, CHEM_MIN], [0.5, 0.5], [CHEM_CHEMORECEPTOR_FA], [1], -3, 0, { atpFloor: true, mrnaScale: true });
  out[18] = mk([CHEM_AA, CHEM_MIN], [0.5, 0.5], [CHEM_CHEMORECEPTOR_MARKER0], [1], -3, 0, { atpFloor: true, mrnaScale: true });
  out[19] = mk([CHEM_AA, CHEM_MIN], [0.5, 0.5], [CHEM_MECHANORECEPTOR], [1], -3, 0.15, { atpFloor: true, mrnaScale: true });
  out[20] = mk([CHEM_AA, CHEM_MIN], [0.5, 0.5], [CHEM_THERMORECEPTOR], [1], -3, 0.15, { atpFloor: true, mrnaScale: true });
  out[21] = mk([CHEM_AA, CHEM_MIN], [0.5, 0.5], [CHEM_MAGNETORECEPTOR], [1], -3, 0.15, { atpFloor: true, mrnaScale: true });
  // Bond and repair chems: products of dedicated SYNTH kinds. K-5
  // wires these into emergent adhesion + somatic-mutation control.
  out[22] = mk([CHEM_AA, CHEM_FA], [0.5, 0.5], [CHEM_BOND], [1], -2, 0.3, { atpFloor: true, mrnaScale: true });
  out[23] = mk([CHEM_AA, CHEM_MIN], [0.5, 0.5], [CHEM_REPAIR], [1], -3, 0.2, { atpFloor: true, mrnaScale: true });
  // Primary-production link (3a): fix glucose into the bulk-food
  // storage polymer. This is what lets autotrophs feed the web --
  // photosynthesis makes glu, this turns surplus glu into biopolymer
  // that heterotrophs ingest + digest (out[10]) back to glu/aa/fa,
  // closing the biopolymer/fa loop. Endergonic (storage costs a
  // little ATP), SYNTH_BIO-gated, mRNA-scaled like other biosynth.
  out[24] = mk([CHEM_GLU], [1], [CHEM_BIOPOLYMER], [1], -2, 0.5, { atpFloor: true, mrnaScale: true });
  // Photophosphorylation (the "light reaction"). Pure light-driven
  // ADP -> ATP, no matter substrate/product: chlorophyll harvests
  // light to regenerate the cell's ATP pool. The engine's exergonic
  // path conserves the ADP<->ATP swap (needs ADP available). This is
  // the autotroph's energy source -- previously photosynthesis only
  // had carbon FIXATION (out[3], endergonic -1 ATP) with no light
  // energy input, so a phototroph was a net energy sink and could
  // never escape the chl-synthesis chicken-and-egg. Now light->ATP
  // funds chl synthesis (-8) and fixation (-1), and scales with the
  // chl pool (chlScale) for an autocatalytic takeoff. Gated only on
  // carrying chlorophyll (gateMask 0), exactly like out[3], so
  // autotrophy stays emergent from the genome's SYNTH_CHL.
  // rate -> 16 (matching aerobic respiration's throughput). In nature
  // photosynthesis is the dominant, SURPLUS-generating primary input --
  // a photoautotroph in light fixes far more energy than it needs. The
  // model had it inverted: photophosphorylation topped out near ~1.3
  // ATP/s (barely upkeep) while fuel-burning ran ~100x faster. At 16 a
  // typical photic cell (chl~0.68 -> ~0.34 of CHL_REF=2, light~0.7) nets
  // ~3.4 ATP/s -- a real surplus over the ~1.5/s upkeep -- and a cell
  // that invests in chlorophyll (-> chl/CHL_REF=1) gets the full ~10
  // ATP/s, so autotrophy stays emergent (chl still pays) but viable.
  // Self-limiting: output is capped by available ADP, so it can't run
  // away once the ATP pool fills.
  out[25] = mk([], [], [], [], +6, 16, { lightIn: 1, chlScale: true, surfaceScale: true });
}
