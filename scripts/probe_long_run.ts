// Long-run smoke: 5 sim-minutes. Looks for population stability,
// particle count drift, pebble drift (cache-stale bug), sim ratio.
//
// Run with: npx tsx scripts/probe_long_run.ts

import { createWorld, step, MATERIAL_IDS_ORDERED } from "../src/sim";

const FIXED_DT = 1 / 60;
const SECONDS = 300;
const STEPS = Math.round(SECONDS / FIXED_DT);

const sandIdx = MATERIAL_IDS_ORDERED.indexOf("sand");
const w = createWorld(800, 600);

function pebbleCount(): number {
  let c = 0;
  const n = w.particles.length;
  for (let i = 0; i < n; i++) {
    if (w.particleStore.material[i] === sandIdx && w.particleStore.r[i] >= 8) c++;
  }
  return c;
}

const startMs = performance.now();
const samples: Array<{ t: number; n: number; p: number; c: number; ext: number }> = [];
for (let s = 0; s < STEPS; s++) {
  step(w, FIXED_DT);
  if (s % (60 * 30) === 0) {
    samples.push({ t: w.t, n: w.particles.length, p: pebbleCount(), c: w.creatures.length, ext: w.extinctionCount });
  }
}
const elapsedSec = (performance.now() - startMs) / 1000;
console.log(`Ran ${STEPS} steps in ${elapsedSec.toFixed(1)}s real-time. Sim ratio: ${(SECONDS / elapsedSec).toFixed(2)}x`);
console.log("t      | particles | pebbles | creatures | extinctions");
for (const s of samples) {
  console.log(`  ${s.t.toFixed(0).padStart(4)}s ${String(s.n).padStart(8)}    ${String(s.p).padStart(4)}    ${String(s.c).padStart(4)}    ${String(s.ext).padStart(4)}`);
}
