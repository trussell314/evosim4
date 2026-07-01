// Probe: run the sim with evacuateRocks temporarily bypassed and
// check whether particles end up inside rock through collision alone.
// If collision is sufficient, INSIDE ROCK stays at 0 (or near 0).
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
        if (firstFew.length < 6) firstFew.push(`p[${i}] (${p.x.toFixed(1)},${p.y.toFixed(1)}) chemId=${p.chemId} r=${p.r.toFixed(2)}`);
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
        break;
      }
    }
  }
  return { particles: pc, creatures: cc, firstFew };
}

const w = createWorld(800, 600, { seed: 1, delayedSpawn: true });
for (let i = 0; i < 3600; i++) step(w, 1 / 60);
console.log(`t=${w.t.toFixed(1)} particles=${w.particles.length} creatures=${w.creatures.length}`);
const r = countInside(w);
console.log(`INSIDE ROCK: particles=${r.particles}  creatures=${r.creatures}`);
for (const s of r.firstFew) console.log(`  ${s}`);

// Sample particles near rock surface
let nearRock = 0, ablySettled = 0;
for (const p of w.particles) {
  for (const ob of w.obstacles as Obstacle[]) {
    if (p.x < ob.minX - 5 || p.x > ob.maxX + 5 || p.y < ob.minY - 5 || p.y > ob.maxY + 5) continue;
    const inside = ob.polygon && pointInPolygon(p.x, p.y, ob.polygon);
    if (!inside) {
      nearRock++;
      // sediment = at rest near a rock surface
      if (Math.abs(p.vx) < 1 && Math.abs(p.vy) < 1) ablySettled++;
    }
    break;
  }
}
console.log(`near-rock particles: ${nearRock}, settled-on-rock: ${ablySettled}`);
