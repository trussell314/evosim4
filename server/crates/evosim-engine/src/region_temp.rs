//! Regional temperature field. Substrate port of
//! `regions.ts:sampleRegionTemps`.
//!
//! Per-region scalar (°C) on a 50px grid. Each tick the field:
//!   1. Diffuses across the 4-neighbour Laplacian at `DIFF_RATE`.
//!   2. Relaxes toward an analytical baseline `TEMP_BASELINE` at
//!      `RELAX_RATE`. This is the distributed heat SINK that keeps
//!      bulk water at the baseline regardless of vent intensity.
//!   3. Receives a Gaussian source-term injection from the active
//!      vent (peak `VENT_TEMP_PEAK_AMP` * intensity at the mouth).
//!
//! The first call after a world reset / resize seeds the field with
//! the baseline and skips stepping; subsequent calls double-buffer
//! the Laplacian for order-independence.
//!
//! Consumed by:
//!   - `region_dissolved_capacity` in `regions.rs` -- warmer regions
//!     hold less gas (Henry's law) and more condensed phase
//!   - the precipitation pass for the per-region capacity check
//!   - future Q10 + THERMO receptor consumers (cells reading the
//!     thermal gradient via the activation pass)
//!
//! `VENT_BASE_INTENSITY` keeps a standing hot zone around the vent
//! mouth between eruptions -- always-on heat with the eruption
//! envelope spiking on top. Matches the TS schedule.

use crate::ambient::AmbientField;
use crate::regions::{region_cols, region_index_at, region_rows, REGION_PX, TEMP_BASELINE};
use crate::vent::{VentState, VENT_TEMP_RADIUS};
use serde::{Deserialize, Serialize};

/// Spread rate of local hot spots into neighbours.
const TEMP_DIFF_RATE: f32 = 0.35;
/// Pull toward the analytical baseline. Slow enough that a vent zone
/// lingers between eruptions instead of relaxing immediately.
const TEMP_RELAX_RATE: f32 = 0.1;
/// How fast vent heat builds up at the mouth per unit intensity.
const TEMP_VENT_INJECT_RATE: f32 = 0.15;
/// Peak vent heat amplitude (°C/sec at the source term, before rate).
const VENT_TEMP_PEAK_AMP: f32 = 100.0;
/// Standing heat from the vent between eruptions (fraction of full
/// intensity).
pub const VENT_BASE_INTENSITY: f32 = 0.4;

/// Per-region temperature field. Double-buffered (`field` + `next`) so
/// the Laplacian pass is order-independent.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RegionTempField {
    pub cols: usize,
    pub rows: usize,
    pub field: Vec<f32>,
    /// Scratch -- always reset to baseline at the start of the next
    /// step; only persisted for save schema stability.
    pub next: Vec<f32>,
}

impl RegionTempField {
    pub fn new() -> Self {
        Self::default()
    }

    /// True if the field's shape matches the given grid size.
    fn shape_matches(&self, cols: usize, rows: usize) -> bool {
        let n = cols * rows;
        self.field.len() == n && self.next.len() == n
    }

    /// Lookup at a world position. Falls back to `TEMP_BASELINE` if
    /// the field hasn't been initialised yet.
    pub fn at(&self, ambient: &AmbientField, x: f32, y: f32) -> f32 {
        if self.field.is_empty() {
            return TEMP_BASELINE;
        }
        let ri = region_index_at(ambient.width, ambient.height, x, y);
        self.field.get(ri).copied().unwrap_or(TEMP_BASELINE)
    }

    /// Read by region index. Same fallback as `at`.
    pub fn by_index(&self, ri: usize) -> f32 {
        self.field.get(ri).copied().unwrap_or(TEMP_BASELINE)
    }
}

/// Advance the per-region temperature field by one tick. Runs the
/// 4-neighbour Laplacian + relaxation toward baseline + vent source
/// term. Idempotent on a freshly-sized world (first call seeds the
/// field with the baseline + skips stepping).
pub fn step_region_temps(
    rt: &mut RegionTempField,
    world_width: f32,
    world_height: f32,
    vent: Option<&VentState>,
    dt: f32,
) {
    let cols = region_cols(world_width);
    let rows = region_rows(world_height);
    let n = cols * rows;
    if n == 0 {
        return;
    }
    if !rt.shape_matches(cols, rows) {
        rt.cols = cols;
        rt.rows = rows;
        rt.field = vec![TEMP_BASELINE; n];
        rt.next = vec![TEMP_BASELINE; n];
        return;
    }

    // Always-on heat: persistent base + eruption envelope on top.
    let (has_vent, vent_x, vent_y, vent_intensity) = match vent {
        Some(v) => {
            let erupt = if v.active { v.intensity } else { 0.0 };
            let intensity = VENT_BASE_INTENSITY + (1.0 - VENT_BASE_INTENSITY) * erupt;
            (true, v.x, v.y, intensity)
        }
        None => (false, 0.0, 0.0, 0.0),
    };
    let r2 = VENT_TEMP_RADIUS * VENT_TEMP_RADIUS;
    let reject_r2 = 9.0 * r2;

    for ry in 0..rows {
        let cy = ((ry as f32) * REGION_PX + REGION_PX * 0.5).min(world_height - 1.0);
        for rx in 0..cols {
            let i = ry * cols + rx;
            let t = rt.field[i];
            // 4-neighbour Laplacian with Neumann BC (use only available
            // neighbours).
            let mut nsum = 0.0_f32;
            let mut ncount = 0.0_f32;
            if rx > 0 {
                nsum += rt.field[i - 1];
                ncount += 1.0;
            }
            if rx < cols - 1 {
                nsum += rt.field[i + 1];
                ncount += 1.0;
            }
            if ry > 0 {
                nsum += rt.field[i - cols];
                ncount += 1.0;
            }
            if ry < rows - 1 {
                nsum += rt.field[i + cols];
                ncount += 1.0;
            }
            let diff = if ncount > 0.0 {
                (nsum / ncount - t) * TEMP_DIFF_RATE * dt
            } else {
                0.0
            };
            // Relax toward the baseline (no depth gradient yet -- when
            // the temperature analytical baseline gains a depth term
            // from `environment.ts`, this becomes `temperatureAt(world, cx, cy)`).
            let relax = (TEMP_BASELINE - t) * TEMP_RELAX_RATE * dt;
            // Vent source: Gaussian bubble * intensity, injected as a rate.
            let cx = ((rx as f32) * REGION_PX + REGION_PX * 0.5).min(world_width - 1.0);
            let mut vent_term = 0.0_f32;
            if has_vent {
                let dx = cx - vent_x;
                let dy = cy - vent_y;
                let d2 = dx * dx + dy * dy;
                if d2 < reject_r2 {
                    vent_term = VENT_TEMP_PEAK_AMP
                        * vent_intensity
                        * (-d2 / r2).exp()
                        * TEMP_VENT_INJECT_RATE
                        * dt;
                }
            }
            rt.next[i] = t + diff + relax + vent_term;
        }
    }
    // Copy back so the field reference stays stable for any consumer
    // (matches TS behaviour).
    for i in 0..n {
        rt.field[i] = rt.next[i];
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::Mulberry32;

    #[test]
    fn first_call_seeds_to_baseline() {
        let mut rt = RegionTempField::new();
        step_region_temps(&mut rt, 200.0, 200.0, None, 0.1);
        assert_eq!(rt.cols, 4);
        assert_eq!(rt.rows, 4);
        for &v in &rt.field {
            assert_eq!(v, TEMP_BASELINE);
        }
    }

    #[test]
    fn relaxes_toward_baseline_without_vent() {
        let mut rt = RegionTempField::new();
        // Seed.
        step_region_temps(&mut rt, 200.0, 200.0, None, 0.1);
        // Push one region's temp up artificially.
        rt.field[0] = TEMP_BASELINE + 50.0;
        // Step a few times -- diffusion smears it; relaxation pulls
        // every region toward baseline.
        for _ in 0..20 {
            step_region_temps(&mut rt, 200.0, 200.0, None, 0.5);
        }
        // After 20 steps the spike should have substantially decayed.
        assert!(
            rt.field[0] < TEMP_BASELINE + 30.0,
            "expected relaxation; got field[0] = {}",
            rt.field[0]
        );
    }

    #[test]
    fn active_vent_warms_local_region() {
        let mut rt = RegionTempField::new();
        let mut rng = Mulberry32::new(1);
        let mut vent = VentState::new(50.0, 50.0, 600.0, &mut rng);
        vent.active = true;
        vent.intensity = 1.0;
        // Seed.
        step_region_temps(&mut rt, 200.0, 200.0, Some(&vent), 0.1);
        // Step for a few sim seconds.
        for _ in 0..50 {
            step_region_temps(&mut rt, 200.0, 200.0, Some(&vent), 0.1);
        }
        // The region containing the vent (0,0) should be hotter than
        // a far-away region.
        let vent_region = rt.field[0];
        let far_region = rt.field[rt.field.len() - 1];
        assert!(
            vent_region > far_region + 5.0,
            "expected vent region hotter than far region: {vent_region} vs {far_region}"
        );
    }
}
