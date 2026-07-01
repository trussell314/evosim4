//! Day / night cycle. A simple sinusoid over `world.t` driving the
//! ambient-light scalar between zero and one. The TS engine has a
//! richer environment (depth attenuation, weather, occlusion from
//! cells above) but those build on this primitive. Day length is in
//! sim-seconds; the default matches the TS founder.

use std::f64::consts::TAU;

/// Default sim-second period for one full day/night cycle. Was 60 s
/// (30 s daylight / 30 s night), which strobed too fast in the live
/// demo -- most observers caught the dark half and never saw the
/// sun. 300 s (5 min real time) is long enough that you see
/// photosynth fire before night returns, and short enough to step
/// through several cycles in a session.
pub const DEFAULT_DAY_PERIOD_S: f64 = 300.0;

/// Sample ambient light at sim-time `t` for the given day period.
/// Output in `[0.0, 1.0]`. Peak at noon (period * 0.5), zero before
/// dawn and after dusk.
pub fn ambient_light_at(t: f64, day_period_s: f64) -> f32 {
    if day_period_s <= 0.0 {
        return 1.0;
    }
    // Project t onto a 0..1 phase, then take sin over [0, π] for the
    // daylight half and clamp the night half to zero. Smoother than a
    // saw + clamp; matches the rough TS shape.
    let phase = (t / day_period_s).rem_euclid(1.0);
    if !(0.0..0.5).contains(&phase) {
        return 0.0;
    }
    // phase 0..0.5 -> sin(π * 2 * phase) so peak is at phase 0.25
    // (= 25% through the cycle), which we treat as "noon".
    ((TAU * 0.5 * (phase * 2.0)).sin() as f32).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-5
    }

    #[test]
    fn dawn_is_zero() {
        assert!(approx(ambient_light_at(0.0, 60.0), 0.0));
    }

    #[test]
    fn noon_is_one() {
        // Noon = 25% through the period.
        assert!(approx(ambient_light_at(15.0, 60.0), 1.0));
    }

    #[test]
    fn dusk_is_zero() {
        // 50% through the period.
        assert!(approx(ambient_light_at(30.0, 60.0), 0.0));
    }

    #[test]
    fn midnight_is_zero() {
        // 75% through -- well into night.
        assert!(approx(ambient_light_at(45.0, 60.0), 0.0));
    }

    #[test]
    fn cycle_repeats() {
        let a = ambient_light_at(15.0, 60.0);
        let b = ambient_light_at(75.0, 60.0);
        assert!(approx(a, b));
    }

    #[test]
    fn zero_period_means_constant_daylight() {
        assert_eq!(ambient_light_at(0.0, 0.0), 1.0);
        assert_eq!(ambient_light_at(100.0, 0.0), 1.0);
    }
}
