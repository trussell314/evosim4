import { describe, it, expect } from "vitest";
import { asm, assertWellFormed } from "../genome-asm";
import {
  OP,
  disassemble,
  newVMState,
  newOutputs,
  runTick,
  type VMSensors,
  type VMSelf,
} from "../genome";

function bareSensors(): VMSensors {
  return { chemConc: new Float32Array(96) };
}
function bareSelf(): VMSelf {
  return { energy: 10, mass: 5, membrane: 2 };
}

describe("genome assembler", () => {
  it("emits zero-operand ops as a single byte", () => {
    expect(Array.from(asm([["REPRODUCE"], ["PREDATE"]]))).toEqual([
      OP.REPRODUCE,
      OP.PREDATE,
    ]);
  });

  it("encodes PUSH8 immediates, including negatives", () => {
    expect(Array.from(asm([["PUSH8", 42]]))).toEqual([OP.PUSH8, 42]);
    expect(Array.from(asm([["PUSH8", -56]]))).toEqual([OP.PUSH8, 200]);
  });

  it("resolves SYNTH kind names to the kind byte", () => {
    expect(Array.from(asm([["SYNTH", "CHL", 0]]))).toEqual([OP.SYNTH, 4, 0]);
    expect(Array.from(asm([["SYNTH", "PHOTO", 1]]))).toEqual([OP.SYNTH, 6, 1]);
  });

  it("LABEL emits no bytes; backward jump offset matches VM pc rule", () => {
    // NOP@0, JMP@1 (operand@2) -> rel = 0 - (2+1) = -3 -> byte 253.
    expect(Array.from(asm([["LABEL", "a"], ["NOP"], ["JMP", "a"]]))).toEqual([
      OP.NOP,
      OP.JMP,
      253,
    ]);
  });

  it("resolves forward label references", () => {
    // JZ@0 (operand@1), NOP@2, fwd@3 -> rel = 3 - (1+1) = 1.
    expect(Array.from(asm([["JZ", "fwd"], ["NOP"], ["LABEL", "fwd"]]))).toEqual(
      [OP.JZ, 1, OP.NOP],
    );
  });

  it("a label loop actually iterates the intended number of times", () => {
    const genome = asm([
      ["PUSH8", 5],
      ["STORE", 0], // reg0 = 5
      ["LABEL", "loop"],
      ["LOAD", 0],
      ["PUSH8", 1],
      ["SUB"],
      ["STORE", 0], // reg0 -= 1
      ["LOAD", 1],
      ["PUSH8", 1],
      ["ADD"],
      ["STORE", 1], // reg1 += 1
      ["LOAD", 0],
      ["JNZ", "loop"], // repeat while reg0 != 0
      ["LABEL", "end"],
      ["JMP", "end"], // park (no reg mutation) until budget runs out
    ]);
    const st = newVMState();
    runTick(genome, st, bareSensors(), bareSelf(), 5000, newOutputs());
    expect(st.regs[0]).toBe(0);
    expect(st.regs[1]).toBe(5);
  });

  it("throws on out-of-range jump distance", () => {
    const prog = [["LABEL", "a"]] as Parameters<typeof asm>[0][number][];
    for (let i = 0; i < 130; i++) prog.push(["NOP"]);
    prog.push(["JMP", "a"]);
    expect(() => asm(prog as Parameters<typeof asm>[0])).toThrow(/jump offset/);
  });

  it("throws on unknown opcode, unknown SYNTH kind, and undefined label", () => {
    expect(() => asm([["BOGUS" as "NOP"]])).toThrow(/unknown opcode/);
    expect(() => asm([["SYNTH", "NOPE" as "CHL", 0]])).toThrow(
      /unknown SYNTH kind/,
    );
    expect(() => asm([["JMP", "missing"]])).toThrow(/undefined label/);
  });

  it("assertWellFormed accepts assembled output and rejects truncation", () => {
    const g = asm([["PUSH8", 1], ["SYNTH", "BIO", 0], ["REPRODUCE"]]);
    expect(() => assertWellFormed(g)).not.toThrow();
    expect(() => assertWellFormed(new Uint8Array([OP.PUSH8]))).toThrow(
      /truncated/,
    );
  });

  it("assembled genomes disassemble with no unknown (db) bytes", () => {
    const g = asm([
      ["SYNTH", "CHEMO", 0],
      ["SENSE_CHEMICAL", 23],
      ["THRUST"],
      ["PUSH8", 1],
      ["INGEST"],
      ["REPRODUCE"],
    ]);
    expect(disassemble(g)).not.toMatch(/db 0x/);
  });
});
