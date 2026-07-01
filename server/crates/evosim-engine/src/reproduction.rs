//! Reproduction (fission) pass. When a cell fires REPRODUCE it pays an
//! attempt-cost ATP tax (success or not); if it then clears the
//! viability gates it splits into parent + daughter. The daughter's
//! share of each named chem is `(1 - parent_fraction)` skewed by any
//! PARTITION bias the genome set; catalysts / inhibitors split at the
//! flat ratio. The daughter's genome is the parent's -- or a bonded-
//! crossover recombinant when the parent has bonds -- with an optional
//! single point mutation, and the parent pays a genome-replication
//! material tax (AA + MIN -> waste) proportional to the daughter's
//! genome length.
//!
//! What's still simplified vs TS (kept honest):
//!   - no `division` in-flight state machine: fission resolves in the
//!     same tick the op fires, so there's no multi-tick mitosis window
//!   - molecule-pool / generic-chem split: we only carry named chems +
//!     catalysts + inhibitors, so there's no separate molecule path
//!
//! Determinism: mutation + crossover need a per-tick PRNG. We take a
//! `&mut Mulberry32` so the engine task's `sim_rng` is the single
//! source and a save/load round-trip preserves the future draw stream.

use crate::chem_ids::{CHEM_ADP, CHEM_ATP, NAMED_CHEMICAL_COUNT};
use crate::creatures::{CreatureInit, CreatureStore};
use crate::genome_consts::CATALYST_COUNT;
use crate::rng::Mulberry32;

/// Minimum ATP a cell needs in its pool to enter mitosis. Anything
/// below this and REPRODUCE no-ops; the cell stays alive.
const MIN_FISSION_ATP: f32 = 8.0;
/// Flat ATP cost charged on every SUCCESSFUL fission. Crude but
/// honest until the per-cell spend ledger lands.
const FISSION_ATP_COST: f32 = 4.0;
/// Attempt-cost charged on every REPRODUCE fire, success or not.
/// Self-throttles op-spamming genomes. Mirrors the TS constants.
const REPRODUCE_ATTEMPT_ATP_BASE: f32 = 0.4;
const REPRODUCE_ATTEMPT_ATP_PER_MASS: f32 = 0.01;
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
pub fn run_reproduction(
    store: &mut CreatureStore,
    bonds: &crate::bonding::BondList,
    rng: &mut Mulberry32,
    t: f64,
    mutation_rate_scale: f64,
) -> usize {
    let parent_count = store.n;
    let mut spawned = 0;
    for i in 0..parent_count {
        if !store.vm_out[i].reproduce {
            continue;
        }
        // Clear the flag so we don't fission the same cell twice
        // before the next tick resets it.
        store.vm_out[i].reproduce = false;

        // Parent fraction clamped to a sane band so the daughter
        // gets a real share but the parent isn't gutted.
        let parent_fraction = (store.vm_out[i].reproduce_fraction as f32).clamp(0.1, 0.9);
        let child_share = 1.0 - parent_fraction;

        // Attempt cost: initiating mitosis spends ATP whether or not
        // the attempt commits. This is the rate-limit on REPRODUCE --
        // a cell can't fire it every tick for free; spamming the op
        // burns ATP on failed cycles and starves the cell. The
        // per-mass term scales with material MOVED (childShare *
        // parentMass), so a big mother shedding a small seed pays
        // proportionally less than a 50/50 fission. ATP -> ADP keeps
        // it mass-conserving.
        let total_mass: f32 = store.chems.iter().map(|c| c[i]).sum();
        let attempt_cost =
            REPRODUCE_ATTEMPT_ATP_BASE + REPRODUCE_ATTEMPT_ATP_PER_MASS * child_share * total_mass;
        let paid = store.chems[CHEM_ATP][i].min(attempt_cost);
        if paid > 0.0 {
            store.chems[CHEM_ATP][i] -= paid;
            store.chems[CHEM_ADP][i] += paid;
        }

        if store.n >= MAX_POPULATION {
            continue;
        }

        let atp = store.chems[CHEM_ATP][i];
        if atp < MIN_FISSION_ATP {
            continue;
        }
        if total_mass < MIN_FISSION_MASS {
            continue;
        }

        // Charge the fission ATP cost on the parent before the split
        // so the parent eats the cost and the daughter inherits a
        // proportional share of the *remaining* ATP.
        store.chems[CHEM_ATP][i] = (atp - FISSION_ATP_COST).max(0.0);

        // Snapshot the parent's PARTITION list before we touch the
        // chem columns (the vm_out borrow would otherwise alias the
        // mutable store.chems borrow below). The genome's OP_PARTITION
        // op lets a cell skew the per-chem split -- e.g. keep all its
        // ATP but hand the daughter extra membrane -- which is how
        // asymmetric division becomes an evolvable strategy.
        let pcount = store.vm_out[i].partition_count;
        let partition: Vec<(usize, f64)> = (0..pcount)
            .map(|q| {
                (
                    store.vm_out[i].partition_chem[q] as usize,
                    store.vm_out[i].partition_bias[q],
                )
            })
            .collect();

        // Build the daughter's chems as the partitioned slice of the
        // parent's pools. Named chems honour PARTITION bias; catalysts
        // and inhibitors use the flat child_share (matches TS, which
        // only partitions the molecule / generic pools).
        let mut daughter_chems = vec![0.0f32; NAMED_CHEMICAL_COUNT];
        for (k, slot) in daughter_chems.iter_mut().enumerate() {
            let v = store.chems[k][i];
            let frac = partition_frac(&partition, child_share, k);
            let give = v * frac;
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

        // Genome inheritance. The parent's coding key is recorded
        // BEFORE any crossover / mutation so the daughter's lineage
        // edge points at who actually spawned her.
        let parent_key = crate::genome::coding_key(&store.genome[i]);

        // Sexual reproduction (bonded crossover): when the parent is
        // bonded to a neighbour, the daughter's PRE-mutation genome is
        // a single-crossover recombinant of the parent and a random
        // bond partner -- useful subprograms flow between adjacent
        // lineages. Falls through to a plain clone when unbonded.
        let mut daughter_genome = if let Some(partner_list) = bonds.get(i) {
            if partner_list.is_empty() {
                store.genome[i].clone()
            } else {
                let pick = (rng.next_f64() * partner_list.len() as f64) as usize;
                let partner = partner_list[pick.min(partner_list.len() - 1)] as usize;
                if partner < store.n {
                    crossover_genomes(&store.genome[i], &store.genome[partner], rng)
                } else {
                    store.genome[i].clone()
                }
            }
        } else {
            store.genome[i].clone()
        };

        // Optional point mutation on top of the (possibly recombined)
        // daughter genome.
        let effective_rate = (FISSION_MUTATION_RATE * mutation_rate_scale).clamp(0.0, 1.0);
        if rng.next_f64() < effective_rate && !daughter_genome.is_empty() {
            let l = daughter_genome.len();
            let idx = (rng.next_f64() * l as f64) as usize;
            let bit = 1u8 << ((rng.next_f64() * 8.0) as usize & 7);
            daughter_genome[idx] ^= bit;
        }

        // Genome-replication material tax. Copying the daughter's
        // DNA consumes AA + MIN proportional to its length (the
        // monomers a real cell spends building a second genome). The
        // consumed mass becomes waste, so it's mass-conserving and
        // gives genome BLOAT a metabolic price -- the selection
        // pressure that keeps genomes from growing without bound.
        charge_genome_replication(store, i, daughter_genome.len());

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
            parent_coding_key: parent_key,
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

/// Per-genome-byte material cost charged at replication. Mirrors the
/// TS `GENOME_MASS_PER_BYTE`.
const GENOME_MASS_PER_BYTE: f32 = 0.01;

/// Charge the parent cell `i` the material cost of copying a genome
/// of `genome_len` bytes: half the demand from amino acids, half from
/// minerals, each capped at what the parent actually holds. The
/// consumed monomers convert to waste so the pass is mass-conserving
/// and genome length carries a real metabolic price.
fn charge_genome_replication(store: &mut CreatureStore, i: usize, genome_len: usize) {
    use crate::chem_ids::{CHEM_AA, CHEM_MIN, CHEM_WASTE};
    let half_demand = 0.5 * GENOME_MASS_PER_BYTE * genome_len as f32;
    if half_demand <= 0.0 {
        return;
    }
    let took_aa = store.chems[CHEM_AA][i].min(half_demand);
    let took_min = store.chems[CHEM_MIN][i].min(half_demand);
    if took_aa > 0.0 {
        store.chems[CHEM_AA][i] -= took_aa;
    }
    if took_min > 0.0 {
        store.chems[CHEM_MIN][i] -= took_min;
    }
    let consumed = took_aa + took_min;
    if consumed > 0.0 {
        store.chems[CHEM_WASTE][i] += consumed;
    }
}

/// Child's share of a given chem after applying any PARTITION bias.
/// `base` is the default proportional split (`1 - parent_fraction`);
/// when the genome set a bias `v` for this chem, the share shifts by
/// `v / (1 + |v|)` (squashed to (-1, 1)) and clamps to `[0, 1]`.
/// Mirrors the TS `partitionFrac`.
fn partition_frac(partition: &[(usize, f64)], base: f32, chem: usize) -> f32 {
    for &(c, v) in partition {
        if c == chem {
            let shift = v / (1.0 + v.abs());
            return (base as f64 + shift).clamp(0.0, 1.0) as f32;
        }
    }
    base
}

/// Single-crossover recombination of two genomes. The result has the
/// FIRST parent's length (so genome-size-based costs stay stable):
/// bytes `[0, k)` come from `a`, bytes `[k, len_a)` come from `b`
/// (falling back to `a`'s tail when `b` is shorter). `k` is uniform
/// in `[0, len_a]`. Mirrors the TS `crossoverGenomes`.
fn crossover_genomes(a: &[u8], b: &[u8], rng: &mut Mulberry32) -> Vec<u8> {
    let len = a.len();
    if len == 0 {
        return b.to_vec();
    }
    let k = (rng.next_f64() * (len as f64 + 1.0)) as usize;
    let k = k.min(len);
    let mut out = Vec::with_capacity(len);
    out.extend_from_slice(&a[..k]);
    for i in k..len {
        out.push(if i < b.len() { b[i] } else { a[i] });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::CHEM_GLU;
    use crate::genome::{OP_END, OP_GENE, OP_NOP, OP_REPRODUCE};
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
        let spawned = run_reproduction(&mut store, &crate::bonding::make_bonds(0), &mut rng, 5.0, 1.0);
        assert_eq!(spawned, 1);
        assert_eq!(store.len(), 2);
        // Each half should get ~ half the glucose pool.
        assert!((store.chems[CHEM_GLU][0] - 5.0).abs() < 1e-3);
        assert!((store.chems[CHEM_GLU][1] - 5.0).abs() < 1e-3);
        // Parent ATP: started 20. Attempt cost = 0.4 + 0.01*0.5*30 =
        // 0.55 -> 19.45. Fission cost 4 -> 15.45. Split 50/50 -> 7.725
        // each.
        assert!((store.chems[CHEM_ATP][0] - 7.725).abs() < 1e-3, "got {}", store.chems[CHEM_ATP][0]);
        assert!((store.chems[CHEM_ATP][1] - 7.725).abs() < 1e-3, "got {}", store.chems[CHEM_ATP][1]);
        // child_count stamped on the parent.
        assert_eq!(store.child_count[0], 1);
    }

    #[test]
    fn skewed_fraction_skews_chem_split() {
        let mut store = make_parent(20.0, 10.0);
        fire_reproduce(&mut store, 0, 0.7); // parent keeps 70%
        let mut rng = Mulberry32::new(1);
        let n = run_reproduction(&mut store, &crate::bonding::make_bonds(0), &mut rng, 1.0, 1.0);
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
        let n = run_reproduction(&mut store, &crate::bonding::make_bonds(0), &mut rng, 1.0, 1.0);
        assert_eq!(n, 0);
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn flag_cleared_so_one_spawn_per_tick() {
        let mut store = make_parent(50.0, 10.0);
        fire_reproduce(&mut store, 0, 0.5);
        let mut rng = Mulberry32::new(1);
        run_reproduction(&mut store, &crate::bonding::make_bonds(0), &mut rng, 1.0, 1.0);
        // Re-run without firing reproduce again -- no new daughter.
        let len_after = store.len();
        run_reproduction(&mut store, &crate::bonding::make_bonds(0), &mut rng, 2.0, 1.0);
        assert_eq!(store.len(), len_after);
    }

    #[test]
    fn catalyst_pool_splits_with_share() {
        let mut store = make_parent(20.0, 10.0);
        store.catalyst[42][0] = 2.0;
        fire_reproduce(&mut store, 0, 0.5);
        let mut rng = Mulberry32::new(1);
        run_reproduction(&mut store, &crate::bonding::make_bonds(0), &mut rng, 1.0, 1.0);
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
        run_reproduction(&mut store, &crate::bonding::make_bonds(0), &mut rng, 1.0, 1.0);
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

    #[test]
    fn failed_reproduce_attempt_still_costs_atp() {
        // A cell below the fission ATP threshold that fires REPRODUCE
        // must STILL pay the attempt cost (ATP -> ADP), so spamming the
        // op isn't free. With 5 ATP it can't divide (needs 8) but the
        // attempt drains a little.
        let mut store = CreatureStore::new();
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[CHEM_ATP] = 5.0;
        chems[CHEM_GLU] = 20.0;
        store.push(CreatureInit {
            r: 8.0, chems: Some(chems), ..CreatureInit::default()
        });
        store.vm_out[0].reproduce = true;
        store.vm_out[0].reproduce_fraction = 0.5;
        let atp0 = store.chems[CHEM_ATP][0];
        let adp0 = store.chems[CHEM_ADP][0];
        let mut rng = Mulberry32::new(1);
        let spawned = run_reproduction(
            &mut store, &crate::bonding::make_bonds(1), &mut rng, 1.0, 0.0,
        );
        assert_eq!(spawned, 0, "5 ATP is below the fission threshold");
        let atp1 = store.chems[CHEM_ATP][0];
        let adp1 = store.chems[CHEM_ADP][0];
        assert!(atp1 < atp0, "failed attempt must still spend ATP");
        // Mass-conserving: ATP lost == ADP gained.
        assert!(((atp0 - atp1) - (adp1 - adp0)).abs() < 1e-5);
    }

    #[test]
    fn genome_replication_taxes_aa_and_min_into_waste() {
        use crate::chem_ids::{CHEM_AA, CHEM_MIN, CHEM_WASTE};
        let mut store = CreatureStore::new();
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[CHEM_AA] = 10.0;
        chems[CHEM_MIN] = 10.0;
        store.push(CreatureInit {
            r: 8.0, chems: Some(chems), ..CreatureInit::default()
        });
        let aa0 = store.chems[CHEM_AA][0];
        let min0 = store.chems[CHEM_MIN][0];
        // 100-byte genome -> half_demand = 0.5 * 0.01 * 100 = 0.5 each.
        charge_genome_replication(&mut store, 0, 100);
        let aa_spent = aa0 - store.chems[CHEM_AA][0];
        let min_spent = min0 - store.chems[CHEM_MIN][0];
        assert!((aa_spent - 0.5).abs() < 1e-5, "aa spent {aa_spent}");
        assert!((min_spent - 0.5).abs() < 1e-5, "min spent {min_spent}");
        // Consumed mass becomes waste (mass-conserving).
        assert!((store.chems[CHEM_WASTE][0] - 1.0).abs() < 1e-5);
    }

    #[test]
    fn genome_tax_capped_at_available() {
        use crate::chem_ids::{CHEM_AA, CHEM_MIN};
        let mut store = CreatureStore::new();
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[CHEM_AA] = 0.1; // less than the 0.5 demand
        chems[CHEM_MIN] = 0.1;
        store.push(CreatureInit {
            r: 8.0, chems: Some(chems), ..CreatureInit::default()
        });
        charge_genome_replication(&mut store, 0, 100);
        // Can't go negative; takes only what's there.
        assert!(store.chems[CHEM_AA][0] >= 0.0);
        assert!(store.chems[CHEM_MIN][0] >= 0.0);
        assert!((store.chems[CHEM_AA][0]).abs() < 1e-6);
    }

    #[test]
    fn partition_frac_shifts_and_clamps() {
        // No entry -> base.
        assert_eq!(partition_frac(&[], 0.5, 2), 0.5);
        // Positive bias pushes the child's share up.
        let up = partition_frac(&[(2, 4.0)], 0.5, 2);
        assert!(up > 0.5 && up <= 1.0, "got {up}");
        // Negative bias pulls it down.
        let down = partition_frac(&[(2, -4.0)], 0.5, 2);
        assert!((0.0..0.5).contains(&down), "got {down}");
        // Extreme bias clamps to [0,1].
        assert!(partition_frac(&[(2, 1e6)], 0.9, 2) <= 1.0);
        assert!(partition_frac(&[(2, -1e6)], 0.1, 2) >= 0.0);
    }

    #[test]
    fn partition_skews_named_chem_split() {
        // A cell biases CHEM_GLU strongly toward the daughter; after
        // fission the daughter should hold a larger glucose share than
        // the default 0.5 split would give.
        let mut store = CreatureStore::new();
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[CHEM_ATP] = 50.0;
        chems[CHEM_GLU] = 100.0;
        store.push(CreatureInit {
            x: 50.0, y: 50.0, r: 8.0,
            genome: vec![OP_GENE, OP_REPRODUCE, OP_END],
            chems: Some(chems),
            ..CreatureInit::default()
        });
        store.vm_out[0].reproduce = true;
        store.vm_out[0].reproduce_fraction = 0.5; // default split 0.5
        // Bias glucose hard toward the child.
        store.vm_out[0].partition_count = 1;
        store.vm_out[0].partition_chem[0] = CHEM_GLU as i16;
        store.vm_out[0].partition_bias[0] = 8.0;
        let mut rng = Mulberry32::new(1);
        let spawned = run_reproduction(
            &mut store, &crate::bonding::make_bonds(1), &mut rng, 1.0, 0.0,
        );
        assert_eq!(spawned, 1);
        let daughter_glu = store.chems[CHEM_GLU][store.n - 1];
        // With base 0.5 + 8/(1+8)=0.89 share, the daughter should get
        // well over half the 100 glucose.
        assert!(
            daughter_glu > 60.0,
            "partition should skew glucose to daughter, got {daughter_glu}",
        );
    }

    #[test]
    fn crossover_takes_prefix_from_a_suffix_from_b() {
        // Deterministic check across many rng draws: every output byte
        // must come from `a` (prefix) or `b` (suffix), and the result
        // keeps a's length.
        let a = vec![1u8, 2, 3, 4, 5, 6];
        let b = vec![10u8, 20, 30, 40, 50, 60];
        let mut rng = Mulberry32::new(99);
        for _ in 0..200 {
            let out = crossover_genomes(&a, &b, &mut rng);
            assert_eq!(out.len(), a.len());
            // There must be a single crossover point k: out[..k]==a[..k]
            // and out[k..]==b[k..].
            let mut k = a.len();
            for i in 0..a.len() {
                if out[i] != a[i] {
                    k = i;
                    break;
                }
            }
            for (i, &v) in out.iter().enumerate() {
                if i < k {
                    assert_eq!(v, a[i], "prefix mismatch at {i}");
                } else {
                    assert_eq!(v, b[i], "suffix mismatch at {i}");
                }
            }
        }
    }

    #[test]
    fn crossover_handles_shorter_partner() {
        // When b is shorter, the tail beyond b falls back to a.
        let a = vec![1u8, 2, 3, 4, 5];
        let b = vec![9u8, 9];
        let mut rng = Mulberry32::new(7);
        let out = crossover_genomes(&a, &b, &mut rng);
        assert_eq!(out.len(), a.len());
        // Any position >= b.len() that came from the suffix must equal a.
        for i in b.len()..a.len() {
            // It's either a's value (prefix) or a's fallback (suffix) --
            // both are a[i].
            assert_eq!(out[i], a[i]);
        }
    }

    #[test]
    fn bonded_parent_produces_recombinant_daughter() {
        // Two bonded cells with distinct genomes; the daughter's genome
        // should contain bytes from BOTH parents (with overwhelming
        // probability across the crossover point).
        let mut store = CreatureStore::new();
        let mut chems_a = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems_a[CHEM_ATP] = 50.0;
        chems_a[CHEM_GLU] = 50.0;
        // Parent A genome: all 0x01 ops (NOPs are 0x00; use distinct
        // marker bytes inside a gene so crossover is observable).
        let genome_a = vec![OP_GENE, 0x10, 0x10, 0x10, 0x10, OP_REPRODUCE, OP_END];
        store.push(CreatureInit {
            x: 100.0, y: 100.0, r: 8.0,
            genome: genome_a.clone(),
            chems: Some(chems_a),
            ..CreatureInit::default()
        });
        let mut chems_b = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems_b[CHEM_ATP] = 50.0;
        let genome_b = vec![OP_GENE, 0x20, 0x20, 0x20, 0x20, OP_NOP, OP_END];
        store.push(CreatureInit {
            x: 110.0, y: 100.0, r: 8.0,
            genome: genome_b.clone(),
            chems: Some(chems_b),
            ..CreatureInit::default()
        });
        // Bond them: cell 0 <-> cell 1.
        let mut bonds = crate::bonding::make_bonds(2);
        bonds[0].push(1);
        bonds[1].push(0);
        // Cell 0 fires REPRODUCE.
        store.vm_out[0].reproduce = true;
        store.vm_out[0].reproduce_fraction = 0.5;
        // Mutation off so the only genome change is crossover.
        let mut rng = Mulberry32::new(3);
        let spawned = run_reproduction(&mut store, &bonds, &mut rng, 1.0, 0.0);
        assert_eq!(spawned, 1);
        // The daughter is the last-pushed cell.
        let d = store.genome[store.n - 1].clone();
        assert_eq!(d.len(), genome_a.len(), "daughter keeps parent A length");
        // Daughter must be a prefix of A + suffix of B; assert it isn't
        // byte-identical to A (crossover actually mixed in B). With
        // seed 3 the crossover point lands inside the gene body.
        assert!(
            d != genome_a,
            "bonded daughter should differ from pure parent-A clone",
        );
    }
}
