//! Founder seeding. Spawns a cohort of viable cells with chem pools
//! tuned to outlast the baseline metabolic drain. The TS engine's
//! `seedRamp` pass fills a particle target over the first few sim
//! seconds and seeds founders in batches; for now we just spawn a
//! fixed count at boot.
//!
//! A "viable founder" here means:
//!   - membrane >> MIN_VIABLE_MEMBRANE so a few sub-viable ticks
//!     don't end its line
//!   - enough ATP to bootstrap the cell's biosynth before its
//!     reactions catch up
//!   - chl + mrna + CO2 + ADP for a photoautotroph; OR enz +
//!     biopolymer for a heterotroph; the engine doesn't care
//!     which the genome chooses, the founder pool just has to
//!     allow the chosen mode
//!
//! Genomes are short canonical "starter" sequences -- one per trophic
//! strategy -- with deterministic mutations so each founder line
//! starts from a slightly different bytecode. Mutation = same
//! point-mutation rule the reproduction pass uses, drawn from
//! `Mulberry32`.

use crate::chem_ids::{
    CHEM_ADP, CHEM_ATP, CHEM_BIOPOLYMER, CHEM_CHL, CHEM_CO2, CHEM_ENZ, CHEM_GLU, CHEM_MEMBRANE,
    CHEM_MRNA, CHEM_O2, NAMED_CHEMICAL_COUNT,
};
use crate::creatures::{CreatureInit, CreatureStore};
use crate::genome::*;
use crate::rng::Mulberry32;

/// Membrane carried by every founder. ~10x MIN_VIABLE_MEMBRANE.
const FOUNDER_MEMBRANE: f32 = 20.0;
/// ATP carried by every founder. Enough for ~ 30 sim-seconds of
/// pure drain even if no reactions fire.
const FOUNDER_ATP: f32 = 50.0;
/// Per-byte mutation probability the founder cohort uses to seed
/// genetic diversity. Higher than the per-fission rate so the
/// founder generation diverges meaningfully.
const FOUNDER_MUTATION_RATE: f64 = 0.05;

/// Canonical founder genomes, one per trophic strategy. Each is short
/// and self-sufficient given the founder's chem pool.
fn founder_genomes() -> Vec<Vec<u8>> {
    vec![
        // Photoautotroph: just live. The cell's chl + ambient light
        // run photosynth + photophos via the reaction driver; no VM
        // ops needed for survival.
        vec![OP_GENE, OP_NOP, OP_END],
        // Aerobic heterotroph (metabolizer): same idle pattern;
        // aerobic respiration runs from the GLU + O2 pool.
        vec![OP_GENE, OP_NOP, OP_END],
        // Seeker: GENE SENSE_OUT 2 THRUST END -- swims up the
        // glucose gradient. Survives because its chem pool covers
        // metabolism even while it spends ATP on thrust.
        vec![OP_GENE, OP_SENSE_OUT, 2, OP_THRUST, OP_END],
        // Reproducer: GENE PUSH8 0 REPRODUCE END.
        vec![OP_GENE, OP_PUSH8, 0, OP_REPRODUCE, OP_END],
        // Osmotroph: imports glucose from the ambient pool every
        // tick. Genome: GENE PUSH8 100 TRANSPORT 2 END
        //   PUSH8 100 puts +100 on the stack
        //   TRANSPORT 2 pops it; positive = import CHEM_GLU from
        //   ambient. The dissolved-chem path lets a cell rely on
        //   what other cells leaked/dumped into the field.
        vec![OP_GENE, OP_PUSH8, 100, OP_TRANSPORT, 2, OP_END],
        // Ingester: SENSE_OUT for biopolymer particles, THRUST toward
        // them, then INGEST with a low threshold so it'll eat
        // anything organic on contact. Genome:
        //   GENE SENSE_OUT 11 THRUST PUSH8 1 INGEST END
        //   (chem 11 = biopolymer; INGEST threshold = 0.02)
        vec![OP_GENE, OP_SENSE_OUT, 11, OP_THRUST, OP_PUSH8, 1, OP_INGEST, OP_END],
        // Predator: every tick it fires PREDATE. With its larger
        // starter membrane and the size-advantage rule it eats
        // smaller neighbours when one is in body contact.
        //   GENE PREDATE END
        vec![OP_GENE, OP_PREDATE, OP_END],
    ]
}

/// Per-founder chems. Order matches `founder_genomes()`.
fn founder_chems() -> Vec<Vec<f32>> {
    let mut photo = vec![0.0; NAMED_CHEMICAL_COUNT];
    photo[CHEM_ATP] = FOUNDER_ATP;
    photo[CHEM_MEMBRANE] = FOUNDER_MEMBRANE;
    photo[CHEM_CO2] = 80.0;
    photo[CHEM_ADP] = 40.0;
    photo[CHEM_CHL] = 4.0;
    photo[CHEM_MRNA] = 5.0;

    let mut metab = vec![0.0; NAMED_CHEMICAL_COUNT];
    metab[CHEM_ATP] = FOUNDER_ATP;
    metab[CHEM_MEMBRANE] = FOUNDER_MEMBRANE;
    metab[CHEM_GLU] = 100.0;
    metab[CHEM_O2] = 100.0;
    metab[CHEM_ADP] = 50.0;

    let mut seeker = metab.clone();
    // Seeker thrust + drain so give it a little more headroom.
    seeker[CHEM_GLU] = 150.0;
    seeker[CHEM_O2] = 150.0;

    let mut reproducer = metab.clone();
    // Reproducer needs lots of mass to divide.
    reproducer[CHEM_GLU] = 200.0;
    reproducer[CHEM_MEMBRANE] = FOUNDER_MEMBRANE * 2.0;

    // Osmotroph: relies on ambient GLU + O2 for respiration so
    // starter pool is minimal.
    let mut osmotroph = vec![0.0; NAMED_CHEMICAL_COUNT];
    osmotroph[CHEM_ATP] = FOUNDER_ATP;
    osmotroph[CHEM_MEMBRANE] = FOUNDER_MEMBRANE;
    osmotroph[CHEM_O2] = 30.0;
    osmotroph[CHEM_ADP] = 50.0;

    // Ingester: hunts particles. Carries enough O2 to keep
    // respiration running as it digests its catches.
    let mut ingester = vec![0.0; NAMED_CHEMICAL_COUNT];
    ingester[CHEM_ATP] = FOUNDER_ATP;
    ingester[CHEM_MEMBRANE] = FOUNDER_MEMBRANE * 1.5;
    ingester[CHEM_O2] = 80.0;
    ingester[CHEM_ADP] = 50.0;

    // Predator: bigger membrane so the size-advantage rule actually
    // gives it prey. Carries some respiratory fuel for the chase.
    let mut predator = vec![0.0; NAMED_CHEMICAL_COUNT];
    predator[CHEM_ATP] = FOUNDER_ATP;
    predator[CHEM_MEMBRANE] = FOUNDER_MEMBRANE * 2.0;
    predator[CHEM_O2] = 80.0;
    predator[CHEM_ADP] = 50.0;

    // Also give every line some enzyme + biopolymer for the digest
    // path: a metabolizer can switch to that route if its glucose
    // ever runs out.
    for chems in [&mut photo, &mut metab, &mut seeker, &mut reproducer, &mut osmotroph, &mut ingester, &mut predator].iter_mut() {
        chems[CHEM_ENZ] = 5.0;
        chems[CHEM_BIOPOLYMER] = 20.0;
    }

    vec![photo, metab, seeker, reproducer, osmotroph, ingester, predator]
}

/// Place `n_per_strategy` cells of each founder genome at random
/// positions across the world. Uses the supplied RNG for both
/// placement and genome mutation. Mutation is per-byte: each byte
/// flips one random bit with probability FOUNDER_MUTATION_RATE so
/// the founder cohort isn't a clone army.
pub fn seed_founders(
    store: &mut CreatureStore,
    rng: &mut Mulberry32,
    width: f32,
    height: f32,
    n_per_strategy: usize,
) -> usize {
    let genomes = founder_genomes();
    let chems = founder_chems();
    let mut spawned = 0;
    for (i, base_genome) in genomes.iter().enumerate() {
        for _ in 0..n_per_strategy {
            let mut g = base_genome.clone();
            // Per-byte point-mutation. Skip empty genomes.
            if !g.is_empty() {
                for byte in g.iter_mut() {
                    if rng.next_f64() < FOUNDER_MUTATION_RATE {
                        let bit = 1u8 << ((rng.next_f64() * 8.0) as usize & 7);
                        *byte ^= bit;
                    }
                }
            }
            let x = rng.next_f64() as f32 * width;
            let y = rng.next_f64() as f32 * height;
            store.push(CreatureInit {
                x,
                y,
                r: 8.0,
                genome: g,
                chems: Some(chems[i].clone()),
                ..CreatureInit::default()
            });
            spawned += 1;
        }
    }
    spawned
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_expected_count() {
        let mut store = CreatureStore::new();
        let mut rng = Mulberry32::new(1);
        let n = seed_founders(&mut store, &mut rng, 1600.0, 1200.0, 5);
        assert_eq!(n, 35); // 7 strategies x 5 each
        assert_eq!(store.len(), 35);
    }

    #[test]
    fn founders_carry_viable_pools() {
        let mut store = CreatureStore::new();
        let mut rng = Mulberry32::new(1);
        seed_founders(&mut store, &mut rng, 1600.0, 1200.0, 2);
        for i in 0..store.len() {
            assert!(
                store.chems[CHEM_MEMBRANE][i] >= 20.0,
                "founder {i} should carry > MIN_VIABLE_MEMBRANE * 10"
            );
            assert!(
                store.chems[CHEM_ATP][i] >= 10.0,
                "founder {i} should carry meaningful ATP"
            );
        }
    }

    #[test]
    fn placement_is_within_world() {
        let mut store = CreatureStore::new();
        let mut rng = Mulberry32::new(1);
        let (w, h) = (1600.0_f32, 1200.0_f32);
        seed_founders(&mut store, &mut rng, w, h, 5);
        for i in 0..store.len() {
            assert!(store.x[i] >= 0.0 && store.x[i] <= w);
            assert!(store.y[i] >= 0.0 && store.y[i] <= h);
        }
    }
}
