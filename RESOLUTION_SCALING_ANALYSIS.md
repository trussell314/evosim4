# World-resolution scaling: performance & fidelity

Status: **analysis only — tabled, not implemented.**

Question: if we change the "resolution" of the sim (its spatial extent —
`width`×`height`), what's the performance and fidelity impact? Two cases
for how the chemistry region grid responds:

- **Case A** — keep the *same number* of regions (regions enlarge to cover
  the extra space; you'd scale `REGION_PX` up with the world).
- **Case B** — keep region *size* fixed, so the region count grows to fill
  the space.

## How the engine scales today (the load-bearing facts)

- **Region grid is fixed cell size:** `REGION_PX = 50`, so
  `regionCols/regionRows = ceil(dimension / 50)` (`src/sim.ts`). Region
  count therefore **already scales with area by default** → **Case B is the
  current behavior**, and **Case A is the one you'd have to force** (scale
  `REGION_PX`).
- **Population/particle counts are fixed, not area-scaled:**
  `INITIAL_PARTICLE_TARGET = 1000` (user-adjustable to 50k) and
  `FOUNDER_TARGET = 10`. So in a bigger world the **biological density
  drops** unless you also raise these.
- **Other spatial grids are fixed cell size too:** `CREATURE_GRID_CELL = 64`,
  `PARTICLE_GRID_CELL = 32` (auto-add cells with the world; cheap — mostly
  empty buckets). The terrain heightmap is one entry per world-x px.
- **Sensing / shadow ranges are fixed in px:** electro 90, light 110,
  vibration 180, `SHADE_DEPTH` 60, the sun shadow slope, etc. In a bigger
  world they cover *relatively less* of it.

## Per-tick cost classes

| Class | Scales with | Examples |
|---|---|---|
| **O(creatures)** | population N | per-cell loop: reactions, sensing scans, biosynth, emission pass. Dominant when N is large. Sensing scans use fixed-px ranges, so each is constant → total O(N). |
| **O(particles)** | particle count | particle physics, ingestion, particle grid. |
| **O(regions)** | region count | chemistry-field diffusion, temperature rebuild, the `ambient`+`reserve` arrays (`2 × regions × 96` floats). |
| **O(area / pixels)** | world area | rendering: background fills, overlay sampling (light overlay samples every ~6 px ∝ area), heightmap/occlusion scan ∝ width. |

## Case A — same # of regions (regions enlarge)

- **Performance:** region cost (diffusion, temp, `ambient`/`reserve`
  memory) **stays flat**; per-creature/particle cost unchanged (counts
  fixed). Real growth is **rendering** (bigger canvas) + slightly larger
  spatial-grid allocations. → **Modest** increase, render-bound.
- **Fidelity:** **drops per area.** Each region averages
  chemistry/temperature over a bigger blob → blurrier gradients, less
  spatial structure (vent plumes, dead zones, acid pockets smear out).
  Combined with fixed particle/creature counts over more space →
  **sparser, thinner ecology.** More *space*, coarser *detail*.

## Case B — region count grows (`REGION_PX` fixed; default)

- **Performance:** region count ∝ area → **diffusion + temperature +
  field memory scale linearly with area** (and the save file grows with
  it), plus rendering ∝ area. With population/particles still capped,
  per-entity cost is flat, so total ≈ **linear in area**, region- and
  render-bound.
- **Fidelity:** **chemistry resolution preserved** — gradients/structure
  stay as crisp per area as today. That's the win.

## The caveat that dominates both

Neither case changes **biological density** on its own, because particle
and founder counts are fixed. To make a bigger world *feel* as alive
(fidelity of the life, not just the chemistry), also scale
**`particleTarget`** and the **founder cap** with area — and that is what
makes the **O(creatures)+O(particles) loops grow linearly with area**, the
steepest per-tick cost. So:

- Bigger but cheaper, accepting emptier/coarser → **Case A**.
- Bigger and behaving like more of the same world → **Case B + scale
  `particleTarget` & founders**; expect cost ≈ linear in area across all
  three loops.

## If/when implemented — knobs & follow-through

- Tunables to scale together for proportional behavior: `REGION_PX` (A
  only), `CREATURE_GRID_CELL`, `PARTICLE_GRID_CELL`, `particleTarget`,
  founder cap, and the fixed sensing/shadow ranges.
- A world-size control (or auto-scaling `particleTarget`/founder cap with
  area) would be the user-facing surface.
- **`SAVE_SCHEMA` + golden:** changing world size / region layout changes
  the seeded fingerprint (golden rebaseline) and the per-region field
  sizes in the save (schema bump if the layout encoding changes).
