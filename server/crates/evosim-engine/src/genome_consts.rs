//! ABI-locked constants from `src/genome.ts`. These bind the genome
//! bytecode space and the per-cell reaction-slot count; both are
//! observed by every other engine module that touches catalyst pools,
//! reaction dispatch, or VM operands, so we lift them into their own
//! module instead of waiting on the full VM port.
//!
//! Only constants that the reactions / chemistry / particle modules
//! need before the VM lands belong here. Resist the temptation to dump
//! everything from `genome.ts`; the VM has its own port commit.

/// Per-cell catalyst pool count. Each pool gates one reaction slot;
/// see `src/genome.ts` for the SYNTH-CAT mechanism that grows it.
pub const CATALYST_COUNT: usize = 256;

/// Reaction-table size = catalyst-pool size, by definition. The
/// reaction-table builder fills exactly this many slots; the named
/// head overwrites the bottom rows. See `src/sim/reactions.ts`.
pub const N_REACTIONS: usize = CATALYST_COUNT;

/// First N reactions are hand-authored (respiration, photosynth, the
/// synth-* family). Generic procedural reactions fill the rest.
pub const NAMED_REACTION_COUNT: usize = 26;

/// Number of carbon-fix variants the reaction builder installs on top
/// of the procedural region. Distinct from `NAMED_REACTION_COUNT`
/// because they're inserted *after* the named head, not in it.
pub const CARBON_FIX_COUNT: usize = 8;

/// Number of generic transport reactions installed at the tail of the
/// table. Each transports one chemical across a membrane the cell owns.
pub const GENERIC_TRANSPORT_COUNT: usize = 16;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn n_reactions_matches_catalyst_count() {
        // The TS source enforces this with `export const N_REACTIONS =
        // CATALYST_COUNT;`. The contract must not drift.
        assert_eq!(N_REACTIONS, CATALYST_COUNT);
    }

    #[test]
    fn slot_counts_make_sense() {
        // Named + carbon-fix + generic-transport leaves room for the
        // procedurally-generated middle. Reads through `core::hint::black_box`
        // so the const-eval lint doesn't fold the comparison away --
        // we want the assertion to fail if a *future* edit bumps a
        // count past the table size.
        let used = NAMED_REACTION_COUNT + CARBON_FIX_COUNT + GENERIC_TRANSPORT_COUNT;
        assert!(std::hint::black_box(used) < std::hint::black_box(N_REACTIONS));
    }
}
