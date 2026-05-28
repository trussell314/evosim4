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
  windExposureAt,
  WIND_MAX,
  temperatureAt,
  VENT_BASE_INTENSITY,
  shoalAt,
  solarLight,
  sunXFrac,
  lightOcclusion,
  LIGHT_DECAY,
  magFieldBaseAt,
  takeSnapshot,
  chemName,
  reactionName,
  reactionCatalog,
  chemAmountToParticles,
  NAMED_CHEMICALS,
  NAMED_CHEMICAL_COUNT,
  reactionWindowSeries,
  CHEM_SHORT_LABELS,
  type ReactionInfo,
  genomeTag,
  PARTICLE_TARGET_STEP,
  PARTICLE_TARGET_MIN,
  PARALLEL_MIN_RANGE,
  type RenderSnapshot,
  type ParticleSnapshot,
  type CreatureSnapshot,
  type InnerCreatureSnapshot,
  type SpeciesSnapshot,
  MIN_VIABLE_MEMBRANE,
  MIN_VIABLE_RIBOSOME,
  MIN_VIABLE_AMINOACID,
} from "./sim";
import { disassemble, walkGenome, genomeCodingKey, OP, OPERANDS, CATALYST_COUNT, SYNTH_KIND, SYNTH_KIND_COUNT, emitChannelName } from "./genome";
import { ARCHETYPES } from "./genome-archetypes";
import {
  compileCreature,
  type CreatureSpec, type TrophicMode as DslTrophicMode,
  type SenseChannel, type EmitChannel,
} from "./creature-dsl";
import type { ScenarioSpec, PopulationSpec } from "./scenario-dsl";

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
hudStats.textContent = "pop/engulfed=--  species/engulfed=--  lineages/extinct=--  parts=--";
hudBar.appendChild(hudStats);
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

// Kill the SELECTED cell. Two-tap arm/fire confirm (like reset): first
// click arms a red "confirm kill" for 3s, second click within the window
// kills it. Hidden when nothing is selected; visibility + reset on
// selection change are driven by updateInspector().
const killCellBtn = document.createElement("div");
killCellBtn.style.cssText =
  "display:none;align-items:center;gap:6px;padding:2px 9px 6px;" +
  "cursor:pointer;user-select:none;" + HUD_FONT;
let killArmedUntil = 0;
let killArmedId: number | null = null;
let killTimer: ReturnType<typeof setTimeout> | null = null;
function renderKillBtn(armed: boolean): void {
  killCellBtn.innerHTML = armed
    ? `<span style="color:#ff6b7a;font-weight:bold;">✕ confirm kill</span>`
    : `<span style="color:#e08a93;">✕ kill cell</span>`;
}
function disarmKill(): void {
  killArmedUntil = 0;
  killArmedId = null;
  renderKillBtn(false);
  if (killTimer) { clearTimeout(killTimer); killTimer = null; }
}
killCellBtn.addEventListener("click", () => {
  const sel = selectedCell();
  if (!sel) return;
  const now = performance.now();
  if (now < killArmedUntil && killArmedId === sel.id) {
    simWorker.postMessage({ type: "killCell", id: sel.id });
    disarmKill();
    return;
  }
  killArmedUntil = now + 3000;
  killArmedId = sel.id;
  renderKillBtn(true);
  if (killTimer) clearTimeout(killTimer);
  killTimer = setTimeout(disarmKill, 3000);
});
renderKillBtn(false);

// Human-readable genome summary -- the same prose shown on the
// species cards. Filled by updateInspector when a cell is selected.
const inspectorProse = document.createElement("div");
inspectorProse.style.cssText =
  "padding:6px 9px;color:#bcd;display:none;" + HUD_FONT;

// Health + reproduce-readiness meters, shown at the top of the
// Inspector for the selected cell. Filled by updateInspector.
const inspectorMeters = document.createElement("div");
inspectorMeters.style.cssText = "padding:6px 9px;display:none;" + HUD_FONT;

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
const WORLD_LANDSCAPE = { w: 1600, h: 1200 };
const WORLD_PORTRAIT = { w: 1200, h: 1600 };
const WORLD_SIZE = window.innerWidth >= window.innerHeight ? WORLD_LANDSCAPE : WORLD_PORTRAIT;
const SAVE_KEY = "evosim4:save";
// World-builder stashes a ScenarioSpec here, then reloads; the bootstrap
// consumes it on next load (takes precedence over the saved world).
const PENDING_SCENARIO_KEY = "evosim4:pendingScenario";

// Read whatever's in localStorage (if anything); it's either a gzip-
// compressed blob (current format) or legacy raw JSON. Decompression is
// async, so the actual decode + worker init happens in a bootstrap below.
// The worker schema-checks before applying and silently keeps the fresh
// world on mismatch.
const storedSave = (() => {
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

// Latest serialized save string the worker has posted to us. The export
// button reads this RAW JSON; localStorage instead gets a gzip-compressed
// copy (latestSaveCompressed) so big worlds fit under the ~5MB quota.
// Updated on every "save" message from the worker. Starts null and is
// populated by the load bootstrap below (after decompressing whatever is
// in localStorage) or by the first "save" message, whichever lands first.
let latestSaveJson: string | null = null;
// gzip(latestSaveJson) as a "gz1:"-tagged base64 string, ready to drop
// into localStorage. maybeAutosave() recomputes it (off the render path,
// async) after each save; forceSave() writes this cached blob
// synchronously on pagehide -- it can't await compression during unload.
let latestSaveCompressed: string | null = null;

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

// Saved worlds are stored gzip-compressed (raw JSON outgrows the ~5MB
// localStorage quota on long runs -- gzip buys ~4x). The stored string is
// tagged so the loader can tell compressed blobs from legacy raw-JSON
// saves and from the (rare) uncompressed fallback.
const SAVE_GZIP_PREFIX = "gz1:";
const canCompress = typeof CompressionStream !== "undefined";

function bytesToB64(b: Uint8Array): string {
  // Build the binary string in chunks; spreading the whole array into
  // fromCharCode overflows the call stack past a few hundred KB.
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < b.length; i += CHUNK) {
    s += String.fromCharCode(...b.subarray(i, i + CHUNK));
  }
  return btoa(s);
}
function b64ToBytes(b64: string) {
  const s = atob(b64);
  // Construct from an explicit ArrayBuffer (not SharedArrayBuffer) so the
  // result is a Blob-compatible ArrayBufferView.
  const b = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}
async function gzipToStored(json: string): Promise<string> {
  const cs = new CompressionStream("gzip");
  const buf = await new Response(
    new Blob([json]).stream().pipeThrough(cs),
  ).arrayBuffer();
  return SAVE_GZIP_PREFIX + bytesToB64(new Uint8Array(buf));
}
async function decodeStoredSave(stored: string | null): Promise<string | null> {
  if (!stored) return null;
  if (!stored.startsWith(SAVE_GZIP_PREFIX)) return stored; // legacy raw JSON
  try {
    const ds = new DecompressionStream("gzip");
    const buf = await new Response(
      new Blob([b64ToBytes(stored.slice(SAVE_GZIP_PREFIX.length))]).stream().pipeThrough(ds),
    ).arrayBuffer();
    return new TextDecoder().decode(buf);
  } catch {
    return null; // corrupt blob -> treat as no save
  }
}

async function maybeAutosave(): Promise<void> {
  if (resetting) return;
  const json = latestSaveJson;
  if (!json) return;
  let payload = json;
  if (canCompress) {
    try {
      payload = await gzipToStored(json);
      if (resetting) return; // a reset may have fired during compression
      latestSaveCompressed = payload;
    } catch {
      payload = json; // compression failed -> fall back to raw
    }
  }
  try {
    localStorage.setItem(SAVE_KEY, payload);
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
  // Prefer the cached compressed blob (can't await compression mid-
  // unload); fall back to raw if we haven't compressed one yet.
  const payload = latestSaveCompressed ?? latestSaveJson;
  if (!payload) return;
  try {
    localStorage.setItem(SAVE_KEY, payload);
  } catch { /* quota / private mode -- ignore */ }
}
// Set in hardReset(), checked by every save path. Survives until
// the page actually unloads.
let resetting = false;
// Reset uses a two-tap arm/fire pattern. confirm() turned out to be
// silently suppressed in some iOS in-app webviews (Brave/Edge),
// which made the button look broken. The first tap turns the button
// label into a red "confirm" prompt that times out after
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
  // Coming back from screen-lock / app-switch: mobile browsers
  // frequently do NOT fire resize / visualViewport.resize on resume,
  // so the canvas keeps its stale (pre-background) backing size and
  // the world-fit transform is never recomputed -> clipped canvas +
  // misaligned HUD. Re-measure on resume. Deferred too, because the
  // visual viewport settles a few hundred ms after resume (URL bar
  // animating back) so a single immediate measure can read mid-anim.
  else scheduleResize();
});
window.addEventListener("pagehide", forceSave);
// bfcache restore / app-switch resume can deliver pageshow without a
// resize event; orientationchange's final size also lands a frame
// late on mobile. Both funnel through the same deferred re-measure.
window.addEventListener("pageshow", () => scheduleResize());
window.addEventListener("orientationchange", () => scheduleResize());

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
// Decompress the stored save (if any), then init the worker. Done in an
// async bootstrap because gzip decode can't be synchronous. No other
// main->worker messages are posted before this runs, so FIFO ordering
// (init, then syncPinnedToWorker) is preserved.
void (async () => {
  const savedJson = await decodeStoredSave(storedSave);
  // Seed the export cache so "export" works right after load, unless a
  // fresh "save" message already populated it during the brief decode.
  if (savedJson && latestSaveJson === null) latestSaveJson = savedJson;
  // World-builder: a pending scenario (stashed just before a reload)
  // takes precedence over the saved world. Consume it once.
  let pendingScenario: ScenarioSpec | null = null;
  try {
    const raw = localStorage.getItem(PENDING_SCENARIO_KEY);
    if (raw) { pendingScenario = JSON.parse(raw) as ScenarioSpec; localStorage.removeItem(PENDING_SCENARIO_KEY); }
  } catch { /* ignore malformed */ }
  if (pendingScenario) {
    WORLD_SIZE.w = pendingScenario.width;
    WORLD_SIZE.h = pendingScenario.height;
  }
  // Roll a random non-zero seed so a fresh production world gets varied
  // rocks by default. Loading a save overrides this with the saved
  // geologySeed; scenarios bake their own terrain via buildScenarioWorld.
  let initGeologySeed = 0;
  while (initGeologySeed === 0) initGeologySeed = (Math.random() * 0x100000000) >>> 0;
  simWorker.postMessage({
    type: "init",
    width: WORLD_SIZE.w,
    height: WORLD_SIZE.h,
    savedJson: pendingScenario ? null : savedJson,
    scenario: pendingScenario ?? undefined,
    geologySeed: initGeologySeed,
  });
  // Re-establish cull protection for pinned species. FIFO message
  // order guarantees the worker has built (or restored) its world
  // from the init above before this applies. speciesKey is a
  // deterministic genome hash, so restored species re-match by key.
  syncPinnedToWorker();
})();
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
    // Track the live world dimensions so the view fit adapts to a custom
    // (world-builder) size or a differently-sized loaded save -- the draw
    // path already uses snapshot dims; this keeps the fit transform in sync.
    if (snapshot.width !== WORLD_SIZE.w || snapshot.height !== WORLD_SIZE.h) {
      WORLD_SIZE.w = snapshot.width;
      WORLD_SIZE.h = snapshot.height;
      resize();
    }
    if (snapshot.particleTarget !== particleCap) {
      particleCap = snapshot.particleTarget;
      renderCapLabel();
    }
    if (snapshot.parallelMin !== parallelMinUI) {
      parallelMinUI = snapshot.parallelMin;
      renderParLabel();
    }
    if (snapshot.mutationRateMul !== mutRateUI) {
      mutRateUI = snapshot.mutationRateMul;
      renderMutLabel();
    }
    if (snapshot.geologySeed !== lastBuiltGeologySeed) {
      // Geology changed (loaded save, or the user clicked "adjust geology"
      // and the worker reran perturbation). Drop the cached terrain
      // bitmap so the next render rebuilds it from the new obstacles.
      lastBuiltGeologySeed = snapshot.geologySeed;
      terrainBitmap = null;
    }
    syncFoundersBtn(snapshot.foundersEnabled !== false);
    syncFounderMode(snapshot.founderCapEnabled !== false, snapshot.founderTarget ?? founderCapValue);
    syncSeedingBtn(snapshot.ongoingSeeding === true);
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
    void maybeAutosave();
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
  } else if (msg.type === "diag") {
    // Response to a stall-triggered requestDiag: surface worker liveness +
    // pool state in the diag bar so an intermittent SIM STALLED can be
    // pinpointed (vs. just "stalled").
    stallDiag = `worker: running=${msg.running} world=${msg.hasWorld} t=${msg.t.toFixed(0)} | ${msg.pool}`;
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
// Per-frame render caches (perf). The HUD distinct-genome counts walk
// genomeCodingKey over every creature; recompute at most a few times a
// second rather than every frame. The inspector disasm + gene-aware
// description are O(genome) string builds; rebuild them only when the
// selected cell's genome actually changes (id + exact speciesKey), not
// every frame.
let lastHudCountT = -1e9;
let cachedSpeciesCount = 0;
let cachedCodingCount = 0;
const HUD_COUNT_INTERVAL_MS = 333;
let lastInspectedGenomeVer = "";
let inspectorProseCache = "";
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
// Master visibility switch for the phylogeny strip (and its legend
// text line). Hidden for now: when false the strip isn't drawn and
// its vertical band is reclaimed so the world extends to the controls
// bar (see bottomReserveH / drawPhylogeny).
const PHYLO_VISIBLE = false;
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
  // z-index above the top HUD / bottom control bar (both z-index:10)
  // so this slideout draws over them, not under.
  "overflow:hidden;padding:0;box-sizing:border-box;z-index:20;";
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
// Order: pin control, the two meters (health + reproduce), the
// gene-aware genome description, then the resource/stats block, then
// the collapsible genome disassembly.
inspectorPane.appendChild(pinSpeciesBtn);
inspectorPane.appendChild(killCellBtn);
inspectorPane.appendChild(inspectorMeters);
inspectorPane.appendChild(inspectorProse);
inspectorPane.appendChild(inspector);
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
  // z-index above the top HUD / bottom control bar (both z-index:10)
  // so this slideout draws over them, not under.
  "overflow:hidden;padding:0;box-sizing:border-box;z-index:20;";
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
type ChemTab = "ledger" | "detail" | "reactions";
let chemTab: ChemTab = "ledger";
const chemTabs = document.createElement("div");
chemTabs.style.cssText =
  "display:none;flex-wrap:wrap;border-bottom:1px solid #1a3340;";
const CHEM_TAB_DEFS: { id: ChemTab; label: string }[] = [
  { id: "ledger", label: "Ledger" },
  { id: "detail", label: "Detail" },
  { id: "reactions", label: "Reactions" },
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

// Reactions pane: filterable table of every tracked reaction.
const reactionsPane = document.createElement("div");
reactionsPane.style.cssText =
  "padding:8px 10px;overflow:auto;display:none;max-height:calc(100vh - 72px);";
const rxnControls = document.createElement("div");
rxnControls.style.cssText =
  "display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;margin-bottom:8px;";
const rxnNonzero = document.createElement("input");
rxnNonzero.type = "checkbox";
rxnNonzero.checked = true; // default: only reactions that have occurred
rxnNonzero.id = "rxnNonzero";
const rxnNonzeroLabel = document.createElement("label");
rxnNonzeroLabel.htmlFor = "rxnNonzero";
rxnNonzeroLabel.textContent = " nonzero counts only";
rxnNonzeroLabel.style.cssText = `color:#9ee;font:${UI_FONT_PX}px ${UI_FONT_FAMILY};cursor:pointer;`;
const rxnNonzeroWrap = document.createElement("span");
rxnNonzeroWrap.style.cssText = "display:inline-flex;align-items:center;";
rxnNonzeroWrap.append(rxnNonzero, rxnNonzeroLabel);
const rxnSearch = document.createElement("input");
rxnSearch.type = "text";
rxnSearch.placeholder = "search reactions…";
rxnSearch.style.cssText =
  "flex:1;min-width:120px;box-sizing:border-box;padding:4px 6px;" +
  "background:rgba(0,0,0,.4);border:1px solid #1a3340;border-radius:4px;" +
  `color:#9ee;font:${UI_FONT_PX}px ${UI_FONT_FAMILY};`;
rxnControls.append(rxnNonzeroWrap, rxnSearch);
const rxnTable = document.createElement("table");
rxnTable.style.cssText =
  "border-collapse:collapse;width:100%;font-size:" + UI_FONT_PX + "px;";
reactionsPane.appendChild(rxnControls);
reactionsPane.appendChild(rxnTable);
rxnNonzero.addEventListener("change", () => renderReactions());
rxnSearch.addEventListener("input", () => renderReactions());

const leftBody = document.createElement("div");
leftBody.style.cssText = "display:none;";
leftBody.appendChild(chemTabs);
leftBody.appendChild(ledgerPane);
leftBody.appendChild(detailPane);
leftBody.appendChild(reactionsPane);
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
  reactionsPane.style.display = open && chemTab === "reactions" ? "" : "none";
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
    else if (chemTab === "reactions") renderReactions();
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

function renderReactions(): void {
  if (!RXN_CATALOG) RXN_CATALOG = reactionCatalog();
  const cat = RXN_CATALOG;
  const totals = snapshot.reactionTotals;
  const cnt = (id: number): number => (totals ? (totals[id] ?? 0) : 0);

  // Newest window t0 in which each reaction fired (for "last seen").
  const hist = snapshot.rxnStatsHistory;
  const lastT0 = new Float64Array(cat.length + 280).fill(-1);
  if (hist) {
    for (const w of reactionWindowSeries(hist)) {
      for (let id = 0; id < w.counts.length && id < lastT0.length; id++) {
        if (w.counts[id] > 0) lastT0[id] = w.t0; // later windows overwrite
      }
    }
  }
  const tNow = snapshot.t;
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const termStr = (terms: { chem: number; coef: number }[]): string => {
    if (terms.length === 0) return "∅";
    return terms.map((t) => {
      const c = Math.round(t.coef * 100) / 100;
      const nm = t.chem < CHEM_SHORT_LABELS.length ? CHEM_SHORT_LABELS[t.chem] : `c${t.chem}`;
      return (c === 1 ? "" : c + " ") + nm;
    }).join(" + ");
  };
  const ago = (id: number): string => {
    const t0 = lastT0[id];
    if (t0 < 0 || cnt(id) === 0) return "—";
    const a = Math.max(0, tNow - t0);
    if (a < 90) return `~${Math.round(a)}s`;
    if (a < 3600) return `~${Math.round(a / 60)}m`;
    const h = Math.floor(a / 3600);
    return `~${h}h${Math.round((a - h * 3600) / 60)}m`;
  };

  const onlyNonzero = rxnNonzero.checked;
  const q = rxnSearch.value.trim().toLowerCase();
  type Row = { r: ReactionInfo; cons: string; prod: string; n: number };
  const rows: Row[] = [];
  for (const r of cat) {
    const n = cnt(r.id);
    const isGeneric = r.label.startsWith("gen#");
    // Scope: named + synthetic always; generics only if ever fired.
    if (isGeneric && n === 0) continue;
    if (onlyNonzero && n === 0) continue;
    const cons = termStr(r.consumes);
    const prod = termStr(r.produces);
    if (q && !(`${r.label} ${cons} ${prod}`.toLowerCase().includes(q))) continue;
    rows.push({ r, cons, prod, n });
  }
  rows.sort((a, b) => (b.n - a.n) || (a.r.id - b.r.id));

  const dE = (v: number): string =>
    v === 0 ? "0" : (v > 0 ? "+" : "") + (Math.round(v * 10) / 10);
  const head =
    `<tr style="text-align:left;border-bottom:1px solid #1a3340;color:#7fb8c8;">` +
    `<th style="padding:2px 6px 4px 0;">Reactants</th>` +
    `<th style="padding:2px 6px 4px 0;">Products</th>` +
    `<th style="padding:2px 6px 4px 0;text-align:right;">ΔATP</th>` +
    `<th style="padding:2px 6px 4px 0;text-align:right;">Times</th>` +
    `<th style="padding:2px 0 4px 0;text-align:right;">Last</th></tr>`;
  const body = rows.length === 0
    ? `<tr><td colspan="5" style="opacity:0.6;padding:6px 0;">no reactions match</td></tr>`
    : rows.map((x) => {
      const eColor = x.r.atpDelta > 0 ? "#9efba8" : x.r.atpDelta < 0 ? "#f7b39a" : "#9ee";
      return `<tr style="border-bottom:1px solid rgba(26,51,64,0.4);">` +
        `<td style="padding:2px 6px 2px 0;overflow-wrap:anywhere;">${esc(x.cons)}</td>` +
        `<td style="padding:2px 6px 2px 0;overflow-wrap:anywhere;">${esc(x.prod)}</td>` +
        `<td style="padding:2px 6px 2px 0;text-align:right;color:${eColor};white-space:nowrap;">${dE(x.r.atpDelta)}</td>` +
        `<td style="padding:2px 6px 2px 0;text-align:right;white-space:nowrap;">${x.n.toLocaleString()}</td>` +
        `<td style="padding:2px 0 2px 0;text-align:right;white-space:nowrap;opacity:0.8;">${ago(x.r.id)}</td></tr>`;
    }).join("");
  rxnTable.innerHTML = head + body;
}

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
  else if (chemTab === "reactions") renderReactions();
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
let controlsBarH = 0;         // measured each layout (0 when hidden)
let bottomHudH = 0;           // measured each layout (bottom status strip)
let overlayPanelH = 0;        // measured each layout (overlay panel)
let archPanelH = 0;           // measured each layout (archetypes panel)
let toggleBarH = 36;          // measured each layout (always-visible row)
// Measured height of the fixed top status strip. The world fit
// reserves it at the top (mirroring controlsBarH at the bottom) so
// the world is never drawn behind the HUD -- the bar sits in its own
// band, outside the world drawing area.
let hudBarH = 0;
function topReserveH(): number { return hudBarH; }
let controlsCollapsed = true;
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
const SELECT_CSS =
  "padding:3px 6px;border:1px solid #1a3340;border-radius:4px;" +
  "background:rgba(0,0,0,.5);color:#9ee;cursor:pointer;" + HUD_FONT;

const ctrlBar = document.createElement("div");
ctrlBar.style.cssText =
  "position:fixed;z-index:10;bottom:0;display:flex;flex-wrap:wrap;" +
  "align-items:center;gap:6px 10px;padding:5px 8px;box-sizing:border-box;" +
  "color:#9ee;background:rgba(2,12,18,0.96);border-top:1px solid #1a3340;" +
  HUD_FONT;
root.appendChild(ctrlBar);

// One-line status strip docked between the world canvas and the
// controls bar. Holds the timing/clock/build readouts moved off the
// top HUD (which now carries only population counts). Positioned and
// height-measured in positionWorldButtons(); its height is reserved
// out of the world fit via bottomReserveH() so it never overlaps the
// canvas. white-space:nowrap keeps it a single line; it sits above
// ctrlBar at bottom = controlsBarH.
const bottomHud = document.createElement("div");
bottomHud.style.cssText =
  "position:fixed;z-index:10;display:flex;align-items:center;gap:16px;" +
  "padding:4px 8px;box-sizing:border-box;white-space:nowrap;overflow:hidden;" +
  "text-overflow:ellipsis;color:#9ee;background:rgba(2,12,18,0.96);" +
  "border-top:1px solid #1a3340;" + HUD_FONT;
bottomHud.textContent = "t=0s  fps=--  sim=--x  r=--ms  s=--ms  build=--";
root.appendChild(bottomHud);

// Single shared toggle row, always visible, anchored at the very
// bottom (it took ctrlBar's old bottom:0 slot). Three buttons --
// overlay / archetypes / controls, in that order -- show/hide the
// stacked panels above them. Arrow points UP when the section is
// hidden, DOWN when it's visible.
const toggleBar = document.createElement("div");
toggleBar.style.cssText =
  "position:fixed;z-index:12;bottom:0;display:flex;flex-wrap:wrap;" +
  "align-items:center;gap:6px;padding:5px 8px;box-sizing:border-box;" +
  "color:#9ee;background:rgba(2,12,18,0.96);border-top:1px solid #1a3340;" +
  HUD_FONT;
root.appendChild(toggleBar);
function panelArrow(hidden: boolean): string { return hidden ? "▲" : "▼"; }
const overlayToggleBtn = mkBtn("overlay ▲", "Show/hide the overlay panel");
const archToggleBtn = mkBtn("archetypes ▲", "Show/hide the archetypes panel");
const controlsToggleBtn = mkBtn("controls ▲", "Show/hide the controls panel");
toggleBar.append(overlayToggleBtn, archToggleBtn, controlsToggleBtn);

const ctrlGroupsWrap = document.createElement("div");
ctrlGroupsWrap.style.cssText =
  "display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;" +
  "flex:1 1 auto;min-width:0;max-width:100%;";
function renderCtrlCollapsed(): void {
  controlsToggleBtn.textContent = `controls ${panelArrow(controlsCollapsed)}`;
  setBtn(controlsToggleBtn, !controlsCollapsed, T_TEAL);
  ctrlBar.style.display = controlsCollapsed ? "none" : "flex";
}
controlsToggleBtn.addEventListener("click", () => {
  controlsCollapsed = !controlsCollapsed;
  renderCtrlCollapsed();
  positionWorldButtons();
  resize();
});
ctrlBar.append(ctrlGroupsWrap);

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

// Overlay controls live in their own collapsible panel docked at the
// bottom-right (separate from the main controls bar, and hidden by
// default -- just a "▸ overlay" tab until expanded). Mirrors the
// ctrlBar collapse pattern. Right edge tracks the right slide-out via
// positionWorldButtons(); z-index sits above ctrlBar.
let overlayCollapsed = true;
const overlayPanel = document.createElement("div");
overlayPanel.style.cssText =
  "position:fixed;z-index:11;bottom:0;display:flex;flex-direction:column;" +
  "align-items:flex-start;gap:6px;padding:5px 8px;box-sizing:border-box;" +
  "color:#9ee;background:rgba(2,12,18,0.96);border-top:1px solid #1a3340;" +
  HUD_FONT;
const overlayWrap = document.createElement("div");
overlayWrap.style.cssText =
  "display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-start;" +
  "gap:6px 10px;max-width:100%;";
function renderOverlayCollapsed(): void {
  overlayToggleBtn.textContent = `overlay ${panelArrow(overlayCollapsed)}`;
  setBtn(overlayToggleBtn, !overlayCollapsed, T_TEAL);
  overlayPanel.style.display = overlayCollapsed ? "none" : "flex";
}
overlayToggleBtn.addEventListener("click", () => {
  overlayCollapsed = !overlayCollapsed;
  renderOverlayCollapsed();
  // Toggling changes the panel's height; the stack above it and the
  // world fit reserve the whole run, so re-measure + re-fit.
  positionWorldButtons();
  resize();
});
overlayPanel.append(overlayWrap);
root.appendChild(overlayPanel);

// Archetypes panel: a collapsible, bottom-left tab (mirrors the
// overlay panel, left-anchored) holding one spawn button per
// GENOME_ARCHETYPES founder. Substrate stance: these are *seeds*, not
// engine rules -- clicking injects one cell of an authored genome via
// the existing spawnSpecies path; it gets no special treatment and
// must survive selection on its own. Hidden by default (toggled from
// the shared bottom button row).
let archCollapsed = true;
const archPanel = document.createElement("div");
archPanel.style.cssText =
  "position:fixed;z-index:11;bottom:0;display:flex;flex-direction:column;" +
  "align-items:flex-start;gap:6px;padding:5px 8px;box-sizing:border-box;" +
  "color:#9ee;background:rgba(2,12,18,0.96);border-top:1px solid #1a3340;" +
  HUD_FONT;
const archWrap = document.createElement("div");
archWrap.style.cssText =
  "display:flex;flex-wrap:wrap;align-items:flex-start;gap:6px 12px;" +
  "max-width:100%;";
function renderArchCollapsed(): void {
  archToggleBtn.textContent = `archetypes ${panelArrow(archCollapsed)}`;
  setBtn(archToggleBtn, !archCollapsed, T_TEAL);
  archPanel.style.display = archCollapsed ? "none" : "flex";
}
archToggleBtn.addEventListener("click", () => {
  archCollapsed = !archCollapsed;
  renderArchCollapsed();
  // Toggling changes the panel height; the world fit reserves the
  // whole bottom stack, so re-measure + re-fit.
  positionWorldButtons();
  resize();
});
function mkArchGroup(name: string): HTMLDivElement {
  const g = document.createElement("div");
  g.style.cssText =
    "display:flex;flex-wrap:wrap;align-items:center;gap:6px;" +
    "min-width:0;max-width:100%;";
  const lab = document.createElement("span");
  lab.textContent = name;
  lab.style.cssText =
    "opacity:0.55;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;";
  g.appendChild(lab);
  archWrap.appendChild(g);
  return g;
}
// Spawn-count selector: a clicked archetype injects this many cells
// (each its own ordinary lineage via spawnSpecies). Default 1.
let archSpawnCount = 1;
const ARCH_COUNTS = [1, 5, 25, 100] as const;
const gArchCount = mkArchGroup("count");
const archCountBtns: HTMLButtonElement[] = [];
function renderArchCount(): void {
  for (let i = 0; i < ARCH_COUNTS.length; i++) {
    setBtn(archCountBtns[i], ARCH_COUNTS[i] === archSpawnCount, T_TEAL);
  }
}
for (const n of ARCH_COUNTS) {
  const cb = mkBtn(String(n), `Spawn ${n} cell${n === 1 ? "" : "s"} per archetype click`);
  cb.addEventListener("click", () => {
    archSpawnCount = n;
    renderArchCount();
  });
  archCountBtns.push(cb);
  gArchCount.appendChild(cb);
}
renderArchCount();

// Placement: scatter = legacy random spread; clump = a tight cluster
// in the top 25% of the world (all cells land together).
let archPlacement: "scatter" | "clump" = "scatter";
const ARCH_PLACEMENTS = ["scatter", "clump"] as const;
const gArchPlace = mkArchGroup("placement");
const archPlaceBtns: HTMLButtonElement[] = [];
function renderArchPlace(): void {
  for (let i = 0; i < ARCH_PLACEMENTS.length; i++) {
    setBtn(archPlaceBtns[i], ARCH_PLACEMENTS[i] === archPlacement, T_TEAL);
  }
}
for (const p of ARCH_PLACEMENTS) {
  const pb = mkBtn(
    p,
    p === "scatter"
      ? "Spread spawns randomly over the world"
      : "Spawn a tight cluster near the surface (top 25%)",
  );
  pb.addEventListener("click", () => {
    archPlacement = p;
    renderArchPlace();
  });
  archPlaceBtns.push(pb);
  gArchPlace.appendChild(pb);
}
renderArchPlace();

const gArchDirect = mkArchGroup("direct");
const gArchSeed = mkArchGroup("seed");
for (const a of ARCHETYPES) {
  if (a.uiHidden) continue; // retained for scenarios/tests, not user-spawnable
  const b = mkBtn(a.label, a.desc);
  b.addEventListener("click", () => {
    if (a.symbiont) {
      // Composite: host genome + a pre-engulfed symbiont.
      simWorker.postMessage({
        type: "spawnComposite",
        genome: Array.from(a.genome),
        symbiont: Array.from(a.symbiont),
        count: archSpawnCount,
        placement: archPlacement,
      });
    } else {
      simWorker.postMessage({
        type: "spawnSpecies",
        genome: Array.from(a.genome),
        count: archSpawnCount,
        placement: archPlacement,
      });
    }
    const prev = a.label;
    b.textContent = `spawned ${archSpawnCount} ✓`;
    setBtn(b, true, T_GREEN);
    setTimeout(() => {
      b.textContent = prev;
      setBtn(b, false, T_GREEN);
    }, 1100);
  });
  (a.cls === "seed" ? gArchSeed : gArchDirect).appendChild(b);
}
renderArchCollapsed();
archPanel.append(archWrap);
root.appendChild(archPanel);

// ---- modal helper (cell-builder / world-builder dialogs) -----------
interface Modal { overlay: HTMLDivElement; body: HTMLDivElement; open: () => void; close: () => void; }
function makeModal(title: string): Modal {
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:10000;display:none;align-items:center;" +
    "justify-content:center;background:rgba(0,0,0,0.55);" + HUD_FONT;
  const panel = document.createElement("div");
  panel.style.cssText =
    "max-width:min(560px,92vw);max-height:88vh;overflow:auto;box-sizing:border-box;" +
    "padding:14px 16px;border:1px solid #2a4a5a;border-radius:8px;" +
    "background:rgba(4,16,22,0.98);color:#9ee;box-shadow:0 8px 40px rgba(0,0,0,.6);";
  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;";
  const h = document.createElement("div");
  h.textContent = title;
  h.style.cssText = `font-size:${UI_FONT_PX + 3}px;color:#cff;`;
  const x = mkBtn("✕", "Close");
  const body = document.createElement("div");
  const close = () => { overlay.style.display = "none"; };
  const open = () => { overlay.style.display = "flex"; };
  x.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  head.append(h, x);
  panel.append(head, body);
  overlay.append(panel);
  root.appendChild(overlay);
  return { overlay, body, open, close };
}
// Form-row helpers shared by both builders.
function fieldRow(label: string, control: HTMLElement): HTMLDivElement {
  const row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:center;gap:8px;margin:5px 0;";
  const l = document.createElement("label");
  l.textContent = label; l.style.cssText = "min-width:120px;color:#9ee;";
  row.append(l, control);
  return row;
}
function checkGroup(items: string[], cols = 4): { wrap: HTMLDivElement; get: () => string[]; boxes: Map<string, HTMLInputElement> } {
  const wrap = document.createElement("div");
  wrap.style.cssText = `display:grid;grid-template-columns:repeat(${cols},auto);gap:2px 12px;`;
  const boxes = new Map<string, HTMLInputElement>();
  for (const it of items) {
    const l = document.createElement("label");
    l.style.cssText = "display:flex;align-items:center;gap:3px;cursor:pointer;white-space:nowrap;";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.style.cursor = "pointer";
    boxes.set(it, cb);
    l.append(cb, document.createTextNode(it));
    wrap.appendChild(l);
  }
  return { wrap, boxes, get: () => [...boxes].filter(([, c]) => c.checked).map(([k]) => k) };
}

// ---- cell-builder dialog -------------------------------------------
{
  const modal = makeModal("Build a cell");
  const b = modal.body;

  const nameI = document.createElement("input");
  nameI.type = "text"; nameI.value = "custom"; nameI.maxLength = 40;
  nameI.style.cssText = SELECT_CSS + "min-width:160px;";

  const trophicSel = document.createElement("select");
  trophicSel.style.cssText = SELECT_CSS;
  for (const t of ["photoautotroph", "heterotroph", "chemolithoautotroph"]) {
    const o = document.createElement("option"); o.value = t; o.textContent = t; trophicSel.appendChild(o);
  }

  const VECTOR = ["light", "electric", "vibration", "magnetic", "mechanical"];
  const SCALAR = ["ph", "thermal"];
  const senses = checkGroup([...VECTOR, ...SCALAR], 4);
  // per-vector-sense seek/flee response selects (shown inline after the box)
  const respSel = new Map<string, HTMLSelectElement>();
  for (const v of VECTOR) {
    const sel = document.createElement("select");
    sel.style.cssText = SELECT_CSS + "margin-left:2px;font-size:" + (UI_FONT_PX - 1) + "px;";
    for (const r of ["seek", "flee"]) { const o = document.createElement("option"); o.value = r; o.textContent = r; sel.appendChild(o); }
    respSel.set(v, sel);
    senses.boxes.get(v)!.parentElement!.appendChild(sel);
  }

  const behaviors = checkGroup(["seekFood", "fleeWaste", "predator", "leakGlucose", "stressTolerant"], 3);
  const emits = checkGroup(["electric", "light", "vibration", "magnetic"], 4);

  const reproI = document.createElement("input");
  reproI.type = "number"; reproI.value = "40"; reproI.min = "5"; reproI.max = "120";
  reproI.style.cssText = SELECT_CSS + "width:70px;";
  const bondI = document.createElement("input");
  bondI.type = "number"; bondI.placeholder = "none"; bondI.min = "0"; bondI.max = "255";
  bondI.style.cssText = SELECT_CSS + "width:70px;";

  const status = document.createElement("div");
  status.style.cssText = "margin-top:8px;color:#8cc;min-height:1.3em;";

  const countSel = document.createElement("select");
  countSel.style.cssText = SELECT_CSS;
  for (const n of [1, 5, 10, 25]) { const o = document.createElement("option"); o.value = String(n); o.textContent = "×" + n; countSel.appendChild(o); }
  const placeSel = document.createElement("select");
  placeSel.style.cssText = SELECT_CSS;
  for (const p of ["scatter", "clump"]) { const o = document.createElement("option"); o.value = p; o.textContent = p; placeSel.appendChild(o); }

  function readSpec(): CreatureSpec {
    const chosen = senses.get().slice(0, 3);
    const bondRaw = bondI.value.trim();
    return {
      name: nameI.value.trim() || "custom",
      trophic: trophicSel.value as DslTrophicMode,
      senses: chosen.map((ch) => ({
        channel: ch as SenseChannel,
        response: respSel.has(ch) ? (respSel.get(ch)!.value as "seek" | "flee") : undefined,
      })),
      seekFood: behaviors.boxes.get("seekFood")!.checked,
      fleeWaste: behaviors.boxes.get("fleeWaste")!.checked,
      predator: behaviors.boxes.get("predator")!.checked,
      leakGlucose: behaviors.boxes.get("leakGlucose")!.checked,
      stressTolerant: behaviors.boxes.get("stressTolerant")!.checked,
      emit: emits.get() as EmitChannel[],
      reproduceAt: Math.max(5, Math.min(120, Number(reproI.value) || 40)),
      bondTag: bondRaw === "" ? undefined : Math.max(0, Math.min(255, Number(bondRaw) | 0)),
    };
  }
  function refresh(): void {
    try {
      const { genome } = compileCreature(readSpec());
      const n = senses.get().length;
      status.style.color = "#8cc";
      status.textContent = `genome: ${genome.length} bytes` + (n > 3 ? `  (only first 3 of ${n} senses used)` : "");
    } catch (err) {
      status.style.color = "#fdd";
      status.textContent = "compile error: " + (err instanceof Error ? err.message : String(err));
    }
  }
  for (const el of [nameI, trophicSel, reproI, bondI, ...respSel.values()]) el.addEventListener("change", refresh);
  for (const m of [senses, behaviors, emits]) for (const cb of m.boxes.values()) cb.addEventListener("change", refresh);

  const spawnBtn = mkBtn("spawn", "Compile + spawn this cell");
  setBtn(spawnBtn, false, T_GREEN);
  spawnBtn.addEventListener("click", () => {
    try {
      const { genome } = compileCreature(readSpec());
      simWorker.postMessage({
        type: "spawnSpecies",
        genome: Array.from(genome),
        count: Number(countSel.value) || 1,
        placement: placeSel.value as "scatter" | "clump",
      });
      status.style.color = "#9efba8";
      status.textContent = `spawned ×${countSel.value} ✓`;
    } catch (err) {
      status.style.color = "#fdd";
      status.textContent = "compile error: " + (err instanceof Error ? err.message : String(err));
    }
  });

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:10px;";
  actions.append(countSel, placeSel, spawnBtn);

  b.append(
    fieldRow("name", nameI),
    fieldRow("trophic mode", trophicSel),
    fieldRow("senses (max 3)", senses.wrap),
    fieldRow("behaviors", behaviors.wrap),
    fieldRow("emit (ATP cost)", emits.wrap),
    fieldRow("reproduce at", reproI),
    fieldRow("bond tag (0-255)", bondI),
    status,
    actions,
  );
  refresh();

  const openBtn = mkBtn("✚ build cell", "Open the cell-builder: design a genome from senses + behaviours");
  setBtn(openBtn, false, T_TEAL);
  openBtn.addEventListener("click", () => { modal.open(); refresh(); });
  archWrap.appendChild(openBtn);
}

// ---- world-builder dialog ------------------------------------------
{
  const modal = makeModal("Build a world");
  const b = modal.body;

  const numI = (val: number, min: number, max: number): HTMLInputElement => {
    const el = document.createElement("input");
    el.type = "number"; el.value = String(val); el.min = String(min); el.max = String(max);
    el.style.cssText = SELECT_CSS + "width:90px;";
    return el;
  };
  const widthI = numI(WORLD_SIZE.w, 300, 4000);
  const heightI = numI(WORLD_SIZE.h, 300, 4000);
  const dayI = numI(600, 10, 100000);
  const windI = numI(0, -60, 60);
  const capI = numI(5000, 0, 50000);
  const foundersCb = document.createElement("input");
  foundersCb.type = "checkbox"; foundersCb.checked = true; foundersCb.style.cursor = "pointer";

  // Seeded populations: archetype + count + placement, added to a list.
  const popArche = document.createElement("select");
  popArche.style.cssText = SELECT_CSS + "max-width:18ch;";
  for (const a of ARCHETYPES) {
    if (a.uiHidden) continue;
    const o = document.createElement("option"); o.value = a.id; o.textContent = a.label; popArche.appendChild(o);
  }
  const popCount = numI(10, 1, 500); popCount.style.cssText = SELECT_CSS + "width:70px;";
  const popPlace = document.createElement("select");
  popPlace.style.cssText = SELECT_CSS;
  for (const p of ["scatter", "clump"]) { const o = document.createElement("option"); o.value = p; o.textContent = p; popPlace.appendChild(o); }
  const addPopBtn = mkBtn("+ add", "Add this population to the world");
  setBtn(addPopBtn, false, T_TEAL);

  const pops: PopulationSpec[] = [];
  const popList = document.createElement("div");
  popList.style.cssText = "margin:4px 0;display:flex;flex-direction:column;gap:2px;";
  function renderPops(): void {
    popList.textContent = "";
    if (pops.length === 0) {
      const e = document.createElement("div"); e.textContent = "(no seeded populations -- founders only)";
      e.style.cssText = "color:#789;"; popList.appendChild(e); return;
    }
    pops.forEach((p, i) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:8px;";
      const t = document.createElement("span");
      t.textContent = `${p.archetype} ×${p.count} (${p.placement})`;
      const rm = mkBtn("✕", "Remove"); rm.style.cssText = CBTN + "padding:0 6px;";
      rm.addEventListener("click", () => { pops.splice(i, 1); renderPops(); });
      row.append(t, rm); popList.appendChild(row);
    });
  }
  renderPops();
  addPopBtn.addEventListener("click", () => {
    pops.push({ archetype: popArche.value, count: Math.max(1, Number(popCount.value) | 0), placement: popPlace.value as "scatter" | "clump" });
    renderPops();
  });

  const status = document.createElement("div");
  status.style.cssText = "margin-top:8px;color:#8cc;min-height:1.3em;";

  function readSpec(): ScenarioSpec {
    return {
      width: Math.max(300, Math.min(4000, Number(widthI.value) | 0)),
      height: Math.max(300, Math.min(4000, Number(heightI.value) | 0)),
      dayPeriod: Math.max(10, Number(dayI.value) || 600),
      wind: Number(windI.value) || 0,
      foundersEnabled: foundersCb.checked,
      particleCap: Math.max(0, Number(capI.value) | 0),
      populations: pops.slice(),
    };
  }

  let armed = false; let armTimer: ReturnType<typeof setTimeout> | null = null;
  const createBtn = mkBtn("create world", "Replace the current world (reloads the page)");
  setBtn(createBtn, false, T_GREEN);
  function disarm(): void { armed = false; createBtn.textContent = "create world"; setBtn(createBtn, false, T_GREEN); if (armTimer) clearTimeout(armTimer); }
  createBtn.addEventListener("click", () => {
    if (!armed) {
      armed = true; createBtn.textContent = "confirm: replaces world"; setBtn(createBtn, true, T_RED);
      status.style.color = "#fda"; status.textContent = "This discards the current world. Click again to confirm.";
      armTimer = setTimeout(disarm, 4000);
      return;
    }
    try {
      const spec = readSpec();
      localStorage.setItem(PENDING_SCENARIO_KEY, JSON.stringify(spec));
      resetting = true;              // suppress the autosave-on-unload of the old world
      try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
      location.reload();
    } catch (err) {
      status.style.color = "#fdd"; status.textContent = "error: " + (err instanceof Error ? err.message : String(err));
    }
  });

  const dims = document.createElement("div");
  dims.style.cssText = "display:flex;align-items:center;gap:6px;";
  dims.append(widthI, document.createTextNode("×"), heightI);
  const foundLbl = document.createElement("label");
  foundLbl.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer;";
  foundLbl.append(foundersCb, document.createTextNode("random founders"));
  const popAdder = document.createElement("div");
  popAdder.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;";
  popAdder.append(popArche, popCount, popPlace, addPopBtn);

  b.append(
    fieldRow("dimensions", dims),
    fieldRow("day length (s)", dayI),
    fieldRow("wind / current", windI),
    fieldRow("particle cap", capI),
    fieldRow("founders", foundLbl),
    fieldRow("add population", popAdder),
    popList,
    status,
    createBtn,
  );

  const openBtn = mkBtn("✚ build world", "Open the world-builder: size, environment, and seeded populations");
  setBtn(openBtn, false, T_TEAL);
  openBtn.addEventListener("click", () => { disarm(); status.textContent = ""; modal.open(); });
  archWrap.appendChild(openBtn);
}

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
  resetBtn.textContent = "confirm";
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
  updateFounderModeEnabled();
});
function syncFoundersBtn(on: boolean): void {
  if (on !== foundersOn) {
    foundersOn = on;
    foundersBtn.textContent = foundersOn ? "founders on" : "founders off";
    setBtn(foundersBtn, foundersOn, T_GREEN);
  }
  updateFounderModeEnabled();
}

// Founder cap mode (mutex, only meaningful while founders are on).
// "cap N" tops the world up to N distinct founder coding lineages and
// stops; "no cap" trickles fresh founders indefinitely with no ceiling.
const FOUNDER_CAP_STEP = 5;
const FOUNDER_CAP_MIN = 1;
let founderCapOn = true;
let founderCapValue = 10;
const founderModeWrap = document.createElement("div");
founderModeWrap.style.cssText =
  "display:flex;align-items:center;gap:6px;padding:2px 8px;flex:0 1 auto;" +
  "white-space:nowrap;max-width:100%;border:1px solid #1a3340;" +
  "border-radius:4px;color:#9ee;background:rgba(0,0,0,.4);";
founderModeWrap.title =
  "Founder spawning mode. cap N: maintain up to N distinct founder " +
  "lineages, then stop. no cap: keep trickling new founders with no ceiling.";
function mkFounderRadio(text: string): [HTMLLabelElement, HTMLInputElement] {
  const l = document.createElement("label");
  l.style.cssText = "display:flex;align-items:center;gap:3px;cursor:pointer;";
  const r = document.createElement("input");
  r.type = "radio"; r.name = "founderMode"; r.style.cssText = "cursor:pointer;";
  l.append(r, document.createTextNode(text));
  return [l, r];
}
const [fmCapLabel, fmCapRadio] = mkFounderRadio("cap");
const [fmNoCapLabel, fmNoCapRadio] = mkFounderRadio("no cap");
fmCapRadio.checked = true;
const fcMinus = mkBtn("−", `Lower the founder cap by ${FOUNDER_CAP_STEP}`);
const fcPlus = mkBtn("+", `Raise the founder cap by ${FOUNDER_CAP_STEP}`);
fcMinus.style.cssText = CBTN + "padding:1px 9px;";
fcPlus.style.cssText = CBTN + "padding:1px 9px;";
const fcValue = document.createElement("span");
fcValue.style.cssText = "font-weight:bold;min-width:3ch;text-align:right;color:#cfe;";
function renderFounderCapLabel(): void { fcValue.textContent = String(founderCapValue); }
function updateFounderModeEnabled(): void {
  founderModeWrap.style.opacity = foundersOn ? "1" : "0.4";
  fmCapRadio.disabled = !foundersOn;
  fmNoCapRadio.disabled = !foundersOn;
  const capCtl = foundersOn && founderCapOn;
  fcMinus.disabled = !capCtl;
  fcPlus.disabled = !capCtl;
  fcMinus.style.cursor = capCtl ? "pointer" : "default";
  fcPlus.style.cursor = capCtl ? "pointer" : "default";
  fcValue.style.opacity = capCtl ? "1" : "0.45";
}
function setFounderCapMode(capOn: boolean): void {
  founderCapOn = capOn;
  fmCapRadio.checked = capOn;
  fmNoCapRadio.checked = !capOn;
  updateFounderModeEnabled();
  simWorker.postMessage({ type: "setFounderCapEnabled", on: capOn });
  if (capOn) simWorker.postMessage({ type: "setFounderTarget", target: founderCapValue });
}
function nudgeFounderCap(delta: number): void {
  founderCapValue = Math.max(FOUNDER_CAP_MIN, founderCapValue + delta);
  renderFounderCapLabel();
  simWorker.postMessage({ type: "setFounderTarget", target: founderCapValue });
}
fmCapRadio.addEventListener("change", () => { if (fmCapRadio.checked) setFounderCapMode(true); });
fmNoCapRadio.addEventListener("change", () => { if (fmNoCapRadio.checked) setFounderCapMode(false); });
fcMinus.addEventListener("click", () => nudgeFounderCap(-FOUNDER_CAP_STEP));
fcPlus.addEventListener("click", () => nudgeFounderCap(FOUNDER_CAP_STEP));
renderFounderCapLabel();
updateFounderModeEnabled();
founderModeWrap.append(fmCapLabel, fcMinus, fcValue, fcPlus, fmNoCapLabel);
function syncFounderMode(capOn: boolean, target: number): void {
  if (target !== founderCapValue) { founderCapValue = target; renderFounderCapLabel(); }
  if (capOn !== founderCapOn) {
    founderCapOn = capOn;
    fmCapRadio.checked = capOn;
    fmNoCapRadio.checked = !capOn;
  }
  updateFounderModeEnabled();
}

// Ongoing resource seeding. Off by default: the one-shot startup seed
// (the "initial period") always runs regardless; turning this on
// resumes periodic resource replenishment toward the cap afterward.
let seedingOn = true;
const seedingBtn = mkBtn(
  "seeding on",
  "Keep dumping resources periodically after the initial seed period (the initial period always happens; default on = resources keep replenishing so the world runs indefinitely)",
);
setBtn(seedingBtn, true, T_GREEN);
seedingBtn.addEventListener("click", () => {
  seedingOn = !seedingOn;
  seedingBtn.textContent = seedingOn ? "seeding on" : "seeding off";
  setBtn(seedingBtn, seedingOn, T_GREEN);
  simWorker.postMessage({ type: "setSeeding", on: seedingOn });
});
function syncSeedingBtn(on: boolean): void {
  if (on === seedingOn) return;
  seedingOn = on;
  seedingBtn.textContent = seedingOn ? "seeding on" : "seeding off";
  setBtn(seedingBtn, seedingOn, T_GREEN);
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
  particleCap = Math.max(PARTICLE_TARGET_MIN, particleCap + delta);
  renderCapLabel();
  simWorker.postMessage({ type: "setParticleCap", cap: particleCap });
}
capMinus.addEventListener("click", () => nudgeCap(-PARTICLE_TARGET_STEP));
capPlus.addEventListener("click", () => nudgeCap(PARTICLE_TARGET_STEP));
renderCapLabel();
capWrap.append(capTitle, capMinus, capValue, capPlus);

// Parallel-dispatch threshold: particle count at/above which collision +
// force passes run on the worker pool. Tunable live to find the
// crossover where parallelizing beats serial dispatch overhead.
let parallelMinUI = 4000;
const parWrap = document.createElement("div");
parWrap.style.cssText = capWrap.style.cssText;
parWrap.title = "Particle count at/above which physics dispatches to worker threads. " +
  "Lower it to parallelize smaller worlds; raise it if dispatch overhead costs more than it saves.";
const parTitle = document.createElement("span");
parTitle.textContent = "par≥"; parTitle.style.cssText = "opacity:0.7;";
const parValue = document.createElement("span");
parValue.style.cssText = "font-weight:bold;min-width:5ch;text-align:right;color:#cfe;";
const parMinus = mkBtn("−", `Lower the parallel threshold by ${PARALLEL_MIN_RANGE.step}`);
const parPlus = mkBtn("+", `Raise the parallel threshold by ${PARALLEL_MIN_RANGE.step}`);
parMinus.style.cssText = CBTN + "padding:1px 9px;";
parPlus.style.cssText = CBTN + "padding:1px 9px;";
function renderParLabel(): void { parValue.textContent = String(parallelMinUI); }
function nudgePar(delta: number): void {
  parallelMinUI = Math.max(PARALLEL_MIN_RANGE.min, Math.min(PARALLEL_MIN_RANGE.max, parallelMinUI + delta));
  renderParLabel();
  simWorker.postMessage({ type: "setParallelMin", n: parallelMinUI });
}
parMinus.addEventListener("click", () => nudgePar(-PARALLEL_MIN_RANGE.step));
parPlus.addEventListener("click", () => nudgePar(PARALLEL_MIN_RANGE.step));
renderParLabel();
parWrap.append(parTitle, parMinus, parValue, parPlus);

// Germline mutation-rate multiplier (world.mutationRateMul). Live knob on
// evolutionary mutation pressure: scales mutateGenome's per-byte rates.
const MUT_RATE_STEP = 0.25;
const MUT_RATE_MAX = 10;
let mutRateUI = 1;
const mutWrap = document.createElement("div");
mutWrap.style.cssText = capWrap.style.cssText;
mutWrap.title = "Germline mutation-rate multiplier at fission (1x = shipped rate). " +
  "Scales the per-byte point/insert/delete probabilities; raise for faster drift, " +
  "lower (or 0) to freeze genomes.";
const mutTitle = document.createElement("span");
mutTitle.textContent = "mut×"; mutTitle.style.cssText = "opacity:0.7;";
const mutValue = document.createElement("span");
mutValue.style.cssText = "font-weight:bold;min-width:5ch;text-align:right;color:#cfe;";
const mutMinus = mkBtn("−", `Lower the mutation rate by ${MUT_RATE_STEP}x`);
const mutPlus = mkBtn("+", `Raise the mutation rate by ${MUT_RATE_STEP}x`);
mutMinus.style.cssText = CBTN + "padding:1px 9px;";
mutPlus.style.cssText = CBTN + "padding:1px 9px;";
function renderMutLabel(): void { mutValue.textContent = `${mutRateUI.toFixed(2)}×`; }
function nudgeMut(delta: number): void {
  mutRateUI = Math.max(0, Math.min(MUT_RATE_MAX, Math.round((mutRateUI + delta) * 100) / 100));
  renderMutLabel();
  simWorker.postMessage({ type: "setMutationRate", mul: mutRateUI });
}
mutMinus.addEventListener("click", () => nudgeMut(-MUT_RATE_STEP));
mutPlus.addEventListener("click", () => nudgeMut(MUT_RATE_STEP));
renderMutLabel();
mutWrap.append(mutTitle, mutMinus, mutValue, mutPlus);

// "adjust geology" -- rerolls procedural rock perturbation in place.
// Rocks (silhouette + collision lobes), heightmap, and surface modifiers
// rebuild around the new seed; the vent stays at its same relative
// position; sim time + population keep running.
const geologyBtn = mkBtn("geology", "Reroll the procedural rock geometry (terrain only; sim keeps running).");
geologyBtn.addEventListener("click", () => {
  // Random non-zero u32 seed so a re-roll always produces fresh geology
  // (seed 0 is reserved for the un-perturbed identity / legacy / tests).
  let seed = 0;
  while (seed === 0) seed = (Math.random() * 0x100000000) >>> 0;
  simWorker.postMessage({ type: "setGeologySeed", seed });
});

gWorld.append(foundersBtn, founderModeWrap, seedingBtn, capWrap, parWrap, mutWrap, geologyBtn);

// ---- view: overlay / density sources / material / grid ----
type HeatmapMode = "off" | "temp" | "density" | "light" | "health" | "reproduce" | "ph" | "electric" | "vibration" | "magnetic";
let heatmapMode: HeatmapMode = "off";
const HEATMAP_CELL = 32;
const HEATMAP_ALPHA = 0.28;
const overlaySelectEl = document.createElement("select");
overlaySelectEl.title = "Field overlay";
overlaySelectEl.style.cssText = SELECT_CSS;
for (const [val, txt] of [["off", "overlay: none"], ["temp", "overlay: temperature"], ["density", "overlay: density"], ["light", "overlay: light"], ["ph", "overlay: pH / acidity"], ["electric", "overlay: electric field"], ["vibration", "overlay: vibration field"], ["magnetic", "overlay: magnetic field"], ["health", "overlay: cell health"], ["reproduce", "overlay: reproduce readiness"]] as [HeatmapMode, string][]) {
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
overlayWrap.append(overlaySelectEl, densChemSel, densSrcWrap, gridBtn);

renderCtrlCollapsed();
renderOverlayCollapsed();

// Live zoom readout: a small label pinned to the top-left of the world
// area, shown only when zoomed past the fit (1.0x) so it stays out of the
// way at the default view. Position tracks the side panels via
// positionWorldButtons; text/visibility update each frame in render().
const zoomReadout = document.createElement("div");
zoomReadout.title = "Double-click the world to reset zoom";
zoomReadout.style.cssText =
  "position:fixed;z-index:9;display:none;padding:2px 7px;border-radius:4px;" +
  "background:rgba(2,12,18,0.82);border:1px solid #1a3340;color:#9ee;" +
  "pointer-events:none;white-space:nowrap;" + HUD_FONT;
root.appendChild(zoomReadout);
function positionZoomReadout(): void {
  zoomReadout.style.left = `${leftPanelWidth() + 6}px`;
  zoomReadout.style.top = `${topReserveH() + 6}px`;
}
let lastZoomLabel = "";
function updateZoomReadout(): void {
  if (viewZoom > 1.005) {
    const label = `${viewZoom.toFixed(1)}×`;
    if (label !== lastZoomLabel) { zoomReadout.textContent = label; lastZoomLabel = label; }
    if (zoomReadout.style.display === "none") zoomReadout.style.display = "";
  } else if (zoomReadout.style.display !== "none") {
    zoomReadout.style.display = "none";
    lastZoomLabel = "";
  }
}

// Geometry: span between the side panels, anchored to screen bottom;
// measure real height so the world fit can reserve exactly that.
function positionWorldButtons(): void {
  const panelW = analysisMinimized ? ANALYSIS_PANEL_W_MIN : analysisPanelW();
  const L = leftPanelWidth();
  // Bottom-to-top stack: [toggle row] [controls] [archetypes]
  // [overlay] [bottom HUD], then the world canvas above. A hidden
  // panel measures 0 (display:none) and contributes nothing.
  toggleBar.style.left = `${L}px`;
  toggleBar.style.right = `${panelW}px`;
  toggleBarH = Math.ceil(toggleBar.getBoundingClientRect().height) || 36;
  // Controls panel: directly above the toggle row.
  ctrlBar.style.left = `${L}px`;
  ctrlBar.style.right = `${panelW}px`;
  ctrlBar.style.bottom = `${toggleBarH}px`;
  controlsBarH = Math.ceil(ctrlBar.getBoundingClientRect().height) || 0;
  // Archetypes panel: above controls.
  archPanel.style.left = `${L}px`;
  archPanel.style.right = `${panelW}px`;
  archPanel.style.bottom = `${toggleBarH + controlsBarH}px`;
  archPanelH = Math.ceil(archPanel.getBoundingClientRect().height) || 0;
  // Overlay panel: above archetypes.
  overlayPanel.style.left = `${L}px`;
  overlayPanel.style.right = `${panelW}px`;
  overlayPanel.style.bottom = `${toggleBarH + controlsBarH + archPanelH}px`;
  overlayPanelH = Math.ceil(overlayPanel.getBoundingClientRect().height) || 0;
  // Bottom status strip: the topmost of the bottom stack, directly
  // under the world canvas.
  bottomHud.style.left = `${L}px`;
  bottomHud.style.right = `${panelW}px`;
  bottomHud.style.bottom =
    `${toggleBarH + controlsBarH + archPanelH + overlayPanelH}px`;
  bottomHudH = Math.ceil(bottomHud.getBoundingClientRect().height) || 0;
  // Keep the status strip clear of the left slide-out's tab/panel.
  hud.style.left = `${L + 8}px`;
  hudBarH = Math.ceil(hud.getBoundingClientRect().height) || 0;
  positionZoomReadout();
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
function bottomReserveH(): number {
  return (PHYLO_VISIBLE ? PHYLO_STRIP_H : 0)
    + toggleBarH + controlsBarH + archPanelH + overlayPanelH + bottomHudH;
}


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
// Re-measure now, next frame, and after the mobile viewport settles
// (URL bar finishing its show/hide animation post-resume). resize()
// is cheap + idempotent, so the extra calls are harmless.
function scheduleResize(): void {
  resize();
  requestAnimationFrame(resize);
  setTimeout(resize, 300);
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
  // Membership: how many live cells share this cell's exact genome
  // (species) vs its founding lineage (lineageRoot). Species nests in
  // lineage, so the species count <= the lineage count.
  let sameSpecies = 0;
  let sameLineage = 0;
  for (const o of snapshot.creatures) {
    if (o.speciesKey === c.speciesKey) sameSpecies++;
    if (o.lineageRoot === c.lineageRoot) sameLineage++;
  }
  const speed = Math.hypot(c.vx, c.vy);
  // Trophic / structural "kit": the few molecules that signal a cell's
  // strategy at a glance -- chlorophyll = phototroph, enzyme =
  // biopolymer digester, high membrane = armored, bondChem = colonial.
  const kit: string[] = [];
  if (c.molecules.chlorophyll > 1) kit.push("photo");
  if (c.molecules.enzyme > 1) kit.push("digest");
  if (c.molecules.membrane > 50) kit.push("armored");
  if (c.molecules.bondChem > 1) kit.push("bond");
  const kitLine = kit.length ? `\n${kit.join(" · ")}` : "";
  const divLine = c.division
    ? `\ndividing ${(c.division.progress * 100).toFixed(0)}%`
    : "";
  // Health bar (above) + reproduce-readiness bar (below). Health is the
  // weakest viability metric; readiness is how close the REPRODUCE gate
  // is to firing (hidden for sterile genomes).
  const health = cellHealth(c);
  const readiness = reproduceReadiness(c.genome, c);
  let barHtml = `<div style="margin-top:5px;">` + meterHtml("health", health, healthColor(health));
  if (readiness !== null) barHtml += meterHtml("reproduce", readiness, readiness >= 1 ? "#4caf50" : "#6fae6f");
  barHtml += `</div>`;
  tooltip.innerHTML =
    `<span style="display:inline-block;width:8px;height:8px;background:${c.color};border:1px solid #fff;vertical-align:middle;margin-right:4px"></span>` +
    `<b>${genomeTag(c.genome)}</b> (${c.genome.length}b)\n` +
    `age=${age}\n` +
    `ATP=${c.energy.toFixed(0)}  mass=${mass.toFixed(0)}\n` +
    `r=${c.r.toFixed(1)}  spd=${speed.toFixed(0)}  z=${c.z.toFixed(0)}\n` +
    `${sameSpecies} in species, ${sameLineage} in lineage` +
    divLine + kitLine + assocLine + barHtml;
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
// Render all N_RENDER_BUCKETS depth layers; the deepest bucket gets the
// heaviest canvas blur (1.6px) and lowest alpha (0.82).
const N_RENDER_BUCKETS = 8;
const BLURS = [0, 0.15, 0.35, 0.6, 0.85, 1.1, 1.35, 1.6];
const ALPHAS = [1.0, 0.98, 0.955, 0.925, 0.895, 0.865, 0.84, 0.82];
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

// Night sky: a fixed star field that twinkles and fades in with the
// night (see render()). Positions must be stable across frames -- a
// Math.random per frame would make every star jump -- so they come from
// a deterministic LCG seeded once and reseeded only when the sky box
// resizes. Render-only; no sim/determinism impact.
interface Star { x: number; y: number; r: number; phase: number; speed: number; }
let starField: Star[] = [];
let starFieldW = 0;
let starFieldH = 0;
function rebuildStarField(width: number, skyH: number): void {
  let s = 0x9e3779b1 >>> 0;
  const rnd = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  const n = Math.max(24, Math.round((width * skyH) / 1400)); // density ~ area
  const stars: Star[] = [];
  for (let i = 0; i < n; i++) {
    stars.push({
      x: rnd() * width,
      // rnd*rnd biases stars toward the top of the sky (few at the waterline).
      y: rnd() * rnd() * skyH,
      r: 0.4 + rnd() * 1.1,
      phase: rnd() * Math.PI * 2,
      speed: 1.5 + rnd() * 3,
    });
  }
  starField = stars;
  starFieldW = width;
  starFieldH = skyH;
}

function render(): void {
  // Re-clamp pan every frame so any path that mutates viewPan / viewZoom
  // (touch gestures, wheel, future hooks) gets the correction without
  // having to remember to call clampPan itself.
  clampPan();
  updateZoomReadout();
  const { width, height, depth, surfaceY } = snapshot;
  // Day/night tint applied to both surface and depth water colors so
  // the whole scene gets dimmer at night. 1 = full day, ~0.4 = deep
  // night (we don't go fully black so creatures stay visible).
  const sl = solarLight(snapshot);
  const dayMult = 0.4 + 0.6 * sl;
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

  // Atmosphere band -- fill above the wavy surface line. Interpolates from a
  // bright daytime sky-blue at midday to a dark night-blue, by the solar
  // intensity (so it tracks the same day/night cycle as the water).
  const skyR = Math.round(8 + sl * 84);
  const skyG = Math.round(14 + sl * 136);
  const skyB = Math.round(30 + sl * 184);
  ctx.fillStyle = `rgb(${skyR},${skyG},${skyB})`;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(width, 0);
  ctx.lineTo(width, surfaceYAt(snapshot, width));
  for (let x = width; x >= 0; x -= SURFACE_VIS_STEP) ctx.lineTo(x, surfaceYAt(snapshot, x));
  ctx.closePath();
  ctx.fill();

  // Night sky: twinkling stars + a full moon. nightAmount peaks at solar
  // midnight (dayPhase 0.75) and is 0 through the day, so both fade in at
  // dusk and out at dawn. Drawn over the sky band, under the water.
  const nightAmount = Math.max(0, -Math.sin(2 * Math.PI * snapshot.dayPhase));
  if (nightAmount > 0.01) {
    const skyH = Math.max(1, surfaceY);
    if (starField.length === 0 || starFieldW !== width || starFieldH !== skyH) {
      rebuildStarField(width, skyH);
    }
    const tw = performance.now() / 1000; // wall-clock twinkle (render-only)
    for (const st of starField) {
      const a = nightAmount * (0.55 + 0.45 * Math.sin(tw * st.speed + st.phase));
      if (a <= 0.02) continue;
      ctx.fillStyle = `rgba(235,242,255,${a.toFixed(3)})`;
      ctx.beginPath(); ctx.arc(st.x, st.y, st.r, 0, 2 * Math.PI); ctx.fill();
    }

    // Full moon: rides the sun's arc exactly half a cycle behind it, so it
    // is always 180deg off the sun -- rising in the east as the sun sets,
    // overhead at solar midnight, setting in the west by sunrise. Anchored
    // to the flat baseline surface like the sun (no wave jitter).
    const nf = Math.min(1, Math.max(0, (snapshot.dayPhase - 0.5) / 0.5));
    const mx = (0.05 + 0.90 * nf) * width;
    const my = surfaceY - (surfaceY - 6) * Math.sin(Math.PI * nf);
    const mr = 9;
    const mglow = ctx.createRadialGradient(mx, my, 0, mx, my, mr * 3);
    mglow.addColorStop(0, `rgba(220,228,245,${0.35 * nightAmount})`);
    mglow.addColorStop(1, "rgba(220,228,245,0)");
    ctx.fillStyle = mglow;
    ctx.beginPath(); ctx.arc(mx, my, mr * 3, 0, 2 * Math.PI); ctx.fill();
    // Fully-lit disc (full moon -> no crescent).
    ctx.fillStyle = `rgba(238,242,250,${(0.55 + 0.4 * nightAmount).toFixed(3)})`;
    ctx.beginPath(); ctx.arc(mx, my, mr, 0, 2 * Math.PI); ctx.fill();
    // Faint maria for a little texture.
    ctx.fillStyle = `rgba(203,210,226,${(0.45 * nightAmount).toFixed(3)})`;
    ctx.beginPath(); ctx.arc(mx - 2.6, my - 1.4, 2.1, 0, 2 * Math.PI); ctx.fill();
    ctx.beginPath(); ctx.arc(mx + 2.3, my + 2.1, 1.5, 0, 2 * Math.PI); ctx.fill();
    ctx.beginPath(); ctx.arc(mx + 1.0, my - 2.9, 1.0, 0, 2 * Math.PI); ctx.fill();
  }

  // Sun: arcs across the sky over the day -- rises at 5% of width, climbs
  // overhead at midday, sets at 95%. Drawn only in daylight; its position
  // is what drives the directional rock + cell shadows below the surface.
  {
    const sl = solarLight(snapshot);
    if (sl > 0.001) {
      const f = Math.min(1, Math.max(0, snapshot.dayPhase / 0.5)); // day fraction
      const sxs = sunXFrac(snapshot.dayPhase) * width;
      // Anchor to the flat baseline surface, NOT surfaceYAt (the live wavy
      // line): a distant sun shouldn't jitter up and down with local wave
      // chop. The water line itself stays wavy; only the sun is steadied.
      const sky = surfaceY;
      const sunY = sky - (sky - 6) * Math.sin(Math.PI * f);
      const r = 7;
      const glow = ctx.createRadialGradient(sxs, sunY, 0, sxs, sunY, r * 3.5);
      glow.addColorStop(0, `rgba(255,238,170,${0.7 * sl})`);
      glow.addColorStop(1, "rgba(255,238,170,0)");
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(sxs, sunY, r * 3.5, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = `rgba(255,246,214,${0.5 + 0.45 * sl})`;
      ctx.beginPath(); ctx.arc(sxs, sunY, r, 0, 2 * Math.PI); ctx.fill();
    }
  }

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

  // Surface highlight stroke.
  ctx.strokeStyle = "rgba(170, 220, 240, 0.45)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, surfaceYAt(snapshot, 0));
  for (let x = SURFACE_VIS_STEP; x <= width; x += SURFACE_VIS_STEP) ctx.lineTo(x, surfaceYAt(snapshot, x));
  ctx.stroke();

  // Wave-crash foam: where the surface shoals into a rock (shoalAt > 1),
  // spray bursts as crests arrive. Intensity peaks at the rock face (max
  // shoal) and pulses with the live crest height. Render-only -- uses
  // Math.random + wall time, no determinism impact.
  if (Math.abs(snapshot.wind) > WIND_MAX * 0.05) {
    for (let x = 0; x <= width; x += 4) {
      const boost = shoalAt(snapshot, x) - 1; // 0 in open water, peaks at the face
      if (boost <= 0.02) continue;
      const sy = surfaceYAt(snapshot, x);
      const up = surfaceY - sy; // >0 when a crest is up at this column
      if (up <= 0) continue;
      const intensity = boost * Math.min(1, up / Math.max(1, snapshot.surfaceWaveAmp));
      if (intensity < 0.05) continue;
      const n = Math.min(10, Math.round(intensity * 9));
      ctx.fillStyle = `rgba(230, 247, 255, ${Math.min(0.75, intensity).toFixed(3)})`;
      for (let i = 0; i < n; i++) {
        const sx = x + (Math.random() - 0.5) * 7;
        const rise = Math.random() * Math.random() * 18 * (0.6 + boost);
        const rr = 0.6 + Math.random() * 1.5;
        ctx.beginPath();
        ctx.arc(sx, sy - rise, rr, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Pre-bake terrain bitmap if needed; the blit happens later so rock
  // paints over particles that would otherwise visibly overlap the
  // surface. Particles are physically pushed out by collision; this
  // is the visual confirmation of impenetrability.
  if (!terrainBitmap) buildTerrainBitmap();

  // Wind streaks: short horizontal slashes drifting through the air
  // band, intensity scaling with |wind|, faded out where rock occupies
  // the column. Purely visual; no determinism impact (uses Math.random
  // and real wall-clock time).
  updateWindStreaks(width, surfaceY, snapshot.wind);
  drawWindStreaks(ctx, snapshot);
  updateSpray(width, surfaceY, snapshot);

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

  // Rock terrain composited on top of particles + vent overlay. Anything
  // painted earlier that overlaps a rock column gets hidden, matching
  // the physical impenetrability the collision code enforces.
  // Vent jet is drawn BEFORE the terrain bitmap so the rock occludes
  // its base -- the stream emerges from the notch rather than painting
  // over the chimney.
  if (snapshot.vent) drawVent(ctx, snapshot.vent, snapshot.t);
  if (terrainBitmap) ctx.drawImage(terrainBitmap, 0, 0);
  // Overtopping spray draws AFTER the rock so droplets are visible
  // arcing over and splashing down the wall's lee side.
  drawSpray(ctx);

  const selId = selectedCellId;
  // When a cell is selected (its follow-tooltip is up), ring every
  // other cell in the same species OR the same founding lineage
  // (covers mutated descendants that speciated away) with a 1px
  // selection border so the family is visible at a glance.
  const sel = selectedCell();
  // When a cell is selected, ring every other cell of the SAME SPECIES
  // (same speciesKey) so the species is visible at a glance. (We do NOT
  // ring the whole founding lineage -- lineageRoot is inherited through
  // all mutation, so a single dominant founder's descendants are usually
  // most of the world, which lit up ~every cell.)
  const kinSpecies = sel ? sel.speciesKey : null;
  for (let i = 0; i < snapshot.creatures.length; i++) {
    const c = snapshot.creatures[i];
    const isSel = c.id === selId;
    const isKin = !isSel && sel != null && c.speciesKey === kinSpecies;
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
// Offscreen buffer for the light overlay: the soft light field is
// sampled into a small bitmap, then upscaled with smoothing so the
// penumbra reads as a continuous gradient instead of 32px blocks.
const lightBuf = document.createElement("canvas");
const lightBufCtx = lightBuf.getContext("2d");

function drawHeatmap(): void {
  if (heatmapMode === "off") return;
  const { width, height, surfaceY } = snapshot;
  const cell = HEATMAP_CELL;
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil((height - surfaceY) / cell);
  ctx.globalAlpha = HEATMAP_ALPHA;
  if (heatmapMode === "temp") {
    // Read the diffused regional temperature field so vent heat +
    // diffusion show up; temperatureAt(snapshot,...) would only give
    // the analytical baseline (depth gradient + patch wave).
    const tField = snapshot.regionTemp;
    const rCols = Math.max(1, Math.ceil(width / REGION_PX));
    const rRows = Math.max(1, Math.ceil(height / REGION_PX));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * cell;
        const y = surfaceY + r * cell;
        let t: number;
        if (tField && tField.length === rCols * rRows) {
          let rx = Math.floor((x + cell / 2) / REGION_PX); if (rx < 0) rx = 0; else if (rx >= rCols) rx = rCols - 1;
          let ry = Math.floor((y + cell / 2) / REGION_PX); if (ry < 0) ry = 0; else if (ry >= rRows) ry = rRows - 1;
          t = tField[ry * rCols + rx];
        } else {
          // Fallback: analytical baseline (no vent / diffusion shown).
          t = temperatureAt(snapshot, x + cell / 2, y + cell / 2);
        }
        ctx.fillStyle = heatColorTemp(t);
        ctx.fillRect(x, y, cell, cell);
      }
    }
    ctx.globalAlpha = 1;
    return;
  }
  if (heatmapMode === "light" && lightBufCtx) {
    // Field overlay of usable sunlight = day-cycle x depth attenuation x
    // soft rock occlusion (the same ambientLightAt photosynthesis reads).
    // Sample into a small bitmap, then upscale with smoothing so the
    // penumbra is a continuous gradient, not flat blocks. solarLight is
    // constant per frame and the depth term varies only by row, so both
    // are hoisted -- only occlusion is per-sample.
    const sun = solarLight(snapshot);
    const SAMP = 6; // world px per sample (buffer resolution)
    const bw = Math.max(1, Math.ceil(width / SAMP));
    const bh = Math.max(1, Math.ceil((height - surfaceY) / SAMP));
    if (lightBuf.width !== bw) lightBuf.width = bw;
    if (lightBuf.height !== bh) lightBuf.height = bh;
    const img = lightBufCtx.createImageData(bw, bh);
    const data = img.data;
    for (let by = 0; by < bh; by++) {
      const y = surfaceY + (by + 0.5) * SAMP;
      const rowLight = sun * Math.exp(-y / LIGHT_DECAY);
      for (let bx = 0; bx < bw; bx++) {
        const x = (bx + 0.5) * SAMP;
        const v = rowLight * lightOcclusion(snapshot, x, y);
        const o = (by * bw + bx) * 4;
        data[o] = Math.round(255 * v);
        data[o + 1] = Math.round(238 * v);
        data[o + 2] = Math.round(120 * v);
        data[o + 3] = 255;
      }
    }
    lightBufCtx.putImageData(img, 0, 0);
    const prevSmooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(lightBuf, 0, surfaceY, width, height - surfaceY);
    ctx.imageSmoothingEnabled = prevSmooth;
    ctx.globalAlpha = 1;
    return;
  }
  if (heatmapMode === "health" || heatmapMode === "reproduce") {
    // Per-cell metric (cellHealth / reproduceReadiness, the same calcs the
    // inspector meters use) averaged over the cells in each heatmap bin.
    const isHealth = heatmapMode === "health";
    const sum = new Float32Array(cols * rows);
    const cnt = new Float32Array(cols * rows);
    for (const c of snapshot.creatures) {
      const v = isHealth ? cellHealth(c) : reproduceReadiness(c.genome, c);
      if (v === null) continue; // no reproduce gate -> excluded from the avg
      const cx = Math.floor(c.x / cell);
      const cy = Math.floor((c.y - surfaceY) / cell);
      if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue;
      const i = cy * cols + cx;
      sum[i] += Math.max(0, Math.min(1, v));
      cnt[i] += 1;
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (cnt[i] <= 0) continue;
        const avg = sum[i] / cnt[i];
        ctx.fillStyle = isHealth ? healthColor(avg) : reproduceColor(avg);
        ctx.fillRect(c * cell, surfaceY + r * cell, cell, cell);
      }
    }
    ctx.globalAlpha = 1;
    return;
  }
  if (heatmapMode === "ph") {
    // Acidity field: ambient CO2 per region (the proxy the pH sense
    // reads). High CO2 = acidic = warm red; low = cool blue.
    const f = snapshot.acidityField;
    const rCols = Math.max(1, Math.ceil(width / REGION_PX));
    const rRows = Math.max(1, Math.ceil(height / REGION_PX));
    if (f && f.length === rCols * rRows) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = c * cell, y = surfaceY + r * cell;
          let rx = Math.floor((x + cell / 2) / REGION_PX); if (rx < 0) rx = 0; else if (rx >= rCols) rx = rCols - 1;
          let ry = Math.floor((y + cell / 2) / REGION_PX); if (ry < 0) ry = 0; else if (ry >= rRows) ry = rRows - 1;
          // PH_ACID_SCALE: CO2 mass that reads as "fully acidic" in the
          // overlay. Tuned so vent/dead-zone plumes light up without
          // saturating the whole field.
          const acidity = Math.max(0, Math.min(1, f[ry * rCols + rx] / 12));
          const rr = Math.round(40 + 200 * acidity);
          const gg = Math.round(90 - 50 * acidity);
          const bb = Math.round(170 - 130 * acidity);
          ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
          ctx.fillRect(x, y, cell, cell);
        }
      }
    }
    ctx.globalAlpha = 1;
    return;
  }
  if (heatmapMode === "electric" || heatmapMode === "vibration") {
    // Cell-emission fields: bin each top-level cell's emission into the
    // heatmap grid (the field IS the cells -- there's no standing array).
    // electric = bioelectric glow of metabolizing cells; vibration =
    // hydroacoustic wake of moving cells.
    const isElec = heatmapMode === "electric";
    const field = new Float32Array(cols * rows);
    for (const c of snapshot.creatures) {
      const em = isElec ? c.electricEmission : c.vibrationEmission;
      if (em <= 0) continue;
      const cx = Math.floor(c.x / cell);
      const cy = Math.floor((c.y - surfaceY) / cell);
      if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue;
      field[cy * cols + cx] += em;
    }
    let maxE = 1e-6;
    for (let i = 0; i < field.length; i++) if (field[i] > maxE) maxE = field[i];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = field[r * cols + c];
        if (v <= 0) continue;
        const x = Math.max(0, Math.min(1, v / maxE));
        // electric -> electric-blue; vibration -> teal/green.
        ctx.fillStyle = isElec
          ? `rgb(${Math.round(60 + 120 * x)},${Math.round(140 + 80 * x)},${Math.round(180 + 75 * x)})`
          : `rgb(${Math.round(40 + 80 * x)},${Math.round(150 + 90 * x)},${Math.round(120 + 60 * x)})`;
        ctx.fillRect(c * cell, surfaceY + r * cell, cell, cell);
      }
    }
    ctx.globalAlpha = 1;
    return;
  }
  if (heatmapMode === "magnetic") {
    // Geomagnetic map as a vector field: short segments along the local
    // field direction, brightness scaling with intensity (which rises
    // with depth). Drawn as lines (not fills) so it reads as a compass
    // field rather than a heat blob.
    const step = REGION_PX; // one arrow per region-ish
    const vec = new Float32Array(2);
    const len = step * 0.34;
    ctx.lineCap = "round";
    for (let y = surfaceY + step / 2; y < height; y += step) {
      for (let x = step / 2; x < width; x += step) {
        magFieldBaseAt(width, height, x, y, vec);
        const mag = Math.hypot(vec[0], vec[1]) || 1;
        const ux = vec[0] / mag, uy = vec[1] / mag;
        const inten = Math.max(0, Math.min(1, (mag - 1) / 1.2));
        const a = (0.25 + 0.55 * inten).toFixed(2);
        ctx.strokeStyle = `rgba(150,90,235,${a})`;
        ctx.lineWidth = 1 + 1.6 * inten;
        ctx.beginPath();
        ctx.moveTo(x - ux * len, y - uy * len);
        ctx.lineTo(x + ux * len, y + uy * len);
        ctx.stroke();
        // arrowhead dot at the leading (field-direction) end.
        ctx.beginPath();
        ctx.arc(x + ux * len, y + uy * len, 1.3 + 1.2 * inten, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(190,140,255,${a})`;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
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
  // (Heatmap label removed per user request -- the legend text used
  // to read "heatmap: density [...] mat:X (max Y/cell)" here.)
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
  if (!PHYLO_VISIBLE) return; // hidden for now (strip + legend line)
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
// Tracks the geology seed the cached terrainBitmap was built for. When
// the snapshot's geologySeed changes (load, or "adjust geology"), this
// drops to force a rebuild from the new obstacles. -1 is a sentinel that
// any real seed (incl. 0) differs from on the first snapshot.
let lastBuiltGeologySeed = -1;
// Corner-rounding radius for the rendered rock silhouette. Render-only:
// collision runs against the lobe circles, not this polygon, so softening
// the drawn corners has zero physics/determinism impact.
const ROCK_CORNER_R = 4;
// Trace a closed polygon with its corners filleted to ~`r` px instead of
// hard vector points. arcTo between edge midpoints bounds each fillet to
// half the adjacent edge; an extra per-corner clamp keeps short edges
// from over-rounding.
// Trace a closed polygon with corners filleted to ~`r` px, using only
// moveTo + lineTo (the corner curves come from sampled quadratic-bezier
// points, not arcTo). arcTo's behaviour at degenerate / collinear /
// coincident corners turned out to silently break the fill for several
// of the wall-anchored rocks; an all-straight-line path fills reliably
// regardless of vertex pattern. The visual difference vs an exact arc
// at r=4 with 6 samples per corner is imperceptible.
const FILLET_SAMPLES = 6;
function traceRoundedPolygon(
  g: CanvasRenderingContext2D, pts: { x: number; y: number }[], r: number,
): void {
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
    Math.hypot(a.x - b.x, a.y - b.y);
  // Defensive dedup of consecutive coincident vertices (scalePolygon can
  // collapse multiple off-canvas anchor points onto the same corner).
  const p: { x: number; y: number }[] = [];
  for (const a of pts) {
    if (p.length === 0 || dist(a, p[p.length - 1]) > 1e-3) p.push(a);
  }
  if (p.length >= 2 && dist(p[0], p[p.length - 1]) <= 1e-3) p.pop();
  const n = p.length;
  if (n < 3) {
    if (n > 0) {
      g.moveTo(p[0].x, p[0].y);
      for (let i = 1; i < n; i++) g.lineTo(p[i].x, p[i].y);
      g.closePath();
    }
    return;
  }
  // Per-vertex fillet start / end points along the adjacent edges.
  const fs: { x: number; y: number }[] = new Array(n);
  const fe: { x: number; y: number }[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const prev = p[(i - 1 + n) % n];
    const cur = p[i];
    const next = p[(i + 1) % n];
    const dx1 = cur.x - prev.x, dy1 = cur.y - prev.y;
    const len1 = Math.hypot(dx1, dy1);
    const dx2 = next.x - cur.x, dy2 = next.y - cur.y;
    const len2 = Math.hypot(dx2, dy2);
    if (len1 === 0 || len2 === 0) {
      fs[i] = { x: cur.x, y: cur.y };
      fe[i] = { x: cur.x, y: cur.y };
      continue;
    }
    const cut = Math.min(r, len1 / 2, len2 / 2);
    fs[i] = { x: cur.x - (dx1 / len1) * cut, y: cur.y - (dy1 / len1) * cut };
    fe[i] = { x: cur.x + (dx2 / len2) * cut, y: cur.y + (dy2 / len2) * cut };
  }
  g.moveTo(fs[0].x, fs[0].y);
  for (let i = 0; i < n; i++) {
    const cur = p[i];
    const f0 = fs[i], f1 = fe[i];
    // Sample the corner via a quadratic-bezier with control at the
    // vertex. Skips s=0 (already there from the previous lineTo).
    for (let s = 1; s <= FILLET_SAMPLES; s++) {
      const t = s / FILLET_SAMPLES;
      const u = 1 - t;
      const x = u * u * f0.x + 2 * u * t * cur.x + t * t * f1.x;
      const y = u * u * f0.y + 2 * u * t * cur.y + t * t * f1.y;
      g.lineTo(x, y);
    }
    // Walk along the outgoing edge to the next corner's fillet start.
    const nfs = fs[(i + 1) % n];
    g.lineTo(nfs.x, nfs.y);
  }
  g.closePath();
}

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
      traceRoundedPolygon(octx, ob.polygon, ROCK_CORNER_R);
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

  // Pass 2: per-rock-pixel coloring. Going for a calm weathered-stone
  // read -- low-frequency tonal variation, soft top-down lighting, and
  // just enough grain to break up flat fills. The previous version
  // stacked uncorrelated per-pixel white-noise grain, sharp mineral
  // specks, and visible horizontal sin stratification on top of each
  // other; everything fought for attention and the rocks read as TV
  // static. Here:
  //
  //   - Two octaves of smoothed value noise drive a single tone field,
  //     remapped into the DARK..MID palette gradient.
  //   - Top-lit highlight + interior shadow ramp smoothly over the
  //     depth-from-surface (smoothstep, no abrupt cutoff).
  //   - One octave of finer noise provides texture WITHOUT per-pixel
  //     hash grain (no sandpaper static).
  //
  // Palette is desaturated cool-grey.
  const PAL_DARK  = [44, 42, 40];
  const PAL_MID   = [92, 88, 84];
  const PAL_LIGHT = [156, 150, 142];
  // Smoothed 2D value noise via bilinear interpolation over an integer
  // lattice. Output range ~[-0.5, 0.5]. Scale `s` is patch size in px.
  const sn2 = (x: number, y: number, s: number): number => {
    const fx = x / s, fy = y / s;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy;
    const a = hash2D(ix, iy);
    const b = hash2D(ix + 1, iy);
    const c = hash2D(ix, iy + 1);
    const d = hash2D(ix + 1, iy + 1);
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
  };
  // Smoothstep in [0,1].
  const ss = (t: number): number => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t * t * (3 - 2 * t);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      if (buf[idx + 3] === 0) continue;
      // Two octaves: a coarse field plus a finer detail field. No
      // per-pixel hash grain -- the finer octave alone gives plenty of
      // surface texture without static.
      const tone =
        sn2(x, y, 38) * 0.65 +
        sn2(x + 911, y + 277, 11) * 0.35;
      // Top-down lighting: smoothstep from full light at the rock
      // surface down to full shadow ~80 px in. No abrupt cutoff.
      const surf = topY[x];
      const depthFromTop = Math.max(0, y - surf);
      const lightT = 1 - ss(depthFromTop / 18);    // 1 at top -> 0 by 18 px
      const shadeT = ss((depthFromTop - 18) / 80); // 0 until 18 px, 1 by 98 px
      // Compose: lerp DARK..MID by tone, then blend toward LIGHT at
      // the top and toward DARK in deep interior. Three clean stages,
      // no per-pixel noise overlay.
      const mix = Math.max(0, Math.min(1, 0.5 + tone));
      let rC = PAL_DARK[0] + (PAL_MID[0] - PAL_DARK[0]) * mix;
      let gC = PAL_DARK[1] + (PAL_MID[1] - PAL_DARK[1]) * mix;
      let bC = PAL_DARK[2] + (PAL_MID[2] - PAL_DARK[2]) * mix;
      const lightW = 0.45 * lightT;
      if (lightW > 0) {
        rC += (PAL_LIGHT[0] - rC) * lightW;
        gC += (PAL_LIGHT[1] - gC) * lightW;
        bC += (PAL_LIGHT[2] - bC) * lightW;
      }
      const shadeW = 0.35 * shadeT;
      if (shadeW > 0) {
        rC += (PAL_DARK[0] - rC) * shadeW;
        gC += (PAL_DARK[1] - gC) * shadeW;
        bC += (PAL_DARK[2] - bC) * shadeW;
      }
      buf[idx]     = clamp255(rC);
      buf[idx + 1] = clamp255(gC);
      buf[idx + 2] = clamp255(bC);
    }
  }
  octx.putImageData(imgData, 0, 0);

  // Thin polygon-outline silhouette stroke. Drawn under multiply
  // composite so it darkens the rim by a fixed factor rather than
  // painting a hard line that would scintillate at high vertex counts.
  octx.save();
  octx.globalCompositeOperation = "multiply";
  octx.strokeStyle = "rgba(40,38,36,1)";
  octx.lineWidth = 1.2;
  octx.lineJoin = "round";
  for (const ob of snapshot.obstacles) {
    if (!ob.polygon || ob.polygon.length < 3) continue;
    octx.beginPath();
    traceRoundedPolygon(octx, ob.polygon, ROCK_CORNER_R);
    octx.stroke();
  }
  octx.restore();
  terrainBitmap = off;
}

// Wind streaks. Lightweight visual layer in the air band above the
// surface. State lives here (not in the snapshot) because it doesn't
// need to be deterministic -- it's purely cosmetic. Each streak is
// a short horizontal segment that advects with snapshot.wind and
// fades over its lifetime.
interface WindStreak { x: number; y: number; len: number; life: number; lifeMax: number }
const WIND_STREAKS: WindStreak[] = [];
const WIND_STREAK_POOL = 80;
let windLastUpdateMs = performance.now();

// Wave-crash overtopping spray. Ballistic droplets launched from a
// shoaling wall face up and DOWNWIND, so they arc over a surface wall
// and splash down its lee side instead of stopping at the windward face.
// Drawn after the terrain bitmap so they're visible clearing the rock.
// Render-only: Math.random + wall-clock dt, no determinism impact.
interface SprayDrop { x: number; y: number; vx: number; vy: number; life: number; lifeMax: number; r: number }
const SPRAY_POOL = 200;
const SPRAY: SprayDrop[] = [];
let sprayCursor = 0;
let sprayLastMs = 0;
const SPRAY_GRAV = 240; // px/s^2
function updateSpray(width: number, surfaceY: number, snap: typeof snapshot): void {
  const now = performance.now();
  const dt = Math.min(0.05, Math.max(0.001, (now - sprayLastMs) / 1000));
  sprayLastMs = now;
  while (SPRAY.length < SPRAY_POOL) SPRAY.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, lifeMax: 1, r: 1 });
  const hm = snap.terrainHeightmap;
  // Integrate live drops (gravity arc) and retire any that have landed:
  // a drop dies the instant it touches the wavy water surface or rock, so
  // spray splashes down instead of sinking through the sea or the wall.
  for (const d of SPRAY) {
    if (d.life <= 0) continue;
    d.life -= dt;
    d.vy += SPRAY_GRAV * dt;
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    if (d.y >= surfaceYAt(snap, d.x)) { d.life = 0; continue; }
    if (hm && hm.length > 0) {
      const ix = Math.floor(d.x);
      if (ix >= 0 && ix < hm.length && d.y >= hm[ix]) d.life = 0;
    }
  }
  const windMag = Math.min(1, Math.abs(snap.wind) / WIND_MAX);
  if (windMag <= 0.05) return;
  if (!hm || hm.length === 0) return;
  const dir = snap.wind >= 0 ? 1 : -1; // downwind = toward the wall / over it
  let budget = 16; // new drops/frame cap
  for (let x = 0; x <= width && budget > 0; x += 5) {
    const boost = shoalAt(snap, x) - 1;
    if (boost <= 0.4) continue; // only the inner apron right at the face
    const up = surfaceY - surfaceYAt(snap, x); // crest height above still surface
    if (up <= 0) continue;
    const intensity = boost * Math.min(1, up / Math.max(1, snap.surfaceWaveAmp));
    if (intensity < 0.18 || Math.random() > intensity) continue;
    // Find the wall edge downwind of this apron column + its crest height,
    // so the spray launches FROM the top of the wall and spills over it.
    let edge = -1, crestY = surfaceY;
    const xi = Math.floor(x);
    for (let d = 1; d <= 72; d++) {
      const cx = xi + dir * d;
      if (cx < 0 || cx >= hm.length) break;
      if (hm[cx] < surfaceY) { edge = cx; crestY = hm[cx]; break; } // breaching rock
    }
    if (edge < 0) continue;
    const drop = SPRAY[sprayCursor];
    sprayCursor = (sprayCursor + 1) % SPRAY_POOL;
    // Launch just above the crest, heading over the wall (downwind) with a
    // pop up; gravity then carries it down the lee side.
    drop.x = edge + dir * 2;
    drop.y = crestY - 2;
    drop.vx = dir * (38 + Math.random() * 70) * (0.6 + intensity);
    drop.vy = -(40 + Math.random() * 80) * (0.6 + intensity);
    drop.r = 0.7 + Math.random() * 1.6;
    drop.lifeMax = 0.7 + Math.random() * 0.9;
    drop.life = drop.lifeMax;
    budget--;
  }
}
function drawSpray(c: CanvasRenderingContext2D): void {
  for (const d of SPRAY) {
    if (d.life <= 0) continue;
    const a = Math.min(0.8, (d.life / d.lifeMax) * 0.8);
    c.fillStyle = `rgba(235, 248, 255, ${a.toFixed(3)})`;
    c.beginPath();
    c.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    c.fill();
  }
}

function updateWindStreaks(width: number, surfaceY: number, wind: number): void {
  const now = performance.now();
  const dt = Math.min(0.1, Math.max(0.001, (now - windLastUpdateMs) / 1000));
  windLastUpdateMs = now;
  while (WIND_STREAKS.length < WIND_STREAK_POOL) {
    WIND_STREAKS.push({ x: 0, y: 0, len: 0, life: 0, lifeMax: 1 });
  }
  const mag = Math.min(1, Math.abs(wind) / WIND_MAX);
  // Number of active streaks scales with wind magnitude.
  const activeN = Math.floor(WIND_STREAK_POOL * mag);
  const airTop = 0;
  const airBot = Math.max(2, surfaceY - 4);
  for (let i = 0; i < WIND_STREAK_POOL; i++) {
    const s = WIND_STREAKS[i];
    if (i >= activeN) { s.life = 0; continue; }
    s.life -= dt;
    if (s.life <= 0) {
      // Respawn at the upwind edge so the streak streams across.
      if (wind >= 0) s.x = -10 + Math.random() * (width * 0.3);
      else           s.x = width + 10 - Math.random() * (width * 0.3);
      s.y = airTop + Math.random() * (airBot - airTop);
      s.lifeMax = 1.0 + Math.random() * 2.5;
      s.life = s.lifeMax;
      s.len = 4 + Math.random() * 10 * mag;
    }
    s.x += wind * dt;
    // Wrap.
    if (s.x > width + 60) s.x -= width + 120;
    else if (s.x < -60) s.x += width + 120;
  }
}

function drawWindStreaks(c: CanvasRenderingContext2D, snap: typeof snapshot): void {
  const wind = snap.wind;
  const mag = Math.min(1, Math.abs(wind) / WIND_MAX);
  if (mag <= 0.05) return;
  c.lineCap = "round";
  c.lineWidth = 1;
  const dir = wind >= 0 ? 1 : -1;
  for (const s of WIND_STREAKS) {
    if (s.life <= 0) continue;
    // Fade in/out at the start and end of the streak's life.
    const fadeIn = Math.min(1, (s.lifeMax - s.life) / 0.3);
    const fadeOut = Math.min(1, s.life / 0.4);
    let alpha = mag * 0.65 * fadeIn * fadeOut;
    // Sheltered columns: streak fades out where wind is blocked.
    const expo = windExposureAt(snap, s.x);
    alpha *= expo;
    if (alpha <= 0.02) continue;
    const tipX = s.x + dir * s.len;
    c.strokeStyle = `rgba(220,232,240,${alpha.toFixed(3)})`;
    c.beginPath();
    c.moveTo(s.x, s.y);
    c.lineTo(tipX, s.y);
    c.stroke();
  }
}

// Hydrothermal vent visual. The vent itself is a small dark mouth
// drilled through the rock at (vent.x, vent.y); while erupting we
// stack three semi-transparent ellipses on top to read as a heated
// shimmer plume. Intensity drives both the plume opacity and a
// subtle orange glow at the mouth so the user can tell at a glance
// whether the vent is dormant or active.
function drawVent(
  c: CanvasRenderingContext2D,
  vent: { x: number; y: number; intensity: number; active: boolean },
  t: number,
): void {
  // Effective heat: a persistent base (the vent is always hot) plus the
  // eruption envelope on top -- matches the sim's regional-temp source,
  // so the animation never goes dead between eruptions.
  const erupt = vent.active ? vent.intensity : 0;
  const eff = VENT_BASE_INTENSITY + (1 - VENT_BASE_INTENSITY) * erupt;

  c.save();
  c.translate(vent.x, vent.y);

  // Narrow rising jet: a tight, mostly-vertical stream with one coherent
  // gentle waver (not wide turbulence). Shorter than a billowing plume.
  const jetH = 34 + 48 * eff;          // modest height
  const halfW = 2.0 + 1.4 * eff;       // narrow throat width
  const swayTop = Math.sin(t * 2.2) * (2 + 2 * eff);
  c.globalCompositeOperation = "lighter";
  c.beginPath();
  c.moveTo(-halfW, -5);
  c.quadraticCurveTo(swayTop * 0.5, -jetH * 0.55, swayTop, -jetH);
  c.quadraticCurveTo(swayTop * 0.5, -jetH * 0.55, halfW, -5);
  const jet = c.createLinearGradient(0, -5, 0, -jetH);
  jet.addColorStop(0, `rgba(255, 210, 160, ${(0.22 * eff).toFixed(3)})`);
  jet.addColorStop(1, "rgba(210, 180, 150, 0)");
  c.fillStyle = jet;
  c.fill();

  // Evenly-spaced rising specks along the centerline -> a consistent
  // stream rather than discrete puffs. Tight waver, slight growth, fade.
  const n = 6;
  const phase = (t * (0.9 + 0.6 * eff)) % 1;
  for (let i = 0; i < n; i++) {
    const k = (i + phase) / n;          // 0 at mouth -> 1 at jet top
    const y = -6 - k * jetH;
    const x = Math.sin(t * 2.2 + k * 3.0) * (1.4 + 2.6 * k);
    const rr = 1.1 + k * 1.9;
    const a = (0.10 + 0.26 * eff) * (1 - k);
    const g = Math.round(160 - 60 * k); // hot -> dusky mineral as it rises
    c.beginPath();
    c.ellipse(x, y, rr, rr * 1.15, 0, 0, Math.PI * 2);
    c.fillStyle = `rgba(255, ${g}, 90, ${a.toFixed(3)})`;
    c.fill();
  }
  c.globalCompositeOperation = "source-over";

  // Chimney lip + pulsing incandescent throat. No wide halo -- the rock
  // bitmap drawn over this frames the mouth in the notch.
  const pulse = 0.85 + 0.15 * Math.sin(t * 4);
  c.beginPath();
  c.ellipse(0, -3, 8, 4, 0, 0, Math.PI * 2);
  c.fillStyle = "rgba(10, 7, 5, 0.95)";
  c.fill();
  const throat = c.createRadialGradient(0, -3, 0, 0, -3, 7);
  const tg = 0.5 + 0.45 * eff * pulse;
  throat.addColorStop(0, `rgba(255, 240, 200, ${tg.toFixed(3)})`);
  throat.addColorStop(0.5, `rgba(255, 130, 50, ${(tg * 0.75).toFixed(3)})`);
  throat.addColorStop(1, "rgba(60, 12, 0, 0)");
  c.beginPath();
  c.ellipse(0, -3, 6, 3, 0, 0, Math.PI * 2);
  c.fillStyle = throat;
  c.fill();

  c.restore();
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
    drawVacuole(c.contents, c.x, c.y, c.r, 0);
  }

}

// Draw a vacuole's engulfed cells inside a parent circle, recursing
// into engulfed-within-engulfed nests. Each prey is drawn at its TRUE
// radius (world units, same scale as the host) so relative sizes read
// honestly; only clamped so a near-host-sized prey can't spill past the
// host disk. Bottoms out when a dot would be sub-pixel on screen or the
// nesting is implausibly deep, so a pathological chain can't blow the
// frame budget. Host volume always contains its prey (creatureTotalMass
// sums contents), so an unclamped inner.r never exceeds parentR anyway.
function drawVacuole(
  list: InnerCreatureSnapshot[], cx: number, cy: number,
  parentR: number, depth: number,
): void {
  if (depth > 4) return;
  const offR = list.length === 1 ? 0 : parentR * 0.4;
  for (let i = 0; i < list.length; i++) {
    const inner = list[i];
    const ir = Math.min(inner.r, parentR - offR);
    if (ir * viewScale < 0.6) continue; // sub-pixel on screen -> skip
    const angle = (i / Math.max(1, list.length)) * Math.PI * 2;
    const ix = cx + Math.cos(angle) * offR;
    const iy = cy + Math.sin(angle) * offR;
    ctx.fillStyle = inner.color;
    ctx.beginPath();
    ctx.arc(ix, iy, ir, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 1;
    ctx.stroke();
    const sub = inner.contents;
    if (sub && sub.length > 0) drawVacuole(sub, ix, iy, ir, depth + 1);
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
// Relabel elapsed sim-time so one full day/night cycle (dayPeriod
// sim-seconds) reads as a 24h day. Scale = 86400 / dayPeriod (144x at the
// default 600s day). Display-only -- the simulation is untouched.
const SECONDS_PER_DISPLAY_DAY = 86400;
function formatDayClock(simSec: number, dayPeriod: number): string {
  const sec = simSec * (SECONDS_PER_DISPLAY_DAY / Math.max(1, dayPeriod));
  const days = Math.floor(sec / SECONDS_PER_DISPLAY_DAY);
  const rem = sec - days * SECONDS_PER_DISPLAY_DAY;
  const h = Math.floor(rem / 3600);
  const m = Math.floor((rem - h * 3600) / 60);
  const hm = `${h}h${m.toString().padStart(2, "0")}m`;
  return days > 0 ? `${days}d ${hm}` : hm;
}

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
  // fps + sim/wall ratio + elapsed sim time + three paired readings +
  // build time. The three readings:
  //   - pop/engulfed:     free live cells / engulfed cells inside
  //                       hosts (recursive through nested vacuoles).
  //   - species/engulfed: distinct genomes among free cells /
  //                       species present ONLY as engulfed members.
  //   - lineages/extinct: distinct founding lineages still alive
  //                       (distinct lineageRoot ids) / lifetime
  //                       extinction count.
  // world.species.size would over-count -- it includes extinct
  // species still in the prune grace window.
  // Distinct species + coding-genome counts walk every creature (the
  // coding count hashes each genome), so throttle to a few times/sec
  // and cache; pop/parts/extinct below stay per-frame fresh.
  const nowHud = performance.now();
  if (nowHud - lastHudCountT > HUD_COUNT_INTERVAL_MS) {
    lastHudCountT = nowHud;
    const liveSpecies = new Set<string>();
    const liveCoding = new Set<string>();
    for (const c of snapshot.creatures) {
      liveSpecies.add(c.speciesKey);
      liveCoding.add(genomeCodingKey(c.genome));
    }
    cachedSpeciesCount = liveSpecies.size;
    cachedCodingCount = liveCoding.size;
  }
  // Top HUD: population-related counts only. "genomes" counts distinct
  // CODING genomes (gene bytes only -- intron drift ignored); "extinct"
  // is the lifetime count of coding genomes that have died out.
  hudStats.textContent =
    `pop/engulfed=${snapshot.creatures.length}/${snapshot.engulfedCount}  ` +
    `species/engulfed=${cachedSpeciesCount}/${snapshot.engulfedOnlySpeciesCount}  ` +
    `genomes/extinct=${cachedCodingCount}/${snapshot.extinctionCount}  ` +
    `parts=${snapshot.particles.length}/${snapshot.particleTarget}`;
  // Bottom HUD: clock / perf / build, fixed order.
  bottomHud.textContent =
    `t=${formatDayClock(snapshot.t, snapshot.dayPeriod)}  ` +
    `fps=${perfFps.toFixed(0)}  ` +
    `sim=${perfSimRate.toFixed(1)}x  ` +
    `r=${perfRenderMs.toFixed(1)}ms  ` +
    `s=${perfSimMs.toFixed(1)}ms  ` +
    `build=${__BUILD_TIME__}`;
  // No auto-fallback: if nothing is selected the inspector shows the
  // population summary and the pin control hides. Selection only
  // changes when the user clicks a cell (or it's cleared on death by
  // clearSelectionIfDead).
  const c = selectedCell();
  if (!c) {
    refreshActiveDisasm(); // clears the cached disasm when nothing is selected
    lastInspectedGenomeVer = "";
    pinSpeciesBtn.style.display = "none";
    killCellBtn.style.display = "none";
    if (killArmedId !== null) disarmKill();
    inspectorMeters.style.display = "none";
    inspectorProse.style.display = "none";
    disasmBar.style.display = "none";
    disasmBody.style.display = "none";
    inspector.textContent = `${statsLine()}  (click a cell)`;
    return;
  }
  // The disasm + gene-aware description are O(genome) string builds.
  // Rebuild them only when the selected genome actually changes -- a
  // new cell selected, or somatic mutation altering the bytes (the
  // exact speciesKey shifts). The meters + resource stats below still
  // refresh every frame off the live snapshot.
  const genomeVer = `${c.id}:${c.speciesKey}`;
  if (genomeVer !== lastInspectedGenomeVer) {
    lastInspectedGenomeVer = genomeVer;
    refreshActiveDisasm();
    inspectorProseCache = describeGenomeRich(c.genome);
    inspectorProse.innerHTML = inspectorProseCache;
    disasmBody.textContent = activeDisasm;
  }
  {
    const isPinned = pinnedSpecies.has(c.speciesKey);
    pinSpeciesBtn.style.display = "flex";
    // Selection changed out from under an armed confirm -> reset it so
    // the second tap can't kill a different cell.
    if (killArmedId !== null && killArmedId !== c.id) disarmKill();
    killCellBtn.style.display = "flex";
    const col = isPinned ? "#ffd24c" : "#9ee";
    pinSpeciesBtn.innerHTML =
      `<span style="font-weight:bold;line-height:1;color:${col};">` +
      `${isPinned ? "★" : "☆"}</span>` +
      `<span style="color:${col};">${isPinned ? "unpin" : "pin"} species ` +
      `<b>${genomeTag(c.genome)}</b></span>`;
  }
  // Meters at the top: health + reproduce readiness.
  inspectorMeters.style.display = "";
  {
    const health = cellHealth(c);
    const readiness = reproduceReadiness(c.genome, c);
    let h = meterHtml("health", health, healthColor(health));
    if (readiness !== null) h += meterHtml("reproduce readiness", readiness, readiness >= 1 ? "#4caf50" : "#6fae6f");
    inspectorMeters.innerHTML = h;
  }
  // Content (innerHTML / disasm text) is set in the genome-change guard
  // above; here just ensure visibility every frame.
  inspectorProse.style.display = "";
  disasmBar.style.display = "flex";
  disasmBody.style.display = disasmExpanded ? "" : "none";
  let molMass = c.energy;
  for (const k of MOLECULE_IDS) molMass += c.molecules[k];
  const totalMass = molMass;
  const m = c.molecules;
  const fmt = (x: number) => x.toFixed(0);
  const age = formatAge(Math.max(0, snapshot.t - c.bornAt));
  inspector.textContent =
    `${statsLine()}\n` +
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
    `sense: mech=${fmt(m.mechanoreceptor)} thermo=${fmt(m.thermoreceptor)} mag=${fmt(m.magnetoreceptor)}\n` +
    `      pH=${fmt(m.phreceptor)}/${fmt(m.activatedPh)} electro=${fmt(m.electroreceptor)}/${fmt(m.activatedElectroX)},${fmt(m.activatedElectroY)}\n` +
    `      light=${fmt(m.activatedLightX)},${fmt(m.activatedLightY)} vib=${fmt(m.vibroreceptor)}/${fmt(m.activatedVibX)},${fmt(m.activatedVibY)}\n` +
    `bond=${fmt(m.bondChem)} repair=${fmt(m.repairChem)}\n` +
    (c.contents.length > 0 ? `vacuole: ${c.contents.length} engulfed cell(s)\n` : "") +
    `pc=${c.vmPc}  genome=${c.genome.length}b`;
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
  // Inspector intentionally carries only the sim-rate now; fps / t /
  // species / profiling / pop / parts / extinct moved off it (top and
  // bottom HUDs own the global counters).
  return `sim=${perfSimRate.toFixed(1)}x`;
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
let stallDiag = "";          // last worker diag response (set on "diag" msg)
let stallDiagReqWall = 0;    // last time we asked the worker for a diag
const STALL_WALL_MS = 1500;
function updateDiagBar(): void {
  const nowWall = performance.now();
  if (snapshot.t !== stallWatchT) {
    stallWatchT = snapshot.t;
    stallWatchWall = nowWall;
    stallDiag = "";
  }
  const stalledMs = nowWall - stallWatchWall;
  const parts: string[] = [];
  if (stalledMs > STALL_WALL_MS) {
    parts.push(`SIM STALLED ${(stalledMs / 1000).toFixed(1)}s  pop=${snapshot.creatures.length}  parts=${snapshot.particles.length}`);
    // Ask the worker what it's doing (throttled). If it answers, the
    // response shows below; if it never does, the worker thread is hung.
    if (nowWall - stallDiagReqWall > 1000) {
      stallDiagReqWall = nowWall;
      simWorker.postMessage({ type: "requestDiag" });
    }
    parts.push(stallDiag || "(querying worker… no diag response = worker thread hung)");
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
// A small two-click-confirm button (mirrors the run-panel reset). First
// click arms (shows the confirm label in red) for 3s; a second click
// within that window fires onConfirm. Used for destructive list actions
// (clear-all, per-item remove) so a stray click can't wipe pins.
function makeConfirmButton(
  label: string, confirmLabel: string, onConfirm: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  const base =
    `margin-top:4px;padding:2px 8px;border:1px solid #1a3340;border-radius:3px;` +
    `cursor:pointer;font-size:${UI_FONT_PX}px;`;
  let armedUntil = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const disarm = (): void => {
    armedUntil = 0;
    btn.textContent = label;
    btn.style.cssText = base + "background:rgba(0,0,0,.4);color:#e88;";
    if (timer) { clearTimeout(timer); timer = null; }
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const now = performance.now();
    if (now < armedUntil) { if (timer) clearTimeout(timer); onConfirm(); return; }
    armedUntil = now + 3000;
    btn.textContent = confirmLabel;
    btn.style.cssText = base + "background:rgba(90,0,0,.55);color:#f88;font-weight:bold;";
    if (timer) clearTimeout(timer);
    timer = setTimeout(disarm, 3000);
  });
  disarm();
  return btn;
}

function buildSpeciesCard(
  genome: Uint8Array, color: string,
  rankLabel: string, status: string, statsLine: string,
  onRemove?: () => void,
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
  // Per-item remove (pinned list only). Two-click confirm so a stray
  // tap can't drop a pin.
  if (onRemove) {
    const removeBtn = makeConfirmButton("Remove", "Confirm remove", onRemove);
    removeBtn.style.cssText += "margin-left:6px;";
    block.appendChild(removeBtn);
  }
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
    ? `Pinned species (${entries.length})`
    : `Notable: best ${entries.length} ever seen`;
  // Clear-all (two-click confirm) -- only when there's something to clear.
  if (entries.length > 0) {
    const isPinned = analysisTab === "pinned";
    const clearBtn = makeConfirmButton("Clear all", "Confirm clear all", () => {
      src.clear();
      if (isPinned) { persistMarked(PIN_KEY, pinnedSpecies); syncPinnedToWorker(); }
      renderAnalysisPanel();
    });
    clearBtn.style.cssText += "float:right;margin-top:0;";
    header.appendChild(clearBtn);
  }
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
    // Pinned items get a per-item remove; notable entries don't (they
    // re-accrue automatically as the sim runs, so removal is moot).
    const onRemove = analysisTab === "pinned"
      ? () => {
          pinnedSpecies.delete(e.key);
          persistMarked(PIN_KEY, pinnedSpecies);
          syncPinnedToWorker();
          renderAnalysisPanel();
        }
      : undefined;
    analysisBody.appendChild(
      buildSpeciesCard(Uint8Array.from(e.genome), e.color, "", status, stats, onRemove),
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
// Reaction slot IDs (mirror sim/reactions.ts -- keep in sync). Used to
// classify a genome's trophic mode from its SYNTH CAT investments.
const SLOT_PHOTOSYNTH_LOCAL = 3;
const SLOT_SYNTH_CHL_LOCAL = 6;
function trophicMode(genome: Uint8Array): TrophicMode {
  let hasIngest = false, hasPredate = false, hasEngulf = false;
  let boostsPhoto = false;
  walkGenome(genome, (op, pc, operand) => {
    if (op === OP.INGEST) hasIngest = true;
    else if (op === OP.PREDATE) hasPredate = true;
    else if (op === OP.ENGULF) hasEngulf = true;
    else if (op === OP.SYNTH && (operand ?? 0) % SYNTH_KIND_COUNT === SYNTH_KIND.CAT) {
      const slot = (genome[(pc + 2) % genome.length] ?? 0) % CATALYST_COUNT;
      if (slot === SLOT_PHOTOSYNTH_LOCAL || slot === SLOT_SYNTH_CHL_LOCAL) boostsPhoto = true;
    }
  });
  const eatsOther = hasPredate || hasEngulf;
  const eatsParticles = hasIngest;
  if (boostsPhoto && !eatsOther && !eatsParticles) return TROPHIC_AUTO;
  if (boostsPhoto && (eatsOther || eatsParticles)) return TROPHIC_MIXO;
  if (eatsOther) return TROPHIC_PRED;
  return TROPHIC_HET;
}

// ---- Rich, gene-aware genome description (inspector top) ----
// Walks the genome's GENE..END spans and, per gene, runs a small
// symbolic stack interpreter to recover the CONDITION guarding each
// action -- so the readout says "Reproduces when membrane > 30 and
// ATP > 15", not just "divides conditionally". Statically-dead gates
// (a constant comparison that can never be true) flag the action as
// short-circuited (rendered orange). Functions the genome lacks are
// omitted, except notable absences (no reproduction).

const i8s = (b: number): number => (b > 127 ? b - 256 : b);

interface SymTerm { s: string; k?: number; t?: 0 | 1 }
interface Guard { label: string; start: number; end: number; dead: boolean }
interface RichAction { text: string; pc: number; cat?: number; inh?: number }

// Decode one gene's ops (already past GENE, up to END) into the action
// list + guard intervals via symbolic execution. Linear walk (jumps are
// not followed -- we read structure, not run it), which matches the
// dominant "sensor; PUSH k; CMP; JZ; action" gating shape.
function analyzeGene(genome: Uint8Array, start: number, end: number): {
  actions: RichAction[]; guards: Guard[];
} {
  const stack: SymTerm[] = [];
  const pop = (): SymTerm => stack.pop() ?? { s: "0", k: 0, t: 0 };
  const guards: Guard[] = [];
  const actions: RichAction[] = [];
  let i = start;
  while (i < end) {
    const op = genome[i];
    const operandLen = OPERANDS[op];
    const a1 = i + 1 < genome.length ? genome[i + 1] : 0;
    const a2 = i + 2 < genome.length ? genome[i + 2] : 0;
    const next = i + 1 + operandLen;
    switch (op) {
      case OP.PUSH8: stack.push({ s: String(i8s(a1)), k: i8s(a1) }); break;
      case OP.SELF_ENERGY: stack.push({ s: "ATP" }); break;
      case OP.SELF_MEMBRANE: stack.push({ s: "membrane" }); break;
      case OP.SELF_MASS: stack.push({ s: "mass" }); break;
      case OP.SENSE_CHEMICAL: stack.push({ s: chemName(a1 % 96) }); break;
      case OP.SENSE_OUT: stack.push({ s: `∇${chemName(a1 % 96)}.x` }); stack.push({ s: `∇${chemName(a1 % 96)}.y` }); break;
      case OP.DUP: { const x = pop(); stack.push(x); stack.push(x); break; }
      case OP.SWAP: { const b = pop(), a = pop(); stack.push(b); stack.push(a); break; }
      case OP.POP: pop(); break;
      case OP.GT: case OP.LT: case OP.EQ: {
        const b = pop(), a = pop();
        const sym = op === OP.GT ? ">" : op === OP.LT ? "<" : "=";
        let t: 0 | 1 | undefined;
        if (a.k !== undefined && b.k !== undefined) {
          t = (op === OP.GT ? a.k > b.k : op === OP.LT ? a.k < b.k : a.k === b.k) ? 1 : 0;
        }
        stack.push({ s: `${a.s} ${sym} ${b.s}`, t });
        break;
      }
      case OP.AND: case OP.OR: {
        const b = pop(), a = pop();
        const word = op === OP.AND ? "and" : "or";
        let t: 0 | 1 | undefined;
        if (a.t !== undefined && b.t !== undefined) {
          t = (op === OP.AND ? a.t && b.t : a.t || b.t) ? 1 : 0;
        }
        stack.push({ s: `${a.s} ${word} ${b.s}`, t });
        break;
      }
      case OP.NOT: { const a = pop(); stack.push({ s: `not(${a.s})`, t: a.t === undefined ? undefined : (a.t ? 0 : 1) }); break; }
      case OP.ADD: case OP.SUB: case OP.MUL: case OP.DIV: {
        const b = pop(), a = pop();
        const sym = op === OP.ADD ? "+" : op === OP.SUB ? "-" : op === OP.MUL ? "×" : "/";
        const k = (a.k !== undefined && b.k !== undefined)
          ? (op === OP.ADD ? a.k + b.k : op === OP.SUB ? a.k - b.k : op === OP.MUL ? a.k * b.k : (b.k ? a.k / b.k : 0))
          : undefined;
        stack.push({ s: `(${a.s} ${sym} ${b.s})`, k });
        break;
      }
      case OP.JZ: case OP.JNZ: {
        const cond = pop();
        const target = next + i8s(a1);
        // JZ skips [next, target) when cond is FALSE -> region runs when
        // cond TRUE (guard = cond). JNZ is the mirror (guard = not cond).
        const isJZ = op === OP.JZ;
        const label = isJZ ? cond.s : `not(${cond.s})`;
        const dead = cond.t !== undefined && (isJZ ? cond.t === 0 : cond.t === 1);
        if (target > next) guards.push({ label, start: next, end: target, dead });
        break;
      }
      case OP.REPRODUCE: actions.push({ text: "Reproduces", pc: i }); break;
      case OP.INGEST: actions.push({ text: "Ingests food particles", pc: i }); break;
      case OP.PREDATE: actions.push({ text: "Predates other cells", pc: i }); break;
      case OP.ENGULF: actions.push({ text: "Engulfs other cells", pc: i }); break;
      case OP.THRUST: actions.push({ text: "Swims (thrust)", pc: i }); break;
      case OP.TURN: actions.push({ text: "Turns", pc: i }); break;
      case OP.EXCRETE: actions.push({ text: `Excretes ${chemName(a1 % 96)}`, pc: i }); break;
      case OP.TRANSPORT: actions.push({ text: `Transports ${chemName(a1 % 96)}`, pc: i }); break;
      case OP.EMIT: actions.push({ text: `Emits a ${emitChannelName(a1)} signal`, pc: i }); break;
      case OP.POKE_BYTE: case OP.SPLICE_DUP: case OP.SPLICE_DEL:
        actions.push({ text: "Self-modifies its genome", pc: i }); break;
      case OP.SYNTH: {
        const kind = a1 % SYNTH_KIND_COUNT;
        if (kind === SYNTH_KIND.CAT) actions.push({ text: "", pc: i, cat: a2 % CATALYST_COUNT });
        else if (kind === SYNTH_KIND.INH) actions.push({ text: "", pc: i, inh: a2 % CATALYST_COUNT });
        else if (kind === SYNTH_KIND.BOND) actions.push({ text: "Adhesive — bonds to matching-marker kin (BOND)", pc: i });
        else if (kind === SYNTH_KIND.COMPETENCE) actions.push({ text: "Takes up environmental DNA (competence)", pc: i });
        else if (kind === SYNTH_KIND.PACKAGE) actions.push({ text: "Sheds genome fragments (package/HGT)", pc: i });
        break;
      }
    }
    i = next;
  }
  return { actions, guards };
}

function describeGenomeRich(genome: Uint8Array): string {
  const esc = (s: string): string => s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
  // Collect genes (GENE..END spans) and intron byte total.
  let nGenes = 0, intronBytes = 0;
  const allActions: Array<{ text: string; guard: string; dead: boolean; cat?: number; inh?: number }> = [];
  let i = 0;
  let inGene = false, geneStart = 0;
  while (i < genome.length) {
    const op = genome[i];
    if (!inGene) {
      if (op === OP.GENE) { inGene = true; geneStart = i + 1; nGenes++; }
      else intronBytes++;
      i += 1;
      continue;
    }
    if (op === OP.END) {
      const { actions, guards } = analyzeGene(genome, geneStart, i);
      for (const a of actions) {
        const covering = guards.filter((g) => a.pc >= g.start && a.pc < g.end);
        const guard = covering.map((g) => g.label).join(" and ");
        const dead = covering.some((g) => g.dead);
        allActions.push({ text: a.text, guard, dead, cat: a.cat, inh: a.inh });
      }
      inGene = false;
      i += 1;
      continue;
    }
    i += 1 + OPERANDS[op];
  }

  const lines: string[] = [];
  const orange = (s: string): string => `<span style="color:#e8a13a;">${s}</span>`;
  const gate = (g: string): string => (g ? ` <span style="opacity:.75;">when ${esc(g)}</span>` : ` <span style="opacity:.55;">(every tick)</span>`);

  // Behaviour actions (non-SYNTH-cat/inh) grouped, conditions shown.
  const behaviours = allActions.filter((a) => a.text !== "");
  // De-dupe identical (text+guard+dead) lines so repeated genes collapse.
  const seen = new Set<string>();
  const reproduces = behaviours.some((a) => a.text === "Reproduces" && !a.dead);
  for (const a of behaviours) {
    const key = a.text + "|" + a.guard + "|" + a.dead;
    if (seen.has(key)) continue;
    seen.add(key);
    if (a.dead) {
      lines.push("• " + orange(`${a.text} — never (gate "${esc(a.guard)}" is always false)`));
    } else {
      lines.push("• " + esc(a.text) + gate(a.guard));
    }
  }
  // Metabolic identity: catalyst boosts / inhibitor damps.
  const cats = [...new Set(allActions.filter((a) => a.cat !== undefined).map((a) => a.cat as number))].sort((x, y) => x - y);
  const inhs = [...new Set(allActions.filter((a) => a.inh !== undefined).map((a) => a.inh as number))].sort((x, y) => x - y);
  if (cats.length) lines.push("• Boosts: " + esc(cats.map(reactionName).join(", ")));
  if (inhs.length) lines.push("• Damps: " + esc(inhs.map(reactionName).join(", ")));

  // Notable absence: a genome with no live REPRODUCE is sterile.
  if (!reproduces) {
    lines.push("• " + orange("Never reproduces — lineage is sterile"));
  }
  if (behaviours.length === 0 && cats.length === 0 && inhs.length === 0) {
    lines.push(orange("No expressed functions (no genes, or all ops in introns)."));
  }

  const head =
    `<div style="opacity:.7;padding-bottom:3px;">` +
    `${nGenes} gene${nGenes === 1 ? "" : "s"}, ${intronBytes} intron byte${intronBytes === 1 ? "" : "s"}` +
    `</div>`;
  return head + lines.join("<br>");
}

// Reproduce-readiness: 0..1 estimate of how close a cell is to firing
// its REPRODUCE gate, derived by symbolically evaluating the gate's
// comparisons against the cell's CURRENT values. Returns null if the
// genome has no reproduce op. A reflexive (ungated) REPRODUCE -> 1.
// Comparisons it can't bind to a live value (e.g. a SENSE_CHEMICAL
// threshold) are treated as already-satisfied so the bar reflects the
// resource gates (membrane/ATP/mass) that dominate founder genomes.
interface CellVals { energy: number; molecules: CreatureSnapshot["molecules"] }
interface RTerm { val?: () => number; prog?: () => number }

function readinessInGene(
  genome: Uint8Array, start: number, end: number, c: CellVals, total: number,
): number | null {
  const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
  const stack: RTerm[] = [];
  const pop = (): RTerm => stack.pop() ?? { val: () => 0 };
  const guards: Array<{ start: number; end: number; prog?: () => number }> = [];
  let reproPc = -1;
  let i = start;
  while (i < end) {
    const op = genome[i];
    const operandLen = OPERANDS[op];
    const a1 = i + 1 < genome.length ? genome[i + 1] : 0;
    const next = i + 1 + operandLen;
    switch (op) {
      case OP.PUSH8: { const k = i8s(a1); stack.push({ val: () => k }); break; }
      case OP.SELF_ENERGY: stack.push({ val: () => c.energy }); break;
      case OP.SELF_MEMBRANE: stack.push({ val: () => c.molecules.membrane }); break;
      case OP.SELF_MASS: stack.push({ val: () => total }); break;
      case OP.DUP: { const x = pop(); stack.push(x); stack.push(x); break; }
      case OP.SWAP: { const b = pop(), a = pop(); stack.push(b); stack.push(a); break; }
      case OP.POP: pop(); break;
      case OP.GT: case OP.LT: {
        const b = pop(), a = pop();
        const av = a.val, bv = b.val;
        const prog = (av && bv)
          ? (): number => {
              const x = av(), y = bv();
              return op === OP.GT
                ? (y > 0 ? clamp01(x / y) : (x > 0 ? 1 : 0))
                : (x < y ? 1 : (x > 0 ? clamp01(y / x) : 1));
            }
          : undefined;
        stack.push({ prog });
        break;
      }
      case OP.AND: {
        const b = pop(), a = pop();
        const prog = (a.prog && b.prog) ? (): number => Math.min(a.prog!(), b.prog!()) : (a.prog ?? b.prog);
        stack.push({ prog });
        break;
      }
      case OP.OR: {
        const b = pop(), a = pop();
        const prog = (a.prog && b.prog) ? (): number => Math.max(a.prog!(), b.prog!()) : (a.prog ?? b.prog);
        stack.push({ prog });
        break;
      }
      case OP.JZ: case OP.JNZ: {
        const cond = pop();
        const target = next + i8s(a1);
        if (target > next) {
          let prog = cond.prog;
          if (op === OP.JNZ && prog) { const p = prog; prog = (): number => 1 - p(); }
          guards.push({ start: next, end: target, prog });
        }
        break;
      }
      case OP.REPRODUCE: reproPc = i; break;
    }
    i = next;
  }
  if (reproPc < 0) return null;
  const covering = guards.filter((g) => reproPc >= g.start && reproPc < g.end);
  if (covering.length === 0) return 1; // reflexive: always ready
  let r = 1;
  for (const g of covering) {
    // A guard whose condition we couldn't evaluate (prog undefined)
    // means the gate stack underflowed or chained ops this symbolic
    // pass can't model -- i.e. a mutation-broken gate. The real VM
    // computes 0 there and the JZ skips REPRODUCE, so it is NOT ready:
    // count it as blocking instead of leaving readiness at 100%.
    r = Math.min(r, g.prog ? g.prog() : 0);
  }
  return r;
}

// Cell health: 0..1, the weakest of the metrics that actually cause
// (non-predation) death -- ATP, structural membrane, mRNA, amino acid.
// A cell dies the instant ANY of these crosses its viability floor, so
// health is the MIN of the per-metric safeties. Each safety saturates
// exponentially: 0 at the death floor, ~0.63 one "comfort scale" above
// it, ~0.95 at three scales -- so 100% means a deep, safe buffer rather
// than a hard cap.
function cellHealth(c: CellVals): number {
  const sat = (v: number, floor: number, scale: number): number => {
    const x = (v - floor) / scale;
    return x <= 0 ? 0 : 1 - Math.exp(-x);
  };
  const m = c.molecules;
  // ATP at/below 0 is only fatal when the cell ALSO has no fuel to burn
  // (engine: starve = energy<=0 AND noFuel). So count convertible
  // reserves toward the energy buffer, mirroring noFuel(): glucose +
  // fattyAcid are direct fuels, biopolymer counts if there's enzyme,
  // and a photosynth-capable cell (chlorophyll + CO2) can regenerate
  // ATP from light. Without this, a well-fed cell idling at ATP~0
  // wrongly read 0% health.
  let fuel = m.glucose + m.fattyAcid;
  if (m.enzyme >= 0.1) fuel += m.biopolymer;
  if (m.chlorophyll > 0.5 && m.co2 > 0.5) fuel += 20;
  return Math.min(
    sat(c.energy + fuel, 0, 20),   // ATP + convertible fuel buffer
    // Floors reference the engine's MIN_VIABLE_* directly so the meter
    // can't drift from the actual death thresholds.
    sat(m.membrane, MIN_VIABLE_MEMBRANE, 8),    // structural membrane
    sat(m.mrna, MIN_VIABLE_RIBOSOME, 2),        // ribosome/translation
    sat(m.aminoAcid, MIN_VIABLE_AMINOACID, 1),  // amino-acid pool
  );
}

// Full-width labeled meter as an HTML string (dark track + colored fill).
function meterHtml(label: string, frac: number, color: string): string {
  const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
  return (
    `<div style="opacity:.8;">${label} ${pct}%</div>` +
    `<div style="margin-top:2px;margin-bottom:5px;height:6px;background:#0a1a22;` +
    `border:1px solid #1a3340;border-radius:3px;overflow:hidden;">` +
    `<div style="height:100%;width:${pct}%;background:${color};"></div></div>`
  );
}
// Health bar color shifts red->amber->green with the value.
function healthColor(frac: number): string {
  return frac < 0.25 ? "#d0524c" : frac < 0.6 ? "#d0a24c" : "#4caf50";
}

// Reproduce-readiness ramp: dim violet (far from the division gate) ->
// bright green (ready to divide). Distinct from the red->green health
// ramp so the two overlays read differently at a glance.
function reproduceColor(frac: number): string {
  const f = frac < 0 ? 0 : frac > 1 ? 1 : frac;
  const r = Math.round(120 - 60 * f);
  const g = Math.round(60 + 180 * f);
  const b = Math.round(160 - 80 * f);
  return `rgb(${r},${g},${b})`;
}

function reproduceReadiness(genome: Uint8Array, c: CellVals): number | null {
  let total = c.energy;
  for (const k of MOLECULE_IDS) total += c.molecules[k];
  let found: number | null = null;
  let i = 0, inGene = false, gStart = 0;
  while (i < genome.length) {
    const op = genome[i];
    if (!inGene) { if (op === OP.GENE) { inGene = true; gStart = i + 1; } i += 1; continue; }
    if (op === OP.END) {
      const r = readinessInGene(genome, gStart, i, c, total);
      if (r !== null) found = found === null ? r : Math.max(found, r);
      inGene = false; i += 1; continue;
    }
    i += 1 + OPERANDS[op];
  }
  return found;
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
  // SYNTH kinds observed: BOND / COMPETENCE / PACKAGE are the
  // single-bit kinds; CAT / INH carry a reaction-slot param.
  let bondSet = false, competenceSet = false, packageSet = false;
  const catalystSlots = new Set<number>();
  const inhibitorSlots = new Set<number>();
  // INGEST is the 6-slot sensor-chem id (min/biop/fa/o2/co2/glu);
  // EXCRETE is operand mod CHEMICAL_COUNT (any chem in the table).
  const ingest = new Set<number>();
  const excrete = new Set<number>();
  const emits = new Set<number>();
  // Chem ids the genome reads via SENSE_CHEMICAL.
  const sensedChems = new Set<number>();
  walkGenome(genome, (op, pc, operand) => {
    switch (op) {
      case OP.THRUST: thrust = true; break;
      case OP.TURN: turn = true; break;
      case OP.REPRODUCE: reproduce = true; break;
      case OP.PREDATE: predate = true; break;
      case OP.ENGULF: engulf = true; break;
      case OP.POKE_BYTE: case OP.SPLICE_DUP: case OP.SPLICE_DEL: selfModifies = true; break;
      case OP.SYNTH: {
        const kind = (operand ?? 0) % SYNTH_KIND_COUNT;
        const param = genome[(pc + 2) % genome.length] ?? 0;
        if (kind === SYNTH_KIND.CAT) catalystSlots.add(param % CATALYST_COUNT);
        else if (kind === SYNTH_KIND.INH) inhibitorSlots.add(param % CATALYST_COUNT);
        else if (kind === SYNTH_KIND.BOND) bondSet = true;
        else if (kind === SYNTH_KIND.COMPETENCE) competenceSet = true;
        else if (kind === SYNTH_KIND.PACKAGE) packageSet = true;
        break;
      }
      case OP.INGEST: ingest.add((operand ?? 0) % 6); break;
      case OP.EXCRETE: excrete.add((operand ?? 0) % 96); break;
      case OP.EMIT: emits.add(operand ?? 0); break;
      case OP.SENSE_CHEMICAL: sensedChems.add((operand ?? 0) % 96); break;
      case OP.JZ: case OP.JNZ: hasJump = true; break;
      case OP.LT: case OP.GT: case OP.EQ: case OP.NOT: case OP.AND: case OP.OR: hasCmp = true; break;
    }
  });
  const gated = hasJump && hasCmp;
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

  // Metabolism: every named bootstrap reaction (aerobic / ferment /
  // betaOx / photosynth / synth_* / digest_biop / membrane) fires on
  // every cell at uncatRate by default. The genome's metabolic
  // identity is which slots it BOOSTS above that baseline via
  // SYNTH CAT, plus any DAMPING via SYNTH INH.
  const metab: string[] = ["named bootstrap reactions (all run at baseline)"];
  if (bondSet) metab.push("BOND-adhesive");
  if (competenceSet) metab.push("COMPETENT (eDNA uptake)");
  if (packageSet) metab.push("PACKAGE-shedding (sheds genome fragments)");
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
  // Inhibitors: each SYNTH INH <slot> damps reaction slot N.
  if (inhibitorSlots.size > 0) {
    const slots = Array.from(inhibitorSlots).sort((a, b) => a - b).map(reactionName);
    lines.push(`Inhibitors damp: ${slots.join(", ")}.`);
  }

  // Excretes: EXCRETE operand mod CHEMICAL_COUNT picks any chem id.
  // Bootstrap chems get named; procedural chems show as "chemN".
  if (excrete.size > 0) {
    const names = Array.from(excrete).sort((a, b) => a - b).map(chemName);
    lines.push(`Excretes: ${names.join(", ")}.`);
  } else {
    lines.push(`Excretes: nothing (plus passive CO2/waste auto-vent).`);
  }

  // Emits: OP.EMIT broadcasts an active signal (costs ATP) on a channel.
  if (emits.size > 0) {
    const names = Array.from(emits).map(emitChannelName);
    lines.push(`Emits: ${[...new Set(names)].join(", ")} signal(s) (active, ATP-costed).`);
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

