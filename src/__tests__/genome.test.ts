// Genome VM unit tests.

import { describe, it, expect } from "vitest";
import {
  OP,
  type VMSensors, type VMSelf, type VMOutputs, type VMState,
  newVMState, newOutputs, runTick,
  disassemble, mutateGenome, genomeMaterialCost, makeDefaultGenome,
} from "../genome";

function makeSensors(overrides: Partial<{
  dx: number[]; dy: number[]; dist: number[];
  creatureDx: number; creatureDy: number; creatureDist: number; creatureMass: number;
  light: number;
}> = {}): VMSensors {
  return {
    dx: new Float32Array(overrides.dx ?? [0, 0, 0, 0, 0, 0]),
    dy: new Float32Array(overrides.dy ?? [0, 0, 0, 0, 0, 0]),
    dist: new Float32Array(overrides.dist ?? [0, 0, 0, 0, 0, 0]),
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
  };
}

function exec(bytes: number[], opts: { state?: VMState; sensors?: VMSensors; self?: VMSelf; budget?: number } = {}): { out: VMOutputs; state: VMState } {
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

describe("VM stack", () => {
  it("PUSH8/POP", () => {
    const { state } = exec([OP.PUSH8, 42, OP.HALT]);
    expect(state.stack).toEqual([42]);
  });
  it("sign-extends", () => {
    const { state } = exec([OP.PUSH8, 200, OP.HALT]);
    expect(state.stack[0]).toBe(-56);
  });
  it("cap drops oldest", () => {
    const bytes: number[] = [];
    for (let i = 1; i <= 40; i++) bytes.push(OP.PUSH8, i);
    bytes.push(OP.HALT);
    const { state } = exec(bytes, { budget: 200 });
    expect(state.stack.length).toBe(32);
  });
});

describe("VM arithmetic", () => {
  it("basics", () => {
    expect(exec([OP.PUSH8, 3, OP.PUSH8, 4, OP.ADD, OP.HALT]).state.stack).toEqual([7]);
    expect(exec([OP.PUSH8, 10, OP.PUSH8, 3, OP.SUB, OP.HALT]).state.stack).toEqual([7]);
    expect(exec([OP.PUSH8, 6, OP.PUSH8, 7, OP.MUL, OP.HALT]).state.stack).toEqual([42]);
    expect(exec([OP.PUSH8, 20, OP.PUSH8, 4, OP.DIV, OP.HALT]).state.stack).toEqual([5]);
    expect(exec([OP.PUSH8, 20, OP.PUSH8, 0, OP.DIV, OP.HALT]).state.stack).toEqual([0]);
  });
});

describe("VM comparison", () => {
  it("LT/GT/EQ", () => {
    expect(exec([OP.PUSH8, 3, OP.PUSH8, 5, OP.LT, OP.HALT]).state.stack).toEqual([1]);
    expect(exec([OP.PUSH8, 5, OP.PUSH8, 3, OP.GT, OP.HALT]).state.stack).toEqual([1]);
    expect(exec([OP.PUSH8, 5, OP.PUSH8, 5, OP.EQ, OP.HALT]).state.stack).toEqual([1]);
  });
});

describe("VM control flow", () => {
  it("JMP forward", () => {
    const { state } = exec([OP.PUSH8, 1, OP.JMP, 1, OP.NOP, OP.PUSH8, 9, OP.HALT]);
    expect(state.stack).toEqual([1, 9]);
  });
  it("HALT yields", () => {
    const state = newVMState();
    const { out } = exec([OP.PUSH8, 1, OP.HALT, OP.PUSH8, 2], { state });
    expect(state.stack).toEqual([1]);
    expect(state.pc).toBe(3);
    expect(out.instructions).toBe(2);
  });
  it("budget caps", () => {
    const { out } = exec([OP.NOP, OP.NOP, OP.NOP], { budget: 5 });
    expect(out.instructions).toBe(5);
  });
});

describe("VM sensors", () => {
  it("SENSE_DX/DY/DIST", () => {
    const sensors = makeSensors({ dx: [10, 20, 30, 40, 50, 60] });
    expect(exec([OP.SENSE_DX, 3, OP.HALT], { sensors }).state.stack).toEqual([40]);
  });
  it("SELF_ENERGY/MASS", () => {
    expect(exec([OP.SELF_ENERGY, OP.HALT], { self: makeSelf({ energy: 77 }) }).state.stack).toEqual([77]);
    expect(exec([OP.SELF_MASS, OP.HALT], { self: makeSelf({ mass: 88 }) }).state.stack).toEqual([88]);
  });
  it("SENSE_CRE_*", () => {
    const sensors = makeSensors({ creatureDx: 7, creatureDy: -3, creatureDist: 15, creatureMass: 42 });
    expect(exec([OP.SENSE_CRE_DX, OP.SENSE_CRE_DY, OP.SENSE_CRE_DIST, OP.SENSE_CRE_MASS, OP.HALT], { sensors }).state.stack).toEqual([7, -3, 15, 42]);
  });
  it("SENSE_LIGHT", () => {
    expect(exec([OP.SENSE_LIGHT, OP.HALT], { sensors: makeSensors({ light: 0.73 }) }).state.stack).toEqual([0.73]);
  });
});

describe("VM actuators", () => {
  it("THRUST accumulates", () => {
    const { out } = exec([OP.PUSH8, 30, OP.PUSH8, 40, OP.THRUST, OP.HALT]);
    expect(out.thrustX).toBe(30);
    expect(out.thrustY).toBe(40);
  });
  it("EXCRETE per material", () => {
    const { out } = exec([OP.PUSH8, 25, OP.EXCRETE, 3, OP.HALT]);
    expect(Array.from(out.excrete)).toEqual([0, 0, 0, 25, 0, 0]);
  });
  it("REPRODUCE", () => {
    expect(exec([OP.REPRODUCE, OP.HALT]).out.reproduce).toBe(true);
  });
  it("PREDATE", () => {
    expect(exec([OP.PREDATE, OP.HALT]).out.predate).toBe(true);
  });
  it("PHOTOSYNTH", () => {
    expect(exec([OP.PHOTOSYNTH, OP.HALT]).out.photosynth).toBe(true);
  });
  it("output reset between ticks", () => {
    const state = newVMState();
    const out = newOutputs();
    runTick(new Uint8Array([OP.REPRODUCE, OP.HALT]), state, makeSensors(), makeSelf(), 32, out);
    expect(out.reproduce).toBe(true);
    runTick(new Uint8Array([OP.NOP, OP.HALT]), newVMState(), makeSensors(), makeSelf(), 32, out);
    expect(out.reproduce).toBe(false);
  });
});

describe("VM edge cases", () => {
  it("empty genome", () => {
    const { out } = exec([]);
    expect(out.instructions).toBe(0);
  });
  it("unknown op = NOP", () => {
    const { state } = exec([0x7F, OP.PUSH8, 9, OP.HALT]);
    expect(state.stack).toEqual([9]);
  });
});

describe("disassemble", () => {
  it("renders names", () => {
    expect(disassemble(new Uint8Array([OP.NOP, OP.HALT]))).toContain("nop");
  });
  it("PUSH8 signed", () => {
    expect(disassemble(new Uint8Array([OP.PUSH8, 200, OP.HALT]))).toContain("push8 -56");
  });
  it("material by name", () => {
    const names = ["rock", "sand", "clay", "organic", "lipid", "gas"];
    expect(disassemble(new Uint8Array([OP.SENSE_DX, 3]), names)).toContain("sense_dx organic");
  });
  it("unknown byte", () => {
    expect(disassemble(new Uint8Array([0x7A]))).toContain("db 0x7a");
  });
});

describe("mutateGenome", () => {
  it("rng=1 -> identical", () => {
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    expect(Array.from(mutateGenome(input, () => 1))).toEqual([1, 2, 3, 4, 5]);
  });
  it("empty result -> default", () => {
    const input = new Uint8Array([7]);
    let call = 0;
    const rng = () => { call++; return call === 1 ? 0 : 1; };
    expect(Array.from(mutateGenome(input, rng))).toEqual(Array.from(makeDefaultGenome()));
  });
  it("seeded deterministic", () => {
    const input = new Uint8Array([10, 20, 30, 40, 50]);
    const a = mutateGenome(input, mulberry32(42));
    const b = mutateGenome(input, mulberry32(42));
    expect(Array.from(a)).toEqual(Array.from(b));
  });
  it("bounded", () => {
    const out = mutateGenome(new Uint8Array(250).fill(0), () => 0.001);
    expect(out.length).toBeLessThanOrEqual(256);
  });
});

describe("genomeMaterialCost", () => {
  it("distributes by byte % 6", () => {
    expect(Array.from(genomeMaterialCost(new Uint8Array([0, 1, 2, 3, 4, 5]), 1))).toEqual([1, 1, 1, 1, 1, 1]);
  });
  it("scales by massPerByte", () => {
    expect(Array.from(genomeMaterialCost(new Uint8Array([3, 3, 3]), 4))).toEqual([0, 0, 0, 12, 0, 0]);
  });
  it("empty -> zeros", () => {
    expect(Array.from(genomeMaterialCost(new Uint8Array([]), 5))).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe("makeDefaultGenome", () => {
  it("contains starter ops", () => {
    const g = makeDefaultGenome();
    expect(g[0]).toBe(OP.SENSE_DX);
    expect(g[g.length - 1]).toBe(OP.HALT);
    expect(Array.from(g)).toContain(OP.REPRODUCE);
  });
});
