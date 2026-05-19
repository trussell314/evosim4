// Per-archetype "perfect scenario" probe. Founder spawns OFF; the
// world is hand-seeded with the resources/biota that maximally favour
// ONE archetype, which is then run 10 sim-min. Reports only measured
// numbers (population trajectory, mean body state, births, the
// tracked death-cause counters, ambient levels). No causal claims.
//
//   npx tsx scripts/scenario.ts <archetypeId> [observeMin]
//
// Throwaway probe.

import {
  createWorld,
  step,
  spawnSpeciesInstance,
  type World,
} from "../src/sim";
import { ARCHETYPES } from "../src/genome-archetypes";
import {
  CHEM_CO2,
  CHEM_ADP,
  CHEM_GLU,
  CHEM_CHL,
  CHEM_MEMBRANE,
  CHEM_MIN,
  CHEM_AA,
  CHEM_ACT_PHOTO_VISIBLE,
} from "../src/sim/chem-ids";

type Cre = {
  id: number;
  x: number;
  y: number;
  energy: number;
  idx: number;
  store: { chemCols: Float32Array[] };
};

interface Scenario {
  id: string;
  count: number;
  describe: string;
  // mutate world + freshly spawned cells before the run
  setup: (w: World, cells: Cre[]) => void;
  // optional per-sample top-up (a chemostat: "perfect" = a
  // non-depleting nutrient-replete medium). Reported in the header.
  replenish?: (w: World) => void;
  coStock: { id: string; count: number }[];
}

const AMB_STRIDE = 96;
function setAmbientAll(w: World, chem: number, v: number): void {
  const A = (w as unknown as { ambient: Float32Array }).ambient;
  for (let b = 0; b + chem < A.length; b += AMB_STRIDE) A[b + chem] = v;
}
function ambientMean(w: World, chem: number): number {
  const A = (w as unknown as { ambient: Float32Array }).ambient;
  let s = 0, n = 0;
  for (let b = 0; b + chem < A.length; b += AMB_STRIDE) { s += A[b + chem]; n++; }
  return n ? s / n : 0;
}

const SCENARIOS: Record<string, Scenario> = {
  photoautotroph: {
    id: "photoautotroph",
    count: 30,
    coStock: [],
    describe:
      "Near-surface (max light exp(-y/250)), permanent midday " +
      "(dayPhase=0.25, dayPeriod=1e9, no night). NUTRIENT-REPLETE " +
      "broth: aa source synth_aa is vmax-limited (0.4) below the aa " +
      "sinks (synth_membrane vmax 0.8 + chl/ribo/receptor), and aa " +
      "(perm 0.5) + min (perm 0.1) diffuse, so ambient CO2=50 / " +
      "MIN=50 / AA=30 seeded and re-topped every sample (chemostat); " +
      "cells primed CO2=20 ADP=30 MIN=30 AA=5. No co-stock. Founder " +
      "spawns off.",
    setup: (w, cells) => {
      w.dayPhase = 0.25;
      w.dayPeriod = 1e9;
      setAmbientAll(w, CHEM_CO2, 50);
      setAmbientAll(w, CHEM_MIN, 50);
      setAmbientAll(w, CHEM_AA, 30);
      const surfaceY = (w as unknown as { surfaceY: number }).surfaceY;
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        // pin just below the surface for maximal light
        c.y = surfaceY + 5 + (k % 6) * 3;
        c.x = w.width * (0.06 + 0.88 * ((k + 0.5) / cells.length));
        c.store.chemCols[CHEM_CO2][c.idx] = 20;
        c.store.chemCols[CHEM_ADP][c.idx] = 30;
        c.store.chemCols[CHEM_MIN][c.idx] = 30;
        c.store.chemCols[CHEM_AA][c.idx] = 5;
      }
    },
    replenish: (w) => {
      // Keep the medium nutrient-replete (non-depleting). aa + min
      // diffuse in (perm 0.5 / 0.1); CO2 too. No per-cell injection
      // -- uptake is via the medium so it stays a fair test.
      setAmbientAll(w, CHEM_CO2, 50);
      setAmbientAll(w, CHEM_MIN, 50);
      setAmbientAll(w, CHEM_AA, 30);
    },
  },

  // Controlled test of the synth_aa vmax 0.4->1.2 engine change:
  // EXACTLY the conditions of photoautotroph "run 2" (CO2+MIN replete
  // chemostat, NO amino-acid feeding, near-surface, permanent midday)
  // so the only variable vs that 30->19 decline is the vmax change.
  "photoautotroph-natural": {
    id: "photoautotroph",
    count: 30,
    coStock: [],
    describe:
      "NO aa feeding (natural). CO2=50/MIN=50 chemostat only; cells " +
      "primed CO2=20 ADP=30 MIN=30 (NO aa prime). Near-surface, " +
      "permanent midday, founders off. Identical to photoautotroph " +
      "run 2 (which declined 30->19); the sole difference is the " +
      "engine synth_aa vmax 0.4->1.2, isolating that change.",
    setup: (w, cells) => {
      w.dayPhase = 0.25;
      w.dayPeriod = 1e9;
      setAmbientAll(w, CHEM_CO2, 50);
      setAmbientAll(w, CHEM_MIN, 50);
      const surfaceY = (w as unknown as { surfaceY: number }).surfaceY;
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        c.y = surfaceY + 5 + (k % 6) * 3;
        c.x = w.width * (0.06 + 0.88 * ((k + 0.5) / cells.length));
        c.store.chemCols[CHEM_CO2][c.idx] = 20;
        c.store.chemCols[CHEM_ADP][c.idx] = 30;
        c.store.chemCols[CHEM_MIN][c.idx] = 30;
      }
    },
    replenish: (w) => {
      setAmbientAll(w, CHEM_CO2, 50);
      setAmbientAll(w, CHEM_MIN, 50);
    },
  },

  phototaxis: {
    id: "phototaxis",
    count: 30,
    coStock: [],
    describe:
      "Metabolically a photoautotroph (AUTO_SYNTH, no INGEST) PLUS " +
      "two extra aa-sinks (PHOTO+MAGNETO receptor synth) and a " +
      "conditional THRUST. Same proven recipe as photoautotroph: " +
      "near-surface (max light), permanent midday, CO2=50/MIN=50/" +
      "AA=30 chemostat, cells primed CO2=20 ADP=30 MIN=30 AA=5. No " +
      "co-stock. Founders off. Defining behavior is the genome's " +
      "'act_photo_visible < 6 -> climb magnetic axis' branch; we " +
      "MEASURE how many cells are in that dark/migrating branch " +
      "(nDark) rather than assume.",
    setup: (w, cells) => {
      w.dayPhase = 0.25;
      w.dayPeriod = 1e9;
      setAmbientAll(w, CHEM_CO2, 50);
      setAmbientAll(w, CHEM_MIN, 50);
      setAmbientAll(w, CHEM_AA, 30);
      const surfaceY = (w as unknown as { surfaceY: number }).surfaceY;
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        c.y = surfaceY + 5 + (k % 6) * 3;
        c.x = w.width * (0.06 + 0.88 * ((k + 0.5) / cells.length));
        c.store.chemCols[CHEM_CO2][c.idx] = 20;
        c.store.chemCols[CHEM_ADP][c.idx] = 30;
        c.store.chemCols[CHEM_MIN][c.idx] = 30;
        c.store.chemCols[CHEM_AA][c.idx] = 5;
      }
    },
    replenish: (w) => {
      setAmbientAll(w, CHEM_CO2, 50);
      setAmbientAll(w, CHEM_MIN, 50);
      setAmbientAll(w, CHEM_AA, 30);
    },
  },
};

const id = process.argv[2] ?? "photoautotroph";
const OBSERVE_MIN = Number(process.argv[3] ?? 10);
const sc = SCENARIOS[id];
if (!sc) {
  console.error(`no scenario for "${id}". have: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(1);
}
const arch = ARCHETYPES.find((a) => a.id === sc.id);
if (!arch) {
  console.error(`scenario "${id}" targets unknown archetype "${sc.id}"`);
  process.exit(1);
}

const DT = 1 / 60;
const OBSERVE_T = OBSERVE_MIN * 60;
const SAMPLE = 30;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const w = createWorld(800, 600, { delayedSpawn: true, seed: 4242 }) as any;
w.foundersEnabled = false;

// co-stock first (so the focal archetype's setup can see them)
for (const cs of sc.coStock) {
  const g = ARCHETYPES.find((a) => a.id === cs.id)!.genome;
  for (let i = 0; i < cs.count; i++) spawnSpeciesInstance(w, g);
}
const focal: Cre[] = [];
for (let i = 0; i < sc.count; i++) {
  const c = spawnSpeciesInstance(w, arch.genome);
  if (c) focal.push(c as unknown as Cre);
}
sc.setup(w, focal);

interface St { births: number; dStarve: number; dMembrane: number; dAa: number; dMrna: number; dOld: number }
function snap(): St {
  const s = w.stats ?? {};
  return {
    births: s.births ?? 0, dStarve: s.dStarve ?? 0, dMembrane: s.dMembrane ?? 0,
    dAa: s.dAa ?? 0, dMrna: s.dMrna ?? 0, dOld: s.dOld ?? 0,
  };
}
function meanCell(chem: number): number {
  const cs = w.creatures;
  if (!cs.length) return 0;
  let s = 0;
  for (const c of cs) s += c.store.chemCols[chem][c.idx];
  return s / cs.length;
}
function meanEnergy(): number {
  const cs = w.creatures;
  if (!cs.length) return 0;
  let s = 0;
  for (const c of cs) s += c.energy;
  return s / cs.length;
}
function nAboveMembrane(thresh: number): number {
  let n = 0;
  for (const c of w.creatures) if (c.store.chemCols[CHEM_MEMBRANE][c.idx] > thresh) n++;
  return n;
}
// Cells whose sensed visible light is below the phototaxis genome's
// threshold of 6 -- i.e. in the "dark, swim the magnetic axis"
// branch. Measured, not assumed.
function nDark(): number {
  let n = 0;
  for (const c of w.creatures) if (c.store.chemCols[CHEM_ACT_PHOTO_VISIBLE][c.idx] < 6) n++;
  return n;
}

console.log(`# scenario: ${id}  (x${focal.length} spawned${sc.coStock.length ? ", co-stock " + sc.coStock.map(c => c.id + ":" + c.count).join(",") : ", no co-stock"})`);
console.log(`# ${sc.describe}`);
console.log(`# reproduce gate: SELF_MEMBRANE > 40`);
console.log(
  `# t=0  pop=${w.creatures.length} ambCO2=${ambientMean(w, CHEM_CO2).toFixed(1)} ` +
    `meanMembrane=${meanCell(CHEM_MEMBRANE).toFixed(2)} meanATP=${meanEnergy().toFixed(1)} ` +
    `meanCHL=${meanCell(CHEM_CHL).toFixed(2)} meanGLU=${meanCell(CHEM_GLU).toFixed(2)}`,
);
const base = snap();
const t0 = Date.now();
let nextSample = SAMPLE;
let peak = w.creatures.length;
const endT = OBSERVE_T;

// Exact, mechanism-agnostic accounting by creature id (c.id is stable
// and never recycled): a new id = a birth, a vanished id = a death.
// Independent of the SimStats counters, so start + births - deaths
// closes by construction and any divergence from SimStats is visible.
let live = new Set<number>();
for (const c of w.creatures) live.add(c.id);
let idBirths = 0;
let idDeaths = 0;
console.log(`# replenish: ${sc.replenish ? "yes (chemostat, every sample)" : "none"}`);

while (w.t < endT) {
  step(w, DT);
  if (w.creatures.length > peak) peak = w.creatures.length;
  const now = new Set<number>();
  for (const c of w.creatures) {
    now.add(c.id);
    if (!live.has(c.id)) idBirths++;
  }
  for (const oldId of live) if (!now.has(oldId)) idDeaths++;
  live = now;
  if (w.t >= nextSample) {
    nextSample += SAMPLE;
    if (sc.replenish) sc.replenish(w);
    console.log(
      `t=${String(Math.round(w.t)).padStart(3)}s pop=${String(w.creatures.length).padStart(4)} ` +
        `nMem>40=${String(nAboveMembrane(40)).padStart(3)} ` +
        `nDark=${String(nDark()).padStart(3)} ` +
        `mActPh=${meanCell(CHEM_ACT_PHOTO_VISIBLE).toFixed(1).padStart(5)} ` +
        `mMem=${meanCell(CHEM_MEMBRANE).toFixed(2).padStart(6)} ` +
        `mATP=${meanEnergy().toFixed(1).padStart(7)} ` +
        `mCHL=${meanCell(CHEM_CHL).toFixed(2).padStart(6)} ` +
        `mAA=${meanCell(CHEM_AA).toFixed(2).padStart(6)} ` +
        `mGLU=${meanCell(CHEM_GLU).toFixed(2).padStart(6)} ` +
        `ambAA=${ambientMean(w, CHEM_AA).toFixed(1).padStart(5)} ` +
        `ambMIN=${ambientMean(w, CHEM_MIN).toFixed(1).padStart(5)}`,
    );
  }
}
const e = snap();
const idClose = focal.length + idBirths - idDeaths;
console.log(
  `# END  pop=${w.creatures.length} peak=${peak}`,
);
console.log(
  `# id-accounting (exact): spawned=${focal.length} births=${idBirths} ` +
    `deaths=${idDeaths} -> expected=${idClose} actual=${w.creatures.length} ` +
    `(closes: ${idClose === w.creatures.length})`,
);
console.log(
  `# SimStats deltas: births=${e.births - base.births} ` +
    `deaths{starve=${e.dStarve - base.dStarve} mem=${e.dMembrane - base.dMembrane} ` +
    `aa=${e.dAa - base.dAa} mrna=${e.dMrna - base.dMrna} old=${e.dOld - base.dOld}} ` +
    `(sum=${(e.dStarve - base.dStarve) + (e.dMembrane - base.dMembrane) + (e.dAa - base.dAa) + (e.dMrna - base.dMrna) + (e.dOld - base.dOld)})`,
);
console.log(
  `# ambient end: CO2=${ambientMean(w, CHEM_CO2).toFixed(1)} MIN=${ambientMean(w, CHEM_MIN).toFixed(1)}`,
);
console.log(`# done in ${((Date.now() - t0) / 1000).toFixed(0)}s wall`);
