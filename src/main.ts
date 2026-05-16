import "./style.css";

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
  CHEM_COLORS,
  SENSOR_CHEM_LABELS,
  MOLECULE_IDS,
  surfaceYAt,
  temperatureAt,
  solarLight,
  takeSnapshot,
  chemName,
  reactionName,
  genomeTag,
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
const HUD_FONT =
  "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;" +
  "font-size:9px;line-height:1.3;font-weight:normal;font-style:normal;";
const hud = document.createElement("div");
hud.style.cssText =
  "position:fixed;top:8px;left:8px;color:#9ee;background:rgba(0,0,0,.45);" +
  "border-radius:4px;" + HUD_FONT +
  "max-height:80vh;overflow:hidden;";
const hudBar = document.createElement("div");
hudBar.style.cssText =
  "display:flex;justify-content:space-between;align-items:center;padding:2px 4px;" +
  "cursor:pointer;user-select:none;color:#9ee;gap:8px;" + HUD_FONT;
// Live stats shown on the bar even when the HUD body is collapsed.
// Updated by updateInspector() each frame.
const hudStats = document.createElement("span");
hudStats.style.cssText = "padding:0 4px;" + HUD_FONT;
hudStats.textContent = "fps=--  sim=--x  t=0s";
const hudToggle = document.createElement("span");
hudToggle.textContent = "[+]";
hudToggle.style.cssText = "padding:0 4px;" + HUD_FONT;
hudBar.appendChild(hudStats);
hudBar.appendChild(hudToggle);
// Per-frame timing, always visible (even when the inspector body is
// collapsed) so render/sim budget is glanceable while iterating.
const hudTimings = document.createElement("div");
hudTimings.style.cssText = "padding:0 8px 2px;color:#9ee;" + HUD_FONT;
hudTimings.textContent = "r=--ms  s=--ms";
// Stall + error indicator: visible from the bar so mobile users
// can see at a glance whether sim is paused / world is empty /
// last step threw. Hidden by default; shown only when something
// useful is going on.
const hudDiag = document.createElement("div");
hudDiag.style.cssText = "padding:0 8px 2px;color:#f88;display:none;" + HUD_FONT;
// Whole HUD is one font (9px). Each element sets it explicitly
// rather than via inherit, because user-agent styles for <pre> can
// override font-size from cascade in some browsers.
const inspector = document.createElement("pre");
inspector.style.cssText =
  "margin:0;padding:0 9px 6px;color:#9ee;white-space:pre;" + HUD_FONT;
// Disasm gets its own collapsible section: it's much longer than the
// rest of the inspector and almost never wanted at-a-glance. Click the
// "[show disasm]" header to expand.
const disasmHeader = document.createElement("div");
disasmHeader.style.cssText =
  "padding:2px 9px 4px;cursor:pointer;user-select:none;color:#9ee;" + HUD_FONT;
disasmHeader.textContent = "[+] show disasm";
const disasmBody = document.createElement("pre");
disasmBody.style.cssText =
  "margin:0;padding:0 9px 6px;color:#9ee;white-space:pre;display:none;" + HUD_FONT;
hud.appendChild(hudBar);
hud.appendChild(hudTimings);
hud.appendChild(hudDiag);
hud.appendChild(inspector);
hud.appendChild(disasmHeader);
hud.appendChild(disasmBody);
root.appendChild(hud);

let hudMinimized = true;
inspector.style.display = "none";
disasmHeader.style.display = "none";
let disasmExpanded = false;
hudBar.addEventListener("click", () => {
  hudMinimized = !hudMinimized;
  inspector.style.display = hudMinimized ? "none" : "";
  disasmHeader.style.display = hudMinimized ? "none" : "";
  disasmBody.style.display = (hudMinimized || !disasmExpanded) ? "none" : "";
  hudToggle.textContent = hudMinimized ? "[+]" : "[–]";
});
disasmHeader.addEventListener("click", () => {
  disasmExpanded = !disasmExpanded;
  disasmBody.style.display = disasmExpanded ? "" : "none";
  disasmHeader.textContent = disasmExpanded ? "[–] hide disasm" : "[+] show disasm";
});

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
const HOF_KEY = "evosim4:hof";
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
const hallOfFame = loadMarked(HOF_KEY);
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
function descendSelectionIfOrphaned(): void {
  if (selectedCellId == null || snapshotCreatureById.has(selectedCellId)) return;
  for (const c of snapshot.creatures) {
    if (c.parentId === selectedCellId) { selectedCellId = c.id; return; }
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
    rebuildSnapshotIndexes();
    descendSelectionIfOrphaned();
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
function refreshActiveDisasm(): void {
  const sel = selectedCell();
  activeDisasm = sel
    ? formatDisasmColumns(disassemble(sel.genome, SENSOR_CHEM_LABELS), DISASM_COL_LINES)
    : "";
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
const ANALYSIS_PANEL_W = 320;
const ANALYSIS_PANEL_W_MIN = 26;
let analysisMinimized = true;
const analysisPanel = document.createElement("div");
analysisPanel.style.cssText =
  "position:fixed;top:0;right:0;bottom:0;width:" + ANALYSIS_PANEL_W_MIN + "px;" +
  "background:rgba(4,16,24,0.92);color:#9ee;border-left:1px solid #1a3340;" +
  "font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;" +
  "overflow:hidden;padding:0;box-sizing:border-box;z-index:10;";
const analysisHeader = document.createElement("div");
analysisHeader.style.cssText =
  "display:flex;align-items:center;justify-content:center;gap:6px;" +
  "padding:6px 4px;cursor:pointer;user-select:none;border-bottom:1px solid #1a3340;";
// `justify-content` is switched to space-between when expanded so the
// title sits left and the toggle sits right; in the 26px minimized
// tab there's only the toggle, and centered looks right.
const analysisTitle = document.createElement("span");
analysisTitle.textContent = "genome analysis";
analysisTitle.style.cssText = "font-weight:bold;font-size:11px;";
const analysisToggle = document.createElement("span");
analysisToggle.textContent = "+";
// Bracketed forms ([+]/[–]) didn't fit inside the 26px minimized tab
// and got clipped on the right edge. Use the bare glyph; the box on
// the tab itself is the affordance.
analysisToggle.style.cssText = "padding:0 4px;";
analysisHeader.appendChild(analysisTitle);
analysisHeader.appendChild(analysisToggle);
const analysisBody = document.createElement("div");
analysisBody.style.cssText =
  "white-space:pre-wrap;padding:8px 10px;overflow-y:auto;display:none;" +
  "max-height:calc(100vh - 36px);";
// Tab bar: Top 5 (live ranking) | Pinned (user stars) | Notable
// (sim-driven hall of fame). Hidden while the panel is minimized.
type AnalysisTab = "top" | "pinned" | "notable";
let analysisTab: AnalysisTab = "top";
const analysisTabs = document.createElement("div");
analysisTabs.style.cssText =
  "display:none;border-bottom:1px solid #1a3340;";
const TAB_DEFS: { id: AnalysisTab; label: string }[] = [
  { id: "top", label: "Top 5" },
  { id: "pinned", label: "Pinned" },
  { id: "notable", label: "Notable" },
];
const tabButtons = new Map<AnalysisTab, HTMLSpanElement>();
function styleTab(btn: HTMLSpanElement, active: boolean): void {
  btn.style.cssText =
    "display:inline-block;padding:5px 10px;cursor:pointer;user-select:none;" +
    "font-size:11px;" +
    (active
      ? "color:#cff;border-bottom:2px solid #4cc;font-weight:bold;"
      : "color:#7aa;border-bottom:2px solid transparent;");
}
for (const def of TAB_DEFS) {
  const btn = document.createElement("span");
  btn.textContent = def.label;
  styleTab(btn, def.id === analysisTab);
  btn.addEventListener("click", () => {
    analysisTab = def.id;
    for (const [id, b] of tabButtons) styleTab(b, id === analysisTab);
    renderAnalysisPanel();
  });
  tabButtons.set(def.id, btn);
  analysisTabs.appendChild(btn);
}
analysisPanel.appendChild(analysisHeader);
analysisPanel.appendChild(analysisTabs);
analysisPanel.appendChild(analysisBody);
root.appendChild(analysisPanel);
// When minimized, hide the title text so just the [+] sits in the tab.
analysisTitle.style.display = "none";
analysisHeader.addEventListener("click", () => {
  analysisMinimized = !analysisMinimized;
  analysisPanel.style.width = (analysisMinimized ? ANALYSIS_PANEL_W_MIN : ANALYSIS_PANEL_W) + "px";
  analysisBody.style.display = analysisMinimized ? "none" : "";
  analysisTabs.style.display = analysisMinimized ? "none" : "";
  analysisToggle.textContent = analysisMinimized ? "+" : "–";
  analysisTitle.style.display = analysisMinimized ? "none" : "";
  analysisHeader.style.justifyContent = analysisMinimized ? "center" : "space-between";
  analysisHeader.style.padding = analysisMinimized ? "6px 4px" : "6px 8px";
  resize();
  positionWorldButtons();
  // Populate immediately on expand instead of waiting for the next
  // 60s analysis cycle.
  if (!analysisMinimized) renderAnalysisPanel();
});

// Reset (bottom-left) + export (bottom-right) sit inside the world
// area, just above the phylogeny strip. The right button tracks the
// analysis-panel width so it never disappears behind it.
const WORLD_BTN_STYLE =
  "position:fixed;z-index:10;padding:4px 10px;border:1px solid #356;" +
  "border-radius:4px;background:rgba(0,0,0,.55);color:#9ee;cursor:pointer;" +
  HUD_FONT;
const resetBtn = document.createElement("button");
resetBtn.textContent = "reset";
resetBtn.title = "Clear saved world and start fresh";
resetBtn.style.cssText = WORLD_BTN_STYLE;
let resetArmedUntil = 0;
let resetArmTimer: ReturnType<typeof setTimeout> | null = null;
function disarmReset(): void {
  resetArmedUntil = 0;
  resetBtn.textContent = "reset";
  resetBtn.style.cssText = WORLD_BTN_STYLE;
  positionWorldButtons();
  if (resetArmTimer) { clearTimeout(resetArmTimer); resetArmTimer = null; }
}
resetBtn.addEventListener("click", () => {
  const now = performance.now();
  if (now < resetArmedUntil) {
    hardReset();
    return;
  }
  resetArmedUntil = now + 3000;
  resetBtn.textContent = "tap again to wipe";
  resetBtn.style.cssText =
    WORLD_BTN_STYLE +
    "background:rgba(60,0,0,.75);color:#fdd;border-color:#a55;";
  positionWorldButtons();
  if (resetArmTimer) clearTimeout(resetArmTimer);
  resetArmTimer = setTimeout(disarmReset, 3000);
});
root.appendChild(resetBtn);

const exportBtn = document.createElement("button");
exportBtn.textContent = "export";
exportBtn.title = "Download the saved world as JSON";
exportBtn.style.cssText = WORLD_BTN_STYLE;
exportBtn.addEventListener("click", () => {
  // Use the most recent save JSON the worker posted to us. It can be
  // up to SAVE_INTERVAL_SEC stale (60s of sim time); for "current" we'd
  // have to ask the worker and await its response, which is overkill
  // for a manual export.
  const json = latestSaveJson;
  if (!json) {
    alert("export not ready yet -- try again in a moment");
    return;
  }
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  // Filename includes sim time so consecutive exports don't overwrite.
  a.download = `evosim4-save-t${Math.floor(snapshot.t)}s.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a delay so the share sheet has time to read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
});
root.appendChild(exportBtn);

// Turbo mode: sim eats every available ms; render runs only once
// every TURBO_RENDER_EVERY rAFs so the world is still glanceable.
// Toggle button sits between reset and export.
let turboMode = false;
let turboFrameCounter = 0;
const TURBO_RENDER_EVERY = 30; // one render per ~500ms at 60fps rAF
const turboBtn = document.createElement("button");
turboBtn.title = "Run sim flat-out; render once per ~500ms";
const renderTurboBtn = (): void => {
  turboBtn.textContent = turboMode ? "turbo on" : "turbo";
  turboBtn.style.cssText =
    WORLD_BTN_STYLE +
    (turboMode ? "background:rgba(60,40,0,.75);color:#ffd49e;border-color:#a87a3a;" : "");
  positionWorldButtons();
};
turboBtn.addEventListener("click", () => {
  turboMode = !turboMode;
  turboFrameCounter = 0;
  renderTurboBtn();
  simWorker.postMessage({ type: "setTurbo", turbo: turboMode });
});
root.appendChild(turboBtn);

function positionWorldButtons(): void {
  const panelW = analysisMinimized ? ANALYSIS_PANEL_W_MIN : ANALYSIS_PANEL_W;
  const bottom = PHYLO_STRIP_H + 8;
  resetBtn.style.bottom = `${bottom}px`;
  resetBtn.style.left = "8px";
  exportBtn.style.bottom = `${bottom}px`;
  exportBtn.style.right = `${panelW + 8}px`;
  // Turbo sits to the right of reset.
  turboBtn.style.bottom = `${bottom}px`;
  turboBtn.style.left = `${8 + resetBtn.offsetWidth + 8}px`;
}
renderTurboBtn();

function resize(): void {
  // Prefer the visual viewport on mobile: pinch-zoom changes visualViewport
  // dimensions but doesn't fire window.resize on iOS Safari.
  const vv = window.visualViewport;
  const dpr = getDpr();
  const fullW = vv ? vv.width : window.innerWidth;
  const h = vv ? vv.height : window.innerHeight;
  // Reserve right-side strip for the analysis console (current width
  // depends on whether it's expanded or just a tab) so the canvas
  // doesn't render under it.
  const panelW = analysisMinimized ? ANALYSIS_PANEL_W_MIN : ANALYSIS_PANEL_W;
  const w = fullW > panelW * 2 ? fullW - panelW : fullW;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  // Fit world into the canvas area above the phylogeny strip with a
  // uniform scale + center-letterbox. The world's logical dimensions
  // never change -- this only computes how to draw it on screen.
  const availW = w;
  const availH = Math.max(1, h - PHYLO_STRIP_H);
  const sx = availW / WORLD_SIZE.w;
  const sy = availH / WORLD_SIZE.h;
  viewScale = Math.min(sx, sy);
  viewOffsetX = (availW - WORLD_SIZE.w * viewScale) / 2;
  viewOffsetY = (availH - WORLD_SIZE.h * viewScale) / 2;
  positionWorldButtons();
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
  // Genome-stats panel toggle. Hit-test in CSS pixel space against
  // the last-rendered toggle rect.
  const t = gsToggleRect;
  if (cx >= t.x && cx <= t.x + t.w && cy >= t.y && cy <= t.y + t.h) {
    gsMinimized = !gsMinimized;
    return;
  }
  const w = canvasToWorld(cx, cy);
  const best = findCellAt(w.x, w.y);
  if (best >= 0) {
    selectedCellId = best;
    refreshActiveDisasm();
    // Tapping a cell also re-locks the follow-tooltip onto it; on
    // touch devices there's no mousemove to set the initial lock.
    lockedCellId = best;
  } else {
    // Click on empty water clears the tooltip lock so the user can
    // dismiss without waiting for the cell to die.
    lockedCellId = null;
  }
});

// Hover tooltip: a small floating card with the cell's age, ATP, mass,
// biomass, species color, and genome length. Skim cells without losing
// the selected one in the inspector.
const tooltip = document.createElement("div");
tooltip.style.cssText =
  "position:fixed;pointer-events:none;display:none;z-index:9;" +
  "background:rgba(0,0,0,.75);color:#dfe;border:1px solid #356;" +
  "padding:4px 6px;font:10px ui-monospace,SFMono-Regular,Menlo,monospace;" +
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
    `<b>${c.speciesKey.slice(0, 6)}</b> (${c.genome.length}b)\n` +
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
  const availH = Math.max(1, canvasH - PHYLO_STRIP_H);
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
    const minPan = availH - originY - drawH;
    const maxPan = -originY;
    if (viewPanY < minPan) viewPanY = minPan;
    else if (viewPanY > maxPan) viewPanY = maxPan;
  } else {
    viewPanY = (availH - drawH) / 2 - originY;
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

  // Highlight along the surface line.
  ctx.strokeStyle = "rgba(170, 220, 240, 0.45)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, surfaceYAt(snapshot, 0));
  for (let x = SURFACE_VIS_STEP; x <= width; x += SURFACE_VIS_STEP) ctx.lineTo(x, surfaceYAt(snapshot, x));
  ctx.stroke();

  for (const b of SUB_BUCKETS) b.length = 0;
  for (const b of TOXIC_BUCKETS) b.length = 0;
  for (const p of snapshot.particles) {
    const t = Math.min(0.999, Math.max(0, p.z / depth));
    const bucket = Math.floor(t * N_BUCKETS);
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
        ctx.moveTo(p.x + p.r, p.y);
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
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
        ctx.moveTo(p.x + p.r, p.y);
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
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
  drawGenomeStats();
}

// Optional field overlay. Cycles off -> temp -> density via the `H` key.
// Drawn on top of particles + cells but below the phylogeny strip so it
// reads as an atmospheric tint rather than blocking the bodies.
type HeatmapMode = "off" | "temp" | "density";
let heatmapMode: HeatmapMode = "off";
const HEATMAP_CELL = 32;
const HEATMAP_ALPHA = 0.28;
window.addEventListener("keydown", (e) => {
  if (e.key === "h" || e.key === "H") {
    heatmapMode =
      heatmapMode === "off" ? "temp" :
      heatmapMode === "temp" ? "density" : "off";
  } else if (e.key === "p" || e.key === "P") {
    // Profile lives on the worker's world. We can't read it back
    // synchronously, but the snapshot carries world.profile when set,
    // so the dump fires whenever a profile is currently active in the
    // last snapshot.
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
    ctx.font = "10px ui-monospace,SFMono-Regular,Menlo,monospace";
    ctx.fillText("heatmap: temperature (cold blue → warm red, H toggles)", 8, surfaceY + 14);
    return;
  }
  if (heatmapMode === "density") {
  // Density: count particles per heatmap cell.
  const counts = new Uint16Array(cols * rows);
  for (const p of snapshot.particles) {
    const cx = Math.floor(p.x / cell);
    const cy = Math.floor((p.y - surfaceY) / cell);
    if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue;
    counts[cy * cols + cx]++;
  }
  let maxC = 1;
  for (let i = 0; i < counts.length; i++) if (counts[i] > maxC) maxC = counts[i];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const n = counts[r * cols + c];
      if (n === 0) continue;
      ctx.fillStyle = heatColorDensity(n / maxC);
      ctx.fillRect(c * cell, surfaceY + r * cell, cell, cell);
    }
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.font = "10px ui-monospace,SFMono-Regular,Menlo,monospace";
  ctx.fillText(`heatmap: particle density (max ${maxC}/cell, H toggles)`, 8, surfaceY + 14);
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

// Population genome-size histogram in the top-right corner. Bars are
// counts of cells per length bucket; vertical lines mark mean and
// mean ± stddev so you can see at a glance whether genomes are
// bloating, collapsing, or settled.
const GS_PANEL_W = 240;
const GS_PANEL_H_FULL = 110;
const GS_PANEL_H_MIN = 22;
const GS_PANEL_MARGIN = 8;
const GS_BUCKET_BYTES = 4;      // 4 bytes per bucket
const GS_N_BUCKETS = 25;        // covers 0..100 bytes
const GS_BUCKETS = new Int32Array(GS_N_BUCKETS);
const GS_TICK_BYTES = [0, 25, 50, 75, 100]; // x-axis labels
let gsMinimized = true;
// Last-rendered toggle rect, used by the canvas click handler to
// hit-test the minimize/expand button. Updated each frame.
let gsToggleRect = { x: 0, y: 0, w: 0, h: 0 };

function drawGenomeStats(): void {
  const dpr = getDpr();
  const canvasCssW = canvas.width / dpr;
  const panelH = gsMinimized ? GS_PANEL_H_MIN : GS_PANEL_H_FULL;
  const panelX = canvasCssW - GS_PANEL_W - GS_PANEL_MARGIN;
  const panelY = GS_PANEL_MARGIN;
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

  // Panel chrome.
  ctx.fillStyle = "rgba(4,16,24,0.78)";
  ctx.fillRect(panelX, panelY, GS_PANEL_W, panelH);
  ctx.strokeStyle = "#1a3340";
  ctx.lineWidth = 1;
  ctx.strokeRect(panelX + 0.5, panelY + 0.5, GS_PANEL_W - 1, panelH - 1);

  // Minimize/maximize toggle in the top-right of the panel header.
  // Draw the toggle BEFORE the header text so the text can be width-
  // capped to end before the toggle's left edge (otherwise the text
  // grows long enough to draw through the toggle box -- visible as
  // "max=N[+]" overlap).
  const tw = 16, th = 14;
  const tx = panelX + GS_PANEL_W - tw - 4;
  const ty = panelY + 3;
  gsToggleRect = { x: tx, y: ty, w: tw, h: th };
  ctx.strokeStyle = "#9ee";
  ctx.strokeRect(tx + 0.5, ty + 0.5, tw - 1, th - 1);
  ctx.fillStyle = "#9ee";
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "top";
  ctx.textAlign = "center";
  ctx.fillText(gsMinimized ? "+" : "–", tx + tw / 2, ty + 2);
  ctx.textAlign = "left";

  // Header text, truncated to leave room for the toggle.
  const fullHdr = `genome size  n=${n}  µ=${mean.toFixed(1)}  σ=${stddev.toFixed(1)}  max=${maxLen}`;
  const headerBudget = tx - (panelX + 6) - 4;
  let hdr = fullHdr;
  if (ctx.measureText(hdr).width > headerBudget) {
    while (hdr.length > 4 && ctx.measureText(hdr + "…").width > headerBudget) hdr = hdr.slice(0, -1);
    hdr = hdr + "…";
  }
  ctx.fillText(hdr, panelX + 6, panelY + 4);

  if (gsMinimized) return;

  // Plot area: leave room for header (18px) and tick-label band (14px).
  const plotX = panelX + 6;
  const plotY = panelY + 22;
  const plotW = GS_PANEL_W - 12;
  const plotH = panelH - 22 - 18;
  const bucketW = plotW / GS_N_BUCKETS;
  const maxBytes = GS_N_BUCKETS * GS_BUCKET_BYTES;
  const xForByteLen = (L: number) =>
    plotX + Math.min(plotW, Math.max(0, (L / maxBytes) * plotW));

  // Bars.
  ctx.fillStyle = "#5fa9c4";
  for (let i = 0; i < GS_N_BUCKETS; i++) {
    const c = GS_BUCKETS[i];
    if (c === 0) continue;
    const h = (c / maxCount) * plotH;
    ctx.fillRect(plotX + i * bucketW, plotY + (plotH - h), Math.max(1, bucketW - 1), h);
  }

  // Baseline + tick marks with byte-count labels.
  ctx.strokeStyle = "#456773";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plotX, plotY + plotH + 0.5);
  ctx.lineTo(plotX + plotW, plotY + plotH + 0.5);
  ctx.stroke();
  ctx.fillStyle = "#7ab";
  ctx.textAlign = "center";
  for (const b of GS_TICK_BYTES) {
    const x = xForByteLen(b);
    ctx.beginPath();
    ctx.moveTo(x, plotY + plotH);
    ctx.lineTo(x, plotY + plotH + 3);
    ctx.stroke();
    ctx.fillText(String(b), x, plotY + plotH + 5);
  }
  ctx.textAlign = "left";

  // Mean + ±stddev lines.
  if (n > 0) {
    const xMean = xForByteLen(mean);
    ctx.strokeStyle = "#f0c050";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xMean, plotY);
    ctx.lineTo(xMean, plotY + plotH);
    ctx.stroke();
    ctx.strokeStyle = "rgba(240,192,80,0.55)";
    ctx.lineWidth = 1;
    for (const off of [-stddev, stddev]) {
      const x = xForByteLen(mean + off);
      ctx.beginPath();
      ctx.moveTo(x, plotY);
      ctx.lineTo(x, plotY + plotH);
      ctx.stroke();
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
  const stripY = canvasCssH - stripH;
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
  for (const c of snapshot.creatures) {
    // Membrane is the structural reserve in the chemistry-overhaul
    // model (replaces the retired biomass chemical).
    bioByKey.set(c.speciesKey, (bioByKey.get(c.speciesKey) ?? 0) + c.molecules.membrane);
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

  let maxBio = 0;
  for (const sp of visible) {
    const b = bioByKey.get(sp.key) ?? 0;
    if (b > maxBio) maxBio = b;
  }

  // Slot heights: living species scale up to LIVE_H_MAX by biomass relative
  // to the largest extant species; extinct species occupy a thin baseline
  // slot so their lifespan segment stays visible. If the total exceeds the
  // available innerH, scale everything down to fit.
  const LIVE_H_MAX = 7;
  const LIVE_H_MIN = 1.2;
  const EXTINCT_H = 0.6;
  const heights = visible.map((sp) => {
    if (sp.alive <= 0) return EXTINCT_H;
    const frac = maxBio > 0 ? (bioByKey.get(sp.key) ?? 0) / maxBio : 0;
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
  ctx.font = "10px ui-monospace,SFMono-Regular,Menlo,monospace";
  const filterTag = phyloFilterTop5 ? "  [TOP 5 alive, F toggles]" : "  (F: top 5 filter)";
  ctx.fillText(
    `phylogeny  t=${tMin.toFixed(0)}..${tNow.toFixed(0)}s  ${visible.length} species  (height ~ biomass, yellow = convergence)${filterTag}`,
    8,
    stripY + 11,
  );
}

// Every cell wears a thin white outline on its wobbly body. Selected
// cells get a thicker version of the same line so selection reads as
// "the same cell, just emphasized."
function strokeCellOutline(
  cx: number, cy: number, r: number, selected: boolean, t: number, phase: number,
  kin = false,
): void {
  // selected: thick white. kin (same species/lineage as the selected
  // cell): thin white selection border so the family stands out
  // against everyone else's default thin black outline.
  ctx.strokeStyle = selected || kin ? "#ffffff" : "#000000";
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
  // fps + sim/wall ratio + elapsed sim time + pop (species) +
  // extinction count there. pop= shows cells / living species /
  // lineages / post-founder-cull-survivors:
  //   - cells: total live cells.
  //   - species: distinct genomes among currently-alive cells.
  //   - lineages: distinct founding lineages (lineageRoot ids).
  //   - survivors: lineages whose founder has been culled (or
  //     starved/etc) but whose descendants are still alive --
  //     a real measure of "lineages that managed to reproduce".
  // world.species.size would over-count -- it includes extinct
  // species still in the prune grace window.
  const liveLineages = new Set<number>();
  const liveSpecies = new Set<string>();
  for (const c of snapshot.creatures) {
    liveLineages.add(c.lineageRoot);
    liveSpecies.add(c.speciesKey);
  }
  const livingFounderSet = new Set(snapshot.livingFounderLineages ?? []);
  let founderCullSurvivors = 0;
  for (const root of liveLineages) {
    if (!livingFounderSet.has(root)) founderCullSurvivors++;
  }
  hudStats.textContent =
    `fps=${perfFps.toFixed(0)}  sim=${perfSimRate.toFixed(1)}x  ` +
    `t=${formatAge(snapshot.t)}  pop=${snapshot.creatures.length}/${liveSpecies.size}/${liveLineages.size}/${founderCullSurvivors}  ` +
    `extinct=${snapshot.extinctionCount}`;
  hudTimings.textContent =
    `r=${perfRenderMs.toFixed(1)}ms  s=${perfSimMs.toFixed(1)}ms`;
  // If the selected cell has died or been eaten, fall back to the first
  // live creature so the inspector shows something useful instead of
  // silently going blank.
  if (selectedCellId == null || !snapshotCreatureById.has(selectedCellId)) {
    selectedCellId = snapshot.creatures[0]?.id ?? null;
  }
  // Always re-disassemble: the selected cell's genome can change between
  // frames from somatic mutation, so a cached string would go stale.
  refreshActiveDisasm();
  const c = selectedCell();
  if (!c) {
    inspector.textContent = `${statsLine()}\npop=0  particles=${snapshot.particles.length}`;
    return;
  }
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

// Sidebar panel: this run's top 5 species (past and current),
// refreshed every ANALYSIS_INTERVAL_SEC of sim-time.
//
// Sort key (descending):
//   1. Duration (sp.alive>0 ? now - firstSeen : lastSeen - firstSeen)
//   2. Total biomass across living members (0 for extinct)
//   3. Cell count (sp.alive)
//   4. firstSeen ascending (older species win ties)
const ANALYSIS_INTERVAL_SEC = 60;
let lastAnalysisT = -Infinity;

type AnalysisRow = {
  key: string;
  genome: Uint8Array;
  color: string;
  alive: boolean;
  duration: number;
  biomass: number;
  cells: number;
};

// Live species ranked by all-time-peak biomass (the phylogeny render
// keeps peakBiomassByKey updated). Live-only biomass swings wildly on
// fission, so peak is the honest "how big did this lineage ever get".
function computeRankedRows(): AnalysisRow[] {
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
      cells: sp.alive,
    });
  }
  rows.sort((a, b) => {
    if (b.biomass !== a.biomass) return b.biomass - a.biomass;
    if (b.duration !== a.duration) return b.duration - a.duration;
    if (b.cells !== a.cells) return b.cells - a.cells;
    return 0;
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
  persistMarked(HOF_KEY, hallOfFame);
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
  key: string, genome: Uint8Array, color: string,
  rankLabel: string, status: string, statsLine: string, peakBio: number,
): HTMLDivElement {
  const block = document.createElement("div");
  block.style.cssText = "padding:6px 0;border-bottom:1px solid #1a3340;white-space:pre-wrap;line-height:1.4;";
  const dot = `<span style="display:inline-block;width:8px;height:8px;background:${color};border-radius:50%;margin-right:6px;vertical-align:middle;"></span>`;
  const tm = trophicMode(genome);
  const trophicChip =
    `<span style="display:inline-block;padding:1px 5px;border-radius:3px;` +
    `background:${tm.bg};color:${tm.fg};font-size:9px;font-weight:bold;` +
    `margin-right:6px;vertical-align:middle;">${tm.label}</span>`;
  const headDiv = document.createElement("div");
  const star = document.createElement("span");
  const pinned = pinnedSpecies.has(key);
  star.textContent = pinned ? "★" : "☆";
  star.title = pinned ? "unpin (re-enables age cull)" : "pin (protects founders from age cull)";
  star.style.cssText =
    "cursor:pointer;user-select:none;margin-right:6px;vertical-align:middle;" +
    (pinned ? "color:#ffd24c;" : "color:#789;");
  star.addEventListener("click", () => togglePin(key, genome, color, peakBio));
  headDiv.appendChild(star);
  const rest = document.createElement("span");
  rest.innerHTML =
    (rankLabel ? `<b>${rankLabel}</b>  ` : "") +
    `${dot}${trophicChip}` +
    `<b style="font-size:13px;letter-spacing:0.5px;">${genomeTag(genome)}</b>` +
    `<span style="opacity:.7"> (${genome.length}b)</span>  ${status}`;
  headDiv.appendChild(rest);
  const statsDiv = document.createElement("div");
  statsDiv.style.cssText = "opacity:0.85;padding-top:2px;";
  statsDiv.textContent = statsLine;
  // Spawn: drop a fresh instance of exactly this genome into the
  // world. The worker uses local particles if the spawn patch has
  // any, otherwise the fixed molecule seed forces viability anyway.
  const spawnBtn = document.createElement("button");
  spawnBtn.textContent = "Spawn";
  spawnBtn.style.cssText =
    "margin-top:4px;padding:2px 8px;border:1px solid #356;border-radius:3px;" +
    "background:rgba(0,0,0,.4);color:#9ee;cursor:pointer;font-size:10px;";
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
  if (analysisMinimized) return;
  analysisBody.innerHTML = "";
  const header = document.createElement("div");
  header.style.cssText = "padding:6px 0 8px;font-weight:bold;border-bottom:1px solid #1a3340;";
  analysisBody.appendChild(header);

  if (analysisTab === "top") {
    const rows = computeRankedRows().slice(0, 5);
    header.textContent = `Top 5 live at t=${formatAge(snapshot.t)} (${snapshot.species.length} tracked)`;
    rows.forEach((r, i) => {
      const status = r.alive ? "ALIVE" : "EXTINCT";
      const stats = `duration=${formatAge(r.duration)}  peakBio=${r.biomass.toFixed(0)}  cells=${r.cells}`;
      analysisBody.appendChild(buildSpeciesCard(r.key, r.genome, r.color, `#${i + 1}`, status, stats, r.biomass));
    });
    return;
  }

  // Pinned + Notable read from the persisted maps so entries survive
  // extinction / reload; live status is looked up by key when present.
  const src = analysisTab === "pinned" ? pinnedSpecies : hallOfFame;
  const entries = [...src.values()].sort((a, b) => b.peakBio - a.peakBio);
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
      buildSpeciesCard(e.key, Uint8Array.from(e.genome), e.color, "", status, stats, e.peakBio),
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

