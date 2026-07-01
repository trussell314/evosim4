//! Somatic mutation. Each tick, every cell rolls a small probability
//! of having one byte in its genome flipped to a random bit. The
//! probability scales quadratically with the cell's age (seconds
//! since birth), so a young cell is effectively stable while an old
//! one drifts.
//!
//! CHEM_REPAIR above a threshold refreshes a "repair window"
//! (REPAIR_WINDOW_TICKS) that suppresses somatic mutation. So a cell
//! can opt in to genetic stability by investing in repair chem
//! (synthesized via reaction slot 23 / SYNTH CAT 23 + the repair-
//! chem biosynth pathway).
//!
//! Why this matters biologically: somatic drift in a long-lived cell
//! IS a selection pressure -- a cell that runs its VM for thousands
//! of ticks might evolve a copy of itself that subtly differs from
//! its parent. Lineages can split this way (the daughter inherits
//! the drift). Cells that invest in repair stay stable; cells that
//! don't, mutate.
//!
//! Calibration: SOMATIC_MUTATION_AGE_COEF = 8e-7 from TS. At age 60s
//! that's 60*60*8e-7 = 2.88e-3 per second = roughly one mutation
//! per ~6 minutes; at age 300s it's 5x faster.

use crate::chem_ids::CHEM_REPAIR;
use crate::creatures::CreatureStore;
use crate::rng::Mulberry32;

/// Quadratic-in-age coefficient on per-second mutation probability.
const SOMATIC_MUTATION_AGE_COEF: f32 = 8e-7;
/// Hard cap on per-tick mutation probability so even very old cells
/// can't churn the whole genome.
const MUTATION_P_CAP: f32 = 0.02;
/// CHEM_REPAIR pool above this refreshes the repair window each tick.
const REPAIR_ACTIVE_THRESH: f32 = 0.1;
/// Ticks of mutation suppression a full repair window provides.
const REPAIR_WINDOW_TICKS: u32 = 30;

/// Per-cell scratch: tick counter of remaining mutation-suppression
/// window. Held alongside the bond list as a parallel column on
/// the Engine (or could move into CreatureStore later).
pub type RepairTicks = Vec<u32>;

pub fn make_repair_ticks(n: usize) -> RepairTicks {
    vec![0; n]
}

pub fn resize_repair_ticks(ticks: &mut RepairTicks, n: usize) {
    if ticks.len() < n {
        ticks.resize(n, 0);
    }
}

/// Returns the number of somatic mutations applied this tick.
pub fn run_somatic_mutation(
    creatures: &mut CreatureStore,
    repair_ticks: &mut RepairTicks,
    rng: &mut Mulberry32,
    t: f64,
    dt: f32,
) -> usize {
    let n = creatures.n;
    resize_repair_ticks(repair_ticks, n);
    let mut mutations = 0;
    #[allow(clippy::needless_range_loop)]
    for i in 0..n {
        let age = (t - creatures.born_at[i]) as f32;
        if age <= 0.0 {
            continue;
        }
        // Refresh the repair window if the cell holds enough
        // CHEM_REPAIR.
        if creatures.chems[CHEM_REPAIR][i] >= REPAIR_ACTIVE_THRESH {
            repair_ticks[i] = REPAIR_WINDOW_TICKS;
        }
        // Inside the window? No mutation. Decrement and continue.
        if repair_ticks[i] > 0 {
            repair_ticks[i] -= 1;
            continue;
        }
        let p_raw = SOMATIC_MUTATION_AGE_COEF * age * age * dt;
        let p = p_raw.min(MUTATION_P_CAP);
        if (rng.next_f64() as f32) >= p {
            continue;
        }
        // Apply one byte flip.
        let l = creatures.genome[i].len();
        if l == 0 {
            continue;
        }
        let idx = (rng.next_f64() * l as f64) as usize;
        let bit = 1u8 << ((rng.next_f64() * 8.0) as usize & 7);
        creatures.genome[i][idx] ^= bit;
        // Recompute the per-cell derived trait that's a function of
        // genome contents (only sense range right now).
        creatures.sense_range[i] = crate::genome::compute_sense_range(&creatures.genome[i]);
        mutations += 1;
    }
    mutations
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::NAMED_CHEMICAL_COUNT;
    use crate::creatures::CreatureInit;

    fn cell_with_age(repair: f32, born_at: f64) -> CreatureStore {
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[CHEM_REPAIR] = repair;
        let mut s = CreatureStore::new();
        s.push(CreatureInit {
            r: 8.0,
            born_at,
            chems: Some(chems),
            genome: vec![0x42; 30],
            ..CreatureInit::default()
        });
        s
    }

    #[test]
    fn young_cell_no_mutation() {
        let mut s = cell_with_age(0.0, 9.99);
        let mut ticks = make_repair_ticks(1);
        let mut rng = Mulberry32::new(1);
        // Age = 0.01s, so p ~= 8e-7 * 1e-4 * dt -- essentially zero.
        let m = run_somatic_mutation(&mut s, &mut ticks, &mut rng, 10.0, 1.0 / 60.0);
        assert_eq!(m, 0);
    }

    #[test]
    fn old_cell_with_no_repair_mutates_eventually() {
        let mut s = cell_with_age(0.0, 0.0);
        let mut ticks = make_repair_ticks(1);
        let mut rng = Mulberry32::new(0xABCD);
        // At age 1000s the per-tick probability is
        //   8e-7 * 1e6 * 1/60 = ~1.33e-2, capped at MUTATION_P_CAP.
        // Over 500 ticks the expected mutations is ~6.7.
        let mut hits = 0;
        for _ in 0..500 {
            hits += run_somatic_mutation(&mut s, &mut ticks, &mut rng, 1000.0, 1.0 / 60.0);
        }
        assert!(hits > 0, "expected at least one mutation, got {hits}");
    }

    #[test]
    fn high_repair_suppresses_mutation() {
        let mut s = cell_with_age(1.0, 0.0); // > REPAIR_ACTIVE_THRESH
        let mut ticks = make_repair_ticks(1);
        let mut rng = Mulberry32::new(0xABCD);
        let mut hits = 0;
        for _ in 0..500 {
            hits += run_somatic_mutation(&mut s, &mut ticks, &mut rng, 1000.0, 1.0 / 60.0);
        }
        assert_eq!(hits, 0, "repair should suppress all mutations");
    }

    #[test]
    fn mutation_perturbs_byte() {
        let mut s = cell_with_age(0.0, 0.0);
        let mut ticks = make_repair_ticks(1);
        let mut rng = Mulberry32::new(0xABCD);
        let original = s.genome[0].clone();
        for _ in 0..500 {
            run_somatic_mutation(&mut s, &mut ticks, &mut rng, 1000.0, 1.0 / 60.0);
        }
        assert_ne!(s.genome[0], original);
    }
}
