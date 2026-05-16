// Decisive leak test: amount-sum vs molar-sum (amount*molarMass).
// If molar is conserved while amount/physical explode -> the leak is
// the amount<->physical-mass boundary ignoring molarMass.
// Run: npx tsx scripts/probe_diag.ts

import { createWorld, step, CHEM_BASE_DENSITY, CHEM_MOLAR_MASS } from "../src/sim";
import { appendFileSync, writeFileSync } from "node:fs";

const OUT = "/tmp/probe_diag.txt";
writeFileSync(OUT, "");
const DT = 1 / 60;
const STEPS = Math.round(40 / DT);
const STRIDE = 96;
const world = createWorld(800, 600, { delayedSpawn: true });

function totals(): { amt: number; molar: number; resAmt: number } {
  let amt = 0, molar = 0;
  for (const c of world.creatures) {
    amt += c.store.energy[c.idx];
    molar += c.store.energy[c.idx];
    for (let k = 0; k < STRIDE; k++) {
      const v = c.store.chemCols[k][c.idx];
      amt += v; molar += v * CHEM_MOLAR_MASS[k];
    }
  }
  const ps = world.particleStore;
  for (let i = 0; i < world.particles.length; i++) {
    const r = ps.r[i];
    const d = ps.density[i] || (CHEM_BASE_DENSITY[ps.chemId[i]] || 1);
    amt += d * (4 / 3) * Math.PI * r * r * r; // physical mass
    molar += d * (4 / 3) * Math.PI * r * r * r;
  }
  let resAmt = 0;
  for (let b = 0; b < world.ambient.length; b += STRIDE) {
    for (let k = 0; k < STRIDE; k++) {
      amt += world.ambient[b + k]; molar += world.ambient[b + k] * CHEM_MOLAR_MASS[k];
      const rv = world.reserve[b + k];
      amt += rv; molar += rv * CHEM_MOLAR_MASS[k]; resAmt += rv;
    }
  }
  return { amt, molar, resAmt };
}

for (let s = 0; s < STEPS; s++) {
  step(world, DT);
  if (s % (60 * 5) === 0) {
    const t = totals();
    appendFileSync(OUT, `t=${world.t.toFixed(0).padStart(2)} amount=${t.amt.toFixed(0).padStart(8)} molar=${t.molar.toFixed(0).padStart(8)} resAmt=${t.resAmt.toFixed(0).padStart(8)} cells=${world.creatures.length}\n`);
  }
}
const t = totals();
appendFileSync(OUT, `t=${world.t.toFixed(0)} amount=${t.amt.toFixed(0)} molar=${t.molar.toFixed(0)} resAmt=${t.resAmt.toFixed(0)} cells=${world.creatures.length}\nDONE\n`);
console.log("done");
