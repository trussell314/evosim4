// Print the per-column rock-top y so we can see the spawn-eligible columns.
import { createWorld } from "../src/sim";

const W = 800, H = 600;
const w = createWorld(W, H, { seed: 1, delayedSpawn: true });
const heightmap = w.terrainHeightmap!;
const surfaceY = w.surfaceY;
console.log(`surfaceY=${surfaceY.toFixed(1)} width=${W} heightmap.length=${heightmap.length}`);

const BINS = 20;
const step = Math.floor(heightmap.length / BINS);
for (let b = 0; b < BINS; b++) {
  let minTop = Infinity, maxTop = -Infinity, sumTop = 0, nFin = 0;
  let clearCols = 0;
  for (let x = b * step; x < (b + 1) * step; x++) {
    const t = heightmap[x];
    if (t === Number.POSITIVE_INFINITY) {
      clearCols++;
    } else {
      if (t < minTop) minTop = t;
      if (t > maxTop) maxTop = t;
      sumTop += t;
      nFin++;
    }
  }
  const avg = nFin > 0 ? sumTop / nFin : Infinity;
  const x0 = b * step, x1 = (b + 1) * step;
  console.log(
    `[${x0.toString().padStart(4)}-${x1.toString().padStart(4)}]  clear=${clearCols}/${step}  topY min=${minTop === Infinity ? "—" : minTop.toFixed(0)} max=${maxTop === -Infinity ? "—" : maxTop.toFixed(0)} avg=${avg === Infinity ? "—" : avg.toFixed(0)}`,
  );
}
