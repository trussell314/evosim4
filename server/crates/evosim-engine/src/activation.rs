//! Minimal sensor activation pass. Cells holding photoreceptor chems
//! convert ambient light into an activated_photo_visible signal that
//! their VM can read via SENSE_CHEMICAL CHEM_ACT_PHOTO_VISIBLE.
//!
//! This is the foundation for SENSE_CHEMICAL being useful as a true
//! environmental sensor. The TS engine runs a much richer activation
//! pass that handles photo/electric/vibration/pH/magnetic/light/mech/
//! thermo bands; we port just the photoreceptor + light case here.
//! More bands follow the same pattern: receptor_chem * stimulus *
//! gain = activated_chem.
//!
//! Activation chems are SIGNAL chems (not physical mass), so they're
//! excluded from mass conservation by chem_ids::is_signal. They
//! decay naturally each tick (the cell-side activation pool fades
//! when stimulus falls).

use crate::chem_ids::{
    CHEM_ACT_PHOTO_LONG, CHEM_ACT_PHOTO_SURFACE, CHEM_ACT_PHOTO_VISIBLE,
    CHEM_PHOTORECEPTOR_LONG, CHEM_PHOTORECEPTOR_SURFACE, CHEM_PHOTORECEPTOR_VISIBLE,
};
use crate::creatures::CreatureStore;

/// Per-receptor gain. Output = receptor_pool * stimulus * gain.
/// Tuned so a cell carrying ~1 receptor and full light reads ~ 1
/// on its activated chem.
const PHOTO_GAIN: f32 = 1.0;
/// Per-tick decay rate on the activated chem. Without this an
/// activation set in a previous tick would persist forever; with
/// it the activation tracks the stimulus on a roughly per-second
/// timescale.
const ACTIVATION_DECAY_PER_S: f32 = 4.0;

/// Run sensor activation for every cell. `ambient_light` is the
/// world's current light level (0..1).
pub fn run_activation(creatures: &mut CreatureStore, ambient_light: f32, dt: f32) {
    let n = creatures.n;
    if n == 0 {
        return;
    }
    let decay = (ACTIVATION_DECAY_PER_S * dt).min(1.0);
    let keep = 1.0 - decay;
    // Photoreceptor variants (visible / long-band / surface). For
    // now they all read the same ambient_light scalar; the TS
    // engine differentiates by depth band, which we'll wire when
    // the region grid lands.
    let bands = [
        (CHEM_PHOTORECEPTOR_VISIBLE, CHEM_ACT_PHOTO_VISIBLE),
        (CHEM_PHOTORECEPTOR_LONG, CHEM_ACT_PHOTO_LONG),
        (CHEM_PHOTORECEPTOR_SURFACE, CHEM_ACT_PHOTO_SURFACE),
    ];
    for (receptor_slot, act_slot) in bands {
        for i in 0..n {
            let receptor = creatures.chems[receptor_slot][i];
            // Decay last tick's activation toward zero, then add
            // this tick's stimulus contribution. The new value is
            // continuous in time.
            let prev = creatures.chems[act_slot][i] * keep;
            let stimulus = receptor * ambient_light * PHOTO_GAIN;
            creatures.chems[act_slot][i] = prev + stimulus * decay;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::NAMED_CHEMICAL_COUNT;
    use crate::creatures::CreatureInit;

    fn cell_with_receptor(receptor_chem: usize, amount: f32) -> CreatureStore {
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[receptor_chem] = amount;
        let mut s = CreatureStore::new();
        s.push(CreatureInit { r: 8.0, chems: Some(chems), ..CreatureInit::default() });
        s
    }

    #[test]
    fn no_receptor_no_activation() {
        let mut s = cell_with_receptor(CHEM_PHOTORECEPTOR_VISIBLE, 0.0);
        run_activation(&mut s, 1.0, 1.0);
        assert_eq!(s.chems[CHEM_ACT_PHOTO_VISIBLE][0], 0.0);
    }

    #[test]
    fn receptor_with_light_produces_activation() {
        let mut s = cell_with_receptor(CHEM_PHOTORECEPTOR_VISIBLE, 2.0);
        run_activation(&mut s, 0.5, 1.0);
        assert!(s.chems[CHEM_ACT_PHOTO_VISIBLE][0] > 0.0);
    }

    #[test]
    fn activation_decays_in_dark() {
        let mut s = cell_with_receptor(CHEM_PHOTORECEPTOR_VISIBLE, 2.0);
        // Charge it up.
        run_activation(&mut s, 1.0, 1.0);
        let charged = s.chems[CHEM_ACT_PHOTO_VISIBLE][0];
        assert!(charged > 0.0);
        // Run several ticks in the dark.
        for _ in 0..30 {
            run_activation(&mut s, 0.0, 1.0 / 60.0);
        }
        let after = s.chems[CHEM_ACT_PHOTO_VISIBLE][0];
        assert!(after < charged * 0.5, "activation should decay; got {after} vs {charged}");
    }

    #[test]
    fn no_cells_is_safe() {
        let mut s = CreatureStore::new();
        run_activation(&mut s, 1.0, 1.0);
        assert_eq!(s.len(), 0);
    }
}
