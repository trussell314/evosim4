// Genome unit tests live with the genome module. See vitest.config.ts for the
// include/exclude rules -- this file is part of the default `npm test` suite.

import { describe, it, expect } from "vitest";
import {
  OP,
  type VMSensors,
  type VMSelf,
  type VMOutputs,
  type VMState,
  newVMState,
  newOutputs,
  runTick,
  disassemble,
  mutateGenome,
  genomeMaterialCost,
  OPERANDS,
} from "../genome";

function makeSensors(overrides: Partial<{
  chemConc: number[];
}> = {}): VMSensors {
  const cc = new Float32Array(96);
  if (overrides.chemConc) {
    for (let i = 0; i < overrides.chemConc.length && i < cc.length; i++) {
      cc[i] = overrides.chemConc[i];
    }
  }
  return { chemConc: cc };
}

function makeSelf(overrides: Partial<{
  energy: number; mass: number; membrane: number;
}> = {}): VMSelf {
  return {
    energy: overrides.energy ?? 100,
    mass: overrides.mass ?? 0,
    membrane: overrides.membrane ?? 0,
  };
}

// Tier 1 cleanup retired the HALT op (cells run until vmInstrBudget is
// exhausted). Tests written with `[OP.PUSH8, 42, HALT_MARK]` shape now
// pass an explicit budget. Helper just counts ops in the byte sequence
// (treating any byte == 0xFF as the marker, since old tests still use
// that literal value via HALT_MARK === 0xFF).
function budgetToHalt(bytes: number[]): number {
  let pc = 0;
  let count = 0;
  while (pc < bytes.length) {
    const op = bytes[pc++];
    if (op === 0xFF) return count;
    count++;
    pc += OPERANDS[op] ?? 0;
  }
  return Math.max(count, 1);
}
// Sentinel byte for tests that need to mark "end of useful ops" -- the
// HALT op was retired but tests still benefit from the marker pattern.
const HALT_MARK = 0xFF;
function exec(
  bytes: number[],
  opts: {
    state?: VMState;
    sensors?: VMSensors;
    self?: VMSelf;
    budget?: number;
  } = {},
): { out: VMOutputs; state: VMState } {
  const state = opts.state ?? newVMState();
  const sensors = opts.sensors ?? makeSensors();
  const self = opts.self ?? makeSelf();
  const budget = opts.budget ?? budgetToHalt(bytes);
  const out = newOutputs();
  runTick(new Uint8Array(bytes), state, sensors, self, budget, out);
  return { out, state };
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("VM stack ops", () => {
  it("PUSH8 pushes positive byte", () => {
    expect(exec([OP.PUSH8, 42, HALT_MARK]).state.stack).toEqual([42]);
  });
  it("PUSH8 sign-extends bytes > 127", () => {
    expect(exec([OP.PUSH8, 200, HALT_MARK]).state.stack[0]).toBe(-56);
  });
  it("PUSH8 handles 0 and 127", () => {
    expect(exec([OP.PUSH8, 0, OP.PUSH8, 127, HALT_MARK]).state.stack).toEqual([0, 127]);
  });
  it("PUSH8 handles 128 as -128", () => {
    expect(exec([OP.PUSH8, 128, HALT_MARK]).state.stack).toEqual([-128]);
  });
  it("POP removes top", () => {
    expect(exec([OP.PUSH8, 1, OP.PUSH8, 2, OP.POP, HALT_MARK]).state.stack).toEqual([1]);
  });
  it("POP on empty is a no-op", () => {
    expect(exec([OP.POP, OP.POP, OP.PUSH8, 5, HALT_MARK]).state.stack).toEqual([5]);
  });
  it("DUP duplicates top", () => {
    expect(exec([OP.PUSH8, 7, OP.DUP, HALT_MARK]).state.stack).toEqual([7, 7]);
  });
  it("DUP on empty pushes two zeros", () => {
    expect(exec([OP.DUP, HALT_MARK]).state.stack).toEqual([0, 0]);
  });
  it("SWAP exchanges top two", () => {
    expect(exec([OP.PUSH8, 1, OP.PUSH8, 2, OP.SWAP, HALT_MARK]).state.stack).toEqual([2, 1]);
  });
  it("stack capped at 32 (drops oldest)", () => {
    const bytes: number[] = [];
    for (let i = 1; i <= 40; i++) bytes.push(OP.PUSH8, i);
    // budget=40 stops after the 40 PUSH8 instructions; without it
    // (or with the old HALT) the VM would now wrap and keep pushing.
    const { state } = exec(bytes, { budget: 40 });
    expect(state.stack.length).toBe(32);
    expect(state.stack[0]).toBe(9);
    expect(state.stack[31]).toBe(40);
  });
});

describe("VM arithmetic", () => {
  it("ADD", () => { expect(exec([OP.PUSH8, 3, OP.PUSH8, 4, OP.ADD, HALT_MARK]).state.stack).toEqual([7]); });
  it("SUB", () => { expect(exec([OP.PUSH8, 10, OP.PUSH8, 3, OP.SUB, HALT_MARK]).state.stack).toEqual([7]); });
  it("MUL", () => { expect(exec([OP.PUSH8, 6, OP.PUSH8, 7, OP.MUL, HALT_MARK]).state.stack).toEqual([42]); });
  it("DIV", () => { expect(exec([OP.PUSH8, 20, OP.PUSH8, 4, OP.DIV, HALT_MARK]).state.stack).toEqual([5]); });
  it("DIV by zero pushes 0", () => { expect(exec([OP.PUSH8, 20, OP.PUSH8, 0, OP.DIV, HALT_MARK]).state.stack).toEqual([0]); });
  it("NEG", () => { expect(exec([OP.PUSH8, 7, OP.NEG, HALT_MARK]).state.stack).toEqual([-7]); });
  it("ABS", () => { expect(exec([OP.PUSH8, 200, OP.ABS, HALT_MARK]).state.stack).toEqual([56]); });
  it("MIN", () => { expect(exec([OP.PUSH8, 3, OP.PUSH8, 9, OP.MIN, HALT_MARK]).state.stack).toEqual([3]); });
  it("MAX", () => { expect(exec([OP.PUSH8, 3, OP.PUSH8, 9, OP.MAX, HALT_MARK]).state.stack).toEqual([9]); });
  it("empty operands -> 0", () => { expect(exec([OP.ADD, HALT_MARK]).state.stack).toEqual([0]); });
});

describe("VM comparison", () => {
  it("LT true", () => { expect(exec([OP.PUSH8, 3, OP.PUSH8, 5, OP.LT, HALT_MARK]).state.stack).toEqual([1]); });
  it("LT false", () => { expect(exec([OP.PUSH8, 5, OP.PUSH8, 3, OP.LT, HALT_MARK]).state.stack).toEqual([0]); });
  it("LT equal pushes 0", () => { expect(exec([OP.PUSH8, 3, OP.PUSH8, 3, OP.LT, HALT_MARK]).state.stack).toEqual([0]); });
  it("GT true/false/equal", () => {
    expect(exec([OP.PUSH8, 5, OP.PUSH8, 3, OP.GT, HALT_MARK]).state.stack).toEqual([1]);
    expect(exec([OP.PUSH8, 3, OP.PUSH8, 5, OP.GT, HALT_MARK]).state.stack).toEqual([0]);
    expect(exec([OP.PUSH8, 3, OP.PUSH8, 3, OP.GT, HALT_MARK]).state.stack).toEqual([0]);
  });
  it("EQ true and false", () => {
    expect(exec([OP.PUSH8, 5, OP.PUSH8, 5, OP.EQ, HALT_MARK]).state.stack).toEqual([1]);
    expect(exec([OP.PUSH8, 5, OP.PUSH8, 3, OP.EQ, HALT_MARK]).state.stack).toEqual([0]);
  });
});

describe("VM control flow", () => {
  it("JMP forward N", () => {
    expect(exec([OP.PUSH8, 1, OP.JMP, 1, OP.NOP, OP.PUSH8, 9, HALT_MARK]).state.stack).toEqual([1, 9]);
  });
  it("JMP backward (loops, budget-bound)", () => {
    const { state } = exec([OP.PUSH8, 1, OP.JMP, 0xFC], { budget: 10 });
    expect(state.stack.length).toBe(5);
  });
  it("JZ taken / not-taken", () => {
    expect(exec([OP.PUSH8, 0, OP.JZ, 1, OP.NOP, OP.PUSH8, 9, HALT_MARK]).state.stack).toEqual([9]);
    expect(exec([OP.PUSH8, 1, OP.JZ, 1, OP.NOP, OP.PUSH8, 9, HALT_MARK]).state.stack).toEqual([9]);
  });
  it("JNZ taken / not-taken", () => {
    expect(exec([OP.PUSH8, 1, OP.JNZ, 2, OP.PUSH8, 5, OP.PUSH8, 9, HALT_MARK]).state.stack).toEqual([9]);
    expect(exec([OP.PUSH8, 0, OP.JNZ, 2, OP.PUSH8, 5, OP.PUSH8, 9, HALT_MARK]).state.stack).toEqual([5, 9]);
  });
  it("PC wraps past end of genome", () => {
    const state = newVMState();
    exec([OP.PUSH8, 7], { state, budget: 6 });
    expect(state.stack.length).toBe(6);
  });
  it("HALT byte (0xFF) is now a NOP -- VM keeps executing past it", () => {
    // budgetToHalt in the test helper stops counting at HALT, so by
    // default the body executes up to the HALT and stops there. With
    // an explicit budget the VM walks straight through.
    const state = newVMState();
    // 3 instructions = PUSH8 1, HALT-as-NOP, PUSH8 2.
    const { out } = exec([OP.PUSH8, 1, HALT_MARK, OP.PUSH8, 2], { state, budget: 3 });
    expect(state.stack).toEqual([1, 2]);
    expect(out.instructions).toBe(3);
  });
  it("budget caps even without HALT", () => {
    expect(exec([OP.NOP, OP.NOP, OP.NOP], { budget: 5 }).out.instructions).toBe(5);
  });
});

describe("VM scratch registers (LOAD / STORE)", () => {
  it("STORE pops, LOAD pushes from the same register", () => {
    expect(exec([OP.PUSH8, 42, OP.STORE, 7, OP.LOAD, 7, HALT_MARK]).state.stack).toEqual([42]);
  });
  it("registers persist across runTick calls", () => {
    const state = newVMState();
    const out = newOutputs();
    // Explicit budget = the number of instructions we want to run;
    // HALT is no longer a yield.
    runTick(new Uint8Array([OP.PUSH8, 99, OP.STORE, 3]), state, makeSensors(), makeSelf(), 2, out);
    // Reset stack + pc to simulate a fresh tick; regs deliberately persist.
    state.stack.length = 0; state.pc = 0;
    runTick(new Uint8Array([OP.LOAD, 3]), state, makeSensors(), makeSelf(), 1, out);
    expect(state.stack).toEqual([99]);
  });
  it("LOAD from an unset register reads zero", () => {
    expect(exec([OP.LOAD, 5, HALT_MARK]).state.stack).toEqual([0]);
  });
  it("register index wraps mod 16", () => {
    // 7 % 16 == 7; 23 % 16 == 7 -- both should hit the same cell.
    expect(exec([OP.PUSH8, 11, OP.STORE, 23, OP.LOAD, 7, HALT_MARK]).state.stack).toEqual([11]);
  });
});

describe("VM sensors", () => {
  it("SELF_ENERGY", () => {
    expect(exec([OP.SELF_ENERGY, HALT_MARK], { self: makeSelf({ energy: 77 }) }).state.stack).toEqual([77]);
  });
  it("SELF_MASS", () => {
    expect(exec([OP.SELF_MASS, HALT_MARK], { self: makeSelf({ mass: 88 }) }).state.stack).toEqual([88]);
  });
  it("SELF_MEMBRANE", () => {
    expect(exec([OP.SELF_MEMBRANE, HALT_MARK], { self: makeSelf({ membrane: 13.5 }) }).state.stack).toEqual([13.5]);
  });
  it("SENSE_CHEMICAL reads internal pool by chem id", () => {
    const cc = new Float32Array(96);
    cc[5] = 42;
    expect(exec([OP.SENSE_CHEMICAL, 5, HALT_MARK], { sensors: { chemConc: cc } }).state.stack).toEqual([42]);
  });
  it("SENSE_CHEMICAL operand wraps mod CHEMICAL_COUNT (96)", () => {
    // K-5: every external reading hits SENSE_CHEMICAL. Activated chems
    // live around id 23 (chemo biopolymer X); a genome that wants
    // "gradient toward food" reads that id directly.
    const cc = new Float32Array(96);
    cc[23] = 9.5;
    // 23 + 96 = 119; mod 96 = 23, so the read still lands at slot 23.
    expect(exec([OP.SENSE_CHEMICAL, 119, HALT_MARK], { sensors: { chemConc: cc } }).state.stack).toEqual([9.5]);
  });
});

describe("VM actuators", () => {
  it("THRUST pops ay,ax and accumulates", () => {
    const { out } = exec([OP.PUSH8, 30, OP.PUSH8, 40, OP.THRUST, HALT_MARK]);
    expect(out.thrustX).toBe(30);
    expect(out.thrustY).toBe(40);
  });
  it("multiple THRUSTs accumulate", () => {
    const { out } = exec([OP.PUSH8, 10, OP.PUSH8, 20, OP.THRUST, OP.PUSH8, 5, OP.PUSH8, 7, OP.THRUST, HALT_MARK]);
    expect(out.thrustX).toBe(15);
    expect(out.thrustY).toBe(27);
  });
  it("EXCRETE accumulates per chem", () => {
    // EXCRETE was widened to operand mod CHEMICAL_COUNT (96) -- the
    // out.excrete array is sized to the full chem table now.
    const out = exec([OP.PUSH8, 25, OP.EXCRETE, 3, HALT_MARK]).out.excrete;
    expect(out[3]).toBe(25);
    expect(out[0]).toBe(0);
    expect(out[2]).toBe(0);
  });
  it("EXCRETE clamps negatives to 0", () => {
    // Negative pop value clamps; slot stays at 0.
    const out = exec([OP.PUSH8, 200, OP.EXCRETE, 0, HALT_MARK]).out.excrete;
    expect(out[0]).toBe(0);
  });
  it("EXCRETE operand wraps via modulo CHEMICAL_COUNT", () => {
    // Operand 7 with mod 96 -> slot 7. Pre-cleanup the operand was
    // mod 6 so 7 wrapped to slot 1; post-cleanup it lands at 7 directly.
    const out = exec([OP.PUSH8, 10, OP.EXCRETE, 7, HALT_MARK]).out.excrete;
    expect(out[7]).toBe(10);
    expect(out[1]).toBe(0);
  });
  it("REPRODUCE flag", () => {
    expect(exec([OP.REPRODUCE, HALT_MARK]).out.reproduce).toBe(true);
  });
  it("PREDATE flag", () => {
    expect(exec([OP.PREDATE, HALT_MARK]).out.predate).toBe(true);
  });
  it("INGEST sets material flag by index", () => {
    const out = exec([OP.INGEST, 3, HALT_MARK]).out;
    expect(Array.from(out.ingestMaterials)).toEqual([0, 0, 0, 1, 0, 0]);
  });
  it("INGEST flags accumulate across multiple ops", () => {
    const out = exec([OP.INGEST, 3, OP.INGEST, 4, HALT_MARK]).out;
    expect(Array.from(out.ingestMaterials)).toEqual([0, 0, 0, 1, 1, 0]);
  });
  it("INGEST flags default to all-zero without the op", () => {
    const out = exec([OP.NOP, HALT_MARK]).out;
    expect(Array.from(out.ingestMaterials)).toEqual([0, 0, 0, 0, 0, 0]);
  });
  it("TURN accumulates angle delta from the stack", () => {
    expect(exec([OP.PUSH8, 1, OP.TURN, HALT_MARK]).out.turn).toBe(1);
  });
  it("multiple TURNs sum", () => {
    expect(exec([OP.PUSH8, 2, OP.TURN, OP.PUSH8, 3, OP.TURN, HALT_MARK]).out.turn).toBe(5);
  });
  it("TURN with no stack value pops 0 (no rotation)", () => {
    expect(exec([OP.TURN, HALT_MARK]).out.turn).toBe(0);
  });
  it("output reset between runTick calls", () => {
    const state = newVMState();
    const out = newOutputs();
    runTick(new Uint8Array([OP.REPRODUCE, HALT_MARK]), state, makeSensors(), makeSelf(), 32, out);
    expect(out.reproduce).toBe(true);
    runTick(new Uint8Array([OP.NOP, HALT_MARK]), newVMState(), makeSensors(), makeSelf(), 32, out);
    expect(out.reproduce).toBe(false);
    expect(out.thrustX).toBe(0);
    expect(out.thrustY).toBe(0);
    expect(out.turn).toBe(0);
    expect(Array.from(out.ingestMaterials)).toEqual([0, 0, 0, 0, 0, 0]);
    // Excrete array sized to CHEMICAL_COUNT (96) post-cleanup; check
    // it's all-zero rather than spelling out 96 entries.
    let total = 0;
    for (let i = 0; i < out.excrete.length; i++) total += out.excrete[i];
    expect(total).toBe(0);
  });
});

describe("VM edge cases", () => {
  it("empty genome runs nothing", () => {
    const { out, state } = exec([]);
    expect(out.instructions).toBe(0);
    expect(state.pc).toBe(0);
    expect(state.stack).toEqual([]);
  });
  it("unknown opcodes act as NOP", () => {
    // budget covers the noop byte + the PUSH8 (2 instructions)
    const { state, out } = exec([0x7F, OP.PUSH8, 9], { budget: 2 });
    expect(state.stack).toEqual([9]);
    expect(out.instructions).toBe(2);
  });
  it("state persists across ticks", () => {
    const genome = new Uint8Array([OP.PUSH8, 7]);
    const state = newVMState();
    const out = newOutputs();
    runTick(genome, state, makeSensors(), makeSelf(), 1, out);
    expect(state.stack).toEqual([7]);
    runTick(genome, state, makeSensors(), makeSelf(), 1, out);
    expect(state.stack).toEqual([7, 7]);
  });
  it("operand-only-byte at end of genome wraps", () => {
    const { state, out } = exec([OP.PUSH8], { budget: 1 });
    expect(out.instructions).toBe(1);
    expect(state.stack).toEqual([OP.PUSH8]);
  });
  it("negative jumps past start renormalize", () => {
    expect(exec([OP.JMP, 0xF6], { budget: 5 }).out.instructions).toBe(5);
  });
});

describe("disassemble", () => {
  it("renders known opcodes by lowercase name", () => {
    // HALT was retired; the byte 0xFF disassembles as a `db 0xff`
    // (raw byte fallback) since it has no opcode label.
    const text = disassemble(new Uint8Array([OP.NOP, OP.REPRODUCE]));
    expect(text).toContain("nop");
    expect(text).toContain("reproduce");
  });
  it("renders PUSH8 with signed operand", () => {
    expect(disassemble(new Uint8Array([OP.PUSH8, 200, HALT_MARK]))).toContain("push8 -56");
  });
  it("renders JMP/JZ/JNZ signed operands", () => {
    const text = disassemble(new Uint8Array([OP.JMP, 5, OP.JZ, 0xFE, OP.JNZ, 0]));
    expect(text).toContain("jmp 5");
    expect(text).toContain("jz -2");
    expect(text).toContain("jnz 0");
  });
  it("renders material operand by name when provided", () => {
    const names = ["rock", "sand", "clay", "organic", "lipid", "gas"];
    // EXCRETE / INGEST still pass through the material-operand naming
    // map. With operand 7 mod 6 = 1, the name is "sand".
    const text = disassemble(new Uint8Array([OP.INGEST, 3, OP.EXCRETE, 7, HALT_MARK]), names);
    expect(text).toContain("ingest organic");
    expect(text).toContain("excrete sand");
  });
  it("renders material operand by index without names", () => {
    expect(disassemble(new Uint8Array([OP.INGEST, 2, HALT_MARK]))).toContain("ingest 2");
  });
  it("renders unknown bytes as db 0xNN", () => {
    expect(disassemble(new Uint8Array([0x7A]))).toContain("db 0x7a");
  });
  it("4-digit hex offsets per instruction", () => {
    const lines = disassemble(new Uint8Array([OP.NOP, OP.PUSH8, 1, HALT_MARK])).split("\n");
    expect(lines[0].startsWith("0000:")).toBe(true);
    expect(lines[1].startsWith("0001:")).toBe(true);
    expect(lines[2].startsWith("0003:")).toBe(true);
  });
});

describe("mutateGenome", () => {
  it("rng=1 (never trigger) -> identical copy", () => {
    expect(Array.from(mutateGenome(new Uint8Array([1, 2, 3, 4, 5]), () => 1))).toEqual([1, 2, 3, 4, 5]);
  });
  it("every byte deleted -> kept non-empty (no curated-default revival)", () => {
    let call = 0;
    const rng = () => { call++; return call === 1 ? 0 : 1; };
    const out = mutateGenome(new Uint8Array([7]), rng);
    expect(out.length).toBe(1);
  });
  it("rng=0 -> trailing insert keeps result non-empty", () => {
    const out = mutateGenome(new Uint8Array([1, 2, 3, 4, 5]), () => 0);
    expect(out.length).toBe(1);
    expect(out[0]).toBe(0);
  });
  it("seeded PRNG -> deterministic output", () => {
    const input = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    expect(Array.from(mutateGenome(input, mulberry32(42)))).toEqual(Array.from(mutateGenome(input, mulberry32(42))));
  });
  it("different seeds produce different output (probabilistic)", () => {
    const input = new Uint8Array(64).fill(0xAA);
    expect(Array.from(mutateGenome(input, mulberry32(1)))).not.toEqual(Array.from(mutateGenome(input, mulberry32(2))));
  });
  it("output stays at or below MAX_GENOME_BYTES (1024)", () => {
    expect(mutateGenome(new Uint8Array(1100).fill(0), () => 0.001).length).toBeLessThanOrEqual(1024);
  });
  it("mid-probability rng=0.5 preserves bytes", () => {
    expect(Array.from(mutateGenome(new Uint8Array([9, 8, 7, 6, 5]), () => 0.5))).toEqual([9, 8, 7, 6, 5]);
  });
});

describe("genomeMaterialCost", () => {
  it("distributes by byte % 6", () => {
    expect(Array.from(genomeMaterialCost(new Uint8Array([0, 1, 2, 3, 4, 5]), 1))).toEqual([1, 1, 1, 1, 1, 1]);
  });
  it("scales by massPerByte", () => {
    expect(Array.from(genomeMaterialCost(new Uint8Array([3, 3, 3]), 4))).toEqual([0, 0, 0, 12, 0, 0]);
  });
  it("aggregates duplicates", () => {
    expect(Array.from(genomeMaterialCost(new Uint8Array([0, 6, 12]), 1))).toEqual([3, 0, 0, 0, 0, 0]);
  });
  it("empty -> all zeros", () => {
    expect(Array.from(genomeMaterialCost(new Uint8Array([]), 5))).toEqual([0, 0, 0, 0, 0, 0]);
  });
  it("sum = length * massPerByte", () => {
    const genome = new Uint8Array(50).map((_, i) => (i * 37 + 11) & 0xFF);
    expect(Array.from(genomeMaterialCost(genome, 3)).reduce((a, b) => a + b, 0)).toBe(50 * 3);
  });
});

