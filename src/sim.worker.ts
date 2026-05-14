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
  step,
  takeSnapshot,
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
