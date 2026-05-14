// Particle subworker. One of a pool spawned by sim.worker.ts. Handles
// two parallel-particle commands depending on what the sim worker
// signals through the control SAB:
//
//   CMD_FORCES (0)     -> applyForces' particle loop over a slice of [0, np)
//   CMD_COLLISIONS (1) -> applyCollisionsRowRange for a row-parity phase
//
// Both share the same Atomics-barrier loop on the control SAB: sim
// worker writes command + params, bumps phase, notifies; each
// subworker wakes, reads command, dispatches, increments done.

import {
  applyParticleForcesRange,
  applyCollisionsRowRange,
  type ParticleSharedLayout,
  type CollisionSharedLayout,
  type ParticleForceParams,
} from "./sim";

// Zero-length stub passed to applyParticleForcesRange when the
// collision SAB isn't shared (cviews === null). Out-of-bounds reads
// on a Uint8Array return 0, so ASLEEP[i] is always falsy and the
// freeze branch is skipped without an extra null check in the
// hot loop.
const EMPTY_ASLEEP = new Uint8Array(0);

// Must match PARAM_COUNT in sim.worker.ts (the producer side). One
// slot per field in ParticleForceParams. Last slot added: worldFloorY.
const PARAM_COUNT = 23;

// Control buffer layout (Int32):
//   [0] phase   -- sim worker increments each tick
//   [1] done    -- subworkers Atomics.add(+1) when finished
//   [2] np      -- forces command: current particle count
//   [3] stop    -- reserved (graceful shutdown)
//   [4] cmd     -- 0 = forces, 1 = collisions
//   [5] cCols   -- collisions: grid columns
//   [6] cRows   -- collisions: grid rows
//   [7] cParity -- collisions: 0 = even rows, 1 = odd rows
//   [8] cE      -- collisions: restitution e * 1e6 (scaled to int)
const CTRL_PHASE = 0;
const CTRL_DONE = 1;
const CTRL_NP = 2;
const CTRL_BARRIER = 3;
const CTRL_CMD = 4;
const CTRL_C_COLS = 5;
const CTRL_C_ROWS = 6;
const CTRL_C_PARITY = 7;
const CTRL_C_E = 8;

const CMD_FORCES = 0;
const CMD_COLLISIONS = 1;

let ctrl: Int32Array | null = null;
let paramsView: Float64Array | null = null;
let matBase: Float32Array | null = null;
let workerIndex = 0;
let nWorkers = 1;
let pviews: {
  PX: Float32Array; PY: Float32Array; PZ: Float32Array;
  PVX: Float32Array; PVY: Float32Array; PVZ: Float32Array;
  PR: Float32Array; PDENS: Float32Array; PMAT: Uint8Array;
} | null = null;
let cviews: {
  mass: Float32Array;
  asleep: Uint8Array;
  cellStart: Int32Array;
  cellItems: Int32Array;
} | null = null;

function rebuildParticleViews(layout: ParticleSharedLayout) {
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
    PMAT: new Uint8Array(b, o.chemId, cap),
  };
}

function rebuildCollisionViews(layout: CollisionSharedLayout) {
  const b = layout.buffer;
  const o = layout.offsets;
  // MASS and ASLEEP live in the same shared layout as the cell index.
  // They're written by the sim worker before each collision phase and
  // read by resolvePairSoa here; building views over the *shared*
  // buffer (rather than this worker's module-local copy from
  // sim.ts module init) is what makes the cross-worker handoff work.
  return {
    mass: new Float32Array(b, o.mass, layout.maxParticles),
    asleep: new Uint8Array(b, o.asleep, layout.maxParticles),
    cellStart: new Int32Array(b, o.cellStart, layout.maxCells + 1),
    cellItems: new Int32Array(b, o.cellItems, layout.maxParticles),
  };
}

function readForceParams(): ParticleForceParams {
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
    worldFloorY: p[22],
  };
}

// Earliest possible signal that the script reached module-top. If the
// parent never sees ack-load, the worker script itself isn't running
// (load failure, COEP rejection, or top-level throw before this line).
(self as unknown as Worker).postMessage({ type: "ack-load" });

self.addEventListener("message", (e: MessageEvent) => {
  const m = e.data;
  if (!m || m.type !== "init") return;
  try {
    workerIndex = m.workerIndex | 0;
    nWorkers = Math.max(1, m.nWorkers | 0);
    matBase = m.matBase;
    if (!m.controlBuffer || !m.paramsBuffer) {
      throw new Error(`missing buffers: ctrl=${!!m.controlBuffer} params=${!!m.paramsBuffer}`);
    }
    ctrl = new Int32Array(m.controlBuffer);
    paramsView = new Float64Array(m.paramsBuffer);
    if (paramsView.length < PARAM_COUNT) {
      throw new Error(`paramsBuffer too small: ${paramsView.length} < ${PARAM_COUNT}`);
    }
    pviews = rebuildParticleViews(m.particleLayout);
    if (m.collisionLayout) cviews = rebuildCollisionViews(m.collisionLayout);
    // Ack init so the parent can distinguish "worker never loaded" from
    // "worker loaded but the Atomics barrier never woke it".
    (self as unknown as Worker).postMessage({ type: "ack-init", workerIndex });
    loop();
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    (self as unknown as Worker).postMessage({ type: "ack-init-error", workerIndex, error: msg });
  }
});

function loop(): void {
  let firstWake = true;
  let lastPhase = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    Atomics.wait(ctrl!, CTRL_PHASE, lastPhase);
    const phase = Atomics.load(ctrl!, CTRL_PHASE);
    lastPhase = phase;
    if (firstWake) {
      firstWake = false;
      // Confirms Atomics.notify actually woke us, separate from the
      // first-phase ack of completion below.
      (self as unknown as Worker).postMessage({ type: "ack-wake", workerIndex });
    }
    const cmd = Atomics.load(ctrl!, CTRL_CMD);
    if (cmd === CMD_FORCES) {
      const np = Atomics.load(ctrl!, CTRL_NP);
      if (np > 0 && pviews && matBase) {
        const chunk = Math.floor(np / nWorkers);
        const rem = np - chunk * nWorkers;
        const from = workerIndex * chunk + Math.min(workerIndex, rem);
        const extra = workerIndex < rem ? 1 : 0;
        const to = from + chunk + extra;
        const params = readForceParams();
        // ASLEEP view is only present when the collision SAB layout
        // was shared. Without it we still want to compute forces
        // correctly -- pass an empty Uint8Array so the freeze branch
        // (yi+ri >= floorY && ASLEEP[i]) never trips and every
        // particle gets full force application.
        const asleepView = cviews ? cviews.asleep : EMPTY_ASLEEP;
        applyParticleForcesRange(
          pviews.PX, pviews.PY, pviews.PZ,
          pviews.PVX, pviews.PVY, pviews.PVZ,
          pviews.PR, pviews.PDENS, pviews.PMAT,
          asleepView,
          matBase, from, to, params,
        );
      }
    } else if (cmd === CMD_COLLISIONS) {
      const cols = Atomics.load(ctrl!, CTRL_C_COLS);
      const rows = Atomics.load(ctrl!, CTRL_C_ROWS);
      const parity = Atomics.load(ctrl!, CTRL_C_PARITY);
      const e = Atomics.load(ctrl!, CTRL_C_E) / 1e6;
      if (cols > 0 && rows > 0 && pviews && cviews) {
        const rowStart = parity + 2 * workerIndex;
        const rowStep = 2 * nWorkers;
        applyCollisionsRowRange(
          pviews.PX, pviews.PY, pviews.PZ,
          pviews.PVX, pviews.PVY, pviews.PVZ,
          pviews.PR,
          cviews.mass, cviews.asleep,
          cviews.cellStart, cviews.cellItems,
          rowStart, rowStep,
          cols, rows, e,
        );
      }
    }
    // Only the last worker to arrive at the barrier flips the
    // BARRIER signal and wakes the sim worker. Removes N-1 wake-ups
    // per dispatch on machines with non-trivial Atomics wake latency.
    const newDone = Atomics.add(ctrl!, CTRL_DONE, 1) + 1;
    if (newDone === nWorkers) {
      Atomics.store(ctrl!, CTRL_BARRIER, 1);
      Atomics.notify(ctrl!, CTRL_BARRIER);
    }
  }
}
