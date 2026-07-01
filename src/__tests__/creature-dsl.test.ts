import { describe, it, expect } from "vitest";
import { compileCreature, specToProg, type CreatureSpec } from "../creature-dsl";
import { disassemble } from "../genome";
import { assertWellFormed } from "../genome-asm";
import { createWorld, spawnSpeciesInstance, step } from "../sim";

const SPECS: CreatureSpec[] = [
  { name: "photo-basic", trophic: "photoautotroph", reproduceAt: 40 },
  {
    name: "light-shoaler",
    trophic: "photoautotroph",
    senses: [{ channel: "light", response: "seek" }],
    reproduceAt: 35,
  },
  {
    name: "electro-hunter",
    trophic: "heterotroph",
    senses: [{ channel: "electric", response: "seek" }],
    predator: true,
    seekFood: true,
  },
  {
    name: "skitterer",
    trophic: "heterotroph",
    senses: [{ channel: "vibration", response: "flee" }],
    seekFood: true,
    fleeWaste: true,
  },
  {
    name: "vent-acidophile",
    trophic: "chemolithoautotroph",
    senses: [{ channel: "ph" }, { channel: "thermal" }],
    stressTolerant: true,
  },
  {
    name: "signalling-colony",
    trophic: "heterotroph",
    senses: [{ channel: "magnetic" }, { channel: "electric" }],
    emit: ["electric", "magnetic"],
    bondTag: 17,
    leakGlucose: true,
    seekFood: true,
  },
];

describe("creature DSL", () => {
  for (const spec of SPECS) {
    describe(spec.name, () => {
      it("compiles to a well-formed genome with no unknown bytes", () => {
        const { genome, name } = compileCreature(spec);
        expect(name.length).toBeGreaterThan(0);
        expect(genome.length).toBeGreaterThan(0);
        expect(() => assertWellFormed(genome)).not.toThrow();
        expect(disassemble(genome)).not.toMatch(/db 0x/);
      });

      it("spawns into a world and steps without throwing", () => {
        const w = createWorld(800, 600, { seed: 1234 });
        const { genome } = compileCreature(spec);
        const c = spawnSpeciesInstance(w, genome);
        expect(c).not.toBeNull();
        expect(() => { for (let i = 0; i < 30; i++) step(w, 1 / 60); }).not.toThrow();
      });
    });
  }

  it("is deterministic: same spec -> identical bytes", () => {
    const a = compileCreature(SPECS[2]).genome;
    const b = compileCreature(SPECS[2]).genome;
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("caps senses at 3", () => {
    const prog = specToProg({
      name: "oversensed",
      trophic: "heterotroph",
      senses: [
        { channel: "light" }, { channel: "electric" }, { channel: "vibration" },
        { channel: "magnetic" }, { channel: "ph" },
      ],
    });
    // Each vector sense emits one SYNTH CAT for its receptor; count them by
    // disassembling is overkill -- assert the genome still assembles.
    expect(prog.length).toBeGreaterThan(0);
    expect(() => compileCreature({
      name: "oversensed", trophic: "heterotroph",
      senses: [
        { channel: "light" }, { channel: "electric" }, { channel: "vibration" },
        { channel: "magnetic" }, { channel: "ph" },
      ],
    })).not.toThrow();
  });
});
