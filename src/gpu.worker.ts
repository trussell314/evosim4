// WebGPU host worker. Holds a GPUDevice + compute pipeline for the
// particle force kernel, services dispatch requests from sim.worker via
// SAB+Atomics (mirroring the CPU pool's barrier protocol), and signals
// completion back the same way.
//
// Why a separate worker (rather than running WebGPU inside the sim
// worker directly)? GPU readback is unavoidably async (`mapAsync`), and
// the sim worker can't block on Atomics.wait while a JS-thread callback
// resolves -- the wait blocks the same event loop the callback runs on,
// deadlocking the round-trip. Putting WebGPU in a dedicated worker
// gives the readback its own event loop while the sim worker blocks
// only on the completion notify. Preserves the existing synchronous
// step/applyForces pattern across all 185 call sites in the codebase.
//
// Determinism: the brownian term uses a per-particle PCG keyed by
// (tickSeed, particleIndex) instead of mulberry32 -- the CPU subworker
// pool path is already non-deterministic for brownian (each worker
// instantiates its own simRng = Math.random at module load), so this
// preserves the existing "deterministic only in the strictly serial
// path" property without weakening it.

import {
  type ParticleSharedLayout,
} from "./sim";
import {
  GPU_FORCES_WGSL,
  GPU_PARTICLE_STRIDE,
  GPU_PARAMS_BYTES,
  GPU_CTRL_PHASE,
  GPU_CTRL_NP,
  GPU_CTRL_DONE,
  GPU_CTRL_CMD,
  GPU_CTRL_TICK_SEED,
  GPU_CMD_FORCES,
  GPU_CMD_SHUTDOWN,
  GPU_PARAM_FIELDS,
} from "./sim/gpu-forces-shader";
import { CHEM_BASE_DENSITY } from "./sim/chemistry";

let ctrl: Int32Array | null = null;
let paramsView: Float64Array | null = null;
let pviews: {
  x: Float32Array; y: Float32Array; z: Float32Array;
  vx: Float32Array; vy: Float32Array; vz: Float32Array;
  r: Float32Array; density: Float32Array; chemId: Uint8Array;
} | null = null;
let matBase: Float32Array = CHEM_BASE_DENSITY;
let device: GPUDevice | null = null;
let pipeline: GPUComputePipeline | null = null;
let uniformBuf: GPUBuffer | null = null;
let particleBuf: GPUBuffer | null = null;
let readbackBuf: GPUBuffer | null = null;
let bindGroup: GPUBindGroup | null = null;
let particleBufCap = 0;
// Reused scratch for packing/unpacking the 8-float Particle struct.
let packed: Float32Array = new Float32Array(0);

(self as unknown as Worker).postMessage({ type: "ack-load" });

self.addEventListener("message", (e: MessageEvent) => {
  const m = e.data;
  if (!m || m.type !== "init") return;
  void initWorker(m).catch((err) => {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    (self as unknown as Worker).postMessage({ type: "ack-init-error", error: msg });
  });
});

async function initWorker(m: {
  particleLayout: ParticleSharedLayout;
  controlBuffer: SharedArrayBuffer;
  paramsBuffer: SharedArrayBuffer;
  matBase?: Float32Array;
}): Promise<void> {
  if (m.matBase) matBase = m.matBase;
  ctrl = new Int32Array(m.controlBuffer);
  paramsView = new Float64Array(m.paramsBuffer);
  if (paramsView.length < GPU_PARAM_FIELDS) {
    throw new Error(`paramsBuffer too small: ${paramsView.length} < ${GPU_PARAM_FIELDS}`);
  }
  pviews = rebuildParticleViews(m.particleLayout);
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) throw new Error("navigator.gpu unavailable");
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error("no GPU adapter");
  device = await adapter.requestDevice();
  device.lost.then((info) => {
    // eslint-disable-next-line no-console
    console.warn("[gpu worker] device lost:", info.reason, info.message);
    device = null;
  });
  const module = device.createShaderModule({ code: GPU_FORCES_WGSL });
  pipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module, entryPoint: "main" },
  });
  uniformBuf = device.createBuffer({
    size: GPU_PARAMS_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  (self as unknown as Worker).postMessage({ type: "ack-init" });
  void loop();
}

function rebuildParticleViews(layout: ParticleSharedLayout): typeof pviews {
  const b = layout.buffer;
  const o = layout.offsets;
  const cap = layout.cap;
  return {
    x: new Float32Array(b, o.x, cap),
    y: new Float32Array(b, o.y, cap),
    z: new Float32Array(b, o.z, cap),
    vx: new Float32Array(b, o.vx, cap),
    vy: new Float32Array(b, o.vy, cap),
    vz: new Float32Array(b, o.vz, cap),
    r: new Float32Array(b, o.r, cap),
    density: new Float32Array(b, o.density, cap),
    chemId: new Uint8Array(b, o.chemId, cap),
  };
}

function ensureGpuBuffers(np: number): void {
  if (!device) return;
  if (np > particleBufCap) {
    if (particleBuf) particleBuf.destroy();
    if (readbackBuf) readbackBuf.destroy();
    particleBufCap = Math.max(np, 1024);
    const bytes = particleBufCap * GPU_PARTICLE_STRIDE;
    particleBuf = device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    readbackBuf = device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    bindGroup = device.createBindGroup({
      layout: pipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuf! } },
        { binding: 1, resource: { buffer: particleBuf } },
      ],
    });
    if (packed.length < particleBufCap * 8) packed = new Float32Array(particleBufCap * 8);
  }
}

// Stub for waitAsync: Chrome's Atomics.waitAsync is well supported in
// workers as of 2024+, but type lib varies. Treat as { async: boolean,
// value: Promise<...> | string }.
type WaitAsyncResult = { async: false; value: "ok" | "not-equal" | "timed-out" }
  | { async: true; value: Promise<"ok" | "timed-out"> };

async function waitAsync(buf: Int32Array, idx: number, expected: number): Promise<string> {
  const A = Atomics as unknown as { waitAsync?: (b: Int32Array, i: number, v: number) => WaitAsyncResult };
  if (typeof A.waitAsync === "function") {
    const r = A.waitAsync(buf, idx, expected);
    if (r.async) return await r.value;
    return r.value;
  }
  // Fallback: poll. Acceptable on browsers without waitAsync (rare).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Atomics.load(buf, idx) !== expected) return "ok";
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function loop(): Promise<void> {
  let lastPhase = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await waitAsync(ctrl!, GPU_CTRL_PHASE, lastPhase);
    const phase = Atomics.load(ctrl!, GPU_CTRL_PHASE);
    if (phase === lastPhase) continue;
    lastPhase = phase;
    const cmd = Atomics.load(ctrl!, GPU_CTRL_CMD);
    if (cmd === GPU_CMD_SHUTDOWN) break;
    if (cmd === GPU_CMD_FORCES) {
      try {
        const np = Atomics.load(ctrl!, GPU_CTRL_NP);
        if (np > 0 && pviews && device && pipeline && uniformBuf) {
          await runForces(np);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[gpu worker] forces dispatch threw:", err);
      }
    }
    // Mark done. sim.worker uses Atomics.wait on GPU_CTRL_DONE.
    Atomics.store(ctrl!, GPU_CTRL_DONE, 1);
    Atomics.notify(ctrl!, GPU_CTRL_DONE, 1);
  }
}

async function runForces(np: number): Promise<void> {
  ensureGpuBuffers(np);
  const d = device!;
  const buf = particleBuf!;
  const rb = readbackBuf!;
  const bg = bindGroup!;
  const v = pviews!;
  // Pack SoA -> packed AoS (8 f32 per particle: x,y,z,r,vx,vy,vz,densityEff).
  const pk = packed;
  for (let i = 0; i < np; i++) {
    const o = i * 8;
    pk[o] = v.x[i];
    pk[o + 1] = v.y[i];
    pk[o + 2] = v.z[i];
    pk[o + 3] = v.r[i];
    pk[o + 4] = v.vx[i];
    pk[o + 5] = v.vy[i];
    pk[o + 6] = v.vz[i];
    const dOv = v.density[i];
    pk[o + 7] = dOv !== 0 ? dOv : (matBase[v.chemId[i]] || 1);
  }
  d.queue.writeBuffer(buf, 0, pk.buffer, pk.byteOffset, np * GPU_PARTICLE_STRIDE);
  // Pack params (matches WGSL Params struct order).
  const p = paramsView!;
  const tickSeed = Atomics.load(ctrl!, GPU_CTRL_TICK_SEED) >>> 0;
  const uf = new Float32Array(GPU_PARAMS_BYTES / 4);
  const uu = new Uint32Array(uf.buffer);
  uf[0] = p[0]; uf[1] = p[1]; uf[2] = p[2]; uf[3] = p[3];        // dt, t, drag, gravity
  uf[4] = p[4]; uf[5] = p[5]; uf[6] = p[6]; uf[7] = p[7];        // surfaceY, surfaceDecay, swellDecay, updraftAmp
  uf[8] = p[8]; uf[9] = p[9]; uf[10] = p[10]; uf[11] = p[11];    // currentAmp, kS, wS, kL
  uf[12] = p[12]; uf[13] = p[13]; uf[14] = p[14]; uf[15] = p[15]; // wL, kU, wU, surfAmp
  uf[16] = p[16]; uf[17] = p[17]; uf[18] = p[18]; uf[19] = p[19]; // swellAmp, zAmp, bAmp, updraftEnv
  uf[20] = p[20]; uf[21] = p[21]; uf[22] = p[22]; uf[23] = p[23]; // colDepth, currentDrift, worldFloorY, worldWidth
  uu[24] = np >>> 0;
  uu[25] = tickSeed;
  // uf[26], uf[27] = pad (default zero).
  d.queue.writeBuffer(uniformBuf!, 0, uf.buffer, uf.byteOffset, GPU_PARAMS_BYTES);
  // Encode + submit.
  const wgCount = Math.ceil(np / 64);
  const enc = d.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline!);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(wgCount);
  pass.end();
  enc.copyBufferToBuffer(buf, 0, rb, 0, np * GPU_PARTICLE_STRIDE);
  d.queue.submit([enc.finish()]);
  // Read back.
  await rb.mapAsync(GPUMapMode.READ, 0, np * GPU_PARTICLE_STRIDE);
  const view = new Float32Array(rb.getMappedRange(0, np * GPU_PARTICLE_STRIDE));
  for (let i = 0; i < np; i++) {
    const o = i * 8;
    v.x[i] = view[o];
    v.y[i] = view[o + 1];
    v.z[i] = view[o + 2];
    // r and densityEff are read-only on GPU side.
    v.vx[i] = view[o + 4];
    v.vy[i] = view[o + 5];
    v.vz[i] = view[o + 6];
  }
  rb.unmap();
}
