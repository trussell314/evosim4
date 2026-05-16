// Reserve / waste diagnostic. 150 sim-sec, production-like world.
// Appends one line per sample to /tmp/probe_diag.txt so partial
// progress is readable even if killed.
// Run: npx tsx scripts/probe_diag.ts

import { createWorld, step, CHEM_BASE_DENSITY, CHEM_IDS } from "../src/sim";
import { appendFileSync, writeFileSync } from "node:fs";

const OUT = "/tmp/probe_diag.txt";
writeFileSync(OUT, "");
const DT = 1 / 60;
const STEPS = Math.round(150 / DT);
const STRIDE = 96;
const W = CHEM_IDS.waste as number;
const volPer = (4 / 3) * Math.PI * 2 * 2 * 2;
const world = createWorld(800, 600, { delayedSpawn: true });

const fieldSum = (a: Float32Array, k: number): number => {
  let s = 0; for (let b = 0; b + k < a.length; b += STRIDE) s += a[b + k]; return s;
};
function reserveCount(k: number): number {
  const d = CHEM_BASE_DENSITY[k] > 0 ? CHEM_BASE_DENSITY[k] : 1;
  return fieldSum(world.reserve, k) / (d * volPer);
}
function line(): string {
  // generic reserve spread (chem 45..95)
  const gc: number[] = [];
  for (let k = 45; k < 96; k++) gc.push(reserveCount(k));
  gc.sort((a, b) => a - b);
  const med = gc[gc.length >> 1];
  const sum = gc.reduce((a, b) => a + b, 0);
  // total system waste mass
  let cellWaste = 0, cellMass = 0;
  for (const c of world.creatures) {
    cellWaste += c.store.chemCols[W][c.idx];
    cellWaste += 0;
  }
  let pWaste = 0, pCount = world.particles.length;
  for (let i = 0; i < pCount; i++) {
    if (world.particleStore.chemId[i] === W) {
      const r = world.particleStore.r[i];
      const d = world.particleStore.density[i] || (CHEM_BASE_DENSITY[W] || 1);
      pWaste += d * (4 / 3) * Math.PI * r * r * r;
    }
  }
  return `t=${world.t.toFixed(0).padStart(3)} parts=${String(pCount).padStart(5)} ghosts=${String(world.fadingGhosts.length).padStart(5)} cells=${String(world.creatures.length).padStart(4)} | genReserveCnt min=${gc[0].toFixed(0)} med=${med.toFixed(0)} max=${gc[gc.length - 1].toFixed(0)} sum=${sum.toFixed(0)} | wasteMass cell=${cellWaste.toFixed(0)} part=${pWaste.toFixed(0)} diss=${fieldSum(world.ambient, W).toFixed(0)} res=${fieldSum(world.reserve, W).toFixed(0)}`;
}

for (let s = 0; s < STEPS; s++) {
  step(world, DT);
  if (s % (60 * 15) === 0) appendFileSync(OUT, line() + "\n");
}
appendFileSync(OUT, line() + "\nDONE\n");
console.log("done");
