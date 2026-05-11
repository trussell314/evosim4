// Stack-based bytecode VM that drives creature behavior.

export const OP = {
  NOP:           0x00,
  PUSH8:         0x01,
  POP:           0x02,
  DUP:           0x03,
  SWAP:          0x04,
  OVER:          0x05,
  ROT:           0x06,

  ADD:           0x10,
  SUB:           0x11,
  MUL:           0x12,
  DIV:           0x13,
  NEG:           0x14,
  ABS:           0x15,
  MIN:           0x16,
  MAX:           0x17,
  MOD:           0x18,
  SIGN:          0x19,

  LT:            0x20,
  GT:            0x21,
  EQ:            0x22,
  NOT:           0x23,
  AND:           0x24,
  OR:            0x25,

  JMP:           0x30,
  JZ:            0x31,
  JNZ:           0x32,

  SENSE_GRAD_X:  0x40,
  SENSE_GRAD_Y:  0x41,
  SENSE_DENSITY: 0x42,
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
  SELF_BIOMASS:  0x4D,
  SELF_AGE:      0x4E,
  SELF_GLUCOSE:  0x4F,

  THRUST:        0x50,
  EXCRETE:       0x51,
  REPRODUCE:     0x52,
  PREDATE:       0x53,   // ingest: absorb prey immediately into own reserves
  TURN:          0x54,   // pop angle delta, rotate the cell's velocity
  ENGULF:        0x55,   // swallow whole: prey persists alive in vacuole

  SELF_O2:       0x56,
  SELF_FATTY:    0x57,
  SELF_AMINO:    0x58,
  SELF_WASTE:    0x59,
  SENSE_WALL_X:  0x5A,
  SENSE_WALL_Y:  0x5B,
  SENSE_HEAD_X:  0x5C,
  SENSE_HEAD_Y:  0x5D,
  INGEST:        0x5E,   // absorb a particle in radius (was implicit before)
  SENSE_TEMP:    0x5F,   // local water temperature

  HALT:          0xFF,
} as const;

const OPERANDS = new Uint8Array(256);
OPERANDS[OP.PUSH8] = 1;
OPERANDS[OP.JMP] = 1;
OPERANDS[OP.JZ] = 1;
OPERANDS[OP.JNZ] = 1;
OPERANDS[OP.SENSE_GRAD_X] = 1;
OPERANDS[OP.SENSE_GRAD_Y] = 1;
OPERANDS[OP.SENSE_DENSITY] = 1;
OPERANDS[OP.SELF_RESERVE] = 1;
OPERANDS[OP.EXCRETE] = 1;
OPERANDS[OP.INGEST] = 1;


const NAME_BY_OP: Record<number, string> = {};
for (const [k, v] of Object.entries(OP)) NAME_BY_OP[v as number] = k;

const MATERIAL_OPERAND = new Set<number>([
  OP.SENSE_GRAD_X, OP.SENSE_GRAD_Y, OP.SENSE_DENSITY, OP.SELF_RESERVE, OP.EXCRETE, OP.INGEST,
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
  // Per-material food gradient: signed inverse-square-weighted pull vector
  // toward every visible particle of that material. Bigger magnitude where
  // food is denser or closer; sign points toward the cluster centroid.
  gradX: Float32Array;
  gradY: Float32Array;
  // Per-material count of particles within sense range. Tells the cell
  // whether it's in a rich pocket or a desert.
  density: Float32Array;
  // Push-from-wall vector. Magnitude grows as the cell approaches an edge;
  // sign points away from the closer wall on each axis. Zero in the middle.
  wallX: number;
  wallY: number;
  // Current normalized velocity. Unit vector when moving, (0,0) at rest.
  headX: number;
  headY: number;
  // Local water temperature at the cell's position. Roughly 12..28 °C.
  temp: number;
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
  biomass: number;
  age: number;
  glucose: number;
  o2: number;
  fattyAcid: number;
  aminoAcid: number;
  waste: number;
}

export interface VMOutputs {
  thrustX: number;
  thrustY: number;
  // Accumulated angle delta (radians) for any TURN ops this tick. The sim
  // applies this after the VM runs by rotating the cell's velocity vector.
  turn: number;
  excrete: Float32Array;
  reproduce: boolean;
  predate: boolean;
  engulf: boolean;
  // Per-material ingest mask. The genome calls INGEST <material>; the
  // matching index is set to 1 each tick. Multiple INGEST ops in one
  // tick accumulate (cell can choose to eat either of several types).
  ingestMaterials: Uint8Array;
  instructions: number;
}

export function newOutputs(): VMOutputs {
  return {
    thrustX: 0, thrustY: 0, turn: 0,
    excrete: new Float32Array(6),
    reproduce: false, predate: false, engulf: false,
    ingestMaterials: new Uint8Array(6),
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
  out.turn = 0;
  out.excrete.fill(0);
  out.reproduce = false;
  out.predate = false;
  out.engulf = false;
  out.ingestMaterials.fill(0);
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
      case OP.OVER: { const b = pop(); const a = pop(); push(a); push(b); push(a); break; }
      case OP.ROT:  { const c = pop(); const b = pop(); const a = pop(); push(b); push(c); push(a); break; }

      case OP.ADD: { const b = pop(); const a = pop(); push(a + b); break; }
      case OP.SUB: { const b = pop(); const a = pop(); push(a - b); break; }
      case OP.MUL: { const b = pop(); const a = pop(); push(a * b); break; }
      case OP.DIV: { const b = pop(); const a = pop(); push(b !== 0 ? a / b : 0); break; }
      case OP.NEG: push(-pop()); break;
      case OP.ABS: push(Math.abs(pop())); break;
      case OP.MIN: { const b = pop(); const a = pop(); push(Math.min(a, b)); break; }
      case OP.MAX: { const b = pop(); const a = pop(); push(Math.max(a, b)); break; }
      case OP.MOD: { const b = pop(); const a = pop(); push(b !== 0 ? a - Math.floor(a / b) * b : 0); break; }
      case OP.SIGN: { const a = pop(); push(a > 0 ? 1 : a < 0 ? -1 : 0); break; }

      case OP.LT: { const b = pop(); const a = pop(); push(a < b ? 1 : 0); break; }
      case OP.GT: { const b = pop(); const a = pop(); push(a > b ? 1 : 0); break; }
      case OP.EQ: { const b = pop(); const a = pop(); push(a === b ? 1 : 0); break; }
      case OP.NOT: push(pop() === 0 ? 1 : 0); break;
      case OP.AND: { const b = pop(); const a = pop(); push(a !== 0 && b !== 0 ? 1 : 0); break; }
      case OP.OR:  { const b = pop(); const a = pop(); push(a !== 0 || b !== 0 ? 1 : 0); break; }

      case OP.JMP: { const rel = i8(readOperand()); state.pc += rel; break; }
      case OP.JZ:  { const rel = i8(readOperand()); if (pop() === 0) state.pc += rel; break; }
      case OP.JNZ: { const rel = i8(readOperand()); if (pop() !== 0) state.pc += rel; break; }

      case OP.SENSE_GRAD_X:{ const idx = m6(readOperand()); push(sensors.gradX[idx]); break; }
      case OP.SENSE_GRAD_Y:{ const idx = m6(readOperand()); push(sensors.gradY[idx]); break; }
      case OP.SENSE_DENSITY:{ const idx = m6(readOperand()); push(sensors.density[idx]); break; }
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
      case OP.SELF_BIOMASS:   push(self.biomass); break;
      case OP.SELF_AGE:       push(self.age); break;
      case OP.SELF_GLUCOSE:   push(self.glucose); break;
      case OP.SELF_O2:        push(self.o2); break;
      case OP.SELF_FATTY:     push(self.fattyAcid); break;
      case OP.SELF_AMINO:     push(self.aminoAcid); break;
      case OP.SELF_WASTE:     push(self.waste); break;
      case OP.SENSE_WALL_X:   push(sensors.wallX); break;
      case OP.SENSE_WALL_Y:   push(sensors.wallY); break;
      case OP.SENSE_HEAD_X:   push(sensors.headX); break;
      case OP.SENSE_HEAD_Y:   push(sensors.headY); break;
      case OP.SENSE_TEMP:     push(sensors.temp); break;

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
      case OP.INGEST:     { const idx = m6(readOperand()); out.ingestMaterials[idx] = 1; break; }
      case OP.TURN:       out.turn      += pop(); break;
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

// Default genome: swim up the organic food gradient (toward the richest
// direction, weighted by every nearby particle) and try to fission when
// ATP clears a low gate. tryReproduce charges a non-trivial ATP fee per
// attempt (even on failure), so the gate exists mainly to keep that fee
// from siphoning the cell back to zero every tick.
//
//   sense_grad_x organic
//   sense_grad_y organic
//   thrust                 ; accelerate up the food gradient
//   ingest organic         ; absorb only organic particles this tick
//   self_energy            ; push ATP
//   push8 3                ; threshold
//   gt                     ; ATP > 3 ?
//   jz +1                  ; if not, skip REPRODUCE
//   reproduce              ; try to fission
//   halt
export function makeDefaultGenome(): Uint8Array {
  return new Uint8Array([
    OP.SENSE_GRAD_X, 3,
    OP.SENSE_GRAD_Y, 3,
    OP.THRUST,
    OP.INGEST, 3,
    OP.SELF_ENERGY,
    OP.PUSH8, 3,
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

// Single mutation event for somatic (in-life) damage. Unlike mutateGenome
// (which runs once at fission across every byte), this applies exactly
// one change: 70% point, 15% insertion, 15% deletion. Callers gate the
// rate -- typically by age, so DNA damage accumulates as the cell lives.
export function somaticMutateOnce(
  genome: Uint8Array,
  rng: () => number = Math.random,
): Uint8Array {
  if (genome.length === 0) return makeDefaultGenome();
  const r = rng();
  if (r < 0.7) {
    const idx = Math.floor(rng() * genome.length);
    const out = new Uint8Array(genome);
    out[idx] = Math.floor(rng() * 256);
    return out;
  }
  if (r < 0.85 && genome.length < MAX_GENOME_BYTES) {
    const idx = Math.floor(rng() * (genome.length + 1));
    const out = new Uint8Array(genome.length + 1);
    out.set(genome.subarray(0, idx), 0);
    out[idx] = Math.floor(rng() * 256);
    out.set(genome.subarray(idx), idx + 1);
    return out;
  }
  if (genome.length > 1) {
    const idx = Math.floor(rng() * genome.length);
    const out = new Uint8Array(genome.length - 1);
    out.set(genome.subarray(0, idx), 0);
    out.set(genome.subarray(idx + 1), idx);
    return out;
  }
  return genome;
}
