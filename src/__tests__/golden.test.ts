import { describe, it, expect } from "vitest";
import { createWorld, step, type World } from "../sim";

// Golden behavior fingerprint. The determinism test only proves two
// runs in the SAME build agree; it cannot catch a refactor that
// changes behavior consistently. This pins a hash of full world state
// after a fixed seeded run, so ANY behavior drift from the modular
// decomposition (CLAUDE.md: behavior-preserving) fails CI immediately.
//
// If a change is *intended* to alter simulation behavior, recompute and
// update GOLDEN deliberately in the same commit -- never reflexively.

const SEED = 0x1234abcd;
const TICKS = 60 * 4;

// Quantize to 1e-6 so a refactor that re-associates mathematically
// equivalent float expressions doesn't trip it, while any real
// behavior change (different path, count, ordering) still does.
function q(v: number): number {
  return Math.round(v * 1e6);
}

function fingerprint(w: World): string {
  let h = 0x811c9dc5 >>> 0;
  const mix = (n: number): void => {
    h ^= n | 0;
    h = Math.imul(h, 0x01000193);
    h >>>= 0;
  };
  mix(q(w.t));
  mix(w.creatures.length);
  mix(w.particles.length);
  for (const c of w.creatures) {
    mix(q(c.energy));
    mix(q(c.x));
    mix(q(c.y));
    mix(q(c.r));
    mix(c.genome.length);
    for (let i = 0; i < c.genome.length; i++) mix(c.genome[i]);
    for (const k of Object.keys(c.molecules).sort()) {
      mix(q((c.molecules as unknown as Record<string, number>)[k]));
    }
  }
  const store = w.particleStore;
  for (let i = 0; i < w.particles.length; i++) {
    mix(store.chemId[i]);
    mix(q(store.x[i]));
    mix(q(store.y[i]));
    mix(q(store.r[i]));
  }
  for (let i = 0; i < w.ambient.length; i++) mix(q(w.ambient[i]));
  for (let i = 0; i < w.reserve.length; i++) mix(q(w.reserve[i]));
  return (h >>> 0).toString(16).padStart(8, "0");
}

describe("golden: seeded run produces a pinned state fingerprint", () => {
  it("matches the committed GOLDEN hash", () => {
    const w = createWorld(800, 600, { seed: SEED });
    for (let i = 0; i < TICKS; i++) step(w, 1 / 60);
    const fp = fingerprint(w);
    // Recompute & update only when a behavior change is intended.
    const GOLDEN = "3e3470c9";
    expect(fp).toBe(GOLDEN);
  }, 20_000);
});
