//! Run the catalyst-gated transport reactions. The reaction table
//! reserves the tail slots [TRANSPORT_SLOT_BASE..N_REACTIONS) as
//! transporters: each slot moves one specific chem across the cell
//! membrane (cell <-> ambient), driven by the cell's catalyst pool
//! for that slot. A cell that expresses no transporter has no flux
//! through these slots; the more catalyst it builds (via SYNTH CAT
//! <slot>), the higher the flux.
//!
//! Flux model: facilitated diffusion. Direction = down the
//! concentration gradient. Magnitude:
//!   rate = TRANSPORT_VMAX * (pool / CAT_REF) * (gradient)
//! where gradient = cell - ambient (signed; positive = export).
//!
//! Symmetric so a cell at concentration parity has zero flux.
//!
//! What's NOT here yet:
//!   - region-aware ambient (currently world-wide)
//!   - membrane area scaling (TS uses cell surface)
//!   - per-chem permeability multiplier

use crate::ambient::AmbientField;
use crate::creatures::CreatureStore;
use crate::reactions::{table as reactions_table, TRANSPORT_SLOT_BASE};

/// Reference catalyst-pool level. Same as in cell_reactions::CAT_REF;
/// kept private to avoid coupling the modules.
const CAT_REF: f32 = 5.0;

/// Run all transport reactions for every cell. Returns the number of
/// (cell, slot) pairs that did real flux this tick.
pub fn run_transport_reactions(creatures: &mut CreatureStore, ambient: &mut AmbientField, dt: f32) -> usize {
    let table = reactions_table();
    let n_cells = creatures.n;
    let mut flux_events = 0;
    for (slot, rxn) in table.iter().enumerate().skip(TRANSPORT_SLOT_BASE) {
        let Some(chem) = rxn.transport else {
            continue;
        };
        let chem_id = chem as usize;
        if chem_id >= creatures.chems.len() {
            continue;
        }
        let vmax = rxn.vmax;
        for i in 0..n_cells {
            let pool = creatures.catalyst[slot][i];
            if pool <= 0.0 {
                continue;
            }
            let cx = creatures.x[i];
            let cy = creatures.y[i];
            let cell = creatures.chems[chem_id][i];
            let amb_local = ambient.at(chem_id, cx, cy);
            let gradient = cell - amb_local;
            if gradient.abs() < 1e-6 {
                continue;
            }
            // Facilitated rate. Signed: positive gradient -> export
            // (cell -> local region).
            let rate = vmax * (pool / CAT_REF) * gradient;
            let mut flux = rate * dt;
            if flux > 0.0 {
                flux = flux.min(cell);
                creatures.chems[chem_id][i] = cell - flux;
                ambient.deposit_at(chem_id, flux, cx, cy);
            } else {
                let want = -flux;
                let taken = ambient.take_at(chem_id, want, cx, cy);
                creatures.chems[chem_id][i] += taken;
                flux = taken;
            }
            if flux > 0.0 {
                flux_events += 1;
            }
        }
    }
    flux_events
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::{CHEM_GLU, NAMED_CHEMICAL_COUNT};
    use crate::creatures::CreatureInit;
    use crate::reactions::TRANSPORT_GLU_SLOT;

    fn make_cell(glu: f32) -> CreatureStore {
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[CHEM_GLU] = glu;
        let mut s = CreatureStore::new();
        s.push(CreatureInit {
            r: 8.0,
            chems: Some(chems),
            ..CreatureInit::default()
        });
        s
    }

    #[test]
    fn no_transporter_no_flux() {
        let mut cs = make_cell(50.0);
        let mut amb = AmbientField::new();
        // No catalyst pool means no flux.
        run_transport_reactions(&mut cs, &mut amb, 1.0);
        assert_eq!(cs.chems[CHEM_GLU][0], 50.0);
        assert_eq!(amb.at(CHEM_GLU, 0.0, 0.0), 0.0);
    }

    #[test]
    fn high_cell_exports_to_low_ambient() {
        let mut cs = make_cell(50.0);
        cs.catalyst[TRANSPORT_GLU_SLOT][0] = 5.0; // = CAT_REF, full pool
        let mut amb = AmbientField::new();
        run_transport_reactions(&mut cs, &mut amb, 1.0);
        // Cell GLU should drop, ambient should gain.
        assert!(cs.chems[CHEM_GLU][0] < 50.0);
        assert!(amb.at(CHEM_GLU, 0.0, 0.0) > 0.0);
    }

    #[test]
    fn high_ambient_imports_into_empty_cell() {
        let mut cs = make_cell(0.0);
        cs.catalyst[TRANSPORT_GLU_SLOT][0] = 5.0;
        let mut amb = AmbientField::new();
        amb.deposit_at(CHEM_GLU, 50.0, 0.0, 0.0);
        run_transport_reactions(&mut cs, &mut amb, 1.0);
        assert!(cs.chems[CHEM_GLU][0] > 0.0);
        assert!(amb.at(CHEM_GLU, 0.0, 0.0) < 50.0);
    }

    #[test]
    fn equilibrium_zero_flux() {
        // Cell and ambient at the same concentration; net flux = 0.
        let mut cs = make_cell(20.0);
        cs.catalyst[TRANSPORT_GLU_SLOT][0] = 5.0;
        let mut amb = AmbientField::new();
        amb.deposit_at(CHEM_GLU, 20.0, 0.0, 0.0);
        let cell_before = cs.chems[CHEM_GLU][0];
        let amb_before = amb.at(CHEM_GLU, 0.0, 0.0);
        run_transport_reactions(&mut cs, &mut amb, 1.0);
        assert!((cs.chems[CHEM_GLU][0] - cell_before).abs() < 1e-3);
        assert!((amb.at(CHEM_GLU, 0.0, 0.0) - amb_before).abs() < 1e-3);
    }

    #[test]
    fn mass_conserved_per_chem() {
        let mut cs = make_cell(40.0);
        cs.catalyst[TRANSPORT_GLU_SLOT][0] = 2.0;
        let mut amb = AmbientField::new();
        amb.deposit_at(CHEM_GLU, 10.0, 0.0, 0.0);
        let total0 = cs.chems[CHEM_GLU][0] + amb.at(CHEM_GLU, 0.0, 0.0);
        run_transport_reactions(&mut cs, &mut amb, 1.0);
        let total1 = cs.chems[CHEM_GLU][0] + amb.at(CHEM_GLU, 0.0, 0.0);
        assert!((total1 - total0).abs() < 1e-3);
    }
}
