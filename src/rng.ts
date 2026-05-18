// Small deterministic PRNG (mulberry32). One self-contained unit,
// extracted from sim.ts so the simulation core, the static table
// generators, and the test scenarios all share a single definition
// instead of carrying duplicate copies. Keeping reaction tables /
// scenarios reproducible across runs, renderer reloads, and workers
// depends on every caller using the exact same algorithm.
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
