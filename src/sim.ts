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
  computeSenseRange,
  MAX_GENOME_BYTES,
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
  ["clay",    3.5],
  ["organic", 4.5],
  ["lipid",   0.5],
  ["gas",     0.5],
];

const MATERIAL_IDS = Object.keys(MATERIALS) as MaterialId[];
// O(1) reverse lookup. Populated once at module load; the per-tick hot
// loops in updateCreatures and populateSensors used to call
// MATERIAL_IDS.indexOf(p.material) inside a loop over every particle for
// every cell -- tens of millions of string-array scans per second.
const MATERIAL_INDEX: Record<MaterialId, number> = {} as Record<MaterialId, number>;
for (let i = 0; i < MATERIAL_IDS.length; i++) MATERIAL_INDEX[MATERIAL_IDS[i]] = i;

export interface ObstacleLobe {
  x: number; y: number; r: number;
}
export interface Obstacle {
  // Bounding box for cheap reject. minY in particular lets the
  // collision pass skip particles floating in the upper water column.
  minX: number; minY: number; maxX: number; maxY: number;
  // Lobes drive physics (circle-circle pushback). Cheap, robust.
  lobes: ObstacleLobe[];
  // Optional polygon outline for rendering. When present the renderer
  // draws straight-line edges with hard corners (rock-like) instead of
  // the lobe-circle union (which reads as cartoon bubbles). Crescent
  // sets this to undefined and is rendered as a lobe union.
  polygon?: { x: number; y: number }[];
  color: string;
}

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
  // Consecutive ticks the particle has been below SLEEP_SPEED_SQ. Once
  // it crosses SLEEP_THRESHOLD_TICKS the collision pass treats it as
  // asleep: pair tests against another sleeping particle are skipped.
  // Sediment piled on the bottom is the big winner here.
  quietTicks?: number;
  // Per-particle density override. When set, replaces the material's
  // base density for physics + mass. Lets organic particles vary --
  // some sink, some float -- so the food cloud actually mixes.
  density?: number;
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
  // Ticks remaining where somatic mutation is suppressed. Refreshed by
  // REPAIR op execution. Costs ATP per refresh.
  repairTicks: number;
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
  // Other creatures this cell is adhered to. Bonds are mutual: each
  // partner has the other in its bonds[] list. Used by ADHERE to form
  // multicell colonies / chains / mats. Cleared from BOTH sides on
  // death or engulf.
  bonds: Creature[];
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
  // 2D pheromone field on a coarse grid. Cells EMIT into the field at
  // their position and SENSE the local concentration. Diffuses + decays
  // each tick so signals fade and spread. Stigmergy substrate: alarm
  // calls, mate-finding, "I ate good food here" trails.
  pheromone: Float32Array;
  pheromoneCols: number;
  pheromoneRows: number;
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
  // Day/night: phase 0..1 advances at 1/dayPeriod each sec. Solar light
  // multiplier = max(0, sin(2*pi*phase + offset)); midday at phase 0.25,
  // dead night at phase 0.75. Photosynthesis and the light sensor both
  // multiply through this so cells experience a real day/night rhythm.
  dayPhase: number;
  dayPeriod: number;
  // Disturbance events ("storms"). intensity 0..1 ramps up + down across
  // an event; surfaceAmp/brownian/zStir scale with it at use sites. The
  // scheduler picks the next event time uniformly within [60s, 1200s]
  // after the previous one ends, so the gaps are irregular.
  disturbanceIntensity: number;
  disturbanceStartedAt: number;
  disturbanceUntil: number;
  nextDisturbanceAt: number;
  // Horizontal current amplitude (accel px/s^2). Surface flows one way,
  // depth the other; the sign reverses on a slow oscillation. Cells and
  // particles both feel it. Tests can zero this for stillwater scenarios.
  currentAmp: number;
  // VM ops budget per creature per tick. Lower = cheaper; cells just
  // take more ticks to finish a full pass through their genome.
  vmInstrBudget: number;
  // Static immovable terrain: rocks pre-placed at world creation. Each
  // obstacle is a cluster of overlapping circle "lobes" so it can be
  // irregular in shape. Particles + creatures collide with them like
  // a fixed wall (no impulse, just positional pushback). Crescent floor
  // and the seven-or-so dropped boulders both live here.
  obstacles: Obstacle[];
  // Optional per-phase timing. When present, step() accumulates wall-clock
  // milliseconds spent in each phase plus a tick counter. Read + reset by
  // the UI to display where the frame budget actually goes.
  profile?: WorldProfile;
}

export interface WorldProfile {
  ticks: number;
  pheromone: number;
  bonds: number;
  forces: number;
  creatures: number;
  particleColl: number;
  creatureColl: number;
  sedimentColl: number;
  obstacleColl: number;
  walls: number;
  aerate: number;
  replenish: number;
  prune: number;
}

export function makeProfile(): WorldProfile {
  return {
    ticks: 0,
    pheromone: 0, bonds: 0, forces: 0, creatures: 0,
    particleColl: 0, creatureColl: 0, sedimentColl: 0, obstacleColl: 0,
    walls: 0, aerate: 0, replenish: 0, prune: 0,
  };
}

export function resetProfile(p: WorldProfile): void {
  p.ticks = 0;
  p.pheromone = 0; p.bonds = 0; p.forces = 0; p.creatures = 0;
  p.particleColl = 0; p.creatureColl = 0; p.sedimentColl = 0;
  p.walls = 0; p.aerate = 0; p.replenish = 0; p.prune = 0;
}

const ENERGY_PER_THRUST_SEC = 5;
const ENERGY_PER_INSTRUCTION = 0.0005;
// VM ops per tick per creature. 8 keeps frame cost reasonable at high
// population. Tests override via world.vmInstrBudget when they need to
// see the whole default-genome program execute in one step.
const DEFAULT_VM_INSTR_BUDGET = 8;

const MASS_PER_GENOME_BYTE = 0.1;
const PARTICLE_DENSITY_PER_AREA = (6188 * 0.75) / (800 * 600);
const PARTICLE_SPAWN_RATIO = 90 / 550;
// Hard cap on the per-second spawn rate. Without this the world tries
// to fill thousands of particles per second from the top of the water,
// which looks like a wall of stuff falling at startup. Refill after
// eating still works because pop * eat-rate stays well under this cap
// for normal populations (~20 cells eating ~3/sec = 60/sec).
const MAX_SPAWN_PER_SEC = 200;

// Recompute every world field that scales with width/height. Called on
// resize so a window expansion actually fills the new space with food
// instead of leaving the old (relatively sparse) particle target.
export function resizeWorld(world: World, width: number, height: number): void {
  world.width = width;
  world.height = Math.max(100, height);
  world.surfaceY = world.height * SURFACE_Y_FRAC;
  world.aerationRate = world.width * AERATION_PER_PX;
  world.particleTarget = Math.max(100, Math.round(world.width * world.height * PARTICLE_DENSITY_PER_AREA));
  world.particleSpawnRate = Math.min(MAX_SPAWN_PER_SEC, Math.max(5, world.particleTarget * PARTICLE_SPAWN_RATIO));
  resizePheromone(world);
}

function resizePheromone(world: World): void {
  const cols = Math.max(1, Math.ceil(world.width / PHEROMONE_CELL));
  const rows = Math.max(1, Math.ceil(world.height / PHEROMONE_CELL));
  if (cols === world.pheromoneCols && rows === world.pheromoneRows && world.pheromone.length === cols * rows) {
    return;
  }
  world.pheromone = new Float32Array(cols * rows);
  world.pheromoneCols = cols;
  world.pheromoneRows = rows;
}

export function pheromoneIndex(world: World, x: number, y: number): number {
  const cx = Math.max(0, Math.min(world.pheromoneCols - 1, Math.floor(x / PHEROMONE_CELL)));
  const cy = Math.max(0, Math.min(world.pheromoneRows - 1, Math.floor(y / PHEROMONE_CELL)));
  return cy * world.pheromoneCols + cx;
}

// Pheromone field decay + diffusion. Called once per tick from step().
// O(cols*rows): cheap at 32px cells on a 1920x1080 canvas (~2000 cells).
// Scratch buffer for evolvePheromone -- preallocated module-level so
// we don't churn the GC with a fresh Float32Array every tick. Resized
// in resizePheromone alongside world.pheromone.
let PHEROMONE_NEXT = new Float32Array(0);
const PHEROMONE_EPS = 1e-4;
function evolvePheromone(world: World, dt: number): void {
  const cols = world.pheromoneCols;
  const rows = world.pheromoneRows;
  const f = world.pheromone;
  const decay = Math.max(0, 1 - PHEROMONE_DECAY_PER_SEC * dt);
  const diff = Math.max(0, Math.min(1, PHEROMONE_DIFFUSE_PER_SEC * dt));
  // Decay + scan: shrink in place, and track whether any cell still
  // has a meaningful value. If the field is empty we can bail before
  // the diffusion pass.
  let anyActive = false;
  for (let i = 0; i < f.length; i++) {
    const v = f[i] * decay;
    f[i] = v;
    if (v > PHEROMONE_EPS) anyActive = true;
  }
  if (!anyActive || diff <= 0 || cols < 2 || rows < 2) return;
  if (PHEROMONE_NEXT.length < f.length) PHEROMONE_NEXT = new Float32Array(f.length);
  const next = PHEROMONE_NEXT;
  const oneMinusDiff = 1 - diff;
  // Interior cells: every cell has 4 neighbors; no boundary checks.
  // Skip the 4-edge frame which is handled in the boundary pass below.
  for (let y = 1; y < rows - 1; y++) {
    const row = y * cols;
    for (let x = 1; x < cols - 1; x++) {
      const i = row + x;
      const avg = (f[i - 1] + f[i + 1] + f[i - cols] + f[i + cols]) * 0.25;
      next[i] = f[i] * oneMinusDiff + avg * diff;
    }
  }
  // Boundary cells: each has 2 or 3 neighbors. Handle the four edges.
  for (let x = 0; x < cols; x++) {
    // top row
    const it = x;
    let s = 0, n = 0;
    if (x > 0)        { s += f[it - 1];    n++; }
    if (x < cols - 1) { s += f[it + 1];    n++; }
    s += f[it + cols]; n++;
    next[it] = f[it] * oneMinusDiff + (s / n) * diff;
    // bottom row
    const ib = (rows - 1) * cols + x;
    s = 0; n = 0;
    if (x > 0)        { s += f[ib - 1];    n++; }
    if (x < cols - 1) { s += f[ib + 1];    n++; }
    s += f[ib - cols]; n++;
    next[ib] = f[ib] * oneMinusDiff + (s / n) * diff;
  }
  for (let y = 1; y < rows - 1; y++) {
    // left column
    const il = y * cols;
    let s = f[il + 1] + f[il - cols] + f[il + cols];
    next[il] = f[il] * oneMinusDiff + (s / 3) * diff;
    // right column
    const ir = il + (cols - 1);
    s = f[ir - 1] + f[ir - cols] + f[ir + cols];
    next[ir] = f[ir] * oneMinusDiff + (s / 3) * diff;
  }
  // Copy next -> f via subarray-set for a single C-side memcpy.
  f.set(next.subarray(0, f.length));
}
const MAX_CREATURES = 400;

const INGEST_ENERGY_COST = 1.5;
const INGEST_COOLDOWN_SEC = 0.15;
// Ingestion is rate-limited by membrane area: a bigger cell has more surface
// through which to absorb, so its post-ingest cooldown shrinks proportionally
// (cooldown / (r / INGEST_REF_R)). Below INGEST_REF_R the cooldown stays at
// the baseline so tiny cells aren't accidentally penalized.
const INGEST_REF_R = 4;
const EXCRETE_MIN_AMOUNT = 0.5;

const PREDATION_MASS_RATIO = 1.5;
const PREDATION_COOLDOWN_SEC = 0.2;
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
const REPRODUCE_ATTEMPT_ATP_BASE = 0.4;
const REPRODUCE_ATTEMPT_ATP_PER_MASS = 0.01;

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

// Precomputed flat tables: per-material, the molecule keys and their
// fractions, ready for indexed iteration. Beats `for (const k in frac)`
// in catabolize() -- for-in is several times slower than a tight indexed
// loop over packed arrays.
const CATAB_KEYS: Record<MaterialId, (keyof Molecules)[]> = {} as Record<MaterialId, (keyof Molecules)[]>;
const CATAB_FRACS: Record<MaterialId, number[]> = {} as Record<MaterialId, number[]>;
for (const id of Object.keys(CATAB_FRACTIONS) as MaterialId[]) {
  const row = CATAB_FRACTIONS[id];
  const keys: (keyof Molecules)[] = [];
  const fracs: number[] = [];
  for (const k of Object.keys(row) as (keyof Molecules)[]) {
    const v = row[k];
    if (v !== undefined && v > 0) { keys.push(k); fracs.push(v); }
  }
  CATAB_KEYS[id] = keys;
  CATAB_FRACS[id] = fracs;
}

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
const SOMATIC_MUTATION_AGE_COEF = 8e-7;
const REPAIR_ATP_PER_OP = 0.5;
const REPAIR_WINDOW_TICKS = 30;
// Horizontal current: amplitude (px/s^2 of acceleration) and the rate of
// the slow direction-reversal oscillation (rad/sec; 2pi/600 ~ 10 sim-min).
// Currently disabled (0) -- when on it piles sediment against one wall
// faster than the slow reversal can clear it. Need a better profile.
const CURRENT_AMP = 0;
const CURRENT_FREQ = 2 * Math.PI / 600;

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
// Vertical splash: how deep the surface "spray" force reaches, and
// how strong it is relative to the horizontal surface force. High gain
// makes droplets visibly jump; small depth keeps the bulk water still.
const SPLASH_DEPTH = 30;
const SPLASH_GAIN = 1.5;
// Aeration: per-pixel-of-surface-length, expected gas bubbles per second.
// Each bubble carries O2 and falls into the water; cells can ingest or
// it eventually rises back out (or gets ingested by a hungry cell).
const AERATION_PER_PX = 0.005;
const AERATION_O2_PER_BUBBLE = 4;
const AERATION_BUBBLE_DROP_SPEED = 14;

// Pheromone field: coarse grid cell size, per-tick decay rate, and
// neighbor-blend (diffusion) fraction. Tuned so a single big emit
// (e.g. 50) fades to background in a few seconds and spreads about
// one grid cell per tick of diffusion.
const PHEROMONE_CELL = 32;
const PHEROMONE_DECAY_PER_SEC = 0.5;
const PHEROMONE_DIFFUSE_PER_SEC = 0.6;

// Adhesion: how many partners a single cell can be bonded to and the
// spring + break distances. Bonds are mutual; the spring rest length
// is the contact distance (sum of radii). Bonds snap at BOND_BREAK_RATIO
// times the rest length so a colony being yanked apart eventually
// disintegrates.
const MAX_BONDS = 4;
const BOND_SPRING_K = 8;
const BOND_BREAK_RATIO = 3.5;

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
// Activity factor for surface-related forces. Combines the slow
// irregularity envelope (so quiet periods read calm) with the storm
// disturbance intensity (so storms read like real chop). Used by the
// visible surface wave, the physics wave forcing, and aeration so all
// three move together.
export function surfaceActivity(world: World): number {
  const t = world.t;
  const env =
    0.55 +
    0.25 * Math.sin(t * (2 * Math.PI / 37)) +
    0.20 * Math.sin(t * (2 * Math.PI / 91) + 1.7);
  const envClamped = Math.max(0.15, Math.min(1.0, env));
  return envClamped * (1 + 3 * world.disturbanceIntensity);
}

export function surfaceYAt(world: World, x: number): number {
  const t = world.t;
  const A = world.surfaceWaveAmp * surfaceActivity(world);
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

// Solar light multiplier 0..1. Sin curve over dayPhase with midday at
// phase 0.25; dark half of cycle returns 0. Multiplied into the depth
// attenuation at every light-using site (photosynthesis, sensor).
export function solarLight(world: World): number {
  return Math.max(0, Math.sin(2 * Math.PI * world.dayPhase));
}

function advanceDayCycle(world: World, dt: number): void {
  world.dayPhase = (world.dayPhase + dt / world.dayPeriod) % 1;
}

// Schedule + ramp disturbance ("storm") intensity. While intensity > 0,
// surface waves, vertical mixing, and brownian forcing are all
// amplified at use sites. Trapezoidal envelope: ramp up 0..1 in first
// 30% of the event, hold, ramp 1..0 in last 30%. Gaps between events
// are picked from [60s, 1200s] so they're irregular.
function advanceDisturbance(world: World, dt: number): void {
  void dt;
  const t = world.t;
  if (world.disturbanceUntil > 0 && t >= world.disturbanceUntil) {
    world.disturbanceUntil = 0;
    world.disturbanceIntensity = 0;
  }
  if (world.disturbanceUntil === 0 && t >= world.nextDisturbanceAt) {
    const duration = 8 + Math.random() * 10;
    world.disturbanceStartedAt = t;
    world.disturbanceUntil = t + duration;
    world.nextDisturbanceAt = world.disturbanceUntil + 60 + Math.random() * 1140;
  }
  if (world.disturbanceUntil > 0) {
    const duration = world.disturbanceUntil - world.disturbanceStartedAt;
    const f = (t - world.disturbanceStartedAt) / duration;
    let i: number;
    if (f < 0.3) i = f / 0.3;
    else if (f > 0.7) i = (1 - f) / 0.3;
    else i = 1;
    world.disturbanceIntensity = Math.max(0, Math.min(1, i));
  }
}

// Lay down the world's terrain: a wide crescent floor (covers ~25% of
// world height, sweeping up at the edges) plus a handful of irregular
// boulders scattered along the bottom. Each obstacle is a cluster of
// overlapping circle "lobes" so it reads as an irregular rock outline
// rather than a perfect circle.
export function generateObstacles(world: World): void {
  world.obstacles = [];
  const W = world.width;
  const H = world.height;

  // Continuous rocky floor across the bottom of the world, with:
  //   * 2 sandy gaps (vertical strips with no rocks; sand piles there)
  //   * 1 C-shaped alcove off one of the gaps -- a curved hollow cove
  //     opening into the sandy strip so cells can swim in and shelter.
  const floorTopY = H * 0.76;
  const floorBotY = H - 4;
  const floorDepth = floorBotY - floorTopY;

  // Sandy gap A: near the cove. Cells use this as the corridor to enter.
  const gapACx = W * (0.30 + Math.random() * 0.20);
  const gapAHw = W * 0.035;
  // Sandy gap B: just for variety, somewhere else.
  const gapBCx = W * (0.65 + Math.random() * 0.20);
  const gapBHw = W * 0.028;

  // Cove: a curved circular hollow attached to gap A. Opens into the
  // gap on one side. Roughly 50% of floor depth in radius -- big enough
  // to hold a few cells but not so big it eats the floor.
  const coveSide = gapACx < W * 0.5 ? 1 : -1; // open the cove into world center
  const coveR = floorDepth * 0.45;
  const coveCx = gapACx + coveSide * (gapAHw + coveR * 0.65);
  const coveCy = floorTopY + floorDepth * 0.55;

  const inGap = (px: number): boolean =>
    Math.abs(px - gapACx) < gapAHw || Math.abs(px - gapBCx) < gapBHw;

  // Cove exclusion: inside the cove disc, PLUS a narrow bridge of width
  // ~half coveR connecting the cove's inner edge to the gap. The bridge
  // is what makes it a C (open side) instead of a sealed circle.
  const bridgeY0 = coveCy - coveR * 0.32;
  const bridgeY1 = coveCy + coveR * 0.32;
  const bridgeX0 = coveSide > 0 ? gapACx + gapAHw : coveCx + coveSide * coveR;
  const bridgeX1 = coveSide > 0 ? coveCx - coveR : gapACx - gapAHw;
  const bx0 = Math.min(bridgeX0, bridgeX1);
  const bx1 = Math.max(bridgeX0, bridgeX1);
  const inCove = (px: number, py: number, pad: number): boolean => {
    const dx = px - coveCx;
    const dy = py - coveCy;
    if (dx * dx + dy * dy < (coveR - pad) * (coveR - pad)) return true;
    if (px >= bx0 - pad && px <= bx1 + pad &&
        py >= bridgeY0 - pad && py <= bridgeY1 + pad) return true;
    return false;
  };

  // Distribute rocks across the floor. For each column x, drop 1-3
  // rocks stacked downward. Skip columns that overlap gaps or the cove.
  // Per-rock jitter in x/y breaks the grid so the surface reads natural.
  const colSpacing = 28;
  for (let xPos = 8; xPos < W - 8; xPos += colSpacing) {
    for (let yPos = floorTopY + 8; yPos < floorBotY; yPos += 26) {
      const baseR = 13 + Math.random() * 14;
      const rx = xPos + (Math.random() - 0.5) * colSpacing * 0.7;
      const ry = yPos + (Math.random() - 0.5) * 10;
      // Top row: jiggle Y so the rocky surface undulates.
      if (yPos < floorTopY + 14) {
        // Skip a small fraction of top-row rocks to add silhouette gaps.
        if (Math.random() < 0.15) continue;
      }
      if (inGap(rx)) continue;
      if (inCove(rx, ry, -baseR * 0.4)) continue;
      const elong = 0.85 + Math.random() * 0.9;
      const tilt = -0.5 + Math.random() * 1.0;
      const polygon = buildRockPolygon(rx, ry, baseR, elong, tilt);
      const lobes = lobesFromPolygon(rx, ry, polygon, baseR);
      const tones = ["#4a4038", "#3a322c", "#52463b", "#403631", "#473d34", "#574b40", "#3d342e"];
      const tone = tones[Math.floor(Math.random() * tones.length)];
      const ob = makeObstacleFromLobes(lobes, tone);
      ob.polygon = polygon;
      for (const v of polygon) {
        if (v.x < ob.minX) ob.minX = v.x;
        if (v.y < ob.minY) ob.minY = v.y;
        if (v.x > ob.maxX) ob.maxX = v.x;
        if (v.y > ob.maxY) ob.maxY = v.y;
      }
      world.obstacles.push(ob);
    }
  }
}

// Polygon vertices around a rock center. n vertices distributed around
// 2pi with jittered angles + radii; offset toward an elongation axis so
// the rock isn't radially symmetric.
function buildRockPolygon(
  cx: number, cy: number, baseR: number, elong: number, tilt: number,
): { x: number; y: number }[] {
  const n = 9 + Math.floor(Math.random() * 4);
  const ca = Math.cos(tilt), sa = Math.sin(tilt);
  const verts: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / n;
    // Jitter angle around the even slice so corners aren't symmetric.
    const ang = t * Math.PI * 2 + (Math.random() - 0.5) * (Math.PI / n);
    // Vertex radius with strong variance. Some vertices close, some far.
    const r = baseR * (0.7 + 0.55 * Math.random());
    // Pre-rotation: ellipse aligned with x-axis, then tilt.
    const ex = Math.cos(ang) * r * elong;
    const ey = Math.sin(ang) * r;
    verts.push({
      x: cx + ca * ex - sa * ey,
      y: cy + sa * ex + ca * ey,
    });
  }
  return verts;
}

// Approximate the interior of a polygon with circle lobes for collision.
// Strategy: one large centroid lobe (inscribed-ish) + a small lobe at
// each vertex. Particles in the interior collide with the centroid;
// particles approaching from outside the convex hull collide with the
// nearest vertex lobe. Good enough for stylized terrain.
function lobesFromPolygon(
  cx: number, cy: number, polygon: { x: number; y: number }[], baseR: number,
): ObstacleLobe[] {
  const lobes: ObstacleLobe[] = [{ x: cx, y: cy, r: baseR * 0.85 }];
  for (const v of polygon) {
    lobes.push({ x: v.x, y: v.y, r: baseR * 0.22 });
  }
  return lobes;
}

function makeObstacleFromLobes(lobes: ObstacleLobe[], color: string): Obstacle {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of lobes) {
    if (l.x - l.r < minX) minX = l.x - l.r;
    if (l.y - l.r < minY) minY = l.y - l.r;
    if (l.x + l.r > maxX) maxX = l.x + l.r;
    if (l.y + l.r > maxY) maxY = l.y + l.r;
  }
  return { minX, minY, maxX, maxY, lobes, color };
}

// Push particles + creatures out of any obstacle they overlap. Static
// terrain: zero impulse to the obstacle, full corrective push back on
// the moving body. With ~50-70 total lobes and AABB pre-reject most
// particles bail in the first compare.
// Static spatial index for obstacles. Terrain doesn't move, so the
// index is built once in generateObstacles and reused every tick.
const OBSTACLE_BAND_W = 64;
let OBSTACLE_BANDS: Obstacle[][] = [];
let OBSTACLE_BANDS_COLS = 0;
let OBSTACLES_MIN_Y = Infinity;

function rebuildObstacleIndex(world: World): void {
  OBSTACLES_MIN_Y = Infinity;
  for (const ob of world.obstacles) {
    if (ob.minY < OBSTACLES_MIN_Y) OBSTACLES_MIN_Y = ob.minY;
  }
  OBSTACLE_BANDS_COLS = Math.max(1, Math.ceil(world.width / OBSTACLE_BAND_W));
  OBSTACLE_BANDS = Array.from({ length: OBSTACLE_BANDS_COLS }, () => []);
  const margin = 6;
  for (const ob of world.obstacles) {
    const b0 = Math.max(0, Math.floor((ob.minX - margin) / OBSTACLE_BAND_W));
    const b1 = Math.min(OBSTACLE_BANDS_COLS - 1, Math.floor((ob.maxX + margin) / OBSTACLE_BAND_W));
    for (let i = b0; i <= b1; i++) OBSTACLE_BANDS[i].push(ob);
  }
}

function resolveObstacleCollisions(world: World): void {
  if (world.obstacles.length === 0) return;
  const minY = OBSTACLES_MIN_Y;
  for (let i = 0; i < world.particles.length; i++) {
    const p = world.particles[i];
    if (p.y + p.r < minY) continue;
    collideObstaclesAt(p, world.restitution);
  }
  for (let i = 0; i < world.creatures.length; i++) {
    const c = world.creatures[i];
    if (c.y + c.r < minY) continue;
    collideObstaclesAt(c, 0.1);
  }
}

function collideObstaclesAt(
  o: { x: number; y: number; vx: number; vy: number; r: number },
  e: number,
): void {
  let bx = Math.floor(o.x / OBSTACLE_BAND_W);
  if (bx < 0) bx = 0; else if (bx >= OBSTACLE_BANDS_COLS) bx = OBSTACLE_BANDS_COLS - 1;
  const obs = OBSTACLE_BANDS[bx];
  for (let i = 0; i < obs.length; i++) {
    const ob = obs[i];
    if (o.x + o.r < ob.minX || o.x - o.r > ob.maxX) continue;
    if (o.y + o.r < ob.minY || o.y - o.r > ob.maxY) continue;
    const lobes = ob.lobes;
    for (let j = 0; j < lobes.length; j++) {
      const l = lobes[j];
      const dx = o.x - l.x;
      const dy = o.y - l.y;
      const minDist = o.r + l.r;
      const d2 = dx * dx + dy * dy;
      if (d2 >= minDist * minDist) continue;
      let d = Math.sqrt(d2);
      let nx, ny;
      if (d < 1e-6) { nx = 0; ny = -1; d = 1; }
      else { nx = dx / d; ny = dy / d; }
      const overlap = minDist - d;
      o.x += nx * overlap;
      o.y += ny * overlap;
      const vN = o.vx * nx + o.vy * ny;
      if (vN < 0) {
        o.vx -= (1 + e) * vN * nx;
        o.vy -= (1 + e) * vN * ny;
      }
    }
  }
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
    particleSpawnRate: Math.min(MAX_SPAWN_PER_SEC, Math.max(5, particleTarget * PARTICLE_SPAWN_RATIO)),
    extinctionCount: 0,
    gravity: 60,
    drag: 0.6,
    surfaceAmp: 55, surfaceLength: 200, surfacePeriod: 7, surfaceDecay: 90,
    swellAmp: 5, swellLength: 600, swellPeriod: 18, swellDecay: 520,
    zStirAmp: 4,
    updraftAmp: 4, updraftLength: 540, updraftPeriod: 28,
    surfaceY: height * SURFACE_Y_FRAC,
    surfaceWaveAmp: 14,
    aerationRate: width * AERATION_PER_PX,
    tempSurface: 28,
    tempBottom: 12,
    tempPatchAmp: 3,
    tempPatchLength: 360,
    tempPatchPeriod: 38,
    pheromone: new Float32Array(0),
    pheromoneCols: 0,
    pheromoneRows: 0,
    restitution: 0.15, xWallRestitution: 0.4, zWallRestitution: 0.6,
    collisionIters: 1,
    species: new Map(),
    phylogenyEvents: [],
    nextSpeciesLane: 0,
    anchorGenome: new Uint8Array(0),
    brownianAmp: 12,
    dayPhase: 0.2, // start a bit before noon so first day shows
    dayPeriod: 90,
    disturbanceIntensity: 0,
    disturbanceStartedAt: 0,
    disturbanceUntil: 0,
    nextDisturbanceAt: 60 + Math.random() * 240,
    currentAmp: CURRENT_AMP,
    vmInstrBudget: DEFAULT_VM_INSTR_BUDGET,
    obstacles: [],
  };
  // Allocate the pheromone grid sized to the world.
  resizePheromone(world);
  generateObstacles(world);
  rebuildObstacleIndex(world);
  // World starts empty: just water and the seed cell. Particles trickle
  // in via replenishParticles() at world.particleSpawnRate until the
  // target is reached, so the simulation has a visible "bootstrap"
  // period instead of dumping thousands of particles all at once.
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
    const mat = pickMaterial();
    world.particles.push({
      x: Math.random() * world.width,
      y: world.surfaceY + Math.random() * yRange,
      z: r + Math.random() * (world.depth - 2 * r),
      vx: 0, vy: 0, vz: (Math.random() - 0.5) * 20,
      r,
      material: mat,
      density: rollDensity(mat),
    });
  }
}

// Per-spawn density jitter. Organic biomatter ranges from oily/lipid-rich
// (floats) to dense protein clumps (sinks); randomize each particle so
// the cloud actually mixes vertically instead of forming a flat stratum.
// Triangular distribution centered on the material's base density.
function rollDensity(material: MaterialId): number | undefined {
  if (material !== "organic") return undefined;
  const tri = Math.random() + Math.random() - 1; // -1..1, triangle peak 0
  return 1.0 + tri * 0.3; // 0.7..1.3
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
  molecules.glucose = 20;
  molecules.fattyAcid = 15;
  molecules.aminoAcid = 15;
  molecules.o2 = 15;
  molecules.minerals = 15;
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
    senseRange: computeSenseRange(genome),
    thrustAccel: 70,
    genome,
    vm: newVMState(),
    color: genomeColor(genome),
    ingestCooldown: 0,
    repairTicks: 0,
    bornAt: 0,
    speciesKey: genomeKey(genome),
    division: null,
    contents: [],
    bonds: [],
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

// Species accumulate forever otherwise. drawPhylogeny iterates the
// whole map each frame; an hours-long run can pile up tens of thousands
// of entries, all dead, and gradually slow the renderer. Drop any
// species that has been extinct AND off the visible phylogeny window
// for a generous grace period. Also drop their phylogeny edges.
const SPECIES_GRACE_SEC = 240;
const SPECIES_PRUNE_INTERVAL_SEC = 5;
let lastSpeciesPruneAt = -SPECIES_PRUNE_INTERVAL_SEC;
function pruneSpecies(world: World): void {
  if (world.t - lastSpeciesPruneAt < SPECIES_PRUNE_INTERVAL_SEC) return;
  lastSpeciesPruneAt = world.t;
  const cutoff = world.t - SPECIES_GRACE_SEC;
  const drop = new Set<string>();
  for (const sp of world.species.values()) {
    if (sp.alive === 0 && sp.lastSeen < cutoff) drop.add(sp.key);
  }
  if (drop.size === 0) return;
  for (const key of drop) world.species.delete(key);
  for (let i = world.phylogenyEvents.length - 1; i >= 0; i--) {
    const ev = world.phylogenyEvents[i];
    if (drop.has(ev.from) || drop.has(ev.to)) world.phylogenyEvents.splice(i, 1);
  }
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
  const rsv = c.reserves;
  const mol = c.molecules;
  for (let i = 0; i < MATERIAL_IDS.length; i++) {
    const id = MATERIAL_IDS[i];
    const avail = rsv[id];
    if (avail <= 0) continue;
    const rate = CATAB_VMAX_PER_R * surface * (avail / (avail + CATAB_KM));
    const amt = rate * dt < avail ? rate * dt : avail;
    if (amt <= 0) continue;
    rsv[id] = avail - amt;
    const keys = CATAB_KEYS[id];
    const fracs = CATAB_FRACS[id];
    for (let k = 0; k < keys.length; k++) {
      mol[keys[k]] += amt * fracs[k];
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
// sat() inlined here and below: avoids the default-argument fast path
// in the generic helper which the JIT doesn't always specialize.
function aerobicRespire(c: Creature, dt: number): void {
  const m = c.molecules;
  const g = m.glucose, o = m.o2, a = m.adp;
  if (g <= 0 || o <= 0 || a <= 0) return;
  const a10 = a / 10;
  const rate = AEROBIC_VMAX * (g / (g + KM_DEFAULT)) * (o / (o + KM_DEFAULT)) * (a10 / (a10 + KM_DEFAULT));
  const rdt = rate * dt;
  let amt = rdt < g ? rdt : g;
  if (o < amt) amt = o;
  if (a10 < amt) amt = a10;
  if (amt <= 0) return;
  m.glucose = g - amt;
  m.o2 = o - amt;
  m.co2 += 2 * amt;
  m.adp = a - 10 * amt;
  c.energy += 10 * amt;
}

// Fermentation: 1 glu + 2 adp -> 0.5 co2 + 0.5 waste + 2 atp. Suppressed
// when O2 is abundant so it acts as the anaerobic fallback path.
function ferment(c: Creature, dt: number): void {
  const m = c.molecules;
  const g = m.glucose, o = m.o2, a = m.adp;
  if (g <= 0 || a <= 0) return;
  const a2 = a / 2;
  const o2Suppression = KM_DEFAULT / (KM_DEFAULT + o);
  const rate = FERMENT_VMAX * (g / (g + KM_DEFAULT)) * (a2 / (a2 + KM_DEFAULT)) * o2Suppression;
  const rdt = rate * dt;
  let amt = rdt < g ? rdt : g;
  if (a2 < amt) amt = a2;
  if (amt <= 0) return;
  m.glucose = g - amt;
  m.adp = a - 2 * amt;
  m.co2 += 0.5 * amt;
  m.waste += 0.5 * amt;
  c.energy += 2 * amt;
}

// Beta-oxidation of fatty acid: 1 fa + 1 o2 + 14 adp -> 2 co2 + 14 atp.
// Much higher ATP yield per gram than glucose -- fatty acids are dense fuel.
function betaOxidize(c: Creature, dt: number): void {
  const m = c.molecules;
  const f = m.fattyAcid, o = m.o2, a = m.adp;
  if (f <= 0 || o <= 0 || a <= 0) return;
  const a14 = a / 14;
  const rate = BETAOX_VMAX * (f / (f + KM_DEFAULT)) * (o / (o + KM_DEFAULT)) * (a14 / (a14 + KM_DEFAULT));
  const rdt = rate * dt;
  let amt = rdt < f ? rdt : f;
  if (o < amt) amt = o;
  if (a14 < amt) amt = a14;
  if (amt <= 0) return;
  m.fattyAcid = f - amt;
  m.o2 = o - amt;
  m.co2 += 2 * amt;
  m.adp = a - 14 * amt;
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
// Single-crossover recombination of two genomes. The result has the
// parent's length (so size-based costs are stable). Bytes 0..k come
// from parent a, bytes k..end from parent b; if b is shorter we fall
// back to a's tail. k is uniformly random.
// Apply a SPLICE_DUP / SPLICE_DEL request to a cell's live genome.
// mode 1 = duplicate the [off, off+len) region in place; mode 2 = delete
// it. Genome length is clamped to [1, MAX_GENOME_BYTES]. PC is taken
// mod the new length so the next tick resumes somewhere valid.
function applyGenomeSplice(c: Creature, mode: number, off: number, len: number): void {
  const g = c.genome;
  const L = g.length;
  if (L === 0 || len <= 0) return;
  const a = ((off % L) + L) % L;
  const b = Math.min(L, a + len);
  if (b <= a) return;
  let next: Uint8Array;
  if (mode === 1) {
    // Duplicate: [0..L) -> [0..b) + [a..b) (the duplicated region) + [b..L)
    const dupLen = b - a;
    const newLen = Math.min(MAX_GENOME_BYTES, L + dupLen);
    next = new Uint8Array(newLen);
    next.set(g.subarray(0, Math.min(b, newLen)), 0);
    // Copy the duplicate region after the original; cap to newLen.
    const dupStart = b;
    const dupEnd = Math.min(newLen, dupStart + dupLen);
    if (dupEnd > dupStart) next.set(g.subarray(a, a + (dupEnd - dupStart)), dupStart);
    // Tail (originally [b..L))
    const tailStart = dupEnd;
    const tailLen = Math.min(L - b, newLen - tailStart);
    if (tailLen > 0) next.set(g.subarray(b, b + tailLen), tailStart);
  } else if (mode === 2) {
    // Delete: keep [0..a) and [b..L).
    const newLen = Math.max(1, L - (b - a));
    next = new Uint8Array(newLen);
    next.set(g.subarray(0, a), 0);
    if (newLen > a) next.set(g.subarray(b, b + (newLen - a)), a);
  } else {
    return;
  }
  c.genome = next;
  if (c.vm.pc >= next.length) c.vm.pc = c.vm.pc % next.length;
}

function crossoverGenomes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const len = a.length;
  if (len === 0) return new Uint8Array(b);
  const out = new Uint8Array(len);
  const k = Math.floor(Math.random() * (len + 1));
  for (let i = 0; i < k; i++) out[i] = a[i];
  for (let i = k; i < len; i++) out[i] = i < b.length ? b[i] : a[i];
  return out;
}

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
  const d = p.density ?? MATERIALS[p.material].density;
  return d * (4 / 3) * Math.PI * p.r * p.r * p.r;
}

// Inverse: given a target mass and material density, what sphere radius
// does it correspond to?
function radiusForMass(m: number, density: number): number {
  return Math.cbrt((3 * m) / (4 * Math.PI * density));
}

export function step(world: World, dt: number): void {
  world.t += dt;
  advanceDayCycle(world, dt);
  advanceDisturbance(world, dt);
  const p = world.profile;
  if (p) {
    let m = performance.now();
    evolvePheromone(world, dt);
    let n = performance.now(); p.pheromone += n - m; m = n;
    applyBondSprings(world, dt);
    n = performance.now(); p.bonds += n - m; m = n;
    applyForces(world, dt);
    n = performance.now(); p.forces += n - m; m = n;
    updateCreatures(world, dt);
    n = performance.now(); p.creatures += n - m; m = n;
    resolveCollisions(world);
    n = performance.now(); p.particleColl += n - m; m = n;
    resolveCreatureCollisions(world);
    n = performance.now(); p.creatureColl += n - m; m = n;
    resolveCreatureSedimentCollisions(world);
    n = performance.now(); p.sedimentColl += n - m; m = n;
    resolveObstacleCollisions(world);
    n = performance.now(); p.obstacleColl += n - m; m = n;
    applyWalls(world);
    n = performance.now(); p.walls += n - m; m = n;
    aerate(world, dt);
    n = performance.now(); p.aerate += n - m; m = n;
    replenishParticles(world, dt);
    n = performance.now(); p.replenish += n - m; m = n;
    pruneSpecies(world);
    n = performance.now(); p.prune += n - m;
    p.ticks++;
  } else {
    evolvePheromone(world, dt);
    applyBondSprings(world, dt);
    applyForces(world, dt);
    updateCreatures(world, dt);
    resolveCollisions(world);
    resolveCreatureCollisions(world);
    resolveCreatureSedimentCollisions(world);
    resolveObstacleCollisions(world);
    applyWalls(world);
    aerate(world, dt);
    replenishParticles(world, dt);
    pruneSpecies(world);
  }
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
    const mat = pickMaterial();
    world.particles.push({
      x: Math.random() * world.width,
      y: world.surfaceY + r,
      z: r + Math.random() * (world.depth - 2 * r),
      vx: 0, vy: 0, vz: (Math.random() - 0.5) * 20,
      r,
      material: mat,
      density: rollDensity(mat),
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
  // Surface chop drives entrainment of air bubbles. Quiet surface =>
  // baseline aeration; storms and choppy periods => much more O2 mixed in.
  const act = surfaceActivity(world);
  const expected = world.aerationRate * dt * (0.5 + act);
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

// Adhesion springs: pull bonded creatures toward their contact distance.
// Bonds that stretch beyond BOND_BREAK_RATIO * restLen snap.
//
// Pair de-duplication: bonds are mutual (each side has the other in its
// list), so processing each (a, b) without care would apply forces
// twice. We use a per-tick Set keyed by (smaller-bornAt + larger-bornAt
// + position) -- creatures don't have a stable numeric ID, but the
// pair (cs[i], b) where i is the array index works fine because we
// only process when b's index is > i. Use a precomputed index map.
// Reused per-tick to avoid allocating a fresh Map each call.
const BOND_IDX_MAP: Map<Creature, number> = new Map();
function applyBondSprings(world: World, dt: number): void {
  const cs = world.creatures;
  const idxOf = BOND_IDX_MAP;
  idxOf.clear();
  for (let i = 0; i < cs.length; i++) idxOf.set(cs[i], i);
  for (let i = 0; i < cs.length; i++) {
    const a = cs[i];
    const bonds = a.bonds;
    for (let bi = bonds.length - 1; bi >= 0; bi--) {
      const b = bonds[bi];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distSq = dx * dx + dy * dy;
      const restLen = a.r + b.r;
      const breakLen = restLen * BOND_BREAK_RATIO;
      if (distSq > breakLen * breakLen) {
        bonds.splice(bi, 1);
        const j = b.bonds.indexOf(a);
        if (j >= 0) b.bonds.splice(j, 1);
        continue;
      }
      // Only the lower-indexed side applies the spring.
      const bj = idxOf.get(b);
      if (bj === undefined || bj <= i) continue;
      const dist = Math.sqrt(distSq);
      if (dist < 1e-6) continue;
      const stretch = dist - restLen;
      const f = BOND_SPRING_K * stretch * dt;
      const nx = dx / dist;
      const ny = dy / dist;
      const ma = Math.max(0.01, creatureTotalMass(a));
      const mb = Math.max(0.01, creatureTotalMass(b));
      a.vx += nx * f / ma;
      a.vy += ny * f / ma;
      b.vx -= nx * f / mb;
      b.vy -= ny * f / mb;
    }
  }
}

function applyForces(world: World, dt: number): void {
  const kS = (2 * Math.PI) / world.surfaceLength;
  const wS = (2 * Math.PI) / world.surfacePeriod;
  const kL = (2 * Math.PI) / world.swellLength;
  const wL = (2 * Math.PI) / world.swellPeriod;
  const kU = (2 * Math.PI) / world.updraftLength;
  const wU = (2 * Math.PI) / world.updraftPeriod;

  // Disturbance amplifies wind/wave/mixing forces. 1.0 baseline, up to 4x
  // during a peak storm. Only surface/swell/zStir/brownian get amplified;
  // gravity/drag are unchanged. surfaceActivity bundles the slow
  // irregularity envelope and the storm multiplier so wave physics,
  // the visible surface line, and aeration all move together.
  const act = surfaceActivity(world);
  const bAmp = world.brownianAmp * act;
  const surfAmp = world.surfaceAmp * act;
  const swellAmp = world.swellAmp * act;
  const zAmp = world.zStirAmp * act;
  const updraftEnv = Math.min(1, act);

  // Slow horizontal current: surface flows one way, deep flows the other.
  // The direction reverses very slowly so cells eventually have to cope
  // with both regimes.
  const colDepth = Math.max(1, world.height - world.surfaceY);
  const currentDrift = Math.sin(world.t * CURRENT_FREQ);
  const integrate = (
    o: { x: number; y: number; z: number; vx: number; vy: number; vz: number; r: number },
    density: number,
  ) => {
    const ay = world.gravity * (1 - 1 / density);
    // Surface ripple travels right; deeper swell travels left. The
    // counter-traveling pair stops particles from accumulating against
    // one wall the way a single right-moving wave train did.
    const depth = Math.max(0, o.y - world.surfaceY);
    // Standing waves: cos(k*x) * sin(w*t). Force at each x oscillates
    // in time but has zero time-average AND zero net horizontal
    // momentum, so particles bob locally instead of drifting toward
    // one wall. The same shape used to be a pair of traveling waves
    // counter-propagating; lowering swellAmp broke the balance and
    // everything piled up downstream of the dominant wave.
    const surface = surfAmp * Math.cos(kS * o.x) * Math.sin(wS * world.t) * Math.exp(-depth / world.surfaceDecay);
    const swell   = swellAmp * Math.cos(kL * o.x) * Math.sin(wL * world.t) * Math.exp(-depth / world.swellDecay);
    const az      = zAmp * Math.sin(wL * world.t + kL * o.x + 1.0) * Math.exp(-depth / world.swellDecay);
    // Vertical splash near the surface: 90deg-phased counterpart to the
    // horizontal standing wave. Particles in the top ~30px of the water
    // get strong upward kicks at wave peaks and downward pulls at
    // troughs, so the surface visibly chops + sprays instead of just
    // bobbing horizontally. Decays sharply with depth so the bulk water
    // column isn't affected.
    const splash = depth < SPLASH_DEPTH
      ? -surfAmp * SPLASH_GAIN * Math.sin(kS * o.x) * Math.cos(wS * world.t) * Math.exp(-depth / SPLASH_DEPTH)
      : 0;
    // Vertical mixing: gentle up/down currents that vary with x and time.
    // Negative ay = upward push, positive = downward. Full water column.
    const updraft = -world.updraftAmp * updraftEnv * Math.sin(kU * o.x + wU * world.t);
    // Slow horizontal current that depends on depth and drifts in time.
    // +1 at surface, -1 at bottom, multiplied by a slow time-oscillation.
    const depthFrac = depth / colDepth;
    const current = world.currentAmp * Math.cos(Math.PI * depthFrac) * currentDrift;
    // Per-tick zero-mean noise to break up any residual coherent drift.
    const noiseX = bAmp * (Math.random() - 0.5) * 2;
    const noiseY = bAmp * (Math.random() - 0.5) * 2;
    const ax = surface + swell + current + noiseX;
    const ayTot = ay + splash + updraft + noiseY;
    const dragScale = o.r / DRAG_REF_R;
    o.vx += (ax - world.drag * dragScale * o.vx) * dt;
    o.vy += (ayTot - world.drag * dragScale * o.vy) * dt;
    o.vz += (az - world.drag * dragScale * o.vz) * dt;
    o.x += o.vx * dt;
    o.y += o.vy * dt;
    o.z += o.vz * dt;
  };

  for (const p of world.particles) integrate(p, p.density ?? MATERIALS[p.material].density);
  for (const c of world.creatures) integrate(c, c.density);
}

const VM_SENSORS: VMSensors = {
  gradX: new Float32Array(6),
  gradY: new Float32Array(6),
  density: new Float32Array(6),
  wallX: 0, wallY: 0,
  headX: 0, headY: 0,
  temp: 0, pheromone: 0,
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
  // Dead/eaten tracked as Creature refs so subsequent passes don't have
  // to worry about array indices shifting underneath them.
  const dead: Creature[] = [];
  const eaten = new Set<Creature>();
  // Build per-tick spatial grids. Used by populateSensors (both creature
  // and particle scans), engulf/predation, creature-creature collisions,
  // and creature-sediment collisions. Replaces O(N) scans over world
  // particles/creatures inside per-cell loops with O(neighborhood) scans.
  buildCreatureGrid(world);
  rebuildSensorBins(world);
  for (let cIdx = 0; cIdx < n; cIdx++) {
    const c = world.creatures[cIdx];
    if (eaten.has(c)) continue;

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
    const ambientLight = Math.exp(-c.y / LIGHT_DECAY) * solarLight(world);
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
    // entire genome every second.
    let mutP = Math.min(0.02, SOMATIC_MUTATION_AGE_COEF * age * age * dt);
    // REPAIR (op 0x63) suppresses somatic mutation while repairTicks > 0.
    // Each REPAIR execution spends ATP and refreshes the window so a cell
    // can choose to invest energy into stability when it matters.
    if (c.repairTicks > 0) { mutP = 0; c.repairTicks--; }
    if (age > 0 && Math.random() < mutP) {
      c.genome = somaticMutateOnce(c.genome);
      // Sense range tracks the SENSE_AMP count in the live genome;
      // somatic mutation can add or remove amps, so recompute here.
      c.senseRange = computeSenseRange(c.genome);
      // Note: c.color is NOT updated on somatic drift. Cell keeps its
      // species' visual identity so phylogeny lane color === body color
      // across the population. Inheritance through fission is what
      // produces a new lineage and a new color.
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

    runTick(c.genome, c.vm, VM_SENSORS, VM_SELF, world.vmInstrBudget, VM_OUT);
    spendATP(c, VM_OUT.instructions * ENERGY_PER_INSTRUCTION);
    if (VM_OUT.repair > 0) {
      // Pay per-op so spamming REPAIR is expensive; refresh the window.
      // 30 ticks ~= 0.5 sim-sec at FIXED_DT 1/60, enough to span a
      // damage event without making the cell mutation-proof for life.
      const want = VM_OUT.repair * REPAIR_ATP_PER_OP;
      const paid = spendATP(c, want);
      if (paid > 0) c.repairTicks = Math.max(c.repairTicks, REPAIR_WINDOW_TICKS);
    }
    // Apply pending genome self-modifications after VM exits. SPLICE_*
    // changed length, which would invalidate PC mid-tick; we let the
    // rest of this tick's ops finish first, then resize here.
    if (VM_OUT.spliceMode !== 0 && VM_OUT.spliceLength > 0) {
      applyGenomeSplice(c, VM_OUT.spliceMode, VM_OUT.spliceOffset, VM_OUT.spliceLength);
    }
    // POKE_BYTE may have changed SENSE_AMP bytes; SPLICE may have too.
    // Recompute senseRange so it tracks the live program.
    c.senseRange = computeSenseRange(c.genome);

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

    // Pheromone emission: cell adds intensity to the field at its
    // position. Subsequent ticks decay + diffuse it.
    if (VM_OUT.emit > 0) {
      world.pheromone[pheromoneIndex(world, c.x, c.y)] += VM_OUT.emit;
    }

    // Adhesion: bond with the nearest creature in scanRange if not
    // already bonded. Cap each cell at MAX_BONDS to keep the spring
    // pass cheap and bounded.
    if (VM_OUT.adhere && c.bonds.length < MAX_BONDS) {
      let nearest: Creature | null = null;
      let bestSq = (c.r + 24) * (c.r + 24);
      forCreaturesNear(c.x, c.y, c.r + 24, (other) => {
        if (other === c || eaten.has(other) || c.bonds.includes(other) || other.bonds.length >= MAX_BONDS) return;
        const dx = other.x - c.x;
        const dy = other.y - c.y;
        const dsq = dx * dx + dy * dy;
        if (dsq < bestSq) { bestSq = dsq; nearest = other; }
      });
      if (nearest) {
        c.bonds.push(nearest);
        (nearest as Creature).bonds.push(c);
      }
    }

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
        forCreaturesNear(c.x, c.y, scanRange, (other) => {
          if (other === c || eaten.has(other)) return;
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
          eaten.add(other);
          ingested = true;
          return true;
        });
      }
      if (!ingested && VM_OUT.predate) {
        const myMass = creatureTotalMass(c);
        forCreaturesNear(c.x, c.y, scanRange, (other) => {
          if (other === c || eaten.has(other)) return;
          const dx = other.x - c.x;
          const dy = other.y - c.y;
          const dz = other.z - c.z;
          const minD = c.r + other.r;
          if (dx * dx + dy * dy + dz * dz >= minD * minD) return;
          const otherMass = creatureTotalMass(other);
          if (myMass < PREDATION_MASS_RATIO * Math.max(0.0001, otherMass)) return;
          const cost = PREDATION_ENERGY_BASE + PREDATION_ENERGY_PER_MASS * otherMass;
          if (c.energy < cost) return;
          for (let k = 0; k < 6; k++) {
            c.reserves[MATERIAL_IDS[k]] += other.reserves[MATERIAL_IDS[k]];
          }
          for (const mk of MOLECULE_IDS) c.molecules[mk] += other.molecules[mk];
          c.energy += other.energy;
          for (const inner of other.contents) c.contents.push(inner);
          other.contents.length = 0;
          spendATP(c, cost);
          c.ingestCooldown = PREDATION_COOLDOWN_SEC;
          eaten.add(other);
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
      dead.push(c);
    }
  }

  // Combined removal pass. dead = spilled, eaten = absorbed (no spill).
  // Build a survivors array in one O(N) pass instead of repeatedly
  // splicing (which is O(N) each).
  if (dead.length > 0 || eaten.size > 0) {
    const spillSet = new Set<Creature>(dead);
    const survivors: Creature[] = [];
    const released: Creature[] = [];
    for (const c of world.creatures) {
      if (spillSet.has(c) || eaten.has(c)) {
        for (const inner of c.contents) {
          inner.x = c.x + (Math.random() - 0.5) * Math.max(2, c.r);
          inner.y = c.y + (Math.random() - 0.5) * Math.max(2, c.r);
          inner.z = c.z;
          released.push(inner);
        }
        c.contents.length = 0;
        for (const partner of c.bonds) {
          const k = partner.bonds.indexOf(c);
          if (k >= 0) partner.bonds.splice(k, 1);
        }
        c.bonds.length = 0;
        if (spillSet.has(c)) releaseReservesAsParticles(c, world);
        noteCreatureDeath(world, c);
      } else {
        survivors.push(c);
      }
    }
    world.creatures.length = 0;
    for (const s of survivors) world.creatures.push(s);
    for (const r of released) world.creatures.push(r);
  }
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
  // Sexual reproduction (bonded crossover): if the parent currently has
  // any bonds, the child's pre-mutation genome is a single-crossover
  // recombinant of parent + random bond partner. Lets useful subprograms
  // flow between adjacent lineages. Falls through to plain asexual when
  // there are no bonds.
  let parentGenome = parent.genome;
  if (parent.bonds.length > 0) {
    const partner = parent.bonds[Math.floor(Math.random() * parent.bonds.length)];
    parentGenome = crossoverGenomes(parent.genome, partner.genome);
  }
  const childGenome = mutateGenome(parentGenome);
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
    senseRange: computeSenseRange(childGenome),
    thrustAccel: parent.thrustAccel,
    genome: childGenome,
    vm: newVMState(),
    color: genomeColor(childGenome, world.anchorGenome),
    ingestCooldown: INGEST_COOLDOWN_SEC,
    repairTicks: 0,
    bornAt: world.t,
    speciesKey: genomeKey(childGenome),
    division: null,
    contents: [],
    bonds: [],
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
  // Per-material gradient + density sampled from the prebuilt
  // SENSOR_BIN_* fields. Each cell visits a small 2D window of bins
  // around its position; each bin contributes (count, centroid)
  // weighted as if all its particles sit at the centroid.
  for (let i = 0; i < 6; i++) {
    VM_SENSORS.gradX[i] = 0;
    VM_SENSORS.gradY[i] = 0;
    VM_SENSORS.density[i] = 0;
  }
  const span = Math.ceil(range / SENSOR_BIN);
  let cbx = Math.floor(c.x / SENSOR_BIN);
  let cby = Math.floor(c.y / SENSOR_BIN);
  if (cbx < 0) cbx = 0; else if (cbx >= SENSOR_BIN_COLS) cbx = SENSOR_BIN_COLS - 1;
  if (cby < 0) cby = 0; else if (cby >= SENSOR_BIN_ROWS) cby = SENSOR_BIN_ROWS - 1;
  const x0 = Math.max(0, cbx - span);
  const x1 = Math.min(SENSOR_BIN_COLS - 1, cbx + span);
  const y0 = Math.max(0, cby - span);
  const y1 = Math.min(SENSOR_BIN_ROWS - 1, cby + span);
  for (let m = 0; m < 6; m++) {
    const cnt = SENSOR_BIN_COUNT[m];
    const sxArr = SENSOR_BIN_SUMX[m];
    const syArr = SENSOR_BIN_SUMY[m];
    let gx = 0, gy = 0, dens = 0;
    for (let by = y0; by <= y1; by++) {
      const row = by * SENSOR_BIN_COLS;
      for (let bx = x0; bx <= x1; bx++) {
        const bin = row + bx;
        const n = cnt[bin];
        if (n === 0) continue;
        const cx_bin = sxArr[bin] / n;
        const cy_bin = syArr[bin] / n;
        const dx = cx_bin - c.x;
        const dy = cy_bin - c.y;
        const dsq = dx * dx + dy * dy;
        if (dsq >= rangeSq || dsq < 1) continue;
        const w = range / dsq;
        gx += dx * w * n;
        gy += dy * w * n;
        dens += n;
      }
    }
    VM_SENSORS.gradX[m] = gx;
    VM_SENSORS.gradY[m] = gy;
    VM_SENSORS.density[m] = dens;
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
  VM_SENSORS.light = Math.exp(-c.y / LIGHT_DECAY) * solarLight(world);
  VM_SENSORS.temp = temperatureAt(world, c.x, c.y);
  VM_SENSORS.pheromone = world.pheromone[pheromoneIndex(world, c.x, c.y)];
  VM_SENSORS.creatureDx = 0;
  VM_SENSORS.creatureDy = 0;
  VM_SENSORS.creatureDist = range;
  VM_SENSORS.creatureMass = 0;
  let bestCreatureSq = rangeSq;
  forCreaturesNear(c.x, c.y, range, (other) => {
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
// Indices of buckets that received at least one particle this pass.
// Lets the resolve loop iterate only occupied cells (~30% of total at
// typical density) instead of every cell in the grid.
let COLLISION_NONEMPTY = new Int32Array(0);
let COLLISION_NONEMPTY_N = 0;
let COLLISION_MASS = new Float64Array(0);
// Per-particle "is asleep" flag, recomputed each call from quietTicks.
// Pair tests where both ends are asleep get skipped.
let COLLISION_ASLEEP = new Uint8Array(0);
const SLEEP_SPEED_SQ = 25;       // <5 px/s counts as still
const SLEEP_THRESHOLD_TICKS = 30; // ~half a sim-second before sleeping

// Creature spatial grid -- shared across sensor lookup, predation/engulf
// scans, and both creature-creature and creature-sediment collisions.
//
// Buckets hold Creature REFERENCES (not indices). updateCreatures
// splices dead/eaten creatures out of world.creatures before returning,
// which would otherwise invalidate every index in the grid before the
// collision passes run. Refs survive the splice; stale entries are
// harmless because we hold the object directly.
//
// Predation/engulf, which still need an "is this creature already
// dead-this-tick" check, pass a Set of in-flight victims to filter
// inside their visitor.
const CREATURE_GRID_CELL = 64;
const CREATURE_BUCKETS: Creature[][] = [];
// Indices of occupied creature buckets, refilled in buildCreatureGrid
// and reused by resolveCreatureCollisions so the collision loop iterates
// only the cells that actually hold creatures. At pop 200 in an 800x600
// world the grid has ~130 cells but typically < 50 are occupied.
let CREATURE_NONEMPTY = new Int32Array(0);
let CREATURE_NONEMPTY_N = 0;
let CREATURE_GRID_COLS = 0;
let CREATURE_GRID_ROWS = 0;

// Per-material particle moment field used by populateSensors. Built
// once per tick by rebuildSensorBins() and sampled by every cell.
// Avoids the previous "every cell re-walks every particle in its
// senseRange" cost which scaled as cells * particles_in_range.
//
// Each bin stores, per material: count, sumX, sumY. Cells approximate
// the bin's contribution to their gradient sensor by treating all
// the bin's particles as concentrated at the centroid (sumX/count,
// sumY/count). Coarse-grained but cheap.
const SENSOR_BIN = 40;
let SENSOR_BIN_COLS = 0;
let SENSOR_BIN_ROWS = 0;
const SENSOR_BIN_COUNT: Int32Array[] = [];   // [material][bin]
const SENSOR_BIN_SUMX: Float32Array[] = [];
const SENSOR_BIN_SUMY: Float32Array[] = [];
let SENSOR_BIN_ALLOC = 0;

function rebuildSensorBins(world: World): void {
  SENSOR_BIN_COLS = Math.max(1, Math.ceil(world.width / SENSOR_BIN));
  SENSOR_BIN_ROWS = Math.max(1, Math.ceil(world.height / SENSOR_BIN));
  const n = SENSOR_BIN_COLS * SENSOR_BIN_ROWS;
  if (n > SENSOR_BIN_ALLOC) {
    SENSOR_BIN_COUNT.length = 0;
    SENSOR_BIN_SUMX.length = 0;
    SENSOR_BIN_SUMY.length = 0;
    const alloc = n * 2;
    for (let m = 0; m < 6; m++) {
      SENSOR_BIN_COUNT.push(new Int32Array(alloc));
      SENSOR_BIN_SUMX.push(new Float32Array(alloc));
      SENSOR_BIN_SUMY.push(new Float32Array(alloc));
    }
    SENSOR_BIN_ALLOC = alloc;
  } else {
    for (let m = 0; m < 6; m++) {
      SENSOR_BIN_COUNT[m].fill(0, 0, n);
      SENSOR_BIN_SUMX[m].fill(0, 0, n);
      SENSOR_BIN_SUMY[m].fill(0, 0, n);
    }
  }
  const ps = world.particles;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    let bx = Math.floor(p.x / SENSOR_BIN);
    let by = Math.floor(p.y / SENSOR_BIN);
    if (bx < 0) bx = 0; else if (bx >= SENSOR_BIN_COLS) bx = SENSOR_BIN_COLS - 1;
    if (by < 0) by = 0; else if (by >= SENSOR_BIN_ROWS) by = SENSOR_BIN_ROWS - 1;
    const idx = MATERIAL_INDEX[p.material];
    const bin = by * SENSOR_BIN_COLS + bx;
    SENSOR_BIN_COUNT[idx][bin]++;
    SENSOR_BIN_SUMX[idx][bin] += p.x;
    SENSOR_BIN_SUMY[idx][bin] += p.y;
  }
}


function buildCreatureGrid(world: World): void {
  const ccs = CREATURE_GRID_CELL;
  CREATURE_GRID_COLS = Math.max(1, Math.ceil(world.width / ccs));
  CREATURE_GRID_ROWS = Math.max(1, Math.ceil(world.height / ccs));
  const cellCount = CREATURE_GRID_COLS * CREATURE_GRID_ROWS;
  while (CREATURE_BUCKETS.length < cellCount) CREATURE_BUCKETS.push([]);
  if (CREATURE_NONEMPTY.length < cellCount) CREATURE_NONEMPTY = new Int32Array(cellCount * 2);
  // Clear only the buckets that were filled last build, not the whole grid.
  for (let i = 0; i < CREATURE_NONEMPTY_N; i++) CREATURE_BUCKETS[CREATURE_NONEMPTY[i]].length = 0;
  CREATURE_NONEMPTY_N = 0;
  const cs = world.creatures;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    let cx = Math.floor(c.x / ccs);
    let cy = Math.floor(c.y / ccs);
    // NaN/Inf safety: comparison ops on NaN are always false, so the
    // clamp below misses them. Catch explicitly and dump such cells
    // into bucket (0, 0) -- they'd otherwise pop into BUCKETS[NaN] and
    // crash the frame loop.
    if (!Number.isFinite(cx)) cx = 0;
    if (!Number.isFinite(cy)) cy = 0;
    if (cx < 0) cx = 0; else if (cx >= CREATURE_GRID_COLS) cx = CREATURE_GRID_COLS - 1;
    if (cy < 0) cy = 0; else if (cy >= CREATURE_GRID_ROWS) cy = CREATURE_GRID_ROWS - 1;
    const idx = cy * CREATURE_GRID_COLS + cx;
    const bucket = CREATURE_BUCKETS[idx];
    if (bucket.length === 0) CREATURE_NONEMPTY[CREATURE_NONEMPTY_N++] = idx;
    bucket.push(c);
  }
}

// Iterate creature indices that might be within `range` of (x, y). The
// visitor may return true to stop iteration early (e.g. when a predator
// finds its first valid prey). Skips buckets outside the search radius.
function forCreaturesNear(
  x: number, y: number, range: number,
  visitor: (c: Creature) => boolean | void,
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
  if (COLLISION_NONEMPTY.length < cellCount) COLLISION_NONEMPTY = new Int32Array(cellCount * 2);
  if (COLLISION_ASLEEP.length < n) COLLISION_ASLEEP = new Uint8Array(n * 2);

  for (let i = 0; i < n; i++) {
    const p = ps[i];
    COLLISION_MASS[i] = mass(p);
    const v2 = p.vx * p.vx + p.vy * p.vy + p.vz * p.vz;
    if (v2 < SLEEP_SPEED_SQ) {
      const q = (p.quietTicks || 0) + 1;
      p.quietTicks = q;
      COLLISION_ASLEEP[i] = q >= SLEEP_THRESHOLD_TICKS ? 1 : 0;
    } else {
      p.quietTicks = 0;
      COLLISION_ASLEEP[i] = 0;
    }
  }

  for (let pass = 0; pass < world.collisionIters; pass++) {
    // Clear only the buckets we filled last pass, not the whole grid.
    for (let i = 0; i < COLLISION_NONEMPTY_N; i++) COLLISION_BUCKETS[COLLISION_NONEMPTY[i]].length = 0;
    COLLISION_NONEMPTY_N = 0;
    for (let pi = 0; pi < n; pi++) {
      const p = ps[pi];
      let cx = Math.floor(p.x / cellSize);
      let cy = Math.floor(p.y / cellSize);
      if (cx < 0) cx = 0; else if (cx >= cols) cx = cols - 1;
      if (cy < 0) cy = 0; else if (cy >= rows) cy = rows - 1;
      const idx = cy * cols + cx;
      const bucket = COLLISION_BUCKETS[idx];
      if (bucket.length === 0) {
        COLLISION_NONEMPTY[COLLISION_NONEMPTY_N++] = idx;
      }
      bucket.push(pi);
    }

    for (let k = 0; k < COLLISION_NONEMPTY_N; k++) {
      const idx = COLLISION_NONEMPTY[k];
      const cell = COLLISION_BUCKETS[idx];
      const cl = cell.length;
      const cy = (idx / cols) | 0;
      const cx = idx - cy * cols;
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

// Soft positional separation for overlapping creatures + symmetric
// velocity exchange like the particle-particle code, but driven off
// the per-tick CREATURE_BUCKETS grid. Without this cells walk through
// each other (only PREDATE/ENGULF cared about contact) and you can't
// see flocking, body-shielding, or crowding pressure emerge.
function resolveCreatureCollisions(world: World): void {
  const n = world.creatures.length;
  if (n < 2) return;
  const e = 0.1;
  const cols = CREATURE_GRID_COLS;
  const rows = CREATURE_GRID_ROWS;
  // Iterate only the buckets we filled, not the whole grid -- most
  // cells are empty at pop ~200 in a 130-cell grid.
  for (let k = 0; k < CREATURE_NONEMPTY_N; k++) {
    const idx = CREATURE_NONEMPTY[k];
    const cell = CREATURE_BUCKETS[idx];
    const cl = cell.length;
    if (cl === 0) continue;
    const gy = (idx / cols) | 0;
    const gx = idx - gy * cols;
    for (let i = 0; i < cl; i++) {
      const ai = cell[i];
      for (let j = i + 1; j < cl; j++) resolveCreaturePair(ai, cell[j], e);
    }
    if (gx + 1 < cols)             checkCreaturePairs(cell, gy * cols + gx + 1, e);
    if (gy + 1 < rows && gx > 0)   checkCreaturePairs(cell, (gy + 1) * cols + gx - 1, e);
    if (gy + 1 < rows)             checkCreaturePairs(cell, (gy + 1) * cols + gx, e);
    if (gy + 1 < rows && gx + 1 < cols) checkCreaturePairs(cell, (gy + 1) * cols + gx + 1, e);
  }
}

function checkCreaturePairs(
  cell: Creature[], otherIdx: number, e: number,
): void {
  const nb = CREATURE_BUCKETS[otherIdx];
  const nl = nb.length;
  if (nl === 0) return;
  const cl = cell.length;
  for (let i = 0; i < cl; i++) {
    const ai = cell[i];
    for (let j = 0; j < nl; j++) resolveCreaturePair(ai, nb[j], e);
  }
}

function resolveCreaturePair(a: Creature, b: Creature, e: number): void {
  if (a === b) return;
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
  // Mass divisor clamped so a pathological zero-mass cell can't NaN out
  // the world by producing Infinity/0 = NaN velocities downstream.
  const ma = Math.max(0.01, creatureTotalMass(a));
  const mb = Math.max(0.01, creatureTotalMass(b));
  const total = ma + mb;
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

// Sediment particles (rock, sand) act as solid terrain: cells can't
// phase through the seafloor. Clay stays permeable so cells can ingest
// it. INGEST runs earlier in the tick, so a cell whose genome fires
// INGEST on a rock/sand at contact still consumes the particle before
// this bounce runs.
const SEDIMENT_MATERIALS = new Set<MaterialId>(["rock", "sand"]);
function resolveCreatureSedimentCollisions(world: World): void {
  const ps = world.particles;
  const cs = world.creatures;
  if (cs.length === 0) return;
  for (let pi = 0; pi < ps.length; pi++) {
    const p = ps[pi];
    if (!SEDIMENT_MATERIALS.has(p.material)) continue;
    const range = p.r + 30;
    forCreaturesNear(p.x, p.y, range, (c) => {
      let dx = c.x - p.x;
      let dy = c.y - p.y;
      let dz = c.z - p.z;
      const minD = c.r + p.r;
      const dsq = dx * dx + dy * dy + dz * dz;
      if (dsq >= minD * minD) return;
      let dist = Math.sqrt(dsq);
      if (dist < 1e-6) { dx = 0; dy = -1; dz = 0; dist = 1; }
      const nx = dx / dist;
      const ny = dy / dist;
      const nz = dz / dist;
      const overlap = minD - dist;
      const pm = Math.max(0.01, mass(p));
      const cm = Math.max(0.01, creatureTotalMass(c));
      const total = pm + cm;
      const cShare = pm / total;
      const pShare = cm / total;
      c.x += nx * overlap * cShare;
      c.y += ny * overlap * cShare;
      c.z += nz * overlap * cShare;
      p.x -= nx * overlap * pShare;
      p.y -= ny * overlap * pShare;
      p.z -= nz * overlap * pShare;
      const rvx = c.vx - p.vx;
      const rvy = c.vy - p.vy;
      const rvz = c.vz - p.vz;
      const vN = rvx * nx + rvy * ny + rvz * nz;
      if (vN >= 0) return;
      const e = 0.2;
      const jImp = (-(1 + e) * vN) / (1 / cm + 1 / pm);
      const ix = nx * jImp;
      const iy = ny * jImp;
      const iz = nz * jImp;
      c.vx += ix / cm;
      c.vy += iy / cm;
      c.vz += iz / cm;
      p.vx -= ix / pm;
      p.vy -= iy / pm;
      p.vz -= iz / pm;
    });
  }
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
  if (COLLISION_ASLEEP[i] && COLLISION_ASLEEP[j]) return;
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
