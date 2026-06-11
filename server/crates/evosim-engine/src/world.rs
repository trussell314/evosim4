//! Minimal `World` skeleton. The TS world (`src/sim/core.ts` World
//! interface) carries dozens of fields covering environment, region
//! state, atmosphere, day/night, vent, terrain etc.; the port lands
//! them subsystem by subsystem. This module ships the slice every
//! current subsystem needs (particles + the ambient parameters the
//! force kernel reads) so the engine task can drive a real tick. The
//! rest accretes here as more port commits land.

use crate::ambient::AmbientField;
use crate::creatures::CreatureStore;
use crate::edna::EdnaField;
use crate::obstacle_collision::ObstacleIndex;
use crate::particles::ParticleStore;
use crate::rng::Mulberry32;
use crate::terrain::Obstacle;

/// Reference radius used in the force kernel's drag scaling. Matches
/// `DRAG_REF_R` in `src/sim.ts`.
pub const DRAG_REF_R: f32 = 4.0;

/// `SPLASH_DEPTH` -- the band below `surface_y` where wave crests
/// throw spray-like vertical impulses on light particles.
pub const SPLASH_DEPTH: f32 = 30.0;

/// `SPLASH_GAIN` -- multiplier on the wave amplitude for the splash
/// impulse inside SPLASH_DEPTH.
pub const SPLASH_GAIN: f32 = 1.5;

/// Slow modulating frequency for the current-direction sine. Matches
/// TS `CURRENT_FREQ = 2π / 600`.
pub const CURRENT_FREQ: f64 = std::f64::consts::TAU / 600.0;

pub struct World {
    /// Sim seconds since epoch. Bumped by `step()`.
    pub t: f64,
    /// World extent in pixels. `depth` is the out-of-plane size used
    /// by the regional dissolved capacity formula (volume = w * h * d
    /// per region, scaled through the 10 m world-height convention).
    /// Zero rendering / kinematics impact; only `regions::region_volume_l`
    /// reads it.
    pub width: f32,
    pub height: f32,
    pub depth: f32,

    pub particle_store: ParticleStore,
    pub creature_store: CreatureStore,
    pub ambient: AmbientField,
    pub edna: EdnaField,

    /// Static rocky terrain. Empty by default; populated by the
    /// world-config / scene port (the hand-authored Inkscape
    /// polygons from `terrain-shapes.ts` live there, not in the
    /// engine substrate).
    pub obstacles: Vec<Obstacle>,
    /// Per-column topmost rock y (or `f32::INFINITY`). Built from
    /// `obstacles` whenever it's rebuilt.
    pub terrain_heightmap: Vec<f32>,
    /// Spatial index over `obstacles` used by the per-tick
    /// collision pass. Rebuilt whenever `obstacles` changes.
    pub obstacle_index: ObstacleIndex,
    /// Hydrothermal vent feature. `None` by default; a future scene /
    /// world-config port (or a test) installs one. When set,
    /// `step_vent` runs each tick and may emit particles.
    pub vent: Option<crate::vent::VentState>,
    /// Per-region temperature field. Diffuses, relaxes toward
    /// `TEMP_BASELINE`, and absorbs vent heat. Consumed by the
    /// solubility / capacity formula and the precipitation pass.
    pub region_temp: crate::region_temp::RegionTempField,
    /// Global rendered-particle ceiling. Passes that ADD particles
    /// (vent emissions, precipitation, autolysis) consult this before
    /// pushing; once the store hits the cap, surplus stays in the
    /// dissolved field (or is silently dropped on the death path).
    /// `None` = unbounded, which is the historical behaviour.
    pub particle_cap: Option<usize>,

    /// Per-engine PRNG for the force kernel's brownian noise. TS uses
    /// a module-level `simRng`; we hold it on the world so the engine
    /// task owns it cleanly.
    pub sim_rng: Mulberry32,

    // ----- Force / fluid params (mirror TS World fields). -----
    pub gravity: f32,
    pub drag: f32,
    pub surface_y: f32,
    pub surface_decay: f32,
    pub swell_decay: f32,
    pub updraft_amp: f32,
    pub current_amp: f32,
    pub surface_length: f32,
    pub surface_period: f32,
    pub swell_length: f32,
    pub swell_period: f32,
    pub updraft_length: f32,
    pub updraft_period: f32,
    pub surface_amp: f32,
    pub swell_amp: f32,
    pub z_stir_amp: f32,
    pub brownian_amp: f32,
    /// Scalar in `[0, 1]` modulating wave amplitude with weather. The
    /// TS code derives this from `surfaceActivity(world)` which folds
    /// in wind state. Until the wind port lands we hold it as a plain
    /// world field; the default of 1.0 reproduces the TS "calm
    /// weather" baseline.
    pub surface_activity: f32,

    // ----- Collision params (mirror TS World fields). -----
    /// Number of Jacobi sweeps per collision pass. TS default is 2.
    pub collision_iters: u32,
    /// Coefficient of restitution. TS default is 0.8.
    pub restitution: f32,

    /// Period of one day/night cycle in sim-seconds. The day_cycle
    /// helper samples ambient light against this; 0 disables the
    /// cycle (constant daylight).
    pub day_period_s: f64,
}

impl World {
    /// Construct a world with the TS founder defaults. Particle count
    /// stays zero; spawn happens through later passes once the
    /// region/atmosphere port lands.
    pub fn new(width: f32, height: f32, seed: u32) -> Self {
        Self {
            t: 0.0,
            width,
            height,
            // Default depth matches REGION_PX so a single column of
            // regions is cubic. The TS world is parameterised; until
            // the world-config port lands the default is a reasonable
            // mid-water-column slice.
            depth: crate::regions::REGION_PX,
            particle_store: ParticleStore::new(),
            creature_store: CreatureStore::new(),
            ambient: AmbientField::new_for_world(width, height),
            obstacles: Vec::new(),
            terrain_heightmap: Vec::new(),
            obstacle_index: ObstacleIndex::new(),
            vent: None,
            region_temp: crate::region_temp::RegionTempField::new(),
            // Default cap sized for the demo world: keeps the dissolve <->
            // precipitate loop healthy without letting autolysis +
            // precipitation pile particles indefinitely.
            particle_cap: Some(3000),
            edna: EdnaField::new(),
            sim_rng: Mulberry32::new(seed),

            // Defaults pulled from the TS scene baseline. Specific
            // values get pinned (and tested against TS goldens) when
            // the world-config / save-format port lands; for now
            // they're a reasonable mid-water-column scene.
            gravity: 40.0,
            drag: 1.5,
            surface_y: 120.0,
            surface_decay: 60.0,
            swell_decay: 200.0,
            updraft_amp: 6.0,
            current_amp: 4.0,
            surface_length: 280.0,
            surface_period: 4.0,
            swell_length: 900.0,
            swell_period: 9.0,
            updraft_length: 600.0,
            updraft_period: 8.0,
            surface_amp: 55.0,
            swell_amp: 16.0,
            z_stir_amp: 6.0,
            brownian_amp: 12.0,
            surface_activity: 1.0,
            collision_iters: 2,
            restitution: 0.8,
            day_period_s: crate::day_cycle::DEFAULT_DAY_PERIOD_S,
        }
    }

    /// Reset world state but keep dimensions + seed.
    pub fn reset(&mut self) {
        self.t = 0.0;
        self.particle_store.clear();
        self.creature_store.clear();
        self.ambient = AmbientField::new_for_world(self.width, self.height);
        self.edna = EdnaField::new();
        self.obstacles.clear();
        self.terrain_heightmap.clear();
        self.obstacle_index = ObstacleIndex::new();
        self.vent = None;
        self.region_temp = crate::region_temp::RegionTempField::new();
    }

    /// Rebuild the heightmap + obstacle index + ambient solid mask
    /// after `obstacles` has been mutated. All three are static
    /// derivatives of the obstacle list and need to stay in sync.
    pub fn rebuild_terrain_derivatives(&mut self) {
        self.terrain_heightmap = crate::terrain::build_terrain_heightmap(&self.obstacles, self.width);
        self.obstacle_index
            .rebuild(&self.obstacles, self.width, self.height);
        self.ambient.solid_mask = build_ambient_solid_mask(&self.obstacles, &self.ambient);
    }
}

/// Parameters passed to the force kernel. Mirrors the TS
/// `ParticleForceParams` interface field-for-field. Pulled out into
/// its own struct so a future GPU-side encoding layer can read the
/// same shape.
#[derive(Debug, Clone, Copy)]
pub struct ParticleForceParams {
    pub dt: f32,
    pub t: f32,
    pub drag: f32,
    pub gravity: f32,
    pub surface_y: f32,
    pub surface_decay: f32,
    pub swell_decay: f32,
    pub updraft_amp: f32,
    pub current_amp: f32,
    pub k_s: f32,
    pub w_s: f32,
    pub k_l: f32,
    pub w_l: f32,
    pub k_u: f32,
    pub w_u: f32,
    pub surf_amp: f32,
    pub swell_amp: f32,
    pub z_amp: f32,
    pub b_amp: f32,
    pub updraft_env: f32,
    pub col_depth: f32,
    pub current_drift: f32,
    pub world_floor_y: f32,
    pub world_width: f32,
}

/// Build a per-region solid mask: 1 if the region center sits inside
/// any obstacle polygon. Empty obstacles list -> all-zero mask
/// (every region treated as water; existing demo + tests unaffected).
fn build_ambient_solid_mask(obstacles: &[Obstacle], ambient: &AmbientField) -> Vec<u8> {
    let n = ambient.cols * ambient.rows;
    let mut mask = vec![0_u8; n];
    if obstacles.is_empty() {
        return mask;
    }
    for (ri, slot) in mask.iter_mut().enumerate().take(n) {
        let rx = (ri % ambient.cols) as f32;
        let ry = (ri / ambient.cols) as f32;
        let cx = rx * crate::regions::REGION_PX + crate::regions::REGION_PX * 0.5;
        let cy = ry * crate::regions::REGION_PX + crate::regions::REGION_PX * 0.5;
        for ob in obstacles {
            if cx < ob.min_x || cx > ob.max_x || cy < ob.min_y || cy > ob.max_y {
                continue;
            }
            let Some(poly) = &ob.polygon else { continue };
            if crate::terrain::point_in_polygon(cx, cy, poly) {
                *slot = 1;
                break;
            }
        }
    }
    mask
}

pub fn build_particle_force_params(world: &World, dt: f32) -> ParticleForceParams {
    let tau = std::f32::consts::TAU;
    let act = world.surface_activity;
    ParticleForceParams {
        dt,
        t: world.t as f32,
        drag: world.drag,
        gravity: world.gravity,
        surface_y: world.surface_y,
        surface_decay: world.surface_decay,
        swell_decay: world.swell_decay,
        updraft_amp: world.updraft_amp,
        current_amp: world.current_amp,
        k_s: tau / world.surface_length,
        w_s: tau / world.surface_period,
        k_l: tau / world.swell_length,
        w_l: tau / world.swell_period,
        k_u: tau / world.updraft_length,
        w_u: tau / world.updraft_period,
        surf_amp: world.surface_amp * act,
        swell_amp: world.swell_amp * act,
        z_amp: world.z_stir_amp * act,
        b_amp: world.brownian_amp * act,
        updraft_env: act.min(1.0),
        col_depth: (world.height - world.surface_y).max(1.0),
        current_drift: (world.t * CURRENT_FREQ).sin() as f32,
        world_floor_y: world.height,
        world_width: world.width,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn force_params_use_world_t() {
        let mut w = World::new(1600.0, 1200.0, 1);
        w.t = 3.0;
        let p = build_particle_force_params(&w, 1.0 / 60.0);
        assert_eq!(p.t, 3.0);
        assert!((p.current_drift - (3.0 * CURRENT_FREQ).sin() as f32).abs() < 1e-6);
    }

    #[test]
    fn reset_clears_time_and_particles() {
        let mut w = World::new(800.0, 600.0, 1);
        w.t = 42.0;
        w.particle_store.push(crate::particles::ParticleInit::default());
        w.reset();
        assert_eq!(w.t, 0.0);
        assert!(w.particle_store.is_empty());
    }
}
