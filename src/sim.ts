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
  mutateGenome,
  genomeMaterialCost,
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
  density: number;
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
  density: number;
  reserves: Record<MaterialId, number>;
  energy: number;
  senseRange: number;
  thrustAccel: number;
  genome: Uint8Array;
  vm: VMState;
  color: string;
  ingestCooldown: number;
  reproduceCooldown: number;
}

export const MATERIAL_IDS_ORDERED = MATERIAL_IDS;

export interface World {
  width: number;
  height: number;
  depth: number;
  t: number;
  particles: Particle[];
  creatures: Creature[];
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
  restitution: number;
  xWallRestitution: number;
  zWallRestitution: number;
  collisionIters: number;
}

// Metabolism & movement.
const METABOLIZE_RATE = 5;
const ENERGY_PER_MASS = 12;
const ENERGY_PER_THRUST_SEC = 22;
const ENERGY_PER_INSTRUCTION = 0.02;
const VM_INSTR_BUDGET = 32;

// Reproduction & ecology.
const MASS_PER_GENOME_BYTE = 3;
const PARTICLE_TARGET = 550;
const PARTICLE_SPAWN_RATE = 30;
const MAX_CREATURES = 80;
const REPRODUCE_COOLDOWN_SEC = 2;

// Ingestion.
const INGEST_ENERGY_COST = 1.5;
const INGEST_COOLDOWN_SEC = 0.35;

// Predation. A cell whose total stored mass exceeds another's by this ratio
// can engulf it on overlap. Eating a whole cell costs the per-event energy
// like a particle but locks the eater out of further ingestion for longer.
const PREDATION_MASS_RATIO = 1.5;
const PREDATION_COOLDOWN_SEC = 0.7;

// Death.
const BASE_METABOLIC_DRAIN = 0.5;
const DEATH_RELEASE_R_MIN = 1.2;
const DEATH_RELEASE_SCATTER = 30;

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
    xWallRestitution: 0.4,
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
      vx: 0, vy: 0, vz: (Math.random() - 0.5) * 20,
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
  const genome = makeDefaultGenome();
  return {
    x, y, z,
    vx: 0, vy: 0, vz: 0,
    r: 9,
    density: 1.0,
    reserves,
    energy: 120,
    senseRange: 200,
    thrustAccel: 70,
    genome,
    vm: newVMState(),
    color: genomeColor(genome),
    ingestCooldown: 0,
    reproduceCooldown: 0,
  };
}

export function genomeColor(genome: Uint8Array): string {
  let h = 5381 >>> 0;
  for (let i = 0; i < genome.length; i++) {
    h = ((h * 33) ^ genome[i]) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue}, 60%, 62%)`;
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
  replenishParticles(world, dt);
}

function replenishParticles(world: World, dt: number): void {
  if (world.particles.length >= PARTICLE_TARGET) return;
  const expected = PARTICLE_SPAWN_RATE * dt;
  let toSpawn = Math.floor(expected);
  if (Math.random() < expected - toSpawn) toSpawn++;
  for (let i = 0; i < toSpawn && world.particles.length < PARTICLE_TARGET; i++) {
    const r = 2 + Math.random() * 4;
    world.particles.push({
      x: Math.random() * world.width,
      y: 0,
      z: r + Math.random() * (world.depth - 2 * r),
      vx: 0, vy: 0, vz: (Math.random() - 0.5) * 20,
      r,
      material: pickMaterial(),
    });
  }
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
    const surface = world.surfaceAmp * Math.sin(kS * o.x - wS * world.t) * Math.exp(-o.y / world.surfaceDecay);
    const swell   = world.swellAmp   * Math.sin(kL * o.x - wL * world.t) * Math.exp(-o.y / world.swellDecay);
    const az      = world.zStirAmp   * Math.sin(wL * world.t + kL * o.x + 1.0) * Math.exp(-o.y / world.swellDecay);
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

// Reusable VM buffers.
const VM_SENSORS: VMSensors = {
  dx: new Float32Array(6),
  dy: new Float32Array(6),
  dist: new Float32Array(6),
  creatureDx: 0, creatureDy: 0, creatureDist: 0, creatureMass: 0,
};
const VM_SELF: VMSelf = {
  energy: 0, vx: 0, vy: 0,
  reserve: new Float32Array(6),
  mass: 0,
};
const VM_OUT: VMOutputs = newOutputs();
const SENSOR_BEST_SQ = new Float32Array(6);

function updateCreatures(world: World, dt: number): void {
  const n = world.creatures.length;
  const dead: number[] = [];
  const eaten = new Set<number>();
  for (let cIdx = 0; cIdx < n; cIdx++) {
    if (eaten.has(cIdx)) continue;
    const c = world.creatures[cIdx];

    c.energy -= BASE_METABOLIC_DRAIN * dt;

    const burn = Math.min(METABOLIZE_RATE * dt, c.reserves.organic);
    c.reserves.organic -= burn;
    c.energy += burn * ENERGY_PER_MASS;

    populateSensors(c, world);

    VM_SELF.energy = c.energy;
    VM_SELF.vx = c.vx;
    VM_SELF.vy = c.vy;
    let selfMass = 0;
    for (let i = 0; i < 6; i++) {
      VM_SELF.reserve[i] = c.reserves[MATERIAL_IDS[i]];
      selfMass += VM_SELF.reserve[i];
    }
    VM_SELF.mass = selfMass;

    runTick(c.genome, c.vm, VM_SENSORS, VM_SELF, VM_INSTR_BUDGET, VM_OUT);
    c.energy -= VM_OUT.instructions * ENERGY_PER_INSTRUCTION;

    if (VM_OUT.reproduce) tryReproduce(c, world);

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

    if (c.ingestCooldown > 0) {
      c.ingestCooldown = Math.max(0, c.ingestCooldown - dt);
    }
    if (c.reproduceCooldown > 0) {
      c.reproduceCooldown = Math.max(0, c.reproduceCooldown - dt);
    }

    if (c.ingestCooldown <= 0 && c.energy >= INGEST_ENERGY_COST) {
      let ingested = false;
      // Try eating a smaller-than-me cell first (predation).
      const myMass = creatureTotalMass(c);
      for (let j = 0; j < n; j++) {
        if (j === cIdx || eaten.has(j)) continue;
        const other = world.creatures[j];
        const dx = other.x - c.x;
        const dy = other.y - c.y;
        const dz = other.z - c.z;
        const minD = c.r + other.r;
        if (dx * dx + dy * dy + dz * dz >= minD * minD) continue;
        const otherMass = creatureTotalMass(other);
        if (myMass < PREDATION_MASS_RATIO * Math.max(0.0001, otherMass)) continue;
        for (let k = 0; k < 6; k++) {
          c.reserves[MATERIAL_IDS[k]] += other.reserves[MATERIAL_IDS[k]];
        }
        c.energy += other.energy;
        c.energy -= INGEST_ENERGY_COST;
        c.ingestCooldown = PREDATION_COOLDOWN_SEC;
        eaten.add(j);
        ingested = true;
        break;
      }
      if (!ingested) {
        for (let i = world.particles.length - 1; i >= 0; i--) {
          const p = world.particles[i];
          const dx = p.x - c.x;
          const dy = p.y - c.y;
          const dz = p.z - c.z;
          if (dx * dx + dy * dy + dz * dz < c.r * c.r) {
            c.reserves[p.material] += mass(p);
            c.energy -= INGEST_ENERGY_COST;
            c.ingestCooldown = INGEST_COOLDOWN_SEC;
            world.particles.splice(i, 1);
            break;
          }
        }
      }
    }

    if (c.energy <= 0 && c.reserves.organic < 0.5) {
      dead.push(cIdx);
    }
  }

  const removed: { idx: number; spill: boolean }[] = [];
  for (const idx of dead) removed.push({ idx, spill: true });
  for (const idx of eaten) removed.push({ idx, spill: false });
  removed.sort((a, b) => b.idx - a.idx);
  for (const r of removed) {
    if (r.spill) releaseReservesAsParticles(world.creatures[r.idx], world);
    world.creatures.splice(r.idx, 1);
  }
}

function releaseReservesAsParticles(c: Creature, world: World): void {
  for (let i = 0; i < 6; i++) {
    const matId = MATERIAL_IDS[i];
    let remaining = c.reserves[matId];
    if (remaining < 0.5) continue;
    const density = MATERIALS[matId].density;
    while (remaining > 0.5) {
      let r = 2 + Math.random() * 2;
      let m = density * Math.PI * r * r;
      if (m > remaining) {
        r = Math.max(DEATH_RELEASE_R_MIN, Math.sqrt(remaining / (density * Math.PI)));
        m = density * Math.PI * r * r;
      }
      world.particles.push({
        x: c.x + (Math.random() - 0.5) * 6,
        y: c.y + (Math.random() - 0.5) * 6,
        z: Math.min(world.depth - r, Math.max(r, c.z + (Math.random() - 0.5) * 4)),
        vx: (Math.random() - 0.5) * 2 * DEATH_RELEASE_SCATTER,
        vy: (Math.random() - 0.5) * 2 * DEATH_RELEASE_SCATTER,
        vz: (Math.random() - 0.5) * DEATH_RELEASE_SCATTER,
        r,
        material: matId,
      });
      remaining -= m;
    }
  }
}

function tryReproduce(parent: Creature, world: World): void {
  if (parent.reproduceCooldown > 0) return;
  if (world.creatures.length >= MAX_CREATURES) return;
  const childGenome = mutateGenome(parent.genome);
  const cost = genomeMaterialCost(childGenome, MASS_PER_GENOME_BYTE);
  for (let i = 0; i < 6; i++) {
    if (parent.reserves[MATERIAL_IDS[i]] < cost[i]) return;
  }
  const childReserves = emptyReserves();
  for (let i = 0; i < 6; i++) {
    parent.reserves[MATERIAL_IDS[i]] -= cost[i];
    childReserves[MATERIAL_IDS[i]] = cost[i];
  }
  const orgGift = parent.reserves.organic * 0.5;
  parent.reserves.organic -= orgGift;
  childReserves.organic += orgGift;
  const energyGift = parent.energy * 0.5;
  parent.energy -= energyGift;

  const angle = Math.random() * Math.PI * 2;
  const offset = parent.r * 2.1;
  const child: Creature = {
    x: parent.x + Math.cos(angle) * offset,
    y: parent.y + Math.sin(angle) * offset,
    z: parent.z,
    vx: parent.vx, vy: parent.vy, vz: parent.vz,
    r: parent.r,
    density: parent.density,
    reserves: childReserves,
    energy: energyGift,
    senseRange: parent.senseRange,
    thrustAccel: parent.thrustAccel,
    genome: childGenome,
    vm: newVMState(),
    color: genomeColor(childGenome),
    ingestCooldown: INGEST_COOLDOWN_SEC,
    reproduceCooldown: REPRODUCE_COOLDOWN_SEC,
  };
  parent.reproduceCooldown = REPRODUCE_COOLDOWN_SEC;
  world.creatures.push(child);
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
  VM_SENSORS.creatureDx = 0;
  VM_SENSORS.creatureDy = 0;
  VM_SENSORS.creatureDist = range;
  VM_SENSORS.creatureMass = 0;
  let bestCreatureSq = rangeSq;
  for (const other of world.creatures) {
    if (other === c) continue;
    const dx = other.x - c.x;
    const dy = other.y - c.y;
    const dsq = dx * dx + dy * dy;
    if (dsq < bestCreatureSq) {
      bestCreatureSq = dsq;
      VM_SENSORS.creatureDx = dx;
      VM_SENSORS.creatureDy = dy;
      VM_SENSORS.creatureDist = Math.sqrt(dsq);
      VM_SENSORS.creatureMass = creatureTotalMass(other);
    }
  }
}

function creatureTotalMass(c: Creature): number {
  let m = 0;
  for (let i = 0; i < 6; i++) m += c.reserves[MATERIAL_IDS[i]];
  return m;
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
    if (o.x < o.r) {
      o.x = o.r;
      if (o.vx < 0) o.vx = -o.vx * world.xWallRestitution;
    } else if (o.x > world.width - o.r) {
      o.x = world.width - o.r;
      if (o.vx > 0) o.vx = -o.vx * world.xWallRestitution;
    }
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
