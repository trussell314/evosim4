// Static rocky terrain: geometry packing, derived per-column maps, and
// the cheap point/disc terrain queries. All pure or world-mutating-only
// helpers -- no RNG, no module-level state. generateObstacles in sim.ts
// orchestrates these (it owns the vent wiring + the SURFACE_Y_FRAC the
// surface maps key off), but the heavy geometry math lives here.
//
// Geometry comes from hand-authored normalized polygons in
// ./terrain-shapes.ts, scaled to the world and lobe-packed so the
// existing circle-vs-circle obstacle collision handles them.

import type { World, Obstacle, ObstacleLobe } from "./core";

// Push a terrain polygon as an Obstacle with lobes packed inside.
// Centralizes the bounding-box / color / z bookkeeping the loop in
// generateObstacles used to repeat per rock.
export function pushTerrainPolygon(world: World, polygon: { x: number; y: number }[], color: string): void {
  if (polygon.length < 3) return;
  const lobes = lobesFromTerrainPolygon(polygon);
  const ob = makeObstacleFromLobes(lobes, color);
  ob.polygon = polygon;
  ob.z = 0;
  for (const v of polygon) {
    if (v.x < ob.minX) ob.minX = v.x;
    if (v.y < ob.minY) ob.minY = v.y;
    if (v.x > ob.maxX) ob.maxX = v.x;
    if (v.y > ob.maxY) ob.maxY = v.y;
  }
  world.obstacles.push(ob);
}

// Pack a polygon's interior with collision lobes. Strategy: rasterize
// a coarse interior grid (one sample every LOBE_PITCH px), keep any
// grid point that's >=LOBE_R inside the polygon, drop a lobe there.
// Yields a "+"-pattern fill that conservatively underapproximates
// the polygon -- particles never tunnel through, but a particle can
// graze a polygon corner without contact. Acceptable for terrain.
function lobesFromTerrainPolygon(polygon: { x: number; y: number }[]): ObstacleLobe[] {
  // Coarse-ish lobe packing -- evacuateRocks is the definitive
  // "inside rock" check via polygon point-in-polygon, so the lobes
  // only need to handle the cheap radial-pushback case for bodies
  // skimming the boundary. Anything that gets all the way inside a
  // polygon is dealt with by the evacuation pass.
  const LOBE_R = 9;
  const LOBE_PITCH = 12;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const v of polygon) {
    if (v.x < minX) minX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.x > maxX) maxX = v.x;
    if (v.y > maxY) maxY = v.y;
  }
  const lobes: ObstacleLobe[] = [];
  // Sample grid. Offset by half-pitch so two adjacent thin polygons
  // (e.g. cave ceiling + lip) don't share a sample row and end up
  // with concentric lobes redundantly covering the boundary.
  for (let y = minY + LOBE_PITCH * 0.5; y <= maxY; y += LOBE_PITCH) {
    for (let x = minX + LOBE_PITCH * 0.5; x <= maxX; x += LOBE_PITCH) {
      if (pointInPolygon(x, y, polygon)) {
        lobes.push({ x, y, r: LOBE_R });
      }
    }
  }
  // Edge fallback: a sliver polygon (e.g. very thin lip) might fit no
  // interior sample. Drop a small lobe at each vertex so collision
  // still has SOMETHING to push off.
  if (lobes.length === 0) {
    for (const v of polygon) lobes.push({ x: v.x, y: v.y, r: LOBE_R * 0.6 });
  }
  return lobes;
}

// Standard ray-cast point-in-polygon. Used by the lobe packer above and
// by the obstacle-evacuation pass in sim.ts.
export function pointInPolygon(x: number, y: number, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function makeObstacleFromLobes(lobes: ObstacleLobe[], color: string): Obstacle {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of lobes) {
    if (l.x - l.r < minX) minX = l.x - l.r;
    if (l.y - l.r < minY) minY = l.y - l.r;
    if (l.x + l.r > maxX) maxX = l.x + l.r;
    if (l.y + l.r > maxY) maxY = l.y + l.r;
  }
  return { minX, minY, maxX, maxY, lobes, color, z: 0 };
}

// Per-column heightmap: topmost rock y per integer x across every
// obstacle. Used as a cheap early-reject in founderTerrainBlocked /
// topTerrainYAtColumn. founderTerrainBlocked falls through to a
// per-obstacle lobe check anyway, so this is purely a fast-path hint
// -- a column that has rock high up but clear water below still gets
// the heightmap top, and the lobe sweep refines the actual
// overlap. Initialized to +Inf so columns with no rock report
// "open water" via the existing semantics.
export function buildTerrainHeightmap(obstacles: Obstacle[], width: number): Float32Array {
  const heightmap = new Float32Array(Math.max(1, Math.floor(width)));
  heightmap.fill(Number.POSITIVE_INFINITY);
  for (const ob of obstacles) {
    if (!ob.polygon) continue;
    const x0 = Math.max(0, Math.floor(ob.minX));
    const x1 = Math.min(heightmap.length - 1, Math.ceil(ob.maxX));
    for (let x = x0; x <= x1; x++) {
      // Top y at this column = smallest y the polygon covers (y down).
      // Done by ray-casting at integer x: find min y where the polygon
      // interior begins. Cheap (one ray per column, <50 vertices).
      let topY = Number.POSITIVE_INFINITY;
      // Walk vertical edges of the polygon; the smallest y where the
      // ray (x = const) crosses an edge bounds the polygon span. Then
      // we also accept any vertex with the matching x range -- a flat
      // top edge contributes only its endpoints to crossings.
      const poly = ob.polygon;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y;
        const xj = poly[j].x, yj = poly[j].y;
        if ((xi <= x && xj >= x) || (xj <= x && xi >= x)) {
          if (xi === xj) {
            // Vertical edge: every y on it is a potential top.
            if (yi < topY) topY = yi;
            if (yj < topY) topY = yj;
          } else {
            const t = (x - xi) / (xj - xi);
            const y = yi + (yj - yi) * t;
            if (y < topY) topY = y;
          }
        }
      }
      if (topY < heightmap[x]) heightmap[x] = topY;
    }
  }
  return heightmap;
}

// Per-column surface-modifier maps derived from the heightmap: how the
// wavy water surface responds to rocks that breach (or nearly breach)
// the still water level at stillSurfaceY. All three are direction-paired
// (from-left when wind blows right, from-right otherwise) and consumed
// by the surface helpers in ./environment.
export interface TerrainSurfaceMaps {
  windExposureFromLeft: Float32Array;
  windExposureFromRight: Float32Array;
  waveOriginFromLeft: Float32Array;
  waveOriginFromRight: Float32Array;
  shoalFromLeft: Float32Array;
  shoalFromRight: Float32Array;
}

export function buildTerrainSurfaceMaps(heightmap: Float32Array, stillSurfaceY: number): TerrainSurfaceMaps {
  // Wind exposure maps. cliffHeight[x] = how far above the still
  // water surface the rock extends at column x (0 if no rock pokes
  // out of the water). A tall cliff casts a wind shadow downwind
  // proportional to its height; exposure ramps from 0 right behind
  // the cliff back up to 1 over SHELTER_DIST_MAX pixels.
  const cliffHeight = new Float32Array(heightmap.length);
  for (let x = 0; x < heightmap.length; x++) {
    const top = heightmap[x];
    if (top !== Number.POSITIVE_INFINITY && top < stillSurfaceY) {
      cliffHeight[x] = stillSurfaceY - top;
    }
  }
  // Shelter distance scales linearly with cliff height so a tiny
  // bump shelters only a few px while a tall cliff shelters far
  // downwind.
  const SHELTER_DIST_PER_HEIGHT = 2;
  const SHELTER_DIST_MAX = 180;
  const buildExposureMap = (fromLeft: boolean): Float32Array => {
    const m = new Float32Array(heightmap.length);
    m.fill(1);
    // For each column, scan UPWIND looking for the tallest cliff
    // within shelter range. The shadow decays linearly with distance.
    const step = fromLeft ? -1 : 1;
    for (let x = 0; x < heightmap.length; x++) {
      // If rock fills this column in the air band, exposure 0.
      if (cliffHeight[x] > 0 && heightmap[x] <= 1) { m[x] = 0; continue; }
      let bestShadow = 0;
      const maxScan = SHELTER_DIST_MAX;
      for (let d = 1; d <= maxScan; d++) {
        const ux = x + step * d;
        if (ux < 0 || ux >= heightmap.length) break;
        const ch = cliffHeight[ux];
        if (ch <= 0) continue;
        const reach = Math.min(SHELTER_DIST_MAX, ch * SHELTER_DIST_PER_HEIGHT);
        if (d > reach) continue;
        // Shelter strength: cliff height normalized vs surfaceY, with
        // linear distance falloff.
        const strength = Math.min(1, ch / stillSurfaceY) * (1 - d / reach);
        if (strength > bestShadow) bestShadow = strength;
      }
      m[x] = Math.max(0, 1 - bestShadow);
    }
    return m;
  };

  // Wave-origin maps: the spatial phase reference for each column. As the
  // wave train sweeps in from the upwind edge, every surface-breaching
  // rock resets the origin to its own (downwind) edge, so leeward water
  // re-forms its own waves from the rock rather than continuing the
  // windward phase. Without this the surface is one global sine and a
  // crest appears to translate straight through a rock.
  const buildWaveOrigin = (fromLeft: boolean): Float32Array => {
    const m = new Float32Array(cliffHeight.length);
    if (fromLeft) {
      let origin = 0;
      for (let x = 0; x < cliffHeight.length; x++) {
        if (cliffHeight[x] > 0) origin = x; // tracks to the rock's far edge
        m[x] = origin;
      }
    } else {
      let origin = cliffHeight.length - 1;
      for (let x = cliffHeight.length - 1; x >= 0; x--) {
        if (cliffHeight[x] > 0) origin = x;
        m[x] = origin;
      }
    }
    return m;
  };

  // Shoaling maps: a wave bound for a surface-breaching rock piles up as
  // it reaches the shallows in front of it. For each open-water column,
  // find the nearest breaching rock DOWNWIND within SHOAL_APRON_PX and
  // boost amplitude, strongest right at the rock face -- so the wave
  // steepens into the rock and then breaks (the rock columns are glassy
  // via exposure 0). Direction-paired: downwind is +x for rightward wind.
  const SHOAL_APRON_PX = 55;
  const SHOAL_GAIN = 1.1; // up to ~2.1x amplitude at the face
  const buildShoal = (fromLeft: boolean): Float32Array => {
    const m = new Float32Array(cliffHeight.length);
    m.fill(1);
    const step = fromLeft ? 1 : -1; // scan downwind for the rock
    for (let x = 0; x < cliffHeight.length; x++) {
      if (cliffHeight[x] > 0) continue; // on the rock: no shoaling (glassy)
      for (let d = 1; d <= SHOAL_APRON_PX; d++) {
        const ux = x + step * d;
        if (ux < 0 || ux >= cliffHeight.length) break;
        if (cliffHeight[ux] > 0) { // rock d px downwind -> shoal, peak at the face
          m[x] = 1 + SHOAL_GAIN * (1 - (d - 1) / SHOAL_APRON_PX);
          break;
        }
      }
    }
    return m;
  };

  return {
    windExposureFromLeft: buildExposureMap(true),
    windExposureFromRight: buildExposureMap(false),
    waveOriginFromLeft: buildWaveOrigin(true),
    waveOriginFromRight: buildWaveOrigin(false),
    shoalFromLeft: buildShoal(true),
    shoalFromRight: buildShoal(false),
  };
}

// True if a candidate body of radius `bodyR` centered at (x, y) would
// overlap any rock. Conservative: tests the candidate disc against
// every obstacle's lobes, which is what the runtime collision pass
// would push out anyway. Used at founder spawn so cells don't enter
// inside the cave, under an outcropping, or stuck in the seafloor.
export function founderTerrainBlocked(world: World, x: number, y: number, bodyR: number): boolean {
  // Per-obstacle lobe test against every rock. With ~5 obstacles and
  // ~30 lobes each this is ~150 ops per attempt -- fine. (The
  // heightmap fast-path that used to short-circuit here only worked
  // for a monotonic seafloor; the hand-authored layout has top-down
  // cliffs that don't fit that assumption, so we rely solely on the
  // lobe sweep now.)
  for (const ob of world.obstacles) {
    if (x + bodyR < ob.minX || x - bodyR > ob.maxX) continue;
    if (y + bodyR < ob.minY || y - bodyR > ob.maxY) continue;
    const lobes = ob.lobes;
    for (let j = 0; j < lobes.length; j++) {
      const l = lobes[j];
      const dx = x - l.x;
      const dy = y - l.y;
      const minDist = bodyR + l.r;
      if (dx * dx + dy * dy < minDist * minDist) return true;
    }
  }
  return false;
}

// Topmost rock surface at column x. Looks up world.terrainHeightmap;
// returns +Inf for columns with no rock (or worlds without terrain).
export function topTerrainYAtColumn(world: World, x: number): number {
  const hm = world.terrainHeightmap;
  if (!hm || hm.length === 0) return Infinity;
  const ix = Math.max(0, Math.min(hm.length - 1, Math.floor(x)));
  return hm[ix];
}
