// Simulation tests. Cover physics primitives, creature behavior (metabolism,
// ingestion with cost+cooldown, thrust, VM execution cost), reproduction
// (affordability + conservation), and ecology (replenishment, MAX_CREATURES).

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

// ---------- helpers ----------

const M = MATERIAL_IDS_ORDERED;

// Minimal world with no forcing -- isolates one physics effect per test.
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

// ---------- world setup ----------

describe("createWorld", () => {
  it("returns a populated world with default particles and one creature", () => {
    const w = createWorld(800, 600);
    expect(w.width).toBe(800);
    expect(w.height).toBe(600);
    expect(w.particles.length).toBeGreaterThan(0);
    expect(w.creatures.length).toBe(1);
    expect(w.t).toBe(0);
  });

  it("seedParticles produces requested count and respects bounds", () => {
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

  it("seedParticles clears existing particles", () => {
    const w = quietWorld();
    seedParticles(w, 10);
    seedParticles(w, 5);
    expect(w.particles.length).toBe(5);
  });
});

// ---------- physics ----------

describe("physics: gravity & buoyancy", () => {
  it("denser-than-water material sinks (positive ay)", () => {
    const w = quietWorld();
    w.gravity = 100;
    w.particles.push({
      x: 100, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 4, material: "rock",
    });
    step(w, 0.1);
    expect(w.particles[0].vy).toBeGreaterThan(0);
    expect(w.particles[0].y).toBeGreaterThan(100);
  });

  it("less-dense-than-water material rises (negative ay)", () => {
    const w = quietWorld();
    w.gravity = 100;
    w.particles.push({
      x: 100, y: 300, z: 12, vx: 0, vy: 0, vz: 0, r: 4, material: "gas",
    });
    step(w, 0.1);
    expect(w.particles[0].vy).toBeLessThan(0);
    expect(w.particles[0].y).toBeLessThan(300);
  });

  it("density-1 material (organic) experiences no net vertical force", () => {
    const w = quietWorld();
    w.gravity = 100;
    w.particles.push({
      x: 100, y: 300, z: 12, vx: 0, vy: 0, vz: 0, r: 4, material: "organic",
    });
    step(w, 0.1);
    expect(Math.abs(w.particles[0].vy)).toBeLessThan(1e-6);
  });
});

describe("physics: drag", () => {
  it("decays a particle's velocity toward zero over time", () => {
    const w = quietWorld();
    w.drag = 2.0;
    w.particles.push({
      x: 100, y: 100, z: 12, vx: 50, vy: 0, vz: 0, r: 4, material: "organic",
    });
    const v0 = w.particles[0].vx;
    for (let i = 0; i < 180; i++) step(w, 1 / 60);
    const v1 = w.particles[0].vx;
    expect(Math.abs(v1)).toBeLessThan(Math.abs(v0) / 10);
  });

  it("drag doesn't reverse velocity sign on a single step", () => {
    const w = quietWorld();
    w.drag = 0.6;
    w.particles.push({
      x: 100, y: 100, z: 12, vx: 50, vy: 0, vz: 0, r: 4, material: "organic",
    });
    step(w, 1 / 60);
    expect(w.particles[0].vx).toBeGreaterThan(0);
    expect(w.particles[0].vx).toBeLessThan(50);
  });
});

describe("physics: walls", () => {
  it("x bounces off the left wall (no wrap-around)", () => {
    const w = quietWorld();
    w.xWallRestitution = 0.5;
    w.particles.push({
      x: 5, y: 100, z: 12, vx: -100, vy: 0, vz: 0, r: 4, material: "organic",
    });
    step(w, 0.5);
    expect(w.particles[0].x).toBeLessThan(w.width / 2);
    expect(w.particles[0].x).toBeGreaterThanOrEqual(w.particles[0].r - 1e-6);
    expect(w.particles[0].vx).toBeGreaterThan(0);
  });

  it("x bounces off the right wall", () => {
    const w = quietWorld();
    w.particles.push({
      x: 795, y: 100, z: 12, vx: 100, vy: 0, vz: 0, r: 4, material: "organic",
    });
    step(w, 0.5);
    expect(w.particles[0].x).toBeGreaterThan(w.width / 2);
    expect(w.particles[0].x).toBeLessThanOrEqual(w.width - w.particles[0].r + 1e-6);
    expect(w.particles[0].vx).toBeLessThan(0);
  });

  it("creature bouncing off side walls (no toroidal sweep)", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 5, y: 100, vx: -100, energy: 50 });
    c.reserves.organic = 50;
    w.creatures.push(c);
    step(w, 0.1);
    expect(w.creatures.length).toBe(1);
    expect(c.x).toBeGreaterThanOrEqual(c.r - 1e-6);
    expect(c.x).toBeLessThan(w.width / 2);
    expect(c.x).toBeLessThan(50);
  });

  it("y clamps at bottom (floor) and zeroes downward velocity", () => {
    const w = quietWorld();
    w.particles.push({
      x: 100, y: 595, z: 12, vx: 0, vy: 50, vz: 0, r: 4, material: "organic",
    });
    step(w, 0.5);
    expect(w.particles[0].y + w.particles[0].r).toBeLessThanOrEqual(w.height + 1e-6);
    expect(w.particles[0].vy).toBeLessThanOrEqual(0);
  });

  it("y clamps at top (ceiling)", () => {
    const w = quietWorld();
    w.particles.push({
      x: 100, y: 1, z: 12, vx: 0, vy: -50, vz: 0, r: 4, material: "organic",
    });
    step(w, 0.5);
    expect(w.particles[0].y).toBeGreaterThanOrEqual(w.particles[0].r - 1e-6);
    expect(w.particles[0].vy).toBeGreaterThanOrEqual(0);
  });

  it("z reflects with restitution at both faces", () => {
    const w = quietWorld();
    w.zWallRestitution = 0.5;
    w.particles.push({
      x: 100, y: 100, z: 1, vx: 0, vy: 0, vz: -50, r: 4, material: "organic",
    });
    step(w, 0.1);
    expect(w.particles[0].vz).toBeGreaterThan(0);
    expect(w.particles[0].vz).toBeLessThan(50);
  });
});

describe("physics: collisions", () => {
  it("two overlapping particles get separated", () => {
    const w = quietWorld();
    w.particles.push(
      { x: 100, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, material: "organic" },
      { x: 103, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, material: "organic" },
    );
    step(w, 0.001);
    const dx = w.particles[1].x - w.particles[0].x;
    const dy = w.particles[1].y - w.particles[0].y;
    const dz = w.particles[1].z - w.particles[0].z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    expect(dist).toBeGreaterThanOrEqual(w.particles[0].r + w.particles[1].r - 1e-3);
  });

  it("two co-located particles still resolve without crashing (degenerate normal)", () => {
    const w = quietWorld();
    w.particles.push(
      { x: 100, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, material: "organic" },
      { x: 100, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, material: "organic" },
    );
    expect(() => step(w, 0.001)).not.toThrow();
    const dx = w.particles[1].x - w.particles[0].x;
    const dy = w.particles[1].y - w.particles[0].y;
    const dz = w.particles[1].z - w.particles[0].z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    expect(dist).toBeGreaterThan(0);
  });

  it("denser particle moved less than lighter on overlap (mass-weighted)", () => {
    const w = quietWorld();
    w.particles.push(
      { x: 100, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, material: "rock" },
      { x: 105, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, material: "gas" },
    );
    step(w, 0.001);
    const rockMoved = Math.abs(w.particles[0].x - 100);
    const gasMoved = Math.abs(w.particles[1].x - 105);
    expect(gasMoved).toBeGreaterThan(rockMoved);
  });

  it("non-overlapping particles do not move from collision", () => {
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
  it("surface wave forcing decays with depth", () => {
    const wShallow = quietWorld();
    wShallow.surfaceAmp = 200;
    wShallow.surfaceDecay = 50;
    wShallow.particles.push({
      x: 100, y: 10, z: 12, vx: 0, vy: 0, vz: 0, r: 4, material: "organic",
    });
    const wDeep = quietWorld();
    wDeep.surfaceAmp = 200;
    wDeep.surfaceDecay = 50;
    wDeep.particles.push({
      x: 100, y: 400, z: 12, vx: 0, vy: 0, vz: 0, r: 4, material: "organic",
    });
    step(wShallow, 0.1);
    step(wDeep, 0.1);
    expect(Math.abs(wShallow.particles[0].vx)).toBeGreaterThan(
      Math.abs(wDeep.particles[0].vx) * 5,
    );
  });
});

// ---------- creature behavior ----------

describe("creature: metabolism", () => {
  it("burns organic into energy at expected rate", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0 });
    c.reserves.organic = 50;
    w.creatures.push(c);
    step(w, 1.0);
    expect(c.energy).toBeGreaterThan(0);
    expect(c.reserves.organic).toBeLessThan(50);
  });

  it("doesn't burn more organic than is present", () => {
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
  it("ingestion charges a per-event energy cost", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50 });
    w.creatures.push(c);
    w.particles.push({
      x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "rock",
    });
    const e0 = c.energy;
    step(w, 0.001);
    expect(w.particles.length).toBe(0);
    expect(c.energy).toBeLessThan(e0);
  });

  it("absorbs only ONE particle even when several overlap (cooldown takes effect)", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50 });
    w.creatures.push(c);
    const targets: object[] = [];
    for (let i = 0; i < 5; i++) {
      const p = {
        x: c.x + i * 0.5, y: c.y, z: c.z,
        vx: 0, vy: 0, vz: 0, r: 2, material: "rock" as const,
      };
      w.particles.push(p);
      targets.push(p);
    }
    step(w, 0.001);
    const remainingTargets = w.particles.filter((p) => targets.includes(p)).length;
    expect(remainingTargets).toBe(4);
    expect(c.ingestCooldown).toBeGreaterThan(0);
  });

  it("does not absorb again until the cooldown expires", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50 });
    w.creatures.push(c);
    for (let i = 0; i < 550; i++) {
      w.particles.push({
        x: 50 + (i % 700), y: 10 + (i % 50), z: c.z,
        vx: 0, vy: 0, vz: 0, r: 2, material: "sand",
      });
    }
    const targets: object[] = [];
    for (let i = 0; i < 5; i++) {
      const p = {
        x: c.x + i * 0.5, y: c.y, z: c.z,
        vx: 0, vy: 0, vz: 0, r: 2, material: "rock" as const,
      };
      w.particles.push(p);
      targets.push(p);
    }
    for (let i = 0; i < 5; i++) step(w, 0.01);
    const remaining = w.particles.filter((p) => targets.includes(p)).length;
    expect(remaining).toBe(4);
  });

  it("can absorb again after cooldown expires", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50 });
    w.creatures.push(c);
    for (let i = 0; i < 550; i++) {
      w.particles.push({
        x: 50 + (i % 700), y: 10 + (i % 50), z: c.z,
        vx: 0, vy: 0, vz: 0, r: 2, material: "sand",
      });
    }
    const targetIds = new Set<unknown>();
    for (let i = 0; i < 3; i++) {
      const p = {
        x: c.x + i * 0.5, y: c.y, z: c.z,
        vx: 0, vy: 0, vz: 0, r: 2, material: "rock" as const,
      };
      w.particles.push(p);
      targetIds.add(p);
    }
    const before = w.particles.filter((p) => targetIds.has(p)).length;
    expect(before).toBe(3);
    for (let i = 0; i < 60; i++) step(w, 1 / 60);
    const after = w.particles.filter((p) => targetIds.has(p)).length;
    expect(after).toBeLessThan(3);
  });

  it("won't absorb if it can't pay the per-event energy cost", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0 });
    w.creatures.push(c);
    w.particles.push({
      x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "rock",
    });
    step(w, 0.001);
    expect(w.particles.length).toBe(1);
  });
});

describe("creature: ingestion (basic)", () => {
  it("absorbs a particle whose center is inside the cell radius", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50 });
    w.creatures.push(c);
    w.particles.push({
      x: c.x + 2, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "lipid",
    });
    expect(w.particles.length).toBe(1);
    step(w, 0.001);
    expect(w.particles.length).toBe(0);
    expect(c.reserves.lipid).toBeGreaterThan(0);
  });

  it("does not absorb particles outside the cell", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50 });
    w.creatures.push(c);
    w.particles.push({
      x: c.x + c.r + 10, y: c.y, z: c.z,
      vx: 0, vy: 0, vz: 0, r: 3, material: "lipid",
    });
    step(w, 0.001);
    expect(w.particles.length).toBe(1);
  });

  it("reserve gain matches MATERIALS[mat].density * pi * r^2", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50 });
    w.creatures.push(c);
    const r = 3;
    w.particles.push({
      x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r, material: "rock",
    });
    step(w, 0.001);
    const expected = MATERIALS.rock.density * Math.PI * r * r;
    expect(c.reserves.rock).toBeCloseTo(expected, 5);
  });
});

describe("creature: VM execution cost", () => {
  it("running the genome drains energy each tick", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50 });
    w.creatures.push(c);
    const e0 = c.energy;
    step(w, 1 / 60);
    expect(c.energy).toBeLessThan(e0);
    expect(e0 - c.energy).toBeLessThan(1);
  });

  it("the longer the program runs before HALT, the more energy it costs", () => {
    const wShort = quietWorld();
    const cShort = makeCreature({ energy: 50 });
    cShort.genome = new Uint8Array([OP.HALT]);
    wShort.creatures.push(cShort);
    step(wShort, 1 / 60);

    const wLong = quietWorld();
    const cLong = makeCreature({ energy: 50 });
    const noWorkOps: number[] = [];
    for (let i = 0; i < 20; i++) noWorkOps.push(OP.NOP);
    noWorkOps.push(OP.HALT);
    cLong.genome = new Uint8Array(noWorkOps);
    wLong.creatures.push(cLong);
    step(wLong, 1 / 60);

    const costShort = 50 - cShort.energy;
    const costLong = 50 - cLong.energy;
    expect(costLong).toBeGreaterThan(costShort);
  });
});

describe("creature: thrust", () => {
  it("creature with default genome thrusts toward organic particle and drains energy", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 100, y: 100, vx: 0, vy: 0, energy: 100 });
    c.reserves.organic = 0;
    w.creatures.push(c);
    for (let i = 0; i < 550; i++) {
      w.particles.push({
        x: 700, y: 500 + (i % 50), z: c.z,
        vx: 0, vy: 0, vz: 0, r: 3, material: "rock",
      });
    }
    w.particles.push({
      x: 250, y: 100, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "organic",
    });
    const e0 = c.energy;
    step(w, 0.1);
    expect(c.vx).toBeGreaterThan(0);
    expect(c.energy).toBeLessThan(e0);
  });

  it("thrust magnitude clamped to thrustAccel", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 0, y: 0, thrustAccel: 50, energy: 1000 });
    c.reserves.organic = 0;
    w.creatures.push(c);
    w.particles.push({
      x: 700, y: 0, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "organic",
    });
    step(w, 1.0);
    expect(c.vx).toBeLessThanOrEqual(50 + 1e-6);
  });

  it("creature with no energy cannot thrust", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 100, y: 100, energy: 0 });
    c.reserves.organic = 0;
    w.creatures.push(c);
    w.particles.push({
      x: 300, y: 100, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "organic",
    });
    step(w, 0.1);
    expect(c.vx).toBeCloseTo(0, 6);
  });
});

// ---------- reproduction ----------

describe("creature: reproduction", () => {
  beforeEach(() => {
    stubRandom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.05, 0.15]);
  });

  it("does not reproduce when reserves are insufficient", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    c.reserves.organic = 200;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(1);
  });

  it("reproduces when all six material reserves cover the genome cost", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    for (const id of M) c.reserves[id] = 200;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
    const parent = w.creatures[0];
    const child = w.creatures[1];
    expect(parent.reserves.organic).toBeLessThan(200);
    let childTotal = 0;
    for (const id of M) childTotal += child.reserves[id];
    expect(childTotal).toBeGreaterThan(0);
  });

  it("parent transfers half its energy to the child", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    for (const id of M) c.reserves[id] = 200;
    w.creatures.push(c);
    step(w, 1 / 60);
    const parent = w.creatures[0];
    const child = w.creatures[1];
    const total = parent.energy + child.energy;
    expect(total).toBeGreaterThan(190);
    expect(total).toBeLessThan(210);
    expect(Math.abs(parent.energy - child.energy)).toBeLessThan(3);
  });

  it("conserves non-organic matter exactly across reproduction", () => {
    const w = quietWorld();
    const c = makeCreature();
    const before: Record<MaterialId, number> = {} as Record<MaterialId, number>;
    for (const id of M) {
      c.reserves[id] = 200;
      before[id] = 200;
    }
    c.energy = 200;
    w.creatures.push(c);
    step(w, 1 / 60);
    const parent = w.creatures[0];
    const child = w.creatures[1];
    for (const id of M) {
      if (id === "organic") continue;
      expect(parent.reserves[id] + child.reserves[id]).toBeCloseTo(before[id], 5);
    }
  });

  it("organic conservation accounts for metabolism during the tick", () => {
    const w = quietWorld();
    const c = makeCreature();
    for (const id of M) c.reserves[id] = 200;
    c.energy = 200;
    w.creatures.push(c);
    const dt = 1 / 60;
    step(w, dt);
    const parent = w.creatures[0];
    const child = w.creatures[1];
    const totalOrganic = parent.reserves.organic + child.reserves.organic;
    expect(totalOrganic).toBeLessThan(200);
    expect(totalOrganic).toBeGreaterThan(200 - 1);
  });

  it("child genome is a (possibly mutated) copy of parent's genome", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    for (const id of M) c.reserves[id] = 200;
    w.creatures.push(c);
    step(w, 1 / 60);
    const child = w.creatures[1];
    expect(child.genome).not.toBe(c.genome);
    expect(Math.abs(child.genome.length - c.genome.length)).toBeLessThanOrEqual(5);
  });

  it("respects MAX_CREATURES cap", () => {
    const w = quietWorld();
    for (let i = 0; i < 80; i++) {
      const c = makeCreature({ x: 100 + i * 5, energy: 200 });
      for (const id of M) c.reserves[id] = 500;
      w.creatures.push(c);
    }
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(80);
  });
});

// ---------- death and resource release ----------

describe("creature: death by starvation", () => {
  it("a cell with no organic and no energy dies on the next tick", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0 });
    c.reserves.organic = 0;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(0);
  });

  it("a cell with organic to metabolize survives the baseline drain", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0 });
    c.reserves.organic = 50;
    w.creatures.push(c);
    for (let i = 0; i < 60; i++) step(w, 1 / 60);
    expect(w.creatures.length).toBe(1);
  });

  it("baseline metabolic drain depletes energy even when idle", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 100 });
    c.reserves.organic = 0;
    w.creatures.push(c);
    const e0 = c.energy;
    step(w, 1 / 60);
    expect(c.energy).toBeLessThan(e0);
  });

  it("on death, reserves are released as particles of matching materials", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0 });
    c.reserves.organic = 0;
    c.reserves.rock = 50;
    c.reserves.sand = 30;
    c.reserves.gas = 20;
    const particlesBefore = w.particles.length;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(0);
    expect(w.particles.length).toBeGreaterThan(particlesBefore);
    const released = w.particles.slice(particlesBefore);
    const counts: Record<string, number> = { rock: 0, sand: 0, gas: 0 };
    for (const p of released) {
      if (p.material in counts) counts[p.material]++;
    }
    expect(counts.rock).toBeGreaterThan(0);
    expect(counts.sand).toBeGreaterThan(0);
    expect(counts.gas).toBeGreaterThan(0);
  });

  it("released particles approximately conserve mass (per material)", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0 });
    c.reserves.organic = 0;
    c.reserves.clay = 100;
    w.creatures.push(c);
    step(w, 1 / 60);
    let totalClayMass = 0;
    for (const p of w.particles) {
      if (p.material !== "clay") continue;
      totalClayMass += MATERIALS.clay.density * Math.PI * p.r * p.r;
    }
    expect(totalClayMass).toBeGreaterThanOrEqual(100 - 1);
    expect(totalClayMass).toBeLessThan(100 + 10);
  });

  it("released particles spawn near the dead cell", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 400, y: 300, z: 12, energy: 0 });
    c.reserves.organic = 0;
    c.reserves.rock = 50;
    for (let i = 0; i < 550; i++) {
      w.particles.push({
        x: 50 + (i % 700), y: 10 + (i % 50), z: c.z,
        vx: 0, vy: 0, vz: 0, r: 2, material: "sand",
      });
    }
    const before = new Set(w.particles);
    w.creatures.push(c);
    step(w, 1 / 60);
    const released = w.particles.filter((p) => !before.has(p));
    for (const p of released) {
      expect(p.material).toBe("rock");
      expect(Math.abs(p.x - 400)).toBeLessThan(20);
      expect(Math.abs(p.y - 300)).toBeLessThan(20);
    }
  });
});

// ---------- in-tick reproduction snapshot ----------

describe("creature: reproduction does not cascade within a single tick", () => {
  beforeEach(() => {
    stubRandom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
  });

  it("a single well-fed creature spawns at most one child per tick", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    for (const id of M) c.reserves[id] = 2000;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
  });

  it("a newborn child does not act on its birth tick", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    for (const id of M) c.reserves[id] = 2000;
    w.creatures.push(c);
    step(w, 1 / 60);
    const child = w.creatures[1];
    expect(child.vm.pc).toBe(0);
    expect(child.vm.stack).toEqual([]);
  });
});

// ---------- reproduction cooldown ----------

describe("creature: reproduction cooldown", () => {
  beforeEach(() => {
    stubRandom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
  });

  it("after reproducing, parent cannot fission again on the next tick", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    for (const id of M) c.reserves[id] = 2000;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
    const parent = w.creatures[0];
    expect(parent.reproduceCooldown).toBeGreaterThan(0);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
  });

  it("child also has a fresh fission cooldown", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    for (const id of M) c.reserves[id] = 2000;
    w.creatures.push(c);
    step(w, 1 / 60);
    const child = w.creatures[1];
    expect(child.reproduceCooldown).toBeGreaterThan(0);
  });

  it("cooldown decrements each tick and eventually allows re-fission", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 1000 });
    for (const id of M) c.reserves[id] = 5000;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
    const startPop = w.creatures.length;
    for (let i = 0; i < 180; i++) step(w, 1 / 60);
    expect(w.creatures.length).toBeGreaterThan(startPop);
  });
});

// ---------- newborn cooldown ----------

describe("creature: newborn ingest cooldown", () => {
  beforeEach(() => {
    stubRandom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
  });

  it("a freshly-spawned child has a positive ingest cooldown (can't eat immediately)", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    for (const id of M) c.reserves[id] = 2000;
    w.creatures.push(c);
    step(w, 1 / 60);
    const child = w.creatures[1];
    expect(child.ingestCooldown).toBeGreaterThan(0);
  });
});

// ---------- precise ingest cost ----------

describe("creature: ingestion charges exactly the per-event energy cost", () => {
  it("energy delta on ingestion accounts for VM + baseline + ingest cost", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 100 });
    c.genome = new Uint8Array([]);
    c.reserves.organic = 0;
    w.creatures.push(c);
    for (let i = 0; i < 550; i++) {
      w.particles.push({
        x: 50 + (i % 700), y: 10 + (i % 50), z: c.z,
        vx: 0, vy: 0, vz: 0, r: 2, material: "sand",
      });
    }
    const target = {
      x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "rock" as const,
    };
    w.particles.push(target);
    const dt = 1 / 60;
    step(w, dt);
    expect(w.particles.includes(target)).toBe(false);
    const expected = 100 - 0.5 * dt - 1.5;
    expect(c.energy).toBeCloseTo(expected, 5);
  });
});

// ---------- particle replenishment ----------

describe("particle replenishment", () => {
  it("spawns particles when below target", () => {
    const w = quietWorld();
    const n0 = w.particles.length;
    for (let i = 0; i < 60; i++) step(w, 1 / 60);
    expect(w.particles.length).toBeGreaterThan(n0);
  });

  it("does not exceed target", () => {
    const w = quietWorld();
    seedParticles(w, 550);
    const n0 = w.particles.length;
    for (let i = 0; i < 30; i++) step(w, 1 / 60);
    expect(w.particles.length).toBeLessThanOrEqual(550);
    expect(w.particles.length).toBe(n0);
  });

  it("replenishes after a creature eats", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50 });
    w.creatures.push(c);
    seedParticles(w, 540);
    w.particles.push({
      x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "organic",
    });
    expect(w.particles.length).toBe(541);
    for (let i = 0; i < 120; i++) step(w, 1 / 60);
    expect(w.particles.length).toBeGreaterThan(540);
  });
});

// ---------- color hashing ----------

describe("genomeColor", () => {
  it("returns a stable color for the same genome bytes", () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array([1, 2, 3, 4, 5]);
    expect(genomeColor(a)).toBe(genomeColor(b));
  });

  it("returns different colors for genomes differing in one byte (most cases)", () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array([1, 2, 9, 4, 5]);
    expect(genomeColor(a)).not.toBe(genomeColor(b));
  });

  it("produces a valid hsl(...) css string", () => {
    const c = genomeColor(new Uint8Array([7, 11]));
    expect(c).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
  });

  it("handles empty genome", () => {
    expect(() => genomeColor(new Uint8Array([]))).not.toThrow();
  });
});

// ---------- integration ----------

describe("default creature behavior (integration)", () => {
  it("moves toward a placed organic particle over a few ticks", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 100, y: 100 });
    w.creatures.push(c);
    for (let i = 0; i < 550; i++) {
      w.particles.push({
        x: 700, y: 500 + (i % 50),
        z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "rock",
      });
    }
    w.particles.push({
      x: 160, y: 100, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "organic",
    });
    for (let i = 0; i < 30; i++) step(w, 1 / 60);
    const stillThere = w.particles.some(
      (p) => p.material === "organic" && p.x > 150 && p.x < 170,
    );
    if (stillThere) {
      expect(w.creatures[0].x).toBeGreaterThan(100);
    } else {
      expect(w.creatures[0].reserves.organic).toBeGreaterThan(0);
    }
  });

  it("default creature with REPRODUCE byte set but threshold not met does not spawn", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    c.reserves.organic = 10;
    for (const id of M) if (id !== "organic") c.reserves[id] = 200;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(1);
  });
});
