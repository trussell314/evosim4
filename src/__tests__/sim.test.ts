// Simulation tests. Cover physics, creature behavior (metabolism, ingestion
// with cost+cooldown, thrust, VM exec cost, predation), reproduction
// (affordability + conservation), death and resource release, and ecology.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  type World,
  type Creature,
  type MaterialId,
  MATERIALS,
  MATERIAL_IDS_ORDERED,
  createWorld,
  seedParticles,
  step,
  genomeColor,
} from "../sim";
import { OP, makeDefaultGenome, newVMState } from "../genome";

const M = MATERIAL_IDS_ORDERED;

function quietWorld(): World {
  return {
    width: 800, height: 600, depth: 24, t: 0,
    particles: [], creatures: [],
    gravity: 0, drag: 0,
    surfaceAmp: 0, surfaceLength: 200, surfacePeriod: 1, surfaceDecay: 100,
    swellAmp: 0, swellLength: 800, swellPeriod: 1, swellDecay: 100,
    zStirAmp: 0,
    restitution: 0.2,
    xWallRestitution: 0.4,
    zWallRestitution: 0.6,
    collisionIters: 1,
  };
}

function makeCreature(overrides: Partial<Creature> = {}): Creature {
  const reserves = {} as Record<MaterialId, number>;
  for (const id of M) reserves[id] = 0;
  const base: Creature = {
    x: 400, y: 300, z: 12,
    vx: 0, vy: 0, vz: 0,
    r: 9, density: 1.0,
    reserves,
    energy: 100,
    senseRange: 200,
    thrustAccel: 70,
    genome: makeDefaultGenome(),
    vm: newVMState(),
    color: "#ffffff",
    ingestCooldown: 0,
    reproduceCooldown: 0,
  };
  return { ...base, ...overrides };
}

function stubRandom(seq: number[]): void {
  let i = 0;
  vi.spyOn(Math, "random").mockImplementation(() => seq[i++ % seq.length]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createWorld", () => {
  it("populated world", () => {
    const w = createWorld(800, 600);
    expect(w.particles.length).toBeGreaterThan(0);
    expect(w.creatures.length).toBe(1);
  });
  it("seedParticles bounds", () => {
    const w = quietWorld();
    seedParticles(w, 50);
    expect(w.particles.length).toBe(50);
    for (const p of w.particles) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThan(w.width);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.z).toBeGreaterThanOrEqual(p.r);
      expect(p.z).toBeLessThanOrEqual(w.depth - p.r);
      expect(p.r).toBeGreaterThanOrEqual(2);
      expect(p.r).toBeLessThanOrEqual(6);
      expect(MATERIALS[p.material]).toBeDefined();
    }
  });
  it("seedParticles resets", () => {
    const w = quietWorld();
    seedParticles(w, 10);
    seedParticles(w, 5);
    expect(w.particles.length).toBe(5);
  });
});

describe("physics: gravity & buoyancy", () => {
  it("dense sinks", () => {
    const w = quietWorld(); w.gravity = 100;
    w.particles.push({ x: 100, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 4, material: "rock" });
    step(w, 0.1);
    expect(w.particles[0].vy).toBeGreaterThan(0);
    expect(w.particles[0].y).toBeGreaterThan(100);
  });
  it("light rises", () => {
    const w = quietWorld(); w.gravity = 100;
    w.particles.push({ x: 100, y: 300, z: 12, vx: 0, vy: 0, vz: 0, r: 4, material: "gas" });
    step(w, 0.1);
    expect(w.particles[0].vy).toBeLessThan(0);
  });
  it("density-1 neutral", () => {
    const w = quietWorld(); w.gravity = 100;
    w.particles.push({ x: 100, y: 300, z: 12, vx: 0, vy: 0, vz: 0, r: 4, material: "organic" });
    step(w, 0.1);
    expect(Math.abs(w.particles[0].vy)).toBeLessThan(1e-6);
  });
});

describe("physics: drag", () => {
  it("decay over time", () => {
    const w = quietWorld(); w.drag = 2.0;
    w.particles.push({ x: 100, y: 100, z: 12, vx: 50, vy: 0, vz: 0, r: 4, material: "organic" });
    for (let i = 0; i < 180; i++) step(w, 1 / 60);
    expect(Math.abs(w.particles[0].vx)).toBeLessThan(5);
  });
  it("no sign reversal on one step", () => {
    const w = quietWorld(); w.drag = 0.6;
    w.particles.push({ x: 100, y: 100, z: 12, vx: 50, vy: 0, vz: 0, r: 4, material: "organic" });
    step(w, 1 / 60);
    expect(w.particles[0].vx).toBeGreaterThan(0);
    expect(w.particles[0].vx).toBeLessThan(50);
  });
});

describe("physics: walls", () => {
  it("x bounces left", () => {
    const w = quietWorld(); w.xWallRestitution = 0.5;
    w.particles.push({ x: 5, y: 100, z: 12, vx: -100, vy: 0, vz: 0, r: 4, material: "organic" });
    step(w, 0.5);
    expect(w.particles[0].x).toBeLessThan(w.width / 2);
    expect(w.particles[0].x).toBeGreaterThanOrEqual(w.particles[0].r - 1e-6);
    expect(w.particles[0].vx).toBeGreaterThan(0);
  });
  it("x bounces right", () => {
    const w = quietWorld();
    w.particles.push({ x: 795, y: 100, z: 12, vx: 100, vy: 0, vz: 0, r: 4, material: "organic" });
    step(w, 0.5);
    expect(w.particles[0].x).toBeGreaterThan(w.width / 2);
    expect(w.particles[0].vx).toBeLessThan(0);
  });
  it("creature bounces (no wrap)", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 5, y: 100, vx: -100, energy: 50 });
    c.reserves.organic = 50;
    w.creatures.push(c);
    step(w, 0.1);
    expect(w.creatures.length).toBe(1);
    expect(c.x).toBeGreaterThanOrEqual(c.r - 1e-6);
    expect(c.x).toBeLessThan(50);
  });
  it("y floor clamp", () => {
    const w = quietWorld();
    w.particles.push({ x: 100, y: 595, z: 12, vx: 0, vy: 50, vz: 0, r: 4, material: "organic" });
    step(w, 0.5);
    expect(w.particles[0].y + w.particles[0].r).toBeLessThanOrEqual(w.height + 1e-6);
    expect(w.particles[0].vy).toBeLessThanOrEqual(0);
  });
  it("y ceiling clamp", () => {
    const w = quietWorld();
    w.particles.push({ x: 100, y: 1, z: 12, vx: 0, vy: -50, vz: 0, r: 4, material: "organic" });
    step(w, 0.5);
    expect(w.particles[0].y).toBeGreaterThanOrEqual(w.particles[0].r - 1e-6);
    expect(w.particles[0].vy).toBeGreaterThanOrEqual(0);
  });
  it("z reflects both faces", () => {
    const w = quietWorld(); w.zWallRestitution = 0.5;
    w.particles.push({ x: 100, y: 100, z: 1, vx: 0, vy: 0, vz: -50, r: 4, material: "organic" });
    step(w, 0.1);
    expect(w.particles[0].vz).toBeGreaterThan(0);
    expect(w.particles[0].vz).toBeLessThan(50);
  });
});

describe("physics: collisions", () => {
  it("overlapping separated", () => {
    const w = quietWorld();
    w.particles.push(
      { x: 100, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, material: "organic" },
      { x: 103, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, material: "organic" },
    );
    step(w, 0.001);
    const dx = w.particles[1].x - w.particles[0].x;
    const dy = w.particles[1].y - w.particles[0].y;
    const dz = w.particles[1].z - w.particles[0].z;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    expect(dist).toBeGreaterThanOrEqual(w.particles[0].r + w.particles[1].r - 1e-3);
  });
  it("co-located resolves", () => {
    const w = quietWorld();
    w.particles.push(
      { x: 100, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, material: "organic" },
      { x: 100, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, material: "organic" },
    );
    expect(() => step(w, 0.001)).not.toThrow();
    const dx = w.particles[1].x - w.particles[0].x;
    const dy = w.particles[1].y - w.particles[0].y;
    const dz = w.particles[1].z - w.particles[0].z;
    expect(Math.sqrt(dx*dx + dy*dy + dz*dz)).toBeGreaterThan(0);
  });
  it("denser moved less", () => {
    const w = quietWorld();
    w.particles.push(
      { x: 100, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, material: "rock" },
      { x: 105, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, material: "gas" },
    );
    step(w, 0.001);
    expect(Math.abs(w.particles[1].x - 105)).toBeGreaterThan(Math.abs(w.particles[0].x - 100));
  });
  it("non-overlap unchanged", () => {
    const w = quietWorld();
    w.particles.push(
      { x: 100, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 3, material: "rock" },
      { x: 200, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 3, material: "rock" },
    );
    step(w, 0.001);
    expect(w.particles[0].x).toBeCloseTo(100, 5);
    expect(w.particles[1].x).toBeCloseTo(200, 5);
  });
});

describe("physics: waves", () => {
  it("surface decay", () => {
    const wS = quietWorld(); wS.surfaceAmp = 200; wS.surfaceDecay = 50;
    wS.particles.push({ x: 100, y: 10, z: 12, vx: 0, vy: 0, vz: 0, r: 4, material: "organic" });
    const wD = quietWorld(); wD.surfaceAmp = 200; wD.surfaceDecay = 50;
    wD.particles.push({ x: 100, y: 400, z: 12, vx: 0, vy: 0, vz: 0, r: 4, material: "organic" });
    step(wS, 0.1); step(wD, 0.1);
    expect(Math.abs(wS.particles[0].vx)).toBeGreaterThan(Math.abs(wD.particles[0].vx) * 5);
  });
});

describe("creature: metabolism", () => {
  it("organic -> energy", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0 });
    c.reserves.organic = 50;
    w.creatures.push(c);
    step(w, 1.0);
    expect(c.energy).toBeGreaterThan(0);
    expect(c.reserves.organic).toBeLessThan(50);
  });
  it("caps at available organic", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0 });
    c.reserves.organic = 1;
    w.creatures.push(c);
    step(w, 10.0);
    expect(c.reserves.organic).toBeGreaterThanOrEqual(0);
    expect(c.reserves.organic).toBeLessThan(0.001);
  });
});

describe("creature: ingestion cost and cooldown", () => {
  it("charges energy", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50 });
    w.creatures.push(c);
    w.particles.push({ x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "rock" });
    const e0 = c.energy;
    step(w, 0.001);
    expect(w.particles.length).toBe(0);
    expect(c.energy).toBeLessThan(e0);
  });
  it("one per cooldown", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50 });
    w.creatures.push(c);
    const targets: object[] = [];
    for (let i = 0; i < 5; i++) {
      const p = { x: c.x + i*0.5, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 2, material: "rock" as const };
      w.particles.push(p); targets.push(p);
    }
    step(w, 0.001);
    const remaining = w.particles.filter((p) => targets.includes(p)).length;
    expect(remaining).toBe(4);
    expect(c.ingestCooldown).toBeGreaterThan(0);
  });
  it("cooldown blocks more eats", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50 });
    w.creatures.push(c);
    for (let i = 0; i < 550; i++) w.particles.push({ x: 50+(i%700), y: 10+(i%50), z: c.z, vx: 0, vy: 0, vz: 0, r: 2, material: "sand" });
    const targets: object[] = [];
    for (let i = 0; i < 5; i++) {
      const p = { x: c.x + i*0.5, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 2, material: "rock" as const };
      w.particles.push(p); targets.push(p);
    }
    for (let i = 0; i < 5; i++) step(w, 0.01);
    expect(w.particles.filter((p) => targets.includes(p)).length).toBe(4);
  });
  it("absorbs again after cooldown", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50 });
    w.creatures.push(c);
    for (let i = 0; i < 550; i++) w.particles.push({ x: 50+(i%700), y: 10+(i%50), z: c.z, vx: 0, vy: 0, vz: 0, r: 2, material: "sand" });
    const tgt = new Set<unknown>();
    for (let i = 0; i < 3; i++) {
      const p = { x: c.x + i*0.5, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 2, material: "rock" as const };
      w.particles.push(p); tgt.add(p);
    }
    for (let i = 0; i < 60; i++) step(w, 1 / 60);
    expect(w.particles.filter((p) => tgt.has(p)).length).toBeLessThan(3);
  });
  it("no energy -> no ingest", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0 });
    w.creatures.push(c);
    w.particles.push({ x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "rock" });
    step(w, 0.001);
    expect(w.particles.length).toBe(1);
  });
});

describe("creature: ingestion (basic)", () => {
  it("absorbs particle inside r", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50 });
    w.creatures.push(c);
    w.particles.push({ x: c.x + 2, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "lipid" });
    step(w, 0.001);
    expect(w.particles.length).toBe(0);
    expect(c.reserves.lipid).toBeGreaterThan(0);
  });
  it("skips particles outside r", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50 });
    w.creatures.push(c);
    w.particles.push({ x: c.x + c.r + 10, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "lipid" });
    step(w, 0.001);
    expect(w.particles.length).toBe(1);
  });
  it("reserve gain matches density*pi*r^2", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50 });
    w.creatures.push(c);
    w.particles.push({ x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "rock" });
    step(w, 0.001);
    expect(c.reserves.rock).toBeCloseTo(MATERIALS.rock.density * Math.PI * 9, 5);
  });
});

describe("creature: VM execution cost", () => {
  it("genome drains energy", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50 });
    w.creatures.push(c);
    const e0 = c.energy;
    step(w, 1 / 60);
    expect(c.energy).toBeLessThan(e0);
    expect(e0 - c.energy).toBeLessThan(1);
  });
  it("longer program costs more", () => {
    const w1 = quietWorld();
    const c1 = makeCreature({ energy: 50 });
    c1.genome = new Uint8Array([OP.HALT]);
    w1.creatures.push(c1);
    step(w1, 1 / 60);
    const w2 = quietWorld();
    const c2 = makeCreature({ energy: 50 });
    const ops: number[] = [];
    for (let i = 0; i < 20; i++) ops.push(OP.NOP);
    ops.push(OP.HALT);
    c2.genome = new Uint8Array(ops);
    w2.creatures.push(c2);
    step(w2, 1 / 60);
    expect(50 - c2.energy).toBeGreaterThan(50 - c1.energy);
  });
});

describe("creature: thrust", () => {
  it("thrusts toward organic", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 100, y: 100, energy: 100 });
    c.reserves.organic = 0;
    w.creatures.push(c);
    for (let i = 0; i < 550; i++) w.particles.push({ x: 700, y: 500+(i%50), z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "rock" });
    w.particles.push({ x: 250, y: 100, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "organic" });
    const e0 = c.energy;
    step(w, 0.1);
    expect(c.vx).toBeGreaterThan(0);
    expect(c.energy).toBeLessThan(e0);
  });
  it("clamped to thrustAccel", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 0, y: 0, thrustAccel: 50, energy: 1000 });
    c.reserves.organic = 0;
    w.creatures.push(c);
    w.particles.push({ x: 700, y: 0, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "organic" });
    step(w, 1.0);
    expect(c.vx).toBeLessThanOrEqual(50 + 1e-6);
  });
  it("no energy -> no thrust", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 100, y: 100, energy: 0 });
    c.reserves.organic = 0;
    w.creatures.push(c);
    w.particles.push({ x: 300, y: 100, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "organic" });
    step(w, 0.1);
    expect(c.vx).toBeCloseTo(0, 6);
  });
});

describe("creature: reproduction", () => {
  beforeEach(() => stubRandom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.05, 0.15]));
  it("missing material -> no repro", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    c.reserves.organic = 200;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(1);
  });
  it("all six covered -> repro", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    for (const id of M) c.reserves[id] = 200;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
  });
  it("energy split ~half", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    for (const id of M) c.reserves[id] = 200;
    w.creatures.push(c);
    step(w, 1 / 60);
    const [p, ch] = w.creatures;
    expect(p.energy + ch.energy).toBeGreaterThan(190);
    expect(p.energy + ch.energy).toBeLessThan(210);
    expect(Math.abs(p.energy - ch.energy)).toBeLessThan(3);
  });
  it("non-organic conserved", () => {
    const w = quietWorld();
    const c = makeCreature();
    for (const id of M) c.reserves[id] = 200;
    c.energy = 200;
    w.creatures.push(c);
    step(w, 1 / 60);
    const [p, ch] = w.creatures;
    for (const id of M) {
      if (id === "organic") continue;
      expect(p.reserves[id] + ch.reserves[id]).toBeCloseTo(200, 5);
    }
  });
  it("organic accounts for metabolism", () => {
    const w = quietWorld();
    const c = makeCreature();
    for (const id of M) c.reserves[id] = 200;
    c.energy = 200;
    w.creatures.push(c);
    step(w, 1 / 60);
    const total = w.creatures[0].reserves.organic + w.creatures[1].reserves.organic;
    expect(total).toBeLessThan(200);
    expect(total).toBeGreaterThan(199);
  });
  it("child genome is a copy", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    for (const id of M) c.reserves[id] = 200;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures[1].genome).not.toBe(c.genome);
    expect(Math.abs(w.creatures[1].genome.length - c.genome.length)).toBeLessThanOrEqual(5);
  });
  it("MAX_CREATURES cap", () => {
    const w = quietWorld();
    for (let i = 0; i < 80; i++) {
      const c = makeCreature({ x: 100 + i*5, energy: 200 });
      for (const id of M) c.reserves[id] = 500;
      w.creatures.push(c);
    }
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(80);
  });
});

describe("creature: predation (cell eats cell)", () => {
  beforeEach(() => stubRandom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]));
  function totalMass(c: Creature): number {
    let m = 0;
    for (const id of M) m += c.reserves[id];
    return m;
  }
  function inertGenome(): Uint8Array { return new Uint8Array([OP.HALT]); }
  it("big eats small on overlap", () => {
    const w = quietWorld();
    const predator = makeCreature({ x: 400, y: 300, energy: 100, genome: inertGenome() });
    for (const id of M) predator.reserves[id] = 100;
    const prey = makeCreature({ x: 405, y: 300, energy: 30, genome: inertGenome() });
    for (const id of M) prey.reserves[id] = 10;
    w.creatures.push(predator, prey);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(1);
    expect(w.creatures[0]).toBe(predator);
  });
  it("absorbs reserves+energy", () => {
    const w = quietWorld();
    const predator = makeCreature({ x: 400, y: 300, energy: 100, genome: inertGenome() });
    for (const id of M) predator.reserves[id] = 100;
    const prey = makeCreature({ x: 405, y: 300, energy: 50, genome: inertGenome() });
    for (const id of M) prey.reserves[id] = 10;
    w.creatures.push(predator, prey);
    const m0 = totalMass(predator), pm = totalMass(prey), pe = prey.energy;
    step(w, 1 / 60);
    expect(totalMass(w.creatures[0])).toBeGreaterThanOrEqual(m0 + pm - 1);
    expect(w.creatures[0].energy).toBeGreaterThan(pe);
  });
  it("equal mass standoff", () => {
    const w = quietWorld();
    const a = makeCreature({ x: 400, y: 300, energy: 100, genome: inertGenome() });
    for (const id of M) a.reserves[id] = 50;
    const b = makeCreature({ x: 405, y: 300, energy: 100, genome: inertGenome() });
    for (const id of M) b.reserves[id] = 50;
    w.creatures.push(a, b);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
  });
  it("engulf pays ingest cost (net positive after prey gift)", () => {
    const w = quietWorld();
    const predator = makeCreature({ x: 400, y: 300, energy: 100, genome: inertGenome() });
    for (const id of M) predator.reserves[id] = 200;
    const prey = makeCreature({ x: 405, y: 300, energy: 20, genome: inertGenome() });
    for (const id of M) prey.reserves[id] = 1;
    w.creatures.push(predator, prey);
    step(w, 1 / 60);
    expect(w.creatures[0].energy).toBeGreaterThan(100);
    expect(w.creatures[0].energy).toBeLessThan(125);
  });
  it("longer cooldown after engulf", () => {
    const w = quietWorld();
    const predator = makeCreature({ x: 400, y: 300, energy: 100, genome: inertGenome() });
    for (const id of M) predator.reserves[id] = 200;
    const prey = makeCreature({ x: 405, y: 300, energy: 20, genome: inertGenome() });
    for (const id of M) prey.reserves[id] = 1;
    w.creatures.push(predator, prey);
    step(w, 1 / 60);
    expect(w.creatures[0].ingestCooldown).toBeGreaterThan(0.35);
  });
  it("non-overlap no engulf", () => {
    const w = quietWorld();
    const predator = makeCreature({ x: 100, y: 300, energy: 100, genome: inertGenome() });
    for (const id of M) predator.reserves[id] = 200;
    const prey = makeCreature({ x: 600, y: 300, energy: 20, genome: inertGenome() });
    for (const id of M) prey.reserves[id] = 1;
    w.creatures.push(predator, prey);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
  });
  it("cooldown blocks engulf", () => {
    const w = quietWorld();
    const predator = makeCreature({ x: 400, y: 300, energy: 100, ingestCooldown: 1.0, genome: inertGenome() });
    for (const id of M) predator.reserves[id] = 200;
    const prey = makeCreature({ x: 405, y: 300, energy: 20, genome: inertGenome() });
    for (const id of M) prey.reserves[id] = 1;
    w.creatures.push(predator, prey);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
  });
  it("low energy blocks engulf", () => {
    const w = quietWorld();
    const predator = makeCreature({ x: 400, y: 300, energy: 1, genome: inertGenome() });
    for (const id of M) predator.reserves[id] = 200;
    predator.reserves.organic = 0;
    const prey = makeCreature({ x: 405, y: 300, energy: 50, genome: inertGenome() });
    for (const id of M) prey.reserves[id] = 1;
    prey.reserves.organic = 5;
    w.creatures.push(predator, prey);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
  });
  it("engulf does NOT spawn death particles", () => {
    const w = quietWorld();
    for (let i = 0; i < 550; i++) w.particles.push({ x: 50+(i%700), y: 10+(i%50), z: 12, vx: 0, vy: 0, vz: 0, r: 2, material: "sand" });
    const before = new Set(w.particles);
    const predator = makeCreature({ x: 400, y: 300, energy: 100, genome: inertGenome() });
    for (const id of M) predator.reserves[id] = 200;
    const prey = makeCreature({ x: 405, y: 300, energy: 30, genome: inertGenome() });
    for (const id of M) prey.reserves[id] = 10;
    w.creatures.push(predator, prey);
    step(w, 1 / 60);
    expect(w.particles.filter((p) => !before.has(p)).length).toBe(0);
  });
});

describe("creature: death by starvation", () => {
  it("no energy + no organic -> dies", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0 });
    c.reserves.organic = 0;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(0);
  });
  it("organic survives baseline drain", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0 });
    c.reserves.organic = 50;
    w.creatures.push(c);
    for (let i = 0; i < 60; i++) step(w, 1 / 60);
    expect(w.creatures.length).toBe(1);
  });
  it("baseline drain depletes idle energy", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 100 });
    c.reserves.organic = 0;
    w.creatures.push(c);
    const e0 = c.energy;
    step(w, 1 / 60);
    expect(c.energy).toBeLessThan(e0);
  });
  it("releases reserves as particles", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0 });
    c.reserves.organic = 0;
    c.reserves.rock = 50;
    c.reserves.sand = 30;
    c.reserves.gas = 20;
    const before = w.particles.length;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(0);
    expect(w.particles.length).toBeGreaterThan(before);
    const counts = { rock: 0, sand: 0, gas: 0 } as Record<string, number>;
    for (const p of w.particles.slice(before)) if (p.material in counts) counts[p.material]++;
    expect(counts.rock).toBeGreaterThan(0);
    expect(counts.sand).toBeGreaterThan(0);
    expect(counts.gas).toBeGreaterThan(0);
  });
  it("mass conservation on release", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0 });
    c.reserves.organic = 0;
    c.reserves.clay = 100;
    w.creatures.push(c);
    step(w, 1 / 60);
    let m = 0;
    for (const p of w.particles) if (p.material === "clay") m += MATERIALS.clay.density * Math.PI * p.r * p.r;
    expect(m).toBeGreaterThanOrEqual(99);
    expect(m).toBeLessThan(110);
  });
  it("particles spawn near dead cell", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 400, y: 300, z: 12, energy: 0 });
    c.reserves.organic = 0;
    c.reserves.rock = 50;
    for (let i = 0; i < 550; i++) w.particles.push({ x: 50+(i%700), y: 10+(i%50), z: c.z, vx: 0, vy: 0, vz: 0, r: 2, material: "sand" });
    const before = new Set(w.particles);
    w.creatures.push(c);
    step(w, 1 / 60);
    for (const p of w.particles.filter((p) => !before.has(p))) {
      expect(p.material).toBe("rock");
      expect(Math.abs(p.x - 400)).toBeLessThan(20);
      expect(Math.abs(p.y - 300)).toBeLessThan(20);
    }
  });
});

describe("creature: reproduction does not cascade within a single tick", () => {
  beforeEach(() => stubRandom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]));
  it("max one child per tick", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    for (const id of M) c.reserves[id] = 2000;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
  });
  it("newborn fresh VM state", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    for (const id of M) c.reserves[id] = 2000;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures[1].vm.pc).toBe(0);
    expect(w.creatures[1].vm.stack).toEqual([]);
  });
});

describe("creature: reproduction cooldown", () => {
  beforeEach(() => stubRandom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]));
  it("parent can't fission next tick", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    for (const id of M) c.reserves[id] = 2000;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
    expect(w.creatures[0].reproduceCooldown).toBeGreaterThan(0);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
  });
  it("child has fission cooldown", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    for (const id of M) c.reserves[id] = 2000;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures[1].reproduceCooldown).toBeGreaterThan(0);
  });
  it("cooldown clears, refission possible", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 1000 });
    for (const id of M) c.reserves[id] = 5000;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
    for (let i = 0; i < 180; i++) step(w, 1 / 60);
    expect(w.creatures.length).toBeGreaterThan(2);
  });
});

describe("creature: newborn ingest cooldown", () => {
  beforeEach(() => stubRandom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]));
  it("child can't eat immediately", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    for (const id of M) c.reserves[id] = 2000;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures[1].ingestCooldown).toBeGreaterThan(0);
  });
});

describe("creature: ingestion charges exactly the per-event energy cost", () => {
  it("empty genome -> energy = start - baseline*dt - 1.5", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 100 });
    c.genome = new Uint8Array([]);
    c.reserves.organic = 0;
    w.creatures.push(c);
    for (let i = 0; i < 550; i++) w.particles.push({ x: 50+(i%700), y: 10+(i%50), z: c.z, vx: 0, vy: 0, vz: 0, r: 2, material: "sand" });
    const target = { x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "rock" as const };
    w.particles.push(target);
    const dt = 1 / 60;
    step(w, dt);
    expect(w.particles.includes(target)).toBe(false);
    expect(c.energy).toBeCloseTo(100 - 0.5 * dt - 1.5, 5);
  });
});

describe("particle replenishment", () => {
  it("spawns when below target", () => {
    const w = quietWorld();
    const n0 = w.particles.length;
    for (let i = 0; i < 60; i++) step(w, 1 / 60);
    expect(w.particles.length).toBeGreaterThan(n0);
  });
  it("doesn't exceed target", () => {
    const w = quietWorld();
    seedParticles(w, 550);
    const n0 = w.particles.length;
    for (let i = 0; i < 30; i++) step(w, 1 / 60);
    expect(w.particles.length).toBe(n0);
  });
  it("refills after eating", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50 });
    w.creatures.push(c);
    seedParticles(w, 540);
    w.particles.push({ x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "organic" });
    for (let i = 0; i < 120; i++) step(w, 1 / 60);
    expect(w.particles.length).toBeGreaterThan(540);
  });
});

describe("genomeColor", () => {
  it("stable", () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array([1, 2, 3, 4, 5]);
    expect(genomeColor(a)).toBe(genomeColor(b));
  });
  it("differs by byte", () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array([1, 2, 9, 4, 5]);
    expect(genomeColor(a)).not.toBe(genomeColor(b));
  });
  it("valid hsl", () => {
    expect(genomeColor(new Uint8Array([7, 11]))).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
  });
  it("empty ok", () => {
    expect(() => genomeColor(new Uint8Array([]))).not.toThrow();
  });
});

describe("default creature behavior (integration)", () => {
  it("moves toward planted organic", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 100, y: 100 });
    w.creatures.push(c);
    for (let i = 0; i < 550; i++) w.particles.push({ x: 700, y: 500+(i%50), z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "rock" });
    w.particles.push({ x: 160, y: 100, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "organic" });
    for (let i = 0; i < 30; i++) step(w, 1 / 60);
    const stillThere = w.particles.some((p) => p.material === "organic" && p.x > 150 && p.x < 170);
    if (stillThere) expect(w.creatures[0].x).toBeGreaterThan(100);
    else expect(w.creatures[0].reserves.organic).toBeGreaterThan(0);
  });
  it("threshold not met -> no spawn", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    c.reserves.organic = 10;
    for (const id of M) if (id !== "organic") c.reserves[id] = 200;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(1);
  });
});
