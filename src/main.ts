import "./style.css";
import { createWorld, step } from "./sim";

const root = document.querySelector<HTMLDivElement>("#app")!;
const canvas = document.createElement("canvas");
root.appendChild(canvas);
const ctx = canvas.getContext("2d")!;

const world = createWorld(window.innerWidth, window.innerHeight);

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

function densityColor(d: number): string {
  // Pale yellow → brown as density rises.
  const t = Math.min(1, Math.max(0, (d - 0.3) / 2.2));
  const hue = 50 - 30 * t;
  const light = 72 - 45 * t;
  return `hsl(${hue.toFixed(0)}, 60%, ${light.toFixed(0)}%)`;
}

function render(): void {
  const { width, height } = world;
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, "#0e2a3a");
  grad.addColorStop(1, "#061520");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  for (const p of world.particles) {
    ctx.fillStyle = densityColor(p.density);
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  step(world, dt);
  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
