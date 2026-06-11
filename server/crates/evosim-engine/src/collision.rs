//! Particle-particle collision pass, ported from
//! `src/sim/collision.ts`. Spatial hash on a `GRID_CELL_SIZE` (=12)
//! grid, Jacobi pair resolution (read frozen positions, write into
//! per-particle delta accumulators, apply once at the end of each
//! sweep). `World::collision_iters` (TS default 2) controls
//! convergence; each iteration rebuilds the grid from the updated
//! positions.
//!
//! The TS code carries a parallel two-phase row-parity dispatcher for
//! a worker pool. Rust runs serially today; rayon parallelism arrives
//! when the cost is worth the dispatch overhead (the TS threshold is
//! 4000 particles -- below that the serial path beats the round trip).
//!
//! Sleep heuristic: a particle whose speed has been < sqrt(25) px/s
//! for >= 30 consecutive ticks is flagged asleep. The collision
//! kernel skips pairs where BOTH endpoints are asleep, which makes
//! settled sediment effectively free.

use crate::chemistry::table as chem_table;
use crate::particles::ParticleStore;
use crate::world::World;

/// Spatial-hash cell size, pixels. Matches TS `GRID_CELL_SIZE`.
pub const GRID_CELL_SIZE: f32 = 12.0;

/// Sleep threshold on squared speed. Below this for
/// `SLEEP_THRESHOLD_TICKS` ticks the particle gets flagged asleep.
const SLEEP_SPEED_SQ: f32 = 25.0;

/// Consecutive ticks at low speed before sleep flag flips.
const SLEEP_THRESHOLD_TICKS: i32 = 30;

const FOUR_THIRDS_PI: f32 = 4.0 / 3.0 * std::f32::consts::PI;

/// Per-tick scratch buffers reused across collision passes. Owning
/// these on the engine avoids per-call allocation in the hot path.
#[derive(Debug, Default)]
pub struct CollisionScratch {
    pub asleep: Vec<u8>,
    pub mass: Vec<f32>,
    cell_start: Vec<i32>,
    cell_items: Vec<i32>,
    cell_of_part: Vec<i32>,
    cell_cursor: Vec<i32>,
    dpx: Vec<f32>,
    dpy: Vec<f32>,
    dpz: Vec<f32>,
    dvx: Vec<f32>,
    dvy: Vec<f32>,
    dvz: Vec<f32>,
}

impl CollisionScratch {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Resolve particle-particle collisions in-place. Mirrors the serial
/// path of TS `resolveCollisions` -- the parallel dispatcher is
/// unused here (rayon arrives when warranted by particle count).
pub fn resolve_collisions(world: &mut World, scratch: &mut CollisionScratch) {
    let store = &mut world.particle_store;
    let n = store.n;
    if n < 2 {
        return;
    }
    let cell_size = GRID_CELL_SIZE;
    let cols = ((world.width / cell_size).ceil() as usize).max(1);
    let rows = ((world.height / cell_size).ceil() as usize).max(1);
    let cell_count = cols * rows;

    let chem_base = &chem_table().base_density[..];

    // ----- Resize scratch buffers as needed.
    if scratch.mass.len() < n {
        scratch.mass.resize(n, 0.0);
    }
    if scratch.asleep.len() < n {
        scratch.asleep.resize(n, 0);
    }
    if scratch.cell_of_part.len() < n {
        scratch.cell_of_part.resize(n, 0);
    }
    if scratch.cell_start.len() < cell_count + 1 {
        scratch.cell_start.resize(cell_count + 1, 0);
    }
    if scratch.cell_cursor.len() < cell_count {
        scratch.cell_cursor.resize(cell_count, 0);
    }
    if scratch.cell_items.len() < n {
        scratch.cell_items.resize(n, 0);
    }
    for buf in [
        &mut scratch.dpx,
        &mut scratch.dpy,
        &mut scratch.dpz,
        &mut scratch.dvx,
        &mut scratch.dvy,
        &mut scratch.dvz,
    ] {
        if buf.len() < n {
            buf.resize(n, 0.0);
        }
    }

    // ----- Mass + sleep classification (matches TS preface block).
    for i in 0..n {
        let r = store.r[i];
        let d = if store.density[i] != 0.0 {
            store.density[i]
        } else {
            chem_base[store.chem_id[i] as usize]
        };
        scratch.mass[i] = d * FOUR_THIRDS_PI * r * r * r;
        let vx = store.vx[i];
        let vy = store.vy[i];
        let vz = store.vz[i];
        let v2 = vx * vx + vy * vy + vz * vz;
        if v2 < SLEEP_SPEED_SQ {
            store.quiet_ticks[i] += 1;
            scratch.asleep[i] = if store.quiet_ticks[i] >= SLEEP_THRESHOLD_TICKS {
                1
            } else {
                0
            };
        } else {
            store.quiet_ticks[i] = 0;
            scratch.asleep[i] = 0;
        }
    }

    // ----- Iterative Jacobi sweeps.
    for _pass in 0..world.collision_iters {
        // Build cellStart by counting per cell.
        for slot in scratch.cell_start.iter_mut().take(cell_count + 1) {
            *slot = 0;
        }
        for pi in 0..n {
            let mut cx = (store.x[pi] / cell_size) as i32;
            let mut cy = (store.y[pi] / cell_size) as i32;
            if cx < 0 {
                cx = 0;
            } else if cx >= cols as i32 {
                cx = cols as i32 - 1;
            }
            if cy < 0 {
                cy = 0;
            } else if cy >= rows as i32 {
                cy = rows as i32 - 1;
            }
            let ci = (cy as usize) * cols + cx as usize;
            scratch.cell_of_part[pi] = ci as i32;
            scratch.cell_start[ci + 1] += 1;
        }
        // Prefix sum: cellStart[i+1] - cellStart[i] = count.
        for i in 1..=cell_count {
            scratch.cell_start[i] += scratch.cell_start[i - 1];
        }
        // Place particles via per-cell cursor.
        for c in scratch.cell_cursor.iter_mut().take(cell_count) {
            *c = 0;
        }
        for pi in 0..n {
            let ci = scratch.cell_of_part[pi] as usize;
            let slot = scratch.cell_start[ci] + scratch.cell_cursor[ci];
            scratch.cell_cursor[ci] += 1;
            scratch.cell_items[slot as usize] = pi as i32;
        }

        // Clear delta accumulators.
        for buf in [
            &mut scratch.dpx,
            &mut scratch.dpy,
            &mut scratch.dpz,
            &mut scratch.dvx,
            &mut scratch.dvy,
            &mut scratch.dvz,
        ] {
            for slot in buf.iter_mut().take(n) {
                *slot = 0.0;
            }
        }

        // Cell-by-cell pair resolution. Within-cell pairs + 4
        // downstream neighbors per cell (E, SW, S, SE) so every pair
        // is enumerated exactly once.
        let e = world.restitution;
        for cy in 0..rows as i32 {
            for cx in 0..cols as i32 {
                let ci = (cy as usize) * cols + cx as usize;
                let s0 = scratch.cell_start[ci];
                let s1 = scratch.cell_start[ci + 1];
                if s1 == s0 {
                    continue;
                }
                // Within-cell pairs.
                for ii in s0..s1 {
                    let ai = scratch.cell_items[ii as usize] as usize;
                    for jj in (ii + 1)..s1 {
                        let bi = scratch.cell_items[jj as usize] as usize;
                        resolve_pair(store, scratch, ai, bi, e);
                    }
                }
                // Downstream neighbours.
                check_neighbor(store, scratch, cols, rows, ci, cx + 1, cy, e);
                check_neighbor(store, scratch, cols, rows, ci, cx - 1, cy + 1, e);
                check_neighbor(store, scratch, cols, rows, ci, cx, cy + 1, e);
                check_neighbor(store, scratch, cols, rows, ci, cx + 1, cy + 1, e);
            }
        }

        // Apply summed deltas back to live arrays.
        for i in 0..n {
            store.x[i] += scratch.dpx[i];
            store.y[i] += scratch.dpy[i];
            store.z[i] += scratch.dpz[i];
            store.vx[i] += scratch.dvx[i];
            store.vy[i] += scratch.dvy[i];
            store.vz[i] += scratch.dvz[i];
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn check_neighbor(
    store: &ParticleStore,
    scratch: &mut CollisionScratch,
    cols: usize,
    rows: usize,
    ci: usize,
    nx: i32,
    ny: i32,
    e: f32,
) {
    if nx < 0 || nx >= cols as i32 || ny < 0 || ny >= rows as i32 {
        return;
    }
    let ni = (ny as usize) * cols + nx as usize;
    let ns0 = scratch.cell_start[ni];
    let ns1 = scratch.cell_start[ni + 1];
    if ns1 == ns0 {
        return;
    }
    let s0 = scratch.cell_start[ci];
    let s1 = scratch.cell_start[ci + 1];
    for ii in s0..s1 {
        let ai = scratch.cell_items[ii as usize] as usize;
        for jj in ns0..ns1 {
            let bi = scratch.cell_items[jj as usize] as usize;
            resolve_pair(store, scratch, ai, bi, e);
        }
    }
}

/// Jacobi pair resolution: read PX/PVX (frozen for the sweep), write
/// the position + velocity correction for both endpoints into the
/// delta accumulators. The TS version of this function is the
/// `resolvePairSoa` inner. The math is identical -- the only Rust-
/// specific detail is that we take a `&ParticleStore` (read-only)
/// plus a `&mut CollisionScratch` to avoid aliasing through the same
/// mutable reference.
fn resolve_pair(
    store: &ParticleStore,
    scratch: &mut CollisionScratch,
    i: usize,
    j: usize,
    e: f32,
) {
    if scratch.asleep[i] != 0 && scratch.asleep[j] != 0 {
        return;
    }
    let ax = store.x[i];
    let ay = store.y[i];
    let az = store.z[i];
    let bx = store.x[j];
    let by = store.y[j];
    let bz = store.z[j];
    let dx = bx - ax;
    let dy = by - ay;
    let dz = bz - az;
    let min_dist = store.r[i] + store.r[j];
    let dist_sq = dx * dx + dy * dy + dz * dz;
    if dist_sq >= min_dist * min_dist {
        return;
    }
    // Coincident particles: degenerate normal would NaN. Pick an
    // arbitrary axis; the next sweep will resolve any residual
    // overlap properly.
    let (dist, nxv, nyv, nzv) = if dist_sq < 1e-12 {
        (1.0, 1.0, 0.0, 0.0)
    } else {
        let d = dist_sq.sqrt();
        (d, dx / d, dy / d, dz / d)
    };
    let overlap = min_dist - dist;
    let ma = scratch.mass[i];
    let mb = scratch.mass[j];
    let total = ma + mb;
    let corr_a = overlap * (mb / total);
    let corr_b = overlap * (ma / total);
    scratch.dpx[i] -= nxv * corr_a;
    scratch.dpy[i] -= nyv * corr_a;
    scratch.dpz[i] -= nzv * corr_a;
    scratch.dpx[j] += nxv * corr_b;
    scratch.dpy[j] += nyv * corr_b;
    scratch.dpz[j] += nzv * corr_b;
    let avx = store.vx[i];
    let avy = store.vy[i];
    let avz = store.vz[i];
    let bvx = store.vx[j];
    let bvy = store.vy[j];
    let bvz = store.vz[j];
    let rvx = bvx - avx;
    let rvy = bvy - avy;
    let rvz = bvz - avz;
    let v_n = rvx * nxv + rvy * nyv + rvz * nzv;
    if v_n >= 0.0 {
        return;
    }
    let j_imp = -(1.0 + e) * v_n / (1.0 / ma + 1.0 / mb);
    let ix = nxv * j_imp;
    let iy = nyv * j_imp;
    let iz = nzv * j_imp;
    scratch.dvx[i] -= ix / ma;
    scratch.dvy[i] -= iy / ma;
    scratch.dvz[i] -= iz / ma;
    scratch.dvx[j] += ix / mb;
    scratch.dvy[j] += iy / mb;
    scratch.dvz[j] += iz / mb;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::particles::ParticleInit;

    fn solid_particle(x: f32, y: f32, r: f32) -> ParticleInit {
        ParticleInit { x, y, r, density: 1.0, chem_id: 0, ..ParticleInit::default() }
    }

    #[test]
    fn no_collisions_at_n_lt_2_is_noop() {
        let mut w = World::new(800.0, 600.0, 1);
        let mut scratch = CollisionScratch::new();
        resolve_collisions(&mut w, &mut scratch);
        w.particle_store.push(solid_particle(100.0, 100.0, 5.0));
        resolve_collisions(&mut w, &mut scratch);
        // No panic, no movement.
        assert_eq!(w.particle_store.x[0], 100.0);
    }

    #[test]
    fn overlapping_particles_separate() {
        let mut w = World::new(800.0, 600.0, 1);
        let mut scratch = CollisionScratch::new();
        // Two particles fully overlapping each other -- collision should
        // push them apart along the resolved normal axis.
        w.particle_store.push(solid_particle(100.0, 100.0, 5.0));
        w.particle_store.push(solid_particle(101.0, 100.0, 5.0));
        let x0_before = w.particle_store.x[0];
        let x1_before = w.particle_store.x[1];
        resolve_collisions(&mut w, &mut scratch);
        let x0_after = w.particle_store.x[0];
        let x1_after = w.particle_store.x[1];
        // They should have moved apart.
        let sep_before = (x1_before - x0_before).abs();
        let sep_after = (x1_after - x0_after).abs();
        assert!(sep_after > sep_before, "sep {sep_before} -> {sep_after}");
    }

    #[test]
    fn pair_at_rest_keeps_v_zero() {
        // Two particles in contact, both at rest -- the position
        // correction should keep them apart but velocities should stay
        // ~zero (no spurious kick).
        let mut w = World::new(800.0, 600.0, 1);
        let mut scratch = CollisionScratch::new();
        w.particle_store.push(solid_particle(100.0, 100.0, 5.0));
        w.particle_store.push(solid_particle(105.0, 100.0, 5.0));
        resolve_collisions(&mut w, &mut scratch);
        assert!(w.particle_store.vx[0].abs() < 1e-3);
        assert!(w.particle_store.vx[1].abs() < 1e-3);
    }

    #[test]
    fn head_on_collision_reverses_relative_velocity() {
        // 1D head-on: equal masses moving towards each other should
        // bounce back with their velocities swapped (e=0.8 here, so
        // slightly damped).
        let mut w = World::new(800.0, 600.0, 1);
        let mut scratch = CollisionScratch::new();
        w.particle_store.push(ParticleInit { x: 100.0, y: 100.0, r: 5.0, vx: 10.0, density: 1.0, ..ParticleInit::default() });
        w.particle_store.push(ParticleInit { x: 108.0, y: 100.0, r: 5.0, vx: -10.0, density: 1.0, ..ParticleInit::default() });
        resolve_collisions(&mut w, &mut scratch);
        // Post collision: vx[0] should be negative (bounced back),
        // vx[1] positive.
        assert!(w.particle_store.vx[0] < 0.0, "vx[0]={}", w.particle_store.vx[0]);
        assert!(w.particle_store.vx[1] > 0.0, "vx[1]={}", w.particle_store.vx[1]);
    }

    #[test]
    fn far_particles_dont_interact() {
        let mut w = World::new(800.0, 600.0, 1);
        let mut scratch = CollisionScratch::new();
        w.particle_store.push(solid_particle(100.0, 100.0, 5.0));
        w.particle_store.push(solid_particle(400.0, 400.0, 5.0));
        resolve_collisions(&mut w, &mut scratch);
        // No movement on either.
        assert_eq!(w.particle_store.x[0], 100.0);
        assert_eq!(w.particle_store.x[1], 400.0);
        assert_eq!(w.particle_store.vx[0], 0.0);
        assert_eq!(w.particle_store.vx[1], 0.0);
    }

    #[test]
    fn asleep_pair_is_skipped() {
        // Both quiet for >= SLEEP_THRESHOLD_TICKS -> asleep -> pair
        // is skipped even though they overlap.
        let mut w = World::new(800.0, 600.0, 1);
        let mut scratch = CollisionScratch::new();
        w.particle_store.push(solid_particle(100.0, 100.0, 5.0));
        w.particle_store.push(solid_particle(101.0, 100.0, 5.0));
        // Pump the quiet counter past the threshold for both.
        w.particle_store.quiet_ticks[0] = SLEEP_THRESHOLD_TICKS;
        w.particle_store.quiet_ticks[1] = SLEEP_THRESHOLD_TICKS;
        // First pass classifies; second pass skips the overlap.
        resolve_collisions(&mut w, &mut scratch);
        let x_after = (w.particle_store.x[0], w.particle_store.x[1]);
        // Both still asleep -- a follow-up resolve should leave the
        // positions unchanged.
        let x_before_second = x_after;
        resolve_collisions(&mut w, &mut scratch);
        assert_eq!(
            (w.particle_store.x[0], w.particle_store.x[1]),
            x_before_second
        );
    }
}
