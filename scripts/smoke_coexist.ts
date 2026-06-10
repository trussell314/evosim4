// ONE shared-world archetype run. A single seeded, food-rich world
// (founder rescue off) is warmed up, then 10 of EACH of the 15
// archetypes are injected into the SAME world so they coexist and
// interact (predators eat foragers, allelopath poisons neighbours,
// virus sheds, etc.). Per-archetype population is tracked by the
// lineageRoot set assigned at spawn (descendants inherit it, so
// attribution survives mutation).
//
//   npx tsx scripts/smoke_coexist.ts [observeMin]
//
// default: 10 min. Throwaway probe. Note: engulfed cells (alive
// inside a host's contents) are not counted -- only free creatures.

import { createWorld, step, spawnSpeciesInstance } from "../src/sim";
import { ARCHETYPES } from "../src/genome-archetypes";

const OBSERVE_MIN = Number(process.argv[2] ?? 10);
const PER = 10;
const DT = 1 / 60;
const WARMUP_T = 120;
const OBSERVE_T = OBSERVE_MIN * 60;
const SAMPLE = 60;
const SEED = 4242;

interface Stats {
  births: number;
  dStarve: number;
  dMembrane: number;
  dAa: number;
}
function snap(w: { stats?: Partial<Stats> }): Stats {
  const s = w.stats ?? {};
  return {
    births: s.births ?? 0,
    dStarve: s.dStarve ?? 0,
    dMembrane: s.dMembrane ?? 0,
    dAa: s.dAa ?? 0,
  };
}

const t0 = Date.now();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const w = createWorld(800, 600, { delayedSpawn: true, seed: SEED }) as any;
w.foundersEnabled = false;
while (w.t < WARMUP_T) step(w, DT);
const foodAtSpawn = w.particles.length;

// archetype id -> set of lineageRoots it owns; descendants inherit.
const roots = new Map<string, Set<number>>();
let spawnedTotal = 0;
for (const a of ARCHETYPES) {
  const set = new Set<number>();
  for (let i = 0; i < PER; i++) {
    const c = spawnSpeciesInstance(w, a.genome);
    if (c) {
      set.add(c.lineageRoot);
      spawnedTotal++;
    }
  }
  roots.set(a.id, set);
}
const base = snap(w);
const spawnT = w.t;

function counts(): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of ARCHETYPES) m.set(a.id, 0);
  for (const c of w.creatures) {
    for (const a of ARCHETYPES) {
      if (roots.get(a.id)!.has(c.lineageRoot)) {
        m.set(a.id, m.get(a.id)! + 1);
        break;
      }
    }
  }
  return m;
}

const peak = new Map<string, number>();
const series = new Map<string, number[]>();
for (const a of ARCHETYPES) {
  peak.set(a.id, PER);
  series.set(a.id, []);
}
console.log(
  `# one world, ${PER} of each of ${ARCHETYPES.length} archetypes ` +
    `(${spawnedTotal} cells), observe ${OBSERVE_MIN}min, ` +
    `food@spawn=${foodAtSpawn}, seed ${SEED}\n`,
);

let nextSample = spawnT + SAMPLE;
const endT = spawnT + OBSERVE_T;
const sampleTimes: number[] = [];
while (w.t < endT) {
  step(w, DT);
  const live = w.creatures.length;
  if (w.t >= nextSample || live === 0) {
    const c = counts();
    for (const a of ARCHETYPES) {
      const n = c.get(a.id)!;
      series.get(a.id)!.push(n);
      if (n > peak.get(a.id)!) peak.set(a.id, n);
    }
    sampleTimes.push(Math.round(w.t - spawnT));
    nextSample += SAMPLE;
    if (live === 0) break;
  }
}

const end = snap(w);
console.log(`samples at +s: [${sampleTimes.join(", ")}]\n`);
const fin = counts();
const rows = ARCHETYPES.map((a) => ({
  a,
  s: series.get(a.id)!,
  pk: peak.get(a.id)!,
  f: fin.get(a.id)!,
}));
rows.sort((x, y) => y.f - x.f || y.pk - x.pk);
for (const { a, s, pk, f } of rows) {
  const verdict =
    f >= PER * 2 ? "GREW" : f >= PER ? "HELD" : f > 0 ? "DECLINED" : "GONE";
  console.log(
    `[${a.cls.padEnd(6)}] ${a.id.padEnd(14)} ` +
      `peak=${String(pk).padStart(3)} final=${String(f).padStart(3)} ` +
      `${verdict.padEnd(8)} [${s.join(",")}]`,
  );
}
console.log(
  `\nworld: live=${w.creatures.length} ` +
    `births=${end.births - base.births} ` +
    `deaths{starve=${end.dStarve - base.dStarve} ` +
    `mem=${end.dMembrane - base.dMembrane} aa=${end.dAa - base.dAa}} ` +
    `food=${w.particles.length}`,
);
console.log(`# done in ${((Date.now() - t0) / 1000).toFixed(0)}s wall`);
