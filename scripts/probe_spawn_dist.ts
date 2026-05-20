// Probe: read the instrumented topSpawnPos x-debug array.
import { createWorld, step, __SPAWN_X_DEBUG, __SPAWN_NULL_DEBUG } from "../src/sim";

const W = 800, H = 600;
const w = createWorld(W, H, { seed: 1, delayedSpawn: true });
for (let i = 0; i < 60 * 200; i++) step(w, 1 / 60);

const BINS = 10;
const counts = new Array(BINS).fill(0);
for (const x of __SPAWN_X_DEBUG) {
  const bin = Math.min(BINS - 1, Math.floor((x / W) * BINS));
  counts[bin]++;
}
const nullCounts = new Array(BINS).fill(0);
for (const x of __SPAWN_NULL_DEBUG) {
  const bin = Math.min(BINS - 1, Math.floor((x / W) * BINS));
  nullCounts[bin]++;
}
// Also bin the post-physics particle positions: that's what the user
// sees on screen.
const postBins = new Array(BINS).fill(0);
for (const p of w.particles) {
  const bin = Math.min(BINS - 1, Math.floor((p.x / W) * BINS));
  postBins[bin]++;
}
const postTotal = w.particles.length;
console.log(`\nPOST-PHYSICS (drifted) particles=${postTotal}`);
console.log("post-physics x-decile counts (uniform target = " + (postTotal / BINS).toFixed(0) + "):");
for (let i = 0; i < BINS; i++) {
  const pct = postTotal > 0 ? (postBins[i] * 100 / postTotal).toFixed(1) : "0.0";
  const bar = "#".repeat(Math.round(postBins[i] * 40 / Math.max(1, postTotal)));
  console.log(`  [${(i * W / BINS).toFixed(0).padStart(4)}-${((i + 1) * W / BINS).toFixed(0).padStart(4)}]  ${postBins[i].toString().padStart(4)} (${pct}%)  ${bar}`);
}
console.log();

const total = __SPAWN_X_DEBUG.length;
const nullTotal = __SPAWN_NULL_DEBUG.length;
console.log(`spawns recorded: ${total}  rejected (null returns): ${nullTotal}`);
console.log("spawn-x decile counts (uniform target = " + (total / BINS).toFixed(0) + "):");
for (let i = 0; i < BINS; i++) {
  const pct = total > 0 ? (counts[i] * 100 / total).toFixed(1) : "0.0";
  const nullPct = nullTotal > 0 ? (nullCounts[i] * 100 / nullTotal).toFixed(1) : "0.0";
  const bar = "#".repeat(Math.round(counts[i] * 40 / Math.max(1, total)));
  console.log(`  [${(i * W / BINS).toFixed(0).padStart(4)}-${((i + 1) * W / BINS).toFixed(0).padStart(4)}]  spawn=${counts[i].toString().padStart(4)} (${pct}%)  null=${nullCounts[i].toString().padStart(4)} (${nullPct}%)  ${bar}`);
}
