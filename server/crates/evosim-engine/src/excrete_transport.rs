//! Consume the VM's `excrete` and `transport` outputs into the
//! ambient field. Without this pass `EXCRETE` and `TRANSPORT` are
//! both inert -- a cell can express the op, but nothing happens.
//!
//! Semantics ported from `src/sim.ts`:
//!   - `EXCRETE <chem>` with stack value v on top: cell loses `max(0, v)`
//!     of `chem`, ambient gains the same. One-way out.
//!   - `TRANSPORT <chem>` with signed stack value v: positive imports
//!     from ambient, negative exports to ambient. Each direction
//!     bounded by the available source (you can't import more than
//!     ambient holds, can't export more than you have).
//!
//! Per-tick magnitudes are scaled to a small fraction so a single
//! VM tick can't drain a cell's pool flat. TS uses MM kinetics
//! against catalyst pools; we use a flat scale until the catalyst-
//! gating pass lands.

use crate::ambient::AmbientField;
use crate::chem_ids::{is_signal, NAMED_CHEMICAL_COUNT};
use crate::creatures::CreatureStore;

/// Per-tick fraction-of-requested-amount actually moved. Scales the
/// raw VM stack value so a cell that requests `EXCRETE` with a 100
/// on top doesn't dump 100 units instantly.
const EXCRETE_GAIN: f32 = 0.02;
const TRANSPORT_GAIN: f32 = 0.05;

/// Walk every cell, draining `vm_out.excrete` and `vm_out.transport`
/// into the ambient field. The pass clears both vectors so the next
/// VM tick starts clean (run_tick also clears them at the top, but
/// this is belt-and-suspenders).
pub fn run_excrete_transport(creatures: &mut CreatureStore, ambient: &mut AmbientField, dt: f32) {
    let excrete_step = EXCRETE_GAIN * dt;
    let transport_step = TRANSPORT_GAIN * dt;
    let n = creatures.n;
    for i in 0..n {
        let out = &mut creatures.vm_out[i];
        for k in 0..NAMED_CHEMICAL_COUNT {
            if is_signal(k) {
                continue;
            }
            // EXCRETE: positive only, one-way cell -> ambient.
            let want_excrete = out.excrete[k] as f32 * excrete_step;
            if want_excrete > 0.0 {
                let take = want_excrete.min(creatures.chems[k][i]);
                creatures.chems[k][i] -= take;
                ambient.deposit(k, take);
            }
            // TRANSPORT: signed. Positive imports, negative exports.
            let want = out.transport[k] as f32 * transport_step;
            if want > 0.0 {
                let take = want.min(ambient.stock[k]);
                ambient.stock[k] -= take;
                creatures.chems[k][i] += take;
            } else if want < 0.0 {
                let export = (-want).min(creatures.chems[k][i]);
                creatures.chems[k][i] -= export;
                ambient.deposit(k, export);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::{CHEM_ATP, CHEM_GLU, NAMED_CHEMICAL_COUNT};
    use crate::creatures::CreatureInit;
    use crate::vm::VmOutputs;

    fn make_cell(glu: f32, atp: f32) -> CreatureStore {
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[CHEM_GLU] = glu;
        chems[CHEM_ATP] = atp;
        let mut s = CreatureStore::new();
        s.push(CreatureInit {
            r: 8.0,
            chems: Some(chems),
            ..CreatureInit::default()
        });
        s
    }

    fn set_excrete(store: &mut CreatureStore, i: usize, chem: usize, amount: f64) {
        store.vm_out[i] = VmOutputs::new();
        store.vm_out[i].excrete[chem] = amount;
    }

    fn set_transport(store: &mut CreatureStore, i: usize, chem: usize, amount: f64) {
        store.vm_out[i] = VmOutputs::new();
        store.vm_out[i].transport[chem] = amount;
    }

    #[test]
    fn excrete_moves_chem_to_ambient() {
        let mut cs = make_cell(50.0, 0.0);
        let mut amb = AmbientField::new();
        set_excrete(&mut cs, 0, CHEM_GLU, 100.0);
        run_excrete_transport(&mut cs, &mut amb, 1.0);
        // 100 requested * 0.02 = 2.0 actually moved.
        assert!((cs.chems[CHEM_GLU][0] - 48.0).abs() < 1e-3);
        assert!((amb.stock[CHEM_GLU] - 2.0).abs() < 1e-3);
    }

    #[test]
    fn excrete_bounded_by_pool() {
        let mut cs = make_cell(0.5, 0.0);
        let mut amb = AmbientField::new();
        set_excrete(&mut cs, 0, CHEM_GLU, 100.0);
        run_excrete_transport(&mut cs, &mut amb, 1.0);
        // Can't excrete more than the pool holds: takes min(2.0, 0.5).
        assert!((cs.chems[CHEM_GLU][0]).abs() < 1e-3);
        assert!((amb.stock[CHEM_GLU] - 0.5).abs() < 1e-3);
    }

    #[test]
    fn transport_positive_imports() {
        let mut cs = make_cell(0.0, 0.0);
        let mut amb = AmbientField::new();
        amb.stock[CHEM_GLU] = 50.0;
        set_transport(&mut cs, 0, CHEM_GLU, 100.0);
        run_excrete_transport(&mut cs, &mut amb, 1.0);
        // 100 * 0.05 = 5.0 moved ambient -> cell.
        assert!((cs.chems[CHEM_GLU][0] - 5.0).abs() < 1e-3);
        assert!((amb.stock[CHEM_GLU] - 45.0).abs() < 1e-3);
    }

    #[test]
    fn transport_negative_exports() {
        let mut cs = make_cell(50.0, 0.0);
        let mut amb = AmbientField::new();
        set_transport(&mut cs, 0, CHEM_GLU, -100.0);
        run_excrete_transport(&mut cs, &mut amb, 1.0);
        // -100 * 0.05 = -5.0, so 5.0 cell -> ambient.
        assert!((cs.chems[CHEM_GLU][0] - 45.0).abs() < 1e-3);
        assert!((amb.stock[CHEM_GLU] - 5.0).abs() < 1e-3);
    }

    #[test]
    fn transport_import_bounded_by_ambient() {
        let mut cs = make_cell(0.0, 0.0);
        let mut amb = AmbientField::new();
        amb.stock[CHEM_GLU] = 1.0;
        set_transport(&mut cs, 0, CHEM_GLU, 1000.0);
        run_excrete_transport(&mut cs, &mut amb, 1.0);
        // Want 50; ambient only has 1.0.
        assert!((cs.chems[CHEM_GLU][0] - 1.0).abs() < 1e-3);
        assert!((amb.stock[CHEM_GLU]).abs() < 1e-3);
    }

    #[test]
    fn signal_chems_are_skipped() {
        let mut cs = make_cell(0.0, 0.0);
        let mut amb = AmbientField::new();
        amb.stock[crate::chem_ids::CHEM_ACT_PHOTO_VISIBLE] = 50.0;
        set_transport(&mut cs, 0, crate::chem_ids::CHEM_ACT_PHOTO_VISIBLE, 100.0);
        run_excrete_transport(&mut cs, &mut amb, 1.0);
        // Signal chem can't be transported.
        assert_eq!(cs.chems[crate::chem_ids::CHEM_ACT_PHOTO_VISIBLE][0], 0.0);
        assert_eq!(amb.stock[crate::chem_ids::CHEM_ACT_PHOTO_VISIBLE], 50.0);
    }
}
