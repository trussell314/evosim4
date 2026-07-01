//! Sterile-cell auto-cull. Cells whose VM never fires REPRODUCE
//! within a time window are marked unviable so the death pass clears
//! them on the next tick. Without this, lineages that never reproduce
//! never die either -- the population freezes at whatever the founders
//! plus a few sweeps produced and the demo looks like a museum.
//!
//! Two knobs (both in sim-seconds):
//!   - `interval_s`: how often to run the scan. Cheap (one pass over
//!     creatures), but no point doing it every tick when the
//!     thresholds are minutes apart.
//!   - `sterile_age_s`: a cell whose last REPRODUCE attempt was
//!     >= this many sim-seconds ago is sterile.
//!
//! Founders get a grace window equal to `sterile_age_s` from the
//! `born_at` stamp so cells with no chance to even try REPRODUCE
//! yet aren't penalised.
//!
//! Determinism: no RNG; the cull is a pure function of state.

use crate::chem_ids::CHEM_MEMBRANE;
use crate::creatures::CreatureStore;

/// Carries the cull's state and tunables. Owned by the engine; the
/// scan reads from it and bumps `last_run_at`.
#[derive(Debug, Clone)]
pub struct SterileCull {
    pub enabled: bool,
    /// Seconds between cull scans.
    pub interval_s: f64,
    /// Seconds without a REPRODUCE fire before a cell is sterile.
    pub sterile_age_s: f64,
    /// Below this live-population count, cull is skipped entirely.
    /// Protects a struggling ecosystem from getting ground out by
    /// a fertile-but-slow lineage.
    pub min_population: usize,
    /// Max cells to cull per scan. Smooths out the population curve
    /// so we don't kill the entire roster the same tick.
    pub max_per_scan: usize,
    /// Sim time of the most recent scan; used for the `interval_s`
    /// throttle.
    pub last_run_at: f64,
}

impl Default for SterileCull {
    fn default() -> Self {
        Self {
            enabled: true,
            // 30 sim-seconds between scans.
            interval_s: 30.0,
            // A cell that hasn't fired REPRODUCE in 10 sim-minutes is
            // probably never going to. TS uses 26 display-hours;
            // ours runs orders of magnitude faster so this is the
            // equivalent fraction of a sweep.
            sterile_age_s: 600.0,
            // Floor below which we don't cull -- the demo recovers
            // population via auto_reseed_if_extinct, not via cull
            // pressure. Killing the last 8 cells just to clear them
            // would just trigger an immediate reseed.
            min_population: 16,
            // Smooth the death curve: even with hundreds of sterile
            // cells, only retire ~20 per scan.
            max_per_scan: 20,
            last_run_at: 0.0,
        }
    }
}

/// Run the cull if its interval has elapsed. Returns the count of
/// cells marked unviable this scan.
pub fn maybe_cull_sterile(
    cull: &mut SterileCull,
    store: &mut CreatureStore,
    t: f64,
) -> usize {
    if !cull.enabled {
        return 0;
    }
    if t - cull.last_run_at < cull.interval_s {
        return 0;
    }
    cull.last_run_at = t;
    if store.n <= cull.min_population {
        // Don't cull while the population is at or below the protect
        // floor. Recovery is auto_reseed's job.
        return 0;
    }
    let mut hits = 0usize;
    for i in 0..store.n {
        if hits >= cull.max_per_scan {
            break;
        }
        // Founders get a born_at-based grace window before they can
        // be counted sterile. Without it, every freshly-spawned cell
        // is < sterile_age_s old and would never be tagged anyway,
        // but the math is the same either way.
        if t - store.born_at[i] < cull.sterile_age_s {
            continue;
        }
        let last_fire = store.last_reproduce_fire_t[i];
        if t - last_fire < cull.sterile_age_s {
            continue;
        }
        // Already dead (membrane <= 0) -- skip; the death pass will
        // clean this up regardless.
        if store.chems[CHEM_MEMBRANE][i] <= 0.0 {
            continue;
        }
        // Mark unviable. The death pass uses CHEM_MEMBRANE <= 0 as
        // the canonical "dead" predicate; we zero it here so the same
        // pass handles cleanup.
        store.chems[CHEM_MEMBRANE][i] = 0.0;
        hits += 1;
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::NAMED_CHEMICAL_COUNT;
    use crate::creatures::CreatureInit;

    fn cell_at(t_born: f64, _last_fire: f64) -> CreatureInit {
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[CHEM_MEMBRANE] = 5.0;
        CreatureInit {
            x: 100.0,
            y: 100.0,
            r: 8.0,
            born_at: t_born,
            chems: Some(chems),
            ..CreatureInit::default()
        }
    }

    /// Build a `min_population + extra` cohort of cells whose
    /// last-reproduce timestamp is at t=0, so the scan can hit them.
    fn populated_store(n: usize) -> CreatureStore {
        let mut store = CreatureStore::new();
        for _ in 0..n {
            let i = store.push(cell_at(0.0, 0.0));
            store.last_reproduce_fire_t[i] = 0.0;
        }
        store
    }

    #[test]
    fn culls_old_sterile_cells_above_floor() {
        let mut cull = SterileCull::default();
        let n = cull.min_population + 5;
        let mut store = populated_store(n);
        // 700s elapsed -> past sterile_age_s = 600. interval gate open.
        let killed = maybe_cull_sterile(&mut cull, &mut store, 700.0);
        assert!(killed > 0, "expected some kills, got {killed}");
        assert!(killed <= cull.max_per_scan);
    }

    #[test]
    fn protects_min_population_floor() {
        let mut cull = SterileCull::default();
        let n = cull.min_population;
        let mut store = populated_store(n);
        let killed = maybe_cull_sterile(&mut cull, &mut store, 9999.0);
        assert_eq!(killed, 0, "must not cull at-or-below floor");
        for i in 0..n {
            assert!(store.chems[CHEM_MEMBRANE][i] > 0.0);
        }
    }

    #[test]
    fn does_not_cull_recent_reproducer() {
        let mut cull = SterileCull::default();
        let n = cull.min_population + 5;
        let mut store = populated_store(n);
        // Bump everyone's last-reproduce to t=650 so they're not
        // sterile-yet at t=700.
        for i in 0..n {
            store.last_reproduce_fire_t[i] = 650.0;
        }
        let killed = maybe_cull_sterile(&mut cull, &mut store, 700.0);
        assert_eq!(killed, 0);
    }

    #[test]
    fn respects_interval_throttle() {
        let mut cull = SterileCull::default();
        let n = cull.min_population + 5;
        let mut store = populated_store(n);
        // First scan at t=700 fires.
        maybe_cull_sterile(&mut cull, &mut store, 700.0);
        // Reset memberships so we can detect a hit on the next call.
        for i in 0..n {
            store.chems[CHEM_MEMBRANE][i] = 5.0;
        }
        // Second scan at t=710 (< interval=30 from last_run_at=700)
        // must be skipped.
        let killed = maybe_cull_sterile(&mut cull, &mut store, 710.0);
        assert_eq!(killed, 0, "scan ran before interval elapsed");
    }

    #[test]
    fn founders_get_grace_window() {
        let mut cull = SterileCull::default();
        let n = cull.min_population + 5;
        let mut store = populated_store(n);
        // Cells just born at t=0 with no REPRODUCE yet; scan at t=10
        // and t=100 -- grace window covers them.
        let killed = maybe_cull_sterile(&mut cull, &mut store, 10.0);
        assert_eq!(killed, 0);
        cull.last_run_at = 0.0;
        let killed = maybe_cull_sterile(&mut cull, &mut store, 100.0);
        assert_eq!(killed, 0);
    }

    #[test]
    fn disabled_cull_is_noop() {
        let mut cull = SterileCull {
            enabled: false,
            ..Default::default()
        };
        let n = cull.min_population + 5;
        let mut store = populated_store(n);
        let killed = maybe_cull_sterile(&mut cull, &mut store, 9999.0);
        assert_eq!(killed, 0);
    }
}
