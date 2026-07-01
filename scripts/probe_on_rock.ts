// Find particles AT or NEAR rock surface (within 3px of polygon edge),
// not just deeply inside. Helps diagnose whether the user sees
// particles on the rock surface vs truly inside the rock body.
import { createWorld, step, type World, type Obstacle } from "../src/sim";

function nearestEdgeDist2(x: number, y: number, poly: { x: number; y: number }[]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j].x, ay = poly[j].y;
    const bx = poly[i].x, by = poly[i].y;
    const ex = bx - ax, ey = by - ay;
    const lenSq = ex * ex + ey * ey;
    let t = 0;
    if (lenSq > 1e-12) {
      t = ((x - ax) * ex + (y - ay) * ey) / lenSq;
      if (t < 0) t = 0; else if (t > 1) t = 1;
    }
    const epx = ax + ex * t, epy = ay + ey * t;
    const ddx = epx - x, ddy = epy - y;
    const d2 = ddx * ddx + ddy * ddy;
    if (d2 < best) best = d2;
  }
  return best;
}

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

function classify(w: World, threshold: number) {
  const stats = { inside: 0, withinBuffer: 0, samples: [] as string[] };
  for (let i = 0; i < w.particles.length; i++) {
    const p = w.particles[i];
    for (const ob of w.obstacles as Obstacle[]) {
      if (!ob.polygon) continue;
      if (p.x < ob.minX - threshold || p.x > ob.maxX + threshold) continue;
      if (p.y < ob.minY - threshold || p.y > ob.maxY + threshold) continue;
      const d2 = nearestEdgeDist2(p.x, p.y, ob.polygon);
      const d = Math.sqrt(d2);
      const inside = pointInPolygon(p.x, p.y, ob.polygon);
      if (inside) {
        stats.inside++;
        if (stats.samples.length < 4) stats.samples.push(`INSIDE  (${p.x.toFixed(1)},${p.y.toFixed(1)}) d=${d.toFixed(2)} chem=${p.chemId}`);
        break;
      } else if (d < threshold) {
        stats.withinBuffer++;
        if (stats.samples.length < 4) stats.samples.push(`NEAR    (${p.x.toFixed(1)},${p.y.toFixed(1)}) d=${d.toFixed(2)} chem=${p.chemId}`);
        break;
      }
    }
  }
  return stats;
}

const w = createWorld(800, 600, { seed: 1 });
for (let i = 0; i < 1800; i++) step(w, 1/60);
console.log(`t=${w.t.toFixed(1)} particles=${w.particles.length}`);
for (const T of [2, 4, 8, 16]) {
  const s = classify(w, T);
  console.log(`  threshold ${T}px:  inside=${s.inside}  within=${s.withinBuffer}`);
}
const s = classify(w, 16);
console.log(`samples:`);
for (const x of s.samples) console.log(`  ${x}`);
