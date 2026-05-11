// Simulation tests.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  type World, type Creature, type MaterialId,
  MATERIALS, MATERIAL_IDS_ORDERED,
  createWorld, seedParticles, step, genomeColor,
} from "../sim";
import { OP, makeDefaultGenome, newVMState } from "../genome";

const M = MATERIAL_IDS_ORDERED;

function quietWorld(): World {
  return {
    width: 800, height: 600, depth: 24, t: 0,
    particles: [], creatures: [],
    particleTarget: 550, particleSpawnRate: 30, extinctionCount: 0,
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

afterEach(() => { vi.restoreAllMocks(); });

describe("createWorld", () => {
  it("populated world", () => {
    const w = createWorld(800, 600);
    expect(w.particles.length).toBeGreaterThan(0);
    expect(w.creatures.length).toBe(1);
    expect(w.extinctionCount).toBe(0);
    expect(w.particleTarget).toBeGreaterThan(0);
    expect(w.particleSpawnRate).toBeGreaterThan(0);
  });
  it("particleTarget scales with area", () => {
    const small = createWorld(800, 600);
    const big = createWorld(1600, 1200);
    expect(big.particleTarget).toBeGreaterThan(small.particleTarget * 3);
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
    seedParticles(w, 10); seedParticles(w, 5);
    expect(w.particles.length).toBe(5);
  });
});

describe("physics: gravity & buoyancy", () => {
  it("dense sinks", () => {
    const w = quietWorld(); w.gravity = 100;
    w.particles.push({ x: 100, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 4, material: "rock" });
    step(w, 0.1);
    expect(w.particles[0].vy).toBeGreaterThan(0);
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
  it("decays", () => {
    const w = quietWorld(); w.drag = 2.0;
    w.particles.push({ x: 100, y: 100, z: 12, vx: 50, vy: 0, vz: 0, r: 4, material: "organic" });
    for (let i = 0; i < 180; i++) step(w, 1 / 60);
    expect(Math.abs(w.particles[0].vx)).toBeLessThan(5);
  });
});

describe("physics: walls", () => {
  it("x bounces", () => {
    const w = quietWorld(); w.xWallRestitution = 0.5;
    w.particles.push({ x: 5, y: 100, z: 12, vx: -100, vy: 0, vz: 0, r: 4, material: "organic" });
    step(w, 0.5);
    expect(w.particles[0].vx).toBeGreaterThan(0);
  });
  it("creature bounces", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 5, y: 100, vx: -100, energy: 50 });
    c.reserves.organic = 50;
    w.creatures.push(c);
    step(w, 0.1);
    expect(w.creatures.length).toBe(1);
    expect(c.x).toBeLessThan(50);
  });
});

describe("physics: collisions", () => {
  it("overlapping separate", () => {
    const w = quietWorld();
    w.particles.push(
      { x: 100, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, material: "organic" },
      { x: 103, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, material: "organic" },
    );
    step(w, 0.001);
    const dx = w.particles[1].x - w.particles[0].x;
    const dy = w.particles[1].y - w.particles[0].y;
    const dz = w.particles[1].z - w.particles[0].z;
    expect(Math.sqrt(dx*dx + dy*dy + dz*dz)).toBeGreaterThanOrEqual(w.particles[0].r + w.particles[1].r - 1e-3);
  });
});

describe("creature: metabolism", () => {
  it("organic -> energy + gas (conserved)", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0, genome: new Uint8Array([OP.HALT]) });
    c.reserves.organic = 50;
    w.creatures.push(c);
    step(w, 1.0);
    expect(c.reserves.organic).toBeLessThan(50);
    expect(c.reserves.gas).toBeGreaterThan(0);
    expect(c.reserves.organic + c.reserves.gas).toBeCloseTo(50, 3);
  });
  it("no organic -> no gas", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50, genome: new Uint8Array([OP.HALT]) });
    c.reserves.organic = 0;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(c.reserves.gas).toBeCloseTo(0, 5);
  });
});

describe("creature: photosynthesis", () => {
  const photoGenome = () => new Uint8Array([OP.PHOTOSYNTH, OP.HALT]);

  it("converts gas to organic", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 400, y: 10, energy: 100, genome: photoGenome() });
    c.reserves.gas = 30;
    w.creatures.push(c);
    step(w, 1.0);
    expect(c.reserves.gas).toBeLessThan(30);
    expect(c.reserves.organic).toBeGreaterThan(0);
  });
  it("surface > depth", () => {
    const ws = quietWorld();
    const wd = quietWorld();
    const cs = makeCreature({ x: 400, y: 10, energy: 100, genome: photoGenome() });
    cs.reserves.gas = 50;
    ws.creatures.push(cs);
    const cd = makeCreature({ x: 400, y: 500, energy: 100, genome: photoGenome() });
    cd.reserves.gas = 50;
    wd.creatures.push(cd);
    step(ws, 1.0); step(wd, 1.0);
    expect(cs.reserves.organic).toBeGreaterThan(cd.reserves.organic * 3);
  });
  it("caps at available gas", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 400, y: 10, energy: 100, genome: photoGenome() });
    c.reserves.gas = 0.5;
    w.creatures.push(c);
    step(w, 10.0);
    expect(c.reserves.gas).toBeGreaterThanOrEqual(0);
  });
  it("no PHOTOSYNTH op -> no conversion", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 400, y: 10, energy: 100, genome: new Uint8Array([OP.HALT]) });
    c.reserves.gas = 30;
    w.creatures.push(c);
    step(w, 1.0);
    expect(c.reserves.organic).toBeCloseTo(0, 3);
  });
});

describe("creature: excretion", () => {
  it("spawns particle of requested material", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 100, genome: new Uint8Array([OP.PUSH8, 20, OP.EXCRETE, 5, OP.HALT]) });
    c.reserves.gas = 30;
    w.creatures.push(c);
    for (let i = 0; i < 550; i++) w.particles.push({ x: 50+(i%700), y: 10+(i%50), z: c.z, vx: 0, vy: 0, vz: 0, r: 2, material: "sand" });
    const before = new Set(w.particles);
    step(w, 1 / 60);
    const newP = w.particles.filter((p) => !before.has(p));
    expect(newP.length).toBe(1);
    expect(newP[0].material).toBe("gas");
    expect(c.reserves.gas).toBeLessThan(30);
  });
  it("caps at reserve", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 100, genome: new Uint8Array([OP.PUSH8, 100, OP.EXCRETE, 5, OP.HALT]) });
    c.reserves.gas = 5;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(c.reserves.gas).toBeLessThan(0.5);
  });
  it("skipped below threshold", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 100, genome: new Uint8Array([OP.PUSH8, 10, OP.EXCRETE, 5, OP.HALT]) });
    c.reserves.gas = 0.1;
    w.creatures.push(c);
    const before = w.particles.length;
    step(w, 1 / 60);
    expect(c.reserves.gas).toBeCloseTo(0.1, 5);
    const newP = w.particles.slice(before);
    expect(newP.some((p) => p.material === "gas")).toBe(false);
  });
  it("particle near edge", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 400, y: 300, energy: 100, genome: new Uint8Array([OP.PUSH8, 20, OP.EXCRETE, 5, OP.HALT]) });
    c.reserves.gas = 30;
    w.creatures.push(c);
    for (let i = 0; i < 550; i++) w.particles.push({ x: 50+(i%700), y: 10+(i%50), z: c.z, vx: 0, vy: 0, vz: 0, r: 2, material: "sand" });
    const before = new Set(w.particles);
    step(w, 1 / 60);
    const newP = w.particles.filter((p) => !before.has(p) && p.material === "gas");
    expect(newP.length).toBe(1);
    const p = newP[0];
    expect(Math.hypot(p.x - 400, p.y - 300)).toBeLessThan(c.r * 2 + 5);
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
    const tg: object[] = [];
    for (let i = 0; i < 5; i++) {
      const p = { x: c.x + i*0.5, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 2, material: "rock" as const };
      w.particles.push(p); tg.push(p);
    }
    step(w, 0.001);
    expect(w.particles.filter((p) => tg.includes(p)).length).toBe(4);
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

describe("creature: VM execution cost", () => {
  it("drains energy", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50 });
    w.creatures.push(c);
    const e0 = c.energy;
    step(w, 1 / 60);
    expect(c.energy).toBeLessThan(e0);
  });
});

describe("creature: thrust", () => {
  it("toward organic", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 100, y: 100, energy: 100 });
    c.reserves.organic = 0;
    w.creatures.push(c);
    for (let i = 0; i < 550; i++) w.particles.push({ x: 700, y: 500+(i%50), z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "rock" });
    w.particles.push({ x: 250, y: 100, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "organic" });
    step(w, 0.1);
    expect(c.vx).toBeGreaterThan(0);
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
  it("non-organic-non-gas conserved", () => {
    const w = quietWorld();
    const c = makeCreature();
    for (const id of M) c.reserves[id] = 200;
    c.energy = 200;
    w.creatures.push(c);
    step(w, 1 / 60);
    const [p, ch] = w.creatures;
    for (const id of M) {
      if (id === "organic" || id === "gas") continue;
      expect(p.reserves[id] + ch.reserves[id]).toBeCloseTo(200, 5);
    }
  });
  it("organic + gas conserved", () => {
    const w = quietWorld();
    const c = makeCreature();
    for (const id of M) c.reserves[id] = 200;
    c.energy = 200;
    w.creatures.push(c);
    step(w, 1 / 60);
    const [p, ch] = w.creatures;
    expect((p.reserves.organic + ch.reserves.organic) + (p.reserves.gas + ch.reserves.gas)).toBeCloseTo(400, 5);
  });
});

describe("creature: predation", () => {
  beforeEach(() => stubRandom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]));
  const predator = () => new Uint8Array([OP.PREDATE, OP.HALT]);
  const inert = () => new Uint8Array([OP.HALT]);
  it("big eats small with PREDATE", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 100, genome: predator() });
    for (const id of M) p.reserves[id] = 100;
    const q = makeCreature({ x: 405, y: 300, energy: 30, genome: inert() });
    for (const id of M) q.reserves[id] = 10;
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(1);
    expect(w.creatures[0]).toBe(p);
  });
  it("opt-in: no PREDATE -> no engulf", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 100, genome: inert() });
    for (const id of M) p.reserves[id] = 100;
    const q = makeCreature({ x: 405, y: 300, energy: 30, genome: inert() });
    for (const id of M) q.reserves[id] = 10;
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
  });
  it("cost scales with prey mass", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 100, genome: predator() });
    for (const id of M) p.reserves[id] = 100;
    const q = makeCreature({ x: 405, y: 300, energy: 0, genome: inert() });
    for (const id of M) q.reserves[id] = 30;
    q.reserves.organic = 30;
    w.creatures.push(p, q);
    const e0 = p.energy;
    step(w, 1 / 60);
    // cost ~= 5 + 0.1 * 180 = 23
    expect(p.energy).toBeLessThan(e0 - 20);
    expect(p.energy).toBeGreaterThan(e0 - 30);
  });
  it("refused when can't afford", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 5, genome: predator() });
    for (const id of M) p.reserves[id] = 100;
    p.reserves.organic = 5;
    const q = makeCreature({ x: 405, y: 300, energy: 30, genome: inert() });
    for (const id of M) q.reserves[id] = 16;
    q.reserves.organic = 5;
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
  });
});

describe("ecology: extinction recovery", () => {
  it("counter ticks on full death", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0 });
    c.reserves.organic = 0;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.includes(c)).toBe(false);
    expect(w.extinctionCount).toBe(1);
  });
  it("respawn in bounds", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0 });
    c.reserves.organic = 0;
    w.creatures.push(c);
    step(w, 1 / 60);
    const f = w.creatures[0];
    expect(f.x).toBeGreaterThanOrEqual(0);
    expect(f.x).toBeLessThanOrEqual(w.width);
    expect(f.y).toBeGreaterThanOrEqual(0);
    expect(f.y).toBeLessThanOrEqual(w.height);
  });
  it("repeated extinctions counted", () => {
    const w = quietWorld();
    for (let i = 0; i < 3; i++) {
      const c = w.creatures[0] ?? makeCreature({ energy: 0 });
      c.energy = 0;
      c.reserves.organic = 0;
      if (w.creatures.length === 0) w.creatures.push(c);
      step(w, 1 / 60);
    }
    expect(w.extinctionCount).toBe(3);
  });
});

describe("creature: death by starvation", () => {
  it("dies + recovers", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0 });
    c.reserves.organic = 0;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.includes(c)).toBe(false);
    expect(w.extinctionCount).toBe(1);
  });
  it("releases reserves", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0 });
    c.reserves.organic = 0;
    c.reserves.rock = 50;
    const before = w.particles.length;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.particles.length).toBeGreaterThan(before);
  });
});

describe("creature: reproduction cooldown", () => {
  beforeEach(() => stubRandom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]));
  it("parent can't refission immediately", () => {
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
});

describe("genomeColor", () => {
  it("stable for same bytes", () => {
    expect(genomeColor(new Uint8Array([1, 2, 3]))).toBe(genomeColor(new Uint8Array([1, 2, 3])));
  });
  it("valid hsl format", () => {
    expect(genomeColor(new Uint8Array([7]))).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
  });
  it("handles empty", () => {
    expect(() => genomeColor(new Uint8Array([]))).not.toThrow();
  });
});
