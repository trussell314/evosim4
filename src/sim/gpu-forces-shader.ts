// WebGPU compute shader (WGSL) for the per-particle force pass: a
// faithful translation of applyParticleForcesRange in sim.ts.
// Operates on a packed Particle buffer (8 f32 per particle) with the
// per-tick params in a uniform buffer. Brownian noise is computed
// per-particle via a counter-based PCG keyed by (particleIdx, tickSeed)
// instead of stepping the world's mulberry32 RNG -- the CPU subworker
// pool path is ALREADY non-deterministic for brownian (each pool
// worker has its own simRng = Math.random initialised at module load
// time), so this preserves the existing "deterministic only in the
// serial path" invariant while keeping the kernel parallel-safe.

export const GPU_FORCES_WGSL: string = /* wgsl */ `
struct Params {
  dt: f32,
  t: f32,
  drag: f32,
  gravity: f32,
  surfaceY: f32,
  surfaceDecay: f32,
  swellDecay: f32,
  updraftAmp: f32,
  currentAmp: f32,
  kS: f32, wS: f32,
  kL: f32, wL: f32,
  kU: f32, wU: f32,
  surfAmp: f32,
  swellAmp: f32,
  zAmp: f32,
  bAmp: f32,
  updraftEnv: f32,
  colDepth: f32,
  currentDrift: f32,
  worldFloorY: f32,
  worldWidth: f32,
  np: u32,
  tickSeed: u32,
  _pad0: f32, _pad1: f32,
};

struct Particle {
  x: f32, y: f32, z: f32, r: f32,
  vx: f32, vy: f32, vz: f32, densityEff: f32,
};

@group(0) @binding(0) var<uniform> u: Params;
@group(0) @binding(1) var<storage, read_write> P: array<Particle>;

const SPLASH_DEPTH: f32 = 30.0;
const SPLASH_GAIN: f32 = 1.5;
const DRAG_REF_R: f32 = 4.0;
const PI: f32 = 3.14159265358979;

// PCG-style hash for cheap per-particle uniform noise.
fn hash32(s: u32) -> u32 {
  var x: u32 = s * 747796405u + 2891336453u;
  let w: u32 = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rand01(seed: u32, i: u32, axis: u32) -> f32 {
  let mixed: u32 = hash32(seed ^ (i * 2654435761u + axis * 1597334677u));
  return f32(mixed) * (1.0 / 4294967296.0);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= u.np) { return; }
  var p = P[i];
  let xi = p.x; let yi = p.y; let ri = p.r;
  var vxi = p.vx; var vyi = p.vy; var vzi = p.vz;
  let density = p.densityEff;
  var ay = u.gravity * (1.0 - 1.0 / density);
  ay = clamp(ay, -u.gravity, u.gravity);
  let depth = max(0.0, yi - u.surfaceY);
  let surfPR = u.kS * xi - u.wS * u.t;
  let surfPL = 1.3 * u.kS * xi + 1.3 * u.wS * u.t + 1.1;
  let swellPR = u.kL * xi - u.wL * u.t;
  let swellPL = 1.4 * u.kL * xi + 1.4 * u.wL * u.t + 0.4;
  let surface = u.surfAmp * 0.5 * (sin(surfPR) + sin(surfPL)) * exp(-depth / u.surfaceDecay);
  let swell = u.swellAmp * 0.5 * (sin(swellPR) + sin(swellPL)) * exp(-depth / u.swellDecay);
  let az = u.zAmp * sin(u.wL * u.t + u.kL * xi + 1.0) * exp(-depth / u.swellDecay);
  var splash: f32 = 0.0;
  if (depth < SPLASH_DEPTH) {
    splash = u.surfAmp * SPLASH_GAIN * 0.5 * (cos(surfPR) + cos(surfPL)) * exp(-depth / SPLASH_DEPTH);
  }
  let updraft = -u.updraftAmp * u.updraftEnv * sin(u.kU * xi + u.wU * u.t);
  let depthFrac = depth / u.colDepth;
  let current = u.currentAmp * cos(PI * depthFrac) * u.currentDrift;
  let noiseEnv = exp(-depth / 400.0);
  let noiseX = u.bAmp * noiseEnv * (rand01(u.tickSeed, i, 0u) - 0.5) * 2.0;
  let noiseY = u.bAmp * noiseEnv * (rand01(u.tickSeed, i, 1u) - 0.5) * 2.0;
  let ax = surface + swell + current + noiseX;
  let ayTot = ay + splash + updraft + noiseY;
  let dragScale = ri / DRAG_REF_R;
  let dscaleDrag = u.drag * dragScale;
  vxi = vxi + (ax - dscaleDrag * vxi) * u.dt;
  vyi = vyi + (ayTot - dscaleDrag * vyi) * u.dt;
  vzi = vzi + (az - dscaleDrag * vzi) * u.dt;
  let cS = u.wS / u.kS; let cL = u.wL / u.kL;
  let vxCap = 1.3 * max(cS, cL);
  vxi = clamp(vxi, -vxCap, vxCap);
  p.vx = vxi; p.vy = vyi; p.vz = vzi;
  p.x = xi + vxi * u.dt;
  p.y = yi + vyi * u.dt;
  p.z = p.z + vzi * u.dt;
  P[i] = p;
}
`;

// Particle struct stride in BYTES (8 f32 per particle).
export const GPU_PARTICLE_STRIDE = 32;
// Uniform buffer size in BYTES (Params struct).
// 26 scalars (4 bytes each) + 2 pad floats = 112 bytes (multiple of 16).
export const GPU_PARAMS_BYTES = 112;
// Control slot offsets in the shared Int32 control buffer the sim worker
// uses to drive the gpu worker (mirrors the CPU pool layout).
export const GPU_CTRL_PHASE = 0;
export const GPU_CTRL_NP = 1;
export const GPU_CTRL_DONE = 2;
export const GPU_CTRL_CMD = 3;
export const GPU_CTRL_TICK_SEED = 4;
export const GPU_CTRL_SLOTS = 8;
export const GPU_CMD_NONE = 0;
export const GPU_CMD_FORCES = 1;
export const GPU_CMD_SHUTDOWN = 2;
// Param block fields in the SAB params buffer (Float64 to mirror the
// existing pool convention; gpu worker reads + writes a Float32 GPU
// uniform buffer).
export const GPU_PARAM_FIELDS = 24 as const;
