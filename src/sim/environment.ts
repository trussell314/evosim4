// Ambient environment field helpers: the analytical world envelope that
// cells and the renderer sample but never own. These are pure functions
// of a world's static config + the per-tick scalars on WorldEnv (time,
// wind, day phase); they hold no mutable state and draw no RNG, so they
// are safe to share between the sim step, the snapshot, and rendering.
//
// What lives here vs. sim.ts: the *analytical baselines* and pure
// lookups (surface profile, baseline temperature, solar/occlusion light,
// baseline geomagnetic field) live here. The *stateful* layers that
// integrate or advance these baselines stay in sim.ts -- the surface
// LUT cache, the diffused regionTemp field (regionTempAt), the day-cycle
// and wind state machines (advanceDayCycle / advanceWind), and the
// magnetite-gradient coupling.

import type { VentState } from "./core";

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
  // Per-column wave-amplitude multiplier (>=1) that ramps up over the
  // windward apron of a surface-breaching rock -- shoaling, so the wave
  // visibly steepens as it nears the rock and then breaks (the rock face
  // is glassy via exposure 0). Direction-paired; also drives the foam
  // accent in the renderer (where the boost is largest = the rock face).
  shoalFromLeft?: Float32Array;
  shoalFromRight?: Float32Array;
  // Optional vent state. WorldEnv is the narrow slice that helpers
  // like temperatureAt see; vents contribute heat through this so the
  // helper doesn't need a full World.
  vent?: VentState;
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

// Windward-apron amplitude multiplier (>=1): the wave shoals (piles up)
// as it approaches a surface-breaching rock. Drives both the steepening
// surface and the renderer's foam accent.
export function shoalAt(world: WorldEnv, x: number): number {
  const map = world.wind >= 0 ? world.shoalFromLeft : world.shoalFromRight;
  if (!map || map.length === 0) return 1;
  const ix = Math.max(0, Math.min(map.length - 1, Math.floor(x)));
  return map[ix];
}

export function surfaceYAt(world: WorldEnv, x: number): number {
  const t = world.t;
  // Amplitude derives from wind magnitude and per-column shelter.
  // Floor at 0 -- a sheltered column with calm wind is glassy.
  const windFactor = Math.min(1, Math.abs(world.wind) / WIND_MAX);
  const expo = windExposureAt(world, x);
  const A = world.surfaceWaveAmp * windFactor * expo * shoalAt(world, x);
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

// Photosynthesis depth attenuation: ambient light = exp(-y / LIGHT_DECAY).
// Surface = 1.0, e-folds every LIGHT_DECAY pixels of depth.
export const LIGHT_DECAY = 250;

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

// Solar light multiplier 0..1. Sin curve over dayPhase with midday at
// phase 0.25; dark half of cycle returns 0. Multiplied into the depth
// attenuation at every light-using site (photosynthesis, sensor).
export function solarLight(world: { dayPhase: number }): number {
  return Math.max(0, Math.sin(2 * Math.PI * world.dayPhase));
}

// The sun travels a daytime arc: it rises at 5% of world width (dayPhase 0),
// climbs overhead at midday (dayPhase 0.25), and sets at 95% (dayPhase 0.5).
// Night (dayPhase >= 0.5) carries no light. sunXFrac is the horizontal
// position [0..1]; sunShadowSlope is the resulting shadow offset (world px
// per px of depth): 0 at midday (sun overhead -> vertical shadows), large
// and signed near rise/set (low sun -> long shadows cast away from it).
const SUN_SHADOW_SLOPE = 1.5;
export function sunXFrac(dayPhase: number): number {
  let f = dayPhase / 0.5; if (f < 0) f = 0; else if (f > 1) f = 1;
  return 0.05 + 0.90 * f;
}
export function sunShadowSlope(dayPhase: number): number {
  return SUN_SHADOW_SLOPE * (sunXFrac(dayPhase) - 0.5);
}

// Rock occlusion of sunlight. Light comes from above and rock blocks the
// direct beam, but water scatters light into shadows, so the edge is a
// soft penumbra rather than a hard step (the old binary 0/1 looked like
// cut-out cardboard). Three terms make it diffuse realistically:
//   - vertical penumbra: light fades over LIGHT_PENUMBRA_PX around the
//     rock rim instead of switching instantly (a smoothstep on depth
//     below the rim).
//   - horizontal softening: the rim is sampled across a small window
//     whose half-width grows with depth (a deeper point sees a wider,
//     softer edge -- its occluding rim is farther up), so adjacent
//     columns stop producing hard vertical stripes.
//   - LIGHT_SHADOW_FLOOR: a little scattered skylight reaches shadows,
//     so they're dim rather than pure black. Combined with the depth
//     decay in ambientLightAt, deep caves still go effectively dark.
const LIGHT_SHADOW_FLOOR = 0.1;
const LIGHT_PENUMBRA_PX = 20;
// Tap count for the horizontal scatter window (odd; centered on x).
const LIGHT_TAPS = 9;
const LIGHT_TAP_HALF = (LIGHT_TAPS - 1) / 2;
export function lightOcclusion(
  env: { dayPhase?: number; terrainHeightmap?: ArrayLike<number> }, x: number, y: number,
): number {
  const hm = env.terrainHeightmap;
  if (!hm || hm.length === 0) return 1;
  const n = hm.length;
  // Scatter half-width widens with depth below the surface: deeper water
  // has scattered more light sideways, so shadows soften and bleed wider.
  let spread = y * 0.09; if (spread < 5) spread = 5; else if (spread > 60) spread = 60;
  const stepPx = spread / LIGHT_TAP_HALF;
  // Directional shadow: as the sun moves off overhead the occluding rim is
  // sampled at a horizontal offset proportional to depth, so rock shadows
  // sweep across the floor over the day (0 at midday). Missing dayPhase ->
  // overhead (vertical), preserving old behaviour for callers that omit it.
  const shadowShift = sunShadowSlope(env.dayPhase ?? 0.25) * y;
  let lit = 0;
  for (let t = -LIGHT_TAP_HALF; t <= LIGHT_TAP_HALF; t++) {
    let ix = Math.round(x + shadowShift + t * stepPx);
    if (ix < 0) ix = 0; else if (ix >= n) ix = n - 1;
    const rim = hm[ix]; // +Infinity where no rock -> fully lit tap
    // smoothstep over [rim - P, rim + P]: 0 (lit) above the rim, 1
    // (shadow) below it, soft in between. Infinity rim -> stays lit.
    let s = (y - (rim - LIGHT_PENUMBRA_PX)) / (2 * LIGHT_PENUMBRA_PX);
    if (s < 0) s = 0; else if (s > 1) s = 1;
    s = s * s * (3 - 2 * s);
    lit += 1 - s;
  }
  lit /= LIGHT_TAPS; // average of the scatter taps
  return LIGHT_SHADOW_FLOOR + (1 - LIGHT_SHADOW_FLOOR) * lit;
}
// Visible ambient light at a point: solar day-cycle x depth attenuation
// x rock occlusion. Single source of truth shared by photosynthesis and
// the light overlay.
export function ambientLightAt(
  env: { dayPhase: number; terrainHeightmap?: ArrayLike<number> }, x: number, y: number,
): number {
  return solarLight(env) * Math.exp(-y / LIGHT_DECAY) * lightOcclusion(env, x, y);
}

// Geomagnetic MAP. Baseline points "up" (-Y = north). Two positional
// gradients make it a map rather than a bare compass:
//  - declination: the heading tilts in +X as you move across the world
//    (MAG_DECLINATION * (x/width - 0.5)), so direction encodes x-position.
//  - intensity: the field strengthens with depth (1 + MAG_DEPTH_GAIN *
//    y/height), so |act_mag| encodes depth.
// A cell with a magnetoreceptor can thus hold a heading, read its depth,
// and (with the tilt) get a coarse x fix -- the substrate for homing /
// vertical migration / long-range navigation.
const MAG_BASE_X = 0;
const MAG_BASE_Y = -1;
const MAG_DECLINATION = 0.6;
const MAG_DEPTH_GAIN = 1.0;
// Base geomagnetic field as a pure function of world dimensions + position
// (no dynamic state), so the renderer can sample it for the magnetic-field
// overlay without a World. magFieldAt delegates here; the magnetite
// gradient coupling is layered on separately in the activation loop.
export function magFieldBaseAt(width: number, height: number, x: number, y: number, out: Float32Array): void {
  const w = width > 0 ? width : 1;
  const h = height > 0 ? height : 1;
  const intensity = 1 + MAG_DEPTH_GAIN * (y / h);
  out[0] = (MAG_BASE_X + MAG_DECLINATION * (x / w - 0.5)) * intensity;
  out[1] = MAG_BASE_Y * intensity;
}
