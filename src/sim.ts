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
  OP,
  somaticMutateOnce,
  computeSenseRange,
  computeThrustAccel,
  MAX_GENOME_BYTES,
} from "./genome";

// Phase D of the chemistry overhaul: free-floating particles carry a
// single chem id (uint8 into the chemical table) instead of a string
// material label. The legacy MaterialId union, MATERIALS dict, and
// material-density LUT are gone; their roles are absorbed by the chem
// table and the SPAWN_CHEM_SPECS roster below. Pebbles are still a
// thing -- they're identified by chemId === CHEM_MIN with r above
// PEBBLE_R_MIN, not by a separate "sand" material.
export type ChemId = number;
// Flat Float32 lookup of each chemical's bulk density, indexed by
// chem id. Used in the hot force loop and the sensor pass. Populated
// after CHEMICALS builds; see CHEM_BASE_DENSITY initialization below
// the chemical table.
export let CHEM_BASE_DENSITY: Float32Array;

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
// Fixed preallocated cap for the ParticleStore. Big enough to cover
// the over-cap multiplier on top of particleTarget at the largest
// world size we ship (currently 800x600 -> particleTarget ~2320,
// peak ~20x ~46k), with a safety margin. The SAB-backed columns
// don't support growth (subworker views would become stale), so we
// reserve the worst case up front. ~3 MB of memory at this cap.
const PARTICLE_STORE_PREALLOC_CAP = 65536;

// Particle store layout. Single backing buffer (SharedArrayBuffer
// when crossOriginIsolated, plain ArrayBuffer otherwise) so subworkers
// can hold views over the same memory for parallel applyForces. Each
// column lives at a fixed byte offset; mutating a slot through any
// view writes the bytes once.
//
// Column order (must match PARTICLE_COLUMN_LAYOUT below):
//   x, y, z, vx, vy, vz, r, density, age   : Float32   (4 bytes each)
//   chemId                                  : Uint8     (1 byte)
//   quietTicks                              : Int32     (4 bytes)
export interface ParticleSharedLayout {
  buffer: ArrayBufferLike;
  cap: number;
  offsets: {
    x: number; y: number; z: number;
    vx: number; vy: number; vz: number;
    r: number; density: number; age: number;
    chemId: number;
    quietTicks: number;
  };
}

const FLOAT_BYTES = 4;
const UINT8_BYTES = 1;
const INT32_BYTES = 4;

function allocParticleBuffer(cap: number): { buffer: ArrayBufferLike; layout: ParticleSharedLayout["offsets"] } {
  // 9 float columns + 1 uint8 column + 1 int32 column, each padded
  // out to 8 bytes so the next column's view stays aligned.
  const align = (n: number): number => (n + 7) & ~7;
  const f32Size = cap * FLOAT_BYTES;
  const u8Size = cap * UINT8_BYTES;
  const i32Size = cap * INT32_BYTES;
  let o = 0;
  const offsets = {} as ParticleSharedLayout["offsets"];
  offsets.x = o; o = align(o + f32Size);
  offsets.y = o; o = align(o + f32Size);
  offsets.z = o; o = align(o + f32Size);
  offsets.vx = o; o = align(o + f32Size);
  offsets.vy = o; o = align(o + f32Size);
  offsets.vz = o; o = align(o + f32Size);
  offsets.r = o; o = align(o + f32Size);
  offsets.density = o; o = align(o + f32Size);
  offsets.age = o; o = align(o + f32Size);
  offsets.chemId = o; o = align(o + u8Size);
  offsets.quietTicks = o; o = align(o + i32Size);
  const total = o;
  // Prefer SharedArrayBuffer when crossOriginIsolated so subworkers
  // can mutate columns in place. Falls back to a regular ArrayBuffer
  // when SAB isn't allowed (no COOP/COEP, older host), and the
  // simulation just runs single-threaded.
  let buffer: ArrayBufferLike;
  if (typeof SharedArrayBuffer !== "undefined" &&
      typeof globalThis !== "undefined" &&
      // crossOriginIsolated is on Window + WorkerGlobalScope when COOP/COEP are set.
      (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated) {
    buffer = new SharedArrayBuffer(total);
  } else {
    buffer = new ArrayBuffer(total);
  }
  return { buffer, layout: offsets };
}

export class ParticleStore {
  cap = 0;
  n = 0;
  buffer!: ArrayBufferLike;
  offsets!: ParticleSharedLayout["offsets"];
  x!: Float32Array;
  y!: Float32Array;
  z!: Float32Array;
  vx!: Float32Array;
  vy!: Float32Array;
  vz!: Float32Array;
  r!: Float32Array;
  density!: Float32Array;   // 0 -> use CHEM_BASE_DENSITY[chemId]
  chemId!: Uint8Array;      // chemical id; rendered/digested per CHEMICALS[k]
  quietTicks!: Int32Array;
  // Particle age in sim-seconds. Used by the decay pass: old particles
  // gradually lose mass (radius shrinks) and disappear once below a
  // minimum size. Models decomposition by unmodeled microbiota and
  // prevents corpse-spillage from autolysis from accumulating
  // indefinitely.
  age!: Float32Array;
  molecules: (Molecules | null)[] = [];
  // Generic-chemical payload (chemCols slots 8..63). Stays null for
  // the typical particle; allocated only when a dying cell's generic
  // pool got dumped here so it can be re-absorbed on ingest. Length
  // GENERIC_CHEMICAL_COUNT when present.
  genericChem: (Float32Array | null)[] = [];
  constructor(initialCap = 256) {
    // Round initial cap up to the parallel-friendly preallocated
    // ceiling. Subworkers receive views over this exact buffer and
    // can't follow us across a reallocation, so we sidestep growth
    // by reserving enough room up front.
    const cap = Math.max(initialCap, PARTICLE_STORE_PREALLOC_CAP);
    const { buffer, layout } = allocParticleBuffer(cap);
    this.cap = cap;
    this.buffer = buffer;
    this.offsets = layout;
    this.rebuildViews();
  }
  // Returns a layout descriptor a subworker can use to construct its
  // own views over the same buffer. Must remain stable for the
  // lifetime of the store (no realloc).
  sharedLayout(): ParticleSharedLayout {
    return { buffer: this.buffer, cap: this.cap, offsets: this.offsets };
  }
  private rebuildViews(): void {
    const b = this.buffer;
    const o = this.offsets;
    const cap = this.cap;
    this.x = new Float32Array(b, o.x, cap);
    this.y = new Float32Array(b, o.y, cap);
    this.z = new Float32Array(b, o.z, cap);
    this.vx = new Float32Array(b, o.vx, cap);
    this.vy = new Float32Array(b, o.vy, cap);
    this.vz = new Float32Array(b, o.vz, cap);
    this.r = new Float32Array(b, o.r, cap);
    this.density = new Float32Array(b, o.density, cap);
    this.age = new Float32Array(b, o.age, cap);
    this.chemId = new Uint8Array(b, o.chemId, cap);
    this.quietTicks = new Int32Array(b, o.quietTicks, cap);
  }
  grow(newCap: number): void {
    if (newCap <= this.cap) return;
    // The store's backing SharedArrayBuffer is shared with particle
    // subworkers that hold views over it; a realloc would silently
    // strand them on stale memory. We preallocate big up front
    // (PARTICLE_STORE_PREALLOC_CAP) so this path is unreachable in
    // practice; signal loudly if it ever isn't.
    throw new Error(
      `ParticleStore grow ${this.cap} -> ${newCap} would invalidate ` +
      `subworker views; raise PARTICLE_STORE_PREALLOC_CAP instead.`,
    );
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
      this.chemId[i] = this.chemId[last];
      this.quietTicks[i] = this.quietTicks[last];
      this.age[i] = this.age[last];
      this.molecules[i] = this.molecules[last];
      this.genericChem[i] = this.genericChem[last];
    }
    this.molecules[last] = null;
    this.genericChem[last] = null;
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
  get chemId(): number { return this.store.chemId[this.idx]; }
  set chemId(v: number) { this.store.chemId[this.idx] = v; }
  get quietTicks(): number | undefined {
    const q = this.store.quietTicks[this.idx];
    return q === 0 ? undefined : q;
  }
  set quietTicks(v: number | undefined) { this.store.quietTicks[this.idx] = v ?? 0; }
  get molecules(): Molecules | undefined { return this.store.molecules[this.idx] ?? undefined; }
  set molecules(v: Molecules | undefined) { this.store.molecules[this.idx] = v ?? null; }
  get genericChem(): Float32Array | undefined { return this.store.genericChem[this.idx] ?? undefined; }
  set genericChem(v: Float32Array | undefined) { this.store.genericChem[this.idx] = v ?? null; }
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
    chemId: number;
    density?: number;
    molecules?: Molecules;
    genericChem?: Float32Array;
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
  store.chemId[i] = opts.chemId;
  store.quietTicks[i] = opts.quietTicks ?? 0;
  // Slot reuse (swap-pop) means COLLISION_ASLEEP may carry a stale 1
  // from the previous occupant. Force-clear it so the freshly-pushed
  // particle isn't treated as asleep until the next resolveCollisions
  // pass classifies it for real.
  COLLISION_ASLEEP[i] = 0;
  store.age[i] = 0;
  store.molecules[i] = opts.molecules ?? null;
  store.genericChem[i] = opts.genericChem ?? null;
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
  // Keep the cached pebble count honest. Without this, ingest of a
  // pebble (creature INGEST doesn't filter by size) leaves the
  // cached count high until the next 30-tick refresh, suppressing
  // pebble replenish for up to half a sim-second.
  // Pebble cache decrement: large mineral grains are tracked separately
  // for sediment-bed replenish targeting.
  if (store.chemId[arrIdx] === CHEM_MIN && store.r[arrIdx] >= SAND_BIG_R_MIN) {
    if (pebbleCountCache > 0) pebbleCountCache--;
  }
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
  chemId: number;
  molecules?: Molecules;
  genericChem?: Float32Array;
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
// Fixed preallocated cap for CreatureStore. MAX_CREATURES (400) is
// the hard ceiling on world.creatures; engulfed prey occupies extra
// slots inside hosts, so we need headroom above 400. 768 keeps the
// per-column stride at 3 KB (cap * 4), which means the 64 chemistry
// columns the runGenericReactions inner loop touches per cell fit in
// ~192 KB -- comfortably inside L2 -- when the loop sweeps cells. SAB-
// backed columns can't grow without invalidating subworker views, so
// this is the hard cap.
const CREATURE_STORE_PREALLOC_CAP = 768;

// Layout descriptor for CreatureStore. Mirrors ParticleSharedLayout's
// role: subworkers receive this in their init message and rebuild
// Float32 / Int32 / Uint32 views over the shared buffer.
export interface CreatureSharedLayout {
  buffer: ArrayBufferLike;
  cap: number;
  // Offsets are stored as a flat record so subworker code can walk
  // it without needing the full Creature column inventory hard-coded.
  // catalyst[k] = byte offset for catalyst column k. Same for generic.
  offsets: {
    base: Record<string, number>; // primitive + molecule + reserve cols
    catalyst: number[];           // CATALYST_COUNT entries
    generic: number[];            // GENERIC_CHEMICAL_COUNT entries
  };
}

const CREATURE_F32_COLS = [
  "x", "y", "z", "vx", "vy", "vz",
  "r", "density",
  "energy", "senseRange", "thrustAccel",
  "bornAt", "ingestCooldown",
  "ax", "ay",
  "m_glucose", "m_fattyAcid", "m_aminoAcid", "m_minerals",
  "m_chlorophyll", "m_enzyme", "m_o2", "m_co2",
  "m_biomass", "m_waste", "m_adp", "m_ribosome",
  "m_biopolymer", "m_membrane",
] as const;
const CREATURE_I32_COLS = ["repairTicks"] as const;
const CREATURE_U32_COLS = ["fpLo", "fpHi"] as const;

function allocCreatureBuffer(cap: number): { buffer: ArrayBufferLike; offsets: CreatureSharedLayout["offsets"] } {
  const align = (n: number): number => (n + 7) & ~7;
  const f32Size = cap * 4;
  const i32Size = cap * 4;
  const u32Size = cap * 4;
  let o = 0;
  const base: Record<string, number> = {};
  for (const k of CREATURE_F32_COLS) { base[k] = o; o = align(o + f32Size); }
  for (const k of CREATURE_I32_COLS) { base[k] = o; o = align(o + i32Size); }
  for (const k of CREATURE_U32_COLS) { base[k] = o; o = align(o + u32Size); }
  const catalyst: number[] = [];
  for (let k = 0; k < CATALYST_COUNT; k++) { catalyst.push(o); o = align(o + f32Size); }
  const generic: number[] = [];
  for (let k = 0; k < GENERIC_CHEMICAL_COUNT; k++) { generic.push(o); o = align(o + f32Size); }
  const total = o;
  let buffer: ArrayBufferLike;
  if (typeof SharedArrayBuffer !== "undefined" &&
      typeof globalThis !== "undefined" &&
      (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated) {
    buffer = new SharedArrayBuffer(total);
  } else {
    buffer = new ArrayBuffer(total);
  }
  return { buffer, offsets: { base, catalyst, generic } };
}

export class CreatureStore {
  cap = 0;
  highWater = 0;
  free: number[] = [];
  buffer!: ArrayBufferLike;
  offsets!: CreatureSharedLayout["offsets"];
  // primitive position/velocity/shape
  x!: Float32Array; y!: Float32Array; z!: Float32Array;
  vx!: Float32Array; vy!: Float32Array; vz!: Float32Array;
  r!: Float32Array; density!: Float32Array;
  // metabolism / lifecycle
  energy!: Float32Array;
  senseRange!: Float32Array;
  thrustAccel!: Float32Array;
  bornAt!: Float32Array;
  ingestCooldown!: Float32Array;
  repairTicks!: Int32Array;
  // Total mechanical force on the cell this tick, recorded by
  // applyForces. Read by populateSensors to feed SENSE_PRESSURE_X/Y.
  // pressureY also gets a static depth term added before VM read.
  ax!: Float32Array;
  ay!: Float32Array;
  // molecule pools (parallel to MOLECULE_IDS order)
  m_glucose!: Float32Array;
  m_fattyAcid!: Float32Array;
  m_aminoAcid!: Float32Array;
  m_minerals!: Float32Array;
  m_chlorophyll!: Float32Array;
  m_enzyme!: Float32Array;
  m_o2!: Float32Array;
  m_co2!: Float32Array;
  m_biomass!: Float32Array;
  m_waste!: Float32Array;
  m_adp!: Float32Array;
  m_ribosome!: Float32Array;
  m_biopolymer!: Float32Array;
  m_membrane!: Float32Array;
  // Generic catalyst pool: one Float32Array per catalyst slot. Sized
  // to CATALYST_COUNT. Each catalyst k's pool multiplies its target
  // reaction's rate via (1 + pool/CAT_REF). Each slot is a view over
  // a contiguous region of the shared buffer.
  catalystCols!: Float32Array[];
  // Parallel array of column refs for indexed access in hot loops.
  // molCols[molKey] -> m_<key>. Initialized once after the typed arrays
  // exist. (Reserves have been collapsed into chemCols: every ingested
  // particle deposits directly into the cell's chem pool, and
  // catabolism is now the biopolymer-digest reaction.)
  molCols!: Float32Array[];
  // Unified chemical pool addressed by the generic-reaction engine.
  // chemCols[0..7] alias molCols entries (the named chemicals) so a
  // write through either path hits the same Float32Array. chemCols
  // [8..63] are independent views over the generic slice of the
  // shared buffer.
  chemCols!: Float32Array[];
  // Backing storage for the generic slice (chemCols[8..63]).
  genericChemCols!: Float32Array[];
  // Surface fingerprint -- the cell's "phenotype on display" used for
  // contact recognition by ADHERE / ENGULF. Each cell's top 8
  // chemicals by mass are packed into a 64-bit set (two Uint32Arrays
  // because JS bitops are 32-bit). Refreshed once per tick.
  fpLo!: Uint32Array;
  fpHi!: Uint32Array;
  constructor(initialCap = 256) {
    // Round up to the parallel-friendly preallocated ceiling. Future
    // creature subworkers will hold views over the same buffer.
    const cap = Math.max(initialCap, CREATURE_STORE_PREALLOC_CAP);
    const { buffer, offsets } = allocCreatureBuffer(cap);
    this.cap = cap;
    this.buffer = buffer;
    this.offsets = offsets;
    this.rebuildViews();
  }
  sharedLayout(): CreatureSharedLayout {
    return { buffer: this.buffer, cap: this.cap, offsets: this.offsets };
  }
  private rebuildViews(): void {
    const b = this.buffer;
    const o = this.offsets;
    const cap = this.cap;
    this.x = new Float32Array(b, o.base.x, cap);
    this.y = new Float32Array(b, o.base.y, cap);
    this.z = new Float32Array(b, o.base.z, cap);
    this.vx = new Float32Array(b, o.base.vx, cap);
    this.vy = new Float32Array(b, o.base.vy, cap);
    this.vz = new Float32Array(b, o.base.vz, cap);
    this.r = new Float32Array(b, o.base.r, cap);
    this.density = new Float32Array(b, o.base.density, cap);
    this.energy = new Float32Array(b, o.base.energy, cap);
    this.senseRange = new Float32Array(b, o.base.senseRange, cap);
    this.thrustAccel = new Float32Array(b, o.base.thrustAccel, cap);
    this.bornAt = new Float32Array(b, o.base.bornAt, cap);
    this.ingestCooldown = new Float32Array(b, o.base.ingestCooldown, cap);
    this.ax = new Float32Array(b, o.base.ax, cap);
    this.ay = new Float32Array(b, o.base.ay, cap);
    this.m_glucose = new Float32Array(b, o.base.m_glucose, cap);
    this.m_fattyAcid = new Float32Array(b, o.base.m_fattyAcid, cap);
    this.m_aminoAcid = new Float32Array(b, o.base.m_aminoAcid, cap);
    this.m_minerals = new Float32Array(b, o.base.m_minerals, cap);
    this.m_chlorophyll = new Float32Array(b, o.base.m_chlorophyll, cap);
    this.m_enzyme = new Float32Array(b, o.base.m_enzyme, cap);
    this.m_o2 = new Float32Array(b, o.base.m_o2, cap);
    this.m_co2 = new Float32Array(b, o.base.m_co2, cap);
    this.m_biomass = new Float32Array(b, o.base.m_biomass, cap);
    this.m_waste = new Float32Array(b, o.base.m_waste, cap);
    this.m_adp = new Float32Array(b, o.base.m_adp, cap);
    this.m_ribosome = new Float32Array(b, o.base.m_ribosome, cap);
    this.m_biopolymer = new Float32Array(b, o.base.m_biopolymer, cap);
    this.m_membrane = new Float32Array(b, o.base.m_membrane, cap);
    this.repairTicks = new Int32Array(b, o.base.repairTicks, cap);
    this.fpLo = new Uint32Array(b, o.base.fpLo, cap);
    this.fpHi = new Uint32Array(b, o.base.fpHi, cap);
    this.catalystCols = new Array(CATALYST_COUNT);
    for (let k = 0; k < CATALYST_COUNT; k++) {
      this.catalystCols[k] = new Float32Array(b, o.catalyst[k], cap);
    }
    this.genericChemCols = new Array(GENERIC_CHEMICAL_COUNT);
    for (let k = 0; k < GENERIC_CHEMICAL_COUNT; k++) {
      this.genericChemCols[k] = new Float32Array(b, o.generic[k], cap);
    }
    // MOLECULE_IDS order: adp, glucose, fattyAcid, aminoAcid, chlorophyll,
    // enzyme, o2, co2, minerals, biomass, waste, ribosome, biopolymer, membrane
    this.molCols = [
      this.m_adp, this.m_glucose, this.m_fattyAcid, this.m_aminoAcid,
      this.m_chlorophyll, this.m_enzyme, this.m_o2, this.m_co2,
      this.m_minerals, this.m_biomass, this.m_waste, this.m_ribosome,
      this.m_biopolymer, this.m_membrane,
    ];
    this.chemCols = new Array(CHEMICAL_COUNT);
    for (let k = 0; k < NAMED_CHEMICAL_COUNT; k++) {
      this.chemCols[k] = this.molCols[CHEM_NAMED_MOL_IDX[k]];
    }
    for (let k = 0; k < GENERIC_CHEMICAL_COUNT; k++) {
      this.chemCols[NAMED_CHEMICAL_COUNT + k] = this.genericChemCols[k];
    }
  }
  grow(newCap: number): void {
    if (newCap <= this.cap) return;
    // Same constraint as ParticleStore: subworker views over the
    // shared buffer can't follow a realloc. Preallocate above to
    // avoid this path.
    throw new Error(
      `CreatureStore grow ${this.cap} -> ${newCap} would invalidate ` +
      `subworker views; raise CREATURE_STORE_PREALLOC_CAP instead.`,
    );
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
    this.m_biopolymer[i] = 0; this.m_membrane[i] = 0;
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
  get biopolymer(): number { return this.c.store.m_biopolymer[this.c.idx]; }
  set biopolymer(v: number) { this.c.store.m_biopolymer[this.c.idx] = v; }
  get membrane(): number { return this.c.store.m_membrane[this.c.idx]; }
  set membrane(v: number) { this.c.store.m_membrane[this.c.idx] = v; }
}

// Reserves were retired in phase D of the chemistry overhaul.
// Ingested particles deposit their mass directly into chemCols[chemId]
// on the cell. Old code that asked for `c.reserves.organic += mass`
// is now `c.store.m_biopolymer[i] += mass` (or whichever chem the
// particle was). Test scaffolding that bulk-loaded reserves now bulks
// chem pools directly.

// Process-wide monotonic counter assigning a stable per-cell id at
// newCreature. Kept module-scoped (not on World) so tests that spin
// up multiple Worlds in one process still get unique ids. Snapshots
// use this id as the selection handle across ticks.
let NEXT_CREATURE_ID = 1;
export class Creature {
  idx: number;
  store: CreatureStore;
  // Stable identity that outlives store slot reuse. Assigned at
  // newCreature time; never recycled, never reused on resurrection.
  // The renderer uses this to track click selection across ticks
  // when the worker rebuilds creature snapshots each frame.
  id: number = 0;
  // Non-typed-array fields kept on the handle (variable-shape, not hot)
  genome!: Uint8Array;
  vm!: VMState;
  // Per-cell VM output struct. Previously a single module-global
  // (VM_OUT), shared across all cells. Made per-cell so each creature
  // keeps its own previous-tick outputs -- the chemistry pass reads
  // its own synthMask / catSynthMask instead of whichever cell
  // happened to run last in the previous tick. Required for any
  // future parallel creature pipeline; subworkers can mutate
  // c.vmOut without contending on a shared struct.
  vmOut!: VMOutputs;
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
  constructor(store: CreatureStore, idx: number) { this.store = store; this.idx = idx; }
  get molecules(): MoleculesView { return this._m ??= new MoleculesView(this); }
  // Setter: copy field-by-field from any Molecules-shaped object into
  // the typed-array slot. Lets `c.molecules = emptyMolecules()`-style
  // existing code keep working while the underlying data is SoA.
  set molecules(m: { glucose?: number; fattyAcid?: number; aminoAcid?: number; minerals?: number; chlorophyll?: number; enzyme?: number; o2?: number; co2?: number; biomass?: number; waste?: number; adp?: number; ribosome?: number; biopolymer?: number; membrane?: number }) {
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
    s.m_ribosome[i] = m.ribosome ?? 0;
    s.m_biopolymer[i] = m.biopolymer ?? 0;
    s.m_membrane[i] = m.membrane ?? 0;
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
}

export function newCreature(store: CreatureStore, init: CreatureInit): Creature {
  const idx = store.alloc();
  const c = new Creature(store, idx);
  c.id = NEXT_CREATURE_ID++;
  c.vmOut = newOutputs();
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
    if (m.ribosome !== undefined) store.m_ribosome[idx] = m.ribosome;
    if (m.biopolymer !== undefined) store.m_biopolymer[idx] = m.biopolymer;
    if (m.membrane !== undefined) store.m_membrane[idx] = m.membrane;
  }
  return c;
}

// Chem labels for the 6 sensor-bin slots in SENSE_GRAD / DENSITY ops.
// Used by the disassembler and HUD to pretty-print the operand. Index
// matches SENSOR_CHEMS slot order.
export const SENSOR_CHEM_LABELS: ReadonlyArray<string> = [
  "min", "biop", "fa", "o2", "co2", "glu",
];

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
  biopolymer: number;   // bulk food substrate; broken to glu/aa/fa by enzyme
  membrane: number;     // structural lipid bilayer; required for fission
}

export const MOLECULE_IDS: ReadonlyArray<keyof Molecules> = [
  "adp", "glucose", "fattyAcid", "aminoAcid", "chlorophyll", "enzyme",
  "o2", "co2", "minerals", "biomass", "waste", "ribosome",
  "biopolymer", "membrane",
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
    biopolymer: 0, membrane: 0,
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
  // Set of creature IDs that were spawned as founders (vs. born from
  // fission). Used by the age-based founder-cull -- see FOUNDER_LIFESPAN_SEC.
  founderIds: Set<number>;
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
  // Atmospheric composition tracked as a single mole pool (in the same
  // mass units the cell pools use). Gas particles that escape past
  // the surface dump their molecules in here; aeration() pulls
  // bubble composition from these mole fractions, so the loop is
  // mass-conserving and creates feedback (CO2-vented world ->
  // CO2-rich bubbles re-entering -> photoautotrophs near the surface
  // benefit). The atmosphere has a finite buffer -- if it gets
  // depleted (every gas dissolved or trapped in cells) aeration
  // slows; we don't conjure new mass.
  atmosphere: Molecules;
  // Dissolved-chemical concentration in the water column, one scalar
  // per chem id. Cells passively diffuse against this pool via
  // diffuseAmbient(). Phase F of the chemistry overhaul; replaces the
  // hardcoded O2_AMBIENT / CO2_AMBIENT constants with a per-chem,
  // mass-conserving pool. Spatial resolution is global scalar for
  // MVP; a coarse 2D grid lands in a later phase without API change.
  ambient: Float32Array;
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
  p.obstacleColl = 0;
  p.walls = 0; p.aerate = 0; p.replenish = 0; p.prune = 0;
}

const ENERGY_PER_THRUST_SEC = 5;
const ENERGY_PER_INSTRUCTION = 0.0005;
// VM ops per tick per creature. 8 keeps frame cost reasonable at high
// population. Tests override via world.vmInstrBudget when they need to
// see the whole default-genome program execute in one step.
const DEFAULT_VM_INSTR_BUDGET = 8;

const PARTICLE_DENSITY_PER_AREA = (6188 * 0.75 * 0.5 * 0.6 * 1.5 * 2) / (800 * 600);
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
// Newborn yolk constants retired. The genome now fully determines
// the child's bootstrap state: it gets its proportional share of
// the parent's pools and nothing else. If the parent didn't
// stockpile enough machinery before reproducing, that's the
// parent's lineage problem.
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
// Biopolymer digestion (catabolism replacement) is now a regular
// reaction (REACTIONS slot 10), with rate gated on enzyme pool. See
// installNamedReactions() for parameters.

// Passive O2 (and CO2) exchange with the surrounding water. Real cells
// dissolve oxygen across their membrane; without this our cells starve
// because the default genome only seeks organic particles and never builds
// up enough internal O2 to power aerobic respiration.
// O2 / CO2 diffusion is now generalized via diffuseAmbient + the
// chem table's per-chem permeability. AMBIENT_TARGET[CHEM_O2] / [CO2]
// continue to set the equilibrium concentrations.

// Catabolism is now driven by reactions, not a hand-coded material-to-
// molecule fraction table. The biopolymer-digest bootstrap reaction
// (slot 10 in REACTIONS) turns ingested biopolymer into glucose + amino
// acid + fatty acid, gated on the digester (enzyme) chemical -- a real
// reaction with substrates, products, and rate-limited by enzyme pool.
// Particles deposit their mass directly into the cell's chem pool on
// ingestion; the cell decides per-tick how much biopolymer to digest
// based on how much enzyme it has built. Catabolism of mineral particles
// is just "the cell carries mineral chemical until it's used as a
// biosynth substrate" -- no transform needed.

// String key -> index in MOLECULE_IDS array. Used to map between named
// chem ids and Molecules field positions.
const MOLECULE_INDEX: Record<keyof Molecules, number> = {} as Record<keyof Molecules, number>;
for (let i = 0; i < MOLECULE_IDS.length; i++) MOLECULE_INDEX[MOLECULE_IDS[i]] = i;

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
const NAMED_CHEMICAL_COUNT = 14;
// Order matches chemical slot 0..13. Each entry is a key of Molecules
// and the chemCols[k] Float32Array aliases molCols[MOLECULE_INDEX[k]].
// Slots 12 (biopolymer) and 13 (membrane) joined in phase C of the
// chemistry overhaul; biopolymer is the bulk-food substrate that
// replaces the old "organic" material, and membrane is the structural
// lipid bilayer required for fission.
const NAMED_CHEMICALS: ReadonlyArray<keyof Molecules> = [
  "o2", "co2", "glucose", "aminoAcid", "fattyAcid", "minerals", "biomass", "adp",
  "waste", "chlorophyll", "enzyme", "ribosome",
  "biopolymer", "membrane",
];
// Slot indices for special handling (engine-managed ATP/ADP, etc.).
// Stable across the migration; phase E renumbers ATP to 0 and shifts these.
const CHEM_O2 = 0;
const CHEM_CO2 = 1;
const CHEM_GLU = 2;
const CHEM_AA = 3;
const CHEM_FA = 4;
const CHEM_MIN = 5;
const CHEM_BIOMASS = 6;
const CHEM_ADP = 7;
const CHEM_WASTE = 8;
// chlorophyll, enzyme, ribosome have specific roles as rate multipliers:
//   chl   -> photosynth (mandatory: no chl -> no photosynth)
//   ribo  -> all biosynth reactions (mandatory: no ribo -> no biosynth)
//   enz   -> catabolize (mandatory: no enz -> no digestion of biopolymer)
// Real biology has matching analogs: pigment for carbon fixation, the
// ribosomal machinery for protein synthesis, digestive enzymes for
// breaking down ingested food.
const CHEM_CHL = 9;
const CHEM_ENZ = 10;
const CHEM_RIBO = 11;
const CHEM_BIOPOLYMER = 12;
const CHEM_MEMBRANE = 13;
const RIBO_REF = 5;
const CHL_REF = 5;
const ENZ_REF = 5;
const GENERIC_CHEMICAL_COUNT = CHEMICAL_COUNT - NAMED_CHEMICAL_COUNT;
// Phase B of the chemistry overhaul (CHEMISTRY_OVERHAUL.md): the
// chemical table is now the single source of truth for every
// substance the engine reasons about, with full property rows
// (phase, solubility, density, role, etc.). The downstream
// migration phases (C..J) will consume these fields; until then
// the new properties are populated but unused, so behavior is
// unchanged from the previous "mass + diffusable" definition.
export type ChemPhase = "solid" | "liquid" | "gas" | "aqueous";
export type ChemRole =
  | "none"
  | "energyCarrier"   // ATP-like: stores energy in chemical form
  | "energyEmpty"     // ADP-like: the discharged counterpart
  | "membrane"        // structural lipid bilayer
  | "mrna"            // catalyst proxy for biosynth (formerly "ribosome")
  | "pigment"         // catalyst proxy for photosynthesis
  | "digester"        // catalyst proxy for catabolism
  | "marker";         // identity-only; no reactions consume it
interface ChemicalDef {
  name: string;
  // Mass per unit reaction; conserved across reactions by the
  // procedural generator. (Renamed from `mass`.)
  molarMass: number;
  // Bulk density when condensed (liquid or solid). Drives free-particle
  // physics (buoyancy/sinking). Gases use their own low density.
  density: number;
  // Default phase at standard simulation conditions.
  defaultPhase: ChemPhase;
  // Saturation concentration in water (0 = insoluble). Used by phase G
  // for dissolution / outgassing accounting against the ambient pool.
  solubility: number;
  // Proxy for tendency to enter gas phase as temperature rises. Higher
  // = more volatile. Used by phase G.
  vaporPressure: number;
  // Proxy for solid <-> liquid transition. Above this, the chem behaves
  // as liquid for phase-transition purposes.
  meltingPoint: number;
  // Rate of passive diffusion across the cell membrane (units: mass/sec
  // per gradient unit per surface ratio). Zero for structural /
  // machinery molecules that can't cross. Replaces the old
  // `diffusable: boolean` -- nonzero permeability == "diffusable".
  permeability: number;
  // Stored chemical potential per unit mass. Informational for the
  // procedural reaction generator (substrates with high bondEnergy
  // tend to yield more ATP when broken down). Phase H uses it.
  bondEnergy: number;
  // Role flag for built-in machinery / identity semantics. Most
  // chemicals are "none".
  role: ChemRole;
  // Dominant-component color for rendering. Used by phase C when
  // particles switch from material-keyed colors to chem-keyed.
  color: string;
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
}
// Order MUST match NAMED_CHEMICALS exactly. Properties are tuned to
// reasonable real-chemistry analogs: O2/CO2 are volatile gases, glucose
// is a high-bond-energy soluble sugar, fatty acid is hydrophobic and
// energy-dense, biomass is structural-insoluble, chlorophyll/enzyme/
// ribosome are aqueous machinery that doesn't cross membranes.
const NAMED_CHEM_SPECS: ReadonlyArray<NamedChemSpec> = [
  /* o2     */ { molarMass: 1.0, density: 0.14, defaultPhase: "gas",     solubility: 0.5,  vaporPressure: 10, meltingPoint: -200, permeability: 1.0, bondEnergy: 0,    role: "none",      color: "#cfe2ff" },
  /* co2    */ { molarMass: 1.0, density: 0.20, defaultPhase: "gas",     solubility: 1.8,  vaporPressure: 9,  meltingPoint: -80,  permeability: 1.0, bondEnergy: 0,    role: "none",      color: "#c4d4e6" },
  /* glu    */ { molarMass: 1.0, density: 1.5,  defaultPhase: "aqueous", solubility: 4.0,  vaporPressure: 0,  meltingPoint: 150,  permeability: 0.6, bondEnergy: 30,   role: "none",      color: "#dbe09c" },
  /* aa     */ { molarMass: 1.0, density: 1.2,  defaultPhase: "aqueous", solubility: 3.0,  vaporPressure: 0,  meltingPoint: 200,  permeability: 0.5, bondEnergy: 20,   role: "none",      color: "#c9c075" },
  /* fa     */ { molarMass: 1.0, density: 0.9,  defaultPhase: "liquid",  solubility: 0.1,  vaporPressure: 0,  meltingPoint: 40,   permeability: 0.3, bondEnergy: 80,   role: "none",      color: "#f0d264" },
  /* min    */ { molarMass: 1.0, density: 2.4,  defaultPhase: "solid",   solubility: 0.02, vaporPressure: 0,  meltingPoint: 1200, permeability: 0.1, bondEnergy: 0,    role: "none",      color: "#8c8175" },
  /* biomass*/ { molarMass: 1.0, density: 1.1,  defaultPhase: "solid",   solubility: 0,    vaporPressure: 0,  meltingPoint: 300,  permeability: 0,   bondEnergy: 15,   role: "none",      color: "#7fb069" },
  /* adp    */ { molarMass: 1.0, density: 1.0,  defaultPhase: "aqueous", solubility: 3.0,  vaporPressure: 0,  meltingPoint: 200,  permeability: 0.5, bondEnergy: 0,    role: "energyEmpty", color: "#a8d8ea" },
  /* waste  */ { molarMass: 1.0, density: 1.0,  defaultPhase: "aqueous", solubility: 4.0,  vaporPressure: 0,  meltingPoint: 100,  permeability: 0.6, bondEnergy: 2,    role: "none",      color: "#a89878" },
  /* chl    */ { molarMass: 1.0, density: 1.1,  defaultPhase: "aqueous", solubility: 0.2,  vaporPressure: 0,  meltingPoint: 200,  permeability: 0,   bondEnergy: 5,    role: "pigment",   color: "#5fa850" },
  /* enz    */ { molarMass: 1.0, density: 1.1,  defaultPhase: "aqueous", solubility: 0.5,  vaporPressure: 0,  meltingPoint: 90,   permeability: 0,   bondEnergy: 5,    role: "digester",  color: "#e0a070" },
  /* ribo   */ { molarMass: 1.0, density: 1.1,  defaultPhase: "aqueous", solubility: 0.3,  vaporPressure: 0,  meltingPoint: 70,   permeability: 0,   bondEnergy: 5,    role: "mrna",      color: "#c8a4dc" },
  /* biop   */ { molarMass: 1.0, density: 1.05, defaultPhase: "solid",   solubility: 0.05, vaporPressure: 0,  meltingPoint: 250,  permeability: 0,   bondEnergy: 25,   role: "none",      color: "#7fb069" },
  /* memb   */ { molarMass: 1.0, density: 0.8,  defaultPhase: "liquid",  solubility: 0.01, vaporPressure: 0,  meltingPoint: 50,   permeability: 0,   bondEnergy: 40,   role: "membrane",  color: "#f0d264" },
];
const CHEMICALS: ChemicalDef[] = buildChemicalTable();
// Initialize the exported per-chem density LUT. Hot loops reuse this
// to avoid a property-dispatch on CHEMICALS[id] every particle.
CHEM_BASE_DENSITY = new Float32Array(CHEMICAL_COUNT);
for (let i = 0; i < CHEMICAL_COUNT; i++) CHEM_BASE_DENSITY[i] = CHEMICALS[i].density;
// Exported color LUT, indexed by chem id. Used by the renderer in
// main.ts to color free-floating particles by their chemical identity.
export const CHEM_COLORS: ReadonlyArray<string> = CHEMICALS.map((c) => c.color);
// Exported name LUT, indexed by chem id. HUD and disassembler use it
// to label operands referencing chemicals.
export const CHEM_NAMES: ReadonlyArray<string> = CHEMICALS.map((c) => c.name);
// Bootstrap chem id exports. Stable across the migration (phase E
// renumbers them; tests pin to the export rather than to literals).
export const CHEM_IDS = {
  o2: 0, co2: 1, glucose: 2, aminoAcid: 3, fattyAcid: 4, minerals: 5,
  biomass: 6, adp: 7, waste: 8, chlorophyll: 9, enzyme: 10, ribosome: 11,
  biopolymer: 12, membrane: 13,
} as const;

// World-spawn weighting for free-floating particles. Replaces the
// old per-MaterialId SEED_WEIGHTS table. Minerals subsume the
// rock/sand/clay slice of the old food web (one chemical, per-particle
// density jitter recovers the old rock-heavy / clay-light visual
// variation). Biopolymer takes "organic"'s slot. The two gas chems
// (O2 / CO2) split the old gas weight 60/40 like the old material
// catabolized to.
//
// `densityJitter` lets specific chems vary their per-particle density;
// undefined means "use CHEM_BASE_DENSITY[chemId]". Minerals jitter
// across the old rock..clay range so the sediment band still reads
// as gravelly. Biopolymer jitters around 1.0 because partially-
// decomposed biomatter ranges from oily to dense protein.
//
// `seedGenericSlots` carries the per-chem "loose generic-chem
// signature" the world seeds onto particles at start-of-sim. Matches
// the old SEED_SPEC genericSlots logic so reaction substrates exist
// in the world without being free molecules.
interface SpawnChemSpec {
  chemId: number;
  weight: number;
  initialCount: number;
  densityJitter?: { lo: number; hi: number };
  seedGenericSlots?: number;
  seedGenericAmount?: number;
}
const SPAWN_CHEM_SPECS: SpawnChemSpec[] = [
  { chemId: CHEM_BIOPOLYMER, weight: 4.5, initialCount: 200, densityJitter: { lo: 0.7, hi: 1.3 }, seedGenericSlots: 3, seedGenericAmount: 0.2 },
  // Minerals: subsume rock + sand + clay. Density spans 1.4..2.6 so
  // some look like clay (lighter, slow sinkers), some like rock
  // (heavy seabed pieces).
  { chemId: CHEM_MIN, weight: 7.5, initialCount: 250, densityJitter: { lo: 1.4, hi: 2.6 }, seedGenericSlots: 1, seedGenericAmount: 0.12 },
  { chemId: CHEM_FA,  weight: 0.5, initialCount: 30, seedGenericSlots: 2, seedGenericAmount: 0.15 },
  // Gas split: O2 60%, CO2 40% (matches the old material catab table).
  { chemId: CHEM_O2,  weight: 0.3, initialCount: 12 },
  { chemId: CHEM_CO2, weight: 0.2, initialCount: 8 },
];

// SENSE_GRAD_X/Y/DENSITY ops index into per-chem sensor bins. The bin
// arrays remain at 6 wide for backward op compatibility; this table
// picks WHICH 6 chems map to those bins. Order chosen so the legacy
// operand 0..5 ranges map to chems that play similar trophic roles to
// the old material slots they replaced (operand 0 = sediment/mineral,
// operand 1 = bulk food, etc). Chemicals outside this list are
// invisible to gradient/density sensing; SENSE_CHEMICAL still reads
// the internal pool for any chem.
const SENSOR_CHEMS: ReadonlyArray<number> = [
  CHEM_MIN, CHEM_BIOPOLYMER, CHEM_FA, CHEM_O2, CHEM_CO2, CHEM_GLU,
];
const SENSOR_BIN_BY_CHEM = new Int8Array(CHEMICAL_COUNT);
SENSOR_BIN_BY_CHEM.fill(-1);
for (let i = 0; i < SENSOR_CHEMS.length; i++) SENSOR_BIN_BY_CHEM[SENSOR_CHEMS[i]] = i;
// CHEM_NAMED_MOL_IDX[k] = molCols index of the named chemical at
// chemCols[k] (k < 8). Resolved against MOLECULE_INDEX which is
// already populated above by the time this line evaluates.
const CHEM_NAMED_MOL_IDX: number[] = NAMED_CHEMICALS.map((n) => MOLECULE_INDEX[n]);

// Deterministic per-chem procedural color: walk a hue ring and pair
// with phase-driven saturation/lightness so a glance at the particle
// tells you roughly what state it tends to be in.
function procColor(rng: () => number, phase: ChemPhase): string {
  const h = Math.floor(rng() * 360);
  const sat = phase === "gas" ? 25 : phase === "solid" ? 35 : 55;
  const light = phase === "gas" ? 78 : phase === "solid" ? 45 : 60;
  return `hsl(${h}deg ${sat}% ${light}%)`;
}

function buildChemicalTable(): ChemicalDef[] {
  const out: ChemicalDef[] = [];
  for (let i = 0; i < NAMED_CHEMICALS.length; i++) {
    const spec = NAMED_CHEM_SPECS[i];
    out.push({ name: NAMED_CHEMICALS[i], ...spec });
  }
  // Procedural generics. Each property rolled deterministically so
  // reaction balance is stable across runs (and across the
  // renderer/worker boundary). Skew masses low (most biology is
  // light chemistry); phase distribution roughly 60% liquid/aqueous,
  // 25% solid, 15% gas. Permeability biased by molar mass so light
  // chems tend to diffuse. All generics carry role "none" -- only
  // bootstrap entries get special roles.
  const rng = mulberry32(0xC8E3_15CA);
  for (let i = NAMED_CHEMICAL_COUNT; i < CHEMICAL_COUNT; i++) {
    const u = rng();
    const molarMass = 0.5 + u * u * 4.5; // 0.5 .. 5.0, skewed low
    const phaseRoll = rng();
    const defaultPhase: ChemPhase =
      phaseRoll < 0.15 ? "gas" :
      phaseRoll < 0.40 ? "solid" :
      phaseRoll < 0.75 ? "liquid" : "aqueous";
    // Density: gases low, solids high, liquids/aqueous middling.
    const density =
      defaultPhase === "gas" ? 0.1 + rng() * 0.3 :
      defaultPhase === "solid" ? 1.5 + rng() * 2.0 :
      defaultPhase === "liquid" ? 0.7 + rng() * 0.8 :
      0.9 + rng() * 0.4;
    // Solubility: log-uniform across a wide range. Gases skew lower
    // (most don't dissolve well); aqueous chems skew higher.
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
    // Light molecules diffuse easily; heavy ones don't. Solids and
    // very large molecules effectively don't cross at all.
    const permBase = 1.0 / (1 + molarMass * 0.5);
    const permeability = defaultPhase === "solid" ? 0 : permBase * (0.4 + rng() * 0.6);
    // Bond energy: rolled per chem, with a small skew so a handful
    // are "high-energy" substrates that drive ATP-rich reactions.
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
      color: procColor(rng, defaultPhase),
    });
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
  // Rate multiplied by chemCols[CHEM_RIBO][i] / RIBO_REF. Set on
  // every biosynth reaction (real ribosomes drive protein synthesis).
  // Mandatory -- zero ribosomes means zero biosynth.
  riboScale: boolean;
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
      riboScale: false, chlScale: false, enzScale: false,
    });
  }
  // Overwrite the first NAMED_REACTION_COUNT generated entries with the
  // named reactions. Catalyst slots 0..N-1 correspond to the named
  // reactions, so a cell that builds catalyst[k] is boosting one of
  // these specific pathways. Subsequent slots remain the generated
  // generics.
  installNamedReactions(out);
  return out;
}
// Number of named reactions installed at the head of REACTIONS. Bumps
// from 10 to 12 in phase D to make room for biopolymer-digest (slot 10)
// and membrane-synth (slot 11). Exported so HUD / disassembler can
// label catalyst slots by their bootstrap pathway.
export const NAMED_REACTION_COUNT = 12;

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
      lightIn?: number; gateMask?: number;
      surfaceScale?: boolean; atpFloor?: boolean;
      riboScale?: boolean; chlScale?: boolean; enzScale?: boolean;
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
    gateMask: opts.gateMask ?? 0,
    surfaceScale: opts.surfaceScale ?? false,
    atpFloor: opts.atpFloor ?? false,
    riboScale: opts.riboScale ?? false,
    chlScale: opts.chlScale ?? false,
    enzScale: opts.enzScale ?? false,
  });
  // Slot index in NAMED_CHEMICALS: o2=0 co2=1 glu=2 aa=3 fa=4 min=5
  // biomass=6 adp=7 waste=8 chl=9 enz=10 rib=11 biop=12 memb=13.
  // Energy reactions: no riboScale (these aren't protein synthesis).
  out[0] = mk([CHEM_GLU, CHEM_O2], [1, 1], [CHEM_CO2], [2], +10, 16);                          // aerobic: glu+o2 -> 2 co2 + 10 atp
  out[1] = mk([CHEM_GLU], [1], [CHEM_CO2, CHEM_WASTE], [0.5, 0.5], +2, 1.5);                   // ferment: glu -> 0.5 co2 + 0.5 waste + 2 atp
  out[2] = mk([CHEM_FA, CHEM_O2], [1, 1], [CHEM_CO2], [2], +14, 1.5);                          // betaOx: fa+o2 -> 2 co2 + 14 atp
  // Photosynth: requires chlorophyll molecule (mandatory multiplier).
  out[3] = mk([CHEM_CO2], [1], [CHEM_GLU, CHEM_O2], [0.5, 0.5], -1, 1.2, { lightIn: 1, surfaceScale: true, chlScale: true });
  // Biosynth (gated by VM_OUT.synthMask bits 1/2/4/3/5/0). All scale
  // with ribosome / mRNA count (mandatory) -- this is the cell's
  // protein synthesis machinery, and zero mRNA means zero growth.
  out[4] = mk([CHEM_GLU, CHEM_MIN], [0.7, 0.3], [CHEM_AA], [1], -2, 0.4, { gateMask: 1 << 1, atpFloor: true, riboScale: true }); // synth_aa
  out[5] = mk([CHEM_GLU, CHEM_MIN], [0.9, 0.1], [CHEM_FA], [1], -6, 0.2, { gateMask: 1 << 2, atpFloor: true, riboScale: true }); // synth_fa
  out[6] = mk([CHEM_AA, CHEM_MIN], [0.5, 0.5], [CHEM_CHL], [1], -8, 0.2, { gateMask: 1 << 4, atpFloor: true, riboScale: true }); // synth_chl
  out[7] = mk([CHEM_AA, CHEM_MIN], [0.5, 0.5], [CHEM_ENZ], [1], -4, 0.4, { gateMask: 1 << 3, atpFloor: true, riboScale: true }); // synth_enz
  out[8] = mk([CHEM_AA, CHEM_MIN], [0.5, 0.5], [CHEM_RIBO], [1], -10, 0.15, { gateMask: 1 << 5, atpFloor: true, riboScale: true }); // synth_ribo
  out[9] = mk([CHEM_AA, CHEM_FA], [0.9, 0.1], [CHEM_BIOMASS], [1], -1, 0.8, { gateMask: 1 << 0, atpFloor: true, riboScale: true }); // synth_biomass
  // Biopolymer digestion. Mass-balanced split mirroring the old
  // CATAB_FRACTIONS for "organic": 0.5 glu + 0.3 aa + 0.2 fa per
  // biopolymer unit. Slightly exergonic (+1 ATP) to model the small
  // payoff a heterotroph gets from breaking polysaccharides /
  // proteins. Gated on enzyme: no enz, no digestion.
  out[10] = mk([CHEM_BIOPOLYMER], [1], [CHEM_GLU, CHEM_AA, CHEM_FA], [0.5, 0.3, 0.2], +1, 6, { enzScale: true });
  // Membrane biosynth. fa -> membrane lipid, endergonic, mRNA-gated.
  // Driven by the same SYNTH bits as synth_biomass (gate 1 << 0) so
  // a cell that biosynths a body also lays down membrane. Cheaper
  // than chl/ribo so a growing cell can afford it.
  out[11] = mk([CHEM_FA], [1], [CHEM_MEMBRANE], [1], -2, 0.6, { gateMask: 1 << 0, atpFloor: true, riboScale: true }); // synth_memb
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
    // Named-molecule multipliers: ribosomes are the cell's protein-
    // synthesis machinery (mandatory on every biosynth reaction);
    // chlorophyll is the photosynth pigment (mandatory on slot 3).
    // Both gate hard at zero -- no pigment, no photosynth; no
    // ribosomes, no biosynthesis. cells must build these molecules
    // via SYNTH_RIBO / SYNTH_CHL to actually grow / fix carbon.
    let machineryMult = 1;
    if (rxn.riboScale) {
      const r = s.chemCols[CHEM_RIBO][i];
      if (r <= 0) continue;
      machineryMult *= r / RIBO_REF;
    }
    if (rxn.chlScale) {
      const ch = s.chemCols[CHEM_CHL][i];
      if (ch <= 0) continue;
      machineryMult *= ch / CHL_REF;
    }
    if (rxn.enzScale) {
      const en = s.chemCols[CHEM_ENZ][i];
      if (en <= 0) continue;
      machineryMult *= en / ENZ_REF;
    }
    const rate = (rxn.uncatRate + rxn.vmax * (pool / CAT_REF)) * satProduct * lightMult * surface * machineryMult;
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
// The three mandatory-machinery molecules (chl/enz/ribo) gate hard at
// zero now, so their decay is what eventually kills a starving cell.
// Lowered to ~0.001 so cells survive temporary substrate shortages
// (~10 min half-life) instead of collapsing within seconds of stalling.
const ENZYME_DECAY_PER_SEC = 0.001;
const CHLORO_DECAY_PER_SEC = 0.001;
const RIBO_DECAY_PER_SEC = 0.001;
const MIN_VIABLE_BIOMASS = 0.5;
// A cell with no ribosome can't turn over biomass or rebuild lost
// enzymes. Ribosome decays slowly (~0.1%/sec) so a 0.01 threshold
// gives healthy cells thousands of sim-sec of headroom before falling
// below it without active SYNTH_RIBO.
const MIN_VIABLE_RIBOSOME = 0.01;
// Amino acid is much more fluid -- biosynth + reactions consume it
// in bursts and maintenance decay refills it. A 0.001 threshold
// catches cells with *essentially zero* aa (no synth, no prey)
// without nuking cells in transient low-aa states mid-tick.
const MIN_VIABLE_AMINOACID = 0.001;

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
// Total mass per bubble (drawn from the atmosphere). Composition is
// sampled from atmospheric mole fractions, so a CO2-rich atmosphere
// yields CO2-rich bubbles (and O2-depleted ones).
const AERATION_MASS_PER_BUBBLE = AERATION_O2_PER_BUBBLE;
// Starting atmospheric inventory. Earthlike: mostly O2, trace CO2,
// nothing else. Large enough that early bubble composition is stable;
// not so large that long runs can't shift it via cellular excretion.
const ATMOSPHERE_INIT_O2 = 8000;
const ATMOSPHERE_INIT_CO2 = 200;
function initialAtmosphere(): Molecules {
  const a = emptyMolecules();
  a.o2 = ATMOSPHERE_INIT_O2;
  a.co2 = ATMOSPHERE_INIT_CO2;
  return a;
}

// Saturation target for each chem in the ambient pool. Water in
// contact with the atmosphere equilibrates toward these values; the
// equilibration rate is what aerateAmbient() drives.
const AMBIENT_TARGET = new Float32Array(CHEMICAL_COUNT);
AMBIENT_TARGET[CHEM_O2] = 12;   // matches the old O2_AMBIENT constant
AMBIENT_TARGET[CHEM_CO2] = 1;   // matches CO2_AMBIENT

function initialAmbient(): Float32Array {
  // Start the water column at its equilibrium target so the first
  // ticks aren't dominated by ambient transients.
  return new Float32Array(AMBIENT_TARGET);
}

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
// Minimal field set the surface/temperature/light helpers read from
// the world. World naturally satisfies this; so does RenderSnapshot,
// which lets the renderer call the same helpers off a snapshot.
export interface WorldEnv {
  t: number;
  height: number;
  surfaceY: number;
  surfaceWaveAmp: number;
  surfaceLength: number;
  surfacePeriod: number;
  swellLength: number;
  swellPeriod: number;
  updraftLength: number;
  updraftPeriod: number;
  disturbanceIntensity: number;
  tempSurface: number;
  tempBottom: number;
  tempPatchAmp: number;
  tempPatchLength: number;
  tempPatchPeriod: number;
  dayPhase: number;
}

export function surfaceActivity(world: WorldEnv): number {
  const t = world.t;
  const env =
    0.55 +
    0.25 * Math.sin(t * (2 * Math.PI / 37)) +
    0.20 * Math.sin(t * (2 * Math.PI / 91) + 1.7);
  const envClamped = Math.max(0.15, Math.min(1.0, env));
  return envClamped * (1 + 3 * world.disturbanceIntensity);
}

export function surfaceYAt(world: WorldEnv, x: number): number {
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

export function temperatureAt(world: WorldEnv, x: number, y: number): number {
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
export function solarLight(world: { dayPhase: number }): number {
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
// Per-cell bitmap: 1 if any obstacle (with particle-radius margin)
// touches the cell. Lets collideObstaclesSoa reject a particle that
// happens to be in a gap between obstacles with a single byte read,
// avoiding the per-band-obstacle AABB sweep + ~30-lobe inner loop on
// what is the dominant in-transit-particle population near the floor.
const OBSTACLE_CELL_SIZE = 12;
let OBSTACLE_CELL_GRID: Uint8Array = new Uint8Array(0);
let OBSTACLE_CELL_COLS = 0;
let OBSTACLE_CELL_ROWS = 0;

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
  // Build the cell-level bitmap. Margin matches the band index so the
  // worst-case particle just touching the AABB still hits the bitmap.
  OBSTACLE_CELL_COLS = Math.max(1, Math.ceil(world.width / OBSTACLE_CELL_SIZE));
  OBSTACLE_CELL_ROWS = Math.max(1, Math.ceil(world.height / OBSTACLE_CELL_SIZE));
  const cellCount = OBSTACLE_CELL_COLS * OBSTACLE_CELL_ROWS;
  if (OBSTACLE_CELL_GRID.length !== cellCount) {
    OBSTACLE_CELL_GRID = new Uint8Array(cellCount);
  } else {
    OBSTACLE_CELL_GRID.fill(0);
  }
  for (const ob of world.obstacles) {
    const x0 = Math.max(0, Math.floor((ob.minX - margin) / OBSTACLE_CELL_SIZE));
    const x1 = Math.min(OBSTACLE_CELL_COLS - 1, Math.floor((ob.maxX + margin) / OBSTACLE_CELL_SIZE));
    const y0 = Math.max(0, Math.floor((ob.minY - margin) / OBSTACLE_CELL_SIZE));
    const y1 = Math.min(OBSTACLE_CELL_ROWS - 1, Math.floor((ob.maxY + margin) / OBSTACLE_CELL_SIZE));
    for (let y = y0; y <= y1; y++) {
      const row = y * OBSTACLE_CELL_COLS;
      for (let x = x0; x <= x1; x++) OBSTACLE_CELL_GRID[row + x] = 1;
    }
  }
}

function resolveObstacleCollisions(world: World): void {
  if (world.obstacles.length === 0) return;
  const minY = OBSTACLES_MIN_Y;
  const ps = world.particleStore;
  const pn = world.particles.length;
  // Skip asleep (sediment) particles. They were resolved against any
  // obstacle they touched when they fell asleep, and they don't move
  // on their own once asleep -- so each tick of obstacle collision on
  // them is pure waste. Without this skip, oColl scales with sediment
  // accumulation: at np=2325 it grew from 0.16ms to >1.5ms/tick over
  // a few minutes of sim time, dominating the worker budget.
  // COLLISION_ASLEEP is populated by resolveCollisions which runs
  // earlier in step().
  collideObstaclesSoa(ps.x, ps.y, ps.vx, ps.vy, ps.r, COLLISION_ASLEEP, pn, world.restitution, minY, 0);
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
  if (OBSTACLE_BANDS_COLS <= 0) return;
  const rk = R[idx];
  if (Y[idx] + rk < minY) return;
  const xk = X[idx], yk = Y[idx];
  if (xk !== xk || yk !== yk || rk !== rk) return;
  // Cell-bitmap early exit -- same idea as the particle loop above.
  const cellSize = OBSTACLE_CELL_SIZE;
  const cellCols = OBSTACLE_CELL_COLS;
  const cellRows = OBSTACLE_CELL_ROWS;
  let gcx = (xk / cellSize) | 0;
  let gcy = (yk / cellSize) | 0;
  if (gcx < 0) gcx = 0; else if (gcx >= cellCols) gcx = cellCols - 1;
  if (gcy < 0) gcy = 0; else if (gcy >= cellRows) gcy = cellRows - 1;
  if (!OBSTACLE_CELL_GRID[gcy * cellCols + gcx]) return;
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
  ASLEEP: Uint8Array,
  n: number, e: number, minY: number, _pad: number,
): void {
  void _pad;
  // Defensive: if the obstacle index wasn't built (cols=0) the per-
  // particle clamp below would land bx at -1 and throw on undefined.
  if (OBSTACLE_BANDS_COLS <= 0) return;
  const cellSize = OBSTACLE_CELL_SIZE;
  const cellCols = OBSTACLE_CELL_COLS;
  const cellRows = OBSTACLE_CELL_ROWS;
  for (let k = 0; k < n; k++) {
    if (ASLEEP[k]) continue;
    const yk = Y[k]; const rk = R[k];
    if (yk + rk < minY) continue;
    const xk = X[k];
    // NaN in any of the coordinate / radius reads would propagate
    // through Math.floor and bypass both clamp branches (every NaN
    // comparison is false), leaving bx as NaN and OBSTACLE_BANDS[NaN]
    // as undefined. Skip and let upstream code recover the particle.
    if (xk !== xk || yk !== yk || rk !== rk) continue;
    // Cell-bitmap early exit: a single byte read rejects particles in
    // obstacle-free cells before the per-band AABB sweep.
    let gcx = (xk / cellSize) | 0;
    let gcy = (yk / cellSize) | 0;
    if (gcx < 0) gcx = 0; else if (gcx >= cellCols) gcx = cellCols - 1;
    if (gcy < 0) gcy = 0; else if (gcy >= cellRows) gcy = cellRows - 1;
    if (!OBSTACLE_CELL_GRID[gcy * cellCols + gcx]) continue;
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

export function createWorld(
  width: number,
  height: number,
  opts?: { delayedSpawn?: boolean },
): World {
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
    // Transient set of currently-alive founder cell IDs. Used to give
    // every founder a fixed 180s lifespan after spawn so the founders
    // can't dominate indefinitely -- their descendants have to take
    // over the niche, or it goes extinct and the top-up loop seeds a
    // fresh lineage. NOT persisted across save/load; reloaded saves
    // lose tracking and existing founders live full lives.
    founderIds: new Set<number>(),
    gravity: 60,
    drag: 0.6,
    surfaceAmp: 55, surfaceLength: 200, surfacePeriod: 7, surfaceDecay: 90,
    swellAmp: 5, swellLength: 600, swellPeriod: 18, swellDecay: 520,
    zStirAmp: 4,
    updraftAmp: 4, updraftLength: 540, updraftPeriod: 28,
    surfaceY: height * SURFACE_Y_FRAC,
    surfaceWaveAmp: 14,
    aerationRate: width * AERATION_PER_PX,
    atmosphere: initialAtmosphere(),
    ambient: initialAmbient(),
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
  // Reset module-level caches that aren't on the world object. These
  // are process-globals indexed by particle/creature slot or by sim
  // time -- if a previous world left them populated, the new world
  // sees stale state until the cache happens to refresh. Tests + any
  // future multi-world / hot-reload path needs this.
  pebbleCountCache = 0;
  pebbleCountStaleTicks = PEBBLE_COUNT_REFRESH_TICKS;
  lastSpeciesPruneAt = -SPECIES_PRUNE_INTERVAL_SEC;
  NEXT_CREATURE_ID = 1;
  // Rocks disabled. rebuildObstacleIndex still runs to set the indexes
  // to a consistent empty state so the obstacle-collision early exits
  // (world.obstacles.length === 0) trip cleanly.
  rebuildObstacleIndex(world);
  // Seed the world with a variety of particles up front. Distribution
  // is intentionally uneven: mineral substrate dominates, with rare
  // payload-bearing organics that give early cells a direct (rather
  // than synthesis-only) path to specific molecules. Runs for both
  // delayed and immediate-spawn worlds -- the warmup gates only
  // suppress *replenish* / aerate / founders, not the initial mix.
  seedInitialParticles(world);
  // World starts empty: just water and a handful of founder cells.
  // Each founder is independent (its own genome, its own lineageRoot
  // id) so we get several parallel lineages to watch. Particles
  // trickle in via replenishParticles() afterward.
  //
  // Production paths (sim.worker.ts main world init) pass
  // { delayedSpawn: true } so the user-facing experience gets a
  // warmup window: pebbles drop first, water column fills around
  // WATER_FILL_DELAY_SEC, founders enter around
  // FOUNDER_SPAWN_DELAY_SEC. Tests + direct callers use the default
  // (no warmup) and get founders synchronously here so existing
  // unit tests keep working.
  if (!opts?.delayedSpawn) {
    // Skip ahead past the spawn-delay gates first so founders' bornAt
    // (set inside spawnFounder from world.t) matches the wall clock
    // they're entering at. Otherwise tests see creatures with
    // bornAt=0 and age=61 immediately.
    world.t = Math.max(FOUNDER_SPAWN_DELAY_SEC, WATER_FILL_DELAY_SEC) + 1;
    // 60-100% of FOUNDER_TARGET seeded immediately; the top-up loop
    // fills the rest in step().
    const initialFounders = Math.round(FOUNDER_TARGET * (0.6 + Math.random() * 0.4));
    for (let i = 0; i < initialFounders; i++) {
      const f = spawnFounder(world);
      if (i === 0) {
        world.anchorGenome = new Uint8Array(f.genome);
        f.color = genomeColor(f.genome, world.anchorGenome);
      }
    }
  }
  return world;
}

// Steady-state target for live founder lineages. Top-up loop pushes
// the live count back toward TARGET whenever it falls below. Initial
// founder spawn is now deferred to the same top-up path (gated by
// FOUNDER_SPAWN_DELAY_SEC below), so there's no separate "initial
// batch" constants any more.
const FOUNDER_TARGET = 50;
// Hold off all founder spawning (initial + top-up) for the first
// FOUNDER_SPAWN_DELAY_SEC sim-seconds of a fresh world. Gives the
// pebble bed time to settle and the water column to populate before
// any creatures enter the simulation -- otherwise founders spawn into
// an empty/loading world and the early dynamics look off.
const FOUNDER_SPAWN_DELAY_SEC = 60;
// Founders live for exactly this many sim-seconds after they're
// spawned, then autolyze regardless of biomass / energy state. Forces
// turnover: descendants must take over the niche, otherwise the
// lineage goes extinct and the top-up loop seeds a fresh genome
// elsewhere. Replaces the "founder dominance forever" steady state.
const FOUNDER_LIFESPAN_SEC = 180;
// Defer everything-but-pebbles for the early game. Pebbles spawn from
// t=0 so the sediment bed forms first; normal per-material replenish
// and aeration hold until WATER_FILL_DELAY_SEC so the floor is settled
// before the water column populates. Founders gate is later still.
const WATER_FILL_DELAY_SEC = 30;

function spawnFounder(world: World): Creature {
  const z = world.depth * 0.5;
  // Reject-sample positions until we find one that's not within
  // FOUNDER_MIN_SPACING of an existing creature. With ~25 founders
  // dropped at once into a 720x420 region, pure uniform random gives
  // ~1.2 overlapping pairs per batch in expectation -- enough that
  // "every reset has a cell inside another" was reliably true.
  // Spacing is 6x MIN_CREATURE_R so even after the founder scoop
  // bulks a body up modestly, neighbours stay distinct.
  const FOUNDER_MIN_SPACING = MIN_CREATURE_R * 6;
  const minSpacingSq = FOUNDER_MIN_SPACING * FOUNDER_MIN_SPACING;
  let x = 0, y = 0;
  const creatures = world.creatures;
  const nc = creatures.length;
  for (let attempt = 0; attempt < 32; attempt++) {
    x = world.width * (0.1 + 0.8 * Math.random());
    y = world.height * (0.1 + 0.6 * Math.random());
    let okay = true;
    for (let k = 0; k < nc; k++) {
      const other = creatures[k];
      const dx = other.x - x;
      const dy = other.y - y;
      if (dx * dx + dy * dy < minSpacingSq) { okay = false; break; }
    }
    if (okay) break;
  }
  const c = makeCreature(world, x, y, z);
  c.bornAt = world.t;
  c.lineageRoot = world.nextLineageRoot++;
  world.creatures.push(c);
  world.founderIds.add(c.id);
  noteCreatureBirth(world, c, undefined);
  return c;
}

// Initial particle seeding. Called once per world creation, before
// any time-gated replenish kicks in. Distribution is set via the
// per-chem SPAWN_CHEM_SPECS table at the top of the file (replaced
// the old MaterialId-keyed SEED_SPEC). Each spawned particle carries
// a small generic-chem signature (reaction substrates/products
// floating in the environment) so cells have varied chemistry to
// react with at world start.

function buildSeedGenericChem(slots: number, amount: number): Float32Array | undefined {
  if (slots <= 0) return undefined;
  const chem = new Float32Array(GENERIC_CHEMICAL_COUNT);
  for (let i = 0; i < slots; i++) {
    const slot = Math.floor(Math.random() * GENERIC_CHEMICAL_COUNT);
    // += so a re-rolled slot accumulates instead of overwriting.
    chem[slot] += Math.random() * amount;
  }
  return chem;
}

function seedInitialParticles(world: World): void {
  const W = world.width;
  const H = world.height;
  const surfaceY = world.surfaceY;
  const yRange = (H - surfaceY) * 0.85;
  for (const spec of SPAWN_CHEM_SPECS) {
    for (let i = 0; i < spec.initialCount; i++) {
      const r = 1 + Math.random() * 1.5;
      const genericChem = buildSeedGenericChem(spec.seedGenericSlots ?? 0, spec.seedGenericAmount ?? 0);
      pushParticle(world, {
        x: Math.random() * W,
        y: surfaceY + Math.random() * yRange,
        z: r + Math.random() * (world.depth - 2 * r),
        vx: 0, vy: 0, vz: (Math.random() - 0.5) * 20,
        r,
        chemId: spec.chemId,
        density: rollChemDensity(spec),
        genericChem,
      });
    }
  }
  seedAdpParticles(world);
}

// Primordial adenosine: spawn N organic particles each carrying a
// small adp molecule payload. Adenosine (adp + atp) is otherwise a
// closed pool in this sim's food web -- death / predation / excretion
// cycle it between cells but nothing creates it from outside, so a
// one-time seed gives the initial population a richer ATP economy
// than just the founder adp:5 inheritance can support. Models
// "primordial salvage food" -- pre-biotic adenosine that cells
// scavenge before evolving their own synthesis.
//
// Particles are molecule-tagged so INGEST routes them straight into
// c.molecules.adp (no catabolism needed); see the if(p.molecules)
// branch of the INGEST handler. Material is organic for visual /
// gravity consistency with other molecule-bearing particles.
const SEED_ADP_PARTICLES = 500;
const SEED_ADP_PER_PARTICLE = 1.0;

function seedAdpParticles(world: World): void {
  const W = world.width;
  const H = world.height;
  const surfaceY = world.surfaceY;
  const yRange = (H - surfaceY) * 0.85;
  for (let i = 0; i < SEED_ADP_PARTICLES; i++) {
    const r = 1 + Math.random() * 1.5;
    const molecules = emptyMolecules();
    molecules.adp = SEED_ADP_PER_PARTICLE;
    pushParticle(world, {
      x: Math.random() * W,
      y: surfaceY + Math.random() * yRange,
      z: r + Math.random() * (world.depth - 2 * r),
      vx: 0, vy: 0, vz: (Math.random() - 0.5) * 20,
      r,
      chemId: CHEM_BIOPOLYMER,
      density: 0.7 + Math.random() * 0.6, // matches the old organic jitter
      molecules,
    });
  }
}

// Pebble-sized sand grains. A SAND_BIG_FRACTION of new sand particles
// spawn at this much larger radius so the same world looks "full of
// sand" with far fewer entries in the O(N) per-tick buckets (forces,
// snapshot, render). Physics scales correctly without changes: the
// existing math uses radius for drag and density (not radius) for
// gravity/buoyancy.
//
// Cap chosen vs the collision broad-phase cellSize=12px. The
// neighbor-cell sweep guarantees pair soundness when r_a+r_b <=
// cellSize, so two big grains in adjacent cells can occasionally
// miss a collision while in transit (radius 8 + 8 = 16 > 12). Once
// they settle and go asleep the pair-check is short-circuited
// anyway, so the visual artifact only shows during falling. Going
// beyond ~r=8 would require widening cellSize, which trades pColl
// cost for fewer big sand misses -- not worth it at current scale.
// Capped at 11 so pebble-pebble pair detection is robust against the
// particle-particle collision broad phase: GRID_CELL_SIZE=12 with a
// one-cell-over neighbor sweep reliably finds pairs only when
// r_a + r_b <= 2 * GRID_CELL_SIZE = 24. Previous range r=10-16 hit
// combined-radius 32, so half the stacked pebble pairs went undetected
// -- upper layers fell through lower ones at gravity terminal
// velocity (~14.5 px/s) instead of settling, producing the "popcorn"
// look. With r in [8, 11] the bed actually settles (~30% transient
// motion at steady state, vs 67% before).
const SAND_BIG_R_MIN = 8;
const SAND_BIG_R_MAX = 11;
// Random-pebble injection into the normal weighted replenish flow is
// disabled now that pebbles have a dedicated spawn path with its own
// count target (PEBBLE_TARGET below). Keeping spawnRadius() in place
// so the wiring is reversible by flipping this back to >0.
const SAND_BIG_FRACTION = 0;
// Dedicated pebble population for the sediment bed. Independent of
// world.particleTarget so the floor doesn't crowd out tiny sand /
// organic / etc that the biology layer depends on. Total particle
// count at steady state ends up ≈ particleTarget + PEBBLE_TARGET.
//
// 1100 pebbles at diameter 10-16px is ~10x the previous floor
// density -- explicitly requested. At ~150 px² per pebble that's
// ~165k px² of visual area on an 800-wide floor, enough for a thick
// stacked sediment band. Lower this if the floor reads as too deep.
const PEBBLE_TARGET = 138;
// Per-second spawn rate when below target. Sized to fill the bed in
// roughly 10 sim-seconds from a cold world without overshooting the
// per-frame replenish budget.
const PEBBLE_SPAWN_RATE = 120;
// Refresh interval for the cached pebble count. Counting every call
// would be a full O(N) scan per replenish; doing it every N refresh
// ticks is fine because the count drifts at <<1 pebble/tick.
const PEBBLE_COUNT_REFRESH_TICKS = 30;
let pebbleCountCache = 0;
let pebbleCountStaleTicks = PEBBLE_COUNT_REFRESH_TICKS; // force first refresh

function countPebbles(world: World): number {
  const ps = world.particleStore;
  const PR = ps.r;
  const PC = ps.chemId;
  const n = world.particles.length;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (PC[i] === CHEM_MIN && PR[i] >= SAND_BIG_R_MIN) count++;
  }
  return count;
}

function spawnRadius(chemId: number): number {
  // Mineral particles can occasionally roll as pebble-sized grains
  // (controlled by SAND_BIG_FRACTION; today 0). All others use the
  // base 1..2.5 range.
  if (chemId === CHEM_MIN && Math.random() < SAND_BIG_FRACTION) {
    return SAND_BIG_R_MIN + Math.random() * (SAND_BIG_R_MAX - SAND_BIG_R_MIN);
  }
  return 1 + Math.random() * 1.5;
}

export function seedParticles(world: World, n: number): void {
  world.particles.length = 0;
  world.particleStore.n = 0;
  for (let i = 0; i < n; i++) {
    const spec = pickSpawnSpec();
    const r = spawnRadius(spec.chemId);
    // Spawn below the surface so the initial state matches the wall.
    const yRange = (world.height - world.surfaceY) * 0.85;
    pushParticle(world, {
      x: Math.random() * world.width,
      y: world.surfaceY + Math.random() * yRange,
      z: r + Math.random() * (world.depth - 2 * r),
      vx: 0, vy: 0, vz: (Math.random() - 0.5) * 20,
      r,
      chemId: spec.chemId,
      density: rollChemDensity(spec),
    });
  }
}

// Per-spawn density jitter, indexed by spawn spec. Specs with no
// jitter clause fall through to undefined (force-pickup of the chem's
// default density at force-time).
function rollChemDensity(spec: SpawnChemSpec): number | undefined {
  if (!spec.densityJitter) return undefined;
  const { lo, hi } = spec.densityJitter;
  // Triangular distribution around the midpoint -- recovers the
  // varied-density "look" of the old rock/sand/clay split that's now
  // collapsed into a single mineral chem.
  const tri = Math.random() + Math.random() - 1; // -1..1
  const mid = (lo + hi) / 2;
  const half = (hi - lo) / 2;
  return mid + tri * half;
}

function pickSpawnSpec(): SpawnChemSpec {
  let total = 0;
  for (const s of SPAWN_CHEM_SPECS) total += s.weight;
  let pick = Math.random() * total;
  for (const s of SPAWN_CHEM_SPECS) {
    pick -= s.weight;
    if (pick <= 0) return s;
  }
  return SPAWN_CHEM_SPECS[SPAWN_CHEM_SPECS.length - 1];
}

// "Lucky DNA + junk" founder bootstrap. A membrane forms around a
// random patch; whatever loose particles happen to be in the patch
// become the cell's starting substrate. The genome decides what
// reactions the cell can run; the environment decides what it has
// to work with. No hardcoded reserve / molecule yolk -- the
// genome's SYNTH_* presence only sizes the absolute minimum
// machinery seed (a "primordial soup" of mandatory-multiplier
// molecules) so first-generation cells can fire their first
// reactions before they have a chance to build more. Each founder
// samples a random radius in [FOUNDER_SCOOP_R_MIN, FOUNDER_SCOOP_R_MAX]
// so initial cell sizes vary -- some founders get a lean scoop and
// stay tiny, others land in a particle-rich patch and start fat.
const FOUNDER_SCOOP_R_MIN = 14;
const FOUNDER_SCOOP_R_MAX = 50;
function makeCreature(world: World, x: number, y: number, z: number): Creature {
  const genome = makeRandomViableGenome();
  let hasChl = false, hasEnz = false;
  for (let i = 0; i < genome.length; i++) {
    const b = genome[i];
    if (b === OP.SYNTH_CHL) hasChl = true;
    else if (b === OP.SYNTH_ENZ) hasEnz = true;
  }
  // Minimal cell body: biomass just above MIN_VIABLE_BIOMASS (the
  // membrane), a trickle of ADP and ATP to enable tick-1 chemistry,
  // and the mandatory-multiplier molecules whose genome op the cell
  // carries. SYNTH_RIBO is universal-required so ribosome is too;
  // chl/enz only seeded if their op is present. Nothing else --
  // glucose, aa, fa, reserves all come from the scoop below.
  const c = newCreature(world.creatureStore, {
    x, y, z,
    r: MIN_CREATURE_R,
    density: 1.0,
    energy: 2,
    senseRange: computeSenseRange(genome),
    thrustAccel: computeThrustAccel(genome),
    genome,
    vm: newVMState(),
    color: genomeColor(genome),
    speciesKey: genomeKey(genome),
    molecules: {
      biomass: 1,
      adp: 5,
      ribosome: 1,
      // Seed a small amino acid pool so the new viability threshold
      // (MIN_VIABLE_AMINOACID) doesn't kill founders before they have
      // a chance to run SYNTH_AA / PREDATE / ENGULF. Maintenance
      // decay also funnels a fraction of biomass-loss into aa each
      // tick, but that takes a few sim-sec to accumulate.
      aminoAcid: 0.5,
      chlorophyll: hasChl ? 0.5 : 0,
      enzyme: hasEnz ? 0.5 : 0,
    },
  });
  // Scoop every loose particle within FOUNDER_SCOOP_RADIUS into the
  // cell. The particle's chemId deposits straight into the matching
  // chemCols slot; an accompanying multi-chem corpse payload (genericChem)
  // adds to the cell's generic-chem pool. Each absorbed particle is
  // removed from the world. An empty patch means a very lean cell
  // that probably won't survive long; that's the luck of biogenesis.
  const scoopR = FOUNDER_SCOOP_R_MIN + Math.random() * (FOUNDER_SCOOP_R_MAX - FOUNDER_SCOOP_R_MIN);
  const rSq = scoopR * scoopR;
  const ps = world.particles;
  const cstore = c.store; const cidx = c.idx;
  for (let i = ps.length - 1; i >= 0; i--) {
    const p = ps[i];
    const dx = p.x - x;
    const dy = p.y - y;
    const dz = p.z - z;
    if (dx * dx + dy * dy + dz * dz >= rSq) continue;
    // Pebbles (large mineral grains, part of the sediment bed) are not
    // absorbed -- a founder spawning near the floor would otherwise
    // inhale a full pebble's worth of mineral mass and skew its
    // starting chem pool wildly. Leave them in the world.
    if (p.chemId === CHEM_MIN && p.r >= SAND_BIG_R_MIN) continue;
    cstore.chemCols[p.chemId][cidx] += mass(p);
    if (p.molecules) {
      for (const k of MOLECULE_IDS) c.molecules[k] += p.molecules[k];
    }
    if (p.genericChem) {
      const gcCols = cstore.genericChemCols;
      for (let k = 0; k < GENERIC_CHEMICAL_COUNT; k++) {
        gcCols[k][cidx] += p.genericChem[k];
      }
    }
    removeParticleAt(world, i);
  }
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
// 60s was 240s. The longer grace let world.species balloon to
// 1000+ entries during high-mutation periods, and every render
// iterates the snapshot's species list -- spiky cost at extinction
// events. 60s still preserves recently-lost species in the
// phylogeny strip long enough to read; older species fall off.
const SPECIES_GRACE_SEC = 60;
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


// Per-chem permeability cache. Mirrors CHEMICALS[k].permeability but
// flat so the hot loop avoids a property dispatch per cell-chem pair.
// Built once at module load alongside CHEM_BASE_DENSITY.
const CHEM_PERMEABILITY = new Float32Array(CHEMICAL_COUNT);
for (let i = 0; i < CHEMICAL_COUNT; i++) CHEM_PERMEABILITY[i] = CHEMICALS[i].permeability;

// Phase F: generalized passive diffusion. Each diffusable chem flows
// down its gradient between the cell's pool and world.ambient, with
// rate scaled by per-chem permeability * cell surface area. Mass
// conserved across cell and ambient. Replaces the old O2/CO2-only
// hard-coded path.
//
// AMBIENT_FLOW_RATE: shared dimensionless scaler so individual
// chems' permeability values stay in the 0..1 range. Tuned so O2
// at permeability 1.0 + surface 1.0 + gap 12 yields ~0.7 mass/sec,
// matching the old `O2_DIFFUSION_PER_R * 0.1` rate.
const AMBIENT_FLOW_RATE = 0.6;
function diffuseAmbient(c: Creature, world: World, dt: number): void {
  const s = c.store; const i = c.idx;
  const surface = s.r[i] / MIN_CREATURE_R;
  const ambient = world.ambient;
  const cols = s.chemCols;
  for (let j = 0; j < DIFFUSABLE_CHEM_IDS.length; j++) {
    const k = DIFFUSABLE_CHEM_IDS[j];
    const perm = CHEM_PERMEABILITY[k];
    if (perm <= 0) continue;
    const gap = ambient[k] - cols[k][i];
    if (gap === 0) continue;
    const flow = perm * surface * gap * AMBIENT_FLOW_RATE * dt;
    cols[k][i] += flow;
    // Mass conservation: every unit gained by the cell came from
    // ambient (or vice versa for outflow). Clamp ambient at 0 -- a
    // depleted pool stays depleted until something refills it.
    const next = ambient[k] - flow;
    ambient[k] = next < 0 ? 0 : next;
  }
}

// Ambient ↔ atmosphere equilibration. Once per tick, gases in the
// atmosphere dissolve into ambient (and vice versa) toward
// AMBIENT_TARGET. Mass conserved: every unit added to ambient is
// removed from atmosphere. Driven by surface activity so a calm
// surface lets gases stratify; a stormy surface mixes them in.
const ATM_AMBIENT_RATE = 0.5; // fraction of gap that crosses per sec at peak activity
function aerateAmbient(world: World, dt: number): void {
  const ambient = world.ambient;
  const atm = world.atmosphere;
  // Surface activity 0..1; even calm water has 0.3 of the rate.
  const act = 0.3 + 0.7 * surfaceActivity(world);
  const rate = ATM_AMBIENT_RATE * act * dt;
  // O2 + CO2 are the gases that exchange with atmosphere today;
  // other chems' atmospheric components are zero so they don't
  // exchange. The loop is bounded by DIFFUSABLE_CHEM_IDS so adding
  // a new gas to AMBIENT_TARGET picks it up automatically.
  const pairs: Array<[number, keyof Molecules]> = [
    [CHEM_O2, "o2"],
    [CHEM_CO2, "co2"],
  ];
  for (const [k, molKey] of pairs) {
    const target = AMBIENT_TARGET[k];
    if (target <= 0) continue;
    const gap = target - ambient[k];
    // Pull from atm if ambient is below target, push back to atm if
    // above. Magnitude bounded by available atmospheric mass.
    let flow = gap * rate;
    if (flow > 0) {
      if (flow > atm[molKey]) flow = atm[molKey];
    } else {
      // Outflow from ambient back to atmosphere is unbounded by atm.
      const limit = ambient[k];
      if (-flow > limit) flow = -limit;
    }
    ambient[k] += flow;
    atm[molKey] -= flow;
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

// Generic reaction runner for paths outside the REACTIONS table -- the
// engine itself inlines the same logic for perf, but for one-off
// reactions where the product lives somewhere other than chemCols
// (catalystCols, or a future "atmosphere", etc.) this shares the
// substrate gate + MM saturation + ATP/ADP bookkeeping so we don't
// drift from the engine's math. Caller's writeProduct(amt) sees the
// final reaction extent and handles wherever the product belongs.
function runSyntheticReaction(
  c: Creature, dt: number,
  sChem: ArrayLike<number>, sCount: ArrayLike<number>,
  atpDelta: number, vmax: number, atpFloor: boolean,
  writeProduct: (amt: number) => void,
): void {
  const s = c.store; const i = c.idx;
  const KM = KM_DEFAULT;
  let limit = Infinity;
  let satProduct = 1;
  for (let j = 0; j < sChem.length; j++) {
    const have = s.chemCols[sChem[j]][i];
    const need = sCount[j];
    const ratio = have / need;
    if (ratio < limit) limit = ratio;
    satProduct *= ratio / (ratio + KM);
  }
  if (limit <= 0) return;
  if (atpDelta < 0) {
    const floor = atpFloor ? BIOSYNTH_ATP_FLOOR : 0;
    const eAvail = (s.energy[i] - floor) / -atpDelta;
    if (eAvail <= 0) return;
    if (eAvail < limit) limit = eAvail;
    satProduct *= eAvail / (eAvail + KM);
  } else if (atpDelta > 0) {
    const adpAvail = s.chemCols[CHEM_ADP][i] / atpDelta;
    if (adpAvail <= 0) return;
    if (adpAvail < limit) limit = adpAvail;
    satProduct *= adpAvail / (adpAvail + KM);
  }
  const rate = vmax * satProduct;
  let amt = rate * dt;
  if (amt > limit) amt = limit;
  if (amt <= 0) return;
  for (let j = 0; j < sChem.length; j++) {
    s.chemCols[sChem[j]][i] -= sCount[j] * amt;
  }
  if (atpDelta !== 0) {
    s.energy[i] += atpDelta * amt;
    s.chemCols[CHEM_ADP][i] -= atpDelta * amt;
  }
  writeProduct(amt);
}

// Catalyst synthesis. Catalysts live in catalystCols[slot] rather
// than in chemCols, so this can't be a REACTIONS-table entry; but
// the substrate / ATP / saturation math is the same as every biosynth
// reaction, so we delegate to runSyntheticReaction. Substrate fixed
// at 0.5 aa + 0.5 min (same as enzymes / chlorophyll / ribosomes).
const CAT_SUBSTRATE_CHEM = new Uint8Array([3, 5]); // aa, min in chemCols
const CAT_SUBSTRATE_COUNT = new Float32Array([0.5, 0.5]);
function biosynthCatalyst(
  c: Creature,
  dt: number,
  vmax: number,
  atpCost: number,
  slot: number,
): void {
  const col = c.store.catalystCols[slot];
  const i = c.idx;
  runSyntheticReaction(
    c, dt, CAT_SUBSTRATE_CHEM, CAT_SUBSTRATE_COUNT,
    -atpCost, vmax, /* atpFloor */ true,
    (amt) => { col[i] += amt; },
  );
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
        spawnExcretedParticle(c, world, CHEM_CO2, affordable, mol);
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
        spawnExcretedParticle(c, world, CHEM_WASTE, affordable, mol);
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
// Cached list of chemical ids whose CHEMICALS[id].permeability is nonzero.
// Built once from the table so the hot loop iterates a tight array.
// (Replaces the old `diffusable: boolean` -- permeability is the
// continuous version, with zero meaning "structural / can't cross".)
const DIFFUSABLE_CHEM_IDS: number[] = (() => {
  const out: number[] = [];
  for (let i = 0; i < CHEMICAL_COUNT; i++) if (CHEMICALS[i].permeability > 0) out.push(i);
  return out;
})();
function runOrganelleChemistry(
  inner: Creature,
  host: Creature,
  dt: number,
  dtT: number,
  light: number,
): void {
  // Catabolism is now driven by the biopolymer-digest reaction
  // (REACTIONS[10]) like every other pathway.
  runGenericReactions(inner, dtT, light, inner.organelleSynthMask);
  maintenanceDecay(inner, dt);

  // Bidirectional diffusion across the inner/host membrane. Net flow
  // toward the lower concentration -- surplus products leak out,
  // scarce substrates leak in. Diffusable set is driven by the
  // Chemical table's `diffusable` flag, so adding a new chemical
  // automatically participates (or doesn't) based on its type.
  const rate = ORGANELLE_DIFFUSE_PER_SEC * dt;
  // ATP isn't a chemical slot but it does cross the membrane like one.
  const dAtp = (inner.energy - host.energy) * rate;
  inner.energy -= dAtp;
  host.energy += dAtp;
  const innerCols = inner.store.chemCols;
  const hostCols = host.store.chemCols;
  const ii = inner.idx, hi = host.idx;
  for (let j = 0; j < DIFFUSABLE_CHEM_IDS.length; j++) {
    const k = DIFFUSABLE_CHEM_IDS[j];
    const ic = innerCols[k];
    const hc = hostCols[k];
    const d = (ic[ii] - hc[hi]) * rate;
    ic[ii] -= d;
    hc[hi] += d;
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
  chemId: number,
  m: number,
  molecules?: Molecules,
  genericChem?: Float32Array,
): void {
  if (m < EXCRETE_MIN_AMOUNT) {
    // Round-off; just drop it on the floor of the cell (lose to environment).
    return;
  }
  const density = CHEM_BASE_DENSITY[chemId];
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
    chemId,
    molecules,
    genericChem,
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
  const d = p.density ?? CHEM_BASE_DENSITY[p.chemId];
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
    // Mirror the non-profile hot path: creature-vs-creature collisions
    // overlap with the parallel particle-collision phase as a hook.
    // Sediment collisions are hoisted out of the hook -- they mutate
    // particle SAB columns directly so they can't run concurrent with
    // the particle workers.
    let pccAcc = 0;
    resolveCollisions(
      world,
      () => { const t = performance.now(); resolveCreatureCollisions(world); pccAcc += performance.now() - t; },
      undefined,
    );
    n = performance.now(); p.particleColl += n - m; m = n;
    p.creatureColl += pccAcc;
    resolveCreatureSedimentCollisions(world);
    n = performance.now(); p.sedimentColl += n - m; m = n;
    resolveObstacleCollisions(world);
    n = performance.now(); p.obstacleColl += n - m; m = n;
    applyWalls(world);
    n = performance.now(); p.walls += n - m; m = n;
    aerate(world, dt);
    aerateAmbient(world, dt);
    n = performance.now(); p.aerate += n - m; m = n;
    replenishParticles(world, dt);
    n = performance.now(); p.replenish += n - m; m = n;
    decayParticles(world, dt);
    // Decay is currently disabled by const, so the bucket isn't
    // separately tracked. The original code added decay's time to
    // `replenish` again (copy-paste -- same field as the line above),
    // double-counting. Skip past it instead so replenish stays
    // accurate and prune measures only pruneSpecies.
    m = performance.now();
    pruneSpecies(world);
    n = performance.now(); p.prune += n - m;
    p.ticks++;
  } else {
    evolvePheromone(world, dt);
    applyBondSprings(world, dt);
    applyForces(world, dt);
    updateCreatures(world, dt);
    // Hand creature-vs-creature collisions to the resolveCollisions
    // hook so it overlaps with the parallel particle-collision phase.
    // resolveCreatureSedimentCollisions used to be a hook too but it
    // writes particle positions/velocities directly; running it
    // concurrent with the particle workers was a data race on the
    // particle SAB columns. Run it serially after the barrier.
    resolveCollisions(
      world,
      () => resolveCreatureCollisions(world),
      undefined,
    );
    resolveCreatureSedimentCollisions(world);
    resolveObstacleCollisions(world);
    applyWalls(world);
    aerate(world, dt);
    aerateAmbient(world, dt);
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
  // Suppress founder spawning entirely until the new-world delay has
  // elapsed. After that the loop runs every step as usual; on a
  // reloaded save world.t is already past the delay so it's a no-op.
  const delayDone = world.t >= FOUNDER_SPAWN_DELAY_SEC;
  if (delayDone && world.founderTarget > 0 && (allDead || !overCap) && currentLineages.size < world.founderTarget) {
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

// Particle aging + decay. Disabled in favor of letting loose
// particles persist so founder-from-junk has something to scoop.
// Kept as code for re-enablement if particle counts ever creep too
// high; toggle PARTICLE_DECAY_ENABLED to bring it back.
const PARTICLE_DECAY_ENABLED = false;
const PARTICLE_DECAY_START_AGE = 300; // sim-seconds before decay begins
const PARTICLE_DECAY_HALF_LIFE = 60;  // sim-seconds; r halves every 60s once decaying
const PARTICLE_MIN_R = 0.4;
function decayParticles(world: World, dt: number): void {
  if (!PARTICLE_DECAY_ENABLED) return;
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
  // particleSpawnRate <= 0 disables ALL spawning (used by tests that
  // want a frozen world). founderTarget == 0 marks a test-style world
  // that doesn't want the pebble sediment bed either.
  if (world.particleSpawnRate <= 0) return;
  const wantPebbles = world.founderTarget > 0;
  // Dedicated pebble path: maintain PEBBLE_TARGET large sand grains
  // for the sediment floor, independent of the normal per-material
  // replenish below. Cached count refreshed every N ticks to avoid
  // an O(N) scan per replenish call.
  pebbleCountStaleTicks++;
  if (pebbleCountStaleTicks >= PEBBLE_COUNT_REFRESH_TICKS) {
    pebbleCountCache = countPebbles(world);
    pebbleCountStaleTicks = 0;
  }
  if (wantPebbles && pebbleCountCache < PEBBLE_TARGET) {
    const pebbleExpected = PEBBLE_SPAWN_RATE * dt;
    let pebbleSpawn = Math.floor(pebbleExpected);
    if (Math.random() < pebbleExpected - pebbleSpawn) pebbleSpawn++;
    pebbleSpawn = Math.min(pebbleSpawn, PEBBLE_TARGET - pebbleCountCache);
    for (let i = 0; i < pebbleSpawn; i++) {
      const r = SAND_BIG_R_MIN + Math.random() * (SAND_BIG_R_MAX - SAND_BIG_R_MIN);
      pushParticle(world, {
        x: Math.random() * world.width,
        y: world.surfaceY + r,
        z: r + Math.random() * (world.depth - 2 * r),
        vx: 0, vy: 0, vz: (Math.random() - 0.5) * 20,
        r,
        chemId: CHEM_MIN,
        // Pebble density nudged toward the rock-end of the mineral
        // range (was always-2.6 under the old MATERIALS["sand"]
        // entry); jitter so the bed has a little variety.
        density: 2.2 + Math.random() * 0.4,
      });
      pebbleCountCache++;
    }
  }

  // Normal per-chem replenish. Cap accommodates the pebble bed
  // on top of particleTarget so the biology mix isn't squeezed by
  // the sediment bed.
  if (world.t < WATER_FILL_DELAY_SEC) return;
  const replenishCap = world.particleTarget + (wantPebbles ? PEBBLE_TARGET : 0);
  if (world.particles.length >= replenishCap) return;
  const expected = world.particleSpawnRate * dt;
  let toSpawn = Math.floor(expected);
  if (Math.random() < expected - toSpawn) toSpawn++;
  for (let i = 0; i < toSpawn && world.particles.length < replenishCap; i++) {
    const spec = pickSpawnSpec();
    const r = spawnRadius(spec.chemId);
    pushParticle(world, {
      x: Math.random() * world.width,
      y: world.surfaceY + r,
      z: r + Math.random() * (world.depth - 2 * r),
      vx: 0, vy: 0, vz: (Math.random() - 0.5) * 20,
      r,
      chemId: spec.chemId,
      density: rollChemDensity(spec),
    });
  }
}

// Aeration: at the water surface, fresh gas particles tagged with O2
// drop in. They start with a downward velocity (so they don't escape
// instantly back through the same surface they entered through) and
// carry molecule-level O2 -- cells that ingest them get straight O2 in
// their molecule pool, just like other molecule-tagged particles.
function aerate(world: World, dt: number): void {
  if (world.t < WATER_FILL_DELAY_SEC) return;
  if (world.particles.length >= world.particleTarget) return;
  // Surface chop drives entrainment of air bubbles. Quiet surface =>
  // baseline aeration; storms and choppy periods => much more O2 mixed in.
  const act = surfaceActivity(world);
  const expected = world.aerationRate * dt * (0.5 + act);
  let n = Math.floor(expected);
  if (Math.random() < expected - n) n++;
  // Compute current atmospheric composition (mole fractions). Bubbles
  // pick up the same fractions, scaled to AERATION_MASS_PER_BUBBLE
  // total. If the atmosphere is depleted (zero total), aeration
  // stalls -- we don't conjure new mass.
  const atm = world.atmosphere;
  let totalAtm = 0;
  for (const k of MOLECULE_IDS) totalAtm += atm[k];
  if (totalAtm <= 0) return;
  for (let i = 0; i < n && world.particles.length < world.particleTarget; i++) {
    const r = 1 + Math.random() * 0.8;
    // Pull at most what's available; bubble may be smaller than the
    // nominal mass when the atmosphere is thin.
    const want = Math.min(AERATION_MASS_PER_BUBBLE, totalAtm);
    const mol = emptyMolecules();
    let actualPulled = 0;
    for (const k of MOLECULE_IDS) {
      const share = atm[k] / totalAtm;
      const take = want * share;
      mol[k] = take;
      atm[k] -= take;
      actualPulled += take;
    }
    totalAtm -= actualPulled;
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
      // Bubbles carry their atmospheric mix as a molecule payload;
      // chemId is the dominant gas (O2) for buoyancy/visual classification.
      chemId: CHEM_O2,
      molecules: mol,
    });
    if (totalAtm <= 0) break;
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

// Scalar inputs the particle force loop needs from the world. Kept
// as a flat shape so a particle subworker can deserialize it cheaply
// from the dispatch SAB instead of cloning the whole World.
export interface ParticleForceParams {
  dt: number;
  t: number;
  drag: number;
  gravity: number;
  // World floor y -- used to gate the asleep-freeze to particles
  // resting at the bottom wall only. Without this gate the freeze
  // also catches lipids/gas/organic at the wavy surface and glues
  // them to a fixed y instead of letting buoyancy bob them with
  // the waves.
  worldFloorY: number;
  surfaceY: number;
  surfaceDecay: number;
  swellDecay: number;
  updraftAmp: number;
  currentAmp: number;
  kS: number; wS: number;
  kL: number; wL: number;
  kU: number; wU: number;
  surfAmp: number;
  swellAmp: number;
  zAmp: number;
  bAmp: number;
  updraftEnv: number;
  colDepth: number;
  currentDrift: number;
}

// Pure per-range version of the particle force loop. The sim worker
// runs it over the full range when no parallel particle workers are
// available; the particle subworkers each run it over their assigned
// chunk. Operates directly on the SoA columns (which are SAB-backed
// views) so there's no copy across the worker boundary.
export function applyParticleForcesRange(
  PX: Float32Array, PY: Float32Array, PZ: Float32Array,
  PVX: Float32Array, PVY: Float32Array, PVZ: Float32Array,
  PR: Float32Array, PDENS: Float32Array, PMAT: Uint8Array,
  ASLEEP: Uint8Array,
  matBase: Float32Array,
  from: number, to: number,
  p: ParticleForceParams,
): void {
  const dt = p.dt;
  const t = p.t;
  const drag = p.drag;
  const grav = p.gravity;
  const surfaceY = p.surfaceY;
  const surfDecay = p.surfaceDecay;
  const swellDecay = p.swellDecay;
  const updraftAmp = p.updraftAmp;
  const currentAmp = p.currentAmp;
  const kS = p.kS, wS = p.wS;
  const kL = p.kL, wL = p.wL;
  const kU = p.kU, wU = p.wU;
  const surfAmp = p.surfAmp;
  const swellAmp = p.swellAmp;
  const zAmp = p.zAmp;
  const bAmp = p.bAmp;
  const updraftEnv = p.updraftEnv;
  const colDepth = p.colDepth;
  const currentDrift = p.currentDrift;
  const floorY = p.worldFloorY;
  for (let i = from; i < to; i++) {
    const xi = PX[i], yi = PY[i], ri = PR[i];
    // Freeze asleep particles ONLY when they're resting at the
    // bottom wall. Other asleep particles (e.g. lipids glued to the
    // wavy surface ceiling) still need buoyancy + drag every tick so
    // they bob with the surface; freezing them there glues them to a
    // static y and the wave passes through them.
    if (ASLEEP[i] && yi + ri >= floorY - 0.5) {
      PVX[i] = 0; PVY[i] = 0; PVZ[i] = 0;
      continue;
    }
    let vxi = PVX[i], vyi = PVY[i], vzi = PVZ[i];
    const overrideD = PDENS[i];
    const density = overrideD !== 0 ? overrideD : matBase[PMAT[i]];
    let ay = grav * (1 - 1 / density);
    if (ay < -grav) ay = -grav; else if (ay > grav) ay = grav;
    const depth = yi > surfaceY ? yi - surfaceY : 0;
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
    // Brownian noise decays with depth like the wave forces. Without
    // this, noise at the bottom (~7-8 px/s RMS for a pebble) keeps
    // sediment above the sleep threshold and churning indefinitely.
    // Decay constant sits between surfaceDecay (fast) and swellDecay
    // (slow) so mid-water still mixes but the floor calms.
    const noiseEnv = Math.exp(-depth / 200);
    const noiseX = bAmp * noiseEnv * (Math.random() - 0.5) * 2;
    const noiseY = bAmp * noiseEnv * (Math.random() - 0.5) * 2;
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
}

export function buildParticleForceParams(world: World): ParticleForceParams {
  const act = surfaceActivity(world);
  return {
    dt: 0, // filled by caller
    t: world.t,
    drag: world.drag,
    gravity: world.gravity,
    worldFloorY: world.height,
    surfaceY: world.surfaceY,
    surfaceDecay: world.surfaceDecay,
    swellDecay: world.swellDecay,
    updraftAmp: world.updraftAmp,
    currentAmp: world.currentAmp,
    kS: (2 * Math.PI) / world.surfaceLength,
    wS: (2 * Math.PI) / world.surfacePeriod,
    kL: (2 * Math.PI) / world.swellLength,
    wL: (2 * Math.PI) / world.swellPeriod,
    kU: (2 * Math.PI) / world.updraftLength,
    wU: (2 * Math.PI) / world.updraftPeriod,
    surfAmp: world.surfaceAmp * act,
    swellAmp: world.swellAmp * act,
    zAmp: world.zStirAmp * act,
    bAmp: world.brownianAmp * act,
    updraftEnv: Math.min(1, act),
    colDepth: Math.max(1, world.height - world.surfaceY),
    currentDrift: Math.sin(world.t * CURRENT_FREQ),
  };
}

// Hook a parallel particle-force dispatcher (e.g. a subworker pool)
// into the sim. When set, applyForces delegates the per-particle loop
// to it instead of running serially; the subworker pool writes back
// into the SAB-backed ParticleStore and signals completion via
// Atomics. Stays null for tests and any context without
// crossOriginIsolated SAB support; sim falls back to single-threaded.
//
// Atomics.wait round-trip on a barrier varies widely across machines
// (~0.1ms to >10ms). Below this threshold the per-particle savings
// from splitting work across the pool don't pay back the dispatch
// overhead, so we stay serial even when the pool is wired up. Picked
// well above the typical mid-game particle count -- the pool is only
// a clear win at multi-thousand-particle loads on hardware with
// non-trivial wake latency.
const PARALLEL_PARTICLE_MIN = 4000;
// Dispatcher is fire-only: it kicks the workers and returns a wait
// function. Callers run concurrent CPU work (creature loop, creature
// collisions) and invoke the wait fn when they need particle results
// settled. Hides barrier latency behind useful work.
export type ParticleForceDispatcher = (np: number, params: ParticleForceParams) => () => void;
let particleForceDispatcher: ParticleForceDispatcher | null = null;
export function setParticleForceDispatcher(d: ParticleForceDispatcher | null): void {
  particleForceDispatcher = d;
}

function applyForces(world: World, dt: number): void {
  // Particle fast path: indexed access on the parallel typed arrays
  // avoids the per-particle handle getter/setter chain. With ~4-9k
  // particles per tick this is the hottest loop in the sim.
  const ps = world.particleStore;
  const np = world.particles.length;
  const params = buildParticleForceParams(world);
  params.dt = dt;
  // Async dispatch: workers start the particle force pass on a slice
  // of the SAB-backed store while we run the creature force loop
  // below on the sim worker. Wait for the barrier just before returning
  // so any code after applyForces observes settled particle state.
  let forceWait: (() => void) | null = null;
  if (particleForceDispatcher && np >= PARALLEL_PARTICLE_MIN) {
    forceWait = particleForceDispatcher(np, params);
  } else {
    applyParticleForcesRange(
      ps.x, ps.y, ps.z, ps.vx, ps.vy, ps.vz,
      ps.r, ps.density, ps.chemId,
      COLLISION_ASLEEP,
      CHEM_BASE_DENSITY,
      0, np,
      params,
    );
  }
  // The dispatcher is actually async: it kicks the worker pool and
  // returns a wait fn. The creature loop below runs concurrent with
  // the particle workers; the wait fn is invoked at the end of this
  // function so any caller reading particles after applyForces sees
  // a settled state. Creature columns are independent of particle
  // SAB columns so the concurrent work is safe.
  const t = params.t;
  const drag = params.drag;
  const grav = params.gravity;
  const surfaceY = params.surfaceY;
  const surfDecay = params.surfaceDecay;
  const swellDecay = params.swellDecay;
  const updraftAmp = params.updraftAmp;
  const currentAmp = params.currentAmp;
  const kS = params.kS, wS = params.wS;
  const kL = params.kL, wL = params.wL;
  const kU = params.kU, wU = params.wU;
  const surfAmp = params.surfAmp;
  const swellAmp = params.swellAmp;
  const zAmp = params.zAmp;
  const bAmp = params.bAmp;
  const updraftEnv = params.updraftEnv;
  const colDepth = params.colDepth;
  const currentDrift = params.currentDrift;
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
    // Brownian noise decays with depth like the wave forces. Without
    // this, noise at the bottom (~7-8 px/s RMS for a pebble) keeps
    // sediment above the sleep threshold and churning indefinitely.
    // Decay constant sits between surfaceDecay (fast) and swellDecay
    // (slow) so mid-water still mixes but the floor calms.
    const noiseEnv = Math.exp(-depth / 200);
    const noiseX = bAmp * noiseEnv * (Math.random() - 0.5) * 2;
    const noiseY = bAmp * noiseEnv * (Math.random() - 0.5) * 2;
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
  // Settle particle force pass before returning. By the time we get
  // here, the workers have usually finished already and this is a
  // cheap no-op; otherwise the sim worker blocks until the barrier.
  if (forceWait) forceWait();
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
// Loop structure note (stage B foundation):
//   The per-creature work below splits naturally into two phases.
//
//   Phase 1 (per-cell, parallel-safe -- no cross-cell writes):
//     updateCreatureRadius, catabolize, diffuseGases,
//     runGenericReactions, biosynthCatalyst, maintenanceDecay,
//     toxify, somatic mutation, populateSensors, runTick,
//     applyGenomeSplice, recompute senseRange/thrustAccel,
//     TURN, THRUST. Reads world spatial grids built before the
//     loop; writes only c's own store row + c.vmOut.
//
//   Phase 2 (serial, cross-cell + world writes):
//     runOrganelleChemistry (writes inner cell's chem),
//     autoExcrete (spawns particles), emit (writes pheromone),
//     adhere (modifies other.bonds), advanceDivision (publishes
//     new creature), engulf / predate / ingest (mutates other
//     creatures or particles), death push.
//
//   The two-phase split + a subworker pool over Phase 1 is the
//   next increment of stage B; left intentionally inlined for now
//   to keep this refactor's diff focused on the de-globalization
//   of VM_OUT (the prerequisite for any per-cell parallel dispatch).

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
    const vmOut = c.vmOut;

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

    // Catabolism is now handled by the biopolymer-digest reaction in
    // runGenericReactions (REACTIONS[10]), gated on enzyme.

    // Passive gas exchange with the surrounding water. Diffusion is
    // physical, not enzymatic -- left at the base dt.
    diffuseAmbient(c, world, dt);

    // All in-cell chemistry runs through one unified loop: named
    // reactions live at REACTIONS[0..9] with uncatRate > 0, so they
    // fire on every cell every tick; generic reactions at [10..255]
    // only fire when the cell has built the relevant catalyst.
    // Biosynth gateMasks honour vmOut.synthMask so SYNTH_AA / FA /
    // BIO / CHL / ENZ / RIBO ops still gate what gets built.
    const ambientLight = Math.exp(-c.y / LIGHT_DECAY) * solarLight(world);
    runGenericReactions(c, dtT, ambientLight, vmOut.synthMask);

    // Generic catalyst synthesis. SYNTH_CAT <id> sets a bit per slot;
    // each catalyst built is its own protein.
    const cm = vmOut.catSynthMask;
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
    // SELF_RESERVE reads VM_SELF.reserve[matIdx]; we map the legacy
    // 6-slot operand to the cell's pool of the corresponding sensor chem.
    // Index aligns with SENSOR_CHEMS: o2, co2, glu, biopolymer, fa, min.
    let selfMass = 0;
    const chemColsC = c.store.chemCols;
    const iC = c.idx;
    for (let i = 0; i < 6; i++) {
      const v = chemColsC[SENSOR_CHEMS[i]][iC];
      VM_SELF.reserve[i] = v;
      selfMass += v;
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
    runTick(c.genome, c.vm, VM_SENSORS, VM_SELF, world.vmInstrBudget, vmOut, ec);
    if (sp) sp.vmTicks++;
    spendATP(c, vmOut.instructions * ENERGY_PER_INSTRUCTION);
    if (vmOut.repair > 0) {
      // Pay per-op so spamming REPAIR is expensive; refresh the window.
      // 30 ticks ~= 0.5 sim-sec at FIXED_DT 1/60, enough to span a
      // damage event without making the cell mutation-proof for life.
      const want = vmOut.repair * REPAIR_ATP_PER_OP;
      const paid = spendATP(c, want);
      if (paid > 0) c.repairTicks = Math.max(c.repairTicks, REPAIR_WINDOW_TICKS);
    }
    // Apply pending genome self-modifications after VM exits. SPLICE_*
    // changed length, which would invalidate PC mid-tick; we let the
    // rest of this tick's ops finish first, then resize here.
    if (vmOut.spliceMode !== 0 && vmOut.spliceLength > 0) {
      applyGenomeSplice(c, vmOut.spliceMode, vmOut.spliceOffset, vmOut.spliceLength);
    }
    // POKE_BYTE / SPLICE may have changed SENSE_AMP or THRUST_AMP
    // byte counts; recompute both derived traits.
    c.senseRange = computeSenseRange(c.genome);
    c.thrustAccel = computeThrustAccel(c.genome);

    // TURN: rotate the cell's velocity by the accumulated angle delta.
    // Cheap; only does the trig when the genome actually issued a turn.
    if (vmOut.turn !== 0) {
      const cos = Math.cos(vmOut.turn);
      const sin = Math.sin(vmOut.turn);
      const nvx = c.vx * cos - c.vy * sin;
      const nvy = c.vx * sin + c.vy * cos;
      c.vx = nvx;
      c.vy = nvy;
    }

    if (vmOut.reproduce) tryReproduce(c, world);

    // Pheromone emission: cell adds intensity to the field at its
    // position. Subsequent ticks decay + diffuse it.
    if (vmOut.emit > 0) {
      world.pheromone[pheromoneIndex(world, c.x, c.y)] += vmOut.emit;
    }

    // Adhesion: bond with the nearest creature in scanRange if not
    // already bonded. Cap each cell at MAX_BONDS to keep the spring
    // pass cheap and bounded.
    if (vmOut.adhere && c.bonds.length < MAX_BONDS) {
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

    let ax = vmOut.thrustX;
    let ay = vmOut.thrustY;
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

    // VM-controlled excretion. EXCRETE <operand> now picks a chemId via
    // SENSOR_CHEMS[operand % 6] (same legacy operand range; same chems
    // a cell can sense gradients of). The released particle carries
    // the chosen chemical directly with no proportional pool slice --
    // the cell is venting a specific chemical, not a generic
    // "material reserve" any more.
    for (let i = 0; i < 6; i++) {
      const requested = vmOut.excrete[i];
      if (requested <= 0) continue;
      const chemId = SENSOR_CHEMS[i];
      const cols = c.store.chemCols;
      const ci = c.idx;
      const available = cols[chemId][ci];
      const amount = Math.min(requested, available);
      if (amount < EXCRETE_MIN_AMOUNT) continue;
      cols[chemId][ci] -= amount;
      spawnExcretedParticle(c, world, chemId, amount);
    }

    if (c.ingestCooldown > 0) {
      c.ingestCooldown = Math.max(0, c.ingestCooldown - dt);
    }

    if (c.ingestCooldown <= 0 && c.energy >= INGEST_ENERGY_COST) {
      let ingested = false;
      // Engulf and predate both scan for nearby cells via the spatial
      // grid; range of c.r + 32 covers all plausible neighbor radii.
      const scanRange = c.r + 32;
      if (vmOut.engulf) {
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
      if (!ingested && vmOut.predate) {
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
          // Predator absorbs the prey's full chem pool. Each chem
          // transfers slot-for-slot; ATP separately.
          {
            const myCols = c.store.chemCols;
            const otherCols = other.store.chemCols;
            const ci = c.idx; const oi = other.idx;
            for (let k = 0; k < NAMED_CHEMICAL_COUNT; k++) {
              myCols[k][ci] += otherCols[k][oi];
              otherCols[k][oi] = 0;
            }
          }
          // Generic chem transfers directly too -- predator absorbs
          // the prey's full chemistry, including any abstract
          // molecules the prey had been accumulating.
          {
            const myCols = c.store.genericChemCols;
            const otherCols = other.store.genericChemCols;
            const ci = c.idx; const oi = other.idx;
            for (let k = 0; k < GENERIC_CHEMICAL_COUNT; k++) {
              myCols[k][ci] += otherCols[k][oi];
              otherCols[k][oi] = 0;
            }
          }
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
          const chemId = p.chemId;
          const sensorSlot = SENSOR_BIN_BY_CHEM[chemId];
          // The legacy 6-slot INGEST gating still applies: cells opt
          // into eating each "sensor chem" (o2/co2/glu/biop/fa/min).
          // Chemicals outside the sensor set are not ingestable via
          // the legacy op -- a future op can lift that gate.
          if (sensorSlot < 0 || !vmOut.ingestMaterials[sensorSlot]) continue;
          const dx = p.x - c.x;
          const dy = p.y - c.y;
          const dz = p.z - c.z;
          if (dx * dx + dy * dy + dz * dz < c.r * c.r) {
            if (p.molecules) {
              // Molecule-tagged particle: contents go straight into the
              // cell's molecule pool, bypassing digestion. This is corpse
              // / excretion food -- already broken down.
              for (const k of MOLECULE_IDS) c.molecules[k] += p.molecules[k];
            } else {
              // Plain chem particle: deposit its mass into the matching
              // chem slot. Biopolymer needs the digester reaction to
              // turn into glu/aa/fa; minerals stay as substrate; o2/co2
              // go straight to the respiration pool.
              c.store.chemCols[chemId][c.idx] += mass(p);
            }
            // Generic-chemical payload (cells dump their generic pool
            // into one organic particle on death). Transfer into the
            // eater's generic chem cols.
            if (p.genericChem) {
              const gcCols = c.store.genericChemCols;
              const ci = c.idx;
              for (let k = 0; k < GENERIC_CHEMICAL_COUNT; k++) {
                gcCols[k][ci] += p.genericChem[k];
              }
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
    //  3. No ribosome: without protein-synthesis machinery the cell
    //     can't turn over biomass or replenish enzymes -- biologically
    //     dead even if structurally intact.
    //  4. No amino acid: with the per-op aa cost on growth ops, an
    //     aa-empty cell is functionally paralyzed. Catch it here so
    //     it doesn't sit indefinitely just decaying biomass.
    //  5. Founder old-age: founders die after FOUNDER_LIFESPAN_SEC so
    //     they can't sit forever -- descendants have to carry the
    //     lineage forward or the top-up reseeds with fresh genomes.
    const m = c.molecules;
    const founderTooOld = world.founderIds.has(c.id)
      && world.t - c.bornAt >= FOUNDER_LIFESPAN_SEC;
    if (
      (c.energy <= 0 && noFuel(c))
      || m.biomass < MIN_VIABLE_BIOMASS
      || m.ribosome < MIN_VIABLE_RIBOSOME
      || m.aminoAcid < MIN_VIABLE_AMINOACID
      || founderTooOld
    ) {
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
        // Drop the founder ID tracking for any cell that's leaving
        // world.creatures (spilled or absorbed), so the set doesn't
        // accumulate stale ids across the run.
        world.founderIds.delete(c.id);
        if (spillSet.has(c)) {
          releaseChemsAsParticles(c, world);
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

// On death, return the cell's chem pool to the world as free-floating
// particles. One particle per named chem with significant mass, each
// carrying its identity (no more bucketing into "organic" / "lipid"
// material categories). Catalysts denature back into amino acid +
// minerals first. Generic chemicals aggregate into a single multi-chem
// corpse particle whose chemId tag is biopolymer (visual / buoyancy
// classifier; the per-chem payload is what gets re-absorbed on ingest).
function releaseChemsAsParticles(c: Creature, world: World): void {
  const ci = c.idx;
  const cols = c.store.chemCols;

  // Catalysts denature on death back to their substrates (0.5 aa +
  // 0.5 min). Folded into the chem pool so the loop below releases
  // them naturally as those chems.
  {
    const ccats = c.store.catalystCols;
    for (let k = 0; k < CATALYST_COUNT; k++) {
      const v = ccats[k][ci];
      if (v > 0) {
        cols[CHEM_AA][ci] += 0.5 * v;
        cols[CHEM_MIN][ci] += 0.5 * v;
        ccats[k][ci] = 0;
      }
    }
  }
  // ATP loses its phosphate on death, returning to the ADP pool.
  if (c.energy > 0) {
    cols[CHEM_ADP][ci] += c.energy;
    c.energy = 0;
  }

  // Named chems: one particle per chem id above MIN_RELEASE. Each
  // particle carries chemId so the eater absorbs the same chemical
  // back into its pool slot. Below-threshold remnants are dropped
  // silently (they round-off to environment). Threshold tuned so a
  // typical cell death produces ~3-5 particles, not one per chem
  // slot -- keeps long-run particle counts stable.
  const MIN_RELEASE = 2;
  for (let k = 0; k < NAMED_CHEMICAL_COUNT; k++) {
    const total = cols[k][ci];
    if (total < MIN_RELEASE) { cols[k][ci] = 0; continue; }
    cols[k][ci] = 0;
    const density = CHEM_BASE_DENSITY[k];
    let remaining = total;
    while (remaining > MIN_RELEASE) {
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
        chemId: k,
      });
      remaining -= mp;
    }
  }

  // Generic chemicals: aggregate into one corpse particle so each
  // chem's identity survives without spamming hundreds of tiny
  // particles. ChemId tag is biopolymer (low-density bulk visual);
  // the multi-chem payload is what really matters on re-ingest.
  {
    const gcols = c.store.genericChemCols;
    const payload = new Float32Array(GENERIC_CHEMICAL_COUNT);
    let totalMass = 0;
    let any = false;
    for (let k = 0; k < GENERIC_CHEMICAL_COUNT; k++) {
      const v = gcols[k][ci];
      if (v > 0) {
        payload[k] = v;
        totalMass += v * CHEMICALS[NAMED_CHEMICAL_COUNT + k].molarMass;
        gcols[k][ci] = 0;
        any = true;
      }
    }
    if (any && totalMass >= MIN_RELEASE) {
      const density = CHEM_BASE_DENSITY[CHEM_BIOPOLYMER];
      const r = Math.max(DEATH_RELEASE_R_MIN, radiusForMass(totalMass, density));
      pushParticle(world, {
        x: c.x + (Math.random() - 0.5) * 6,
        y: c.y + (Math.random() - 0.5) * 6,
        z: Math.min(world.depth - r, Math.max(r, c.z + (Math.random() - 0.5) * 4)),
        vx: (Math.random() - 0.5) * 2 * DEATH_RELEASE_SCATTER,
        vy: (Math.random() - 0.5) * 2 * DEATH_RELEASE_SCATTER,
        vz: (Math.random() - 0.5) * DEATH_RELEASE_SCATTER,
        r,
        chemId: CHEM_BIOPOLYMER,
        genericChem: payload,
      });
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
  const parentShare = parent.vmOut.reproduceFraction;
  const childShare = 1 - parentShare;
  // Build-block sufficiency check is also gone -- the parent commits
  // whatever proportional share its current pool gives the child,
  // and if either daughter ends up below MIN_VIABLE_BIOMASS the
  // standard autolyze handles cleanup with mass returned to the
  // environment. Bad timing has real consequences now.
  const childMolecules = emptyMolecules();
  for (const mk of MOLECULE_IDS) {
    const give = parent.molecules[mk] * childShare;
    parent.molecules[mk] -= give;
    childMolecules[mk] = give;
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
  const energyGift = parent.energy * childShare;
  parent.energy -= energyGift;
  // No additive yolk. The child receives exactly its proportional
  // share of the parent's molecules / reserves / energy. If the
  // parent didn't stockpile enough ribosomes / chlorophyll / glucose
  // before fission, the child inherits that deficit. This puts the
  // genome in charge of bootstrap -- cells that evolve "save before
  // dividing" behavior produce viable children; profligate ones
  // produce stillborns.

  updateCreatureRadius(parent);

  const angle = Math.random() * Math.PI * 2;
  let childMassEstimate = energyGift;
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
  });
  daughter.organelleSynthMask = genomeSynthMask(daughterGenome);
  // Endosymbiont daughters share the inner's lineageRoot. They live
  // in host vacuoles and aren't counted toward FOUNDER_TARGET, but
  // tagging them keeps the bookkeeping consistent if one is ever
  // released back to the world.
  daughter.lineageRoot = inner.lineageRoot;
  // Split molecules + ATP half / half. (Generic chem half-split is
  // skipped here for the endosymbiont path -- the daughter inherits an
  // empty generic pool, matching the previous behavior. Catalyst pools
  // are also not split: the parent retains them.)
  for (const k of MOLECULE_IDS) {
    const half = inner.molecules[k] * 0.5;
    inner.molecules[k] -= half;
    daughter.molecules[k] = half;
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
  for (const k of MOLECULE_IDS) m += c.molecules[k];
  // Engulfed prey lives in our vacuole; its mass still occupies our volume.
  for (const inner of c.contents) m += creatureSelfMass(inner);
  return m;
}

// Mass of a single cell excluding its contents -- used to avoid recursion
// when summing up an engulfed prey's contribution to its container's mass.
function creatureSelfMass(c: Creature): number {
  let m = c.energy;
  for (const k of MOLECULE_IDS) m += c.molecules[k];
  return m;
}

// Has the cell exhausted every fuel it could turn into ATP?
function noFuel(c: Creature): boolean {
  const m = c.molecules;
  // Direct molecular fuels: glucose / fattyAcid can be catabolized
  // straight into ATP, no enzyme needed.
  const hasDirect = m.glucose >= 0.5 || m.fattyAcid >= 0.5;
  if (hasDirect) return false;
  // Biopolymer is fuel-on-paper: convertible to glu/aa/fa via the
  // digestion reaction iff the cell has enzyme. Without enzyme it's
  // functionally starvation.
  if (m.biopolymer >= 0.5 && m.enzyme >= MIN_USABLE_ENZYME) return false;
  // Photosynth recovery path: chlorophyll + CO2 + light bypasses the
  // enzyme requirement (chl is itself an enzyme-like catalyst).
  if (m.chlorophyll > 0.5 && m.co2 > 0.5) return false;
  return true;
}

// Minimum enzyme to unlock biopolymer digestion. Heterotroph founders
// start with enzyme=0.5 and enzyme decays at ~0.1%/sec, so it takes
// hundreds of sim-sec to fall below this without active SYNTH_ENZ.
const MIN_USABLE_ENZYME = 0.01;

export function updateCreatureRadius(c: Creature): void {
  // Treat stored mass as a sphere's volume (water-density convention), then
  // render its equatorial cross-section. So mass = (4/3) pi R^3, giving
  // R = cbrt(3 m / (4 pi)). The on-screen disk's area is pi R^2.
  // This means doubling mass only grows radius by 2^(1/3) ~= 1.26, so the
  // surface-area-vs-volume penalty kicks in much harder than under the old
  // disk-area formula.
  const m = creatureTotalMass(c);
  c.r = Math.max(MIN_CREATURE_R, Math.cbrt((3 * m) / (4 * Math.PI)));
  // Effective density follows what the cell is carrying. Each chem
  // contributes at its bulk density (minerals at 2.4 sinks, gas at
  // 0.14 floats); molecules + ATP at water density (1.0). Real cells
  // are osmotically regulated; we damp the raw mass ratio toward 1.0
  // so loading dense chems doesn't immediately glue the cell to the
  // seafloor. Clamped to [DENSITY_FLOOR, DENSITY_CEIL].
  if (m > 0) {
    const s = c.store; const i = c.idx;
    const cols = s.chemCols;
    let weighted = 0;
    for (let k = 0; k < NAMED_CHEMICAL_COUNT; k++) {
      weighted += cols[k][i] * CHEM_BASE_DENSITY[k];
    }
    const raw = weighted / m;
    const damped = 1 + (raw - 1) * DENSITY_DAMPING;
    c.density = damped < DENSITY_FLOOR ? DENSITY_FLOOR
              : damped > DENSITY_CEIL ? DENSITY_CEIL
              : damped;
  }
}

const GRID_CELL_SIZE = 12;

// Worst-case grid dimensions. For an 800x600 world with cell=12, the
// grid is 67x50 = 3350 cells. 16384 leaves room for larger worlds; the
// buffer is allocated once at world creation and never resized.
const COLLISION_MAX_CELLS = 16384;
// Matches PARTICLE_STORE_PREALLOC_CAP so cellItems can index every
// possible particle slot.
const COLLISION_MAX_PARTICLES = PARTICLE_STORE_PREALLOC_CAP;

// SAB-backed collision-pass scratch. Holds the per-particle mass +
// sleep flags AND the spatial-hash grid in a layout subworkers can
// read directly. Replaces the old number[][] bucket-of-arrays layout
// (which can't cross a worker boundary).
//
//   mass        Float32[cap]            kg-like per particle
//   asleep      Uint8[cap]              1 if both ends of a pair can skip work
//   cellStart   Int32[maxCells + 1]     prefix sum: items in cell i live at
//                                       cellItems[cellStart[i]..cellStart[i+1])
//   cellItems   Int32[cap]              particle indices, sorted by cell
//
// Built serially each pass on the sim worker; read by the row-parity
// collision subworkers during the parallel resolve phase.
export interface CollisionSharedLayout {
  buffer: ArrayBufferLike;
  maxParticles: number;
  maxCells: number;
  offsets: {
    mass: number;
    asleep: number;
    cellStart: number;
    cellItems: number;
  };
}

function allocCollisionBuffer(): CollisionSharedLayout {
  const align = (n: number): number => (n + 7) & ~7;
  let o = 0;
  const offsets = {} as CollisionSharedLayout["offsets"];
  offsets.mass = o; o = align(o + COLLISION_MAX_PARTICLES * 4);
  offsets.asleep = o; o = align(o + COLLISION_MAX_PARTICLES);
  offsets.cellStart = o; o = align(o + (COLLISION_MAX_CELLS + 1) * 4);
  offsets.cellItems = o; o = align(o + COLLISION_MAX_PARTICLES * 4);
  const total = o;
  let buffer: ArrayBufferLike;
  if (typeof SharedArrayBuffer !== "undefined" &&
      typeof globalThis !== "undefined" &&
      (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated) {
    buffer = new SharedArrayBuffer(total);
  } else {
    buffer = new ArrayBuffer(total);
  }
  return { buffer, maxParticles: COLLISION_MAX_PARTICLES, maxCells: COLLISION_MAX_CELLS, offsets };
}

const COLLISION_LAYOUT = allocCollisionBuffer();
const COLLISION_MASS = new Float32Array(COLLISION_LAYOUT.buffer, COLLISION_LAYOUT.offsets.mass, COLLISION_MAX_PARTICLES);
const COLLISION_ASLEEP = new Uint8Array(COLLISION_LAYOUT.buffer, COLLISION_LAYOUT.offsets.asleep, COLLISION_MAX_PARTICLES);
const COLLISION_CELL_START = new Int32Array(COLLISION_LAYOUT.buffer, COLLISION_LAYOUT.offsets.cellStart, COLLISION_MAX_CELLS + 1);
const COLLISION_CELL_ITEMS = new Int32Array(COLLISION_LAYOUT.buffer, COLLISION_LAYOUT.offsets.cellItems, COLLISION_MAX_PARTICLES);
// Per-cell counter scratch used during cellItems build. Not shared
// across workers; only the sim worker touches it.
let COLLISION_CELL_COUNTER = new Int32Array(0);
export function getCollisionSharedLayout(): CollisionSharedLayout {
  return COLLISION_LAYOUT;
}

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
  const PX = store.x, PY = store.y, PCHEM = store.chemId;
  const np = world.particles.length;
  for (let i = 0; i < np; i++) {
    const xi = PX[i], yi = PY[i];
    // Map chemId to sensor bin slot via SENSOR_BIN_BY_CHEM. Chems
    // outside the 6 sensor slots are invisible to gradient/density
    // ops (cells use SENSE_CHEMICAL to read internal chem pools for
    // anything else). Skipping invisible chems also keeps the bin
    // table hot/small even after CHEMICAL_COUNT grows.
    const slot = SENSOR_BIN_BY_CHEM[PCHEM[i]];
    if (slot < 0) continue;
    let bx = Math.floor(xi / SENSOR_BIN);
    let by = Math.floor(yi / SENSOR_BIN);
    if (bx < 0) bx = 0; else if (bx >= SENSOR_BIN_COLS) bx = SENSOR_BIN_COLS - 1;
    if (by < 0) by = 0; else if (by >= SENSOR_BIN_ROWS) by = SENSOR_BIN_ROWS - 1;
    const bin = by * SENSOR_BIN_COLS + bx;
    SENSOR_BIN_COUNT[slot][bin]++;
    SENSOR_BIN_SUMX[slot][bin] += xi;
    SENSOR_BIN_SUMY[slot][bin] += yi;
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

// Dispatcher hook for the parallel collision pass. When set, the sim
// worker delegates each row-parity phase (even rows, then odd rows)
// to a subworker pool that holds views over the same SAB-backed
// particle store + collision grid. Stays null in tests / non-isolated
// contexts; the serial path below runs in that case.
// Fire-only: kicks workers for the given parity, returns a wait fn.
// Callers can run unrelated work (creature collisions, sediment, etc)
// between firing and waiting to hide the barrier latency.
export type CollisionPhaseDispatcher = (cols: number, rows: number, rowParity: 0 | 1, e: number) => () => void;
let collisionPhaseDispatcher: CollisionPhaseDispatcher | null = null;
export function setCollisionPhaseDispatcher(d: CollisionPhaseDispatcher | null): void {
  collisionPhaseDispatcher = d;
}

// Process every cell in rows {rowStart, rowStart+rowStep, ...} on the
// collision grid: resolve pairs within each cell plus pairs against
// the four canonical downstream neighbors (E, SW, S, SE). Reads cell
// membership from cellStart / cellItems built by the sim worker on
// the same buffer. Each row writes to particles in its own row + the
// row below it, so disjoint rows produce disjoint writes (see
// resolveCollisions for the two-phase row-parity coloring).
//
// Worker assignment for phase p with N workers:
//   worker i processes rowStart = p + 2*i, rowStep = 2*N.
// That way every row in the phase is owned by exactly one worker.
export function applyCollisionsRowRange(
  PX: Float32Array, PY: Float32Array, PZ: Float32Array,
  PVX: Float32Array, PVY: Float32Array, PVZ: Float32Array,
  PR: Float32Array,
  MASS: Float32Array, ASLEEP: Uint8Array,
  cellStart: Int32Array, cellItems: Int32Array,
  rowStart: number, rowStep: number,
  cols: number, rows: number,
  e: number,
): void {
  for (let cy = rowStart; cy < rows; cy += rowStep) {
    for (let cx = 0; cx < cols; cx++) {
      const ci = cy * cols + cx;
      const s0 = cellStart[ci];
      const s1 = cellStart[ci + 1];
      if (s1 === s0) continue;
      // Within-cell pairs.
      for (let i = s0; i < s1; i++) {
        const ai = cellItems[i];
        for (let j = i + 1; j < s1; j++) {
          resolvePairSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, MASS, ASLEEP, ai, cellItems[j], e);
        }
      }
      // Downstream neighbors: E, SW, S, SE. Pairs with each are
      // resolved exactly once because every cell only iterates its
      // four downstream-of-(cx,cy) neighbors.
      checkNeighborCellSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, MASS, ASLEEP, cellStart, cellItems,
        ci, cx + 1, cy,     cols, rows, e);
      checkNeighborCellSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, MASS, ASLEEP, cellStart, cellItems,
        ci, cx - 1, cy + 1, cols, rows, e);
      checkNeighborCellSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, MASS, ASLEEP, cellStart, cellItems,
        ci, cx,     cy + 1, cols, rows, e);
      checkNeighborCellSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, MASS, ASLEEP, cellStart, cellItems,
        ci, cx + 1, cy + 1, cols, rows, e);
    }
  }
}

// duringPhase0 and duringPhase1 run concurrently with the worker pool
// during each respective collision-phase barrier (parallel path only).
// In the serial fallback they run after the particle collision pass to
// preserve the original step ordering. Both callbacks must be safe to
// execute alongside particle position/velocity mutations -- only
// creature-vs-creature collisions qualify (touches creature stores
// only). resolveCreatureSedimentCollisions used to be passed here as
// duringPhase1 but it mutates particle SAB columns and so cannot
// safely overlap; it now runs serially in step() after this returns.
function resolveCollisions(
  world: World,
  duringPhase0?: () => void,
  duringPhase1?: () => void,
): void {
  let pendingP0 = duringPhase0;
  let pendingP1 = duringPhase1;
  const store = world.particleStore;
  const n = world.particles.length;
  if (n < 2) {
    if (pendingP0) pendingP0();
    if (pendingP1) pendingP1();
    return;
  }
  const e = world.restitution;
  const cellSize = GRID_CELL_SIZE;
  const cols = Math.max(1, Math.ceil(world.width / cellSize));
  const rows = Math.max(1, Math.ceil(world.height / cellSize));
  const cellCount = cols * rows;
  if (cellCount + 1 > COLLISION_MAX_CELLS + 1) {
    // Shouldn't happen with current world sizes + GRID_CELL_SIZE;
    // signal loudly so we don't silently corrupt collision state.
    throw new Error(`collision grid ${cellCount} cells exceeds COLLISION_MAX_CELLS=${COLLISION_MAX_CELLS}`);
  }
  if (COLLISION_CELL_COUNTER.length < cellCount) {
    COLLISION_CELL_COUNTER = new Int32Array(cellCount * 2);
  }

  const PX = store.x, PY = store.y, PZ = store.z;
  const PVX = store.vx, PVY = store.vy, PVZ = store.vz;
  const PR = store.r, PDENS = store.density, PCHEM = store.chemId;
  const PQUIET = store.quietTicks;
  const chemBase = CHEM_BASE_DENSITY;
  const FOUR_THIRDS_PI = (4 / 3) * Math.PI;
  for (let i = 0; i < n; i++) {
    const r = PR[i];
    const d = PDENS[i] !== 0 ? PDENS[i] : chemBase[PCHEM[i]];
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
    // Build cellStart + cellItems. Two-pass: (1) count per cell into
    // cellStart, (2) prefix sum, (3) place each particle using a per-
    // cell counter. cellStart[i+1] - cellStart[i] = count in cell i.
    for (let i = 0; i <= cellCount; i++) COLLISION_CELL_START[i] = 0;
    const cellOfPart = COLLISION_CELL_COUNTER; // reuse as scratch to remember cell-of-particle
    for (let pi = 0; pi < n; pi++) {
      let cx = Math.floor(PX[pi] / cellSize);
      let cy = Math.floor(PY[pi] / cellSize);
      if (cx < 0) cx = 0; else if (cx >= cols) cx = cols - 1;
      if (cy < 0) cy = 0; else if (cy >= rows) cy = rows - 1;
      const ci = cy * cols + cx;
      cellOfPart[pi] = ci;
      COLLISION_CELL_START[ci + 1]++;
    }
    for (let i = 1; i <= cellCount; i++) COLLISION_CELL_START[i] += COLLISION_CELL_START[i - 1];
    // Place particles. cellOfPart is reused here but we no longer
    // need its previous values once we've consumed pi; safe to
    // overwrite as a placement cursor seeded from cellStart.
    const cursor = new Int32Array(cellCount); // small alloc; cellCount typically <4k
    for (let pi = 0; pi < n; pi++) {
      const ci = cellOfPart[pi];
      const slot = COLLISION_CELL_START[ci] + cursor[ci]++;
      COLLISION_CELL_ITEMS[slot] = pi;
    }

    // Cache the dispatcher locally so a barrier-timeout teardown that
    // fires from inside wait0() (e.g. mobile suspends the tab, particle
    // workers stop responding) doesn't null the module-level reference
    // mid-step and crash the second dispatcher call with
    // "Se is not a function". The cached function checks `if (!pool)`
    // at entry and returns a no-op wait fn when the pool is torn down,
    // so we still get through the rest of this iteration cleanly.
    const dispatch = collisionPhaseDispatcher;
    if (dispatch && n >= PARALLEL_PARTICLE_MIN) {
      const wait0 = dispatch(cols, rows, 0, e);
      // Run hooks on the first iter only; subsequent iters have no
      // useful work to hide and we want hook side-effects to happen
      // exactly once per step.
      if (pendingP0) { pendingP0(); pendingP0 = undefined; }
      wait0();
      const wait1 = dispatch(cols, rows, 1, e);
      if (pendingP1) { pendingP1(); pendingP1 = undefined; }
      wait1();
    } else {
      // Serial fallback: iterate every row.
      for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
          const ci = cy * cols + cx;
          const s0 = COLLISION_CELL_START[ci];
          const s1 = COLLISION_CELL_START[ci + 1];
          if (s1 === s0) continue;
          for (let i = s0; i < s1; i++) {
            const ai = COLLISION_CELL_ITEMS[i];
            for (let j = i + 1; j < s1; j++) {
              resolvePairSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, COLLISION_MASS, COLLISION_ASLEEP, ai, COLLISION_CELL_ITEMS[j], e);
            }
          }
          checkNeighborCellSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, COLLISION_MASS, COLLISION_ASLEEP,
            COLLISION_CELL_START, COLLISION_CELL_ITEMS,
            ci, cx + 1, cy,     cols, rows, e);
          checkNeighborCellSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, COLLISION_MASS, COLLISION_ASLEEP,
            COLLISION_CELL_START, COLLISION_CELL_ITEMS,
            ci, cx - 1, cy + 1, cols, rows, e);
          checkNeighborCellSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, COLLISION_MASS, COLLISION_ASLEEP,
            COLLISION_CELL_START, COLLISION_CELL_ITEMS,
            ci, cx,     cy + 1, cols, rows, e);
          checkNeighborCellSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, COLLISION_MASS, COLLISION_ASLEEP,
            COLLISION_CELL_START, COLLISION_CELL_ITEMS,
            ci, cx + 1, cy + 1, cols, rows, e);
        }
      }
    }
  }
  // Serial path falls through with pending hooks. Run them now (after
  // particle collisions are settled, matching the original step order).
  if (pendingP0) pendingP0();
  if (pendingP1) pendingP1();

  // Dedicated pebble-pair sweep. The 12px collision broad-phase + one-
  // neighbor sweep guarantees pair detection only when r_a+r_b<=24;
  // two pebbles with r=11 sum to 22 (detectable) but their centers can
  // be in cells 2 apart, missing the sweep. Missed pairs accumulate
  // overlap silently until they happen to land in adjacent cells,
  // then the giant correction kicks them into the air -- the
  // "popcorn" symptom. An O(P²) pass with P~PEBBLE_TARGET (~138) is
  // ~9.5k early-rejected checks per tick, cheap, and catches every
  // pair regardless of grid alignment.
  resolvePebblePairs(world, e);
}

// Build pebble index list lazily; sized to particle store cap so we
// never reallocate at runtime.
let PEBBLE_IDX_BUFFER = new Int32Array(0);

function resolvePebblePairs(world: World, e: number): void {
  const store = world.particleStore;
  const PCHEM = store.chemId;
  const PR = store.r;
  const n = world.particles.length;
  if (PEBBLE_IDX_BUFFER.length < n) PEBBLE_IDX_BUFFER = new Int32Array(n);
  let pn = 0;
  for (let i = 0; i < n; i++) {
    if (PCHEM[i] === CHEM_MIN && PR[i] >= SAND_BIG_R_MIN) PEBBLE_IDX_BUFFER[pn++] = i;
  }
  if (pn < 2) return;
  const PX = store.x, PY = store.y, PZ = store.z;
  const PVX = store.vx, PVY = store.vy, PVZ = store.vz;
  for (let i = 0; i < pn; i++) {
    const ai = PEBBLE_IDX_BUFFER[i];
    for (let j = i + 1; j < pn; j++) {
      resolvePairSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, COLLISION_MASS, COLLISION_ASLEEP, ai, PEBBLE_IDX_BUFFER[j], e);
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

// Mineral particles act as solid terrain: cells can't phase through
// the seafloor. INGEST runs earlier in the tick, so a cell whose
// genome fires INGEST on a mineral at contact still consumes the
// particle before this bounce runs. (Phase D collapse: rock/sand/clay
// are all CHEM_MIN now; the clay-permeable carve-out is gone.)
function resolveCreatureSedimentCollisions(world: World): void {
  const ps = world.particles;
  const cs = world.creatures;
  if (cs.length === 0) return;
  for (let pi = 0; pi < ps.length; pi++) {
    const p = ps[pi];
    if (p.chemId !== CHEM_MIN) continue;
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

function checkNeighborCellSoa(
  PX: Float32Array, PY: Float32Array, PZ: Float32Array,
  PVX: Float32Array, PVY: Float32Array, PVZ: Float32Array,
  PR: Float32Array,
  MASS: Float32Array, ASLEEP: Uint8Array,
  cellStart: Int32Array, cellItems: Int32Array,
  ci: number, nx: number, ny: number,
  cols: number, rows: number,
  e: number,
): void {
  if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) return;
  const ni = ny * cols + nx;
  const ns0 = cellStart[ni], ns1 = cellStart[ni + 1];
  if (ns1 === ns0) return;
  const s0 = cellStart[ci], s1 = cellStart[ci + 1];
  for (let i = s0; i < s1; i++) {
    const ai = cellItems[i];
    for (let j = ns0; j < ns1; j++) {
      resolvePairSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, MASS, ASLEEP, ai, cellItems[j], e);
    }
  }
}

function resolvePairSoa(
  PX: Float32Array, PY: Float32Array, PZ: Float32Array,
  PVX: Float32Array, PVY: Float32Array, PVZ: Float32Array,
  PR: Float32Array,
  MASS: Float32Array, ASLEEP: Uint8Array,
  i: number, j: number, e: number,
): void {
  if (ASLEEP[i] && ASLEEP[j]) return;
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
  const ma = MASS[i];
  const mb = MASS[j];
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
  // Gas particles that drift up past the (wavy) water surface escape
  // to the atmosphere. Dump their molecules into world.atmosphere on
  // the way out so the loop is mass-conserving and aeration can later
  // re-introduce them as bubble contents.
  for (let i = world.particles.length - 1; i >= 0; i--) {
    const p = world.particles[i];
    // Gas particles (O2 or CO2 chem) that drift up past the (wavy)
    // water surface escape to the atmosphere.
    const cId = p.chemId;
    if ((cId === CHEM_O2 || cId === CHEM_CO2) && p.y - p.r < surfaceYAt(world, p.x)) {
      const pm = p.molecules;
      if (pm) {
        for (const k of MOLECULE_IDS) {
          const v = pm[k];
          if (v > 0) world.atmosphere[k] += v;
        }
      }
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

export const SAVE_SCHEMA = `evosim4:6:${CATALYST_COUNT}:${CHEMICAL_COUNT}:${NAMED_CHEMICAL_COUNT}:${MAX_GENOME_BYTES}`;

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
  // Sparse: only nonzero entries -- catalystCols is 256 wide, most slots empty.
  catalysts: SavedSparse[];
  // Sparse: 56 wide for generic chemicals.
  generics: SavedSparse[];
  // Engulfed inner cells (endosymbionts). Recursive: an inner cell can
  // itself carry contents in real biology, so we snapshot the same
  // structure -- though the sim currently only nests one level deep.
  contents?: SavedCreature[];
  // ADHERE bond partners as indices into the saved.creatures array.
  // Bonds only exist among top-level world.creatures (engulfed cells
  // don't run VM and can't fire ADHERE), so this is a flat index
  // list. Restored in a second pass once every Creature instance
  // exists. Empty when no bonds (most cells).
  bonds?: number[];
}
interface SavedParticle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  r: number; chemId: number;
  density?: number;
  // Optional: persist sleep state so settled sediment doesn't all
  // wake up and bounce on reload (would take SLEEP_THRESHOLD_TICKS
  // sim-ticks to re-settle, looks like a glitch). Older saves
  // without this field default to 0 = wake immediately, which is
  // the previous behavior.
  quietTicks?: number;
  molecules?: Record<string, number>;
  // Sparse: pairs of (slotInGenericRange, value) for nonzero entries.
  // Only present for corpse particles that inherited a cell's
  // accumulated generic-chemical pool.
  generics?: SavedSparse[];
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
  atmosphere?: Partial<Molecules>;
  // Phase F ambient pool. Sparse list of (chemId, concentration);
  // missing entries default to zero on restore.
  ambient?: Array<{ i: number; v: number }>;
  species: SavedSpecies[];
  particles: SavedParticle[];
  creatures: SavedCreature[];
  // Pheromone field as a flat array of cell values. Re-applied if the
  // saved cols/rows match the freshly-resized world; otherwise
  // dropped silently (different world dimensions = different grid).
  // Older saves without this field reload with an empty pheromone
  // field (creatures' established trails vanish until they re-emit).
  pheromone?: { cols: number; rows: number; values: number[] };
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
    molecules: mol,
    catalysts: snapshotSparseCol(s.catalystCols, i, CATALYST_COUNT),
    generics: snapshotSparseCol(s.genericChemCols, i, GENERIC_CHEMICAL_COUNT),
    contents: c.contents.length > 0 ? c.contents.map(snapshotCreature) : undefined,
  };
}

function snapshotParticle(p: Particle): SavedParticle {
  const out: SavedParticle = {
    x: p.x, y: p.y, z: p.z,
    vx: p.vx, vy: p.vy, vz: p.vz,
    r: p.r, chemId: p.chemId,
  };
  if (p.density !== undefined) out.density = p.density;
  const q = p.quietTicks ?? 0;
  if (q > 0) out.quietTicks = q;
  if (p.molecules) {
    const m: Record<string, number> = {};
    let any = false;
    for (const k of MOLECULE_IDS) {
      const v = p.molecules[k];
      if (v !== 0) { m[k] = v; any = true; }
    }
    if (any) out.molecules = m;
  }
  if (p.genericChem) {
    const sparse: SavedSparse[] = [];
    for (let k = 0; k < p.genericChem.length; k++) {
      const v = p.genericChem[k];
      if (v > 0) sparse.push({ i: k, v });
    }
    if (sparse.length > 0) out.generics = sparse;
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
    atmosphere: { ...w.atmosphere },
    ambient: (() => {
      const out: Array<{ i: number; v: number }> = [];
      for (let k = 0; k < w.ambient.length; k++) {
        if (w.ambient[k] > 0) out.push({ i: k, v: w.ambient[k] });
      }
      return out;
    })(),
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
    pheromone: w.pheromone.length > 0
      ? { cols: w.pheromoneCols, rows: w.pheromoneRows, values: Array.from(w.pheromone) }
      : undefined,
  };
  // Second pass for bonds: now that every creature has an index in
  // saved.creatures, translate each cell's bond partners into those
  // indices. Cells engulfed in contents[] are skipped (they don't
  // form bonds), and partners that aren't in the top-level
  // creatures array (shouldn't happen but defensive) are dropped.
  const idxByCreature = new Map<Creature, number>();
  for (let i = 0; i < w.creatures.length; i++) idxByCreature.set(w.creatures[i], i);
  for (let i = 0; i < w.creatures.length; i++) {
    const c = w.creatures[i];
    if (c.bonds.length === 0) continue;
    const idxs: number[] = [];
    for (const partner of c.bonds) {
      const pi = idxByCreature.get(partner);
      if (pi !== undefined) idxs.push(pi);
    }
    if (idxs.length > 0) saved.creatures[i].bonds = idxs;
  }
  return JSON.stringify(saved);
}

function restoreCreature(world: World, sc: SavedCreature): Creature {
  const mol = emptyMolecules();
  for (const k of MOLECULE_IDS) {
    const v = sc.molecules[k];
    if (v !== undefined) mol[k] = v;
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
  // Restore pheromone trails if the saved grid dimensions match the
  // current world's. Different dimensions (e.g., world resized
  // between save and load) drop silently to a clean field.
  world.pheromone.fill(0);
  if (saved.pheromone
    && saved.pheromone.cols === world.pheromoneCols
    && saved.pheromone.rows === world.pheromoneRows
    && saved.pheromone.values.length === world.pheromone.length) {
    for (let i = 0; i < saved.pheromone.values.length; i++) {
      world.pheromone[i] = saved.pheromone.values[i];
    }
  }
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
  // Rocks have been removed; drop any obstacles a pre-removal save
  // carried so loading an old save doesn't bring them back.
  world.obstacles = [];
  // Rebuild the module-global obstacle indexes from the (now empty)
  // obstacle list. Without this they'd retain whatever the previous
  // world left there: stale OBSTACLE_BANDS pointers, an
  // OBSTACLES_MIN_Y of Infinity from the wrong layout, etc. The
  // early-out in resolveObstacleCollisions hides it today, but the
  // moment rocks come back this becomes a silent corruption path.
  rebuildObstacleIndex(world);
  if (saved.atmosphere) {
    const atm = world.atmosphere;
    for (const k of MOLECULE_IDS) atm[k] = saved.atmosphere[k] ?? 0;
  }
  if (saved.ambient) {
    const a = world.ambient;
    a.fill(0);
    for (const { i, v } of saved.ambient) {
      if (i >= 0 && i < a.length) a[i] = v;
    }
  }
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
    let genericChem: Float32Array | undefined;
    if (sp.generics && sp.generics.length > 0) {
      genericChem = new Float32Array(GENERIC_CHEMICAL_COUNT);
      for (const e of sp.generics) genericChem[e.i] = e.v;
    }
    pushParticle(world, {
      x: sp.x, y: sp.y, z: sp.z,
      vx: sp.vx, vy: sp.vy, vz: sp.vz,
      r: sp.r, chemId: sp.chemId,
      density: sp.density,
      quietTicks: sp.quietTicks,
      molecules: sp.molecules ? { ...emptyMolecules(), ...sp.molecules } : undefined,
      genericChem,
    });
  }
  for (const sc of saved.creatures) {
    const c = restoreCreature(world, sc);
    world.creatures.push(c);
  }
  // Second pass: wire bonds. Each saved.creatures[i].bonds holds the
  // partner indices into the same array, which now corresponds 1:1
  // with world.creatures (we pushed in the same order). Each bond is
  // symmetric, but we record it from both sides so we don't have to
  // worry about ordering -- duplicates checked with includes().
  for (let i = 0; i < saved.creatures.length; i++) {
    const sc = saved.creatures[i];
    if (!sc.bonds || sc.bonds.length === 0) continue;
    const c = world.creatures[i];
    for (const pi of sc.bonds) {
      if (pi < 0 || pi >= world.creatures.length) continue;
      const partner = world.creatures[pi];
      if (partner === c) continue;
      if (!c.bonds.includes(partner)) c.bonds.push(partner);
      if (!partner.bonds.includes(c)) partner.bonds.push(c);
    }
  }
  return true;
}

// ---------------------------------------------------------------------
// Render snapshot. Plain-data subset of the world that the renderer
// needs each frame. Produced on the sim side (in-process today, in a
// worker after stage C), consumed by the UI to draw. Carries no class
// instances or store references -- everything is JSON-/structuredClone-
// transferable so it can cross a worker boundary later.
// ---------------------------------------------------------------------

export interface ParticleSnapshot {
  x: number;
  y: number;
  z: number;
  r: number;
  chemId: number;
  // Only present when the particle carries a molecule payload (corpse /
  // excretion). The renderer checks the waste fraction to switch to the
  // toxic-tint palette.
  molecules: Molecules | null;
}

// Slim shape used inside a cell's contents[] -- the renderer only needs
// color + radius to draw engulfed prey inside the host body, and the
// tooltip / inspector show counts but not individual fields.
export interface InnerCreatureSnapshot {
  id: number;
  color: string;
  r: number;
}

export interface CreatureSnapshot {
  id: number;
  x: number;
  y: number;
  z: number;
  r: number;
  vx: number;
  vy: number;
  color: string;
  energy: number;
  ingestCooldown: number;
  bornAt: number;
  lineageRoot: number;
  speciesKey: string;
  genome: Uint8Array;
  molecules: Molecules;
  vmPc: number;
  vmStack: number[];
  bondsCount: number;
  contents: InnerCreatureSnapshot[];
  division: { progress: number; axis: number; childR: number; childColor: string } | null;
}

export interface SpeciesSnapshot {
  key: string;
  color: string;
  firstSeen: number;
  lastSeen: number;
  alive: number;
  lane: number;
  genome: Uint8Array;
  peakBiomass: number;
}

export interface RenderSnapshot extends WorldEnv {
  // World geometry / scalars used by the renderer.
  width: number;
  depth: number;
  particleTarget: number;
  extinctionCount: number;
  // Lineage roots whose founder is still alive. Main thread uses this
  // to count "lineages that outlived the founder cull": a lineage with
  // live cells whose root isn't in this set has lost its founder and
  // is being carried by descendants only.
  livingFounderLineages: number[];
  pheromone: Float32Array;
  pheromoneCols: number;
  pheromoneRows: number;
  // Static across the run, but we ship it once so the renderer can
  // bake the terrain bitmap on the first snapshot it sees.
  obstacles: Obstacle[];
  particles: ParticleSnapshot[];
  creatures: CreatureSnapshot[];
  species: SpeciesSnapshot[];
  phylogenyEvents: PhylogenyEvent[];
  // Optional per-phase timing. Mirrors world.profile when present.
  profile?: WorldProfile;
}

function snapshotInner(c: Creature): InnerCreatureSnapshot {
  return { id: c.id, color: c.color, r: c.r };
}

function snapshotCreatureLive(c: Creature): CreatureSnapshot {
  const m = c.molecules;
  return {
    id: c.id,
    x: c.x,
    y: c.y,
    z: c.z,
    r: c.r,
    vx: c.vx,
    vy: c.vy,
    color: c.color,
    energy: c.energy,
    ingestCooldown: c.ingestCooldown,
    bornAt: c.bornAt,
    lineageRoot: c.lineageRoot,
    speciesKey: c.speciesKey,
    genome: c.genome,
    molecules: {
      adp: m.adp,
      glucose: m.glucose,
      fattyAcid: m.fattyAcid,
      aminoAcid: m.aminoAcid,
      chlorophyll: m.chlorophyll,
      enzyme: m.enzyme,
      o2: m.o2,
      co2: m.co2,
      minerals: m.minerals,
      biomass: m.biomass,
      waste: m.waste,
      ribosome: m.ribosome,
      biopolymer: m.biopolymer,
      membrane: m.membrane,
    },
    vmPc: c.vm.pc,
    // The renderer reads the stack length and a short preview; a slice
    // is enough and keeps the per-tick clone small.
    vmStack: c.vm.stack.slice(),
    bondsCount: c.bonds.length,
    contents: c.contents.map(snapshotInner),
    division: c.division
      ? {
          progress: c.division.progress,
          axis: c.division.axis,
          childR: c.division.child.r,
          childColor: c.division.child.color,
        }
      : null,
  };
}

function snapshotParticleLive(p: Particle): ParticleSnapshot {
  // p.molecules getter returns undefined when there's no payload; the
  // snapshot uses null for the same reason -- both are structured-
  // clone-friendly, but null is one less code path on the consumer.
  return {
    x: p.x,
    y: p.y,
    z: p.z,
    r: p.r,
    chemId: p.chemId,
    molecules: p.molecules ?? null,
  };
}

function snapshotSpecies(sp: Species): SpeciesSnapshot {
  return {
    key: sp.key,
    color: sp.color,
    firstSeen: sp.firstSeen,
    lastSeen: sp.lastSeen,
    alive: sp.alive,
    lane: sp.lane,
    genome: sp.genome,
    peakBiomass: sp.peakBiomass,
  };
}

// Copy the renderable subset of `world` into a fresh RenderSnapshot.
// Called once per render frame from the sim worker after each tick
// batch. The snapshot owns its own creature / particle / species
// arrays; the originals can be mutated by the next step without
// affecting any rendered frame.
export function takeSnapshot(world: World): RenderSnapshot {
  const creatures: CreatureSnapshot[] = new Array(world.creatures.length);
  for (let i = 0; i < world.creatures.length; i++) {
    creatures[i] = snapshotCreatureLive(world.creatures[i]);
  }
  const particles: ParticleSnapshot[] = new Array(world.particles.length);
  for (let i = 0; i < world.particles.length; i++) {
    particles[i] = snapshotParticleLive(world.particles[i]);
  }
  const species: SpeciesSnapshot[] = [];
  for (const sp of world.species.values()) species.push(snapshotSpecies(sp));
  return {
    width: world.width,
    height: world.height,
    depth: world.depth,
    t: world.t,
    surfaceY: world.surfaceY,
    surfaceWaveAmp: world.surfaceWaveAmp,
    surfaceLength: world.surfaceLength,
    surfacePeriod: world.surfacePeriod,
    swellLength: world.swellLength,
    swellPeriod: world.swellPeriod,
    updraftLength: world.updraftLength,
    updraftPeriod: world.updraftPeriod,
    disturbanceIntensity: world.disturbanceIntensity,
    tempSurface: world.tempSurface,
    tempBottom: world.tempBottom,
    tempPatchAmp: world.tempPatchAmp,
    tempPatchLength: world.tempPatchLength,
    tempPatchPeriod: world.tempPatchPeriod,
    dayPhase: world.dayPhase,
    particleTarget: world.particleTarget,
    extinctionCount: world.extinctionCount,
    // Lineage roots that still have a founder cell alive. Computed by
    // walking creatures: a creature whose id is in world.founderIds
    // contributes its lineageRoot. Set -> array for structured-clone.
    livingFounderLineages: (() => {
      const roots: number[] = [];
      const seen = new Set<number>();
      for (const c of world.creatures) {
        if (world.founderIds.has(c.id) && !seen.has(c.lineageRoot)) {
          seen.add(c.lineageRoot);
          roots.push(c.lineageRoot);
        }
      }
      return roots;
    })(),
    pheromone: new Float32Array(world.pheromone),
    pheromoneCols: world.pheromoneCols,
    pheromoneRows: world.pheromoneRows,
    obstacles: world.obstacles,
    particles,
    creatures,
    species,
    phylogenyEvents: world.phylogenyEvents.slice(),
    profile: world.profile,
  };
}
