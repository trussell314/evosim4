// Standalone Node bench: measure serial vs parallel applyForces over
// SAB-backed particle columns. Mirrors the runtime pattern in
// src/sim.worker.ts (Atomics-based barrier across N subworkers) but
// uses Node's worker_threads so it can run from the CLI without a
// browser. The math itself is pasted into parallelParticleWorker.mjs.

import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const FLOAT = 4;
const UINT8 = 1;
const INT32 = 4;

function allocLayout(cap) {
  const align = (n) => (n + 7) & ~7;
  const f32 = cap * FLOAT, u8 = cap * UINT8, i32 = cap * INT32;
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
  offsets.age = o; o = align(o + f32);
  offsets.material = o; o = align(o + u8);
  offsets.quietTicks = o; o = align(o + i32);
  return { offsets, total: o };
}

function seedRealistic(cap, np) {
  const { offsets, total } = allocLayout(cap);
  const buf = new SharedArrayBuffer(total);
  const PX = new Float32Array(buf, offsets.x, cap);
  const PY = new Float32Array(buf, offsets.y, cap);
  const PZ = new Float32Array(buf, offsets.z, cap);
  const PVX = new Float32Array(buf, offsets.vx, cap);
  const PVY = new Float32Array(buf, offsets.vy, cap);
  const PVZ = new Float32Array(buf, offsets.vz, cap);
  const PR = new Float32Array(buf, offsets.r, cap);
  const PDENS = new Float32Array(buf, offsets.density, cap);
  const PMAT = new Uint8Array(buf, offsets.material, cap);
  // Synthetic but force-loop-realistic: positions scattered in
  // 800x600, depth-z in [0,40], radii ~1-3, six materials.
  for (let i = 0; i < np; i++) {
    PX[i] = Math.random() * 800;
    PY[i] = Math.random() * 600;
    PZ[i] = Math.random() * 40;
    PVX[i] = (Math.random() - 0.5) * 20;
    PVY[i] = (Math.random() - 0.5) * 20;
    PVZ[i] = 0;
    PR[i] = 1 + Math.random() * 2;
    PDENS[i] = 0; // use material base
    PMAT[i] = Math.floor(Math.random() * 6);
  }
  return { buffer: buf, offsets, cap, np, PX, PY, PZ, PVX, PVY, PVZ, PR, PDENS, PMAT };
}

// Matches MATERIAL_IDS_ORDERED order in sim.ts: rock, sand, clay,
// organic, lipid, gas. Realistic densities so the buoyancy term
// produces realistic accelerations.
const MAT_BASE = new Float32Array([2.6, 1.6, 1.2, 1.05, 0.92, 0.0012]);

function makeParams(t) {
  return {
    dt: 1 / 60,
    t,
    drag: 0.2,
    gravity: 30,
    surfaceY: 80,
    surfaceDecay: 60,
    swellDecay: 120,
    updraftAmp: 6,
    currentAmp: 8,
    kS: (2 * Math.PI) / 240,
    wS: (2 * Math.PI) / 5,
    kL: (2 * Math.PI) / 700,
    wL: (2 * Math.PI) / 11,
    kU: (2 * Math.PI) / 320,
    wU: (2 * Math.PI) / 9,
    surfAmp: 6,
    swellAmp: 4,
    zAmp: 2,
    bAmp: 1,
    updraftEnv: 0.6,
    colDepth: 520,
    currentDrift: 0.3,
  };
}

// Same applyParticleForcesRange math inlined for the serial baseline.
const SPLASH_DEPTH = 30, SPLASH_GAIN = 1.5, DRAG_REF_R = 4;
function serialApply(PX, PY, PZ, PVX, PVY, PVZ, PR, PDENS, PMAT, matBase, from, to, p) {
  const dt = p.dt, t = p.t, drag = p.drag, grav = p.gravity;
  const surfaceY = p.surfaceY, surfDecay = p.surfaceDecay, swellDecay = p.swellDecay;
  const updraftAmp = p.updraftAmp, currentAmp = p.currentAmp;
  const kS = p.kS, wS = p.wS, kL = p.kL, wL = p.wL, kU = p.kU, wU = p.wU;
  const surfAmp = p.surfAmp, swellAmp = p.swellAmp, zAmp = p.zAmp, bAmp = p.bAmp;
  const updraftEnv = p.updraftEnv, colDepth = p.colDepth, currentDrift = p.currentDrift;
  for (let i = from; i < to; i++) {
    const xi = PX[i], yi = PY[i], ri = PR[i];
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
}

async function spawnWorkers(scene, nWorkers) {
  const CTRL_SLOTS = 4, PARAM_COUNT = 22;
  const ctrlBuf = new SharedArrayBuffer(CTRL_SLOTS * 4);
  const paramsBuf = new SharedArrayBuffer(PARAM_COUNT * 8);
  const ctrl = new Int32Array(ctrlBuf);
  const params = new Float64Array(paramsBuf);
  const workers = [];
  const readies = [];
  for (let i = 0; i < nWorkers; i++) {
    const w = new Worker(join(__dirname, "parallelParticleWorker.mjs"), {
      workerData: {
        buffer: scene.buffer,
        offsets: scene.offsets,
        cap: scene.cap,
        controlBuffer: ctrlBuf,
        paramsBuffer: paramsBuf,
        matBase: MAT_BASE,
        workerIndex: i,
        nWorkers,
      },
    });
    readies.push(new Promise((res) => w.once("message", res)));
    workers.push(w);
  }
  await Promise.all(readies);
  return { workers, ctrl, params, nWorkers };
}

function dispatch(pool, np, p) {
  const { ctrl, params, nWorkers } = pool;
  params[0] = p.dt; params[1] = p.t; params[2] = p.drag; params[3] = p.gravity;
  params[4] = p.surfaceY; params[5] = p.surfaceDecay; params[6] = p.swellDecay;
  params[7] = p.updraftAmp; params[8] = p.currentAmp;
  params[9] = p.kS; params[10] = p.wS; params[11] = p.kL; params[12] = p.wL;
  params[13] = p.kU; params[14] = p.wU;
  params[15] = p.surfAmp; params[16] = p.swellAmp; params[17] = p.zAmp; params[18] = p.bAmp;
  params[19] = p.updraftEnv; params[20] = p.colDepth; params[21] = p.currentDrift;
  Atomics.store(ctrl, 2 /*NP*/, np);
  Atomics.store(ctrl, 1 /*DONE*/, 0);
  const phase = (Atomics.load(ctrl, 0 /*PHASE*/) + 1) >>> 0;
  Atomics.store(ctrl, 0 /*PHASE*/, phase);
  Atomics.notify(ctrl, 0 /*PHASE*/, nWorkers);
  while (Atomics.load(ctrl, 1 /*DONE*/) < nWorkers) {
    Atomics.wait(ctrl, 1 /*DONE*/, Atomics.load(ctrl, 1 /*DONE*/));
  }
}

async function shutdown(pool) {
  // -1 phase tells workers to break the loop and exit.
  Atomics.store(pool.ctrl, 0, -1);
  Atomics.notify(pool.ctrl, 0, pool.nWorkers);
  await Promise.all(pool.workers.map((w) => w.terminate()));
}

async function bench(np, ticks, nWorkers) {
  const cap = 65536;
  const scene = seedRealistic(cap, np);
  // Warmup
  for (let i = 0; i < 30; i++) {
    serialApply(
      scene.PX, scene.PY, scene.PZ, scene.PVX, scene.PVY, scene.PVZ,
      scene.PR, scene.PDENS, scene.PMAT, MAT_BASE, 0, np, makeParams(i * 0.016),
    );
  }
  // Serial timing
  const s0 = performance.now();
  for (let i = 0; i < ticks; i++) {
    serialApply(
      scene.PX, scene.PY, scene.PZ, scene.PVX, scene.PVY, scene.PVZ,
      scene.PR, scene.PDENS, scene.PMAT, MAT_BASE, 0, np, makeParams(i * 0.016),
    );
  }
  const sMs = performance.now() - s0;

  // Reset positions (the warmup + serial moved them, but the parallel
  // run starts where serial finished; that's fine for timing).
  const pool = await spawnWorkers(scene, nWorkers);
  // Parallel warmup
  for (let i = 0; i < 30; i++) dispatch(pool, np, makeParams(i * 0.016));
  const p0 = performance.now();
  for (let i = 0; i < ticks; i++) dispatch(pool, np, makeParams(i * 0.016));
  const pMs = performance.now() - p0;
  await shutdown(pool);
  return { np, ticks, nWorkers, sMs, pMs };
}

const cores = (await import("node:os")).default.cpus().length;
const configs = [
  { np: 2000, ticks: 400, nWorkers: 2 },
  { np: 5000, ticks: 200, nWorkers: 2 },
  { np: 5000, ticks: 200, nWorkers: 4 },
  { np: 10000, ticks: 100, nWorkers: 2 },
  { np: 10000, ticks: 100, nWorkers: 4 },
];
console.log(`Node ${process.version}, ${cores} CPU cores reported`);
console.log(`np    \tticks\tworkers\tserial(ms)\tparallel(ms)\tspeedup`);
for (const c of configs) {
  const r = await bench(c.np, c.ticks, c.nWorkers);
  const speedup = r.sMs / r.pMs;
  const pad = (n, w) => String(n).padStart(w);
  console.log(
    `${pad(r.np, 6)}\t${pad(r.ticks, 5)}\t${pad(r.nWorkers, 7)}\t` +
    `${r.sMs.toFixed(1).padStart(10)}\t${r.pMs.toFixed(1).padStart(12)}\t${speedup.toFixed(2)}x`,
  );
}
