//! Total-mass accounting for the whole world. Sums chem mass across
//! every reservoir cells can move it between:
//!
//!   - per-cell named-chem pools
//!   - per-cell catalyst + inhibitor pools (which consumed AA+MIN
//!     when synthesised, so they count as mass)
//!   - ambient field stocks
//!   - particle bodies (mass = density * 4/3 pi r^3)
//!   - eDNA carriers (genome bytes don't carry chemical mass, so
//!     they're zero here; tracked separately by count)
//!
//! Without a mass-conserving guarantee an engine that leaks mass
//! (e.g. a pass forgets to clear a chem after subtracting it) drifts
//! invisibly. The snapshot ships a single MassReport struct so the
//! client / a script can compare across ticks and catch drift fast.

use crate::ambient::AmbientField;
use crate::chem_ids::{is_signal, NAMED_CHEMICAL_COUNT};
use crate::chemistry::table as chem_table;
use crate::creatures::CreatureStore;
use crate::genome_consts::CATALYST_COUNT;
use crate::particles::ParticleStore;
pub use evosim_protocol::MassReport;

pub fn report(
    creatures: &CreatureStore,
    particles: &ParticleStore,
    ambient: &AmbientField,
) -> MassReport {
    let mut r = MassReport::default();
    let n = creatures.n;

    // Cell chem pools (count -> mass via per-chem molar mass).
    let molar = &chem_table().molar_mass;
    if !creatures.chems.is_empty() {
        #[allow(clippy::needless_range_loop)]
        for k in 0..NAMED_CHEMICAL_COUNT {
            if is_signal(k) {
                continue;
            }
            let mm = molar[k] as f64;
            let col = &creatures.chems[k];
            r.cell_chems +=
                col.iter().take(n).map(|&v| v as f64 * mm).sum::<f64>();
        }
    }
    // Catalysts + inhibitors are protein-like and don't have a
    // table molar mass; treat them as molar_mass=1 (they were
    // synthesised from 0.5 AA + 0.5 MIN at substrate mass 1, so
    // mass-conserving math works at = 1).
    if !creatures.catalyst.is_empty() {
        for k in 0..CATALYST_COUNT {
            let cc = &creatures.catalyst[k];
            let ic = &creatures.inhibitor[k];
            r.cell_catalysts += cc.iter().take(n).map(|&v| v as f64).sum::<f64>()
                + ic.iter().take(n).map(|&v| v as f64).sum::<f64>();
        }
    }

    // Ambient (count -> mass). Sums across all regions per chem.
    let totals = ambient.totals_per_chem();
    for (k, &count) in totals.iter().enumerate() {
        if is_signal(k) {
            continue;
        }
        let mm = if k < molar.len() { molar[k] as f64 } else { 1.0 };
        r.ambient += count as f64 * mm;
    }

    // Particles.
    let chem_density = &chem_table().base_density;
    for i in 0..particles.len() {
        let rad = particles.r[i];
        let chem_id = particles.chem_id[i] as usize;
        let density = if particles.density[i] != 0.0 {
            particles.density[i]
        } else if chem_id < chem_density.len() {
            chem_density[chem_id]
        } else {
            1.0
        };
        let v = (4.0 / 3.0) * std::f32::consts::PI * rad * rad * rad;
        r.particles += (density * v) as f64;
    }

    r.total = r.cell_chems + r.cell_catalysts + r.particles + r.ambient;
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::{CHEM_ATP, CHEM_GLU};
    use crate::creatures::CreatureInit;
    use crate::particles::ParticleInit;

    #[test]
    fn empty_world_zero_mass() {
        let cs = CreatureStore::new();
        let ps = ParticleStore::new();
        let amb = AmbientField::new();
        let r = report(&cs, &ps, &amb);
        assert_eq!(r.total, 0.0);
    }

    #[test]
    fn cell_chem_counted_in_total() {
        let mut cs = CreatureStore::new();
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[CHEM_ATP] = 10.0;
        chems[CHEM_GLU] = 5.0;
        cs.push(CreatureInit { r: 8.0, chems: Some(chems), ..CreatureInit::default() });
        let r = report(&cs, &ParticleStore::new(), &AmbientField::new());
        assert!((r.cell_chems - 15.0).abs() < 1e-3);
        assert!((r.total - 15.0).abs() < 1e-3);
    }

    #[test]
    fn ambient_counted_in_total() {
        let cs = CreatureStore::new();
        let mut amb = AmbientField::new();
        amb.deposit_at(CHEM_GLU, 7.0, 0.0, 0.0);
        let r = report(&cs, &ParticleStore::new(), &amb);
        assert!((r.ambient - 7.0).abs() < 1e-3);
    }

    #[test]
    fn particle_mass_uses_density_volume() {
        let mut ps = ParticleStore::new();
        ps.push(ParticleInit { r: 1.0, chem_id: CHEM_GLU as u8, ..ParticleInit::default() });
        let r = report(&CreatureStore::new(), &ps, &AmbientField::new());
        // GLU density = 1.5; V = 4/3 pi (~ 4.19); mass ~ 6.28.
        let expected = 1.5 * 4.0 / 3.0 * std::f32::consts::PI;
        assert!((r.particles - expected as f64).abs() < 1e-3);
    }

    #[test]
    fn signal_chems_excluded() {
        let mut cs = CreatureStore::new();
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[crate::chem_ids::CHEM_ACT_PHOTO_VISIBLE] = 1000.0;
        cs.push(CreatureInit { r: 8.0, chems: Some(chems), ..CreatureInit::default() });
        let r = report(&cs, &ParticleStore::new(), &AmbientField::new());
        // Signal chem must not appear in the total.
        assert_eq!(r.cell_chems, 0.0);
    }
}
