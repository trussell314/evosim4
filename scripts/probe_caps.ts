// One-off cap instrumentation. 3 durations x 3 particle caps, fixed
// seed per duration so differences are attributable to the cap, not
// RNG. Prints a per-duration comparison + a flagged-difference summary.
//   npx tsx scripts/probe_caps.ts
import {
  createWorld, step, setParticleTarget, genomeKey,
  CHEM_BASE_DENSITY, CHEM_MOLAR_MASS, CHEM_IDS,
} from "../src/sim";

const DT = 1 / 60;
const SEED = 0xC0FFEE;
const DURATIONS = [5, 20, 60];   // sim minutes
const CAPS = [1000, 3000, 5000];
const STRIDE = CHEM_MOLAR_MASS.length;
const ID = CHEM_IDS as Record<string, number>;

interface Metrics {
  cap: number; cells: number; species: number; lineages: number;
  ext: number; chlPct: number; parts: number;
  fa: number; biop: number; co2: number; o2: number; glu: number;
  births: number; dStarve: number; dMem: number; wallS: number;
}

function chemTotal(w: any, k: number): number {
  let s = 0;
  for (const c of w.creatures) s += c.store.chemCols[k][c.idx];
  const A = w.ambient, R = w.reserve;
  for (let b = 0; b < A.length; b += STRIDE) s += A[b + k] + R[b + k];
  const ps = w.particleStore;
  for (let i = 0; i < w.particles.length; i++) {
    if (ps.chemId[i] !== k) continue;
    const r = ps.r[i];
    const d = ps.density[i] || (CHEM_BASE_DENSITY[k] || 1);
    s += (d * (4 / 3) * Math.PI * r * r * r) / (CHEM_MOLAR_MASS[k] || 1);
  }
  return s;
}

function run(minutes: number, cap: number): Metrics {
  const w = createWorld(800, 600, { delayedSpawn: true, seed: SEED }) as any;
  setParticleTarget(w, cap);
  const RUN_T = minutes * 60;
  const t0 = Date.now();
  for (let i = 0; w.t < RUN_T; i++) step(w, DT);
  const species = new Set<string>();
  const lineages = new Set<number>();
  let chl = 0;
  for (const c of w.creatures) {
    species.add(genomeKey(c.genome));
    lineages.add(c.lineageRoot);
    if (c.store.chemCols[ID.chlorophyll][c.idx] > 0.01) chl++;
  }
  const st = w.stats;
  return {
    cap, cells: w.creatures.length, species: species.size,
    lineages: lineages.size, ext: w.extinctionCount,
    chlPct: w.creatures.length ? (100 * chl / w.creatures.length) : 0,
    parts: w.particles.length,
    fa: chemTotal(w, ID.fattyAcid), biop: chemTotal(w, ID.biopolymer),
    co2: chemTotal(w, ID.co2), o2: chemTotal(w, ID.o2),
    glu: chemTotal(w, ID.glucose),
    births: st ? st.births : 0, dStarve: st ? st.dStarve : 0,
    dMem: st ? st.dMembrane : 0,
    wallS: (Date.now() - t0) / 1000,
  };
}

const f = (n: number) => (Number.isFinite(n) ? n : 0).toFixed(0).padStart(7);
for (const minutes of DURATIONS) {
  console.log(`\n=== ${minutes} sim-min (seed ${SEED.toString(16)}) ===`);
  console.log(
    "cap     cells  species lineage   ext  chl%   parts      fa    biop     co2      o2     glu  births dStarve  dMem  wallS",
  );
  const ms: Metrics[] = [];
  for (const cap of CAPS) {
    const m = run(minutes, cap);
    ms.push(m);
    console.log(
      `${String(cap).padStart(4)} ${f(m.cells)} ${f(m.species)} ${f(m.lineages)} ${f(m.ext)} ` +
      `${m.chlPct.toFixed(0).padStart(4)} ${f(m.parts)} ${f(m.fa)} ${f(m.biop)} ${f(m.co2)} ` +
      `${f(m.o2)} ${f(m.glu)} ${f(m.births)} ${f(m.dStarve)} ${f(m.dMem)} ${m.wallS.toFixed(0).padStart(5)}`,
    );
  }
  // Flag metrics that vary >40% across caps (range / median).
  const keys: (keyof Metrics)[] = ["cells", "species", "lineages", "ext", "chlPct", "fa", "biop", "co2", "o2", "glu", "births", "dStarve", "dMem"];
  const flags: string[] = [];
  for (const k of keys) {
    const vs = ms.map((m) => m[k] as number).slice().sort((a, b) => a - b);
    const lo = vs[0], hi = vs[2], med = vs[1];
    const denom = Math.max(1, Math.abs(med));
    const spread = (hi - lo) / denom;
    if (spread > 0.4) flags.push(`${k}: ${ms.map((m) => (m[k] as number).toFixed(0)).join(" / ")} (1k/3k/5k, spread ${(spread * 100).toFixed(0)}%)`);
  }
  console.log(flags.length ? "  significant cap differences:\n   - " + flags.join("\n   - ") : "  no >40% differences across caps");
}
