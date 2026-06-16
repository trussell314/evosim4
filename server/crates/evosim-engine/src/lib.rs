//! Native evosim engine. Subsystems land here one at a time; today
//! the engine owns a real `World` with a ported particle store +
//! force kernel. Subsequent commits bring in the genome VM, region
//! passes, collision pass, and creature update.

#![forbid(unsafe_code)]

pub mod activation;
pub mod ambient;
pub mod bonding;
pub mod cell_reactions;
pub mod chem_ids;
pub mod chemistry;
pub mod chemolith;
pub mod collision;
pub mod creature_collision;
pub mod creature_update;
pub mod creatures;
pub mod day_cycle;
pub mod death;
pub mod describe;
pub mod edna;
pub mod excrete_transport;
pub mod forces;
pub mod founders;
pub mod geology;
pub mod genome;
pub mod gpu_forces;
pub mod genome_consts;
pub mod growth;
pub mod ingest;
pub mod maintenance;
pub mod mass;
pub mod obstacle_collision;
pub mod particle_decay;
pub mod particles;
pub mod perf;
pub mod precipitation;
pub mod predate;
pub mod reactions;
pub mod region_temp;
pub mod regions;
pub mod reproduction;
pub mod terrain;
pub mod terrain_shapes;
pub mod vent;
pub mod rng;
pub mod save;
pub mod scene;
pub mod sensor_bins;
pub mod somatic;
pub mod transport_reactions;
pub mod vm;
pub mod world;

use evosim_protocol::{ForceSource, NamedBlob, Snapshot, Soa};

use crate::creatures::CreatureStore;
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

/// Snapshot of one cell's pools, returned by
/// [`Engine::cell_pools_nearest`]. Plain owned data so the WS layer
/// can serialise without re-touching the engine.
#[derive(Debug, Clone)]
pub struct CellPools {
    pub tick: u64,
    pub x: f32,
    pub y: f32,
    pub r: f32,
    pub mass: f32,
    pub atp: f32,
    pub chems: Vec<f32>,
    pub catalysts: Vec<f32>,
    pub inhibitors: Vec<f32>,
}

/// Owns the simulation state. Single-threaded today; rayon and wgpu
/// arrive as the kernels land.
pub struct Engine {
    tick: u64,
    world: World,
    collision_scratch: collision::CollisionScratch,
    sensor_bins: sensor_bins::SensorBins,
    /// Cells that died since the last snapshot. The next snapshot
    /// reads + zeroes this so the client sees a per-window mortality
    /// count, not a monotonic cumulative.
    pending_deaths: u32,
    /// Per-cell bond list. Tracked outside CreatureStore so the SoA
    /// stays a pure numeric column layout (bonds are variable-length
    /// neighbour lists, which don't fit the SoA model).
    bonds: bonding::BondList,
    /// Per-cell repair-window counter. Same lifecycle as bonds.
    repair_ticks: somatic::RepairTicks,
    /// Founder-cohort spawn count per trophic strategy. Configurable
    /// via AdminCommand::Configure; default is 4.
    founders_per_strategy: usize,
    /// Per-tick wall-clock metrics. Folded into the snapshot each
    /// frame so clients can chart per-pass cost over time.
    perf: perf::PerfCollector,
    /// Mirrored from the server task so the snapshot can broadcast
    /// the truth to all clients. Engine doesn't act on these values;
    /// the server task owns them.
    pub mirror_sim_rate: f32,
    pub mirror_running: bool,
    /// Bump counter -- incremented whenever auto_reseed_if_extinct
    /// repopulates founders after a crash. Clients use this to
    /// surface "the world auto-respawned" feedback.
    pub auto_reseeds: u32,
    /// Sim-seconds the population has been below the extinction
    /// threshold. Reset every tick where the count is above; used
    /// to debounce the reseed (a transient blip during reset
    /// shouldn't trigger a respawn).
    extinction_for_s: f64,
    /// Operator-tunable scale on the fission point-mutation rate.
    /// 1.0 = engine default; 0.0 disables drift entirely; >1.0
    /// accelerates evolution at the cost of higher inviability.
    /// Clamped server-side; here we just multiply.
    pub mutation_rate_scale: f64,
}

impl Engine {
    pub fn new() -> Self {
        let mut engine = Self {
            tick: 0,
            world: World::new(DEFAULT_WIDTH, DEFAULT_HEIGHT, DEFAULT_SEED),
            collision_scratch: collision::CollisionScratch::new(),
            sensor_bins: sensor_bins::SensorBins::new(),
            pending_deaths: 0,
            bonds: bonding::make_bonds(0),
            repair_ticks: somatic::make_repair_ticks(0),
            founders_per_strategy: 4,
            perf: perf::PerfCollector::new(),
            mirror_sim_rate: 1.0,
            mirror_running: true,
            auto_reseeds: 0,
            extinction_for_s: 0.0,
            mutation_rate_scale: 1.0,
        };
        // Install the default terrain scene + vent BEFORE seeding
        // founders so cells don't materialise inside rock. Geology
        // seed defaults to the world seed for per-world variability;
        // pass 0 in tests if a byte-stable un-perturbed silhouette is
        // wanted.
        scene::install_default_scene(&mut engine.world, DEFAULT_SEED);
        engine.seed_demo_particles();
        engine.seed_founders();
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

    /// Seed the world with viable founders so a long-running sim can
    /// self-sustain instead of running to extinction. 4 trophic
    /// strategies, `N_FOUNDERS_PER_STRATEGY` of each. Goes away when
    /// the world-config / per-session founder count lands.
    fn seed_founders(&mut self) {
        founders::seed_founders(
            &mut self.world.creature_store,
            &mut self.world.sim_rng,
            self.world.width,
            self.world.height,
            self.founders_per_strategy,
            &self.world.obstacles,
        );
    }

    /// Advance the simulation by one tick. Force / collision pass on
    /// particles, then the VM / movement pass on creatures.
    pub fn step(&mut self, dt: f64) {
        use perf::Pass;
        use std::time::Instant;
        self.perf.tick_start();
        self.tick += 1;
        self.world.t += dt;
        let t = Instant::now();
        forces::apply_forces(&mut self.world, dt as f32);
        self.perf.add_since(Pass::Forces, t);
        let t = Instant::now();
        collision::resolve_collisions(&mut self.world, &mut self.collision_scratch);
        self.perf.add_since(Pass::Collision, t);
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
            // Sampled from the day/night cycle so photosynth tracks
            // the diurnal rhythm. ambient_light is 0 at dawn/dusk
            // and 1 at noon.
            ambient_light: day_cycle::ambient_light_at(self.world.t, self.world.day_period_s),
        };
        // Baseline metabolic drain BEFORE update_creatures so a cell
        // that scrapes by on reaction output gets credited the same
        // tick. This closes the selection loop: a cell with no fuel
        // path can't outpace the drain and eventually autolyses.
        let t = Instant::now();
        maintenance::run_maintenance(&mut self.world.creature_store, &mut self.world.ambient, dt as f32);
        self.perf.add_since(Pass::Maintenance, t);
        // Sensor activation pass: cells holding receptor chems
        // translate the ambient stimuli (currently just light) into
        // signal chems their VM can read via SENSE_CHEMICAL on the
        // CHEM_ACT_* slots. Runs BEFORE update_creatures so the
        // VM reads fresh activations the same tick.
        let t = Instant::now();
        activation::run_activation(
            &mut self.world.creature_store,
            &self.world.particle_store,
            &self.world.ambient,
            ctx.ambient_light,
            self.world.height,
            dt as f32,
        );
        self.perf.add_since(Pass::Activation, t);
        // Bond springs before update_creatures so the velocity
        // contribution shows up in the same tick's position advect.
        let t = Instant::now();
        bonding::apply_bond_springs(
            &mut self.world.creature_store,
            &self.bonds,
            dt as f32,
        );
        creature_update::update_creatures(
            ctx,
            &mut self.world.creature_store,
            &self.sensor_bins,
            dt as f32,
        );
        // Bond list update: prune broken bonds, form new ones based
        // on the freshly-written vm_out.bond_marker. Runs after the
        // VM so SYNTH BOND fires we just observed get acted on.
        bonding::run_bonding(&mut self.world.creature_store, &mut self.bonds);
        self.perf.add_since(Pass::Vm, t);
        // Excrete + transport: read the VM's just-written per-chem
        // output vectors and move chems between cells and the
        // ambient field. Closes the EXCRETE / TRANSPORT op loop and
        // lets the photoautotroph -> heterotroph carbon cycle work
        // through dissolved chemistry as well as particles.
        let t = Instant::now();
        excrete_transport::run_excrete_transport(
            &mut self.world.creature_store,
            &mut self.world.ambient,
            dt as f32,
        );
        self.perf.add_since(Pass::Transport, t);
        let t = Instant::now();
        ingest::run_ingest(
            &mut self.world.creature_store,
            &mut self.world.particle_store,
        );
        self.perf.add_since(Pass::Ingest, t);
        let t = Instant::now();
        predate::run_predate(&mut self.world.creature_store, &self.bonds);
        self.perf.add_since(Pass::Predate, t);
        let t = Instant::now();
        creature_collision::run_creature_collisions(&mut self.world.creature_store);
        self.perf.add_since(Pass::CreatureCollision, t);
        let t = Instant::now();
        obstacle_collision::resolve_obstacle_collisions(
            &self.world.obstacles,
            &self.world.obstacle_index,
            &mut self.world.particle_store,
            &mut self.world.creature_store,
            self.world.restitution,
        );
        obstacle_collision::evacuate_rocks(
            &self.world.obstacles,
            &self.world.obstacle_index,
            &mut self.world.particle_store,
            &mut self.world.creature_store,
            &mut self.world.ambient,
        );
        self.perf.add_since(Pass::ObstacleCollision, t);
        let t = Instant::now();
        if let Some(vent) = self.world.vent.as_mut() {
            vent::step_vent(
                vent,
                &mut self.world.particle_store,
                self.world.t,
                dt,
                self.world.day_period_s,
                self.world.particle_cap.unwrap_or(usize::MAX),
                &mut self.world.sim_rng,
            );
        }
        self.perf.add_since(Pass::Vent, t);
        let t = Instant::now();
        region_temp::step_region_temps(
            &mut self.world.region_temp,
            self.world.width,
            self.world.height,
            self.world.vent.as_ref(),
            dt as f32,
        );
        self.perf.add_since(Pass::RegionTemp, t);
        let t = Instant::now();
        reproduction::run_reproduction(
            &mut self.world.creature_store,
            &mut self.world.sim_rng,
            self.world.t,
            self.mutation_rate_scale,
        );
        self.perf.add_since(Pass::Reproduction, t);
        let t = Instant::now();
        let n_deaths = death::run_death(
            &mut self.world.creature_store,
            &mut self.world.particle_store,
            &mut self.world.ambient,
            &mut self.world.edna,
            &mut self.world.sim_rng,
            self.world.particle_cap.unwrap_or(usize::MAX),
        );
        self.perf.add_since(Pass::Death, t);
        self.pending_deaths = self.pending_deaths.saturating_add(n_deaths as u32);
        let t = Instant::now();
        particle_decay::run_particle_decay(&mut self.world.particle_store, &mut self.world.ambient, dt as f32);
        self.perf.add_since(Pass::ParticleDecay, t);
        let t = Instant::now();
        ambient::run_ambient_exchange(
            &mut self.world.creature_store,
            &mut self.world.ambient,
            dt as f32,
        );
        self.perf.add_since(Pass::Ambient, t);
        let t = Instant::now();
        ambient::diffuse_dissolved(&mut self.world.ambient, dt as f32);
        self.perf.add_since(Pass::Diffuse, t);
        let precip_geom = precipitation::PrecipGeom {
            width: self.world.width,
            height: self.world.height,
            depth: self.world.depth,
            surface_y: self.world.surface_y,
            particle_cap: self.world.particle_cap.unwrap_or(usize::MAX),
        };
        let t = Instant::now();
        precipitation::run_precipitation(
            &mut self.world.ambient,
            &mut self.world.particle_store,
            &self.world.region_temp,
            precip_geom,
            &mut self.world.sim_rng,
        );
        self.perf.add_since(Pass::Precipitation, t);
        let t = Instant::now();
        transport_reactions::run_transport_reactions(
            &mut self.world.creature_store,
            &mut self.world.ambient,
            dt as f32,
        );
        self.perf.add_since(Pass::Transport, t);
        // Growth: recompute every cell's radius from its membrane
        // chem pool. r ~ sqrt(membrane) so a cell that successfully
        // builds membrane physically grows -- larger ingest target,
        // larger sense range eventually, larger surface area for
        // photosynth (the r^2 term in the surface_scale slot).
        growth::run_growth(&mut self.world.creature_store);
        somatic::run_somatic_mutation(
            &mut self.world.creature_store,
            &mut self.repair_ticks,
            &mut self.world.sim_rng,
            self.world.t,
            dt as f32,
        );
        edna::age_carriers(&mut self.world.edna, dt as f32);
        edna::run_competence_uptake(
            &mut self.world.creature_store,
            &mut self.world.edna,
            &mut self.world.sim_rng,
        );
        // Update live counts for the perf report.
        self.perf.set_counts(
            self.world.particle_store.len() as u32,
            self.world.creature_store.n as u32,
        );
        self.perf.tick_end();
    }

    /// Serialise the current world to a JSON string. Schema string
    /// inside the JSON guards against loading into a newer binary
    /// that's grown columns since the save was written.
    /// Configure the global rendered-particle cap. `None` removes the
    /// cap (unbounded -- vent / autolysis / precipitation can pile
    /// particles freely). Pass-through to `world.particle_cap`.
    pub fn set_particle_cap(&mut self, cap: Option<usize>) {
        self.world.particle_cap = cap;
    }

    /// Find the closest live cell to (x, y) within `max_d` world px
    /// and force-kill it by zeroing its membrane chem. Death pass
    /// culls it next tick. Returns the SoA index of the killed cell
    /// (for diagnostics) or None when nothing was close enough.
    /// Dump the pools of the cell nearest (x, y) within `max_d`. Used
    /// by the WS layer for the inspector's "show me this cell's
    /// chemistry" query; intentionally a fresh allocation per call so
    /// the snapshot hot path stays untouched.
    pub fn cell_pools_nearest(&self, x: f32, y: f32, max_d: f32) -> Option<CellPools> {
        let store = &self.world.creature_store;
        let n = store.n;
        if n == 0 {
            return None;
        }
        let mut best: Option<(usize, f32)> = None;
        for i in 0..n {
            let dx = store.x[i] - x;
            let dy = store.y[i] - y;
            let d = (dx * dx + dy * dy).sqrt();
            if d > max_d { continue; }
            if best.map_or(true, |(_, bd)| d < bd) {
                best = Some((i, d));
            }
        }
        let (idx, _) = best?;
        let cap_n = crate::chem_ids::NAMED_CHEMICAL_COUNT;
        let mut chems = Vec::with_capacity(cap_n);
        for k in 0..cap_n {
            let col = store.chems.get(k);
            chems.push(col.and_then(|c| c.get(idx)).copied().unwrap_or(0.0));
        }
        let mut catalysts = Vec::with_capacity(store.catalyst.len());
        for col in &store.catalyst {
            catalysts.push(col.get(idx).copied().unwrap_or(0.0));
        }
        let mut inhibitors = Vec::with_capacity(store.inhibitor.len());
        for col in &store.inhibitor {
            inhibitors.push(col.get(idx).copied().unwrap_or(0.0));
        }
        Some(CellPools {
            tick: self.tick,
            x: store.x[idx],
            y: store.y[idx],
            r: store.r[idx],
            mass: store.total_mass(idx),
            atp: store.energy(idx),
            chems,
            catalysts,
            inhibitors,
        })
    }

    pub fn kill_cell_nearest(&mut self, x: f32, y: f32, max_d: f32) -> Option<usize> {
        let store = &mut self.world.creature_store;
        let n = store.n;
        if n == 0 {
            return None;
        }
        let mut best: Option<(usize, f32)> = None;
        for i in 0..n {
            let dx = store.x[i] - x;
            let dy = store.y[i] - y;
            let d = (dx * dx + dy * dy).sqrt();
            if d > max_d {
                continue;
            }
            if best.map_or(true, |(_, bd)| d < bd) {
                best = Some((i, d));
            }
        }
        let (idx, _) = best?;
        let mem_slot = crate::chem_ids::CHEM_MEMBRANE;
        store.chems[mem_slot][idx] = 0.0;
        Some(idx)
    }

    /// Auto-reseed the founder cohort if the live population has been
    /// at or below `min_cells` for `min_sustained_s` continuous sim
    /// seconds. Without this an extinction event leaves clients
    /// staring at a blank canvas until someone hits Reset. Call from
    /// the server task once per snapshot cadence; the debounce
    /// counter lives on `self.extinction_for_s`.
    ///
    /// Returns true if a reseed fired this call.
    pub fn auto_reseed_if_extinct(
        &mut self,
        min_cells: usize,
        min_sustained_s: f64,
        dt_since_last_check_s: f64,
    ) -> bool {
        let alive = self.world.creature_store.n;
        if alive > min_cells {
            self.extinction_for_s = 0.0;
            return false;
        }
        self.extinction_for_s += dt_since_last_check_s;
        if self.extinction_for_s < min_sustained_s {
            return false;
        }
        // Sustained extinction: reseed founders + the demo particle
        // field. Doesn't touch the obstacles / vent / region_temp so
        // the world keeps its terrain across crashes.
        self.seed_demo_particles();
        self.seed_founders();
        self.auto_reseeds = self.auto_reseeds.saturating_add(1);
        self.extinction_for_s = 0.0;
        true
    }

    /// Read-only access to the underlying world. Used by the server
    /// task to populate the Hello frame with the static terrain
    /// silhouette (and a future renderer-feature dump).
    pub fn world(&self) -> &world::World {
        &self.world
    }

    /// Try to install the wgpu compute force kernel. Returns `true` if
    /// a compute-capable adapter was found and the pipeline built;
    /// `false` (and stays on the CPU paths) otherwise. Idempotent --
    /// rebuilding is a no-op once the pipeline exists.
    pub fn enable_gpu_forces(&mut self) -> bool {
        if self.world.gpu_forces.is_some() {
            return true;
        }
        // Size for the demo world's current cap so the first few
        // dispatches don't have to grow the buffer.
        let initial_capacity = self
            .world
            .particle_cap
            .unwrap_or(8192)
            .max(1024);
        self.world.gpu_forces = gpu_forces::GpuForcesPipeline::new(initial_capacity);
        self.world.gpu_forces.is_some()
    }

    /// Drop the GPU pipeline if one was installed. The force kernel
    /// falls back to the CPU paths.
    pub fn disable_gpu_forces(&mut self) {
        self.world.gpu_forces = None;
    }

    pub fn save_json(&self) -> Result<String, serde_json::Error> {
        let saved = save::save_world(&self.world);
        serde_json::to_string(&saved)
    }

    /// Reconfigure the world. Any None field keeps its current
    /// value. Resets the simulation (clears bonds / repair ticks /
    /// particle + creature stores; reseeds founders and demo
    /// particles in the new dimensions). Used by the admin
    /// Configure command.
    pub fn configure(
        &mut self,
        width: Option<f32>,
        height: Option<f32>,
        seed: Option<u32>,
        day_period_s: Option<f64>,
        founders_per_strategy: Option<u32>,
    ) {
        let w = width.unwrap_or(self.world.width).max(100.0);
        let h = height.unwrap_or(self.world.height).max(100.0);
        let s = seed.unwrap_or_else(|| self.world.sim_rng.peek_state());
        let dp = day_period_s.unwrap_or(self.world.day_period_s).max(0.0);
        let fps = founders_per_strategy
            .map(|v| (v as usize).clamp(1, 64))
            .unwrap_or(self.founders_per_strategy);
        self.founders_per_strategy = fps;
        self.tick = 0;
        self.world = World::new(w, h, s);
        self.world.day_period_s = dp;
        self.bonds = bonding::make_bonds(0);
        self.repair_ticks = somatic::make_repair_ticks(0);
        self.seed_demo_particles();
        self.seed_founders();
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
        let w = self.world.width;
        let h = self.world.height;
        let seed = self.world.sim_rng.peek_state(); // preserve seed across resets
        let day = self.world.day_period_s;
        self.world = World::new(w, h, seed);
        self.world.day_period_s = day;
        self.bonds = bonding::make_bonds(0);
        self.repair_ticks = somatic::make_repair_ticks(0);
        self.seed_demo_particles();
        self.seed_founders();
    }

    /// Pack the current state into a snapshot for broadcast. Particle
    /// SoA blobs carry the live store columns as packed bytes; the
    /// client decodes them as TypedArrays of the declared stride.
    pub fn snapshot(&mut self) -> Snapshot {
        use std::collections::HashMap;
        // Build the per-cell coding-key index in one pass; reuse it
        // for both species_count and per-cell species coloring.
        let n = self.world.creature_store.len();
        let mut keys: Vec<String> = Vec::with_capacity(n);
        let mut counts: HashMap<String, u32> = HashMap::new();
        // First live genome for each coding key -- the representative
        // we ship in SpeciesSummary.genome so the client can disasm
        // without an extra round trip.
        let mut representative_genome: HashMap<String, Vec<u8>> = HashMap::new();
        // Track per-species aggregates: total biomass and ATP.
        let mut biomass_by_key: HashMap<String, f32> = HashMap::new();
        let mut atp_by_key: HashMap<String, f32> = HashMap::new();
        // For each (child_key, parent_key) edge seen in the live
        // population, tally how many cells of this species came from
        // that parent. The per-species `parent_key` is the majority
        // vote; ties broken by lexicographic order so the wire shape
        // is deterministic.
        let mut parent_votes: HashMap<String, HashMap<String, u32>> = HashMap::new();
        let cs = &self.world.creature_store;
        for (i, g) in cs.genome.iter().enumerate() {
            let k = genome::coding_key(g);
            *counts.entry(k.clone()).or_insert(0) += 1;
            representative_genome.entry(k.clone()).or_insert_with(|| g.clone());
            *biomass_by_key.entry(k.clone()).or_insert(0.0) += cs.total_mass(i);
            *atp_by_key.entry(k.clone()).or_insert(0.0) += cs.energy(i);
            let pk = cs.parent_coding_key.get(i).cloned().unwrap_or_default();
            if !pk.is_empty() && pk != k {
                *parent_votes
                    .entry(k.clone())
                    .or_default()
                    .entry(pk)
                    .or_insert(0) += 1;
            }
            keys.push(k);
        }
        // Top species rows, sorted by population descending. Cap at
        // TOP_SPECIES_MAX so a stable wire size on a runaway lineage.
        const TOP_SPECIES_MAX: usize = 16;
        let mut ranked: Vec<(String, u32)> = counts.into_iter().collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let top_species: Vec<evosim_protocol::SpeciesSummary> = ranked
            .iter()
            .take(TOP_SPECIES_MAX)
            .map(|(key, count)| {
                let genome = representative_genome.get(key).cloned().unwrap_or_default();
                let description = describe::describe(&genome);
                // Majority vote on the parent species. Ties broken
                // by lexicographic key so the wire shape is stable
                // tick-to-tick.
                let parent_key = parent_votes.get(key).and_then(|votes| {
                    let mut entries: Vec<(&String, &u32)> = votes.iter().collect();
                    entries.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
                    entries.first().map(|(k, _)| (*k).clone())
                });
                evosim_protocol::SpeciesSummary {
                    coding_key: key.clone(),
                    count: *count,
                    color: species_color_from_key(key),
                    genome,
                    description,
                    biomass: biomass_by_key.get(key).copied().unwrap_or(0.0),
                    atp: atp_by_key.get(key).copied().unwrap_or(0.0),
                    parent_key,
                }
            })
            .collect();
        // Build a key -> index map so per-cell coloring is O(1).
        let key_to_idx: HashMap<String, u32> = top_species
            .iter()
            .enumerate()
            .map(|(i, s)| (s.coding_key.clone(), i as u32))
            .collect();
        let particles = pack_particle_soa(&self.world.particle_store);
        let creatures = pack_creature_soa_with_species(
            &self.world.creature_store,
            &keys,
            &key_to_idx,
        );
        let species_count = ranked.len() as u32;
        let deaths_this_window = std::mem::take(&mut self.pending_deaths);
        let ambient_light = day_cycle::ambient_light_at(self.world.t, self.world.day_period_s);
        // Flatten bonds into pairs (i, j) with i < j so each bond
        // appears exactly once.
        let mut bond_pairs: Vec<u32> = Vec::new();
        let bonds_len = self.bonds.len().min(n);
        for i in 0..bonds_len {
            for &j_u32 in &self.bonds[i] {
                let j = j_u32 as usize;
                if j > i {
                    bond_pairs.push(i as u32);
                    bond_pairs.push(j_u32);
                }
            }
        }
        Snapshot {
            tick: self.tick,
            t: self.world.t,
            width: self.world.width,
            height: self.world.height,
            surface_y: self.world.surface_y,
            sim_rate: self.mirror_sim_rate,
            running: self.mirror_running,
            auto_reseeds: self.auto_reseeds,
            particles,
            creatures,
            force_source: ForceSource::Serial,
            cpu_pool_workers: 0,
            gpu_last_ms: 0.0,
            species_count,
            deaths_this_window,
            day_period_s: self.world.day_period_s,
            ambient_light,
            top_species,
            bonds: bond_pairs,
            ambient_chems: self.world.ambient.totals_per_chem(),
            mass: mass::report(
                &self.world.creature_store,
                &self.world.particle_store,
                &self.world.ambient,
            ),
            perf: self.perf.report(),
            temp_stats: {
                let f = &self.world.region_temp.field;
                if f.is_empty() {
                    (0.0, 0.0, 0.0)
                } else {
                    let mut min = f32::INFINITY;
                    let mut max = f32::NEG_INFINITY;
                    let mut sum = 0.0f64;
                    for &v in f {
                        if v < min { min = v; }
                        if v > max { max = v; }
                        sum += v as f64;
                    }
                    ((sum / f.len() as f64) as f32, min, max)
                }
            },
            ambient_grid: build_ambient_grid(&self.world.ambient),
        }
    }
}

/// Pack the per-region ambient field into the wire shape: total
/// dissolved mass plus the dominant chem id per region. Skips
/// signal chems (consistent with mass accounting) and reuses the
/// solid_mask the engine already maintains.
fn build_ambient_grid(ambient: &crate::ambient::AmbientField) -> evosim_protocol::AmbientGrid {
    let cols = ambient.cols;
    let rows = ambient.rows;
    if cols == 0 || rows == 0 || ambient.dissolved.is_empty() {
        return evosim_protocol::AmbientGrid::default();
    }
    let n = cols * rows;
    let chems = crate::chem_ids::CHEMICAL_COUNT;
    let mut totals = Vec::with_capacity(n);
    let mut dominant = Vec::with_capacity(n);
    for region in 0..n {
        let base = region * chems;
        let mut total = 0.0f32;
        let mut best_id = 0xFFu8;
        let mut best_val = 0.0f32;
        for chem in 0..chems {
            if crate::chem_ids::is_signal(chem) {
                continue;
            }
            let v = ambient.dissolved[base + chem];
            total += v;
            if v > best_val {
                best_val = v;
                best_id = chem as u8;
            }
        }
        totals.push(total);
        dominant.push(best_id);
    }
    evosim_protocol::AmbientGrid {
        cols: cols as u32,
        rows: rows as u32,
        totals,
        dominant_chem: dominant,
        solid_mask: ambient.solid_mask.clone(),
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

/// Deterministic species color from a coding-key fingerprint. FNV-1a
/// 32-bit hash -> hue degrees, OKLCH-ish saturation/lightness picked
/// so any two species are visually distinguishable on the client.
/// Stable across server restarts because the input is the key itself.
fn species_color_from_key(key: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for b in key.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    let hue = (h % 360) as f32;
    // hsl works in browsers without any extra dance and is good enough
    // for visual distinction. 65% sat, 55% lum so we get vivid but not
    // eye-searing colors.
    format!("hsl({hue:.0} 65% 55%)")
}

fn pack_creature_soa_with_species(
    store: &CreatureStore,
    keys: &[String],
    key_to_idx: &std::collections::HashMap<String, u32>,
) -> Soa {
    let mut soa = pack_creature_soa(store);
    // Append a species_idx column. -1 (= 255 in u8 land) when the
    // cell's species is outside the top-N rows the snapshot
    // carried; the client falls back to a synthetic color in that
    // case.
    let n = store.len();
    let mut species_idx = Vec::with_capacity(n);
    for k in keys.iter().take(n) {
        let idx = key_to_idx.get(k).copied().unwrap_or(0xFF);
        species_idx.push(idx as u8);
    }
    soa.blobs.push(NamedBlob {
        name: "speciesIdx".into(),
        stride: 1,
        data: species_idx,
    });
    soa
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
        let mut e = Engine::new();
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
        let mut e = Engine::new();
        let snap = e.snapshot();
        // 4 founders per strategy * 9 strategies = 36.
        assert_eq!(snap.creatures.count, 36);
        for col in ["x", "y", "r", "heading", "mass", "energy"] {
            assert!(
                snap.creatures.blobs.iter().any(|b| b.name == col),
                "creature SoA missing column {col}"
            );
        }
    }

    #[test]
    fn unviable_cells_autolyse_and_release_mass() {
        // Spawn a single sub-viable cell (membrane 0). Death pass
        // should kill it next tick; particle count should rise.
        let mut e = Engine::new();
        // Reset to a fresh world without the demo cells/particles.
        e.world.creature_store.clear();
        e.world.particle_store.clear();
        let mut chems = vec![0.0; chem_ids::NAMED_CHEMICAL_COUNT];
        chems[chem_ids::CHEM_ATP] = 5.0;
        chems[chem_ids::CHEM_GLU] = 5.0;
        e.world.creature_store.push(creatures::CreatureInit {
            r: 8.0,
            chems: Some(chems),
            genome: vec![genome::OP_NOP],
            ..creatures::CreatureInit::default()
        });
        let creatures_before = e.world.creature_store.len();
        let particles_before = e.world.particle_store.len();
        e.step(1.0 / 60.0);
        assert_eq!(e.world.creature_store.len(), creatures_before - 1);
        assert!(
            e.world.particle_store.len() > particles_before,
            "autolysis should have emitted particles"
        );
    }

    #[test]
    fn population_grows_via_reproduction() {
        let mut e = Engine::new();
        let n0 = e.snapshot().creatures.count;
        for _ in 0..120 {
            e.step(1.0 / 60.0);
        }
        let n1 = e.snapshot().creatures.count;
        assert!(
            n1 > n0,
            "reproducer cells should fission, {n0} -> {n1}"
        );
    }

    #[test]
    fn metabolizer_cells_burn_glucose_for_atp() {
        // Metabolizer founders live at indices 4..8 (photo: 0..4,
        // metab: 4..8). After 1s of sim time aerobic respiration
        // should have drained GLU and raised ATP.
        let mut e = Engine::new();
        let store0 = &e.world.creature_store;
        let glu0 = store0.chems[chem_ids::CHEM_GLU][4];
        let atp0 = store0.chems[chem_ids::CHEM_ATP][4];
        for _ in 0..60 {
            e.step(1.0 / 60.0);
        }
        let store = &e.world.creature_store;
        let glu1 = store.chems[chem_ids::CHEM_GLU][4];
        let atp1 = store.chems[chem_ids::CHEM_ATP][4];
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
        // Photo founders live at indices 0..4. Under flat ambient
        // light = 0.5 the photosynth slot fires and glucose
        // accumulates.
        let mut e = Engine::new();
        let glu0 = e.world.creature_store.chems[chem_ids::CHEM_GLU][0];
        for _ in 0..60 {
            e.step(1.0 / 60.0);
        }
        let glu1 = e.world.creature_store.chems[chem_ids::CHEM_GLU][0];
        assert!(glu1 > glu0, "photo cell should fix C into GLU, {glu0} -> {glu1}");
    }
}
