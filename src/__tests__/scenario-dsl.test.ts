import { describe, it, expect } from "vitest";
import {
  resolvePopulationGenome, buildScenarioWorld, runScenarioSpec,
  type ScenarioSpec,
} from "../scenario-dsl";

describe("scenario DSL", () => {
  it("resolves an archetype population to genome bytes", () => {
    const g = resolvePopulationGenome({ archetype: "photoautotroph", count: 1 });
    expect(g.length).toBeGreaterThan(0);
  });

  it("resolves a creature-spec population via the creature DSL", () => {
    const g = resolvePopulationGenome({
      creature: { name: "x", trophic: "heterotroph", seekFood: true },
      count: 1,
    });
    expect(g.length).toBeGreaterThan(0);
  });

  it("throws on an unknown archetype", () => {
    expect(() => resolvePopulationGenome({ archetype: "nope", count: 1 })).toThrow();
  });

  it("builds a world at the requested size with seeded populations", () => {
    const spec: ScenarioSpec = {
      width: 700, height: 500,
      dayPeriod: 300, foundersEnabled: false, seed: 42,
      populations: [
        { archetype: "photoautotroph", count: 8, placement: "scatter" },
        { creature: { name: "forager", trophic: "heterotroph", seekFood: true }, count: 4, placement: "clump" },
      ],
    };
    const w = buildScenarioWorld(spec);
    expect(w.width).toBe(700);
    expect(w.height).toBe(500);
    expect(w.dayPeriod).toBe(300);
    expect(w.foundersEnabled).toBe(false);
    // 12 seeded cells (store cap is far higher; placement never drops them).
    expect(w.creatures.length).toBe(12);
  });

  it("runs headless and reports a trajectory + success", () => {
    const spec: ScenarioSpec = {
      width: 600, height: 400, foundersEnabled: false, seed: 7,
      populations: [{ archetype: "photoautotroph", count: 10 }],
      success: { minPopulation: 1, minSeconds: 2 },
    };
    const samples: number[] = [];
    const res = runScenarioSpec(spec, 3, { sampleSec: 1, onSample: (_t, p) => samples.push(p) });
    expect(res.seconds).toBeGreaterThanOrEqual(3);
    expect(res.peakPopulation).toBeGreaterThanOrEqual(10);
    expect(samples.length).toBeGreaterThan(0);
    expect(typeof res.success).toBe("boolean");
  });

  it("is deterministic: same seed -> same final population", () => {
    const spec: ScenarioSpec = {
      width: 600, height: 400, foundersEnabled: false, seed: 99,
      populations: [{ archetype: "forager", count: 6 }],
    };
    const a = runScenarioSpec(spec, 2);
    const b = runScenarioSpec(spec, 2);
    expect(a.finalPopulation).toBe(b.finalPopulation);
    expect(a.peakPopulation).toBe(b.peakPopulation);
  });
});
