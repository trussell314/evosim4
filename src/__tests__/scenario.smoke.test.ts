// Long-running scenario test: spin up the default world and observe it for
// a meaningful amount of simulated time. Not part of the default suite -- run
// explicitly via `npm run test:smoke`.
//
// All scenarios stub Math.random with a seeded mulberry32 PRNG so each run is
// reproducible. The loop is pure CPU (no rAF, no sleep) -- it runs as fast as
// the host allows.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createWorld,
  step,
  type World,
  MATERIAL_IDS_ORDERED,
  MOLECULE_IDS,
  newCreature,
} from "../sim";
import { newVMState } from "../genome";

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SMOKE_SEED = 0xC0FFEE;

beforeEach(() => {
  vi.spyOn(Math, "random").mockImplementation(mulberry32(SMOKE_SEED));
});
afterEach(() => {
  vi.restoreAllMocks();
});

interface Snapshot {
  t: number;
  pop: number;
  particles: number;
  energyMean: number;
  organicMean: number;
  uniqueGenomeColors: number;
  genomeLenMin: number;
  genomeLenMax: number;
  genomeLenMean: number;
  hasNaN: boolean;
}

function snapshot(w: World): Snapshot {
  const pop = w.creatures.length;
  let energySum = 0;
  let organicSum = 0;
  let lenSum = 0;
  let lenMin = Infinity;
  let lenMax = 0;
  const colors = new Set<string>();
  let hasNaN = false;
  for (const c of w.creatures) {
    energySum += c.energy;
    organicSum += c.reserves.organic;
    lenSum += c.genome.length;
    if (c.genome.length < lenMin) lenMin = c.genome.length;
    if (c.genome.length > lenMax) lenMax = c.genome.length;
    colors.add(c.color);
    if (!Number.isFinite(c.x + c.y + c.z + c.vx + c.vy + c.vz + c.energy)) {
      hasNaN = true;
    }
    for (const id of MATERIAL_IDS_ORDERED) {
      if (!Number.isFinite(c.reserves[id])) hasNaN = true;
    }
  }
  for (const p of w.particles) {
    if (!Number.isFinite(p.x + p.y + p.z + p.vx + p.vy + p.vz + p.r)) hasNaN = true;
  }
  return {
    t: w.t,
    pop,
    particles: w.particles.length,
    energyMean: pop ? energySum / pop : 0,
    organicMean: pop ? organicSum / pop : 0,
    uniqueGenomeColors: colors.size,
    genomeLenMin: pop ? lenMin : 0,
    genomeLenMax: lenMax,
    genomeLenMean: pop ? lenSum / pop : 0,
    hasNaN,
  };
}

function formatRow(s: Snapshot): string {
  return [
    `t=${s.t.toFixed(1).padStart(5)}s`,
    `pop=${String(s.pop).padStart(3)}`,
    `parts=${String(s.particles).padStart(4)}`,
    `E̅=${s.energyMean.toFixed(1).padStart(6)}`,
    `org̅=${s.organicMean.toFixed(1).padStart(6)}`,
    `lin=${String(s.uniqueGenomeColors).padStart(3)}`,
    `gLen=[${s.genomeLenMin}..${s.genomeLenMax}]̅${s.genomeLenMean.toFixed(1)}`,
  ].join(" ");
}

describe("smoke: default-creature ecosystem (long run)", () => {
  it("scenarios are reproducible: same seed yields identical outcomes", () => {
    interface Outcome {
      pop: number;
      particles: number;
      energySum: number;
      firstGenomeBytes: number[];
    }
    const runOnce = (seed: number, ticks: number): Outcome => {
      vi.spyOn(Math, "random").mockImplementation(mulberry32(seed));
      const w = createWorld(800, 600);
      for (let i = 0; i < ticks; i++) step(w, 1 / 60);
      let energySum = 0;
      for (const c of w.creatures) energySum += c.energy;
      const out: Outcome = {
        pop: w.creatures.length,
        particles: w.particles.length,
        energySum,
        firstGenomeBytes: Array.from(w.creatures[0]?.genome ?? []),
      };
      vi.restoreAllMocks();
      return out;
    };
    const TICKS = 60 * 60;
    const a = runOnce(SMOKE_SEED, TICKS);
    const b = runOnce(SMOKE_SEED, TICKS);
    expect(a).toEqual(b);
    const c = runOnce(SMOKE_SEED + 1, TICKS);
    expect(a).not.toEqual(c);
  });

  it("runs 1 default creature for 120 simulated seconds without crashing or NaN-ing", () => {
    const w = createWorld(800, 600);
    runAndObserve(w, 120, 1 / 60, 10);
  });

  it("runs 3 default creatures for 60 simulated seconds without crashing or NaN-ing", () => {
    const w = createWorld(800, 600);
    const proto = w.creatures[0];
    const cloneOf = (px: number, py: number) => {
      const molecules: Record<string, number> = {};
      for (const k of MOLECULE_IDS) molecules[k] = proto.molecules[k];
      const reserves: Record<string, number> = {};
      for (const id of MATERIAL_IDS_ORDERED) reserves[id] = proto.reserves[id];
      return newCreature(w.creatureStore, {
        x: px, y: py, z: proto.z,
        vx: proto.vx, vy: proto.vy, vz: proto.vz,
        r: proto.r, density: proto.density,
        energy: proto.energy,
        senseRange: proto.senseRange,
        thrustAccel: proto.thrustAccel,
        ingestCooldown: proto.ingestCooldown,
        repairTicks: proto.repairTicks,
        bornAt: proto.bornAt,
        genome: new Uint8Array(proto.genome),
        vm: newVMState(),
        color: proto.color,
        speciesKey: proto.speciesKey,
        molecules,
        reserves,
      });
    };
    w.creatures.push(cloneOf(200, 200));
    w.creatures.push(cloneOf(600, 400));
    runAndObserve(w, 60, 1 / 60, 5);
  });
});

function runAndObserve(w: World, durationSec: number, dt: number, logEvery: number): void {
  const initial = snapshot(w);
  console.log("\n" + formatRow(initial));
  let lastLog = 0;
  const totalSteps = Math.floor(durationSec / dt);
  let maxPop = initial.pop;
  let reproducedAtLeastOnce = false;
  for (let i = 0; i < totalSteps; i++) {
    step(w, dt);
    if (w.creatures.length > maxPop) {
      maxPop = w.creatures.length;
      reproducedAtLeastOnce = reproducedAtLeastOnce || maxPop > initial.pop;
    }
    if (w.t - lastLog >= logEvery) {
      lastLog = w.t;
      const s = snapshot(w);
      console.log(formatRow(s));
      if (s.hasNaN) throw new Error(`NaN detected at t=${s.t.toFixed(2)}`);
    }
  }
  const final = snapshot(w);
  console.log(formatRow(final));

  expect(final.hasNaN).toBe(false);
  expect(final.particles).toBeGreaterThan(0);
  expect(final.pop).toBeLessThanOrEqual(80);
  for (const c of w.creatures) {
    expect(c.x).toBeGreaterThanOrEqual(0);
    expect(c.x).toBeLessThan(w.width);
    expect(c.y).toBeGreaterThanOrEqual(0);
    expect(c.y).toBeLessThanOrEqual(w.height);
    expect(c.z).toBeGreaterThanOrEqual(0);
    expect(c.z).toBeLessThanOrEqual(w.depth);
  }
  expect(reproducedAtLeastOnce).toBe(true);
  console.log(`-- summary: maxPop=${maxPop} finalPop=${final.pop} reproduced=${reproducedAtLeastOnce}`);
}
