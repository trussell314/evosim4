//! Gas-particle escape at the surface. O2 / CO2 particles that hit
//! the water surface should pop and rejoin the atmosphere; without
//! this pass they accumulate in a perfectly straight line along
//! `surface_y` forever -- which is what the user's screenshot of the
//! demo showed.
//!
//! Port-level simplification: we don't have an atmosphere reservoir
//! yet, so the escaping mass is just lost. That's mass-non-conserving
//! at the global level, but the dissolved field still gets aerated
//! through `aerate::run_aerate`, so the chemistry loop closes
//! eventually anyway. Once an atmosphere field lands, this pass
//! should debit `atmosphere[chem]` on escape and `aerate` credits it.

use crate::chem_ids::{CHEM_CO2, CHEM_O2};
use crate::particles::ParticleStore;

/// Per-second probability that a gas particle within
/// `SURFACE_BAND_PX` of `surface_y` escapes. 1.5/s means a typical
/// bubble has ~67% chance of escaping each sim second.
const ESCAPE_RATE_PER_S: f32 = 1.5;
/// How close to the surface a gas particle has to be to be
/// considered "at the surface" for escape. The forces kernel clamps
/// at exactly `surface_y`; a small band absorbs surface chop.
const SURFACE_BAND_PX: f32 = 1.5;

/// Remove gas particles that are at-or-near the water surface, with
/// per-tick probability `ESCAPE_RATE_PER_S * dt`. Pop order: reverse
/// scan with `remove_swap_pop` so the indices stay valid.
pub fn run_gas_escape(
    particles: &mut ParticleStore,
    surface_y: f32,
    rng: &mut crate::rng::Mulberry32,
    dt: f32,
) -> usize {
    if particles.is_empty() || dt <= 0.0 {
        return 0;
    }
    let p_escape = (ESCAPE_RATE_PER_S * dt).clamp(0.0, 1.0);
    if p_escape <= 0.0 {
        return 0;
    }
    let mut removed = 0;
    let mut i = particles.len();
    while i > 0 {
        i -= 1;
        let chem = particles.chem_id[i] as usize;
        if chem != CHEM_O2 && chem != CHEM_CO2 {
            continue;
        }
        // The forces kernel pinned the particle's y at surface_y when
        // it tried to rise above; check the actual position against
        // the surface band.
        if (particles.y[i] - surface_y).abs() > SURFACE_BAND_PX {
            continue;
        }
        if (rng.next_f64() as f32) < p_escape {
            let _ = particles.remove_swap_pop(i);
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::particles::ParticleInit;
    use crate::rng::Mulberry32;

    fn gas(x: f32, y: f32, chem: usize) -> ParticleInit {
        ParticleInit {
            x,
            y,
            r: 1.0,
            chem_id: chem as u8,
            density: 0.14,
            ..ParticleInit::default()
        }
    }

    #[test]
    fn surface_bubbles_escape_over_time() {
        let mut ps = ParticleStore::new();
        for i in 0..40 {
            ps.push(gas(10.0 * i as f32, 100.0, CHEM_O2));
        }
        let mut rng = Mulberry32::new(1);
        // 10 seconds of escape rolls -- the vast majority should pop.
        for _ in 0..600 {
            run_gas_escape(&mut ps, 100.0, &mut rng, 1.0 / 60.0);
        }
        assert!(
            ps.len() < 5,
            "surface bubbles should have escaped after 10s, {} remain",
            ps.len(),
        );
    }

    #[test]
    fn submerged_bubbles_do_not_escape() {
        let mut ps = ParticleStore::new();
        ps.push(gas(50.0, 200.0, CHEM_O2)); // well below surface_y=100
        let mut rng = Mulberry32::new(1);
        for _ in 0..600 {
            run_gas_escape(&mut ps, 100.0, &mut rng, 1.0 / 60.0);
        }
        assert_eq!(ps.len(), 1, "submerged bubble must persist");
    }

    #[test]
    fn non_gas_particles_unaffected() {
        let mut ps = ParticleStore::new();
        ps.push(ParticleInit {
            x: 50.0,
            y: 100.0,
            r: 1.0,
            chem_id: 4, // glucose
            density: 1.5,
            ..ParticleInit::default()
        });
        let mut rng = Mulberry32::new(1);
        for _ in 0..600 {
            run_gas_escape(&mut ps, 100.0, &mut rng, 1.0 / 60.0);
        }
        assert_eq!(ps.len(), 1);
    }
}
