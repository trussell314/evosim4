// Environment dynamics: the per-tick state machines that advance the
// world's time-of-day and weather. Where ./environment holds the pure
// analytical baselines (sampled, never mutated), this module owns the
// mutable scalars those baselines read -- dayPhase and wind -- and steps
// them forward each tick. RNG is threaded in as a parameter (the
// canonical per-world simRng) so this module stays free of module-level
// random state, matching stepVent's convention.

import type { World } from "./core";
import { WIND_MAX } from "./environment";

export function advanceDayCycle(world: World, dt: number): void {
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
export function advanceWind(world: World, dt: number, rng: () => number): void {
  const t = world.t;
  // 1. Disturbance event scheduler (re-used as the gust trigger).
  if (world.disturbanceUntil > 0 && t >= world.disturbanceUntil) {
    world.disturbanceUntil = 0;
    world.disturbanceIntensity = 0;
  }
  if (world.disturbanceUntil === 0 && t >= world.nextDisturbanceAt) {
    const duration = 8 + rng() * 10;
    world.disturbanceStartedAt = t;
    world.disturbanceUntil = t + duration;
    world.nextDisturbanceAt = world.disturbanceUntil + 60 + rng() * 1140;
    // Lock in a gust direction + magnitude for the whole event.
    const sign = rng() < 0.5 ? -1 : 1;
    const mag = WIND_GUST_MAG_MIN + rng() * (WIND_GUST_MAG_MAX - WIND_GUST_MAG_MIN);
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
      world.windTarget = (rng() * 2 - 1) * WIND_DRIFT_RANGE;
    }
  }
  // Exponential approach: wind += (target - wind) * (1 - exp(-dt/tau)).
  // For small dt the linearization dt/tau is accurate enough and
  // cheaper than a Math.exp per tick.
  const alpha = Math.min(1, dt / WIND_RELAX_TAU);
  world.wind += (world.windTarget - world.wind) * alpha;
}
