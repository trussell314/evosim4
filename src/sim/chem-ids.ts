// Chemical identity layer: the molecular pool shape, the locked
// chem-slot id space, and the slot/role count constants. Pure
// declarations -- no engine state, no rng, no table build -- so the
// reaction engine, regional field, creatures and serializer can all
// import ids/types without a value cycle back through sim.ts. The
// CHEMICALS table + LUTs (which depend on spawn ranking) stay in
// sim.ts for now and import from here.

// Per-cell molecular pool. ATP itself lives on the Creature as
// `energy`; every other named species in the chemistry lives here.
// All quantities are in the same mass units as reserves, so reactions
// are mass-conserving and cell volume is total mass.
export interface Molecules {
  adp: number;          // ATP's discharged form
  glucose: number;
  fattyAcid: number;
  aminoAcid: number;
  chlorophyll: number;
  enzyme: number;
  o2: number;
  co2: number;
  minerals: number;
  waste: number;
  mrna: number;
  biopolymer: number;
  membrane: number;
  // Photoreceptor band variants (visible / long-penetrating / depth-
  // invariant surface). Cells choose bands to invest in via the
  // unified SYNTH op; each band has its own activated chem.
  photoreceptorVisible: number;
  photoreceptorLong: number;
  photoreceptorSurface: number;
  activatedPhotoVisible: number;
  activatedPhotoLong: number;
  activatedPhotoSurface: number;
  // Retired CHEMO-branch receptor chems (the chemo gradient sense was
  // superseded by universal SENSE_OUT). Their ids/columns are being
  // REPURPOSED into the new sensory modalities (SENSES_PLAN.md) rather
  // than left inert: chemoreceptorFa(21)->phreceptor (pH/acidity sense).
  // The remaining biopolymer/minerals/marker0 slots are repurposed in
  // later modality commits (electric/vibration/light).
  electroreceptor: number;
  vibroreceptor: number;
  phreceptor: number; // ex-chemoreceptorFa (id 21): acidity receptor
  chemoreceptorMarker0: number;
  activatedElectroX: number;
  activatedElectroY: number;
  activatedVibX: number;
  activatedVibY: number;
  activatedPh: number; // ex-activatedChemoFaX (id 27): acidity signal (scalar)
  activatedChemoFaY: number; // dead spare (id 28), future repurpose

  activatedLightX: number;
  activatedLightY: number;
  // Mechano / thermo / magneto.
  mechanoreceptor: number;
  activatedMechX: number;
  activatedMechY: number;
  thermoreceptor: number;
  activatedThermo: number;
  magnetoreceptor: number;
  activatedMagX: number;
  activatedMagY: number;
  // Phase K ADHERE / REPAIR rework: chemistry-mediated bonding and
  // somatic-mutation suppression.
  bondChem: number;
  repairChem: number;
  // Identity markers (last so additions above don't shift their ids).
  marker0: number;
  marker1: number;
  marker2: number;
  marker3: number;
  // ATP. Path 1: ATP is now a first-class chemical (was the
  // per-creature `energy` scalar). It is mass-conserved like every
  // other molecule and participates in the chem machinery (transport
  // / reactions). The Creature.energy accessor + store.energy array
  // are aliased onto this column, so all existing energy code paths
  // are unchanged. Appended last (named id 45) so chems 0..44 keep
  // their ids and the genome ABI (%CHEMICAL_COUNT) is unchanged.
  atp: number;
}

export const MOLECULE_IDS: ReadonlyArray<keyof Molecules> = [
  "adp", "glucose", "fattyAcid", "aminoAcid", "chlorophyll", "enzyme",
  "o2", "co2", "minerals", "waste", "mrna",
  "biopolymer", "membrane",
  "photoreceptorVisible", "photoreceptorLong", "photoreceptorSurface",
  "activatedPhotoVisible", "activatedPhotoLong", "activatedPhotoSurface",
  "electroreceptor", "vibroreceptor", "phreceptor", "chemoreceptorMarker0",
  "activatedElectroX", "activatedElectroY",
  "activatedVibX", "activatedVibY",
  "activatedPh", "activatedChemoFaY",
  "activatedLightX", "activatedLightY",
  "mechanoreceptor", "activatedMechX", "activatedMechY",
  "thermoreceptor", "activatedThermo",
  "magnetoreceptor", "activatedMagX", "activatedMagY",
  "bondChem", "repairChem",
  "marker0", "marker1", "marker2", "marker3",
  "atp",
];

export function emptyMolecules(): Molecules {
  // Build from MOLECULE_IDS so adding a new entry above auto-zero-
  // initializes here. Cheap (one allocation per call); used mostly
  // by snapshots / death release / test scaffolds.
  const m = {} as Molecules;
  for (const k of MOLECULE_IDS) (m as unknown as Record<string, number>)[k] = 0;
  return m;
}

// String key -> index in MOLECULE_IDS array. Maps between named chem
// ids and Molecules field positions.
export const MOLECULE_INDEX: Record<keyof Molecules, number> =
  {} as Record<keyof Molecules, number>;
for (let i = 0; i < MOLECULE_IDS.length; i++) MOLECULE_INDEX[MOLECULE_IDS[i]] = i;

export const CHEMICAL_COUNT = 96;
export const NAMED_CHEMICAL_COUNT = 46;
// Order maps to chemCols[0..NAMED_CHEMICAL_COUNT-1]. The CHEM_* slot
// constants below MUST match this order; see CHEMISTRY_OVERHAUL.md
// phase K for the locked layout.
export const NAMED_CHEMICALS: ReadonlyArray<keyof Molecules> = [
  "o2", "co2", "glucose", "aminoAcid", "fattyAcid", "minerals", "adp",
  "waste", "chlorophyll", "enzyme", "mrna",
  "biopolymer", "membrane",
  "photoreceptorVisible", "photoreceptorLong", "photoreceptorSurface",
  "activatedPhotoVisible", "activatedPhotoLong", "activatedPhotoSurface",
  "electroreceptor", "vibroreceptor", "phreceptor", "chemoreceptorMarker0",
  "activatedElectroX", "activatedElectroY",
  "activatedVibX", "activatedVibY",
  "activatedPh", "activatedChemoFaY",
  "activatedLightX", "activatedLightY",
  "mechanoreceptor", "activatedMechX", "activatedMechY",
  "thermoreceptor", "activatedThermo",
  "magnetoreceptor", "activatedMagX", "activatedMagY",
  "bondChem", "repairChem",
  "marker0", "marker1", "marker2", "marker3",
  "atp",
];

// Slot indices for special handling (engine-managed ATP/ADP, etc.).
export const CHEM_O2 = 0;
export const CHEM_CO2 = 1;
export const CHEM_GLU = 2;
export const CHEM_AA = 3;
export const CHEM_FA = 4;
export const CHEM_MIN = 5;
export const CHEM_ADP = 6;
export const CHEM_WASTE = 7;
// chlorophyll, enzyme, mrna have specific roles as rate multipliers:
//   chl   -> photosynth (mandatory: no chl -> no photosynth)
//   ribo  -> all biosynth reactions (mandatory: no ribo -> no biosynth)
//   enz   -> catabolize (mandatory: no enz -> no digestion of biopolymer)
export const CHEM_CHL = 8;
export const CHEM_ENZ = 9;
export const CHEM_MRNA = 10;
export const CHEM_BIOPOLYMER = 11;
export const CHEM_MEMBRANE = 12;
// Phase K-1 layout: receptors split into band / per-target variants,
// each with paired activated chems. Order matches NAMED_CHEMICALS.
export const CHEM_PHOTORECEPTOR_VISIBLE = 13;
export const CHEM_PHOTORECEPTOR_LONG = 14;
export const CHEM_PHOTORECEPTOR_SURFACE = 15;
export const CHEM_ACT_PHOTO_VISIBLE = 16;
export const CHEM_ACT_PHOTO_LONG = 17;
export const CHEM_ACT_PHOTO_SURFACE = 18;
export const CHEM_ELECTRORECEPTOR = 19;
export const CHEM_VIBRORECEPTOR = 20;
export const CHEM_PHRECEPTOR = 21; // ex-CHEM_CHEMORECEPTOR_FA: acidity receptor
export const CHEM_CHEMORECEPTOR_MARKER0 = 22;
export const CHEM_ACT_ELECTRO_X = 23;
export const CHEM_ACT_ELECTRO_Y = 24;
export const CHEM_ACT_VIB_X = 25;
export const CHEM_ACT_VIB_Y = 26;
export const CHEM_ACT_PH = 27; // ex-CHEM_ACT_CHEMO_FA_X: acidity signal (scalar)
export const CHEM_ACT_CHEMO_FA_Y = 28;
export const CHEM_ACT_LIGHT_X = 29;
export const CHEM_ACT_LIGHT_Y = 30;
export const CHEM_MECHANORECEPTOR = 31;
export const CHEM_ACT_MECH_X = 32;
export const CHEM_ACT_MECH_Y = 33;
export const CHEM_THERMORECEPTOR = 34;
export const CHEM_ACT_THERMO = 35;
export const CHEM_MAGNETORECEPTOR = 36;
export const CHEM_ACT_MAG_X = 37;
export const CHEM_ACT_MAG_Y = 38;
export const CHEM_BOND = 39;
export const CHEM_REPAIR = 40;
export const CHEM_MARKER0 = 41;
// Markers occupy 41..44; marker0 has a constant since the
// chemoreceptor system targets it specifically.
// ATP: named id 45 (appended after markers; first ex-generic slot).
// CHEMICAL_COUNT stays 96 so the genome ABI is unchanged.
export const CHEM_ATP = 45;
export const MRNA_REF = 5;
// Lowered 5 -> 2: photosynthesis + photophosphorylation scale by
// min(1, chl/CHL_REF), and a fresh founder seeds only chl=1, so at
// CHL_REF=5 it ran light-harvesting at 20% -- too little ATP to afford
// building more chlorophyll (synth_chl costs -8 ATP), a bootstrap
// deadlock that left <0.1% of cells able to ignite autotrophy. At 2 the
// seed chl=1 drives 50% light-harvesting (~8x more cells ignite), while
// reaching full rate still requires investing in chl (SYNTH_CHL), so
// autotrophy stays an evolved trait -- just a reachable one. (Note: this
// broadens ignition but does NOT by itself make the world self-
// sustaining; seedless descendants still rarely reach the reproduce
// threshold -- see the founder-subsidy finding.)
export const CHL_REF = 2;
export const ENZ_REF = 5;
export const GENERIC_CHEMICAL_COUNT = CHEMICAL_COUNT - NAMED_CHEMICAL_COUNT;

// CHEM_NAMED_MOL_IDX[k] = molCols index of the named chemical at
// chemCols[k]. Resolved against MOLECULE_INDEX (populated above).
export const CHEM_NAMED_MOL_IDX: number[] = NAMED_CHEMICALS.map((n) => MOLECULE_INDEX[n]);
