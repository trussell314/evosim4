// Skip the first 3 sim-min (settle), baseline all chem totals, then
// run 5 min and report the largest shifts (fa called out explicitly).
// Per-chem total = cells + dissolved + reserve + particles, in amount
// (particle physical mass / molarMass). Appends to /tmp/probe_shift.txt.
// Run: npx tsx scripts/probe_shift.ts

import { createWorld, step, CHEM_BASE_DENSITY, CHEM_MOLAR_MASS, CHEM_NAMES, CHEM_IDS } from "../src/sim";
import { appendFileSync, writeFileSync } from "node:fs";

const OUT = "/tmp/probe_shift.txt";
writeFileSync(OUT, "");
const DT = 1 / 60;
const STRIDE = CHEM_MOLAR_MASS.length;
const SKIP_T = 180;     // ignore first 3 min
const RUN_T = SKIP_T + 300; // then 5 min
const FA = CHEM_IDS.fattyAcid as number;
const world = createWorld(800, 600, { delayedSpawn: true }) as any;

function totals(): Float64Array {
  const t = new Float64Array(STRIDE);
  for (const c of world.creatures) {
    const cols = c.store.chemCols;
    for (let k = 0; k < STRIDE; k++) t[k] += cols[k][c.idx];
  }
  const A = world.ambient, R = world.reserve;
  for (let b = 0; b < A.length; b += STRIDE) for (let k = 0; k < STRIDE; k++) t[k] += A[b + k] + R[b + k];
  const ps = world.particleStore;
  for (let i = 0; i < world.particles.length; i++) {
    const ci = ps.chemId[i];
    const r = ps.r[i];
    const d = ps.density[i] || (CHEM_BASE_DENSITY[ci] || 1);
    t[ci] += (d * (4 / 3) * Math.PI * r * r * r) / (CHEM_MOLAR_MASS[ci] || 1);
  }
  return t;
}

for (let s = 0; world.t < SKIP_T; s++) step(world, DT);
const base = totals();
appendFileSync(OUT, `baseline @t=${world.t.toFixed(0)} (settle skipped)\n`);
function snap(): void {
  const cur = totals();
  appendFileSync(OUT,
    `t=${world.t.toFixed(0)}  fa=${cur[FA].toFixed(0)} (Δ${(cur[FA] - base[FA]).toFixed(0)})  ` +
    `cells=${world.creatures.length} parts=${world.particles.length}\n`);
}
for (let s = 0; world.t < RUN_T; s++) {
  step(world, DT);
  if (s % (60 * 30) === 0) snap();
}
snap();

const end = totals();
const rows = [...end.keys()]
  .map((k) => ({ k, d: end[k] - base[k], b: base[k], e: end[k] }))
  .filter((r) => Math.abs(r.d) > 1)
  .sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
let out = `\n=== LARGEST SHIFTS over ${SKIP_T}->${RUN_T}s (Δ amount) ===\n`;
for (const r of rows.slice(0, 20)) {
  const pct = r.b > 1 ? ` (${(100 * r.d / r.b).toFixed(0)}%)` : "";
  out += `${(CHEM_NAMES[r.k] ?? ("c" + r.k)).padEnd(22)} ${r.b.toFixed(0).padStart(9)} -> ${r.e.toFixed(0).padStart(9)}  Δ${r.d >= 0 ? "+" : ""}${r.d.toFixed(0)}${pct}\n`;
}
out += `\nfattyAcid: ${base[FA].toFixed(0)} -> ${end[FA].toFixed(0)}  Δ${(end[FA] - base[FA]).toFixed(0)}\n`;
appendFileSync(OUT, out + "DONE\n");
console.log("done");
