// Simulation tests. Cover physics, creature behavior (metabolism, ingestion
// with cost+cooldown, thrust, VM exec cost, predation, photosynthesis,
// excretion), reproduction (affordability + conservation), death and resource
// release, extinction recovery, and ecology.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  type World,
  Creature,
  type Molecules,
  MOLECULE_IDS,
  CHEM_IDS,
  regionDissolvedCapacity,
  regionVolumeL,
  regionCols,
  regionRows,
  createWorld,
  resizeWorld,
  setParticleTarget,
  diffuseReserve,
  denatureWaste,
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
  serializeRxnStats,
  deserializeRxnStats,
  reactionCatalog,
  NAMED_REACTION_COUNT,
  chargeGenomeReplication,
  GENOME_MASS_PER_BYTE,
  serializeWorld,
  applySavedWorld,
  eDnaUptakePass,
  runTransportReactions,
  TRANSPORT_SLOT_BASE,
  TRANSPORT_CHEM_IDS,
  TRANSPORT_ATP_SLOT,
  spawnCompositeInstance,
} from "../sim";
import { ARCHETYPES } from "../genome-archetypes";
import { OP, SYNTH_KIND, SYNTH_BIT_COMPETENCE, newVMState, GENE_FRAGMENT_CAP, type VMState } from "../genome";

// Local viable-heterotroph genome for test creatures. Mirrors the
// production curated default that used to exist before founders went
// fully random; kept here so behavior tests stay deterministic without
// the sim shipping a hand-built genome.
const TEST_DEFAULT_GENOME = new Uint8Array([
  OP.SENSE_AMP,
  OP.SENSE_CHEMICAL, 23,
  OP.SENSE_CHEMICAL, 24,
  OP.THRUST,
  OP.INGEST, 1,
  OP.INGEST, 0,
  OP.SYNTH, SYNTH_KIND.ENZ, 0,
  OP.SYNTH, SYNTH_KIND.FA, 0,
  OP.SYNTH, SYNTH_KIND.BIO, 0,
  OP.SYNTH, SYNTH_KIND.MRNA, 0,
  OP.SYNTH, SYNTH_KIND.CHEMO, 0,
  OP.SYNTH, SYNTH_KIND.REPAIR, 0,
  OP.SYNTH, SYNTH_KIND.CAT, 0,
  OP.SELF_MEMBRANE,
  OP.PUSH8, 30,
  OP.GT,
  OP.SELF_ENERGY,
  OP.PUSH8, 15,
  OP.GT,
  OP.AND,
  OP.JZ, 1,
  OP.REPRODUCE,
]);

// Sentinel byte used by tests as a "no more useful ops" marker. The
// HALT op was retired but the mark pattern keeps tests readable.
const HALT_MARK = 0xFF;

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

// Regional-ambient test helpers. world.ambient is a flat
// [region*96 + chem] grid; these sum / zero a chem across all
// regions so conservation assertions stay layout-agnostic.
const AMB_STRIDE = 96;
function ambTotal(w: World, chem: number): number {
  let s = 0;
  for (let b = 0; b + chem < w.ambient.length; b += AMB_STRIDE) s += w.ambient[b + chem];
  return s;
}
function zeroAmb(w: World, chem: number): void {
  for (let b = 0; b + chem < w.ambient.length; b += AMB_STRIDE) w.ambient[b + chem] = 0;
}

function quietWorld(): World {
  return {
    // t starts past the warmup delays so tests using step()
    // immediately exercise the post-delay code paths (founder
    // respawn, water-column replenish, aeration).
    width: 800, height: 600, depth: 24, t: 100,
    particles: [], particleStore: new ParticleStore(256), fadingGhosts: [], eDnaCarriers: [], creatures: [], creatureStore: new CreatureStore(64),
    particleTarget: 550, particleSpawnRate: 0, useSeedRamp: false, initialSeedDone: true, seedRampClock: 0, extinctionCount: 0, liveLineageRoots: new Set<number>(), nextLineageRoot: 0, founderTarget: 0, lastFounderTrickleT: -1e9, founderIds: new Set<number>(), founderReproduced: new Set<number>(), founderBirthScore: new Map(), pinnedSpecies: new Set<string>(),
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
    atmosphere: { ...emptyMolecules(), o2: 8000, co2: 200 },
    // Regional dissolved field: 800x600 / 50px = 16x12 = 192 regions
    // x 96 chems. Seed O2/CO2 per region (matches initialAmbient).
    ambient: (() => {
      const STRIDE = 96, N = 16 * 12;
      const a = new Float32Array(N * STRIDE);
      for (let r = 0; r < N; r++) { a[r * STRIDE + CHEM_IDS.o2] = 12; a[r * STRIDE + CHEM_IDS.co2] = 1; }
      return a;
    })(),
    reserve: new Float32Array(16 * 12 * 96),
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
  // Defaults: biomass above the reproduction gate; mrna + aa
  // generous enough that the viability thresholds don't autolyze
  // a test creature mid-scenario. enzyme=1 unlocks biopolymer
  // digestion under the new model. Tests probing starvation
  // override in their molecules patch.
  const molecules: Partial<Molecules> = {
    membrane: 50, mrna: 5, aminoAcid: 2, enzyme: 1,
    // Phase K-1: receptors split into band/target variants. Tests
    // pre-fill the legacy single-receptor equivalents (visible band
    // for photo, biopolymer target for chemo) so existing sensing
    // tests still pass. Tests probing receptor-gating override these.
    photoreceptorVisible: 1, chemoreceptorBiopolymer: 1,
    mechanoreceptor: 1, thermoreceptor: 1,
    ...(overrides.molecules ?? {}),
  };
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
    genome: overrides.genome ?? TEST_DEFAULT_GENOME,
    vm: overrides.vm ?? newVMState(),
    color: overrides.color ?? "#ffffff",
    ingestCooldown: overrides.ingestCooldown ?? 0,
    repairTicks: overrides.repairTicks ?? 0,
    bornAt: overrides.bornAt ?? 0,
    speciesKey: overrides.speciesKey ?? "",
    molecules,
  });
}

function cellTotalMass(c: Creature): number {
  // Path 1: ATP is the `atp` molecule (== c.energy, aliased), so it
  // is summed by MOLECULE_IDS -- no separate c.energy term (matches
  // the engine's creatureTotalMass; adding it back double-counts).
  let m = 0;
  for (const k of MOLECULE_IDS) m += c.molecules[k];
  return m;
}

// Distribute `total` mass-units across the cell's chem pool, spread
// across food-like chems (biopolymer + minerals + fa). Replaces the
// pre-phase-D pattern `for (const id of M) c.reserves[id] = N`.
function fillCellChems(c: Creature, total: number): void {
  c.molecules.biopolymer += total * 0.5;
  c.molecules.minerals += total * 0.3;
  c.molecules.fattyAcid += total * 0.2;
}

function readyToFission(c: Creature): void {
  c.molecules.aminoAcid = 200;
  c.molecules.fattyAcid = 200;
  c.molecules.minerals = 200;
  c.molecules.membrane = 200;
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
    // Unified seed: the world fills to particleTarget up front
    // (weight-distributed, >=1 of every chem guaranteed), then the
    // founder cohort scoops nearby particles into their reserves, so
    // the live count lands below the cap but well populated.
    expect(w.particles.length).toBeGreaterThan(w.particleTarget * 0.4);
    expect(w.particles.length).toBeLessThanOrEqual(w.particleTarget);
    expect(w.creatures.length).toBeGreaterThanOrEqual(30);
    expect(w.creatures.length).toBeLessThanOrEqual(50);
    expect(w.extinctionCount).toBe(0);
    expect(w.particleTarget).toBeGreaterThan(0);
    expect(w.particleSpawnRate).toBeGreaterThan(0);
  });

  it("initial particle target is a fixed cap, independent of world area", () => {
    const small = createWorld(800, 600);
    const big = createWorld(1600, 1200);
    expect(small.particleTarget).toBe(2500);
    expect(big.particleTarget).toBe(2500);
  });

  it("resizeWorld does not rescale the particle target", () => {
    const w = createWorld(800, 600);
    resizeWorld(w, 1600, 1200);
    expect(w.particleTarget).toBe(2500);
  });

  it("setParticleTarget changes the cap, clamps, and resyncs spawn rate", () => {
    const w = createWorld(800, 600);
    setParticleTarget(w, 5500);
    expect(w.particleTarget).toBe(5500);
    expect(w.particleSpawnRate).toBeGreaterThan(0);
    setParticleTarget(w, 0); // below min -> clamps up
    expect(w.particleTarget).toBe(500);
    setParticleTarget(w, 1e9); // above max -> clamps down
    expect(w.particleTarget).toBe(50000);
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
      expect(p.chemId).toBeGreaterThanOrEqual(0);
      expect(p.chemId).toBeLessThan(96); // CHEMICAL_COUNT (generics now spawn too)
    }
  });

  it("seedParticles clears existing particles", () => {
    const w = quietWorld();
    seedParticles(w, 10);
    seedParticles(w, 5);
    expect(w.particles.length).toBe(5);
  });

  it("reserve diffuses horizontally; dense sinks, buoyant rises; mass conserved", () => {
    const w = quietWorld();
    const cols = regionCols(w);
    const rows = regionRows(w);
    const rx = (cols / 2) | 0;
    const ry = (rows / 2) | 0;
    const mid = ry * cols + rx;
    const up = mid - cols;     // toward surface
    const down = mid + cols;   // toward floor
    const DENSE = CHEM_IDS.minerals; // density 2.4 > water
    const LIGHT = CHEM_IDS.o2;       // density 0.14 < water
    const cell = (ri: number, chem: number): number => w.reserve[ri * AMB_STRIDE + chem];
    const reserveTotal = (chem: number): number => {
      let s = 0;
      for (let b = 0; b + chem < w.reserve.length; b += AMB_STRIDE) s += w.reserve[b + chem];
      return s;
    };
    w.reserve.fill(0);
    w.reserve[mid * AMB_STRIDE + DENSE] = 1000;
    w.reserve[mid * AMB_STRIDE + LIGHT] = 1000;
    for (let i = 0; i < 50; i++) diffuseReserve(w, 1 / 60);
    // Horizontal both ways for every chem.
    expect(cell(mid - 1, DENSE)).toBeGreaterThan(0);
    expect(cell(mid + 1, DENSE)).toBeGreaterThan(0);
    expect(cell(mid - 1, LIGHT)).toBeGreaterThan(0);
    expect(cell(mid + 1, LIGHT)).toBeGreaterThan(0);
    // Dense settles DOWN only (never up).
    expect(cell(down, DENSE)).toBeGreaterThan(0);
    expect(cell(up, DENSE)).toBe(0);
    // Buoyant rises UP only (never down).
    expect(cell(up, LIGHT)).toBeGreaterThan(0);
    expect(cell(down, LIGHT)).toBe(0);
    // Mass conserved per chem.
    expect(Math.abs(reserveTotal(DENSE) - 1000)).toBeLessThan(1e-2);
    expect(Math.abs(reserveTotal(LIGHT) - 1000)).toBeLessThan(1e-2);
  });

  it("waste denatures into CO2 (dissolved + reserve + particle), mass conserved", () => {
    const w = quietWorld();
    w.ambient.fill(0);
    w.reserve.fill(0);
    const W = CHEM_IDS.waste;
    const C = CHEM_IDS.co2;
    w.ambient[W] = 500;            // dissolved waste in region 0
    w.reserve[W] = 300;            // reserve waste in region 0
    pushParticle(w, { x: 100, y: 200, z: 12, vx: 0, vy: 0, vz: 0, r: 3, chemId: W, density: 1.0 });
    const pMass0 = (4 / 3) * Math.PI * 27 * 1.0;
    const sum = (chem: number): number => {
      let s = 0;
      for (let b = 0; b + chem < w.ambient.length; b += AMB_STRIDE) s += w.ambient[b + chem] + w.reserve[b + chem];
      return s;
    };
    const wasteParticleMass = (): number => {
      let s = 0;
      for (const p of w.particles) if (p.chemId === W) s += (4 / 3) * Math.PI * p.r ** 3 * (p.density ?? 1);
      return s;
    };
    const total0 = sum(W) + sum(C) + wasteParticleMass();
    for (let i = 0; i < 60; i++) denatureWaste(w, 1 / 60);
    // Waste shrinks, CO2 grows, total (waste+co2+wasteparticles) conserved.
    expect(sum(W)).toBeLessThan(800);
    expect(sum(C)).toBeGreaterThan(0);
    expect(wasteParticleMass()).toBeLessThan(pMass0);
    const total1 = sum(W) + sum(C) + wasteParticleMass();
    expect(Math.abs(total1 - total0)).toBeLessThan(total0 * 1e-3 + 1e-3);
  });

  it("registers each initial founder as its own species (no parents)", () => {
    const w = createWorld(800, 600);
    // 5-10 founders means 5-10 species (each random genome is its
    // own root). Founders are at firstSeen=0 with no parent.
    expect(w.species.size).toBeGreaterThanOrEqual(30);
    expect(w.species.size).toBeLessThanOrEqual(50);
    for (const sp of w.species.values()) {
      // Founders enter at world creation time. createWorld in the
      // test path bumps w.t past the warmup delays before spawning,
      // so firstSeen lines up with w.t rather than 0.
      expect(sp.firstSeen).toBe(w.t);
      expect(sp.parents.size).toBe(0);
    }
    expect(w.phylogenyEvents.length).toBe(0);
  });
});

describe("physics: gravity & buoyancy", () => {
  it("denser-than-water material sinks", () => {
    const w = quietWorld(); w.gravity = 100;
    pushParticle(w, { x: 100, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 4, chemId: CHEM_IDS.minerals, density: 2.6 });
    step(w, 0.1);
    expect(w.particles[0].vy).toBeGreaterThan(0);
    expect(w.particles[0].y).toBeGreaterThan(100);
  });
  it("less-dense-than-water material rises", () => {
    const w = quietWorld(); w.gravity = 100;
    pushParticle(w, { x: 100, y: 300, z: 12, vx: 0, vy: 0, vz: 0, r: 4, chemId: CHEM_IDS.o2, density: 0.2 });
    step(w, 0.1);
    expect(w.particles[0].vy).toBeLessThan(0);
    expect(w.particles[0].y).toBeLessThan(300);
  });
  it("density-1 material (organic) has no net vertical force", () => {
    const w = quietWorld(); w.gravity = 100;
    pushParticle(w, { x: 100, y: 300, z: 12, vx: 0, vy: 0, vz: 0, r: 4, chemId: CHEM_IDS.biopolymer, density: 1.0 });
    step(w, 0.1);
    expect(Math.abs(w.particles[0].vy)).toBeLessThan(1e-6);
  });
});

describe("physics: drag", () => {
  it("decays velocity toward zero over time", () => {
    const w = quietWorld(); w.drag = 2.0;
    pushParticle(w, { x: 100, y: 100, z: 12, vx: 50, vy: 0, vz: 0, r: 4, chemId: CHEM_IDS.biopolymer, density: 1.0 });
    for (let i = 0; i < 180; i++) step(w, 1 / 60);
    expect(Math.abs(w.particles[0].vx)).toBeLessThan(5);
  });
  it("doesn't reverse velocity sign in one step", () => {
    const w = quietWorld(); w.drag = 0.6;
    pushParticle(w, { x: 100, y: 100, z: 12, vx: 50, vy: 0, vz: 0, r: 4, chemId: CHEM_IDS.biopolymer, density: 1.0 });
    step(w, 1 / 60);
    expect(w.particles[0].vx).toBeGreaterThan(0);
    expect(w.particles[0].vx).toBeLessThan(50);
  });
});

describe("physics: walls", () => {
  it("x bounces off the left wall", () => {
    const w = quietWorld(); w.xWallRestitution = 0.5;
    pushParticle(w, { x: 5, y: 100, z: 12, vx: -100, vy: 0, vz: 0, r: 4, chemId: CHEM_IDS.biopolymer, density: 1.0 });
    step(w, 0.5);
    expect(w.particles[0].x).toBeLessThan(w.width / 2);
    expect(w.particles[0].x).toBeGreaterThanOrEqual(w.particles[0].r - 1e-6);
    expect(w.particles[0].vx).toBeGreaterThan(0);
  });
  it("x bounces off the right wall", () => {
    const w = quietWorld();
    pushParticle(w, { x: 795, y: 100, z: 12, vx: 100, vy: 0, vz: 0, r: 4, chemId: CHEM_IDS.biopolymer, density: 1.0 });
    step(w, 0.5);
    expect(w.particles[0].x).toBeGreaterThan(w.width / 2);
    expect(w.particles[0].vx).toBeLessThan(0);
  });
  it("creature bounces off side walls (no toroidal sweep)", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 5, y: 100, vx: -100, energy: 50 });
    c.molecules.biopolymer = 50;
    w.creatures.push(c);
    step(w, 0.1);
    expect(w.creatures.length).toBe(1);
    expect(c.x).toBeGreaterThanOrEqual(c.r - 1e-6);
    expect(c.x).toBeLessThan(50);
  });
  it("y clamps at the floor and zeros downward velocity", () => {
    const w = quietWorld();
    pushParticle(w, { x: 100, y: 595, z: 12, vx: 0, vy: 50, vz: 0, r: 4, chemId: CHEM_IDS.biopolymer, density: 1.0 });
    step(w, 0.5);
    expect(w.particles[0].y + w.particles[0].r).toBeLessThanOrEqual(w.height + 1e-6);
    expect(w.particles[0].vy).toBeLessThanOrEqual(0);
  });
  it("y clamps at the ceiling", () => {
    const w = quietWorld();
    pushParticle(w, { x: 100, y: 1, z: 12, vx: 0, vy: -50, vz: 0, r: 4, chemId: CHEM_IDS.biopolymer, density: 1.0 });
    step(w, 0.5);
    expect(w.particles[0].y).toBeGreaterThanOrEqual(w.particles[0].r - 1e-6);
    expect(w.particles[0].vy).toBeGreaterThanOrEqual(0);
  });
  it("z reflects with restitution on both faces", () => {
    const w = quietWorld(); w.zWallRestitution = 0.5;
    pushParticle(w, { x: 100, y: 100, z: 1, vx: 0, vy: 0, vz: -50, r: 4, chemId: CHEM_IDS.biopolymer, density: 1.0 });
    step(w, 0.1);
    expect(w.particles[0].vz).toBeGreaterThan(0);
    expect(w.particles[0].vz).toBeLessThan(50);
  });
});

describe("physics: collisions", () => {
  it("two overlapping particles get separated", () => {
    const w = quietWorld();
    pushParticle(w, { x: 100, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, chemId: CHEM_IDS.biopolymer, density: 1.0 });
    pushParticle(w, { x: 103, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, chemId: CHEM_IDS.biopolymer, density: 1.0 });
    step(w, 0.001);
    const dx = w.particles[1].x - w.particles[0].x;
    const dy = w.particles[1].y - w.particles[0].y;
    const dz = w.particles[1].z - w.particles[0].z;
    expect(Math.sqrt(dx*dx + dy*dy + dz*dz)).toBeGreaterThanOrEqual(w.particles[0].r + w.particles[1].r - 1e-3);
  });
  it("co-located particles resolve without crashing", () => {
    const w = quietWorld();
    pushParticle(w, { x: 100, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, chemId: CHEM_IDS.biopolymer, density: 1.0 });
    pushParticle(w, { x: 100, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, chemId: CHEM_IDS.biopolymer, density: 1.0 });
    expect(() => step(w, 0.001)).not.toThrow();
    const dx = w.particles[1].x - w.particles[0].x;
    const dy = w.particles[1].y - w.particles[0].y;
    const dz = w.particles[1].z - w.particles[0].z;
    expect(Math.sqrt(dx*dx + dy*dy + dz*dz)).toBeGreaterThan(0);
  });
  it("denser particle moves less than lighter on overlap", () => {
    const w = quietWorld();
    pushParticle(w, { x: 100, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, chemId: CHEM_IDS.minerals, density: 2.6 });
    pushParticle(w, { x: 105, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 5, chemId: CHEM_IDS.o2, density: 0.2 });
    step(w, 0.001);
    expect(Math.abs(w.particles[1].x - 105)).toBeGreaterThan(Math.abs(w.particles[0].x - 100));
  });
  it("non-overlapping particles don't move from collision", () => {
    const w = quietWorld();
    pushParticle(w, { x: 100, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 3, chemId: CHEM_IDS.minerals, density: 2.6 });
    pushParticle(w, { x: 200, y: 100, z: 12, vx: 0, vy: 0, vz: 0, r: 3, chemId: CHEM_IDS.minerals, density: 2.6 });
    step(w, 0.001);
    expect(w.particles[0].x).toBeCloseTo(100, 5);
    expect(w.particles[1].x).toBeCloseTo(200, 5);
  });
});

describe("physics: waves", () => {
  it("surface wave forcing decays with depth", () => {
    const wS = quietWorld(); wS.surfaceAmp = 200; wS.surfaceDecay = 50;
    pushParticle(wS, { x: 100, y: 10, z: 12, vx: 0, vy: 0, vz: 0, r: 4, chemId: CHEM_IDS.biopolymer, density: 1.0 });
    const wD = quietWorld(); wD.surfaceAmp = 200; wD.surfaceDecay = 50;
    pushParticle(wD, { x: 100, y: 400, z: 12, vx: 0, vy: 0, vz: 0, r: 4, chemId: CHEM_IDS.biopolymer, density: 1.0 });
    step(wS, 0.1); step(wD, 0.1);
    expect(Math.abs(wS.particles[0].vx)).toBeGreaterThan(Math.abs(wD.particles[0].vx) * 5);
  });
});

describe("creature: chemistry - catabolism + respiration", () => {
  it("organic catabolizes into glucose / amino-acid / fatty-acid molecules", () => {
    const w = quietWorld();
    // Catabolize is gated on enzyme molecule (zero enz -> no digestion).
    const c = makeCreature({
      energy: 100, genome: new Uint8Array([HALT_MARK]),
      molecules: { enzyme: 5 },
    });
    c.molecules.biopolymer = 50;
    w.creatures.push(c);
    step(w, 1.0);
    expect(c.molecules.biopolymer).toBeLessThan(50);
    expect(c.molecules.glucose).toBeGreaterThan(0);
    expect(c.molecules.aminoAcid).toBeGreaterThan(0);
    expect(c.molecules.fattyAcid).toBeGreaterThan(0);
  });
  it("aerobic respiration: glucose + O2 produces ATP and CO2", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0, genome: new Uint8Array([HALT_MARK]) });
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
    // Phase F ambient pool would pump O2 into the cell within 1 sec
    // via passive diffusion; zero it out to keep the test focused
    // on the no-O2 ferment path.
    zeroAmb(w, CHEM_IDS.o2);
    const c = makeCreature({ energy: 0, genome: new Uint8Array([HALT_MARK]) });
    c.molecules.glucose = 20;
    c.molecules.adp = 50;
    w.creatures.push(c);
    step(w, 1.0);
    expect(c.energy).toBeGreaterThan(0);
    expect(c.molecules.waste).toBeGreaterThan(0);
  });
  it("no fuel + no ATP -> dies", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0, genome: new Uint8Array([HALT_MARK]) });
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.includes(c)).toBe(false);
  });
});

describe("creature: cost-of-bigness (surface-area-vs-volume)", () => {
  it("baseline metabolic drain is higher for cells with more stored mass", () => {
    const w = quietWorld();
    const small = makeCreature({ x: 100, y: 300, energy: 100, genome: new Uint8Array([HALT_MARK]) });
    const big = makeCreature({ x: 700, y: 300, energy: 100, genome: new Uint8Array([HALT_MARK]) });
    big.molecules.minerals = 15000;
    w.creatures.push(small, big);
    step(w, 1.0);
    const drainSmall = 100 - small.energy;
    const drainBig = 100 - big.energy;
    expect(drainBig).toBeGreaterThan(drainSmall * 4);
  });
  it("ingest cooldown shortens for bigger cells (membrane scales with perimeter)", () => {
    const wS = quietWorld();
    const cs = makeCreature({ energy: 50, genome: new Uint8Array([OP.INGEST, 0, HALT_MARK]) });
    wS.creatures.push(cs);
    pushParticle(wS, { x: cs.x, y: cs.y, z: cs.z, vx: 0, vy: 0, vz: 0, r: 3, chemId: CHEM_IDS.minerals, density: 2.6 });
    step(wS, 0.001);
    const cdSmall = cs.ingestCooldown;

    const wB = quietWorld();
    const cb = makeCreature({ energy: 50, genome: new Uint8Array([OP.INGEST, 0, HALT_MARK]) });
    cb.molecules.minerals = 4000;
    wB.creatures.push(cb);
    pushParticle(wB, { x: cb.x, y: cb.y, z: cb.z, vx: 0, vy: 0, vz: 0, r: 3, chemId: CHEM_IDS.minerals, density: 2.6 });
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
        genome: new Uint8Array([OP.PUSH8, 80, OP.THRUST, HALT_MARK]),
      });
      c.molecules.biopolymer = 0;
      c.molecules.minerals = rockMass;
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
    const c = makeCreature({ x: 400, y: 10, energy: 100, genome: new Uint8Array([HALT_MARK]) });
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
    const surface = makeCreature({ x: 400, y: 10, energy: 100, genome: new Uint8Array([HALT_MARK]) });
    surface.molecules.chlorophyll = 5;
    surface.molecules.co2 = 50;
    wS.creatures.push(surface);
    const deep = makeCreature({ x: 400, y: 500, energy: 100, genome: new Uint8Array([HALT_MARK]) });
    deep.molecules.chlorophyll = 5;
    deep.molecules.co2 = 50;
    wD.creatures.push(deep);
    step(wS, 1.0); step(wD, 1.0);
    expect(surface.molecules.glucose).toBeGreaterThan(deep.molecules.glucose * 3);
  });
  it("photosynthesis costs ATP (substrate-level: CO2 + ATP -> glucose + O2 + ADP)", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 400, y: 10, energy: 50, genome: new Uint8Array([HALT_MARK]) });
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
    // EXCRETE operand is now mod CHEMICAL_COUNT (96); CHEM_IDS.o2 == 0.
    const c = makeCreature({ energy: 100, genome: new Uint8Array([OP.PUSH8, 20, OP.EXCRETE, CHEM_IDS.o2, HALT_MARK]) });
    c.molecules.o2 = 30;
    w.creatures.push(c);
    // Prefill kept well under particleTarget (550); over-cap excretion
    // now routes to ambient instead of spawning, so the test world
    // needs headroom for the spawn assertion to hold.
    for (let i = 0; i < 100; i++) pushParticle(w, { x: 50+(i%700), y: 10+(i%50), z: c.z, vx: 0, vy: 0, vz: 0, r: 2, chemId: CHEM_IDS.minerals, density: 1.9 });
    const before = new Set(w.particles);
    step(w, 1 / 60);
    const newP = w.particles.filter((p) => !before.has(p));
    expect(newP.length).toBe(1);
    expect(newP[0].chemId).toBe(CHEM_IDS.o2);
    expect(c.molecules.o2).toBeLessThan(30);
  });
  it("caps at available reserve", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 100, genome: new Uint8Array([OP.PUSH8, 100, OP.EXCRETE, CHEM_IDS.o2, HALT_MARK]) });
    c.molecules.o2 = 5;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(c.molecules.o2).toBeGreaterThanOrEqual(0);
    expect(c.molecules.o2).toBeLessThan(0.5);
  });
  it("skipped when reserve below threshold", () => {
    const w = quietWorld();
    w.particleSpawnRate = 0;
    const c = makeCreature({ energy: 100, genome: new Uint8Array([OP.PUSH8, 10, OP.EXCRETE, CHEM_IDS.o2, HALT_MARK]) });
    c.molecules.o2 = 0.1;
    w.creatures.push(c);
    const before = w.particles.length;
    step(w, 1 / 60);
    // O2 diffusion from ambient nudges the pool toward 12; we just
    // check that EXCRETE didn't fire (no fresh particle below).
    expect(c.molecules.o2).toBeLessThan(1);
    const newP = w.particles.slice(before);
    expect(newP.some((p) => (p.chemId === CHEM_IDS.o2 || p.chemId === CHEM_IDS.co2))).toBe(false);
  });
  it("particle spawns near the cell edge", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 400, y: 300, energy: 100, genome: new Uint8Array([OP.PUSH8, 20, OP.EXCRETE, CHEM_IDS.o2, HALT_MARK]) });
    c.molecules.o2 = 30;
    w.creatures.push(c);
    // Prefill kept well under particleTarget (550); over-cap excretion
    // now routes to ambient instead of spawning, so the test world
    // needs headroom for the spawn assertion to hold.
    for (let i = 0; i < 100; i++) pushParticle(w, { x: 50+(i%700), y: 10+(i%50), z: c.z, vx: 0, vy: 0, vz: 0, r: 2, chemId: CHEM_IDS.minerals, density: 1.9 });
    const before = new Set(w.particles);
    step(w, 1 / 60);
    const newP = w.particles.filter((p) => !before.has(p) && (p.chemId === CHEM_IDS.o2 || p.chemId === CHEM_IDS.co2));
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
  OP.INGEST, 3, OP.INGEST, 4, OP.INGEST, 5, HALT_MARK,
]);

describe("creature: ingestion cost and cooldown", () => {
  it("charges per-event energy on ingestion", () => {
    const w = quietWorld();
    w.particleSpawnRate = 0;
    const c = makeCreature({ energy: 50, genome: OMNIVORE });
    w.creatures.push(c);
    pushParticle(w, { x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, chemId: CHEM_IDS.minerals, density: 2.6 });
    const e0 = c.energy;
    step(w, 0.001);
    expect(w.particles.length).toBe(0);
    expect(c.energy).toBeLessThan(e0);
  });
  it("ingests a generic-chem particle under the biopolymer gate", () => {
    const w = quietWorld();
    w.particleSpawnRate = 0;
    const c = makeCreature({ energy: 50, genome: OMNIVORE });
    w.creatures.push(c);
    const GEN = 46; // first generic chem id (NAMED_CHEMICAL_COUNT, now 46 after CHEM_ATP)
    const before = c.store.chemCols[GEN][c.idx];
    pushParticle(w, { x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, chemId: GEN, density: 1.2 });
    step(w, 0.001);
    expect(w.particles.length).toBe(0); // eaten, not skipped
    expect(c.store.chemCols[GEN][c.idx]).toBeGreaterThan(before);
  });
  it("ingests a plain waste particle under the biopolymer gate", () => {
    const w = quietWorld();
    w.particleSpawnRate = 0;
    const c = makeCreature({ energy: 50, genome: OMNIVORE });
    w.creatures.push(c);
    const before = c.store.chemCols[CHEM_IDS.waste][c.idx];
    pushParticle(w, { x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, chemId: CHEM_IDS.waste, density: 1.0 });
    step(w, 0.001);
    expect(w.particles.length).toBe(0); // eaten, not skipped
    expect(c.store.chemCols[CHEM_IDS.waste][c.idx]).toBeGreaterThan(before);
  });
  it("absorbs only one particle per cooldown window", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50, genome: OMNIVORE });
    w.creatures.push(c);
    const targets: object[] = [];
    for (let i = 0; i < 5; i++) {
      const p = pushParticle(w, { x: c.x + i*0.5, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 2, chemId: CHEM_IDS.minerals, density: 2.6 });
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
    // Prefill kept well under particleTarget (550); over-cap excretion
    // now routes to ambient instead of spawning, so the test world
    // needs headroom for the spawn assertion to hold.
    for (let i = 0; i < 100; i++) pushParticle(w, { x: 50+(i%700), y: 10+(i%50), z: c.z, vx: 0, vy: 0, vz: 0, r: 2, chemId: CHEM_IDS.minerals, density: 1.9 });
    const targets: object[] = [];
    for (let i = 0; i < 5; i++) {
      const p = pushParticle(w, { x: c.x + i*0.5, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 2, chemId: CHEM_IDS.minerals, density: 2.6 });
      targets.push(p);
    }
    for (let i = 0; i < 5; i++) step(w, 0.01);
    expect(w.particles.filter((p) => targets.includes(p)).length).toBe(4);
  });
  it("absorbs again after cooldown", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50, genome: OMNIVORE });
    w.creatures.push(c);
    // Prefill kept well under particleTarget (550); over-cap excretion
    // now routes to ambient instead of spawning, so the test world
    // needs headroom for the spawn assertion to hold.
    for (let i = 0; i < 100; i++) pushParticle(w, { x: 50+(i%700), y: 10+(i%50), z: c.z, vx: 0, vy: 0, vz: 0, r: 2, chemId: CHEM_IDS.minerals, density: 1.9 });
    const tgt = new Set<unknown>();
    for (let i = 0; i < 3; i++) {
      const p = pushParticle(w, { x: c.x + i*0.5, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 2, chemId: CHEM_IDS.minerals, density: 2.6 });
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
    pushParticle(w, { x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, chemId: CHEM_IDS.minerals, density: 2.6 });
    step(w, 0.001);
    expect(w.particles.length).toBe(1);
  });
});

describe("TRANSPORT op (Phase 2a-ii: facilitated + active pump)", () => {
  const GEN = 46; // first generic chem id (NAMED_CHEMICAL_COUNT)
  function setAmb(w: World, chem: number, v: number): void {
    for (let b = 0; b + chem < w.ambient.length; b += AMB_STRIDE) {
      w.ambient[b + chem] = v;
    }
  }
  it("imports a chem down-gradient (facilitated), mass-exact", () => {
    const w = quietWorld();
    w.particleSpawnRate = 0;
    const c = makeCreature({
      energy: 50,
      genome: new Uint8Array([OP.PUSH8, 60, OP.TRANSPORT, GEN]),
    });
    w.creatures.push(c);
    setAmb(w, GEN, 20);
    c.store.chemCols[GEN][c.idx] = 0;
    const total0 = ambTotal(w, GEN) + c.store.chemCols[GEN][c.idx];
    step(w, 0.001);
    const cell1 = c.store.chemCols[GEN][c.idx];
    expect(cell1).toBeGreaterThan(0); // imported via TRANSPORT
    expect(Math.abs(ambTotal(w, GEN) + cell1 - total0)).toBeLessThan(1e-3);
  });
  it("pumps uphill (cell richer than ambient) and stays mass-exact", () => {
    const w = quietWorld();
    w.particleSpawnRate = 0;
    const c = makeCreature({
      energy: 100,
      genome: new Uint8Array([OP.PUSH8, 60, OP.TRANSPORT, GEN]),
    });
    w.creatures.push(c);
    setAmb(w, GEN, 10);
    c.store.chemCols[GEN][c.idx] = 40; // dst(inside) > src(outside) => uphill
    const cell0 = c.store.chemCols[GEN][c.idx];
    const total0 = ambTotal(w, GEN) + cell0;
    step(w, 0.001);
    const cell1 = c.store.chemCols[GEN][c.idx];
    expect(cell1).toBeGreaterThan(cell0); // active pump moved it uphill
    expect(Math.abs(ambTotal(w, GEN) + cell1 - total0)).toBeLessThan(1e-3);
  });
  it("active pumping costs ATP — no free energy (vs no-pump control)", () => {
    // Two identical worlds; genomes have equal instruction count
    // (2 ops) so VM/idle ATP drain is identical. Only A pumps uphill.
    const mk = (g: number[]) => {
      const w = quietWorld();
      w.particleSpawnRate = 0;
      const c = makeCreature({ energy: 100, genome: new Uint8Array(g) });
      w.creatures.push(c);
      setAmb(w, GEN, 10);
      c.store.chemCols[GEN][c.idx] = 40; // uphill for the pumper
      return { w, c };
    };
    const A = mk([OP.PUSH8, 60, OP.TRANSPORT, GEN]); // pumps uphill
    const B = mk([OP.PUSH8, 60, OP.PUSH8, 60]);      // no transport
    for (let i = 0; i < 20; i++) { step(A.w, 0.001); step(B.w, 0.001); }
    // The pumper spent strictly more ATP (the up-gradient work).
    expect(A.c.energy).toBeLessThan(B.c.energy);
  });
});

describe("creature: ingestion (basic)", () => {
  it("absorbs a particle inside the cell radius", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50, genome: OMNIVORE });
    w.creatures.push(c);
    const target = pushParticle(w, { x: c.x + 2, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, chemId: CHEM_IDS.fattyAcid, density: 0.9 });
    step(w, 0.001);
    expect(w.particles.includes(target)).toBe(false);
    expect(c.molecules.fattyAcid).toBeGreaterThan(0);
  });
  it("does not absorb particles outside the cell", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50, genome: OMNIVORE });
    w.creatures.push(c);
    pushParticle(w, { x: c.x + c.r + 10, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, chemId: CHEM_IDS.fattyAcid, density: 0.9 });
    step(w, 0.001);
    expect(w.particles.length).toBe(1);
  });
  it("reserve gain matches density * pi * r^2", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 50, genome: OMNIVORE });
    w.creatures.push(c);
    pushParticle(w, { x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, chemId: CHEM_IDS.minerals, density: 2.6 });
    step(w, 0.001);
    expect(c.molecules.minerals).toBeCloseTo(2.6 * (4 / 3) * Math.PI * 27, 5);
  });
  it("INGEST is bond-energy selective: high threshold skips low-energy food", () => {
    // PUSH8 60 -> threshold 60*0.02 = 1.2, above fatty-acid's bond
    // potential (~0.96): the particle is left uneaten.
    const w = quietWorld();
    const c = makeCreature({
      energy: 50,
      genome: new Uint8Array([OP.PUSH8, 60, OP.INGEST, HALT_MARK]),
    });
    w.creatures.push(c);
    const target = pushParticle(w, { x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, chemId: CHEM_IDS.fattyAcid, density: 0.9 });
    step(w, 0.001);
    expect(w.particles.includes(target)).toBe(true); // skipped
  });
  it("INGEST eats the same particle at a low threshold", () => {
    const w = quietWorld();
    const c = makeCreature({
      energy: 50,
      genome: new Uint8Array([OP.PUSH8, 1, OP.INGEST, HALT_MARK]),
    });
    w.creatures.push(c);
    const target = pushParticle(w, { x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, chemId: CHEM_IDS.fattyAcid, density: 0.9 });
    step(w, 0.001);
    expect(w.particles.includes(target)).toBe(false); // eaten
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
      genome: new Uint8Array([OP.NOP, OP.NOP, OP.NOP, HALT_MARK]),
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
      genome: new Uint8Array([HALT_MARK]),
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
    c.molecules.biopolymer = 0;
    w.creatures.push(c);
    for (let i = 0; i < 550; i++) pushParticle(w, { x: 700, y: 500+(i%50), z: c.z, vx: 0, vy: 0, vz: 0, r: 3, chemId: CHEM_IDS.minerals, density: 2.6 });
    pushParticle(w, { x: 250, y: 100, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, chemId: CHEM_IDS.biopolymer, density: 1.0 });
    const e0 = c.energy;
    step(w, 0.1);
    expect(c.vx).toBeGreaterThan(0);
    expect(c.energy).toBeLessThan(e0);
  });
  it("thrust magnitude clamped to thrustAccel", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 0, y: 0, thrustAccel: 50, energy: 1000 });
    c.molecules.biopolymer = 0;
    w.creatures.push(c);
    pushParticle(w, { x: 700, y: 0, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, chemId: CHEM_IDS.biopolymer, density: 1.0 });
    step(w, 1.0);
    expect(c.vx).toBeLessThanOrEqual(50 + 1e-6);
  });
  it("creature with no energy cannot thrust", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 100, y: 100, energy: 0 });
    c.molecules.biopolymer = 0;
    w.creatures.push(c);
    pushParticle(w, { x: 300, y: 100, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, chemId: CHEM_IDS.biopolymer, density: 1.0 });
    step(w, 0.1);
    expect(c.vx).toBeCloseTo(0, 6);
  });
});

describe("creature: reproduction", () => {
  beforeEach(() => stubRandom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.05, 0.15]));
  it("does not reproduce when reserves are insufficient", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    c.molecules.biopolymer = 200;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(1);
  });
  it("reproduces when all six material reserves cover cost", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    fillCellChems(c, 1200); readyToFission(c);
    w.creatures.push(c);
    stepFullCycle(w);
    flushDivisions(w);
    expect(w.creatures.length).toBe(2);
  });
  it("both daughters have positive energy after default-skew fission", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    fillCellChems(c, 1200); readyToFission(c);
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
    fillCellChems(c, 1200); readyToFission(c);
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
  it("biopolymer survives fission with at-most a small metabolic dent", () => {
    const w = quietWorld();
    const c = makeCreature();
    fillCellChems(c, 1200); readyToFission(c);
    c.energy = 200;
    c.molecules.enzyme = 5; // biopolymer digestion gates on enzyme
    const biopBefore = c.molecules.biopolymer;
    w.creatures.push(c);
    stepFullCycle(w);
    flushDivisions(w);
    const total = w.creatures[0].molecules.biopolymer + w.creatures[1].molecules.biopolymer;
    // The biopolymer-digest reaction (slot 10) consumes some during the
    // ticks; what's left + what got digested + what got passed to the
    // child should still roughly balance to the pre-fission total.
    expect(total).toBeLessThanOrEqual(biopBefore + 0.01);
    expect(total).toBeGreaterThan(biopBefore * 0.5);
  });
  it("child genome is a fresh (possibly mutated) copy", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    fillCellChems(c, 1200); readyToFission(c);
    w.creatures.push(c);
    stepFullCycle(w);
    flushDivisions(w);
    expect(w.creatures[1].genome).not.toBe(c.genome);
    expect(Math.abs(w.creatures[1].genome.length - c.genome.length)).toBeLessThanOrEqual(5);
  });
  it("no soft 400 cap: reproduction past 400 is allowed (limited only by store)", () => {
    // 405 ready-to-fission cells -- over the OLD MAX_CREATURES=400
    // soft ceiling. Under the old cap, tryReproduce bailed at
    // length>=400 before creating any division. Now the only limit is
    // the CreatureStore's physical capacity, so divisions are set up
    // even above 400.
    const w = quietWorld();
    for (let i = 0; i < 405; i++) {
      const c = makeCreature({ x: 100 + (i % 80) * 5, y: 100 + Math.floor(i / 80) * 5, energy: 200 });
      fillCellChems(c, 3000); readyToFission(c); readyToFission(c);
      w.creatures.push(c);
    }
    // Under the old soft cap the population could never exceed 400.
    // Run long enough for division waves to commit and confirm it
    // climbs PAST 405, while staying finite and bounded by the store.
    for (let i = 0; i < 150; i++) step(w, 1 / 60);
    expect(w.creatures.length).toBeGreaterThan(405);
    expect(w.creatures.length).toBeLessThanOrEqual(4096);
    expect(Number.isFinite(w.creatures.length)).toBe(true);
  }, 20_000);
});

describe("creature: predation (cell eats cell)", () => {
  beforeEach(() => stubRandom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]));
  function totalMass(c: Creature): number {
    return cellTotalMass(c);
  }
  const inert = () => new Uint8Array([HALT_MARK]);
  const predator = () => new Uint8Array([OP.PREDATE, HALT_MARK]);

  it("big eats small on overlap with PREDATE", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 100, genome: predator() });
    fillCellChems(p, 100 * 6);
    const q = makeCreature({ x: 405, y: 300, energy: 30, genome: inert() });
    fillCellChems(q, 10 * 6);
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(1);
    expect(w.creatures[0]).toBe(p);
  });
  it("predator absorbs prey's reserves and energy", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 100, genome: predator() });
    fillCellChems(p, 100 * 6);
    const q = makeCreature({ x: 405, y: 300, energy: 50, genome: inert() });
    fillCellChems(q, 10 * 6);
    w.creatures.push(p, q);
    const m0 = totalMass(p), pm = totalMass(q), pe = q.energy;
    step(w, 1 / 60);
    expect(totalMass(w.creatures[0])).toBeGreaterThanOrEqual(m0 + pm - 1);
    expect(w.creatures[0].energy).toBeGreaterThan(pe);
  });
  it("equal-mass overlapping cells don't engulf each other", () => {
    const w = quietWorld();
    const a = makeCreature({ x: 400, y: 300, energy: 100, genome: inert() });
    fillCellChems(a, 50 * 6);
    const b = makeCreature({ x: 405, y: 300, energy: 100, genome: inert() });
    fillCellChems(b, 50 * 6);
    w.creatures.push(a, b);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
  });
  it("engulf pays cost (net positive after prey energy gift)", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 100, genome: predator() });
    fillCellChems(p, 200 * 6);
    // Soft prey: low membrane => cheap to breach (membrane is armor
    // via the energy cost now), so the prey's energy gift nets out
    // positive. A heavily-armored prey would instead be net-negative.
    const q = makeCreature({ x: 405, y: 300, energy: 20, genome: inert(), molecules: { membrane: 1 } });
    fillCellChems(q, 1 * 6);
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(w.creatures[0].energy).toBeGreaterThan(100);
    expect(w.creatures[0].energy).toBeLessThan(125);
  });
  it("predator gets longer cooldown after engulf", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 100, genome: predator() });
    fillCellChems(p, 200 * 6);
    const q = makeCreature({ x: 405, y: 300, energy: 20, genome: inert() });
    fillCellChems(q, 1 * 6);
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(w.creatures[0].ingestCooldown).toBeGreaterThan(0.15);
  });
  it("non-overlapping cells don't engulf", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 100, y: 300, energy: 100, genome: predator() });
    fillCellChems(p, 200 * 6);
    const q = makeCreature({ x: 600, y: 300, energy: 20, genome: inert() });
    fillCellChems(q, 1 * 6);
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
  });
  it("cooldown blocks engulf", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 100, ingestCooldown: 1.0, genome: predator() });
    fillCellChems(p, 200 * 6);
    const q = makeCreature({ x: 405, y: 300, energy: 20, genome: inert() });
    fillCellChems(q, 1 * 6);
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
  });
  it("low energy blocks engulf", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 1, genome: predator() });
    fillCellChems(p, 200 * 6);
    p.molecules.biopolymer = 0;
    const q = makeCreature({ x: 405, y: 300, energy: 50, genome: inert() });
    fillCellChems(q, 1 * 6);
    q.molecules.biopolymer = 5;
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
  });
  it("predation is opt-in: no PREDATE -> no engulf", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 100, genome: inert() });
    fillCellChems(p, 100 * 6);
    const q = makeCreature({ x: 405, y: 300, energy: 30, genome: inert() });
    fillCellChems(q, 10 * 6);
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
  });
  it("predation energy cost scales with prey mass", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 100, genome: predator() });
    fillCellChems(p, 100 * 6);
    // Soft prey (low membrane) so the variable cost is dominated by
    // the prey-mass term, which is what this test exercises; the
    // membrane-armor term is held near zero.
    const q = makeCreature({ x: 405, y: 300, energy: 0, genome: inert(), molecules: { membrane: 1 } });
    fillCellChems(q, 30 * 6);
    q.molecules.biopolymer = 30;
    w.creatures.push(p, q);
    const e0 = p.energy;
    step(w, 1 / 60);
    // New physical cost ~= 5 + 0.1*preyMass + 0.5*preyMembrane plus
    // the predator's own per-tick metabolism; band retuned for that.
    expect(p.energy).toBeLessThan(e0 - 12);
    expect(p.energy).toBeGreaterThan(e0 - 30);
  });
  it("predation refused when can't afford the prey-mass cost", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 5, genome: predator() });
    fillCellChems(p, 100 * 6);
    p.molecules.biopolymer = 5;
    const q = makeCreature({ x: 405, y: 300, energy: 30, genome: inert() });
    fillCellChems(q, 16 * 6);
    q.molecules.biopolymer = 5;
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(2);
  });
  it("cohesion (bondChem x bond count) makes a colony member costlier to predate", () => {
    // Control: a solitary, soft, low-mass prey (energy 30 so it does
    // not starve this tick) is affordable for a predator with 20 ATP
    // -> it gets eaten.
    {
      const w = quietWorld();
      const p = makeCreature({ x: 400, y: 300, energy: 20, genome: predator() });
      fillCellChems(p, 100 * 6); // large radius so the size gate passes
      const q = makeCreature({ x: 405, y: 300, energy: 30, genome: inert(), molecules: { membrane: 5 } });
      w.creatures.push(p, q);
      step(w, 1 / 60);
      expect(w.creatures.length).toBe(1); // solitary prey eaten
    }
    // Same predator + prey, but the prey is now a cohesive colony
    // member (bondChem 4, three intact bonds). The added cohesion cost
    // (PREDATION_ENERGY_PER_COHESION * bondChem * bondCount) pushes the
    // total above the predator's 20 ATP, so it cannot pick it off --
    // nor any equally-cohesive partner.
    {
      const w = quietWorld();
      const p = makeCreature({ x: 400, y: 300, energy: 20, genome: predator() });
      fillCellChems(p, 100 * 6);
      const q = makeCreature({ x: 405, y: 300, energy: 30, genome: inert(), molecules: { membrane: 5, bondChem: 4 } });
      const partners = [0, 1, 2].map(() =>
        makeCreature({ x: 405, y: 300, energy: 30, genome: inert(), molecules: { bondChem: 4 } }),
      );
      // Mutually bond q with three partners. Kept stable for the tick:
      // all sit coincident (no overstretch) and hold bondChem above
      // the formation threshold so applyBondSprings won't sever them.
      for (const pr of partners) { q.bonds.push(pr); pr.bonds.push(q); }
      w.creatures.push(p, q, ...partners);
      step(w, 1 / 60);
      // q + every partner are cohesive (and partners also carry the
      // default membrane armor), so none is affordable: no predation.
      expect(w.creatures.length).toBe(5);
    }
  });
  it("engulfing does NOT spawn death particles", () => {
    const w = quietWorld();
    for (let i = 0; i < 550; i++) pushParticle(w, { x: 50+(i%700), y: 10+(i%50), z: 12, vx: 0, vy: 0, vz: 0, r: 2, chemId: CHEM_IDS.minerals, density: 1.9 });
    const before = new Set(w.particles);
    const p = makeCreature({ x: 400, y: 300, energy: 100, genome: predator() });
    fillCellChems(p, 200 * 6);
    const q = makeCreature({ x: 405, y: 300, energy: 30, genome: inert() });
    fillCellChems(q, 10 * 6);
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(w.particles.filter((p) => !before.has(p)).length).toBe(0);
  });
});

describe("creature: engulf (swallow whole, membrane intact)", () => {
  beforeEach(() => stubRandom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]));
  const inert = () => new Uint8Array([HALT_MARK]);
  const swallower = () => new Uint8Array([OP.ENGULF, HALT_MARK]);

  it("removes prey from world.creatures and parks it in predator.contents", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 100, genome: swallower() });
    fillCellChems(p, 200 * 6);
    const q = makeCreature({ x: 405, y: 300, energy: 30, genome: inert() });
    fillCellChems(q, 10 * 6);
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
    fillCellChems(p, 300 * 6);
    const q = makeCreature({ x: 405, y: 300, energy: 30, genome: inert() });
    q.molecules.minerals = 80;
    q.molecules.glucose = 25;
    const pRockBefore = p.molecules.minerals;
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(p.molecules.minerals).toBeGreaterThan(pRockBefore - 5);
    expect(p.molecules.minerals).toBeLessThan(pRockBefore + 1);
    expect(p.molecules.glucose).toBeLessThan(15);
    expect(p.contents.length).toBe(1);
    expect(p.contents[0].molecules.minerals).toBeCloseTo(80, 1);
    expect(p.contents[0].molecules.glucose).toBeCloseTo(25, 1);
  });
  it("engulfed prey still counts toward predator mass (vacuole occupies volume)", () => {
    const w = quietWorld();
    // Predator must be physically larger than the prey (the engulf
    // gate is now geometric: radius ratio, no abstract mass score),
    // so give it enough mineral mass to clear the size threshold.
    const p = makeCreature({ x: 400, y: 300, energy: 100, genome: swallower() });
    p.molecules.minerals = 2000;
    const q = makeCreature({ x: 405, y: 300, energy: 50, genome: inert() });
    q.molecules.minerals = 50;
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(cellTotalMass(p) + cellTotalMass(p.contents[0])).toBeGreaterThan(390);
  });
  it("predator death releases vacuole contents back to the world", () => {
    const w = quietWorld();
    const p = makeCreature({ x: 400, y: 300, energy: 100, genome: swallower() });
    fillCellChems(p, 200 * 6);
    const q = makeCreature({ x: 405, y: 300, energy: 50, genome: inert() });
    fillCellChems(q, 10 * 6);
    w.creatures.push(p, q);
    step(w, 1 / 60);
    expect(p.contents.length).toBe(1);
    p.energy = 0;
    p.molecules = emptyMolecules();
    fillCellChems(p, 0 * 6);
    step(w, 1 / 60);
    expect(w.creatures.includes(p)).toBe(false);
    expect(w.creatures.includes(q)).toBe(true);
  });
  it("INGEST (PREDATE) absorbs the vacuole contents of its own prey", () => {
    const w = quietWorld();
    const big = makeCreature({ x: 400, y: 300, energy: 200, genome: new Uint8Array([OP.PREDATE, HALT_MARK]) });
    fillCellChems(big, 1000 * 6);
    const mid = makeCreature({ x: 403, y: 300, energy: 50, genome: inert() });
    fillCellChems(mid, 30 * 6);
    const small = makeCreature({ x: 410, y: 300, energy: 20, genome: inert() });
    fillCellChems(small, 5 * 6);
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
    c.molecules.biopolymer = 0;
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
    c.molecules.biopolymer = 0;
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
      fillCellChems(c, 0 * 6);
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
    c.molecules.biopolymer = 0;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.includes(c)).toBe(false);
    expect(w.extinctionCount).toBe(1);
  });
  it("organic survives baseline drain", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0 });
    c.molecules.biopolymer = 50;
    w.creatures.push(c);
    for (let i = 0; i < 60; i++) step(w, 1 / 60);
    expect(w.creatures.length).toBe(1);
  });
  it("baseline drain depletes idle energy", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 100 });
    c.molecules.biopolymer = 0;
    w.creatures.push(c);
    const e0 = c.energy;
    step(w, 1 / 60);
    expect(c.energy).toBeLessThan(e0);
  });
  it("releases reserves as particles of matching materials", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 0 });
    c.molecules.biopolymer = 0;
    c.molecules.minerals = 50;
    c.molecules.minerals = 30;
    c.molecules.o2 = 20;
    const before = w.particles.length;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.includes(c)).toBe(false);
    expect(w.particles.length).toBeGreaterThan(before);
    let minerals = 0; let o2 = 0;
    for (const p of w.particles.slice(before)) {
      if (p.chemId === CHEM_IDS.minerals) minerals++;
      else if (p.chemId === CHEM_IDS.o2) o2++;
    }
    expect(minerals).toBeGreaterThan(0);
    expect(o2).toBeGreaterThan(0);
  });
  it("released mass approximately conserved", () => {
    const w = quietWorld();
    for (let i = 0; i < 550; i++) pushParticle(w, { x: 50 + (i % 700), y: 10 + (i % 50), z: 12, vx: 0, vy: 0, vz: 0, r: 2, chemId: CHEM_IDS.minerals, density: 1.9 });
    // Total mineral mass across the whole system (particles +
    // reserve + dissolved). Phase 4's proportional reserve makes
    // individual particles fungible, so the right invariant is
    // "the dead cell's mineral mass is conserved system-wide", not
    // "appears as N specific new particles".
    const ps = w.particleStore;
    const minSys = () => {
      let s = ambTotal(w, CHEM_IDS.minerals);
      for (let k = 0; k < w.reserve.length; k++) {
        if ((k % AMB_STRIDE) === CHEM_IDS.minerals) s += w.reserve[k];
      }
      for (let i = 0; i < w.particles.length; i++) {
        if (ps.chemId[i] !== CHEM_IDS.minerals) continue;
        const r = ps.r[i];
        s += (ps.density[i] || 2.4) * (4 / 3) * Math.PI * r * r * r;
      }
      return s;
    };
    const c = makeCreature({ energy: 0 });
    c.molecules.biopolymer = 0;
    c.molecules.minerals = 100;
    w.creatures.push(c);
    const before = minSys() + 100; // + the cell's 100 mineral mass
    expect(w.creatures.includes(c)).toBe(true);
    step(w, 1 / 60);
    expect(w.creatures.includes(c)).toBe(false); // starved & died
    const after = minSys();        // cell's 100 now released into the system
    expect(Math.abs(after - before)).toBeLessThan(before * 0.02 + 2);
  });
  it("released particles spawn near the dead cell", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 400, y: 300, z: 12, energy: 0 });
    // Empty the pool first, then give it a single deterministic mass
    // to release (minerals). Death is now mass-faithful: any trace
    // chem from this tick's reactions is also released, so we assert
    // spawn POSITION for every new particle and that the minerals
    // mass came back, rather than "minerals only".
    c.molecules = emptyMolecules();
    c.molecules.minerals = 50;
    for (let i = 0; i < 100; i++) pushParticle(w, { x: 50+(i%700), y: 10+(i%50), z: c.z, vx: 0, vy: 0, vz: 0, r: 2, chemId: CHEM_IDS.minerals, density: 1.9 });
    const before = new Set(w.particles);
    w.creatures.push(c);
    step(w, 1 / 60);
    const fresh = w.particles.filter((p) => !before.has(p));
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.some((p) => p.chemId === CHEM_IDS.minerals)).toBe(true);
    for (const p of fresh) {
      expect(Math.abs(p.x - 400)).toBeLessThan(20);
      expect(Math.abs(p.y - 300)).toBeLessThan(20);
    }
  });
  it("dead cell's chems survive as chem-tagged particles", () => {
    const w = quietWorld();
    const c = makeCreature({ x: 400, y: 300, z: 12, energy: 0 });
    fillCellChems(c, 0 * 6);
    c.molecules = emptyMolecules();
    // Load up the non-fuel chems that should survive death as chem
    // particles. In the phase-D release path, each named chem above
    // a small threshold gets its own particle of that chemId.
    c.molecules.membrane = 50;
    c.molecules.enzyme = 20;
    c.molecules.minerals = 30;
    const before = new Set(w.particles);
    w.creatures.push(c);
    step(w, 1 / 60);
    const fresh = w.particles.filter((p) => !before.has(p));
    const massByChem = (id: number): number => {
      const ps = w.particleStore;
      // Per-chem default density used when the particle had no
      // per-particle override (releaseChemsAsParticles doesn't set
      // density; the chem table default applies).
      const defaultDensity: Record<number, number> = {
        [CHEM_IDS.membrane]: 0.8,
        [CHEM_IDS.enzyme]: 1.1,
        [CHEM_IDS.minerals]: 2.4,
      };
      let m = 0;
      for (const p of fresh) {
        if (p.chemId !== id) continue;
        const d = ps.density[p.idx] !== 0 ? ps.density[p.idx] : (defaultDensity[id] ?? 1);
        m += d * (4 / 3) * Math.PI * p.r * p.r * p.r;
      }
      return m;
    };
    // Necromass lipolysis: the 50 membrane hydrolyzes to ~0.65 fa +
    // ~0.35 aa (it does NOT survive as membrane particles). Enzyme +
    // minerals still release as themselves. Mass is conserved
    // (maintenance decay nibbles a little during the death tick).
    // membrane does NOT survive as membrane; its lipid (~0.65) comes
    // back as a fatty-acid particle. (The ~0.35 aa fraction is below
    // the death-release particle floor and dissolves into ambient --
    // the documented trace-amount rule -- so it's not a particle.)
    expect(massByChem(CHEM_IDS.membrane)).toBeLessThan(2);
    expect(massByChem(CHEM_IDS.fattyAcid)).toBeGreaterThan(28);
    expect(massByChem(CHEM_IDS.fattyAcid)).toBeLessThan(35);
    expect(massByChem(CHEM_IDS.enzyme)).toBeGreaterThan(17);
    expect(massByChem(CHEM_IDS.enzyme)).toBeLessThan(22);
    expect(massByChem(CHEM_IDS.minerals)).toBeGreaterThan(28);
    expect(massByChem(CHEM_IDS.minerals)).toBeLessThan(32);
  });
  it("ingesting a molecule-tagged particle deposits into the cell's molecules", () => {
    const w = quietWorld();
    w.particleSpawnRate = 0;
    // INGEST 1 -> biopolymer slot in the post-phase-D SENSOR_CHEMS mapping.
    const eater = makeCreature({ x: 400, y: 300, energy: 100, genome: new Uint8Array([OP.INGEST, 1, HALT_MARK]) });
    w.creatures.push(eater);
    const gluBefore = eater.molecules.glucose;
    const orgReserveBefore = eater.molecules.biopolymer;
    const mol = emptyMolecules();
    mol.glucose = 12;
    pushParticle(w, {
      x: eater.x, y: eater.y, z: eater.z,
      vx: 0, vy: 0, vz: 0,
      r: 3, chemId: CHEM_IDS.biopolymer, density: 1.0,
      molecules: mol,
    });
    step(w, 0.001);
    expect(eater.molecules.glucose).toBeCloseTo(gluBefore + 12, 5);
    expect(eater.molecules.biopolymer).toBeCloseTo(orgReserveBefore, 5);
  });
});

describe("creature: reproduction does not cascade within a single tick", () => {
  beforeEach(() => stubRandom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]));
  it("only one child per parent per tick", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    fillCellChems(c, 2000 * 6); readyToFission(c);
    w.creatures.push(c);
    stepFullCycle(w);
    flushDivisions(w);
    expect(w.creatures.length).toBe(2);
  });
  it("newborn has fresh VM state", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    fillCellChems(c, 2000 * 6); readyToFission(c);
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
    fillCellChems(c, 5000 * 6); readyToFission(c);
    c.molecules.aminoAcid = 2000;
    c.molecules.fattyAcid = 2000;
    c.molecules.minerals = 2000;
    c.molecules.membrane = 2000;
    w.creatures.push(c);
    stepFullCycle(w);
    flushDivisions(w);
    expect(w.creatures.length).toBe(2);
    const parent = w.creatures[0];
    parent.molecules.aminoAcid = 2000;
    parent.molecules.fattyAcid = 2000;
    parent.molecules.minerals = 2000;
    parent.molecules.membrane = 2000;
    parent.energy = 200;
    stepFullCycle(w);
    flushDivisions(w);
    expect(w.creatures.length).toBeGreaterThanOrEqual(3);
  });
  it("fission fails the next tick when build-blocks are depleted", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    fillCellChems(c, 2000 * 6); readyToFission(c);
    w.creatures.push(c);
    stepFullCycle(w);
    flushDivisions(w);
    expect(w.creatures.length).toBe(2);
    for (const cell of w.creatures) {
      // Keep aa just above MIN_VIABLE_AMINOACID -- enough to stay
      // alive, far below what fission needs as build-blocks. Same
      // for biomass (above MIN_VIABLE_MEMBRANE). Fission has to fail
      // on build-block exhaustion, not on the viability checks.
      cell.molecules.aminoAcid = 0.01;
      cell.molecules.fattyAcid = 0;
      cell.molecules.minerals = 0;
      cell.molecules.membrane = 1;
      fillCellChems(cell, 0 * 6);
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
    fillCellChems(c, 2000 * 6); readyToFission(c);
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
    const c = makeCreature({ energy: 100, genome: new Uint8Array([OP.INGEST, 0, HALT_MARK]) });
    c.molecules.biopolymer = 0;
    w.creatures.push(c);
    // Prefill kept well under particleTarget (550); over-cap excretion
    // now routes to ambient instead of spawning, so the test world
    // needs headroom for the spawn assertion to hold.
    for (let i = 0; i < 100; i++) pushParticle(w, { x: 50+(i%700), y: 10+(i%50), z: c.z, vx: 0, vy: 0, vz: 0, r: 2, chemId: CHEM_IDS.minerals, density: 1.9 });
    const target = pushParticle(w, { x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, chemId: CHEM_IDS.minerals, density: 2.6 });
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
    const c = makeCreature({ energy: 100, genome: new Uint8Array([HALT_MARK]) });
    c.molecules.biopolymer = 0;
    w.creatures.push(c);
    const target = pushParticle(w, { x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, chemId: CHEM_IDS.minerals, density: 2.6 });
    const minBefore = c.molecules.minerals;
    step(w, 1 / 60);
    expect(w.particles.includes(target)).toBe(true);
    // No ingestion -> mineral pool shouldn't grow by anything close
    // to a particle mass (~30 units). Maintenance decay of enz/ribo
    // dribbles trace amounts in regardless; we just bound the gain.
    expect(c.molecules.minerals - minBefore).toBeLessThan(1);
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
      const c = makeCreature({ energy: 0, genome: new Uint8Array([HALT_MARK]) });
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
    pushParticle(w, { x: 100, y: 30, z: 12, vx: 0, vy: 0, vz: 0, r: 2, chemId: CHEM_IDS.o2, density: 0.2 });
    step(w, 0.001);
    expect(w.particles.length).toBe(0);
  });
  it("non-gas particle above the surface is clamped, not escaped", () => {
    const w = quietWorld();
    w.surfaceY = 50;
    pushParticle(w, { x: 100, y: 30, z: 12, vx: 0, vy: 0, vz: 0, r: 2, chemId: CHEM_IDS.minerals, density: 2.6 });
    step(w, 0.001);
    expect(w.particles.length).toBe(1);
    expect(w.particles[0].y).toBeGreaterThanOrEqual(w.surfaceY);
  });
  it("creature clamps at the water surface", () => {
    const w = quietWorld();
    w.surfaceY = 50;
    const c = makeCreature({ x: 400, y: 20, vy: -100, energy: 50, genome: new Uint8Array([HALT_MARK]) });
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
    const gas = w.particles.filter((p) => (p.chemId === CHEM_IDS.o2 || p.chemId === CHEM_IDS.co2));
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
  // K-5: bonds form passively when both partners hold CHEM_BOND
  // (chem id 39) above BOND_FORMATION_THRESH AND carry compatible
  // greenbeard markers. No op needed -- a genome that wants colonies
  // SYNTHs bond_chem, whose param byte is the recognition tag.
  const CHEM_BOND_ID = 39;
  function seedBondPool(c: ReturnType<typeof makeCreature>, marker = 7): void {
    c.store.chemCols[CHEM_BOND_ID][c.idx] = 1.0;
    // Cells under test have inert HALT genomes, so the VM never sets
    // the marker; assign it directly to emulate having expressed
    // SYNTH BOND with this tag.
    c.bondMarker = marker;
  }
  it("two cells with matching bond markers auto-bond in range", () => {
    const w = quietWorld();
    const a = makeCreature({ x: 400, y: 300, energy: 50, genome: new Uint8Array([HALT_MARK]) });
    const b = makeCreature({ x: 410, y: 300, energy: 50, genome: new Uint8Array([HALT_MARK]) });
    seedBondPool(a, 7);
    seedBondPool(b, 7);
    w.creatures.push(a, b);
    step(w, 1 / 60);
    expect(a.bonds).toContain(b);
    expect(b.bonds).toContain(a);
  });
  it("cells with incompatible bond markers do not bond (greenbeard)", () => {
    const w = quietWorld();
    const a = makeCreature({ x: 400, y: 300, energy: 50, genome: new Uint8Array([HALT_MARK]) });
    const b = makeCreature({ x: 410, y: 300, energy: 50, genome: new Uint8Array([HALT_MARK]) });
    seedBondPool(a, 10);
    seedBondPool(b, 200);
    w.creatures.push(a, b);
    step(w, 1 / 60);
    expect(a.bonds).not.toContain(b);
    expect(b.bonds).not.toContain(a);
  });
  it("bond breaks when cells are pulled far apart", () => {
    const w = quietWorld();
    const a = makeCreature({ x: 400, y: 300, energy: 50, genome: new Uint8Array([HALT_MARK]) });
    const b = makeCreature({ x: 410, y: 300, energy: 50, genome: new Uint8Array([HALT_MARK]) });
    seedBondPool(a); seedBondPool(b);
    a.bonds.push(b); b.bonds.push(a);
    w.creatures.push(a, b);
    // Teleport b far away. Spring pass should snap the bond on
    // overstretch (pools are seeded so the threshold rule doesn't fire).
    b.x = 5000;
    step(w, 1 / 60);
    expect(a.bonds).not.toContain(b);
    expect(b.bonds).not.toContain(a);
  });
  it("a dying cell is removed from its partners' bond lists", () => {
    const w = quietWorld();
    const a = makeCreature({ x: 400, y: 300, energy: 50, genome: new Uint8Array([HALT_MARK]) });
    const b = makeCreature({ x: 410, y: 300, energy: 50, genome: new Uint8Array([HALT_MARK]) });
    seedBondPool(a); seedBondPool(b);
    a.bonds.push(b); b.bonds.push(a);
    // Force b to die: zero biomass + zero fuel.
    b.molecules.membrane = 0;
    b.molecules.glucose = 0;
    b.molecules.fattyAcid = 0;
    fillCellChems(b, 0 * 6);
    b.energy = 0;
    w.creatures.push(a, b);
    step(w, 1 / 60);
    expect(a.bonds.length).toBe(0);
  });
});

describe("region dissolved-capacity calibration (Phase 0)", () => {
  it("M is fitted so food chems stay particulate and byproducts dissolve", () => {
    const w = createWorld(800, 600);
    const T = 15; // TEMP_BASELINE -> solubilityTempFactor == 1
    const cap = (id: number) => regionDissolvedCapacity(id, w, T);
    // Insoluble food chems: <1 particle-equivalent => effectively zero
    // capacity, so any amount precipitates / stays edible.
    expect(cap(CHEM_IDS.biopolymer)).toBeLessThan(1);
    expect(cap(CHEM_IDS.minerals)).toBeLessThan(1);
    expect(cap(CHEM_IDS.fattyAcid)).toBeLessThan(1);
    expect(cap(CHEM_IDS.membrane)).toBeLessThan(1);
    // Soluble byproducts / sugars: large capacity => they dissolve
    // into the regional field rather than persisting as particles.
    expect(cap(CHEM_IDS.glucose)).toBeGreaterThan(1000);
    expect(cap(CHEM_IDS.aminoAcid)).toBeGreaterThan(1000);
    expect(cap(CHEM_IDS.waste)).toBeGreaterThan(1000);
    // Gases: moderate (CO2 >> O2, both finite and > food chems).
    expect(cap(CHEM_IDS.co2)).toBeGreaterThan(cap(CHEM_IDS.o2));
    expect(cap(CHEM_IDS.o2)).toBeGreaterThan(cap(CHEM_IDS.biopolymer));
  });
  it("region grid + volume are sane for both world orientations", () => {
    for (const [W, H] of [[800, 600], [600, 800]] as const) {
      const w = createWorld(W, H);
      expect(regionCols(w) * regionRows(w)).toBeGreaterThan(50);
      expect(regionVolumeL(w)).toBeGreaterThan(1);   // litres, positive
      expect(regionVolumeL(w)).toBeLessThan(1e6);
    }
  });
});

describe("reserve keeps visible mix proportional (Phase 4)", () => {
  it("no material exceeds the per-chem visible ceiling; rest stays in reserve", () => {
    const w = quietWorld();
    w.aerationRate = 0;
    w.particleSpawnRate = 0;
    const target = w.particleTarget;
    const maxPerChem = Math.floor(0.20 * target); // PARTICLE_PER_CHEM_FRAC
    // 2:1 minerals:biopolymer, both far above the 20% ceiling.
    const NMIN = target * 4, NBIO = target * 2;
    for (let i = 0; i < NMIN; i++) pushParticle(w, { x: 5 + Math.random() * (w.width - 10), y: w.surfaceY + 5 + Math.random() * 150, z: 12, vx: 0, vy: 0, vz: 0, r: 2, chemId: CHEM_IDS.minerals });
    for (let i = 0; i < NBIO; i++) pushParticle(w, { x: 5 + Math.random() * (w.width - 10), y: w.surfaceY + 5 + Math.random() * 150, z: 12, vx: 0, vy: 0, vz: 0, r: 2, chemId: CHEM_IDS.biopolymer });
    for (let i = 0; i < 20; i++) step(w, 1 / 60);
    const ps = w.particleStore;
    let visMin = 0, visBio = 0;
    for (let i = 0; i < w.particles.length; i++) {
      if (ps.chemId[i] === CHEM_IDS.minerals) visMin++;
      else if (ps.chemId[i] === CHEM_IDS.biopolymer) visBio++;
    }
    // Cap respected.
    expect(w.particles.length).toBeLessThanOrEqual(target);
    // Both chems still represented (not winner-take-all).
    expect(visMin).toBeGreaterThan(0);
    expect(visBio).toBeGreaterThan(0);
    // Neither material exceeds the per-chem ceiling (the surplus that
    // would have been visible under pure proportionality is held in
    // reserve instead). Both are far above the ceiling in total, so
    // both should sit at (approximately) the ceiling.
    expect(visMin).toBeLessThanOrEqual(maxPerChem);
    expect(visBio).toBeLessThanOrEqual(maxPerChem);
    expect(visMin).toBeGreaterThan(maxPerChem * 0.6);
    expect(visBio).toBeGreaterThan(maxPerChem * 0.6);
  });
});

describe("founders recirculate reserve (Phase 4)", () => {
  it("founder spawn draws bounded reserve mass; conserved; no balloon", () => {
    const w = createWorld(800, 600);
    const ps = w.particleStore;
    const minSys = () => {
      let s = 0;
      for (let k = 0; k < w.ambient.length; k++) if ((k % AMB_STRIDE) === CHEM_IDS.minerals) s += w.ambient[k] + w.reserve[k];
      for (let i = 0; i < w.particles.length; i++) if (ps.chemId[i] === CHEM_IDS.minerals) { const r = ps.r[i]; s += (ps.density[i] || 2.4) * (4 / 3) * Math.PI * r * r * r; }
      const cs = w.creatureStore;
      for (const c of w.creatures) s += cs.m_minerals[c.idx];
      return s;
    };
    // Heavy mineral reserve everywhere; wipe creatures so the
    // top-up spawns a fresh founder cohort that should draw it.
    for (let k = 0; k < w.reserve.length; k++) if ((k % AMB_STRIDE) === CHEM_IDS.minerals) w.reserve[k] = 500;
    w.creatures.length = 0;
    void minSys; // (whole-system conservation covered elsewhere;
    // minerals aren't conserved in isolation -- maintenanceDecay
    // mints 0.5 min per machinery decay each tick by design.)
    let resBefore = 0;
    for (let k = 0; k < w.reserve.length; k++) if ((k % AMB_STRIDE) === CHEM_IDS.minerals) resBefore += w.reserve[k];
    const cs = w.creatureStore;
    for (let i = 0; i < 30; i++) step(w, 1 / 60);
    expect(w.creatures.length).toBeGreaterThan(0); // founders spawned
    let resAfter = 0;
    for (let k = 0; k < w.reserve.length; k++) if ((k % AMB_STRIDE) === CHEM_IDS.minerals) resAfter += w.reserve[k];
    // Recirculation happened: sequestered mineral reserve was drawn
    // into the freshly-spawned founders (not vanished). (Net reserve
    // total isn't a clean down-check anymore: the per-chem visible
    // ceiling demotes mineral particles back into reserve and
    // maintenanceDecay mints 0.5 min/tick, so reserve churns -- but it
    // must stay bounded, no runaway.)
    let cellMin = 0;
    for (const c of w.creatures) cellMin += cs.m_minerals[c.idx];
    expect(cellMin).toBeGreaterThan(0);
    expect(resAfter).toBeLessThan(resBefore * 1.5); // bounded, no explosion
    // No founder ballooned. The per-chem cap keeps draws small; an
    // uncapped reserve dump (the fireworks failure) would put r in
    // the hundreds, so a generous bound still discriminates.
    let maxR = 0;
    for (const c of w.creatures) if (c.r > maxR) maxR = c.r;
    expect(maxR).toBeLessThan(200);
  });
});

describe("reserve bucket + cap enforcement (Phase 4)", () => {
  it("bounds particle count at the cap and conserves mass via reserve", () => {
    const w = quietWorld();
    w.aerationRate = 0;
    w.particleSpawnRate = 0;
    const target = w.particleTarget;
    // Flood ~3x the cap with inert mineral particles.
    for (let k = 0; k < target * 3; k++) {
      pushParticle(w, {
        x: 5 + Math.random() * (w.width - 10),
        y: w.surfaceY + 5 + Math.random() * 200,
        z: 12, vx: 0, vy: 0, vz: 0, r: 2,
        chemId: CHEM_IDS.minerals, density: 2.4,
      });
    }
    const partMass = () => {
      const ps = w.particleStore; let s = 0;
      for (let i = 0; i < w.particles.length; i++) {
        const r = ps.r[i];
        s += (ps.density[i] || 1) * (4 / 3) * Math.PI * r * r * r;
      }
      return s;
    };
    const reserveTot = () => { let s = 0; for (let k = 0; k < w.reserve.length; k++) s += w.reserve[k]; return s; };
    const m0 = partMass() + reserveTot() + ambTotal(w, CHEM_IDS.minerals);
    for (let i = 0; i < 120; i++) step(w, 1 / 60);
    // Cap enforced: particle count pulled down to the target.
    expect(w.particles.length).toBeLessThanOrEqual(target);
    // The shed mass parked in the reserve pool (not destroyed).
    expect(reserveTot()).toBeGreaterThan(0);
    // Mass conserved across demote/diffuse/precipitate/promote.
    const m1 = partMass() + reserveTot() + ambTotal(w, CHEM_IDS.minerals);
    expect(Math.abs(m1 - m0)).toBeLessThan(m0 * 0.02 + 1);
  });
});

describe("region precipitation / hysteresis (Phase 3)", () => {
  it("supersaturated region precipitates then stabilises (no thrash, mass conserved)", () => {
    const w = quietWorld();
    w.aerationRate = 0;
    w.particleSpawnRate = 0;
    const INJECT = 5000;
    w.ambient[0 * AMB_STRIDE + CHEM_IDS.minerals] = INJECT;
    const minMass = () => {
      let s = ambTotal(w, CHEM_IDS.minerals);
      const ps = w.particleStore;
      for (let i = 0; i < w.particles.length; i++) {
        if (ps.chemId[i] !== CHEM_IDS.minerals) continue;
        const r = ps.r[i];
        s += ps.density[i] * (4 / 3) * Math.PI * r * r * r;
      }
      return s;
    };
    const m0 = minMass();
    for (let i = 0; i < 90; i++) step(w, 1 / 60);
    const counts: number[] = [];
    for (let i = 0; i < 60; i++) { step(w, 1 / 60); counts.push(w.particles.length); }
    const lo = Math.min(...counts), hi = Math.max(...counts);
    expect(hi - lo).toBeLessThanOrEqual(3); // deadband -> no thrash
    expect(hi).toBeGreaterThan(0);          // precipitation happened
    expect(Math.abs(minMass() - m0)).toBeLessThan(m0 * 0.02 + 1); // conserved
  });
});

describe("mass conservation", () => {
  // Total system mass = particles + creatures + ambient pool + atmosphere.
  // The phase F mass-conservation invariant: every per-tick chemistry
  // event moves mass between containers without creating or destroying
  // it. Sum should hold across many ticks.
  function worldMass(w: World): number {
    let m = 0;
    for (const p of w.particles) {
      const ps = w.particleStore;
      const d = ps.density[p.idx] !== 0 ? ps.density[p.idx] : 1;
      m += d * (4 / 3) * Math.PI * p.r * p.r * p.r;
    }
    function creatureMass(c: Creature): number {
      let cm = c.energy;
      for (const mk of MOLECULE_IDS) cm += c.molecules[mk];
      for (const inner of c.contents) cm += creatureMass(inner);
      return cm;
    }
    for (const c of w.creatures) m += creatureMass(c);
    // Phase F ambient pool: chemicals dissolved in the water column.
    for (let k = 0; k < w.ambient.length; k++) m += w.ambient[k];
    // Phase 4 reserve pool (invisible per-region chem mass).
    for (let k = 0; k < w.reserve.length; k++) m += w.reserve[k];
    // Atmosphere reservoir.
    for (const mk of MOLECULE_IDS) m += w.atmosphere[mk];
    return m;
  }

  it("soluble particles dissolve into the ambient pool", () => {
    // Phase G: a free particle of glucose (high solubility) below the
    // surface should shrink over time while ambient[glucose] grows.
    // Mass conserved: particle mass loss + ambient gain = constant.
    const w = quietWorld();
    w.aerationRate = 0;
    w.particleSpawnRate = 0;
    zeroAmb(w, CHEM_IDS.glucose);
    const p = pushParticle(w, {
      x: 100, y: 200, z: 12, vx: 0, vy: 0, vz: 0, r: 4,
      chemId: CHEM_IDS.glucose, density: 1.5,
    });
    const r0 = p.r;
    const massBefore = 1.5 * (4 / 3) * Math.PI * r0 * r0 * r0;
    for (let i = 0; i < 120; i++) step(w, 1 / 60);
    // Either the particle is still present but smaller, or it
    // fully dissolved and is gone. Either way, ambient gained mass.
    expect(ambTotal(w, CHEM_IDS.glucose)).toBeGreaterThan(0);
    if (w.particles.includes(p)) {
      expect(p.r).toBeLessThan(r0);
    }
    // Conservation: ambient gain bounded by initial particle mass.
    expect(ambTotal(w, CHEM_IDS.glucose)).toBeLessThan(massBefore * 1.01);
  });

  it("K-3 activation pass: photoreceptor visible -> activated_photo_visible scales with light", () => {
    const w = quietWorld();
    w.surfaceY = 8;
    w.dayPhase = 0.25; // peak sun
    // Cell near surface (light strong) with photoreceptor invested.
    const lit = makeCreature({ x: 100, y: 30, energy: 50,
      genome: new Uint8Array([HALT_MARK]),
      molecules: { membrane: 50, mrna: 5, aminoAcid: 2, enzyme: 1,
        photoreceptorVisible: 2 } });
    w.creatures.push(lit);
    // Cell with no receptor.
    const blind = makeCreature({ x: 200, y: 30, energy: 50,
      genome: new Uint8Array([HALT_MARK]),
      molecules: { membrane: 50, mrna: 5, aminoAcid: 2, enzyme: 1,
        photoreceptorVisible: 0 } });
    w.creatures.push(blind);
    for (let i = 0; i < 30; i++) step(w, 1 / 60);
    expect(lit.store.m_activatedPhotoVisible[lit.idx]).toBeGreaterThan(0);
    expect(blind.store.m_activatedPhotoVisible[blind.idx]).toBe(0);
  });

  it("K-3 activation pass: chemoreceptor_biopolymer + nearby biopolymer -> gradient activation", () => {
    const w = quietWorld();
    w.particleSpawnRate = 0;
    // Plant a biopolymer cluster east of the cell.
    for (let i = 0; i < 50; i++) {
      pushParticle(w, { x: 600, y: 300 + (i % 50), z: 12, vx: 0, vy: 0, vz: 0, r: 3,
        chemId: CHEM_IDS.biopolymer, density: 1.0 });
    }
    const c = makeCreature({ x: 450, y: 300, energy: 50, senseRange: 300,
      genome: new Uint8Array([HALT_MARK]),
      molecules: { membrane: 50, mrna: 5, aminoAcid: 2, enzyme: 1,
        chemoreceptorBiopolymer: 2 } });
    w.creatures.push(c);
    for (let i = 0; i < 30; i++) step(w, 1 / 60);
    // Positive activatedChemoBiopolymerX means gradient pulls toward +x (east).
    expect(c.store.m_activatedChemoBiopolymerX[c.idx]).toBeGreaterThan(0);
  });

  it("K-5 repair_chem pool keeps somatic mutation suppressed", () => {
    // CHEM_REPAIR (id 40) above 0.1 refreshes the repairTicks window
    // each tick, which somaticMutate already consults. A cell whose
    // repair_chem stays high should not accumulate mutations even
    // when its age-driven mutation rate is forced high.
    const w = quietWorld();
    const CHEM_REPAIR_ID = 40;
    const c = makeCreature({ energy: 50,
      molecules: { membrane: 50, mrna: 5, aminoAcid: 2, enzyme: 1 } });
    // Seed the cell with a big repair pool; the K-5 active-threshold
    // check (>= 0.1) will keep refreshing repairTicks every step.
    c.store.chemCols[CHEM_REPAIR_ID][c.idx] = 1.0;
    // Force an aged cell so somaticMutate would normally fire.
    c.bornAt = w.t - 200;
    w.creatures.push(c);
    for (let i = 0; i < 30; i++) step(w, 1 / 60);
    expect(c.repairTicks).toBeGreaterThan(0);
  });

  it("zero receptor pool keeps the activated chemo signal at zero", () => {
    // K-5: gradient sensing is now activated-chemo (CHEM id 23 = X
    // axis for biopolymer). The activation pass writes it only when
    // the cell holds chemoreceptor_biopolymer (chem id 19) above
    // zero. Otherwise the activated chem stays at zero -- and a
    // genome reading SENSE_CHEMICAL 23 sees zero.
    const w = quietWorld();
    w.particleSpawnRate = 0;
    for (let i = 0; i < 100; i++) {
      pushParticle(w, { x: 600, y: 300, z: 12, vx: 0, vy: 0, vz: 0, r: 3,
        chemId: CHEM_IDS.biopolymer, density: 1.0 });
    }
    const blind = makeCreature({
      x: 450, y: 300, energy: 50, senseRange: 300,
      genome: new Uint8Array([OP.SENSE_CHEMICAL, 23, OP.STORE, 0, HALT_MARK]),
      molecules: { membrane: 50, mrna: 5, aminoAcid: 2, enzyme: 1,
        chemoreceptorBiopolymer: 0 },
    });
    w.creatures.push(blind);
    step(w, 1 / 60);
    expect(blind.vm.regs[0]).toBe(0);
    const seeing = makeCreature({
      x: 450, y: 300, energy: 50, senseRange: 300,
      genome: new Uint8Array([OP.SENSE_CHEMICAL, 23, OP.STORE, 0, HALT_MARK]),
      molecules: { membrane: 50, mrna: 5, aminoAcid: 2, enzyme: 1,
        chemoreceptorBiopolymer: 2 },
    });
    w.creatures.push(seeing);
    for (let i = 0; i < 30; i++) step(w, 1 / 60);
    expect(seeing.vm.regs[0]).not.toBe(0);
  });

  it("cell <-> ambient diffusion is mass-conserving per chem", () => {
    const w = quietWorld();
    w.aerationRate = 0;
    w.particleSpawnRate = 0;
    // Force one chem (O2) to a known cell+ambient split, then run a
    // bunch of ticks and assert the per-chem total is preserved.
    for (let b = 0; b + CHEM_IDS.o2 < w.ambient.length; b += AMB_STRIDE) w.ambient[b + CHEM_IDS.o2] = 10;
    const c = makeCreature({ energy: 50 });
    c.molecules.o2 = 0;
    w.creatures.push(c);
    const o2Before = ambTotal(w, CHEM_IDS.o2) + c.molecules.o2;
    for (let i = 0; i < 60; i++) step(w, 1 / 60);
    const o2After = ambTotal(w, CHEM_IDS.o2) + c.molecules.o2;
    // Tolerance: respiration may have consumed some O2 into CO2 (mass
    // still conserved overall but redistributed). Just bound the
    // total drift to confirm no leak in the diffusion path itself.
    expect(Math.abs(o2After - o2Before)).toBeLessThan(o2Before * 0.5);
  });

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
      pushParticle(w, { x: 100 + i * 30, y: 200, z: 12, vx: 0, vy: 0, vz: 0, r: 2,
        chemId: i % 2 === 0 ? CHEM_IDS.biopolymer : CHEM_IDS.minerals,
        density: i % 2 === 0 ? 1.0 : 1.4 });
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
    pushParticle(w, { x: c.x, y: c.y, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, chemId: CHEM_IDS.biopolymer, density: 1.0 });
    for (let i = 0; i < 120; i++) step(w, 1 / 60);
    // Replenish keeps a healthy population near the cap rather than
    // draining out. (Exact count is no longer ~seed: soluble chems
    // -- incl. many generics now spawned -- dissolve into the
    // regional field, so steady state sits a bit below target.)
    expect(w.particles.length).toBeGreaterThan(w.particleTarget * 0.6);
    expect(w.particles.length).toBeLessThanOrEqual(w.particleTarget + 5);
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
    for (let i = 0; i < 550; i++) pushParticle(w, { x: 700, y: 500+(i%50), z: c.z, vx: 0, vy: 0, vz: 0, r: 3, chemId: CHEM_IDS.minerals, density: 2.6 });
    pushParticle(w, { x: 160, y: 100, z: c.z, vx: 0, vy: 0, vz: 0, r: 3, chemId: CHEM_IDS.biopolymer, density: 1.0 });
    for (let i = 0; i < 30; i++) step(w, 1 / 60);
    const stillThere = w.particles.some((p) => p.chemId === CHEM_IDS.biopolymer && p.x > 150 && p.x < 170);
    if (stillThere) {
      expect(w.creatures[0].x).toBeGreaterThan(100);
    } else {
      // The particle was consumed: assert the cell actually
      // benefited. Biopolymer may already be (partly) digested into
      // glucose/aa/fa within the 30-tick window, so accept any of
      // the uptake products rather than brittle undigested biop.
      const mol = w.creatures[0].molecules;
      expect(mol.biopolymer + mol.glucose + mol.aminoAcid + mol.fattyAcid)
        .toBeGreaterThan(0);
    }
  });
  it("threshold not met -> no spawn", () => {
    const w = quietWorld();
    const c = makeCreature({ energy: 200 });
    c.molecules.biopolymer = 10;
    c.molecules.minerals = 200;
    c.molecules.fattyAcid = 200;
    w.creatures.push(c);
    step(w, 1 / 60);
    expect(w.creatures.length).toBe(1);
  });
});

describe("reaction / ATP accounting", () => {
  const sum = (a: Int32Array | Float64Array): number => {
    let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s;
  };

  it("accumulates reaction counts + ATP flux as the sim runs", () => {
    const w = createWorld(800, 600);
    const rs = w.rxnStats!;
    expect(rs).toBeTruthy();
    expect(sum(rs.curRxn)).toBe(0);
    for (let i = 0; i < 20; i++) step(w, 1 / 60);
    // Founders + their reactions ran -> some reactions counted and
    // some ATP moved through the ledger.
    expect(sum(rs.curRxn)).toBeGreaterThan(0);
    expect(sum(rs.curAtp)).toBeGreaterThan(0);
  });

  it("rolls a 60s window: snapshots to fine[] and resets cur", () => {
    const w = createWorld(800, 600);
    const rs = w.rxnStats!;
    // createWorld pre-advances world.t (~61s), so windowStart settles
    // there on the first step. Accumulate into the *current* window.
    for (let i = 0; i < 10; i++) step(w, 1 / 60);
    const startWin = rs.windowStart;
    const before = sum(rs.curRxn);
    expect(before).toBeGreaterThan(0);
    const fineBefore = rs.fine.length;
    // Jump just past this window's 60s boundary; the next step rolls it.
    w.t = startWin + 61;
    step(w, 1 / 60);
    expect(rs.windowStart).toBeGreaterThan(startWin);
    expect(rs.fine.length).toBeGreaterThan(fineBefore);
    // The just-closed window captured the pre-roll activity.
    const closed = rs.fine[rs.fine.length - 1];
    expect(sum(closed.rxn)).toBeGreaterThanOrEqual(before);
  });

  it("compacts >1h-old fine windows into 5-minute coarse buckets", () => {
    const w = createWorld(800, 600);
    const rs = w.rxnStats!;
    for (let i = 0; i < 5; i++) step(w, 1 / 60);
    // Jump ~70 minutes ahead: the early fine window must age into a
    // coarse bucket; no fine window may remain older than 1h.
    w.t = 70 * 60;
    step(w, 1 / 60);
    expect(rs.coarse.length).toBeGreaterThanOrEqual(1);
    for (const win of rs.fine) expect(win.t0).toBeGreaterThanOrEqual(w.t - 3600 - 60);
    // 5-minute bucket boundaries.
    for (const win of rs.coarse) expect(win.t0 % 300).toBe(0);
  });

  it("serialize -> deserialize round-trips the accounting", () => {
    const w = createWorld(800, 600);
    const rs = w.rxnStats!;
    for (let i = 0; i < 30; i++) step(w, 1 / 60);
    w.t = 61; step(w, 1 / 60); // force a fine window to exist
    const before = sum(rs.curRxn) + rs.fine.reduce((a, x) => a + sum(x.rxn), 0);
    const restored = deserializeRxnStats(serializeRxnStats(rs));
    const after = sum(restored.curRxn) + restored.fine.reduce((a, x) => a + sum(x.rxn), 0);
    expect(after).toBe(before);
    expect(restored.windowStart).toBe(rs.windowStart);
    expect(restored.fine.length).toBe(rs.fine.length);
  });

  it("denatureWaste is recorded (out-of-cell field reaction)", () => {
    const w = createWorld(800, 600);
    const rs = w.rxnStats!;
    const stride = w.ambient.length / (regionCols(w) * regionRows(w));
    // Seed dissolved waste in every region so denatureWaste converts
    // it during the step (which binds the accounting world).
    for (let b = 0; b < w.ambient.length; b += stride) w.ambient[b + CHEM_IDS.waste] = 5;
    const before = sum(rs.curRxn);
    step(w, 1 / 60);
    expect(sum(rs.curRxn)).toBeGreaterThan(before);
  });
});

describe("genome replication tax", () => {
  const totalMol = (c: Creature) => {
    let m = 0;
    for (const k of MOLECULE_IDS) m += c.molecules[k];
    return m;
  };

  it("consumes aa+min 50/50, converts to waste, proportional to length, mass-conserving", () => {
    const c = makeCreature({ molecules: { aminoAcid: 100, minerals: 100, waste: 0 } });
    const before = totalMol(c);
    chargeGenomeReplication(c, new Uint8Array(600));
    // Mass conserved (aa/min -> waste, nothing destroyed).
    expect(totalMol(c)).toBeCloseTo(before, 4);
    // Total cost 600 * GENOME_MASS_PER_BYTE, split evenly aa/min.
    const half = 0.5 * 600 * GENOME_MASS_PER_BYTE;
    expect(100 - c.molecules.aminoAcid).toBeCloseTo(half, 4);
    expect(100 - c.molecules.minerals).toBeCloseTo(half, 4);
    expect(c.molecules.waste).toBeCloseTo(2 * half, 4);
  });

  it("only aa+min are touched -- other pools untouched", () => {
    const c = makeCreature({
      molecules: { aminoAcid: 100, minerals: 100, glucose: 50, fattyAcid: 40, biopolymer: 30, o2: 20, co2: 10, waste: 0 },
    });
    chargeGenomeReplication(c, new Uint8Array(400));
    expect(c.molecules.glucose).toBe(50);
    expect(c.molecules.fattyAcid).toBe(40);
    expect(c.molecules.biopolymer).toBe(30);
    expect(c.molecules.o2).toBe(20);
    expect(c.molecules.co2).toBe(10);
  });

  it("longer genome costs strictly more than a shorter one", () => {
    const mk = () => makeCreature({ molecules: { aminoAcid: 100, minerals: 100, waste: 0 } });
    const small = mk();
    const big = mk();
    chargeGenomeReplication(small, new Uint8Array(100));
    chargeGenomeReplication(big, new Uint8Array(2000));
    expect(big.molecules.waste).toBeGreaterThan(small.molecules.waste);
  });

  it("underfunding is not fatal and never goes negative or loses mass", () => {
    const c = makeCreature({ molecules: { aminoAcid: 1, minerals: 1, waste: 0 } });
    const before = totalMol(c);
    chargeGenomeReplication(c, new Uint8Array(5000));
    expect(totalMol(c)).toBeCloseTo(before, 4);
    for (const k of MOLECULE_IDS) expect(c.molecules[k]).toBeGreaterThanOrEqual(0);
    // Drained both pools fully (demand >> holdings), nothing more.
    expect(c.molecules.aminoAcid).toBe(0);
    expect(c.molecules.minerals).toBe(0);
    expect(c.molecules.waste).toBeCloseTo(2, 4);
  });
});

describe("reaction energetics: thermodynamic consistency", () => {
  // Generic reactions must derive atpDelta from composition (bond
  // potential), not a random exergonic-biased draw. The old draw had
  // mean ~+1.4 ATP/reaction -- a free-energy reservoir. Composition-
  // derived deltas are zero-mean (no bias) but still energetically
  // meaningful (nonzero spread).
  const generic = reactionCatalog()
    .filter((r) => r.label.startsWith("gen#"))
    .map((r) => r.atpDelta);

  it("generic slot count is the procedural tail", () => {
    expect(generic.length).toBe(256 - NAMED_REACTION_COUNT);
  });

  it("no exergonic bias: mean atpDelta ~ 0", () => {
    const mean = generic.reduce((a, b) => a + b, 0) / generic.length;
    expect(Math.abs(mean)).toBeLessThan(0.5);
  });

  it("energetically meaningful: real spread, both signs present", () => {
    const mean = generic.reduce((a, b) => a + b, 0) / generic.length;
    const sd = Math.sqrt(
      generic.reduce((a, b) => a + (b - mean) ** 2, 0) / generic.length,
    );
    expect(sd).toBeGreaterThan(0.5);
    expect(generic.some((d) => d > 0.5)).toBe(true);
    expect(generic.some((d) => d < -0.5)).toBe(true);
  });

  it("deterministic table: catalog is stable across calls", () => {
    const a = reactionCatalog().map((r) => r.atpDelta);
    const b = reactionCatalog().map((r) => r.atpDelta);
    expect(a).toEqual(b);
  });
});

describe("eDNA carrier persistence (Substrate A, sub-commit 1)", () => {
  it("roundtrips world carriers and a host eDNA buffer through save/load", () => {
    const w = createWorld(800, 600, { seed: 42 });
    w.eDnaCarriers.push({
      x: 12, y: 34, z: 5, age: 1.5,
      payload: new Uint8Array([1, 2, 3, 250]),
      srcSpeciesKey: "abc123",
    });
    expect(w.creatures.length).toBeGreaterThan(0);
    w.creatures[0].eDnaBuffer = new Uint8Array([9, 8, 7]);

    const json = serializeWorld(w);
    const w2 = createWorld(800, 600, { seed: 1 });
    expect(applySavedWorld(w2, json)).toBe(true);

    expect(w2.eDnaCarriers.length).toBe(1);
    const c = w2.eDnaCarriers[0];
    expect([c.x, c.y, c.z, c.age]).toEqual([12, 34, 5, 1.5]);
    expect(Array.from(c.payload)).toEqual([1, 2, 3, 250]);
    expect(c.srcSpeciesKey).toBe("abc123");
    const restored = w2.creatures.find(
      (cr) => cr.eDnaBuffer && cr.eDnaBuffer.length === 3,
    );
    expect(restored).toBeDefined();
    expect(Array.from(restored!.eDnaBuffer!)).toEqual([9, 8, 7]);
  });

  it("rejects loads across the bumped SAVE_SCHEMA", () => {
    const w = createWorld(400, 300, { seed: 7 });
    const json = serializeWorld(w);
    const tampered = json.replace(/"schema":"[^"]*"/, '"schema":"evosim4:8:x"');
    const w2 = createWorld(400, 300, { seed: 7 });
    expect(applySavedWorld(w2, tampered)).toBe(false);
  });
});

describe("eDNA lysis shedding (Substrate A, sub-commit 2)", () => {
  it("free-water lysis sheds carriers without perturbing the sim", () => {
    const w = createWorld(600, 400, { seed: 123 });
    let everShed = false;
    for (let i = 0; i < 4000 && !everShed; i++) {
      step(w, 1 / 60);
      if (w.eDnaCarriers.length > 0) everShed = true;
    }
    expect(everShed).toBe(true);
    for (const c of w.eDnaCarriers) {
      expect(c.payload.length).toBeGreaterThan(0);
      expect(c.payload.length).toBeLessThanOrEqual(GENE_FRAGMENT_CAP);
      expect(c.age).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("eDNA competence uptake (Substrate A, sub-commit 3)", () => {
  function competentCreature(): Creature {
    const c = makeCreature({ genome: new Uint8Array([OP.SYNTH, SYNTH_KIND.COMPETENCE, 0]) });
    // Mark competent this tick (the VM would set this via SYNTH
    // COMPETENCE; set directly so the test doesn't depend on stepping).
    c.vmOut.synthMask |= 1 << SYNTH_BIT_COMPETENCE;
    return c;
  }

  it("integrates the host buffer append-only, then consumes it (EGT)", () => {
    const w = quietWorld();
    const c = competentCreature();
    w.creatures.push(c);
    const original = Array.from(c.genome);
    c.eDnaBuffer = new Uint8Array([111, 122, 133, 144]);

    let grew = false;
    for (let i = 0; i < 5000 && !grew; i++) {
      w.t += 0.016;
      eDnaUptakePass(w);
      if (c.genome.length > original.length) grew = true;
    }
    expect(grew).toBe(true);
    // Append-only: original prefix preserved.
    expect(Array.from(c.genome.subarray(0, original.length))).toEqual(original);
    // Host buffer consumed on integration.
    expect(c.eDnaBuffer).toBeNull();
  });

  it("free-water carrier persists after uptake (shared pool)", () => {
    const w = quietWorld();
    const c = competentCreature();
    w.creatures.push(c);
    const original = Array.from(c.genome);
    w.eDnaCarriers.push({
      x: c.x, y: c.y, z: c.z, age: 0,
      payload: new Uint8Array([7, 8, 9, 10, 11]),
      srcSpeciesKey: "donor",
    });

    let grew = false;
    for (let i = 0; i < 5000 && !grew; i++) {
      w.t += 0.016;
      eDnaUptakePass(w);
      if (c.genome.length > original.length) grew = true;
    }
    expect(grew).toBe(true);
    expect(Array.from(c.genome.subarray(0, original.length))).toEqual(original);
    // Persists: still available for other cells until DNase decay.
    expect(w.eDnaCarriers.length).toBe(1);
  });

  it("non-competent cells never take up eDNA", () => {
    const w = quietWorld();
    const c = makeCreature({ genome: new Uint8Array([OP.SYNTH, SYNTH_KIND.COMPETENCE, 0]) });
    // No competence bit set.
    w.creatures.push(c);
    c.eDnaBuffer = new Uint8Array([1, 2, 3, 4]);
    const len0 = c.genome.length;
    for (let i = 0; i < 3000; i++) { w.t += 0.016; eDnaUptakePass(w); }
    expect(c.genome.length).toBe(len0);
    expect(c.eDnaBuffer).not.toBeNull();
  });
});

describe("eDNA active packaging (Substrate A, sub-commit 4)", () => {
  it("a cell expressing SYNTH PACKAGE sheds free-water carriers", () => {
    const w = quietWorld();
    const c = makeCreature({
      genome: new Uint8Array([OP.SYNTH, SYNTH_KIND.PACKAGE, 0]),
      energy: 1e6,
      molecules: { membrane: 500, mrna: 50, aminoAcid: 50, enzyme: 1 },
    });
    w.creatures.push(c);
    let shed = false;
    for (let i = 0; i < 2000 && !shed; i++) {
      step(w, 1 / 60);
      if (w.eDnaCarriers.length > 0) shed = true;
    }
    expect(shed).toBe(true);
    for (const e of w.eDnaCarriers) {
      expect(e.payload.length).toBeGreaterThan(0);
      expect(e.payload.length).toBeLessThanOrEqual(GENE_FRAGMENT_CAP);
    }
  });

  it("a cell not expressing PACKAGE sheds nothing", () => {
    const w = quietWorld();
    const c = makeCreature({
      genome: new Uint8Array([0x00]), // NOP only
      energy: 1e6,
      molecules: { membrane: 500, mrna: 50, aminoAcid: 50, enzyme: 1 },
    });
    w.creatures.push(c);
    for (let i = 0; i < 1500; i++) step(w, 1 / 60);
    expect(w.eDnaCarriers.length).toBe(0);
  });
});

describe("EGT emergent ratchet (Substrate A, sub-commit 5)", () => {
  // Gap 2 closed WITHOUT a hard-coded p = 1-(1-p0)^k formula: the
  // count-scaled ratchet emerges purely because more symbiont deaths
  // refresh the host buffer more often, so a competent host has more
  // integration opportunities. This test demonstrates that emergence:
  // a host whose buffer is refreshed often (frequent symbiont death)
  // integrates strictly more than one refreshed rarely, with zero
  // EGT-specific probability code in the engine.
  function competentHost(): Creature {
    const c = makeCreature({ genome: new Uint8Array([OP.SYNTH, SYNTH_KIND.COMPETENCE, 0]) });
    return c;
  }
  function countIntegrations(refreshEvery: number): number {
    const w = quietWorld();
    const c = competentHost();
    w.creatures.push(c);
    let prevLen = c.genome.length;
    let events = 0;
    for (let i = 0; i < 12000; i++) {
      // Recurrent symbiont death refreshing the host-scoped buffer
      // (what digestInnerIntoHost does on each inner death).
      if (i % refreshEvery === 0 && !c.eDnaBuffer) {
        c.eDnaBuffer = new Uint8Array([42, 43, 44, 45, 46, 47]);
      }
      c.vmOut.synthMask |= 1 << SYNTH_BIT_COMPETENCE; // competent each tick
      w.t += 0.016;
      eDnaUptakePass(w);
      if (c.genome.length > prevLen) { events++; prevLen = c.genome.length; }
    }
    return events;
  }

  it("integration frequency scales with symbiont-death frequency (no formula)", () => {
    const frequent = countIntegrations(20);    // buffer almost always full
    const rare = countIntegrations(4000);      // buffer rarely available
    expect(frequent).toBeGreaterThan(rare);
    expect(rare).toBeGreaterThanOrEqual(0);
  });
});

describe("composite archetype spawn (host + pre-engulfed symbiont)", () => {
  it("spawns the host free with the symbiont engulfed in its contents", () => {
    const w = createWorld(800, 600, { seed: 7 }) as unknown as World;
    const a = ARCHETYPES.find((x) => x.id === "farmer-mito")!;
    expect(a.symbiont).toBeTruthy();
    const host = spawnCompositeInstance(w, a.genome, a.symbiont!);
    expect(host).not.toBeNull();
    // symbiont is alive INSIDE the host, not in the free population.
    expect(host!.contents.length).toBe(1);
    expect(w.creatures.includes(host!)).toBe(true);
    expect(w.creatures.includes(host!.contents[0])).toBe(false);
    // host got the size/energy head start (relative sizes viable).
    expect(host!.molecules.membrane).toBeGreaterThanOrEqual(60);
    expect(host!.energy).toBeGreaterThanOrEqual(220);
    expect(host!.r).toBeGreaterThan(host!.contents[0].r);
    // steps without throwing (engulfed symbiont runs inside the host).
    expect(() => { for (let i = 0; i < 60; i++) step(w, 1 / 60); }).not.toThrow();
  });
});

describe("standing transporters (Substrate B, sub-commit 1: cell<->world)", () => {
  const GLU_N = TRANSPORT_CHEM_IDS.indexOf(2); // CHEM_GLU
  const SLOT = TRANSPORT_SLOT_BASE + GLU_N;
  const K = 2; // CHEM_GLU id

  function setAmbient(w: World, chem: number, v: number): void {
    for (let b = 0; b + chem < w.ambient.length; b += AMB_STRIDE) w.ambient[b + chem] = v;
  }
  function ambTotal(w: World, chem: number): number {
    let s = 0;
    for (let b = 0; b + chem < w.ambient.length; b += AMB_STRIDE) s += w.ambient[b + chem];
    return s;
  }

  it("expressing the transporter catalyst imports down-gradient, mass-exact", () => {
    const w = quietWorld();
    const c = makeCreature();
    w.creatures.push(c);
    const s = c.store, i = c.idx;
    s.chemCols[K][i] = 0;
    s.catalystCols[SLOT][i] = 10; // built the glu transporter
    setAmbient(w, K, 50);
    const before = s.chemCols[K][i] + ambTotal(w, K);
    runTransportReactions(c, w, 1);
    expect(s.chemCols[K][i]).toBeGreaterThan(0);          // imported
    const after = s.chemCols[K][i] + ambTotal(w, K);
    expect(after).toBeCloseTo(before, 6);                 // mass-exact
  });

  it("no transporter catalyst -> no flux", () => {
    const w = quietWorld();
    const c = makeCreature();
    w.creatures.push(c);
    const s = c.store, i = c.idx;
    s.chemCols[K][i] = 0;
    s.catalystCols[SLOT][i] = 0; // no transporter protein
    setAmbient(w, K, 50);
    runTransportReactions(c, w, 1);
    expect(s.chemCols[K][i]).toBe(0);
  });

  it("runs the gradient the other way (export) when the cell is richer", () => {
    const w = quietWorld();
    const c = makeCreature();
    w.creatures.push(c);
    const s = c.store, i = c.idx;
    s.chemCols[K][i] = 80;
    s.catalystCols[SLOT][i] = 10;
    setAmbient(w, K, 0);
    runTransportReactions(c, w, 1);
    expect(s.chemCols[K][i]).toBeLessThan(80);            // exported
  });
});

describe("standing transporters (Substrate B, sub-commit 2: host<->organelle)", () => {
  const MIN_N = TRANSPORT_CHEM_IDS.indexOf(5); // CHEM_MIN (inert: only SYNTH consumes it)
  const SLOT = TRANSPORT_SLOT_BASE + MIN_N;

  // Directly construct the engulfed state (inner parked in host.contents,
  // not in world.creatures) -- the same invariant the live engulf path
  // maintains -- so the test exercises runInnerCell's vacuolar transport
  // without depending on the finicky geometric engulf gate.
  function engulfed(): { w: World; host: Creature; inner: Creature } {
    const w = quietWorld();
    const host = makeCreature({ x: 400, y: 300, energy: 1e6, genome: new Uint8Array([HALT_MARK]) });
    fillCellChems(host, 300 * 6);
    const inner = makeCreature({ x: 400, y: 300, energy: 1e6, genome: new Uint8Array([HALT_MARK]) });
    fillCellChems(inner, 10 * 6);
    host.contents.push(inner);
    w.creatures.push(host); // engulfed inner is NOT in world.creatures
    return { w, host, inner };
  }

  // dInner = minerals that left the organelle. (Per-step mass-exactness
  // of the transfer is identical-by-construction to the cell<->world
  // transporter already unit-tested "mass-exact" in sub-commit 1, and
  // the suite's global mass-conservation invariant guards the engine;
  // inner+host minerals is not a closed quantity across 120 full-sim
  // steps, so asserting it here would be the wrong test.)
  function runScenario(catalystPool: number): number {
    const { w, host, inner } = engulfed();
    host.molecules.minerals = 10;
    inner.molecules.minerals = 300;
    inner.store.catalystCols[SLOT][inner.idx] = catalystPool;
    for (let i = 0; i < 120; i++) step(w, 1 / 60);
    return 300 - inner.molecules.minerals;
  }

  it("a vacuolar transporter moves chem organelle->host", () => {
    expect(runScenario(10)).toBeGreaterThan(5);
  });

  it("isolates the transporter effect vs no-catalyst control", () => {
    expect(runScenario(10)).toBeGreaterThan(runScenario(0) + 2);
  });

  // ATP translocase (ANT): the engine change for literal mitochondrial
  // ATP export. Moves the per-creature `energy` scalar (NOT a chem)
  // organelle->host across the vacuolar membrane only, gradient-driven,
  // mass-exact (both endpoints are inside the host's mass ledger).
  // (Per-step 1:1-ness of the energy transfer is identical-by-
  // construction to the cell<->world / chem vacuolar transporters
  // already covered; host+inner energy is NOT closed across 120
  // full-sim steps -- maintenance spends it -- so asserting it here
  // would be the wrong test. The global mass-conservation invariant
  // ("total mass is preserved...") guards the engine.)
  function runAtp(catalystPool: number): number {
    const { w, host, inner } = engulfed();
    host.energy = 100;
    inner.energy = 5000; // respiration-rich organelle
    inner.store.catalystCols[TRANSPORT_ATP_SLOT][inner.idx] = catalystPool;
    for (let i = 0; i < 120; i++) step(w, 1 / 60);
    return 5000 - inner.energy; // energy that left the organelle
  }

  it("ATP translocase moves energy organelle->host (down-gradient)", () => {
    expect(runAtp(10)).toBeGreaterThan(5);
  });

  it("isolates the ATP-translocase effect vs no-catalyst control", () => {
    expect(runAtp(10)).toBeGreaterThan(runAtp(0) + 2);
  });
});
