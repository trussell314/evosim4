//! Static-terrain collision: spatial index + per-tick push-out passes.
//!
//! Substrate port of `src/sim/obstacle-collision.ts`. The obstacle
//! geometry is static (terrain doesn't move), so the index is built
//! once per world via [`ObstacleIndex::rebuild`] and reused every tick.
//! [`resolve_obstacle_collisions`] is the hot path: a single SoA
//! sweep over particles + a per-cell sweep over creatures, both
//! rejecting via the cell-bitmap before walking lobes.
//!
//! What's NOT here vs the TS pass:
//!   - rock-aware ambient redirect (`depositRegionBase` -- the
//!     no-flux dissolve mass redirected to the nearest water region)
//!     -- folded into the regions module instead
//!   - per-particle generic-molecules handling on the evacuate path
//!     (`store.molecules`) -- our particle SoA doesn't carry sparse
//!     molecule maps yet
//!   - asleep-particle skip (`ASLEEP` array) -- we don't track sleep
//!     state on particles; the cell-bitmap early-reject is the real
//!     fast path

use crate::ambient::{AmbientField, AMBIENT_STRIDE};
use crate::chem_ids::NAMED_CHEMICAL_COUNT;
use crate::chemistry::table as chem_table;
use crate::creatures::CreatureStore;
use crate::particles::ParticleStore;
use crate::terrain::{nearest_polygon_edge_point, point_in_polygon, Obstacle};

/// Cell size (px) for the obstacle bitmap + per-cell lobe index.
const OBSTACLE_CELL_SIZE: f32 = 12.0;
/// Margin added when registering an obstacle / lobe into the bitmap
/// and the lobe lists. Matches the TS value so the two indices agree
/// on what "near" means.
const OBSTACLE_BITMAP_MARGIN: f32 = 6.0;

/// Static obstacle spatial index. Built once per world; consumed by
/// the collision sweeps and the evacuation pass.
#[derive(Debug, Default)]
pub struct ObstacleIndex {
    /// Lowest y across all obstacles. Particles whose `y + r` are
    /// above this can skip the per-particle spatial lookup.
    pub min_y: f32,
    pub cell_cols: usize,
    pub cell_rows: usize,
    /// Per-cell flag: 1 if any obstacle's AABB (with margin) covers
    /// this cell. Bytewise dense for cache friendliness.
    pub cell_grid: Vec<u8>,
    /// Prefix-sum offsets into `cell_lobe_data`. Length = cells + 1.
    pub cell_lobe_start: Vec<i32>,
    /// Flat list of `(obstacle_idx, lobe_idx)` pairs covering each
    /// cell. Indexed by `cell_lobe_start[ci]..cell_lobe_start[ci+1]`.
    pub cell_lobe_data: Vec<(u32, u32)>,
}

impl ObstacleIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Rebuild the bitmap + lobe lists from the world's obstacle
    /// geometry. Idempotent; safe to call from anywhere the obstacle
    /// vec might have changed.
    pub fn rebuild(&mut self, obstacles: &[Obstacle], world_width: f32, world_height: f32) {
        self.min_y = f32::INFINITY;
        for ob in obstacles {
            if ob.min_y < self.min_y {
                self.min_y = ob.min_y;
            }
        }
        let margin = OBSTACLE_BITMAP_MARGIN;
        let cell_size = OBSTACLE_CELL_SIZE;
        self.cell_cols = ((world_width / cell_size).ceil() as usize).max(1);
        self.cell_rows = ((world_height / cell_size).ceil() as usize).max(1);
        let n_cells = self.cell_cols * self.cell_rows;
        self.cell_grid = vec![0; n_cells];
        for ob in obstacles {
            let x0 = (((ob.min_x - margin) / cell_size).floor() as i32).max(0) as usize;
            let x1 = (((ob.max_x + margin) / cell_size).floor() as i32)
                .min(self.cell_cols as i32 - 1) as usize;
            let y0 = (((ob.min_y - margin) / cell_size).floor() as i32).max(0) as usize;
            let y1 = (((ob.max_y + margin) / cell_size).floor() as i32)
                .min(self.cell_rows as i32 - 1) as usize;
            for y in y0..=y1 {
                let row = y * self.cell_cols;
                for x in x0..=x1 {
                    self.cell_grid[row + x] = 1;
                }
            }
        }
        // Pass 1: count entries per cell into cell_lobe_start[ci+1].
        self.cell_lobe_start = vec![0_i32; n_cells + 1];
        for ob in obstacles {
            for l in &ob.lobes {
                let x0 = (((l.x - l.r - margin) / cell_size).floor() as i32).max(0) as usize;
                let x1 = (((l.x + l.r + margin) / cell_size).floor() as i32)
                    .min(self.cell_cols as i32 - 1) as usize;
                let y0 = (((l.y - l.r - margin) / cell_size).floor() as i32).max(0) as usize;
                let y1 = (((l.y + l.r + margin) / cell_size).floor() as i32)
                    .min(self.cell_rows as i32 - 1) as usize;
                for y in y0..=y1 {
                    let row = y * self.cell_cols;
                    for x in x0..=x1 {
                        self.cell_lobe_start[row + x + 1] += 1;
                    }
                }
            }
        }
        // Pass 2: prefix sum -> turn counts into start offsets.
        for i in 1..=n_cells {
            self.cell_lobe_start[i] += self.cell_lobe_start[i - 1];
        }
        let total = self.cell_lobe_start[n_cells] as usize;
        self.cell_lobe_data = vec![(0, 0); total];
        // Cursor copy so we can advance per-cell without losing
        // start offsets.
        let mut cursor: Vec<i32> = self.cell_lobe_start[..n_cells].to_vec();
        for (ob_idx, ob) in obstacles.iter().enumerate() {
            for (lobe_idx, l) in ob.lobes.iter().enumerate() {
                let x0 = (((l.x - l.r - margin) / cell_size).floor() as i32).max(0) as usize;
                let x1 = (((l.x + l.r + margin) / cell_size).floor() as i32)
                    .min(self.cell_cols as i32 - 1) as usize;
                let y0 = (((l.y - l.r - margin) / cell_size).floor() as i32).max(0) as usize;
                let y1 = (((l.y + l.r + margin) / cell_size).floor() as i32)
                    .min(self.cell_rows as i32 - 1) as usize;
                for y in y0..=y1 {
                    let row = y * self.cell_cols;
                    for x in x0..=x1 {
                        let ci = row + x;
                        let e = cursor[ci] as usize;
                        cursor[ci] += 1;
                        self.cell_lobe_data[e] = (ob_idx as u32, lobe_idx as u32);
                    }
                }
            }
        }
    }

    /// Cell index for a world position (clamped to grid).
    #[inline]
    fn cell_at(&self, x: f32, y: f32) -> Option<usize> {
        if self.cell_grid.is_empty() {
            return None;
        }
        let gcx = (x / OBSTACLE_CELL_SIZE) as i32;
        let gcy = (y / OBSTACLE_CELL_SIZE) as i32;
        let gcx = gcx.clamp(0, self.cell_cols as i32 - 1) as usize;
        let gcy = gcy.clamp(0, self.cell_rows as i32 - 1) as usize;
        Some(gcy * self.cell_cols + gcx)
    }

    /// True if the cell at `(x, y)` is flagged as touching rock.
    pub fn cell_has_rock(&self, x: f32, y: f32) -> bool {
        match self.cell_at(x, y) {
            Some(ci) => self.cell_grid.get(ci).copied().unwrap_or(0) != 0,
            None => false,
        }
    }
}

/// Mutable body state the per-cell collision helper writes back.
struct BodyOut {
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
}

/// Process every lobe entry indexed by cell `ci` against a single
/// moving body. Polygon-edge resolve when the obstacle has a polygon;
/// per-lobe pushback otherwise. Mirrors `processObstaclesAtCell` in
/// the TS source line-for-line so the iteration order (and the
/// resulting collision response) is identical.
#[allow(clippy::too_many_arguments)]
fn process_at_cell(
    index: &ObstacleIndex,
    obstacles: &[Obstacle],
    ci: usize,
    ox: f32,
    oy: f32,
    ovx: f32,
    ovy: f32,
    rk: f32,
    restitution: f32,
) -> BodyOut {
    let start = index.cell_lobe_start[ci] as usize;
    let end = index.cell_lobe_start[ci + 1] as usize;
    let mut out = BodyOut {
        x: ox,
        y: oy,
        vx: ovx,
        vy: ovy,
    };
    if start == end {
        return out;
    }
    let mut last_ob: i32 = -1;
    let mut last_ob_skip = false;
    let mut last_ob_has_poly = false;
    for pos in start..end {
        let (ob_idx, lobe_idx) = index.cell_lobe_data[pos];
        if ob_idx as i32 != last_ob {
            last_ob = ob_idx as i32;
            last_ob_skip = false;
            let ob = &obstacles[ob_idx as usize];
            if out.x + rk < ob.min_x
                || out.x - rk > ob.max_x
                || out.y + rk < ob.min_y
                || out.y - rk > ob.max_y
            {
                last_ob_skip = true;
                continue;
            }
            last_ob_has_poly = ob.polygon.is_some();
        } else if last_ob_skip {
            continue;
        }
        let ob = &obstacles[ob_idx as usize];
        let lobe = &ob.lobes[lobe_idx as usize];
        if last_ob_has_poly {
            let poly = ob.polygon.as_ref().expect("checked above");
            // Lobe fast-reject first.
            let dx = out.x - lobe.x;
            let dy = out.y - lobe.y;
            let min_dist = rk + lobe.r;
            if dx * dx + dy * dy >= min_dist * min_dist {
                continue;
            }
            // Walk polygon edges: nearest point + horizontal-ray
            // crossings for inside/outside in a single pass.
            let mut best_x = 0.0_f32;
            let mut best_y = 0.0_f32;
            let mut best_d2 = f32::INFINITY;
            let mut crossings = 0_i32;
            let pl = poly.len();
            let mut jj = pl - 1;
            for j2 in 0..pl {
                let ax = poly[jj].x;
                let ay = poly[jj].y;
                let bxp = poly[j2].x;
                let byp = poly[j2].y;
                let ex = bxp - ax;
                let ey = byp - ay;
                let len_sq = ex * ex + ey * ey;
                let mut t = 0.0_f32;
                if len_sq > 1e-12 {
                    t = ((out.x - ax) * ex + (out.y - ay) * ey) / len_sq;
                    t = t.clamp(0.0, 1.0);
                }
                let epx = ax + ex * t;
                let epy = ay + ey * t;
                let ddx = epx - out.x;
                let ddy = epy - out.y;
                let d2 = ddx * ddx + ddy * ddy;
                if d2 < best_d2 {
                    best_d2 = d2;
                    best_x = epx;
                    best_y = epy;
                }
                if (ay > out.y) != (byp > out.y) {
                    let x_int = (bxp - ax) * (out.y - ay) / (byp - ay + 1e-12) + ax;
                    if out.x < x_int {
                        crossings += 1;
                    }
                }
                jj = j2;
            }
            let is_inside = (crossings & 1) == 1;
            let d = best_d2.sqrt();
            if !is_inside && d >= rk {
                last_ob_skip = true;
                continue;
            }
            let (nx, ny, depth);
            if d < 1e-6 {
                nx = 1.0;
                ny = 0.0;
                depth = if is_inside { rk } else { 0.0 };
            } else if is_inside {
                nx = (best_x - out.x) / d;
                ny = (best_y - out.y) / d;
                depth = rk + d;
            } else {
                nx = (out.x - best_x) / d;
                ny = (out.y - best_y) / d;
                depth = rk - d;
            }
            out.x += nx * depth;
            out.y += ny * depth;
            let v_n = out.vx * nx + out.vy * ny;
            if v_n < 0.0 {
                out.vx -= (1.0 + restitution) * v_n * nx;
                out.vy -= (1.0 + restitution) * v_n * ny;
            }
            last_ob_skip = true;
        } else {
            // No polygon: per-lobe pushback.
            let dx = out.x - lobe.x;
            let dy = out.y - lobe.y;
            let min_dist = rk + lobe.r;
            let d2 = dx * dx + dy * dy;
            if d2 >= min_dist * min_dist {
                continue;
            }
            let (nx, ny) = if d2 < 1e-12 {
                (1.0_f32, 0.0_f32)
            } else {
                let d = d2.sqrt();
                (dx / d, dy / d)
            };
            let d = d2.sqrt().max(1e-6);
            let overlap = min_dist - d;
            out.x += nx * overlap;
            out.y += ny * overlap;
            let v_n = out.vx * nx + out.vy * ny;
            if v_n < 0.0 {
                out.vx -= (1.0 + restitution) * v_n * nx;
                out.vy -= (1.0 + restitution) * v_n * ny;
            }
        }
    }
    out
}

/// Per-tick collision pass: push particles and creatures back out of
/// rock. No-op when there are no obstacles. Restitution comes from
/// the world's collision settings; the creature pass uses a softer
/// constant (TS uses 0.1) so cells don't ping off rock.
pub fn resolve_obstacle_collisions(
    obstacles: &[Obstacle],
    index: &ObstacleIndex,
    particles: &mut ParticleStore,
    creatures: &mut CreatureStore,
    restitution: f32,
) {
    if obstacles.is_empty() || index.cell_grid.is_empty() {
        return;
    }
    let min_y = index.min_y;
    // Particles.
    for k in 0..particles.len() {
        let yk = particles.y[k];
        let rk = particles.r[k];
        if yk + rk < min_y {
            continue;
        }
        let xk = particles.x[k];
        if !xk.is_finite() || !yk.is_finite() || !rk.is_finite() {
            continue;
        }
        let Some(ci) = index.cell_at(xk, yk) else { continue };
        if index.cell_grid[ci] == 0 {
            continue;
        }
        let out = process_at_cell(
            index,
            obstacles,
            ci,
            xk,
            yk,
            particles.vx[k],
            particles.vy[k],
            rk,
            restitution,
        );
        particles.x[k] = out.x;
        particles.y[k] = out.y;
        particles.vx[k] = out.vx;
        particles.vy[k] = out.vy;
    }
    // Creatures (softer restitution).
    let cn = creatures.n;
    let cell_size = OBSTACLE_CELL_SIZE;
    let cell_cols = index.cell_cols;
    let cell_rows = index.cell_rows;
    let creature_e = 0.1_f32;
    for k in 0..cn {
        let rk = creatures.r[k];
        let yk = creatures.y[k];
        if yk + rk < min_y {
            continue;
        }
        let xk = creatures.x[k];
        if !xk.is_finite() || !yk.is_finite() || !rk.is_finite() {
            continue;
        }
        let gcx = (xk / cell_size) as i32;
        let gcy = (yk / cell_size) as i32;
        let gcx = gcx.clamp(0, cell_cols as i32 - 1) as usize;
        let gcy = gcy.clamp(0, cell_rows as i32 - 1) as usize;
        let ci = gcy * cell_cols + gcx;
        if index.cell_grid[ci] == 0 {
            continue;
        }
        let out = process_at_cell(
            index,
            obstacles,
            ci,
            xk,
            yk,
            creatures.vx[k],
            creatures.vy[k],
            rk,
            creature_e,
        );
        creatures.x[k] = out.x;
        creatures.y[k] = out.y;
        creatures.vx[k] = out.vx;
        creatures.vy[k] = out.vy;
    }
}

/// Rock evacuation safety net. If a particle's CENTER ended up
/// inside a polygon (wave-clamp tunnel, between-tick teleport),
/// dump its mass into the nearest non-rock region's dissolved field
/// and remove the particle. Creatures get teleported just past the
/// nearest edge so they keep their state. Mass-conserving on both
/// paths.
pub fn evacuate_rocks(
    obstacles: &[Obstacle],
    index: &ObstacleIndex,
    particles: &mut ParticleStore,
    creatures: &mut CreatureStore,
    ambient: &mut AmbientField,
) {
    if obstacles.is_empty() || index.cell_grid.is_empty() {
        return;
    }
    let four_thirds_pi = (4.0 / 3.0) * std::f32::consts::PI;
    let table = chem_table();
    // Particles. Iterate backwards because remove_swap_pop shuffles.
    let mut i = particles.len();
    while i > 0 {
        i -= 1;
        let px = particles.x[i];
        let py = particles.y[i];
        if !index.cell_has_rock(px, py) {
            continue;
        }
        let mut inside = false;
        for ob in obstacles {
            if px < ob.min_x || px > ob.max_x || py < ob.min_y || py > ob.max_y {
                continue;
            }
            let Some(poly) = &ob.polygon else { continue };
            if point_in_polygon(px, py, poly) {
                inside = true;
                break;
            }
        }
        if !inside {
            continue;
        }
        let r = particles.r[i];
        let chem_id = particles.chem_id[i] as usize;
        let density = if particles.density[i] != 0.0 {
            particles.density[i]
        } else if chem_id < table.base_density.len() {
            table.base_density[chem_id]
        } else {
            1.0
        };
        let mass = density * four_thirds_pi * r * r * r;
        let mm = if chem_id < table.molar_mass.len() {
            table.molar_mass[chem_id].max(1.0)
        } else {
            1.0
        };
        // Dissolved field stores amount (moles); particle holds physical
        // mass. Convert via molar mass on the way in.
        let deposit_base = deposit_region_base(obstacles, index, ambient, px, py);
        if chem_id < AMBIENT_STRIDE {
            ambient.dissolved[deposit_base + chem_id] += mass / mm;
        }
        particles.remove_swap_pop(i);
    }
    // Creatures: polygon-based push to nearest edge.
    for k in 0..creatures.n {
        let cx = creatures.x[k];
        let cy = creatures.y[k];
        if !index.cell_has_rock(cx, cy) {
            continue;
        }
        let mut inside_ob: Option<&Obstacle> = None;
        for ob in obstacles {
            let Some(poly) = &ob.polygon else { continue };
            if cx < ob.min_x || cx > ob.max_x || cy < ob.min_y || cy > ob.max_y {
                continue;
            }
            if point_in_polygon(cx, cy, poly) {
                inside_ob = Some(ob);
                break;
            }
        }
        let Some(ob) = inside_ob else { continue };
        let Some(poly) = &ob.polygon else { continue };
        let (nx_pt, ny_pt) = nearest_polygon_edge_point(cx, cy, poly);
        let dx = nx_pt - cx;
        let dy = ny_pt - cy;
        let d = (dx * dx + dy * dy).sqrt();
        if d > 1e-6 {
            let margin = creatures.r[k] + 2.0;
            let ux = dx / d;
            let uy = dy / d;
            creatures.x[k] = nx_pt + ux * margin;
            creatures.y[k] = ny_pt + uy * margin;
            // Zero any inward velocity.
            let v_dot_u = creatures.vx[k] * ux + creatures.vy[k] * uy;
            if v_dot_u > 0.0 {
                creatures.vx[k] -= v_dot_u * ux;
                creatures.vy[k] -= v_dot_u * uy;
            }
        }
    }
    // Unused: NAMED_CHEMICAL_COUNT (kept imported for the future
    // per-particle generic-molecules path).
    let _ = NAMED_CHEMICAL_COUNT;
}

/// Index into `ambient.dissolved` for the region containing
/// `(x, y)`, redirected OUT of rock. Solid regions act as no-flux
/// barriers; depositing into one would trap the mass there forever,
/// so we redirect to the nearest non-solid region via a perimeter
/// ring scan. Non-rock positions take the fast path.
pub fn deposit_region_base(
    obstacles: &[Obstacle],
    index: &ObstacleIndex,
    ambient: &AmbientField,
    x: f32,
    y: f32,
) -> usize {
    let cols = ambient.cols;
    let rows = ambient.rows;
    let region_idx = crate::regions::region_index_at(ambient.width, ambient.height, x, y);
    // Fast path: position isn't in rock OR obstacles are empty.
    if obstacles.is_empty() || index.cell_grid.is_empty() {
        return region_idx * AMBIENT_STRIDE;
    }
    if !region_center_is_solid(obstacles, ambient, region_idx) {
        return region_idx * AMBIENT_STRIDE;
    }
    let rx = (region_idx % cols) as i32;
    let ry = (region_idx / cols) as i32;
    let max_r = cols.max(rows) as i32;
    for radius in 1..max_r {
        // Walk the perimeter of the radius-ring (not the filled square).
        for dy in -radius..=radius {
            let ny = ry + dy;
            if ny < 0 || ny >= rows as i32 {
                continue;
            }
            let edge_y = dy.abs() == radius;
            for dx in -radius..=radius {
                if !edge_y && dx.abs() != radius {
                    continue;
                }
                let nx = rx + dx;
                if nx < 0 || nx >= cols as i32 {
                    continue;
                }
                let ni = (ny as usize) * cols + nx as usize;
                if !region_center_is_solid(obstacles, ambient, ni) {
                    return ni * AMBIENT_STRIDE;
                }
            }
        }
    }
    region_idx * AMBIENT_STRIDE
}

fn region_center_is_solid(obstacles: &[Obstacle], ambient: &AmbientField, region_idx: usize) -> bool {
    let cols = ambient.cols;
    let rx = (region_idx % cols) as f32;
    let ry = (region_idx / cols) as f32;
    let cx = rx * crate::regions::REGION_PX + crate::regions::REGION_PX * 0.5;
    let cy = ry * crate::regions::REGION_PX + crate::regions::REGION_PX * 0.5;
    for ob in obstacles {
        if cx < ob.min_x || cx > ob.max_x || cy < ob.min_y || cy > ob.max_y {
            continue;
        }
        let Some(poly) = &ob.polygon else { continue };
        if point_in_polygon(cx, cy, poly) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::particles::ParticleInit;
    use crate::terrain::{make_obstacle_from_polygon, PolygonPoint};

    fn square(min: f32, max: f32) -> Vec<PolygonPoint> {
        vec![
            PolygonPoint { x: min, y: min },
            PolygonPoint { x: max, y: min },
            PolygonPoint { x: max, y: max },
            PolygonPoint { x: min, y: max },
        ]
    }

    #[test]
    fn empty_index_no_op() {
        let mut idx = ObstacleIndex::new();
        idx.rebuild(&[], 200.0, 200.0);
        let mut ps = ParticleStore::new();
        ps.push(ParticleInit {
            x: 50.0,
            y: 50.0,
            r: 2.0,
            chem_id: 0,
            ..ParticleInit::default()
        });
        let mut cs = CreatureStore::new();
        resolve_obstacle_collisions(&[], &idx, &mut ps, &mut cs, 0.8);
        assert_eq!(ps.x[0], 50.0);
        assert_eq!(ps.y[0], 50.0);
    }

    #[test]
    fn particle_overlapping_rock_gets_pushed_out() {
        let ob = make_obstacle_from_polygon(square(40.0, 80.0)).unwrap();
        let obs = vec![ob];
        let mut idx = ObstacleIndex::new();
        idx.rebuild(&obs, 200.0, 200.0);
        let mut ps = ParticleStore::new();
        // Place particle just inside the rock at (45, 45).
        ps.push(ParticleInit {
            x: 45.0,
            y: 45.0,
            r: 3.0,
            chem_id: 0,
            ..ParticleInit::default()
        });
        let mut cs = CreatureStore::new();
        resolve_obstacle_collisions(&obs, &idx, &mut ps, &mut cs, 0.8);
        // After collision the particle must be outside the rock polygon.
        assert!(!point_in_polygon(ps.x[0], ps.y[0], &square(40.0, 80.0)));
    }

    #[test]
    fn cell_grid_marks_rock_cells() {
        let ob = make_obstacle_from_polygon(square(0.0, 60.0)).unwrap();
        let obs = vec![ob];
        let mut idx = ObstacleIndex::new();
        idx.rebuild(&obs, 200.0, 200.0);
        assert!(idx.cell_has_rock(30.0, 30.0));
        assert!(!idx.cell_has_rock(150.0, 150.0));
    }

    #[test]
    fn deposit_region_base_redirects_out_of_rock() {
        // Cover region 0 with rock (the 0..60 square).
        let ob = make_obstacle_from_polygon(square(0.0, 60.0)).unwrap();
        let obs = vec![ob];
        let mut idx = ObstacleIndex::new();
        idx.rebuild(&obs, 200.0, 200.0);
        let amb = AmbientField::new_for_world(200.0, 200.0);
        // Region 0 = (0..50, 0..50): center at (25, 25) -> in rock.
        let base = deposit_region_base(&obs, &idx, &amb, 25.0, 25.0);
        // Should redirect to a neighbouring non-rock region (not region 0).
        assert_ne!(base, 0, "deposit should not land in rock region 0");
    }

    #[test]
    fn evacuate_inside_rock_dissolves_particle() {
        let ob = make_obstacle_from_polygon(square(40.0, 80.0)).unwrap();
        let obs = vec![ob];
        let mut idx = ObstacleIndex::new();
        idx.rebuild(&obs, 200.0, 200.0);
        let mut ps = ParticleStore::new();
        // Particle deep inside the rock.
        ps.push(ParticleInit {
            x: 60.0,
            y: 60.0,
            r: 2.0,
            chem_id: crate::chem_ids::CHEM_GLU as u8,
            density: 1.0,
            ..ParticleInit::default()
        });
        let mut cs = CreatureStore::new();
        let mut amb = AmbientField::new_for_world(200.0, 200.0);
        let glu_before = amb.totals_per_chem()[crate::chem_ids::CHEM_GLU];
        evacuate_rocks(&obs, &idx, &mut ps, &mut cs, &mut amb);
        let glu_after = amb.totals_per_chem()[crate::chem_ids::CHEM_GLU];
        assert_eq!(ps.len(), 0, "particle should be removed");
        assert!(
            glu_after > glu_before,
            "particle mass should land in ambient dissolved field: {glu_before} -> {glu_after}"
        );
    }
}
