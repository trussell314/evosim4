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
  // 0x5A..0x5D SENSE_WALL_*/HEAD_*, 0x5F SENSE_TEMP,
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
  // EMIT <channel>: pop a magnitude, deliberately spend ATP to broadcast
  // into a perceptual field (active emission). The ATP cost raises the
  // cell's metabolic-glow term, so emitting makes it louder on that
  // channel than baseline metabolism alone. Channel = operand %
  // EMIT_CHANNELS (currently only electric; grows as modalities land).
  // Reclaims the byte of the retired pre-overhaul EMIT op.
  EMIT:          0x60,
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

  // Gene framing (start/stop codons). The VM only EXECUTES bytes inside
  // a GENE..END span; bytes outside (between END and the next GENE, or
  // before the first GENE) are INTRONS -- skipped, never executed, and
  // therefore neutral space where indels accumulate without breaking
  // the cell. This gives the genome a reading frame: an indel inside
  // one gene frame-shifts only that gene (until its END); the next
  // GENE re-synchronises. The stack is cleared at every GENE boundary
  // so a garbled gene cannot corrupt its neighbours (per-gene
  // isolation). A genome with no GENE codon executes nothing.
  GENE:          0x6A,
  END:           0x6B,

  // Chemistry sensor. Reads the cell's own pool of chem by id (operand
  // mod CHEMICAL_COUNT). With the K-3 activation pass populating
  // activated_* chems for every modality, this is the only external
  // sensor primitive a genome needs.
  SENSE_CHEMICAL:0x6F,

  // Environmental gradient sensor. SENSE_OUT <chemId> pushes the
  // local spatial gradient VECTOR of that chem's particle field at
  // the cell's position: gx then gy (so `SENSE_OUT c; THRUST` climbs
  // it -- THRUST pops ay then ax). Universal: works for ANY chem
  // with no SYNTH'd receptor, so emergent taxis toward/away from any
  // particle species is expressible without the dedicated
  // chemoreceptor machinery. Zero vector for engulfed organelles
  // (no spatial gradient inside a host).
  SENSE_OUT:     0x6E,
} as const;

// SYNTH kinds. Op layout: SYNTH <kind, param>. Each kind sets one
// bit in VMOutputs.synthMask (or, for multi-param kinds like PHOTO
// and CHEMO, sets one of several bits keyed on param). CAT routes
// to VMOutputs.catSynthMask separately. K-4 of the chemistry overhaul.
// SYNTH kinds the VM actually consumes. After Phase 4a the named
// biosynth/receptor kinds (BIO/AA/FA/ENZ/CHL/MRNA/PHOTO/CHEMO/MECH/
// THERMO/MAGNETO/REPAIR) were retired -- their reactions now run on
// every cell at uncatRate so the "declare the pathway" gate no
// longer exists. CAT / INH / BOND / COMPETENCE / PACKAGE are the
// only kinds that still produce a runtime effect, so they're the
// only kinds left. SYNTH_KIND_COUNT is the modulo applied to the
// genome's kind byte; shrinking it reroutes mutation pressure away
// from the dead surface.
export const SYNTH_KIND = {
  // Boost reaction slot <param> above its uncatRate baseline. The
  // primary differentiation mechanism: every "what kind of cell is
  // this" question is now "which slots is it pouring catalyst into."
  CAT: 0, // param: reaction slot 0..255
  // Allosteric inhibitor for reaction slot <param>. Dual of CAT --
  // multiplies the slot's effective rate down (1 - INH_K * inhPool
  // / CAT_REF). Paid + decaying; it's the off-switch for the
  // constitutive bootstrap floor (Phase 4b).
  INH: 1, // param: reaction slot 0..255
  // Adhesion marker (greenbeard). Param byte is the lineage tag;
  // cells with matching tags bond. Inherited by clones at fission.
  BOND: 2,
  // Competence (HGT uptake): expressed on a tick to take up a
  // nearby extracellular DNA fragment or one from the host-scoped
  // buffer. Uptake/integration is physical (see eDnaUptakePass);
  // this op only marks the cell competent for the tick.
  COMPETENCE: 3,
  // Active packaging (HGT shed): expressed on a tick to encapsulate
  // a fragment of the cell's OWN genome and ship it as a free-
  // floating carrier (donor-side virus/plasmid/conjugation). Donor
  // cannot address a recipient; uptake is the recipient's call.
  PACKAGE: 4,
} as const;
export const SYNTH_KIND_COUNT = 5;
// Reverse map (kind byte -> short name) for the disassembler / prose.
export const SYNTH_KIND_NAME: Record<number, string> = {
  [SYNTH_KIND.CAT]: "cat",
  [SYNTH_KIND.INH]: "inh",
  [SYNTH_KIND.BOND]: "bond",
  [SYNTH_KIND.COMPETENCE]: "competence",
  [SYNTH_KIND.PACKAGE]: "package",
};
// synthMask bit positions. One bit per kind that has a non-CAT/INH
// effect (those two use the parallel catSynthMask / inhSynthMask).
export const SYNTH_BIT_BOND = 0;
export const SYNTH_BIT_COMPETENCE = 1;
export const SYNTH_BIT_PACKAGE = 2;

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

// --- Multi-element genome (chromosomes + plasmids) ---------------------
// A cell's heritable material is a SET of genetic elements, not one flat
// array. CHROMOSOME elements are the essential, vertically-inherited
// genome (>=2 homologous copies => diploidy); PLASMID elements are small,
// non-essential, horizontally-transferable. Today every cell carries
// exactly one CHROMOSOME (genomes[0]) and Creature.genome is an accessor
// for its bytes, so behavior is unchanged -- this just lays the storage
// the later phases (diploidy, conjugation) build on. See GENETICS_PLAN.md.
export const ELEMENT_KIND = { CHROMOSOME: 0, PLASMID: 1 } as const;
export interface GenomeElement {
  kind: number; // ELEMENT_KIND.*
  bytes: Uint8Array;
  // Per-element VM execution state (pc/stack/regs persist independently
  // so each element runs its own program). Element 0's state is the
  // cell's `vm`; extra elements get their own, created lazily.
  vm?: VMState;
}

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
// INGEST is zero-operand: it pops a bond-energy threshold off the
// stack (INGEST_TH_SCALE-scaled) rather than naming a material.
// Maps a stack value (PUSH8 byte 0..255, or any computed value)
// onto bond-potential units: 255 -> ~5.1 covers the richest chem;
// a small pushed value -> ~0 eats everything organic but excludes
// zero-bond inorganics (MIN/O2/CO2). Selection tunes the value.
const INGEST_TH_SCALE = 0.02;

// Reused scratch for SENSE_OUT's [gx, gy] return (module-level so the
// VM hot loop allocates nothing). RNG-free.
const _GRAD = new Float32Array(2);
OPERANDS[OP.LOAD] = 1;
OPERANDS[OP.STORE] = 1;
OPERANDS[OP.SENSE_CHEMICAL] = 1;
OPERANDS[OP.SENSE_OUT] = 1;
OPERANDS[OP.PARTITION] = 1;
OPERANDS[OP.SYNTH] = 2;
OPERANDS[OP.EMIT] = 1;

// Active-emission channels addressable by OP.EMIT (operand % EMIT_CHANNELS).
// Channel ids are stable; new channels append as modalities land. Today:
// 0 = electric (the only emission channel wired in the sim).
export const EMIT_CHANNELS = 1;
export const EMIT_CHANNEL_ELECTRIC = 0;
// Per-tick magnitude clamp so a runaway stack value can't request an
// absurd ATP burn in one op.
const EMIT_MAG_CAP = 1000;

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
  // expressedOnly: mirror the VM's gene framing -- skip intron bytes
  // (outside any GENE..END span) and don't visit the GENE/END codons
  // themselves, so callers see exactly the ops that actually EXECUTE.
  // Default false = walk every byte (used by the disassembler, which
  // must render introns + codons too). Scanning advances byte-by-byte
  // (introns aren't parsed for operands), matching runTick.
  expressedOnly = false,
): void {
  let i = 0;
  let executing = !expressedOnly;
  while (i < genome.length) {
    const op = genome[i];
    if (expressedOnly && !executing) {
      if (op === OP.GENE) executing = true;
      i += 1;
      continue;
    }
    if (expressedOnly) {
      if (op === OP.END) { executing = false; i += 1; continue; }
      if (op === OP.GENE) { i += 1; continue; }
    }
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
  OP.EXCRETE,
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
  // Gene-framing mode. false = SCANNING (skipping introns, looking for
  // the next GENE codon); true = EXECUTING (inside a gene, running ops
  // until END). Persists across ticks because pc does -- a gene can
  // span tick boundaries when the instruction budget runs out mid-gene.
  executing: boolean;
}

export function newVMState(): VMState {
  return { pc: 0, stack: [], regs: new Float32Array(REG_COUNT), executing: false };
}

export interface VMSensors {
  // Internal chemical concentration, indexed by chemical id. SENSE_CHEMICAL
  // <id> mod CHEMICAL_COUNT reads this. All external sensing has been
  // collapsed onto this primitive: the K-3 activation pass writes
  // activated_photo/chemo/mech/thermo/mag chems into the same pool, so
  // a genome that wants "light" reads SENSE_CHEMICAL CHEM_ACT_PHOTO,
  // "gradient toward food" reads SENSE_CHEMICAL CHEM_ACT_CHEMO_*_X, etc.
  chemConc: Float32Array;
  // Local spatial gradient of a chem's particle field at the cell's
  // position. Writes [gx, gy] into `out`. Supplied by the engine
  // (closes over the current cell/world); deterministic. Zero vector
  // for engulfed organelles. Backs the SENSE_OUT op.
  gradient(chemId: number, out: Float32Array): void;
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
  // Bond-energy ingest threshold this tick. INGEST pops a value off
  // the stack (scaled to bond-potential units); the cell engulfs any
  // contacted particle whose CHEM_BOND_POTENTIAL >= this. Infinity =
  // no INGEST ran this tick (ingest nothing). Multiple INGEST ops
  // take the MOST permissive (lowest) threshold.
  ingestThreshold: number;
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
  // Per-slot expression flags for generic catalyst synthesis this tick.
  // catSynthMask[k] != 0 means SYNTH_CAT with operand mod CATALYST_COUNT == k
  // fired this tick; the sim runs catalyst synthesis for slot k iff that
  // entry is nonzero. Stored as a Uint8Array(CATALYST_COUNT) rather than a
  // packed JS bitmask -- CATALYST_COUNT is 256 but JS bitwise ops are
  // 32-bit, so 1 << k for k >= 32 silently aliases low bits (slot 37
  // collides with slot 5, etc.). Array form makes each slot independent.
  catSynthMask: Uint8Array;
  // Parallel array: inhSynthMask[k] != 0 means SYNTH INH param=k fired
  // this tick. updateCreatures() runs biosynthInhibitor(slot) for each
  // nonzero entry (dual of catSynthMask -> biosynthCatalyst).
  inhSynthMask: Uint8Array;
  // Compact lists of the slots that fired this tick (deduped via the
  // masks above). Consumers iterate these instead of scanning all
  // CATALYST_COUNT mask entries, and runTick clears only these entries
  // instead of fill(0)-ing the whole mask -- so the per-cell cost is
  // O(slots-expressed) (~handful) not O(256). The masks stay for the
  // O(1) dedup test ("has slot k already fired this tick?").
  catSynthList: Int32Array;
  catSynthCount: number;
  inhSynthList: Int32Array;
  inhSynthCount: number;
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
  // Per-channel active-emission magnitude requested this tick by OP.EMIT
  // (sized EMIT_CHANNELS). The sim spends ATP proportional to it, which
  // feeds the channel's emission field. Cleared each tick.
  emit: Float32Array;
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
    ingestThreshold: Infinity,
    synthMask: 0,
    bondMarker: -1,
    catSynthMask: new Uint8Array(CATALYST_COUNT),
    inhSynthMask: new Uint8Array(CATALYST_COUNT),
    catSynthList: new Int32Array(CATALYST_COUNT),
    catSynthCount: 0,
    inhSynthList: new Int32Array(CATALYST_COUNT),
    inhSynthCount: 0,
    spliceMode: 0, spliceOffset: 0, spliceLength: 0,
    partitionChem: new Int16Array(PARTITION_CAP),
    partitionBias: new Float32Array(PARTITION_CAP),
    partitionCount: 0,
    instructions: 0,
    emit: new Float32Array(EMIT_CHANNELS),
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
  out.emit.fill(0);
  // Parent keeps 40%, child gets 60%. Skewed in favor of the newborn
  // because the parent has had time to build reserves and can rebuild
  // from a lower base, while the newborn faces an immediate
  // foraging-or-die window.
  out.reproduceFraction = 0.4;
  out.predate = false;
  out.engulf = false;
  out.ingestThreshold = Infinity;
  out.synthMask = 0;
  out.bondMarker = -1;
  // Clear only the slots that fired last tick (O(count)), not the whole
  // CATALYST_COUNT-wide mask.
  for (let i = 0; i < out.catSynthCount; i++) out.catSynthMask[out.catSynthList[i]] = 0;
  out.catSynthCount = 0;
  for (let i = 0; i < out.inhSynthCount; i++) out.inhSynthMask[out.inhSynthList[i]] = 0;
  out.inhSynthCount = 0;
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

    // SCANNING: outside any gene. Skip the intron run to the next GENE
    // codon in a single budget step (intron length is therefore nearly
    // free -- it is "spliced out", not executed), so large neutral
    // regions don't starve genes of the small per-tick instr budget.
    if (!state.executing) {
      let scanned = 0;
      while (scanned < L && genome[state.pc] !== OP.GENE) {
        state.pc++;
        if (state.pc >= L) state.pc = 0;
        scanned++;
      }
      out.instructions++;
      if (scanned >= L) {
        // No GENE anywhere in the genome: nothing to express. Don't
        // spin the remaining budget scanning a gene-less genome.
        break;
      }
      // Landed on a GENE codon: enter the gene. Clear the stack so a
      // previous (possibly garbled) gene can't leak values into this
      // one -- per-gene isolation.
      if (execCounts && state.pc < execCounts.length) execCounts[state.pc]++;
      state.pc++;
      state.executing = true;
      stack.length = 0;
      continue;
    }

    if (execCounts && state.pc < execCounts.length) execCounts[state.pc]++;
    const op = genome[state.pc];
    state.pc++;
    out.instructions++;

    // END codon: leave the gene, resume scanning for the next one.
    if (op === OP.END) { state.executing = false; continue; }
    // A GENE codon encountered while already executing starts a fresh
    // gene (back-to-back genes with a zero-length intron). Re-clear the
    // stack for isolation, stay in executing mode.
    if (op === OP.GENE) { stack.length = 0; continue; }

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
      case OP.SENSE_OUT: {
        // operand mod CHEMICAL_COUNT. Pushes the local spatial
        // gradient vector of that chem's particle field: gx then gy
        // (THRUST pops ay,ax, so `SENSE_OUT c; THRUST` swims up-grad).
        const id = genome[state.pc % L] % CHEMICAL_COUNT;
        state.pc++;
        sensors.gradient(id, _GRAD);
        vmPush(stack, _GRAD[0]);
        vmPush(stack, _GRAD[1]);
        break;
      }
      // Unified SYNTH op. Two-byte operand: kind, param. Kind picks
      // CAT/INH/BOND/COMPETENCE/PACKAGE (the only kinds with runtime
      // effect after Phase 4a); param picks catalyst slot (CAT/INH)
      // or adhesion marker (BOND). Unrecognized kinds (post-mod) are
      // impossible since the modulo is the count.
      case OP.SYNTH: {
        const kindByte = genome[state.pc % L]; state.pc++;
        const param = genome[state.pc % L]; state.pc++;
        const kind = kindByte % SYNTH_KIND_COUNT;
        switch (kind) {
          case SYNTH_KIND.CAT: {
            const s = param % CATALYST_COUNT;
            if (!out.catSynthMask[s]) { out.catSynthMask[s] = 1; out.catSynthList[out.catSynthCount++] = s; }
            break;
          }
          case SYNTH_KIND.INH: {
            const s = param % CATALYST_COUNT;
            if (!out.inhSynthMask[s]) { out.inhSynthMask[s] = 1; out.inhSynthList[out.inhSynthCount++] = s; }
            break;
          }
          case SYNTH_KIND.BOND:   out.synthMask |= 1 << SYNTH_BIT_BOND; out.bondMarker = param; break;
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
      case OP.EMIT: {
        const ch = genome[state.pc % L] % EMIT_CHANNELS; state.pc++;
        let mag = vmPop(stack);
        if (mag < 0) mag = 0; else if (mag > EMIT_MAG_CAP) mag = EMIT_MAG_CAP;
        out.emit[ch] += mag;
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
      case OP.INGEST:     { const t = Math.max(0, vmPop(stack)) * INGEST_TH_SCALE; if (t < out.ingestThreshold) out.ingestThreshold = t; break; }
      case OP.TURN:       out.turn      += vmPop(stack); break;
      // HALT (0xFF) is retired -- it was a programmer's escape hatch
      // with no biological analog. Old genomes carrying the byte now
      // fall through to the default branch (NOP), so the byte stays
      // inert during a tick instead of cutting it short. The OP
      // constant is kept for the disassembler.
      default: break;
    }
  }
  // Keep the fired-slot lists in ascending slot order so consumers run
  // catalyst/inhibitor synthesis in the same order as the old full-mask
  // (0..255) scan -- the order matters under substrate scarcity, so this
  // keeps the list optimization behaviour-identical. Lists are tiny
  // (<= instruction budget entries), so the sort is negligible.
  if (out.catSynthCount > 1) out.catSynthList.subarray(0, out.catSynthCount).sort();
  if (out.inhSynthCount > 1) out.inhSynthList.subarray(0, out.inhSynthCount).sort();
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
  ingests: boolean;
  excreteMaterials: number[];
  reproduce: boolean;
  predate: boolean;
  engulf: boolean;
  selfModifies: boolean;
  sensors: string[];
  capabilities: string[];
  // Catalyst / inhibitor slots SYNTH CAT / SYNTH INH will populate if
  // they fire at the listed PCs. Best-effort static analysis: operand
  // byte mod CATALYST_COUNT. Doesn't catch runtime PC drift; gives an
  // honest "likely portfolio" view of the cell's metabolic identity.
  // After Phase 4a these are how a cell differentiates -- every named
  // bootstrap reaction fires at uncatRate on every cell, so the only
  // genome-controlled axis is which slots get boosted (CAT) or damped
  // (INH) above/below that baseline.
  catalystSlots: number[];
  inhibitorSlots: number[];
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
  let ingests = false;
  const excreteMaterials: number[] = [];
  const sensors: string[] = [];
  const seenSensor = new Set<string>();
  let thrust = false, turn = false, reproduce = false;
  let predate = false, engulf = false;
  let selfModifies = false;
  let hasJump = false, hasCmp = false;
  let executableOps = 0, unknownBytes = 0;
  const catalystSlots: number[] = [];
  const inhibitorSlots: number[] = [];

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
      case OP.INGEST:
        ingests = true;
        break;
      case OP.EXCRETE: {
        const mat = m6(operand);
        if (!excreteMaterials.includes(mat)) excreteMaterials.push(mat);
        break;
      }
      case OP.SYNTH: {
        // operand here is the first operand byte (kind). The param
        // byte is at genome[pc+2] (one past the kind).
        const kind = (operand ?? 0) % SYNTH_KIND_COUNT;
        if (kind === SYNTH_KIND.CAT) {
          const param = genome[(i + 2) % genome.length] ?? 0;
          const slot = param % CATALYST_COUNT;
          if (!catalystSlots.includes(slot)) catalystSlots.push(slot);
        } else if (kind === SYNTH_KIND.INH) {
          const param = genome[(i + 2) % genome.length] ?? 0;
          const slot = param % CATALYST_COUNT;
          if (!inhibitorSlots.includes(slot)) inhibitorSlots.push(slot);
        }
        // BOND / COMPETENCE / PACKAGE kinds have effects but no slot,
        // so the summary picks them up via the capability axis below
        // (BOND => bondMarker; COMPETENCE / PACKAGE => HGT
        // capabilities). Not flagged here.
        break;
      }
      case OP.JZ: case OP.JNZ: hasJump = true; break;
      case OP.LT: case OP.GT: case OP.EQ:
      case OP.NOT: case OP.AND: case OP.OR:
        hasCmp = true; break;
      case OP.SELF_MASS:
      case OP.SELF_MEMBRANE: case OP.SELF_ENERGY:
      case OP.SENSE_CHEMICAL:
      case OP.SENSE_OUT: {
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
  if (ingests) {
    capabilities.push("ingests particles (bond-energy threshold)");
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

  bullets.push("- Ingest food? " + (ingests
    ? `Yes -- engulfs particles above its bond-energy threshold.${gateNote}`
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

  const anyAction = thrust || turn || reproduce || ingests
    || predate || engulf || excreteMaterials.length > 0;
  bullets.push("- React to anything it senses? " + (sensors.length === 0
    ? "No sensor reads at all."
    : !anyAction
    ? `Reads ${sensors.join(", ")}, but with no action ops those readings just pile onto the stack and get discarded when capacity is reached.`
    : !conditional
    ? `Reads ${sensors.join(", ")}, but with no JZ/JNZ + comparison the readings don't gate any decision -- actions fire reflexively.`
    : `Yes -- reads ${sensors.join(", ")}, and has JZ/JNZ + comparison gating its actions.`));

  // Catalyst-slot interpretation. Mirror of sim/reactions.ts named
  // installs -- keep in sync if those renumber. Used by the metabolism
  // classifier below to read "this cell boosts photosynth + synth_aa"
  // as "is an autotroph", without inventing dead SYNTH-kind flags.
  const SLOT_PHOTOSYNTH = 3;
  const SLOT_SYNTH_AA = 4;
  const SLOT_SYNTH_CHL = 6;
  const SLOT_SYNTH_ENZ = 7;
  const SLOT_SYNTH_MEM_AAFA = 9;
  const SLOT_DIGEST_BIOP = 10;
  const SLOT_SYNTH_MEM_FA = 11;
  const SLOT_NAMES: Record<number, string> = {
    0: "respiration", 1: "fermentation", 2: "beta-ox",
    3: "photosynth", 4: "synth_aa", 5: "synth_fa",
    6: "synth_chl", 7: "synth_enz", 8: "synth_ribo",
    9: "synth_membrane(aa+fa)", 10: "digest_biopolymer",
    11: "synth_membrane(fa)", 12: "synth_photo_v",
    19: "synth_mech", 20: "synth_thermo", 21: "synth_magneto",
  };
  const boostsPhotosynth = catalystSlots.includes(SLOT_PHOTOSYNTH);
  const boostsChl = catalystSlots.includes(SLOT_SYNTH_CHL);
  const boostsDigest = catalystSlots.includes(SLOT_DIGEST_BIOP);
  const boostsMembrane = catalystSlots.includes(SLOT_SYNTH_MEM_AAFA)
    || catalystSlots.includes(SLOT_SYNTH_MEM_FA);
  const isHetero = ingests || predate || engulf;
  const isPhotoauto = (boostsPhotosynth || boostsChl) && !isHetero;

  // Net behavior: short verdict + likely fate in this environment.
  let netClass: string;
  if (!anyAction) netClass = "An inert blob.";
  else if (isPhotoauto && reproduce) netClass = "A photoautotroph: boosts photosynth/chl above baseline, no INGEST, divides.";
  else if (predate || engulf) netClass = "A predator.";
  else if (thrust && ingests && reproduce) netClass = "A complete loop: senses, swims, eats, divides.";
  else if (ingests && reproduce) netClass = "A passive eater that divides -- doesn't steer toward food.";
  else if (thrust && ingests) netClass = "A forager: swims and eats, but never divides.";
  else if (ingests) netClass = "A passive eater -- waits for food to drift in.";
  else if (thrust) netClass = "A wanderer -- swims around but never eats.";
  else if (reproduce) netClass = "Tries to divide but can't sustain itself (no eat path).";
  else netClass = "Has actions, but no eat path.";

  // Metabolism axis. Every cell metabolizes at baseline (post-Phase-4a
  // uncatRate floor); a cell's "identity" now lives in which reaction
  // slots it boosts via SYNTH CAT. Read those + the trophic ops to
  // describe the cell.
  let metabolism: string;
  if (isPhotoauto && (predate || engulf)) {
    metabolism = "predatory autotroph (boosts photosynth + extracts from prey)";
  } else if (isPhotoauto) {
    const haveAa = catalystSlots.includes(SLOT_SYNTH_AA);
    metabolism = haveAa
      ? "photoautotroph (boosts photosynth + synth_aa)"
      : "photoautotroph (boosts photosynth but not synth_aa -- aa supply rate-limited at baseline)";
  } else if ((predate || engulf) && !ingests) {
    metabolism = "obligate predator";
  } else if (predate || engulf) {
    metabolism = "predator-grazer hybrid";
  } else if (ingests) {
    const haveDigest = boostsDigest;
    const haveEnz = catalystSlots.includes(SLOT_SYNTH_ENZ);
    metabolism = (haveDigest || haveEnz)
      ? "heterotroph (boosts digestion / enzyme synth)"
      : "heterotroph (runs digestion at baseline only)";
  } else if (catalystSlots.length > 0) {
    metabolism = "specialist (boosts " + catalystSlots.slice(0, 3).map((s) => SLOT_NAMES[s] ?? `slot ${s}`).join(", ") + ")";
  } else {
    metabolism = "no trophic input -- can't acquire mass";
  }
  bullets.push("- Metabolism: " + metabolism + ".");

  bullets.push("- Catalysts: " + (catalystSlots.length > 0
    ? `boosts slot${catalystSlots.length === 1 ? "" : "s"} ${catalystSlots.slice(0, 8).sort((a, b) => a - b).map((s) => `${s}${SLOT_NAMES[s] ? ` (${SLOT_NAMES[s]})` : ""}`).join(", ")}${catalystSlots.length > 8 ? `, +${catalystSlots.length - 8} more` : ""}.`
    : "no SYNTH CAT -- runs every reaction at baseline only."));
  if (inhibitorSlots.length > 0) {
    bullets.push("- Inhibitors: damps slot" + (inhibitorSlots.length === 1 ? "" : "s") + " " + inhibitorSlots.slice(0, 8).sort((a, b) => a - b).map((s) => `${s}${SLOT_NAMES[s] ? ` (${SLOT_NAMES[s]})` : ""}`).join(", ") + ".");
  }

  // Warnings: structural issues that make the lineage doomed under
  // the current biology. Quiet (no warnings line) if the genome
  // checks out.
  const warnings: string[] = [];
  if (isHetero && !thrust) {
    warnings.push("heterotroph without THRUST -- can't chase new food patches once the local pool is exhausted.");
  }
  if (isPhotoauto && !boostsMembrane && !boostsDigest) {
    // Photoautotroph without any biosynth boost -- everything runs at
    // uncatRate floor; the cell can survive but won't outcompete a
    // baseline cell.
    warnings.push("photoautotroph with no growth-pathway boost -- metabolizes at baseline only; no genome-specific edge.");
  }
  void boostsDigest; void boostsMembrane;
  if (warnings.length > 0) {
    bullets.push("- Warnings: " + warnings.join(" "));
  }

  let fate: string;
  if (!ingests && !predate && !engulf) {
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
    : thrust && ingests
    ? "swims and eats"
    : ingests
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
    thrust, turn, ingests, excreteMaterials,
    reproduce, predate, engulf, selfModifies,
    sensors, capabilities,
    catalystSlots, inhibitorSlots, metabolism, warnings, oneLine,
    verdict: lines.join("\n"),
  };
}

// Coding-only identity hash: the bytes of every GENE..END span (in
// order, gene boundaries marked), ignoring introns. Two genomes with
// the same genes but different non-coding filler share this key, so it
// measures FUNCTIONAL diversity rather than neutral intron drift. A
// genome with no genes hashes to the empty string.
//
// Memoized by genome OBJECT identity: a creature's genome Uint8Array is
// stable until somatic mutation / fission replaces it with a new array,
// so per-step (extinction + founder gate) and per-frame (HUD) callers
// hit the cache instead of re-walking the bytes. Pure memoization --
// same bytes always hash the same -- so no determinism impact.
const _codingKeyCache = new WeakMap<Uint8Array, string>();
export function genomeCodingKey(genome: Uint8Array): string {
  const cached = _codingKeyCache.get(genome);
  if (cached !== undefined) return cached;
  let s = "";
  let inGene = false;
  for (let i = 0; i < genome.length; i++) {
    const b = genome[i];
    if (!inGene) {
      if (b === OP.GENE) { inGene = true; s += "|"; }
      continue;
    }
    if (b === OP.END) { inGene = false; continue; }
    if (b === OP.GENE) { s += "|"; continue; } // back-to-back gene
    s += (b < 16 ? "0" : "") + b.toString(16);
  }
  _codingKeyCache.set(genome, s);
  return s;
}

// Gene-aware disassembly. The VM only executes bytes inside a GENE..END
// span, so the listing mirrors that: GENE/END are flush markers, gene-
// body ops are indented and operand-decoded, and intron bytes (outside
// any gene) are shown raw as `db 0xNN  ; intron` byte-by-byte -- exactly
// how the scanner steps over them. SYNTH renders both operands.
export function disassemble(genome: Uint8Array, materialNames?: ReadonlyArray<string>): string {
  const lines: string[] = [];
  let i = 0;
  let executing = false;
  while (i < genome.length) {
    const op = genome[i];
    const off = i.toString(16).padStart(4, "0") + ": ";
    if (!executing) {
      // Scanning region (intron). Only GENE has meaning here; every
      // other byte is skipped one at a time (operands are NOT consumed
      // since nothing executes), so render byte-by-byte. Known op bytes
      // still show their mnemonic + an "; intron" marker; truly unknown
      // bytes fall back to `db`.
      if (op === OP.GENE) { lines.push(off + "gene"); executing = true; }
      else {
        const nm = NAME_BY_OP[op];
        lines.push(off + "  " + (nm ? nm.toLowerCase() : "db 0x" + op.toString(16).padStart(2, "0")) + "  ; intron");
      }
      i += 1;
      continue;
    }
    // Inside a gene.
    if (op === OP.END) { lines.push(off + "end"); executing = false; i += 1; continue; }
    if (op === OP.GENE) { lines.push(off + "gene"); i += 1; continue; }
    const name = NAME_BY_OP[op];
    const operandLen = OPERANDS[op];
    let s = off + "  ";
    if (name) {
      s += name.toLowerCase();
      if (op === OP.SYNTH) {
        const kind = i + 1 < genome.length ? genome[i + 1] : 0;
        const param = i + 2 < genome.length ? genome[i + 2] : 0;
        const kindName = SYNTH_KIND_NAME[kind % SYNTH_KIND_COUNT] ?? String(kind);
        s += " " + kindName + " " + param;
      } else if (operandLen === 1 && i + 1 < genome.length) {
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
// cells whose VM doesn't run -- their HGT / adhesion intent is locked
// to whichever non-CAT/INH SYNTH kinds happen to appear in their
// genome. (CAT and INH use parallel masks; they're not represented
// in synthMask.)
export function genomeSynthMask(genome: Uint8Array): number {
  let mask = 0;
  walkGenome(genome, (op, _pc, operand) => {
    if (op !== OP.SYNTH || operand === undefined) return;
    const kind = operand % SYNTH_KIND_COUNT;
    if (kind === SYNTH_KIND.BOND) mask |= 1 << SYNTH_BIT_BOND;
    else if (kind === SYNTH_KIND.COMPETENCE) mask |= 1 << SYNTH_BIT_COMPETENCE;
    else if (kind === SYNTH_KIND.PACKAGE) mask |= 1 << SYNTH_BIT_PACKAGE;
  }, true);
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
// After Phase 4a all named biosynth reactions (synth_bio/aa/fa/enz/chl/
// mrna/photo*/thermo/mech/magneto) run on every cell at uncatRate
// unconditionally. There is no longer a SYNTH op that "declares the
// pathway" -- the cell either has the SUBSTRATES at hand (which is the
// trophic question) or it doesn't. Photosynthesis specifically still
// needs intracellular chl, but chl synth itself fires at baseline, so
// presence-of-SYNTH-CHL is not a viability gate either.
//
// The actual viability requirements collapse to:
//   - hasReproduce: REPRODUCE op. A cell that can never fission is
//     evolutionarily dead.
//   - hasSense:     any SENSE_* / SELF_* op. A cell that can't read
//                   state can only emit constant behavior.
//   - has-a-mass-source: INGEST/PREDATE/ENGULF for heterotrophy, OR
//                        nothing -- photosynth runs at baseline on any
//                        cell, so "sit and photosynthesise" is a valid
//                        strategy with no genome ops required.
//   - heterotroph + THRUST: motile mass acquisition. Without THRUST a
//                           heterotroph can't chase a new food patch
//                           once it's exhausted the local ambient.
//                           (Autotrophs are exempt -- sun reaches them
//                           where they sit.)
export function viableGenome(genome: Uint8Array): boolean {
  let hasIngest = false, hasPredate = false, hasEngulf = false;
  let hasReproduce = false;
  let hasSense = false;
  let hasThrust = false;
  // Only EXPRESSED ops count -- a REPRODUCE or SENSE buried in an
  // intron never executes, so it can't make the genome viable.
  walkGenome(genome, (op) => {
    if (op === OP.INGEST) hasIngest = true;
    else if (op === OP.PREDATE) hasPredate = true;
    else if (op === OP.ENGULF) hasEngulf = true;
    else if (op === OP.REPRODUCE) hasReproduce = true;
    else if (op === OP.THRUST) hasThrust = true;
    if (!hasSense && SENSE_OPS.has(op)) hasSense = true;
  }, true);
  if (!hasReproduce || !hasSense) return false;
  const isHeterotroph = hasIngest || hasPredate || hasEngulf;
  if (isHeterotroph && !hasThrust) return false;
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


// Catalyst slots a founder might invest in -- the post-Phase-4a
// equivalent of "what kind of cell is this." Importing the numeric
// values directly to keep this module free of the sim/reactions
// import cycle (genome.ts is consumed by sim.ts -- a back-edge would
// make startup order load-bearing). Mirror these by hand if reactions
// renumber; assertions in tests guard the mapping.
const FOUNDER_CAT_SLOTS = [
  3,  // photosynth: only meaningful if cell has chl (which it makes at baseline)
  4,  // synth_aa
  5,  // synth_fa
  6,  // synth_chl
  7,  // synth_enz
  9,  // synth_membrane (aa+fa)
  10, // biopolymer digestion
  11, // synth_membrane (fa-only)
] as const;

// Chem ids / reaction-slot numbers used by the founder gene pool below.
// genome.ts must stay free of the chem-ids/reactions import cycle (same
// reason as FOUNDER_CAT_SLOTS), so these mirror the canonical constants
// by hand; genome.test.ts asserts the mapping holds.
export const FOUNDER_GENE_REFS = {
  // chem-ids.ts
  CO2: 1, GLU: 2, FA: 4, MIN: 5, WASTE: 7, MRNA: 10, BIOPOLYMER: 11,
  ACT_THERMO: 35, MARKER0: 41,
  // chem-ids.ts -- activated sensor chems read via SENSE_CHEMICAL
  ACT_PHOTO_V: 16, ACT_MECH_X: 32, ACT_MECH_Y: 33, ACT_MAG_X: 37, ACT_MAG_Y: 38,
  ACT_PH: 27, ACT_ELECTRO_X: 23, ACT_ELECTRO_Y: 24, ACT_LIGHT_X: 29, ACT_LIGHT_Y: 30,
  ACT_VIB_X: 25, ACT_VIB_Y: 26,
  // reactions.ts named slots
  PHOTOSYNTH: 3, SYNTH_AA: 4, SYNTH_FA: 5, SYNTH_CHL: 6, SYNTH_ENZ: 7,
  SYNTH_MEM: 9, DIGEST_BIOP: 10, SYNTH_THERMO: 20, SYNTH_REPAIR: 23,
  // reactions.ts -- receptor-synth slots driven by SYNTH CAT
  SYNTH_PHOTO_V: 12, SYNTH_ELECTRO: 15, SYNTH_VIBRO: 16, SYNTH_PHRECEPTOR: 17,
  SYNTH_MECH: 19, SYNTH_MAGNETO: 21,
} as const;

// Founder gene pool: each entry is one GENE's worth of op-bytes
// transcribed from a tested archetype module (genome-archetypes.ts). A
// founder splices 2..5 of these (with replacement -- may repeat or mix
// archetypes) into its token list, so it starts with a random handful of
// real behaviors / metabolic identities drawn from across the
// archetypes, shuffled in and intron-framed like every other gene. Each
// gene runs with a cleared stack (per-GENE), so stack effects can't
// corrupt neighbours and any module is safe to splice anywhere.
const FG = FOUNDER_GENE_REFS;
const FOUNDER_GENES: ReadonlyArray<ReadonlyArray<number>> = [
  // photoautotroph (AUTO_KIT): boost photosynthesis + de-novo amino acid
  [OP.SYNTH, SYNTH_KIND.CAT, FG.PHOTOSYNTH, OP.SYNTH, SYNTH_KIND.CAT, FG.SYNTH_AA],
  // heterotroph (HET_KIT): boost enzyme + biopolymer digestion
  [OP.SYNTH, SYNTH_KIND.CAT, FG.SYNTH_ENZ, OP.SYNTH, SYNTH_KIND.CAT, FG.DIGEST_BIOP],
  // forager: climb the biopolymer/detritus gradient
  [OP.SENSE_OUT, FG.BIOPOLYMER, OP.PUSH8, 30, OP.MUL, OP.SWAP, OP.PUSH8, 30, OP.MUL, OP.SWAP, OP.THRUST],
  // miner: climb the mineral gradient
  [OP.SENSE_OUT, FG.MIN, OP.PUSH8, 24, OP.MUL, OP.SWAP, OP.PUSH8, 24, OP.MUL, OP.SWAP, OP.THRUST],
  // thermophile: build thermoreceptor, thrust ~ act_thermo^3 toward the isotherm
  [OP.SYNTH, SYNTH_KIND.CAT, FG.SYNTH_THERMO, OP.SENSE_CHEMICAL, FG.ACT_THERMO, OP.DUP, OP.DUP, OP.MUL, OP.MUL, OP.DUP, OP.THRUST],
  // heat-shock tolerance (thermophile/chemolith): synth repair chaperone
  [OP.SYNTH, SYNTH_KIND.CAT, FG.SYNTH_REPAIR],
  // lipogenesis + membrane: boost fatty-acid + membrane synthesis
  [OP.SYNTH, SYNTH_KIND.CAT, FG.SYNTH_FA, OP.SYNTH, SYNTH_KIND.CAT, FG.SYNTH_MEM],
  // primary-producer pigment: chlorophyll synthesis
  [OP.SYNTH, SYNTH_KIND.CAT, FG.SYNTH_CHL],
  // predator: strike on contact
  [OP.PREDATE],
  // engulfer: take up smaller cells / particles
  [OP.ENGULF],
  // allelopath: vent waste + CO2 as a toxin (EXCRETE-ing them also
  // confers self-resistance to that toxin)
  [OP.SENSE_CHEMICAL, FG.WASTE, OP.EXCRETE, FG.WASTE, OP.SENSE_CHEMICAL, FG.CO2, OP.EXCRETE, FG.CO2],
  // beacon: shed a marker0 plume others can sense/home on
  [OP.SENSE_CHEMICAL, FG.MARKER0, OP.EXCRETE, FG.MARKER0],
  // differentiated colony: skew mRNA toward the mother at fission
  [OP.PUSH8, 0xFF, OP.PARTITION, FG.MRNA],
  // metabolic sensing identity: read the glucose pool
  [OP.SENSE_CHEMICAL, FG.GLU],
];

// Sense+behavior gene pool: each entry is ONE complete gene that both
// SENSES and ACTS on what it senses (the per-gene cleared stack wires the
// sensor's output straight into THRUST/REPRODUCE). makeRandomViableGenome
// guarantees every founder gets 1..3 DISTINCT entries, so a fresh founder
// genuinely perceives and responds rather than drifting with a dangling
// sensor. Spans modalities: chemotaxis (SENSE_OUT particle gradient -- no
// receptor needed), thermo/magneto/mechano/photo (SYNTH the receptor in
// the same gene, then read its activated chem). Vector taxis pushes
// ax then ay so THRUST (pops ay,ax) drives along the gradient; the scale
// constants size raw gradient/activation into a usable thrust.
const SB_SCALE = 30;
// climb a particle-field gradient (SENSE_OUT pushes gx,gy; *s both; THRUST up-grad)
const chemoSeek = (chem: number): number[] =>
  [OP.SENSE_OUT, chem, OP.PUSH8, SB_SCALE, OP.MUL, OP.SWAP, OP.PUSH8, SB_SCALE, OP.MUL, OP.SWAP, OP.THRUST];
// flee down the gradient: negate both components before THRUST
const chemoFlee = (chem: number): number[] =>
  [OP.SENSE_OUT, chem, OP.PUSH8, SB_SCALE, OP.MUL, OP.NEG, OP.SWAP, OP.PUSH8, SB_SCALE, OP.MUL, OP.NEG, OP.SWAP, OP.THRUST];
const SENSE_BEHAVIOR_GENES: ReadonlyArray<ReadonlyArray<number>> = [
  // chemotaxis -- swim up a food / mineral / lipid / kin-marker gradient
  chemoSeek(FG.BIOPOLYMER),
  chemoSeek(FG.MIN),
  chemoSeek(FG.FA),
  chemoSeek(FG.MARKER0),
  // chemo-AVOIDANCE -- flee a waste/toxin plume (also a predator-exhaust cue)
  chemoFlee(FG.WASTE),
  // thermotaxis -- build thermoreceptor, drive hard far from the isotherm
  // (act_thermo^3), barely when close (saves ATP).
  [OP.SYNTH, SYNTH_KIND.CAT, FG.SYNTH_THERMO, OP.SENSE_CHEMICAL, FG.ACT_THERMO,
   OP.DUP, OP.DUP, OP.MUL, OP.MUL, OP.DUP, OP.THRUST],
  // magnetotaxis -- build the compass, swim along the magnetic axis
  // (vertical migration / depth-keeping). ax = mag_x*40, ay = mag_y*40.
  [OP.SYNTH, SYNTH_KIND.CAT, FG.SYNTH_MAGNETO,
   OP.SENSE_CHEMICAL, FG.ACT_MAG_X, OP.PUSH8, 40, OP.MUL,
   OP.SENSE_CHEMICAL, FG.ACT_MAG_Y, OP.PUSH8, 40, OP.MUL, OP.THRUST],
  // mechanotaxis -- build the mechanoreceptor, drift along the net force
  // (rheotaxis: ride currents / disturbance).
  [OP.SYNTH, SYNTH_KIND.CAT, FG.SYNTH_MECH,
   OP.SENSE_CHEMICAL, FG.ACT_MECH_X, OP.PUSH8, 20, OP.MUL,
   OP.SENSE_CHEMICAL, FG.ACT_MECH_Y, OP.PUSH8, 20, OP.MUL, OP.THRUST],
  // photo life-history -- build a photoreceptor, only fission when it's
  // bright enough (act_photo_visible > 2). Couples reproduction to light.
  [OP.SYNTH, SYNTH_KIND.CAT, FG.SYNTH_PHOTO_V,
   OP.SENSE_CHEMICAL, FG.ACT_PHOTO_V, OP.PUSH8, 2, OP.GT, OP.JZ, 1, OP.REPRODUCE],
  // pH life-history -- build a phreceptor, only fission when the local
  // water is NOT too acidic (act_ph < threshold). Couples reproduction to
  // acidity, so the lineage avoids breeding in CO2/vent-acid dead zones.
  [OP.SYNTH, SYNTH_KIND.CAT, FG.SYNTH_PHRECEPTOR,
   OP.SENSE_CHEMICAL, FG.ACT_PH, OP.PUSH8, 20, OP.LT, OP.JZ, 1, OP.REPRODUCE],
  // electrotaxis -- build an electroreceptor, swim toward the bearing of
  // nearby metabolically-active cells (act_electro x/y). Electrolocation:
  // homes on prey/conspecifics by their bioelectric glow. ax then ay.
  [OP.SYNTH, SYNTH_KIND.CAT, FG.SYNTH_ELECTRO,
   OP.SENSE_CHEMICAL, FG.ACT_ELECTRO_X, OP.PUSH8, 30, OP.MUL,
   OP.SENSE_CHEMICAL, FG.ACT_ELECTRO_Y, OP.PUSH8, 30, OP.MUL, OP.THRUST],
  // light vision -- boost the visible photoreceptor, swim toward the
  // reflected-light bearing of nearby cells (act_light x/y). Visual
  // shoaling/aggregation toward sunlit clusters (dark = nothing to see).
  [OP.SYNTH, SYNTH_KIND.CAT, FG.SYNTH_PHOTO_V,
   OP.SENSE_CHEMICAL, FG.ACT_LIGHT_X, OP.PUSH8, 30, OP.MUL,
   OP.SENSE_CHEMICAL, FG.ACT_LIGHT_Y, OP.PUSH8, 30, OP.MUL, OP.THRUST],
  // vibration startle -- build a vibroreceptor, flee AWAY from the bearing
  // of a nearby mover/wake (act_vib x/y, negated): predator-avoidance /
  // escape response. Pairs against fast swimmers.
  [OP.SYNTH, SYNTH_KIND.CAT, FG.SYNTH_VIBRO,
   OP.SENSE_CHEMICAL, FG.ACT_VIB_X, OP.PUSH8, 30, OP.MUL, OP.NEG,
   OP.SENSE_CHEMICAL, FG.ACT_VIB_Y, OP.PUSH8, 30, OP.MUL, OP.NEG, OP.THRUST],
];

// Viable-by-construction founder genome. After Phase 4a a viable cell
// just needs REPRODUCE + a SENSE op (+ THRUST for heterotrophs). We
// assemble those, plus a randomized handful of `SYNTH CAT <slot>`
// boosts that give each founder some metabolic identity, plus
// optional adhesion + HGT toggles. Every founder is a distinct genome
// (token order, picked slots, gate threshold, size, junk filler all
// randomized).
export function makeRandomViableGenome(
  rng: () => number = Math.random,
): Uint8Array | null {
  // Gated REPRODUCE: instead of a bare (unconditional) REPRODUCE that
  // fires every tick and makes every new lineage balloon then
  // boom/bust, wrap it in a randomized resource gate:
  //   SELF_ENERGY|SELF_MEMBRANE ; PUSH8 thresh ; GT ; JZ +1 ; REPRODUCE
  // i.e. only fission once the chosen reserve clears a per-founder
  // random threshold. Kept as one atomic token so the JZ +1 skip
  // stays aligned through the shuffle; threshold + which reserve are
  // randomized per founder, and mutation/selection tune it from there.
  // Always gate on SELF_MEMBRANE (not energy). Reproduction halves the
  // cell's pools into the daughter, so dividing must be a STRUCTURAL
  // readiness check: an energy-gated cell would fission whenever ATP was
  // high regardless of membrane, birthing daughters below the membrane
  // viability floor (the dominant death). SELF_MASS was rejected because
  // it's dominated by the ~conserved ADP+ATP pool, a poor readiness
  // signal. Gating on membrane at a threshold of 8..23 means a 50/50
  // split leaves each daughter membrane 4..11.5 -- well clear of the 0.5
  // floor -- so offspring get a fighting chance; mutation/selection tune
  // the threshold per lineage from here.
  const repThresh = 8 + Math.floor(rng() * 16); // 8..23, positive i8
  const repSensor = OP.SELF_MEMBRANE;
  const tokens: number[][] = [
    [repSensor, OP.PUSH8, repThresh, OP.GT, OP.JZ, 1, OP.REPRODUCE],
    [OP.PUSH8, 4, OP.INGEST], // low bond-energy threshold -> eats detritus
    [OP.THRUST],
    [OP.SENSE_CHEMICAL, Math.floor(rng() * CHEMICAL_COUNT)],
  ];
  // 2..4 random catalyst boosts -- the cell's metabolic identity. Each
  // boost picks one slot from FOUNDER_CAT_SLOTS uniformly with
  // replacement (overlap is fine; doubling up on a slot just means
  // more catalyst protein for that reaction).
  const nCat = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < nCat; i++) {
    const slot = FOUNDER_CAT_SLOTS[Math.floor(rng() * FOUNDER_CAT_SLOTS.length)];
    tokens.push([OP.SYNTH, SYNTH_KIND.CAT, slot]);
  }
  // A fraction of founders are adhesive. The SYNTH BOND param byte is
  // the cell's greenbeard marker: a random tag here, inherited by the
  // whole clonal lineage (fission copies the genome) so descendants
  // recognize each other and form colonies, while distinct founder
  // lineages get distinct tags and stay bond-incompatible. Mutation
  // drifts the tag, letting colonies speciate into tribes over time.
  // Prevalence is env-overridable (ADH_PREV, 0..1) purely so the
  // long-run probe can A/B it; default is the shipped value.
  if (rng() < ADHESION_PREVALENCE) {
    tokens.push([OP.SYNTH, SYNTH_KIND.BOND, Math.floor(rng() * 256)]);
  }
  // Rare HGT: a small fraction get competence (uptake) or package
  // (shed) so eDNA flow is a present-but-rare baseline strategy.
  if (rng() < 0.05) tokens.push([OP.SYNTH, SYNTH_KIND.COMPETENCE, 0]);
  if (rng() < 0.05) tokens.push([OP.SYNTH, SYNTH_KIND.PACKAGE, 0]);
  // Cross-archetype variation: splice 2..5 genes from the archetype pool
  // (with replacement, so a founder may repeat a gene or mix several
  // archetypes). They join the viability tokens before the shuffle, so
  // they land in random order and get intron-framed like everything else.
  const nGenes = 2 + Math.floor(rng() * 4); // 2..5
  for (let i = 0; i < nGenes; i++) {
    tokens.push(FOUNDER_GENES[Math.floor(rng() * FOUNDER_GENES.length)].slice());
  }
  // Guarantee every founder is multi-sensory: 1..3 DISTINCT sense+behavior
  // genes (each wires a sensor straight into THRUST/REPRODUCE). Distinct
  // picks (sample without replacement) => up to three different modalities,
  // so a fresh founder perceives and acts rather than drifting.
  {
    const pool = SENSE_BEHAVIOR_GENES.map((g) => g);
    const nSenses = 1 + Math.floor(rng() * 3); // 1..3
    for (let s = 0; s < nSenses && pool.length > 0; s++) {
      const pick = Math.floor(rng() * pool.length);
      tokens.push(pool[pick].slice());
      pool.splice(pick, 1);
    }
  }
  // Fisher-Yates shuffle so structure differs founder to founder.
  for (let i = tokens.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = tokens[i]; tokens[i] = tokens[j]; tokens[j] = t;
  }
  // Lay the genome out as intron-gene-intron-gene-...-intron: each
  // token becomes its own GENE..END span, separated (and book-ended) by
  // random-length introns. Introns are neutral non-coding filler (the
  // VM skips them), so they give mutation a safe place to land and a
  // reservoir of bytes to exonize later. Founder length runs high
  // (many introns up to 20b each); selection trims it over generations.
  const out: number[] = [];
  // Per-founder intron budget: larger on average and more variable across
  // founders than the old fixed 0..20 cap, so founder genome SIZE has a
  // wide spread (some lean, some sprawling). Selection trims it over time.
  const intronMax = 16 + Math.floor(rng() * 48); // per-founder cap 16..63
  const emitIntron = (): void => {
    const len = Math.floor(rng() * (intronMax + 1)); // 0..intronMax bytes
    for (let i = 0; i < len; i++) {
      // Any byte EXCEPT a GENE codon, so the founder's gene structure
      // is exactly as designed (an accidental GENE in an intron would
      // start an unintended gene). END in an intron is harmless (the
      // scanner ignores everything but GENE).
      let b = Math.floor(rng() * 256);
      if (b === OP.GENE) b = OP.NOP;
      out.push(b);
    }
  };
  for (const tk of tokens) {
    emitIntron();
    out.push(OP.GENE);
    for (const byte of tk) out.push(byte);
    out.push(OP.END);
  }
  emitIntron();
  return new Uint8Array(out);
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
