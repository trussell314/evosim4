//! Placeholder for the ported sim engine. Today this just produces
//! empty snapshots on demand so the server can be exercised end-to-end
//! before the real port lands. Subsequent commits replace the body of
//! [`Engine`] with the ported chemistry / VM / particle / creature
//! systems, one subsystem at a time, with parity tests against the TS
//! implementation's golden snapshots.

#![forbid(unsafe_code)]

pub mod chem_ids;
pub mod rng;

use evosim_protocol::{ForceSource, NamedBlob, Snapshot, Soa};

/// Owns the simulation state. Single-threaded today, will host the
/// rayon thread pool and the wgpu device once the real port begins.
pub struct Engine {
    tick: u64,
    t: f64,
    width: f32,
    height: f32,
}

impl Engine {
    pub fn new() -> Self {
        Self { tick: 0, t: 0.0, width: 1920.0, height: 1080.0 }
    }

    /// Advance the simulation by one wall-clock-driven tick. Today
    /// this is a no-op other than bumping the clock; the ported step
    /// function will land here.
    pub fn step(&mut self, dt: f64) {
        self.tick += 1;
        self.t += dt;
    }

    /// Reset state to defaults. Called by `AdminCommand::Reset`.
    pub fn reset(&mut self) {
        self.tick = 0;
        self.t = 0.0;
    }

    /// Take a snapshot for broadcast. Empty SoA blobs today; the
    /// shape is stable so the client renderer can be written against
    /// it now.
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            tick: self.tick,
            t: self.t,
            width: self.width,
            height: self.height,
            particles: Soa { count: 0, blobs: empty_particle_blobs() },
            creatures: Soa { count: 0, blobs: empty_creature_blobs() },
            force_source: ForceSource::Serial,
            cpu_pool_workers: 0,
            gpu_last_ms: 0.0,
        }
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

fn empty_particle_blobs() -> Vec<NamedBlob> {
    // Column names match the TS ParticleSharedLayout offsets so the
    // client renderer port doesn't have to learn new keys. Empty
    // payloads today; the real snapshot will copy from the SoA store.
    ["x", "y", "z", "vx", "vy", "vz", "r", "density"]
        .into_iter()
        .map(|name| NamedBlob { name: name.into(), stride: 4, data: Vec::new() })
        .chain(std::iter::once(NamedBlob {
            name: "chemId".into(),
            stride: 1,
            data: Vec::new(),
        }))
        .collect()
}

fn empty_creature_blobs() -> Vec<NamedBlob> {
    ["x", "y", "r", "mass", "energy"]
        .into_iter()
        .map(|name| NamedBlob { name: name.into(), stride: 4, data: Vec::new() })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_is_stable_before_step() {
        let e = Engine::new();
        let snap = e.snapshot();
        assert_eq!(snap.tick, 0);
        assert_eq!(snap.t, 0.0);
        assert!(snap.particles.blobs.iter().any(|b| b.name == "x"));
    }

    #[test]
    fn step_advances_clock() {
        let mut e = Engine::new();
        e.step(0.1);
        e.step(0.1);
        assert_eq!(e.snapshot().tick, 2);
        assert!((e.snapshot().t - 0.2).abs() < 1e-9);
    }
}
