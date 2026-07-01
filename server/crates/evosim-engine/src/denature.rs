//! Slow conversion of CHEM_WASTE -> CHEM_CO2 across the world.
//! Without this pass waste accumulates monotonically; the user
//! reported this as "the mass ledger never shifts" in the demo.
//!
//! Waste denatures into CO2 (mass-conserving: WASTE molar_mass ==
//! CO2 molar_mass for this engine's table). Two sinks are touched:
//!   - the per-region dissolved field (`AmbientField.dissolved`)
//!   - particle bodies whose chem_id is CHEM_WASTE; they shrink and
//!     dump their mass into the local dissolved CO2 column
//!
//! TS also touches `world.reserve` (sub-grid reserve column) and
//! molecule-tagged corpse particles; neither is ported in the Rust
//! engine yet, so they're omitted -- the existing surface is enough
//! to break the runaway-waste accumulator.
//!
//! Mineral weathering is on the same pattern and lives in
//! `weather_minerals`. They run back to back from the engine step.

use std::f32::consts::PI;

use crate::ambient::{AmbientField, AMBIENT_STRIDE};
use crate::chem_ids::{CHEM_CO2, CHEM_WASTE, CHEM_MIN, CHEMICAL_COUNT};
use crate::chemistry::table as chem_table;
use crate::particles::ParticleStore;
use crate::regions::region_index_at;

/// Half-life of waste in seconds. Matches the TS constant. Fast
/// enough that a busy demo doesn't bury the chemistry in toxic
/// runoff; slow enough that waste still matters as a short-term
/// inhibitor.
const WASTE_HALFLIFE_S: f32 = 300.0;
/// Minerals are nearly insoluble but they still need a return path
/// so the seafloor doesn't accumulate forever.
const MINERAL_WEATHER_HALFLIFE_S: f32 = 90.0;
/// Particle radius below which we just remove it.
const MIN_RESIDUAL_R: f32 = 0.6;
const FOUR_THIRDS_PI: f32 = 4.0 / 3.0 * PI;

/// Run the waste -> CO2 denature pass. Mutates `ambient.dissolved`
/// in the WASTE / CO2 columns and shrinks waste particles. Returns
/// the count of particles fully consumed this tick.
pub fn run_denature_waste(
    particles: &mut ParticleStore,
    ambient: &mut AmbientField,
    dt: f32,
) -> usize {
    let frac = denature_fraction(dt, WASTE_HALFLIFE_S);
    if frac <= 0.0 {
        return 0;
    }
    convert_in_field(ambient, CHEM_WASTE, CHEM_CO2, frac);
    convert_particles(
        particles,
        ambient,
        CHEM_WASTE,
        Some(CHEM_CO2),
        frac,
    )
}

/// Weather mineral particles back into the local dissolved field.
/// Same shape as `run_denature_waste`; different chem.
pub fn run_weather_minerals(
    particles: &mut ParticleStore,
    ambient: &mut AmbientField,
    dt: f32,
) -> usize {
    let frac = denature_fraction(dt, MINERAL_WEATHER_HALFLIFE_S);
    if frac <= 0.0 {
        return 0;
    }
    convert_particles(particles, ambient, CHEM_MIN, None, frac)
}

#[inline]
fn denature_fraction(dt: f32, halflife_s: f32) -> f32 {
    if dt <= 0.0 || halflife_s <= 0.0 {
        return 0.0;
    }
    1.0 - (0.5_f32).powf(dt / halflife_s)
}

fn convert_in_field(
    ambient: &mut AmbientField,
    src: usize,
    dst: usize,
    frac: f32,
) {
    if ambient.dissolved.is_empty() || src >= CHEMICAL_COUNT || dst >= CHEMICAL_COUNT {
        return;
    }
    let n = ambient.dissolved.len() / AMBIENT_STRIDE;
    for ri in 0..n {
        let base = ri * AMBIENT_STRIDE;
        let cur = ambient.dissolved[base + src];
        if cur <= 0.0 {
            continue;
        }
        let d = cur * frac;
        ambient.dissolved[base + src] = cur - d;
        ambient.dissolved[base + dst] += d;
    }
    ambient.chem_active[dst] = 1;
}

fn convert_particles(
    particles: &mut ParticleStore,
    ambient: &mut AmbientField,
    src_chem: usize,
    deposit_as: Option<usize>,
    frac: f32,
) -> usize {
    let chem = chem_table();
    let mut removed = 0;
    let mut i = particles.len();
    while i > 0 {
        i -= 1;
        if particles.chem_id[i] as usize != src_chem {
            continue;
        }
        let r = particles.r[i];
        if r <= 0.0 {
            continue;
        }
        let density = if particles.density[i] != 0.0 {
            particles.density[i]
        } else if src_chem < chem.base_density.len() {
            chem.base_density[src_chem]
        } else {
            1.0
        };
        if density <= 0.0 {
            continue;
        }
        let mass = density * FOUR_THIRDS_PI * r * r * r;
        let dm = mass * frac;
        // Deposit into the local region. Convert mass -> amount via
        // molar mass; for both CO2 and MIN our table puts molar_mass
        // at 1.0 so this collapses to identity, but we do the math
        // properly in case the table is ever rebalanced.
        let deposit_chem = deposit_as.unwrap_or(src_chem);
        let molar_mass = if deposit_chem < chem.molar_mass.len() {
            chem.molar_mass[deposit_chem].max(1e-6)
        } else {
            1.0
        };
        let amount = dm / molar_mass;
        let ri = region_index_at(ambient.width, ambient.height, particles.x[i], particles.y[i]);
        let base = ri * AMBIENT_STRIDE;
        if base + deposit_chem < ambient.dissolved.len() {
            ambient.dissolved[base + deposit_chem] += amount;
            ambient.chem_active[deposit_chem] = 1;
        }
        let new_mass = mass - dm;
        let new_r3 = 3.0 * new_mass / (4.0 * PI * density);
        let new_r = new_r3.max(0.0).cbrt();
        if new_r < MIN_RESIDUAL_R {
            let _ = particles.remove_swap_pop(i);
            removed += 1;
        } else {
            particles.r[i] = new_r;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::{CHEM_CO2, CHEM_MIN, CHEM_WASTE};
    use crate::particles::ParticleInit;

    fn ambient_with(chem: usize, amount: f32) -> AmbientField {
        let mut amb = AmbientField::new_for_world(200.0, 200.0);
        for ri in 0..(amb.dissolved.len() / AMBIENT_STRIDE) {
            amb.dissolved[ri * AMBIENT_STRIDE + chem] = amount;
        }
        amb
    }

    #[test]
    fn waste_field_converts_to_co2() {
        let mut amb = ambient_with(CHEM_WASTE, 1000.0);
        let mut ps = ParticleStore::new();
        // 5 minutes -> ~half should denature.
        run_denature_waste(&mut ps, &mut amb, 300.0);
        let ri = 0;
        let w = amb.dissolved[ri * AMBIENT_STRIDE + CHEM_WASTE];
        let c = amb.dissolved[ri * AMBIENT_STRIDE + CHEM_CO2];
        assert!((w - 500.0).abs() < 5.0, "expected ~500, got {w}");
        assert!((c - 500.0).abs() < 5.0, "expected ~500, got {c}");
        // Mass conservation: total chem amount unchanged.
        assert!((w + c - 1000.0).abs() < 10.0, "w+c={}", w + c);
    }

    #[test]
    fn waste_particle_shrinks_and_feeds_field() {
        let mut amb = AmbientField::new_for_world(200.0, 200.0);
        let mut ps = ParticleStore::new();
        ps.push(ParticleInit {
            x: 100.0,
            y: 100.0,
            r: 4.0,
            chem_id: CHEM_WASTE as u8,
            density: 1.0,
            ..ParticleInit::default()
        });
        let r0 = ps.r[0];
        run_denature_waste(&mut ps, &mut amb, 60.0);
        // Particle either smaller or removed; either way ambient CO2
        // got something.
        let ri = region_index_at(200.0, 200.0, 100.0, 100.0);
        let c = amb.dissolved[ri * AMBIENT_STRIDE + CHEM_CO2];
        assert!(c > 0.0, "no CO2 deposit");
        if !ps.is_empty() {
            assert!(ps.r[0] < r0, "particle did not shrink");
        }
    }

    #[test]
    fn mineral_particle_weathered_into_field() {
        let mut amb = AmbientField::new_for_world(200.0, 200.0);
        let mut ps = ParticleStore::new();
        ps.push(ParticleInit {
            x: 100.0,
            y: 100.0,
            r: 4.0,
            chem_id: CHEM_MIN as u8,
            density: 1.5,
            ..ParticleInit::default()
        });
        let r0 = ps.r[0];
        run_weather_minerals(&mut ps, &mut amb, 60.0);
        let ri = region_index_at(200.0, 200.0, 100.0, 100.0);
        let m = amb.dissolved[ri * AMBIENT_STRIDE + CHEM_MIN];
        assert!(m > 0.0);
        if !ps.is_empty() {
            assert!(ps.r[0] < r0);
        }
    }
}
