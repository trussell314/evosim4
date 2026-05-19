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

  // K-5 retired: 0x40 SENSE_GRAD_X, 0x41 SENSE_GRAD_Y, 0x42 SENSE_DENSITY,
  // 0x45 SENSE_VX, 0x46 SENSE_VY, 0x47..0x4A SENSE_CRE_*, 0x4C SENSE_LIGHT,
  // 0x5A..0x5D SENSE_WALL_*/HEAD_*, 0x5F SENSE_TEMP, 0x60 EMIT,
  // 0x61 SENSE_PHEROMONE, 0x62 ADHERE, 0x63 REPAIR, 0x70 SENSE_EM,
  // 0x71/0x72 SENSE_PRESSURE_X/Y, 0x74 SENSE_KIN, 0x75 SENSE_NEIGHBOR_HASH.
  // All of those readings are now reachable via SENSE_CHEMICAL <id> on
  // an activated_* chem (K-3 activation pass). Bonding + DNA repair are
  // chemistry-mediated (CHEM_BOND, CHEM_REPAIR pools). The bytes
  // decode to NOP so old genomes degrade gracefully (save-compat is
  // explicitly not required per the overhaul brief).
  SELF_ENERGY:   0x43,
  SELF_MASS:     0x4B,
  SELF_MEMBRANE: 0x4D,    // own structural reserve (replaces SELF_BIOMASS)

  THRUST:        0x50,
  EXCRETE:       0x51,
  REPRODUCE:     0x52,
  PREDATE:       0x53,
  TURN:          0x54,
  ENGULF:        0x55,
  // TRANSPORT <chemId>: pop a signed amount (+ import from ambient,
  // - export to ambient); facilitated down-gradient flux of ANY chem
  // across the cell<->world membrane. Lets a genome acquire/dump
  // dissolved chems that passive permeability can't move (generics
  // are permeability 0). v1 is facilitated only (down-gradient,
  // mass-exact, no ATP); active uphill pumping is a later sub-step.
  TRANSPORT:     0x56,

  INGEST:        0x5E,
  SENSE_AMP:     0x64,
  POKE_BYTE:     0x65,
  SPLICE_DUP:    0x66,
  SPLICE_DEL:    0x67,
  // PARTITION <chemId>: pop a bias; skew this chem's mother/daughter
  // split at the next division away from the uniform reproduce share.
  // The substrate primitive for asymmetric determinant segregation --
  // genetically identical daughters emerge with different cytoplasm.
  PARTITION:     0x68,
  // 0x69 SYNTH -- unified biosynthesis op (kind, param).
  SYNTH:         0x69,

  // Chemistry sensor. Reads the cell's own pool of chem by id (operand
  // mod CHEMICAL_COUNT). With the K-3 activation pass populating
  // activated_* chems for every modality, this is the only external
  // sensor primitive a genome needs.
  SENSE_CHEMICAL:0x6F,
} as const;

// SYNTH kinds. Op layout: SYNTH <kind, param>. Each kind sets one
// bit in VMOutputs.synthMask (or, for multi-param kinds like PHOTO
// and CHEMO, sets one of several bits keyed on param). CAT routes
// to VMOutputs.catSynthMask separately. K-4 of the chemistry overhaul.
export const SYNTH_KIND = {
  BIO:     0,  // membrane synth (was SYNTH_BIO)
  AA:      1,
  FA:      2,
  ENZ:     3,
  CHL:     4,
  MRNA:    5,
  PHOTO:   6,  // param: band 0..2 (visible / long / surface)
  CHEMO:   7,  // param: target 0..3 (biopolymer / minerals / fa / marker0)
  MECH:    8,
  THERMO:  9,
  MAGNETO: 10,
  BOND:    11,
  REPAIR:  12,
  CAT:     13, // param: catalyst slot 0..255
  // Competence: expressed on a tick to take up a nearby extracellular
  // DNA fragment (HGT) or one in the host-scoped buffer (EGT). The
  // uptake/integration is physical (see eDnaUptakePass); this op only
  // marks the cell competent this tick, like every other SYNTH gate.
  COMPETENCE: 14,
  // Active packaging: expressed on a tick to encapsulate a fragment of
  // the cell's OWN genome and shed it as a free-floating carrier (the
  // donor-side virus/plasmid/conjugation strategy). Modeled like an
  // ATP-costed secretion -- emphatically not a targeted "inject"
  // verb: the donor cannot address a recipient. Who, if anyone, takes
  // it up is decided by the physical carrier + recipient competence.
  PACKAGE: 15,
} as const;
export const SYNTH_KIND_COUNT = 16;
// synthMask bit positions. Per-kind bits 0..5 + 13..17 use one bit
// each; PHOTO occupies bits 6..8 (one per band), CHEMO occupies
// bits 9..12 (one per target). 18 bits total.
export const SYNTH_BIT_BIO = 0;
export const SYNTH_BIT_AA = 1;
export const SYNTH_BIT_FA = 2;
export const SYNTH_BIT_ENZ = 3;
export const SYNTH_BIT_CHL = 4;
export const SYNTH_BIT_MRNA = 5;
export const SYNTH_BIT_PHOTO_BASE = 6;     // +0..+2
export const SYNTH_BIT_CHEMO_BASE = 9;     // +0..+3
export const SYNTH_BIT_MECH = 13;
export const SYNTH_BIT_THERMO = 14;
export const SYNTH_BIT_MAGNETO = 15;
export const SYNTH_BIT_BOND = 16;
export const SYNTH_BIT_REPAIR = 17;
export const SYNTH_BIT_COMPETENCE = 18;
export const SYNTH_BIT_PACKAGE = 19;

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

// Max bytes any single genome-editing event may copy in one tick:
// the SPLICE_DUP/SPLICE_DEL payload cap, and (reused) the per-event
// cap for horizontal injection and death-triggered EGT fragment
// transfer. Single-sourced so all byte-copy paths share one bound on
// per-tick genome growth. Value is unchanged from the original inline
// `32` -- keep it 32 so existing seeded runs stay byte-identical.
export const GENE_FRAGMENT_CAP = 32;

// Max distinct per-chem partition biases a cell can register in one
// tick (PARTITION op). Bounds the VMOutputs scratch and keeps the
// per-tick reset O(1); a cell biasing more chems than this in a single
// tick just has the surplus dropped.
export const PARTITION_CAP = 16;

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
OPERANDS[OP.EXCRETE] = 1;
OPERANDS[OP.TRANSPORT] = 1;
OPERANDS[OP.INGEST] = 1;
OPERANDS[OP.LOAD] = 1;
OPERANDS[OP.STORE] = 1;
OPERANDS[OP.SENSE_CHEMICAL] = 1;
OPERANDS[OP.PARTITION] = 1;
OPERANDS[OP.SYNTH] = 2;

// Walk the genome and call `visit(op, pc, operand)` for each
// executable op position. `operand` is the FIRST operand byte for any
// op that takes >=1 operand (e.g. SYNTH's kind byte; its second
// operand/param is read separately by callers that need it), and
// `undefined` for zero-operand ops. Centralizes the iteration pattern
// that used to be repeated (with subtle differences) in viableGenome
// / disassemble / summarizeGenome / describeGenomeProse /
// observedOpBias.
export function walkGenome(
  genome: Uint8Array,
  visit: (op: number, pc: number, operand: number | undefined) => void | "break",
): void {
  let i = 0;
  while (i < genome.length) {
    const op = genome[i];
    const operandLen = OPERANDS[op];
    const operand = operandLen >= 1 && i + 1 < genome.length ? genome[i + 1] : undefined;
    if (visit(op, i, operand) === "break") return;
    i += 1 + operandLen;
  }
}


const NAME_BY_OP: Record<number, string> = {};
for (const [k, v] of Object.entries(OP)) NAME_BY_OP[v as number] = k;

// Ops whose operand selects a sensor-chem slot (legacy disassembler
// label). Only INGEST still uses the 6-slot material naming; EXCRETE
// takes operand mod CHEMICAL_COUNT now but is included so the
// disassembler keeps labeling its operand against the low-slot
// mnemonics for readability.
const MATERIAL_OPERAND = new Set<number>([
  OP.EXCRETE, OP.INGEST,
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
  // Internal chemical concentration, indexed by chemical id. SENSE_CHEMICAL
  // <id> mod CHEMICAL_COUNT reads this. All external sensing has been
  // collapsed onto this primitive: the K-3 activation pass writes
  // activated_photo/chemo/mech/thermo/mag chems into the same pool, so
  // a genome that wants "light" reads SENSE_CHEMICAL CHEM_ACT_PHOTO,
  // "gradient toward food" reads SENSE_CHEMICAL CHEM_ACT_CHEMO_*_X, etc.
  chemConc: Float32Array;
}

// Self-state read by SELF_* ops. These are the values the cell knows
// about itself with no receptor mediation -- ATP, total mass, and the
// structural reserve (membrane). Per-chem internal pools (including
// activated_* signal chems) are read via SENSE_CHEMICAL <id>.
export interface VMSelf {
  energy: number;
  mass: number;
  membrane: number;
}

export interface VMOutputs {
  thrustX: number;
  thrustY: number;
  // Accumulated angle delta (radians) for any TURN ops this tick. The sim
  // applies this after the VM runs by rotating the cell's velocity vector.
  turn: number;
  excrete: Float32Array;
  // Signed per-chem membrane-flux request: + import from ambient,
  // - export. Sized to the full chem table (TRANSPORT <chemId>).
  transport: Float32Array;
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
  // Bit flags for biosynthesis gates this tick. Bit positions:
  //   0 biomass, 1 aa, 2 fa, 3 enzyme, 4 chlorophyll.
  // updateCreatures() runs biosynthesize() for product k iff the
  // corresponding bit is set. This makes the cell pay attention to
  // what it actually wants to build instead of always trying every
  // product (and wasting ATP on chlorophyll it never uses).
  synthMask: number;
  // Greenbeard adhesion tag. When SYNTH BOND runs this tick its param
  // byte (0..255) is exposed here; -1 means the cell did not express
  // bonding. Bond formation only links cells whose markers match
  // within BOND_MARKER_TOL, so the recognition rule is genome-encoded
  // and evolvable (mutation drifts the marker, splitting colonies into
  // bond-incompatible tribes over time).
  bondMarker: number;
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
  // Per-chem asymmetric-division bias requested this tick by PARTITION.
  // A capped (chemId, bias) list so the per-tick reset is O(1)
  // (partitionCount = 0) instead of a CHEMICAL_COUNT-wide memset on
  // every VM run. At apply time the last entry for a given chem wins;
  // entries past PARTITION_CAP this tick are dropped.
  partitionChem: Int16Array;
  partitionBias: Float32Array;
  partitionCount: number;
  instructions: number;
}

export function newOutputs(): VMOutputs {
  return {
    thrustX: 0, thrustY: 0, turn: 0,
    // EXCRETE was widened to take operand mod CHEMICAL_COUNT, so the
    // per-tick excretion request is sized to the full chem table.
    excrete: new Float32Array(CHEMICAL_COUNT),
    transport: new Float32Array(CHEMICAL_COUNT),
    reproduce: false, reproduceFraction: 0.4,
    predate: false, engulf: false,
    ingestMaterials: new Uint8Array(6),
    synthMask: 0,
    bondMarker: -1,
    catSynthMask: 0,
    spliceMode: 0, spliceOffset: 0, spliceLength: 0,
    partitionChem: new Int16Array(PARTITION_CAP),
    partitionBias: new Float32Array(PARTITION_CAP),
    partitionCount: 0,
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
  out.transport.fill(0);
  out.reproduce = false;
  // Parent keeps 40%, child gets 60%. Skewed in favor of the newborn
  // because the parent has had time to build reserves and can rebuild
  // from a lower base, while the newborn faces an immediate
  // foraging-or-die window.
  out.reproduceFraction = 0.4;
  out.predate = false;
  out.engulf = false;
  out.ingestMaterials.fill(0);
  out.synthMask = 0;
  out.bondMarker = -1;
  out.catSynthMask = 0;
  out.spliceMode = 0;
  out.spliceOffset = 0;
  out.spliceLength = 0;
  out.partitionCount = 0;
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

      case OP.SELF_ENERGY:   vmPush(stack, self.energy); break;
      case OP.SELF_MASS:      vmPush(stack, self.mass); break;
      case OP.SELF_MEMBRANE:  vmPush(stack, self.membrane); break;
      case OP.SENSE_CHEMICAL: {
        // operand mod CHEMICAL_COUNT. Reads the cell's pool of that
        // chem -- both bootstrap chems (0..12) and the K-3 activated
        // signal chems (CHEM_ACT_PHOTO/CHEMO/MECH/THERMO/MAG). All
        // external sensing is now layered on top of this primitive.
        const id = genome[state.pc % L] % CHEMICAL_COUNT;
        state.pc++;
        vmPush(stack, sensors.chemConc[id]);
        break;
      }
      // Unified SYNTH op (Tier 3 K-4). Two-byte operand: kind, param.
      // Kind selects the chem family; param picks band (PHOTO) /
      // target (CHEMO) / catalyst slot (CAT). Other kinds ignore
      // param. Each kind sets one bit in synthMask; per-cell
      // chemoreceptor target is implicit in the bit position.
      case OP.SYNTH: {
        const kindByte = genome[state.pc % L]; state.pc++;
        const param = genome[state.pc % L]; state.pc++;
        const kind = kindByte % SYNTH_KIND_COUNT;
        switch (kind) {
          case SYNTH_KIND.BIO:    out.synthMask |= 1 << SYNTH_BIT_BIO; break;
          case SYNTH_KIND.AA:     out.synthMask |= 1 << SYNTH_BIT_AA; break;
          case SYNTH_KIND.FA:     out.synthMask |= 1 << SYNTH_BIT_FA; break;
          case SYNTH_KIND.ENZ:    out.synthMask |= 1 << SYNTH_BIT_ENZ; break;
          case SYNTH_KIND.CHL:    out.synthMask |= 1 << SYNTH_BIT_CHL; break;
          case SYNTH_KIND.MRNA:   out.synthMask |= 1 << SYNTH_BIT_MRNA; break;
          case SYNTH_KIND.PHOTO:  out.synthMask |= 1 << (SYNTH_BIT_PHOTO_BASE + (param % 3)); break;
          case SYNTH_KIND.CHEMO:  out.synthMask |= 1 << (SYNTH_BIT_CHEMO_BASE + (param % 4)); break;
          case SYNTH_KIND.MECH:   out.synthMask |= 1 << SYNTH_BIT_MECH; break;
          case SYNTH_KIND.THERMO: out.synthMask |= 1 << SYNTH_BIT_THERMO; break;
          case SYNTH_KIND.MAGNETO: out.synthMask |= 1 << SYNTH_BIT_MAGNETO; break;
          case SYNTH_KIND.BOND:   out.synthMask |= 1 << SYNTH_BIT_BOND; out.bondMarker = param; break;
          case SYNTH_KIND.REPAIR: out.synthMask |= 1 << SYNTH_BIT_REPAIR; break;
          case SYNTH_KIND.CAT:    out.catSynthMask |= 1 << (param % CATALYST_COUNT); break;
          case SYNTH_KIND.COMPETENCE: out.synthMask |= 1 << SYNTH_BIT_COMPETENCE; break;
          case SYNTH_KIND.PACKAGE: out.synthMask |= 1 << SYNTH_BIT_PACKAGE; break;
        }
        break;
      }
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
        out.spliceLength = Math.max(0, Math.min(GENE_FRAGMENT_CAP, lenRaw | 0));
        break;
      }
      case OP.SPLICE_DEL: {
        const lenRaw = vmPop(stack);
        const offRaw = vmPop(stack);
        out.spliceMode = 2;
        out.spliceOffset = (((offRaw | 0) % L) + L) % L;
        out.spliceLength = Math.max(0, Math.min(GENE_FRAGMENT_CAP, lenRaw | 0));
        break;
      }

      case OP.PARTITION: {
        // Operand picks the chem (mod CHEMICAL_COUNT) whose
        // mother/daughter split to skew at the next division; pop the
        // raw bias. The squash + clamp to a valid [0,1] fraction is
        // applied where the split happens, so any popped value is
        // mass-safe. Last bias for a given chem this tick wins.
        const idx = genome[state.pc % L] % CHEMICAL_COUNT; state.pc++;
        const bias = vmPop(stack);
        let slot = -1;
        for (let q = 0; q < out.partitionCount; q++) {
          if (out.partitionChem[q] === idx) { slot = q; break; }
        }
        if (slot < 0 && out.partitionCount < PARTITION_CAP) {
          slot = out.partitionCount++;
          out.partitionChem[slot] = idx;
        }
        if (slot >= 0) out.partitionBias[slot] = bias;
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
        // Operand picks any chem in the table (mod CHEMICAL_COUNT).
        // Cells can excrete any chem they hold, not just the 6 sensor
        // chems the old m6-mask restricted them to.
        const idx = genome[state.pc % L] % CHEMICAL_COUNT; state.pc++;
        out.excrete[idx] += Math.max(0, vmPop(stack));
        break;
      }
      case OP.TRANSPORT: {
        // Operand = chem id (mod CHEMICAL_COUNT). Stack value is
        // SIGNED: positive imports from ambient, negative exports.
        const idx = genome[state.pc % L] % CHEMICAL_COUNT; state.pc++;
        out.transport[idx] += vmPop(stack);
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
  let predate = false, engulf = false;
  let selfModifies = false;
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
    const operand = operandLen >= 1 ? genome[(i + 1) % genome.length] : 0;
    switch (op) {
      case OP.THRUST:    thrust = true; break;
      case OP.TURN:      turn = true; break;
      case OP.REPRODUCE: reproduce = true; break;
      case OP.PREDATE:   predate = true; break;
      case OP.ENGULF:    engulf = true; break;
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
      case OP.SYNTH: {
        // operand here is the first operand byte (kind). The param
        // byte is at genome[pc+2] (one past the kind).
        const kind = (operand ?? 0) % SYNTH_KIND_COUNT;
        switch (kind) {
          case SYNTH_KIND.BIO:    synthBio = true; break;
          case SYNTH_KIND.AA:     synthAA = true; break;
          case SYNTH_KIND.FA:     synthFA = true; break;
          case SYNTH_KIND.ENZ:    synthEnz = true; break;
          case SYNTH_KIND.CHL:    synthChl = true; break;
          case SYNTH_KIND.MRNA:   synthRibo = true; break;
          case SYNTH_KIND.CAT: {
            const param = genome[(i + 2) % genome.length] ?? 0;
            const slot = param % CATALYST_COUNT;
            if (!catalystSlots.includes(slot)) catalystSlots.push(slot);
            break;
          }
          // Tier 3 sense-related SYNTH kinds don't get summary flags
          // yet; HUD will pick them up via the chem-pool inspector.
        }
        break;
      }
      case OP.JZ: case OP.JNZ: hasJump = true; break;
      case OP.LT: case OP.GT: case OP.EQ:
      case OP.NOT: case OP.AND: case OP.OR:
        hasCmp = true; break;
      case OP.SELF_MASS:
      case OP.SELF_MEMBRANE: case OP.SELF_ENERGY:
      case OP.SENSE_CHEMICAL: {
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
  if (engulf) otherActs.push("engulfs prey");
  if (predate) otherActs.push("predates");
  if (selfModifies) otherActs.push("rewrites its own genome (POKE / SPLICE)");
  bullets.push("- Excrete / engulf / predate? " + (otherActs.length > 0
    ? otherActs.join("; ") + "."
    : "None of the corresponding ops are present."));

  const anyAction = thrust || turn || reproduce || ingestMaterials.length > 0
    || predate || engulf || excreteMaterials.length > 0;
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
    reproduce, predate, engulf, selfModifies,
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

// Thrust acceleration was previously scaled by a passive THRUST_AMP
// op count. That op was retired in the chemistry-overhaul cleanup
// pass (free passive boost with no biological cost). Cells now stack
// THRUST ops at the cost of ATP per fire. Acceleration is a flat
// constant -- evolution tunes effective speed via THRUST cadence.
export const THRUST_BASE = 70;
export function computeThrustAccel(_genome: Uint8Array): number {
  return THRUST_BASE;
}

// Viability predicate. A genome is "viable enough to bother
// spawning" if it has at least one metabolism op (food intake or
// photosynthesis) and at least one reproduction op. Cells failing
// either are dead-end lineages: a no-metabolism cell starves in
// ~30s; a no-REPRODUCE cell can't perpetuate. Filtering them out at
// spawn time saves us from watching long sterile lives.

// Static synthMask derived from genome op set. Used for engulfed
// cells whose VM doesn't run -- their biosynthesis intent is locked
// to whichever SYNTH kinds happen to appear in their genome. K-4
// rewrite: walk every SYNTH op, decode kind, set the matching bit.
export function genomeSynthMask(genome: Uint8Array): number {
  let mask = 0;
  walkGenome(genome, (op, _pc, operand) => {
    if (op !== OP.SYNTH || operand === undefined) return;
    const kind = operand % SYNTH_KIND_COUNT;
    // PHOTO/CHEMO use param too; for static-mask purposes we OR all
    // band/target bits since we don't know which the cell will fire.
    switch (kind) {
      case SYNTH_KIND.BIO:    mask |= 1 << SYNTH_BIT_BIO; break;
      case SYNTH_KIND.AA:     mask |= 1 << SYNTH_BIT_AA; break;
      case SYNTH_KIND.FA:     mask |= 1 << SYNTH_BIT_FA; break;
      case SYNTH_KIND.ENZ:    mask |= 1 << SYNTH_BIT_ENZ; break;
      case SYNTH_KIND.CHL:    mask |= 1 << SYNTH_BIT_CHL; break;
      case SYNTH_KIND.MRNA:   mask |= 1 << SYNTH_BIT_MRNA; break;
      case SYNTH_KIND.PHOTO:
        mask |= (1 << SYNTH_BIT_PHOTO_BASE) | (1 << (SYNTH_BIT_PHOTO_BASE + 1)) | (1 << (SYNTH_BIT_PHOTO_BASE + 2));
        break;
      case SYNTH_KIND.CHEMO:
        mask |= (1 << SYNTH_BIT_CHEMO_BASE) | (1 << (SYNTH_BIT_CHEMO_BASE + 1))
              | (1 << (SYNTH_BIT_CHEMO_BASE + 2)) | (1 << (SYNTH_BIT_CHEMO_BASE + 3));
        break;
      case SYNTH_KIND.MECH:    mask |= 1 << SYNTH_BIT_MECH; break;
      case SYNTH_KIND.THERMO:  mask |= 1 << SYNTH_BIT_THERMO; break;
      case SYNTH_KIND.MAGNETO: mask |= 1 << SYNTH_BIT_MAGNETO; break;
      case SYNTH_KIND.BOND:    mask |= 1 << SYNTH_BIT_BOND; break;
      case SYNTH_KIND.REPAIR:  mask |= 1 << SYNTH_BIT_REPAIR; break;
      case SYNTH_KIND.COMPETENCE: mask |= 1 << SYNTH_BIT_COMPETENCE; break;
      case SYNTH_KIND.PACKAGE: mask |= 1 << SYNTH_BIT_PACKAGE; break;
    }
  });
  return mask;
}

// Set of every SENSE_* / SELF_* op the VM exposes. A genome with no
// member of this set has no way to read state and can only emit
// constant-conditioned behavior -- useless. Used by viableGenome
// below; kept here so adding a new sensor op only requires touching
// the OP table + this set.
const SENSE_OPS: ReadonlySet<number> = new Set([
  OP.SELF_ENERGY, OP.SELF_MASS, OP.SELF_MEMBRANE, OP.SENSE_CHEMICAL,
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
//    - hasBio:       SYNTH_BIO -- builds membrane (the structural
//                    reserve) and receptors; without it the cell
//                    autolyzes from maintenance decay.
//    - hasFA:        SYNTH_FA -- universal route to fatty acid;
//                    membrane-synth reactions consume fa, so
//                    without an internal supply membrane bleeds.
//    - hasMrna:      SYNTH_MRNA -- mRNA are mandatory on every
//                    biosynth reaction.
//    - hasSense:     any SENSE_* / SELF_* op -- a cell that can't
//                    read state can only emit constant behavior.
//  Heterotroph (INGEST/PREDATE/ENGULF present):
//    - hasEnz:       SYNTH_ENZ -- enzymes gate biopolymer digestion.
//    - hasThrust:    THRUST -- founders' scoop only fills the first
//                    few seconds; without movement the cell can't
//                    refill its pool from elsewhere. Photoautotrophs
//                    are exempt (sun reaches them where they sit).
//  Photoautotroph-only (SYNTH_CHL, no INGEST/PREDATE/ENGULF):
//    - hasAA:        SYNTH_AA -- cell makes its own amino acid from
//                    photosynth glucose. SYNTH_FA is already
//                    required universally above.
export function viableGenome(genome: Uint8Array): boolean {
  let hasIngest = false, hasPredate = false, hasEngulf = false, hasChl = false;
  let hasReproduce = false;
  let hasBio = false, hasMrna = false;
  let hasAA = false, hasFA = false, hasEnz = false;
  let hasSense = false;
  let hasThrust = false;
  walkGenome(genome, (op, _pc, operand) => {
    if (op === OP.INGEST) hasIngest = true;
    else if (op === OP.PREDATE) hasPredate = true;
    else if (op === OP.ENGULF) hasEngulf = true;
    else if (op === OP.REPRODUCE) hasReproduce = true;
    else if (op === OP.THRUST) hasThrust = true;
    else if (op === OP.SYNTH && operand !== undefined) {
      const kind = operand % SYNTH_KIND_COUNT;
      if (kind === SYNTH_KIND.BIO) hasBio = true;
      else if (kind === SYNTH_KIND.MRNA) hasMrna = true;
      else if (kind === SYNTH_KIND.AA) hasAA = true;
      else if (kind === SYNTH_KIND.FA) hasFA = true;
      else if (kind === SYNTH_KIND.ENZ) hasEnz = true;
      else if (kind === SYNTH_KIND.CHL) hasChl = true;
    }
    if (!hasSense && SENSE_OPS.has(op)) hasSense = true;
  });
  const isHeterotroph = hasIngest || hasPredate || hasEngulf;
  const hasMass = isHeterotroph || hasChl;
  if (!hasMass || !hasReproduce || !hasBio || !hasMrna || !hasSense) return false;
  // SYNTH_FA is universally required now. Both membrane-synth
  // reactions consume fatty acid; without an internal route to fa
  // the cell's structural reserve (membrane) starves whenever
  // biopolymer flow stops. Heterotrophs can dribble fa in via
  // biopolymer digestion, but that's not enough on its own.
  if (!hasFA) return false;
  // Heterotrophs need digestive enzymes to convert biopolymer into glu/aa/fa.
  if (isHeterotroph && !hasEnz) return false;
  // Heterotrophs also need THRUST -- without movement they can't
  // chase a new food patch after exhausting their founder scoop and
  // local ambient. Photoautotrophs can sit still and photosynthesize
  // so movement isn't strictly required for them.
  if (isHeterotroph && !hasThrust) return false;
  // Pure photoautotrophs need their own building-block factory.
  // (SYNTH_FA is already required universally above; SYNTH_AA stays
  // a pure-autotroph requirement.)
  if (hasChl && !isHeterotroph && !hasAA) return false;
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

// Sample a random genome size in [16, 100] with a gradual bias toward
// smaller. Floor raised to 16 to match the new viability floor:
// 6 universal required ops (REPRODUCE, SYNTH_BIO, SYNTH_MRNA,
// SYNTH_FA, one SENSE_*, plus either THRUST or SYNTH_CHL for mass
// acquisition) + 2 trophic-branch ops (SYNTH_ENZ + INGEST or
// SYNTH_AA + SYNTH_CHL) + operand bytes. Smaller genomes always
// fail and waste reroll budget.
// Shipped default 0.50; ADH_PREV env var overrides it for A/B probes
// only (clamped to [0,1], NaN-safe). Read once at module load.
const ADHESION_PREVALENCE: number = (() => {
  // globalThis access keeps this browser-safe (no `process` type in
  // the src tsconfig); env is only set by the Node long-run probe.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const raw = env?.ADH_PREV;
  const v = raw === undefined ? 0.50 : Number(raw);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.50;
})();

function randomGenomeSize(rng: () => number): number {
  const u = rng();
  // Triangular falloff on [24, 100]; clamping handles the math.
  const k = Math.floor((201 - Math.sqrt(Math.max(0, 38025 - 38024 * u))) / 2) + 1;
  return Math.max(24, Math.min(100, k));
}

// Viable-by-construction founder genome. Instead of rejection-sampling
// against viableGenome (which a purely random genome essentially never
// passes), we assemble the required ops as atomic tokens, shuffle their
// order, and pad to a random size with junk filler. Every founder is a
// distinct genome (token order, operands, size, and trailing junk all
// randomized) yet guaranteed to satisfy the heterotroph viability
// rules. No curated/hand-built genome is involved. Never returns null;
// the `| null` return is kept so callers' skip-path stays valid.
export function makeRandomViableGenome(
  rng: () => number = Math.random,
): Uint8Array | null {
  const b = (): number => Math.floor(rng() * 256);
  // Gated REPRODUCE: instead of a bare (unconditional) REPRODUCE that
  // fires every tick and makes every new lineage balloon then
  // boom/bust, wrap it in a randomized resource gate:
  //   SELF_ENERGY|SELF_MEMBRANE ; PUSH8 thresh ; GT ; JZ +1 ; REPRODUCE
  // i.e. only fission once the chosen reserve clears a per-founder
  // random threshold. Kept as one atomic token so the JZ +1 skip
  // stays aligned through the shuffle; threshold + which reserve are
  // randomized per founder, and mutation/selection tune it from there.
  const repSensor = rng() < 0.5 ? OP.SELF_ENERGY : OP.SELF_MEMBRANE;
  const repThresh = 8 + Math.floor(rng() * 40); // 8..47, positive i8
  // Required tokens for a viable heterotroph (see viableGenome):
  // reproduce, ingest, thrust, a SENSE op, and SYNTH for
  // bio/mrna/fa/enz/aa. Operands randomized for diversity.
  const tokens: number[][] = [
    [repSensor, OP.PUSH8, repThresh, OP.GT, OP.JZ, 1, OP.REPRODUCE],
    [OP.INGEST, Math.floor(rng() * 6)],          // a sensor material
    [OP.THRUST],
    [OP.SENSE_CHEMICAL, Math.floor(rng() * CHEMICAL_COUNT)],
    [OP.SYNTH, SYNTH_KIND.BIO, b()],
    [OP.SYNTH, SYNTH_KIND.MRNA, b()],
    [OP.SYNTH, SYNTH_KIND.FA, b()],
    [OP.SYNTH, SYNTH_KIND.ENZ, b()],
    [OP.SYNTH, SYNTH_KIND.AA, b()],
  ];
  // ~10% of founders are chlorophyll synthesizers (mixotrophs): they
  // keep the heterotroph kit but also build chlorophyll, so they can
  // run photosynthesis (fix carbon, release O2). Mixotroph rather than
  // pure autotroph keeps viableGenome happy without special-casing the
  // pure-autotroph branch; pure photoautotrophs can still evolve from
  // these by losing INGEST via mutation.
  if (rng() < 0.50) tokens.push([OP.SYNTH, SYNTH_KIND.CHL, b()]);
  // A fraction of founders are adhesive. The SYNTH BOND param byte is
  // the cell's greenbeard marker: a random tag here, inherited by the
  // whole clonal lineage (fission copies the genome) so descendants
  // recognize each other and form colonies, while distinct founder
  // lineages get distinct tags and stay bond-incompatible. Mutation
  // drifts the tag, letting colonies speciate into tribes over time.
  // Prevalence is env-overridable (ADH_PREV, 0..1) purely so the
  // long-run probe can A/B it; default is the shipped value.
  if (rng() < ADHESION_PREVALENCE) tokens.push([OP.SYNTH, SYNTH_KIND.BOND, b()]);
  // Every founder builds 1-2 sensory receptors. Founders used to start
  // blind (zero receptors) -- SENSE_CHEMICAL is inert without a
  // receptor chem -- so they drifted until sensing happened to evolve.
  // Give each a random 1-2 from the receptor set so they can actually
  // navigate from birth. Kind + param randomized for diversity.
  const RECEPTOR_KINDS = [
    SYNTH_KIND.CHEMO, SYNTH_KIND.PHOTO, SYNTH_KIND.MECH,
    SYNTH_KIND.THERMO, SYNTH_KIND.MAGNETO,
  ];
  const nRecept = 1 + (rng() < 0.5 ? 1 : 0);
  for (let r = 0; r < nRecept; r++) {
    const kind = RECEPTOR_KINDS[Math.floor(rng() * RECEPTOR_KINDS.length)];
    tokens.push([OP.SYNTH, kind, b()]);
  }
  // Fisher-Yates shuffle so structure differs founder to founder.
  for (let i = tokens.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = tokens[i]; tokens[i] = tokens[j]; tokens[j] = t;
  }
  const core: number[] = [];
  for (const tk of tokens) for (const byte of tk) core.push(byte);
  // Pad with junk to a random total size. Junk goes AFTER the core so
  // the required ops always decode at a fixed alignment from pc 0
  // regardless of what the random filler bytes happen to be.
  const target = Math.max(core.length, randomGenomeSize(rng));
  const out = new Uint8Array(target);
  for (let i = 0; i < core.length; i++) out[i] = core[i];
  for (let i = core.length; i < target; i++) out[i] = b();
  return out;
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
    if (rng() < P_INSERT) {
      out.push(randMutByte(rng, opBias));
    }
    let b = genome[i];
    if (rng() < P_POINT) b = randMutByte(rng, opBias);
    out.push(b);
  }
  if (rng() < P_INSERT) {
    out.push(randMutByte(rng, opBias));
  }
  // Every byte happened to delete: keep the genome non-empty with a
  // single lineage-consistent random byte (no curated-default revival).
  if (out.length === 0) out.push(randMutByte(rng, opBias));
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
  if (genome.length === 0) return new Uint8Array([0]);
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
  if (r < 0.85) {
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

// Append-only genome byte transfer: returns a new genome with up to
// GENE_FRAGMENT_CAP bytes copied from `src[srcOff .. )` onto the end of
// `genome`. The shared primitive behind horizontal injection (donor ->
// recipient) and death-triggered EGT (dead symbiont -> host).
//
// Append-only on purpose: existing code offsets never move, so the
// recipient's program counter stays valid (length only grows) and the
// transferred payload is dormant until reached by a JMP or PC wrap --
// the latency is emergent, not scripted. The source window is clamped
// to src bounds (no wrap, mirroring SPLICE's truncate-at-end). A no-op
// (empty/zero/out-of-range request) returns the original array
// unchanged so callers can assign unconditionally.
export function appendGenomeBytes(
  genome: Uint8Array,
  src: Uint8Array,
  srcOff: number,
  srcLen: number,
): Uint8Array {
  if (src.length === 0) return genome;
  const cap = Math.max(0, Math.min(GENE_FRAGMENT_CAP, srcLen | 0));
  if (cap === 0) return genome;
  const a = (((srcOff | 0) % src.length) + src.length) % src.length;
  const b = Math.min(src.length, a + cap);
  const n = b - a;
  if (n <= 0) return genome;
  const out = new Uint8Array(genome.length + n);
  out.set(genome, 0);
  out.set(src.subarray(a, b), genome.length);
  return out;
}
