// Pure genome-identity helpers: hashing, keying, edit distance and
// colour. Functions of the raw genome bytes only -- no engine state --
// so they live outside the simulation core. Re-exported from sim.ts
// for API stability.

// Short, stable, human-readable tag for a genome (FNV-1a -> base36,
// 6 chars). Used as a display handle for species/cells.
export function genomeTag(genome: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < genome.length; i++) {
    h ^= genome[i];
    h = Math.imul(h, 0x01000193);
  }
  const s = (h >>> 0).toString(36);
  return (s.length >= 6 ? s.slice(0, 6) : s.padStart(6, "0")).toUpperCase();
}

// Exact hex encoding of the genome bytes. This is the canonical
// species key (two cells are the same species iff byte-identical).
export function genomeKey(genome: Uint8Array): string {
  let s = "";
  for (let i = 0; i < genome.length; i++) {
    const b = genome[i];
    s += (b < 16 ? "0" : "") + b.toString(16);
  }
  return s;
}

// Levenshtein edit distance between two genomes (row-rolled DP).
export function genomeDistance(a: Uint8Array, b: Uint8Array): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Int32Array(n + 1);
  const cur = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const sub = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + sub);
    }
    prev.set(cur);
  }
  return prev[n];
}

// Cell color. With no anchor, uses a deterministic hash-based hue at
// fixed saturation/lightness. With an anchor, an exact-match genome
// paints white and the color fades toward the hash hue as edit
// distance grows.
const COLOR_SAT_FULL = 60;
const COLOR_LIGHT_FULL = 62;
const COLOR_DIST_FULL = 24;

export function genomeColor(genome: Uint8Array, anchor?: Uint8Array): string {
  let h = 5381 >>> 0;
  for (let i = 0; i < genome.length; i++) {
    h = ((h * 33) ^ genome[i]) >>> 0;
  }
  const hue = h % 360;
  if (!anchor) {
    return `hsl(${hue}, ${COLOR_SAT_FULL}%, ${COLOR_LIGHT_FULL}%)`;
  }
  const d = Math.min(1, genomeDistance(genome, anchor) / COLOR_DIST_FULL);
  const sat = COLOR_SAT_FULL * d;
  const light = 100 - (100 - COLOR_LIGHT_FULL) * d;
  return `hsl(${hue}, ${sat.toFixed(1)}%, ${light.toFixed(1)}%)`;
}
