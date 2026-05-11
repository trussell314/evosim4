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
  dx: number[]; dy: number[]; dist: number[];
  creatureDx: number; creatureDy: number; creatureDist: number; creatureMass: number;
}> = {}): VMSensors {
  return {
    dx: new Float32Array(overrides.dx ?? [0, 0, 0, 0, 0, 0]),
    dy: new Float32Array(overrides.dy ?? [0, 0, 0, 0, 0, 0]),
    dist: new Float32Array(overrides.dist ?? [0, 0, 0, 0, 0, 0]),
    creatureDx: overrides.creatureDx ?? 0,
    creatureDy: overrides.creatureDy ?? 0,
    creatureDist: overrides.creatureDist ?? 0,
    creatureMass: overrides.creatureMass ?? 0,
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
  it("PUSH8 positive", () => {
    const { state } = exec([OP.PUSH8, 42, OP.HALT]);
    expect(state.stack).toEqual([42]);
  });
  it("PUSH8 sign-extends > 127", () => {
    const { state } = exec([OP.PUSH8, 200, OP.HALT]);
    expect(state.stack[0]).toBe(200 - 256);
  });
  it("PUSH8 0 and 127", () => {
    const { state } = exec([OP.PUSH8, 0, OP.PUSH8, 127, OP.HALT]);
    expect(state.stack).toEqual([0, 127]);
  });
  it("PUSH8 128 as -128", () => {
    const { state } = exec([OP.PUSH8, 128, OP.HALT]);
    expect(state.stack).toEqual([-128]);
  });
  it("POP", () => {
    const { state } = exec([OP.PUSH8, 1, OP.PUSH8, 2, OP.POP, OP.HALT]);
    expect(state.stack).toEqual([1]);
  });
  it("POP empty", () => {
    const { state } = exec([OP.POP, OP.POP, OP.PUSH8, 5, OP.HALT]);
    expect(state.stack).toEqual([5]);
  });
  it("DUP", () => {
    const { state } = exec([OP.PUSH8, 7, OP.DUP, OP.HALT]);
    expect(state.stack).toEqual([7, 7]);
  });
  it("DUP empty pushes two zeros", () => {
    const { state } = exec([OP.DUP, OP.HALT]);
    expect(state.stack).toEqual([0, 0]);
  });
  it("SWAP", () => {
    const { state } = exec([OP.PUSH8, 1, OP.PUSH8, 2, OP.SWAP, OP.HALT]);
    expect(state.stack).toEqual([2, 1]);
  });
  it("stack cap drops oldest", () => {
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
  it("ADD", () => {
    const { state } = exec([OP.PUSH8, 3, OP.PUSH8, 4, OP.ADD, OP.HALT]);
    expect(state.stack).toEqual([7]);
  });
  it("SUB", () => {
    const { state } = exec([OP.PUSH8, 10, OP.PUSH8, 3, OP.SUB, OP.HALT]);
    expect(state.stack).toEqual([7]);
  });
  it("MUL", () => {
    const { state } = exec([OP.PUSH8, 6, OP.PUSH8, 7, OP.MUL, OP.HALT]);
    expect(state.stack).toEqual([42]);
  });
  it("DIV", () => {
    const { state } = exec([OP.PUSH8, 20, OP.PUSH8, 4, OP.DIV, OP.HALT]);
    expect(state.stack).toEqual([5]);
  });
  it("DIV by zero -> 0", () => {
    const { state } = exec([OP.PUSH8, 20, OP.PUSH8, 0, OP.DIV, OP.HALT]);
    expect(state.stack).toEqual([0]);
  });
  it("NEG", () => {
    const { state } = exec([OP.PUSH8, 7, OP.NEG, OP.HALT]);
    expect(state.stack).toEqual([-7]);
  });
  it("ABS", () => {
    const { state } = exec([OP.PUSH8, 200, OP.ABS, OP.HALT]);
    expect(state.stack).toEqual([56]);
  });
  it("MIN", () => {
    const { state } = exec([OP.PUSH8, 3, OP.PUSH8, 9, OP.MIN, OP.HALT]);
    expect(state.stack).toEqual([3]);
  });
  it("MAX", () => {
    const { state } = exec([OP.PUSH8, 3, OP.PUSH8, 9, OP.MAX, OP.HALT]);
    expect(state.stack).toEqual([9]);
  });
  it("empty operands -> 0", () => {
    const { state } = exec([OP.ADD, OP.HALT]);
    expect(state.stack).toEqual([0]);
  });
});

describe("VM comparison", () => {
  it("LT true", () => {
    const { state } = exec([OP.PUSH8, 3, OP.PUSH8, 5, OP.LT, OP.HALT]);
    expect(state.stack).toEqual([1]);
  });
  it("LT false", () => {
    const { state } = exec([OP.PUSH8, 5, OP.PUSH8, 3, OP.LT, OP.HALT]);
    expect(state.stack).toEqual([0]);
  });
  it("LT equal", () => {
    const { state } = exec([OP.PUSH8, 3, OP.PUSH8, 3, OP.LT, OP.HALT]);
    expect(state.stack).toEqual([0]);
  });
  it("GT trio", () => {
    const a = exec([OP.PUSH8, 5, OP.PUSH8, 3, OP.GT, OP.HALT]);
    const b = exec([OP.PUSH8, 3, OP.PUSH8, 5, OP.GT, OP.HALT]);
    const c = exec([OP.PUSH8, 3, OP.PUSH8, 3, OP.GT, OP.HALT]);
    expect(a.state.stack).toEqual([1]);
    expect(b.state.stack).toEqual([0]);
    expect(c.state.stack).toEqual([0]);
  });
  it("EQ", () => {
    const a = exec([OP.PUSH8, 5, OP.PUSH8, 5, OP.EQ, OP.HALT]);
    const b = exec([OP.PUSH8, 5, OP.PUSH8, 3, OP.EQ, OP.HALT]);
    expect(a.state.stack).toEqual([1]);
    expect(b.state.stack).toEqual([0]);
  });
});

describe("VM control flow", () => {
  it("JMP +N forward", () => {
    const { state } = exec([OP.PUSH8, 1, OP.JMP, 1, OP.NOP, OP.PUSH8, 9, OP.HALT]);
    expect(state.stack).toEqual([1, 9]);
  });
  it("JMP -N backward (loops)", () => {
    const { state } = exec([OP.PUSH8, 1, OP.JMP, 0xFC], { budget: 10 });
    expect(state.stack.length).toBe(5);
    expect(state.stack.every((v) => v === 1)).toBe(true);
  });
  it("JZ taken/not", () => {
    const taken = exec([OP.PUSH8, 0, OP.JZ, 1, OP.NOP, OP.PUSH8, 9, OP.HALT]);
    const notTaken = exec([OP.PUSH8, 1, OP.JZ, 1, OP.NOP, OP.PUSH8, 9, OP.HALT]);
    expect(taken.state.stack).toEqual([9]);
    expect(notTaken.state.stack).toEqual([9]);
  });
  it("JNZ taken/not", () => {
    const taken = exec([OP.PUSH8, 1, OP.JNZ, 2, OP.PUSH8, 5, OP.PUSH8, 9, OP.HALT]);
    const notTaken = exec([OP.PUSH8, 0, OP.JNZ, 2, OP.PUSH8, 5, OP.PUSH8, 9, OP.HALT]);
    expect(taken.state.stack).toEqual([9]);
    expect(notTaken.state.stack).toEqual([5, 9]);
  });
  it("PC wraps past end", () => {
    const state = newVMState();
    exec([OP.PUSH8, 7], { state, budget: 6 });
    expect(state.stack.length).toBe(6);
  });
  it("HALT advances pc, stops loop", () => {
    const state = newVMState();
    const { out } = exec([OP.PUSH8, 1, OP.HALT, OP.PUSH8, 2], { state });
    expect(state.stack).toEqual([1]);
    expect(state.pc).toBe(3);
    expect(out.instructions).toBe(2);
  });
  it("budget caps no-halt", () => {
    const { out } = exec([OP.NOP, OP.NOP, OP.NOP], { budget: 5 });
    expect(out.instructions).toBe(5);
  });
});

describe("VM sensors", () => {
  it("SENSE_DX", () => {
    const sensors = makeSensors({ dx: [10, 20, 30, 40, 50, 60] });
    const { state } = exec([OP.SENSE_DX, 3, OP.HALT], { sensors });
    expect(state.stack).toEqual([40]);
  });
  it("SENSE_DY", () => {
    const sensors = makeSensors({ dy: [10, 20, 30, 40, 50, 60] });
    const { state } = exec([OP.SENSE_DY, 5, OP.HALT], { sensors });
    expect(state.stack).toEqual([60]);
  });
  it("SENSE_DIST", () => {
    const sensors = makeSensors({ dist: [10, 20, 30, 40, 50, 60] });
    const { state } = exec([OP.SENSE_DIST, 2, OP.HALT], { sensors });
    expect(state.stack).toEqual([30]);
  });
  it("sensor operand wraps mod 6", () => {
    const sensors = makeSensors({ dx: [11, 12, 13, 14, 15, 16] });
    const { state } = exec([OP.SENSE_DX, 8, OP.HALT], { sensors });
    expect(state.stack).toEqual([13]);
  });
  it("SELF_ENERGY", () => {
    const self = makeSelf({ energy: 77 });
    const { state } = exec([OP.SELF_ENERGY, OP.HALT], { self });
    expect(state.stack).toEqual([77]);
  });
  it("SELF_RESERVE", () => {
    const self = makeSelf({ reserve: [1, 2, 3, 4, 5, 6] });
    const { state } = exec([OP.SELF_RESERVE, 4, OP.HALT], { self });
    expect(state.stack).toEqual([5]);
  });
  it("SELF_VX/VY", () => {
    const self = makeSelf({ vx: 11, vy: -7 });
    const { state } = exec([OP.SELF_VX, OP.SELF_VY, OP.HALT], { self });
    expect(state.stack).toEqual([11, -7]);
  });
  it("SENSE_CRE_DX/DY/DIST/MASS", () => {
    const sensors = makeSensors({ creatureDx: 7, creatureDy: -3, creatureDist: 15, creatureMass: 42 });
    const { state } = exec(
      [OP.SENSE_CRE_DX, OP.SENSE_CRE_DY, OP.SENSE_CRE_DIST, OP.SENSE_CRE_MASS, OP.HALT],
      { sensors },
    );
    expect(state.stack).toEqual([7, -3, 15, 42]);
  });
  it("SELF_MASS", () => {
    const self = makeSelf({ mass: 88 });
    const { state } = exec([OP.SELF_MASS, OP.HALT], { self });
    expect(state.stack).toEqual([88]);
  });
});

describe("VM actuators", () => {
  it("THRUST accumulates", () => {
    const { out } = exec([OP.PUSH8, 30, OP.PUSH8, 40, OP.THRUST, OP.HALT]);
    expect(out.thrustX).toBe(30);
    expect(out.thrustY).toBe(40);
  });
  it("multiple THRUST accumulate", () => {
    const { out } = exec([
      OP.PUSH8, 10, OP.PUSH8, 20, OP.THRUST,
      OP.PUSH8, 5,  OP.PUSH8, 7,  OP.THRUST,
      OP.HALT,
    ]);
    expect(out.thrustX).toBe(15);
    expect(out.thrustY).toBe(27);
  });
  it("EXCRETE accumulates per material", () => {
    const { out } = exec([OP.PUSH8, 25, OP.EXCRETE, 3, OP.HALT]);
    expect(Array.from(out.excrete)).toEqual([0, 0, 0, 25, 0, 0]);
  });
  it("EXCRETE clamps negatives", () => {
    const { out } = exec([OP.PUSH8, 200, OP.EXCRETE, 0, OP.HALT]);
    expect(Array.from(out.excrete)).toEqual([0, 0, 0, 0, 0, 0]);
  });
  it("EXCRETE operand wraps", () => {
    const { out } = exec([OP.PUSH8, 10, OP.EXCRETE, 7, OP.HALT]);
    expect(Array.from(out.excrete)).toEqual([0, 10, 0, 0, 0, 0]);
  });
  it("REPRODUCE flag", () => {
    const { out } = exec([OP.REPRODUCE, OP.HALT]);
    expect(out.reproduce).toBe(true);
  });
  it("output reset between ticks", () => {
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
  it("empty genome no-op", () => {
    const { out, state } = exec([]);
    expect(out.instructions).toBe(0);
    expect(state.pc).toBe(0);
    expect(state.stack).toEqual([]);
  });
  it("unknown op = NOP", () => {
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
  it("operand-only-byte at end wraps", () => {
    const { state, out } = exec([OP.PUSH8], { budget: 1 });
    expect(out.instructions).toBe(1);
    expect(state.stack).toEqual([OP.PUSH8]);
  });
  it("negative jump renormalizes", () => {
    const { out } = exec([OP.JMP, 0xF6], { budget: 5 });
    expect(out.instructions).toBe(5);
  });
});

describe("disassemble", () => {
  it("known op names", () => {
    const text = disassemble(new Uint8Array([OP.NOP, OP.HALT]));
    expect(text).toContain("nop");
    expect(text).toContain("halt");
  });
  it("PUSH8 signed operand", () => {
    const text = disassemble(new Uint8Array([OP.PUSH8, 200, OP.HALT]));
    expect(text).toContain("push8 -56");
  });
  it("JMP/JZ/JNZ signed operand", () => {
    const text = disassemble(new Uint8Array([OP.JMP, 5, OP.JZ, 0xFE, OP.JNZ, 0]));
    expect(text).toContain("jmp 5");
    expect(text).toContain("jz -2");
    expect(text).toContain("jnz 0");
  });
  it("material operand by name", () => {
    const names = ["rock", "sand", "clay", "organic", "lipid", "gas"];
    const text = disassemble(new Uint8Array([OP.SENSE_DX, 3, OP.EXCRETE, 7, OP.HALT]), names);
    expect(text).toContain("sense_dx organic");
    expect(text).toContain("excrete sand");
  });
  it("material operand by index when no names", () => {
    const text = disassemble(new Uint8Array([OP.SENSE_DX, 2, OP.HALT]));
    expect(text).toContain("sense_dx 2");
  });
  it("unknown byte as db 0xNN", () => {
    const text = disassemble(new Uint8Array([0x7A]));
    expect(text).toContain("db 0x7a");
  });
  it("4-digit hex offsets", () => {
    const text = disassemble(new Uint8Array([OP.NOP, OP.PUSH8, 1, OP.HALT]));
    const lines = text.split("\n");
    expect(lines[0].startsWith("0000:")).toBe(true);
    expect(lines[1].startsWith("0001:")).toBe(true);
    expect(lines[2].startsWith("0003:")).toBe(true);
  });
});

describe("mutateGenome", () => {
  it("rng=1 never triggers -> identical", () => {
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const out = mutateGenome(input, () => 1);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });
  it("empty output falls back to default", () => {
    const input = new Uint8Array([7]);
    let call = 0;
    const rng = (): number => { call++; return call === 1 ? 0 : 1; };
    const out = mutateGenome(input, rng);
    expect(Array.from(out)).toEqual(Array.from(makeDefaultGenome()));
  });
  it("rng=0 deletes-all-then-trailing-insert", () => {
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const out = mutateGenome(input, () => 0);
    expect(out.length).toBe(1);
    expect(out[0]).toBe(0);
  });
  it("seeded -> deterministic", () => {
    const input = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const a = mutateGenome(input, mulberry32(42));
    const b = mutateGenome(input, mulberry32(42));
    expect(Array.from(a)).toEqual(Array.from(b));
  });
  it("different seeds -> different output", () => {
    const input = new Uint8Array(64).fill(0xAA);
    const a = mutateGenome(input, mulberry32(1));
    const b = mutateGenome(input, mulberry32(2));
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
  it("bounded at MAX_GENOME_BYTES (256)", () => {
    const input = new Uint8Array(250).fill(0);
    const out = mutateGenome(input, () => 0.001);
    expect(out.length).toBeLessThanOrEqual(256);
  });
  it("mid-probability rng=0.5 -> identical", () => {
    const input = new Uint8Array([9, 8, 7, 6, 5]);
    const out = mutateGenome(input, () => 0.5);
    expect(Array.from(out)).toEqual([9, 8, 7, 6, 5]);
  });
});

describe("genomeMaterialCost", () => {
  it("distributes by byte % 6", () => {
    const genome = new Uint8Array([0, 1, 2, 3, 4, 5]);
    expect(Array.from(genomeMaterialCost(genome, 1))).toEqual([1, 1, 1, 1, 1, 1]);
  });
  it("scales by massPerByte", () => {
    const genome = new Uint8Array([3, 3, 3]);
    expect(Array.from(genomeMaterialCost(genome, 4))).toEqual([0, 0, 0, 12, 0, 0]);
  });
  it("aggregates duplicates", () => {
    const genome = new Uint8Array([0, 6, 12]);
    expect(Array.from(genomeMaterialCost(genome, 1))).toEqual([3, 0, 0, 0, 0, 0]);
  });
  it("empty -> zeros", () => {
    expect(Array.from(genomeMaterialCost(new Uint8Array([]), 5))).toEqual([0, 0, 0, 0, 0, 0]);
  });
  it("sum = length * massPerByte", () => {
    const genome = new Uint8Array(50).map((_, i) => (i * 37 + 11) & 0xFF);
    const total = Array.from(genomeMaterialCost(genome, 3)).reduce((a, b) => a + b, 0);
    expect(total).toBe(50 * 3);
  });
});

describe("makeDefaultGenome", () => {
  it("fresh array each call", () => {
    const a = makeDefaultGenome();
    const b = makeDefaultGenome();
    a[0] = 0;
    expect(b[0]).not.toBe(0);
  });
  it("contains starter ops", () => {
    const g = makeDefaultGenome();
    expect(g[0]).toBe(OP.SENSE_DX);
    expect(g[1]).toBe(3);
    expect(g[g.length - 1]).toBe(OP.HALT);
    expect(Array.from(g)).toContain(OP.THRUST);
    expect(Array.from(g)).toContain(OP.REPRODUCE);
  });
});
