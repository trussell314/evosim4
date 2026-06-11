//! Cell-cell bonding. Cells whose VM expressed SYNTH BOND with
//! compatible markers and whose CHEM_BOND pool is above threshold
//! self-bond when adjacent. Bonded cells experience a soft spring
//! force on every tick that pulls them toward each other -- enough
//! to keep a cluster together but soft enough that the cells can
//! still maneuver.
//!
//! Marker recognition is the genome-encoded greenbeard rule from TS:
//! |a.marker - b.marker| <= BOND_MARKER_TOL. So a cell expresses
//! a 0..255 marker via SYNTH BOND <byte> and only bonds to cells
//! within ~4 units of the same marker. Mutation diversifies the
//! markers, producing tribes that bond among themselves and not to
//! outsiders.
//!
//! Bonds break when either side drops its CHEM_BOND below threshold
//! (the cell stopped expressing) or when stretched past the break
//! distance.

use crate::chem_ids::CHEM_BOND;
use crate::creatures::CreatureStore;

/// Min CHEM_BOND pool a cell must hold to remain bonded. Below this
/// the bond breaks.
pub const BOND_FORMATION_THRESH: f32 = 0.1;
/// Max marker difference for two cells to be bondable. With markers
/// in 0..255, a tolerance of 4 means tribes drift on roughly the
/// scale of mutation; close mutants stay bonded, distant ones don't.
pub const BOND_MARKER_TOL: i32 = 4;
/// Max bonds per cell.
const MAX_BONDS: usize = 6;
/// Search radius (added to cell radius) for new bond partners.
/// Larger than the TS default (24) because our sparse demo
/// population would never form clusters at that range; tuned down
/// once a region-grid spawn pass lands.
const BOND_SEEK_RADIUS: f32 = 80.0;
/// Spring stiffness per second.
const BOND_SPRING_K: f32 = 4.0;
/// Bond breaks if cell centers exceed this multiple of their summed
/// radii.
const BOND_BREAK_MULTIPLIER: f32 = 4.0;
/// Tracked outside CreatureStore so the SoA stays pure-numeric
/// columns. Indexed by cell slot.
pub type BondList = Vec<Vec<u32>>;

pub fn make_bonds(n: usize) -> BondList {
    vec![Vec::new(); n]
}

pub fn resize_bonds(bonds: &mut BondList, n: usize) {
    if bonds.len() < n {
        bonds.resize(n, Vec::new());
    }
}

/// Drop bonds where either endpoint is out of range or no longer
/// holds enough CHEM_BOND. Then form new bonds for cells whose VM
/// fired SYNTH BOND this tick.
pub fn run_bonding(creatures: &mut CreatureStore, bonds: &mut BondList) {
    let n = creatures.n;
    resize_bonds(bonds, n);

    // Step 1: prune bonds that broke (out of pool or distance).
    #[allow(clippy::needless_range_loop)]
    #[allow(clippy::needless_range_loop)]
    for i in 0..n {
        let i_bond_pool = creatures.chems[CHEM_BOND][i];
        let mut keep = Vec::with_capacity(bonds[i].len());
        for &j_u32 in &bonds[i] {
            let j = j_u32 as usize;
            if j >= n {
                continue;
            }
            if i_bond_pool < BOND_FORMATION_THRESH
                || creatures.chems[CHEM_BOND][j] < BOND_FORMATION_THRESH
            {
                continue;
            }
            let dx = creatures.x[j] - creatures.x[i];
            let dy = creatures.y[j] - creatures.y[i];
            let dsq = dx * dx + dy * dy;
            let break_dist = (creatures.r[i] + creatures.r[j]) * BOND_BREAK_MULTIPLIER;
            if dsq > break_dist * break_dist {
                continue;
            }
            keep.push(j_u32);
        }
        bonds[i] = keep;
    }

    // Step 2: form new bonds. For each cell that expressed a bond
    // marker this tick, scan neighbours within seek radius and find
    // the nearest compatible-marker not-yet-bonded partner. Form a
    // single bond per tick per cell to keep cluster growth gradual.
    #[allow(clippy::needless_range_loop)]
    for i in 0..n {
        if bonds[i].len() >= MAX_BONDS {
            continue;
        }
        let marker_i = creatures.vm_out[i].bond_marker;
        if marker_i < 0 {
            continue;
        }
        if creatures.chems[CHEM_BOND][i] < BOND_FORMATION_THRESH {
            continue;
        }
        let cx = creatures.x[i];
        let cy = creatures.y[i];
        let cr = creatures.r[i];
        let seek = cr + BOND_SEEK_RADIUS;
        let mut best: Option<(usize, f32)> = None;
        for j in 0..n {
            if j == i || bonds[j].len() >= MAX_BONDS {
                continue;
            }
            // Already bonded?
            if bonds[i].iter().any(|&k| k as usize == j) {
                continue;
            }
            let marker_j = creatures.vm_out[j].bond_marker;
            if marker_j < 0 {
                continue;
            }
            if (marker_j - marker_i).abs() > BOND_MARKER_TOL {
                continue;
            }
            if creatures.chems[CHEM_BOND][j] < BOND_FORMATION_THRESH {
                continue;
            }
            let dx = creatures.x[j] - cx;
            let dy = creatures.y[j] - cy;
            let dsq = dx * dx + dy * dy;
            if dsq > seek * seek {
                continue;
            }
            let better = best.map_or(true, |(_, prev)| dsq < prev);
            if better {
                best = Some((j, dsq));
            }
        }
        if let Some((j, _)) = best {
            bonds[i].push(j as u32);
            bonds[j].push(i as u32);
        }
    }
}

/// Apply soft spring forces from bonds. Pulls bonded cell centers
/// toward their natural distance (sum of radii); the position update
/// in update_creatures then advects them. Bond pass needs to happen
/// before the position-advect step so the cells see the bond pull
/// the same tick.
pub fn apply_bond_springs(creatures: &mut CreatureStore, bonds: &BondList, dt: f32) {
    // The bond list may be shorter than the creature store when new
    // cells have been pushed in this tick before run_bonding caught
    // up. Iterate the intersection.
    let n = creatures.n.min(bonds.len());
    #[allow(clippy::needless_range_loop)]
    for i in 0..n {
        for &j_u32 in &bonds[i] {
            let j = j_u32 as usize;
            if j <= i || j >= n {
                // Visit each pair once
                continue;
            }
            let dx = creatures.x[j] - creatures.x[i];
            let dy = creatures.y[j] - creatures.y[i];
            let dsq = dx * dx + dy * dy;
            if dsq < 1e-6 {
                continue;
            }
            let d = dsq.sqrt();
            let natural = creatures.r[i] + creatures.r[j];
            let stretch = d - natural;
            // Hooke. Half the displacement on each cell so equal
            // masses converge symmetrically; the position-advect step
            // bakes the velocity in.
            let fx = BOND_SPRING_K * stretch * dx / d;
            let fy = BOND_SPRING_K * stretch * dy / d;
            creatures.vx[i] += fx * dt;
            creatures.vy[i] += fy * dt;
            creatures.vx[j] -= fx * dt;
            creatures.vy[j] -= fy * dt;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::NAMED_CHEMICAL_COUNT;
    use crate::creatures::CreatureInit;
    use crate::vm::VmOutputs;

    fn cell_at(x: f32, y: f32, bond_pool: f32, marker: i32) -> (CreatureInit, i32) {
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[CHEM_BOND] = bond_pool;
        let init = CreatureInit { x, y, r: 8.0, chems: Some(chems), ..CreatureInit::default() };
        (init, marker)
    }

    fn build(store_inits: Vec<(CreatureInit, i32)>) -> (CreatureStore, BondList) {
        let mut s = CreatureStore::new();
        let markers: Vec<i32> = store_inits.iter().map(|(_, m)| *m).collect();
        for (init, _) in store_inits {
            s.push(init);
        }
        for (i, &m) in markers.iter().enumerate() {
            s.vm_out[i] = VmOutputs::new();
            s.vm_out[i].bond_marker = m;
        }
        let bonds = make_bonds(s.n);
        (s, bonds)
    }

    #[test]
    fn same_marker_in_range_bonds() {
        let (mut s, mut b) = build(vec![
            cell_at(0.0, 0.0, 1.0, 50),
            cell_at(10.0, 0.0, 1.0, 51), // close marker, in range
        ]);
        run_bonding(&mut s, &mut b);
        assert_eq!(b[0].len(), 1);
        assert_eq!(b[1].len(), 1);
        assert_eq!(b[0][0], 1);
    }

    #[test]
    fn different_markers_dont_bond() {
        let (mut s, mut b) = build(vec![
            cell_at(0.0, 0.0, 1.0, 50),
            cell_at(10.0, 0.0, 1.0, 200), // way out of tolerance
        ]);
        run_bonding(&mut s, &mut b);
        assert_eq!(b[0].len(), 0);
        assert_eq!(b[1].len(), 0);
    }

    #[test]
    fn low_chem_bond_pool_blocks_bonding() {
        let (mut s, mut b) = build(vec![
            cell_at(0.0, 0.0, 0.05, 50), // below threshold
            cell_at(10.0, 0.0, 1.0, 51),
        ]);
        run_bonding(&mut s, &mut b);
        assert_eq!(b[0].len(), 0);
    }

    #[test]
    fn out_of_range_doesnt_bond() {
        let (mut s, mut b) = build(vec![
            cell_at(0.0, 0.0, 1.0, 50),
            cell_at(200.0, 0.0, 1.0, 51), // way past seek radius
        ]);
        run_bonding(&mut s, &mut b);
        assert_eq!(b[0].len(), 0);
    }

    #[test]
    fn bond_breaks_when_stretched() {
        let (mut s, mut b) = build(vec![
            cell_at(0.0, 0.0, 1.0, 50),
            cell_at(10.0, 0.0, 1.0, 51),
        ]);
        run_bonding(&mut s, &mut b);
        assert_eq!(b[0].len(), 1);
        // Now pull them apart past break distance.
        s.x[1] = 200.0;
        run_bonding(&mut s, &mut b);
        assert_eq!(b[0].len(), 0);
    }

    #[test]
    fn spring_pulls_bonded_cells_together() {
        let (mut s, mut b) = build(vec![
            cell_at(0.0, 0.0, 1.0, 50),
            cell_at(20.0, 0.0, 1.0, 50),
        ]);
        run_bonding(&mut s, &mut b);
        assert_eq!(b[0].len(), 1);
        apply_bond_springs(&mut s, &b, 1.0 / 60.0);
        // The cells were 20 apart, natural distance r0+r1 = 16. Stretch
        // = +4, so spring pulls them together.
        assert!(s.vx[0] > 0.0); // cell 0 accelerates +x toward cell 1
        assert!(s.vx[1] < 0.0); // cell 1 accelerates -x toward cell 0
    }
}
