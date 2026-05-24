// Chemical property table + derived LUTs. Builds the 96-chem
// ChemicalDef table (named specs + deterministically-rolled generics)
// at import and exposes the hot-path lookup arrays. Pure: depends only
// on rng + the chem-id layer, so it has no cycle back through sim.ts.

import { mulberry32 } from "../rng";
import {
  NAMED_CHEMICALS, NAMED_CHEMICAL_COUNT, CHEMICAL_COUNT,
  GENERIC_CHEMICAL_COUNT,
  CHEM_MIN, CHEM_BIOPOLYMER, CHEM_FA, CHEM_O2, CHEM_CO2, CHEM_GLU,
} from "./chem-ids";

// Deterministic spawn-rarity ranking for the generic chems, shared by
// the chem-color ramp here and the particle spawn weights in sim.ts.
export const GENERIC_SPAWN_ORDER: number[] = (() => {
  const g: number[] = [];
  for (let k = NAMED_CHEMICAL_COUNT; k < CHEMICAL_COUNT; k++) g.push(k);
  const rng = mulberry32(0x5EED9A1C);
  for (let i = g.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = g[i]; g[i] = g[j]; g[j] = t;
  }
  return g; // g[rank] = chemId
})();
const GENERIC_SPAWN_RANK = (() => {
  const r = new Int32Array(CHEMICAL_COUNT);
  for (let rank = 0; rank < GENERIC_SPAWN_ORDER.length; rank++) r[GENERIC_SPAWN_ORDER[rank]] = rank;
  return r;
})();
// Gray (most-seeded) -> bright orange (rarest). t in [0,1].
function grayToOrange(t: number): string {
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const R = Math.round(128 + t * 127);
  const B = Math.round(128 - t * 128);
  const hex = (n: number): string => n.toString(16).padStart(2, "0");
  return `#${hex(R)}80${hex(B)}`;
}

export type ChemPhase = "solid" | "liquid" | "gas" | "aqueous";
export type ChemRole =
  | "none"
  | "energyCarrier"   // ATP-like: stores energy in chemical form
  | "energyEmpty"     // ADP-like: the discharged counterpart
  | "membrane"        // structural lipid bilayer
  | "mrna"            // catalyst proxy for biosynth (formerly "mrna")
  | "pigment"         // catalyst proxy for photosynthesis
  | "digester"        // catalyst proxy for catabolism
  | "marker";         // identity-only; no reactions consume it
export interface ChemicalDef {
  name: string;
  // Mass per unit reaction; conserved across reactions by the
  // procedural generator.
  molarMass: number;
  // Bulk density when condensed. Drives free-particle physics.
  density: number;
  defaultPhase: ChemPhase;
  // Saturation concentration in water (0 = insoluble).
  solubility: number;
  // Tendency to enter gas phase as temperature rises.
  vaporPressure: number;
  // Solid <-> liquid transition proxy.
  meltingPoint: number;
  // Passive membrane diffusion rate (0 = can't cross).
  permeability: number;
  // Stored chemical potential per unit mass -- the thermodynamic
  // ground truth: every generic reaction's atpDelta is derived from
  // it (Σ substrate potential − Σ product potential via
  // CHEM_BOND_POTENTIAL), so the system can't mint free energy.
  bondEnergy: number;
  role: ChemRole;
  color: string;
  // Signal chems are populated by the activation pass each tick rather
  // than transported through reactions; excluded from mass conservation.
  isSignal: boolean;
}

interface NamedChemSpec {
  molarMass: number;
  density: number;
  defaultPhase: ChemPhase;
  solubility: number;
  vaporPressure: number;
  meltingPoint: number;
  permeability: number;
  bondEnergy: number;
  role: ChemRole;
  color: string;
  isSignal: boolean;
}
// Helper templates for the bulk of the receptor / activated chems --
// they share most properties; only color varies meaningfully.
const RECEPTOR_BASE: Omit<NamedChemSpec, "color"> = {
  molarMass: 1.0, density: 1.1, defaultPhase: "aqueous", solubility: 0.2,
  vaporPressure: 0, meltingPoint: 60, permeability: 0, bondEnergy: 5,
  role: "none", isSignal: false,
};
const SIGNAL_BASE: Omit<NamedChemSpec, "color"> = {
  molarMass: 1.0, density: 1.0, defaultPhase: "aqueous", solubility: 0,
  vaporPressure: 0, meltingPoint: 100, permeability: 0, bondEnergy: 0,
  role: "none", isSignal: true,
};
// Order MUST match NAMED_CHEMICALS exactly.
const NAMED_CHEM_SPECS: ReadonlyArray<NamedChemSpec> = [
  /* o2     */ { molarMass: 1.0, density: 0.14, defaultPhase: "gas",     solubility: 0.5,  vaporPressure: 10, meltingPoint: -200, permeability: 1.0, bondEnergy: 0,    role: "none",      color: "#3fa9f5", isSignal: false },
  /* co2    */ { molarMass: 1.0, density: 0.20, defaultPhase: "gas",     solubility: 1.8,  vaporPressure: 9,  meltingPoint: -80,  permeability: 1.0, bondEnergy: 0,    role: "none",      color: "#c4d4e6", isSignal: false },
  /* glu    */ { molarMass: 1.0, density: 1.5,  defaultPhase: "aqueous", solubility: 4.0,  vaporPressure: 0,  meltingPoint: 150,  permeability: 0,    bondEnergy: 30,   role: "none",      color: "#dbe09c", isSignal: false },
  /* aa     */ { molarMass: 1.0, density: 1.2,  defaultPhase: "aqueous", solubility: 3.0,  vaporPressure: 0,  meltingPoint: 200,  permeability: 0.5, bondEnergy: 20,   role: "none",      color: "#c9c075", isSignal: false },
  /* fa     */ { molarMass: 1.0, density: 0.9,  defaultPhase: "liquid",  solubility: 0.1,  vaporPressure: 0,  meltingPoint: 40,   permeability: 0.3, bondEnergy: 80,   role: "none",      color: "#f0d264", isSignal: false },
  /* min    */ { molarMass: 1.0, density: 2.4,  defaultPhase: "solid",   solubility: 0.02, vaporPressure: 0,  meltingPoint: 1200, permeability: 0.1, bondEnergy: 0,    role: "none",      color: "#8c8175", isSignal: false },
  /* adp    */ { molarMass: 1.0, density: 1.0,  defaultPhase: "aqueous", solubility: 3.0,  vaporPressure: 0,  meltingPoint: 200,  permeability: 0.5, bondEnergy: 0,    role: "energyEmpty", color: "#a8d8ea", isSignal: false },
  /* waste  */ { molarMass: 1.0, density: 1.0,  defaultPhase: "aqueous", solubility: 4.0,  vaporPressure: 0,  meltingPoint: 100,  permeability: 0.6, bondEnergy: 2,    role: "none",      color: "#a89878", isSignal: false },
  /* chl    */ { molarMass: 1.0, density: 1.1,  defaultPhase: "aqueous", solubility: 0.2,  vaporPressure: 0,  meltingPoint: 200,  permeability: 0,   bondEnergy: 5,    role: "pigment",   color: "#5fa850", isSignal: false },
  /* enz    */ { molarMass: 1.0, density: 1.1,  defaultPhase: "aqueous", solubility: 0.5,  vaporPressure: 0,  meltingPoint: 90,   permeability: 0,   bondEnergy: 5,    role: "digester",  color: "#e0a070", isSignal: false },
  /* mrna   */ { molarMass: 1.0, density: 1.1,  defaultPhase: "aqueous", solubility: 0.3,  vaporPressure: 0,  meltingPoint: 70,   permeability: 0,   bondEnergy: 5,    role: "mrna",      color: "#c8a4dc", isSignal: false },
  /* biop   */ { molarMass: 1.0, density: 1.05, defaultPhase: "solid",   solubility: 0.05, vaporPressure: 0,  meltingPoint: 250,  permeability: 0,   bondEnergy: 25,   role: "none",      color: "#7fb069", isSignal: false },
  /* memb   */ { molarMass: 1.0, density: 0.8,  defaultPhase: "liquid",  solubility: 0.01, vaporPressure: 0,  meltingPoint: 50,   permeability: 0,   bondEnergy: 40,   role: "membrane",  color: "#f0d264", isSignal: false },
  /* photoVisible  */ { ...RECEPTOR_BASE, color: "#d864c8" },
  /* photoLong     */ { ...RECEPTOR_BASE, color: "#b04ca0" },
  /* photoSurface  */ { ...RECEPTOR_BASE, color: "#e890d0" },
  /* actPhotoVis   */ { ...SIGNAL_BASE,   color: "#f0c0e8" },
  /* actPhotoLong  */ { ...SIGNAL_BASE,   color: "#c890c0" },
  /* actPhotoSurf  */ { ...SIGNAL_BASE,   color: "#ffe0f0" },
  /* electroreceptor*/ { ...RECEPTOR_BASE, color: "#f0e040" },
  /* chemoMin      */ { ...RECEPTOR_BASE, color: "#4ca0b0" },
  /* phreceptor    */ { ...RECEPTOR_BASE, color: "#a8d840" },
  /* chemoMark0    */ { ...RECEPTOR_BASE, color: "#a8ecf0" },
  /* actElectroX   */ { ...SIGNAL_BASE,   color: "#fff080" },
  /* actElectroY   */ { ...SIGNAL_BASE,   color: "#fff080" },
  /* actChemoMinX  */ { ...SIGNAL_BASE,   color: "#a0c0c8" },
  /* actChemoMinY  */ { ...SIGNAL_BASE,   color: "#a0c0c8" },
  /* activatedPh   */ { ...SIGNAL_BASE,   color: "#d0f088" },
  /* actChemoFaY   */ { ...SIGNAL_BASE,   color: "#d0f0f8" },
  /* actChemoMrkX  */ { ...SIGNAL_BASE,   color: "#e0f8fc" },
  /* actChemoMrkY  */ { ...SIGNAL_BASE,   color: "#e0f8fc" },
  /* mech          */ { ...RECEPTOR_BASE, color: "#c8d864" },
  /* actMechX      */ { ...SIGNAL_BASE,   color: "#e0e8a0" },
  /* actMechY      */ { ...SIGNAL_BASE,   color: "#e0e8a0" },
  /* thermo        */ { ...RECEPTOR_BASE, color: "#d8a064" },
  /* actThermo     */ { ...SIGNAL_BASE,   color: "#f0c890" },
  /* magneto       */ { ...RECEPTOR_BASE, color: "#9090d8" },
  /* actMagX       */ { ...SIGNAL_BASE,   color: "#b0b0e8" },
  /* actMagY       */ { ...SIGNAL_BASE,   color: "#b0b0e8" },
  /* bondChem      */ { molarMass: 1.0, density: 1.05, defaultPhase: "aqueous", solubility: 0.5, vaporPressure: 0, meltingPoint: 80, permeability: 0, bondEnergy: 8, role: "none", color: "#d8c0a0", isSignal: false },
  /* repairChem    */ { molarMass: 1.0, density: 1.1,  defaultPhase: "aqueous", solubility: 0.3, vaporPressure: 0, meltingPoint: 70, permeability: 0, bondEnergy: 8, role: "none", color: "#b0c0d8", isSignal: false },
  /* mark0  */ { molarMass: 1.0, density: 1.0,  defaultPhase: "aqueous", solubility: 4.0,  vaporPressure: 0,  meltingPoint: 100,  permeability: 0.5, bondEnergy: 5,    role: "marker",    color: "#e84a4a", isSignal: false },
  /* mark1  */ { molarMass: 1.0, density: 1.0,  defaultPhase: "aqueous", solubility: 4.0,  vaporPressure: 0,  meltingPoint: 100,  permeability: 0.5, bondEnergy: 5,    role: "marker",    color: "#4ae84a", isSignal: false },
  /* mark2  */ { molarMass: 1.0, density: 1.0,  defaultPhase: "aqueous", solubility: 4.0,  vaporPressure: 0,  meltingPoint: 100,  permeability: 0.5, bondEnergy: 5,    role: "marker",    color: "#4a4ae8", isSignal: false },
  /* mark3  */ { molarMass: 1.0, density: 1.0,  defaultPhase: "aqueous", solubility: 4.0,  vaporPressure: 0,  meltingPoint: 100,  permeability: 0.5, bondEnergy: 5,    role: "marker",    color: "#e8e84a", isSignal: false },
  // ATP (Path 1, named id 45). permeability 0: ATP does NOT passively
  // cross a membrane (no free bleed to ambient; no passive organelle
  // <->host) -- it moves only via the SYNTH'd ATP translocase (ANT,
  // Path 2). solubility 0 + not in GENERIC_SPAWN_ORDER => never a
  // free particle (energy stays intracellular). Mass-unit consistent.
  /* atp    */ { molarMass: 1.0, density: 1.0,  defaultPhase: "aqueous", solubility: 0.0,  vaporPressure: 0,  meltingPoint: 200,  permeability: 0,   bondEnergy: 0,    role: "none",      color: "#ffe066", isSignal: false },
];

function buildChemicalTable(): ChemicalDef[] {
  const out: ChemicalDef[] = [];
  for (let i = 0; i < NAMED_CHEMICALS.length; i++) {
    const spec = NAMED_CHEM_SPECS[i];
    out.push({ name: NAMED_CHEMICALS[i], ...spec });
  }
  // Procedural generics. Each property rolled deterministically so
  // reaction balance is stable across runs. Skew masses low; phase
  // distribution roughly 60% liquid/aqueous, 25% solid, 15% gas.
  const rng = mulberry32(0xC8E3_15CA);
  for (let i = NAMED_CHEMICAL_COUNT; i < CHEMICAL_COUNT; i++) {
    const u = rng();
    const molarMass = 0.5 + u * u * 4.5; // 0.5 .. 5.0, skewed low
    const phaseRoll = rng();
    const defaultPhase: ChemPhase =
      phaseRoll < 0.15 ? "gas" :
      phaseRoll < 0.40 ? "solid" :
      phaseRoll < 0.75 ? "liquid" : "aqueous";
    const density =
      defaultPhase === "gas" ? 0.1 + rng() * 0.3 :
      defaultPhase === "solid" ? 1.5 + rng() * 2.0 :
      defaultPhase === "liquid" ? 0.7 + rng() * 0.8 :
      0.9 + rng() * 0.4;
    const solBase = Math.exp(Math.log(0.01) + rng() * (Math.log(5) - Math.log(0.01)));
    const solubility =
      defaultPhase === "aqueous" ? Math.max(solBase, 0.5) :
      defaultPhase === "solid" ? solBase * 0.2 :
      solBase;
    const vaporPressure = defaultPhase === "gas" ? 5 + rng() * 8 : rng() * 2;
    const meltingPoint =
      defaultPhase === "solid" ? 200 + rng() * 1000 :
      defaultPhase === "gas" ? -200 + rng() * 100 :
      rng() * 200;
    const permBase = 1.0 / (1 + molarMass * 0.5);
    const permeability = defaultPhase === "solid" ? 0 : permBase * (0.4 + rng() * 0.6);
    const bondEnergy = (rng() < 0.2 ? 30 + rng() * 60 : rng() * 20);
    out.push({
      name: `c${i.toString(16).padStart(2, "0")}`,
      molarMass,
      density,
      defaultPhase,
      solubility,
      vaporPressure,
      meltingPoint,
      permeability,
      bondEnergy,
      role: "none",
      color: grayToOrange(GENERIC_SPAWN_RANK[i] / (GENERIC_CHEMICAL_COUNT - 1)),
      isSignal: false,
    });
  }
  return out;
}

export const CHEMICALS: ChemicalDef[] = buildChemicalTable();
// Per-chem density LUT. Hot loops reuse this to avoid a property
// dispatch on CHEMICALS[id] every particle.
export const CHEM_BASE_DENSITY = new Float32Array(CHEMICAL_COUNT);
for (let i = 0; i < CHEMICAL_COUNT; i++) CHEM_BASE_DENSITY[i] = CHEMICALS[i].density;
// Molar-mass LUT. Chemistry stores AMOUNT; physical mass = amount *
// molarMass. Every chem<->physical conversion uses this.
export const CHEM_MM = new Float32Array(CHEMICAL_COUNT);
for (let i = 0; i < CHEMICAL_COUNT; i++) CHEM_MM[i] = CHEMICALS[i].molarMass;
// Stored chemical potential of one count-unit of each chem, in ATP
// units (mass * bondEnergy * BOND_ENERGY_TO_ATP). Generic-reaction
// atpDelta = Σ substrate potential − Σ product potential, so a
// reaction and its exact reverse cancel and no cycle mints energy.
const BOND_ENERGY_TO_ATP = 0.012;
export const CHEM_BOND_POTENTIAL = new Float32Array(CHEMICAL_COUNT);
for (let i = 0; i < CHEMICAL_COUNT; i++) {
  CHEM_BOND_POTENTIAL[i] = CHEMICALS[i].molarMass * CHEMICALS[i].bondEnergy * BOND_ENERGY_TO_ATP;
}
// Color / name / molar-mass LUTs, indexed by chem id (renderer + HUD).
export const CHEM_COLORS: ReadonlyArray<string> = CHEMICALS.map((c) => c.color);
export const CHEM_NAMES: ReadonlyArray<string> = CHEMICALS.map((c) => c.name);
export const CHEM_MOLAR_MASS: ReadonlyArray<number> = CHEMICALS.map((c) => c.molarMass);
// Bootstrap chem id exports. Tests pin to this rather than literals.
export const CHEM_IDS = {
  o2: 0, co2: 1, glucose: 2, aminoAcid: 3, fattyAcid: 4, minerals: 5,
  adp: 6, waste: 7, chlorophyll: 8, enzyme: 9, mrna: 10,
  biopolymer: 11, membrane: 12,
  photoreceptorVisible: 13, photoreceptorLong: 14, photoreceptorSurface: 15,
  activatedPhotoVisible: 16, activatedPhotoLong: 17, activatedPhotoSurface: 18,
  electroreceptor: 19, chemoreceptorMinerals: 20,
  phreceptor: 21, chemoreceptorMarker0: 22,
  activatedElectroX: 23, activatedElectroY: 24,
  activatedChemoMineralsX: 25, activatedChemoMineralsY: 26,
  activatedPh: 27, activatedChemoFaY: 28,
  activatedChemoMarker0X: 29, activatedChemoMarker0Y: 30,
  mechanoreceptor: 31, activatedMechX: 32, activatedMechY: 33,
  thermoreceptor: 34, activatedThermo: 35,
  magnetoreceptor: 36, activatedMagX: 37, activatedMagY: 38,
  bondChem: 39, repairChem: 40,
  marker0: 41, marker1: 42, marker2: 43, marker3: 44,
} as const;

// SENSE_GRAD_X/Y/DENSITY ops index into 6 per-chem sensor bins. This
// picks WHICH 6 chems map to those legacy bins (operand 0 =
// sediment/mineral, 1 = bulk food, ...). Chems outside this list are
// invisible to gradient/density sensing; SENSE_CHEMICAL still reads
// the internal pool for any chem.
export const SENSOR_CHEMS: ReadonlyArray<number> = [
  CHEM_MIN, CHEM_BIOPOLYMER, CHEM_FA, CHEM_O2, CHEM_CO2, CHEM_GLU,
];
export const SENSOR_BIN_BY_CHEM = new Int8Array(CHEMICAL_COUNT);
SENSOR_BIN_BY_CHEM.fill(-1);
for (let i = 0; i < SENSOR_CHEMS.length; i++) SENSOR_BIN_BY_CHEM[SENSOR_CHEMS[i]] = i;
