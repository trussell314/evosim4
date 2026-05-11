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
  makeDefaultGenome,
} from "../genome";

function makeSensors(overrides: Partial<{
  gradX: number[]; gradY: number[];
  creatureDx: number; creatureDy: number; creatureDist: number; creatureMass: number;
  light: number;
}> = {}): VMSensors {
  return {
    gradX: new Float32Array(overrides.gradX ?? [0, 0, 0, 0, 0, 0]),
    gradY: new Float32Array(overrides.gradY ?? [0, 0, 0, 0, 0, 0]),
    creatureDx: overrides.creatureDx ?? 0,
    creatureDy: overrides.creatureDy ?? 0,
    creatureDist: overrides.creatureDist ?? 0,
    creatureMass: overrides.creatureMass ?? 0,
    light: overrides.light ?? 0,
  };
}

function makeSelf(overrides: Partial<{
  energy: number; vx: number; vy: number; reserve: number[]; mass: number;
}> = {}): VMSelf {
  return {
    energy: overrides.energy ?? 100,
    vx: overrides.vx ?? 0,
    vy: overrides.vy ?? 0,
    reserve: new Float32Array(overrides.reserve ?? [0, 0, 0, 0, 0, 0]),
    mass: overrides.mass ?? 0,
    biomass: 0, age: 0,
    glucose: 0, o2: 0, fattyAcid: 0, aminoAcid: 0, waste: 0,
  };
}

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
  const budget = opts.budget ?? 64;
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
    expect(exec([OP.PUSH8, 42, OP.HALT]).state.stack).toEqual([42]);
  });
  it("PUSH8 sign-extends bytes > 127", () => {
    expect(exec([OP.PUSH8, 200, OP.HALT]).state.stack[0]).toBe(-56);
  });
  it("PUSH8 handles 0 and 127", () => {
    expect(exec([OP.PUSH8, 0, OP.PUSH8, 127, OP.HALT]).state.stack).toEqual([0, 127]);
  });
  it("PUSH8 handles 128 as -128", () => {
    expect(exec([OP.PUSH8, 128, OP.HALT]).state.stack).toEqual([-128]);
  });
  it("POP removes top", () => {
    expect(exec([OP.PUSH8, 1, OP.PUSH8, 2, OP.POP, OP.HALT]).state.stack).toEqual([1]);
  });
  it("POP on empty is a no-op", () => {
    expect(exec([OP.POP, OP.POP, OP.PUSH8, 5, OP.HALT]).state.stack).toEqual([5]);
  });
  it("DUP duplicates top", () => {
    expect(exec([OP.PUSH8, 7, OP.DUP, OP.HALT]).state.stack).toEqual([7, 7]);
  });
  it("DUP on empty pushes two zeros", () => {
    expect(exec([OP.DUP, OP.HALT]).state.stack).toEqual([0, 0]);
  });
  it("SWAP exchanges top two", () => {
    expect(exec([OP.PUSH8, 1, OP.PUSH8, 2, OP.SWAP, OP.HALT]).state.stack).toEqual([2, 1]);
  });
  it("stack capped at 32 (drops oldest)", () => {
    const bytes: number[] = [];
    for (let i = 1; i <= 40; i++) bytes.push(OP.PUSH8, i);
    bytes.push(OP.HALT);
    const { state } = exec(bytes, { budget: 200 });
    expect(state.stack.length).toBe(32);
    expect(state.stack[0]).toBe(9);
    expect(state.stack[31]).toBe(40);
  });
});

describe("VM arithmetic", () => {
  it("ADD", () => { expect(exec([OP.PUSH8, 3, OP.PUSH8, 4, OP.ADD, OP.HALT]).state.stack).toEqual([7]); });
  it("SUB", () => { expect(exec([OP.PUSH8, 10, OP.PUSH8, 3, OP.SUB, OP.HALT]).state.stack).toEqual([7]); });
  it("MUL", () => { expect(exec([OP.PUSH8, 6, OP.PUSH8, 7, OP.MUL, OP.HALT]).state.stack).toEqual([42]); });
  it("DIV", () => { expect(exec([OP.PUSH8, 20, OP.PUSH8, 4, OP.DIV, OP.HALT]).state.stack).toEqual([5]); });
  it("DIV by zero pushes 0", () => { expect(exec([OP.PUSH8, 20, OP.PUSH8, 0, OP.DIV, OP.HALT]).state.stack).toEqual([0]); });
  it("NEG", () => { expect(exec([OP.PUSH8, 7, OP.NEG, OP.HALT]).state.stack).toEqual([-7]); });
  it("ABS", () => { expect(exec([OP.PUSH8, 200, OP.ABS, OP.HALT]).state.stack).toEqual([56]); });
  it("MIN", () => { expect(exec([OP.PUSH8, 3, OP.PUSH8, 9, OP.MIN, OP.HALT]).state.stack).toEqual([3]); });
  it("MAX", () => { expect(exec([OP.PUSH8, 3, OP.PUSH8, 9, OP.MAX, OP.HALT]).state.stack).toEqual([9]); });
  it("empty operands -> 0", () => { expect(exec([OP.ADD, OP.HALT]).state.stack).toEqual([0]); });
});

describe("VM comparison", () => {
  it("LT true", () => { expect(exec([OP.PUSH8, 3, OP.PUSH8, 5, OP.LT, OP.HALT]).state.stack).toEqual([1]); });
  it("LT false", () => { expect(exec([OP.PUSH8, 5, OP.PUSH8, 3, OP.LT, OP.HALT]).state.stack).toEqual([0]); });
  it("LT equal pushes 0", () => { expect(exec([OP.PUSH8, 3, OP.PUSH8, 3, OP.LT, OP.HALT]).state.stack).toEqual([0]); });
  it("GT true/false/equal", () => {
    expect(exec([OP.PUSH8, 5, OP.PUSH8, 3, OP.GT, OP.HALT]).state.stack).toEqual([1]);
    expect(exec([OP.PUSH8, 3, OP.PUSH8, 5, OP.GT, OP.HALT]).state.stack).toEqual([0]);
    expect(exec([OP.PUSH8, 3, OP.PUSH8, 3, OP.GT, OP.HALT]).state.stack).toEqual([0]);
  });
  it("EQ true and false", () => {
    expect(exec([OP.PUSH8, 5, OP.PUSH8, 5, OP.EQ, OP.HALT]).state.stack).toEqual([1]);
    expect(exec([OP.PUSH8, 5, OP.PUSH8, 3, OP.EQ, OP.HALT]).state.stack).toEqual([0]);
  });
});

describe("VM control flow", () => {
  it("JMP forward N", () => {
    expect(exec([OP.PUSH8, 1, OP.JMP, 1, OP.NOP, OP.PUSH8, 9, OP.HALT]).state.stack).toEqual([1, 9]);
  });
  it("JMP backward (loops, budget-bound)", () => {
    const { state } = exec([OP.PUSH8, 1, OP.JMP, 0xFC], { budget: 10 });
    expect(state.stack.length).toBe(5);
  });
  it("JZ taken / not-taken", () => {
    expect(exec([OP.PUSH8, 0, OP.JZ, 1, OP.NOP, OP.PUSH8, 9, OP.HALT]).state.stack).toEqual([9]);
    expect(exec([OP.PUSH8, 1, OP.JZ, 1, OP.NOP, OP.PUSH8, 9, OP.HALT]).state.stack).toEqual([9]);
  });
  it("JNZ taken / not-taken", () => {
    expect(exec([OP.PUSH8, 1, OP.JNZ, 2, OP.PUSH8, 5, OP.PUSH8, 9, OP.HALT]).state.stack).toEqual([9]);
    expect(exec([OP.PUSH8, 0, OP.JNZ, 2, OP.PUSH8, 5, OP.PUSH8, 9, OP.HALT]).state.stack).toEqual([5, 9]);
  });
  it("PC wraps past end of genome", () => {
    const state = newVMState();
    exec([OP.PUSH8, 7], { state, budget: 6 });
    expect(state.stack.length).toBe(6);
  });
  it("HALT yields, pc advances past HALT byte", () => {
    const state = newVMState();
    const { out } = exec([OP.PUSH8, 1, OP.HALT, OP.PUSH8, 2], { state });
    expect(state.stack).toEqual([1]);
    expect(state.pc).toBe(3);
    expect(out.instructions).toBe(2);
  });
  it("budget caps even without HALT", () => {
    expect(exec([OP.NOP, OP.NOP, OP.NOP], { budget: 5 }).out.instructions).toBe(5);
  });
});

describe("VM sensors", () => {
  it("SENSE_GRAD_X/Y read by material index", () => {
    expect(exec([OP.SENSE_GRAD_X, 3, OP.HALT], { sensors: makeSensors({ gradX: [10, 20, 30, 40, 50, 60] }) }).state.stack).toEqual([40]);
    expect(exec([OP.SENSE_GRAD_Y, 5, OP.HALT], { sensors: makeSensors({ gradY: [10, 20, 30, 40, 50, 60] }) }).state.stack).toEqual([60]);
  });
  it("sensor operand wraps via modulo", () => {
    expect(exec([OP.SENSE_GRAD_X, 8, OP.HALT], { sensors: makeSensors({ gradX: [11, 12, 13, 14, 15, 16] }) }).state.stack).toEqual([13]);
  });
  it("SELF_ENERGY", () => {
    expect(exec([OP.SELF_ENERGY, OP.HALT], { self: makeSelf({ energy: 77 }) }).state.stack).toEqual([77]);
  });
  it("SELF_RESERVE", () => {
    expect(exec([OP.SELF_RESERVE, 4, OP.HALT], { self: makeSelf({ reserve: [1, 2, 3, 4, 5, 6] }) }).state.stack).toEqual([5]);
  });
  it("SELF_VX / SELF_VY", () => {
    expect(exec([OP.SELF_VX, OP.SELF_VY, OP.HALT], { self: makeSelf({ vx: 11, vy: -7 }) }).state.stack).toEqual([11, -7]);
  });
  it("SENSE_CRE_DX/DY/DIST/MASS", () => {
    const sensors = makeSensors({ creatureDx: 7, creatureDy: -3, creatureDist: 15, creatureMass: 42 });
    expect(exec([OP.SENSE_CRE_DX, OP.SENSE_CRE_DY, OP.SENSE_CRE_DIST, OP.SENSE_CRE_MASS, OP.HALT], { sensors }).state.stack).toEqual([7, -3, 15, 42]);
  });
  it("SELF_MASS", () => {
    expect(exec([OP.SELF_MASS, OP.HALT], { self: makeSelf({ mass: 88 }) }).state.stack).toEqual([88]);
  });
  it("SENSE_LIGHT", () => {
    expect(exec([OP.SENSE_LIGHT, OP.HALT], { sensors: makeSensors({ light: 0.73 }) }).state.stack).toEqual([0.73]);
  });
});

describe("VM actuators", () => {
  it("THRUST pops ay,ax and accumulates", () => {
    const { out } = exec([OP.PUSH8, 30, OP.PUSH8, 40, OP.THRUST, OP.HALT]);
    expect(out.thrustX).toBe(30);
    expect(out.thrustY).toBe(40);
  });
  it("multiple THRUSTs accumulate", () => {
    const { out } = exec([OP.PUSH8, 10, OP.PUSH8, 20, OP.THRUST, OP.PUSH8, 5, OP.PUSH8, 7, OP.THRUST, OP.HALT]);
    expect(out.thrustX).toBe(15);
    expect(out.thrustY).toBe(27);
  });
  it("EXCRETE accumulates per material", () => {
    expect(Array.from(exec([OP.PUSH8, 25, OP.EXCRETE, 3, OP.HALT]).out.excrete)).toEqual([0, 0, 0, 25, 0, 0]);
  });
  it("EXCRETE clamps negatives to 0", () => {
    expect(Array.from(exec([OP.PUSH8, 200, OP.EXCRETE, 0, OP.HALT]).out.excrete)).toEqual([0, 0, 0, 0, 0, 0]);
  });
  it("EXCRETE operand wraps via modulo", () => {
    expect(Array.from(exec([OP.PUSH8, 10, OP.EXCRETE, 7, OP.HALT]).out.excrete)).toEqual([0, 10, 0, 0, 0, 0]);
  });
  it("REPRODUCE flag", () => {
    expect(exec([OP.REPRODUCE, OP.HALT]).out.reproduce).toBe(true);
  });
  it("PREDATE flag", () => {
    expect(exec([OP.PREDATE, OP.HALT]).out.predate).toBe(true);
  });
  it("output reset between runTick calls", () => {
    const state = newVMState();
    const out = newOutputs();
    runTick(new Uint8Array([OP.REPRODUCE, OP.HALT]), state, makeSensors(), makeSelf(), 32, out);
    expect(out.reproduce).toBe(true);
    runTick(new Uint8Array([OP.NOP, OP.HALT]), newVMState(), makeSensors(), makeSelf(), 32, out);
    expect(out.reproduce).toBe(false);
    expect(out.thrustX).toBe(0);
    expect(out.thrustY).toBe(0);
    expect(Array.from(out.excrete)).toEqual([0, 0, 0, 0, 0, 0]);
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
    const { state, out } = exec([0x7F, OP.PUSH8, 9, OP.HALT]);
    expect(state.stack).toEqual([9]);
    expect(out.instructions).toBe(3);
  });
  it("state persists across ticks", () => {
    const genome = new Uint8Array([OP.PUSH8, 7, OP.HALT]);
    const state = newVMState();
    const out = newOutputs();
    runTick(genome, state, makeSensors(), makeSelf(), 32, out);
    expect(state.stack).toEqual([7]);
    runTick(genome, state, makeSensors(), makeSelf(), 32, out);
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
    const text = disassemble(new Uint8Array([OP.NOP, OP.HALT]));
    expect(text).toContain("nop");
    expect(text).toContain("halt");
  });
  it("renders PUSH8 with signed operand", () => {
    expect(disassemble(new Uint8Array([OP.PUSH8, 200, OP.HALT]))).toContain("push8 -56");
  });
  it("renders JMP/JZ/JNZ signed operands", () => {
    const text = disassemble(new Uint8Array([OP.JMP, 5, OP.JZ, 0xFE, OP.JNZ, 0]));
    expect(text).toContain("jmp 5");
    expect(text).toContain("jz -2");
    expect(text).toContain("jnz 0");
  });
  it("renders material operand by name when provided", () => {
    const names = ["rock", "sand", "clay", "organic", "lipid", "gas"];
    const text = disassemble(new Uint8Array([OP.SENSE_GRAD_X, 3, OP.EXCRETE, 7, OP.HALT]), names);
    expect(text).toContain("sense_grad_x organic");
    expect(text).toContain("excrete sand");
  });
  it("renders material operand by index without names", () => {
    expect(disassemble(new Uint8Array([OP.SENSE_GRAD_X, 2, OP.HALT]))).toContain("sense_grad_x 2");
  });
  it("renders unknown bytes as db 0xNN", () => {
    expect(disassemble(new Uint8Array([0x7A]))).toContain("db 0x7a");
  });
  it("4-digit hex offsets per instruction", () => {
    const lines = disassemble(new Uint8Array([OP.NOP, OP.PUSH8, 1, OP.HALT])).split("\n");
    expect(lines[0].startsWith("0000:")).toBe(true);
    expect(lines[1].startsWith("0001:")).toBe(true);
    expect(lines[2].startsWith("0003:")).toBe(true);
  });
});

describe("mutateGenome", () => {
  it("rng=1 (never trigger) -> identical copy", () => {
    expect(Array.from(mutateGenome(new Uint8Array([1, 2, 3, 4, 5]), () => 1))).toEqual([1, 2, 3, 4, 5]);
  });
  it("empty result -> falls back to default", () => {
    let call = 0;
    const rng = () => { call++; return call === 1 ? 0 : 1; };
    expect(Array.from(mutateGenome(new Uint8Array([7]), rng))).toEqual(Array.from(makeDefaultGenome()));
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
  it("output stays at or below MAX_GENOME_BYTES (256)", () => {
    expect(mutateGenome(new Uint8Array(250).fill(0), () => 0.001).length).toBeLessThanOrEqual(256);
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

describe("makeDefaultGenome", () => {
  it("returns fresh array each call (no shared mutation)", () => {
    const a = makeDefaultGenome();
    const b = makeDefaultGenome();
    a[0] = 0;
    expect(b[0]).not.toBe(0);
  });
  it("contains the starter behavior bytes", () => {
    const g = makeDefaultGenome();
    expect(g[0]).toBe(OP.SENSE_GRAD_X);
    expect(g[1]).toBe(3);
    expect(g[g.length - 1]).toBe(OP.HALT);
    expect(Array.from(g)).toContain(OP.THRUST);
    expect(Array.from(g)).toContain(OP.REPRODUCE);
  });
});
