// One-off: spin up a world, let pebbles spawn + fall, and report
// the distribution of speeds + sleep state at the bottom. Goal: see
// whether pebbles are settling and going asleep, or churning.
//
// Run with: npx tsx scripts/probe_pebbles.ts

import { createWorld, step, MATERIAL_IDS_ORDERED } from "../src/sim";

const sandIdx = MATERIAL_IDS_ORDERED.indexOf("sand");

const FIXED_DT = 1 / 60;
const SECONDS = 60;
const STEPS = Math.round(SECONDS / FIXED_DT);

const w = createWorld(800, 600);
// Skip warm-up gates: jump sim time past FOUNDER/WATER delays so the
// world fills normally; pebbles still spawn from t=0 anyway, but this
// makes sure the per-material replenish doesn't behave weirdly.
w.t = 0;

// Sample pebble count over time so we can see if they grow then shrink.
const sampleInterval = 60; // every 1 sim-sec
function pebbleCountNow(): number {
  let c = 0;
  const n = w.particles.length;
  for (let i = 0; i < n; i++) {
    if (w.particleStore.material[i] === sandIdx && w.particleStore.r[i] >= 8) c++;
  }
  return c;
}
const samples: Array<{ t: number; n: number; p: number }> = [];
for (let s = 0; s < STEPS; s++) {
  step(w, FIXED_DT);
  if (s % sampleInterval === 0) {
    samples.push({ t: w.t, n: w.particles.length, p: pebbleCountNow() });
  }
}
console.log("time | total | pebbles");
for (let i = 0; i < samples.length; i += 5) {
  const s = samples[i];
  console.log(`  t=${s.t.toFixed(1)}s n=${s.n} pebbles=${s.p}`);
}

const ps = w.particleStore;
const n = w.particles.length;

let totalPebbles = 0;
let movingPebbles = 0;
let speedSum = 0;
let speedMax = 0;
const buckets = [0, 0, 0, 0, 0, 0, 0]; // 0-1, 1-3, 3-5, 5-10, 10-20, 20-50, 50+
let bottomPebbles = 0;
let bottomMoving = 0;
let pebbleYMin = Infinity;
let pebbleYMax = -Infinity;

for (let i = 0; i < n; i++) {
  if (ps.material[i] !== sandIdx) continue;
  if (ps.r[i] < 8) continue;
  totalPebbles++;
  const vx = ps.vx[i], vy = ps.vy[i], vz = ps.vz[i];
  const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
  speedSum += speed;
  if (speed > speedMax) speedMax = speed;
  if (speed > 5) movingPebbles++;
  if (ps.y[i] < pebbleYMin) pebbleYMin = ps.y[i];
  if (ps.y[i] > pebbleYMax) pebbleYMax = ps.y[i];
  if (speed < 1) buckets[0]++;
  else if (speed < 3) buckets[1]++;
  else if (speed < 5) buckets[2]++;
  else if (speed < 10) buckets[3]++;
  else if (speed < 20) buckets[4]++;
  else if (speed < 50) buckets[5]++;
  else buckets[6]++;
  // "Bottom" = within 30px of the lowest pebble seen so far.
  if (ps.y[i] > w.height - 50) {
    bottomPebbles++;
    if (speed > 5) bottomMoving++;
  }
}

const quietTicksSample: number[] = [];
let pebbleQuietTotal = 0;
let pebbleQuietBuckets = [0, 0, 0, 0]; // 0, 1-9, 10-29, 30+
for (let i = 0; i < n; i++) {
  if (ps.material[i] !== sandIdx) continue;
  if (ps.r[i] < 10) continue;
  const q = ps.quietTicks[i];
  pebbleQuietTotal += q;
  if (q === 0) pebbleQuietBuckets[0]++;
  else if (q < 10) pebbleQuietBuckets[1]++;
  else if (q < 30) pebbleQuietBuckets[2]++;
  else pebbleQuietBuckets[3]++;
  if (quietTicksSample.length < 20) quietTicksSample.push(q);
}

console.log(`After ${SECONDS}s sim time (${STEPS} steps):`);
console.log(`  total particles: ${n}`);
console.log(`  pebbles: ${totalPebbles}`);
console.log(`  pebble y range: ${pebbleYMin.toFixed(0)} - ${pebbleYMax.toFixed(0)} (world h=${w.height})`);
console.log(`  pebbles with speed > 5 (sleep threshold): ${movingPebbles} / ${totalPebbles} (${(100 * movingPebbles / Math.max(1, totalPebbles)).toFixed(1)}%)`);
console.log(`  avg pebble speed: ${(speedSum / Math.max(1, totalPebbles)).toFixed(2)} px/s`);
console.log(`  max pebble speed: ${speedMax.toFixed(2)} px/s`);
console.log(`  speed buckets [<1, 1-3, 3-5, 5-10, 10-20, 20-50, 50+]: ${buckets.join(", ")}`);
console.log(`  bottom-50px pebbles: ${bottomPebbles}, moving: ${bottomMoving}`);
console.log(`  quietTicks buckets [0, 1-9, 10-29, 30+]: ${pebbleQuietBuckets.join(", ")} (sleep threshold = 30)`);
console.log(`  avg quietTicks: ${(pebbleQuietTotal / Math.max(1, totalPebbles)).toFixed(1)}`);
console.log(`  quietTicks sample: ${quietTicksSample.join(", ")}`);
