// Probe: track chem46 every tick for 30 sim sec, identify what
// makes it appear. Phase-instrumented (snapshot before & after each
// known mass-touching call would be ideal, but for now just per-tick).
import { createWorld, step } from "../src/sim";
import { CHEM_MOLAR_MASS, NAMED_CHEMICAL_COUNT } from "../src/sim";

const CHEM_ID = parseInt(process.argv[2] ?? "46", 10);
const SECONDS = Number(process.argv[3] ?? 30);
const STRIDE = CHEM_MOLAR_MASS.length;
const DT = 1 / 60;

const w = createWorld(800, 600, { delayedSpawn: true, seed: 1 }) as any;

function fieldTotal(): number {
  let s = 0;
  const A = w.ambient as Float32Array, R = w.reserve as Float32Array;
  for (let b = 0; b < A.length; b += STRIDE) s += A[b + CHEM_ID] + R[b + CHEM_ID];
  return s;
}
function particleTotal(): number {
  let s = 0;
  const ps = w.particleStore;
  const mm = CHEM_MOLAR_MASS[CHEM_ID] || 1;
  for (let i = 0; i < w.particles.length; i++) {
    if (ps.chemId[i] === CHEM_ID) {
      const r = ps.r[i];
      const d = ps.density[i] || 1;
      s += (d * (4 / 3) * Math.PI * r * r * r) / mm;
    }
    const gc = ps.genericChem[i];
    if (gc && CHEM_ID >= NAMED_CHEMICAL_COUNT) {
      const idx = CHEM_ID - NAMED_CHEMICAL_COUNT;
      if (gc.length > idx) s += gc[idx];
    }
  }
  return s;
}
function particleCount(): number {
  let c = 0;
  const ps = w.particleStore;
  for (let i = 0; i < w.particles.length; i++) if (ps.chemId[i] === CHEM_ID) c++;
  return c;
}

let lastTotal = 0;
let lastReserve = 0;
const TOTAL_TICKS = SECONDS * 60;
for (let i = 0; i < TOTAL_TICKS; i++) {
  step(w, DT);
  if (i % 30 === 0 || i < 10) {
    const f = fieldTotal();
    let res = 0;
    const R = w.reserve as Float32Array;
    for (let b = 0; b < R.length; b += STRIDE) res += R[b + CHEM_ID];
    const p = particleTotal();
    const pc = particleCount();
    const tot = f + p;
    const delta = tot - lastTotal;
    const nCells = w.creatures.length;
    const nParticles = w.particles.length;
    console.log(
      `tick=${i.toString().padStart(4)} t=${w.t.toFixed(2)}  ` +
      `field=${f.toFixed(1).padStart(10)} (res=${res.toFixed(0).padStart(8)}) ` +
      `parts=${p.toFixed(1).padStart(7)} (n=${pc.toString().padStart(4)})  ` +
      `TOT=${tot.toFixed(1).padStart(10)}  Δ=${delta.toFixed(2).padStart(8)}  ` +
      `cells=${nCells} nparts=${nParticles}`,
    );
    lastTotal = tot;
    lastReserve = res;
  }
}
void lastReserve;
