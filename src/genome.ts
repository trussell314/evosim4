// Stack-based bytecode VM that drives creature behavior.

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

  SENSE_DX:      0x40,
  SENSE_DY:      0x41,
  SENSE_DIST:    0x42,
  SELF_ENERGY:   0x43,
  SELF_RESERVE:  0x44,
  SELF_VX:       0x45,
  SELF_VY:       0x46,
  SENSE_CRE_DX:  0x47,
  SENSE_CRE_DY:  0x48,
  SENSE_CRE_DIST:0x49,
  SENSE_CRE_MASS:0x4A,
  SELF_MASS:     0x4B,
  SENSE_LIGHT:   0x4C,

  THRUST:        0x50,
  EXCRETE:       0x51,
  REPRODUCE:     0x52,
  PREDATE:       0x53,   // ingest: absorb prey immediately into own reserves
  ENGULF:        0x55,   // swallow whole: prey persists alive in vacuole

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
  dx: Float32Array;
  dy: Float32Array;
  dist: Float32Array;
  creatureDx: number;
  creatureDy: number;
  creatureDist: number;
  creatureMass: number;
  light: number;
}

export interface VMSelf {
  energy: number;
  vx: number;
  vy: number;
  reserve: Float32Array;
  mass: number;
}

export interface VMOutputs {
  thrustX: number;
  thrustY: number;
  excrete: Float32Array;
  reproduce: boolean;
  predate: boolean;
  engulf: boolean;
  instructions: number;
}

export function newOutputs(): VMOutputs {
  return {
    thrustX: 0, thrustY: 0,
    excrete: new Float32Array(6),
    reproduce: false, predate: false, engulf: false,
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
  out.reproduce = false;
  out.predate = false;
  out.engulf = false;
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
      case OP.SENSE_CRE_DX:   push(sensors.creatureDx); break;
      case OP.SENSE_CRE_DY:   push(sensors.creatureDy); break;
      case OP.SENSE_CRE_DIST: push(sensors.creatureDist); break;
      case OP.SENSE_CRE_MASS: push(sensors.creatureMass); break;
      case OP.SELF_MASS:      push(self.mass); break;
      case OP.SENSE_LIGHT:    push(sensors.light); break;

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
      case OP.REPRODUCE:  out.reproduce  = true; break;
      case OP.PREDATE:    out.predate    = true; break;
      case OP.ENGULF:     out.engulf     = true; break;
      case OP.HALT:
        return;

      default: break;
    }
  }
}

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

// Default genome under the new chemistry: chase organic particles and try
// to reproduce every tick. The fission cost (paid in amino-acid / fatty-acid
// / minerals / biomass molecules, NOT in a single reserve threshold) is
// gated inside tryReproduce, so the genome doesn't need an explicit check.
// Reproduce-cooldown handles spacing.
export function makeDefaultGenome(): Uint8Array {
  return new Uint8Array([
    OP.SENSE_DX, 3,    // dx to nearest organic particle
    OP.SENSE_DY, 3,    // dy to nearest organic particle
    OP.THRUST,         // accelerate toward it
    OP.REPRODUCE,      // try to fission this tick (gated internally)
    OP.HALT,
  ]);
}

export function genomeMaterialCost(genome: Uint8Array, massPerByte: number): Float32Array {
  const cost = new Float32Array(6);
  for (let i = 0; i < genome.length; i++) {
    cost[genome[i] % 6] += massPerByte;
  }
  return cost;
}

const P_POINT  = 0.02;
const P_INSERT = 0.005;
const P_DELETE = 0.005;
const MAX_GENOME_BYTES = 256;

export function mutateGenome(
  genome: Uint8Array,
  rng: () => number = Math.random,
): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < genome.length; i++) {
    if (rng() < P_DELETE) continue;
    if (rng() < P_INSERT && out.length < MAX_GENOME_BYTES) {
      out.push(Math.floor(rng() * 256));
    }
    let b = genome[i];
    if (rng() < P_POINT) b = Math.floor(rng() * 256);
    if (out.length < MAX_GENOME_BYTES) out.push(b);
  }
  if (rng() < P_INSERT && out.length < MAX_GENOME_BYTES) {
    out.push(Math.floor(rng() * 256));
  }
  if (out.length === 0) return makeDefaultGenome();
  return new Uint8Array(out);
}
