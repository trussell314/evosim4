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

// Stateless deterministic hash of integer inputs -> uint32. This is the
// per-event entropy source for stochastic mechanics (e.g. death-triggered
// EGT) that must NOT draw from the world RNG: pulling from the shared
// mulberry32 stream would reorder every downstream draw and perturb
// unrelated systems run-to-run. Hashing fixed event coordinates
// (creature ids, tick, a per-mechanic salt) instead keeps each decision
// reproducible while leaving the global draw order untouched.
//
// A 32-bit murmur3-style mixer, not a true 64-bit splitmix -- JS has no
// cheap 64-bit integer math, and Math.imul-based 32-bit mixing is the
// same technique mulberry32 already relies on. Inputs are coerced to
// int32; callers pass small non-negative coordinates.
export function mixHash(...vals: number[]): number {
  let h = 0x9e3779b9 | 0;
  for (let i = 0; i < vals.length; i++) {
    let k = vals[i] | 0;
    k = Math.imul(k ^ (k >>> 16), 0x85ebca6b);
    k = Math.imul(k ^ (k >>> 13), 0xc2b2ae35);
    k ^= k >>> 16;
    h = Math.imul(h ^ k, 0x9e3779b1);
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// Same hash mapped to a uniform double in [0, 1) -- the drop-in
// replacement for a `simRng()` draw inside a per-event decision.
export function hashUnit(...vals: number[]): number {
  return mixHash(...vals) / 4294967296;
}
