// Probe: track chem46 mass before/after each sub-pass of step(). To do
// that without monkey-patching step, we duplicate the phase ordering
// and call each sub-pass manually.
import {
  createWorld, step,
  CHEM_MOLAR_MASS, NAMED_CHEMICAL_COUNT,
} from "../src/sim";

const CHEM_ID = 46;
const STRIDE = CHEM_MOLAR_MASS.length;
const DT = 1 / 60;
const MM = CHEM_MOLAR_MASS[CHEM_ID] || 1;

const w = createWorld(800, 600, { delayedSpawn: true, seed: 1 }) as any;

function fieldTotal(): number {
  let s = 0;
  const A = w.ambient as Float32Array, R = w.reserve as Float32Array;
  for (let b = 0; b < A.length; b += STRIDE) s += A[b + CHEM_ID] + R[b + CHEM_ID];
  return s;
}
function partsTotal(): number {
  let s = 0;
  const ps = w.particleStore;
  for (let i = 0; i < w.particles.length; i++) {
    if (ps.chemId[i] === CHEM_ID) {
      const r = ps.r[i];
      const d = ps.density[i] || 1;
      s += (d * (4 / 3) * Math.PI * r * r * r) / MM;
    }
    const gc = ps.genericChem[i];
    if (gc && CHEM_ID >= NAMED_CHEMICAL_COUNT) {
      const idx = CHEM_ID - NAMED_CHEMICAL_COUNT;
      if (gc.length > idx) s += gc[idx];
    }
  }
  return s;
}
function critTotal(): number {
  let s = 0;
  for (const c of w.creatures) {
    const cols = c.store.chemCols;
    if (cols && cols[CHEM_ID]) s += cols[CHEM_ID][c.idx];
  }
  return s;
}
function total(): number { return fieldTotal() + partsTotal() + critTotal(); }

// Run for 600 ticks (10s), checking mass change per tick. When delta is
// big, dump the ambient totals to find which region.
let prev = total();
let bigDeltaCount = 0;
for (let i = 0; i < 60 * 60; i++) {
  step(w, DT);
  const t = total();
  const d = t - prev;
  if (Math.abs(d) > 1) {
    bigDeltaCount++;
    if (bigDeltaCount < 30 || i % 60 === 0) {
      const A = w.ambient as Float32Array, R = w.reserve as Float32Array;
      let topRegion = -1, topRegMass = 0;
      for (let b = 0, ri = 0; b < A.length; b += STRIDE, ri++) {
        const m = A[b + CHEM_ID] + R[b + CHEM_ID];
        if (m > topRegMass) { topRegMass = m; topRegion = ri; }
      }
      console.log(
        `tick=${i.toString().padStart(5)} t=${w.t.toFixed(2)} cells=${w.creatures.length} nparts=${w.particles.length} ` +
        `TOT=${t.toFixed(1).padStart(12)}  Δ=${d.toFixed(2).padStart(10)} ` +
        `topRegion=${topRegion} regMass=${topRegMass.toFixed(1)}`,
      );
    }
  }
  prev = t;
}
console.log(`\nbig-delta-tick count: ${bigDeltaCount}`);
