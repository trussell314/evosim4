// Trace evacuateRocks behavior. Spawns a particle inside a known-rock
// position and steps the sim, watching whether evacuateRocks actually
// removes it.
import { createWorld, step, pushParticle, type Obstacle } from "../src/sim";
import { CHEM_MIN } from "../src/sim/chem-ids";

function pointInPolygon(x: number, y: number, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const it = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi);
    if (it) inside = !inside;
  }
  return inside;
}

const w = createWorld(600, 800, { seed: 1 });
console.log(`obstacles: ${w.obstacles.length}`);
for (const ob of w.obstacles as Obstacle[]) {
  console.log(`  AABB x=[${ob.minX.toFixed(1)},${ob.maxX.toFixed(1)}]  y=[${ob.minY.toFixed(1)},${ob.maxY.toFixed(1)}]  poly?=${!!ob.polygon}`);
}

// Position known to be inside top-left rock body.
const tx = 2, ty = 100;
const inside = (w.obstacles as Obstacle[]).some(ob => ob.polygon && pointInPolygon(tx, ty, ob.polygon));
console.log(`\ntest point (${tx},${ty}) inside any polygon: ${inside}`);

const p = pushParticle(w, { x: tx, y: ty, z: 12, vx: 0, vy: 0, vz: 0, r: 1, chemId: CHEM_MIN, density: 1.5 });
console.log(`pushed particle: idx=${p.idx} pos=(${p.x},${p.y})`);
console.log(`particles in world before step: ${w.particles.length}`);

step(w, 1/60);

const stillThere = w.particles.find(q => Math.abs(q.x - tx) < 1 && Math.abs(q.y - ty) < 1);
console.log(`particles in world after 1 step: ${w.particles.length}`);
console.log(`our particle still there? ${!!stillThere}`);
if (stillThere) {
  console.log(`  pos after step: (${stillThere.x.toFixed(2)},${stillThere.y.toFixed(2)})`);
}
