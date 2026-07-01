// Headless long-run: no DOM/renderer, sim only, as fast as the CPU
// allows. Logs a periodic summary and writes the save JSON so the
// result can be loaded back into the app.
//
//   npx tsx scripts/headless.ts [minutes] [sampleSec] [outPath]
//
// defaults: 60 minutes, 60s sample, /tmp/headless-save.json
// Load the result: paste the file's contents into localStorage key
// "evosim4:save" (or wire an import), then reload the app.

import { createWorld, step, serializeWorld, CHEM_BASE_DENSITY, CHEM_MOLAR_MASS, CHEM_IDS, regionCols, regionRows } from "../src/sim";
import { writeFileSync } from "node:fs";

const minutes = Number(process.argv[2] ?? 60);
const sampleSec = Number(process.argv[3] ?? 60);
const outPath = process.argv[4] ?? "/tmp/headless-save.json";
const DT = 1 / 60;
const RUN_T = minutes * 60;
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
function chlPct(): number {
  const n = w.creatures.length; if (n === 0) return 0;
  let a = 0;
  for (const c of w.creatures) if (c.store.chemCols[ID.chlorophyll][c.idx] > 0.01) a++;
  return 100 * a / n;
}
void regionCols; void regionRows;
const t0 = Date.now();
let nextSample = 0;
for (let i = 0; w.t < RUN_T; i++) {
  step(w, DT);
  if (w.t >= nextSample) {
    nextSample += sampleSec;
    const st = w.stats;
    const wall = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(
      `t=${w.t.toFixed(0).padStart(5)}s (${wall}s wall, ${(w.t / Math.max(1, (Date.now() - t0) / 1000)).toFixed(0)}x) ` +
      `cells=${String(w.creatures.length).padStart(4)} chl%=${chlPct().toFixed(0).padStart(3)} ` +
      `fa=${chemTotal(ID.fattyAcid).toFixed(0).padStart(6)} biop=${chemTotal(ID.biopolymer).toFixed(0).padStart(6)} ` +
      `co2=${chemTotal(ID.co2).toFixed(0).padStart(6)} births=${st ? st.births : 0} ` +
      `dMem=${st ? st.dMembrane : 0} dStrv=${st ? st.dStarve : 0} ext=${w.extinctionCount}`,
    );
    try { writeFileSync(outPath, serializeWorld(w)); } catch { /* ignore */ }
  }
}
try { writeFileSync(outPath, serializeWorld(w)); } catch { /* ignore */ }
console.log(`done: ${minutes} sim-min in ${((Date.now() - t0) / 1000).toFixed(0)}s wall; save -> ${outPath}`);
