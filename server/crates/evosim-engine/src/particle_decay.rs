//! Particle aging + decay. Every particle has an `age` field; this
//! pass advances it and removes particles that exceed `MAX_AGE`. A
//! tiny radius shrink each tick models slow dissolution; once below
//! `MIN_RADIUS` the particle is removed even if it's not yet at
//! max age.
//!
//! Without this pass dead-cell autolysis grows the particle field
//! monotonically and the world's particle count climbs without bound
//! over long sessions. The TS decay pass is richer (per-chem
//! dissolution rates, region-aware), but the minimal version closes
//! the leak.

use crate::ambient::AmbientField;
use crate::chem_ids::CHEMICAL_COUNT;
use crate::chemistry::table as chem_table;
use crate::particles::ParticleStore;

/// Particles older than this many sim-seconds are removed
/// unconditionally. 120 s is long enough that nearby cells have a
/// real chance to ingest the chem before it dissolves.
pub const MAX_AGE_S: f32 = 120.0;
/// Radius below which a particle is removed regardless of age. Avoids
/// shipping invisibly-small motes the renderer can't draw anyway.
const MIN_RADIUS: f32 = 0.3;
/// Per-second radius shrink rate. At 0.02/s a starter-radius particle
/// (2.5) lasts ~ 110 sim-seconds before hitting MIN_RADIUS, putting it
/// just under MAX_AGE_S so both paths fire on roughly the same scale.
const RADIUS_SHRINK_PER_S: f32 = 0.02;

/// Returns the number of particles removed. Mass from the radius
/// shrink (per tick) AND from the cull (on removal) deposits into
/// the ambient field so total world mass is conserved.
pub fn run_particle_decay(store: &mut ParticleStore, ambient: &mut AmbientField, dt: f32) -> usize {
    let chem_density = &chem_table().base_density;
    let pre = std::f32::consts::PI * (4.0 / 3.0);
    let particle_mass = |r: f32, density: f32| -> f32 { density * pre * r * r * r };

    let mut removed = 0;
    let mut i = store.len();
    while i > 0 {
        i -= 1;
        let chem_id = store.chem_id[i] as usize;
        let density = if store.density[i] != 0.0 {
            store.density[i]
        } else if chem_id < chem_density.len() {
            chem_density[chem_id]
        } else {
            1.0
        };
        let r_old = store.r[i];
        store.age[i] += dt;
        store.r[i] = (r_old - RADIUS_SHRINK_PER_S * dt).max(0.0);
        let px = store.x[i];
        let py = store.y[i];
        // Mass lost to shrinkage -> local region's dissolved field.
        if chem_id < CHEMICAL_COUNT {
            let dissolved = particle_mass(r_old, density) - particle_mass(store.r[i], density);
            if dissolved > 0.0 {
                ambient.deposit_at(chem_id, dissolved, px, py);
            }
        }
        if store.age[i] >= MAX_AGE_S || store.r[i] <= MIN_RADIUS {
            // Cull: deposit remaining mass at the particle's last position.
            if chem_id < CHEMICAL_COUNT {
                let remaining = particle_mass(store.r[i], density);
                if remaining > 0.0 {
                    ambient.deposit_at(chem_id, remaining, px, py);
                }
            }
            store.remove_swap_pop(i);
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::particles::ParticleInit;

    fn store_with(n: usize, r: f32) -> ParticleStore {
        let mut s = ParticleStore::new();
        for _ in 0..n {
            s.push(ParticleInit { r, chem_id: 0, ..ParticleInit::default() });
        }
        s
    }

    #[test]
    fn advances_age() {
        let mut s = store_with(1, 2.5);
        run_particle_decay(&mut s, &mut AmbientField::new(), 1.0);
        assert!(s.age[0] > 0.9);
    }

    #[test]
    fn shrinks_radius() {
        let mut s = store_with(1, 2.5);
        run_particle_decay(&mut s, &mut AmbientField::new(), 1.0);
        assert!(s.r[0] < 2.5);
    }

    #[test]
    fn removes_at_max_age() {
        let mut s = store_with(1, 2.5);
        // Big dt so we hit MAX_AGE_S in one step.
        let removed = run_particle_decay(&mut s, &mut AmbientField::new(), MAX_AGE_S + 1.0);
        assert_eq!(removed, 1);
        assert_eq!(s.len(), 0);
    }

    #[test]
    fn removes_tiny_particles() {
        let mut s = store_with(1, MIN_RADIUS + 0.001);
        // A few seconds of shrink to fall below MIN_RADIUS.
        let removed = run_particle_decay(&mut s, &mut AmbientField::new(), 1.0);
        assert_eq!(removed, 1);
        assert_eq!(s.len(), 0);
    }

    #[test]
    fn reverse_iteration_handles_multiple_kills() {
        let mut s = store_with(5, 0.32);
        let removed = run_particle_decay(&mut s, &mut AmbientField::new(), 1.0);
        assert_eq!(removed, 5);
        assert_eq!(s.len(), 0);
    }
}
