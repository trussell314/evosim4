// Stack-based bytecode VM that drives creature behavior.

export const OP = {
  NOP:           0x00,
  PUSH8:         0x01,
  POP:           0x02,
  DUP:           0x03,
  SWAP:          0x04,
  OVER:          0x05,
  ROT:           0x06,
  LOAD:          0x07,    // push register[i] onto stack
  STORE:         0x08,    // pop, store into register[i]

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
  EMIT:          0x60,   // pop intensity, add it to the pheromone field here
  SENSE_PHEROMONE: 0x61, // push local pheromone concentration
  ADHERE:        0x62,   // bond with nearest cell in range; forms colonies
  REPAIR:        0x63,   // spend ATP to suppress somatic mutation briefly
  SENSE_AMP:     0x64,   // passive: each copy expands the cell's sense range
  POKE_BYTE:     0x65,   // pop (idx, val), write genome[idx % L] = val & 0xff
  SPLICE_DUP:    0x66,   // pop (offset, length), duplicate that region in place
  SPLICE_DEL:    0x67,   // pop (offset, length), delete that region from genome

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
OPERANDS[OP.LOAD] = 1;
OPERANDS[OP.STORE] = 1;


const NAME_BY_OP: Record<number, string> = {};
for (const [k, v] of Object.entries(OP)) NAME_BY_OP[v as number] = k;

const MATERIAL_OPERAND = new Set<number>([
  OP.SENSE_GRAD_X, OP.SENSE_GRAD_Y, OP.SENSE_DENSITY, OP.SELF_RESERVE, OP.EXCRETE, OP.INGEST,
]);

const STACK_MAX = 32;
const REG_COUNT = 16;
const i8 = (b: number): number => (b > 127 ? b - 256 : b);
const m6 = (b: number): number => b % 6;
const m16 = (b: number): number => b % REG_COUNT;

// Hoisted stack helpers. Module-level so runTick doesn't allocate
// fresh closures on every call.
function vmPush(stack: number[], v: number): void {
  if (!Number.isFinite(v)) v = 0;
  if (stack.length >= STACK_MAX) stack.shift();
  stack.push(v);
}
function vmPop(stack: number[]): number {
  return stack.length ? (stack.pop() as number) : 0;
}

export interface VMState {
  pc: number;
  stack: number[];
  // Scratch register file. Persists across ticks so a genome can build
  // oscillators, timers, integrators, memory of past sensor values.
  regs: Float32Array;
}

export function newVMState(): VMState {
  return { pc: 0, stack: [], regs: new Float32Array(REG_COUNT) };
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
  // Local pheromone concentration (diffusing signal field).
  pheromone: number;
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
  // Pheromone amount this cell wants to emit into the field this tick.
  emit: number;
  // Cell wants to bond with the nearest creature in range this tick.
  adhere: boolean;
  reproduce: boolean;
  // Parent's share of mass after fission. Set by REPRODUCE from the
  // stack-top value, clamped to [0.1, 0.9]; out-of-range / NaN / empty
  // stack defaults to 0.5 (symmetric). Cells can evolve to "throw small
  // daughters often" (f=0.9) or "split big" (f=0.5).
  reproduceFraction: number;
  predate: boolean;
  engulf: boolean;
  // Per-material ingest mask. The genome calls INGEST <material>; the
  // matching index is set to 1 each tick. Multiple INGEST ops in one
  // tick accumulate (cell can choose to eat either of several types).
  ingestMaterials: Uint8Array;
  // Count of REPAIR ops that fired this tick. Sim multiplies by a fixed
  // ATP cost to debit the cell, and refreshes its repair window.
  repair: number;
  // Pending genome-length-change request from SPLICE_DUP / SPLICE_DEL.
  // mode 0 = none, 1 = duplicate region, 2 = delete region. Sim consumes
  // this after runTick returns: changing genome length mid-tick would
  // invalidate PC. Last splice op of the tick wins.
  spliceMode: number;
  spliceOffset: number;
  spliceLength: number;
  instructions: number;
}

export function newOutputs(): VMOutputs {
  return {
    thrustX: 0, thrustY: 0, turn: 0,
    excrete: new Float32Array(6),
    reproduce: false, reproduceFraction: 0.5,
    predate: false, engulf: false, emit: 0, adhere: false,
    ingestMaterials: new Uint8Array(6),
    repair: 0,
    spliceMode: 0, spliceOffset: 0, spliceLength: 0,
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
  out.reproduceFraction = 0.5;
  out.predate = false;
  out.engulf = false;
  out.emit = 0;
  out.adhere = false;
  out.ingestMaterials.fill(0);
  out.repair = 0;
  out.spliceMode = 0;
  out.spliceOffset = 0;
  out.spliceLength = 0;
  out.instructions = 0;
  const L = genome.length;
  if (L === 0) return;

  // Hoisted helpers: stack/genome live on `state`, no per-call closure
  // allocation. Tens of thousands of runTick calls per second on a busy
  // world used to make these allocations show up in profiles.
  const stack = state.stack;
  const regs = state.regs;

  for (let n = 0; n < budget; n++) {
    state.pc = ((state.pc % L) + L) % L;
    const op = genome[state.pc];
    state.pc++;
    out.instructions++;

    switch (op) {
      case OP.NOP: break;
      case OP.PUSH8: { const b = genome[state.pc % L]; state.pc++; vmPush(stack, i8(b)); break; }
      case OP.POP: vmPop(stack); break;
      case OP.DUP: { const x = vmPop(stack); vmPush(stack, x); vmPush(stack, x); break; }
      case OP.SWAP: { const a = vmPop(stack); const b = vmPop(stack); vmPush(stack, a); vmPush(stack, b); break; }
      case OP.OVER: { const b = vmPop(stack); const a = vmPop(stack); vmPush(stack, a); vmPush(stack, b); vmPush(stack, a); break; }
      case OP.ROT:  { const c = vmPop(stack); const b = vmPop(stack); const a = vmPop(stack); vmPush(stack, b); vmPush(stack, c); vmPush(stack, a); break; }
      case OP.LOAD: { const i = m16(genome[state.pc % L]); state.pc++; vmPush(stack, regs[i]); break; }
      case OP.STORE: { const i = m16(genome[state.pc % L]); state.pc++; const v = vmPop(stack); regs[i] = Number.isFinite(v) ? v : 0; break; }

      case OP.ADD: { const b = vmPop(stack); const a = vmPop(stack); vmPush(stack, a + b); break; }
      case OP.SUB: { const b = vmPop(stack); const a = vmPop(stack); vmPush(stack, a - b); break; }
      case OP.MUL: { const b = vmPop(stack); const a = vmPop(stack); vmPush(stack, a * b); break; }
      case OP.DIV: { const b = vmPop(stack); const a = vmPop(stack); vmPush(stack, b !== 0 ? a / b : 0); break; }
      case OP.NEG: vmPush(stack, -vmPop(stack)); break;
      case OP.ABS: vmPush(stack, Math.abs(vmPop(stack))); break;
      case OP.MIN: { const b = vmPop(stack); const a = vmPop(stack); vmPush(stack, Math.min(a, b)); break; }
      case OP.MAX: { const b = vmPop(stack); const a = vmPop(stack); vmPush(stack, Math.max(a, b)); break; }
      case OP.MOD: { const b = vmPop(stack); const a = vmPop(stack); vmPush(stack, b !== 0 ? a - Math.floor(a / b) * b : 0); break; }
      case OP.SIGN: { const a = vmPop(stack); vmPush(stack, a > 0 ? 1 : a < 0 ? -1 : 0); break; }

      case OP.LT: { const b = vmPop(stack); const a = vmPop(stack); vmPush(stack, a < b ? 1 : 0); break; }
      case OP.GT: { const b = vmPop(stack); const a = vmPop(stack); vmPush(stack, a > b ? 1 : 0); break; }
      case OP.EQ: { const b = vmPop(stack); const a = vmPop(stack); vmPush(stack, a === b ? 1 : 0); break; }
      case OP.NOT: vmPush(stack, vmPop(stack) === 0 ? 1 : 0); break;
      case OP.AND: { const b = vmPop(stack); const a = vmPop(stack); vmPush(stack, a !== 0 && b !== 0 ? 1 : 0); break; }
      case OP.OR:  { const b = vmPop(stack); const a = vmPop(stack); vmPush(stack, a !== 0 || b !== 0 ? 1 : 0); break; }

      case OP.JMP: { const rel = i8(genome[state.pc % L]); state.pc++; state.pc += rel; break; }
      case OP.JZ:  { const rel = i8(genome[state.pc % L]); state.pc++; if (vmPop(stack) === 0) state.pc += rel; break; }
      case OP.JNZ: { const rel = i8(genome[state.pc % L]); state.pc++; if (vmPop(stack) !== 0) state.pc += rel; break; }

      case OP.SENSE_GRAD_X:  { const i = m6(genome[state.pc % L]); state.pc++; vmPush(stack, sensors.gradX[i]); break; }
      case OP.SENSE_GRAD_Y:  { const i = m6(genome[state.pc % L]); state.pc++; vmPush(stack, sensors.gradY[i]); break; }
      case OP.SENSE_DENSITY: { const i = m6(genome[state.pc % L]); state.pc++; vmPush(stack, sensors.density[i]); break; }
      case OP.SELF_ENERGY:   vmPush(stack, self.energy); break;
      case OP.SELF_RESERVE:  { const i = m6(genome[state.pc % L]); state.pc++; vmPush(stack, self.reserve[i]); break; }
      case OP.SELF_VX:       vmPush(stack, self.vx); break;
      case OP.SELF_VY:       vmPush(stack, self.vy); break;
      case OP.SENSE_CRE_DX:   vmPush(stack, sensors.creatureDx); break;
      case OP.SENSE_CRE_DY:   vmPush(stack, sensors.creatureDy); break;
      case OP.SENSE_CRE_DIST: vmPush(stack, sensors.creatureDist); break;
      case OP.SENSE_CRE_MASS: vmPush(stack, sensors.creatureMass); break;
      case OP.SELF_MASS:      vmPush(stack, self.mass); break;
      case OP.SENSE_LIGHT:    vmPush(stack, sensors.light); break;
      case OP.SELF_BIOMASS:   vmPush(stack, self.biomass); break;
      case OP.SELF_AGE:       vmPush(stack, self.age); break;
      case OP.SELF_GLUCOSE:   vmPush(stack, self.glucose); break;
      case OP.SELF_O2:        vmPush(stack, self.o2); break;
      case OP.SELF_FATTY:     vmPush(stack, self.fattyAcid); break;
      case OP.SELF_AMINO:     vmPush(stack, self.aminoAcid); break;
      case OP.SELF_WASTE:     vmPush(stack, self.waste); break;
      case OP.SENSE_WALL_X:   vmPush(stack, sensors.wallX); break;
      case OP.SENSE_WALL_Y:   vmPush(stack, sensors.wallY); break;
      case OP.SENSE_HEAD_X:   vmPush(stack, sensors.headX); break;
      case OP.SENSE_HEAD_Y:   vmPush(stack, sensors.headY); break;
      case OP.SENSE_TEMP:     vmPush(stack, sensors.temp); break;
      case OP.SENSE_PHEROMONE: vmPush(stack, sensors.pheromone); break;
      case OP.EMIT:           out.emit += Math.max(0, vmPop(stack)); break;
      case OP.ADHERE:         out.adhere = true; break;
      case OP.REPAIR:         out.repair++; break;
      // SENSE_AMP is a passive marker; its only effect is to widen
      // the cell's sense range, computed once at birth in sim.ts.
      case OP.SENSE_AMP:      break;
      // POKE_BYTE: write to an arbitrary genome byte in place. (val, idx)
      // are popped; idx is taken mod L, value is masked to 8 bits.
      case OP.POKE_BYTE: {
        const idxRaw = vmPop(stack);
        const valRaw = vmPop(stack);
        const idx = (((idxRaw | 0) % L) + L) % L;
        genome[idx] = (valRaw | 0) & 0xff;
        break;
      }
      // SPLICE_DUP / SPLICE_DEL: pop (length, offset). Length capped to
      // avoid ridiculous payloads; offset taken mod L. Resizing happens
      // after runTick returns, so PC stays valid for the rest of this tick.
      case OP.SPLICE_DUP: {
        const lenRaw = vmPop(stack);
        const offRaw = vmPop(stack);
        out.spliceMode = 1;
        out.spliceOffset = (((offRaw | 0) % L) + L) % L;
        out.spliceLength = Math.max(0, Math.min(32, lenRaw | 0));
        break;
      }
      case OP.SPLICE_DEL: {
        const lenRaw = vmPop(stack);
        const offRaw = vmPop(stack);
        out.spliceMode = 2;
        out.spliceOffset = (((offRaw | 0) % L) + L) % L;
        out.spliceLength = Math.max(0, Math.min(32, lenRaw | 0));
        break;
      }

      case OP.THRUST: {
        const ay = vmPop(stack);
        const ax = vmPop(stack);
        out.thrustX += ax;
        out.thrustY += ay;
        break;
      }
      case OP.EXCRETE: {
        const idx = m6(genome[state.pc % L]); state.pc++;
        out.excrete[idx] += Math.max(0, vmPop(stack));
        break;
      }
      case OP.REPRODUCE: {
        // Pop parent's share of mass (0.1..0.9). Out of range -> symmetric.
        const f = vmPop(stack);
        out.reproduce = true;
        out.reproduceFraction = (f >= 0.1 && f <= 0.9) ? f : 0.5;
        break;
      }
      case OP.PREDATE:    out.predate    = true; break;
      case OP.ENGULF:     out.engulf     = true; break;
      case OP.INGEST:     { const idx = m6(genome[state.pc % L]); state.pc++; out.ingestMaterials[idx] = 1; break; }
      case OP.TURN:       out.turn      += vmPop(stack); break;
      case OP.HALT:
        return;

      default: break;
    }
  }
}

// Static analysis of a genome: which actions it can perform, which
// inputs it reads, whether it has any branching, plus a one-paragraph
// human-readable verdict. Pure walk over the bytes -- no execution,
// no per-tick cost. Used by the inspector to give a plain-English
// answer to "what does this cell actually do?".
export interface GenomeSummary {
  totalBytes: number;
  executableOps: number;
  unknownBytes: number;
  estAtpPerTick: number;
  hasJump: boolean;
  hasComparison: boolean;
  conditional: boolean;
  thrust: boolean;
  turn: boolean;
  ingestMaterials: number[];
  excreteMaterials: number[];
  reproduce: boolean;
  predate: boolean;
  engulf: boolean;
  emit: boolean;
  adhere: boolean;
  repair: boolean;
  selfModifies: boolean;
  sensors: string[];
  capabilities: string[];
  verdict: string;
}

export function summarizeGenome(
  genome: Uint8Array,
  materialNames?: ReadonlyArray<string>,
  opts?: { instrBudget?: number; atpPerInstr?: number },
): GenomeSummary {
  const ingestMaterials: number[] = [];
  const excreteMaterials: number[] = [];
  const sensors: string[] = [];
  const seenSensor = new Set<string>();
  let thrust = false, turn = false, reproduce = false;
  let predate = false, engulf = false, emit = false, adhere = false;
  let repair = false, selfModifies = false;
  let hasJump = false, hasCmp = false;
  let executableOps = 0, unknownBytes = 0;

  let i = 0;
  while (i < genome.length) {
    const op = genome[i];
    const operandLen = OPERANDS[op];
    if (NAME_BY_OP[op] === undefined) {
      unknownBytes++;
      i += 1;
      continue;
    }
    executableOps++;
    const operand = operandLen === 1 ? genome[(i + 1) % genome.length] : 0;
    switch (op) {
      case OP.THRUST:    thrust = true; break;
      case OP.TURN:      turn = true; break;
      case OP.REPRODUCE: reproduce = true; break;
      case OP.PREDATE:   predate = true; break;
      case OP.ENGULF:    engulf = true; break;
      case OP.EMIT:      emit = true; break;
      case OP.ADHERE:    adhere = true; break;
      case OP.REPAIR:    repair = true; break;
      case OP.POKE_BYTE:
      case OP.SPLICE_DUP:
      case OP.SPLICE_DEL: selfModifies = true; break;
      case OP.INGEST: {
        const mat = m6(operand);
        if (!ingestMaterials.includes(mat)) ingestMaterials.push(mat);
        break;
      }
      case OP.EXCRETE: {
        const mat = m6(operand);
        if (!excreteMaterials.includes(mat)) excreteMaterials.push(mat);
        break;
      }
      case OP.JZ: case OP.JNZ: hasJump = true; break;
      case OP.LT: case OP.GT: case OP.EQ:
      case OP.NOT: case OP.AND: case OP.OR:
        hasCmp = true; break;
      case OP.SENSE_GRAD_X: case OP.SENSE_GRAD_Y: case OP.SENSE_DENSITY:
      case OP.SENSE_LIGHT: case OP.SENSE_TEMP: case OP.SENSE_PHEROMONE:
      case OP.SENSE_WALL_X: case OP.SENSE_WALL_Y:
      case OP.SENSE_HEAD_X: case OP.SENSE_HEAD_Y:
      case OP.SENSE_CRE_DX: case OP.SENSE_CRE_DY:
      case OP.SENSE_CRE_DIST: case OP.SENSE_CRE_MASS:
      case OP.SELF_VX: case OP.SELF_VY: case OP.SELF_MASS:
      case OP.SELF_BIOMASS: case OP.SELF_AGE: case OP.SELF_ENERGY:
      case OP.SELF_GLUCOSE: case OP.SELF_O2: case OP.SELF_FATTY:
      case OP.SELF_AMINO: case OP.SELF_WASTE: case OP.SELF_RESERVE: {
        const name = NAME_BY_OP[op].toLowerCase();
        if (!seenSensor.has(name)) { seenSensor.add(name); sensors.push(name); }
        break;
      }
    }
    i += 1 + operandLen;
  }

  const conditional = hasJump && hasCmp;
  const matName = (idx: number) => materialNames ? materialNames[idx] : String(idx);
  const capabilities: string[] = [];
  if (thrust || turn) capabilities.push("moves");
  if (ingestMaterials.length > 0) {
    capabilities.push("eats " + ingestMaterials.map(matName).join("/"));
  }
  if (reproduce) capabilities.push(conditional ? "reproduces (gated)" : "reproduces (every tick)");
  if (predate || engulf) capabilities.push("preys on cells");
  if (emit) capabilities.push("emits pheromone");
  if (adhere) capabilities.push("forms colonies");
  if (repair) capabilities.push("repairs DNA");
  if (selfModifies) capabilities.push("self-modifies genome");
  if (excreteMaterials.length > 0) {
    capabilities.push("excretes " + excreteMaterials.map(matName).join("/"));
  }
  if (capabilities.length === 0) capabilities.push("inert (no actions)");

  const instrBudget = opts?.instrBudget ?? 32;
  const atpPerInstr = opts?.atpPerInstr ?? 0.005;
  const opsPerTick = Math.min(instrBudget, executableOps + unknownBytes);
  const estAtpPerTick = opsPerTick * atpPerInstr;

  // Bullet section: a Q/A line for each capability axis, in the same
  // shape a human would write up the cell after reading the disasm.
  const bullets: string[] = [];
  const gateNote = conditional ? "" : " (unconditional -- no JZ/JNZ + comparison gates it)";

  bullets.push("- Ingest food? " + (ingestMaterials.length > 0
    ? `Yes, opts in to ${ingestMaterials.map(matName).join(", ")}.${gateNote}`
    : "Never. No INGEST op is present."));

  bullets.push("- Reproduce? " + (reproduce
    ? `Yes.${gateNote}`
    : "Never. No REPRODUCE op is present."));

  const moveParts: string[] = [];
  if (thrust) moveParts.push("THRUST");
  if (turn) moveParts.push("TURN");
  bullets.push("- Thrust / steer? " + (moveParts.length > 0
    ? `Yes -- uses ${moveParts.join(" + ")}.${gateNote}`
    : "Never. No THRUST, no TURN. It drifts passively under gravity, drag, brownian, and wave forcing only."));

  const otherActs: string[] = [];
  if (excreteMaterials.length > 0) otherActs.push(`excretes ${excreteMaterials.map(matName).join("/")}`);
  if (emit) otherActs.push("emits pheromone");
  if (adhere) otherActs.push("adheres (forms colonies)");
  if (engulf) otherActs.push("engulfs prey");
  if (predate) otherActs.push("predates");
  if (repair) otherActs.push("spends ATP on DNA repair");
  if (selfModifies) otherActs.push("rewrites its own genome (POKE / SPLICE)");
  bullets.push("- Excrete / emit pheromone / adhere / engulf / predate? " + (otherActs.length > 0
    ? otherActs.join("; ") + "."
    : "None of the corresponding ops are present."));

  const anyAction = thrust || turn || reproduce || ingestMaterials.length > 0
    || predate || engulf || emit || adhere || excreteMaterials.length > 0;
  bullets.push("- React to anything it senses? " + (sensors.length === 0
    ? "No sensor reads at all."
    : !anyAction
    ? `Reads ${sensors.join(", ")}, but with no action ops those readings just pile onto the stack and get discarded when capacity is reached.`
    : !conditional
    ? `Reads ${sensors.join(", ")}, but with no JZ/JNZ + comparison the readings don't gate any decision -- actions fire reflexively.`
    : `Yes -- reads ${sensors.join(", ")}, and has JZ/JNZ + comparison gating its actions.`));

  // Net behavior: short verdict + likely fate in this environment.
  let netClass: string;
  if (!anyAction) netClass = "An inert blob.";
  else if (predate || engulf) netClass = "A predator.";
  else if (thrust && ingestMaterials.length > 0 && reproduce) netClass = "A complete loop: senses, swims, eats, divides.";
  else if (ingestMaterials.length > 0 && reproduce) netClass = "A passive eater that divides -- doesn't steer toward food.";
  else if (thrust && ingestMaterials.length > 0) netClass = "A forager: swims and eats, but never divides.";
  else if (ingestMaterials.length > 0) netClass = "A passive eater -- waits for food to drift in.";
  else if (thrust) netClass = "A wanderer -- swims around but never eats.";
  else if (reproduce) netClass = "Tries to divide but can't sustain itself (no eat path).";
  else netClass = "Has actions, but no eat path.";

  let fate: string;
  if (ingestMaterials.length === 0 && !predate && !engulf) {
    fate = `Pays the per-instruction ATP cost (~${opsPerTick} ops × ${atpPerInstr.toFixed(3)} = ~${estAtpPerTick.toFixed(2)} ATP/tick) plus baseline maintenance, takes in nothing, so biomass and reserves trickle down. Will autolyze once biomass falls below MIN_VIABLE_BIOMASS (0.5).`;
  } else if (!reproduce) {
    fate = `Can sustain itself if food is plentiful, but the lineage dies with this cell -- no REPRODUCE.`;
  } else if (!conditional) {
    fate = `Reflexive: REPRODUCE fires every tick, which means it tries to fission whenever it has the ATP, regardless of whether biomass is actually large enough to make a viable daughter. Lots of stillbirths.`;
  } else {
    fate = `Self-sustaining if food is available; gates make it reproduce only when conditions are met.`;
  }

  const lines: string[] = [];
  lines.push(`stats: bytes=${genome.length}  ops=${executableOps}  junk=${unknownBytes}  ~${estAtpPerTick.toFixed(2)} ATP/tick`);
  lines.push("");
  lines.push(...bullets);
  lines.push("");
  lines.push("Net behavior: " + netClass + " " + fate);

  return {
    totalBytes: genome.length, executableOps, unknownBytes,
    estAtpPerTick, hasJump, hasComparison: hasCmp, conditional,
    thrust, turn, ingestMaterials, excreteMaterials,
    reproduce, predate, engulf, emit, adhere, repair, selfModifies,
    sensors, capabilities,
    verdict: lines.join("\n"),
  };
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
// BOTH biomass and ATP clear minimum thresholds. The build-block cost
// of fission is paid in biomass (and other molecules); ATP is just the
// per-attempt tax. Checking biomass first saves wasted attempts when
// the cell hasn't accumulated enough to make a viable daughter.
//
//   sense_grad_x organic
//   sense_grad_y organic
//   thrust                 ; accelerate up the food gradient
//   ingest organic         ; opt in to organic particles (food)
//   ingest clay            ; opt in to clay (minerals for biosynth + fission)
//   self_biomass           ; push biomass pool
//   push8 14               ; minimum to afford 2x fission cost
//   gt                     ; biomass > 12 ?
//   self_energy            ; push ATP
//   push8 3                ; minimum ATP
//   gt                     ; ATP > 3 ?
//   and                    ; need both
//   jz +1                  ; if either fails, skip REPRODUCE
//   reproduce              ; try to fission
//   halt
// Sense range is encoded by SENSE_AMP bytes in the genome. Cost scales
// with sensing area, so range scales with sqrt(amp count): each amp
// contributes a constant area increment, but total radius grows
// sub-linearly. Empty genome -> SENSE_BASE; default genome (1 amp) -> 80.
export const SENSE_BASE = 40;
export const SENSE_PER_AMP = 40;
export function computeSenseRange(genome: Uint8Array): number {
  let amps = 0;
  for (let i = 0; i < genome.length; i++) if (genome[i] === OP.SENSE_AMP) amps++;
  return SENSE_BASE + SENSE_PER_AMP * Math.sqrt(amps);
}

export function makeDefaultGenome(): Uint8Array {
  return new Uint8Array([
    OP.SENSE_AMP,             // one sense amplifier -> 80px range
    OP.SENSE_GRAD_X, 3,
    OP.SENSE_GRAD_Y, 3,
    OP.THRUST,
    OP.INGEST, 3,
    OP.INGEST, 2,
    OP.SELF_BIOMASS,
    OP.PUSH8, 14,
    OP.GT,
    OP.SELF_ENERGY,
    OP.PUSH8, 3,
    OP.GT,
    OP.AND,
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

const P_POINT  = 0.003;
const P_INSERT = 0.0008;
const P_DELETE = 0.0008;
export const MAX_GENOME_BYTES = 256;

export function mutateGenome(
  genome: Uint8Array,
  rng: () => number = Math.random,
): Uint8Array {
  // Per-byte: roll DELETE first; if not deleted, optionally insert a
  // random byte just before it, then optionally point-mutate the byte
  // itself. A deleted byte short-circuits the rest of the slot, so
  // delete and insert never both fire on the same position.
  // Plus one trailing-insert chance so the genome can grow at the end.
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
