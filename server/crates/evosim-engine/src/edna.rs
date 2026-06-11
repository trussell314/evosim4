//! Extracellular DNA carriers (eDNA) for horizontal gene transfer.
//!
//! Dying cells release their genome into the eDNA field with a
//! position and age. COMPETENCE-expressing cells absorb the nearest
//! fragment in range: one byte from the fragment overwrites a random
//! byte in the cell's genome. That's it -- minimal HGT, enough for
//! lateral evolution to happen.
//!
//! The TS engine has a much richer system (active packaging via SYNTH
//! PACKAGE, separate carrier ages, payload-keyed uptake). This is
//! the foundational subset: death-driven release + COMPETENCE
//! uptake closes the horizontal-transfer loop without active
//! emission. Active packaging lands when needed.

use crate::creatures::CreatureStore;
use crate::rng::Mulberry32;
use crate::vm::SYNTH_BIT_COMPETENCE;
use serde::{Deserialize, Serialize};

/// One eDNA carrier in the field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdnaCarrier {
    pub x: f32,
    pub y: f32,
    pub age: f32,
    pub genome: Vec<u8>,
}

/// World-wide eDNA pool. Held on the World so it round-trips in
/// save/load.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct EdnaField {
    pub carriers: Vec<EdnaCarrier>,
}

impl EdnaField {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, x: f32, y: f32, genome: Vec<u8>) {
        if genome.is_empty() {
            return;
        }
        self.carriers.push(EdnaCarrier { x, y, age: 0.0, genome });
    }
}

/// Carrier lifetime in sim-seconds. Past this, fragments dissolve.
const EDNA_TTL_S: f32 = 90.0;
/// Pickup range from cell center.
const EDNA_PICKUP_R: f32 = 50.0;
/// Hard cap on carrier count to keep the field bounded.
const MAX_CARRIERS: usize = 256;

/// Advance carrier ages and remove expired ones. Returns the number
/// removed.
pub fn age_carriers(field: &mut EdnaField, dt: f32) -> usize {
    let mut removed = 0;
    let mut i = field.carriers.len();
    while i > 0 {
        i -= 1;
        field.carriers[i].age += dt;
        if field.carriers[i].age >= EDNA_TTL_S {
            field.carriers.swap_remove(i);
            removed += 1;
        }
    }
    removed
}

/// COMPETENCE cells absorb the nearest in-range carrier. Returns the
/// number of HGT events this tick.
pub fn run_competence_uptake(
    creatures: &mut CreatureStore,
    field: &mut EdnaField,
    rng: &mut Mulberry32,
) -> usize {
    if field.carriers.is_empty() {
        return 0;
    }
    let mut events = 0;
    let n = creatures.n;
    let pickup_sq = EDNA_PICKUP_R * EDNA_PICKUP_R;
    for i in 0..n {
        let synth_mask = creatures.vm_out[i].synth_mask;
        if synth_mask & (1 << SYNTH_BIT_COMPETENCE) == 0 {
            continue;
        }
        let cx = creatures.x[i];
        let cy = creatures.y[i];
        let mut best: Option<(usize, f32)> = None;
        for (k, c) in field.carriers.iter().enumerate() {
            let dx = c.x - cx;
            let dy = c.y - cy;
            let dsq = dx * dx + dy * dy;
            if dsq > pickup_sq {
                continue;
            }
            let better = best.map_or(true, |(_, prev)| dsq < prev);
            if better {
                best = Some((k, dsq));
            }
        }
        let Some((k, _)) = best else {
            continue;
        };
        // Splice one random byte: read a random byte from the
        // fragment and write it into a random position in the cell's
        // genome. The fragment is consumed (TS lets a fragment
        // service many cells; we don't, to keep events more
        // selective).
        let carrier = field.carriers.swap_remove(k);
        if !carrier.genome.is_empty() && !creatures.genome[i].is_empty() {
            let src_idx = (rng.next_f64() * carrier.genome.len() as f64) as usize;
            let dst_idx = (rng.next_f64() * creatures.genome[i].len() as f64) as usize;
            creatures.genome[i][dst_idx] = carrier.genome[src_idx];
            // Recompute derived trait.
            creatures.sense_range[i] =
                crate::genome::compute_sense_range(&creatures.genome[i]);
        }
        events += 1;
    }
    events
}

/// Caller drops a fragment at the dying cell's position. Called by
/// the death pass.
pub fn release_at_death(field: &mut EdnaField, x: f32, y: f32, genome: &[u8]) {
    if field.carriers.len() >= MAX_CARRIERS {
        // Hard cap: drop the oldest carrier to make room. Keeps the
        // field bounded under runaway cull waves.
        field.carriers.swap_remove(0);
    }
    field.push(x, y, genome.to_vec());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::{CHEM_MEMBRANE, NAMED_CHEMICAL_COUNT};
    use crate::creatures::CreatureInit;
    use crate::vm::VmOutputs;

    fn cell_at(x: f32, y: f32, competent: bool) -> CreatureStore {
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[CHEM_MEMBRANE] = 5.0;
        let mut s = CreatureStore::new();
        s.push(CreatureInit {
            x,
            y,
            r: 8.0,
            chems: Some(chems),
            genome: vec![0x42; 16],
            ..CreatureInit::default()
        });
        s.vm_out[0] = VmOutputs::new();
        if competent {
            s.vm_out[0].synth_mask |= 1 << SYNTH_BIT_COMPETENCE;
        }
        s
    }

    #[test]
    fn aging_removes_expired() {
        let mut f = EdnaField::new();
        f.push(0.0, 0.0, vec![1, 2, 3]);
        age_carriers(&mut f, EDNA_TTL_S + 1.0);
        assert!(f.carriers.is_empty());
    }

    #[test]
    fn no_competence_no_uptake() {
        let mut s = cell_at(50.0, 50.0, false);
        let mut f = EdnaField::new();
        f.push(52.0, 50.0, vec![0xAA, 0xBB, 0xCC]);
        let mut rng = Mulberry32::new(1);
        let n = run_competence_uptake(&mut s, &mut f, &mut rng);
        assert_eq!(n, 0);
        assert_eq!(f.carriers.len(), 1);
    }

    #[test]
    fn competence_picks_up_in_range() {
        let mut s = cell_at(50.0, 50.0, true);
        let mut f = EdnaField::new();
        f.push(60.0, 50.0, vec![0xAA, 0xBB, 0xCC]); // 10 px away
        let mut rng = Mulberry32::new(1);
        let original = s.genome[0].clone();
        let n = run_competence_uptake(&mut s, &mut f, &mut rng);
        assert_eq!(n, 1);
        assert!(f.carriers.is_empty());
        // The cell's genome should now contain at least one byte
        // from the fragment {0xAA, 0xBB, 0xCC}.
        let g = &s.genome[0];
        let altered = g.iter().enumerate().any(|(i, &b)| b != original[i]);
        assert!(altered, "expected the splice to alter a byte");
    }

    #[test]
    fn out_of_range_no_uptake() {
        let mut s = cell_at(50.0, 50.0, true);
        let mut f = EdnaField::new();
        f.push(500.0, 50.0, vec![0xAA, 0xBB, 0xCC]); // way out
        let mut rng = Mulberry32::new(1);
        let n = run_competence_uptake(&mut s, &mut f, &mut rng);
        assert_eq!(n, 0);
        assert_eq!(f.carriers.len(), 1);
    }
}
