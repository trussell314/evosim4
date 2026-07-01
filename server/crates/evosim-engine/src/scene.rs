//! Default world scene installer.
//!
//! Glue between [`terrain_shapes`] (hand-authored normalized
//! polygons), [`geology`] (per-world seeded perturbation), and the
//! engine substrate ([`crate::terrain`], [`crate::obstacle_collision`],
//! [`crate::vent`]). One entry point: [`install_default_scene`] takes
//! the world + a geology seed, scales each rock to world dims,
//! perturbs it, lobe-packs it through `make_obstacle_from_polygon`,
//! pushes onto `world.obstacles`, installs a vent at the seafloor
//! pit, then rebuilds the heightmap / spatial index / solid mask.
//!
//! Per-world variation: at the same `geology_seed` the engine produces
//! the same rocks every time; different seeds yield different
//! silhouettes (subdivision + smooth warp + per-vertex jitter, with
//! topology guards that protect the vent point and stop polygons from
//! crossing). `seed == 0` keeps the un-perturbed originals -- the
//! determinism path tests and goldens key off.
//!
//! Extra procedural touch: in addition to the 3 baseline rocks, the
//! installer optionally scatters a handful of small "seafloor
//! cobbles" between the main features. They're independent obstacles
//! sized below the rocks so they don't dominate the silhouette but
//! add foothills + nooks the cells can shelter in. Disabled when
//! `geology_seed == 0` so the default world stays sparse.

use crate::geology::perturb_polygons;
use crate::rng::Mulberry32;
use crate::terrain::{make_obstacle_from_polygon, PolygonPoint};
use crate::terrain_shapes::{default_rocks, scale_polygon, scale_vent_origin};
use crate::vent::VentState;
use crate::world::World;

/// How many extra procedural cobbles to scatter when `geology_seed != 0`.
const COBBLE_COUNT: usize = 6;
/// Cobble radius range, world px.
const COBBLE_R_MIN: f32 = 14.0;
const COBBLE_R_MAX: f32 = 28.0;
/// Cobbles stay at least this far above the world floor so they sit
/// on the seafloor without clipping out of the world.
const COBBLE_FLOOR_MARGIN: f32 = 12.0;
/// Vertical band (above the seafloor) the cobbles get sprinkled into,
/// as a fraction of world height.
const COBBLE_BAND_FRAC: f32 = 0.15;

/// Install the default scene on the world. Pushes the 3 base rocks
/// (perturbed by `geology_seed`), optionally a handful of seafloor
/// cobbles for extra texture, and the vent at the seafloor pit.
/// Rebuilds the heightmap / obstacle index / solid mask before
/// returning so all derived data is consistent.
///
/// `geology_seed == 0` keeps the un-perturbed originals + skips the
/// procedural cobbles, so the determinism path is byte-stable.
pub fn install_default_scene(world: &mut World, geology_seed: u32) {
    let w = world.width;
    let h = world.height;
    let (vx, vy) = scale_vent_origin(w, h);
    let vent_pt = PolygonPoint { x: vx, y: vy };

    // Scale each base polygon.
    let scaled: Vec<Vec<PolygonPoint>> = default_rocks()
        .iter()
        .map(|poly| scale_polygon(poly, w, h))
        .collect();
    let perturbed = perturb_polygons(&scaled, w, h, geology_seed, vent_pt);

    for poly in perturbed {
        if let Some(ob) = make_obstacle_from_polygon(poly) {
            world.obstacles.push(ob);
        }
    }

    // Extra procedural cobbles. Deterministic per seed.
    if geology_seed != 0 {
        let mut rng = Mulberry32::new(geology_seed.wrapping_add(0xCAB1E));
        scatter_seafloor_cobbles(world, &mut rng);
    }

    // Install the vent + recompute derived data.
    world.vent = Some(VentState::new(vx, vy, world.day_period_s, &mut world.sim_rng));
    world.rebuild_terrain_derivatives();
}

/// Scatter a handful of small circular "cobble" polygons across the
/// seafloor band. They don't overlap the existing obstacles (rejected
/// via a quick AABB + polygon containment test). Adds foothills + nooks
/// without changing the major terrain silhouette.
fn scatter_seafloor_cobbles(world: &mut World, rng: &mut Mulberry32) {
    let w = world.width;
    let h = world.height;
    let band_top = h - h * COBBLE_BAND_FRAC;
    let band_bot = h - COBBLE_FLOOR_MARGIN;
    if band_bot <= band_top + 1.0 {
        return;
    }
    let mut placed = 0;
    let mut attempts = 0;
    while placed < COBBLE_COUNT && attempts < COBBLE_COUNT * 8 {
        attempts += 1;
        let cx = (rng.next_f64() as f32) * w;
        let cy = band_top + (rng.next_f64() as f32) * (band_bot - band_top);
        let r = COBBLE_R_MIN + (rng.next_f64() as f32) * (COBBLE_R_MAX - COBBLE_R_MIN);
        // Reject if the cobble center sits inside any existing rock
        // (would create overlapping geometry).
        if !is_clear_of_obstacles(world, cx, cy, r) {
            continue;
        }
        // Octagonal polygon -- 8 vertices, irregularity from a small
        // per-vertex radial jitter.
        let poly = make_cobble_polygon(cx, cy, r, rng, w, h);
        if let Some(ob) = make_obstacle_from_polygon(poly) {
            world.obstacles.push(ob);
            placed += 1;
        }
    }
}

fn is_clear_of_obstacles(world: &World, cx: f32, cy: f32, r: f32) -> bool {
    for ob in &world.obstacles {
        if cx + r < ob.min_x || cx - r > ob.max_x {
            continue;
        }
        if cy + r < ob.min_y || cy - r > ob.max_y {
            continue;
        }
        let Some(poly) = &ob.polygon else { continue };
        if crate::terrain::point_in_polygon(cx, cy, poly) {
            return false;
        }
        // Distance from cobble center to the nearest edge: if it's
        // closer than `r`, the cobble would penetrate.
        let (ex, ey) = crate::terrain::nearest_polygon_edge_point(cx, cy, poly);
        let d2 = (ex - cx).powi(2) + (ey - cy).powi(2);
        if d2 < r * r {
            return false;
        }
    }
    true
}

/// 8-vertex polygon roughly a circle of radius `r` at `(cx, cy)`, with
/// small per-vertex radial jitter so they don't all look identical.
/// Clamped to the world box.
fn make_cobble_polygon(
    cx: f32,
    cy: f32,
    r: f32,
    rng: &mut Mulberry32,
    w: f32,
    h: f32,
) -> Vec<PolygonPoint> {
    let n = 8;
    let mut pts = Vec::with_capacity(n);
    for i in 0..n {
        let theta = (i as f32) / (n as f32) * std::f32::consts::TAU;
        let rj = r * (0.85 + (rng.next_f64() as f32) * 0.30);
        let x = (cx + theta.cos() * rj).clamp(0.0, w);
        let y = (cy + theta.sin() * rj).clamp(0.0, h);
        pts.push(PolygonPoint { x, y });
    }
    pts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_scene_installs_obstacles_and_vent() {
        let mut w = World::new(1600.0, 1200.0, 1);
        assert!(w.obstacles.is_empty());
        assert!(w.vent.is_none());
        install_default_scene(&mut w, 0);
        assert_eq!(w.obstacles.len(), 3, "seed 0 -> just the 3 base rocks");
        assert!(w.vent.is_some());
        // Heightmap + spatial index should be populated.
        assert!(!w.terrain_heightmap.is_empty());
        assert!(w.obstacle_index.cell_cols > 0);
    }

    #[test]
    fn nonzero_seed_adds_cobbles() {
        let mut w = World::new(1600.0, 1200.0, 1);
        install_default_scene(&mut w, 42);
        // 3 base rocks + up to COBBLE_COUNT extra cobbles.
        assert!(w.obstacles.len() >= 3);
        assert!(w.obstacles.len() <= 3 + COBBLE_COUNT);
    }

    #[test]
    fn solid_mask_populated_after_install() {
        let mut w = World::new(1600.0, 1200.0, 1);
        install_default_scene(&mut w, 1);
        let any_solid = w.ambient.solid_mask.iter().any(|&v| v != 0);
        assert!(any_solid, "scene should mark at least one region solid");
    }

    #[test]
    fn vent_lands_in_seafloor_pit() {
        let mut w = World::new(1600.0, 1200.0, 1);
        install_default_scene(&mut w, 0);
        let v = w.vent.as_ref().unwrap();
        // 0.40 * 1600 = 640, 0.965 * 1200 = 1158.
        assert!((v.x - 640.0).abs() < 1.0);
        assert!((v.y - 1158.0).abs() < 1.0);
    }

    #[test]
    fn same_seed_same_scene() {
        let mut a = World::new(1600.0, 1200.0, 1);
        let mut b = World::new(1600.0, 1200.0, 1);
        install_default_scene(&mut a, 777);
        install_default_scene(&mut b, 777);
        assert_eq!(a.obstacles.len(), b.obstacles.len());
        for (oa, ob) in a.obstacles.iter().zip(b.obstacles.iter()) {
            assert_eq!(oa.lobes.len(), ob.lobes.len());
            for (la, lb) in oa.lobes.iter().zip(ob.lobes.iter()) {
                assert!((la.x - lb.x).abs() < 1e-3);
                assert!((la.y - lb.y).abs() < 1e-3);
            }
        }
    }
}
