// Creature subworker. One of a pool spawned by sim.worker.ts. Currently
// handles a single command -- CMD_CHEMISTRY -- which runs the per-cell
// chemistry phase (runGenericReactions) over a slice of live cells.
//
// Strict per-cell writes only -- workers only touch the columns of the
// cells in their slice, no cross-cell or world.ambient writes. Activation,
// transport, engulf/predate/ingest, and division all stay on the sim
// worker on the sequential phase.

import {
  CreatureStore,
  type CreatureSharedLayout,
} from "./sim";
import { runGenericReactions } from "./sim/cell-reactions";

// Control buffer layout (Int32). Independent from the particle pool's
// ctrl SAB so particle + creature phases can both exist (creatures don't
// fire while particles do or vice versa in practice, but separating the
// counters makes that ordering trivial).
//   [0] phase   -- sim worker increments each tick
//   [1] done    -- subworkers Atomics.add(+1) when finished
//   [2] n       -- chemistry: live cell count for this dispatch
//   [3] barrier -- 0 pending, 1 complete (last worker writes it)
//   [4] cmd     -- which command this phase carries
const CTRL_PHASE = 0;
const CTRL_DONE = 1;
const CTRL_N = 2;
const CTRL_BARRIER = 3;
const CTRL_CMD = 4;

const CMD_CHEMISTRY = 0;

let ctrl: Int32Array | null = null;
let idxs: Int32Array | null = null;
let scratch: Float32Array | null = null;
let viewStore: CreatureStore | null = null;
let workerIndex = 0;
let nWorkers = 1;

// Earliest possible signal that the script reached module-top. If the
// parent never sees ack-load, the worker script itself isn't running
// (load failure, COEP rejection, or top-level throw before this line).
(self as unknown as Worker).postMessage({ type: "ack-load" });

self.addEventListener("message", (e: MessageEvent) => {
  const m = e.data as {
    type?: string;
    workerIndex?: number;
    nWorkers?: number;
    controlBuffer?: SharedArrayBuffer;
    idxsBuffer?: SharedArrayBuffer;
    scratchBuffer?: SharedArrayBuffer;
    creatureLayout?: CreatureSharedLayout;
  };
  if (!m || m.type !== "init") return;
  try {
    workerIndex = (m.workerIndex ?? 0) | 0;
    nWorkers = Math.max(1, (m.nWorkers ?? 1) | 0);
    if (!m.controlBuffer || !m.idxsBuffer || !m.scratchBuffer || !m.creatureLayout) {
      throw new Error(`missing buffers: ctrl=${!!m.controlBuffer} idxs=${!!m.idxsBuffer} scratch=${!!m.scratchBuffer} layout=${!!m.creatureLayout}`);
    }
    ctrl = new Int32Array(m.controlBuffer);
    idxs = new Int32Array(m.idxsBuffer);
    scratch = new Float32Array(m.scratchBuffer);
    viewStore = CreatureStore.viewsFromSharedLayout(m.creatureLayout);
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
      (self as unknown as Worker).postMessage({ type: "ack-wake", workerIndex });
    }
    const cmd = Atomics.load(ctrl!, CTRL_CMD);
    if (cmd === CMD_CHEMISTRY) {
      const n = Atomics.load(ctrl!, CTRL_N);
      if (n > 0 && viewStore && idxs && scratch) {
        // Even slice. Same as particle.worker's split: each worker gets
        // floor(n/nWorkers) + (1 if workerIndex < remainder).
        const chunk = Math.floor(n / nWorkers);
        const rem = n - chunk * nWorkers;
        const from = workerIndex * chunk + Math.min(workerIndex, rem);
        const extra = workerIndex < rem ? 1 : 0;
        const to = from + chunk + extra;
        for (let k = from; k < to; k++) {
          const idx = idxs[k];
          if (idx < 0) continue;
          const dtT = scratch[k * 2];
          const ambient = scratch[k * 2 + 1];
          runGenericReactions({ store: viewStore, idx }, dtT, ambient);
        }
      }
    }
    // Only the last worker to arrive flips the BARRIER signal.
    const newDone = Atomics.add(ctrl!, CTRL_DONE, 1) + 1;
    if (newDone === nWorkers) {
      Atomics.store(ctrl!, CTRL_BARRIER, 1);
      Atomics.notify(ctrl!, CTRL_BARRIER);
    }
  }
}
