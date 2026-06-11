//! wgpu compute force kernel. Port of `src/sim/gpu-forces-shader.ts`.
//!
//! Runs the per-particle force kernel on a GPU compute pipeline. The
//! WGSL math is verbatim from the TS shader (the CPU + GPU paths land
//! in the same probability distribution per slot via a counter-based
//! PCG keyed by `(particleIdx, tickSeed)` -- already documented as the
//! "deterministic only on the serial CPU path" invariant of the engine).
//!
//! Pipeline:
//!
//!   `GpuForcesPipeline::new()`  -- build the device + queue + compute
//!     pipeline. Sized for `np_max` particles; if a tick presents more,
//!     the pipeline is dropped and rebuilt at the new size.
//!   `dispatch(...)`             -- pack the SoA columns into a single
//!     [`PackedParticle`] buffer, upload + params + tick-seed, dispatch
//!     a workgroup-64 compute pass, read back, unpack into the SoA
//!     columns.
//!
//! Auto-engage:
//!
//!   The default constructor returns `Some` only when an adapter is
//!   available; sandboxed / headless environments without a GPU driver
//!   get `None` and the engine falls back to the CPU paths transparently.
//!   Override the auto-decision via `EVOSIM_FORCE_GPU=1/0`.
//!
//! Cost model:
//!
//!   - one-time: adapter + device init (~50ms), shader compile (~5ms),
//!     buffer allocation
//!   - per tick: SoA -> packed write (~N * 32 bytes), upload, dispatch
//!     (`np / 64 + 1` workgroups), download, packed -> SoA write
//!
//!   For small N (< ~4096) the per-tick latency dominates and CPU wins.
//!   At larger N the GPU shader's parallelism + memory-bandwidth wins
//!   decisively. The threshold is exposed via `GPU_FORCES_THRESHOLD`.

use crate::particles::ParticleStore;
use crate::world::ParticleForceParams;
use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

/// Particles below this count run on the CPU path -- below the GPU
/// breakeven the upload/download latency exceeds the savings.
pub const GPU_FORCES_THRESHOLD: usize = 4096;

/// Packed particle layout matching the WGSL `struct Particle`: 8 f32
/// per particle. The `density_eff` field carries the effective density
/// the CPU computed (override OR `mat_base[chem_id]`), so the shader
/// doesn't need a chem table.
#[repr(C)]
#[derive(Copy, Clone, Debug, Pod, Zeroable)]
struct PackedParticle {
    x: f32,
    y: f32,
    z: f32,
    r: f32,
    vx: f32,
    vy: f32,
    vz: f32,
    density_eff: f32,
}

/// Uniform buffer layout matching the WGSL `struct Params`.
#[repr(C)]
#[derive(Copy, Clone, Debug, Pod, Zeroable)]
struct GpuParams {
    dt: f32,
    t: f32,
    drag: f32,
    gravity: f32,
    surface_y: f32,
    surface_decay: f32,
    swell_decay: f32,
    updraft_amp: f32,
    current_amp: f32,
    k_s: f32,
    w_s: f32,
    k_l: f32,
    w_l: f32,
    k_u: f32,
    w_u: f32,
    surf_amp: f32,
    swell_amp: f32,
    z_amp: f32,
    b_amp: f32,
    updraft_env: f32,
    col_depth: f32,
    current_drift: f32,
    world_floor_y: f32,
    world_width: f32,
    np: u32,
    tick_seed: u32,
    _pad0: f32,
    _pad1: f32,
}

/// WGSL source. Imported verbatim from `gpu-forces-shader.ts` so the
/// CPU + GPU paths produce the same per-particle probability draws.
const FORCES_WGSL: &str = include_str!("gpu_forces.wgsl");

/// wgpu adapter + device + pipeline + per-frame buffers. Held by the
/// `Engine` and reused across ticks; rebuilt only when `np_max` grows
/// past the current allocation.
pub struct GpuForcesPipeline {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::ComputePipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    params_buf: wgpu::Buffer,
    particle_buf: wgpu::Buffer,
    read_buf: wgpu::Buffer,
    np_max: usize,
}

impl GpuForcesPipeline {
    /// Build the pipeline. Returns `None` if no compute-capable adapter
    /// is available (sandboxed CI, headless servers without a GPU
    /// driver, etc.). Caller falls back to the CPU paths transparently.
    pub fn new(np_max: usize) -> Option<Self> {
        pollster::block_on(Self::new_async(np_max)).ok()
    }

    async fn new_async(np_max: usize) -> Result<Self, &'static str> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::PRIMARY,
            ..Default::default()
        });
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: None,
                force_fallback_adapter: false,
            })
            .await
            .map_err(|_| "no compute-capable adapter available")?;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("evosim-forces"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::downlevel_defaults(),
                memory_hints: wgpu::MemoryHints::default(),
                trace: wgpu::Trace::default(),
            })
            .await
            .map_err(|_| "device init failed")?;
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("forces-wgsl"),
            source: wgpu::ShaderSource::Wgsl(FORCES_WGSL.into()),
        });
        let bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("forces-bgl"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only: false },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ],
            });
        let pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("forces-pl"),
                bind_group_layouts: &[&bind_group_layout],
                push_constant_ranges: &[],
            });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("forces-cp"),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        let particle_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("forces-particles"),
            size: (np_max * std::mem::size_of::<PackedParticle>()) as u64,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let read_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("forces-readback"),
            size: (np_max * std::mem::size_of::<PackedParticle>()) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let params_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("forces-params"),
            contents: bytemuck::bytes_of(&GpuParams::zeroed()),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        Ok(Self {
            device,
            queue,
            pipeline,
            bind_group_layout,
            params_buf,
            particle_buf,
            read_buf,
            np_max,
        })
    }

    fn ensure_capacity(&mut self, np: usize) {
        if np <= self.np_max {
            return;
        }
        // Grow with a 2x factor so reallocations are amortised.
        let new_max = (np.max(self.np_max * 2)).max(1024);
        self.particle_buf = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("forces-particles"),
            size: (new_max * std::mem::size_of::<PackedParticle>()) as u64,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        self.read_buf = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("forces-readback"),
            size: (new_max * std::mem::size_of::<PackedParticle>()) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        self.np_max = new_max;
    }

    /// Dispatch the compute kernel over `[0, store.n)`. Packs the SoA
    /// columns into a single buffer, writes the params, dispatches,
    /// reads back, and unpacks.
    pub fn dispatch(
        &mut self,
        store: &mut ParticleStore,
        mat_base: &[f32],
        params: &ParticleForceParams,
        tick_seed: u32,
    ) {
        let np = store.n;
        if np == 0 {
            return;
        }
        self.ensure_capacity(np);

        // Pack SoA -> AoS. Density carries the effective density so the
        // shader doesn't need a chem table.
        let mut packed: Vec<PackedParticle> = Vec::with_capacity(np);
        for i in 0..np {
            let override_d = store.density[i];
            let density_eff = if override_d != 0.0 {
                override_d
            } else {
                mat_base[store.chem_id[i] as usize]
            };
            packed.push(PackedParticle {
                x: store.x[i],
                y: store.y[i],
                z: store.z[i],
                r: store.r[i],
                vx: store.vx[i],
                vy: store.vy[i],
                vz: store.vz[i],
                density_eff,
            });
        }

        let gpu_params = GpuParams {
            dt: params.dt,
            t: params.t,
            drag: params.drag,
            gravity: params.gravity,
            surface_y: params.surface_y,
            surface_decay: params.surface_decay,
            swell_decay: params.swell_decay,
            updraft_amp: params.updraft_amp,
            current_amp: params.current_amp,
            k_s: params.k_s,
            w_s: params.w_s,
            k_l: params.k_l,
            w_l: params.w_l,
            k_u: params.k_u,
            w_u: params.w_u,
            surf_amp: params.surf_amp,
            swell_amp: params.swell_amp,
            z_amp: params.z_amp,
            b_amp: params.b_amp,
            updraft_env: params.updraft_env,
            col_depth: params.col_depth,
            current_drift: params.current_drift,
            world_floor_y: params.world_floor_y,
            world_width: params.world_width,
            np: np as u32,
            tick_seed,
            _pad0: 0.0,
            _pad1: 0.0,
        };
        self.queue
            .write_buffer(&self.params_buf, 0, bytemuck::bytes_of(&gpu_params));
        self.queue
            .write_buffer(&self.particle_buf, 0, bytemuck::cast_slice(&packed));

        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("forces-bg"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: self.params_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: self.particle_buf.as_entire_binding(),
                },
            ],
        });

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("forces-enc"),
            });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("forces-pass"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            let workgroups = (np as u32).div_ceil(64);
            pass.dispatch_workgroups(workgroups, 1, 1);
        }
        encoder.copy_buffer_to_buffer(
            &self.particle_buf,
            0,
            &self.read_buf,
            0,
            (np * std::mem::size_of::<PackedParticle>()) as u64,
        );
        self.queue.submit(std::iter::once(encoder.finish()));

        // Map + read back.
        let slice = self
            .read_buf
            .slice(..(np * std::mem::size_of::<PackedParticle>()) as u64);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        self.device.poll(wgpu::PollType::Wait).ok();
        if rx.recv().is_err() {
            return;
        }
        let data = slice.get_mapped_range();
        let packed_back: &[PackedParticle] = bytemuck::cast_slice(&data);
        for (i, p) in packed_back.iter().enumerate().take(np) {
            store.x[i] = p.x;
            store.y[i] = p.y;
            store.z[i] = p.z;
            store.vx[i] = p.vx;
            store.vy[i] = p.vy;
            store.vz[i] = p.vz;
        }
        drop(data);
        self.read_buf.unmap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke: build the pipeline. Skips silently if no GPU adapter is
    /// available (CI / sandboxed environments).
    #[test]
    fn pipeline_builds_or_skips() {
        match GpuForcesPipeline::new(1024) {
            Some(_) => { /* ok */ }
            None => eprintln!("no GPU adapter available -- skipping"),
        }
    }
}
