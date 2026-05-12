import "./style.css";
import { createWorld, MATERIALS, MATERIAL_IDS_ORDERED, MOLECULE_IDS, step, surfaceYAt, resizeWorld, temperatureAt, type Particle, type Creature, type Species } from "./sim";
import { disassemble } from "./genome";

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
  "display:flex;justify-content:flex-end;padding:2px 4px;cursor:pointer;" +
  "user-select:none;color:#9ee;";
const hudToggle = document.createElement("span");
hudToggle.textContent = "[–]"; // [-]
hudToggle.style.cssText = "padding:0 4px;";
hudBar.appendChild(hudToggle);
const inspector = document.createElement("pre");
inspector.style.cssText =
  "margin:0;padding:0 9px 6px;color:#9ee;white-space:pre;";
hud.appendChild(hudBar);
hud.appendChild(inspector);
root.appendChild(hud);

let hudMinimized = false;
hudBar.addEventListener("click", () => {
  hudMinimized = !hudMinimized;
  inspector.style.display = hudMinimized ? "none" : "";
  hudToggle.textContent = hudMinimized ? "[+]" : "[–]";
});

const world = createWorld(window.innerWidth, window.innerHeight);

let selectedIdx = 0;
let activeDisasm = "";
function refreshActiveDisasm(): void {
  const c = world.creatures[selectedIdx];
  activeDisasm = c ? disassemble(c.genome, MATERIAL_IDS_ORDERED) : "";
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

function resize(): void {
  // Prefer the visual viewport on mobile: pinch-zoom changes visualViewport
  // dimensions but doesn't fire window.resize on iOS Safari, so the canvas
  // can be smaller than the visible area after zooming out.
  const vv = window.visualViewport;
  const dpr = window.devicePixelRatio || 1;
  const w = vv ? vv.width : window.innerWidth;
  const h = vv ? vv.height : window.innerHeight;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Reserve the bottom PHYLO_STRIP_H px for the phylogeny timeline so it
  // never overlaps swimming cells. resizeWorld also rescales particle
  // target/spawn rate so the new area gets filled with food.
  resizeWorld(world, w, h - PHYLO_STRIP_H);
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
canvas.addEventListener("click", (e) => {
  const rect = canvas.getBoundingClientRect();
  const best = findCellAt(e.clientX - rect.left, e.clientY - rect.top);
  if (best >= 0) {
    selectedIdx = best;
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
  pendingMouseX = e.clientX - rect.left;
  pendingMouseY = e.clientY - rect.top;
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
const BLURS = [0, 0.6, 1.4, 2.4, 3.4, 4.4, 5.4, 6.4];
const ALPHAS = [1.0, 0.92, 0.82, 0.70, 0.58, 0.46, 0.36, 0.28];
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
const DEPTH_TINTS = [0, 0.05, 0.12, 0.22, 0.34, 0.46, 0.58, 0.70];
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

// Map water temperature (°C) to a tint. Warm = lighter cyan, cool = deep
// dark blue. Chosen so 20°C lands near the original water palette.
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

// Sample the wavy surface at intervals; sim.surfaceYAt is the shared
// source of truth so the rendered line matches the physical wall.
const SURFACE_VIS_STEP = 3;

function render(): void {
  const { width, height, depth, surfaceY } = world;
  const tWarm = tempToColor(world.tempSurface);
  const tCool = tempToColor(world.tempBottom);

  // Atmosphere band -- fill above the wavy surface line.
  ctx.fillStyle = "#0a1620";
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

  // Highlight along the surface line.
  ctx.strokeStyle = "rgba(170, 220, 240, 0.45)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, surfaceYAt(world,0));
  for (let x = SURFACE_VIS_STEP; x <= width; x += SURFACE_VIS_STEP) ctx.lineTo(x, surfaceYAt(world,x));
  ctx.stroke();

  for (const b of SUB_BUCKETS) b.length = 0;
  const matIdx: Record<string, number> = MATERIAL_IDX_BY_NAME;
  for (const p of world.particles) {
    const t = Math.min(0.999, Math.max(0, p.z / depth));
    const bucket = Math.floor(t * N_BUCKETS);
    SUB_BUCKETS[bucket * N_MATERIALS + matIdx[p.material]].push(p);
  }
  const tinted = TINTED_COLORS;
  for (let i = N_BUCKETS - 1; i >= 0; i--) {
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
  }
  ctx.filter = "none";
  ctx.globalAlpha = 1;

  for (let i = 0; i < world.creatures.length; i++) {
    drawCreature(world.creatures[i], i === selectedIdx);
  }

  drawHeatmap();
  drawPhylogeny();
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
  }
});
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

function drawPhylogeny(): void {
  const stripH = PHYLO_STRIP_H;
  // World ends at world.height; strip sits in the canvas band below that.
  const stripY = world.height;
  const w = world.width;

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
  const padTop = 14;
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
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = selected ? 3 : 1;
  tracedWobblyBody(cx, cy, r, t, phase);
  ctx.stroke();
}

function drawCreature(c: Creature, selected: boolean): void {
  // Each cell has a stable random phase derived from its bornAt + position,
  // so its wobble pattern is its own instead of every cell pulsing in sync.
  const phase = c.bornAt * 0.7 + c.x * 0.013 + c.y * 0.019;
  const t = world.t;
  if (c.division) {
    // Mitosis: render two overlapping wobbly bodies whose centers split
    // along the division axis as `progress` advances 0 -> 1.
    const child = c.division.child;
    const sep = c.division.progress * (c.r + child.r);
    const dx = Math.cos(c.division.axis) * sep * 0.5;
    const dy = Math.sin(c.division.axis) * sep * 0.5;
    ctx.fillStyle = c.color;
    tracedWobblyBody(c.x - dx, c.y - dy, c.r, t, phase);
    ctx.fill();
    strokeCellOutline(c.x - dx, c.y - dy, c.r, selected, t, phase);
    ctx.fillStyle = child.color;
    tracedWobblyBody(c.x + dx, c.y + dy, child.r, t, phase + 1.7);
    ctx.fill();
    strokeCellOutline(c.x + dx, c.y + dy, child.r, selected, t, phase + 1.7);
  } else {
    ctx.fillStyle = c.color;
    tracedWobblyBody(c.x, c.y, c.r, t, phase);
    ctx.fill();
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
  if (selectedIdx >= world.creatures.length) {
    selectedIdx = 0;
  }
  // Always re-disassemble: the selected cell's genome can change between
  // frames from somatic mutation, so a cached string would go stale.
  refreshActiveDisasm();
  const c = world.creatures[selectedIdx];
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
    `cell: chl=${fmt(m.chlorophyll)} enz=${fmt(m.enzyme)} bio=${fmt(m.biomass)}\n` +
    `stomach: ${reserves}\n` +
    (c.contents.length > 0 ? `vacuole: ${c.contents.length} engulfed cell(s)\n` : "") +
    `pc=${c.vm.pc}  genome=${c.genome.length}b  stack=[${stackStr}]\n` +
    "—\n" +
    activeDisasm;
}

// Sim speed control. "realtime" runs one step per RAF tick using wall
// clock dt. "max" runs a fixed-dt step in a loop for ~10ms each frame
// so the sim advances as fast as the CPU allows while keeping the page
// responsive.
type SpeedMode = "realtime" | "max";
let speedMode: SpeedMode = "max";
const FIXED_DT = 1 / 60;
const MAX_BUDGET_MS = 10;

// Stats line: FPS + sim/wall ratio + particle count. Smoothed over a
// short window so the numbers don't flicker.
let perfWallStart = performance.now();
let perfSimSecs = 0;
let perfFrames = 0;
let perfFps = 0;
let perfSimRate = 1;
function updatePerfStats(simAdvanced: number): void {
  perfSimSecs += simAdvanced;
  perfFrames++;
  const elapsed = (performance.now() - perfWallStart) / 1000;
  if (elapsed > 0.5) {
    perfFps = perfFrames / elapsed;
    perfSimRate = perfSimSecs / elapsed;
    perfWallStart = performance.now();
    perfSimSecs = 0;
    perfFrames = 0;
  }
}

function statsLine(): string {
  // fps = frames/sec rendered; sim = how many sim-seconds advance per
  // wall-second (1x in realtime; usually 5..30x in max-speed). t = the
  // world's elapsed sim-time. Helps tell whether the bottleneck is
  // render or sim, and how far ahead "max" is running.
  return `fps=${perfFps.toFixed(0)}  sim=${perfSimRate.toFixed(1)}x  t=${world.t.toFixed(0)}s  species=${world.species.size}`;
}

const speedBtn = document.createElement("button");
speedBtn.style.cssText =
  "position:fixed;bottom:8px;left:8px;z-index:10;" +
  "padding:6px 10px;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;" +
  "cursor:pointer;border-radius:4px;border:1px solid #6ad;" +
  "min-width:120px;text-align:left;";
function refreshSpeedBtn(): void {
  if (speedMode === "realtime") {
    speedBtn.textContent = "● REALTIME  (click for max)";
    speedBtn.style.background = "rgba(20,80,120,.85)";
    speedBtn.style.color = "#cfe7ff";
    speedBtn.style.borderColor = "#6ad";
  } else {
    speedBtn.textContent = "⏩ MAX SPEED  (click for realtime)";
    speedBtn.style.background = "rgba(180,140,30,.85)";
    speedBtn.style.color = "#fff8d8";
    speedBtn.style.borderColor = "#fc4";
  }
}
refreshSpeedBtn();
speedBtn.addEventListener("click", () => {
  speedMode = speedMode === "realtime" ? "max" : "realtime";
  refreshSpeedBtn();
});
document.body.appendChild(speedBtn);

let last = performance.now();
function frame(now: number): void {
  let advanced = 0;
  if (speedMode === "max") {
    const start = performance.now();
    do { step(world, FIXED_DT); advanced += FIXED_DT; } while (performance.now() - start < MAX_BUDGET_MS);
    last = now;
  } else {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    step(world, dt);
    advanced = dt;
  }
  updatePerfStats(advanced);
  render();
  updateInspector();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
