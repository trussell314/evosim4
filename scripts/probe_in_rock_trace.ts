// Trace particle-in-rock state across one full tick to identify
// which sub-phase is creating the inside-rock particles.
import { createWorld, step, type Obstacle, type World } from "../src/sim";

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
function countInside(w: World): number {
  let n = 0;
  for (let i = 0; i < w.particles.length; i++) {
    const p = w.particles[i];
    for (const ob of w.obstacles as Obstacle[]) {
      if (!ob.polygon) continue;
      if (p.x < ob.minX || p.x > ob.maxX || p.y < ob.minY || p.y > ob.maxY) continue;
      if (pointInPolygon(p.x, p.y, ob.polygon)) { n++; break; }
    }
  }
  return n;
}

const w = createWorld(600, 800, { seed: 1 });
for (let i = 0; i < 1800; i++) step(w, 1/60);

// Sample inside-rock counts across many ticks to see the pattern.
const counts: number[] = [];
for (let i = 0; i < 30; i++) {
  step(w, 1/60);
  counts.push(countInside(w));
}
console.log(`inside-rock count per tick (after evacuate, after spawns):`);
console.log(`  min=${Math.min(...counts)}  max=${Math.max(...counts)}  avg=${(counts.reduce((a,b)=>a+b)/counts.length).toFixed(1)}`);
console.log(`  samples: ${counts.slice(0, 10).join(",")}...`);

// Distribution of inside-rock chemIds.
const byChem = new Map<number, number>();
for (const p of w.particles) {
  for (const ob of w.obstacles as Obstacle[]) {
    if (!ob.polygon) continue;
    if (p.x < ob.minX || p.x > ob.maxX || p.y < ob.minY || p.y > ob.maxY) continue;
    if (pointInPolygon(p.x, p.y, ob.polygon)) {
      byChem.set(p.chemId, (byChem.get(p.chemId) ?? 0) + 1);
      break;
    }
  }
}
console.log(`inside-rock by chemId (top 8):`);
const sorted = [...byChem.entries()].sort((a, b) => b[1] - a[1]);
for (const [chem, n] of sorted.slice(0, 8)) console.log(`  chem=${chem}: ${n}`);
