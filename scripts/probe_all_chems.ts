// Probe: for every chem, report mass in ambient + reserve at t=180
// and t=720. If specific chems are growing post-ramp, list them.
import { createWorld, step } from "../src/sim";
import { CHEM_MOLAR_MASS, CHEM_NAMES } from "../src/sim";

const STRIDE = CHEM_MOLAR_MASS.length;
const DT = 1 / 60;
const SAMPLE_TS = [180, 360, 540, 720];

const w = createWorld(800, 600, { delayedSpawn: true, seed: 1 }) as any;

function chemFieldTotal(chemId: number): { a: number; r: number } {
  let a = 0, r = 0;
  const A = w.ambient as Float32Array;
  const R = w.reserve as Float32Array;
  for (let b = 0; b < A.length; b += STRIDE) {
    a += A[b + chemId];
    r += R[b + chemId];
  }
  return { a, r };
}

const snapshots: Record<number, { a: number; r: number }[]> = {};
for (let i = 0; i < STRIDE; i++) snapshots[i] = [];

let nextT = SAMPLE_TS[0];
let si = 0;
while (w.t < SAMPLE_TS[SAMPLE_TS.length - 1]) {
  step(w, DT);
  if (w.t >= nextT) {
    for (let k = 0; k < STRIDE; k++) snapshots[k].push(chemFieldTotal(k));
    si++;
    if (si < SAMPLE_TS.length) nextT = SAMPLE_TS[si];
    else break;
  }
}

console.log(`# Sample times: ${SAMPLE_TS.join(", ")}`);
console.log(`# columns: chemId  name  t=180 (amb/res)  t=720 (amb/res)  Δ(720-180)`);
const growing: { id: number; name: string; delta: number; t720r: number }[] = [];
for (let k = 0; k < STRIDE; k++) {
  const s = snapshots[k];
  if (s.length < 2) continue;
  const first = s[0];
  const last = s[s.length - 1];
  const tot1 = first.a + first.r;
  const tot2 = last.a + last.r;
  const delta = tot2 - tot1;
  growing.push({
    id: k,
    name: CHEM_NAMES?.[k] ?? `chem${k}`,
    delta,
    t720r: last.r,
  });
}
growing.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
console.log("\nTop chems by |Δ(t=720)-Δ(t=180)|:");
for (const g of growing.slice(0, 15)) {
  console.log(`  chem${g.id.toString().padStart(2)} ${g.name.padEnd(16)}  Δ=${g.delta.toExponential(2).padStart(10)}  reserve@720=${g.t720r.toExponential(2)}`);
}
