//! Creature Struct-of-Arrays store, the minimal slice ported from the
//! TS `CreatureStore` in `src/sim/core.ts`. The TS store carries
//! ~60 named columns plus per-creature `CATALYST_COUNT * 2` catalyst
//! and inhibitor pools and per-creature generic-chem slots; that
//! whole shape only makes sense once every consuming subsystem
//! (regions, atmosphere, organelles, transport) has been ported.
//!
//! For now we ship just enough state to run the VM and watch creatures
//! steer under their own programs:
//!   - position / velocity / radius
//!   - per-cell named-chem pool (ATP among them)
//!   - genome bytes
//!   - persistent `VmState`
//!   - per-cell `VmOutputs` (so the per-tick reset is O(expressed))
//!   - per-slot catalyst + inhibitor pools (the substrate the
//!     SYNTH op writes to; reactions will read from these in a
//!     later commit)
//!
//! Each TS column lands as a separate Rust `Vec<f32>` (or `Vec<i32>`
//! etc.), matching the ParticleStore design from `particles.rs`. As
//! more subsystems port over, the column inventory grows; the public
//! `push` / `remove_swap_pop` / `clear` API stays stable.

#![allow(clippy::too_many_arguments)]

use crate::chem_ids::{CHEM_ATP, NAMED_CHEMICAL_COUNT};
use crate::genome_consts::CATALYST_COUNT;
use crate::vm::{VmOutputs, VmState};

/// Floor on creature radius. Matches TS `MIN_CREATURE_R = 4`.
pub const MIN_CREATURE_R: f32 = 4.0;

/// All per-cell state we currently track. Columns are public so the
/// update pass can mutate them in place; future readers (renderer,
/// snapshot packer) take immutable slices through `&self` views.
#[derive(Debug, Default)]
pub struct CreatureStore {
    pub n: usize,

    // ----- Kinematics.
    pub x: Vec<f32>,
    pub y: Vec<f32>,
    pub z: Vec<f32>,
    pub vx: Vec<f32>,
    pub vy: Vec<f32>,
    pub vz: Vec<f32>,
    pub r: Vec<f32>,
    /// Heading angle in radians; the TURN op accumulates `out.turn`
    /// here so a downstream pass can apply it to velocity.
    pub heading: Vec<f32>,

    // ----- Lifecycle.
    pub born_at: Vec<f64>,
    /// Sim time of the most recent REPRODUCE op fire (whether or not
    /// tryReproduce committed). Drives the sterile-cull heuristic
    /// once that pass lands; harmless to track now.
    pub last_reproduce_fire_t: Vec<f64>,
    pub child_count: Vec<i32>,

    // ----- Chemistry / energy.
    /// Per-named-chem pool, in mass units. Layout matches
    /// `NAMED_CHEMICALS`: index by `CHEM_*` slot constants. ATP lives
    /// here too (slot `CHEM_ATP`); the TS "energy" alias is just a
    /// view onto the ATP column, which we model as a method here.
    pub chems: Vec<Vec<f32>>,
    /// Per-cell catalyst pool, one per reaction slot. Grown by
    /// `SYNTH CAT <slot>`; consumed by enzyme decay (not ported yet).
    pub catalyst: Vec<Vec<f32>>,
    /// Per-cell inhibitor pool (allosteric repressor analog). Parallel
    /// shape to `catalyst`.
    pub inhibitor: Vec<Vec<f32>>,

    // ----- VM state.
    pub genome: Vec<Vec<u8>>,
    pub vm_state: Vec<VmState>,
    pub vm_out: Vec<VmOutputs>,
    /// Derived per-cell sense range (genome::compute_sense_range
    /// applied at push and refreshed on genome mutations). Read by
    /// the Sensors trait at VM dispatch.
    pub sense_range: Vec<f32>,
}

/// Initial state for `push`. Named fields mirror the ergonomic shape
/// of the TS `newCreature` init; fields we don't carry yet stay off
/// the struct entirely so a future addition is an explicit edit, not
/// a silent default-zero.
#[derive(Debug, Clone, Default)]
pub struct CreatureInit {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub vx: f32,
    pub vy: f32,
    pub vz: f32,
    pub r: f32,
    pub heading: f32,
    pub born_at: f64,
    pub genome: Vec<u8>,
    /// Starter named-chem pool. If `None`, the creature starts with
    /// all named chems at zero. Length must be `NAMED_CHEMICAL_COUNT`
    /// when supplied.
    pub chems: Option<Vec<f32>>,
}

impl CreatureStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.n
    }

    pub fn is_empty(&self) -> bool {
        self.n == 0
    }

    /// ATP read-helper. Matches the TS `store.energy` alias onto the
    /// `m_atp` column.
    pub fn energy(&self, i: usize) -> f32 {
        self.chems[CHEM_ATP][i]
    }

    /// Total cell mass = sum of every chem in the pool. Matches the
    /// TS `creatureTotalMass` helper.
    pub fn total_mass(&self, i: usize) -> f32 {
        self.chems.iter().map(|c| c[i]).sum()
    }

    /// Append a creature, returning its slot index.
    pub fn push(&mut self, init: CreatureInit) -> usize {
        let i = self.n;
        let r = init.r.max(MIN_CREATURE_R);
        self.x.push(init.x);
        self.y.push(init.y);
        self.z.push(init.z);
        self.vx.push(init.vx);
        self.vy.push(init.vy);
        self.vz.push(init.vz);
        self.r.push(r);
        self.heading.push(init.heading);
        self.born_at.push(init.born_at);
        self.last_reproduce_fire_t.push(0.0);
        self.child_count.push(0);

        let chem_init = init
            .chems
            .unwrap_or_else(|| vec![0.0; NAMED_CHEMICAL_COUNT]);
        debug_assert_eq!(
            chem_init.len(),
            NAMED_CHEMICAL_COUNT,
            "chems init length must match NAMED_CHEMICAL_COUNT"
        );
        if self.chems.is_empty() {
            self.chems = (0..NAMED_CHEMICAL_COUNT).map(|_| Vec::new()).collect();
        }
        for (slot, val) in chem_init.into_iter().enumerate() {
            self.chems[slot].push(val);
        }
        if self.catalyst.is_empty() {
            self.catalyst = (0..CATALYST_COUNT).map(|_| Vec::new()).collect();
            self.inhibitor = (0..CATALYST_COUNT).map(|_| Vec::new()).collect();
        }
        for slot in 0..CATALYST_COUNT {
            self.catalyst[slot].push(0.0);
            self.inhibitor[slot].push(0.0);
        }

        let sense_range = crate::genome::compute_sense_range(&init.genome);
        self.genome.push(init.genome);
        self.vm_state.push(VmState::new());
        self.vm_out.push(VmOutputs::new());
        self.sense_range.push(sense_range);

        self.n += 1;
        i
    }

    /// Swap-pop removal. Returns `Some(idx)` when a swap happened,
    /// `None` when the removed slot was already last.
    pub fn remove_swap_pop(&mut self, idx: usize) -> Option<usize> {
        let last = self.n - 1;
        let was_last = idx == last;
        if was_last {
            self.x.pop();
            self.y.pop();
            self.z.pop();
            self.vx.pop();
            self.vy.pop();
            self.vz.pop();
            self.r.pop();
            self.heading.pop();
            self.born_at.pop();
            self.last_reproduce_fire_t.pop();
            self.child_count.pop();
            for c in &mut self.chems {
                c.pop();
            }
            for c in &mut self.catalyst {
                c.pop();
            }
            for c in &mut self.inhibitor {
                c.pop();
            }
            self.genome.pop();
            self.vm_state.pop();
            self.vm_out.pop(); self.sense_range.pop();
            self.n -= 1;
            return None;
        }
        self.x.swap_remove(idx);
        self.y.swap_remove(idx);
        self.z.swap_remove(idx);
        self.vx.swap_remove(idx);
        self.vy.swap_remove(idx);
        self.vz.swap_remove(idx);
        self.r.swap_remove(idx);
        self.heading.swap_remove(idx);
        self.born_at.swap_remove(idx);
        self.last_reproduce_fire_t.swap_remove(idx);
        self.child_count.swap_remove(idx);
        for c in &mut self.chems {
            c.swap_remove(idx);
        }
        for c in &mut self.catalyst {
            c.swap_remove(idx);
        }
        for c in &mut self.inhibitor {
            c.swap_remove(idx);
        }
        self.genome.swap_remove(idx);
        self.vm_state.swap_remove(idx);
        self.vm_out.swap_remove(idx); self.sense_range.swap_remove(idx);
        self.n -= 1;
        Some(idx)
    }

    pub fn clear(&mut self) {
        self.x.clear();
        self.y.clear();
        self.z.clear();
        self.vx.clear();
        self.vy.clear();
        self.vz.clear();
        self.r.clear();
        self.heading.clear();
        self.born_at.clear();
        self.last_reproduce_fire_t.clear();
        self.child_count.clear();
        for c in &mut self.chems {
            c.clear();
        }
        for c in &mut self.catalyst {
            c.clear();
        }
        for c in &mut self.inhibitor {
            c.clear();
        }
        self.genome.clear();
        self.vm_state.clear();
        self.vm_out.clear(); self.sense_range.clear();
        self.n = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::CHEM_GLU;
    use crate::genome::OP_END;

    fn init(x: f32, atp: f32) -> CreatureInit {
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[CHEM_ATP] = atp;
        CreatureInit {
            x,
            r: MIN_CREATURE_R,
            genome: vec![OP_END],
            chems: Some(chems),
            ..CreatureInit::default()
        }
    }

    #[test]
    fn push_and_energy_alias() {
        let mut s = CreatureStore::new();
        let i = s.push(init(10.0, 7.5));
        assert_eq!(i, 0);
        assert_eq!(s.len(), 1);
        assert_eq!(s.energy(0), 7.5);
        assert_eq!(s.x[0], 10.0);
    }

    #[test]
    fn r_clamped_to_minimum() {
        let mut s = CreatureStore::new();
        let init = CreatureInit { r: 1.0, ..init(0.0, 0.0) };
        s.push(init);
        assert_eq!(s.r[0], MIN_CREATURE_R);
    }

    #[test]
    fn total_mass_sums_chems() {
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[CHEM_ATP] = 3.0;
        chems[CHEM_GLU] = 4.0;
        let mut s = CreatureStore::new();
        s.push(CreatureInit {
            chems: Some(chems),
            genome: vec![OP_END],
            ..CreatureInit::default()
        });
        assert_eq!(s.total_mass(0), 7.0);
    }

    #[test]
    fn catalyst_columns_grow_with_count() {
        let mut s = CreatureStore::new();
        s.push(init(0.0, 0.0));
        s.push(init(1.0, 0.0));
        assert_eq!(s.catalyst.len(), CATALYST_COUNT);
        assert_eq!(s.catalyst[0].len(), 2);
        assert_eq!(s.inhibitor[127].len(), 2);
    }

    #[test]
    fn swap_pop_middle_moves_last() {
        let mut s = CreatureStore::new();
        s.push(init(1.0, 1.0));
        s.push(init(2.0, 2.0));
        s.push(init(3.0, 3.0));
        let swapped = s.remove_swap_pop(0);
        assert_eq!(swapped, Some(0));
        assert_eq!(s.len(), 2);
        assert_eq!(s.x[0], 3.0); // old last moved into slot 0
        assert_eq!(s.energy(0), 3.0);
        assert_eq!(s.x[1], 2.0);
    }

    #[test]
    fn swap_pop_last_does_not_swap() {
        let mut s = CreatureStore::new();
        s.push(init(1.0, 1.0));
        s.push(init(2.0, 2.0));
        assert_eq!(s.remove_swap_pop(1), None);
        assert_eq!(s.len(), 1);
        assert_eq!(s.x[0], 1.0);
    }

    #[test]
    fn clear_resets_columns() {
        let mut s = CreatureStore::new();
        for i in 0..5 {
            s.push(init(i as f32, 1.0));
        }
        s.clear();
        assert!(s.is_empty());
        assert!(s.x.is_empty());
        assert!(s.chems[CHEM_ATP].is_empty());
        assert!(s.catalyst[0].is_empty());
    }
}
