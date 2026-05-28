// Procedural variance for the hand-authored rock polygons. Each fresh
// world (seed != 0) jitters every vertex within a bounded radius so the
// silhouette is subtly different per world while the overall layout
// stays put. Render + collision both read the perturbed polygons, so the
// rocks ARE the new shape, not just drawn that way.
//
// Vertex classes, after scalePolygon has snapped off-canvas anchors to
// the world boundary:
//   - corner-anchored (both coords on a wall): pinned. The corner seal
//     stays exact.
//   - wall-anchored (one coord on a wall): slides along the wall only.
//     The off-axis stays clamped, so the rock never lifts off the wall.
//   - interior: free offset in a random direction within the magnitude.
//
// Magnitude is *relative*: capped at MAGNITUDE * avg(adjacent edge len).
// (Tried min(adjacent) initially -- collapsed to invisible jitter on
// polygons with many short edges because one short neighbour pinned the
// cap to ~1px. avg lets dense-vertex polygons still vary visibly.)
//
// Topology guard: every candidate polygon must (a) have no non-adjacent
// self-intersection, (b) not cross any other rock's polygon, (c) not
// engulf the vent point. On fail, retry up to RETRIES with a fresh inner
// seed; on continued fail, halve the magnitude and try again; if the
// smallest magnitude also fails, that polygon falls back to the
// un-perturbed scaled original.

export interface Vec { x: number; y: number; }

const RETRIES = 32;
// Per-vertex offset cap = MAG * avg(adjacent edge lengths). Using the
// AVERAGE (not min) of the two adjacent edges keeps a vertex with one
// tiny + one long neighbour from collapsing to invisible perturbation.
// The schedule starts large and falls back to smaller mags if the
// topology guard keeps rejecting -- worst case (still rejected at the
// smallest mag) the polygon falls back to the un-perturbed original.
const MAGNITUDES = [0.60, 0.40, 0.25, 0.10];

// Boundary classification against the world box [0,W] x [0,H]. Bitmask:
// 1=left (x==0), 2=right (x==W), 4=top (y==0), 8=bottom (y==H).
function boundaryMask(p: Vec, W: number, H: number, eps = 0.5): number {
  let m = 0;
  if (p.x <= eps) m |= 1;
  if (p.x >= W - eps) m |= 2;
  if (p.y <= eps) m |= 4;
  if (p.y >= H - eps) m |= 8;
  return m;
}

function popcount4(n: number): number {
  return (n & 1) + ((n >> 1) & 1) + ((n >> 2) & 1) + ((n >> 3) & 1);
}

// Inject new vertices along edges -- adds degrees of freedom that the
// subsequent perturbation can shape independently, so the polygon's
// silhouette gains genuinely new bumps between rerolls instead of just
// jittered versions of the same ROCK_POLYGONS skeleton. Each edge has
// SUBDIV_PROB chance to gain one midpoint vertex; for interior edges
// the midpoint also gets a perpendicular offset proportional to edge
// length, for wall-shared edges it stays on the wall.
const SUBDIV_PROB = 0.55;
const SUBDIV_PERP_FRAC = 0.18;
function subdivideEdges(pts: Vec[], W: number, H: number, rng: () => number): Vec[] {
  const n = pts.length;
  const out: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    out.push({ x: a.x, y: a.y });
    if (rng() >= SUBDIV_PROB) continue;
    const t = 0.30 + rng() * 0.40; // bias toward the middle, never at the endpoints
    let mxv = a.x + (b.x - a.x) * t;
    let myv = a.y + (b.y - a.y) * t;
    const sharedWall = boundaryMask(a, W, H) & boundaryMask(b, W, H);
    if (sharedWall === 0) {
      // Interior edge: optional perpendicular bump. Sign is random; magnitude
      // is bounded so the topology guard rarely has to reject the whole
      // perturbation pass over the subdivision alone.
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        const sign = rng() > 0.5 ? 1 : -1;
        const perp = rng() * SUBDIV_PERP_FRAC * len * sign;
        mxv += (-dy / len) * perp;
        myv += (dx / len) * perp;
      }
    }
    // Wall-shared edge: keep the new vertex on the wall (no perpendicular),
    // so the seal stays intact. The perturbation pass will slide it along.
    out.push({ x: mxv, y: myv });
  }
  return out;
}

// Proper segment intersection: returns true only if the open interiors of
// the two segments cross. Endpoint touches and collinear overlaps don't
// count -- adjacent polygon edges share an endpoint and that's fine.
function segmentsCross(a1: Vec, a2: Vec, b1: Vec, b2: Vec): boolean {
  const d1x = a2.x - a1.x, d1y = a2.y - a1.y;
  const d2x = b2.x - b1.x, d2y = b2.y - b1.y;
  const denom = d1x * d2y - d1y * d2x;
  if (denom === 0) return false; // parallel or collinear -> not a proper crossing
  const sx = b1.x - a1.x, sy = b1.y - a1.y;
  const t = (sx * d2y - sy * d2x) / denom;
  const u = (sx * d1y - sy * d1x) / denom;
  // Open intervals: strict inequalities so shared endpoints don't trip.
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
}

function selfIntersects(pts: Vec[]): boolean {
  const n = pts.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a1 = pts[i], a2 = pts[(i + 1) % n];
    // Skip the same edge, immediate neighbour (shared endpoint), and the
    // pair that wraps (i=0 vs j=n-1 shares the wrap endpoint).
    const jStart = i + 2;
    const jEnd = i === 0 ? n - 1 : n;
    for (let j = jStart; j < jEnd; j++) {
      const b1 = pts[j], b2 = pts[(j + 1) % n];
      if (segmentsCross(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

function polygonsCross(a: Vec[], b: Vec[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i], a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const b1 = b[j], b2 = b[(j + 1) % b.length];
      if (segmentsCross(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

// Even-odd ray cast (horizontal +x ray). Used to check that the vent
// point isn't inside a perturbed seafloor polygon.
function pointInPolygon(p: Vec, pts: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const vi = pts[i], vj = pts[j];
    const crossesY = (vi.y > p.y) !== (vj.y > p.y);
    if (!crossesY) continue;
    const xAt = vi.x + (p.y - vi.y) * (vj.x - vi.x) / (vj.y - vi.y);
    if (p.x < xAt) inside = !inside;
  }
  return inside;
}

// Local seeded RNG so perturbation is reproducible from geologySeed
// without touching the world's main rng stream (collision / mutation /
// etc. must stay deterministic against the world seed).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function perturbOnce(
  pts: Vec[], W: number, H: number, rng: () => number, mag: number,
): Vec[] {
  const n = pts.length;
  const out: Vec[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    const eLenA = Math.hypot(p.x - prev.x, p.y - prev.y);
    const eLenB = Math.hypot(next.x - p.x, next.y - p.y);
    const cap = ((eLenA + eLenB) / 2) * mag;
    const mask = boundaryMask(p, W, H);
    if (mask === 0) {
      // Interior: random direction, magnitude in [-cap, +cap] along each axis.
      const theta = rng() * Math.PI * 2;
      const r = rng() * cap;
      out[i] = { x: p.x + Math.cos(theta) * r, y: p.y + Math.sin(theta) * r };
    } else if (popcount4(mask) >= 2) {
      // Corner-anchored: pinned exactly.
      out[i] = { x: p.x, y: p.y };
    } else {
      // Wall-anchored: slide along the wall. The pinned axis stays
      // clamped to 0 or W/H so the rock never lifts off the wall.
      const slide = (rng() * 2 - 1) * cap;
      if (mask & 3) {
        // left or right wall: x is pinned, slide y (clamped to [0,H])
        const y = Math.max(0, Math.min(H, p.y + slide));
        out[i] = { x: p.x, y };
      } else {
        // top or bottom wall: y is pinned, slide x (clamped to [0,W])
        const x = Math.max(0, Math.min(W, p.x + slide));
        out[i] = { x, y: p.y };
      }
    }
  }
  return out;
}

// Perturb each polygon in `scaled` (world-px coords). The vent point is
// guarded -- no perturbed polygon may contain it. seed == 0 returns the
// inputs unchanged (deep-copied so callers can mutate freely), which is
// the default-world / test path so determinism + golden stay byte-identical.
export function perturbPolygons(
  scaled: Vec[][],
  W: number, H: number,
  seed: number,
  vent: Vec,
): Vec[][] {
  const copyAll = (arr: Vec[][]): Vec[][] => arr.map((p) => p.map((v) => ({ x: v.x, y: v.y })));
  if (!seed) return copyAll(scaled);
  const rng = mulberry32(seed);
  const result = copyAll(scaled);
  for (let i = 0; i < scaled.length; i++) {
    // Subdivide once per polygon: gives the perturbation a richer vertex
    // skeleton to work on. Fresh subdivision pattern per reroll (driven
    // by the same rng stream).
    const base = subdivideEdges(scaled[i], W, H, rng);
    let placed = false;
    for (const mag of MAGNITUDES) {
      for (let attempt = 0; attempt < RETRIES; attempt++) {
        const cand = perturbOnce(base, W, H, rng, mag);
        if (selfIntersects(cand)) continue;
        if (pointInPolygon(vent, cand)) continue;
        let crosses = false;
        for (let j = 0; j < result.length; j++) {
          if (j === i) continue;
          if (polygonsCross(cand, result[j])) { crosses = true; break; }
        }
        if (crosses) continue;
        result[i] = cand;
        placed = true;
        break;
      }
      if (placed) break;
    }
    // If even mag=0.05 never validated, result[i] stays at scaled[i].
  }
  return result;
}
