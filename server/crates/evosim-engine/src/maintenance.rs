//! Baseline metabolic drain. A small per-second cost on ATP and
//! membrane every cell pays whether the VM ran an op or not. This is
//! the "slow clock" that closes the selection loop: a cell with no
//! way to replenish its pools eventually drops below viability and
//! the death pass culls it. Without this every demo cell sits there
//! forever at its initial pool levels.
//!
//! Calibrated against the TS BASE_METABOLIC_DRAIN. The rates are
//! intentionally tiny so a fed cell can easily outpace them and a
//! single bad tick doesn't kill a healthy one.

use crate::chem_ids::{CHEM_ATP, CHEM_MEMBRANE};
use crate::creatures::CreatureStore;

/// ATP units per sim-second of idle drain. Small enough that a
/// reproducer cell carrying 20 ATP and metabolising on glucose can
/// outpace it indefinitely; large enough that an inert seeker with
/// 50 starter ATP dies in ~ 5 minutes of sim time.
const BASE_METABOLIC_ATP_PER_S: f32 = 0.15;
/// Membrane units per sim-second of idle drain. An undisturbed cell
/// loses its starter membrane (5.0) in ~ 100 seconds, well outside
/// the demo's interesting window but inside any long-run cull.
const BASE_METABOLIC_MEMBRANE_PER_S: f32 = 0.05;

pub fn run_maintenance(store: &mut CreatureStore, dt: f32) {
    let dt_atp = BASE_METABOLIC_ATP_PER_S * dt;
    let dt_mem = BASE_METABOLIC_MEMBRANE_PER_S * dt;
    let n = store.n;
    for i in 0..n {
        // Saturating at zero: never push pool below 0 (the death
        // pass keys off membrane being < MIN_VIABLE_MEMBRANE, not
        // < 0, so a negative pool isn't load-bearing -- this is
        // just hygiene).
        let atp = store.chems[CHEM_ATP][i];
        store.chems[CHEM_ATP][i] = (atp - dt_atp).max(0.0);
        let mem = store.chems[CHEM_MEMBRANE][i];
        store.chems[CHEM_MEMBRANE][i] = (mem - dt_mem).max(0.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::NAMED_CHEMICAL_COUNT;
    use crate::creatures::CreatureInit;

    #[test]
    fn drains_atp_and_membrane() {
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[CHEM_ATP] = 10.0;
        chems[CHEM_MEMBRANE] = 10.0;
        let mut store = CreatureStore::new();
        store.push(CreatureInit {
            r: 8.0,
            chems: Some(chems),
            ..CreatureInit::default()
        });
        // 1 sim-second of drain.
        run_maintenance(&mut store, 1.0);
        assert!(store.chems[CHEM_ATP][0] < 10.0);
        assert!(store.chems[CHEM_MEMBRANE][0] < 10.0);
    }

    #[test]
    fn pool_saturates_at_zero() {
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[CHEM_ATP] = 0.1;
        let mut store = CreatureStore::new();
        store.push(CreatureInit {
            r: 8.0,
            chems: Some(chems),
            ..CreatureInit::default()
        });
        run_maintenance(&mut store, 100.0);
        assert_eq!(store.chems[CHEM_ATP][0], 0.0);
    }
}
