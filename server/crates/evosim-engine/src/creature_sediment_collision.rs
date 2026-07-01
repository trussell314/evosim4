//! Creature-vs-sediment collision. Mineral particles (CHEM_MIN) are
//! heavy and inert; cells encountering them must push them aside
//! rather than ghost through. This is the Rust port of TS's
//! `resolveCreatureSedimentCollisions`. Only mineral-id particles
//! interact this way; other particles dissolve / decay too quickly
//! to make solid-body contact worth the cycles.
//!
//! Mass-weighted symmetric resolution: both bodies share the overlap
//! correction proportional to the other's mass (so a small cell
//! against a big mineral mostly nudges itself, not the rock). A
//! restitution e=0.2 gives a soft thud rather than an elastic bounce.
//!
//! This pass uses an O(N_p · grid_lookup) loop. We bin cells into a
//! uniform spatial grid at the cell radius scale (~16 px); each
//! mineral particle only checks the 3x3 cell-block neighbourhood
//! around its position. For typical demo populations (40-200 cells,
//! ~1k mineral particles) that's about 100-500 lookups per tick.

use crate::chem_ids::CHEM_MIN;
use crate::creatures::CreatureStore;
use crate::particles::ParticleStore;
use std::f32::consts::FRAC_PI_3;

/// Restitution coefficient. Low because sediment-cell contact is
/// closer to a thump than a bounce.
const E: f32 = 0.2;
/// Hash-grid cell size in world units. Slightly larger than the
/// largest expected cell radius so a typical cell only touches one
/// bucket; 3x3 neighbour scan still catches edge cases.
const GRID_CELL: f32 = 32.0;

pub fn run_creature_sediment_collisions(
    creatures: &mut CreatureStore,
    particles: &mut ParticleStore,
    width: f32,
    height: f32,
) -> usize {
    let nc = creatures.n;
    if nc == 0 || particles.is_empty() {
        return 0;
    }
    // Bin cell indices by grid cell. Allocate once per pass; tiny
    // (~few KB) and keeps the hot loop branch-free of resize chatter.
    let cols = ((width / GRID_CELL).ceil() as usize).max(1);
    let rows = ((height / GRID_CELL).ceil() as usize).max(1);
    let mut head: Vec<i32> = vec![-1; cols * rows];
    let mut next: Vec<i32> = vec![-1; nc];
    for (i, slot) in next.iter_mut().enumerate() {
        let gx = ((creatures.x[i] / GRID_CELL) as i32).clamp(0, cols as i32 - 1) as usize;
        let gy = ((creatures.y[i] / GRID_CELL) as i32).clamp(0, rows as i32 - 1) as usize;
        let bin = gy * cols + gx;
        *slot = head[bin];
        head[bin] = i as i32;
    }

    let mut hits = 0usize;
    for pi in 0..particles.len() {
        if particles.chem_id[pi] as usize != CHEM_MIN {
            continue;
        }
        let px = particles.x[pi];
        let py = particles.y[pi];
        let pr = particles.r[pi];
        // Particle "mass" approx 4/3 · π · r³ · density; we treat the
        // 4π/3 as a constant FRAC_PI_3 * 4 to avoid repeated work.
        let density = if particles.density[pi] > 0.0 { particles.density[pi] } else { 1.0 };
        let pm = (4.0 * FRAC_PI_3 * pr * pr * pr * density).max(0.01);
        let gx = ((px / GRID_CELL) as i32).clamp(0, cols as i32 - 1) as usize;
        let gy = ((py / GRID_CELL) as i32).clamp(0, rows as i32 - 1) as usize;
        for dy in [-1i32, 0, 1] {
            for dx in [-1i32, 0, 1] {
                let nx = gx as i32 + dx;
                let ny = gy as i32 + dy;
                if nx < 0 || ny < 0 || nx >= cols as i32 || ny >= rows as i32 {
                    continue;
                }
                let bin = ny as usize * cols + nx as usize;
                let mut idx = head[bin];
                while idx >= 0 {
                    let i = idx as usize;
                    idx = next[i];
                    let cx = creatures.x[i];
                    let cy = creatures.y[i];
                    let cr = creatures.r[i];
                    let min_d = cr + pr;
                    let dx_v = cx - px;
                    let dy_v = cy - py;
                    let dsq = dx_v * dx_v + dy_v * dy_v;
                    if dsq >= min_d * min_d {
                        continue;
                    }
                    let dist = dsq.sqrt();
                    let (nxv, nyv) = if dist < 1e-6 {
                        (0.0, -1.0)
                    } else {
                        (dx_v / dist, dy_v / dist)
                    };
                    let dist = if dist < 1e-6 { 1.0 } else { dist };
                    let overlap = min_d - dist;
                    let cm = creatures.total_mass(i).max(0.01);
                    let total = pm + cm;
                    let c_share = pm / total;
                    let p_share = cm / total;
                    creatures.x[i] += nxv * overlap * c_share;
                    creatures.y[i] += nyv * overlap * c_share;
                    particles.x[pi] -= nxv * overlap * p_share;
                    particles.y[pi] -= nyv * overlap * p_share;
                    let rvx = creatures.vx[i] - particles.vx[pi];
                    let rvy = creatures.vy[i] - particles.vy[pi];
                    let v_n = rvx * nxv + rvy * nyv;
                    if v_n < 0.0 {
                        let j_imp = -(1.0 + E) * v_n / (1.0 / cm + 1.0 / pm);
                        let ix = nxv * j_imp;
                        let iy = nyv * j_imp;
                        creatures.vx[i] += ix / cm;
                        creatures.vy[i] += iy / cm;
                        particles.vx[pi] -= ix / pm;
                        particles.vy[pi] -= iy / pm;
                    }
                    hits += 1;
                }
            }
        }
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::{CHEM_GLU, CHEM_MIN, NAMED_CHEMICAL_COUNT};
    use crate::creatures::CreatureInit;
    use crate::particles::ParticleInit;

    fn cell(x: f32, y: f32, r: f32) -> CreatureInit {
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[CHEM_GLU] = 10.0;
        CreatureInit { x, y, r, chems: Some(chems), ..CreatureInit::default() }
    }
    fn min_particle(x: f32, y: f32, r: f32) -> ParticleInit {
        ParticleInit { x, y, r, chem_id: CHEM_MIN as u8, density: 1.5, ..ParticleInit::default() }
    }

    #[test]
    fn cell_pushes_mineral_off_collision_path() {
        let mut cs = CreatureStore::new();
        let mut ps = ParticleStore::new();
        cs.push(cell(100.0, 100.0, 8.0));
        // Mineral overlapping the cell -- should be displaced.
        ps.push(min_particle(102.0, 100.0, 4.0));
        let px0 = ps.x[0];
        run_creature_sediment_collisions(&mut cs, &mut ps, 200.0, 200.0);
        assert!(ps.x[0] > px0, "mineral should be pushed right of {px0}, got {}", ps.x[0]);
    }

    #[test]
    fn non_mineral_particles_ignored() {
        let mut cs = CreatureStore::new();
        let mut ps = ParticleStore::new();
        cs.push(cell(100.0, 100.0, 8.0));
        // Glucose particle inside the cell; should NOT be pushed.
        ps.push(ParticleInit {
            x: 102.0,
            y: 100.0,
            r: 4.0,
            chem_id: CHEM_GLU as u8,
            density: 1.0,
            ..ParticleInit::default()
        });
        let px0 = ps.x[0];
        run_creature_sediment_collisions(&mut cs, &mut ps, 200.0, 200.0);
        assert_eq!(ps.x[0], px0, "non-mineral must pass through cleanly");
    }

    #[test]
    fn no_overlap_means_no_movement() {
        let mut cs = CreatureStore::new();
        let mut ps = ParticleStore::new();
        cs.push(cell(100.0, 100.0, 8.0));
        // Mineral well outside reach.
        ps.push(min_particle(300.0, 100.0, 4.0));
        let cx0 = cs.x[0];
        let px0 = ps.x[0];
        run_creature_sediment_collisions(&mut cs, &mut ps, 400.0, 200.0);
        assert_eq!(cs.x[0], cx0);
        assert_eq!(ps.x[0], px0);
    }
}
