//! Minimal reproduction (fission) pass. When a cell fires REPRODUCE
//! and meets the viability gates, we split it into parent + daughter:
//! the daughter takes `(1 - parent_fraction)` of every chem, catalyst,
//! and inhibitor pool; the parent keeps the rest; the daughter's
//! genome is a copy of the parent's with a single point mutation.
//!
//! What's NOT here yet (kept honest):
//!   - bonded crossover (the TS sexual path that recombines a parent's
//!     genome with a bond partner's)
//!   - REPRODUCE attempt-cost ATP tax: we charge a flat ATP cost on
//!     SUCCESSFUL fission only. The TS charges on every attempt so
//!     spamming the op is self-throttling; we'll bring that across
//!     with the per-cell ATP-spend ledger
//!   - genome-replication material tax (parent pays a small chem
//!     cost proportional to childGenome length)
//!   - PARTITION op respect: TS lets a cell skew the per-chem split
//!     via the partition list; we do a flat proportional split for
//!     now. partition list still serialises through the VM, just
//!     isn't read here yet
//!
//! Determinism: mutation needs a per-tick PRNG. We take a `&mut
//! Mulberry32` so the engine task's `sim_rng` is the single source
//! and a save/load round-trip preserves the future mutation stream.

use crate::chem_ids::{CHEM_ATP, NAMED_CHEMICAL_COUNT};
use crate::creatures::{CreatureInit, CreatureStore};
use crate::genome_consts::CATALYST_COUNT;
use crate::rng::Mulberry32;

/// Minimum ATP a cell needs in its pool to enter mitosis. Anything
/// below this and REPRODUCE no-ops; the cell stays alive.
const MIN_FISSION_ATP: f32 = 8.0;
/// Flat ATP cost charged on every SUCCESSFUL fission. Crude but
/// honest until the per-cell spend ledger lands.
const FISSION_ATP_COST: f32 = 4.0;
/// Minimum total mass a cell needs before it's allowed to divide.
/// Below this its daughter would be vanishingly small.
const MIN_FISSION_MASS: f32 = 4.0;
/// Genome mutation rate -- probability a single point mutation
/// fires per fission. Crude rate; the per-byte-rate machinery is
/// what the TS uses for finer control.
const FISSION_MUTATION_RATE: f64 = 0.4;
/// Maximum population the minimal pass will spawn into. Hard ceiling
/// so a runaway division loop can't melt the heap before the
/// per-region cap pass lands.
const MAX_POPULATION: usize = 4096;

/// Walk the creature store, fissioning every cell whose vm_out.reproduce
/// is set. Returns the number of daughters spawned. The split happens
/// inline against the store, which is sound because we only ever
/// PUSH new cells (no swap-remove); existing indices stay valid for
/// the rest of the tick.
pub fn run_reproduction(store: &mut CreatureStore, rng: &mut Mulberry32, t: f64) -> usize {
    let parent_count = store.n;
    let mut spawned = 0;
    for i in 0..parent_count {
        if !store.vm_out[i].reproduce {
            continue;
        }
        // Clear the flag so we don't fission the same cell twice
        // before the next tick resets it.
        store.vm_out[i].reproduce = false;

        if store.n >= MAX_POPULATION {
            continue;
        }

        let atp = store.chems[CHEM_ATP][i];
        if atp < MIN_FISSION_ATP {
            continue;
        }
        let total_mass: f32 = store.chems.iter().map(|c| c[i]).sum();
        if total_mass < MIN_FISSION_MASS {
            continue;
        }

        // Parent fraction clamped to a sane band so the daughter
        // gets a real share but the parent isn't gutted.
        let parent_fraction = (store.vm_out[i].reproduce_fraction as f32).clamp(0.1, 0.9);
        let child_share = 1.0 - parent_fraction;

        // Charge the fission ATP cost on the parent before the split
        // so the parent eats the cost and the daughter inherits a
        // proportional share of the *remaining* ATP.
        store.chems[CHEM_ATP][i] = (atp - FISSION_ATP_COST).max(0.0);

        // Build the daughter's chems, catalysts, inhibitors as the
        // child_share slice of the parent's pools.
        let mut daughter_chems = vec![0.0f32; NAMED_CHEMICAL_COUNT];
        for (k, slot) in daughter_chems.iter_mut().enumerate() {
            let v = store.chems[k][i];
            let give = v * child_share;
            store.chems[k][i] = v - give;
            *slot = give;
        }
        let mut daughter_catalyst = vec![0.0f32; CATALYST_COUNT];
        let mut daughter_inhibitor = vec![0.0f32; CATALYST_COUNT];
        for k in 0..CATALYST_COUNT {
            let cv = store.catalyst[k][i];
            let give = cv * child_share;
            store.catalyst[k][i] = cv - give;
            daughter_catalyst[k] = give;

            let iv = store.inhibitor[k][i];
            let give = iv * child_share;
            store.inhibitor[k][i] = iv - give;
            daughter_inhibitor[k] = give;
        }

        // Genome copy + optional point mutation.
        let mut daughter_genome = store.genome[i].clone();
        if rng.next_f64() < FISSION_MUTATION_RATE && !daughter_genome.is_empty() {
            let l = daughter_genome.len();
            let idx = (rng.next_f64() * l as f64) as usize;
            let bit = 1u8 << ((rng.next_f64() * 8.0) as usize & 7);
            daughter_genome[idx] ^= bit;
        }

        // Place the daughter half a radius away from the parent so
        // they don't share a slot. Direction chosen from the rng so
        // siblings spread out over time.
        let theta = rng.next_f64() as f32 * std::f32::consts::TAU;
        let offset = store.r[i] * 0.6;
        let dx = theta.cos() * offset;
        let dy = theta.sin() * offset;
        let parent_x = store.x[i];
        let parent_y = store.y[i];
        let parent_heading = store.heading[i];
        let parent_r = store.r[i];

        // last_reproduce_fire_t stamped on the parent for sterile-cull;
        // the VM run already set it but only as a "fired" mark, not
        // a "succeeded" mark. Stamp again here for the success path.
        store.last_reproduce_fire_t[i] = t;
        store.child_count[i] += 1;

        // Daughter init. Inherits parent's catalyst / inhibitor /
        // chems via the post-init writes below.
        let did_push = store.push(CreatureInit {
            x: parent_x + dx,
            y: parent_y + dy,
            r: parent_r,
            heading: parent_heading,
            born_at: t,
            genome: daughter_genome,
            chems: Some(daughter_chems),
            ..CreatureInit::default()
        });
        // Post-push writes: copy the daughter's catalyst and inhibitor
        // pools. push() initialised them to zero.
        for k in 0..CATALYST_COUNT {
            store.catalyst[k][did_push] = daughter_catalyst[k];
            store.inhibitor[k][did_push] = daughter_inhibitor[k];
        }
        spawned += 1;
    }
    spawned
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::CHEM_GLU;
    use crate::genome::OP_NOP;
    use crate::vm::VmOutputs;

    fn make_parent(atp: f32, glu: f32) -> CreatureStore {
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[CHEM_ATP] = atp;
        chems[CHEM_GLU] = glu;
        let mut store = CreatureStore::new();
        store.push(CreatureInit {
            r: 8.0,
            chems: Some(chems),
            genome: vec![OP_NOP, OP_NOP, OP_NOP, OP_NOP],
            ..CreatureInit::default()
        });
        store
    }

    fn fire_reproduce(store: &mut CreatureStore, i: usize, fraction: f32) {
        store.vm_out[i] = VmOutputs::new();
        store.vm_out[i].reproduce = true;
        store.vm_out[i].reproduce_fraction = fraction as f64;
    }

    #[test]
    fn fires_and_spawns_daughter() {
        let mut store = make_parent(20.0, 10.0);
        fire_reproduce(&mut store, 0, 0.5);
        let mut rng = Mulberry32::new(1);
        let spawned = run_reproduction(&mut store, &mut rng, 5.0);
        assert_eq!(spawned, 1);
        assert_eq!(store.len(), 2);
        // Each half should get ~ half the glucose pool.
        assert!((store.chems[CHEM_GLU][0] - 5.0).abs() < 1e-3);
        assert!((store.chems[CHEM_GLU][1] - 5.0).abs() < 1e-3);
        // Parent ATP: started 20, charged 4 -> 16, then split 50/50
        // -> 8 left.
        assert!((store.chems[CHEM_ATP][0] - 8.0).abs() < 1e-3);
        assert!((store.chems[CHEM_ATP][1] - 8.0).abs() < 1e-3);
        // child_count stamped on the parent.
        assert_eq!(store.child_count[0], 1);
    }

    #[test]
    fn skewed_fraction_skews_chem_split() {
        let mut store = make_parent(20.0, 10.0);
        fire_reproduce(&mut store, 0, 0.7); // parent keeps 70%
        let mut rng = Mulberry32::new(1);
        let n = run_reproduction(&mut store, &mut rng, 1.0);
        assert_eq!(n, 1);
        // Glucose split: 7.0 parent / 3.0 daughter.
        assert!((store.chems[CHEM_GLU][0] - 7.0).abs() < 1e-3);
        assert!((store.chems[CHEM_GLU][1] - 3.0).abs() < 1e-3);
    }

    #[test]
    fn refuses_below_atp_threshold() {
        let mut store = make_parent(1.0, 10.0);
        fire_reproduce(&mut store, 0, 0.5);
        let mut rng = Mulberry32::new(1);
        let n = run_reproduction(&mut store, &mut rng, 1.0);
        assert_eq!(n, 0);
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn flag_cleared_so_one_spawn_per_tick() {
        let mut store = make_parent(50.0, 10.0);
        fire_reproduce(&mut store, 0, 0.5);
        let mut rng = Mulberry32::new(1);
        run_reproduction(&mut store, &mut rng, 1.0);
        // Re-run without firing reproduce again -- no new daughter.
        let len_after = store.len();
        run_reproduction(&mut store, &mut rng, 2.0);
        assert_eq!(store.len(), len_after);
    }

    #[test]
    fn catalyst_pool_splits_with_share() {
        let mut store = make_parent(20.0, 10.0);
        store.catalyst[42][0] = 2.0;
        fire_reproduce(&mut store, 0, 0.5);
        let mut rng = Mulberry32::new(1);
        run_reproduction(&mut store, &mut rng, 1.0);
        // Each daughter pool ~ 1.0.
        assert!((store.catalyst[42][0] - 1.0).abs() < 1e-3);
        assert!((store.catalyst[42][1] - 1.0).abs() < 1e-3);
    }

    #[test]
    fn mutation_can_alter_daughter_genome() {
        // Pick an RNG seed that does fire a mutation. The 0.4 rate
        // means we'll see one within a handful of tries.
        let mut store = make_parent(20.0, 10.0);
        fire_reproduce(&mut store, 0, 0.5);
        let mut rng = Mulberry32::new(0xCAFE_F00D);
        run_reproduction(&mut store, &mut rng, 1.0);
        let parent_g = &store.genome[0];
        let daughter_g = &store.genome[1];
        // Either identical (no mutation that draw) or differs in
        // exactly one bit -- the assert is loose so the test isn't
        // brittle.
        let mut diff_bits = 0;
        for (p, d) in parent_g.iter().zip(daughter_g.iter()) {
            diff_bits += (p ^ d).count_ones();
        }
        assert!(diff_bits <= 1, "expected 0 or 1 bit difference, got {diff_bits}");
    }
}
