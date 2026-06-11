//! Per-particle force pass, ported from TS `applyParticleForcesRange`
//! in `src/sim.ts`. The math is verbatim -- this is the same kernel
//! that ships in the WebGPU compute shader (`gpu-forces-shader.ts`)
//! and the CPU pool worker (`particle.worker.ts`). The Rust port runs
//! over `&mut [f32]` slices so a future rayon parallelisation is a
//! one-line `par_chunks_mut` away.
//!
//! Brownian noise pulls from the world's `sim_rng`; the TS source
//! does the same with a module-level `simRng`. This is the source of
//! the engine's documented "serial path is deterministic, parallel
//! paths are not" property -- the parallel CPU pool draws from each
//! worker's own RNG, and the GPU kernel uses a per-particle PCG; only
//! the strictly-serial path keeps a single ordered RNG stream.

use crate::particles::ParticleStore;
use crate::rng::Mulberry32;
use crate::world::{ParticleForceParams, World, DRAG_REF_R, SPLASH_DEPTH, SPLASH_GAIN};

/// Run the force kernel over particle indices `[from, to)`. Reads SoA
/// columns from `store` and a borrowed `mat_base[chem_id]` lookup so
/// no clone of the chem table happens per particle. `rng` is the
/// shared serial-path PRNG.
pub fn apply_particle_forces_range(
    store: &mut ParticleStore,
    mat_base: &[f32],
    rng: &mut Mulberry32,
    from: usize,
    to: usize,
    p: &ParticleForceParams,
) {
    debug_assert!(from <= to);
    debug_assert!(to <= store.n);
    let dt = p.dt;
    let t = p.t;
    let drag = p.drag;
    let grav = p.gravity;
    let surface_y = p.surface_y;
    let surf_decay = p.surface_decay;
    let swell_decay = p.swell_decay;
    let updraft_amp = p.updraft_amp;
    let current_amp = p.current_amp;
    let k_s = p.k_s;
    let w_s = p.w_s;
    let k_l = p.k_l;
    let w_l = p.w_l;
    let k_u = p.k_u;
    let w_u = p.w_u;
    let surf_amp = p.surf_amp;
    let swell_amp = p.swell_amp;
    let z_amp = p.z_amp;
    let b_amp = p.b_amp;
    let updraft_env = p.updraft_env;
    let col_depth = p.col_depth;
    let current_drift = p.current_drift;
    let v_x_cap = {
        let c_s = w_s / k_s;
        let c_l = w_l / k_l;
        1.3 * c_s.max(c_l)
    };

    // Borrow each column. Doing this once outside the loop hands the
    // optimiser a fixed-length slice and a known stride.
    let px = &mut store.x[..];
    let py = &mut store.y[..];
    let pz = &mut store.z[..];
    let pvx = &mut store.vx[..];
    let pvy = &mut store.vy[..];
    let pvz = &mut store.vz[..];
    let pr = &store.r[..];
    let pdens = &store.density[..];
    let pmat = &store.chem_id[..];

    for i in from..to {
        let xi = px[i];
        let yi = py[i];
        let ri = pr[i];
        let mut vxi = pvx[i];
        let mut vyi = pvy[i];
        let mut vzi = pvz[i];
        let override_d = pdens[i];
        let density = if override_d != 0.0 {
            override_d
        } else {
            mat_base[pmat[i] as usize]
        };

        // Vertical buoyancy clamped to ±gravity.
        let mut ay = grav * (1.0 - 1.0 / density);
        if ay < -grav {
            ay = -grav;
        } else if ay > grav {
            ay = grav;
        }

        let depth = if yi > surface_y { yi - surface_y } else { 0.0 };

        // Counter-propagating wave pair (matched phase speeds).
        let surf_pr = k_s * xi - w_s * t;
        let surf_pl = 1.3 * k_s * xi + 1.3 * w_s * t + 1.1;
        let swell_pr = k_l * xi - w_l * t;
        let swell_pl = 1.4 * k_l * xi + 1.4 * w_l * t + 0.4;
        let surface = surf_amp * 0.5
            * (surf_pr.sin() + surf_pl.sin())
            * (-depth / surf_decay).exp();
        let swell = swell_amp * 0.5
            * (swell_pr.sin() + swell_pl.sin())
            * (-depth / swell_decay).exp();
        let az = z_amp
            * (w_l * t + k_l * xi + 1.0).sin()
            * (-depth / swell_decay).exp();
        let splash = if depth < SPLASH_DEPTH {
            surf_amp * SPLASH_GAIN * 0.5
                * (surf_pr.cos() + surf_pl.cos())
                * (-depth / SPLASH_DEPTH).exp()
        } else {
            0.0
        };
        let updraft = -updraft_amp * updraft_env * (k_u * xi + w_u * t).sin();
        let depth_frac = depth / col_depth;
        let current = current_amp * (std::f32::consts::PI * depth_frac).cos() * current_drift;

        // Brownian noise -- gentler depth decay than waves.
        let noise_env = (-depth / 400.0).exp();
        let noise_x = b_amp * noise_env * (rng.next_f64() as f32 - 0.5) * 2.0;
        let noise_y = b_amp * noise_env * (rng.next_f64() as f32 - 0.5) * 2.0;

        let ax = surface + swell + current + noise_x;
        let ay_tot = ay + splash + updraft + noise_y;

        let drag_scale = ri / DRAG_REF_R;
        let dscale_drag = drag * drag_scale;
        vxi += (ax - dscale_drag * vxi) * dt;
        vyi += (ay_tot - dscale_drag * vyi) * dt;
        vzi += (az - dscale_drag * vzi) * dt;

        // Wave-orbit cap on horizontal speed.
        if vxi > v_x_cap {
            vxi = v_x_cap;
        } else if vxi < -v_x_cap {
            vxi = -v_x_cap;
        }

        pvx[i] = vxi;
        pvy[i] = vyi;
        pvz[i] = vzi;
        px[i] = xi + vxi * dt;
        py[i] = yi + vyi * dt;
        pz[i] += vzi * dt;
    }
}

/// Convenience wrapper around `apply_particle_forces_range` that runs
/// the kernel across every particle in `world`. Used by the engine's
/// serial path. Borrows the chem table internally so callers don't
/// thread it through.
pub fn apply_forces(world: &mut World, dt: f32) {
    if world.particle_store.n == 0 {
        return;
    }
    let params = crate::world::build_particle_force_params(world, dt);
    let mat_base = &crate::chemistry::table().base_density[..];
    let n = world.particle_store.n;
    apply_particle_forces_range(
        &mut world.particle_store,
        mat_base,
        &mut world.sim_rng,
        0,
        n,
        &params,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::particles::ParticleInit;

    fn light_particle(x: f32, y: f32, chem_id: u8) -> ParticleInit {
        ParticleInit { x, y, r: 2.0, chem_id, density: 0.0, ..ParticleInit::default() }
    }

    #[test]
    fn no_particles_no_op() {
        // Empty store: shouldn't panic, should leave time alone.
        let mut w = World::new(800.0, 600.0, 1);
        apply_forces(&mut w, 1.0 / 60.0);
        assert_eq!(w.particle_store.len(), 0);
    }

    #[test]
    fn buoyant_particle_rises() {
        // Light particle (low density) under gravity should accumulate
        // upward velocity (Y goes down in screen coords -- "up" = -y).
        let mut w = World::new(800.0, 600.0, 1);
        // Disable wave/brownian so the test is signal-only.
        w.surface_amp = 0.0;
        w.swell_amp = 0.0;
        w.z_stir_amp = 0.0;
        w.brownian_amp = 0.0;
        w.updraft_amp = 0.0;
        w.current_amp = 0.0;
        w.particle_store.push(ParticleInit {
            density: 0.2, // much lighter than water (1.0)
            ..light_particle(400.0, 400.0, 0)
        });
        let y_before = w.particle_store.y[0];
        for _ in 0..120 {
            apply_forces(&mut w, 1.0 / 60.0);
            w.t += 1.0 / 60.0;
        }
        let y_after = w.particle_store.y[0];
        // Light particle should have risen (y decreased).
        assert!(y_after < y_before, "y_before={y_before} y_after={y_after}");
    }

    #[test]
    fn dense_particle_sinks() {
        let mut w = World::new(800.0, 600.0, 1);
        w.surface_amp = 0.0;
        w.swell_amp = 0.0;
        w.z_stir_amp = 0.0;
        w.brownian_amp = 0.0;
        w.updraft_amp = 0.0;
        w.current_amp = 0.0;
        w.particle_store.push(ParticleInit {
            density: 4.0,
            ..light_particle(400.0, 400.0, 0)
        });
        let y_before = w.particle_store.y[0];
        for _ in 0..120 {
            apply_forces(&mut w, 1.0 / 60.0);
            w.t += 1.0 / 60.0;
        }
        let y_after = w.particle_store.y[0];
        assert!(y_after > y_before);
    }

    #[test]
    fn velocity_cap_holds() {
        // Pump up wave amp and run many ticks; horizontal speed must
        // saturate at ~1.3 max(c_s, c_l) and not blow past it.
        let mut w = World::new(800.0, 600.0, 1);
        w.brownian_amp = 0.0;
        w.particle_store.push(light_particle(400.0, 100.0, 0));
        for _ in 0..600 {
            apply_forces(&mut w, 1.0 / 60.0);
            w.t += 1.0 / 60.0;
        }
        let p = crate::world::build_particle_force_params(&w, 1.0 / 60.0);
        let cap = 1.3 * (p.w_s / p.k_s).max(p.w_l / p.k_l);
        let vx = w.particle_store.vx[0];
        assert!(vx.abs() <= cap + 1e-3, "vx={vx} cap={cap}");
    }
}
