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
  THRUST_AMP:    0x68,   // passive: each copy boosts the cell's thrustAccel
  // Active biosynthesis gates: a product is only built this tick if its
  // SYNTH op was executed. Substrate + ATP cost still applies as before.
  // Without these, biosynthesize() ran unconditionally every tick and
  // newborns wasted ATP making chlorophyll/enzyme they didn't use.
  SYNTH_BIO:     0x69,
  SYNTH_AA:      0x6A,
  SYNTH_FA:      0x6B,
  SYNTH_ENZ:     0x6C,
  SYNTH_CHL:     0x6D,
  SYNTH_MRNA:    0x6E,   // build mRNA; their count multiplies biosynth rate

  // Generalized primitive sensors. The operand selects which "receptor
  // type" / which band to read -- analogous to how real chemoreceptors
  // each bind a specific molecule. Evolution rolls operand bytes;
  // useful ones get selected.
  SENSE_CHEMICAL:0x6F,   // <id>: id mod 7. 0-5 = material density at cell, 6 = pheromone.
  SENSE_EM:      0x70,   // <band>: band mod 1 currently = visible light intensity (forward-compat).
  SENSE_PRESSURE_X: 0x71, // horizontal mechanical force on cell (wave + current + contact)
  SENSE_PRESSURE_Y: 0x72, // vertical mechanical force + static depth pressure (gravity * depth)

  // Cell-recognition primitives. Returns information ABOUT a nearby
  // cell so the genome can decide what to do with it. SENSE_KIN
  // pushes the bit-overlap (0..8) between this cell's surface
  // fingerprint (top 8 chems by mass) and the nearest cell's --
  // higher = more chemically similar = more likely a relative.
  // SENSE_NEIGHBOR_HASH pushes a single byte hash of the nearest
  // cell's fingerprint, letting the genome recognize specific
  // signatures and not just kinship-by-overlap. Both return 0 when
  // no cell is in sense range.
  SENSE_KIN:           0x74,
  SENSE_NEIGHBOR_HASH: 0x75,

  // Generic catalyst synthesis. Operand picks which reaction the
  // catalyst boosts. Each catalyst k accumulates in its own pool;
  // the reaction's rate is multiplied by (1 + catalyst[k]/CAT_REF).
  // Maps:
  //   0 respirase  (aerobic respiration)
  //   1 fermentase (fermentation)
  //   2 lipase     (beta-oxidation of fatty acid)
  //   3 catabase   (catabolism of ingested material)
  SYNTH_CAT:     0x73,

  HALT:          0xFF,
} as const;

// Number of catalyst slots. Kept in genome.ts (not sim.ts) because
// the VM dispatch mods the operand by this -- it's part of the
// genome ABI. Catalyst slot k IS reaction k from sim.ts's generated
// reaction table; bumping this and the table size together extends
// the reaction space the genome can address.
export const CATALYST_COUNT = 256;
// Alias for code that reads more naturally with "reaction" wording.
export const N_REACTIONS = CATALYST_COUNT;
// Number of distinct chemical species the cell pool tracks (8 named
// + 56 generic, defined in sim.ts). Exposed here because the VM mods
// SENSE_CHEMICAL's operand by it -- part of the genome ABI.
export const CHEMICAL_COUNT = 96;

// Single source of truth for operand widths. Every code path that
// walks a genome MUST consult this table -- duplicating an op list
// in a separate walker introduces drift bugs where the VM and the
// describer (or the filter, etc.) disagree about op alignment.
// Exported so main.ts (describer, inspector) can use it directly.
export const OPERANDS = new Uint8Array(256);
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
OPERANDS[OP.SENSE_CHEMICAL] = 1;
OPERANDS[OP.SENSE_EM] = 1;
OPERANDS[OP.SYNTH_CAT] = 1;

// Walk the genome and call `visit(op, pc, operand)` for each
// executable op position. `operand` is `undefined` if the op takes
// no operand. Centralizes the iteration pattern that used to be
// repeated (with subtle differences) in viableGenome / disassemble /
// summarizeGenome / describeGenomeProse / observedOpBias.
export function walkGenome(
  genome: Uint8Array,
  visit: (op: number, pc: number, operand: number | undefined) => void | "break",
): void {
  let i = 0;
  while (i < genome.length) {
    const op = genome[i];
    const operandLen = OPERANDS[op];
    const operand = operandLen === 1 && i + 1 < genome.length ? genome[i + 1] : undefined;
    if (visit(op, i, operand) === "break") return;
    i += 1 + operandLen;
  }
}


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
  // Three EM bands with different depth-attenuation profiles, sampled
  // by SENSE_EM <band>. Band 0 = visible (matches `light`), band 1 =
  // long-penetrating (attenuates 3x slower with depth), band 2 = a
  // depth-invariant surface signal (just the sun's intensity).
  // Genome can derive depth from band ratios (band1/band0 grows with
  // depth), get a depth-invariant "is the sun out" from band 2, or
  // gate photosynth on visible specifically.
  emBands: Float32Array;
  // Mechanical force vector on the cell (waves + current + contact +
  // gravity-buoyancy net). pressureY also includes a static-depth
  // component so deep cells see a steady-state signal even when
  // neutrally buoyant.
  pressureX: number;
  pressureY: number;
  // Internal chemical concentration, indexed by chemical id. SENSE_CHEMICAL
  // <id> mod CHEMICAL_COUNT reads this. Slots 0..7 are the named chemicals
  // (o2, co2, glucose, aa, fa, min, biomass, adp); 8..63 are abstract
  // generics built by reactions. This is the cell's own pool, not the
  // environment -- so feedback loops on internal state become evolvable.
  chemConc: Float32Array;
  // Surface-recognition values for the nearest in-range cell, sampled
  // each tick. kinOverlap is 0..8 (bit overlap of top-8 chem
  // fingerprints); neighborHash is a 0..255 byte hash of the
  // neighbor's fingerprint. Both are 0 when nothing is in range.
  kinOverlap: number;
  neighborHash: number;
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
  // Bit flags for biosynthesis gates this tick. Bit positions:
  //   0 biomass, 1 aa, 2 fa, 3 enzyme, 4 chlorophyll.
  // updateCreatures() runs biosynthesize() for product k iff the
  // corresponding bit is set. This makes the cell pay attention to
  // what it actually wants to build instead of always trying every
  // product (and wasting ATP on chlorophyll it never uses).
  synthMask: number;
  // Bit flags for generic catalyst synthesis this tick. Bit k is set
  // by SYNTH_CAT with operand mod N_CATALYSTS == k. The
  // sim runs catalyst synthesis for slot k iff bit k is set.
  catSynthMask: number;
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
    reproduce: false, reproduceFraction: 0.4,
    predate: false, engulf: false, emit: 0, adhere: false,
    ingestMaterials: new Uint8Array(6),
    repair: 0,
    synthMask: 0,
    catSynthMask: 0,
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
  // Optional per-position execution counter. If provided, each PC the
  // VM hits this tick increments execCounts[pc]. Used by the species-
  // level analysis to discover which positions of a genome are
  // actually hot vs. dead code -- and to spot convergent patterns
  // across independent lineages.
  execCounts?: Uint32Array,
): void {
  out.thrustX = 0;
  out.thrustY = 0;
  out.turn = 0;
  out.excrete.fill(0);
  out.reproduce = false;
  // Parent keeps 40%, child gets 60%. Skewed in favor of the newborn
  // because the parent has had time to build reserves and can rebuild
  // from a lower base, while the newborn faces an immediate
  // foraging-or-die window.
  out.reproduceFraction = 0.4;
  out.predate = false;
  out.engulf = false;
  out.emit = 0;
  out.adhere = false;
  out.ingestMaterials.fill(0);
  out.repair = 0;
  out.synthMask = 0;
  out.catSynthMask = 0;
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
    if (execCounts && state.pc < execCounts.length) execCounts[state.pc]++;
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
      case OP.SENSE_CHEMICAL: {
        // operand mod CHEMICAL_COUNT. Returns the cell's internal
        // concentration of that chemical id (slots 0..7 = named,
        // 8..63 = abstract generics built by reactions). External
        // particle density is sensed via SENSE_GRAD_X/Y instead;
        // pheromone has its own dedicated op.
        const id = genome[state.pc % L] % CHEMICAL_COUNT;
        state.pc++;
        vmPush(stack, sensors.chemConc[id]);
        break;
      }
      case OP.SENSE_EM: {
        // Operand picks a band; emBands has 3 distinct attenuation
        // profiles so the genome can read multiple signals from one
        // op. Cells with different operand bytes will read different
        // values, letting evolution discover what's useful.
        const band = genome[state.pc % L] % sensors.emBands.length;
        state.pc++;
        vmPush(stack, sensors.emBands[band]);
        break;
      }
      case OP.SENSE_PRESSURE_X: vmPush(stack, sensors.pressureX); break;
      case OP.SENSE_PRESSURE_Y: vmPush(stack, sensors.pressureY); break;
      case OP.SENSE_KIN:           vmPush(stack, sensors.kinOverlap); break;
      case OP.SENSE_NEIGHBOR_HASH: vmPush(stack, sensors.neighborHash); break;
      case OP.EMIT:           out.emit += Math.max(0, vmPop(stack)); break;
      case OP.ADHERE:         out.adhere = true; break;
      case OP.REPAIR:         out.repair++; break;
      case OP.SYNTH_BIO:      out.synthMask |= 1 << 0; break;
      case OP.SYNTH_AA:       out.synthMask |= 1 << 1; break;
      case OP.SYNTH_FA:       out.synthMask |= 1 << 2; break;
      case OP.SYNTH_ENZ:      out.synthMask |= 1 << 3; break;
      case OP.SYNTH_CHL:      out.synthMask |= 1 << 4; break;
      case OP.SYNTH_MRNA:     out.synthMask |= 1 << 5; break;
      case OP.SYNTH_CAT: {
        // Operand picks which catalyst slot to build. Mod to the
        // catalyst count keeps every operand byte targeting a real
        // slot (no operand values waste). Sim keeps the catalyst
        // table; the bit-mask handshake just tells it which to run.
        const slot = genome[state.pc % L] % CATALYST_COUNT;
        state.pc++;
        out.catSynthMask |= 1 << slot;
        break;
      }
      // SENSE_AMP is a passive marker; its only effect is to widen
      // the cell's sense range, computed once at birth in sim.ts.
      case OP.SENSE_AMP:      break;
      // THRUST_AMP is a passive trait marker; sim.ts derives
      // c.thrustAccel from byte counts at birth (and on somatic
      // mutation).
      case OP.THRUST_AMP:     break;
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
      // HALT (0xFF) is retired -- it was a programmer's escape hatch
      // with no biological analog. Old genomes carrying the byte now
      // fall through to the default branch (NOP), so the byte stays
      // inert during a tick instead of cutting it short. The OP
      // constant is kept for the disassembler.
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
  // Metabolism / chemistry axis. Populated by walking SYNTH_* ops
  // and trophic ops. Used for the new "Metabolism" bullet + top-line
  // summary + warnings section.
  synthBio: boolean;
  synthAA: boolean;
  synthFA: boolean;
  synthEnz: boolean;
  synthChl: boolean;
  synthRibo: boolean;
  // Catalyst slots SYNTH_CAT will populate if it fires at the listed
  // PCs. Best-effort static analysis: operand byte mod CATALYST_COUNT.
  // Doesn't catch runtime PC drift; gives an honest "likely portfolio".
  catalystSlots: number[];
  metabolism: string;       // one-line classification
  warnings: string[];       // structural issues that doom the lineage
  oneLine: string;          // top-of-summary one-liner
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
  let synthBio = false, synthAA = false, synthFA = false;
  let synthEnz = false, synthChl = false, synthRibo = false;
  const catalystSlots: number[] = [];

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
      case OP.SYNTH_BIO:  synthBio = true; break;
      case OP.SYNTH_AA:   synthAA = true; break;
      case OP.SYNTH_FA:   synthFA = true; break;
      case OP.SYNTH_ENZ:  synthEnz = true; break;
      case OP.SYNTH_CHL:  synthChl = true; break;
      case OP.SYNTH_MRNA: synthRibo = true; break;
      case OP.SYNTH_CAT: {
        const slot = operand % CATALYST_COUNT;
        if (!catalystSlots.includes(slot)) catalystSlots.push(slot);
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
  else if (synthChl && synthBio && reproduce) netClass = "A photoautotroph that builds biomass from light and divides.";
  else if (predate || engulf) netClass = "A predator.";
  else if (thrust && ingestMaterials.length > 0 && reproduce) netClass = "A complete loop: senses, swims, eats, divides.";
  else if (ingestMaterials.length > 0 && reproduce) netClass = "A passive eater that divides -- doesn't steer toward food.";
  else if (thrust && ingestMaterials.length > 0) netClass = "A forager: swims and eats, but never divides.";
  else if (ingestMaterials.length > 0) netClass = "A passive eater -- waits for food to drift in.";
  else if (thrust) netClass = "A wanderer -- swims around but never eats.";
  else if (reproduce) netClass = "Tries to divide but can't sustain itself (no eat path).";
  else netClass = "Has actions, but no eat path.";

  // Metabolism axis. Based on which trophic + synth ops are present;
  // doesn't simulate runtime so a SYNTH_* op buried after a never-
  // taken branch still "counts" -- intentional, we want to surface
  // anything the genome could in principle do.
  const isHetero = ingestMaterials.length > 0 || predate || engulf;
  let metabolism: string;
  if (synthChl && isHetero) {
    metabolism = "predatory autotroph (photosynth + extracts from prey)";
  } else if (synthChl) {
    metabolism = synthAA && synthFA
      ? "complete photoautotroph"
      : "incomplete photoautotroph (missing aa/fa synthesis)";
  } else if ((predate || engulf) && ingestMaterials.length === 0) {
    metabolism = "obligate predator";
  } else if (predate || engulf) {
    metabolism = "predator-grazer hybrid";
  } else if (ingestMaterials.length > 0) {
    metabolism = synthEnz
      ? "heterotroph (digests reserves into molecules)"
      : "molecule-grazer (no SYNTH_ENZ -- can only consume tagged corpse particles, not raw substrate)";
  } else {
    metabolism = "no trophic input -- can't acquire mass";
  }
  bullets.push("- Metabolism: " + metabolism + ".");

  const builds: string[] = [];
  if (synthBio) builds.push("biomass");
  if (synthAA) builds.push("amino acid");
  if (synthFA) builds.push("fatty acid");
  if (synthEnz) builds.push("enzyme");
  if (synthChl) builds.push("chlorophyll");
  if (synthRibo) builds.push("mRNA");
  bullets.push("- Builds: " + (builds.length > 0 ? builds.join(", ") : "nothing (no SYNTH_* ops present)") + ".");

  bullets.push("- Catalysts: " + (catalystSlots.length > 0
    ? `SYNTH_CAT targets slot${catalystSlots.length === 1 ? "" : "s"} ${catalystSlots.slice(0, 8).sort((a, b) => a - b).join(", ")}${catalystSlots.length > 8 ? `, +${catalystSlots.length - 8} more` : ""}.`
    : "no SYNTH_CAT; inherits whatever the parent split provided."));

  // Warnings: structural issues that make the lineage doomed under
  // the current biology. Quiet (no warnings line) if the genome
  // checks out.
  const warnings: string[] = [];
  if (synthBio && !synthRibo) {
    warnings.push("SYNTH_BIO without SYNTH_MRNA -- mRNA decay and biosynth stalls.");
  }
  if (synthChl && !isHetero && !synthAA) {
    warnings.push("pure autotroph without SYNTH_AA -- aa supply will run out.");
  }
  if (synthChl && !isHetero && !synthFA) {
    warnings.push("pure autotroph without SYNTH_FA -- fa supply will run out.");
  }
  if (isHetero && !synthEnz) {
    warnings.push("heterotroph without SYNTH_ENZ -- reserves don't count as fuel (MIN_USABLE_ENZYME).");
  }
  if (!synthAA && !predate && !engulf) {
    warnings.push("no amino-acid source (SYNTH_AA / PREDATE / ENGULF) -- can't sustain growth ops.");
  }
  if (warnings.length > 0) {
    bullets.push("- Warnings: " + warnings.join(" "));
  }

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

  // One-line gist at the top -- captures the cell at a glance for
  // someone scrolling through many. Composition: metabolism class +
  // the dominant behavioral verb.
  const verb = !anyAction
    ? "inert"
    : predate || engulf
    ? "preys"
    : thrust && ingestMaterials.length > 0
    ? "swims and eats"
    : ingestMaterials.length > 0
    ? "grazes passively"
    : thrust
    ? "wanders"
    : "stationary";
  const oneLine = `${metabolism}; ${verb}${reproduce ? "; divides" : "; sterile"}.`;

  const lines: string[] = [];
  lines.push(`stats: bytes=${genome.length}  ops=${executableOps}  junk=${unknownBytes}  ~${estAtpPerTick.toFixed(2)} ATP/tick`);
  lines.push("");
  lines.push("Summary: " + oneLine);
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
    synthBio, synthAA, synthFA, synthEnz, synthChl, synthRibo,
    catalystSlots, metabolism, warnings, oneLine,
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

// Thrust acceleration scales with THRUST_AMP byte count. Same sqrt
// curve as sense range: linear-in-count cost (one byte each), sqrt
// payoff so doubling thrust costs 4x DNA.
export const THRUST_BASE = 70;
export const THRUST_PER_AMP = 25;
export function computeThrustAccel(genome: Uint8Array): number {
  let amps = 0;
  for (let i = 0; i < genome.length; i++) if (genome[i] === OP.THRUST_AMP) amps++;
  return THRUST_BASE + THRUST_PER_AMP * Math.sqrt(amps);
}

// Viability predicate. A genome is "viable enough to bother
// spawning" if it has at least one metabolism op (food intake or
// photosynthesis) and at least one reproduction op. Cells failing
// either are dead-end lineages: a no-metabolism cell starves in
// ~30s; a no-REPRODUCE cell can't perpetuate. Filtering them out at
// spawn time saves us from watching long sterile lives.

// Static synthMask derived from genome op set. Used for engulfed
// cells whose VM doesn't run -- their biosynthesis intent is locked
// to whichever SYNTH_* ops happen to exist in their genome. Bits:
//   0 BIO, 1 AA, 2 FA, 3 ENZ, 4 CHL, 5 RIBO.
export function genomeSynthMask(genome: Uint8Array): number {
  let mask = 0;
  walkGenome(genome, (op) => {
    if (op === OP.SYNTH_BIO) mask |= 1 << 0;
    else if (op === OP.SYNTH_AA) mask |= 1 << 1;
    else if (op === OP.SYNTH_FA) mask |= 1 << 2;
    else if (op === OP.SYNTH_ENZ) mask |= 1 << 3;
    else if (op === OP.SYNTH_CHL) mask |= 1 << 4;
    else if (op === OP.SYNTH_MRNA) mask |= 1 << 5;
  });
  return mask;
}

// Set of every SENSE_* / SELF_* op the VM exposes. A genome with no
// member of this set has no way to read state and can only emit
// constant-conditioned behavior -- useless. Used by viableGenome
// below; kept here so adding a new sensor op only requires touching
// the OP table + this set.
const SENSE_OPS: ReadonlySet<number> = new Set([
  OP.SENSE_GRAD_X, OP.SENSE_GRAD_Y, OP.SENSE_DENSITY,
  OP.SELF_ENERGY, OP.SELF_RESERVE, OP.SELF_VX, OP.SELF_VY,
  OP.SENSE_CRE_DX, OP.SENSE_CRE_DY, OP.SENSE_CRE_DIST, OP.SENSE_CRE_MASS,
  OP.SELF_MASS, OP.SENSE_LIGHT, OP.SELF_BIOMASS, OP.SELF_AGE,
  OP.SELF_GLUCOSE, OP.SELF_O2, OP.SELF_FATTY, OP.SELF_AMINO, OP.SELF_WASTE,
  OP.SENSE_WALL_X, OP.SENSE_WALL_Y, OP.SENSE_HEAD_X, OP.SENSE_HEAD_Y,
  OP.SENSE_TEMP, OP.SENSE_PHEROMONE,
  OP.SENSE_CHEMICAL, OP.SENSE_EM, OP.SENSE_PRESSURE_X, OP.SENSE_PRESSURE_Y,
  OP.SENSE_KIN, OP.SENSE_NEIGHBOR_HASH,
]);

// Minimum viable cell after all the chemistry restoration.  Branches
// by trophic mode -- photoautotrophs need to make their own building
// blocks; heterotrophs need to digest what they catch.  SYNTH_CAT
// is no longer required (the named pathways suffice without it).
//
//  Universal:
//    - hasMass:      INGEST/PREDATE/ENGULF (heterotroph) or
//                    SYNTH_CHL (photoautotroph; chl is the mandatory
//                    multiplier on photosynth).
//    - hasReproduce: REPRODUCE.
//    - hasBio:       SYNTH_BIO -- builds biomass; without it the cell
//                    autolyzes from maintenance decay.
//    - hasMrna:      SYNTH_MRNA -- mRNA are mandatory on every
//                    biosynth reaction.
//    - hasSense:     any SENSE_* / SELF_* op -- a cell that can't
//                    read state can only emit constant behavior.
//  Heterotroph (INGEST/PREDATE/ENGULF present):
//    - hasEnz:       SYNTH_ENZ -- enzymes are mandatory on catabolize;
//                    without them the cell stomachs food but can't
//                    actually digest it into molecules.
//  Photoautotroph-only (SYNTH_CHL, no INGEST/PREDATE/ENGULF):
//    - hasAA + hasFA: cell makes its own building blocks from
//                    photosynth glucose; without these SYNTH_BIO
//                    starves once the yolk runs out.
export function viableGenome(genome: Uint8Array): boolean {
  let hasIngest = false, hasPredate = false, hasEngulf = false, hasChl = false;
  let hasReproduce = false;
  let hasBio = false, hasMrna = false;
  let hasAA = false, hasFA = false, hasEnz = false;
  let hasSense = false;
  walkGenome(genome, (op) => {
    if (op === OP.INGEST) hasIngest = true;
    else if (op === OP.PREDATE) hasPredate = true;
    else if (op === OP.ENGULF) hasEngulf = true;
    else if (op === OP.SYNTH_CHL) hasChl = true;
    else if (op === OP.REPRODUCE) hasReproduce = true;
    else if (op === OP.SYNTH_BIO) hasBio = true;
    else if (op === OP.SYNTH_MRNA) hasMrna = true;
    else if (op === OP.SYNTH_AA) hasAA = true;
    else if (op === OP.SYNTH_FA) hasFA = true;
    else if (op === OP.SYNTH_ENZ) hasEnz = true;
    if (!hasSense && SENSE_OPS.has(op)) hasSense = true;
  });
  const isHeterotroph = hasIngest || hasPredate || hasEngulf;
  const hasMass = isHeterotroph || hasChl;
  if (!hasMass || !hasReproduce || !hasBio || !hasMrna || !hasSense) return false;
  // Heterotrophs need digestive enzymes to convert reserves -> molecules.
  if (isHeterotroph && !hasEnz) return false;
  // Pure photoautotrophs need their own building-block factory.
  // Note: this branch is bypassed for chlorophyll carriers that ALSO
  // have any heterotroph op (PREDATE / ENGULF / INGEST), since those
  // ops can supply fa/aa from prey or seeded particles without an
  // internal synthesis pathway. The condition is `!isHeterotroph`
  // exactly so the hybrid case (chl + predate) skips the autotroph
  // synth requirement -- audit suggestion #4.
  if (hasChl && !isHeterotroph && (!hasAA || !hasFA)) return false;
  // Amino-acid acquisition path. Required so that any growth op that
  // costs amino acid (planned: per-op aa cost on SYNTH_*/REPRODUCE/
  // splice) has a viable supply. Sources:
  //   - SYNTH_AA: internal synthesis from non-aa precursors (exempt
  //     from the per-op aa cost itself; it's the producer).
  //   - PREDATE/ENGULF: extract the prey's free aa directly.
  // INGEST is NOT counted: seeded particles carry only generic
  // chemistry, not named molecules like aminoAcid. A pure-INGEST
  // lineage that doesn't also synth or predate has no path to aa
  // and would starve under the per-op cost rule.
  // None of these sources go through the mrna (which itself
  // requires aa to synth under the cost rule), so there's no
  // chicken-and-egg lock -- audit suggestion #2.
  const hasAaSource = hasAA || hasPredate || hasEngulf;
  if (!hasAaSource) return false;
  return true;
}

// Sample a random genome size in [12, 100] with a gradual bias toward
// smaller. Floor raised to 12 to match the new viability floor:
// 5 universal required ops + 2 trophic-branch ops (e.g. SYNTH_ENZ for
// heterotrophs; SYNTH_AA + SYNTH_FA for autotrophs) + operand bytes.
// Smaller genomes always fail and waste reroll budget.
function randomGenomeSize(rng: () => number): number {
  const u = rng();
  // Triangular falloff on [12, 100]; clamping handles the math.
  const k = Math.floor((201 - Math.sqrt(Math.max(0, 38025 - 38024 * u))) / 2) + 1;
  return Math.max(12, Math.min(100, k));
}

// Generate a random viable genome. Size is sampled from the triangular
// distribution above; each byte is drawn from the same OP/noop bias as
// mutations (~2/3 chance of an executable op). The result is then
// checked for viability (metabolism + reproduce); nonviable rolls are
// rejected and re-rolled, with a hard cap so we can never spin
// forever. After MAX_REROLLS, we fall back to makeDefaultGenome().
const MAX_REROLLS = 64;
export function makeRandomViableGenome(rng: () => number = Math.random): Uint8Array {
  for (let attempt = 0; attempt < MAX_REROLLS; attempt++) {
    const size = randomGenomeSize(rng);
    const bytes = new Uint8Array(size);
    // Each founder rolls a fresh op-bias in [0.5, 0.95] -- some land
    // streamlined (5% noop, bacterium-like), some carry significant
    // junk (~50% noop). The bias persists in the lineage because
    // mutations use the parent's observed bias.
    const opBias = randFounderOpBias(rng);
    for (let i = 0; i < size; i++) bytes[i] = randSeedByte(rng, opBias);
    if (viableGenome(bytes)) return bytes;
  }
  return makeDefaultGenome();
}

export function makeDefaultGenome(): Uint8Array {
  return new Uint8Array([
    OP.SENSE_AMP,             // one sense amplifier -> 80px range
    OP.THRUST_AMP,            // one thrust amplifier -> 95 px/s^2
    // Phase D: SENSOR_CHEMS layout puts biopolymer (the bulk food) at
    // operand 1, minerals at operand 0. Default heterotroph chases
    // biopolymer and ingests both.
    OP.SENSE_GRAD_X, 1,
    OP.SENSE_GRAD_Y, 1,
    OP.THRUST,
    OP.INGEST, 1,
    OP.INGEST, 0,
    // Biosynthesis is now genome-gated. The starter cell is a
    // heterotroph: it intends to digest ingested food into building
    // blocks (enzyme + catabolize), then builds biomass directly
    // from the catabolized aa + fa. Doesn't make chlorophyll.
    OP.SYNTH_ENZ,      // mandatory for catabolize to fire (gates digestion)
    OP.SYNTH_BIO,
    // Ribosomes mandatory on every biosynth reaction's rate.
    OP.SYNTH_MRNA,
    // Generic catalyst synthesis. Optional now -- evolution can tune
    // which reaction slot benefits. Operand picks one of 256.
    OP.SYNTH_CAT, 0,
    // Keep the genome stable as the cell ages. Costs 0.5 ATP per
    // execution and refreshes a 30-tick window during which somatic
    // mutation is suppressed.
    OP.REPAIR,
    // Reproduction gate: only fission when well-stocked. Higher
    // thresholds let the parent stockpile and pass a meaningful
    // endowment to the child.
    OP.SELF_BIOMASS,
    OP.PUSH8, 30,
    OP.GT,
    OP.SELF_ENERGY,
    OP.PUSH8, 15,
    OP.GT,
    OP.AND,
    OP.JZ, 1,
    OP.REPRODUCE,
  ]);
}

export function genomeMaterialCost(genome: Uint8Array, massPerByte: number): Float32Array {
  const cost = new Float32Array(6);
  for (let i = 0; i < genome.length; i++) {
    cost[genome[i] % 6] += massPerByte;
  }
  return cost;
}

// Mutation random byte generator. We want the ratio of noop bytes
// to executable ops in mutated bytes to be roughly 1:2 -- i.e. ~2/3
// of newly introduced bytes should decode to a real op. Without
// biasing, a uniform byte has ~73% chance of landing on an unused
// value and becoming a noop. Pre-compute the partition once.
const OP_BYTES: number[] = (() => {
  const seen = new Set<number>();
  for (const v of Object.values(OP)) seen.add(v as number);
  return Array.from(seen).sort((a, b) => a - b);
})();
const NOOP_BYTES: number[] = (() => {
  const seen = new Set<number>(OP_BYTES);
  const out: number[] = [];
  for (let i = 0; i < 256; i++) if (!seen.has(i)) out.push(i);
  return out;
})();
// Default OP-vs-noop bias used when a caller doesn't supply one. A
// genome's *observed* op fraction is what propagates the lineage's
// junk-tolerance through descent: mutations use the parent genome's
// own ratio, so streamlined lineages stay streamlined and junky ones
// keep adding junk. This default is only the bootstrap value.
const OP_BYTE_BIAS = 2 / 3;
const OP_BYTE_SET: Set<number> = new Set(OP_BYTES);

// Fraction of bytes in the genome that *actually execute* as a real
// op. Counts each op-position byte once; operand bytes don't count
// toward the op fraction (they're data, not code). Empty genomes
// fall back to the default bias.
export function observedOpBias(genome: Uint8Array): number {
  if (genome.length === 0) return OP_BYTE_BIAS;
  let opCount = 0;
  walkGenome(genome, (op) => {
    if (OP_BYTE_SET.has(op)) opCount++;
  });
  return opCount / genome.length;
}

function randMutByte(rng: () => number, opBias: number = OP_BYTE_BIAS): number {
  if (rng() < opBias) return OP_BYTES[Math.floor(rng() * OP_BYTES.length)];
  return NOOP_BYTES[Math.floor(rng() * NOOP_BYTES.length)];
}

// Seed-time byte distribution: same OP/noop bias as mutations, but
// the OP pool is weighted toward ops a thriving cell typically wants.
// A random founder is more likely to roll INGEST + REPRODUCE +
// SYNTH_BIO + a food sensor than the truly uniform distribution
// would produce, so we waste less time on viable-but-doomed
// "barely passes the filter" founders. Other ops still appear at
// their base weight; nothing is forbidden.
const SEED_OP_WEIGHT: Record<number, number> = {
  [OP.INGEST]:        3,
  [OP.REPRODUCE]:     3,
  [OP.SYNTH_BIO]:     3,
  [OP.SYNTH_MRNA]:    3, // mandatory for biosynthesis under strict mrna model
  [OP.SYNTH_ENZ]:     3, // mandatory for heterotroph digestion (catabolize gates on enz)
  [OP.SYNTH_AA]:      3, // mandatory for photoautotrophs (no INGEST -> no aa from food)
  [OP.SYNTH_FA]:      3, // mandatory for photoautotrophs
  [OP.THRUST]:        2,
  [OP.SENSE_GRAD_X]:  2,
  [OP.SENSE_GRAD_Y]:  2,
  [OP.REPAIR]:        2,
  [OP.SELF_BIOMASS]:  1.5,
  [OP.SELF_ENERGY]:   1.5,
  [OP.GT]:            1.5,
  [OP.JZ]:            1.5,
  [OP.PUSH8]:         1.5,
  // Primitive sensors get a modest weight so founders sample them
  // without crowding out the food-loop ops.
  [OP.SENSE_CHEMICAL]: 1.5,
  [OP.SENSE_EM]:       1.5,
  [OP.SENSE_PRESSURE_X]: 1.5,
  [OP.SENSE_PRESSURE_Y]: 1.5,
  [OP.SENSE_KIN]:           1.5,
  [OP.SENSE_NEIGHBOR_HASH]: 1,
  [OP.SYNTH_CAT]:        1.5, // optional now -- evolutionary potential, not a viability gate
};
const SEED_OP_POOL: number[] = (() => {
  const pool: number[] = [];
  for (const op of OP_BYTES) {
    const w = SEED_OP_WEIGHT[op] ?? 1;
    // Integer weight: emit each op `Math.round(w * 2)` times so 1.5
    // gives 3 copies vs base 2, etc. Resolution good enough; the bias
    // is supposed to be "light" anyway.
    const n = Math.max(1, Math.round(w * 2));
    for (let i = 0; i < n; i++) pool.push(op);
  }
  return pool;
})();
function randSeedByte(rng: () => number, opBias: number): number {
  if (rng() < opBias) return SEED_OP_POOL[Math.floor(rng() * SEED_OP_POOL.length)];
  return NOOP_BYTES[Math.floor(rng() * NOOP_BYTES.length)];
}

// Founder op-bias range. Each new founder rolls a uniform value in
// this interval; that becomes the genome's OP-vs-noop split for its
// initial composition. Range covers tightly-packed bacteria-like
// (0.95 = 5% noop) through moderately junky (0.5 = 50% noop). Within
// the OP fraction, SEED_OP_POOL weights core useful ops higher; the
// bias only controls the OP-vs-noop split, not which op gets picked.
const FOUNDER_OP_BIAS_MIN = 0.50;
const FOUNDER_OP_BIAS_MAX = 0.95;
function randFounderOpBias(rng: () => number): number {
  return FOUNDER_OP_BIAS_MIN + rng() * (FOUNDER_OP_BIAS_MAX - FOUNDER_OP_BIAS_MIN);
}

// Per-byte mutation rates at fission. Halved from the previous values
// (0.003 / 0.0010) because the old rates produced ~7% of children with
// a real mutation per fission and the 2/3 op-bias meant most of those
// broke a working opcode. Mutation-load was killing newborn lineages
// faster than they could establish.
const P_POINT  = 0.0015;
const P_INSERT = 0.0005;
// Deletions are uniquely lossy in our genome: one deleted byte at the
// wrong offset can remove REPRODUCE or break a gate, sterilizing the
// lineage. Without functional redundancy or reading frames there's
// nothing to absorb the loss -- bias against deletion at the mutation
// level instead.
const P_DELETE = 0.0003;
export const MAX_GENOME_BYTES = 256;

export function mutateGenome(
  genome: Uint8Array,
  rng: () => number = Math.random,
): Uint8Array {
  // New bytes (inserts + point-mutation replacements) are drawn from
  // the *parent's* observed op-bias. A lineage that's 30% noop keeps
  // generating ~30% noop on mutation; a tight bacterium stays tight.
  // The lineage's "junk tolerance" is heritable through descent.
  const opBias = observedOpBias(genome);
  // Per-byte: roll DELETE first; if not deleted, optionally insert a
  // random byte just before it, then optionally point-mutate the byte
  // itself. A deleted byte short-circuits the rest of the slot, so
  // delete and insert never both fire on the same position.
  // Plus one trailing-insert chance so the genome can grow at the end.
  const out: number[] = [];
  for (let i = 0; i < genome.length; i++) {
    if (rng() < P_DELETE) continue;
    if (rng() < P_INSERT && out.length < MAX_GENOME_BYTES) {
      out.push(randMutByte(rng, opBias));
    }
    let b = genome[i];
    if (rng() < P_POINT) b = randMutByte(rng, opBias);
    if (out.length < MAX_GENOME_BYTES) out.push(b);
  }
  if (rng() < P_INSERT && out.length < MAX_GENOME_BYTES) {
    out.push(randMutByte(rng, opBias));
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
  // Somatic edits use the cell's own observed op-bias too, so an
  // aging cell drifts in a way consistent with its own composition.
  const opBias = observedOpBias(genome);
  const r = rng();
  if (r < 0.7) {
    const idx = Math.floor(rng() * genome.length);
    const out = new Uint8Array(genome);
    out[idx] = randMutByte(rng, opBias);
    return out;
  }
  if (r < 0.85 && genome.length < MAX_GENOME_BYTES) {
    const idx = Math.floor(rng() * (genome.length + 1));
    const out = new Uint8Array(genome.length + 1);
    out.set(genome.subarray(0, idx), 0);
    out[idx] = randMutByte(rng, opBias);
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
