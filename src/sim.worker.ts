// Sim worker. Owns the live World; runs step() flat-out; posts a
// RenderSnapshot back to the main thread on a fixed cadence. All HUD
// / render / inspector reads on the main side go through that
// snapshot so this thread never touches the DOM.
//
// Lifecycle:
//   - Main posts { type: "init", width, height, savedJson? } once.
//   - Worker creates the world (optionally restoring from JSON), then
//     starts the tick loop.
//   - Main can post { type: "setTurbo" }, { type: "toggleProfile" },
//     { type: "applySaved" } at any time. Save snapshots are sent
//     unsolicited every SAVE_INTERVAL_SEC of sim time so the main
//     thread can write to localStorage without round-tripping.

import {
  applySavedWorld,
  createWorld,
  makeProfile,
  serializeWorld,
  setParticleForceDispatcher,
  step,
  takeSnapshot,
  MATERIAL_BASE_DENSITY,
  type ParticleForceParams,
  type RenderSnapshot,
  type World,
} from "./sim";

const FIXED_DT = 1 / 60;
// How often to post a render snapshot to the main thread. The renderer
// runs on rAF (~16ms), so this matches that cadence; turbo mode on
// the main thread already throttles render down to ~500ms intervals,
// but we still post at 60Hz so the cached snapshot stays fresh for
// HUD reads between renders.
const SNAPSHOT_INTERVAL_MS = 16;
// How often to ship a save snapshot. Main writes whatever it
// last received to localStorage on autosave / pagehide.
const SAVE_INTERVAL_SEC = 60;

let world: World | null = null;
let running = false;
let turbo = false;
let pendingSimError: { message: string; at: number } | null = null;
let lastSnapshotPostAt = 0;
let lastSaveSimT = 0;
let advancedSinceSnapshot = 0;
let simMsSinceSnapshot = 0;

type WorkerInbound =
  | { type: "init"; width: number; height: number; savedJson?: string | null }
  | { type: "setTurbo"; turbo: boolean }
  | { type: "toggleProfile" }
  | { type: "applySaved"; json: string }
  | { type: "requestSave" };

type WorkerOutbound =
  | {
      type: "snapshot";
      snapshot: RenderSnapshot;
      advanced: number;
      simMs: number;
      err: { message: string; at: number } | null;
    }
  | { type: "save"; json: string };

function send(msg: WorkerOutbound): void {
  (self as unknown as Worker).postMessage(msg);
}

self.addEventListener("message", (e: MessageEvent) => {
  const m = e.data as WorkerInbound;
  switch (m.type) {
    case "init": {
      world = createWorld(m.width, m.height);
      if (m.savedJson) {
        try {
          applySavedWorld(world, m.savedJson);
        } catch {
          // Schema mismatch / malformed -- main wipes localStorage on
          // its side when it sees no save coming back.
        }
      }
      lastSaveSimT = world.t;
      setupParticlePool(world);
      running = true;
      schedule();
      break;
    }
    case "setTurbo":
      turbo = !!m.turbo;
      break;
    case "toggleProfile":
      if (world) world.profile = world.profile ? undefined : makeProfile();
      break;
    case "applySaved":
      if (world) {
        try {
          applySavedWorld(world, m.json);
          lastSaveSimT = world.t;
        } catch {
          // Bad JSON; ignore.
        }
      }
      break;
    case "requestSave":
      if (world) {
        try {
          send({ type: "save", json: serializeWorld(world) });
        } catch {
          /* ignore */
        }
      }
      break;
  }
});

// Macrotask chain so messages from main can drain between sim slices.
// setTimeout(0) is the simplest portable yield; MessageChannel would
// be a touch faster but the difference is invisible at our budget.
function schedule(): void {
  if (!running) return;
  setTimeout(tick, 0);
}

function tick(): void {
  if (!running || !world) {
    schedule();
    return;
  }
  // Per-scheduling-slot budget. In normal mode we cap at a few ms so
  // incoming messages stay responsive; in turbo we go longer per slot
  // and lean on the snapshot-post rate to keep main responsive.
  const sliceStart = performance.now();
  const sliceBudgetMs = turbo ? 12 : 4;
  while (performance.now() - sliceStart < sliceBudgetMs) {
    const t0 = performance.now();
    try {
      step(world, FIXED_DT);
    } catch (err) {
      pendingSimError = {
        message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        at: world.t,
      };
      // eslint-disable-next-line no-console
      console.error("[sim worker] step threw, continuing:", err);
      break;
    }
    const elapsed = performance.now() - t0;
    advancedSinceSnapshot += FIXED_DT;
    simMsSinceSnapshot += elapsed;
  }
  maybePostSnapshot();
  maybePostSave();
  schedule();
}

function maybePostSnapshot(): void {
  if (!world) return;
  const now = performance.now();
  if (now - lastSnapshotPostAt < SNAPSHOT_INTERVAL_MS) return;
  lastSnapshotPostAt = now;
  const snap = takeSnapshot(world);
  send({
    type: "snapshot",
    snapshot: snap,
    advanced: advancedSinceSnapshot,
    simMs: simMsSinceSnapshot,
    err: pendingSimError,
  });
  advancedSinceSnapshot = 0;
  simMsSinceSnapshot = 0;
  pendingSimError = null;
}

function maybePostSave(): void {
  if (!world) return;
  if (world.t - lastSaveSimT < SAVE_INTERVAL_SEC) return;
  lastSaveSimT = world.t;
  try {
    send({ type: "save", json: serializeWorld(world) });
  } catch {
    /* serialize can fail for absurd worlds; not worth crashing */
  }
}

// ---------------------------------------------------------------------
// Particle subworker pool. Only spun up when crossOriginIsolated is
// true (SharedArrayBuffer required). The sim worker registers a
// dispatcher with sim.ts that, instead of running the per-particle
// loop here, signals the pool via Atomics and waits at a barrier.
// ---------------------------------------------------------------------

// Control SAB layout matches particle.worker.ts.
const CTRL_PHASE = 0;
const CTRL_DONE = 1;
const CTRL_NP = 2;
// CTRL_STOP at slot 3 is reserved for a future graceful-shutdown
// signal; sim worker doesn't currently set it.
const CTRL_SLOTS = 4;
// Params block: 22 Float64 slots.
const PARAM_COUNT = 22;

interface ParticlePool {
  workers: Worker[];
  ctrl: Int32Array;
  params: Float64Array;
  nWorkers: number;
  phase: number;
}
let pool: ParticlePool | null = null;

function setupParticlePool(w: World): void {
  // Sanity-check SAB availability. createWorld already allocated the
  // particle store on the appropriate buffer type; if that buffer is
  // a plain ArrayBuffer (no SAB), particle subworkers wouldn't see
  // our writes, so skip the pool and stay single-threaded.
  if (typeof SharedArrayBuffer === "undefined" ||
      !(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated) {
    return;
  }
  const storeLayout = w.particleStore.sharedLayout();
  if (!(storeLayout.buffer instanceof SharedArrayBuffer)) return;

  // Two workers is the sweet spot at ~5k particles (main loop is
  // ~0.5ms; one helper gets us close to 2x with minimal coordination
  // overhead). Tunable via the inbound message contract later if
  // needed; for now keep it simple.
  const hwc = (navigator as { hardwareConcurrency?: number }).hardwareConcurrency ?? 4;
  // Reserve 1 thread for main and 1 for the sim worker itself.
  const nWorkers = Math.max(1, Math.min(4, hwc - 2));
  const ctrlBuf = new SharedArrayBuffer(CTRL_SLOTS * 4);
  const paramsBuf = new SharedArrayBuffer(PARAM_COUNT * 8);
  const ctrl = new Int32Array(ctrlBuf);
  const params = new Float64Array(paramsBuf);
  const workers: Worker[] = [];
  for (let i = 0; i < nWorkers; i++) {
    const wk = new Worker(new URL("./particle.worker.ts", import.meta.url), {
      type: "module",
    });
    wk.postMessage({
      type: "init",
      particleLayout: storeLayout,
      controlBuffer: ctrlBuf,
      paramsBuffer: paramsBuf,
      matBase: MATERIAL_BASE_DENSITY,
      workerIndex: i,
      nWorkers,
    });
    workers.push(wk);
  }
  pool = { workers, ctrl, params, nWorkers, phase: 0 };
  setParticleForceDispatcher(dispatchParticleForces);
}

function dispatchParticleForces(np: number, p: ParticleForceParams): void {
  if (!pool) return;
  const { ctrl, params, nWorkers } = pool;
  // Pack params into the Float64 block in the layout particle.worker
  // expects (mirrors readParams there).
  params[0] = p.dt;
  params[1] = p.t;
  params[2] = p.drag;
  params[3] = p.gravity;
  params[4] = p.surfaceY;
  params[5] = p.surfaceDecay;
  params[6] = p.swellDecay;
  params[7] = p.updraftAmp;
  params[8] = p.currentAmp;
  params[9] = p.kS;
  params[10] = p.wS;
  params[11] = p.kL;
  params[12] = p.wL;
  params[13] = p.kU;
  params[14] = p.wU;
  params[15] = p.surfAmp;
  params[16] = p.swellAmp;
  params[17] = p.zAmp;
  params[18] = p.bAmp;
  params[19] = p.updraftEnv;
  params[20] = p.colDepth;
  params[21] = p.currentDrift;
  // Publish np, reset done, then bump phase and notify all workers.
  // The phase counter is what subworkers Atomics.wait()'d on; bumping
  // it wakes them. After they finish each adds 1 to the done counter;
  // we Atomics.wait on it until it equals nWorkers.
  Atomics.store(ctrl, CTRL_NP, np);
  Atomics.store(ctrl, CTRL_DONE, 0);
  pool.phase++;
  Atomics.store(ctrl, CTRL_PHASE, pool.phase);
  Atomics.notify(ctrl, CTRL_PHASE, nWorkers);
  // Barrier: wait until every worker has bumped done. Loop because
  // wait() can return without the condition being met (spurious wake,
  // timeout, or notify from another channel).
  while (Atomics.load(ctrl, CTRL_DONE) < nWorkers) {
    Atomics.wait(ctrl, CTRL_DONE, Atomics.load(ctrl, CTRL_DONE));
  }
}
