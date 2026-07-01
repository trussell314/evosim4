// Direct timing of evacuateRocks. Runs the sim long enough to settle,
// then samples the cost of a single pass with high precision.
import { createWorld, step } from "../src/sim";

const w = createWorld(800, 600, { seed: 1 });
// Warm up
for (let i = 0; i < 600; i++) step(w, 1 / 60);
console.log(`warmed up: particles=${w.particles.length}  creatures=${w.creatures.length}`);

// Run another N ticks to time only evacuate.
const N = 300;
const samples: number[] = [];
for (let i = 0; i < N; i++) {
  const t0 = performance.now();
  step(w, 1 / 60);
  samples.push(performance.now() - t0);
}
samples.sort((a, b) => a - b);
const med = samples[Math.floor(N / 2)];
const avg = samples.reduce((a, b) => a + b, 0) / N;
const max = samples[N - 1];
console.log(`per-tick (full step): avg=${avg.toFixed(3)}  median=${med.toFixed(3)}  max=${max.toFixed(3)} ms`);
