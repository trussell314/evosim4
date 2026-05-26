// Regional dissolved/reserve system -- foundational layer: the region
// grid geometry, the molar-solubility -> particle-equivalent dissolved
// capacity model, and the world temperature baseline those formulas key
// off. State-bearing field stepping (temperature diffusion, ambient /
// reserve diffusion) builds on these and currently lives in sim.ts.
//
// Pure functions of world dimensions + chem tables; no RNG, no
// module-level mutable state. The solubility tables build once at import
// from the (already-initialized) chemistry module.

import {
  CHEMICAL_COUNT, NAMED_CHEMICAL_COUNT,
  CHEM_O2, CHEM_CO2, CHEM_GLU, CHEM_AA, CHEM_FA, CHEM_MIN, CHEM_ADP,
  CHEM_WASTE, CHEM_CHL, CHEM_ENZ, CHEM_MRNA, CHEM_BIOPOLYMER, CHEM_MEMBRANE,
} from "./chem-ids";
import { CHEMICALS, CHEM_BASE_DENSITY } from "./chemistry";
import type { World } from "./core";
import { temperatureAt } from "./environment";
import { pointInPolygon } from "./terrain";

// World temperature baseline. activated_thermo encodes departure from
// this; the solubility temperature factor is identity here so a baseline
// world is unchanged.
export const TEMP_BASELINE = 15; // °C

// 50x50 px region footprint; a region is a 50x50x world.depth box.
// "Someday adjustable" -- keep all region math derived from this.
export const REGION_PX = 50;
// The whole vertical extent of the world maps to 10 m. Scale is
// isotropic (x, y, z all use this) and used ONLY to turn px volumes
// into litres for the molar-solubility capacity formula and to
// calibrate diffusion rate. Zero impact on rendering / dynamics.
const WORLD_HEIGHT_METERS = 10;
function metersPerPx(world: { height: number }): number {
  return WORLD_HEIGHT_METERS / world.height;
}
export function regionCols(world: { width: number }): number {
  return Math.max(1, Math.ceil(world.width / REGION_PX));
}
export function regionRows(world: { height: number }): number {
  return Math.max(1, Math.ceil(world.height / REGION_PX));
}
// Region volume in litres: (50px x 50px x depth-px) cubed via the
// 10 m scale, * 1000 L/m^3.
export function regionVolumeL(world: { height: number; depth: number }): number {
  const m = metersPerPx(world);
  const volM3 = (REGION_PX * m) * (REGION_PX * m) * (world.depth * m);
  return volM3 * 1000;
}

// Avogadro. Capacity is expressed in particle-equivalents:
//   capacity = S_molar[mol/L] * f_T(T) * V_region[L] * N_A / M
// M = real molecules represented by one sim particle. It's the single
// fitted knob; chosen so insoluble food chems (biopolymer/minerals/
// fattyAcid) get <1 particle-equivalent capacity (they stay
// particulate / edible) while soluble byproducts (glucose/aminoAcid/
// waste/adp) and gases get large capacity (they dissolve into the
// regional field). See the calibration test in sim.test.ts.
const AVOGADRO = 6.022e23;
const PARTICLE_MOLECULE_MULTIPLIER = 2e22;

// Realistic-ish molar solubilities (mol/L) for the 13 bootstrap
// chems. Absolute values are loose; the ORDERING + relative spread
// is what drives behavior, and M absorbs the global scale. Receptors,
// signals and procedural generics keep their existing per-chem
// solubility roll reinterpreted as mol/L (plausibly-invented,
// deterministic).
const CHEM_MOLAR_SOLUBILITY = new Float32Array(CHEMICAL_COUNT);
for (let i = 0; i < CHEMICAL_COUNT; i++) CHEM_MOLAR_SOLUBILITY[i] = CHEMICALS[i].solubility;
CHEM_MOLAR_SOLUBILITY[CHEM_O2] = 1.3e-3;   // sparingly soluble gas
CHEM_MOLAR_SOLUBILITY[CHEM_CO2] = 3.3e-2;  // ~25x more soluble than O2
CHEM_MOLAR_SOLUBILITY[CHEM_GLU] = 5.0;     // sugar, freely soluble
CHEM_MOLAR_SOLUBILITY[CHEM_AA] = 3.0;      // soluble
CHEM_MOLAR_SOLUBILITY[CHEM_FA] = 1e-4;     // hydrophobic, ~insoluble
CHEM_MOLAR_SOLUBILITY[CHEM_MIN] = 1e-5;    // mineral, ~insoluble
CHEM_MOLAR_SOLUBILITY[CHEM_ADP] = 0.5;     // soluble
CHEM_MOLAR_SOLUBILITY[CHEM_WASTE] = 5.0;   // freely soluble
CHEM_MOLAR_SOLUBILITY[CHEM_CHL] = 1e-5;    // water-insoluble pigment
CHEM_MOLAR_SOLUBILITY[CHEM_ENZ] = 1e-3;    // colloidal protein, low
CHEM_MOLAR_SOLUBILITY[CHEM_MRNA] = 1e-3;   // nucleic, low
CHEM_MOLAR_SOLUBILITY[CHEM_BIOPOLYMER] = 1e-6; // structural, insoluble
CHEM_MOLAR_SOLUBILITY[CHEM_MEMBRANE] = 1e-7;   // lipid, insoluble
// Procedural generics rolled their solubility on a 0.01..5 "mol/L"
// scale that was never calibrated against the N_A/M * V capacity
// formula -- at that scale every generic is effectively infinitely
// soluble (capacity dwarfs the whole particle budget, so they all
// dissolve and almost none ever render). Scale the generic block down
// into the same realistic band the bootstrap food chems sit in. The
// relative spread between generics is preserved; only the absolute
// magnitude shifts, so a few stay mildly soluble and most behave as
// particulate matter.
const GENERIC_SOLUBILITY_SCALE = 1e-3;
for (let i = NAMED_CHEMICAL_COUNT; i < CHEMICAL_COUNT; i++) {
  CHEM_MOLAR_SOLUBILITY[i] *= GENERIC_SOLUBILITY_SCALE;
}

// Temperature factor on solubility. Gases get LESS soluble warm
// (inverse, Henry's law); condensed phases get MORE soluble warm
// (direct). Small slope; identity at TEMP_BASELINE so a baseline
// world is unchanged.
function solubilityTempFactor(chemId: number, tempC: number): number {
  const dRel = (tempC - TEMP_BASELINE) / TEMP_BASELINE;
  const gas = CHEMICALS[chemId].defaultPhase === "gas";
  const k = 0.4;
  const f = gas ? 1 - k * dRel : 1 + k * dRel;
  return f < 0.05 ? 0.05 : f > 3 ? 3 : f;
}

// Dissolved capacity of a region for a chem, in particle-equivalents.
export function regionDissolvedCapacity(
  chemId: number, world: { height: number; depth: number }, tempC: number,
): number {
  const sMolar = CHEM_MOLAR_SOLUBILITY[chemId];
  if (sMolar <= 0) return 0;
  const vL = regionVolumeL(world);
  return sMolar * solubilityTempFactor(chemId, tempC) * vL * AVOGADRO
    / PARTICLE_MOLECULE_MULTIPLIER;
}

// Per-region temperature field. STATE-BEARING: each tick we diffuse
// heat between neighbouring regions, relax slowly toward the analytical
// baseline (depth gradient + patch wave from temperatureAt), and inject
// a Gaussian source from the active vent. This is what makes vent heat
// linger and spread instead of stamping a fixed bubble that disappears
// the moment the eruption ends. Consumed by chemistry (dissolution
// capacity, region dissolve thresholds), creature reads (Q10, THERMO
// receptor), and the heatmap overlay.
//
// Time constants in 1/sec. DIFF spreads local hot spots; RELAX pulls
// each region back toward its analytical equilibrium -- and is the
// distributed heat SINK that keeps the bulk water at its depth-gradient
// baseline no matter how hard the vent injects (so a hotter vent can't
// boil the whole world, only its local zone). VENT_INJECT sets how fast
// the local peak builds.
//
// The vent is an ALWAYS-ON heat source: a persistent base intensity
// (VENT_BASE_INTENSITY) keeps a standing hot zone around the mouth at
// all times, and an eruption envelope spikes on top. RELAX is slow
// enough that the zone lingers rather than dissipating the moment the
// puff ends.
const TEMP_DIFF_RATE = 0.35;
const TEMP_RELAX_RATE = 0.1;
const TEMP_VENT_INJECT_RATE = 0.15;
const VENT_TEMP_PEAK_AMP = 100;
const VENT_TEMP_RADIUS_PX = 95;
// Standing heat the vent emits between eruptions (fraction of full
// intensity). Eruptions ramp from this base up to 1 and back. Exported
// so the renderer animates the persistent plume off the same value.
export const VENT_BASE_INTENSITY = 0.4;
export function sampleRegionTemps(world: World, dt: number): void {
  const cols = regionCols(world);
  const rows = regionRows(world);
  const n = cols * rows;
  // First call, or dims changed: allocate world.regionTemp and seed
  // with the analytical baseline. Skip the stepping for this tick --
  // the field has no history yet.
  if (world.regionTemp.length !== n) {
    world.regionTemp = new Float32Array(n);
    world.regionTempNext = new Float32Array(n);
    for (let ry = 0; ry < rows; ry++) {
      const cy = Math.min(world.height - 1, ry * REGION_PX + REGION_PX / 2);
      for (let rx = 0; rx < cols; rx++) {
        const cx = Math.min(world.width - 1, rx * REGION_PX + REGION_PX / 2);
        world.regionTemp[ry * cols + rx] = temperatureAt(world, cx, cy);
      }
    }
    return;
  }
  const cur = world.regionTemp;
  const next = world.regionTempNext;
  const v = world.vent;
  const hasVent = v != null;
  const vx = hasVent ? v!.x : 0;
  const vy = hasVent ? v!.y : 0;
  // Always-on heat: persistent base + the eruption envelope on top.
  const eruptI = hasVent && v!.active ? v!.intensity : 0;
  const vIntensity = hasVent
    ? VENT_BASE_INTENSITY + (1 - VENT_BASE_INTENSITY) * eruptI
    : 0;
  const r2 = VENT_TEMP_RADIUS_PX * VENT_TEMP_RADIUS_PX;
  const rejectR2 = 9 * r2;
  for (let ry = 0; ry < rows; ry++) {
    const cy = Math.min(world.height - 1, ry * REGION_PX + REGION_PX / 2);
    const rowBase = ry * cols;
    for (let rx = 0; rx < cols; rx++) {
      const i = rowBase + rx;
      const T = cur[i];
      // 4-neighbour Laplacian (Neumann BC: edges use available
      // neighbours only). Stored as the avg-vs-self difference so the
      // rate constant is wall-time independent of cell size.
      let nsum = 0, ncount = 0;
      if (rx > 0)        { nsum += cur[i - 1];    ncount++; }
      if (rx < cols - 1) { nsum += cur[i + 1];    ncount++; }
      if (ry > 0)        { nsum += cur[i - cols]; ncount++; }
      if (ry < rows - 1) { nsum += cur[i + cols]; ncount++; }
      const diff = ncount > 0 ? (nsum / ncount - T) * TEMP_DIFF_RATE * dt : 0;
      // Relax toward analytical baseline (depth gradient + patch wave;
      // NOT vent -- that's the source term below).
      const cx = Math.min(world.width - 1, rx * REGION_PX + REGION_PX / 2);
      const eq = temperatureAt(world, cx, cy);
      const relax = (eq - T) * TEMP_RELAX_RATE * dt;
      // Vent source: Gaussian bubble * intensity, injected as a rate.
      let vent = 0;
      if (hasVent) {
        const dx2 = (cx - vx) * (cx - vx);
        const dy2 = (cy - vy) * (cy - vy);
        const d2 = dx2 + dy2;
        if (d2 < rejectR2) {
          vent = VENT_TEMP_PEAK_AMP * vIntensity * Math.exp(-d2 / r2)
            * TEMP_VENT_INJECT_RATE * dt;
        }
      }
      next[i] = T + diff + relax + vent;
    }
  }
  // Copy back into world.regionTemp; the swap-by-reference would
  // change Float32Array identity, and any caller that captured the
  // array reference (snapshot serializer, parallel workers) expects
  // it to stay stable.
  for (let i = 0; i < n; i++) cur[i] = next[i];
}

// Effective local temperature: reads from the diffused, state-bearing
// regionTemp field on the world (which sampleRegionTemps steps every
// tick). Falls back to the analytical baseline if the field hasn't
// been initialised yet (e.g. a freshly-built world before its first
// tick).
export function regionTempAt(world: World, x: number, y: number): number {
  const field = world.regionTemp;
  if (!field || field.length === 0) return temperatureAt(world, x, y);
  const cols = regionCols(world);
  const rows = regionRows(world);
  let rx = (x / REGION_PX) | 0; if (rx < 0) rx = 0; else if (rx >= cols) rx = cols - 1;
  let ry = (y / REGION_PX) | 0; if (ry < 0) ry = 0; else if (ry >= rows) ry = rows - 1;
  return field[ry * cols + rx];
}

// Atmosphere<->dissolved equilibrium target. ONLY the gases: water
// in contact with air equilibrates dissolved O2/CO2 toward these
// (Henry's-law-ish), the rate driven by aerateAmbient(). The old
// aa/min "primordial soup" floors were retired -- with the regional
// reserve + founders drawing from reserve, every chemical now enters
// solely as particles, so seeding the dissolved field with aa/min
// from nowhere is both redundant and inconsistent with that model.
export const AMBIENT_TARGET = new Float32Array(CHEMICAL_COUNT);
AMBIENT_TARGET[CHEM_O2] = 12;   // matches the old O2_AMBIENT constant
AMBIENT_TARGET[CHEM_CO2] = 1;   // matches CO2_AMBIENT

export function initialAmbient(width: number, height: number): Float32Array {
  // Regional dissolved field: every region's block starts at the
  // equilibrium target (per-region seed of the aa/min/O2/CO2 floors)
  // so the first ticks aren't dominated by ambient transients.
  const cols = Math.max(1, Math.ceil(width / REGION_PX));
  const rows = Math.max(1, Math.ceil(height / REGION_PX));
  const a = new Float32Array(cols * rows * CHEMICAL_COUNT);
  for (let r = 0; r < cols * rows; r++) {
    const b = r * CHEMICAL_COUNT;
    for (let k = 0; k < CHEMICAL_COUNT; k++) a[b + k] = AMBIENT_TARGET[k];
  }
  return a;
}

export function regionIndexAt(world: { width: number; height: number }, x: number, y: number): number {
  const cols = regionCols(world);
  let rx = (x / REGION_PX) | 0; if (rx < 0) rx = 0; else if (rx >= cols) rx = cols - 1;
  const rows = regionRows(world);
  let ry = (y / REGION_PX) | 0; if (ry < 0) ry = 0; else if (ry >= rows) ry = rows - 1;
  return ry * cols + rx;
}

// ---- Phase 1: regional dissolved field -------------------------
// world.ambient is now a flat [region * CHEMICAL_COUNT + chem] grid
// instead of a single global scalar vector. Every dissolve / cell-
// diffusion / aeration event acts on the LOCAL region's block, and a
// slow Jacobi pass diffuses dissolved mass between regions.
export const AMBIENT_STRIDE = CHEMICAL_COUNT;
export function ambientBaseAt(world: { width: number; height: number }, x: number, y: number): number {
  return regionIndexAt(world, x, y) * AMBIENT_STRIDE;
}
// Per-neighbour Jacobi exchange fraction giving a ~2-minute
// half-life for the longest-wavelength (domain-spanning) gradient,
// derived from the region-grid extent. Recomputed per call (cheap)
// so it adapts to world size; clamped well under the 2-D explicit
// stability limit (sum of 4 edge coeffs < 0.5).
// Lowered 600 -> 120: at 600s the surface->floor O2 gradient took ~10
// min to half-equilibrate -- longer than a cell lives -- so the deep
// water stayed anoxic and the aphotic zone was an energy desert (no
// O2 for betaOx/respiration, no light for photophosphorylation), which
// killed the majority of cells that spawn below the photic layer.
// Lowered 120 -> 60: rock now occludes light (caves/overhangs can't
// photosynthesize), so shaded + deep water depends entirely on O2 mixed
// in from the lit surface for respiration. Faster vertical/lateral
// mixing keeps those zones habitable.
const REGION_DIFFUSION_HALFLIFE_S = 60;
let REGION_DIFF_SCRATCH = new Float32Array(0);

// Per-region solid mask: 1 if the region center sits inside rock.
// Dissolved fields (ambient gases + reserve) can't diffuse through rock,
// so solid regions are no-flux barriers -- caves/overhangs become
// chemically isolated micro-environments. Cached per world (terrain is
// static after generation); rebuilt on region-grid resize. Mass-safe:
// skipping a barrier exchange moves no mass, and solid regions hold ~0
// (cells/particles are evacuated from rock) but any trapped mass still
// counts toward conservation.
const REGION_SOLID_CACHE = new WeakMap<World, Uint8Array>();
export function regionSolidMask(world: World): Uint8Array {
  const cols = regionCols(world), rows = regionRows(world);
  const n = cols * rows;
  const cached = REGION_SOLID_CACHE.get(world);
  if (cached && cached.length === n) return cached;
  const mask = new Uint8Array(n);
  const obs = world.obstacles;
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const cx = rx * REGION_PX + REGION_PX / 2;
      const cy = ry * REGION_PX + REGION_PX / 2;
      for (let k = 0; k < obs.length; k++) {
        const ob = obs[k];
        if (cx < ob.minX || cx > ob.maxX || cy < ob.minY || cy > ob.maxY) continue;
        const poly = ob.polygon;
        if (poly && pointInPolygon(cx, cy, poly)) { mask[ry * cols + rx] = 1; break; }
      }
    }
  }
  REGION_SOLID_CACHE.set(world, mask);
  return mask;
}

// Region base (AMBIENT_STRIDE index) for depositing dissolved mass at
// (x,y), redirected OUT of rock: the no-flux barrier would otherwise
// trap any mass deposited in a solid region forever, slowly draining the
// living water into inert rock. If the target region is solid, return
// the nearest non-solid region instead. Non-rock positions take the fast
// path and are byte-identical to regionIndexAt()*AMBIENT_STRIDE.
export function depositRegionBase(world: World, x: number, y: number): number {
  const ri = regionIndexAt(world, x, y);
  const solid = regionSolidMask(world);
  if (!solid[ri]) return ri * AMBIENT_STRIDE;
  const cols = regionCols(world), rows = regionRows(world);
  const rx = ri % cols, ry = (ri / cols) | 0;
  const maxR = Math.max(cols, rows);
  for (let radius = 1; radius < maxR; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      const ny = ry + dy; if (ny < 0 || ny >= rows) continue;
      const edgeY = Math.abs(dy) === radius;
      for (let dx = -radius; dx <= radius; dx++) {
        if (!edgeY && Math.abs(dx) !== radius) continue; // ring perimeter only
        const nx = rx + dx; if (nx < 0 || nx >= cols) continue;
        const ni = ny * cols + nx;
        if (!solid[ni]) return ni * AMBIENT_STRIDE;
      }
    }
  }
  return ri * AMBIENT_STRIDE; // fully solid world -> nowhere to redirect
}
export function diffuseRegions(world: World, dt: number): void {
  // The DISSOLVED field is a true aqueous solute -> isotropic Jacobi
  // diffusion. The reserve pool diffuses too now, but anisotropically:
  // horizontally both ways for everything, and vertically only in the
  // gravity-consistent direction per chem (dense sinks, buoyant rises)
  // -- see diffuseReserve().
  jacobiDiffuseField(world, world.ambient, dt);
}

// Buoyancy-neutral density. applyForces uses ay = g*(1 - 1/density),
// so density 1.0 neither sinks nor rises; >1 sinks, <1 floats. Reserve
// vertical transport keys off the same threshold.
const RESERVE_WATER_DENSITY = 1.0;
let RESERVE_DIFF_SCRATCH = new Float32Array(0);
// Reserve diffusion (Phase 4 revision -- reserve was previously inert):
//  1. left <-> right: symmetric Jacobi exchange for every chem.
//  2. density >= water: also drifts DOWN (settling) one-directionally.
//  3. density <= water: drifts UP (buoyant) one-directionally.
//  4. rate scaled by the mean temperature of the two regions.
// Vertical transfers are applied source-side only (every unit removed
// from a region is added to exactly one neighbour) so the pass is
// exactly mass-conserving. Uses a double buffer so it's order- and
// direction-independent (determinism).
export function diffuseReserve(world: World, dt: number): void {
  const res = world.reserve;
  const cols = regionCols(world);
  const rows = regionRows(world);
  const n = cols * rows;
  if (n < 2) return;
  if (RESERVE_DIFF_SCRATCH.length < res.length) {
    RESERVE_DIFF_SCRATCH = new Float32Array(res.length);
  }
  const old = RESERVE_DIFF_SCRATCH;
  old.set(res.subarray(0, n * AMBIENT_STRIDE));
  const N = Math.max(cols, rows);
  const ticks = REGION_DIFFUSION_HALFLIFE_S / dt;
  const wmode = Math.PI / N;
  let alpha = Math.LN2 / (ticks * wmode * wmode);
  if (alpha > 0.1) alpha = 0.1; // shared stability clamp
  const tempFactor = (ri: number, rj: number): number => {
    const tI = world.regionTemp.length > ri ? world.regionTemp[ri] : TEMP_BASELINE;
    const tJ = world.regionTemp.length > rj ? world.regionTemp[rj] : TEMP_BASELINE;
    let tf = 1 + 0.5 * (((tI + tJ) * 0.5 - TEMP_BASELINE) / TEMP_BASELINE);
    if (tf < 0.3) tf = 0.3; else if (tf > 2) tf = 2;
    return tf;
  };
  const solid = regionSolidMask(world);
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const ri = ry * cols + rx;
      if (solid[ri]) continue; // rock: no reserve exchange
      const base = ri * AMBIENT_STRIDE;
      const left = rx > 0 ? ri - 1 : -1;
      const right = rx < cols - 1 ? ri + 1 : -1;
      const up = ry > 0 ? ri - cols : -1;            // toward surface
      const down = ry < rows - 1 ? ri + cols : -1;   // toward floor
      // (1) Horizontal: symmetric Jacobi, every chem, both edges.
      for (let h = 0; h < 2; h++) {
        const nj = h === 0 ? left : right;
        if (nj < 0 || solid[nj]) continue;
        const a = alpha * tempFactor(ri, nj);
        const jb = nj * AMBIENT_STRIDE;
        for (let k = 0; k < AMBIENT_STRIDE; k++) {
          const oi = old[base + k];
          const oj = old[jb + k];
          if (oi !== oj) res[base + k] += a * (oj - oi);
        }
      }
      // (2) Dense chems settle one region DOWN.
      if (down >= 0 && !solid[down]) {
        const a = alpha * tempFactor(ri, down);
        const db = down * AMBIENT_STRIDE;
        for (let k = 0; k < AMBIENT_STRIDE; k++) {
          const d = CHEM_BASE_DENSITY[k] > 0 ? CHEM_BASE_DENSITY[k] : 1;
          if (d < RESERVE_WATER_DENSITY) continue;
          const amt = a * old[base + k];
          if (amt > 0) { res[base + k] -= amt; res[db + k] += amt; }
        }
      }
      // (3) Buoyant chems rise one region UP.
      if (up >= 0 && !solid[up]) {
        const a = alpha * tempFactor(ri, up);
        const ub = up * AMBIENT_STRIDE;
        for (let k = 0; k < AMBIENT_STRIDE; k++) {
          const d = CHEM_BASE_DENSITY[k] > 0 ? CHEM_BASE_DENSITY[k] : 1;
          if (d > RESERVE_WATER_DENSITY) continue;
          const amt = a * old[base + k];
          if (amt > 0) { res[base + k] -= amt; res[ub + k] += amt; }
        }
      }
    }
  }
}
function jacobiDiffuseField(world: World, amb: Float32Array, dt: number): void {
  const cols = regionCols(world);
  const rows = regionRows(world);
  const n = cols * rows;
  if (n < 2) return;
  if (REGION_DIFF_SCRATCH.length < amb.length) REGION_DIFF_SCRATCH = new Float32Array(amb.length);
  const old = REGION_DIFF_SCRATCH;
  old.set(amb.subarray(0, n * AMBIENT_STRIDE));
  const N = Math.max(cols, rows);
  const ticks = REGION_DIFFUSION_HALFLIFE_S / dt;
  const wmode = Math.PI / N;
  // lambda = ln2/ticks ; alpha solves lambda = alpha*(pi/N)^2 (small-mode).
  let alpha = Math.LN2 / (ticks * wmode * wmode);
  if (alpha > 0.1) alpha = 0.1; // hard stability clamp
  const solid = regionSolidMask(world);
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const ri = ry * cols + rx;
      if (solid[ri]) continue; // rock: no dissolved-field exchange
      const base = ri * AMBIENT_STRIDE;
      // Edge-symmetric, temperature-scaled coefficient per neighbour
      // (avg T of the two regions) so the Jacobi pass stays exactly
      // mass-conserving even with a temperature gradient.
      const tI = world.regionTemp.length > ri ? world.regionTemp[ri] : TEMP_BASELINE;
      // up/down/left/right neighbour region indices (-1 = none)
      const nb0 = rx > 0 ? ri - 1 : -1;
      const nb1 = rx < cols - 1 ? ri + 1 : -1;
      const nb2 = ry > 0 ? ri - cols : -1;
      const nb3 = ry < rows - 1 ? ri + cols : -1;
      for (let pass = 0; pass < 4; pass++) {
        const nj = pass === 0 ? nb0 : pass === 1 ? nb1 : pass === 2 ? nb2 : nb3;
        if (nj < 0 || solid[nj]) continue;
        const tJ = world.regionTemp.length > nj ? world.regionTemp[nj] : TEMP_BASELINE;
        // warmer water mixes a bit faster; mild, clamped, symmetric.
        let tf = 1 + 0.5 * (((tI + tJ) * 0.5 - TEMP_BASELINE) / TEMP_BASELINE);
        if (tf < 0.3) tf = 0.3; else if (tf > 2) tf = 2;
        const a = alpha * tf;
        const jb = nj * AMBIENT_STRIDE;
        for (let k = 0; k < AMBIENT_STRIDE; k++) {
          const oi = old[base + k];
          const oj = old[jb + k];
          if (oi === oj) continue;
          amb[base + k] += a * (oj - oi);
        }
      }
    }
  }
}
