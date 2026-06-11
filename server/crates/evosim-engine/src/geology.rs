//! Procedural variance for the hand-authored rock polygons. Port of
//! `src/sim/geology.ts`.
//!
//! Each fresh world (seed != 0) jitters every vertex within a bounded
//! radius so the silhouette is subtly different per world while the
//! overall layout stays put. The perturbed polygons drive BOTH render
//! (when rendering lands) and collision -- the rocks ARE the new
//! shape, not just drawn that way.
//!
//! Vertex classes after `scale_polygon` has snapped off-canvas anchors:
//!   - corner-anchored (both coords on a wall): pinned. Corner seal
//!     stays exact.
//!   - wall-anchored (one coord on a wall): slides along the wall
//!     only. The off-axis stays clamped so the rock can't lift off.
//!   - interior: free offset in a random direction within the
//!     magnitude cap.
//!
//! Magnitude cap is per-vertex = MAG * avg(adjacent edge length).
//! Topology guards: every candidate polygon must (a) have no
//! non-adjacent self-intersection, (b) not cross any other rock's
//! polygon, (c) not engulf the vent point. On fail, retry up to
//! RETRIES with a fresh inner seed; on continued fail, halve the
//! magnitude and try again; if the smallest magnitude also fails,
//! that polygon falls back to the un-perturbed scaled original.
//!
//! Uses its own local RNG keyed off the geology seed so perturbation
//! is reproducible without touching the world's main RNG stream
//! (collisions, mutations, etc. stay deterministic against the world
//! seed).

use crate::terrain::PolygonPoint;

const RETRIES: u32 = 32;
/// Per-vertex offset cap = MAG * avg(adjacent edge lengths). Schedule
/// starts large and falls back to smaller mags if the topology guard
/// rejects; worst case (still rejected at the smallest mag) the
/// polygon falls back to the un-perturbed original.
const MAGNITUDES: &[f32] = &[0.60, 0.40, 0.25, 0.10];

/// Per-edge probability of inserting a midpoint vertex during
/// subdivision. Higher = richer silhouette, more vertices for the
/// per-vertex jitter to shape independently.
const SUBDIV_PROB: f32 = 0.75;
/// Perpendicular offset of subdivision midpoints, as a fraction of
/// the parent edge's length. Interior edges only; wall-shared edges
/// keep their midpoint on the wall.
const SUBDIV_PERP_FRAC: f32 = 0.30;

/// Number of sinusoidal modes in the smooth warp. More modes ->
/// richer per-world silhouette; the topology guard tolerates more
/// modes because neighbouring vertices sample nearly the same value
/// (coherent shift) and stay safe.
const WARP_MODES: usize = 4;
/// Per-mode peak amplitude as a fraction of the polygon's
/// characteristic size (sqrt of polygon area).
const WARP_AMP_FRAC: f32 = 0.10;

/// Local seeded RNG -- matches the TS `mulberry32` modulo arithmetic
/// bit-for-bit so a given geology seed produces the same perturbation
/// here as in TS.
struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    fn next_f32(&mut self) -> f32 {
        self.state = self.state.wrapping_add(0x6d2b79f5);
        let mut t: u32 = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f32) / 4_294_967_296.0
    }
}

/// Boundary classification against the world box [0,W] x [0,H]. Bits:
/// 1 = left, 2 = right, 4 = top, 8 = bottom. Combined values indicate
/// corner anchorage (2-bit popcount >= 2).
fn boundary_mask(p: PolygonPoint, w: f32, h: f32) -> u32 {
    let eps = 0.5_f32;
    let mut m = 0;
    if p.x <= eps {
        m |= 1;
    }
    if p.x >= w - eps {
        m |= 2;
    }
    if p.y <= eps {
        m |= 4;
    }
    if p.y >= h - eps {
        m |= 8;
    }
    m
}

fn popcount4(n: u32) -> u32 {
    (n & 1) + ((n >> 1) & 1) + ((n >> 2) & 1) + ((n >> 3) & 1)
}

/// Inject midpoint vertices on a random subset of edges -- adds degrees
/// of freedom for the subsequent jitter to shape independently, so
/// rerolls produce genuinely new silhouettes instead of jittered copies
/// of the same skeleton.
fn subdivide_edges(pts: &[PolygonPoint], w: f32, h: f32, rng: &mut Mulberry32) -> Vec<PolygonPoint> {
    let n = pts.len();
    let mut out = Vec::with_capacity(n * 2);
    for i in 0..n {
        let a = pts[i];
        let b = pts[(i + 1) % n];
        out.push(a);
        if rng.next_f32() >= SUBDIV_PROB {
            continue;
        }
        let t = 0.30 + rng.next_f32() * 0.40;
        let mut mx = a.x + (b.x - a.x) * t;
        let mut my = a.y + (b.y - a.y) * t;
        let shared_wall = boundary_mask(a, w, h) & boundary_mask(b, w, h);
        if shared_wall == 0 {
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let len = (dx * dx + dy * dy).sqrt();
            if len > 0.0 {
                let sign: f32 = if rng.next_f32() > 0.5 { 1.0 } else { -1.0 };
                let perp = rng.next_f32() * SUBDIV_PERP_FRAC * len * sign;
                mx += (-dy / len) * perp;
                my += (dx / len) * perp;
            }
        }
        out.push(PolygonPoint { x: mx, y: my });
    }
    out
}

/// Proper segment intersection: open interiors crossing. Endpoint
/// touches don't count -- adjacent polygon edges share an endpoint and
/// that's fine.
fn segments_cross(
    a1: PolygonPoint,
    a2: PolygonPoint,
    b1: PolygonPoint,
    b2: PolygonPoint,
) -> bool {
    let d1x = a2.x - a1.x;
    let d1y = a2.y - a1.y;
    let d2x = b2.x - b1.x;
    let d2y = b2.y - b1.y;
    let denom = d1x * d2y - d1y * d2x;
    if denom == 0.0 {
        return false;
    }
    let sx = b1.x - a1.x;
    let sy = b1.y - a1.y;
    let t = (sx * d2y - sy * d2x) / denom;
    let u = (sx * d1y - sy * d1x) / denom;
    t > 1e-9 && t < 1.0 - 1e-9 && u > 1e-9 && u < 1.0 - 1e-9
}

fn self_intersects(pts: &[PolygonPoint]) -> bool {
    let n = pts.len();
    if n < 4 {
        return false;
    }
    for i in 0..n {
        let a1 = pts[i];
        let a2 = pts[(i + 1) % n];
        let j_start = i + 2;
        let j_end = if i == 0 { n - 1 } else { n };
        for j in j_start..j_end {
            let b1 = pts[j];
            let b2 = pts[(j + 1) % n];
            if segments_cross(a1, a2, b1, b2) {
                return true;
            }
        }
    }
    false
}

fn polygons_cross(a: &[PolygonPoint], b: &[PolygonPoint]) -> bool {
    for i in 0..a.len() {
        let a1 = a[i];
        let a2 = a[(i + 1) % a.len()];
        for j in 0..b.len() {
            let b1 = b[j];
            let b2 = b[(j + 1) % b.len()];
            if segments_cross(a1, a2, b1, b2) {
                return true;
            }
        }
    }
    false
}

fn point_in_polygon(p: PolygonPoint, pts: &[PolygonPoint]) -> bool {
    let n = pts.len();
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let vi = pts[i];
        let vj = pts[j];
        let crosses_y = (vi.y > p.y) != (vj.y > p.y);
        if crosses_y {
            let x_at = vi.x + (p.y - vi.y) * (vj.x - vi.x) / (vj.y - vi.y);
            if p.x < x_at {
                inside = !inside;
            }
        }
        j = i;
    }
    inside
}

/// 2x signed area via the shoelace formula. Used to derive a
/// characteristic length scale for the warp amplitudes.
fn polygon_char_size(pts: &[PolygonPoint]) -> f32 {
    let mut a = 0.0_f32;
    for i in 0..pts.len() {
        let p = pts[i];
        let q = pts[(i + 1) % pts.len()];
        a += p.x * q.y - q.x * p.y;
    }
    (a.abs() * 0.5).sqrt()
}

/// Smooth polygon-wide warp via summed sinusoids. Neighbouring vertices
/// sample nearly the same value, so they shift coherently -- topology
/// safety tolerates much larger amplitudes than independent per-vertex
/// jitter could. Wall-anchored axes are zeroed before applying so the
/// seal stays exact; corners stay pinned.
fn smooth_warp(
    pts: &[PolygonPoint],
    w: f32,
    h: f32,
    rng: &mut Mulberry32,
    char_size: f32,
) -> Vec<PolygonPoint> {
    let base_amp = char_size * WARP_AMP_FRAC;
    let mut waves: Vec<(f32, f32, f32, f32, f32, f32)> = Vec::with_capacity(WARP_MODES);
    let inv_char = 1.0 / char_size.max(1.0);
    for _ in 0..WARP_MODES {
        let ax = rng.next_f32() * base_amp;
        let ay = rng.next_f32() * base_amp;
        let fx = (0.5 + rng.next_f32() * 1.5) * inv_char;
        let fy = (0.5 + rng.next_f32() * 1.5) * inv_char;
        let px = rng.next_f32() * std::f32::consts::TAU;
        let py = rng.next_f32() * std::f32::consts::TAU;
        waves.push((ax, ay, fx, fy, px, py));
    }
    pts.iter()
        .map(|p| {
            let mask = boundary_mask(*p, w, h);
            if popcount4(mask) >= 2 {
                return *p;
            }
            let mut off_x = 0.0_f32;
            let mut off_y = 0.0_f32;
            for &(ax, ay, fx, fy, px, py) in &waves {
                off_x += ax * (fx * p.x + px).sin();
                off_y += ay * (fy * p.y + py).sin();
            }
            if mask & 3 != 0 {
                off_x = 0.0;
            }
            if mask & 12 != 0 {
                off_y = 0.0;
            }
            let qx = (p.x + off_x).clamp(0.0, w);
            let qy = (p.y + off_y).clamp(0.0, h);
            PolygonPoint { x: qx, y: qy }
        })
        .collect()
}

fn perturb_once(
    pts: &[PolygonPoint],
    w: f32,
    h: f32,
    rng: &mut Mulberry32,
    mag: f32,
) -> Vec<PolygonPoint> {
    let n = pts.len();
    let mut out = vec![PolygonPoint { x: 0.0, y: 0.0 }; n];
    for i in 0..n {
        let p = pts[i];
        let prev = pts[(i + n - 1) % n];
        let next = pts[(i + 1) % n];
        let e_len_a = ((p.x - prev.x).powi(2) + (p.y - prev.y).powi(2)).sqrt();
        let e_len_b = ((next.x - p.x).powi(2) + (next.y - p.y).powi(2)).sqrt();
        let cap = ((e_len_a + e_len_b) * 0.5) * mag;
        let mask = boundary_mask(p, w, h);
        if mask == 0 {
            let theta = rng.next_f32() * std::f32::consts::TAU;
            let r = rng.next_f32() * cap;
            out[i] = PolygonPoint {
                x: p.x + theta.cos() * r,
                y: p.y + theta.sin() * r,
            };
        } else if popcount4(mask) >= 2 {
            out[i] = p;
        } else {
            let slide = (rng.next_f32() * 2.0 - 1.0) * cap;
            if mask & 3 != 0 {
                let y = (p.y + slide).clamp(0.0, h);
                out[i] = PolygonPoint { x: p.x, y };
            } else {
                let x = (p.x + slide).clamp(0.0, w);
                out[i] = PolygonPoint { x, y: p.y };
            }
        }
    }
    out
}

/// Perturb each polygon in `scaled` (world-px coords). The vent point
/// is guarded -- no perturbed polygon may contain it. `seed == 0`
/// returns the inputs unchanged (deep-copied), which is the
/// default-world / test path so determinism stays byte-identical.
pub fn perturb_polygons(
    scaled: &[Vec<PolygonPoint>],
    w: f32,
    h: f32,
    seed: u32,
    vent: PolygonPoint,
) -> Vec<Vec<PolygonPoint>> {
    let mut result: Vec<Vec<PolygonPoint>> = scaled.to_vec();
    if seed == 0 {
        return result;
    }
    let mut rng = Mulberry32::new(seed);
    for i in 0..scaled.len() {
        let base = subdivide_edges(&scaled[i], w, h, &mut rng);
        let char_size = polygon_char_size(&base).max(1.0);
        let mut placed = false;
        for &mag in MAGNITUDES {
            for _ in 0..RETRIES {
                let warped = smooth_warp(&base, w, h, &mut rng, char_size);
                let cand = perturb_once(&warped, w, h, &mut rng, mag);
                if self_intersects(&cand) {
                    continue;
                }
                if point_in_polygon(vent, &cand) {
                    continue;
                }
                let mut crosses = false;
                for (j, other) in result.iter().enumerate() {
                    if j == i {
                        continue;
                    }
                    if polygons_cross(&cand, other) {
                        crosses = true;
                        break;
                    }
                }
                if crosses {
                    continue;
                }
                result[i] = cand;
                placed = true;
                break;
            }
            if placed {
                break;
            }
        }
        // If every magnitude failed, result[i] keeps the un-perturbed
        // scaled original.
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(w: f32, h: f32) -> Vec<PolygonPoint> {
        vec![
            PolygonPoint { x: 100.0, y: 100.0 },
            PolygonPoint { x: w - 100.0, y: 100.0 },
            PolygonPoint { x: w - 100.0, y: h - 100.0 },
            PolygonPoint { x: 100.0, y: h - 100.0 },
        ]
    }

    #[test]
    fn seed_zero_returns_copy() {
        let scaled = vec![square(800.0, 600.0)];
        let out = perturb_polygons(&scaled, 800.0, 600.0, 0, PolygonPoint { x: 400.0, y: 500.0 });
        assert_eq!(out, scaled);
    }

    #[test]
    fn perturbation_is_deterministic() {
        let scaled = vec![square(800.0, 600.0)];
        let vent = PolygonPoint { x: 400.0, y: 500.0 };
        let a = perturb_polygons(&scaled, 800.0, 600.0, 12345, vent);
        let b = perturb_polygons(&scaled, 800.0, 600.0, 12345, vent);
        assert_eq!(a, b);
    }

    #[test]
    fn different_seeds_differ() {
        let scaled = vec![square(800.0, 600.0)];
        let vent = PolygonPoint { x: 400.0, y: 500.0 };
        let a = perturb_polygons(&scaled, 800.0, 600.0, 1, vent);
        let b = perturb_polygons(&scaled, 800.0, 600.0, 2, vent);
        assert_ne!(a, b);
    }

    #[test]
    fn perturbation_keeps_topology() {
        // Two adjacent rocks: the perturbation guards against crossing.
        let scaled = vec![
            vec![
                PolygonPoint { x: 100.0, y: 100.0 },
                PolygonPoint { x: 200.0, y: 100.0 },
                PolygonPoint { x: 200.0, y: 200.0 },
                PolygonPoint { x: 100.0, y: 200.0 },
            ],
            vec![
                PolygonPoint { x: 300.0, y: 100.0 },
                PolygonPoint { x: 400.0, y: 100.0 },
                PolygonPoint { x: 400.0, y: 200.0 },
                PolygonPoint { x: 300.0, y: 200.0 },
            ],
        ];
        let vent = PolygonPoint { x: 600.0, y: 500.0 };
        let out = perturb_polygons(&scaled, 800.0, 600.0, 4242, vent);
        for poly in &out {
            assert!(!self_intersects(poly), "perturbed polygon should be simple");
        }
        assert!(!polygons_cross(&out[0], &out[1]));
    }

    #[test]
    fn vent_never_engulfed() {
        // A vent inside a square rock should force the perturbation to
        // leave the polygon original (since any deformation might still
        // contain the point).
        let scaled = vec![square(800.0, 600.0)];
        let vent = PolygonPoint { x: 400.0, y: 300.0 };
        let out = perturb_polygons(&scaled, 800.0, 600.0, 99, vent);
        assert!(!point_in_polygon(vent, &out[0]));
    }
}
