// Validation bar (per design decision): author + sanity-spawn only.
// No survival guarantee is asserted -- surviving selection is itself
// the experiment. Each archetype must: assemble well-formed,
// disassemble with no unknown bytes, and spawn + step without
// throwing.

import { describe, it, expect } from "vitest";
import { ARCHETYPES } from "../genome-archetypes";
import { assertWellFormed } from "../genome-asm";
import { disassemble, viableGenome } from "../genome";
import { createWorld, spawnSpeciesInstance, step } from "../sim";

describe("genome archetypes", () => {
  it("the catalogue has unique ids/labels and both classes", () => {
    expect(ARCHETYPES.length).toBe(24);
    expect(new Set(ARCHETYPES.map((a) => a.id)).size).toBe(24);
    expect(new Set(ARCHETYPES.map((a) => a.label)).size).toBe(24);
    expect(ARCHETYPES.some((a) => a.cls === "direct")).toBe(true);
    expect(ARCHETYPES.some((a) => a.cls === "seed")).toBe(true);
  });

  for (const a of ARCHETYPES) {
    describe(a.id, () => {
      it("is well-formed and disassembles with no unknown bytes", () => {
        expect(() => assertWellFormed(a.genome)).not.toThrow();
        expect(a.genome.length).toBeGreaterThan(0);
        expect(disassemble(a.genome)).not.toMatch(/db 0x/);
        if (a.symbiont) {
          expect(() => assertWellFormed(a.symbiont!)).not.toThrow();
          expect(a.symbiont!.length).toBeGreaterThan(0);
          expect(disassemble(a.symbiont!)).not.toMatch(/db 0x/);
        }
      });

      it("spawns into a world and steps without throwing", () => {
        const w = createWorld(800, 600, { seed: 99 });
        const c = spawnSpeciesInstance(w, a.genome);
        expect(c).not.toBeNull();
        expect(() => {
          for (let i = 0; i < 300; i++) step(w, 1 / 60);
        }).not.toThrow();
      });
    });
  }

  // Not a ship gate, just an authoring sanity signal: the founders we
  // intend to be self-sufficient pass the engine's own viability
  // predicate. The "seed" parasite/virus are deliberately minimal and
  // exempt (they bank on a host / carrier, not solo viability).
  it("self-sufficient archetypes satisfy viableGenome", () => {
    // chemolithoautotroph is sessile: it ingests the vent's stationary
    // fuel seep without thrusting (viableGenome assumes ingest => must
    // chase food). Self-sufficient at the vent, just not by that rule.
    const exempt = new Set(["endoparasite", "virus", "chemolithoautotroph"]);
    for (const a of ARCHETYPES) {
      if (exempt.has(a.id)) continue;
      expect(viableGenome(a.genome), `${a.id} should be viable`).toBe(true);
    }
  });
});
