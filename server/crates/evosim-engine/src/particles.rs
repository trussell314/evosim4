//! Particle Struct-of-Arrays store, ported from the TS `ParticleStore`
//! class in `src/sim/core.ts`. The TS code leans on a single
//! SharedArrayBuffer + parallel byte-offset views because the
//! force/collision kernels run inside worker subthreads that can only
//! see SAB-backed memory. Rust doesn't need that dance: rayon shares
//! `&mut [f32]` slices across threads natively, so we can keep each
//! column as a regular `Vec<f32>` (or `Vec<u8>`, `Vec<i32>`) and let
//! rustc / LLVM handle the rest.
//!
//! Behaviour parity with the TS store:
//!   - swap-pop removal at any index so per-tick churn is O(1)
//!   - sparse `molecules` / `generic_chem` payloads carried only when
//!     a dying cell dumped its pool into a particle (cleared on slot
//!     reuse)
//!   - quiet-tick counter for the collision sleep heuristic
//!
//! Differences from TS that don't affect semantics:
//!   - no `cap` cliff: Vec grows on demand. The TS cap of 131_072 is
//!     a SAB constraint that doesn't apply here.
//!   - no `onParticleSlotReused` hook -- the collision module clears
//!     the asleep flag directly through a mutable slice once it
//!     runs, instead of trampolining through a global hook.

#![allow(clippy::too_many_arguments)] // SoA-style spawn needs N positional args

use crate::chem_ids::CHEMICAL_COUNT;

/// Sparse per-particle molecule payload. Populated only when a dying
/// cell's named-chem pool gets dumped into a freshly-spawned particle
/// so a future predator can re-absorb it. Defined here -- not in
/// `chem_ids` -- because it's a runtime container, not a schema.
#[derive(Debug, Clone, Default)]
pub struct Molecules {
    /// One slot per named chemical (length `NAMED_CHEMICAL_COUNT`).
    /// Indexed by `CHEM_*` slot constants.
    pub named: Vec<f32>,
}

impl Molecules {
    pub fn zeroed() -> Self {
        Self { named: vec![0.0; crate::chem_ids::NAMED_CHEMICAL_COUNT] }
    }
}

/// Default initial capacity. The TS code preallocates 131_072 for SAB
/// reasons; we start small and let `Vec` grow. The wgpu / rayon work
/// later in the port pulls slices straight off these columns so the
/// growth doesn't break any pinned worker view.
const DEFAULT_INITIAL_CAP: usize = 256;

#[derive(Debug, Default)]
pub struct ParticleStore {
    pub n: usize,
    pub x: Vec<f32>,
    pub y: Vec<f32>,
    pub z: Vec<f32>,
    pub vx: Vec<f32>,
    pub vy: Vec<f32>,
    pub vz: Vec<f32>,
    pub r: Vec<f32>,
    /// 0.0 sentinel = "use CHEM_BASE_DENSITY[chem_id]"; copied into a
    /// dense `density_eff` column by the force kernel before
    /// dispatch.
    pub density: Vec<f32>,
    /// Sim-seconds since spawn. Drives the decay pass.
    pub age: Vec<f32>,
    pub chem_id: Vec<u8>,
    /// Consecutive ticks at low speed. The collision module flips the
    /// asleep flag once this crosses its threshold.
    pub quiet_ticks: Vec<i32>,
    /// Sparse per-particle molecule pool.
    pub molecules: Vec<Option<Box<Molecules>>>,
    /// Sparse per-particle generic-chem pool. Length
    /// `GENERIC_CHEMICAL_COUNT` when present.
    pub generic_chem: Vec<Option<Box<[f32]>>>,
}

/// Initial state for a `push`. Named fields mirror the TS
/// `pushParticle` opts object so the call sites stay readable.
#[derive(Debug, Clone, Default)]
pub struct ParticleInit {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub vx: f32,
    pub vy: f32,
    pub vz: f32,
    pub r: f32,
    pub chem_id: u8,
    pub density: f32,
    pub quiet_ticks: i32,
    pub molecules: Option<Box<Molecules>>,
    pub generic_chem: Option<Box<[f32]>>,
}

impl ParticleStore {
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_INITIAL_CAP)
    }

    pub fn with_capacity(cap: usize) -> Self {
        let mut s = Self::default();
        s.x.reserve(cap);
        s.y.reserve(cap);
        s.z.reserve(cap);
        s.vx.reserve(cap);
        s.vy.reserve(cap);
        s.vz.reserve(cap);
        s.r.reserve(cap);
        s.density.reserve(cap);
        s.age.reserve(cap);
        s.chem_id.reserve(cap);
        s.quiet_ticks.reserve(cap);
        s.molecules.reserve(cap);
        s.generic_chem.reserve(cap);
        s
    }

    pub fn len(&self) -> usize {
        self.n
    }

    pub fn is_empty(&self) -> bool {
        self.n == 0
    }

    /// Append a particle, returning its slot index. Mirrors the TS
    /// `pushParticle` semantics: any sparse pool that was set on the
    /// init is moved into the slot, anything else stays `None`.
    pub fn push(&mut self, init: ParticleInit) -> usize {
        debug_assert!(
            (init.chem_id as usize) < CHEMICAL_COUNT,
            "chem_id out of range"
        );
        let i = self.n;
        self.x.push(init.x);
        self.y.push(init.y);
        self.z.push(init.z);
        self.vx.push(init.vx);
        self.vy.push(init.vy);
        self.vz.push(init.vz);
        self.r.push(init.r);
        self.density.push(init.density);
        self.age.push(0.0);
        self.chem_id.push(init.chem_id);
        self.quiet_ticks.push(init.quiet_ticks);
        self.molecules.push(init.molecules);
        self.generic_chem.push(init.generic_chem);
        self.n += 1;
        i
    }

    /// Swap-pop removal -- O(1) at the cost of reordering. Returns
    /// the slot the last particle moved into (= `idx`) when a swap
    /// happened, or `None` when the removed slot WAS the last one.
    /// The caller (= the World) uses this to fix up its
    /// `arr_idx -> store_idx` handle mapping.
    pub fn remove_swap_pop(&mut self, idx: usize) -> Option<usize> {
        let last = self.n - 1;
        if idx == last {
            self.x.pop();
            self.y.pop();
            self.z.pop();
            self.vx.pop();
            self.vy.pop();
            self.vz.pop();
            self.r.pop();
            self.density.pop();
            self.age.pop();
            self.chem_id.pop();
            self.quiet_ticks.pop();
            self.molecules.pop();
            self.generic_chem.pop();
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
        self.density.swap_remove(idx);
        self.age.swap_remove(idx);
        self.chem_id.swap_remove(idx);
        self.quiet_ticks.swap_remove(idx);
        self.molecules.swap_remove(idx);
        self.generic_chem.swap_remove(idx);
        self.n -= 1;
        Some(idx)
    }

    /// Drop every particle. Used by the engine `Reset` admin command.
    pub fn clear(&mut self) {
        self.x.clear();
        self.y.clear();
        self.z.clear();
        self.vx.clear();
        self.vy.clear();
        self.vz.clear();
        self.r.clear();
        self.density.clear();
        self.age.clear();
        self.chem_id.clear();
        self.quiet_ticks.clear();
        self.molecules.clear();
        self.generic_chem.clear();
        self.n = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init(x: f32, chem_id: u8) -> ParticleInit {
        ParticleInit { x, chem_id, r: 1.0, ..ParticleInit::default() }
    }

    #[test]
    fn push_grows_and_indexes_in_order() {
        let mut s = ParticleStore::new();
        assert!(s.is_empty());
        assert_eq!(s.push(init(1.0, 2)), 0);
        assert_eq!(s.push(init(2.0, 3)), 1);
        assert_eq!(s.push(init(3.0, 4)), 2);
        assert_eq!(s.len(), 3);
        assert_eq!(s.x, &[1.0, 2.0, 3.0]);
        assert_eq!(s.chem_id, &[2, 3, 4]);
    }

    #[test]
    fn swap_pop_in_middle_moves_last() {
        let mut s = ParticleStore::new();
        s.push(init(1.0, 1));
        s.push(init(2.0, 2));
        s.push(init(3.0, 3));
        // Remove index 0 -> slot 0 should now hold the last (3.0/3).
        let swapped = s.remove_swap_pop(0);
        assert_eq!(swapped, Some(0));
        assert_eq!(s.len(), 2);
        assert_eq!(s.x[0], 3.0);
        assert_eq!(s.chem_id[0], 3);
        assert_eq!(s.x[1], 2.0);
        assert_eq!(s.chem_id[1], 2);
    }

    #[test]
    fn swap_pop_at_end_does_not_swap() {
        let mut s = ParticleStore::new();
        s.push(init(1.0, 1));
        s.push(init(2.0, 2));
        assert_eq!(s.remove_swap_pop(1), None);
        assert_eq!(s.len(), 1);
        assert_eq!(s.x[0], 1.0);
    }

    #[test]
    fn sparse_molecules_carried_through_swap() {
        let mut mol = Molecules::zeroed();
        mol.named[crate::chem_ids::CHEM_GLU] = 4.5;
        let mut s = ParticleStore::new();
        s.push(init(1.0, 1));
        s.push(ParticleInit {
            molecules: Some(Box::new(mol)),
            ..init(2.0, 2)
        });
        s.push(init(3.0, 3));
        // Swap-pop slot 0; the old last (slot 2) moves in. The mol-
        // carrying particle (was slot 1) stays at index 1.
        s.remove_swap_pop(0);
        assert!(s.molecules[0].is_none());
        let mol = s.molecules[1].as_ref().expect("mol carried");
        assert_eq!(mol.named[crate::chem_ids::CHEM_GLU], 4.5);
    }

    #[test]
    fn clear_resets_to_empty() {
        let mut s = ParticleStore::new();
        for i in 0..10 {
            s.push(init(i as f32, 1));
        }
        s.clear();
        assert!(s.is_empty());
        assert!(s.x.is_empty());
        assert_eq!(s.molecules.len(), 0);
    }
}
