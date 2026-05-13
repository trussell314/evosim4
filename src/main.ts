import "./style.css";
import { createWorld, MATERIALS, MATERIAL_IDS_ORDERED, MOLECULE_IDS, step, surfaceYAt, surfaceActivity, temperatureAt, makeProfile, solarLight, type Particle, type Creature, type Species } from "./sim";
import { disassemble, walkGenome, OP } from "./genome";

const root = document.querySelector<HTMLDivElement>("#app")!;
const canvas = document.createElement("canvas");
root.appendChild(canvas);
const ctx = canvas.getContext("2d")!;

// HUD: a wrapper holding a minimize button and the inspector pre. Click the
// button to collapse to just the button; click again to expand.
const hud = document.createElement("div");
hud.style.cssText =
  "position:fixed;top:8px;left:8px;color:#9ee;background:rgba(0,0,0,.45);" +
  "border-radius:4px;font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;" +
  "max-height:80vh;overflow:hidden;";
const hudBar = document.createElement("div");
hudBar.style.cssText =
  "display:flex;justify-content:space-between;align-items:center;padding:2px 4px;" +
  "cursor:pointer;user-select:none;color:#9ee;gap:8px;";
// Live stats shown on the bar even when the HUD body is collapsed.
// Updated by updateInspector() each frame.
const hudStats = document.createElement("span");
hudStats.style.cssText = "padding:0 4px;font:inherit;";
hudStats.textContent = "fps=--  sim=--x  t=0s";
const hudToggle = document.createElement("span");
hudToggle.textContent = "[+]";
hudToggle.style.cssText = "padding:0 4px;";
hudBar.appendChild(hudStats);
hudBar.appendChild(hudToggle);
// Per-frame timing, always visible (even when the inspector body is
// collapsed) so render/sim budget is glanceable while iterating.
const hudTimings = document.createElement("div");
hudTimings.style.cssText = "padding:0 8px 2px;color:#9ee;font:inherit;";
hudTimings.textContent = "r=--ms  s=--ms";
// Stall + error indicator: visible from the bar so mobile users
// can see at a glance whether sim is paused / world is empty /
// last step threw. Hidden by default; shown only when something
// useful is going on.
const hudDiag = document.createElement("div");
hudDiag.style.cssText = "padding:0 8px 2px;color:#f88;font:inherit;display:none;";
// The expanded body uses a smaller font than the always-visible
// bar -- the inspector pre is dense and reads better tighter.
const EXPANDED_FONT = "font:9px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;";
const inspector = document.createElement("pre");
inspector.style.cssText =
  `margin:0;padding:0 9px 6px;color:#9ee;white-space:pre;${EXPANDED_FONT}`;
// Disasm gets its own collapsible section: it's much longer than the
// rest of the inspector and almost never wanted at-a-glance. Click the
// "[show disasm]" header to expand.
const disasmHeader = document.createElement("div");
disasmHeader.style.cssText =
  `padding:2px 9px 4px;cursor:pointer;user-select:none;color:#9ee;${EXPANDED_FONT}`;
disasmHeader.textContent = "[+] show disasm";
const disasmBody = document.createElement("pre");
disasmBody.style.cssText =
  `margin:0;padding:0 9px 6px;color:#9ee;white-space:pre;display:none;${EXPANDED_FONT}`;
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
const world = createWorld(WORLD_SIZE.w, WORLD_SIZE.h);

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

// Track the selected cell by reference, not index. world.creatures
// gets fully rebuilt each tick (death/engulf removes plus released
// vacuole prey appends), so any cached numeric index goes stale
// silently -- you'd click cell 5 and find yourself looking at a
// totally different creature on the next tick.
let selectedCell: Creature | null = null;
let activeDisasm = "";
function refreshActiveDisasm(): void {
  activeDisasm = selectedCell
    ? formatDisasmColumns(disassemble(selectedCell.genome, MATERIAL_IDS_ORDERED), DISASM_COL_LINES)
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
// Reused per-frame to avoid allocating fresh arrays/maps inside the
// phylogeny render loop. With thousands of species after a long run,
// per-frame Array.from() + Map() was costing meaningful GC pressure.
const visibleSpecies: Species[] = [];
const bioByKey = new Map<string, number>();

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
analysisPanel.appendChild(analysisHeader);
analysisPanel.appendChild(analysisBody);
root.appendChild(analysisPanel);
// When minimized, hide the title text so just the [+] sits in the tab.
analysisTitle.style.display = "none";
analysisHeader.addEventListener("click", () => {
  analysisMinimized = !analysisMinimized;
  analysisPanel.style.width = (analysisMinimized ? ANALYSIS_PANEL_W_MIN : ANALYSIS_PANEL_W) + "px";
  analysisBody.style.display = analysisMinimized ? "none" : "";
  analysisToggle.textContent = analysisMinimized ? "+" : "–";
  analysisTitle.style.display = analysisMinimized ? "none" : "";
  analysisHeader.style.justifyContent = analysisMinimized ? "center" : "space-between";
  analysisHeader.style.padding = analysisMinimized ? "6px 4px" : "6px 8px";
  resize();
});

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
}
resize();
window.addEventListener("resize", resize);
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", resize);
  window.visualViewport.addEventListener("scroll", resize);
}

// Linear scan over creatures; bounded by MAX_CREATURES so cost is small.
function findCellAt(x: number, y: number): number {
  let best = -1;
  let bestSq = Infinity;
  for (let i = 0; i < world.creatures.length; i++) {
    const c = world.creatures[i];
    const dx = c.x - x;
    const dy = c.y - y;
    const d = dx * dx + dy * dy;
    const reach = (c.r + 8) * (c.r + 8);
    if (d < bestSq && d < reach) { bestSq = d; best = i; }
  }
  return best;
}
// Canvas (CSS) pixel coords -> world coords, inverse of the view
// transform set in resize(). Used by click + hover so cells under
// the pointer match regardless of browser zoom / window size.
function canvasToWorld(cx: number, cy: number): { x: number; y: number } {
  return {
    x: (cx - viewOffsetX) / viewScale,
    y: (cy - viewOffsetY) / viewScale,
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
    selectedCell = world.creatures[best];
    refreshActiveDisasm();
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
// Mousemove can fire 200-1000Hz on some devices. We coalesce per
// requestAnimationFrame so the cell scan + tooltip rewrite happens at
// most once per render frame.
let pendingMouseX = -1;
let pendingMouseY = -1;
let pendingMouseInside = false;
let pendingMouseClient = { x: 0, y: 0 };
let tooltipScheduled = false;
function flushTooltip(): void {
  tooltipScheduled = false;
  if (!pendingMouseInside) { tooltip.style.display = "none"; return; }
  const idx = findCellAt(pendingMouseX, pendingMouseY);
  if (idx < 0) { tooltip.style.display = "none"; return; }
  const c = world.creatures[idx];
  let mass = c.energy;
  for (const id of MATERIAL_IDS_ORDERED) mass += c.reserves[id];
  for (const mk of MOLECULE_IDS) mass += c.molecules[mk];
  const age = formatAge(Math.max(0, world.t - c.bornAt));
  tooltip.innerHTML =
    `<span style="display:inline-block;width:8px;height:8px;background:${c.color};border:1px solid #fff;vertical-align:middle;margin-right:4px"></span>` +
    `age=${age}\n` +
    `ATP=${c.energy.toFixed(0)}  bio=${c.molecules.biomass.toFixed(0)}  mass=${mass.toFixed(0)}\n` +
    `genome=${c.genome.length}b`;
  tooltip.style.display = "block";
  tooltip.style.left = `${pendingMouseClient.x + 12}px`;
  tooltip.style.top = `${pendingMouseClient.y + 12}px`;
}
canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  const wpt = canvasToWorld(e.clientX - rect.left, e.clientY - rect.top);
  pendingMouseX = wpt.x;
  pendingMouseY = wpt.y;
  pendingMouseClient = { x: e.clientX, y: e.clientY };
  pendingMouseInside = true;
  if (!tooltipScheduled) {
    tooltipScheduled = true;
    requestAnimationFrame(flushTooltip);
  }
});
canvas.addEventListener("mouseleave", () => {
  pendingMouseInside = false;
  if (!tooltipScheduled) {
    tooltipScheduled = true;
    requestAnimationFrame(flushTooltip);
  }
});

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
// One sub-bucket per (depth bucket, material) so the renderer can issue
// a single beginPath + many arcs + single fill per group. With 12k+
// particles, dropping from one canvas op per particle to one per group
// is a big speedup -- arc/fill/beginPath are expensive when called in
// the millions per second.
const N_MATERIALS = 6;
const SUB_BUCKETS: Particle[][] = Array.from({ length: N_BUCKETS * N_MATERIALS }, () => []);
const MATERIAL_IDX_BY_NAME: Record<string, number> = {};
for (let i = 0; i < MATERIAL_IDS_ORDERED.length; i++) MATERIAL_IDX_BY_NAME[MATERIAL_IDS_ORDERED[i]] = i;
// How much each bucket is tinted toward the deep-water color. 0 = no tint
// (use material color as-is); 1 = fully replaced by background.
const DEPTH_TINTS = [0, 0.025, 0.06, 0.11, 0.17, 0.23, 0.29, 0.35];
const DEEP_TINT_R = 6;
const DEEP_TINT_G = 21;
const DEEP_TINT_B = 32; // matches the bottom of the water gradient (#061520)

function blendToward(hex: string, frac: number): string {
  // Parse "#rrggbb" and blend toward the deep-water tint by frac.
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const br = Math.round(r + (DEEP_TINT_R - r) * frac);
  const bg = Math.round(g + (DEEP_TINT_G - g) * frac);
  const bb = Math.round(b + (DEEP_TINT_B - b) * frac);
  return `rgb(${br},${bg},${bb})`;
}
// Pre-compute tinted material colors per bucket so the render loop just
// looks them up instead of parsing strings every frame.
const TINTED_COLORS: Record<string, string[]> = {};
for (const matId of MATERIAL_IDS_ORDERED) {
  const base = MATERIALS[matId].color;
  TINTED_COLORS[matId] = DEPTH_TINTS.map((t) => blendToward(base, t));
}
// Toxic-waste-tagged particles get rendered in a sickly rust color
// rather than their underlying material color, so the player can see
// where pollution accumulates. Routed by waste molecule fraction.
const TOXIC_BUCKETS: Particle[][] = Array.from({ length: N_BUCKETS }, () => []);
const TOXIC_BASE = "#a04a2a";
const TOXIC_TINTED = DEPTH_TINTS.map((t) => blendToward(TOXIC_BASE, t));
const TOXIC_WASTE_FRAC = 0.5;

// Map water temperature (°C) to a tint. Warm = lighter cyan, cool = deep
// dark blue. Chosen so 20°C lands near the original water palette.
// Lerp a "#rrggbb" hex color toward (tr, tg, tb) by `frac`.
// Returns an "rgb(r,g,b)" string. Used by the obstacle renderer to
// compute lighter top and darker bottom stops in one helper.
function hexLerp(hex: string, tr: number, tg: number, tb: number, frac: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lr = Math.round(r + (tr - r) * frac);
  const lg = Math.round(g + (tg - g) * frac);
  const lb = Math.round(b + (tb - b) * frac);
  return `rgb(${lr},${lg},${lb})`;
}

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

// Spray droplets: transient render-only entities that spawn at wave
// crests, arc above the water line under gravity, and disappear when
// they fall back into the surface. Pure visual; the splash physics
// in sim.ts still kicks particles upward, this just makes the effect
// readable. Lives in render so it doesn't fight the sim's fixed dt.
type Droplet = { x: number; y: number; vx: number; vy: number; r: number; life: number };
const droplets: Droplet[] = [];
const DROPLET_RATE_PER_SEC = 30;     // spawn budget at activity = 1
const DROPLET_MIN_CREST = 1;         // px above mean surface
const DROPLET_GRAVITY = 280;         // px/s^2; independent of world.gravity
let lastDropletTime = performance.now();

function updateDroplets(): void {
  const nowWall = performance.now();
  let dt = (nowWall - lastDropletTime) / 1000;
  if (dt > 0.1) dt = 0.1; // clamp after pauses / tab returns
  lastDropletTime = nowWall;

  const act = surfaceActivity(world);
  const expected = DROPLET_RATE_PER_SEC * act * dt;
  let n = Math.floor(expected);
  if (Math.random() < expected - n) n++;
  for (let i = 0; i < n; i++) {
    // Sample a random x; only spawn if that point is above mean
    // surface (i.e., on a crest). Otherwise skip -- keeps spray
    // visually correlated with where the waves actually peak.
    const x = Math.random() * world.width;
    const surfY = surfaceYAt(world, x);
    if (surfY > world.surfaceY - DROPLET_MIN_CREST) continue;
    droplets.push({
      x,
      y: surfY,
      vx: (Math.random() - 0.5) * 50,
      vy: -50 - Math.random() * 80,
      r: 0.8 + Math.random() * 1.4,
      life: 1.2 + Math.random() * 0.6,
    });
  }
  for (let i = droplets.length - 1; i >= 0; i--) {
    const d = droplets[i];
    d.vy += DROPLET_GRAVITY * dt;
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    d.life -= dt;
    // Pop if life ran out or droplet fell back into the surface.
    const surfHere = surfaceYAt(world, d.x);
    if (d.life <= 0 || d.y > surfHere) {
      droplets[i] = droplets[droplets.length - 1];
      droplets.pop();
    }
  }
}

function drawDroplets(): void {
  if (droplets.length === 0) return;
  // Single beginPath/fill batches all droplets into one draw call.
  ctx.fillStyle = "rgba(220, 240, 255, 0.85)";
  ctx.beginPath();
  for (const d of droplets) {
    ctx.moveTo(d.x + d.r, d.y);
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
  }
  ctx.fill();
}

// Sample the wavy surface at intervals; sim.surfaceYAt is the shared
// source of truth so the rendered line matches the physical wall.
const SURFACE_VIS_STEP = 3;

function render(): void {
  const { width, height, depth, surfaceY } = world;
  // Day/night tint applied to both surface and depth water colors so
  // the whole scene gets dimmer at night. 1 = full day, ~0.4 = deep
  // night (we don't go fully black so creatures stay visible).
  const dayMult = 0.4 + 0.6 * solarLight(world);
  const tWarm = darkenColor(tempToColor(world.tempSurface), dayMult);
  const tCool = darkenColor(tempToColor(world.tempBottom), dayMult);

  // Clear the full canvas (letterbox color), then apply the view
  // transform so subsequent draws use world coords. DPR is folded into
  // the same matrix so a single setTransform suffices.
  const dpr = getDpr();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  ctx.setTransform(dpr * viewScale, 0, 0, dpr * viewScale, dpr * viewOffsetX, dpr * viewOffsetY);

  // Atmosphere band -- fill above the wavy surface line. Darkened with
  // the same day/night multiplier as the water so the whole scene dims.
  ctx.fillStyle = darkenColor("rgb(10,22,32)", dayMult);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(width, 0);
  ctx.lineTo(width, surfaceYAt(world,width));
  for (let x = width; x >= 0; x -= SURFACE_VIS_STEP) ctx.lineTo(x, surfaceYAt(world,x));
  ctx.closePath();
  ctx.fill();

  // Water column -- fill below the wavy surface line.
  const grad = ctx.createLinearGradient(0, surfaceY, 0, height);
  grad.addColorStop(0, tWarm);
  grad.addColorStop(1, tCool);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(0, surfaceYAt(world,0));
  for (let x = SURFACE_VIS_STEP; x <= width; x += SURFACE_VIS_STEP) ctx.lineTo(x, surfaceYAt(world,x));
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
  ctx.moveTo(0, surfaceYAt(world,0));
  for (let x = SURFACE_VIS_STEP; x <= width; x += SURFACE_VIS_STEP) ctx.lineTo(x, surfaceYAt(world,x));
  ctx.stroke();

  for (const b of SUB_BUCKETS) b.length = 0;
  for (const b of TOXIC_BUCKETS) b.length = 0;
  const matIdx: Record<string, number> = MATERIAL_IDX_BY_NAME;
  for (const p of world.particles) {
    const t = Math.min(0.999, Math.max(0, p.z / depth));
    const bucket = Math.floor(t * N_BUCKETS);
    // Tag-toxic check: a molecule-tagged particle whose waste fraction
    // is high enough renders in the toxic palette, regardless of its
    // underlying material id.
    if (p.molecules && p.molecules.waste > 0) {
      let total = 0;
      const m = p.molecules;
      total += m.glucose + m.fattyAcid + m.aminoAcid + m.minerals
        + m.o2 + m.co2 + m.waste + m.adp + m.chlorophyll + m.enzyme + m.biomass;
      if (total > 0 && m.waste / total >= TOXIC_WASTE_FRAC) {
        TOXIC_BUCKETS[bucket].push(p);
        continue;
      }
    }
    SUB_BUCKETS[bucket * N_MATERIALS + matIdx[p.material]].push(p);
  }
  const tinted = TINTED_COLORS;
  for (let i = N_RENDER_BUCKETS - 1; i >= 0; i--) {
    ctx.filter = BLURS[i] === 0 ? "none" : `blur(${BLURS[i]}px)`;
    ctx.globalAlpha = ALPHAS[i];
    for (let m = 0; m < N_MATERIALS; m++) {
      const group = SUB_BUCKETS[i * N_MATERIALS + m];
      if (group.length === 0) continue;
      const matName = MATERIAL_IDS_ORDERED[m];
      ctx.fillStyle = tinted[matName][i];
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

  // Spray droplets render above particles (they're flying above the
  // water line) but below cells.
  drawDroplets();

  for (let i = 0; i < world.creatures.length; i++) {
    drawCreature(world.creatures[i], world.creatures[i] === selectedCell);
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
type HeatmapMode = "off" | "temp" | "density" | "pheromone";
let heatmapMode: HeatmapMode = "off";
const HEATMAP_CELL = 32;
const HEATMAP_ALPHA = 0.28;
window.addEventListener("keydown", (e) => {
  if (e.key === "h" || e.key === "H") {
    heatmapMode =
      heatmapMode === "off" ? "temp" :
      heatmapMode === "temp" ? "density" :
      heatmapMode === "density" ? "pheromone" : "off";
  } else if (e.key === "p" || e.key === "P") {
    if (world.profile) {
      dumpProfile();
      world.profile = undefined;
    } else {
      world.profile = makeProfile();
    }
  }
});

function dumpProfile(): void {
  const p = world.profile;
  if (!p || p.ticks === 0) return;
  const n = p.ticks;
  const rows: { phase: string; ms: number }[] = [
    { phase: "pheromone", ms: p.pheromone / n },
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
  console.log(`[profile] over ${n} ticks  total=${total.toFixed(3)}ms/tick  pop=${world.creatures.length}  particles=${world.particles.length}`);
  for (const r of rows) {
    const pct = total > 0 ? (100 * r.ms / total).toFixed(1) : "0.0";
    // eslint-disable-next-line no-console
    console.log(`  ${r.phase.padEnd(22)} ${r.ms.toFixed(3)}ms  ${pct}%`);
  }
}
function drawHeatmap(): void {
  if (heatmapMode === "off") return;
  const { width, height, surfaceY } = world;
  const cell = HEATMAP_CELL;
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil((height - surfaceY) / cell);
  ctx.globalAlpha = HEATMAP_ALPHA;
  if (heatmapMode === "temp") {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * cell;
        const y = surfaceY + r * cell;
        const t = temperatureAt(world, x + cell / 2, y + cell / 2);
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
  for (const p of world.particles) {
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
  if (heatmapMode === "pheromone") {
    // Render pheromone field directly. Grid size is world.pheromoneCols/Rows.
    let maxP = 0.001;
    for (let i = 0; i < world.pheromone.length; i++) if (world.pheromone[i] > maxP) maxP = world.pheromone[i];
    const pCols = world.pheromoneCols;
    const pRows = world.pheromoneRows;
    const pCell = world.width / pCols;
    ctx.globalAlpha = HEATMAP_ALPHA;
    for (let r = 0; r < pRows; r++) {
      for (let c = 0; c < pCols; c++) {
        const v = world.pheromone[r * pCols + c];
        if (v <= 0) continue;
        ctx.fillStyle = heatColorPheromone(v / maxP);
        ctx.fillRect(c * pCell, r * pCell, pCell, pCell);
      }
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.fillText(`heatmap: pheromone field (max ${maxP.toFixed(1)}, H toggles)`, 8, surfaceY + 14);
  }
}

function heatColorPheromone(x: number): string {
  // Cool purple → bright magenta gradient. Distinct from density yellow.
  const r = Math.round(60 + 200 * x);
  const g = Math.round(20 + 60 * x);
  const b = Math.round(80 + 175 * x);
  return `rgb(${r},${g},${b})`;
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
  const cs = world.creatures;
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
  const tNow = world.t;
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
  for (const sp of world.species.values()) {
    if (sp.lastSeen >= tMin) visibleSpecies.push(sp);
  }
  visibleSpecies.sort((a, b) => a.lane - b.lane);
  const visible = visibleSpecies;

  // Per-species live biomass. Use c.speciesKey (frozen at birth) instead
  // of recomputing genomeKey each frame -- somatic drift doesn't move a
  // cell to a different species, so the birth key is the right bucket.
  bioByKey.clear();
  for (const c of world.creatures) {
    bioByKey.set(c.speciesKey, (bioByKey.get(c.speciesKey) ?? 0) + c.molecules.biomass);
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
  for (const ev of world.phylogenyEvents) {
    const from = world.species.get(ev.from);
    const to = world.species.get(ev.to);
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
  ctx.fillText(
    `phylogeny  t=${tMin.toFixed(0)}..${tNow.toFixed(0)}s  ${visible.length} species  (height ~ biomass, yellow = convergence)`,
    8,
    stripY + 11,
  );
}

// Every cell wears a thin white outline on its wobbly body. Selected
// cells get a thicker version of the same line so selection reads as
// "the same cell, just emphasized."
function strokeCellOutline(
  cx: number, cy: number, r: number, selected: boolean, t: number, phase: number,
): void {
  ctx.strokeStyle = selected ? "#ffffff" : "#000000";
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
  for (const ob of world.obstacles) {
    const grad = octx.createLinearGradient(0, ob.minY, 0, ob.maxY);
    grad.addColorStop(0, hexLerp(ob.color, 255, 255, 255, 0.20));
    grad.addColorStop(0.4, ob.color);
    grad.addColorStop(1, hexLerp(ob.color, 0, 0, 0, 0.45));
    octx.fillStyle = grad;
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
    octx.strokeStyle = hexLerp(ob.color, 0, 0, 0, 0.55);
    octx.lineWidth = 1;
    octx.stroke();
  }
  terrainBitmap = off;
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

function drawCreature(c: Creature, selected: boolean): void {
  // Each cell has a stable random phase derived from its bornAt + position,
  // so its wobble pattern is its own instead of every cell pulsing in sync.
  const phase = c.bornAt * 0.7 + c.x * 0.013 + c.y * 0.019;
  const t = world.t;
  const screenR = c.r * viewScale;
  const lod = !selected && screenR < LOD_MIN_SCREEN_R;
  if (c.division) {
    // Mitosis: render two overlapping wobbly bodies whose centers split
    // along the division axis as `progress` advances 0 -> 1.
    const child = c.division.child;
    const sep = c.division.progress * (c.r + child.r);
    const dx = Math.cos(c.division.axis) * sep * 0.5;
    const dy = Math.sin(c.division.axis) * sep * 0.5;
    if (lod) {
      drawCellLOD(c.x - dx, c.y - dy, c.r, c.color);
      drawCellLOD(c.x + dx, c.y + dy, child.r, child.color);
    } else {
      drawCellBody(c.x - dx, c.y - dy, c.r, c.color, t, phase);
      strokeCellOutline(c.x - dx, c.y - dy, c.r, selected, t, phase);
      drawCellBody(c.x + dx, c.y + dy, child.r, child.color, t, phase + 1.7);
      strokeCellOutline(c.x + dx, c.y + dy, child.r, selected, t, phase + 1.7);
    }
  } else if (lod) {
    drawCellLOD(c.x, c.y, c.r, c.color);
  } else {
    drawCellBody(c.x, c.y, c.r, c.color, t, phase);
    strokeCellOutline(c.x, c.y, c.r, selected, t, phase);
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
  // lineages: total live cells, distinct genomes among currently-
  // alive cells, distinct founding lineages (lineageRoot ids).
  // world.species.size would over-count -- it includes extinct
  // species still in the 4-minute prune grace window.
  const liveLineages = new Set<number>();
  const liveSpecies = new Set<string>();
  for (const c of world.creatures) {
    liveLineages.add(c.lineageRoot);
    liveSpecies.add(c.speciesKey);
  }
  hudStats.textContent =
    `fps=${perfFps.toFixed(0)}  sim=${perfSimRate.toFixed(1)}x  ` +
    `t=${formatAge(world.t)}  pop=${world.creatures.length}/${liveSpecies.size}/${liveLineages.size}  ` +
    `extinct=${world.extinctionCount}`;
  hudTimings.textContent =
    `r=${perfRenderMs.toFixed(1)}ms  s=${perfSimMs.toFixed(1)}ms`;
  // If the selected cell has died or been eaten, fall back to the first
  // live creature so the inspector shows something useful instead of
  // silently going blank.
  if (!selectedCell || world.creatures.indexOf(selectedCell) < 0) {
    selectedCell = world.creatures[0] ?? null;
  }
  // Always re-disassemble: the selected cell's genome can change between
  // frames from somatic mutation, so a cached string would go stale.
  refreshActiveDisasm();
  const c = selectedCell;
  if (!c) {
    inspector.textContent = `${statsLine()}\npop=0  particles=${world.particles.length}`;
    return;
  }
  let reserveMass = 0;
  for (const id of MATERIAL_IDS_ORDERED) reserveMass += c.reserves[id];
  let molMass = c.energy;
  for (const k of MOLECULE_IDS) molMass += c.molecules[k];
  const totalMass = reserveMass + molMass;
  const reserves = MATERIAL_IDS_ORDERED
    .map((id) => `${id.slice(0, 3)}=${c.reserves[id].toFixed(0)}`)
    .join(" ");
  const m = c.molecules;
  const fmt = (x: number) => x.toFixed(0);
  const stackStr = c.vm.stack.map((n) => n.toFixed(1)).join(" ");
  const age = formatAge(Math.max(0, world.t - c.bornAt));
  inspector.textContent =
    `${statsLine()}\n` +
    `pop=${world.creatures.length}  parts=${world.particles.length}/${world.particleTarget}  extinct=${world.extinctionCount}  (click a cell)\n` +
    `age=${age}  pos=(${c.x.toFixed(0)},${c.y.toFixed(0)},${c.z.toFixed(1)})  ` +
    `vel=(${c.vx.toFixed(1)},${c.vy.toFixed(1)})\n` +
    `r=${c.r.toFixed(1)}  mass=${totalMass.toFixed(0)}  ATP=${c.energy.toFixed(0)}  ADP=${fmt(m.adp)}\n` +
    `ingestCD=${c.ingestCooldown.toFixed(2)}s\n` +
    `food: glu=${fmt(m.glucose)} fa=${fmt(m.fattyAcid)} aa=${fmt(m.aminoAcid)} min=${fmt(m.minerals)}\n` +
    `gas:  O2=${fmt(m.o2)} CO2=${fmt(m.co2)} waste=${fmt(m.waste)}\n` +
    `cell: chl=${fmt(m.chlorophyll)} enz=${fmt(m.enzyme)} rib=${fmt(m.ribosome)} bio=${fmt(m.biomass)}\n` +
    `stomach: ${reserves}\n` +
    (c.contents.length > 0 ? `vacuole: ${c.contents.length} engulfed cell(s)\n` : "") +
    `pc=${c.vm.pc}  genome=${c.genome.length}b  stack=[${stackStr}]`;
  disasmBody.textContent = activeDisasm;
}

// Sim runs at maximum speed but the renderer is paced to hit 60fps.
// Each frame: measure how long the render + inspector took last time;
// give the sim whatever budget remains in the 16.6ms slot (with a 2ms
// safety margin for browser overhead). When CPU-constrained the sim
// just does fewer ticks per render; render still hits 60fps.
const FIXED_DT = 1 / 60;
const TARGET_FRAME_MS = 16.6;

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
  let s = `fps=${perfFps.toFixed(0)}  sim=${perfSimRate.toFixed(1)}x  t=${world.t.toFixed(0)}s  species=${world.species.size}`;
  const p = world.profile;
  if (p && p.ticks > 0) {
    const total =
      p.pheromone + p.bonds + p.forces + p.creatures +
      p.particleColl + p.creatureColl + p.sedimentColl + p.obstacleColl +
      p.walls + p.aerate + p.replenish + p.prune;
    s += `  [prof ${ (total / p.ticks).toFixed(2) }ms/tick over ${p.ticks}t]`;
  }
  return s;
}

// Sim and render are decoupled. Render is on rAF (vsync). Sim runs
// in a MessageChannel macrotask that *chains*: every onmessage posts
// the next one, so sim fills the gap between vsyncs with whatever
// budget remains (gated by sliceDeadline + frameDeadline checks).
//
// Earlier we tried "one macrotask per rAF" to break a suspected
// rAF-starvation cause of 30fps lock. Data showed r+s well under
// vsync but still 30fps -- so the lock was browser/OS rate-limiting
// (mobile thermal/power throttling, vsync clamp hysteresis), not us.
// Removing the chain hurt sim throughput by ~3x with no fps benefit.
const SIM_SLICE_MS = 6;
const FRAME_OVERHEAD_FOR_SIM_MS = 3;
const simChannel = new MessageChannel();
let lastFrameStart = performance.now();
let advancedThisFrame = 0;
let simMsThisFrame = 0;
// Worst recent step() duration in ms, with slow decay. Used to refuse
// to *start* a step that would overshoot the per-frame deadline.
let recentStepMs = 1.5;
const RECENT_STEP_DECAY = 0.97;
const STEP_BUDGET_SAFETY = 1.4;
// Surface step() errors on the HUD so mobile users can see them
// without opening a console.
let lastSimError: string | null = null;
let lastSimErrorAt = 0;
simChannel.port1.onmessage = () => {
  const sliceDeadline = performance.now() + SIM_SLICE_MS;
  const frameDeadline = lastFrameStart + (TARGET_FRAME_MS - FRAME_OVERHEAD_FOR_SIM_MS);
  let ranOne = false;
  while (performance.now() < sliceDeadline) {
    const t0 = performance.now();
    // Always run at least one step per frame so sim can never stall
    // permanently. The overshoot guard only applies to *additional*
    // steps -- if recentStepMs spikes once we still make forward
    // progress, and the spike decays back to normal as steps run.
    if (ranOne && t0 + recentStepMs * STEP_BUDGET_SAFETY > frameDeadline) break;
    try {
      step(world, FIXED_DT);
    } catch (err) {
      lastSimError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      lastSimErrorAt = world.t;
      // eslint-disable-next-line no-console
      console.error("[sim] step threw, continuing:", err);
      break;
    }
    advancedThisFrame += FIXED_DT;
    ranOne = true;
    const elapsed = performance.now() - t0;
    simMsThisFrame += elapsed;
    recentStepMs = elapsed > recentStepMs ? elapsed : recentStepMs * RECENT_STEP_DECAY;
  }
  // Chain: post the next macrotask so sim fills the gap between
  // vsyncs. frame() also posts one per rAF as an initial kick.
  simChannel.port2.postMessage(null);
};
simChannel.port2.postMessage(null);

function frame(): void {
  lastFrameStart = performance.now();
  const simMsLast = simMsThisFrame;
  simMsThisFrame = 0;
  const advanced = advancedThisFrame;
  advancedThisFrame = 0;
  const tBeforeRender = performance.now();
  updateDroplets();
  render();
  updateInspector();
  maybeAnalyzeGenomes();
  const renderMs = performance.now() - tBeforeRender;
  updatePerfStats(advanced, renderMs, simMsLast);
  updateDiagBar();
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
  if (world.t !== stallWatchT) {
    stallWatchT = world.t;
    stallWatchWall = nowWall;
  }
  const stalledMs = nowWall - stallWatchWall;
  const parts: string[] = [];
  if (stalledMs > STALL_WALL_MS) {
    parts.push(`SIM STALLED ${(stalledMs / 1000).toFixed(1)}s  pop=${world.creatures.length}  parts=${world.particles.length}`);
  }
  if (lastSimError) {
    parts.push(`step err @ t=${lastSimErrorAt.toFixed(0)}s: ${lastSimError.slice(0, 120)}`);
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
function maybeAnalyzeGenomes(): void {
  if (world.t - lastAnalysisT < ANALYSIS_INTERVAL_SEC) return;
  lastAnalysisT = world.t;

  // Per-species live biomass aggregation. world.species.alive already
  // tracks cell counts; we walk world.creatures to sum biomass.
  const liveBiomass = new Map<string, number>();
  for (const c of world.creatures) {
    liveBiomass.set(c.speciesKey, (liveBiomass.get(c.speciesKey) ?? 0) + c.molecules.biomass);
  }

  type Row = {
    sp: Species;
    alive: boolean;
    duration: number;
    biomass: number;
    cells: number;
  };
  const rows: Row[] = [];
  for (const sp of world.species.values()) {
    const alive = sp.alive > 0;
    const duration = (alive ? world.t : sp.lastSeen) - sp.firstSeen;
    rows.push({
      sp,
      alive,
      duration,
      biomass: liveBiomass.get(sp.key) ?? 0,
      cells: sp.alive,
    });
  }
  rows.sort((a, b) => {
    if (b.duration !== a.duration) return b.duration - a.duration;
    if (b.biomass !== a.biomass) return b.biomass - a.biomass;
    if (b.cells !== a.cells) return b.cells - a.cells;
    return a.sp.firstSeen - b.sp.firstSeen; // oldest first as final tiebreaker
  });
  const top = rows.slice(0, 5);

  // Render the panel content fresh each cycle (no append/history --
  // the panel is a current top-5 snapshot, not a log).
  analysisBody.innerHTML = "";
  const header = document.createElement("div");
  header.style.cssText = "padding:6px 0 8px;font-weight:bold;border-bottom:1px solid #1a3340;";
  header.textContent = `Top 5 species at t=${formatAge(world.t)} (across ${world.species.size} tracked)`;
  analysisBody.appendChild(header);

  for (let i = 0; i < top.length; i++) {
    const row = top[i];
    const sp = row.sp;
    const status = row.alive
      ? `ALIVE`
      : `EXTINCT ${formatAge(world.t - sp.lastSeen)} ago`;
    const block = document.createElement("div");
    block.style.cssText = "padding:6px 0;border-bottom:1px solid #1a3340;white-space:pre-wrap;line-height:1.4;";
    const dot = `<span style="display:inline-block;width:8px;height:8px;background:${sp.color};border-radius:50%;margin-right:6px;vertical-align:middle;"></span>`;
    const headLine = `${dot}<b>#${i + 1}</b>  ${sp.key.slice(0, 6)}  duration=${formatAge(row.duration)}  bio=${row.biomass.toFixed(0)}  cells=${row.cells}  ${status}`;
    const prose = describeGenomeProse(sp.genome, MATERIAL_IDS_ORDERED);
    const proseDiv = document.createElement("div");
    proseDiv.style.cssText = "padding-top:3px;";
    proseDiv.textContent = prose;
    const headDiv = document.createElement("div");
    headDiv.innerHTML = headLine;
    block.appendChild(headDiv);
    block.appendChild(proseDiv);
    analysisBody.appendChild(block);
  }
}

// Walk a genome and describe it in plain prose. Same fact extraction
// the disasm uses, but emitted as a 1-2 sentence English summary that
// a human can read at a glance.
function describeGenomeProse(genome: Uint8Array, materialNames: ReadonlyArray<string>): string {
  let thrust = false, turn = false, reproduce = false;
  let predate = false, engulf = false, emit = false, adhere = false;
  let repair = false, selfModifies = false;
  let hasJump = false, hasCmp = false;
  let synthBio = false, synthAA = false, synthFA = false, synthEnz = false, synthChl = false, synthRibo = false;
  const ingest = new Set<number>();
  const excrete = new Set<number>();
  const sensors = new Set<string>();
  // Uses the canonical walker from genome.ts so this stays in lockstep
  // with the VM. Any future op added to genome.ts's OPERANDS table is
  // automatically picked up here.
  walkGenome(genome, (op, _pc, operand) => {
    switch (op) {
      case OP.THRUST: thrust = true; break;
      case OP.TURN: turn = true; break;
      case OP.REPRODUCE: reproduce = true; break;
      case OP.PREDATE: predate = true; break;
      case OP.ENGULF: engulf = true; break;
      case OP.EMIT: emit = true; break;
      case OP.ADHERE: adhere = true; break;
      case OP.REPAIR: repair = true; break;
      case OP.POKE_BYTE: case OP.SPLICE_DUP: case OP.SPLICE_DEL: selfModifies = true; break;
      case OP.SYNTH_BIO: synthBio = true; break;
      case OP.SYNTH_AA: synthAA = true; break;
      case OP.SYNTH_FA: synthFA = true; break;
      case OP.SYNTH_ENZ: synthEnz = true; break;
      case OP.SYNTH_CHL: synthChl = true; break;
      case OP.SYNTH_RIBO: synthRibo = true; break;
      case OP.INGEST: ingest.add((operand ?? 0) % 6); break;
      case OP.EXCRETE: excrete.add((operand ?? 0) % 6); break;
      case OP.JZ: case OP.JNZ: hasJump = true; break;
      case OP.LT: case OP.GT: case OP.EQ: case OP.NOT: case OP.AND: case OP.OR: hasCmp = true; break;
      case OP.SENSE_GRAD_X: case OP.SENSE_GRAD_Y: sensors.add("food gradient"); break;
      case OP.SENSE_DENSITY: sensors.add("crowding"); break;
      case OP.SENSE_LIGHT: sensors.add("light"); break;
      case OP.SENSE_TEMP: sensors.add("temperature"); break;
      case OP.SENSE_PHEROMONE: sensors.add("pheromone"); break;
      case OP.SENSE_WALL_X: case OP.SENSE_WALL_Y: sensors.add("walls"); break;
      case OP.SENSE_HEAD_X: case OP.SENSE_HEAD_Y: sensors.add("heading"); break;
      case OP.SENSE_CRE_DX: case OP.SENSE_CRE_DY:
      case OP.SENSE_CRE_DIST: case OP.SENSE_CRE_MASS: sensors.add("other cells"); break;
      case OP.SENSE_CHEMICAL: sensors.add("chemicals"); break;
      case OP.SENSE_EM: sensors.add("EM/light"); break;
      case OP.SENSE_PRESSURE_X: case OP.SENSE_PRESSURE_Y: sensors.add("pressure"); break;
    }
  });
  const gated = hasJump && hasCmp;
  const mat = (k: number) => materialNames[k] ?? String(k);

  const parts: string[] = [];
  // Trophic mode
  if (predate || engulf) parts.push("Hunts other cells.");
  else if (ingest.size > 0) {
    const list = Array.from(ingest).map(mat).join(" + ");
    parts.push(`Eats ${list}` + (thrust ? " — actively swims toward it." : "; doesn't pursue."));
  } else if (synthChl) parts.push("Photoautotroph: fixes CO2 via chlorophyll, no ingestion.");
  else if (thrust) parts.push("Swims but doesn't eat anything.");
  else parts.push("Drifts passively; no food intake.");
  // Synthesis
  const synth: string[] = [];
  if (synthAA && synthFA && synthBio) synth.push("builds full biomass");
  else {
    if (synthBio) synth.push("makes biomass");
    if (synthAA) synth.push("amino acids");
    if (synthFA) synth.push("fatty acids");
  }
  if (synthChl) synth.push("makes chlorophyll (photosynthesizes)");
  if (synthEnz) synth.push("makes enzymes");
  if (synthRibo) synth.push("builds ribosomes (faster all-around growth)");
  if (synth.length > 0) parts.push(`Internally ${synth.join(", ")}.`);
  else parts.push("No biosynthesis ops — can't grow new structure.");
  // Reproduction
  if (reproduce) parts.push(gated ? "Divides when conditions are met." : "Divides reflexively every tick (lots of stillbirths).");
  else parts.push("Has no REPRODUCE op — sterile.");
  // Extras
  const extras: string[] = [];
  if (repair) extras.push("repairs DNA");
  if (emit) extras.push("emits pheromone");
  if (adhere) extras.push("forms colonies");
  if (excrete.size > 0) extras.push("excretes " + Array.from(excrete).map(mat).join("/"));
  if (selfModifies) extras.push("rewrites its own genome");
  if (turn && !thrust) extras.push("turns in place");
  if (extras.length > 0) parts.push("Also " + extras.join(", ") + ".");
  // Sensors
  if (sensors.size > 0) {
    parts.push(`Senses ${Array.from(sensors).join(", ")}${gated ? " and gates behavior on it" : " but doesn't gate behavior on it"}.`);
  } else {
    parts.push("Blind — no sensor reads.");
  }
  return parts.join(" ");
}

