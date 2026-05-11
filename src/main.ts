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
const baseDisasm = disassemble(world.creatures[0].genome, MATERIAL_IDS_ORDERED);

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

  for (const c of world.creatures) drawCreature(c);
}

function drawCreature(c: Creature): void {
  ctx.fillStyle = "#4ec9b0";
  ctx.beginPath();
  ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#0a1f1d";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Energy ring: arc length proportional to energy (clamped at 200 = full).
  const frac = Math.min(1, Math.max(0, c.energy / 200));
  ctx.strokeStyle = frac > 0.3 ? "#a6f0c8" : "#e8a07e";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(c.x, c.y, c.r + 3, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
  ctx.stroke();
}

function updateInspector(): void {
  const c = world.creatures[0];
  if (!c) { inspector.textContent = ""; return; }
  const stackStr = c.vm.stack.map((n) => n.toFixed(1)).join(" ");
  const reserves = MATERIAL_IDS_ORDERED
    .map((id) => `${id.slice(0, 3)}=${c.reserves[id].toFixed(0)}`)
    .join(" ");
  inspector.textContent =
    `E=${c.energy.toFixed(0)}  ${reserves}\n` +
    `pc=${c.vm.pc}  stack=[${stackStr}]\n` +
    "—\n" +
    baseDisasm;
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
