// Standalone Node bench: measure serial vs two-phase row-parity
// parallel resolveCollisions over a SAB-backed prefix-sum grid.
// Mirrors the runtime path in src/sim.ts (which delegates to the
// pool wired up in sim.worker.ts) using Node worker_threads.

import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CELL_SIZE = 12;
const FLOAT = 4;
const INT32 = 4;
const UINT8 = 1;

function allocParticles(cap) {
  const align = (n) => (n + 7) & ~7;
  const f32 = cap * FLOAT;
  const u8 = cap * UINT8;
  let o = 0;
  const offsets = {};
  offsets.x = o; o = align(o + f32);
  offsets.y = o; o = align(o + f32);
  offsets.z = o; o = align(o + f32);
  offsets.vx = o; o = align(o + f32);
  offsets.vy = o; o = align(o + f32);
  offsets.vz = o; o = align(o + f32);
  offsets.r = o; o = align(o + f32);
  offsets.density = o; o = align(o + f32);
  offsets.material = o; o = align(o + u8);
  const buf = new SharedArrayBuffer(o);
  return { buffer: buf, offsets, cap };
}

function allocCollision(maxParticles, maxCells) {
  const align = (n) => (n + 7) & ~7;
  let o = 0;
  const offsets = {};
  offsets.mass = o; o = align(o + maxParticles * FLOAT);
  offsets.asleep = o; o = align(o + maxParticles * UINT8);
  offsets.cellStart = o; o = align(o + (maxCells + 1) * INT32);
  offsets.cellItems = o; o = align(o + maxParticles * INT32);
  const buf = new SharedArrayBuffer(o);
  return { buffer: buf, offsets, maxParticles, maxCells };
}

function seed(scene, np, worldW, worldH) {
  const PX = new Float32Array(scene.buffer, scene.offsets.x, scene.cap);
  const PY = new Float32Array(scene.buffer, scene.offsets.y, scene.cap);
  const PZ = new Float32Array(scene.buffer, scene.offsets.z, scene.cap);
  const PVX = new Float32Array(scene.buffer, scene.offsets.vx, scene.cap);
  const PVY = new Float32Array(scene.buffer, scene.offsets.vy, scene.cap);
  const PVZ = new Float32Array(scene.buffer, scene.offsets.vz, scene.cap);
  const PR = new Float32Array(scene.buffer, scene.offsets.r, scene.cap);
  const PDENS = new Float32Array(scene.buffer, scene.offsets.density, scene.cap);
  for (let i = 0; i < np; i++) {
    PX[i] = Math.random() * worldW;
    PY[i] = Math.random() * worldH;
    PZ[i] = Math.random() * 40;
    PVX[i] = (Math.random() - 0.5) * 30;
    PVY[i] = (Math.random() - 0.5) * 30;
    PVZ[i] = 0;
    PR[i] = 1 + Math.random() * 2.5;
    PDENS[i] = 0.9 + Math.random() * 0.6;
  }
}

function buildGrid(scene, coll, np, cols, rows) {
  const PX = new Float32Array(scene.buffer, scene.offsets.x, scene.cap);
  const PY = new Float32Array(scene.buffer, scene.offsets.y, scene.cap);
  const PR = new Float32Array(scene.buffer, scene.offsets.r, scene.cap);
  const PDENS = new Float32Array(scene.buffer, scene.offsets.density, scene.cap);
  const MASS = new Float32Array(coll.buffer, coll.offsets.mass, coll.maxParticles);
  const ASLEEP = new Uint8Array(coll.buffer, coll.offsets.asleep, coll.maxParticles);
  const cellCount = cols * rows;
  const cellStart = new Int32Array(coll.buffer, coll.offsets.cellStart, coll.maxCells + 1);
  const cellItems = new Int32Array(coll.buffer, coll.offsets.cellItems, coll.maxParticles);
  for (let i = 0; i <= cellCount; i++) cellStart[i] = 0;
  const FOUR_THIRDS_PI = (4 / 3) * Math.PI;
  const cellOfPart = new Int32Array(np);
  for (let i = 0; i < np; i++) {
    const r = PR[i];
    MASS[i] = PDENS[i] * FOUR_THIRDS_PI * r * r * r;
    ASLEEP[i] = 0;
    let cx = Math.floor(PX[i] / CELL_SIZE);
    let cy = Math.floor(PY[i] / CELL_SIZE);
    if (cx < 0) cx = 0; else if (cx >= cols) cx = cols - 1;
    if (cy < 0) cy = 0; else if (cy >= rows) cy = rows - 1;
    const ci = cy * cols + cx;
    cellOfPart[i] = ci;
    cellStart[ci + 1]++;
  }
  for (let i = 1; i <= cellCount; i++) cellStart[i] += cellStart[i - 1];
  const cursor = new Int32Array(cellCount);
  for (let i = 0; i < np; i++) {
    const ci = cellOfPart[i];
    cellItems[cellStart[ci] + cursor[ci]++] = i;
  }
}

// Serial collision pass, same logic as resolveCollisions's fallback.
function serialCollisions(scene, coll, np, cols, rows, e) {
  const PX = new Float32Array(scene.buffer, scene.offsets.x, scene.cap);
  const PY = new Float32Array(scene.buffer, scene.offsets.y, scene.cap);
  const PZ = new Float32Array(scene.buffer, scene.offsets.z, scene.cap);
  const PVX = new Float32Array(scene.buffer, scene.offsets.vx, scene.cap);
  const PVY = new Float32Array(scene.buffer, scene.offsets.vy, scene.cap);
  const PVZ = new Float32Array(scene.buffer, scene.offsets.vz, scene.cap);
  const PR = new Float32Array(scene.buffer, scene.offsets.r, scene.cap);
  const MASS = new Float32Array(coll.buffer, coll.offsets.mass, coll.maxParticles);
  const ASLEEP = new Uint8Array(coll.buffer, coll.offsets.asleep, coll.maxParticles);
  const cellStart = new Int32Array(coll.buffer, coll.offsets.cellStart, coll.maxCells + 1);
  const cellItems = new Int32Array(coll.buffer, coll.offsets.cellItems, coll.maxParticles);
  function resolvePair(i, j) {
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
    const ma = MASS[i], mb = MASS[j];
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
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const ci = cy * cols + cx;
      const s0 = cellStart[ci], s1 = cellStart[ci + 1];
      if (s1 === s0) continue;
      for (let i = s0; i < s1; i++) {
        const ai = cellItems[i];
        for (let j = i + 1; j < s1; j++) resolvePair(ai, cellItems[j]);
      }
      const nbrs = [[cx + 1, cy], [cx - 1, cy + 1], [cx, cy + 1], [cx + 1, cy + 1]];
      for (const [nx, ny] of nbrs) {
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
        const ni = ny * cols + nx;
        const ns0 = cellStart[ni], ns1 = cellStart[ni + 1];
        if (ns1 === ns0) continue;
        for (let i = s0; i < s1; i++) {
          const ai = cellItems[i];
          for (let j = ns0; j < ns1; j++) resolvePair(ai, cellItems[j]);
        }
      }
    }
  }
}

async function spawnPool(scene, coll, nWorkers) {
  const CTRL_SLOTS = 16;
  const ctrlBuf = new SharedArrayBuffer(CTRL_SLOTS * 4);
  const ctrl = new Int32Array(ctrlBuf);
  const workers = [];
  const readies = [];
  for (let i = 0; i < nWorkers; i++) {
    const wk = new Worker(join(__dirname, "parallelCollisionWorker.mjs"), {
      workerData: {
        particleBuffer: scene.buffer,
        particleOffsets: scene.offsets,
        particleCap: scene.cap,
        collisionBuffer: coll.buffer,
        collisionOffsets: coll.offsets,
        maxParticles: coll.maxParticles,
        maxCells: coll.maxCells,
        controlBuffer: ctrlBuf,
        workerIndex: i,
        nWorkers,
      },
    });
    readies.push(new Promise((res) => wk.once("message", res)));
    workers.push(wk);
  }
  await Promise.all(readies);
  return { workers, ctrl, nWorkers };
}

function dispatch(pool, cols, rows, parity, e) {
  const { ctrl, nWorkers } = pool;
  // slots: 0=phase, 1=done, 5=cols, 6=rows, 7=parity, 8=e*1e6
  Atomics.store(ctrl, 5, cols);
  Atomics.store(ctrl, 6, rows);
  Atomics.store(ctrl, 7, parity);
  Atomics.store(ctrl, 8, Math.round(e * 1e6));
  Atomics.store(ctrl, 1, 0);
  const phase = (Atomics.load(ctrl, 0) + 1) >>> 0;
  Atomics.store(ctrl, 0, phase);
  Atomics.notify(ctrl, 0, nWorkers);
  while (Atomics.load(ctrl, 1) < nWorkers) {
    Atomics.wait(ctrl, 1, Atomics.load(ctrl, 1));
  }
}

async function shutdown(pool) {
  Atomics.store(pool.ctrl, 0, -1);
  Atomics.notify(pool.ctrl, 0, pool.nWorkers);
  await Promise.all(pool.workers.map((w) => w.terminate()));
}

async function bench(np, ticks, nWorkers, worldW, worldH) {
  const cap = 65536;
  const cols = Math.max(1, Math.ceil(worldW / CELL_SIZE));
  const rows = Math.max(1, Math.ceil(worldH / CELL_SIZE));
  const maxCells = 16384;
  const scene = allocParticles(cap);
  const coll = allocCollision(cap, maxCells);
  seed(scene, np, worldW, worldH);
  const e = 0.6;
  // Warmup builds + serial runs
  for (let i = 0; i < 30; i++) {
    buildGrid(scene, coll, np, cols, rows);
    serialCollisions(scene, coll, np, cols, rows, e);
  }
  // Serial
  const s0 = performance.now();
  for (let i = 0; i < ticks; i++) {
    buildGrid(scene, coll, np, cols, rows);
    serialCollisions(scene, coll, np, cols, rows, e);
  }
  const sMs = performance.now() - s0;
  // Parallel
  const pool = await spawnPool(scene, coll, nWorkers);
  for (let i = 0; i < 30; i++) {
    buildGrid(scene, coll, np, cols, rows);
    dispatch(pool, cols, rows, 0, e);
    dispatch(pool, cols, rows, 1, e);
  }
  const p0 = performance.now();
  for (let i = 0; i < ticks; i++) {
    buildGrid(scene, coll, np, cols, rows);
    dispatch(pool, cols, rows, 0, e);
    dispatch(pool, cols, rows, 1, e);
  }
  const pMs = performance.now() - p0;
  await shutdown(pool);
  return { np, ticks, nWorkers, sMs, pMs };
}

const cores = (await import("node:os")).default.cpus().length;
const configs = [
  { np: 2000, ticks: 300, nWorkers: 2, w: 800, h: 600 },
  { np: 5000, ticks: 200, nWorkers: 2, w: 800, h: 600 },
  { np: 5000, ticks: 200, nWorkers: 4, w: 800, h: 600 },
  { np: 10000, ticks: 100, nWorkers: 2, w: 1200, h: 900 },
  { np: 10000, ticks: 100, nWorkers: 4, w: 1200, h: 900 },
];
console.log(`Node ${process.version}, ${cores} CPU cores reported`);
console.log(`np    \tticks\tworkers\tserial(ms)\tparallel(ms)\tspeedup`);
for (const c of configs) {
  const r = await bench(c.np, c.ticks, c.nWorkers, c.w, c.h);
  const speedup = r.sMs / r.pMs;
  const pad = (n, w) => String(n).padStart(w);
  console.log(
    `${pad(r.np, 6)}\t${pad(r.ticks, 5)}\t${pad(r.nWorkers, 7)}\t` +
    `${r.sMs.toFixed(1).padStart(10)}\t${r.pMs.toFixed(1).padStart(12)}\t${speedup.toFixed(2)}x`,
  );
}
