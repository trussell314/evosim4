// Per-pass mass-leak localizer. Runs with MASS_AUDIT on; dumps which
// step pass mints molar mass. Run: npx tsx scripts/probe_diag.ts

import { createWorld, step, MASS_AUDIT } from "../src/sim";
import { writeFileSync } from "node:fs";

const OUT = "/tmp/probe_diag.txt";
const DT = 1 / 60;
const STEPS = Math.round(30 / DT);
const world = createWorld(800, 600, { delayedSpawn: true });
MASS_AUDIT.on = true;
for (let s = 0; s < STEPS; s++) step(world, DT);
const rows = [...MASS_AUDIT.acc.entries()]
  .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
  .map(([k, v]) => `${k.padEnd(16)} netMolarDelta=${v.toFixed(0)}`);
writeFileSync(OUT, `ticks=${MASS_AUDIT.ticks}\n` + rows.join("\n") + "\nDONE\n");
console.log("done\n" + rows.join("\n"));
