//! Hydrothermal vent. Substrate port of `src/sim/vent.ts`.
//!
//! A point feature embedded in the seafloor rock that erupts on a slow
//! schedule, emitting hot particles upward (high vy) and raising local
//! water temperature while active. The vent is a TRUE SOURCE in the
//! mass ledger -- emitted mass is recorded via the particle store, not
//! drawn from any pool, so it doesn't conserve world mass in the
//! `mass::report` sense. (TS tracks a `world.ventEmitted` ledger and
//! subtracts it from totals; we keep the cycle / emission but skip the
//! ledger until a generic-molecules pool lands.)
//!
//! Schedule (sim seconds):
//!   - Dormant for ~2 in-game days ± jitter between eruptions.
//!   - Warmup (intensity 0 -> 1) over `WARMUP_SEC`.
//!   - Main phase (intensity = 1) for `MAIN_SEC`.
//!   - Cooldown (intensity 1 -> 0) over `COOLDOWN_SEC`.
//!
//! Total active window is ~13 sim seconds.
//!
//! Materials: weighted draws from `EMISSIONS` (heavy minerals / CO2 /
//! waste dominant; abiogenic precursors AA / FA / GLU rare; MARKER0
//! rarest). One chem per particle.
//!
//! What's NOT here (kept honest):
//!   - global-saturation gate (TS blocks emissions when any vent chem
//!     hits >= 10% of total dissolved capacity) -- we don't yet have a
//!     per-chem capacity accumulator wired in
//!   - generic-molecules content tag on particles (`Molecules` map)
//!     -- our particle SoA only carries a single chem_id
//!   - vent fuel seep (a continuous bounded reduced-fuel cocktail
//!     standing pool around the vent mouth) -- belongs in chemolith
//!     and depends on the generic chems table

use crate::chem_ids::{
    CHEM_AA, CHEM_BIOPOLYMER, CHEM_CO2, CHEM_FA, CHEM_GLU, CHEM_MARKER0, CHEM_MEMBRANE, CHEM_MIN,
    CHEM_O2, CHEM_WASTE,
};
use crate::particles::{ParticleInit, ParticleStore};
use crate::rng::Mulberry32;
use serde::{Deserialize, Serialize};

/// Schedule constants. Two game days at `day_period_s=600` = 1200
/// sim seconds between eruptions; small symmetric jitter so the
/// rhythm is recognizable but not perfectly clockwork.
pub const VENT_CYCLE_DAYS: f64 = 2.0;
const VENT_CYCLE_JITTER_FRAC: f64 = 0.15;
const VENT_WARMUP_SEC: f64 = 2.0;
const VENT_MAIN_SEC: f64 = 8.0;
const VENT_COOLDOWN_SEC: f64 = 3.0;

/// Active-window total. Pre-computed so the phase machine stays
/// simple: every transition reads this once.
const VENT_ACTIVE_WINDOW: f64 = VENT_WARMUP_SEC + VENT_MAIN_SEC + VENT_COOLDOWN_SEC;

/// Emission cadence while active.
const VENT_EMIT_PERIOD: f64 = 0.10;
/// Expected particles per emission batch at peak intensity. Scales
/// by intensity^2 so warmup/cooldown shed dramatically fewer than the
/// main phase; the rare-puff design (BATCH_AT_PEAK << 1) keeps the
/// vent from dominating long-run mass.
const VENT_BATCH_AT_PEAK: f32 = 0.0004;

/// Upward emission velocity. Particles get a strong vy < 0 (UP in
/// y-down coords) + lateral / depth spread; gravity + buoyancy take
/// over once they clear the rock mouth.
const VENT_EXIT_SPEED: f32 = 90.0;
const VENT_LATERAL_SPREAD: f32 = 35.0;

/// Spatial temperature contribution: a Gaussian bubble of `VENT_TEMP_PEAK`
/// degrees inside `VENT_TEMP_RADIUS`. `vent_heat_at` reads these.
pub const VENT_TEMP_PEAK: f32 = 40.0;
pub const VENT_TEMP_RADIUS: f32 = 90.0;

/// Eruption material spec.
#[derive(Debug, Clone, Copy)]
struct EmitSpec {
    chem_id: usize,
    weight: f32,
    /// Density for the emitted particle. Vent precipitates are dense
    /// (sulfides, metal salts -> heavy minerals); organics ride on
    /// buoyancy from the upward velocity rather than density alone.
    density: f32,
}

const EMISSIONS: [EmitSpec; 10] = [
    // Common vent chemistry.
    EmitSpec { chem_id: CHEM_MIN, weight: 7.0, density: 1.8 },
    EmitSpec { chem_id: CHEM_CO2, weight: 5.0, density: 0.6 },
    EmitSpec { chem_id: CHEM_WASTE, weight: 3.0, density: 1.1 },
    // Slightly less common: dissolved O2 cycled through hot rock.
    EmitSpec { chem_id: CHEM_O2, weight: 1.5, density: 0.4 },
    // Rare: abiogenic precursors -- vents are a leading origin-of-life
    // candidate. Low weights so these read as a real find in the wild.
    EmitSpec { chem_id: CHEM_AA, weight: 1.0, density: 1.0 },
    EmitSpec { chem_id: CHEM_FA, weight: 1.0, density: 0.9 },
    EmitSpec { chem_id: CHEM_GLU, weight: 0.7, density: 1.0 },
    EmitSpec { chem_id: CHEM_BIOPOLYMER, weight: 0.6, density: 1.0 },
    EmitSpec { chem_id: CHEM_MEMBRANE, weight: 0.4, density: 0.95 },
    // Very rare: marker chemistry -- gives evolution a sniffable
    // tracer that only originates at the vent.
    EmitSpec { chem_id: CHEM_MARKER0, weight: 0.2, density: 1.0 },
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VentState {
    pub x: f32,
    pub y: f32,
    pub next_eruption_at: f64,
    pub eruption_ends_at: f64,
    pub intensity: f32,
    pub active: bool,
    pub emit_clock: f64,
}

impl VentState {
    /// Construct an initial vent state. First eruption is scheduled one
    /// dormant span out so a fresh world is quiet at t=0.
    pub fn new(x: f32, y: f32, day_period_s: f64, rng: &mut Mulberry32) -> Self {
        Self {
            x,
            y,
            next_eruption_at: next_dormant_span(day_period_s, rng),
            eruption_ends_at: 0.0,
            intensity: 0.0,
            active: false,
            emit_clock: 0.0,
        }
    }
}

/// Next dormant span (sim seconds) given the world's `day_period_s`.
/// One RNG draw for jitter; determinism preserved.
pub fn next_dormant_span(day_period_s: f64, rng: &mut Mulberry32) -> f64 {
    let base = VENT_CYCLE_DAYS * day_period_s;
    let jitter = (rng.next_f64() - 0.5) * 2.0 * VENT_CYCLE_JITTER_FRAC * base;
    base + jitter
}

/// Pick an emission spec by weight. Linear scan over a 10-entry table.
fn pick_emission(rng: &mut Mulberry32) -> EmitSpec {
    let total: f32 = EMISSIONS.iter().map(|s| s.weight).sum();
    let roll = rng.next_f64() as f32 * total;
    let mut acc = 0.0_f32;
    for s in &EMISSIONS {
        acc += s.weight;
        if roll < acc {
            return *s;
        }
    }
    *EMISSIONS.last().expect("EMISSIONS is non-empty")
}

/// Tick the vent: advance the phase machine, set intensity, emit
/// particles into `particles`. `t` is the world's sim seconds.
pub fn step_vent(
    vent: &mut VentState,
    particles: &mut ParticleStore,
    t: f64,
    dt: f64,
    day_period_s: f64,
    rng: &mut Mulberry32,
) {
    // Phase transitions.
    if !vent.active && t >= vent.next_eruption_at {
        vent.active = true;
        vent.eruption_ends_at = t + VENT_ACTIVE_WINDOW;
        vent.emit_clock = 0.0;
    }
    if vent.active && t >= vent.eruption_ends_at {
        vent.active = false;
        vent.intensity = 0.0;
        vent.next_eruption_at = t + next_dormant_span(day_period_s, rng);
        return;
    }
    if !vent.active {
        return;
    }
    // Intensity envelope across the active window.
    let into = (t - (vent.eruption_ends_at - VENT_ACTIVE_WINDOW)) as f32;
    let warmup = VENT_WARMUP_SEC as f32;
    let main = VENT_MAIN_SEC as f32;
    let cooldown = VENT_COOLDOWN_SEC as f32;
    vent.intensity = if into < warmup {
        into / warmup
    } else if into < warmup + main {
        1.0
    } else {
        (1.0 - (into - warmup - main) / cooldown).max(0.0)
    };
    // Emit batches.
    vent.emit_clock += dt;
    while vent.emit_clock >= VENT_EMIT_PERIOD {
        vent.emit_clock -= VENT_EMIT_PERIOD;
        let ramp = vent.intensity * vent.intensity;
        let expected = VENT_BATCH_AT_PEAK * ramp + rng.next_f64() as f32;
        let n = expected.floor().max(0.0) as usize;
        for _ in 0..n {
            let spec = pick_emission(rng);
            let r = 1.0 + rng.next_f64() as f32 * 1.2;
            let sx = vent.x + (rng.next_f64() as f32 - 0.5) * VENT_LATERAL_SPREAD;
            // Spawn slightly above the vent mouth so particles enter
            // the water column rather than overlapping rock.
            let sy = vent.y - 8.0 - rng.next_f64() as f32 * 6.0;
            let vy = -VENT_EXIT_SPEED * (0.6 + 0.4 * rng.next_f64() as f32);
            let vx = (rng.next_f64() as f32 - 0.5) * 30.0;
            particles.push(ParticleInit {
                x: sx,
                y: sy,
                vx,
                vy,
                r,
                chem_id: spec.chem_id as u8,
                density: spec.density,
                ..ParticleInit::default()
            });
        }
    }
}

/// Local temperature contribution: Gaussian bubble around the vent
/// that decays with distance. Returns 0 outside ~3 radii so most
/// lookups exit fast.
pub fn vent_heat_at(vent: &VentState, x: f32, y: f32) -> f32 {
    if !vent.active {
        return 0.0;
    }
    let dx = x - vent.x;
    let dy = y - vent.y;
    let d2 = dx * dx + dy * dy;
    let r2 = VENT_TEMP_RADIUS * VENT_TEMP_RADIUS;
    if d2 > 9.0 * r2 {
        return 0.0;
    }
    VENT_TEMP_PEAK * vent.intensity * (-d2 / r2).exp()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dormant_at_t_zero() {
        let mut rng = Mulberry32::new(1);
        let v = VentState::new(100.0, 200.0, 600.0, &mut rng);
        assert!(!v.active);
        // First eruption scheduled at t > 0, roughly one dormant span out.
        assert!(v.next_eruption_at > 0.0);
        assert!(v.next_eruption_at < VENT_CYCLE_DAYS * 600.0 * 2.0);
    }

    #[test]
    fn vent_activates_at_scheduled_time() {
        let mut rng = Mulberry32::new(1);
        let mut v = VentState::new(100.0, 200.0, 600.0, &mut rng);
        let mut ps = ParticleStore::new();
        // Step forward to just past the scheduled eruption.
        let dt = 0.1_f64;
        let mut t = 0.0_f64;
        while t < v.next_eruption_at + 0.5 {
            step_vent(&mut v, &mut ps, t, dt, 600.0, &mut rng);
            t += dt;
        }
        assert!(v.active);
    }

    #[test]
    fn vent_intensity_ramps() {
        let mut rng = Mulberry32::new(1);
        let mut v = VentState::new(100.0, 200.0, 600.0, &mut rng);
        let mut ps = ParticleStore::new();
        // Force the vent active by setting next_eruption_at to 0.
        v.next_eruption_at = 0.0;
        let dt = 0.1;
        // Step in for one warmup second: intensity should be partial.
        step_vent(&mut v, &mut ps, 0.0, dt, 600.0, &mut rng);
        step_vent(&mut v, &mut ps, 1.0, dt, 600.0, &mut rng);
        assert!(v.active);
        assert!(v.intensity > 0.0 && v.intensity <= 1.0);
        // Mid-main: intensity should be 1.
        step_vent(
            &mut v,
            &mut ps,
            VENT_WARMUP_SEC + VENT_MAIN_SEC * 0.5,
            dt,
            600.0,
            &mut rng,
        );
        assert_eq!(v.intensity, 1.0);
    }

    #[test]
    fn vent_heat_decays_with_distance() {
        let mut rng = Mulberry32::new(1);
        let mut v = VentState::new(100.0, 200.0, 600.0, &mut rng);
        v.active = true;
        v.intensity = 1.0;
        let at_vent = vent_heat_at(&v, 100.0, 200.0);
        let nearby = vent_heat_at(&v, 130.0, 200.0);
        let far = vent_heat_at(&v, 500.0, 200.0);
        assert!(at_vent > nearby);
        assert!(nearby > far);
        assert_eq!(far, 0.0, "far outside radius -> 0");
    }

    #[test]
    fn inactive_vent_emits_no_heat() {
        let mut rng = Mulberry32::new(1);
        let v = VentState::new(100.0, 200.0, 600.0, &mut rng);
        assert_eq!(vent_heat_at(&v, 100.0, 200.0), 0.0);
    }
}
