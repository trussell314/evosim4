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
  molecules: Molecules;
  energy: number;       // ATP. Spent operations turn it into molecules.adp.
  senseRange: number;
  thrustAccel: number;
  genome: Uint8Array;
  vm: VMState;
  color: string;
  ingestCooldown: number;
  reproduceCooldown: number;
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
  restitution: number;
  xWallRestitution: number;
  zWallRestitution: number;
  collisionIters: number;
  species: Map<string, Species>;
  phylogenyEvents: PhylogenyEvent[];
  nextSpeciesLane: number;
}

const ENERGY_PER_THRUST_SEC = 22;
const ENERGY_PER_INSTRUCTION = 0.02;
const VM_INSTR_BUDGET = 32;

const MASS_PER_GENOME_BYTE = 3;
const PARTICLE_DENSITY_PER_AREA = 11000 / (800 * 600);
const PARTICLE_SPAWN_RATIO = 90 / 550;
const MAX_CREATURES = 80;
const REPRODUCE_COOLDOWN_SEC = 2;

const INGEST_ENERGY_COST = 1.5;
const INGEST_COOLDOWN_SEC = 0.35;
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
const BASE_METABOLIC_PER_MASS = 0.005;
const DEATH_RELEASE_R_MIN = 1.2;
const DEATH_RELEASE_SCATTER = 30;

// Thrust energy scaling. THRUST_MASS_REF=50 ~= the starting cell mass
// (organic=40 + lipid=10), so a fresh cell's thrust cost matches the prior
// flat rate; bigger cells pay linearly more to move themselves through fluid.
const THRUST_MASS_REF = 50;

// Photosynthesis depth attenuation: ambient light = exp(-y / LIGHT_DECAY).
// Surface = 1.0, e-folds every LIGHT_DECAY pixels of depth.
const LIGHT_DECAY = 250;

const DRAG_REF_R = 4;
const MIN_CREATURE_R = 4;

// ----- chemistry constants -----
//
// Catabolism rate (per-material breakdown into molecules). Mass per second
// at the cell. Mass fractions in CATAB_FRACTIONS must sum to 1 per row so
// material -> molecules conversion is mass-conserving.
const CATAB_RATE_PER_MASS = 0.6;
const CATAB_KM = 4;

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
const AEROBIC_VMAX = 8;     // glucose-mass consumed per sec per cell at saturation
const FERMENT_VMAX = 1.5;
const BETAOX_VMAX = 4;      // fatty-acid mass per sec
const PHOTO_VMAX_PER_R = 1.2;   // photosynth scales with surface (~r)
const CHLORO_SYNTH_VMAX = 0.05;
const ENZYME_SYNTH_VMAX = 0.1;
const BIOMASS_GROW_VMAX = 0.2;

// Auto-excretion: once internal CO2 / waste crosses these thresholds, the
// cell dumps the excess back to the world as particles (mass-conserving).
const CO2_EXCRETE_THRESHOLD = 6;
const WASTE_EXCRETE_THRESHOLD = 3;
const EXCRETE_FLOOR = 1;

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
    swellAmp: 22, swellLength: 820, swellPeriod: 8.5, swellDecay: 520,
    zStirAmp: 9,
    restitution: 0.15, xWallRestitution: 0.4, zWallRestitution: 0.6,
    collisionIters: 2,
    species: new Map(),
    phylogenyEvents: [],
    nextSpeciesLane: 0,
  };
  seedParticles(world, Math.round(particleTarget * 0.9));
  const first = makeCreature(world.width * 0.5, world.height * 0.3, world.depth * 0.5);
  world.creatures.push(first);
  noteCreatureBirth(world, first, undefined);
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
  const molecules = emptyMolecules();
  // Starter cell ships with a working metabolism: enough ATP to live, a
  // matched ADP pool, some glucose and O2 to run respiration, a little
  // amino-acid / minerals / fatty-acid for biosynthesis and movement,
  // and biomass to give it physical body. No undigested food yet.
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
    reproduceCooldown: 0,
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
  const sp = world.species.get(genomeKey(c.genome));
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
  for (const id of MATERIAL_IDS) {
    const avail = c.reserves[id];
    if (avail <= 0) continue;
    const rate = CATAB_RATE_PER_MASS * sat(avail, CATAB_KM);
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

// Aerobic respiration: 1 glu + 1 o2 + 6 adp -> 2 co2 + 6 atp.
function aerobicRespire(c: Creature, dt: number): void {
  const m = c.molecules;
  if (m.glucose <= 0 || m.o2 <= 0 || m.adp <= 0) return;
  const rate = AEROBIC_VMAX * sat(m.glucose) * sat(m.o2) * sat(m.adp / 6);
  const amt = Math.min(rate * dt, m.glucose, m.o2, m.adp / 6);
  if (amt <= 0) return;
  m.glucose -= amt;
  m.o2 -= amt;
  m.co2 += 2 * amt;
  m.adp -= 6 * amt;
  c.energy += 6 * amt;
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
  // CO2 vented as gas particles.
  if (c.molecules.co2 > CO2_EXCRETE_THRESHOLD) {
    const amt = c.molecules.co2 - EXCRETE_FLOOR;
    c.molecules.co2 = EXCRETE_FLOOR;
    spawnExcretedParticle(c, world, "gas", amt);
  }
  // Toxic waste vented as organic particles (decomposer-friendly).
  if (c.molecules.waste > WASTE_EXCRETE_THRESHOLD) {
    const amt = c.molecules.waste - EXCRETE_FLOOR;
    c.molecules.waste = EXCRETE_FLOOR;
    spawnExcretedParticle(c, world, "organic", amt);
  }
}

function spawnExcretedParticle(c: Creature, world: World, material: MaterialId, m: number): void {
  if (m < EXCRETE_MIN_AMOUNT) {
    // Round-off; just drop it on the floor of the cell (lose to environment).
    return;
  }
  const density = MATERIALS[material].density;
  const pr = Math.max(1.5, Math.sqrt(m / (density * Math.PI)));
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
  });
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
  if (world.creatures.length === 0) {
    const x = world.width * (0.1 + 0.8 * Math.random());
    const y = world.height * (0.1 + 0.6 * Math.random());
    const z = world.depth * 0.5;
    const seed = makeCreature(x, y, z);
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
    o: { x: number; y: number; z: number; vx: number; vy: number; vz: number; r: number },
    density: number,
  ) => {
    const ay = world.gravity * (1 - 1 / density);
    const surface = world.surfaceAmp * Math.sin(kS * o.x - wS * world.t) * Math.exp(-o.y / world.surfaceDecay);
    const swell   = world.swellAmp   * Math.sin(kL * o.x - wL * world.t) * Math.exp(-o.y / world.swellDecay);
    const az      = world.zStirAmp   * Math.sin(wL * world.t + kL * o.x + 1.0) * Math.exp(-o.y / world.swellDecay);
    const ax = surface + swell;
    const dragScale = o.r / DRAG_REF_R;
    o.vx += (ax - world.drag * dragScale * o.vx) * dt;
    o.vy += (ay - world.drag * dragScale * o.vy) * dt;
    o.vz += (az - world.drag * dragScale * o.vz) * dt;
    o.x += o.vx * dt;
    o.y += o.vy * dt;
    o.z += o.vz * dt;
  };

  for (const p of world.particles) integrate(p, MATERIALS[p.material].density);
  for (const c of world.creatures) integrate(c, c.density);
}

const VM_SENSORS: VMSensors = {
  dx: new Float32Array(6),
  dy: new Float32Array(6),
  dist: new Float32Array(6),
  creatureDx: 0, creatureDy: 0, creatureDist: 0, creatureMass: 0,
  light: 0,
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

    updateCreatureRadius(c);

    // Cost of being alive. ATP turns into ADP, mass conserved.
    const idleDrain = (BASE_METABOLIC_DRAIN + BASE_METABOLIC_PER_MASS * creatureTotalMass(c)) * dt;
    spendATP(c, idleDrain);

    // Bulk -> molecules.
    catabolize(c, dt);

    // Energy production. All three pathways may run in parallel; rates
    // self-balance via substrate availability (Michaelis-Menten).
    aerobicRespire(c, dt);
    ferment(c, dt);
    betaOxidize(c, dt);

    // Carbon fixation if the cell has chlorophyll and reaches light.
    const ambientLight = Math.exp(-c.y / LIGHT_DECAY);
    photosynthesize(c, dt, ambientLight);

    // Cell builds its own catalysts and structure as substrates allow.
    biosynthesize(c, dt, CHLORO_SYNTH_VMAX, 0.5, "aminoAcid", 0.5, "minerals", "chlorophyll");
    biosynthesize(c, dt, ENZYME_SYNTH_VMAX, 0.5, "aminoAcid", 0.5, "minerals", "enzyme");
    biosynthesize(c, dt, BIOMASS_GROW_VMAX, 0.7, "aminoAcid", 0.3, "fattyAcid", "biomass");

    // Vent CO2 / waste back to the world if accumulating.
    autoExcrete(c, world);

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
    spendATP(c, VM_OUT.instructions * ENERGY_PER_INSTRUCTION);

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
      // Thrust ATP cost scales linearly with mass.
      const massScale = Math.max(1, creatureTotalMass(c) / THRUST_MASS_REF);
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
    if (c.reproduceCooldown > 0) {
      c.reproduceCooldown = Math.max(0, c.reproduceCooldown - dt);
    }

    if (c.ingestCooldown <= 0 && c.energy >= INGEST_ENERGY_COST) {
      let ingested = false;
      if (VM_OUT.predate) {
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
          const cost = PREDATION_ENERGY_BASE + PREDATION_ENERGY_PER_MASS * otherMass;
          if (c.energy < cost) continue;
          // Engulf: take everything the prey was carrying.
          for (let k = 0; k < 6; k++) {
            c.reserves[MATERIAL_IDS[k]] += other.reserves[MATERIAL_IDS[k]];
          }
          for (const mk of MOLECULE_IDS) {
            c.molecules[mk] += other.molecules[mk];
          }
          c.energy += other.energy;
          spendATP(c, cost);
          c.ingestCooldown = PREDATION_COOLDOWN_SEC;
          eaten.add(j);
          ingested = true;
          break;
        }
      }
      if (!ingested) {
        for (let i = world.particles.length - 1; i >= 0; i--) {
          const p = world.particles[i];
          const dx = p.x - c.x;
          const dy = p.y - c.y;
          const dz = p.z - c.z;
          if (dx * dx + dy * dy + dz * dz < c.r * c.r) {
            c.reserves[p.material] += mass(p);
            spendATP(c, INGEST_ENERGY_COST);
            c.ingestCooldown = INGEST_COOLDOWN_SEC * (INGEST_REF_R / Math.max(INGEST_REF_R, c.r));
            world.particles.splice(i, 1);
            break;
          }
        }
      }
    }

    updateCreatureRadius(c);

    // Death: no ATP and no way to make more (no fuel in either reserves
    // or already-broken-down molecule pool).
    if (c.energy <= 0 && noFuel(c)) {
      dead.push(cIdx);
    }
  }

  const removed: { idx: number; spill: boolean }[] = [];
  for (const idx of dead) removed.push({ idx, spill: true });
  for (const idx of eaten) removed.push({ idx, spill: false });
  removed.sort((a, b) => b.idx - a.idx);
  for (const r of removed) {
    const victim = world.creatures[r.idx];
    if (r.spill) releaseReservesAsParticles(victim, world);
    noteCreatureDeath(world, victim);
    world.creatures.splice(r.idx, 1);
  }
}

function releaseReservesAsParticles(c: Creature, world: World): void {
  // On death the cell's entire contents return to the environment. Reserves
  // dump as their own material; molecules map to the closest material
  // (organics back to organic, gases to gas, minerals to sand).
  const per: Record<MaterialId, number> = {
    rock: 0, sand: 0, clay: 0, organic: 0, lipid: 0, gas: 0,
  };
  for (const id of MATERIAL_IDS) per[id] += c.reserves[id];
  const m = c.molecules;
  per.organic += m.glucose + m.fattyAcid + m.aminoAcid + m.biomass
               + m.chlorophyll + m.enzyme + m.waste + m.adp + c.energy;
  per.gas += m.o2 + m.co2;
  per.sand += m.minerals;

  for (const matId of MATERIAL_IDS) {
    let remaining = per[matId];
    if (remaining < 0.5) continue;
    const density = MATERIALS[matId].density;
    while (remaining > 0.5) {
      let r = 2 + Math.random() * 2;
      let mp = density * Math.PI * r * r;
      if (mp > remaining) {
        r = Math.max(DEATH_RELEASE_R_MIN, Math.sqrt(remaining / (density * Math.PI)));
        mp = density * Math.PI * r * r;
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
  // Split the remaining reserves and the molecular pool 50/50 with the
  // child so it can metabolize from birth.
  const orgGift = parent.reserves.organic * 0.5;
  parent.reserves.organic -= orgGift;
  childReserves.organic += orgGift;
  const childMolecules = emptyMolecules();
  for (const mk of MOLECULE_IDS) {
    const half = parent.molecules[mk] * 0.5;
    parent.molecules[mk] -= half;
    childMolecules[mk] = half;
  }
  const energyGift = parent.energy * 0.5;
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
    color: genomeColor(childGenome),
    ingestCooldown: INGEST_COOLDOWN_SEC,
    reproduceCooldown: REPRODUCE_COOLDOWN_SEC,
  };
  updateCreatureRadius(child);
  parent.reproduceCooldown = REPRODUCE_COOLDOWN_SEC;
  world.creatures.push(child);
  noteCreatureBirth(world, child, genomeKey(parent.genome));
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
  VM_SENSORS.light = Math.exp(-c.y / LIGHT_DECAY);
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
  let m = c.energy; // ATP is a real molecule and contributes to mass.
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
      if (o.y - o.r < 0) { o.y = o.r; if (o.vy < 0) o.vy = 0; }
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
