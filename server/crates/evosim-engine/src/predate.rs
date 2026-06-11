//! Minimal PREDATE pass. Cells whose vm_out.predate is set this tick
//! scan for nearby cells, eat at most one whose mass + viability
//! profile makes it valid prey. The prey's chem pools (named +
//! catalyst + inhibitor) transfer wholesale to the predator and the
//! prey's membrane is zeroed so the death pass culls it next tick.
//!
//! What's NOT here yet (kept honest):
//!   - PREDATION_ATP_COST: TS charges energy per kill; we do not
//!     yet so predation is currently free
//!   - per-cell ingestCooldown that throttles serial kills
//!   - membrane tear ceiling: TS refuses kills that would push the
//!     predator over its envelope budget
//!   - bonded-partner protection (TS guards bonded cells)
//!   - generic-chem transfer (those columns don't exist yet)
//!
//! Selection: the predator gets a free mass transfer minus the prey's
//! membrane (which we leave zeroed so the prey dies cleanly). Smaller
//! cells are eaten preferentially because the size-based breach gate
//! refuses prey larger than the predator -- you can't swallow what
//! you can't engulf.

use crate::chem_ids::{CHEM_MEMBRANE, NAMED_CHEMICAL_COUNT};
use crate::creatures::CreatureStore;
use crate::genome_consts::CATALYST_COUNT;

/// Minimum size advantage a predator needs over its prey. Predator
/// must be at least this much bigger by radius so cell-vs-cell
/// pressure favors the larger cells.
const PREDATOR_R_ADVANTAGE: f32 = 1.0;

/// Returns the number of cells killed by predation this tick.
pub fn run_predate(creatures: &mut CreatureStore) -> usize {
    let n = creatures.n;
    if n < 2 {
        return 0;
    }
    let mut kills = 0;
    // Track which cells are still eligible to eat / be eaten. A cell
    // that's already been eaten this tick (membrane zeroed) can't
    // also be a predator and shouldn't appear as prey again.
    let mut eaten = vec![false; n];

    for ci in 0..n {
        if !creatures.vm_out[ci].predate {
            continue;
        }
        if eaten[ci] {
            continue;
        }
        // Scan for prey: nearest in-range, smaller-by-radius,
        // not-yet-eaten cell.
        let cx = creatures.x[ci];
        let cy = creatures.y[ci];
        let cr = creatures.r[ci];
        let mut best: Option<(usize, f32)> = None;
        for (pi, was_eaten) in eaten.iter().enumerate().take(n) {
            if pi == ci || *was_eaten {
                continue;
            }
            let pr = creatures.r[pi];
            if cr < pr + PREDATOR_R_ADVANTAGE {
                continue;
            }
            let dx = creatures.x[pi] - cx;
            let dy = creatures.y[pi] - cy;
            let min_d = cr + pr;
            let dsq = dx * dx + dy * dy;
            if dsq >= min_d * min_d {
                continue;
            }
            let better = best.map_or(true, |(_, prev)| dsq < prev);
            if better {
                best = Some((pi, dsq));
            }
        }
        let Some((prey, _)) = best else {
            continue;
        };
        // Transfer chems wholesale.
        for k in 0..NAMED_CHEMICAL_COUNT {
            let m = creatures.chems[k][prey];
            if m > 0.0 {
                creatures.chems[k][ci] += m;
                creatures.chems[k][prey] = 0.0;
            }
        }
        // Catalysts + inhibitors transfer verbatim (prey enzymes are
        // not denatured; TS calls this the "digestInnerIntoHost"
        // model).
        for k in 0..CATALYST_COUNT {
            let v = creatures.catalyst[k][prey];
            if v != 0.0 {
                creatures.catalyst[k][ci] += v;
                creatures.catalyst[k][prey] = 0.0;
            }
            let v = creatures.inhibitor[k][prey];
            if v != 0.0 {
                creatures.inhibitor[k][ci] += v;
                creatures.inhibitor[k][prey] = 0.0;
            }
        }
        // Force the prey's membrane to zero so the death pass culls
        // it next tick. Belt-and-suspenders since we just transferred
        // out its chems above (chems include membrane).
        creatures.chems[CHEM_MEMBRANE][prey] = 0.0;
        eaten[prey] = true;
        kills += 1;
    }
    kills
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::{CHEM_ATP, CHEM_GLU};
    use crate::creatures::CreatureInit;
    use crate::vm::VmOutputs;

    fn cell_at(x: f32, y: f32, r: f32, membrane: f32, atp: f32, glu: f32) -> (CreatureInit, Vec<f32>) {
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[CHEM_MEMBRANE] = membrane;
        chems[CHEM_ATP] = atp;
        chems[CHEM_GLU] = glu;
        (
            CreatureInit { x, y, r, chems: Some(chems.clone()), ..CreatureInit::default() },
            chems,
        )
    }

    fn push_cell(store: &mut CreatureStore, init: CreatureInit) {
        store.push(init);
    }

    fn fire_predate(store: &mut CreatureStore, i: usize) {
        store.vm_out[i] = VmOutputs::new();
        store.vm_out[i].predate = true;
    }

    #[test]
    fn predator_eats_smaller_prey_in_range() {
        let mut s = CreatureStore::new();
        // Predator at (50, 50), r=10. Prey at (52, 50), r=8.
        let (a, _) = cell_at(50.0, 50.0, 10.0, 5.0, 20.0, 0.0);
        let (b, _) = cell_at(52.0, 50.0, 8.0, 5.0, 5.0, 30.0);
        push_cell(&mut s, a);
        push_cell(&mut s, b);
        fire_predate(&mut s, 0);
        let kills = run_predate(&mut s);
        assert_eq!(kills, 1);
        // Predator absorbed prey's GLU pool.
        assert!(s.chems[CHEM_GLU][0] >= 30.0);
        // Prey lost membrane.
        assert_eq!(s.chems[CHEM_MEMBRANE][1], 0.0);
    }

    #[test]
    fn predator_refuses_larger_prey() {
        let mut s = CreatureStore::new();
        // Predator r=8, prey r=10. The size advantage rule blocks it.
        let (a, _) = cell_at(50.0, 50.0, 8.0, 5.0, 20.0, 0.0);
        let (b, _) = cell_at(52.0, 50.0, 10.0, 5.0, 5.0, 30.0);
        push_cell(&mut s, a);
        push_cell(&mut s, b);
        fire_predate(&mut s, 0);
        let kills = run_predate(&mut s);
        assert_eq!(kills, 0);
    }

    #[test]
    fn predator_refuses_out_of_range_prey() {
        let mut s = CreatureStore::new();
        // Both r=8 with PREDATOR_R_ADVANTAGE=1 we make predator r=10.
        let (a, _) = cell_at(50.0, 50.0, 10.0, 5.0, 20.0, 0.0);
        // Prey 100 px away -- not in body contact.
        let (b, _) = cell_at(200.0, 50.0, 8.0, 5.0, 5.0, 30.0);
        push_cell(&mut s, a);
        push_cell(&mut s, b);
        fire_predate(&mut s, 0);
        let kills = run_predate(&mut s);
        assert_eq!(kills, 0);
    }

    #[test]
    fn each_cell_eats_at_most_one_per_tick() {
        let mut s = CreatureStore::new();
        // Predator at center, two prey adjacent.
        let (p, _) = cell_at(50.0, 50.0, 10.0, 5.0, 20.0, 0.0);
        let (a, _) = cell_at(51.0, 50.0, 8.0, 5.0, 5.0, 10.0);
        let (b, _) = cell_at(50.0, 51.0, 8.0, 5.0, 5.0, 20.0);
        push_cell(&mut s, p);
        push_cell(&mut s, a);
        push_cell(&mut s, b);
        fire_predate(&mut s, 0);
        let kills = run_predate(&mut s);
        assert_eq!(kills, 1);
    }

    #[test]
    fn no_predate_no_kills() {
        let mut s = CreatureStore::new();
        let (a, _) = cell_at(50.0, 50.0, 10.0, 5.0, 20.0, 0.0);
        let (b, _) = cell_at(52.0, 50.0, 8.0, 5.0, 5.0, 30.0);
        push_cell(&mut s, a);
        push_cell(&mut s, b);
        // No predate flag set.
        let kills = run_predate(&mut s);
        assert_eq!(kills, 0);
    }

    #[test]
    fn catalyst_transfer_is_verbatim() {
        let mut s = CreatureStore::new();
        let (a, _) = cell_at(50.0, 50.0, 10.0, 5.0, 20.0, 0.0);
        let (b, _) = cell_at(52.0, 50.0, 8.0, 5.0, 5.0, 30.0);
        push_cell(&mut s, a);
        push_cell(&mut s, b);
        s.catalyst[7][1] = 4.5;
        s.inhibitor[7][1] = 1.5;
        fire_predate(&mut s, 0);
        run_predate(&mut s);
        assert_eq!(s.catalyst[7][0], 4.5);
        assert_eq!(s.inhibitor[7][0], 1.5);
        assert_eq!(s.catalyst[7][1], 0.0);
    }
}
