// Mass-conservation diagnostic. Short run; tracks TOTAL system mass to
// tell a reserve "trap" (bounded, plateaus) from a "leak" (reactions
// minting mass -> grows forever). Appends to /tmp/probe_diag.txt.
// Run: npx tsx scripts/probe_diag.ts

import { createWorld, step, CHEM_BASE_DENSITY, CHEM_IDS } from "../src/sim";
import { appendFileSync, writeFileSync } from "node:fs";

const OUT = "/tmp/probe_diag.txt";
writeFileSync(OUT, "");
const DT = 1 / 60;
const STEPS = Math.round(75 / DT);
const STRIDE = 96;
const W = CHEM_IDS.waste as number;
const volPer = (4 / 3) * Math.PI * 8;
const world = createWorld(800, 600, { delayedSpawn: true });

const fieldSumAll = (a: Float32Array): number => {
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s;
};
const fieldSum = (a: Float32Array, k: number): number => {
  let s = 0; for (let b = 0; b + k < a.length; b += STRIDE) s += a[b + k]; return s;
};
function totalMass(): { tot: number; cell: number; part: number; amb: number; res: number; atm: number } {
  let cell = 0;
  for (const c of world.creatures) {
    cell += c.store.energy[c.idx];
    for (let k = 0; k < STRIDE; k++) cell += c.store.chemCols[k][c.idx];
  }
  let part = 0;
  const ps = world.particleStore;
  for (let i = 0; i < world.particles.length; i++) {
    const r = ps.r[i];
    const d = ps.density[i] || (CHEM_BASE_DENSITY[ps.chemId[i]] || 1);
    part += d * (4 / 3) * Math.PI * r * r * r;
  }
  const amb = fieldSumAll(world.ambient);
  const res = fieldSumAll(world.reserve);
  let atm = 0;
  const A = world.atmosphere as Record<string, number>;
  for (const key in A) if (typeof A[key] === "number") atm += A[key];
  return { tot: cell + part + amb + res + atm, cell, part, amb, res, atm };
}
function genResSum(): number {
  let s = 0;
  for (let k = 45; k < 96; k++) {
    const d = CHEM_BASE_DENSITY[k] > 0 ? CHEM_BASE_DENSITY[k] : 1;
    s += fieldSum(world.reserve, k) / (d * volPer);
  }
  return s;
}
function line(): string {
  const m = totalMass();
  return `t=${world.t.toFixed(0).padStart(3)} TOTAL=${m.tot.toFixed(0).padStart(8)} | cell=${m.cell.toFixed(0)} part=${m.part.toFixed(0)} amb=${m.amb.toFixed(0)} res=${m.res.toFixed(0)} atm=${m.atm.toFixed(0)} | genResCnt=${genResSum().toFixed(0)} dissW=${fieldSum(world.ambient, W).toFixed(0)} cells=${world.creatures.length}`;
}

for (let s = 0; s < STEPS; s++) {
  step(world, DT);
  if (s % (60 * 10) === 0) appendFileSync(OUT, line() + "\n");
}
appendFileSync(OUT, line() + "\nDONE\n");
console.log("done");
