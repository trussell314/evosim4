//! Native evosim engine. Subsystems land here one at a time; today
//! the engine owns a real `World` with a ported particle store +
//! force kernel. Subsequent commits bring in the genome VM, region
//! passes, collision pass, and creature update.

#![forbid(unsafe_code)]

pub mod chem_ids;
pub mod chemistry;
pub mod forces;
pub mod genome_consts;
pub mod particles;
pub mod reactions;
pub mod rng;
pub mod world;

use evosim_protocol::{ForceSource, NamedBlob, Snapshot, Soa};

use crate::particles::ParticleInit;
use crate::world::World;

/// Default world size for a fresh engine. Matches the TS founder
/// default (`1600 x 1200`). The size becomes configurable when the
/// world-config / save-format port lands.
const DEFAULT_WIDTH: f32 = 1600.0;
const DEFAULT_HEIGHT: f32 = 1200.0;

/// Engine RNG seed for `Engine::new`. The world's `sim_rng` derives
/// from this; later commits make it configurable per session.
const DEFAULT_SEED: u32 = 0x1B57E5;

/// Owns the simulation state. Single-threaded today; rayon and wgpu
/// arrive as the kernels land.
pub struct Engine {
    tick: u64,
    world: World,
}

impl Engine {
    pub fn new() -> Self {
        let mut engine = Self {
            tick: 0,
            world: World::new(DEFAULT_WIDTH, DEFAULT_HEIGHT, DEFAULT_SEED),
        };
        engine.seed_demo_particles();
        engine
    }

    /// Spawn a handful of particles so a freshly-booted engine has
    /// something visible to ship to the client. Goes away once the
    /// region/atmosphere port lands and real spawn passes run.
    fn seed_demo_particles(&mut self) {
        // Light deterministic spread; reuses the world rng so seed
        // controls layout.
        let w = self.world.width;
        let h = self.world.height;
        for i in 0..200 {
            let x = self.world.sim_rng.next_f64() as f32 * w;
            let y = self.world.sim_rng.next_f64() as f32 * h;
            let chem_id = (i % 8) as u8;
            self.world.particle_store.push(ParticleInit {
                x,
                y,
                r: 2.5,
                chem_id,
                ..ParticleInit::default()
            });
        }
    }

    /// Advance the simulation by one tick. Today this is just the
    /// force pass + clock; chemistry / creatures / regions arrive in
    /// later commits.
    pub fn step(&mut self, dt: f64) {
        self.tick += 1;
        self.world.t += dt;
        forces::apply_forces(&mut self.world, dt as f32);
    }

    /// Reset to defaults. Called by `AdminCommand::Reset`.
    pub fn reset(&mut self) {
        self.tick = 0;
        self.world = World::new(DEFAULT_WIDTH, DEFAULT_HEIGHT, DEFAULT_SEED);
        self.seed_demo_particles();
    }

    /// Pack the current state into a snapshot for broadcast. Particle
    /// SoA blobs carry the live store columns as packed bytes; the
    /// client decodes them as TypedArrays of the declared stride.
    pub fn snapshot(&self) -> Snapshot {
        let particles = pack_particle_soa(&self.world.particle_store);
        Snapshot {
            tick: self.tick,
            t: self.world.t,
            width: self.world.width,
            height: self.world.height,
            particles,
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

fn pack_particle_soa(store: &particles::ParticleStore) -> Soa {
    // One blob per column; the client renderer port maps these to
    // Float32Array / Uint8Array views by stride. Names match the TS
    // ParticleSharedLayout offsets so it can be a drop-in.
    let n = store.len() as u32;
    let blob_f32 = |name: &str, data: &[f32]| NamedBlob {
        name: name.into(),
        stride: 4,
        data: bytemuck_f32(data),
    };
    let blob_u8 = |name: &str, data: &[u8]| NamedBlob {
        name: name.into(),
        stride: 1,
        data: data.to_vec(),
    };
    Soa {
        count: n,
        blobs: vec![
            blob_f32("x", &store.x),
            blob_f32("y", &store.y),
            blob_f32("z", &store.z),
            blob_f32("vx", &store.vx),
            blob_f32("vy", &store.vy),
            blob_f32("vz", &store.vz),
            blob_f32("r", &store.r),
            blob_f32("density", &store.density),
            blob_u8("chemId", &store.chem_id),
        ],
    }
}

/// Reinterpret a `&[f32]` as a `Vec<u8>` in native-endian (= little
/// on every target client we care about). Avoids pulling in the
/// `bytemuck` crate for one call site; matches the TS Float32Array
/// underlying-buffer layout exactly.
fn bytemuck_f32(data: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() * 4);
    for &v in data {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

fn empty_creature_blobs() -> Vec<NamedBlob> {
    ["x", "y", "r", "mass", "energy"]
        .into_iter()
        .map(|name| NamedBlob {
            name: name.into(),
            stride: 4,
            data: Vec::new(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_engine_has_demo_particles() {
        let e = Engine::new();
        let snap = e.snapshot();
        assert_eq!(snap.particles.count, 200);
        let x_blob = snap.particles.blobs.iter().find(|b| b.name == "x").unwrap();
        assert_eq!(x_blob.data.len(), 200 * 4);
    }

    #[test]
    fn step_advances_clock_and_runs_kernel() {
        let mut e = Engine::new();
        // Capture y0 before stepping.
        let snap0 = e.snapshot();
        let y_blob_0 = snap0.particles.blobs.iter().find(|b| b.name == "y").unwrap();
        let y_first_0 = f32::from_le_bytes(y_blob_0.data[0..4].try_into().unwrap());

        for _ in 0..30 {
            e.step(1.0 / 60.0);
        }
        let snap = e.snapshot();
        assert_eq!(snap.tick, 30);
        // Force kernel should have moved particles. The first slot
        // should not still have exactly its initial y.
        let y_blob = snap.particles.blobs.iter().find(|b| b.name == "y").unwrap();
        let y_first = f32::from_le_bytes(y_blob.data[0..4].try_into().unwrap());
        assert!(
            (y_first - y_first_0).abs() > 1e-6,
            "particles should have moved over 30 ticks"
        );
    }

    #[test]
    fn reset_returns_to_clean_state() {
        let mut e = Engine::new();
        for _ in 0..60 {
            e.step(1.0 / 60.0);
        }
        e.reset();
        let snap = e.snapshot();
        assert_eq!(snap.tick, 0);
        assert_eq!(snap.t, 0.0);
        assert_eq!(snap.particles.count, 200);
    }
}
