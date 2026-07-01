//! Hand-authored static terrain polygons. Ported verbatim from
//! `src/sim/terrain-shapes.ts` -- the same Inkscape drawing in
//! normalized [0,1] world coordinates that the TS engine ships.
//! Vertices at or outside the box anchor to the world boundary via
//! [`scale_polygon`] so off-canvas anchor points land flush with the
//! wall (no water leaks under a rock that was drawn slightly outside).
//!
//! Three rocks ship by default:
//!   1. `ROCK_TOP_LEFT` -- a crag-laden silhouette descending the
//!      left wall from the upper-left corner, with a long horizontal
//!      lip across the upper third of the world
//!   2. `ROCK_RIGHT_MID` -- a smoother formation hooking out from
//!      the right wall mid-column
//!   3. `ROCK_SEAFLOOR` -- the seafloor + a lower-left rock with a
//!      single hydrothermal pit where the vent lives
//!
//! `VENT_ORIGIN` is in the seafloor pit, where the engine's vent
//! installer places `VentState`.
//!
//! `scene::default_scene` is the install entry point: it scales each
//! polygon to the world dims, applies seeded `geology::perturb` for
//! per-world variation, lobe-packs each one through
//! `terrain::make_obstacle_from_polygon`, and pushes them onto
//! `world.obstacles` + rebuilds the heightmap / spatial index /
//! solid mask.

// Hand-authored polygon vertex coordinates -- some happen to
// numerically resemble math constants (e.g. 0.7071 ≈ FRAC_1_SQRT_2);
// they're not derived from them. Suppress the lint module-wide.
#![allow(clippy::approx_constant)]

use crate::terrain::PolygonPoint;

/// `ROCK_TOP_LEFT`: 123 vertices, normalized to [0,1].
const ROCK_TOP_LEFT: &[(f32, f32)] = &[
    (-0.0345, -0.0043),
    (-0.0254, -0.0020),
    (-0.0040, 0.0039),
    (0.0256, 0.0123),
    (0.0592, 0.0219),
    (0.0925, 0.0314),
    (0.1215, 0.0398),
    (0.1419, 0.0457),
    (0.1497, 0.0480),
    (0.1921, 0.0985),
    (0.1949, 0.0994),
    (0.2025, 0.1018),
    (0.2131, 0.1052),
    (0.2255, 0.1090),
    (0.2380, 0.1128),
    (0.2491, 0.1161),
    (0.2573, 0.1183),
    (0.2612, 0.1191),
    (0.2654, 0.1183),
    (0.2748, 0.1164),
    (0.2875, 0.1137),
    (0.3020, 0.1108),
    (0.3164, 0.1078),
    (0.3291, 0.1051),
    (0.3383, 0.1032),
    (0.3424, 0.1024),
    (0.3461, 0.1011),
    (0.3546, 0.0979),
    (0.3661, 0.0935),
    (0.3790, 0.0885),
    (0.3919, 0.0835),
    (0.4030, 0.0792),
    (0.4109, 0.0761),
    (0.4139, 0.0750),
    (0.4569, 0.0326),
    (0.4951, 0.0266),
    (0.5157, 0.0441),
    (0.5153, 0.0449),
    (0.5144, 0.0468),
    (0.5130, 0.0496),
    (0.5113, 0.0529),
    (0.5095, 0.0562),
    (0.5077, 0.0591),
    (0.5061, 0.0614),
    (0.5048, 0.0626),
    (0.5032, 0.0636),
    (0.5010, 0.0657),
    (0.4984, 0.0684),
    (0.4957, 0.0714),
    (0.4932, 0.0743),
    (0.4910, 0.0768),
    (0.4896, 0.0786),
    (0.4890, 0.0793),
    (0.4887, 0.0806),
    (0.4880, 0.0842),
    (0.4869, 0.0892),
    (0.4857, 0.0951),
    (0.4844, 0.1011),
    (0.4834, 0.1064),
    (0.4826, 0.1103),
    (0.4823, 0.1123),
    (0.4827, 0.1137),
    (0.4836, 0.1164),
    (0.4848, 0.1199),
    (0.4863, 0.1238),
    (0.4877, 0.1276),
    (0.4890, 0.1309),
    (0.4899, 0.1332),
    (0.4902, 0.1341),
    (0.4926, 0.1675),
    (0.3920, 0.1928),
    (0.3296, 0.2348),
    (0.2806, 0.2755),
    (0.2790, 0.2751),
    (0.2751, 0.2742),
    (0.2694, 0.2728),
    (0.2629, 0.2712),
    (0.2564, 0.2695),
    (0.2506, 0.2679),
    (0.2465, 0.2666),
    (0.2448, 0.2656),
    (0.2421, 0.2640),
    (0.2355, 0.2606),
    (0.2261, 0.2562),
    (0.2155, 0.2513),
    (0.2049, 0.2464),
    (0.1956, 0.2423),
    (0.1891, 0.2393),
    (0.1866, 0.2382),
    (0.1857, 0.2379),
    (0.1832, 0.2372),
    (0.1795, 0.2362),
    (0.1753, 0.2351),
    (0.1708, 0.2339),
    (0.1667, 0.2330),
    (0.1633, 0.2324),
    (0.1612, 0.2322),
    (0.1589, 0.2331),
    (0.1551, 0.2351),
    (0.1504, 0.2380),
    (0.1453, 0.2412),
    (0.1403, 0.2443),
    (0.1361, 0.2471),
    (0.1332, 0.2490),
    (0.1321, 0.2498),
    (0.0921, 0.2712),
    (0.0904, 0.2719),
    (0.0858, 0.2736),
    (0.0792, 0.2762),
    (0.0716, 0.2792),
    (0.0637, 0.2824),
    (0.0566, 0.2855),
    (0.0510, 0.2881),
    (0.0479, 0.2901),
    (0.0445, 0.2929),
    (0.0381, 0.2981),
    (0.0299, 0.3048),
    (0.0208, 0.3121),
    (0.0120, 0.3192),
    (0.0043, 0.3253),
    (-0.0010, 0.3296),
    (-0.0030, 0.3312),
    (-0.0267, 0.2905),
];

/// `ROCK_RIGHT_MID`: 32 vertices, normalized to [0,1].
const ROCK_RIGHT_MID: &[(f32, f32)] = &[
    (1.0266, 0.4702),
    (0.6393, 0.5320),
    (0.5330, 0.5817),
    (0.5244, 0.6508),
    (0.5364, 0.6920),
    (0.5742, 0.7065),
    (0.5755, 0.7066),
    (0.5791, 0.7068),
    (0.5848, 0.7071),
    (0.5921, 0.7073),
    (0.6008, 0.7073),
    (0.6103, 0.7070),
    (0.6204, 0.7064),
    (0.6307, 0.7053),
    (0.6424, 0.7026),
    (0.6562, 0.6979),
    (0.6710, 0.6918),
    (0.6856, 0.6851),
    (0.6989, 0.6786),
    (0.7098, 0.6731),
    (0.7171, 0.6692),
    (0.7198, 0.6677),
    (0.7524, 0.6447),
    (0.7935, 0.6289),
    (0.8398, 0.6386),
    (0.8861, 0.6641),
    (0.8981, 0.6762),
    (0.9238, 0.7065),
    (0.9563, 0.7223),
    (0.9855, 0.7271),
    (1.0249, 0.7307),
    (1.0489, 0.7307),
];

/// `ROCK_SEAFLOOR`: 45 vertices, normalized to [0,1].
const ROCK_SEAFLOOR: &[(f32, f32)] = &[
    (1.0249, 0.8337),
    (0.8535, 0.8774),
    (0.7284, 0.8955),
    (0.6136, 0.8943),
    (0.5622, 0.8604),
    (0.4970, 0.7901),
    (0.4199, 0.7198),
    (0.3445, 0.7126),
    (0.2982, 0.7174),
    (0.2571, 0.7223),
    (0.2108, 0.7477),
    (0.2121, 0.7489),
    (0.2155, 0.7521),
    (0.2204, 0.7565),
    (0.2262, 0.7616),
    (0.2324, 0.7668),
    (0.2383, 0.7712),
    (0.2433, 0.7744),
    (0.2468, 0.7756),
    (0.2523, 0.7763),
    (0.2625, 0.7782),
    (0.2758, 0.7809),
    (0.2905, 0.7841),
    (0.3048, 0.7872),
    (0.3172, 0.7899),
    (0.3258, 0.7918),
    (0.3291, 0.7925),
    (0.4079, 0.8265),
    (0.4285, 0.8531),
    (0.4490, 0.8846),
    (0.4525, 0.8992),
    (0.4490, 0.9392),
    (0.3822, 0.9610),
    (0.3428, 0.9380),
    (0.3256, 0.9016),
    (0.3068, 0.8701),
    (0.2365, 0.8398),
    (0.1851, 0.8337),
    (0.1268, 0.8228),
    (0.0446, 0.8059),
    (0.0291, 0.7671),
    (-0.0069, 0.6835),
    (-0.0463, 0.7004),
    (-0.0463, 1.0495),
    (1.0575, 1.0240),
];


/// Vent location in normalized coords. Sits in the seafloor pit
/// (matches `terrain-shapes.ts:VENT_ORIGIN`).
pub const VENT_ORIGIN_NORM: (f32, f32) = (0.40, 0.965);

/// All three default rocks in installation order. Used by
/// `scene::default_scene` to walk the table.
pub fn default_rocks() -> [&'static [(f32, f32)]; 3] {
    [ROCK_TOP_LEFT, ROCK_RIGHT_MID, ROCK_SEAFLOOR]
}

/// Re-anchor a normalized polygon to world pixels. Vertices at or
/// outside the [0,1] box snap exactly to the world boundary so an
/// off-canvas vertex (deliberately drawn outside to anchor against
/// a wall) lands flush instead of leaking a sliver of water through.
pub fn scale_polygon(poly: &[(f32, f32)], width: f32, height: f32) -> Vec<PolygonPoint> {
    poly.iter()
        .map(|&(nx, ny)| {
            let x = if nx <= 0.0 {
                0.0
            } else if nx >= 1.0 {
                width
            } else {
                nx * width
            };
            let y = if ny <= 0.0 {
                0.0
            } else if ny >= 1.0 {
                height
            } else {
                ny * height
            };
            PolygonPoint { x, y }
        })
        .collect()
}

/// Scale the vent origin to world pixels.
pub fn scale_vent_origin(width: f32, height: f32) -> (f32, f32) {
    let (nx, ny) = VENT_ORIGIN_NORM;
    (nx * width, ny * height)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rock_polygons_are_non_empty() {
        for rock in default_rocks() {
            assert!(rock.len() >= 3, "rock should have at least 3 vertices");
        }
    }

    #[test]
    fn scale_snaps_oob_vertices() {
        // Vertices outside [0,1] snap to the boundary exactly.
        let p = [(-0.05, 0.5), (1.1, 0.5), (0.5, -0.2), (0.5, 1.3)];
        let scaled = scale_polygon(&p, 1600.0, 1200.0);
        assert_eq!(scaled[0].x, 0.0);
        assert_eq!(scaled[1].x, 1600.0);
        assert_eq!(scaled[2].y, 0.0);
        assert_eq!(scaled[3].y, 1200.0);
    }

    #[test]
    fn scale_keeps_interior_vertices() {
        let p = [(0.25, 0.5)];
        let scaled = scale_polygon(&p, 1600.0, 1200.0);
        assert_eq!(scaled[0].x, 400.0);
        assert_eq!(scaled[0].y, 600.0);
    }

    #[test]
    fn vent_origin_in_seafloor() {
        let (vx, vy) = scale_vent_origin(1600.0, 1200.0);
        assert!((vx - 640.0).abs() < 1e-3);
        assert!((vy - 1158.0).abs() < 1e-3);
    }
}
