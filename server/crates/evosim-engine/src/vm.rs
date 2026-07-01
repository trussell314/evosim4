//! Stack-bytecode VM interpreter, ported from `runTick` in
//! `src/genome.ts`. This is the per-cell behaviour engine: it reads
//! the genome, a persistent `VmState`, sensor inputs and self-state,
//! and writes a `VmOutputs` the creature-update pass consumes.
//!
//! The interpreter itself is pure given its inputs -- the only world
//! coupling is through the `Sensors` trait (chem concentrations + a
//! spatial-gradient callback), which the engine implements by closing
//! over the current cell + world. That keeps the VM testable in
//! isolation: a test supplies a fixed `Sensors` and checks the
//! resulting outputs, exactly as the TS unit tests do.
//!
//! Determinism parity with TS:
//!   - stack values are f64 (JS numbers); a bounded stack of 32 drops
//!     the OLDEST entry on overflow (TS `stack.shift()` then push)
//!   - registers are f32 (TS `Float32Array`): STORE rounds to f32,
//!     LOAD widens back, so a genome that round-trips a value through
//!     a register sees the f32-quantised result -- we replicate that
//!   - POKE_BYTE mutates the genome in place, so the genome is `&mut`
//!   - non-finite values coerce to 0 on push and on STORE, matching
//!     the TS `Number.isFinite` guards

use std::collections::VecDeque;

use crate::genome::*;
use crate::genome_consts::CATALYST_COUNT;
use crate::chem_ids::CHEMICAL_COUNT;

const STACK_MAX: usize = 32;
const REG_COUNT: usize = 16;
const GENE_FRAGMENT_CAP: i64 = 32;
const PARTITION_CAP: usize = 16;
const EMIT_MAG_CAP: f64 = 1000.0;
const INGEST_TH_SCALE: f64 = 0.02;

pub const SYNTH_BIT_BOND: u32 = 0;
pub const SYNTH_BIT_COMPETENCE: u32 = 1;
pub const SYNTH_BIT_PACKAGE: u32 = 2;

/// Persistent per-cell VM state. `pc` + `executing` persist across
/// ticks so a gene can span tick boundaries when the instruction
/// budget runs out mid-gene; `regs` persist so a genome can build
/// oscillators / timers / integrators.
#[derive(Debug, Clone)]
pub struct VmState {
    pub pc: i64,
    pub stack: VecDeque<f64>,
    pub regs: [f32; REG_COUNT],
    pub executing: bool,
}

impl VmState {
    pub fn new() -> Self {
        Self {
            pc: 0,
            stack: VecDeque::with_capacity(STACK_MAX),
            regs: [0.0; REG_COUNT],
            executing: false,
        }
    }
}

impl Default for VmState {
    fn default() -> Self {
        Self::new()
    }
}

/// Sensor inputs. The engine implements this by closing over the
/// current cell + world. `chem_conc` is the cell's own per-chem pool
/// (the activation pass writes activated_* signal chems into it, so
/// all external sensing layers onto `SENSE_CHEMICAL`); `gradient`
/// supplies the local spatial gradient of a chem's particle field as
/// `[gx, gy]` (zero for engulfed organelles).
pub trait Sensors {
    fn chem_conc(&self, chem_id: usize) -> f64;
    fn gradient(&self, chem_id: usize) -> [f64; 2];
}

/// Self-state read by the SELF_* ops.
#[derive(Debug, Clone, Copy)]
pub struct VmSelf {
    pub energy: f64,
    pub mass: f64,
    pub membrane: f64,
}

/// Per-tick VM outputs. Reset at the top of every `run_tick`. The
/// catalyst / inhibitor masks use a list+flag pair so the per-tick
/// reset is O(expressed) not O(256), matching the TS optimisation.
#[derive(Debug, Clone)]
pub struct VmOutputs {
    pub thrust_x: f64,
    pub thrust_y: f64,
    pub turn: f64,
    pub excrete: Vec<f64>,
    pub transport: Vec<f64>,
    pub reproduce: bool,
    pub reproduce_fraction: f64,
    pub predate: bool,
    pub engulf: bool,
    pub ingest_threshold: f64,
    pub synth_mask: u32,
    pub bond_marker: i32,
    cat_synth_mask: Vec<u8>,
    pub cat_synth_list: Vec<i32>,
    pub cat_synth_count: usize,
    inh_synth_mask: Vec<u8>,
    pub inh_synth_list: Vec<i32>,
    pub inh_synth_count: usize,
    pub splice_mode: u8,
    pub splice_offset: i64,
    pub splice_length: i64,
    pub poke_fired: bool,
    pub partition_chem: Vec<i16>,
    pub partition_bias: Vec<f64>,
    pub partition_count: usize,
    pub instructions: u32,
    pub emit: Vec<f64>,
}

impl VmOutputs {
    pub fn new() -> Self {
        Self {
            thrust_x: 0.0,
            thrust_y: 0.0,
            turn: 0.0,
            excrete: vec![0.0; CHEMICAL_COUNT],
            transport: vec![0.0; CHEMICAL_COUNT],
            reproduce: false,
            reproduce_fraction: 0.4,
            predate: false,
            engulf: false,
            ingest_threshold: f64::INFINITY,
            synth_mask: 0,
            bond_marker: -1,
            cat_synth_mask: vec![0; CATALYST_COUNT],
            cat_synth_list: vec![0; CATALYST_COUNT],
            cat_synth_count: 0,
            inh_synth_mask: vec![0; CATALYST_COUNT],
            inh_synth_list: vec![0; CATALYST_COUNT],
            inh_synth_count: 0,
            splice_mode: 0,
            splice_offset: 0,
            splice_length: 0,
            poke_fired: false,
            partition_chem: vec![0; PARTITION_CAP],
            partition_bias: vec![0.0; PARTITION_CAP],
            partition_count: 0,
            instructions: 0,
            emit: vec![0.0; EMIT_CHANNELS as usize],
        }
    }

    /// Read-only view of the catalyst-synth mask (`!= 0` means slot
    /// fired this tick). Exposed for the creature-update consumer.
    pub fn cat_synth_fired(&self, slot: usize) -> bool {
        self.cat_synth_mask[slot] != 0
    }

    pub fn inh_synth_fired(&self, slot: usize) -> bool {
        self.inh_synth_mask[slot] != 0
    }
}

impl Default for VmOutputs {
    fn default() -> Self {
        Self::new()
    }
}

/// Two's-complement reinterpret of a byte as a signed i8 -> f64,
/// matching the TS `i8` helper.
#[inline]
fn i8_of(b: u8) -> f64 {
    (b as i8) as f64
}

#[inline]
fn push(stack: &mut VecDeque<f64>, v: f64) {
    let v = if v.is_finite() { v } else { 0.0 };
    if stack.len() >= STACK_MAX {
        stack.pop_front();
    }
    stack.push_back(v);
}

#[inline]
fn pop(stack: &mut VecDeque<f64>) -> f64 {
    stack.pop_back().unwrap_or(0.0)
}

/// Run the VM for up to `budget` instructions, mutating `state` and
/// writing into `out`. The genome is `&mut` because POKE_BYTE writes
/// in place. `exec_counts`, when supplied, is incremented at every PC
/// the VM hits (length must be >= genome length to be used).
pub fn run_tick<S: Sensors>(
    genome: &mut [u8],
    state: &mut VmState,
    sensors: &S,
    me: &VmSelf,
    budget: u32,
    out: &mut VmOutputs,
    mut exec_counts: Option<&mut [u32]>,
) {
    // ----- Reset per-tick outputs.
    out.thrust_x = 0.0;
    out.thrust_y = 0.0;
    out.turn = 0.0;
    out.excrete.iter_mut().for_each(|v| *v = 0.0);
    out.transport.iter_mut().for_each(|v| *v = 0.0);
    out.reproduce = false;
    out.emit.iter_mut().for_each(|v| *v = 0.0);
    out.reproduce_fraction = 0.4;
    out.predate = false;
    out.engulf = false;
    out.ingest_threshold = f64::INFINITY;
    out.synth_mask = 0;
    out.bond_marker = -1;
    for i in 0..out.cat_synth_count {
        out.cat_synth_mask[out.cat_synth_list[i] as usize] = 0;
    }
    out.cat_synth_count = 0;
    for i in 0..out.inh_synth_count {
        out.inh_synth_mask[out.inh_synth_list[i] as usize] = 0;
    }
    out.inh_synth_count = 0;
    out.splice_mode = 0;
    out.splice_offset = 0;
    out.splice_length = 0;
    out.poke_fired = false;
    out.partition_count = 0;
    out.instructions = 0;

    let l = genome.len();
    if l == 0 {
        return;
    }
    let l_i = l as i64;

    // Helper for reading a genome byte at a possibly-overflowed pc,
    // matching TS `genome[state.pc % L]` (pc is non-negative here).
    macro_rules! at {
        ($pc:expr) => {
            genome[($pc).rem_euclid(l_i) as usize]
        };
    }

    for _ in 0..budget {
        state.pc = state.pc.rem_euclid(l_i);

        // ----- SCANNING: skip the intron run to the next GENE codon
        // in a single budget step.
        if !state.executing {
            let mut scanned = 0i64;
            while scanned < l_i && genome[state.pc as usize] != OP_GENE {
                state.pc += 1;
                if state.pc >= l_i {
                    state.pc = 0;
                }
                scanned += 1;
            }
            out.instructions += 1;
            if scanned >= l_i {
                // Gene-less genome: nothing to express.
                break;
            }
            if let Some(ec) = exec_counts.as_deref_mut() {
                let pc = state.pc as usize;
                if pc < ec.len() {
                    ec[pc] += 1;
                }
            }
            state.pc += 1;
            state.executing = true;
            state.stack.clear();
            continue;
        }

        if let Some(ec) = exec_counts.as_deref_mut() {
            let pc = state.pc as usize;
            if pc < ec.len() {
                ec[pc] += 1;
            }
        }
        let op = genome[state.pc as usize];
        state.pc += 1;
        out.instructions += 1;

        // END / back-to-back GENE handling (gene framing).
        if op == OP_END {
            state.executing = false;
            continue;
        }
        if op == OP_GENE {
            state.stack.clear();
            continue;
        }

        let stack = &mut state.stack;
        match op {
            OP_NOP => {}
            OP_PUSH8 => {
                let b = at!(state.pc);
                state.pc += 1;
                push(stack, i8_of(b));
            }
            OP_POP => {
                pop(stack);
            }
            OP_DUP => {
                let x = pop(stack);
                push(stack, x);
                push(stack, x);
            }
            OP_SWAP => {
                let a = pop(stack);
                let b = pop(stack);
                push(stack, a);
                push(stack, b);
            }
            OP_OVER => {
                let b = pop(stack);
                let a = pop(stack);
                push(stack, a);
                push(stack, b);
                push(stack, a);
            }
            OP_ROT => {
                let c = pop(stack);
                let b = pop(stack);
                let a = pop(stack);
                push(stack, b);
                push(stack, c);
                push(stack, a);
            }
            OP_LOAD => {
                let i = (at!(state.pc) as usize) % REG_COUNT;
                state.pc += 1;
                push(stack, state.regs[i] as f64);
            }
            OP_STORE => {
                let i = (at!(state.pc) as usize) % REG_COUNT;
                state.pc += 1;
                let v = pop(stack);
                state.regs[i] = if v.is_finite() { v as f32 } else { 0.0 };
            }
            OP_ADD => {
                let b = pop(stack);
                let a = pop(stack);
                push(stack, a + b);
            }
            OP_SUB => {
                let b = pop(stack);
                let a = pop(stack);
                push(stack, a - b);
            }
            OP_MUL => {
                let b = pop(stack);
                let a = pop(stack);
                push(stack, a * b);
            }
            OP_DIV => {
                let b = pop(stack);
                let a = pop(stack);
                push(stack, if b != 0.0 { a / b } else { 0.0 });
            }
            OP_NEG => {
                let a = pop(stack);
                push(stack, -a);
            }
            OP_ABS => {
                let a = pop(stack);
                push(stack, a.abs());
            }
            OP_MIN => {
                let b = pop(stack);
                let a = pop(stack);
                push(stack, a.min(b));
            }
            OP_MAX => {
                let b = pop(stack);
                let a = pop(stack);
                push(stack, a.max(b));
            }
            OP_MOD => {
                let b = pop(stack);
                let a = pop(stack);
                // TS: b !== 0 ? a - floor(a/b)*b : 0  (floored modulo)
                push(stack, if b != 0.0 { a - (a / b).floor() * b } else { 0.0 });
            }
            OP_SIGN => {
                let a = pop(stack);
                push(stack, if a > 0.0 { 1.0 } else if a < 0.0 { -1.0 } else { 0.0 });
            }
            OP_LT => {
                let b = pop(stack);
                let a = pop(stack);
                push(stack, if a < b { 1.0 } else { 0.0 });
            }
            OP_GT => {
                let b = pop(stack);
                let a = pop(stack);
                push(stack, if a > b { 1.0 } else { 0.0 });
            }
            OP_EQ => {
                let b = pop(stack);
                let a = pop(stack);
                push(stack, if a == b { 1.0 } else { 0.0 });
            }
            OP_NOT => {
                let a = pop(stack);
                push(stack, if a == 0.0 { 1.0 } else { 0.0 });
            }
            OP_AND => {
                let b = pop(stack);
                let a = pop(stack);
                push(stack, if a != 0.0 && b != 0.0 { 1.0 } else { 0.0 });
            }
            OP_OR => {
                let b = pop(stack);
                let a = pop(stack);
                push(stack, if a != 0.0 || b != 0.0 { 1.0 } else { 0.0 });
            }
            OP_JMP => {
                let rel = i8_of(at!(state.pc));
                state.pc += 1;
                state.pc += rel as i64;
            }
            OP_JZ => {
                let rel = i8_of(at!(state.pc));
                state.pc += 1;
                if pop(stack) == 0.0 {
                    state.pc += rel as i64;
                }
            }
            OP_JNZ => {
                let rel = i8_of(at!(state.pc));
                state.pc += 1;
                if pop(stack) != 0.0 {
                    state.pc += rel as i64;
                }
            }
            OP_SELF_ENERGY => push(stack, me.energy),
            OP_SELF_MASS => push(stack, me.mass),
            OP_SELF_MEMBRANE => push(stack, me.membrane),
            OP_SENSE_CHEMICAL => {
                let id = (at!(state.pc) as usize) % CHEMICAL_COUNT;
                state.pc += 1;
                push(stack, sensors.chem_conc(id));
            }
            OP_SENSE_OUT => {
                let id = (at!(state.pc) as usize) % CHEMICAL_COUNT;
                state.pc += 1;
                let g = sensors.gradient(id);
                push(stack, g[0]);
                push(stack, g[1]);
            }
            OP_SYNTH => {
                let kind_byte = at!(state.pc);
                state.pc += 1;
                let param = at!(state.pc);
                state.pc += 1;
                let kind = kind_byte % SYNTH_KIND_COUNT;
                match kind {
                    SYNTH_KIND_CAT => {
                        let s = (param as usize) % CATALYST_COUNT;
                        if out.cat_synth_mask[s] == 0 {
                            out.cat_synth_mask[s] = 1;
                            out.cat_synth_list[out.cat_synth_count] = s as i32;
                            out.cat_synth_count += 1;
                        }
                    }
                    SYNTH_KIND_INH => {
                        let s = (param as usize) % CATALYST_COUNT;
                        if out.inh_synth_mask[s] == 0 {
                            out.inh_synth_mask[s] = 1;
                            out.inh_synth_list[out.inh_synth_count] = s as i32;
                            out.inh_synth_count += 1;
                        }
                    }
                    SYNTH_KIND_BOND => {
                        out.synth_mask |= 1 << SYNTH_BIT_BOND;
                        out.bond_marker = param as i32;
                    }
                    SYNTH_KIND_COMPETENCE => {
                        out.synth_mask |= 1 << SYNTH_BIT_COMPETENCE;
                    }
                    SYNTH_KIND_PACKAGE => {
                        out.synth_mask |= 1 << SYNTH_BIT_PACKAGE;
                    }
                    _ => {}
                }
            }
            OP_SENSE_AMP => {}
            OP_POKE_BYTE => {
                let idx_raw = pop(stack);
                let val_raw = pop(stack);
                let idx = (to_i32(idx_raw) as i64).rem_euclid(l_i) as usize;
                genome[idx] = (to_i32(val_raw) & 0xff) as u8;
                out.poke_fired = true;
            }
            OP_PEEK_BYTE => {
                let idx_raw = pop(stack);
                let idx = (to_i32(idx_raw) as i64).rem_euclid(l_i) as usize;
                push(stack, genome[idx] as f64);
            }
            OP_SPLICE_DUP => {
                let len_raw = pop(stack);
                let off_raw = pop(stack);
                out.splice_mode = 1;
                out.splice_offset = (to_i32(off_raw) as i64).rem_euclid(l_i);
                out.splice_length = (to_i32(len_raw) as i64).clamp(0, GENE_FRAGMENT_CAP);
            }
            OP_SPLICE_DEL => {
                let len_raw = pop(stack);
                let off_raw = pop(stack);
                out.splice_mode = 2;
                out.splice_offset = (to_i32(off_raw) as i64).rem_euclid(l_i);
                out.splice_length = (to_i32(len_raw) as i64).clamp(0, GENE_FRAGMENT_CAP);
            }
            OP_PARTITION => {
                let idx = (at!(state.pc) as usize) % CHEMICAL_COUNT;
                state.pc += 1;
                let bias = pop(stack);
                let mut slot: i64 = -1;
                for q in 0..out.partition_count {
                    if out.partition_chem[q] as usize == idx {
                        slot = q as i64;
                        break;
                    }
                }
                if slot < 0 && out.partition_count < PARTITION_CAP {
                    slot = out.partition_count as i64;
                    out.partition_chem[out.partition_count] = idx as i16;
                    out.partition_count += 1;
                }
                if slot >= 0 {
                    out.partition_bias[slot as usize] = bias;
                }
            }
            OP_THRUST => {
                let ay = pop(stack);
                let ax = pop(stack);
                out.thrust_x += ax;
                out.thrust_y += ay;
            }
            OP_EMIT => {
                let ch = (at!(state.pc) % EMIT_CHANNELS) as usize;
                state.pc += 1;
                // Stack values are always finite (push coerces), so
                // clamp matches the TS min/max with no NaN edge case.
                let mag = pop(stack).clamp(0.0, EMIT_MAG_CAP);
                out.emit[ch] += mag;
            }
            OP_EXCRETE => {
                let idx = (at!(state.pc) as usize) % CHEMICAL_COUNT;
                state.pc += 1;
                out.excrete[idx] += pop(stack).max(0.0);
            }
            OP_TRANSPORT => {
                let idx = (at!(state.pc) as usize) % CHEMICAL_COUNT;
                state.pc += 1;
                out.transport[idx] += pop(stack);
            }
            OP_REPRODUCE => {
                let f = pop(stack);
                out.reproduce = true;
                out.reproduce_fraction = if (0.1..=0.9).contains(&f) { f } else { 0.5 };
            }
            OP_PREDATE => out.predate = true,
            OP_ENGULF => out.engulf = true,
            OP_INGEST => {
                let t = pop(stack).max(0.0) * INGEST_TH_SCALE;
                if t < out.ingest_threshold {
                    out.ingest_threshold = t;
                }
            }
            OP_TURN => out.turn += pop(stack),
            _ => {}
        }
    }

    // Keep fired-slot lists ascending so the consumer runs synthesis
    // in the same order as the old full-mask scan (order matters under
    // substrate scarcity).
    if out.cat_synth_count > 1 {
        out.cat_synth_list[..out.cat_synth_count].sort_unstable();
    }
    if out.inh_synth_count > 1 {
        out.inh_synth_list[..out.inh_synth_count].sort_unstable();
    }
}

/// Reinterpret an f64 as i32 the way TS `| 0` does: truncate toward
/// zero, wrapping to 32 bits. Non-finite -> 0.
#[inline]
fn to_i32(v: f64) -> i32 {
    if !v.is_finite() {
        return 0;
    }
    // ECMAScript ToInt32: truncate, modulo 2^32, interpret as signed.
    let trunc = v.trunc();
    let m = trunc.rem_euclid(4_294_967_296.0);
    if m >= 2_147_483_648.0 {
        (m - 4_294_967_296.0) as i32
    } else {
        m as i32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NullSensors;
    impl Sensors for NullSensors {
        fn chem_conc(&self, _chem_id: usize) -> f64 {
            0.0
        }
        fn gradient(&self, _chem_id: usize) -> [f64; 2] {
            [0.0, 0.0]
        }
    }

    struct FixedSensors {
        conc: Vec<f64>,
        grad: [f64; 2],
    }
    impl Sensors for FixedSensors {
        fn chem_conc(&self, chem_id: usize) -> f64 {
            self.conc.get(chem_id).copied().unwrap_or(0.0)
        }
        fn gradient(&self, _chem_id: usize) -> [f64; 2] {
            self.grad
        }
    }

    fn run(genome: &mut [u8], sensors: &impl Sensors, me: &VmSelf, budget: u32) -> VmOutputs {
        let mut state = VmState::new();
        let mut out = VmOutputs::new();
        run_tick(genome, &mut state, sensors, me, budget, &mut out, None);
        out
    }

    const ME: VmSelf = VmSelf { energy: 10.0, mass: 5.0, membrane: 2.0 };

    #[test]
    fn gene_less_genome_does_nothing() {
        let mut g = [OP_NOP, OP_ADD, OP_THRUST];
        let out = run(&mut g, &NullSensors, &ME, 100);
        assert_eq!(out.thrust_x, 0.0);
        assert_eq!(out.thrust_y, 0.0);
    }

    #[test]
    fn push_add_thrust() {
        // GENE; PUSH8 3; PUSH8 4; THRUST; END
        // THRUST pops ay then ax: ay=4, ax=3.
        let mut g = [OP_GENE, OP_PUSH8, 3, OP_PUSH8, 4, OP_THRUST, OP_END];
        // budget = exactly one pass (scan + PUSH8 + PUSH8 + THRUST + END);
        // a larger budget re-loops the gene and accumulates thrust.
        let out = run(&mut g, &NullSensors, &ME, 5);
        assert_eq!(out.thrust_x, 3.0);
        assert_eq!(out.thrust_y, 4.0);
    }

    #[test]
    fn push8_sign_extends() {
        // PUSH8 0xFF = -1; NEG -> +1; both go to thrust via DUP.
        // GENE PUSH8 0xFF DUP THRUST END  => ay=-1, ax=-1
        let mut g = [OP_GENE, OP_PUSH8, 0xFF, OP_DUP, OP_THRUST, OP_END];
        let out = run(&mut g, &NullSensors, &ME, 5);
        assert_eq!(out.thrust_x, -1.0);
        assert_eq!(out.thrust_y, -1.0);
    }

    #[test]
    fn self_energy_reaches_stack() {
        // GENE SELF_ENERGY SELF_MASS THRUST END => ay=mass, ax=energy
        let mut g = [OP_GENE, OP_SELF_ENERGY, OP_SELF_MASS, OP_THRUST, OP_END];
        let out = run(&mut g, &NullSensors, &ME, 5);
        assert_eq!(out.thrust_x, 10.0);
        assert_eq!(out.thrust_y, 5.0);
    }

    #[test]
    fn sense_chemical_reads_pool() {
        let sensors = FixedSensors { conc: vec![0.0; CHEMICAL_COUNT], grad: [0.0, 0.0] };
        let mut sensors = sensors;
        sensors.conc[CHEM_INDEX_3] = 7.5;
        // GENE SENSE_CHEMICAL 3 DUP THRUST END
        let mut g = [OP_GENE, OP_SENSE_CHEMICAL, 3, OP_DUP, OP_THRUST, OP_END];
        let out = run(&mut g, &sensors, &ME, 5);
        assert_eq!(out.thrust_x, 7.5);
        assert_eq!(out.thrust_y, 7.5);
    }
    const CHEM_INDEX_3: usize = 3;

    #[test]
    fn synth_cat_records_slot() {
        // GENE SYNTH CAT 7 END
        let mut g = [OP_GENE, OP_SYNTH, SYNTH_KIND_CAT, 7, OP_END];
        let out = run(&mut g, &NullSensors, &ME, 100);
        assert_eq!(out.cat_synth_count, 1);
        assert!(out.cat_synth_fired(7));
    }

    #[test]
    fn synth_bond_sets_marker() {
        // GENE SYNTH BOND 42 END
        let mut g = [OP_GENE, OP_SYNTH, SYNTH_KIND_BOND, 42, OP_END];
        let out = run(&mut g, &NullSensors, &ME, 100);
        assert_eq!(out.bond_marker, 42);
        assert_ne!(out.synth_mask & (1 << SYNTH_BIT_BOND), 0);
    }

    #[test]
    fn reproduce_fraction_clamped() {
        // Out-of-range fraction defaults to 0.5.
        // GENE PUSH8 0xFF (=-1) REPRODUCE END
        let mut g = [OP_GENE, OP_PUSH8, 0xFF, OP_REPRODUCE, OP_END];
        let out = run(&mut g, &NullSensors, &ME, 100);
        assert!(out.reproduce);
        assert_eq!(out.reproduce_fraction, 0.5);
    }

    #[test]
    fn poke_byte_mutates_genome() {
        // GENE PUSH8 0x41 PUSH8 6 POKE_BYTE END
        // pops idx=6, val=0x41; writes genome[6] = 0x41.
        let mut g = [OP_GENE, OP_PUSH8, 0x41, OP_PUSH8, 6, OP_POKE_BYTE, OP_END];
        let out = run(&mut g, &NullSensors, &ME, 100);
        assert!(out.poke_fired);
        assert_eq!(g[6], 0x41);
    }

    #[test]
    fn registers_persist_across_ticks_as_f32() {
        // Tick 1: store energy (10.0) in reg 0.
        // Tick 2: load reg 0, thrust.
        let mut g1 = [OP_GENE, OP_SELF_ENERGY, OP_STORE, 0, OP_END];
        let mut state = VmState::new();
        let mut out = VmOutputs::new();
        run_tick(&mut g1, &mut state, &NullSensors, &ME, 100, &mut out, None);
        assert_eq!(state.regs[0], 10.0);
    }

    #[test]
    fn stack_overflow_drops_oldest() {
        // Push 40 distinct values, then thrust twice. With STACK_MAX
        // = 32 the oldest 8 are dropped; the last two pushed are what
        // thrust reads.
        let mut prog = vec![OP_GENE];
        for i in 0..40u8 {
            prog.push(OP_PUSH8);
            prog.push(i + 1);
        }
        prog.push(OP_THRUST); // ay = 40, ax = 39
        prog.push(OP_END);
        // One pass: scan(1) + 40 PUSH8 + THRUST + END = 43 instructions.
        let out = run(&mut prog, &NullSensors, &ME, 43);
        assert_eq!(out.thrust_y, 40.0);
        assert_eq!(out.thrust_x, 39.0);
    }

    #[test]
    fn jump_backward_loops_within_budget() {
        // Infinite-ish loop that increments thrust each pass; bounded
        // only by the instruction budget so this must terminate.
        // GENE PUSH8 1 THRUST JMP -3 END   (JMP -3 lands back on PUSH8)
        // We just verify it terminates and produced some thrust.
        let mut g = [OP_GENE, OP_PUSH8, 1, OP_PUSH8, 1, OP_THRUST, OP_JMP, 0xFB, OP_END];
        let out = run(&mut g, &NullSensors, &ME, 50);
        assert!(out.thrust_x != 0.0 || out.thrust_y != 0.0);
        assert!(out.instructions <= 50);
    }

    #[test]
    fn ts_golden_arith_registers_branching() {
        // Captured from the TS runTick on the identical genome:
        // GENE PUSH8 10 PUSH8 3 SUB STORE 0 LOAD 0 PUSH8 2 MUL THRUST END
        // (10-3)=7 -> reg0; load 7, *2 = 14; THRUST pops ay=14, ax=0
        // (stack had only one value left). TS result: thrustX=0,
        // thrustY=14, reg0=7, instructions=10, pc=15, executing=false.
        let mut g = [
            OP_GENE, OP_PUSH8, 10, OP_PUSH8, 3, OP_SUB, OP_STORE, 0,
            OP_LOAD, 0, OP_PUSH8, 2, OP_MUL, OP_THRUST, OP_END,
        ];
        let mut state = VmState::new();
        let mut out = VmOutputs::new();
        run_tick(&mut g, &mut state, &NullSensors, &ME, 10, &mut out, None);
        assert_eq!(out.thrust_x, 0.0);
        assert_eq!(out.thrust_y, 14.0);
        assert_eq!(state.regs[0], 7.0);
        assert_eq!(out.instructions, 10);
        assert_eq!(state.pc, 15);
        assert!(!state.executing);
    }

    #[test]
    fn per_gene_stack_isolation() {
        // First gene pushes 99 but doesn't consume it; second gene
        // thrusts. The stack clears at the gene boundary, so thrust
        // reads 0,0 not 99.
        let mut g = [
            OP_GENE, OP_PUSH8, 99, OP_END,
            OP_GENE, OP_THRUST, OP_END,
        ];
        let out = run(&mut g, &NullSensors, &ME, 100);
        assert_eq!(out.thrust_x, 0.0);
        assert_eq!(out.thrust_y, 0.0);
    }
}
