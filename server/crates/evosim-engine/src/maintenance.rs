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

/// Fixed ATP cost per cell per second regardless of size. Small
/// enough that a metabolising cell easily outpaces it; large enough
/// that an inert cell with 50 starter ATP dies in ~ 5 minutes.
const BASE_METABOLIC_ATP_PER_S: f32 = 0.1;
/// Mass-scaled ATP cost: per-second drain *per unit total mass*.
/// Bigger cells cost proportionally more upkeep, so a cell that
/// bloats to 200 units of membrane pays a real ATP tax for it. This
/// is the selection pressure against unbounded size accumulation.
const MASS_METABOLIC_ATP_PER_S: f32 = 0.005;
/// Membrane drain per sim-second. Constant for now (no size-scale
/// on the chem itself); a fed cell rebuilds it through biosynth.
const BASE_METABOLIC_MEMBRANE_PER_S: f32 = 0.05;

pub fn run_maintenance(store: &mut CreatureStore, dt: f32) {
    let dt_atp_base = BASE_METABOLIC_ATP_PER_S * dt;
    let dt_atp_mass = MASS_METABOLIC_ATP_PER_S * dt;
    let dt_mem = BASE_METABOLIC_MEMBRANE_PER_S * dt;
    let n = store.n;
    for i in 0..n {
        // Mass scaling: total mass = sum of all named chems.
        let total_mass: f32 = store.chems.iter().map(|c| c[i]).sum();
        let atp_cost = dt_atp_base + dt_atp_mass * total_mass;
        let atp = store.chems[CHEM_ATP][i];
        store.chems[CHEM_ATP][i] = (atp - atp_cost).max(0.0);
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
    fn bigger_cell_pays_more_atp() {
        // Two cells, same starter ATP. The bigger one (more total
        // mass) should drain proportionally more after 1 sec.
        let mut small_chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        small_chems[CHEM_ATP] = 100.0;
        small_chems[CHEM_MEMBRANE] = 10.0;
        let mut big_chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        big_chems[CHEM_ATP] = 100.0;
        big_chems[CHEM_MEMBRANE] = 200.0;
        let mut store = CreatureStore::new();
        store.push(CreatureInit { r: 4.0, chems: Some(small_chems), ..CreatureInit::default() });
        store.push(CreatureInit { r: 16.0, chems: Some(big_chems), ..CreatureInit::default() });
        run_maintenance(&mut store, 1.0);
        let small_drain = 100.0 - store.chems[CHEM_ATP][0];
        let big_drain = 100.0 - store.chems[CHEM_ATP][1];
        assert!(
            big_drain > small_drain,
            "big cell should pay more ATP: {} vs {}",
            big_drain,
            small_drain
        );
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
