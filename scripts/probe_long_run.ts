// Long-run smoke: population stability, particle-count drift, sim
// ratio, and whether greenbeard adhesion forms persistent bonded
// colonies. SECONDS is overridable via argv[2] (in sim-minutes).
//
// Run with: npx tsx scripts/probe_long_run.ts [minutes]

import { createWorld, step } from "../src/sim";

const FIXED_DT = 1 / 60;
const MINUTES = Number(process.argv[2]) || 5;
const SECONDS = MINUTES * 60;
const STEPS = Math.round(SECONDS / FIXED_DT);
const CHEM_BOND = 39;
const BOND_THRESH = 0.1;

const w = createWorld(800, 600);

// Adhesion: total bonds, distinct active markers, and the largest
// connected bonded cluster (colony size) via a component scan.
function bondStats(): { bonds: number; markers: number; maxClust: number } {
  const cs = w.creatures;
  let bonds = 0;
  const markers = new Set<number>();
  const seen = new Set<unknown>();
  let maxClust = 0;
  for (const c of cs) {
    bonds += c.bonds.length;
    if (c.bondMarker >= 0 && c.store.chemCols[CHEM_BOND][c.idx] >= BOND_THRESH) {
      markers.add(c.bondMarker);
    }
    if (seen.has(c)) continue;
    const stack = [c];
    seen.add(c);
    let size = 0;
    while (stack.length) {
      const x = stack.pop()!;
      size++;
      for (const nb of x.bonds) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
    if (size > maxClust) maxClust = size;
  }
  return { bonds: bonds / 2, markers: markers.size, maxClust };
}

const startMs = performance.now();
const samples: Array<{
  t: number; n: number; c: number; ext: number;
  bonds: number; markers: number; maxClust: number;
}> = [];
for (let s = 0; s < STEPS; s++) {
  step(w, FIXED_DT);
  if (s % (60 * 30) === 0) {
    const bs = bondStats();
    samples.push({
      t: w.t, n: w.particles.length, c: w.creatures.length,
      ext: w.extinctionCount, bonds: bs.bonds, markers: bs.markers, maxClust: bs.maxClust,
    });
  }
}
const elapsedSec = (performance.now() - startMs) / 1000;
console.log(`Ran ${STEPS} steps (${MINUTES} sim-min) in ${elapsedSec.toFixed(1)}s real. Sim ratio: ${(SECONDS / elapsedSec).toFixed(2)}x`);
console.log("   t   | particles | creatures | extinctions | bonds | markers | maxColony");
for (const s of samples) {
  console.log(
    `  ${s.t.toFixed(0).padStart(5)}s ${String(s.n).padStart(8)}     ` +
    `${String(s.c).padStart(4)}      ${String(s.ext).padStart(5)}     ${String(s.bonds).padStart(5)}   ` +
    `${String(s.markers).padStart(6)}   ${String(s.maxClust).padStart(7)}`,
  );
}
