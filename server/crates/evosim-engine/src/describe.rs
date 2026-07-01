//! Genome describer. Walks a genome's expressed code (intron-skipped)
//! and emits a short English summary suitable for the species
//! inspector. The TS engine has a much richer describer at
//! `src/main.ts::describeGenomeProse`; we ship a focused subset that
//! covers the most behaviour-relevant outputs:
//!
//!   - which trophic / movement / lifecycle ops fire
//!   - which chems the cell senses
//!   - which catalyst / inhibitor slots it boosts / damps
//!   - whether it expresses BOND / COMPETENCE / PACKAGE
//!   - whether it has branching (a cell with JZ/JNZ + LT/GT/EQ is
//!     "conditional"; one without is "always-on")

use crate::chem_ids::CHEMICAL_COUNT;
use crate::chem_ids::slot_name as chem_name;
use crate::genome::{*, Action};
use crate::genome_consts::CATALYST_COUNT;
use crate::reactions;
use std::collections::BTreeSet;

#[derive(Default, Debug)]
struct GenomeProfile {
    thrusts: bool,
    turns: bool,
    reproduces: bool,
    predates: bool,
    engulfs: bool,
    ingests: bool,
    sensors_grad: BTreeSet<u8>,
    sensed_chems: BTreeSet<u8>,
    excretes: BTreeSet<u8>,
    transports: BTreeSet<u8>,
    catalyst_slots: BTreeSet<u8>,
    inhibitor_slots: BTreeSet<u8>,
    bond_marker_set: bool,
    competence_set: bool,
    package_set: bool,
    self_modifies: bool,
    has_jump: bool,
    has_cmp: bool,
}

fn profile(genome: &[u8]) -> GenomeProfile {
    let mut p = GenomeProfile::default();
    walk_genome(genome, true, |op, _pc, operand| {
        match op {
            OP_THRUST => p.thrusts = true,
            OP_TURN => p.turns = true,
            OP_REPRODUCE => p.reproduces = true,
            OP_PREDATE => p.predates = true,
            OP_ENGULF => p.engulfs = true,
            OP_INGEST => p.ingests = true,
            OP_SENSE_OUT => {
                if let Some(o) = operand {
                    p.sensors_grad.insert((o as usize % CHEMICAL_COUNT) as u8);
                }
            }
            OP_SENSE_CHEMICAL => {
                if let Some(o) = operand {
                    p.sensed_chems.insert((o as usize % CHEMICAL_COUNT) as u8);
                }
            }
            OP_EXCRETE => {
                if let Some(o) = operand {
                    p.excretes.insert((o as usize % CHEMICAL_COUNT) as u8);
                }
            }
            OP_TRANSPORT => {
                if let Some(o) = operand {
                    p.transports.insert((o as usize % CHEMICAL_COUNT) as u8);
                }
            }
            OP_SYNTH => {
                if let Some(kind_byte) = operand {
                    let kind = kind_byte % SYNTH_KIND_COUNT;
                    // SYNTH carries two operands; walk_genome only
                    // returns the first via `operand`. For CAT / INH
                    // we want the second. Find it from the next pc.
                    // Walk_genome calls back with the op's pc; for
                    // SYNTH the next byte after `pc + 1` (=operand
                    // byte) is the param. We don't have direct
                    // access here; instead, the walker doesn't expose
                    // it. Settle for noting that a synth op of CAT
                    // or INH fired; the precise slot can be teased
                    // out in a follow-up if needed.
                    match kind {
                        SYNTH_KIND_BOND => p.bond_marker_set = true,
                        SYNTH_KIND_COMPETENCE => p.competence_set = true,
                        SYNTH_KIND_PACKAGE => p.package_set = true,
                        _ => {}
                    }
                }
            }
            OP_POKE_BYTE | OP_SPLICE_DUP | OP_SPLICE_DEL => p.self_modifies = true,
            OP_JZ | OP_JNZ | OP_JMP => p.has_jump = true,
            OP_LT | OP_GT | OP_EQ | OP_NOT | OP_AND | OP_OR => p.has_cmp = true,
            _ => {}
        }
        Action::Continue
    });
    // Second walk for SYNTH's two-operand slot capture, since the
    // single-pass walker only exposes the first operand byte.
    let l = genome.len();
    let mut i = 0usize;
    let mut in_gene = false;
    while i < l {
        let op = genome[i];
        if op == OP_GENE {
            in_gene = true;
            i += 1;
            continue;
        }
        if op == OP_END {
            in_gene = false;
            i += 1;
            continue;
        }
        if !in_gene {
            i += 1;
            continue;
        }
        if op == OP_SYNTH {
            let kind = if i + 1 < l { genome[i + 1] % SYNTH_KIND_COUNT } else { 0 };
            let param = if i + 2 < l { genome[i + 2] } else { 0 };
            if kind == SYNTH_KIND_CAT {
                p.catalyst_slots.insert((param as usize % CATALYST_COUNT) as u8);
            } else if kind == SYNTH_KIND_INH {
                p.inhibitor_slots.insert((param as usize % CATALYST_COUNT) as u8);
            }
            i += 3;
            continue;
        }
        // Skip operand bytes for ops that have them.
        i += match OPERANDS[op as usize] {
            1 => 2,
            2 => 3,
            _ => 1,
        };
    }
    p
}

/// Map a reaction slot to a human label. Named slots get their
/// canonical name; generic procedurally-generated slots get "rxn<n>";
/// transport slots get "transport(<chem>)".
fn reaction_label(slot: usize) -> String {
    if slot >= reactions::TRANSPORT_SLOT_BASE {
        let rxn = &reactions::table()[slot];
        if let Some(chem) = rxn.transport {
            return format!("transport({})", chem_name(chem as usize));
        }
    }
    if slot < reactions::NAMED_REACTION_COUNT {
        match slot {
            0 => "respiration".to_string(),
            1 => "fermentation".to_string(),
            2 => "beta-oxidation".to_string(),
            3 => "photosynthesis".to_string(),
            4 => "synth_aa".to_string(),
            5 => "synth_fa".to_string(),
            6 => "synth_chlorophyll".to_string(),
            7 => "synth_enzyme".to_string(),
            8 => "synth_mrna".to_string(),
            9 => "synth_membrane(aafa)".to_string(),
            10 => "digest_biopolymer".to_string(),
            11 => "synth_membrane(fa)".to_string(),
            12 => "synth_photoreceptor_v".to_string(),
            13 => "synth_photoreceptor_l".to_string(),
            14 => "synth_photoreceptor_s".to_string(),
            15 => "synth_electroreceptor".to_string(),
            16 => "synth_vibroreceptor".to_string(),
            17 => "synth_phreceptor".to_string(),
            19 => "synth_mechanoreceptor".to_string(),
            20 => "synth_thermoreceptor".to_string(),
            21 => "synth_magnetoreceptor".to_string(),
            22 => "synth_bondchem".to_string(),
            23 => "synth_repairchem".to_string(),
            24 => "synth_biopolymer".to_string(),
            25 => "photophosphorylation".to_string(),
            _ => format!("named_rxn[{slot}]"),
        }
    } else {
        format!("rxn[{slot}]")
    }
}

fn chem_list(set: &BTreeSet<u8>) -> String {
    let names: Vec<String> = set.iter().map(|&c| chem_name(c as usize).to_string()).collect();
    names.join(", ")
}

fn slot_list(set: &BTreeSet<u8>) -> String {
    let labels: Vec<String> = set.iter().map(|&s| reaction_label(s as usize)).collect();
    labels.join(", ")
}

/// Multi-line English summary of a genome.
pub fn describe(genome: &[u8]) -> String {
    if genome.is_empty() {
        return "(empty genome)".to_string();
    }
    let p = profile(genome);
    let mut lines: Vec<String> = Vec::new();

    // Trophic + lifecycle behaviours.
    let mut acts: Vec<&str> = Vec::new();
    if p.thrusts {
        acts.push("thrusts");
    }
    if p.turns {
        acts.push("turns");
    }
    if p.ingests {
        acts.push("ingests particles");
    }
    if p.predates {
        acts.push("predates cells");
    }
    if p.engulfs {
        acts.push("engulfs cells");
    }
    if p.reproduces {
        acts.push("reproduces");
    }
    if !acts.is_empty() {
        lines.push(format!("Acts: {}.", acts.join(", ")));
    } else {
        lines.push("Acts: passive (no movement, ingest, or reproduce).".into());
    }

    // Sensing.
    if !p.sensors_grad.is_empty() {
        lines.push(format!("Senses gradient of: {}.", chem_list(&p.sensors_grad)));
    }
    if !p.sensed_chems.is_empty() {
        lines.push(format!("Reads chem pool: {}.", chem_list(&p.sensed_chems)));
    }

    // Chemistry export / import.
    if !p.excretes.is_empty() {
        lines.push(format!("Excretes: {}.", chem_list(&p.excretes)));
    }
    if !p.transports.is_empty() {
        lines.push(format!("Transports (signed): {}.", chem_list(&p.transports)));
    }

    // Catalyst / inhibitor synth.
    if !p.catalyst_slots.is_empty() {
        lines.push(format!("Boosts: {}.", slot_list(&p.catalyst_slots)));
    }
    if !p.inhibitor_slots.is_empty() {
        lines.push(format!("Damps: {}.", slot_list(&p.inhibitor_slots)));
    }
    if p.bond_marker_set {
        lines.push("Expresses BOND (adhesive).".into());
    }
    if p.competence_set {
        lines.push("Expresses COMPETENCE (eDNA uptake).".into());
    }
    if p.package_set {
        lines.push("Expresses PACKAGE (sheds genome fragments).".into());
    }
    if p.self_modifies {
        lines.push("Self-modifying genome (POKE / SPLICE).".into());
    }
    if p.has_jump && p.has_cmp {
        lines.push("Control flow: conditional (branches on sensor values).".into());
    } else if p.has_jump {
        lines.push("Control flow: unconditional jump only.".into());
    } else {
        lines.push("Control flow: linear (no branches).".into());
    }

    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_genome() {
        assert_eq!(describe(&[]), "(empty genome)");
    }

    #[test]
    fn idle_passive_cell() {
        let g = vec![OP_GENE, OP_NOP, OP_END];
        let s = describe(&g);
        assert!(s.contains("passive"), "{s}");
        assert!(s.contains("linear"), "{s}");
    }

    #[test]
    fn swimmer() {
        let g = vec![OP_GENE, OP_PUSH8, 0, OP_PUSH8, 6, OP_THRUST, OP_END];
        let s = describe(&g);
        assert!(s.contains("thrusts"), "{s}");
    }

    #[test]
    fn seeker_summary() {
        let g = vec![OP_GENE, OP_SENSE_OUT, 2, OP_THRUST, OP_END];
        let s = describe(&g);
        assert!(s.contains("gradient"), "{s}");
        assert!(s.contains("glucose"), "{s}");
        assert!(s.contains("thrusts"), "{s}");
    }

    #[test]
    fn reproducer_summary() {
        let g = vec![OP_GENE, OP_PUSH8, 0, OP_REPRODUCE, OP_END];
        let s = describe(&g);
        assert!(s.contains("reproduces"), "{s}");
    }

    #[test]
    fn synth_cat_lists_slot() {
        // GENE SYNTH CAT 3 END -- catalyst slot 3 = photosynth.
        let g = vec![OP_GENE, OP_SYNTH, SYNTH_KIND_CAT, 3, OP_END];
        let s = describe(&g);
        assert!(s.contains("Boosts"), "{s}");
        assert!(s.contains("photosynthesis"), "{s}");
    }

    #[test]
    fn predator_summary() {
        let g = vec![OP_GENE, OP_PREDATE, OP_END];
        let s = describe(&g);
        assert!(s.contains("predates cells"), "{s}");
    }

    #[test]
    fn transport_lists_chem() {
        let g = vec![OP_GENE, OP_PUSH8, 100, OP_TRANSPORT, 2, OP_END];
        let s = describe(&g);
        assert!(s.contains("Transports"), "{s}");
        assert!(s.contains("glucose"), "{s}");
    }
}
