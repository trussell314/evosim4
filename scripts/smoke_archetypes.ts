// Per-archetype 5-sim-min smoke test. For each of the 15 founder
// archetypes: a fresh seeded world is filled with food (delayedSpawn
// seed ramp) with founder rescue disabled so the ONLY lineages are
// the archetype under test; then 100 instances are injected and the
// world runs 5 sim-min. Reports survival timeline, peak/final
// population, births, death causes, and end body state.
//
//   npx tsx scripts/smoke_archetypes.ts [observeMin] [spawnN]
//
// defaults: 5 min observation, 100 spawned. Throwaway probe.

import { createWorld, step } from "../src/sim";
import { spawnSpeciesInstance } from "../src/sim";
import { ARCHETYPES } from "../src/genome-archetypes";

const OBSERVE_MIN = Number(process.argv[2] ?? 5);
const SPAWN_N = Number(process.argv[3] ?? 100);
const DT = 1 / 60;
const WARMUP_T = 120; // let the seed ramp build a food base first
const OBSERVE_T = OBSERVE_MIN * 60;
const SAMPLE = 30; // sim-seconds between population samples
const SEED = 4242;

interface Stats {
  births: number;
  dStarve: number;
  dMembrane: number;
  dMrna: number;
  dAa: number;
  dCull: number;
}
function snap(w: { stats?: Stats }): Stats {
  const s = (w.stats ?? {}) as Partial<Stats>;
  return {
    births: s.births ?? 0,
    dStarve: s.dStarve ?? 0,
    dMembrane: s.dMembrane ?? 0,
    dMrna: s.dMrna ?? 0,
    dAa: s.dAa ?? 0,
    dCull: s.dCull ?? 0,
  };
}

function meanATP(w: { creatures: { energy: number }[] }): number {
  const n = w.creatures.length;
  if (!n) return 0;
  let s = 0;
  for (const c of w.creatures) s += c.energy;
  return s / n;
}
function meanR(w: { creatures: { r: number }[] }): number {
  const n = w.creatures.length;
  if (!n) return 0;
  let s = 0;
  for (const c of w.creatures) s += c.r;
  return s / n;
}

const t0 = Date.now();
console.log(
  `# archetype smoke: spawn ${SPAWN_N}, observe ${OBSERVE_MIN}min, ` +
    `warmup ${WARMUP_T}s, seed ${SEED}\n`,
);

for (const a of ARCHETYPES) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = createWorld(800, 600, { delayedSpawn: true, seed: SEED }) as any;
  w.foundersEnabled = false; // isolate: only this archetype's lineage

  while (w.t < WARMUP_T) step(w, DT);
  const particlesAtSpawn = w.particles.length;

  let spawned = 0;
  for (let i = 0; i < SPAWN_N; i++) {
    if (spawnSpeciesInstance(w, a.genome)) spawned++;
  }
  const base = snap(w);
  const spawnT = w.t;

  let peak = w.creatures.length;
  let extinctAt = -1;
  const series: number[] = [];
  let nextSample = spawnT + SAMPLE;
  const endT = spawnT + OBSERVE_T;
  while (w.t < endT) {
    step(w, DT);
    const n = w.creatures.length;
    if (n > peak) peak = n;
    if (n === 0 && extinctAt < 0) extinctAt = w.t - spawnT;
    if (w.t >= nextSample) {
      series.push(n);
      nextSample += SAMPLE;
    }
  }

  const end = snap(w);
  const dB = end.births - base.births;
  const dStarve = end.dStarve - base.dStarve;
  const dMem = end.dMembrane - base.dMembrane;
  const dMrna = end.dMrna - base.dMrna;
  const dAa = end.dAa - base.dAa;
  const dCull = end.dCull - base.dCull;
  const finalN = w.creatures.length;

  const verdict =
    finalN >= spawned * 0.8 && dB > 0
      ? "THRIVING"
      : finalN > 0 && dB > 0
        ? "PERSISTING"
        : finalN > 0
          ? "SURVIVING (no repro)"
          : extinctAt >= 0 && extinctAt < 30
            ? "DIED FAST"
            : "DIED OUT";

  console.log(
    `[${a.cls.padEnd(6)}] ${a.id.padEnd(14)} ` +
      `spawned=${String(spawned).padStart(3)} ` +
      `food@spawn=${String(particlesAtSpawn).padStart(4)}  ` +
      `${verdict}`,
  );
  console.log(
    `   pop(+30s..+${OBSERVE_T}s/${SAMPLE}s): [${series.join(", ")}]`,
  );
  console.log(
    `   peak=${peak} final=${finalN} births=${dB} ` +
      `deaths{starve=${dStarve} mem=${dMem} mrna=${dMrna} aa=${dAa} cull=${dCull}} ` +
      (extinctAt >= 0 ? `extinct@+${extinctAt.toFixed(0)}s ` : "") +
      `endATP=${meanATP(w).toFixed(1)} endR=${meanR(w).toFixed(1)}`,
  );
  console.log();
}

console.log(`# done in ${((Date.now() - t0) / 1000).toFixed(0)}s wall`);
