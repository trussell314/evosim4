// Post-fix verification: per-pass mass deltas + total molar trajectory.
import { createWorld, step, MASS_AUDIT } from "../src/sim";
import { appendFileSync, writeFileSync } from "node:fs";

const OUT = "/tmp/probe_diag.txt";
writeFileSync(OUT, "");
const DT = 1 / 60;
const STEPS = Math.round(28 / DT);
const world = createWorld(800, 600, { delayedSpawn: true });
MASS_AUDIT.on = true;
// snapshot total molar via the audit fn by marking a no-op label
for (let s = 0; s < STEPS; s++) {
  step(world, DT);
  if (s % (60 * 10) === 0) {
    // MASS_AUDIT.last is refreshed each step start; read after a step
    appendFileSync(OUT, `t=${world.t.toFixed(0).padStart(3)} totalMolar=${MASS_AUDIT.last.toFixed(0).padStart(9)} cells=${world.creatures.length} parts=${world.particles.length}\n`);
  }
}
const rows = [...MASS_AUDIT.acc.entries()]
  .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
  .map(([k, v]) => `${k.padEnd(16)} netMolarDelta=${v.toFixed(0)}`);
appendFileSync(OUT, "--- per-pass over " + MASS_AUDIT.ticks + " ticks ---\n" + rows.join("\n") + "\nDONE\n");
console.log("done");
