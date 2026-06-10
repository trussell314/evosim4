import { describe, it, expect } from "vitest";
import { createWorld, step, type World } from "../sim";

// Determinism guard, kept in the DEFAULT suite (not the smoke config)
// so `npm test` enforces it. Previously reproducibility was only
// checked in scenario.smoke.test.ts via a global Math.random stub;
// that masked any sim-path draw that bypassed the seeded stream.
// createWorld now threads a seeded RNG (opts.seed) through every
// nondeterministic draw, so two worlds built from the same seed must
// evolve byte-identically without touching Math.random.

interface Outcome {
  pop: number;
  particles: number;
  energySum: number;
  firstGenomeBytes: number[];
  meanX: number;
}

function runOnce(seed: number, ticks: number): Outcome {
  const w: World = createWorld(800, 600, { seed });
  for (let i = 0; i < ticks; i++) step(w, 1 / 60);
  let energySum = 0;
  let meanX = 0;
  for (const c of w.creatures) {
    energySum += c.energy;
    meanX += c.x;
  }
  if (w.creatures.length > 0) meanX /= w.creatures.length;
  return {
    pop: w.creatures.length,
    particles: w.particles.length,
    energySum,
    firstGenomeBytes: Array.from(w.creatures[0]?.genome ?? []),
    meanX,
  };
}

describe("determinism: seeded createWorld is reproducible", () => {
  // A few sim-seconds is plenty: same-seed identity and different-seed
  // divergence both hold from the first founder draw onward. Kept short
  // so this stays in the default suite's time budget (each call builds
  // a full world + particle pool and steps it).
  const TICKS = 60 * 4;

  it("same seed yields byte-identical outcomes", () => {
    const a = runOnce(0x1234abcd, TICKS);
    const b = runOnce(0x1234abcd, TICKS);
    expect(a).toEqual(b);
  }, 20_000);

  it("different seeds diverge", () => {
    const a = runOnce(0x1234abcd, TICKS);
    const c = runOnce(0x1234abce, TICKS);
    expect(a).not.toEqual(c);
  }, 20_000);
});
