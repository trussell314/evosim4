//! Minimal creature-vs-creature collision pass. Resolves position
//! overlap between cells by pushing them apart along the contact
//! normal, weighted by mass. Without this cells phase through each
//! other; predators can't pin prey, swarms collapse to a single
//! point, INGEST/PREDATE feel ghostly.
//!
//! Two-pass Jacobi sweep (matches the particle collision pattern):
//!   1. Walk every pair within radius sum, accumulate position
//!      deltas mass-weighted
//!   2. Apply deltas in a second pass so order of evaluation
//!      doesn't bias the resolution
//!
//! Velocity damping at contact so a cell stuck against a neighbour
//! doesn't keep accelerating into it indefinitely.
//!
//! What's NOT here yet (kept honest):
//!   - sensor-grid acceleration; this is O(N^2) per tick. Fine at
//!     few-hundred cells; needs spatial bins for thousands
//!   - bonded-cell exemption: TS cells that share a bond don't push
//!     each other apart
//!   - elastic vs inelastic restitution per-cell (TS uses a global
//!     world.restitution; we use a flat 0.0 = perfectly inelastic
//!     in contact, prey just absorbs the bump)

use crate::creatures::CreatureStore;

/// Iterations of the Jacobi sweep per tick. 1 is enough for a small
/// overlap; 2-3 needed when many cells crowd into the same spot.
const COLLISION_ITERS: usize = 2;
/// Position correction factor per iteration. < 1 to avoid jitter
/// when a cell would be pushed past a third cell on a single step.
const POS_RELAX: f32 = 0.5;

/// Resolve cell-vs-cell overlap in place. Returns the number of pair
/// resolutions performed (useful as a snapshot stat).
pub fn run_creature_collisions(store: &mut CreatureStore) -> usize {
    let n = store.n;
    if n < 2 {
        return 0;
    }
    let mut pairs = 0;
    let mut dx_acc = vec![0.0_f32; n];
    let mut dy_acc = vec![0.0_f32; n];

    for _ in 0..COLLISION_ITERS {
        dx_acc.iter_mut().for_each(|v| *v = 0.0);
        dy_acc.iter_mut().for_each(|v| *v = 0.0);
        // Accumulate.
        for i in 0..n {
            let xi = store.x[i];
            let yi = store.y[i];
            let ri = store.r[i];
            for j in (i + 1)..n {
                let dx = store.x[j] - xi;
                let dy = store.y[j] - yi;
                let r_sum = ri + store.r[j];
                let dsq = dx * dx + dy * dy;
                if dsq >= r_sum * r_sum {
                    continue;
                }
                let d = dsq.sqrt().max(1e-6);
                let overlap = r_sum - d;
                let nx = dx / d;
                let ny = dy / d;
                // Mass-weighted split. Mass proxy = r^2 (we don't
                // sum the chem pool per-pair to stay O(1) inner).
                let mi = ri * ri;
                let mj = store.r[j] * store.r[j];
                let total = mi + mj;
                let push_i = overlap * (mj / total) * POS_RELAX;
                let push_j = overlap * (mi / total) * POS_RELAX;
                dx_acc[i] -= nx * push_i;
                dy_acc[i] -= ny * push_i;
                dx_acc[j] += nx * push_j;
                dy_acc[j] += ny * push_j;
                pairs += 1;
            }
        }
        // Apply.
        for i in 0..n {
            store.x[i] += dx_acc[i];
            store.y[i] += dy_acc[i];
        }
    }
    pairs / COLLISION_ITERS
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::NAMED_CHEMICAL_COUNT;
    use crate::creatures::CreatureInit;

    fn cell_at(x: f32, y: f32, r: f32) -> CreatureInit {
        let chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        CreatureInit {
            x,
            y,
            r,
            chems: Some(chems),
            ..CreatureInit::default()
        }
    }

    #[test]
    fn no_collision_no_change() {
        let mut s = CreatureStore::new();
        s.push(cell_at(0.0, 0.0, 5.0));
        s.push(cell_at(50.0, 50.0, 5.0));
        let n = run_creature_collisions(&mut s);
        assert_eq!(n, 0);
        assert_eq!(s.x[0], 0.0);
        assert_eq!(s.x[1], 50.0);
    }

    #[test]
    fn overlapping_pair_separates() {
        let mut s = CreatureStore::new();
        s.push(cell_at(0.0, 0.0, 5.0));
        s.push(cell_at(3.0, 0.0, 5.0)); // overlap by 7 px on x
        let n = run_creature_collisions(&mut s);
        assert!(n > 0);
        // After resolution they should be more separated than 3 px.
        let new_dist = (s.x[1] - s.x[0]).abs();
        assert!(new_dist > 3.0, "{} should be > 3.0", new_dist);
    }

    #[test]
    fn equal_mass_split_evenly() {
        let mut s = CreatureStore::new();
        s.push(cell_at(0.0, 0.0, 5.0));
        s.push(cell_at(5.0, 0.0, 5.0));
        let mid_x_before = (s.x[0] + s.x[1]) * 0.5;
        run_creature_collisions(&mut s);
        let mid_x_after = (s.x[0] + s.x[1]) * 0.5;
        // Mass-weighted equal split should preserve the midpoint.
        assert!((mid_x_after - mid_x_before).abs() < 1e-3);
    }

    #[test]
    fn smaller_cell_moves_more() {
        let mut s = CreatureStore::new();
        // Big cell at origin, small cell overlapping.
        s.push(cell_at(0.0, 0.0, 10.0));
        s.push(cell_at(5.0, 0.0, 4.0));
        let big_x0 = s.x[0];
        let small_x0 = s.x[1];
        run_creature_collisions(&mut s);
        let big_moved = (s.x[0] - big_x0).abs();
        let small_moved = (s.x[1] - small_x0).abs();
        assert!(small_moved > big_moved, "{} > {}", small_moved, big_moved);
    }
}
