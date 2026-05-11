// Genome unit tests live with the genome module. See vitest.config.ts for the
// include/exclude rules -- this file is part of the default `npm test` suite.
// Smoke / scenario tests use a separate naming convention (*.smoke.test.ts).

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

// ---------- helpers ----------

function makeSensors(overrides: Partial<{
  dx: number[]; dy: number[]; dist: number[];
}> = {}): VMSensors {
  return {
    dx: new Float32Array(overrides.dx ?? [0, 0, 0, 0, 0, 0]),
    dy: new Float32Array(overrides.dy ?? [0, 0, 0, 0, 0, 0]),
    dist: new Float32Array(overrides.dist ?? [0, 0, 0, 0, 0, 0]),
  };
}

function makeSelf(overrides: Partial<{
  energy: number; vx: number; vy: number; reserve: number[];
}> = {}): VMSelf {
  return {
    energy: overrides.energy ?? 100,
    vx: overrides.vx ?? 0,
    vy: overrides.vy ?? 0,
    reserve: new Float32Array(overrides.reserve ?? [0, 0, 0, 0, 0, 0]),
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

// Deterministic PRNG (mulberry32) for reproducible mutation tests.
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- stack ops ----------

describe("VM stack ops", () => {
  it("PUSH8 pushes positive byte as positive int", () => {
    const { state } = exec([OP.PUSH8, 42, OP.HALT]);
    expect(state.stack).toEqual([42]);
  });

  it("PUSH8 sign-extends bytes > 127", () => {
    const { state } = exec([OP.PUSH8, 200, OP.HALT]);
    expect(state.stack[0]).toBe(200 - 256); // -56
  });

  it("PUSH8 handles 0 and 127 as positive", () => {
    const { state } = exec([OP.PUSH8, 0, OP.PUSH8, 127, OP.HALT]);
    expect(state.stack).toEqual([0, 127]);
  });

  it("PUSH8 handles 128 as -128 (signed boundary)", () => {
    const { state } = exec([OP.PUSH8, 128, OP.HALT]);
    expect(state.stack).toEqual([-128]);
  });

  it("POP removes top of stack", () => {
    const { state } = exec([OP.PUSH8, 1, OP.PUSH8, 2, OP.POP, OP.HALT]);
    expect(state.stack).toEqual([1]);
  });

  it("POP on empty stack is a safe no-op", () => {
    const { state } = exec([OP.POP, OP.POP, OP.PUSH8, 5, OP.HALT]);
    expect(state.stack).toEqual([5]);
  });

  it("DUP duplicates top of stack", () => {
    const { state } = exec([OP.PUSH8, 7, OP.DUP, OP.HALT]);
    expect(state.stack).toEqual([7, 7]);
  });

  it("DUP on empty stack pushes two zeros", () => {
    const { state } = exec([OP.DUP, OP.HALT]);
    expect(state.stack).toEqual([0, 0]);
  });

  it("SWAP exchanges top two values", () => {
    const { state } = exec([OP.PUSH8, 1, OP.PUSH8, 2, OP.SWAP, OP.HALT]);
    expect(state.stack).toEqual([2, 1]);
  });

  it("stack capped at 32 elements (oldest dropped)", () => {
    const bytes: number[] = [];
    for (let i = 1; i <= 40; i++) bytes.push(OP.PUSH8, i);
    bytes.push(OP.HALT);
    const { state } = exec(bytes, { budget: 200 });
    expect(state.stack.length).toBe(32);
    // First 8 (values 1..8) dropped; stack should start at 9 and end at 40.
    expect(state.stack[0]).toBe(9);
    expect(state.stack[31]).toBe(40);
  });
});

// ---------- arithmetic ops ----------

describe("VM arithmetic", () => {
  it("ADD pops b,a and pushes a+b", () => {
    const { state } = exec([OP.PUSH8, 3, OP.PUSH8, 4, OP.ADD, OP.HALT]);
    expect(state.stack).toEqual([7]);
  });

  it("SUB computes a-b in stack order", () => {
    const { state } = exec([OP.PUSH8, 10, OP.PUSH8, 3, OP.SUB, OP.HALT]);
    expect(state.stack).toEqual([7]);
  });

  it("MUL multiplies", () => {
    const { state } = exec([OP.PUSH8, 6, OP.PUSH8, 7, OP.MUL, OP.HALT]);
    expect(state.stack).toEqual([42]);
  });

  it("DIV divides", () => {
    const { state } = exec([OP.PUSH8, 20, OP.PUSH8, 4, OP.DIV, OP.HALT]);
    expect(state.stack).toEqual([5]);
  });

  it("DIV by zero pushes 0 (no crash)", () => {
    const { state } = exec([OP.PUSH8, 20, OP.PUSH8, 0, OP.DIV, OP.HALT]);
    expect(state.stack).toEqual([0]);
  });

  it("NEG negates top", () => {
    const { state } = exec([OP.PUSH8, 7, OP.NEG, OP.HALT]);
    expect(state.stack).toEqual([-7]);
  });

  it("ABS absolutes top", () => {
    const { state } = exec([OP.PUSH8, 200, OP.ABS, OP.HALT]);
    expect(state.stack).toEqual([56]); // |-56| = 56
  });

  it("MIN picks smaller", () => {
    const { state } = exec([OP.PUSH8, 3, OP.PUSH8, 9, OP.MIN, OP.HALT]);
    expect(state.stack).toEqual([3]);
  });

  it("MAX picks larger", () => {
    const { state } = exec([OP.PUSH8, 3, OP.PUSH8, 9, OP.MAX, OP.HALT]);
    expect(state.stack).toEqual([9]);
  });

  it("arithmetic on empty stack treats missing operands as 0", () => {
    const { state } = exec([OP.ADD, OP.HALT]);
    expect(state.stack).toEqual([0]);
  });
});

// ---------- comparison ----------

describe("VM comparison", () => {
  it("LT: true case pushes 1", () => {
    const { state } = exec([OP.PUSH8, 3, OP.PUSH8, 5, OP.LT, OP.HALT]);
    expect(state.stack).toEqual([1]);
  });

  it("LT: false case pushes 0", () => {
    const { state } = exec([OP.PUSH8, 5, OP.PUSH8, 3, OP.LT, OP.HALT]);
    expect(state.stack).toEqual([0]);
  });

  it("LT: equal case pushes 0", () => {
    const { state } = exec([OP.PUSH8, 3, OP.PUSH8, 3, OP.LT, OP.HALT]);
    expect(state.stack).toEqual([0]);
  });

  it("GT: true / false / equal", () => {
    const a = exec([OP.PUSH8, 5, OP.PUSH8, 3, OP.GT, OP.HALT]);
    const b = exec([OP.PUSH8, 3, OP.PUSH8, 5, OP.GT, OP.HALT]);
    const c = exec([OP.PUSH8, 3, OP.PUSH8, 3, OP.GT, OP.HALT]);
    expect(a.state.stack).toEqual([1]);
    expect(b.state.stack).toEqual([0]);
    expect(c.state.stack).toEqual([0]);
  });

  it("EQ: true and false", () => {
    const a = exec([OP.PUSH8, 5, OP.PUSH8, 5, OP.EQ, OP.HALT]);
    const b = exec([OP.PUSH8, 5, OP.PUSH8, 3, OP.EQ, OP.HALT]);
    expect(a.state.stack).toEqual([1]);
    expect(b.state.stack).toEqual([0]);
  });
});

// ---------- control flow ----------

describe("VM control flow", () => {
  it("JMP +N skips forward over the next N bytes", () => {
    const { state } = exec([
      OP.PUSH8, 1,
      OP.JMP, 1,           // pc after operand at next opcode; +1 skips next 1 byte
      OP.NOP,              // skipped
      OP.PUSH8, 9,
      OP.HALT,
    ]);
    expect(state.stack).toEqual([1, 9]);
  });

  it("JMP -N goes backward (infinite loop bounded by budget)", () => {
    // PUSH8 1, JMP -4 -> loops back to PUSH8.
    const { state } = exec(
      [OP.PUSH8, 1, OP.JMP, 0xFC /* -4 */],
      { budget: 10 },
    );
    expect(state.stack.length).toBe(5);
    expect(state.stack.every((v) => v === 1)).toBe(true);
  });

  it("JZ taken when top is zero, not taken when nonzero", () => {
    const taken = exec([OP.PUSH8, 0, OP.JZ, 1, OP.NOP, OP.PUSH8, 9, OP.HALT]);
    const notTaken = exec([OP.PUSH8, 1, OP.JZ, 1, OP.NOP, OP.PUSH8, 9, OP.HALT]);
    expect(taken.state.stack).toEqual([9]);
    expect(notTaken.state.stack).toEqual([9]);
  });

  it("JNZ taken when top is nonzero, not taken when zero", () => {
    const taken = exec([OP.PUSH8, 1, OP.JNZ, 2, OP.PUSH8, 5, OP.PUSH8, 9, OP.HALT]);
    const notTaken = exec([OP.PUSH8, 0, OP.JNZ, 2, OP.PUSH8, 5, OP.PUSH8, 9, OP.HALT]);
    expect(taken.state.stack).toEqual([9]);
    expect(notTaken.state.stack).toEqual([5, 9]);
  });

  it("PC wraps to 0 when past end of genome", () => {
    const state = newVMState();
    exec([OP.PUSH8, 7], { state, budget: 6 });
    expect(state.stack.length).toBe(6);
    expect(state.stack.every((v) => v === 7)).toBe(true);
  });

  it("HALT yields immediately; PC advances past HALT byte", () => {
    const state = newVMState();
    const { out } = exec([OP.PUSH8, 1, OP.HALT, OP.PUSH8, 2], { state });
    expect(state.stack).toEqual([1]);
    expect(state.pc).toBe(3);
    expect(out.instructions).toBe(2);
  });

  it("budget caps instructions even without HALT", () => {
    const { out } = exec([OP.NOP, OP.NOP, OP.NOP], { budget: 5 });
    expect(out.instructions).toBe(5);
  });
});

// ---------- sensors ----------

describe("VM sensors", () => {
  it("SENSE_DX reads sensors.dx[operand % 6]", () => {
    const sensors = makeSensors({ dx: [10, 20, 30, 40, 50, 60] });
    const { state } = exec([OP.SENSE_DX, 3, OP.HALT], { sensors });
    expect(state.stack).toEqual([40]);
  });

  it("SENSE_DY reads sensors.dy[operand % 6]", () => {
    const sensors = makeSensors({ dy: [10, 20, 30, 40, 50, 60] });
    const { state } = exec([OP.SENSE_DY, 5, OP.HALT], { sensors });
    expect(state.stack).toEqual([60]);
  });

  it("SENSE_DIST reads sensors.dist[operand % 6]", () => {
    const sensors = makeSensors({ dist: [10, 20, 30, 40, 50, 60] });
    const { state } = exec([OP.SENSE_DIST, 2, OP.HALT], { sensors });
    expect(state.stack).toEqual([30]);
  });

  it("sensor operand >= 6 wraps via modulo", () => {
    const sensors = makeSensors({ dx: [11, 12, 13, 14, 15, 16] });
    const { state } = exec([OP.SENSE_DX, 8, OP.HALT], { sensors });
    expect(state.stack).toEqual([13]);
  });

  it("SELF_ENERGY pushes self.energy", () => {
    const self = makeSelf({ energy: 77 });
    const { state } = exec([OP.SELF_ENERGY, OP.HALT], { self });
    expect(state.stack).toEqual([77]);
  });

  it("SELF_RESERVE reads self.reserve[operand % 6]", () => {
    const self = makeSelf({ reserve: [1, 2, 3, 4, 5, 6] });
    const { state } = exec([OP.SELF_RESERVE, 4, OP.HALT], { self });
    expect(state.stack).toEqual([5]);
  });

  it("SELF_VX / SELF_VY push self velocity", () => {
    const self = makeSelf({ vx: 11, vy: -7 });
    const { state } = exec([OP.SELF_VX, OP.SELF_VY, OP.HALT], { self });
    expect(state.stack).toEqual([11, -7]);
  });
});

// ---------- actuators ----------

describe("VM actuators", () => {
  it("THRUST pops ay,ax and accumulates into outputs", () => {
    const { out } = exec([
      OP.PUSH8, 30,
      OP.PUSH8, 40,
      OP.THRUST,
      OP.HALT,
    ]);
    expect(out.thrustX).toBe(30);
    expect(out.thrustY).toBe(40);
  });

  it("multiple THRUST calls accumulate", () => {
    const { out } = exec([
      OP.PUSH8, 10, OP.PUSH8, 20, OP.THRUST,
      OP.PUSH8, 5,  OP.PUSH8, 7,  OP.THRUST,
      OP.HALT,
    ]);
    expect(out.thrustX).toBe(15);
    expect(out.thrustY).toBe(27);
  });

  it("EXCRETE pops amount and accumulates per material idx", () => {
    const { out } = exec([
      OP.PUSH8, 25,
      OP.EXCRETE, 3,         // organic
      OP.HALT,
    ]);
    expect(Array.from(out.excrete)).toEqual([0, 0, 0, 25, 0, 0]);
  });

  it("EXCRETE clamps negative amounts to 0", () => {
    const { out } = exec([
      OP.PUSH8, 200,         // -56 signed
      OP.EXCRETE, 0,
      OP.HALT,
    ]);
    expect(Array.from(out.excrete)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("EXCRETE operand wraps via modulo", () => {
    const { out } = exec([
      OP.PUSH8, 10,
      OP.EXCRETE, 7,         // 7 % 6 = 1 (sand)
      OP.HALT,
    ]);
    expect(Array.from(out.excrete)).toEqual([0, 10, 0, 0, 0, 0]);
  });

  it("REPRODUCE sets the reproduce flag", () => {
    const { out } = exec([OP.REPRODUCE, OP.HALT]);
    expect(out.reproduce).toBe(true);
  });

  it("output is reset between runTick calls", () => {
    const state = newVMState();
    const out = newOutputs();
    runTick(
      new Uint8Array([OP.REPRODUCE, OP.HALT]),
      state,
      makeSensors(),
      makeSelf(),
      32,
      out,
    );
    expect(out.reproduce).toBe(true);
    runTick(
      new Uint8Array([OP.NOP, OP.HALT]),
      newVMState(),
      makeSensors(),
      makeSelf(),
      32,
      out,
    );
    expect(out.reproduce).toBe(false);
    expect(out.thrustX).toBe(0);
    expect(out.thrustY).toBe(0);
    expect(Array.from(out.excrete)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

// ---------- robustness / edge cases ----------

describe("VM edge cases", () => {
  it("empty genome runs no instructions, no crash", () => {
    const { out, state } = exec([]);
    expect(out.instructions).toBe(0);
    expect(state.pc).toBe(0);
    expect(state.stack).toEqual([]);
  });

  it("unknown opcodes act as NOP", () => {
    const { state, out } = exec([0x7F /* unassigned */, OP.PUSH8, 9, OP.HALT]);
    expect(state.stack).toEqual([9]);
    expect(out.instructions).toBe(3);
  });

  it("state persists across ticks (pc + stack)", () => {
    const genome = new Uint8Array([OP.PUSH8, 7, OP.HALT]);
    const state = newVMState();
    const out = newOutputs();
    runTick(genome, state, makeSensors(), makeSelf(), 32, out);
    expect(state.stack).toEqual([7]);
    // Next tick: PC has wrapped to 0, will push another 7.
    runTick(genome, state, makeSensors(), makeSelf(), 32, out);
    expect(state.stack).toEqual([7, 7]);
  });

  it("operand-only-byte at end of genome wraps (no crash)", () => {
    const { state, out } = exec([OP.PUSH8], { budget: 1 });
    expect(out.instructions).toBe(1);
    expect(state.stack).toEqual([OP.PUSH8]);
  });

  it("negative jumps that go past start get re-normalized", () => {
    const { out } = exec([OP.JMP, 0xF6 /* -10 */], { budget: 5 });
    expect(out.instructions).toBe(5);
  });
});

// ---------- disassembler ----------

describe("disassemble", () => {
  it("renders known opcodes by name (lowercase)", () => {
    const text = disassemble(new Uint8Array([OP.NOP, OP.HALT]));
    expect(text).toContain("nop");
    expect(text).toContain("halt");
  });

  it("renders PUSH8 with signed integer operand", () => {
    const text = disassemble(new Uint8Array([OP.PUSH8, 200, OP.HALT]));
    expect(text).toContain("push8 -56");
  });

  it("renders JMP/JZ/JNZ with signed operand", () => {
    const text = disassemble(new Uint8Array([
      OP.JMP, 5,
      OP.JZ, 0xFE,   // -2
      OP.JNZ, 0,
    ]));
    expect(text).toContain("jmp 5");
    expect(text).toContain("jz -2");
    expect(text).toContain("jnz 0");
  });

  it("renders material operand by name when provided", () => {
    const names = ["rock", "sand", "clay", "organic", "lipid", "gas"];
    const text = disassemble(new Uint8Array([
      OP.SENSE_DX, 3,
      OP.EXCRETE, 7,         // wraps to 1 = sand
      OP.HALT,
    ]), names);
    expect(text).toContain("sense_dx organic");
    expect(text).toContain("excrete sand");
  });

  it("renders material operand by index when names omitted", () => {
    const text = disassemble(new Uint8Array([OP.SENSE_DX, 2, OP.HALT]));
    expect(text).toContain("sense_dx 2");
  });

  it("renders unknown bytes as db 0xNN", () => {
    const text = disassemble(new Uint8Array([0x7A]));
    expect(text).toContain("db 0x7a");
  });

  it("addresses each instruction with 4-digit hex offset", () => {
    const text = disassemble(new Uint8Array([OP.NOP, OP.PUSH8, 1, OP.HALT]));
    const lines = text.split("\n");
    expect(lines[0].startsWith("0000:")).toBe(true);
    expect(lines[1].startsWith("0001:")).toBe(true);
    expect(lines[2].startsWith("0003:")).toBe(true);
  });
});

// ---------- mutation ----------

describe("mutateGenome", () => {
  it("with rng always returning 1 (never trigger), produces identical copy", () => {
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const out = mutateGenome(input, () => 1);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns default genome when mutation produces empty output", () => {
    // First rng call (delete check on the only byte): 0 -> deletes.
    // Second rng call (trailing-insert check): 1 -> no insert.
    // Result: empty -> mutator falls back to default genome.
    const input = new Uint8Array([7]);
    let call = 0;
    const rng = (): number => {
      call++;
      return call === 1 ? 0 : 1;
    };
    const out = mutateGenome(input, rng);
    expect(Array.from(out)).toEqual(Array.from(makeDefaultGenome()));
  });

  it("with rng always 0, deletes everything but trailing-insert keeps it nonempty", () => {
    // Documents the actual behavior under degenerate rng=0: every byte
    // deleted, then a single trailing insert of Math.floor(0 * 256) = 0.
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const out = mutateGenome(input, () => 0);
    expect(out.length).toBe(1);
    expect(out[0]).toBe(0);
  });

  it("with seeded PRNG produces deterministic output", () => {
    const input = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const a = mutateGenome(input, mulberry32(42));
    const b = mutateGenome(input, mulberry32(42));
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("different seeds produce different outputs (probabilistic)", () => {
    const input = new Uint8Array(64).fill(0xAA);
    const a = mutateGenome(input, mulberry32(1));
    const b = mutateGenome(input, mulberry32(2));
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("output stays at or below MAX_GENOME_BYTES (256)", () => {
    const input = new Uint8Array(250).fill(0);
    const out = mutateGenome(input, () => 0.001);
    expect(out.length).toBeLessThanOrEqual(256);
  });

  it("preserves bytes that don't mutate (mid-probability rng)", () => {
    // rng=0.5 is above all thresholds (P_POINT=0.02, P_INSERT=0.005, P_DELETE=0.005).
    const input = new Uint8Array([9, 8, 7, 6, 5]);
    const out = mutateGenome(input, () => 0.5);
    expect(Array.from(out)).toEqual([9, 8, 7, 6, 5]);
  });
});

// ---------- genome cost ----------

describe("genomeMaterialCost", () => {
  it("distributes cost by (byte % 6) across materials", () => {
    const genome = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const cost = genomeMaterialCost(genome, 1);
    expect(Array.from(cost)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("scales by massPerByte parameter", () => {
    const genome = new Uint8Array([3, 3, 3]);
    const cost = genomeMaterialCost(genome, 4);
    expect(Array.from(cost)).toEqual([0, 0, 0, 12, 0, 0]);
  });

  it("aggregates duplicates", () => {
    const genome = new Uint8Array([0, 6, 12]); // all mod 6 = 0
    const cost = genomeMaterialCost(genome, 1);
    expect(Array.from(cost)).toEqual([3, 0, 0, 0, 0, 0]);
  });

  it("empty genome has zero cost everywhere", () => {
    const cost = genomeMaterialCost(new Uint8Array([]), 5);
    expect(Array.from(cost)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("sum equals length * massPerByte", () => {
    const genome = new Uint8Array(50).map((_, i) => (i * 37 + 11) & 0xFF);
    const cost = genomeMaterialCost(genome, 3);
    const total = Array.from(cost).reduce((a, b) => a + b, 0);
    expect(total).toBe(50 * 3);
  });
});

// ---------- default genome ----------

describe("makeDefaultGenome", () => {
  it("returns a fresh array each call (no shared mutation)", () => {
    const a = makeDefaultGenome();
    const b = makeDefaultGenome();
    a[0] = 0;
    expect(b[0]).not.toBe(0);
  });

  it("contains the expected starter behavior bytes", () => {
    const g = makeDefaultGenome();
    // SENSE_DX organic, SENSE_DY organic, THRUST, ..., REPRODUCE, HALT
    expect(g[0]).toBe(OP.SENSE_DX);
    expect(g[1]).toBe(3);
    expect(g[g.length - 1]).toBe(OP.HALT);
    expect(Array.from(g)).toContain(OP.THRUST);
    expect(Array.from(g)).toContain(OP.REPRODUCE);
  });
});
