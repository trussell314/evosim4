// Per-phase timing probe. Runs the sim for N ticks with the profile
// enabled, prints the per-phase ms/tick averages.
import { createWorld, step } from "../src/sim";
import { makeProfile } from "../src/sim/profile";

const TICKS = parseInt(process.argv[2] ?? "600", 10);
const SEED = parseInt(process.argv[3] ?? "1", 10);
const w = createWorld(800, 600, { seed: SEED });
w.profile = makeProfile();
const t0 = performance.now();
for (let i = 0; i < TICKS; i++) step(w, 1 / 60);
const total = performance.now() - t0;
const p = w.profile!;
const n = p.ticks || TICKS;
const phase = (label: string, ms: number) => {
  const each = (ms / n).toFixed(3);
  const pct = total > 0 ? ((ms / total) * 100).toFixed(1) : "0";
  console.log(`  ${label.padEnd(16)} ${each.padStart(8)} ms/tick   (${pct.padStart(5)}% wall)`);
};
console.log(`ran ${n} ticks in ${total.toFixed(0)} ms (${(total/n).toFixed(2)} ms/tick avg)`);
console.log(`  particles=${w.particles.length}  creatures=${w.creatures.length}`);
console.log("phase breakdown:");
phase("bonds",        p.bonds);
phase("forces",       p.forces);
phase("creatures",    p.creatures);
phase("particleColl", p.particleColl);
phase("creatureColl", p.creatureColl);
phase("sedimentColl", p.sedimentColl);
phase("obstacleColl", p.obstacleColl);
phase("walls",        p.walls);
phase("aerate",       p.aerate);
phase("replenish",    p.replenish);
phase("prune",        p.prune);
const tracked = p.bonds + p.forces + p.creatures + p.particleColl + p.creatureColl
              + p.sedimentColl + p.obstacleColl + p.walls + p.aerate + p.replenish + p.prune;
console.log(`  TRACKED          ${(tracked/n).toFixed(3).padStart(8)} ms/tick   (untracked = ${((total - tracked)/n).toFixed(3)} ms)`);
