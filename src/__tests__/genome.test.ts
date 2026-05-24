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
  OPERANDS,
  walkGenome,
  genomeSynthMask,
  viableGenome,
  SYNTH_KIND,
  SYNTH_KIND_COUNT,
  CATALYST_COUNT,
  SYNTH_BIT_BOND,
  SYNTH_BIT_COMPETENCE,
  SYNTH_BIT_PACKAGE,
  GENE_FRAGMENT_CAP,
  appendGenomeBytes,
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
  return {
    chemConc: cc,
    gradient: (_id, out) => { out[0] = 0; out[1] = 0; },
  };
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
  // Gene framing: the VM only executes bytes inside a GENE..END span,
  // so wrap the raw op sequence in one gene. Entering the gene costs
  // exactly one budget step (the scan lands on GENE at pc 0), so add 1
  // to whatever budget the test intended for its ops.
  const framed = [OP.GENE, ...bytes, OP.END];
  const budget = (opts.budget ?? budgetToHalt(bytes)) + 1;
  const out = newOutputs();
  runTick(new Uint8Array(framed), state, sensors, self, budget, out);
  return { out, state };
}

// Wrap a raw op sequence in one gene (GENE..END) -- the only bytes the
// VM / static decoders treat as expressed. Used directly by tests that
// call runTick or the static analyzers without going through exec().
function framed(bytes: number[]): Uint8Array {
  return new Uint8Array([OP.GENE, ...bytes, OP.END]);
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
  it("PC wraps past end of gene and re-enters, clearing the stack", () => {
    // With per-gene isolation the stack is cleared each time the
    // scanner re-enters the GENE on wrap, so it can't accumulate
    // across cycles -- it never grows past one push.
    const state = newVMState();
    const { state: s } = exec([OP.PUSH8, 7], { state, budget: 6 });
    expect(s.stack.length).toBeLessThanOrEqual(1);
  });
  it("HALT byte (0xFF) is now a NOP -- VM keeps executing past it", () => {
    // The 0xFF byte decodes to the default NOP branch, so both PUSH8s
    // run. exec adds 1 budget for the GENE-entry step, so 3 ops budget
    // -> 4 counted instructions (GENE + PUSH8 + NOP + PUSH8).
    const state = newVMState();
    const { out } = exec([OP.PUSH8, 1, HALT_MARK, OP.PUSH8, 2], { state, budget: 3 });
    expect(state.stack).toEqual([1, 2]);
    expect(out.instructions).toBe(4);
  });
  it("budget caps even without HALT", () => {
    // exec adds 1 for the GENE-entry step, so budget 5 -> 6 counted.
    expect(exec([OP.NOP, OP.NOP, OP.NOP], { budget: 5 }).out.instructions).toBe(6);
  });
});

describe("VM scratch registers (LOAD / STORE)", () => {
  it("STORE pops, LOAD pushes from the same register", () => {
    expect(exec([OP.PUSH8, 42, OP.STORE, 7, OP.LOAD, 7, HALT_MARK]).state.stack).toEqual([42]);
  });
  it("registers persist across runTick calls", () => {
    const state = newVMState();
    const out = newOutputs();
    // Explicit budget = ops + 1 for the GENE-entry step.
    runTick(framed([OP.PUSH8, 99, OP.STORE, 3]), state, makeSensors(), makeSelf(), 3, out);
    // Reset stack + pc + framing mode to simulate a fresh tick; regs
    // deliberately persist across ticks.
    state.stack.length = 0; state.pc = 0; state.executing = false;
    runTick(framed([OP.LOAD, 3]), state, makeSensors(), makeSelf(), 2, out);
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
    expect(exec([OP.SENSE_CHEMICAL, 5, HALT_MARK], { sensors: { chemConc: cc, gradient: (_i,o)=>{o[0]=0;o[1]=0;} } }).state.stack).toEqual([42]);
  });
  it("SENSE_CHEMICAL operand wraps mod CHEMICAL_COUNT (96)", () => {
    // K-5: every external reading hits SENSE_CHEMICAL. Activated chems
    // live around id 23 (chemo biopolymer X); a genome that wants
    // "gradient toward food" reads that id directly.
    const cc = new Float32Array(96);
    cc[23] = 9.5;
    // 23 + 96 = 119; mod 96 = 23, so the read still lands at slot 23.
    expect(exec([OP.SENSE_CHEMICAL, 119, HALT_MARK], { sensors: { chemConc: cc, gradient: (_i,o)=>{o[0]=0;o[1]=0;} } }).state.stack).toEqual([9.5]);
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
  it("INGEST pops a bond-energy threshold off the stack", () => {
    const out = exec([OP.PUSH8, 50, OP.INGEST, HALT_MARK]).out;
    expect(out.ingestThreshold).toBeCloseTo(50 * 0.02, 6); // INGEST_TH_SCALE
  });
  it("INGEST takes the most permissive (lowest) threshold", () => {
    const out = exec([
      OP.PUSH8, 50, OP.INGEST, OP.PUSH8, 10, OP.INGEST, HALT_MARK,
    ]).out;
    expect(out.ingestThreshold).toBeCloseTo(10 * 0.02, 6);
  });
  it("INGEST threshold is Infinity (ingest nothing) without the op", () => {
    const out = exec([OP.NOP, HALT_MARK]).out;
    expect(out.ingestThreshold).toBe(Infinity);
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
    runTick(framed([OP.REPRODUCE, HALT_MARK]), state, makeSensors(), makeSelf(), 32, out);
    expect(out.reproduce).toBe(true);
    runTick(framed([OP.NOP, HALT_MARK]), newVMState(), makeSensors(), makeSelf(), 32, out);
    expect(out.reproduce).toBe(false);
    expect(out.thrustX).toBe(0);
    expect(out.thrustY).toBe(0);
    expect(out.turn).toBe(0);
    expect(out.ingestThreshold).toBe(Infinity);
    // Excrete array sized to CHEMICAL_COUNT (96) post-cleanup; check
    // it's all-zero rather than spelling out 96 entries.
    let total = 0;
    for (let i = 0; i < out.excrete.length; i++) total += out.excrete[i];
    expect(total).toBe(0);
  });
});

describe("VM edge cases", () => {
  it("empty genome runs nothing", () => {
    // A truly empty genome (no GENE codon, length 0) -- the VM returns
    // immediately. Tested directly since exec() would frame it.
    const state = newVMState();
    const out = newOutputs();
    runTick(new Uint8Array([]), state, makeSensors(), makeSelf(), 5, out);
    expect(out.instructions).toBe(0);
    expect(state.pc).toBe(0);
    expect(state.stack).toEqual([]);
  });
  it("unknown opcodes act as NOP", () => {
    // budget covers the noop byte + the PUSH8; exec adds 1 for GENE.
    const { state, out } = exec([0x7F, OP.PUSH8, 9], { budget: 2 });
    expect(state.stack).toEqual([9]);
    expect(out.instructions).toBe(3);
  });
  it("stack state persists across ticks within a gene", () => {
    // Two PUSH8 7 in one gene, budget 2/tick. Tick 1 spends a step
    // entering the GENE then runs the first PUSH8 (stack [7]); tick 2
    // resumes mid-gene and runs the second PUSH8 (stack [7,7]). The
    // stack carries across ticks because the gene is NOT re-entered (a
    // GENE re-entry would clear it -- per-gene isolation).
    const genome = framed([OP.PUSH8, 7, OP.PUSH8, 7]);
    const state = newVMState();
    const out = newOutputs();
    runTick(genome, state, makeSensors(), makeSelf(), 2, out);
    expect(state.stack).toEqual([7]);
    runTick(genome, state, makeSensors(), makeSelf(), 2, out);
    expect(state.stack).toEqual([7, 7]);
  });
  it("a PUSH8 at the end of a gene reads the following byte as operand", () => {
    // PUSH8 is the last op before END; operand reads don't respect gene
    // boundaries, so it takes the END codon byte (0x6B) as its operand.
    const { state } = exec([OP.PUSH8], { budget: 1 });
    expect(state.stack).toEqual([OP.END]);
  });
  it("negative jumps past start renormalize", () => {
    // exec adds 1 for the GENE-entry step, so budget 5 -> 6 counted.
    expect(exec([OP.JMP, 0xF6], { budget: 5 }).out.instructions).toBe(6);
  });
});

describe("disassemble", () => {
  it("renders known opcodes by lowercase name (inside a gene)", () => {
    const text = disassemble(framed([OP.NOP, OP.REPRODUCE]));
    expect(text).toContain("nop");
    expect(text).toContain("reproduce");
    // gene framing codons are rendered as flush markers
    expect(text).toContain("gene");
    expect(text).toContain("end");
  });
  it("renders SYNTH with kind name + param", () => {
    expect(disassemble(framed([OP.SYNTH, SYNTH_KIND.CAT, 7]))).toContain("synth cat 7");
    expect(disassemble(framed([OP.SYNTH, SYNTH_KIND.BOND, 200]))).toContain("synth bond 200");
  });
  it("flags intron bytes with an ; intron marker outside any gene", () => {
    // No GENE codon -> every byte is an intron, shown byte-by-byte with
    // an ; intron marker (op mnemonic if known, else db 0xNN).
    const text = disassemble(new Uint8Array([OP.NOP, OP.REPRODUCE]));
    expect(text).toContain("; intron");
    // reproduce appears, but flagged as non-coding (not an executed op)
    expect(text).toMatch(/reproduce\s+; intron/);
  });
  it("renders PUSH8 with signed operand", () => {
    expect(disassemble(framed([OP.PUSH8, 200, HALT_MARK]))).toContain("push8 -56");
  });
  it("renders JMP/JZ/JNZ signed operands", () => {
    const text = disassemble(framed([OP.JMP, 5, OP.JZ, 0xFE, OP.JNZ, 0]));
    expect(text).toContain("jmp 5");
    expect(text).toContain("jz -2");
    expect(text).toContain("jnz 0");
  });
  it("renders material operand by name when provided", () => {
    const names = ["rock", "sand", "clay", "organic", "lipid", "gas"];
    // EXCRETE still passes through the material-operand naming map.
    // With operand 7 mod 6 = 1, the name is "sand".
    const text = disassemble(framed([OP.EXCRETE, 7, HALT_MARK]), names);
    expect(text).toContain("excrete sand");
  });
  it("renders material operand by index without names", () => {
    expect(disassemble(framed([OP.EXCRETE, 2, HALT_MARK]))).toContain("excrete 2");
  });
  it("renders unknown bytes as db 0xNN", () => {
    // A defined-but-unaligned byte inside a gene falls to the db branch.
    expect(disassemble(framed([0x7A]))).toContain("db 0x7a");
  });
  it("4-digit hex offsets per instruction, skipping operands", () => {
    // framed: [GENE, NOP, PUSH8, 1, 0xFF, END]
    const lines = disassemble(framed([OP.NOP, OP.PUSH8, 1, HALT_MARK])).split("\n");
    expect(lines[0].startsWith("0000:")).toBe(true); // gene
    expect(lines[1].startsWith("0001:")).toBe(true); // nop
    expect(lines[2].startsWith("0002:")).toBe(true); // push8 (1-byte operand)
    expect(lines[3].startsWith("0004:")).toBe(true); // 0xff -- operand at 0003 skipped
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

// Characterization tests: a fixed, hand-built byte sequence must
// decode to a known, specific effect. Real genomes have surrounding
// junk that changes alignment/control-flow; these pin only the
// well-aligned base contract so the decoders can't silently regress.
describe("genome decoding: known byte sequences", () => {
  // The SYNTH op is 3 bytes: [SYNTH, kindByte, paramByte]. The live
  // VM is the source of truth for what a cell actually expresses.
  // After Phase 4a the only kinds with runtime effect are CAT, INH,
  // BOND, COMPETENCE, PACKAGE.
  describe("dynamic VM (runTick) -- the executed contract", () => {
    it("[SYNTH, CAT, 3] marks slot 3 expressed in catSynthMask (photosynth slot)", () => {
      const { out } = exec([OP.SYNTH, SYNTH_KIND.CAT, 3]);
      expect(out.catSynthMask[3]).toBeTruthy();
      expect(out.inhSynthMask.some((v) => v !== 0)).toBe(false);
    });
    it("[SYNTH, INH, 4] marks slot 4 expressed in inhSynthMask (synth_aa slot)", () => {
      const { out } = exec([OP.SYNTH, SYNTH_KIND.INH, 4]);
      expect(out.inhSynthMask[4]).toBeTruthy();
      expect(out.catSynthMask.some((v) => v !== 0)).toBe(false);
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
      expect(exec([OP.SYNTH, SYNTH_KIND.CAT, 0]).out.bondMarker).toBe(-1);
    });
    it("[SYNTH, COMPETENCE, 0] sets the COMPETENCE bit", () => {
      const { out } = exec([OP.SYNTH, SYNTH_KIND.COMPETENCE, 0]);
      expect(out.synthMask & (1 << SYNTH_BIT_COMPETENCE)).toBeTruthy();
    });
    it("[SYNTH, PACKAGE, 0] sets the PACKAGE bit", () => {
      const { out } = exec([OP.SYNTH, SYNTH_KIND.PACKAGE, 0]);
      expect(out.synthMask & (1 << SYNTH_BIT_PACKAGE)).toBeTruthy();
    });
    it("kindByte is taken mod SYNTH_KIND_COUNT (wraps)", () => {
      // SYNTH_KIND_COUNT + BOND == BOND after the mod, still bond.
      const { out } = exec([OP.SYNTH, SYNTH_KIND_COUNT + SYNTH_KIND.BOND, 99]);
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
      // Static decoders (genomeSynthMask/summarizeGenome) read this
      // to learn what a SYNTH op does. SYNTH has two operand bytes;
      // the first is the kind.
      let kindByte: number | undefined = -999;
      walkGenome(new Uint8Array([OP.SYNTH, SYNTH_KIND.BOND, 7]),
        (op, _pc, operand) => { if (op === OP.SYNTH) kindByte = operand; });
      expect(kindByte).toBe(SYNTH_KIND.BOND);
    });
  });

  // genomeSynthMask: static "what could this genome do via SYNTH" used
  // for engulfed cells whose VM doesn't run. Only carries BOND /
  // COMPETENCE / PACKAGE (the non-CAT/INH kinds with a runtime
  // effect); CAT and INH go through their own parallel masks.
  describe("genomeSynthMask static synth intent", () => {
    it("[SYNTH BOND][SYNTH PACKAGE] -> BOND and PACKAGE bits set", () => {
      const g = framed([
        OP.SYNTH, SYNTH_KIND.BOND, 0,
        OP.SYNTH, SYNTH_KIND.PACKAGE, 0,
      ]);
      const m = genomeSynthMask(g);
      expect(m & (1 << SYNTH_BIT_BOND)).toBeTruthy();
      expect(m & (1 << SYNTH_BIT_PACKAGE)).toBeTruthy();
    });
    it("a SYNTH BOND op is detectable in the static mask", () => {
      const g = framed([OP.SYNTH, SYNTH_KIND.BOND, 123]);
      expect(genomeSynthMask(g) & (1 << SYNTH_BIT_BOND)).toBeTruthy();
    });
    it("a SYNTH BOND op buried in an INTRON is NOT expressed", () => {
      // Outside any GENE..END span the op never executes, so the static
      // mask must ignore it -- the whole point of framing.
      const g = new Uint8Array([OP.SYNTH, SYNTH_KIND.BOND, 123]);
      expect(genomeSynthMask(g) & (1 << SYNTH_BIT_BOND)).toBeFalsy();
    });
    it("no SYNTH ops -> empty mask", () => {
      expect(genomeSynthMask(new Uint8Array([OP.THRUST, OP.REPRODUCE]))).toBe(0);
    });
    it("SYNTH CAT / INH are NOT in the synthMask (use parallel masks)", () => {
      const g = new Uint8Array([
        OP.SYNTH, SYNTH_KIND.CAT, 3,
        OP.SYNTH, SYNTH_KIND.INH, 4,
      ]);
      expect(genomeSynthMask(g)).toBe(0);
    });
    it("matches the VM's bit for the same well-aligned op", () => {
      const bytes = [OP.SYNTH, SYNTH_KIND.BOND, 0];
      const dyn = exec(bytes).out.synthMask;
      const stat = genomeSynthMask(framed(bytes));
      expect(stat & (1 << SYNTH_BIT_BOND)).toBe(dyn & (1 << SYNTH_BIT_BOND));
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
    it("FOUNDER_GENE_REFS mirror the canonical chem/slot constants", async () => {
      const { FOUNDER_GENE_REFS: F } = await import("../genome");
      const c = await import("../sim/chem-ids");
      const r = await import("../sim/reactions");
      expect(F.CO2).toBe(c.CHEM_CO2);
      expect(F.GLU).toBe(c.CHEM_GLU);
      expect(F.FA).toBe(c.CHEM_FA);
      expect(F.MIN).toBe(c.CHEM_MIN);
      expect(F.WASTE).toBe(c.CHEM_WASTE);
      expect(F.MRNA).toBe(c.CHEM_MRNA);
      expect(F.BIOPOLYMER).toBe(c.CHEM_BIOPOLYMER);
      expect(F.ACT_THERMO).toBe(c.CHEM_ACT_THERMO);
      expect(F.MARKER0).toBe(c.CHEM_MARKER0);
      expect(F.ACT_PHOTO_V).toBe(c.CHEM_ACT_PHOTO_VISIBLE);
      expect(F.ACT_MECH_X).toBe(c.CHEM_ACT_MECH_X);
      expect(F.ACT_MECH_Y).toBe(c.CHEM_ACT_MECH_Y);
      expect(F.ACT_MAG_X).toBe(c.CHEM_ACT_MAG_X);
      expect(F.ACT_MAG_Y).toBe(c.CHEM_ACT_MAG_Y);
      expect(F.ACT_PH).toBe(c.CHEM_ACT_PH);
      expect(F.ACT_ELECTRO_X).toBe(c.CHEM_ACT_ELECTRO_X);
      expect(F.ACT_ELECTRO_Y).toBe(c.CHEM_ACT_ELECTRO_Y);
      expect(F.SYNTH_PHOTO_V).toBe(r.RX_SLOT_SYNTH_PHOTO_V);
      expect(F.SYNTH_ELECTRO).toBe(r.RX_SLOT_SYNTH_ELECTRO);
      expect(F.SYNTH_PHRECEPTOR).toBe(r.RX_SLOT_SYNTH_PHRECEPTOR);
      expect(F.SYNTH_MECH).toBe(r.RX_SLOT_SYNTH_MECH);
      expect(F.SYNTH_MAGNETO).toBe(r.RX_SLOT_SYNTH_MAGNETO);
      expect(F.PHOTOSYNTH).toBe(r.RX_SLOT_PHOTOSYNTH);
      expect(F.SYNTH_AA).toBe(r.RX_SLOT_SYNTH_AA);
      expect(F.SYNTH_FA).toBe(r.RX_SLOT_SYNTH_FA);
      expect(F.SYNTH_CHL).toBe(r.RX_SLOT_SYNTH_CHL);
      expect(F.SYNTH_ENZ).toBe(r.RX_SLOT_SYNTH_ENZ);
      expect(F.SYNTH_MEM).toBe(r.RX_SLOT_SYNTH_MEM_AAFA);
      expect(F.DIGEST_BIOP).toBe(r.RX_SLOT_DIGEST_BIOP);
      expect(F.SYNTH_THERMO).toBe(r.RX_SLOT_SYNTH_THERMO);
      expect(F.SYNTH_REPAIR).toBe(r.RX_SLOT_SYNTH_REPAIR);
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
    // Frame the op sequence (the VM only executes inside a gene) and
    // add 1 budget for the GENE-entry step. The returned genome
    // therefore has GENE at index 0 and END last -- self-modifying ops
    // index into THAT framed layout.
    function run(bytes: number[], budget: number): Uint8Array {
      const g = framed(bytes);
      runTick(g, newVMState(), { chemConc: new Float32Array(96), gradient: (_i,o)=>{o[0]=0;o[1]=0;} },
        { energy: 100, mass: 0, membrane: 0 }, budget + 1, newOutputs());
      return g;
    }
    it("POKE_BYTE writes value to genome[idx] in place (pops idx then val)", () => {
      // stack order: push val, push idx; POKE pops idx (top) then val.
      // Writes 42 into genome[0] (the GENE codon slot in the framed
      // layout) -- self-modification can overwrite framing too.
      const g = run([OP.PUSH8, 42, OP.PUSH8, 0, OP.POKE_BYTE], 3);
      expect(g[0]).toBe(42);
    });
    it("POKE_BYTE masks value to 8 bits and wraps idx mod length", () => {
      // framed: [GENE, NOP, PUSH8, 9, PUSH8, 100, POKE, END], length 8.
      // idx 100 mod 8 = 4 (the second PUSH8 opcode byte), overwritten
      // with value 9.
      const g = run([OP.NOP, OP.PUSH8, 9, OP.PUSH8, 100, OP.POKE_BYTE], 4);
      expect(g.length).toBe(8);
      expect(g[4]).toBe(9);
    });
    it("SPLICE_DUP requests a duplicate (mode 1), length capped at 32", () => {
      const out = newOutputs();
      // push offset(2) then length(100); SPLICE pops length then offset.
      runTick(framed([OP.PUSH8, 2, OP.PUSH8, 100, OP.SPLICE_DUP]),
        newVMState(), { chemConc: new Float32Array(96), gradient: (_i,o)=>{o[0]=0;o[1]=0;} },
        { energy: 100, mass: 0, membrane: 0 }, 4, out);
      expect(out.spliceMode).toBe(1);
      expect(out.spliceLength).toBe(32);
      // framed genome length is 7; offset 2 mod 7 = 2.
      expect(out.spliceOffset).toBe(2 % 7);
    });
    it("SPLICE_DEL requests a deletion (mode 2)", () => {
      const out = newOutputs();
      runTick(framed([OP.PUSH8, 1, OP.PUSH8, 3, OP.SPLICE_DEL]),
        newVMState(), { chemConc: new Float32Array(96), gradient: (_i,o)=>{o[0]=0;o[1]=0;} },
        { energy: 100, mass: 0, membrane: 0 }, 4, out);
      expect(out.spliceMode).toBe(2);
      expect(out.spliceLength).toBe(3);
    });
  });

  describe("SYNTH: every live kind sets its documented bit", () => {
    // synthMask-bit-setting kinds (the ones with a runtime effect that
    // ISN'T CAT/INH -- those go to their own parallel masks).
    const bitOf: Array<[number, number]> = [
      [SYNTH_KIND.BOND, SYNTH_BIT_BOND],
      [SYNTH_KIND.COMPETENCE, SYNTH_BIT_COMPETENCE],
      [SYNTH_KIND.PACKAGE, SYNTH_BIT_PACKAGE],
    ];
    for (const [kind, bit] of bitOf) {
      it(`kind ${kind} -> synthMask bit ${bit}`, () => {
        expect(exec([OP.SYNTH, kind, 0, HALT_MARK]).out.synthMask).toBe(1 << bit);
      });
    }
    it("CAT routes to catSynthMask, not synthMask (param = slot)", () => {
      const { out } = exec([OP.SYNTH, SYNTH_KIND.CAT, 3, HALT_MARK]);
      expect(out.synthMask).toBe(0);
      expect(out.catSynthMask[3 % CATALYST_COUNT]).toBe(1);
      expect(out.catSynthMask.reduce((s, v) => s + v, 0)).toBe(1);
    });
    it("INH routes to inhSynthMask (param = slot), parallel to CAT", () => {
      const { out } = exec([OP.SYNTH, SYNTH_KIND.INH, 7, HALT_MARK]);
      expect(out.synthMask).toBe(0);
      expect(out.catSynthMask.some((v) => v !== 0)).toBe(false);
      expect(out.inhSynthMask[7 % CATALYST_COUNT]).toBe(1);
      expect(out.inhSynthMask.reduce((s, v) => s + v, 0)).toBe(1);
    });
    it("kindByte wraps mod SYNTH_KIND_COUNT", () => {
      expect(exec([OP.SYNTH, SYNTH_KIND_COUNT + SYNTH_KIND.BOND, 0, HALT_MARK]).out.synthMask)
        .toBe(1 << SYNTH_BIT_BOND);
    });
    // Regression: catSynthMask / inhSynthMask used to be packed JS
    // bitmasks. CATALYST_COUNT is 256 but JS bitwise ops are 32-bit,
    // so 1 << 37 silently aliased to 1 << 5. SYNTH CAT 37 and SYNTH
    // CAT 5 set the same bit, and the consumer loop fired phantom
    // biosyntheses for every slot that shared its low 5 bits with an
    // expressed slot. The mask is now Uint8Array(CATALYST_COUNT); each
    // slot is independent. These tests would have caught the original
    // bug because they exercise high-slot params and assert per-slot
    // independence, which the bitmask form can't satisfy.
    it("SYNTH CAT 37 marks slot 37, NOT slot 5 (high-slot params do not alias low ones)", () => {
      const { out } = exec([OP.SYNTH, SYNTH_KIND.CAT, 37, HALT_MARK]);
      expect(out.catSynthMask[37]).toBe(1);
      expect(out.catSynthMask[5]).toBe(0);
      expect(out.catSynthMask.reduce((s, v) => s + v, 0)).toBe(1);
    });
    it("SYNTH CAT 5 and SYNTH CAT 37 mark two distinct slots, not one shared one", () => {
      // Two SYNTH ops back-to-back; the second comes after the kind byte
      // padding so the VM's PC actually lands on its op.
      const { out } = exec([
        OP.SYNTH, SYNTH_KIND.CAT, 5,
        OP.SYNTH, SYNTH_KIND.CAT, 37,
        HALT_MARK,
      ]);
      expect(out.catSynthMask[5]).toBe(1);
      expect(out.catSynthMask[37]).toBe(1);
      expect(out.catSynthMask.reduce((s, v) => s + v, 0)).toBe(2);
    });
    it("SYNTH INH 64 marks slot 64, NOT slot 0 (same independence rule for inhibitor)", () => {
      const { out } = exec([OP.SYNTH, SYNTH_KIND.INH, 64, HALT_MARK]);
      expect(out.inhSynthMask[64]).toBe(1);
      expect(out.inhSynthMask[0]).toBe(0);
      expect(out.inhSynthMask.reduce((s, v) => s + v, 0)).toBe(1);
    });
  });
});

describe("PARTITION op (asymmetric-division bias)", () => {
  it("records (chemId, bias) for the next division", () => {
    const { out } = exec([OP.PUSH8, 5, OP.PARTITION, 3]);
    expect(out.partitionCount).toBe(1);
    expect(out.partitionChem[0]).toBe(3);
    expect(out.partitionBias[0]).toBe(5);
  });

  it("last bias for a given chem wins (dedupes, no count growth)", () => {
    const { out } = exec([OP.PUSH8, 2, OP.PARTITION, 3, OP.PUSH8, 7, OP.PARTITION, 3]);
    expect(out.partitionCount).toBe(1);
    expect(out.partitionBias[0]).toBe(7);
  });

  it("tracks distinct chems separately", () => {
    const { out } = exec([OP.PUSH8, 1, OP.PARTITION, 3, OP.PUSH8, 9, OP.PARTITION, 4]);
    expect(out.partitionCount).toBe(2);
    expect(Array.from(out.partitionChem.subarray(0, 2)).sort()).toEqual([3, 4]);
  });
});

describe("appendGenomeBytes (shared HGT / EGT primitive)", () => {
  const G = () => new Uint8Array([1, 2, 3]);
  const S = () => new Uint8Array([10, 11, 12, 13]);

  it("appends the requested window onto the end", () => {
    const out = appendGenomeBytes(G(), S(), 1, 2);
    expect(Array.from(out)).toEqual([1, 2, 3, 11, 12]);
  });

  it("is append-only: original genome bytes are unchanged and not aliased", () => {
    const g = G();
    const out = appendGenomeBytes(g, S(), 0, 4);
    expect(Array.from(g)).toEqual([1, 2, 3]); // input not mutated
    expect(Array.from(out.subarray(0, 3))).toEqual([1, 2, 3]);
    expect(out.length).toBeGreaterThan(g.length); // length only grows -> PC stays valid
  });

  it("clamps the copied length to GENE_FRAGMENT_CAP", () => {
    const src = new Uint8Array(100).map((_, i) => i & 0xff);
    const out = appendGenomeBytes(new Uint8Array([0]), src, 0, 1000);
    expect(out.length).toBe(1 + GENE_FRAGMENT_CAP);
  });

  it("returns the original array unchanged for no-op requests", () => {
    const g = G();
    expect(appendGenomeBytes(g, S(), 0, 0)).toBe(g); // zero length
    expect(appendGenomeBytes(g, S(), 0, -5)).toBe(g); // negative length
    expect(appendGenomeBytes(g, new Uint8Array(0), 0, 4)).toBe(g); // empty source
  });

  it("wraps a negative/large source offset into bounds", () => {
    expect(Array.from(appendGenomeBytes(G(), S(), -1, 1))).toEqual([1, 2, 3, 13]);
    expect(Array.from(appendGenomeBytes(G(), S(), 4, 1))).toEqual([1, 2, 3, 10]);
  });

  it("truncates the window at the source end (no wrap mid-copy)", () => {
    // offset 3 of a 4-byte src, asking for 32 -> only the last byte.
    expect(Array.from(appendGenomeBytes(G(), S(), 3, 32))).toEqual([1, 2, 3, 13]);
  });
});

