//! Minimal INGEST pass. Cells whose `vm_out.ingest_threshold` is
//! finite this tick try to absorb at most one nearby particle whose
//! bond-potential exceeds the threshold. Mass-conserving: the
//! particle's chem mass becomes a deposit into the cell's pool of
//! that chem, and the particle is removed from the store.
//!
//! What's NOT here yet (kept honest):
//!   - sensor-bin acceleration: TS walks a spatial grid; we do an
//!     O(N_cells * N_particles) scan. Fine while particle counts are
//!     low; the bins are already built per-tick so this can be wired
//!     in a later commit
//!   - INGEST_ENERGY_COST: TS charges ATP per bite; we don't yet
//!   - membrane-budget gate (`wouldTearOnGrowth`): TS refuses
//!     ingestion if the resulting cell mass would push membrane
//!     past its tear ceiling. We just ingest
//!   - particle molecule payload: TS particles can carry an entire
//!     creature's pool on death; ours don't have payloads yet
//!   - ingest cooldown: TS cells throttle themselves with a per-cell
//!     cooldown; without that here a cell can eat several particles
//!     in a tick. We mitigate by stopping at the first ingest per
//!     cell per tick

use crate::chem_ids::CHEMICAL_COUNT;
use crate::chemistry::table as chem_table;
use crate::creatures::CreatureStore;
use crate::particles::ParticleStore;

/// Mass per particle = particle volume * density. Same model as the
/// force / collision kernels.
fn particle_mass(particles: &ParticleStore, i: usize, chem_density: &[f32]) -> f32 {
    let r = particles.r[i];
    let chem_id = particles.chem_id[i] as usize;
    let density = if particles.density[i] != 0.0 {
        particles.density[i]
    } else {
        chem_density[chem_id]
    };
    let v = (4.0 / 3.0) * std::f32::consts::PI * r * r * r;
    density * v
}

/// Run one INGEST attempt per cell that requested it. Returns the
/// number of particles consumed.
pub fn run_ingest(creatures: &mut CreatureStore, particles: &mut ParticleStore) -> usize {
    let chem = chem_table();
    let chem_density = &chem.base_density;
    let bond_potential = &chem.bond_potential;
    let mut consumed = 0;
    let n_cells = creatures.n;
    for ci in 0..n_cells {
        let threshold = creatures.vm_out[ci].ingest_threshold;
        if !threshold.is_finite() {
            continue;
        }
        let cx = creatures.x[ci];
        let cy = creatures.y[ci];
        let cr = creatures.r[ci];
        let cr2 = cr * cr;
        // Scan; first eligible particle wins. The walk in REVERSE so
        // swap_pop doesn't shift later particles into already-scanned
        // slots.
        let mut found: Option<usize> = None;
        let mut pi = particles.len();
        while pi > 0 {
            pi -= 1;
            let chem_id = particles.chem_id[pi] as usize;
            if chem_id >= CHEMICAL_COUNT {
                continue;
            }
            if (bond_potential[chem_id] as f64) < threshold {
                continue;
            }
            let dx = particles.x[pi] - cx;
            let dy = particles.y[pi] - cy;
            if dx * dx + dy * dy >= cr2 {
                continue;
            }
            found = Some(pi);
            break;
        }
        if let Some(pi) = found {
            let chem_id = particles.chem_id[pi] as usize;
            let mass = particle_mass(particles, pi, chem_density);
            // Deposit mass into the cell's chem pool (named slots
            // only; generic chems go via a different path that
            // hasn't landed yet).
            if chem_id < creatures.chems.len() {
                creatures.chems[chem_id][ci] += mass;
            }
            particles.remove_swap_pop(pi);
            consumed += 1;
        }
    }
    consumed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::{CHEM_GLU, NAMED_CHEMICAL_COUNT};
    use crate::creatures::CreatureInit;
    use crate::particles::ParticleInit;
    use crate::vm::VmOutputs;

    fn cell_with_threshold(x: f32, y: f32, threshold: f64) -> CreatureStore {
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[crate::chem_ids::CHEM_ATP] = 10.0;
        let mut s = CreatureStore::new();
        s.push(CreatureInit {
            x,
            y,
            r: 8.0,
            chems: Some(chems),
            ..CreatureInit::default()
        });
        s.vm_out[0] = VmOutputs::new();
        s.vm_out[0].ingest_threshold = threshold;
        s
    }

    fn particle(x: f32, y: f32, chem_id: u8) -> ParticleStore {
        let mut p = ParticleStore::new();
        p.push(ParticleInit { x, y, r: 1.5, chem_id, ..ParticleInit::default() });
        p
    }

    #[test]
    fn ingests_particle_in_reach() {
        // Cell at (50, 50, r=8). Particle at (52, 52) -- inside r.
        // CHEM_GLU has bond_potential = 0.36 (from chemistry::tests).
        // Threshold 0.1 lets it through.
        let mut cs = cell_with_threshold(50.0, 50.0, 0.1);
        let mut ps = particle(52.0, 52.0, CHEM_GLU as u8);
        let n = run_ingest(&mut cs, &mut ps);
        assert_eq!(n, 1);
        assert_eq!(ps.len(), 0);
        assert!(cs.chems[CHEM_GLU][0] > 0.0, "cell should gain GLU");
    }

    #[test]
    fn refuses_below_threshold() {
        // High threshold rejects glucose (bond potential 0.36).
        let mut cs = cell_with_threshold(50.0, 50.0, 10.0);
        let mut ps = particle(52.0, 52.0, CHEM_GLU as u8);
        let n = run_ingest(&mut cs, &mut ps);
        assert_eq!(n, 0);
        assert_eq!(ps.len(), 1);
    }

    #[test]
    fn refuses_out_of_range() {
        let mut cs = cell_with_threshold(50.0, 50.0, 0.1);
        // Particle 100 px away.
        let mut ps = particle(150.0, 50.0, CHEM_GLU as u8);
        let n = run_ingest(&mut cs, &mut ps);
        assert_eq!(n, 0);
        assert_eq!(ps.len(), 1);
    }

    #[test]
    fn ingest_threshold_infinity_does_nothing() {
        let mut cs = cell_with_threshold(50.0, 50.0, f64::INFINITY);
        let mut ps = particle(52.0, 52.0, CHEM_GLU as u8);
        let n = run_ingest(&mut cs, &mut ps);
        assert_eq!(n, 0);
        assert_eq!(ps.len(), 1);
    }

    #[test]
    fn one_ingest_per_cell_per_tick() {
        let mut cs = cell_with_threshold(50.0, 50.0, 0.1);
        let mut ps = ParticleStore::new();
        for _ in 0..5 {
            ps.push(ParticleInit { x: 50.0, y: 50.0, r: 1.5, chem_id: CHEM_GLU as u8, ..ParticleInit::default() });
        }
        let n = run_ingest(&mut cs, &mut ps);
        assert_eq!(n, 1);
        assert_eq!(ps.len(), 4);
    }
}
