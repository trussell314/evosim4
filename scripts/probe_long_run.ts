// Long-run probe: population stability, particle-count drift, sim
// ratio, and whether greenbeard adhesion forms persistent bonded
// colonies WITHOUT depressing the ecosystem.
//
// Investigation mode: classifies the live population by GENOTYPE
// (does the genome carry a SYNTH BOND op) into adhesive vs plain, so
// preferential death of adhesive lineages is directly visible. Set
// adhesion prevalence per-arm with the ADH_PREV env var (0..1).
//
// Run: ADH_PREV=0.5 npx tsx scripts/probe_long_run.ts [minutes] [trials]

import { createWorld, step } from "../src/sim";
import { genomeSynthMask, SYNTH_BIT_BOND } from "../src/genome";

const FIXED_DT = 1 / 60;
const MINUTES = Number(process.argv[2]) || 5;
const TRIALS = Number(process.argv[3]) || 1;
const SECONDS = MINUTES * 60;
const STEPS = Math.round(SECONDS / FIXED_DT);
const CHEM_BOND = 39;
const BOND_THRESH = 0.1;
const ADH_PREV = process.env.ADH_PREV ?? "0.50 (default)";
const BOND_BIT = 1 << SYNTH_BIT_BOND;

type Sample = {
  t: number; n: number; c: number; adh: number; plain: number;
  ext: number; bonds: number; markers: number; maxClust: number;
};

function runTrial(trial: number): Sample[] {
  const w = createWorld(800, 600);
  const out: Sample[] = [];
  for (let s = 0; s < STEPS; s++) {
    step(w, FIXED_DT);
    if (s % (60 * 30) !== 0) continue;
    const cs = w.creatures;
    let bonds = 0, adh = 0, maxClust = 0;
    const markers = new Set<number>();
    const seen = new Set<unknown>();
    for (const c of cs) {
      bonds += c.bonds.length;
      // Genotype classification: carries a SYNTH BOND op at all.
      if ((genomeSynthMask(c.genome) & BOND_BIT) !== 0) adh++;
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
    out.push({
      t: w.t, n: w.particles.length, c: cs.length, adh, plain: cs.length - adh,
      ext: w.extinctionCount, bonds: bonds / 2, markers: markers.size, maxClust,
    });
  }
  return out;
}

const startMs = performance.now();
console.log(`ADH_PREV=${ADH_PREV}  ${MINUTES} sim-min x ${TRIALS} trial(s)`);
const finals: Sample[] = [];
for (let tr = 0; tr < TRIALS; tr++) {
  const samples = runTrial(tr);
  console.log(`\n-- trial ${tr + 1} --`);
  console.log("   t   | particles | cells | adhesive | plain | ext | bonds | markers | maxColony");
  for (const s of samples) {
    console.log(
      `  ${s.t.toFixed(0).padStart(5)}s ${String(s.n).padStart(8)}    ` +
      `${String(s.c).padStart(4)}   ${String(s.adh).padStart(6)}  ${String(s.plain).padStart(5)}  ` +
      `${String(s.ext).padStart(4)}  ${String(s.bonds).padStart(5)}   ${String(s.markers).padStart(6)}   ` +
      `${String(s.maxClust).padStart(7)}`,
    );
  }
  finals.push(samples[samples.length - 1]);
}
const elapsedSec = (performance.now() - startMs) / 1000;
const avg = (f: (s: Sample) => number) =>
  (finals.reduce((a, s) => a + f(s), 0) / finals.length).toFixed(1);
console.log(
  `\nSUMMARY ADH_PREV=${ADH_PREV} (${TRIALS} trial avg @ ${MINUTES}min): ` +
  `cells=${avg((s) => s.c)} adhesive=${avg((s) => s.adh)} plain=${avg((s) => s.plain)} ` +
  `ext=${avg((s) => s.ext)} bonds=${avg((s) => s.bonds)} maxColony=${avg((s) => s.maxClust)}`,
);
console.log(`Ran ${STEPS}x${TRIALS} steps in ${elapsedSec.toFixed(1)}s real. Sim ratio: ${(SECONDS * TRIALS / elapsedSec).toFixed(2)}x`);
