//! Food / material replenishment. Without this pass the ecosystem
//! is closed: cells eat particles and excrete waste, dissolve drains
//! the residual into the ambient field, denature converts waste back
//! into CO2 -- but no new physical food enters the world. The
//! starting cohort runs the cap down and the population collapses
//! within a few minutes of sim time. The user observed exactly this:
//! 78 cells -> 21 over a 5-minute headless run.
//!
//! Port-level simplification: TS uses a per-spawn-spec weighted
//! roster + reserve fallback + atmosphere accounting. We just keep
//! the world topped up to a target particle count with a small
//! basket of food chems, picked weighted by `SPAWN_WEIGHTS`. Mass
//! injected via this pass is bounded by the per-tick spawn rate.

use crate::chem_ids::{CHEM_ADP, CHEM_BIOPOLYMER, CHEM_FA, CHEM_GLU, CHEM_MIN};
use crate::chemistry::table as chem_table;
use crate::particles::{ParticleInit, ParticleStore};
use crate::rng::Mulberry32;
use crate::world::World;

/// Pairs of (chem_id, weight). Sample with cumulative weighted roll;
/// the weights are the spawn frequency the TS demo uses with a few
/// reductions for things we don't have UI for yet (GENERIC_SPAWN_*).
const SPAWN_WEIGHTS: &[(usize, f32)] = &[
    (CHEM_BIOPOLYMER, 4.5),
    (CHEM_MIN, 4.0),
    (CHEM_FA, 6.0),
    (CHEM_GLU, 6.0),
    (CHEM_ADP, 2.0),
];

/// Fraction of `particle_cap` we aim to keep populated. 0.7 leaves
/// headroom for excrete / aerate spawns and avoids saturating the
/// renderer.
const PARTICLE_TARGET_FRACTION: f32 = 0.7;
/// Spawn budget per sim second when the world is empty. Modulated by
/// the gap between current count and target so we don't slam the
/// particle store back to target in one tick.
const SPAWN_RATE_PER_SEC: f32 = 25.0;
/// Don't replenish during the warmup window -- gives the chemistry
/// pipeline a beat to find equilibrium first, and lets the
/// mass-conservation invariant in `common_sense.rs` ignore the
/// inject-from-atmosphere step. Matches the TS
/// `WATER_FILL_DELAY_SEC` of 30s.
const WATER_FILL_DELAY_S: f64 = 30.0;

/// Spawn food particles until either the budget for this tick runs
/// out or we hit `target` count. Returns the number actually spawned.
pub fn run_replenish(world: &mut World, dt: f32) -> usize {
    if world.t < WATER_FILL_DELAY_S {
        return 0;
    }
    if dt <= 0.0 {
        return 0;
    }
    let cap = world.particle_cap.unwrap_or(usize::MAX);
    if cap == 0 {
        return 0;
    }
    let target = ((cap as f32) * PARTICLE_TARGET_FRACTION) as usize;
    let cur = world.particle_store.len();
    if cur >= target {
        return 0;
    }
    let gap = target - cur;
    let expected = SPAWN_RATE_PER_SEC * dt;
    // Round to nearest int, biased by the rng so the schedule stays
    // smooth at small dt (matches TS).
    let mut want = expected.floor() as usize;
    let frac = expected - want as f32;
    if (world.sim_rng.next_f64() as f32) < frac {
        want += 1;
    }
    let to_spawn = want.min(gap).min(cap.saturating_sub(cur));
    if to_spawn == 0 {
        return 0;
    }
    let total_weight: f32 = SPAWN_WEIGHTS.iter().map(|(_, w)| *w).sum();
    let mut spawned = 0;
    for _ in 0..to_spawn {
        // Pick a chem by weighted roll.
        let mut pick = world.sim_rng.next_f64() as f32 * total_weight;
        let mut chosen = CHEM_GLU;
        for (chem, w) in SPAWN_WEIGHTS {
            pick -= *w;
            if pick <= 0.0 {
                chosen = *chem;
                break;
            }
        }
        let r = spawn_radius(&mut world.sim_rng, chosen);
        let density = spawn_density(chosen);
        let x = world.sim_rng.next_f64() as f32 * world.width;
        // Dense chems sink so just spawn them at the surface; light
        // chems also fine starting at the surface (they're food bobbing
        // in). Below surface_y by r so the gas-escape pass doesn't
        // pop them on tick 0.
        let y_top = world.surface_y + r;
        let y_bot = (world.height - r).max(y_top + 1.0);
        let y = y_top + world.sim_rng.next_f64() as f32 * (y_bot - y_top);
        world.particle_store.push(ParticleInit {
            x,
            y,
            r,
            chem_id: chosen as u8,
            density,
            ..ParticleInit::default()
        });
        spawned += 1;
    }
    spawned
}

fn spawn_radius(rng: &mut Mulberry32, chem: usize) -> f32 {
    // Visible-but-not-massive radii: small for food, slightly bigger
    // for minerals so they're recognisable as sediment.
    let base = match chem {
        c if c == CHEM_MIN => 3.0,
        _ => 2.0,
    };
    base + (rng.next_f64() as f32) * 1.5
}

fn spawn_density(chem: usize) -> f32 {
    let table = chem_table();
    if chem < table.base_density.len() {
        table.base_density[chem]
    } else {
        1.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replenishes_below_target() {
        let mut w = World::new(800.0, 600.0, 1);
        w.particle_cap = Some(100);
        w.surface_y = 200.0;
        w.t = 60.0;
        let before = w.particle_store.len();
        let spawned = run_replenish(&mut w, 1.0);
        assert!(spawned > 0, "below target should spawn");
        assert_eq!(w.particle_store.len(), before + spawned);
    }

    #[test]
    fn does_not_overshoot_cap() {
        let mut w = World::new(800.0, 600.0, 1);
        w.particle_cap = Some(40);
        w.surface_y = 200.0;
        w.t = 60.0;
        // Hammer the spawn for many ticks; should saturate at target.
        for _ in 0..600 {
            run_replenish(&mut w, 1.0 / 60.0);
        }
        let target = (40.0 * PARTICLE_TARGET_FRACTION) as usize;
        assert!(
            w.particle_store.len() <= target + 1,
            "expected <={target}, got {}",
            w.particle_store.len(),
        );
    }

    #[test]
    fn waits_for_water_fill_delay() {
        let mut w = World::new(800.0, 600.0, 1);
        w.particle_cap = Some(100);
        w.surface_y = 200.0;
        w.t = 5.0; // before WATER_FILL_DELAY_S (30s)
        let spawned = run_replenish(&mut w, 1.0);
        assert_eq!(spawned, 0);
    }

    #[test]
    fn cap_zero_disables_spawn() {
        let mut w = World::new(800.0, 600.0, 1);
        w.particle_cap = Some(0);
        w.surface_y = 200.0;
        w.t = 10.0;
        let spawned = run_replenish(&mut w, 1.0);
        assert_eq!(spawned, 0);
    }
}
