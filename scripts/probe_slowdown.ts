// Long-run sim ratio probe: bins wall-time-per-sim-second and dumps
// growing-state counters to find what causes the gradual slowdown
// (~6x early -> ~2x later). Run: npx tsx scripts/probe_slowdown.ts

import { createWorld, step, type World } from "../src/sim";

const FIXED_DT = 1 / 60;
const SECONDS = 600; // 10 sim-minutes
const STEPS = Math.round(SECONDS / FIXED_DT);
const BIN_SECONDS = 30;

const w = createWorld(800, 600); // test-path: founders + warmup skipped, t=61

const bins: Array<{
  simT: number;
  wallMs: number;
  creatures: number;
  species: number;
  particles: number;
  pebbles: number;
  bonds: number;
  phyloEvents: number;
  vmInstrTotal: number;
  genomeLenAvg: number;
  liveLineageRoots: number;
}> = [];

function countPebbles(w: World): number {
  let c = 0;
  for (let i = 0; i < w.particles.length; i++) {
    if (w.particles[i].material === "sand" && w.particles[i].r >= 8) c++;
  }
  return c;
}

function countBonds(w: World): number {
  let n = 0;
  for (const c of w.creatures) n += c.bonds.length;
  return n;
}

function avgGenomeLen(w: World): number {
  if (w.creatures.length === 0) return 0;
  let total = 0;
  for (const c of w.creatures) total += c.genome.length;
  return total / w.creatures.length;
}

let binStartWall = performance.now();
let binStartSim = w.t;

for (let s = 0; s < STEPS; s++) {
  step(w, FIXED_DT);
  if (w.t - binStartSim >= BIN_SECONDS) {
    const wallMs = performance.now() - binStartWall;
    bins.push({
      simT: w.t,
      wallMs,
      creatures: w.creatures.length,
      species: w.species.size,
      particles: w.particles.length,
      pebbles: countPebbles(w),
      bonds: countBonds(w),
      phyloEvents: w.phylogenyEvents.length,
      vmInstrTotal: 0, // not exposed
      genomeLenAvg: avgGenomeLen(w),
      liveLineageRoots: w.liveLineageRoots.size,
    });
    binStartWall = performance.now();
    binStartSim = w.t;
  }
}

console.log("simT(s) | binWall(ms) | simRatio | crts | species | parts | pebbles | bonds | phylo | genomeAvg | live");
for (const b of bins) {
  const simRatio = (BIN_SECONDS * 1000) / b.wallMs;
  console.log(
    `${b.simT.toFixed(0).padStart(6)} | ${b.wallMs.toFixed(0).padStart(7)} | ${simRatio.toFixed(2).padStart(5)}x | `
    + `${b.creatures.toString().padStart(4)} | ${b.species.toString().padStart(7)} | ${b.particles.toString().padStart(5)} | `
    + `${b.pebbles.toString().padStart(7)} | ${b.bonds.toString().padStart(5)} | ${b.phyloEvents.toString().padStart(5)} | `
    + `${b.genomeLenAvg.toFixed(1).padStart(9)} | ${b.liveLineageRoots.toString().padStart(4)}`,
  );
}

if (bins.length >= 2) {
  const first = bins[0];
  const last = bins[bins.length - 1];
  const firstRatio = (BIN_SECONDS * 1000) / first.wallMs;
  const lastRatio = (BIN_SECONDS * 1000) / last.wallMs;
  console.log(`\nSlowdown: ${(firstRatio / lastRatio).toFixed(2)}x (${firstRatio.toFixed(2)} -> ${lastRatio.toFixed(2)})`);
  console.log(`Species growth: ${first.species} -> ${last.species} (${(last.species / Math.max(1, first.species)).toFixed(1)}x)`);
  console.log(`Phylogeny: ${first.phyloEvents} -> ${last.phyloEvents}`);
  console.log(`Genome avg len: ${first.genomeLenAvg.toFixed(1)} -> ${last.genomeLenAvg.toFixed(1)}`);
}
