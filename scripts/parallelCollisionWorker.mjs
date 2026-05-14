// Node worker_threads worker for the parallel-collision benchmark.
// Mirrors src/particle.worker.ts's CMD_COLLISIONS path but lives in
// its own Node ESM file (no TS loader required).
//
// Inlines applyCollisionsRowRange + resolvePairSoa + checkNeighborCellSoa.
// If sim.ts diverges, bring these copies up to date.
import { parentPort, workerData } from "node:worker_threads";

const CTRL_PHASE = 0;
const CTRL_DONE = 1;
const CTRL_C_COLS = 5;
const CTRL_C_ROWS = 6;
const CTRL_C_PARITY = 7;
const CTRL_C_E = 8;

function resolvePairSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, MASS, ASLEEP, i, j, e) {
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

function applyCollisionsRowRange(
  PX, PY, PZ, PVX, PVY, PVZ, PR, MASS, ASLEEP,
  cellStart, cellItems, rowStart, rowStep, cols, rows, e,
) {
  for (let cy = rowStart; cy < rows; cy += rowStep) {
    for (let cx = 0; cx < cols; cx++) {
      const ci = cy * cols + cx;
      const s0 = cellStart[ci];
      const s1 = cellStart[ci + 1];
      if (s1 === s0) continue;
      for (let i = s0; i < s1; i++) {
        const ai = cellItems[i];
        for (let j = i + 1; j < s1; j++) {
          resolvePairSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, MASS, ASLEEP, ai, cellItems[j], e);
        }
      }
      // Downstream neighbors: E, SW, S, SE.
      const nbrs = [
        [cx + 1, cy],
        [cx - 1, cy + 1],
        [cx,     cy + 1],
        [cx + 1, cy + 1],
      ];
      for (const [nx, ny] of nbrs) {
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
        const ni = ny * cols + nx;
        const ns0 = cellStart[ni], ns1 = cellStart[ni + 1];
        if (ns1 === ns0) continue;
        for (let i = s0; i < s1; i++) {
          const ai = cellItems[i];
          for (let j = ns0; j < ns1; j++) {
            resolvePairSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, MASS, ASLEEP, ai, cellItems[j], e);
          }
        }
      }
    }
  }
}

const { particleBuffer, particleOffsets, particleCap,
        collisionBuffer, collisionOffsets, maxParticles, maxCells,
        controlBuffer, workerIndex, nWorkers } = workerData;
const ctrl = new Int32Array(controlBuffer);
const PX = new Float32Array(particleBuffer, particleOffsets.x, particleCap);
const PY = new Float32Array(particleBuffer, particleOffsets.y, particleCap);
const PZ = new Float32Array(particleBuffer, particleOffsets.z, particleCap);
const PVX = new Float32Array(particleBuffer, particleOffsets.vx, particleCap);
const PVY = new Float32Array(particleBuffer, particleOffsets.vy, particleCap);
const PVZ = new Float32Array(particleBuffer, particleOffsets.vz, particleCap);
const PR = new Float32Array(particleBuffer, particleOffsets.r, particleCap);
const MASS = new Float32Array(collisionBuffer, collisionOffsets.mass, maxParticles);
const ASLEEP = new Uint8Array(collisionBuffer, collisionOffsets.asleep, maxParticles);
const cellStart = new Int32Array(collisionBuffer, collisionOffsets.cellStart, maxCells + 1);
const cellItems = new Int32Array(collisionBuffer, collisionOffsets.cellItems, maxParticles);

parentPort.postMessage({ type: "ready" });
let lastPhase = 0;
while (true) {
  Atomics.wait(ctrl, CTRL_PHASE, lastPhase);
  const phase = Atomics.load(ctrl, CTRL_PHASE);
  if (phase < 0) break;
  lastPhase = phase;
  const cols = Atomics.load(ctrl, CTRL_C_COLS);
  const rows = Atomics.load(ctrl, CTRL_C_ROWS);
  const parity = Atomics.load(ctrl, CTRL_C_PARITY);
  const e = Atomics.load(ctrl, CTRL_C_E) / 1e6;
  const rowStart = parity + 2 * workerIndex;
  const rowStep = 2 * nWorkers;
  applyCollisionsRowRange(
    PX, PY, PZ, PVX, PVY, PVZ, PR, MASS, ASLEEP,
    cellStart, cellItems, rowStart, rowStep, cols, rows, e,
  );
  Atomics.add(ctrl, CTRL_DONE, 1);
  Atomics.notify(ctrl, CTRL_DONE);
}
