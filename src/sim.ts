// Pure simulation. No DOM access.
//
// Units: pixels for length, seconds for time.
// World is "basically 2D" — a thin z-slice so particles can shift back/forth
// in depth and occasionally pass each other in z. Water density = 1.

import {
  type VMState,
  type VMSensors,
  type VMSelf,
  type VMOutputs,
  newVMState,
  newOutputs,
  runTick,
  makeRandomViableGenome,
  viableGenome,
  genomeSynthMask,
  mutateGenome,
  CATALYST_COUNT,
  N_REACTIONS,
  somaticMutateOnce,
  computeSenseRange,
  computeThrustAccel,
  MAX_GENOME_BYTES,
} from "./genome";

export type MaterialId =
  | "rock"
  | "sand"
  | "clay"
  | "organic"
  | "lipid"
  | "gas";

export interface Material {
  id: MaterialId;
  density: number;
  color: string;
}

export const MATERIALS: Record<MaterialId, Material> = {
  rock:    { id: "rock",    density: 2.6, color: "#5b4a3a" },
  sand:    { id: "sand",    density: 1.9, color: "#c9b074" },
  clay:    { id: "clay",    density: 1.4, color: "#8c8175" },
  organic: { id: "organic", density: 1.0, color: "#7fb069" },
  lipid:   { id: "lipid",   density: 0.7, color: "#f0d264" },
  gas:     { id: "gas",     density: 0.2, color: "#cfe2ff" },
};

const SEED_WEIGHTS: Array<[MaterialId, number]> = [
  ["rock",    1.0],
  ["sand",    3.0],
  ["clay",    3.5],
  ["organic", 4.5],
  ["lipid",   0.5],
  ["gas",     0.5],
];

const MATERIAL_IDS = Object.keys(MATERIALS) as MaterialId[];
// O(1) reverse lookup. Populated once at module load; the per-tick hot
// loops in updateCreatures and populateSensors used to call
// MATERIAL_IDS.indexOf(p.material) inside a loop over every particle for
// every cell -- tens of millions of string-array scans per second.
const MATERIAL_INDEX: Record<MaterialId, number> = {} as Record<MaterialId, number>;
for (let i = 0; i < MATERIAL_IDS.length; i++) MATERIAL_INDEX[MATERIAL_IDS[i]] = i;
// Flat Float32 lookup of material default density, indexed by the
// uint8 stored in ParticleStore.material[i]. Avoids a string-keyed
// dictionary lookup in the hot force loop.
const MATERIAL_BASE_DENSITY = new Float32Array(MATERIAL_IDS.length);
for (let i = 0; i < MATERIAL_IDS.length; i++) MATERIAL_BASE_DENSITY[i] = MATERIALS[MATERIAL_IDS[i]].density;

export interface ObstacleLobe {
  x: number; y: number; r: number;
}
export interface Obstacle {
  // Bounding box for cheap reject. minY in particular lets the
  // collision pass skip particles floating in the upper water column.
  minX: number; minY: number; maxX: number; maxY: number;
  // Lobes drive physics (circle-circle pushback). Cheap, robust.
  lobes: ObstacleLobe[];
  // Optional polygon outline for rendering. When present the renderer
  // draws straight-line edges with hard corners (rock-like) instead of
  // the lobe-circle union (which reads as cartoon bubbles). Crescent
  // sets this to undefined and is rendered as a lobe union.
  polygon?: { x: number; y: number }[];
  color: string;
  // Discrete depth layer (0..ROCK_Z_LAYERS-1). Rocks at different
  // layers don't interact during placement -- letting them visually
  // overlap simulates 3D depth on a 2D cross-section. Rendering
  // sorts by z descending so foreground rocks (low z) paint over
  // background rocks (high z).
  z: number;
}

// Particle storage as Struct-of-Arrays. All hot fields live in a
// ParticleStore as parallel typed arrays. Each Particle is a thin
// handle (idx + back-ref) whose property accessors index into the
// store. Hot loops that need maximum throughput can bypass the
// handle and read the typed arrays directly.
//
// Invariant: world.particles[i].idx === i. Splice / removeAt
// routines maintain this via swap-and-pop so iterating by array
// index is equivalent to iterating store slot by slot.
export class ParticleStore {
  cap = 0;
  n = 0;
  x = new Float32Array(0);
  y = new Float32Array(0);
  z = new Float32Array(0);
  vx = new Float32Array(0);
  vy = new Float32Array(0);
  vz = new Float32Array(0);
  r = new Float32Array(0);
  density = new Float32Array(0);   // 0 -> use MATERIALS[material].density
  material = new Uint8Array(0);    // index into MATERIAL_IDS
  quietTicks = new Int32Array(0);
  // Particle age in sim-seconds. Used by the decay pass: old particles
  // gradually lose mass (radius shrinks) and disappear once below a
  // minimum size. Models decomposition by unmodeled microbiota and
  // prevents corpse-spillage from autolysis from accumulating
  // indefinitely.
  age = new Float32Array(0);
  molecules: (Molecules | null)[] = [];
  constructor(initialCap = 256) { this.grow(initialCap); }
  grow(newCap: number): void {
    if (newCap <= this.cap) return;
    const old = this;
    const nx = new Float32Array(newCap); nx.set(old.x); this.x = nx;
    const ny = new Float32Array(newCap); ny.set(old.y); this.y = ny;
    const nz = new Float32Array(newCap); nz.set(old.z); this.z = nz;
    const nvx = new Float32Array(newCap); nvx.set(old.vx); this.vx = nvx;
    const nvy = new Float32Array(newCap); nvy.set(old.vy); this.vy = nvy;
    const nvz = new Float32Array(newCap); nvz.set(old.vz); this.vz = nvz;
    const nr = new Float32Array(newCap); nr.set(old.r); this.r = nr;
    const nd = new Float32Array(newCap); nd.set(old.density); this.density = nd;
    const nm = new Uint8Array(newCap); nm.set(old.material); this.material = nm;
    const nq = new Int32Array(newCap); nq.set(old.quietTicks); this.quietTicks = nq;
    const na = new Float32Array(newCap); na.set(old.age); this.age = na;
    while (this.molecules.length < newCap) this.molecules.push(null);
    this.cap = newCap;
  }
  // Append a slot with the given field values. Returns the new slot
  // index. Caller is responsible for keeping the world.particles
  // array in sync (push the handle to the world array).
  alloc(): number {
    if (this.n >= this.cap) this.grow(this.cap * 2 || 256);
    return this.n++;
  }
  // Swap-and-pop: copy slot `last` into slot `i`, decrement n. Caller
  // is responsible for updating the handle that lived at `last`.
  removeSwapPop(i: number): void {
    const last = this.n - 1;
    if (i !== last) {
      this.x[i] = this.x[last];
      this.y[i] = this.y[last];
      this.z[i] = this.z[last];
      this.vx[i] = this.vx[last];
      this.vy[i] = this.vy[last];
      this.vz[i] = this.vz[last];
      this.r[i] = this.r[last];
      this.density[i] = this.density[last];
      this.material[i] = this.material[last];
      this.quietTicks[i] = this.quietTicks[last];
      this.age[i] = this.age[last];
      this.molecules[i] = this.molecules[last];
    }
    this.molecules[last] = null;
    this.n--;
  }
}

// Handle class. Fields proxy into the owning ParticleStore by idx.
// JS engines inline these accessors well in practice. Code that
// already wrote `p.x` continues to work; hot loops that want the
// fast path should read store.x[i] directly.
export class Particle {
  idx: number;
  store: ParticleStore;
  constructor(store: ParticleStore, idx: number) { this.store = store; this.idx = idx; }
  get x(): number { return this.store.x[this.idx]; }
  set x(v: number) { this.store.x[this.idx] = v; }
  get y(): number { return this.store.y[this.idx]; }
  set y(v: number) { this.store.y[this.idx] = v; }
  get z(): number { return this.store.z[this.idx]; }
  set z(v: number) { this.store.z[this.idx] = v; }
  get vx(): number { return this.store.vx[this.idx]; }
  set vx(v: number) { this.store.vx[this.idx] = v; }
  get vy(): number { return this.store.vy[this.idx]; }
  set vy(v: number) { this.store.vy[this.idx] = v; }
  get vz(): number { return this.store.vz[this.idx]; }
  set vz(v: number) { this.store.vz[this.idx] = v; }
  get r(): number { return this.store.r[this.idx]; }
  set r(v: number) { this.store.r[this.idx] = v; }
  get density(): number | undefined {
    const d = this.store.density[this.idx];
    return d === 0 ? undefined : d;
  }
  set density(v: number | undefined) { this.store.density[this.idx] = v ?? 0; }
  get material(): MaterialId { return MATERIAL_IDS[this.store.material[this.idx]]; }
  set material(v: MaterialId) { this.store.material[this.idx] = MATERIAL_INDEX[v]; }
  get quietTicks(): number | undefined {
    const q = this.store.quietTicks[this.idx];
    return q === 0 ? undefined : q;
  }
  set quietTicks(v: number | undefined) { this.store.quietTicks[this.idx] = v ?? 0; }
  get molecules(): Molecules | undefined { return this.store.molecules[this.idx] ?? undefined; }
  set molecules(v: Molecules | undefined) { this.store.molecules[this.idx] = v ?? null; }
}

// Push a new particle to world.particles AND to the underlying store,
// maintaining the array-index == store-slot invariant. opts contains
// the literal field values just like the old object-literal sites.
export function pushParticle(
  world: World,
  opts: {
    x: number; y: number; z: number;
    vx: number; vy: number; vz: number;
    r: number;
    material: MaterialId;
    density?: number;
    molecules?: Molecules;
    quietTicks?: number;
  },
): Particle {
  const store = world.particleStore;
  const i = store.alloc();
  store.x[i] = opts.x;
  store.y[i] = opts.y;
  store.z[i] = opts.z;
  store.vx[i] = opts.vx;
  store.vy[i] = opts.vy;
  store.vz[i] = opts.vz;
  store.r[i] = opts.r;
  store.density[i] = opts.density ?? 0;
  store.material[i] = MATERIAL_INDEX[opts.material];
  store.quietTicks[i] = opts.quietTicks ?? 0;
  store.age[i] = 0;
  store.molecules[i] = opts.molecules ?? null;
  const h = new Particle(store, i);
  world.particles.push(h);
  return h;
}

// Remove a particle by its array index using swap-and-pop. Maintains
// the array-index == store-slot invariant by re-pointing the moved
// particle's handle at slot `arrIdx`.
export function removeParticleAt(world: World, arrIdx: number): void {
  const ps = world.particles;
  const store = world.particleStore;
  const last = ps.length - 1;
  if (arrIdx !== last) {
    store.removeSwapPop(arrIdx);
    ps[arrIdx] = ps[last];
    ps[arrIdx].idx = arrIdx;
  } else {
    store.removeSwapPop(arrIdx);
  }
  ps.pop();
}

// Legacy interface kept for type compatibility with code that still
// references `Particle` as a structural shape. The class above
// implements this shape via accessors.
export interface ParticleData {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  r: number;
  material: MaterialId;
  molecules?: Molecules;
  quietTicks?: number;
  density?: number;
}

// Creature storage as Struct-of-Arrays. Primitives + every molecule
// and reserve get their own typed-array column, sized by capacity and
// indexed by the creature's persistent `idx`. Slot allocation uses a
// free-list rather than swap-and-pop so handles to dead creatures
// still read consistent data through `releaseReservesAsParticles`.
//
// The `Creature` class is a thin handle whose primitive-field
// accessors index into the store. molecules and reserves are exposed
// via two helper classes (MoleculesView, ReservesView) that proxy
// their named fields into the right column.
export class CreatureStore {
  cap = 0;
  highWater = 0;
  free: number[] = [];
  // primitive position/velocity/shape
  x: Float32Array; y: Float32Array; z: Float32Array;
  vx: Float32Array; vy: Float32Array; vz: Float32Array;
  r: Float32Array; density: Float32Array;
  // metabolism / lifecycle
  energy: Float32Array;
  senseRange: Float32Array;
  thrustAccel: Float32Array;
  bornAt: Float32Array;
  ingestCooldown: Float32Array;
  repairTicks: Int32Array;
  // Total mechanical force on the cell this tick, recorded by
  // applyForces. Read by populateSensors to feed SENSE_PRESSURE_X/Y.
  // pressureY also gets a static depth term added before VM read.
  ax: Float32Array;
  ay: Float32Array;
  // molecule pools (parallel to MOLECULE_IDS order)
  m_glucose: Float32Array;
  m_fattyAcid: Float32Array;
  m_aminoAcid: Float32Array;
  m_minerals: Float32Array;
  m_chlorophyll: Float32Array;
  m_enzyme: Float32Array;
  m_o2: Float32Array;
  m_co2: Float32Array;
  m_biomass: Float32Array;
  m_waste: Float32Array;
  m_adp: Float32Array;
  m_ribosome: Float32Array;
  // reserves (parallel to MATERIAL_IDS order)
  r_rock: Float32Array;
  r_sand: Float32Array;
  r_clay: Float32Array;
  r_organic: Float32Array;
  r_lipid: Float32Array;
  r_gas: Float32Array;
  // Generic catalyst pool: one Float32Array per catalyst slot. Sized
  // to CATALYST_COUNT. Each catalyst k's pool multiplies its target
  // reaction's rate via (1 + pool/CAT_REF). Storage is array-of-
  // arrays (not a single 2D) so each slot has its own contiguous
  // typed array, matching the rest of the SoA layout.
  catalystCols!: Float32Array[];
  // Parallel arrays of column refs for indexed access in hot loops.
  // resCols[matIdx] -> r_<mat>; molCols[molKey] -> m_<key>. Initialized
  // once after the typed arrays exist.
  resCols!: Float32Array[];
  molCols!: Float32Array[];
  // Unified chemical pool addressed by the generic-reaction engine.
  // chemCols[0..7] alias molCols entries (the named chemicals) so a
  // write through either path hits the same Float32Array. chemCols
  // [8..63] are independent typed arrays for the abstract generic
  // chemicals (no Molecules key, no particle representation in
  // phase 1 -- they exist only as intracellular pools).
  chemCols!: Float32Array[];
  // Backing storage for the generic slice (chemCols[8..63]). Kept
  // separate so grow() can resize them without touching molCols.
  genericChemCols!: Float32Array[];
  // Surface fingerprint -- the cell's "phenotype on display" used for
  // contact recognition by ADHERE / ENGULF. Each cell's top 8
  // chemicals by mass are packed into a 64-bit set (two Uint32Arrays
  // because JS bitops are 32-bit). Refreshed once per tick.
  fpLo!: Uint32Array;
  fpHi!: Uint32Array;
  constructor(initialCap = 256) {
    const blank = new Float32Array(0);
    const blanki = new Int32Array(0);
    this.x = blank; this.y = blank; this.z = blank;
    this.vx = blank; this.vy = blank; this.vz = blank;
    this.r = blank; this.density = blank;
    this.energy = blank; this.senseRange = blank; this.thrustAccel = blank;
    this.bornAt = blank; this.ingestCooldown = blank; this.repairTicks = blanki;
    const blanku = new Uint32Array(0);
    this.fpLo = blanku; this.fpHi = blanku;
    this.ax = blank; this.ay = blank;
    this.m_glucose = blank; this.m_fattyAcid = blank; this.m_aminoAcid = blank;
    this.m_minerals = blank; this.m_chlorophyll = blank; this.m_enzyme = blank;
    this.m_o2 = blank; this.m_co2 = blank; this.m_biomass = blank;
    this.m_waste = blank; this.m_adp = blank; this.m_ribosome = blank;
    this.r_rock = blank; this.r_sand = blank; this.r_clay = blank;
    this.r_organic = blank; this.r_lipid = blank; this.r_gas = blank;
    this.catalystCols = [];
    for (let k = 0; k < CATALYST_COUNT; k++) this.catalystCols.push(blank);
    this.genericChemCols = [];
    for (let k = 0; k < GENERIC_CHEMICAL_COUNT; k++) this.genericChemCols.push(blank);
    this.chemCols = new Array(CHEMICAL_COUNT).fill(blank);
    this.grow(initialCap);
  }
  grow(newCap: number): void {
    if (newCap <= this.cap) return;
    const grow1 = (a: Float32Array): Float32Array => {
      const n = new Float32Array(newCap); n.set(a); return n;
    };
    const grow1i = (a: Int32Array): Int32Array => {
      const n = new Int32Array(newCap); n.set(a); return n;
    };
    this.x = grow1(this.x); this.y = grow1(this.y); this.z = grow1(this.z);
    this.vx = grow1(this.vx); this.vy = grow1(this.vy); this.vz = grow1(this.vz);
    this.r = grow1(this.r); this.density = grow1(this.density);
    this.energy = grow1(this.energy);
    this.senseRange = grow1(this.senseRange);
    this.thrustAccel = grow1(this.thrustAccel);
    this.bornAt = grow1(this.bornAt);
    this.ingestCooldown = grow1(this.ingestCooldown);
    this.repairTicks = grow1i(this.repairTicks);
    {
      const grow1u = (a: Uint32Array): Uint32Array => {
        const n = new Uint32Array(newCap); n.set(a); return n;
      };
      this.fpLo = grow1u(this.fpLo);
      this.fpHi = grow1u(this.fpHi);
    }
    this.ax = grow1(this.ax);
    this.ay = grow1(this.ay);
    this.m_glucose = grow1(this.m_glucose);
    this.m_fattyAcid = grow1(this.m_fattyAcid);
    this.m_aminoAcid = grow1(this.m_aminoAcid);
    this.m_minerals = grow1(this.m_minerals);
    this.m_chlorophyll = grow1(this.m_chlorophyll);
    this.m_enzyme = grow1(this.m_enzyme);
    this.m_o2 = grow1(this.m_o2);
    this.m_co2 = grow1(this.m_co2);
    this.m_biomass = grow1(this.m_biomass);
    this.m_waste = grow1(this.m_waste);
    this.m_adp = grow1(this.m_adp);
    this.m_ribosome = grow1(this.m_ribosome);
    this.r_rock = grow1(this.r_rock);
    this.r_sand = grow1(this.r_sand);
    this.r_clay = grow1(this.r_clay);
    this.r_organic = grow1(this.r_organic);
    this.r_lipid = grow1(this.r_lipid);
    this.r_gas = grow1(this.r_gas);
    for (let k = 0; k < CATALYST_COUNT; k++) {
      this.catalystCols[k] = grow1(this.catalystCols[k]);
    }
    for (let k = 0; k < GENERIC_CHEMICAL_COUNT; k++) {
      this.genericChemCols[k] = grow1(this.genericChemCols[k]);
    }
    this.cap = newCap;
    // Rebuild column-by-name arrays so chemistry hot loops can iterate
    // them by integer index. Order matches MATERIAL_IDS / MOLECULE_IDS.
    this.resCols = [this.r_rock, this.r_sand, this.r_clay, this.r_organic, this.r_lipid, this.r_gas];
    // MOLECULE_IDS order: adp, glucose, fattyAcid, aminoAcid, chlorophyll,
    // enzyme, o2, co2, minerals, biomass, waste, ribosome
    this.molCols = [
      this.m_adp, this.m_glucose, this.m_fattyAcid, this.m_aminoAcid,
      this.m_chlorophyll, this.m_enzyme, this.m_o2, this.m_co2,
      this.m_minerals, this.m_biomass, this.m_waste, this.m_ribosome,
    ];
    // chemCols[0..7] alias the named slice of molCols (so writes via
    // either reach the same array); chemCols[8..63] point into the
    // independent genericChemCols storage.
    for (let k = 0; k < NAMED_CHEMICAL_COUNT; k++) {
      this.chemCols[k] = this.molCols[CHEM_NAMED_MOL_IDX[k]];
    }
    for (let k = 0; k < GENERIC_CHEMICAL_COUNT; k++) {
      this.chemCols[NAMED_CHEMICAL_COUNT + k] = this.genericChemCols[k];
    }
  }
  // Returns a fresh slot. Reuses freed slots first; grows on overflow.
  alloc(): number {
    if (this.free.length > 0) return this.free.pop()!;
    if (this.highWater >= this.cap) this.grow(this.cap * 2 || 256);
    const i = this.highWater++;
    this.zero(i);
    return i;
  }
  release(idx: number): void {
    this.zero(idx);
    this.free.push(idx);
  }
  private zero(i: number): void {
    this.x[i] = 0; this.y[i] = 0; this.z[i] = 0;
    this.vx[i] = 0; this.vy[i] = 0; this.vz[i] = 0;
    this.r[i] = 0; this.density[i] = 0;
    this.energy[i] = 0;
    this.senseRange[i] = 0;
    this.thrustAccel[i] = 0;
    this.bornAt[i] = 0;
    this.ingestCooldown[i] = 0;
    this.repairTicks[i] = 0;
    this.fpLo[i] = 0; this.fpHi[i] = 0;
    this.ax[i] = 0; this.ay[i] = 0;
    this.m_glucose[i] = 0; this.m_fattyAcid[i] = 0; this.m_aminoAcid[i] = 0;
    this.m_minerals[i] = 0; this.m_chlorophyll[i] = 0; this.m_enzyme[i] = 0;
    this.m_o2[i] = 0; this.m_co2[i] = 0; this.m_biomass[i] = 0;
    this.m_waste[i] = 0; this.m_adp[i] = 0; this.m_ribosome[i] = 0;
    this.r_rock[i] = 0; this.r_sand[i] = 0; this.r_clay[i] = 0;
    this.r_organic[i] = 0; this.r_lipid[i] = 0; this.r_gas[i] = 0;
    for (let k = 0; k < CATALYST_COUNT; k++) this.catalystCols[k][i] = 0;
    // Named chemCols slots 0..7 are aliases of molCols and already
    // cleared above; only the generic slice (8..63) needs its own
    // zeroing here.
    for (let k = 0; k < GENERIC_CHEMICAL_COUNT; k++) this.genericChemCols[k][i] = 0;
  }
}

export class MoleculesView {
  constructor(public c: Creature) {}
  get glucose(): number { return this.c.store.m_glucose[this.c.idx]; }
  set glucose(v: number) { this.c.store.m_glucose[this.c.idx] = v; }
  get fattyAcid(): number { return this.c.store.m_fattyAcid[this.c.idx]; }
  set fattyAcid(v: number) { this.c.store.m_fattyAcid[this.c.idx] = v; }
  get aminoAcid(): number { return this.c.store.m_aminoAcid[this.c.idx]; }
  set aminoAcid(v: number) { this.c.store.m_aminoAcid[this.c.idx] = v; }
  get minerals(): number { return this.c.store.m_minerals[this.c.idx]; }
  set minerals(v: number) { this.c.store.m_minerals[this.c.idx] = v; }
  get chlorophyll(): number { return this.c.store.m_chlorophyll[this.c.idx]; }
  set chlorophyll(v: number) { this.c.store.m_chlorophyll[this.c.idx] = v; }
  get enzyme(): number { return this.c.store.m_enzyme[this.c.idx]; }
  set enzyme(v: number) { this.c.store.m_enzyme[this.c.idx] = v; }
  get o2(): number { return this.c.store.m_o2[this.c.idx]; }
  set o2(v: number) { this.c.store.m_o2[this.c.idx] = v; }
  get co2(): number { return this.c.store.m_co2[this.c.idx]; }
  set co2(v: number) { this.c.store.m_co2[this.c.idx] = v; }
  get biomass(): number { return this.c.store.m_biomass[this.c.idx]; }
  set biomass(v: number) { this.c.store.m_biomass[this.c.idx] = v; }
  get waste(): number { return this.c.store.m_waste[this.c.idx]; }
  set waste(v: number) { this.c.store.m_waste[this.c.idx] = v; }
  get adp(): number { return this.c.store.m_adp[this.c.idx]; }
  set adp(v: number) { this.c.store.m_adp[this.c.idx] = v; }
  get ribosome(): number { return this.c.store.m_ribosome[this.c.idx]; }
  set ribosome(v: number) { this.c.store.m_ribosome[this.c.idx] = v; }
}

export class ReservesView {
  constructor(public c: Creature) {}
  get rock(): number { return this.c.store.r_rock[this.c.idx]; }
  set rock(v: number) { this.c.store.r_rock[this.c.idx] = v; }
  get sand(): number { return this.c.store.r_sand[this.c.idx]; }
  set sand(v: number) { this.c.store.r_sand[this.c.idx] = v; }
  get clay(): number { return this.c.store.r_clay[this.c.idx]; }
  set clay(v: number) { this.c.store.r_clay[this.c.idx] = v; }
  get organic(): number { return this.c.store.r_organic[this.c.idx]; }
  set organic(v: number) { this.c.store.r_organic[this.c.idx] = v; }
  get lipid(): number { return this.c.store.r_lipid[this.c.idx]; }
  set lipid(v: number) { this.c.store.r_lipid[this.c.idx] = v; }
  get gas(): number { return this.c.store.r_gas[this.c.idx]; }
  set gas(v: number) { this.c.store.r_gas[this.c.idx] = v; }
}

export class Creature {
  idx: number;
  store: CreatureStore;
  // Non-typed-array fields kept on the handle (variable-shape, not hot)
  genome!: Uint8Array;
  vm!: VMState;
  color!: string;
  speciesKey!: string;
  // Founding-lineage ID: every founder gets a fresh unique ID, every
  // descendant inherits it. Used to count distinct living lineages
  // so the world can top up to a target founder count. Engulfed cells
  // retain their original lineageRoot (they're alive, just confined
  // to a vacuole) but only world.creatures contribute to the count.
  lineageRoot: number = -1;
  division: { progress: number; axis: number; child: Creature } | null = null;
  contents: Creature[] = [];
  bonds: Creature[] = [];
  // Cached synthMask used when this cell is an endosymbiont in some
  // host's contents. Its VM doesn't run while engulfed, so its
  // biosynthesis intent is locked to whichever SYNTH_* ops exist in
  // its genome. Recomputed on engulfment and on inner-cell fission.
  // Meaningful only when this cell is inside someone's `contents`.
  organelleSynthMask: number = 0;
  // Views cached on first access. `molecules.glucose` etc. proxy into
  // store.m_glucose[this.idx].
  private _m?: MoleculesView;
  private _r?: ReservesView;
  constructor(store: CreatureStore, idx: number) { this.store = store; this.idx = idx; }
  get molecules(): MoleculesView { return this._m ??= new MoleculesView(this); }
  // Setter: copy field-by-field from any Molecules-shaped object into
  // the typed-array slot. Lets `c.molecules = emptyMolecules()`-style
  // existing code keep working while the underlying data is SoA.
  set molecules(m: { glucose?: number; fattyAcid?: number; aminoAcid?: number; minerals?: number; chlorophyll?: number; enzyme?: number; o2?: number; co2?: number; biomass?: number; waste?: number; adp?: number }) {
    const s = this.store; const i = this.idx;
    s.m_glucose[i] = m.glucose ?? 0;
    s.m_fattyAcid[i] = m.fattyAcid ?? 0;
    s.m_aminoAcid[i] = m.aminoAcid ?? 0;
    s.m_minerals[i] = m.minerals ?? 0;
    s.m_chlorophyll[i] = m.chlorophyll ?? 0;
    s.m_enzyme[i] = m.enzyme ?? 0;
    s.m_o2[i] = m.o2 ?? 0;
    s.m_co2[i] = m.co2 ?? 0;
    s.m_biomass[i] = m.biomass ?? 0;
    s.m_waste[i] = m.waste ?? 0;
    s.m_adp[i] = m.adp ?? 0;
  }
  get reserves(): ReservesView { return this._r ??= new ReservesView(this); }
  set reserves(r: { rock?: number; sand?: number; clay?: number; organic?: number; lipid?: number; gas?: number }) {
    const s = this.store; const i = this.idx;
    s.r_rock[i] = r.rock ?? 0;
    s.r_sand[i] = r.sand ?? 0;
    s.r_clay[i] = r.clay ?? 0;
    s.r_organic[i] = r.organic ?? 0;
    s.r_lipid[i] = r.lipid ?? 0;
    s.r_gas[i] = r.gas ?? 0;
  }
  get x(): number { return this.store.x[this.idx]; }
  set x(v: number) { this.store.x[this.idx] = v; }
  get y(): number { return this.store.y[this.idx]; }
  set y(v: number) { this.store.y[this.idx] = v; }
  get z(): number { return this.store.z[this.idx]; }
  set z(v: number) { this.store.z[this.idx] = v; }
  get vx(): number { return this.store.vx[this.idx]; }
  set vx(v: number) { this.store.vx[this.idx] = v; }
  get vy(): number { return this.store.vy[this.idx]; }
  set vy(v: number) { this.store.vy[this.idx] = v; }
  get vz(): number { return this.store.vz[this.idx]; }
  set vz(v: number) { this.store.vz[this.idx] = v; }
  get r(): number { return this.store.r[this.idx]; }
  set r(v: number) { this.store.r[this.idx] = v; }
  get density(): number { return this.store.density[this.idx]; }
  set density(v: number) { this.store.density[this.idx] = v; }
  get energy(): number { return this.store.energy[this.idx]; }
  set energy(v: number) { this.store.energy[this.idx] = v; }
  get senseRange(): number { return this.store.senseRange[this.idx]; }
  set senseRange(v: number) { this.store.senseRange[this.idx] = v; }
  get thrustAccel(): number { return this.store.thrustAccel[this.idx]; }
  set thrustAccel(v: number) { this.store.thrustAccel[this.idx] = v; }
  get bornAt(): number { return this.store.bornAt[this.idx]; }
  set bornAt(v: number) { this.store.bornAt[this.idx] = v; }
  get ingestCooldown(): number { return this.store.ingestCooldown[this.idx]; }
  set ingestCooldown(v: number) { this.store.ingestCooldown[this.idx] = v; }
  get repairTicks(): number { return this.store.repairTicks[this.idx]; }
  set repairTicks(v: number) { this.store.repairTicks[this.idx] = v; }
}

// Initialization options for a new Creature. Mirrors the field set.
export interface CreatureInit {
  x?: number; y?: number; z?: number;
  vx?: number; vy?: number; vz?: number;
  r?: number; density?: number;
  energy?: number;
  senseRange?: number; thrustAccel?: number;
  bornAt?: number;
  ingestCooldown?: number;
  repairTicks?: number;
  genome: Uint8Array;
  vm: VMState;
  color: string;
  speciesKey: string;
  molecules?: Partial<Molecules>;
  reserves?: Partial<Record<MaterialId, number>>;
}

export function newCreature(store: CreatureStore, init: CreatureInit): Creature {
  const idx = store.alloc();
  const c = new Creature(store, idx);
  store.x[idx] = init.x ?? 0;
  store.y[idx] = init.y ?? 0;
  store.z[idx] = init.z ?? 0;
  store.vx[idx] = init.vx ?? 0;
  store.vy[idx] = init.vy ?? 0;
  store.vz[idx] = init.vz ?? 0;
  store.r[idx] = init.r ?? 0;
  store.density[idx] = init.density ?? 1;
  store.energy[idx] = init.energy ?? 0;
  store.senseRange[idx] = init.senseRange ?? 0;
  store.thrustAccel[idx] = init.thrustAccel ?? 0;
  store.bornAt[idx] = init.bornAt ?? 0;
  store.ingestCooldown[idx] = init.ingestCooldown ?? 0;
  store.repairTicks[idx] = init.repairTicks ?? 0;
  c.genome = init.genome;
  c.vm = init.vm;
  c.color = init.color;
  c.speciesKey = init.speciesKey;
  if (init.molecules) {
    const m = init.molecules;
    if (m.glucose !== undefined) store.m_glucose[idx] = m.glucose;
    if (m.fattyAcid !== undefined) store.m_fattyAcid[idx] = m.fattyAcid;
    if (m.aminoAcid !== undefined) store.m_aminoAcid[idx] = m.aminoAcid;
    if (m.minerals !== undefined) store.m_minerals[idx] = m.minerals;
    if (m.chlorophyll !== undefined) store.m_chlorophyll[idx] = m.chlorophyll;
    if (m.enzyme !== undefined) store.m_enzyme[idx] = m.enzyme;
    if (m.o2 !== undefined) store.m_o2[idx] = m.o2;
    if (m.co2 !== undefined) store.m_co2[idx] = m.co2;
    if (m.biomass !== undefined) store.m_biomass[idx] = m.biomass;
    if (m.waste !== undefined) store.m_waste[idx] = m.waste;
    if (m.adp !== undefined) store.m_adp[idx] = m.adp;
  }
  if (init.reserves) {
    const r = init.reserves;
    if (r.rock !== undefined) store.r_rock[idx] = r.rock;
    if (r.sand !== undefined) store.r_sand[idx] = r.sand;
    if (r.clay !== undefined) store.r_clay[idx] = r.clay;
    if (r.organic !== undefined) store.r_organic[idx] = r.organic;
    if (r.lipid !== undefined) store.r_lipid[idx] = r.lipid;
    if (r.gas !== undefined) store.r_gas[idx] = r.gas;
  }
  return c;
}

export const MATERIAL_IDS_ORDERED = MATERIAL_IDS;

// Per-cell molecular pool. ATP itself lives on the Creature as `energy`
// (so existing code that talks about energy is talking about ATP); every
// other named species in the chemistry lives here. All quantities are in
// the same mass units as reserves, so reactions are mass-conserving and
// cell volume is total mass.
//
// Reactions are catalyzed (cell-built) where biology requires it
// (chlorophyll for carbon fixation; enzymes broadly); pathways gate on
// substrate availability via Michaelis-Menten kinetics so they slow down
// rather than cut off when reactants run low. Waste / CO2 build-up that
// the cell can't process get auto-excreted as world particles.
export interface Molecules {
  adp: number;          // ATP's discharged form; energy spend goes here
  glucose: number;      // primary fuel
  fattyAcid: number;    // energy-dense secondary fuel
  aminoAcid: number;    // building block
  chlorophyll: number;  // cell-built catalyst, enables photosynthesis
  enzyme: number;       // cell-built generic catalyst
  o2: number;           // respiration substrate / photosynth product
  co2: number;          // respiration product / photosynth substrate
  minerals: number;     // mineral cofactor / structural input
  biomass: number;      // structural; part of cell volume
  waste: number;        // toxic byproduct of fermentation
  ribosome: number;     // protein-synthesis machinery; multiplies biosynth rate
}

export const MOLECULE_IDS: ReadonlyArray<keyof Molecules> = [
  "adp", "glucose", "fattyAcid", "aminoAcid", "chlorophyll", "enzyme",
  "o2", "co2", "minerals", "biomass", "waste", "ribosome",
];

// Per-byte genome cost (BUILD_KEYS, genomeMoleculeCost,
// MASS_PER_GENOME_BYTE) retired with the build-block sufficiency gate
// in tryReproduce. Fission now splits whatever the parent has; if
// the daughter can't survive she autolyzes via the normal death pass.

export function emptyMolecules(): Molecules {
  return {
    adp: 0, glucose: 0, fattyAcid: 0, aminoAcid: 0,
    chlorophyll: 0, enzyme: 0,
    o2: 0, co2: 0, minerals: 0, biomass: 0, waste: 0, ribosome: 0,
  };
}

// Phylogeny: a "species" is a unique exact genome. We track when each first
// appeared, when its population last changed, who its parents (other genome
// keys that have produced it) are, and the events that bridged ancestors to
// it. A divergence is when a new genome key is born from an existing one;
// a convergence is when an already-known genome key is re-instantiated by
// a parent that has never produced it before.
export interface Species {
  key: string;
  color: string;
  firstSeen: number;
  lastSeen: number;
  alive: number;
  parents: Set<string>;
  lane: number;
  // Representative genome captured at first creation. Used to render
  // plain-English behavior summaries for both alive and extinct
  // species (a member's c.genome can drift somatically; this one
  // stays the canonical species signature).
  genome: Uint8Array;
  // Per-position VM execution counter (length = MAX_GENOME_BYTES).
  // Every tick that any cell of this species runs its VM, each PC
  // the VM lands on increments the slot at that position. Hot
  // positions = code that actually runs; zero slots = dead code or
  // unreachable. Aggregated across the species' cells; somatic
  // drift in any individual cell may slightly misalign its PCs vs.
  // the canonical genome here, treated as noise.
  execCounts: Uint32Array;
  // World ticks during which at least one cell of this species ran
  // its VM. Combined with execCounts gives per-position rates.
  vmTicks: number;
  // Highest summed-across-living-members biomass this species has
  // ever reached. Sampled by the renderer each frame and monotonically
  // increased. Survives extinction so the sidebar can rank species
  // by peak rather than current-instant biomass (the latter is often
  // 0 -- extinct species, or alive cells that just spent their stock
  // on a division).
  peakBiomass: number;
}

export interface PhylogenyEvent {
  t: number;
  from: string;
  to: string;
  convergence: boolean;
}

export interface World {
  width: number;
  height: number;
  depth: number;
  t: number;
  particles: Particle[];
  particleStore: ParticleStore;
  creatures: Creature[];
  creatureStore: CreatureStore;
  particleTarget: number;
  particleSpawnRate: number;
  // extinctionCount counts founding-lineage extinction events. Each
  // step we diff the previous live-lineage set against the current
  // one; any lineage that was alive last step but not this step
  // increments the counter. Whole-world wipeouts contribute too
  // (every lineage dies at once), but a single lineage going extinct
  // while others survive also counts.
  extinctionCount: number;
  // Set of lineageRoot ids alive at the end of the previous step.
  // Used to compute lineage extinctions per step.
  liveLineageRoots: Set<number>;
  // Monotonic counter used to assign a fresh lineageRoot ID each time
  // a founder is spawned (initial seeding + top-up after extinctions).
  nextLineageRoot: number;
  // Steady-state target for distinct founding lineages alive in the
  // world. Each step counts current lineages and spawns up to this
  // many to top up. Real worlds use 10; tests usually set to 0 to
  // disable spontaneous founder spawning while they assert specific
  // population shapes.
  founderTarget: number;
  gravity: number;
  drag: number;
  surfaceAmp: number;
  surfaceLength: number;
  surfacePeriod: number;
  surfaceDecay: number;
  swellAmp: number;
  swellLength: number;
  swellPeriod: number;
  swellDecay: number;
  zStirAmp: number;
  // Vertical mixing: a slowly drifting sine field of up/down currents.
  // Half the world rises while the other half sinks, and the pattern
  // shifts over time so no column is permanently a downdraft.
  updraftAmp: number;
  updraftLength: number;
  updraftPeriod: number;
  // Y-coordinate of the water surface. The band y = 0..surfaceY is
  // atmosphere; cells stay submerged below it; gas particles that drift
  // up past it escape to the atmosphere. Aeration drops fresh O2-rich
  // gas particles in just below the surface at a steady rate.
  // 2D pheromone field on a coarse grid. Cells EMIT into the field at
  // their position and SENSE the local concentration. Diffuses + decays
  // each tick so signals fade and spread. Stigmergy substrate: alarm
  // calls, mate-finding, "I ate good food here" trails.
  pheromone: Float32Array;
  pheromoneCols: number;
  pheromoneRows: number;
  surfaceY: number;
  // Visible / physical vertical amplitude of the surface wave. The wall
  // and the renderer both use this so lipids (which float to the surface)
  // never appear above the rendered water line.
  surfaceWaveAmp: number;
  aerationRate: number;
  // Water temperature profile. The surface is warmer (sunlight), the
  // bottom is colder. Horizontal patches drift slowly via tempPatch*,
  // standing in for thermal convection without simulating it.
  tempSurface: number;
  tempBottom: number;
  tempPatchAmp: number;
  tempPatchLength: number;
  tempPatchPeriod: number;
  restitution: number;
  xWallRestitution: number;
  zWallRestitution: number;
  collisionIters: number;
  species: Map<string, Species>;
  phylogenyEvents: PhylogenyEvent[];
  nextSpeciesLane: number;
  // Cell color is keyed off genome distance from this "root" genome. The
  // root is the genome of the latest seed cell -- the world's first cell,
  // and reseed each time the population goes extinct. Distance 0 -> pure
  // white; bigger distance -> a desaturated-to-saturated hash-hued color.
  anchorGenome: Uint8Array;
  // Brownian noise amplitude added to wave forcing. Helps prevent stuff
  // from accumulating on one side of the world.
  brownianAmp: number;
  // Day/night: phase 0..1 advances at 1/dayPeriod each sec. Solar light
  // multiplier = max(0, sin(2*pi*phase + offset)); midday at phase 0.25,
  // dead night at phase 0.75. Photosynthesis and the light sensor both
  // multiply through this so cells experience a real day/night rhythm.
  dayPhase: number;
  dayPeriod: number;
  // Disturbance events ("storms"). intensity 0..1 ramps up + down across
  // an event; surfaceAmp/brownian/zStir scale with it at use sites. The
  // scheduler picks the next event time uniformly within [60s, 1200s]
  // after the previous one ends, so the gaps are irregular.
  disturbanceIntensity: number;
  disturbanceStartedAt: number;
  disturbanceUntil: number;
  nextDisturbanceAt: number;
  // Horizontal current amplitude (accel px/s^2). Surface flows one way,
  // depth the other; the sign reverses on a slow oscillation. Cells and
  // particles both feel it. Tests can zero this for stillwater scenarios.
  currentAmp: number;
  // VM ops budget per creature per tick. Lower = cheaper; cells just
  // take more ticks to finish a full pass through their genome.
  vmInstrBudget: number;
  // Static immovable terrain: rocks pre-placed at world creation. Each
  // obstacle is a cluster of overlapping circle "lobes" so it can be
  // irregular in shape. Particles + creatures collide with them like
  // a fixed wall (no impulse, just positional pushback). Crescent floor
  // and the seven-or-so dropped boulders both live here.
  obstacles: Obstacle[];
  // Optional per-phase timing. When present, step() accumulates wall-clock
  // milliseconds spent in each phase plus a tick counter. Read + reset by
  // the UI to display where the frame budget actually goes.
  profile?: WorldProfile;
}

export interface WorldProfile {
  ticks: number;
  pheromone: number;
  bonds: number;
  forces: number;
  creatures: number;
  particleColl: number;
  creatureColl: number;
  sedimentColl: number;
  obstacleColl: number;
  walls: number;
  aerate: number;
  replenish: number;
  prune: number;
}

export function makeProfile(): WorldProfile {
  return {
    ticks: 0,
    pheromone: 0, bonds: 0, forces: 0, creatures: 0,
    particleColl: 0, creatureColl: 0, sedimentColl: 0, obstacleColl: 0,
    walls: 0, aerate: 0, replenish: 0, prune: 0,
  };
}

export function resetProfile(p: WorldProfile): void {
  p.ticks = 0;
  p.pheromone = 0; p.bonds = 0; p.forces = 0; p.creatures = 0;
  p.particleColl = 0; p.creatureColl = 0; p.sedimentColl = 0;
  p.walls = 0; p.aerate = 0; p.replenish = 0; p.prune = 0;
}

const ENERGY_PER_THRUST_SEC = 5;
const ENERGY_PER_INSTRUCTION = 0.0005;
// VM ops per tick per creature. 8 keeps frame cost reasonable at high
// population. Tests override via world.vmInstrBudget when they need to
// see the whole default-genome program execute in one step.
const DEFAULT_VM_INSTR_BUDGET = 8;

const PARTICLE_DENSITY_PER_AREA = (6188 * 0.75 * 0.5) / (800 * 600);
const PARTICLE_SPAWN_RATIO = (90 / 550) * 0.5;
// Hard cap on the per-second spawn rate. Without this the world tries
// to fill thousands of particles per second from the top of the water,
// which looks like a wall of stuff falling at startup. Refill after
// eating still works because pop * eat-rate stays well under this cap
// for normal populations (~20 cells eating ~3/sec = 60/sec).
const MAX_SPAWN_PER_SEC = 200;

// Recompute every world field that scales with width/height. Called on
// resize so a window expansion actually fills the new space with food
// instead of leaving the old (relatively sparse) particle target.
export function resizeWorld(world: World, width: number, height: number): void {
  world.width = width;
  world.height = Math.max(100, height);
  world.surfaceY = world.height * SURFACE_Y_FRAC;
  world.aerationRate = world.width * AERATION_PER_PX;
  world.particleTarget = Math.max(100, Math.round(world.width * world.height * PARTICLE_DENSITY_PER_AREA));
  world.particleSpawnRate = Math.min(MAX_SPAWN_PER_SEC, Math.max(5, world.particleTarget * PARTICLE_SPAWN_RATIO));
  resizePheromone(world);
}

function resizePheromone(world: World): void {
  const cols = Math.max(1, Math.ceil(world.width / PHEROMONE_CELL));
  const rows = Math.max(1, Math.ceil(world.height / PHEROMONE_CELL));
  if (cols === world.pheromoneCols && rows === world.pheromoneRows && world.pheromone.length === cols * rows) {
    return;
  }
  world.pheromone = new Float32Array(cols * rows);
  world.pheromoneCols = cols;
  world.pheromoneRows = rows;
}

export function pheromoneIndex(world: World, x: number, y: number): number {
  const cx = Math.max(0, Math.min(world.pheromoneCols - 1, Math.floor(x / PHEROMONE_CELL)));
  const cy = Math.max(0, Math.min(world.pheromoneRows - 1, Math.floor(y / PHEROMONE_CELL)));
  return cy * world.pheromoneCols + cx;
}

// Pheromone field decay + diffusion. Called once per tick from step().
// O(cols*rows): cheap at 32px cells on a 1920x1080 canvas (~2000 cells).
// Scratch buffer for evolvePheromone -- preallocated module-level so
// we don't churn the GC with a fresh Float32Array every tick. Resized
// in resizePheromone alongside world.pheromone.
let PHEROMONE_NEXT = new Float32Array(0);
const PHEROMONE_EPS = 1e-4;
function evolvePheromone(world: World, dt: number): void {
  const cols = world.pheromoneCols;
  const rows = world.pheromoneRows;
  const f = world.pheromone;
  const decay = Math.max(0, 1 - PHEROMONE_DECAY_PER_SEC * dt);
  const diff = Math.max(0, Math.min(1, PHEROMONE_DIFFUSE_PER_SEC * dt));
  // Decay + scan: shrink in place, and track whether any cell still
  // has a meaningful value. If the field is empty we can bail before
  // the diffusion pass.
  let anyActive = false;
  for (let i = 0; i < f.length; i++) {
    const v = f[i] * decay;
    f[i] = v;
    if (v > PHEROMONE_EPS) anyActive = true;
  }
  if (!anyActive || diff <= 0 || cols < 2 || rows < 2) return;
  if (PHEROMONE_NEXT.length < f.length) PHEROMONE_NEXT = new Float32Array(f.length);
  const next = PHEROMONE_NEXT;
  const oneMinusDiff = 1 - diff;
  // Interior cells: every cell has 4 neighbors; no boundary checks.
  // Skip the 4-edge frame which is handled in the boundary pass below.
  for (let y = 1; y < rows - 1; y++) {
    const row = y * cols;
    for (let x = 1; x < cols - 1; x++) {
      const i = row + x;
      const avg = (f[i - 1] + f[i + 1] + f[i - cols] + f[i + cols]) * 0.25;
      next[i] = f[i] * oneMinusDiff + avg * diff;
    }
  }
  // Boundary cells: each has 2 or 3 neighbors. Handle the four edges.
  for (let x = 0; x < cols; x++) {
    // top row
    const it = x;
    let s = 0, n = 0;
    if (x > 0)        { s += f[it - 1];    n++; }
    if (x < cols - 1) { s += f[it + 1];    n++; }
    s += f[it + cols]; n++;
    next[it] = f[it] * oneMinusDiff + (s / n) * diff;
    // bottom row
    const ib = (rows - 1) * cols + x;
    s = 0; n = 0;
    if (x > 0)        { s += f[ib - 1];    n++; }
    if (x < cols - 1) { s += f[ib + 1];    n++; }
    s += f[ib - cols]; n++;
    next[ib] = f[ib] * oneMinusDiff + (s / n) * diff;
  }
  for (let y = 1; y < rows - 1; y++) {
    // left column
    const il = y * cols;
    let s = f[il + 1] + f[il - cols] + f[il + cols];
    next[il] = f[il] * oneMinusDiff + (s / 3) * diff;
    // right column
    const ir = il + (cols - 1);
    s = f[ir - 1] + f[ir - cols] + f[ir + cols];
    next[ir] = f[ir] * oneMinusDiff + (s / 3) * diff;
  }
  // Copy next -> f via subarray-set for a single C-side memcpy.
  f.set(next.subarray(0, f.length));
}
const MAX_CREATURES = 400;

const INGEST_ENERGY_COST = 1.5;
const INGEST_COOLDOWN_SEC = 0.15;
// Ingestion is rate-limited by membrane area: a bigger cell has more surface
// through which to absorb, so its post-ingest cooldown shrinks proportionally
// (cooldown / (r / INGEST_REF_R)). Below INGEST_REF_R the cooldown stays at
// the baseline so tiny cells aren't accidentally penalized.
const INGEST_REF_R = 4;
const EXCRETE_MIN_AMOUNT = 0.5;

const PREDATION_MASS_RATIO = 1.5;
const PREDATION_COOLDOWN_SEC = 0.2;
const PREDATION_ENERGY_BASE = 5;
const PREDATION_ENERGY_PER_MASS = 0.1;

// Baseline metabolism: a small flat "cost of being alive" plus a per-mass
// component. Big cells must keep more chemistry running and starve faster
// when idle. A r=4 cell pays ~0.5 e/s; a r=20 (~mass 1250) cell pays ~7 e/s.
const BASE_METABOLIC_DRAIN = 0.5;
const BASE_METABOLIC_PER_MASS = 0.0003;
const DEATH_RELEASE_R_MIN = 1.2;
const DEATH_RELEASE_SCATTER = 30;

// Thrust energy scaling. Starter cell mass is ~224 (reserves + molecules +
// ATP), so THRUST_MASS_REF=200 keeps the starter near the no-penalty line
// and only large grown cells pay the surface-area-vs-volume tax. With the
// old THRUST_MASS_REF=50 the starter paid ~4.5x and bankrupted itself on
// the chase to its first organic particle.
const THRUST_MASS_REF = 200;

// Mitosis initiation cost. Charged unconditionally at the start of every
// REPRODUCE attempt, success or failure. This is the "natural" rate limit
// on spamming REPRODUCE: a cell that fires the op every tick without the
// biomass to back it up bleeds ATP and starves itself. The per-mass term
// reflects that splitting a big cell takes more reorganization than a small
// one.
const REPRODUCE_ATTEMPT_ATP_BASE = 0.4;
const REPRODUCE_ATTEMPT_ATP_PER_MASS = 0.01;
// Newborn maternal investment ("yolk"). Free glucose + ATP injected
// at fission so children survive the lag between birth and reaching
// their first meal. Small enough not to invalidate metabolic accounting
// at population scale.
const NEWBORN_YOLK_GLUCOSE = 15;
const NEWBORN_YOLK_ATP = 8;
// Starter ribosome endowment for newborns. With the strict ribosome
// model (zero ribosomes -> zero biosynth), a child that inherited
// only a fractional ribosome from a small parent could stall before
// it ever gets going. A small free bump guarantees biosynth runs
// from tick 1.
const NEWBORN_YOLK_RIBO = 2;
// Multiplier on (parent.r + child.r) for birth offset. >1 places the
// child outside the parent's recently-eaten food zone so it can find
// a food gradient. Was 1.1 (child inside parent's foraging range).
const BIRTH_OFFSET_MULT = 3.0;

// Photosynthesis depth attenuation: ambient light = exp(-y / LIGHT_DECAY).
// Surface = 1.0, e-folds every LIGHT_DECAY pixels of depth.
const LIGHT_DECAY = 250;
// Static depth contribution to vertical pressure. Scales (y - surfaceY)
// to a comparable magnitude with the wave / current force components
// so the genome's threshold logic gets a meaningful spread across the
// water column. Tuned to give ~100 at the bottom of an 800x600 world.
const PRESSURE_PER_DEPTH = 0.2;

const DRAG_REF_R = 4;
const MIN_CREATURE_R = 4;
// Cell density: how strongly reserve composition shifts the effective
// density away from water (1.0). 1.0 = full literal weighting (the
// rock-stuffed cell really does sit at ~1.3); 0 = density always 1.0.
// 0.3 = "mostly water, slight nudge from contents."
const DENSITY_DAMPING = 0.3;
const DENSITY_FLOOR = 0.85;
const DENSITY_CEIL = 1.15;

// ----- chemistry constants -----
//
// Catabolism rate: how fast undigested reserves break down into named
// molecules per second per unit cell surface (r/MIN_CREATURE_R). Mass
// fractions in CATAB_FRACTIONS must sum to 1 per row so material ->
// molecules conversion is mass-conserving.
const CATAB_VMAX_PER_R = 6;   // mass / sec per (r / MIN_R) surface ratio at saturation
const CATAB_KM = 6;

// Passive O2 (and CO2) exchange with the surrounding water. Real cells
// dissolve oxygen across their membrane; without this our cells starve
// because the default genome only seeks organic particles and never builds
// up enough internal O2 to power aerobic respiration.
const O2_DIFFUSION_PER_R = 2;     // mass/sec at saturation
const O2_AMBIENT = 12;             // assumed dissolved-O2 concentration cells diffuse toward
const CO2_OFFGAS_PER_R = 1.5;     // mass/sec; CO2 leaks out of cells (down its gradient)
const CO2_AMBIENT = 1;

type Catab = Partial<Molecules>;
const CATAB_FRACTIONS: Record<MaterialId, Catab> = {
  rock:    { minerals: 1.0 },
  sand:    { minerals: 1.0 },
  clay:    { minerals: 0.7, aminoAcid: 0.3 },
  organic: { glucose: 0.5, aminoAcid: 0.3, fattyAcid: 0.2 },
  lipid:   { fattyAcid: 0.7, aminoAcid: 0.3 },
  gas:     { o2: 0.6, co2: 0.4 },
};

// Precomputed flat tables: per-material, the molecule keys and their
// fractions, ready for indexed iteration. Beats `for (const k in frac)`
// in catabolize() -- for-in is several times slower than a tight indexed
// loop over packed arrays.
const CATAB_KEYS: Record<MaterialId, (keyof Molecules)[]> = {} as Record<MaterialId, (keyof Molecules)[]>;
const CATAB_FRACS: Record<MaterialId, number[]> = {} as Record<MaterialId, number[]>;
for (const id of Object.keys(CATAB_FRACTIONS) as MaterialId[]) {
  const row = CATAB_FRACTIONS[id];
  const keys: (keyof Molecules)[] = [];
  const fracs: number[] = [];
  for (const k of Object.keys(row) as (keyof Molecules)[]) {
    const v = row[k];
    if (v !== undefined && v > 0) { keys.push(k); fracs.push(v); }
  }
  CATAB_KEYS[id] = keys;
  CATAB_FRACS[id] = fracs;
}

// String key -> index in MOLECULE_IDS array. Used by CATAB_MOL_TARGETS
// to translate the catabolism table into integer column indices.
const MOLECULE_INDEX: Record<keyof Molecules, number> = {} as Record<keyof Molecules, number>;
for (let i = 0; i < MOLECULE_IDS.length; i++) MOLECULE_INDEX[MOLECULE_IDS[i]] = i;

// Catabolism lookups indexed by material number (matching MATERIAL_IDS).
// Each row is a packed list of (molecule index, fraction) pairs. Lets
// the hot loop avoid object-keyed dispatch entirely.
const CATAB_TARGETS_MOL: Int32Array[] = MATERIAL_IDS.map((id) => {
  const keys = CATAB_KEYS[id];
  const a = new Int32Array(keys.length);
  for (let k = 0; k < keys.length; k++) a[k] = MOLECULE_INDEX[keys[k]];
  return a;
});
const CATAB_TARGETS_FRAC: Float32Array[] = MATERIAL_IDS.map((id) => {
  const fracs = CATAB_FRACS[id];
  const a = new Float32Array(fracs.length);
  for (let k = 0; k < fracs.length; k++) a[k] = fracs[k];
  return a;
});

// Reaction kinetics. Each reaction uses Michaelis-Menten saturation so it
// runs at most VMAX per second and gracefully slows as substrates deplete.
// The named-reaction VMAX values (formerly AEROBIC_VMAX etc.) now live
// inline in installNamedReactions() since each one belongs to a single
// slot in the REACTIONS table. KM_DEFAULT is still used by the engine.
const KM_DEFAULT = 1;

// Phase 2: riboMult retired. Biosynth rates are uniform across cells;
// ribosome accumulation no longer multiplies them. Cells that want to
// out-build their peers do it via catalyst pools on the specific
// biosynth slots (REACTIONS[4..9]). Ribosomes still exist as a
// tracked molecule and can be synthesized via the synth_ribo
// reaction, but they're inert -- a future cleanup will retire them.

// Generic chemistry: 64 chemicals + 256 reactions. The named
// chemistry (aerobic / ferment / betaOx / catabolize / photosynth /
// biosynthesize) runs UNCATALYZED at its base rate -- it's the
// bootstrap engine every cell gets for free. On top of that, the VM
// can choose to build catalysts (SYNTH_CAT <id>) for any of 256
// generated reactions that swap chemicals around. The 8 named
// chemicals appear at slots 0..7 of the chemical table and alias
// the existing m_* fields, so generic reactions can pull from /
// dump into the named pool transparently. The other 56 are abstract
// generic chemicals with random masses -- the "chemicals the cell
// stumbles upon".
const CAT_REF = 5;
const CAT_SYNTH_VMAX = 0.3;
const CAT_ATP_COST = 4;
const CAT_DECAY_PER_SEC = 0.005;
const CHEMICAL_COUNT = 64;
const NAMED_CHEMICAL_COUNT = 12;
// Order matches chemical slot 0..11. Each entry is a key of Molecules
// and the chemCols[k] Float32Array aliases molCols[MOLECULE_INDEX[k]].
// Phase 2 promotes all current Molecules to named chemicals so the
// reaction engine can address every cellular species directly.
const NAMED_CHEMICALS: ReadonlyArray<keyof Molecules> = [
  "o2", "co2", "glucose", "aminoAcid", "fattyAcid", "minerals", "biomass", "adp",
  "waste", "chlorophyll", "enzyme", "ribosome",
];
// Slot indices for special handling (engine-managed ATP/ADP, etc.).
const CHEM_ADP = 7;
const GENERIC_CHEMICAL_COUNT = CHEMICAL_COUNT - NAMED_CHEMICAL_COUNT;
interface ChemicalDef {
  name: string;
  mass: number; // unit mass per "mole" -- 1 for named (matches existing model)
}
const CHEMICALS: ChemicalDef[] = buildChemicalTable();
// CHEM_NAMED_MOL_IDX[k] = molCols index of the named chemical at
// chemCols[k] (k < 8). Resolved against MOLECULE_INDEX which is
// already populated above by the time this line evaluates.
const CHEM_NAMED_MOL_IDX: number[] = NAMED_CHEMICALS.map((n) => MOLECULE_INDEX[n]);

function buildChemicalTable(): ChemicalDef[] {
  const out: ChemicalDef[] = [];
  for (const n of NAMED_CHEMICALS) out.push({ name: n, mass: 1 });
  // Deterministic per-chemical mass for the generic pool, drawn
  // from a small set so reactions across runs have the same balance.
  // Skew toward small masses (most biology is light chemistry).
  const rng = mulberry32(0xC8E3_15CA);
  for (let i = NAMED_CHEMICAL_COUNT; i < CHEMICAL_COUNT; i++) {
    const u = rng();
    const mass = 0.5 + u * u * 4.5; // 0.5 .. 5.0, skewed low
    out.push({ name: `c${i.toString(16).padStart(2, "0")}`, mass });
  }
  return out;
}

// One reaction per catalyst slot. Generated deterministically at
// module init so reactions are stable across runs (and across the
// renderer/worker boundary, when we get there). Substrate /
// product chemicals are picked from any of CHEMICAL_COUNT, counts
// are scaled to keep mass balanced, atpDelta and lightIn are added
// independently of mass.
interface Reaction {
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
  // Optional synthMask bit: reaction only runs if (VM_OUT.synthMask & gateMask).
  // 0 = no gate (always eligible). Biosynth reactions use this so the
  // SYNTH_AA / SYNTH_FA / SYNTH_BIO ops still gate what gets built.
  gateMask: number;
  // If true, rate also scales with cell surface area (r / MIN_R) -- only
  // photosynth uses this today, modeling pigment membrane area.
  surfaceScale: boolean;
  // Apply BIOSYNTH_ATP_FLOOR when this reaction consumes ATP. True for
  // biosynth slots so newborns don't burn their starting ATP on growth.
  atpFloor: boolean;
}
const REACTIONS: Reaction[] = buildReactionTable();

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
      sMass += c * CHEMICALS[sChem[j]].mass;
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
      pMassRaw += c * CHEMICALS[pChem[j]].mass;
    }
    const scale = sMass / pMassRaw;
    const pCount = new Float32Array(nP);
    for (let j = 0; j < nP; j++) pCount[j] = pCountRaw[j] * scale;
    // ATP delta: roughly bell-shaped around 0, slight exergonic bias
    // so on average reactions release a little energy. Range ~[-6, +8].
    const atpDelta = ((rng() + rng() + rng()) / 3 - 0.4) * 14;
    // Light: ~15% of reactions are light-driven, requiring 0.2..1.5
    // units of ambient light to proceed (caps the rate).
    const lightIn = rng() < 0.15 ? 0.2 + rng() * 1.3 : 0;
    // VMAX: log-uniform 0.05 .. 1.5, so a few reactions are fast,
    // most are middling. Cells that build the right catalyst can
    // make the slow ones useful too.
    const vmax = Math.exp(Math.log(0.05) + rng() * (Math.log(1.5) - Math.log(0.05)));
    out.push({
      sChem, sCount, pChem, pCount, atpDelta, lightIn, vmax,
      uncatRate: 0, gateMask: 0, surfaceScale: false, atpFloor: false,
    });
  }
  // Overwrite the first 10 generated entries with the named reactions.
  // Catalyst slots 0..9 correspond to the named reactions, so a cell
  // that builds catalyst[k] is boosting one of these specific
  // pathways. Subsequent slots (10..255) remain the generated generics.
  installNamedReactions(out);
  return out;
}

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
    opts: { lightIn?: number; gateMask?: number; surfaceScale?: boolean; atpFloor?: boolean } = {},
  ): Reaction => ({
    sChem: new Uint8Array(sChem),
    sCount: new Float32Array(sCount),
    pChem: new Uint8Array(pChem),
    pCount: new Float32Array(pCount),
    atpDelta,
    lightIn: opts.lightIn ?? 0,
    vmax: rate,             // catalyst boost: another `rate` at full pool
    uncatRate: rate,         // bootstrap rate every cell gets free
    gateMask: opts.gateMask ?? 0,
    surfaceScale: opts.surfaceScale ?? false,
    atpFloor: opts.atpFloor ?? false,
  });
  // Slot index in NAMED_CHEMICALS: o2=0 co2=1 glu=2 aa=3 fa=4 min=5
  // biomass=6 adp=7 waste=8 chl=9 enz=10 rib=11.
  // Energy reactions:
  out[0] = mk([2, 0], [1, 1], [1], [2], +10, 16);                // aerobic: glu+o2 -> 2 co2 + 10 atp
  out[1] = mk([2], [1], [1, 8], [0.5, 0.5], +2, 1.5);            // ferment: glu -> 0.5 co2 + 0.5 waste + 2 atp
  out[2] = mk([4, 0], [1, 1], [1], [2], +14, 1.5);               // betaOx: fa+o2 -> 2 co2 + 14 atp
  out[3] = mk([1], [1], [2, 0], [0.5, 0.5], -1, 1.2, { lightIn: 1, surfaceScale: true }); // photosynth
  // Biosynth (gated by VM_OUT.synthMask bits 1/2/4/3/5/0):
  out[4] = mk([2, 5], [0.7, 0.3], [3], [1], -2, 0.4, { gateMask: 1 << 1, atpFloor: true }); // synth_aa
  out[5] = mk([2, 5], [0.9, 0.1], [4], [1], -6, 0.2, { gateMask: 1 << 2, atpFloor: true }); // synth_fa
  out[6] = mk([3, 5], [0.5, 0.5], [9], [1], -8, 0.2, { gateMask: 1 << 4, atpFloor: true }); // synth_chl
  out[7] = mk([3, 5], [0.5, 0.5], [10], [1], -4, 0.4, { gateMask: 1 << 3, atpFloor: true }); // synth_enz
  out[8] = mk([3, 5], [0.5, 0.5], [11], [1], -10, 0.15, { gateMask: 1 << 5, atpFloor: true }); // synth_ribo
  out[9] = mk([3, 4], [0.9, 0.1], [6], [1], -1, 0.8, { gateMask: 1 << 0, atpFloor: true }); // synth_biomass
}

// Hot inner loop. Slot-major iteration so each catalystCols[k] is one
// contiguous Float32Array per pass; the empty-pool branch is
// predicted not-taken for the common case (cells express only a
// handful of catalysts at a time).
//
// Phase 2: also drives the named reactions. Slot 0..9 have
// uncatRate > 0 so they fire even with zero catalyst -- the bootstrap
// chemistry every cell gets free. Catalyst pools boost on top.
// ATP/ADP mass conservation is engine-managed via atpDelta: exergonic
// reactions deduct |atpDelta| ADP per unit; endergonic deduct
// |atpDelta| ATP (energy) and credit |atpDelta| ADP.
// Surface fingerprint: each cell's top FP_SIZE chemicals by current
// concentration, packed as a bitmask over CHEMICAL_COUNT. Other
// cells read this on contact to gate ADHERE (kin recognition) and
// ENGULF (non-self recognition). No genome inspection involved --
// this is the cell's phenotype "on display": its actual chemistry
// pool. Kin recognition emerges naturally because related lineages
// run similar genomes -> produce similar chemistry -> carry
// overlapping fingerprints. Refreshed once per tick before VM /
// reactions.
const FP_SIZE = 8;
const fpScratchIds = new Uint8Array(FP_SIZE);
const fpScratchVals = new Float32Array(FP_SIZE);
function popcount32(x: number): number {
  x = (x | 0) - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return ((((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24) | 0;
}
function fingerprintOverlap(a: Creature, b: Creature): number {
  const sa = a.store; const sb = b.store;
  const ai = a.idx; const bi = b.idx;
  return popcount32(sa.fpLo[ai] & sb.fpLo[bi]) + popcount32(sa.fpHi[ai] & sb.fpHi[bi]);
}
function updateSurfaceFingerprint(c: Creature): void {
  const s = c.store; const i = c.idx;
  const cols = s.chemCols;
  // Selection: keep top FP_SIZE entries in fpScratch.
  for (let k = 0; k < FP_SIZE; k++) { fpScratchVals[k] = -1; fpScratchIds[k] = 0; }
  for (let chem = 0; chem < CHEMICAL_COUNT; chem++) {
    const v = cols[chem][i];
    if (v <= 0) continue;
    // Find slot with smallest value; evict if v is bigger.
    let minIdx = 0;
    let minVal = fpScratchVals[0];
    for (let k = 1; k < FP_SIZE; k++) {
      if (fpScratchVals[k] < minVal) { minVal = fpScratchVals[k]; minIdx = k; }
    }
    if (v > minVal) {
      fpScratchVals[minIdx] = v;
      fpScratchIds[minIdx] = chem;
    }
  }
  // Pack ids into a 64-bit set (lo: ids 0..31, hi: ids 32..63).
  let lo = 0, hi = 0;
  for (let k = 0; k < FP_SIZE; k++) {
    if (fpScratchVals[k] < 0) continue; // unfilled slot
    const id = fpScratchIds[k];
    if (id < 32) lo |= (1 << id);
    else hi |= (1 << (id - 32));
  }
  s.fpLo[i] = lo >>> 0;
  s.fpHi[i] = hi >>> 0;
}
function refreshSurfaceFingerprints(world: World): void {
  for (const c of world.creatures) {
    updateSurfaceFingerprint(c);
    // Inner cells get fingerprints too so a host's engulfment of a new
    // prey reads the prey's fingerprint correctly; engulfed cells
    // already inside don't need to be checked (recognition is at
    // contact time, but cheap to keep them updated).
    for (const inner of c.contents) updateSurfaceFingerprint(inner);
  }
}

function runGenericReactions(c: Creature, dt: number, ambientLight: number, synthMask: number): void {
  const s = c.store; const i = c.idx;
  const KM = KM_DEFAULT;
  for (let slot = 0; slot < N_REACTIONS; slot++) {
    const rxn = REACTIONS[slot];
    if (rxn.gateMask !== 0 && (synthMask & rxn.gateMask) === 0) continue;
    const pool = s.catalystCols[slot][i];
    if (rxn.uncatRate <= 0 && pool <= 0) continue;
    // Light gate
    let lightMult = 1;
    if (rxn.lightIn > 0) {
      if (ambientLight <= 0) continue;
      lightMult = ambientLight / rxn.lightIn;
      if (lightMult > 1) lightMult = 1;
    }
    // Substrate gate + MM saturation
    let limit = Infinity;
    let satProduct = 1;
    const sChem = rxn.sChem;
    const sCount = rxn.sCount;
    for (let j = 0; j < sChem.length; j++) {
      const have = s.chemCols[sChem[j]][i];
      const need = sCount[j];
      const ratio = have / need;
      if (ratio < limit) limit = ratio;
      satProduct *= ratio / (ratio + KM);
    }
    if (limit <= 0) continue;
    // ATP / ADP handling.
    const atpD = rxn.atpDelta;
    if (atpD < 0) {
      // Endergonic: pulls from cell energy. atpFloor reactions keep
      // BIOSYNTH_ATP_FLOOR ATP in reserve so newborns don't drain
      // themselves dry growing.
      const floor = rxn.atpFloor ? BIOSYNTH_ATP_FLOOR : 0;
      const eAvail = (s.energy[i] - floor) / -atpD;
      if (eAvail <= 0) continue;
      if (eAvail < limit) limit = eAvail;
      satProduct *= eAvail / (eAvail + KM);
    } else if (atpD > 0) {
      // Exergonic: phosphorylates ADP back to ATP. Need ADP available.
      const adpAvail = s.chemCols[CHEM_ADP][i] / atpD;
      if (adpAvail <= 0) continue;
      if (adpAvail < limit) limit = adpAvail;
      satProduct *= adpAvail / (adpAvail + KM);
    }
    const surface = rxn.surfaceScale ? (s.r[i] / MIN_CREATURE_R) : 1;
    const rate = (rxn.uncatRate + rxn.vmax * (pool / CAT_REF)) * satProduct * lightMult * surface;
    let amt = rate * dt;
    if (amt > limit) amt = limit;
    if (amt <= 0) continue;
    // Apply substrates
    for (let j = 0; j < sChem.length; j++) {
      s.chemCols[sChem[j]][i] -= sCount[j] * amt;
    }
    // Apply products
    const pChem = rxn.pChem;
    const pCount = rxn.pCount;
    for (let j = 0; j < pChem.length; j++) {
      s.chemCols[pChem[j]][i] += pCount[j] * amt;
    }
    // ATP / ADP conversion (mass-conserving)
    if (atpD !== 0) {
      s.energy[i] += atpD * amt;
      s.chemCols[CHEM_ADP][i] -= atpD * amt;
    }
  }
}

// Small deterministic RNG. Keep reaction tables reproducible across
// runs / renderer reloads / future workers.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Maintenance: structural molecules turn over even when the cell isn't
// reproducing. Each tick a small fraction of biomass / enzyme / chloro
// / ribosome degrades back into the substrates it was synthesized
// from -- no ATP recovered, but mass-conserving. A cell that stops
// biosynthesizing (because it has no ATP) bleeds structure and
// eventually drops below MIN_VIABLE_BIOMASS, at which point it
// autolyzes.
const BIOMASS_DECAY_PER_SEC = 0.005;
const ENZYME_DECAY_PER_SEC = 0.005;
const CHLORO_DECAY_PER_SEC = 0.005;
const RIBO_DECAY_PER_SEC = 0.003;
const MIN_VIABLE_BIOMASS = 0.5;

// Somatic mutation rate scales quadratically with age (seconds). A newborn
// is effectively stable; an old cell accumulates DNA damage gradually.
// At age 60s: ~7e-3/s (1 mutation per ~140s); 100s: ~0.02/s; 300s: ~0.18/s.
const SOMATIC_MUTATION_AGE_COEF = 8e-7;
const REPAIR_ATP_PER_OP = 0.5;
const REPAIR_WINDOW_TICKS = 30;
// Horizontal current: amplitude (px/s^2 of acceleration) and the rate of
// the slow direction-reversal oscillation (rad/sec; 2pi/600 ~ 10 sim-min).
// Currently disabled (0) -- when on it piles sediment against one wall
// faster than the slow reversal can clear it. Need a better profile.
const CURRENT_AMP = 0;
const CURRENT_FREQ = 2 * Math.PI / 600;

// Auto-excretion: once internal CO2 / waste crosses these thresholds, the
// cell dumps the excess back to the world as particles (mass-conserving).
// Pumping costs ATP -- a stalled cell can't flush toxins, and the
// resulting waste/CO2 buildup eats biomass (see TOX_*).
const CO2_EXCRETE_THRESHOLD = 6;
const WASTE_EXCRETE_THRESHOLD = 3;
const EXCRETE_FLOOR = 1;
const EXCRETE_ATP_PER_MASS = 0.05;

// Above the excrete thresholds, waste / CO2 accumulation actively damages
// biomass. This is the second pressure (alongside maintenance decay) that
// makes "metabolically stalled" mean "dying" rather than "immortal couch
// potato." Damage mass goes into waste (oxidative byproducts).
const TOX_DAMAGE_PER_EXCESS_PER_SEC = 0.05;

// Surface of the water sits 5% of the world height below the top. The
// band above is atmosphere where cells can't go and gas particles escape.
const SURFACE_Y_FRAC = 0.05;
// Vertical splash: how deep the surface "spray" force reaches, and
// how strong it is relative to the horizontal surface force. High gain
// makes droplets visibly jump; small depth keeps the bulk water still.
const SPLASH_DEPTH = 30;
const SPLASH_GAIN = 1.5;
// Aeration: per-pixel-of-surface-length, expected gas bubbles per second.
// Each bubble carries O2 and falls into the water; cells can ingest or
// it eventually rises back out (or gets ingested by a hungry cell).
const AERATION_PER_PX = 0.005;
const AERATION_O2_PER_BUBBLE = 4;
const AERATION_BUBBLE_DROP_SPEED = 14;

// Pheromone field: coarse grid cell size, per-tick decay rate, and
// neighbor-blend (diffusion) fraction. Tuned so a single big emit
// (e.g. 50) fades to background in a few seconds and spreads about
// one grid cell per tick of diffusion.
const PHEROMONE_CELL = 32;
const PHEROMONE_DECAY_PER_SEC = 0.5;
const PHEROMONE_DIFFUSE_PER_SEC = 0.6;

// Adhesion: how many partners a single cell can be bonded to and the
// spring + break distances. Bonds are mutual; the spring rest length
// is the contact distance (sum of radii). Bonds snap at BOND_BREAK_RATIO
// times the rest length so a colony being yanked apart eventually
// disintegrates.
const MAX_BONDS = 4;
const BOND_SPRING_K = 8;
const BOND_BREAK_RATIO = 3.5;

// Temperature chemistry: enzyme-catalyzed reactions and idle metabolism
// scale with temperature via Q10 -- every 10°C, rates double. T_REF is
// the "neutral" temperature where the multiplier is 1.0. Clamped so that
// extreme temps don't blow up or zero out the simulation.
const TEMP_REF = 20;
const TEMP_Q10 = 2;
const TEMP_MULT_MIN = 0.25;
const TEMP_MULT_MAX = 4.0;

// Surface displacement at a given x. Built from multiple superposed
// wavelets so the line looks like real water -- a main gravity wave plus
// off-rate harmonics, a longer swell contribution, and a coupling term
// that bulges the surface UP wherever the updraft field is pushing water
// up from below. Physics wall and renderer share this so lipids float to
// exactly the visible line.
// Activity factor for surface-related forces. Combines the slow
// irregularity envelope (so quiet periods read calm) with the storm
// disturbance intensity (so storms read like real chop). Used by the
// visible surface wave, the physics wave forcing, and aeration so all
// three move together.
export function surfaceActivity(world: World): number {
  const t = world.t;
  const env =
    0.55 +
    0.25 * Math.sin(t * (2 * Math.PI / 37)) +
    0.20 * Math.sin(t * (2 * Math.PI / 91) + 1.7);
  const envClamped = Math.max(0.15, Math.min(1.0, env));
  return envClamped * (1 + 3 * world.disturbanceIntensity);
}

export function surfaceYAt(world: World, x: number): number {
  const t = world.t;
  const A = world.surfaceWaveAmp * surfaceActivity(world);
  const kS = (2 * Math.PI) / world.surfaceLength;
  const wS = (2 * Math.PI) / world.surfacePeriod;
  const kL = (2 * Math.PI) / world.swellLength;
  const wL = (2 * Math.PI) / world.swellPeriod;
  const kU = (2 * Math.PI) / world.updraftLength;
  const wU = (2 * Math.PI) / world.updraftPeriod;

  // Main gravity wave.
  let dy = A * Math.sin(kS * x - wS * t);
  // Two off-rate harmonics: irrational frequency ratios and phase offsets
  // keep the surface from repeating noticeably.
  dy += 0.45 * A * Math.sin(1.7 * kS * x - 1.3 * wS * t + 0.6);
  dy += 0.25 * A * Math.sin(3.1 * kS * x + 2.1 * wS * t + 1.4);
  // Longer swell contribution. Slower phase so it reads as a separate
  // motion riding under the chop.
  dy += 0.7 * A * Math.sin(kL * x + 0.4 * wL * t);
  // Coupling to the vertical mixing field: where updraft is pushing
  // water up (negative ay in applyForces), the surface bulges up.
  dy -= 0.8 * A * Math.sin(kU * x + wU * t);
  return world.surfaceY + dy;
}

export function temperatureAt(world: World, x: number, y: number): number {
  const span = Math.max(1, world.height - world.surfaceY);
  const depth = Math.max(0, Math.min(1, (y - world.surfaceY) / span));
  const base = world.tempSurface + (world.tempBottom - world.tempSurface) * depth;
  const kT = (2 * Math.PI) / world.tempPatchLength;
  const wT = (2 * Math.PI) / world.tempPatchPeriod;
  const patch = world.tempPatchAmp * Math.sin(kT * x + wT * world.t);
  return base + patch;
}

// Solar light multiplier 0..1. Sin curve over dayPhase with midday at
// phase 0.25; dark half of cycle returns 0. Multiplied into the depth
// attenuation at every light-using site (photosynthesis, sensor).
export function solarLight(world: World): number {
  return Math.max(0, Math.sin(2 * Math.PI * world.dayPhase));
}

function advanceDayCycle(world: World, dt: number): void {
  world.dayPhase = (world.dayPhase + dt / world.dayPeriod) % 1;
}

// Schedule + ramp disturbance ("storm") intensity. While intensity > 0,
// surface waves, vertical mixing, and brownian forcing are all
// amplified at use sites. Trapezoidal envelope: ramp up 0..1 in first
// 30% of the event, hold, ramp 1..0 in last 30%. Gaps between events
// are picked from [60s, 1200s] so they're irregular.
function advanceDisturbance(world: World, dt: number): void {
  void dt;
  const t = world.t;
  if (world.disturbanceUntil > 0 && t >= world.disturbanceUntil) {
    world.disturbanceUntil = 0;
    world.disturbanceIntensity = 0;
  }
  if (world.disturbanceUntil === 0 && t >= world.nextDisturbanceAt) {
    const duration = 8 + Math.random() * 10;
    world.disturbanceStartedAt = t;
    world.disturbanceUntil = t + duration;
    world.nextDisturbanceAt = world.disturbanceUntil + 60 + Math.random() * 1140;
  }
  if (world.disturbanceUntil > 0) {
    const duration = world.disturbanceUntil - world.disturbanceStartedAt;
    const f = (t - world.disturbanceStartedAt) / duration;
    let i: number;
    if (f < 0.3) i = f / 0.3;
    else if (f > 0.7) i = (1 - f) / 0.3;
    else i = 1;
    world.disturbanceIntensity = Math.max(0, Math.min(1, i));
  }
}

// Lay down the world's terrain: 25 heavy rocks dropped from above
// at random x positions. Each rock falls until it hits the bedrock
// or another rock, then slides sideways downhill if its initial
// contact point isn't directly under the center -- a real rock
// perched off-center on top of another rock tips and falls further
// rather than balancing on a knife edge.
// Number of discrete depth layers rocks can occupy. Rocks at
// different layers don't interact during placement -- they can
// visually overlap, simulating 3D depth on a 2D cross-section.
const ROCK_Z_LAYERS = 5;

export function generateObstacles(world: World): void {
  world.obstacles = [];
  const W = world.width;
  const H = world.height;
  const floorY = H - 4;
  const ROCK_COUNT = 25;
  const ROCK_R_MIN = 22;
  const ROCK_R_MAX = 42;
  const tones = ["#4a4038", "#3a322c", "#52463b", "#403631", "#473d34", "#574b40", "#3d342e"];

  // One heightmap per z layer. A rock at layer k only sees / updates
  // heightmaps[k]; rocks at other layers pass through it during
  // placement. Each layer starts flat at the bedrock.
  const heightmaps: Float32Array[] = [];
  for (let k = 0; k < ROCK_Z_LAYERS; k++) {
    const hm = new Float32Array(W);
    hm.fill(floorY);
    heightmaps.push(hm);
  }

  for (let i = 0; i < ROCK_COUNT; i++) {
    const z = Math.floor(Math.random() * ROCK_Z_LAYERS);
    const heightmap = heightmaps[z];
    const baseR = ROCK_R_MIN + Math.random() * (ROCK_R_MAX - ROCK_R_MIN);
    const elong = 0.85 + Math.random() * 0.9;

    // Pick the random rest x first so we can sample the local slope
    // there. The rock's settle tilt = atan(local slope), so a rock
    // landing on a hillside lies along that hillside instead of
    // being parallel to gravity. Plus a small random jitter so
    // identical surfaces don't all produce identically-tilted rocks.
    const rxInitial = baseR + Math.random() * (W - 2 * baseR);
    const slopeWindow = Math.max(8, baseR * 0.5);
    const hL = heightmap[Math.max(0, Math.floor(rxInitial - slopeWindow))];
    const hR = heightmap[Math.min(W - 1, Math.floor(rxInitial + slopeWindow))];
    const localSlope = (hR - hL) / (2 * slopeWindow);
    const tilt = Math.atan(localSlope) + (Math.random() - 0.5) * 0.4;

    // Build the polygon ONCE around (0, 0) with the chosen tilt; we
    // translate to (rx, ry) at placement time. Compute its per-column
    // bottom/top profile so collision uses the actual jagged shape.
    const protoPoly = buildRockPolygon(0, 0, baseR, elong, tilt);
    const profile = buildPolygonProfile(protoPoly);
    const halfW = Math.max(-profile.minXi, profile.bottom.length + profile.minXi);

    function supportY(rx: number): number {
      let ry = floorY;
      const baseX = Math.floor(rx) + profile.minXi;
      for (let xi = 0; xi < profile.bottom.length; xi++) {
        const b = profile.bottom[xi];
        if (b === -Infinity) continue;
        const wx = baseX + xi;
        if (wx < 0 || wx >= W) continue;
        const candidate = heightmap[wx] - b;
        if (candidate < ry) ry = candidate;
      }
      return ry;
    }

    let rx = Math.max(halfW, Math.min(W - halfW, rxInitial));

    // Roll. Sample a 2-px shift each side; if either lets the rock
    // drop further, move there. Converges when neither direction
    // improves -- supported under center / wide flat / floor.
    for (let iter = 0; iter < 80; iter++) {
      const ry = supportY(rx);
      const leftX = Math.max(halfW, rx - 2);
      const rightX = Math.min(W - halfW, rx + 2);
      const leftRy = supportY(leftX);
      const rightRy = supportY(rightX);
      if (leftRy > ry + 0.25 && leftRy >= rightRy) rx = leftX;
      else if (rightRy > ry + 0.25) rx = rightX;
      else break;
    }
    const ry = supportY(rx);

    // Translate prototype polygon to final position.
    const polygon = protoPoly.map((v) => ({ x: v.x + rx, y: v.y + ry }));
    const lobes = lobesFromPolygon(rx, ry, polygon, baseR);
    const tone = tones[Math.floor(Math.random() * tones.length)];
    const ob = makeObstacleFromLobes(lobes, tone);
    ob.polygon = polygon;
    ob.z = z;
    for (const v of polygon) {
      if (v.x < ob.minX) ob.minX = v.x;
      if (v.y < ob.minY) ob.minY = v.y;
      if (v.x > ob.maxX) ob.maxX = v.x;
      if (v.y > ob.maxY) ob.maxY = v.y;
    }
    world.obstacles.push(ob);

    // Update this layer's heightmap using the polygon's top profile.
    const baseX = Math.floor(rx) + profile.minXi;
    for (let xi = 0; xi < profile.top.length; xi++) {
      const t = profile.top[xi];
      if (t === Infinity) continue;
      const wx = baseX + xi;
      if (wx < 0 || wx >= W) continue;
      const topY = ry + t;
      if (topY < heightmap[wx]) heightmap[wx] = topY;
    }
  }
  // Sort obstacles back-to-front so rendering passes (terrain bitmap,
  // any per-frame redraw) paint deepest rocks first.
  world.obstacles.sort((a, b) => b.z - a.z);
}

// Rasterize a polygon's per-column vertical extent. For each integer
// x in the polygon's footprint, walks the edges to find the lowest
// (max-y) and highest (min-y) points where any edge crosses that
// column. Used so rock collision uses the actual jagged silhouette
// instead of treating the rock as a circle of radius baseR.
function buildPolygonProfile(polygon: { x: number; y: number }[]): {
  minXi: number; bottom: Float32Array; top: Float32Array;
} {
  let minX = Infinity, maxX = -Infinity;
  for (const v of polygon) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
  }
  const minXi = Math.floor(minX);
  const maxXi = Math.ceil(maxX);
  const n = maxXi - minXi + 1;
  const bottom = new Float32Array(n).fill(-Infinity);
  const top = new Float32Array(n).fill(Infinity);
  for (let i = 0; i < polygon.length; i++) {
    const v1 = polygon[i];
    const v2 = polygon[(i + 1) % polygon.length];
    const dx = v2.x - v1.x;
    if (Math.abs(dx) < 1e-6) {
      const xi = Math.round(v1.x) - minXi;
      if (xi >= 0 && xi < n) {
        if (v1.y > bottom[xi]) bottom[xi] = v1.y;
        if (v2.y > bottom[xi]) bottom[xi] = v2.y;
        if (v1.y < top[xi]) top[xi] = v1.y;
        if (v2.y < top[xi]) top[xi] = v2.y;
      }
      continue;
    }
    const xLo = Math.max(minXi, Math.floor(Math.min(v1.x, v2.x)));
    const xHi = Math.min(maxXi, Math.ceil(Math.max(v1.x, v2.x)));
    for (let x = xLo; x <= xHi; x++) {
      const t = (x - v1.x) / dx;
      if (t < 0 || t > 1) continue;
      const y = v1.y + t * (v2.y - v1.y);
      const xi = x - minXi;
      if (y > bottom[xi]) bottom[xi] = y;
      if (y < top[xi]) top[xi] = y;
    }
  }
  return { minXi, bottom, top };
}

// Polygon vertices around a rock center. n vertices distributed around
// 2pi with jittered angles + radii; offset toward an elongation axis so
// the rock isn't radially symmetric.
function buildRockPolygon(
  cx: number, cy: number, baseR: number, elong: number, tilt: number,
): { x: number; y: number }[] {
  const n = 9 + Math.floor(Math.random() * 4);
  const ca = Math.cos(tilt), sa = Math.sin(tilt);
  const verts: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / n;
    // Jitter angle around the even slice so corners aren't symmetric.
    const ang = t * Math.PI * 2 + (Math.random() - 0.5) * (Math.PI / n);
    // Vertex radius with strong variance. Some vertices close, some far.
    const r = baseR * (0.7 + 0.55 * Math.random());
    // Pre-rotation: ellipse aligned with x-axis, then tilt.
    const ex = Math.cos(ang) * r * elong;
    const ey = Math.sin(ang) * r;
    verts.push({
      x: cx + ca * ex - sa * ey,
      y: cy + sa * ex + ca * ey,
    });
  }
  return verts;
}

// Approximate the interior of a polygon with circle lobes for collision.
// Strategy: one large centroid lobe (inscribed-ish) + a small lobe at
// each vertex. Particles in the interior collide with the centroid;
// particles approaching from outside the convex hull collide with the
// nearest vertex lobe. Good enough for stylized terrain.
function lobesFromPolygon(
  cx: number, cy: number, polygon: { x: number; y: number }[], baseR: number,
): ObstacleLobe[] {
  const lobes: ObstacleLobe[] = [{ x: cx, y: cy, r: baseR * 0.85 }];
  for (const v of polygon) {
    lobes.push({ x: v.x, y: v.y, r: baseR * 0.22 });
  }
  return lobes;
}

function makeObstacleFromLobes(lobes: ObstacleLobe[], color: string): Obstacle {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of lobes) {
    if (l.x - l.r < minX) minX = l.x - l.r;
    if (l.y - l.r < minY) minY = l.y - l.r;
    if (l.x + l.r > maxX) maxX = l.x + l.r;
    if (l.y + l.r > maxY) maxY = l.y + l.r;
  }
  return { minX, minY, maxX, maxY, lobes, color, z: 0 };
}

// Push particles + creatures out of any obstacle they overlap. Static
// terrain: zero impulse to the obstacle, full corrective push back on
// the moving body. With ~50-70 total lobes and AABB pre-reject most
// particles bail in the first compare.
// Static spatial index for obstacles. Terrain doesn't move, so the
// index is built once in generateObstacles and reused every tick.
const OBSTACLE_BAND_W = 64;
let OBSTACLE_BANDS: Obstacle[][] = [];
let OBSTACLE_BANDS_COLS = 0;
let OBSTACLES_MIN_Y = Infinity;

function rebuildObstacleIndex(world: World): void {
  OBSTACLES_MIN_Y = Infinity;
  for (const ob of world.obstacles) {
    if (ob.minY < OBSTACLES_MIN_Y) OBSTACLES_MIN_Y = ob.minY;
  }
  OBSTACLE_BANDS_COLS = Math.max(1, Math.ceil(world.width / OBSTACLE_BAND_W));
  OBSTACLE_BANDS = Array.from({ length: OBSTACLE_BANDS_COLS }, () => []);
  const margin = 6;
  for (const ob of world.obstacles) {
    const b0 = Math.max(0, Math.floor((ob.minX - margin) / OBSTACLE_BAND_W));
    const b1 = Math.min(OBSTACLE_BANDS_COLS - 1, Math.floor((ob.maxX + margin) / OBSTACLE_BAND_W));
    for (let i = b0; i <= b1; i++) OBSTACLE_BANDS[i].push(ob);
  }
}

function resolveObstacleCollisions(world: World): void {
  if (world.obstacles.length === 0) return;
  const minY = OBSTACLES_MIN_Y;
  const ps = world.particleStore;
  const pn = world.particles.length;
  collideObstaclesSoa(ps.x, ps.y, ps.vx, ps.vy, ps.r, pn, world.restitution, minY, 0);
  const cn = world.creatures.length;
  // Creatures may belong to different stores (test fixtures use
  // private stores). Per-creature hoist into the right typed arrays.
  for (let k = 0; k < cn; k++) {
    const c = world.creatures[k];
    const cs = c.store;
    collideObstaclesSoaSingle(cs.x, cs.y, cs.vx, cs.vy, cs.r, c.idx, 0.1, minY);
  }
}

// One-particle/creature variant: same math as the array sweep, fixed
// to slot idx. Used for creature obstacle collision since each cell
// can live in a different store.
function collideObstaclesSoaSingle(
  X: Float32Array, Y: Float32Array, VX: Float32Array, VY: Float32Array, R: Float32Array,
  idx: number, e: number, minY: number,
): void {
  const rk = R[idx];
  if (Y[idx] + rk < minY) return;
  const xk = X[idx], yk = Y[idx];
  let bx = Math.floor(xk / OBSTACLE_BAND_W);
  if (bx < 0) bx = 0; else if (bx >= OBSTACLE_BANDS_COLS) bx = OBSTACLE_BANDS_COLS - 1;
  const obs = OBSTACLE_BANDS[bx];
  let ox = xk, oy = yk, ovx = VX[idx], ovy = VY[idx];
  for (let i = 0; i < obs.length; i++) {
    const ob = obs[i];
    if (ox + rk < ob.minX || ox - rk > ob.maxX) continue;
    if (oy + rk < ob.minY || oy - rk > ob.maxY) continue;
    const lobes = ob.lobes;
    for (let j = 0; j < lobes.length; j++) {
      const l = lobes[j];
      const dx = ox - l.x;
      const dy = oy - l.y;
      const minDist = rk + l.r;
      const d2 = dx * dx + dy * dy;
      if (d2 >= minDist * minDist) continue;
      let d = Math.sqrt(d2);
      let nx = 0, ny = -1;
      if (d < 1e-6) { d = 1; nx = 1; ny = 0; }
      else { nx = dx / d; ny = dy / d; }
      const overlap = minDist - d;
      ox += nx * overlap;
      oy += ny * overlap;
      const vN = ovx * nx + ovy * ny;
      if (vN < 0) {
        ovx -= (1 + e) * vN * nx;
        ovy -= (1 + e) * vN * ny;
      }
    }
  }
  X[idx] = ox; Y[idx] = oy; VX[idx] = ovx; VY[idx] = ovy;
}

// Contiguous-index version: used for particles where slot i corresponds
// to world.particles[i]. No indirection.
function collideObstaclesSoa(
  X: Float32Array, Y: Float32Array, VX: Float32Array, VY: Float32Array, R: Float32Array,
  n: number, e: number, minY: number, _pad: number,
): void {
  void _pad;
  for (let k = 0; k < n; k++) {
    const yk = Y[k]; const rk = R[k];
    if (yk + rk < minY) continue;
    const xk = X[k];
    let bx = Math.floor(xk / OBSTACLE_BAND_W);
    if (bx < 0) bx = 0; else if (bx >= OBSTACLE_BANDS_COLS) bx = OBSTACLE_BANDS_COLS - 1;
    const obs = OBSTACLE_BANDS[bx];
    let ox = xk, oy = yk, ovx = VX[k], ovy = VY[k];
    for (let i = 0; i < obs.length; i++) {
      const ob = obs[i];
      if (ox + rk < ob.minX || ox - rk > ob.maxX) continue;
      if (oy + rk < ob.minY || oy - rk > ob.maxY) continue;
      const lobes = ob.lobes;
      for (let j = 0; j < lobes.length; j++) {
        const l = lobes[j];
        const dx = ox - l.x;
        const dy = oy - l.y;
        const minDist = rk + l.r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= minDist * minDist) continue;
        let d = Math.sqrt(d2);
        let nx = 0, ny = -1;
        if (d < 1e-6) { d = 1; nx = 1; ny = 0; }
        else { nx = dx / d; ny = dy / d; }
        const overlap = minDist - d;
        ox += nx * overlap;
        oy += ny * overlap;
        const vN = ovx * nx + ovy * ny;
        if (vN < 0) {
          ovx -= (1 + e) * vN * nx;
          ovy -= (1 + e) * vN * ny;
        }
      }
    }
    X[k] = ox; Y[k] = oy; VX[k] = ovx; VY[k] = ovy;
  }
}

// Scatter-index version: used for creatures whose store slots are
// non-contiguous after free-list reuse. idx[k] maps world.creatures[k]
// to its slot in the typed arrays.
function tempMult(T: number): number {
  const m = Math.pow(TEMP_Q10, (T - TEMP_REF) / 10);
  return Math.max(TEMP_MULT_MIN, Math.min(TEMP_MULT_MAX, m));
}

export function createWorld(width: number, height: number): World {
  const particleTarget = Math.max(100, Math.round(width * height * PARTICLE_DENSITY_PER_AREA));
  const world: World = {
    width, height,
    depth: 24,
    t: 0,
    particles: [],
    particleStore: new ParticleStore(Math.max(256, particleTarget)),
    creatures: [],
    creatureStore: new CreatureStore(512),
    particleTarget,
    particleSpawnRate: Math.min(MAX_SPAWN_PER_SEC, Math.max(5, particleTarget * PARTICLE_SPAWN_RATIO)),
    extinctionCount: 0,
    liveLineageRoots: new Set(),
    nextLineageRoot: 0,
    founderTarget: FOUNDER_TARGET,
    gravity: 60,
    drag: 0.6,
    surfaceAmp: 55, surfaceLength: 200, surfacePeriod: 7, surfaceDecay: 90,
    swellAmp: 5, swellLength: 600, swellPeriod: 18, swellDecay: 520,
    zStirAmp: 4,
    updraftAmp: 4, updraftLength: 540, updraftPeriod: 28,
    surfaceY: height * SURFACE_Y_FRAC,
    surfaceWaveAmp: 14,
    aerationRate: width * AERATION_PER_PX,
    tempSurface: 28,
    tempBottom: 12,
    tempPatchAmp: 3,
    tempPatchLength: 360,
    tempPatchPeriod: 38,
    pheromone: new Float32Array(0),
    pheromoneCols: 0,
    pheromoneRows: 0,
    restitution: 0.15, xWallRestitution: 0.4, zWallRestitution: 0.6,
    collisionIters: 1,
    species: new Map(),
    phylogenyEvents: [],
    nextSpeciesLane: 0,
    anchorGenome: new Uint8Array(0),
    brownianAmp: 18,
    dayPhase: 0.2, // start a bit before noon so first day shows
    dayPeriod: 90,
    disturbanceIntensity: 0,
    disturbanceStartedAt: 0,
    disturbanceUntil: 0,
    nextDisturbanceAt: 60 + Math.random() * 240,
    currentAmp: CURRENT_AMP,
    vmInstrBudget: DEFAULT_VM_INSTR_BUDGET,
    obstacles: [],
  };
  // Allocate the pheromone grid sized to the world.
  resizePheromone(world);
  generateObstacles(world);
  rebuildObstacleIndex(world);
  // World starts empty: just water and a handful of founder cells.
  // Each founder is independent (its own genome, its own lineageRoot
  // id) so we get several parallel lineages to watch. Particles
  // trickle in via replenishParticles() afterward.
  const initialFounders = INITIAL_FOUNDER_MIN + Math.floor(Math.random() * (INITIAL_FOUNDER_MAX - INITIAL_FOUNDER_MIN + 1));
  for (let i = 0; i < initialFounders; i++) {
    const f = spawnFounder(world);
    // The very first founder also anchors the color palette so other
    // cells visually contrast with it.
    if (i === 0) {
      world.anchorGenome = new Uint8Array(f.genome);
      f.color = genomeColor(f.genome, world.anchorGenome);
    }
  }
  return world;
}

// Founder spawn count + steady-state target. Initial world drops in
// random[MIN, MAX] founders; later top-ups push the live count back
// toward TARGET whenever it falls below.
const INITIAL_FOUNDER_MIN = 15;
const INITIAL_FOUNDER_MAX = 25;
const FOUNDER_TARGET = 25;

function spawnFounder(world: World): Creature {
  const x = world.width * (0.1 + 0.8 * Math.random());
  const y = world.height * (0.1 + 0.6 * Math.random());
  const z = world.depth * 0.5;
  const c = makeCreature(world, x, y, z);
  c.bornAt = world.t;
  c.lineageRoot = world.nextLineageRoot++;
  world.creatures.push(c);
  noteCreatureBirth(world, c, undefined);
  return c;
}

export function seedParticles(world: World, n: number): void {
  world.particles.length = 0;
  world.particleStore.n = 0;
  for (let i = 0; i < n; i++) {
    const r = 1 + Math.random() * 1.5;
    // Spawn below the surface so the initial state matches the wall.
    const yRange = (world.height - world.surfaceY) * 0.85;
    const mat = pickMaterial();
    pushParticle(world, {
      x: Math.random() * world.width,
      y: world.surfaceY + Math.random() * yRange,
      z: r + Math.random() * (world.depth - 2 * r),
      vx: 0, vy: 0, vz: (Math.random() - 0.5) * 20,
      r,
      material: mat,
      density: rollDensity(mat),
    });
  }
}

// Per-spawn density jitter. Organic biomatter ranges from oily/lipid-rich
// (floats) to dense protein clumps (sinks); randomize each particle so
// the cloud actually mixes vertically instead of forming a flat stratum.
// Triangular distribution centered on the material's base density.
function rollDensity(material: MaterialId): number | undefined {
  if (material !== "organic") return undefined;
  const tri = Math.random() + Math.random() - 1; // -1..1, triangle peak 0
  return 1.0 + tri * 0.3; // 0.7..1.3
}

function pickMaterial(): MaterialId {
  let total = 0;
  for (const [, w] of SEED_WEIGHTS) total += w;
  let pick = Math.random() * total;
  for (const [id, w] of SEED_WEIGHTS) {
    pick -= w;
    if (pick <= 0) return id;
  }
  return SEED_WEIGHTS[SEED_WEIGHTS.length - 1][0];
}

function emptyReserves(): Record<MaterialId, number> {
  const r = {} as Record<MaterialId, number>;
  for (const id of MATERIAL_IDS) r[id] = 0;
  return r;
}

function makeCreature(world: World, x: number, y: number, z: number): Creature {
  // Founders get a random viable genome instead of the hand-crafted
  // default. Each reseed explores a different starting strategy
  // (heterotroph / photoautotroph / predator / etc.) -- natural
  // selection picks the survivors rather than the designer.
  const genome = makeRandomViableGenome();
  const c = newCreature(world.creatureStore, {
    x, y, z,
    r: MIN_CREATURE_R,
    density: 1.0,
    energy: 30,
    senseRange: computeSenseRange(genome),
    thrustAccel: computeThrustAccel(genome),
    genome,
    vm: newVMState(),
    color: genomeColor(genome),
    speciesKey: genomeKey(genome),
    // Starter cell ships with a working metabolism: enough ATP to live, a
    // matched ADP pool, some glucose and O2 to run respiration, a little
    // amino-acid / minerals / fatty-acid for biosynthesis and movement,
    // and biomass to give it physical body. Plus a few ribosomes so it
    // can actually run biosynthesis from tick 1 (with the strict
    // ribosome model, zero ribosomes means zero biosynth -- founders
    // would die before they had a chance to bootstrap).
    molecules: {
      adp: 50, glucose: 20, fattyAcid: 15, aminoAcid: 15,
      o2: 15, minerals: 15, biomass: 30, ribosome: 3,
    },
    // Seed reserves across all materials so the cell can pay the per-byte
    // fission cost (genomeMaterialCost is spread across all 6 materials)
    // without first having to ingest one particle of every type. Without
    // this, a cell can ingest organic until its reproduce-threshold is met
    // but still fail to fission because (say) reserves.sand is still 0.
    reserves: { rock: 4, sand: 15, clay: 12, organic: 30, lipid: 12, gas: 6 },
  });
  updateCreatureRadius(c);
  return c;
}

export function genomeKey(genome: Uint8Array): string {
  let s = "";
  for (let i = 0; i < genome.length; i++) {
    const b = genome[i];
    s += (b < 16 ? "0" : "") + b.toString(16);
  }
  return s;
}

const PHYLO_EVENT_CAP = 2000;

function noteCreatureBirth(world: World, c: Creature, parentKey: string | undefined): void {
  const key = genomeKey(c.genome);
  let sp = world.species.get(key);
  const wasNew = !sp;
  if (!sp) {
    sp = {
      key,
      color: c.color,
      firstSeen: world.t,
      lastSeen: world.t,
      alive: 0,
      parents: new Set<string>(),
      lane: world.nextSpeciesLane++,
      genome: new Uint8Array(c.genome),
      execCounts: new Uint32Array(MAX_GENOME_BYTES),
      vmTicks: 0,
      peakBiomass: 0,
    };
    world.species.set(key, sp);
  }
  sp.lastSeen = world.t;
  sp.alive++;
  if (parentKey && parentKey !== key && !sp.parents.has(parentKey)) {
    sp.parents.add(parentKey);
    world.phylogenyEvents.push({
      t: world.t,
      from: parentKey,
      to: key,
      convergence: !wasNew,
    });
    if (world.phylogenyEvents.length > PHYLO_EVENT_CAP) {
      world.phylogenyEvents.splice(0, world.phylogenyEvents.length - PHYLO_EVENT_CAP);
    }
  }
}

function noteCreatureDeath(world: World, c: Creature): void {
  const sp = world.species.get(c.speciesKey);
  if (!sp) return;
  sp.alive = Math.max(0, sp.alive - 1);
  sp.lastSeen = world.t;
}

// Species accumulate forever otherwise. drawPhylogeny iterates the
// whole map each frame; an hours-long run can pile up tens of thousands
// of entries, all dead, and gradually slow the renderer. Drop any
// species that has been extinct AND off the visible phylogeny window
// for a generous grace period. Also drop their phylogeny edges.
const SPECIES_GRACE_SEC = 240;
const SPECIES_PRUNE_INTERVAL_SEC = 5;
let lastSpeciesPruneAt = -SPECIES_PRUNE_INTERVAL_SEC;
function pruneSpecies(world: World): void {
  if (world.t - lastSpeciesPruneAt < SPECIES_PRUNE_INTERVAL_SEC) return;
  lastSpeciesPruneAt = world.t;
  const cutoff = world.t - SPECIES_GRACE_SEC;
  const drop = new Set<string>();
  for (const sp of world.species.values()) {
    if (sp.alive === 0 && sp.lastSeen < cutoff) drop.add(sp.key);
  }
  if (drop.size === 0) return;
  for (const key of drop) world.species.delete(key);
  for (let i = world.phylogenyEvents.length - 1; i >= 0; i--) {
    const ev = world.phylogenyEvents[i];
    if (drop.has(ev.from) || drop.has(ev.to)) world.phylogenyEvents.splice(i, 1);
  }
}

// Charge an ATP cost. Caps at available ATP and routes the spent mass into
// ADP so the cell can later re-charge it via respiration. Returns the amount
// actually paid (which may be less than requested if the cell ran out).
function spendATP(c: Creature, want: number): number {
  if (want <= 0) return 0;
  const s = c.store; const i = c.idx;
  const e = s.energy[i];
  const got = e < want ? e : want;
  s.energy[i] = e - got;
  s.m_adp[i] += got;
  return got;
}

function sat(x: number, km: number = KM_DEFAULT): number {
  return x > 0 ? x / (x + km) : 0;
}

// Convert undigested reserves into named molecules. Mass-conserving:
// each row of CATAB_FRACTIONS sums to 1.
function catabolize(c: Creature, dt: number): void {
  const s = c.store; const i = c.idx;
  const surface = s.r[i] / MIN_CREATURE_R;
  const resCols = s.resCols;
  const molCols = s.molCols;
  for (let m = 0; m < 6; m++) {
    const rc = resCols[m];
    const avail = rc[i];
    if (avail <= 0) continue;
    const rate = CATAB_VMAX_PER_R * surface * (avail / (avail + CATAB_KM));
    const rd = rate * dt;
    const amt = rd < avail ? rd : avail;
    if (amt <= 0) continue;
    rc[i] = avail - amt;
    const targets = CATAB_TARGETS_MOL[m];
    const fracs = CATAB_TARGETS_FRAC[m];
    for (let k = 0; k < targets.length; k++) {
      molCols[targets[k]][i] += amt * fracs[k];
    }
  }
}

// Passive diffusion of O2 and CO2 across the cell membrane. Both flow down
// their concentration gradient between the cell and the surrounding water,
// with rate proportional to surface area. This is how dissolved gases
// equilibrate in real cells -- the genome doesn't have to plan for it.
function diffuseGases(c: Creature, dt: number): void {
  const s = c.store; const i = c.idx;
  const surface = s.r[i] / MIN_CREATURE_R;
  const o2Grad = O2_AMBIENT - s.m_o2[i];
  s.m_o2[i] += O2_DIFFUSION_PER_R * surface * o2Grad * dt * 0.1;
  const co2 = s.m_co2[i];
  const co2Grad = co2 - CO2_AMBIENT;
  if (co2Grad > 0) {
    s.m_co2[i] = co2 - CO2_OFFGAS_PER_R * surface * co2Grad * dt * 0.1;
  }
}

// Aerobic respiration / fermentation / beta-oxidation / photosynthesis
// were each a dedicated function reading m_* fields and mutating
// them in place. In phase 2 they're all entries in REACTIONS[0..3]
// driven by runGenericReactions(), with uncatRate matching the old
// VMAX -- catalyst pool only adds on top. ATP/ADP mass conservation
// is handled by the engine (atpDelta is the energy delta; the same
// magnitude flows the other way through chemCols[CHEM_ADP]).

// ATP floor: biosynthesis tapers off as the cell's ATP approaches
// this value, and stops entirely below it. Without this, a newborn
// with limited ATP burns through it building expensive products
// (chlorophyll at 8 ATP/unit, enzyme at 4) it doesn't actually need
// yet, and starves before respiration can refill the pool. Real cells
// downregulate growth under energy stress; this is the same idea.
const BIOSYNTH_ATP_FLOOR = 4;

// biosynthesize() retired in phase 2 -- all biosynth pathways are now
// table entries in REACTIONS[4..9] driven by runGenericReactions().

// Build catalyst into the catalystCols[slot] pool. Same shape as
// biosynthesize() but the product lives in the per-slot Float32Array
// rather than a Molecules key. Substrate is 0.5 aa + 0.5 min, same as
// enzymes / chlorophyll / ribosomes.
function biosynthCatalyst(
  c: Creature,
  dt: number,
  vmax: number,
  atpCost: number,
  slot: number,
): void {
  const s = c.store; const i = c.idx;
  const colA = s.molCols[MOLECULE_INDEX["aminoAcid"]];
  const colB = s.molCols[MOLECULE_INDEX["minerals"]];
  const colP = s.catalystCols[slot];
  const a = colA[i], b = colB[i], e = s.energy[i];
  if (a <= 0 || b <= 0 || e <= BIOSYNTH_ATP_FLOOR) return;
  const aFrac = a / 0.5, bFrac = b / 0.5;
  const eAvail = (e - BIOSYNTH_ATP_FLOOR) / atpCost;
  const rate = vmax * sat(aFrac) * sat(bFrac) * sat(eAvail);
  const rdt = rate * dt;
  let amt = rdt < aFrac ? rdt : aFrac;
  if (bFrac < amt) amt = bFrac;
  if (eAvail < amt) amt = eAvail;
  if (amt <= 0) return;
  colA[i] = a - 0.5 * amt;
  colB[i] = b - 0.5 * amt;
  s.energy[i] = e - atpCost * amt;
  colP[i] += amt;
  s.m_adp[i] += atpCost * amt;
}

function autoExcrete(c: Creature, world: World): void {
  const s = c.store; const i = c.idx;
  const overFlow = world.particles.length >= world.particleTarget;
  const co2 = s.m_co2[i];
  if (co2 > CO2_EXCRETE_THRESHOLD) {
    const want = co2 - EXCRETE_FLOOR;
    const affordable = Math.min(want, s.energy[i] / EXCRETE_ATP_PER_MASS);
    if (affordable > 0) {
      spendATP(c, affordable * EXCRETE_ATP_PER_MASS);
      s.m_co2[i] -= affordable;
      if (!overFlow) {
        const mol = emptyMolecules();
        mol.co2 = affordable;
        spawnExcretedParticle(c, world, "gas", affordable, mol);
      }
    }
  }
  const waste = s.m_waste[i];
  if (waste > WASTE_EXCRETE_THRESHOLD) {
    const want = waste - EXCRETE_FLOOR;
    const affordable = Math.min(want, s.energy[i] / EXCRETE_ATP_PER_MASS);
    if (affordable > 0) {
      spendATP(c, affordable * EXCRETE_ATP_PER_MASS);
      s.m_waste[i] -= affordable;
      if (!overFlow) {
        const mol = emptyMolecules();
        mol.waste = affordable;
        spawnExcretedParticle(c, world, "organic", affordable, mol);
      }
    }
  }
}

// Structural turnover: biomass / enzyme / chloro decay continuously, mass
// returning to the substrates they were synthesized from. The cell must
// keep biosynthesizing to maintain its body. Decay never recovers ATP --
// the energy that went into building these molecules is gone.
//
// Decay rate scales up under metabolic stress. A well-fed cell with ATP
// in hand sits at the baseline rate; a starving cell (ATP near zero) sees
// up to ~5x decay because it can't run the maintenance reactions that
// would normally replenish what's falling apart. This is the channel
// that kills cells which have lost the ability to ingest -- they bleed
// structure faster than their own catabolism can rebuild it.
function maintenanceDecay(c: Creature, dt: number): void {
  const s = c.store; const i = c.idx;
  const stressMult = 1 + 4 * Math.max(0, 1 - s.energy[i] / 8);
  const bio = s.m_biomass[i];
  if (bio > 0) {
    const lost = bio * BIOMASS_DECAY_PER_SEC * stressMult * dt;
    s.m_biomass[i] = bio - lost;
    s.m_aminoAcid[i] += 0.9 * lost;
    s.m_fattyAcid[i] += 0.1 * lost;
  }
  const enz = s.m_enzyme[i];
  if (enz > 0) {
    const lost = enz * ENZYME_DECAY_PER_SEC * stressMult * dt;
    s.m_enzyme[i] = enz - lost;
    s.m_aminoAcid[i] += 0.5 * lost;
    s.m_minerals[i] += 0.5 * lost;
  }
  const chl = s.m_chlorophyll[i];
  if (chl > 0) {
    const lost = chl * CHLORO_DECAY_PER_SEC * stressMult * dt;
    s.m_chlorophyll[i] = chl - lost;
    s.m_aminoAcid[i] += 0.5 * lost;
    s.m_minerals[i] += 0.5 * lost;
  }
  const rib = s.m_ribosome[i];
  if (rib > 0) {
    const lost = rib * RIBO_DECAY_PER_SEC * stressMult * dt;
    s.m_ribosome[i] = rib - lost;
    s.m_aminoAcid[i] += 0.5 * lost;
    s.m_minerals[i] += 0.5 * lost;
  }
  for (let k = 0; k < CATALYST_COUNT; k++) {
    const col = s.catalystCols[k];
    const v = col[i];
    if (v > 0) {
      const lost = v * CAT_DECAY_PER_SEC * stressMult * dt;
      col[i] = v - lost;
      s.m_aminoAcid[i] += 0.5 * lost;
      s.m_minerals[i] += 0.5 * lost;
    }
  }
}

// Chemistry for an engulfed cell (endosymbiont). No VM, no motion,
// no excretion to world particles. Same metabolic reactions a free
// cell runs, gated by the inner's static organelleSynthMask. Then
// small molecules diffuse bidirectionally between inner and host so
// surplus ATP / glucose / etc. flows where it's useful. This is the
// whole "subsumed cell becomes organelle" mechanic.
const ORGANELLE_DIFFUSE_PER_SEC = 0.5;   // fraction of (inner - host) gap that crosses per sec
const ORGANELLE_DIFFUSE_KEYS: (keyof Molecules)[] = [
  "glucose", "fattyAcid", "aminoAcid", "minerals", "o2", "co2", "adp", "waste",
];
function runOrganelleChemistry(
  inner: Creature,
  host: Creature,
  dt: number,
  dtT: number,
  light: number,
): void {
  // Reserve catabolism still hand-coded (it operates on the reserves
  // side, not chemCols). Everything else goes through the table.
  catabolize(inner, dtT);
  runGenericReactions(inner, dtT, light, inner.organelleSynthMask);
  maintenanceDecay(inner, dt);

  // Bidirectional diffusion of small molecules + ATP between inner
  // and host. Net flow toward the lower concentration -- surplus
  // products leak out, scarce substrates leak in. Mass-conserving.
  const rate = ORGANELLE_DIFFUSE_PER_SEC * dt;
  // ATP
  const dAtp = (inner.energy - host.energy) * rate;
  inner.energy -= dAtp;
  host.energy += dAtp;
  // Tracked molecules
  const innerMol = inner.molecules;
  const hostMol = host.molecules;
  for (const k of ORGANELLE_DIFFUSE_KEYS) {
    const d = (innerMol[k] - hostMol[k]) * rate;
    innerMol[k] = innerMol[k] - d;
    hostMol[k] = hostMol[k] + d;
  }
}

// Oxidative damage from accumulated waste / CO2. Above the excretion
// thresholds, biomass is converted directly to waste at a rate scaling
// with the excess. Net effect: a cell that can pay the excretion ATP
// cost stays clean; one that can't suffers proportional damage.
function toxify(c: Creature, dt: number): void {
  const s = c.store; const i = c.idx;
  const co2 = s.m_co2[i], waste = s.m_waste[i], bio = s.m_biomass[i];
  let excess = 0;
  if (co2 > CO2_EXCRETE_THRESHOLD) excess += co2 - CO2_EXCRETE_THRESHOLD;
  if (waste > WASTE_EXCRETE_THRESHOLD) excess += waste - WASTE_EXCRETE_THRESHOLD;
  if (excess <= 0 || bio <= 0) return;
  const want = excess * TOX_DAMAGE_PER_EXCESS_PER_SEC * dt;
  const damage = want < bio ? want : bio;
  s.m_biomass[i] = bio - damage;
  s.m_waste[i] = waste + damage;
}

function spawnExcretedParticle(
  c: Creature,
  world: World,
  material: MaterialId,
  m: number,
  molecules?: Molecules,
): void {
  if (m < EXCRETE_MIN_AMOUNT) {
    // Round-off; just drop it on the floor of the cell (lose to environment).
    return;
  }
  const density = MATERIALS[material].density;
  const pr = Math.max(1.5, radiusForMass(m, density));
  const angle = Math.random() * Math.PI * 2;
  const ejectV = 25;
  pushParticle(world, {
    x: c.x + Math.cos(angle) * (c.r + pr + 1),
    y: c.y + Math.sin(angle) * (c.r + pr + 1),
    z: Math.min(world.depth - pr, Math.max(pr, c.z)),
    vx: Math.cos(angle) * ejectV,
    vy: Math.sin(angle) * ejectV,
    vz: (Math.random() - 0.5) * 10,
    r: pr,
    material,
    molecules,
  });
}

// Levenshtein edit distance between two genomes. Bounded by the larger of
// the two lengths. Genomes are <= 256 bytes so the O(n*m) cost is fine.
// Single-crossover recombination of two genomes. The result has the
// parent's length (so size-based costs are stable). Bytes 0..k come
// from parent a, bytes k..end from parent b; if b is shorter we fall
// back to a's tail. k is uniformly random.
// Apply a SPLICE_DUP / SPLICE_DEL request to a cell's live genome.
// mode 1 = duplicate the [off, off+len) region in place; mode 2 = delete
// it. Genome length is clamped to [1, MAX_GENOME_BYTES]. PC is taken
// mod the new length so the next tick resumes somewhere valid.
function applyGenomeSplice(c: Creature, mode: number, off: number, len: number): void {
  const g = c.genome;
  const L = g.length;
  if (L === 0 || len <= 0) return;
  const a = ((off % L) + L) % L;
  const b = Math.min(L, a + len);
  if (b <= a) return;
  let next: Uint8Array;
  if (mode === 1) {
    // Duplicate: [0..L) -> [0..b) + [a..b) (the duplicated region) + [b..L)
    const dupLen = b - a;
    const newLen = Math.min(MAX_GENOME_BYTES, L + dupLen);
    next = new Uint8Array(newLen);
    next.set(g.subarray(0, Math.min(b, newLen)), 0);
    // Copy the duplicate region after the original; cap to newLen.
    const dupStart = b;
    const dupEnd = Math.min(newLen, dupStart + dupLen);
    if (dupEnd > dupStart) next.set(g.subarray(a, a + (dupEnd - dupStart)), dupStart);
    // Tail (originally [b..L))
    const tailStart = dupEnd;
    const tailLen = Math.min(L - b, newLen - tailStart);
    if (tailLen > 0) next.set(g.subarray(b, b + tailLen), tailStart);
  } else if (mode === 2) {
    // Delete: keep [0..a) and [b..L).
    const newLen = Math.max(1, L - (b - a));
    next = new Uint8Array(newLen);
    next.set(g.subarray(0, a), 0);
    if (newLen > a) next.set(g.subarray(b, b + (newLen - a)), a);
  } else {
    return;
  }
  c.genome = next;
  if (c.vm.pc >= next.length) c.vm.pc = c.vm.pc % next.length;
}

function crossoverGenomes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const len = a.length;
  if (len === 0) return new Uint8Array(b);
  const out = new Uint8Array(len);
  const k = Math.floor(Math.random() * (len + 1));
  for (let i = 0; i < k; i++) out[i] = a[i];
  for (let i = k; i < len; i++) out[i] = i < b.length ? b[i] : a[i];
  return out;
}

export function genomeDistance(a: Uint8Array, b: Uint8Array): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Int32Array(n + 1);
  const cur = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const sub = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + sub);
    }
    prev.set(cur);
  }
  return prev[n];
}

// Cell color. With no anchor, uses a deterministic hash-based hue at fixed
// saturation/lightness. With an anchor, an exact-match genome paints white
// and the color fades toward the hash hue as edit distance grows.
const COLOR_SAT_FULL = 60;
const COLOR_LIGHT_FULL = 62;
const COLOR_DIST_FULL = 24;

export function genomeColor(genome: Uint8Array, anchor?: Uint8Array): string {
  let h = 5381 >>> 0;
  for (let i = 0; i < genome.length; i++) {
    h = ((h * 33) ^ genome[i]) >>> 0;
  }
  const hue = h % 360;
  if (!anchor) {
    return `hsl(${hue}, ${COLOR_SAT_FULL}%, ${COLOR_LIGHT_FULL}%)`;
  }
  const d = Math.min(1, genomeDistance(genome, anchor) / COLOR_DIST_FULL);
  const sat = COLOR_SAT_FULL * d;
  const light = 100 - (100 - COLOR_LIGHT_FULL) * d;
  return `hsl(${hue}, ${sat.toFixed(1)}%, ${light.toFixed(1)}%)`;
}

// Particle mass = density * (4/3) * pi * r^3. Particles are spheres; the
// circle we render is the equatorial cross-section. Same convention as cells.
function mass(p: Particle): number {
  const d = p.density ?? MATERIALS[p.material].density;
  return d * (4 / 3) * Math.PI * p.r * p.r * p.r;
}

// Inverse: given a target mass and material density, what sphere radius
// does it correspond to?
function radiusForMass(m: number, density: number): number {
  return Math.cbrt((3 * m) / (4 * Math.PI * density));
}

export function step(world: World, dt: number): void {
  world.t += dt;
  // Snapshot living lineages at the *start* of this step so we can
  // count lineage extinctions at the end (any lineageRoot that was
  // alive going in but isn't alive coming out has gone extinct this
  // step). Includes lineages from cells manually pushed by tests.
  world.liveLineageRoots.clear();
  for (const c of world.creatures) world.liveLineageRoots.add(c.lineageRoot);
  advanceDayCycle(world, dt);
  advanceDisturbance(world, dt);
  const p = world.profile;
  if (p) {
    let m = performance.now();
    evolvePheromone(world, dt);
    let n = performance.now(); p.pheromone += n - m; m = n;
    applyBondSprings(world, dt);
    n = performance.now(); p.bonds += n - m; m = n;
    applyForces(world, dt);
    n = performance.now(); p.forces += n - m; m = n;
    updateCreatures(world, dt);
    n = performance.now(); p.creatures += n - m; m = n;
    resolveCollisions(world);
    n = performance.now(); p.particleColl += n - m; m = n;
    resolveCreatureCollisions(world);
    n = performance.now(); p.creatureColl += n - m; m = n;
    resolveCreatureSedimentCollisions(world);
    n = performance.now(); p.sedimentColl += n - m; m = n;
    resolveObstacleCollisions(world);
    n = performance.now(); p.obstacleColl += n - m; m = n;
    applyWalls(world);
    n = performance.now(); p.walls += n - m; m = n;
    aerate(world, dt);
    n = performance.now(); p.aerate += n - m; m = n;
    replenishParticles(world, dt);
    n = performance.now(); p.replenish += n - m; m = n;
    decayParticles(world, dt);
    n = performance.now(); p.replenish += n - m; m = n;
    pruneSpecies(world);
    n = performance.now(); p.prune += n - m;
    p.ticks++;
  } else {
    evolvePheromone(world, dt);
    applyBondSprings(world, dt);
    applyForces(world, dt);
    updateCreatures(world, dt);
    resolveCollisions(world);
    resolveCreatureCollisions(world);
    resolveCreatureSedimentCollisions(world);
    resolveObstacleCollisions(world);
    applyWalls(world);
    aerate(world, dt);
    replenishParticles(world, dt);
    decayParticles(world, dt);
    pruneSpecies(world);
  }
  // Count lineage extinctions. Any lineageRoot that was alive at the
  // *start* of this step but isn't alive now has gone extinct in this
  // tick. A lone lineage dying counts as 1, a full world wipeout
  // counts as N. Done before top-up so freshly spawned replacement
  // founders don't show up in the post-set.
  const currentLineages = new Set<number>();
  for (const c of world.creatures) currentLineages.add(c.lineageRoot);
  for (const id of world.liveLineageRoots) {
    if (!currentLineages.has(id)) world.extinctionCount++;
  }

  // Top up founding lineages. If the live count is below
  // world.founderTarget, spawn fresh founders (each viability-filtered
  // by makeRandomViableGenome) until we reach the target.
  //
  // The over-cap gate's permissiveness scales with how depleted the
  // lineage pool is. At a healthy full house of lineages, enforce a
  // 2x particle cap as a real throttle on successful runs. As
  // lineages die off, loosen toward "no throttle" -- when the world
  // is down to one barely-alive lineage that can't possibly drain
  // the surplus before dying, we shouldn't be the reason recovery
  // can't start. Death-released particles bypass the replenish/aerate
  // caps because autolysis can't refuse to produce its mass.
  const deficit = Math.max(0, world.founderTarget - currentLineages.size);
  const capMult = 2 + deficit * 0.8;
  const allDead = currentLineages.size === 0;
  const overCap = world.particles.length >= world.particleTarget * capMult;
  if (world.founderTarget > 0 && (allDead || !overCap) && currentLineages.size < world.founderTarget) {
    const wasEmpty = currentLineages.size === 0;
    const need = world.founderTarget - currentLineages.size;
    for (let i = 0; i < need; i++) {
      const f = spawnFounder(world);
      // When the world had just gone fully empty, the first new
      // founder also re-anchors the color palette so descendant
      // coloring restarts relative to this new root.
      if (wasEmpty && i === 0) {
        world.anchorGenome = new Uint8Array(f.genome);
        f.color = genomeColor(f.genome, world.anchorGenome);
      }
    }
  }
}

// Particle aging + decay. Every particle accumulates age every tick.
// After PARTICLE_DECAY_START_AGE seconds of grace, its radius shrinks
// at PARTICLE_DECAY_HALF_LIFE (exponential half-life). When it falls
// below PARTICLE_MIN_R the particle is removed. Models decomposition
// by unmodeled microbiota -- corpse mass that no cell ate has to go
// somewhere or particle counts creep monotonically up.
const PARTICLE_DECAY_START_AGE = 300; // sim-seconds before decay begins
const PARTICLE_DECAY_HALF_LIFE = 60;  // sim-seconds; r halves every 60s once decaying
const PARTICLE_MIN_R = 0.4;
function decayParticles(world: World, dt: number): void {
  const ps = world.particleStore;
  const age = ps.age;
  const r = ps.r;
  // Same exponential factor for every decaying particle this tick.
  const decayFactor = Math.pow(0.5, dt / PARTICLE_DECAY_HALF_LIFE);
  for (let i = world.particles.length - 1; i >= 0; i--) {
    age[i] += dt;
    if (age[i] <= PARTICLE_DECAY_START_AGE) continue;
    r[i] *= decayFactor;
    if (r[i] < PARTICLE_MIN_R) removeParticleAt(world, i);
  }
}

function replenishParticles(world: World, dt: number): void {
  if (world.particles.length >= world.particleTarget) return;
  const expected = world.particleSpawnRate * dt;
  let toSpawn = Math.floor(expected);
  if (Math.random() < expected - toSpawn) toSpawn++;
  for (let i = 0; i < toSpawn && world.particles.length < world.particleTarget; i++) {
    const r = 1 + Math.random() * 1.5;
    const mat = pickMaterial();
    pushParticle(world, {
      x: Math.random() * world.width,
      y: world.surfaceY + r,
      z: r + Math.random() * (world.depth - 2 * r),
      vx: 0, vy: 0, vz: (Math.random() - 0.5) * 20,
      r,
      material: mat,
      density: rollDensity(mat),
    });
  }
}

// Aeration: at the water surface, fresh gas particles tagged with O2
// drop in. They start with a downward velocity (so they don't escape
// instantly back through the same surface they entered through) and
// carry molecule-level O2 -- cells that ingest them get straight O2 in
// their molecule pool, just like other molecule-tagged particles.
function aerate(world: World, dt: number): void {
  if (world.particles.length >= world.particleTarget) return;
  // Surface chop drives entrainment of air bubbles. Quiet surface =>
  // baseline aeration; storms and choppy periods => much more O2 mixed in.
  const act = surfaceActivity(world);
  const expected = world.aerationRate * dt * (0.5 + act);
  let n = Math.floor(expected);
  if (Math.random() < expected - n) n++;
  for (let i = 0; i < n && world.particles.length < world.particleTarget; i++) {
    const r = 1 + Math.random() * 0.8;
    const mol = emptyMolecules();
    mol.o2 = AERATION_O2_PER_BUBBLE;
    pushParticle(world, {
      x: Math.random() * world.width,
      // Just below the surface so the wall-escape pass doesn't immediately
      // strip the new bubble.
      y: world.surfaceY + r + 1,
      z: r + Math.random() * (world.depth - 2 * r),
      vx: (Math.random() - 0.5) * 4,
      vy: AERATION_BUBBLE_DROP_SPEED,
      vz: (Math.random() - 0.5) * 4,
      r,
      material: "gas",
      molecules: mol,
    });
  }
}

// Adhesion springs: pull bonded creatures toward their contact distance.
// Bonds that stretch beyond BOND_BREAK_RATIO * restLen snap.
//
// Pair de-duplication: bonds are mutual (each side has the other in its
// list), so processing each (a, b) without care would apply forces
// twice. We use a per-tick Set keyed by (smaller-bornAt + larger-bornAt
// + position) -- creatures don't have a stable numeric ID, but the
// pair (cs[i], b) where i is the array index works fine because we
// only process when b's index is > i. Use a precomputed index map.
// Reused per-tick to avoid allocating a fresh Map each call.
const BOND_IDX_MAP: Map<Creature, number> = new Map();
function applyBondSprings(world: World, dt: number): void {
  const cs = world.creatures;
  const idxOf = BOND_IDX_MAP;
  idxOf.clear();
  for (let i = 0; i < cs.length; i++) idxOf.set(cs[i], i);
  for (let i = 0; i < cs.length; i++) {
    const a = cs[i];
    const bonds = a.bonds;
    for (let bi = bonds.length - 1; bi >= 0; bi--) {
      const b = bonds[bi];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distSq = dx * dx + dy * dy;
      const restLen = a.r + b.r;
      const breakLen = restLen * BOND_BREAK_RATIO;
      if (distSq > breakLen * breakLen) {
        bonds.splice(bi, 1);
        const j = b.bonds.indexOf(a);
        if (j >= 0) b.bonds.splice(j, 1);
        continue;
      }
      // Only the lower-indexed side applies the spring.
      const bj = idxOf.get(b);
      if (bj === undefined || bj <= i) continue;
      const dist = Math.sqrt(distSq);
      if (dist < 1e-6) continue;
      const stretch = dist - restLen;
      const f = BOND_SPRING_K * stretch * dt;
      const nx = dx / dist;
      const ny = dy / dist;
      const ma = Math.max(0.01, creatureTotalMass(a));
      const mb = Math.max(0.01, creatureTotalMass(b));
      a.vx += nx * f / ma;
      a.vy += ny * f / ma;
      b.vx -= nx * f / mb;
      b.vy -= ny * f / mb;
    }
  }
}

function applyForces(world: World, dt: number): void {
  const kS = (2 * Math.PI) / world.surfaceLength;
  const wS = (2 * Math.PI) / world.surfacePeriod;
  const kL = (2 * Math.PI) / world.swellLength;
  const wL = (2 * Math.PI) / world.swellPeriod;
  const kU = (2 * Math.PI) / world.updraftLength;
  const wU = (2 * Math.PI) / world.updraftPeriod;

  // Disturbance amplifies wind/wave/mixing forces. 1.0 baseline, up to 4x
  // during a peak storm. Only surface/swell/zStir/brownian get amplified;
  // gravity/drag are unchanged. surfaceActivity bundles the slow
  // irregularity envelope and the storm multiplier so wave physics,
  // the visible surface line, and aeration all move together.
  const act = surfaceActivity(world);
  const bAmp = world.brownianAmp * act;
  const surfAmp = world.surfaceAmp * act;
  const swellAmp = world.swellAmp * act;
  const zAmp = world.zStirAmp * act;
  const updraftEnv = Math.min(1, act);

  // Slow horizontal current: surface flows one way, deep flows the other.
  // The direction reverses very slowly so cells eventually have to cope
  // with both regimes.
  const colDepth = Math.max(1, world.height - world.surfaceY);
  const currentDrift = Math.sin(world.t * CURRENT_FREQ);
  // Particle fast path: indexed access on the parallel typed arrays
  // avoids the per-particle handle getter/setter chain. With ~4-9k
  // particles per tick this is the hottest loop in the sim.
  const ps = world.particleStore;
  const PX = ps.x, PY = ps.y, PZ = ps.z;
  const PVX = ps.vx, PVY = ps.vy, PVZ = ps.vz;
  const PR = ps.r, PDENS = ps.density, PMAT = ps.material;
  const np = world.particles.length;
  const t = world.t;
  const drag = world.drag;
  const grav = world.gravity;
  const surfDecay = world.surfaceDecay;
  const swellDecay = world.swellDecay;
  const updraftAmp = world.updraftAmp;
  const currentAmp = world.currentAmp;
  const surfaceY = world.surfaceY;
  const matBase = MATERIAL_BASE_DENSITY;
  for (let i = 0; i < np; i++) {
    const xi = PX[i], yi = PY[i], ri = PR[i];
    let vxi = PVX[i], vyi = PVY[i], vzi = PVZ[i];
    const overrideD = PDENS[i];
    const density = overrideD !== 0 ? overrideD : matBase[PMAT[i]];
    let ay = grav * (1 - 1 / density);
    if (ay < -grav) ay = -grav; else if (ay > grav) ay = grav;
    const depth = yi > surfaceY ? yi - surfaceY : 0;
    // Balanced sum of rightward + leftward travelling waves. A single
    // travelling wave produces Stokes drift in its propagation direction;
    // particles slowly migrate to one side of the world. A pair with
    // opposite directions but *different* (k, w) cancels the drift
    // without collapsing back to a standing wave (which would re-create
    // fixed accumulation nodes -- equal-(k,w) opposing waves sum to a
    // standing wave). Splash is the 90-degree-out-of-phase vertical
    // companion of the dominant horizontal component.
    const surfPR = kS * xi - wS * t;
    const surfPL = 1.3 * kS * xi + 0.9 * wS * t + 1.1;
    const swellPR = kL * xi - wL * t;
    const swellPL = 1.4 * kL * xi + 0.7 * wL * t + 0.4;
    const surface = surfAmp * 0.5 * (Math.sin(surfPR) + Math.sin(surfPL)) * Math.exp(-depth / surfDecay);
    const swell   = swellAmp * 0.5 * (Math.sin(swellPR) + Math.sin(swellPL)) * Math.exp(-depth / swellDecay);
    const az      = zAmp * Math.sin(wL * t + kL * xi + 1.0) * Math.exp(-depth / swellDecay);
    const splash = depth < SPLASH_DEPTH
      ? surfAmp * SPLASH_GAIN * 0.5 * (Math.cos(surfPR) + Math.cos(surfPL)) * Math.exp(-depth / SPLASH_DEPTH)
      : 0;
    const updraft = -updraftAmp * updraftEnv * Math.sin(kU * xi + wU * t);
    const depthFrac = depth / colDepth;
    const current = currentAmp * Math.cos(Math.PI * depthFrac) * currentDrift;
    const noiseX = bAmp * (Math.random() - 0.5) * 2;
    const noiseY = bAmp * (Math.random() - 0.5) * 2;
    const ax = surface + swell + current + noiseX;
    const ayTot = ay + splash + updraft + noiseY;
    const dragScale = ri / DRAG_REF_R;
    const dscaleDrag = drag * dragScale;
    vxi += (ax - dscaleDrag * vxi) * dt;
    vyi += (ayTot - dscaleDrag * vyi) * dt;
    vzi += (az - dscaleDrag * vzi) * dt;
    PVX[i] = vxi; PVY[i] = vyi; PVZ[i] = vzi;
    PX[i] = xi + vxi * dt;
    PY[i] = yi + vyi * dt;
    PZ[i] = PZ[i] + vzi * dt;
  }
  // Creature fast path: same math as the particle loop, but creatures
  // may belong to different stores (tests allocate private stores), so
  // hoist the store columns per-creature.
  const cn = world.creatures.length;
  for (let k = 0; k < cn; k++) {
    const c = world.creatures[k];
    const i = c.idx;
    const cs = c.store;
    const CX = cs.x, CY = cs.y, CZ = cs.z;
    const CVX = cs.vx, CVY = cs.vy, CVZ = cs.vz;
    const CR = cs.r, CDENS = cs.density;
    const xi = CX[i], yi = CY[i], ri = CR[i];
    let vxi = CVX[i], vyi = CVY[i], vzi = CVZ[i];
    const density = CDENS[i];
    let ay = grav * (1 - 1 / density);
    if (ay < -grav) ay = -grav; else if (ay > grav) ay = grav;
    const depth = yi > surfaceY ? yi - surfaceY : 0;
    // Balanced rightward + leftward travelling waves -- see particle
    // loop above for rationale (no Stokes drift, no fixed nodes).
    const surfPR = kS * xi - wS * t;
    const surfPL = 1.3 * kS * xi + 0.9 * wS * t + 1.1;
    const swellPR = kL * xi - wL * t;
    const swellPL = 1.4 * kL * xi + 0.7 * wL * t + 0.4;
    const surface = surfAmp * 0.5 * (Math.sin(surfPR) + Math.sin(surfPL)) * Math.exp(-depth / surfDecay);
    const swell   = swellAmp * 0.5 * (Math.sin(swellPR) + Math.sin(swellPL)) * Math.exp(-depth / swellDecay);
    const az      = zAmp * Math.sin(wL * t + kL * xi + 1.0) * Math.exp(-depth / swellDecay);
    const splash = depth < SPLASH_DEPTH
      ? surfAmp * SPLASH_GAIN * 0.5 * (Math.cos(surfPR) + Math.cos(surfPL)) * Math.exp(-depth / SPLASH_DEPTH)
      : 0;
    const updraft = -updraftAmp * updraftEnv * Math.sin(kU * xi + wU * t);
    const depthFrac = depth / colDepth;
    const current = currentAmp * Math.cos(Math.PI * depthFrac) * currentDrift;
    const noiseX = bAmp * (Math.random() - 0.5) * 2;
    const noiseY = bAmp * (Math.random() - 0.5) * 2;
    const ax = surface + swell + current + noiseX;
    const ayTot = ay + splash + updraft + noiseY;
    const dragScale = ri / DRAG_REF_R;
    const dscaleDrag = drag * dragScale;
    vxi += (ax - dscaleDrag * vxi) * dt;
    vyi += (ayTot - dscaleDrag * vyi) * dt;
    vzi += (az - dscaleDrag * vzi) * dt;
    CVX[i] = vxi; CVY[i] = vyi; CVZ[i] = vzi;
    // Record force vector for SENSE_PRESSURE_X/Y. Static depth term
    // added in populateSensors, not here.
    cs.ax[i] = ax;
    cs.ay[i] = ayTot;
    CX[i] = xi + vxi * dt;
    CY[i] = yi + vyi * dt;
    CZ[i] = CZ[i] + vzi * dt;
  }
}

const VM_SENSORS: VMSensors = {
  gradX: new Float32Array(6),
  gradY: new Float32Array(6),
  density: new Float32Array(6),
  wallX: 0, wallY: 0,
  headX: 0, headY: 0,
  temp: 0, pheromone: 0,
  creatureDx: 0, creatureDy: 0, creatureDist: 0, creatureMass: 0,
  light: 0,
  emBands: new Float32Array(3),
  pressureX: 0, pressureY: 0,
  chemConc: new Float32Array(CHEMICAL_COUNT),
  kinOverlap: 0,
  neighborHash: 0,
};
const VM_SELF: VMSelf = {
  energy: 0, vx: 0, vy: 0,
  reserve: new Float32Array(6),
  mass: 0,
  biomass: 0, age: 0,
  glucose: 0, o2: 0, fattyAcid: 0, aminoAcid: 0, waste: 0,
};
const VM_OUT: VMOutputs = newOutputs();

function updateCreatures(world: World, dt: number): void {
  const n = world.creatures.length;
  // Dead/eaten tracked as Creature refs so subsequent passes don't have
  // to worry about array indices shifting underneath them.
  const dead: Creature[] = [];
  const eaten = new Set<Creature>();
  // Build per-tick spatial grids. Used by populateSensors (both creature
  // and particle scans), engulf/predation, creature-creature collisions,
  // and creature-sediment collisions. Replaces O(N) scans over world
  // particles/creatures inside per-cell loops with O(neighborhood) scans.
  buildCreatureGrid(world);
  rebuildSensorBins(world);
  // Snapshot each cell's surface fingerprint up front so ADHERE /
  // ENGULF in the per-cell loop below see consistent values for
  // both self and neighbor (rather than mid-update mixes).
  refreshSurfaceFingerprints(world);
  for (let cIdx = 0; cIdx < n; cIdx++) {
    const c = world.creatures[cIdx];
    if (eaten.has(c)) continue;

    updateCreatureRadius(c);

    // Temperature multiplies every enzyme-catalyzed rate (and the matching
    // idle drain) -- warm cells run hot; cold cells slow down. Q10 = 2.
    const localTemp = temperatureAt(world, c.x, c.y);
    const km = tempMult(localTemp);
    const dtT = dt * km;

    // Cost of being alive. ATP turns into ADP, mass conserved. Drain
    // scales with temperature like the rest of metabolism.
    const idleDrain = (BASE_METABOLIC_DRAIN + BASE_METABOLIC_PER_MASS * creatureTotalMass(c)) * dtT;
    spendATP(c, idleDrain);

    // Bulk -> molecules.
    catabolize(c, dtT);

    // Passive gas exchange with the surrounding water. Diffusion is
    // physical, not enzymatic -- left at the base dt.
    diffuseGases(c, dt);

    // All in-cell chemistry runs through one unified loop: named
    // reactions live at REACTIONS[0..9] with uncatRate > 0, so they
    // fire on every cell every tick; generic reactions at [10..255]
    // only fire when the cell has built the relevant catalyst.
    // Biosynth gateMasks honour VM_OUT.synthMask so SYNTH_AA / FA /
    // BIO / CHL / ENZ / RIBO ops still gate what gets built.
    const ambientLight = Math.exp(-c.y / LIGHT_DECAY) * solarLight(world);
    runGenericReactions(c, dtT, ambientLight, VM_OUT.synthMask);

    // Generic catalyst synthesis. SYNTH_CAT <id> sets a bit per slot;
    // each catalyst built is its own protein.
    const cm = VM_OUT.catSynthMask;
    if (cm) {
      for (let k = 0; k < CATALYST_COUNT; k++) {
        if (cm & (1 << k)) biosynthCatalyst(c, dtT, CAT_SYNTH_VMAX, CAT_ATP_COST, k);
      }
    }

    // Structural pools turn over even when nothing else is happening.
    maintenanceDecay(c, dt);

    // Endosymbionts: run chemistry on each engulfed cell and let
    // small molecules diffuse between inner and host pools. Inner
    // cells have no VM (motion / ingest / reproduce make no sense in
    // a vacuole); their biosynthesis runs on the static synthMask
    // captured at engulfment.
    if (c.contents.length > 0) {
      for (let ic = 0; ic < c.contents.length; ic++) {
        runOrganelleChemistry(c.contents[ic], c, dt, dtT, ambientLight);
      }
    }

    // Vent CO2 / waste back to the world if accumulating. Costs ATP, so a
    // stalled cell will fail to flush and start accumulating toxins.
    autoExcrete(c, world);

    // Toxic damage from any waste / CO2 the cell couldn't pump out.
    toxify(c, dt);

    // Somatic DNA damage: probability rises quadratically with age, so old
    // cells slowly become genetic mosaics of their original self. Doesn't
    // create a new species -- only inheritance does that.
    const age = world.t - c.bornAt;
    // Clamp at 0.1/tick (10%) so even very old cells don't churn their
    // entire genome every second.
    let mutP = Math.min(0.02, SOMATIC_MUTATION_AGE_COEF * age * age * dt);
    // REPAIR (op 0x63) suppresses somatic mutation while repairTicks > 0.
    // Each REPAIR execution spends ATP and refreshes the window so a cell
    // can choose to invest energy into stability when it matters.
    if (c.repairTicks > 0) { mutP = 0; c.repairTicks--; }
    if (age > 0 && Math.random() < mutP) {
      // Same viability guard the stillbirth filter uses at fission:
      // reject in-place edits that would knock out the cell's last
      // metabolism op or last REPRODUCE. Without this, an aging cell
      // with no REPAIR slowly self-sterilizes -- the founder is alive
      // and well, but its lineage quietly dies because its REPRODUCE
      // byte was mutated away. Non-critical somatic drift still flows
      // freely; survival-critical bytes are protected.
      const candidate = somaticMutateOnce(c.genome);
      if (viableGenome(candidate)) {
        c.genome = candidate;
      }
      // Sense range tracks the SENSE_AMP count in the live genome
      // and thrust accel tracks THRUST_AMP. Somatic mutations can
      // add or remove either, so recompute both here.
      c.senseRange = computeSenseRange(c.genome);
      c.thrustAccel = computeThrustAccel(c.genome);
      // Note: c.color is NOT updated on somatic drift. Cell keeps its
      // species' visual identity so phylogeny lane color === body color
      // across the population. Inheritance through fission is what
      // produces a new lineage and a new color.
    }

    populateSensors(c, world);

    VM_SELF.energy = c.energy;
    VM_SELF.vx = c.vx;
    VM_SELF.vy = c.vy;
    let selfMass = 0;
    for (let i = 0; i < 6; i++) {
      VM_SELF.reserve[i] = c.reserves[MATERIAL_IDS[i]];
      selfMass += VM_SELF.reserve[i];
    }
    VM_SELF.mass = selfMass;
    VM_SELF.biomass = c.molecules.biomass;
    VM_SELF.age = world.t - c.bornAt;
    VM_SELF.glucose = c.molecules.glucose;
    VM_SELF.o2 = c.molecules.o2;
    VM_SELF.fattyAcid = c.molecules.fattyAcid;
    VM_SELF.aminoAcid = c.molecules.aminoAcid;
    VM_SELF.waste = c.molecules.waste;

    // Per-species execution counters: each PC the VM lands on this
    // tick increments species.execCounts[pc]. species.vmTicks is
    // bumped once per cell-run so we can divide for per-position
    // rates.
    const sp = world.species.get(c.speciesKey);
    const ec = sp ? sp.execCounts : undefined;
    runTick(c.genome, c.vm, VM_SENSORS, VM_SELF, world.vmInstrBudget, VM_OUT, ec);
    if (sp) sp.vmTicks++;
    spendATP(c, VM_OUT.instructions * ENERGY_PER_INSTRUCTION);
    if (VM_OUT.repair > 0) {
      // Pay per-op so spamming REPAIR is expensive; refresh the window.
      // 30 ticks ~= 0.5 sim-sec at FIXED_DT 1/60, enough to span a
      // damage event without making the cell mutation-proof for life.
      const want = VM_OUT.repair * REPAIR_ATP_PER_OP;
      const paid = spendATP(c, want);
      if (paid > 0) c.repairTicks = Math.max(c.repairTicks, REPAIR_WINDOW_TICKS);
    }
    // Apply pending genome self-modifications after VM exits. SPLICE_*
    // changed length, which would invalidate PC mid-tick; we let the
    // rest of this tick's ops finish first, then resize here.
    if (VM_OUT.spliceMode !== 0 && VM_OUT.spliceLength > 0) {
      applyGenomeSplice(c, VM_OUT.spliceMode, VM_OUT.spliceOffset, VM_OUT.spliceLength);
    }
    // POKE_BYTE / SPLICE may have changed SENSE_AMP or THRUST_AMP
    // byte counts; recompute both derived traits.
    c.senseRange = computeSenseRange(c.genome);
    c.thrustAccel = computeThrustAccel(c.genome);

    // TURN: rotate the cell's velocity by the accumulated angle delta.
    // Cheap; only does the trig when the genome actually issued a turn.
    if (VM_OUT.turn !== 0) {
      const cos = Math.cos(VM_OUT.turn);
      const sin = Math.sin(VM_OUT.turn);
      const nvx = c.vx * cos - c.vy * sin;
      const nvy = c.vx * sin + c.vy * cos;
      c.vx = nvx;
      c.vy = nvy;
    }

    if (VM_OUT.reproduce) tryReproduce(c, world);

    // Pheromone emission: cell adds intensity to the field at its
    // position. Subsequent ticks decay + diffuse it.
    if (VM_OUT.emit > 0) {
      world.pheromone[pheromoneIndex(world, c.x, c.y)] += VM_OUT.emit;
    }

    // Adhesion: bond with the nearest creature in scanRange if not
    // already bonded. Cap each cell at MAX_BONDS to keep the spring
    // pass cheap and bounded.
    if (VM_OUT.adhere && c.bonds.length < MAX_BONDS) {
      // No engine-side recognition gate: the genome decides via
      // SENSE_KIN / SENSE_NEIGHBOR_HASH before issuing ADHERE. The
      // engine just wires up whatever the cell asked for. Same
      // pattern as ENGULF / PREDATE.
      let nearest: Creature | null = null;
      let bestSq = (c.r + 24) * (c.r + 24);
      forCreaturesNear(c.x, c.y, c.r + 24, (other) => {
        if (other === c || eaten.has(other) || c.bonds.includes(other) || other.bonds.length >= MAX_BONDS) return;
        const dx = other.x - c.x;
        const dy = other.y - c.y;
        const dsq = dx * dx + dy * dy;
        if (dsq < bestSq) { bestSq = dsq; nearest = other; }
      });
      if (nearest) {
        c.bonds.push(nearest);
        (nearest as Creature).bonds.push(c);
      }
    }

    // Advance any in-flight fission. When progress hits 1, the stashed
    // daughter is committed into world.creatures.
    advanceDivision(c, world, dt);

    let ax = VM_OUT.thrustX;
    let ay = VM_OUT.thrustY;
    const mag = Math.sqrt(ax * ax + ay * ay);
    if (mag > c.thrustAccel) {
      const k = c.thrustAccel / mag;
      ax *= k; ay *= k;
    }
    const usedFrac = Math.min(1, mag / c.thrustAccel);
    if (c.energy > 0 && usedFrac > 0) {
      c.vx += ax * dt;
      c.vy += ay * dt;
      // Thrust cost scales with cube root of mass -- approximates Stokes
      // drag (~r ∝ mass^(1/3)) so a 10x cell pays only ~2.15x more to
      // move at the same speed, not 10x.
      const massScale = Math.max(1, Math.cbrt(creatureTotalMass(c) / THRUST_MASS_REF));
      spendATP(c, usedFrac * ENERGY_PER_THRUST_SEC * massScale * dt);
    }

    // VM-controlled excretion (vent specific reserves on demand).
    for (let i = 0; i < 6; i++) {
      const requested = VM_OUT.excrete[i];
      if (requested <= 0) continue;
      const matId = MATERIAL_IDS[i];
      const available = c.reserves[matId];
      const amount = Math.min(requested, available);
      if (amount < EXCRETE_MIN_AMOUNT) continue;
      c.reserves[matId] -= amount;
      spawnExcretedParticle(c, world, matId, amount);
    }

    if (c.ingestCooldown > 0) {
      c.ingestCooldown = Math.max(0, c.ingestCooldown - dt);
    }

    if (c.ingestCooldown <= 0 && c.energy >= INGEST_ENERGY_COST) {
      let ingested = false;
      // Engulf and predate both scan for nearby cells via the spatial
      // grid; range of c.r + 32 covers all plausible neighbor radii.
      const scanRange = c.r + 32;
      if (VM_OUT.engulf) {
        const myMass = creatureTotalMass(c);
        forCreaturesNear(c.x, c.y, scanRange, (other) => {
          if (other === c || eaten.has(other)) return;
          const dx = other.x - c.x;
          const dy = other.y - c.y;
          const dz = other.z - c.z;
          const minD = c.r + other.r;
          if (dx * dx + dy * dy + dz * dz >= minD * minD) return;
          // No engine-side recognition gate: the genome decides
          // (SENSE_KIN / SENSE_NEIGHBOR_HASH) before issuing ENGULF.
          const otherMass = creatureTotalMass(other);
          if (myMass < PREDATION_MASS_RATIO * Math.max(0.0001, otherMass)) return;
          const cost = PREDATION_ENERGY_BASE + PREDATION_ENERGY_PER_MASS * otherMass;
          if (c.energy < cost) return;
          // Engulfed cell becomes an endosymbiont: its VM no longer
          // runs, but its chemistry continues each tick driven by a
          // static synthMask derived from its genome's SYNTH_* op set.
          other.organelleSynthMask = genomeSynthMask(other.genome);
          c.contents.push(other);
          spendATP(c, cost);
          c.ingestCooldown = PREDATION_COOLDOWN_SEC;
          eaten.add(other);
          ingested = true;
          return true;
        });
      }
      if (!ingested && VM_OUT.predate) {
        const myMass = creatureTotalMass(c);
        forCreaturesNear(c.x, c.y, scanRange, (other) => {
          if (other === c || eaten.has(other)) return;
          const dx = other.x - c.x;
          const dy = other.y - c.y;
          const dz = other.z - c.z;
          const minD = c.r + other.r;
          if (dx * dx + dy * dy + dz * dz >= minD * minD) return;
          const otherMass = creatureTotalMass(other);
          if (myMass < PREDATION_MASS_RATIO * Math.max(0.0001, otherMass)) return;
          const cost = PREDATION_ENERGY_BASE + PREDATION_ENERGY_PER_MASS * otherMass;
          if (c.energy < cost) return;
          for (let k = 0; k < 6; k++) {
            c.reserves[MATERIAL_IDS[k]] += other.reserves[MATERIAL_IDS[k]];
          }
          for (const mk of MOLECULE_IDS) c.molecules[mk] += other.molecules[mk];
          c.energy += other.energy;
          for (const inner of other.contents) c.contents.push(inner);
          other.contents.length = 0;
          spendATP(c, cost);
          c.ingestCooldown = PREDATION_COOLDOWN_SEC;
          eaten.add(other);
          // Note: slot release is deferred to the death pass so the
          // creature stays readable for the rest of this tick. Other
          // cells' sensor scans iterate the pre-tick CREATURE_BUCKETS
          // and could otherwise pick up a zeroed-out ghost slot here.
          ingested = true;
          return true;
        });
      }
      // Particle ingestion is genome-triggered: the cell must explicitly
      // run INGEST <material> this tick. Cells now select what they
      // want to eat -- chasing organic but bumping into a rock no longer
      // means swallowing the rock. Multiple INGEST ops per tick stack
      // into per-material flags so a genome can opt in to several types
      // at once. Engulf/predate above remain genome-triggered too.
      if (!ingested) {
        for (let i = world.particles.length - 1; i >= 0; i--) {
          const p = world.particles[i];
          const matIdx = MATERIAL_INDEX[p.material];
          if (!VM_OUT.ingestMaterials[matIdx]) continue;
          const dx = p.x - c.x;
          const dy = p.y - c.y;
          const dz = p.z - c.z;
          if (dx * dx + dy * dy + dz * dz < c.r * c.r) {
            if (p.molecules) {
              // Molecule-tagged particle: contents go straight into the
              // cell's molecule pool, bypassing catabolism. This is corpse
              // / excretion food -- already digested.
              for (const k of MOLECULE_IDS) c.molecules[k] += p.molecules[k];
            } else {
              c.reserves[p.material] += mass(p);
            }
            spendATP(c, INGEST_ENERGY_COST);
            // c.r >= MIN_CREATURE_R == INGEST_REF_R so the divisor is just c.r.
            c.ingestCooldown = INGEST_COOLDOWN_SEC * (INGEST_REF_R / c.r);
            removeParticleAt(world, i);
            break;
          }
        }
      }
    }

    updateCreatureRadius(c);

    // Death conditions:
    //  1. Starvation: no ATP and no fuel anywhere to rebuild it.
    //  2. Autolysis: biomass has decayed below the viable minimum (the
    //     cell can no longer hold itself together as a cell).
    if ((c.energy <= 0 && noFuel(c)) || c.molecules.biomass < MIN_VIABLE_BIOMASS) {
      dead.push(c);
    }
  }

  // Combined removal pass. dead = spilled, eaten = absorbed (no spill).
  // Build a survivors array in one O(N) pass instead of repeatedly
  // splicing (which is O(N) each).
  if (dead.length > 0 || eaten.size > 0) {
    const spillSet = new Set<Creature>(dead);
    // Engulfed (vs predated) prey is identified by being in some live
    // predator's contents[]. Engulfed prey keeps its slot alive (it
    // may emerge when the predator dies); predated prey gets absorbed
    // entirely and its slot is freed.
    const inSomeContents = new Set<Creature>();
    for (const c of world.creatures) {
      if (spillSet.has(c) || eaten.has(c)) continue;
      for (const inner of c.contents) inSomeContents.add(inner);
    }
    const survivors: Creature[] = [];
    const released: Creature[] = [];
    for (const c of world.creatures) {
      if (spillSet.has(c) || eaten.has(c)) {
        for (const inner of c.contents) {
          inner.x = c.x + (Math.random() - 0.5) * Math.max(2, c.r);
          inner.y = c.y + (Math.random() - 0.5) * Math.max(2, c.r);
          inner.z = c.z;
          released.push(inner);
        }
        c.contents.length = 0;
        for (const partner of c.bonds) {
          const k = partner.bonds.indexOf(c);
          if (k >= 0) partner.bonds.splice(k, 1);
        }
        c.bonds.length = 0;
        // If the cell was mid-division, the stashed child was alloc'd in
        // tryReproduce but never pushed into world.creatures. Its slot
        // would leak unless we release it explicitly here.
        if (c.division) {
          const ch = c.division.child;
          ch.store.release(ch.idx);
          c.division = null;
        }
        if (spillSet.has(c)) {
          releaseReservesAsParticles(c, world);
          c.store.release(c.idx);
        } else if (eaten.has(c) && !inSomeContents.has(c)) {
          // Predated -- absorbed entirely, no vacuole, slot is free.
          c.store.release(c.idx);
        }
        // Engulfed cells (in eaten AND in some predator's contents)
        // keep their slot alive until that predator dies and pushes
        // them back to world.creatures via released[].
        noteCreatureDeath(world, c);
      } else {
        survivors.push(c);
      }
    }
    world.creatures.length = 0;
    for (const s of survivors) world.creatures.push(s);
    for (const r of released) world.creatures.push(r);
  }
}

// Which world material best represents each molecule when it leaves a
// cell as a particle. Picked by density / chemical role so the visual
// behavior matches: fatty acid floats (lipid), gases float harder (gas),
// minerals sink (sand), the rest of the biochemistry is organic.
function moleculeBucket(k: keyof Molecules): MaterialId {
  if (k === "o2" || k === "co2") return "gas";
  if (k === "minerals") return "sand";
  if (k === "fattyAcid") return "lipid";
  return "organic";
}

function releaseReservesAsParticles(c: Creature, world: World): void {
  // On death the cell's entire contents return to the environment.
  //
  // Bulk reserves are released as plain material particles -- they're the
  // cell's undigested food pile, so they catabolize like world-seeded food
  // when re-eaten.
  //
  // The molecule pool is released as molecule-tagged particles, grouped by
  // their natural material bucket. Each particle in a bucket carries a
  // proportional slice of that bucket's molecules. When another cell eats
  // one of these, the molecules go straight into its molecule pool --
  // preserving the dead cell's actual chemistry (a fat-rich corpse gives
  // fatty acid back, a glucose-rich one gives glucose, etc.).
  for (const matId of MATERIAL_IDS) {
    let remaining = c.reserves[matId];
    if (remaining < 0.5) continue;
    const density = MATERIALS[matId].density;
    while (remaining > 0.5) {
      let r = 2 + Math.random() * 2;
      let mp = density * (4 / 3) * Math.PI * r * r * r;
      if (mp > remaining) {
        r = Math.max(DEATH_RELEASE_R_MIN, radiusForMass(remaining, density));
        mp = density * (4 / 3) * Math.PI * r * r * r;
      }
      pushParticle(world, {
        x: c.x + (Math.random() - 0.5) * 6,
        y: c.y + (Math.random() - 0.5) * 6,
        z: Math.min(world.depth - r, Math.max(r, c.z + (Math.random() - 0.5) * 4)),
        vx: (Math.random() - 0.5) * 2 * DEATH_RELEASE_SCATTER,
        vy: (Math.random() - 0.5) * 2 * DEATH_RELEASE_SCATTER,
        vz: (Math.random() - 0.5) * DEATH_RELEASE_SCATTER,
        r,
        material: matId,
      });
      remaining -= mp;
    }
  }

  // Catalysts denature on death back to their substrates (0.5 aa +
  // 0.5 min), same as enzymes / chlorophyll / ribosomes do during
  // maintenance. Folded into the molecule pool so the bucket loop
  // below releases them naturally.
  {
    const cols = c.store.catalystCols;
    const ci = c.idx;
    for (let k = 0; k < CATALYST_COUNT; k++) {
      const v = cols[k][ci];
      if (v > 0) {
        c.molecules.aminoAcid += 0.5 * v;
        c.molecules.minerals += 0.5 * v;
        cols[k][ci] = 0;
      }
    }
  }
  // Generic chemicals don't (yet) have a particle representation.
  // On death they release as bulk organic, weighted by their per-
  // chemical mass so cells that accumulated heavy generics drop a
  // proportionally larger pile.
  {
    const cols = c.store.genericChemCols;
    const ci = c.idx;
    let organicMass = 0;
    for (let k = 0; k < GENERIC_CHEMICAL_COUNT; k++) {
      const v = cols[k][ci];
      if (v > 0) {
        organicMass += v * CHEMICALS[NAMED_CHEMICAL_COUNT + k].mass;
        cols[k][ci] = 0;
      }
    }
    if (organicMass > 0) c.reserves.organic += organicMass;
  }

  // Group molecules by their natural bucket. ATP loses its terminal
  // phosphate on death, so we lump c.energy into the adp pool.
  const bucketContents: Record<MaterialId, Molecules> = {
    rock: emptyMolecules(),
    sand: emptyMolecules(),
    clay: emptyMolecules(),
    organic: emptyMolecules(),
    lipid: emptyMolecules(),
    gas: emptyMolecules(),
  };
  const bucketTotal: Record<MaterialId, number> = {
    rock: 0, sand: 0, clay: 0, organic: 0, lipid: 0, gas: 0,
  };
  for (const k of MOLECULE_IDS) {
    const v = c.molecules[k];
    if (v <= 0) continue;
    const b = moleculeBucket(k);
    bucketContents[b][k] += v;
    bucketTotal[b] += v;
  }
  if (c.energy > 0) {
    bucketContents.organic.adp += c.energy;
    bucketTotal.organic += c.energy;
  }

  for (const matId of MATERIAL_IDS) {
    const total = bucketTotal[matId];
    if (total < 0.5) continue;
    const density = MATERIALS[matId].density;
    let remaining = total;
    let usedFrac = 0;
    while (remaining > 0.5) {
      let r = 2 + Math.random() * 2;
      let mp = density * (4 / 3) * Math.PI * r * r * r;
      if (mp > remaining) {
        r = Math.max(DEATH_RELEASE_R_MIN, radiusForMass(remaining, density));
        mp = density * (4 / 3) * Math.PI * r * r * r;
      }
      const frac = Math.min(1 - usedFrac, mp / total);
      usedFrac += frac;
      const pMol = emptyMolecules();
      for (const k of MOLECULE_IDS) pMol[k] = bucketContents[matId][k] * frac;
      pushParticle(world, {
        x: c.x + (Math.random() - 0.5) * 6,
        y: c.y + (Math.random() - 0.5) * 6,
        z: Math.min(world.depth - r, Math.max(r, c.z + (Math.random() - 0.5) * 4)),
        vx: (Math.random() - 0.5) * 2 * DEATH_RELEASE_SCATTER,
        vy: (Math.random() - 0.5) * 2 * DEATH_RELEASE_SCATTER,
        vz: (Math.random() - 0.5) * DEATH_RELEASE_SCATTER,
        r,
        material: matId,
        molecules: pMol,
      });
      remaining -= mp;
    }
  }
}

function tryReproduce(parent: Creature, world: World): void {
  // Can't start a new division while one is already in flight.
  if (parent.division) return;

  // Initiating mitosis costs ATP whether the attempt succeeds or not.
  // This is the rate-limit on REPRODUCE: a cell can't fire it every tick
  // without paying for the failed cycles, so spamming the op starves the
  // cell instead of being free.
  spendATP(parent, REPRODUCE_ATTEMPT_ATP_BASE + REPRODUCE_ATTEMPT_ATP_PER_MASS * creatureTotalMass(parent));

  if (world.creatures.length >= MAX_CREATURES) return;
  // Sexual reproduction (bonded crossover): if the parent currently has
  // any bonds, the child's pre-mutation genome is a single-crossover
  // recombinant of parent + random bond partner. Lets useful subprograms
  // flow between adjacent lineages. Falls through to plain asexual when
  // there are no bonds.
  let parentGenome = parent.genome;
  if (parent.bonds.length > 0) {
    const partner = parent.bonds[Math.floor(Math.random() * parent.bonds.length)];
    parentGenome = crossoverGenomes(parent.genome, partner.genome);
  }
  const childGenome = mutateGenome(parentGenome);
  // No engine-side stillbirth filter. If the mutation knocks out a
  // required op, that's the cell's problem -- the resulting daughter
  // will autolyze through the normal death pass (which conserves
  // mass back to particles). "Started mitosis, no undo button" was
  // the user's explicit design call.
  const parentShare = VM_OUT.reproduceFraction;
  const childShare = 1 - parentShare;
  // Build-block sufficiency check is also gone -- the parent commits
  // whatever proportional share its current pool gives the child,
  // and if either daughter ends up below MIN_VIABLE_BIOMASS the
  // standard autolyze handles cleanup with mass returned to the
  // environment. Bad timing has real consequences now.
  const childMolecules = emptyMolecules();
  const childReserves = emptyReserves();
  for (const mk of MOLECULE_IDS) {
    const give = parent.molecules[mk] * childShare;
    parent.molecules[mk] -= give;
    childMolecules[mk] = give;
  }
  for (const id of MATERIAL_IDS) {
    const give = parent.reserves[id] * childShare;
    parent.reserves[id] -= give;
    childReserves[id] = give;
  }
  const childCatalysts = new Float32Array(CATALYST_COUNT);
  {
    const cols = parent.store.catalystCols;
    const pi = parent.idx;
    for (let k = 0; k < CATALYST_COUNT; k++) {
      const v = cols[k][pi];
      const give = v * childShare;
      cols[k][pi] = v - give;
      childCatalysts[k] = give;
    }
  }
  // Same proportional split for the generic chemical pool. Named
  // chemCols (0..7) are aliased onto molCols so they already split
  // above via the molecules path; we only need to split the
  // independent generic slice here.
  const childGenericChem = new Float32Array(GENERIC_CHEMICAL_COUNT);
  {
    const cols = parent.store.genericChemCols;
    const pi = parent.idx;
    for (let k = 0; k < GENERIC_CHEMICAL_COUNT; k++) {
      const v = cols[k][pi];
      const give = v * childShare;
      cols[k][pi] = v - give;
      childGenericChem[k] = give;
    }
  }
  let energyGift = parent.energy * childShare;
  parent.energy -= energyGift;
  // "Yolk": a small free endowment of glucose + ATP to the newborn so
  // it has runway to find its first meal. Without this, the child
  // starts with only what proportional split gives it -- often not
  // enough to survive the lag between birth and reaching a food
  // particle. Conservation is "violated" (mass appears from thin air)
  // but this models maternal investment that isn't tracked elsewhere
  // in our chemistry.
  childMolecules.glucose += NEWBORN_YOLK_GLUCOSE;
  childMolecules.ribosome += NEWBORN_YOLK_RIBO;
  energyGift += NEWBORN_YOLK_ATP;

  updateCreatureRadius(parent);

  const angle = Math.random() * Math.PI * 2;
  let childMassEstimate = energyGift;
  for (const id of MATERIAL_IDS) childMassEstimate += childReserves[id];
  for (const mk of MOLECULE_IDS) childMassEstimate += childMolecules[mk];
  const childRGuess = Math.max(MIN_CREATURE_R, Math.cbrt((3 * childMassEstimate) / (4 * Math.PI)));
  // Place the child outside the parent's recent food-eating zone.
  // The previous 1.1x offset dropped the daughter inside the parent's
  // sense range of just-eaten particles, so the child saw no food
  // gradient and drifted until starving.
  const offset = (parent.r + childRGuess) * BIRTH_OFFSET_MULT;
  const child = newCreature(world.creatureStore, {
    x: parent.x + Math.cos(angle) * offset,
    y: parent.y + Math.sin(angle) * offset,
    z: parent.z,
    vx: parent.vx, vy: parent.vy, vz: parent.vz,
    r: MIN_CREATURE_R,
    density: parent.density,
    energy: energyGift,
    senseRange: computeSenseRange(childGenome),
    thrustAccel: computeThrustAccel(childGenome),
    genome: childGenome,
    vm: newVMState(),
    color: genomeColor(childGenome, world.anchorGenome),
    ingestCooldown: INGEST_COOLDOWN_SEC,
    repairTicks: 0,
    bornAt: world.t,
    speciesKey: genomeKey(childGenome),
    molecules: childMolecules,
    reserves: childReserves,
  });
  // Inherit the parent's founding lineage. Mutated descendants stay
  // part of the same lineageRoot for top-up counting purposes.
  child.lineageRoot = parent.lineageRoot;
  {
    const cols = child.store.catalystCols;
    const ci = child.idx;
    for (let k = 0; k < CATALYST_COUNT; k++) cols[k][ci] = childCatalysts[k];
  }
  {
    const cols = child.store.genericChemCols;
    const ci = child.idx;
    for (let k = 0; k < GENERIC_CHEMICAL_COUNT; k++) cols[k][ci] = childGenericChem[k];
  }
  updateCreatureRadius(child);

  // Endosymbiont propagation: each engulfed cell binary-fissions
  // alongside the host. One half stays in the parent's contents,
  // the other goes to the child. Mutation runs on each daughter
  // (organelle DNA drifts faster than host DNA in real biology --
  // we don't enforce a viability filter on inner cells since they
  // don't need their own REPRODUCE / metabolism to perpetuate).
  if (parent.contents.length > 0) {
    const innerOriginals = parent.contents.slice();
    parent.contents.length = 0;
    for (const inner of innerOriginals) {
      const sibling = fissionInner(inner, world);
      parent.contents.push(inner);
      if (sibling) child.contents.push(sibling);
    }
  }

  // Don't commit the child to the world yet -- stash it in the parent's
  // division state and animate the separation. advanceDivision() will
  // push the child into world.creatures when the visual completes.
  parent.division = {
    progress: 0,
    axis: angle,
    child,
  };
}

// Binary fission of an engulfed (endosymbiont) cell. Halves its mass
// and molecule pools, mutates the daughter's genome, recomputes its
// static synthMask. Returns the new sibling, which the caller hands
// to the host's child cell. Returns null if there isn't enough mass
// to make a viable split (the original inner keeps everything).
function fissionInner(inner: Creature, world: World): Creature | null {
  const bio = inner.molecules.biomass;
  if (bio < 2 * MIN_VIABLE_BIOMASS) return null;
  // Mutate the genome -- endosymbionts drift; no viability gate
  // because they don't need autonomous viability inside a host.
  const daughterGenome = mutateGenome(inner.genome);
  const daughter = newCreature(world.creatureStore, {
    x: inner.x, y: inner.y, z: inner.z,
    vx: 0, vy: 0, vz: 0,
    r: inner.r,
    density: inner.density,
    energy: 0,
    senseRange: 0,
    thrustAccel: 0,
    genome: daughterGenome,
    vm: newVMState(),
    color: inner.color,
    ingestCooldown: 0,
    repairTicks: 0,
    bornAt: world.t,
    speciesKey: genomeKey(daughterGenome),
    molecules: emptyMolecules(),
    reserves: emptyReserves(),
  });
  daughter.organelleSynthMask = genomeSynthMask(daughterGenome);
  // Endosymbiont daughters share the inner's lineageRoot. They live
  // in host vacuoles and aren't counted toward FOUNDER_TARGET, but
  // tagging them keeps the bookkeeping consistent if one is ever
  // released back to the world.
  daughter.lineageRoot = inner.lineageRoot;
  // Split molecules + reserves + ATP half / half.
  for (const k of MOLECULE_IDS) {
    const half = inner.molecules[k] * 0.5;
    inner.molecules[k] -= half;
    daughter.molecules[k] = half;
  }
  for (const id of MATERIAL_IDS) {
    const half = inner.reserves[id] * 0.5;
    inner.reserves[id] -= half;
    daughter.reserves[id] = half;
  }
  const eHalf = inner.energy * 0.5;
  inner.energy -= eHalf;
  daughter.energy = eHalf;
  updateCreatureRadius(inner);
  updateCreatureRadius(daughter);
  return daughter;
}

// Mitosis takes about a second to play out visually. The child has already
// been built and paid for inside tryReproduce; we just spread the visible
// transition over time.
export const DIVISION_DURATION_SEC = 1.0;

export function advanceDivision(c: Creature, world: World, dt: number): void {
  if (!c.division) return;
  c.division.progress += dt / DIVISION_DURATION_SEC;
  if (c.division.progress < 1) return;
  const child = c.division.child;
  const ang = c.division.axis;
  c.division = null;
  // No commit-time stillbirth abort either. A daughter that opens
  // below MIN_VIABLE_BIOMASS gets pushed to world.creatures anyway
  // and is caught by the normal autolyze pass on the next tick,
  // which releases its mass as particles. Brief +1/-1 churn in the
  // species table is the cost of dumb fission timing.
  // Drop the daughter at the current separation point. Recomputing from
  // the parent's live position keeps the visual in sync even if the
  // parent drifted during the second-long animation. Matches the
  // initial offset in tryReproduce().
  const offset = (c.r + child.r) * BIRTH_OFFSET_MULT;
  child.x = c.x + Math.cos(ang) * offset;
  child.y = c.y + Math.sin(ang) * offset;
  child.vx = c.vx;
  child.vy = c.vy;
  world.creatures.push(child);
  noteCreatureBirth(world, child, c.speciesKey);
}

function populateSensors(c: Creature, world: World): void {
  const range = c.senseRange;
  const rangeSq = range * range;
  // Per-material food gradient: signed pull vector summed over every visible
  // particle of that material. Each contribution is range * (dx, dy) / dsq,
  // so a particle at the edge of sense range contributes a unit vector, one
  // at half-range contributes ~2x, etc. The scaling keeps magnitudes in a
  // useful range for THRUST (which clamps to thrustAccel ~ 70).
  // Per-material gradient + density sampled from the prebuilt
  // SENSOR_BIN_* fields. Each cell visits a small 2D window of bins
  // around its position; each bin contributes (count, centroid)
  // weighted as if all its particles sit at the centroid.
  for (let i = 0; i < 6; i++) {
    VM_SENSORS.gradX[i] = 0;
    VM_SENSORS.gradY[i] = 0;
    VM_SENSORS.density[i] = 0;
  }
  const span = Math.ceil(range / SENSOR_BIN);
  let cbx = Math.floor(c.x / SENSOR_BIN);
  let cby = Math.floor(c.y / SENSOR_BIN);
  if (cbx < 0) cbx = 0; else if (cbx >= SENSOR_BIN_COLS) cbx = SENSOR_BIN_COLS - 1;
  if (cby < 0) cby = 0; else if (cby >= SENSOR_BIN_ROWS) cby = SENSOR_BIN_ROWS - 1;
  const x0 = Math.max(0, cbx - span);
  const x1 = Math.min(SENSOR_BIN_COLS - 1, cbx + span);
  const y0 = Math.max(0, cby - span);
  const y1 = Math.min(SENSOR_BIN_ROWS - 1, cby + span);
  for (let m = 0; m < 6; m++) {
    const cnt = SENSOR_BIN_COUNT[m];
    const sxArr = SENSOR_BIN_SUMX[m];
    const syArr = SENSOR_BIN_SUMY[m];
    let gx = 0, gy = 0, dens = 0;
    for (let by = y0; by <= y1; by++) {
      const row = by * SENSOR_BIN_COLS;
      for (let bx = x0; bx <= x1; bx++) {
        const bin = row + bx;
        const n = cnt[bin];
        if (n === 0) continue;
        const cx_bin = sxArr[bin] / n;
        const cy_bin = syArr[bin] / n;
        const dx = cx_bin - c.x;
        const dy = cy_bin - c.y;
        const dsq = dx * dx + dy * dy;
        if (dsq >= rangeSq || dsq < 1) continue;
        const w = range / dsq;
        gx += dx * w * n;
        gy += dy * w * n;
        dens += n;
      }
    }
    VM_SENSORS.gradX[m] = gx;
    VM_SENSORS.gradY[m] = gy;
    VM_SENSORS.density[m] = dens;
  }
  // Push-from-wall vector: range * (1/distLeft - 1/distRight). Magnitude
  // ~unit when the cell is at sense range from one wall and far from the
  // opposite one; 0 at the midpoint.
  const distLeft   = Math.max(1, c.x);
  const distRight  = Math.max(1, world.width - c.x);
  const distTop    = Math.max(1, c.y);
  const distBottom = Math.max(1, world.height - c.y);
  VM_SENSORS.wallX = range * (1 / distLeft - 1 / distRight);
  VM_SENSORS.wallY = range * (1 / distTop  - 1 / distBottom);
  // Normalized heading: unit vector when moving, zero at rest.
  const speed = Math.sqrt(c.vx * c.vx + c.vy * c.vy);
  if (speed > 0.01) {
    VM_SENSORS.headX = c.vx / speed;
    VM_SENSORS.headY = c.vy / speed;
  } else {
    VM_SENSORS.headX = 0;
    VM_SENSORS.headY = 0;
  }
  // Single scalar for legacy SENSE_LIGHT.
  const surfaceSun = solarLight(world);
  const visible = Math.exp(-c.y / LIGHT_DECAY) * surfaceSun;
  VM_SENSORS.light = visible;
  // Three EM bands with different attenuation profiles. Band 0 = visible
  // (same as legacy `light`); band 1 = long-penetrating (3x slower
  // depth falloff -- a depth ratio signal when divided into band 0);
  // band 2 = depth-invariant surface sun (constant regardless of how
  // deep the cell is, so the genome can read "is the sun out" without
  // depth interference).
  VM_SENSORS.emBands[0] = visible;
  VM_SENSORS.emBands[1] = Math.exp(-c.y / (LIGHT_DECAY * 3)) * surfaceSun;
  VM_SENSORS.emBands[2] = surfaceSun;
  VM_SENSORS.temp = temperatureAt(world, c.x, c.y);
  VM_SENSORS.pheromone = world.pheromone[pheromoneIndex(world, c.x, c.y)];
  // Internal chemistry sense: snapshot the cell's own chemical pool
  // so SENSE_CHEMICAL <id> can read any of the 64 chemicals.
  {
    const cols = c.store.chemCols;
    const i = c.idx;
    const cc = VM_SENSORS.chemConc;
    for (let k = 0; k < CHEMICAL_COUNT; k++) cc[k] = cols[k][i];
  }
  VM_SENSORS.creatureDx = 0;
  VM_SENSORS.creatureDy = 0;
  VM_SENSORS.creatureDist = range;
  VM_SENSORS.creatureMass = 0;
  VM_SENSORS.kinOverlap = 0;
  VM_SENSORS.neighborHash = 0;
  // Mechanical pressure on the cell. ax/ay are the per-tick force
  // components recorded by applyForces; pressureY also picks up a
  // static depth term so deep cells see a steady signal even when
  // neutrally buoyant (otherwise gravity nets to zero against
  // buoyancy and depth becomes invisible).
  VM_SENSORS.pressureX = c.store.ax[c.idx];
  const depthBelowSurface = Math.max(0, c.y - world.surfaceY);
  VM_SENSORS.pressureY = c.store.ay[c.idx] + depthBelowSurface * PRESSURE_PER_DEPTH;
  let bestCreatureSq = rangeSq;
  let nearestOther: Creature | null = null;
  forCreaturesNear(c.x, c.y, range, (other) => {
    if (other === c) return;
    const dx = other.x - c.x;
    const dy = other.y - c.y;
    const dsq = dx * dx + dy * dy;
    if (dsq < bestCreatureSq) {
      bestCreatureSq = dsq;
      VM_SENSORS.creatureDx = dx;
      VM_SENSORS.creatureDy = dy;
      VM_SENSORS.creatureDist = Math.sqrt(dsq);
      VM_SENSORS.creatureMass = creatureTotalMass(other);
      nearestOther = other;
    }
  });
  if (nearestOther !== null) {
    const o = nearestOther as Creature;
    VM_SENSORS.kinOverlap = fingerprintOverlap(c, o);
    // Cheap byte hash of the neighbor's full fingerprint -- xor low
    // and high words byte-by-byte so the genome can use it as a
    // tribe / signature recognizer.
    const lo = o.store.fpLo[o.idx];
    const hi = o.store.fpHi[o.idx];
    const xored = (lo ^ hi) >>> 0;
    VM_SENSORS.neighborHash =
      ((xored & 0xFF) ^ ((xored >>> 8) & 0xFF) ^ ((xored >>> 16) & 0xFF) ^ ((xored >>> 24) & 0xFF)) & 0xFF;
  }
}

function creatureTotalMass(c: Creature): number {
  let m = c.energy; // ATP is a real molecule and contributes to mass.
  for (let i = 0; i < 6; i++) m += c.reserves[MATERIAL_IDS[i]];
  for (const k of MOLECULE_IDS) m += c.molecules[k];
  // Engulfed prey lives in our vacuole; its mass still occupies our volume.
  for (const inner of c.contents) m += creatureSelfMass(inner);
  return m;
}

// Mass of a single cell excluding its contents -- used to avoid recursion
// when summing up an engulfed prey's contribution to its container's mass.
function creatureSelfMass(c: Creature): number {
  let m = c.energy;
  for (let i = 0; i < 6; i++) m += c.reserves[MATERIAL_IDS[i]];
  for (const k of MOLECULE_IDS) m += c.molecules[k];
  return m;
}

// Has the cell exhausted every fuel it could turn into ATP?
function noFuel(c: Creature): boolean {
  const m = c.molecules;
  return m.glucose < 0.5 && m.fattyAcid < 0.5
    && c.reserves.organic < 0.5 && c.reserves.lipid < 0.5
    // Chlorophyll + CO2 + light can still recover atp via photosynthesis.
    && !(m.chlorophyll > 0.5 && m.co2 > 0.5);
}

export function updateCreatureRadius(c: Creature): void {
  // Treat stored mass as a sphere's volume (water-density convention), then
  // render its equatorial cross-section. So mass = (4/3) pi R^3, giving
  // R = cbrt(3 m / (4 pi)). The on-screen disk's area is pi R^2.
  // This means doubling mass only grows radius by 2^(1/3) ~= 1.26, so the
  // surface-area-vs-volume penalty kicks in much harder than under the old
  // disk-area formula.
  const m = creatureTotalMass(c);
  c.r = Math.max(MIN_CREATURE_R, Math.cbrt((3 * m) / (4 * Math.PI)));
  // Effective density follows what the cell is carrying. Reserves
  // contribute at their material density (rock 2.6 sinks, gas 0.2
  // floats); molecules + ATP contribute at water density (1.0). Real
  // cells are osmotically regulated and live near water-density; we
  // damp the raw mass ratio toward 1.0 so storing some dense reserves
  // doesn't immediately glue every cell to the seafloor. Final value
  // is clamped to [DENSITY_FLOOR, DENSITY_CEIL] so the buoyancy
  // acceleration `g * (1 - 1/density)` stays in a tractable range.
  if (m > 0) {
    const s = c.store; const i = c.idx;
    const resCols = s.resCols;
    const matBase = MATERIAL_BASE_DENSITY;
    let reserveMass = 0;
    let weighted = 0;
    for (let k = 0; k < 6; k++) {
      const rk = resCols[k][i];
      reserveMass += rk;
      weighted += rk * matBase[k];
    }
    const watery = m - reserveMass;
    const raw = (weighted + watery) / m;
    const damped = 1 + (raw - 1) * DENSITY_DAMPING;
    c.density = damped < DENSITY_FLOOR ? DENSITY_FLOOR
              : damped > DENSITY_CEIL ? DENSITY_CEIL
              : damped;
  }
}

const GRID_CELL_SIZE = 12;
const COLLISION_BUCKETS: number[][] = [];
// Indices of buckets that received at least one particle this pass.
// Lets the resolve loop iterate only occupied cells (~30% of total at
// typical density) instead of every cell in the grid.
let COLLISION_NONEMPTY = new Int32Array(0);
let COLLISION_NONEMPTY_N = 0;
let COLLISION_MASS = new Float64Array(0);
// Per-particle "is asleep" flag, recomputed each call from quietTicks.
// Pair tests where both ends are asleep get skipped.
let COLLISION_ASLEEP = new Uint8Array(0);
const SLEEP_SPEED_SQ = 25;       // <5 px/s counts as still
const SLEEP_THRESHOLD_TICKS = 30; // ~half a sim-second before sleeping

// Creature spatial grid -- shared across sensor lookup, predation/engulf
// scans, and both creature-creature and creature-sediment collisions.
//
// Buckets hold Creature REFERENCES (not indices). updateCreatures
// splices dead/eaten creatures out of world.creatures before returning,
// which would otherwise invalidate every index in the grid before the
// collision passes run. Refs survive the splice; stale entries are
// harmless because we hold the object directly.
//
// Predation/engulf, which still need an "is this creature already
// dead-this-tick" check, pass a Set of in-flight victims to filter
// inside their visitor.
const CREATURE_GRID_CELL = 64;
const CREATURE_BUCKETS: Creature[][] = [];
// Indices of occupied creature buckets, refilled in buildCreatureGrid
// and reused by resolveCreatureCollisions so the collision loop iterates
// only the cells that actually hold creatures. At pop 200 in an 800x600
// world the grid has ~130 cells but typically < 50 are occupied.
let CREATURE_NONEMPTY = new Int32Array(0);
let CREATURE_NONEMPTY_N = 0;
let CREATURE_GRID_COLS = 0;
let CREATURE_GRID_ROWS = 0;

// Per-material particle moment field used by populateSensors. Built
// once per tick by rebuildSensorBins() and sampled by every cell.
// Avoids the previous "every cell re-walks every particle in its
// senseRange" cost which scaled as cells * particles_in_range.
//
// Each bin stores, per material: count, sumX, sumY. Cells approximate
// the bin's contribution to their gradient sensor by treating all
// the bin's particles as concentrated at the centroid (sumX/count,
// sumY/count). Coarse-grained but cheap.
const SENSOR_BIN = 40;
let SENSOR_BIN_COLS = 0;
let SENSOR_BIN_ROWS = 0;
const SENSOR_BIN_COUNT: Int32Array[] = [];   // [material][bin]
const SENSOR_BIN_SUMX: Float32Array[] = [];
const SENSOR_BIN_SUMY: Float32Array[] = [];
let SENSOR_BIN_ALLOC = 0;

function rebuildSensorBins(world: World): void {
  SENSOR_BIN_COLS = Math.max(1, Math.ceil(world.width / SENSOR_BIN));
  SENSOR_BIN_ROWS = Math.max(1, Math.ceil(world.height / SENSOR_BIN));
  const n = SENSOR_BIN_COLS * SENSOR_BIN_ROWS;
  if (n > SENSOR_BIN_ALLOC) {
    SENSOR_BIN_COUNT.length = 0;
    SENSOR_BIN_SUMX.length = 0;
    SENSOR_BIN_SUMY.length = 0;
    const alloc = n * 2;
    for (let m = 0; m < 6; m++) {
      SENSOR_BIN_COUNT.push(new Int32Array(alloc));
      SENSOR_BIN_SUMX.push(new Float32Array(alloc));
      SENSOR_BIN_SUMY.push(new Float32Array(alloc));
    }
    SENSOR_BIN_ALLOC = alloc;
  } else {
    for (let m = 0; m < 6; m++) {
      SENSOR_BIN_COUNT[m].fill(0, 0, n);
      SENSOR_BIN_SUMX[m].fill(0, 0, n);
      SENSOR_BIN_SUMY[m].fill(0, 0, n);
    }
  }
  const store = world.particleStore;
  const PX = store.x, PY = store.y, PMAT = store.material;
  const np = world.particles.length;
  for (let i = 0; i < np; i++) {
    const xi = PX[i], yi = PY[i];
    let bx = Math.floor(xi / SENSOR_BIN);
    let by = Math.floor(yi / SENSOR_BIN);
    if (bx < 0) bx = 0; else if (bx >= SENSOR_BIN_COLS) bx = SENSOR_BIN_COLS - 1;
    if (by < 0) by = 0; else if (by >= SENSOR_BIN_ROWS) by = SENSOR_BIN_ROWS - 1;
    const idx = PMAT[i];
    const bin = by * SENSOR_BIN_COLS + bx;
    SENSOR_BIN_COUNT[idx][bin]++;
    SENSOR_BIN_SUMX[idx][bin] += xi;
    SENSOR_BIN_SUMY[idx][bin] += yi;
  }
}


function buildCreatureGrid(world: World): void {
  const ccs = CREATURE_GRID_CELL;
  CREATURE_GRID_COLS = Math.max(1, Math.ceil(world.width / ccs));
  CREATURE_GRID_ROWS = Math.max(1, Math.ceil(world.height / ccs));
  const cellCount = CREATURE_GRID_COLS * CREATURE_GRID_ROWS;
  while (CREATURE_BUCKETS.length < cellCount) CREATURE_BUCKETS.push([]);
  if (CREATURE_NONEMPTY.length < cellCount) CREATURE_NONEMPTY = new Int32Array(cellCount * 2);
  // Clear only the buckets that were filled last build, not the whole grid.
  for (let i = 0; i < CREATURE_NONEMPTY_N; i++) CREATURE_BUCKETS[CREATURE_NONEMPTY[i]].length = 0;
  CREATURE_NONEMPTY_N = 0;
  const cs = world.creatures;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    let cx = Math.floor(c.x / ccs);
    let cy = Math.floor(c.y / ccs);
    // NaN/Inf safety: comparison ops on NaN are always false, so the
    // clamp below misses them. Catch explicitly and dump such cells
    // into bucket (0, 0) -- they'd otherwise pop into BUCKETS[NaN] and
    // crash the frame loop.
    if (!Number.isFinite(cx)) cx = 0;
    if (!Number.isFinite(cy)) cy = 0;
    if (cx < 0) cx = 0; else if (cx >= CREATURE_GRID_COLS) cx = CREATURE_GRID_COLS - 1;
    if (cy < 0) cy = 0; else if (cy >= CREATURE_GRID_ROWS) cy = CREATURE_GRID_ROWS - 1;
    const idx = cy * CREATURE_GRID_COLS + cx;
    const bucket = CREATURE_BUCKETS[idx];
    if (bucket.length === 0) CREATURE_NONEMPTY[CREATURE_NONEMPTY_N++] = idx;
    bucket.push(c);
  }
}

// Iterate creature indices that might be within `range` of (x, y). The
// visitor may return true to stop iteration early (e.g. when a predator
// finds its first valid prey). Skips buckets outside the search radius.
function forCreaturesNear(
  x: number, y: number, range: number,
  visitor: (c: Creature) => boolean | void,
): void {
  const ccs = CREATURE_GRID_CELL;
  const span = Math.max(1, Math.ceil(range / ccs));
  const cx = Math.max(0, Math.min(CREATURE_GRID_COLS - 1, Math.floor(x / ccs)));
  const cy = Math.max(0, Math.min(CREATURE_GRID_ROWS - 1, Math.floor(y / ccs)));
  const x0 = Math.max(0, cx - span);
  const x1 = Math.min(CREATURE_GRID_COLS - 1, cx + span);
  const y0 = Math.max(0, cy - span);
  const y1 = Math.min(CREATURE_GRID_ROWS - 1, cy + span);
  for (let gy = y0; gy <= y1; gy++) {
    const row = gy * CREATURE_GRID_COLS;
    for (let gx = x0; gx <= x1; gx++) {
      const bucket = CREATURE_BUCKETS[row + gx];
      for (let k = 0; k < bucket.length; k++) {
        if (visitor(bucket[k]) === true) return;
      }
    }
  }
}

function resolveCollisions(world: World): void {
  const store = world.particleStore;
  const n = world.particles.length;
  if (n < 2) return;
  const e = world.restitution;
  const cellSize = GRID_CELL_SIZE;
  const cols = Math.max(1, Math.ceil(world.width / cellSize));
  const rows = Math.max(1, Math.ceil(world.height / cellSize));
  const cellCount = cols * rows;

  while (COLLISION_BUCKETS.length < cellCount) COLLISION_BUCKETS.push([]);
  if (COLLISION_MASS.length < n) COLLISION_MASS = new Float64Array(n * 2);
  if (COLLISION_NONEMPTY.length < cellCount) COLLISION_NONEMPTY = new Int32Array(cellCount * 2);
  if (COLLISION_ASLEEP.length < n) COLLISION_ASLEEP = new Uint8Array(n * 2);

  const PX = store.x, PY = store.y, PZ = store.z;
  const PVX = store.vx, PVY = store.vy, PVZ = store.vz;
  const PR = store.r, PDENS = store.density, PMAT = store.material;
  const PQUIET = store.quietTicks;
  const matBase = MATERIAL_BASE_DENSITY;
  const FOUR_THIRDS_PI = (4 / 3) * Math.PI;
  for (let i = 0; i < n; i++) {
    const r = PR[i];
    const d = PDENS[i] !== 0 ? PDENS[i] : matBase[PMAT[i]];
    COLLISION_MASS[i] = d * FOUR_THIRDS_PI * r * r * r;
    const vx = PVX[i], vy = PVY[i], vz = PVZ[i];
    const v2 = vx * vx + vy * vy + vz * vz;
    if (v2 < SLEEP_SPEED_SQ) {
      const q = PQUIET[i] + 1;
      PQUIET[i] = q;
      COLLISION_ASLEEP[i] = q >= SLEEP_THRESHOLD_TICKS ? 1 : 0;
    } else {
      PQUIET[i] = 0;
      COLLISION_ASLEEP[i] = 0;
    }
  }

  for (let pass = 0; pass < world.collisionIters; pass++) {
    for (let i = 0; i < COLLISION_NONEMPTY_N; i++) COLLISION_BUCKETS[COLLISION_NONEMPTY[i]].length = 0;
    COLLISION_NONEMPTY_N = 0;
    for (let pi = 0; pi < n; pi++) {
      let cx = Math.floor(PX[pi] / cellSize);
      let cy = Math.floor(PY[pi] / cellSize);
      if (cx < 0) cx = 0; else if (cx >= cols) cx = cols - 1;
      if (cy < 0) cy = 0; else if (cy >= rows) cy = rows - 1;
      const idx = cy * cols + cx;
      const bucket = COLLISION_BUCKETS[idx];
      if (bucket.length === 0) {
        COLLISION_NONEMPTY[COLLISION_NONEMPTY_N++] = idx;
      }
      bucket.push(pi);
    }

    for (let k = 0; k < COLLISION_NONEMPTY_N; k++) {
      const idx = COLLISION_NONEMPTY[k];
      const cell = COLLISION_BUCKETS[idx];
      const cl = cell.length;
      const cy = (idx / cols) | 0;
      const cx = idx - cy * cols;
      for (let i = 0; i < cl; i++) {
        const ai = cell[i];
        for (let j = i + 1; j < cl; j++) resolvePairSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, ai, cell[j], e);
      }
      checkNeighborPairsSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, cell, cx + 1, cy,     cols, rows, e);
      checkNeighborPairsSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, cell, cx - 1, cy + 1, cols, rows, e);
      checkNeighborPairsSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, cell, cx,     cy + 1, cols, rows, e);
      checkNeighborPairsSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, cell, cx + 1, cy + 1, cols, rows, e);
    }
  }
}

// Soft positional separation for overlapping creatures + symmetric
// velocity exchange like the particle-particle code, but driven off
// the per-tick CREATURE_BUCKETS grid. Without this cells walk through
// each other (only PREDATE/ENGULF cared about contact) and you can't
// see flocking, body-shielding, or crowding pressure emerge.
function resolveCreatureCollisions(world: World): void {
  const n = world.creatures.length;
  if (n < 2) return;
  const e = 0.1;
  const cols = CREATURE_GRID_COLS;
  const rows = CREATURE_GRID_ROWS;
  // Iterate only the buckets we filled, not the whole grid -- most
  // cells are empty at pop ~200 in a 130-cell grid.
  for (let k = 0; k < CREATURE_NONEMPTY_N; k++) {
    const idx = CREATURE_NONEMPTY[k];
    const cell = CREATURE_BUCKETS[idx];
    const cl = cell.length;
    if (cl === 0) continue;
    const gy = (idx / cols) | 0;
    const gx = idx - gy * cols;
    for (let i = 0; i < cl; i++) {
      const ai = cell[i];
      for (let j = i + 1; j < cl; j++) resolveCreaturePair(ai, cell[j], e);
    }
    if (gx + 1 < cols)             checkCreaturePairs(cell, gy * cols + gx + 1, e);
    if (gy + 1 < rows && gx > 0)   checkCreaturePairs(cell, (gy + 1) * cols + gx - 1, e);
    if (gy + 1 < rows)             checkCreaturePairs(cell, (gy + 1) * cols + gx, e);
    if (gy + 1 < rows && gx + 1 < cols) checkCreaturePairs(cell, (gy + 1) * cols + gx + 1, e);
  }
}

function checkCreaturePairs(
  cell: Creature[], otherIdx: number, e: number,
): void {
  const nb = CREATURE_BUCKETS[otherIdx];
  const nl = nb.length;
  if (nl === 0) return;
  const cl = cell.length;
  for (let i = 0; i < cl; i++) {
    const ai = cell[i];
    for (let j = 0; j < nl; j++) resolveCreaturePair(ai, nb[j], e);
  }
}

function resolveCreaturePair(a: Creature, b: Creature, e: number): void {
  if (a === b) return;
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let dz = b.z - a.z;
  const minDist = a.r + b.r;
  const distSq = dx * dx + dy * dy + dz * dz;
  if (distSq >= minDist * minDist) return;
  let dist = Math.sqrt(distSq);
  if (dist < 1e-6) { dx = 1; dy = 0; dz = 0; dist = 1; }
  const nx = dx / dist;
  const ny = dy / dist;
  const nz = dz / dist;
  const overlap = minDist - dist;
  // Mass divisor clamped so a pathological zero-mass cell can't NaN out
  // the world by producing Infinity/0 = NaN velocities downstream.
  const ma = Math.max(0.01, creatureTotalMass(a));
  const mb = Math.max(0.01, creatureTotalMass(b));
  const total = ma + mb;
  const corrA = overlap * (mb / total);
  const corrB = overlap * (ma / total);
  a.x -= nx * corrA;
  a.y -= ny * corrA;
  a.z -= nz * corrA;
  b.x += nx * corrB;
  b.y += ny * corrB;
  b.z += nz * corrB;
  // Symmetric velocity exchange along the contact normal.
  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const rvz = b.vz - a.vz;
  const vN = rvx * nx + rvy * ny + rvz * nz;
  if (vN >= 0) return;
  const jImp = (-(1 + e) * vN) / (1 / ma + 1 / mb);
  const ix = nx * jImp;
  const iy = ny * jImp;
  const iz = nz * jImp;
  a.vx -= ix / ma;
  a.vy -= iy / ma;
  a.vz -= iz / ma;
  b.vx += ix / mb;
  b.vy += iy / mb;
  b.vz += iz / mb;
}

// Sediment particles (rock, sand) act as solid terrain: cells can't
// phase through the seafloor. Clay stays permeable so cells can ingest
// it. INGEST runs earlier in the tick, so a cell whose genome fires
// INGEST on a rock/sand at contact still consumes the particle before
// this bounce runs.
const SEDIMENT_MATERIALS = new Set<MaterialId>(["rock", "sand"]);
function resolveCreatureSedimentCollisions(world: World): void {
  const ps = world.particles;
  const cs = world.creatures;
  if (cs.length === 0) return;
  for (let pi = 0; pi < ps.length; pi++) {
    const p = ps[pi];
    if (!SEDIMENT_MATERIALS.has(p.material)) continue;
    const range = p.r + 30;
    forCreaturesNear(p.x, p.y, range, (c) => {
      let dx = c.x - p.x;
      let dy = c.y - p.y;
      let dz = c.z - p.z;
      const minD = c.r + p.r;
      const dsq = dx * dx + dy * dy + dz * dz;
      if (dsq >= minD * minD) return;
      let dist = Math.sqrt(dsq);
      if (dist < 1e-6) { dx = 0; dy = -1; dz = 0; dist = 1; }
      const nx = dx / dist;
      const ny = dy / dist;
      const nz = dz / dist;
      const overlap = minD - dist;
      const pm = Math.max(0.01, mass(p));
      const cm = Math.max(0.01, creatureTotalMass(c));
      const total = pm + cm;
      const cShare = pm / total;
      const pShare = cm / total;
      c.x += nx * overlap * cShare;
      c.y += ny * overlap * cShare;
      c.z += nz * overlap * cShare;
      p.x -= nx * overlap * pShare;
      p.y -= ny * overlap * pShare;
      p.z -= nz * overlap * pShare;
      const rvx = c.vx - p.vx;
      const rvy = c.vy - p.vy;
      const rvz = c.vz - p.vz;
      const vN = rvx * nx + rvy * ny + rvz * nz;
      if (vN >= 0) return;
      const e = 0.2;
      const jImp = (-(1 + e) * vN) / (1 / cm + 1 / pm);
      const ix = nx * jImp;
      const iy = ny * jImp;
      const iz = nz * jImp;
      c.vx += ix / cm;
      c.vy += iy / cm;
      c.vz += iz / cm;
      p.vx -= ix / pm;
      p.vy -= iy / pm;
      p.vz -= iz / pm;
    });
  }
}

function checkNeighborPairsSoa(
  PX: Float32Array, PY: Float32Array, PZ: Float32Array,
  PVX: Float32Array, PVY: Float32Array, PVZ: Float32Array,
  PR: Float32Array, cell: number[],
  nx: number, ny: number, cols: number, rows: number,
  e: number,
): void {
  if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) return;
  const nb = COLLISION_BUCKETS[ny * cols + nx];
  const nl = nb.length;
  if (nl === 0) return;
  const cl = cell.length;
  for (let i = 0; i < cl; i++) {
    const ai = cell[i];
    for (let j = 0; j < nl; j++) resolvePairSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, ai, nb[j], e);
  }
}

function resolvePairSoa(
  PX: Float32Array, PY: Float32Array, PZ: Float32Array,
  PVX: Float32Array, PVY: Float32Array, PVZ: Float32Array,
  PR: Float32Array, i: number, j: number, e: number,
): void {
  if (COLLISION_ASLEEP[i] && COLLISION_ASLEEP[j]) return;
  const ax = PX[i], ay = PY[i], az = PZ[i];
  const bx = PX[j], by = PY[j], bz = PZ[j];
  let dx = bx - ax, dy = by - ay, dz = bz - az;
  const minDist = PR[i] + PR[j];
  const distSq = dx * dx + dy * dy + dz * dz;
  if (distSq >= minDist * minDist) return;
  let dist = Math.sqrt(distSq);
  let nxv = 0, nyv = -1, nzv = 0;
  if (dist < 1e-6) { dx = 1; dy = 0; dz = 0; dist = 1; nxv = 1; nyv = 0; nzv = 0; }
  else { nxv = dx / dist; nyv = dy / dist; nzv = dz / dist; }
  const overlap = minDist - dist;
  const ma = COLLISION_MASS[i];
  const mb = COLLISION_MASS[j];
  const total = ma + mb;
  const corrA = overlap * (mb / total);
  const corrB = overlap * (ma / total);
  PX[i] = ax - nxv * corrA;
  PY[i] = ay - nyv * corrA;
  PZ[i] = az - nzv * corrA;
  PX[j] = bx + nxv * corrB;
  PY[j] = by + nyv * corrB;
  PZ[j] = bz + nzv * corrB;
  const avx = PVX[i], avy = PVY[i], avz = PVZ[i];
  const bvx = PVX[j], bvy = PVY[j], bvz = PVZ[j];
  const rvx = bvx - avx, rvy = bvy - avy, rvz = bvz - avz;
  const vN = rvx * nxv + rvy * nyv + rvz * nzv;
  if (vN >= 0) return;
  const jImp = (-(1 + e) * vN) / (1 / ma + 1 / mb);
  const ix = nxv * jImp, iy = nyv * jImp, iz = nzv * jImp;
  PVX[i] = avx - ix / ma; PVY[i] = avy - iy / ma; PVZ[i] = avz - iz / ma;
  PVX[j] = bvx + ix / mb; PVY[j] = bvy + iy / mb; PVZ[j] = bvz + iz / mb;
}

function applyWalls(world: World): void {
  // Gas particles that drift up past the (wavy) water surface escape to
  // the atmosphere -- splice them out instead of clamping.
  for (let i = world.particles.length - 1; i >= 0; i--) {
    const p = world.particles[i];
    if (p.material === "gas" && p.y - p.r < surfaceYAt(world, p.x)) {
      removeParticleAt(world, i);
    }
  }
  const wallEach = (
    o: { x: number; y: number; z: number; vx: number; vy: number; vz: number; r: number },
  ): void => {
    if (o.r * 2 >= world.width) {
      o.x = world.width * 0.5; o.vx = 0;
    } else if (o.x < o.r) {
      o.x = o.r; if (o.vx < 0) o.vx = -o.vx * world.xWallRestitution;
    } else if (o.x > world.width - o.r) {
      o.x = world.width - o.r; if (o.vx > 0) o.vx = -o.vx * world.xWallRestitution;
    }
    if (o.r * 2 >= world.height) {
      o.y = world.height * 0.5; o.vy = 0;
    } else {
      if (o.y + o.r > world.height) { o.y = world.height - o.r; if (o.vy > 0) o.vy = 0; }
      // Non-gas objects (creatures, solid particles) clamp at the wavy
      // surface so floating lipids ride the wave instead of poking above
      // the visible water line. Gas escape is handled above.
      const top = surfaceYAt(world, o.x) + o.r;
      if (o.y < top) { o.y = top; if (o.vy < 0) o.vy = 0; }
    }
    if (o.r * 2 >= world.depth) {
      o.z = world.depth * 0.5; o.vz = 0;
    } else if (o.z < o.r) {
      o.z = o.r; if (o.vz < 0) o.vz = -o.vz * world.zWallRestitution;
    } else if (o.z > world.depth - o.r) {
      o.z = world.depth - o.r; if (o.vz > 0) o.vz = -o.vz * world.zWallRestitution;
    }
  };
  for (const p of world.particles) wallEach(p);
  for (const c of world.creatures) wallEach(c);
}

// ---------------------------------------------------------------------
// Persistence: serialize the live world to a JSON-friendly object and
// restore it. Used by main.ts to auto-save to localStorage every game
// minute so a mobile tab that gets reaped doesn't lose progress.
//
// The schema string bakes in ABI-affecting constants -- bumping any of
// them (CATALYST_COUNT, CHEMICAL_COUNT, MAX_GENOME_BYTES) invalidates
// older saves automatically. main.ts treats schema mismatch as
// "fresh world", matching the user's preference for hard-reset over
// migration.
//
// What we DON'T save (acceptable cosmetic loss):
//   - pheromone field (re-zeros; cells re-emit)
//   - phylogenyEvents (timeline starts fresh)
//   - per-cell bonds + engulfed `contents` + in-flight `division`
//   - species.execCounts (per-position VM trace, re-accumulates)
// What we DO save: enough to keep the population, terrain, day phase,
// and named/generic chemistry pools intact.
// ---------------------------------------------------------------------

export const SAVE_SCHEMA = `evosim4:2:${CATALYST_COUNT}:${CHEMICAL_COUNT}:${NAMED_CHEMICAL_COUNT}:${MAX_GENOME_BYTES}`;

interface SavedSparse { i: number; v: number }
interface SavedCreature {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  r: number; density: number; energy: number;
  senseRange: number; thrustAccel: number;
  bornAt: number; ingestCooldown: number; repairTicks: number;
  genome: number[];
  vmPc: number; vmStack: number[];
  color: string; speciesKey: string; lineageRoot: number;
  organelleSynthMask: number;
  molecules: Record<string, number>;
  reserves: Record<string, number>;
  // Sparse: only nonzero entries -- catalystCols is 256 wide, most slots empty.
  catalysts: SavedSparse[];
  // Sparse: 56 wide for generic chemicals.
  generics: SavedSparse[];
  // Engulfed inner cells (endosymbionts). Recursive: an inner cell can
  // itself carry contents in real biology, so we snapshot the same
  // structure -- though the sim currently only nests one level deep.
  contents?: SavedCreature[];
}
interface SavedParticle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  r: number; material: MaterialId;
  density?: number;
  molecules?: Record<string, number>;
}
interface SavedSpecies {
  key: string; color: string; firstSeen: number; lastSeen: number;
  alive: number; lane: number; vmTicks: number;
  parents: string[];
  genome: number[];
  peakBiomass: number;
}
interface SavedWorld {
  schema: string;
  width: number; height: number; depth: number;
  t: number;
  nextLineageRoot: number;
  extinctionCount: number;
  founderTarget: number;
  dayPhase: number;
  disturbanceIntensity: number;
  disturbanceStartedAt: number;
  disturbanceUntil: number;
  nextDisturbanceAt: number;
  anchorGenome: number[];
  liveLineageRoots: number[];
  obstacles: Obstacle[];
  species: SavedSpecies[];
  particles: SavedParticle[];
  creatures: SavedCreature[];
}

function snapshotSparseCol(cols: Float32Array[], i: number, n: number): SavedSparse[] {
  const out: SavedSparse[] = [];
  for (let k = 0; k < n; k++) {
    const v = cols[k][i];
    if (v > 0) out.push({ i: k, v });
  }
  return out;
}

function snapshotCreature(c: Creature): SavedCreature {
  const s = c.store; const i = c.idx;
  const mol: Record<string, number> = {};
  for (const k of MOLECULE_IDS) {
    const v = c.molecules[k];
    if (v !== 0) mol[k] = v;
  }
  const res: Record<string, number> = {};
  for (const id of MATERIAL_IDS) {
    const v = c.reserves[id];
    if (v !== 0) res[id] = v;
  }
  return {
    x: s.x[i], y: s.y[i], z: s.z[i],
    vx: s.vx[i], vy: s.vy[i], vz: s.vz[i],
    r: s.r[i], density: s.density[i], energy: s.energy[i],
    senseRange: s.senseRange[i], thrustAccel: s.thrustAccel[i],
    bornAt: s.bornAt[i], ingestCooldown: s.ingestCooldown[i],
    repairTicks: s.repairTicks[i],
    genome: Array.from(c.genome),
    vmPc: c.vm.pc, vmStack: Array.from(c.vm.stack),
    color: c.color, speciesKey: c.speciesKey, lineageRoot: c.lineageRoot,
    organelleSynthMask: c.organelleSynthMask,
    molecules: mol, reserves: res,
    catalysts: snapshotSparseCol(s.catalystCols, i, CATALYST_COUNT),
    generics: snapshotSparseCol(s.genericChemCols, i, GENERIC_CHEMICAL_COUNT),
    contents: c.contents.length > 0 ? c.contents.map(snapshotCreature) : undefined,
  };
}

function snapshotParticle(p: Particle): SavedParticle {
  const out: SavedParticle = {
    x: p.x, y: p.y, z: p.z,
    vx: p.vx, vy: p.vy, vz: p.vz,
    r: p.r, material: p.material,
  };
  if (p.density !== undefined) out.density = p.density;
  if (p.molecules) {
    const m: Record<string, number> = {};
    let any = false;
    for (const k of MOLECULE_IDS) {
      const v = p.molecules[k];
      if (v !== 0) { m[k] = v; any = true; }
    }
    if (any) out.molecules = m;
  }
  return out;
}

export function serializeWorld(w: World): string {
  const speciesList: SavedSpecies[] = [];
  for (const s of w.species.values()) {
    speciesList.push({
      key: s.key, color: s.color,
      firstSeen: s.firstSeen, lastSeen: s.lastSeen,
      alive: s.alive, lane: s.lane, vmTicks: s.vmTicks,
      parents: Array.from(s.parents),
      genome: Array.from(s.genome),
      peakBiomass: s.peakBiomass,
    });
  }
  const saved: SavedWorld = {
    schema: SAVE_SCHEMA,
    width: w.width, height: w.height, depth: w.depth,
    t: w.t,
    nextLineageRoot: w.nextLineageRoot,
    extinctionCount: w.extinctionCount,
    founderTarget: w.founderTarget,
    dayPhase: w.dayPhase,
    disturbanceIntensity: w.disturbanceIntensity,
    disturbanceStartedAt: w.disturbanceStartedAt,
    disturbanceUntil: w.disturbanceUntil,
    nextDisturbanceAt: w.nextDisturbanceAt,
    anchorGenome: Array.from(w.anchorGenome),
    liveLineageRoots: Array.from(w.liveLineageRoots),
    obstacles: w.obstacles,
    species: speciesList,
    particles: w.particles.map(snapshotParticle),
    creatures: w.creatures.map(snapshotCreature),
  };
  return JSON.stringify(saved);
}

function restoreCreature(world: World, sc: SavedCreature): Creature {
  const mol = emptyMolecules();
  for (const k of MOLECULE_IDS) {
    const v = sc.molecules[k];
    if (v !== undefined) mol[k] = v;
  }
  const res = emptyReserves();
  for (const id of MATERIAL_IDS) {
    const v = sc.reserves[id];
    if (v !== undefined) res[id] = v;
  }
  const c = newCreature(world.creatureStore, {
    x: sc.x, y: sc.y, z: sc.z,
    vx: sc.vx, vy: sc.vy, vz: sc.vz,
    r: sc.r, density: sc.density, energy: sc.energy,
    senseRange: sc.senseRange, thrustAccel: sc.thrustAccel,
    genome: new Uint8Array(sc.genome),
    vm: newVMState(),
    color: sc.color,
    ingestCooldown: sc.ingestCooldown,
    repairTicks: sc.repairTicks,
    bornAt: sc.bornAt,
    speciesKey: sc.speciesKey,
    molecules: mol,
    reserves: res,
  });
  c.lineageRoot = sc.lineageRoot;
  c.organelleSynthMask = sc.organelleSynthMask;
  c.vm.pc = sc.vmPc;
  for (const v of sc.vmStack) c.vm.stack.push(v);
  const s = c.store;
  for (const e of sc.catalysts) s.catalystCols[e.i][c.idx] = e.v;
  for (const e of sc.generics) s.genericChemCols[e.i][c.idx] = e.v;
  // Restore engulfed cells. They get their own creature slot (alloc'd
  // by restoreCreature) but are NOT pushed onto world.creatures --
  // they live in the host's contents[] until the host dies. Same
  // invariant the live engulf path maintains.
  if (sc.contents) {
    for (const sub of sc.contents) {
      const inner = restoreCreature(world, sub);
      c.contents.push(inner);
    }
  }
  return c;
}

// Mutates `world` in place: replaces particles + creatures + species
// + scalar state from the snapshot. Returns true on success, false on
// schema mismatch or malformed JSON (in which case `world` is left
// untouched).
export function applySavedWorld(world: World, json: string): boolean {
  let saved: SavedWorld;
  try {
    saved = JSON.parse(json);
  } catch {
    return false;
  }
  if (!saved || saved.schema !== SAVE_SCHEMA) return false;
  // Drop fresh world state and rebuild from snapshot.
  for (const c of world.creatures) {
    c.store.release(c.idx);
  }
  world.creatures.length = 0;
  while (world.particles.length > 0) removeParticleAt(world, world.particles.length - 1);
  world.species.clear();
  world.phylogenyEvents.length = 0;
  world.pheromone.fill(0);
  world.t = saved.t;
  world.nextLineageRoot = saved.nextLineageRoot;
  world.extinctionCount = saved.extinctionCount;
  // Intentionally NOT restoring saved.founderTarget -- we want the
  // current FOUNDER_TARGET constant to win so bumps in code take
  // effect even when restoring from a snapshot taken under an older
  // target. Tests / scripts that set founderTarget at runtime keep
  // doing so via direct mutation after createWorld returns.
  world.dayPhase = saved.dayPhase;
  world.disturbanceIntensity = saved.disturbanceIntensity;
  world.disturbanceStartedAt = saved.disturbanceStartedAt;
  world.disturbanceUntil = saved.disturbanceUntil;
  world.nextDisturbanceAt = saved.nextDisturbanceAt;
  world.anchorGenome = new Uint8Array(saved.anchorGenome);
  world.liveLineageRoots = new Set(saved.liveLineageRoots);
  world.obstacles = saved.obstacles;
  let maxLane = -1;
  for (const ss of saved.species) {
    if (ss.lane > maxLane) maxLane = ss.lane;
    world.species.set(ss.key, {
      key: ss.key, color: ss.color,
      firstSeen: ss.firstSeen, lastSeen: ss.lastSeen,
      alive: ss.alive, lane: ss.lane, vmTicks: ss.vmTicks,
      parents: new Set(ss.parents),
      genome: new Uint8Array(ss.genome),
      execCounts: new Uint32Array(MAX_GENOME_BYTES),
      peakBiomass: ss.peakBiomass ?? 0,
    });
  }
  world.nextSpeciesLane = maxLane + 1;
  for (const sp of saved.particles) {
    pushParticle(world, {
      x: sp.x, y: sp.y, z: sp.z,
      vx: sp.vx, vy: sp.vy, vz: sp.vz,
      r: sp.r, material: sp.material,
      density: sp.density,
      molecules: sp.molecules ? { ...emptyMolecules(), ...sp.molecules } : undefined,
    });
  }
  for (const sc of saved.creatures) {
    const c = restoreCreature(world, sc);
    world.creatures.push(c);
  }
  return true;
}
