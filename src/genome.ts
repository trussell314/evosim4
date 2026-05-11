// Stack-based bytecode VM that drives creature behavior.
//
// Design notes:
//  - Every byte is "valid": unknown opcodes are NOPs, jumps wrap modulo the
//    genome length, divide-by-zero gives 0, stack underflow gives 0. This is
//    deliberate -- random mutations should always produce an executable (often
//    nonsensical) program, the way real DNA does.
//  - Each tick the VM gets an instruction budget and yields when it runs out
//    (or hits HALT). PC + stack persist across ticks.
//  - SENSE_* opcodes are placeholders for proper physical sensors (photon,
//    chemical gradient, pressure). For now they query a precomputed
//    nearest-neighbor table per material index. Replacing them is on the
//    roadmap.

export const OP = {
  NOP:           0x00,
  PUSH8:         0x01,
  POP:           0x02,
  DUP:           0x03,
  SWAP:          0x04,

  ADD:           0x10,
  SUB:           0x11,
  MUL:           0x12,
  DIV:           0x13,
  NEG:           0x14,
  ABS:           0x15,
  MIN:           0x16,
  MAX:           0x17,

  LT:            0x20,
  GT:            0x21,
  EQ:            0x22,

  JMP:           0x30,
  JZ:            0x31,
  JNZ:           0x32,

  // Sensors (placeholders -- will be regrounded in physical mechanisms).
  SENSE_DX:      0x40,
  SENSE_DY:      0x41,
  SENSE_DIST:    0x42,
  SELF_ENERGY:   0x43,
  SELF_RESERVE:  0x44,
  SELF_VX:       0x45,
  SELF_VY:       0x46,

  // Actuators.
  THRUST:        0x50,
  EXCRETE:       0x51,

  HALT:          0xFF,
} as const;

const OPERANDS = new Uint8Array(256);
OPERANDS[OP.PUSH8] = 1;
OPERANDS[OP.JMP] = 1;
OPERANDS[OP.JZ] = 1;
OPERANDS[OP.JNZ] = 1;
OPERANDS[OP.SENSE_DX] = 1;
OPERANDS[OP.SENSE_DY] = 1;
OPERANDS[OP.SENSE_DIST] = 1;
OPERANDS[OP.SELF_RESERVE] = 1;
OPERANDS[OP.EXCRETE] = 1;

const NAME_BY_OP: Record<number, string> = {};
for (const [k, v] of Object.entries(OP)) NAME_BY_OP[v as number] = k;

// Operands that index a material (0..5).
const MATERIAL_OPERAND = new Set<number>([
  OP.SENSE_DX, OP.SENSE_DY, OP.SENSE_DIST, OP.SELF_RESERVE, OP.EXCRETE,
]);

const STACK_MAX = 32;
const i8 = (b: number): number => (b > 127 ? b - 256 : b);
const m6 = (b: number): number => b % 6;

export interface VMState {
  pc: number;
  stack: number[];
}

export function newVMState(): VMState {
  return { pc: 0, stack: [] };
}

export interface VMSensors {
  dx: Float32Array;    // length 6, per material index
  dy: Float32Array;
  dist: Float32Array;
}

export interface VMSelf {
  energy: number;
  vx: number;
  vy: number;
  reserve: Float32Array;  // length 6
}

export interface VMOutputs {
  thrustX: number;            // accumulated requested accel (px/s^2)
  thrustY: number;
  excrete: Float32Array;      // length 6, requested mass per material idx
  instructions: number;       // number actually executed this tick
}

export function newOutputs(): VMOutputs {
  return {
    thrustX: 0,
    thrustY: 0,
    excrete: new Float32Array(6),
    instructions: 0,
  };
}

export function runTick(
  genome: Uint8Array,
  state: VMState,
  sensors: VMSensors,
  self: VMSelf,
  budget: number,
  out: VMOutputs,
): void {
  out.thrustX = 0;
  out.thrustY = 0;
  out.excrete.fill(0);
  out.instructions = 0;
  const L = genome.length;
  if (L === 0) return;

  const stack = state.stack;
  const push = (v: number): void => {
    if (!Number.isFinite(v)) v = 0;
    if (stack.length >= STACK_MAX) stack.shift();
    stack.push(v);
  };
  const pop = (): number => (stack.length ? (stack.pop() as number) : 0);
  const readOperand = (): number => {
    const b = genome[state.pc % L];
    state.pc++;
    return b;
  };

  for (let n = 0; n < budget; n++) {
    state.pc = ((state.pc % L) + L) % L;
    const op = genome[state.pc];
    state.pc++;
    out.instructions++;

    switch (op) {
      case OP.NOP: break;
      case OP.PUSH8: push(i8(readOperand())); break;
      case OP.POP: pop(); break;
      case OP.DUP: { const x = pop(); push(x); push(x); break; }
      case OP.SWAP: { const a = pop(); const b = pop(); push(a); push(b); break; }

      case OP.ADD: { const b = pop(); const a = pop(); push(a + b); break; }
      case OP.SUB: { const b = pop(); const a = pop(); push(a - b); break; }
      case OP.MUL: { const b = pop(); const a = pop(); push(a * b); break; }
      case OP.DIV: { const b = pop(); const a = pop(); push(b !== 0 ? a / b : 0); break; }
      case OP.NEG: push(-pop()); break;
      case OP.ABS: push(Math.abs(pop())); break;
      case OP.MIN: { const b = pop(); const a = pop(); push(Math.min(a, b)); break; }
      case OP.MAX: { const b = pop(); const a = pop(); push(Math.max(a, b)); break; }

      case OP.LT: { const b = pop(); const a = pop(); push(a < b ? 1 : 0); break; }
      case OP.GT: { const b = pop(); const a = pop(); push(a > b ? 1 : 0); break; }
      case OP.EQ: { const b = pop(); const a = pop(); push(a === b ? 1 : 0); break; }

      case OP.JMP: { const rel = i8(readOperand()); state.pc += rel; break; }
      case OP.JZ:  { const rel = i8(readOperand()); if (pop() === 0) state.pc += rel; break; }
      case OP.JNZ: { const rel = i8(readOperand()); if (pop() !== 0) state.pc += rel; break; }

      case OP.SENSE_DX:    { const idx = m6(readOperand()); push(sensors.dx[idx]); break; }
      case OP.SENSE_DY:    { const idx = m6(readOperand()); push(sensors.dy[idx]); break; }
      case OP.SENSE_DIST:  { const idx = m6(readOperand()); push(sensors.dist[idx]); break; }
      case OP.SELF_ENERGY: push(self.energy); break;
      case OP.SELF_RESERVE:{ const idx = m6(readOperand()); push(self.reserve[idx]); break; }
      case OP.SELF_VX:     push(self.vx); break;
      case OP.SELF_VY:     push(self.vy); break;

      case OP.THRUST: {
        const ay = pop();
        const ax = pop();
        out.thrustX += ax;
        out.thrustY += ay;
        break;
      }
      case OP.EXCRETE: {
        const idx = m6(readOperand());
        const amt = Math.max(0, pop());
        out.excrete[idx] += amt;
        break;
      }
      case OP.HALT:
        return;

      default: break; // unknown -> NOP
    }
  }
}

// Human-readable dump for the inspector panel. Plain disassembly for now;
// a structural decompiler (collapsing into nested control flow) can come later.
export function disassemble(genome: Uint8Array, materialNames?: ReadonlyArray<string>): string {
  const lines: string[] = [];
  let i = 0;
  while (i < genome.length) {
    const op = genome[i];
    const name = NAME_BY_OP[op];
    const operandLen = OPERANDS[op];
    let s = i.toString(16).padStart(4, "0") + ": ";
    if (name) {
      s += name.toLowerCase();
      if (operandLen === 1 && i + 1 < genome.length) {
        const arg = genome[i + 1];
        if (op === OP.PUSH8 || op === OP.JMP || op === OP.JZ || op === OP.JNZ) {
          s += " " + i8(arg);
        } else if (MATERIAL_OPERAND.has(op)) {
          const idx = m6(arg);
          s += " " + (materialNames ? materialNames[idx] : idx);
        } else {
          s += " " + arg;
        }
      }
    } else {
      s += "db 0x" + op.toString(16).padStart(2, "0");
    }
    lines.push(s);
    i += 1 + operandLen;
  }
  return lines.join("\n");
}

// Hand-written starter: thrust toward nearest organic particle each tick.
//
//   sense_dx organic    ; push dx
//   sense_dy organic    ; push dy
//   thrust              ; pop ay, ax -> apply
//   halt
//
// organic = MATERIAL_IDS index 3.
export function makeDefaultGenome(): Uint8Array {
  return new Uint8Array([
    OP.SENSE_DX, 3,
    OP.SENSE_DY, 3,
    OP.THRUST,
    OP.HALT,
  ]);
}
