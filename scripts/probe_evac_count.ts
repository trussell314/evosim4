import { createWorld, step, _evacDbg, _evacDbgReset } from "../src/sim";

const w = createWorld(600, 800, { seed: 1 });
// Warmup
for (let i = 0; i < 1800; i++) step(w, 1/60);
_evacDbgReset();
// Run 60 more ticks to measure
for (let i = 0; i < 60; i++) step(w, 1/60);
const d = _evacDbg();
console.log(`per 60 ticks:`);
console.log(`  particles tested : ${d.tested}`);
console.log(`  grid-skipped     : ${d.gridSkipped}`);
console.log(`  poly-tested      : ${d.polyTested}`);
console.log(`  evacuated        : ${d.evacuated}`);
console.log(`particle count: ${w.particles.length}`);
