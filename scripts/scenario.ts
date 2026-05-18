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
} from "../src/sim/chem-ids";

type Cre = { x: number; y: number; energy: number; idx: number; store: { chemCols: Float32Array[] } };

interface Scenario {
  id: string;
  count: number;
  describe: string;
  // mutate world + freshly spawned cells before the run
  setup: (w: World, cells: Cre[]) => void;
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
      "Near-surface placement (max light: exp(-y/250)), permanent " +
      "midday (dayPhase=0.25, dayPeriod=1e9 so solarLight stays 1, no " +
      "night), ambient CO2 seeded to 50/region, cells primed CO2=20 " +
      "ADP=30. No predators/competitors (pure primary producer gains " +
      "nothing from co-stocking). Founder spawns off.",
    setup: (w, cells) => {
      w.dayPhase = 0.25;
      w.dayPeriod = 1e9;
      setAmbientAll(w, CHEM_CO2, 50);
      const surfaceY = (w as unknown as { surfaceY: number }).surfaceY;
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        // pin just below the surface for maximal light
        c.y = surfaceY + 5 + (k % 6) * 3;
        c.x = w.width * (0.06 + 0.88 * ((k + 0.5) / cells.length));
        c.store.chemCols[CHEM_CO2][c.idx] = 20;
        c.store.chemCols[CHEM_ADP][c.idx] = 30;
      }
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
const arch = ARCHETYPES.find((a) => a.id === id);
if (!arch) {
  console.error(`no archetype "${id}"`);
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
while (w.t < endT) {
  step(w, DT);
  if (w.creatures.length > peak) peak = w.creatures.length;
  if (w.t >= nextSample) {
    nextSample += SAMPLE;
    console.log(
      `t=${String(Math.round(w.t)).padStart(3)}s pop=${String(w.creatures.length).padStart(4)} ` +
        `mMem=${meanCell(CHEM_MEMBRANE).toFixed(2).padStart(6)} ` +
        `mATP=${meanEnergy().toFixed(1).padStart(7)} ` +
        `mCHL=${meanCell(CHEM_CHL).toFixed(2).padStart(6)} ` +
        `mGLU=${meanCell(CHEM_GLU).toFixed(2).padStart(6)} ` +
        `ambCO2=${ambientMean(w, CHEM_CO2).toFixed(1).padStart(6)}`,
    );
  }
}
const e = snap();
console.log(
  `# END  pop=${w.creatures.length} peak=${peak} ` +
    `births=${e.births - base.births} ` +
    `deaths{starve=${e.dStarve - base.dStarve} mem=${e.dMembrane - base.dMembrane} ` +
    `aa=${e.dAa - base.dAa} mrna=${e.dMrna - base.dMrna} old=${e.dOld - base.dOld}} ` +
    `ambCO2=${ambientMean(w, CHEM_CO2).toFixed(1)}`,
);
console.log(`# done in ${((Date.now() - t0) / 1000).toFixed(0)}s wall`);
