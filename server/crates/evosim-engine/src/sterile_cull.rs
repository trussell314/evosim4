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
            // A cell that hasn't fired REPRODUCE in 5 sim-minutes is
            // probably never going to. TS uses 26 display-hours but
            // their demo runs orders of magnitude slower; for our
            // accelerated demo this maps to roughly the same fraction
            // of a sweep.
            sterile_age_s: 300.0,
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
    let mut hits = 0usize;
    for i in 0..store.n {
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

    #[test]
    fn culls_old_sterile_cell() {
        let mut store = CreatureStore::new();
        let i = store.push(cell_at(0.0, 0.0));
        store.last_reproduce_fire_t[i] = 0.0;
        let mut cull = SterileCull::default();
        // 400s elapsed -> well past 300s sterile age. last_run_at=0
        // so the interval gate is open.
        let killed = maybe_cull_sterile(&mut cull, &mut store, 400.0);
        assert_eq!(killed, 1);
        assert_eq!(store.chems[CHEM_MEMBRANE][0], 0.0);
    }

    #[test]
    fn does_not_cull_recent_reproducer() {
        let mut store = CreatureStore::new();
        let i = store.push(cell_at(0.0, 350.0));
        store.last_reproduce_fire_t[i] = 350.0;
        let mut cull = SterileCull::default();
        let killed = maybe_cull_sterile(&mut cull, &mut store, 400.0);
        assert_eq!(killed, 0);
        assert!(store.chems[CHEM_MEMBRANE][0] > 0.0);
    }

    #[test]
    fn respects_interval_throttle() {
        let mut store = CreatureStore::new();
        let i = store.push(cell_at(0.0, 0.0));
        store.last_reproduce_fire_t[i] = 0.0;
        let mut cull = SterileCull::default();
        // First scan at t=400 fires.
        maybe_cull_sterile(&mut cull, &mut store, 400.0);
        // Second scan at t=410 (< interval=30) -- skipped.
        // Reset the cell's membrane so we can detect a hit.
        store.chems[CHEM_MEMBRANE][i] = 5.0;
        let killed = maybe_cull_sterile(&mut cull, &mut store, 410.0);
        assert_eq!(killed, 0, "scan ran before interval elapsed");
        assert!(store.chems[CHEM_MEMBRANE][0] > 0.0);
    }

    #[test]
    fn founders_get_grace_window() {
        // Cell just born + never reproduced yet, scan at t=10.
        // sterile_age_s=300 means the grace covers it.
        let mut store = CreatureStore::new();
        let i = store.push(cell_at(0.0, 0.0));
        store.last_reproduce_fire_t[i] = 0.0;
        let mut cull = SterileCull::default();
        let killed = maybe_cull_sterile(&mut cull, &mut store, 10.0);
        assert_eq!(killed, 0);
        // Even fast-forward to 100s, still inside grace.
        cull.last_run_at = 0.0;
        let killed = maybe_cull_sterile(&mut cull, &mut store, 100.0);
        assert_eq!(killed, 0);
    }

    #[test]
    fn disabled_cull_is_noop() {
        let mut store = CreatureStore::new();
        let i = store.push(cell_at(0.0, 0.0));
        store.last_reproduce_fire_t[i] = 0.0;
        let mut cull = SterileCull {
            enabled: false,
            ..Default::default()
        };
        let killed = maybe_cull_sterile(&mut cull, &mut store, 9999.0);
        assert_eq!(killed, 0);
    }
}
