//! Founder immigration -- continuous, diversity-gated. Ports the TS
//! engine's "capped founder trickle": every `interval_s` sim-seconds,
//! if the number of distinct coding genomes alive is below
//! `target_species`, spawn enough random founders to refill the
//! deficit (bounded by `max_per_event`).
//!
//! Why this matters: viable lineages in this engine are slow to
//! reproduce, so a closed world bleeds diversity and eventually
//! collapses to a handful of non-reproducing survivors before the
//! extinction-reseed (which only fires at ~zero population) ever
//! triggers. Immigration is the standard island-biogeography answer:
//! a steady influx of new lineages balances the extinction drip so
//! the world stays populated and diverse WITHOUT hand-tuning every
//! reaction rate. Selection still does its job -- immigrants that
//! can't metabolise die just as fast as before; the ones that can
//! take hold.
//!
//! This is engine-level (runs inside `step`), so headless, server,
//! and any future client all get the same behaviour. The older
//! `auto_reseed_if_extinct` (server-task-driven, full-cohort, fires
//! only at zero) stays as the catastrophe backstop.

use crate::creatures::CreatureStore;
use crate::founders::seed_random_founders;
use crate::genome::coding_key;
use crate::rng::Mulberry32;
use crate::terrain::Obstacle;
use std::collections::HashSet;

/// Immigration state + tunables. Owned by the engine.
#[derive(Debug, Clone)]
pub struct Immigration {
    pub enabled: bool,
    /// Seconds between immigration checks.
    pub interval_s: f64,
    /// Distinct-coding-genome count we try to keep the world at or
    /// above. When live diversity drops below this, the deficit is
    /// spawned (bounded by `max_per_event`).
    pub target_species: usize,
    /// Hard ceiling on founders spawned per event so a freshly-reset
    /// empty world ramps in over a few intervals instead of dumping a
    /// huge cohort in one tick.
    pub max_per_event: usize,
    /// Don't immigrate once the live population is at or above this --
    /// a thriving world shouldn't get diluted by tourists.
    pub population_ceiling: usize,
    pub last_run_at: f64,
}

impl Default for Immigration {
    fn default() -> Self {
        Self {
            enabled: true,
            // Check several times a sim-minute.
            interval_s: 10.0,
            // Keep at least this many distinct lineages around. Set a
            // little above the founder strategy count (9) so mutation
            // drift always has a diverse standing pool to act on.
            target_species: 14,
            // Ramp, don't dump.
            max_per_event: 8,
            // Above this live count, stop immigrating -- the world is
            // doing fine on its own.
            population_ceiling: 120,
            last_run_at: 0.0,
        }
    }
}

/// Run the immigration check. Returns the number of founders spawned
/// this call (0 when throttled, disabled, or diversity is healthy).
#[allow(clippy::too_many_arguments)]
pub fn run_immigration(
    imm: &mut Immigration,
    store: &mut CreatureStore,
    rng: &mut Mulberry32,
    width: f32,
    height: f32,
    surface_y: f32,
    obstacles: &[Obstacle],
    t: f64,
) -> usize {
    if !imm.enabled {
        return 0;
    }
    if t - imm.last_run_at < imm.interval_s {
        return 0;
    }
    imm.last_run_at = t;
    if store.n >= imm.population_ceiling {
        return 0;
    }
    // Count distinct coding genomes among the living.
    let mut distinct: HashSet<String> = HashSet::new();
    for g in &store.genome {
        distinct.insert(coding_key(g));
    }
    let have = distinct.len();
    if have >= imm.target_species {
        return 0;
    }
    let deficit = (imm.target_species - have).min(imm.max_per_event);
    if deficit == 0 {
        return 0;
    }
    seed_random_founders(store, rng, width, height, surface_y, deficit, obstacles)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::World;

    fn empty_world() -> World {
        let mut w = World::new(1600.0, 1200.0, 1);
        // Clear any demo-seeded creatures so the test starts blank.
        w.creature_store.clear();
        w
    }

    #[test]
    fn refills_toward_target_when_below() {
        let mut w = empty_world();
        let mut imm = Immigration::default();
        let obstacles = w.obstacles.clone();
        let spawned = run_immigration(
            &mut imm,
            &mut w.creature_store,
            &mut w.sim_rng,
            w.width,
            w.height,
            w.surface_y,
            &obstacles,
            100.0,
        );
        // Empty world -> deficit == target, clamped to max_per_event.
        assert_eq!(spawned, imm.max_per_event);
        assert_eq!(w.creature_store.n, imm.max_per_event);
    }

    #[test]
    fn throttled_within_interval() {
        let mut w = empty_world();
        let mut imm = Immigration::default();
        let obstacles = w.obstacles.clone();
        run_immigration(
            &mut imm, &mut w.creature_store, &mut w.sim_rng,
            w.width, w.height, w.surface_y, &obstacles, 100.0,
        );
        let before = w.creature_store.n;
        // Second call 5s later (< interval=15) must be a no-op.
        let spawned = run_immigration(
            &mut imm, &mut w.creature_store, &mut w.sim_rng,
            w.width, w.height, w.surface_y, &obstacles, 105.0,
        );
        assert_eq!(spawned, 0);
        assert_eq!(w.creature_store.n, before);
    }

    #[test]
    fn no_immigration_above_ceiling() {
        let mut w = empty_world();
        let mut imm = Immigration {
            population_ceiling: 3,
            ..Default::default()
        };
        let obstacles = w.obstacles.clone();
        // Seed 4 cells so we're above the ceiling.
        crate::founders::seed_random_founders(
            &mut w.creature_store, &mut w.sim_rng,
            w.width, w.height, w.surface_y, 4, &obstacles,
        );
        let before = w.creature_store.n;
        let spawned = run_immigration(
            &mut imm, &mut w.creature_store, &mut w.sim_rng,
            w.width, w.height, w.surface_y, &obstacles, 200.0,
        );
        assert_eq!(spawned, 0);
        assert_eq!(w.creature_store.n, before);
    }

    #[test]
    fn disabled_is_noop() {
        let mut w = empty_world();
        let mut imm = Immigration { enabled: false, ..Default::default() };
        let obstacles = w.obstacles.clone();
        let spawned = run_immigration(
            &mut imm, &mut w.creature_store, &mut w.sim_rng,
            w.width, w.height, w.surface_y, &obstacles, 100.0,
        );
        assert_eq!(spawned, 0);
    }
}
