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

use crate::ambient::AmbientField;
use crate::chem_ids::{
    CHEM_ACT_ELECTRO_X, CHEM_ACT_ELECTRO_Y, CHEM_ACT_MAG_X, CHEM_ACT_MAG_Y, CHEM_ACT_PH,
    CHEM_ACT_PHOTO_LONG, CHEM_ACT_PHOTO_SURFACE, CHEM_ACT_PHOTO_VISIBLE,
    CHEM_ACT_VIB_X, CHEM_ACT_VIB_Y, CHEM_ATP, CHEM_CO2, CHEM_ELECTRORECEPTOR,
    CHEM_MAGNETORECEPTOR, CHEM_PHOTORECEPTOR_LONG, CHEM_PHOTORECEPTOR_SURFACE,
    CHEM_PHOTORECEPTOR_VISIBLE, CHEM_PHRECEPTOR, CHEM_VIBRORECEPTOR,
};
use crate::creatures::CreatureStore;
use crate::particles::ParticleStore;

/// Per-receptor gain. Output = receptor_pool * stimulus * gain.
/// Tuned so a cell carrying ~1 receptor and full light reads ~ 1
/// on its activated chem.
const PHOTO_GAIN: f32 = 1.0;
/// Per-tick decay rate on the activated chem. Without this an
/// activation set in a previous tick would persist forever; with
/// it the activation tracks the stimulus on a roughly per-second
/// timescale.
const ACTIVATION_DECAY_PER_S: f32 = 4.0;

/// Range over which an electroreceptor "feels" other cells' ATP.
const ELECTRO_RANGE: f32 = 100.0;
/// Per-unit gain on the electro signal.
const ELECTRO_GAIN: f32 = 0.001;
/// Range over which a vibroreceptor "feels" particle motion.
const VIB_RANGE: f32 = 120.0;
/// Per-unit gain on the vibration signal.
const VIB_GAIN: f32 = 0.05;
/// Per-unit gain on the pH signal. pH is a scalar (acidity feels
/// like a magnitude, not a direction), driven by both the cell's
/// own CO2 pool and the ambient CO2 stock.
const PH_GAIN: f32 = 0.05;
/// World magnetic-field direction (unit vector). +y is "north" by
/// convention. A magnetoreceptor cell reads this scaled by its
/// receptor pool size. The field is uniform world-wide (no
/// gradient yet) but a cell can evolve to thrust along the
/// returned direction -- a compass.
const MAG_FIELD_X: f32 = 0.0;
const MAG_FIELD_Y: f32 = 1.0;
const MAG_GAIN: f32 = 1.0;

/// Run sensor activation for every cell. `ambient_light` is the
/// world's current light level (0..1). `particles` is the world's
/// particle store (vibration sensing reads it for motion).
/// `ambient` provides the world-wide dissolved-chem stocks (pH
/// sensing reads CO2 from it).
pub fn run_activation(
    creatures: &mut CreatureStore,
    particles: &ParticleStore,
    ambient: &AmbientField,
    ambient_light: f32,
    dt: f32,
) {
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
    #[allow(clippy::needless_range_loop)]
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

    // Electric: directional. For each electroreceptor-carrying
    // cell, sum the ATP of nearby cells weighted by 1/dsq and
    // direction. Result lands in (CHEM_ACT_ELECTRO_X,
    // CHEM_ACT_ELECTRO_Y) so SENSE_CHEMICAL on either reads the
    // x or y component of the local "metabolism gradient." O(N^2)
    // for now; spatial bins arrive later.
    if n >= 2 {
        let range_sq = ELECTRO_RANGE * ELECTRO_RANGE;
        for i in 0..n {
            let receptor = creatures.chems[CHEM_ELECTRORECEPTOR][i];
            // Decay both axes regardless of whether we add new
            // signal -- keeps the continuous-in-time semantics.
            creatures.chems[CHEM_ACT_ELECTRO_X][i] *= keep;
            creatures.chems[CHEM_ACT_ELECTRO_Y][i] *= keep;
            if receptor <= 0.0 {
                continue;
            }
            let cx = creatures.x[i];
            let cy = creatures.y[i];
            let mut sx = 0.0_f32;
            let mut sy = 0.0_f32;
            for j in 0..n {
                if j == i {
                    continue;
                }
                let dx = creatures.x[j] - cx;
                let dy = creatures.y[j] - cy;
                let dsq = dx * dx + dy * dy;
                if dsq < 1.0 || dsq >= range_sq {
                    continue;
                }
                let atp = creatures.chems[CHEM_ATP][j];
                if atp <= 0.0 {
                    continue;
                }
                // 1/dsq weighting times the direction unit vector
                // multiplied by ATP gives a per-axis signed signal
                // that points TOWARD the nearby cell with strength
                // proportional to its metabolism.
                let d = dsq.sqrt();
                let nx = dx / d;
                let ny = dy / d;
                let w = atp / dsq;
                sx += nx * w;
                sy += ny * w;
            }
            let gain = receptor * ELECTRO_GAIN;
            creatures.chems[CHEM_ACT_ELECTRO_X][i] += sx * gain * decay;
            creatures.chems[CHEM_ACT_ELECTRO_Y][i] += sy * gain * decay;
        }
    }

    // Vibration: cells with vibroreceptors sense moving particles
    // in range. The signal points TOWARD each contributing particle
    // weighted by particle speed (vx^2+vy^2) / dsq. Fast distant
    // particles and slow nearby ones both contribute; the cell
    // tells direction but not what kind of particle.
    let np = particles.len();
    if n >= 1 && np > 0 {
        let vib_range_sq = VIB_RANGE * VIB_RANGE;
        for i in 0..n {
            let receptor = creatures.chems[CHEM_VIBRORECEPTOR][i];
            // Decay axes regardless of contribution.
            creatures.chems[CHEM_ACT_VIB_X][i] *= keep;
            creatures.chems[CHEM_ACT_VIB_Y][i] *= keep;
            if receptor <= 0.0 {
                continue;
            }
            let cx = creatures.x[i];
            let cy = creatures.y[i];
            let mut sx = 0.0_f32;
            let mut sy = 0.0_f32;
            for p in 0..np {
                let dx = particles.x[p] - cx;
                let dy = particles.y[p] - cy;
                let dsq = dx * dx + dy * dy;
                if dsq < 1.0 || dsq >= vib_range_sq {
                    continue;
                }
                let vx = particles.vx[p];
                let vy = particles.vy[p];
                let speed_sq = vx * vx + vy * vy;
                if speed_sq < 0.01 {
                    continue;
                }
                let d = dsq.sqrt();
                let nx = dx / d;
                let ny = dy / d;
                let w = speed_sq / dsq;
                sx += nx * w;
                sy += ny * w;
            }
            let gain = receptor * VIB_GAIN;
            creatures.chems[CHEM_ACT_VIB_X][i] += sx * gain * decay;
            creatures.chems[CHEM_ACT_VIB_Y][i] += sy * gain * decay;
        }
    }

    // pH: scalar acidity. Driven by the cell's own CO2 pool plus
    // the world-wide ambient CO2 stock; a cell sitting in dissolved
    // CO2 from autolysis or its own respiration feels the rising
    // acidity. Useful as a "crowding" signal -- a metabolically
    // active region emits CO2.
    let ambient_co2 = ambient
        .stock
        .get(CHEM_CO2)
        .copied()
        .unwrap_or(0.0);
    for i in 0..n {
        let receptor = creatures.chems[CHEM_PHRECEPTOR][i];
        let prev = creatures.chems[CHEM_ACT_PH][i] * keep;
        if receptor <= 0.0 {
            creatures.chems[CHEM_ACT_PH][i] = prev;
            continue;
        }
        let local_co2 = creatures.chems[CHEM_CO2][i];
        let stimulus = (local_co2 + ambient_co2 * 0.1) * receptor * PH_GAIN;
        creatures.chems[CHEM_ACT_PH][i] = prev + stimulus * decay;
    }

    // Magnetic: directional, uniform world-wide. A
    // magnetoreceptor-carrying cell reads the magnetic field unit
    // vector scaled by receptor_pool * MAG_GAIN. SENSE_CHEMICAL on
    // CHEM_ACT_MAG_X / CHEM_ACT_MAG_Y returns the projection.
    // Lets cells evolve a compass: e.g. seek_north genome reads
    // CHEM_ACT_MAG_Y and thrusts +y in proportion.
    for i in 0..n {
        let receptor = creatures.chems[CHEM_MAGNETORECEPTOR][i];
        creatures.chems[CHEM_ACT_MAG_X][i] *= keep;
        creatures.chems[CHEM_ACT_MAG_Y][i] *= keep;
        if receptor <= 0.0 {
            continue;
        }
        let gain = receptor * MAG_GAIN;
        creatures.chems[CHEM_ACT_MAG_X][i] += MAG_FIELD_X * gain * decay;
        creatures.chems[CHEM_ACT_MAG_Y][i] += MAG_FIELD_Y * gain * decay;
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
        run_activation(&mut s, &ParticleStore::new(), &AmbientField::new(), 1.0, 1.0);
        assert_eq!(s.chems[CHEM_ACT_PHOTO_VISIBLE][0], 0.0);
    }

    #[test]
    fn receptor_with_light_produces_activation() {
        let mut s = cell_with_receptor(CHEM_PHOTORECEPTOR_VISIBLE, 2.0);
        run_activation(&mut s, &ParticleStore::new(), &AmbientField::new(), 0.5, 1.0);
        assert!(s.chems[CHEM_ACT_PHOTO_VISIBLE][0] > 0.0);
    }

    #[test]
    fn activation_decays_in_dark() {
        let mut s = cell_with_receptor(CHEM_PHOTORECEPTOR_VISIBLE, 2.0);
        // Charge it up.
        run_activation(&mut s, &ParticleStore::new(), &AmbientField::new(), 1.0, 1.0);
        let charged = s.chems[CHEM_ACT_PHOTO_VISIBLE][0];
        assert!(charged > 0.0);
        // Run several ticks in the dark.
        for _ in 0..30 {
            run_activation(&mut s, &ParticleStore::new(), &AmbientField::new(), 0.0, 1.0 / 60.0);
        }
        let after = s.chems[CHEM_ACT_PHOTO_VISIBLE][0];
        assert!(after < charged * 0.5, "activation should decay; got {after} vs {charged}");
    }

    #[test]
    fn no_cells_is_safe() {
        let mut s = CreatureStore::new();
        run_activation(&mut s, &ParticleStore::new(), &AmbientField::new(), 1.0, 1.0);
        assert_eq!(s.len(), 0);
    }

    #[test]
    fn magnetoreceptor_reads_compass() {
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[CHEM_MAGNETORECEPTOR] = 1.0;
        let mut s = CreatureStore::new();
        s.push(CreatureInit { r: 8.0, chems: Some(chems), ..CreatureInit::default() });
        for _ in 0..30 {
            run_activation(&mut s, &ParticleStore::new(), &AmbientField::new(), 0.0, 1.0 / 60.0);
        }
        let my = s.chems[CHEM_ACT_MAG_Y][0];
        let mx = s.chems[CHEM_ACT_MAG_X][0];
        assert!(my > 0.0, "expected +y compass, got {my}");
        assert!(mx.abs() < 1e-3, "expected ~0 x component, got {mx}");
    }

    #[test]
    fn phreceptor_responds_to_co2() {
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[CHEM_PHRECEPTOR] = 1.0;
        chems[CHEM_CO2] = 5.0;
        let mut s = CreatureStore::new();
        s.push(CreatureInit { r: 8.0, chems: Some(chems), ..CreatureInit::default() });
        for _ in 0..20 {
            run_activation(&mut s, &ParticleStore::new(), &AmbientField::new(), 0.0, 1.0 / 60.0);
        }
        let ph = s.chems[CHEM_ACT_PH][0];
        assert!(ph > 0.0, "expected ph activation, got {ph}");
    }

    #[test]
    fn electroreceptor_senses_nearby_atp_source() {
        // Cell 0 has an electroreceptor; cell 1 has lots of ATP and
        // is to the +x. Cell 0's CHEM_ACT_ELECTRO_X should rise.
        let mut a_chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        a_chems[CHEM_ELECTRORECEPTOR] = 1.0;
        let mut b_chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        b_chems[CHEM_ATP] = 100.0;
        let mut s = CreatureStore::new();
        s.push(CreatureInit { x: 0.0, y: 0.0, r: 8.0, chems: Some(a_chems), ..CreatureInit::default() });
        s.push(CreatureInit { x: 30.0, y: 0.0, r: 8.0, chems: Some(b_chems), ..CreatureInit::default() });
        // Charge the signal.
        for _ in 0..20 {
            run_activation(&mut s, &ParticleStore::new(), &AmbientField::new(), 0.0, 1.0 / 60.0);
        }
        let sx = s.chems[CHEM_ACT_ELECTRO_X][0];
        assert!(sx > 0.0, "expected +x electro signal, got {sx}");
    }
}
