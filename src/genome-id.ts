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

// Cell color encodes phylogeny on two axes, in OKLCH (perceptually
// uniform -- equal hue steps look equally different, unlike HSL where
// greens sprawl and blues compress):
//   HUE      = the founding LINEAGE (lineageRoot), spread by the golden
//              angle so sibling founders get maximally-separated hues.
//              Every descendant of a founder shares that founder's hue
//              family, so a clade is one colour at a glance.
//   LIGHTNESS+CHROMA = how far this cell's CODING genome (introns
//              stripped) has DIVERGED from its lineage root. A cell at
//              the root is pale and gently saturated; as the coding
//              genome drifts it darkens and saturates. So within one
//              hue family you read sub-structure: pale = close to the
//              founder, deep = highly evolved away from it.
// Replaces the old full-genome-hash hue (which scrambled on neutral
// intron drift and made relatives look unrelated) + single-anchor
// fade.
const GOLDEN_ANGLE_DEG = 137.50776405003785;
// Coding edit-distance that maps to "fully diverged" (max darkening).
const COLOR_DIVERGENCE_FULL = 40;
const OKLCH_L_ROOT = 0.86;   // lightness at the lineage root
const OKLCH_L_FAR = 0.50;    // lightness when fully diverged
const OKLCH_C_ROOT = 0.05;   // chroma at the root (near-grey, pale)
const OKLCH_C_FAR = 0.20;    // chroma when fully diverged (vivid)

// OKLCH -> sRGB hex. OKLCH = OKLab in polar form; convert to OKLab,
// then OKLab -> linear sRGB (Bjorn Ottosson's matrices), then gamma-
// encode + clamp. Done by hand rather than emitting an "oklch(...)"
// CSS string so the result works everywhere (older canvas impls, hex
// equality, save round-trips) regardless of browser oklch() support.
function oklchToHex(L: number, C: number, hueDeg: number): string {
  const hr = (hueDeg * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  let r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  let bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  const enc = (v: number): number => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    const u = c < 0 ? 0 : c > 1 ? 1 : c;
    return Math.round(u * 255);
  };
  const ri = enc(r), gi = enc(g), bi = enc(bl);
  const hex = (n: number): string => (n < 16 ? "0" : "") + n.toString(16);
  return `#${hex(ri)}${hex(gi)}${hex(bi)}`;
}

// Color for a cell from its founding lineage id + how far its coding
// genome has diverged from the lineage root (a coding edit distance).
export function lineageColor(lineageRoot: number, codingDivergence: number): string {
  const hue = ((lineageRoot * GOLDEN_ANGLE_DEG) % 360 + 360) % 360;
  const d = Math.min(1, Math.max(0, codingDivergence / COLOR_DIVERGENCE_FULL));
  const L = OKLCH_L_ROOT + (OKLCH_L_FAR - OKLCH_L_ROOT) * d;
  const C = OKLCH_C_ROOT + (OKLCH_C_FAR - OKLCH_C_ROOT) * d;
  return oklchToHex(L, C, hue);
}
