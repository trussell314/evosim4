// Probe: after the sim has been running, count how many particles
// have centers inside any rock polygon. If evacuateRocks is doing
// its job, this should be 0 at every tick.
import { createWorld, step, type World, type Obstacle } from "../src/sim";

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

function countInside(w: World): { particles: number; creatures: number; firstFew: string[] } {
  let pc = 0, cc = 0;
  const firstFew: string[] = [];
  for (let i = 0; i < w.particles.length; i++) {
    const p = w.particles[i];
    for (const ob of w.obstacles as Obstacle[]) {
      if (!ob.polygon) continue;
      if (p.x < ob.minX || p.x > ob.maxX || p.y < ob.minY || p.y > ob.maxY) continue;
      if (pointInPolygon(p.x, p.y, ob.polygon)) {
        pc++;
        if (firstFew.length < 6) firstFew.push(`p[${i}] (${p.x.toFixed(1)},${p.y.toFixed(1)}) chemId=${p.chemId}`);
        break;
      }
    }
  }
  for (const c of w.creatures) {
    for (const ob of w.obstacles as Obstacle[]) {
      if (!ob.polygon) continue;
      if (c.x < ob.minX || c.x > ob.maxX || c.y < ob.minY || c.y > ob.maxY) continue;
      if (pointInPolygon(c.x, c.y, ob.polygon)) {
        cc++;
        if (firstFew.length < 6) firstFew.push(`c[${c.id}] (${c.x.toFixed(1)},${c.y.toFixed(1)})`);
        break;
      }
    }
  }
  return { particles: pc, creatures: cc, firstFew };
}

// Use portrait so the polygons get the same shape the user sees.
const w = createWorld(800, 600, { seed: 1 });
for (let i = 0; i < 1800; i++) step(w, 1 / 60);
console.log(`t=${w.t.toFixed(1)} particles=${w.particles.length} creatures=${w.creatures.length}`);
const r = countInside(w);
console.log(`INSIDE ROCK: particles=${r.particles}  creatures=${r.creatures}`);
for (const s of r.firstFew) console.log(`  ${s}`);
