//! World-wide ambient reserve field. A single scalar per chem,
//! representing the dissolved bulk stock of that chem in the
//! environment. Cells exchange with the field through three
//! channels:
//!
//!   - **autolysis dump**: when a cell dies, a small fraction of
//!     each emitted chem goes into the ambient pool instead of out
//!     as a particle. Models dissolution of small molecules at
//!     death rather than every chem turning into a solid grain
//!   - **passive leak**: each tick every cell loses a tiny
//!     fraction of each chem to the ambient pool. The TS engine
//!     gates this on per-chem permeability; until that lands we use
//!     a flat low rate so cells slowly equilibrate
//!   - **passive uptake**: each tick every cell pulls a tiny
//!     fraction of the ambient pool inward. Balanced against the
//!     leak so a cell at parity with ambient doesn't drift
//!
//! What's NOT here yet (kept honest):
//!   - region grid: TS partitions the world into ~50px boxes and
//!     each region has its own ambient. We use one bulk stock for
//!     the whole world so distance doesn't matter -- a cell can't
//!     exhaust its local pool without affecting the global
//!   - per-chem permeability: TS reads permeability from the chem
//!     table; we use flat rates
//!   - mass-balance against an atmosphere reservoir for O2/CO2

use crate::chem_ids::{CHEMICAL_COUNT, NAMED_CHEMICAL_COUNT};
use crate::creatures::CreatureStore;
use serde::{Deserialize, Serialize};

/// Per-chem ambient mass. Length matches CHEMICAL_COUNT so any chem
/// can in principle dissolve; the per-chem permeability constants
/// here are crude until the TS pass lands.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AmbientField {
    pub stock: Vec<f32>,
}

impl AmbientField {
    pub fn new() -> Self {
        Self { stock: vec![0.0; CHEMICAL_COUNT] }
    }

    /// Pour `mass` of chem `id` into the ambient field. Called by the
    /// death pass when a cell autolyses.
    pub fn deposit(&mut self, chem_id: usize, mass: f32) {
        if let Some(slot) = self.stock.get_mut(chem_id) {
            *slot += mass;
        }
    }

    /// Total ambient mass across all chems. Snapshot stat.
    pub fn total(&self) -> f32 {
        self.stock.iter().sum()
    }
}

impl Default for AmbientField {
    fn default() -> Self {
        Self::new()
    }
}

/// Fraction of a cell's named-chem pool that leaks into the ambient
/// per second. Small enough that a healthy cell barely notices.
const LEAK_PER_S: f32 = 0.005;
/// Fraction of the ambient stock a cell pulls inward per second.
/// Symmetric with leak so a cell at ambient equilibrium doesn't
/// drift.
const UPTAKE_PER_S: f32 = 0.005;

/// Run leak + uptake against every cell, mass-conservingly. Skipped
/// per chem when the cell has no pool AND the ambient has no stock
/// (the common case for sensor activation chems).
pub fn run_ambient_exchange(creatures: &mut CreatureStore, ambient: &mut AmbientField, dt: f32) {
    let leak_frac = (LEAK_PER_S * dt).min(1.0);
    let uptake_frac = (UPTAKE_PER_S * dt).min(1.0);
    let n = creatures.n;
    for chem_id in 0..NAMED_CHEMICAL_COUNT {
        // Signal chems are the activation-pool slots that carry
        // signed amplitudes, not physical mass. Excluding them keeps
        // mass balance honest.
        if crate::chem_ids::is_signal(chem_id) {
            continue;
        }
        let col = &mut creatures.chems[chem_id];
        let ambient_slot = &mut ambient.stock[chem_id];
        for slot in col.iter_mut().take(n) {
            let cell_amount = *slot;
            // Leak cell -> ambient.
            let leak = cell_amount * leak_frac;
            *slot = cell_amount - leak;
            *ambient_slot += leak;
            // Uptake ambient -> cell.
            let uptake = *ambient_slot * uptake_frac;
            *ambient_slot -= uptake;
            *slot += uptake;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::{CHEM_GLU, NAMED_CHEMICAL_COUNT};
    use crate::creatures::CreatureInit;

    fn make_cell(glu: f32) -> CreatureStore {
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[CHEM_GLU] = glu;
        let mut s = CreatureStore::new();
        s.push(CreatureInit { r: 8.0, chems: Some(chems), ..CreatureInit::default() });
        s
    }

    #[test]
    fn high_cell_leaks_into_empty_ambient() {
        let mut cs = make_cell(100.0);
        let mut amb = AmbientField::new();
        run_ambient_exchange(&mut cs, &mut amb, 1.0);
        assert!(cs.chems[CHEM_GLU][0] < 100.0, "cell should leak");
        assert!(amb.stock[CHEM_GLU] > 0.0, "ambient should gain");
    }

    #[test]
    fn high_ambient_seeps_into_empty_cell() {
        let mut cs = make_cell(0.0);
        let mut amb = AmbientField::new();
        amb.stock[CHEM_GLU] = 100.0;
        run_ambient_exchange(&mut cs, &mut amb, 1.0);
        assert!(cs.chems[CHEM_GLU][0] > 0.0, "cell should take up");
        assert!(amb.stock[CHEM_GLU] < 100.0, "ambient should drop");
    }

    #[test]
    fn mass_is_conserved_per_chem() {
        let mut cs = make_cell(60.0);
        let mut amb = AmbientField::new();
        amb.stock[CHEM_GLU] = 40.0;
        let total0 = cs.chems[CHEM_GLU][0] + amb.stock[CHEM_GLU];
        run_ambient_exchange(&mut cs, &mut amb, 1.0);
        let total1 = cs.chems[CHEM_GLU][0] + amb.stock[CHEM_GLU];
        assert!((total1 - total0).abs() < 1e-3, "mass should be conserved: {total0} -> {total1}");
    }

    #[test]
    fn signal_chems_are_skipped() {
        // CHEM_ACT_PHOTO_VISIBLE = 16 is a signal chem; the leak
        // pass must not touch it.
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[crate::chem_ids::CHEM_ACT_PHOTO_VISIBLE] = 7.0;
        let mut cs = CreatureStore::new();
        cs.push(CreatureInit { r: 8.0, chems: Some(chems), ..CreatureInit::default() });
        let mut amb = AmbientField::new();
        run_ambient_exchange(&mut cs, &mut amb, 1.0);
        assert_eq!(cs.chems[crate::chem_ids::CHEM_ACT_PHOTO_VISIBLE][0], 7.0);
        assert_eq!(amb.stock[crate::chem_ids::CHEM_ACT_PHOTO_VISIBLE], 0.0);
    }
}
