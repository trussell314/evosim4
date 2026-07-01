// Probe: particle count over time. The user reported "infinite
// seeding" past 40 in-game minutes. After the evacuator + spawn fix,
// the population should ramp up over the first ~3 min and then sit
// at a stable level set by dissolution / aeration balance.
import { createWorld, step } from "../src/sim";

const w = createWorld(800, 600, { seed: 1, delayedSpawn: true });
const samples: { t: number; n: number }[] = [];
for (let i = 0; i < 60 * 60 * 5; i++) {  // 5 sim minutes
  step(w, 1 / 60);
  if (i % (60 * 15) === 0) samples.push({ t: w.t, n: w.particles.length });
}
samples.push({ t: w.t, n: w.particles.length });
console.log("t(sim s)   particles");
for (const s of samples) {
  console.log(`  ${s.t.toFixed(1).padStart(7)}    ${s.n.toString().padStart(5)}`);
}
