// Pure simulation. No DOM access.
//
// Units: pixels for length, seconds for time.
// World is "basically 2D" — a thin z-slice so particles can shift back/forth
// in depth and occasionally pass each other in z. Water density = 1.

import {
  type VMState,
  type VMSensors,
  type VMSelf,
  type VMOutputs,
  newVMState,
  newOutputs,
  runTick,
  makeDefaultGenome,
} from "./genome";

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
  ["organic", 3.5],
  ["lipid",   1.5],
  ["gas",     0.5],
];

const MATERIAL_IDS = Object.keys(MATERIALS) as MaterialId[];

export interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  r: number;
  material: MaterialId;
}

export interface Creature {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  r: number;
  density: number;                          // baseline cell density (≈1 = neutral)
  reserves: Record<MaterialId, number>;     // mass per material, in same units as particle mass
  energy: number;                           // abstract energy units
  senseRange: number;                       // px
  thrustAccel: number;                      // px/s^2 max self-applied accel
  genome: Uint8Array;
  vm: VMState;
}

export const MATERIAL_IDS_ORDERED = MATERIAL_IDS;

export interface World {
  width: number;
  height: number;
  depth: number;
  t: number;
  particles: Particle[];
  creatures: Creature[];

  // Forcing.
  gravity: number;
  drag: number;

  surfaceAmp: number;
  surfaceLength: number;
  surfacePeriod: number;
  surfaceDecay: number;

  swellAmp: number;
  swellLength: number;
  swellPeriod: number;
  swellDecay: number;

  zStirAmp: number;

  // Collision response (between particles).
  restitution: number;
  zWallRestitution: number;
  collisionIters: number;
}

// Metabolism & movement constants (hand-tuned for first creature).
const METABOLIZE_RATE = 5;            // mass of organic burned per second
const ENERGY_PER_MASS = 12;           // energy yielded per unit mass burned
const ENERGY_PER_THRUST_SEC = 22;     // energy cost per second at full thrust
const ENERGY_PER_INSTRUCTION = 0.005; // VM bookkeeping cost
const VM_INSTR_BUDGET = 32;           // instructions per tick

export function createWorld(width: number, height: number): World {
  const world: World = {
    width, height,
    depth: 24,
    t: 0,
    particles: [],
    creatures: [],
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
  seedParticles(world, 500);
  world.creatures.push(makeCreature(world.width * 0.5, world.height * 0.3, world.depth * 0.5));
  return world;
}

export function seedParticles(world: World, n: number): void {
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

function emptyReserves(): Record<MaterialId, number> {
  const r = {} as Record<MaterialId, number>;
  for (const id of MATERIAL_IDS) r[id] = 0;
  return r;
}

function makeCreature(x: number, y: number, z: number): Creature {
  const reserves = emptyReserves();
  reserves.organic = 40;
  reserves.lipid = 10;
  return {
    x, y, z,
    vx: 0, vy: 0, vz: 0,
    r: 9,
    density: 1.0,
    reserves,
    energy: 120,
    senseRange: 200,
    thrustAccel: 70,
    genome: makeDefaultGenome(),
    vm: newVMState(),
  };
}

function mass(p: Particle): number {
  return MATERIALS[p.material].density * Math.PI * p.r * p.r;
}

export function step(world: World, dt: number): void {
  world.t += dt;
  applyForces(world, dt);
  updateCreatures(world, dt);
  resolveCollisions(world);
  applyWalls(world);
}

function applyForces(world: World, dt: number): void {
  const kS = (2 * Math.PI) / world.surfaceLength;
  const wS = (2 * Math.PI) / world.surfacePeriod;
  const kL = (2 * Math.PI) / world.swellLength;
  const wL = (2 * Math.PI) / world.swellPeriod;

  const integrate = (
    o: { x: number; y: number; z: number; vx: number; vy: number; vz: number },
    density: number,
  ) => {
    const ay = world.gravity * (1 - 1 / density);
    const surface =
      world.surfaceAmp *
      Math.sin(kS * o.x - wS * world.t) *
      Math.exp(-o.y / world.surfaceDecay);
    const swell =
      world.swellAmp *
      Math.sin(kL * o.x - wL * world.t) *
      Math.exp(-o.y / world.swellDecay);
    const az =
      world.zStirAmp *
      Math.sin(wL * world.t + kL * o.x + 1.0) *
      Math.exp(-o.y / world.swellDecay);
    const ax = surface + swell;

    o.vx += (ax - world.drag * o.vx) * dt;
    o.vy += (ay - world.drag * o.vy) * dt;
    o.vz += (az - world.drag * o.vz) * dt;
    o.x += o.vx * dt;
    o.y += o.vy * dt;
    o.z += o.vz * dt;
  };

  for (const p of world.particles) integrate(p, MATERIALS[p.material].density);
  for (const c of world.creatures) integrate(c, c.density);
}

// Reusable buffers for VM I/O so we don't allocate per tick.
const VM_SENSORS: VMSensors = {
  dx: new Float32Array(6),
  dy: new Float32Array(6),
  dist: new Float32Array(6),
};
const VM_SELF: VMSelf = {
  energy: 0, vx: 0, vy: 0,
  reserve: new Float32Array(6),
};
const VM_OUT: VMOutputs = newOutputs();
const SENSOR_BEST_SQ = new Float32Array(6);

function updateCreatures(world: World, dt: number): void {
  for (const c of world.creatures) {
    // Metabolize organic into energy.
    const burn = Math.min(METABOLIZE_RATE * dt, c.reserves.organic);
    c.reserves.organic -= burn;
    c.energy += burn * ENERGY_PER_MASS;

    // Build per-material nearest-particle sensor readings. These stand in for
    // proper physical sensors (photon / chemical / pressure) until those land.
    populateSensors(c, world);

    // Build self readings.
    VM_SELF.energy = c.energy;
    VM_SELF.vx = c.vx;
    VM_SELF.vy = c.vy;
    for (let i = 0; i < 6; i++) VM_SELF.reserve[i] = c.reserves[MATERIAL_IDS[i]];

    // Run the genome.
    runTick(c.genome, c.vm, VM_SENSORS, VM_SELF, VM_INSTR_BUDGET, VM_OUT);
    c.energy -= VM_OUT.instructions * ENERGY_PER_INSTRUCTION;

    // Apply thrust intent, clamped to thrustAccel magnitude. Energy cost
    // scales with the fraction of full thrust actually used.
    let ax = VM_OUT.thrustX;
    let ay = VM_OUT.thrustY;
    const mag = Math.sqrt(ax * ax + ay * ay);
    if (mag > c.thrustAccel) {
      const k = c.thrustAccel / mag;
      ax *= k; ay *= k;
    }
    const usedFrac = Math.min(1, mag / c.thrustAccel);
    if (c.energy > 0 && usedFrac > 0) {
      c.vx += ax * dt;
      c.vy += ay * dt;
      c.energy -= usedFrac * ENERGY_PER_THRUST_SEC * dt;
    }
    if (c.energy < 0) c.energy = 0;

    // Ingest any particle whose center is inside the cell.
    for (let i = world.particles.length - 1; i >= 0; i--) {
      const p = world.particles[i];
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      const dz = p.z - c.z;
      if (dx * dx + dy * dy + dz * dz < c.r * c.r) {
        c.reserves[p.material] += mass(p);
        world.particles.splice(i, 1);
      }
    }
  }
}

function populateSensors(c: Creature, world: World): void {
  const range = c.senseRange;
  const rangeSq = range * range;
  for (let i = 0; i < 6; i++) {
    VM_SENSORS.dx[i] = 0;
    VM_SENSORS.dy[i] = 0;
    VM_SENSORS.dist[i] = range;
    SENSOR_BEST_SQ[i] = rangeSq;
  }
  for (const p of world.particles) {
    const idx = MATERIAL_IDS.indexOf(p.material);
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const dsq = dx * dx + dy * dy;
    if (dsq < SENSOR_BEST_SQ[idx]) {
      SENSOR_BEST_SQ[idx] = dsq;
      VM_SENSORS.dx[idx] = dx;
      VM_SENSORS.dy[idx] = dy;
      VM_SENSORS.dist[idx] = Math.sqrt(dsq);
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

function applyWalls(world: World): void {
  const wallEach = (
    o: { x: number; y: number; z: number; vx: number; vy: number; vz: number; r: number },
  ): void => {
    if (o.y + o.r > world.height) {
      o.y = world.height - o.r;
      if (o.vy > 0) o.vy = 0;
    }
    if (o.y - o.r < 0) {
      o.y = o.r;
      if (o.vy < 0) o.vy = 0;
    }
    if (o.x < 0) o.x += world.width;
    else if (o.x >= world.width) o.x -= world.width;
    if (o.z < o.r) {
      o.z = o.r;
      if (o.vz < 0) o.vz = -o.vz * world.zWallRestitution;
    } else if (o.z > world.depth - o.r) {
      o.z = world.depth - o.r;
      if (o.vz > 0) o.vz = -o.vz * world.zWallRestitution;
    }
  };
  for (const p of world.particles) wallEach(p);
  for (const c of world.creatures) wallEach(c);
}
