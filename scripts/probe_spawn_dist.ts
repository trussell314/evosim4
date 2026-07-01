// Probe: post-physics particle x-distribution. The user sees this on
// screen, so it's the meaningful measure of "evenly distributed".
import { createWorld, step } from "../src/sim";

const W = 800, H = 600;
const w = createWorld(W, H, { seed: 1, delayedSpawn: true });
for (let i = 0; i < 60 * 200; i++) step(w, 1 / 60);

const BINS = 10;
const postBins = new Array(BINS).fill(0);
for (const p of w.particles) {
  const bin = Math.min(BINS - 1, Math.floor((p.x / W) * BINS));
  postBins[bin]++;
}
const postTotal = w.particles.length;
console.log(`t=${w.t.toFixed(1)} particles=${postTotal}`);
console.log("post-physics x-decile counts (uniform target = " + (postTotal / BINS).toFixed(0) + "):");
for (let i = 0; i < BINS; i++) {
  const pct = postTotal > 0 ? (postBins[i] * 100 / postTotal).toFixed(1) : "0.0";
  const bar = "#".repeat(Math.round(postBins[i] * 40 / Math.max(1, postTotal)));
  console.log(`  [${(i * W / BINS).toFixed(0).padStart(4)}-${((i + 1) * W / BINS).toFixed(0).padStart(4)}]  ${postBins[i].toString().padStart(4)} (${pct}%)  ${bar}`);
}
