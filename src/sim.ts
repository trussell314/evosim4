// Pure simulation. No DOM access.
//
// Units: pixels for length, seconds for time.
// Water density is the reference (= 1). Particle density is relative.

export interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  r: number;
  density: number;
}

export interface World {
  width: number;
  height: number;
  t: number;
  particles: Particle[];

  // Forcing.
  gravity: number;        // px/s^2, downward
  drag: number;           // 1/s, linear drag on velocity
  waveAmplitude: number;  // px/s^2 peak horizontal accel at surface
  waveLength: number;     // px
  wavePeriod: number;     // s
  waveDecay: number;      // px, depth at which surface forcing falls to 1/e

  // Collision response.
  restitution: number;    // 0 = sticky, 1 = perfectly elastic
  collisionIters: number; // relaxation passes per step
}

export function createWorld(width: number, height: number): World {
  const world: World = {
    width, height,
    t: 0,
    particles: [],
    gravity: 220,
    drag: 0.6,
    waveAmplitude: 110,
    waveLength: 240,
    wavePeriod: 2.6,
    waveDecay: 180,
    restitution: 0.15,
    collisionIters: 2,
  };
  seed(world, 500);
  return world;
}

export function seed(world: World, n: number): void {
  world.particles.length = 0;
  for (let i = 0; i < n; i++) {
    world.particles.push({
      x: Math.random() * world.width,
      y: Math.random() * world.height * 0.85,
      vx: 0,
      vy: 0,
      r: 2 + Math.random() * 4,
      density: 0.4 + Math.random() * 1.8,
    });
  }
}

function mass(p: Particle): number {
  // 2D: treat "volume" as area.
  return p.density * Math.PI * p.r * p.r;
}

export function step(world: World, dt: number): void {
  world.t += dt;
  const k = (2 * Math.PI) / world.waveLength;
  const omega = (2 * Math.PI) / world.wavePeriod;

  // Forces + integration.
  for (const p of world.particles) {
    const ay = world.gravity * (1 - 1 / p.density);
    const ax =
      world.waveAmplitude *
      Math.sin(k * p.x - omega * world.t) *
      Math.exp(-p.y / world.waveDecay);

    p.vx += (ax - world.drag * p.vx) * dt;
    p.vy += (ay - world.drag * p.vy) * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }

  // Pair collisions: position correction + impulse, relaxed over a few passes.
  resolveCollisions(world);

  // Walls (after collisions so nothing escapes).
  for (const p of world.particles) {
    if (p.y + p.r > world.height) {
      p.y = world.height - p.r;
      if (p.vy > 0) p.vy = 0;
    }
    if (p.y - p.r < 0) {
      p.y = p.r;
      if (p.vy < 0) p.vy = 0;
    }
    if (p.x < 0) p.x += world.width;
    else if (p.x >= world.width) p.x -= world.width;
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
        const minDist = a.r + b.r;
        const distSq = dx * dx + dy * dy;
        if (distSq >= minDist * minDist) continue;
        let dist = Math.sqrt(distSq);
        if (dist < 1e-6) { dx = 1; dy = 0; dist = 1; }
        const nx = dx / dist;
        const ny = dy / dist;
        const overlap = minDist - dist;
        const mb = mass(b);
        const total = ma + mb;
        // Position correction (push along normal, mass-weighted).
        const corrA = overlap * (mb / total);
        const corrB = overlap * (ma / total);
        a.x -= nx * corrA;
        a.y -= ny * corrA;
        b.x += nx * corrB;
        b.y += ny * corrB;
        // Impulse only when approaching.
        const rvx = b.vx - a.vx;
        const rvy = b.vy - a.vy;
        const vN = rvx * nx + rvy * ny;
        if (vN < 0) {
          const j_imp = (-(1 + e) * vN) / (1 / ma + 1 / mb);
          const ix = nx * j_imp;
          const iy = ny * j_imp;
          a.vx -= ix / ma;
          a.vy -= iy / ma;
          b.vx += ix / mb;
          b.vy += iy / mb;
        }
      }
    }
  }
}
