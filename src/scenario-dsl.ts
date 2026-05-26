// Declarative scenario DSL: a `ScenarioSpec` describing a world (size,
// environment knobs, founder policy) and a set of seeded populations
// (archetypes or cell-builder specs), plus optional success criteria.
// Backs the in-app world-builder dialog and is reusable headlessly by
// scenarios/tests.
//
// Substrate stance unchanged: seeding a population just injects ordinary
// cells via the normal spawn path; nothing gets special treatment.

import {
  createWorld, spawnSpeciesInstance, setParticleTarget, pickClumpCenter,
  step, type World,
} from "./sim";
import { ARCHETYPES } from "./genome-archetypes";
import { compileCreature, type CreatureSpec } from "./creature-dsl";

export interface PopulationSpec {
  // Exactly one source of the genome:
  archetype?: string;      // an ARCHETYPES id
  creature?: CreatureSpec; // compiled via the creature DSL
  count: number;
  placement?: "scatter" | "clump";
}

export interface SuccessCriteria {
  // The run "succeeds" if, at the end, the live population is at least
  // minPopulation (default 1) and the world reached minSeconds (default 0).
  minPopulation?: number;
  minSeconds?: number;
}

export interface ScenarioSpec {
  width: number;
  height: number;
  // Environment knobs (all optional; sensible defaults from createWorld).
  dayPeriod?: number;       // seconds per day/night cycle
  wind?: number;            // steady horizontal current bias
  foundersEnabled?: boolean; // random founder seeding on/off
  particleCap?: number;     // nutrient/particle target
  seed?: number;            // deterministic RNG seed
  populations?: PopulationSpec[];
  success?: SuccessCriteria;
}

// Resolve a population to genome bytes. Throws on an unknown archetype id
// or a spec with neither source so a bad scenario fails loudly.
export function resolvePopulationGenome(pop: PopulationSpec): Uint8Array {
  if (pop.creature) return compileCreature(pop.creature).genome;
  if (pop.archetype) {
    const a = ARCHETYPES.find((x) => x.id === pop.archetype);
    if (!a) throw new Error(`scenario: unknown archetype "${pop.archetype}"`);
    return a.genome;
  }
  throw new Error("scenario: population needs an archetype id or a creature spec");
}

// Build a fresh world from a spec and seed its populations. Runs wherever
// the engine runs (the worker, or a headless script/test).
export function buildScenarioWorld(spec: ScenarioSpec): World {
  const world = createWorld(spec.width, spec.height, {
    delayedSpawn: true,
    seed: spec.seed,
  });
  if (spec.dayPeriod !== undefined && spec.dayPeriod > 0) world.dayPeriod = spec.dayPeriod;
  if (spec.foundersEnabled !== undefined) world.foundersEnabled = spec.foundersEnabled;
  if (spec.wind !== undefined) { world.wind = spec.wind; world.windTarget = spec.wind; }
  if (spec.particleCap !== undefined) setParticleTarget(world, spec.particleCap);
  for (const pop of spec.populations ?? []) {
    const genome = resolvePopulationGenome(pop);
    const mode = pop.placement ?? "scatter";
    const center = mode === "clump" ? pickClumpCenter(world) : undefined;
    for (let i = 0; i < Math.max(0, pop.count | 0); i++) {
      spawnSpeciesInstance(world, genome, { mode, center });
    }
  }
  return world;
}

export interface ScenarioResult {
  seconds: number;
  finalPopulation: number;
  peakPopulation: number;
  success: boolean;
}

// Headless run: build the world, step it for `seconds`, and report the
// population trajectory against the success criteria. For the smoke /
// scenario harness and tests.
export function runScenarioSpec(
  spec: ScenarioSpec,
  seconds: number,
  opts: { dt?: number; onSample?: (t: number, pop: number) => void; sampleSec?: number } = {},
): ScenarioResult {
  const dt = opts.dt ?? 1 / 60;
  const sampleSec = opts.sampleSec ?? 10;
  const world = buildScenarioWorld(spec);
  let peak = world.creatures.length;
  let nextSample = 0;
  while (world.t < seconds) {
    step(world, dt);
    if (world.creatures.length > peak) peak = world.creatures.length;
    if (opts.onSample && world.t >= nextSample) {
      opts.onSample(world.t, world.creatures.length);
      nextSample += sampleSec;
    }
  }
  const minPop = spec.success?.minPopulation ?? 1;
  const minSec = spec.success?.minSeconds ?? 0;
  return {
    seconds: world.t,
    finalPopulation: world.creatures.length,
    peakPopulation: peak,
    success: world.creatures.length >= minPop && world.t >= minSec,
  };
}
