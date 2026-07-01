//! Per-tick performance metrics.
//!
//! `PerfCollector` wraps an `Instant` start + an enum-keyed bucket so
//! the step loop can mark "this pass ran for X ms" without manual
//! arithmetic at every call site. The collector exposes an EMA-smoothed
//! report (`perf_report()`) that the snapshot ships every tick.
//!
//! EMA alpha is tunable but a low default (0.1) is the sweet spot:
//! fast enough to track real load changes within a few seconds, slow
//! enough that a single GC-induced spike doesn't dominate the
//! displayed number.
//!
//! Cheap: a `Pass` measurement is one `Instant::now` + one subtract +
//! one float add against a small fixed-size array. Total per-tick
//! overhead is a few µs even with 20 passes instrumented -- well
//! below the threshold where it would distort what it's measuring.

use evosim_protocol::PerfReport;
use std::time::Instant;

/// Identifies a single engine pass. The order here doesn't matter --
/// the report just reads each bucket into the matching protocol field.
#[derive(Debug, Clone, Copy)]
pub enum Pass {
    Forces,
    Collision,
    ParticleDecay,
    Vm,
    CreatureCollision,
    ObstacleCollision,
    CellReactions,
    Transport,
    Ambient,
    Diffuse,
    Precipitation,
    RegionTemp,
    Vent,
    Predate,
    Ingest,
    Reproduction,
    Death,
    Maintenance,
    Bonding,
    Activation,
    Snapshot,
}

const PASS_COUNT: usize = 21;

/// EMA smoothing factor. New sample contributes `EMA_ALPHA`; the
/// running average keeps `1 - EMA_ALPHA` of the previous value.
const EMA_ALPHA: f32 = 0.1;

/// Per-pass timing accumulator + tick-total + live counts.
#[derive(Debug, Default)]
pub struct PerfCollector {
    /// EMA of the last N ticks, indexed by `Pass as usize`.
    ema_ms: [f32; PASS_COUNT],
    /// EMA of the total tick wall time.
    tick_ms: f32,
    /// Most recent particle / creature counts (single sample, not EMA --
    /// these are read directly from the stores at snapshot time).
    particle_count: u32,
    creature_count: u32,
    /// Scratch for the current tick. Reset at the top of every step.
    current_ms: [f32; PASS_COUNT],
    tick_start: Option<Instant>,
}

impl PerfCollector {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mark the start of a tick. Resets the per-pass scratch so the
    /// measurement loop accumulates only the current tick's work.
    pub fn tick_start(&mut self) {
        self.current_ms.fill(0.0);
        self.tick_start = Some(Instant::now());
    }

    /// Time `f` and credit its wall-clock to `pass`. The closure runs
    /// inline so it has the same access to surrounding state as the
    /// original call. Use this when the closure doesn't need to borrow
    /// anything else mutably; otherwise pair `Instant::now()` with
    /// [`add_since`].
    #[inline]
    pub fn measure<R>(&mut self, pass: Pass, f: impl FnOnce() -> R) -> R {
        let start = Instant::now();
        let out = f();
        let dt = start.elapsed().as_secs_f32() * 1000.0;
        self.current_ms[pass as usize] += dt;
        out
    }

    /// Credit the elapsed time since `start` to `pass`. Use when the
    /// scope can't be wrapped in a closure (e.g. the closure would
    /// have to mutably borrow other engine state in the same scope
    /// as the collector). Pattern:
    /// ```ignore
    /// let t = Instant::now();
    /// forces::apply_forces(&mut self.world, dt);
    /// self.perf.add_since(Pass::Forces, t);
    /// ```
    #[inline]
    pub fn add_since(&mut self, pass: Pass, start: Instant) {
        let dt = start.elapsed().as_secs_f32() * 1000.0;
        self.current_ms[pass as usize] += dt;
    }

    /// Mark the end of a tick. Folds the just-collected per-pass values
    /// into the EMA so the next `perf_report()` reflects them.
    pub fn tick_end(&mut self) {
        let total = match self.tick_start.take() {
            Some(s) => s.elapsed().as_secs_f32() * 1000.0,
            None => 0.0,
        };
        // EMA the per-pass values + the total.
        for i in 0..PASS_COUNT {
            self.ema_ms[i] = ema(self.ema_ms[i], self.current_ms[i]);
        }
        self.tick_ms = ema(self.tick_ms, total);
    }

    /// Record live counts. Cheap, called at snapshot time only.
    pub fn set_counts(&mut self, particles: u32, creatures: u32) {
        self.particle_count = particles;
        self.creature_count = creatures;
    }

    /// Render the current EMA into a protocol-side report. Cheap;
    /// each call is just a small struct allocation.
    pub fn report(&self) -> PerfReport {
        PerfReport {
            tick_ms: self.tick_ms,
            forces_ms: self.ema_ms[Pass::Forces as usize],
            collision_ms: self.ema_ms[Pass::Collision as usize],
            particle_decay_ms: self.ema_ms[Pass::ParticleDecay as usize],
            vm_ms: self.ema_ms[Pass::Vm as usize],
            creature_collision_ms: self.ema_ms[Pass::CreatureCollision as usize],
            obstacle_collision_ms: self.ema_ms[Pass::ObstacleCollision as usize],
            cell_reactions_ms: self.ema_ms[Pass::CellReactions as usize],
            transport_ms: self.ema_ms[Pass::Transport as usize],
            ambient_ms: self.ema_ms[Pass::Ambient as usize],
            diffuse_ms: self.ema_ms[Pass::Diffuse as usize],
            precipitation_ms: self.ema_ms[Pass::Precipitation as usize],
            region_temp_ms: self.ema_ms[Pass::RegionTemp as usize],
            vent_ms: self.ema_ms[Pass::Vent as usize],
            predate_ms: self.ema_ms[Pass::Predate as usize],
            ingest_ms: self.ema_ms[Pass::Ingest as usize],
            reproduction_ms: self.ema_ms[Pass::Reproduction as usize],
            death_ms: self.ema_ms[Pass::Death as usize],
            maintenance_ms: self.ema_ms[Pass::Maintenance as usize],
            bonding_ms: self.ema_ms[Pass::Bonding as usize],
            activation_ms: self.ema_ms[Pass::Activation as usize],
            snapshot_ms: self.ema_ms[Pass::Snapshot as usize],
            particle_count: self.particle_count,
            creature_count: self.creature_count,
        }
    }
}

fn ema(prev: f32, sample: f32) -> f32 {
    if prev == 0.0 {
        // First sample: jump straight to it so the report isn't all
        // zeros for the first ~50 ticks (which is roughly how long
        // 0.1 alpha takes to converge from cold).
        sample
    } else {
        prev * (1.0 - EMA_ALPHA) + sample * EMA_ALPHA
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;
    use std::time::Duration;

    #[test]
    fn measure_credits_wall_time() {
        let mut c = PerfCollector::new();
        c.tick_start();
        c.measure(Pass::Forces, || {
            sleep(Duration::from_millis(2));
        });
        c.tick_end();
        let r = c.report();
        // Some wall time was recorded; cannot pin exact (timing noise).
        assert!(r.forces_ms > 0.5);
        assert!(r.tick_ms > 0.5);
    }

    #[test]
    fn ema_smooths_spikes() {
        let mut c = PerfCollector::new();
        // First tick: ~5 ms total.
        c.tick_start();
        c.measure(Pass::Forces, || sleep(Duration::from_millis(5)));
        c.tick_end();
        let r1 = c.report();
        // Second tick: instant.
        c.tick_start();
        c.measure(Pass::Forces, || {});
        c.tick_end();
        let r2 = c.report();
        // EMA falls but not to zero (smoothing).
        assert!(r2.forces_ms < r1.forces_ms);
        assert!(r2.forces_ms > 0.0);
    }

    #[test]
    fn counts_set_and_read() {
        let mut c = PerfCollector::new();
        c.set_counts(123, 45);
        let r = c.report();
        assert_eq!(r.particle_count, 123);
        assert_eq!(r.creature_count, 45);
    }
}
