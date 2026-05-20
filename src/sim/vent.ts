// Hydrothermal vent: a point feature embedded in the seafloor rock
// that erupts on a slow schedule, emitting hot particles upward and
// raising the local temperature while active. The vent is a *true
// source* in the mass ledger -- emitted mass is recorded on
// world.ventEmitted so worldMass() can still close.
//
// Schedule (sim seconds, world.dayPeriod defaults to 90):
//   - Dormant for ~2 in-game days +/- jitter between eruptions.
//   - Warmup (intensity 0 -> 1) over WARMUP_SEC.
//   - Main phase (intensity = 1) for MAIN_SEC.
//   - Cooldown (intensity 1 -> 0) over COOLDOWN_SEC.
// Total eruption visible window is ~12-15 sim seconds.
//
// Materials: 8-10 chems, weighted common-vs-rare. Selection draws
// once per emitted particle from a cumulative-weight table.

import type { World, VentState } from "./core";
import type { Molecules } from "./chem-ids";
import {
  MOLECULE_INDEX, MOLECULE_IDS, emptyMolecules,
  CHEM_CO2, CHEM_MIN, CHEM_WASTE, CHEM_AA, CHEM_FA, CHEM_GLU,
  CHEM_O2, CHEM_BIOPOLYMER, CHEM_MEMBRANE, CHEM_MARKER0,
} from "./chem-ids";

// Schedule constants. Two game days at dayPeriod=90 = 180 sim seconds
// between eruptions; small symmetric jitter so the rhythm is
// recognizable but not perfectly clockwork.
export const VENT_CYCLE_DAYS = 2;
const VENT_CYCLE_JITTER_FRAC = 0.15; // +/-15% on the dormant span
const VENT_WARMUP_SEC = 2.0;
const VENT_MAIN_SEC = 8.0;
const VENT_COOLDOWN_SEC = 3.0;

// Emission cadence while active: one batch per EMIT_PERIOD sim seconds.
const VENT_EMIT_PERIOD = 0.10;
// Expected particles per emission batch at intensity=1. Scales by
// intensity^2 so warmup/cooldown shed dramatically fewer particles
// than the peak. Fractional values << 1 are handled by floor(rate + rng):
// most batches emit 0 particles, occasional batches emit 1, long-run
// average is the rate. Dialed down 1000x further (4 -> 0.04 -> 0.0004):
// the vent is now a rare-puff feature instead of a continuous plume,
// since heavier output dominated the ledger in long runs.
const VENT_BATCH_AT_PEAK = 0.0004;

// Upward emission velocity. Particles get a strong vy < 0 (UP in y-down
// coords) plus lateral spread; gravity + buoyancy take over once they
// clear the rock mouth.
const VENT_EXIT_SPEED = 90;
const VENT_LATERAL_SPREAD = 35;
const VENT_DEPTH_SPREAD = 6;

// Temperature contribution. Active vent raises local water temperature
// by up to VENT_TEMP_PEAK degrees inside a soft Gaussian bubble of
// radius VENT_TEMP_RADIUS. temperatureAt in sim.ts reads ventHeatAt.
export const VENT_TEMP_PEAK = 40;
export const VENT_TEMP_RADIUS = 90;

// Eruption material spec: chemId + weight. Common (mineral / CO2 /
// waste) dominate; rare (amino acids, fatty acids, glucose, marker0)
// are present but sparse so they're a real event when emitted. Total
// weight is open-ended; selection normalizes on the fly.
interface EmitSpec {
  chemId: number;
  weight: number;
  // Density for the emitted particle. Vent precipitates are dense
  // (sulfides, metal salts -> heavy minerals); organics ride on
  // buoyancy from the upward velocity rather than density alone.
  density: number;
  // Mass per emitted particle. Sets the granularity of the ledger;
  // 1 unit per particle keeps it simple and proportional to count.
  unitMass: number;
}

const VENT_EMISSIONS: EmitSpec[] = [
  // Common: classic vent chemistry. Hot sulfide-rich brine carrying
  // dissolved CO2 and precipitating mineral grains.
  { chemId: CHEM_MIN, weight: 7.0, density: 1.8, unitMass: 1 },
  { chemId: CHEM_CO2, weight: 5.0, density: 0.6, unitMass: 1 },
  { chemId: CHEM_WASTE, weight: 3.0, density: 1.1, unitMass: 1 },
  // Slightly less common: dissolved O2 (residual from photochemistry
  // higher up in the column getting recycled through hot rock).
  { chemId: CHEM_O2, weight: 1.5, density: 0.4, unitMass: 1 },
  // Rare: abiogenic precursors. Hydrothermal vents are a leading
  // theory for the origin of organic chemistry; emit these at low
  // weight so they read as a real find when they appear in the wild.
  { chemId: CHEM_AA, weight: 1.0, density: 1.0, unitMass: 1 },
  { chemId: CHEM_FA, weight: 1.0, density: 0.9, unitMass: 1 },
  { chemId: CHEM_GLU, weight: 0.7, density: 1.0, unitMass: 1 },
  { chemId: CHEM_BIOPOLYMER, weight: 0.6, density: 1.0, unitMass: 1 },
  { chemId: CHEM_MEMBRANE, weight: 0.4, density: 0.95, unitMass: 1 },
  // Very rare: exotic marker chemistry -- gives evolution a sniffable
  // tracer chemical that only originates near the vent.
  { chemId: CHEM_MARKER0, weight: 0.2, density: 1.0, unitMass: 1 },
];

// Pre-resolved chemId -> molecule-index map for ledger updates. Built
// once at module load so the emission hot path is one array lookup.
const VENT_EMIT_MOL_IDX: number[] = (() => {
  const idx: number[] = [];
  // chem-ids.ts NAMED_CHEMICALS layout matches chemId == named slot id.
  // The molecule index for each name is in MOLECULE_INDEX.
  const CHEM_TO_KEY: Record<number, keyof Molecules> = {
    [CHEM_MIN]: "minerals",
    [CHEM_CO2]: "co2",
    [CHEM_WASTE]: "waste",
    [CHEM_O2]: "o2",
    [CHEM_AA]: "aminoAcid",
    [CHEM_FA]: "fattyAcid",
    [CHEM_GLU]: "glucose",
    [CHEM_BIOPOLYMER]: "biopolymer",
    [CHEM_MEMBRANE]: "membrane",
    [CHEM_MARKER0]: "marker0",
  };
  for (const spec of VENT_EMISSIONS) {
    idx.push(MOLECULE_INDEX[CHEM_TO_KEY[spec.chemId]]);
  }
  return idx;
})();

const VENT_TOTAL_WEIGHT = VENT_EMISSIONS.reduce((a, s) => a + s.weight, 0);

// Compute the next dormant span (sim seconds) given the world's
// dayPeriod. Pulls one rng draw for jitter, so determinism is preserved.
export function nextVentDormantSpan(dayPeriod: number, rng: () => number): number {
  const base = VENT_CYCLE_DAYS * dayPeriod;
  const jitter = (rng() - 0.5) * 2 * VENT_CYCLE_JITTER_FRAC * base;
  return base + jitter;
}

// Construct an initial vent state. First eruption is scheduled one
// dormant span out so a fresh world is quiet at t=0.
export function makeVentState(x: number, y: number, dayPeriod: number, rng: () => number): VentState {
  return {
    x, y,
    nextEruptionAt: nextVentDormantSpan(dayPeriod, rng),
    eruptionEndsAt: 0,
    intensity: 0,
    active: false,
    emitClock: 0,
  };
}

// Pick an emission spec by weight. Walks the cumulative table; with
// only ~10 entries the linear scan is fast and keeps the ledger
// alignment trivial.
function pickEmission(rng: () => number): { spec: EmitSpec; molIdx: number } {
  const roll = rng() * VENT_TOTAL_WEIGHT;
  let acc = 0;
  for (let i = 0; i < VENT_EMISSIONS.length; i++) {
    acc += VENT_EMISSIONS[i].weight;
    if (roll < acc) return { spec: VENT_EMISSIONS[i], molIdx: VENT_EMIT_MOL_IDX[i] };
  }
  const i = VENT_EMISSIONS.length - 1;
  return { spec: VENT_EMISSIONS[i], molIdx: VENT_EMIT_MOL_IDX[i] };
}

// Tick the vent: advance the phase machine, set intensity, emit
// particles if appropriate. spawn() is the engine's pushParticle
// adapter (kept abstract so this module doesn't import sim.ts).
export function stepVent(
  world: World,
  dt: number,
  rng: () => number,
  spawn: (
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    r: number, chemId: number, density: number,
    molecules: Molecules,
  ) => void,
): void {
  const v = world.vent;
  if (!v) return;
  const ledger = world.ventEmitted;
  const t = world.t;

  // After the seed-ramp window closes the world is meant to be a
  // closed substrate; the vent's role was to seed abiotic chemistry +
  // localized heat during the initial fill. Permanently dormant from
  // here on: any in-progress eruption ends, no new ones scheduled.
  if (world.initialSeedDone) {
    if (v.active) {
      v.active = false;
      v.intensity = 0;
    }
    return;
  }

  // Phase transitions.
  if (!v.active && t >= v.nextEruptionAt) {
    v.active = true;
    v.eruptionEndsAt = t + VENT_WARMUP_SEC + VENT_MAIN_SEC + VENT_COOLDOWN_SEC;
    v.emitClock = 0;
  }
  if (v.active && t >= v.eruptionEndsAt) {
    v.active = false;
    v.intensity = 0;
    v.nextEruptionAt = t + nextVentDormantSpan(world.dayPeriod, rng);
    return;
  }
  if (!v.active) return;

  // Intensity envelope across the active window.
  const into = t - (v.eruptionEndsAt - (VENT_WARMUP_SEC + VENT_MAIN_SEC + VENT_COOLDOWN_SEC));
  if (into < VENT_WARMUP_SEC) {
    v.intensity = into / VENT_WARMUP_SEC;
  } else if (into < VENT_WARMUP_SEC + VENT_MAIN_SEC) {
    v.intensity = 1;
  } else {
    const c = into - VENT_WARMUP_SEC - VENT_MAIN_SEC;
    v.intensity = Math.max(0, 1 - c / VENT_COOLDOWN_SEC);
  }

  // Emit one batch per VENT_EMIT_PERIOD while active. intensity^2 keeps
  // the ramp visually punchy -- the main phase pours, warmup/cooldown
  // dribble.
  v.emitClock += dt;
  while (v.emitClock >= VENT_EMIT_PERIOD) {
    v.emitClock -= VENT_EMIT_PERIOD;
    const ramp = v.intensity * v.intensity;
    const n = Math.max(0, Math.floor(VENT_BATCH_AT_PEAK * ramp + rng()));
    for (let i = 0; i < n; i++) {
      const { spec, molIdx } = pickEmission(rng);
      const r = 1 + rng() * 1.2;
      // Spawn slightly above the vent mouth so particles enter the
      // water column rather than overlapping the rock. lateralSpread
      // gives the plume a visible width.
      const sx = v.x + (rng() - 0.5) * VENT_LATERAL_SPREAD;
      const sy = v.y - 8 - rng() * 6;
      const sz = world.depth * 0.5 + (rng() - 0.5) * VENT_DEPTH_SPREAD;
      const vy = -VENT_EXIT_SPEED * (0.6 + 0.4 * rng());
      const vx = (rng() - 0.5) * 30;
      const vz = (rng() - 0.5) * 18;
      // Tag the particle with its molecular content so dissolution +
      // ingestion paths credit the right pool. unitMass is per-particle
      // so the ledger bookkeeping is just += unitMass.
      const mols = emptyMolecules();
      const key = MOLECULE_IDS[molIdx];
      mols[key] = spec.unitMass;
      spawn(sx, sy, sz, vx, vy, vz, r, spec.chemId, spec.density, mols);
      if (ledger) ledger[molIdx] += spec.unitMass;
    }
  }
}

// Spatial temperature contribution: a soft Gaussian bubble around the
// vent that decays with distance. Reads cleanly when added to the
// baseline temperatureAt in sim.ts. Returns 0 outside ~3*radius so
// most lookups exit fast.
export function ventHeatAt(world: World, x: number, y: number): number {
  const v = world.vent;
  if (!v || !v.active) return 0;
  const dx = x - v.x;
  const dy = y - v.y;
  const d2 = dx * dx + dy * dy;
  const r2 = VENT_TEMP_RADIUS * VENT_TEMP_RADIUS;
  if (d2 > 9 * r2) return 0;
  // Gaussian: exp(-d^2 / r^2). Peak at vent, falloff to ~0.05 at 3r.
  const g = Math.exp(-d2 / r2);
  return VENT_TEMP_PEAK * v.intensity * g;
}
