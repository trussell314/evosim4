//! Atmosphere -> water gas exchange. Without this pass the demo's
//! only O2 source is photosynthesis, so a sleeping world (day_cycle
//! at night, no light) starves the ecosystem to extinction within
//! one diurnal cycle.
//!
//! Simplified port of TS's `aerateAmbient`: a small O2 flux into the
//! surface-row regions of the dissolved field, modulated by surface
//! activity (we approximate "wind" with the live wind speed) and
//! gated by the per-region O2 capacity so a stagnant region doesn't
//! overshoot its solubility ceiling.
//!
//! TS also has a bubble-spawn aerate (particle stream); that's left
//! out because it depends on the atmosphere field + particle-cap
//! interaction we haven't ported. Dissolved aeration alone is the
//! larger O2 source in TS too.

use crate::ambient::{AmbientField, AMBIENT_STRIDE};
use crate::chem_ids::CHEM_O2;
use crate::regions::{
    region_cols, region_dissolved_capacity, region_rows, REGION_PX, TEMP_BASELINE,
};
use crate::region_temp::RegionTempField;

/// Per-tick dissolved-O2 deposit rate, in amount-units / sec / region,
/// at calm-surface baseline. Surface activity scales this up.
const AERATE_BASE_PER_REGION: f32 = 8.0;
/// Slope on wind speed (px/s). At |wind| = 40 (drift max) we hit
/// roughly 2x the calm rate; gusts (not ported yet) would push it
/// higher still.
const AERATE_PER_WIND_PX: f32 = 0.025;

/// Deposit dissolved O2 into the top row of the regional dissolved
/// field. `wind_speed` is the engine's live wind scalar; the magnitude
/// is what matters (gusts from either direction roughen the surface).
pub fn run_aerate(
    ambient: &mut AmbientField,
    region_temp: &RegionTempField,
    height: f32,
    wind_speed: f32,
    dt: f32,
) -> f32 {
    if ambient.dissolved.is_empty() || dt <= 0.0 {
        return 0.0;
    }
    let cols = region_cols(ambient.width).max(1);
    let rows = region_rows(ambient.height).max(1);
    if rows == 0 {
        return 0.0;
    }
    let act = (1.0 + AERATE_PER_WIND_PX * wind_speed.abs()).clamp(0.5, 4.0);
    let per_region = AERATE_BASE_PER_REGION * act * dt;
    if per_region <= 0.0 {
        return 0.0;
    }
    let mut deposited = 0.0;
    // Top row only -- atmospheric contact happens at the air-water
    // interface, not on every region.
    let row = 0usize;
    for col in 0..cols {
        let ri = row * cols + col;
        let temp = if ri < region_temp.field.len() {
            region_temp.field[ri]
        } else {
            TEMP_BASELINE
        };
        let cap = region_dissolved_capacity(CHEM_O2, height, REGION_PX, temp);
        if cap <= 0.0 {
            continue;
        }
        let base = ri * AMBIENT_STRIDE;
        let cur = ambient.dissolved[base + CHEM_O2];
        if cur >= cap {
            continue;
        }
        let gap = cap - cur;
        let amt = per_region.min(gap);
        ambient.dissolved[base + CHEM_O2] = cur + amt;
        deposited += amt;
    }
    if deposited > 0.0 {
        ambient.chem_active[CHEM_O2] = 1;
    }
    deposited
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `new_for_world` seeds a baseline O2 level into every region;
    /// we deliberately zero the field for these tests so we can read
    /// the delta clean.
    fn empty_ambient(w: f32, h: f32) -> AmbientField {
        let mut amb = AmbientField::new_for_world(w, h);
        for v in amb.dissolved.iter_mut() {
            *v = 0.0;
        }
        amb
    }

    #[test]
    fn aerates_top_row_only() {
        let mut amb = empty_ambient(200.0, 200.0);
        let region_temp = RegionTempField::default();
        let deposited = run_aerate(&mut amb, &region_temp, 200.0, 0.0, 1.0);
        assert!(deposited > 0.0);
        let cols = region_cols(200.0);
        let rows = region_rows(200.0);
        // Top row got O2.
        for col in 0..cols {
            assert!(amb.dissolved[col * AMBIENT_STRIDE + CHEM_O2] > 0.0);
        }
        // Bottom row did not.
        let bottom_row = rows - 1;
        for col in 0..cols {
            let ri = bottom_row * cols + col;
            assert_eq!(amb.dissolved[ri * AMBIENT_STRIDE + CHEM_O2], 0.0);
        }
    }

    #[test]
    fn wind_boosts_deposition() {
        let mut calm = empty_ambient(200.0, 200.0);
        let mut windy = empty_ambient(200.0, 200.0);
        let region_temp = RegionTempField::default();
        let q_calm = run_aerate(&mut calm, &region_temp, 200.0, 0.0, 1.0);
        let q_windy = run_aerate(&mut windy, &region_temp, 200.0, 80.0, 1.0);
        assert!(q_windy > q_calm, "windy={q_windy} calm={q_calm}");
    }

    #[test]
    fn does_not_exceed_capacity() {
        let mut amb = empty_ambient(200.0, 200.0);
        let region_temp = RegionTempField::default();
        let cap = region_dissolved_capacity(CHEM_O2, 200.0, REGION_PX, TEMP_BASELINE);
        let cols = region_cols(200.0);
        for col in 0..cols {
            amb.dissolved[col * AMBIENT_STRIDE + CHEM_O2] = cap;
        }
        let deposited = run_aerate(&mut amb, &region_temp, 200.0, 0.0, 1.0);
        assert_eq!(deposited, 0.0, "saturated region should not aerate");
    }
}
