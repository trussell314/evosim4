import "./style.css";
import { createWorld, MATERIALS, MATERIAL_IDS_ORDERED, step, type Particle, type Creature } from "./sim";
import { disassemble } from "./genome";

const root = document.querySelector<HTMLDivElement>("#app")!;
const canvas = document.createElement("canvas");
root.appendChild(canvas);
const ctx = canvas.getContext("2d")!;

const inspector = document.createElement("pre");
inspector.style.cssText =
  "position:fixed;top:8px;left:8px;margin:0;padding:6px 9px;" +
  "color:#9ee;background:rgba(0,0,0,.45);border-radius:4px;" +
  "font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;" +
  "pointer-events:none;white-space:pre;max-height:60vh;overflow:hidden;";
root.appendChild(inspector);

const world = createWorld(window.innerWidth, window.innerHeight);

let selectedIdx = 0;
let activeDisasm = "";
function refreshActiveDisasm(): void {
  const c = world.creatures[selectedIdx];
  activeDisasm = c ? disassemble(c.genome, MATERIAL_IDS_ORDERED) : "";
}
refreshActiveDisasm();

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
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
  let mass = 0;
  for (const id of MATERIAL_IDS_ORDERED) mass += c.reserves[id];
  const reserves = MATERIAL_IDS_ORDERED
    .map((id) => `${id.slice(0, 3)}=${c.reserves[id].toFixed(0)}`)
    .join(" ");
  const stackStr = c.vm.stack.map((n) => n.toFixed(1)).join(" ");
  inspector.textContent =
    `pop=${world.creatures.length}  parts=${world.particles.length}/${world.particleTarget}  extinct=${world.extinctionCount}  (click a cell)\n` +
    `pos=(${c.x.toFixed(0)},${c.y.toFixed(0)},${c.z.toFixed(1)})  ` +
    `vel=(${c.vx.toFixed(1)},${c.vy.toFixed(1)})\n` +
    `r=${c.r.toFixed(1)}  mass=${mass.toFixed(0)}  E=${c.energy.toFixed(0)}\n` +
    `ingestCD=${c.ingestCooldown.toFixed(2)}s  reproCD=${c.reproduceCooldown.toFixed(2)}s\n` +
    `${reserves}\n` +
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
