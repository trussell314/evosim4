// Stack-based bytecode VM for creature genomes.
//
// Sensor model: VMSensors has six material slots (one per MaterialId) carrying
// dx/dy/dist to the nearest particle of each kind, plus the nearest other
// creature's dx/dy/dist/mass and ambient light. Self exposes energy, vx, vy,
// per-material reserves, and total stored mass.
//
// Outputs accumulate into a VMOutputs struct each tick: thrust vector,
// excretion request per material, and three intent flags (reproduce, predate,
// photosynth). The sim consumes those, debits energy, and applies effects.

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
  photosynth: boolean;
  instructions: number;
}

export const OP = {
  HALT:          0x00,
  NOP:           0x01,
  PUSH8:         0x10,
  POP:           0x11,
  DUP:           0x12,
  SWAP:          0x13,
  ADD:           0x20,
  SUB:           0x21,
  MUL:           0x22,
  DIV:           0x23,
  NEG:           0x24,
  ABS:           0x25,
  MIN:           0x26,
  MAX:           0x27,
  EQ:            0x30,
  NE:            0x31,
  LT:            0x32,
  GT:            0x33,
  JMP:           0x40,
  JZ:            0x41,
  JNZ:           0x42,
  SENSE_DX:      0x48,
  SENSE_DY:      0x49,
  SENSE_DIST:    0x4A,
  SENSE_VEL:     0x4B,
  SENSE_LIGHT:   0x4C,
  SENSE_CDX:     0x4D,
  SENSE_CDY:     0x4E,
  SENSE_CDIST:   0x4F,
  SENSE_CMASS:   0x50,
  THRUST:        0x51,
  REPRODUCE:     0x52,
  PREDATE:       0x53,
  PHOTOSYNTH:    0x54,
  EXCRETE:       0x60,
  SELF_ENERGY:   0x70,
  SELF_VX:       0x71,
  SELF_VY:       0x72,
  SELF_RESERVE:  0x73,
  SELF_MASS:     0x74,
} as const;

export type OpCode = typeof OP[keyof typeof OP];

export interface VMState {
  pc: number;
  stack: number[];
}

export function newVMState(): VMState {
  return { pc: 0, stack: [] };
}

export function newOutputs(): VMOutputs {
  return {
    thrustX: 0,
    thrustY: 0,
    excrete: new Float32Array(6),
    reproduce: false,
    predate: false,
    photosynth: false,
    instructions: 0,
  };
}

function signExtend8(b: number): number {
  return b < 128 ? b : b - 256;
}

function pop(stack: number[]): number {
  return stack.length > 0 ? (stack.pop() as number) : 0;
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
  out.reproduce = false;
  out.predate = false;
  out.photosynth = false;
  for (let i = 0; i < 6; i++) out.excrete[i] = 0;
  out.instructions = 0;

  if (genome.length === 0) return;

  const stack = state.stack;
  let pc = state.pc;
  if (pc >= genome.length) pc = 0;

  let steps = 0;
  while (steps < budget) {
    if (pc >= genome.length) pc = 0;
    const op = genome[pc++];
    steps++;

    switch (op) {
      case OP.HALT: out.instructions = steps; state.pc = pc; return;
      case OP.NOP:  break;
      case OP.PUSH8: {
        const b = pc < genome.length ? genome[pc++] : 0;
        stack.push(signExtend8(b));
        break;
      }
      case OP.POP: pop(stack); break;
      case OP.DUP: {
        const v = stack.length > 0 ? stack[stack.length - 1] : 0;
        stack.push(v);
        break;
      }
      case OP.SWAP: {
        if (stack.length >= 2) {
          const a = stack[stack.length - 1];
          stack[stack.length - 1] = stack[stack.length - 2];
          stack[stack.length - 2] = a;
        }
        break;
      }
      case OP.ADD: { const b = pop(stack), a = pop(stack); stack.push(a + b); break; }
      case OP.SUB: { const b = pop(stack), a = pop(stack); stack.push(a - b); break; }
      case OP.MUL: { const b = pop(stack), a = pop(stack); stack.push(a * b); break; }
      case OP.DIV: { const b = pop(stack), a = pop(stack); stack.push(b === 0 ? 0 : a / b); break; }
      case OP.NEG: { const a = pop(stack); stack.push(-a); break; }
      case OP.ABS: { const a = pop(stack); stack.push(Math.abs(a)); break; }
      case OP.MIN: { const b = pop(stack), a = pop(stack); stack.push(Math.min(a, b)); break; }
      case OP.MAX: { const b = pop(stack), a = pop(stack); stack.push(Math.max(a, b)); break; }
      case OP.EQ:  { const b = pop(stack), a = pop(stack); stack.push(a === b ? 1 : 0); break; }
      case OP.NE:  { const b = pop(stack), a = pop(stack); stack.push(a !== b ? 1 : 0); break; }
      case OP.LT:  { const b = pop(stack), a = pop(stack); stack.push(a < b ? 1 : 0); break; }
      case OP.GT:  { const b = pop(stack), a = pop(stack); stack.push(a > b ? 1 : 0); break; }
      case OP.JMP: {
        const off = pc < genome.length ? signExtend8(genome[pc++]) : 0;
        pc += off;
        if (pc < 0) pc = 0;
        break;
      }
      case OP.JZ: {
        const off = pc < genome.length ? signExtend8(genome[pc++]) : 0;
        const v = pop(stack);
        if (v === 0) { pc += off; if (pc < 0) pc = 0; }
        break;
      }
      case OP.JNZ: {
        const off = pc < genome.length ? signExtend8(genome[pc++]) : 0;
        const v = pop(stack);
        if (v !== 0) { pc += off; if (pc < 0) pc = 0; }
        break;
      }
      case OP.SENSE_DX: { const i = (pc < genome.length ? genome[pc++] : 0) % 6; stack.push(sensors.dx[i]); break; }
      case OP.SENSE_DY: { const i = (pc < genome.length ? genome[pc++] : 0) % 6; stack.push(sensors.dy[i]); break; }
      case OP.SENSE_DIST: { const i = (pc < genome.length ? genome[pc++] : 0) % 6; stack.push(sensors.dist[i]); break; }
      case OP.SENSE_VEL: { stack.push(Math.sqrt(self.vx * self.vx + self.vy * self.vy)); break; }
      case OP.SENSE_LIGHT: { stack.push(sensors.light); break; }
      case OP.SENSE_CDX:   { stack.push(sensors.creatureDx); break; }
      case OP.SENSE_CDY:   { stack.push(sensors.creatureDy); break; }
      case OP.SENSE_CDIST: { stack.push(sensors.creatureDist); break; }
      case OP.SENSE_CMASS: { stack.push(sensors.creatureMass); break; }
      case OP.THRUST: {
        const ty = pop(stack);
        const tx = pop(stack);
        out.thrustX += tx;
        out.thrustY += ty;
        break;
      }
      case OP.REPRODUCE:  out.reproduce  = true; break;
      case OP.PREDATE:    out.predate    = true; break;
      case OP.PHOTOSYNTH: out.photosynth = true; break;
      case OP.EXCRETE: {
        const idx = (pc < genome.length ? genome[pc++] : 0) % 6;
        const amount = pop(stack);
        if (amount > 0) out.excrete[idx] += amount;
        break;
      }
      case OP.SELF_ENERGY: stack.push(self.energy); break;
      case OP.SELF_VX:     stack.push(self.vx); break;
      case OP.SELF_VY:     stack.push(self.vy); break;
      case OP.SELF_RESERVE: {
        const i = (pc < genome.length ? genome[pc++] : 0) % 6;
        stack.push(self.reserve[i]);
        break;
      }
      case OP.SELF_MASS: stack.push(self.mass); break;
      default: /* unknown opcode: noop */ break;
    }

    if (stack.length > 64) stack.splice(0, stack.length - 64);
  }

  out.instructions = steps;
  state.pc = pc;
}

export function disassemble(genome: Uint8Array, materialIds: readonly string[]): string {
  const lines: string[] = [];
  const opName: Record<number, string> = {};
  for (const [k, v] of Object.entries(OP)) opName[v as number] = k;
  let i = 0;
  while (i < genome.length) {
    const op = genome[i];
    const name = opName[op] ?? `?0x${op.toString(16)}`;
    let operandLen = 0;
    if (op === OP.PUSH8 || op === OP.JMP || op === OP.JZ || op === OP.JNZ) operandLen = 1;
    if (op === OP.SENSE_DX || op === OP.SENSE_DY || op === OP.SENSE_DIST ||
        op === OP.EXCRETE || op === OP.SELF_RESERVE) operandLen = 1;
    let s = i.toString().padStart(3, " ") + "  " + name;
    if (operandLen === 1 && i + 1 < genome.length) {
      const b = genome[i + 1];
      if (op === OP.PUSH8) s += " " + signExtend8(b);
      else if (op === OP.JMP || op === OP.JZ || op === OP.JNZ) s += " " + signExtend8(b);
      else if (op === OP.SENSE_DX || op === OP.SENSE_DY || op === OP.SENSE_DIST ||
               op === OP.EXCRETE || op === OP.SELF_RESERVE) {
        s += " " + (materialIds[b % 6] ?? `?${b % 6}`);
      } else {
        s += " " + b;
      }
    } else if (op === OP.HALT) {
      // no operand
    } else if (operandLen === 0) {
      // no operand
    } else {
      s += "db 0x" + op.toString(16).padStart(2, "0");
    }
    lines.push(s);
    i += 1 + operandLen;
  }
  return lines.join("\n");
}

export function makeDefaultGenome(): Uint8Array {
  return new Uint8Array([
    OP.SENSE_DX, 3,
    OP.SENSE_DY, 3,
    OP.THRUST,
    OP.SELF_RESERVE, 3,
    OP.PUSH8, 45,
    OP.GT,
    OP.JZ, 1,
    OP.REPRODUCE,
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
