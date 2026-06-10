// Probe: identify "frozen" particles. After running the sim a while,
// find particles whose velocity is exactly zero (the freeze gate
// fired) and report where they live. Also report particles with
// near-zero velocity (settled sediment).
import { createWorld, step } from "../src/sim";

const W = 600, H = 800;  // portrait, matching the user's view
const w = createWorld(W, H, { seed: 1, delayedSpawn: true });
for (let i = 0; i < 60 * 5 * 60; i++) step(w, 1 / 60);

const ps = w.particleStore;
const n = w.particles.length;
let zeroV = 0, tinyV = 0, normalV = 0;
const zeroSamples: string[] = [];
const tinySamples: string[] = [];
for (let i = 0; i < n; i++) {
  const vx = ps.vx[i], vy = ps.vy[i], vz = ps.vz[i];
  const v2 = vx * vx + vy * vy + vz * vz;
  if (v2 === 0) {
    zeroV++;
    if (zeroSamples.length < 8) {
      zeroSamples.push(`(${ps.x[i].toFixed(0)},${ps.y[i].toFixed(0)})`);
    }
  } else if (v2 < 0.01) {
    tinyV++;
    if (tinySamples.length < 8) {
      tinySamples.push(`(${ps.x[i].toFixed(0)},${ps.y[i].toFixed(0)}) v=${Math.sqrt(v2).toFixed(3)}`);
    }
  } else {
    normalV++;
  }
}
console.log(`t=${w.t.toFixed(1)}  particles=${n}`);
console.log(`  v=0 (frozen):     ${zeroV.toString().padStart(4)}   samples: ${zeroSamples.join(" ")}`);
console.log(`  v<0.1 (settled):  ${tinyV.toString().padStart(4)}   samples: ${tinySamples.join(" ")}`);
console.log(`  v>=0.1 (moving):  ${normalV.toString().padStart(4)}`);
console.log(`  world height = ${H}, floor freeze fires at y >= ${H - 2.5}`);
