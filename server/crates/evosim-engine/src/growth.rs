//! Cell radius from membrane mass. Without this pass cells stay at
//! their spawn radius forever; biosynth_membrane and the membrane
//! decay path show up in the chem pool but not in the cell's size.
//! With it, a cell that successfully runs the membrane biosynth
//! reaction physically grows, becomes a bigger SENSE_OUT receiver,
//! a bigger ingestion target, and a more productive photosynth
//! emitter (the surface_scale slot uses r^2).
//!
//! Inverse cube root because membrane is a SHELL: a sphere's
//! surface area is what holds the cell together, and the membrane
//! mass requirement scales as r^2 (envelope). So r ~ sqrt(membrane).
//!
//! Tuning: at the demo founder's starter membrane of 20.0 the cell
//! sits at its current spawn radius of ~8 px; we scale so MEMBRANE_R_K
//! makes that match.

use crate::chem_ids::CHEM_MEMBRANE;
use crate::creatures::{CreatureStore, MIN_CREATURE_R};

/// `r = max(MIN_R, MEMBRANE_R_K * sqrt(membrane))` so a cell at the
/// founder default of membrane=20 lands close to 8 px.
const MEMBRANE_R_K: f32 = 1.789; // 8.0 / sqrt(20.0)

/// Recompute every cell's radius from its membrane chem pool.
pub fn run_growth(store: &mut CreatureStore) {
    let n = store.n;
    for i in 0..n {
        let mem = store.chems[CHEM_MEMBRANE][i].max(0.0);
        let r = MEMBRANE_R_K * mem.sqrt();
        store.r[i] = r.max(MIN_CREATURE_R);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::NAMED_CHEMICAL_COUNT;
    use crate::creatures::CreatureInit;

    fn cell(membrane: f32) -> CreatureStore {
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[CHEM_MEMBRANE] = membrane;
        let mut s = CreatureStore::new();
        s.push(CreatureInit {
            r: 100.0, // anything; growth pass will overwrite
            chems: Some(chems),
            ..CreatureInit::default()
        });
        s
    }

    #[test]
    fn radius_floors_at_min() {
        let mut s = cell(0.0);
        run_growth(&mut s);
        assert_eq!(s.r[0], MIN_CREATURE_R);
    }

    #[test]
    fn radius_grows_with_membrane() {
        let mut a = cell(20.0);
        let mut b = cell(80.0);
        run_growth(&mut a);
        run_growth(&mut b);
        assert!(b.r[0] > a.r[0], "{} > {}", b.r[0], a.r[0]);
        // Inverse: 4x membrane -> 2x r.
        assert!((b.r[0] / a.r[0] - 2.0).abs() < 1e-3);
    }

    #[test]
    fn founder_starting_size_close_to_8() {
        let mut s = cell(20.0);
        run_growth(&mut s);
        assert!((s.r[0] - 8.0).abs() < 0.1);
    }
}
