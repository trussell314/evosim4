// Engine core: the structure-of-arrays particle/creature stores, the
// Particle/Creature/MoleculesView value classes, the worker
// shared-buffer layouts, and the World/Species/SimStats type graph.
// This is the foundational data layer every simulation pass operates
// on. It depends only on leaf modules (chem ids/table, rxn-stats,
// profile, genome VM types) and never imports sim.ts, so the
// dependency edge is one-directional and cycle-free.

import { CATALYST_COUNT, newOutputs, ELEMENT_KIND, type VMState, type VMOutputs, type GenomeElement } from "../genome";
import {
  type Molecules, MOLECULE_IDS,
  CHEMICAL_COUNT, NAMED_CHEMICAL_COUNT, GENERIC_CHEMICAL_COUNT,
  CHEM_NAMED_MOL_IDX,
} from "./chem-ids";
import { CHEM_BASE_DENSITY } from "./chemistry";
import type { RxnStats } from "./rxn-stats";
import type { WorldProfile } from "./profile";

// Render-only ghost of a particle that just demoted into reserve;
// fades out over RESERVE_FADE_SEC. Mass-free (the demotion already
// conserved mass); lives on World so the snapshot can draw it.
export interface FadingGhost {
  x: number;
  y: number;
  z: number;
  r: number;
  chemId: number;
  age: number;
}

// A free-floating extracellular DNA fragment: the physical vector
// behind horizontal gene transfer (and, intracellularly via the
// host-scoped buffer, endosymbiotic gene transfer). Shed by lysing
// cells and by cells actively expressing packaging; taken up by cells
// expressing competence; integrated append-only via appendGenomeBytes.
// DNase-like decay (age past a lifetime -> retired) bounds accumulation
// and makes shed/uptake timing a selection pressure. Unlike FadingGhost
// this is functional, not render-only, so it IS persisted.
export interface EDnaCarrier {
  x: number;
  y: number;
  z: number;
  // Seconds since shed; retired once past the DNase lifetime.
  age: number;
  // The shed genome fragment (already clamped to GENE_FRAGMENT_CAP at
  // shed time). Recipients copy a window of this via appendGenomeBytes.
  payload: Uint8Array;
  // Donor species key, for instrumentation only -- never gates uptake
  // (the substrate must not read identity to decide transfer).
  srcSpeciesKey: string;
}

// pushParticle reuses store slots (swap-pop). The collision subsystem
// (in sim.ts) keeps a parallel asleep-flag array that must be cleared
// for a reused slot. core has no collision dependency, so sim.ts
// registers the clear here -- same inversion as the force/collision
// dispatchers.
export let onParticleSlotReused: ((i: number) => void) | null = null;
export function setParticleSlotReusedHook(fn: ((i: number) => void) | null): void {
  onParticleSlotReused = fn;
}

export type ChemId = number;
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
// Fixed preallocated cap for the ParticleStore. The measured settle peak
// is ~1x particleTarget (the no-cap window at world start barely overshoots
// in practice), so the real ceiling is set by the max user-selectable
// target (PARTICLE_TARGET_MAX = 50000) plus headroom for the no-cap
// window above it. 131072 = ~2.6x that max, comfortably covering the
// 1600x1200 default (target ~4000 by area) too. The SAB-backed columns
// don't support growth (subworker views would become stale), so we
// reserve this up front. ~6 MB of memory at this cap.
export const PARTICLE_STORE_PREALLOC_CAP = 131072;

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
  // Slot reuse (swap-pop) means the collision system's parallel
  // asleep-flag array may carry a stale 1 from the previous occupant.
  // core has no collision dependency, so sim.ts registers a clear
  // hook (mirrors the force/collision dispatcher pattern); force-clear
  // it so the freshly-pushed particle isn't treated as asleep until
  // the next resolveCollisions pass classifies it for real.
  onParticleSlotReused?.(i);
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
// Fixed preallocated cap for CreatureStore. This is THE hard limit on
// total simultaneously-allocated cells (free + engulfed): the
// SAB-backed columns can't grow without invalidating subworker views
// (CreatureStore.grow throws), so allocation must never exceed this.
// MAX_CREATURES is set equal to it -- there is no separate, smaller
// "soft" population ceiling; the only cap is the physical store size.
// The larger per-column stride (16 KB) costs some L2 locality in the
// runGenericReactions sweep, but that's the price of a single,
// generous, never-grown allocation.
export const CREATURE_STORE_PREALLOC_CAP = 4096;

// Minimum creature radius (px). Floors cell size for physics, drag, and
// the reaction surface-area scaling. A fundamental creature dimension
// shared across the engine, so it lives with the creature store.
export const MIN_CREATURE_R = 4;

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
    inhibitor: number[];          // CATALYST_COUNT entries (allosteric repressor pools, parallel to catalyst)
    generic: number[];            // GENERIC_CHEMICAL_COUNT entries
  };
}

const CREATURE_F32_COLS = [
  "x", "y", "z", "vx", "vy", "vz",
  "r", "density",
  // Path 1: `energy` is no longer its own column -- it aliases the
  // m_atp named-molecule column (ATP is a first-class chemical).
  "senseRange", "thrustAccel",
  "bornAt", "ingestCooldown",
  "ax", "ay",
  "m_glucose", "m_fattyAcid", "m_aminoAcid", "m_minerals",
  "m_chlorophyll", "m_enzyme", "m_o2", "m_co2",
  "m_waste", "m_adp", "m_mrna",
  "m_biopolymer", "m_membrane",
  "m_photoreceptorVisible", "m_photoreceptorLong", "m_photoreceptorSurface",
  "m_activatedPhotoVisible", "m_activatedPhotoLong", "m_activatedPhotoSurface",
  "m_electroreceptor", "m_vibroreceptor", "m_phreceptor", "m_chemoreceptorMarker0",
  "m_activatedElectroX", "m_activatedElectroY",
  "m_activatedVibX", "m_activatedVibY",
  "m_activatedPh", "m_activatedChemoFaY",
  "m_activatedLightX", "m_activatedLightY",
  "m_mechanoreceptor", "m_activatedMechX", "m_activatedMechY",
  "m_thermoreceptor", "m_activatedThermo",
  "m_magnetoreceptor", "m_activatedMagX", "m_activatedMagY",
  "m_bondChem", "m_repairChem",
  "m_marker0", "m_marker1", "m_marker2", "m_marker3",
  "m_atp", // Path 1: ATP column; store.energy aliases this.
  // Sensory-emission scratch (NOT molecules -> not serialized, recomputed
  // each tick). atpSpentTick: ATP spent this tick (accumulated by spendATP,
  // reset per turn) -- the metabolic-activity proxy. electricEmission: the
  // cell's bioelectric output others detect (materialized pre-loop from
  // last-tick atpSpentTick), summed over neighbours in runActivation.
  // lightEmission: the cell's visible-light output (reflection of ambient
  // sky-light; bioluminescence added later) others' photoreceptors detect.
  "atpSpentTick", "electricEmission", "lightEmission", "vibrationEmission",
  // activeLightEmit: bioluminescence requested via OP.EMIT (light channel),
  // accumulated this tick, read next tick by the emission pass and added to
  // lightEmission on top of passive reflection. Reset per turn.
  "activeLightEmit",
  // shadeFactor (0..1): how much sky-light reaches this cell after cells
  // ABOVE it (toward the surface) cast shadow. Materialized in the pre-loop
  // pass; multiplies the cell's sky-light reads (photosynthesis,
  // photoreception, reflection) so a shaded cell makes/senses/reflects less.
  "shadeFactor",
  // Active-emission accumulators for the remaining EMIT channels (mirror
  // activeLightEmit): activeVibEmit folds into vibrationEmission; magnetic
  // has no passive term so activeMagEmit is materialized straight into
  // magneticEmission (the field other magnetoreceptors read -- long range,
  // not rock-occluded). All reset per turn, read next tick by the pass.
  "activeVibEmit", "activeMagEmit", "magneticEmission",
] as const;
const CREATURE_I32_COLS = ["repairTicks"] as const;
const CREATURE_U32_COLS = ["fpW0", "fpW1", "fpW2", "fpW3"] as const;

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
  const inhibitor: number[] = [];
  for (let k = 0; k < CATALYST_COUNT; k++) { inhibitor.push(o); o = align(o + f32Size); }
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
  return { buffer, offsets: { base, catalyst, inhibitor, generic } };
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
  m_waste!: Float32Array;
  m_adp!: Float32Array;
  m_mrna!: Float32Array;
  m_biopolymer!: Float32Array;
  m_membrane!: Float32Array;
  m_photoreceptorVisible!: Float32Array;
  m_photoreceptorLong!: Float32Array;
  m_photoreceptorSurface!: Float32Array;
  m_activatedPhotoVisible!: Float32Array;
  m_activatedPhotoLong!: Float32Array;
  m_activatedPhotoSurface!: Float32Array;
  m_electroreceptor!: Float32Array;
  m_vibroreceptor!: Float32Array;
  m_phreceptor!: Float32Array;
  m_chemoreceptorMarker0!: Float32Array;
  m_activatedElectroX!: Float32Array;
  m_activatedElectroY!: Float32Array;
  m_activatedVibX!: Float32Array;
  m_activatedVibY!: Float32Array;
  m_activatedPh!: Float32Array;
  m_activatedChemoFaY!: Float32Array;
  m_activatedLightX!: Float32Array;
  m_activatedLightY!: Float32Array;
  m_mechanoreceptor!: Float32Array;
  m_activatedMechX!: Float32Array;
  m_activatedMechY!: Float32Array;
  m_thermoreceptor!: Float32Array;
  m_activatedThermo!: Float32Array;
  m_magnetoreceptor!: Float32Array;
  m_activatedMagX!: Float32Array;
  m_activatedMagY!: Float32Array;
  m_bondChem!: Float32Array;
  m_repairChem!: Float32Array;
  m_marker0!: Float32Array;
  m_marker1!: Float32Array;
  m_marker2!: Float32Array;
  m_marker3!: Float32Array;
  m_atp!: Float32Array; // Path 1: ATP column; `energy` aliases it.
  atpSpentTick!: Float32Array;
  electricEmission!: Float32Array;
  lightEmission!: Float32Array;
  vibrationEmission!: Float32Array;
  activeLightEmit!: Float32Array;
  shadeFactor!: Float32Array;
  activeVibEmit!: Float32Array;
  activeMagEmit!: Float32Array;
  magneticEmission!: Float32Array;
  // Generic catalyst pool: one Float32Array per catalyst slot. Sized
  // to CATALYST_COUNT. Each catalyst k's pool multiplies its target
  // reaction's rate via (1 + pool/CAT_REF). Each slot is a view over
  // a contiguous region of the shared buffer.
  catalystCols!: Float32Array[];
  // Parallel allosteric-inhibitor pool: one Float32Array per slot,
  // SAME shape and decay/biosynth economics as catalystCols, but
  // multiplies its target reaction's rate DOWN (1 - INH_K*pool/CAT_REF)
  // instead of up. The off-switch for bootstrap reactions that now
  // run unconditionally on uncatRate (Phase 4a removed the synthMask
  // enable-gate); built via SYNTH INH <slot>.
  inhibitorCols!: Float32Array[];
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
  // Surface fingerprint: top-FP_SIZE chems packed into a 128-bit set
  // (four 32-bit words). Word i covers chem ids [32i .. 32i+31].
  // Phase I widened from 64 -> 128 bits to accommodate CHEMICAL_COUNT=96.
  fpW0!: Uint32Array;
  fpW1!: Uint32Array;
  fpW2!: Uint32Array;
  fpW3!: Uint32Array;
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
    // `energy` is aliased onto the m_atp column below (Path 1).
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
    this.m_waste = new Float32Array(b, o.base.m_waste, cap);
    this.m_adp = new Float32Array(b, o.base.m_adp, cap);
    this.m_mrna = new Float32Array(b, o.base.m_mrna, cap);
    this.m_biopolymer = new Float32Array(b, o.base.m_biopolymer, cap);
    this.m_membrane = new Float32Array(b, o.base.m_membrane, cap);
    this.m_photoreceptorVisible = new Float32Array(b, o.base.m_photoreceptorVisible, cap);
    this.m_photoreceptorLong = new Float32Array(b, o.base.m_photoreceptorLong, cap);
    this.m_photoreceptorSurface = new Float32Array(b, o.base.m_photoreceptorSurface, cap);
    this.m_activatedPhotoVisible = new Float32Array(b, o.base.m_activatedPhotoVisible, cap);
    this.m_activatedPhotoLong = new Float32Array(b, o.base.m_activatedPhotoLong, cap);
    this.m_activatedPhotoSurface = new Float32Array(b, o.base.m_activatedPhotoSurface, cap);
    this.m_electroreceptor = new Float32Array(b, o.base.m_electroreceptor, cap);
    this.m_vibroreceptor = new Float32Array(b, o.base.m_vibroreceptor, cap);
    this.m_phreceptor = new Float32Array(b, o.base.m_phreceptor, cap);
    this.m_chemoreceptorMarker0 = new Float32Array(b, o.base.m_chemoreceptorMarker0, cap);
    this.m_activatedElectroX = new Float32Array(b, o.base.m_activatedElectroX, cap);
    this.m_activatedElectroY = new Float32Array(b, o.base.m_activatedElectroY, cap);
    this.m_activatedVibX = new Float32Array(b, o.base.m_activatedVibX, cap);
    this.m_activatedVibY = new Float32Array(b, o.base.m_activatedVibY, cap);
    this.m_activatedPh = new Float32Array(b, o.base.m_activatedPh, cap);
    this.m_activatedChemoFaY = new Float32Array(b, o.base.m_activatedChemoFaY, cap);
    this.m_activatedLightX = new Float32Array(b, o.base.m_activatedLightX, cap);
    this.m_activatedLightY = new Float32Array(b, o.base.m_activatedLightY, cap);
    this.m_mechanoreceptor = new Float32Array(b, o.base.m_mechanoreceptor, cap);
    this.m_activatedMechX = new Float32Array(b, o.base.m_activatedMechX, cap);
    this.m_activatedMechY = new Float32Array(b, o.base.m_activatedMechY, cap);
    this.m_thermoreceptor = new Float32Array(b, o.base.m_thermoreceptor, cap);
    this.m_activatedThermo = new Float32Array(b, o.base.m_activatedThermo, cap);
    this.m_magnetoreceptor = new Float32Array(b, o.base.m_magnetoreceptor, cap);
    this.m_activatedMagX = new Float32Array(b, o.base.m_activatedMagX, cap);
    this.m_activatedMagY = new Float32Array(b, o.base.m_activatedMagY, cap);
    this.m_bondChem = new Float32Array(b, o.base.m_bondChem, cap);
    this.m_repairChem = new Float32Array(b, o.base.m_repairChem, cap);
    this.m_marker0 = new Float32Array(b, o.base.m_marker0, cap);
    this.m_marker1 = new Float32Array(b, o.base.m_marker1, cap);
    this.m_marker2 = new Float32Array(b, o.base.m_marker2, cap);
    this.m_marker3 = new Float32Array(b, o.base.m_marker3, cap);
    this.m_atp = new Float32Array(b, o.base.m_atp, cap);
    this.atpSpentTick = new Float32Array(b, o.base.atpSpentTick, cap);
    this.electricEmission = new Float32Array(b, o.base.electricEmission, cap);
    this.lightEmission = new Float32Array(b, o.base.lightEmission, cap);
    this.vibrationEmission = new Float32Array(b, o.base.vibrationEmission, cap);
    this.activeLightEmit = new Float32Array(b, o.base.activeLightEmit, cap);
    this.shadeFactor = new Float32Array(b, o.base.shadeFactor, cap);
    this.activeVibEmit = new Float32Array(b, o.base.activeVibEmit, cap);
    this.activeMagEmit = new Float32Array(b, o.base.activeMagEmit, cap);
    this.magneticEmission = new Float32Array(b, o.base.magneticEmission, cap);
    // Path 1: ATP is a first-class chemical. `energy` is the same
    // backing array as the m_atp molecule column (== molCols[atp] ==
    // chemCols[CHEM_ATP]); every store.energy / c.energy / c.molecules
    // .atp / chemCols[CHEM_ATP] access hits one memory location.
    this.energy = this.m_atp;
    this.repairTicks = new Int32Array(b, o.base.repairTicks, cap);
    this.fpW0 = new Uint32Array(b, o.base.fpW0, cap);
    this.fpW1 = new Uint32Array(b, o.base.fpW1, cap);
    this.fpW2 = new Uint32Array(b, o.base.fpW2, cap);
    this.fpW3 = new Uint32Array(b, o.base.fpW3, cap);
    this.catalystCols = new Array(CATALYST_COUNT);
    for (let k = 0; k < CATALYST_COUNT; k++) {
      this.catalystCols[k] = new Float32Array(b, o.catalyst[k], cap);
    }
    this.inhibitorCols = new Array(CATALYST_COUNT);
    for (let k = 0; k < CATALYST_COUNT; k++) {
      this.inhibitorCols[k] = new Float32Array(b, o.inhibitor[k], cap);
    }
    this.genericChemCols = new Array(GENERIC_CHEMICAL_COUNT);
    for (let k = 0; k < GENERIC_CHEMICAL_COUNT; k++) {
      this.genericChemCols[k] = new Float32Array(b, o.generic[k], cap);
    }
    // molCols MUST match MOLECULE_IDS order exactly.
    this.molCols = [
      this.m_adp, this.m_glucose, this.m_fattyAcid, this.m_aminoAcid,
      this.m_chlorophyll, this.m_enzyme, this.m_o2, this.m_co2,
      this.m_minerals, this.m_waste, this.m_mrna,
      this.m_biopolymer, this.m_membrane,
      this.m_photoreceptorVisible, this.m_photoreceptorLong, this.m_photoreceptorSurface,
      this.m_activatedPhotoVisible, this.m_activatedPhotoLong, this.m_activatedPhotoSurface,
      this.m_electroreceptor, this.m_vibroreceptor,
      this.m_phreceptor, this.m_chemoreceptorMarker0,
      this.m_activatedElectroX, this.m_activatedElectroY,
      this.m_activatedVibX, this.m_activatedVibY,
      this.m_activatedPh, this.m_activatedChemoFaY,
      this.m_activatedLightX, this.m_activatedLightY,
      this.m_mechanoreceptor, this.m_activatedMechX, this.m_activatedMechY,
      this.m_thermoreceptor, this.m_activatedThermo,
      this.m_magnetoreceptor, this.m_activatedMagX, this.m_activatedMagY,
      this.m_bondChem, this.m_repairChem,
      this.m_marker0, this.m_marker1, this.m_marker2, this.m_marker3,
      this.m_atp, // MUST stay last to match MOLECULE_IDS order.
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
  // True iff alloc() can hand out a slot without hitting the
  // un-growable ceiling. The single hard population gate -- callers
  // that create cells (fission, founder spawn, internal organelle
  // division) check this instead of any soft numeric cap.
  canAlloc(): boolean {
    return this.free.length > 0 || this.highWater < this.cap;
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
    this.fpW0[i] = 0; this.fpW1[i] = 0; this.fpW2[i] = 0; this.fpW3[i] = 0;
    this.ax[i] = 0; this.ay[i] = 0;
    // Zero every molecule column via molCols. Cheaper than listing
    // 40+ field names and stays correct as Tier 3 grows the table.
    for (let k = 0; k < this.molCols.length; k++) this.molCols[k][i] = 0;
    for (let k = 0; k < CATALYST_COUNT; k++) {
      this.catalystCols[k][i] = 0;
      this.inhibitorCols[k][i] = 0;
    }
    // Named chemCols 0..NAMED_CHEMICAL_COUNT-1 alias molCols and are
    // already cleared above; only the generic slice needs its own pass.
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
  get waste(): number { return this.c.store.m_waste[this.c.idx]; }
  set waste(v: number) { this.c.store.m_waste[this.c.idx] = v; }
  get adp(): number { return this.c.store.m_adp[this.c.idx]; }
  set adp(v: number) { this.c.store.m_adp[this.c.idx] = v; }
  get mrna(): number { return this.c.store.m_mrna[this.c.idx]; }
  set mrna(v: number) { this.c.store.m_mrna[this.c.idx] = v; }
  get biopolymer(): number { return this.c.store.m_biopolymer[this.c.idx]; }
  set biopolymer(v: number) { this.c.store.m_biopolymer[this.c.idx] = v; }
  get membrane(): number { return this.c.store.m_membrane[this.c.idx]; }
  set membrane(v: number) { this.c.store.m_membrane[this.c.idx] = v; }
  get photoreceptorVisible(): number { return this.c.store.m_photoreceptorVisible[this.c.idx]; }
  set photoreceptorVisible(v: number) { this.c.store.m_photoreceptorVisible[this.c.idx] = v; }
  get photoreceptorLong(): number { return this.c.store.m_photoreceptorLong[this.c.idx]; }
  set photoreceptorLong(v: number) { this.c.store.m_photoreceptorLong[this.c.idx] = v; }
  get photoreceptorSurface(): number { return this.c.store.m_photoreceptorSurface[this.c.idx]; }
  set photoreceptorSurface(v: number) { this.c.store.m_photoreceptorSurface[this.c.idx] = v; }
  get activatedPhotoVisible(): number { return this.c.store.m_activatedPhotoVisible[this.c.idx]; }
  set activatedPhotoVisible(v: number) { this.c.store.m_activatedPhotoVisible[this.c.idx] = v; }
  get activatedPhotoLong(): number { return this.c.store.m_activatedPhotoLong[this.c.idx]; }
  set activatedPhotoLong(v: number) { this.c.store.m_activatedPhotoLong[this.c.idx] = v; }
  get activatedPhotoSurface(): number { return this.c.store.m_activatedPhotoSurface[this.c.idx]; }
  set activatedPhotoSurface(v: number) { this.c.store.m_activatedPhotoSurface[this.c.idx] = v; }
  get electroreceptor(): number { return this.c.store.m_electroreceptor[this.c.idx]; }
  set electroreceptor(v: number) { this.c.store.m_electroreceptor[this.c.idx] = v; }
  get vibroreceptor(): number { return this.c.store.m_vibroreceptor[this.c.idx]; }
  set vibroreceptor(v: number) { this.c.store.m_vibroreceptor[this.c.idx] = v; }
  get phreceptor(): number { return this.c.store.m_phreceptor[this.c.idx]; }
  set phreceptor(v: number) { this.c.store.m_phreceptor[this.c.idx] = v; }
  get chemoreceptorMarker0(): number { return this.c.store.m_chemoreceptorMarker0[this.c.idx]; }
  set chemoreceptorMarker0(v: number) { this.c.store.m_chemoreceptorMarker0[this.c.idx] = v; }
  get activatedElectroX(): number { return this.c.store.m_activatedElectroX[this.c.idx]; }
  set activatedElectroX(v: number) { this.c.store.m_activatedElectroX[this.c.idx] = v; }
  get activatedElectroY(): number { return this.c.store.m_activatedElectroY[this.c.idx]; }
  set activatedElectroY(v: number) { this.c.store.m_activatedElectroY[this.c.idx] = v; }
  get activatedVibX(): number { return this.c.store.m_activatedVibX[this.c.idx]; }
  set activatedVibX(v: number) { this.c.store.m_activatedVibX[this.c.idx] = v; }
  get activatedVibY(): number { return this.c.store.m_activatedVibY[this.c.idx]; }
  set activatedVibY(v: number) { this.c.store.m_activatedVibY[this.c.idx] = v; }
  get activatedPh(): number { return this.c.store.m_activatedPh[this.c.idx]; }
  set activatedPh(v: number) { this.c.store.m_activatedPh[this.c.idx] = v; }
  get activatedChemoFaY(): number { return this.c.store.m_activatedChemoFaY[this.c.idx]; }
  set activatedChemoFaY(v: number) { this.c.store.m_activatedChemoFaY[this.c.idx] = v; }
  get activatedLightX(): number { return this.c.store.m_activatedLightX[this.c.idx]; }
  set activatedLightX(v: number) { this.c.store.m_activatedLightX[this.c.idx] = v; }
  get activatedLightY(): number { return this.c.store.m_activatedLightY[this.c.idx]; }
  set activatedLightY(v: number) { this.c.store.m_activatedLightY[this.c.idx] = v; }
  get mechanoreceptor(): number { return this.c.store.m_mechanoreceptor[this.c.idx]; }
  set mechanoreceptor(v: number) { this.c.store.m_mechanoreceptor[this.c.idx] = v; }
  get activatedMechX(): number { return this.c.store.m_activatedMechX[this.c.idx]; }
  set activatedMechX(v: number) { this.c.store.m_activatedMechX[this.c.idx] = v; }
  get activatedMechY(): number { return this.c.store.m_activatedMechY[this.c.idx]; }
  set activatedMechY(v: number) { this.c.store.m_activatedMechY[this.c.idx] = v; }
  get thermoreceptor(): number { return this.c.store.m_thermoreceptor[this.c.idx]; }
  set thermoreceptor(v: number) { this.c.store.m_thermoreceptor[this.c.idx] = v; }
  get activatedThermo(): number { return this.c.store.m_activatedThermo[this.c.idx]; }
  set activatedThermo(v: number) { this.c.store.m_activatedThermo[this.c.idx] = v; }
  get magnetoreceptor(): number { return this.c.store.m_magnetoreceptor[this.c.idx]; }
  set magnetoreceptor(v: number) { this.c.store.m_magnetoreceptor[this.c.idx] = v; }
  get activatedMagX(): number { return this.c.store.m_activatedMagX[this.c.idx]; }
  set activatedMagX(v: number) { this.c.store.m_activatedMagX[this.c.idx] = v; }
  get activatedMagY(): number { return this.c.store.m_activatedMagY[this.c.idx]; }
  set activatedMagY(v: number) { this.c.store.m_activatedMagY[this.c.idx] = v; }
  get bondChem(): number { return this.c.store.m_bondChem[this.c.idx]; }
  set bondChem(v: number) { this.c.store.m_bondChem[this.c.idx] = v; }
  get repairChem(): number { return this.c.store.m_repairChem[this.c.idx]; }
  set repairChem(v: number) { this.c.store.m_repairChem[this.c.idx] = v; }
  get marker0(): number { return this.c.store.m_marker0[this.c.idx]; }
  set marker0(v: number) { this.c.store.m_marker0[this.c.idx] = v; }
  get marker1(): number { return this.c.store.m_marker1[this.c.idx]; }
  set marker1(v: number) { this.c.store.m_marker1[this.c.idx] = v; }
  get marker2(): number { return this.c.store.m_marker2[this.c.idx]; }
  set marker2(v: number) { this.c.store.m_marker2[this.c.idx] = v; }
  get marker3(): number { return this.c.store.m_marker3[this.c.idx]; }
  set marker3(v: number) { this.c.store.m_marker3[this.c.idx] = v; }
  get atp(): number { return this.c.store.m_atp[this.c.idx]; }
  set atp(v: number) { this.c.store.m_atp[this.c.idx] = v; }
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
// createWorld resets this for determinism / hot-reload. Imported
// bindings are read-only across modules, so expose a setter.
export function resetCreatureIdCounter(): void { NEXT_CREATURE_ID = 1; }
export class Creature {
  idx: number;
  store: CreatureStore;
  // Stable identity that outlives store slot reuse. Assigned at
  // newCreature time; never recycled, never reused on resurrection.
  // The renderer uses this to track click selection across ticks
  // when the worker rebuilds creature snapshots each frame.
  id: number = 0;
  // Non-typed-array fields kept on the handle (variable-shape, not hot)
  // Heritable elements: genomes[0] is the (only, today) chromosome.
  // `genome` is an accessor for its bytes so the existing single-genome
  // call sites are unchanged while the multi-element storage exists
  // underneath (diploidy = extra CHROMOSOMEs; HGT = PLASMID elements).
  genomes: GenomeElement[] = [];
  get genome(): Uint8Array { return this.genomes[0].bytes; }
  set genome(v: Uint8Array) {
    if (this.genomes.length === 0) this.genomes.push({ kind: ELEMENT_KIND.CHROMOSOME, bytes: v });
    else this.genomes[0].bytes = v;
  }
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
  // Greenbeard adhesion tag (0..255), refreshed from the VM each tick a
  // cell expresses SYNTH BOND; -1 = not adhesive. Genome-encoded and
  // inherited, so a clonal colony shares one marker.
  bondMarker: number = -1;
  // id of the cell this one fissioned from (-1 for founders). Purely
  // for the UI: lets selection "descend" to a child if the selected
  // cell divides and the parent later dies.
  parentId: number = -1;
  division: { progress: number; axis: number; child: Creature } | null = null;
  contents: Creature[] = [];
  bonds: Creature[] = [];
  // Host-scoped extracellular-DNA buffer: fragments shed by this
  // cell's own engulfed symbionts when they lyse (digestInnerIntoHost).
  // The intracellular locality of the same HGT substrate -- this cell's
  // competence integrates from here, so endosymbiotic gene transfer is
  // not special-cased: its count-scaled ratchet emerges because more
  // symbionts -> more deaths -> more buffered fragments. null = empty.
  eDnaBuffer: Uint8Array | null = null;
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
  // Setter: copy field-by-field from any Molecules-shaped object
  // into the typed-array slot. Iterates molCols so adding chems
  // doesn't require updating this method.
  set molecules(m: Partial<Molecules>) {
    const cols = this.store.molCols;
    const i = this.idx;
    const mm = m as Record<string, number | undefined>;
    for (let k = 0; k < MOLECULE_IDS.length; k++) {
      cols[k][i] = mm[MOLECULE_IDS[k]] ?? 0;
    }
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
    const mm = m as Record<string, number | undefined>;
    for (let k = 0; k < MOLECULE_IDS.length; k++) {
      const v = mm[MOLECULE_IDS[k]];
      if (v !== undefined) store.molCols[k][idx] = v;
    }
  }
  return c;
}

// Chem / reaction display labels live in ./sim/labels (imported +
// re-exported at the top of this file).

// 32-bit FNV-1a hash of a genome, rendered as a 6-char base36 tag
// for use as a stable, content-derived species label. Replaces the
// previous `sp.key.slice(0, 6)` (first 3 bytes of the genome) which
// post-K-4/K-5 collided for every cell back when founders shared a
// fixed curated-genome prefix (since removed -- founders are random).

// Molecules / MOLECULE_IDS / emptyMolecules / MOLECULE_INDEX and the
// CHEM_* id space live in ./sim/chem-ids (imported + re-exported at
// the top of this file).

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
  // Per-position VM execution counter (length = the species' captured
  // genome length; PCs past it from somatic growth go untraced).
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

export interface SimStats {
  births: number;       // cumulative successful child births
  dStarve: number;      // deaths: energy<=0 & no fuel
  dMembrane: number;    // deaths: membrane below viable
  dMrna: number;        // deaths: mrna below viable
  dAa: number;          // deaths: amino acid below viable
  dOld: number;         // deaths: founder old-age cull
}
export interface World {
  // Optional cumulative counters for instrumentation. Optional so
  // hand-built test World literals don't need to populate it.
  stats?: SimStats;
  // Reaction / ATP accounting (60s windows, persisted). Optional so
  // hand-built test World literals don't need to populate it.
  rxnStats?: RxnStats;
  // Whether the founder top-up spawns new lineages. Optional: absent
  // (older saves / test literals) means enabled. Persisted.
  foundersEnabled?: boolean;
  // Founder spawning mode. Absent/true = CAPPED: top the world up to
  // founderTarget distinct coding lineages and stop. false = NO CAP:
  // ignore the ceiling and trickle a fresh founder every interval
  // indefinitely (continuous immigration). Persisted.
  founderCapEnabled?: boolean;
  // Whether the world keeps replenishing resource particles toward the
  // cap *after* the one-shot startup seed. The startup seed (the
  // "initial period") always happens regardless; this only controls
  // ongoing periodic resource dumping. Absent/false = closed system
  // after startup. Persisted. (Non-ramp test worlds ignore this and
  // keep their legacy continuous replenish.)
  ongoingSeeding?: boolean;
  // Simulation RNG, installed by createWorld. Optional so hand-built
  // test World literals don't need it -- the module falls back to its
  // own simRng for internal draws regardless. Exposed for callers that
  // want the world's reproducible stream. Transient; not persisted.
  rng?: () => number;
  // UI focus chem for the density overlay (-1 / absent = all chems).
  // Transient; not persisted.
  densityChem?: number;
  // Creature ids the UI has asked to kill. Drained by the death pass
  // each step (matched cells die like any other death). Transient; not
  // persisted.
  killRequests?: Set<number>;
  width: number;
  height: number;
  depth: number;
  t: number;
  particles: Particle[];
  particleStore: ParticleStore;
  // Render-only transients: particles that were just demoted into
  // reserve. They carry no mass and no physics (their mass is already
  // in world.reserve); they exist purely so the renderer can fade the
  // vanishing particle out instead of popping it. Not persisted.
  fadingGhosts: FadingGhost[];
  // Free-floating extracellular DNA fragments (HGT vector). Functional
  // (recipients integrate from these), so unlike fadingGhosts this IS
  // persisted. Aged + retired by advanceEDnaCarriers, hard-capped.
  eDnaCarriers: EDnaCarrier[];
  creatures: Creature[];
  creatureStore: CreatureStore;
  particleTarget: number;
  // Particle count at/above which collision + force passes dispatch to
  // the worker pool (runtime-tunable from the UI; see setParallelMin).
  parallelMin: number;
  particleSpawnRate: number;
  // One-shot startup seeding. When useSeedRamp is true the world is
  // born empty and seedRamp() adds a fixed batch of particles once per
  // sim-second (in the spawn-spec ratio) until particleTarget is
  // reached; then initialSeedDone latches true and NOTHING respawns
  // (no ongoing replenish) -- the pool is fixed for the rest of the
  // run. Founders are held back until initialSeedDone. When
  // useSeedRamp is false (tests / direct callers) the world is fully
  // seeded up front and the legacy continuous replenish stays on.
  useSeedRamp: boolean;
  initialSeedDone: boolean;
  seedRampClock: number;
  // extinctionCount counts founding-lineage extinction events. Each
  // step we diff the previous live-lineage set against the current
  // one; any lineage that was alive last step but not this step
  // increments the counter. Whole-world wipeouts contribute too
  // (every lineage dies at once), but a single lineage going extinct
  // while others survive also counts.
  extinctionCount: number;
  // Set of distinct CODING-GENOME keys (genomeCodingKey: gene bytes
  // only, introns ignored) alive at the start of the current step.
  // Used to count genome extinctions per step and to gate founder
  // immigration on functional diversity rather than founder ancestry.
  liveCodingKeys: Set<string>;
  // Monotonic counter used to assign a fresh lineageRoot ID each time
  // a founder is spawned (initial seeding + top-up after extinctions).
  nextLineageRoot: number;
  // Steady-state target for distinct founding lineages alive in the
  // world. Each step counts current lineages and spawns up to this
  // many to top up. Real worlds use 10; tests usually set to 0 to
  // disable spontaneous founder spawning while they assert specific
  // population shapes.
  founderTarget: number;
  // Sim-time of the last founder spawned by the rare-immigration
  // rescue trickle. Gates the trickle so founders are a rare external
  // rescue, not a continuous population subsidy. Transient (not
  // serialized -- reloading just resets the trickle clock).
  lastFounderTrickleT: number;
  // Set of creature IDs that were spawned as founders (vs. born from
  // fission). Used by the age-based founder-cull -- see FOUNDER_LIFESPAN_SEC.
  // Stays populated for the founder's entire life so the HUD's
  // livingFounderLineages count reflects "lineages whose original
  // founder cell is still alive".
  founderIds: Set<number>;
  // Subset of founderIds whose owner has already committed at least
  // one fission. These are exempt from the lifespan cull -- the
  // cull's job is to retire founders that never reproduced, not to
  // wall off a successful lineage's original cell. Removed alongside
  // founderIds when the cell finally dies.
  founderReproduced: Set<number>;
  // Per-founder snapshot taken at spawn (post-scoop). Lets the
  // lifespan cull grant a founder extra runway if it has measurably
  // progressed from what it started with -- see founderLifespanBonus.
  // Entry removed when the founder leaves world.creatures.
  founderBirthScore: Map<number, { mass: number; mrna: number; machinery: number }>;
  // speciesKeys the user has pinned in the UI. A founder whose
  // speciesKey is in here is exempt from the age cull so a watched
  // lineage isn't retired out from under the observer. Set from the
  // main thread via the "setPinnedSpecies" worker message.
  pinnedSpecies: Set<string>;
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
  // Phase 4: invisible per-region chemical reserve (flat
  // [region*CHEMICAL_COUNT + chem]). Holds mass demoted off-screen
  // when the global particle cap is hit; promoted back to rendered
  // particles when there's room. Same layout as `ambient`.
  reserve: Float32Array;
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
  // Wind: signed horizontal velocity that drives the surface waves.
  // Positive => blowing right, negative => blowing left, magnitude
  // sets wave amplitude. Driven by a smoothed random walk toward
  // windTarget; gusts push windTarget to a higher magnitude for the
  // duration of a disturbance event. Tests can pin wind=0 for
  // glassy-surface scenarios.
  wind: number;
  windTarget: number;
  // Per-column wind exposure maps in [0,1]. Computed at terrain build.
  // windExposureFromLeft[x] is the exposure to wind blowing right (so
  // tall rocks to the left of x shelter that column); from-right is
  // the mirror. surfaceYAt picks the map matching the sign of wind.
  // Empty for worlds without terrain.
  windExposureFromLeft?: Float32Array;
  windExposureFromRight?: Float32Array;
  // Per-column wave-train spatial origin (reset at surface-breaching
  // rock edges) so the lee re-forms waves instead of phase-locking to
  // the windward train. Direction-paired like the exposure maps.
  waveOriginFromLeft?: Float32Array;
  waveOriginFromRight?: Float32Array;
  // Per-column windward-apron wave-amplitude multiplier (shoaling toward
  // surface-breaching rock). Direction-paired like the maps above.
  shoalFromLeft?: Float32Array;
  shoalFromRight?: Float32Array;
  // Per-region effective temperature (state-bearing field, stepped by
  // sampleRegionTemps each tick: diffuses neighbour heat, relaxes
  // toward the analytical baseline temperatureAt, integrates vent
  // source). Row-major regionCols x regionRows; allocated lazily on
  // first sampleRegionTemps call. regionTempNext is the per-tick
  // scratch buffer. Both live on the world (not module scope) so
  // independent worlds don't share thermal state.
  regionTemp: Float32Array;
  regionTempNext: Float32Array;
  // VM ops budget per creature per tick. Lower = cheaper; cells just
  // take more ticks to finish a full pass through their genome.
  vmInstrBudget: number;
  // Static immovable terrain: rocks pre-placed at world creation. Each
  // obstacle is a cluster of overlapping circle "lobes" so it can be
  // irregular in shape. Particles + creatures collide with them like
  // a fixed wall (no impulse, just positional pushback). Hand-authored
  // shapes from sim/terrain-shapes.ts get instantiated here.
  obstacles: Obstacle[];
  // Per-column topmost-rock-y, indexed by integer x. Used by the
  // founder-placement fast path. Empty array for worlds without
  // terrain. Populated by generateObstacles.
  terrainHeightmap?: Float32Array;
  // Hydrothermal vent. Optional: tests build worlds without one. The
  // vent runs an eruption schedule, emits hot particles upward during
  // eruptions, and contributes a localized temperature bubble that
  // temperatureAt reads. Mass conservation: emitted mass is recorded
  // on world.ventEmitted so the engine's mass invariant becomes
  // particles+cells+ambient-ventEmitted = const.
  vent?: VentState;
  // Cumulative mass the vent has injected into the world, per molecule
  // index (Molecules layout). Treated as a source term in the mass
  // ledger -- worldMass() subtracts this so the conservation invariant
  // remains tight even though the vent is technically a true source.
  ventEmitted?: Float64Array;
  // Optional per-phase timing. When present, step() accumulates wall-clock
  // milliseconds spent in each phase plus a tick counter. Read + reset by
  // the UI to display where the frame budget actually goes.
  profile?: WorldProfile;
}

// Hydrothermal vent state. One per world (or none in test scaffolds).
// Position is in world coordinates; the vent sits inside the seafloor
// rock with its mouth opening at (x, y - mouthDepth). The phase machine
// runs dormant -> warmup -> eruption -> cooldown -> dormant on a fixed
// schedule (with small jitter) so the user sees a recognizable pattern:
// long quiet stretches punctuated by visible plumes.
export interface VentState {
  x: number;
  y: number;
  // Next scheduled eruption start time (sim seconds). When t crosses
  // this, phase flips to "warmup".
  nextEruptionAt: number;
  // When the current eruption (warmup + main + cooldown) ends and the
  // vent returns to dormant. 0 when dormant.
  eruptionEndsAt: number;
  // 0..1 intensity envelope. Dormant=0; warmup ramps 0->1; main holds
  // 1; cooldown ramps 1->0. Read by emit + temperatureAt + renderer.
  intensity: number;
  // True while emitting (warmup + main + cooldown). Dormant=false.
  active: boolean;
  // Accumulator for emission cadence: emit one batch every so many sim
  // seconds while active.
  emitClock: number;
}

// Body-mass helpers. Mass is an intrinsic property of a Particle /
// Creature, used by collision (momentum), buoyancy, predation, and
// division. Particles are spheres; the rendered circle is the
// equatorial cross-section.
export function mass(p: Particle): number {
  const d = p.density ?? CHEM_BASE_DENSITY[p.chemId];
  return d * (4 / 3) * Math.PI * p.r * p.r * p.r;
}

export function creatureTotalMass(c: Creature): number {
  // ATP is the `atp` molecule (== c.energy, aliased), so it is summed by
  // the MOLECULE_IDS loop -- no separate c.energy term (double-count).
  let m = 0;
  for (const k of MOLECULE_IDS) m += c.molecules[k];
  // Engulfed prey lives in our vacuole; its mass still occupies our
  // volume. Recurse through every nesting level: a cell we engulfed may
  // itself hold prey it had engulfed, and all of it rides inside us.
  // Contents form a strict tree (engulf moves a cell out of the world
  // into one container), so this terminates.
  for (const inner of c.contents) m += creatureTotalMass(inner);
  return m;
}
