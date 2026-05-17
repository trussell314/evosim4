// 10-min observation run: does the new founder seed + glu->biopolymer
// let autotrophs establish and the food loop hold? Tracks %chl, the
// food chems, gases, population, and total (ATP-inclusive) mass.
// Appends to /tmp/probe_obs.txt. Run: npx tsx scripts/probe_obs.ts

import { createWorld, step, CHEM_BASE_DENSITY, CHEM_MOLAR_MASS, CHEM_IDS, regionCols, regionRows } from "../src/sim";
import { appendFileSync, writeFileSync } from "node:fs";

const OUT = "/tmp/probe_obs.txt";
writeFileSync(OUT, "t    cells chl% fa     biop   glu    o2    co2    dO2  births dMem dStrv  totMass\n");
const DT = 1 / 60;
const RUN_T = 600;
const STRIDE = CHEM_MOLAR_MASS.length;
const ID = CHEM_IDS as Record<string, number>;
const w = createWorld(800, 600, { delayedSpawn: true }) as any;

function chemTotal(k: number): number {
  let s = 0;
  for (const c of w.creatures) s += c.store.chemCols[k][c.idx];
  const A = w.ambient, R = w.reserve;
  for (let b = 0; b < A.length; b += STRIDE) s += A[b + k] + R[b + k];
  const ps = w.particleStore;
  for (let i = 0; i < w.particles.length; i++) {
    if (ps.chemId[i] !== k) continue;
    const r = ps.r[i];
    const d = ps.density[i] || (CHEM_BASE_DENSITY[k] || 1);
    s += (d * (4 / 3) * Math.PI * r * r * r) / (CHEM_MOLAR_MASS[k] || 1);
  }
  return s;
}
function ambTotal(k: number): number {
  const A = w.ambient; let s = 0;
  for (let b = 0; b < A.length; b += STRIDE) s += A[b + k];
  return s;
}
function totalMass(): number {
  // ATP is matter now: include energy.
  let s = 0;
  for (const c of w.creatures) {
    s += c.store.energy[c.idx];
    const cols = c.store.chemCols;
    for (let k = 0; k < STRIDE; k++) s += cols[k][c.idx] * CHEM_MOLAR_MASS[k];
    const cc = c.store.catalystCols;
    for (let k = 0; k < cc.length; k++) s += cc[k][c.idx];
  }
  const ps = w.particleStore;
  for (let i = 0; i < w.particles.length; i++) {
    const r = ps.r[i];
    const d = ps.density[i] || (CHEM_BASE_DENSITY[ps.chemId[i]] || 1);
    s += d * (4 / 3) * Math.PI * r * r * r;
  }
  const A = w.ambient, R = w.reserve;
  for (let b = 0; b < A.length; b += STRIDE) for (let k = 0; k < STRIDE; k++) s += (A[b + k] + R[b + k]) * CHEM_MOLAR_MASS[k];
  for (const key in w.atmosphere) { const v = w.atmosphere[key]; if (typeof v === "number") s += v; }
  return s;
}
function chlPct(): number {
  const n = w.creatures.length; if (n === 0) return 0;
  let a = 0;
  for (const c of w.creatures) if (c.store.chemCols[ID.chlorophyll][c.idx] > 0.01) a++;
  return 100 * a / n;
}
function sample(): void {
  const st = w.stats;
  appendFileSync(OUT,
    `${w.t.toFixed(0).padStart(4)} ${String(w.creatures.length).padStart(5)} ` +
    `${chlPct().toFixed(0).padStart(3)} ` +
    `${chemTotal(ID.fattyAcid).toFixed(0).padStart(6)} ${chemTotal(ID.biopolymer).toFixed(0).padStart(6)} ` +
    `${chemTotal(ID.glucose).toFixed(0).padStart(6)} ${chemTotal(ID.o2).toFixed(0).padStart(5)} ` +
    `${chemTotal(ID.co2).toFixed(0).padStart(6)} ${ambTotal(ID.o2).toFixed(0).padStart(4)} ` +
    `${String(st.births).padStart(6)} ${String(st.dMembrane).padStart(4)} ${String(st.dStarve).padStart(5)} ` +
    `${totalMass().toFixed(0).padStart(9)}\n`);
}
for (let i = 0; w.t < RUN_T; i++) {
  step(w, DT);
  if (i % (60 * 30) === 0) sample();
}
sample();
appendFileSync(OUT, "DONE\n");
console.log("done");
