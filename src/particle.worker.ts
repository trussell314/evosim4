// Particle subworker. One of a pool spawned by sim.worker.ts to run
// the per-particle portion of applyForces in parallel. Communication
// is barrier-style on a control SharedArrayBuffer via Atomics; the
// particle SoA columns are direct views over the sim worker's
// SharedArrayBuffer so the math reads / writes the same memory the
// sim worker is about to read for collisions.
//
// Init payload (one-time):
//   { type: "init",
//     particleLayout: ParticleSharedLayout,
//     controlBuffer: SharedArrayBuffer,      // Int32 control words
//     paramsBuffer: SharedArrayBuffer,       // Float64 params block
//     matBase: Float32Array,                 // material base density
//     workerIndex: number,                   // 0..nWorkers-1
//     nWorkers: number }
//
// Then this worker Atomics.wait()s on the phase counter; when it
// changes, processes its assigned slice; Atomics.adds to the done
// counter; notifies the sim worker.

import {
  applyParticleForcesRange,
  type ParticleSharedLayout,
  type ParticleForceParams,
} from "./sim";

const PARAM_COUNT = 22;

// Control buffer layout (Int32):
//   [0] phase  -- sim worker increments each tick; subworker
//                 Atomics.wait()s for it to differ from lastPhase
//   [1] done   -- subworkers Atomics.add(+1) when they finish; sim
//                 worker Atomics.wait()s until it equals nWorkers
//   [2] np     -- current particle count this tick
//   [3] stop   -- nonzero asks the subworker to exit cleanly
const CTRL_PHASE = 0;
const CTRL_DONE = 1;
const CTRL_NP = 2;
const CTRL_STOP = 3;

let particleLayout: ParticleSharedLayout | null = null;
let ctrl: Int32Array | null = null;
let paramsView: Float64Array | null = null;
let matBase: Float32Array | null = null;
let workerIndex = 0;
let nWorkers = 1;
let views: {
  PX: Float32Array; PY: Float32Array; PZ: Float32Array;
  PVX: Float32Array; PVY: Float32Array; PVZ: Float32Array;
  PR: Float32Array; PDENS: Float32Array; PMAT: Uint8Array;
} | null = null;

function rebuildViews(layout: ParticleSharedLayout): typeof views {
  const b = layout.buffer;
  const o = layout.offsets;
  const cap = layout.cap;
  return {
    PX: new Float32Array(b, o.x, cap),
    PY: new Float32Array(b, o.y, cap),
    PZ: new Float32Array(b, o.z, cap),
    PVX: new Float32Array(b, o.vx, cap),
    PVY: new Float32Array(b, o.vy, cap),
    PVZ: new Float32Array(b, o.vz, cap),
    PR: new Float32Array(b, o.r, cap),
    PDENS: new Float32Array(b, o.density, cap),
    PMAT: new Uint8Array(b, o.material, cap),
  };
}

function readParams(): ParticleForceParams {
  const p = paramsView!;
  return {
    dt: p[0],
    t: p[1],
    drag: p[2],
    gravity: p[3],
    surfaceY: p[4],
    surfaceDecay: p[5],
    swellDecay: p[6],
    updraftAmp: p[7],
    currentAmp: p[8],
    kS: p[9], wS: p[10],
    kL: p[11], wL: p[12],
    kU: p[13], wU: p[14],
    surfAmp: p[15],
    swellAmp: p[16],
    zAmp: p[17],
    bAmp: p[18],
    updraftEnv: p[19],
    colDepth: p[20],
    currentDrift: p[21],
  };
}

self.addEventListener("message", (e: MessageEvent) => {
  const m = e.data;
  if (m.type !== "init") return;
  particleLayout = m.particleLayout;
  workerIndex = m.workerIndex | 0;
  nWorkers = Math.max(1, m.nWorkers | 0);
  matBase = m.matBase;
  ctrl = new Int32Array(m.controlBuffer);
  // Params buffer holds PARAM_COUNT Float64 slots; sim worker writes,
  // we read. Aligned at offset 0 of its own SAB.
  paramsView = new Float64Array(m.paramsBuffer);
  if (paramsView.length < PARAM_COUNT) {
    // eslint-disable-next-line no-console
    console.error("[particle worker] paramsBuffer too small");
    return;
  }
  views = rebuildViews(particleLayout!);
  loop();
});

function loop(): void {
  // Spin-and-wait on the phase counter. Each tick the sim worker
  // increments it and Atomics.notify()s; we wake, run our slice,
  // increment the done counter, and notify back.
  let lastPhase = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    Atomics.wait(ctrl!, CTRL_PHASE, lastPhase);
    if (Atomics.load(ctrl!, CTRL_STOP) !== 0) return;
    const phase = Atomics.load(ctrl!, CTRL_PHASE);
    lastPhase = phase;
    const np = Atomics.load(ctrl!, CTRL_NP);
    if (np > 0 && views && matBase) {
      // Even-split partition of [0, np) across nWorkers.
      const chunk = Math.floor(np / nWorkers);
      const rem = np - chunk * nWorkers;
      const from = workerIndex * chunk + Math.min(workerIndex, rem);
      const extra = workerIndex < rem ? 1 : 0;
      const to = from + chunk + extra;
      const params = readParams();
      applyParticleForcesRange(
        views.PX, views.PY, views.PZ,
        views.PVX, views.PVY, views.PVZ,
        views.PR, views.PDENS, views.PMAT,
        matBase, from, to, params,
      );
    }
    Atomics.add(ctrl!, CTRL_DONE, 1);
    Atomics.notify(ctrl!, CTRL_DONE);
  }
}
