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
  walkGenome,
  genomeSynthMask,
  viableGenome,
  SYNTH_KIND,
  SYNTH_KIND_COUNT,
  CATALYST_COUNT,
  SYNTH_BIT_BIO,
  SYNTH_BIT_AA,
  SYNTH_BIT_FA,
  SYNTH_BIT_ENZ,
  SYNTH_BIT_CHL,
  SYNTH_BIT_MRNA,
  SYNTH_BIT_PHOTO_BASE,
  SYNTH_BIT_CHEMO_BASE,
  SYNTH_BIT_MECH,
  SYNTH_BIT_THERMO,
  SYNTH_BIT_MAGNETO,
  SYNTH_BIT_BOND,
  SYNTH_BIT_REPAIR,
} from "../genome";
import { mulberry32 } from "../rng";

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
  it("no upper length cap: high insert rate grows past the old 1024 limit", () => {
    expect(mutateGenome(new Uint8Array(1100).fill(0), () => 0.001).length).toBeGreaterThan(1024);
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

// Characterization tests: a fixed, hand-built byte sequence must
// decode to a known, specific effect. Real genomes have surrounding
// junk that changes alignment/control-flow; these pin only the
// well-aligned base contract so the decoders can't silently regress.
describe("genome decoding: known byte sequences", () => {
  // The SYNTH op is 3 bytes: [SYNTH, kindByte, paramByte]. The live
  // VM is the source of truth for what a cell actually expresses.
  describe("dynamic VM (runTick) -- the executed contract", () => {
    it("[SYNTH, BIO, 0] sets the BIO synth bit", () => {
      const { out } = exec([OP.SYNTH, SYNTH_KIND.BIO, 0]);
      expect(out.synthMask & (1 << SYNTH_BIT_BIO)).toBeTruthy();
    });
    it("[SYNTH, FA, 0] sets the FA synth bit, not BIO", () => {
      const { out } = exec([OP.SYNTH, SYNTH_KIND.FA, 0]);
      expect(out.synthMask & (1 << SYNTH_BIT_FA)).toBeTruthy();
      expect(out.synthMask & (1 << SYNTH_BIT_BIO)).toBeFalsy();
    });
    it("[SYNTH, BOND, 200] sets BOND bit AND exposes marker 200", () => {
      const { out } = exec([OP.SYNTH, SYNTH_KIND.BOND, 200]);
      expect(out.synthMask & (1 << SYNTH_BIT_BOND)).toBeTruthy();
      expect(out.bondMarker).toBe(200);
    });
    it("[SYNTH, BOND, 7] -- the param byte is the greenbeard marker", () => {
      expect(exec([OP.SYNTH, SYNTH_KIND.BOND, 7]).out.bondMarker).toBe(7);
    });
    it("no SYNTH BOND -> bondMarker stays -1 (not adhesive)", () => {
      expect(exec([OP.SYNTH, SYNTH_KIND.BIO, 0]).out.bondMarker).toBe(-1);
    });
    it("kindByte is taken mod SYNTH_KIND_COUNT (wraps)", () => {
      // 14 + BOND == BOND after the mod, so this still expresses bond.
      const { out } = exec([OP.SYNTH, 14 + SYNTH_KIND.BOND, 99]);
      expect(out.synthMask & (1 << SYNTH_BIT_BOND)).toBeTruthy();
      expect(out.bondMarker).toBe(99);
    });
  });

  // walkGenome is the shared static iterator. It correctly steps over
  // operand bytes; what it exposes as `operand` is the contract other
  // static decoders depend on.
  describe("walkGenome static iteration", () => {
    it("visits ops at the right pc and skips operand bytes", () => {
      const seen: Array<[number, number]> = [];
      walkGenome(new Uint8Array([OP.PUSH8, 9, OP.THRUST, OP.PUSH8, 1]),
        (op, pc) => { seen.push([op, pc]); });
      expect(seen).toEqual([[OP.PUSH8, 0], [OP.THRUST, 2], [OP.PUSH8, 3]]);
    });
    it("exposes the operand of a 1-byte-operand op (PUSH8)", () => {
      let v: number | undefined = -999;
      walkGenome(new Uint8Array([OP.PUSH8, 42]), (op, _pc, operand) => {
        if (op === OP.PUSH8) v = operand;
      });
      expect(v).toBe(42);
    });
    it("exposes the first operand byte (kind) of SYNTH", () => {
      // Static decoders (genomeSynthMask/viableGenome/trophicMode) all
      // read this to learn which chem a cell builds. SYNTH has two
      // operand bytes; the first is the kind.
      let kindByte: number | undefined = -999;
      walkGenome(new Uint8Array([OP.SYNTH, SYNTH_KIND.FA, 7]),
        (op, _pc, operand) => { if (op === OP.SYNTH) kindByte = operand; });
      expect(kindByte).toBe(SYNTH_KIND.FA);
    });
  });

  // genomeSynthMask: static "what could this genome build" used for
  // engulfed cells whose VM doesn't run, and as the genotype classifier.
  describe("genomeSynthMask static synth intent", () => {
    it("[SYNTH BIO][SYNTH FA] -> BIO and FA bits set", () => {
      const g = new Uint8Array([
        OP.SYNTH, SYNTH_KIND.BIO, 0,
        OP.SYNTH, SYNTH_KIND.FA, 0,
      ]);
      const m = genomeSynthMask(g);
      expect(m & (1 << SYNTH_BIT_BIO)).toBeTruthy();
      expect(m & (1 << SYNTH_BIT_FA)).toBeTruthy();
    });
    it("a SYNTH BOND op is detectable in the static mask", () => {
      const g = new Uint8Array([OP.SYNTH, SYNTH_KIND.BOND, 123]);
      expect(genomeSynthMask(g) & (1 << SYNTH_BIT_BOND)).toBeTruthy();
    });
    it("no SYNTH ops -> empty mask", () => {
      expect(genomeSynthMask(new Uint8Array([OP.THRUST, OP.REPRODUCE]))).toBe(0);
    });
    it("matches the VM's bit for the same well-aligned op", () => {
      const bytes = [OP.SYNTH, SYNTH_KIND.FA, 0];
      const dyn = exec(bytes).out.synthMask;
      const stat = genomeSynthMask(new Uint8Array(bytes));
      expect(stat & (1 << SYNTH_BIT_FA)).toBe(dyn & (1 << SYNTH_BIT_FA));
    });
  });

  // viableGenome: structural gate (must have metabolism + reproduce +
  // sense + a trophic mode). Pinned at the coarse level only.
  describe("viableGenome structural gate", () => {
    it("a bare genome with no metabolism is not viable", () => {
      expect(viableGenome(new Uint8Array([OP.THRUST]))).toBe(false);
    });
    it("makeRandomViableGenome output passes its own viability gate", async () => {
      const { makeRandomViableGenome } = await import("../genome");
      for (let i = 0; i < 20; i++) {
        const g = makeRandomViableGenome(mulberry32(i + 1));
        expect(g).not.toBeNull();
        expect(viableGenome(g!)).toBe(true);
      }
    });
  });
});

// Every defined VM op must have its documented behavior pinned. The
// blocks above cover the common ops; this block fills the remainder so
// no defined opcode is unverified.
describe("VM op coverage: every defined op", () => {
  describe("stack ops (remaining)", () => {
    it("NOP does nothing and execution continues", () => {
      expect(exec([OP.NOP, OP.PUSH8, 5, OP.NOP, HALT_MARK]).state.stack).toEqual([5]);
    });
    it("OVER copies the second item to the top: [a,b] -> [a,b,a]", () => {
      expect(exec([OP.PUSH8, 1, OP.PUSH8, 2, OP.OVER, HALT_MARK]).state.stack).toEqual([1, 2, 1]);
    });
    it("ROT rotates top three: [a,b,c] -> [b,c,a]", () => {
      expect(exec([OP.PUSH8, 1, OP.PUSH8, 2, OP.PUSH8, 3, OP.ROT, HALT_MARK]).state.stack)
        .toEqual([2, 3, 1]);
    });
  });

  describe("arithmetic (remaining)", () => {
    it("MOD is floored modulo: 17 mod 5 = 2", () => {
      expect(exec([OP.PUSH8, 17, OP.PUSH8, 5, OP.MOD, HALT_MARK]).state.stack).toEqual([2]);
    });
    it("MOD with negative dividend stays floored: -7 mod 3 = 2", () => {
      // 249 -> i8 -7. -7 - floor(-7/3)*3 = -7 - (-3*3) = 2.
      expect(exec([OP.PUSH8, 249, OP.PUSH8, 3, OP.MOD, HALT_MARK]).state.stack).toEqual([2]);
    });
    it("MOD by zero pushes 0", () => {
      expect(exec([OP.PUSH8, 17, OP.PUSH8, 0, OP.MOD, HALT_MARK]).state.stack).toEqual([0]);
    });
    it("SIGN: positive -> 1, negative -> -1, zero -> 0", () => {
      expect(exec([OP.PUSH8, 9, OP.SIGN, HALT_MARK]).state.stack).toEqual([1]);
      expect(exec([OP.PUSH8, 249, OP.SIGN, HALT_MARK]).state.stack).toEqual([-1]);
      expect(exec([OP.PUSH8, 0, OP.SIGN, HALT_MARK]).state.stack).toEqual([0]);
    });
  });

  describe("logical ops", () => {
    it("NOT: 0 -> 1, nonzero -> 0", () => {
      expect(exec([OP.PUSH8, 0, OP.NOT, HALT_MARK]).state.stack).toEqual([1]);
      expect(exec([OP.PUSH8, 5, OP.NOT, HALT_MARK]).state.stack).toEqual([0]);
    });
    it("AND is logical (truthiness, not bitwise)", () => {
      expect(exec([OP.PUSH8, 5, OP.PUSH8, 9, OP.AND, HALT_MARK]).state.stack).toEqual([1]);
      expect(exec([OP.PUSH8, 5, OP.PUSH8, 0, OP.AND, HALT_MARK]).state.stack).toEqual([0]);
    });
    it("OR is logical (truthiness, not bitwise)", () => {
      expect(exec([OP.PUSH8, 0, OP.PUSH8, 0, OP.OR, HALT_MARK]).state.stack).toEqual([0]);
      expect(exec([OP.PUSH8, 0, OP.PUSH8, 4, OP.OR, HALT_MARK]).state.stack).toEqual([1]);
    });
  });

  describe("actuators (remaining)", () => {
    it("ENGULF sets the engulf flag (default false)", () => {
      expect(exec([OP.NOP, HALT_MARK]).out.engulf).toBe(false);
      expect(exec([OP.ENGULF, HALT_MARK]).out.engulf).toBe(true);
    });
    it("REPRODUCE fraction: in-range value is used verbatim", () => {
      // 1 / 4 = 0.25, within [0.1, 0.9].
      const { out } = exec([OP.PUSH8, 1, OP.PUSH8, 4, OP.DIV, OP.REPRODUCE, HALT_MARK]);
      expect(out.reproduce).toBe(true);
      expect(out.reproduceFraction).toBeCloseTo(0.25, 6);
    });
    it("REPRODUCE fraction: out-of-range collapses to symmetric 0.5", () => {
      const { out } = exec([OP.PUSH8, 5, OP.REPRODUCE, HALT_MARK]);
      expect(out.reproduceFraction).toBe(0.5);
    });
    it("SENSE_AMP is an inert marker (no stack/output effect)", () => {
      const { out, state } = exec([OP.SENSE_AMP, HALT_MARK]);
      expect(state.stack).toEqual([]);
      expect(out.thrustX).toBe(0);
      expect(out.synthMask).toBe(0);
    });
  });

  describe("genome self-modification", () => {
    function run(bytes: number[], budget: number): Uint8Array {
      const g = new Uint8Array(bytes);
      runTick(g, newVMState(), { chemConc: new Float32Array(96) },
        { energy: 100, mass: 0, membrane: 0 }, budget, newOutputs());
      return g;
    }
    it("POKE_BYTE writes value to genome[idx] in place (pops idx then val)", () => {
      // stack order: push val, push idx; POKE pops idx (top) then val.
      // Writes 42 into genome[0].
      const g = run([OP.PUSH8, 42, OP.PUSH8, 0, OP.POKE_BYTE], 3);
      expect(g[0]).toBe(42);
    });
    it("POKE_BYTE masks value to 8 bits and wraps idx mod length", () => {
      const g = run([OP.PUSH8, 1, OP.PUSH8, 100, OP.POKE_BYTE], 3);
      // idx 100 mod 5 = 0; value 1 & 0xff = 1.
      expect(g[0]).toBe(1);
    });
    it("SPLICE_DUP requests a duplicate (mode 1), length capped at 32", () => {
      const out = newOutputs();
      // push offset(2) then length(100); SPLICE pops length then offset.
      runTick(new Uint8Array([OP.PUSH8, 2, OP.PUSH8, 100, OP.SPLICE_DUP]),
        newVMState(), { chemConc: new Float32Array(96) },
        { energy: 100, mass: 0, membrane: 0 }, 3, out);
      expect(out.spliceMode).toBe(1);
      expect(out.spliceLength).toBe(32);
      expect(out.spliceOffset).toBe(2 % 5);
    });
    it("SPLICE_DEL requests a deletion (mode 2)", () => {
      const out = newOutputs();
      runTick(new Uint8Array([OP.PUSH8, 1, OP.PUSH8, 3, OP.SPLICE_DEL]),
        newVMState(), { chemConc: new Float32Array(96) },
        { energy: 100, mass: 0, membrane: 0 }, 3, out);
      expect(out.spliceMode).toBe(2);
      expect(out.spliceLength).toBe(3);
    });
  });

  describe("SYNTH: every kind sets its documented bit", () => {
    const bitOf: Array<[number, number]> = [
      [SYNTH_KIND.BIO, SYNTH_BIT_BIO],
      [SYNTH_KIND.AA, SYNTH_BIT_AA],
      [SYNTH_KIND.FA, SYNTH_BIT_FA],
      [SYNTH_KIND.ENZ, SYNTH_BIT_ENZ],
      [SYNTH_KIND.CHL, SYNTH_BIT_CHL],
      [SYNTH_KIND.MRNA, SYNTH_BIT_MRNA],
      [SYNTH_KIND.MECH, SYNTH_BIT_MECH],
      [SYNTH_KIND.THERMO, SYNTH_BIT_THERMO],
      [SYNTH_KIND.MAGNETO, SYNTH_BIT_MAGNETO],
      [SYNTH_KIND.BOND, SYNTH_BIT_BOND],
      [SYNTH_KIND.REPAIR, SYNTH_BIT_REPAIR],
    ];
    for (const [kind, bit] of bitOf) {
      it(`kind ${kind} -> synthMask bit ${bit}`, () => {
        expect(exec([OP.SYNTH, kind, 0, HALT_MARK]).out.synthMask).toBe(1 << bit);
      });
    }
    it("PHOTO param selects the band bit (param % 3)", () => {
      for (let p = 0; p < 5; p++) {
        expect(exec([OP.SYNTH, SYNTH_KIND.PHOTO, p, HALT_MARK]).out.synthMask)
          .toBe(1 << (SYNTH_BIT_PHOTO_BASE + (p % 3)));
      }
    });
    it("CHEMO param selects the target bit (param % 4)", () => {
      for (let p = 0; p < 6; p++) {
        expect(exec([OP.SYNTH, SYNTH_KIND.CHEMO, p, HALT_MARK]).out.synthMask)
          .toBe(1 << (SYNTH_BIT_CHEMO_BASE + (p % 4)));
      }
    });
    it("CAT routes to catSynthMask, not synthMask (param = slot)", () => {
      const { out } = exec([OP.SYNTH, SYNTH_KIND.CAT, 3, HALT_MARK]);
      expect(out.synthMask).toBe(0);
      expect(out.catSynthMask).toBe(1 << (3 % CATALYST_COUNT));
    });
    it("kindByte wraps mod SYNTH_KIND_COUNT", () => {
      expect(exec([OP.SYNTH, SYNTH_KIND_COUNT + SYNTH_KIND.AA, 0, HALT_MARK]).out.synthMask)
        .toBe(1 << SYNTH_BIT_AA);
    });
  });
});

