// Standalone perf benchmark for the collision phase. Run via `npm run bench`.
//
// Times whole `step()` calls (since `resolveCollisions` is the inner loop
// that dominates at high particle counts). Uses a seeded mulberry32 PRNG so
// successive runs measure the same workload.

import { describe, it } from "vitest";
import { createWorld, step, seedParticles, type World } from "../sim";
import { mulberry32 } from "../rng";

function buildScene(particleCount: number): World {
  const w = createWorld(800, 600);
  seedParticles(w, particleCount);
  return w;
}

function benchSteps(w: World, ticks: number): { totalMs: number; perTick: number } {
  for (let i = 0; i < 20; i++) step(w, 1 / 60);
  const t0 = performance.now();
  for (let i = 0; i < ticks; i++) step(w, 1 / 60);
  const dt = performance.now() - t0;
  return { totalMs: dt, perTick: dt / ticks };
}

describe("collision benchmark", () => {
  it("step() with 550 particles, 120 ticks", () => {
    const orig = Math.random;
    Math.random = mulberry32(0xBE17C4);
    try {
      const w = buildScene(550);
      const r = benchSteps(w, 120);
      console.log(`\n[bench] 550 particles  total=${r.totalMs.toFixed(2)}ms  per-tick=${r.perTick.toFixed(3)}ms`);
    } finally { Math.random = orig; }
  });
  it("step() with 1000 particles, 60 ticks", () => {
    const orig = Math.random;
    Math.random = mulberry32(0xBE17C4);
    try {
      const w = buildScene(1000);
      const r = benchSteps(w, 60);
      console.log(`[bench] 1000 particles total=${r.totalMs.toFixed(2)}ms  per-tick=${r.perTick.toFixed(3)}ms`);
    } finally { Math.random = orig; }
  });
  it("step() with 2000 particles, 30 ticks", () => {
    const orig = Math.random;
    Math.random = mulberry32(0xBE17C4);
    try {
      const w = buildScene(2000);
      const r = benchSteps(w, 30);
      console.log(`[bench] 2000 particles total=${r.totalMs.toFixed(2)}ms  per-tick=${r.perTick.toFixed(3)}ms`);
    } finally { Math.random = orig; }
  });
});
