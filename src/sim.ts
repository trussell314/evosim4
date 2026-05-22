// Pure simulation. No DOM access.
//
// Units: pixels for length, seconds for time.
// World is "basically 2D" — a thin z-slice so particles can shift back/forth
// in depth and occasionally pass each other in z. Water density = 1.

import {
  type VMSensors,
  type VMSelf,
  type VMOutputs,
  newVMState,
  runTick,
  makeRandomViableGenome,
  genomeSynthMask,
  genomeCodingKey,
  walkGenome,
  OP,
  mutateGenome,
  CATALYST_COUNT,
  N_REACTIONS,
  somaticMutateOnce,
  computeSenseRange,
  computeThrustAccel,
  SYNTH_BIT_BOND,
  SYNTH_BIT_COMPETENCE,
  SYNTH_BIT_PACKAGE,
  appendGenomeBytes,
  GENE_FRAGMENT_CAP,
} from "./genome";
import { mulberry32, mixHash, hashUnit } from "./rng";
import { genomeTag, genomeKey, genomeDistance, genomeColor } from "./genome-id";
export { genomeTag, genomeKey, genomeDistance, genomeColor };
import {
  RX_MAINT_MEMBRANE, RX_MAINT_ENZ, RX_MAINT_CHL, RX_MAINT_MRNA,
  RX_MAINT_RECEPTOR, RX_MAINT_CATALYST, RX_TOXIFY, RX_DEATH_CATDENATURE,
  RX_DENATURE_WASTE, RX_SYNTH_CATALYST, RX_BIOGENESIS, RX_THERMAL_DENATURE,
  NREACT, RX_LOC_CELL, RX_LOC_FIELD, rxIdx,
  ATP_IDLE, ATP_VM, ATP_THRUST, ATP_EXCRETE, ATP_INGEST, ATP_ENGULF,
  ATP_PREDATE, ATP_REPRODUCE, ATP_RXN_ENDO, ATP_RXN_EXO, ATP_OTHER,
} from "./sim/rxn-ids";
import type { RxnWindow } from "./sim/rxn-stats";
import {
  type RxnStats, type SavedRxnStats, newRxnStats,
  serializeRxnStats, deserializeRxnStats, reactionWindowSeries,
} from "./sim/rxn-stats";
export {
  type RxnStats, type SavedRxnStats,
  serializeRxnStats, deserializeRxnStats, reactionWindowSeries,
};
import {
  type Molecules, MOLECULE_IDS, MOLECULE_INDEX, emptyMolecules,
  CHEMICAL_COUNT, NAMED_CHEMICAL_COUNT, GENERIC_CHEMICAL_COUNT,
  NAMED_CHEMICALS,
  CHEM_O2, CHEM_CO2, CHEM_GLU, CHEM_AA, CHEM_FA, CHEM_MIN, CHEM_ADP,
  CHEM_WASTE, CHEM_CHL, CHEM_ENZ, CHEM_MRNA, CHEM_BIOPOLYMER,
  CHEM_MEMBRANE,
  CHEM_PHOTORECEPTOR_VISIBLE, CHEM_PHOTORECEPTOR_LONG,
  CHEM_PHOTORECEPTOR_SURFACE, CHEM_ACT_PHOTO_VISIBLE,
  CHEM_ACT_PHOTO_LONG, CHEM_ACT_PHOTO_SURFACE,
  CHEM_MECHANORECEPTOR, CHEM_ACT_MECH_X, CHEM_ACT_MECH_Y,
  CHEM_THERMORECEPTOR, CHEM_ACT_THERMO,
  CHEM_MAGNETORECEPTOR, CHEM_ACT_MAG_X, CHEM_ACT_MAG_Y,
  CHEM_BOND, CHEM_REPAIR, CHEM_MARKER0,
  MRNA_REF, CHL_REF, ENZ_REF,
} from "./sim/chem-ids";
export {
  type Molecules, MOLECULE_IDS, emptyMolecules,
  NAMED_CHEMICAL_COUNT, NAMED_CHEMICALS,
};
import {
  type ChemPhase, type ChemRole, type ChemicalDef,
  GENERIC_SPAWN_ORDER, CHEMICALS, CHEM_BASE_DENSITY, CHEM_MM,
  CHEM_COLORS, CHEM_NAMES, CHEM_MOLAR_MASS,
  CHEM_IDS, SENSOR_CHEMS, CHEM_BOND_POTENTIAL,
} from "./sim/chemistry";
export {
  type ChemPhase, type ChemRole, type ChemicalDef,
  CHEM_BASE_DENSITY, CHEM_COLORS, CHEM_NAMES, CHEM_MOLAR_MASS, CHEM_IDS,
};
import {
  REACTIONS, NAMED_REACTION_COUNT,
  TRANSPORT_SLOT_BASE, TRANSPORT_CHEM_IDS, TRANSPORT_TARGETS, TRANSPORT_ATP,
  TRANSPORT_ATP_SLOT,
} from "./sim/reactions";
export { TRANSPORT_SLOT_BASE, TRANSPORT_CHEM_IDS, TRANSPORT_ATP_SLOT };
export { NAMED_REACTION_COUNT };
import {
  SENSOR_CHEM_LABELS, CHEM_SHORT_LABELS, chemName,
  NAMED_REACTION_NAMES, reactionName,
} from "./sim/labels";
export {
  SENSOR_CHEM_LABELS, CHEM_SHORT_LABELS, chemName,
  NAMED_REACTION_NAMES, reactionName,
};
import { type WorldProfile, makeProfile, resetProfile } from "./sim/profile";
export { type WorldProfile, makeProfile, resetProfile };

// Phase D of the chemistry overhaul: free-floating particles carry a
// single chem id (uint8 into the chemical table) instead of a string
// material label. The legacy MaterialId union, MATERIALS dict, and
// material-density LUT are gone; their roles are absorbed by the chem
// table and the SPAWN_CHEM_SPECS roster below. The pebble-sized
// mineral grain bed that used to form the seafloor has also been
// retired -- the floor is now static rocky terrain (see
// generateObstacles / buildTerrainBitmap).
// === Engine core (stores, value classes, World/Species types) lives
// in ./sim/core -- imported for internal use + re-exported below. ===
export * from "./sim/core";
import {
  type ObstacleLobe, type Obstacle,
  type Species, type PhylogenyEvent, type World, type EDnaCarrier,
  ParticleStore, Particle, CreatureStore, Creature,
  pushParticle, removeParticleAt, newCreature,
  resetCreatureIdCounter, setParticleSlotReusedHook,
  PARTICLE_STORE_PREALLOC_CAP, CREATURE_STORE_PREALLOC_CAP,
} from "./sim/core";
import { ROCK_POLYGONS, VENT_ORIGIN, scalePolygon } from "./sim/terrain-shapes";
import { makeVentState, stepVent, VENT_EMISSION_CHEMS } from "./sim/vent";
import { VENT_FUEL_CHEMS } from "./sim/chemolith";

// WorldProfile + makeProfile/resetProfile live in ./sim/profile
// (imported + re-exported at the top of this file).

const ENERGY_PER_THRUST_SEC = 5;
const ENERGY_PER_INSTRUCTION = 0.0005;
// VM ops per tick per creature. 8 keeps frame cost reasonable at high
// population. Tests override via world.vmInstrBudget when they need to
// see the whole default-genome program execute in one step.
// 8 instructions/tick. (Briefly raised to 16 to offset gene-framing
// scan/codon overhead, but reverted to 8 for per-step performance --
// framed genomes just cycle their genes over a few more ticks.)
const DEFAULT_VM_INSTR_BUDGET = 8;

// Initial particle cap for a fresh world. Fixed (not area-scaled) so the
// steady-state particle budget is predictable and user-adjustable at
// runtime via setParticleTarget(). Resizing the window no longer
// recomputes it.
const INITIAL_PARTICLE_TARGET = 2500;
// Bounds + step for runtime cap adjustment. Max stays well under
// PARTICLE_STORE_PREALLOC_CAP so the over-cap headroom never overflows
// the preallocated store.
export const PARTICLE_TARGET_MIN = 500;
const PARTICLE_TARGET_MAX = 50000;
export const PARTICLE_TARGET_STEP = 500;
const PARTICLE_SPAWN_RATIO = (90 / 550) * 0.5;
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
  // particleTarget is a fixed/user-controlled budget now -- a window
  // resize must not silently rescale it. Spawn rate still follows the
  // current target.
  world.particleSpawnRate = Math.min(MAX_SPAWN_PER_SEC, Math.max(5, world.particleTarget * PARTICLE_SPAWN_RATIO));
}

// Runtime particle-cap setter. Clamps to [MIN, MAX] and resyncs the
// spawn rate. Excess/shortage is reconciled by the normal per-tick
// reserve passes (demote to reserve / promote from reserve), so no
// special migration is needed here.
export function setParticleTarget(world: World, cap: number): void {
  const c = Math.max(
    PARTICLE_TARGET_MIN,
    Math.min(PARTICLE_TARGET_MAX, Math.round(cap)),
  );
  world.particleTarget = c;
  world.particleSpawnRate = Math.min(
    MAX_SPAWN_PER_SEC,
    Math.max(5, c * PARTICLE_SPAWN_RATIO),
  );
}
// No soft population ceiling: the hard limit IS the CreatureStore
// allocation size. Reproduction/spawn is refused only when the store
// is physically full (see CreatureStore.canAlloc), not at some lower
// tuned number.
const MAX_CREATURES = CREATURE_STORE_PREALLOC_CAP;

const INGEST_ENERGY_COST = 1.5;
const INGEST_COOLDOWN_SEC = 0.15;
// Ingestion is rate-limited by membrane area: a bigger cell has more surface
// through which to absorb, so its post-ingest cooldown shrinks proportionally
// (cooldown / (r / INGEST_REF_R)). Below INGEST_REF_R the cooldown stays at
// the baseline so tiny cells aren't accidentally penalized.
const INGEST_REF_R = 4;
const EXCRETE_MIN_AMOUNT = 0.5;

// Predation/engulfment is gated by the cells' PHYSICAL nature, not an
// abstract mass score. The attacker must be physically larger (you
// can't wrap or rupture a cell wider than you), and the target's
// structural membrane is armor (you can't breach a cell whose
// envelope is sturdier than your own). 1.14 ~= the old 1.5 mass
// ratio expressed in radius (r proportional to mass^(1/3)), so the
// ecosystem balance is preserved while the criterion becomes
// physical. Both "grow bigger" and "build a tougher envelope" thus
// emerge as independent, genome-driven anti-predation strategies
// without the engine prescribing predator/prey roles.
const PREDATION_RADIUS_RATIO = 1.14;
const PREDATION_COOLDOWN_SEC = 0.2;
const PREDATION_ENERGY_BASE = 5;
const PREDATION_ENERGY_PER_MASS = 0.1;
// Breaching a target's membrane costs energy in proportion to how
// much structural envelope there is to rupture -- armor makes prey
// expensive (or, combined with the hard gate above, impossible) to eat.
const PREDATION_ENERGY_PER_MEMBRANE = 0.5;
// Extra ATP per unit of target cohesion (its CHEM_BOND pool x its
// intact bond count) to tear it out of a colony. Tunable: high enough
// that a lineage investing heavily in SYNTH BOND meaningfully
// protects its members, low enough not to shut predation down in the
// smoke ecosystem.
const PREDATION_ENERGY_PER_COHESION = 3;

// Baseline metabolism: a small flat "cost of being alive" plus a per-mass
// component. Big cells must keep more chemistry running and starve faster
// when idle. A r=4 cell pays ~0.5 e/s; a r=20 (~mass 1250) cell pays ~7 e/s.
const BASE_METABOLIC_DRAIN = 0.5;
const BASE_METABOLIC_PER_MASS = 0.0003;
const DEATH_RELEASE_R_MIN = 1.2;

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
// Newborn yolk constants retired. The genome now fully determines
// the child's bootstrap state: it gets its proportional share of
// the parent's pools and nothing else. If the parent didn't
// stockpile enough machinery before reproducing, that's the
// parent's lineage problem.
// Multiplier on (parent.r + child.r) for birth offset. >1 places the
// child outside the parent's recently-eaten food zone so it can find
// a food gradient. Was 1.1 (child inside parent's foraging range).
const BIRTH_OFFSET_MULT = 3.0;

// Photosynthesis depth attenuation: ambient light = exp(-y / LIGHT_DECAY).
// Surface = 1.0, e-folds every LIGHT_DECAY pixels of depth.
const LIGHT_DECAY = 250;
const DRAG_REF_R = 4;
const MIN_CREATURE_R = 4;
// Cell density: how strongly reserve composition shifts the effective
// density away from water (1.0). 1.0 = full literal weighting (the
// rock-stuffed cell really does sit at ~1.3); 0 = density always 1.0.
// 0.3 = "mostly water, slight nudge from contents."
const DENSITY_DAMPING = 0.3;
const DENSITY_FLOOR = 0.85;
const DENSITY_CEIL = 1.15;

// ----- chemistry constants -----
//
// Biopolymer digestion (catabolism replacement) is now a regular
// reaction (REACTIONS slot 10), with rate gated on enzyme pool. See
// installNamedReactions() for parameters.

// Passive O2 (and CO2) exchange with the surrounding water. Real cells
// dissolve oxygen across their membrane; without this our cells starve
// because the default genome only seeks organic particles and never builds
// up enough internal O2 to power aerobic respiration.
// O2 / CO2 diffusion is now generalized via diffuseAmbient + the
// chem table's per-chem permeability. AMBIENT_TARGET[CHEM_O2] / [CO2]
// continue to set the equilibrium concentrations.

// Catabolism is now driven by reactions, not a hand-coded material-to-
// molecule fraction table. The biopolymer-digest bootstrap reaction
// (slot 10 in REACTIONS) turns ingested biopolymer into glucose + amino
// acid + fatty acid, gated on the digester (enzyme) chemical -- a real
// reaction with substrates, products, and rate-limited by enzyme pool.
// Particles deposit their mass directly into the cell's chem pool on
// ingestion; the cell decides per-tick how much biopolymer to digest
// based on how much enzyme it has built. Catabolism of mineral particles
// is just "the cell carries mineral chemical until it's used as a
// biosynth substrate" -- no transform needed.

// String key -> index in MOLECULE_IDS array. Used to map between named
// chem ids and Molecules field positions.

// Reaction kinetics. Each reaction uses Michaelis-Menten saturation so it
// runs at most VMAX per second and gracefully slows as substrates deplete.
// The named-reaction VMAX values (formerly AEROBIC_VMAX etc.) now live
// inline in installNamedReactions() since each one belongs to a single
// slot in the REACTIONS table. KM_DEFAULT is still used by the engine.
const KM_DEFAULT = 1;

// Phase 2: mrnaMult retired. Biosynth rates are uniform across cells;
// mrna accumulation no longer multiplies them. Cells that want to
// out-build their peers do it via catalyst pools on the specific
// biosynth slots (REACTIONS[4..9]). Ribosomes still exist as a
// tracked molecule and can be synthesized via the synth_ribo
// reaction, but they're inert -- a future cleanup will retire them.

// Generic chemistry: 64 chemicals + 256 reactions. The named
// chemistry (aerobic / ferment / betaOx / catabolize / photosynth /
// biosynthesize) runs UNCATALYZED at its base rate -- it's the
// bootstrap engine every cell gets for free. On top of that, the VM
// can choose to build catalysts (SYNTH_CAT <id>) for any of 256
// generated reactions that swap chemicals around. The 8 named
// chemicals appear at slots 0..7 of the chemical table and alias
// the existing m_* fields, so generic reactions can pull from /
// dump into the named pool transparently. The other 56 are abstract
// generic chemicals with random masses -- the "chemicals the cell
// stumbles upon".
const CAT_REF = 5;
const CAT_SYNTH_VMAX = 0.3;
const CAT_ATP_COST = 4;
// Active-transport (TRANSPORT op, up-gradient pumping) tuning. Cost
// per unit flow = TRANSPORT_PUMP_ATP * ln(1 + min(C_dest/C_src,
// MAX_RATIO)). EPS floors the ratio so a near-empty source can't
// divide-by-zero; MAX_RATIO bounds the cost when C_src ~ 0. Down-
// gradient transport is free (no constant needed).
const TRANSPORT_PUMP_ATP = 0.5;
const TRANSPORT_MAX_RATIO = 1e3;
const TRANSPORT_EPS = 1e-6;
const CAT_DECAY_PER_SEC = 0.005;
// Allosteric inhibitor (SYNTH INH <slot>) — dual of catalyst. Same
// substrate (AA+MIN) and ATP cost as catalyst biosynthesis; same
// decay rate (recycles to AA+MIN). INH_K is the per-(pool/CAT_REF)
// rate-multiplier reduction: a full unit of inhibitor pool kills
// the reaction completely (rate × max(0, 1 − 1·1) = 0). Equal
// catalyst + inhibitor pools collide head-on, leaving the rate at
// uncatRate (no net amplification, no zeroing).
const INH_SYNTH_VMAX = 0.3;
const INH_ATP_COST = 4;
const INH_DECAY_PER_SEC = 0.005;
const INH_K = 1;

// ===================================================================
// Reaction / ATP accounting -------------------------------------------
// Raw occurrence counts for every chemical transformation (the 256-slot
// REACTIONS table run in cells/organelles, catalyst synthesis, plus the
// non-table conversions: maintenance decay, toxify, death catalyst
// denature, waste denature), split by location (in a cell vs in a
// field) and whether a catalyst was present. Plus a separate ATP
// ledger: how much ATP each source consumed/produced. Bucketed into
// 60-second windows; windows older than 1h compact to 5-minute
// buckets. Persisted with the save.
// Reaction-id space + ATP-ledger labels live in ./sim/rxn-ids
// (imported at the top of this file).
// RxnStats data model + (de)serialization live in ./sim/rxn-stats
// (imported at the top of this file). Only the World-coupled recording
// hot path stays here.
// Set once per step() (chemistry is single-threaded in the sim worker)
// so the deep reaction/decay/spendATP paths can record without
// threading `world` through five hot signatures.
let RXN_STATS_WORLD: World | undefined;
function recordRxn(id: number, loc: number, cat: number): void {
  const rs = RXN_STATS_WORLD && RXN_STATS_WORLD.rxnStats;
  if (rs) rs.curRxn[rxIdx(id, loc, cat)]++;
}
function recordAtp(label: number, consumed: number, produced: number): void {
  const rs = RXN_STATS_WORLD && RXN_STATS_WORLD.rxnStats;
  if (!rs) return;
  if (consumed) rs.curAtp[label * 2] += consumed;
  if (produced) rs.curAtp[label * 2 + 1] += produced;
}
const RXN_WINDOW_SEC = 60;
const RXN_FINE_RETAIN_SEC = 3600; // keep 60s windows for the last hour
const RXN_COARSE_SEC = 300;       // older windows compact to 5-minute buckets
function rollReactionWindow(world: World): void {
  const rs = world.rxnStats;
  if (!rs) return;
  while (world.t - rs.windowStart >= RXN_WINDOW_SEC) {
    rs.fine.push({ t0: rs.windowStart, rxn: rs.curRxn.slice(), atp: rs.curAtp.slice() });
    rs.curRxn.fill(0);
    rs.curAtp.fill(0);
    rs.windowStart += RXN_WINDOW_SEC;
  }
  const cutoff = world.t - RXN_FINE_RETAIN_SEC;
  while (rs.fine.length > 0 && rs.fine[0].t0 < cutoff) {
    const w = rs.fine.shift() as RxnWindow;
    const bucket = Math.floor(w.t0 / RXN_COARSE_SEC) * RXN_COARSE_SEC;
    const last = rs.coarse.length > 0 ? rs.coarse[rs.coarse.length - 1] : undefined;
    if (last && last.t0 === bucket) {
      for (let i = 0; i < w.rxn.length; i++) last.rxn[i] += w.rxn[i];
      for (let i = 0; i < w.atp.length; i++) last.atp[i] += w.atp[i];
    } else {
      rs.coarse.push({ t0: bucket, rxn: w.rxn, atp: w.atp });
    }
  }
}
// --- Reaction catalog: stable per-reaction metadata (what each
// reaction consumes/produces + a human label) so the UI can show,
// for any material, which reactions are its producers vs consumers
// and how many times each has run to date.
export interface ReactionTerm { chem: number; coef: number; }
export interface ReactionInfo {
  id: number;
  label: string;
  consumes: ReactionTerm[];
  produces: ReactionTerm[];
  // Signed ATP delta per reaction (>0 exergonic, <0 endergonic, 0 =
  // not an ATP reaction). Derived uniformly from the ADP term so it's
  // exact for the 256 table reactions and correct for the synthetic
  // accounting entries.
  atpDelta: number;
  // true = an external/spawn input (founder biogenesis), excluded
  // from the production/consumption time-series graph.
  external?: boolean;
}
function rxnTermStr(t: ReactionTerm[]): string {
  if (t.length === 0) return "∅";
  return t.map((x) => {
    const c = Math.round(x.coef * 100) / 100;
    const nm = x.chem < CHEM_SHORT_LABELS.length ? CHEM_SHORT_LABELS[x.chem] : `c${x.chem}`;
    return (c === 1 ? "" : c + " ") + nm;
  }).join(" + ");
}
let REACTION_CATALOG: ReactionInfo[] | null = null;
export function reactionCatalog(): ReactionInfo[] {
  if (REACTION_CATALOG) return REACTION_CATALOG;
  const out: ReactionInfo[] = [];
  for (let slot = 0; slot < N_REACTIONS; slot++) {
    const r = REACTIONS[slot];
    const consumes: ReactionTerm[] = [];
    const produces: ReactionTerm[] = [];
    for (let j = 0; j < r.sChem.length; j++) consumes.push({ chem: r.sChem[j], coef: r.sCount[j] });
    for (let j = 0; j < r.pChem.length; j++) produces.push({ chem: r.pChem[j], coef: r.pCount[j] });
    // ATP/ADP is engine-managed via atpDelta, not in sChem/pChem:
    // endergonic spends ATP and yields ADP; exergonic consumes ADP.
    if (r.atpDelta < 0) produces.push({ chem: CHEM_ADP, coef: -r.atpDelta });
    else if (r.atpDelta > 0) consumes.push({ chem: CHEM_ADP, coef: r.atpDelta });
    const named = slot < NAMED_REACTION_COUNT;
    const label = (named ? reactionName(slot) + ": " : `gen#${slot}: `) +
      rxnTermStr(consumes) + " → " + rxnTermStr(produces);
    out.push({ id: slot, label, consumes, produces, atpDelta: r.atpDelta });
  }
  const adpDelta = (cons: ReactionTerm[], prod: ReactionTerm[]): number => {
    for (const t of cons) if (t.chem === CHEM_ADP) return t.coef;   // exergonic
    for (const t of prod) if (t.chem === CHEM_ADP) return -t.coef;  // endergonic
    return 0;
  };
  // Phase 5 cleanup: CHEM_CHEMORECEPTOR_* removed from the receptor
  // maintenance list (they are no longer produced -- chemo synth
  // slots inertized in reactions.ts -- so there is nothing to
  // maintain).
  const RECEPTORS = [
    CHEM_PHOTORECEPTOR_VISIBLE, CHEM_PHOTORECEPTOR_LONG, CHEM_PHOTORECEPTOR_SURFACE,
    CHEM_MECHANORECEPTOR, CHEM_THERMORECEPTOR, CHEM_MAGNETORECEPTOR,
  ];
  const aaMin: ReactionTerm[] = [{ chem: CHEM_AA, coef: 0.5 }, { chem: CHEM_MIN, coef: 0.5 }];
  const syn = (id: number, name: string, cons: ReactionTerm[], prod: ReactionTerm[]): void => {
    out.push({
      id, label: `${name}: ${rxnTermStr(cons)} → ${rxnTermStr(prod)}`,
      consumes: cons, produces: prod, atpDelta: adpDelta(cons, prod),
    });
  };
  syn(RX_MAINT_MEMBRANE, "membrane hydrolysis", [{ chem: CHEM_MEMBRANE, coef: 1 }], [{ chem: CHEM_FA, coef: 0.65 }, { chem: CHEM_AA, coef: 0.35 }]);
  syn(RX_MAINT_ENZ, "maint enzyme", [{ chem: CHEM_ENZ, coef: 1 }], aaMin);
  syn(RX_MAINT_CHL, "maint chlorophyll", [{ chem: CHEM_CHL, coef: 1 }], aaMin);
  syn(RX_MAINT_MRNA, "maint mRNA", [{ chem: CHEM_MRNA, coef: 1 }], aaMin);
  syn(RX_MAINT_RECEPTOR, "maint receptors", RECEPTORS.map((c) => ({ chem: c, coef: 1 })), aaMin);
  syn(RX_MAINT_CATALYST, "maint catalyst", [], aaMin);
  syn(RX_TOXIFY, "toxify", [{ chem: CHEM_MEMBRANE, coef: 1 }], [{ chem: CHEM_WASTE, coef: 1 }]);
  syn(RX_THERMAL_DENATURE, "thermal denature", [{ chem: CHEM_MEMBRANE, coef: 1 }], [{ chem: CHEM_WASTE, coef: 1 }]);
  syn(RX_DEATH_CATDENATURE, "death catalyst denature", [], aaMin);
  syn(RX_DENATURE_WASTE, "waste denature", [{ chem: CHEM_WASTE, coef: 1 }], [{ chem: CHEM_CO2, coef: 1 }]);
  syn(RX_SYNTH_CATALYST, "synth catalyst", aaMin, [{ chem: CHEM_ADP, coef: CAT_ATP_COST }]);
  syn(RX_BIOGENESIS, "founder biogenesis (reserve→seed/ATP)", [],
    [{ chem: CHEM_MEMBRANE, coef: 1 }, { chem: CHEM_ADP, coef: 5 }, { chem: CHEM_MRNA, coef: 5 },
     { chem: CHEM_GLU, coef: 10 }, { chem: CHEM_AA, coef: 0.5 }]);
  out[out.length - 1].external = true; // spawn input, excluded from the graph
  REACTION_CATALOG = out;
  return out;
}
// Total executions to date per reaction id (cur + all windows, both
// locations + catalyzed/uncatalyzed summed).
export function reactionTotals(world: World): Int32Array {
  const t = new Int32Array(NREACT);
  const rs = world.rxnStats;
  if (!rs) return t;
  const addAll = (a: Int32Array): void => {
    for (let id = 0; id < NREACT; id++) {
      const b = id * 4;
      t[id] += a[b] + a[b + 1] + a[b + 2] + a[b + 3];
    }
  };
  addAll(rs.curRxn);
  for (const w of rs.fine) addAll(w.rxn);
  for (const w of rs.coarse) addAll(w.rxn);
  return t;
}
// Convert a chemical AMOUNT (moles) to 2px-particle-equivalents --
// the exact conversion the chemistry panel uses for diss/resv, so
// the reaction detail reads on the same scale as rend/diss/resv.
export function chemAmountToParticles(chem: number, amount: number): number {
  const density = CHEM_BASE_DENSITY[chem] > 0 ? CHEM_BASE_DENSITY[chem] : 1;
  const volPer = (4 / 3) * Math.PI * PRECIP_R * PRECIP_R * PRECIP_R;
  const amountPer = (density * volPer) / (CHEM_MM[chem] || 1);
  return amountPer > 0 ? amount / amountPer : 0;
}
// ===================================================================
// CHEMICAL_COUNT / NAMED_CHEMICAL_COUNT / NAMED_CHEMICALS, the CHEM_*
// slot ids, MRNA/CHL/ENZ_REF and GENERIC_CHEMICAL_COUNT live in
// ./sim/chem-ids (imported at the top of this file). The CHEMICALS
// table + LUTs below still build here.

// Chemical table, LUTs, CHEM_IDS, SENSOR_CHEMS, GENERIC_SPAWN_ORDER
// and the property types live in ./sim/chemistry (imported + re-
// exported at the top of this file). Particle spawn weights + the
// chemCols<->molCols index map stay here (they compose the chemistry
// LUTs with particle/creature concerns).

// World-spawn weighting for free-floating particles. Replaces the
// old per-MaterialId SEED_WEIGHTS table. Minerals subsume the
// rock/sand/clay slice of the old food web (one chemical, per-particle
// density jitter recovers the old rock-heavy / clay-light visual
// variation). Biopolymer takes "organic"'s slot. The two gas chems
// (O2 / CO2) split the old gas weight 60/40 like the old material
// catabolized to.
//
// `densityJitter` lets specific chems vary their per-particle density;
// undefined means "use CHEM_BASE_DENSITY[chemId]". Minerals jitter
// across the old rock..clay range so the sediment band still reads
// as gravelly. Biopolymer jitters around 1.0 because partially-
// decomposed biomatter ranges from oily to dense protein.
//
// Every particle is exactly one unit of one chemical -- no riders.
// `weight` is the SINGLE distribution: it drives both the initial
// seed and the ongoing replenish (one ratio, no separate
// initialCount). seedInitialParticles guarantees >=1 of every spec
// then weighted-fills to particleTarget, so t=0 == steady-state mix.
interface SpawnChemSpec {
  chemId: number;
  weight: number;
  densityJitter?: { lo: number; hi: number };
}
// Generic-chem tail: weight = max(GEN_TOP*GEN_DECAY^rank, GEN_FLOOR)
// over the deterministically-shuffled GENERIC_SPAWN_ORDER -- a few
// common, a long rare tail, but FLOORED so even the rarest generic
// keeps a meaningful spawn share (see the representation analysis:
// at a ~5k cap the floor yields ~6 expected of each, and the >=1
// guarantee in seedInitialParticles makes t=0 presence certain).
const GEN_SPAWN_TOP = 0.8;
const GEN_SPAWN_DECAY = 0.82;
const GEN_SPAWN_FLOOR = 0.025;
const SPAWN_CHEM_SPECS: SpawnChemSpec[] = (() => {
  const specs: SpawnChemSpec[] = [
    { chemId: CHEM_BIOPOLYMER, weight: 4.5, densityJitter: { lo: 0.7, hi: 1.3 } },
    // Minerals: subsume rock + sand + clay. Density spans 1.4..2.6.
    { chemId: CHEM_MIN, weight: 7.5, densityJitter: { lo: 1.4, hi: 2.6 } },
    { chemId: CHEM_FA, weight: 7.5 },
    // ADP is a normal single-chem spawn (was a "primordial
    // adenosine" molecule-rider seed); ATP economy fed by ongoing
    // spawn, not a one-time dump.
    { chemId: CHEM_ADP, weight: 2.0 },
    // Gas split: O2 60%, CO2 40% (matches the old catab table).
    { chemId: CHEM_O2, weight: 0.3 },
    { chemId: CHEM_CO2, weight: 0.2 },
  ];
  for (let rank = 0; rank < GENERIC_SPAWN_ORDER.length; rank++) {
    const w = Math.max(GEN_SPAWN_TOP * Math.pow(GEN_SPAWN_DECAY, rank), GEN_SPAWN_FLOOR);
    specs.push({ chemId: GENERIC_SPAWN_ORDER[rank], weight: w });
  }
  return specs;
})();


// The reaction table (Reaction type, buildReactionTable,
// installNamedReactions, REACTIONS, NAMED_REACTION_COUNT) lives in
// ./sim/reactions (imported + re-exported at the top of this file).

// Hot inner loop. Slot-major iteration so each catalystCols[k] is one
// contiguous Float32Array per pass; the empty-pool branch is
// predicted not-taken for the common case (cells express only a
// handful of catalysts at a time).
//
// Phase 2: also drives the named reactions. Slot 0..9 have
// uncatRate > 0 so they fire even with zero catalyst -- the bootstrap
// chemistry every cell gets free. Catalyst pools boost on top.
// ATP/ADP mass conservation is engine-managed via atpDelta: exergonic
// reactions deduct |atpDelta| ADP per unit; endergonic deduct
// |atpDelta| ATP (energy) and credit |atpDelta| ADP.
// Surface fingerprint: each cell's top FP_SIZE chemicals by current
// concentration, packed as a bitmask over CHEMICAL_COUNT. Other
// cells read this on contact to gate ADHERE (kin recognition) and
// ENGULF (non-self recognition). No genome inspection involved --
// this is the cell's phenotype "on display": its actual chemistry
// pool. Kin recognition emerges naturally because related lineages
// run similar genomes -> produce similar chemistry -> carry
// overlapping fingerprints. Refreshed once per tick before VM /
// reactions.
const FP_SIZE = 8;
const fpScratchIds = new Uint8Array(FP_SIZE);
const fpScratchVals = new Float32Array(FP_SIZE);
function updateSurfaceFingerprint(c: Creature): void {
  const s = c.store; const i = c.idx;
  const cols = s.chemCols;
  // Selection: keep top FP_SIZE entries in fpScratch.
  for (let k = 0; k < FP_SIZE; k++) { fpScratchVals[k] = -1; fpScratchIds[k] = 0; }
  for (let chem = 0; chem < CHEMICAL_COUNT; chem++) {
    const v = cols[chem][i];
    if (v <= 0) continue;
    // Find slot with smallest value; evict if v is bigger.
    let minIdx = 0;
    let minVal = fpScratchVals[0];
    for (let k = 1; k < FP_SIZE; k++) {
      if (fpScratchVals[k] < minVal) { minVal = fpScratchVals[k]; minIdx = k; }
    }
    if (v > minVal) {
      fpScratchVals[minIdx] = v;
      fpScratchIds[minIdx] = chem;
    }
  }
  // Pack ids into a 128-bit set across four 32-bit words.
  // Word w covers chem ids [32w .. 32w+31].
  let w0 = 0, w1 = 0, w2 = 0, w3 = 0;
  for (let k = 0; k < FP_SIZE; k++) {
    if (fpScratchVals[k] < 0) continue; // unfilled slot
    const id = fpScratchIds[k];
    const word = id >>> 5;        // id / 32
    const bit = 1 << (id & 31);   // id % 32
    if (word === 0) w0 |= bit;
    else if (word === 1) w1 |= bit;
    else if (word === 2) w2 |= bit;
    else w3 |= bit;
  }
  s.fpW0[i] = w0 >>> 0;
  s.fpW1[i] = w1 >>> 0;
  s.fpW2[i] = w2 >>> 0;
  s.fpW3[i] = w3 >>> 0;
}
function refreshSurfaceFingerprints(world: World): void {
  for (const c of world.creatures) {
    updateSurfaceFingerprint(c);
    // Inner cells get fingerprints too so a host's engulfment of a new
    // prey reads the prey's fingerprint correctly; engulfed cells
    // already inside don't need to be checked (recognition is at
    // contact time, but cheap to keep them updated).
    for (const inner of c.contents) updateSurfaceFingerprint(inner);
  }
}

function runGenericReactions(c: Creature, dt: number, ambientLight: number): void {
  const s = c.store; const i = c.idx;
  const KM = KM_DEFAULT;
  for (let slot = 0; slot < N_REACTIONS; slot++) {
    const rxn = REACTIONS[slot];
    // Transport-flavored slots are not intra-pool reactions; the
    // cross-compartment applier (runTransportReactions) handles them.
    if (rxn.transport !== undefined) continue;
    const pool = s.catalystCols[slot][i];
    if (rxn.uncatRate <= 0 && pool <= 0) continue;
    // Light gate
    let lightMult = 1;
    if (rxn.lightIn > 0) {
      if (ambientLight <= 0) continue;
      lightMult = ambientLight / rxn.lightIn;
      if (lightMult > 1) lightMult = 1;
    }
    // Substrate gate + MM saturation
    let limit = Infinity;
    let satProduct = 1;
    const sChem = rxn.sChem;
    const sCount = rxn.sCount;
    for (let j = 0; j < sChem.length; j++) {
      const have = s.chemCols[sChem[j]][i];
      const need = sCount[j];
      const ratio = have / need;
      if (ratio < limit) limit = ratio;
      satProduct *= ratio / (ratio + KM);
    }
    if (limit <= 0) continue;
    // ATP / ADP handling.
    const atpD = rxn.atpDelta;
    if (atpD < 0) {
      // Endergonic: pulls from cell energy. atpFloor reactions keep
      // BIOSYNTH_ATP_FLOOR ATP in reserve so newborns don't drain
      // themselves dry growing.
      const floor = rxn.atpFloor ? BIOSYNTH_ATP_FLOOR : 0;
      const eAvail = (s.energy[i] - floor) / -atpD;
      if (eAvail <= 0) continue;
      if (eAvail < limit) limit = eAvail;
      satProduct *= eAvail / (eAvail + KM);
    } else if (atpD > 0) {
      // Exergonic: phosphorylates ADP back to ATP. Need ADP available.
      const adpAvail = s.chemCols[CHEM_ADP][i] / atpD;
      if (adpAvail <= 0) continue;
      if (adpAvail < limit) limit = adpAvail;
      satProduct *= adpAvail / (adpAvail + KM);
    }
    const surface = rxn.surfaceScale ? (s.r[i] / MIN_CREATURE_R) : 1;
    // Named-molecule multipliers: mRNA are the cell's protein-
    // synthesis machinery (mandatory on every biosynth reaction);
    // chlorophyll is the photosynth pigment (mandatory on slot 3).
    // Both gate hard at zero -- no pigment, no photosynth; no
    // mRNA, no biosynthesis. cells must build these molecules
    // via SYNTH_MRNA / SYNTH_CHL to actually grow / fix carbon.
    let machineryMult = 1;
    if (rxn.mrnaScale) {
      const r = s.chemCols[CHEM_MRNA][i];
      if (r <= 0) continue;
      machineryMult *= r / MRNA_REF;
    }
    if (rxn.chlScale) {
      const ch = s.chemCols[CHEM_CHL][i];
      if (ch <= 0) continue;
      // Saturating, not linear: per-cell light harvesting is capped by
      // finite incident photons. An unbounded chl/CHL_REF made the
      // light reaction (out[25]) autocatalytic without diminishing
      // returns -- cells hoarded carbon as excess chlorophyll (chl
      // ran away to 4000+) instead of building fa/membranes/dividing.
      // Flat above CHL_REF removes that incentive; identical below.
      machineryMult *= Math.min(1, ch / CHL_REF);
    }
    if (rxn.enzScale) {
      const en = s.chemCols[CHEM_ENZ][i];
      if (en <= 0) continue;
      machineryMult *= en / ENZ_REF;
    }
    // Allosteric inhibitor dampens the effective rate (Phase 4b).
    // inhPool/CAT_REF = 1 with INH_K=1 zeros the slot; below that
    // it linearly scales the (uncat + catalyzed) rate down.
    const inhPool = s.inhibitorCols[slot][i];
    let inhMult = 1;
    if (inhPool > 0) {
      inhMult = 1 - INH_K * (inhPool / CAT_REF);
      if (inhMult <= 0) continue;
    }
    const rate = (rxn.uncatRate + rxn.vmax * (pool / CAT_REF)) * satProduct * lightMult * surface * machineryMult * inhMult;
    let amt = rate * dt;
    if (amt > limit) amt = limit;
    if (amt <= 0) continue;
    // Apply substrates
    for (let j = 0; j < sChem.length; j++) {
      s.chemCols[sChem[j]][i] -= sCount[j] * amt;
    }
    // Apply products
    const pChem = rxn.pChem;
    const pCount = rxn.pCount;
    for (let j = 0; j < pChem.length; j++) {
      s.chemCols[pChem[j]][i] += pCount[j] * amt;
    }
    // ATP / ADP conversion (mass-conserving)
    if (atpD !== 0) {
      s.energy[i] += atpD * amt;
      s.chemCols[CHEM_ADP][i] -= atpD * amt;
    }
    // Accounting: one firing of this slot (cell), catalyzed iff a
    // catalyst pool actually boosted it. ATP flux into the ledger.
    recordRxn(slot, RX_LOC_CELL, (pool > 0 && rxn.vmax > 0) ? 1 : 0);
    if (atpD < 0) recordAtp(ATP_RXN_ENDO, -atpD * amt, 0);
    else if (atpD > 0) recordAtp(ATP_RXN_EXO, 0, atpD * amt);
  }
}

// Standing transporters across the cell's OUTER membrane (cell<->world).
// A transporter is the existing enzyme machinery: catalystCols[slot]
// (built by SYNTH CAT param=slot) facilitates movement of one chem
// across the membrane, MM-saturated on the source side and scaled by
// the catalyst pool + cell surface -- the same kinetic shape as
// metabolism, just cross-compartment. v1 is facilitated (down-gradient,
// no ATP); the Reaction.atpDelta hook is reserved for future active
// pumping. Mass-exact (chem moves 1:1 between the cell pool and the
// region ambient field, which is in the mass ledger -- same surface
// diffuseAmbient uses) and deterministic (no simRng). The vacuolar
// (host<->organelle) membrane is wired in a following sub-commit.
export function runTransportReactions(c: Creature, world: World, dt: number): void {
  const s = c.store; const i = c.idx;
  const cols = s.chemCols;
  const cats = s.catalystCols;
  const ambient = world.ambient;
  const ab = ambientBaseAt(world, s.x[i], s.y[i]);
  const surface = s.r[i] / MIN_CREATURE_R;
  for (let n = 0; n < TRANSPORT_TARGETS.length; n++) {
    const k = TRANSPORT_TARGETS[n];
    // ATP translocase (ANT) is inner-membrane only: there is no
    // ambient ATP, so it does not act at the cell<->world membrane.
    if (k === TRANSPORT_ATP) continue;
    const slot = TRANSPORT_SLOT_BASE + n;
    const pool = cats[slot][i];
    if (pool <= 0) continue; // no transporter protein -> no facilitated flux
    const ak = ab + k;
    const inside = cols[k][i];
    const outside = ambient[ak];
    const gap = outside - inside; // >0 net import, <0 net export
    if (gap === 0) continue;
    // MM-saturate on the SOURCE concentration so a carrier saturates
    // like a real transporter instead of growing unbounded with the
    // gradient.
    const src = gap > 0 ? outside : inside;
    const sat = src / (src + KM_DEFAULT);
    let flow = REACTIONS[slot].vmax * (pool / CAT_REF) * surface * sat * gap * dt;
    // Strict mass conservation: never move more than the source holds.
    if (flow > 0) { if (flow > outside) flow = outside; }
    else { if (-flow > inside) flow = -inside; }
    if (flow === 0) continue;
    cols[k][i] += flow;
    ambient[ak] -= flow;
  }
}

// Maintenance: structural molecules turn over even when the cell isn't
// reproducing. Each tick a small fraction of biomass / enzyme / chloro
// / mrna degrades back into the substrates it was synthesized
// from -- no ATP recovered, but mass-conserving. A cell that stops
// biosynthesizing (because it has no ATP) bleeds structure and
// eventually drops below MIN_VIABLE_MEMBRANE, at which point it
// autolyzes.
const MEMBRANE_DECAY_PER_SEC = 0.005;
// The three mandatory-machinery molecules (chl/enz/ribo) gate hard at
// zero now, so their decay is what eventually kills a starving cell.
// Lowered to ~0.001 so cells survive temporary substrate shortages
// (~10 min half-life) instead of collapsing within seconds of stalling.
const ENZYME_DECAY_PER_SEC = 0.001;
const CHLORO_DECAY_PER_SEC = 0.001;
const MRNA_DECAY_PER_SEC = 0.001;
// Membrane is the structural reserve that gates viability now that
// the biomass chemical is retired. Same threshold the old MIN_VIABLE_MEMBRANE
// gate used; cells below this autolyze.
const MIN_VIABLE_MEMBRANE = 0.5;
// A cell with no mrna can't turn over biomass or rebuild lost
// enzymes. Ribosome decays slowly (~0.1%/sec) so a 0.01 threshold
// gives healthy cells thousands of sim-sec of headroom before falling
// below it without active SYNTH_MRNA.
const MIN_VIABLE_RIBOSOME = 0.01;
// Amino acid is much more fluid -- biosynth + reactions consume it
// in bursts and maintenance decay refills it. A 0.001 threshold
// catches cells with *essentially zero* aa (no synth, no prey)
// without nuking cells in transient low-aa states mid-tick.
const MIN_VIABLE_AMINOACID = 0.001;

// Somatic mutation rate scales quadratically with age (seconds). A newborn
// is effectively stable; an old cell accumulates DNA damage gradually.
// At age 60s: ~7e-3/s (1 mutation per ~140s); 100s: ~0.02/s; 300s: ~0.18/s.
const SOMATIC_MUTATION_AGE_COEF = 8e-7;
const REPAIR_WINDOW_TICKS = 30;
// K-5: chemistry-mediated DNA repair. CHEM_REPAIR pool above this
// threshold each tick refreshes the cell's repairTicks window, which
// somaticMutate already consults to suppress drift. CHEM_BOND pool
// above its threshold lets two adjacent cells auto-bond. Both
// thresholds are calibrated against the receptor RECEPTOR_REF
// constant (0.1) so a single SYNTH op per couple of seconds keeps
// either pool active.
const REPAIR_ACTIVE_THRESH = 0.1;
const BOND_FORMATION_THRESH = 0.1;
// Greenbeard recognition tolerance. Two adhesive cells only bond if
// their genome-encoded bond markers (0..255, the SYNTH BOND param)
// differ by <= this. Clonal kin share an identical marker (diff 0) and
// always recognize; the band gives a few point-mutations of drift
// before a sub-lineage becomes bond-incompatible, so colonies speciate
// gradually rather than fracturing on the first mutation. Small
// relative to the 256-value space so distinct founder lineages
// (random tags) rarely cross-bond by accident.
const BOND_MARKER_TOL = 4;
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
// Distance from each side wall in which aeration bubbles refuse to
// spawn. Same motivation as the gas-only wall-repulsion term: keep
// fresh bubbles out of the strip where they'd start their life
// already collision-pinned against a wall.
const AERATION_WALL_INSET = 32;
// Total mass per bubble (drawn from the atmosphere). Composition is
// sampled from atmospheric mole fractions, so a CO2-rich atmosphere
// yields CO2-rich bubbles (and O2-depleted ones).
const AERATION_MASS_PER_BUBBLE = AERATION_O2_PER_BUBBLE;
// Starting atmospheric inventory. Earthlike: mostly O2, trace CO2,
// nothing else. Large enough that early bubble composition is stable;
// not so large that long runs can't shift it via cellular excretion.
const ATMOSPHERE_INIT_O2 = 8000;
const ATMOSPHERE_INIT_CO2 = 200;
function initialAtmosphere(): Molecules {
  const a = emptyMolecules();
  a.o2 = ATMOSPHERE_INIT_O2;
  a.co2 = ATMOSPHERE_INIT_CO2;
  return a;
}

// Atmosphere<->dissolved equilibrium target. ONLY the gases: water
// in contact with air equilibrates dissolved O2/CO2 toward these
// (Henry's-law-ish), the rate driven by aerateAmbient(). The old
// aa/min "primordial soup" floors were retired -- with the regional
// reserve + founders drawing from reserve, every chemical now enters
// solely as particles, so seeding the dissolved field with aa/min
// from nowhere is both redundant and inconsistent with that model.
const AMBIENT_TARGET = new Float32Array(CHEMICAL_COUNT);
AMBIENT_TARGET[CHEM_O2] = 12;   // matches the old O2_AMBIENT constant
AMBIENT_TARGET[CHEM_CO2] = 1;   // matches CO2_AMBIENT

function initialAmbient(width: number, height: number): Float32Array {
  // Regional dissolved field: every region's block starts at the
  // equilibrium target (per-region seed of the aa/min/O2/CO2 floors)
  // so the first ticks aren't dominated by ambient transients.
  const cols = Math.max(1, Math.ceil(width / REGION_PX));
  const rows = Math.max(1, Math.ceil(height / REGION_PX));
  const a = new Float32Array(cols * rows * CHEMICAL_COUNT);
  for (let r = 0; r < cols * rows; r++) {
    const b = r * CHEMICAL_COUNT;
    for (let k = 0; k < CHEMICAL_COUNT; k++) a[b + k] = AMBIENT_TARGET[k];
  }
  return a;
}

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
// Minimal field set the surface/temperature/light helpers read from
// the world. World naturally satisfies this; so does RenderSnapshot,
// which lets the renderer call the same helpers off a snapshot.
export interface WorldEnv {
  t: number;
  height: number;
  surfaceY: number;
  surfaceWaveAmp: number;
  surfaceLength: number;
  surfacePeriod: number;
  swellLength: number;
  swellPeriod: number;
  updraftLength: number;
  updraftPeriod: number;
  disturbanceIntensity: number;
  tempSurface: number;
  tempBottom: number;
  tempPatchAmp: number;
  tempPatchLength: number;
  tempPatchPeriod: number;
  dayPhase: number;
  // Wind state (drives surface wave amplitude + direction). Wind
  // magnitude is in the same units as the legacy surfaceWaveAmp
  // baseline -- |wind|/WIND_MAX gives a 0..1 scale that gets
  // multiplied into amplitude per column.
  wind: number;
  windExposureFromLeft?: Float32Array;
  windExposureFromRight?: Float32Array;
  // Per-column wave-train spatial origin: the x a surface wave "starts"
  // from for that column, reset to the downwind edge of each
  // surface-breaching rock so the lee re-forms its own waves instead of
  // staying phase-locked to (and appearing to pass straight through) the
  // windward train. Direction-paired like the exposure maps.
  waveOriginFromLeft?: Float32Array;
  waveOriginFromRight?: Float32Array;
  // Optional vent state. WorldEnv is the narrow slice that helpers
  // like temperatureAt see; vents contribute heat through this so the
  // helper doesn't need a full World.
  vent?: import("./sim/core").VentState;
}

// Maximum |wind| magnitude. surfaceYAt scales wave amplitude by
// |wind|/WIND_MAX so this is the "100% storm" reference.
export const WIND_MAX = 200;

// Generic "how rough is the surface, 0..1 multiplier" reading. Now
// derived from wind: |wind|/WIND_MAX with the disturbance intensity
// folded in as an additional amplifier for aeration / brownian /
// vertical-mixing call sites that already expected the old
// disturbance-blended scalar. Sites that want the column-specific
// wave amplitude should compute it from `wind` + `windExposureAt`.
export function surfaceActivity(world: WorldEnv): number {
  const windMag = Math.min(1, Math.abs(world.wind) / WIND_MAX);
  return Math.max(0.05, windMag);
}

// Per-column wind exposure in [0,1]. 0 = sheltered (no waves
// regardless of wind), 1 = fully exposed. Picks the from-left map
// when wind blows right (the upwind side is to the left of x), the
// from-right map otherwise. Worlds without terrain return 1.
export function windExposureAt(world: WorldEnv, x: number): number {
  const map = world.wind >= 0 ? world.windExposureFromLeft : world.windExposureFromRight;
  if (!map || map.length === 0) return 1;
  const ix = Math.max(0, Math.min(map.length - 1, Math.floor(x)));
  return map[ix];
}

export function waveOriginAt(world: WorldEnv, x: number): number {
  const map = world.wind >= 0 ? world.waveOriginFromLeft : world.waveOriginFromRight;
  if (!map || map.length === 0) return 0;
  const ix = Math.max(0, Math.min(map.length - 1, Math.floor(x)));
  return map[ix];
}

export function surfaceYAt(world: WorldEnv, x: number): number {
  const t = world.t;
  // Amplitude derives from wind magnitude and per-column shelter.
  // Floor at 0 -- a sheltered column with calm wind is glassy.
  const windFactor = Math.min(1, Math.abs(world.wind) / WIND_MAX);
  const expo = windExposureAt(world, x);
  const A = world.surfaceWaveAmp * windFactor * expo;
  if (A <= 0) return world.surfaceY;
  // Wave propagation direction follows wind sign: positive wind blows
  // right, so waves travel +x; negative wind flips the time term.
  const dir = world.wind >= 0 ? 1 : -1;
  // Spatial phase is measured from the wave origin for this column (reset
  // at each surface-breaching rock), so the lee re-forms its own train
  // instead of a single global sine sweeping straight through the rock.
  const xr = x - waveOriginAt(world, x);
  const kS = (2 * Math.PI) / world.surfaceLength;
  const wS = (2 * Math.PI) / world.surfacePeriod;
  const kL = (2 * Math.PI) / world.swellLength;
  const wL = (2 * Math.PI) / world.swellPeriod;
  const kU = (2 * Math.PI) / world.updraftLength;
  const wU = (2 * Math.PI) / world.updraftPeriod;

  // Main gravity wave.
  let dy = A * Math.sin(kS * xr - dir * wS * t);
  // Off-rate harmonics; irrational frequency ratios + phase offsets
  // keep the surface from visibly repeating.
  dy += 0.45 * A * Math.sin(1.7 * kS * xr - dir * 1.3 * wS * t + 0.6);
  dy += 0.25 * A * Math.sin(3.1 * kS * xr + dir * 2.1 * wS * t + 1.4);
  // Longer swell contribution.
  dy += 0.7 * A * Math.sin(kL * xr + dir * 0.4 * wL * t);
  // Updraft coupling -- where updraft is pushing water up, the
  // surface bulges up.
  dy -= 0.8 * A * Math.sin(kU * xr + wU * t);
  return world.surfaceY + dy;
}

// Per-tick surface-height lookup. surfaceYAt() is ~5 Math.sin calls;
// applyWalls invokes it once per particle AND once per creature for
// the floating-surface clamp (4000+ transcendental calls/tick). The
// surface depends only on x and world.t, both constant within a
// step, so sample it across the width once and linear-interpolate.
// SURFACE_LUT_STEP=2px keeps interpolation error sub-pixel; fully
// deterministic so the reproducibility test is unaffected.
const SURFACE_LUT_STEP = 2;
let SURFACE_LUT = new Float32Array(0);
let SURFACE_LUT_N = 0;
function buildSurfaceLUT(world: World): void {
  const n = Math.max(2, Math.ceil(world.width / SURFACE_LUT_STEP) + 1);
  if (SURFACE_LUT.length < n) SURFACE_LUT = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    SURFACE_LUT[i] = surfaceYAt(world, i * SURFACE_LUT_STEP);
  }
  SURFACE_LUT_N = n;
}
function surfaceYLUT(x: number): number {
  if (SURFACE_LUT_N === 0) return SURFACE_LUT[0] ?? 0;
  let fx = x / SURFACE_LUT_STEP;
  if (fx <= 0) return SURFACE_LUT[0];
  const maxI = SURFACE_LUT_N - 1;
  if (fx >= maxI) return SURFACE_LUT[maxI];
  const i = fx | 0;
  const f = fx - i;
  const a = SURFACE_LUT[i];
  return a + (SURFACE_LUT[i + 1] - a) * f;
}

// Analytical baseline temperature at (x, y). Depth gradient + travelling
// patch wave. This is the EQUILIBRIUM the regional temperature field
// relaxes toward; it deliberately excludes vent heat, which is injected
// into the regional field as a source term in sampleRegionTemps and
// then diffuses through the grid. To read the actual local temperature
// (with vent + diffusion history baked in), use regionTempAt.
export function temperatureAt(world: WorldEnv, x: number, y: number): number {
  const span = Math.max(1, world.height - world.surfaceY);
  const depth = Math.max(0, Math.min(1, (y - world.surfaceY) / span));
  const base = world.tempSurface + (world.tempBottom - world.tempSurface) * depth;
  const kT = (2 * Math.PI) / world.tempPatchLength;
  const wT = (2 * Math.PI) / world.tempPatchPeriod;
  const patch = world.tempPatchAmp * Math.sin(kT * x + wT * world.t);
  return base + patch;
}

// Effective local temperature: reads from the diffused, state-bearing
// regionTemp field on the world (which sampleRegionTemps steps every
// tick). Falls back to the analytical baseline if the field hasn't
// been initialised yet (e.g. a freshly-built world before its first
// tick).
export function regionTempAt(world: World, x: number, y: number): number {
  const field = world.regionTemp;
  if (!field || field.length === 0) return temperatureAt(world, x, y);
  const cols = regionCols(world);
  const rows = regionRows(world);
  let rx = (x / REGION_PX) | 0; if (rx < 0) rx = 0; else if (rx >= cols) rx = cols - 1;
  let ry = (y / REGION_PX) | 0; if (ry < 0) ry = 0; else if (ry >= rows) ry = rows - 1;
  return field[ry * cols + rx];
}

// Solar light multiplier 0..1. Sin curve over dayPhase with midday at
// phase 0.25; dark half of cycle returns 0. Multiplied into the depth
// attenuation at every light-using site (photosynthesis, sensor).
export function solarLight(world: { dayPhase: number }): number {
  return Math.max(0, Math.sin(2 * Math.PI * world.dayPhase));
}

function advanceDayCycle(world: World, dt: number): void {
  world.dayPhase = (world.dayPhase + dt / world.dayPeriod) % 1;
}

// Wind state machine. Two layered behaviors:
//
//   1. Baseline drift: windTarget does a slow random walk every
//      ~5 seconds, bounded to a gentle range. Even with no events,
//      the surface always has SOME breeze.
//   2. Gust events: the old "disturbance" schedule is repurposed.
//      On a fresh event we pick a high-magnitude target (and a sign
//      so the gust can come from either direction). disturbanceIntensity
//      keeps a 0..1 envelope across the event for the legacy call
//      sites (aerate / brownian / vertical mix) that still want a
//      "weather is rough" multiplier.
//
// world.wind tracks toward windTarget with a slow time constant so
// the actual sea state lags behind the target -- waves don't switch
// direction instantly the moment the wind does.
const WIND_DRIFT_STEP_SEC = 5;     // re-roll baseline windTarget every N sec
const WIND_DRIFT_RANGE = 40;       // baseline windTarget magnitude (px/s)
const WIND_RELAX_TAU = 6;          // seconds: how fast wind follows target
const WIND_GUST_MAG_MIN = 120;     // gust event minimum |windTarget|
const WIND_GUST_MAG_MAX = WIND_MAX; // ...and ceiling
function advanceWind(world: World, dt: number): void {
  const t = world.t;
  // 1. Disturbance event scheduler (re-used as the gust trigger).
  if (world.disturbanceUntil > 0 && t >= world.disturbanceUntil) {
    world.disturbanceUntil = 0;
    world.disturbanceIntensity = 0;
  }
  if (world.disturbanceUntil === 0 && t >= world.nextDisturbanceAt) {
    const duration = 8 + simRng() * 10;
    world.disturbanceStartedAt = t;
    world.disturbanceUntil = t + duration;
    world.nextDisturbanceAt = world.disturbanceUntil + 60 + simRng() * 1140;
    // Lock in a gust direction + magnitude for the whole event.
    const sign = simRng() < 0.5 ? -1 : 1;
    const mag = WIND_GUST_MAG_MIN + simRng() * (WIND_GUST_MAG_MAX - WIND_GUST_MAG_MIN);
    world.windTarget = sign * mag;
  }
  if (world.disturbanceUntil > 0) {
    const duration = world.disturbanceUntil - world.disturbanceStartedAt;
    const f = (t - world.disturbanceStartedAt) / duration;
    let i: number;
    if (f < 0.3) i = f / 0.3;
    else if (f > 0.7) i = (1 - f) / 0.3;
    else i = 1;
    world.disturbanceIntensity = Math.max(0, Math.min(1, i));
  } else {
    // 2. Baseline drift between gusts. Sample a new target every
    // WIND_DRIFT_STEP_SEC using a stride of world.t so the schedule
    // is deterministic per world. The target is a fresh random pick
    // in [-WIND_DRIFT_RANGE, +WIND_DRIFT_RANGE]; wind relaxes
    // toward it smoothly. Floors disturbanceIntensity at 0 so the
    // legacy call sites see a calm state.
    world.disturbanceIntensity = 0;
    // Discretize sampling on the WIND_DRIFT_STEP_SEC grid.
    const lastStep = Math.floor((t - dt) / WIND_DRIFT_STEP_SEC);
    const thisStep = Math.floor(t / WIND_DRIFT_STEP_SEC);
    if (thisStep > lastStep) {
      world.windTarget = (simRng() * 2 - 1) * WIND_DRIFT_RANGE;
    }
  }
  // Exponential approach: wind += (target - wind) * (1 - exp(-dt/tau)).
  // For small dt the linearization dt/tau is accurate enough and
  // cheaper than a Math.exp per tick.
  const alpha = Math.min(1, dt / WIND_RELAX_TAU);
  world.wind += (world.windTarget - world.wind) * alpha;
}

// Static rocky terrain. Built once at world creation and never modified
// after -- the obstacle collision broad-phase (band index + cell
// bitmap) is rebuilt to match in rebuildObstacleIndex.
//
// Geometry comes from hand-authored normalized polygons in
// ./sim/terrain-shapes.ts. Each one gets scaled to the actual
// (width, height) of the world, packaged as an Obstacle via
// pushTerrainPolygon -- which lobe-packs the interior so the
// existing circle-vs-circle obstacle collision handles it -- and
// added to world.obstacles.
//
// Two derived per-column maps are built here as well:
//   - TERRAIN_HEIGHTMAP[x]: topmost rock y at column x, used as a
//     fast-path early-reject in founderTerrainBlocked.
//   - WAVE_CLIP_Y[x]: the y the wavy water surface clamps to when
//     a rock cliff pierces the still water level at column x.
//     Without this, the wave line would slide right through any
//     rock that pokes above the still surface (the top-left cliff
//     in the layout). Consumed by surfaceYAt.
const TERRAIN_ENABLED = true;

export function generateObstacles(world: World): void {
  world.obstacles = [];
  world.terrainHeightmap = undefined;
  if (!TERRAIN_ENABLED) return;
  const W = world.width;
  const H = world.height;
  // Single shared earth-tone for all rocks. The per-pixel texture pass
  // (buildTerrainBitmap in main.ts) modulates this with value noise +
  // directional lighting + crack mask; keeping one base tone here
  // avoids "this rock is darker than that one for no reason" patches.
  const baseTone = "#4a4038";
  for (const poly of ROCK_POLYGONS) {
    pushTerrainPolygon(world, scalePolygon(poly, W, H), baseTone);
  }

  // Per-column heightmap: topmost rock y per integer x across every
  // obstacle. Used as a cheap early-reject in founderTerrainBlocked /
  // topTerrainYAtColumn. founderTerrainBlocked falls through to a
  // per-obstacle lobe check anyway, so this is purely a fast-path hint
  // -- a column that has rock high up but clear water below still gets
  // the heightmap top, and the lobe sweep refines the actual
  // overlap. Initialized to +Inf so columns with no rock report
  // "open water" via the existing semantics.
  const heightmap = new Float32Array(Math.max(1, Math.floor(W)));
  heightmap.fill(Number.POSITIVE_INFINITY);
  for (const ob of world.obstacles) {
    if (!ob.polygon) continue;
    const x0 = Math.max(0, Math.floor(ob.minX));
    const x1 = Math.min(heightmap.length - 1, Math.ceil(ob.maxX));
    for (let x = x0; x <= x1; x++) {
      // Top y at this column = smallest y the polygon covers (y down).
      // Done by ray-casting at integer x: find min y where the polygon
      // interior begins. Cheap (one ray per column, <50 vertices).
      let topY = Number.POSITIVE_INFINITY;
      // Walk vertical edges of the polygon; the smallest y where the
      // ray (x = const) crosses an edge bounds the polygon span. Then
      // we also accept any vertex with the matching x range -- a flat
      // top edge contributes only its endpoints to crossings.
      const poly = ob.polygon;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y;
        const xj = poly[j].x, yj = poly[j].y;
        if ((xi <= x && xj >= x) || (xj <= x && xi >= x)) {
          if (xi === xj) {
            // Vertical edge: every y on it is a potential top.
            if (yi < topY) topY = yi;
            if (yj < topY) topY = yj;
          } else {
            const t = (x - xi) / (xj - xi);
            const y = yi + (yj - yi) * t;
            if (y < topY) topY = y;
          }
        }
      }
      if (topY < heightmap[x]) heightmap[x] = topY;
    }
  }

  world.terrainHeightmap = heightmap;

  // Wind exposure maps. cliffHeight[x] = how far above the still
  // water surface the rock extends at column x (0 if no rock pokes
  // out of the water). A tall cliff casts a wind shadow downwind
  // proportional to its height; exposure ramps from 0 right behind
  // the cliff back up to 1 over SHELTER_DIST_MAX pixels.
  const stillSurfaceY = H * SURFACE_Y_FRAC;
  const cliffHeight = new Float32Array(heightmap.length);
  for (let x = 0; x < heightmap.length; x++) {
    const top = heightmap[x];
    if (top !== Number.POSITIVE_INFINITY && top < stillSurfaceY) {
      cliffHeight[x] = stillSurfaceY - top;
    }
  }
  // Shelter distance scales linearly with cliff height so a tiny
  // bump shelters only a few px while a tall cliff shelters far
  // downwind.
  const SHELTER_DIST_PER_HEIGHT = 2;
  const SHELTER_DIST_MAX = 180;
  const buildExposureMap = (fromLeft: boolean): Float32Array => {
    const m = new Float32Array(heightmap.length);
    m.fill(1);
    // For each column, scan UPWIND looking for the tallest cliff
    // within shelter range. The shadow decays linearly with distance.
    const step = fromLeft ? -1 : 1;
    for (let x = 0; x < heightmap.length; x++) {
      // If rock fills this column in the air band, exposure 0.
      if (cliffHeight[x] > 0 && heightmap[x] <= 1) { m[x] = 0; continue; }
      let bestShadow = 0;
      const maxScan = SHELTER_DIST_MAX;
      for (let d = 1; d <= maxScan; d++) {
        const ux = x + step * d;
        if (ux < 0 || ux >= heightmap.length) break;
        const ch = cliffHeight[ux];
        if (ch <= 0) continue;
        const reach = Math.min(SHELTER_DIST_MAX, ch * SHELTER_DIST_PER_HEIGHT);
        if (d > reach) continue;
        // Shelter strength: cliff height normalized vs surfaceY, with
        // linear distance falloff.
        const strength = Math.min(1, ch / stillSurfaceY) * (1 - d / reach);
        if (strength > bestShadow) bestShadow = strength;
      }
      m[x] = Math.max(0, 1 - bestShadow);
    }
    return m;
  };
  world.windExposureFromLeft = buildExposureMap(true);
  world.windExposureFromRight = buildExposureMap(false);

  // Wave-origin maps: the spatial phase reference for each column. As the
  // wave train sweeps in from the upwind edge, every surface-breaching
  // rock resets the origin to its own (downwind) edge, so leeward water
  // re-forms its own waves from the rock rather than continuing the
  // windward phase. Without this the surface is one global sine and a
  // crest appears to translate straight through a rock.
  const buildWaveOrigin = (fromLeft: boolean): Float32Array => {
    const m = new Float32Array(cliffHeight.length);
    if (fromLeft) {
      let origin = 0;
      for (let x = 0; x < cliffHeight.length; x++) {
        if (cliffHeight[x] > 0) origin = x; // tracks to the rock's far edge
        m[x] = origin;
      }
    } else {
      let origin = cliffHeight.length - 1;
      for (let x = cliffHeight.length - 1; x >= 0; x--) {
        if (cliffHeight[x] > 0) origin = x;
        m[x] = origin;
      }
    }
    return m;
  };
  world.waveOriginFromLeft = buildWaveOrigin(true);
  world.waveOriginFromRight = buildWaveOrigin(false);

  // Vent: anchor it at the normalized VENT_ORIGIN inside the seafloor
  // notch. Per-world vent state (next eruption time, current phase)
  // resets here so a fresh world is dormant for the first cycle.
  initVent(world, VENT_ORIGIN.x * W, VENT_ORIGIN.y * H);
}

// Install the vent state on the world. Stays consistent with the
// generateObstacles entry point: the vent anchor is in world coords
// (computed there from the VENT_ORIGIN normalized point) so test
// scaffolds that bypass generateObstacles never get a vent unless they
// opt in. ventEmitted ledger is sized to MOLECULE_IDS.length so the
// mass-conservation ledger has one slot per molecule.
function initVent(world: World, x: number, y: number): void {
  world.vent = makeVentState(x, y, world.dayPeriod, simRng);
  if (!world.ventEmitted) {
    world.ventEmitted = new Float64Array(MOLECULE_IDS.length);
  } else {
    world.ventEmitted.fill(0);
  }
}

// Tick the vent. Wrapped here so the vent module stays free of the
// pushParticle import (which would pull in the whole sim graph). Skip
// when the world has no vent installed (test scaffolds).
//
// Global-saturation gate: the vent still cycles (phase machine,
// intensity envelope, heat injection) at all times, but emits no
// particles when any of its emission chems is at >=
// VENT_SATURATION_FRAC of global dissolved capacity. This caps the
// vent's pile-up potential without freezing the cycle.
const VENT_SATURATION_FRAC = 0.10;
function ventEmissionsBlocked(world: World): boolean {
  const amb = world.ambient;
  const cols = regionCols(world);
  const rows = regionRows(world);
  const nReg = cols * rows;
  for (const chem of VENT_EMISSION_CHEMS) {
    let amount = 0;
    let cap = 0;
    for (let ri = 0; ri < nReg; ri++) {
      amount += amb[ri * AMBIENT_STRIDE + chem];
      const tReg = world.regionTemp.length > ri ? world.regionTemp[ri] : TEMP_BASELINE;
      cap += regionDissolvedCapacity(chem, world, tReg);
    }
    if (cap > 0 && amount >= VENT_SATURATION_FRAC * cap) return true;
  }
  return false;
}
function runVent(world: World, dt: number): void {
  if (!world.vent) return;
  // Respect the particle cap so the vent can't push the world over the
  // overflow band even at peak intensity.
  const cap = effectiveParticleCap(world);
  const blocked = ventEmissionsBlocked(world);
  stepVent(world, dt, simRng, (x, y, z, vx, vy, vz, r, chemId, density, molecules) => {
    if (world.particles.length >= cap) return;
    pushParticle(world, { x, y, z, vx, vy, vz, r, chemId, density, molecules });
  }, blocked);
  ventFuelSeep(world);
}

// Continuous reduced-fuel seep: the vent maintains a bounded standing
// pool of its reduced-generic fuel cocktail (CHEMOLITH's VENT_FUEL_CHEMS)
// in a zone around the mouth, independent of the eruption cycle -- the
// always-on chemical analog of the always-on heat. This is what makes a
// non-photic chemolithoautotroph niche viable in the open world: dense
// (sinks, pools on the floor) reduced chems that an evolved `SYNTH CAT`
// energy catalyst can oxidize. Bounded by the standing target so the
// influx never runs away; topped a little per tick as cells eat it.
// The seep maintains the reduced-fuel cocktail PLUS a marker0 beacon: a
// vent-only tracer chemolithoautotrophs home on (SENSE_OUT marker0) to
// park on the fuel instead of drifting off to starve.
const VENT_SEEP_CHEMS: number[] = [...VENT_FUEL_CHEMS, CHEM_MARKER0];
const VENT_FUEL_SET: ReadonlySet<number> = new Set(VENT_SEEP_CHEMS);
const VENT_FUEL_STANDING = 460;    // particles held in the seep zone
const VENT_FUEL_ZONE_PX = 150;     // seep/count radius around the mouth
const VENT_FUEL_DENSITY = 1.25;    // > water: fuel sinks and pools by the vent
const VENT_FUEL_BATCH_MAX = 32;    // cap emitted per tick (ramp, not dump)
function ventFuelSeep(world: World): void {
  const v = world.vent;
  if (!v || VENT_FUEL_CHEMS.length === 0) return;
  const seepChems = VENT_SEEP_CHEMS;
  const cap = effectiveParticleCap(world);
  if (world.particles.length >= cap) return;
  const zone2 = VENT_FUEL_ZONE_PX * VENT_FUEL_ZONE_PX;
  let have = 0;
  for (const p of world.particles) {
    if (!VENT_FUEL_SET.has(p.chemId)) continue;
    const dx = p.x - v.x, dy = p.y - v.y;
    if (dx * dx + dy * dy < zone2) have++;
  }
  let need = VENT_FUEL_STANDING - have;
  if (need <= 0) return;
  if (need > VENT_FUEL_BATCH_MAX) need = VENT_FUEL_BATCH_MAX;
  let rot = world.particles.length;
  while (need-- > 0 && world.particles.length < cap) {
    const r = 1 + simRng() * 0.8;
    pushParticle(world, {
      x: v.x + (simRng() - 0.5) * VENT_FUEL_ZONE_PX * 1.4,
      y: v.y - 4 - simRng() * 12,
      z: world.depth * 0.5 + (simRng() - 0.5) * 10,
      vx: (simRng() - 0.5) * 12,
      vy: -12 * simRng(),
      vz: 0,
      r,
      chemId: seepChems[rot++ % seepChems.length],
      density: VENT_FUEL_DENSITY,
    });
  }
}


// Per-world derived terrain maps. Stored on World so test scaffolds
// that swap worlds across describe blocks don't leak stale terrain
// state into a quietWorld() that should be open water everywhere.
// generateObstacles populates world.terrainHeightmap; callers below
// read directly from the world.

// True if a candidate body of radius `bodyR` centered at (x, y) would
// overlap any rock. Conservative: tests the candidate disc against
// every obstacle's lobes, which is what the runtime collision pass
// would push out anyway. Used at founder spawn so cells don't enter
// inside the cave, under an outcropping, or stuck in the seafloor.
function founderTerrainBlocked(world: World, x: number, y: number, bodyR: number): boolean {
  // Per-obstacle lobe test against every rock. With ~5 obstacles and
  // ~30 lobes each this is ~150 ops per attempt -- fine. (The
  // heightmap fast-path that used to short-circuit here only worked
  // for a monotonic seafloor; the hand-authored layout has top-down
  // cliffs that don't fit that assumption, so we rely solely on the
  // lobe sweep now.)
  for (const ob of world.obstacles) {
    if (x + bodyR < ob.minX || x - bodyR > ob.maxX) continue;
    if (y + bodyR < ob.minY || y - bodyR > ob.maxY) continue;
    const lobes = ob.lobes;
    for (let j = 0; j < lobes.length; j++) {
      const l = lobes[j];
      const dx = x - l.x;
      const dy = y - l.y;
      const minDist = bodyR + l.r;
      if (dx * dx + dy * dy < minDist * minDist) return true;
    }
  }
  return false;
}

// Topmost rock surface at column x. Looks up world.terrainHeightmap;
// returns +Inf for columns with no rock (or worlds without terrain).
export function topTerrainYAtColumn(world: World, x: number): number {
  const hm = world.terrainHeightmap;
  if (!hm || hm.length === 0) return Infinity;
  const ix = Math.max(0, Math.min(hm.length - 1, Math.floor(x)));
  return hm[ix];
}

// Push a terrain polygon as an Obstacle with lobes packed inside.
// Centralizes the bounding-box / color / z bookkeeping the loop in
// generateObstacles used to repeat per rock.
function pushTerrainPolygon(world: World, polygon: { x: number; y: number }[], color: string): void {
  if (polygon.length < 3) return;
  const lobes = lobesFromTerrainPolygon(polygon);
  const ob = makeObstacleFromLobes(lobes, color);
  ob.polygon = polygon;
  ob.z = 0;
  for (const v of polygon) {
    if (v.x < ob.minX) ob.minX = v.x;
    if (v.y < ob.minY) ob.minY = v.y;
    if (v.x > ob.maxX) ob.maxX = v.x;
    if (v.y > ob.maxY) ob.maxY = v.y;
  }
  world.obstacles.push(ob);
}

// Pack a polygon's interior with collision lobes. Strategy: rasterize
// a coarse interior grid (one sample every LOBE_PITCH px), keep any
// grid point that's >=LOBE_R inside the polygon, drop a lobe there.
// Yields a "+"-pattern fill that conservatively underapproximates
// the polygon -- particles never tunnel through, but a particle can
// graze a polygon corner without contact. Acceptable for terrain.
function lobesFromTerrainPolygon(polygon: { x: number; y: number }[]): ObstacleLobe[] {
  // Coarse-ish lobe packing -- evacuateRocks is the definitive
  // "inside rock" check via polygon point-in-polygon, so the lobes
  // only need to handle the cheap radial-pushback case for bodies
  // skimming the boundary. Anything that gets all the way inside a
  // polygon is dealt with by the evacuation pass.
  const LOBE_R = 9;
  const LOBE_PITCH = 12;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const v of polygon) {
    if (v.x < minX) minX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.x > maxX) maxX = v.x;
    if (v.y > maxY) maxY = v.y;
  }
  const lobes: ObstacleLobe[] = [];
  // Sample grid. Offset by half-pitch so two adjacent thin polygons
  // (e.g. cave ceiling + lip) don't share a sample row and end up
  // with concentric lobes redundantly covering the boundary.
  for (let y = minY + LOBE_PITCH * 0.5; y <= maxY; y += LOBE_PITCH) {
    for (let x = minX + LOBE_PITCH * 0.5; x <= maxX; x += LOBE_PITCH) {
      if (pointInPolygon(x, y, polygon)) {
        lobes.push({ x, y, r: LOBE_R });
      }
    }
  }
  // Edge fallback: a sliver polygon (e.g. very thin lip) might fit no
  // interior sample. Drop a small lobe at each vertex so collision
  // still has SOMETHING to push off.
  if (lobes.length === 0) {
    for (const v of polygon) lobes.push({ x: v.x, y: v.y, r: LOBE_R * 0.6 });
  }
  return lobes;
}

// Standard ray-cast point-in-polygon. Used by the lobe packer above.
function pointInPolygon(x: number, y: number, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function makeObstacleFromLobes(lobes: ObstacleLobe[], color: string): Obstacle {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of lobes) {
    if (l.x - l.r < minX) minX = l.x - l.r;
    if (l.y - l.r < minY) minY = l.y - l.r;
    if (l.x + l.r > maxX) maxX = l.x + l.r;
    if (l.y + l.r > maxY) maxY = l.y + l.r;
  }
  return { minX, minY, maxX, maxY, lobes, color, z: 0 };
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
// Per-cell bitmap: 1 if any obstacle (with particle-radius margin)
// touches the cell. Lets collideObstaclesSoa reject a particle that
// happens to be in a gap between obstacles with a single byte read,
// avoiding the per-band-obstacle AABB sweep + ~30-lobe inner loop on
// what is the dominant in-transit-particle population near the floor.
const OBSTACLE_CELL_SIZE = 12;
let OBSTACLE_CELL_GRID: Uint8Array = new Uint8Array(0);
let OBSTACLE_CELL_COLS = 0;
let OBSTACLE_CELL_ROWS = 0;

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
  // Build the cell-level bitmap. Margin matches the band index so the
  // worst-case particle just touching the AABB still hits the bitmap.
  OBSTACLE_CELL_COLS = Math.max(1, Math.ceil(world.width / OBSTACLE_CELL_SIZE));
  OBSTACLE_CELL_ROWS = Math.max(1, Math.ceil(world.height / OBSTACLE_CELL_SIZE));
  const cellCount = OBSTACLE_CELL_COLS * OBSTACLE_CELL_ROWS;
  if (OBSTACLE_CELL_GRID.length !== cellCount) {
    OBSTACLE_CELL_GRID = new Uint8Array(cellCount);
  } else {
    OBSTACLE_CELL_GRID.fill(0);
  }
  for (const ob of world.obstacles) {
    const x0 = Math.max(0, Math.floor((ob.minX - margin) / OBSTACLE_CELL_SIZE));
    const x1 = Math.min(OBSTACLE_CELL_COLS - 1, Math.floor((ob.maxX + margin) / OBSTACLE_CELL_SIZE));
    const y0 = Math.max(0, Math.floor((ob.minY - margin) / OBSTACLE_CELL_SIZE));
    const y1 = Math.min(OBSTACLE_CELL_ROWS - 1, Math.floor((ob.maxY + margin) / OBSTACLE_CELL_SIZE));
    for (let y = y0; y <= y1; y++) {
      const row = y * OBSTACLE_CELL_COLS;
      for (let x = x0; x <= x1; x++) OBSTACLE_CELL_GRID[row + x] = 1;
    }
  }
}

// Rock evacuation safety net. Particle-rock collision
// (resolveObstacleCollisions / collideObstaclesSoa) is the primary
// mechanism that keeps particles out of rock -- it pushes any
// overlap back along the polygon normal with restitution. This pass
// is a strict fallback: if a particle's CENTER ended up inside a
// polygon (e.g. a wave-clamp landed it there, or a between-tick
// position update tunneled it past a thin feature), dump its mass
// into the local ambient pool and remove the particle. Creatures
// get teleported to just past the nearest edge so they keep their
// state.
//
// Mass-conserving on both paths.
function evacuateRocks(world: World): void {
  if (world.obstacles.length === 0) return;
  const ambient = world.ambient;
  const store = world.particleStore;
  const FOUR_THIRDS_PI = (4 / 3) * Math.PI;
  // Cell-bitmap fast-reject: a single byte read skips particles in
  // cells that contain no rock at all. With margin=0 (set in
  // rebuildObstacleIndex), this rejects only the genuinely-clear
  // cells; particles within the boundary cell still go through the
  // polygon test below.
  const cellGrid = OBSTACLE_CELL_GRID;
  const cellCols = OBSTACLE_CELL_COLS;
  const cellRows = OBSTACLE_CELL_ROWS;
  const cellSize = OBSTACLE_CELL_SIZE;
  const obstacles = world.obstacles;
  // Particles. Iterate backwards because removeParticleAt swap-pops.
  for (let i = world.particles.length - 1; i >= 0; i--) {
    const px = store.x[i], py = store.y[i];
    if (cellGrid.length === 0) break; // no terrain -- nothing to do
    const cx = Math.floor(px / cellSize);
    const cy = Math.floor(py / cellSize);
    if (cx < 0 || cx >= cellCols || cy < 0 || cy >= cellRows) continue;
    if (cellGrid[cy * cellCols + cx] === 0) continue;
    // Cell flagged rocky -- run the polygon test. Only an actual
    // inside-polygon hit triggers dissolution; particles RESTING ON
    // the rock surface stay (their centers sit on the water side of
    // the edge).
    let inside = false;
    for (let k = 0; k < obstacles.length; k++) {
      const ob = obstacles[k];
      if (px < ob.minX || px > ob.maxX || py < ob.minY || py > ob.maxY) continue;
      const poly = ob.polygon;
      if (!poly) continue;
      if (pointInPolygon(px, py, poly)) { inside = true; break; }
    }
    if (!inside) continue;
    // In rock -- dissolve. Mass to local ambient.
    const base = ambientBaseAt(world, px, py);
    const mol = store.molecules[i];
    if (mol) {
      for (let k = 0; k < NAMED_CHEMICALS.length; k++) {
        const v = mol[NAMED_CHEMICALS[k]];
        if (v > 0) ambient[base + k] += v;
      }
    } else {
      const r = store.r[i];
      const chemId = store.chemId[i];
      const density = store.density[i] !== 0 ? store.density[i] : CHEM_BASE_DENSITY[chemId];
      // ambient stores AMOUNT (moles), particle holds PHYSICAL MASS.
      // Convert mass -> moles via molar mass on the way in. Skipping the
      // conversion meant every evacuation cycle inflated ambient by a
      // factor of molarMass; combined with precipitate re-spawning
      // particles that the next evacuator pass could re-ingest, this
      // was an autocatalytic mass source for any chem with molarMass != 1
      // (i.e. every generic chem).
      const mass = density * FOUR_THIRDS_PI * r * r * r;
      const mm = CHEM_MM[chemId] || 1;
      ambient[base + chemId] += mass / mm;
    }
    removeParticleAt(world, i);
  }
  // Creatures. Polygon-based push: find nearest edge point, teleport
  // to a safe distance past it.
  for (const c of world.creatures) {
    const cx = c.x, cy = c.y;
    if (cellGrid.length > 0) {
      const ccx = Math.floor(cx / cellSize);
      const ccy = Math.floor(cy / cellSize);
      if (ccx < 0 || ccx >= cellCols || ccy < 0 || ccy >= cellRows) continue;
      if (cellGrid[ccy * cellCols + ccx] === 0) continue;
    }
    let insideOb: Obstacle | null = null;
    for (const ob of world.obstacles) {
      if (!ob.polygon) continue;
      if (cx < ob.minX || cx > ob.maxX || cy < ob.minY || cy > ob.maxY) continue;
      if (pointInPolygon(cx, cy, ob.polygon)) { insideOb = ob; break; }
    }
    if (!insideOb) continue;
    const np = nearestPolygonEdgePoint(cx, cy, insideOb.polygon!);
    const dx = np.x - cx, dy = np.y - cy;
    const d = Math.hypot(dx, dy);
    if (d > 1e-6) {
      // Direction from inside-point to the edge IS the outward
      // direction; teleport `margin` past the edge along it.
      const margin = c.r + 2;
      const ux = dx / d, uy = dy / d;
      c.x = np.x + ux * margin;
      c.y = np.y + uy * margin;
      // Kill any inward velocity that would push the creature right
      // back into the rock on the next physics tick.
      const vDotU = c.vx * ux + c.vy * uy;
      if (vDotU > 0) {
        c.vx -= vDotU * ux;
        c.vy -= vDotU * uy;
      }
    }
  }
}

// Closest point on a polygon's boundary to (qx, qy). Walks every
// edge and projects the query onto each segment; returns the
// projection nearest in Euclidean distance.
function nearestPolygonEdgePoint(
  qx: number, qy: number, poly: { x: number; y: number }[],
): { x: number; y: number } {
  let bestX = poly[0].x, bestY = poly[0].y, bestD = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j].x, ay = poly[j].y;
    const bx = poly[i].x, by = poly[i].y;
    const ex = bx - ax, ey = by - ay;
    const lenSq = ex * ex + ey * ey;
    let t = 0;
    if (lenSq > 1e-12) {
      t = ((qx - ax) * ex + (qy - ay) * ey) / lenSq;
      if (t < 0) t = 0; else if (t > 1) t = 1;
    }
    const px = ax + ex * t, py = ay + ey * t;
    const dx = px - qx, dy = py - qy;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; bestX = px; bestY = py; }
  }
  return { x: bestX, y: bestY };
}

function resolveObstacleCollisions(world: World): void {
  if (world.obstacles.length === 0) return;
  const minY = OBSTACLES_MIN_Y;
  const ps = world.particleStore;
  const pn = world.particles.length;
  // Skip asleep (sediment) particles. They were resolved against any
  // obstacle they touched when they fell asleep, and they don't move
  // on their own once asleep -- so each tick of obstacle collision on
  // them is pure waste. Without this skip, oColl scales with sediment
  // accumulation: at np=2325 it grew from 0.16ms to >1.5ms/tick over
  // a few minutes of sim time, dominating the worker budget.
  // COLLISION_ASLEEP is populated by resolveCollisions which runs
  // earlier in step().
  collideObstaclesSoa(ps.x, ps.y, ps.vx, ps.vy, ps.r, COLLISION_ASLEEP, pn, world.restitution, minY, 0);
  const cn = world.creatures.length;
  // Creatures may belong to different stores (test fixtures use
  // private stores). Per-creature hoist into the right typed arrays.
  for (let k = 0; k < cn; k++) {
    const c = world.creatures[k];
    const cs = c.store;
    collideObstaclesSoaSingle(cs.x, cs.y, cs.vx, cs.vy, cs.r, c.idx, 0.1, minY);
  }
}

// One-particle/creature variant: same math as the array sweep, fixed
// to slot idx. Used for creature obstacle collision since each cell
// can live in a different store.
function collideObstaclesSoaSingle(
  X: Float32Array, Y: Float32Array, VX: Float32Array, VY: Float32Array, R: Float32Array,
  idx: number, e: number, minY: number,
): void {
  if (OBSTACLE_BANDS_COLS <= 0) return;
  const rk = R[idx];
  if (Y[idx] + rk < minY) return;
  const xk = X[idx], yk = Y[idx];
  if (xk !== xk || yk !== yk || rk !== rk) return;
  // Cell-bitmap early exit -- same idea as the particle loop above.
  const cellSize = OBSTACLE_CELL_SIZE;
  const cellCols = OBSTACLE_CELL_COLS;
  const cellRows = OBSTACLE_CELL_ROWS;
  let gcx = (xk / cellSize) | 0;
  let gcy = (yk / cellSize) | 0;
  if (gcx < 0) gcx = 0; else if (gcx >= cellCols) gcx = cellCols - 1;
  if (gcy < 0) gcy = 0; else if (gcy >= cellRows) gcy = cellRows - 1;
  if (!OBSTACLE_CELL_GRID[gcy * cellCols + gcx]) return;
  let bx = Math.floor(xk / OBSTACLE_BAND_W);
  if (bx < 0) bx = 0; else if (bx >= OBSTACLE_BANDS_COLS) bx = OBSTACLE_BANDS_COLS - 1;
  const obs = OBSTACLE_BANDS[bx];
  let ox = xk, oy = yk, ovx = VX[idx], ovy = VY[idx];
  for (let i = 0; i < obs.length; i++) {
    const ob = obs[i];
    if (ox + rk < ob.minX || ox - rk > ob.maxX) continue;
    if (oy + rk < ob.minY || oy - rk > ob.maxY) continue;
    const poly = ob.polygon;
    if (poly) {
      const lobes = ob.lobes;
      let nearLobe = false;
      for (let j = 0; j < lobes.length; j++) {
        const l = lobes[j];
        const dx = ox - l.x;
        const dy = oy - l.y;
        const minDist = rk + l.r;
        if (dx * dx + dy * dy < minDist * minDist) { nearLobe = true; break; }
      }
      if (!nearLobe) continue;
      let bestX = 0, bestY = 0, bestD2 = Infinity;
      let crossings = 0;
      const PL = poly.length;
      for (let jj = PL - 1, j2 = 0; j2 < PL; jj = j2++) {
        const ax = poly[jj].x, ay = poly[jj].y;
        const bxp = poly[j2].x, byp = poly[j2].y;
        const ex = bxp - ax, ey = byp - ay;
        const lenSq = ex * ex + ey * ey;
        let t = 0;
        if (lenSq > 1e-12) {
          t = ((ox - ax) * ex + (oy - ay) * ey) / lenSq;
          if (t < 0) t = 0; else if (t > 1) t = 1;
        }
        const epx = ax + ex * t, epy = ay + ey * t;
        const ddx = epx - ox, ddy = epy - oy;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 < bestD2) { bestD2 = d2; bestX = epx; bestY = epy; }
        if ((ay > oy) !== (byp > oy)) {
          const xInt = (bxp - ax) * (oy - ay) / (byp - ay + 1e-12) + ax;
          if (ox < xInt) crossings++;
        }
      }
      const isInside = (crossings & 1) === 1;
      const d = Math.sqrt(bestD2);
      if (!isInside && d >= rk) continue;
      let nx, ny, depth;
      if (d < 1e-6) { nx = 1; ny = 0; depth = isInside ? rk : 0; }
      else if (isInside) {
        nx = (bestX - ox) / d;
        ny = (bestY - oy) / d;
        depth = rk + d;
      } else {
        nx = (ox - bestX) / d;
        ny = (oy - bestY) / d;
        depth = rk - d;
      }
      ox += nx * depth;
      oy += ny * depth;
      const vN = ovx * nx + ovy * ny;
      if (vN < 0) {
        ovx -= (1 + e) * vN * nx;
        ovy -= (1 + e) * vN * ny;
      }
    } else {
      const lobes = ob.lobes;
      for (let j = 0; j < lobes.length; j++) {
        const l = lobes[j];
        const dx = ox - l.x;
        const dy = oy - l.y;
        const minDist = rk + l.r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= minDist * minDist) continue;
        let d = Math.sqrt(d2);
        let nx = 0, ny = -1;
        if (d < 1e-6) { d = 1; nx = 1; ny = 0; }
        else { nx = dx / d; ny = dy / d; }
        const overlap = minDist - d;
        ox += nx * overlap;
        oy += ny * overlap;
        const vN = ovx * nx + ovy * ny;
        if (vN < 0) {
          ovx -= (1 + e) * vN * nx;
          ovy -= (1 + e) * vN * ny;
        }
      }
    }
  }
  X[idx] = ox; Y[idx] = oy; VX[idx] = ovx; VY[idx] = ovy;
}

// Contiguous-index version: used for particles where slot i corresponds
// to world.particles[i]. No indirection.
function collideObstaclesSoa(
  X: Float32Array, Y: Float32Array, VX: Float32Array, VY: Float32Array, R: Float32Array,
  ASLEEP: Uint8Array,
  n: number, e: number, minY: number, _pad: number,
): void {
  void _pad;
  void ASLEEP;
  // Defensive: if the obstacle index wasn't built (cols=0) the per-
  // particle clamp below would land bx at -1 and throw on undefined.
  if (OBSTACLE_BANDS_COLS <= 0) return;
  const cellSize = OBSTACLE_CELL_SIZE;
  const cellCols = OBSTACLE_CELL_COLS;
  const cellRows = OBSTACLE_CELL_ROWS;
  // ASLEEP used to gate this loop, on the assumption that an
  // asleep particle = a frozen particle. That held when the only
  // floor was a particle-pebble bed: pebbles slept at the world
  // floor and the force loop genuinely zeroed their velocity. With
  // the procedural rock terrain, "asleep" still gets set for any
  // particle moving below SLEEP_SPEED_SQ -- including particles
  // resting on top of seafloor rock -- but the force loop only
  // freezes particles touching the world floor (y + r >= floorY).
  // Asleep particles on a rock surface still get buoyancy + brownian
  // applied, accumulate a slow drift, and tunnel into the rock since
  // this loop never runs for them. Drop the ASLEEP skip; the
  // OBSTACLE_CELL_GRID early-reject below is the real fast path.
  for (let k = 0; k < n; k++) {
    const yk = Y[k]; const rk = R[k];
    if (yk + rk < minY) continue;
    const xk = X[k];
    // NaN in any of the coordinate / radius reads would propagate
    // through Math.floor and bypass both clamp branches (every NaN
    // comparison is false), leaving bx as NaN and OBSTACLE_BANDS[NaN]
    // as undefined. Skip and let upstream code recover the particle.
    if (xk !== xk || yk !== yk || rk !== rk) continue;
    // Cell-bitmap early exit: a single byte read rejects particles in
    // obstacle-free cells before the per-band AABB sweep.
    let gcx = (xk / cellSize) | 0;
    let gcy = (yk / cellSize) | 0;
    if (gcx < 0) gcx = 0; else if (gcx >= cellCols) gcx = cellCols - 1;
    if (gcy < 0) gcy = 0; else if (gcy >= cellRows) gcy = cellRows - 1;
    if (!OBSTACLE_CELL_GRID[gcy * cellCols + gcx]) continue;
    let bx = Math.floor(xk / OBSTACLE_BAND_W);
    if (bx < 0) bx = 0; else if (bx >= OBSTACLE_BANDS_COLS) bx = OBSTACLE_BANDS_COLS - 1;
    const obs = OBSTACLE_BANDS[bx];
    let ox = xk, oy = yk, ovx = VX[k], ovy = VY[k];
    for (let i = 0; i < obs.length; i++) {
      const ob = obs[i];
      if (ox + rk < ob.minX || ox - rk > ob.maxX) continue;
      if (oy + rk < ob.minY || oy - rk > ob.maxY) continue;
      const poly = ob.polygon;
      if (poly) {
        // Polygon-edge collision: gives smooth contour-following rest
        // positions, vs the lobe-grid quantization that left particles
        // pinned at fixed y-levels regardless of the actual rock
        // shape. The lobes still drive the spatial index; we use them
        // only as a fast reject before the O(V) polygon walk.
        const lobes = ob.lobes;
        let nearLobe = false;
        for (let j = 0; j < lobes.length; j++) {
          const l = lobes[j];
          const dx = ox - l.x;
          const dy = oy - l.y;
          const minDist = rk + l.r;
          if (dx * dx + dy * dy < minDist * minDist) { nearLobe = true; break; }
        }
        if (!nearLobe) continue;
        // Walk the polygon's edges to find the nearest edge point AND
        // count horizontal-ray crossings for an inside/outside test in
        // the same pass. Inside particles (from a between-tick step
        // that landed in rock) get pushed OUT through the nearest edge.
        let bestX = 0, bestY = 0, bestD2 = Infinity;
        let crossings = 0;
        const PL = poly.length;
        for (let jj = PL - 1, j2 = 0; j2 < PL; jj = j2++) {
          const ax = poly[jj].x, ay = poly[jj].y;
          const bxp = poly[j2].x, byp = poly[j2].y;
          const ex = bxp - ax, ey = byp - ay;
          const lenSq = ex * ex + ey * ey;
          let t = 0;
          if (lenSq > 1e-12) {
            t = ((ox - ax) * ex + (oy - ay) * ey) / lenSq;
            if (t < 0) t = 0; else if (t > 1) t = 1;
          }
          const epx = ax + ex * t, epy = ay + ey * t;
          const ddx = epx - ox, ddy = epy - oy;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 < bestD2) { bestD2 = d2; bestX = epx; bestY = epy; }
          if ((ay > oy) !== (byp > oy)) {
            const xInt = (bxp - ax) * (oy - ay) / (byp - ay + 1e-12) + ax;
            if (ox < xInt) crossings++;
          }
        }
        const isInside = (crossings & 1) === 1;
        const d = Math.sqrt(bestD2);
        if (!isInside && d >= rk) continue;
        let nx, ny, depth;
        if (d < 1e-6) { nx = 1; ny = 0; depth = isInside ? rk : 0; }
        else if (isInside) {
          nx = (bestX - ox) / d;
          ny = (bestY - oy) / d;
          depth = rk + d;
        } else {
          nx = (ox - bestX) / d;
          ny = (oy - bestY) / d;
          depth = rk - d;
        }
        ox += nx * depth;
        oy += ny * depth;
        const vN = ovx * nx + ovy * ny;
        if (vN < 0) {
          ovx -= (1 + e) * vN * nx;
          ovy -= (1 + e) * vN * ny;
        }
      } else {
        // Fallback: no polygon outline -> use lobe pushback as before.
        const lobes = ob.lobes;
        for (let j = 0; j < lobes.length; j++) {
          const l = lobes[j];
          const dx = ox - l.x;
          const dy = oy - l.y;
          const minDist = rk + l.r;
          const d2 = dx * dx + dy * dy;
          if (d2 >= minDist * minDist) continue;
          let d = Math.sqrt(d2);
          let nx = 0, ny = -1;
          if (d < 1e-6) { d = 1; nx = 1; ny = 0; }
          else { nx = dx / d; ny = dy / d; }
          const overlap = minDist - d;
          ox += nx * overlap;
          oy += ny * overlap;
          const vN = ovx * nx + ovy * ny;
          if (vN < 0) {
            ovx -= (1 + e) * vN * nx;
            ovy -= (1 + e) * vN * ny;
          }
        }
      }
    }
    X[k] = ox; Y[k] = oy; VX[k] = ovx; VY[k] = ovy;
  }
}

// Scatter-index version: used for creatures whose store slots are
// non-contiguous after free-list reuse. idx[k] maps world.creatures[k]
// to its slot in the typed arrays.
function tempMult(T: number): number {
  const m = Math.pow(TEMP_Q10, (T - TEMP_REF) / 10);
  return Math.max(TEMP_MULT_MIN, Math.min(TEMP_MULT_MAX, m));
}

// Live simulation RNG. Every nondeterministic draw in the stepping
// path and in world setup goes through this so a world can be made
// fully reproducible by passing a seed to createWorld. Defaults to
// Math.random (nondeterministic) when no seed is given, which also
// keeps existing callers/tests that stub Math.random working
// unchanged. NOTE: particle.worker.ts imports applyParticleForcesRange
// but never calls createWorld, so in the worker realm this stays
// Math.random -- the opt-in parallel-particle path (>=4000 particles)
// trades determinism of sub-pixel brownian jitter for throughput.
let simRng: () => number = Math.random;

export function createWorld(
  width: number,
  height: number,
  opts?: { delayedSpawn?: boolean; seed?: number },
): World {
  // Install the seeded generator before ANY random draw below (the
  // world literal's nextDisturbanceAt, generateObstacles, founder
  // spawn all consume it).
  simRng = opts?.seed != null ? mulberry32(opts.seed >>> 0) : Math.random;
  const particleTarget = INITIAL_PARTICLE_TARGET;
  const world: World = {
    width, height,
    depth: 24,
    t: 0,
    particles: [],
    particleStore: new ParticleStore(Math.max(256, particleTarget)),
    fadingGhosts: [],
    eDnaCarriers: [],
    creatures: [],
    creatureStore: new CreatureStore(512),
    particleTarget,
    parallelMin: PARALLEL_PARTICLE_MIN_DEFAULT,
    particleSpawnRate: Math.min(MAX_SPAWN_PER_SEC, Math.max(5, particleTarget * PARTICLE_SPAWN_RATIO)),
    // Production (delayedSpawn) uses the one-shot ramp; tests / direct
    // callers keep the legacy "fully seeded up front + continuous
    // replenish" behavior so their assertions hold.
    useSeedRamp: !!opts?.delayedSpawn,
    initialSeedDone: !opts?.delayedSpawn,
    stats: { births: 0, dStarve: 0, dMembrane: 0, dMrna: 0, dAa: 0, dOld: 0 },
    rxnStats: newRxnStats(),
    foundersEnabled: true,
    ongoingSeeding: false,
    seedRampClock: SEED_RAMP_PERIOD_SEC, // first tick fires the first batch
    extinctionCount: 0,
    liveCodingKeys: new Set(),
    nextLineageRoot: 0,
    founderTarget: FOUNDER_TARGET,
    lastFounderTrickleT: -1e9,
    // Transient set of currently-alive founder cell IDs. Used to give
    // every founder a fixed 180s lifespan after spawn so the founders
    // can't dominate indefinitely -- their descendants have to take
    // over the niche, or it goes extinct and the top-up loop seeds a
    // fresh lineage. NOT persisted across save/load; reloaded saves
    // lose tracking and existing founders live full lives.
    founderIds: new Set<number>(),
    founderReproduced: new Set<number>(),
    founderBirthScore: new Map(),
    pinnedSpecies: new Set<string>(),
    gravity: 60,
    drag: 0.6,
    surfaceAmp: 55, surfaceLength: 200, surfacePeriod: 7, surfaceDecay: 90,
    swellAmp: 5, swellLength: 600, swellPeriod: 18, swellDecay: 520,
    zStirAmp: 4,
    updraftAmp: 4, updraftLength: 540, updraftPeriod: 28,
    surfaceY: height * SURFACE_Y_FRAC,
    surfaceWaveAmp: 14,
    aerationRate: width * AERATION_PER_PX,
    atmosphere: initialAtmosphere(),
    ambient: initialAmbient(width, height),
    reserve: (() => {
      const cols = Math.max(1, Math.ceil(width / REGION_PX));
      const rows = Math.max(1, Math.ceil(height / REGION_PX));
      return new Float32Array(cols * rows * CHEMICAL_COUNT);
    })(),
    tempSurface: 28,
    tempBottom: 12,
    // tempPatchAmp 0 by default. The patch term was a traveling sine
    // wave that used to track the visible water waves but became
    // decoupled when wave physics was reworked, leaving an unrelated
    // pattern on the temperature overlay. Now that temperature is a
    // diffused regional field (vent heat spreads, depth gradient is
    // the baseline), the patch term is no longer doing useful work.
    // Math stays in temperatureAt for tests + future re-introduction.
    tempPatchAmp: 0,
    tempPatchLength: 360,
    tempPatchPeriod: 38,
    // Soft side walls: bounces lose most of their energy so a
    // particle smacking the wall under wave forcing comes to rest
    // there for one frame instead of pinging back into a tight
    // wall-margin column.
    restitution: 0.15, xWallRestitution: 0.05, zWallRestitution: 0.6,
    collisionIters: 1,
    species: new Map(),
    phylogenyEvents: [],
    nextSpeciesLane: 0,
    anchorGenome: new Uint8Array(0),
    brownianAmp: 18,
    dayPhase: 0.2, // start a bit before noon so first day shows
    dayPeriod: 90,
    disturbanceIntensity: 0,
    disturbanceStartedAt: 0,
    disturbanceUntil: 0,
    nextDisturbanceAt: 60 + simRng() * 240,
    wind: 0,
    windTarget: 0,
    currentAmp: CURRENT_AMP,
    regionTemp: new Float32Array(0),
    regionTempNext: new Float32Array(0),
    vmInstrBudget: DEFAULT_VM_INSTR_BUDGET,
    obstacles: [],
    rng: simRng,
  };
  // Reset module-level caches that aren't on the world object. These
  // are process-globals indexed by particle/creature slot or by sim
  // time -- if a previous world left them populated, the new world
  // sees stale state until the cache happens to refresh. Tests + any
  // future multi-world / hot-reload path needs this.
  lastSpeciesPruneAt = -SPECIES_PRUNE_INTERVAL_SEC;
  resetCreatureIdCounter();
  // Build the static rocky terrain (seafloor + cave + outcroppings)
  // and its collision broad-phase index. The terrain is procedurally
  // generated once at world creation -- it never changes -- so the
  // band index and cell bitmap built here are reused for every tick
  // of obstacle collision afterward.
  generateObstacles(world);
  rebuildObstacleIndex(world);
  // Particle seeding. Production (delayedSpawn) is born empty and the
  // one-shot seedRamp() fills the pool over the first seconds; founders
  // are withheld until that completes (see step()). Tests / direct
  // callers seed the full mix up front so their assertions hold.
  if (!opts?.delayedSpawn) {
    seedInitialParticles(world);
  }
  // Tests + direct callers also get founders synchronously here so
  // existing unit tests keep working.
  if (!opts?.delayedSpawn) {
    // Skip ahead past the spawn-delay gates first so founders' bornAt
    // (set inside spawnFounder from world.t) matches the wall clock
    // they're entering at. Otherwise tests see creatures with
    // bornAt=0 and age=61 immediately.
    world.t = Math.max(FOUNDER_SPAWN_DELAY_SEC, WATER_FILL_DELAY_SEC) + 1;
    // 60-100% of FOUNDER_TARGET seeded immediately; the top-up loop
    // fills the rest in step().
    // Build the particle grid so the founder scoop (forParticlesNear)
    // has a populated index for these initial spawns.
    buildParticleGrid(world);
    const initialFounders = Math.round(FOUNDER_TARGET * (0.6 + simRng() * 0.4));
    for (let i = 0; i < initialFounders; i++) {
      const f = spawnFounder(world);
      if (f && i === 0) {
        world.anchorGenome = new Uint8Array(f.genome);
        f.color = genomeColor(f.genome, world.anchorGenome);
      }
    }
  }
  return world;
}

// Steady-state target for live founder lineages. Top-up loop pushes
// the live count back toward TARGET whenever it falls below. Initial
// founder spawn is now deferred to the same top-up path (gated by
// FOUNDER_SPAWN_DELAY_SEC below), so there's no separate "initial
// batch" constants any more.
const FOUNDER_TARGET = 50;
// Active immigration model. Each trickle interval, if the live lineage
// pool is below FOUNDER_TARGET, spawn a fraction of the REMAINING
// deficit (founderTarget - live) -- a geometric approach to the target
// rather than the old "rare rescue only below a floor" trickle. No
// resource/particle cap gates it. Total extinction (zero lineages)
// still gets an immediate reseed so a dead world restarts promptly.
const FOUNDER_TRICKLE_FRACTION = 0.2;
const FOUNDER_TRICKLE_INTERVAL_SEC = 7.5;
// (legacy note) Founder top-up previously refilled the full deficit
// (founderTarget minus current live lineages) every step it was short.
// Hold off all founder spawning (initial + top-up) for the first
// FOUNDER_SPAWN_DELAY_SEC sim-seconds of a fresh world. Gives the
// water column time to populate before any creatures enter the
// simulation -- otherwise founders spawn into an empty/loading world
// and the early dynamics look off. (Terrain is in place from t=0
// already since it's procedurally generated at world creation.)
const FOUNDER_SPAWN_DELAY_SEC = 60;
// Founders live for exactly this many sim-seconds after they're
// spawned, then autolyze regardless of biomass / energy state. Forces
// turnover: descendants must take over the niche, otherwise the
// lineage goes extinct and the top-up loop seeds a fresh genome
// elsewhere. Replaces the "founder dominance forever" steady state.
// Bumped 180 -> 300s after K-4/K-5: founders now have to bootstrap a
// receptor pool (SYNTH CHEMO is mRNA-gated and 0.15/s endergonic)
// before they can sense food at all, so the first half of a founder's
// life is spent blind. 300s gives enough room to build receptors,
// chase a food patch, and reach first fission. Founders that DO
// reproduce graduate out of the cull entirely (see advanceDivision)
// so the "no immortal founders" property is preserved -- the cull
// only takes founders that never managed to spawn a descendant.
// Master switch for the age-based founder cull. Paused: founders only
// die from real causes (starvation / membrane / mrna / aa loss), not
// old age, so we can observe whether lineages establish on their own.
const FOUNDER_CULL_ENABLED = false;
const FOUNDER_LIFESPAN_SEC = 300;
// A founder that hasn't fissioned yet but has measurably advanced
// from its spawn state earns extra runway before the age cull --
// "did something interesting" without the binary all-or-nothing of
// the reproduction graduation. Each met condition adds a fixed
// bonus, capped so a stuck-but-busy founder still can't live
// forever (max effective life = FOUNDER_LIFESPAN_SEC + the cap).
// Conditions are deliberately coarse: they reward genuine growth /
// machinery buildup, which a paralyzed (aa- or atp-starved) cell
// cannot fake. Returns seconds to add to the base lifespan.
const FOUNDER_BONUS_PER_COND = 120;
const FOUNDER_BONUS_CAP = 480;
function founderLifespanBonus(world: World, c: Creature): number {
  const s = world.founderBirthScore.get(c.id);
  if (s === undefined) return 0;
  const mol = c.molecules;
  let bonus = 0;
  // Grew substantially: total mass at least doubled since spawn
  // (net anabolism -- ingested/synthesized more than it spent).
  if (creatureTotalMass(c) >= 2 * s.mass) bonus += FOUNDER_BONUS_PER_COND;
  // Built up translation capacity: mRNA at least doubled. mRNA gates
  // every biosynth reaction, so this is hard to reach without a
  // working metabolism.
  if (mol.mrna >= 2 * s.mrna) bonus += FOUNDER_BONUS_PER_COND;
  // Expanded its machinery pool (mRNA + chlorophyll + enzyme)
  // ~3x -- the cell is investing in its own catalytic apparatus,
  // not just coasting on the seed.
  if (mol.mrna + mol.chlorophyll + mol.enzyme >= 3 * s.machinery) {
    bonus += FOUNDER_BONUS_PER_COND;
  }
  // Healthy energy reserve (above the stress-decay threshold) --
  // it's running a net-positive ATP budget, not slowly dying.
  if (c.energy >= 8) bonus += FOUNDER_BONUS_PER_COND;
  return bonus > FOUNDER_BONUS_CAP ? FOUNDER_BONUS_CAP : bonus;
}
// Defer normal per-material replenish + aeration for the early game.
// Holds until WATER_FILL_DELAY_SEC so the seed mix dominates the
// initial chemistry and the column fills gradually instead of all at
// once. Founders gate (FOUNDER_SPAWN_DELAY_SEC) sits a beat later.
// The rock terrain itself is in place from t=0 -- no warmup needed.
const WATER_FILL_DELAY_SEC = 30;

// Founders draw a bounded amount of each chem from the regional
// reserve -- their own region first, one random region as fallback
// -- recirculating mass the cap has sequestered (esp. minerals)
// back into the food web. Per-chem cap keeps a huge reserve from
// ballooning a founder (which would re-trigger the spawn-explosion
// failure). Mass-conserving: reserve down, cell pool up.
const FOUNDER_RESERVE_DRAW_PER_CHEM = 50;
function drawFounderReserve(world: World, c: Creature, x: number, y: number): void {
  const res = world.reserve;
  const nReg = regionCols(world) * regionRows(world);
  if (nReg <= 0) return;
  const localBase = regionIndexAt(world, x, y) * AMBIENT_STRIDE;
  const randBase = (Math.min(nReg - 1, (simRng() * nReg) | 0)) * AMBIENT_STRIDE;
  const cs = c.store; const ci = c.idx;
  const CAP = FOUNDER_RESERVE_DRAW_PER_CHEM;
  for (let k = 0; k < AMBIENT_STRIDE; k++) {
    // Don't birth cells pre-loaded with metabolic waste / CO2 -- the
    // founder scoop is for building materials, not byproducts. (Newborns
    // dying early were dumping a reserve-fed waste slug right back.)
    if (k === CHEM_WASTE || k === CHEM_CO2) continue;
    // Same buoyancy guard as the particle scoop: don't draw dense chems
    // (minerals 2.4, glucose 1.5, aa 1.2) into a fresh founder, or it
    // spawns heavier than water and sinks. Light building materials
    // (biopolymer, fa, adp) still come through.
    if (CHEM_BASE_DENSITY[k] > FOUNDER_SCOOP_MAX_DENSITY) continue;
    let take = 0;
    const lv = res[localBase + k];
    if (lv > 0) { take = lv < CAP ? lv : CAP; res[localBase + k] = lv - take; }
    if (take < CAP && randBase !== localBase) {
      const rv = res[randBase + k];
      if (rv > 0) { const more = Math.min(rv, CAP - take); res[randBase + k] = rv - more; take += more; }
    }
    if (take > 0) cs.chemCols[k][ci] += take;
  }
}

// Founder seed amounts (mirror makeCreature). ATP is now real matter,
// so spawning pays for the whole seed out of the world reserve where
// possible; the uncovered remainder is the explicit, recorded
// external input (RX_BIOGENESIS) -- nothing is silently conjured.
// Bumped 40 -> 80: gene framing made founder genomes larger and spends
// part of each tick's budget scanning introns + crossing GENE/END, so
// founders bootstrap a touch slower. A bigger starting ATP buffer gives
// them more runway to reach a net-positive metabolism before starving.
const FOUNDER_SEED_ATP = 80;
const FOUNDER_SEED_MAT: ReadonlyArray<readonly [number, number]> = [
  [CHEM_MEMBRANE, 1], [CHEM_ADP, 5], [CHEM_MRNA, 5], [CHEM_GLU, 10], [CHEM_AA, 0.5],
];
// Region-index sweep order: the founder's own region first, then
// every other region. Founders take from reserve FIRST wherever it
// exists (anywhere in the world) before any ex-nihilo biogenesis.
function reserveSweepBases(world: World, x: number, y: number): number[] {
  const nReg = regionCols(world) * regionRows(world);
  if (nReg <= 0) return [];
  const local = Math.min(nReg - 1, Math.max(0, regionIndexAt(world, x, y)));
  const out: number[] = [local * AMBIENT_STRIDE];
  for (let ri = 0; ri < nReg; ri++) if (ri !== local) out.push(ri * AMBIENT_STRIDE);
  return out;
}
function pullReserve(world: World, x: number, y: number, chem: number, want: number): number {
  if (want <= 0) return 0;
  const res = world.reserve;
  let got = 0;
  for (const base of reserveSweepBases(world, x, y)) {
    if (got >= want) break;
    const v = res[base + chem];
    if (v <= 0) continue;
    const t = Math.min(v, want - got);
    res[base + chem] = v - t; got += t;
  }
  return got;
}
function pullReserveAny(world: World, x: number, y: number, want: number): number {
  if (want <= 0) return 0;
  const res = world.reserve;
  let got = 0;
  for (const base of reserveSweepBases(world, x, y)) {
    if (got >= want) break;
    for (let k = 0; k < AMBIENT_STRIDE && got < want; k++) {
      if (k === CHEM_WASTE || k === CHEM_CO2) continue;
      const v = res[base + k];
      if (v <= 0) continue;
      const t = Math.min(v, want - got);
      res[base + k] = v - t; got += t;
    }
  }
  return got;
}
// Pay for the founder's fixed seed (materials + ATP) out of reserve so
// ATP/materials are conserved matter; record the founder spawn (and
// the uncovered remainder = explicit external input) as RX_BIOGENESIS.
function reconcileFounderSeed(world: World, x: number, y: number, sizeMult: number = 1): void {
  // Scale the reserve pull + ATP by the founder's size factor so a bigger
  // founder recycles proportionally more reserve mass (accounting stays
  // as honest as the unscaled path: reserve first, external remainder
  // recorded).
  for (const [chem, amt] of FOUNDER_SEED_MAT) pullReserve(world, x, y, chem, amt * sizeMult);
  const seedAtp = FOUNDER_SEED_ATP * sizeMult;
  const atpFromReserve = pullReserveAny(world, x, y, seedAtp);
  recordRxn(RX_BIOGENESIS, RX_LOC_CELL, 0);
  const atpExternal = seedAtp - atpFromReserve;
  if (atpExternal > 0) recordAtp(ATP_OTHER, 0, atpExternal);
}

function spawnFounder(world: World): Creature | null {
  const z = world.depth * 0.5;
  // Reject-sample positions until we find one that's not within
  // FOUNDER_MIN_SPACING of an existing creature. With ~25 founders
  // dropped at once into a 720x420 region, pure uniform random gives
  // ~1.2 overlapping pairs per batch in expectation -- enough that
  // "every reset has a cell inside another" was reliably true.
  // Spacing is 6x MIN_CREATURE_R so even after the founder scoop
  // bulks a body up modestly, neighbours stay distinct.
  const FOUNDER_MIN_SPACING = MIN_CREATURE_R * 6;
  const minSpacingSq = FOUNDER_MIN_SPACING * FOUNDER_MIN_SPACING;
  let x = 0, y = 0;
  const creatures = world.creatures;
  const nc = creatures.length;
  for (let attempt = 0; attempt < 32; attempt++) {
    x = world.width * (0.1 + 0.8 * simRng());
    // Y range covers most of the water column (10%..90% of height),
    // skipping just the surface band and the rocky terrain at the floor.
    y = world.height * (0.1 + 0.8 * simRng());
    let okay = true;
    // Terrain avoidance: refuse to place a founder at-or-below the
    // topmost rock surface in this column. topTerrainYAtColumn handles
    // the cave + overhangs too by reporting any rock the candidate
    // body would overlap (we test the founder's x,y as if it were a
    // solid disc of radius MIN_CREATURE_R + margin against obstacle
    // lobes), so founders don't spawn inside the cave chamber or
    // under an outcropping where they'd be stuck.
    if (founderTerrainBlocked(world, x, y, MIN_CREATURE_R)) { okay = false; }
    if (okay) {
      for (let k = 0; k < nc; k++) {
        const other = creatures[k];
        const dx = other.x - x;
        const dy = other.y - y;
        if (dx * dx + dy * dy < minSpacingSq) { okay = false; break; }
      }
    }
    if (okay) break;
  }
  // Per-founder physical size: ~[1.5, 8], right-skewed (rng*rng) so most
  // founders are modestly larger than the old minimal body and a few are
  // much bigger -- larger on average, wide spread.
  const sizeMult = 1.5 + simRng() * simRng() * 6.5;
  const c = makeCreature(world, x, y, z, undefined, sizeMult);
  if (c === null) return null; // genome roll failed -- skip this founder
  // Recirculate cap-sequestered reserve mass into the new founder.
  drawFounderReserve(world, c, x, y);
  // ATP is real matter now: pay for the fixed seed out of reserve
  // (conserving) and record the spawn / external remainder.
  reconcileFounderSeed(world, x, y, sizeMult);
  updateCreatureRadius(c); // reflect the drawn mass in r / density
  c.bornAt = world.t;
  c.lineageRoot = world.nextLineageRoot++;
  world.creatures.push(c);
  world.founderIds.add(c.id);
  {
    const bm = c.molecules;
    world.founderBirthScore.set(c.id, {
      mass: creatureTotalMass(c),
      mrna: bm.mrna,
      machinery: bm.mrna + bm.chlorophyll + bm.enzyme,
    });
  }
  noteCreatureBirth(world, c, undefined);
  return c;
}

// Initial particle seeding. Called once per world creation, before
// any time-gated replenish kicks in. Distribution is set via the
// per-chem SPAWN_CHEM_SPECS table at the top of the file (replaced
// the old MaterialId-keyed SEED_SPEC). Each spawned particle carries
// a small generic-chem signature (reaction substrates/products
// floating in the environment) so cells have varied chemistry to
// react with at world start.


function seedInitialParticles(world: World): void {
  const spawnOne = (spec: SpawnChemSpec): boolean => {
    const r = 1 + simRng() * 1.5;
    const pos = spawnPosForChem(world, r, spec.chemId);
    if (!pos) return false;
    pushParticle(world, {
      x: pos.x, y: pos.y, z: pos.z,
      vx: 0, vy: pos.vy ?? 0, vz: (simRng() - 0.5) * 20,
      r,
      chemId: spec.chemId,
      density: rollChemDensity(spec),
    });
    return true;
  };
  // Unified seed: the spawn `weight` IS the distribution. Guarantee
  // >=1 of every chemical (deterministic representation, independent
  // of cap/Poisson), then weighted-fill the rest up to
  // particleTarget so the initial state already matches the
  // steady-state replenish mix.
  const target = world.particleTarget;
  for (const spec of SPAWN_CHEM_SPECS) {
    if (world.particles.length >= target) break;
    spawnOne(spec);
  }
  // Bounded loop: with topSpawnPos rejecting rocky columns, spawnOne
  // can return false; pick fresh specs until the population reaches
  // target. Cap iterations so a pathological terrain (all rock) can't
  // hang -- in practice this loop finishes in ~target attempts.
  let safety = target * 4;
  while (world.particles.length < target && safety-- > 0) spawnOne(pickSpawnSpec());
}

// One-shot startup ramp (production worlds). Once per sim-second, inject
// a fixed batch of particles in the spawn-spec ratio. dissolve/reserve
// run later in the same tick, so each batch nets out to a partial gain;
// the ramp keeps going until the visible count reaches particleTarget,
// then latches done forever (nothing respawns afterward -- the pool is
// fixed for the rest of the run). Founders are gated on this completing.
// Slow ramp: one batch per 30s lays the substrate down over the full
// SEED_RAMP_MAX_T window without flooding the cap. (Was 2s / 400; the
// faster cadence dumped 15x as much mass in during the same window,
// which the reservePass then had to demote every tick.)
const SEED_RAMP_PERIOD_SEC = 30;
// 10x the prior per-batch amount (400 -> 4000). Frequency unchanged.
// During SETTLE_NO_CAP_SEC the particle cap is Infinity, so the full
// batch lands and the dissolved-field equilibrium settles ~10x higher
// before reservePass demotes back to particleTarget after settle.
const SEED_RAMP_BATCH = 4000;
// Hard time cap on the ramp: stop seeding after this many sim-seconds
// even if particleTarget was never reached, then latch done forever.
const SEED_RAMP_MAX_T = 180;
// Settle window: for the first SETTLE_NO_CAP_SEC sim-seconds the 5k
// particle cap is OFF -- seedRamp/precipitate ignore particleTarget and
// reservePass does nothing, so the world fills and finds its natural
// dissolve/precipitate equilibrium unthrottled. After it, the cap
// re-engages and reservePass demotes any surplus into reserve.
const SETTLE_NO_CAP_SEC = 180;
function inSettleWindow(world: World): boolean {
  // Production (ramp) worlds only -- test/legacy worlds keep the cap
  // always so cap-enforcement unit tests stay valid.
  return world.useSeedRamp && world.t < SETTLE_NO_CAP_SEC;
}
function effectiveParticleCap(world: World): number {
  return inSettleWindow(world) ? Infinity : world.particleTarget;
}
function seedRamp(world: World, dt: number): void {
  if (!world.useSeedRamp || world.initialSeedDone) return;
  const cap = effectiveParticleCap(world);
  if (world.particles.length >= cap || world.t >= SEED_RAMP_MAX_T) {
    world.initialSeedDone = true;
    return;
  }
  world.seedRampClock += dt;
  while (world.seedRampClock >= SEED_RAMP_PERIOD_SEC) {
    world.seedRampClock -= SEED_RAMP_PERIOD_SEC;
    const room = cap - world.particles.length;
    if (room <= 0) break;
    const n = Math.min(SEED_RAMP_BATCH, room);
    for (let i = 0; i < n; i++) {
      const spec = pickSpawnSpec();
      const r = spawnRadius(spec.chemId);
      const pos = spawnPosForChem(world, r, spec.chemId);
      if (!pos) continue;
      pushParticle(world, {
        x: pos.x, y: pos.y, z: pos.z,
        vx: 0, vy: pos.vy ?? 0, vz: (simRng() - 0.5) * 20,
        r,
        chemId: spec.chemId,
        density: rollChemDensity(spec),
      });
    }
  }
  if (world.particles.length >= cap || world.t >= SEED_RAMP_MAX_T) world.initialSeedDone = true;
}


// Uniform random position anywhere in the water body (full width, full
// sub-surface column, full depth). Used by every material-spawn path so
// both the initial seed and the periodic replenish scatter throughout
// the world instead of raining down from the surface.
function randomWaterPos(
  world: World, r: number,
): { x: number; y: number; z: number } {
  // Reject positions that would land a particle inside rock. Bounded
  // retry: founderTerrainBlocked is a fast lobe sweep over ~5
  // obstacles, and the rock occupies a small fraction of the world,
  // so it rarely takes more than a couple of attempts.
  let x = 0, y = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    x = simRng() * world.width;
    y = world.surfaceY + simRng() * (world.height - world.surfaceY);
    if (!founderTerrainBlocked(world, x, y, r)) break;
  }
  return {
    x, y,
    z: r + simRng() * (world.depth - 2 * r),
  };
}

// Top-of-water spawn. Drops particles in a thin band just below the
// surface so they fall under gravity and find their natural resting
// place. Spawn x is sampled uniformly across the full width; if the
// rock pierces near the surface at the chosen column, the spawn y
// snaps DOWN to land in clear water at that column rather than
// rejecting the x and re-rolling. That keeps the long-run x
// distribution uniform across the world even when significant
// rock columns extend near the waterline.
//
// Returns null only for the pathological case where rock fills the
// column from the surface all the way past a reasonable spawn band
// (a narrow cave ceiling at the very top).
function topSpawnPos(
  world: World, r: number,
): { x: number; y: number; z: number; vy: number } | null {
  const surfaceY = world.surfaceY;
  const heightmap = world.terrainHeightmap;
  const x = simRng() * world.width;
  const z = r + simRng() * (world.depth - 2 * r);
  const baseY = surfaceY + r + simRng() * (r * 3);
  if (!heightmap || heightmap.length === 0) {
    return { x, y: baseY, z, vy: 5 + simRng() * 10 };
  }
  const ix = Math.max(0, Math.min(heightmap.length - 1, Math.floor(x)));
  const topY = heightmap[ix];
  // Column is clear in the surface band: drop a particle there directly.
  if (topY === Number.POSITIVE_INFINITY || topY > baseY + r) {
    return { x, y: baseY, z, vy: 5 + simRng() * 10 };
  }
  // Rock is at or near the surface in this column. If rock starts BELOW
  // the surface, there's a narrow band between surface and rock-top
  // that's still clear; spawn there (common case: a submerged shelf).
  if (topY > surfaceY + r * 2) {
    const y = topY - r - 1 - simRng() * (r * 2);
    if (y > surfaceY + r) {
      return { x, y, z, vy: 5 + simRng() * 10 };
    }
  }
  // Pathological: rock pierces the surface here. Skip this spawn rather
  // than dropping into rock or, worse, retrying with a new x (the old
  // 32-retry loop concentrated spawns into the clear columns, breaking
  // the long-run uniform-x property). The next spawn call gets a fresh
  // uniform x sample.
  return null;
}

// Pick the spawn position for `chemId`. Gases keep the uniform-water
// path (they'd just escape from the top anyway, and aeration is
// their primary inlet); everything else top-drops. Returns null when
// the spawn would land in rock; callers skip those.
function spawnPosForChem(
  world: World, r: number, chemId: number,
): { x: number; y: number; z: number; vy?: number } | null {
  if (chemId === CHEM_O2 || chemId === CHEM_CO2) {
    return randomWaterPos(world, r);
  }
  return topSpawnPos(world, r);
}

// Particle spawn radius. All particles -- mineral, organic, gas --
// share the small 1..2.5px range now that the sediment bed is gone.
// (Previously this branched on chemId to occasionally roll a large
// "pebble" mineral grain that drove a procedural sand floor; the
// floor is now static rock terrain, so the branch is dead.)
function spawnRadius(_chemId: number): number {
  return 1 + simRng() * 1.5;
}

export function seedParticles(world: World, n: number): void {
  world.particles.length = 0;
  world.particleStore.n = 0;
  for (let i = 0; i < n; i++) {
    const spec = pickSpawnSpec();
    const r = spawnRadius(spec.chemId);
    pushParticle(world, {
      ...randomWaterPos(world, r),
      vx: 0, vy: 0, vz: (simRng() - 0.5) * 20,
      r,
      chemId: spec.chemId,
      density: rollChemDensity(spec),
    });
  }
}

// Per-spawn density jitter, indexed by spawn spec. Specs with no
// jitter clause fall through to undefined (force-pickup of the chem's
// default density at force-time).
function rollChemDensity(spec: SpawnChemSpec): number | undefined {
  if (!spec.densityJitter) return undefined;
  const { lo, hi } = spec.densityJitter;
  // Triangular distribution around the midpoint -- recovers the
  // varied-density "look" of the old rock/sand/clay split that's now
  // collapsed into a single mineral chem.
  const tri = simRng() + simRng() - 1; // -1..1
  const mid = (lo + hi) / 2;
  const half = (hi - lo) / 2;
  return mid + tri * half;
}

function pickSpawnSpec(): SpawnChemSpec {
  let total = 0;
  for (const s of SPAWN_CHEM_SPECS) total += s.weight;
  let pick = simRng() * total;
  for (const s of SPAWN_CHEM_SPECS) {
    pick -= s.weight;
    if (pick <= 0) return s;
  }
  return SPAWN_CHEM_SPECS[SPAWN_CHEM_SPECS.length - 1];
}

// "Lucky DNA + junk" founder bootstrap. A membrane forms around a
// random patch; whatever loose particles happen to be in the patch
// become the cell's starting substrate. The genome decides what
// reactions the cell can run; the environment decides what it has
// to work with. No hardcoded reserve / molecule yolk -- the
// genome's SYNTH_* presence only sizes the absolute minimum
// machinery seed (a "primordial soup" of mandatory-multiplier
// molecules) so first-generation cells can fire their first
// reactions before they have a chance to build more. Each founder
// samples a random radius in [FOUNDER_SCOOP_R_MIN, FOUNDER_SCOOP_R_MAX]
// so initial cell sizes vary -- some founders get a lean scoop and
// stay tiny, others land in a particle-rich patch and start fat.
const FOUNDER_SCOOP_R_MIN = 14;
const FOUNDER_SCOOP_R_MAX = 50;
// Founders only scoop particles at-or-below this chem density. Dense
// chems (minerals 2.4, glucose 1.5, amino acid 1.2) are what made fresh
// founders heavier than water and sink into the dark floor before they
// could bootstrap; leaving them in the world keeps the founder near
// neutral buoyancy. Biopolymer (1.05) and lighter (fa, gases) still get
// scooped, so the food/building-block pickup mostly survives. The cell
// can still acquire dense chems later via INGEST/TRANSPORT once it can
// afford the ballast.
const FOUNDER_SCOOP_MAX_DENSITY = 1.1;
function makeCreature(
  world: World, x: number, y: number, z: number, genomeOverride?: Uint8Array,
  sizeMult: number = 1,
): Creature | null {
  // genomeOverride: used by spawnSpeciesInstance to materialize a
  // specific pinned/notable genome instead of rolling a random one.
  // The minimal molecule seed below is the "force it" floor (the cell
  // is viable even in barren water); the particle scoop layered on
  // top is the "use available resources if present" part.
  const rolled = genomeOverride
    ? new Uint8Array(genomeOverride)
    : makeRandomViableGenome(simRng);
  if (rolled === null) {
    console.warn(
      "makeRandomViableGenome: no viable genome in MAX_REROLLS -- skipping founder",
    );
    return null;
  }
  const genome = rolled;
  // Minimal cell body: membrane just above MIN_VIABLE_MEMBRANE, a
  // trickle of ADP + a starter ATP grant, and small starter pools of
  // every chem the baseline reactions could produce. Phase 4a made
  // the named biosynth reactions uncatRate-driven on every cell, so
  // there's no longer a meaningful "this founder carries SYNTH X /
  // this one doesn't" distinction at spawn time -- every founder can
  // in principle synthesize every output. Seeding small starter
  // pools avoids tick-1 thresholds (MIN_VIABLE_AMINOACID etc) killing
  // a fresh cell before the baseline chemistry catches up.
  const c = newCreature(world.creatureStore, {
    x, y, z,
    r: MIN_CREATURE_R,
    density: 1.0,
    energy: FOUNDER_SEED_ATP,
    senseRange: computeSenseRange(genome),
    thrustAccel: computeThrustAccel(genome),
    genome,
    vm: newVMState(),
    color: genomeColor(genome),
    speciesKey: genomeKey(genome),
    molecules: {
      // Membrane: the structural reserve (just above
      // MIN_VIABLE_MEMBRANE).
      membrane: 1,
      adp: 60,
      // Enough mRNA for biosynth to run near full rate from birth
      // (rate scales with mrna/MRNA_REF; the old seed of 1 = 20%).
      // Bumped 5 -> 8 as part of the founder "starter machinery" head
      // start so first-tick biosynth runs strong while the cell is
      // still blind + bootstrapping.
      mrna: 8,
      // Buoyancy aid: a starter pool of O2 (gas, density 0.14) offsets
      // the dense glucose/mineral load so a fresh founder spawns nearer
      // neutral buoyancy and doesn't immediately sink into the dark
      // floor before it can sense + thrust. O2 is also the respiration
      // electron acceptor, so it's not wasted.
      o2: 8,
      // Glucose so the cell can respire to *sustain* ATP past the
      // one-shot energy grant. Reduced 100 -> 50 for buoyancy: glucose
      // (density 1.5) was the dominant driver keeping fresh founders
      // above neutral and sinking. With FOUNDER_SEED_ATP now 80 the
      // total starting energy buffer stays ample (80 ATP + 50 glucose),
      // while the lighter glucose load brings founders nearer neutral.
      glucose: 50,
      // Small amino-acid pool so the new viability threshold
      // (MIN_VIABLE_AMINOACID) doesn't kill the founder on tick 1.
      aminoAcid: 0.5,
      // Starter pigment + enzyme pools. Phase 4a made these
      // synthesisable on every cell at baseline; seeding them avoids
      // a tick-1 starvation while the baseline chemistry warms up.
      // Bumped 0.5 -> 1.0 ("starter machinery" head start) so a founder
      // can digest / photosynthesize meaningfully from birth.
      chlorophyll: 1.0,
      enzyme: 1.0,
      // Starter receptor pools. The post-bitmask-fix catalyst tax
      // bankrupted sense-dependent archetypes (phototaxis, thermophile,
      // etc.) before they could grow receptors from substrate -- the
      // sense -> migrate -> reach light -> photosynth -> aa loop has
      // no entry point without a nonzero receptor pool to seed the
      // sense step. Tiny but nonzero starter so first-tick sensing
      // can fire; the cell still has to keep maintenance + biosynth
      // ahead of decay to be viable. Lineages that don't invest in
      // SYNTH CAT for receptor slots lose their sense capacity within
      // a few seconds (CAT_DECAY_PER_SEC + receptor maintenance).
      photoreceptorVisible: 0.5,
      photoreceptorLong: 0.5,
      photoreceptorSurface: 0.5,
      mechanoreceptor: 0.5,
      thermoreceptor: 0.5,
      magnetoreceptor: 0.5,
    },
  });
  // Founder size variation: scale the whole molecular seed (incl. the
  // aliased ATP column) by a per-founder factor so founders spawn across
  // a range of physical sizes -- larger on average, wide spread --
  // instead of all at the minimal body. Proportional, so composition
  // (hence density/buoyancy) and the maintenance/synthesis balance are
  // preserved -- the cell is just bigger. Applied BEFORE the particle
  // scoop so only the seed scales, not scooped environmental matter.
  // sizeMult is 1 for archetype spawns (genomeOverride), so seeds keep
  // their authored size.
  if (sizeMult !== 1) {
    const sc = c.store.chemCols; const si = c.idx;
    for (let k = 0; k < sc.length; k++) sc[k][si] *= sizeMult;
  }
  // Scoop every loose particle within FOUNDER_SCOOP_RADIUS into the
  // cell. The particle's chemId deposits straight into the matching
  // chemCols slot; an accompanying multi-chem corpse payload (genericChem)
  // adds to the cell's generic-chem pool. Each absorbed particle is
  // removed from the world. An empty patch means a very lean cell
  // that probably won't survive long; that's the luck of biogenesis.
  const scoopR = FOUNDER_SCOOP_R_MIN + simRng() * (FOUNDER_SCOOP_R_MAX - FOUNDER_SCOOP_R_MIN);
  const rSq = scoopR * scoopR;
  const cstore = c.store; const cidx = c.idx;
  // Scan only particles near the spawn point (grid built by the caller
  // before founder spawning) rather than all of world.particles. The
  // visitor removes each scooped particle; forParticlesNear's bucket
  // arrays aren't mutated by removal, and each candidate is liveness-
  // checked, so multi-remove during the walk is safe.
  forParticlesNear(world, x, y, scoopR, (p) => {
    const dx = p.x - x;
    const dy = p.y - y;
    const dz = p.z - z;
    if (dx * dx + dy * dy + dz * dz >= rSq) return;
    // Skip dense particles so the founder doesn't spawn heavier than
    // water (left in the world for later INGEST/TRANSPORT).
    if (CHEM_BASE_DENSITY[p.chemId] > FOUNDER_SCOOP_MAX_DENSITY) return;
    cstore.chemCols[p.chemId][cidx] += mass(p) / CHEM_MM[p.chemId];
    if (p.molecules) {
      for (const k of MOLECULE_IDS) c.molecules[k] += p.molecules[k];
    }
    if (p.genericChem) {
      const gcCols = cstore.genericChemCols;
      for (let k = 0; k < GENERIC_CHEMICAL_COUNT; k++) {
        gcCols[k][cidx] += p.genericChem[k];
      }
    }
    removeParticleAt(world, p.idx);
  });
  updateCreatureRadius(c);
  return c;
}

// Placement mode for user-triggered spawns. "scatter" = the legacy
// reject-sampled spread over the central 80%. "clump" = a tight
// cluster in the top 25% of the world (near the surface), all cells
// packed around one shared center so an injected batch lands together.
export interface SpawnPlacement {
  mode: "scatter" | "clump";
  // Shared clump center for a batch; computed once by the caller
  // (pickClumpCenter) so every cell in one click lands together.
  center?: { x: number; y: number };
}

// A random non-terrain-blocked point in the top 25% of the world
// (just below the thin surface band). The clump-batch anchor.
export function pickClumpCenter(world: World): { x: number; y: number } {
  for (let attempt = 0; attempt < 32; attempt++) {
    const cx = world.width * (0.1 + 0.8 * simRng());
    const cy = world.height * (0.08 + 0.17 * simRng()); // ~top quarter
    if (!founderTerrainBlocked(world, cx, cy, MIN_CREATURE_R)) {
      return { x: cx, y: cy };
    }
  }
  return { x: world.width * 0.5, y: world.height * 0.15 };
}

// User-triggered spawn of a specific genome (from the Pinned /
// Notable species lists). Mirrors spawnFounder's placement +
// species-tracking bookkeeping, but with a caller-supplied genome and
// WITHOUT joining founderIds -- a manually conjured cell lives a
// normal life, it isn't a founding lineage and isn't subject to (or
// exempt from) the founder age cull. "Use available resources if
// present, otherwise force it" is satisfied by makeCreature: the
// fixed molecule seed is the forced viability floor and the local
// particle scoop is the opportunistic resource use. Returns null if
// the creature cap is full.
export function spawnSpeciesInstance(
  world: World,
  genome: Uint8Array,
  placement?: SpawnPlacement,
): Creature | null {
  if (world.creatures.length >= MAX_CREATURES) return null;
  const z = world.depth * 0.5;
  let x = world.width * 0.5, y = world.height * 0.5;
  if (placement?.mode === "clump") {
    // Pack tightly around the shared center; relaxed spacing so a
    // batch forms a real cluster rather than spreading out.
    const center = placement.center ?? pickClumpCenter(world);
    const CLUMP_R = MIN_CREATURE_R * 10;
    const clumpSpacingSq = (MIN_CREATURE_R * 1.5) ** 2;
    x = center.x;
    y = center.y;
    for (let attempt = 0; attempt < 32; attempt++) {
      const ang = simRng() * Math.PI * 2;
      const rad = CLUMP_R * Math.sqrt(simRng());
      const cx = Math.min(
        world.width * 0.98,
        Math.max(world.width * 0.02, center.x + Math.cos(ang) * rad),
      );
      const cy = Math.min(
        world.height * 0.27,
        Math.max(world.height * 0.06, center.y + Math.sin(ang) * rad),
      );
      if (founderTerrainBlocked(world, cx, cy, MIN_CREATURE_R)) continue;
      let okay = true;
      for (let k = 0; k < world.creatures.length; k++) {
        const o = world.creatures[k];
        const dx = o.x - cx, dy = o.y - cy;
        if (dx * dx + dy * dy < clumpSpacingSq) { okay = false; break; }
      }
      x = cx; y = cy;
      if (okay) break;
    }
  } else {
    const FOUNDER_MIN_SPACING = MIN_CREATURE_R * 6;
    const minSpacingSq = FOUNDER_MIN_SPACING * FOUNDER_MIN_SPACING;
    for (let attempt = 0; attempt < 32; attempt++) {
      const cx = world.width * (0.1 + 0.8 * simRng());
      const cy = world.height * (0.1 + 0.8 * simRng());
      if (founderTerrainBlocked(world, cx, cy, MIN_CREATURE_R)) continue;
      let okay = true;
      for (let k = 0; k < world.creatures.length; k++) {
        const o = world.creatures[k];
        const dx = o.x - cx, dy = o.y - cy;
        if (dx * dx + dy * dy < minSpacingSq) { okay = false; break; }
      }
      x = cx; y = cy;
      if (okay) break;
    }
  }
  const c = makeCreature(world, x, y, z, genome);
  if (c === null) return null; // unreachable with an explicit genome
  c.bornAt = world.t;
  c.lineageRoot = world.nextLineageRoot++;
  world.creatures.push(c);
  noteCreatureBirth(world, c, undefined);
  return c;
}

// Composite spawn: a HOST that already carries a SYMBIONT engulfed in
// its contents (a pre-formed endosymbiotic unit). Both go through the
// normal creature-init path; the symbiont is then moved into the
// host's contents and removed from the free population -- exactly the
// invariant the live engulf path maintains (alive in host.contents,
// organelleSynthMask set, NOT in world.creatures). The host gets a
// membrane + energy head start so the relative sizes keep the unit
// viable for a time (a fresh host carrying a draining captive from
// t0 otherwise collapses before it can establish).
export function spawnCompositeInstance(
  world: World,
  hostGenome: Uint8Array,
  symGenome: Uint8Array,
  placement?: SpawnPlacement,
): Creature | null {
  const host = spawnSpeciesInstance(world, hostGenome, placement);
  if (host === null) return null;
  host.molecules.membrane = Math.max(host.molecules.membrane, 60);
  host.energy = Math.max(host.energy, 220);
  updateCreatureRadius(host);
  const sym = spawnSpeciesInstance(world, symGenome);
  if (sym === null) return host; // cap full -- host without symbiont
  sym.organelleSynthMask = genomeSynthMask(sym.genome);
  host.contents.push(sym);
  const i = world.creatures.indexOf(sym);
  if (i >= 0) world.creatures.splice(i, 1); // engulfed: not free
  return host;
}


const PHYLO_EVENT_CAP = 2000;

function noteCreatureBirth(world: World, c: Creature, parentKey: string | undefined): void {
  if (world.stats) world.stats.births++;
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
      genome: new Uint8Array(c.genome),
      execCounts: new Uint32Array(c.genome.length),
      vmTicks: 0,
      peakBiomass: 0,
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
// 60s was 240s. The longer grace let world.species balloon to
// 1000+ entries during high-mutation periods, and every render
// iterates the snapshot's species list -- spiky cost at extinction
// events. 60s still preserves recently-lost species in the
// phylogeny strip long enough to read; older species fall off.
const SPECIES_GRACE_SEC = 60;
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
function spendATP(c: Creature, want: number, src: number = ATP_OTHER): number {
  if (want <= 0) return 0;
  const s = c.store; const i = c.idx;
  const e = s.energy[i];
  const got = e < want ? e : want;
  s.energy[i] = e - got;
  s.m_adp[i] += got;
  recordAtp(src, got, 0);
  return got;
}


// Per-chem permeability cache. Mirrors CHEMICALS[k].permeability but
// flat so the hot loop avoids a property dispatch per cell-chem pair.
// Built once at module load alongside CHEM_BASE_DENSITY.
const CHEM_PERMEABILITY = new Float32Array(CHEMICAL_COUNT);
const CHEM_SOLUBILITY = new Float32Array(CHEMICAL_COUNT);
for (let i = 0; i < CHEMICAL_COUNT; i++) {
  CHEM_PERMEABILITY[i] = CHEMICALS[i].permeability;
  CHEM_SOLUBILITY[i] = CHEMICALS[i].solubility;
}

// ===================================================================
// Regional dissolved/reserve system -- Phase 0 scaffolding.
// Pure additions; nothing here is wired into step() yet (no behavior
// change). See REGION_SYSTEM_PLAN.md.
// ===================================================================

// 50x50 px region footprint; a region is a 50x50x world.depth box.
// "Someday adjustable" -- keep all region math derived from this.
export const REGION_PX = 50;
// The whole vertical extent of the world maps to 10 m. Scale is
// isotropic (x, y, z all use this) and used ONLY to turn px volumes
// into litres for the molar-solubility capacity formula and to
// calibrate diffusion rate. Zero impact on rendering / dynamics.
const WORLD_HEIGHT_METERS = 10;
function metersPerPx(world: { height: number }): number {
  return WORLD_HEIGHT_METERS / world.height;
}
export function regionCols(world: { width: number }): number {
  return Math.max(1, Math.ceil(world.width / REGION_PX));
}
export function regionRows(world: { height: number }): number {
  return Math.max(1, Math.ceil(world.height / REGION_PX));
}
// Region volume in litres: (50px x 50px x depth-px) cubed via the
// 10 m scale, * 1000 L/m^3.
export function regionVolumeL(world: { height: number; depth: number }): number {
  const m = metersPerPx(world);
  const volM3 = (REGION_PX * m) * (REGION_PX * m) * (world.depth * m);
  return volM3 * 1000;
}

// Avogadro. Capacity is expressed in particle-equivalents:
//   capacity = S_molar[mol/L] * f_T(T) * V_region[L] * N_A / M
// M = real molecules represented by one sim particle. It's the single
// fitted knob; chosen so insoluble food chems (biopolymer/minerals/
// fattyAcid) get <1 particle-equivalent capacity (they stay
// particulate / edible) while soluble byproducts (glucose/aminoAcid/
// waste/adp) and gases get large capacity (they dissolve into the
// regional field). See the calibration test in sim.test.ts.
const AVOGADRO = 6.022e23;
const PARTICLE_MOLECULE_MULTIPLIER = 2e22;

// Realistic-ish molar solubilities (mol/L) for the 13 bootstrap
// chems. Absolute values are loose; the ORDERING + relative spread
// is what drives behavior, and M absorbs the global scale. Receptors,
// signals and procedural generics keep their existing CHEM_SOLUBILITY
// roll reinterpreted as mol/L (plausibly-invented, deterministic).
const CHEM_MOLAR_SOLUBILITY = new Float32Array(CHEMICAL_COUNT);
for (let i = 0; i < CHEMICAL_COUNT; i++) CHEM_MOLAR_SOLUBILITY[i] = CHEM_SOLUBILITY[i];
CHEM_MOLAR_SOLUBILITY[CHEM_O2] = 1.3e-3;   // sparingly soluble gas
CHEM_MOLAR_SOLUBILITY[CHEM_CO2] = 3.3e-2;  // ~25x more soluble than O2
CHEM_MOLAR_SOLUBILITY[CHEM_GLU] = 5.0;     // sugar, freely soluble
CHEM_MOLAR_SOLUBILITY[CHEM_AA] = 3.0;      // soluble
CHEM_MOLAR_SOLUBILITY[CHEM_FA] = 1e-4;     // hydrophobic, ~insoluble
CHEM_MOLAR_SOLUBILITY[CHEM_MIN] = 1e-5;    // mineral, ~insoluble
CHEM_MOLAR_SOLUBILITY[CHEM_ADP] = 0.5;     // soluble
CHEM_MOLAR_SOLUBILITY[CHEM_WASTE] = 5.0;   // freely soluble
CHEM_MOLAR_SOLUBILITY[CHEM_CHL] = 1e-5;    // water-insoluble pigment
CHEM_MOLAR_SOLUBILITY[CHEM_ENZ] = 1e-3;    // colloidal protein, low
CHEM_MOLAR_SOLUBILITY[CHEM_MRNA] = 1e-3;   // nucleic, low
CHEM_MOLAR_SOLUBILITY[CHEM_BIOPOLYMER] = 1e-6; // structural, insoluble
CHEM_MOLAR_SOLUBILITY[CHEM_MEMBRANE] = 1e-7;   // lipid, insoluble
// Procedural generics rolled their solubility on a 0.01..5 "mol/L"
// scale that was never calibrated against the N_A/M * V capacity
// formula -- at that scale every generic is effectively infinitely
// soluble (capacity dwarfs the whole particle budget, so they all
// dissolve and almost none ever render). Scale the generic block down
// into the same realistic band the bootstrap food chems sit in. The
// relative spread between generics is preserved; only the absolute
// magnitude shifts, so a few stay mildly soluble and most behave as
// particulate matter.
const GENERIC_SOLUBILITY_SCALE = 1e-3;
for (let i = NAMED_CHEMICAL_COUNT; i < CHEMICAL_COUNT; i++) {
  CHEM_MOLAR_SOLUBILITY[i] *= GENERIC_SOLUBILITY_SCALE;
}

// Temperature factor on solubility. Gases get LESS soluble warm
// (inverse, Henry's law); condensed phases get MORE soluble warm
// (direct). Small slope; identity at TEMP_BASELINE so a baseline
// world is unchanged. Used from Phase 1 onward; defined now so the
// capacity signature is stable.
function solubilityTempFactor(chemId: number, tempC: number): number {
  const dRel = (tempC - TEMP_BASELINE) / TEMP_BASELINE;
  const gas = CHEMICALS[chemId].defaultPhase === "gas";
  const k = 0.4;
  const f = gas ? 1 - k * dRel : 1 + k * dRel;
  return f < 0.05 ? 0.05 : f > 3 ? 3 : f;
}

// Dissolved capacity of a region for a chem, in particle-equivalents.
export function regionDissolvedCapacity(
  chemId: number, world: { height: number; depth: number }, tempC: number,
): number {
  const sMolar = CHEM_MOLAR_SOLUBILITY[chemId];
  if (sMolar <= 0) return 0;
  const vL = regionVolumeL(world);
  return sMolar * solubilityTempFactor(chemId, tempC) * vL * AVOGADRO
    / PARTICLE_MOLECULE_MULTIPLIER;
}

// Per-region temperature field. STATE-BEARING: each tick we diffuse
// heat between neighbouring regions, relax slowly toward the analytical
// baseline (depth gradient + patch wave from temperatureAt), and inject
// a Gaussian source from the active vent. This is what makes vent heat
// linger and spread instead of stamping a fixed bubble that disappears
// the moment the eruption ends. Consumed by chemistry (dissolution
// capacity, region dissolve thresholds), creature reads (Q10, THERMO
// receptor), and the heatmap overlay.
//
// Time constants in 1/sec. DIFF spreads local hot spots; RELAX pulls
// each region back toward its analytical equilibrium -- and is the
// distributed heat SINK that keeps the bulk water at its depth-gradient
// baseline no matter how hard the vent injects (so a hotter vent can't
// boil the whole world, only its local zone). VENT_INJECT sets how fast
// the local peak builds.
//
// The vent is an ALWAYS-ON heat source: a persistent base intensity
// (VENT_BASE_INTENSITY) keeps a standing hot zone around the mouth at
// all times, and an eruption envelope spikes on top. RELAX is slow
// enough that the zone lingers rather than dissipating the moment the
// puff ends.
const TEMP_DIFF_RATE = 0.35;
const TEMP_RELAX_RATE = 0.1;
const TEMP_VENT_INJECT_RATE = 0.15;
const VENT_TEMP_PEAK_AMP = 100;
const VENT_TEMP_RADIUS_PX = 95;
// Standing heat the vent emits between eruptions (fraction of full
// intensity). Eruptions ramp from this base up to 1 and back. Exported
// so the renderer animates the persistent plume off the same value.
export const VENT_BASE_INTENSITY = 0.4;
function sampleRegionTemps(world: World, dt: number): void {
  const cols = regionCols(world);
  const rows = regionRows(world);
  const n = cols * rows;
  // First call, or dims changed: allocate world.regionTemp and seed
  // with the analytical baseline. Skip the stepping for this tick --
  // the field has no history yet.
  if (world.regionTemp.length !== n) {
    world.regionTemp = new Float32Array(n);
    world.regionTempNext = new Float32Array(n);
    for (let ry = 0; ry < rows; ry++) {
      const cy = Math.min(world.height - 1, ry * REGION_PX + REGION_PX / 2);
      for (let rx = 0; rx < cols; rx++) {
        const cx = Math.min(world.width - 1, rx * REGION_PX + REGION_PX / 2);
        world.regionTemp[ry * cols + rx] = temperatureAt(world, cx, cy);
      }
    }
    return;
  }
  const cur = world.regionTemp;
  const next = world.regionTempNext;
  const v = world.vent;
  const hasVent = v != null;
  const vx = hasVent ? v!.x : 0;
  const vy = hasVent ? v!.y : 0;
  // Always-on heat: persistent base + the eruption envelope on top.
  const eruptI = hasVent && v!.active ? v!.intensity : 0;
  const vIntensity = hasVent
    ? VENT_BASE_INTENSITY + (1 - VENT_BASE_INTENSITY) * eruptI
    : 0;
  const r2 = VENT_TEMP_RADIUS_PX * VENT_TEMP_RADIUS_PX;
  const rejectR2 = 9 * r2;
  for (let ry = 0; ry < rows; ry++) {
    const cy = Math.min(world.height - 1, ry * REGION_PX + REGION_PX / 2);
    const rowBase = ry * cols;
    for (let rx = 0; rx < cols; rx++) {
      const i = rowBase + rx;
      const T = cur[i];
      // 4-neighbour Laplacian (Neumann BC: edges use available
      // neighbours only). Stored as the avg-vs-self difference so the
      // rate constant is wall-time independent of cell size.
      let nsum = 0, ncount = 0;
      if (rx > 0)        { nsum += cur[i - 1];    ncount++; }
      if (rx < cols - 1) { nsum += cur[i + 1];    ncount++; }
      if (ry > 0)        { nsum += cur[i - cols]; ncount++; }
      if (ry < rows - 1) { nsum += cur[i + cols]; ncount++; }
      const diff = ncount > 0 ? (nsum / ncount - T) * TEMP_DIFF_RATE * dt : 0;
      // Relax toward analytical baseline (depth gradient + patch wave;
      // NOT vent -- that's the source term below).
      const cx = Math.min(world.width - 1, rx * REGION_PX + REGION_PX / 2);
      const eq = temperatureAt(world, cx, cy);
      const relax = (eq - T) * TEMP_RELAX_RATE * dt;
      // Vent source: Gaussian bubble * intensity, injected as a rate.
      let vent = 0;
      if (hasVent) {
        const dx2 = (cx - vx) * (cx - vx);
        const dy2 = (cy - vy) * (cy - vy);
        const d2 = dx2 + dy2;
        if (d2 < rejectR2) {
          vent = VENT_TEMP_PEAK_AMP * vIntensity * Math.exp(-d2 / r2)
            * TEMP_VENT_INJECT_RATE * dt;
        }
      }
      next[i] = T + diff + relax + vent;
    }
  }
  // Copy back into world.regionTemp; the swap-by-reference would
  // change Float32Array identity, and any caller that captured the
  // array reference (snapshot serializer, parallel workers) expects
  // it to stay stable.
  for (let i = 0; i < n; i++) cur[i] = next[i];
}
function regionIndexAt(world: { width: number; height: number }, x: number, y: number): number {
  const cols = regionCols(world);
  let rx = (x / REGION_PX) | 0; if (rx < 0) rx = 0; else if (rx >= cols) rx = cols - 1;
  const rows = regionRows(world);
  let ry = (y / REGION_PX) | 0; if (ry < 0) ry = 0; else if (ry >= rows) ry = rows - 1;
  return ry * cols + rx;
}

// ---- Phase 1: regional dissolved field -------------------------
// world.ambient is now a flat [region * CHEMICAL_COUNT + chem] grid
// instead of a single global scalar vector. Every dissolve / cell-
// diffusion / aeration event acts on the LOCAL region's block, and a
// slow Jacobi pass diffuses dissolved mass between regions.
const AMBIENT_STRIDE = CHEMICAL_COUNT;
function ambientBaseAt(world: { width: number; height: number }, x: number, y: number): number {
  return regionIndexAt(world, x, y) * AMBIENT_STRIDE;
}
// Per-neighbour Jacobi exchange fraction giving a ~10-minute
// half-life for the longest-wavelength (domain-spanning) gradient,
// derived from the region-grid extent. Recomputed per call (cheap)
// so it adapts to world size; clamped well under the 2-D explicit
// stability limit (sum of 4 edge coeffs < 0.5).
const REGION_DIFFUSION_HALFLIFE_S = 600;
let REGION_DIFF_SCRATCH = new Float32Array(0);
function diffuseRegions(world: World, dt: number): void {
  // The DISSOLVED field is a true aqueous solute -> isotropic Jacobi
  // diffusion. The reserve pool diffuses too now, but anisotropically:
  // horizontally both ways for everything, and vertically only in the
  // gravity-consistent direction per chem (dense sinks, buoyant rises)
  // -- see diffuseReserve().
  jacobiDiffuseField(world, world.ambient, dt);
}

// Buoyancy-neutral density. applyForces uses ay = g*(1 - 1/density),
// so density 1.0 neither sinks nor rises; >1 sinks, <1 floats. Reserve
// vertical transport keys off the same threshold.
const RESERVE_WATER_DENSITY = 1.0;
let RESERVE_DIFF_SCRATCH = new Float32Array(0);
// Reserve diffusion (Phase 4 revision -- reserve was previously inert):
//  1. left <-> right: symmetric Jacobi exchange for every chem.
//  2. density >= water: also drifts DOWN (settling) one-directionally.
//  3. density <= water: drifts UP (buoyant) one-directionally.
//  4. rate scaled by the mean temperature of the two regions.
// Vertical transfers are applied source-side only (every unit removed
// from a region is added to exactly one neighbour) so the pass is
// exactly mass-conserving. Uses a double buffer so it's order- and
// direction-independent (determinism).
export function diffuseReserve(world: World, dt: number): void {
  const res = world.reserve;
  const cols = regionCols(world);
  const rows = regionRows(world);
  const n = cols * rows;
  if (n < 2) return;
  if (RESERVE_DIFF_SCRATCH.length < res.length) {
    RESERVE_DIFF_SCRATCH = new Float32Array(res.length);
  }
  const old = RESERVE_DIFF_SCRATCH;
  old.set(res.subarray(0, n * AMBIENT_STRIDE));
  const N = Math.max(cols, rows);
  const ticks = REGION_DIFFUSION_HALFLIFE_S / dt;
  const wmode = Math.PI / N;
  let alpha = Math.LN2 / (ticks * wmode * wmode);
  if (alpha > 0.1) alpha = 0.1; // shared stability clamp
  const tempFactor = (ri: number, rj: number): number => {
    const tI = world.regionTemp.length > ri ? world.regionTemp[ri] : TEMP_BASELINE;
    const tJ = world.regionTemp.length > rj ? world.regionTemp[rj] : TEMP_BASELINE;
    let tf = 1 + 0.5 * (((tI + tJ) * 0.5 - TEMP_BASELINE) / TEMP_BASELINE);
    if (tf < 0.3) tf = 0.3; else if (tf > 2) tf = 2;
    return tf;
  };
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const ri = ry * cols + rx;
      const base = ri * AMBIENT_STRIDE;
      const left = rx > 0 ? ri - 1 : -1;
      const right = rx < cols - 1 ? ri + 1 : -1;
      const up = ry > 0 ? ri - cols : -1;            // toward surface
      const down = ry < rows - 1 ? ri + cols : -1;   // toward floor
      // (1) Horizontal: symmetric Jacobi, every chem, both edges.
      for (let h = 0; h < 2; h++) {
        const nj = h === 0 ? left : right;
        if (nj < 0) continue;
        const a = alpha * tempFactor(ri, nj);
        const jb = nj * AMBIENT_STRIDE;
        for (let k = 0; k < AMBIENT_STRIDE; k++) {
          const oi = old[base + k];
          const oj = old[jb + k];
          if (oi !== oj) res[base + k] += a * (oj - oi);
        }
      }
      // (2) Dense chems settle one region DOWN.
      if (down >= 0) {
        const a = alpha * tempFactor(ri, down);
        const db = down * AMBIENT_STRIDE;
        for (let k = 0; k < AMBIENT_STRIDE; k++) {
          const d = CHEM_BASE_DENSITY[k] > 0 ? CHEM_BASE_DENSITY[k] : 1;
          if (d < RESERVE_WATER_DENSITY) continue;
          const amt = a * old[base + k];
          if (amt > 0) { res[base + k] -= amt; res[db + k] += amt; }
        }
      }
      // (3) Buoyant chems rise one region UP.
      if (up >= 0) {
        const a = alpha * tempFactor(ri, up);
        const ub = up * AMBIENT_STRIDE;
        for (let k = 0; k < AMBIENT_STRIDE; k++) {
          const d = CHEM_BASE_DENSITY[k] > 0 ? CHEM_BASE_DENSITY[k] : 1;
          if (d > RESERVE_WATER_DENSITY) continue;
          const amt = a * old[base + k];
          if (amt > 0) { res[base + k] -= amt; res[ub + k] += amt; }
        }
      }
    }
  }
}
function jacobiDiffuseField(world: World, amb: Float32Array, dt: number): void {
  const cols = regionCols(world);
  const rows = regionRows(world);
  const n = cols * rows;
  if (n < 2) return;
  if (REGION_DIFF_SCRATCH.length < amb.length) REGION_DIFF_SCRATCH = new Float32Array(amb.length);
  const old = REGION_DIFF_SCRATCH;
  old.set(amb.subarray(0, n * AMBIENT_STRIDE));
  const N = Math.max(cols, rows);
  const ticks = REGION_DIFFUSION_HALFLIFE_S / dt;
  const wmode = Math.PI / N;
  // lambda = ln2/ticks ; alpha solves lambda = alpha*(pi/N)^2 (small-mode).
  let alpha = Math.LN2 / (ticks * wmode * wmode);
  if (alpha > 0.1) alpha = 0.1; // hard stability clamp
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const ri = ry * cols + rx;
      const base = ri * AMBIENT_STRIDE;
      // Edge-symmetric, temperature-scaled coefficient per neighbour
      // (avg T of the two regions) so the Jacobi pass stays exactly
      // mass-conserving even with a temperature gradient.
      const tI = world.regionTemp.length > ri ? world.regionTemp[ri] : TEMP_BASELINE;
      // up/down/left/right neighbour region indices (-1 = none)
      const nb0 = rx > 0 ? ri - 1 : -1;
      const nb1 = rx < cols - 1 ? ri + 1 : -1;
      const nb2 = ry > 0 ? ri - cols : -1;
      const nb3 = ry < rows - 1 ? ri + cols : -1;
      for (let pass = 0; pass < 4; pass++) {
        const nj = pass === 0 ? nb0 : pass === 1 ? nb1 : pass === 2 ? nb2 : nb3;
        if (nj < 0) continue;
        const tJ = world.regionTemp.length > nj ? world.regionTemp[nj] : TEMP_BASELINE;
        // warmer water mixes a bit faster; mild, clamped, symmetric.
        let tf = 1 + 0.5 * (((tI + tJ) * 0.5 - TEMP_BASELINE) / TEMP_BASELINE);
        if (tf < 0.3) tf = 0.3; else if (tf > 2) tf = 2;
        const a = alpha * tf;
        const jb = nj * AMBIENT_STRIDE;
        for (let k = 0; k < AMBIENT_STRIDE; k++) {
          const oi = old[base + k];
          const oj = old[jb + k];
          if (oi === oj) continue;
          amb[base + k] += a * (oj - oi);
        }
      }
    }
  }
}

// ---- Phase 3: precipitation + hysteresis -----------------------
// Dissolution refills a region up to capacity; precipitation sheds
// anything ABOVE capacity back into rendered 2px particles. The
// 90..100% deadband (REGION_DISSOLVE_LO) between the two stops a
// just-precipitated particle from instantly re-dissolving.
const REGION_DISSOLVE_LO = 0.9;
const PRECIP_R = 2; // physical radius of a precipitated particle
function precipitateRegions(world: World): void {
  // Best-effort under the global particle cap; leftover supersaturation
  // stays dissolved until capacity rises or Phase 4 reserve drains it.
  const pCap = effectiveParticleCap(world);
  if (world.particles.length >= pCap) return;
  const amb = world.ambient;
  const cols = regionCols(world);
  const rows = regionRows(world);
  const nReg = cols * rows;
  const surfaceY = world.surfaceY;
  const FOUR_THIRDS_PI = (4 / 3) * Math.PI;
  const volPer = FOUR_THIRDS_PI * PRECIP_R * PRECIP_R * PRECIP_R;
  for (let ri = 0; ri < nReg; ri++) {
    const rx = ri % cols;
    const ry = (ri / cols) | 0;
    const tReg = world.regionTemp.length > ri ? world.regionTemp[ri] : TEMP_BASELINE;
    const base = ri * AMBIENT_STRIDE;
    for (let k = 0; k < AMBIENT_STRIDE; k++) {
      const v = amb[base + k];
      if (v <= 0) continue;
      const cap = regionDissolvedCapacity(k, world, tReg);
      const excess = v - cap;
      if (excess <= 0) continue;
      const density = CHEM_BASE_DENSITY[k] > 0 ? CHEM_BASE_DENSITY[k] : 1;
      // amb stores AMOUNT; a PRECIP particle's physical mass is
      // density*volPer, i.e. amountPer = that / molarMass moles.
      const amountPer = (density * volPer) / CHEM_MM[k];
      if (amountPer <= 0) continue;
      let count = Math.floor(excess / amountPer);
      if (count <= 0) continue;
      const room = pCap - world.particles.length;
      if (count > room) count = room;
      if (count <= 0) { if (room <= 0) return; continue; }
      // Spawn within this region's px box, below the surface.
      const x0 = rx * REGION_PX, y0 = ry * REGION_PX;
      for (let s = 0; s < count; s++) {
        const px = Math.min(world.width - 1, x0 + simRng() * REGION_PX);
        let py = y0 + simRng() * REGION_PX;
        if (py < surfaceY + PRECIP_R) py = surfaceY + PRECIP_R;
        py = Math.min(world.height - PRECIP_R, py);
        pushParticle(world, {
          x: px, y: py, z: PRECIP_R + simRng() * (world.depth - 2 * PRECIP_R),
          vx: 0, vy: 0, vz: 0, r: PRECIP_R, chemId: k, density,
        });
      }
      amb[base + k] = v - count * amountPer; // mass-conserving
    }
  }
}

// ---- Phase 4: reserve bucket + global cap enforcement ----------
// Last pass each tick. Over the global particle cap -> demote the
// excess (plain single-chem particles) into their region's reserve
// (invisible, mass-conserved). Under the cap with reserve available
// -> promote: pick the globally most-abundant reserved chem and
// re-spawn 2px particles, drawing mass LOCALLY from a region that
// holds it. This is what finally bounds particle count (and thus
// kills the over-density rightward-drift bug) without losing mass.
// Reserve <-> visible transition fade duration (sim seconds). A
// promoted particle ramps its opacity up over this window (driven by
// its store age); a demoted particle lingers as a render-only ghost,
// fading out over the same window.
const RESERVE_FADE_SEC = 1.5;
// Hard ceiling on simultaneously-fading demote ghosts. They're
// render-only (mass-free) but still ride the snapshot particle array,
// so under heavy demotion churn (big death/seed bursts) an uncapped
// list balloons the reported/rendered count into the tens of
// thousands. Past this budget we just skip the fade visual; the
// demotion itself (the mass-conserving part) still happens.
const FADING_GHOST_MAX = 2000;

// Age the demote ghosts and retire the expired ones. Cheap: the list
// is empty unless reservePass demoted something in the last
// RESERVE_FADE_SEC of sim time.
function advanceFadingGhosts(world: World, dt: number): void {
  const g = world.fadingGhosts;
  if (g.length === 0) return;
  let w = 0;
  for (let i = 0; i < g.length; i++) {
    g[i].age += dt;
    if (g[i].age < RESERVE_FADE_SEC) {
      if (w !== i) g[w] = g[i];
      w++;
    }
  }
  g.length = w;
}

// DNase-like degradation: a shed fragment is viable for this long
// before it is retired. Bounds accumulation and makes shed/uptake
// timing an evolvable trade-off rather than a free broadcast.
const EDNA_LIFETIME_SEC = 30;
// Hard ceiling on simultaneously-live carriers. A burst die-off can't
// be allowed to balloon the list unbounded; past this the oldest are
// dropped (they were closest to DNase retirement anyway).
const EDNA_CARRIER_MAX = 4000;
// Host-scoped buffer (intracellular EGT) is bounded: newly shed
// fragments append, oldest bytes trim past this. A few fragments'
// worth -- enough that recurrent symbiont death keeps material
// available, not so much that one host hoards a whole genome.
const EDNA_HOST_BUFFER_MAX = 4 * GENE_FRAGMENT_CAP;

const EMPTY_BYTES = new Uint8Array(0);

// Deterministic source-window offset for a shed fragment. Uses the
// landed mixHash (NOT simRng) keyed on stable per-event values so the
// world RNG draw order is byte-identical -- only the new behavior, not
// RNG reordering, may move the golden hash. Which gene travels is thus
// emergent-but-reproducible.
function shedOffset(seedA: number, seedB: number, len: number): number {
  if (len <= 0) return 0;
  return mixHash(seedA, seedB | 0, len) % len;
}

// Age the extracellular-DNA carriers and retire the expired ones, then
// enforce the hard cap (drop oldest first). Same cheap compaction
// pattern as advanceFadingGhosts; the list is empty unless something
// has shed recently. Fixed position in the step order (right after
// advanceFadingGhosts) so it never perturbs simRng draw order.
function advanceEDnaCarriers(world: World, dt: number): void {
  const cs = world.eDnaCarriers;
  if (cs.length === 0) return;
  let w = 0;
  for (let i = 0; i < cs.length; i++) {
    cs[i].age += dt;
    if (cs[i].age < EDNA_LIFETIME_SEC) {
      if (w !== i) cs[w] = cs[i];
      w++;
    }
  }
  cs.length = w;
  if (cs.length > EDNA_CARRIER_MAX) {
    // Oldest first = front of the list (carriers are appended on shed
    // and only compacted in place above, so order is shed order).
    cs.splice(0, cs.length - EDNA_CARRIER_MAX);
  }
}

// Per-competent-tick probability that a competent cell actually
// integrates an available fragment. Transformation is a rare event;
// this is a physical uptake-efficiency constant (like a reaction
// VMAX), not a hard-coded strategy -- it bounds genome growth so a
// cell sitting in a fragment-rich region doesn't bloat every tick.
const EDNA_UPTAKE_RATE = 0.01;

// Active packaging (SYNTH PACKAGE): per-expressing-tick probability of
// actually shedding a self-fragment, and the ATP charged per shed
// event. The cadence gate keeps a cell that holds PACKAGE high from
// emitting one carrier every tick; ATP makes the donor strategy a real
// metabolic investment (so virus/plasmid behavior must pay its way),
// not a free broadcast. Physical constants, not a scripted strategy.
const EDNA_PACKAGE_RATE = 0.05;
const EDNA_PACKAGE_ATP = 0.4;

// Competent cells integrate a fragment from the shared free-water eDNA
// pool (region-local carriers, which PERSIST -- natural transformation
// from a shared pool, retired only by DNase decay) and from their own
// host-scoped buffer (intracellular EGT, CONSUMED on integration: the
// one host processes it). Determinism: stable creature order, region-
// local lookup, and the rare-event gate + recombination offset come
// from the landed hashUnit/mixHash keyed on stable ids (never simRng),
// so the world RNG draw order stays byte-identical -- only the new
// behavior (and the SYNTH_KIND_COUNT modulo shift) moves golden.
// Integration is append-only, so every PC stays valid (no clamp), and
// genome bytes are not matter, so mass conservation is untouched.
export function eDnaUptakePass(world: World): void {
  const cs = world.eDnaCarriers;
  let byRegion: Map<number, EDnaCarrier[]> | null = null;
  if (cs.length > 0) {
    byRegion = new Map();
    for (const e of cs) {
      const ri = regionIndexAt(world, e.x, e.y);
      let b = byRegion.get(ri);
      if (!b) { b = []; byRegion.set(ri, b); }
      b.push(e);
    }
  }
  // ms-resolution time seed: world.t advances by dt deterministically,
  // so this is reproducible and varies every tick (unlike world.t|0,
  // which is constant for ~60 consecutive ticks).
  const tSeed = Math.round(world.t * 1000) | 0;
  for (const c of world.creatures) {
    if ((c.vmOut.synthMask & (1 << SYNTH_BIT_COMPETENCE)) === 0) continue;
    let changed = false;
    const buf = c.eDnaBuffer;
    if (buf && buf.length > 0
        && hashUnit(c.id, tSeed, 0x45475431) < EDNA_UPTAKE_RATE) {
      const off = mixHash(c.id, tSeed, buf.length) % buf.length;
      c.genome = appendGenomeBytes(c.genome, buf, off, GENE_FRAGMENT_CAP);
      c.eDnaBuffer = null;
      changed = true;
    }
    if (byRegion) {
      const bucket = byRegion.get(regionIndexAt(world, c.x, c.y));
      if (bucket && bucket.length > 0
          && hashUnit(c.id, tSeed, 0x48475431) < EDNA_UPTAKE_RATE) {
        const e = bucket[0]; // deterministic: first in stable order
        if (e.payload.length > 0) {
          const off = mixHash(c.id, tSeed, e.payload.length) % e.payload.length;
          c.genome = appendGenomeBytes(
            c.genome, e.payload, off, GENE_FRAGMENT_CAP,
          );
          changed = true;
        }
      }
    }
    if (changed) {
      // A transferred fragment may carry SENSE_AMP / THRUST_AMP bytes;
      // recompute derived traits exactly as the splice path does.
      c.senseRange = computeSenseRange(c.genome);
      c.thrustAccel = computeThrustAccel(c.genome);
    }
  }
}

// Per-tick scratch for reservePass's proportional balancing.
const RESERVE_CHEMCOUNT = new Uint32Array(CHEMICAL_COUNT); // visible count / chem
const RESERVE_TOT = new Float64Array(CHEMICAL_COUNT);      // visible+reserve equiv / chem
const RESERVE_WANT = new Int32Array(CHEMICAL_COUNT);       // desired visible / chem
const RESERVE_SURPLUS = new Int32Array(CHEMICAL_COUNT);    // visible - want (positive)
const RESERVE_ORDER = new Uint8Array(CHEMICAL_COUNT);      // chem ids, sorted by tot desc
// In the greedy allocation each chem may claim at most this fraction
// of the particle cap STILL UNALLOCATED when its turn comes (descending
// by abundance). The draw-down bounds rarer chems by a shrinking pool
// and stops one abundant byproduct (e.g. minerals) from crowding the
// field; leftover capacity is intentionally left unused.
const PARTICLE_PER_CHEM_FRAC = 0.20;
function reservePass(world: World): void {
  // Reserve demote/promote + the visible cap run from t=0, including
  // during initial population. (The settle window still lets seedRamp
  // / precipitate overfill past particleTarget via effectiveParticleCap;
  // reservePass just moves that surplus into reserve instead of
  // leaving it visible -- there's no reason to pause recirculation.)
  const target = world.particleTarget;
  const store = world.particleStore;
  const res = world.reserve;
  const FOUR_THIRDS_PI = (4 / 3) * Math.PI;
  const volPer = FOUR_THIRDS_PI * PRECIP_R * PRECIP_R * PRECIP_R;
  // Keep the VISIBLE particle mix a proportional sample of the
  // TOTAL (visible + reserve) mix, per chemical, capped at
  // particleTarget. Payload particles (genericChem/molecules) carry
  // identity -> never demoted; they hold visible slots and shrink
  // the budget available to fungible chems.
  const cols = regionCols(world);
  const rows = regionRows(world);
  const nReg = cols * rows;
  const surfaceY = world.surfaceY;
  const visN = RESERVE_CHEMCOUNT; // non-payload visible count / chem
  visN.fill(0);
  let payloadN = 0;
  for (let i = 0; i < world.particles.length; i++) {
    if (store.genericChem[i] || store.molecules[i]) { payloadN++; continue; }
    visN[store.chemId[i]]++;
  }
  const tot = RESERVE_TOT; // visible + reserve-equivalent count / chem
  for (let k = 0; k < AMBIENT_STRIDE; k++) {
    const density = CHEM_BASE_DENSITY[k] > 0 ? CHEM_BASE_DENSITY[k] : 1;
    // reserve stores AMOUNT; a PRECIP particle is density*volPer of
    // PHYSICAL mass == amountPer moles of this chem.
    const amountPer = (density * volPer) / CHEM_MM[k];
    let rmass = 0;
    for (let ri = 0; ri < nReg; ri++) rmass += res[ri * AMBIENT_STRIDE + k];
    const resEquiv = amountPer > 0 ? rmass / amountPer : 0;
    tot[k] = visN[k] + resEquiv;
  }
  // "Ideal" visible allocation. Two rules, in order:
  //  1. Presence guarantee: any chem whose total (visible+reserve)
  //     rounds to exactly one particle-equivalent always gets a
  //     visible slot, so a lone unit never disappears into reserve.
  //  2. Greedy descending 20%-of-remaining: process chems from most
  //     to least abundant (by total). `remaining` starts at the global
  //     particle cap less identity-carrying payload (payload can't be
  //     demoted, so it's reserved off the top; with no payload this is
  //     exactly world.particleTarget, e.g. 2500). Each chem may claim
  //     at most floor(20% * remaining) -- and never more than it
  //     actually has -- then that much is drawn down from `remaining`.
  //     Rarer chems are bounded by a shrinking pool; any leftover
  //     capacity is intentionally NOT reallocated.
  const want = RESERVE_WANT;
  for (let k = 0; k < AMBIENT_STRIDE; k++) want[k] = 0;
  let remaining = Math.max(0, target - payloadN);
  // Rule 1.
  for (let k = 0; k < AMBIENT_STRIDE; k++) {
    if (Math.round(tot[k]) === 1) {
      want[k] = 1;
      if (remaining > 0) remaining--;
    }
  }
  // Rule 2: descending by total.
  const order = RESERVE_ORDER.subarray(0, AMBIENT_STRIDE);
  for (let k = 0; k < AMBIENT_STRIDE; k++) order[k] = k;
  order.sort((a, b) => tot[b] - tot[a]);
  for (let oi = 0; oi < AMBIENT_STRIDE; oi++) {
    const k = order[oi];
    if (want[k] === 1 && Math.round(tot[k]) === 1) continue; // singleton (rule 1)
    const desired = Math.round(tot[k]);
    if (desired <= 0) { want[k] = 0; continue; }
    const stepCap = Math.floor(PARTICLE_PER_CHEM_FRAC * remaining);
    const give = desired < stepCap ? desired : stepCap;
    want[k] = give;
    remaining -= give;
  }

  // --- Demote per-chem surplus (visN[k] > want[k]) into local
  // reserve, one descending pass; mass-conserving.
  const surplus = RESERVE_SURPLUS;
  let anySurplus = false;
  for (let k = 0; k < AMBIENT_STRIDE; k++) {
    const s = visN[k] - want[k];
    surplus[k] = s > 0 ? s : 0;
    if (s > 0) anySurplus = true;
  }
  if (anySurplus) {
    // SLEEP_SPEED_SQ in px^2/s^2: only particles essentially at rest get
    // a fading ghost. Vent plumes and other in-flight particles freeze
    // into a visible trajectory artifact if we ghost them mid-flight
    // (the demotion order picks the newest spawn first, which for the
    // vent is the freshest ejected particle still climbing).
    const px = store.x, py = store.y, pz = store.z;
    const pvx = store.vx, pvy = store.vy, pvz = store.vz;
    for (let i = world.particles.length - 1; i >= 0; i--) {
      if (i >= world.particles.length) continue;
      if (store.genericChem[i] || store.molecules[i]) continue;
      const k = store.chemId[i];
      if (surplus[k] <= 0) continue;
      const r = store.r[i];
      const density = store.density[i] !== 0 ? store.density[i] : CHEM_BASE_DENSITY[k];
      res[regionIndexAt(world, px[i], py[i]) * AMBIENT_STRIDE + k]
        += (density * FOUR_THIRDS_PI * r * r * r) / CHEM_MM[k];
      const vx = pvx[i], vy = pvy[i], vz = pvz[i];
      const settled = vx * vx + vy * vy + vz * vz < SLEEP_SPEED_SQ;
      if (settled && world.fadingGhosts.length < FADING_GHOST_MAX) {
        world.fadingGhosts.push({
          x: px[i], y: py[i], z: pz[i],
          r, chemId: k, age: 0,
        });
      }
      removeParticleAt(world, i);
      surplus[k]--;
    }
  }

  // --- Promote per-chem deficit (want[k] > visN[k]) from that
  // chem's reserve, drawing mass region-locally.
  for (let k = 0; k < AMBIENT_STRIDE; k++) {
    let need = want[k] - visN[k];
    if (need <= 0) continue;
    const density = CHEM_BASE_DENSITY[k] > 0 ? CHEM_BASE_DENSITY[k] : 1;
    // reserve is AMOUNT; one PRECIP particle drains amountPer moles.
    const amountPer = (density * volPer) / CHEM_MM[k];
    if (amountPer <= 0) continue;
    for (let ri = 0; ri < nReg && need > 0; ri++) {
      const ak = ri * AMBIENT_STRIDE + k;
      let avail = res[ak];
      if (avail < amountPer) continue;
      const rx = ri % cols, ry = (ri / cols) | 0;
      const x0 = rx * REGION_PX, y0 = ry * REGION_PX;
      while (avail >= amountPer && need > 0) {
        const px = Math.min(world.width - 1, x0 + simRng() * REGION_PX);
        let py = y0 + simRng() * REGION_PX;
        if (py < surfaceY + PRECIP_R) py = surfaceY + PRECIP_R;
        py = Math.min(world.height - PRECIP_R, py);
        pushParticle(world, {
          x: px, y: py, z: PRECIP_R + simRng() * (world.depth - 2 * PRECIP_R),
          vx: 0, vy: 0, vz: 0, r: PRECIP_R, chemId: k, density,
        });
        avail -= amountPer;
        need--;
      }
      res[ak] = avail;
    }
  }

  // --- Hard-cap backstop (rounding / payload-heavy edge cases):
  // shed any remaining non-payload first, then payload as the
  // absolute last resort, so particles.length <= target always.
  if (world.particles.length > target) {
    for (let pass = 0; pass < 2 && world.particles.length > target; pass++) {
      for (let i = world.particles.length - 1; i >= 0 && world.particles.length > target; i--) {
        if (i >= world.particles.length) continue;
        if (pass === 0 && (store.genericChem[i] || store.molecules[i])) continue;
        const k = store.chemId[i];
        const r = store.r[i];
        const density = store.density[i] !== 0 ? store.density[i] : CHEM_BASE_DENSITY[k];
        res[regionIndexAt(world, store.x[i], store.y[i]) * AMBIENT_STRIDE + k]
          += (density * FOUR_THIRDS_PI * r * r * r) / CHEM_MM[k];
        removeParticleAt(world, i);
      }
    }
  }
}
// ===================================================================


// Phase F: generalized passive diffusion. Each diffusable chem flows
// down its gradient between the cell's pool and world.ambient, with
// rate scaled by per-chem permeability * cell surface area. Mass
// conserved across cell and ambient. Replaces the old O2/CO2-only
// hard-coded path.
//
// AMBIENT_FLOW_RATE: shared dimensionless scaler so individual
// chems' permeability values stay in the 0..1 range. Tuned so O2
// at permeability 1.0 + surface 1.0 + gap 12 yields ~0.7 mass/sec,
// matching the old `O2_DIFFUSION_PER_R * 0.1` rate.
const AMBIENT_FLOW_RATE = 0.6;

// Phase K-3: activation pass. Each tick, populate activated_*
// receptor chems from `receptor_pool * stimulus * dt`, with a
// shared decay factor `1 - ACT_DECAY*dt` applied to the current
// pool. Activated pools persist across ticks (cells get a short
// time-series readout for free) but they're "computed" -- mass
// conservation explicitly excludes signal chems.
const ACT_DECAY = 2.0;            // per second; ~0.35s half-life
const VEL_TO_FORCE_GAIN = 0.5;    // velocity contribution to perceived mech
const TEMP_BASELINE = 15;         // °C; activated_thermo encodes departure
const MAG_FIELD_X = 0;            // compass field: pointing toward +Y (south)
const MAG_FIELD_Y = -1;           // -Y is "north" in screen coords
// Phase 5 retired the CHEMO branch of runActivation; the per-target
// receptor/signal-chem arrays it iterated were deleted along with it.
// CHEM_CHEMORECEPTOR_* and CHEM_ACT_CHEMO_*_X/Y ids remain in the
// chem table (no renumber) but are no longer written.
// `host` is set only for engulfed organelles. The penetrating physical
// fields (PHOTO/THERMO/MAGNETO/MECH) are identical either way -- they
// reach the organelle through the host's position. CHEMO differs: a
// free cell reads a spatial ∇ of the world particle field; an
// organelle has no spatial gradient inside a host, so it instead
// senses the host cytoplasm's CONCENTRATION of each target chem
// (option 1). That value goes in the X activation slot; Y is inert
// (no direction inside a host).
function runActivation(c: Creature, world: World, dt: number, host?: Creature): void {
  const s = c.store; const i = c.idx;
  const cols = s.chemCols;
  const k = Math.max(0, 1 - ACT_DECAY * dt);
  const sunlight = solarLight(world);
  const depthRatio = Math.max(0, c.y / LIGHT_DECAY);
  // PHOTO: 3 bands. Visible attenuates at LIGHT_DECAY (the canonical
  // depth e-fold). Long-penetrating attenuates 3x slower. Surface
  // is depth-invariant -- cells anywhere read it equally.
  const lightVis = Math.exp(-depthRatio) * sunlight;
  const lightLong = Math.exp(-depthRatio / 3) * sunlight;
  const lightSurf = sunlight;
  cols[CHEM_ACT_PHOTO_VISIBLE][i] = cols[CHEM_ACT_PHOTO_VISIBLE][i] * k
    + cols[CHEM_PHOTORECEPTOR_VISIBLE][i] * lightVis * dt;
  cols[CHEM_ACT_PHOTO_LONG][i] = cols[CHEM_ACT_PHOTO_LONG][i] * k
    + cols[CHEM_PHOTORECEPTOR_LONG][i] * lightLong * dt;
  cols[CHEM_ACT_PHOTO_SURFACE][i] = cols[CHEM_ACT_PHOTO_SURFACE][i] * k
    + cols[CHEM_PHOTORECEPTOR_SURFACE][i] * lightSurf * dt;
  // THERMO: receptor * (local temp - baseline). Reads the diffused
  // regional cache so vent heat actually reaches the receptor.
  const tempOff = regionTempAt(world, c.x, c.y) - TEMP_BASELINE;
  cols[CHEM_ACT_THERMO][i] = cols[CHEM_ACT_THERMO][i] * k
    + cols[CHEM_THERMORECEPTOR][i] * tempOff * dt;
  // MECH: receptor * (net force + velocity contribution).
  const mechR = cols[CHEM_MECHANORECEPTOR][i];
  if (mechR > 0) {
    const fx = s.ax[i] + c.vx * VEL_TO_FORCE_GAIN;
    const fy = s.ay[i] + c.vy * VEL_TO_FORCE_GAIN;
    cols[CHEM_ACT_MECH_X][i] = cols[CHEM_ACT_MECH_X][i] * k + mechR * fx * dt;
    cols[CHEM_ACT_MECH_Y][i] = cols[CHEM_ACT_MECH_Y][i] * k + mechR * fy * dt;
  } else {
    cols[CHEM_ACT_MECH_X][i] *= k;
    cols[CHEM_ACT_MECH_Y][i] *= k;
  }
  // MAGNETO: receptor * fixed compass field.
  const magR = cols[CHEM_MAGNETORECEPTOR][i];
  cols[CHEM_ACT_MAG_X][i] = cols[CHEM_ACT_MAG_X][i] * k + magR * MAG_FIELD_X * dt;
  cols[CHEM_ACT_MAG_Y][i] = cols[CHEM_ACT_MAG_Y][i] * k + magR * MAG_FIELD_Y * dt;
  // Phase 5: the CHEMO branch (4 receptor-gated particle-gradient
  // signals into CHEM_ACT_CHEMO_*_X/Y) is retired -- SENSE_OUT
  // <chemId> reads the same chemGradient universally for any chem,
  // with no SYNTH'd receptor required. The receptor + signal chem
  // ids (CHEM_CHEMORECEPTOR_*, CHEM_ACT_CHEMO_*_X/Y) remain in the
  // chem table at their existing ids to avoid renumbering ripple;
  // their pools are simply no longer written, so they stay 0 unless
  // a legacy lineage's bootstrap reaction (slots 15-18) still
  // produces a trickle.
  void host;
}

function diffuseAmbient(c: Creature, world: World, dt: number): void {
  const s = c.store; const i = c.idx;
  const surface = s.r[i] / MIN_CREATURE_R;
  const ambient = world.ambient;
  const cols = s.chemCols;
  // Cell exchanges with the dissolved field of the region it's in.
  const ab = ambientBaseAt(world, s.x[i], s.y[i]);
  for (let j = 0; j < DIFFUSABLE_CHEM_IDS.length; j++) {
    const k = DIFFUSABLE_CHEM_IDS[j];
    const perm = CHEM_PERMEABILITY[k];
    if (perm <= 0) continue;
    const ak = ab + k;
    const gap = ambient[ak] - cols[k][i];
    if (gap === 0) continue;
    let flow = perm * surface * gap * AMBIENT_FLOW_RATE * dt;
    // Strict mass conservation: a transfer can't move more than the
    // SOURCE side actually holds. Inflow (flow > 0) is capped by the
    // region's stock; outflow by the cell's pool. (The old code
    // credited the cell the full flow and just clamped ambient at 0,
    // minting the shortfall every tick a cell sat in a depleted
    // region -- the dominant mass leak.)
    if (flow > 0) { if (flow > ambient[ak]) flow = ambient[ak]; }
    else { const avail = cols[k][i]; if (-flow > avail) flow = -avail; }
    cols[k][i] += flow;
    ambient[ak] -= flow;
  }
}

// Phase G: free particles of soluble chems dissolve into the ambient
// pool when ambient[chemId] is below the chemical's solubility. Mass-
// conserving: every unit removed from the particle is added to ambient.
// Particles that drop below MIN_DISSOLVE_R fully dissolve (removed and
// remaining mass dumped to ambient). Gas-phase chems also outgas
// (negative gap) but the particle stays; ambient shrinks toward
// saturation. Real physical chemistry has both directions; for MVP
// we only model dissolution-into-ambient and let outgassing spawn
// new particles through future phase-G work.
const DISSOLVE_RATE_PER_AREA = 0.05;
const MIN_DISSOLVE_R = 0.6;
function dissolveParticles(world: World, dt: number): void {
  const store = world.particleStore;
  const ambient = world.ambient;
  const PC = store.chemId;
  const PR = store.r;
  const PY = store.y;
  const surfaceY = world.surfaceY;
  const FOUR_THIRDS_PI = (4 / 3) * Math.PI;
  // Iterate in reverse so removeParticleAt's swap-pop doesn't skip entries.
  const PX = store.x;
  for (let i = world.particles.length - 1; i >= 0; i--) {
    if (PY[i] < surfaceY) continue; // particle above water -- can't dissolve
    const chemId = PC[i];
    // Multi-chem corpse particles (genericChem payload) keep their
    // chem identity through the corpse path; don't dissolve them.
    if (store.genericChem[i]) continue;
    if (store.molecules[i]) continue;
    const r = PR[i];
    if (r <= 0) continue;
    // Dissolve into the LOCAL region's block, capped by that
    // region's molar-solubility capacity at its temperature.
    const ri = regionIndexAt(world, PX[i], PY[i]);
    const cap = regionDissolvedCapacity(chemId, world, world.regionTemp.length > ri ? world.regionTemp[ri] : TEMP_BASELINE);
    if (cap <= 0) continue;
    const ak = ri * AMBIENT_STRIDE + chemId;
    // Hysteresis: only (re)start dissolving once the region is below
    // the LOW watermark (90% of capacity). Precipitation drives it
    // back down to ~capacity; the 90..100% deadband stops a freshly
    // precipitated particle from instantly re-dissolving (thrash).
    if (ambient[ak] >= REGION_DISSOLVE_LO * cap) continue;
    const gap = cap - ambient[ak];
    if (gap <= 0) continue;
    const density = store.density[i] !== 0 ? store.density[i] : CHEM_BASE_DENSITY[chemId];
    const mm = CHEM_MM[chemId];
    const physMass = density * FOUR_THIRDS_PI * r * r * r;
    // ambient stores AMOUNT (moles); the particle is PHYSICAL MASS.
    const amountTotal = physMass / mm;
    // Rate proportional to surface area (4*pi*r^2) and capacity gap
    // (gap is in amount units, so this is an amount).
    const dissolveAmount = DISSOLVE_RATE_PER_AREA * gap * (r * r) * dt;
    if (dissolveAmount >= amountTotal || r * Math.cbrt(1 - dissolveAmount / amountTotal) < MIN_DISSOLVE_R) {
      ambient[ak] += amountTotal;
      removeParticleAt(world, i);
    } else {
      const newMass = (amountTotal - dissolveAmount) * mm;
      PR[i] = Math.cbrt((3 * newMass) / (4 * Math.PI * density));
      ambient[ak] += dissolveAmount;
    }
  }
}

// Waste mineralization. Real detritus doesn't pile up forever -- it
// breaks down. Waste slowly denatures into CO2 (mass-conserving),
// which re-enters the food web via photosynthesis. Applies to every
// waste store: the dissolved field, the reserve field, molecule-tagged
// excreted-waste particles (payload waste -> co2, so the particle
// becomes an ordinary CO2 bubble that can dissolve/be eaten), and
// plain waste-chem death-debris particles (shrink, depositing the
// converted mass into the local dissolved CO2). ~5-min half-life:
// fast enough to bound accumulation, slow enough that waste still
// matters as a short-term toxin.
const WASTE_DENATURE_HALFLIFE_S = 300;
export function denatureWaste(world: World, dt: number): void {
  const frac = 1 - Math.pow(0.5, dt / WASTE_DENATURE_HALFLIFE_S);
  if (frac <= 0) return;
  const amb = world.ambient;
  const res = world.reserve;
  const nReg = amb.length / AMBIENT_STRIDE;
  for (let ri = 0; ri < nReg; ri++) {
    const base = ri * AMBIENT_STRIDE;
    const aw = amb[base + CHEM_WASTE];
    if (aw > 0) { const d = aw * frac; amb[base + CHEM_WASTE] = aw - d; amb[base + CHEM_CO2] += d; recordRxn(RX_DENATURE_WASTE, RX_LOC_FIELD, 0); }
    const rw = res[base + CHEM_WASTE];
    if (rw > 0) { const d = rw * frac; res[base + CHEM_WASTE] = rw - d; res[base + CHEM_CO2] += d; recordRxn(RX_DENATURE_WASTE, RX_LOC_FIELD, 0); }
  }
  const store = world.particleStore;
  const FOUR_THIRDS_PI = (4 / 3) * Math.PI;
  for (let i = world.particles.length - 1; i >= 0; i--) {
    const mol = store.molecules[i];
    if (mol) {
      if (mol.waste > 0) { const d = mol.waste * frac; mol.waste -= d; mol.co2 += d; recordRxn(RX_DENATURE_WASTE, RX_LOC_FIELD, 0); }
      continue;
    }
    if (store.chemId[i] !== CHEM_WASTE) continue;
    const r = store.r[i];
    const density = store.density[i] !== 0 ? store.density[i] : CHEM_BASE_DENSITY[CHEM_WASTE];
    const mass = density * FOUR_THIRDS_PI * r * r * r;
    const dm = mass * frac;
    const base = regionIndexAt(world, store.x[i], store.y[i]) * AMBIENT_STRIDE;
    amb[base + CHEM_CO2] += dm;
    recordRxn(RX_DENATURE_WASTE, RX_LOC_FIELD, 0);
    const newMass = mass - dm;
    const newR = Math.cbrt((3 * newMass) / (4 * Math.PI * density));
    if (newR < MIN_DISSOLVE_R) removeParticleAt(world, i);
    else store.r[i] = newR;
  }
}

// Mineral weathering. Minerals are ~insoluble, so mineral PARTICLES
// (from maintenance/catalyst decay -> 0.5 min, then precipitated) would
// otherwise persist forever and pile up. Slowly weather mineral
// particles back into the LOCAL dissolved field so cells can re-uptake
// them (SYNTH_* consume CHEM_MIN). Acts ONLY on active particles --
// the reserve pool is intentionally left untouched. Mass-conserving
// (CHEM_MIN molarMass is 1, so particle physical mass == amount).
const MINERAL_WEATHER_HALFLIFE_S = 90;
function weatherMinerals(world: World, dt: number): void {
  const frac = 1 - Math.pow(0.5, dt / MINERAL_WEATHER_HALFLIFE_S);
  if (frac <= 0) return;
  const amb = world.ambient;
  const store = world.particleStore;
  const FOUR_THIRDS_PI = (4 / 3) * Math.PI;
  for (let i = world.particles.length - 1; i >= 0; i--) {
    if (store.molecules[i]) continue;
    if (store.chemId[i] !== CHEM_MIN) continue;
    const r = store.r[i];
    const density = store.density[i] !== 0 ? store.density[i] : CHEM_BASE_DENSITY[CHEM_MIN];
    const mass = density * FOUR_THIRDS_PI * r * r * r;
    const dm = mass * frac;
    const base = regionIndexAt(world, store.x[i], store.y[i]) * AMBIENT_STRIDE;
    amb[base + CHEM_MIN] += dm; // CHEM_MIN molarMass == 1: physMass == amount
    const newMass = mass - dm;
    const newR = Math.cbrt((3 * newMass) / (4 * Math.PI * density));
    if (newR < MIN_DISSOLVE_R) removeParticleAt(world, i);
    else store.r[i] = newR;
  }
}

// Ambient ↔ atmosphere equilibration. Once per tick, gases in the
// atmosphere dissolve into ambient (and vice versa) toward
// AMBIENT_TARGET. Mass conserved: every unit added to ambient is
// removed from atmosphere. Driven by surface activity so a calm
// surface lets gases stratify; a stormy surface mixes them in.
const ATM_AMBIENT_RATE = 0.5; // fraction of gap that crosses per sec at peak activity
// O2 surface exchange is driven 10x harder than the base rate so the
// surface layer stays oxygenated and feeds the bulk by diffusion. CO2
// deliberately stays at 1x (see aerateAmbient) so it accumulates and
// gives chlorophyll users a carbon niche.
const O2_SURFACE_EXCHANGE_MULT = 10;
// Asymmetric boundary. O2 is open: the atmosphere is effectively
// unbounded outside air, relaxed back toward baseline each tick so
// dissolved O2 can always be replenished regardless of biological
// demand. CO2 is CLOSED: the atmospheric CO2 pool is finite and
// conserved -- respired CO2 returns to it via the surface exchange
// below, photosynthesis draws it back down, and nothing vents it out
// of the system. Carbon is therefore mass-closed (an ocean is a vast
// carbonate buffer that recycles carbon, not exports it); O2 is the
// one deliberate open reservoir.
const ATM_VENT_RATE = 0.25; // fraction of (baseline - current)/sec, O2 only
function aerateAmbient(world: World, dt: number): void {
  const ambient = world.ambient;
  const atm = world.atmosphere;
  // Open boundary for O2 only: relax atmospheric O2 toward outside-air
  // baseline. CO2 is intentionally NOT vented -- it is a conserved pool.
  const vent = Math.min(1, ATM_VENT_RATE * dt);
  atm.o2 += (ATMOSPHERE_INIT_O2 - atm.o2) * vent;
  // Surface activity 0..1; even calm water has 0.3 of the rate.
  const act = 0.3 + 0.7 * surfaceActivity(world);
  const baseRate = ATM_AMBIENT_RATE * act * dt;
  const cols = regionCols(world);
  const nRegions = cols * regionRows(world);
  // Gas exchange is a SURFACE phenomenon: only the region row that
  // straddles the air/water interface exchanges with the atmosphere.
  // O2/CO2 reach the deep water solely by diffuseRegions carrying the
  // dissolved field downward -- so a real depth gradient (oxygenated
  // surface, potentially anoxic deep) can emerge instead of every
  // region being magically equilibrated with air.
  const surfaceRow = Math.min(
    regionRows(world) - 1,
    Math.max(0, (world.surfaceY / REGION_PX) | 0),
  );
  // Per-gas surface-exchange multiplier. O2 is pushed hard (10x) so
  // the surface stays well oxygenated and feeds the bulk via
  // diffusion. CO2 stays at the base rate ON PURPOSE: we want
  // dissolved CO2 to build up somewhat instead of being vented out
  // fast, so chlorophyll users have a carbon source to exploit.
  const pairs: Array<[number, keyof Molecules, number]> = [
    [CHEM_O2, "o2", O2_SURFACE_EXCHANGE_MULT],
    [CHEM_CO2, "co2", 1],
  ];
  for (const [k, molKey, mult] of pairs) {
    const target = AMBIENT_TARGET[k];
    if (target <= 0) continue;
    const rate = baseRate * mult;
    for (let r = 0; r < nRegions; r++) {
      if (((r / cols) | 0) !== surfaceRow) continue;
      const ak = r * AMBIENT_STRIDE + k;
      const gap = target - ambient[ak];
      let flow = gap * rate;
      if (flow > 0) {
        if (flow > atm[molKey]) flow = atm[molKey];
      } else {
        const limit = ambient[ak];
        if (-flow > limit) flow = -limit;
      }
      ambient[ak] += flow;
      atm[molKey] -= flow;
    }
  }
}

// Aerobic respiration / fermentation / beta-oxidation / photosynthesis
// were each a dedicated function reading m_* fields and mutating
// them in place. In phase 2 they're all entries in REACTIONS[0..3]
// driven by runGenericReactions(), with uncatRate matching the old
// VMAX -- catalyst pool only adds on top. ATP/ADP mass conservation
// is handled by the engine (atpDelta is the energy delta; the same
// magnitude flows the other way through chemCols[CHEM_ADP]).

// ATP floor: biosynthesis tapers off as the cell's ATP approaches
// this value, and stops entirely below it. Without this, a newborn
// with limited ATP burns through it building expensive products
// (chlorophyll at 8 ATP/unit, enzyme at 4) it doesn't actually need
// yet, and starves before respiration can refill the pool. Real cells
// downregulate growth under energy stress; this is the same idea.
const BIOSYNTH_ATP_FLOOR = 4;

// biosynthesize() retired in phase 2 -- all biosynth pathways are now
// table entries in REACTIONS[4..9] driven by runGenericReactions().

// Generic reaction runner for paths outside the REACTIONS table -- the
// engine itself inlines the same logic for perf, but for one-off
// reactions where the product lives somewhere other than chemCols
// (catalystCols, or a future "atmosphere", etc.) this shares the
// substrate gate + MM saturation + ATP/ADP bookkeeping so we don't
// drift from the engine's math. Caller's writeProduct(amt) sees the
// final reaction extent and handles wherever the product belongs.
function runSyntheticReaction(
  c: Creature, dt: number,
  sChem: ArrayLike<number>, sCount: ArrayLike<number>,
  atpDelta: number, vmax: number, atpFloor: boolean,
  writeProduct: (amt: number) => void,
): void {
  const s = c.store; const i = c.idx;
  const KM = KM_DEFAULT;
  let limit = Infinity;
  let satProduct = 1;
  for (let j = 0; j < sChem.length; j++) {
    const have = s.chemCols[sChem[j]][i];
    const need = sCount[j];
    const ratio = have / need;
    if (ratio < limit) limit = ratio;
    satProduct *= ratio / (ratio + KM);
  }
  if (limit <= 0) return;
  if (atpDelta < 0) {
    const floor = atpFloor ? BIOSYNTH_ATP_FLOOR : 0;
    const eAvail = (s.energy[i] - floor) / -atpDelta;
    if (eAvail <= 0) return;
    if (eAvail < limit) limit = eAvail;
    satProduct *= eAvail / (eAvail + KM);
  } else if (atpDelta > 0) {
    const adpAvail = s.chemCols[CHEM_ADP][i] / atpDelta;
    if (adpAvail <= 0) return;
    if (adpAvail < limit) limit = adpAvail;
    satProduct *= adpAvail / (adpAvail + KM);
  }
  const rate = vmax * satProduct;
  let amt = rate * dt;
  if (amt > limit) amt = limit;
  if (amt <= 0) return;
  for (let j = 0; j < sChem.length; j++) {
    s.chemCols[sChem[j]][i] -= sCount[j] * amt;
  }
  if (atpDelta !== 0) {
    s.energy[i] += atpDelta * amt;
    s.chemCols[CHEM_ADP][i] -= atpDelta * amt;
  }
  writeProduct(amt);
}

// Catalyst synthesis. Catalysts live in catalystCols[slot] rather
// than in chemCols, so this can't be a REACTIONS-table entry; but
// the substrate / ATP / saturation math is the same as every biosynth
// reaction, so we delegate to runSyntheticReaction. Substrate fixed
// at 0.5 aa + 0.5 min (same as enzymes / chlorophyll / mRNA).
const CAT_SUBSTRATE_CHEM = new Uint8Array([3, 5]); // aa, min in chemCols
const CAT_SUBSTRATE_COUNT = new Float32Array([0.5, 0.5]);
function biosynthCatalyst(
  c: Creature,
  dt: number,
  vmax: number,
  atpCost: number,
  slot: number,
): void {
  const col = c.store.catalystCols[slot];
  const i = c.idx;
  runSyntheticReaction(
    c, dt, CAT_SUBSTRATE_CHEM, CAT_SUBSTRATE_COUNT,
    -atpCost, vmax, /* atpFloor */ true,
    (amt) => {
      col[i] += amt;
      recordRxn(RX_SYNTH_CATALYST, RX_LOC_CELL, 0);
      recordAtp(ATP_RXN_ENDO, atpCost * amt, 0);
    },
  );
}
// Dual of biosynthCatalyst: same substrate (AA+MIN) and ATP cost,
// but the synthesized pool LIVES in inhibitorCols and DAMPENS its
// target slot's effective rate. Recorded under the same RX as
// catalyst maintenance/synth since the bookkeeping shape is
// identical (mass-conserving recycle through aaMin on decay).
function biosynthInhibitor(
  c: Creature,
  dt: number,
  vmax: number,
  atpCost: number,
  slot: number,
): void {
  const col = c.store.inhibitorCols[slot];
  const i = c.idx;
  runSyntheticReaction(
    c, dt, CAT_SUBSTRATE_CHEM, CAT_SUBSTRATE_COUNT,
    -atpCost, vmax, true,
    (amt) => {
      col[i] += amt;
      recordRxn(RX_SYNTH_CATALYST, RX_LOC_CELL, 0);
      recordAtp(ATP_RXN_ENDO, atpCost * amt, 0);
    },
  );
}

function autoExcrete(c: Creature, world: World): void {
  const s = c.store; const i = c.idx;
  // Metabolic CO2 / waste are dissolved solutes -- excrete them into
  // the local dissolved field, NOT as rendered particles. (Spawning
  // them as particles saturated the cap: ~90% waste within a minute.)
  // denatureWaste turns dissolved waste -> CO2; diffusion spreads it;
  // photosynthesis consumes the CO2. Detritus that cells can eat now
  // comes only from corpse/death waste particles.
  const base = ambientBaseAt(world, c.x, c.y);
  const co2 = s.m_co2[i];
  if (co2 > CO2_EXCRETE_THRESHOLD) {
    const want = co2 - EXCRETE_FLOOR;
    const affordable = Math.min(want, s.energy[i] / EXCRETE_ATP_PER_MASS);
    if (affordable > 0) {
      spendATP(c, affordable * EXCRETE_ATP_PER_MASS, ATP_EXCRETE);
      s.m_co2[i] -= affordable;
      world.ambient[base + CHEM_CO2] += affordable;
    }
  }
  const waste = s.m_waste[i];
  if (waste > WASTE_EXCRETE_THRESHOLD) {
    const want = waste - EXCRETE_FLOOR;
    const affordable = Math.min(want, s.energy[i] / EXCRETE_ATP_PER_MASS);
    if (affordable > 0) {
      spendATP(c, affordable * EXCRETE_ATP_PER_MASS, ATP_EXCRETE);
      s.m_waste[i] -= affordable;
      world.ambient[base + CHEM_WASTE] += affordable;
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
  const s = c.store; const i = c.idx;
  const stressMult = 1 + 4 * Math.max(0, 1 - s.energy[i] / 8);
  // Membrane is the bulk structural reserve; decays into aa + fa
  // (replaces the old biomass decay path).
  const memb = s.m_membrane[i];
  if (memb > 0) {
    const lost = memb * MEMBRANE_DECAY_PER_SEC * stressMult * dt;
    s.m_membrane[i] = memb - lost;
    // Phospholipid hydrolysis: ~65% of bilayer mass is fatty-acyl
    // chains, ~35% glycerophosphate + N head-group (-> aa proxy).
    s.m_aminoAcid[i] += 0.35 * lost;
    s.m_fattyAcid[i] += 0.65 * lost;
    recordRxn(RX_MAINT_MEMBRANE, RX_LOC_CELL, 0);
  }
  const enz = s.m_enzyme[i];
  if (enz > 0) {
    const lost = enz * ENZYME_DECAY_PER_SEC * stressMult * dt;
    s.m_enzyme[i] = enz - lost;
    s.m_aminoAcid[i] += 0.5 * lost;
    s.m_minerals[i] += 0.5 * lost;
    recordRxn(RX_MAINT_ENZ, RX_LOC_CELL, 0);
  }
  const chl = s.m_chlorophyll[i];
  if (chl > 0) {
    const lost = chl * CHLORO_DECAY_PER_SEC * stressMult * dt;
    s.m_chlorophyll[i] = chl - lost;
    s.m_aminoAcid[i] += 0.5 * lost;
    s.m_minerals[i] += 0.5 * lost;
    recordRxn(RX_MAINT_CHL, RX_LOC_CELL, 0);
  }
  const rib = s.m_mrna[i];
  if (rib > 0) {
    const lost = rib * MRNA_DECAY_PER_SEC * stressMult * dt;
    s.m_mrna[i] = rib - lost;
    s.m_aminoAcid[i] += 0.5 * lost;
    s.m_minerals[i] += 0.5 * lost;
    recordRxn(RX_MAINT_MRNA, RX_LOC_CELL, 0);
  }
  // Receptor chems decay at the same rate as other machinery. Cells
  // that don't run biosynth lose their sensing capacity over minutes.
  const RECEPTOR_DECAY_PER_SEC = 0.005;
  const recCols = [
    s.m_photoreceptorVisible, s.m_photoreceptorLong, s.m_photoreceptorSurface,
    s.m_chemoreceptorBiopolymer, s.m_chemoreceptorMinerals, s.m_chemoreceptorFa, s.m_chemoreceptorMarker0,
    s.m_mechanoreceptor, s.m_thermoreceptor, s.m_magnetoreceptor,
  ];
  for (let r = 0; r < recCols.length; r++) {
    const col = recCols[r];
    const v = col[i];
    if (v > 0) {
      const lost = v * RECEPTOR_DECAY_PER_SEC * stressMult * dt;
      col[i] = v - lost;
      s.m_aminoAcid[i] += 0.5 * lost;
      s.m_minerals[i] += 0.5 * lost;
      recordRxn(RX_MAINT_RECEPTOR, RX_LOC_CELL, 0);
    }
  }
  for (let k = 0; k < CATALYST_COUNT; k++) {
    const col = s.catalystCols[k];
    const v = col[i];
    if (v > 0) {
      const lost = v * CAT_DECAY_PER_SEC * stressMult * dt;
      col[i] = v - lost;
      s.m_aminoAcid[i] += 0.5 * lost;
      s.m_minerals[i] += 0.5 * lost;
      recordRxn(RX_MAINT_CATALYST, RX_LOC_CELL, 0);
    }
  }
  // Same shape for the inhibitor pools.
  for (let k = 0; k < CATALYST_COUNT; k++) {
    const col = s.inhibitorCols[k];
    const v = col[i];
    if (v > 0) {
      const lost = v * INH_DECAY_PER_SEC * stressMult * dt;
      col[i] = v - lost;
      s.m_aminoAcid[i] += 0.5 * lost;
      s.m_minerals[i] += 0.5 * lost;
      recordRxn(RX_MAINT_CATALYST, RX_LOC_CELL, 0);
    }
  }
}

// Chemistry for an engulfed cell (endosymbiont). No VM, no motion,
// no excretion to world particles. Same metabolic reactions a free
// cell runs, gated by the inner's static organelleSynthMask. Then
// small molecules diffuse bidirectionally between inner and host so
// surplus ATP / glucose / etc. flows where it's useful. This is the
// whole "subsumed cell becomes organelle" mechanic.
const ORGANELLE_DIFFUSE_PER_SEC = 0.5;   // fraction of (inner - host) gap that crosses per sec
// Max mass of one chem an organelle actively pulls from the host pool
// per uptake event (gated by ingest cooldown + ATP) -- the analog of
// a free cell swallowing one food particle.
const INNER_UPTAKE_MAX = 5;
// Cached list of chemical ids whose CHEMICALS[id].permeability is nonzero.
// Built once from the table so the hot loop iterates a tight array.
// (Replaces the old `diffusable: boolean` -- permeability is the
// continuous version, with zero meaning "structural / can't cross".)
const DIFFUSABLE_CHEM_IDS: number[] = (() => {
  const out: number[] = [];
  for (let i = 0; i < CHEMICAL_COUNT; i++) if (CHEMICALS[i].permeability > 0) out.push(i);
  return out;
})();
// Internal division: an endosymbiont that issues REPRODUCE while
// inside a host fissions into a second inner cell within the SAME
// host's contents. This is the mechanism by which a heritable
// organelle population can establish and be co-inherited (the host
// partitions contents between daughters at its own fission). There is
// deliberately NO cap on how many inner cells a host may hold -- the
// only regulators are the same economic ones a free cell faces (ATP
// attempt cost, membrane/energy split, and autolysis+digestion of
// nonviable inners). No world placement, no division animation: the
// child appears in the vacuole immediately. The only hard limit is
// the shared CreatureStore's physical capacity (same gate free-cell
// fission uses) -- there is no soft per-host cap.
// Per-chem child share for asymmetric division. A PARTITION-registered
// bias for `chemId` skews that chem's split away from the uniform
// `base` reproduce share; the raw bias is squashed to a bounded offset
// and the result clamped to a valid [0,1] fraction, so the
// mother/daughter transfer is always exactly mass-conserving regardless
// of what the genome popped. No bias for this chem -> uniform `base`.
// The substrate primitive for asymmetric determinant segregation:
// identical genomes can diverge into different cytoplasm at division,
// which the existing SENSE_CHEMICAL machinery then lets them act on.
function partitionFrac(out: VMOutputs, base: number, chemId: number): number {
  const n = out.partitionCount;
  for (let q = 0; q < n; q++) {
    if (out.partitionChem[q] === chemId) {
      const v = out.partitionBias[q];
      const f = base + v / (1 + Math.abs(v)); // squash to (-1, 1), shift
      return f < 0 ? 0 : f > 1 ? 1 : f;
    }
  }
  return base;
}

function divideInner(inner: Creature, host: Creature, world: World): void {
  if (!world.creatureStore.canAlloc()) return;
  spendATP(
    inner,
    REPRODUCE_ATTEMPT_ATP_BASE + REPRODUCE_ATTEMPT_ATP_PER_MASS * creatureTotalMass(inner),
    ATP_REPRODUCE,
  );
  const childGenome = mutateGenome(inner.genome, simRng);
  // Same genome-replication material tax a free cell pays, charged
  // before the cytoplasm split.
  chargeGenomeReplication(inner, childGenome);
  const parentShare = inner.vmOut.reproduceFraction;
  const childShare = 1 - parentShare;
  const childMolecules = emptyMolecules();
  for (const mk of MOLECULE_IDS) {
    const give = inner.molecules[mk]
      * partitionFrac(inner.vmOut, childShare, MOLECULE_INDEX[mk]);
    inner.molecules[mk] -= give;
    childMolecules[mk] = give;
  }
  // Path 1: ATP is the `atp` molecule, so the MOLECULE_IDS loop above
  // already split it parent->child (childMolecules.atp) and debited
  // inner. No separate energyGift (that double-moved it).
  const child = newCreature(world.creatureStore, {
    x: host.x, y: host.y, z: host.z,
    r: MIN_CREATURE_R,
    density: inner.density,
    energy: childMolecules.atp,
    senseRange: computeSenseRange(childGenome),
    thrustAccel: computeThrustAccel(childGenome),
    genome: childGenome,
    vm: newVMState(),
    color: genomeColor(childGenome, world.anchorGenome),
    bornAt: world.t,
    speciesKey: genomeKey(childGenome),
    molecules: childMolecules,
  });
  // Proportional split of the independent pools (catalysts + generic
  // chems), mirroring tryReproduce's asexual path.
  {
    const pc = inner.store.catalystCols;
    const cc = child.store.catalystCols;
    const pi = inner.idx; const ci = child.idx;
    for (let k = 0; k < CATALYST_COUNT; k++) {
      const v = pc[k][pi];
      const give = v * childShare;
      pc[k][pi] = v - give;
      cc[k][ci] = give;
    }
  }
  {
    // Same proportional split for the inhibitor pools.
    const pc = inner.store.inhibitorCols;
    const cc = child.store.inhibitorCols;
    const pi = inner.idx; const ci = child.idx;
    for (let k = 0; k < CATALYST_COUNT; k++) {
      const v = pc[k][pi];
      const give = v * childShare;
      pc[k][pi] = v - give;
      cc[k][ci] = give;
    }
  }
  {
    const pc = inner.store.genericChemCols;
    const cc = child.store.genericChemCols;
    const pi = inner.idx; const ci = child.idx;
    for (let k = 0; k < GENERIC_CHEMICAL_COUNT; k++) {
      const v = pc[k][pi];
      const give = v * partitionFrac(inner.vmOut, childShare, NAMED_CHEMICAL_COUNT + k);
      pc[k][pi] = v - give;
      cc[k][ci] = give;
    }
  }
  child.lineageRoot = inner.lineageRoot;
  child.parentId = inner.id;
  child.organelleSynthMask = genomeSynthMask(childGenome);
  // The child is itself an active endosymbiont in the same vacuole.
  // Not registered in world.creatures / world.species: organelle
  // lineages live inside hosts, not in the free population.
  host.contents.push(child);
  updateCreatureRadius(inner);
  updateCreatureRadius(child);
}

// An engulfed cell is FULLY ALIVE and its relationship to the host is
// the exact analog of a free cell's relationship to the outer
// environment -- the host cytoplasm IS its environment:
//   - passive exchange of permeable chems with the host pool
//     (mirrors diffuseAmbient against the dissolved field);
//   - active uptake of any chem (incl. non-diffusable) from the host
//     (mirrors INGEST of world particles);
//   - active + auto excretion of any chem into the host
//     (mirrors the EXCRETE op + autoExcrete to the world);
//   - it may engulf/predate sibling organelles in the same host
//     (mirrors engulf/predate of the free population);
//   - ATP does NOT free-diffuse to the host (energy is intracellular,
//     exactly as a free cell's ATP doesn't bleed into the water).
// The only things that cross the host membrane from the OUTSIDE world
// are penetrating physical fields -- light, magnetism, temperature,
// bulk force -- which reach the organelle via the host's position
// (handled by runActivation). Self-propelled movement has no analog
// (no fluid medium inside a host) and stays withheld.
function runInnerCell(
  inner: Creature,
  host: Creature,
  world: World,
  dt: number,
  dtT: number,
  light: number,
  eatenInner: Set<Creature>,
  predatedInner: Set<Creature>,
): void {
  // The organelle experiences the host's location so the penetrating
  // outside fields (light at depth, temperature, magnetic) reach it
  // through the host -- the explicit "permeable from outside" case.
  inner.x = host.x;
  inner.y = host.y;
  inner.z = host.z;

  // Sense -> decide. Same activation + sensor snapshot + VM run a free
  // cell gets. VM_SENSORS/VM_SELF are shared scratch; we populate and
  // consume them synchronously here before the host loop reuses them.
  runActivation(inner, world, dt, host);
  populateSensors(inner, world, true);
  VM_SELF.energy = inner.energy;
  {
    let selfMass = 0;
    const cols = inner.store.chemCols;
    const ii = inner.idx;
    for (let k = 0; k < NAMED_CHEMICAL_COUNT; k++) selfMass += cols[k][ii];
    VM_SELF.mass = selfMass;
  }
  VM_SELF.membrane = inner.molecules.membrane;
  runTick(inner.genome, inner.vm, VM_SENSORS, VM_SELF, world.vmInstrBudget, inner.vmOut);
  spendATP(inner, inner.vmOut.instructions * ENERGY_PER_INSTRUCTION, ATP_VM);
  if (inner.vmOut.spliceMode !== 0 && inner.vmOut.spliceLength > 0) {
    applyGenomeSplice(inner, inner.vmOut.spliceMode, inner.vmOut.spliceOffset, inner.vmOut.spliceLength);
  }

  // Somatic drift -- unguarded, identical policy to free cells: an
  // organelle lineage may metabolically reduce (or break) and lives
  // with the consequence.
  const age = world.t - inner.bornAt;
  let mutP = Math.min(0.02, SOMATIC_MUTATION_AGE_COEF * age * age * dt);
  if (inner.repairTicks > 0) { mutP = 0; inner.repairTicks--; }
  if (age > 0 && simRng() < mutP) inner.genome = somaticMutateOnce(inner.genome, simRng);
  inner.senseRange = computeSenseRange(inner.genome);
  inner.thrustAccel = computeThrustAccel(inner.genome);
  if (inner.store.chemCols[CHEM_REPAIR][inner.idx] >= REPAIR_ACTIVE_THRESH) {
    inner.repairTicks = Math.max(inner.repairTicks, REPAIR_WINDOW_TICKS);
  }

  // Chemistry from the LIVE synth mask the VM just produced (not the
  // frozen organelleSynthMask), plus catalyst synthesis -- exactly
  // the free-cell metabolic pipeline.
  runGenericReactions(inner, dtT, light);
  {
    const cl = inner.vmOut.catSynthList, cn = inner.vmOut.catSynthCount;
    for (let i = 0; i < cn; i++) biosynthCatalyst(inner, dtT, CAT_SYNTH_VMAX, CAT_ATP_COST, cl[i]);
    const il = inner.vmOut.inhSynthList, iN = inner.vmOut.inhSynthCount;
    for (let i = 0; i < iN; i++) biosynthInhibitor(inner, dtT, INH_SYNTH_VMAX, INH_ATP_COST, il[i]);
  }
  maintenanceDecay(inner, dt);
  toxify(inner, dt);

  const iCols = inner.store.chemCols;
  const hCols = host.store.chemCols;
  const ii = inner.idx, hi = host.idx;

  // Auto-excrete CO2 / waste over threshold into the HOST pool (the
  // organelle's "environment"), ATP-costed -- the analog of a free
  // cell venting to the dissolved field.
  for (const ex of [
    [CHEM_CO2, CO2_EXCRETE_THRESHOLD] as const,
    [CHEM_WASTE, WASTE_EXCRETE_THRESHOLD] as const,
  ]) {
    const have = iCols[ex[0]][ii];
    if (have > ex[1]) {
      const want = have - EXCRETE_FLOOR;
      const affordable = Math.min(want, inner.energy / EXCRETE_ATP_PER_MASS);
      if (affordable > 0) {
        spendATP(inner, affordable * EXCRETE_ATP_PER_MASS, ATP_EXCRETE);
        iCols[ex[0]][ii] -= affordable;
        hCols[ex[0]][hi] += affordable;
      }
    }
  }

  // VM-driven EXCRETE: push any requested chem (incl. non-diffusable)
  // from the organelle into the host pool -- the analog of the
  // free-cell EXCRETE op (which spawns a world particle).
  {
    const exc = inner.vmOut.excrete;
    for (let chemId = 0; chemId < CHEMICAL_COUNT; chemId++) {
      const requested = exc[chemId];
      if (requested <= 0) continue;
      const amount = Math.min(requested, iCols[chemId][ii]);
      if (amount < EXCRETE_MIN_AMOUNT) continue;
      iCols[chemId][ii] -= amount;
      hCols[chemId][hi] += amount;
    }
  }

  if (inner.ingestCooldown > 0) {
    inner.ingestCooldown = Math.max(0, inner.ingestCooldown - dt);
  }

  // Active uptake / engulf / predation against the host's interior.
  // Mirrors the free-cell INGEST/ENGULF/PREDATE block: gated by the
  // same cooldown + ATP affordability.
  if (inner.ingestCooldown <= 0 && inner.energy >= INGEST_ENERGY_COST) {
    let acted = false;
    // Sibling engulf/predate: same physical gate (canBreach) and
    // energy economics as the free population, but the "neighbours"
    // are the other organelles sharing this vacuole. Co-located, so
    // no distance test. host.contents isn't mutated here -- consumed
    // siblings are recorded in the shared sets and the host loop's
    // rebuild pass relocates/frees them.
    if (inner.vmOut.engulf || inner.vmOut.predate) {
      const sibs = host.contents;
      for (let si = 0; si < sibs.length && !acted; si++) {
        const other = sibs[si];
        if (other === inner || eatenInner.has(other)) continue;
        // Don't eat your own nested organelle or an ancestor.
        if (inner.contents.includes(other) || other.contents.includes(inner)) continue;
        updateCreatureRadius(other);
        if (!canBreach(inner, other)) continue;
        const otherMass = creatureTotalMass(other);
        const cost = predationCost(other, otherMass);
        if (inner.energy < cost) continue;
        if (inner.vmOut.engulf) {
          other.organelleSynthMask = genomeSynthMask(other.genome);
          inner.contents.push(other);
          spendATP(inner, cost, ATP_ENGULF);
        } else {
          const oCols = other.store.chemCols;
          const oi = other.idx;
          for (let k = 0; k < NAMED_CHEMICAL_COUNT; k++) { iCols[k][ii] += oCols[k][oi]; oCols[k][oi] = 0; }
          const iGC = inner.store.genericChemCols;
          const oGC = other.store.genericChemCols;
          for (let k = 0; k < GENERIC_CHEMICAL_COUNT; k++) { iGC[k][ii] += oGC[k][oi]; oGC[k][oi] = 0; }
          const iCat = inner.store.catalystCols;
          const oCat = other.store.catalystCols;
          for (let k = 0; k < CATALYST_COUNT; k++) {
            const v = oCat[k][oi];
            if (v !== 0) { iCat[k][ii] += v; oCat[k][oi] = 0; }
          }
          inner.energy += other.energy;
          for (const sub of other.contents) inner.contents.push(sub);
          other.contents.length = 0;
          spendATP(inner, cost, ATP_PREDATE);
          predatedInner.add(other);
        }
        eatenInner.add(other);
        inner.ingestCooldown = PREDATION_COOLDOWN_SEC;
        acted = true;
      }
    }
    // Active chemical uptake from the host pool: the symbiont grabs
    // the bootstrap metabolites whose bond potential clears its
    // INGEST bond-energy threshold this tick. Works on non-diffusable
    // chems too -- this is active transport, not passive diffusion.
    if (!acted) {
      let took = false;
      for (let slot = 0; slot < SENSOR_CHEMS.length; slot++) {
        const chem = SENSOR_CHEMS[slot];
        if (CHEM_BOND_POTENTIAL[chem] < inner.vmOut.ingestThreshold) continue;
        const grab = Math.min(INNER_UPTAKE_MAX, hCols[chem][hi]);
        if (grab <= 0) continue;
        hCols[chem][hi] -= grab;
        iCols[chem][ii] += grab;
        took = true;
      }
      if (took) {
        spendATP(inner, INGEST_ENERGY_COST, ATP_INGEST);
        inner.ingestCooldown = INGEST_COOLDOWN_SEC;
      }
    }
  }

  // Internal fission. No soft cap (per design): the shared store's
  // physical capacity and the same economics a free cell faces are
  // the only regulators.
  if (inner.vmOut.reproduce) divideInner(inner, host, world);

  // Passive permeable exchange with the host pool -- the analog of
  // diffuseAmbient against the dissolved field. ONLY diffusable chems
  // (driven by the Chemical table's permeability) cross this way;
  // non-diffusable transfer is the active path above. ATP is NOT in
  // this set: energy is intracellular and does not free-diffuse to
  // the host, exactly as a free cell's ATP doesn't bleed to the water.
  const rate = ORGANELLE_DIFFUSE_PER_SEC * dt;
  for (let j = 0; j < DIFFUSABLE_CHEM_IDS.length; j++) {
    const k = DIFFUSABLE_CHEM_IDS[j];
    const ic = iCols[k];
    const hc = hCols[k];
    const d = (ic[ii] - hc[hi]) * rate;
    ic[ii] -= d;
    hc[hi] += d;
  }

  // Standing transporters across the shared VACUOLAR membrane
  // (host<->organelle) -- the same substrate as the outer membrane,
  // just a different "other side". Both the organelle's OWN transporter
  // catalyst AND the host's transporter catalyst for chem k act on this
  // membrane, summed: the organelle controls its exchange with the host
  // cytoplasm, and the host can farm/starve by expressing transporter-k
  // (which acts equally across EVERY organelle it carries -- no
  // addressed delivery; control stays footprint-driven). Mass-exact
  // (1:1 inner<->host) and deterministic. Facilitated v1 (atpDelta
  // hook reserved for active pumping), matching the outer membrane.
  const iCat = inner.store.catalystCols;
  const hCat = host.store.catalystCols;
  const surf = inner.store.r[ii] / MIN_CREATURE_R;
  // Path 1: CHEM_ATP is a real chemCols id (== the aliased energy /
  // m_atp column), so the ATP translocase is just the generic
  // chem-transport path below -- no special energy branch. It is
  // mass-exact (1:1; both endpoints inside the host's mass ledger,
  // host total includes inner via creatureSelfMass) and the ANT
  // analog: it only runs here (vacuolar), the outer applier skips
  // CHEM_ATP, and ATP permeability 0 blocks any passive crossing.
  for (let n = 0; n < TRANSPORT_TARGETS.length; n++) {
    const k = TRANSPORT_TARGETS[n];
    const slot = TRANSPORT_SLOT_BASE + n;
    const pool = iCat[slot][ii] + hCat[slot][hi];
    if (pool <= 0) continue;
    const ic = iCols[k];
    const hc = hCols[k];
    const inside = ic[ii];
    const outside = hc[hi];
    const gap = outside - inside; // >0 import into organelle, <0 export
    if (gap === 0) continue;
    const src = gap > 0 ? outside : inside;
    const sat = src / (src + KM_DEFAULT);
    let flow = REACTIONS[slot].vmax * (pool / CAT_REF) * surf * sat * gap * dt;
    if (flow > 0) { if (flow > outside) flow = outside; }
    else { if (-flow > inside) flow = -inside; }
    if (flow === 0) continue;
    ic[ii] += flow;
    hc[hi] -= flow;
  }
}

// An engulfed cell that decays to a husk (lost structural membrane, or
// starved with no fuel) dies *inside* the host. Every pool it holds is
// yielded to the host verbatim -- ATP, catalysts, named chems
// (including the membrane raw material), and generic chems all
// transfer 1:1 with no denaturing or conversion. The dead inner's own
// engulfed cells are handled by the caller (promoted to the host).
function innerIsDead(inner: Creature): boolean {
  return inner.molecules.membrane < MIN_VIABLE_MEMBRANE
    || (inner.energy <= 0 && noFuel(inner));
}
function digestInnerIntoHost(inner: Creature, host: Creature): void {
  const store = host.store; // inner shares world.creatureStore
  const hi = host.idx;
  const ii = inner.idx;
  host.energy += inner.energy;
  inner.energy = 0;
  const cc = store.catalystCols;
  for (let k = 0; k < CATALYST_COUNT; k++) {
    const v = cc[k][ii];
    if (v !== 0) { cc[k][hi] += v; cc[k][ii] = 0; }
  }
  const cols = store.chemCols;
  for (let k = 0; k < NAMED_CHEMICAL_COUNT; k++) {
    const v = cols[k][ii];
    if (v !== 0) { cols[k][hi] += v; cols[k][ii] = 0; }
  }
  const g = store.genericChemCols;
  for (let k = 0; k < GENERIC_CHEMICAL_COUNT; k++) {
    const v = g[k][ii];
    if (v !== 0) { g[k][hi] += v; g[k][ii] = 0; }
  }
  // Intracellular eDNA: the lysing symbiont's genome fragment enters
  // the host's cytoplasm. Append-only (via the shared primitive),
  // then trim oldest bytes past the bound. No uptake yet (sub-commit
  // 3 wires host competence to this buffer) -- inert here, so no
  // trajectory/golden change.
  if (inner.genome.length > 0) {
    const off = shedOffset(inner.id, host.id, inner.genome.length);
    let buf = appendGenomeBytes(
      host.eDnaBuffer ?? EMPTY_BYTES, inner.genome, off, GENE_FRAGMENT_CAP,
    );
    if (buf.length > EDNA_HOST_BUFFER_MAX) {
      buf = buf.slice(buf.length - EDNA_HOST_BUFFER_MAX);
    }
    host.eDnaBuffer = buf;
  }
}

// Oxidative damage from accumulated waste / CO2. Above the excretion
// thresholds, membrane is converted directly to waste at a rate
// scaling with the excess. Net effect: a cell that can pay the
// excretion ATP cost stays clean; one that can't suffers
// proportional damage to its structural reserve.
// Heritable toxin self-resistance, memoized by genome object. A genome
// that EXPRESSES `EXCRETE co2`/`EXCRETE waste` (in-gene) makes the cell
// permanently immune to that toxin's toxify -- not just on the ticks the
// op happens to run (per-tick exemption was too intermittent under the
// instruction budget). Bit 1 = CO2-resistant, bit 2 = waste-resistant.
// So an allelopath tolerates its own (and kin's) chemical warfare while
// susceptible victims that don't produce the toxin still take damage.
const TOXIN_RESIST_CO2 = 1, TOXIN_RESIST_WASTE = 2;
const _toxinResistCache = new WeakMap<Uint8Array, number>();
function genomeToxinResist(genome: Uint8Array): number {
  const cached = _toxinResistCache.get(genome);
  if (cached !== undefined) return cached;
  let mask = 0;
  walkGenome(genome, (op, _pc, operand) => {
    if (op !== OP.EXCRETE || operand === undefined) return;
    const chem = operand % CHEMICAL_COUNT;
    if (chem === CHEM_CO2) mask |= TOXIN_RESIST_CO2;
    else if (chem === CHEM_WASTE) mask |= TOXIN_RESIST_WASTE;
  }, true);
  _toxinResistCache.set(genome, mask);
  return mask;
}

function toxify(c: Creature, dt: number): void {
  const s = c.store; const i = c.idx;
  const co2 = s.m_co2[i], waste = s.m_waste[i], memb = s.m_membrane[i];
  const resist = genomeToxinResist(c.genome);
  let excess = 0;
  if (co2 > CO2_EXCRETE_THRESHOLD && !(resist & TOXIN_RESIST_CO2)) excess += co2 - CO2_EXCRETE_THRESHOLD;
  if (waste > WASTE_EXCRETE_THRESHOLD && !(resist & TOXIN_RESIST_WASTE)) excess += waste - WASTE_EXCRETE_THRESHOLD;
  if (excess <= 0 || memb <= 0) return;
  const want = excess * TOX_DAMAGE_PER_EXCESS_PER_SEC * dt;
  const damage = want < memb ? want : memb;
  s.m_membrane[i] = memb - damage;
  s.m_waste[i] = waste + damage;
  recordRxn(RX_TOXIFY, RX_LOC_CELL, 0);
}

// Thermal stress. Water hotter than a cell's tolerance ceiling denatures
// its membrane lipid (-> waste, mass-conserving), eroding it toward the
// MIN_VIABLE_MEMBRANE death floor. The ceiling is BASE plus a bonus that
// scales with the cell's CHEM_REPAIR pool -- the same stress-chaperone
// protein that suppresses somatic mutation (real heat-shock proteins are
// general stress chaperones). So heat tolerance is an evolvable,
// synthesized, graded trait, not a fixed engine number: the vent core
// selects for cells that invest in chaperones; nothing forces it. A
// door, not a script. With no chaperones a cell cooks above
// THERMAL_SAFE_BASE; a fully-invested one survives the eruption core.
const THERMAL_SAFE_BASE = 42;             // °C tolerated with zero chaperones
const THERMAL_TOLERANCE_PER_REPAIR = 30;  // °C ceiling added per unit CHEM_REPAIR
const THERMAL_TOLERANCE_MAX = 45;         // cap on the chaperone bonus (°C)
const THERMAL_DAMAGE_PER_DEG_PER_SEC = 0.08; // membrane lost / °C over ceiling / s
function thermalStress(c: Creature, dt: number, world: World): void {
  const s = c.store; const i = c.idx;
  const memb = s.m_membrane[i];
  if (memb <= 0) return;
  const T = regionTempAt(world, c.x, c.y);
  if (T <= THERMAL_SAFE_BASE) return; // fast path: most of the world is cool
  const tol = Math.min(
    THERMAL_TOLERANCE_MAX,
    s.chemCols[CHEM_REPAIR][i] * THERMAL_TOLERANCE_PER_REPAIR,
  );
  const over = T - (THERMAL_SAFE_BASE + tol);
  if (over <= 0) return;
  const want = over * THERMAL_DAMAGE_PER_DEG_PER_SEC * dt;
  const damage = want < memb ? want : memb;
  s.m_membrane[i] = memb - damage;
  s.m_waste[i] += damage;
  recordRxn(RX_THERMAL_DENATURE, RX_LOC_CELL, 0);
}

function spawnExcretedParticle(
  c: Creature,
  world: World,
  chemId: number,
  m: number,
  molecules?: Molecules,
  genericChem?: Float32Array,
): void {
  if (m < EXCRETE_MIN_AMOUNT) {
    // Round-off; just drop it on the floor of the cell (lose to environment).
    return;
  }
  // Particle-count valve: when the world is already at/over its
  // particle budget, dump excretion straight into the ambient pool
  // instead of spawning a new particle. Mass-conserving (cells
  // diffuse against ambient via diffuseAmbient), and it stops
  // autoExcrete + VM-driven EXCRETE from blowing past the target
  // when dissolution can't keep up. Payload (molecules /
  // genericChem from autoExcrete) is dropped on the floor in this
  // path -- payload only matters when the particle is later
  // ingested whole, and a particle that never spawned can't be
  // ingested anyway.
  if (world.particles.length >= world.particleTarget) {
    world.ambient[ambientBaseAt(world, c.x, c.y) + chemId] += m;
    return;
  }
  const density = CHEM_BASE_DENSITY[chemId];
  // m is chemical AMOUNT; the spawned particle carries PHYSICAL MASS.
  const pr = Math.max(1.5, radiusForMass(m * CHEM_MM[chemId], density));
  const angle = simRng() * Math.PI * 2;
  const ejectV = 25;
  // Clamp the spawn position so a wall-hugging cell can't drop a
  // particle right at (or outside) the wall, where the wall clamp
  // would pin it indefinitely. Margin = pr + 4 keeps the particle
  // a few px clear of either side and the surface line.
  const margin = pr + 4;
  const sx = Math.max(margin, Math.min(world.width - margin, c.x + Math.cos(angle) * (c.r + pr + 1)));
  const sy = Math.max(world.surfaceY + margin, Math.min(world.height - margin, c.y + Math.sin(angle) * (c.r + pr + 1)));
  pushParticle(world, {
    x: sx,
    y: sy,
    z: Math.min(world.depth - pr, Math.max(pr, c.z)),
    vx: Math.cos(angle) * ejectV,
    vy: Math.sin(angle) * ejectV,
    vz: (simRng() - 0.5) * 10,
    r: pr,
    chemId,
    molecules,
    genericChem,
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
// it. Genome length has no upper bound; the lower bound is 1 (SPLICE_DEL
// can't empty it). PC is taken mod the new length so the next tick
// resumes somewhere valid.
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
    next = new Uint8Array(L + dupLen);
    next.set(g.subarray(0, b), 0);
    next.set(g.subarray(a, b), b);
    next.set(g.subarray(b, L), b + dupLen);
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
  const k = Math.floor(simRng() * (len + 1));
  for (let i = 0; i < k; i++) out[i] = a[i];
  for (let i = k; i < len; i++) out[i] = i < b.length ? b[i] : a[i];
  return out;
}


// Particle mass = density * (4/3) * pi * r^3. Particles are spheres; the
// circle we render is the equatorial cross-section. Same convention as cells.
function mass(p: Particle): number {
  const d = p.density ?? CHEM_BASE_DENSITY[p.chemId];
  return d * (4 / 3) * Math.PI * p.r * p.r * p.r;
}

// Inverse: given a target mass and material density, what sphere radius
// does it correspond to?
function radiusForMass(m: number, density: number): number {
  return Math.cbrt((3 * m) / (4 * Math.PI * density));
}


export function step(world: World, dt: number): void {
  world.t += dt;
  // Reaction/ATP accounting: bind the world for the deep record hooks
  // (chemistry is single-threaded here) and roll the 60s window.
  RXN_STATS_WORLD = world;
  rollReactionWindow(world);
  // Snapshot living CODING genomes at the *start* of this step so we
  // can count genome extinctions at the end (any coding-key alive going
  // in but not coming out has gone extinct this step). Coding key
  // ignores introns, so neutral drift doesn't churn the count.
  world.liveCodingKeys.clear();
  for (const c of world.creatures) world.liveCodingKeys.add(genomeCodingKey(c.genome));
  advanceDayCycle(world, dt);
  advanceWind(world, dt);
  const p = world.profile;
  if (p) {
    let m = performance.now();
    applyBondSprings(world, dt);
    let n = performance.now(); p.bonds += n - m; m = n;
    applyForces(world, dt);
    n = performance.now(); p.forces += n - m; m = n;
    updateCreatures(world, dt);
    eDnaUptakePass(world);
    n = performance.now(); p.creatures += n - m; m = n;
    // Mirror the non-profile hot path: creature-vs-creature collisions
    // overlap with the parallel particle-collision phase as a hook.
    // Sediment collisions are hoisted out of the hook -- they mutate
    // particle SAB columns directly so they can't run concurrent with
    // the particle workers.
    let pccAcc = 0;
    resolveCollisions(
      world,
      () => { const t = performance.now(); resolveCreatureCollisions(world); pccAcc += performance.now() - t; },
      undefined,
    );
    n = performance.now(); p.particleColl += n - m; m = n;
    p.creatureColl += pccAcc;
    resolveCreatureSedimentCollisions(world);
    n = performance.now(); p.sedimentColl += n - m; m = n;
    resolveObstacleCollisions(world);
    n = performance.now(); p.obstacleColl += n - m; m = n;
    applyWalls(world);
    n = performance.now(); p.walls += n - m; m = n;
    sampleRegionTemps(world, dt);
    seedRamp(world, dt);
    runVent(world, dt);
    aerate(world, dt);
    aerateAmbient(world, dt);
    diffuseRegions(world, dt);
    diffuseReserve(world, dt);
    dissolveParticles(world, dt);
    denatureWaste(world, dt);
    weatherMinerals(world, dt);
    precipitateRegions(world);
    reservePass(world);
    n = performance.now(); p.aerate += n - m; m = n;
    replenishParticles(world, dt);
    n = performance.now(); p.replenish += n - m; m = n;
    decayParticles(world, dt);
    advanceFadingGhosts(world, dt);
    advanceEDnaCarriers(world, dt);
    // Decay is currently disabled by const, so the bucket isn't
    // separately tracked. The original code added decay's time to
    // `replenish` again (copy-paste -- same field as the line above),
    // double-counting. Skip past it instead so replenish stays
    // accurate and prune measures only pruneSpecies.
    m = performance.now();
    pruneSpecies(world);
    n = performance.now(); p.prune += n - m;
    m = performance.now();
    // Single end-of-tick evacuation pass: catches wall-clamp-into-rock,
    // vent/aerate spawns that landed inside thin rock features, and any
    // collision-pushback that left a center inside a polygon. With the
    // evacuator now polygon-gated, this is rare.
    evacuateRocks(world);
    n = performance.now(); p.evacuate += n - m;
    p.ticks++;
  } else {
    applyBondSprings(world, dt);
    applyForces(world, dt);
    updateCreatures(world, dt);
    eDnaUptakePass(world);
    resolveCollisions(
      world,
      () => resolveCreatureCollisions(world),
      undefined,
    );
    resolveCreatureSedimentCollisions(world);
    resolveObstacleCollisions(world);
    applyWalls(world);
    sampleRegionTemps(world, dt);
    seedRamp(world, dt);
    runVent(world, dt);
    aerate(world, dt);
    aerateAmbient(world, dt);
    diffuseRegions(world, dt);
    diffuseReserve(world, dt);
    dissolveParticles(world, dt);
    denatureWaste(world, dt);
    weatherMinerals(world, dt);
    precipitateRegions(world);
    reservePass(world);
    replenishParticles(world, dt);
    decayParticles(world, dt);
    advanceFadingGhosts(world, dt);
    advanceEDnaCarriers(world, dt);
    pruneSpecies(world);
    // Single end-of-tick evacuation pass. Catches the rare case where
    // wall-clamp, vent/aerate spawn, or collision pushback left a
    // particle center inside a rock polygon. End-of-tick guarantee:
    // when the snapshot is taken, nothing is inside rock.
    evacuateRocks(world);
  }
  // Count genome extinctions. Any coding genome alive at the *start* of
  // this step but not now has gone extinct this tick. Done before
  // top-up so freshly spawned founders don't show up in the post-set.
  const currentCoding = new Set<string>();
  for (const c of world.creatures) currentCoding.add(genomeCodingKey(c.genome));
  for (const key of world.liveCodingKeys) {
    if (!currentCoding.has(key)) world.extinctionCount++;
  }

  // Top up immigration. Each trickle interval, if the number of DISTINCT
  // CODING genomes alive is below world.founderTarget, spawn a fraction
  // of the remaining deficit -- so founders inject when FUNCTIONAL
  // diversity collapses (e.g. after a selective sweep), not merely when
  // founder-ancestry count is low. No resource/particle cap gates this.
  const deficit = Math.max(0, world.founderTarget - currentCoding.size);
  // Suppress founder spawning until the world is ready. Ramp worlds
  // (production) hold founders back until the one-shot seed ramp has
  // finished filling the pool; legacy/test worlds use the time delay.
  const delayDone = world.useSeedRamp
    ? world.initialSeedDone
    : world.t >= FOUNDER_SPAWN_DELAY_SEC;
  const wasEmpty = world.creatures.length === 0;
  // Total extinction bypasses the interval so a fully dead world
  // restarts promptly; otherwise spawn at most once per interval.
  const trickleDue = wasEmpty
    || world.t - world.lastFounderTrickleT >= FOUNDER_TRICKLE_INTERVAL_SEC;
  if (
    delayDone && world.foundersEnabled !== false && world.founderTarget > 0
    && deficit > 0 && trickleDue
  ) {
    // 20% of the remaining cap each time (at least one). A freshly
    // empty world seeds a single founder that re-anchors the palette.
    const nSpawn = wasEmpty ? 1 : Math.max(1, Math.ceil(deficit * FOUNDER_TRICKLE_FRACTION));
    // Refresh the particle grid: this runs after updateCreatures (whose
    // grid reflects pre-physics positions and has had INGEST removals),
    // so rebuild it for an accurate founder scoop.
    buildParticleGrid(world);
    let first: Creature | null = null;
    for (let i = 0; i < nSpawn; i++) {
      const f = spawnFounder(world);
      if (f && first === null) first = f;
    }
    if (first) {
      world.lastFounderTrickleT = world.t;
      // When the world had just gone fully empty, the first new founder
      // re-anchors the color palette so descendant coloring restarts
      // relative to this new root.
      if (wasEmpty) {
        world.anchorGenome = new Uint8Array(first.genome);
        first.color = genomeColor(first.genome, world.anchorGenome);
      }
    }
  }
}

// Particle aging + decay. Disabled in favor of letting loose
// particles persist so founder-from-junk has something to scoop.
// Kept as code for re-enablement if particle counts ever creep too
// high; toggle PARTICLE_DECAY_ENABLED to bring it back.
const PARTICLE_DECAY_ENABLED = false;
const PARTICLE_DECAY_START_AGE = 300; // sim-seconds before decay begins
const PARTICLE_DECAY_HALF_LIFE = 60;  // sim-seconds; r halves every 60s once decaying
const PARTICLE_MIN_R = 0.4;
function decayParticles(world: World, dt: number): void {
  const ps = world.particleStore;
  const age = ps.age;
  // Age every particle every tick regardless of the decay toggle --
  // the reserve<->visible fade-in reads age, so it must keep advancing
  // even while decay itself is disabled.
  const n = world.particles.length;
  for (let i = 0; i < n; i++) age[i] += dt;
  if (!PARTICLE_DECAY_ENABLED) return;
  const r = ps.r;
  // Same exponential factor for every decaying particle this tick.
  const decayFactor = Math.pow(0.5, dt / PARTICLE_DECAY_HALF_LIFE);
  for (let i = world.particles.length - 1; i >= 0; i--) {
    if (age[i] <= PARTICLE_DECAY_START_AGE) continue;
    r[i] *= decayFactor;
    if (r[i] < PARTICLE_MIN_R) removeParticleAt(world, i);
  }
}

function replenishParticles(world: World, dt: number): void {
  // Ramp worlds (production) do a one-shot startup seed (the "initial
  // period", always). Continuous replenishment afterward is opt-in via
  // the UI "seeding" toggle: default off keeps the post-startup world
  // closed; on resumes the periodic resource dump toward the cap once
  // the startup seed has finished.
  if (world.useSeedRamp && (!world.ongoingSeeding || !world.initialSeedDone)) {
    return;
  }
  // particleSpawnRate <= 0 disables ALL spawning (used by tests that
  // want a frozen world).
  if (world.particleSpawnRate <= 0) return;
  // Normal per-chem replenish. The pebble sediment bed is gone --
  // the floor is now static rock terrain (see generateTerrain) --
  // so there's no separate large-grain target padding the cap.
  if (world.t < WATER_FILL_DELAY_SEC) return;
  if (world.particles.length >= world.particleTarget) return;
  const expected = world.particleSpawnRate * dt;
  let toSpawn = Math.floor(expected);
  if (simRng() < expected - toSpawn) toSpawn++;
  for (let i = 0; i < toSpawn && world.particles.length < world.particleTarget; i++) {
    const spec = pickSpawnSpec();
    const r = spawnRadius(spec.chemId);
    const pos = spawnPosForChem(world, r, spec.chemId);
    if (!pos) continue;
    pushParticle(world, {
      x: pos.x, y: pos.y, z: pos.z,
      vx: 0, vy: pos.vy ?? 0, vz: (simRng() - 0.5) * 20,
      r,
      chemId: spec.chemId,
      density: rollChemDensity(spec),
    });
  }
}

// Aeration: at the water surface, fresh gas particles tagged with O2
// drop in. They start with a downward velocity (so they don't escape
// instantly back through the same surface they entered through) and
// carry molecule-level O2 -- cells that ingest them get straight O2 in
// their molecule pool, just like other molecule-tagged particles.
function aerate(world: World, dt: number): void {
  if (world.t < WATER_FILL_DELAY_SEC) return;
  // Bubble entrainment is gated by the REAL particle cap, never the
  // settle-relaxed one: an unbounded surface bubble stream re-excites
  // wave-capture "surfing" (the rightward zip) and floods the top
  // band. O2 supply doesn't depend on this -- aerateAmbient() (a
  // dissolved-field exchange, cap-independent, 10x O2) does the work.
  const pCap = world.particleTarget;
  if (world.particles.length >= pCap) return;
  // Surface chop drives entrainment of air bubbles. Quiet surface =>
  // baseline aeration; storms and choppy periods => much more O2 mixed in.
  const act = surfaceActivity(world);
  const expected = world.aerationRate * dt * (0.5 + act);
  let n = Math.floor(expected);
  if (simRng() < expected - n) n++;
  // Compute current atmospheric composition (mole fractions). Bubbles
  // pick up the same fractions, scaled to AERATION_MASS_PER_BUBBLE
  // total. If the atmosphere is depleted (zero total), aeration
  // stalls -- we don't conjure new mass.
  const atm = world.atmosphere;
  let totalAtm = 0;
  for (const k of MOLECULE_IDS) totalAtm += atm[k];
  if (totalAtm <= 0) return;
  for (let i = 0; i < n && world.particles.length < pCap; i++) {
    const r = 1 + simRng() * 0.8;
    // Pull at most what's available; bubble may be smaller than the
    // nominal mass when the atmosphere is thin.
    const want = Math.min(AERATION_MASS_PER_BUBBLE, totalAtm);
    const mol = emptyMolecules();
    let actualPulled = 0;
    for (const k of MOLECULE_IDS) {
      const share = atm[k] / totalAtm;
      const take = want * share;
      mol[k] = take;
      atm[k] -= take;
      actualPulled += take;
    }
    totalAtm -= actualPulled;
    // Inset the spawn x by AERATION_WALL_INSET on each side. Without
    // the inset, bubbles spawn right against the wall and immediately
    // contribute to the gas pile-up problem -- a new bubble dropping
    // onto an existing wall column gets wedged in place by collisions
    // with bubbles below. Spawning away from walls gives every bubble
    // a clean shot at rising back up to the surface.
    const insetMin = Math.min(AERATION_WALL_INSET, world.width * 0.25);
    const insetMax = Math.max(world.width - insetMin, insetMin + r * 2);
    const spawnX = insetMin + simRng() * Math.max(0, insetMax - insetMin);
    pushParticle(world, {
      x: spawnX,
      // Just below the *wavy* surface at this x so the wall-escape pass
      // doesn't immediately strip the new bubble. Using the flat
      // world.surfaceY here made every fresh bubble appear on one
      // horizontal line, ignoring the wave it should be sitting under.
      y: surfaceYAt(world, spawnX) + r + 1,
      z: r + simRng() * (world.depth - 2 * r),
      vx: (simRng() - 0.5) * 4,
      vy: AERATION_BUBBLE_DROP_SPEED,
      vz: (simRng() - 0.5) * 4,
      r,
      // Bubbles carry their atmospheric mix as a molecule payload;
      // chemId is the dominant gas (O2) for buoyancy/visual classification.
      chemId: CHEM_O2,
      molecules: mol,
    });
    if (totalAtm <= 0) break;
  }
}

// Adhesion springs: pull bonded creatures toward their contact distance.
// Bonds snap when stretched beyond BOND_BREAK_RATIO * restLen, or when
// either side lets its CHEM_BOND pool lapse below BOND_FORMATION_THRESH.
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
      // Sever on overstretch, or when either side stops maintaining its
      // CHEM_BOND pool (stops expressing SYNTH BOND): adhesion is an
      // active, continuously-paid trait, not a permanent weld.
      if (distSq > breakLen * breakLen
          || a.store.chemCols[CHEM_BOND][a.idx] < BOND_FORMATION_THRESH
          || b.store.chemCols[CHEM_BOND][b.idx] < BOND_FORMATION_THRESH) {
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

// Scalar inputs the particle force loop needs from the world. Kept
// as a flat shape so a particle subworker can deserialize it cheaply
// from the dispatch SAB instead of cloning the whole World.
export interface ParticleForceParams {
  dt: number;
  t: number;
  drag: number;
  gravity: number;
  // World floor y -- used to gate the asleep-freeze to particles
  // resting at the bottom wall only. Without this gate the freeze
  // also catches lipids/gas/organic at the wavy surface and glues
  // them to a fixed y instead of letting buoyancy bob them with
  // the waves.
  worldFloorY: number;
  // World width. Used by the gas wall-repulsion term so buoyant
  // particles get nudged away from the side walls (where they'd
  // otherwise stack into vertical columns under particle-particle
  // collisions, with new aeration bubbles piling onto the top of
  // each column and pushing the bottom of the stack down).
  worldWidth: number;
  surfaceY: number;
  surfaceDecay: number;
  swellDecay: number;
  updraftAmp: number;
  currentAmp: number;
  kS: number; wS: number;
  kL: number; wL: number;
  kU: number; wU: number;
  surfAmp: number;
  swellAmp: number;
  zAmp: number;
  bAmp: number;
  updraftEnv: number;
  colDepth: number;
  currentDrift: number;
}

// Pure per-range version of the particle force loop. The sim worker
// runs it over the full range when no parallel particle workers are
// available; the particle subworkers each run it over their assigned
// chunk. Operates directly on the SoA columns (which are SAB-backed
// views) so there's no copy across the worker boundary.
export function applyParticleForcesRange(
  PX: Float32Array, PY: Float32Array, PZ: Float32Array,
  PVX: Float32Array, PVY: Float32Array, PVZ: Float32Array,
  PR: Float32Array, PDENS: Float32Array, PMAT: Uint8Array,
  ASLEEP: Uint8Array,
  matBase: Float32Array,
  from: number, to: number,
  p: ParticleForceParams,
): void {
  const dt = p.dt;
  const t = p.t;
  const drag = p.drag;
  const grav = p.gravity;
  const surfaceY = p.surfaceY;
  const surfDecay = p.surfaceDecay;
  const swellDecay = p.swellDecay;
  const updraftAmp = p.updraftAmp;
  const currentAmp = p.currentAmp;
  const kS = p.kS, wS = p.wS;
  const kL = p.kL, wL = p.wL;
  const kU = p.kU, wU = p.wU;
  const surfAmp = p.surfAmp;
  const swellAmp = p.swellAmp;
  const zAmp = p.zAmp;
  const bAmp = p.bAmp;
  const updraftEnv = p.updraftEnv;
  const colDepth = p.colDepth;
  const currentDrift = p.currentDrift;
  for (let i = from; i < to; i++) {
    const xi = PX[i], yi = PY[i], ri = PR[i];
    // No freeze branch. The old freeze-at-floor gate (zero velocity for
    // ASLEEP particles at y >= floorY) was carried over from the old
    // pebble-bed sediment. With rock terrain a "settled" particle isn't
    // necessarily at the world floor -- it can be on top of any rock
    // surface, in a rock pocket, etc. Zeroing velocity in those cases
    // froze sediment dead even where gravity + buoyancy + brownian
    // should keep it gently shifting. Let the force loop run for every
    // particle; the cost is bounded and the gate's only saving was
    // for ~bottom-row pebble piles that no longer exist.
    let vxi = PVX[i], vyi = PVY[i], vzi = PVZ[i];
    void ASLEEP;
    const overrideD = PDENS[i];
    const density = overrideD !== 0 ? overrideD : matBase[PMAT[i]];
    let ay = grav * (1 - 1 / density);
    if (ay < -grav) ay = -grav; else if (ay > grav) ay = grav;
    const depth = yi > surfaceY ? yi - surfaceY : 0;
    // Counter-propagating wave pair. The left-going component keeps a
    // different wavenumber (1.3x / 1.4x) so the surface still looks
    // irregular, but its time coefficient is matched to that
    // wavenumber so |phase speed| equals the right-going component's.
    // Mismatched phase speeds let particles get wave-captured
    // ("surf") preferentially by the faster wave and migrate that way
    // until they pile against a wall -- that was the rightward
    // zipping. Equal |c| balances capture both directions: no net
    // horizontal transport.
    const surfPR = kS * xi - wS * t;
    const surfPL = 1.3 * kS * xi + 1.3 * wS * t + 1.1;
    const swellPR = kL * xi - wL * t;
    const swellPL = 1.4 * kL * xi + 1.4 * wL * t + 0.4;
    const surface = surfAmp * 0.5 * (Math.sin(surfPR) + Math.sin(surfPL)) * Math.exp(-depth / surfDecay);
    const swell   = swellAmp * 0.5 * (Math.sin(swellPR) + Math.sin(swellPL)) * Math.exp(-depth / swellDecay);
    const az      = zAmp * Math.sin(wL * t + kL * xi + 1.0) * Math.exp(-depth / swellDecay);
    const splash = depth < SPLASH_DEPTH
      ? surfAmp * SPLASH_GAIN * 0.5 * (Math.cos(surfPR) + Math.cos(surfPL)) * Math.exp(-depth / SPLASH_DEPTH)
      : 0;
    const updraft = -updraftAmp * updraftEnv * Math.sin(kU * xi + wU * t);
    const depthFrac = depth / colDepth;
    const current = currentAmp * Math.cos(Math.PI * depthFrac) * currentDrift;
    // Brownian noise decays with depth like the wave forces, but more
    // gently than waves so deep-water sediment still drifts visibly
    // (rock pockets and deep basins now hold particles where the old
    // pebble-bed world dumped everything to the floor). At depth=400
    // noiseEnv ~= 0.37, down to ~0.14 at depth=800.
    const noiseEnv = Math.exp(-depth / 400);
    const noiseX = bAmp * noiseEnv * (simRng() - 0.5) * 2;
    const noiseY = bAmp * noiseEnv * (simRng() - 0.5) * 2;
    const ax = surface + swell + current + noiseX;
    const ayTot = ay + splash + updraft + noiseY;
    const dragScale = ri / DRAG_REF_R;
    const dscaleDrag = drag * dragScale;
    vxi += (ax - dscaleDrag * vxi) * dt;
    vyi += (ayTot - dscaleDrag * vyi) * dt;
    vzi += (az - dscaleDrag * vzi) * dt;
    // Cap horizontal speed to ~1.3x the faster wave's phase speed.
    // The wave force is an acceleration (~55 px/s^2 at the surface)
    // and small particles barely damp (c ~= 0.22/s), so without this
    // they accelerate to hundreds of px/s -- far faster than the
    // waves themselves -- and rocket sideways into a wall. Water in
    // a real wave orbits at well under the phase speed; this clamp
    // enforces that ceiling. Vertical settling + brownian are on
    // their own axes and unaffected.
    const cS = wS / kS, cL = wL / kL;
    const vxCap = 1.3 * (cS > cL ? cS : cL);
    if (vxi > vxCap) vxi = vxCap; else if (vxi < -vxCap) vxi = -vxCap;
    PVX[i] = vxi; PVY[i] = vyi; PVZ[i] = vzi;
    PX[i] = xi + vxi * dt;
    PY[i] = yi + vyi * dt;
    PZ[i] = PZ[i] + vzi * dt;
  }
}

export function buildParticleForceParams(world: World): ParticleForceParams {
  const act = surfaceActivity(world);
  return {
    dt: 0, // filled by caller
    t: world.t,
    drag: world.drag,
    gravity: world.gravity,
    worldFloorY: world.height,
    worldWidth: world.width,
    surfaceY: world.surfaceY,
    surfaceDecay: world.surfaceDecay,
    swellDecay: world.swellDecay,
    updraftAmp: world.updraftAmp,
    currentAmp: world.currentAmp,
    kS: (2 * Math.PI) / world.surfaceLength,
    wS: (2 * Math.PI) / world.surfacePeriod,
    kL: (2 * Math.PI) / world.swellLength,
    wL: (2 * Math.PI) / world.swellPeriod,
    kU: (2 * Math.PI) / world.updraftLength,
    wU: (2 * Math.PI) / world.updraftPeriod,
    surfAmp: world.surfaceAmp * act,
    swellAmp: world.swellAmp * act,
    zAmp: world.zStirAmp * act,
    bAmp: world.brownianAmp * act,
    updraftEnv: Math.min(1, act),
    colDepth: Math.max(1, world.height - world.surfaceY),
    currentDrift: Math.sin(world.t * CURRENT_FREQ),
  };
}

// Hook a parallel particle-force dispatcher (e.g. a subworker pool)
// into the sim. When set, applyForces delegates the per-particle loop
// to it instead of running serially; the subworker pool writes back
// into the SAB-backed ParticleStore and signals completion via
// Atomics. Stays null for tests and any context without
// crossOriginIsolated SAB support; sim falls back to single-threaded.
//
// Atomics.wait round-trip on a barrier varies widely across machines
// (~0.1ms to >10ms). Below this threshold the per-particle savings
// from splitting work across the pool don't pay back the dispatch
// overhead, so we stay serial even when the pool is wired up. Picked
// well above the typical mid-game particle count -- the pool is only
// a clear win at multi-thousand-particle loads on hardware with
// non-trivial wake latency.
// Default particle count at/above which collision + force passes
// dispatch to the worker pool. Now a runtime knob (world.parallelMin)
// so it can be tuned live from the UI: below the threshold the passes
// run serially on the sim worker (no dispatch overhead), above it they
// parallelize. Lower it to parallelize smaller worlds; raise it if
// dispatch overhead outweighs the win.
const PARALLEL_PARTICLE_MIN_DEFAULT = 4000;
export const PARALLEL_MIN_RANGE = { min: 500, max: 50000, step: 500 } as const;
export function setParallelMin(world: World, n: number): void {
  world.parallelMin = Math.max(
    PARALLEL_MIN_RANGE.min,
    Math.min(PARALLEL_MIN_RANGE.max, Math.round(n)),
  );
}
// Dispatcher is fire-only: it kicks the workers and returns a wait
// function. Callers run concurrent CPU work (creature loop, creature
// collisions) and invoke the wait fn when they need particle results
// settled. Hides barrier latency behind useful work.
export type ParticleForceDispatcher = (np: number, params: ParticleForceParams) => () => void;
let particleForceDispatcher: ParticleForceDispatcher | null = null;
export function setParticleForceDispatcher(d: ParticleForceDispatcher | null): void {
  particleForceDispatcher = d;
}

function applyForces(world: World, dt: number): void {
  // Particle fast path: indexed access on the parallel typed arrays
  // avoids the per-particle handle getter/setter chain. With ~4-9k
  // particles per tick this is the hottest loop in the sim.
  const ps = world.particleStore;
  const np = world.particles.length;
  const params = buildParticleForceParams(world);
  params.dt = dt;
  // Async dispatch: workers start the particle force pass on a slice
  // of the SAB-backed store while we run the creature force loop
  // below on the sim worker. Wait for the barrier just before returning
  // so any code after applyForces observes settled particle state.
  let forceWait: (() => void) | null = null;
  if (particleForceDispatcher && np >= world.parallelMin) {
    forceWait = particleForceDispatcher(np, params);
  } else {
    applyParticleForcesRange(
      ps.x, ps.y, ps.z, ps.vx, ps.vy, ps.vz,
      ps.r, ps.density, ps.chemId,
      COLLISION_ASLEEP,
      CHEM_BASE_DENSITY,
      0, np,
      params,
    );
  }
  // The dispatcher is actually async: it kicks the worker pool and
  // returns a wait fn. The creature loop below runs concurrent with
  // the particle workers; the wait fn is invoked at the end of this
  // function so any caller reading particles after applyForces sees
  // a settled state. Creature columns are independent of particle
  // SAB columns so the concurrent work is safe.
  const t = params.t;
  const drag = params.drag;
  const grav = params.gravity;
  const surfaceY = params.surfaceY;
  const surfDecay = params.surfaceDecay;
  const swellDecay = params.swellDecay;
  const updraftAmp = params.updraftAmp;
  const currentAmp = params.currentAmp;
  const kS = params.kS, wS = params.wS;
  const kL = params.kL, wL = params.wL;
  const kU = params.kU, wU = params.wU;
  const surfAmp = params.surfAmp;
  const swellAmp = params.swellAmp;
  const zAmp = params.zAmp;
  const bAmp = params.bAmp;
  const updraftEnv = params.updraftEnv;
  const colDepth = params.colDepth;
  const currentDrift = params.currentDrift;
  // Creature fast path: same math as the particle loop, but creatures
  // may belong to different stores (tests allocate private stores), so
  // hoist the store columns per-creature.
  const cn = world.creatures.length;
  for (let k = 0; k < cn; k++) {
    const c = world.creatures[k];
    const i = c.idx;
    const cs = c.store;
    const CX = cs.x, CY = cs.y, CZ = cs.z;
    const CVX = cs.vx, CVY = cs.vy, CVZ = cs.vz;
    const CR = cs.r, CDENS = cs.density;
    const xi = CX[i], yi = CY[i], ri = CR[i];
    let vxi = CVX[i], vyi = CVY[i], vzi = CVZ[i];
    const density = CDENS[i];
    let ay = grav * (1 - 1 / density);
    if (ay < -grav) ay = -grav; else if (ay > grav) ay = grav;
    const depth = yi > surfaceY ? yi - surfaceY : 0;
    // Balanced rightward + leftward travelling waves -- see particle
    // loop above for rationale (no Stokes drift, no fixed nodes).
    // Phase speeds of the counter-propagating pair kept equal in
    // magnitude so wave-capture is balanced left/right (see the
    // matching comment in applyParticleForcesRange).
    const surfPR = kS * xi - wS * t;
    const surfPL = 1.3 * kS * xi + 1.3 * wS * t + 1.1;
    const swellPR = kL * xi - wL * t;
    const swellPL = 1.4 * kL * xi + 1.4 * wL * t + 0.4;
    const surface = surfAmp * 0.5 * (Math.sin(surfPR) + Math.sin(surfPL)) * Math.exp(-depth / surfDecay);
    const swell   = swellAmp * 0.5 * (Math.sin(swellPR) + Math.sin(swellPL)) * Math.exp(-depth / swellDecay);
    const az      = zAmp * Math.sin(wL * t + kL * xi + 1.0) * Math.exp(-depth / swellDecay);
    const splash = depth < SPLASH_DEPTH
      ? surfAmp * SPLASH_GAIN * 0.5 * (Math.cos(surfPR) + Math.cos(surfPL)) * Math.exp(-depth / SPLASH_DEPTH)
      : 0;
    const updraft = -updraftAmp * updraftEnv * Math.sin(kU * xi + wU * t);
    const depthFrac = depth / colDepth;
    const current = currentAmp * Math.cos(Math.PI * depthFrac) * currentDrift;
    // Brownian noise decays with depth like the wave forces, but more
    // gently than waves so deep-water sediment still drifts visibly
    // (rock pockets and deep basins now hold particles where the old
    // pebble-bed world dumped everything to the floor). At depth=400
    // noiseEnv ~= 0.37, down to ~0.14 at depth=800.
    const noiseEnv = Math.exp(-depth / 400);
    const noiseX = bAmp * noiseEnv * (simRng() - 0.5) * 2;
    const noiseY = bAmp * noiseEnv * (simRng() - 0.5) * 2;
    const ax = surface + swell + current + noiseX;
    const ayTot = ay + splash + updraft + noiseY;
    const dragScale = ri / DRAG_REF_R;
    const dscaleDrag = drag * dragScale;
    vxi += (ax - dscaleDrag * vxi) * dt;
    vyi += (ayTot - dscaleDrag * vyi) * dt;
    vzi += (az - dscaleDrag * vzi) * dt;
    CVX[i] = vxi; CVY[i] = vyi; CVZ[i] = vzi;
    // Record force vector for SENSE_PRESSURE_X/Y. Static depth term
    // added in populateSensors, not here.
    cs.ax[i] = ax;
    cs.ay[i] = ayTot;
    CX[i] = xi + vxi * dt;
    CY[i] = yi + vyi * dt;
    CZ[i] = CZ[i] + vzi * dt;
  }
  // Settle particle force pass before returning. By the time we get
  // here, the workers have usually finished already and this is a
  // cheap no-op; otherwise the sim worker blocks until the barrier.
  if (forceWait) forceWait();
}

// Current-cell spatial context for the SENSE_OUT gradient sensor.
// Set by populateSensors each tick (the same shared-scratch trick
// VM_SENSORS/VM_SELF use). RANGE 0 => chemGradient returns the zero
// vector (engulfed organelles: no spatial gradient inside a host).
let GRAD_CX = 0, GRAD_CY = 0, GRAD_RANGE = 0;
function simGradient(chemId: number, out: Float32Array): void {
  chemGradient(GRAD_CX, GRAD_CY, GRAD_RANGE, chemId, out);
}
const VM_SENSORS: VMSensors = {
  chemConc: new Float32Array(CHEMICAL_COUNT),
  gradient: simGradient,
};
const VM_SELF: VMSelf = {
  energy: 0,
  mass: 0,
  membrane: 0,
};
// Loop structure note (stage B foundation):
//   The per-creature work below splits naturally into two phases.
//
//   Phase 1 (per-cell, parallel-safe -- no cross-cell writes):
//     updateCreatureRadius, catabolize, diffuseGases,
//     runGenericReactions, biosynthCatalyst, maintenanceDecay,
//     toxify, somatic mutation, populateSensors, runTick,
//     applyGenomeSplice, recompute senseRange/thrustAccel,
//     TURN, THRUST. Reads world spatial grids built before the
//     loop; writes only c's own store row + c.vmOut.
//
//   Phase 2 (serial, cross-cell + world writes):
//     runOrganelleChemistry (writes inner cell's chem),
//     autoExcrete (spawns particles), emit (writes pheromone),
//     adhere (modifies other.bonds), advanceDivision (publishes
//     new creature), engulf / predate / ingest (mutates other
//     creatures or particles), death push.
//
//   The two-phase split + a subworker pool over Phase 1 is the
//   next increment of stage B; left intentionally inlined for now
//   to keep this refactor's diff focused on the de-globalization
//   of VM_OUT (the prerequisite for any per-cell parallel dispatch).

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
  // SENSOR_BIN_* is only read by chemGradient() inside runActivation
  // (per-cell). With zero living cells, all that bookkeeping is
  // wasted -- CHEMICAL_COUNT * 3 typed-array fills + a binning pass
  // over every particle. Skip the rebuild when no cells are alive
  // to keep the empty-world steady state cheap.
  if (n > 0) rebuildSensorBins(world);
  // Particle bucket grid for the per-cell INGEST scan below (replaces a
  // full world.particles walk per ingesting cell).
  if (n > 0) buildParticleGrid(world);
  // Snapshot each cell's surface fingerprint up front so ADHERE /
  // ENGULF in the per-cell loop below see consistent values for
  // both self and neighbor (rather than mid-update mixes).
  refreshSurfaceFingerprints(world);
  for (let cIdx = 0; cIdx < n; cIdx++) {
    const c = world.creatures[cIdx];
    if (eaten.has(c)) continue;
    const vmOut = c.vmOut;

    updateCreatureRadius(c);

    // Temperature multiplies every enzyme-catalyzed rate (and the matching
    // idle drain) -- warm cells run hot; cold cells slow down. Q10 = 2.
    // Reads regionTempAt so cells near an active vent feel its heat.
    const localTemp = regionTempAt(world, c.x, c.y);
    const km = tempMult(localTemp);
    const dtT = dt * km;

    // Cost of being alive. ATP turns into ADP, mass conserved. Drain
    // scales with temperature like the rest of metabolism.
    const idleDrain = (BASE_METABOLIC_DRAIN + BASE_METABOLIC_PER_MASS * creatureTotalMass(c)) * dtT;
    spendATP(c, idleDrain, ATP_IDLE);

    // Catabolism is now handled by the biopolymer-digest reaction in
    // runGenericReactions (REACTIONS[10]), gated on enzyme.

    // Passive gas exchange with the surrounding water. Diffusion is
    // physical, not enzymatic -- left at the base dt.
    diffuseAmbient(c, world, dt);

    // All in-cell chemistry runs through one unified loop: named
    // reactions live at REACTIONS[0..9] with uncatRate > 0, so they
    // fire on every cell every tick; generic reactions at [10..255]
    // only fire when the cell has built the relevant catalyst. The
    // only genome-controlled metabolic axis is which catalyst/inhibitor
    // slots get expressed (catSynthMask/inhSynthMask, below) -- the old
    // SYNTH_AA/FA/BIO/CHL/ENZ/RIBO synthMask bits no longer exist (the
    // VM only sets BOND/COMPETENCE/PACKAGE on synthMask now).
    const ambientLight = Math.exp(-c.y / LIGHT_DECAY) * solarLight(world);
    runGenericReactions(c, dtT, ambientLight);
    // Standing transporters across the outer membrane (cell<->world).
    // A transporter is a SYNTH'd catalyst (SYNTH CAT param=slot) for a
    // transport-flavored reaction slot; selective uptake/excretion of
    // a chem now emerges from expressing that catalyst.
    runTransportReactions(c, world, dtT);

    // Generic catalyst synthesis. SYNTH_CAT <id> marks slot id as
    // expressed this tick; each catalyst built is its own protein.
    // Iterate the compact fired-slot list, not all CATALYST_COUNT slots.
    const cl = vmOut.catSynthList, cn = vmOut.catSynthCount;
    for (let i = 0; i < cn; i++) biosynthCatalyst(c, dtT, CAT_SYNTH_VMAX, CAT_ATP_COST, cl[i]);
    // Dual: SYNTH_INH <id> per-slot allosteric inhibitor.
    const il = vmOut.inhSynthList, iN = vmOut.inhSynthCount;
    for (let i = 0; i < iN; i++) biosynthInhibitor(c, dtT, INH_SYNTH_VMAX, INH_ATP_COST, il[i]);

    // Structural pools turn over even when nothing else is happening.
    maintenanceDecay(c, dt);

    // Endosymbionts: each engulfed cell runs the full inner pipeline
    // (VM + chemistry + active exchange with the host + sibling
    // engulf/predate + internal fission).
    if (c.contents.length > 0) {
      // Snapshot the count so an inner cell that divides this tick has
      // its new daughter processed starting NEXT tick -- exactly how a
      // free cell's child waits a tick. This is per-tick scheduling,
      // not a population cap (there is deliberately no cap).
      const nInnerThisTick = c.contents.length;
      // Siblings consumed by another organelle this tick. predatedInner
      // is the absorbed subset whose slot is freed; the rest were
      // engulfed (relocated alive into the predator's contents).
      const eatenInner = new Set<Creature>();
      const predatedInner = new Set<Creature>();
      for (let ic = 0; ic < nInnerThisTick; ic++) {
        const inn = c.contents[ic];
        if (eatenInner.has(inn)) continue; // eaten by an earlier sibling
        runInnerCell(inn, c, world, dt, dtT, ambientLight, eatenInner, predatedInner);
      }
      // Rebuild contents if anything died OR was consumed by a sibling.
      let dirty = eatenInner.size > 0;
      if (!dirty) {
        for (let ic = 0; ic < c.contents.length; ic++) {
          if (innerIsDead(c.contents[ic])) { dirty = true; break; }
        }
      }
      if (dirty) {
        const survivors: Creature[] = [];
        const promoted: Creature[] = [];
        for (let ic = 0; ic < c.contents.length; ic++) {
          const inner = c.contents[ic];
          if (eatenInner.has(inner)) {
            // Consumed by a sibling. Predated => absorbed, free its
            // slot. Engulfed => already relocated into the predator's
            // contents (still alive), so just drop it from the host
            // list without releasing the slot.
            if (predatedInner.has(inner)) {
              inner.contents.length = 0;
              inner.store.release(inner.idx);
            }
            continue;
          }
          if (innerIsDead(inner)) {
            digestInnerIntoHost(inner, c);
            for (const sub of inner.contents) promoted.push(sub);
            inner.contents.length = 0;
            inner.store.release(inner.idx);
          } else {
            survivors.push(inner);
          }
        }
        c.contents.length = 0;
        for (const s of survivors) c.contents.push(s);
        for (const p of promoted) c.contents.push(p);
        updateCreatureRadius(c);
      }
    }

    // Vent CO2 / waste back to the world if accumulating. Costs ATP, so a
    // stalled cell will fail to flush and start accumulating toxins.
    autoExcrete(c, world);

    // Toxic damage from any waste / CO2 the cell couldn't pump out.
    toxify(c, dt);

    // Thermal damage if the local water exceeds the cell's heat-shock
    // tolerance ceiling (raised by holding CHEM_REPAIR chaperones).
    thermalStress(c, dt, world);

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
    if (age > 0 && simRng() < mutP) {
      // No viability guard here. viableGenome only exists to bootstrap
      // the world with viable founder lineages; it must NOT police
      // somatic drift or inherited mutation. A somatic edit that
      // knocks out a required op is a real consequence the cell lives
      // (and its lineage dies) with -- that selection pressure is the
      // point, and metabolic reduction toward an obligate/organelle
      // state must be allowed to emerge rather than be forbidden.
      c.genome = somaticMutateOnce(c.genome, simRng);
      // Sense range tracks the SENSE_AMP count in the live genome
      // and thrust accel tracks THRUST_AMP. Somatic mutations can
      // add or remove either, so recompute both here.
      c.senseRange = computeSenseRange(c.genome);
      c.thrustAccel = computeThrustAccel(c.genome);
      // Note: c.color is NOT updated on somatic drift. Cell keeps its
      // species' visual identity so phylogeny lane color === body color
      // across the population. Inheritance through fission is what
      // produces a new lineage and a new color.
    }

    // K-3 activation pass: refresh activated_* signal chems from
    // (receptor pool * stimulus) before the VM reads them. Runs
    // before populateSensors so chemConc snapshot reflects this
    // tick's activations.
    runActivation(c, world, dt);

    populateSensors(c, world);

    // Pure-self readouts: ATP, total mass, and the structural reserve.
    // Per-chem internal pools are read via SENSE_CHEMICAL <id>;
    // velocity is read via SENSE_VX/VY (mechanoreceptor-gated, set
    // inside populateSensors above).
    VM_SELF.energy = c.energy;
    let selfMass = 0;
    const chemColsC = c.store.chemCols;
    const iC = c.idx;
    for (let k = 0; k < NAMED_CHEMICAL_COUNT; k++) selfMass += chemColsC[k][iC];
    VM_SELF.mass = selfMass;
    VM_SELF.membrane = c.molecules.membrane;

    // Per-species execution counters: each PC the VM lands on this
    // tick increments species.execCounts[pc]. species.vmTicks is
    // bumped once per cell-run so we can divide for per-position
    // rates.
    const sp = world.species.get(c.speciesKey);
    const ec = sp ? sp.execCounts : undefined;
    runTick(c.genome, c.vm, VM_SENSORS, VM_SELF, world.vmInstrBudget, vmOut, ec);
    if (sp) sp.vmTicks++;
    spendATP(c, vmOut.instructions * ENERGY_PER_INSTRUCTION, ATP_VM);
    // K-5: somatic-mutation suppression is now driven by CHEM_REPAIR
    // pool (set by SYNTH REPAIR). The somaticMutate path consults
    // c.repairTicks, but that window is now refreshed continuously
    // by the per-tick repair-chem check below rather than by a
    // discrete REPAIR op.
    // Apply pending genome self-modifications after VM exits. SPLICE_*
    // changed length, which would invalidate PC mid-tick; we let the
    // rest of this tick's ops finish first, then resize here.
    if (vmOut.spliceMode !== 0 && vmOut.spliceLength > 0) {
      applyGenomeSplice(c, vmOut.spliceMode, vmOut.spliceOffset, vmOut.spliceLength);
    }
    // POKE_BYTE / SPLICE may have changed SENSE_AMP or THRUST_AMP
    // byte counts; recompute both derived traits.
    c.senseRange = computeSenseRange(c.genome);
    c.thrustAccel = computeThrustAccel(c.genome);

    // TURN: rotate the cell's velocity by the accumulated angle delta.
    // Cheap; only does the trig when the genome actually issued a turn.
    if (vmOut.turn !== 0) {
      const cos = Math.cos(vmOut.turn);
      const sin = Math.sin(vmOut.turn);
      const nvx = c.vx * cos - c.vy * sin;
      const nvy = c.vx * sin + c.vy * cos;
      c.vx = nvx;
      c.vy = nvy;
    }

    if (vmOut.reproduce) tryReproduce(c, world);

    // Refresh the greenbeard marker whenever the cell expressed SYNTH
    // BOND this tick. Persisted between expressing ticks so a genome
    // that gates BOND behind control flow keeps its identity; -1 until
    // first expressed.
    if ((vmOut.synthMask & (1 << SYNTH_BIT_BOND)) !== 0) c.bondMarker = vmOut.bondMarker;

    // Active packaging: a cell expressing SYNTH PACKAGE encapsulates a
    // window of its OWN genome and sheds it as a free-floating carrier
    // (donor-side virus/plasmid/conjugation -- the donor cannot address
    // a recipient; uptake is the recipient's competence + the physical
    // carrier). ATP-costed like a secretion. Deterministic: cadence
    // gate + source offset from the landed hashUnit/mixHash (never
    // simRng), so RNG draw order is byte-identical. Genome bytes are
    // not matter -> mass conservation untouched.
    if ((vmOut.synthMask & (1 << SYNTH_BIT_PACKAGE)) !== 0
        && c.genome.length > 0
        && c.energy >= EDNA_PACKAGE_ATP
        && world.eDnaCarriers.length < EDNA_CARRIER_MAX) {
      const tSeed = Math.round(world.t * 1000) | 0;
      if (hashUnit(c.id, tSeed, 0x504b4731) < EDNA_PACKAGE_RATE) {
        const off = shedOffset(c.id, tSeed, c.genome.length);
        const payload = appendGenomeBytes(
          EMPTY_BYTES, c.genome, off, GENE_FRAGMENT_CAP,
        );
        if (payload.length > 0) {
          spendATP(c, EDNA_PACKAGE_ATP, ATP_EXCRETE);
          world.eDnaCarriers.push({
            x: c.x, y: c.y, z: c.z, age: 0,
            payload, srcSpeciesKey: c.speciesKey,
          });
        }
      }
    }

    // K-5: passive bond formation, greenbeard-gated. Both this cell and
    // the nearest neighbor must hold CHEM_BOND above
    // BOND_FORMATION_THRESH AND carry compatible bond markers (genome-
    // encoded recognition: |markerA - markerB| <= BOND_MARKER_TOL).
    // Bonds self-form here and self-break in the bond-spring pass when
    // either side's CHEM_BOND drops below threshold. No op required:
    // the genome controls bonding by deciding whether (and with which
    // marker) to SYNTH BOND.
    if (c.bonds.length < MAX_BONDS && c.bondMarker >= 0
        && c.store.chemCols[CHEM_BOND][c.idx] >= BOND_FORMATION_THRESH) {
      let nearest: Creature | null = null;
      let bestSq = (c.r + 24) * (c.r + 24);
      forCreaturesNear(c.x, c.y, c.r + 24, (other) => {
        if (other === c || eaten.has(other) || c.bonds.includes(other) || other.bonds.length >= MAX_BONDS) return;
        if (other.store.chemCols[CHEM_BOND][other.idx] < BOND_FORMATION_THRESH) return;
        // Greenbeard recognition: only bond to a compatible marker.
        if (other.bondMarker < 0 || Math.abs(other.bondMarker - c.bondMarker) > BOND_MARKER_TOL) return;
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

    // K-5: continuous DNA-repair gating. Each tick, any cell whose
    // CHEM_REPAIR pool is above the threshold gets its repairTicks
    // window topped up. somaticMutate already consults the window so
    // a cell that holds repair_chem high stays mutation-suppressed.
    if (c.store.chemCols[CHEM_REPAIR][c.idx] >= REPAIR_ACTIVE_THRESH) {
      c.repairTicks = Math.max(c.repairTicks, REPAIR_WINDOW_TICKS);
    }

    // Advance any in-flight fission. When progress hits 1, the stashed
    // daughter is committed into world.creatures.
    advanceDivision(c, world, dt);

    let ax = vmOut.thrustX;
    let ay = vmOut.thrustY;
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
      spendATP(c, usedFrac * ENERGY_PER_THRUST_SEC * massScale * dt, ATP_THRUST);
    }

    // VM-controlled excretion. EXCRETE <operand> picks any chem id
    // (operand mod CHEMICAL_COUNT). Cells can excrete any chem they
    // hold; no longer restricted to the 6 sensor-chem slots.
    {
      const cols = c.store.chemCols;
      const ci = c.idx;
      const exc = vmOut.excrete;
      for (let chemId = 0; chemId < CHEMICAL_COUNT; chemId++) {
        const requested = exc[chemId];
        if (requested <= 0) continue;
        const available = cols[chemId][ci];
        const amount = Math.min(requested, available);
        if (amount < EXCRETE_MIN_AMOUNT) continue;
        cols[chemId][ci] -= amount;
        spawnExcretedParticle(c, world, chemId, amount);
      }
    }

    // VM-controlled transport. TRANSPORT <chemId> moves a chem
    // across the cell<->world membrane; stack value is signed
    // (+ import from ambient, - export). DOWN-gradient is facilitated
    // and free (capped at the no-overshoot point so it can't
    // oscillate). UP-gradient is an active pump: it is allowed (a
    // cell CAN concentrate against the gradient) but costs ATP
    // ~ flow * ln(C_dest/C_src) -- the thermodynamic work. Crucially
    // the down-gradient leg yields NO ATP, so transport is never an
    // ATP source and any pump-in -> leak-out cycle strictly loses
    // ATP: no free energy can be minted. Mass-exact (chem moves 1:1
    // cell<->region ambient, the same ledger excretion/diffusion
    // use), deterministic (no rng), affordability-limited (never
    // moves mass it could not pay for). Unlocks acquisition of
    // dissolved generics (permeability 0) passive diffusion can't
    // move.
    {
      const cols = c.store.chemCols;
      const ci = c.idx;
      const tr = vmOut.transport;
      const ambient = world.ambient;
      const ab = ambientBaseAt(world, c.x, c.y);
      for (let chemId = 0; chemId < CHEMICAL_COUNT; chemId++) {
        const req = tr[chemId];
        if (req === 0) continue;
        const ak = ab + chemId;
        const inside = cols[chemId][ci];
        const outside = ambient[ak];
        const importing = req > 0;
        const src = importing ? outside : inside;  // depleted side
        const dst = importing ? inside : outside;  // accumulated side
        let mag = Math.abs(req);
        if (mag > src) mag = src;                   // can't move what's absent
        if (mag <= 0) continue;
        let costPerUnit = 0;
        if (dst < src) {
          // down-gradient: facilitated, free, no overshoot past
          // equalization (gap/2 keeps it from oscillating).
          const halfGap = (src - dst) * 0.5;
          if (mag > halfGap) mag = halfGap;
        } else {
          // up-gradient: active pump, ATP-costed by the conc ratio.
          const ratio = Math.min(
            (dst + TRANSPORT_EPS) / (src + TRANSPORT_EPS),
            TRANSPORT_MAX_RATIO,
          );
          costPerUnit = TRANSPORT_PUMP_ATP * Math.log(ratio + 1); // >0
        }
        if (mag <= 0) continue;
        if (costPerUnit > 0) {
          const got = spendATP(c, mag * costPerUnit, ATP_OTHER);
          const afford = got / costPerUnit;
          if (afford < mag) mag = afford;
          if (mag <= 0) continue;
        }
        const flow = importing ? mag : -mag;
        cols[chemId][ci] += flow;
        ambient[ak] -= flow;
      }
    }

    if (c.ingestCooldown > 0) {
      c.ingestCooldown = Math.max(0, c.ingestCooldown - dt);
    }

    if (c.ingestCooldown <= 0 && c.energy >= INGEST_ENERGY_COST) {
      let ingested = false;
      // Engulf and predate both scan for nearby cells via the spatial
      // grid; range of c.r + 32 covers all plausible neighbor radii.
      const scanRange = c.r + 32;
      if (vmOut.engulf) {
        forCreaturesNear(c.x, c.y, scanRange, (other) => {
          if (other === c || eaten.has(other)) return;
          const dx = other.x - c.x;
          const dy = other.y - c.y;
          const dz = other.z - c.z;
          const minD = c.r + other.r;
          if (dx * dx + dy * dy + dz * dz >= minD * minD) return;
          // No engine-side recognition gate: the genome decides
          // (via its sensors) before issuing ENGULF. Whether it can
          // physically wrap the target is decided by canBreach. Refresh
          // the target's radius first so the size comparison reflects
          // its current mass regardless of loop order (deterministic).
          updateCreatureRadius(other);
          if (!canBreach(c, other)) return;
          const otherMass = creatureTotalMass(other);
          const cost = predationCost(other, otherMass);
          if (c.energy < cost) return;
          // Engulfed cell becomes an endosymbiont. It stays FULLY
          // ALIVE inside the vacuole: its genome VM, chemistry,
          // maintenance, somatic drift, and internal division all run
          // each tick (see runOrganelleChemistry). organelleSynthMask
          // is kept as a fallback only.
          other.organelleSynthMask = genomeSynthMask(other.genome);
          c.contents.push(other);
          spendATP(c, cost, ATP_ENGULF);
          c.ingestCooldown = PREDATION_COOLDOWN_SEC;
          eaten.add(other);
          ingested = true;
          return true;
        });
      }
      if (!ingested && vmOut.predate) {
        forCreaturesNear(c.x, c.y, scanRange, (other) => {
          if (other === c || eaten.has(other)) return;
          const dx = other.x - c.x;
          const dy = other.y - c.y;
          const dz = other.z - c.z;
          const minD = c.r + other.r;
          if (dx * dx + dy * dy + dz * dz >= minD * minD) return;
          updateCreatureRadius(other);
          if (!canBreach(c, other)) return;
          const otherMass = creatureTotalMass(other);
          const cost = predationCost(other, otherMass);
          if (c.energy < cost) return;
          // Predator absorbs the prey's full chem pool. Each chem
          // transfers slot-for-slot; ATP separately.
          {
            const myCols = c.store.chemCols;
            const otherCols = other.store.chemCols;
            const ci = c.idx; const oi = other.idx;
            for (let k = 0; k < NAMED_CHEMICAL_COUNT; k++) {
              myCols[k][ci] += otherCols[k][oi];
              otherCols[k][oi] = 0;
            }
          }
          // Generic chem transfers directly too -- predator absorbs
          // the prey's full chemistry, including any abstract
          // molecules the prey had been accumulating.
          {
            const myCols = c.store.genericChemCols;
            const otherCols = other.store.genericChemCols;
            const ci = c.idx; const oi = other.idx;
            for (let k = 0; k < GENERIC_CHEMICAL_COUNT; k++) {
              myCols[k][ci] += otherCols[k][oi];
              otherCols[k][oi] = 0;
            }
          }
          // Catalysts transfer verbatim too -- prey enzymes are NOT
          // denatured; the predator inherits them intact, exactly like
          // an engulfed cell digested in place (digestInnerIntoHost).
          {
            const myCats = c.store.catalystCols;
            const otherCats = other.store.catalystCols;
            const ci = c.idx; const oi = other.idx;
            for (let k = 0; k < CATALYST_COUNT; k++) {
              const v = otherCats[k][oi];
              if (v !== 0) { myCats[k][ci] += v; otherCats[k][oi] = 0; }
            }
          }
          c.energy += other.energy;
          for (const inner of other.contents) c.contents.push(inner);
          other.contents.length = 0;
          spendATP(c, cost, ATP_PREDATE);
          c.ingestCooldown = PREDATION_COOLDOWN_SEC;
          eaten.add(other);
          // Note: slot release is deferred to the death pass so the
          // creature stays readable for the rest of this tick. Other
          // cells' sensor scans iterate the pre-tick CREATURE_BUCKETS
          // and could otherwise pick up a zeroed-out ghost slot here.
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
        // Only scan particles whose bucket overlaps the cell's body
        // (forParticlesNear) instead of walking all of world.particles.
        const cr2 = c.r * c.r;
        forParticlesNear(world, c.x, c.y, c.r, (p) => {
          const chemId = p.chemId;
          // Bond-energy-threshold engulf: the cell eats any contacted
          // particle whose chemical bond potential clears the
          // threshold INGEST popped this tick. Detritus (low
          // threshold) eats the open generic set; rock/inorganics
          // (CHEM_BOND_POTENTIAL 0) fall out for any threshold > 0;
          // a picky cell sets a high threshold. No sensor bins, no
          // curated lists -- selectivity is an evolvable scalar and
          // species-specificity is handled post-ingestion by
          // chem-id-addressed metabolism.
          if (CHEM_BOND_POTENTIAL[chemId] < vmOut.ingestThreshold) return;
          const dx = p.x - c.x;
          const dy = p.y - c.y;
          const dz = p.z - c.z;
          if (dx * dx + dy * dy + dz * dz < cr2) {
            if (p.molecules) {
              // Molecule-tagged particle: contents go straight into the
              // cell's molecule pool, bypassing digestion. This is corpse
              // / excretion food -- already broken down.
              for (const k of MOLECULE_IDS) c.molecules[k] += p.molecules[k];
            } else {
              // Plain chem particle: deposit its mass into the matching
              // chem slot. Biopolymer needs the digester reaction to
              // turn into glu/aa/fa; minerals stay as substrate; o2/co2
              // go straight to the respiration pool.
              c.store.chemCols[chemId][c.idx] += mass(p) / CHEM_MM[chemId];
            }
            // Generic-chemical payload (cells dump their generic pool
            // into one organic particle on death). Transfer into the
            // eater's generic chem cols.
            if (p.genericChem) {
              const gcCols = c.store.genericChemCols;
              const ci = c.idx;
              for (let k = 0; k < GENERIC_CHEMICAL_COUNT; k++) {
                gcCols[k][ci] += p.genericChem[k];
              }
            }
            spendATP(c, INGEST_ENERGY_COST, ATP_INGEST);
            // c.r >= MIN_CREATURE_R == INGEST_REF_R so the divisor is just c.r.
            c.ingestCooldown = INGEST_COOLDOWN_SEC * (INGEST_REF_R / c.r);
            removeParticleAt(world, p.idx);
            return true; // ate one; stop
          }
        });
      }
    }

    updateCreatureRadius(c);

    // Death conditions:
    //  1. Starvation: no ATP and no fuel anywhere to rebuild it.
    //  2. Autolysis: biomass has decayed below the viable minimum (the
    //     cell can no longer hold itself together as a cell).
    //  3. No mrna: without protein-synthesis machinery the cell
    //     can't turn over biomass or replenish enzymes -- biologically
    //     dead even if structurally intact.
    //  4. No amino acid: with the per-op aa cost on growth ops, an
    //     aa-empty cell is functionally paralyzed. Catch it here so
    //     it doesn't sit indefinitely just decaying biomass.
    //  5. Founder old-age: founders die after FOUNDER_LIFESPAN_SEC so
    //     they can't sit forever -- descendants have to carry the
    //     lineage forward or the top-up reseeds with fresh genomes.
    const m = c.molecules;
    // Cull only founders that never managed to fission. Founders that
    // produced a viable child graduated into founderReproduced and
    // live a normal life (so a successful colony's anchor cell can
    // age out naturally instead of hitting the wall artificially).
    const founderTooOld = FOUNDER_CULL_ENABLED
      && world.founderIds.has(c.id)
      && !world.founderReproduced.has(c.id)
      && !world.pinnedSpecies.has(c.speciesKey)
      && world.t - c.bornAt >= FOUNDER_LIFESPAN_SEC + founderLifespanBonus(world, c);
    const starve = c.energy <= 0 && noFuel(c);
    const lowMemb = m.membrane < MIN_VIABLE_MEMBRANE;
    const lowMrna = m.mrna < MIN_VIABLE_RIBOSOME;
    const lowAa = m.aminoAcid < MIN_VIABLE_AMINOACID;
    if (starve || lowMemb || lowMrna || lowAa || founderTooOld) {
      const st = world.stats;
      if (st) {
        if (starve) st.dStarve++;
        else if (lowMemb) st.dMembrane++;
        else if (lowMrna) st.dMrna++;
        else if (lowAa) st.dAa++;
        else st.dOld++;
      }
      dead.push(c);
    }
  }

  // Combined removal pass. dead = spilled, eaten = absorbed (no spill).
  // Build a survivors array in one O(N) pass instead of repeatedly
  // splicing (which is O(N) each).
  if (dead.length > 0 || eaten.size > 0) {
    const spillSet = new Set<Creature>(dead);
    // Engulfed (vs predated) prey is identified by being in some live
    // predator's contents[]. Engulfed prey keeps its slot alive (it
    // may emerge when the predator dies); predated prey gets absorbed
    // entirely and its slot is freed.
    const inSomeContents = new Set<Creature>();
    for (const c of world.creatures) {
      if (spillSet.has(c) || eaten.has(c)) continue;
      for (const inner of c.contents) inSomeContents.add(inner);
    }
    const survivors: Creature[] = [];
    const released: Creature[] = [];
    for (const c of world.creatures) {
      if (spillSet.has(c) || eaten.has(c)) {
        for (const inner of c.contents) {
          inner.x = c.x + (simRng() - 0.5) * Math.max(2, c.r);
          inner.y = c.y + (simRng() - 0.5) * Math.max(2, c.r);
          inner.z = c.z;
          released.push(inner);
        }
        c.contents.length = 0;
        for (const partner of c.bonds) {
          const k = partner.bonds.indexOf(c);
          if (k >= 0) partner.bonds.splice(k, 1);
        }
        c.bonds.length = 0;
        // If the cell was mid-division, the stashed child was alloc'd in
        // tryReproduce but never pushed into world.creatures. Its slot
        // would leak unless we release it explicitly here.
        if (c.division) {
          const ch = c.division.child;
          ch.store.release(ch.idx);
          c.division = null;
        }
        // Engulfed cells (in eaten AND in some predator's contents)
        // keep their slot alive until that predator dies and pushes
        // them back to world.creatures via released[]. An engulfed
        // founder is NOT culled and KEEPS its founder identity, so it
        // resumes as a founder if it's ever released -- being inside
        // another cell is a protected state, not a death.
        const engulfed = eaten.has(c) && inSomeContents.has(c);
        if (!engulfed) {
          // Drop founder tracking for cells that are truly gone
          // (spilled/dead or predated-absorbed) so the sets don't
          // accumulate stale ids across the run.
          world.founderIds.delete(c.id);
          world.founderReproduced.delete(c.id);
          world.founderBirthScore.delete(c.id);
        }
        if (spillSet.has(c)) {
          releaseChemsAsParticles(c, world);
          c.store.release(c.idx);
        } else if (eaten.has(c) && !inSomeContents.has(c)) {
          // Predated -- absorbed entirely, no vacuole, slot is free.
          c.store.release(c.idx);
        }
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

// On death, return the cell's chem pool to the world as free-floating
// particles -- one faithful, full-mass particle per chem (named AND
// generic) carrying its own identity. Catalysts denature back into
// 0.5 aa + 0.5 min first (the one intentional transformation kept).
// No ATP->ADP fold, no sub-threshold mass discard, no biopolymer
// corpse aggregation: death is now mass-faithful for matter.
const DEATH_RELEASE_SCATTER = 1.5; // small in-place jitter (was 6 / 4)
function releaseChemsAsParticles(c: Creature, world: World): void {
  const ci = c.idx;
  const cols = c.store.chemCols;

  // Lysis sheds a genome fragment into the open water as a free-
  // floating eDNA carrier (the HGT vector). No uptake yet (sub-commit
  // 3 adds competence); carriers are inert, carry no mass, and draw no
  // simRng -- so trajectory and golden are unchanged here. The corpse's
  // matter still releases fully and unchanged below.
  if (c.genome.length > 0 && world.eDnaCarriers.length < EDNA_CARRIER_MAX) {
    const off = shedOffset(c.id, world.t, c.genome.length);
    const payload = appendGenomeBytes(
      EMPTY_BYTES, c.genome, off, GENE_FRAGMENT_CAP,
    );
    if (payload.length > 0) {
      world.eDnaCarriers.push({
        x: c.x, y: c.y, z: c.z, age: 0,
        payload, srcSpeciesKey: c.speciesKey,
      });
    }
  }

  // (1, kept) Catalysts denature back to their substrates (0.5 aa +
  // 0.5 min). Folded into the chem pool so the release loop below
  // emits them naturally as those chems.
  {
    const ccats = c.store.catalystCols;
    for (let k = 0; k < CATALYST_COUNT; k++) {
      const v = ccats[k][ci];
      if (v > 0) {
        cols[CHEM_AA][ci] += 0.5 * v;
        cols[CHEM_MIN][ci] += 0.5 * v;
        ccats[k][ci] = 0;
        recordRxn(RX_DEATH_CATDENATURE, RX_LOC_CELL, 0);
      }
    }
  }
  // Leftover ATP is released as ADP, exactly like spendATP does in
  // life (energy -> ADP, 1:1). Annihilating it on death broke mass
  // conservation (it was the entire post-settle audit drift); the
  // ADP then emits with the rest of the pool below.
  cols[CHEM_ADP][ci] += c.energy;
  c.energy = 0;
  // Necromass lipolysis: a dead cell's membrane bilayer hydrolyzes
  // rather than persisting as inert membrane debris. Same chemistry
  // as maintenance turnover (~0.65 fatty acid + 0.35 glycerophosphate/
  // head-group -> aa). This is the realistic fatty-acid recycling
  // path -- structural lipid returns to the environment as free fa
  // for survivors to rebuild membranes from.
  {
    const mb = cols[CHEM_MEMBRANE][ci];
    if (mb > 0) {
      cols[CHEM_FA][ci] += 0.65 * mb;
      cols[CHEM_AA][ci] += 0.35 * mb;
      cols[CHEM_MEMBRANE][ci] = 0;
      recordRxn(RX_MAINT_MEMBRANE, RX_LOC_CELL, 0);
    }
  }

  // Emit one full-mass particle for a chem (no thresholding -- (3)
  // removed). Placed in-place with only a small scatter ((5) toned
  // down). Generic chem ids deposit straight back into the matching
  // generic column on re-ingest (chemCols[NAMED+k] aliases it).
  const relBase = ambientBaseAt(world, c.x, c.y);
  const emit = (chemId: number, total: number, density: number): void => {
    if (total <= 0) return;
    // total is chemical AMOUNT; the particle carries PHYSICAL MASS.
    const physMass = total * CHEM_MM[chemId];
    const rTrue = radiusForMass(physMass, density);
    // Too little to make a non-inflated particle: flooring r to
    // DEATH_RELEASE_R_MIN would give the particle far more physical
    // mass than the chem it represents (the dominant death-pass mass
    // leak, x dozens of tiny generic pools per corpse). Dissolve the
    // trace amount into the local field instead -- mass-conserving.
    if (rTrue < DEATH_RELEASE_R_MIN) {
      world.ambient[relBase + chemId] += total;
      return;
    }
    const r = rTrue;
    const jit = (): number => (simRng() - 0.5) * DEATH_RELEASE_SCATTER;
    const z = world.depth > 2 * r
      ? Math.min(world.depth - r, Math.max(r, c.z + jit()))
      : world.depth / 2;
    pushParticle(world, {
      x: c.x + jit(),
      y: c.y + jit(),
      z,
      vx: 0, vy: 0, vz: 0, // released in place -- no death momentum
      r,
      chemId,
      density,
    });
  };

  // Named chems: one faithful, full-mass particle each.
  for (let k = 0; k < NAMED_CHEMICAL_COUNT; k++) {
    emit(k, cols[k][ci], CHEM_BASE_DENSITY[k]);
    cols[k][ci] = 0;
  }
  // (4, removed) Generic chems released per-chem as first-class
  // single-chem particles -- no biopolymer-tagged corpse blob.
  {
    const gcols = c.store.genericChemCols;
    for (let k = 0; k < GENERIC_CHEMICAL_COUNT; k++) {
      const chemId = NAMED_CHEMICAL_COUNT + k;
      emit(chemId, gcols[k][ci], CHEM_BASE_DENSITY[chemId]);
      gcols[k][ci] = 0;
    }
  }
}

// Genome replication tax. The genome is a nucleic acid, so copying it
// costs the same substrates the engine already uses to build its
// nucleic-acid currency -- synth_ribo (mRNA) is aminoAcid + minerals,
// 50/50 -- scaled by child genome length. Matter is conserved: whatever
// the parent can cover is converted to inert waste (useful aa/min ->
// waste), making this a real fitness cost that scales with genome size
// and selects against unbounded bloat now that the hard length cap is
// gone. Underfunding is not fatal: the parent pays only what it holds
// (no stillbirth filter, matching the rest of fission). This is purely
// the replication cost paid once at division -- free-cell fission and
// endosymbiont internal division alike -- transcription/expression are
// deliberately untouched. GENOME_MASS_PER_BYTE is the tuning knob: a
// 24..100b founder pays ~0.5..2 mass (negligible), a multi-thousand-
// byte runaway pays tens-to-hundreds (crippling).
// Lowered 0.02 -> 0.01 with gene framing: framed genomes carry intron
// bytes (neutral non-coding length), and the replication tax must stay
// gentle enough that introns are near-neutral -- otherwise selection
// would strip the very non-coding space the framing exists to provide.
export const GENOME_MASS_PER_BYTE = 0.01;
export function chargeGenomeReplication(parent: Creature, childGenome: Uint8Array): void {
  const halfDemand = 0.5 * GENOME_MASS_PER_BYTE * childGenome.length;
  const aaKey = NAMED_CHEMICALS[CHEM_AA];
  const minKey = NAMED_CHEMICALS[CHEM_MIN];
  const tookAa = Math.min(parent.molecules[aaKey], halfDemand);
  const tookMin = Math.min(parent.molecules[minKey], halfDemand);
  if (tookAa > 0) parent.molecules[aaKey] -= tookAa;
  if (tookMin > 0) parent.molecules[minKey] -= tookMin;
  const consumed = tookAa + tookMin;
  if (consumed > 0) parent.molecules[NAMED_CHEMICALS[CHEM_WASTE]] += consumed;
}

function tryReproduce(parent: Creature, world: World): void {
  // Can't start a new division while one is already in flight.
  if (parent.division) return;

  // Initiating mitosis costs ATP whether the attempt succeeds or not.
  // This is the rate-limit on REPRODUCE: a cell can't fire it every tick
  // without paying for the failed cycles, so spamming the op starves the
  // cell instead of being free.
  spendATP(parent, REPRODUCE_ATTEMPT_ATP_BASE + REPRODUCE_ATTEMPT_ATP_PER_MASS * creatureTotalMass(parent), ATP_REPRODUCE);

  if (world.creatures.length >= MAX_CREATURES) return;
  // Sexual reproduction (bonded crossover): if the parent currently has
  // any bonds, the child's pre-mutation genome is a single-crossover
  // recombinant of parent + random bond partner. Lets useful subprograms
  // flow between adjacent lineages. Falls through to plain asexual when
  // there are no bonds.
  let parentGenome = parent.genome;
  if (parent.bonds.length > 0) {
    const partner = parent.bonds[Math.floor(simRng() * parent.bonds.length)];
    parentGenome = crossoverGenomes(parent.genome, partner.genome);
  }
  const childGenome = mutateGenome(parentGenome, simRng);
  // Pay the genome-replication material tax before partitioning the
  // cytoplasm, so the child's proportional share is taken from what
  // the parent has left after copying the DNA.
  chargeGenomeReplication(parent, childGenome);
  // No engine-side stillbirth filter. If the mutation knocks out a
  // required op, that's the cell's problem -- the resulting daughter
  // will autolyze through the normal death pass (which conserves
  // mass back to particles). "Started mitosis, no undo button" was
  // the user's explicit design call.
  const parentShare = parent.vmOut.reproduceFraction;
  const childShare = 1 - parentShare;
  // Build-block sufficiency check is also gone -- the parent commits
  // whatever proportional share its current pool gives the child,
  // and if either daughter ends up below MIN_VIABLE_MEMBRANE the
  // standard autolyze handles cleanup with mass returned to the
  // environment. Bad timing has real consequences now.
  const childMolecules = emptyMolecules();
  for (const mk of MOLECULE_IDS) {
    const give = parent.molecules[mk]
      * partitionFrac(parent.vmOut, childShare, MOLECULE_INDEX[mk]);
    parent.molecules[mk] -= give;
    childMolecules[mk] = give;
  }
  const childCatalysts = new Float32Array(CATALYST_COUNT);
  {
    const cols = parent.store.catalystCols;
    const pi = parent.idx;
    for (let k = 0; k < CATALYST_COUNT; k++) {
      const v = cols[k][pi];
      const give = v * childShare;
      cols[k][pi] = v - give;
      childCatalysts[k] = give;
    }
  }
  // Same proportional split for the inhibitor pools.
  const childInhibitors = new Float32Array(CATALYST_COUNT);
  {
    const cols = parent.store.inhibitorCols;
    const pi = parent.idx;
    for (let k = 0; k < CATALYST_COUNT; k++) {
      const v = cols[k][pi];
      const give = v * childShare;
      cols[k][pi] = v - give;
      childInhibitors[k] = give;
    }
  }
  // Same proportional split for the generic chemical pool. Named
  // chemCols (0..7) are aliased onto molCols so they already split
  // above via the molecules path; we only need to split the
  // independent generic slice here.
  const childGenericChem = new Float32Array(GENERIC_CHEMICAL_COUNT);
  {
    const cols = parent.store.genericChemCols;
    const pi = parent.idx;
    for (let k = 0; k < GENERIC_CHEMICAL_COUNT; k++) {
      const v = cols[k][pi];
      const give = v * partitionFrac(parent.vmOut, childShare, NAMED_CHEMICAL_COUNT + k);
      cols[k][pi] = v - give;
      childGenericChem[k] = give;
    }
  }
  // Path 1: ATP is the `atp` molecule -- the MOLECULE_IDS split above
  // already moved its share to childMolecules.atp and debited parent.
  // No separate energyGift (double-moved energy before).
  // No additive yolk. The child receives exactly its proportional
  // share of the parent's molecules / reserves / energy. If the
  // parent didn't stockpile enough mRNA / chlorophyll / glucose
  // before fission, the child inherits that deficit. This puts the
  // genome in charge of bootstrap -- cells that evolve "save before
  // dividing" behavior produce viable children; profligate ones
  // produce stillborns.

  updateCreatureRadius(parent);

  const angle = simRng() * Math.PI * 2;
  let childMassEstimate = 0; // atp included via MOLECULE_IDS
  for (const mk of MOLECULE_IDS) childMassEstimate += childMolecules[mk];
  const childRGuess = Math.max(MIN_CREATURE_R, Math.cbrt((3 * childMassEstimate) / (4 * Math.PI)));
  // Place the child outside the parent's recent food-eating zone.
  // The previous 1.1x offset dropped the daughter inside the parent's
  // sense range of just-eaten particles, so the child saw no food
  // gradient and drifted until starving.
  const offset = (parent.r + childRGuess) * BIRTH_OFFSET_MULT;
  const child = newCreature(world.creatureStore, {
    x: parent.x + Math.cos(angle) * offset,
    y: parent.y + Math.sin(angle) * offset,
    z: parent.z,
    vx: parent.vx, vy: parent.vy, vz: parent.vz,
    r: MIN_CREATURE_R,
    density: parent.density,
    energy: childMolecules.atp,
    senseRange: computeSenseRange(childGenome),
    thrustAccel: computeThrustAccel(childGenome),
    genome: childGenome,
    vm: newVMState(),
    color: genomeColor(childGenome, world.anchorGenome),
    ingestCooldown: INGEST_COOLDOWN_SEC,
    repairTicks: 0,
    bornAt: world.t,
    speciesKey: genomeKey(childGenome),
    molecules: childMolecules,
  });
  // Inherit the parent's founding lineage. Mutated descendants stay
  // part of the same lineageRoot for top-up counting purposes.
  child.lineageRoot = parent.lineageRoot;
  child.parentId = parent.id;
  {
    const cols = child.store.catalystCols;
    const ci = child.idx;
    for (let k = 0; k < CATALYST_COUNT; k++) cols[k][ci] = childCatalysts[k];
  }
  {
    const cols = child.store.inhibitorCols;
    const ci = child.idx;
    for (let k = 0; k < CATALYST_COUNT; k++) cols[k][ci] = childInhibitors[k];
  }
  {
    const cols = child.store.genericChemCols;
    const ci = child.idx;
    for (let k = 0; k < GENERIC_CHEMICAL_COUNT; k++) cols[k][ci] = childGenericChem[k];
  }
  updateCreatureRadius(child);

  // Partition the engulfed cells between the two daughters in
  // proportion to mass (childShare to the child). No fission /
  // duplication -- each existing inner cell moves wholesale to one
  // side; only the *allocation* is mass-weighted. Largest-first greedy
  // assigning each to whichever daughter is furthest below its target
  // share keeps the realized split close to childShare and is
  // deterministic (mass desc, id asc tiebreak).
  if (parent.contents.length > 0) {
    const inners = parent.contents.slice();
    parent.contents.length = 0;
    let totalInnerMass = 0;
    for (const inner of inners) totalInnerMass += creatureTotalMass(inner);
    const targetChild = totalInnerMass * childShare;
    const targetParent = totalInnerMass - targetChild;
    inners.sort((a, b) => {
      const dm = creatureTotalMass(b) - creatureTotalMass(a);
      return dm !== 0 ? dm : a.id - b.id;
    });
    let childMass = 0;
    let parentMass = 0;
    for (const inner of inners) {
      const m = creatureTotalMass(inner);
      if (targetChild - childMass >= targetParent - parentMass) {
        child.contents.push(inner);
        childMass += m;
      } else {
        parent.contents.push(inner);
        parentMass += m;
      }
    }
  }

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
  // No commit-time stillbirth abort either. A daughter that opens
  // below MIN_VIABLE_MEMBRANE gets pushed to world.creatures anyway
  // and is caught by the normal autolyze pass on the next tick,
  // which releases its mass as particles. Brief +1/-1 churn in the
  // species table is the cost of dumb fission timing.
  // Drop the daughter at the current separation point. Recomputing from
  // the parent's live position keeps the visual in sync even if the
  // parent drifted during the second-long animation. Matches the
  // initial offset in tryReproduce().
  const offset = (c.r + child.r) * BIRTH_OFFSET_MULT;
  child.x = c.x + Math.cos(ang) * offset;
  child.y = c.y + Math.sin(ang) * offset;
  child.vx = c.vx;
  child.vy = c.vy;
  world.creatures.push(child);
  noteCreatureBirth(world, child, c.speciesKey);
  // A founder that successfully spawns a viable child has carried its
  // lineage forward -- graduate it out of the lifespan cull (but
  // keep it in founderIds so livingFounderLineages still reflects
  // "lineages with a living founder cell"). The cull only exists to
  // retire founders that never manage to reproduce.
  if (world.founderIds.has(c.id)) {
    world.founderReproduced.add(c.id);
  }
}

function populateSensors(c: Creature, _world: World, engulfed = false): void {
  // SENSE_OUT spatial context. Engulfed organelles get range 0 ->
  // zero gradient (no spatial field inside a host), mirroring the
  // chemo pass's organelle handling.
  GRAD_CX = c.x;
  GRAD_CY = c.y;
  GRAD_RANGE = engulfed ? 0 : c.senseRange;
  // K-5: external sensing collapsed onto SENSE_CHEMICAL <id>. The K-3
  // activation pass (runActivation, called every tick) writes
  // activated_photo/chemo/mech/thermo/mag chems into the same per-cell
  // pool, gated on the corresponding receptor chem. So this snapshot
  // is the entire VMSensors payload now -- everything else is fallout
  // of the genome reading the right chem id.
  const cols = c.store.chemCols;
  const i = c.idx;
  const cc = VM_SENSORS.chemConc;
  for (let k = 0; k < CHEMICAL_COUNT; k++) cc[k] = cols[k][i];
}

// Physical predation gate, shared by ENGULF and PREDATE. The hard
// gate is geometric: the attacker must be physically wider than the
// target -- you cannot wrap or rupture a cell broader than you. The
// target's structural membrane is the OTHER physical defense, but it
// acts as armor through the energy economics (predationCost scales
// with target membrane: a thick envelope is expensive, and beyond
// the attacker's ATP simply impossible, to breach). Membrane is
// deliberately NOT a second hard inequality here -- doing so keyed
// success on a sub-tick maintenance-decay ordering artifact and made
// equal-membrane cells mutually un-eatable. No mass score, no
// recognition table: predator/prey is whatever the genomes' physical
// investments (size vs. envelope) make it, emergently.
function canBreach(attacker: Creature, target: Creature): boolean {
  return attacker.r >= PREDATION_RADIUS_RATIO * target.r;
}
function predationCost(target: Creature, targetMass: number): number {
  // Cohesion penalty: ripping a cell out of a colony costs extra ATP
  // on top of the size/membrane economics. The strength scalar is the
  // target's genome-purchased CHEM_BOND pool (produced by SYNTH BOND
  // chemistry) multiplied by how many intact bonds anchor it -- more
  // adhesive investment and more partners => harder to extract. A
  // solitary cell (zero bonds) pays nothing extra, so colony defense
  // EMERGES from how much a lineage invests in bonding rather than
  // being a hardcoded "colonies are protected" rule.
  const cohesion = target.store.chemCols[CHEM_BOND][target.idx] * target.bonds.length;
  return PREDATION_ENERGY_BASE
    + PREDATION_ENERGY_PER_MASS * targetMass
    + PREDATION_ENERGY_PER_MEMBRANE * target.molecules.membrane
    + PREDATION_ENERGY_PER_COHESION * cohesion;
}

function creatureTotalMass(c: Creature): number {
  // Path 1: ATP is the `atp` molecule (== c.energy, aliased), so it
  // is summed by the MOLECULE_IDS loop -- no separate c.energy term
  // (that would double-count).
  let m = 0;
  for (const k of MOLECULE_IDS) m += c.molecules[k];
  // Engulfed prey lives in our vacuole; its mass still occupies our volume.
  for (const inner of c.contents) m += creatureSelfMass(inner);
  return m;
}

// Mass of a single cell excluding its contents -- used to avoid recursion
// when summing up an engulfed prey's contribution to its container's mass.
function creatureSelfMass(c: Creature): number {
  // ATP counted via MOLECULE_IDS (it is the `atp` molecule == energy).
  let m = 0;
  for (const k of MOLECULE_IDS) m += c.molecules[k];
  return m;
}

// Has the cell exhausted every fuel it could turn into ATP?
function noFuel(c: Creature): boolean {
  const m = c.molecules;
  // Direct molecular fuels: glucose / fattyAcid can be catabolized
  // straight into ATP, no enzyme needed.
  const hasDirect = m.glucose >= 0.5 || m.fattyAcid >= 0.5;
  if (hasDirect) return false;
  // Biopolymer is fuel-on-paper: convertible to glu/aa/fa via the
  // digestion reaction iff the cell has enzyme. Without enzyme it's
  // functionally starvation.
  if (m.biopolymer >= 0.5 && m.enzyme >= MIN_USABLE_ENZYME) return false;
  // Photosynth recovery path: chlorophyll + CO2 + light bypasses the
  // enzyme requirement (chl is itself an enzyme-like catalyst).
  if (m.chlorophyll > 0.5 && m.co2 > 0.5) return false;
  return true;
}

// Minimum enzyme to unlock biopolymer digestion. Heterotroph founders
// start with enzyme=0.5 and enzyme decays at ~0.1%/sec, so it takes
// hundreds of sim-sec to fall below this without active SYNTH_ENZ.
const MIN_USABLE_ENZYME = 0.01;

export function updateCreatureRadius(c: Creature): void {
  // Treat stored mass as a sphere's volume (water-density convention), then
  // render its equatorial cross-section. So mass = (4/3) pi R^3, giving
  // R = cbrt(3 m / (4 pi)). The on-screen disk's area is pi R^2.
  // This means doubling mass only grows radius by 2^(1/3) ~= 1.26, so the
  // surface-area-vs-volume penalty kicks in much harder than under the old
  // disk-area formula.
  const m = creatureTotalMass(c);
  c.r = Math.max(MIN_CREATURE_R, Math.cbrt((3 * m) / (4 * Math.PI)));
  // Effective density follows what the cell is carrying. Each chem
  // contributes at its bulk density (minerals at 2.4 sinks, gas at
  // 0.14 floats); molecules + ATP at water density (1.0). Real cells
  // are osmotically regulated; we damp the raw mass ratio toward 1.0
  // so loading dense chems doesn't immediately glue the cell to the
  // seafloor. Clamped to [DENSITY_FLOOR, DENSITY_CEIL].
  if (m > 0) {
    const s = c.store; const i = c.idx;
    const cols = s.chemCols;
    let weighted = 0;
    for (let k = 0; k < NAMED_CHEMICAL_COUNT; k++) {
      weighted += cols[k][i] * CHEM_BASE_DENSITY[k];
    }
    const raw = weighted / m;
    const damped = 1 + (raw - 1) * DENSITY_DAMPING;
    c.density = damped < DENSITY_FLOOR ? DENSITY_FLOOR
              : damped > DENSITY_CEIL ? DENSITY_CEIL
              : damped;
  }
}

const GRID_CELL_SIZE = 12;

// Worst-case grid dimensions. For an 800x600 world with cell=12, the
// grid is 67x50 = 3350 cells. 16384 leaves room for larger worlds; the
// buffer is allocated once at world creation and never resized.
const COLLISION_MAX_CELLS = 16384;
// Matches PARTICLE_STORE_PREALLOC_CAP so cellItems can index every
// possible particle slot.
const COLLISION_MAX_PARTICLES = PARTICLE_STORE_PREALLOC_CAP;

// SAB-backed collision-pass scratch. Holds the per-particle mass +
// sleep flags AND the spatial-hash grid in a layout subworkers can
// read directly. Replaces the old number[][] bucket-of-arrays layout
// (which can't cross a worker boundary).
//
//   mass        Float32[cap]            kg-like per particle
//   asleep      Uint8[cap]              1 if both ends of a pair can skip work
//   cellStart   Int32[maxCells + 1]     prefix sum: items in cell i live at
//                                       cellItems[cellStart[i]..cellStart[i+1])
//   cellItems   Int32[cap]              particle indices, sorted by cell
//
// Built serially each pass on the sim worker; read by the row-parity
// collision subworkers during the parallel resolve phase.
export interface CollisionSharedLayout {
  buffer: ArrayBufferLike;
  maxParticles: number;
  maxCells: number;
  offsets: {
    mass: number;
    asleep: number;
    cellStart: number;
    cellItems: number;
    // Jacobi collision accumulators: per-particle position/velocity
    // deltas. The sweep reads the frozen PX/PVX snapshot and only
    // ACCUMULATES here; resolveCollisions applies them after the
    // barrier. Order-independent -> no Gauss-Seidel directional drift.
    dpx: number; dpy: number; dpz: number;
    dvx: number; dvy: number; dvz: number;
  };
}

function allocCollisionBuffer(): CollisionSharedLayout {
  const align = (n: number): number => (n + 7) & ~7;
  let o = 0;
  const offsets = {} as CollisionSharedLayout["offsets"];
  offsets.mass = o; o = align(o + COLLISION_MAX_PARTICLES * 4);
  offsets.asleep = o; o = align(o + COLLISION_MAX_PARTICLES);
  offsets.cellStart = o; o = align(o + (COLLISION_MAX_CELLS + 1) * 4);
  offsets.cellItems = o; o = align(o + COLLISION_MAX_PARTICLES * 4);
  offsets.dpx = o; o = align(o + COLLISION_MAX_PARTICLES * 4);
  offsets.dpy = o; o = align(o + COLLISION_MAX_PARTICLES * 4);
  offsets.dpz = o; o = align(o + COLLISION_MAX_PARTICLES * 4);
  offsets.dvx = o; o = align(o + COLLISION_MAX_PARTICLES * 4);
  offsets.dvy = o; o = align(o + COLLISION_MAX_PARTICLES * 4);
  offsets.dvz = o; o = align(o + COLLISION_MAX_PARTICLES * 4);
  const total = o;
  let buffer: ArrayBufferLike;
  if (typeof SharedArrayBuffer !== "undefined" &&
      typeof globalThis !== "undefined" &&
      (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated) {
    buffer = new SharedArrayBuffer(total);
  } else {
    buffer = new ArrayBuffer(total);
  }
  return { buffer, maxParticles: COLLISION_MAX_PARTICLES, maxCells: COLLISION_MAX_CELLS, offsets };
}

const COLLISION_LAYOUT = allocCollisionBuffer();
const COLLISION_MASS = new Float32Array(COLLISION_LAYOUT.buffer, COLLISION_LAYOUT.offsets.mass, COLLISION_MAX_PARTICLES);
const COLLISION_ASLEEP = new Uint8Array(COLLISION_LAYOUT.buffer, COLLISION_LAYOUT.offsets.asleep, COLLISION_MAX_PARTICLES);
// core's pushParticle reuses store slots; clear the stale collision
// asleep flag for a recycled slot (core has no collision dependency).
setParticleSlotReusedHook((i) => { COLLISION_ASLEEP[i] = 0; });
const COLLISION_CELL_START = new Int32Array(COLLISION_LAYOUT.buffer, COLLISION_LAYOUT.offsets.cellStart, COLLISION_MAX_CELLS + 1);
const COLLISION_CELL_ITEMS = new Int32Array(COLLISION_LAYOUT.buffer, COLLISION_LAYOUT.offsets.cellItems, COLLISION_MAX_PARTICLES);
const COLLISION_DPX = new Float32Array(COLLISION_LAYOUT.buffer, COLLISION_LAYOUT.offsets.dpx, COLLISION_MAX_PARTICLES);
const COLLISION_DPY = new Float32Array(COLLISION_LAYOUT.buffer, COLLISION_LAYOUT.offsets.dpy, COLLISION_MAX_PARTICLES);
const COLLISION_DPZ = new Float32Array(COLLISION_LAYOUT.buffer, COLLISION_LAYOUT.offsets.dpz, COLLISION_MAX_PARTICLES);
const COLLISION_DVX = new Float32Array(COLLISION_LAYOUT.buffer, COLLISION_LAYOUT.offsets.dvx, COLLISION_MAX_PARTICLES);
const COLLISION_DVY = new Float32Array(COLLISION_LAYOUT.buffer, COLLISION_LAYOUT.offsets.dvy, COLLISION_MAX_PARTICLES);
const COLLISION_DVZ = new Float32Array(COLLISION_LAYOUT.buffer, COLLISION_LAYOUT.offsets.dvz, COLLISION_MAX_PARTICLES);
// Per-cell counter scratch used during cellItems build. Not shared
// across workers; only the sim worker touches it.
let COLLISION_CELL_COUNTER = new Int32Array(0);
// Cell-placement cursor, hoisted out of resolveCollisions to avoid a
// per-tick alloc (cellCount typically 3-4k, so this is ~13KB of GC
// pressure on every tick under non-trivial particle counts).
let COLLISION_CELL_CURSOR = new Int32Array(0);
export function getCollisionSharedLayout(): CollisionSharedLayout {
  return COLLISION_LAYOUT;
}

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
// K-2: sensor bins widen from 6 slots (per-sensor-chem) to one slot
// per chem id (CHEMICAL_COUNT). Lets the chemo activation pass query
// gradients for any chem id, not just the legacy 6 SENSOR_CHEMS.
// Memory: ~CHEMICAL_COUNT * 3 arrays * SENSOR_BIN_ALLOC * 4 bytes.
// At 96 chems * 300 bins * 12 bytes that's ~350KB, allocated once.
const SENSOR_BIN_COUNT: Int32Array[] = [];   // [chemId][bin]
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
    for (let m = 0; m < CHEMICAL_COUNT; m++) {
      SENSOR_BIN_COUNT.push(new Int32Array(alloc));
      SENSOR_BIN_SUMX.push(new Float32Array(alloc));
      SENSOR_BIN_SUMY.push(new Float32Array(alloc));
    }
    SENSOR_BIN_ALLOC = alloc;
  } else {
    for (let m = 0; m < CHEMICAL_COUNT; m++) {
      SENSOR_BIN_COUNT[m].fill(0, 0, n);
      SENSOR_BIN_SUMX[m].fill(0, 0, n);
      SENSOR_BIN_SUMY[m].fill(0, 0, n);
    }
  }
  const store = world.particleStore;
  const PX = store.x, PY = store.y, PCHEM = store.chemId;
  const np = world.particles.length;
  for (let i = 0; i < np; i++) {
    const chem = PCHEM[i];
    // Bin every particle by its raw chemId. K-5 retires the legacy
    // 6-slot SENSE_GRAD ops; chemoGradient() queries by any chemId.
    const xi = PX[i], yi = PY[i];
    let bx = Math.floor(xi / SENSOR_BIN);
    let by = Math.floor(yi / SENSOR_BIN);
    if (bx < 0) bx = 0; else if (bx >= SENSOR_BIN_COLS) bx = SENSOR_BIN_COLS - 1;
    if (by < 0) by = 0; else if (by >= SENSOR_BIN_ROWS) by = SENSOR_BIN_ROWS - 1;
    const bin = by * SENSOR_BIN_COLS + bx;
    SENSOR_BIN_COUNT[chem][bin]++;
    SENSOR_BIN_SUMX[chem][bin] += xi;
    SENSOR_BIN_SUMY[chem][bin] += yi;
  }
}

// Gradient pull vector toward particles of a given chem within
// sense range, using the same inverse-square weighting as the
// legacy populateSensors GRAD loop. Out is written into the provided
// length-2 array to avoid allocations in the per-cell hot path.
// K-3's activation pass calls this; not yet wired (silences
// noUnusedLocals via export below).
export function chemGradient(cx: number, cy: number, range: number, chemId: number, out: Float32Array): void {
  out[0] = 0; out[1] = 0;
  if (chemId < 0 || chemId >= CHEMICAL_COUNT) return;
  const rangeSq = range * range;
  const span = Math.ceil(range / SENSOR_BIN);
  let cbx = Math.floor(cx / SENSOR_BIN);
  let cby = Math.floor(cy / SENSOR_BIN);
  if (cbx < 0) cbx = 0; else if (cbx >= SENSOR_BIN_COLS) cbx = SENSOR_BIN_COLS - 1;
  if (cby < 0) cby = 0; else if (cby >= SENSOR_BIN_ROWS) cby = SENSOR_BIN_ROWS - 1;
  const x0 = Math.max(0, cbx - span);
  const x1 = Math.min(SENSOR_BIN_COLS - 1, cbx + span);
  const y0 = Math.max(0, cby - span);
  const y1 = Math.min(SENSOR_BIN_ROWS - 1, cby + span);
  const cnt = SENSOR_BIN_COUNT[chemId];
  const sxArr = SENSOR_BIN_SUMX[chemId];
  const syArr = SENSOR_BIN_SUMY[chemId];
  let gx = 0, gy = 0;
  for (let by = y0; by <= y1; by++) {
    const row = by * SENSOR_BIN_COLS;
    for (let bx = x0; bx <= x1; bx++) {
      const bin = row + bx;
      const n = cnt[bin];
      if (n === 0) continue;
      const cxBin = sxArr[bin] / n;
      const cyBin = syArr[bin] / n;
      const dx = cxBin - cx;
      const dy = cyBin - cy;
      const dsq = dx * dx + dy * dy;
      if (dsq >= rangeSq || dsq < 1) continue;
      const w = range / dsq;
      gx += dx * w * n;
      gy += dy * w * n;
    }
  }
  out[0] = gx;
  out[1] = gy;
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

// Per-tick spatial grid of particle refs, mirroring CREATURE_BUCKETS.
// Lets per-entity scans (INGEST, the founder scoop) query only the
// particles near a point instead of walking all of world.particles --
// the old O(cells * particles) pattern. Stores Particle refs; liveness
// is validated at query time via world.particles[p.idx] === p, so a
// swap-pop removal between build and query never surfaces a stale ref
// (the eaten particle's idx no longer maps back to it).
const PARTICLE_GRID_CELL = 32;
const PARTICLE_BUCKETS: Particle[][] = [];
let PARTICLE_NONEMPTY = new Int32Array(0);
let PARTICLE_NONEMPTY_N = 0;
let PARTICLE_GRID_COLS = 0;
let PARTICLE_GRID_ROWS = 0;

function buildParticleGrid(world: World): void {
  const pcs = PARTICLE_GRID_CELL;
  PARTICLE_GRID_COLS = Math.max(1, Math.ceil(world.width / pcs));
  PARTICLE_GRID_ROWS = Math.max(1, Math.ceil(world.height / pcs));
  const cellCount = PARTICLE_GRID_COLS * PARTICLE_GRID_ROWS;
  while (PARTICLE_BUCKETS.length < cellCount) PARTICLE_BUCKETS.push([]);
  if (PARTICLE_NONEMPTY.length < cellCount) PARTICLE_NONEMPTY = new Int32Array(cellCount * 2);
  for (let i = 0; i < PARTICLE_NONEMPTY_N; i++) PARTICLE_BUCKETS[PARTICLE_NONEMPTY[i]].length = 0;
  PARTICLE_NONEMPTY_N = 0;
  const ps = world.particles;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    let bx = Math.floor(p.x / pcs);
    let by = Math.floor(p.y / pcs);
    if (!Number.isFinite(bx)) bx = 0;
    if (!Number.isFinite(by)) by = 0;
    if (bx < 0) bx = 0; else if (bx >= PARTICLE_GRID_COLS) bx = PARTICLE_GRID_COLS - 1;
    if (by < 0) by = 0; else if (by >= PARTICLE_GRID_ROWS) by = PARTICLE_GRID_ROWS - 1;
    const idx = by * PARTICLE_GRID_COLS + bx;
    const bucket = PARTICLE_BUCKETS[idx];
    if (bucket.length === 0) PARTICLE_NONEMPTY[PARTICLE_NONEMPTY_N++] = idx;
    bucket.push(p);
  }
}

// Visit live particles whose bin overlaps the (x, y, range) query.
// Visitor returns true to stop early. Each candidate is liveness-checked
// against world.particles so removals since the grid build are skipped;
// the visitor may itself remove particles (removeParticleAt) safely
// because the bucket arrays are not mutated by removal.
function forParticlesNear(
  world: World, x: number, y: number, range: number,
  visitor: (p: Particle) => boolean | void,
): void {
  if (PARTICLE_GRID_COLS === 0) return;
  const pcs = PARTICLE_GRID_CELL;
  const span = Math.max(1, Math.ceil(range / pcs));
  const cx = Math.max(0, Math.min(PARTICLE_GRID_COLS - 1, Math.floor(x / pcs)));
  const cy = Math.max(0, Math.min(PARTICLE_GRID_ROWS - 1, Math.floor(y / pcs)));
  const x0 = Math.max(0, cx - span);
  const x1 = Math.min(PARTICLE_GRID_COLS - 1, cx + span);
  const y0 = Math.max(0, cy - span);
  const y1 = Math.min(PARTICLE_GRID_ROWS - 1, cy + span);
  const live = world.particles;
  for (let gy = y0; gy <= y1; gy++) {
    const row = gy * PARTICLE_GRID_COLS;
    for (let gx = x0; gx <= x1; gx++) {
      const bucket = PARTICLE_BUCKETS[row + gx];
      for (let k = 0; k < bucket.length; k++) {
        const p = bucket[k];
        if (live[p.idx] !== p) continue; // removed/eaten since the grid build
        if (visitor(p) === true) return;
      }
    }
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

// Dispatcher hook for the parallel collision pass. When set, the sim
// worker delegates each row-parity phase (even rows, then odd rows)
// to a subworker pool that holds views over the same SAB-backed
// particle store + collision grid. Stays null in tests / non-isolated
// contexts; the serial path below runs in that case.
// Fire-only: kicks workers for the given parity, returns a wait fn.
// Callers can run unrelated work (creature collisions, sediment, etc)
// between firing and waiting to hide the barrier latency.
export type CollisionPhaseDispatcher = (cols: number, rows: number, rowParity: 0 | 1, e: number) => () => void;
let collisionPhaseDispatcher: CollisionPhaseDispatcher | null = null;
export function setCollisionPhaseDispatcher(d: CollisionPhaseDispatcher | null): void {
  collisionPhaseDispatcher = d;
}

// Process every cell in rows {rowStart, rowStart+rowStep, ...} on the
// collision grid: resolve pairs within each cell plus pairs against
// the four canonical downstream neighbors (E, SW, S, SE). Reads cell
// membership from cellStart / cellItems built by the sim worker on
// the same buffer. Each row writes to particles in its own row + the
// row below it, so disjoint rows produce disjoint writes (see
// resolveCollisions for the two-phase row-parity coloring).
//
// Worker assignment for phase p with N workers:
//   worker i processes rowStart = p + 2*i, rowStep = 2*N.
// That way every row in the phase is owned by exactly one worker.
export function applyCollisionsRowRange(
  PX: Float32Array, PY: Float32Array, PZ: Float32Array,
  PVX: Float32Array, PVY: Float32Array, PVZ: Float32Array,
  PR: Float32Array,
  DX: Float32Array, DY: Float32Array, DZ: Float32Array,
  DVX: Float32Array, DVY: Float32Array, DVZ: Float32Array,
  MASS: Float32Array, ASLEEP: Uint8Array,
  cellStart: Int32Array, cellItems: Int32Array,
  rowStart: number, rowStep: number,
  cols: number, rows: number,
  e: number,
): void {
  for (let cy = rowStart; cy < rows; cy += rowStep) {
    for (let cx = 0; cx < cols; cx++) {
      const ci = cy * cols + cx;
      const s0 = cellStart[ci];
      const s1 = cellStart[ci + 1];
      if (s1 === s0) continue;
      // Within-cell pairs.
      for (let i = s0; i < s1; i++) {
        const ai = cellItems[i];
        for (let j = i + 1; j < s1; j++) {
          resolvePairSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, DX, DY, DZ, DVX, DVY, DVZ, MASS, ASLEEP, ai, cellItems[j], e);
        }
      }
      // Downstream neighbors: E, SW, S, SE. Pairs with each are
      // resolved exactly once because every cell only iterates its
      // four downstream-of-(cx,cy) neighbors. (Jacobi: which cell
      // enumerates the pair no longer affects the result.)
      checkNeighborCellSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, DX, DY, DZ, DVX, DVY, DVZ, MASS, ASLEEP, cellStart, cellItems,
        ci, cx + 1, cy,     cols, rows, e);
      checkNeighborCellSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, DX, DY, DZ, DVX, DVY, DVZ, MASS, ASLEEP, cellStart, cellItems,
        ci, cx - 1, cy + 1, cols, rows, e);
      checkNeighborCellSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, DX, DY, DZ, DVX, DVY, DVZ, MASS, ASLEEP, cellStart, cellItems,
        ci, cx,     cy + 1, cols, rows, e);
      checkNeighborCellSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, DX, DY, DZ, DVX, DVY, DVZ, MASS, ASLEEP, cellStart, cellItems,
        ci, cx + 1, cy + 1, cols, rows, e);
    }
  }
}

// duringPhase0 and duringPhase1 run concurrently with the worker pool
// during each respective collision-phase barrier (parallel path only).
// In the serial fallback they run after the particle collision pass to
// preserve the original step ordering. Both callbacks must be safe to
// execute alongside particle position/velocity mutations -- only
// creature-vs-creature collisions qualify (touches creature stores
// only). resolveCreatureSedimentCollisions used to be passed here as
// duringPhase1 but it mutates particle SAB columns and so cannot
// safely overlap; it now runs serially in step() after this returns.
function resolveCollisions(
  world: World,
  duringPhase0?: () => void,
  duringPhase1?: () => void,
): void {
  let pendingP0 = duringPhase0;
  let pendingP1 = duringPhase1;
  const store = world.particleStore;
  const n = world.particles.length;
  if (n < 2) {
    if (pendingP0) pendingP0();
    if (pendingP1) pendingP1();
    return;
  }
  const e = world.restitution;
  const cellSize = GRID_CELL_SIZE;
  const cols = Math.max(1, Math.ceil(world.width / cellSize));
  const rows = Math.max(1, Math.ceil(world.height / cellSize));
  const cellCount = cols * rows;
  if (cellCount + 1 > COLLISION_MAX_CELLS + 1) {
    // Shouldn't happen with current world sizes + GRID_CELL_SIZE;
    // signal loudly so we don't silently corrupt collision state.
    throw new Error(`collision grid ${cellCount} cells exceeds COLLISION_MAX_CELLS=${COLLISION_MAX_CELLS}`);
  }
  if (COLLISION_CELL_COUNTER.length < cellCount) {
    COLLISION_CELL_COUNTER = new Int32Array(cellCount * 2);
  }

  const PX = store.x, PY = store.y, PZ = store.z;
  const PVX = store.vx, PVY = store.vy, PVZ = store.vz;
  const PR = store.r, PDENS = store.density, PCHEM = store.chemId;
  const PQUIET = store.quietTicks;
  const chemBase = CHEM_BASE_DENSITY;
  const FOUR_THIRDS_PI = (4 / 3) * Math.PI;
  for (let i = 0; i < n; i++) {
    const r = PR[i];
    const d = PDENS[i] !== 0 ? PDENS[i] : chemBase[PCHEM[i]];
    COLLISION_MASS[i] = d * FOUR_THIRDS_PI * r * r * r;
    const vx = PVX[i], vy = PVY[i], vz = PVZ[i];
    const v2 = vx * vx + vy * vy + vz * vz;
    if (v2 < SLEEP_SPEED_SQ) {
      const q = PQUIET[i] + 1;
      PQUIET[i] = q;
      COLLISION_ASLEEP[i] = q >= SLEEP_THRESHOLD_TICKS ? 1 : 0;
    } else {
      PQUIET[i] = 0;
      COLLISION_ASLEEP[i] = 0;
    }
  }

  for (let pass = 0; pass < world.collisionIters; pass++) {
    // Build cellStart + cellItems. Two-pass: (1) count per cell into
    // cellStart, (2) prefix sum, (3) place each particle using a per-
    // cell counter. cellStart[i+1] - cellStart[i] = count in cell i.
    for (let i = 0; i <= cellCount; i++) COLLISION_CELL_START[i] = 0;
    const cellOfPart = COLLISION_CELL_COUNTER; // reuse as scratch to remember cell-of-particle
    for (let pi = 0; pi < n; pi++) {
      let cx = Math.floor(PX[pi] / cellSize);
      let cy = Math.floor(PY[pi] / cellSize);
      if (cx < 0) cx = 0; else if (cx >= cols) cx = cols - 1;
      if (cy < 0) cy = 0; else if (cy >= rows) cy = rows - 1;
      const ci = cy * cols + cx;
      cellOfPart[pi] = ci;
      COLLISION_CELL_START[ci + 1]++;
    }
    for (let i = 1; i <= cellCount; i++) COLLISION_CELL_START[i] += COLLISION_CELL_START[i - 1];
    // Place particles. cellOfPart is reused here but we no longer
    // need its previous values once we've consumed pi; safe to
    // overwrite as a placement cursor seeded from cellStart.
    if (COLLISION_CELL_CURSOR.length < cellCount) {
      COLLISION_CELL_CURSOR = new Int32Array(cellCount * 2);
    } else {
      COLLISION_CELL_CURSOR.fill(0, 0, cellCount);
    }
    const cursor = COLLISION_CELL_CURSOR;
    for (let pi = 0; pi < n; pi++) {
      const ci = cellOfPart[pi];
      const slot = COLLISION_CELL_START[ci] + cursor[ci]++;
      COLLISION_CELL_ITEMS[slot] = pi;
    }

    // Jacobi: clear the per-particle delta accumulators before the
    // sweep. Workers (or the serial path) only ADD into these reading
    // the frozen PX/PVX snapshot; the summed result is applied once
    // after the sweep, so visitation order can't bias the outcome.
    COLLISION_DPX.fill(0, 0, n);
    COLLISION_DPY.fill(0, 0, n);
    COLLISION_DPZ.fill(0, 0, n);
    COLLISION_DVX.fill(0, 0, n);
    COLLISION_DVY.fill(0, 0, n);
    COLLISION_DVZ.fill(0, 0, n);

    // Cache the dispatcher locally so a barrier-timeout teardown that
    // fires from inside wait0() (e.g. mobile suspends the tab, particle
    // workers stop responding) doesn't null the module-level reference
    // mid-step and crash the second dispatcher call with
    // "Se is not a function". The cached function checks `if (!pool)`
    // at entry and returns a no-op wait fn when the pool is torn down,
    // so we still get through the rest of this iteration cleanly.
    const dispatch = collisionPhaseDispatcher;
    if (dispatch && n >= world.parallelMin) {
      const wait0 = dispatch(cols, rows, 0, e);
      // Run hooks on the first iter only; subsequent iters have no
      // useful work to hide and we want hook side-effects to happen
      // exactly once per step.
      if (pendingP0) { pendingP0(); pendingP0 = undefined; }
      wait0();
      const wait1 = dispatch(cols, rows, 1, e);
      if (pendingP1) { pendingP1(); pendingP1 = undefined; }
      wait1();
    } else {
      // Serial fallback: iterate every row.
      for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
          const ci = cy * cols + cx;
          const s0 = COLLISION_CELL_START[ci];
          const s1 = COLLISION_CELL_START[ci + 1];
          if (s1 === s0) continue;
          for (let i = s0; i < s1; i++) {
            const ai = COLLISION_CELL_ITEMS[i];
            for (let j = i + 1; j < s1; j++) {
              resolvePairSoa(PX, PY, PZ, PVX, PVY, PVZ, PR,
                COLLISION_DPX, COLLISION_DPY, COLLISION_DPZ,
                COLLISION_DVX, COLLISION_DVY, COLLISION_DVZ,
                COLLISION_MASS, COLLISION_ASLEEP, ai, COLLISION_CELL_ITEMS[j], e);
            }
          }
          checkNeighborCellSoa(PX, PY, PZ, PVX, PVY, PVZ, PR,
            COLLISION_DPX, COLLISION_DPY, COLLISION_DPZ, COLLISION_DVX, COLLISION_DVY, COLLISION_DVZ,
            COLLISION_MASS, COLLISION_ASLEEP,
            COLLISION_CELL_START, COLLISION_CELL_ITEMS,
            ci, cx + 1, cy,     cols, rows, e);
          checkNeighborCellSoa(PX, PY, PZ, PVX, PVY, PVZ, PR,
            COLLISION_DPX, COLLISION_DPY, COLLISION_DPZ, COLLISION_DVX, COLLISION_DVY, COLLISION_DVZ,
            COLLISION_MASS, COLLISION_ASLEEP,
            COLLISION_CELL_START, COLLISION_CELL_ITEMS,
            ci, cx - 1, cy + 1, cols, rows, e);
          checkNeighborCellSoa(PX, PY, PZ, PVX, PVY, PVZ, PR,
            COLLISION_DPX, COLLISION_DPY, COLLISION_DPZ, COLLISION_DVX, COLLISION_DVY, COLLISION_DVZ,
            COLLISION_MASS, COLLISION_ASLEEP,
            COLLISION_CELL_START, COLLISION_CELL_ITEMS,
            ci, cx,     cy + 1, cols, rows, e);
          checkNeighborCellSoa(PX, PY, PZ, PVX, PVY, PVZ, PR,
            COLLISION_DPX, COLLISION_DPY, COLLISION_DPZ, COLLISION_DVX, COLLISION_DVY, COLLISION_DVZ,
            COLLISION_MASS, COLLISION_ASLEEP,
            COLLISION_CELL_START, COLLISION_CELL_ITEMS,
            ci, cx + 1, cy + 1, cols, rows, e);
        }
      }
    }
    // Jacobi apply: fold the summed deltas back into the live arrays
    // once, after the whole sweep (both parallel parity phases or the
    // serial pass). Next iteration rebuilds the grid from the updated
    // snapshot -> iterative Jacobi convergence over collisionIters.
    for (let i = 0; i < n; i++) {
      PX[i] += COLLISION_DPX[i]; PY[i] += COLLISION_DPY[i]; PZ[i] += COLLISION_DPZ[i];
      PVX[i] += COLLISION_DVX[i]; PVY[i] += COLLISION_DVY[i]; PVZ[i] += COLLISION_DVZ[i];
    }
  }
  // Serial path falls through with pending hooks. Run them now (after
  // particle collisions are settled, matching the original step order).
  if (pendingP0) pendingP0();
  if (pendingP1) pendingP1();
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

// Mineral particles act as solid terrain: cells can't phase through
// the seafloor. INGEST runs earlier in the tick, so a cell whose
// genome fires INGEST on a mineral at contact still consumes the
// particle before this bounce runs. (Phase D collapse: rock/sand/clay
// are all CHEM_MIN now; the clay-permeable carve-out is gone.)
// Hoisted visitor: forCreaturesNear took a fresh arrow per mineral
// particle (~1900 closure allocations/tick = real GC pressure). One
// reused function reading the current particle from a module slot
// keeps behaviour + iteration order bit-identical with zero allocs.
let SED_P: Particle | null = null;
function sedimentVisit(c: Creature): void {
  const p = SED_P!;
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
}
function resolveCreatureSedimentCollisions(world: World): void {
  const ps = world.particles;
  const cs = world.creatures;
  if (cs.length === 0) return;
  for (let pi = 0; pi < ps.length; pi++) {
    const p = ps[pi];
    if (p.chemId !== CHEM_MIN) continue;
    SED_P = p;
    forCreaturesNear(p.x, p.y, p.r + 30, sedimentVisit);
  }
  SED_P = null;
}

function checkNeighborCellSoa(
  PX: Float32Array, PY: Float32Array, PZ: Float32Array,
  PVX: Float32Array, PVY: Float32Array, PVZ: Float32Array,
  PR: Float32Array,
  DX: Float32Array, DY: Float32Array, DZ: Float32Array,
  DVX: Float32Array, DVY: Float32Array, DVZ: Float32Array,
  MASS: Float32Array, ASLEEP: Uint8Array,
  cellStart: Int32Array, cellItems: Int32Array,
  ci: number, nx: number, ny: number,
  cols: number, rows: number,
  e: number,
): void {
  if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) return;
  const ni = ny * cols + nx;
  const ns0 = cellStart[ni], ns1 = cellStart[ni + 1];
  if (ns1 === ns0) return;
  const s0 = cellStart[ci], s1 = cellStart[ci + 1];
  for (let i = s0; i < s1; i++) {
    const ai = cellItems[i];
    for (let j = ns0; j < ns1; j++) {
      resolvePairSoa(PX, PY, PZ, PVX, PVY, PVZ, PR, DX, DY, DZ, DVX, DVY, DVZ, MASS, ASLEEP, ai, cellItems[j], e);
    }
  }
}

// Jacobi pair resolution: reads the FROZEN PX/PVX snapshot, writes the
// position/velocity correction for BOTH particles into the per-particle
// delta accumulators (DX..DVZ). Never mutates PX/PVX, so the result is
// independent of the order pairs/cells are visited (kills the
// Gauss-Seidel left-to-right directional drift). resolveCollisions
// applies the summed deltas after the sweep.
function resolvePairSoa(
  PX: Float32Array, PY: Float32Array, PZ: Float32Array,
  PVX: Float32Array, PVY: Float32Array, PVZ: Float32Array,
  PR: Float32Array,
  DX: Float32Array, DY: Float32Array, DZ: Float32Array,
  DVX: Float32Array, DVY: Float32Array, DVZ: Float32Array,
  MASS: Float32Array, ASLEEP: Uint8Array,
  i: number, j: number, e: number,
): void {
  if (ASLEEP[i] && ASLEEP[j]) return;
  const ax = PX[i], ay = PY[i], az = PZ[i];
  const bx = PX[j], by = PY[j], bz = PZ[j];
  let dx = bx - ax, dy = by - ay, dz = bz - az;
  const minDist = PR[i] + PR[j];
  const distSq = dx * dx + dy * dy + dz * dz;
  if (distSq >= minDist * minDist) return;
  let dist = Math.sqrt(distSq);
  let nxv = 0, nyv = -1, nzv = 0;
  if (dist < 1e-6) { dx = 1; dy = 0; dz = 0; dist = 1; nxv = 1; nyv = 0; nzv = 0; }
  else { nxv = dx / dist; nyv = dy / dist; nzv = dz / dist; }
  const overlap = minDist - dist;
  const ma = MASS[i];
  const mb = MASS[j];
  const total = ma + mb;
  const corrA = overlap * (mb / total);
  const corrB = overlap * (ma / total);
  DX[i] -= nxv * corrA; DY[i] -= nyv * corrA; DZ[i] -= nzv * corrA;
  DX[j] += nxv * corrB; DY[j] += nyv * corrB; DZ[j] += nzv * corrB;
  const avx = PVX[i], avy = PVY[i], avz = PVZ[i];
  const bvx = PVX[j], bvy = PVY[j], bvz = PVZ[j];
  const rvx = bvx - avx, rvy = bvy - avy, rvz = bvz - avz;
  const vN = rvx * nxv + rvy * nyv + rvz * nzv;
  if (vN >= 0) return;
  const jImp = (-(1 + e) * vN) / (1 / ma + 1 / mb);
  const ix = nxv * jImp, iy = nyv * jImp, iz = nzv * jImp;
  DVX[i] -= ix / ma; DVY[i] -= iy / ma; DVZ[i] -= iz / ma;
  DVX[j] += ix / mb; DVY[j] += iy / mb; DVZ[j] += iz / mb;
}

function applyWalls(world: World): void {
  // One surface-profile LUT for the whole pass: surfaceYAt is ~5
  // sins and we'd otherwise call it for every particle + creature.
  buildSurfaceLUT(world);
  // Gas particles that drift up past the (wavy) water surface escape
  // to the atmosphere. Dump their molecules into world.atmosphere on
  // the way out so the loop is mass-conserving and aeration can later
  // re-introduce them as bubble contents.
  for (let i = world.particles.length - 1; i >= 0; i--) {
    const p = world.particles[i];
    // Gas particles (O2 or CO2 chem) that drift up past the (wavy)
    // water surface escape to the atmosphere.
    const cId = p.chemId;
    if ((cId === CHEM_O2 || cId === CHEM_CO2) && p.y - p.r < surfaceYLUT(p.x)) {
      const pm = p.molecules;
      if (pm) {
        for (const k of MOLECULE_IDS) {
          const v = pm[k];
          if (v > 0) world.atmosphere[k] += v;
        }
      }
      removeParticleAt(world, i);
    }
  }
  const wallEach = (
    o: { x: number; y: number; z: number; vx: number; vy: number; vz: number; r: number },
    xRest: number,
  ): void => {
    if (o.r * 2 >= world.width) {
      o.x = world.width * 0.5; o.vx = 0;
    } else if (o.x < o.r) {
      o.x = o.r; if (o.vx < 0) o.vx = -o.vx * xRest;
    } else if (o.x > world.width - o.r) {
      o.x = world.width - o.r; if (o.vx > 0) o.vx = -o.vx * xRest;
    }
    if (o.r * 2 >= world.height) {
      o.y = world.height * 0.5; o.vy = 0;
    } else {
      if (o.y + o.r > world.height) { o.y = world.height - o.r; if (o.vy > 0) o.vy = 0; }
      // Non-gas objects (creatures, solid particles) clamp at the wavy
      // surface so floating lipids ride the wave instead of poking above
      // the visible water line. Gas escape is handled above.
      const top = surfaceYLUT(o.x) + o.r;
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
  // Particles get a springy side-wall bounce (0.6) so wave-induced
  // horizontal drift can't pack them into a dead band against a wall.
  // Without the old wall-repulsion force sweeping the margin, the soft
  // 0.05 restitution let any particle that reached a wall stick there
  // permanently -- over a long run the slow Stokes drift from the
  // asymmetric two-component wave field migrated most light particles
  // onto one side. A real bounce kicks them back into the water to
  // redistribute. Creatures keep the soft world.xWallRestitution so
  // they don't trampoline off the edges.
  const PARTICLE_X_WALL_RESTITUTION = 0.6;
  for (const p of world.particles) wallEach(p, PARTICLE_X_WALL_RESTITUTION);
  for (const c of world.creatures) wallEach(c, world.xWallRestitution);
}

// ---------------------------------------------------------------------
// Persistence: serialize the live world to a JSON-friendly object and
// restore it. Used by main.ts to auto-save to localStorage every game
// minute so a mobile tab that gets reaped doesn't lose progress.
//
// The schema string bakes in ABI-affecting constants -- bumping any of
// them (CATALYST_COUNT, CHEMICAL_COUNT) invalidates
// older saves automatically. main.ts treats schema mismatch as
// "fresh world", matching the user's preference for hard-reset over
// migration.
//
// What we DON'T save (acceptable cosmetic loss):
//   - pheromone field (re-zeros; cells re-emit)
//   - phylogenyEvents (timeline starts fresh)
//   - per-cell bonds + engulfed `contents` + in-flight `division`
//   - species.execCounts (per-position VM trace, re-accumulates)
// What we DO save: enough to keep the population, terrain, day phase,
// and named/generic chemistry pools intact.
// ---------------------------------------------------------------------

// v10: Path 1 -- ATP is a first-class chemical (CHEM_ATP, named id
// 45); NAMED_CHEMICAL_COUNT 45->46 (so this string changes anyway).
// Bumped 19 -> 20: static rocky terrain (hand-authored polygons) +
// hydrothermal vent are part of every world; the vent's schedule and
// emission ledger are not yet persisted, so reloaded saves restart
// the vent dormant. Old saves without rock terrain would land cells
// inside the new rocks, so we invalidate them via the schema bump.
export const SAVE_SCHEMA = `evosim4:22:${CATALYST_COUNT}:${CHEMICAL_COUNT}:${NAMED_CHEMICAL_COUNT}`;

interface SavedSparse { i: number; v: number }
interface SavedCreature {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  r: number; density: number; energy: number;
  senseRange: number; thrustAccel: number;
  bornAt: number; ingestCooldown: number; repairTicks: number;
  genome: number[];
  vmPc: number; vmStack: number[];
  color: string; speciesKey: string; lineageRoot: number;
  organelleSynthMask: number;
  molecules: Record<string, number>;
  // Sparse: only nonzero entries -- catalystCols is 256 wide, most slots empty.
  catalysts: SavedSparse[];
  inhibitors: SavedSparse[];
  // Sparse: 56 wide for generic chemicals.
  generics: SavedSparse[];
  // Engulfed inner cells (endosymbionts). Recursive: an inner cell can
  // itself carry contents in real biology, so we snapshot the same
  // structure -- though the sim currently only nests one level deep.
  contents?: SavedCreature[];
  // Host-scoped extracellular-DNA buffer (intracellular EGT vector).
  // Absent when the cell holds no buffered fragments (the common case).
  eDnaBuffer?: number[];
  // ADHERE bond partners as indices into the saved.creatures array.
  // Bonds only exist among top-level world.creatures (engulfed cells
  // don't run VM and can't fire ADHERE), so this is a flat index
  // list. Restored in a second pass once every Creature instance
  // exists. Empty when no bonds (most cells).
  bonds?: number[];
}
interface SavedParticle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  r: number; chemId: number;
  density?: number;
  // Optional: persist sleep state so settled sediment doesn't all
  // wake up and bounce on reload (would take SLEEP_THRESHOLD_TICKS
  // sim-ticks to re-settle, looks like a glitch). Older saves
  // without this field default to 0 = wake immediately, which is
  // the previous behavior.
  quietTicks?: number;
  molecules?: Record<string, number>;
  // Sparse: pairs of (slotInGenericRange, value) for nonzero entries.
  // Only present for corpse particles that inherited a cell's
  // accumulated generic-chemical pool.
  generics?: SavedSparse[];
}
interface SavedSpecies {
  key: string; color: string; firstSeen: number; lastSeen: number;
  alive: number; lane: number; vmTicks: number;
  parents: string[];
  genome: number[];
  peakBiomass: number;
}
interface SavedWorld {
  schema: string;
  width: number; height: number; depth: number;
  t: number;
  nextLineageRoot: number;
  extinctionCount: number;
  founderTarget: number;
  dayPhase: number;
  disturbanceIntensity: number;
  disturbanceStartedAt: number;
  disturbanceUntil: number;
  nextDisturbanceAt: number;
  anchorGenome: number[];
  liveCodingKeys: string[];
  // UI-controlled visible particle cap. Persisted so the user's
  // chosen budget survives a browser refresh. Optional: older saves
  // without it keep the current/default target.
  particleTarget?: number;
  parallelMin?: number;
  // Founder generation toggle. Absent (old saves) = enabled.
  foundersEnabled?: boolean;
  // Ongoing resource-replenishment toggle. Absent (old saves) = off.
  ongoingSeeding?: boolean;
  // Reaction / ATP accounting history. Optional: older saves restore
  // with a fresh empty accumulator.
  rxnStats?: SavedRxnStats;
  obstacles: Obstacle[];
  atmosphere?: Partial<Molecules>;
  // Phase F ambient pool. Sparse list of (chemId, concentration);
  // missing entries default to zero on restore.
  ambient?: Array<{ i: number; v: number }>;
  // Phase 4 reserve pool (invisible per-region chem mass). Sparse.
  reserve?: Array<{ i: number; v: number }>;
  species: SavedSpecies[];
  particles: SavedParticle[];
  creatures: SavedCreature[];
  // Free-floating HGT carriers. Absent in older saves -> none restored.
  eDnaCarriers?: SavedEDnaCarrier[];
}
interface SavedEDnaCarrier {
  x: number; y: number; z: number;
  age: number;
  payload: number[];
  srcSpeciesKey: string;
}

function snapshotSparseCol(cols: Float32Array[], i: number, n: number): SavedSparse[] {
  const out: SavedSparse[] = [];
  for (let k = 0; k < n; k++) {
    const v = cols[k][i];
    if (v > 0) out.push({ i: k, v });
  }
  return out;
}

function snapshotCreature(c: Creature): SavedCreature {
  const s = c.store; const i = c.idx;
  const mol: Record<string, number> = {};
  for (const k of MOLECULE_IDS) {
    const v = c.molecules[k];
    if (v !== 0) mol[k] = v;
  }
  return {
    x: s.x[i], y: s.y[i], z: s.z[i],
    vx: s.vx[i], vy: s.vy[i], vz: s.vz[i],
    r: s.r[i], density: s.density[i], energy: s.energy[i],
    senseRange: s.senseRange[i], thrustAccel: s.thrustAccel[i],
    bornAt: s.bornAt[i], ingestCooldown: s.ingestCooldown[i],
    repairTicks: s.repairTicks[i],
    genome: Array.from(c.genome),
    vmPc: c.vm.pc, vmStack: Array.from(c.vm.stack),
    color: c.color, speciesKey: c.speciesKey, lineageRoot: c.lineageRoot,
    organelleSynthMask: c.organelleSynthMask,
    molecules: mol,
    catalysts: snapshotSparseCol(s.catalystCols, i, CATALYST_COUNT),
    inhibitors: snapshotSparseCol(s.inhibitorCols, i, CATALYST_COUNT),
    generics: snapshotSparseCol(s.genericChemCols, i, GENERIC_CHEMICAL_COUNT),
    contents: c.contents.length > 0 ? c.contents.map(snapshotCreature) : undefined,
    eDnaBuffer: c.eDnaBuffer && c.eDnaBuffer.length > 0
      ? Array.from(c.eDnaBuffer) : undefined,
  };
}

function snapshotParticle(p: Particle): SavedParticle {
  const out: SavedParticle = {
    x: p.x, y: p.y, z: p.z,
    vx: p.vx, vy: p.vy, vz: p.vz,
    r: p.r, chemId: p.chemId,
  };
  if (p.density !== undefined) out.density = p.density;
  const q = p.quietTicks ?? 0;
  if (q > 0) out.quietTicks = q;
  if (p.molecules) {
    const m: Record<string, number> = {};
    let any = false;
    for (const k of MOLECULE_IDS) {
      const v = p.molecules[k];
      if (v !== 0) { m[k] = v; any = true; }
    }
    if (any) out.molecules = m;
  }
  if (p.genericChem) {
    const sparse: SavedSparse[] = [];
    for (let k = 0; k < p.genericChem.length; k++) {
      const v = p.genericChem[k];
      if (v > 0) sparse.push({ i: k, v });
    }
    if (sparse.length > 0) out.generics = sparse;
  }
  return out;
}

export function serializeWorld(w: World): string {
  const speciesList: SavedSpecies[] = [];
  for (const s of w.species.values()) {
    speciesList.push({
      key: s.key, color: s.color,
      firstSeen: s.firstSeen, lastSeen: s.lastSeen,
      alive: s.alive, lane: s.lane, vmTicks: s.vmTicks,
      parents: Array.from(s.parents),
      genome: Array.from(s.genome),
      peakBiomass: s.peakBiomass,
    });
  }
  const saved: SavedWorld = {
    schema: SAVE_SCHEMA,
    width: w.width, height: w.height, depth: w.depth,
    t: w.t,
    nextLineageRoot: w.nextLineageRoot,
    extinctionCount: w.extinctionCount,
    founderTarget: w.founderTarget,
    particleTarget: w.particleTarget,
    parallelMin: w.parallelMin,
    foundersEnabled: w.foundersEnabled,
    ongoingSeeding: w.ongoingSeeding,
    rxnStats: w.rxnStats ? serializeRxnStats(w.rxnStats) : undefined,
    dayPhase: w.dayPhase,
    atmosphere: { ...w.atmosphere },
    ambient: (() => {
      const out: Array<{ i: number; v: number }> = [];
      for (let k = 0; k < w.ambient.length; k++) {
        if (w.ambient[k] > 0) out.push({ i: k, v: w.ambient[k] });
      }
      return out;
    })(),
    reserve: (() => {
      const out: Array<{ i: number; v: number }> = [];
      for (let k = 0; k < w.reserve.length; k++) {
        if (w.reserve[k] > 0) out.push({ i: k, v: w.reserve[k] });
      }
      return out;
    })(),
    disturbanceIntensity: w.disturbanceIntensity,
    disturbanceStartedAt: w.disturbanceStartedAt,
    disturbanceUntil: w.disturbanceUntil,
    nextDisturbanceAt: w.nextDisturbanceAt,
    anchorGenome: Array.from(w.anchorGenome),
    liveCodingKeys: Array.from(w.liveCodingKeys),
    obstacles: w.obstacles,
    species: speciesList,
    particles: w.particles.map(snapshotParticle),
    creatures: w.creatures.map(snapshotCreature),
    eDnaCarriers: w.eDnaCarriers.length > 0
      ? w.eDnaCarriers.map((e) => ({
          x: e.x, y: e.y, z: e.z, age: e.age,
          payload: Array.from(e.payload),
          srcSpeciesKey: e.srcSpeciesKey,
        }))
      : undefined,
  };
  // Second pass for bonds: now that every creature has an index in
  // saved.creatures, translate each cell's bond partners into those
  // indices. Cells engulfed in contents[] are skipped (they don't
  // form bonds), and partners that aren't in the top-level
  // creatures array (shouldn't happen but defensive) are dropped.
  const idxByCreature = new Map<Creature, number>();
  for (let i = 0; i < w.creatures.length; i++) idxByCreature.set(w.creatures[i], i);
  for (let i = 0; i < w.creatures.length; i++) {
    const c = w.creatures[i];
    if (c.bonds.length === 0) continue;
    const idxs: number[] = [];
    for (const partner of c.bonds) {
      const pi = idxByCreature.get(partner);
      if (pi !== undefined) idxs.push(pi);
    }
    if (idxs.length > 0) saved.creatures[i].bonds = idxs;
  }
  return JSON.stringify(saved);
}

function restoreCreature(world: World, sc: SavedCreature): Creature {
  const mol = emptyMolecules();
  for (const k of MOLECULE_IDS) {
    const v = sc.molecules[k];
    if (v !== undefined) mol[k] = v;
  }
  const c = newCreature(world.creatureStore, {
    x: sc.x, y: sc.y, z: sc.z,
    vx: sc.vx, vy: sc.vy, vz: sc.vz,
    r: sc.r, density: sc.density, energy: sc.energy,
    senseRange: sc.senseRange, thrustAccel: sc.thrustAccel,
    genome: new Uint8Array(sc.genome),
    vm: newVMState(),
    color: sc.color,
    ingestCooldown: sc.ingestCooldown,
    repairTicks: sc.repairTicks,
    bornAt: sc.bornAt,
    speciesKey: sc.speciesKey,
    molecules: mol,
  });
  c.lineageRoot = sc.lineageRoot;
  c.organelleSynthMask = sc.organelleSynthMask;
  if (sc.eDnaBuffer && sc.eDnaBuffer.length > 0) {
    c.eDnaBuffer = new Uint8Array(sc.eDnaBuffer);
  }
  c.vm.pc = sc.vmPc;
  for (const v of sc.vmStack) c.vm.stack.push(v);
  const s = c.store;
  for (const e of sc.catalysts) s.catalystCols[e.i][c.idx] = e.v;
  if (sc.inhibitors) for (const e of sc.inhibitors) s.inhibitorCols[e.i][c.idx] = e.v;
  for (const e of sc.generics) s.genericChemCols[e.i][c.idx] = e.v;
  // Restore engulfed cells. They get their own creature slot (alloc'd
  // by restoreCreature) but are NOT pushed onto world.creatures --
  // they live in the host's contents[] until the host dies. Same
  // invariant the live engulf path maintains.
  if (sc.contents) {
    for (const sub of sc.contents) {
      const inner = restoreCreature(world, sub);
      c.contents.push(inner);
    }
  }
  return c;
}

// Mutates `world` in place: replaces particles + creatures + species
// + scalar state from the snapshot. Returns true on success, false on
// schema mismatch or malformed JSON (in which case `world` is left
// untouched).
export function applySavedWorld(world: World, json: string): boolean {
  let saved: SavedWorld;
  try {
    saved = JSON.parse(json);
  } catch {
    return false;
  }
  if (!saved || saved.schema !== SAVE_SCHEMA) return false;
  // Drop fresh world state and rebuild from snapshot.
  for (const c of world.creatures) {
    c.store.release(c.idx);
  }
  world.creatures.length = 0;
  while (world.particles.length > 0) removeParticleAt(world, world.particles.length - 1);
  world.fadingGhosts.length = 0;
  world.eDnaCarriers.length = 0;
  // A restored world is already populated -- never re-run the one-shot
  // startup ramp or withhold founders on load.
  world.initialSeedDone = true;
  world.species.clear();
  world.phylogenyEvents.length = 0;
  world.t = saved.t;
  world.nextLineageRoot = saved.nextLineageRoot;
  world.extinctionCount = saved.extinctionCount;
  // Intentionally NOT restoring saved.founderTarget -- we want the
  // current FOUNDER_TARGET constant to win so bumps in code take
  // effect even when restoring from a snapshot taken under an older
  // target. Tests / scripts that set founderTarget at runtime keep
  // doing so via direct mutation after createWorld returns.
  // The visible particle cap IS restored (UI-controlled, must survive
  // a refresh). setParticleTarget keeps particleSpawnRate consistent
  // and clamps to the valid range. Older saves omit it -> keep default.
  if (typeof saved.particleTarget === "number") {
    setParticleTarget(world, saved.particleTarget);
  }
  // Parallel-dispatch threshold: older saves omit it -> keep default.
  if (typeof saved.parallelMin === "number") {
    setParallelMin(world, saved.parallelMin);
  }
  // Absent in older saves -> founders enabled (prior behavior).
  world.foundersEnabled = saved.foundersEnabled !== false;
  // Absent in older saves -> ongoing seeding off (closed system).
  world.ongoingSeeding = saved.ongoingSeeding === true;
  world.rxnStats = saved.rxnStats
    ? deserializeRxnStats(saved.rxnStats)
    : newRxnStats();
  world.dayPhase = saved.dayPhase;
  world.disturbanceIntensity = saved.disturbanceIntensity;
  world.disturbanceStartedAt = saved.disturbanceStartedAt;
  world.disturbanceUntil = saved.disturbanceUntil;
  world.nextDisturbanceAt = saved.nextDisturbanceAt;
  world.anchorGenome = new Uint8Array(saved.anchorGenome);
  world.liveCodingKeys = new Set(saved.liveCodingKeys);
  // Terrain is procedural and deterministic-from-fresh; we don't
  // serialize it. Regenerate from the world dimensions instead of
  // restoring any obstacles the save may have carried. (Per project
  // policy: no save-state compatibility, see CHEMISTRY_OVERHAUL.md.)
  world.obstacles = [];
  generateObstacles(world);
  rebuildObstacleIndex(world);
  if (saved.atmosphere) {
    const atm = world.atmosphere;
    for (const k of MOLECULE_IDS) atm[k] = saved.atmosphere[k] ?? 0;
  }
  if (saved.ambient) {
    const a = world.ambient;
    a.fill(0);
    for (const { i, v } of saved.ambient) {
      if (i >= 0 && i < a.length) a[i] = v;
    }
  }
  {
    const rsv = world.reserve;
    rsv.fill(0);
    if (saved.reserve) {
      for (const { i, v } of saved.reserve) {
        if (i >= 0 && i < rsv.length) rsv[i] = v;
      }
    }
  }
  if (saved.eDnaCarriers) {
    for (const e of saved.eDnaCarriers) {
      world.eDnaCarriers.push({
        x: e.x, y: e.y, z: e.z, age: e.age,
        payload: new Uint8Array(e.payload),
        srcSpeciesKey: e.srcSpeciesKey,
      });
    }
  }
  let maxLane = -1;
  for (const ss of saved.species) {
    if (ss.lane > maxLane) maxLane = ss.lane;
    world.species.set(ss.key, {
      key: ss.key, color: ss.color,
      firstSeen: ss.firstSeen, lastSeen: ss.lastSeen,
      alive: ss.alive, lane: ss.lane, vmTicks: ss.vmTicks,
      parents: new Set(ss.parents),
      genome: new Uint8Array(ss.genome),
      execCounts: new Uint32Array(ss.genome.length),
      peakBiomass: ss.peakBiomass ?? 0,
    });
  }
  world.nextSpeciesLane = maxLane + 1;
  for (const sp of saved.particles) {
    let genericChem: Float32Array | undefined;
    if (sp.generics && sp.generics.length > 0) {
      genericChem = new Float32Array(GENERIC_CHEMICAL_COUNT);
      for (const e of sp.generics) genericChem[e.i] = e.v;
    }
    pushParticle(world, {
      x: sp.x, y: sp.y, z: sp.z,
      vx: sp.vx, vy: sp.vy, vz: sp.vz,
      r: sp.r, chemId: sp.chemId,
      density: sp.density,
      quietTicks: sp.quietTicks,
      molecules: sp.molecules ? { ...emptyMolecules(), ...sp.molecules } : undefined,
      genericChem,
    });
  }
  for (const sc of saved.creatures) {
    const c = restoreCreature(world, sc);
    world.creatures.push(c);
  }
  // Second pass: wire bonds. Each saved.creatures[i].bonds holds the
  // partner indices into the same array, which now corresponds 1:1
  // with world.creatures (we pushed in the same order). Each bond is
  // symmetric, but we record it from both sides so we don't have to
  // worry about ordering -- duplicates checked with includes().
  for (let i = 0; i < saved.creatures.length; i++) {
    const sc = saved.creatures[i];
    if (!sc.bonds || sc.bonds.length === 0) continue;
    const c = world.creatures[i];
    for (const pi of sc.bonds) {
      if (pi < 0 || pi >= world.creatures.length) continue;
      const partner = world.creatures[pi];
      if (partner === c) continue;
      if (!c.bonds.includes(partner)) c.bonds.push(partner);
      if (!partner.bonds.includes(c)) partner.bonds.push(c);
    }
  }
  return true;
}

// ---------------------------------------------------------------------
// Render snapshot. Plain-data subset of the world that the renderer
// needs each frame. Produced on the sim side (in-process today, in a
// worker after stage C), consumed by the UI to draw. Carries no class
// instances or store references -- everything is JSON-/structuredClone-
// transferable so it can cross a worker boundary later.
// ---------------------------------------------------------------------

// A vanishing (reserve-demoted) particle, kept render-side only while
// it fades out. age counts up from 0; the ghost is dropped once it
// reaches RESERVE_FADE_SEC.
// FadingGhost lives in ./sim/core (imported + re-exported at the top).

export interface ParticleSnapshot {
  x: number;
  y: number;
  z: number;
  r: number;
  chemId: number;
  // 0..1 opacity multiplier while a particle fades in (just promoted
  // from reserve) or out (just demoted to reserve). Absent / undefined
  // means fully opaque -- the common case, kept off the wire so the
  // hot render path can skip the per-particle alpha branch.
  fade?: number;
  // Only present when the particle carries a molecule payload (corpse /
  // excretion). The renderer checks the waste fraction to switch to the
  // toxic-tint palette.
  molecules: Molecules | null;
}

// Slim shape used inside a cell's contents[] -- the renderer only needs
// color + radius to draw engulfed prey inside the host body, and the
// tooltip / inspector show counts but not individual fields.
export interface InnerCreatureSnapshot {
  id: number;
  color: string;
  r: number;
  // Engulfed cells can themselves hold engulfed cells (the engine
  // nests arbitrarily). Present only when this inner cell has its own
  // vacuole contents, so the common flat case stays allocation-free.
  contents?: InnerCreatureSnapshot[];
}

export interface CreatureSnapshot {
  id: number;
  x: number;
  y: number;
  z: number;
  r: number;
  vx: number;
  vy: number;
  color: string;
  energy: number;
  ingestCooldown: number;
  bornAt: number;
  lineageRoot: number;
  parentId: number;
  speciesKey: string;
  genome: Uint8Array;
  molecules: Molecules;
  // Generic (non-named) internal chem pool, sparse [chemId, amount]
  // pairs (chemId in NAMED_CHEMICAL_COUNT..CHEMICAL_COUNT-1). Only
  // nonzero slots; most cells hold few generics so this stays tiny.
  genericInternal: [number, number][];
  vmPc: number;
  vmStack: number[];
  bondsCount: number;
  contents: InnerCreatureSnapshot[];
  division: { progress: number; axis: number; childR: number; childColor: string } | null;
}

export interface SpeciesSnapshot {
  key: string;
  color: string;
  firstSeen: number;
  lastSeen: number;
  alive: number;
  lane: number;
  genome: Uint8Array;
  peakBiomass: number;
}

export interface RenderSnapshot extends WorldEnv {
  // World geometry / scalars used by the renderer.
  width: number;
  depth: number;
  particleTarget: number;
  parallelMin: number;
  extinctionCount: number;
  // Lineage roots whose founder is still alive. Main thread uses this
  // to count "lineages that outlived the founder cull": a lineage with
  // live cells whose root isn't in this set has lost its founder and
  // is being carried by descendants only.
  livingFounderLineages: number[];
  // HUD aggregates for engulfed cells (not in world.creatures, so the
  // flat creatures[] / species[] arrays miss them). engulfedCount is
  // every cell living inside any host, counted recursively through
  // nested vacuoles. engulfedOnlySpeciesCount is the number of
  // distinct species that appear ONLY as engulfed members (their
  // speciesKey is on no free/world cell).
  engulfedCount: number;
  engulfedOnlySpeciesCount: number;
  // Static across the run, but we ship it once so the renderer can
  // bake the terrain bitmap on the first snapshot it sees.
  obstacles: Obstacle[];
  particles: ParticleSnapshot[];
  creatures: CreatureSnapshot[];
  species: SpeciesSnapshot[];
  phylogenyEvents: PhylogenyEvent[];
  // Per-chemical global aggregates for the chemistry panel. Indexed by
  // chem id, length CHEMICAL_COUNT. Both are summed over every region
  // and expressed in 2px-particle equivalents (mass / mass-per-2px-
  // particle, the same conversion reservePass uses) so the panel reads
  // in particles alongside the rendered column.
  chemDissolved: Float32Array;
  chemReserveCount: Float32Array;
  // Per-region dissolved / reserve totals in 2px-particle-equivalents
  // (row-major, regionCols x regionRows). For the density overlay.
  ambientPE: Float32Array;
  reservePE: Float32Array;
  // Per-region effective temperature (state-bearing field maintained
  // by sampleRegionTemps). Same row-major (regionCols x regionRows)
  // layout as ambientPE. Used by the heatmap to render the actual
  // local temperature including vent heat + diffusion, not the
  // analytical baseline.
  regionTemp: Float32Array;
  // Density-overlay material filter: the focused chem and its
  // per-region dissolved/reserve PE (present only when one is focused).
  densityChem?: number;
  densityChemAmbPE?: Float32Array;
  densityChemResPE?: Float32Array;
  // Per-reaction lifetime execution counts (indexed by reaction id;
  // see reactionCatalog()). Absent if accounting is disabled.
  reactionTotals?: Int32Array;
  // Mirrors world.foundersEnabled so the UI toggle reflects loaded state.
  foundersEnabled?: boolean;
  // Mirrors world.ongoingSeeding so the UI toggle reflects loaded state.
  ongoingSeeding?: boolean;
  // Windowed reaction history (sparse) for the detail time-graph.
  rxnStatsHistory?: SavedRxnStats;
  // Optional per-phase timing. Mirrors world.profile when present.
  profile?: WorldProfile;
}

function snapshotInner(c: Creature): InnerCreatureSnapshot {
  return c.contents.length > 0
    ? { id: c.id, color: c.color, r: c.r, contents: c.contents.map(snapshotInner) }
    : { id: c.id, color: c.color, r: c.r };
}

function snapshotCreatureLive(c: Creature): CreatureSnapshot {
  return {
    id: c.id,
    x: c.x,
    y: c.y,
    z: c.z,
    r: c.r,
    vx: c.vx,
    vy: c.vy,
    color: c.color,
    energy: c.energy,
    ingestCooldown: c.ingestCooldown,
    bornAt: c.bornAt,
    lineageRoot: c.lineageRoot,
    parentId: c.parentId,
    speciesKey: c.speciesKey,
    genome: c.genome,
    molecules: (() => {
      // Snapshot every named molecule via molCols so the structure
      // grows automatically as new chems are added to the table.
      const out = {} as Molecules;
      const cols = c.store.molCols;
      const i = c.idx;
      const o = out as unknown as Record<string, number>;
      for (let k = 0; k < MOLECULE_IDS.length; k++) o[MOLECULE_IDS[k]] = cols[k][i];
      return out;
    })(),
    genericInternal: (() => {
      const out: [number, number][] = [];
      const cc = c.store.chemCols;
      const i = c.idx;
      for (let g = 0; g < GENERIC_CHEMICAL_COUNT; g++) {
        const chemId = NAMED_CHEMICAL_COUNT + g;
        const v = cc[chemId][i];
        if (v > 0) out.push([chemId, v]);
      }
      return out;
    })(),
    vmPc: c.vm.pc,
    // The renderer reads the stack length and a short preview; a slice
    // is enough and keeps the per-tick clone small.
    vmStack: c.vm.stack.slice(),
    bondsCount: c.bonds.length,
    contents: c.contents.map(snapshotInner),
    division: c.division
      ? {
          progress: c.division.progress,
          axis: c.division.axis,
          childR: c.division.child.r,
          childColor: c.division.child.color,
        }
      : null,
  };
}

function snapshotParticleLive(p: Particle): ParticleSnapshot {
  // p.molecules getter returns undefined when there's no payload; the
  // snapshot uses null for the same reason -- both are structured-
  // clone-friendly, but null is one less code path on the consumer.
  return {
    x: p.x,
    y: p.y,
    z: p.z,
    r: p.r,
    chemId: p.chemId,
    molecules: p.molecules ?? null,
  };
}

function snapshotSpecies(sp: Species): SpeciesSnapshot {
  return {
    key: sp.key,
    color: sp.color,
    firstSeen: sp.firstSeen,
    lastSeen: sp.lastSeen,
    alive: sp.alive,
    lane: sp.lane,
    genome: sp.genome,
    peakBiomass: sp.peakBiomass,
  };
}

// Copy the renderable subset of `world` into a fresh RenderSnapshot.
// Called once per render frame from the sim worker after each tick
// batch. The snapshot owns its own creature / particle / species
// arrays; the originals can be mutated by the next step without
// affecting any rendered frame.
export function takeSnapshot(world: World): RenderSnapshot {
  const creatures: CreatureSnapshot[] = new Array(world.creatures.length);
  for (let i = 0; i < world.creatures.length; i++) {
    creatures[i] = snapshotCreatureLive(world.creatures[i]);
  }
  const particles: ParticleSnapshot[] = new Array(world.particles.length);
  const pAge = world.particleStore.age;
  for (let i = 0; i < world.particles.length; i++) {
    const ps = snapshotParticleLive(world.particles[i]);
    // Fade a freshly spawned/promoted particle in over its first
    // RESERVE_FADE_SEC of life. Older particles stay off the wire's
    // fade field so the renderer keeps them on the fast batched path.
    const age = pAge[i];
    if (age < RESERVE_FADE_SEC) ps.fade = age / RESERVE_FADE_SEC;
    particles[i] = ps;
  }
  // Demote ghosts: render-only, fading out. Appended so the renderer
  // draws them through the same particle path.
  for (const g of world.fadingGhosts) {
    particles.push({
      x: g.x, y: g.y, z: g.z, r: g.r, chemId: g.chemId,
      molecules: null,
      fade: Math.max(0, 1 - g.age / RESERVE_FADE_SEC),
    });
  }
  const species: SpeciesSnapshot[] = [];
  for (const sp of world.species.values()) species.push(snapshotSpecies(sp));
  // Per-chem global aggregates: sum dissolved + reserve across regions.
  const chemDissolved = new Float32Array(CHEMICAL_COUNT);
  const chemReserveCount = new Float32Array(CHEMICAL_COUNT);
  const amb = world.ambient;
  const res = world.reserve;
  const nReg = amb.length / AMBIENT_STRIDE;
  // Per-region dissolved / reserve totals in 2px-particle-equivalents
  // (same scale as rendered particles) so the density overlay can mix
  // all three sources on one footing.
  const ambientPE = new Float32Array(nReg);
  const reservePE = new Float32Array(nReg);
  let densityChemAmbPE: Float32Array | undefined;
  let densityChemResPE: Float32Array | undefined;
  {
    const volPer = (4 / 3) * Math.PI * PRECIP_R * PRECIP_R * PRECIP_R;
    const amountPerArr = new Float32Array(CHEMICAL_COUNT);
    for (let k = 0; k < CHEMICAL_COUNT; k++) {
      const d = CHEM_BASE_DENSITY[k] > 0 ? CHEM_BASE_DENSITY[k] : 1;
      amountPerArr[k] = (d * volPer) / CHEM_MM[k];
    }
    for (let ri = 0; ri < nReg; ri++) {
      const base = ri * AMBIENT_STRIDE;
      let aPE = 0, rPE = 0;
      for (let k = 0; k < CHEMICAL_COUNT; k++) {
        chemDissolved[k] += amb[base + k];
        chemReserveCount[k] += res[base + k];
        const ap = amountPerArr[k];
        if (ap > 0) { aPE += amb[base + k] / ap; rPE += res[base + k] / ap; }
      }
      ambientPE[ri] = aPE;
      reservePE[ri] = rPE;
    }
    // Per-region PE for the UI's focus chem (density overlay material
    // filter). Only when a valid chem is focused -- nReg floats each.
    const fc = world.densityChem;
    if (typeof fc === "number" && fc >= 0 && fc < CHEMICAL_COUNT) {
      const ap = amountPerArr[fc];
      densityChemAmbPE = new Float32Array(nReg);
      densityChemResPE = new Float32Array(nReg);
      if (ap > 0) {
        for (let ri = 0; ri < nReg; ri++) {
          const b = ri * AMBIENT_STRIDE + fc;
          densityChemAmbPE[ri] = amb[b] / ap;
          densityChemResPE[ri] = res[b] / ap;
        }
      }
    }
    // Express BOTH dissolved and reserve as 2px-particle equivalents
    // (mass / mass-per-2px-particle) so the panel reads in particles,
    // consistent with the rendered column.
    for (let k = 0; k < CHEMICAL_COUNT; k++) {
      const density = CHEM_BASE_DENSITY[k] > 0 ? CHEM_BASE_DENSITY[k] : 1;
      // dissolved/reserve are AMOUNT; one 2px particle == amountPer moles.
      const amountPer = (density * volPer) / CHEM_MM[k];
      if (amountPer > 0) {
        chemDissolved[k] /= amountPer;
        chemReserveCount[k] /= amountPer;
      } else {
        chemDissolved[k] = 0;
        chemReserveCount[k] = 0;
      }
    }
  }
  // Engulfed-cell aggregates for the HUD. Computed here on the live
  // Creature graph because snapshots flatten inner cells (no
  // speciesKey / nested contents on InnerCreatureSnapshot).
  let engulfedCount = 0;
  const freeSpeciesKeys = new Set<string>();
  const engulfedSpeciesKeys = new Set<string>();
  for (const c of world.creatures) freeSpeciesKeys.add(c.speciesKey);
  const walkInner = (cell: Creature): void => {
    for (const inner of cell.contents) {
      engulfedCount++;
      engulfedSpeciesKeys.add(inner.speciesKey);
      walkInner(inner);
    }
  };
  for (const c of world.creatures) walkInner(c);
  let engulfedOnlySpeciesCount = 0;
  for (const k of engulfedSpeciesKeys) {
    if (!freeSpeciesKeys.has(k)) engulfedOnlySpeciesCount++;
  }
  return {
    width: world.width,
    height: world.height,
    depth: world.depth,
    t: world.t,
    surfaceY: world.surfaceY,
    surfaceWaveAmp: world.surfaceWaveAmp,
    surfaceLength: world.surfaceLength,
    surfacePeriod: world.surfacePeriod,
    swellLength: world.swellLength,
    swellPeriod: world.swellPeriod,
    updraftLength: world.updraftLength,
    updraftPeriod: world.updraftPeriod,
    disturbanceIntensity: world.disturbanceIntensity,
    tempSurface: world.tempSurface,
    tempBottom: world.tempBottom,
    tempPatchAmp: world.tempPatchAmp,
    tempPatchLength: world.tempPatchLength,
    tempPatchPeriod: world.tempPatchPeriod,
    dayPhase: world.dayPhase,
    wind: world.wind,
    windExposureFromLeft: world.windExposureFromLeft,
    windExposureFromRight: world.windExposureFromRight,
    waveOriginFromLeft: world.waveOriginFromLeft,
    waveOriginFromRight: world.waveOriginFromRight,
    vent: world.vent ? { ...world.vent } : undefined,
    particleTarget: world.particleTarget,
    parallelMin: world.parallelMin,
    extinctionCount: world.extinctionCount,
    engulfedCount,
    engulfedOnlySpeciesCount,
    // Lineage roots that still have a founder cell alive. Computed by
    // walking creatures: a creature whose id is in world.founderIds
    // contributes its lineageRoot. Set -> array for structured-clone.
    livingFounderLineages: (() => {
      const roots: number[] = [];
      const seen = new Set<number>();
      for (const c of world.creatures) {
        if (world.founderIds.has(c.id) && !seen.has(c.lineageRoot)) {
          seen.add(c.lineageRoot);
          roots.push(c.lineageRoot);
        }
      }
      return roots;
    })(),
    obstacles: world.obstacles,
    particles,
    creatures,
    species,
    phylogenyEvents: world.phylogenyEvents.slice(),
    chemDissolved,
    chemReserveCount,
    ambientPE,
    reservePE,
    regionTemp: world.regionTemp.slice(),
    densityChem: world.densityChem,
    densityChemAmbPE,
    densityChemResPE,
    reactionTotals: world.rxnStats ? reactionTotals(world) : undefined,
    rxnStatsHistory: world.rxnStats ? serializeRxnStats(world.rxnStats) : undefined,
    foundersEnabled: world.foundersEnabled !== false,
    ongoingSeeding: world.ongoingSeeding === true,
    profile: world.profile,
  };
}
