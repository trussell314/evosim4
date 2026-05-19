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
// To edit the layout, change the vertices and re-run; the rest of the
// engine (collision lobes, founder placement, wave clipping, vent) is
// driven off the resulting Obstacle polygons.

export interface NormPoint { x: number; y: number }

export interface NormPolygon {
  // Counter-clockwise outline (in screen-space y-down terms; visually
  // clockwise on screen). The renderer + lobe packer both tolerate
  // either winding, but stay consistent here for sanity.
  points: NormPoint[];
}

// 1. Top-left rock mass. Comes down from the top edge as a cliff,
// pokes out over the water with a small overhang, then trails off
// along the left wall.
export const ROCK_TOP_LEFT: NormPolygon = {
  points: [
    { x: 0.00, y: 0.00 },
    { x: 0.55, y: 0.00 },
    { x: 0.60, y: 0.05 },
    { x: 0.62, y: 0.13 },
    { x: 0.55, y: 0.19 },
    { x: 0.58, y: 0.26 },
    { x: 0.45, y: 0.30 },
    { x: 0.32, y: 0.34 },
    { x: 0.24, y: 0.42 },
    { x: 0.13, y: 0.40 },
    { x: 0.06, y: 0.30 },
    { x: 0.00, y: 0.40 },
  ],
};

// 2. Right-side mid-depth bulge.
export const ROCK_RIGHT_MID: NormPolygon = {
  points: [
    { x: 1.00, y: 0.52 },
    { x: 0.82, y: 0.58 },
    { x: 0.72, y: 0.66 },
    { x: 0.80, y: 0.73 },
    { x: 1.00, y: 0.76 },
  ],
};

// 3. Right-side lower outcropping.
export const ROCK_RIGHT_LOW: NormPolygon = {
  points: [
    { x: 1.00, y: 0.81 },
    { x: 0.78, y: 0.83 },
    { x: 0.64, y: 0.87 },
    { x: 0.72, y: 0.92 },
    { x: 1.00, y: 0.90 },
  ],
};

// 4. Seafloor: spans the bottom edge wall-to-wall with an undulating
// top contour. A few prominent peaks + a deeper notch in the middle
// (vent sits in/near the notch).
export const ROCK_SEAFLOOR: NormPolygon = {
  points: [
    { x: 0.00, y: 1.00 },
    { x: 0.00, y: 0.86 },
    { x: 0.05, y: 0.90 },
    { x: 0.10, y: 0.84 },
    { x: 0.15, y: 0.89 },
    { x: 0.22, y: 0.86 },
    { x: 0.28, y: 0.91 },
    { x: 0.35, y: 0.94 },
    { x: 0.40, y: 0.93 },
    { x: 0.44, y: 0.96 },   // vent sits here
    { x: 0.50, y: 0.94 },
    { x: 0.58, y: 0.90 },
    { x: 0.64, y: 0.94 },
    { x: 0.70, y: 0.90 },
    { x: 0.78, y: 0.94 },
    { x: 0.85, y: 0.92 },
    { x: 0.92, y: 0.95 },
    { x: 1.00, y: 0.93 },
    { x: 1.00, y: 1.00 },
  ],
};

export const ROCK_POLYGONS: NormPolygon[] = [
  ROCK_TOP_LEFT,
  ROCK_RIGHT_MID,
  ROCK_RIGHT_LOW,
  ROCK_SEAFLOOR,
];

// Vent location. Sits in the seafloor notch; emissions come out
// upward (toward y=0). The vent is a point feature in the engine
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
