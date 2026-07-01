//! Abiotic chemolithotrophy wiring. Substrate port of
//! `src/sim/chemolith.ts`.
//!
//! Derives, deterministically, from the seeded reaction table:
//!   (a) the reduced-fuel cocktail a hydrothermal vent must emit to
//!       sustain a chemolithoautotroph niche, and
//!   (b) the catalyst slots a chemolithoautotroph evolves to SYNTH
//!       on its genome to live off that fuel.
//!
//! Because the table is built once at module init from fixed seeds,
//! both numbers are constants of the engine -- the vent's fuel
//! cocktail and the shipped archetype's `SYNTH CAT` targets agree by
//! construction; no hand-tuning, the seeded chemistry picks the
//! niche.
//!
//! Energy module: the dark (no light-in), catalyst-gated (uncat_rate=0)
//! exergonic reaction with the highest ATP throughput (`atp_delta * vmax`)
//! whose substrates are all acquirable AND include at least one
//! generic chem (so it genuinely depends on vent fuel rather than
//! ambient inorganics alone).
//!
//! Carbon module: the dark, catalyst-gated reaction that produces the
//! most glucose per second (yield * vmax) from acquirable inputs.

use crate::chem_ids::{CHEM_CO2, CHEM_GLU, CHEM_MIN, CHEM_O2, NAMED_CHEMICAL_COUNT};
use crate::reactions::{table as reactions_table, Reaction};

/// Inorganics the open world already supplies everywhere (so a
/// reaction needing only these plus vent generics is runnable at
/// the vent).
fn is_ambient_inorganic(chem: usize) -> bool {
    chem == CHEM_O2 || chem == CHEM_CO2 || chem == CHEM_MIN
}

/// A chem is "acquirable" if it's a generic (any procedural chem) or
/// one of the ambient inorganics.
fn acquirable(chem: usize) -> bool {
    chem >= NAMED_CHEMICAL_COUNT || is_ambient_inorganic(chem)
}

/// Generic substrate ids of a reaction.
fn generic_subs(rxn: &Reaction) -> Vec<usize> {
    rxn.s_chem
        .iter()
        .map(|&c| c as usize)
        .filter(|&c| c >= NAMED_CHEMICAL_COUNT)
        .collect()
}

/// True if every substrate of `rxn` is acquirable from the world +
/// vent fuel pool.
fn all_acquirable(rxn: &Reaction) -> bool {
    if rxn.s_chem.is_empty() {
        return false;
    }
    rxn.s_chem.iter().all(|&c| acquirable(c as usize))
}

fn pick_energy_slot() -> i32 {
    let table = reactions_table();
    let mut best: i32 = -1;
    let mut score = 0.0_f32;
    for (k, r) in table.iter().enumerate() {
        if r.uncat_rate != 0.0 || r.atp_delta <= 0.0 || r.light_in != 0.0 {
            continue;
        }
        if !all_acquirable(r) || generic_subs(r).is_empty() {
            continue;
        }
        let s = r.atp_delta * r.vmax;
        if s > score {
            score = s;
            best = k as i32;
        }
    }
    best
}

fn pick_carbon_slot() -> i32 {
    let table = reactions_table();
    let mut best: i32 = -1;
    let mut score = -1.0_f32;
    for (k, r) in table.iter().enumerate() {
        if r.uncat_rate != 0.0 || r.light_in != 0.0 {
            continue;
        }
        if !all_acquirable(r) {
            continue;
        }
        let gi = r
            .p_chem
            .iter()
            .position(|&c| c as usize == CHEM_GLU);
        let Some(gi) = gi else { continue };
        let s = r.p_count[gi] * r.vmax;
        if s > score {
            score = s;
            best = k as i32;
        }
    }
    best
}

/// The chemolithoautotroph's energy catalyst slot. `< 0` if no
/// suitable exergonic generic-substrate reaction was seeded.
pub fn energy_slot() -> i32 {
    static SLOT: std::sync::OnceLock<i32> = std::sync::OnceLock::new();
    *SLOT.get_or_init(pick_energy_slot)
}

/// The chemolithoautotroph's carbon-fixation catalyst slot. `< 0` if
/// no GLU-producing acquirable-input reaction was seeded.
pub fn carbon_slot() -> i32 {
    static SLOT: std::sync::OnceLock<i32> = std::sync::OnceLock::new();
    *SLOT.get_or_init(pick_carbon_slot)
}

/// The reduced generic chems the vent must emit: the union of the
/// energy and carbon modules' generic substrates. Ambient inorganics
/// (CO2 / O2 / MIN) are supplied by the world, not the vent.
pub fn vent_fuel_chems() -> Vec<usize> {
    static FUEL: std::sync::OnceLock<Vec<usize>> = std::sync::OnceLock::new();
    FUEL.get_or_init(|| {
        let table = reactions_table();
        let mut set = std::collections::BTreeSet::new();
        let energy = energy_slot();
        if energy >= 0 {
            for c in generic_subs(&table[energy as usize]) {
                set.insert(c);
            }
        }
        let carbon = carbon_slot();
        if carbon >= 0 {
            for c in generic_subs(&table[carbon as usize]) {
                set.insert(c);
            }
        }
        set.into_iter().collect()
    })
    .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn energy_slot_resolves() {
        // The seeded table should contain at least one exergonic
        // generic-substrate dark reaction; if it doesn't this test
        // catches a chemistry-table change that broke chemolithotrophy.
        let s = energy_slot();
        assert!(
            s >= 0,
            "expected an energy slot in the seeded reaction table"
        );
        // The picked slot must satisfy the eligibility rules.
        let r = &reactions_table()[s as usize];
        assert_eq!(r.uncat_rate, 0.0);
        assert!(r.atp_delta > 0.0);
        assert_eq!(r.light_in, 0.0);
        assert!(all_acquirable(r));
        assert!(!generic_subs(r).is_empty());
    }

    #[test]
    fn carbon_slot_resolves() {
        let s = carbon_slot();
        assert!(s >= 0, "expected a carbon-fix slot");
        let r = &reactions_table()[s as usize];
        assert_eq!(r.uncat_rate, 0.0);
        assert_eq!(r.light_in, 0.0);
        assert!(all_acquirable(r));
        let has_glu = r
            .p_chem
            .iter()
            .any(|&c| c as usize == CHEM_GLU);
        assert!(has_glu);
    }

    #[test]
    fn vent_fuel_chems_are_generics() {
        let fuel = vent_fuel_chems();
        for c in &fuel {
            assert!(
                *c >= NAMED_CHEMICAL_COUNT,
                "vent fuel chem {c} should be a generic (>= NAMED_CHEMICAL_COUNT)"
            );
        }
    }
}
