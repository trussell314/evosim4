// Hand-authored static terrain. The polygons here are imported
// verbatim from the user's Inkscape drawing (210x297 mm A4 portrait,
// converted to normalized [0,1] world coords). Vertices that lie at
// or outside the [0,1] box (the path was drawn slightly off-canvas
// to anchor against the walls) snap to the world boundary in
// scalePolygon below.
//
// To re-trace: redraw in Inkscape over a 210x297 page, paste the
// path "d" attributes into scripts/parse-svg.mjs, run, and replace
// the polygon points below with the output.
//
// Coordinate convention: x grows right, y grows DOWN.

export interface NormPoint { x: number; y: number }

export interface NormPolygon {
  points: NormPoint[];
}

// 1. Top-left mass. Hooks out from the upper-left corner with a
// crag-laden silhouette, descends to the left edge around y=0.33.
export const ROCK_TOP_LEFT: NormPolygon = {
  points: [
    { x: -0.0345, y: -0.0043 },
    { x: -0.0254, y: -0.0020 },
    { x: -0.0040, y:  0.0039 },
    { x:  0.0256, y:  0.0123 },
    { x:  0.0592, y:  0.0219 },
    { x:  0.0925, y:  0.0314 },
    { x:  0.1215, y:  0.0398 },
    { x:  0.1419, y:  0.0457 },
    { x:  0.1497, y:  0.0480 },
    { x:  0.1921, y:  0.0985 },
    { x:  0.1949, y:  0.0994 },
    { x:  0.2025, y:  0.1018 },
    { x:  0.2131, y:  0.1052 },
    { x:  0.2255, y:  0.1090 },
    { x:  0.2380, y:  0.1128 },
    { x:  0.2491, y:  0.1161 },
    { x:  0.2573, y:  0.1183 },
    { x:  0.2612, y:  0.1191 },
    { x:  0.2654, y:  0.1183 },
    { x:  0.2748, y:  0.1164 },
    { x:  0.2875, y:  0.1137 },
    { x:  0.3020, y:  0.1108 },
    { x:  0.3164, y:  0.1078 },
    { x:  0.3291, y:  0.1051 },
    { x:  0.3383, y:  0.1032 },
    { x:  0.3424, y:  0.1024 },
    { x:  0.3461, y:  0.1011 },
    { x:  0.3546, y:  0.0979 },
    { x:  0.3661, y:  0.0935 },
    { x:  0.3790, y:  0.0885 },
    { x:  0.3919, y:  0.0835 },
    { x:  0.4030, y:  0.0792 },
    { x:  0.4109, y:  0.0761 },
    { x:  0.4139, y:  0.0750 },
    { x:  0.4569, y:  0.0326 },
    { x:  0.4951, y:  0.0266 },
    { x:  0.5157, y:  0.0441 },
    { x:  0.5153, y:  0.0449 },
    { x:  0.5144, y:  0.0468 },
    { x:  0.5130, y:  0.0496 },
    { x:  0.5113, y:  0.0529 },
    { x:  0.5095, y:  0.0562 },
    { x:  0.5077, y:  0.0591 },
    { x:  0.5061, y:  0.0614 },
    { x:  0.5048, y:  0.0626 },
    { x:  0.5032, y:  0.0636 },
    { x:  0.5010, y:  0.0657 },
    { x:  0.4984, y:  0.0684 },
    { x:  0.4957, y:  0.0714 },
    { x:  0.4932, y:  0.0743 },
    { x:  0.4910, y:  0.0768 },
    { x:  0.4896, y:  0.0786 },
    { x:  0.4890, y:  0.0793 },
    { x:  0.4887, y:  0.0806 },
    { x:  0.4880, y:  0.0842 },
    { x:  0.4869, y:  0.0892 },
    { x:  0.4857, y:  0.0951 },
    { x:  0.4844, y:  0.1011 },
    { x:  0.4834, y:  0.1064 },
    { x:  0.4826, y:  0.1103 },
    { x:  0.4823, y:  0.1123 },
    { x:  0.4827, y:  0.1137 },
    { x:  0.4836, y:  0.1164 },
    { x:  0.4848, y:  0.1199 },
    { x:  0.4863, y:  0.1238 },
    { x:  0.4877, y:  0.1276 },
    { x:  0.4890, y:  0.1309 },
    { x:  0.4899, y:  0.1332 },
    { x:  0.4902, y:  0.1341 },
    { x:  0.4926, y:  0.1675 },
    { x:  0.3920, y:  0.1928 },
    { x:  0.3296, y:  0.2348 },
    { x:  0.2806, y:  0.2755 },
    { x:  0.2790, y:  0.2751 },
    { x:  0.2751, y:  0.2742 },
    { x:  0.2694, y:  0.2728 },
    { x:  0.2629, y:  0.2712 },
    { x:  0.2564, y:  0.2695 },
    { x:  0.2506, y:  0.2679 },
    { x:  0.2465, y:  0.2666 },
    { x:  0.2448, y:  0.2656 },
    { x:  0.2421, y:  0.2640 },
    { x:  0.2355, y:  0.2606 },
    { x:  0.2261, y:  0.2562 },
    { x:  0.2155, y:  0.2513 },
    { x:  0.2049, y:  0.2464 },
    { x:  0.1956, y:  0.2423 },
    { x:  0.1891, y:  0.2393 },
    { x:  0.1866, y:  0.2382 },
    { x:  0.1857, y:  0.2379 },
    { x:  0.1832, y:  0.2372 },
    { x:  0.1795, y:  0.2362 },
    { x:  0.1753, y:  0.2351 },
    { x:  0.1708, y:  0.2339 },
    { x:  0.1667, y:  0.2330 },
    { x:  0.1633, y:  0.2324 },
    { x:  0.1612, y:  0.2322 },
    { x:  0.1589, y:  0.2331 },
    { x:  0.1551, y:  0.2351 },
    { x:  0.1504, y:  0.2380 },
    { x:  0.1453, y:  0.2412 },
    { x:  0.1403, y:  0.2443 },
    { x:  0.1361, y:  0.2471 },
    { x:  0.1332, y:  0.2490 },
    { x:  0.1321, y:  0.2498 },
    { x:  0.0921, y:  0.2712 },
    { x:  0.0904, y:  0.2719 },
    { x:  0.0858, y:  0.2736 },
    { x:  0.0792, y:  0.2762 },
    { x:  0.0716, y:  0.2792 },
    { x:  0.0637, y:  0.2824 },
    { x:  0.0566, y:  0.2855 },
    { x:  0.0510, y:  0.2881 },
    { x:  0.0479, y:  0.2901 },
    { x:  0.0445, y:  0.2929 },
    { x:  0.0381, y:  0.2981 },
    { x:  0.0299, y:  0.3048 },
    { x:  0.0208, y:  0.3121 },
    { x:  0.0120, y:  0.3192 },
    { x:  0.0043, y:  0.3253 },
    { x: -0.0010, y:  0.3296 },
    { x: -0.0030, y:  0.3312 },
    { x: -0.0267, y:  0.2905 },
  ],
};

// 2. Right-side rock. Hooks in from the right wall, sweeps across
// to a peak at ~0.52x then back to the right wall.
export const ROCK_RIGHT_MID: NormPolygon = {
  points: [
    { x: 1.0266, y: 0.4702 },
    { x: 0.6393, y: 0.5320 },
    { x: 0.5330, y: 0.5817 },
    { x: 0.5244, y: 0.6508 },
    { x: 0.5364, y: 0.6920 },
    { x: 0.5742, y: 0.7065 },
    { x: 0.5755, y: 0.7066 },
    { x: 0.5791, y: 0.7068 },
    { x: 0.5848, y: 0.7071 },
    { x: 0.5921, y: 0.7073 },
    { x: 0.6008, y: 0.7073 },
    { x: 0.6103, y: 0.7070 },
    { x: 0.6204, y: 0.7064 },
    { x: 0.6307, y: 0.7053 },
    { x: 0.6424, y: 0.7026 },
    { x: 0.6562, y: 0.6979 },
    { x: 0.6710, y: 0.6918 },
    { x: 0.6856, y: 0.6851 },
    { x: 0.6989, y: 0.6786 },
    { x: 0.7098, y: 0.6731 },
    { x: 0.7171, y: 0.6692 },
    { x: 0.7198, y: 0.6677 },
    { x: 0.7524, y: 0.6447 },
    { x: 0.7935, y: 0.6289 },
    { x: 0.8398, y: 0.6386 },
    { x: 0.8861, y: 0.6641 },
    { x: 0.8981, y: 0.6762 },
    { x: 0.9238, y: 0.7065 },
    { x: 0.9563, y: 0.7223 },
    { x: 0.9855, y: 0.7271 },
    { x: 1.0249, y: 0.7307 },
    { x: 1.0489, y: 0.7307 },
  ],
};

// 3. Seafloor + lower-left rock. Spans the bottom of the world with
// a complex top contour and a re-entrant section in the middle.
export const ROCK_SEAFLOOR: NormPolygon = {
  points: [
    { x:  1.0249, y: 0.8337 },
    { x:  0.8535, y: 0.8774 },
    { x:  0.7284, y: 0.8955 },
    { x:  0.6136, y: 0.8943 },
    { x:  0.5622, y: 0.8604 },
    { x:  0.4970, y: 0.7901 },
    { x:  0.4199, y: 0.7198 },
    { x:  0.3445, y: 0.7126 },
    { x:  0.2982, y: 0.7174 },
    { x:  0.2571, y: 0.7223 },
    { x:  0.2108, y: 0.7477 },
    { x:  0.2121, y: 0.7489 },
    { x:  0.2155, y: 0.7521 },
    { x:  0.2204, y: 0.7565 },
    { x:  0.2262, y: 0.7616 },
    { x:  0.2324, y: 0.7668 },
    { x:  0.2383, y: 0.7712 },
    { x:  0.2433, y: 0.7744 },
    { x:  0.2468, y: 0.7756 },
    { x:  0.2523, y: 0.7763 },
    { x:  0.2625, y: 0.7782 },
    { x:  0.2758, y: 0.7809 },
    { x:  0.2905, y: 0.7841 },
    { x:  0.3048, y: 0.7872 },
    { x:  0.3172, y: 0.7899 },
    { x:  0.3258, y: 0.7918 },
    { x:  0.3291, y: 0.7925 },
    { x:  0.4079, y: 0.8265 },
    { x:  0.4285, y: 0.8531 },
    { x:  0.4490, y: 0.8846 },
    { x:  0.4525, y: 0.8992 },
    { x:  0.4490, y: 0.9392 },
    { x:  0.3822, y: 0.9610 },
    { x:  0.3428, y: 0.9380 },
    { x:  0.3256, y: 0.9016 },
    { x:  0.3068, y: 0.8701 },
    { x:  0.2365, y: 0.8398 },
    { x:  0.1851, y: 0.8337 },
    { x:  0.1268, y: 0.8228 },
    { x:  0.0446, y: 0.8059 },
    { x:  0.0291, y: 0.7671 },
    { x: -0.0069, y: 0.6835 },
    { x: -0.0463, y: 0.7004 },
    { x: -0.0463, y: 1.0495 },
    { x:  1.0575, y: 1.0240 },
  ],
};

export const ROCK_POLYGONS: NormPolygon[] = [
  ROCK_TOP_LEFT,
  ROCK_RIGHT_MID,
  ROCK_SEAFLOOR,
];

// Vent location. Sits in the seafloor; emissions come out upward.
export const VENT_ORIGIN: NormPoint = { x: 0.44, y: 0.95 };

// Re-anchor a polygon to the actual world width/height. Vertices at
// or outside the [0,1] box snap exactly to the world boundary so an
// off-canvas vertex (deliberately drawn outside to anchor against a
// wall) lands flush instead of leaking a sliver of water through.
export function scalePolygon(
  poly: NormPolygon,
  width: number,
  height: number,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const p of poly.points) {
    const sx = p.x <= 0 ? 0 : p.x >= 1 ? width : p.x * width;
    const sy = p.y <= 0 ? 0 : p.y >= 1 ? height : p.y * height;
    out.push({ x: sx, y: sy });
  }
  return out;
}
