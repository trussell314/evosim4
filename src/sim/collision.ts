// Spatial indexing + collision resolution. Owns three uniform-grid
// neighbour indices -- particle buckets (forParticlesNear), creature
// buckets (forCreaturesNear / creature collision), and chem sensor bins
// (chemGradient) -- plus the SharedArrayBuffer-backed particle-collision
// grid + delta scratch that the row-parity subworkers read directly
// (getCollisionSharedLayout / applyCollisionsRowRange). All grid state
// is rebuilt each tick from the world's stores; nothing here draws RNG.
//
// This is a leaf of the engine graph: it reads core value types + the
// region helpers + the body-mass helpers, and is driven by sim.ts's
// step() + the worker pool. It imports nothing back from sim.ts.

import {
  type World, type Particle, type Creature,
  setParticleSlotReusedHook, PARTICLE_STORE_PREALLOC_CAP,
  mass, creatureTotalMass,
} from "./core";
import { regionCols, regionRows, REGION_PX, AMBIENT_STRIDE, PRECIP_R } from "./regions";
import { CHEMICAL_COUNT, CHEM_MIN } from "./chem-ids";
import { CHEM_BASE_DENSITY, CHEM_MM } from "./chemistry";

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
    // Jacobi collision accumulators: per-particle position/velocity
    // deltas. The sweep reads the frozen PX/PVX snapshot and only
    // ACCUMULATES here; resolveCollisions applies them after the
    // barrier. Order-independent -> no Gauss-Seidel directional drift.
    dpx: number; dpy: number; dpz: number;
    dvx: number; dvy: number; dvz: number;
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
  offsets.dpx = o; o = align(o + COLLISION_MAX_PARTICLES * 4);
  offsets.dpy = o; o = align(o + COLLISION_MAX_PARTICLES * 4);
  offsets.dpz = o; o = align(o + COLLISION_MAX_PARTICLES * 4);
  offsets.dvx = o; o = align(o + COLLISION_MAX_PARTICLES * 4);
  offsets.dvy = o; o = align(o + COLLISION_MAX_PARTICLES * 4);
  offsets.dvz = o; o = align(o + COLLISION_MAX_PARTICLES * 4);
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
export const COLLISION_ASLEEP = new Uint8Array(COLLISION_LAYOUT.buffer, COLLISION_LAYOUT.offsets.asleep, COLLISION_MAX_PARTICLES);
// core's pushParticle reuses store slots; clear the stale collision
// asleep flag for a recycled slot (core has no collision dependency).
setParticleSlotReusedHook((i) => { COLLISION_ASLEEP[i] = 0; });
const COLLISION_CELL_START = new Int32Array(COLLISION_LAYOUT.buffer, COLLISION_LAYOUT.offsets.cellStart, COLLISION_MAX_CELLS + 1);
const COLLISION_CELL_ITEMS = new Int32Array(COLLISION_LAYOUT.buffer, COLLISION_LAYOUT.offsets.cellItems, COLLISION_MAX_PARTICLES);
const COLLISION_DPX = new Float32Array(COLLISION_LAYOUT.buffer, COLLISION_LAYOUT.offsets.dpx, COLLISION_MAX_PARTICLES);
const COLLISION_DPY = new Float32Array(COLLISION_LAYOUT.buffer, COLLISION_LAYOUT.offsets.dpy, COLLISION_MAX_PARTICLES);
const COLLISION_DPZ = new Float32Array(COLLISION_LAYOUT.buffer, COLLISION_LAYOUT.offsets.dpz, COLLISION_MAX_PARTICLES);
const COLLISION_DVX = new Float32Array(COLLISION_LAYOUT.buffer, COLLISION_LAYOUT.offsets.dvx, COLLISION_MAX_PARTICLES);
const COLLISION_DVY = new Float32Array(COLLISION_LAYOUT.buffer, COLLISION_LAYOUT.offsets.dvy, COLLISION_MAX_PARTICLES);
const COLLISION_DVZ = new Float32Array(COLLISION_LAYOUT.buffer, COLLISION_LAYOUT.offsets.dvz, COLLISION_MAX_PARTICLES);
// Per-cell counter scratch used during cellItems build. Not shared
// across workers; only the sim worker touches it.
let COLLISION_CELL_COUNTER = new Int32Array(0);
// Cell-placement cursor, hoisted out of resolveCollisions to avoid a
// per-tick alloc (cellCount typically 3-4k, so this is ~13KB of GC
// pressure on every tick under non-trivial particle counts).
let COLLISION_CELL_CURSOR = new Int32Array(0);
export function getCollisionSharedLayout(): CollisionSharedLayout {
  return COLLISION_LAYOUT;
}

export const SLEEP_SPEED_SQ = 25;       // <5 px/s counts as still
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
// K-2: sensor bins widen from 6 slots (per-sensor-chem) to one slot
// per chem id (CHEMICAL_COUNT). Lets the chemo activation pass query
// gradients for any chem id, not just the legacy 6 SENSOR_CHEMS.
// Memory: ~CHEMICAL_COUNT * 3 arrays * SENSOR_BIN_ALLOC * 4 bytes.
// At 96 chems * 300 bins * 12 bytes that's ~350KB, allocated once.
const SENSOR_BIN_COUNT: Int32Array[] = [];   // [chemId][bin]
const SENSOR_BIN_SUMX: Float32Array[] = [];
const SENSOR_BIN_SUMY: Float32Array[] = [];
let SENSOR_BIN_ALLOC = 0;

export function rebuildSensorBins(world: World): void {
  SENSOR_BIN_COLS = Math.max(1, Math.ceil(world.width / SENSOR_BIN));
  SENSOR_BIN_ROWS = Math.max(1, Math.ceil(world.height / SENSOR_BIN));
  const n = SENSOR_BIN_COLS * SENSOR_BIN_ROWS;
  if (n > SENSOR_BIN_ALLOC) {
    SENSOR_BIN_COUNT.length = 0;
    SENSOR_BIN_SUMX.length = 0;
    SENSOR_BIN_SUMY.length = 0;
    const alloc = n * 2;
    for (let m = 0; m < CHEMICAL_COUNT; m++) {
      SENSOR_BIN_COUNT.push(new Int32Array(alloc));
      SENSOR_BIN_SUMX.push(new Float32Array(alloc));
      SENSOR_BIN_SUMY.push(new Float32Array(alloc));
    }
    SENSOR_BIN_ALLOC = alloc;
  } else {
    for (let m = 0; m < CHEMICAL_COUNT; m++) {
      SENSOR_BIN_COUNT[m].fill(0, 0, n);
      SENSOR_BIN_SUMX[m].fill(0, 0, n);
      SENSOR_BIN_SUMY[m].fill(0, 0, n);
    }
  }
  const store = world.particleStore;
  const PX = store.x, PY = store.y, PCHEM = store.chemId;
  const np = world.particles.length;
  for (let i = 0; i < np; i++) {
    const chem = PCHEM[i];
    // Bin every particle by its raw chemId. K-5 retires the legacy
    // 6-slot SENSE_GRAD ops; chemoGradient() queries by any chemId.
    const xi = PX[i], yi = PY[i];
    let bx = Math.floor(xi / SENSOR_BIN);
    let by = Math.floor(yi / SENSOR_BIN);
    if (bx < 0) bx = 0; else if (bx >= SENSOR_BIN_COLS) bx = SENSOR_BIN_COLS - 1;
    if (by < 0) by = 0; else if (by >= SENSOR_BIN_ROWS) by = SENSOR_BIN_ROWS - 1;
    const bin = by * SENSOR_BIN_COLS + bx;
    SENSOR_BIN_COUNT[chem][bin]++;
    SENSOR_BIN_SUMX[chem][bin] += xi;
    SENSOR_BIN_SUMY[chem][bin] += yi;
  }
  // Blend each region's reserve into the bins as particle-equivalents,
  // placed at the region center, so SENSE_OUT gradients sense total
  // (rendered + reserve) food. With the particle cap low most food lives
  // in reserve; without this a cell would be blind to it and chase only
  // the sparse rendered sample. Deterministic; ~nReg*CHEMICAL_COUNT/tick.
  const res = world.reserve;
  if (res.length > 0) {
    const rcols = regionCols(world);
    const nReg = rcols * regionRows(world);
    const volPer = (4 / 3) * Math.PI * PRECIP_R * PRECIP_R * PRECIP_R;
    const half = REGION_PX / 2;
    for (let ri = 0; ri < nReg; ri++) {
      const rgx = (ri % rcols) * REGION_PX + half;
      const rgy = ((ri / rcols) | 0) * REGION_PX + half;
      let bx = Math.floor(rgx / SENSOR_BIN);
      let by = Math.floor(rgy / SENSOR_BIN);
      if (bx < 0) bx = 0; else if (bx >= SENSOR_BIN_COLS) bx = SENSOR_BIN_COLS - 1;
      if (by < 0) by = 0; else if (by >= SENSOR_BIN_ROWS) by = SENSOR_BIN_ROWS - 1;
      const bin = by * SENSOR_BIN_COLS + bx;
      const base = ri * AMBIENT_STRIDE;
      for (let k = 0; k < CHEMICAL_COUNT; k++) {
        const rmass = res[base + k];
        if (rmass <= 0) continue;
        const density = CHEM_BASE_DENSITY[k] > 0 ? CHEM_BASE_DENSITY[k] : 1;
        const amountPer = (density * volPer) / CHEM_MM[k];
        if (amountPer <= 0) continue;
        const eq = Math.round(rmass / amountPer);
        if (eq <= 0) continue;
        SENSOR_BIN_COUNT[k][bin] += eq;
        SENSOR_BIN_SUMX[k][bin] += eq * rgx;
        SENSOR_BIN_SUMY[k][bin] += eq * rgy;
      }
    }
  }
}

// Gradient pull vector toward particles of a given chem within
// sense range, using the same inverse-square weighting as the
// legacy populateSensors GRAD loop. Out is written into the provided
// length-2 array to avoid allocations in the per-cell hot path.
// K-3's activation pass calls this; not yet wired (silences
// noUnusedLocals via export below).
export function chemGradient(cx: number, cy: number, range: number, chemId: number, out: Float32Array): void {
  out[0] = 0; out[1] = 0;
  if (chemId < 0 || chemId >= CHEMICAL_COUNT) return;
  const rangeSq = range * range;
  const span = Math.ceil(range / SENSOR_BIN);
  let cbx = Math.floor(cx / SENSOR_BIN);
  let cby = Math.floor(cy / SENSOR_BIN);
  if (cbx < 0) cbx = 0; else if (cbx >= SENSOR_BIN_COLS) cbx = SENSOR_BIN_COLS - 1;
  if (cby < 0) cby = 0; else if (cby >= SENSOR_BIN_ROWS) cby = SENSOR_BIN_ROWS - 1;
  const x0 = Math.max(0, cbx - span);
  const x1 = Math.min(SENSOR_BIN_COLS - 1, cbx + span);
  const y0 = Math.max(0, cby - span);
  const y1 = Math.min(SENSOR_BIN_ROWS - 1, cby + span);
  const cnt = SENSOR_BIN_COUNT[chemId];
  const sxArr = SENSOR_BIN_SUMX[chemId];
  const syArr = SENSOR_BIN_SUMY[chemId];
  let gx = 0, gy = 0;
  for (let by = y0; by <= y1; by++) {
    const row = by * SENSOR_BIN_COLS;
    for (let bx = x0; bx <= x1; bx++) {
      const bin = row + bx;
      const n = cnt[bin];
      if (n === 0) continue;
      const cxBin = sxArr[bin] / n;
      const cyBin = syArr[bin] / n;
      const dx = cxBin - cx;
      const dy = cyBin - cy;
      const dsq = dx * dx + dy * dy;
      if (dsq >= rangeSq || dsq < 1) continue;
      const w = range / dsq;
      gx += dx * w * n;
      gy += dy * w * n;
    }
  }
  out[0] = gx;
  out[1] = gy;
}


export function buildCreatureGrid(world: World): void {
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

// Per-tick spatial grid of particle refs, mirroring CREATURE_BUCKETS.
// Lets per-entity scans (INGEST, the founder scoop) query only the
// particles near a point instead of walking all of world.particles --
// the old O(cells * particles) pattern. Stores Particle refs; liveness
// is validated at query time via world.particles[p.idx] === p, so a
// swap-pop removal between build and query never surfaces a stale ref
// (the eaten particle's idx no longer maps back to it).
const PARTICLE_GRID_CELL = 32;
const PARTICLE_BUCKETS: Particle[][] = [];
let PARTICLE_NONEMPTY = new Int32Array(0);
let PARTICLE_NONEMPTY_N = 0;
let PARTICLE_GRID_COLS = 0;
let PARTICLE_GRID_ROWS = 0;

export function buildParticleGrid(world: World): void {
  const pcs = PARTICLE_GRID_CELL;
  PARTICLE_GRID_COLS = Math.max(1, Math.ceil(world.width / pcs));
  PARTICLE_GRID_ROWS = Math.max(1, Math.ceil(world.height / pcs));
  const cellCount = PARTICLE_GRID_COLS * PARTICLE_GRID_ROWS;
  while (PARTICLE_BUCKETS.length < cellCount) PARTICLE_BUCKETS.push([]);
  if (PARTICLE_NONEMPTY.length < cellCount) PARTICLE_NONEMPTY = new Int32Array(cellCount * 2);
  for (let i = 0; i < PARTICLE_NONEMPTY_N; i++) PARTICLE_BUCKETS[PARTICLE_NONEMPTY[i]].length = 0;
  PARTICLE_NONEMPTY_N = 0;
  const ps = world.particles;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    let bx = Math.floor(p.x / pcs);
    let by = Math.floor(p.y / pcs);
    if (!Number.isFinite(bx)) bx = 0;
    if (!Number.isFinite(by)) by = 0;
    if (bx < 0) bx = 0; else if (bx >= PARTICLE_GRID_COLS) bx = PARTICLE_GRID_COLS - 1;
    if (by < 0) by = 0; else if (by >= PARTICLE_GRID_ROWS) by = PARTICLE_GRID_ROWS - 1;
    const idx = by * PARTICLE_GRID_COLS + bx;
    const bucket = PARTICLE_BUCKETS[idx];
    if (bucket.length === 0) PARTICLE_NONEMPTY[PARTICLE_NONEMPTY_N++] = idx;
    bucket.push(p);
  }
}

// Visit live particles whose bin overlaps the (x, y, range) query.
// Visitor returns true to stop early. Each candidate is liveness-checked
// against world.particles so removals since the grid build are skipped;
// the visitor may itself remove particles (removeParticleAt) safely
// because the bucket arrays are not mutated by removal.
export function forParticlesNear(
  world: World, x: number, y: number, range: number,
  visitor: (p: Particle) => boolean | void,
): void {
  if (PARTICLE_GRID_COLS === 0) return;
  const pcs = PARTICLE_GRID_CELL;
  const span = Math.max(1, Math.ceil(range / pcs));
  const cx = Math.max(0, Math.min(PARTICLE_GRID_COLS - 1, Math.floor(x / pcs)));
  const cy = Math.max(0, Math.min(PARTICLE_GRID_ROWS - 1, Math.floor(y / pcs)));
  const x0 = Math.max(0, cx - span);
  const x1 = Math.min(PARTICLE_GRID_COLS - 1, cx + span);
  const y0 = Math.max(0, cy - span);
  const y1 = Math.min(PARTICLE_GRID_ROWS - 1, cy + span);
  const live = world.particles;
  for (let gy = y0; gy <= y1; gy++) {
    const row = gy * PARTICLE_GRID_COLS;
    for (let gx = x0; gx <= x1; gx++) {
      const bucket = PARTICLE_BUCKETS[row + gx];
      for (let k = 0; k < bucket.length; k++) {
        const p = bucket[k];
        if (live[p.idx] !== p) continue; // removed/eaten since the grid build
        if (visitor(p) === true) return;
      }
    }
  }
}

// Iterate creature indices that might be within `range` of (x, y). The
// visitor may return true to stop iteration early (e.g. when a predator
// finds its first valid prey). Skips buckets outside the search radius.
export function forCreaturesNear(
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
  DX: Float32Array, DY: Float32Array, DZ: Float32Array,
  DVX: Float32Array, DVY: Float32Array, DVZ: Float32Array,
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
          resolvePairSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, DX, DY, DZ, DVX, DVY, DVZ, MASS, ASLEEP, ai, cellItems[j], e);
        }
      }
      // Downstream neighbors: E, SW, S, SE. Pairs with each are
      // resolved exactly once because every cell only iterates its
      // four downstream-of-(cx,cy) neighbors. (Jacobi: which cell
      // enumerates the pair no longer affects the result.)
      checkNeighborCellSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, DX, DY, DZ, DVX, DVY, DVZ, MASS, ASLEEP, cellStart, cellItems,
        ci, cx + 1, cy,     cols, rows, e);
      checkNeighborCellSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, DX, DY, DZ, DVX, DVY, DVZ, MASS, ASLEEP, cellStart, cellItems,
        ci, cx - 1, cy + 1, cols, rows, e);
      checkNeighborCellSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, DX, DY, DZ, DVX, DVY, DVZ, MASS, ASLEEP, cellStart, cellItems,
        ci, cx,     cy + 1, cols, rows, e);
      checkNeighborCellSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, DX, DY, DZ, DVX, DVY, DVZ, MASS, ASLEEP, cellStart, cellItems,
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
export function resolveCollisions(
  world: World,
  duringPhase0?: () => void,
  duringPhase1?: () => void,
): void {
  let pendingP0 = duringPhase0;
  let pendingP1 = duringPhase1;
  const store = world.particleStore;
  const n = world.particles.length;
  // Operator toggle: when off, skip the P-P Jacobi sweep entirely.
  // The during-phase hooks (creature collisions in the serial path,
  // parallel particle dispatch in the SAB path) still fire -- they're
  // tied to step ordering, not to P-P specifically. Particle-rock and
  // particle-border collisions live in separate passes
  // (resolveObstacleCollisions / applyWalls) and remain active.
  if (n < 2 || world.particleCollisionsEnabled === false) {
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
    if (COLLISION_CELL_CURSOR.length < cellCount) {
      COLLISION_CELL_CURSOR = new Int32Array(cellCount * 2);
    } else {
      COLLISION_CELL_CURSOR.fill(0, 0, cellCount);
    }
    const cursor = COLLISION_CELL_CURSOR;
    for (let pi = 0; pi < n; pi++) {
      const ci = cellOfPart[pi];
      const slot = COLLISION_CELL_START[ci] + cursor[ci]++;
      COLLISION_CELL_ITEMS[slot] = pi;
    }

    // Jacobi: clear the per-particle delta accumulators before the
    // sweep. Workers (or the serial path) only ADD into these reading
    // the frozen PX/PVX snapshot; the summed result is applied once
    // after the sweep, so visitation order can't bias the outcome.
    COLLISION_DPX.fill(0, 0, n);
    COLLISION_DPY.fill(0, 0, n);
    COLLISION_DPZ.fill(0, 0, n);
    COLLISION_DVX.fill(0, 0, n);
    COLLISION_DVY.fill(0, 0, n);
    COLLISION_DVZ.fill(0, 0, n);

    // Cache the dispatcher locally so a barrier-timeout teardown that
    // fires from inside wait0() (e.g. mobile suspends the tab, particle
    // workers stop responding) doesn't null the module-level reference
    // mid-step and crash the second dispatcher call with
    // "Se is not a function". The cached function checks `if (!pool)`
    // at entry and returns a no-op wait fn when the pool is torn down,
    // so we still get through the rest of this iteration cleanly.
    const dispatch = collisionPhaseDispatcher;
    if (dispatch && n >= world.parallelMin) {
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
              resolvePairSoa(PX, PY, PZ, PVX, PVY, PVZ, PR,
                COLLISION_DPX, COLLISION_DPY, COLLISION_DPZ,
                COLLISION_DVX, COLLISION_DVY, COLLISION_DVZ,
                COLLISION_MASS, COLLISION_ASLEEP, ai, COLLISION_CELL_ITEMS[j], e);
            }
          }
          checkNeighborCellSoa(PX, PY, PZ, PVX, PVY, PVZ, PR,
            COLLISION_DPX, COLLISION_DPY, COLLISION_DPZ, COLLISION_DVX, COLLISION_DVY, COLLISION_DVZ,
            COLLISION_MASS, COLLISION_ASLEEP,
            COLLISION_CELL_START, COLLISION_CELL_ITEMS,
            ci, cx + 1, cy,     cols, rows, e);
          checkNeighborCellSoa(PX, PY, PZ, PVX, PVY, PVZ, PR,
            COLLISION_DPX, COLLISION_DPY, COLLISION_DPZ, COLLISION_DVX, COLLISION_DVY, COLLISION_DVZ,
            COLLISION_MASS, COLLISION_ASLEEP,
            COLLISION_CELL_START, COLLISION_CELL_ITEMS,
            ci, cx - 1, cy + 1, cols, rows, e);
          checkNeighborCellSoa(PX, PY, PZ, PVX, PVY, PVZ, PR,
            COLLISION_DPX, COLLISION_DPY, COLLISION_DPZ, COLLISION_DVX, COLLISION_DVY, COLLISION_DVZ,
            COLLISION_MASS, COLLISION_ASLEEP,
            COLLISION_CELL_START, COLLISION_CELL_ITEMS,
            ci, cx,     cy + 1, cols, rows, e);
          checkNeighborCellSoa(PX, PY, PZ, PVX, PVY, PVZ, PR,
            COLLISION_DPX, COLLISION_DPY, COLLISION_DPZ, COLLISION_DVX, COLLISION_DVY, COLLISION_DVZ,
            COLLISION_MASS, COLLISION_ASLEEP,
            COLLISION_CELL_START, COLLISION_CELL_ITEMS,
            ci, cx + 1, cy + 1, cols, rows, e);
        }
      }
    }
    // Jacobi apply: fold the summed deltas back into the live arrays
    // once, after the whole sweep (both parallel parity phases or the
    // serial pass). Next iteration rebuilds the grid from the updated
    // snapshot -> iterative Jacobi convergence over collisionIters.
    for (let i = 0; i < n; i++) {
      PX[i] += COLLISION_DPX[i]; PY[i] += COLLISION_DPY[i]; PZ[i] += COLLISION_DPZ[i];
      PVX[i] += COLLISION_DVX[i]; PVY[i] += COLLISION_DVY[i]; PVZ[i] += COLLISION_DVZ[i];
    }
  }
  // Serial path falls through with pending hooks. Run them now (after
  // particle collisions are settled, matching the original step order).
  if (pendingP0) pendingP0();
  if (pendingP1) pendingP1();
}

// Soft positional separation for overlapping creatures + symmetric
// velocity exchange like the particle-particle code, but driven off
// the per-tick CREATURE_BUCKETS grid. Without this cells walk through
// each other (only PREDATE/ENGULF cared about contact) and you can't
// see flocking, body-shielding, or crowding pressure emerge.
export function resolveCreatureCollisions(world: World): void {
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
// Hoisted visitor: forCreaturesNear took a fresh arrow per mineral
// particle (~1900 closure allocations/tick = real GC pressure). One
// reused function reading the current particle from a module slot
// keeps behaviour + iteration order bit-identical with zero allocs.
let SED_P: Particle | null = null;
function sedimentVisit(c: Creature): void {
  const p = SED_P!;
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
}
export function resolveCreatureSedimentCollisions(world: World): void {
  const ps = world.particles;
  const cs = world.creatures;
  if (cs.length === 0) return;
  for (let pi = 0; pi < ps.length; pi++) {
    const p = ps[pi];
    if (p.chemId !== CHEM_MIN) continue;
    SED_P = p;
    forCreaturesNear(p.x, p.y, p.r + 30, sedimentVisit);
  }
  SED_P = null;
}

function checkNeighborCellSoa(
  PX: Float32Array, PY: Float32Array, PZ: Float32Array,
  PVX: Float32Array, PVY: Float32Array, PVZ: Float32Array,
  PR: Float32Array,
  DX: Float32Array, DY: Float32Array, DZ: Float32Array,
  DVX: Float32Array, DVY: Float32Array, DVZ: Float32Array,
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
      resolvePairSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, DX, DY, DZ, DVX, DVY, DVZ, MASS, ASLEEP, ai, cellItems[j], e);
    }
  }
}

// Jacobi pair resolution: reads the FROZEN PX/PVX snapshot, writes the
// position/velocity correction for BOTH particles into the per-particle
// delta accumulators (DX..DVZ). Never mutates PX/PVX, so the result is
// independent of the order pairs/cells are visited (kills the
// Gauss-Seidel left-to-right directional drift). resolveCollisions
// applies the summed deltas after the sweep.
function resolvePairSoa(
  PX: Float32Array, PY: Float32Array, PZ: Float32Array,
  PVX: Float32Array, PVY: Float32Array, PVZ: Float32Array,
  PR: Float32Array,
  DX: Float32Array, DY: Float32Array, DZ: Float32Array,
  DVX: Float32Array, DVY: Float32Array, DVZ: Float32Array,
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
  DX[i] -= nxv * corrA; DY[i] -= nyv * corrA; DZ[i] -= nzv * corrA;
  DX[j] += nxv * corrB; DY[j] += nyv * corrB; DZ[j] += nzv * corrB;
  const avx = PVX[i], avy = PVY[i], avz = PVZ[i];
  const bvx = PVX[j], bvy = PVY[j], bvz = PVZ[j];
  const rvx = bvx - avx, rvy = bvy - avy, rvz = bvz - avz;
  const vN = rvx * nxv + rvy * nyv + rvz * nzv;
  if (vN >= 0) return;
  const jImp = (-(1 + e) * vN) / (1 / ma + 1 / mb);
  const ix = nxv * jImp, iy = nyv * jImp, iz = nzv * jImp;
  DVX[i] -= ix / ma; DVY[i] -= iy / ma; DVZ[i] -= iz / ma;
  DVX[j] += ix / mb; DVY[j] += iy / mb; DVZ[j] += iz / mb;
}
