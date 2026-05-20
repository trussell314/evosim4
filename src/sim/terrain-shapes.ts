// Hand-authored static terrain. The polygons here are traced from a
// freehand layout and stored in normalized [0,1] coordinates. At world
// creation time they get stretched to fit the actual world width/height
// (see generateObstacles in sim.ts). Vertices that lie on a [0,1] edge
// snap to the corresponding world boundary so the silhouette stays
// flush against the wall regardless of aspect ratio.
//
// Coordinate convention matches the rest of the engine: x grows right,
// y grows DOWN (y=0 is the top of the world, y=1 is the floor).
//
// Vertex counts are intentionally high (30-60 per shape) so the lobe
// packer + the renderer's polygon outline both pick up real silhouette
// detail. Hand-tuned for the freehand reference; tweak vertices in
// place to refine.

export interface NormPoint { x: number; y: number }

export interface NormPolygon {
  // Outline. Either winding works -- the lobe packer uses an even-odd
  // point-in-polygon test, and the renderer fills with non-zero. Keep
  // the loop simple (no self-intersection); re-entrant notches (the
  // top-left bay) are fine.
  points: NormPoint[];
}

// 1. Top-left rock formation. A continuous mass anchored to the top
// edge and the left edge, with a re-entrant BAY carved out of its
// upper silhouette -- the pool of water sits inside that notch. The
// outline therefore goes: along the top edge -> down into the bay ->
// across the bay floor -> back up to the top edge -> along the top
// edge to the right side of the rock -> down the right face -> across
// the rugged lower edge -> back to the left edge.
export const ROCK_TOP_LEFT: NormPolygon = {
  points: [
    // Top-left corner, then walk right along the top edge to the
    // start of the bay.
    { x: 0.00, y: 0.00 },
    { x: 0.08, y: 0.00 },
    { x: 0.16, y: 0.00 },
    { x: 0.24, y: 0.00 },
    { x: 0.30, y: 0.00 },
    // Bay opening: descend into the carved-out pool, around its
    // floor, and back up to the top edge on the far side. The bay
    // sits between x=0.30 and x=0.56, opening to the sky.
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
    // Continue right along the top edge to the right edge of the rock.
    { x: 0.62, y: 0.00 },
    { x: 0.66, y: 0.00 },
    // Right face descending in a couple of crags.
    { x: 0.68, y: 0.03 },
    { x: 0.69, y: 0.07 },
    { x: 0.71, y: 0.11 },
    { x: 0.70, y: 0.15 },
    { x: 0.69, y: 0.19 },
    { x: 0.67, y: 0.23 },
    { x: 0.64, y: 0.26 },
    { x: 0.61, y: 0.28 },
    // Underside of the rock: gentle wave with overhang feel.
    { x: 0.58, y: 0.30 },
    { x: 0.54, y: 0.31 },
    { x: 0.50, y: 0.31 },
    { x: 0.46, y: 0.32 },
    { x: 0.42, y: 0.33 },
    { x: 0.38, y: 0.35 },
    { x: 0.34, y: 0.37 },
    { x: 0.30, y: 0.39 },
    { x: 0.26, y: 0.41 },
    { x: 0.22, y: 0.42 },
    { x: 0.18, y: 0.42 },
    { x: 0.14, y: 0.41 },
    { x: 0.11, y: 0.39 },
    { x: 0.09, y: 0.36 },
    { x: 0.07, y: 0.33 },
    { x: 0.05, y: 0.31 },
    { x: 0.03, y: 0.32 },
    { x: 0.01, y: 0.35 },
    { x: 0.00, y: 0.38 },
    // Down the left edge to the corner where the rock returns to
    // the wall, then back to the top-left.
    { x: 0.00, y: 0.30 },
    { x: 0.00, y: 0.22 },
    { x: 0.00, y: 0.14 },
    { x: 0.00, y: 0.06 },
  ],
};

// 2. Right-side mid-depth bulge. Larger and more arched than v1.
// A broad lobe protruding from the right edge with a rounded face.
export const ROCK_RIGHT_MID: NormPolygon = {
  points: [
    { x: 1.00, y: 0.46 },
    { x: 0.96, y: 0.48 },
    { x: 0.91, y: 0.50 },
    { x: 0.86, y: 0.52 },
    { x: 0.81, y: 0.55 },
    { x: 0.77, y: 0.58 },
    { x: 0.73, y: 0.61 },
    { x: 0.70, y: 0.64 },
    { x: 0.68, y: 0.67 },
    { x: 0.67, y: 0.70 },
    { x: 0.69, y: 0.72 },
    { x: 0.72, y: 0.74 },
    { x: 0.76, y: 0.75 },
    { x: 0.80, y: 0.76 },
    { x: 0.85, y: 0.77 },
    { x: 0.90, y: 0.78 },
    { x: 0.95, y: 0.78 },
    { x: 1.00, y: 0.78 },
  ],
};

// 3. Right-side lower outcropping. Bigger and more arched than v1 --
// a substantial lobe with a clear curved face.
export const ROCK_RIGHT_LOW: NormPolygon = {
  points: [
    { x: 1.00, y: 0.80 },
    { x: 0.96, y: 0.81 },
    { x: 0.91, y: 0.82 },
    { x: 0.85, y: 0.83 },
    { x: 0.78, y: 0.83 },
    { x: 0.70, y: 0.84 },
    { x: 0.63, y: 0.85 },
    { x: 0.57, y: 0.87 },
    { x: 0.53, y: 0.89 },
    { x: 0.51, y: 0.91 },
    { x: 0.53, y: 0.93 },
    { x: 0.56, y: 0.95 },
    { x: 0.60, y: 0.95 },
    { x: 0.65, y: 0.94 },
    { x: 0.70, y: 0.93 },
    { x: 0.76, y: 0.92 },
    { x: 0.82, y: 0.91 },
    { x: 0.88, y: 0.91 },
    { x: 0.94, y: 0.91 },
    { x: 1.00, y: 0.92 },
  ],
};

// 4. Seafloor: spans the bottom wall-to-wall with a pronounced
// peak/notch contour and a clear CAVERN notch in the middle where
// the vent opens out. High-detail top contour (~30 vertices) gives
// real visual texture instead of a smooth shelf.
export const ROCK_SEAFLOOR: NormPolygon = {
  points: [
    // Top contour walking left to right.
    { x: 0.00, y: 0.85 },
    { x: 0.03, y: 0.86 },
    { x: 0.06, y: 0.83 },  // small peak
    { x: 0.09, y: 0.85 },
    { x: 0.12, y: 0.82 },  // higher peak
    { x: 0.15, y: 0.84 },
    { x: 0.18, y: 0.83 },
    { x: 0.21, y: 0.86 },
    { x: 0.24, y: 0.84 },
    { x: 0.27, y: 0.87 },
    { x: 0.30, y: 0.85 },
    { x: 0.33, y: 0.88 },
    { x: 0.36, y: 0.90 },  // descending into cavern
    { x: 0.39, y: 0.92 },
    { x: 0.42, y: 0.93 },  // cavern floor begins
    { x: 0.44, y: 0.95 },  // vent mouth here
    { x: 0.46, y: 0.94 },
    { x: 0.48, y: 0.92 },
    { x: 0.50, y: 0.89 },  // climbing out of cavern
    { x: 0.53, y: 0.86 },
    { x: 0.56, y: 0.84 },  // peak past the cavern
    { x: 0.59, y: 0.86 },
    { x: 0.62, y: 0.83 },  // tall peak
    { x: 0.65, y: 0.85 },
    { x: 0.68, y: 0.84 },
    { x: 0.71, y: 0.87 },
    { x: 0.74, y: 0.85 },
    { x: 0.77, y: 0.88 },
    { x: 0.80, y: 0.87 },
    { x: 0.83, y: 0.90 },
    { x: 0.86, y: 0.88 },
    { x: 0.89, y: 0.91 },
    { x: 0.92, y: 0.89 },
    { x: 0.95, y: 0.92 },
    { x: 0.98, y: 0.90 },
    { x: 1.00, y: 0.91 },
    // Right edge down to corner, across the bottom, back to left.
    { x: 1.00, y: 1.00 },
    { x: 0.00, y: 1.00 },
  ],
};

export const ROCK_POLYGONS: NormPolygon[] = [
  ROCK_TOP_LEFT,
  ROCK_RIGHT_MID,
  ROCK_RIGHT_LOW,
  ROCK_SEAFLOOR,
];

// Vent location. Sits in the seafloor cavern notch; emissions come
// out upward (toward y=0). The vent is a point feature in the engine
// (not part of any Obstacle polygon) -- the seafloor polygon dips
// down right above it so the visual reads as "opening in the rock".
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
