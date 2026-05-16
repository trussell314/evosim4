// 5 sim-minute waste probe. Production-like world (delayedSpawn: the
// one-shot seed ramp + founders + waste denature/edible path).
// Run: npx tsx scripts/probe_waste.ts

import { createWorld, step, chemName, CHEM_IDS } from "../src/sim";

const DT = 1 / 60;
const SECONDS = 300;
const STEPS = Math.round(SECONDS / DT);
const W = CHEM_IDS.waste as number;
const C = CHEM_IDS.co2 as number;

const world = createWorld(800, 600, { delayedSpawn: true });
const STRIDE = 96;
const sumField = (arr: Float32Array, chem: number): number => {
  let s = 0;
  for (let b = 0; b + chem < arr.length; b += STRIDE) s += arr[b + chem];
  return s;
};

function sample(): void {
  const byChem = new Map<number, number>();
  const n = world.particles.length;
  for (let i = 0; i < n; i++) {
    const k = world.particleStore.chemId[i];
    byChem.set(k, (byChem.get(k) ?? 0) + 1);
  }
  const top = [...byChem.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([k, v]) => `${chemName(k)}=${v}`).join(" ");
  const waste = byChem.get(W) ?? 0;
  const pct = n > 0 ? ((100 * waste) / n).toFixed(1) : "0";
  console.log(
    `t=${world.t.toFixed(0).padStart(3)}s parts=${String(n).padStart(5)} ` +
    `waste=${String(waste).padStart(5)}(${pct}%) cells=${String(world.creatures.length).padStart(3)} ` +
    `| dissWaste=${sumField(world.ambient, W).toFixed(0)} resWaste=${sumField(world.reserve, W).toFixed(0)} ` +
    `dissCO2=${sumField(world.ambient, C).toFixed(0)} | top: ${top}`,
  );
}

const t0 = performance.now();
for (let s = 0; s < STEPS; s++) {
  step(world, DT);
  if (s % (60 * 30) === 0) sample();
}
sample();
console.log(`done: ${STEPS} steps in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
