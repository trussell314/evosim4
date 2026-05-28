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
  getCollisionSharedLayout,
  makeProfile,
  resetProfile,
  serializeWorld,
  setCollisionPhaseDispatcher,
  setParticleForceDispatcher,
  step,
  takeSnapshot,
  setParticleTarget,
  setParallelMin,
  spawnSpeciesInstance,
  spawnCompositeInstance,
  pickClumpCenter,
  CHEM_BASE_DENSITY,
  type ParticleForceParams,
  type RenderSnapshot,
  type SpawnPlacement,
  type World,
} from "./sim";
import { buildScenarioWorld, type ScenarioSpec } from "./scenario-dsl";

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

// Pool / step profiling. Tick-level accumulators flushed every
// PROFILE_LOG_MS as an averaged line so we can see where the per-tick
// budget actually goes. Costs ~6 performance.now() calls per tick;
// cheap enough to leave on while tuning. Disable by setting
// PROFILE_LOG_MS to 0.
const PROFILE_LOG_MS = 3000;
let profForceDispatchMs = 0;
let profForceBarrierMs = 0;
let profCollisionDispatchMs = 0;
let profCollisionBarrierMs = 0;
let profStepMs = 0;
let profSnapshotMs = 0;
let profTickMs = 0;
let profTicks = 0;
let profPoolTicks = 0;
let profLastLogAt = 0;
let lastSnapshotPostAt = 0;
let lastSaveSimT = 0;
let advancedSinceSnapshot = 0;
let simMsSinceSnapshot = 0;

type WorkerInbound =
  | { type: "init"; width: number; height: number; savedJson?: string | null; scenario?: ScenarioSpec }
  | { type: "setTurbo"; turbo: boolean }
  | { type: "toggleProfile" }
  | { type: "applySaved"; json: string }
  | { type: "requestSave" }
  | { type: "setPinnedSpecies"; keys: string[] }
  | { type: "setParallelMin"; n: number }
  | { type: "setParticleCap"; cap: number }
  | { type: "setFoundersEnabled"; on: boolean }
  | { type: "setSeeding"; on: boolean }
  | { type: "setFounderTarget"; target: number }
  | { type: "setFounderCapEnabled"; on: boolean }
  | { type: "setMutationRate"; mul: number }
  | { type: "killCell"; id: number }
  | { type: "setDensityChem"; chem: number }
  | {
      type: "spawnSpecies";
      genome: number[];
      count?: number;
      placement?: "scatter" | "clump";
    }
  | {
      type: "spawnComposite";
      genome: number[]; // host
      symbiont: number[]; // pre-engulfed in the host's contents
      count?: number;
      placement?: "scatter" | "clump";
    }
  | { type: "particle-pool-message"; index: number; data: unknown }
  | { type: "particle-pool-error"; index: number; message: string }
  | { type: "requestDiag" };

type WorkerOutbound =
  | {
      type: "snapshot";
      snapshot: RenderSnapshot;
      advanced: number;
      simMs: number;
      err: { message: string; at: number } | null;
    }
  | { type: "save"; json: string }
  | { type: "spawn-particle-pool"; initPayloads: unknown[] }
  | { type: "teardown-particle-pool" }
  | { type: "diag"; running: boolean; hasWorld: boolean; t: number; pool: string };

function send(msg: WorkerOutbound): void {
  (self as unknown as Worker).postMessage(msg);
}

self.addEventListener("message", (e: MessageEvent) => {
  const m = e.data as WorkerInbound;
  switch (m.type) {
    case "particle-pool-message": {
      if (!pool) return;
      const idx = m.index | 0;
      const data = m.data as { type?: string; workerIndex?: number; error?: unknown };
      if (!data || typeof data !== "object") return;
      if (data.type === "ack-load") pool.loadAcked[idx] = true;
      else if (data.type === "ack-init") pool.initAcked[data.workerIndex! | 0] = true;
      else if (data.type === "ack-wake") pool.wakeAcked[data.workerIndex! | 0] = true;
      else if (data.type === "ack-init-error") pool.initErrors[data.workerIndex! | 0] = String(data.error || "unknown");
      return;
    }
    case "particle-pool-error": {
      teardownPool(`worker ${m.index} error: ${m.message}`);
      return;
    }
    case "init": {
      if (m.scenario) {
        // World-builder: build a fresh world from a declarative scenario
        // spec (custom size/env + seeded populations). Ignores savedJson.
        world = buildScenarioWorld(m.scenario);
      } else {
        world = createWorld(m.width, m.height, { delayedSpawn: true });
      }
      // Enable in-engine sub-step profile by default so the [prof] log
      // can break down the "creature" bucket into pheromone / bonds /
      // forces / updateCreatures / particleColl / etc. The toggleProfile
      // message still flips it off-on if a caller needs to.
      world.profile = makeProfile();
      if (!m.scenario && m.savedJson) {
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
    case "requestDiag":
      // Main asks for liveness/pool state when it sees the snapshot clock
      // frozen (SIM STALLED). Cheap, read-only -- helps pinpoint a stall
      // (stepping not running? world null? a pool worker unresponsive?).
      send({ type: "diag", running, hasWorld: world !== null,
        t: world ? world.t : -1, pool: poolDiagSnapshot() });
      break;
    case "setTurbo":
      turbo = !!m.turbo;
      break;
    case "setPinnedSpecies":
      if (world) world.pinnedSpecies = new Set(m.keys);
      break;
    case "setParticleCap":
      if (world) setParticleTarget(world, m.cap);
      break;
    case "setParallelMin":
      if (world) setParallelMin(world, m.n);
      break;
    case "setFoundersEnabled":
      if (world) world.foundersEnabled = m.on;
      break;
    case "setSeeding":
      if (world) world.ongoingSeeding = m.on;
      break;
    case "setFounderTarget":
      if (world) world.founderTarget = Math.max(0, Math.round(m.target));
      break;
    case "setFounderCapEnabled":
      if (world) world.founderCapEnabled = m.on;
      break;
    case "setMutationRate":
      if (world) world.mutationRateMul = Math.max(0, m.mul);
      break;
    case "killCell":
      if (world) (world.killRequests ??= new Set()).add(m.id);
      break;
    case "setDensityChem":
      if (world) world.densityChem = m.chem;
      break;
    case "spawnSpecies":
      if (world && m.genome.length > 0) {
        const g = Uint8Array.from(m.genome);
        const n = Math.max(1, Math.min(100, m.count ?? 1));
        // One shared clump center per click so the batch lands together.
        const center =
          m.placement === "clump" ? pickClumpCenter(world) : undefined;
        const place: SpawnPlacement | undefined =
          m.placement === "clump" ? { mode: "clump", center } : undefined;
        for (let i = 0; i < n; i++) spawnSpeciesInstance(world, g, place);
      }
      break;
    case "spawnComposite":
      if (world && m.genome.length > 0 && m.symbiont.length > 0) {
        const host = Uint8Array.from(m.genome);
        const sym = Uint8Array.from(m.symbiont);
        const n = Math.max(1, Math.min(100, m.count ?? 1));
        const center =
          m.placement === "clump" ? pickClumpCenter(world) : undefined;
        const place: SpawnPlacement | undefined =
          m.placement === "clump" ? { mode: "clump", center } : undefined;
        for (let i = 0; i < n; i++) {
          spawnCompositeInstance(world, host, sym, place);
        }
      }
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
// MessageChannel beats setTimeout(0) by ~4ms because browsers clamp
// nested setTimeouts to a 4ms minimum but apply no such clamp to
// MessagePort task posts. At sim-tick-per-frame budgets, that 4ms is
// the difference between sim ratio 0.95x (setTimeout) and ~1.23x
// (MessageChannel) on hardware where the per-tick work itself is
// already near the 16.7ms frame budget.
const scheduleChannel = new MessageChannel();
scheduleChannel.port1.onmessage = () => tick();
function schedule(): void {
  if (!running) return;
  scheduleChannel.port2.postMessage(null);
}

function tick(): void {
  if (!running || !world) {
    schedule();
    return;
  }
  const tickEntry = performance.now();
  // Per-scheduling-slot budget. In normal mode we cap at a few ms so
  // incoming messages stay responsive; in turbo we go longer per slot
  // and lean on the snapshot-post rate to keep main responsive.
  const sliceStart = tickEntry;
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
    profStepMs += elapsed;
    profTicks += 1;
    if (pool) profPoolTicks += 1;
  }
  const tBeforeSnap = performance.now();
  maybePostSnapshot();
  profSnapshotMs += performance.now() - tBeforeSnap;
  maybePostSave();
  profTickMs += performance.now() - tickEntry;
  maybeLogProfile();
  schedule();
}

function maybeLogProfile(): void {
  if (PROFILE_LOG_MS <= 0 || profTicks === 0) return;
  const now = performance.now();
  if (profLastLogAt === 0) { profLastLogAt = now; return; }
  if (now - profLastLogAt < PROFILE_LOG_MS) return;
  const n = profTicks;
  const np = world ? world.particles.length : 0;
  const pop = world ? world.creatures.length : 0;
  // Sim worker creature-loop time is roughly step minus the dispatch
  // and barrier time, since those are the only synchronous "wait for
  // workers" sub-paths inside step().
  const creature = profStepMs - profForceDispatchMs - profForceBarrierMs
    - profCollisionDispatchMs - profCollisionBarrierMs;
  const fmt = (v: number) => (v / n).toFixed(2);
  // eslint-disable-next-line no-console
  console.log(
    `[prof] ticks=${n} pool=${profPoolTicks}/${n} np=${np} pop=${pop} | `
    + `step=${fmt(profStepMs)}ms `
    + `force[disp=${fmt(profForceDispatchMs)} bar=${fmt(profForceBarrierMs)}] `
    + `coll[disp=${fmt(profCollisionDispatchMs)} bar=${fmt(profCollisionBarrierMs)}] `
    + `creature=${fmt(creature)} `
    + `snap=${fmt(profSnapshotMs)} `
    + `tick=${fmt(profTickMs)}`,
  );
  // Second line breaks down the "creature" bucket using the in-engine
  // world.profile sub-counters. Lets us see which serial sub-step is
  // dominating (updateCreatures vs particleColl vs obstacleColl vs ...).
  // Hidden behind a separate console.log so callers can tail just the
  // top-line if they prefer.
  const wp = world?.profile;
  if (wp && wp.ticks > 0) {
    const t = wp.ticks;
    const wfmt = (v: number) => (v / t).toFixed(2);
    // eslint-disable-next-line no-console
    console.log(
      `[prof.sub] bonds=${wfmt(wp.bonds)} `
      + `forces=${wfmt(wp.forces)} creatures=${wfmt(wp.creatures)} `
      + `pColl=${wfmt(wp.particleColl)} cColl=${wfmt(wp.creatureColl)} `
      + `sColl=${wfmt(wp.sedimentColl)} oColl=${wfmt(wp.obstacleColl)} `
      + `walls=${wfmt(wp.walls)} evac=${wfmt(wp.evacuate)} `
      + `aerate=${wfmt(wp.aerate)} `
      + `replenish=${wfmt(wp.replenish)} prune=${wfmt(wp.prune)}`,
    );
    resetProfile(wp);
  }
  profForceDispatchMs = 0;
  profForceBarrierMs = 0;
  profCollisionDispatchMs = 0;
  profCollisionBarrierMs = 0;
  profStepMs = 0;
  profSnapshotMs = 0;
  profTickMs = 0;
  profTicks = 0;
  profPoolTicks = 0;
  profLastLogAt = now;
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
// Barrier-complete signal: 0 = pending, 1 = complete. The worker that
// increments DONE to nWorkers stores 1 here and notifies; sim worker
// waits on this slot, not on the counter. That cuts wake-ups per
// barrier from N (one per worker completion) to 1 (only the last
// worker fires), which dominates the dispatch cost on hardware where
// Atomics wake latency is high.
const CTRL_BARRIER = 3;
const CTRL_CMD = 4;
const CTRL_C_COLS = 5;
const CTRL_C_ROWS = 6;
const CTRL_C_PARITY = 7;
const CTRL_C_E = 8;
const CTRL_SLOTS = 9;
const CMD_FORCES = 0;
const CMD_COLLISIONS = 1;
// Params block: 22 Float64 slots.
const PARAM_COUNT = 24;

interface ParticlePool {
  // Worker refs live on the main thread; sim worker only talks to them
  // indirectly via "particle-pool-message" relays. Nested module
  // workers spawned from another worker silently fail to load in some
  // browsers, so we route through main as a workaround.
  ctrl: Int32Array;
  params: Float64Array;
  nWorkers: number;
  phase: number;
  loadAcked: boolean[];
  initAcked: boolean[];
  wakeAcked: boolean[];
  initErrors: (string | null)[];
}
let pool: ParticlePool | null = null;

// Upper bound on how long a barrier wait can block before we assume a
// subworker has gone AWOL (failed to load, threw silently, etc.) and
// tear the pool down. Picked well above any realistic per-phase time
// (single-digit ms) but small enough to recover within a frame budget.
const BARRIER_TIMEOUT_MS = 500;

function teardownPool(reason: string): void {
  if (!pool) return;
  pool = null;
  setParticleForceDispatcher(null);
  setCollisionPhaseDispatcher(null);
  pendingSimError = { message: `[pool] ${reason}`, at: world ? world.t : 0 };
  // eslint-disable-next-line no-console
  console.error("[sim worker] particle pool torn down:", reason);
  send({ type: "teardown-particle-pool" });
}

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
  const collisionLayout = getCollisionSharedLayout();
  // The collision SAB must also actually be a SharedArrayBuffer for
  // the parallel collision path to work; if it isn't we just skip
  // wiring the collision dispatcher and run that phase serially.
  const collisionShared = collisionLayout.buffer instanceof SharedArrayBuffer;

  // Two workers is the sweet spot at ~5k particles (main loop is
  // ~0.5ms; one helper gets us close to 2x with minimal coordination
  // overhead). Tunable via the inbound message contract later if
  // needed; for now keep it simple.
  const hwc = (navigator as { hardwareConcurrency?: number }).hardwareConcurrency ?? 4;
  // Reserve 1 thread for main and 1 for the sim worker itself.
  const nWorkers = Math.max(1, Math.min(4, hwc - 2));
  // With only one helper, dispatching costs more than it saves --
  // Atomics.wait wake latency is fixed but per-particle savings are
  // divided by nWorkers. Stay single-threaded in that case.
  if (nWorkers < 2) return;
  const ctrlBuf = new SharedArrayBuffer(CTRL_SLOTS * 4);
  const paramsBuf = new SharedArrayBuffer(PARAM_COUNT * 8);
  const ctrl = new Int32Array(ctrlBuf);
  const params = new Float64Array(paramsBuf);
  const loadAcked = new Array<boolean>(nWorkers).fill(false);
  const initAcked = new Array<boolean>(nWorkers).fill(false);
  const wakeAcked = new Array<boolean>(nWorkers).fill(false);
  const initErrors: (string | null)[] = new Array(nWorkers).fill(null);
  const initPayloads: unknown[] = [];
  for (let i = 0; i < nWorkers; i++) {
    initPayloads.push({
      type: "init",
      particleLayout: storeLayout,
      collisionLayout: collisionShared ? collisionLayout : null,
      controlBuffer: ctrlBuf,
      paramsBuffer: paramsBuf,
      matBase: CHEM_BASE_DENSITY,
      workerIndex: i,
      nWorkers,
    });
  }
  pool = { ctrl, params, nWorkers, phase: 0, loadAcked, initAcked, wakeAcked, initErrors };
  setParticleForceDispatcher(dispatchParticleForces);
  if (collisionShared) setCollisionPhaseDispatcher(dispatchCollisionPhase);
  // Spawn workers on main and have main forward acks back to us.
  // Workers spawned this way are top-level workers from main's point
  // of view, which works around the silent-load failure observed when
  // spawning module workers from inside another worker.
  send({ type: "spawn-particle-pool", initPayloads });
}

function poolDiagSnapshot(): string {
  if (!pool) return "no pool";
  const load = pool.loadAcked.map((v, i) => v ? null : i).filter((v) => v !== null);
  const init = pool.initAcked.map((v, i) => v ? null : i).filter((v) => v !== null);
  const wake = pool.wakeAcked.map((v, i) => v ? null : i).filter((v) => v !== null);
  const errs = pool.initErrors
    .map((e, i) => e ? `${i}:${e}` : null)
    .filter((v): v is string => v !== null);
  const parts = [
    `load-missing=[${load.join(",")}]`,
    `init-missing=[${init.join(",")}]`,
    `wake-missing=[${wake.join(",")}]`,
  ];
  if (errs.length) parts.push(`init-errors={${errs.join("; ")}}`);
  return parts.join(" ");
}

function dispatchParticleForces(np: number, p: ParticleForceParams): () => void {
  if (!pool) return () => {};
  const tStart = performance.now();
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
  params[22] = p.worldFloorY;
  params[23] = p.worldWidth;
  // Publish np, reset done, then bump phase and notify all workers.
  // The phase counter is what subworkers Atomics.wait()'d on; bumping
  // it wakes them. After they finish each adds 1 to the done counter;
  // we Atomics.wait on it until it equals nWorkers.
  Atomics.store(ctrl, CTRL_CMD, CMD_FORCES);
  Atomics.store(ctrl, CTRL_NP, np);
  Atomics.store(ctrl, CTRL_DONE, 0);
  Atomics.store(ctrl, CTRL_BARRIER, 0);
  pool.phase++;
  Atomics.store(ctrl, CTRL_PHASE, pool.phase);
  Atomics.notify(ctrl, CTRL_PHASE, nWorkers);
  const tFireDone = performance.now();
  profForceDispatchMs += tFireDone - tStart;
  // Return a wait fn so the caller can do unrelated work first.
  return () => {
    const tWait = performance.now();
    waitForBarrier(ctrl, nWorkers, "force");
    profForceBarrierMs += performance.now() - tWait;
  };
}

function dispatchCollisionPhase(cols: number, rows: number, parity: 0 | 1, e: number): () => void {
  if (!pool) return () => {};
  const tStart = performance.now();
  const { ctrl, nWorkers } = pool;
  Atomics.store(ctrl, CTRL_CMD, CMD_COLLISIONS);
  Atomics.store(ctrl, CTRL_C_COLS, cols);
  Atomics.store(ctrl, CTRL_C_ROWS, rows);
  Atomics.store(ctrl, CTRL_C_PARITY, parity);
  // Restitution is a small float (0..1); pack into Int32 at 1e6 scale.
  Atomics.store(ctrl, CTRL_C_E, Math.round(e * 1e6));
  Atomics.store(ctrl, CTRL_DONE, 0);
  Atomics.store(ctrl, CTRL_BARRIER, 0);
  pool.phase++;
  Atomics.store(ctrl, CTRL_PHASE, pool.phase);
  Atomics.notify(ctrl, CTRL_PHASE, nWorkers);
  const tFireDone = performance.now();
  profCollisionDispatchMs += tFireDone - tStart;
  return () => {
    const tWait = performance.now();
    waitForBarrier(ctrl, nWorkers, "collision");
    profCollisionBarrierMs += performance.now() - tWait;
  };
}

// Bounded barrier wait. Returns true on success, false if the deadline
// expires (in which case the pool has already been torn down and the
// caller should give up on this phase). The sim's next step will use
// the serial fallback that the cleared dispatchers route to.
function waitForBarrier(ctrl: Int32Array, nWorkers: number, label: string): boolean {
  // Sim worker now waits on CTRL_BARRIER (set by the last worker only)
  // instead of polling CTRL_DONE, so a successful barrier is exactly
  // one wake. The loop is defensive against spurious wakeups.
  const deadline = performance.now() + BARRIER_TIMEOUT_MS;
  while (Atomics.load(ctrl, CTRL_BARRIER) === 0) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      const diag = poolDiagSnapshot();
      teardownPool(`${label} barrier timed out (${nWorkers - Atomics.load(ctrl, CTRL_DONE)}/${nWorkers} unresponsive; ${diag})`);
      return false;
    }
    Atomics.wait(ctrl, CTRL_BARRIER, 0, remaining);
  }
  return true;
}
