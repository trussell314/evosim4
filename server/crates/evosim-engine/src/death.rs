//! Minimal death / autolysis pass. Cells below any viability gate
//! are removed from the store; their remaining named-chem mass is
//! released back to the world as particles (one particle per chem
//! whose pool exceeds an emit threshold) so the engine's mass
//! conservation invariant holds across the cycle of fission and
//! death.
//!
//! What's NOT here yet (kept honest):
//!   - ATP idle-drain pass: TS subtracts a tiny baseline ATP cost
//!     every tick; that's the slow-clock that eventually kills an
//!     unfed cell. We don't yet, so cells only die when something
//!     more dramatic happens (mass goes to zero, membrane below
//!     viability after a future biosynth-decay pass)
//!   - somatic-mutation pass that gates on age + repair chem
//!   - bonded cell stranding cleanup
//!   - the particle decay pass that recycles aging emitted particles

use crate::ambient::AmbientField;
use crate::chem_ids::{
    CHEMICAL_COUNT, CHEM_BIOPOLYMER, CHEM_FA, CHEM_MEMBRANE, NAMED_CHEMICAL_COUNT,
};
use crate::creatures::CreatureStore;
use crate::edna::EdnaField;
use crate::particles::{ParticleInit, ParticleStore};
use crate::rng::Mulberry32;

/// Membrane below this and the cell autolyses. Matches the TS
/// `MIN_VIABLE_MEMBRANE` constant.
pub const MIN_VIABLE_MEMBRANE: f32 = 0.5;
/// Total mass below this and the cell is treated as evaporated --
/// no autolysis particles emitted, just removed.
const MIN_TOTAL_MASS: f32 = 0.1;
/// Per-chem emit threshold. Pools below this stay with the cell on
/// the rare borderline death so we don't spam particles for tiny
/// fractional pools.
const PARTICLE_EMIT_THRESHOLD: f32 = 0.05;
/// Particle radius for autolysed chem releases. Same scale as the
/// demo particle seeder.
const AUTOLYSED_PARTICLE_R: f32 = 2.0;

/// Walk the creature store, killing every cell that fails viability
/// and emitting its remaining named-chem mass as particles. Returns
/// the number of cells removed. We iterate in REVERSE so the swap-pop
/// removal at index `i` doesn't shift unvisited cells around.
/// Fraction of every dying cell's chem mass that dissolves into the
/// ambient field rather than going out as a particle. ~ 0.4 puts a
/// real chunk of mass into the field on a cull wave -- a useful
/// signal for downstream cells -- without erasing the particle path.
const AMBIENT_DISSOLVE_FRACTION: f32 = 0.4;

pub fn run_death(
    creatures: &mut CreatureStore,
    particles: &mut ParticleStore,
    ambient: &mut AmbientField,
    edna: &mut EdnaField,
    rng: &mut Mulberry32,
) -> usize {
    let mut deaths = 0;
    let mut i = creatures.n;
    while i > 0 {
        i -= 1;
        let membrane = creatures.chems[CHEM_MEMBRANE][i];
        let total_mass: f32 = creatures.chems.iter().map(|c| c[i]).sum();

        let kill = membrane < MIN_VIABLE_MEMBRANE || total_mass < MIN_TOTAL_MASS;
        if !kill {
            continue;
        }

        // Emit a particle per chem with enough mass to bother. Use
        // the dying cell's position; small random jitter so a cell
        // with many chems doesn't collapse a stack of particles into
        // one slot.
        let cx = creatures.x[i];
        let cy = creatures.y[i];
        if total_mass >= MIN_TOTAL_MASS {
            for k in 0..NAMED_CHEMICAL_COUNT {
                let amount = creatures.chems[k][i];
                if amount < PARTICLE_EMIT_THRESHOLD {
                    continue;
                }
                // Split the chem between the ambient field and a
                // particle, so the food web has both a long-range
                // signal and a local nutrient pile.
                let dissolved = amount * AMBIENT_DISSOLVE_FRACTION;
                ambient.deposit(k, dissolved);
                let jitter_x = (rng.next_f64() as f32 - 0.5) * 8.0;
                let jitter_y = (rng.next_f64() as f32 - 0.5) * 8.0;
                particles.push(ParticleInit {
                    x: cx + jitter_x,
                    y: cy + jitter_y,
                    r: AUTOLYSED_PARTICLE_R,
                    chem_id: k as u8,
                    ..ParticleInit::default()
                });
            }
        }
        // eDNA: release the dying cell's genome into the field so
        // COMPETENCE-expressing cells can pick it up later. Skip
        // tiny-mass evaporations (they're treated as having no
        // structural genome left).
        if total_mass >= MIN_TOTAL_MASS && !creatures.genome[i].is_empty() {
            crate::edna::release_at_death(edna, cx, cy, &creatures.genome[i]);
        }
        creatures.remove_swap_pop(i);
        deaths += 1;
    }
    let _ = CHEMICAL_COUNT;
    let _ = CHEM_BIOPOLYMER;
    let _ = CHEM_FA;
    deaths
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::{CHEM_ATP, CHEM_GLU};
    use crate::creatures::CreatureInit;

    fn make_cell_chems(membrane: f32, atp: f32, glu: f32) -> Vec<f32> {
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[CHEM_MEMBRANE] = membrane;
        chems[CHEM_ATP] = atp;
        chems[CHEM_GLU] = glu;
        chems
    }

    #[test]
    fn viable_cell_survives() {
        let mut cs = CreatureStore::new();
        let mut ps = ParticleStore::new();
        let mut rng = Mulberry32::new(1);
        cs.push(CreatureInit {
            r: 8.0,
            chems: Some(make_cell_chems(2.0, 10.0, 5.0)),
            ..CreatureInit::default()
        });
        let killed = run_death(&mut cs, &mut ps, &mut AmbientField::new(), &mut EdnaField::new(), &mut rng);
        assert_eq!(killed, 0);
        assert_eq!(cs.len(), 1);
        assert_eq!(ps.len(), 0);
    }

    #[test]
    fn membrane_below_threshold_dies() {
        let mut cs = CreatureStore::new();
        let mut ps = ParticleStore::new();
        let mut rng = Mulberry32::new(1);
        cs.push(CreatureInit {
            r: 8.0,
            chems: Some(make_cell_chems(0.3, 10.0, 5.0)),
            ..CreatureInit::default()
        });
        let killed = run_death(&mut cs, &mut ps, &mut AmbientField::new(), &mut EdnaField::new(), &mut rng);
        assert_eq!(killed, 1);
        assert_eq!(cs.len(), 0);
        // Particles emitted for the three populated chems
        // (membrane, ATP, GLU), all > PARTICLE_EMIT_THRESHOLD.
        assert_eq!(ps.len(), 3);
    }

    #[test]
    fn tiny_mass_cell_evaporates_no_particles() {
        let mut cs = CreatureStore::new();
        let mut ps = ParticleStore::new();
        let mut rng = Mulberry32::new(1);
        cs.push(CreatureInit {
            r: 8.0,
            chems: Some(make_cell_chems(0.0, 0.01, 0.01)),
            ..CreatureInit::default()
        });
        let killed = run_death(&mut cs, &mut ps, &mut AmbientField::new(), &mut EdnaField::new(), &mut rng);
        assert_eq!(killed, 1);
        assert_eq!(cs.len(), 0);
        // Total mass < MIN_TOTAL_MASS so no particles emitted.
        assert_eq!(ps.len(), 0);
    }

    #[test]
    fn iterates_in_reverse_so_removals_dont_skip() {
        // Make 3 cells, all unviable. After the pass all should be
        // gone; iteration order matters for swap_remove correctness.
        let mut cs = CreatureStore::new();
        let mut ps = ParticleStore::new();
        let mut rng = Mulberry32::new(1);
        for x in [10.0, 20.0, 30.0] {
            cs.push(CreatureInit {
                x,
                r: 8.0,
                chems: Some(make_cell_chems(0.0, 5.0, 5.0)),
                ..CreatureInit::default()
            });
        }
        let killed = run_death(&mut cs, &mut ps, &mut AmbientField::new(), &mut EdnaField::new(), &mut rng);
        assert_eq!(killed, 3);
        assert_eq!(cs.len(), 0);
        // 3 dead cells * 2 emitted chems each (ATP, GLU; membrane
        // was 0) = 6 particles. Actually each cell had 2 chems
        // above the emit threshold (ATP=5, GLU=5).
        assert_eq!(ps.len(), 6);
    }
}
