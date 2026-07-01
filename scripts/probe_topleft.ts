// Find all particles in the top-left rock area, distinguishing
// inside-polygon, edge-buffer, and clear-water positions.
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

const w = createWorld(800, 600, { seed: 1 });
for (let i = 0; i < 2200; i++) step(w, 1/60);

// Find polygon AABBs
console.log("Obstacles:");
for (let i = 0; i < w.obstacles.length; i++) {
  const ob = w.obstacles[i];
  console.log(`  [${i}] x=[${ob.minX.toFixed(1)},${ob.maxX.toFixed(1)}] y=[${ob.minY.toFixed(1)},${ob.maxY.toFixed(1)}] verts=${ob.polygon?.length ?? 0}`);
}

// Sample top-left region
console.log(`\nTop-left region (x<200, y<150) at t=${w.t.toFixed(1)}:`);
let total = 0, inAir = 0, atSurface = 0;
for (const p of w.particles as Array<{ x: number; y: number; chemId: number; r: number }>) {
  if (p.x > 200 || p.y > 150) continue;
  total++;
  if (p.y < 30) inAir++;
  else if (p.y < 80) atSurface++;
}
console.log(`  total particles in top-left bbox: ${total}`);
console.log(`  y<30 (air zone): ${inAir}`);
console.log(`  30<=y<80 (surface band): ${atSurface}`);
console.log(`  y>=80 (water): ${total - inAir - atSurface}`);

// Sample raw positions
console.log(`\nFirst 10 particles in top-left bbox:`);
let n = 0;
for (const p of w.particles as Array<{ x: number; y: number; chemId: number; r: number; idx?: number }>) {
  if (p.x > 200 || p.y > 150) continue;
  if (n++ >= 10) break;
  // Check distance to each polygon edge
  let bestD = Infinity;
  let bestOb = -1;
  for (let i = 0; i < w.obstacles.length; i++) {
    const ob = w.obstacles[i] as Obstacle;
    if (!ob.polygon) continue;
    for (let j = 0, jj = ob.polygon.length - 1; j < ob.polygon.length; jj = j++) {
      const ax = ob.polygon[jj].x, ay = ob.polygon[jj].y;
      const bx = ob.polygon[j].x, by = ob.polygon[j].y;
      const ex = bx - ax, ey = by - ay;
      const lenSq = ex * ex + ey * ey;
      let t = 0;
      if (lenSq > 1e-12) { t = ((p.x - ax)*ex + (p.y - ay)*ey) / lenSq; if (t < 0) t = 0; else if (t > 1) t = 1; }
      const epx = ax + ex * t, epy = ay + ey * t;
      const ddx = epx - p.x, ddy = epy - p.y;
      const d2 = ddx*ddx + ddy*ddy;
      if (d2 < bestD) { bestD = d2; bestOb = i; }
    }
  }
  const inside = bestOb >= 0 && pointInPolygon(p.x, p.y, w.obstacles[bestOb].polygon!);
  console.log(`  (${p.x.toFixed(1)},${p.y.toFixed(1)})  chem=${p.chemId}  r=${p.r.toFixed(2)}  dEdge=${Math.sqrt(bestD).toFixed(2)}  ob=${bestOb}  inside=${inside}`);
}
