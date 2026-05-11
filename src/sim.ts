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
}

export function createWorld(width: number, height: number): World {
  const world: World = {
    width, height,
    t: 0,
    particles: [],
    gravity: 220,
    drag: 0.9,
    waveAmplitude: 90,
    waveLength: 240,
    wavePeriod: 2.6,
    waveDecay: 180,
  };
  seed(world, 240);
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

export function step(world: World, dt: number): void {
  world.t += dt;
  const k = (2 * Math.PI) / world.waveLength;
  const omega = (2 * Math.PI) / world.wavePeriod;

  for (const p of world.particles) {
    // Net vertical acceleration from gravity + buoyancy (Archimedes).
    // a = g * (1 - rho_water / rho_particle); positive = downward.
    const ay = world.gravity * (1 - 1 / p.density);

    // Surface-driven horizontal wave forcing, decaying with depth.
    const ax =
      world.waveAmplitude *
      Math.sin(k * p.x - omega * world.t) *
      Math.exp(-p.y / world.waveDecay);

    p.vx += (ax - world.drag * p.vx) * dt;
    p.vy += (ay - world.drag * p.vy) * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // Bottom: rest on the floor.
    if (p.y + p.r > world.height) {
      p.y = world.height - p.r;
      if (p.vy > 0) p.vy = 0;
    }
    // Surface: don't escape.
    if (p.y - p.r < 0) {
      p.y = p.r;
      if (p.vy < 0) p.vy = 0;
    }
    // Sides: wrap.
    if (p.x < 0) p.x += world.width;
    else if (p.x >= world.width) p.x -= world.width;
  }
}
