// Probe: track chem46 (first generic chem) over a long run and report
// where its mass is sitting. Run for >= 10 sim min.
import { createWorld, step } from "../src/sim";
import { CHEM_BASE_DENSITY, CHEM_MOLAR_MASS } from "../src/sim";

const CHEM_ID = parseInt(process.argv[2] ?? "46", 10);
const MINUTES = Number(process.argv[3] ?? 12);
const STRIDE = CHEM_MOLAR_MASS.length;
const DT = 1 / 60;

const w = createWorld(800, 600, { delayedSpawn: true, seed: 1 }) as any;

function chemTotal(chemId: number): { ambient: number; reserve: number; particles: number; creatures: number; total: number } {
  let amb = 0, res = 0, parts = 0, crit = 0;
  const A = w.ambient as Float32Array;
  const R = w.reserve as Float32Array;
  for (let b = 0; b < A.length; b += STRIDE) {
    amb += A[b + chemId];
    res += R[b + chemId];
  }
  const ps = w.particleStore;
  const mm = CHEM_MOLAR_MASS[chemId] || 1;
  for (let i = 0; i < w.particles.length; i++) {
    if (ps.chemId[i] !== chemId) continue;
    const r = ps.r[i];
    const d = ps.density[i] || (CHEM_BASE_DENSITY[chemId] || 1);
    parts += (d * (4 / 3) * Math.PI * r * r * r) / mm;
    // Add molecule-tagged particle contributions
  }
  // Genericparticle contributions through store.genericChem (Float32Array
  // indexed by genericIdx = chemId - NAMED_CHEMICAL_COUNT).
  const NAMED = 46;
  if (chemId >= NAMED) {
    const gIdx = chemId - NAMED;
    for (let i = 0; i < w.particles.length; i++) {
      const gc = ps.genericChem[i];
      if (gc && gc.length > gIdx) parts += gc[gIdx];
    }
  }
  for (const c of w.creatures) {
    const cols = c.store.chemCols;
    if (cols && cols[chemId]) crit += cols[chemId][c.idx];
  }
  return { ambient: amb, reserve: res, particles: parts, creatures: crit, total: amb + res + parts + crit };
}

const samples: { t: number; tot: any }[] = [];
const SAMPLE_SEC = 30;
let nextSample = 0;
// Watch the particle store push events: count how many chem46 particles
// were ever pushed.
let pushedCount = 0;
const ps0 = w.particleStore;
const origPushChem = ps0.chemId;
// Hook by polling: at each tick, compare to last frame's last chemId.
// Cheap: just count chemId distribution at each sample.
const cumulativeSpawns: number[] = [];
for (let i = 0; w.t < MINUTES * 60; i++) {
  step(w, DT);
  if (w.t >= nextSample) {
    nextSample += SAMPLE_SEC;
    samples.push({ t: w.t, tot: chemTotal(CHEM_ID) });
  }
}

console.log(`chemId=${CHEM_ID} -- columns: t(s)  ambient  reserve  parts  crit  TOTAL  Δtotal`);
let prev = 0;
for (const s of samples) {
  const delta = s.tot.total - prev;
  prev = s.tot.total;
  console.log(
    `  t=${s.t.toFixed(0).padStart(5)}  ` +
    `amb=${s.tot.ambient.toFixed(2).padStart(8)}  ` +
    `res=${s.tot.reserve.toFixed(2).padStart(8)}  ` +
    `parts=${s.tot.particles.toFixed(2).padStart(8)}  ` +
    `crit=${s.tot.creatures.toFixed(2).padStart(7)}  ` +
    `TOT=${s.tot.total.toFixed(2).padStart(8)}  ` +
    `Δ=${delta.toFixed(2).padStart(8)}`,
  );
}
