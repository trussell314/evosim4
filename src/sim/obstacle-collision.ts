// Static-terrain collision: the obstacle spatial index (band + cell
// bitmap) plus the particle/creature push-out passes that keep moving
// bodies out of rock. Terrain never moves, so the index is built once
// per world (rebuildObstacleIndex) and read every tick.
//
// All state here is the obstacle index; it holds no RNG. The collision
// math reads/writes the caller's SoA arrays in place. depositRegionBase
// (ambient redirect out of rock) comes from ./regions and pointInPolygon
// from ./terrain; neither imports this module, so there is no cycle.

import type { World, Obstacle } from "./core";
import { removeParticleAt } from "./core";
import { pointInPolygon } from "./terrain";
import { depositRegionBase } from "./regions";
import { NAMED_CHEMICALS } from "./chem-ids";
import { CHEM_BASE_DENSITY, CHEM_MM } from "./chemistry";

// Static spatial index for obstacles. Terrain doesn't move, so the
// index is built once in generateObstacles and reused every tick.
// Lowest y across all obstacles -- lets the collision loops skip
// particles floating in the upper water column before any spatial
// lookup. Set by rebuildObstacleIndex.
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
// Per-cell lobe index. For each cell, CELL_LOBE_START[ci]..[ci+1] is a
// range into CELL_LOBE_DATA holding (obstacleIdx, lobeIdx) pairs for
// every lobe whose disc-with-margin touches the cell. Entries are
// sorted by (obstacleIdx ASC, lobeIdx ASC) so the hot loop processes
// obstacles and their lobes in the same order the old per-band /
// per-lobe nested loops did -- iteration order is preserved bit for
// bit so behavior (and the golden hash) stays identical, only the
// per-lobe loop shrinks from "all ~30 lobes in this obstacle" to
// "just the ~1-3 lobes covering this cell". oColl was ~22% of the
// per-tick budget per PERF_NEXT_STEPS step #1.
//
// Margin matches OBSTACLE_CELL_GRID's margin=6 so the two indexes
// agree on what "near" means -- a cell flagged by the bitmap may have
// zero, one, or several lobe entries depending on whether any lobes
// pass close enough.
let CELL_LOBE_START: Int32Array = new Int32Array(1);
let CELL_LOBE_DATA: Int32Array = new Int32Array(0);
// Stable handle to the world's obstacles array, captured during
// rebuildObstacleIndex so the bulk SoA collision (which takes raw
// typed-array slices instead of a World) can resolve obstacleIdx
// entries back to obstacle objects without an extra parameter.
let OBSTACLES_REF: ReadonlyArray<Obstacle> = [];

export function rebuildObstacleIndex(world: World): void {
  OBSTACLES_REF = world.obstacles;
  OBSTACLES_MIN_Y = Infinity;
  for (const ob of world.obstacles) {
    if (ob.minY < OBSTACLES_MIN_Y) OBSTACLES_MIN_Y = ob.minY;
  }
  const margin = 6;
  // Build the cell-level bitmap. Particle-radius margin so the
  // worst-case particle just touching an obstacle AABB still hits the
  // bitmap and reaches the per-cell lobe walk.
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
  // Build the per-cell lobe index. Two passes: count entries per cell,
  // prefix-sum to start offsets, then fill. Iterating obstacles + lobes
  // in source order keeps each cell's entries sorted by (obIdx, lobeIdx)
  // since lobes of one obstacle land in contiguous cells before the next
  // obstacle starts contributing, and lobes within an obstacle are
  // processed in lobeIdx order.
  CELL_LOBE_START = new Int32Array(cellCount + 1);
  // Pass 1: count
  for (let obIdx = 0; obIdx < world.obstacles.length; obIdx++) {
    const ob = world.obstacles[obIdx];
    const lobes = ob.lobes;
    for (let lobeIdx = 0; lobeIdx < lobes.length; lobeIdx++) {
      const l = lobes[lobeIdx];
      const x0 = Math.max(0, Math.floor((l.x - l.r - margin) / OBSTACLE_CELL_SIZE));
      const x1 = Math.min(OBSTACLE_CELL_COLS - 1, Math.floor((l.x + l.r + margin) / OBSTACLE_CELL_SIZE));
      const y0 = Math.max(0, Math.floor((l.y - l.r - margin) / OBSTACLE_CELL_SIZE));
      const y1 = Math.min(OBSTACLE_CELL_ROWS - 1, Math.floor((l.y + l.r + margin) / OBSTACLE_CELL_SIZE));
      for (let y = y0; y <= y1; y++) {
        const row = y * OBSTACLE_CELL_COLS;
        for (let x = x0; x <= x1; x++) CELL_LOBE_START[row + x + 1]++;
      }
    }
  }
  // Pass 2: prefix sum -> turn counts into start offsets
  for (let i = 1; i <= cellCount; i++) CELL_LOBE_START[i] += CELL_LOBE_START[i - 1];
  // Cursor copy so we can advance per-cell during the fill pass
  // without losing the start offsets.
  const cursor = new Int32Array(cellCount);
  for (let i = 0; i < cellCount; i++) cursor[i] = CELL_LOBE_START[i];
  CELL_LOBE_DATA = new Int32Array(CELL_LOBE_START[cellCount] * 2);
  for (let obIdx = 0; obIdx < world.obstacles.length; obIdx++) {
    const ob = world.obstacles[obIdx];
    const lobes = ob.lobes;
    for (let lobeIdx = 0; lobeIdx < lobes.length; lobeIdx++) {
      const l = lobes[lobeIdx];
      const x0 = Math.max(0, Math.floor((l.x - l.r - margin) / OBSTACLE_CELL_SIZE));
      const x1 = Math.min(OBSTACLE_CELL_COLS - 1, Math.floor((l.x + l.r + margin) / OBSTACLE_CELL_SIZE));
      const y0 = Math.max(0, Math.floor((l.y - l.r - margin) / OBSTACLE_CELL_SIZE));
      const y1 = Math.min(OBSTACLE_CELL_ROWS - 1, Math.floor((l.y + l.r + margin) / OBSTACLE_CELL_SIZE));
      for (let y = y0; y <= y1; y++) {
        const row = y * OBSTACLE_CELL_COLS;
        for (let x = x0; x <= x1; x++) {
          const ci = row + x;
          const e = cursor[ci]++;
          CELL_LOBE_DATA[e * 2] = obIdx;
          CELL_LOBE_DATA[e * 2 + 1] = lobeIdx;
        }
      }
    }
  }
}

// Rock evacuation safety net. Particle-rock collision
// (resolveObstacleCollisions / collideObstaclesSoa) is the primary
// mechanism that keeps particles out of rock -- it pushes any
// overlap back along the polygon normal with restitution. This pass
// is a strict fallback: if a particle's CENTER ended up inside a
// polygon (e.g. a wave-clamp landed it there, or a between-tick
// position update tunneled it past a thin feature), dump its mass
// into the local ambient pool and remove the particle. Creatures
// get teleported to just past the nearest edge so they keep their
// state.
//
// Mass-conserving on both paths.
export function evacuateRocks(world: World): void {
  if (world.obstacles.length === 0) return;
  const ambient = world.ambient;
  const store = world.particleStore;
  const FOUR_THIRDS_PI = (4 / 3) * Math.PI;
  // Cell-bitmap fast-reject: a single byte read skips particles in
  // cells that contain no rock at all. With margin=0 (set in
  // rebuildObstacleIndex), this rejects only the genuinely-clear
  // cells; particles within the boundary cell still go through the
  // polygon test below.
  const cellGrid = OBSTACLE_CELL_GRID;
  const cellCols = OBSTACLE_CELL_COLS;
  const cellRows = OBSTACLE_CELL_ROWS;
  const cellSize = OBSTACLE_CELL_SIZE;
  const obstacles = world.obstacles;
  // Particles. Iterate backwards because removeParticleAt swap-pops.
  for (let i = world.particles.length - 1; i >= 0; i--) {
    const px = store.x[i], py = store.y[i];
    if (cellGrid.length === 0) break; // no terrain -- nothing to do
    const cx = Math.floor(px / cellSize);
    const cy = Math.floor(py / cellSize);
    if (cx < 0 || cx >= cellCols || cy < 0 || cy >= cellRows) continue;
    if (cellGrid[cy * cellCols + cx] === 0) continue;
    // Cell flagged rocky -- run the polygon test. Only an actual
    // inside-polygon hit triggers dissolution; particles RESTING ON
    // the rock surface stay (their centers sit on the water side of
    // the edge).
    let inside = false;
    for (let k = 0; k < obstacles.length; k++) {
      const ob = obstacles[k];
      if (px < ob.minX || px > ob.maxX || py < ob.minY || py > ob.maxY) continue;
      const poly = ob.polygon;
      if (!poly) continue;
      if (pointInPolygon(px, py, poly)) { inside = true; break; }
    }
    if (!inside) continue;
    // In rock -- dissolve. Mass to the nearest WATER region (not the
    // rock region, where the no-flux barrier would trap it forever).
    const base = depositRegionBase(world, px, py);
    const mol = store.molecules[i];
    if (mol) {
      for (let k = 0; k < NAMED_CHEMICALS.length; k++) {
        const v = mol[NAMED_CHEMICALS[k]];
        if (v > 0) ambient[base + k] += v;
      }
    } else {
      const r = store.r[i];
      const chemId = store.chemId[i];
      const density = store.density[i] !== 0 ? store.density[i] : CHEM_BASE_DENSITY[chemId];
      // ambient stores AMOUNT (moles), particle holds PHYSICAL MASS.
      // Convert mass -> moles via molar mass on the way in. Skipping the
      // conversion meant every evacuation cycle inflated ambient by a
      // factor of molarMass; combined with precipitate re-spawning
      // particles that the next evacuator pass could re-ingest, this
      // was an autocatalytic mass source for any chem with molarMass != 1
      // (i.e. every generic chem).
      const mass = density * FOUR_THIRDS_PI * r * r * r;
      const mm = CHEM_MM[chemId] || 1;
      ambient[base + chemId] += mass / mm;
    }
    removeParticleAt(world, i);
  }
  // Creatures. Polygon-based push: find nearest edge point, teleport
  // to a safe distance past it.
  for (const c of world.creatures) {
    const cx = c.x, cy = c.y;
    if (cellGrid.length > 0) {
      const ccx = Math.floor(cx / cellSize);
      const ccy = Math.floor(cy / cellSize);
      if (ccx < 0 || ccx >= cellCols || ccy < 0 || ccy >= cellRows) continue;
      if (cellGrid[ccy * cellCols + ccx] === 0) continue;
    }
    let insideOb: Obstacle | null = null;
    for (const ob of world.obstacles) {
      if (!ob.polygon) continue;
      if (cx < ob.minX || cx > ob.maxX || cy < ob.minY || cy > ob.maxY) continue;
      if (pointInPolygon(cx, cy, ob.polygon)) { insideOb = ob; break; }
    }
    if (!insideOb) continue;
    const np = nearestPolygonEdgePoint(cx, cy, insideOb.polygon!);
    const dx = np.x - cx, dy = np.y - cy;
    const d = Math.hypot(dx, dy);
    if (d > 1e-6) {
      // Direction from inside-point to the edge IS the outward
      // direction; teleport `margin` past the edge along it.
      const margin = c.r + 2;
      const ux = dx / d, uy = dy / d;
      c.x = np.x + ux * margin;
      c.y = np.y + uy * margin;
      // Kill any inward velocity that would push the creature right
      // back into the rock on the next physics tick.
      const vDotU = c.vx * ux + c.vy * uy;
      if (vDotU > 0) {
        c.vx -= vDotU * ux;
        c.vy -= vDotU * uy;
      }
    }
  }
}

// Closest point on a polygon's boundary to (qx, qy). Walks every
// edge and projects the query onto each segment; returns the
// projection nearest in Euclidean distance.
function nearestPolygonEdgePoint(
  qx: number, qy: number, poly: { x: number; y: number }[],
): { x: number; y: number } {
  let bestX = poly[0].x, bestY = poly[0].y, bestD = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j].x, ay = poly[j].y;
    const bx = poly[i].x, by = poly[i].y;
    const ex = bx - ax, ey = by - ay;
    const lenSq = ex * ex + ey * ey;
    let t = 0;
    if (lenSq > 1e-12) {
      t = ((qx - ax) * ex + (qy - ay) * ey) / lenSq;
      if (t < 0) t = 0; else if (t > 1) t = 1;
    }
    const px = ax + ex * t, py = ay + ey * t;
    const dx = px - qx, dy = py - qy;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; bestX = px; bestY = py; }
  }
  return { x: bestX, y: bestY };
}

export function resolveObstacleCollisions(world: World, asleep: Uint8Array): void {
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
  // The asleep flags are populated by resolveCollisions which runs
  // earlier in step().
  collideObstaclesSoa(ps.x, ps.y, ps.vx, ps.vy, ps.r, asleep, pn, world.restitution, minY, 0);
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
  if (OBSTACLES_REF.length === 0) return;
  const rk = R[idx];
  if (Y[idx] + rk < minY) return;
  const xk = X[idx], yk = Y[idx];
  if (xk !== xk || yk !== yk || rk !== rk) return;
  const cellSize = OBSTACLE_CELL_SIZE;
  const cellCols = OBSTACLE_CELL_COLS;
  const cellRows = OBSTACLE_CELL_ROWS;
  let gcx = (xk / cellSize) | 0;
  let gcy = (yk / cellSize) | 0;
  if (gcx < 0) gcx = 0; else if (gcx >= cellCols) gcx = cellCols - 1;
  if (gcy < 0) gcy = 0; else if (gcy >= cellRows) gcy = cellRows - 1;
  const ci = gcy * cellCols + gcx;
  if (!OBSTACLE_CELL_GRID[ci]) return;
  const obstacles = OBSTACLES_REF;
  if (obstacles.length === 0) return;
  processObstaclesAtCell(ci, xk, yk, VX[idx], VY[idx], rk, obstacles, e);
  X[idx] = _OB_SCRATCH[0]; Y[idx] = _OB_SCRATCH[1];
  VX[idx] = _OB_SCRATCH[2]; VY[idx] = _OB_SCRATCH[3];
}

// Scratch holder for the per-cell collision helper. Module-level
// so the helper can return four floats without per-call allocation.
const _OB_SCRATCH = new Float32Array(4);

// Process all lobe entries indexed by cell `ci` against a single
// moving body at (ox, oy, rk) with velocity (ovx, ovy). Writes the
// post-collision state into _OB_SCRATCH[0..3] = [ox, oy, ovx, ovy].
// Iteration order is sorted by (obstacleIdx ASC, lobeIdx ASC) -- the
// same order the old per-band / per-lobe nested loops produced, so
// the resolve sequence (and golden hash) is preserved bit-for-bit.
// `obstacles` is hoisted by the caller to avoid the world lookup per
// entry. `restitution` is the bounce coefficient.
function processObstaclesAtCell(
  ci: number,
  ox: number, oy: number, ovx: number, ovy: number, rk: number,
  obstacles: ReadonlyArray<Obstacle>, restitution: number,
): void {
  const start = CELL_LOBE_START[ci];
  const end = CELL_LOBE_START[ci + 1];
  if (start === end) {
    _OB_SCRATCH[0] = ox; _OB_SCRATCH[1] = oy;
    _OB_SCRATCH[2] = ovx; _OB_SCRATCH[3] = ovy;
    return;
  }
  // lastOb tracks the obstacle we're currently iterating lobes for.
  // lastObSkip caches "skip remaining lobes of this obstacle" -- set
  // when AABB rejects the obstacle outright OR when its polygon has
  // already resolved against this body (subsequent lobes from the
  // same obstacle add no information). Reset whenever obIdx changes.
  let lastOb = -1;
  let lastObSkip = false;
  let lastObPoly: { x: number; y: number }[] | undefined;
  for (let pos = start; pos < end; pos++) {
    const obIdx = CELL_LOBE_DATA[pos * 2];
    if (obIdx !== lastOb) {
      lastOb = obIdx;
      lastObSkip = false;
      const ob = obstacles[obIdx];
      // Re-check AABB now that ox/oy may have moved from prior
      // obstacle pushbacks. This is the same cheap reject the old
      // per-band outer loop did.
      if (ox + rk < ob.minX || ox - rk > ob.maxX
          || oy + rk < ob.minY || oy - rk > ob.maxY) {
        lastObSkip = true;
        continue;
      }
      lastObPoly = ob.polygon;
    } else if (lastObSkip) {
      continue;
    }
    const ob = obstacles[obIdx];
    const lobe = ob.lobes[CELL_LOBE_DATA[pos * 2 + 1]];
    if (lastObPoly !== undefined) {
      // Polygon-edge resolve. Lobe fast-reject first.
      const dx = ox - lobe.x;
      const dy = oy - lobe.y;
      const minDist = rk + lobe.r;
      if (dx * dx + dy * dy >= minDist * minDist) continue;
      // Walk polygon edges: nearest point + horizontal-ray crossings
      // for inside/outside in one pass.
      const poly = lastObPoly;
      let bestX = 0, bestY = 0, bestD2 = Infinity;
      let crossings = 0;
      const PL = poly.length;
      for (let jj = PL - 1, j2 = 0; j2 < PL; jj = j2++) {
        const ax = poly[jj].x, ay = poly[jj].y;
        const bxp = poly[j2].x, byp = poly[j2].y;
        const ex = bxp - ax, ey = byp - ay;
        const lenSq = ex * ex + ey * ey;
        let t = 0;
        if (lenSq > 1e-12) {
          t = ((ox - ax) * ex + (oy - ay) * ey) / lenSq;
          if (t < 0) t = 0; else if (t > 1) t = 1;
        }
        const epx = ax + ex * t, epy = ay + ey * t;
        const ddx = epx - ox, ddy = epy - oy;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 < bestD2) { bestD2 = d2; bestX = epx; bestY = epy; }
        if ((ay > oy) !== (byp > oy)) {
          const xInt = (bxp - ax) * (oy - ay) / (byp - ay + 1e-12) + ax;
          if (ox < xInt) crossings++;
        }
      }
      const isInside = (crossings & 1) === 1;
      const d = Math.sqrt(bestD2);
      if (!isInside && d >= rk) {
        // Lobe near but polygon edge isn't yet -- mark obstacle done
        // so other lobes of this same obstacle don't re-walk it
        // (the polygon-walk verdict applies to the whole obstacle).
        lastObSkip = true;
        continue;
      }
      let nx, ny, depth;
      if (d < 1e-6) { nx = 1; ny = 0; depth = isInside ? rk : 0; }
      else if (isInside) {
        nx = (bestX - ox) / d;
        ny = (bestY - oy) / d;
        depth = rk + d;
      } else {
        nx = (ox - bestX) / d;
        ny = (oy - bestY) / d;
        depth = rk - d;
      }
      ox += nx * depth;
      oy += ny * depth;
      const vN = ovx * nx + ovy * ny;
      if (vN < 0) {
        ovx -= (1 + restitution) * vN * nx;
        ovy -= (1 + restitution) * vN * ny;
      }
      // Polygon resolved for this obstacle -- skip its remaining lobes.
      lastObSkip = true;
    } else {
      // No polygon: per-lobe pushback (each lobe contributes
      // independently, matching the old fallback branch).
      const dx = ox - lobe.x;
      const dy = oy - lobe.y;
      const minDist = rk + lobe.r;
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
        ovx -= (1 + restitution) * vN * nx;
        ovy -= (1 + restitution) * vN * ny;
      }
    }
  }
  _OB_SCRATCH[0] = ox; _OB_SCRATCH[1] = oy;
  _OB_SCRATCH[2] = ovx; _OB_SCRATCH[3] = ovy;
}

// Contiguous-index version: used for particles where slot i corresponds
// to world.particles[i]. No indirection.
function collideObstaclesSoa(
  X: Float32Array, Y: Float32Array, VX: Float32Array, VY: Float32Array, R: Float32Array,
  ASLEEP: Uint8Array,
  n: number, e: number, minY: number, _pad: number,
): void {
  void _pad;
  void ASLEEP;
  // Defensive: if the obstacle index wasn't built (cols=0) the per-
  // particle clamp below would land at -1 and throw on undefined.
  if (OBSTACLES_REF.length === 0) return;
  const cellSize = OBSTACLE_CELL_SIZE;
  const cellCols = OBSTACLE_CELL_COLS;
  const cellRows = OBSTACLE_CELL_ROWS;
  const obstacles = OBSTACLES_REF;
  if (obstacles.length === 0) return;
  // ASLEEP used to gate this loop, on the assumption that an
  // asleep particle = a frozen particle. That held when the only
  // floor was a particle-pebble bed: pebbles slept at the world
  // floor and the force loop genuinely zeroed their velocity. With
  // the procedural rock terrain, "asleep" still gets set for any
  // particle moving below SLEEP_SPEED_SQ -- including particles
  // resting on top of seafloor rock -- but the force loop only
  // freezes particles touching the world floor (y + r >= floorY).
  // Asleep particles on a rock surface still get buoyancy + brownian
  // applied, accumulate a slow drift, and tunnel into the rock since
  // this loop never runs for them. Drop the ASLEEP skip; the
  // OBSTACLE_CELL_GRID early-reject below is the real fast path.
  for (let k = 0; k < n; k++) {
    const yk = Y[k]; const rk = R[k];
    if (yk + rk < minY) continue;
    const xk = X[k];
    // NaN in any of the coordinate / radius reads would propagate
    // through Math.floor and bypass both clamp branches (every NaN
    // comparison is false). Skip and let upstream code recover.
    if (xk !== xk || yk !== yk || rk !== rk) continue;
    // Cell-bitmap early exit: a single byte read rejects particles in
    // obstacle-free cells before the per-cell lobe walk.
    let gcx = (xk / cellSize) | 0;
    let gcy = (yk / cellSize) | 0;
    if (gcx < 0) gcx = 0; else if (gcx >= cellCols) gcx = cellCols - 1;
    if (gcy < 0) gcy = 0; else if (gcy >= cellRows) gcy = cellRows - 1;
    const ci = gcy * cellCols + gcx;
    if (!OBSTACLE_CELL_GRID[ci]) continue;
    processObstaclesAtCell(ci, xk, yk, VX[k], VY[k], rk, obstacles, e);
    X[k] = _OB_SCRATCH[0]; Y[k] = _OB_SCRATCH[1];
    VX[k] = _OB_SCRATCH[2]; VY[k] = _OB_SCRATCH[3];
  }
}
