//! Dissolve liquid / gas particles into the regional ambient field.
//! Port of TS `dissolveParticles`. Closes the chemistry loop: cells
//! excrete particles, particles dissolve into the field, the field
//! re-feeds cells via ingest / sense. Without this pass the engine
//! is one-way -- excreted particles persist forever as decorative
//! sediment instead of returning to the ecosystem.
//!
//! Skips:
//!   - particles above the water surface (no aqueous capacity in air)
//!   - mineral particles (handled by sediment collision; they don't
//!     dissolve in the demo's reaction set)
//!   - particles whose region is at >= 90% capacity (hysteresis so a
//!     freshly precipitated particle doesn't instantly re-dissolve)
//!
//! Rate proportional to surface area (`4 pi r^2`) and capacity gap.
//! When the residual mass would drop below `MIN_DISSOLVE_R`, the
//! particle is removed entirely and its remaining mass dumped into
//! the field in one shot.

use std::f32::consts::PI;

use crate::ambient::{AmbientField, AMBIENT_STRIDE};
use crate::chem_ids::{is_signal, CHEM_MIN};
use crate::chemistry::table as chem_table;
use crate::particles::ParticleStore;
use crate::regions::{
    region_dissolved_capacity, region_index_at, REGION_PX, TEMP_BASELINE,
};
use crate::region_temp::RegionTempField;

/// kg / s per (capacity_gap_units * radius^2). Matches the TS constant
/// `DISSOLVE_RATE_PER_AREA`. Empirically tuned to be visible but slow
/// enough that a busy region stays in the dissolve / precipitate
/// deadband for tens of seconds.
const DISSOLVE_RATE_PER_AREA: f32 = 0.05;
/// Particle radius below which we just remove + dump the residual.
/// Below this the surface-area math underflows and the particle
/// would hang around as a sub-pixel speck forever.
const MIN_DISSOLVE_R: f32 = 0.6;
/// Capacity fraction below which dissolve is allowed to fire. >= this
/// and the particle waits for the field to drain. Mirrors TS's
/// `REGION_DISSOLVE_LO` constant.
const REGION_DISSOLVE_LO: f32 = 0.9;
const FOUR_THIRDS_PI: f32 = 4.0 / 3.0 * PI;

/// Run the dissolve pass. Returns the count of particles fully
/// dissolved this tick -- handy for tests and the perf table.
pub fn run_dissolve_particles(
    particles: &mut ParticleStore,
    ambient: &mut AmbientField,
    region_temp: &RegionTempField,
    surface_y: f32,
    height: f32,
    dt: f32,
) -> usize {
    if particles.is_empty() || ambient.dissolved.is_empty() {
        return 0;
    }
    let chem = chem_table();
    let mut removed = 0usize;
    // Iterate in reverse so remove_swap_pop doesn't invalidate the
    // indices we haven't visited yet.
    let mut i = particles.len();
    let region_depth = REGION_PX;
    while i > 0 {
        i -= 1;
        // Skip particles above water (nothing aqueous to dissolve into).
        if particles.y[i] < surface_y {
            continue;
        }
        let chem_id = particles.chem_id[i] as usize;
        // Sediment + signal chems don't dissolve.
        if chem_id == CHEM_MIN || is_signal(chem_id) {
            continue;
        }
        let r = particles.r[i];
        if r <= 0.0 {
            continue;
        }
        let ri = region_index_at(ambient.width, ambient.height, particles.x[i], particles.y[i]);
        let temp = if ri < region_temp.field.len() {
            region_temp.field[ri]
        } else {
            TEMP_BASELINE
        };
        let cap = region_dissolved_capacity(chem_id, height, region_depth, temp);
        if cap <= 0.0 {
            continue;
        }
        let base = ri * AMBIENT_STRIDE;
        let cur = ambient.dissolved[base + chem_id];
        if cur >= REGION_DISSOLVE_LO * cap {
            continue;
        }
        let gap = cap - cur;
        if gap <= 0.0 {
            continue;
        }
        let density = if particles.density[i] != 0.0 {
            particles.density[i]
        } else if chem_id < chem.base_density.len() {
            chem.base_density[chem_id]
        } else {
            1.0
        };
        if density <= 0.0 {
            continue;
        }
        let mm = if chem_id < chem.molar_mass.len() {
            chem.molar_mass[chem_id].max(1e-6)
        } else {
            1.0
        };
        let phys_mass = density * FOUR_THIRDS_PI * r * r * r;
        let amount_total = phys_mass / mm;
        let dissolve_amount = DISSOLVE_RATE_PER_AREA * gap * r * r * dt;
        if dissolve_amount >= amount_total {
            ambient.dissolved[base + chem_id] = (cur + amount_total).min(cap);
            ambient.chem_active[chem_id] = 1;
            let _ = particles.remove_swap_pop(i);
            removed += 1;
            continue;
        }
        let residual_amount = amount_total - dissolve_amount;
        let new_mass = residual_amount * mm;
        let new_r3 = 3.0 * new_mass / (4.0 * PI * density);
        let new_r = new_r3.max(0.0).cbrt();
        if new_r < MIN_DISSOLVE_R {
            ambient.dissolved[base + chem_id] = (cur + amount_total).min(cap);
            ambient.chem_active[chem_id] = 1;
            let _ = particles.remove_swap_pop(i);
            removed += 1;
        } else {
            particles.r[i] = new_r;
            ambient.dissolved[base + chem_id] = (cur + dissolve_amount).min(cap);
            ambient.chem_active[chem_id] = 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::{CHEM_GLU, CHEM_O2};
    use crate::particles::ParticleInit;
    use crate::region_temp::RegionTempField;

    fn empty_ambient(w: f32, h: f32) -> AmbientField {
        AmbientField::new_for_world(w, h)
    }

    #[test]
    fn liquid_particle_dissolves_into_field() {
        let mut ps = ParticleStore::new();
        ps.push(ParticleInit {
            x: 50.0,
            y: 100.0,
            r: 3.0,
            chem_id: CHEM_GLU as u8,
            density: 1.5,
            ..ParticleInit::default()
        });
        let mut amb = empty_ambient(200.0, 200.0);
        let region_temp = RegionTempField::default();
        let pre = ps.len();
        run_dissolve_particles(&mut ps, &mut amb, &region_temp, 0.0, 200.0, 1.0 / 60.0);
        // Either shrunk or removed -- check the ambient field got
        // something either way.
        let ri = region_index_at(200.0, 200.0, 50.0, 100.0);
        let amount = amb.dissolved[ri * AMBIENT_STRIDE + CHEM_GLU];
        assert!(amount > 0.0, "ambient field should have non-zero glu, got {amount}");
        if ps.len() == pre {
            assert!(ps.r[0] < 3.0, "particle should have shrunk");
        }
    }

    #[test]
    fn mineral_particle_not_dissolved() {
        let mut ps = ParticleStore::new();
        ps.push(ParticleInit {
            x: 50.0,
            y: 100.0,
            r: 3.0,
            chem_id: CHEM_MIN as u8,
            density: 1.5,
            ..ParticleInit::default()
        });
        let mut amb = empty_ambient(200.0, 200.0);
        let region_temp = RegionTempField::default();
        let r0 = ps.r[0];
        run_dissolve_particles(&mut ps, &mut amb, &region_temp, 0.0, 200.0, 1.0 / 60.0);
        assert_eq!(ps.len(), 1);
        assert_eq!(ps.r[0], r0, "mineral must not shrink");
    }

    #[test]
    fn particle_above_surface_skipped() {
        let mut ps = ParticleStore::new();
        // surface_y = 100; particle at y=50 is in air.
        ps.push(ParticleInit {
            x: 50.0,
            y: 50.0,
            r: 3.0,
            chem_id: CHEM_O2 as u8,
            density: 0.14,
            ..ParticleInit::default()
        });
        let mut amb = empty_ambient(200.0, 200.0);
        let region_temp = RegionTempField::default();
        let r0 = ps.r[0];
        run_dissolve_particles(&mut ps, &mut amb, &region_temp, 100.0, 200.0, 1.0 / 60.0);
        assert_eq!(ps.r[0], r0, "in-air particle must not dissolve");
    }

    #[test]
    fn saturated_region_does_not_drain_more() {
        let mut ps = ParticleStore::new();
        ps.push(ParticleInit {
            x: 50.0,
            y: 100.0,
            r: 3.0,
            chem_id: CHEM_GLU as u8,
            density: 1.5,
            ..ParticleInit::default()
        });
        let mut amb = empty_ambient(200.0, 200.0);
        let region_temp = RegionTempField::default();
        // Fill the region to its theoretical max -- dissolve should
        // be a no-op until it drains below 90%.
        let ri = region_index_at(200.0, 200.0, 50.0, 100.0);
        let cap = region_dissolved_capacity(CHEM_GLU, 200.0, REGION_PX, TEMP_BASELINE);
        amb.dissolved[ri * AMBIENT_STRIDE + CHEM_GLU] = cap;
        let r0 = ps.r[0];
        run_dissolve_particles(&mut ps, &mut amb, &region_temp, 0.0, 200.0, 1.0 / 60.0);
        assert_eq!(ps.r[0], r0, "saturated region should not drain particle");
    }
}
