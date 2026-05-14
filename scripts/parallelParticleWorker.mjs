// Node worker_threads worker for the standalone parallel-particles
// benchmark. Mirrors src/particle.worker.ts's barrier protocol but
// uses Node's parentPort instead of the web-worker self.
//
// The particle force math is pasted in (rather than imported from
// sim.ts) because the bench runs as pure Node ESM; we don't want to
// stand up a TS loader just for one benchmark. If sim.ts's
// applyParticleForcesRange diverges, bring this copy up to date.
import { parentPort, workerData } from "node:worker_threads";

const CTRL_PHASE = 0;
const CTRL_DONE = 1;
const CTRL_NP = 2;

// Mirror of sim.ts constants. Keep in sync.
const SPLASH_DEPTH = 30;
const SPLASH_GAIN = 1.5;
const DRAG_REF_R = 4;

function applyParticleForcesRange(
  PX, PY, PZ, PVX, PVY, PVZ, PR, PDENS, PMAT,
  matBase, from, to, p,
) {
  const dt = p.dt;
  const t = p.t;
  const drag = p.drag;
  const grav = p.gravity;
  const surfaceY = p.surfaceY;
  const surfDecay = p.surfaceDecay;
  const swellDecay = p.swellDecay;
  const updraftAmp = p.updraftAmp;
  const currentAmp = p.currentAmp;
  const kS = p.kS, wS = p.wS;
  const kL = p.kL, wL = p.wL;
  const kU = p.kU, wU = p.wU;
  const surfAmp = p.surfAmp;
  const swellAmp = p.swellAmp;
  const zAmp = p.zAmp;
  const bAmp = p.bAmp;
  const updraftEnv = p.updraftEnv;
  const colDepth = p.colDepth;
  const currentDrift = p.currentDrift;
  for (let i = from; i < to; i++) {
    const xi = PX[i], yi = PY[i], ri = PR[i];
    let vxi = PVX[i], vyi = PVY[i], vzi = PVZ[i];
    const overrideD = PDENS[i];
    const density = overrideD !== 0 ? overrideD : matBase[PMAT[i]];
    let ay = grav * (1 - 1 / density);
    if (ay < -grav) ay = -grav; else if (ay > grav) ay = grav;
    const depth = yi > surfaceY ? yi - surfaceY : 0;
    const surfPR = kS * xi - wS * t;
    const surfPL = 1.3 * kS * xi + 0.9 * wS * t + 1.1;
    const swellPR = kL * xi - wL * t;
    const swellPL = 1.4 * kL * xi + 0.7 * wL * t + 0.4;
    const surface = surfAmp * 0.5 * (Math.sin(surfPR) + Math.sin(surfPL)) * Math.exp(-depth / surfDecay);
    const swell   = swellAmp * 0.5 * (Math.sin(swellPR) + Math.sin(swellPL)) * Math.exp(-depth / swellDecay);
    const az      = zAmp * Math.sin(wL * t + kL * xi + 1.0) * Math.exp(-depth / swellDecay);
    const splash = depth < SPLASH_DEPTH
      ? surfAmp * SPLASH_GAIN * 0.5 * (Math.cos(surfPR) + Math.cos(surfPL)) * Math.exp(-depth / SPLASH_DEPTH)
      : 0;
    const updraft = -updraftAmp * updraftEnv * Math.sin(kU * xi + wU * t);
    const depthFrac = depth / colDepth;
    const current = currentAmp * Math.cos(Math.PI * depthFrac) * currentDrift;
    const noiseX = bAmp * (Math.random() - 0.5) * 2;
    const noiseY = bAmp * (Math.random() - 0.5) * 2;
    const ax = surface + swell + current + noiseX;
    const ayTot = ay + splash + updraft + noiseY;
    const dragScale = ri / DRAG_REF_R;
    const dscaleDrag = drag * dragScale;
    vxi += (ax - dscaleDrag * vxi) * dt;
    vyi += (ayTot - dscaleDrag * vyi) * dt;
    vzi += (az - dscaleDrag * vzi) * dt;
    PVX[i] = vxi; PVY[i] = vyi; PVZ[i] = vzi;
    PX[i] = xi + vxi * dt;
    PY[i] = yi + vyi * dt;
    PZ[i] = PZ[i] + vzi * dt;
  }
}

const { buffer, offsets, cap, controlBuffer, paramsBuffer, matBase, workerIndex, nWorkers } = workerData;
const ctrl = new Int32Array(controlBuffer);
const params = new Float64Array(paramsBuffer);
const PX = new Float32Array(buffer, offsets.x, cap);
const PY = new Float32Array(buffer, offsets.y, cap);
const PZ = new Float32Array(buffer, offsets.z, cap);
const PVX = new Float32Array(buffer, offsets.vx, cap);
const PVY = new Float32Array(buffer, offsets.vy, cap);
const PVZ = new Float32Array(buffer, offsets.vz, cap);
const PR = new Float32Array(buffer, offsets.r, cap);
const PDENS = new Float32Array(buffer, offsets.density, cap);
const PMAT = new Uint8Array(buffer, offsets.material, cap);

function readParams() {
  return {
    dt: params[0], t: params[1], drag: params[2], gravity: params[3],
    surfaceY: params[4], surfaceDecay: params[5], swellDecay: params[6],
    updraftAmp: params[7], currentAmp: params[8],
    kS: params[9], wS: params[10], kL: params[11], wL: params[12],
    kU: params[13], wU: params[14],
    surfAmp: params[15], swellAmp: params[16], zAmp: params[17], bAmp: params[18],
    updraftEnv: params[19], colDepth: params[20], currentDrift: params[21],
  };
}

parentPort.postMessage({ type: "ready" });
let lastPhase = 0;
while (true) {
  Atomics.wait(ctrl, CTRL_PHASE, lastPhase);
  const phase = Atomics.load(ctrl, CTRL_PHASE);
  if (phase < 0) break; // -1 = shutdown
  lastPhase = phase;
  const np = Atomics.load(ctrl, CTRL_NP);
  if (np > 0) {
    const chunk = Math.floor(np / nWorkers);
    const rem = np - chunk * nWorkers;
    const from = workerIndex * chunk + Math.min(workerIndex, rem);
    const extra = workerIndex < rem ? 1 : 0;
    const to = from + chunk + extra;
    const p = readParams();
    applyParticleForcesRange(
      PX, PY, PZ, PVX, PVY, PVZ, PR, PDENS, PMAT,
      matBase, from, to, p,
    );
  }
  Atomics.add(ctrl, CTRL_DONE, 1);
  Atomics.notify(ctrl, CTRL_DONE);
}
