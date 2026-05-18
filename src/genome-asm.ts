// Substrate-pure genome assembler.
//
// Authoring genomes as raw Uint8Array literals is unreviewable and
// jump offsets are computed by hand against the VM's exact pc
// semantics -- error-prone. This module turns a readable instruction
// list into bytes, resolving label-relative jumps against the real
// decode rule. It is RNG-free and imports no engine/sim state, so
// using it has zero determinism impact (it only emits bytes a genome
// could already contain).
//
// Jump pc semantics (mirrors runTick in genome.ts): the opcode byte
// is fetched and pc advances past it; the 1-byte signed operand is
// then read and pc advances past it; finally pc += rel. So for a JMP
// opcode at address A, operand at A+1, the next pc before the add is
// A+2, and a jump to target T needs rel = T - (A + 2), an i8 in
// [-128, 127].

import { OP, OPERANDS, SYNTH_KIND } from "./genome";

type OpName = keyof typeof OP;
type SynthKindName = keyof typeof SYNTH_KIND;

// One program element. `["LABEL", name]` is a zero-byte marker.
// Everything else is `[opName, ...operands]`:
//   - jumps (`JMP`/`JZ`/`JNZ`) take a single label-name string;
//   - `SYNTH` takes `[kind, param]` where kind is a SYNTH_KIND name
//     (or number) and param a 0..255 byte;
//   - `PUSH8` takes a signed -128..127 immediate;
//   - other 1-operand ops take a 0..255 byte (chem id / reg / etc.);
//   - 0-operand ops take nothing.
export type Instr =
  | readonly ["LABEL", string]
  | readonly [OpName]
  | readonly [OpName, number]
  | readonly ["JMP" | "JZ" | "JNZ", string]
  | readonly ["SYNTH", SynthKindName | number, number];

const JUMP_OPS = new Set<number>([OP.JMP, OP.JZ, OP.JNZ]);

const NAME_BY_BYTE: Record<number, string> = {};
for (const [k, v] of Object.entries(OP)) NAME_BY_BYTE[v] = k;

function opByte(name: string): number {
  if (!(name in OP)) throw new Error(`asm: unknown opcode "${name}"`);
  return OP[name as OpName];
}

function byte(v: number, lo: number, hi: number, what: string): number {
  if (!Number.isInteger(v) || v < lo || v > hi) {
    throw new Error(`asm: ${what} out of range [${lo}, ${hi}]: ${v}`);
  }
  return v & 0xff;
}

// Assemble a program to genome bytes. Two passes: pass 1 fixes every
// instruction's address (so forward label refs resolve), pass 2 emits.
export function asm(prog: ReadonlyArray<Instr>): Uint8Array {
  const labels = new Map<string, number>();
  let addr = 0;
  for (const ins of prog) {
    if (ins[0] === "LABEL") {
      const name = ins[1] as string;
      if (labels.has(name)) throw new Error(`asm: duplicate label "${name}"`);
      labels.set(name, addr);
      continue;
    }
    addr += 1 + OPERANDS[opByte(ins[0])];
  }

  const out: number[] = [];
  for (const ins of prog) {
    if (ins[0] === "LABEL") continue;
    const op = opByte(ins[0]);
    const nOperands = OPERANDS[op];
    out.push(op);
    if (nOperands === 0) {
      if (ins.length > 1) throw new Error(`asm: ${ins[0]} takes no operand`);
      continue;
    }
    if (op === OP.SYNTH) {
      const rawKind = ins[1];
      if (rawKind === undefined) throw new Error("asm: SYNTH needs a kind");
      const kind =
        typeof rawKind === "number"
          ? byte(rawKind, 0, 255, "SYNTH kind")
          : ((): number => {
              if (!(rawKind in SYNTH_KIND)) {
                throw new Error(`asm: unknown SYNTH kind "${rawKind}"`);
              }
              return SYNTH_KIND[rawKind as SynthKindName];
            })();
      const param = byte(ins[2] as number, 0, 255, "SYNTH param");
      out.push(kind, param);
      continue;
    }
    // Single-operand op.
    if (JUMP_OPS.has(op)) {
      const target = ins[1];
      if (typeof target !== "string") {
        throw new Error(`asm: ${ins[0]} target must be a label name`);
      }
      if (!labels.has(target)) {
        throw new Error(`asm: undefined label "${target}"`);
      }
      // out.length is the operand's address; pc after consuming it is
      // operandAddr + 1, then pc += rel.
      const rel = (labels.get(target) as number) - (out.length + 1);
      out.push(byte(rel, -128, 127, `jump offset to "${target}"`));
      continue;
    }
    const v = ins[1];
    if (typeof v !== "number") {
      throw new Error(`asm: ${ins[0]} operand must be a number`);
    }
    if (op === OP.PUSH8) out.push(byte(v, -128, 127, "PUSH8 immediate"));
    else out.push(byte(v, 0, 255, `${ins[0]} operand`));
  }
  return Uint8Array.from(out);
}

// Structural self-check used by archetype tests: every byte must be
// reachable as an opcode-or-operand on the OPERANDS-aligned walk, no
// instruction's operand may run off the end, and every opcode must be
// a known op (no accidental `db 0x..`). Throws on any violation.
export function assertWellFormed(genome: Uint8Array): void {
  let i = 0;
  while (i < genome.length) {
    const op = genome[i];
    if (!(op in NAME_BY_BYTE)) {
      throw new Error(
        `asm: byte 0x${op.toString(16)} at ${i} is not a known opcode`,
      );
    }
    const need = OPERANDS[op];
    if (i + 1 + need > genome.length) {
      throw new Error(`asm: truncated operand for ${NAME_BY_BYTE[op]} at ${i}`);
    }
    i += 1 + need;
  }
  if (i !== genome.length) {
    throw new Error(`asm: walk ended at ${i}, genome length ${genome.length}`);
  }
}
