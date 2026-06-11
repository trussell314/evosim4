//! Phase 3 of the regions port: regional precipitation pass.
//!
//! Each tick, walk every (region, chem) pair. If the dissolved mass
//! exceeds the per-region capacity (`region_dissolved_capacity`), shed
//! the excess back into rendered 2px particles inside the region's
//! footprint. Mass-conserving: every unit removed from `dissolved`
//! becomes the equivalent mass of a `density * (4/3)π r^3` particle.
//!
//! The TS pass adds a 90..100% deadband (`REGION_DISSOLVE_LO`) between
//! dissolution and precipitation so a freshly-precipitated particle
//! can't instantly re-dissolve. We don't have a dedicated dissolve
//! path yet (particle_decay shrinks particles regardless of capacity),
//! so the hysteresis sits where it does in TS: as a one-way precipitate
//! pass.
//!
//! What's NOT here yet:
//!   - global particle cap (TS bounds spawn count by `effectiveParticleCap`)
//!     -- we have no cap yet, so excess always becomes particles
//!   - regional temperature scaling (depends on `regionTemp` field --
//!     vent port). For now every region uses `TEMP_BASELINE` for the
//!     capacity formula
//!   - rock-aware spawn (TS skips regions whose center sits in solid
//!     terrain). Depends on the terrain port.

use crate::ambient::{AmbientField, AMBIENT_STRIDE};
use crate::chemistry::table as chem_table;
use crate::particles::{ParticleInit, ParticleStore};
use crate::regions::{region_dissolved_capacity, PRECIP_R, REGION_PX, TEMP_BASELINE};
use crate::rng::Mulberry32;

/// World geometry the precipitation pass needs. Lifted out so the
/// caller can hand it without surrendering `&mut self.world` to the
/// pass (which would conflict with the rng borrow).
#[derive(Debug, Clone, Copy)]
pub struct PrecipGeom {
    pub width: f32,
    pub height: f32,
    pub depth: f32,
    pub surface_y: f32,
}

/// Walk every (region, chem) pair; precipitate supersaturated excess.
/// Returns the number of particles spawned this pass.
pub fn run_precipitation(
    ambient: &mut AmbientField,
    particles: &mut ParticleStore,
    geom: PrecipGeom,
    rng: &mut Mulberry32,
) -> usize {
    let cols = ambient.cols;
    let rows = ambient.rows;
    if cols == 0 || rows == 0 {
        return 0;
    }
    let table = chem_table();
    let four_thirds_pi = (4.0 / 3.0) * std::f32::consts::PI;
    let vol_per = four_thirds_pi * PRECIP_R.powi(3);

    let mut spawned = 0;
    for ry in 0..rows {
        for rx in 0..cols {
            let ri = ry * cols + rx;
            let base = ri * AMBIENT_STRIDE;
            for k in 0..AMBIENT_STRIDE {
                let v = ambient.dissolved[base + k];
                if v <= 0.0 {
                    continue;
                }
                let cap = region_dissolved_capacity(k, geom.height, geom.depth, TEMP_BASELINE);
                let excess = v - cap;
                if excess <= 0.0 {
                    continue;
                }
                let density = if table.base_density[k] > 0.0 {
                    table.base_density[k]
                } else {
                    1.0
                };
                let molar_mass = table.molar_mass[k].max(1e-6);
                let amount_per = (density * vol_per) / molar_mass;
                if amount_per <= 0.0 {
                    continue;
                }
                let count_f = (excess / amount_per).floor();
                if count_f <= 0.0 {
                    continue;
                }
                let count = count_f as usize;
                let x0 = rx as f32 * REGION_PX;
                let y0 = ry as f32 * REGION_PX;
                for _ in 0..count {
                    let px = (x0 + rng.next_f64() as f32 * REGION_PX).min(geom.width - 1.0);
                    let mut py = y0 + rng.next_f64() as f32 * REGION_PX;
                    if py < geom.surface_y + PRECIP_R {
                        py = geom.surface_y + PRECIP_R;
                    }
                    py = py.min(geom.height - PRECIP_R);
                    particles.push(ParticleInit {
                        x: px,
                        y: py,
                        r: PRECIP_R,
                        chem_id: k as u8,
                        density,
                        ..ParticleInit::default()
                    });
                    spawned += 1;
                }
                ambient.dissolved[base + k] = v - count_f * amount_per;
            }
        }
    }
    spawned
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::CHEM_MEMBRANE;

    fn geom(width: f32, height: f32, surface_y: f32) -> PrecipGeom {
        PrecipGeom {
            width,
            height,
            depth: REGION_PX,
            surface_y,
        }
    }

    #[test]
    fn no_excess_no_spawn() {
        let mut amb = AmbientField::new_for_world(200.0, 200.0);
        let mut ps = ParticleStore::new();
        let mut rng = Mulberry32::new(1);
        let spawned = run_precipitation(&mut amb, &mut ps, geom(200.0, 200.0, 0.0), &mut rng);
        assert_eq!(spawned, 0);
    }

    #[test]
    fn supersaturated_membrane_precipitates() {
        let mut amb = AmbientField::new_for_world(200.0, 200.0);
        amb.deposit_at(CHEM_MEMBRANE, 1000.0, 50.0, 50.0);
        let mass_before = amb.totals_per_chem()[CHEM_MEMBRANE];
        assert!(mass_before > 0.0);
        let mut ps = ParticleStore::new();
        let mut rng = Mulberry32::new(1);
        let spawned = run_precipitation(&mut amb, &mut ps, geom(200.0, 200.0, 0.0), &mut rng);
        assert!(spawned > 0, "expected MEMBRANE to precipitate");
        let mut mem_particles = 0;
        for i in 0..ps.len() {
            if ps.chem_id[i] as usize == CHEM_MEMBRANE {
                mem_particles += 1;
            }
        }
        assert_eq!(mem_particles, spawned);
    }

    #[test]
    fn precipitation_is_mass_conserving() {
        let mut amb = AmbientField::new_for_world(200.0, 200.0);
        amb.deposit_at(CHEM_MEMBRANE, 1000.0, 50.0, 50.0);
        let dissolved_before = amb.totals_per_chem()[CHEM_MEMBRANE];

        let mut ps = ParticleStore::new();
        let mut rng = Mulberry32::new(1);
        run_precipitation(&mut amb, &mut ps, geom(200.0, 200.0, 0.0), &mut rng);

        let dissolved_after = amb.totals_per_chem()[CHEM_MEMBRANE];
        let table = chem_table();
        let density = table.base_density[CHEM_MEMBRANE];
        let molar_mass = table.molar_mass[CHEM_MEMBRANE];
        let four_thirds_pi = (4.0 / 3.0) * std::f32::consts::PI;
        let vol_per = four_thirds_pi * PRECIP_R.powi(3);
        let amount_per = (density * vol_per) / molar_mass;

        let mut particle_count = 0.0_f32;
        for i in 0..ps.len() {
            if ps.chem_id[i] as usize == CHEM_MEMBRANE {
                particle_count += amount_per;
            }
        }
        let total_after = dissolved_after + particle_count;
        assert!(
            (total_after - dissolved_before).abs() < 1e-2,
            "mass should be conserved: {dissolved_before} -> {total_after}"
        );
    }

    #[test]
    fn precipitation_keeps_particles_under_surface() {
        let mut amb = AmbientField::new_for_world(200.0, 200.0);
        amb.deposit_at(CHEM_MEMBRANE, 1000.0, 10.0, 10.0);
        let mut ps = ParticleStore::new();
        let mut rng = Mulberry32::new(1);
        let surface = 80.0;
        run_precipitation(&mut amb, &mut ps, geom(200.0, 200.0, surface), &mut rng);
        for i in 0..ps.len() {
            assert!(
                ps.y[i] >= surface + PRECIP_R - 1e-3,
                "particle should spawn below surface: y={}",
                ps.y[i]
            );
        }
    }
}
