// Simulation tests. Cover physics, creature behavior (metabolism, ingestion
// with cost+cooldown, thrust, VM exec cost, predation, photosynthesis,
// excretion), reproduction (affordability + conservation), death and resource
// release, extinction recovery, and ecology.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  type World,
  Creature,
  type MaterialId,
  type Molecules,
  MATERIALS,
  MATERIAL_IDS_ORDERED,
  MOLECULE_IDS,
  createWorld,
  seedParticles,
  step,
  genomeColor,
  emptyMolecules,
  advanceDivision,
  DIVISION_DURATION_SEC,
  temperatureAt,
  ParticleStore,
  pushParticle,
  CreatureStore,
  newCreature,
} from "../sim";
import { OP, makeDefaultGenome, newVMState, type VMState } from "../genome";

const M = MATERIAL_IDS_ORDERED;

// Drive any in-flight cell divisions to completion without advancing the
// rest of the simulation. Tests that examine post-fission state can call
// this immediately after the step that triggered REPRODUCE to bypass the
// 1-second visual animation.
function flushDivisions(w: World): void {
  for (const c of [...w.creatures]) {
    if (c.division) advanceDivision(c, w, DIVISION_DURATION_SEC);
  }
}

// Step the world enough times for every cell to walk a full pass of
// its genome. With vmInstrBudget=8 and the 18-op default genome
// (SENSE_AMP..HALT incl. REPAIR + reproduction gate) REPRODUCE lives
// past op 16, so three ticks are needed to reach it from a fresh PC.
function stepFullCycle(w: World, dt: number = 1 / 60): void {
  step(w, dt);
  step(w, dt);
  step(w, dt);
}

function quietWorld(): World {
  return {
    width: 800, height: 600, depth: 24, t: 0,
    particles: [], particleStore: new ParticleStore(256), creatures: [], creatureStore: new CreatureStore(64),
    particleTarget: 550, particleSpawnRate: 0, extinctionCount: 0, liveLineageRoots: new Set<number>(), nextLineageRoot: 0, founderTarget: 0,
    gravity: 0, drag: 0,
    surfaceAmp: 0, surfaceLength: 200, surfacePeriod: 1, surfaceDecay: 100,
    swellAmp: 0, swellLength: 800, swellPeriod: 1, swellDecay: 100,
    zStirAmp: 0,
    updraftAmp: 0, updraftLength: 400, updraftPeriod: 16,
    surfaceY: 0,
    surfaceWaveAmp: 0,
    aerationRate: 0,
    tempSurface: 20, tempBottom: 20, tempPatchAmp: 0,
    tempPatchLength: 400, tempPatchPeriod: 40,
    pheromone: new Float32Array(25 * 19),
    pheromoneCols: 25,
    pheromoneRows: 19,
    restitution: 0.2,
    xWallRestitution: 0.4,
    zWallRestitution: 0.6,
    collisionIters: 1,
    species: new Map(),
    phylogenyEvents: [],
    nextSpeciesLane: 0,
    anchorGenome: new Uint8Array(0),
    brownianAmp: 0,
    dayPhase: 0.25, // midday for tests so photosynthesis works normally
    dayPeriod: 90,
    disturbanceIntensity: 0,
    disturbanceStartedAt: 0,
    disturbanceUntil: 0,
    nextDisturbanceAt: Number.POSITIVE_INFINITY,
    currentAmp: 0,
    vmInstrBudget: 8,
    obstacles: [],
    atmosphere: { adp: 0, glucose: 0, fattyAcid: 0, aminoAcid: 0, chlorophyll: 0, enzyme: 0, o2: 8000, co2: 200, minerals: 0, biomass: 0, waste: 0, ribosome: 0 },
  };
}

// Per-test creature factory. Each call backs the new Creature in its
// own private CreatureStore so tests don't have to share a world's
// store. Hot loops in sim.ts dispatch through `c.store` per-creature,
// so this works regardless of whether the creature ends up in a
// world or in a standalone test scenario.
function makeCreature(overrides: Partial<{
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  r: number; density: number;
  reserves: Partial<Record<MaterialId, number>>;
  molecules: Partial<Molecules>;
  energy: number;
  senseRange: number; thrustAccel: number;
  genome: Uint8Array;
  vm: VMState;
  color: string;
  ingestCooldown: number;
  repairTicks: number;
  bornAt: number;
  speciesKey: string;
}> = {}): Creature {
  const store = new CreatureStore(1);
  const reserves: Partial<Record<MaterialId, number>> = overrides.reserves ?? {};
  // Above the default genome's biomass > 30 reproduction gate so the
  // mass-scaled REPRODUCE ATP fee fires in tests that walk the full
  // default genome.
  const molecules: Partial<Molecules> = { biomass: 50, ...(overrides.molecules ?? {}) };
  return newCreature(store, {
    x: overrides.x ?? 400,
    y: overrides.y ?? 300,
    z: overrides.z ?? 12,
    vx: overrides.vx ?? 0, vy: overrides.vy ?? 0, vz: overrides.vz ?? 0,
    r: overrides.r ?? 9,
    density: overrides.density ?? 1.0,
    energy: overrides.energy ?? 100,
    senseRange: overrides.senseRange ?? 200,
    thrustAccel: overrides.thrustAccel ?? 70,
    genome: overrides.genome ?? makeDefaultGenome(),
    vm: overrides.vm ?? newVMState(),
    color: overrides.color ?? "#ffffff",
    ingestCooldown: overrides.ingestCooldown ?? 0,
    repairTicks: overrides.repairTicks ?? 0,
    bornAt: overrides.bornAt ?? 0,
    speciesKey: overrides.speciesKey ?? "",
    molecules,
    reserves,
  });
}

function cellTotalMass(c: Creature): number {
  let m = c.energy;
  for (const id of M) m += c.reserves[id];
  for (const k of MOLECULE_IDS) m += c.molecules[k];
  return m;
}

function readyToFission(c: Creature): void {
  c.molecules.aminoAcid = 200;
  c.molecules.fattyAcid = 200;
  c.molecules.minerals = 200;
  c.molecules.biomass = 200;
  c.molecules.glucose = 50;
  c.molecules.o2 = 20;
  c.molecules.adp = 50;
}

function stubRandom(seq: number[]): void {
  let i = 0;
  vi.spyOn(Math, "random").mockImplementation(() => seq[i++ % seq.length]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createWorld", () => {
  it("populated world with ecology fields", () => {
    const w = createWorld(800, 600);
    // World starts empty of particles (they trickle in via
    // replenishParticles at particleSpawnRate) but is seeded with
    // 5-10 random founders, each its own founding lineage.
    expect(w.particles.length).toBe(0);
    expect(w.creatures.length).toBeGreaterThanOrEqual(15);
    expect(w.creatures.length).toBeLessThanOrEqual(25);
    expect(w.extinctionCount).toBe(0);
    expect(w.particleTarget).toBeGreaterThan(0);
    expect(w.particleSpawnRate).toBeGreaterThan(0);
  });

  it("particle target scales with world area", () => {
    const small = createWorld(800, 600);
    const big = createWorld(1600, 1200);
    expect(big.particleTarget).toBeGreaterThan(small.particleTarget * 3);
  });

  it("seedParticles produces requested count within bounds", () => {
    const w = quietWorld();
    seedParticles(w, 50);
    expect(w.particles.length).toBe(50);
    for (const p of w.particles) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThan(w.width);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.z).toBeGreaterThanOrEqual(p.r);
      expect(p.z).toBeLessThanOrEqual(w.depth - p.r);
      expect(p.r).toBeGreaterThanOrEqual(1);
      // Big-sand variant lets sand grains spawn up to ~r=8.
      expect(p.r).toBeLessThanOrEqual(8);
      expect(MATERIALS[p.material]).toBeDefined();
    }
  });

  it("seedParticles clears existing particles", () => {
    const w = quietWorld();
    seedParticles(w, 10);
    seedParticles(w, 5);
    expect(w.particles.length).toBe(5);
  });

  it("registers each initial founder as its own species (no parents)", () => {
    const w = createWorld(800, 600);
    // 5-10 founders means 5-10 species (each random genome is its
    // own root). Founders are at firstSeen=0 with no parent.
    expect(w.species.size).toBeGreaterThanOrEqual(15);
    expect(w.species.size).toBeLessThanOrEqual(25);
    for (const sp of w.species.values()) {
      expect(sp.firstSeen).toBe(0);
      expect(sp.parents.size).toBe(0);
    }
    expect(w.phylogenyEvents.length).toBe(0);
  });
});

describe("physics: gravity & buoyancy", () => {
  it("denser-than-water material sinks", () => {
    const w = quietWorld(); w.gravity = 100;
    pushParticle(w, { x: 100, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 4, material: "rock" });
    step(w, 0.1);
    expect(w.particles[0].vy).toBeGreaterThan(0);
    expect(w.particles[0].y).toBeGreaterThan(100);
  });
  it("less-dense-than-water material rises", () => {
    const w = quietWorld(); w.gravity = 100;
    pushParticle(w, { x: 100, y: 300, z: 12, vx: 0, vy: 0, vz: 0, r: 4, material: "gas" });
    step(w, 0.1);
    expect(w.particles[0].vy).toBeLessThan(0);
    expect(w.particles[0].y).toBeLessThan(300);
  });
  it("density-1 material (organic) has no net vertical force", () => {
    const w = quietWorld(); w.gravity = 100;
    pushParticle(w, { x: 100, y: 300, z: 12, vx: 0, vy: 0, vz: 0, r: 4, material: "organic" });
    step(w, 0.1);
    expect(Math.abs(w.particles[0].vy)).toBeLessThan(1e-6);
  });
});

describe("physics: drag", () => {
  it("decays velocity toward zero over time", () => {
    const w = quietWorld(); w.drag = 2.0;
    pushParticle(w, { x: 100, y: 100, z: 12, vx: 50, vy: 0, vz: 0, r: 4, material: "organic" });
    for (let i = 0; i < 180; i++) step(w, 1 / 60);
    expect(Math.abs(w.particles[0].vx)).toBeLessThan(5);
  });
  it("doesn't reverse velocity sign in one step", () => {
    const w = quietWorld(); w.drag = 0.6;
    pushParticle(w, { x: 100, y: 100, z: 12, vx: 50, vy: 0, vz: 0, r: 4, material: "organic" });
    step(w, 1 / 60);
    expect(w.particles[0].vx).toBeGreaterThan(0);
    expect(w.particles[0].vx).toBeLessThan(50);
  });
});

describe("physics: walls", () => {
  it("x bounces off the left wall", () => {
    const w = quietWorld(); w.xWallRestitution = 0.5;
    pushParticle(w, { x: 5, y: 100, z: 12, vx: -100, vy: 0, vz: 0, r: 4, material: "organic" });
    step(w, 0.5);
    expect(w.particles[0].x).toBeLessThan(w.width / 2);
    expect(w.particles[0].x).toBeGreaterThanOrEqual(w.particles[0].r - 1e-6);
    expect(w.particles[0].vx).toBeGreaterThan(0);
  });
  it("x bounces off the right wall", () => {
    const w = quietWorld();
    pushParticle(w, { x: 795, y: 100, z: 12, vx: 100, vy: 0, vz: 0, r: 4, material: "organic" });
    step(w, 0.5);
    expect(w.particles[0].x).toBeGreaterThan(w.width / 2);
    expect(w.particles[0].vx).toBeLessThan(0);
  });
  it("creature bounces off side walls (no toroidal sweep)", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 5, y: 100, vx: -100, energy: 50 });
    c.reserves.organic = 50;
    w.creatures.push(c);
    step(w, 0.1);
    expect(w.creatures.length).toBe(1);
    expect(c.x).toBeGreaterThanOrEqual(c.r - 1e-6);
    expect(c.x).toBeLessThan(50);
  });
  it("y clamps at the floor and zeros downward velocity", () => {
    const w = quietWorld();
    pushParticle(w, { x: 100, y: 595, z: 12, vx: 0, vy: 50, vz: 0, r: 4, material: "organic" });
    step(w, 0.5);
    expect(w.particles[0].y + w.particles[0].r).toBeLessThanOrEqual(w.height + 1e-6);
    expect(w.particles[0].vy).toBeLessThanOrEqual(0);
  });
  it("y clamps at the ceiling", () => {
    const w = quietWorld();
    pushParticle(w, { x: 100, y: 1, z: 12, vx: 0, vy: -50, vz: 0, r: 4, material: "organic" });
    step(w, 0.5);
    expect(w.particles[0].y).toBeGreaterThanOrEqual(w.particles[0].r - 1e-6);
    expect(w.particles[0].vy).toBeGreaterThanOrEqual(0);
  });
  it("z reflects with restitution on both faces", () => {
    const w = quietWorld(); w.zWallRestitution = 0.5;
    pushParticle(w, { x: 100, y: 100, z: 1, vx: 0, vy: 0, vz: -50, r: 4, material: "organic" });
    step(w, 0.1);
    expect(w.particles[0].vz).toBeGreaterThan(0);
    expect(w.particles[0].vz).toBeLessThan(50);
  });
});

describe("physics: collisions", () => {
  it("two overlapping particles get separated", () => {
    const w = quietWorld();
    pushParticle(w, { x: 100, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, material: "organic" });
    pushParticle(w, { x: 103, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, material: "organic" });
    step(w, 0.001);
    const dx = w.particles[1].x - w.particles[0].x;
    const dy = w.particles[1].y - w.particles[0].y;
    const dz = w.particles[1].z - w.particles[0].z;
    expect(Math.sqrt(dx*dx + dy*dy + dz*dz)).toBeGreaterThanOrEqual(w.particles[0].r + w.particles[1].r - 1e-3);
  });
  it("co-located particles resolve without crashing", () => {
    const w = quietWorld();
    pushParticle(w, { x: 100, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, material: "organic" });
    pushParticle(w, { x: 100, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, material: "organic" });
    expect(() => step(w, 0.001)).not.toThrow();
    const dx = w.particles[1].x - w.particles[0].x;
    const dy = w.particles[1].y - w.particles[0].y;
    const dz = w.particles[1].z - w.particles[0].z;
    expect(Math.sqrt(dx*dx + dy*dy + dz*dz)).toBeGreaterThan(0);
  });
  it("denser particle moves less than lighter on overlap", () => {
    const w = quietWorld();
    pushParticle(w, { x: 100, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, material: "rock" });
    pushParticle(w, { x: 105, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, material: "gas" });
    step(w, 0.001);
    expect(Math.abs(w.particles[1].x - 105)).toBeGreaterThan(Math.abs(w.particles[0].x - 100));
  });
  it("non-overlapping particles don't move from collision", () => {
    const w = quietWorld();
    pushParticle(w, { x: 100, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 3, material: "rock" });
    pushParticle(w, { x: 200, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 3, material: "rock" });
    step(w, 0.001);
    expect(w.particles[0].x).toBeCloseTo(100, 5);
    expect(w.particles[1].x).toBeCloseTo(200, 5);
  });
});

describe("physics: waves", () => {
  it("surface wave forcing decays with depth", () => {
    const wS = quietWorld(); wS.surfaceAmp = 200; wS.surfaceDecay = 50;
    pushParticle(wS, { x: 100, y: 10, z: 12, vx: 0, vy: 0, vz: 0, r: 4, material: "organic" });
    const wD = quietWorld(); wD.surfaceAmp = 200; wD.surfaceDecay = 50;
    pushParticle(wD, { x: 100, y: 400, z: 12, vx: 0, vy: 0, vz: 0, r: 4, material: "organic" });
    step(wS, 0.1); step(wD, 0.1);
    expect(Math.abs(wS.particles[0].vx)).toBeGreaterThan(Math.abs(wD.particles[0].vx) * 5);
  });
});

describe("creature: chemistry - catabolism + respiration", () => {
  it("organic catabolizes into glucose / amino-acid / fatty-acid molecules", () => {
    const w = quietWorld();
    // Catabolize is gated on enzyme molecule (zero enz -> no digestion).
    const c = makeCreature({
      energy: 100, genome: new Uint8Array([OP.HALT]),
      molecules: { enzyme: 5 },
    });
    c.reserves.organic = 50;
    w.creatures.push(c);
    step(w, 1.0);
    expect(c.reserves.organic).toBeLessThan(50);
    expect(c.molecules.glucose).toBeGreaterThan(0);
    expect(c.molecules.aminoAcid).toBeGreaterThan(0);
    expect(c.molecules.fattyAcid).toBeGreaterThan(0);
  });
  it("aerobic respiration: glucose + O2 produces ATP and CO2", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0, genome: new Uint8Array([OP.HALT]) });
    c.molecules.glucose = 20;
    c.molecules.o2 = 20;
    c.molecules.adp = 200;
    w.creatures.push(c);
    step(w, 1.0);
    expect(c.energy).toBeGreaterThan(0);
    expect(c.molecules.glucose).toBeLessThan(20);
    expect(c.molecules.o2).toBeLessThan(20);
    expect(c.molecules.co2).toBeGreaterThan(0);
  });
  it("fermentation: glucose alone (no O2) still makes ATP but produces waste", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0, genome: new Uint8Array([OP.HALT]) });
    c.molecules.glucose = 20;
    c.molecules.adp = 50;
    w.creatures.push(c);
    step(w, 1.0);
    expect(c.energy).toBeGreaterThan(0);
    expect(c.molecules.waste).toBeGreaterThan(0);
  });
  it("no fuel + no ATP -> dies", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0, genome: new Uint8Array([OP.HALT]) });
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.includes(c)).toBe(false);
  });
});

describe("creature: cost-of-bigness (surface-area-vs-volume)", () => {
  it("baseline metabolic drain is higher for cells with more stored mass", () => {
    const w = quietWorld();
    const small = makeCreature({ x: 100, y: 300, energy: 100, genome: new Uint8Array([OP.HALT]) });
    const big = makeCreature({ x: 700, y: 300, energy: 100, genome: new Uint8Array([OP.HALT]) });
    big.reserves.rock = 15000;
    w.creatures.push(small, big);
    step(w, 1.0);
    const drainSmall = 100 - small.energy;
    const drainBig = 100 - big.energy;
    expect(drainBig).toBeGreaterThan(drainSmall * 4);
  });
  it("ingest cooldown shortens for bigger cells (membrane scales with perimeter)", () => {
    const wS = quietWorld();
    const cs = makeCreature({ energy: 50, genome: new Uint8Array([OP.INGEST, 0, OP.HALT]) });
    wS.creatures.push(cs);
    pushParticle(wS, { x: cs.x, y: cs.y, z: cs.z, vx: 0, vy: 0, vz: 0, r: 3, material: "rock" });
    step(wS, 0.001);
    const cdSmall = cs.ingestCooldown;

    const wB = quietWorld();
    const cb = makeCreature({ energy: 50, genome: new Uint8Array([OP.INGEST, 0, OP.HALT]) });
    cb.reserves.rock = 4000;
    wB.creatures.push(cb);
    pushParticle(wB, { x: cb.x, y: cb.y, z: cb.z, vx: 0, vy: 0, vz: 0, r: 3, material: "rock" });
    step(wB, 0.001);
    const cdBig = cb.ingestCooldown;

    expect(cdBig).toBeLessThan(cdSmall * 0.5);
    expect(cdSmall).toBeGreaterThan(0.05);
  });
  it("thrust energy cost scales with mass", () => {
    function run(rockMass: number): number {
      const w = quietWorld();
      // Use a thrust-only genome so the drain measures thrust cost
      // directly. The old version leaned on REPRODUCE's mass-scaled
      // attempt fee, but post-fission-gate-removal the first attempt
      // succeeds and parent.division blocks further attempts -- only
      // one fee per run, which no longer separates big from small.
      const c = makeCreature({
        x: 100, y: 300, energy: 100,
        genome: new Uint8Array([OP.PUSH8, 80, OP.THRUST, OP.HALT]),
      });
      c.reserves.organic = 0;
      c.reserves.rock = rockMass;
      w.creatures.push(c);
      const e0 = c.energy;
      step(w, 0.1);
      step(w, 0.1);
      step(w, 0.1);
      return e0 - c.energy;
    }
    const drainSmall = run(0);
    const drainBig = run(5000);
    // Thrust cost scales as cube root of mass (~Stokes drag), so a
    // 26x mass ratio (200 -> 5200) yields ~3x drain, not 26x. The
    // old 5x threshold leaned on REPRODUCE's linear mass-fee.
    expect(drainBig).toBeGreaterThan(drainSmall * 2);
  });
});

describe("creature: chemistry - photosynthesis", () => {
  it("chlorophyll + CO2 + light fixes carbon (CO2 -> glucose + O2)", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 400, y: 10, energy: 100, genome: new Uint8Array([OP.HALT]) });
    c.molecules.chlorophyll = 5;
    c.molecules.co2 = 20;
    w.creatures.push(c);
    step(w, 1.0);
    expect(c.molecules.co2).toBeLessThan(20);
    expect(c.molecules.glucose).toBeGreaterThan(0);
    expect(c.molecules.o2).toBeGreaterThan(0);
  });
  it("zero chlorophyll => no photosynthesis (chl is the mandatory pigment)", () => {
    // Re-restored gate after fixing the dead chl molecule: photosynth
    // rate scales with chlorophyll / CHL_REF, so a cell with no chl
    // can't fix carbon regardless of light or CO2 availability.
    const w = quietWorld();
    const c = makeCreature({ x: 400, y: 10, energy: 100 });
    c.molecules.co2 = 5;
    c.molecules.chlorophyll = 0;
    w.creatures.push(c);
    const glu0 = c.molecules.glucose;
    step(w, 1.0);
    expect(c.molecules.glucose).toBeCloseTo(glu0, 3);
  });
  it("at depth, much less light -> much less photosynthesis", () => {
    const wS = quietWorld(), wD = quietWorld();
    const surface = makeCreature({ x: 400, y: 10, energy: 100, genome: new Uint8Array([OP.HALT]) });
    surface.molecules.chlorophyll = 5;
    surface.molecules.co2 = 50;
    wS.creatures.push(surface);
    const deep = makeCreature({ x: 400, y: 500, energy: 100, genome: new Uint8Array([OP.HALT]) });
    deep.molecules.chlorophyll = 5;
    deep.molecules.co2 = 50;
    wD.creatures.push(deep);
    step(wS, 1.0); step(wD, 1.0);
    expect(surface.molecules.glucose).toBeGreaterThan(deep.molecules.glucose * 3);
  });
  it("photosynthesis costs ATP (substrate-level: CO2 + ATP -> glucose + O2 + ADP)", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 400, y: 10, energy: 50, genome: new Uint8Array([OP.HALT]) });
    c.molecules.chlorophyll = 5;
    c.molecules.co2 = 20;
    w.creatures.push(c);
    const e0 = c.energy;
    const adp0 = c.molecules.adp;
    step(w, 1.0);
    expect(c.energy).toBeLessThan(e0);
    expect(c.molecules.adp).toBeGreaterThan(adp0);
  });
});

describe("creature: excretion", () => {
  it("EXCRETE spawns a particle of the requested material", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 100, genome: new Uint8Array([OP.PUSH8, 20, OP.EXCRETE, 5, OP.HALT]) });
    c.reserves.gas = 30;
    w.creatures.push(c);
    for (let i = 0; i < 550; i++) pushParticle(w, { x: 50+(i%700), y: 10+(i%50), z: c.z, vx: 0, vy: 0, vz: 0, r: 2, material: "sand" });
    const before = new Set(w.particles);
    step(w, 1 / 60);
    const newP = w.particles.filter((p) => !before.has(p));
    expect(newP.length).toBe(1);
    expect(newP[0].material).toBe("gas");
    expect(c.reserves.gas).toBeLessThan(30);
  });
  it("caps at available reserve", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 100, genome: new Uint8Array([OP.PUSH8, 100, OP.EXCRETE, 5, OP.HALT]) });
    c.reserves.gas = 5;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(c.reserves.gas).toBeGreaterThanOrEqual(0);
    expect(c.reserves.gas).toBeLessThan(0.5);
  });
  it("skipped when reserve below threshold", () => {
    const w = quietWorld();
    w.particleSpawnRate = 0;
    const c = makeCreature({ energy: 100, genome: new Uint8Array([OP.PUSH8, 10, OP.EXCRETE, 5, OP.HALT]) });
    c.reserves.gas = 0.1;
    w.creatures.push(c);
    const before = w.particles.length;
    step(w, 1 / 60);
    expect(c.reserves.gas).toBeCloseTo(0.1, 2);
    const newP = w.particles.slice(before);
    expect(newP.some((p) => p.material === "gas")).toBe(false);
  });
  it("particle spawns near the cell edge", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 400, y: 300, energy: 100, genome: new Uint8Array([OP.PUSH8, 20, OP.EXCRETE, 5, OP.HALT]) });
    c.reserves.gas = 30;
    w.creatures.push(c);
    for (let i = 0; i < 550; i++) pushParticle(w, { x: 50+(i%700), y: 10+(i%50), z: c.z, vx: 0, vy: 0, vz: 0, r: 2, material: "sand" });
    const before = new Set(w.particles);
    step(w, 1 / 60);
    const newP = w.particles.filter((p) => !before.has(p) && p.material === "gas");
    expect(newP.length).toBe(1);
    const p = newP[0];
    expect(Math.hypot(p.x - 400, p.y - 300)).toBeLessThan(c.r * 2 + 5);
  });
});

// Genome that flips INGEST on for every material -- mirrors the old
// auto-ingest behavior so legacy ingestion tests don't have to care
// about per-material gates.
const OMNIVORE = new Uint8Array([
  OP.INGEST, 0, OP.INGEST, 1, OP.INGEST, 2,
  OP.INGEST, 3, OP.INGEST, 4, OP.INGEST, 5, OP.HALT,
]);

describe("creature: ingestion cost and cooldown", () => {
  it("charges per-event energy on ingestion", () => {
    const w = quietWorld();
    w.particleSpawnRate = 0;
    const c = makeCreature({ energy: 50, genome: OMNIVORE });
    w.creatures.push(c);
    pushParticle(w, { x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "rock" });
    const e0 = c.energy;
    step(w, 0.001);
    expect(w.particles.length).toBe(0);
    expect(c.energy).toBeLessThan(e0);
  });
  it("absorbs only one particle per cooldown window", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50, genome: OMNIVORE });
    w.creatures.push(c);
    const targets: object[] = [];
    for (let i = 0; i < 5; i++) {
      const p = pushParticle(w, { x: c.x + i*0.5, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 2, material: "rock" });
      targets.push(p);
    }
    step(w, 0.001);
    expect(w.particles.filter((p) => targets.includes(p)).length).toBe(4);
    expect(c.ingestCooldown).toBeGreaterThan(0);
  });
  it("cooldown blocks further eating until expired", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50, genome: OMNIVORE });
    w.creatures.push(c);
    for (let i = 0; i < 550; i++) pushParticle(w, { x: 50+(i%700), y: 10+(i%50), z: c.z, vx: 0, vy: 0, vz: 0, r: 2, material: "sand" });
    const targets: object[] = [];
    for (let i = 0; i < 5; i++) {
      const p = pushParticle(w, { x: c.x + i*0.5, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 2, material: "rock" });
      targets.push(p);
    }
    for (let i = 0; i < 5; i++) step(w, 0.01);
    expect(w.particles.filter((p) => targets.includes(p)).length).toBe(4);
  });
  it("absorbs again after cooldown", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50, genome: OMNIVORE });
    w.creatures.push(c);
    for (let i = 0; i < 550; i++) pushParticle(w, { x: 50+(i%700), y: 10+(i%50), z: c.z, vx: 0, vy: 0, vz: 0, r: 2, material: "sand" });
    const tgt = new Set<unknown>();
    for (let i = 0; i < 3; i++) {
      const p = pushParticle(w, { x: c.x + i*0.5, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 2, material: "rock" });
      tgt.add(p);
    }
    for (let i = 0; i < 60; i++) step(w, 1 / 60);
    expect(w.particles.filter((p) => tgt.has(p)).length).toBeLessThan(3);
  });
  it("won't absorb without enough energy to pay", () => {
    const w = quietWorld();
    // ATP starts at 0 so ingestion can't pay INGEST_ENERGY_COST. Glucose
    // keeps the cell from autolyzing on this step so we can still observe
    // the no-ingest behavior.
    const c = makeCreature({ energy: 0 });
    c.molecules.glucose = 1;
    w.creatures.push(c);
    pushParticle(w, { x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "rock" });
    step(w, 0.001);
    expect(w.particles.length).toBe(1);
  });
});

describe("creature: ingestion (basic)", () => {
  it("absorbs a particle inside the cell radius", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50, genome: OMNIVORE });
    w.creatures.push(c);
    const target = pushParticle(w, { x: c.x + 2, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "lipid" });
    step(w, 0.001);
    expect(w.particles.includes(target)).toBe(false);
    expect(c.reserves.lipid).toBeGreaterThan(0);
  });
  it("does not absorb particles outside the cell", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50, genome: OMNIVORE });
    w.creatures.push(c);
    pushParticle(w, { x: c.x + c.r + 10, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "lipid" });
    step(w, 0.001);
    expect(w.particles.length).toBe(1);
  });
  it("reserve gain matches density * pi * r^2", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50, genome: OMNIVORE });
    w.creatures.push(c);
    pushParticle(w, { x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "rock" });
    step(w, 0.001);
    expect(c.reserves.rock).toBeCloseTo(MATERIALS.rock.density * (4 / 3) * Math.PI * 27, 5);
  });
  it("INGEST is material-selective: rock genome ignores lipid", () => {
    const w = quietWorld();
    // INGEST 0 -> rock only.
    const c = makeCreature({ energy: 50, genome: new Uint8Array([OP.INGEST, 0, OP.HALT]) });
    w.creatures.push(c);
    const target = pushParticle(w, { x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "lipid" });
    step(w, 0.001);
    expect(w.particles.includes(target)).toBe(true);
    expect(c.reserves.lipid).toBe(0);
  });
});

describe("creature: VM execution cost", () => {
  it("running the genome drains energy each tick", () => {
    const w = quietWorld();
    // Use a no-side-effect genome so the only ATP cost is the per-
    // instruction VM tax. The default genome includes REPRODUCE, which
    // burns the per-attempt ATP fee on every tick and dominates the
    // expected sub-1-ATP drain.
    const c = makeCreature({
      energy: 50,
      genome: new Uint8Array([OP.NOP, OP.NOP, OP.NOP, OP.HALT]),
    });
    w.creatures.push(c);
    const e0 = c.energy;
    step(w, 1 / 60);
    expect(c.energy).toBeLessThan(e0);
    expect(e0 - c.energy).toBeLessThan(1);
  });
  it("longer programs cost more energy", () => {
    // Without HALT as a yield, both genomes run the full vmInstrBudget
    // every tick by cycling. We still expect more total work / more
    // ATP drain from a longer genome's bigger walk -- and we keep the
    // comparison by giving w1 a tiny genome (just a NOP) and w2 a
    // longer one. Per-instruction ATP scales with ops executed.
    const w1 = quietWorld();
    const c1 = makeCreature({ energy: 50 });
    c1.genome = new Uint8Array([OP.NOP]);
    w1.creatures.push(c1);
    step(w1, 1 / 60);
    const w2 = quietWorld();
    const c2 = makeCreature({ energy: 50 });
    const ops: number[] = [];
    for (let i = 0; i < 20; i++) ops.push(OP.NOP);
    c2.genome = new Uint8Array(ops);
    w2.creatures.push(c2);
    step(w2, 1 / 60);
    // c2's genome is longer so a tick walks past more bytes, but ATP
    // cost is per-instruction not per-byte and both hit the budget,
    // so the difference is mostly maintenance / baseline. Assert
    // c2 spent at least as much as c1.
    expect(50 - c2.energy).toBeGreaterThanOrEqual(50 - c1.energy);
  });
});

describe("creature: TURN rotates velocity", () => {
  it("PUSH8 + TURN rotates the cell's velocity vector", () => {
    const w = quietWorld();
    // Without HALT yielding, the budget-bound VM cycles the genome
    // multiple times per tick -- TURN ends up firing several times
    // and the velocity rotates by N radians. We assert that direction
    // changed (vx != 10, vy != 0) and total speed roughly preserved,
    // rather than the exact angle.
    const c = makeCreature({
      x: 400, y: 300, vx: 10, vy: 0, energy: 100,
      genome: new Uint8Array([OP.PUSH8, 1, OP.TURN]),
    });
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(c.vx).not.toBe(10);
    expect(c.vy).not.toBe(0);
    const speed = Math.hypot(c.vx, c.vy);
    expect(speed).toBeGreaterThan(9);
    expect(speed).toBeLessThan(11);
  });
  it("no TURN op means no rotation", () => {
    const w = quietWorld();
    const c = makeCreature({
      x: 400, y: 300, vx: 10, vy: 0, energy: 100,
      genome: new Uint8Array([OP.HALT]),
    });
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(c.vy).toBeCloseTo(0, 4);
  });
});

describe("creature: thrust", () => {
  it("thrusts toward a placed organic particle", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 100, y: 100, energy: 100 });
    c.reserves.organic = 0;
    w.creatures.push(c);
    for (let i = 0; i < 550; i++) pushParticle(w, { x: 700, y: 500+(i%50), z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "rock" });
    pushParticle(w, { x: 250, y: 100, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "organic" });
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
    pushParticle(w, { x: 700, y: 0, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "organic" });
    step(w, 1.0);
    expect(c.vx).toBeLessThanOrEqual(50 + 1e-6);
  });
  it("creature with no energy cannot thrust", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 100, y: 100, energy: 0 });
    c.reserves.organic = 0;
    w.creatures.push(c);
    pushParticle(w, { x: 300, y: 100, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "organic" });
    step(w, 0.1);
    expect(c.vx).toBeCloseTo(0, 6);
  });
});

describe("creature: reproduction", () => {
  beforeEach(() => stubRandom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.05, 0.15]));
  it("does not reproduce when reserves are insufficient", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    c.reserves.organic = 200;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(1);
  });
  it("reproduces when all six material reserves cover cost", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    for (const id of M) c.reserves[id] = 200; readyToFission(c);
    w.creatures.push(c);
    stepFullCycle(w);
    flushDivisions(w);
    expect(w.creatures.length).toBe(2);
  });
  it("both daughters have positive energy after default-skew fission", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    for (const id of M) c.reserves[id] = 200; readyToFission(c);
    w.creatures.push(c);
    stepFullCycle(w);
    flushDivisions(w);
    const [p, ch] = w.creatures;
    // Default reproduceFraction=0.4 -- parent keeps 40%, child gets
    // 60%. Subsequent within-tick aerobic respiration tends to
    // equalize them, so we just assert both ended up viably ATP-
    // positive rather than checking the exact split.
    expect(p.energy).toBeGreaterThan(0);
    expect(ch.energy).toBeGreaterThan(0);
  });
  it("cell mass is conserved across fission (no additive yolk)", () => {
    const w = quietWorld();
    const c = makeCreature();
    for (const id of M) c.reserves[id] = 200; readyToFission(c);
    c.energy = 200;
    const totalBefore = cellTotalMass(c);
    w.creatures.push(c);
    stepFullCycle(w);
    flushDivisions(w);
    const [p, ch] = w.creatures;
    // No more yolk -- parent + child mass equals the parent's
    // pre-fission mass minus the REPRODUCE attempt ATP fee.
    const totalAfter = cellTotalMass(p) + cellTotalMass(ch);
    expect(totalAfter).toBeLessThanOrEqual(totalBefore + 0.01);
    // ...but only by a small amount (the fee + some intra-tick
    // metabolism, not a huge swing).
    expect(totalBefore - totalAfter).toBeLessThan(40);
  });
  it("organic accounts for metabolism during tick", () => {
    const w = quietWorld();
    const c = makeCreature();
    for (const id of M) c.reserves[id] = 200; readyToFission(c);
    c.energy = 200;
    c.molecules.enzyme = 5; // catabolize gates on enzyme now
    w.creatures.push(c);
    stepFullCycle(w);
    flushDivisions(w);
    const total = w.creatures[0].reserves.organic + w.creatures[1].reserves.organic;
    expect(total).toBeLessThan(200);
    expect(total).toBeGreaterThan(199);
  });
  it("child genome is a fresh (possibly mutated) copy", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    for (const id of M) c.reserves[id] = 200; readyToFission(c);
    w.creatures.push(c);
    stepFullCycle(w);
    flushDivisions(w);
    expect(w.creatures[1].genome).not.toBe(c.genome);
    expect(Math.abs(w.creatures[1].genome.length - c.genome.length)).toBeLessThanOrEqual(5);
  });
  it("respects MAX_CREATURES cap", () => {
    const w = quietWorld();
    for (let i = 0; i < 400; i++) {
      const c = makeCreature({ x: 100 + (i % 80) * 5, y: 100 + Math.floor(i / 80) * 5, energy: 200 });
      for (const id of M) c.reserves[id] = 500; readyToFission(c); readyToFission(c);
      w.creatures.push(c);
    }
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(400);
  });
});

describe("creature: predation (cell eats cell)", () => {
  beforeEach(() => stubRandom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]));
  function totalMass(c: Creature): number {
    let m = 0;
    for (const id of M) m += c.reserves[id];
    return m;
  }
  const inert = () => new Uint8Array([OP.HALT]);
  const predator = () => new Uint8Array([OP.PREDATE, OP.HALT]);

  it("big eats small on overlap with PREDATE", () => {
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
  it("predator absorbs prey's reserves and energy", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 100, genome: predator() });
    for (const id of M) p.reserves[id] = 100;
    const q = makeCreature({ x: 405, y: 300, energy: 50, genome: inert() });
    for (const id of M) q.reserves[id] = 10;
    w.creatures.push(p, q);
    const m0 = totalMass(p), pm = totalMass(q), pe = q.energy;
    step(w, 1 / 60);
    expect(totalMass(w.creatures[0])).toBeGreaterThanOrEqual(m0 + pm - 1);
    expect(w.creatures[0].energy).toBeGreaterThan(pe);
  });
  it("equal-mass overlapping cells don't engulf each other", () => {
    const w = quietWorld();
    const a = makeCreature({ x: 400, y: 300, energy: 100, genome: inert() });
    for (const id of M) a.reserves[id] = 50;
    const b = makeCreature({ x: 405, y: 300, energy: 100, genome: inert() });
    for (const id of M) b.reserves[id] = 50;
    w.creatures.push(a, b);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
  });
  it("engulf pays cost (net positive after prey energy gift)", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 100, genome: predator() });
    for (const id of M) p.reserves[id] = 200;
    const q = makeCreature({ x: 405, y: 300, energy: 20, genome: inert() });
    for (const id of M) q.reserves[id] = 1;
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(w.creatures[0].energy).toBeGreaterThan(100);
    expect(w.creatures[0].energy).toBeLessThan(125);
  });
  it("predator gets longer cooldown after engulf", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 100, genome: predator() });
    for (const id of M) p.reserves[id] = 200;
    const q = makeCreature({ x: 405, y: 300, energy: 20, genome: inert() });
    for (const id of M) q.reserves[id] = 1;
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(w.creatures[0].ingestCooldown).toBeGreaterThan(0.15);
  });
  it("non-overlapping cells don't engulf", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 100, y: 300, energy: 100, genome: predator() });
    for (const id of M) p.reserves[id] = 200;
    const q = makeCreature({ x: 600, y: 300, energy: 20, genome: inert() });
    for (const id of M) q.reserves[id] = 1;
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
  });
  it("cooldown blocks engulf", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 100, ingestCooldown: 1.0, genome: predator() });
    for (const id of M) p.reserves[id] = 200;
    const q = makeCreature({ x: 405, y: 300, energy: 20, genome: inert() });
    for (const id of M) q.reserves[id] = 1;
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
  });
  it("low energy blocks engulf", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 1, genome: predator() });
    for (const id of M) p.reserves[id] = 200;
    p.reserves.organic = 0;
    const q = makeCreature({ x: 405, y: 300, energy: 50, genome: inert() });
    for (const id of M) q.reserves[id] = 1;
    q.reserves.organic = 5;
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
  });
  it("predation is opt-in: no PREDATE -> no engulf", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 100, genome: inert() });
    for (const id of M) p.reserves[id] = 100;
    const q = makeCreature({ x: 405, y: 300, energy: 30, genome: inert() });
    for (const id of M) q.reserves[id] = 10;
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
  });
  it("predation energy cost scales with prey mass", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 100, genome: predator() });
    for (const id of M) p.reserves[id] = 100;
    const q = makeCreature({ x: 405, y: 300, energy: 0, genome: inert() });
    for (const id of M) q.reserves[id] = 30;
    q.reserves.organic = 30;
    w.creatures.push(p, q);
    const e0 = p.energy;
    step(w, 1 / 60);
    expect(p.energy).toBeLessThan(e0 - 20);
    expect(p.energy).toBeGreaterThan(e0 - 30);
  });
  it("predation refused when can't afford the prey-mass cost", () => {
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
  it("engulfing does NOT spawn death particles", () => {
    const w = quietWorld();
    for (let i = 0; i < 550; i++) pushParticle(w, { x: 50+(i%700), y: 10+(i%50), z: 12, vx: 0, vy: 0, vz: 0, r: 2, material: "sand" });
    const before = new Set(w.particles);
    const p = makeCreature({ x: 400, y: 300, energy: 100, genome: predator() });
    for (const id of M) p.reserves[id] = 200;
    const q = makeCreature({ x: 405, y: 300, energy: 30, genome: inert() });
    for (const id of M) q.reserves[id] = 10;
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(w.particles.filter((p) => !before.has(p)).length).toBe(0);
  });
});

describe("creature: engulf (swallow whole, membrane intact)", () => {
  beforeEach(() => stubRandom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]));
  const inert = () => new Uint8Array([OP.HALT]);
  const swallower = () => new Uint8Array([OP.ENGULF, OP.HALT]);

  it("removes prey from world.creatures and parks it in predator.contents", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 100, genome: swallower() });
    for (const id of M) p.reserves[id] = 200;
    const q = makeCreature({ x: 405, y: 300, energy: 30, genome: inert() });
    for (const id of M) q.reserves[id] = 10;
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(1);
    expect(w.creatures[0]).toBe(p);
    expect(p.contents.length).toBe(1);
    expect(p.contents[0]).toBe(q);
  });
  it("does NOT transfer prey reserves/molecules into predator", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 100, genome: swallower() });
    for (const id of M) p.reserves[id] = 300;
    const q = makeCreature({ x: 405, y: 300, energy: 30, genome: inert() });
    q.reserves.rock = 80;
    q.molecules.glucose = 25;
    const pRockBefore = p.reserves.rock;
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(p.reserves.rock).toBeGreaterThan(pRockBefore - 5);
    expect(p.reserves.rock).toBeLessThan(pRockBefore + 1);
    expect(p.molecules.glucose).toBeLessThan(15);
    expect(p.contents.length).toBe(1);
    expect(p.contents[0].reserves.rock).toBeCloseTo(80, 1);
    expect(p.contents[0].molecules.glucose).toBeCloseTo(25, 1);
  });
  it("engulfed prey still counts toward predator mass (vacuole occupies volume)", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 100, genome: swallower() });
    p.reserves.rock = 200;
    const q = makeCreature({ x: 405, y: 300, energy: 50, genome: inert() });
    q.reserves.rock = 50;
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(cellTotalMass(p) + cellTotalMass(p.contents[0])).toBeGreaterThan(390);
  });
  it("predator death releases vacuole contents back to the world", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 100, genome: swallower() });
    for (const id of M) p.reserves[id] = 200;
    const q = makeCreature({ x: 405, y: 300, energy: 50, genome: inert() });
    for (const id of M) q.reserves[id] = 10;
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(p.contents.length).toBe(1);
    p.energy = 0;
    p.molecules = emptyMolecules();
    for (const id of M) p.reserves[id] = 0;
    step(w, 1 / 60);
    expect(w.creatures.includes(p)).toBe(false);
    expect(w.creatures.includes(q)).toBe(true);
  });
  it("INGEST (PREDATE) absorbs the vacuole contents of its own prey", () => {
    const w = quietWorld();
    const big = makeCreature({ x: 400, y: 300, energy: 200, genome: new Uint8Array([OP.PREDATE, OP.HALT]) });
    for (const id of M) big.reserves[id] = 1000;
    const mid = makeCreature({ x: 403, y: 300, energy: 50, genome: inert() });
    for (const id of M) mid.reserves[id] = 30;
    const small = makeCreature({ x: 410, y: 300, energy: 20, genome: inert() });
    for (const id of M) small.reserves[id] = 5;
    mid.contents.push(small);
    w.creatures.push(big, mid);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(1);
    expect(big.contents.includes(small)).toBe(true);
  });
});

describe("ecology: extinction recovery", () => {
  it("counter ticks up on full die-off and respawns", () => {
    const w = quietWorld();
    w.founderTarget = 1; // exercise respawn path
    const c = makeCreature({ energy: 0 });
    c.reserves.organic = 0;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.includes(c)).toBe(false);
    expect(w.extinctionCount).toBe(1);
    expect(w.creatures.length).toBeGreaterThanOrEqual(1);
  });
  it("respawned cell within world bounds", () => {
    const w = quietWorld();
    w.founderTarget = 1; // exercise respawn path
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
  it("repeated extinctions counted independently", () => {
    const w = quietWorld();
    for (let i = 0; i < 3; i++) {
      const c = w.creatures[0] ?? makeCreature({ energy: 0 });
      c.energy = 0;
      for (const id of M) c.reserves[id] = 0;
      c.molecules = emptyMolecules();
      if (w.creatures.length === 0) w.creatures.push(c);
      step(w, 1 / 60);
    }
    expect(w.extinctionCount).toBe(3);
  });
});

describe("creature: death by starvation", () => {
  it("no energy + no organic -> dies (extinction recovery reseeds)", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0 });
    c.reserves.organic = 0;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.includes(c)).toBe(false);
    expect(w.extinctionCount).toBe(1);
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
  it("releases reserves as particles of matching materials", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0 });
    c.reserves.organic = 0;
    c.reserves.rock = 50;
    c.reserves.sand = 30;
    c.reserves.gas = 20;
    const before = w.particles.length;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.includes(c)).toBe(false);
    expect(w.particles.length).toBeGreaterThan(before);
    const counts = { rock: 0, sand: 0, gas: 0 } as Record<string, number>;
    for (const p of w.particles.slice(before)) if (p.material in counts) counts[p.material]++;
    expect(counts.rock).toBeGreaterThan(0);
    expect(counts.sand).toBeGreaterThan(0);
    expect(counts.gas).toBeGreaterThan(0);
  });
  it("released mass approximately conserved", () => {
    const w = quietWorld();
    for (let i = 0; i < 550; i++) pushParticle(w, { x: 50 + (i % 700), y: 10 + (i % 50), z: 12, vx: 0, vy: 0, vz: 0, r: 2, material: "sand" });
    const before = new Set(w.particles);
    const c = makeCreature({ energy: 0 });
    c.reserves.organic = 0;
    c.reserves.clay = 100;
    w.creatures.push(c);
    step(w, 1 / 60);
    let m = 0;
    for (const p of w.particles) {
      if (before.has(p)) continue;
      if (p.material === "clay") m += MATERIALS.clay.density * (4 / 3) * Math.PI * p.r * p.r * p.r;
    }
    expect(m).toBeGreaterThanOrEqual(99);
    expect(m).toBeLessThan(110);
  });
  it("released particles spawn near the dead cell", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 400, y: 300, z: 12, energy: 0 });
    c.reserves.organic = 0;
    c.reserves.rock = 50;
    // Strip molecules so the only mass to release is the rock reserve;
    // biomass would otherwise spawn organic-tagged corpse particles too.
    c.molecules = emptyMolecules();
    for (let i = 0; i < 550; i++) pushParticle(w, { x: 50+(i%700), y: 10+(i%50), z: c.z, vx: 0, vy: 0, vz: 0, r: 2, material: "sand" });
    const before = new Set(w.particles);
    w.creatures.push(c);
    step(w, 1 / 60);
    for (const p of w.particles.filter((p) => !before.has(p))) {
      expect(p.material).toBe("rock");
      expect(Math.abs(p.x - 400)).toBeLessThan(20);
      expect(Math.abs(p.y - 300)).toBeLessThan(20);
    }
  });
  it("dead cell's molecules survive as molecule-tagged particles", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 400, y: 300, z: 12, energy: 0 });
    // Strip every fuel source so noFuel() returns true and the cell dies.
    for (const id of M) c.reserves[id] = 0;
    c.molecules = emptyMolecules();
    // Then load up the non-fuel molecules that should survive into corpse
    // particles. biomass+enzyme are organic-bucket; minerals are sand-bucket.
    c.molecules.biomass = 50;
    c.molecules.enzyme = 20;
    c.molecules.minerals = 30;
    const before = new Set(w.particles);
    w.creatures.push(c);
    step(w, 1 / 60);
    const fresh = w.particles.filter((p) => !before.has(p));
    let bio = 0, enz = 0, min = 0;
    for (const p of fresh) {
      if (!p.molecules) continue;
      bio += p.molecules.biomass;
      enz += p.molecules.enzyme;
      min += p.molecules.minerals;
    }
    expect(bio).toBeGreaterThan(48);
    expect(bio).toBeLessThan(52);
    expect(enz).toBeGreaterThan(18);
    expect(enz).toBeLessThan(22);
    expect(min).toBeGreaterThan(28);
    expect(min).toBeLessThan(32);
    // Bucketing: minerals went into sand-bucket particles, not generic
    // organic; that's the whole point of preserving identity.
    const sandMin = fresh
      .filter((p) => p.material === "sand" && p.molecules)
      .reduce((s, p) => s + p.molecules!.minerals, 0);
    expect(sandMin).toBeGreaterThan(28);
  });
  it("ingesting a molecule-tagged particle deposits into the cell's molecules", () => {
    const w = quietWorld();
    w.particleSpawnRate = 0;
    const eater = makeCreature({ x: 400, y: 300, energy: 100, genome: new Uint8Array([OP.INGEST, 3, OP.HALT]) });
    w.creatures.push(eater);
    const gluBefore = eater.molecules.glucose;
    const orgReserveBefore = eater.reserves.organic;
    const mol = emptyMolecules();
    mol.glucose = 12;
    pushParticle(w, {
      x: eater.x, y: eater.y, z: eater.z,
      vx: 0, vy: 0, vz: 0,
      r: 3, material: "organic",
      molecules: mol,
    });
    step(w, 0.001);
    expect(eater.molecules.glucose).toBeCloseTo(gluBefore + 12, 5);
    expect(eater.reserves.organic).toBeCloseTo(orgReserveBefore, 5);
  });
});

describe("creature: reproduction does not cascade within a single tick", () => {
  beforeEach(() => stubRandom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]));
  it("only one child per parent per tick", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    for (const id of M) c.reserves[id] = 2000; readyToFission(c);
    w.creatures.push(c);
    stepFullCycle(w);
    flushDivisions(w);
    expect(w.creatures.length).toBe(2);
  });
  it("newborn has fresh VM state", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    for (const id of M) c.reserves[id] = 2000; readyToFission(c);
    w.creatures.push(c);
    stepFullCycle(w);
    flushDivisions(w);
    expect(w.creatures[1].vm.pc).toBe(0);
    expect(w.creatures[1].vm.stack).toEqual([]);
  });
});

describe("creature: reproduction pacing (no cooldown)", () => {
  beforeEach(() => stubRandom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]));
  it("parent can fission again the next tick if it still has build-blocks", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    for (const id of M) c.reserves[id] = 5000; readyToFission(c);
    c.molecules.aminoAcid = 2000;
    c.molecules.fattyAcid = 2000;
    c.molecules.minerals = 2000;
    c.molecules.biomass = 2000;
    w.creatures.push(c);
    stepFullCycle(w);
    flushDivisions(w);
    expect(w.creatures.length).toBe(2);
    const parent = w.creatures[0];
    parent.molecules.aminoAcid = 2000;
    parent.molecules.fattyAcid = 2000;
    parent.molecules.minerals = 2000;
    parent.molecules.biomass = 2000;
    parent.energy = 200;
    stepFullCycle(w);
    flushDivisions(w);
    expect(w.creatures.length).toBeGreaterThanOrEqual(3);
  });
  it("fission fails the next tick when build-blocks are depleted", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    for (const id of M) c.reserves[id] = 2000; readyToFission(c);
    w.creatures.push(c);
    stepFullCycle(w);
    flushDivisions(w);
    expect(w.creatures.length).toBe(2);
    for (const cell of w.creatures) {
      cell.molecules.aminoAcid = 0;
      cell.molecules.fattyAcid = 0;
      cell.molecules.minerals = 0;
      // Keep biomass just above MIN_VIABLE_BIOMASS so the cell doesn't
      // autolyze -- we want fission to fail on build-block exhaustion,
      // not on structural collapse.
      cell.molecules.biomass = 1;
      for (const id of M) cell.reserves[id] = 0;
    }
    stepFullCycle(w);
    flushDivisions(w);
    expect(w.creatures.length).toBe(2);
  });
});

describe("creature: newborn ingest cooldown", () => {
  beforeEach(() => stubRandom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]));
  it("freshly-spawned child has a positive ingest cooldown", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    for (const id of M) c.reserves[id] = 2000; readyToFission(c);
    w.creatures.push(c);
    stepFullCycle(w);
    flushDivisions(w);
    expect(w.creatures[1].ingestCooldown).toBeGreaterThan(0);
  });
});

describe("creature: ingestion charges exactly the per-event energy cost", () => {
  it("INGEST op: energy drop ~ baseline + INGEST_ENERGY_COST", () => {
    const w = quietWorld();
    // Minimal genome that just triggers INGEST -- no thrust, no reproduce.
    const c = makeCreature({ energy: 100, genome: new Uint8Array([OP.INGEST, 0, OP.HALT]) });
    c.reserves.organic = 0;
    w.creatures.push(c);
    for (let i = 0; i < 550; i++) pushParticle(w, { x: 50+(i%700), y: 10+(i%50), z: c.z, vx: 0, vy: 0, vz: 0, r: 2, material: "sand" });
    const target = pushParticle(w, { x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "rock" });
    const dt = 1 / 60;
    const e0 = c.energy;
    step(w, dt);
    expect(w.particles.includes(target)).toBe(false);
    const drop = e0 - c.energy;
    expect(drop).toBeGreaterThan(1.5);
    expect(drop).toBeLessThan(2.0);
  });
  it("no INGEST op: nearby particle is not absorbed", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 100, genome: new Uint8Array([OP.HALT]) });
    c.reserves.organic = 0;
    w.creatures.push(c);
    const target = pushParticle(w, { x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "rock" });
    step(w, 1 / 60);
    expect(w.particles.includes(target)).toBe(true);
    expect(c.reserves.rock).toBe(0);
  });
});

describe("temperature gradient", () => {
  it("surface is warm, bottom is cold", () => {
    const w = quietWorld();
    w.surfaceY = 30;
    w.tempSurface = 28; w.tempBottom = 12; w.tempPatchAmp = 0;
    const tSurf = temperatureAt(w, 400, w.surfaceY);
    const tBot = temperatureAt(w, 400, w.height);
    expect(tSurf).toBeCloseTo(28, 5);
    expect(tBot).toBeCloseTo(12, 5);
    expect(tSurf).toBeGreaterThan(tBot);
  });
  it("temperature interpolates linearly with depth", () => {
    const w = quietWorld();
    w.surfaceY = 0;
    w.tempSurface = 30; w.tempBottom = 10; w.tempPatchAmp = 0;
    const tMid = temperatureAt(w, 400, w.height / 2);
    expect(tMid).toBeCloseTo(20, 5);
  });
  it("horizontal patches shift the local temp", () => {
    const w = quietWorld();
    w.surfaceY = 0;
    w.tempSurface = 20; w.tempBottom = 20; w.tempPatchAmp = 5;
    w.tempPatchLength = 200; w.tempPatchPeriod = 100;
    // At x=0, t=0 -> sin(0)=0 -> base 20.
    expect(temperatureAt(w, 0, 300)).toBeCloseTo(20, 5);
    // At x=50, t=0 -> sin(pi/2)=1 -> base + 5.
    expect(temperatureAt(w, 50, 300)).toBeCloseTo(25, 5);
  });
  it("warmer water speeds up aerobic respiration (Q10)", () => {
    function run(temp: number): number {
      const w = quietWorld();
      w.surfaceY = 0;
      w.tempSurface = temp; w.tempBottom = temp; w.tempPatchAmp = 0;
      const c = makeCreature({ energy: 0, genome: new Uint8Array([OP.HALT]) });
      c.molecules.glucose = 50; c.molecules.o2 = 50; c.molecules.adp = 100;
      w.creatures.push(c);
      step(w, 0.5);
      return c.energy;
    }
    const eCold = run(12);
    const eWarm = run(28);
    expect(eWarm).toBeGreaterThan(eCold * 1.5);
  });
});

describe("aeration & surface escape", () => {
  it("gas particle above the surface escapes", () => {
    const w = quietWorld();
    w.surfaceY = 50;
    pushParticle(w, { x: 100, y: 30, z: 12, vx: 0, vy: 0, vz: 0, r: 2, material: "gas" });
    step(w, 0.001);
    expect(w.particles.length).toBe(0);
  });
  it("non-gas particle above the surface is clamped, not escaped", () => {
    const w = quietWorld();
    w.surfaceY = 50;
    pushParticle(w, { x: 100, y: 30, z: 12, vx: 0, vy: 0, vz: 0, r: 2, material: "rock" });
    step(w, 0.001);
    expect(w.particles.length).toBe(1);
    expect(w.particles[0].y).toBeGreaterThanOrEqual(w.surfaceY);
  });
  it("creature clamps at the water surface", () => {
    const w = quietWorld();
    w.surfaceY = 50;
    const c = makeCreature({ x: 400, y: 20, vy: -100, energy: 50, genome: new Uint8Array([OP.HALT]) });
    w.creatures.push(c);
    step(w, 0.1);
    expect(w.creatures.length).toBe(1);
    expect(c.y).toBeGreaterThanOrEqual(w.surfaceY);
  });
  it("aerationRate spawns gas particles below the surface", () => {
    const w = quietWorld();
    w.surfaceY = 50;
    w.aerationRate = 500; // burst, easy to observe
    const n0 = w.particles.length;
    step(w, 0.05);
    const gas = w.particles.filter((p) => p.material === "gas");
    expect(w.particles.length).toBeGreaterThan(n0);
    expect(gas.length).toBeGreaterThan(0);
    for (const p of gas) {
      expect(p.y).toBeGreaterThanOrEqual(w.surfaceY);
      // Bubbles carry O2.
      expect(p.molecules?.o2 ?? 0).toBeGreaterThan(0);
    }
  });
  it("aerationRate=0 spawns no bubbles", () => {
    const w = quietWorld();
    w.surfaceY = 50;
    w.aerationRate = 0;
    const n0 = w.particles.length;
    step(w, 0.5);
    expect(w.particles.length).toBe(n0);
  });
});

describe("adhesion (multicell bonds)", () => {
  // ADHERE now requires surface-chemistry recognition (top-8 chem
  // fingerprint overlap >= 4 bits). Test cells need matching
  // chemistry profiles to count as kin.
  const kinChem = {
    biomass: 50, glucose: 30, o2: 10, aminoAcid: 20,
    fattyAcid: 15, minerals: 25, adp: 12, co2: 8,
  };
  it("ADHERE bonds with the nearest other cell in range", () => {
    const w = quietWorld();
    const a = makeCreature({ x: 400, y: 300, energy: 50, molecules: kinChem, genome: new Uint8Array([OP.ADHERE, OP.HALT]) });
    const b = makeCreature({ x: 410, y: 300, energy: 50, molecules: kinChem, genome: new Uint8Array([OP.HALT]) });
    w.creatures.push(a, b);
    step(w, 1 / 60);
    expect(a.bonds).toContain(b);
    expect(b.bonds).toContain(a);
  });
  it("bond breaks when cells are pulled far apart", () => {
    const w = quietWorld();
    const a = makeCreature({ x: 400, y: 300, energy: 50, genome: new Uint8Array([OP.HALT]) });
    const b = makeCreature({ x: 410, y: 300, energy: 50, genome: new Uint8Array([OP.HALT]) });
    a.bonds.push(b); b.bonds.push(a);
    w.creatures.push(a, b);
    // Teleport b far away. Spring pass should snap the bond.
    b.x = 5000;
    step(w, 1 / 60);
    expect(a.bonds).not.toContain(b);
    expect(b.bonds).not.toContain(a);
  });
  it("a dying cell is removed from its partners' bond lists", () => {
    const w = quietWorld();
    const a = makeCreature({ x: 400, y: 300, energy: 50, genome: new Uint8Array([OP.HALT]) });
    const b = makeCreature({ x: 410, y: 300, energy: 50, genome: new Uint8Array([OP.HALT]) });
    a.bonds.push(b); b.bonds.push(a);
    // Force b to die: zero biomass + zero fuel.
    b.molecules.biomass = 0;
    b.molecules.glucose = 0;
    b.molecules.fattyAcid = 0;
    for (const id of M) b.reserves[id] = 0;
    b.energy = 0;
    w.creatures.push(a, b);
    step(w, 1 / 60);
    expect(a.bonds.length).toBe(0);
  });
});

describe("pheromone field", () => {
  it("EMIT deposits into the field at the cell's position; SENSE reads it", () => {
    const w = quietWorld();
    const c = makeCreature({
      x: 100, y: 100, energy: 50,
      genome: new Uint8Array([OP.PUSH8, 30, OP.EMIT, OP.HALT]),
    });
    w.creatures.push(c);
    step(w, 1 / 60);
    // After step's evolvePheromone runs before updateCreatures, the
    // freshly emitted value is in the field but not yet decayed/diffused.
    // The cell deposits at (100,100) -> cell (3, 3) in the 32px grid.
    const idx = 3 * w.pheromoneCols + 3;
    expect(w.pheromone[idx]).toBeGreaterThan(0);
  });
  it("field decays toward zero with no emissions", () => {
    const w = quietWorld();
    w.pheromone[0] = 100;
    for (let i = 0; i < 600; i++) step(w, 1 / 60);
    expect(w.pheromone[0]).toBeLessThan(1);
  });
});

describe("mass conservation", () => {
  // Total system mass = sum of particle mass + sum of all creature stuff
  // (reserves + molecules + ATP-as-mass, plus engulfed contents).
  function worldMass(w: World): number {
    let m = 0;
    for (const p of w.particles) {
      m += MATERIALS[p.material].density * (4 / 3) * Math.PI * p.r * p.r * p.r;
    }
    function creatureMass(c: Creature): number {
      let cm = c.energy;
      for (const id of M) cm += c.reserves[id];
      for (const mk of MOLECULE_IDS) cm += c.molecules[mk];
      for (const inner of c.contents) cm += creatureMass(inner);
      return cm;
    }
    for (const c of w.creatures) m += creatureMass(c);
    return m;
  }

  it("total mass is preserved across many ticks with no aeration / no escape", () => {
    const w = quietWorld();
    // Surface above the world so floating gas can't escape; aeration off
    // so no fresh O2 enters; spawn rate zero so no replenishment.
    // particleTarget kept high so autoExcrete spawns particles instead of
    // hitting the overflow branch (which silently vaporizes molecules).
    w.surfaceY = -50;
    w.aerationRate = 0;
    w.particleSpawnRate = 0;
    w.particleTarget = 100000;
    for (let i = 0; i < 20; i++) {
      pushParticle(w, { x: 100 + i * 30, y: 200, z: 12, vx: 0, vy: 0, vz: 0, r: 2, material: i % 2 === 0 ? "organic" : "clay" });
    }
    const c = makeCreature({ x: 400, y: 200, energy: 30, genome: OMNIVORE });
    w.creatures.push(c);
    const m0 = worldMass(w);
    for (let i = 0; i < 600; i++) step(w, 1 / 60);
    const m1 = worldMass(w);
    // 5% bound accommodates small float drift from the molecule-tagged
    // particle radius floor (radiusForMass clamped at 1.5, which slightly
    // overshoots actual molecule mass for very small excretions).
    expect(Math.abs(m1 - m0)).toBeLessThan(m0 * 0.05);
  });
});

describe("particle replenishment", () => {
  it("spawns when below target", () => {
    const w = quietWorld();
    w.particleSpawnRate = 30;
    const n0 = w.particles.length;
    for (let i = 0; i < 60; i++) step(w, 1 / 60);
    expect(w.particles.length).toBeGreaterThan(n0);
  });
  it("does not refill above target", () => {
    const w = quietWorld();
    w.particleSpawnRate = 30;
    seedParticles(w, 550);
    const n0 = w.particles.length;
    for (let i = 0; i < 30; i++) step(w, 1 / 60);
    expect(w.particles.length).toBeLessThanOrEqual(n0 + 3);
  });
  it("refills after eating", () => {
    const w = quietWorld();
    w.particleSpawnRate = 30;
    const c = makeCreature({ energy: 50 });
    w.creatures.push(c);
    seedParticles(w, 540);
    pushParticle(w, { x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "organic" });
    for (let i = 0; i < 120; i++) step(w, 1 / 60);
    expect(w.particles.length).toBeGreaterThan(540);
  });
});

describe("genomeColor", () => {
  it("stable for same bytes", () => {
    expect(genomeColor(new Uint8Array([1, 2, 3, 4, 5]))).toBe(genomeColor(new Uint8Array([1, 2, 3, 4, 5])));
  });
  it("differs by one byte", () => {
    expect(genomeColor(new Uint8Array([1, 2, 3, 4, 5]))).not.toBe(genomeColor(new Uint8Array([1, 2, 9, 4, 5])));
  });
  it("valid hsl format", () => {
    expect(genomeColor(new Uint8Array([7, 11]))).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
  });
  it("handles empty genome", () => {
    expect(() => genomeColor(new Uint8Array([]))).not.toThrow();
  });
});

describe("default creature behavior (integration)", () => {
  it("moves toward a planted organic particle", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 100, y: 100 });
    w.creatures.push(c);
    for (let i = 0; i < 550; i++) pushParticle(w, { x: 700, y: 500+(i%50), z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "rock" });
    pushParticle(w, { x: 160, y: 100, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, material: "organic" });
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
