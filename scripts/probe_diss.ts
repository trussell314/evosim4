// Dissolution / seed-ramp watcher. Samples every 0.5 sim-sec; runs
// until the initial ramp latches (world.initialSeedDone), then keeps
// going for 60 more sim-sec. Appends to /tmp/probe_diss.txt so partial
// progress is readable. Run: npx tsx scripts/probe_diss.ts

import { createWorld, step, CHEM_BASE_DENSITY } from "../src/sim";
import { appendFileSync, writeFileSync } from "node:fs";

const OUT = "/tmp/probe_diss.txt";
writeFileSync(OUT, "t      done parts  pMass    dissolved  reserve    cells\n");
const DT = 1 / 60;
const STRIDE = 96;
const world = createWorld(800, 600, { delayedSpawn: true }) as any;

const fieldSum = (a: Float32Array): number => {
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s;
};
function particleMass(): number {
  const ps = world.particleStore; let m = 0;
  for (let i = 0; i < world.particles.length; i++) {
    const r = ps.r[i];
    const d = ps.density[i] || (CHEM_BASE_DENSITY[ps.chemId[i]] || 1);
    m += d * (4 / 3) * Math.PI * r * r * r;
  }
  return m;
}
function sample(): void {
  appendFileSync(OUT,
    `${world.t.toFixed(1).padStart(6)} ${world.initialSeedDone ? "Y" : "."}    ` +
    `${String(world.particles.length).padStart(5)} ` +
    `${particleMass().toFixed(0).padStart(7)}  ` +
    `${fieldSum(world.ambient).toFixed(0).padStart(9)}  ` +
    `${fieldSum(world.reserve).toFixed(0).padStart(9)}  ` +
    `${String(world.creatures.length).padStart(4)}\n`);
}

let doneAt = -1;
const MAX_T = 600;
for (let s = 0; world.t < MAX_T; s++) {
  step(world, DT);
  if (doneAt < 0 && world.initialSeedDone) doneAt = world.t;
  if (s % 30 === 0) sample(); // every 0.5 sim-sec
  if (doneAt >= 0 && world.t >= doneAt + 60) break;
}
sample();
appendFileSync(OUT, `--- ramp latched at t=${doneAt.toFixed(2)}s; ran ${(world.t - doneAt).toFixed(1)}s past it ---\nDONE\n`);
console.log("done");
