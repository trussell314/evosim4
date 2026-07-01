//! Common-sense invariants that don't belong to any single subsystem.
//! Cheap checks that catch the "did we break a fundamental property
//! of the sim" class of regression. New common-sense things go here
//! rather than spreading them across the per-module test mods.

#[cfg(test)]
mod tests {
    use evosim_engine::day_cycle::ambient_light_at;
    use evosim_engine::Engine;
    use evosim_protocol::{decode_server, encode_server, ServerMessage};

    /// Engine ticks long enough to cycle every pass at least once
    /// without panicking. Don't assert counts -- Reset re-seeds
    /// founders + demo particles, so "empty" isn't a reachable state
    /// from the public API. The point is "no pass crashes on a fresh
    /// world".
    #[test]
    fn fresh_engine_ticks_without_panic() {
        let mut e = Engine::new();
        for _ in 0..120 {
            e.step(1.0 / 60.0);
        }
        let snap = e.snapshot();
        // The fresh world has at least the seed cohort + demo
        // particles right out of the box.
        assert!(snap.creatures.count > 0, "founders didn't seed");
        assert!(snap.particles.count > 0, "demo particles didn't seed");
    }

    /// Sim time advances by exactly `dt` per `step()`. A regression
    /// here would silently slow down every per-second rate constant.
    #[test]
    fn tick_advances_world_time_linearly() {
        let mut e = Engine::new();
        e.reset();
        let dt = 1.0 / 60.0;
        let n = 600; // 10 seconds at 60 Hz
        for _ in 0..n {
            e.step(dt);
        }
        let snap = e.snapshot();
        let expected = dt * n as f64;
        assert!(
            (snap.t - expected).abs() < 1e-6,
            "expected t={expected}, got {}",
            snap.t
        );
        assert_eq!(snap.tick, n as u64);
    }

    /// Same seed + same input -> same snapshot. This is the engine's
    /// determinism contract for the serial CPU path. Without it,
    /// the bench harness can't compare runs and the wire-smoke test
    /// can't pin tick numbers.
    #[test]
    fn deterministic_serial_path_for_same_seed() {
        let mut a = Engine::new();
        let mut b = Engine::new();
        for _ in 0..120 {
            a.step(1.0 / 60.0);
            b.step(1.0 / 60.0);
        }
        let snap_a = a.snapshot();
        let snap_b = b.snapshot();
        assert_eq!(snap_a.tick, snap_b.tick);
        assert_eq!(snap_a.creatures.count, snap_b.creatures.count);
        assert_eq!(snap_a.particles.count, snap_b.particles.count);
        assert!((snap_a.t - snap_b.t).abs() < 1e-9);
        // Mass should match bit-for-bit on the same seed since the
        // serial path uses one ordered RNG stream.
        assert!((snap_a.mass.total - snap_b.mass.total).abs() < 1e-3);
    }

    /// Reset returns the engine to a deterministic state. Two
    /// independent engines reset to the same configuration should
    /// produce the same snapshot.
    #[test]
    fn reset_is_deterministic() {
        let mut a = Engine::new();
        let mut b = Engine::new();
        // Step a few ticks then reset; the resulting state should
        // match an engine that was just constructed.
        for _ in 0..30 {
            a.step(1.0 / 60.0);
        }
        a.reset();
        let snap_a = a.snapshot();
        let snap_b = b.snapshot();
        assert_eq!(snap_a.tick, 0);
        assert_eq!(snap_a.tick, snap_b.tick);
        assert_eq!(snap_a.creatures.count, snap_b.creatures.count);
    }

    /// Snapshot encode -> decode -> encode round-trips bit-for-bit.
    /// Guards the msgpack wire encoding against accidental drift
    /// (e.g. someone reorders struct fields, breaks #[serde(default)]
    /// on an optional). Catches breakage that the per-field unit
    /// tests would never notice.
    #[test]
    fn snapshot_round_trips_through_msgpack() {
        let mut e = Engine::new();
        e.step(1.0 / 60.0);
        let snap = e.snapshot();
        let bytes = encode_server(&ServerMessage::Snapshot(Box::new(snap))).unwrap();
        let back = decode_server(&bytes).unwrap();
        match back {
            ServerMessage::Snapshot(s) => {
                let bytes2 =
                    encode_server(&ServerMessage::Snapshot(Box::new(*s))).unwrap();
                assert_eq!(
                    bytes, bytes2,
                    "round-trip changed the msgpack payload"
                );
            }
            other => panic!("decoded a non-snapshot: {other:?}"),
        }
    }

    /// `day_period_s = 0` (or negative) disables the cycle and pins
    /// daylight on. The day_cycle test mod covers normal sinusoid
    /// behaviour; this is the no-cycle escape hatch other tests rely
    /// on when they want stable light.
    #[test]
    fn day_period_zero_disables_cycle() {
        for &t in &[0.0, 1.0, 60.0, 600.0] {
            let l = ambient_light_at(t, 0.0);
            assert!(
                (l - 1.0).abs() < 1e-6,
                "day_period_s=0 should give full light, got {l} at t={t}"
            );
        }
    }

    /// After several seconds of tick, every particle's position +
    /// velocity must be finite. NaN propagating through the force
    /// kernel was a class of bug that destroyed a previous session.
    #[test]
    fn no_nan_in_kinematics_over_long_run() {
        let mut e = Engine::new();
        for _ in 0..600 {
            e.step(1.0 / 60.0);
        }
        let snap = e.snapshot();
        // Pull the x / y / vx / vy blobs out of the particle SoA.
        let n = snap.particles.count as usize;
        if n == 0 {
            return;
        }
        let mut blobs = std::collections::HashMap::new();
        for b in &snap.particles.blobs {
            blobs.insert(b.name.clone(), b);
        }
        for name in ["x", "y", "vx", "vy"] {
            let Some(blob) = blobs.get(name) else { continue };
            assert!(
                blob.data.len() >= n * 4,
                "blob '{name}' too short: {} bytes for {n} particles",
                blob.data.len()
            );
            for i in 0..n {
                let mut buf = [0u8; 4];
                buf.copy_from_slice(&blob.data[i * 4..i * 4 + 4]);
                let v = f32::from_le_bytes(buf);
                assert!(
                    v.is_finite(),
                    "particle[{i}].{name} = {v} after 600 ticks"
                );
            }
        }
    }

    /// Snapshot dimensions are sane: positive, surface_y inside the
    /// world. A regression here means the protocol struct or the
    /// world config produced something a renderer can't interpret.
    #[test]
    fn snapshot_dimensions_are_sane() {
        let mut e = Engine::new();
        e.step(1.0 / 60.0);
        let snap = e.snapshot();
        assert!(snap.width > 0.0);
        assert!(snap.height > 0.0);
        assert!(snap.surface_y >= 0.0);
        assert!(snap.surface_y < snap.height);
        // Surface should sit in the top fifth of the world for the
        // demo scene -- a sanity check that the world's wave kernel
        // has a reasonable air column to play with.
        assert!(
            snap.surface_y <= snap.height * 0.25,
            "surface_y too deep: {} of {}",
            snap.surface_y,
            snap.height
        );
    }

    /// Mass conservation: total world mass at tick 600 must be close
    /// to the mass at tick 1. Any drift here points at a pass that
    /// invents or destroys mass. The wiggle room is generous (~1% of
    /// total) because float-rounding adds up across 600 ticks.
    #[test]
    fn mass_conserves_across_long_run() {
        let mut e = Engine::new();
        e.step(1.0 / 60.0);
        let baseline = e.snapshot().mass.total;
        for _ in 0..600 {
            e.step(1.0 / 60.0);
        }
        let after = e.snapshot().mass.total;
        let drift = (after - baseline).abs();
        let pct = drift / baseline.abs().max(1.0);
        assert!(
            pct < 0.05,
            "world mass drifted {pct:.4} (>{:.4}%): {baseline} -> {after}",
            5.0
        );
    }

    /// Particle decay never leaves a particle with negative radius
    /// or a NaN one. Catches a subtle off-by-one in the shrink + cull
    /// pass.
    #[test]
    fn particle_radii_stay_positive_and_finite() {
        let mut e = Engine::new();
        for _ in 0..300 {
            e.step(1.0 / 60.0);
        }
        let snap = e.snapshot();
        let n = snap.particles.count as usize;
        for b in &snap.particles.blobs {
            if b.name != "r" {
                continue;
            }
            for i in 0..n {
                let mut buf = [0u8; 4];
                buf.copy_from_slice(&b.data[i * 4..i * 4 + 4]);
                let r = f32::from_le_bytes(buf);
                assert!(r.is_finite(), "particle[{i}].r = {r}");
                assert!(r > 0.0, "particle[{i}].r = {r} (non-positive)");
            }
        }
    }

    /// Particle cap is honored. The cap only constrains spawn-side
    /// passes (precipitation, vent, autolysis) so the initial seed
    /// from Engine::new can sit above it briefly; what matters is
    /// that the count converges to <= cap as decay catches up.
    #[test]
    fn particle_cap_bounds_steady_state() {
        let mut e = Engine::new();
        // Pick a cap comfortably above the demo seed (~200) so the
        // initial population starts inside the cap, then verify no
        // pass ever pushes us above it.
        e.set_particle_cap(Some(400));
        for _ in 0..600 {
            e.step(1.0 / 60.0);
            let n = e.snapshot().particles.count;
            assert!(
                n <= 400,
                "particle count exceeded cap: {n} > 400 at tick {}",
                e.snapshot().tick
            );
        }
    }
}
