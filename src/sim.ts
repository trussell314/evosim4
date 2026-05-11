// Pure simulation. No DOM access.
//
// Units: pixels for length, seconds for time.
// World is "basically 2D" — a thin z-slice (a few mm at our scale) so
// particles can shift back/forth in depth and occasionally pass each
// other in z. Water density is the reference (= 1).

export type MaterialId =
  | "rock"
  | "sand"
  | "clay"
  | "organic"
  | "lipid"
  | "gas";

export interface Material {
  id: MaterialId;
  density: number;  // relative to water
  color: string;
}

export const MATERIALS: Record<MaterialId, Material> = {
  rock:    { id: "rock",    density: 2.6, color: "#5b4a3a" },
  sand:    { id: "sand",    density: 1.9, color: "#c9b074" },
  clay:    { id: "clay",    density: 1.4, color: "#8c8175" },
  organic: { id: "organic", density: 1.0, color: "#7fb069" },
  lipid:   { id: "lipid",   density: 0.7, color: "#f0d264" },
  gas:     { id: "gas",     density: 0.2, color: "#cfe2ff" },
};

const SEED_WEIGHTS: Array<[MaterialId, number]> = [
  ["rock",    1.0],
  ["sand",    3.0],
  ["clay",    3.0],
  ["organic", 2.0],
  ["lipid",   1.5],
  ["gas",     0.5],
];

export interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  r: number;
  material: MaterialId;
}

export interface World {
  width: number;
  height: number;
  depth: number;            // thin z-slice extent
  t: number;
  particles: Particle[];

  // Forcing.
  gravity: number;          // px/s^2, downward (+y)
  drag: number;             // 1/s, linear drag

  // Surface chop: small wavelength, short period, decays fast with depth.
  surfaceAmp: number;
  surfaceLength: number;
  surfacePeriod: number;
  surfaceDecay: number;

  // Slow swell: long wavelength, long period, reaches deep but gently.
  swellAmp: number;
  swellLength: number;
  swellPeriod: number;
  swellDecay: number;

  // Mild z-stirring tied to swell phase.
  zStirAmp: number;

  // Collision response.
  restitution: number;
  zWallRestitution: number; // bounce off front/back walls
  collisionIters: number;
}

export function createWorld(width: number, height: number): World {
  const world: World = {
    width, height,
    depth: 24,
    t: 0,
    particles: [],
    gravity: 220,
    drag: 0.6,

    surfaceAmp: 130,
    surfaceLength: 240,
    surfacePeriod: 2.4,
    surfaceDecay: 120,

    swellAmp: 22,
    swellLength: 820,
    swellPeriod: 8.5,
    swellDecay: 520,

    zStirAmp: 9,

    restitution: 0.15,
    zWallRestitution: 0.6,
    collisionIters: 2,
  };
  seed(world, 500);
  return world;
}

export function seed(world: World, n: number): void {
  world.particles.length = 0;
  for (let i = 0; i < n; i++) {
    const r = 2 + Math.random() * 4;
    world.particles.push({
      x: Math.random() * world.width,
      y: Math.random() * world.height * 0.85,
      z: r + Math.random() * (world.depth - 2 * r),
      vx: 0,
      vy: 0,
      vz: (Math.random() - 0.5) * 20,
      r,
      material: pickMaterial(),
    });
  }
}

function pickMaterial(): MaterialId {
  let total = 0;
  for (const [, w] of SEED_WEIGHTS) total += w;
  let pick = Math.random() * total;
  for (const [id, w] of SEED_WEIGHTS) {
    pick -= w;
    if (pick <= 0) return id;
  }
  return SEED_WEIGHTS[SEED_WEIGHTS.length - 1][0];
}

function mass(p: Particle): number {
  // Thin slice: treat particles as flat disks; mass ~ density * area.
  return MATERIALS[p.material].density * Math.PI * p.r * p.r;
}

export function step(world: World, dt: number): void {
  world.t += dt;
  const kS = (2 * Math.PI) / world.surfaceLength;
  const wS = (2 * Math.PI) / world.surfacePeriod;
  const kL = (2 * Math.PI) / world.swellLength;
  const wL = (2 * Math.PI) / world.swellPeriod;

  // Forces + integration.
  for (const p of world.particles) {
    const density = MATERIALS[p.material].density;
    const ay = world.gravity * (1 - 1 / density);

    const surface =
      world.surfaceAmp *
      Math.sin(kS * p.x - wS * world.t) *
      Math.exp(-p.y / world.surfaceDecay);
    const swell =
      world.swellAmp *
      Math.sin(kL * p.x - wL * world.t) *
      Math.exp(-p.y / world.swellDecay);
    const ax = surface + swell;

    // Mild z forcing so depth motion doesn't fully damp out.
    const az =
      world.zStirAmp *
      Math.sin(wL * world.t + kL * p.x + 1.0) *
      Math.exp(-p.y / world.swellDecay);

    p.vx += (ax - world.drag * p.vx) * dt;
    p.vy += (ay - world.drag * p.vy) * dt;
    p.vz += (az - world.drag * p.vz) * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
  }

  resolveCollisions(world);

  // Walls.
  for (const p of world.particles) {
    if (p.y + p.r > world.height) {
      p.y = world.height - p.r;
      if (p.vy > 0) p.vy = 0;
    }
    if (p.y - p.r < 0) {
      p.y = p.r;
      if (p.vy < 0) p.vy = 0;
    }
    // x wraps.
    if (p.x < 0) p.x += world.width;
    else if (p.x >= world.width) p.x -= world.width;
    // z reflects (front/back glass walls).
    if (p.z < p.r) {
      p.z = p.r;
      if (p.vz < 0) p.vz = -p.vz * world.zWallRestitution;
    } else if (p.z > world.depth - p.r) {
      p.z = world.depth - p.r;
      if (p.vz > 0) p.vz = -p.vz * world.zWallRestitution;
    }
  }
}

function resolveCollisions(world: World): void {
  const ps = world.particles;
  const n = ps.length;
  const e = world.restitution;
  for (let pass = 0; pass < world.collisionIters; pass++) {
    for (let i = 0; i < n; i++) {
      const a = ps[i];
      const ma = mass(a);
      for (let j = i + 1; j < n; j++) {
        const b = ps[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dz = b.z - a.z;
        const minDist = a.r + b.r;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq >= minDist * minDist) continue;
        let dist = Math.sqrt(distSq);
        if (dist < 1e-6) { dx = 1; dy = 0; dz = 0; dist = 1; }
        const nx = dx / dist;
        const ny = dy / dist;
        const nz = dz / dist;
        const overlap = minDist - dist;
        const mb = mass(b);
        const total = ma + mb;
        const corrA = overlap * (mb / total);
        const corrB = overlap * (ma / total);
        a.x -= nx * corrA;
        a.y -= ny * corrA;
        a.z -= nz * corrA;
        b.x += nx * corrB;
        b.y += ny * corrB;
        b.z += nz * corrB;
        const rvx = b.vx - a.vx;
        const rvy = b.vy - a.vy;
        const rvz = b.vz - a.vz;
        const vN = rvx * nx + rvy * ny + rvz * nz;
        if (vN < 0) {
          const j_imp = (-(1 + e) * vN) / (1 / ma + 1 / mb);
          const ix = nx * j_imp;
          const iy = ny * j_imp;
          const iz = nz * j_imp;
          a.vx -= ix / ma;
          a.vy -= iy / ma;
          a.vz -= iz / ma;
          b.vx += ix / mb;
          b.vy += iy / mb;
          b.vz += iz / mb;
        }
      }
    }
  }
}
