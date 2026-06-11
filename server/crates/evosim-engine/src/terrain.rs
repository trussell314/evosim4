//! Static rocky terrain: obstacle types + geometry helpers.
//!
//! Substrate port of `src/sim/terrain.ts`. Ships the data shapes,
//! polygon queries, and lobe packing the runtime collision pass
//! consumes. The hand-authored polygons from `terrain-shapes.ts` are
//! deliberately NOT ported here -- they're world data, not substrate,
//! and the engine starts with an empty obstacles list. A future world-
//! config / scene port will populate them.
//!
//! What's NOT ported (kept honest):
//!   - `terrain-shapes.ts` -- hand-authored normalized polygons
//!   - `geology.ts` -- per-world vertex jitter for seeded variation
//!   - the surface modifier maps (`buildTerrainSurfaceMaps`) -- depend on
//!     the wave system, which isn't ported. Wind exposure, wave origin,
//!     shoaling all wait on that.

use serde::{Deserialize, Serialize};

/// A circular sub-collider packed inside an obstacle polygon. The
/// runtime collision sweeps treat lobes like spheres so existing
/// circle-vs-circle logic handles polygon shapes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObstacleLobe {
    pub x: f32,
    pub y: f32,
    pub r: f32,
}

/// A polygon vertex (matches the TS `{x, y}` shape).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PolygonPoint {
    pub x: f32,
    pub y: f32,
}

/// A static rock. Holds the source polygon (for point-in-polygon
/// evacuation + heightmap construction), its lobe pack (for the hot
/// collision path), and the AABB the spatial index keys off.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Obstacle {
    pub min_x: f32,
    pub min_y: f32,
    pub max_x: f32,
    pub max_y: f32,
    pub lobes: Vec<ObstacleLobe>,
    /// The polygon source. `None` for synthetic / test obstacles built
    /// directly from lobes; production rocks always have one.
    pub polygon: Option<Vec<PolygonPoint>>,
    /// Z-band (rendering layer hint). Reserved for the render port;
    /// not used by collision.
    pub z: f32,
}

/// Lobe geometry constants. Match the TS values exactly so the
/// collision footprint is bit-identical.
const LOBE_R: f32 = 9.0;
const LOBE_PITCH: f32 = 12.0;

/// Standard ray-cast point-in-polygon. Translated verbatim from
/// `terrain.ts:74`. Used by the lobe packer + obstacle evacuation.
pub fn point_in_polygon(x: f32, y: f32, poly: &[PolygonPoint]) -> bool {
    if poly.len() < 3 {
        return false;
    }
    let mut inside = false;
    let n = poly.len();
    let mut j = n - 1;
    for i in 0..n {
        let xi = poly[i].x;
        let yi = poly[i].y;
        let xj = poly[j].x;
        let yj = poly[j].y;
        let intersect =
            ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi);
        if intersect {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Pack a polygon's interior with circular collision lobes on a
/// `LOBE_PITCH` grid, kept where the grid point falls inside the
/// polygon. Sliver polygons that miss every grid point get small
/// vertex-anchored lobes as a fallback so collision still has
/// something to push off.
pub fn lobes_from_terrain_polygon(polygon: &[PolygonPoint]) -> Vec<ObstacleLobe> {
    if polygon.is_empty() {
        return Vec::new();
    }
    let mut min_x = f32::INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut max_y = f32::NEG_INFINITY;
    for v in polygon {
        if v.x < min_x {
            min_x = v.x;
        }
        if v.y < min_y {
            min_y = v.y;
        }
        if v.x > max_x {
            max_x = v.x;
        }
        if v.y > max_y {
            max_y = v.y;
        }
    }
    let mut lobes = Vec::new();
    let mut y = min_y + LOBE_PITCH * 0.5;
    while y <= max_y {
        let mut x = min_x + LOBE_PITCH * 0.5;
        while x <= max_x {
            if point_in_polygon(x, y, polygon) {
                lobes.push(ObstacleLobe { x, y, r: LOBE_R });
            }
            x += LOBE_PITCH;
        }
        y += LOBE_PITCH;
    }
    if lobes.is_empty() {
        for v in polygon {
            lobes.push(ObstacleLobe {
                x: v.x,
                y: v.y,
                r: LOBE_R * 0.6,
            });
        }
    }
    lobes
}

/// Build an Obstacle from a polygon (lobe-packs it, computes the
/// AABB from the polygon's vertices). The polygon is stored on the
/// obstacle for the evacuation path.
pub fn make_obstacle_from_polygon(polygon: Vec<PolygonPoint>) -> Option<Obstacle> {
    if polygon.len() < 3 {
        return None;
    }
    let lobes = lobes_from_terrain_polygon(&polygon);
    // AABB from the polygon vertices (not the lobes -- a vertex may
    // sit outside the lobe pack but is still part of the silhouette).
    let mut min_x = f32::INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut max_y = f32::NEG_INFINITY;
    for v in &polygon {
        if v.x < min_x {
            min_x = v.x;
        }
        if v.y < min_y {
            min_y = v.y;
        }
        if v.x > max_x {
            max_x = v.x;
        }
        if v.y > max_y {
            max_y = v.y;
        }
    }
    Some(Obstacle {
        min_x,
        min_y,
        max_x,
        max_y,
        lobes,
        polygon: Some(polygon),
        z: 0.0,
    })
}

/// Per-column heightmap: topmost rock y for every integer x in
/// `0..width`. Columns with no rock report `f32::INFINITY` (the
/// "open water" sentinel).
pub fn build_terrain_heightmap(obstacles: &[Obstacle], width: f32) -> Vec<f32> {
    let cols = (width.floor() as usize).max(1);
    let mut heightmap = vec![f32::INFINITY; cols];
    for ob in obstacles {
        let Some(poly) = &ob.polygon else { continue };
        let x0 = (ob.min_x.floor() as i32).max(0) as usize;
        let x1 = (ob.max_x.ceil() as i32).min(cols as i32 - 1) as usize;
        let col_lo = x0;
        let col_hi = x1.min(cols.saturating_sub(1));
        for (col, slot) in heightmap
            .iter_mut()
            .enumerate()
            .take(col_hi + 1)
            .skip(col_lo)
        {
            let x = col as f32;
            let mut top_y = f32::INFINITY;
            let n = poly.len();
            let mut j = n - 1;
            for i in 0..n {
                let xi = poly[i].x;
                let yi = poly[i].y;
                let xj = poly[j].x;
                let yj = poly[j].y;
                let in_x_range =
                    (xi <= x && xj >= x) || (xj <= x && xi >= x);
                if in_x_range {
                    if (xi - xj).abs() < 1e-9 {
                        // Vertical edge: every y on it is a candidate.
                        if yi < top_y {
                            top_y = yi;
                        }
                        if yj < top_y {
                            top_y = yj;
                        }
                    } else {
                        let t = (x - xi) / (xj - xi);
                        let y = yi + (yj - yi) * t;
                        if y < top_y {
                            top_y = y;
                        }
                    }
                }
                j = i;
            }
            if top_y < *slot {
                *slot = top_y;
            }
        }
    }
    heightmap
}

/// True if a candidate body of radius `body_r` at `(x, y)` would
/// overlap any obstacle's lobe pack. Used at founder spawn so cells
/// don't materialise inside rock.
pub fn founder_terrain_blocked(obstacles: &[Obstacle], x: f32, y: f32, body_r: f32) -> bool {
    for ob in obstacles {
        if x + body_r < ob.min_x || x - body_r > ob.max_x {
            continue;
        }
        if y + body_r < ob.min_y || y - body_r > ob.max_y {
            continue;
        }
        for l in &ob.lobes {
            let dx = x - l.x;
            let dy = y - l.y;
            let min_dist = body_r + l.r;
            if dx * dx + dy * dy < min_dist * min_dist {
                return true;
            }
        }
    }
    false
}

/// Closest point on a polygon's boundary to `(qx, qy)`. Walks every
/// edge, projects the query onto each segment, returns the
/// projection nearest in Euclidean distance.
pub fn nearest_polygon_edge_point(qx: f32, qy: f32, poly: &[PolygonPoint]) -> (f32, f32) {
    if poly.is_empty() {
        return (qx, qy);
    }
    let mut best_x = poly[0].x;
    let mut best_y = poly[0].y;
    let mut best_d = f32::INFINITY;
    let n = poly.len();
    let mut j = n - 1;
    for i in 0..n {
        let ax = poly[j].x;
        let ay = poly[j].y;
        let bx = poly[i].x;
        let by = poly[i].y;
        let ex = bx - ax;
        let ey = by - ay;
        let len_sq = ex * ex + ey * ey;
        let mut t = 0.0_f32;
        if len_sq > 1e-12 {
            t = ((qx - ax) * ex + (qy - ay) * ey) / len_sq;
            t = t.clamp(0.0, 1.0);
        }
        let px = ax + ex * t;
        let py = ay + ey * t;
        let dx = px - qx;
        let dy = py - qy;
        let d = dx * dx + dy * dy;
        if d < best_d {
            best_d = d;
            best_x = px;
            best_y = py;
        }
        j = i;
    }
    (best_x, best_y)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(min: f32, max: f32) -> Vec<PolygonPoint> {
        vec![
            PolygonPoint { x: min, y: min },
            PolygonPoint { x: max, y: min },
            PolygonPoint { x: max, y: max },
            PolygonPoint { x: min, y: max },
        ]
    }

    #[test]
    fn point_in_polygon_basic_square() {
        let sq = square(0.0, 10.0);
        assert!(point_in_polygon(5.0, 5.0, &sq));
        assert!(!point_in_polygon(20.0, 5.0, &sq));
        assert!(!point_in_polygon(-1.0, 5.0, &sq));
        assert!(!point_in_polygon(5.0, -1.0, &sq));
    }

    #[test]
    fn lobes_pack_inside_polygon() {
        let sq = square(0.0, 60.0);
        let lobes = lobes_from_terrain_polygon(&sq);
        assert!(!lobes.is_empty());
        for l in &lobes {
            assert_eq!(l.r, LOBE_R);
            assert!(l.x > 0.0 && l.x < 60.0);
            assert!(l.y > 0.0 && l.y < 60.0);
            assert!(point_in_polygon(l.x, l.y, &sq));
        }
    }

    #[test]
    fn make_obstacle_aabb_matches_polygon() {
        let poly = vec![
            PolygonPoint { x: 10.0, y: 20.0 },
            PolygonPoint { x: 30.0, y: 20.0 },
            PolygonPoint { x: 30.0, y: 50.0 },
            PolygonPoint { x: 10.0, y: 50.0 },
        ];
        let ob = make_obstacle_from_polygon(poly).unwrap();
        assert_eq!(ob.min_x, 10.0);
        assert_eq!(ob.min_y, 20.0);
        assert_eq!(ob.max_x, 30.0);
        assert_eq!(ob.max_y, 50.0);
        assert!(ob.polygon.is_some());
    }

    #[test]
    fn make_obstacle_rejects_degenerate() {
        assert!(make_obstacle_from_polygon(vec![]).is_none());
        assert!(make_obstacle_from_polygon(vec![PolygonPoint { x: 0.0, y: 0.0 }]).is_none());
    }

    #[test]
    fn heightmap_reports_top_of_rock() {
        // Polygon spans columns 10..30, top y = 20.
        let poly = vec![
            PolygonPoint { x: 10.0, y: 20.0 },
            PolygonPoint { x: 30.0, y: 20.0 },
            PolygonPoint { x: 30.0, y: 50.0 },
            PolygonPoint { x: 10.0, y: 50.0 },
        ];
        let ob = make_obstacle_from_polygon(poly).unwrap();
        let hm = build_terrain_heightmap(&[ob], 60.0);
        // Columns under the rock report y=20.
        assert!((hm[15] - 20.0).abs() < 1e-3);
        assert!((hm[29] - 20.0).abs() < 1e-3);
        // Columns outside report Infinity.
        assert!(hm[0].is_infinite());
        assert!(hm[40].is_infinite());
    }

    #[test]
    fn founder_blocked_inside_rock() {
        let poly = square(0.0, 60.0);
        let ob = make_obstacle_from_polygon(poly).unwrap();
        assert!(founder_terrain_blocked(std::slice::from_ref(&ob), 30.0, 30.0, 5.0));
        assert!(!founder_terrain_blocked(&[ob], 200.0, 200.0, 5.0));
    }

    #[test]
    fn nearest_edge_clamps_to_segment() {
        let sq = square(0.0, 10.0);
        // Query inside center, nearest point should be on one of the
        // four edges at distance 5.
        let (x, y) = nearest_polygon_edge_point(5.0, 5.0, &sq);
        let d = ((x - 5.0).hypot(y - 5.0)).abs();
        assert!((d - 5.0).abs() < 1e-3, "expected dist=5, got {d}");
    }

    #[test]
    fn empty_obstacles_no_blocked() {
        // Founder spawn on a terrain-less world should never reject.
        assert!(!founder_terrain_blocked(&[], 0.0, 0.0, 5.0));
        assert!(!founder_terrain_blocked(&[], 500.0, 500.0, 5.0));
    }
}
