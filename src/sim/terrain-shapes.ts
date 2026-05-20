// Hand-authored static terrain. The polygons here are traced from a
// freehand layout and stored in normalized [0,1] coordinates. At world
// creation time they get stretched to fit the actual world width/height
// (see generateObstacles in sim.ts). Vertices that lie on a [0,1] edge
// snap to the corresponding world boundary so the silhouette stays
// flush against the wall regardless of aspect ratio.
//
// Coordinate convention matches the rest of the engine: x grows right,
// y grows DOWN (y=0 is the top of the world, y=1 is the floor).

export interface NormPoint { x: number; y: number }

export interface NormPolygon {
  // Outline. Either winding works -- the lobe packer uses an even-odd
  // point-in-polygon test, and the renderer fills with non-zero.
  // Simple closed loop; re-entrant notches (the top-left bay) OK.
  points: NormPoint[];
}

// 1. Top-left rock. Compact mass anchored to the top edge with a
// re-entrant BAY carved out of the silhouette. Sits across the upper
// ~25% of the world; reaches the left edge briefly near y=0.18, then
// curves up and away so the water column below the rock is open.
export const ROCK_TOP_LEFT: NormPolygon = {
  points: [
    // Top edge from left corner to the start of the bay.
    { x: 0.00, y: 0.00 },
    { x: 0.06, y: 0.00 },
    { x: 0.12, y: 0.00 },
    { x: 0.18, y: 0.00 },
    { x: 0.24, y: 0.00 },
    { x: 0.30, y: 0.00 },
    // Bay opening: descend into the carved-out pool and back up to
    // the top edge. Bay sits between x=0.30 and x=0.56.
    { x: 0.31, y: 0.04 },
    { x: 0.32, y: 0.08 },
    { x: 0.34, y: 0.11 },
    { x: 0.37, y: 0.14 },
    { x: 0.40, y: 0.16 },
    { x: 0.43, y: 0.17 },
    { x: 0.46, y: 0.17 },
    { x: 0.49, y: 0.16 },
    { x: 0.52, y: 0.14 },
    { x: 0.54, y: 0.11 },
    { x: 0.55, y: 0.08 },
    { x: 0.56, y: 0.05 },
    { x: 0.56, y: 0.02 },
    { x: 0.56, y: 0.00 },
    // Top edge resumes; walk right to the rock's right cape.
    { x: 0.60, y: 0.00 },
    { x: 0.64, y: 0.00 },
    { x: 0.66, y: 0.00 },
    // Right face: short descent, then a clean curve back left under.
    { x: 0.66, y: 0.03 },
    { x: 0.66, y: 0.06 },
    { x: 0.65, y: 0.09 },
    { x: 0.63, y: 0.12 },
    { x: 0.60, y: 0.14 },
    { x: 0.57, y: 0.16 },
    // Underside (water-facing). Slopes UP toward the right tip --
    // rock tapers thinner as it juts into open water. Doesn't reach
    // anywhere near the bottom of the world: stops well above
    // mid-height. The whole lower half of the original mass is GONE.
    { x: 0.53, y: 0.17 },
    { x: 0.48, y: 0.18 },
    { x: 0.43, y: 0.19 },
    { x: 0.38, y: 0.20 },
    { x: 0.32, y: 0.21 },
    { x: 0.26, y: 0.21 },
    { x: 0.20, y: 0.20 },
    { x: 0.14, y: 0.19 },
    { x: 0.09, y: 0.18 },
    { x: 0.05, y: 0.18 },
    // Left edge: rock touches the wall briefly around y=0.18, then
    // climbs back up. Most of the left wall stays open water.
    { x: 0.00, y: 0.18 },
    { x: 0.00, y: 0.14 },
    { x: 0.00, y: 0.10 },
    { x: 0.00, y: 0.06 },
  ],
};

// 2. Right-side mid-depth bulge. Now smaller and pulled in toward
// the right wall so it doesn't dominate the right side of the world.
export const ROCK_RIGHT_MID: NormPolygon = {
  points: [
    { x: 1.00, y: 0.52 },
    { x: 0.97, y: 0.53 },
    { x: 0.93, y: 0.55 },
    { x: 0.89, y: 0.58 },
    { x: 0.86, y: 0.61 },
    { x: 0.84, y: 0.64 },
    { x: 0.83, y: 0.67 },
    { x: 0.84, y: 0.70 },
    { x: 0.86, y: 0.72 },
    { x: 0.89, y: 0.73 },
    { x: 0.93, y: 0.74 },
    { x: 0.97, y: 0.74 },
    { x: 1.00, y: 0.74 },
  ],
};

// 2b. Right-side spur. A narrow tongue of rock protruding from the
// right wall between the mid bulge and the low outcropping.
export const ROCK_RIGHT_SPUR: NormPolygon = {
  points: [
    { x: 1.00, y: 0.77 },
    { x: 0.96, y: 0.77 },
    { x: 0.92, y: 0.78 },
    { x: 0.88, y: 0.78 },
    { x: 0.84, y: 0.79 },
    { x: 0.82, y: 0.80 },
    { x: 0.84, y: 0.81 },
    { x: 0.88, y: 0.81 },
    { x: 0.93, y: 0.80 },
    { x: 0.97, y: 0.79 },
    { x: 1.00, y: 0.79 },
  ],
};

// 3. Right-side lower outcropping. Pulled IN toward the right wall.
// Was too aggressive previously; now a more modest curve.
export const ROCK_RIGHT_LOW: NormPolygon = {
  points: [
    { x: 1.00, y: 0.84 },
    { x: 0.97, y: 0.84 },
    { x: 0.93, y: 0.85 },
    { x: 0.88, y: 0.86 },
    { x: 0.83, y: 0.87 },
    { x: 0.78, y: 0.88 },
    { x: 0.74, y: 0.90 },
    { x: 0.72, y: 0.92 },
    { x: 0.74, y: 0.94 },
    { x: 0.79, y: 0.94 },
    { x: 0.85, y: 0.93 },
    { x: 0.91, y: 0.92 },
    { x: 0.96, y: 0.92 },
    { x: 1.00, y: 0.92 },
  ],
};

// 4. Central spire. New: a discrete rock formation rising out of the
// seafloor in the middle of the world. Narrower at the top, wider at
// the base; merges into the seafloor implicitly via the bottom edge.
// Sits at x=~0.40..0.58, top of spire at y=~0.68.
export const ROCK_CENTRAL_SPIRE: NormPolygon = {
  points: [
    { x: 0.42, y: 0.92 },
    { x: 0.41, y: 0.88 },
    { x: 0.42, y: 0.84 },
    { x: 0.43, y: 0.80 },
    { x: 0.44, y: 0.76 },
    { x: 0.45, y: 0.72 },
    { x: 0.47, y: 0.70 },
    { x: 0.49, y: 0.68 },
    { x: 0.52, y: 0.69 },
    { x: 0.54, y: 0.71 },
    { x: 0.55, y: 0.74 },
    { x: 0.56, y: 0.78 },
    { x: 0.57, y: 0.82 },
    { x: 0.58, y: 0.86 },
    { x: 0.58, y: 0.90 },
    { x: 0.57, y: 0.94 },
    { x: 0.50, y: 0.94 },
  ],
};

// 5. Seafloor. Spans the bottom wall-to-wall with a varied top
// contour. The vent cavern is to the LEFT of the central spire (and
// the spire is a separate polygon, so the seafloor outline just
// passes underneath it).
export const ROCK_SEAFLOOR: NormPolygon = {
  points: [
    // Top contour walking left to right.
    { x: 0.00, y: 0.88 },
    { x: 0.03, y: 0.88 },
    { x: 0.06, y: 0.85 },  // small peak
    { x: 0.09, y: 0.87 },
    { x: 0.12, y: 0.84 },  // higher peak
    { x: 0.15, y: 0.86 },
    { x: 0.18, y: 0.85 },
    { x: 0.21, y: 0.87 },
    { x: 0.24, y: 0.86 },
    { x: 0.27, y: 0.88 },
    { x: 0.30, y: 0.87 },
    { x: 0.33, y: 0.89 },
    { x: 0.36, y: 0.91 },  // descending into cavern
    { x: 0.39, y: 0.93 },
    { x: 0.42, y: 0.94 },  // cavern floor begins
    { x: 0.44, y: 0.95 },  // vent mouth here
    { x: 0.46, y: 0.94 },
    { x: 0.48, y: 0.93 },
    { x: 0.50, y: 0.92 },
    { x: 0.55, y: 0.93 },
    { x: 0.60, y: 0.93 },  // past the spire base
    { x: 0.63, y: 0.91 },
    { x: 0.66, y: 0.89 },
    { x: 0.69, y: 0.87 },
    { x: 0.72, y: 0.88 },
    { x: 0.75, y: 0.87 },
    { x: 0.78, y: 0.89 },
    { x: 0.81, y: 0.88 },
    { x: 0.84, y: 0.90 },
    { x: 0.87, y: 0.89 },
    { x: 0.90, y: 0.91 },
    { x: 0.93, y: 0.90 },
    { x: 0.96, y: 0.92 },
    { x: 1.00, y: 0.91 },
    { x: 1.00, y: 1.00 },
    { x: 0.00, y: 1.00 },
  ],
};

export const ROCK_POLYGONS: NormPolygon[] = [
  ROCK_TOP_LEFT,
  ROCK_RIGHT_MID,
  ROCK_RIGHT_SPUR,
  ROCK_RIGHT_LOW,
  ROCK_CENTRAL_SPIRE,
  ROCK_SEAFLOOR,
];

// Vent location. Sits in the seafloor cavern notch; emissions come
// out upward.
export const VENT_ORIGIN: NormPoint = { x: 0.44, y: 0.95 };

// Re-anchor a polygon to the actual world width/height. Vertices on a
// [0,1] edge in normalized space snap exactly to the world boundary
// even after float math, so the polygon stays flush against the wall.
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
