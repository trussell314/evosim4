// 10-game-minute instrumentation: thorough material accounting +
// cell-function metrics. Settle window (no 5k cap) is the first 180s;
// cap re-engages after. Appends to /tmp/probe_diss.txt.
// Run: npx tsx scripts/probe_diss.ts

import { createWorld, step, CHEM_BASE_DENSITY, CHEM_MOLAR_MASS, CHEM_NAMES } from "../src/sim";
import { appendFileSync, writeFileSync } from "node:fs";

const OUT = "/tmp/probe_diss.txt";
const DT = 1 / 60;
const RUN_T = 600;          // 10 game minutes
const SAMPLE_EVERY = 5;     // sim-seconds
const STRIDE = CHEM_MOLAR_MASS.length;
const world = createWorld(800, 600, { delayedSpawn: true }) as any;

writeFileSync(OUT,
  "t parts cells totMolar cell part amb res cat | o2d co2d atmO2 atmCO2 min | " +
  "births dMem dStrv avgE avgMem %chl\n");

const perChem = new Float64Array(STRIDE); // reused scratch

function snapshotMaterials() {
  perChem.fill(0);
  let cell = 0, cat = 0;
  for (const c of world.creatures) {
    cell += c.store.energy[c.idx];
    const cols = c.store.chemCols;
    for (let k = 0; k < STRIDE; k++) {
      const v = cols[k][c.idx]; cell += v * CHEM_MOLAR_MASS[k]; perChem[k] += v * CHEM_MOLAR_MASS[k];
    }
    const cc = c.store.catalystCols;
    for (let k = 0; k < cc.length; k++) cat += cc[k][c.idx];
  }
  let part = 0;
  const ps = world.particleStore;
  for (let i = 0; i < world.particles.length; i++) {
    const r = ps.r[i];
    const d = ps.density[i] || (CHEM_BASE_DENSITY[ps.chemId[i]] || 1);
    const m = d * (4 / 3) * Math.PI * r * r * r;
    part += m; perChem[ps.chemId[i]] += m;
  }
  let amb = 0, res = 0;
  const A = world.ambient, R = world.reserve;
  for (let b = 0; b < A.length; b += STRIDE) {
    for (let k = 0; k < STRIDE; k++) {
      const mm = CHEM_MOLAR_MASS[k];
      amb += A[b + k] * mm; res += R[b + k] * mm;
      perChem[k] += (A[b + k] + R[b + k]) * mm;
    }
  }
  let atm = 0;
  for (const key in world.atmosphere) {
    const v = world.atmosphere[key]; if (typeof v === "number") atm += v;
  }
  return { cell, part, amb, res, atm, cat, tot: cell + part + amb + res + atm + cat };
}

function cellMetrics() {
  const n = world.creatures.length;
  if (n === 0) return { avgE: 0, avgM: 0, avgMem: 0, chl: 0 };
  let e = 0, mass = 0, mem = 0, chl = 0;
  for (const c of world.creatures) {
    e += c.store.energy[c.idx];
    const cols = c.store.chemCols;
    let cm = 0; for (let k = 0; k < STRIDE; k++) cm += cols[k][c.idx];
    mass += cm;
    mem += c.molecules.membrane ?? 0;
    if ((c.molecules.chlorophyll ?? 0) > 0.01) chl++;
  }
  return { avgE: e / n, avgM: mass / n, avgMem: mem / n, chl: (100 * chl / n) };
}

function ambSum(k: number): number {
  const A = world.ambient; let s = 0;
  for (let b = 0; b < A.length; b += STRIDE) s += A[b + k];
  return s;
}
function sample() {
  const M = snapshotMaterials(); // also fills perChem
  const cm = cellMetrics();
  const s = world.stats;
  const o2d = ambSum(0), co2d = ambSum(1);
  const atmO2 = world.atmosphere.o2 ?? 0, atmCO2 = world.atmosphere.co2 ?? 0;
  appendFileSync(OUT,
    `${world.t.toFixed(0).padStart(4)} ${String(world.particles.length).padStart(5)} ` +
    `${String(world.creatures.length).padStart(4)} ${M.tot.toFixed(0).padStart(8)} ` +
    `${M.cell.toFixed(0).padStart(6)} ${M.part.toFixed(0).padStart(6)} ${M.amb.toFixed(0).padStart(6)} ` +
    `${M.res.toFixed(0).padStart(6)} ${M.cat.toFixed(0).padStart(5)} ` +
    `o2d=${o2d.toFixed(0).padStart(5)} co2d=${co2d.toFixed(0).padStart(6)} ` +
    `atmO2=${atmO2.toFixed(0).padStart(5)} atmCO2=${atmCO2.toFixed(0).padStart(6)} ` +
    `min=${perChem[5].toFixed(0).padStart(7)} ` +
    `b=${String(s.births).padStart(5)} dMem=${String(s.dMembrane).padStart(4)} ` +
    `dStrv=${String(s.dStarve).padStart(4)} ` +
    `aE=${cm.avgE.toFixed(0).padStart(4)} aMem=${cm.avgMem.toFixed(2).padStart(5)} ` +
    `%chl=${cm.chl.toFixed(0).padStart(3)}\n`);
}

let totAt180 = 0;
for (let i = 0; world.t < RUN_T; i++) {
  step(world, DT);
  if (i % (60 * SAMPLE_EVERY) === 0) sample();
  if (totAt180 === 0 && world.t >= 180) totAt180 = snapshotMaterials().tot;
}
sample();

// ---- Final analysis ----
const final = snapshotMaterials();
const order = [...perChem.keys()].sort((a, b) => perChem[b] - perChem[a]);
let lines = "\n=== PER-CHEM MOLAR (top 15) ===\n";
for (let i = 0; i < 15 && i < order.length; i++) {
  const k = order[i];
  lines += `${(CHEM_NAMES[k] ?? ("chem" + k)).padEnd(22)} ${perChem[k].toFixed(0).padStart(9)}\n`;
}
let anomalies = "";
for (let k = 0; k < STRIDE; k++) {
  if (!Number.isFinite(perChem[k])) anomalies += `  ${CHEM_NAMES[k]}: non-finite (${perChem[k]})\n`;
  if (perChem[k] < -1e-6) anomalies += `  ${CHEM_NAMES[k]}: NEGATIVE (${perChem[k].toFixed(3)})\n`;
}
const drift = totAt180 > 0 ? (100 * (final.tot - totAt180) / totAt180) : NaN;
lines += `\n=== CONSERVATION ===\n`;
lines += `total molar @t=180 (cap re-engage): ${totAt180.toFixed(0)}\n`;
lines += `total molar @t=${world.t.toFixed(0)}:              ${final.tot.toFixed(0)}\n`;
lines += `post-settle drift: ${drift.toFixed(2)}%  (expect ~0; >~1% => residual leak)\n`;
lines += `reserve @end: ${final.res.toFixed(0)} (expect >0 after cap re-engages & particles>cap)\n`;
lines += `\n=== ANOMALIES ===\n` + (anomalies || "  none (no negative / non-finite chem totals)\n");
lines += `\n=== CELL FUNCTION (cumulative) ===\n`;
lines += `births=${world.stats.births} dStarve=${world.stats.dStarve} dMembrane=${world.stats.dMembrane} ` +
  `dMrna=${world.stats.dMrna} dAa=${world.stats.dAa} dOld=${world.stats.dOld} ` +
  `extinctions=${world.extinctionCount} finalCells=${world.creatures.length}\n`;
appendFileSync(OUT, lines + "DONE\n");
console.log("done");
