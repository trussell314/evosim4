import "./style.css";

// Injected by Vite's `define` (see vite.config.ts): the ISO-8601 UTC
// timestamp of when this bundle/dev-server was built.
declare const __BUILD_TIME__: string;

// Register the COI service worker before anything else. On a host
// that doesn't send COOP/COEP (e.g. GitHub Pages), the SW intercepts
// our own fetches and tacks the headers on, which is enough to flip
// self.crossOriginIsolated to true and let stage A's particle
// subworker pool spawn. On hosts that already send the headers, the
// SW is harmless (just a no-op rewrite). First install requires a
// reload to put the SW in front of the document load.
if (typeof navigator !== "undefined" && "serviceWorker" in navigator && !window.crossOriginIsolated) {
  // Relative path so it picks up Vite's base prefix at build time;
  // public/coi-serviceworker.js is copied to dist/ root.
  const swUrl = `${import.meta.env.BASE_URL}coi-serviceworker.js`;
  // Cases we need to handle:
  //   A) Fresh install: register() resolves with the SW still installing.
  //      controllerchange fires once it activates + claims; reload then.
  //   B) SW already active but this navigation isn't controlled
  //      (force-reload bypass, or claim() missed this client). register()
  //      resolves with reg.active set but controller === null and no
  //      controllerchange will fire. Reload manually.
  //   C) SW controlling but headers still not applied. Reload as well.
  // A time-stamped sessionStorage guard prevents an infinite reload
  // loop without pinning the session to "give up" forever -- if the
  // user manually refreshes more than RELOAD_GUARD_MS later, the
  // stamp is treated as stale and we try again. The auto-reload from
  // a still-fresh stamp is what stops a busy loop.
  const RELOAD_GUARD_KEY = "coi-sw-reload-attempted-at";
  const RELOAD_GUARD_MS = 5000;
  const reloadOnce = (): void => {
    let lastAt = 0;
    try { lastAt = Number(sessionStorage.getItem(RELOAD_GUARD_KEY)) || 0; } catch { /* ignore */ }
    if (Date.now() - lastAt < RELOAD_GUARD_MS) {
      // eslint-disable-next-line no-console
      console.warn("[coi] SW registered but page still not isolated after recent reload; not retrying");
      return;
    }
    try { sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now())); } catch { /* private mode */ }
    window.location.reload();
  };
  if (!navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener("controllerchange", reloadOnce, { once: true });
  }
  navigator.serviceWorker.register(swUrl, { scope: import.meta.env.BASE_URL })
    .then((reg) => {
      if (window.crossOriginIsolated) return;
      // Case B/C: an active SW exists but we're still not isolated.
      // Reload pulls the navigation back through the SW.
      if (reg.active) reloadOnce();
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[coi] service worker registration failed:", err);
    });
} else if (typeof window !== "undefined" && window.crossOriginIsolated) {
  // Page reached isolation; clear the guard stamp so future
  // unrelated reloads aren't pinned to "recently tried".
  try { sessionStorage.removeItem("coi-sw-reload-attempted-at"); } catch { /* ignore */ }
}

import {
  createWorld,
  REGION_PX,
  CHEM_COLORS,
  SENSOR_CHEM_LABELS,
  MOLECULE_IDS,
  surfaceYAt,
  temperatureAt,
  solarLight,
  takeSnapshot,
  chemName,
  reactionName,
  reactionCatalog,
  chemAmountToParticles,
  NAMED_CHEMICALS,
  NAMED_CHEMICAL_COUNT,
  reactionWindowSeries,
  type ReactionInfo,
  genomeTag,
  PARTICLE_TARGET_STEP,
  type RenderSnapshot,
  type ParticleSnapshot,
  type CreatureSnapshot,
  type SpeciesSnapshot,
} from "./sim";
import { disassemble, walkGenome, OP, CATALYST_COUNT, SYNTH_KIND, SYNTH_KIND_COUNT } from "./genome";

const root = document.querySelector<HTMLDivElement>("#app")!;
const canvas = document.createElement("canvas");
root.appendChild(canvas);
const ctx = canvas.getContext("2d")!;

// HUD: a wrapper holding a minimize button and the inspector pre. Click the
// button to collapse to just the button; click again to expand.
// Split the font into individual properties rather than the `font:`
// shorthand. The shorthand resets font-stretch / font-variant-* in some
// engines, and a few browsers were quietly bumping <pre> back to their
// UA default size when only the shorthand was present. Explicit
// properties + a top-level reset on the wrapping HUD makes the size
// stick everywhere, every time.
// Single source of truth for ALL UI text size. One number, used by
// every HUD / panel / tooltip / canvas-label site so the whole UI
// scales together from here. Bump this to resize everything.
const UI_FONT_PX = 14;
const UI_FONT_FAMILY = "ui-monospace,SFMono-Regular,Menlo,monospace";
// Canvas ctx.font string (phylogeny / heatmap labels).
const UI_CANVAS_FONT = `${UI_FONT_PX}px ${UI_FONT_FAMILY}`;
const HUD_FONT =
  `font-family:${UI_FONT_FAMILY};` +
  `font-size:${UI_FONT_PX}px;line-height:1.3;font-weight:normal;font-style:normal;`;
const hud = document.createElement("div");
hud.style.cssText =
  "position:fixed;z-index:10;top:0;left:0;right:0;color:#9ee;" +
  "background:rgba(2,12,18,0.96);border-bottom:1px solid #1a3340;" +
  "box-sizing:border-box;padding:4px 8px;" + HUD_FONT;
const hudBar = document.createElement("div");
hudBar.style.cssText =
  "display:flex;flex-wrap:wrap;align-items:center;gap:4px 16px;" +
  "user-select:none;color:#9ee;" + HUD_FONT;
// Live stats shown on the strip. Updated by updateInspector() each frame.
const hudStats = document.createElement("span");
hudStats.style.cssText = HUD_FONT;
hudStats.textContent = "fps=--  sim=--x  t=0s";
hudBar.appendChild(hudStats);
// Per-frame render/sim timing, inline beside the stats so the budget
// is glanceable while iterating.
const hudTimings = document.createElement("span");
hudTimings.style.cssText = "opacity:0.8;" + HUD_FONT;
hudTimings.textContent = "r=--ms  s=--ms";
hudBar.appendChild(hudTimings);
// Stall + error indicator. Hidden by default; shown only when
// something useful is going on (sim paused / world empty / threw).
const hudDiag = document.createElement("div");
hudDiag.style.cssText = "padding-top:2px;color:#f88;display:none;" + HUD_FONT;
// Whole HUD is one font (9px). Each element sets it explicitly
// rather than via inherit, because user-agent styles for <pre> can
// override font-size from cascade in some browsers.
const inspector = document.createElement("pre");
inspector.style.cssText =
  "margin:0;padding:0 9px 6px;color:#9ee;white-space:pre-wrap;" +
  "overflow-wrap:anywhere;" + HUD_FONT;
// Disasm gets its own collapsible section: it's much longer than the
// rest of the inspector and almost never wanted at-a-glance. Click the
// "[show disasm]" header to expand.
const disasmHeader = document.createElement("div");
disasmHeader.style.cssText =
  "padding:2px 9px 4px;cursor:pointer;user-select:none;color:#9ee;" + HUD_FONT;
disasmHeader.textContent = "[+] show genome";
const disasmBody = document.createElement("pre");
disasmBody.style.cssText =
  "margin:0;padding:0 9px 6px;color:#9ee;white-space:pre;display:none;" + HUD_FONT;
// HUD is now a static top-left status strip (stats / timings / diag).
// The selected-cell inspector, pin control and disasm moved into the
// Inspector tab of the right-side organisms drawer.
hud.appendChild(hudBar);
hud.appendChild(hudTimings);
hud.appendChild(hudDiag);
root.appendChild(hud);

// Pin the SELECTED cell's species. The star on the species cards only
// reaches species in Top 10 / Pinned / Notable; this lets you pin any
// species -- click its cell, then this button. Hidden when nothing is
// selected. Label/visibility refreshed each frame by updateInspector().
const pinSpeciesBtn = document.createElement("div");
pinSpeciesBtn.style.cssText =
  "display:none;align-items:center;gap:8px;padding:4px 9px 6px;" +
  "cursor:pointer;user-select:none;" + HUD_FONT;
pinSpeciesBtn.addEventListener("click", () => {
  const sel = selectedCell();
  if (!sel) return;
  togglePin(sel.speciesKey, sel.genome, sel.color, peakBiomassByKey.get(sel.speciesKey) ?? 0);
});

// Human-readable genome summary -- the same prose shown on the
// species cards. Filled by updateInspector when a cell is selected.
const inspectorProse = document.createElement("div");
inspectorProse.style.cssText =
  "padding:6px 9px;color:#bcd;display:none;" + HUD_FONT;

// "genome" (was "disasm") stays a collapsible sub-section inside the
// Inspector tab, with a copy-to-clipboard button (one op per line).
// The whole bar is hidden by updateInspector when no cell is selected.
let disasmExpanded = false;
disasmHeader.addEventListener("click", () => {
  disasmExpanded = !disasmExpanded;
  disasmBody.style.display = disasmExpanded ? "" : "none";
  disasmHeader.textContent = disasmExpanded ? "[–] hide genome" : "[+] show genome";
});
const disasmBar = document.createElement("div");
disasmBar.style.cssText = "display:none;align-items:center;gap:8px;";
disasmHeader.style.flex = "1 1 auto";
const copyDisasmBtn = document.createElement("button");
copyDisasmBtn.title = "Copy genome (one op per line)";
copyDisasmBtn.textContent = "⧉";
copyDisasmBtn.style.cssText =
  "padding:2px 8px;margin:0 6px;border:1px solid #1a3340;" +
  "border-radius:4px;background:rgba(0,0,0,.45);color:#9ee;cursor:pointer;" +
  HUD_FONT;
// Transient confirmation near the button. Some browsers block the
// async clipboard API (insecure context / no permission); fall back
// to a hidden-textarea execCommand copy and only claim success if a
// path actually worked.
const copyToast = document.createElement("div");
copyToast.style.cssText =
  "position:fixed;z-index:9999;display:none;padding:5px 9px;border-radius:4px;" +
  "background:rgba(0,0,0,.88);pointer-events:none;white-space:nowrap;" + HUD_FONT;
document.body.appendChild(copyToast);
let copyToastTimer: ReturnType<typeof setTimeout> | undefined;
function showCopyToast(msg: string, ok: boolean): void {
  const r = copyDisasmBtn.getBoundingClientRect();
  copyToast.textContent = msg;
  copyToast.style.color = ok ? "#9efba8" : "#fdd";
  copyToast.style.border = `1px solid ${ok ? "#2a6" : "#a55"}`;
  copyToast.style.display = "";
  const tw = copyToast.getBoundingClientRect().width || 150;
  copyToast.style.left = `${Math.max(8, r.right - tw)}px`;
  copyToast.style.top = `${Math.max(8, r.top - 30)}px`;
  if (copyToastTimer) clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => { copyToast.style.display = "none"; }, 2600);
}
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to legacy path */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
copyDisasmBtn.addEventListener("click", async (ev) => {
  ev.stopPropagation();
  if (!activeDisasmRaw) return;
  const lines = activeDisasmRaw.split("\n").filter((l) => l.length > 0).length;
  const ok = await copyToClipboard(activeDisasmRaw);
  copyDisasmBtn.textContent = ok ? "✓" : "✗";
  setTimeout(() => { copyDisasmBtn.textContent = "⧉"; }, 1200);
  showCopyToast(ok ? `copied ${lines} lines` : "copy failed", ok);
});
disasmBar.append(disasmHeader, copyDisasmBtn);

// World dimensions are fixed at startup; zooming/resizing the browser
// only changes the canvas's visual scale, never the underlying world.
// Two presets so the world fills the viewport reasonably in either
// orientation:
const WORLD_LANDSCAPE = { w: 800, h: 600 };
const WORLD_PORTRAIT = { w: 600, h: 800 };
const WORLD_SIZE = window.innerWidth >= window.innerHeight ? WORLD_LANDSCAPE : WORLD_PORTRAIT;
const SAVE_KEY = "evosim4:save";

// Read whatever's in localStorage (if anything) so we can pass it to
// the worker as part of init. The worker schema-checks before applying
// and silently keeps the fresh world on mismatch; we wipe the bad
// localStorage entry here too so the next reload starts clean.
const savedJson = (() => {
  try { return localStorage.getItem(SAVE_KEY); }
  catch { return null; }
})();

// Marked-species persistence. Two independent collections, both keyed
// by speciesKey and both storing the FULL genome bytes so an entry
// survives the species going extinct (and a page reload):
//   - pinned: user-starred species. Their founders are also exempt
//     from the age cull (worker is told the key set).
//   - hallOfFame: sim-driven "best so far", auto-maintained, capped.
// Lineage history is intentionally NOT saved (nice-to-have only).
interface MarkedSpecies {
  key: string;
  genome: number[];   // full genome bytes -- the whole point
  color: string;
  at: number;         // sim-time the entry was recorded
  peakBio: number;
}
const PIN_KEY = "evosim4:pins";
const HOF_LIMIT = 8; // "best 5-10"
function loadMarked(storeKey: string): Map<string, MarkedSpecies> {
  const m = new Map<string, MarkedSpecies>();
  try {
    const raw = localStorage.getItem(storeKey);
    if (raw) {
      for (const e of JSON.parse(raw) as MarkedSpecies[]) {
        if (e && typeof e.key === "string" && Array.isArray(e.genome)) m.set(e.key, e);
      }
    }
  } catch { /* corrupt / unavailable -- start empty */ }
  return m;
}
const pinnedSpecies = loadMarked(PIN_KEY);
// Notable ("hall of fame") is scoped to THIS sim run only for now --
// not loaded from or persisted to localStorage, so it starts empty
// each session and doesn't bleed across different sims.
const hallOfFame = new Map<string, MarkedSpecies>();
function persistMarked(storeKey: string, m: Map<string, MarkedSpecies>): void {
  try { localStorage.setItem(storeKey, JSON.stringify([...m.values()])); }
  catch { /* quota / private mode -- in-memory only */ }
}
function syncPinnedToWorker(): void {
  simWorker.postMessage({ type: "setPinnedSpecies", keys: [...pinnedSpecies.keys()] });
}

// Bootstrap snapshot: build a transient world purely to produce an
// empty initial RenderSnapshot for the renderer to draw against until
// the worker delivers its first real one. The local world is never
// stepped or referenced again -- the worker owns the truth.
const bootstrapWorld = createWorld(WORLD_SIZE.w, WORLD_SIZE.h);
let snapshot: RenderSnapshot = takeSnapshot(bootstrapWorld);

// Main-thread profile: lets us see if the worker's sim_rate is being
// gated by snapshot delivery, frame() execution, or render() cost.
// Compares snapshots-received-per-second against frames-rendered-per-
// second and the wall time consumed by each frame's sub-buckets.
const MAIN_PROFILE_LOG_MS = 3000;
let mpSnapshotsReceived = 0;
let mpSnapshotsAdvanced = 0;
let mpIntakeMs = 0;
let mpFrames = 0;
let mpFrameTotalMs = 0;
let mpRenderMs = 0;
let mpInspectorMs = 0;
let mpFlushTooltipMs = 0;
let mpAnalyzeMs = 0;
let mpDiagBarMs = 0;
let mpLastLogAt = 0;
function maybeLogMainProfile(): void {
  if (MAIN_PROFILE_LOG_MS <= 0) return;
  const now = performance.now();
  if (mpLastLogAt === 0) { mpLastLogAt = now; return; }
  const elapsedMs = now - mpLastLogAt;
  if (elapsedMs < MAIN_PROFILE_LOG_MS) return;
  const fmtMs = (v: number, n: number) => n > 0 ? (v / n).toFixed(2) : "-";
  const elapsedSec = elapsedMs / 1000;
  // eslint-disable-next-line no-console
  console.log(
    `[main-prof] snaps=${mpSnapshotsReceived} (${(mpSnapshotsReceived/elapsedSec).toFixed(1)}/s) `
    + `simAdv=${mpSnapshotsAdvanced.toFixed(3)}s (${(mpSnapshotsAdvanced/elapsedSec).toFixed(2)}x) `
    + `intake=${fmtMs(mpIntakeMs, mpSnapshotsReceived)}ms/snap | `
    + `frames=${mpFrames} (${(mpFrames/elapsedSec).toFixed(1)}/s) `
    + `frame=${fmtMs(mpFrameTotalMs, mpFrames)}ms `
    + `[render=${fmtMs(mpRenderMs, mpFrames)} inspector=${fmtMs(mpInspectorMs, mpFrames)} `
    + `tooltip=${fmtMs(mpFlushTooltipMs, mpFrames)} analyze=${fmtMs(mpAnalyzeMs, mpFrames)} `
    + `diag=${fmtMs(mpDiagBarMs, mpFrames)}]`,
  );
  mpSnapshotsReceived = 0;
  mpSnapshotsAdvanced = 0;
  mpIntakeMs = 0;
  mpFrames = 0;
  mpFrameTotalMs = 0;
  mpRenderMs = 0;
  mpInspectorMs = 0;
  mpFlushTooltipMs = 0;
  mpAnalyzeMs = 0;
  mpDiagBarMs = 0;
  mpLastLogAt = now;
}
let snapshotSpeciesByKey: Map<string, SpeciesSnapshot> = new Map();
let snapshotCreatureById: Map<number, CreatureSnapshot> = new Map();
function rebuildSnapshotIndexes(): void {
  snapshotSpeciesByKey.clear();
  for (const sp of snapshot.species) snapshotSpeciesByKey.set(sp.key, sp);
  snapshotCreatureById.clear();
  for (const c of snapshot.creatures) snapshotCreatureById.set(c.id, c);
}

// Keep selection alive across reproduction. The parent keeps its id
// through fission so selection normally just stays put; but if the
// selected cell dies (e.g. spent itself dividing), hand selection
// down to a child it spawned so the user keeps following the line
// instead of the tooltip blinking out. Kept OUT of
// rebuildSnapshotIndexes: that runs once at module-bootstrap (before
// the selectedCellId binding initializes), and touching it there
// would throw a TDZ ReferenceError and abort the whole module.
// If the selected cell is gone from the latest snapshot (died or
// eaten), drop the selection entirely. We deliberately do NOT hop to
// a child / nearest / first cell -- a selection silently jumping to
// some unrelated cell is more confusing than just clearing. Kept OUT
// of rebuildSnapshotIndexes: that runs once at module-bootstrap
// before the selectedCellId binding initializes, and touching it
// there would throw a TDZ ReferenceError and abort the whole module.
function clearSelectionIfDead(): void {
  if (selectedCellId != null && !snapshotCreatureById.has(selectedCellId)) {
    selectedCellId = null;
  }
}
rebuildSnapshotIndexes();

// Latest serialized save string the worker has posted to us. Autosave
// + forceSave + export all read from this cache rather than asking
// the worker synchronously (which we can't do across the worker
// boundary anyway). Updated on every "save" message from the worker.
let latestSaveJson: string | null = savedJson;

// Latest per-frame stats reported by the worker. Used by the perf
// stats line so the main thread can still display sim/wall ratio
// without measuring the work itself.
let workerSimMsThisFrame = 0;
let workerAdvancedThisFrame = 0;
let workerLastSimError: string | null = null;
let workerLastSimErrorAt = 0;
// Wall-clock timestamp when workerLastSimError was set. The error
// banner auto-clears after SIM_ERROR_LINGER_MS of continued healthy
// snapshots so a self-recovering pool teardown doesn't leave stale
// red text on screen indefinitely.
let workerLastSimErrorWallTs = 0;
const SIM_ERROR_LINGER_MS = 5000;

function maybeAutosave(): void {
  if (resetting) return;
  if (!latestSaveJson) return;
  try {
    localStorage.setItem(SAVE_KEY, latestSaveJson);
  } catch (err) {
    // Quota exceeded, private mode, etc. Don't crash the page.
    console.warn("evosim4: autosave failed", err);
  }
}
function forceSave(): void {
  // pagehide / visibilitychange both fire during a reset reload --
  // without this guard we'd write the soon-to-be-discarded world
  // right back to localStorage, defeating the reset.
  if (resetting) return;
  if (!latestSaveJson) return;
  try {
    localStorage.setItem(SAVE_KEY, latestSaveJson);
  } catch { /* quota / private mode -- ignore */ }
}
// Set in hardReset(), checked by every save path. Survives until
// the page actually unloads.
let resetting = false;
// Reset uses a two-tap arm/fire pattern. confirm() turned out to be
// silently suppressed in some iOS in-app webviews (Brave/Edge),
// which made the button look broken. The first tap turns the button
// label into a red "tap again to wipe" prompt that times out after
// 3s; the second tap inside that window actually clears the save
// and reloads.
function hardReset(): void {
  resetting = true;
  try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
  location.reload();
}
// Force-save when the tab gets backgrounded (mobile Safari frequently
// reaps tabs without firing further events). pagehide is the most
// reliable cross-browser signal for "we may not run again".
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") forceSave();
});
window.addEventListener("pagehide", forceSave);

// ---------------------------------------------------------------------
// Sim worker. Owns the live World and runs step() flat-out on a
// background thread. Posts a fresh RenderSnapshot ~60Hz; posts a
// serialized-world save string every ~60s of sim time. All world
// mutation (turbo toggle, profile toggle, applying a saved world)
// goes through messages.
// ---------------------------------------------------------------------
const simWorker = new Worker(new URL("./sim.worker.ts", import.meta.url), {
  type: "module",
});
simWorker.postMessage({
  type: "init",
  width: WORLD_SIZE.w,
  height: WORLD_SIZE.h,
  savedJson,
});
// Re-establish cull protection for pinned species. FIFO message
// order guarantees the worker has built (or restored) its world
// from the init above before this applies. speciesKey is a
// deterministic genome hash, so restored species re-match by key.
syncPinnedToWorker();
// If we passed a saved JSON in and the worker silently fell back to
// fresh (schema mismatch / malformed), the worker's "save" stream
// will overwrite localStorage with the fresh world a minute later --
// which is fine. We don't try to detect schema rejection on the main
// side any more; the worker decides.

// Particle subworkers are spawned here on the main thread rather than
// from inside sim.worker, because nested module workers (Worker spawning
// Worker) silently fail to load in some browsers under COEP isolation.
// Main relays messages between sim worker and the particle pool; the
// hot path between sim worker and particle workers stays on shared
// memory via Atomics, so the relay only carries init + ack messages.
let particleWorkers: Worker[] = [];
function teardownParticleWorkers(): void {
  for (const pw of particleWorkers) {
    try { pw.terminate(); } catch { /* ignore */ }
  }
  particleWorkers = [];
}

simWorker.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === "snapshot") {
    const tIntake = performance.now();
    snapshot = msg.snapshot;
    if (snapshot.particleTarget !== particleCap) {
      particleCap = snapshot.particleTarget;
      renderCapLabel();
    }
    syncFoundersBtn(snapshot.foundersEnabled !== false);
    rebuildSnapshotIndexes();
    clearSelectionIfDead();
    workerSimMsThisFrame += msg.simMs;
    workerAdvancedThisFrame += msg.advanced;
    if (msg.err) {
      workerLastSimError = msg.err.message;
      workerLastSimErrorAt = msg.err.at;
      workerLastSimErrorWallTs = performance.now();
    } else if (workerLastSimError && msg.advanced > 0) {
      // Snapshot advanced without a fresh error -- sim is recovering.
      // Clear the banner after the linger window.
      if (performance.now() - workerLastSimErrorWallTs > SIM_ERROR_LINGER_MS) {
        workerLastSimError = null;
        workerLastSimErrorAt = 0;
      }
    }
    mpSnapshotsReceived++;
    mpSnapshotsAdvanced += msg.advanced;
    mpIntakeMs += performance.now() - tIntake;
  } else if (msg.type === "save") {
    latestSaveJson = msg.json;
    maybeAutosave();
  } else if (msg.type === "spawn-particle-pool") {
    teardownParticleWorkers();
    const payloads = msg.initPayloads as { workerIndex: number }[];
    for (let i = 0; i < payloads.length; i++) {
      const idx = i;
      const pw = new Worker(new URL("./particle.worker.ts", import.meta.url), { type: "module" });
      pw.addEventListener("message", (ev: MessageEvent) => {
        simWorker.postMessage({ type: "particle-pool-message", index: idx, data: ev.data });
      });
      pw.addEventListener("error", (ev) => {
        simWorker.postMessage({ type: "particle-pool-error", index: idx, message: ev.message || "unknown" });
      });
      pw.addEventListener("messageerror", () => {
        simWorker.postMessage({ type: "particle-pool-error", index: idx, message: "messageerror" });
      });
      pw.postMessage(payloads[i]);
      particleWorkers.push(pw);
    }
  } else if (msg.type === "teardown-particle-pool") {
    teardownParticleWorkers();
  }
});

// Reset + export buttons live in the world-area corners. They're
// created and positioned later (positionWorldButtons), once the
// phylogeny-strip height and analysis-panel width constants are
// available, because the right-side button has to dodge the
// analysis panel when it expands.

// Cap the device pixel ratio used for canvas backing-store size. At
// DPR=3 (high-end phones, some retina displays) the backing store has
// 9x the pixels of DPR=1. Past DPR=2 the visual gain is marginal but
// every render path scales linearly with backing-store area, so this
// is a free ~2x win on those devices.
const MAX_DPR = 2;
function getDpr(): number {
  return Math.min(MAX_DPR, window.devicePixelRatio || 1);
}

// View transform mapping world coords -> canvas (CSS pixel) coords.
// Updated in resize(); used in render and inverse-applied in pointer
// handlers so a click maps to the right world position regardless of
// viewport size or pinch zoom.
let viewScale = 1;
let viewOffsetX = 0;
let viewOffsetY = 0;
// User-controlled view: in-app pinch/scroll zoom + drag pan applied
// only to the world drawing area. HUD / sidebar / phylogeny stay at
// their CSS-fixed positions regardless. Composed on top of the
// world-fit transform: finalScreenX = canvasX * viewZoom + viewPanX,
// where canvasX = worldX * viewScale + viewOffsetX. zoom 1 + pan 0
// = original auto-fit.
let viewZoom = 1;
let viewPanX = 0;
let viewPanY = 0;
const ZOOM_MIN = 1;
const ZOOM_MAX = 12;

// Track selection by stable creature id. Snapshot creatures are fresh
// objects each tick so we can't hold the reference; the id is assigned
// at newCreature time and never reused.
let selectedCellId: number | null = null;
function selectedCell(): CreatureSnapshot | null {
  return selectedCellId != null ? snapshotCreatureById.get(selectedCellId) ?? null : null;
}
let activeDisasm = "";
// One op per line, unformatted -- what the copy button hands over.
let activeDisasmRaw = "";
function refreshActiveDisasm(): void {
  const sel = selectedCell();
  if (sel) {
    activeDisasmRaw = disassemble(sel.genome, SENSOR_CHEM_LABELS);
    activeDisasm = formatDisasmColumns(activeDisasmRaw, DISASM_COL_LINES);
  } else {
    activeDisasmRaw = "";
    activeDisasm = "";
  }
}
// Width budget for the disasm body. Higher = more columns. Tuned to
// look right against the 9px monospace font in EXPANDED_FONT.
const DISASM_COL_LINES = 12;

function formatDisasmColumns(disasm: string, colLines: number): string {
  // Lay out disasm lines in a fixed-rows-per-column grid, column-major.
  // Each visual row contains one line from each column, padded to the
  // widest line of the entire disasm so columns align.
  const lines = disasm ? disasm.split("\n") : [];
  if (lines.length === 0) return "";
  const ncols = Math.max(1, Math.ceil(lines.length / colLines));
  let maxLen = 0;
  for (const ln of lines) if (ln.length > maxLen) maxLen = ln.length;
  const gutter = 2;
  const colWidth = maxLen + gutter;
  const out: string[] = [];
  for (let row = 0; row < colLines; row++) {
    const parts: string[] = [];
    for (let col = 0; col < ncols; col++) {
      const idx = col * colLines + row;
      if (idx >= lines.length) break;
      parts.push(lines[idx].padEnd(col === ncols - 1 ? 0 : colWidth));
    }
    if (parts.length === 0) continue;
    out.push(parts.join(""));
  }
  return out.join("\n");
}
refreshActiveDisasm();

// Height of the phylogeny strip rendered below the world. The world's
// bottom wall sits PHYLO_STRIP_H pixels above the canvas bottom so cells
// never overlap the timeline.
const PHYLO_STRIP_H = 70;
// Rolling phylogeny window. Older history scrolls off the left edge so
// recent events don't compress into a sliver as the sim runs forever.
const PHYLO_WINDOW_SEC = 180;
// Phylogeny filter: when true, the strip only renders the top 5
// currently-alive species ranked by live biomass. Toggled via the F
// key. Off by default so the full history view is the baseline.
let phyloFilterTop5 = false;
// Reused per-frame to avoid allocating fresh arrays/maps inside the
// phylogeny render loop. With thousands of species after a long run,
// per-frame Array.from() + Map() was costing meaningful GC pressure.
const visibleSpecies: SpeciesSnapshot[] = [];
const bioByKey = new Map<string, number>();
// All-time peak summed-biomass per species. The phylogeny render
// samples per-frame, but the worker's species snapshot doesn't carry
// peak across ticks (peak was historically tracked on the live world);
// keep the running peak on the main side so the sidebar can rank
// species by their best-ever stretch, not just the current instant.
const peakBiomassByKey = new Map<string, number>();

// Genome-analysis console: right-side sidebar. Collapsible -- when
// minimized only a thin tab shows; expanded, the canvas shrinks to
// leave room so the panel doesn't overlap the world.
// Expanded width scales with the viewport so wide screens get a
// roomy drawer instead of a fixed narrow column that over-wraps.
function analysisPanelW(): number {
  return Math.round(Math.max(340, Math.min(680, window.innerWidth * 0.40)));
}
const ANALYSIS_PANEL_W_MIN = 26;
let analysisMinimized = true;
const analysisPanel = document.createElement("div");
analysisPanel.style.cssText =
  "position:fixed;top:0;right:0;bottom:0;width:" + ANALYSIS_PANEL_W_MIN + "px;" +
  "background:rgba(4,16,24,0.92);color:#9ee;border-left:1px solid #1a3340;" +
  `font:${UI_FONT_PX}px/1.4 ${UI_FONT_FAMILY};` +
  "overflow:hidden;padding:0;box-sizing:border-box;z-index:10;";
const analysisHeader = document.createElement("div");
analysisHeader.style.cssText =
  "display:flex;align-items:center;justify-content:center;gap:6px;" +
  "padding:6px 4px;cursor:pointer;user-select:none;border-bottom:1px solid #1a3340;";
// `justify-content` is switched to space-between when expanded so the
// title sits left and the toggle sits right; in the 26px minimized
// tab there's only the toggle, and centered looks right.
const analysisTitle = document.createElement("span");
analysisTitle.textContent = "organisms";
analysisTitle.style.cssText = `font-weight:bold;font-size:${UI_FONT_PX}px;`;
const analysisToggle = document.createElement("span");
analysisToggle.textContent = "+";
// Bracketed forms ([+]/[–]) didn't fit inside the 26px minimized tab
// and got clipped on the right edge. Use the bare glyph; the box on
// the tab itself is the affordance.
analysisToggle.style.cssText = "padding:0 4px;";
analysisHeader.appendChild(analysisTitle);
analysisHeader.appendChild(analysisToggle);
const PANE_MAXH = "max-height:calc(100vh - 72px);";
// List body (Top 10 / Pinned / Notable species cards).
const analysisBody = document.createElement("div");
analysisBody.style.cssText =
  "white-space:pre-wrap;padding:8px 10px;overflow-y:auto;display:none;" + PANE_MAXH;
// Inspector pane: selected-cell readout + pin control + disasm. The
// disasm grid is wide, so allow both-axis scroll.
const inspectorPane = document.createElement("div");
inspectorPane.style.cssText =
  "padding:6px 4px 10px;overflow:auto;display:none;" + PANE_MAXH;
inspectorPane.appendChild(inspector);
inspectorPane.appendChild(pinSpeciesBtn);
inspectorPane.appendChild(inspectorProse);
inspectorPane.appendChild(disasmBar);
inspectorPane.appendChild(disasmBody);
// Genome pane: the population genome-size histogram canvas.
const genomePane = document.createElement("div");
genomePane.style.cssText = "padding:8px 10px;display:none;";
const gsCanvas = document.createElement("canvas");
gsCanvas.style.cssText = "width:100%;height:160px;display:block;";
genomePane.appendChild(gsCanvas);

// Tabs: Inspector (selected cell) | Top 10 / Pinned / Notable (species
// lists) | Genome (size histogram). Hidden while the panel is minimized.
type AnalysisTab = "inspector" | "top" | "pinned" | "notable" | "genome";
let analysisTab: AnalysisTab = "inspector";
const analysisTabs = document.createElement("div");
analysisTabs.style.cssText =
  "display:none;flex-wrap:wrap;border-bottom:1px solid #1a3340;";
const TAB_DEFS: { id: AnalysisTab; label: string }[] = [
  { id: "inspector", label: "Inspector" },
  { id: "top", label: "Top 10" },
  { id: "pinned", label: "Pinned" },
  { id: "notable", label: "Notable" },
  { id: "genome", label: "Genome" },
];
const tabButtons = new Map<AnalysisTab, HTMLSpanElement>();
function styleTab(btn: HTMLSpanElement, active: boolean): void {
  btn.style.cssText =
    "display:inline-block;padding:5px 10px;cursor:pointer;user-select:none;" +
    `font-size:${UI_FONT_PX}px;` +
    (active
      ? "color:#cff;border-bottom:2px solid #4cc;font-weight:bold;"
      : "color:#7aa;border-bottom:2px solid transparent;");
}
function isListTab(t: AnalysisTab): boolean {
  return t === "top" || t === "pinned" || t === "notable";
}
function applyTabVisibility(): void {
  const open = !analysisMinimized;
  analysisBody.style.display = open && isListTab(analysisTab) ? "" : "none";
  inspectorPane.style.display = open && analysisTab === "inspector" ? "" : "none";
  genomePane.style.display = open && analysisTab === "genome" ? "" : "none";
}
for (const def of TAB_DEFS) {
  const btn = document.createElement("span");
  btn.textContent = def.label;
  styleTab(btn, def.id === analysisTab);
  btn.addEventListener("click", () => {
    analysisTab = def.id;
    for (const [id, b] of tabButtons) styleTab(b, id === analysisTab);
    applyTabVisibility();
    renderAnalysisPanel();
  });
  tabButtons.set(def.id, btn);
  analysisTabs.appendChild(btn);
}
analysisPanel.appendChild(analysisHeader);
analysisPanel.appendChild(analysisTabs);
analysisPanel.appendChild(analysisBody);
analysisPanel.appendChild(inspectorPane);
analysisPanel.appendChild(genomePane);
root.appendChild(analysisPanel);
// When minimized, hide the title text so just the [+] sits in the tab.
analysisTitle.style.display = "none";
analysisHeader.addEventListener("click", () => {
  analysisMinimized = !analysisMinimized;
  analysisPanel.style.width = (analysisMinimized ? ANALYSIS_PANEL_W_MIN : analysisPanelW()) + "px";
  analysisTabs.style.display = analysisMinimized ? "none" : "flex";
  analysisToggle.textContent = analysisMinimized ? "+" : "–";
  analysisTitle.style.display = analysisMinimized ? "none" : "";
  analysisHeader.style.justifyContent = analysisMinimized ? "center" : "space-between";
  analysisHeader.style.padding = analysisMinimized ? "6px 4px" : "6px 8px";
  applyTabVisibility();
  resize();
  positionWorldButtons();
  // Populate immediately on expand instead of waiting for the next
  // 60s analysis cycle.
  if (!analysisMinimized) renderAnalysisPanel();
});

// ---------------------------------------------------------------------
// Left slide-out: the "chemistry" drawer. Mirrors the organisms drawer
// (responsive width, tab chrome, collapsible). Tabs:
//   Ledger -- per-chem table (dissolved / visible / simulated) with a
//             name filter + sortable columns; click a row for detail.
//   Detail -- the selected material's reaction accounting + cumulative
//             produced/consumed/net graph, folded in from the old
//             fixed flyout so it no longer overlays the world.
// ---------------------------------------------------------------------
function chemPanelW(): number {
  return Math.round(Math.max(340, Math.min(680, window.innerWidth * 0.40)));
}
const LEFT_PANEL_W_MIN = 26;
let leftMinimized = true;
function leftPanelWidth(): number {
  return leftMinimized ? LEFT_PANEL_W_MIN : chemPanelW();
}
const leftPanel = document.createElement("div");
leftPanel.style.cssText =
  "position:fixed;top:0;left:0;bottom:0;width:" + LEFT_PANEL_W_MIN + "px;" +
  "background:rgba(4,16,24,0.92);color:#9ee;border-right:1px solid #1a3340;" +
  `font:${UI_FONT_PX}px/1.4 ${UI_FONT_FAMILY};` +
  "overflow:hidden;padding:0;box-sizing:border-box;z-index:10;";
const leftHeader = document.createElement("div");
leftHeader.style.cssText =
  "display:flex;align-items:center;justify-content:center;gap:6px;" +
  "padding:6px 4px;cursor:pointer;user-select:none;border-bottom:1px solid #1a3340;";
const leftToggle = document.createElement("span");
leftToggle.textContent = "+";
leftToggle.style.cssText = "padding:0 4px;";
const leftTitle = document.createElement("span");
leftTitle.textContent = "chemistry";
leftTitle.style.cssText = `font-weight:bold;font-size:${UI_FONT_PX}px;display:none;`;
leftHeader.appendChild(leftToggle);
leftHeader.appendChild(leftTitle);

// Tab bar -- same chrome as the organisms drawer (styleTab reused).
type ChemTab = "ledger" | "detail";
let chemTab: ChemTab = "ledger";
const chemTabs = document.createElement("div");
chemTabs.style.cssText =
  "display:none;flex-wrap:wrap;border-bottom:1px solid #1a3340;";
const CHEM_TAB_DEFS: { id: ChemTab; label: string }[] = [
  { id: "ledger", label: "Ledger" },
  { id: "detail", label: "Detail" },
];
const chemTabBtns = new Map<ChemTab, HTMLSpanElement>();

// Ledger pane: name filter + sortable per-chem table.
const ledgerPane = document.createElement("div");
ledgerPane.style.cssText =
  "padding:8px 10px;overflow:auto;display:none;max-height:calc(100vh - 72px);";
const chemFilter = document.createElement("input");
chemFilter.type = "text";
chemFilter.placeholder = "filter materials…";
chemFilter.style.cssText =
  "width:100%;box-sizing:border-box;margin-bottom:8px;padding:4px 6px;" +
  "background:rgba(0,0,0,.4);border:1px solid #1a3340;border-radius:4px;" +
  `color:#9ee;font:${UI_FONT_PX}px ${UI_FONT_FAMILY};`;
const chemTable = document.createElement("table");
chemTable.style.cssText =
  "border-collapse:collapse;width:100%;font-size:" + UI_FONT_PX + "px;";
ledgerPane.appendChild(chemFilter);
ledgerPane.appendChild(chemTable);

// Detail pane: in-drawer reaction accounting + graph.
const detailPane = document.createElement("div");
detailPane.style.cssText =
  "padding:10px 12px;overflow-y:auto;overflow-x:hidden;display:none;" +
  "max-height:calc(100vh - 72px);overflow-wrap:anywhere;word-break:break-word;" +
  `font:${UI_FONT_PX}px/1.45 ${UI_FONT_FAMILY};`;

const leftBody = document.createElement("div");
leftBody.style.cssText = "display:none;";
leftBody.appendChild(chemTabs);
leftBody.appendChild(ledgerPane);
leftBody.appendChild(detailPane);
leftPanel.appendChild(leftHeader);
leftPanel.appendChild(leftBody);
root.appendChild(leftPanel);

let chemDetailId: number | null = null;
let RXN_CATALOG: ReactionInfo[] | null = null;

function applyChemTab(): void {
  const open = !leftMinimized;
  chemTabs.style.display = open ? "flex" : "none";
  ledgerPane.style.display = open && chemTab === "ledger" ? "" : "none";
  detailPane.style.display = open && chemTab === "detail" ? "" : "none";
  for (const [id, b] of chemTabBtns) styleTab(b, id === chemTab);
}
for (const def of CHEM_TAB_DEFS) {
  const btn = document.createElement("span");
  btn.textContent = def.label;
  styleTab(btn, def.id === chemTab);
  btn.addEventListener("click", () => {
    chemTab = def.id;
    applyChemTab();
    if (chemTab === "detail") renderChemDetail();
  });
  chemTabBtns.set(def.id, btn);
  chemTabs.appendChild(btn);
}
function showChemDetail(k: number): void {
  chemDetailId = k;
  chemTab = "detail";
  applyChemTab();
  renderChemDetail();
}
function backToLedger(): void {
  chemTab = "ledger";
  applyChemTab();
}

function renderChemDetail(): void {
  if (chemDetailId == null) {
    detailPane.innerHTML =
      `<div style="opacity:0.6;padding:6px 0;">Select a material in the Ledger tab.</div>`;
    return;
  }
  const k = chemDetailId;
  if (!RXN_CATALOG) RXN_CATALOG = reactionCatalog();
  const totals = snapshot.reactionTotals;
  const cnt = (id: number): number => (totals ? (totals[id] ?? 0) : 0);
  const coefFor = (terms: { chem: number; coef: number }[]): number => {
    let s = 0; for (const t of terms) if (t.chem === k) s += t.coef; return s;
  };
  type Row = { label: string; n: number; mass: number };
  const prod: Row[] = [];
  const cons: Row[] = [];
  for (const r of RXN_CATALOG) {
    const n = cnt(r.id);
    const pc = coefFor(r.produces);
    const cc = coefFor(r.consumes);
    if (pc > 0) prod.push({ label: r.label, n, mass: chemAmountToParticles(k, n * pc) });
    if (cc > 0) cons.push({ label: r.label, n, mass: chemAmountToParticles(k, n * cc) });
  }
  const nz = (a: Row[]): Row[] => a.filter((x) => x.n > 0).sort((x, y) => y.mass - x.mass);
  const pNZ = nz(prod), cNZ = nz(cons);
  const pTot = pNZ.reduce((s, x) => s + x.n, 0);
  const cTot = cNZ.reduce((s, x) => s + x.n, 0);
  const pMass = pNZ.reduce((s, x) => s + x.mass, 0);
  const cMass = cNZ.reduce((s, x) => s + x.mass, 0);
  const fmtMass = (v: number): string =>
    v >= 1000 ? Math.round(v).toLocaleString() : v >= 1 ? v.toFixed(0) : v.toFixed(2);
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const list = (rows: Row[]): string =>
    rows.length === 0
      ? `<div style="opacity:0.6;padding:2px 0;">none recorded</div>`
      : rows.map((x) =>
        `<div style="display:flex;justify-content:space-between;gap:10px;padding:1px 0;border-bottom:1px solid rgba(26,51,64,0.4);">` +
        `<span style="min-width:0;overflow-wrap:anywhere;">${esc(x.label)}</span>` +
        `<span style="white-space:nowrap;"><b style="color:#cfe;">${fmtMass(x.mass)}</b>` +
        `<span style="opacity:0.55;"> &nbsp;(${x.n.toLocaleString()}×)</span></span></div>`).join("");
  const totals0 = totals == null;
  const netMass = pMass - cMass;
  detailPane.innerHTML =
    `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">` +
    `<b style="font-size:${UI_FONT_PX + 2}px;">${esc(chemName(k))}</b>` +
    `<span id="chemDetailClose" style="cursor:pointer;padding:2px 8px;border:1px solid #1a3340;border-radius:3px;">‹ ledger</span></div>` +
    (totals0
      ? `<div style="opacity:0.6;margin-bottom:8px;">reaction accounting unavailable (no rxnStats)</div>`
      : `<canvas id="chemGraph" width="352" height="150" style="width:100%;height:150px;` +
        `display:block;margin:2px 0 4px;background:rgba(0,0,0,0.25);border:1px solid #1a3340;"></canvas>` +
        `<div style="opacity:0.5;font-size:${UI_FONT_PX - 2}px;margin-bottom:8px;">` +
        `cumulative p-eq vs time — <span style="color:#9efba8;">produced</span> / ` +
        `<span style="color:#ff9e9e;">consumed</span> / <span style="color:#fff;">net</span> ` +
        `(spawn input excluded)</div>`) +
    `<div style="margin:6px 0;">Net since inception ` +
    `(produced − consumed): <b style="color:${netMass >= 0 ? "#9efba8" : "#ff9e9e"};">` +
    `${netMass >= 0 ? "+" : "−"}${fmtMass(Math.abs(netMass))} p-eq</b>` +
    `<span style="opacity:0.55;"> &nbsp;(${(pTot - cTot).toLocaleString()} net events)</span></div>` +
    `<div style="opacity:0.55;font-size:${UI_FONT_PX - 2}px;margin-bottom:6px;">` +
    `values are 2px-particle-equivalents (same scale as dissolved/visible/simulated)</div>` +
    `<div style="margin-top:10px;color:#9efba8;font-weight:bold;">Producers (+${fmtMass(pMass)} p-eq · ${pTot.toLocaleString()} events)</div>` +
    `<div style="opacity:0.5;font-size:${UI_FONT_PX - 2}px;margin:1px 0 3px;">reaction&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;p-eq&nbsp;(executions)</div>` +
    list(pNZ) +
    `<div style="margin-top:12px;color:#ff9e9e;font-weight:bold;">Consumers (−${fmtMass(cMass)} p-eq · ${cTot.toLocaleString()} events)</div>` +
    `<div style="opacity:0.5;font-size:${UI_FONT_PX - 2}px;margin:1px 0 3px;">reaction&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;p-eq&nbsp;(executions)</div>` +
    list(cNZ);
  const cl = detailPane.querySelector("#chemDetailClose");
  if (cl) cl.addEventListener("click", backToLedger);
  drawChemGraph(k);
}

// Cumulative produced (green) / consumed (red, negative) / net (white)
// p-eq vs time for the selected material. Spawn input excluded so the
// seed doesn't swamp the curve.
function drawChemGraph(k: number): void {
  const canvas = detailPane.querySelector("#chemGraph") as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  canvas.width = Math.max(240, Math.floor((detailPane.clientWidth || chemPanelW()) - 28));
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const hist = snapshot.rxnStatsHistory;
  if (!RXN_CATALOG) RXN_CATALOG = reactionCatalog();
  const series = hist ? reactionWindowSeries(hist) : [];
  const coefOf = (terms: { chem: number; coef: number }[]): number => {
    let s = 0; for (const t of terms) if (t.chem === k) s += t.coef; return s;
  };
  const prod = RXN_CATALOG
    .filter((r) => !r.external && r.produces.some((t) => t.chem === k))
    .map((r) => ({ id: r.id, coef: coefOf(r.produces) }));
  const cons = RXN_CATALOG
    .filter((r) => !r.external && r.consumes.some((t) => t.chem === k))
    .map((r) => ({ id: r.id, coef: coefOf(r.consumes) }));
  type P = { t: number; g: number; r: number; n: number };
  const pts: P[] = [];
  let cg = 0, cc = 0;
  for (const w of series) {
    let pa = 0, ca = 0;
    for (const x of prod) pa += w.counts[x.id] * x.coef;
    for (const x of cons) ca += w.counts[x.id] * x.coef;
    cg += chemAmountToParticles(k, pa);
    cc += chemAmountToParticles(k, ca);
    pts.push({ t: w.t0, g: cg, r: -cc, n: cg - cc });
  }
  if (pts.length > 0) pts.push({ t: Math.max(snapshot.t, pts[pts.length - 1].t), g: cg, r: -cc, n: cg - cc });
  if (pts.length < 2) {
    ctx.fillStyle = "rgba(158,238,255,0.5)";
    ctx.font = "11px ui-monospace,monospace";
    ctx.fillText("collecting… (first window at ~60s)", 8, H / 2);
    return;
  }
  const tMax = Math.max(1, pts[pts.length - 1].t);
  let yMin = 0, yMax = 0;
  for (const p of pts) {
    yMax = Math.max(yMax, p.g, p.n);
    yMin = Math.min(yMin, p.r, p.n);
  }
  if (yMax === yMin) yMax = yMin + 1;
  const padL = 4, padR = 4, padT = 6, padB = 12;
  const xx = (t: number): number => padL + (t / tMax) * (W - padL - padR);
  const yy = (v: number): number => padT + (1 - (v - yMin) / (yMax - yMin)) * (H - padT - padB);
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, yy(0)); ctx.lineTo(W - padR, yy(0)); ctx.stroke();
  const line = (sel: (p: P) => number, color: string, width: number): void => {
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath();
    pts.forEach((p, idx) => {
      const X = xx(p.t), Y = yy(sel(p));
      if (idx === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
    });
    ctx.stroke();
  };
  line((p) => p.r, "#ff6b6b", 1.5);
  line((p) => p.g, "#5dd97a", 1.5);
  line((p) => p.n, "#ffffff", 2.5);
  ctx.fillStyle = "rgba(158,238,255,0.55)";
  ctx.font = "10px ui-monospace,monospace";
  const mm = Math.floor(tMax / 60);
  ctx.fillText(`0`, padL, H - 2);
  const lbl = `${mm}m`;
  ctx.fillText(lbl, W - padR - ctx.measureText(lbl).width, H - 2);
}

// Lazily-built fixed row set: one <tr> per chem id, cells updated in
// place so the per-frame refresh never thrashes layout. Sorting just
// re-appends the existing <tr>s; filtering toggles row display.
type SortKey = "id" | "name" | "diss" | "rend" | "res";
type ChemRow = {
  k: number; tr: HTMLTableRowElement;
  name: HTMLTableCellElement; diss: HTMLTableCellElement;
  rend: HTMLTableCellElement; res: HTMLTableCellElement;
  vName: string; vDiss: number; vRend: number; vRes: number;
};
let chemRows: ChemRow[] | null = null;
let chemSortKey: SortKey = "id";
let chemSortDir: 1 | -1 = 1;
function setChemSort(key: SortKey): void {
  if (chemSortKey === key) chemSortDir = (chemSortDir === 1 ? -1 : 1);
  else { chemSortKey = key; chemSortDir = key === "name" || key === "id" ? 1 : -1; }
  applyLedgerView();
}
function buildChemTable(n: number): void {
  chemTable.textContent = "";
  const thead = document.createElement("tr");
  const cols: [string, boolean, SortKey][] = [
    ["chem", false, "name"], ["dissolved", true, "diss"],
    ["visible", true, "rend"], ["simulated", true, "res"],
  ];
  for (const [label, alignRight, key] of cols) {
    const th = document.createElement("th");
    th.textContent = label;
    th.style.cssText =
      "text-align:" + (alignRight ? "right" : "left") +
      ";padding:2px 6px;border-bottom:1px solid #1a3340;color:#7fb8c8;" +
      "position:sticky;top:0;background:rgba(4,16,24,0.98);cursor:pointer;" +
      "user-select:none;white-space:nowrap;";
    th.title = "sort";
    th.addEventListener("click", () => setChemSort(key));
    thead.appendChild(th);
  }
  chemTable.appendChild(thead);
  const rows: ChemRow[] = [];
  for (let k = 0; k < n; k++) {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.title = `accounting for ${chemName(k)}`;
    tr.addEventListener("click", () => showChemDetail(k));
    tr.addEventListener("mouseenter", () => { tr.style.background = "rgba(40,80,100,0.35)"; });
    tr.addEventListener("mouseleave", () => { tr.style.background = ""; });
    const mk = (alignRight: boolean): HTMLTableCellElement => {
      const td = document.createElement("td");
      td.style.cssText =
        "padding:1px 6px;text-align:" + (alignRight ? "right" : "left") +
        ";border-bottom:1px solid rgba(26,51,64,0.5);white-space:nowrap;";
      tr.appendChild(td);
      return td;
    };
    const name = mk(false), diss = mk(true), rend = mk(true), res = mk(true);
    name.textContent = chemName(k);
    chemTable.appendChild(tr);
    rows.push({ k, tr, name, diss, rend, res, vName: chemName(k), vDiss: 0, vRend: 0, vRes: 0 });
  }
  chemRows = rows;
}
function applyLedgerView(): void {
  if (!chemRows) return;
  const q = chemFilter.value.trim().toLowerCase();
  const cmp = (a: ChemRow, b: ChemRow): number => {
    let d: number;
    switch (chemSortKey) {
      case "name": d = a.vName.localeCompare(b.vName); break;
      case "diss": d = a.vDiss - b.vDiss; break;
      case "rend": d = a.vRend - b.vRend; break;
      case "res": d = a.vRes - b.vRes; break;
      default: d = a.k - b.k;
    }
    return (d || a.k - b.k) * chemSortDir;
  };
  const ordered = [...chemRows].sort(cmp);
  for (const r of ordered) {
    r.tr.style.display = q && !r.vName.toLowerCase().includes(q) ? "none" : "";
    chemTable.appendChild(r.tr); // re-append in sorted order
  }
}
chemFilter.addEventListener("input", applyLedgerView);

let lastChemPanelMs = 0;
function updateChemPanel(): void {
  if (leftMinimized) return;
  const now = performance.now();
  if (now - lastChemPanelMs < 400) return;
  lastChemPanelMs = now;
  const diss = snapshot.chemDissolved;
  const resv = snapshot.chemReserveCount;
  if (!diss || !resv) return;
  const n = diss.length;
  if (!chemRows || chemRows.length !== n) buildChemTable(n);
  const rows = chemRows!;
  const rendered = new Float64Array(n);
  for (const p of snapshot.particles) {
    const c = p.chemId;
    if (c >= 0 && c < n) rendered[c]++;
  }
  const fmt = (v: number): string =>
    v === 0 ? "0" : v >= 1000 ? Math.round(v).toLocaleString() : v >= 1 ? v.toFixed(0) : v.toFixed(2);
  for (let k = 0; k < n; k++) {
    const r = rows[k];
    r.vDiss = diss[k]; r.vRend = rendered[k]; r.vRes = resv[k];
    r.diss.textContent = fmt(diss[k]);
    r.rend.textContent = fmt(rendered[k]);
    r.res.textContent = fmt(resv[k]);
  }
  applyLedgerView();
  if (chemTab === "detail" && chemDetailId != null) renderChemDetail();
}
leftHeader.addEventListener("click", () => {
  leftMinimized = !leftMinimized;
  leftPanel.style.width = leftPanelWidth() + "px";
  leftBody.style.display = leftMinimized ? "none" : "";
  leftToggle.textContent = leftMinimized ? "+" : "–";
  leftTitle.style.display = leftMinimized ? "none" : "";
  leftHeader.style.justifyContent = leftMinimized ? "center" : "space-between";
  leftHeader.style.padding = leftMinimized ? "6px 4px" : "6px 8px";
  applyChemTab();
  resize();
  positionWorldButtons();
  if (!leftMinimized) { lastChemPanelMs = 0; updateChemPanel(); }
});
// ===================================================================

// ===================================================================
// Bottom Controls bar. Reserved region (its measured height is taken
// out of the world fit, so it never overlays the world), grouped into
// run / world / view, collapsible to a slim handle. Replaces the old
// floating dock. Explicit text color here -- bare label spans were
// invisible because the container set no color.
// ---------------------------------------------------------------------
let controlsBarH = 40;        // measured each layout
// Measured height of the fixed top status strip. The world fit
// reserves it at the top (mirroring controlsBarH at the bottom) so
// the world is never drawn behind the HUD -- the bar sits in its own
// band, outside the world drawing area.
let hudBarH = 0;
function topReserveH(): number { return hudBarH; }
let controlsCollapsed = false;
const CBTN =
  "padding:4px 9px;border:1px solid #1a3340;border-radius:4px;" +
  "background:rgba(0,0,0,.45);color:#9ee;cursor:pointer;white-space:nowrap;" +
  HUD_FONT;
function mkBtn(label: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label; b.title = title; b.style.cssText = CBTN;
  return b;
}
function setBtn(b: HTMLButtonElement, on: boolean, tint: string): void {
  b.style.cssText = CBTN + (on ? tint : "");
}
const T_AMBER = "background:rgba(60,40,0,.75);color:#ffd49e;border-color:#a87a3a;";
const T_TEAL  = "background:rgba(0,40,60,.75);color:#9ee;border-color:#3a7a8a;";
const T_GREEN = "background:rgba(0,50,20,.75);color:#9efba8;border-color:#3a8a5a;";
const T_RED   = "background:rgba(60,0,0,.75);color:#fdd;border-color:#a55;";

const ctrlBar = document.createElement("div");
ctrlBar.style.cssText =
  "position:fixed;z-index:10;bottom:0;display:flex;flex-wrap:wrap;" +
  "align-items:center;gap:6px 10px;padding:5px 8px;box-sizing:border-box;" +
  "color:#9ee;background:rgba(2,12,18,0.96);border-top:1px solid #1a3340;" +
  HUD_FONT;
root.appendChild(ctrlBar);

// Collapse handle (always visible, far left of the bar).
const ctrlHandle = document.createElement("button");
ctrlHandle.style.cssText = CBTN + "padding:4px 8px;";
const ctrlGroupsWrap = document.createElement("div");
ctrlGroupsWrap.style.cssText =
  "display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;" +
  "flex:1 1 auto;min-width:0;max-width:100%;";
function renderCtrlCollapsed(): void {
  ctrlHandle.textContent = controlsCollapsed ? "▸ controls" : "▾ controls";
  ctrlGroupsWrap.style.display = controlsCollapsed ? "none" : "flex";
}
ctrlHandle.addEventListener("click", () => {
  controlsCollapsed = !controlsCollapsed;
  renderCtrlCollapsed();
  positionWorldButtons();
  resize();
});
ctrlBar.append(ctrlHandle, ctrlGroupsWrap);

// A labelled control group.
function mkGroup(name: string): HTMLDivElement {
  const g = document.createElement("div");
  // Groups wrap internally too: on a narrow/mobile width a single
  // group (e.g. WORLD = founders + cap slider) can be wider than the
  // bar, so its buttons must break onto a new line instead of being
  // clipped off the right edge.
  g.style.cssText =
    "display:flex;flex-wrap:wrap;align-items:center;gap:6px;" +
    "min-width:0;max-width:100%;";
  const lab = document.createElement("span");
  lab.textContent = name;
  lab.style.cssText = "opacity:0.55;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;";
  g.appendChild(lab);
  ctrlGroupsWrap.appendChild(g);
  return g;
}
const gRun = mkGroup("run");
const gWorld = mkGroup("world");
const gView = mkGroup("view");

// ---- run: reset / turbo / profile / export ----
const resetBtn = mkBtn("reset", "Clear saved world and start fresh");
let resetArmedUntil = 0;
let resetArmTimer: ReturnType<typeof setTimeout> | null = null;
function disarmReset(): void {
  resetArmedUntil = 0; resetBtn.textContent = "reset"; resetBtn.style.cssText = CBTN;
  if (resetArmTimer) { clearTimeout(resetArmTimer); resetArmTimer = null; }
}
resetBtn.addEventListener("click", () => {
  const now = performance.now();
  if (now < resetArmedUntil) { hardReset(); return; }
  resetArmedUntil = now + 3000;
  resetBtn.textContent = "tap again to wipe";
  resetBtn.style.cssText = CBTN + T_RED;
  if (resetArmTimer) clearTimeout(resetArmTimer);
  resetArmTimer = setTimeout(disarmReset, 3000);
});
let turboMode = false;
let turboFrameCounter = 0;
const TURBO_RENDER_EVERY = 30;
const turboBtn = mkBtn("turbo", "Run sim flat-out; render once per ~500ms");
turboBtn.addEventListener("click", () => {
  turboMode = !turboMode;
  turboFrameCounter = 0;
  turboBtn.textContent = turboMode ? "turbo on" : "turbo";
  setBtn(turboBtn, turboMode, T_AMBER);
  simWorker.postMessage({ type: "setTurbo", turbo: turboMode });
});
let profileOn = false;
const profileBtn = mkBtn("profile", "Toggle the sim profiler (logs per-phase timings)");
profileBtn.addEventListener("click", () => {
  if (profileOn && snapshot.profile) dumpProfile();
  profileOn = !profileOn;
  setBtn(profileBtn, profileOn, T_TEAL);
  simWorker.postMessage({ type: "toggleProfile" });
});
const exportBtn = mkBtn("export", "Download the saved world as JSON");
exportBtn.addEventListener("click", () => {
  const json = latestSaveJson;
  if (!json) { alert("export not ready yet -- try again in a moment"); return; }
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `evosim4-save-t${Math.floor(snapshot.t)}s.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
});
gRun.append(resetBtn, turboBtn, profileBtn, exportBtn);

// ---- world: founders / particle cap ----
let foundersOn = true;
const foundersBtn = mkBtn("founders on", "Toggle spawning of new founder lineages (saved with the world)");
setBtn(foundersBtn, true, T_GREEN);
foundersBtn.addEventListener("click", () => {
  foundersOn = !foundersOn;
  foundersBtn.textContent = foundersOn ? "founders on" : "founders off";
  setBtn(foundersBtn, foundersOn, T_GREEN);
  simWorker.postMessage({ type: "setFoundersEnabled", on: foundersOn });
});
function syncFoundersBtn(on: boolean): void {
  if (on === foundersOn) return;
  foundersOn = on;
  foundersBtn.textContent = foundersOn ? "founders on" : "founders off";
  setBtn(foundersBtn, foundersOn, T_GREEN);
}
let particleCap = 5000;
const capWrap = document.createElement("div");
capWrap.style.cssText =
  "display:flex;align-items:center;gap:6px;padding:2px 8px;flex:0 1 auto;" +
  "white-space:nowrap;max-width:100%;border:1px solid #1a3340;" +
  "border-radius:4px;color:#9ee;background:rgba(0,0,0,.4);";
const capTitle = document.createElement("span");
capTitle.textContent = "cap"; capTitle.style.cssText = "opacity:0.7;";
const capValue = document.createElement("span");
capValue.style.cssText = "font-weight:bold;min-width:4ch;text-align:right;color:#cfe;";
const capMinus = mkBtn("−", `Lower the particle cap by ${PARTICLE_TARGET_STEP}`);
const capPlus = mkBtn("+", `Raise the particle cap by ${PARTICLE_TARGET_STEP}`);
capMinus.style.cssText = CBTN + "padding:1px 9px;";
capPlus.style.cssText = CBTN + "padding:1px 9px;";
function renderCapLabel(): void { capValue.textContent = String(particleCap); }
function nudgeCap(delta: number): void {
  particleCap = Math.max(PARTICLE_TARGET_STEP, particleCap + delta);
  renderCapLabel();
  simWorker.postMessage({ type: "setParticleCap", cap: particleCap });
}
capMinus.addEventListener("click", () => nudgeCap(-PARTICLE_TARGET_STEP));
capPlus.addEventListener("click", () => nudgeCap(PARTICLE_TARGET_STEP));
renderCapLabel();
capWrap.append(capTitle, capMinus, capValue, capPlus);
gWorld.append(foundersBtn, capWrap);

// ---- view: overlay / density sources / material / grid ----
type HeatmapMode = "off" | "temp" | "density";
let heatmapMode: HeatmapMode = "off";
const HEATMAP_CELL = 32;
const HEATMAP_ALPHA = 0.28;
const SELECT_CSS =
  "padding:3px 6px;border:1px solid #1a3340;border-radius:4px;" +
  "background:rgba(0,0,0,.5);color:#9ee;cursor:pointer;" + HUD_FONT;
const overlaySelectEl = document.createElement("select");
overlaySelectEl.title = "Field overlay";
overlaySelectEl.style.cssText = SELECT_CSS;
for (const [val, txt] of [["off", "overlay: none"], ["temp", "overlay: temperature"], ["density", "overlay: density"]] as [HeatmapMode, string][]) {
  const o = document.createElement("option");
  o.value = val; o.textContent = txt; overlaySelectEl.appendChild(o);
}
function setOverlay(mode: HeatmapMode): void {
  heatmapMode = mode;
  if (overlaySelectEl.value !== mode) overlaySelectEl.value = mode;
}
overlaySelectEl.addEventListener("change", () => setOverlay(overlaySelectEl.value as HeatmapMode));
let densRend = true, densDiss = true, densResv = true, densVivo = true;
const densSrcWrap = document.createElement("span");
densSrcWrap.style.cssText = "display:flex;align-items:center;gap:7px;color:#9ee;";
function mkSrcChk(text: string, set: (v: boolean) => void): HTMLLabelElement {
  const l = document.createElement("label");
  l.style.cssText = "display:flex;align-items:center;gap:2px;cursor:pointer;";
  const cb = document.createElement("input");
  cb.type = "checkbox"; cb.checked = true; cb.style.cssText = "cursor:pointer;";
  cb.addEventListener("change", () => set(cb.checked));
  l.append(cb, document.createTextNode(text));
  return l;
}
densSrcWrap.append(
  mkSrcChk("visible", (v) => { densRend = v; }),
  mkSrcChk("dissolved", (v) => { densDiss = v; }),
  mkSrcChk("simulated", (v) => { densResv = v; }),
  mkSrcChk("in vivo", (v) => { densVivo = v; }),
);
let densityChemSel = -1;
const densChemSel = document.createElement("select");
densChemSel.title = "Density overlay: limit to one material";
densChemSel.style.cssText = SELECT_CSS + "max-width:13ch;";
{
  const optAll = document.createElement("option");
  optAll.value = "-1"; optAll.textContent = "mat: all";
  densChemSel.appendChild(optAll);
  const nChem = snapshot.chemDissolved ? snapshot.chemDissolved.length : 0;
  for (let k = 0; k < nChem; k++) {
    const o = document.createElement("option");
    o.value = String(k); o.textContent = chemName(k);
    densChemSel.appendChild(o);
  }
}
densChemSel.addEventListener("change", () => {
  const v = parseInt(densChemSel.value, 10);
  densityChemSel = Number.isNaN(v) ? -1 : v;
  simWorker.postMessage({ type: "setDensityChem", chem: densityChemSel });
});
let gridLinesOn = false;
const gridBtn = mkBtn("grid", "Toggle the region grid overlay");
gridBtn.addEventListener("click", () => {
  gridLinesOn = !gridLinesOn;
  gridBtn.textContent = gridLinesOn ? "grid on" : "grid";
  setBtn(gridBtn, gridLinesOn, T_TEAL);
});
gView.append(overlaySelectEl, densChemSel, densSrcWrap, gridBtn);

renderCtrlCollapsed();

// Geometry: span between the side panels, anchored to screen bottom;
// measure real height so the world fit can reserve exactly that.
function positionWorldButtons(): void {
  const panelW = analysisMinimized ? ANALYSIS_PANEL_W_MIN : analysisPanelW();
  ctrlBar.style.left = `${leftPanelWidth()}px`;
  ctrlBar.style.right = `${panelW}px`;
  controlsBarH = Math.ceil(ctrlBar.getBoundingClientRect().height) || 40;
  // Keep the status strip clear of the left slide-out's tab/panel.
  hud.style.left = `${leftPanelWidth() + 8}px`;
  hudBarH = Math.ceil(hud.getBoundingClientRect().height) || 0;
}
// The HUD grows/shrinks a line as its stats text wraps (longer sim
// time, bigger population). Re-fit the world whenever its measured
// height changes so the world band stays exactly below the bar. The
// observer can't loop: a resize() doesn't change the HUD's width.
new ResizeObserver(() => {
  const prev = hudBarH;
  hudBarH = Math.ceil(hud.getBoundingClientRect().height) || 0;
  if (hudBarH !== prev) resize();
}).observe(hud);
function bottomReserveH(): number { return PHYLO_STRIP_H + controlsBarH; }


function resize(): void {
  // Prefer the visual viewport on mobile: pinch-zoom changes visualViewport
  // dimensions but doesn't fire window.resize on iOS Safari.
  const vv = window.visualViewport;
  const dpr = getDpr();
  const fullW = vv ? vv.width : window.innerWidth;
  const h = vv ? vv.height : window.innerHeight;
  // Reserve a strip on each side for the slide-out consoles (left =
  // chemistry, right = organisms) so the canvas doesn't render
  // under either. Each width depends on whether that panel is expanded.
  if (!analysisMinimized) analysisPanel.style.width = `${analysisPanelW()}px`;
  const panelW = analysisMinimized ? ANALYSIS_PANEL_W_MIN : analysisPanelW();
  const leftW = leftPanelWidth();
  const reserve = panelW + leftW;
  const w = fullW > reserve * 2 ? fullW - reserve : Math.max(1, fullW - leftW);
  canvas.style.marginLeft = `${leftW}px`;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  // Fit world into the canvas area above the phylogeny strip with a
  // uniform scale + center-letterbox. The world's logical dimensions
  // never change -- this only computes how to draw it on screen.
  // Lay out + measure the controls bar first so the world fit can
  // reserve its real height (it never overlaps the world).
  positionWorldButtons();
  const top = topReserveH();
  const availW = w;
  const availH = Math.max(1, h - top - bottomReserveH());
  const sx = availW / WORLD_SIZE.w;
  const sy = availH / WORLD_SIZE.h;
  viewScale = Math.min(sx, sy);
  viewOffsetX = (availW - WORLD_SIZE.w * viewScale) / 2;
  viewOffsetY = top + (availH - WORLD_SIZE.h * viewScale) / 2;
}
resize();
window.addEventListener("resize", resize);
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", resize);
  window.visualViewport.addEventListener("scroll", resize);
}

// Linear scan over creatures; bounded by MAX_CREATURES so cost is small.
// Returns the stable creature id (or -1 if no cell is within reach).
function findCellAt(x: number, y: number): number {
  let bestId = -1;
  let bestSq = Infinity;
  const cs = snapshot.creatures;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    const dx = c.x - x;
    const dy = c.y - y;
    const d = dx * dx + dy * dy;
    const reach = (c.r + 8) * (c.r + 8);
    if (d < bestSq && d < reach) { bestSq = d; bestId = c.id; }
  }
  return bestId;
}
// Canvas (CSS) pixel coords -> world coords, inverse of the view
// transform set in resize(). Used by click + hover so cells under
// the pointer match regardless of browser zoom / window size.
function canvasToWorld(cx: number, cy: number): { x: number; y: number } {
  // Invert both the world-fit and the user zoom/pan layers.
  const tScale = viewScale * viewZoom;
  return {
    x: (cx - viewOffsetX * viewZoom - viewPanX) / tScale,
    y: (cy - viewOffsetY * viewZoom - viewPanY) / tScale,
  };
}
canvas.addEventListener("click", (e) => {
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const w = canvasToWorld(cx, cy);
  const best = findCellAt(w.x, w.y);
  if (best >= 0) {
    selectedCellId = best;
    refreshActiveDisasm();
    // Tapping a cell also re-locks the follow-tooltip onto it; on
    // touch devices there's no mousemove to set the initial lock.
    lockedCellId = best;
  } else {
    // Click on empty water deselects: clear the selection (so the
    // inspector / "pin species" message clears) and drop the
    // tooltip lock.
    selectedCellId = null;
    refreshActiveDisasm();
    lockedCellId = null;
  }
});

// Hover tooltip: a small floating card with the cell's age, ATP, mass,
// biomass, species color, and genome length. Skim cells without losing
// the selected one in the inspector.
const tooltip = document.createElement("div");
tooltip.style.cssText =
  "position:fixed;pointer-events:none;display:none;z-index:9;" +
  "background:rgba(0,0,0,.75);color:#dfe;border:1px solid #1a3340;" +
  `padding:4px 6px;font:${UI_FONT_PX}px ${UI_FONT_FAMILY};` +
  "border-radius:3px;white-space:pre;";
document.body.appendChild(tooltip);
// Mousemove sets the lock; the per-frame flusher just re-renders.
let pendingMouseInside = false;
let tooltipScheduled = false;
// Sticky-follow: once the cursor lands on a cell we capture it here,
// and the tooltip tracks that cell's screen position every frame
// (whether the cursor stays put or wanders off) until the cell dies.
// Hovering a different cell replaces the lock; moving the cursor over
// empty water leaves the existing lock alone. Click an empty patch
// to clear it manually.
let lockedCellId: number | null = null;
function worldToClientX(wx: number): number {
  const rect = canvas.getBoundingClientRect();
  return wx * viewScale * viewZoom + viewOffsetX * viewZoom + viewPanX + rect.left;
}
function worldToClientY(wy: number): number {
  const rect = canvas.getBoundingClientRect();
  return wy * viewScale * viewZoom + viewOffsetY * viewZoom + viewPanY + rect.top;
}
function flushTooltip(): void {
  tooltipScheduled = false;
  // Drop the lock if the cell died or was eaten -- the snapshot is
  // rebuilt each tick from live creatures, so an absent id is the
  // liveness check. (We DON'T re-scan for a cell under the cursor
  // here -- that caused phantom switches when a different cell
  // drifted under the parked cursor.)
  if (lockedCellId != null && !snapshotCreatureById.has(lockedCellId)) lockedCellId = null;
  const c = lockedCellId != null ? snapshotCreatureById.get(lockedCellId) : null;
  if (!c) { tooltip.style.display = "none"; return; }
  let mass = c.energy;
  for (const mk of MOLECULE_IDS) mass += c.molecules[mk];
  const age = formatAge(Math.max(0, snapshot.t - c.bornAt));
  // Surface engulfed + bonded counts so the user can tell a fat
  // single cell from a host carrying endosymbionts from an adhered
  // pair drifting close. Only render rows when nonzero to keep
  // the box small for typical free-swimmers.
  const engulfed = c.contents.length;
  const bonded = c.bondsCount;
  const assocLine =
    (engulfed > 0 || bonded > 0)
      ? `\nengulfed=${engulfed}  bonded=${bonded}`
      : "";
  tooltip.innerHTML =
    `<span style="display:inline-block;width:8px;height:8px;background:${c.color};border:1px solid #fff;vertical-align:middle;margin-right:4px"></span>` +
    `<b>${genomeTag(c.genome)}</b> (${c.genome.length}b)\n` +
    `age=${age}\n` +
    `ATP=${c.energy.toFixed(0)}  memb=${c.molecules.membrane.toFixed(0)}  mass=${mass.toFixed(0)}` +
    assocLine;
  tooltip.style.display = "block";
  // Anchor at the cell's projected screen position with edge-flipping
  // so the box never spills off the visible viewport. visualViewport
  // tracks pinch-zoom on mobile; falls back to window.inner* otherwise.
  const OFFSET = 12;
  const MARGIN = 4;
  const vv = window.visualViewport;
  const vw = vv ? vv.width : window.innerWidth;
  const vh = vv ? vv.height : window.innerHeight;
  const w = tooltip.offsetWidth;
  const h = tooltip.offsetHeight;
  const rPix = c.r * viewScale * viewZoom;
  const cx = worldToClientX(c.x) + rPix;
  const cy = worldToClientY(c.y);
  let left = cx + OFFSET;
  let top = cy + OFFSET;
  if (left + w + MARGIN > vw) left = cx - OFFSET - w - rPix * 2;
  if (top + h + MARGIN > vh) top = cy - OFFSET - h;
  if (left < MARGIN) left = MARGIN;
  if (top < MARGIN) top = MARGIN;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}
canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  const wpt = canvasToWorld(e.clientX - rect.left, e.clientY - rect.top);
  pendingMouseInside = true;
  // The hover is the only place we *switch* the lock: pointing at a
  // cell captures it; pointing at empty water leaves the existing
  // lock alone (so a swimming cell can drift away and we still
  // follow it). The per-frame flusher never re-targets.
  const hovered = findCellAt(wpt.x, wpt.y);
  if (hovered >= 0) lockedCellId = hovered;
  if (!tooltipScheduled) {
    tooltipScheduled = true;
    requestAnimationFrame(flushTooltip);
  }
});
canvas.addEventListener("mouseleave", () => {
  // Don't drop pendingMouseInside's effect on the lock -- but the
  // tooltip should keep following the locked cell once the cursor
  // leaves the canvas. flushTooltip's render loop call still fires.
  pendingMouseInside = false;
});

// ---------------------------------------------------------------------
// In-app canvas zoom + pan. iOS Safari/Brave's page-level pinch zoom
// is disabled in index.html so the HUD stays put; this re-implements
// the gesture but applies it only to the world drawing area via the
// viewZoom / viewPan state.
//
// Pinch (2 touches): scale around the midpoint, like a normal pinch.
// Drag (1 touch when zoomed in): pan. We skip drag at zoom 1 so a
// regular tap-to-select still fires (preventDefault would swallow it).
// Wheel: desktop trackpad pinch (ctrl-wheel from Mac trackpad too) +
// scroll to zoom around the cursor.
// Double-tap / double-click: reset to fit.
// ---------------------------------------------------------------------
const clampZoom = (z: number): number => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
function zoomAround(screenX: number, screenY: number, factor: number): void {
  const oldZoom = viewZoom;
  const newZoom = clampZoom(oldZoom * factor);
  if (newZoom === oldZoom) return;
  // Keep the world point under (screenX, screenY) anchored as the
  // zoom changes. Pan adjusts by how much the post-zoom view of
  // that anchor has slid.
  const ratio = newZoom / oldZoom;
  viewPanX = screenX - (screenX - viewPanX) * ratio;
  viewPanY = screenY - (screenY - viewPanY) * ratio;
  viewZoom = newZoom;
}
function resetView(): void { viewZoom = 1; viewPanX = 0; viewPanY = 0; }
// Keep the world drawing inside the visible canvas. At zoom=1 (or any
// zoom where the world's drawn size is smaller than the available
// area) we snap to centered, so pinching back out always lands on
// the original auto-fit. When zoomed in, pan is clamped so an edge
// of the world can never leave the canvas edge -- no more "dark
// void" gutters when panning aggressively.
function clampPan(): void {
  const canvasW = canvas.clientWidth;
  const canvasH = canvas.clientHeight;
  const top = topReserveH();
  const availH = Math.max(1, canvasH - top - bottomReserveH());
  const drawW = WORLD_SIZE.w * viewScale * viewZoom;
  const drawH = WORLD_SIZE.h * viewScale * viewZoom;
  const originX = viewOffsetX * viewZoom;
  const originY = viewOffsetY * viewZoom;
  if (drawW >= canvasW) {
    const minPan = canvasW - originX - drawW;
    const maxPan = -originX;
    if (viewPanX < minPan) viewPanX = minPan;
    else if (viewPanX > maxPan) viewPanX = maxPan;
  } else {
    viewPanX = (canvasW - drawW) / 2 - originX;
  }
  if (drawH >= availH) {
    const minPan = top + availH - originY - drawH;
    const maxPan = top - originY;
    if (viewPanY < minPan) viewPanY = minPan;
    else if (viewPanY > maxPan) viewPanY = maxPan;
  } else {
    viewPanY = top + (availH - drawH) / 2 - originY;
  }
}

// --- Touch gestures ---
let pinchStartDistance = 0;
let pinchStartMidpoint = { x: 0, y: 0 };
let pinchStartZoom = 1;
let pinchStartPan = { x: 0, y: 0 };
let pinchActive = false;
let dragLastX = 0;
let dragLastY = 0;
let dragActive = false;
let dragMoved = false;
let lastTapAt = 0;
function touchMid(touches: TouchList, rect: DOMRect): { x: number; y: number } {
  return {
    x: (touches[0].clientX + touches[1].clientX) / 2 - rect.left,
    y: (touches[0].clientY + touches[1].clientY) / 2 - rect.top,
  };
}
function touchDist(touches: TouchList): number {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}
canvas.addEventListener("touchstart", (e) => {
  const rect = canvas.getBoundingClientRect();
  if (e.touches.length === 2) {
    pinchActive = true;
    dragActive = false;
    pinchStartDistance = touchDist(e.touches);
    pinchStartMidpoint = touchMid(e.touches, rect);
    pinchStartZoom = viewZoom;
    pinchStartPan = { x: viewPanX, y: viewPanY };
    e.preventDefault();
  } else if (e.touches.length === 1 && !pinchActive) {
    dragActive = true;
    dragMoved = false;
    dragLastX = e.touches[0].clientX;
    dragLastY = e.touches[0].clientY;
  }
}, { passive: false });
canvas.addEventListener("touchmove", (e) => {
  const rect = canvas.getBoundingClientRect();
  if (pinchActive && e.touches.length === 2) {
    const dist = touchDist(e.touches);
    const mid = touchMid(e.touches, rect);
    const zf = dist / Math.max(1, pinchStartDistance);
    const newZoom = clampZoom(pinchStartZoom * zf);
    const ratio = newZoom / pinchStartZoom;
    viewZoom = newZoom;
    // Anchor the original midpoint's world point at the live midpoint.
    viewPanX = mid.x - (pinchStartMidpoint.x - pinchStartPan.x) * ratio;
    viewPanY = mid.y - (pinchStartMidpoint.y - pinchStartPan.y) * ratio;
    e.preventDefault();
  } else if (dragActive && e.touches.length === 1 && viewZoom > 1) {
    const dx = e.touches[0].clientX - dragLastX;
    const dy = e.touches[0].clientY - dragLastY;
    if (Math.hypot(dx, dy) > 1) dragMoved = true;
    viewPanX += dx;
    viewPanY += dy;
    dragLastX = e.touches[0].clientX;
    dragLastY = e.touches[0].clientY;
    if (dragMoved) e.preventDefault();
  }
}, { passive: false });
canvas.addEventListener("touchend", (e) => {
  if (pinchActive && e.touches.length < 2) pinchActive = false;
  if (dragActive && e.touches.length === 0) {
    dragActive = false;
    // Double-tap (within 300ms, no drag) resets the zoom.
    if (!dragMoved) {
      const now = performance.now();
      if (now - lastTapAt < 300) { resetView(); lastTapAt = 0; }
      else lastTapAt = now;
    }
  }
});

// --- Wheel / trackpad pinch ---
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  // ctrlKey is what Mac trackpad pinches set on wheel events. Use a
  // gentler factor for plain scroll-wheel so a single notch doesn't
  // overshoot.
  const sensitivity = e.ctrlKey ? 0.01 : 0.0015;
  const factor = Math.exp(-e.deltaY * sensitivity);
  zoomAround(cx, cy, factor);
}, { passive: false });

// --- Desktop double-click resets ---
canvas.addEventListener("dblclick", () => { resetView(); });

// Dramatic depth: near particles are crisp and full-color, deep ones get
// heavy blur, low alpha, and shift toward the water-color background --
// classic atmospheric perspective. Eight buckets give a smooth gradient.
// All particles render at a fixed 2px radius regardless of their
// physical radius. Per design: render size is decoupled from
// physics -- buoyancy/drag/collision still use the particle's real
// `r` (which encodes mass via density*r^3); only the visual is
// unified. Cells are unaffected (drawn separately).
const PARTICLE_RENDER_R = 2;
const N_BUCKETS = 8;
// Render only the front N_RENDER_BUCKETS depth layers. The deepest
// bucket gets the heaviest canvas blur (3.2px) and lowest alpha
// (0.64), so dropping it from the render loop skips one full
// filter+composite pass per frame for minimal visual cost.
const N_RENDER_BUCKETS = 7;
const BLURS = [0, 0.3, 0.7, 1.2, 1.7, 2.2, 2.7, 3.2];
const ALPHAS = [1.0, 0.96, 0.91, 0.85, 0.79, 0.73, 0.68, 0.64];
// One sub-bucket per (depth bucket, chem id) so the renderer can issue
// a single beginPath + many arcs + single fill per group. With 12k+
// particles, dropping from one canvas op per particle to one per group
// is a big speedup -- arc/fill/beginPath are expensive when called in
// the millions per second. Phase D widens the chem axis from 6
// materials to N_RENDER_CHEMS (sized to the chemical table) so
// procedural chems also render distinctly.
const N_RENDER_CHEMS = CHEM_COLORS.length;
const SUB_BUCKETS: ParticleSnapshot[][] = Array.from({ length: N_BUCKETS * N_RENDER_CHEMS }, () => []);
// How much each bucket is tinted toward the deep-water color. 0 = no tint
// (use chem color as-is); 1 = fully replaced by background.
const DEPTH_TINTS = [0, 0.025, 0.06, 0.11, 0.17, 0.23, 0.29, 0.35];
const DEEP_TINT_R = 6;
const DEEP_TINT_G = 21;
const DEEP_TINT_B = 32; // matches the bottom of the water gradient (#061520)

function blendToward(color: string, frac: number): string {
  // Accept either "#rrggbb" or "hsl(...)"; for HSL we don't tint
  // (the renderer already gets darker chems at depth via the canvas
  // composite). For hex parse rgb and blend toward the deep tint.
  if (color.startsWith("hsl")) return color;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  const br = Math.round(r + (DEEP_TINT_R - r) * frac);
  const bg = Math.round(g + (DEEP_TINT_G - g) * frac);
  const bb = Math.round(b + (DEEP_TINT_B - b) * frac);
  return `rgb(${br},${bg},${bb})`;
}
// Pre-compute tinted chem colors per bucket so the render loop just
// looks them up instead of parsing strings every frame. Indexed by
// chemId, then by depth tier.
const TINTED_COLORS: string[][] = CHEM_COLORS.map((base) => DEPTH_TINTS.map((t) => blendToward(base, t)));
// Toxic-waste-tagged particles get rendered in a sickly rust color
// rather than their underlying material color, so the player can see
// where pollution accumulates. Routed by waste molecule fraction.
const TOXIC_BUCKETS: ParticleSnapshot[][] = Array.from({ length: N_BUCKETS }, () => []);
// Particles mid-fade (reserve <-> visible). Pulled out of the batched
// path so each can carry its own alpha; expected to be a small set.
const FADING_PARTICLES: ParticleSnapshot[] = [];
const TOXIC_BASE = "#a04a2a";
const TOXIC_TINTED = DEPTH_TINTS.map((t) => blendToward(TOXIC_BASE, t));
const TOXIC_WASTE_FRAC = 0.5;

// Map water temperature (°C) to a tint. Warm = lighter cyan, cool = deep
// dark blue. Chosen so 20°C lands near the original water palette.
// (hexLerp removed -- the procedural rock texture in buildTerrainBitmap
// no longer composes colors from per-obstacle gradient stops; it
// computes per-pixel RGB from base tone + noise + lighting directly.)

// Scale an "rgb(r,g,b)" string toward black by `mult` in [0..1].
// Used to apply the day/night dimming to the water gradient.
function darkenColor(rgb: string, mult: number): string {
  const m = rgb.match(/rgb\((\d+),(\d+),(\d+)\)/);
  if (!m) return rgb;
  const r = Math.round(parseInt(m[1]) * mult);
  const g = Math.round(parseInt(m[2]) * mult);
  const b = Math.round(parseInt(m[3]) * mult);
  return `rgb(${r},${g},${b})`;
}

function tempToColor(T: number): string {
  // 12°C -> "#041420", 20°C -> "#0e2a3a", 28°C -> "#3a6e8c". Linear lerp
  // in RGB between three anchor colors.
  const cold = [4, 20, 32];
  const mid  = [14, 42, 58];
  const warm = [58, 110, 140];
  let a, b, t;
  if (T <= 20) { a = cold; b = mid;  t = Math.max(0, (T - 12) / 8); }
  else         { a = mid;  b = warm; t = Math.min(1, (T - 20) / 8); }
  const lerp = (x: number, y: number) => Math.round(x + (y - x) * t);
  const r = lerp(a[0], b[0]);
  const g = lerp(a[1], b[1]);
  const b2 = lerp(a[2], b[2]);
  return `rgb(${r},${g},${b2})`;
}

// Splash droplets removed -- previous implementation sprinkled them
// across the above-mean half of every wave regardless of whether the
// crest was steep enough to actually break. Result: random pops over
// otherwise calm water. See PERF_NEXT_STEPS / chat thread for the
// design of the replacement (event-driven, gated on local steepness
// and minimum activity, burst-spawned per breaking crest).

// Sample the wavy surface at intervals; sim.surfaceYAt is the shared
// source of truth so the rendered line matches the physical wall.
const SURFACE_VIS_STEP = 3;

function render(): void {
  // Re-clamp pan every frame so any path that mutates viewPan / viewZoom
  // (touch gestures, wheel, future hooks) gets the correction without
  // having to remember to call clampPan itself.
  clampPan();
  const { width, height, depth, surfaceY } = snapshot;
  // Day/night tint applied to both surface and depth water colors so
  // the whole scene gets dimmer at night. 1 = full day, ~0.4 = deep
  // night (we don't go fully black so creatures stay visible).
  const dayMult = 0.4 + 0.6 * solarLight(snapshot);
  const tWarm = darkenColor(tempToColor(snapshot.tempSurface), dayMult);
  const tCool = darkenColor(tempToColor(snapshot.tempBottom), dayMult);

  // Clear the full canvas (letterbox color), then apply the view
  // transform so subsequent draws use world coords. DPR is folded into
  // the same matrix so a single setTransform suffices.
  const dpr = getDpr();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  // Compose world-fit transform with user pinch/scroll zoom + pan.
  // After zoom: x' = canvasX * viewZoom + viewPanX where canvasX is
  // the world-fit value. So the combined scale is viewScale*viewZoom
  // and the translation is viewOffset*viewZoom + viewPan.
  const tScale = viewScale * viewZoom;
  ctx.setTransform(
    dpr * tScale, 0, 0, dpr * tScale,
    dpr * (viewOffsetX * viewZoom + viewPanX),
    dpr * (viewOffsetY * viewZoom + viewPanY),
  );

  // Atmosphere band -- fill above the wavy surface line. Darkened with
  // the same day/night multiplier as the water so the whole scene dims.
  ctx.fillStyle = darkenColor("rgb(10,22,32)", dayMult);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(width, 0);
  ctx.lineTo(width, surfaceYAt(snapshot, width));
  for (let x = width; x >= 0; x -= SURFACE_VIS_STEP) ctx.lineTo(x, surfaceYAt(snapshot, x));
  ctx.closePath();
  ctx.fill();

  // Water column -- fill below the wavy surface line.
  const grad = ctx.createLinearGradient(0, surfaceY, 0, height);
  grad.addColorStop(0, tWarm);
  grad.addColorStop(1, tCool);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(0, surfaceYAt(snapshot, 0));
  for (let x = SURFACE_VIS_STEP; x <= width; x += SURFACE_VIS_STEP) ctx.lineTo(x, surfaceYAt(snapshot, x));
  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.closePath();
  ctx.fill();

  // Static terrain. Pre-baked once into terrainBitmap (an offscreen
  // canvas sized to the world); we just blit it per frame.
  if (!terrainBitmap) buildTerrainBitmap();
  if (terrainBitmap) ctx.drawImage(terrainBitmap, 0, 0);

  // Region grid overlay (toggled by the lower-left button). Matches
  // REGION_PX so the dissolved/reserve region boundaries are visible.
  if (gridLinesOn) {
    ctx.strokeStyle = "rgba(150, 200, 220, 0.14)";
    ctx.lineWidth = 1 / tScale; // crisp ~1 device-px regardless of zoom
    ctx.beginPath();
    for (let gx = 0; gx <= width; gx += REGION_PX) { ctx.moveTo(gx, 0); ctx.lineTo(gx, height); }
    for (let gy = 0; gy <= height; gy += REGION_PX) { ctx.moveTo(0, gy); ctx.lineTo(width, gy); }
    ctx.stroke();
  }

  // Highlight along the surface line.
  ctx.strokeStyle = "rgba(170, 220, 240, 0.45)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, surfaceYAt(snapshot, 0));
  for (let x = SURFACE_VIS_STEP; x <= width; x += SURFACE_VIS_STEP) ctx.lineTo(x, surfaceYAt(snapshot, x));
  ctx.stroke();

  for (const b of SUB_BUCKETS) b.length = 0;
  for (const b of TOXIC_BUCKETS) b.length = 0;
  FADING_PARTICLES.length = 0;
  for (const p of snapshot.particles) {
    const t = Math.min(0.999, Math.max(0, p.z / depth));
    const bucket = Math.floor(t * N_BUCKETS);
    // Fading particles take a per-particle alpha pass so the rest can
    // stay on the fast batched path.
    if (p.fade !== undefined && p.fade < 1) {
      if (bucket < N_RENDER_BUCKETS) FADING_PARTICLES.push(p);
      continue;
    }
    // Tag-toxic check: a molecule-tagged particle whose waste fraction
    // is high enough renders in the toxic palette, regardless of its
    // underlying chem id.
    if (p.molecules && p.molecules.waste > 0) {
      let total = 0;
      const m = p.molecules;
      total += m.glucose + m.fattyAcid + m.aminoAcid + m.minerals
        + m.o2 + m.co2 + m.waste + m.adp + m.chlorophyll + m.enzyme + m.membrane;
      if (total > 0 && m.waste / total >= TOXIC_WASTE_FRAC) {
        TOXIC_BUCKETS[bucket].push(p);
        continue;
      }
    }
    const ci = p.chemId;
    if (ci < 0 || ci >= N_RENDER_CHEMS) continue;
    SUB_BUCKETS[bucket * N_RENDER_CHEMS + ci].push(p);
  }
  const tinted = TINTED_COLORS;
  for (let i = N_RENDER_BUCKETS - 1; i >= 0; i--) {
    ctx.filter = BLURS[i] === 0 ? "none" : `blur(${BLURS[i]}px)`;
    ctx.globalAlpha = ALPHAS[i];
    for (let m = 0; m < N_RENDER_CHEMS; m++) {
      const group = SUB_BUCKETS[i * N_RENDER_CHEMS + m];
      if (group.length === 0) continue;
      ctx.fillStyle = tinted[m][i];
      ctx.beginPath();
      // moveTo before each arc prevents canvas from auto-connecting the
      // previous endpoint -- without it we'd draw spurious lines through
      // every particle.
      for (let k = 0; k < group.length; k++) {
        const p = group[k];
        ctx.moveTo(p.x + PARTICLE_RENDER_R, p.y);
        ctx.arc(p.x, p.y, PARTICLE_RENDER_R, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    // Toxic-waste pass for this depth bucket, in the rust palette.
    const toxic = TOXIC_BUCKETS[i];
    if (toxic.length > 0) {
      ctx.fillStyle = TOXIC_TINTED[i];
      ctx.beginPath();
      for (let k = 0; k < toxic.length; k++) {
        const p = toxic[k];
        ctx.moveTo(p.x + PARTICLE_RENDER_R, p.y);
        ctx.arc(p.x, p.y, PARTICLE_RENDER_R, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  }
  // Per-particle fade pass (reserve <-> visible transitions). Small
  // set; each gets its own alpha so it eases in/out smoothly.
  for (let k = 0; k < FADING_PARTICLES.length; k++) {
    const p = FADING_PARTICLES[k];
    const t = Math.min(0.999, Math.max(0, p.z / depth));
    const bucket = Math.floor(t * N_BUCKETS);
    let isToxic = false;
    if (p.molecules && p.molecules.waste > 0) {
      const m = p.molecules;
      const total = m.glucose + m.fattyAcid + m.aminoAcid + m.minerals
        + m.o2 + m.co2 + m.waste + m.adp + m.chlorophyll + m.enzyme + m.membrane;
      isToxic = total > 0 && m.waste / total >= TOXIC_WASTE_FRAC;
    }
    const ci = p.chemId;
    if (!isToxic && (ci < 0 || ci >= N_RENDER_CHEMS)) continue;
    ctx.filter = BLURS[bucket] === 0 ? "none" : `blur(${BLURS[bucket]}px)`;
    ctx.globalAlpha = ALPHAS[bucket] * (p.fade ?? 1);
    ctx.fillStyle = isToxic ? TOXIC_TINTED[bucket] : TINTED_COLORS[ci][bucket];
    ctx.beginPath();
    ctx.moveTo(p.x + PARTICLE_RENDER_R, p.y);
    ctx.arc(p.x, p.y, PARTICLE_RENDER_R, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.filter = "none";
  ctx.globalAlpha = 1;

  const selId = selectedCellId;
  // When a cell is selected (its follow-tooltip is up), ring every
  // other cell in the same species OR the same founding lineage
  // (covers mutated descendants that speciated away) with a 1px
  // selection border so the family is visible at a glance.
  const sel = selectedCell();
  const kinSpecies = sel ? sel.speciesKey : null;
  const kinLineage = sel ? sel.lineageRoot : -1;
  for (let i = 0; i < snapshot.creatures.length; i++) {
    const c = snapshot.creatures[i];
    const isSel = c.id === selId;
    const isKin = !isSel && sel != null
      && (c.speciesKey === kinSpecies || c.lineageRoot === kinLineage);
    drawCreature(c, isSel, isKin);
  }

  drawHeatmap();
  // Phylogeny strip lives in canvas (screen) coords below the world.
  // Reset to DPR-only transform before drawing.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawPhylogeny();
  if (!analysisMinimized && analysisTab === "genome") drawGenomeStats();
}

// The overlay is driven solely by the controls-bar <select> via
// setOverlay; the heatmap state lives in the controls block above.
// Drawn on top of particles/cells but below the phylogeny strip.
window.addEventListener("keydown", (e) => {
  if (e.key === "p" || e.key === "P") {
    if (snapshot.profile) dumpProfile();
    simWorker.postMessage({ type: "toggleProfile" });
  } else if (e.key === "f" || e.key === "F") {
    // Toggle the phylogeny "top 5 alive" filter.
    phyloFilterTop5 = !phyloFilterTop5;
  }
});

function dumpProfile(): void {
  const p = snapshot.profile;
  if (!p || p.ticks === 0) return;
  const n = p.ticks;
  const rows: { phase: string; ms: number }[] = [
    { phase: "bonds", ms: p.bonds / n },
    { phase: "forces", ms: p.forces / n },
    { phase: "creatures (VM+chem)", ms: p.creatures / n },
    { phase: "particle coll", ms: p.particleColl / n },
    { phase: "creature coll", ms: p.creatureColl / n },
    { phase: "sediment coll", ms: p.sedimentColl / n },
    { phase: "obstacle coll", ms: p.obstacleColl / n },
    { phase: "walls", ms: p.walls / n },
    { phase: "aerate", ms: p.aerate / n },
    { phase: "replenish", ms: p.replenish / n },
    { phase: "prune", ms: p.prune / n },
  ];
  rows.sort((a, b) => b.ms - a.ms);
  const total = rows.reduce((s, r) => s + r.ms, 0);
  // eslint-disable-next-line no-console
  console.log(`[profile] over ${n} ticks  total=${total.toFixed(3)}ms/tick  pop=${snapshot.creatures.length}  particles=${snapshot.particles.length}`);
  for (const r of rows) {
    const pct = total > 0 ? (100 * r.ms / total).toFixed(1) : "0.0";
    // eslint-disable-next-line no-console
    console.log(`  ${r.phase.padEnd(22)} ${r.ms.toFixed(3)}ms  ${pct}%`);
  }
}
function drawHeatmap(): void {
  if (heatmapMode === "off") return;
  const { width, height, surfaceY } = snapshot;
  const cell = HEATMAP_CELL;
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil((height - surfaceY) / cell);
  ctx.globalAlpha = HEATMAP_ALPHA;
  if (heatmapMode === "temp") {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * cell;
        const y = surfaceY + r * cell;
        const t = temperatureAt(snapshot, x + cell / 2, y + cell / 2);
        ctx.fillStyle = heatColorTemp(t);
        ctx.fillRect(x, y, cell, cell);
      }
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.font = UI_CANVAS_FONT;
    ctx.fillText("heatmap: temperature (cold blue → warm red)", 8, surfaceY + 14);
    return;
  }
  if (heatmapMode === "density") {
  // Combined density in 2px-particle-equivalents: rendered particles
  // (count) + dissolved + reserve fields (per-region PE spread over
  // the heatmap cells covering that region), each gated by its
  // checkbox. All on => total stuff per cell.
  // Material filter: -1 = all chems. When a chem is focused, rendered
  // is filtered client-side; dissolved/reserve use the worker's
  // per-chem per-region field (present once the worker has applied
  // the same focus chem -- snapshot.densityChem echoes it).
  const matSel = densityChemSel;
  const matName = matSel < 0 ? "all" : chemName(matSel);
  const dens = new Float32Array(cols * rows);
  if (densRend) {
    for (const p of snapshot.particles) {
      if (matSel >= 0 && p.chemId !== matSel) continue;
      const cx = Math.floor(p.x / cell);
      const cy = Math.floor((p.y - surfaceY) / cell);
      if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue;
      dens[cy * cols + cx] += 1;
    }
  }
  if (densDiss || densResv) {
    const rCols = Math.max(1, Math.ceil(width / REGION_PX));
    const rRows = Math.max(1, Math.ceil(height / REGION_PX));
    // a heatmap cell is smaller than a region; give it the region's
    // PE prorated by area so values stay per-cell comparable.
    const areaFrac = (cell * cell) / (REGION_PX * REGION_PX);
    // All chems -> aggregate PE; specific chem -> worker per-chem PE,
    // but only once the worker echoes the matching focus chem.
    const perChemReady = matSel >= 0 && snapshot.densityChem === matSel;
    const aPE = matSel < 0 ? snapshot.ambientPE : (perChemReady ? snapshot.densityChemAmbPE : undefined);
    const vPE = matSel < 0 ? snapshot.reservePE : (perChemReady ? snapshot.densityChemResPE : undefined);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const wx = c * cell + cell / 2;
        const wy = surfaceY + r * cell + cell / 2;
        let rx = Math.floor(wx / REGION_PX); if (rx < 0) rx = 0; else if (rx >= rCols) rx = rCols - 1;
        let ry = Math.floor(wy / REGION_PX); if (ry < 0) ry = 0; else if (ry >= rRows) ry = rRows - 1;
        const ri = ry * rCols + rx;
        let add = 0;
        if (densDiss && aPE && ri < aPE.length) add += aPE[ri] * areaFrac;
        if (densResv && vPE && ri < vPE.length) add += vPE[ri] * areaFrac;
        dens[r * cols + c] += add;
      }
    }
  }
  if (densVivo) {
    // Mass held inside living cells, converted to the same 2px-
    // particle-equivalent scale as the dissolved/reserve fields.
    // Covers both the named molecule pools and the sparse generic
    // internal pool the snapshot ships.
    for (const c of snapshot.creatures) {
      let pe = 0;
      if (matSel < 0) {
        for (let k = 0; k < NAMED_CHEMICAL_COUNT; k++) {
          pe += chemAmountToParticles(k, c.molecules[NAMED_CHEMICALS[k]]);
        }
        for (const [chemId, amt] of c.genericInternal) {
          pe += chemAmountToParticles(chemId, amt);
        }
      } else if (matSel < NAMED_CHEMICAL_COUNT) {
        pe = chemAmountToParticles(matSel, c.molecules[NAMED_CHEMICALS[matSel]]);
      } else {
        for (const [chemId, amt] of c.genericInternal) {
          if (chemId === matSel) { pe = chemAmountToParticles(matSel, amt); break; }
        }
      }
      if (pe <= 0) continue;
      const cx = Math.floor(c.x / cell);
      const cy = Math.floor((c.y - surfaceY) / cell);
      if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue;
      dens[cy * cols + cx] += pe;
    }
  }
  let maxC = 1e-6;
  for (let i = 0; i < dens.length; i++) if (dens[i] > maxC) maxC = dens[i];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const n = dens[r * cols + c];
      if (n <= 0) continue;
      ctx.fillStyle = heatColorDensity(n / maxC);
      ctx.fillRect(c * cell, surfaceY + r * cell, cell, cell);
    }
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.font = UI_CANVAS_FONT;
  const srcs = [densRend && "visible", densDiss && "dissolved", densResv && "simulated", densVivo && "in vivo"].filter(Boolean).join("+") || "none";
  ctx.fillText(`heatmap: density [${srcs}] · mat:${matName} (max ${maxC.toFixed(0)}/cell)`, 8, surfaceY + 14);
    return;
  }
}

function heatColorTemp(t: number): string {
  // 12 °C → deep blue, 20 °C → green-ish, 28 °C → warm red.
  const x = Math.max(0, Math.min(1, (t - 10) / 20));
  if (x < 0.5) {
    const k = x / 0.5;
    const r = Math.round(20 + 60 * k);
    const g = Math.round(60 + 140 * k);
    const b = Math.round(200 - 80 * k);
    return `rgb(${r},${g},${b})`;
  }
  const k = (x - 0.5) / 0.5;
  const r = Math.round(80 + 175 * k);
  const g = Math.round(200 - 120 * k);
  const b = Math.round(120 - 100 * k);
  return `rgb(${r},${g},${b})`;
}
function heatColorDensity(x: number): string {
  // Gradient from cool dark to bright yellow as density rises.
  const r = Math.round(40 + 215 * x);
  const g = Math.round(40 + 180 * x);
  const b = Math.round(80 - 60 * x);
  return `rgb(${r},${g},${b})`;
}

// Population genome-size histogram, drawn into the Genome tab's own
// canvas. Bars are counts of cells per length bucket; vertical lines
// mark mean and mean ± stddev so you can see at a glance whether
// genomes are bloating, collapsing, or settled.
const GS_BUCKET_BYTES = 4;      // 4 bytes per bucket
const GS_N_BUCKETS = 25;        // covers 0..100 bytes
const GS_BUCKETS = new Int32Array(GS_N_BUCKETS);
const GS_TICK_BYTES = [0, 25, 50, 75, 100]; // x-axis labels

function drawGenomeStats(): void {
  const gctx = gsCanvas.getContext("2d");
  if (!gctx) return;
  const dpr = getDpr();
  const cssW = gsCanvas.clientWidth || (analysisPanelW() - 20);
  const cssH = 160;
  const needW = Math.max(1, Math.round(cssW * dpr));
  const needH = Math.max(1, Math.round(cssH * dpr));
  if (gsCanvas.width !== needW || gsCanvas.height !== needH) {
    gsCanvas.width = needW;
    gsCanvas.height = needH;
  }
  gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  gctx.clearRect(0, 0, cssW, cssH);

  const cs = snapshot.creatures;
  const n = cs.length;

  // Bucket fill + mean/stddev. Both passes only N adds; no allocation.
  GS_BUCKETS.fill(0);
  let sum = 0, sumSq = 0;
  let maxLen = 0;
  for (let i = 0; i < n; i++) {
    const L = cs[i].genome.length;
    sum += L;
    sumSq += L * L;
    if (L > maxLen) maxLen = L;
    const b = Math.min(GS_N_BUCKETS - 1, Math.max(0, Math.floor(L / GS_BUCKET_BYTES)));
    GS_BUCKETS[b]++;
  }
  const mean = n > 0 ? sum / n : 0;
  const variance = n > 0 ? Math.max(0, sumSq / n - mean * mean) : 0;
  const stddev = Math.sqrt(variance);
  let maxCount = 1;
  for (let i = 0; i < GS_N_BUCKETS; i++) if (GS_BUCKETS[i] > maxCount) maxCount = GS_BUCKETS[i];

  gctx.fillStyle = "#9ee";
  gctx.font = UI_CANVAS_FONT;
  gctx.textBaseline = "top";
  gctx.textAlign = "left";
  gctx.fillText(
    `n=${n}  µ=${mean.toFixed(1)}  σ=${stddev.toFixed(1)}  max=${maxLen}`,
    4, 4,
  );

  const plotX = 6;
  const plotY = 26;
  const plotW = cssW - 12;
  const plotH = cssH - plotY - 20;
  const bucketW = plotW / GS_N_BUCKETS;
  const maxBytes = GS_N_BUCKETS * GS_BUCKET_BYTES;
  const xForByteLen = (L: number) =>
    plotX + Math.min(plotW, Math.max(0, (L / maxBytes) * plotW));

  // Bars.
  gctx.fillStyle = "#5fa9c4";
  for (let i = 0; i < GS_N_BUCKETS; i++) {
    const c = GS_BUCKETS[i];
    if (c === 0) continue;
    const h = (c / maxCount) * plotH;
    gctx.fillRect(plotX + i * bucketW, plotY + (plotH - h), Math.max(1, bucketW - 1), h);
  }

  // Baseline + tick marks with byte-count labels.
  gctx.strokeStyle = "#456773";
  gctx.lineWidth = 1;
  gctx.beginPath();
  gctx.moveTo(plotX, plotY + plotH + 0.5);
  gctx.lineTo(plotX + plotW, plotY + plotH + 0.5);
  gctx.stroke();
  gctx.fillStyle = "#7ab";
  gctx.textAlign = "center";
  for (const b of GS_TICK_BYTES) {
    const x = xForByteLen(b);
    gctx.beginPath();
    gctx.moveTo(x, plotY + plotH);
    gctx.lineTo(x, plotY + plotH + 3);
    gctx.stroke();
    gctx.fillText(String(b), x, plotY + plotH + 5);
  }
  gctx.textAlign = "left";

  // Mean + ±stddev lines.
  if (n > 0) {
    const xMean = xForByteLen(mean);
    gctx.strokeStyle = "#f0c050";
    gctx.lineWidth = 1.5;
    gctx.beginPath();
    gctx.moveTo(xMean, plotY);
    gctx.lineTo(xMean, plotY + plotH);
    gctx.stroke();
    gctx.strokeStyle = "rgba(240,192,80,0.55)";
    gctx.lineWidth = 1;
    for (const off of [-stddev, stddev]) {
      const x = xForByteLen(mean + off);
      gctx.beginPath();
      gctx.moveTo(x, plotY);
      gctx.lineTo(x, plotY + plotH);
      gctx.stroke();
    }
  }
}

function drawPhylogeny(): void {
  const stripH = PHYLO_STRIP_H;
  // Strip sits at the bottom of the CANVAS (in CSS pixels). The render
  // path resets the transform to DPR-only before calling us so screen
  // coords work directly here.
  const dpr = getDpr();
  const canvasCssH = canvas.height / dpr;
  const canvasCssW = canvas.width / dpr;
  // Phylogeny sits directly above the bottom controls bar.
  const stripY = canvasCssH - stripH - controlsBarH;
  const w = canvasCssW;

  // Semi-opaque panel so the strip is legible over particles drawn underneath.
  ctx.fillStyle = "rgba(4,16,24,0.78)";
  ctx.fillRect(0, stripY, w, stripH);
  ctx.strokeStyle = "#1a3340";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, stripY + 0.5);
  ctx.lineTo(w, stripY + 0.5);
  ctx.stroke();

  // Rolling window: only the last PHYLO_WINDOW_SEC of history is shown
  // so recent events stay legible. Species whose lifespan starts before
  // the window clip at the left edge (handled naturally by tx()).
  const tNow = snapshot.t;
  const tMin = Math.max(0, tNow - PHYLO_WINDOW_SEC);
  const span = Math.max(0.001, tNow - tMin);
  // Reserve enough top padding that the thickest possible lane (live
  // species at max biomass -> lineWidth ~6px) clears the legend text
  // baseline at stripY + 11. Was 14, which left ~1.5px and visibly
  // collided with descenders at high DPR.
  const padTop = 22;
  const padBot = 6;
  const innerY = stripY + padTop;
  const innerH = stripH - padTop - padBot;

  // Only consider species whose lifespan overlaps the visible window.
  // Keeps the per-frame work proportional to recent activity instead of
  // every species ever seen.
  visibleSpecies.length = 0;
  for (const sp of snapshot.species) {
    if (sp.lastSeen >= tMin) visibleSpecies.push(sp);
  }
  visibleSpecies.sort((a, b) => a.lane - b.lane);
  const visible = visibleSpecies;

  // Per-species live biomass. Use c.speciesKey (frozen at birth) instead
  // of recomputing genomeKey each frame -- somatic drift doesn't move a
  // cell to a different species, so the birth key is the right bucket.
  bioByKey.clear();
  // Per-species live total cell mass (energy + all molecular contents),
  // used to scale the slot heights below.
  const massByKey = new Map<string, number>();
  for (const c of snapshot.creatures) {
    // Membrane is the structural reserve in the chemistry-overhaul
    // model (replaces the retired biomass chemical).
    bioByKey.set(c.speciesKey, (bioByKey.get(c.speciesKey) ?? 0) + c.molecules.membrane);
    let tm = c.energy;
    for (const k of MOLECULE_IDS) tm += c.molecules[k];
    massByKey.set(c.speciesKey, (massByKey.get(c.speciesKey) ?? 0) + tm);
  }
  // Update the main-side peak map from this sample. The phylogeny
  // render runs every frame, so the peak tracks tightly without
  // needing per-tick work in the sim worker.
  for (const [key, b] of bioByKey) {
    const prev = peakBiomassByKey.get(key) ?? 0;
    if (b > prev) peakBiomassByKey.set(key, b);
  }
  // Prune entries for species the sim no longer tracks. Without this,
  // peakBiomassByKey grows monotonically (one float per ever-seen
  // species) over a long session. The sim already drops a species
  // from snapshot.species after SPECIES_GRACE_SEC of zero population.
  if (peakBiomassByKey.size > snapshotSpeciesByKey.size * 2) {
    for (const key of peakBiomassByKey.keys()) {
      if (!snapshotSpeciesByKey.has(key)) peakBiomassByKey.delete(key);
    }
  }
  // Top-5 filter: prune visibleSpecies down to the five currently-alive
  // species with the highest live biomass. Applied after bioByKey is
  // built so the ranking uses fresh per-frame numbers. visible is a
  // const alias for visibleSpecies, so the in-place mutation here
  // flows through.
  if (phyloFilterTop5) {
    visibleSpecies.sort((a, b) => {
      if (a.alive > 0 && b.alive <= 0) return -1;
      if (b.alive > 0 && a.alive <= 0) return 1;
      return (bioByKey.get(b.key) ?? 0) - (bioByKey.get(a.key) ?? 0);
    });
    let aliveN = 0;
    for (const sp of visibleSpecies) if (sp.alive > 0) aliveN++;
    visibleSpecies.length = Math.min(5, aliveN);
    visibleSpecies.sort((a, b) => a.lane - b.lane);
  }

  let maxMass = 0;
  for (const sp of visible) {
    const m = massByKey.get(sp.key) ?? 0;
    if (m > maxMass) maxMass = m;
  }

  // Slot heights: living species scale up to LIVE_H_MAX by total cell
  // mass relative to the largest extant species; extinct species occupy
  // a thin baseline slot so their lifespan segment stays visible. If the
  // total exceeds the available innerH, scale everything down to fit.
  const LIVE_H_MAX = 7;
  const LIVE_H_MIN = 1.2;
  const EXTINCT_H = 0.6;
  const heights = visible.map((sp) => {
    if (sp.alive <= 0) return EXTINCT_H;
    const frac = maxMass > 0 ? (massByKey.get(sp.key) ?? 0) / maxMass : 0;
    return Math.max(LIVE_H_MIN, frac * LIVE_H_MAX);
  });
  const totalH = heights.reduce((a, b) => a + b, 0);
  const scale = totalH > innerH ? innerH / totalH : 1;
  for (let i = 0; i < heights.length; i++) heights[i] *= scale;

  // Y center of each species' slot. Lane lookup map mirrors the sim's
  // stable lane index so convergence/divergence connectors stay attached
  // to the same vertical position frame to frame.
  const yOfLane = new Map<number, number>();
  let acc = innerY;
  for (let i = 0; i < visible.length; i++) {
    yOfLane.set(visible[i].lane, acc + heights[i] / 2);
    acc += heights[i];
  }

  const tx = (t: number): number => ((t - tMin) / span) * w;

  // Lifespan segments. Living species extend to tNow; extinct species end
  // at lastSeen and stay put as a static segment.
  for (let i = 0; i < visible.length; i++) {
    const sp = visible[i];
    const tEnd = sp.alive > 0 ? tNow : sp.lastSeen;
    const x1 = tx(sp.firstSeen);
    const x2 = tx(tEnd);
    const ly = yOfLane.get(sp.lane)!;
    ctx.strokeStyle = sp.color;
    ctx.globalAlpha = sp.alive > 0 ? 1 : 0.5;
    ctx.lineWidth = Math.max(0.5, heights[i] * 0.85);
    ctx.beginPath();
    ctx.moveTo(x1, ly);
    ctx.lineTo(x2, ly);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Divergence / convergence connectors on top so they're visible.
  for (const ev of snapshot.phylogenyEvents) {
    const from = snapshotSpeciesByKey.get(ev.from);
    const to = snapshotSpeciesByKey.get(ev.to);
    if (!from || !to) continue;
    const y1 = yOfLane.get(from.lane);
    const y2 = yOfLane.get(to.lane);
    if (y1 === undefined || y2 === undefined) continue;
    const ex = tx(ev.t);
    ctx.strokeStyle = ev.convergence ? "#f0c050" : "#9fc3d4";
    ctx.globalAlpha = ev.convergence ? 0.9 : 0.55;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ex, y1);
    ctx.lineTo(ex, y2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  ctx.fillStyle = "#7fb8c8";
  ctx.font = UI_CANVAS_FONT;
  const filterTag = phyloFilterTop5 ? "  [TOP 5 alive, F toggles]" : "  (F: top 5 filter)";
  ctx.fillText(
    `phylogeny  t=${tMin.toFixed(0)}..${tNow.toFixed(0)}s  ${visible.length} species  (height ~ total mass, yellow = convergence)${filterTag}`,
    8,
    stripY + 11,
  );
}

// Selection highlight color: a hue that sweeps the full wheel on a
// fixed wall-clock period, so the selected cell + its kin pulse through
// a smooth rainbow regardless of sim speed.
const SELECTION_CYCLE_MS = 3000;
function selectionCycleColor(): string {
  const h = ((performance.now() % SELECTION_CYCLE_MS) / SELECTION_CYCLE_MS) * 360;
  return `hsl(${h.toFixed(1)},100%,65%)`;
}

// Every cell wears a thin black outline on its wobbly body. The
// selected cell + its species/lineage kin get a color-cycling outline
// instead so the family stands out; the selected cell's is thicker.
function strokeCellOutline(
  cx: number, cy: number, r: number, selected: boolean, t: number, phase: number,
  kin = false,
): void {
  ctx.strokeStyle = selected || kin ? selectionCycleColor() : "#000000";
  ctx.lineWidth = selected ? 3 : 1;
  tracedWobblyBody(cx, cy, r, t, phase);
  ctx.stroke();
}

// Shift an "hsl(h, s%, l%)" string's lightness by lDelta percentage
// points (clamped 0..100). Used to build the highlight + rim-shadow
// gradient stops for the 3D cell render.
function hslAdjustL(hsl: string, lDelta: number): string {
  const m = hsl.match(/hsl\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)%,\s*(-?\d+(?:\.\d+)?)%\)/);
  if (!m) return hsl;
  const h = m[1];
  const s = m[2];
  const l = Math.max(0, Math.min(100, parseFloat(m[3]) + lDelta));
  return `hsl(${h}, ${s}%, ${l}%)`;
}

// Radial gradient centered on a light source offset to the upper-left,
// so each cell renders like a lit sphere. Used as the fill style for
// the wobbly body path.
// Static-terrain bitmap. Obstacles never move and never change after
// world creation, so the polygon/gradient/stroke work that used to
// run every frame in the main render loop is baked into an offscreen
// canvas once. The main loop then blits it with a single drawImage().
let terrainBitmap: HTMLCanvasElement | null = null;
function buildTerrainBitmap(): void {
  const w = WORLD_SIZE.w;
  const h = WORLD_SIZE.h;
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const octx = off.getContext("2d");
  if (!octx) return;
  // Procedural rock texturing. The plan:
  //   1. Stamp each obstacle polygon as a solid base-tone fill so the
  //      texturing pass only has to consider pixels that are rock.
  //      We pull the pixel buffer once and modify in place so the
  //      texture noise doesn't go through canvas state-change cost.
  //   2. Per pixel marked rock: composite base tone + noise +
  //      directional lighting + occasional dark fissure. Lighting
  //      uses a per-column "rock surface y" (the topmost rock pixel
  //      at that x) so pixels near the top of the rock get the
  //      lit-from-above highlight, and deeper pixels get the shadow.
  //   3. Stroke a thin edge on top so the polygon silhouette is
  //      crisp at the rock/water boundary.
  //
  // Cost: O(rock pixel count) once at world load. With a default
  // 720x420 world and ~80-100k rock pixels we're at a few ms in dev,
  // which is invisible (called once, off the hot path).

  // Pass 1: solid base fill. Picks up alpha=255 inside the polygon
  // so the pixel-write pass can use the alpha channel as a mask.
  octx.fillStyle = "#000000"; // alpha tag color -- overwritten in pass 2
  for (const ob of snapshot.obstacles) {
    octx.beginPath();
    if (ob.polygon && ob.polygon.length >= 3) {
      octx.moveTo(ob.polygon[0].x, ob.polygon[0].y);
      for (let i = 1; i < ob.polygon.length; i++) {
        octx.lineTo(ob.polygon[i].x, ob.polygon[i].y);
      }
      octx.closePath();
    } else {
      for (const l of ob.lobes) {
        octx.moveTo(l.x + l.r, l.y);
        octx.arc(l.x, l.y, l.r, 0, Math.PI * 2);
      }
    }
    octx.fill();
  }

  // Build a per-column "topmost rock y" map for lighting. Scan the
  // alpha channel of the just-filled bitmap; first non-transparent
  // pixel from the top is the rock surface for that column. Anywhere
  // there's no rock, mark the surface as h+1 so the lighting term
  // becomes maximally dark (no upward-facing surface above).
  const imgData = octx.getImageData(0, 0, w, h);
  const buf = imgData.data;
  const topY = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    let foundY = h + 1;
    for (let y = 0; y < h; y++) {
      if (buf[(y * w + x) * 4 + 3] !== 0) { foundY = y; break; }
    }
    topY[x] = foundY;
  }

  // Pass 2: per-rock-pixel coloring. Iterate the buffer once and
  // rewrite every alpha != 0 pixel. Base tone is a warm dark gray
  // (matches the obstacle's ob.color but we don't pull from it --
  // procedural texture provides all the per-pixel variation).
  const BASE_R = 74, BASE_G = 64, BASE_B = 56; // ~#4a4038
  // Noise amplitude per channel. Big enough to read as "rock", small
  // enough to stay in the dark-brown band.
  const NOISE_AMP = 22;
  // Lighting: pixels within LIGHT_FALLOFF px below the local top get
  // a highlight; below that, the rock fades to shadow. LIGHT_MAX is
  // the max upward-facing brightness boost; SHADOW_MAX is the
  // downward-facing darkening.
  const LIGHT_FALLOFF = 18;
  const LIGHT_MAX = 36;
  const SHADOW_MAX = 28;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      if (buf[idx + 3] === 0) continue;
      // Multi-octave value noise on (x, y). hash2D is cheap and
      // produces uncorrelated values; smoothing isn't needed for
      // texture (we WANT high-frequency grain at the pixel level).
      const n1 = hash2D(x, y);              // -0.5..0.5
      const n2 = hash2D(x >> 2, y >> 2);    // coarser, lower-freq mottling
      const n3 = hash2D(x >> 5, y >> 5);    // very low freq, big patches
      const noise = (n1 * 0.5 + n2 * 0.35 + n3 * 0.6) * NOISE_AMP;
      // Lighting. depthFromTop = how far below the local rock surface
      // this pixel is. Negative shouldn't happen (we sampled topY
      // from the same alpha mask), but clamp defensively.
      const surf = topY[x];
      const depthFromTop = Math.max(0, y - surf);
      let lighting = 0;
      if (depthFromTop < LIGHT_FALLOFF) {
        // Upward-facing: brighter. Quadratic falloff feels more like
        // rim-light than linear.
        const t = 1 - depthFromTop / LIGHT_FALLOFF;
        lighting = LIGHT_MAX * t * t;
      } else {
        // Below the lit band, darken proportionally with depth but
        // saturate at SHADOW_MAX so deep interiors aren't pitch black.
        const t = Math.min(1, (depthFromTop - LIGHT_FALLOFF) / 60);
        lighting = -SHADOW_MAX * t;
      }
      // Cracks/fissures. Use a thresholded noise channel so the
      // darkening only triggers on a sparse subset of pixels. Two
      // overlapping low-freq fields ORed -> short curving cracks.
      // crackVal close to 0.5 means edges of two noise fields meet
      // -- those become the crack pixels.
      const c1 = Math.abs(hash2D(x >> 1, y >> 3));
      const c2 = Math.abs(hash2D(x >> 3, y >> 1));
      let crackDark = 0;
      if (c1 < 0.06 || c2 < 0.06) crackDark = -34;
      // Compose. Clamp to [0,255]; the base + noise + lighting +
      // crack can over/underflow the byte range on extreme inputs.
      const r = clamp255(BASE_R + noise + lighting + crackDark);
      const g = clamp255(BASE_G + noise * 0.9 + lighting * 0.95 + crackDark);
      const b = clamp255(BASE_B + noise * 0.8 + lighting * 0.85 + crackDark);
      buf[idx] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
      // alpha already 255 from the fill
    }
  }
  octx.putImageData(imgData, 0, 0);

  // Pass 3: crisp outline along each polygon edge. Drawn on top of
  // the textured fill so the silhouette pops against the water
  // gradient. Very dark; near-black.
  octx.strokeStyle = "rgba(20, 16, 12, 0.85)";
  octx.lineWidth = 1;
  for (const ob of snapshot.obstacles) {
    if (!ob.polygon || ob.polygon.length < 3) continue;
    octx.beginPath();
    octx.moveTo(ob.polygon[0].x, ob.polygon[0].y);
    for (let i = 1; i < ob.polygon.length; i++) {
      octx.lineTo(ob.polygon[i].x, ob.polygon[i].y);
    }
    octx.closePath();
    octx.stroke();
  }
  terrainBitmap = off;
}

// Pseudo-random hash on (x, y). Returns roughly uniform in [-0.5, 0.5).
// Cheap 32-bit integer math; deterministic per (x, y) so the rock
// texture is stable for the lifetime of the bitmap.
function hash2D(x: number, y: number): number {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  h = h ^ (h >>> 16);
  return ((h >>> 0) / 0x100000000) - 0.5;
}

function clamp255(v: number): number {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return v | 0;
}

// Cell-fill gradient cache. cellShadingFill() used to build a fresh
// CanvasGradient per cell per frame. At pop=100, 60fps, that's 6k
// gradients/sec being allocated and garbage-collected. Caching keyed
// by (color, r-bucket) keeps the count to a few hundred entries
// across the run. Each cached gradient is built at origin so the
// caller translates the canvas to the cell's position before fill.
const CELL_GRAD_CACHE = new Map<string, CanvasGradient>();
function getCellGradient(color: string, r: number): CanvasGradient {
  // Round to 1px buckets -- gradients quantized to integer cell radii
  // are visually indistinguishable but cap the cache size.
  const rb = Math.max(1, Math.round(r));
  const key = color + "@" + rb;
  let g = CELL_GRAD_CACHE.get(key);
  if (g) return g;
  g = ctx.createRadialGradient(-rb * 0.35, -rb * 0.45, rb * 0.05, 0, 0, rb * 1.05);
  g.addColorStop(0, hslAdjustL(color, 22));
  g.addColorStop(0.55, color);
  g.addColorStop(1, hslAdjustL(color, -25));
  CELL_GRAD_CACHE.set(key, g);
  return g;
}

// Draw a wobbly cell body filled with the cached radial gradient
// for its color. The gradient is built at origin; we translate the
// canvas to the cell's position so the same cached object can fill
// any cell of that color/radius.
function drawCellBody(cx: number, cy: number, r: number, color: string, t: number, phase: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = getCellGradient(color, r);
  tracedWobblyBody(0, 0, r, t, phase);
  ctx.fill();
  ctx.restore();
}

// Below this on-screen radius (in CSS pixels) the wobble and outline
// are imperceptible -- the cell becomes a tinted dot. Skipping them
// saves ~15 path ops + a stroke per such cell per frame. The world is
// always letterboxed-fully-visible, so traditional viewport-based
// frustum culling is a no-op; this size-based LOD is the equivalent
// win for cells that occupy ~1 pixel of screen.
const LOD_MIN_SCREEN_R = 2.0;

function drawCellLOD(cx: number, cy: number, r: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawCreature(c: CreatureSnapshot, selected: boolean, kin = false): void {
  // Each cell has a stable random phase derived from its bornAt + position,
  // so its wobble pattern is its own instead of every cell pulsing in sync.
  const phase = c.bornAt * 0.7 + c.x * 0.013 + c.y * 0.019;
  const t = snapshot.t;
  const screenR = c.r * viewScale;
  const lod = !selected && !kin && screenR < LOD_MIN_SCREEN_R;
  if (c.division) {
    // Mitosis: render two overlapping wobbly bodies whose centers split
    // along the division axis as `progress` advances 0 -> 1.
    const child = c.division;
    const sep = c.division.progress * (c.r + child.childR);
    const dx = Math.cos(c.division.axis) * sep * 0.5;
    const dy = Math.sin(c.division.axis) * sep * 0.5;
    if (lod) {
      drawCellLOD(c.x - dx, c.y - dy, c.r, c.color);
      drawCellLOD(c.x + dx, c.y + dy, child.childR, child.childColor);
    } else {
      drawCellBody(c.x - dx, c.y - dy, c.r, c.color, t, phase);
      strokeCellOutline(c.x - dx, c.y - dy, c.r, selected, t, phase, kin);
      drawCellBody(c.x + dx, c.y + dy, child.childR, child.childColor, t, phase + 1.7);
      strokeCellOutline(c.x + dx, c.y + dy, child.childR, selected, t, phase + 1.7, kin);
    }
  } else if (lod) {
    drawCellLOD(c.x, c.y, c.r, c.color);
  } else {
    drawCellBody(c.x, c.y, c.r, c.color, t, phase);
    strokeCellOutline(c.x, c.y, c.r, selected, t, phase, kin);
  }

  // Engulfed prey: render each inside the predator, clustered around the
  // center. Their barrier is intact, so they're drawn with their own color
  // and a thin outline -- visually distinct from absorbed-mass coloring.
  if (c.contents.length > 0) {
    const innerR = Math.min(c.r * 0.45, 6);
    for (let i = 0; i < c.contents.length; i++) {
      const angle = (i / Math.max(1, c.contents.length)) * Math.PI * 2;
      const offR = c.contents.length === 1 ? 0 : c.r * 0.35;
      const ix = c.x + Math.cos(angle) * offR;
      const iy = c.y + Math.sin(angle) * offR;
      ctx.fillStyle = c.contents[i].color;
      ctx.beginPath();
      ctx.arc(ix, iy, innerR, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

}

// Trace a wobbly closed path around (cx, cy). Caller is responsible for
// fill() / stroke() so the same path can be both filled and outlined. The
// wobble combines two sine harmonics over angle, modulated by time, plus
// a per-cell phase so cells don't all pulse together.
const WOBBLE_SEGMENTS = 14;
function tracedWobblyBody(cx: number, cy: number, r: number, t: number, phase: number): void {
  ctx.beginPath();
  for (let i = 0; i <= WOBBLE_SEGMENTS; i++) {
    const a = (i / WOBBLE_SEGMENTS) * Math.PI * 2;
    const wob =
      1 +
      0.05 * Math.sin(t * 1.7 + phase + a * 3) +
      0.03 * Math.sin(t * 0.9 + phase * 1.3 + a * 5);
    const rr = r * wob;
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

// Format seconds as "1h02m" / "12m04s" / "47.3s" so age is readable across
// the wide range a long-running simulation can produce.
function formatAge(sec: number): string {
  if (sec < 60) return `${sec.toFixed(1)}s`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec - m * 60);
    return `${m}m${s.toString().padStart(2, "0")}s`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec - h * 3600) / 60);
  return `${h}h${m.toString().padStart(2, "0")}m`;
}

// Best-effort plain-English summary of a cell, inferred from genome ops it
function updateInspector(): void {
  // Bar stays visible whether the HUD body is open or collapsed; show
  // fps + sim/wall ratio + elapsed sim time + pop + extinction count +
  // build time there. pop= shows cells / living species / lineages:
  //   - cells: total live cells.
  //   - species: distinct genomes among currently-alive cells.
  //   - lineages: distinct founding lineages still alive -- count of
  //     distinct lineageRoot ids (cells sharing a founder collapse to
  //     one), so this is "how many separate founder lineages persist".
  // world.species.size would over-count -- it includes extinct
  // species still in the prune grace window.
  const liveLineages = new Set<number>();
  const liveSpecies = new Set<string>();
  for (const c of snapshot.creatures) {
    liveLineages.add(c.lineageRoot);
    liveSpecies.add(c.speciesKey);
  }
  hudStats.textContent =
    `fps=${perfFps.toFixed(0)}  sim=${perfSimRate.toFixed(1)}x  ` +
    `t=${formatAge(snapshot.t)}  pop=${snapshot.creatures.length}/${liveSpecies.size}/${liveLineages.size}  ` +
    `extinct=${snapshot.extinctionCount}  build=${__BUILD_TIME__}`;
  hudTimings.textContent =
    `r=${perfRenderMs.toFixed(1)}ms  s=${perfSimMs.toFixed(1)}ms`;
  // No auto-fallback: if nothing is selected the inspector shows the
  // population summary and the pin control hides. Selection only
  // changes when the user clicks a cell (or it's cleared on death by
  // clearSelectionIfDead).
  // Always re-disassemble: the selected cell's genome can change between
  // frames from somatic mutation, so a cached string would go stale.
  refreshActiveDisasm();
  const c = selectedCell();
  if (!c) {
    pinSpeciesBtn.style.display = "none";
    inspectorProse.style.display = "none";
    disasmBar.style.display = "none";
    disasmBody.style.display = "none";
    inspector.textContent = `${statsLine()}\npop=0  particles=${snapshot.particles.length}`;
    return;
  }
  {
    const isPinned = pinnedSpecies.has(c.speciesKey);
    pinSpeciesBtn.style.display = "flex";
    const col = isPinned ? "#ffd24c" : "#9ee";
    pinSpeciesBtn.innerHTML =
      `<span style="font-weight:bold;line-height:1;color:${col};">` +
      `${isPinned ? "★" : "☆"}</span>` +
      `<span style="color:${col};">${isPinned ? "unpin" : "pin"} species ` +
      `<b>${genomeTag(c.genome)}</b></span>`;
  }
  inspectorProse.style.display = "";
  inspectorProse.textContent = describeGenomeProse(c.genome);
  disasmBar.style.display = "flex";
  disasmBody.style.display = disasmExpanded ? "" : "none";
  let molMass = c.energy;
  for (const k of MOLECULE_IDS) molMass += c.molecules[k];
  const totalMass = molMass;
  const m = c.molecules;
  const fmt = (x: number) => x.toFixed(0);
  const stackStr = c.vmStack.map((n) => n.toFixed(1)).join(" ");
  const age = formatAge(Math.max(0, snapshot.t - c.bornAt));
  inspector.textContent =
    `${statsLine()}\n` +
    `pop=${snapshot.creatures.length}  parts=${snapshot.particles.length}/${snapshot.particleTarget}  extinct=${snapshot.extinctionCount}  (click a cell)\n` +
    `age=${age}  pos=(${c.x.toFixed(0)},${c.y.toFixed(0)},${c.z.toFixed(1)})  ` +
    `vel=(${c.vx.toFixed(1)},${c.vy.toFixed(1)})\n` +
    `r=${c.r.toFixed(1)}  mass=${totalMass.toFixed(0)}  ATP=${c.energy.toFixed(0)}  ADP=${fmt(m.adp)}\n` +
    `ingestCD=${c.ingestCooldown.toFixed(2)}s\n` +
    `food: glu=${fmt(m.glucose)} fa=${fmt(m.fattyAcid)} aa=${fmt(m.aminoAcid)} min=${fmt(m.minerals)}\n` +
    `gas:  O2=${fmt(m.o2)} CO2=${fmt(m.co2)} waste=${fmt(m.waste)}\n` +
    `cell: chl=${fmt(m.chlorophyll)} enz=${fmt(m.enzyme)} mRNA=${fmt(m.mrna)} memb=${fmt(m.membrane)}\n` +
    `bulk: biop=${fmt(m.biopolymer)}\n` +
    // K-7: receptor inventory. Each cell shows photoreceptor band
    // pools (V/L/S), per-target chemoreceptor pools (B/M/F/0), and
    // the scalar mech/thermo/magneto pools. Bond + repair chems
    // show alongside since they're chemistry-mediated actions now.
    `photo: V=${fmt(m.photoreceptorVisible)} L=${fmt(m.photoreceptorLong)} S=${fmt(m.photoreceptorSurface)}\n` +
    `chemo: B=${fmt(m.chemoreceptorBiopolymer)} M=${fmt(m.chemoreceptorMinerals)} F=${fmt(m.chemoreceptorFa)} 0=${fmt(m.chemoreceptorMarker0)}\n` +
    `sense: mech=${fmt(m.mechanoreceptor)} thermo=${fmt(m.thermoreceptor)} mag=${fmt(m.magnetoreceptor)}\n` +
    `bond=${fmt(m.bondChem)} repair=${fmt(m.repairChem)}\n` +
    (c.contents.length > 0 ? `vacuole: ${c.contents.length} engulfed cell(s)\n` : "") +
    `pc=${c.vmPc}  genome=${c.genome.length}b  stack=[${stackStr}]`;
  disasmBody.textContent = activeDisasm;
}

// Sim runs flat-out in simWorker; the renderer is just an rAF loop
// that consumes whatever snapshot the worker last posted (~60Hz under
// normal load, less under heavy work). FPS / sim-rate / per-frame
// timings come from the running tallies the snapshot handler keeps
// in workerSimMsThisFrame / workerAdvancedThisFrame.

// Stats line: FPS + sim/wall ratio + particle count. Smoothed over a
// short window so the numbers don't flicker.
let perfWallStart = performance.now();
let perfSimSecs = 0;
let perfFrames = 0;
let perfFps = 0;
let perfSimRate = 1;
// Per-frame timing for diagnosing where the 16.6ms budget goes.
// renderMs + simMs + idle ≈ wall-time per frame; the breakdown tells
// you whether render, sim, or browser pacing is the bottleneck.
let perfRenderMsAcc = 0;
let perfSimMsAcc = 0;
let perfRenderMs = 0;
let perfSimMs = 0;
function updatePerfStats(simAdvanced: number, renderMs: number, simMs: number): void {
  perfSimSecs += simAdvanced;
  perfRenderMsAcc += renderMs;
  perfSimMsAcc += simMs;
  perfFrames++;
  const elapsed = (performance.now() - perfWallStart) / 1000;
  if (elapsed > 0.5) {
    perfFps = perfFrames / elapsed;
    perfSimRate = perfSimSecs / elapsed;
    perfRenderMs = perfRenderMsAcc / perfFrames;
    perfSimMs = perfSimMsAcc / perfFrames;
    perfWallStart = performance.now();
    perfSimSecs = 0;
    perfFrames = 0;
    perfRenderMsAcc = 0;
    perfSimMsAcc = 0;
  }
}

function statsLine(): string {
  // Count only species with currently-living cells (matches the
  // top-row pop= number). snapshot.species includes the
  // SPECIES_GRACE_SEC window of dead species, which inflates the
  // count if used directly.
  const liveSpeciesKeys = new Set<string>();
  for (const c of snapshot.creatures) liveSpeciesKeys.add(c.speciesKey);
  let s = `fps=${perfFps.toFixed(0)}  sim=${perfSimRate.toFixed(1)}x  t=${snapshot.t.toFixed(0)}s  species=${liveSpeciesKeys.size}`;
  const p = snapshot.profile;
  if (p && p.ticks > 0) {
    const total =
      p.bonds + p.forces + p.creatures +
      p.particleColl + p.creatureColl + p.sedimentColl + p.obstacleColl +
      p.walls + p.aerate + p.replenish + p.prune;
    s += `  [prof ${ (total / p.ticks).toFixed(2) }ms/tick over ${p.ticks}t]`;
  }
  return s;
}

// Sim and render are fully decoupled: sim runs in simWorker on its own
// thread; main thread just renders the latest snapshot the worker has
// posted. The frame loop pulls workerSimMsThisFrame /
// workerAdvancedThisFrame from the running tally that the worker's
// snapshot-message handler maintains.

function frame(): void {
  const tFrameStart = performance.now();
  const simMsLast = workerSimMsThisFrame;
  workerSimMsThisFrame = 0;
  const advanced = workerAdvancedThisFrame;
  workerAdvancedThisFrame = 0;
  turboFrameCounter = (turboFrameCounter + 1) | 0;
  const renderThisFrame = !turboMode || (turboFrameCounter % TURBO_RENDER_EVERY) === 0;
  const tBeforeRender = performance.now();
  if (renderThisFrame) {
    render();
  }
  const tAfterRender = performance.now();
  mpRenderMs += tAfterRender - tBeforeRender;
  updateInspector();
  const tAfterInspector = performance.now();
  mpInspectorMs += tAfterInspector - tAfterRender;
  if (lockedCellId != null || pendingMouseInside) flushTooltip();
  const tAfterTooltip = performance.now();
  mpFlushTooltipMs += tAfterTooltip - tAfterInspector;
  maybeAnalyzeGenomes();
  updateChemPanel();
  const tAfterAnalyze = performance.now();
  mpAnalyzeMs += tAfterAnalyze - tAfterTooltip;
  const renderMs = tAfterRender - tBeforeRender;
  updatePerfStats(advanced, renderMs, simMsLast);
  updateDiagBar();
  const tFrameEnd = performance.now();
  mpDiagBarMs += tFrameEnd - tAfterAnalyze;
  mpFrames++;
  mpFrameTotalMs += tFrameEnd - tFrameStart;
  maybeLogMainProfile();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Mobile-friendly diag bar: surface stall + error state on screen
// instead of in the dev console.
let stallWatchT = 0;
let stallWatchWall = performance.now();
const STALL_WALL_MS = 1500;
function updateDiagBar(): void {
  const nowWall = performance.now();
  if (snapshot.t !== stallWatchT) {
    stallWatchT = snapshot.t;
    stallWatchWall = nowWall;
  }
  const stalledMs = nowWall - stallWatchWall;
  const parts: string[] = [];
  if (stalledMs > STALL_WALL_MS) {
    parts.push(`SIM STALLED ${(stalledMs / 1000).toFixed(1)}s  pop=${snapshot.creatures.length}  parts=${snapshot.particles.length}`);
  }
  if (workerLastSimError) {
    parts.push(`step err @ t=${workerLastSimErrorAt.toFixed(0)}s: ${workerLastSimError.slice(0, 120)}`);
  }
  if (parts.length === 0) {
    hudDiag.style.display = "none";
  } else {
    hudDiag.style.display = "";
    hudDiag.textContent = parts.join(" | ");
  }
}

// Sidebar panel: this run's top 10 species (past and current),
// refreshed every ANALYSIS_INTERVAL_SEC of sim-time.
//
// Sort key:
//   1. Live cell count (sp.alive), descending
//   2. Total cell mass across living members, descending
//   3. firstSeen ascending (oldest species win ties)
const ANALYSIS_INTERVAL_SEC = 60;
let lastAnalysisT = -Infinity;

type AnalysisRow = {
  key: string;
  genome: Uint8Array;
  color: string;
  alive: boolean;
  duration: number;
  biomass: number;
  mass: number;
  cells: number;
  firstSeen: number;
};

// Top species ranked by live cell count, then total live cell mass,
// then age. Total cell mass is summed from the live creature snapshots
// (energy + molecular contents), distinct from membrane-based biomass.
function computeRankedRows(): AnalysisRow[] {
  const massByKey = new Map<string, number>();
  for (const c of snapshot.creatures) {
    let m = c.energy;
    for (const k of MOLECULE_IDS) m += c.molecules[k];
    massByKey.set(c.speciesKey, (massByKey.get(c.speciesKey) ?? 0) + m);
  }
  const rows: AnalysisRow[] = [];
  for (const sp of snapshot.species) {
    const alive = sp.alive > 0;
    rows.push({
      key: sp.key,
      genome: sp.genome,
      color: sp.color,
      alive,
      duration: (alive ? snapshot.t : sp.lastSeen) - sp.firstSeen,
      biomass: peakBiomassByKey.get(sp.key) ?? sp.peakBiomass,
      mass: massByKey.get(sp.key) ?? 0,
      cells: sp.alive,
      firstSeen: sp.firstSeen,
    });
  }
  rows.sort((a, b) => {
    if (b.cells !== a.cells) return b.cells - a.cells;
    if (b.mass !== a.mass) return b.mass - a.mass;
    return a.firstSeen - b.firstSeen;
  });
  return rows;
}

// Sim-driven hall of fame: every analysis cycle, fold the current
// ranked species into a persisted best-N-by-peak-biomass set. Full
// genome stored so an entry survives extinction + reload.
function updateHallOfFame(rows: AnalysisRow[]): void {
  for (const r of rows.slice(0, HOF_LIMIT)) {
    const prev = hallOfFame.get(r.key);
    if (prev === undefined || r.biomass > prev.peakBio) {
      hallOfFame.set(r.key, {
        key: r.key, genome: Array.from(r.genome), color: r.color,
        at: snapshot.t, peakBio: r.biomass,
      });
    }
  }
  if (hallOfFame.size > HOF_LIMIT) {
    const keep = [...hallOfFame.values()]
      .sort((a, b) => b.peakBio - a.peakBio)
      .slice(0, HOF_LIMIT);
    hallOfFame.clear();
    for (const e of keep) hallOfFame.set(e.key, e);
  }
  // Intentionally NOT persisted: Notable is per-sim-run for now.
}

function togglePin(key: string, genome: Uint8Array, color: string, peakBio: number): void {
  if (pinnedSpecies.has(key)) {
    pinnedSpecies.delete(key);
  } else {
    pinnedSpecies.set(key, {
      key, genome: Array.from(genome), color, at: snapshot.t, peakBio,
    });
  }
  persistMarked(PIN_KEY, pinnedSpecies);
  syncPinnedToWorker();
  renderAnalysisPanel();
}

// One species card. rankLabel is "#1" etc for ranked tabs, "" for
// flat lists. status text is precomputed by the caller.
function buildSpeciesCard(
  genome: Uint8Array, color: string,
  rankLabel: string, status: string, statsLine: string,
): HTMLDivElement {
  const block = document.createElement("div");
  block.style.cssText = "padding:6px 0;border-bottom:1px solid #1a3340;white-space:pre-wrap;line-height:1.4;";
  const dot = `<span style="display:inline-block;width:8px;height:8px;background:${color};border-radius:50%;margin-right:6px;vertical-align:middle;"></span>`;
  const tm = trophicMode(genome);
  const trophicChip =
    `<span style="display:inline-block;padding:1px 5px;border-radius:3px;` +
    `background:${tm.bg};color:${tm.fg};font-weight:bold;` +
    `margin-right:6px;vertical-align:middle;">${tm.label}</span>`;
  // Pinning lives in the HUD inspector (select a cell -> pin its
  // species), not here -- a card only exists for species already in
  // Top 10 / Pinned / Notable, which can't reach an arbitrary species.
  const headDiv = document.createElement("div");
  headDiv.innerHTML =
    (rankLabel ? `<b>${rankLabel}</b>  ` : "") +
    `${dot}${trophicChip}` +
    `<b style="letter-spacing:0.5px;">${genomeTag(genome)}</b>` +
    `<span style="opacity:.7"> (${genome.length}b)</span>  ${status}`;
  const statsDiv = document.createElement("div");
  statsDiv.style.cssText = "opacity:0.85;padding-top:2px;";
  statsDiv.textContent = statsLine;
  // Spawn: drop a fresh instance of exactly this genome into the
  // world. The worker uses local particles if the spawn patch has
  // any, otherwise the fixed molecule seed forces viability anyway.
  const spawnBtn = document.createElement("button");
  spawnBtn.textContent = "Spawn";
  spawnBtn.style.cssText =
    "margin-top:4px;padding:2px 8px;border:1px solid #1a3340;border-radius:3px;" +
    `background:rgba(0,0,0,.4);color:#9ee;cursor:pointer;font-size:${UI_FONT_PX}px;`;
  spawnBtn.addEventListener("click", () => {
    simWorker.postMessage({ type: "spawnSpecies", genome: Array.from(genome) });
    spawnBtn.textContent = "Spawned ✓";
    setTimeout(() => { spawnBtn.textContent = "Spawn"; }, 1200);
  });
  const proseDiv = document.createElement("div");
  proseDiv.style.cssText = "padding-top:3px;";
  proseDiv.textContent = describeGenomeProse(genome);
  block.appendChild(headDiv);
  block.appendChild(statsDiv);
  block.appendChild(proseDiv);
  block.appendChild(spawnBtn);
  return block;
}

function renderAnalysisPanel(): void {
  if (analysisMinimized || !isListTab(analysisTab)) return;
  analysisBody.innerHTML = "";
  const header = document.createElement("div");
  header.style.cssText = "padding:6px 0 8px;font-weight:bold;border-bottom:1px solid #1a3340;";
  analysisBody.appendChild(header);

  if (analysisTab === "top") {
    const rows = computeRankedRows().slice(0, 10);
    header.textContent = `Top 10 live at t=${formatAge(snapshot.t)} (${snapshot.species.length} tracked)`;
    rows.forEach((r, i) => {
      const status = r.alive ? "ALIVE" : "EXTINCT";
      const stats = `duration=${formatAge(r.duration)}  peakBio=${r.biomass.toFixed(0)}  cells=${r.cells}`;
      analysisBody.appendChild(buildSpeciesCard(r.genome, r.color, `#${i + 1}`, status, stats));
    });
    return;
  }

  // Pinned + Notable read from the persisted maps so entries survive
  // extinction / reload; live status is looked up by key when present.
  const src = analysisTab === "pinned" ? pinnedSpecies : hallOfFame;
  // Pinned: newest-pinned first (by the sim-time it was recorded).
  // Notable: best-ever first (peak biomass).
  const entries = analysisTab === "pinned"
    ? [...src.values()].sort((a, b) => b.at - a.at)
    : [...src.values()].sort((a, b) => b.peakBio - a.peakBio);
  header.textContent = analysisTab === "pinned"
    ? `Pinned species (${entries.length}) -- founders cull-exempt`
    : `Notable: best ${entries.length} ever seen`;
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding:10px 0;opacity:0.7;";
    empty.textContent = analysisTab === "pinned"
      ? "No pinned species yet. Tap the ☆ on any species card to pin it."
      : "No notable species yet -- they accrue as the sim runs.";
    analysisBody.appendChild(empty);
    return;
  }
  for (const e of entries) {
    const live = snapshotSpeciesByKey.get(e.key);
    const status = live && live.alive > 0
      ? `ALIVE (${live.alive} cells)`
      : `EXTINCT`;
    const stats = `peakBio=${e.peakBio.toFixed(0)}  noted@t=${formatAge(e.at)}`;
    analysisBody.appendChild(
      buildSpeciesCard(Uint8Array.from(e.genome), e.color, "", status, stats),
    );
  }
}

function maybeAnalyzeGenomes(): void {
  if (snapshot.t - lastAnalysisT < ANALYSIS_INTERVAL_SEC) return;
  lastAnalysisT = snapshot.t;
  updateHallOfFame(computeRankedRows());
  renderAnalysisPanel();
}

// Trophic mode chip for the sidebar: same op-presence rules viableGenome
// uses to decide whether a candidate is a photoautotroph, heterotroph,
// predator, or mixotroph (both photo + animal eating). Color-coded so
// the eye groups species by lifestyle.
type TrophicMode = { label: string; bg: string; fg: string };
const TROPHIC_AUTO: TrophicMode = { label: "auto", bg: "#1e4d2b", fg: "#9efba8" };
const TROPHIC_HET: TrophicMode  = { label: "het",  bg: "#1c3b5a", fg: "#9ec7ff" };
const TROPHIC_PRED: TrophicMode = { label: "pred", bg: "#5a1c1c", fg: "#ff9e9e" };
const TROPHIC_MIXO: TrophicMode = { label: "mixo", bg: "#5a4a1c", fg: "#ffe49e" };
function trophicMode(genome: Uint8Array): TrophicMode {
  let hasIngest = false, hasPredate = false, hasEngulf = false, hasChl = false;
  walkGenome(genome, (op, _pc, operand) => {
    if (op === OP.INGEST) hasIngest = true;
    else if (op === OP.PREDATE) hasPredate = true;
    else if (op === OP.ENGULF) hasEngulf = true;
    else if (op === OP.SYNTH && (operand ?? 0) % SYNTH_KIND_COUNT === SYNTH_KIND.CHL) hasChl = true;
  });
  const eatsOther = hasPredate || hasEngulf;
  const eatsParticles = hasIngest;
  if (hasChl && !eatsOther && !eatsParticles) return TROPHIC_AUTO;
  if (hasChl && (eatsOther || eatsParticles)) return TROPHIC_MIXO;
  if (eatsOther) return TROPHIC_PRED;
  return TROPHIC_HET;
}

// Walk a genome and describe it as a structured list aligned with the
// post-K-5 chemistry: ingests, metabolism (biosynth + catalysis),
// excretes, senses (the specific chem ids the genome reads), and the
// division gate. Bootstrap chems (0..44) are named; procedural chems
// (45..95) and procedural reaction slots fall back to numeric form.
function describeGenomeProse(genome: Uint8Array): string {
  let thrust = false, turn = false, reproduce = false;
  let predate = false, engulf = false;
  let selfModifies = false;
  let hasJump = false, hasCmp = false;
  // SYNTH kinds observed. PHOTO / CHEMO get per-param bits since one
  // SYNTH op picks a specific band / target.
  const synthSimple = new Set<number>();           // BIO/AA/FA/ENZ/CHL/MRNA/MECH/THERMO/MAGNETO/BOND/REPAIR
  const synthPhotoBands = new Set<number>();       // 0=V, 1=L, 2=S
  const synthChemoTargets = new Set<number>();     // 0=B, 1=M, 2=F, 3=marker0
  const catalystSlots = new Set<number>();
  // INGEST is the 6-slot sensor-chem id (min/biop/fa/o2/co2/glu);
  // EXCRETE is operand mod CHEMICAL_COUNT (any chem in the table).
  const ingest = new Set<number>();
  const excrete = new Set<number>();
  // Chem ids the genome reads via SENSE_CHEMICAL. Distinct from the
  // SYNTH side: SYNTH builds the receptor; SENSE_CHEMICAL reads the
  // activated chem (or any other internal pool).
  const sensedChems = new Set<number>();
  walkGenome(genome, (op, _pc, operand) => {
    switch (op) {
      case OP.THRUST: thrust = true; break;
      case OP.TURN: turn = true; break;
      case OP.REPRODUCE: reproduce = true; break;
      case OP.PREDATE: predate = true; break;
      case OP.ENGULF: engulf = true; break;
      case OP.POKE_BYTE: case OP.SPLICE_DUP: case OP.SPLICE_DEL: selfModifies = true; break;
      case OP.SYNTH: {
        const kind = (operand ?? 0) % SYNTH_KIND_COUNT;
        const param = genome[(_pc + 2) % genome.length] ?? 0;
        if (kind === SYNTH_KIND.PHOTO) synthPhotoBands.add(param % 3);
        else if (kind === SYNTH_KIND.CHEMO) synthChemoTargets.add(param % 4);
        else if (kind === SYNTH_KIND.CAT) catalystSlots.add(param % CATALYST_COUNT);
        else synthSimple.add(kind);
        break;
      }
      case OP.INGEST: ingest.add((operand ?? 0) % 6); break;
      case OP.EXCRETE: excrete.add((operand ?? 0) % 96); break;
      case OP.SENSE_CHEMICAL: sensedChems.add((operand ?? 0) % 96); break;
      case OP.JZ: case OP.JNZ: hasJump = true; break;
      case OP.LT: case OP.GT: case OP.EQ: case OP.NOT: case OP.AND: case OP.OR: hasCmp = true; break;
    }
  });
  const gated = hasJump && hasCmp;
  const synthChl = synthSimple.has(SYNTH_KIND.CHL);
  const synthEnz = synthSimple.has(SYNTH_KIND.ENZ);
  const lines: string[] = [];

  // Ingests: trophic input. INGEST operand maps to the 6-slot sensor
  // chem table (SENSOR_CHEM_LABELS); PREDATE/ENGULF eat other cells.
  const ingestParts: string[] = [];
  if (predate) ingestParts.push("predates cells");
  if (engulf) ingestParts.push("engulfs cells");
  if (ingest.size > 0) {
    const names = Array.from(ingest).sort((a, b) => a - b).map((k) => SENSOR_CHEM_LABELS[k] ?? String(k));
    ingestParts.push(`particles {${names.join(", ")}}`);
  }
  lines.push(`Ingests: ${ingestParts.length > 0 ? ingestParts.join("; ") : "nothing"}.`);

  // Metabolism: catabolism (always-on given substrate), photosynth
  // (chlorophyll-gated), biopolymer digestion (enzyme-gated), and
  // every biosynth pathway the genome's SYNTH ops open up. The
  // engine runs aerobic / ferment / beta-ox on every cell with the
  // right substrate regardless of genome -- they're the "free"
  // tier and worth surfacing so the reader sees the full picture.
  const metab: string[] = ["aerobic+ferment+betaOx (built-in)"];
  if (synthChl) metab.push("photosynth");
  if (synthEnz) metab.push("digestBiop (enzyme-gated)");
  const synthLabels: string[] = [];
  if (synthSimple.has(SYNTH_KIND.AA)) synthLabels.push("aa");
  if (synthSimple.has(SYNTH_KIND.FA)) synthLabels.push("fa");
  if (synthSimple.has(SYNTH_KIND.ENZ)) synthLabels.push("enz");
  if (synthSimple.has(SYNTH_KIND.CHL)) synthLabels.push("chl");
  if (synthSimple.has(SYNTH_KIND.MRNA)) synthLabels.push("mrna");
  if (synthSimple.has(SYNTH_KIND.BIO)) synthLabels.push("memb");
  if (synthPhotoBands.size > 0) {
    const bands = Array.from(synthPhotoBands).sort().map((b) => "VLS"[b]);
    synthLabels.push(`photoR-{${bands.join(",")}}`);
  }
  if (synthChemoTargets.size > 0) {
    const tgts = Array.from(synthChemoTargets).sort().map((t) => "BMF0"[t]);
    synthLabels.push(`chemoR-{${tgts.join(",")}}`);
  }
  if (synthSimple.has(SYNTH_KIND.MECH)) synthLabels.push("mechR");
  if (synthSimple.has(SYNTH_KIND.THERMO)) synthLabels.push("thermoR");
  if (synthSimple.has(SYNTH_KIND.MAGNETO)) synthLabels.push("magR");
  if (synthSimple.has(SYNTH_KIND.BOND)) synthLabels.push("bond");
  if (synthSimple.has(SYNTH_KIND.REPAIR)) synthLabels.push("repair");
  if (synthLabels.length > 0) metab.push(`synths {${synthLabels.join(", ")}}`);
  lines.push(`Metabolism: ${metab.join(", ")}.`);

  // Catalysts: each SYNTH CAT <slot> boosts reaction slot N. First
  // NAMED_REACTION_NAMES.length slots map to named pathways; the
  // rest are procedural and shown as "rxnN".
  if (catalystSlots.size > 0) {
    const slots = Array.from(catalystSlots).sort((a, b) => a - b).map(reactionName);
    lines.push(`Catalysts boost: ${slots.join(", ")}.`);
  } else {
    lines.push(`Catalysts boost: none.`);
  }

  // Excretes: EXCRETE operand mod CHEMICAL_COUNT picks any chem id.
  // Bootstrap chems get named; procedural chems show as "chemN".
  if (excrete.size > 0) {
    const names = Array.from(excrete).sort((a, b) => a - b).map(chemName);
    lines.push(`Excretes: ${names.join(", ")}.`);
  } else {
    lines.push(`Excretes: nothing (plus passive CO2/waste auto-vent).`);
  }

  // Senses: SENSE_CHEMICAL <id> reads. Lists every chem id the genome
  // explicitly samples. Same name-vs-number rule as excretion.
  if (sensedChems.size > 0) {
    const names = Array.from(sensedChems).sort((a, b) => a - b).map(chemName);
    lines.push(`Senses: ${names.join(", ")}${gated ? "" : " (ungated -- no JZ+cmp)"}.`);
  } else {
    lines.push(`Senses: nothing (no SENSE_CHEMICAL ops).`);
  }

  // Division: REPRODUCE op + whether gated by JZ/JNZ + comparison.
  if (reproduce) {
    lines.push(`Divides: ${gated ? "conditionally (JZ+cmp gates the REPRODUCE op)" : "reflexively (REPRODUCE fires every tick)"}.`);
  } else {
    lines.push(`Divides: never (no REPRODUCE op).`);
  }

  // Motion + self-mod hints (small bullet, optional).
  const extras: string[] = [];
  if (thrust && turn) extras.push("thrusts + turns");
  else if (thrust) extras.push("thrusts");
  else if (turn) extras.push("turns in place");
  if (selfModifies) extras.push("self-modifies genome");
  if (extras.length > 0) lines.push(`Other: ${extras.join(", ")}.`);

  return lines.join("\n");
}

