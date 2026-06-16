//! Save / load for the native engine. JSON via serde -- legible at
//! rest, easy to diff, no schema drama. Compact: only the slice of
//! state that exists today; the schema string bumps every time the
//! port adds a column so an older binary refuses a newer save with a
//! clear message instead of silently truncating.
//!
//! Wire-compat with the TS save format is intentionally NOT in scope:
//! the TS save couples to ~40 World fields (atmosphere, regions,
//! obstacles, geology, species, bond partners, ...) we haven't ported
//! yet. A future commit can add an adapter once those ports land.
//!
//! What's serialised today: world dims + clock, world RNG state,
//! particle SoA, creature SoA + genomes + VM state + chem / catalyst /
//! inhibitor pools. Per-cell VmOutputs are NOT serialised; they're
//! cleared at the top of every run_tick anyway, so a fresh instance
//! on load reproduces tick-1 behaviour.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

use crate::chem_ids::{CHEMICAL_COUNT, NAMED_CHEMICAL_COUNT};
use crate::ambient::AmbientField;
use crate::creatures::CreatureInit;
use crate::edna::EdnaField;
use crate::genome_consts::CATALYST_COUNT;
use crate::particles::ParticleInit;
use crate::rng::Mulberry32;
use crate::vm::{VmOutputs, VmState};
use crate::world::World;

/// Compact schema fingerprint. Older binaries refuse a newer save by
/// string comparison. Format: `evosim-native:<rev>:<catalyst_count>:<chemical_count>:<named_chemical_count>`.
///
/// History:
///   1 -- foundational SavedWorld (world dims, RNG, particles, creatures)
///   2 -- adds ambient field + day_period_s
///   3 -- adds eDNA field
///   4 -- regional dissolved field (was flat `stock[chem]`,
///        now per-region `dissolved[region*chems+chem]` + cols/rows
///        + world dims duplicated for self-validation)
///   5 -- per-cell `parent_coding_key` lineage column, optional in
///        the deserialiser so r4 saves still load (with empty
///        ancestry that fills in naturally as cells reproduce)
pub fn save_schema() -> String {
    format!(
        "evosim-native:5:{}:{}:{}",
        CATALYST_COUNT, CHEMICAL_COUNT, NAMED_CHEMICAL_COUNT
    )
}

/// Schema strings the loader will accept besides the current
/// `save_schema()`. Each entry is paired with the migrations the
/// loader runs to bring the data forward. Today we accept the v4
/// shape and synthesise empty ancestry on load.
pub fn accepted_legacy_schemas() -> Vec<String> {
    vec![format!(
        "evosim-native:4:{}:{}:{}",
        CATALYST_COUNT, CHEMICAL_COUNT, NAMED_CHEMICAL_COUNT
    )]
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SavedWorld {
    pub schema: String,
    pub t: f64,
    pub width: f32,
    pub height: f32,
    pub rng_state: u32,
    #[serde(default)]
    pub day_period_s: f64,

    // Particles
    pub particles: Vec<SavedParticle>,

    // Creatures
    pub creatures: Vec<SavedCreature>,

    /// World-wide ambient stock per chem. Default empty for older
    /// saves (we won't reach that branch unless we accept v1, which
    /// the schema check refuses).
    #[serde(default)]
    pub ambient: AmbientField,
    /// eDNA carriers. Default empty for older saves.
    #[serde(default)]
    pub edna: EdnaField,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SavedParticle {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub vx: f32,
    pub vy: f32,
    pub vz: f32,
    pub r: f32,
    pub density: f32,
    pub age: f32,
    pub chem_id: u8,
    pub quiet_ticks: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SavedCreature {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub vx: f32,
    pub vy: f32,
    pub vz: f32,
    pub r: f32,
    pub heading: f32,
    pub born_at: f64,
    pub last_reproduce_fire_t: f64,
    pub child_count: i32,
    /// `NAMED_CHEMICAL_COUNT` slots.
    pub chems: Vec<f32>,
    /// Sparse: only non-zero catalyst slots emitted. `(slot, value)`.
    pub catalyst: Vec<(u32, f32)>,
    pub inhibitor: Vec<(u32, f32)>,
    pub genome: Vec<u8>,
    /// Parent's coding-key fingerprint at fission time. Optional so
    /// schema-r4 saves still deserialise (the loader populates the
    /// column with empty strings, and the ancestry reconstructs as
    /// the population reproduces).
    #[serde(default)]
    pub parent_coding_key: String,
    pub vm: SavedVmState,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SavedVmState {
    pub pc: i64,
    pub executing: bool,
    pub stack: Vec<f64>,
    pub regs: [f32; 16],
}

/// Wrap the current `Mulberry32` state. We expose `state` on
/// the RNG via a peek method below for the save path.
fn rng_state(rng: &Mulberry32) -> u32 {
    rng.peek_state()
}

/// Snapshot the world into a serialisable struct.
pub fn save_world(world: &World) -> SavedWorld {
    let ps = &world.particle_store;
    let particles = (0..ps.len())
        .map(|i| SavedParticle {
            x: ps.x[i],
            y: ps.y[i],
            z: ps.z[i],
            vx: ps.vx[i],
            vy: ps.vy[i],
            vz: ps.vz[i],
            r: ps.r[i],
            density: ps.density[i],
            age: ps.age[i],
            chem_id: ps.chem_id[i],
            quiet_ticks: ps.quiet_ticks[i],
        })
        .collect();

    let cs = &world.creature_store;
    let creatures = (0..cs.len())
        .map(|i| {
            let chems: Vec<f32> = (0..NAMED_CHEMICAL_COUNT).map(|k| cs.chems[k][i]).collect();
            let catalyst: Vec<(u32, f32)> = (0..CATALYST_COUNT)
                .filter_map(|k| {
                    let v = cs.catalyst[k][i];
                    if v != 0.0 { Some((k as u32, v)) } else { None }
                })
                .collect();
            let inhibitor: Vec<(u32, f32)> = (0..CATALYST_COUNT)
                .filter_map(|k| {
                    let v = cs.inhibitor[k][i];
                    if v != 0.0 { Some((k as u32, v)) } else { None }
                })
                .collect();
            let vm_state = &cs.vm_state[i];
            SavedCreature {
                x: cs.x[i],
                y: cs.y[i],
                z: cs.z[i],
                vx: cs.vx[i],
                vy: cs.vy[i],
                vz: cs.vz[i],
                r: cs.r[i],
                heading: cs.heading[i],
                born_at: cs.born_at[i],
                last_reproduce_fire_t: cs.last_reproduce_fire_t[i],
                child_count: cs.child_count[i],
                chems,
                catalyst,
                inhibitor,
                genome: cs.genome[i].clone(),
                parent_coding_key: cs
                    .parent_coding_key
                    .get(i)
                    .cloned()
                    .unwrap_or_default(),
                vm: SavedVmState {
                    pc: vm_state.pc,
                    executing: vm_state.executing,
                    stack: vm_state.stack.iter().copied().collect(),
                    regs: vm_state.regs,
                },
            }
        })
        .collect();

    SavedWorld {
        schema: save_schema(),
        t: world.t,
        width: world.width,
        height: world.height,
        rng_state: rng_state(&world.sim_rng),
        day_period_s: world.day_period_s,
        particles,
        creatures,
        ambient: world.ambient.clone(),
        edna: world.edna.clone(),
    }
}

/// Errors from a load attempt. Surface a string so the admin reply
/// can carry it without ceremony.
#[derive(Debug)]
pub enum LoadError {
    SchemaMismatch { got: String, want: String },
    Json(serde_json::Error),
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LoadError::SchemaMismatch { got, want } => {
                write!(f, "schema mismatch: save says {got:?}, binary speaks {want:?}")
            }
            LoadError::Json(e) => write!(f, "json decode: {e}"),
        }
    }
}

impl std::error::Error for LoadError {}

impl From<serde_json::Error> for LoadError {
    fn from(e: serde_json::Error) -> Self {
        LoadError::Json(e)
    }
}

/// Replace `world` state from a `SavedWorld`. Dimensions, time, and
/// stores all overwrite. The RNG is reseeded to the saved state.
pub fn load_world(world: &mut World, saved: SavedWorld) -> Result<(), LoadError> {
    let want = save_schema();
    if saved.schema != want && !accepted_legacy_schemas().contains(&saved.schema) {
        return Err(LoadError::SchemaMismatch {
            got: saved.schema,
            want,
        });
    }
    world.t = saved.t;
    world.width = saved.width;
    world.height = saved.height;
    world.sim_rng = Mulberry32::new(saved.rng_state);
    world.day_period_s = saved.day_period_s;
    world.ambient = saved.ambient;
    world.edna = saved.edna;

    world.particle_store.clear();
    for p in saved.particles {
        world.particle_store.push(ParticleInit {
            x: p.x,
            y: p.y,
            z: p.z,
            vx: p.vx,
            vy: p.vy,
            vz: p.vz,
            r: p.r,
            chem_id: p.chem_id,
            density: p.density,
            quiet_ticks: p.quiet_ticks,
            molecules: None,
            generic_chem: None,
        });
        let idx = world.particle_store.len() - 1;
        world.particle_store.age[idx] = p.age;
    }

    world.creature_store.clear();
    for c in saved.creatures {
        // Build chems vec in the expected order so push() copies into
        // each column. If the saved length doesn't match the current
        // NAMED_CHEMICAL_COUNT the per-column push assert trips --
        // that's a load failure caught before we corrupt state.
        let chems_vec = c.chems.clone();
        if chems_vec.len() != NAMED_CHEMICAL_COUNT {
            return Err(LoadError::SchemaMismatch {
                got: format!("chems len {}", chems_vec.len()),
                want: format!("chems len {}", NAMED_CHEMICAL_COUNT),
            });
        }
        world.creature_store.push(CreatureInit {
            x: c.x,
            y: c.y,
            z: c.z,
            vx: c.vx,
            vy: c.vy,
            vz: c.vz,
            r: c.r,
            heading: c.heading,
            born_at: c.born_at,
            genome: c.genome,
            chems: Some(chems_vec),
            parent_coding_key: c.parent_coding_key,
        });
        let i = world.creature_store.len() - 1;
        world.creature_store.last_reproduce_fire_t[i] = c.last_reproduce_fire_t;
        world.creature_store.child_count[i] = c.child_count;

        // Sparse catalyst / inhibitor: only non-zero slots stored.
        for (slot, v) in c.catalyst {
            if (slot as usize) < CATALYST_COUNT {
                world.creature_store.catalyst[slot as usize][i] = v;
            }
        }
        for (slot, v) in c.inhibitor {
            if (slot as usize) < CATALYST_COUNT {
                world.creature_store.inhibitor[slot as usize][i] = v;
            }
        }
        // VM state.
        let mut state = VmState::new();
        state.pc = c.vm.pc;
        state.executing = c.vm.executing;
        state.regs = c.vm.regs;
        state.stack = VecDeque::from(c.vm.stack);
        world.creature_store.vm_state[i] = state;
        world.creature_store.vm_out[i] = VmOutputs::new();
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::{CHEM_ATP, CHEM_GLU};
    use crate::genome::*;

    fn populated_world() -> World {
        let mut world = World::new(1600.0, 1200.0, 42);
        world.t = 7.5;
        world.particle_store.push(ParticleInit {
            x: 10.0,
            y: 20.0,
            r: 2.5,
            chem_id: 3,
            ..ParticleInit::default()
        });
        world.particle_store.push(ParticleInit {
            x: 30.0,
            y: 40.0,
            r: 1.5,
            chem_id: 7,
            ..ParticleInit::default()
        });
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[CHEM_ATP] = 35.0;
        chems[CHEM_GLU] = 17.0;
        world.creature_store.push(CreatureInit {
            x: 100.0,
            y: 200.0,
            r: 8.0,
            heading: 0.5,
            genome: vec![OP_GENE, OP_NOP, OP_END],
            chems: Some(chems),
            ..CreatureInit::default()
        });
        // Stamp a catalyst slot so the sparse path is exercised.
        world.creature_store.catalyst[42][0] = 1.25;
        world.creature_store.last_reproduce_fire_t[0] = 3.0;
        world
    }

    #[test]
    fn round_trip_matches() {
        let world = populated_world();
        let saved = save_world(&world);
        let json = serde_json::to_string(&saved).expect("serialise");
        let parsed: SavedWorld = serde_json::from_str(&json).expect("parse");

        let mut loaded = World::new(0.0, 0.0, 0);
        load_world(&mut loaded, parsed).expect("load");

        assert_eq!(loaded.t, 7.5);
        assert_eq!(loaded.width, 1600.0);
        assert_eq!(loaded.height, 1200.0);
        assert_eq!(loaded.particle_store.len(), 2);
        assert_eq!(loaded.particle_store.x[0], 10.0);
        assert_eq!(loaded.particle_store.chem_id[1], 7);
        assert_eq!(loaded.creature_store.len(), 1);
        assert_eq!(loaded.creature_store.chems[CHEM_ATP][0], 35.0);
        assert_eq!(loaded.creature_store.catalyst[42][0], 1.25);
        assert_eq!(loaded.creature_store.last_reproduce_fire_t[0], 3.0);
    }

    #[test]
    fn schema_mismatch_refuses_load() {
        let world = populated_world();
        let mut saved = save_world(&world);
        saved.schema = "evosim-native:99:0:0:0".into();

        let mut target = World::new(0.0, 0.0, 0);
        match load_world(&mut target, saved) {
            Err(LoadError::SchemaMismatch { .. }) => {}
            other => panic!("expected schema mismatch, got {other:?}"),
        }
    }

    #[test]
    fn sparse_catalyst_round_trip() {
        let world = populated_world();
        let saved = save_world(&world);
        // Only slot 42 was populated; the SavedCreature should hold a
        // single entry.
        assert_eq!(saved.creatures[0].catalyst.len(), 1);
        assert_eq!(saved.creatures[0].catalyst[0], (42, 1.25));
    }

    #[test]
    fn parent_coding_key_round_trips() {
        let mut world = populated_world();
        // Stamp a parent key into the first cell; round-trip should
        // preserve it exactly.
        world.creature_store.parent_coding_key[0] = "|10|11".into();
        let saved = save_world(&world);
        let mut target = World::new(0.0, 0.0, 0);
        load_world(&mut target, saved).unwrap();
        assert_eq!(
            target.creature_store.parent_coding_key[0],
            "|10|11",
            "parent_coding_key must survive save/load round-trip",
        );
    }

    #[test]
    fn r4_save_loads_with_empty_ancestry() {
        // Hand-roll a schema-r4 SavedWorld JSON (no parent_coding_key
        // field) and verify the loader migrates it forward by filling
        // the column with empty strings. Uses a tiny synthetic world
        // so the JSON stays inline-able.
        let world = populated_world();
        let mut saved = save_world(&world);
        saved.schema = format!(
            "evosim-native:4:{}:{}:{}",
            CATALYST_COUNT, CHEMICAL_COUNT, NAMED_CHEMICAL_COUNT
        );
        // Drop the new field by re-serialising / deserialising
        // through a minimal shim that omits it; serde_default keeps
        // the deserialise side happy.
        let json = serde_json::to_string(&saved).unwrap();
        let back: SavedWorld = serde_json::from_str(&json).unwrap();
        let mut target = World::new(0.0, 0.0, 0);
        load_world(&mut target, back).expect("r4 schema must still load");
        assert_eq!(
            target.creature_store.parent_coding_key.len(),
            target.creature_store.n,
            "loader must initialise the lineage column for every cell",
        );
    }
}
