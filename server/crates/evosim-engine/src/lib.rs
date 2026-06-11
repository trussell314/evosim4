//! Native evosim engine. Subsystems land here one at a time; today
//! the engine owns a real `World` with a ported particle store +
//! force kernel. Subsequent commits bring in the genome VM, region
//! passes, collision pass, and creature update.

#![forbid(unsafe_code)]

pub mod cell_reactions;
pub mod chem_ids;
pub mod chemistry;
pub mod collision;
pub mod creature_update;
pub mod creatures;
pub mod forces;
pub mod genome;
pub mod genome_consts;
pub mod particles;
pub mod reactions;
pub mod rng;
pub mod save;
pub mod sensor_bins;
pub mod vm;
pub mod world;

use evosim_protocol::{ForceSource, NamedBlob, Snapshot, Soa};

use crate::chem_ids::{CHEM_ATP, NAMED_CHEMICAL_COUNT};
use crate::creatures::{CreatureInit, CreatureStore};
use crate::genome::*;
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
    collision_scratch: collision::CollisionScratch,
    sensor_bins: sensor_bins::SensorBins,
}

impl Engine {
    pub fn new() -> Self {
        let mut engine = Self {
            tick: 0,
            world: World::new(DEFAULT_WIDTH, DEFAULT_HEIGHT, DEFAULT_SEED),
            collision_scratch: collision::CollisionScratch::new(),
            sensor_bins: sensor_bins::SensorBins::new(),
        };
        engine.seed_demo_particles();
        engine.seed_demo_creatures();
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

    /// Spawn a small demo population of creatures so the snapshot
    /// has visible cells before the founder / spawn pass lands. Each
    /// cell runs a different short genome (swimmer / turner / synth),
    /// two of each, spread across the world.
    fn seed_demo_creatures(&mut self) {
        use crate::chem_ids::{CHEM_GLU, CHEM_O2, CHEM_ADP, CHEM_CHL, CHEM_CO2, CHEM_MRNA};
        let w = self.world.width;
        let h = self.world.height;
        let starter_chems = || {
            let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
            chems[CHEM_ATP] = 50.0;
            chems
        };
        // A "respirator": comes equipped with glucose + O2 + ADP so
        // the aerobic respiration slot (RX_SLOT_RESPIRATION) actually
        // fires once cell_reactions ticks. Without ADP no exergonic
        // slot can phosphorylate, so include some.
        let metabolizer_chems = || {
            let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
            chems[CHEM_ATP] = 20.0;
            chems[CHEM_GLU] = 80.0;
            chems[CHEM_O2] = 80.0;
            chems[CHEM_ADP] = 40.0;
            chems
        };
        // A "photoautotroph": carries chlorophyll + mRNA + CO2 + ADP
        // so photosynth (slot 3) + photophosphorylation (slot 25)
        // fire once cell_reactions ticks under ambient light.
        let photo_chems = || {
            let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
            chems[CHEM_ATP] = 20.0;
            chems[CHEM_CO2] = 80.0;
            chems[CHEM_ADP] = 40.0;
            chems[CHEM_CHL] = 4.0;  // 2x CHL_REF: full chl machinery
            chems[CHEM_MRNA] = 5.0; // full MRNA_REF
            chems
        };

        let swimmer = vec![OP_GENE, OP_PUSH8, 0, OP_PUSH8, 6, OP_THRUST, OP_END];
        let metabolizer = vec![OP_GENE, OP_NOP, OP_END];
        let photo = vec![OP_GENE, OP_NOP, OP_END];
        // A real seeker: pushes the spatial gradient of glucose
        // (CHEM_GLU = 2) onto the stack, then THRUST swims up it.
        // Genome: GENE SENSE_OUT 2 THRUST END
        let seeker = vec![OP_GENE, OP_SENSE_OUT, 2, OP_THRUST, OP_END];

        struct Seed {
            genome: Vec<u8>,
            chems: Vec<f32>,
        }
        let seeds = [
            Seed { genome: swimmer, chems: starter_chems() },
            Seed { genome: metabolizer, chems: metabolizer_chems() },
            Seed { genome: photo, chems: photo_chems() },
            Seed { genome: seeker, chems: starter_chems() },
        ];
        let mut idx = 0u32;
        for seed in &seeds {
            for j in 0..2 {
                let x = (0.25 + 0.5 * (j as f32)) * w;
                let y = ((idx as f32 + 1.0) / (seeds.len() as f32 + 2.0)) * h;
                self.world.creature_store.push(CreatureInit {
                    x,
                    y,
                    r: 8.0,
                    genome: seed.genome.clone(),
                    chems: Some(seed.chems.clone()),
                    ..CreatureInit::default()
                });
                idx += 1;
            }
        }
    }

    /// Advance the simulation by one tick. Force / collision pass on
    /// particles, then the VM / movement pass on creatures.
    pub fn step(&mut self, dt: f64) {
        self.tick += 1;
        self.world.t += dt;
        forces::apply_forces(&mut self.world, dt as f32);
        collision::resolve_collisions(&mut self.world, &mut self.collision_scratch);
        // Rebuild spatial bins from the post-physics particle field;
        // creatures see the current frame's particle layout when
        // their VM runs.
        self.sensor_bins.rebuild(
            &self.world.particle_store,
            self.world.width,
            self.world.height,
        );
        let ctx = creature_update::UpdateCtx {
            t: self.world.t,
            width: self.world.width,
            height: self.world.height,
            // Flat ambient until the region/atmosphere port. 0.5 lets
            // a chl-bearing cell run photosynth at ~half rate.
            ambient_light: 0.5,
        };
        creature_update::update_creatures(
            ctx,
            &mut self.world.creature_store,
            &self.sensor_bins,
            dt as f32,
        );
    }

    /// Serialise the current world to a JSON string. Schema string
    /// inside the JSON guards against loading into a newer binary
    /// that's grown columns since the save was written.
    pub fn save_json(&self) -> Result<String, serde_json::Error> {
        let saved = save::save_world(&self.world);
        serde_json::to_string(&saved)
    }

    /// Load a JSON-encoded save, replacing the current world. Tick
    /// counter resets to zero (the saved t is restored on the
    /// world, but the engine's tick count is just a wall-clock
    /// counter and doesn't roundtrip).
    pub fn load_json(&mut self, json: &str) -> Result<(), save::LoadError> {
        let parsed: save::SavedWorld = serde_json::from_str(json)?;
        save::load_world(&mut self.world, parsed)?;
        self.tick = 0;
        Ok(())
    }

    /// Reset to defaults. Called by `AdminCommand::Reset`.
    pub fn reset(&mut self) {
        self.tick = 0;
        self.world = World::new(DEFAULT_WIDTH, DEFAULT_HEIGHT, DEFAULT_SEED);
        self.seed_demo_particles();
        self.seed_demo_creatures();
    }

    /// Pack the current state into a snapshot for broadcast. Particle
    /// SoA blobs carry the live store columns as packed bytes; the
    /// client decodes them as TypedArrays of the declared stride.
    pub fn snapshot(&self) -> Snapshot {
        let particles = pack_particle_soa(&self.world.particle_store);
        let creatures = pack_creature_soa(&self.world.creature_store);
        Snapshot {
            tick: self.tick,
            t: self.world.t,
            width: self.world.width,
            height: self.world.height,
            particles,
            creatures,
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

fn pack_creature_soa(store: &CreatureStore) -> Soa {
    // Per-cell ATP / total-mass are derived columns the client wants
    // for rendering (color by energy, size by mass). We compute them
    // once into scratch vecs so the blob payload stays a plain f32
    // packed stream.
    let n = store.len();
    let mut energy = Vec::with_capacity(n);
    let mut mass = Vec::with_capacity(n);
    for i in 0..n {
        energy.push(store.energy(i));
        mass.push(store.total_mass(i));
    }
    let blob_f32 = |name: &str, data: &[f32]| NamedBlob {
        name: name.into(),
        stride: 4,
        data: bytemuck_f32(data),
    };
    Soa {
        count: n as u32,
        blobs: vec![
            blob_f32("x", &store.x),
            blob_f32("y", &store.y),
            blob_f32("r", &store.r),
            blob_f32("heading", &store.heading),
            blob_f32("mass", &mass),
            blob_f32("energy", &energy),
        ],
    }
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

    #[test]
    fn snapshot_carries_demo_creatures() {
        let e = Engine::new();
        let snap = e.snapshot();
        assert_eq!(snap.creatures.count, 8);
        for col in ["x", "y", "r", "heading", "mass", "energy"] {
            assert!(
                snap.creatures.blobs.iter().any(|b| b.name == col),
                "creature SoA missing column {col}"
            );
        }
    }

    #[test]
    fn metabolizer_cells_burn_glucose_for_atp() {
        // The "metabolizer" pair (indices 2,3) carries GLU + O2 + ADP
        // so the aerobic respiration named reaction fires every
        // tick. After ~ a second of sim time glucose should drop and
        // ATP should rise above its starting 20.
        let mut e = Engine::new();
        let store0 = &e.world.creature_store;
        let glu0 = store0.chems[chem_ids::CHEM_GLU][2];
        let atp0 = store0.chems[CHEM_ATP][2];
        for _ in 0..60 {
            e.step(1.0 / 60.0);
        }
        let store = &e.world.creature_store;
        let glu1 = store.chems[chem_ids::CHEM_GLU][2];
        let atp1 = store.chems[CHEM_ATP][2];
        assert!(glu1 < glu0, "glucose should drop, {glu0} -> {glu1}");
        assert!(atp1 > atp0, "ATP should rise, {atp0} -> {atp1}");
    }

    #[test]
    fn save_load_round_trip_preserves_state() {
        let mut e = Engine::new();
        for _ in 0..30 {
            e.step(1.0 / 60.0);
        }
        let snap0 = e.snapshot();
        let json = e.save_json().expect("save");

        let mut e2 = Engine::new();
        e2.load_json(&json).expect("load");
        let snap1 = e2.snapshot();

        assert_eq!(snap1.t, snap0.t);
        assert_eq!(snap1.width, snap0.width);
        assert_eq!(snap1.particles.count, snap0.particles.count);
        assert_eq!(snap1.creatures.count, snap0.creatures.count);

        let x_bytes_0 = &snap0
            .particles
            .blobs
            .iter()
            .find(|b| b.name == "x")
            .unwrap()
            .data;
        let x_bytes_1 = &snap1
            .particles
            .blobs
            .iter()
            .find(|b| b.name == "x")
            .unwrap()
            .data;
        assert_eq!(x_bytes_0, x_bytes_1, "particle x should round-trip exactly");
    }

    #[test]
    fn photoautotroph_cells_fix_carbon_under_light() {
        // The "photo" pair (indices 4,5) carries chl + mRNA + CO2 +
        // ADP. Under flat ambient light = 0.5 the photosynth slot
        // fires and glucose accumulates.
        let mut e = Engine::new();
        let glu0 = e.world.creature_store.chems[chem_ids::CHEM_GLU][4];
        for _ in 0..60 {
            e.step(1.0 / 60.0);
        }
        let glu1 = e.world.creature_store.chems[chem_ids::CHEM_GLU][4];
        assert!(glu1 > glu0, "photo cell should fix C into GLU, {glu0} -> {glu1}");
    }
}
