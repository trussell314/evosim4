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
  somaticMutateOnce,
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
// O(1) reverse lookup. Populated once at module load; the per-tick hot
// loops in updateCreatures and populateSensors used to call
// MATERIAL_IDS.indexOf(p.material) inside a loop over every particle for
// every cell -- tens of millions of string-array scans per second.
const MATERIAL_INDEX: Record<MaterialId, number> = {} as Record<MaterialId, number>;
for (let i = 0; i < MATERIAL_IDS.length; i++) MATERIAL_INDEX[MATERIAL_IDS[i]] = i;

export interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  r: number;
  material: MaterialId;
  // Molecule-tagged particles bypass catabolism: when ingested, their
  // contents are deposited straight into the cell's molecule pool. This
  // is how death-released corpses and auto-excreted CO2 / waste preserve
  // their actual chemistry instead of collapsing to a generic material.
  // World-seeded and VM-EXCRETE-spawned particles leave this undefined
  // and behave as plain bulk material (catabolize via CATAB_FRACTIONS).
  molecules?: Molecules;
}

export interface Creature {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  r: number;
  density: number;
  reserves: Record<MaterialId, number>;
  molecules: Molecules;
  energy: number;       // ATP. Spent operations turn it into molecules.adp.
  senseRange: number;
  thrustAccel: number;
  genome: Uint8Array;
  vm: VMState;
  color: string;
  ingestCooldown: number;
  // world.t at the moment this creature was created. Age = world.t - bornAt.
  bornAt: number;
  // genomeKey at birth -- frozen for life so species accounting (alive
  // counts, phylogeny) survives any in-life somatic mutations.
  speciesKey: string;
  // When non-null the cell is in the middle of fissioning. The child has
  // already been built and paid for; we animate the separation here, and
  // commit the child into world.creatures when progress reaches 1.
  division: { progress: number; axis: number; child: Creature } | null;
  // Cells this creature has swallowed whole (OP.ENGULF). They sit inert in
  // a vacuole inside the predator: no VM, no physics, no chemistry. Their
  // mass still counts toward the predator's total mass (and radius).
  contents: Creature[];
}

export const MATERIAL_IDS_ORDERED = MATERIAL_IDS;

// Per-cell molecular pool. ATP itself lives on the Creature as `energy`
// (so existing code that talks about energy is talking about ATP); every
// other named species in the chemistry lives here. All quantities are in
// the same mass units as reserves, so reactions are mass-conserving and
// cell volume is total mass.
//
// Reactions are catalyzed (cell-built) where biology requires it
// (chlorophyll for carbon fixation; enzymes broadly); pathways gate on
// substrate availability via Michaelis-Menten kinetics so they slow down
// rather than cut off when reactants run low. Waste / CO2 build-up that
// the cell can't process get auto-excreted as world particles.
export interface Molecules {
  adp: number;          // ATP's discharged form; energy spend goes here
  glucose: number;      // primary fuel
  fattyAcid: number;    // energy-dense secondary fuel
  aminoAcid: number;    // building block
  chlorophyll: number;  // cell-built catalyst, enables photosynthesis
  enzyme: number;       // cell-built generic catalyst
  o2: number;           // respiration substrate / photosynth product
  co2: number;          // respiration product / photosynth substrate
  minerals: number;     // mineral cofactor / structural input
  biomass: number;      // structural; part of cell volume
  waste: number;        // toxic byproduct of fermentation
}

export const MOLECULE_IDS: ReadonlyArray<keyof Molecules> = [
  "adp", "glucose", "fattyAcid", "aminoAcid", "chlorophyll", "enzyme",
  "o2", "co2", "minerals", "biomass", "waste",
];

// Building-block molecules: the substrates a cell actually consumes to
// synthesize a copy of itself. Genome bytes are charged per-byte against
// one of these four; bytes % 4 picks which.
const BUILD_KEYS: ReadonlyArray<keyof Molecules> = [
  "aminoAcid", "fattyAcid", "minerals", "biomass",
];

export function genomeMoleculeCost(genome: Uint8Array, massPerByte: number): Record<keyof Molecules, number> {
  const cost = {
    adp: 0, glucose: 0, fattyAcid: 0, aminoAcid: 0,
    chlorophyll: 0, enzyme: 0, o2: 0, co2: 0,
    minerals: 0, biomass: 0, waste: 0,
  };
  for (let i = 0; i < genome.length; i++) {
    const k = BUILD_KEYS[genome[i] % BUILD_KEYS.length];
    cost[k] += massPerByte;
  }
  return cost;
}

export function emptyMolecules(): Molecules {
  return {
    adp: 0, glucose: 0, fattyAcid: 0, aminoAcid: 0,
    chlorophyll: 0, enzyme: 0,
    o2: 0, co2: 0, minerals: 0, biomass: 0, waste: 0,
  };
}

// Phylogeny: a "species" is a unique exact genome. We track when each first
// appeared, when its population last changed, who its parents (other genome
// keys that have produced it) are, and the events that bridged ancestors to
// it. A divergence is when a new genome key is born from an existing one;
// a convergence is when an already-known genome key is re-instantiated by
// a parent that has never produced it before.
export interface Species {
  key: string;
  color: string;
  firstSeen: number;
  lastSeen: number;
  alive: number;
  parents: Set<string>;
  lane: number;
}

export interface PhylogenyEvent {
  t: number;
  from: string;
  to: string;
  convergence: boolean;
}

export interface World {
  width: number;
  height: number;
  depth: number;
  t: number;
  particles: Particle[];
  creatures: Creature[];
  particleTarget: number;
  particleSpawnRate: number;
  extinctionCount: number;
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
  // Vertical mixing: a slowly drifting sine field of up/down currents.
  // Half the world rises while the other half sinks, and the pattern
  // shifts over time so no column is permanently a downdraft.
  updraftAmp: number;
  updraftLength: number;
  updraftPeriod: number;
  // Y-coordinate of the water surface. The band y = 0..surfaceY is
  // atmosphere; cells stay submerged below it; gas particles that drift
  // up past it escape to the atmosphere. Aeration drops fresh O2-rich
  // gas particles in just below the surface at a steady rate.
  surfaceY: number;
  // Visible / physical vertical amplitude of the surface wave. The wall
  // and the renderer both use this so lipids (which float to the surface)
  // never appear above the rendered water line.
  surfaceWaveAmp: number;
  aerationRate: number;
  // Water temperature profile. The surface is warmer (sunlight), the
  // bottom is colder. Horizontal patches drift slowly via tempPatch*,
  // standing in for thermal convection without simulating it.
  tempSurface: number;
  tempBottom: number;
  tempPatchAmp: number;
  tempPatchLength: number;
  tempPatchPeriod: number;
  restitution: number;
  xWallRestitution: number;
  zWallRestitution: number;
  collisionIters: number;
  species: Map<string, Species>;
  phylogenyEvents: PhylogenyEvent[];
  nextSpeciesLane: number;
  // Cell color is keyed off genome distance from this "root" genome. The
  // root is the genome of the latest seed cell -- the world's first cell,
  // and reseed each time the population goes extinct. Distance 0 -> pure
  // white; bigger distance -> a desaturated-to-saturated hash-hued color.
  anchorGenome: Uint8Array;
  // Brownian noise amplitude added to wave forcing. Helps prevent stuff
  // from accumulating on one side of the world.
  brownianAmp: number;
}

const ENERGY_PER_THRUST_SEC = 5;
const ENERGY_PER_INSTRUCTION = 0.005;
const VM_INSTR_BUDGET = 32;

const MASS_PER_GENOME_BYTE = 1.5;
const PARTICLE_DENSITY_PER_AREA = 16500 / (800 * 600);
const PARTICLE_SPAWN_RATIO = 90 / 550;

// Recompute every world field that scales with width/height. Called on
// resize so a window expansion actually fills the new space with food
// instead of leaving the old (relatively sparse) particle target.
export function resizeWorld(world: World, width: number, height: number): void {
  world.width = width;
  world.height = Math.max(100, height);
  world.surfaceY = world.height * SURFACE_Y_FRAC;
  world.aerationRate = world.width * AERATION_PER_PX;
  world.particleTarget = Math.max(100, Math.round(world.width * world.height * PARTICLE_DENSITY_PER_AREA));
  world.particleSpawnRate = Math.max(5, world.particleTarget * PARTICLE_SPAWN_RATIO);
}
const MAX_CREATURES = 400;

const INGEST_ENERGY_COST = 1.5;
const INGEST_COOLDOWN_SEC = 0.7;
// Ingestion is rate-limited by membrane area: a bigger cell has more surface
// through which to absorb, so its post-ingest cooldown shrinks proportionally
// (cooldown / (r / INGEST_REF_R)). Below INGEST_REF_R the cooldown stays at
// the baseline so tiny cells aren't accidentally penalized.
const INGEST_REF_R = 4;
const EXCRETE_MIN_AMOUNT = 0.5;

const PREDATION_MASS_RATIO = 1.5;
const PREDATION_COOLDOWN_SEC = 0.7;
const PREDATION_ENERGY_BASE = 5;
const PREDATION_ENERGY_PER_MASS = 0.1;

// Baseline metabolism: a small flat "cost of being alive" plus a per-mass
// component. Big cells must keep more chemistry running and starve faster
// when idle. A r=4 cell pays ~0.5 e/s; a r=20 (~mass 1250) cell pays ~7 e/s.
const BASE_METABOLIC_DRAIN = 0.5;
const BASE_METABOLIC_PER_MASS = 0.0003;
const DEATH_RELEASE_R_MIN = 1.2;
const DEATH_RELEASE_SCATTER = 30;

// Thrust energy scaling. Starter cell mass is ~224 (reserves + molecules +
// ATP), so THRUST_MASS_REF=200 keeps the starter near the no-penalty line
// and only large grown cells pay the surface-area-vs-volume tax. With the
// old THRUST_MASS_REF=50 the starter paid ~4.5x and bankrupted itself on
// the chase to its first organic particle.
const THRUST_MASS_REF = 200;

// Mitosis initiation cost. Charged unconditionally at the start of every
// REPRODUCE attempt, success or failure. This is the "natural" rate limit
// on spamming REPRODUCE: a cell that fires the op every tick without the
// biomass to back it up bleeds ATP and starves itself. The per-mass term
// reflects that splitting a big cell takes more reorganization than a small
// one.
const REPRODUCE_ATTEMPT_ATP_BASE = 2;
const REPRODUCE_ATTEMPT_ATP_PER_MASS = 0.05;

// Photosynthesis depth attenuation: ambient light = exp(-y / LIGHT_DECAY).
// Surface = 1.0, e-folds every LIGHT_DECAY pixels of depth.
const LIGHT_DECAY = 250;

const DRAG_REF_R = 4;
const MIN_CREATURE_R = 4;

// ----- chemistry constants -----
//
// Catabolism rate: how fast undigested reserves break down into named
// molecules per second per unit cell surface (r/MIN_CREATURE_R). Mass
// fractions in CATAB_FRACTIONS must sum to 1 per row so material ->
// molecules conversion is mass-conserving.
const CATAB_VMAX_PER_R = 6;   // mass / sec per (r / MIN_R) surface ratio at saturation
const CATAB_KM = 6;

// Passive O2 (and CO2) exchange with the surrounding water. Real cells
// dissolve oxygen across their membrane; without this our cells starve
// because the default genome only seeks organic particles and never builds
// up enough internal O2 to power aerobic respiration.
const O2_DIFFUSION_PER_R = 2;     // mass/sec at saturation
const O2_AMBIENT = 12;             // assumed dissolved-O2 concentration cells diffuse toward
const CO2_OFFGAS_PER_R = 1.5;     // mass/sec; CO2 leaks out of cells (down its gradient)
const CO2_AMBIENT = 1;

type Catab = Partial<Molecules>;
const CATAB_FRACTIONS: Record<MaterialId, Catab> = {
  rock:    { minerals: 1.0 },
  sand:    { minerals: 1.0 },
  clay:    { minerals: 0.7, aminoAcid: 0.3 },
  organic: { glucose: 0.5, aminoAcid: 0.3, fattyAcid: 0.2 },
  lipid:   { fattyAcid: 0.7, aminoAcid: 0.3 },
  gas:     { o2: 0.6, co2: 0.4 },
};

// Reaction kinetics. Each reaction uses Michaelis-Menten saturation so it
// runs at most VMAX per second and gracefully slows as substrates deplete.
const KM_DEFAULT = 1;
const AEROBIC_VMAX = 16;    // glucose-mass consumed per sec per cell at saturation
const FERMENT_VMAX = 1.5;
const BETAOX_VMAX = 1.5;    // fatty-acid mass per sec; tame so fa survives for biosynth
const PHOTO_VMAX_PER_R = 1.2;   // photosynth scales with surface (~r)
const CHLORO_SYNTH_VMAX = 0.2;
const ENZYME_SYNTH_VMAX = 0.4;
const BIOMASS_GROW_VMAX = 0.8;

// Maintenance: structural molecules turn over even when the cell isn't
// reproducing. Each tick a small fraction of biomass / enzyme / chloro
// degrades back into the substrates it was synthesized from -- no ATP
// recovered, but mass-conserving. A cell that stops biosynthesizing
// (because it has no ATP) bleeds structure and eventually drops below
// MIN_VIABLE_BIOMASS, at which point it autolyzes.
const BIOMASS_DECAY_PER_SEC = 0.005;
const ENZYME_DECAY_PER_SEC = 0.005;
const CHLORO_DECAY_PER_SEC = 0.005;
const MIN_VIABLE_BIOMASS = 0.5;

// Somatic mutation rate scales quadratically with age (seconds). A newborn
// is effectively stable; an old cell accumulates DNA damage gradually.
// At age 60s: ~7e-3/s (1 mutation per ~140s); 100s: ~0.02/s; 300s: ~0.18/s.
const SOMATIC_MUTATION_AGE_COEF = 2e-6;

// Auto-excretion: once internal CO2 / waste crosses these thresholds, the
// cell dumps the excess back to the world as particles (mass-conserving).
// Pumping costs ATP -- a stalled cell can't flush toxins, and the
// resulting waste/CO2 buildup eats biomass (see TOX_*).
const CO2_EXCRETE_THRESHOLD = 6;
const WASTE_EXCRETE_THRESHOLD = 3;
const EXCRETE_FLOOR = 1;
const EXCRETE_ATP_PER_MASS = 0.05;

// Above the excrete thresholds, waste / CO2 accumulation actively damages
// biomass. This is the second pressure (alongside maintenance decay) that
// makes "metabolically stalled" mean "dying" rather than "immortal couch
// potato." Damage mass goes into waste (oxidative byproducts).
const TOX_DAMAGE_PER_EXCESS_PER_SEC = 0.05;

// Surface of the water sits 5% of the world height below the top. The
// band above is atmosphere where cells can't go and gas particles escape.
const SURFACE_Y_FRAC = 0.05;
// Aeration: per-pixel-of-surface-length, expected gas bubbles per second.
// Each bubble carries O2 and falls into the water; cells can ingest or
// it eventually rises back out (or gets ingested by a hungry cell).
const AERATION_PER_PX = 0.005;
const AERATION_O2_PER_BUBBLE = 4;
const AERATION_BUBBLE_DROP_SPEED = 14;

// Temperature chemistry: enzyme-catalyzed reactions and idle metabolism
// scale with temperature via Q10 -- every 10°C, rates double. T_REF is
// the "neutral" temperature where the multiplier is 1.0. Clamped so that
// extreme temps don't blow up or zero out the simulation.
const TEMP_REF = 20;
const TEMP_Q10 = 2;
const TEMP_MULT_MIN = 0.25;
const TEMP_MULT_MAX = 4.0;

// Surface displacement at a given x. Built from multiple superposed
// wavelets so the line looks like real water -- a main gravity wave plus
// off-rate harmonics, a longer swell contribution, and a coupling term
// that bulges the surface UP wherever the updraft field is pushing water
// up from below. Physics wall and renderer share this so lipids float to
// exactly the visible line.
export function surfaceYAt(world: World, x: number): number {
  const t = world.t;
  const A = world.surfaceWaveAmp;
  const kS = (2 * Math.PI) / world.surfaceLength;
  const wS = (2 * Math.PI) / world.surfacePeriod;
  const kL = (2 * Math.PI) / world.swellLength;
  const wL = (2 * Math.PI) / world.swellPeriod;
  const kU = (2 * Math.PI) / world.updraftLength;
  const wU = (2 * Math.PI) / world.updraftPeriod;

  // Main gravity wave.
  let dy = A * Math.sin(kS * x - wS * t);
  // Two off-rate harmonics: irrational frequency ratios and phase offsets
  // keep the surface from repeating noticeably.
  dy += 0.45 * A * Math.sin(1.7 * kS * x - 1.3 * wS * t + 0.6);
  dy += 0.25 * A * Math.sin(3.1 * kS * x + 2.1 * wS * t + 1.4);
  // Longer swell contribution. Slower phase so it reads as a separate
  // motion riding under the chop.
  dy += 0.7 * A * Math.sin(kL * x + 0.4 * wL * t);
  // Coupling to the vertical mixing field: where updraft is pushing
  // water up (negative ay in applyForces), the surface bulges up.
  dy -= 0.8 * A * Math.sin(kU * x + wU * t);
  return world.surfaceY + dy;
}

export function temperatureAt(world: World, x: number, y: number): number {
  const span = Math.max(1, world.height - world.surfaceY);
  const depth = Math.max(0, Math.min(1, (y - world.surfaceY) / span));
  const base = world.tempSurface + (world.tempBottom - world.tempSurface) * depth;
  const kT = (2 * Math.PI) / world.tempPatchLength;
  const wT = (2 * Math.PI) / world.tempPatchPeriod;
  const patch = world.tempPatchAmp * Math.sin(kT * x + wT * world.t);
  return base + patch;
}

function tempMult(T: number): number {
  const m = Math.pow(TEMP_Q10, (T - TEMP_REF) / 10);
  return Math.max(TEMP_MULT_MIN, Math.min(TEMP_MULT_MAX, m));
}

export function createWorld(width: number, height: number): World {
  const particleTarget = Math.max(100, Math.round(width * height * PARTICLE_DENSITY_PER_AREA));
  const world: World = {
    width, height,
    depth: 24,
    t: 0,
    particles: [],
    creatures: [],
    particleTarget,
    particleSpawnRate: Math.max(5, particleTarget * PARTICLE_SPAWN_RATIO),
    extinctionCount: 0,
    gravity: 220,
    drag: 0.6,
    surfaceAmp: 130, surfaceLength: 240, surfacePeriod: 2.4, surfaceDecay: 120,
    swellAmp: 11, swellLength: 820, swellPeriod: 8.5, swellDecay: 520,
    zStirAmp: 9,
    updraftAmp: 9, updraftLength: 360, updraftPeriod: 16,
    surfaceY: height * SURFACE_Y_FRAC,
    surfaceWaveAmp: 7,
    aerationRate: width * AERATION_PER_PX,
    tempSurface: 28,
    tempBottom: 12,
    tempPatchAmp: 3,
    tempPatchLength: 360,
    tempPatchPeriod: 38,
    restitution: 0.15, xWallRestitution: 0.4, zWallRestitution: 0.6,
    collisionIters: 2,
    species: new Map(),
    phylogenyEvents: [],
    nextSpeciesLane: 0,
    anchorGenome: new Uint8Array(0),
    brownianAmp: 25,
  };
  seedParticles(world, Math.round(particleTarget * 0.9));
  const first = makeCreature(world.width * 0.5, world.height * 0.3, world.depth * 0.5);
  first.bornAt = 0;
  // First cell defines the root: paint it white and use its genome as the
  // anchor every other cell colors against until the next extinction.
  world.anchorGenome = new Uint8Array(first.genome);
  first.color = genomeColor(first.genome, world.anchorGenome);
  world.creatures.push(first);
  noteCreatureBirth(world, first, undefined);
  return world;
}

export function seedParticles(world: World, n: number): void {
  world.particles.length = 0;
  for (let i = 0; i < n; i++) {
    const r = 1 + Math.random() * 1.5;
    // Spawn below the surface so the initial state matches the wall.
    const yRange = (world.height - world.surfaceY) * 0.85;
    world.particles.push({
      x: Math.random() * world.width,
      y: world.surfaceY + Math.random() * yRange,
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
  // Seed reserves across all materials so the cell can pay the per-byte
  // fission cost (genomeMaterialCost is spread across all 6 materials)
  // without first having to ingest one particle of every type. Without
  // this, a cell can ingest organic until its reproduce-threshold is met
  // but still fail to fission because (say) reserves.sand is still 0.
  reserves.rock = 4;
  reserves.sand = 15;
  reserves.clay = 12;
  reserves.organic = 30;
  reserves.lipid = 12;
  reserves.gas = 6;
  const molecules = emptyMolecules();
  // Starter cell ships with a working metabolism: enough ATP to live, a
  // matched ADP pool, some glucose and O2 to run respiration, a little
  // amino-acid / minerals / fatty-acid for biosynthesis and movement,
  // and biomass to give it physical body.
  molecules.adp = 50;
  molecules.glucose = 10;
  molecules.fattyAcid = 5;
  molecules.aminoAcid = 5;
  molecules.o2 = 10;
  molecules.minerals = 5;
  molecules.biomass = 30;
  const genome = makeDefaultGenome();
  const c: Creature = {
    x, y, z,
    vx: 0, vy: 0, vz: 0,
    r: MIN_CREATURE_R,
    density: 1.0,
    reserves,
    molecules,
    energy: 30,
    senseRange: 200,
    thrustAccel: 70,
    genome,
    vm: newVMState(),
    color: genomeColor(genome),
    ingestCooldown: 0,
    bornAt: 0,
    speciesKey: genomeKey(genome),
    division: null,
    contents: [],
  };
  updateCreatureRadius(c);
  return c;
}

export function genomeKey(genome: Uint8Array): string {
  let s = "";
  for (let i = 0; i < genome.length; i++) {
    const b = genome[i];
    s += (b < 16 ? "0" : "") + b.toString(16);
  }
  return s;
}

const PHYLO_EVENT_CAP = 2000;

function noteCreatureBirth(world: World, c: Creature, parentKey: string | undefined): void {
  const key = genomeKey(c.genome);
  let sp = world.species.get(key);
  const wasNew = !sp;
  if (!sp) {
    sp = {
      key,
      color: c.color,
      firstSeen: world.t,
      lastSeen: world.t,
      alive: 0,
      parents: new Set<string>(),
      lane: world.nextSpeciesLane++,
    };
    world.species.set(key, sp);
  }
  sp.lastSeen = world.t;
  sp.alive++;
  if (parentKey && parentKey !== key && !sp.parents.has(parentKey)) {
    sp.parents.add(parentKey);
    world.phylogenyEvents.push({
      t: world.t,
      from: parentKey,
      to: key,
      convergence: !wasNew,
    });
    if (world.phylogenyEvents.length > PHYLO_EVENT_CAP) {
      world.phylogenyEvents.splice(0, world.phylogenyEvents.length - PHYLO_EVENT_CAP);
    }
  }
}

function noteCreatureDeath(world: World, c: Creature): void {
  const sp = world.species.get(c.speciesKey);
  if (!sp) return;
  sp.alive = Math.max(0, sp.alive - 1);
  sp.lastSeen = world.t;
}

// Charge an ATP cost. Caps at available ATP and routes the spent mass into
// ADP so the cell can later re-charge it via respiration. Returns the amount
// actually paid (which may be less than requested if the cell ran out).
function spendATP(c: Creature, want: number): number {
  if (want <= 0) return 0;
  const got = Math.min(c.energy, want);
  c.energy -= got;
  c.molecules.adp += got;
  return got;
}

function sat(x: number, km: number = KM_DEFAULT): number {
  return x > 0 ? x / (x + km) : 0;
}

// Convert undigested reserves into named molecules. Mass-conserving:
// each row of CATAB_FRACTIONS sums to 1.
function catabolize(c: Creature, dt: number): void {
  const surface = c.r / MIN_CREATURE_R;
  for (const id of MATERIAL_IDS) {
    const avail = c.reserves[id];
    if (avail <= 0) continue;
    const rate = CATAB_VMAX_PER_R * surface * sat(avail, CATAB_KM);
    const amt = Math.min(rate * dt, avail);
    if (amt <= 0) continue;
    c.reserves[id] = avail - amt;
    const frac = CATAB_FRACTIONS[id];
    for (const k in frac) {
      const key = k as keyof Molecules;
      c.molecules[key] += amt * (frac[key] as number);
    }
  }
}

// Passive diffusion of O2 and CO2 across the cell membrane. Both flow down
// their concentration gradient between the cell and the surrounding water,
// with rate proportional to surface area. This is how dissolved gases
// equilibrate in real cells -- the genome doesn't have to plan for it.
function diffuseGases(c: Creature, dt: number): void {
  const surface = c.r / MIN_CREATURE_R;
  const o2Grad = O2_AMBIENT - c.molecules.o2;
  c.molecules.o2 += O2_DIFFUSION_PER_R * surface * o2Grad * dt * 0.1;
  const co2Grad = c.molecules.co2 - CO2_AMBIENT;
  if (co2Grad > 0) {
    c.molecules.co2 -= CO2_OFFGAS_PER_R * surface * co2Grad * dt * 0.1;
  }
}

// Aerobic respiration: 1 glu + 1 o2 + 10 adp -> 2 co2 + 10 atp.
function aerobicRespire(c: Creature, dt: number): void {
  const m = c.molecules;
  if (m.glucose <= 0 || m.o2 <= 0 || m.adp <= 0) return;
  const rate = AEROBIC_VMAX * sat(m.glucose) * sat(m.o2) * sat(m.adp / 10);
  const amt = Math.min(rate * dt, m.glucose, m.o2, m.adp / 10);
  if (amt <= 0) return;
  m.glucose -= amt;
  m.o2 -= amt;
  m.co2 += 2 * amt;
  m.adp -= 10 * amt;
  c.energy += 10 * amt;
}

// Fermentation: 1 glu + 2 adp -> 0.5 co2 + 0.5 waste + 2 atp. Suppressed
// when O2 is abundant so it acts as the anaerobic fallback path.
function ferment(c: Creature, dt: number): void {
  const m = c.molecules;
  if (m.glucose <= 0 || m.adp <= 0) return;
  const o2Suppression = KM_DEFAULT / (KM_DEFAULT + m.o2);
  const rate = FERMENT_VMAX * sat(m.glucose) * sat(m.adp / 2) * o2Suppression;
  const amt = Math.min(rate * dt, m.glucose, m.adp / 2);
  if (amt <= 0) return;
  m.glucose -= amt;
  m.adp -= 2 * amt;
  m.co2 += 0.5 * amt;
  m.waste += 0.5 * amt;
  c.energy += 2 * amt;
}

// Beta-oxidation of fatty acid: 1 fa + 1 o2 + 14 adp -> 2 co2 + 14 atp.
// Much higher ATP yield per gram than glucose -- fatty acids are dense fuel.
function betaOxidize(c: Creature, dt: number): void {
  const m = c.molecules;
  if (m.fattyAcid <= 0 || m.o2 <= 0 || m.adp <= 0) return;
  const rate = BETAOX_VMAX * sat(m.fattyAcid) * sat(m.o2) * sat(m.adp / 14);
  const amt = Math.min(rate * dt, m.fattyAcid, m.o2, m.adp / 14);
  if (amt <= 0) return;
  m.fattyAcid -= amt;
  m.o2 -= amt;
  m.co2 += 2 * amt;
  m.adp -= 14 * amt;
  c.energy += 14 * amt;
}

// Photosynthesis: 1 co2 + 1 atp + light -> 0.5 glu + 0.5 o2 + 1 adp.
// Requires chlorophyll catalyst (not consumed). Scales with surface area
// (perimeter ~ r) and with the local ambient light.
function photosynthesize(c: Creature, dt: number, light: number): void {
  const m = c.molecules;
  if (m.chlorophyll <= 0 || m.co2 <= 0 || c.energy <= 0 || light <= 0) return;
  const surface = c.r / MIN_CREATURE_R;
  const rate = PHOTO_VMAX_PER_R * surface * sat(m.chlorophyll) * sat(m.co2) * light;
  const amt = Math.min(rate * dt, m.co2, c.energy);
  if (amt <= 0) return;
  m.co2 -= amt;
  c.energy -= amt;
  m.glucose += 0.5 * amt;
  m.o2 += 0.5 * amt;
  m.adp += amt;
}

// Generic biosynthesis helper: combine two substrate molecules (by their
// mass fractions in the product) with 1 atp, producing 1 unit of product
// and 1 adp. Mass-conserving: fracA + fracB + 1 = 2, product + adp = 2.
function biosynthesize(
  c: Creature,
  dt: number,
  vmax: number,
  fracA: number, subA: keyof Molecules,
  fracB: number, subB: keyof Molecules,
  product: keyof Molecules,
): void {
  const m = c.molecules;
  const a = m[subA];
  const b = m[subB];
  if (a <= 0 || b <= 0 || c.energy <= 0) return;
  const rate = vmax * sat(a / fracA) * sat(b / fracB) * sat(c.energy);
  const amt = Math.min(rate * dt, a / fracA, b / fracB, c.energy);
  if (amt <= 0) return;
  m[subA] = a - fracA * amt;
  m[subB] = b - fracB * amt;
  c.energy -= amt;
  m[product] += amt;
  m.adp += amt;
}

function autoExcrete(c: Creature, world: World): void {
  // Bound the world's particle count: if we're already at or above the
  // target, the excess CO2 / waste dissolves into the environment and is
  // lost (mass leaves the cell either way, but no new particle).
  const overFlow = world.particles.length >= world.particleTarget;
  if (c.molecules.co2 > CO2_EXCRETE_THRESHOLD) {
    const want = c.molecules.co2 - EXCRETE_FLOOR;
    // Active transport: pumping costs ATP. A stalled cell can't pay,
    // so co2 stays inside and starts damaging biomass via toxify().
    const affordable = Math.min(want, c.energy / EXCRETE_ATP_PER_MASS);
    if (affordable > 0) {
      spendATP(c, affordable * EXCRETE_ATP_PER_MASS);
      c.molecules.co2 -= affordable;
      if (!overFlow) {
        const mol = emptyMolecules();
        mol.co2 = affordable;
        spawnExcretedParticle(c, world, "gas", affordable, mol);
      }
    }
  }
  if (c.molecules.waste > WASTE_EXCRETE_THRESHOLD) {
    const want = c.molecules.waste - EXCRETE_FLOOR;
    const affordable = Math.min(want, c.energy / EXCRETE_ATP_PER_MASS);
    if (affordable > 0) {
      spendATP(c, affordable * EXCRETE_ATP_PER_MASS);
      c.molecules.waste -= affordable;
      if (!overFlow) {
        const mol = emptyMolecules();
        mol.waste = affordable;
        spawnExcretedParticle(c, world, "organic", affordable, mol);
      }
    }
  }
}

// Structural turnover: biomass / enzyme / chloro decay continuously, mass
// returning to the substrates they were synthesized from. The cell must
// keep biosynthesizing to maintain its body. Decay never recovers ATP --
// the energy that went into building these molecules is gone.
//
// Decay rate scales up under metabolic stress. A well-fed cell with ATP
// in hand sits at the baseline rate; a starving cell (ATP near zero) sees
// up to ~5x decay because it can't run the maintenance reactions that
// would normally replenish what's falling apart. This is the channel
// that kills cells which have lost the ability to ingest -- they bleed
// structure faster than their own catabolism can rebuild it.
function maintenanceDecay(c: Creature, dt: number): void {
  const stressMult = 1 + 4 * Math.max(0, 1 - c.energy / 8);
  const m = c.molecules;
  if (m.biomass > 0) {
    const lost = m.biomass * BIOMASS_DECAY_PER_SEC * stressMult * dt;
    m.biomass -= lost;
    m.aminoAcid += 0.9 * lost;
    m.fattyAcid += 0.1 * lost;
  }
  if (m.enzyme > 0) {
    const lost = m.enzyme * ENZYME_DECAY_PER_SEC * stressMult * dt;
    m.enzyme -= lost;
    m.aminoAcid += 0.5 * lost;
    m.minerals += 0.5 * lost;
  }
  if (m.chlorophyll > 0) {
    const lost = m.chlorophyll * CHLORO_DECAY_PER_SEC * stressMult * dt;
    m.chlorophyll -= lost;
    m.aminoAcid += 0.5 * lost;
    m.minerals += 0.5 * lost;
  }
}

// Oxidative damage from accumulated waste / CO2. Above the excretion
// thresholds, biomass is converted directly to waste at a rate scaling
// with the excess. Net effect: a cell that can pay the excretion ATP
// cost stays clean; one that can't suffers proportional damage.
function toxify(c: Creature, dt: number): void {
  const m = c.molecules;
  let excess = 0;
  if (m.co2 > CO2_EXCRETE_THRESHOLD) excess += m.co2 - CO2_EXCRETE_THRESHOLD;
  if (m.waste > WASTE_EXCRETE_THRESHOLD) excess += m.waste - WASTE_EXCRETE_THRESHOLD;
  if (excess <= 0 || m.biomass <= 0) return;
  const damage = Math.min(m.biomass, excess * TOX_DAMAGE_PER_EXCESS_PER_SEC * dt);
  m.biomass -= damage;
  m.waste += damage;
}

function spawnExcretedParticle(
  c: Creature,
  world: World,
  material: MaterialId,
  m: number,
  molecules?: Molecules,
): void {
  if (m < EXCRETE_MIN_AMOUNT) {
    // Round-off; just drop it on the floor of the cell (lose to environment).
    return;
  }
  const density = MATERIALS[material].density;
  const pr = Math.max(1.5, radiusForMass(m, density));
  const angle = Math.random() * Math.PI * 2;
  const ejectV = 25;
  world.particles.push({
    x: c.x + Math.cos(angle) * (c.r + pr + 1),
    y: c.y + Math.sin(angle) * (c.r + pr + 1),
    z: Math.min(world.depth - pr, Math.max(pr, c.z)),
    vx: Math.cos(angle) * ejectV,
    vy: Math.sin(angle) * ejectV,
    vz: (Math.random() - 0.5) * 10,
    r: pr,
    material,
    molecules,
  });
}

// Levenshtein edit distance between two genomes. Bounded by the larger of
// the two lengths. Genomes are <= 256 bytes so the O(n*m) cost is fine.
export function genomeDistance(a: Uint8Array, b: Uint8Array): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Int32Array(n + 1);
  const cur = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const sub = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + sub);
    }
    prev.set(cur);
  }
  return prev[n];
}

// Cell color. With no anchor, uses a deterministic hash-based hue at fixed
// saturation/lightness. With an anchor, an exact-match genome paints white
// and the color fades toward the hash hue as edit distance grows.
const COLOR_SAT_FULL = 60;
const COLOR_LIGHT_FULL = 62;
const COLOR_DIST_FULL = 24;

export function genomeColor(genome: Uint8Array, anchor?: Uint8Array): string {
  let h = 5381 >>> 0;
  for (let i = 0; i < genome.length; i++) {
    h = ((h * 33) ^ genome[i]) >>> 0;
  }
  const hue = h % 360;
  if (!anchor) {
    return `hsl(${hue}, ${COLOR_SAT_FULL}%, ${COLOR_LIGHT_FULL}%)`;
  }
  const d = Math.min(1, genomeDistance(genome, anchor) / COLOR_DIST_FULL);
  const sat = COLOR_SAT_FULL * d;
  const light = 100 - (100 - COLOR_LIGHT_FULL) * d;
  return `hsl(${hue}, ${sat.toFixed(1)}%, ${light.toFixed(1)}%)`;
}

// Particle mass = density * (4/3) * pi * r^3. Particles are spheres; the
// circle we render is the equatorial cross-section. Same convention as cells.
function mass(p: Particle): number {
  return MATERIALS[p.material].density * (4 / 3) * Math.PI * p.r * p.r * p.r;
}

// Inverse: given a target mass and material density, what sphere radius
// does it correspond to?
function radiusForMass(m: number, density: number): number {
  return Math.cbrt((3 * m) / (4 * Math.PI * density));
}

export function step(world: World, dt: number): void {
  world.t += dt;
  applyForces(world, dt);
  updateCreatures(world, dt);
  resolveCollisions(world);
  resolveCreatureCollisions(world);
  applyWalls(world);
  aerate(world, dt);
  replenishParticles(world, dt);
  if (world.creatures.length === 0) {
    const x = world.width * (0.1 + 0.8 * Math.random());
    const y = world.height * (0.1 + 0.6 * Math.random());
    const z = world.depth * 0.5;
    const seed = makeCreature(x, y, z);
    seed.bornAt = world.t;
    // Reset the color anchor for the new lineage so descendants color
    // relative to this new "Adam".
    world.anchorGenome = new Uint8Array(seed.genome);
    seed.color = genomeColor(seed.genome, world.anchorGenome);
    world.creatures.push(seed);
    world.extinctionCount++;
    noteCreatureBirth(world, seed, undefined);
  }
}

function replenishParticles(world: World, dt: number): void {
  if (world.particles.length >= world.particleTarget) return;
  const expected = world.particleSpawnRate * dt;
  let toSpawn = Math.floor(expected);
  if (Math.random() < expected - toSpawn) toSpawn++;
  for (let i = 0; i < toSpawn && world.particles.length < world.particleTarget; i++) {
    const r = 1 + Math.random() * 1.5;
    world.particles.push({
      x: Math.random() * world.width,
      y: world.surfaceY + r,
      z: r + Math.random() * (world.depth - 2 * r),
      vx: 0, vy: 0, vz: (Math.random() - 0.5) * 20,
      r,
      material: pickMaterial(),
    });
  }
}

// Aeration: at the water surface, fresh gas particles tagged with O2
// drop in. They start with a downward velocity (so they don't escape
// instantly back through the same surface they entered through) and
// carry molecule-level O2 -- cells that ingest them get straight O2 in
// their molecule pool, just like other molecule-tagged particles.
function aerate(world: World, dt: number): void {
  if (world.particles.length >= world.particleTarget) return;
  const expected = world.aerationRate * dt;
  let n = Math.floor(expected);
  if (Math.random() < expected - n) n++;
  for (let i = 0; i < n && world.particles.length < world.particleTarget; i++) {
    const r = 1 + Math.random() * 0.8;
    const mol = emptyMolecules();
    mol.o2 = AERATION_O2_PER_BUBBLE;
    world.particles.push({
      x: Math.random() * world.width,
      // Just below the surface so the wall-escape pass doesn't immediately
      // strip the new bubble.
      y: world.surfaceY + r + 1,
      z: r + Math.random() * (world.depth - 2 * r),
      vx: (Math.random() - 0.5) * 4,
      vy: AERATION_BUBBLE_DROP_SPEED,
      vz: (Math.random() - 0.5) * 4,
      r,
      material: "gas",
      molecules: mol,
    });
  }
}

function applyForces(world: World, dt: number): void {
  const kS = (2 * Math.PI) / world.surfaceLength;
  const wS = (2 * Math.PI) / world.surfacePeriod;
  const kL = (2 * Math.PI) / world.swellLength;
  const wL = (2 * Math.PI) / world.swellPeriod;
  const kU = (2 * Math.PI) / world.updraftLength;
  const wU = (2 * Math.PI) / world.updraftPeriod;

  const bAmp = world.brownianAmp;
  const integrate = (
    o: { x: number; y: number; z: number; vx: number; vy: number; vz: number; r: number },
    density: number,
  ) => {
    const ay = world.gravity * (1 - 1 / density);
    // Surface ripple travels right; deeper swell travels left. The
    // counter-traveling pair stops particles from accumulating against
    // one wall the way a single right-moving wave train did.
    const depth = Math.max(0, o.y - world.surfaceY);
    const surface = world.surfaceAmp * Math.sin(kS * o.x - wS * world.t) * Math.exp(-depth / world.surfaceDecay);
    const swell   = world.swellAmp   * Math.sin(kL * o.x + wL * world.t) * Math.exp(-depth / world.swellDecay);
    const az      = world.zStirAmp   * Math.sin(wL * world.t + kL * o.x + 1.0) * Math.exp(-depth / world.swellDecay);
    // Vertical mixing: gentle up/down currents that vary with x and time.
    // Negative ay = upward push, positive = downward. Full water column.
    const updraft = -world.updraftAmp * Math.sin(kU * o.x + wU * world.t);
    // Per-tick zero-mean noise to break up any residual coherent drift.
    const noiseX = bAmp * (Math.random() - 0.5) * 2;
    const noiseY = bAmp * (Math.random() - 0.5) * 2;
    const ax = surface + swell + noiseX;
    const ayTot = ay + updraft + noiseY;
    const dragScale = o.r / DRAG_REF_R;
    o.vx += (ax - world.drag * dragScale * o.vx) * dt;
    o.vy += (ayTot - world.drag * dragScale * o.vy) * dt;
    o.vz += (az - world.drag * dragScale * o.vz) * dt;
    o.x += o.vx * dt;
    o.y += o.vy * dt;
    o.z += o.vz * dt;
  };

  for (const p of world.particles) integrate(p, MATERIALS[p.material].density);
  for (const c of world.creatures) integrate(c, c.density);
}

const VM_SENSORS: VMSensors = {
  gradX: new Float32Array(6),
  gradY: new Float32Array(6),
  density: new Float32Array(6),
  wallX: 0, wallY: 0,
  headX: 0, headY: 0,
  temp: 0,
  creatureDx: 0, creatureDy: 0, creatureDist: 0, creatureMass: 0,
  light: 0,
};
const VM_SELF: VMSelf = {
  energy: 0, vx: 0, vy: 0,
  reserve: new Float32Array(6),
  mass: 0,
  biomass: 0, age: 0,
  glucose: 0, o2: 0, fattyAcid: 0, aminoAcid: 0, waste: 0,
};
const VM_OUT: VMOutputs = newOutputs();

function updateCreatures(world: World, dt: number): void {
  const n = world.creatures.length;
  const dead: number[] = [];
  const eaten = new Set<number>();
  // Build the per-tick creature spatial grid. Used by populateSensors,
  // engulf scans, predation scans, and creature-creature collisions.
  buildCreatureGrid(world);
  for (let cIdx = 0; cIdx < n; cIdx++) {
    if (eaten.has(cIdx)) continue;
    const c = world.creatures[cIdx];

    updateCreatureRadius(c);

    // Temperature multiplies every enzyme-catalyzed rate (and the matching
    // idle drain) -- warm cells run hot; cold cells slow down. Q10 = 2.
    const localTemp = temperatureAt(world, c.x, c.y);
    const km = tempMult(localTemp);
    const dtT = dt * km;

    // Cost of being alive. ATP turns into ADP, mass conserved. Drain
    // scales with temperature like the rest of metabolism.
    const idleDrain = (BASE_METABOLIC_DRAIN + BASE_METABOLIC_PER_MASS * creatureTotalMass(c)) * dtT;
    spendATP(c, idleDrain);

    // Bulk -> molecules.
    catabolize(c, dtT);

    // Passive gas exchange with the surrounding water. Diffusion is
    // physical, not enzymatic -- left at the base dt.
    diffuseGases(c, dt);

    // Energy production. All three pathways may run in parallel; rates
    // self-balance via substrate availability (Michaelis-Menten).
    aerobicRespire(c, dtT);
    ferment(c, dtT);
    betaOxidize(c, dtT);

    // Carbon fixation if the cell has chlorophyll and reaches light.
    const ambientLight = Math.exp(-c.y / LIGHT_DECAY);
    photosynthesize(c, dtT, ambientLight);

    // Cell builds its own catalysts and structure as substrates allow.
    biosynthesize(c, dtT, CHLORO_SYNTH_VMAX, 0.5, "aminoAcid", 0.5, "minerals", "chlorophyll");
    biosynthesize(c, dtT, ENZYME_SYNTH_VMAX, 0.5, "aminoAcid", 0.5, "minerals", "enzyme");
    // Biomass is mostly protein (aa); the lipid fraction is structural
    // membrane only. Old 0.7/0.3 mix made fa the limiting reagent because
    // it competes with beta-oxidation for the same scarce pool.
    biosynthesize(c, dtT, BIOMASS_GROW_VMAX, 0.9, "aminoAcid", 0.1, "fattyAcid", "biomass");

    // Structural pools turn over even when nothing else is happening.
    maintenanceDecay(c, dt);

    // Vent CO2 / waste back to the world if accumulating. Costs ATP, so a
    // stalled cell will fail to flush and start accumulating toxins.
    autoExcrete(c, world);

    // Toxic damage from any waste / CO2 the cell couldn't pump out.
    toxify(c, dt);

    // Somatic DNA damage: probability rises quadratically with age, so old
    // cells slowly become genetic mosaics of their original self. Doesn't
    // create a new species -- only inheritance does that.
    const age = world.t - c.bornAt;
    // Clamp at 0.1/tick (10%) so even very old cells don't churn their
    // entire genome every second. Above the saturation point, biology
    // would be other failure modes (toxicity, biomass collapse) anyway.
    const mutP = Math.min(0.1, SOMATIC_MUTATION_AGE_COEF * age * age * dt);
    if (age > 0 && Math.random() < mutP) {
      c.genome = somaticMutateOnce(c.genome);
      c.color = genomeColor(c.genome, world.anchorGenome);
    }

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
    VM_SELF.biomass = c.molecules.biomass;
    VM_SELF.age = world.t - c.bornAt;
    VM_SELF.glucose = c.molecules.glucose;
    VM_SELF.o2 = c.molecules.o2;
    VM_SELF.fattyAcid = c.molecules.fattyAcid;
    VM_SELF.aminoAcid = c.molecules.aminoAcid;
    VM_SELF.waste = c.molecules.waste;

    runTick(c.genome, c.vm, VM_SENSORS, VM_SELF, VM_INSTR_BUDGET, VM_OUT);
    spendATP(c, VM_OUT.instructions * ENERGY_PER_INSTRUCTION);

    // TURN: rotate the cell's velocity by the accumulated angle delta.
    // Cheap; only does the trig when the genome actually issued a turn.
    if (VM_OUT.turn !== 0) {
      const cos = Math.cos(VM_OUT.turn);
      const sin = Math.sin(VM_OUT.turn);
      const nvx = c.vx * cos - c.vy * sin;
      const nvy = c.vx * sin + c.vy * cos;
      c.vx = nvx;
      c.vy = nvy;
    }

    if (VM_OUT.reproduce) tryReproduce(c, world);

    // Advance any in-flight fission. When progress hits 1, the stashed
    // daughter is committed into world.creatures.
    advanceDivision(c, world, dt);

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
      // Thrust cost scales with cube root of mass -- approximates Stokes
      // drag (~r ∝ mass^(1/3)) so a 10x cell pays only ~2.15x more to
      // move at the same speed, not 10x.
      const massScale = Math.max(1, Math.cbrt(creatureTotalMass(c) / THRUST_MASS_REF));
      spendATP(c, usedFrac * ENERGY_PER_THRUST_SEC * massScale * dt);
    }

    // VM-controlled excretion (vent specific reserves on demand).
    for (let i = 0; i < 6; i++) {
      const requested = VM_OUT.excrete[i];
      if (requested <= 0) continue;
      const matId = MATERIAL_IDS[i];
      const available = c.reserves[matId];
      const amount = Math.min(requested, available);
      if (amount < EXCRETE_MIN_AMOUNT) continue;
      c.reserves[matId] -= amount;
      spawnExcretedParticle(c, world, matId, amount);
    }

    if (c.ingestCooldown > 0) {
      c.ingestCooldown = Math.max(0, c.ingestCooldown - dt);
    }

    if (c.ingestCooldown <= 0 && c.energy >= INGEST_ENERGY_COST) {
      let ingested = false;
      // Engulf and predate both scan for nearby cells via the spatial
      // grid; range of c.r + 32 covers all plausible neighbor radii.
      const scanRange = c.r + 32;
      if (VM_OUT.engulf) {
        const myMass = creatureTotalMass(c);
        forCreaturesNear(c.x, c.y, scanRange, (j) => {
          if (j === cIdx || eaten.has(j)) return;
          const other = world.creatures[j];
          const dx = other.x - c.x;
          const dy = other.y - c.y;
          const dz = other.z - c.z;
          const minD = c.r + other.r;
          if (dx * dx + dy * dy + dz * dz >= minD * minD) return;
          const otherMass = creatureTotalMass(other);
          if (myMass < PREDATION_MASS_RATIO * Math.max(0.0001, otherMass)) return;
          const cost = PREDATION_ENERGY_BASE + PREDATION_ENERGY_PER_MASS * otherMass;
          if (c.energy < cost) return;
          c.contents.push(other);
          spendATP(c, cost);
          c.ingestCooldown = PREDATION_COOLDOWN_SEC;
          eaten.add(j);
          ingested = true;
          return true;
        });
      }
      if (!ingested && VM_OUT.predate) {
        const myMass = creatureTotalMass(c);
        forCreaturesNear(c.x, c.y, scanRange, (j) => {
          if (j === cIdx || eaten.has(j)) return;
          const other = world.creatures[j];
          const dx = other.x - c.x;
          const dy = other.y - c.y;
          const dz = other.z - c.z;
          const minD = c.r + other.r;
          if (dx * dx + dy * dy + dz * dz >= minD * minD) return;
          const otherMass = creatureTotalMass(other);
          if (myMass < PREDATION_MASS_RATIO * Math.max(0.0001, otherMass)) return;
          const cost = PREDATION_ENERGY_BASE + PREDATION_ENERGY_PER_MASS * otherMass;
          if (c.energy < cost) return;
          // Ingest: take everything the prey was carrying.
          for (let k = 0; k < 6; k++) {
            c.reserves[MATERIAL_IDS[k]] += other.reserves[MATERIAL_IDS[k]];
          }
          for (const mk of MOLECULE_IDS) c.molecules[mk] += other.molecules[mk];
          c.energy += other.energy;
          for (const inner of other.contents) c.contents.push(inner);
          other.contents.length = 0;
          spendATP(c, cost);
          c.ingestCooldown = PREDATION_COOLDOWN_SEC;
          eaten.add(j);
          ingested = true;
          return true;
        });
      }
      // Particle ingestion is genome-triggered: the cell must explicitly
      // run INGEST <material> this tick. Cells now select what they
      // want to eat -- chasing organic but bumping into a rock no longer
      // means swallowing the rock. Multiple INGEST ops per tick stack
      // into per-material flags so a genome can opt in to several types
      // at once. Engulf/predate above remain genome-triggered too.
      if (!ingested) {
        for (let i = world.particles.length - 1; i >= 0; i--) {
          const p = world.particles[i];
          const matIdx = MATERIAL_INDEX[p.material];
          if (!VM_OUT.ingestMaterials[matIdx]) continue;
          const dx = p.x - c.x;
          const dy = p.y - c.y;
          const dz = p.z - c.z;
          if (dx * dx + dy * dy + dz * dz < c.r * c.r) {
            if (p.molecules) {
              // Molecule-tagged particle: contents go straight into the
              // cell's molecule pool, bypassing catabolism. This is corpse
              // / excretion food -- already digested.
              for (const k of MOLECULE_IDS) c.molecules[k] += p.molecules[k];
            } else {
              c.reserves[p.material] += mass(p);
            }
            spendATP(c, INGEST_ENERGY_COST);
            // c.r >= MIN_CREATURE_R == INGEST_REF_R so the divisor is just c.r.
            c.ingestCooldown = INGEST_COOLDOWN_SEC * (INGEST_REF_R / c.r);
            world.particles.splice(i, 1);
            break;
          }
        }
      }
    }

    updateCreatureRadius(c);

    // Death conditions:
    //  1. Starvation: no ATP and no fuel anywhere to rebuild it.
    //  2. Autolysis: biomass has decayed below the viable minimum (the
    //     cell can no longer hold itself together as a cell).
    if ((c.energy <= 0 && noFuel(c)) || c.molecules.biomass < MIN_VIABLE_BIOMASS) {
      dead.push(cIdx);
    }
  }

  const removed: { idx: number; spill: boolean }[] = [];
  for (const idx of dead) removed.push({ idx, spill: true });
  for (const idx of eaten) removed.push({ idx, spill: false });
  removed.sort((a, b) => b.idx - a.idx);
  const released: Creature[] = [];
  for (const r of removed) {
    const victim = world.creatures[r.idx];
    // Spill the vacuole: held cells are alive and break out at the host's
    // position when the host dies or is ingested by something larger.
    for (const inner of victim.contents) {
      inner.x = victim.x + (Math.random() - 0.5) * Math.max(2, victim.r);
      inner.y = victim.y + (Math.random() - 0.5) * Math.max(2, victim.r);
      inner.z = victim.z;
      released.push(inner);
    }
    victim.contents.length = 0;
    if (r.spill) releaseReservesAsParticles(victim, world);
    noteCreatureDeath(world, victim);
    world.creatures.splice(r.idx, 1);
  }
  for (const r of released) world.creatures.push(r);
}

// Which world material best represents each molecule when it leaves a
// cell as a particle. Picked by density / chemical role so the visual
// behavior matches: fatty acid floats (lipid), gases float harder (gas),
// minerals sink (sand), the rest of the biochemistry is organic.
function moleculeBucket(k: keyof Molecules): MaterialId {
  if (k === "o2" || k === "co2") return "gas";
  if (k === "minerals") return "sand";
  if (k === "fattyAcid") return "lipid";
  return "organic";
}

function releaseReservesAsParticles(c: Creature, world: World): void {
  // On death the cell's entire contents return to the environment.
  //
  // Bulk reserves are released as plain material particles -- they're the
  // cell's undigested food pile, so they catabolize like world-seeded food
  // when re-eaten.
  //
  // The molecule pool is released as molecule-tagged particles, grouped by
  // their natural material bucket. Each particle in a bucket carries a
  // proportional slice of that bucket's molecules. When another cell eats
  // one of these, the molecules go straight into its molecule pool --
  // preserving the dead cell's actual chemistry (a fat-rich corpse gives
  // fatty acid back, a glucose-rich one gives glucose, etc.).
  for (const matId of MATERIAL_IDS) {
    let remaining = c.reserves[matId];
    if (remaining < 0.5) continue;
    const density = MATERIALS[matId].density;
    while (remaining > 0.5) {
      let r = 2 + Math.random() * 2;
      let mp = density * (4 / 3) * Math.PI * r * r * r;
      if (mp > remaining) {
        r = Math.max(DEATH_RELEASE_R_MIN, radiusForMass(remaining, density));
        mp = density * (4 / 3) * Math.PI * r * r * r;
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
      remaining -= mp;
    }
  }

  // Group molecules by their natural bucket. ATP loses its terminal
  // phosphate on death, so we lump c.energy into the adp pool.
  const bucketContents: Record<MaterialId, Molecules> = {
    rock: emptyMolecules(),
    sand: emptyMolecules(),
    clay: emptyMolecules(),
    organic: emptyMolecules(),
    lipid: emptyMolecules(),
    gas: emptyMolecules(),
  };
  const bucketTotal: Record<MaterialId, number> = {
    rock: 0, sand: 0, clay: 0, organic: 0, lipid: 0, gas: 0,
  };
  for (const k of MOLECULE_IDS) {
    const v = c.molecules[k];
    if (v <= 0) continue;
    const b = moleculeBucket(k);
    bucketContents[b][k] += v;
    bucketTotal[b] += v;
  }
  if (c.energy > 0) {
    bucketContents.organic.adp += c.energy;
    bucketTotal.organic += c.energy;
  }

  for (const matId of MATERIAL_IDS) {
    const total = bucketTotal[matId];
    if (total < 0.5) continue;
    const density = MATERIALS[matId].density;
    let remaining = total;
    let usedFrac = 0;
    while (remaining > 0.5) {
      let r = 2 + Math.random() * 2;
      let mp = density * (4 / 3) * Math.PI * r * r * r;
      if (mp > remaining) {
        r = Math.max(DEATH_RELEASE_R_MIN, radiusForMass(remaining, density));
        mp = density * (4 / 3) * Math.PI * r * r * r;
      }
      const frac = Math.min(1 - usedFrac, mp / total);
      usedFrac += frac;
      const pMol = emptyMolecules();
      for (const k of MOLECULE_IDS) pMol[k] = bucketContents[matId][k] * frac;
      world.particles.push({
        x: c.x + (Math.random() - 0.5) * 6,
        y: c.y + (Math.random() - 0.5) * 6,
        z: Math.min(world.depth - r, Math.max(r, c.z + (Math.random() - 0.5) * 4)),
        vx: (Math.random() - 0.5) * 2 * DEATH_RELEASE_SCATTER,
        vy: (Math.random() - 0.5) * 2 * DEATH_RELEASE_SCATTER,
        vz: (Math.random() - 0.5) * DEATH_RELEASE_SCATTER,
        r,
        material: matId,
        molecules: pMol,
      });
      remaining -= mp;
    }
  }
}

function tryReproduce(parent: Creature, world: World): void {
  // Can't start a new division while one is already in flight.
  if (parent.division) return;

  // Initiating mitosis costs ATP whether the attempt succeeds or not.
  // This is the rate-limit on REPRODUCE: a cell can't fire it every tick
  // without paying for the failed cycles, so spamming the op starves the
  // cell instead of being free.
  spendATP(parent, REPRODUCE_ATTEMPT_ATP_BASE + REPRODUCE_ATTEMPT_ATP_PER_MASS * creatureTotalMass(parent));

  if (world.creatures.length >= MAX_CREATURES) return;
  const childGenome = mutateGenome(parent.genome);
  // Genome cost is paid in building-block molecules (aa / fa / min / bio).
  // Genome-controlled split ratio: f = parent's share of mass after
  // fission, 1-f = child's share. Symmetric (0.5) by default; the genome
  // can push a different value before REPRODUCE to evolve r-strategist
  // (small frequent daughters, f -> 0.9) or K-strategist (rare big
  // splits, f -> 0.5) styles. Both daughters need a viable copy, so we
  // require the smaller side has at least the genome cost in each
  // build-block.
  const parentShare = VM_OUT.reproduceFraction;
  const childShare = 1 - parentShare;
  const minShare = Math.min(parentShare, childShare);
  const cost = genomeMoleculeCost(childGenome, MASS_PER_GENOME_BYTE);
  for (const k of BUILD_KEYS) {
    if (parent.molecules[k] * minShare < cost[k]) return;
  }
  const childMolecules = emptyMolecules();
  const childReserves = emptyReserves();
  for (const mk of MOLECULE_IDS) {
    const give = parent.molecules[mk] * childShare;
    parent.molecules[mk] -= give;
    childMolecules[mk] = give;
  }
  for (const id of MATERIAL_IDS) {
    const give = parent.reserves[id] * childShare;
    parent.reserves[id] -= give;
    childReserves[id] = give;
  }
  const energyGift = parent.energy * childShare;
  parent.energy -= energyGift;

  updateCreatureRadius(parent);

  const angle = Math.random() * Math.PI * 2;
  let childMassEstimate = energyGift;
  for (const id of MATERIAL_IDS) childMassEstimate += childReserves[id];
  for (const mk of MOLECULE_IDS) childMassEstimate += childMolecules[mk];
  const childRGuess = Math.max(MIN_CREATURE_R, Math.cbrt((3 * childMassEstimate) / (4 * Math.PI)));
  const offset = (parent.r + childRGuess) * 1.1;
  const child: Creature = {
    x: parent.x + Math.cos(angle) * offset,
    y: parent.y + Math.sin(angle) * offset,
    z: parent.z,
    vx: parent.vx, vy: parent.vy, vz: parent.vz,
    r: MIN_CREATURE_R,
    density: parent.density,
    reserves: childReserves,
    molecules: childMolecules,
    energy: energyGift,
    senseRange: parent.senseRange,
    thrustAccel: parent.thrustAccel,
    genome: childGenome,
    vm: newVMState(),
    color: genomeColor(childGenome, world.anchorGenome),
    ingestCooldown: INGEST_COOLDOWN_SEC,
    bornAt: world.t,
    speciesKey: genomeKey(childGenome),
    division: null,
    contents: [],
  };
  updateCreatureRadius(child);

  // Don't commit the child to the world yet -- stash it in the parent's
  // division state and animate the separation. advanceDivision() will
  // push the child into world.creatures when the visual completes.
  parent.division = {
    progress: 0,
    axis: angle,
    child,
  };
}

// Mitosis takes about a second to play out visually. The child has already
// been built and paid for inside tryReproduce; we just spread the visible
// transition over time.
export const DIVISION_DURATION_SEC = 1.0;

export function advanceDivision(c: Creature, world: World, dt: number): void {
  if (!c.division) return;
  c.division.progress += dt / DIVISION_DURATION_SEC;
  if (c.division.progress < 1) return;
  const child = c.division.child;
  const ang = c.division.axis;
  c.division = null;
  // Stillbirth check: the child must clear the autolyze floor at commit
  // time. Otherwise we'd record a birth in the species table and
  // immediately autolyze the cell, producing phantom +1/-1 churn.
  if (child.molecules.biomass < MIN_VIABLE_BIOMASS) return;
  // Drop the daughter at the current separation point. Recomputing from
  // the parent's live position keeps the visual in sync even if the
  // parent drifted during the second-long animation.
  const offset = (c.r + child.r) * 1.1;
  child.x = c.x + Math.cos(ang) * offset;
  child.y = c.y + Math.sin(ang) * offset;
  child.vx = c.vx;
  child.vy = c.vy;
  world.creatures.push(child);
  noteCreatureBirth(world, child, c.speciesKey);
}

function populateSensors(c: Creature, world: World): void {
  const range = c.senseRange;
  const rangeSq = range * range;
  // Per-material food gradient: signed pull vector summed over every visible
  // particle of that material. Each contribution is range * (dx, dy) / dsq,
  // so a particle at the edge of sense range contributes a unit vector, one
  // at half-range contributes ~2x, etc. The scaling keeps magnitudes in a
  // useful range for THRUST (which clamps to thrustAccel ~ 70).
  for (let i = 0; i < 6; i++) {
    VM_SENSORS.gradX[i] = 0;
    VM_SENSORS.gradY[i] = 0;
    VM_SENSORS.density[i] = 0;
  }
  for (const p of world.particles) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const dsq = dx * dx + dy * dy;
    if (dsq >= rangeSq || dsq < 1) continue;
    const idx = MATERIAL_INDEX[p.material];
    const w = range / dsq;
    VM_SENSORS.gradX[idx] += dx * w;
    VM_SENSORS.gradY[idx] += dy * w;
    VM_SENSORS.density[idx]++;
  }
  // Push-from-wall vector: range * (1/distLeft - 1/distRight). Magnitude
  // ~unit when the cell is at sense range from one wall and far from the
  // opposite one; 0 at the midpoint.
  const distLeft   = Math.max(1, c.x);
  const distRight  = Math.max(1, world.width - c.x);
  const distTop    = Math.max(1, c.y);
  const distBottom = Math.max(1, world.height - c.y);
  VM_SENSORS.wallX = range * (1 / distLeft - 1 / distRight);
  VM_SENSORS.wallY = range * (1 / distTop  - 1 / distBottom);
  // Normalized heading: unit vector when moving, zero at rest.
  const speed = Math.sqrt(c.vx * c.vx + c.vy * c.vy);
  if (speed > 0.01) {
    VM_SENSORS.headX = c.vx / speed;
    VM_SENSORS.headY = c.vy / speed;
  } else {
    VM_SENSORS.headX = 0;
    VM_SENSORS.headY = 0;
  }
  VM_SENSORS.light = Math.exp(-c.y / LIGHT_DECAY);
  VM_SENSORS.temp = temperatureAt(world, c.x, c.y);
  VM_SENSORS.creatureDx = 0;
  VM_SENSORS.creatureDy = 0;
  VM_SENSORS.creatureDist = range;
  VM_SENSORS.creatureMass = 0;
  let bestCreatureSq = rangeSq;
  const cs = world.creatures;
  forCreaturesNear(c.x, c.y, range, (j) => {
    const other = cs[j];
    if (other === c) return;
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
  });
}

function creatureTotalMass(c: Creature): number {
  let m = c.energy; // ATP is a real molecule and contributes to mass.
  for (let i = 0; i < 6; i++) m += c.reserves[MATERIAL_IDS[i]];
  for (const k of MOLECULE_IDS) m += c.molecules[k];
  // Engulfed prey lives in our vacuole; its mass still occupies our volume.
  for (const inner of c.contents) m += creatureSelfMass(inner);
  return m;
}

// Mass of a single cell excluding its contents -- used to avoid recursion
// when summing up an engulfed prey's contribution to its container's mass.
function creatureSelfMass(c: Creature): number {
  let m = c.energy;
  for (let i = 0; i < 6; i++) m += c.reserves[MATERIAL_IDS[i]];
  for (const k of MOLECULE_IDS) m += c.molecules[k];
  return m;
}

// Has the cell exhausted every fuel it could turn into ATP?
function noFuel(c: Creature): boolean {
  const m = c.molecules;
  return m.glucose < 0.5 && m.fattyAcid < 0.5
    && c.reserves.organic < 0.5 && c.reserves.lipid < 0.5
    // Chlorophyll + CO2 + light can still recover atp via photosynthesis.
    && !(m.chlorophyll > 0.5 && m.co2 > 0.5);
}

export function updateCreatureRadius(c: Creature): void {
  // Treat stored mass as a sphere's volume (water-density convention), then
  // render its equatorial cross-section. So mass = (4/3) pi R^3, giving
  // R = cbrt(3 m / (4 pi)). The on-screen disk's area is pi R^2.
  // This means doubling mass only grows radius by 2^(1/3) ~= 1.26, so the
  // surface-area-vs-volume penalty kicks in much harder than under the old
  // disk-area formula.
  const m = creatureTotalMass(c);
  c.r = Math.max(MIN_CREATURE_R, Math.cbrt((3 * m) / (4 * Math.PI)));
}

const GRID_CELL_SIZE = 12;
const COLLISION_BUCKETS: number[][] = [];
let COLLISION_MASS = new Float64Array(0);

// Creature spatial grid -- shared across sensor lookup, predation/engulf
// scans, and the creature-creature collision pass. Built once per tick
// at the start of updateCreatures. Replaces what used to be O(n^2) scans
// over world.creatures.
const CREATURE_GRID_CELL = 64;
const CREATURE_BUCKETS: number[][] = [];
let CREATURE_GRID_COLS = 0;
let CREATURE_GRID_ROWS = 0;

function buildCreatureGrid(world: World): void {
  const ccs = CREATURE_GRID_CELL;
  CREATURE_GRID_COLS = Math.max(1, Math.ceil(world.width / ccs));
  CREATURE_GRID_ROWS = Math.max(1, Math.ceil(world.height / ccs));
  const cellCount = CREATURE_GRID_COLS * CREATURE_GRID_ROWS;
  while (CREATURE_BUCKETS.length < cellCount) CREATURE_BUCKETS.push([]);
  for (let i = 0; i < cellCount; i++) CREATURE_BUCKETS[i].length = 0;
  const cs = world.creatures;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    let cx = Math.floor(c.x / ccs);
    let cy = Math.floor(c.y / ccs);
    if (cx < 0) cx = 0; else if (cx >= CREATURE_GRID_COLS) cx = CREATURE_GRID_COLS - 1;
    if (cy < 0) cy = 0; else if (cy >= CREATURE_GRID_ROWS) cy = CREATURE_GRID_ROWS - 1;
    CREATURE_BUCKETS[cy * CREATURE_GRID_COLS + cx].push(i);
  }
}

// Iterate creature indices that might be within `range` of (x, y). The
// visitor may return true to stop iteration early (e.g. when a predator
// finds its first valid prey). Skips buckets outside the search radius.
function forCreaturesNear(
  x: number, y: number, range: number,
  visitor: (idx: number) => boolean | void,
): void {
  const ccs = CREATURE_GRID_CELL;
  const span = Math.max(1, Math.ceil(range / ccs));
  const cx = Math.max(0, Math.min(CREATURE_GRID_COLS - 1, Math.floor(x / ccs)));
  const cy = Math.max(0, Math.min(CREATURE_GRID_ROWS - 1, Math.floor(y / ccs)));
  const x0 = Math.max(0, cx - span);
  const x1 = Math.min(CREATURE_GRID_COLS - 1, cx + span);
  const y0 = Math.max(0, cy - span);
  const y1 = Math.min(CREATURE_GRID_ROWS - 1, cy + span);
  for (let gy = y0; gy <= y1; gy++) {
    const row = gy * CREATURE_GRID_COLS;
    for (let gx = x0; gx <= x1; gx++) {
      const bucket = CREATURE_BUCKETS[row + gx];
      for (let k = 0; k < bucket.length; k++) {
        if (visitor(bucket[k]) === true) return;
      }
    }
  }
}

function resolveCollisions(world: World): void {
  const ps = world.particles;
  const n = ps.length;
  if (n < 2) return;
  const e = world.restitution;
  const cellSize = GRID_CELL_SIZE;
  const cols = Math.max(1, Math.ceil(world.width / cellSize));
  const rows = Math.max(1, Math.ceil(world.height / cellSize));
  const cellCount = cols * rows;

  while (COLLISION_BUCKETS.length < cellCount) COLLISION_BUCKETS.push([]);
  if (COLLISION_MASS.length < n) COLLISION_MASS = new Float64Array(n * 2);

  for (let i = 0; i < n; i++) COLLISION_MASS[i] = mass(ps[i]);

  for (let pass = 0; pass < world.collisionIters; pass++) {
    for (let i = 0; i < cellCount; i++) COLLISION_BUCKETS[i].length = 0;
    for (let pi = 0; pi < n; pi++) {
      const p = ps[pi];
      let cx = Math.floor(p.x / cellSize);
      let cy = Math.floor(p.y / cellSize);
      if (cx < 0) cx = 0; else if (cx >= cols) cx = cols - 1;
      if (cy < 0) cy = 0; else if (cy >= rows) cy = rows - 1;
      COLLISION_BUCKETS[cy * cols + cx].push(pi);
    }

    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const cell = COLLISION_BUCKETS[cy * cols + cx];
        const cl = cell.length;
        if (cl === 0) continue;
        for (let i = 0; i < cl; i++) {
          const ai = cell[i];
          for (let j = i + 1; j < cl; j++) resolvePair(ps, ai, cell[j], e);
        }
        checkNeighborPairs(ps, cell, cx + 1, cy,     cols, rows, e);
        checkNeighborPairs(ps, cell, cx - 1, cy + 1, cols, rows, e);
        checkNeighborPairs(ps, cell, cx,     cy + 1, cols, rows, e);
        checkNeighborPairs(ps, cell, cx + 1, cy + 1, cols, rows, e);
      }
    }
  }
}

// Soft positional separation for overlapping creatures + symmetric
// velocity exchange like the particle-particle code, but driven off
// the per-tick CREATURE_BUCKETS grid. Without this cells walk through
// each other (only PREDATE/ENGULF cared about contact) and you can't
// see flocking, body-shielding, or crowding pressure emerge.
function resolveCreatureCollisions(world: World): void {
  const cs = world.creatures;
  const n = cs.length;
  if (n < 2) return;
  // Restitution: cells are mostly soft membranes, gentle rebound.
  const e = 0.1;
  // The grid was last built at the start of updateCreatures; positions
  // have since moved by at most ~v*dt < a few px, so the grid is still
  // accurate enough for collision pairing.
  const cols = CREATURE_GRID_COLS;
  const rows = CREATURE_GRID_ROWS;
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const cell = CREATURE_BUCKETS[gy * cols + gx];
      const cl = cell.length;
      if (cl === 0) continue;
      // Pairs within this cell.
      for (let i = 0; i < cl; i++) {
        const ai = cell[i];
        for (let j = i + 1; j < cl; j++) resolveCreaturePair(cs, ai, cell[j], e);
      }
      // Half the 3x3 neighborhood -- the other half is covered by those
      // cells' own iteration. Standard staggered-neighborhood trick.
      if (gx + 1 < cols)             checkCreaturePairs(cs, cell, cell.length, cols, gy * cols + gx + 1, e);
      if (gy + 1 < rows && gx > 0)   checkCreaturePairs(cs, cell, cell.length, cols, (gy + 1) * cols + gx - 1, e);
      if (gy + 1 < rows)             checkCreaturePairs(cs, cell, cell.length, cols, (gy + 1) * cols + gx, e);
      if (gy + 1 < rows && gx + 1 < cols) checkCreaturePairs(cs, cell, cell.length, cols, (gy + 1) * cols + gx + 1, e);
    }
  }
}

function checkCreaturePairs(
  cs: Creature[], cell: number[], cl: number, _cols: number, otherIdx: number, e: number,
): void {
  const nb = CREATURE_BUCKETS[otherIdx];
  const nl = nb.length;
  if (nl === 0) return;
  for (let i = 0; i < cl; i++) {
    const ai = cell[i];
    for (let j = 0; j < nl; j++) resolveCreaturePair(cs, ai, nb[j], e);
  }
}

function resolveCreaturePair(cs: Creature[], i: number, j: number, e: number): void {
  if (i === j) return;
  const a = cs[i];
  const b = cs[j];
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let dz = b.z - a.z;
  const minDist = a.r + b.r;
  const distSq = dx * dx + dy * dy + dz * dz;
  if (distSq >= minDist * minDist) return;
  let dist = Math.sqrt(distSq);
  if (dist < 1e-6) { dx = 1; dy = 0; dz = 0; dist = 1; }
  const nx = dx / dist;
  const ny = dy / dist;
  const nz = dz / dist;
  const overlap = minDist - dist;
  const ma = creatureTotalMass(a);
  const mb = creatureTotalMass(b);
  const total = ma + mb;
  if (total <= 0) return;
  const corrA = overlap * (mb / total);
  const corrB = overlap * (ma / total);
  a.x -= nx * corrA;
  a.y -= ny * corrA;
  a.z -= nz * corrA;
  b.x += nx * corrB;
  b.y += ny * corrB;
  b.z += nz * corrB;
  // Symmetric velocity exchange along the contact normal.
  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const rvz = b.vz - a.vz;
  const vN = rvx * nx + rvy * ny + rvz * nz;
  if (vN >= 0) return;
  const jImp = (-(1 + e) * vN) / (1 / ma + 1 / mb);
  const ix = nx * jImp;
  const iy = ny * jImp;
  const iz = nz * jImp;
  a.vx -= ix / ma;
  a.vy -= iy / ma;
  a.vz -= iz / ma;
  b.vx += ix / mb;
  b.vy += iy / mb;
  b.vz += iz / mb;
}

function checkNeighborPairs(
  ps: Particle[], cell: number[],
  nx: number, ny: number, cols: number, rows: number,
  e: number,
): void {
  if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) return;
  const nb = COLLISION_BUCKETS[ny * cols + nx];
  const nl = nb.length;
  if (nl === 0) return;
  const cl = cell.length;
  for (let i = 0; i < cl; i++) {
    const ai = cell[i];
    for (let j = 0; j < nl; j++) resolvePair(ps, ai, nb[j], e);
  }
}

function resolvePair(ps: Particle[], i: number, j: number, e: number): void {
  const a = ps[i];
  const b = ps[j];
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let dz = b.z - a.z;
  const minDist = a.r + b.r;
  const distSq = dx * dx + dy * dy + dz * dz;
  if (distSq >= minDist * minDist) return;
  let dist = Math.sqrt(distSq);
  if (dist < 1e-6) { dx = 1; dy = 0; dz = 0; dist = 1; }
  const nx = dx / dist;
  const ny = dy / dist;
  const nz = dz / dist;
  const overlap = minDist - dist;
  const ma = COLLISION_MASS[i];
  const mb = COLLISION_MASS[j];
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
  if (vN >= 0) return;
  const jImp = (-(1 + e) * vN) / (1 / ma + 1 / mb);
  const ix = nx * jImp;
  const iy = ny * jImp;
  const iz = nz * jImp;
  a.vx -= ix / ma;
  a.vy -= iy / ma;
  a.vz -= iz / ma;
  b.vx += ix / mb;
  b.vy += iy / mb;
  b.vz += iz / mb;
}

function applyWalls(world: World): void {
  // Gas particles that drift up past the (wavy) water surface escape to
  // the atmosphere -- splice them out instead of clamping.
  for (let i = world.particles.length - 1; i >= 0; i--) {
    const p = world.particles[i];
    if (p.material === "gas" && p.y - p.r < surfaceYAt(world, p.x)) {
      world.particles.splice(i, 1);
    }
  }
  const wallEach = (
    o: { x: number; y: number; z: number; vx: number; vy: number; vz: number; r: number },
  ): void => {
    if (o.r * 2 >= world.width) {
      o.x = world.width * 0.5; o.vx = 0;
    } else if (o.x < o.r) {
      o.x = o.r; if (o.vx < 0) o.vx = -o.vx * world.xWallRestitution;
    } else if (o.x > world.width - o.r) {
      o.x = world.width - o.r; if (o.vx > 0) o.vx = -o.vx * world.xWallRestitution;
    }
    if (o.r * 2 >= world.height) {
      o.y = world.height * 0.5; o.vy = 0;
    } else {
      if (o.y + o.r > world.height) { o.y = world.height - o.r; if (o.vy > 0) o.vy = 0; }
      // Non-gas objects (creatures, solid particles) clamp at the wavy
      // surface so floating lipids ride the wave instead of poking above
      // the visible water line. Gas escape is handled above.
      const top = surfaceYAt(world, o.x) + o.r;
      if (o.y < top) { o.y = top; if (o.vy < 0) o.vy = 0; }
    }
    if (o.r * 2 >= world.depth) {
      o.z = world.depth * 0.5; o.vz = 0;
    } else if (o.z < o.r) {
      o.z = o.r; if (o.vz < 0) o.vz = -o.vz * world.zWallRestitution;
    } else if (o.z > world.depth - o.r) {
      o.z = world.depth - o.r; if (o.vz > 0) o.vz = -o.vz * world.zWallRestitution;
    }
  };
  for (const p of world.particles) wallEach(p);
  for (const c of world.creatures) wallEach(c);
}
