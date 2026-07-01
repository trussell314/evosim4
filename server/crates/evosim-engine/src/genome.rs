//! Genome VM static surface, ported from `src/genome.ts`. This is the
//! scaffold the rest of the VM hangs off: opcode constants, the
//! per-op operand-length table, the genome walker, and the
//! intron-stripping helpers (`coding_key`, `species_key`,
//! `coding_bytes`).
//!
//! The interpreter (`run_tick`, mutation, fission, splicing) lands in
//! a future commit -- it needs creature state and chemistry that the
//! port hasn't reached yet. Everything here is pure (slice in -> ID/
//! string out), so it can ship now and the rest of the engine can
//! depend on it without waiting for the messy interpreter pieces.

// ----- Opcodes. Match `src/genome.ts` OP table byte-for-byte; the
// genome ABI depends on these positions, so do not renumber. The
// retired opcodes documented in the TS source are deliberately
// omitted here -- the bytes decode to NOP at the operand-table level.

pub const OP_NOP: u8 = 0x00;
pub const OP_PUSH8: u8 = 0x01;
pub const OP_POP: u8 = 0x02;
pub const OP_DUP: u8 = 0x03;
pub const OP_SWAP: u8 = 0x04;
pub const OP_OVER: u8 = 0x05;
pub const OP_ROT: u8 = 0x06;
pub const OP_LOAD: u8 = 0x07;
pub const OP_STORE: u8 = 0x08;

pub const OP_ADD: u8 = 0x10;
pub const OP_SUB: u8 = 0x11;
pub const OP_MUL: u8 = 0x12;
pub const OP_DIV: u8 = 0x13;
pub const OP_NEG: u8 = 0x14;
pub const OP_ABS: u8 = 0x15;
pub const OP_MIN: u8 = 0x16;
pub const OP_MAX: u8 = 0x17;
pub const OP_MOD: u8 = 0x18;
pub const OP_SIGN: u8 = 0x19;

pub const OP_LT: u8 = 0x20;
pub const OP_GT: u8 = 0x21;
pub const OP_EQ: u8 = 0x22;
pub const OP_NOT: u8 = 0x23;
pub const OP_AND: u8 = 0x24;
pub const OP_OR: u8 = 0x25;

pub const OP_JMP: u8 = 0x30;
pub const OP_JZ: u8 = 0x31;
pub const OP_JNZ: u8 = 0x32;

pub const OP_SELF_ENERGY: u8 = 0x43;
pub const OP_SELF_MASS: u8 = 0x4B;
pub const OP_SELF_MEMBRANE: u8 = 0x4D;

pub const OP_THRUST: u8 = 0x50;
pub const OP_EXCRETE: u8 = 0x51;
pub const OP_REPRODUCE: u8 = 0x52;
pub const OP_PREDATE: u8 = 0x53;
pub const OP_TURN: u8 = 0x54;
pub const OP_ENGULF: u8 = 0x55;
pub const OP_TRANSPORT: u8 = 0x56;
pub const OP_INGEST: u8 = 0x5E;
pub const OP_EMIT: u8 = 0x60;
pub const OP_SENSE_AMP: u8 = 0x64;
pub const OP_POKE_BYTE: u8 = 0x65;
pub const OP_SPLICE_DUP: u8 = 0x66;
pub const OP_SPLICE_DEL: u8 = 0x67;
pub const OP_PARTITION: u8 = 0x68;
pub const OP_SYNTH: u8 = 0x69;

/// Gene framing -- `GENE..END` is the executable span. Bytes
/// outside any gene are introns; the VM advances byte-by-byte
/// without parsing operands, so an indent inside an intron drifts
/// the rest of THAT intron's bytes but the next `GENE` re-syncs.
pub const OP_GENE: u8 = 0x6A;
pub const OP_END: u8 = 0x6B;

pub const OP_PEEK_BYTE: u8 = 0x6a; // intentionally aliases GENE in the TS
                                   // source. Decoder ordering in walk_genome
                                   // resolves the conflict at gene boundaries
                                   // (gene framing wins; PEEK_BYTE bytes
                                   // inside a gene are interpreted as PEEK).

pub const OP_SENSE_OUT: u8 = 0x6E;
pub const OP_SENSE_CHEMICAL: u8 = 0x6F;

// ----- Operand lengths. Looked up by op-byte in the hot loop;
// matches TS `OPERANDS` byte table.

pub const OPERANDS: [u8; 256] = {
    let mut t = [0u8; 256];
    t[OP_PUSH8 as usize] = 1;
    t[OP_JMP as usize] = 1;
    t[OP_JZ as usize] = 1;
    t[OP_JNZ as usize] = 1;
    t[OP_EXCRETE as usize] = 1;
    t[OP_TRANSPORT as usize] = 1;
    t[OP_LOAD as usize] = 1;
    t[OP_STORE as usize] = 1;
    t[OP_SENSE_CHEMICAL as usize] = 1;
    t[OP_SENSE_OUT as usize] = 1;
    t[OP_PARTITION as usize] = 1;
    t[OP_EMIT as usize] = 1;
    t[OP_SYNTH as usize] = 2;
    t
};

// ----- SYNTH kinds. Match `SYNTH_KIND` in TS.

pub const SYNTH_KIND_CAT: u8 = 0;
pub const SYNTH_KIND_INH: u8 = 1;
pub const SYNTH_KIND_BOND: u8 = 2;
pub const SYNTH_KIND_COMPETENCE: u8 = 3;
pub const SYNTH_KIND_PACKAGE: u8 = 4;
pub const SYNTH_KIND_COUNT: u8 = 5;

pub fn synth_kind_name(k: u8) -> &'static str {
    match k % SYNTH_KIND_COUNT {
        SYNTH_KIND_CAT => "cat",
        SYNTH_KIND_INH => "inh",
        SYNTH_KIND_BOND => "bond",
        SYNTH_KIND_COMPETENCE => "competence",
        SYNTH_KIND_PACKAGE => "package",
        _ => unreachable!(),
    }
}

// ----- EMIT channels.

pub const EMIT_CHANNELS: u8 = 4;
pub const EMIT_CHANNEL_ELECTRIC: u8 = 0;
pub const EMIT_CHANNEL_LIGHT: u8 = 1;
pub const EMIT_CHANNEL_VIBRATION: u8 = 2;
pub const EMIT_CHANNEL_MAGNETIC: u8 = 3;

pub fn emit_channel_name(ch: u8) -> &'static str {
    match ch % EMIT_CHANNELS {
        EMIT_CHANNEL_ELECTRIC => "electric",
        EMIT_CHANNEL_LIGHT => "light",
        EMIT_CHANNEL_VIBRATION => "vibration",
        EMIT_CHANNEL_MAGNETIC => "magnetic",
        _ => unreachable!(),
    }
}

/// Per-op execution control returned by `walk_genome`'s visitor. The
/// visitor returns `Action::Continue` to keep walking or `Break` to
/// stop early (matches the TS `void | "break"` return shape).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Continue,
    Break,
}

/// Walk the genome and call the visitor for each opcode position.
///
/// `expressed_only = false` (default) walks every byte, used by the
/// disassembler which must render introns + codons too. `true`
/// mirrors the VM's gene framing: skip intron bytes outside any
/// `GENE..END` span, and skip the `GENE` / `END` codons themselves,
/// so the visitor sees exactly the ops that would execute.
///
/// `operand` is the FIRST operand byte for any op with >= 1 operand
/// (e.g. SYNTH's kind byte; the second operand is read separately by
/// callers that need it), or `None` for zero-operand ops.
pub fn walk_genome<F>(genome: &[u8], expressed_only: bool, mut visit: F)
where
    F: FnMut(u8, usize, Option<u8>) -> Action,
{
    let mut i = 0usize;
    let mut executing = !expressed_only;
    while i < genome.len() {
        let op = genome[i];
        if expressed_only && !executing {
            if op == OP_GENE {
                executing = true;
            }
            i += 1;
            continue;
        }
        if expressed_only {
            if op == OP_END {
                executing = false;
                i += 1;
                continue;
            }
            if op == OP_GENE {
                i += 1;
                continue;
            }
        }
        let operand_len = OPERANDS[op as usize] as usize;
        let operand = if operand_len >= 1 && i + 1 < genome.len() {
            Some(genome[i + 1])
        } else {
            None
        };
        if visit(op, i, operand) == Action::Break {
            return;
        }
        i += 1 + operand_len;
    }
}

/// Coding key: the gene-bodies-only flat string used as the
/// per-genome identity hash. `|` separates back-to-back genes.
/// Base sense radius in world pixels for a genome with zero
/// SENSE_AMP bytes. Matches TS `SENSE_BASE`.
pub const SENSE_BASE: f32 = 80.0;
/// Pixels of sense range per sqrt(SENSE_AMP count). Matches TS
/// `SENSE_PER_AMP`. Sub-linear scaling so a genome can't trivially
/// max out its sense by stuffing SENSE_AMP bytes -- diminishing
/// returns means a cell pays for breadth, not stacking.
pub const SENSE_PER_AMP: f32 = 30.0;

/// Compute the per-cell sense range from a genome. Counts SENSE_AMP
/// bytes anywhere in the genome (not just expressed code) and uses
/// sqrt scaling. Matches TS `computeSenseRange`.
pub fn compute_sense_range(genome: &[u8]) -> f32 {
    let mut amps: u32 = 0;
    for &b in genome {
        if b == OP_SENSE_AMP {
            amps += 1;
        }
    }
    SENSE_BASE + SENSE_PER_AMP * (amps as f32).sqrt()
}

/// Lower-case hex; back-to-back-`GENE` produces a `||`. A gene-less
/// genome yields the empty string.
pub fn coding_key(genome: &[u8]) -> String {
    let mut s = String::new();
    let mut in_gene = false;
    for &b in genome {
        if !in_gene {
            if b == OP_GENE {
                in_gene = true;
                s.push('|');
            }
            continue;
        }
        if b == OP_END {
            in_gene = false;
            continue;
        }
        if b == OP_GENE {
            // Back-to-back genes -- stay executing, mark boundary.
            s.push('|');
            continue;
        }
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// Species key: order-independent, intron-independent SET of genes.
/// Used to bucket cells into species (two cells are the same species
/// iff they carry the same multiset of gene bodies, regardless of
/// order or any intron drift between them).
pub fn species_key(genome: &[u8]) -> String {
    let mut genes: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut cur = String::new();
    let mut in_gene = false;
    for &b in genome {
        if !in_gene {
            if b == OP_GENE {
                in_gene = true;
                cur.clear();
            }
            continue;
        }
        if b == OP_END {
            genes.insert(std::mem::take(&mut cur));
            in_gene = false;
            continue;
        }
        if b == OP_GENE {
            genes.insert(std::mem::take(&mut cur));
            continue;
        }
        cur.push_str(&format!("{:02x}", b));
    }
    if in_gene {
        genes.insert(cur);
    }
    genes.into_iter().collect::<Vec<_>>().join("|")
}

/// Flat byte sequence of the gene-bodies-only payload. Back-to-back
/// genes are separated by a single `0xff` sentinel so a byte can't
/// bridge two genes when a caller computes an edit distance.
pub fn coding_bytes(genome: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut in_gene = false;
    for &b in genome {
        if !in_gene {
            if b == OP_GENE {
                in_gene = true;
                if !out.is_empty() {
                    out.push(0xff);
                }
            }
            continue;
        }
        if b == OP_END {
            in_gene = false;
            continue;
        }
        if b == OP_GENE {
            out.push(0xff);
            continue;
        }
        out.push(b);
    }
    out
}

/// True iff the op uses its first operand as a reaction-slot index
/// (modulo `N_REACTIONS`). The disassembler labels these specially.
pub fn is_reaction_slot_op(op: u8) -> bool {
    op == OP_SYNTH // SYNTH cat/inh take a slot byte as the second operand;
                    // the disassembler still surfaces it for cat/inh
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operand_table_matches_ts() {
        // Spot-check the entries against the TS OPERANDS table.
        assert_eq!(OPERANDS[OP_PUSH8 as usize], 1);
        assert_eq!(OPERANDS[OP_SYNTH as usize], 2);
        assert_eq!(OPERANDS[OP_SENSE_OUT as usize], 1);
        assert_eq!(OPERANDS[OP_NOP as usize], 0);
        assert_eq!(OPERANDS[OP_INGEST as usize], 0);
        // Unmapped opcodes default to 0 (treated as NOP at parse time).
        assert_eq!(OPERANDS[0xCC], 0);
    }

    #[test]
    fn walk_full_visits_every_byte_position() {
        // Genome: PUSH8 5; GENE; THRUST; END; NOP
        let g = [OP_PUSH8, 5, OP_GENE, OP_THRUST, OP_END, OP_NOP];
        let mut seen: Vec<(u8, usize, Option<u8>)> = Vec::new();
        walk_genome(&g, false, |op, pc, operand| {
            seen.push((op, pc, operand));
            Action::Continue
        });
        // PUSH8@0 with operand 5; GENE@2; THRUST@3; END@4; NOP@5.
        assert_eq!(seen.len(), 5);
        assert_eq!(seen[0], (OP_PUSH8, 0, Some(5)));
        assert_eq!(seen[2], (OP_THRUST, 3, None));
    }

    #[test]
    fn walk_expressed_only_skips_introns_and_codons() {
        // PUSH8 5; GENE; THRUST; END; NOP (intron)
        let g = [OP_PUSH8, 5, OP_GENE, OP_THRUST, OP_END, OP_NOP];
        let mut seen: Vec<u8> = Vec::new();
        walk_genome(&g, true, |op, _pc, _operand| {
            seen.push(op);
            Action::Continue
        });
        // Only THRUST is inside the gene body.
        assert_eq!(seen, vec![OP_THRUST]);
    }

    #[test]
    fn walk_break_terminates_early() {
        let g = [OP_NOP, OP_DUP, OP_ADD];
        let mut count = 0usize;
        walk_genome(&g, false, |_op, _pc, _operand| {
            count += 1;
            if count == 2 { Action::Break } else { Action::Continue }
        });
        assert_eq!(count, 2);
    }

    #[test]
    fn compute_sense_range_base_no_amp() {
        // No SENSE_AMP bytes -> SENSE_BASE.
        let g = vec![OP_GENE, OP_PUSH8, 0, OP_THRUST, OP_END];
        assert_eq!(compute_sense_range(&g), SENSE_BASE);
    }

    #[test]
    fn compute_sense_range_grows_with_amps() {
        // 1 SENSE_AMP -> SENSE_BASE + SENSE_PER_AMP * sqrt(1) = 80 + 30
        let g = vec![OP_GENE, OP_SENSE_AMP, OP_PUSH8, 0, OP_THRUST, OP_END];
        assert!((compute_sense_range(&g) - (SENSE_BASE + SENSE_PER_AMP)).abs() < 1e-3);
    }

    #[test]
    fn compute_sense_range_sublinear() {
        // 4 SENSE_AMP -> SENSE_BASE + SENSE_PER_AMP * 2 = 80 + 60 = 140.
        let g = vec![
            OP_GENE,
            OP_SENSE_AMP, OP_SENSE_AMP, OP_SENSE_AMP, OP_SENSE_AMP,
            OP_END,
        ];
        let r = compute_sense_range(&g);
        assert!((r - (SENSE_BASE + SENSE_PER_AMP * 2.0)).abs() < 1e-3);
    }

    #[test]
    fn coding_key_strips_introns() {
        // [intron NOP] GENE THRUST PUSH8 5 END [intron]
        let g = [OP_NOP, OP_GENE, OP_THRUST, OP_PUSH8, 5, OP_END, OP_DUP];
        assert_eq!(coding_key(&g), "|500105");
    }

    #[test]
    fn coding_key_separates_back_to_back_genes() {
        // GENE A END GENE B END
        let g = [OP_GENE, 0x10, OP_END, OP_GENE, 0x11, OP_END];
        assert_eq!(coding_key(&g), "|10|11");
    }

    #[test]
    fn species_key_is_order_independent() {
        let a = [OP_GENE, 0x10, OP_END, OP_GENE, 0x11, OP_END];
        let b = [OP_GENE, 0x11, OP_END, OP_GENE, 0x10, OP_END];
        assert_eq!(species_key(&a), species_key(&b));
    }

    #[test]
    fn species_key_dedups_gene_dosage() {
        // Same gene twice -> one set entry.
        let a = [OP_GENE, 0x10, OP_END];
        let b = [OP_GENE, 0x10, OP_END, OP_GENE, 0x10, OP_END];
        assert_eq!(species_key(&a), species_key(&b));
    }

    #[test]
    fn coding_bytes_separates_with_ff() {
        let g = [OP_GENE, 0x10, OP_END, OP_GENE, 0x11, OP_END];
        let bytes = coding_bytes(&g);
        assert_eq!(bytes, vec![0x10, 0xff, 0x11]);
    }

    #[test]
    fn emit_channel_name_round_trips() {
        assert_eq!(emit_channel_name(EMIT_CHANNEL_LIGHT), "light");
        // Wrap by modulo.
        assert_eq!(emit_channel_name(EMIT_CHANNELS + EMIT_CHANNEL_VIBRATION), "vibration");
    }

    #[test]
    fn synth_kind_name_round_trips() {
        assert_eq!(synth_kind_name(SYNTH_KIND_CAT), "cat");
        assert_eq!(synth_kind_name(SYNTH_KIND_PACKAGE), "package");
        // Wrap by modulo.
        assert_eq!(synth_kind_name(SYNTH_KIND_COUNT + SYNTH_KIND_BOND), "bond");
    }

    #[test]
    fn n_reactions_visible_for_disasm() {
        // Sanity-check the cross-module dep so a reactions/genome
        // mismatch trips here, not in some downstream consumer.
        let _ = crate::genome_consts::N_REACTIONS;
    }
}
