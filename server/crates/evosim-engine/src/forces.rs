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

        // Water-surface clamp. Buoyant particles (density < 1, e.g.
        // gases) try to keep rising forever. Hold them at-or-below
        // surface_y so they bob along the surface like real bubbles
        // instead of drifting into the air column. Heavy particles
        // hit this no-op since their velocity is already downward.
        let mut new_y = yi + vyi * dt;
        if new_y < surface_y {
            new_y = surface_y;
            if vyi < 0.0 {
                vyi = 0.0;
            }
        }

        pvx[i] = vxi;
        pvy[i] = vyi;
        pvz[i] = vzi;
        px[i] = xi + vxi * dt;
        py[i] = new_y;
        pz[i] += vzi * dt;
    }
}

/// Convenience wrapper around `apply_particle_forces_range` that runs
/// the kernel across every particle in `world`. Three dispatch paths:
///
///   `gpu`        N >= GPU_FORCES_THRESHOLD and a wgpu pipeline is
///                installed -- compute shader on the GPU
///   `parallel`   N >= PARALLEL_THRESHOLD -- rayon par_chunks_mut
///   `serial`     otherwise -- the original strictly-serial loop
///
/// The GPU + parallel paths share the per-chunk / per-particle PCG
/// pattern for Brownian noise (matches `gpu-forces-shader.ts`). The
/// serial path keeps the engine's documented "deterministic only on
/// the serial CPU path" invariant.
pub fn apply_forces(world: &mut World, dt: f32) {
    if world.particle_store.n == 0 {
        return;
    }
    let params = crate::world::build_particle_force_params(world, dt);
    let mat_base = &crate::chemistry::table().base_density[..];
    let n = world.particle_store.n;
    // GPU path -- if the pipeline is installed on the world AND N is
    // past the GPU-vs-CPU breakeven, dispatch the compute kernel.
    if n >= crate::gpu_forces::GPU_FORCES_THRESHOLD {
        if let Some(gpu) = world.gpu_forces.as_mut() {
            let tick_seed = world.sim_rng.peek_state();
            let _ = world.sim_rng.next_u32();
            gpu.dispatch(&mut world.particle_store, mat_base, &params, tick_seed);
            return;
        }
    }
    if n >= PARALLEL_THRESHOLD {
        let tick_seed = world.sim_rng.peek_state();
        // Pull a single draw so the serial-path determinism boundary is
        // crisp: ticks that take the parallel path advance the serial
        // RNG by exactly one draw (matching the count the parallel
        // kernel doesn't make against it).
        let _ = world.sim_rng.next_u32();
        apply_particle_forces_parallel(
            &mut world.particle_store,
            mat_base,
            tick_seed,
            &params,
        );
    } else {
        apply_particle_forces_range(
            &mut world.particle_store,
            mat_base,
            &mut world.sim_rng,
            0,
            n,
            &params,
        );
    }
}

/// Particles below this count run on the serial path. The force
/// kernel is intrinsically cheap (~30 float ops per particle), so the
/// rayon dispatch + work-stealing overhead exceeds the savings until
/// the workload crosses this threshold. Tuned against the bench
/// harness: at cap=500 the serial path is 0.05 ms; the parallel path
/// is 0.19 ms (slower by 3.5x) so we stay serial. At cap=4000 the
/// parallel path wins decisively.
const PARALLEL_THRESHOLD: usize = 2048;
/// Particles per rayon chunk. Sized so a 4k-particle world lands
/// ~8 chunks across a modern 4-8 core box -- enough to amortise
/// dispatch overhead, small enough that work stays balanced.
const PARALLEL_CHUNK: usize = 512;

/// PCG32 step used for per-chunk Brownian noise. Tiny: 8 bytes of
/// state, two multiplies + one rotate per draw. Returns a uniform
/// `[0, 1)` f32. Independent from the serial Mulberry32 stream so the
/// parallel path's RNG draws can run unsynchronised across threads.
#[inline]
fn pcg32_next(state: &mut u64) -> f32 {
    let old = *state;
    *state = old.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1442695040888963407);
    let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
    let rot = (old >> 59) as u32;
    let mixed = xorshifted.rotate_right(rot);
    (mixed as f32) / 4_294_967_296.0
}

fn pcg32_seed(tick_seed: u32, chunk_idx: usize) -> u64 {
    // Stable per (tick, chunk) seed -- matches the wgpu shader's
    // approach so the GPU + parallel CPU paths land in the same
    // probability distribution per slot, even if not the same draws.
    let mut s = (tick_seed as u64) << 32 | (chunk_idx as u64) ^ 0x9E37_79B9_7F4A_7C15;
    s ^= s >> 30;
    s = s.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    s ^= s >> 27;
    s = s.wrapping_mul(0x94D0_49BB_1331_11EB);
    s ^= s >> 31;
    s
}

/// Parallel force kernel: identical math to `apply_particle_forces_range`
/// except for Brownian noise (per-chunk PCG instead of the serial RNG).
/// Splits the SoA columns into `PARALLEL_CHUNK`-sized stripes and
/// dispatches each chunk to a rayon worker.
fn apply_particle_forces_parallel(
    store: &mut ParticleStore,
    mat_base: &[f32],
    tick_seed: u32,
    p: &ParticleForceParams,
) {
    use rayon::prelude::*;
    let n = store.n;
    if n == 0 {
        return;
    }
    let v_x_cap = {
        let c_s = p.w_s / p.k_s;
        let c_l = p.w_l / p.k_l;
        1.3 * c_s.max(c_l)
    };

    // The immutable columns can be borrowed once and shared across
    // closures by reference -- rayon handles the per-thread reads.
    let pr = &store.r[..];
    let pdens = &store.density[..];
    let pmat = &store.chem_id[..];

    // Split each mutable column into PARALLEL_CHUNK stripes. Zipping
    // the parallel chunk iterators of multiple disjoint &mut slices
    // produces a tuple chain rayon can dispatch over.
    let px = store.x.par_chunks_mut(PARALLEL_CHUNK);
    let py = store.y.par_chunks_mut(PARALLEL_CHUNK);
    let pz = store.z.par_chunks_mut(PARALLEL_CHUNK);
    let pvx = store.vx.par_chunks_mut(PARALLEL_CHUNK);
    let pvy = store.vy.par_chunks_mut(PARALLEL_CHUNK);
    let pvz = store.vz.par_chunks_mut(PARALLEL_CHUNK);

    px.zip(py)
        .zip(pz)
        .zip(pvx)
        .zip(pvy)
        .zip(pvz)
        .enumerate()
        .for_each(|(ci, (((((cx, cy), cz), cvx), cvy), cvz))| {
            let from = ci * PARALLEL_CHUNK;
            let to = (from + cx.len()).min(n);
            let mut rng = pcg32_seed(tick_seed, ci);
            for (local, _i) in (from..to).enumerate() {
                let xi = cx[local];
                let yi = cy[local];
                let ri = pr[from + local];
                let mut vxi = cvx[local];
                let mut vyi = cvy[local];
                let mut vzi = cvz[local];
                let override_d = pdens[from + local];
                let density = if override_d != 0.0 {
                    override_d
                } else {
                    mat_base[pmat[from + local] as usize]
                };

                let mut ay = p.gravity * (1.0 - 1.0 / density);
                if ay < -p.gravity {
                    ay = -p.gravity;
                } else if ay > p.gravity {
                    ay = p.gravity;
                }
                let depth = if yi > p.surface_y { yi - p.surface_y } else { 0.0 };

                let surf_pr = p.k_s * xi - p.w_s * p.t;
                let surf_pl = 1.3 * p.k_s * xi + 1.3 * p.w_s * p.t + 1.1;
                let swell_pr = p.k_l * xi - p.w_l * p.t;
                let swell_pl = 1.4 * p.k_l * xi + 1.4 * p.w_l * p.t + 0.4;
                let surface = p.surf_amp
                    * 0.5
                    * (surf_pr.sin() + surf_pl.sin())
                    * (-depth / p.surface_decay).exp();
                let swell = p.swell_amp
                    * 0.5
                    * (swell_pr.sin() + swell_pl.sin())
                    * (-depth / p.swell_decay).exp();
                let az = p.z_amp
                    * (p.w_l * p.t + p.k_l * xi + 1.0).sin()
                    * (-depth / p.swell_decay).exp();
                let splash = if depth < SPLASH_DEPTH {
                    p.surf_amp
                        * SPLASH_GAIN
                        * 0.5
                        * (surf_pr.cos() + surf_pl.cos())
                        * (-depth / SPLASH_DEPTH).exp()
                } else {
                    0.0
                };
                let updraft = -p.updraft_amp * p.updraft_env * (p.k_u * xi + p.w_u * p.t).sin();
                let depth_frac = depth / p.col_depth;
                let current = p.current_amp
                    * (std::f32::consts::PI * depth_frac).cos()
                    * p.current_drift;

                let noise_env = (-depth / 400.0).exp();
                let noise_x = p.b_amp * noise_env * (pcg32_next(&mut rng) - 0.5) * 2.0;
                let noise_y = p.b_amp * noise_env * (pcg32_next(&mut rng) - 0.5) * 2.0;

                let ax = surface + swell + current + noise_x;
                let ay_tot = ay + splash + updraft + noise_y;

                let drag_scale = ri / DRAG_REF_R;
                let dscale_drag = p.drag * drag_scale;
                vxi += (ax - dscale_drag * vxi) * p.dt;
                vyi += (ay_tot - dscale_drag * vyi) * p.dt;
                vzi += (az - dscale_drag * vzi) * p.dt;

                if vxi > v_x_cap {
                    vxi = v_x_cap;
                } else if vxi < -v_x_cap {
                    vxi = -v_x_cap;
                }

                // Water-surface clamp matches the serial kernel.
                let mut new_y = yi + vyi * p.dt;
                if new_y < p.surface_y {
                    new_y = p.surface_y;
                    if vyi < 0.0 {
                        vyi = 0.0;
                    }
                }

                cvx[local] = vxi;
                cvy[local] = vyi;
                cvz[local] = vzi;
                cx[local] = xi + vxi * p.dt;
                cy[local] = new_y;
                cz[local] += vzi * p.dt;
            }
        });
}

/// Quick microbench: time the serial vs parallel kernels at high N.
/// Returns `(serial_ms, parallel_ms)`. Excluded from `cargo test` to
/// avoid timing-noisy assertions; runs only on explicit invocation
/// via `cargo test --release perf_forces -- --ignored --nocapture`.
#[doc(hidden)]
pub fn microbench_forces(n: usize, iters: usize) -> (f64, f64) {
    use crate::particles::ParticleInit;
    use std::time::Instant;
    // Build a synthetic store of N light particles.
    let mut store = ParticleStore::new();
    for i in 0..n {
        store.push(ParticleInit {
            x: (i % 1000) as f32,
            y: ((i / 1000) % 600) as f32,
            r: 2.0,
            chem_id: 0,
            density: 1.0,
            ..ParticleInit::default()
        });
    }
    let p = ParticleForceParams {
        dt: 1.0 / 60.0,
        t: 0.0,
        drag: 1.5,
        gravity: 40.0,
        surface_y: 120.0,
        surface_decay: 60.0,
        swell_decay: 200.0,
        updraft_amp: 6.0,
        current_amp: 4.0,
        k_s: 0.025,
        w_s: 1.5,
        k_l: 0.007,
        w_l: 0.7,
        k_u: 0.011,
        w_u: 0.8,
        surf_amp: 55.0,
        swell_amp: 16.0,
        z_amp: 6.0,
        b_amp: 12.0,
        updraft_env: 1.0,
        col_depth: 480.0,
        current_drift: 0.0,
        world_floor_y: 600.0,
        world_width: 1000.0,
    };
    let mat_base = &crate::chemistry::table().base_density[..];

    // Serial path.
    let mut rng = Mulberry32::new(1);
    let t0 = Instant::now();
    for _ in 0..iters {
        apply_particle_forces_range(&mut store, mat_base, &mut rng, 0, n, &p);
    }
    let serial_ms = t0.elapsed().as_secs_f64() * 1000.0 / iters as f64;

    // Parallel path. Reset positions so the heat factor matches.
    for i in 0..n {
        store.x[i] = (i % 1000) as f32;
        store.y[i] = ((i / 1000) % 600) as f32;
        store.vx[i] = 0.0;
        store.vy[i] = 0.0;
        store.vz[i] = 0.0;
    }
    let t0 = Instant::now();
    for it in 0..iters {
        apply_particle_forces_parallel(&mut store, mat_base, it as u32, &p);
    }
    let parallel_ms = t0.elapsed().as_secs_f64() * 1000.0 / iters as f64;
    (serial_ms, parallel_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::particles::ParticleInit;

    fn light_particle(x: f32, y: f32, chem_id: u8) -> ParticleInit {
        ParticleInit { x, y, r: 2.0, chem_id, density: 0.0, ..ParticleInit::default() }
    }

    /// Microbench: prove the parallel kernel wins at high N. Ignored by
    /// default to keep `cargo test` quiet; run with `cargo test
    /// --release perf_forces_parallel_wins -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn perf_forces_parallel_wins() {
        for n in [1024_usize, 2048, 4096, 8192] {
            let (s, par) = super::microbench_forces(n, 50);
            let speedup = s / par.max(1e-6);
            println!(
                "N={n:>5}  serial={s:>6.2} ms  parallel={par:>6.2} ms  speedup={speedup:>4.2}x"
            );
        }
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

    /// Buoyancy stops at the water surface -- a particle floating up
    /// must not drift into the air column. Without the clamp added in
    /// this fix, gas particles drifted up indefinitely past surface_y,
    /// which the user reported as "bubbles rise up through the air".
    #[test]
    fn buoyant_particle_clamps_at_surface() {
        let mut w = World::new(800.0, 600.0, 1);
        w.surface_y = 100.0;
        // Disable wave/brownian so the surface clamp is the only
        // force keeping y at the boundary -- a noisy kernel could
        // bounce the particle around enough to fool the assertion.
        w.surface_amp = 0.0;
        w.swell_amp = 0.0;
        w.z_stir_amp = 0.0;
        w.brownian_amp = 0.0;
        w.updraft_amp = 0.0;
        w.current_amp = 0.0;
        w.particle_store.push(ParticleInit {
            x: 400.0,
            y: 300.0,
            r: 2.0,
            chem_id: 0,
            density: 0.1, // very buoyant
            ..ParticleInit::default()
        });
        for _ in 0..600 {
            apply_forces(&mut w, 1.0 / 60.0);
            w.t += 1.0 / 60.0;
        }
        let y_after = w.particle_store.y[0];
        assert!(
            y_after >= w.surface_y - 0.01,
            "buoyant particle drifted above surface: y={} surface_y={}",
            y_after,
            w.surface_y
        );
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
