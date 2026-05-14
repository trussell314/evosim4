// Density stratification probe: do gas/lipid/sand/etc end up where
// buoyancy + gravity say they should? Tests the "particles don't
// respect pressure/gravity" user report.
//
// Run with: npx tsx scripts/probe_density.ts

import { createWorld, step, MATERIAL_IDS_ORDERED, MATERIAL_BASE_DENSITY } from "../src/sim";

const FIXED_DT = 1 / 60;
const SECONDS = 120;
const STEPS = Math.round(SECONDS / FIXED_DT);

const w = createWorld(800, 600);
for (let s = 0; s < STEPS; s++) step(w, FIXED_DT);

const ps = w.particleStore;
const n = w.particles.length;

interface Bucket { count: number; ySum: number; yMin: number; yMax: number }
const byMat: Record<string, Bucket> = {};
for (let i = 0; i < n; i++) {
  const matId = MATERIAL_IDS_ORDERED[ps.material[i]];
  const b = (byMat[matId] ??= { count: 0, ySum: 0, yMin: Infinity, yMax: -Infinity });
  b.count++; b.ySum += ps.y[i];
  if (ps.y[i] < b.yMin) b.yMin = ps.y[i];
  if (ps.y[i] > b.yMax) b.yMax = ps.y[i];
}
console.log(`After ${SECONDS}s. n=${n}, surfaceY=${w.surfaceY}, floor=${w.height}`);
console.log(`material  | density | count |  avgY | minY | maxY`);
for (const id of Object.keys(byMat)) {
  const b = byMat[id];
  const matIdx = MATERIAL_IDS_ORDERED.indexOf(id);
  const dens = MATERIAL_BASE_DENSITY[matIdx];
  console.log(
    `  ${id.padEnd(9)} ${dens.toFixed(2).padStart(6)} ${String(b.count).padStart(5)} `
    + `${(b.ySum / b.count).toFixed(0).padStart(5)} `
    + `${b.yMin.toFixed(0).padStart(4)} ${b.yMax.toFixed(0).padStart(4)}`,
  );
}
