import "./style.css";
import { createWorld, MATERIALS, MATERIAL_IDS_ORDERED, MOLECULE_IDS, step, type Particle, type Creature } from "./sim";
import { disassemble, OP } from "./genome";

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
  world.width = w;
  world.height = h;
}
resize();
window.addEventListener("resize", resize);
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", resize);
  window.visualViewport.addEventListener("scroll", resize);
}

canvas.addEventListener("click", (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
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
  if (best >= 0) {
    selectedIdx = best;
    refreshActiveDisasm();
  }
});

const N_BUCKETS = 4;
const BUCKETS: Particle[][] = Array.from({ length: N_BUCKETS }, () => []);
const BLURS = [0, 1.0, 1.8, 2.6];
const ALPHAS = [1.0, 0.92, 0.84, 0.76];

function render(): void {
  const { width, height, depth } = world;
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, "#0e2a3a");
  grad.addColorStop(1, "#061520");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  for (const b of BUCKETS) b.length = 0;
  for (const p of world.particles) {
    const t = Math.min(0.999, Math.max(0, p.z / depth));
    BUCKETS[Math.floor(t * N_BUCKETS)].push(p);
  }
  for (let i = N_BUCKETS - 1; i >= 0; i--) {
    ctx.filter = BLURS[i] === 0 ? "none" : `blur(${BLURS[i]}px)`;
    ctx.globalAlpha = ALPHAS[i];
    for (const p of BUCKETS[i]) {
      ctx.fillStyle = MATERIALS[p.material].color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.filter = "none";
  ctx.globalAlpha = 1;

  for (let i = 0; i < world.creatures.length; i++) {
    drawCreature(world.creatures[i], i === selectedIdx);
  }

  drawPhylogeny();
}

const PHYLO_STRIP_H = 70;
const PHYLO_WINDOW_SEC = 120;

function drawPhylogeny(): void {
  const stripH = PHYLO_STRIP_H;
  const stripY = world.height - stripH;
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

  const tNow = world.t;
  const tMin = Math.max(0, tNow - PHYLO_WINDOW_SEC);
  const span = Math.max(0.001, tNow - tMin);
  const padTop = 14;
  const padBot = 6;
  const innerY = stripY + padTop;
  const innerH = stripH - padTop - padBot;

  // Pack visible species onto dense lanes so the strip isn't sparse.
  const visible = [];
  for (const sp of world.species.values()) {
    if (sp.alive === 0 && sp.lastSeen < tMin) continue;
    visible.push(sp);
  }
  visible.sort((a, b) => a.lane - b.lane);
  const laneOf = new Map<number, number>();
  visible.forEach((sp, i) => laneOf.set(sp.lane, i));
  const laneCount = Math.max(1, visible.length);
  const laneH = Math.min(4, innerH / laneCount);

  const tx = (t: number): number => ((t - tMin) / span) * w;
  const yOf = (origLane: number): number => {
    const i = laneOf.get(origLane);
    if (i === undefined) return innerY;
    return innerY + (i + 0.5) * laneH;
  };

  // Species lifespans first.
  for (const sp of visible) {
    const tStart = Math.max(sp.firstSeen, tMin);
    const tEnd = sp.alive > 0 ? tNow : sp.lastSeen;
    if (tEnd < tMin) continue;
    const x1 = tx(tStart);
    const x2 = tx(tEnd);
    const ly = yOf(sp.lane);
    ctx.strokeStyle = sp.color;
    ctx.globalAlpha = sp.alive > 0 ? 1 : 0.45;
    ctx.lineWidth = sp.alive > 0 ? Math.max(1.5, laneH - 0.5) : 1;
    ctx.beginPath();
    ctx.moveTo(x1, ly);
    ctx.lineTo(x2, ly);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Divergence / convergence connectors on top so they're visible.
  for (const ev of world.phylogenyEvents) {
    if (ev.t < tMin) continue;
    const from = world.species.get(ev.from);
    const to = world.species.get(ev.to);
    if (!from || !to) continue;
    if (!laneOf.has(from.lane) || !laneOf.has(to.lane)) continue;
    const ex = tx(ev.t);
    const y1 = yOf(from.lane);
    const y2 = yOf(to.lane);
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
    `phylogeny  last ${PHYLO_WINDOW_SEC}s  ${visible.length} species  (yellow = convergence)`,
    8,
    stripY + 11,
  );
}

const RING_GAP = 3;
const RING_SPACING = 3;
const RING_WIDTH = 2;

function drawCreature(c: Creature, selected: boolean): void {
  ctx.fillStyle = c.color;
  ctx.beginPath();
  ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = selected ? "#ffffff" : "#0a1f1d";
  ctx.lineWidth = selected ? 2 : 1.5;
  ctx.stroke();

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

  const energyFrac = Math.min(1, Math.max(0, c.energy / 200));
  drawRing(c.x, c.y, c.r + RING_GAP, energyFrac,
           energyFrac > 0.3 ? "#a6f0c8" : "#e8a07e");

  const ingestFrac = 1 - Math.min(1, c.ingestCooldown / 0.7);
  drawRing(c.x, c.y, c.r + RING_GAP + RING_SPACING, ingestFrac, "#7fb8ea");

  const reproFrac = 1 - Math.min(1, c.reproduceCooldown / 2.0);
  drawRing(c.x, c.y, c.r + RING_GAP + 2 * RING_SPACING, reproFrac, "#c890f5");
}

function drawRing(cx: number, cy: number, r: number, frac: number, color: string): void {
  if (frac <= 0) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = RING_WIDTH;
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
  ctx.stroke();
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
// contains and its current molecule pool. Not a simulation; just a readable
// hint for the watcher.
function describeBiology(c: Creature): string {
  const ops = new Set<number>();
  for (let i = 0; i < c.genome.length; i++) ops.add(c.genome[i]);
  const m = c.molecules;

  // Trophic mode: photosynthesizer (chlorophyll-bearing) vs predator
  // (PREDATE op) vs heterotroph (the default — eats organic particles).
  const tags: string[] = [];
  if (m.chlorophyll > 1) tags.push("photosynth");
  if (ops.has(OP.PREDATE)) tags.push("predator");
  if (ops.has(OP.ENGULF)) tags.push("engulfer");
  // Default sensory + thrust → motile chaser of organic food.
  const chases =
    ops.has(OP.THRUST) &&
    (ops.has(OP.SENSE_DX) || ops.has(OP.SENSE_DY) || ops.has(OP.SENSE_CRE_DX));
  if (chases && tags.length === 0) tags.push("heterotroph");
  if (!chases && tags.length === 0) tags.push("drifter");

  // Energy pathway currently running, judged from molecule snapshot.
  const pathways: string[] = [];
  if (m.glucose > 0.5 && m.o2 > 0.5) pathways.push("aerobic resp");
  else if (m.glucose > 0.5) pathways.push("fermentation");
  if (m.fattyAcid > 0.5 && m.o2 > 0.5) pathways.push("beta-ox");
  if (m.chlorophyll > 0.5 && m.co2 > 0.5) pathways.push("photo");
  const pathwayStr = pathways.length ? pathways.join("+") : "starving";

  // Reproductive cadence: a function of cooldown only; the genome decides
  // when to call REPRODUCE, but cost + cooldown ultimately pace it.
  const repro = ops.has(OP.REPRODUCE)
    ? `tries fission ~every ${(2.0).toFixed(1)}s`
    : "no REPRODUCE op (sterile)";

  // One item per line, with a small leading indent so it visually groups
  // under the "bio:" label. Tight on mobile screens.
  return `\n  type:    ${tags.join("/")}\n` +
         `  burns:   ${pathwayStr}\n` +
         `  repro:   ${repro}`;
}

function updateInspector(): void {
  if (selectedIdx >= world.creatures.length) {
    selectedIdx = 0;
    refreshActiveDisasm();
  }
  const c = world.creatures[selectedIdx];
  if (!c) {
    inspector.textContent = `pop=0  particles=${world.particles.length}`;
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
    `pop=${world.creatures.length}  parts=${world.particles.length}/${world.particleTarget}  extinct=${world.extinctionCount}  (click a cell)\n` +
    `bio: ${describeBiology(c)}\n` +
    `age=${age}  pos=(${c.x.toFixed(0)},${c.y.toFixed(0)},${c.z.toFixed(1)})  ` +
    `vel=(${c.vx.toFixed(1)},${c.vy.toFixed(1)})\n` +
    `r=${c.r.toFixed(1)}  mass=${totalMass.toFixed(0)}  ATP=${c.energy.toFixed(0)}  ADP=${fmt(m.adp)}\n` +
    `ingestCD=${c.ingestCooldown.toFixed(2)}s  reproCD=${c.reproduceCooldown.toFixed(2)}s\n` +
    `food: glu=${fmt(m.glucose)} fa=${fmt(m.fattyAcid)} aa=${fmt(m.aminoAcid)} min=${fmt(m.minerals)}\n` +
    `gas:  O2=${fmt(m.o2)} CO2=${fmt(m.co2)} waste=${fmt(m.waste)}\n` +
    `cell: chl=${fmt(m.chlorophyll)} enz=${fmt(m.enzyme)} bio=${fmt(m.biomass)}\n` +
    `stomach: ${reserves}\n` +
    (c.contents.length > 0 ? `vacuole: ${c.contents.length} engulfed cell(s)\n` : "") +
    `pc=${c.vm.pc}  genome=${c.genome.length}b  stack=[${stackStr}]\n` +
    "—\n" +
    activeDisasm;
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  step(world, dt);
  render();
  updateInspector();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
