//! Per-cell reaction driver, ported from `runGenericReactions` in
//! `src/sim/cell-reactions.ts`. Reads the cell's chem + catalyst +
//! inhibitor pools, walks every reaction slot, fires substrates ->
//! products under Michaelis-Menten saturation, and credits / debits
//! ATP as the slot's `atp_delta` requires.
//!
//! What's NOT here yet (kept honest for the next consumer ports):
//!   - transport reactions: those are intra-pool here only (we skip
//!     any slot with `transport.is_some()`); the cell <-> world
//!     applier lands when regions/ambient ports
//!   - light gating beyond an ambient scalar -- a real per-cell
//!     light value lands with the surface/depth port
//!   - reaction recording: the TS records every firing for the
//!     ledger / inspector; we drop those calls and add them back
//!     once the recording sink lands
//!   - surface-area scaling reads MIN_CREATURE_R like TS does
//!
//! Determinism: the kernel matches the TS order (slots 0..N) and
//! the same MM saturation, the same atp / adp gating, the same
//! light multiplier, the same machinery multipliers. Floats are f32
//! on the cell columns and f64 transiently inside the kinetic math
//! so accumulators retain a little headroom, matching the TS
//! "Float32Array storage, Number arithmetic" pattern.

use crate::chem_ids::{
    CHEM_AA, CHEM_ADP, CHEM_ATP, CHEM_CHL, CHEM_ENZ, CHEM_MIN, CHEM_MRNA, CHL_REF, ENZ_REF,
    MRNA_REF,
};
use crate::creatures::{CreatureStore, MIN_CREATURE_R};
use crate::genome_consts::N_REACTIONS;
use crate::reactions::table as reactions_table;

const KM_DEFAULT: f64 = 1.0;
const CAT_REF: f64 = 5.0;
const INH_K: f64 = 1.0;
/// Endergonic reactions keep this much ATP in reserve when atp_floor
/// is set. Matches TS `BIOSYNTH_ATP_FLOOR`.
const BIOSYNTH_ATP_FLOOR: f64 = 4.0;

/// Max rate of catalyst-pool synthesis per second. Matches TS
/// `CAT_SYNTH_VMAX`.
const CAT_SYNTH_VMAX: f64 = 0.3;
/// ATP cost per unit catalyst (or inhibitor) synthesised. Matches TS
/// `CAT_ATP_COST`.
const CAT_ATP_COST: f64 = 4.0;
/// AA consumed per unit synthesised. Half the substrate is amino
/// acids, half is minerals (TS `CAT_SUBSTRATE_COUNT`).
const CAT_AA_PER_UNIT: f64 = 0.5;
const CAT_MIN_PER_UNIT: f64 = 0.5;

/// Run all reaction slots for cell `i`. `ambient_light` is the local
/// solar light value the photosynth slots gate on; 1.0 is bright sun,
/// 0.0 is dark.
pub fn run_cell_reactions(
    store: &mut CreatureStore,
    i: usize,
    dt: f32,
    ambient_light: f32,
) {
    let dt = dt as f64;
    let ambient_light = ambient_light as f64;
    let reactions = reactions_table();

    for (slot, rxn) in reactions.iter().enumerate().take(N_REACTIONS) {
        if rxn.transport.is_some() {
            continue;
        }
        let pool = store.catalyst[slot][i] as f64;
        if rxn.uncat_rate <= 0.0 && pool <= 0.0 {
            continue;
        }
        // Cheap gates first.
        if rxn.light_in > 0.0 && ambient_light <= 0.0 {
            continue;
        }
        let mrna_val = if rxn.mrna_scale {
            store.chems[CHEM_MRNA][i] as f64
        } else {
            0.0
        };
        if rxn.mrna_scale && mrna_val <= 0.0 {
            continue;
        }
        let chl_val = if rxn.chl_scale {
            store.chems[CHEM_CHL][i] as f64
        } else {
            0.0
        };
        if rxn.chl_scale && chl_val <= 0.0 {
            continue;
        }
        let enz_val = if rxn.enz_scale {
            store.chems[CHEM_ENZ][i] as f64
        } else {
            0.0
        };
        if rxn.enz_scale && enz_val <= 0.0 {
            continue;
        }
        let inh_pool = store.inhibitor[slot][i] as f64;
        // Fully inhibited iff (1 - INH_K * inhPool/CAT_REF) <= 0.
        if inh_pool > 0.0 && INH_K * inh_pool >= CAT_REF {
            continue;
        }
        let light_mult = if rxn.light_in > 0.0 {
            (ambient_light / rxn.light_in as f64).min(1.0)
        } else {
            1.0
        };

        // Skip reactions touching a generic chem (chem id >=
        // NAMED_CHEMICAL_COUNT). Cells carry only named chems; any
        // generic substrate / product can't be matched against a
        // cell-internal pool. Generic chems are environmental --
        // they enter / leave the cell exclusively via TRANSPORT /
        // INGEST against the dissolved field.
        let touches_generic = rxn
            .s_chem
            .iter()
            .chain(rxn.p_chem.iter())
            .any(|&c| (c as usize) >= crate::chem_ids::NAMED_CHEMICAL_COUNT);
        if touches_generic {
            continue;
        }

        // Substrate gate + MM saturation.
        let mut limit = f64::INFINITY;
        let mut sat_product = 1.0_f64;
        let mut substrate_ok = true;
        for (j, &chem) in rxn.s_chem.iter().enumerate() {
            let have = store.chems[chem as usize][i] as f64;
            if have <= 0.0 {
                substrate_ok = false;
                break;
            }
            let need = rxn.s_count[j] as f64;
            let ratio = have / need;
            if ratio < limit {
                limit = ratio;
            }
            sat_product *= ratio / (ratio + KM_DEFAULT);
        }
        if !substrate_ok {
            continue;
        }

        // ATP / ADP handling.
        let atp_d = rxn.atp_delta as f64;
        if atp_d < 0.0 {
            let floor = if rxn.atp_floor { BIOSYNTH_ATP_FLOOR } else { 0.0 };
            let e_avail = (store.chems[CHEM_ATP][i] as f64 - floor) / -atp_d;
            if e_avail <= 0.0 {
                continue;
            }
            if e_avail < limit {
                limit = e_avail;
            }
            sat_product *= e_avail / (e_avail + KM_DEFAULT);
        } else if atp_d > 0.0 {
            let adp_avail = store.chems[CHEM_ADP][i] as f64 / atp_d;
            if adp_avail <= 0.0 {
                continue;
            }
            if adp_avail < limit {
                limit = adp_avail;
            }
            sat_product *= adp_avail / (adp_avail + KM_DEFAULT);
        }

        // Surface-area scaling: (r / MIN_R)^2.
        let surface = if rxn.surface_scale {
            let r_rel = (store.r[i] / MIN_CREATURE_R) as f64;
            r_rel * r_rel
        } else {
            1.0
        };
        // Machinery multipliers.
        let mut machinery_mult = 1.0_f64;
        if rxn.mrna_scale {
            machinery_mult *= mrna_val / MRNA_REF as f64;
        }
        if rxn.chl_scale {
            machinery_mult *= (chl_val / CHL_REF as f64).min(1.0);
        }
        if rxn.enz_scale {
            machinery_mult *= enz_val / ENZ_REF as f64;
        }
        let inh_mult = if inh_pool > 0.0 {
            1.0 - INH_K * (inh_pool / CAT_REF)
        } else {
            1.0
        };
        let rate = (rxn.uncat_rate as f64 + rxn.vmax as f64 * (pool / CAT_REF))
            * sat_product
            * light_mult
            * surface
            * machinery_mult
            * inh_mult;
        let mut amt = rate * dt;
        if amt > limit {
            amt = limit;
        }
        if amt <= 0.0 {
            continue;
        }

        // Apply substrates.
        for (j, &chem) in rxn.s_chem.iter().enumerate() {
            let delta = (rxn.s_count[j] as f64 * amt) as f32;
            store.chems[chem as usize][i] -= delta;
        }
        // Apply products.
        for (j, &chem) in rxn.p_chem.iter().enumerate() {
            let delta = (rxn.p_count[j] as f64 * amt) as f32;
            store.chems[chem as usize][i] += delta;
        }
        // ATP <-> ADP conversion.
        if atp_d != 0.0 {
            let d = (atp_d * amt) as f32;
            store.chems[CHEM_ATP][i] += d;
            store.chems[CHEM_ADP][i] -= d;
        }
    }
}

/// Grow the catalyst pool at `slot` for cell `i` by running the
/// canonical synth reaction: 0.5 AA + 0.5 MIN -> 1 unit, costing
/// `CAT_ATP_COST` ATP, gated by mRNA / BIOSYNTH_ATP_FLOOR.
/// Returns the amount synthesised. Replaces the placeholder linear
/// bump that used to grow pools without paying any substrate or
/// ATP cost.
pub fn biosynth_catalyst(store: &mut CreatureStore, slot: usize, i: usize, dt: f32) -> f32 {
    biosynth_pool(store, slot, i, dt, /* is_inhibitor */ false)
}

pub fn biosynth_inhibitor(store: &mut CreatureStore, slot: usize, i: usize, dt: f32) -> f32 {
    biosynth_pool(store, slot, i, dt, /* is_inhibitor */ true)
}

fn biosynth_pool(
    store: &mut CreatureStore,
    slot: usize,
    i: usize,
    dt: f32,
    is_inhibitor: bool,
) -> f32 {
    let dt = dt as f64;
    let aa = store.chems[CHEM_AA][i] as f64;
    let mn = store.chems[CHEM_MIN][i] as f64;
    let atp = store.chems[CHEM_ATP][i] as f64;
    let mrna = store.chems[CHEM_MRNA][i] as f64;
    // Mandatory mRNA gate: no mRNA -> no biosynth.
    if mrna <= 0.0 || aa <= 0.0 || mn <= 0.0 {
        return 0.0;
    }
    // ATP floor: keep BIOSYNTH_ATP_FLOOR in reserve so newborns
    // don't dry themselves growing.
    let atp_avail = atp - BIOSYNTH_ATP_FLOOR;
    if atp_avail <= 0.0 {
        return 0.0;
    }
    let mrna_mult = (mrna / MRNA_REF as f64).min(1.0);
    let rate_cap = CAT_SYNTH_VMAX * mrna_mult * dt;
    // Substrate-bounded amount.
    let aa_limit = aa / CAT_AA_PER_UNIT;
    let mn_limit = mn / CAT_MIN_PER_UNIT;
    let atp_limit = atp_avail / CAT_ATP_COST;
    let amount = rate_cap.min(aa_limit).min(mn_limit).min(atp_limit);
    if amount <= 0.0 {
        return 0.0;
    }
    store.chems[CHEM_AA][i] -= (amount * CAT_AA_PER_UNIT) as f32;
    store.chems[CHEM_MIN][i] -= (amount * CAT_MIN_PER_UNIT) as f32;
    let atp_spent = (amount * CAT_ATP_COST) as f32;
    store.chems[CHEM_ATP][i] -= atp_spent;
    store.chems[CHEM_ADP][i] += atp_spent;
    if is_inhibitor {
        store.inhibitor[slot][i] += amount as f32;
    } else {
        store.catalyst[slot][i] += amount as f32;
    }
    amount as f32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::{
        CHEM_AA, CHEM_CO2, CHEM_GLU, CHEM_MEMBRANE, CHEM_MIN, CHEM_O2, NAMED_CHEMICAL_COUNT,
    };
    use crate::creatures::CreatureInit;
    use crate::reactions::RX_SLOT_RESPIRATION;

    fn make_cell(chems: Vec<f32>) -> CreatureStore {
        let mut s = CreatureStore::new();
        s.push(CreatureInit {
            r: MIN_CREATURE_R,
            chems: Some(chems),
            ..CreatureInit::default()
        });
        s
    }

    fn empty_chems() -> Vec<f32> {
        vec![0.0; NAMED_CHEMICAL_COUNT]
    }

    #[test]
    fn aerobic_respiration_consumes_glu_o2_makes_atp() {
        let mut chems = empty_chems();
        chems[CHEM_GLU] = 5.0;
        chems[CHEM_O2] = 5.0;
        chems[CHEM_ADP] = 10.0; // ADP gates ATP regen
        let mut store = make_cell(chems);
        let atp0 = store.chems[CHEM_ATP][0];
        run_cell_reactions(&mut store, 0, 0.5, 0.0);
        let glu1 = store.chems[CHEM_GLU][0];
        let o21 = store.chems[CHEM_O2][0];
        let atp1 = store.chems[CHEM_ATP][0];
        let co21 = store.chems[CHEM_CO2][0];
        assert!(glu1 < 5.0, "glu should drop, got {glu1}");
        assert!(o21 < 5.0, "o2 should drop, got {o21}");
        assert!(atp1 > atp0, "atp should rise, got {atp1} from {atp0}");
        assert!(co21 > 0.0, "co2 should accumulate, got {co21}");
        // RX_SLOT_RESPIRATION exists by name to anchor this test;
        // assert it's still the aerobic slot.
        let r = &reactions_table()[RX_SLOT_RESPIRATION];
        assert_eq!(r.atp_delta, 10.0);
    }

    #[test]
    fn no_substrate_no_reaction() {
        // Cell with no GLU/O2: aerobic respiration shouldn't run.
        let mut store = make_cell(empty_chems());
        let atp0 = store.chems[CHEM_ATP][0];
        run_cell_reactions(&mut store, 0, 1.0, 0.0);
        assert_eq!(store.chems[CHEM_ATP][0], atp0);
    }

    #[test]
    fn endergonic_synth_needs_atp_floor() {
        // synth_aa is slot 4: glu+min -> aa, atp -2, atpFloor=true.
        // With ATP at exactly the floor, it should NOT fire.
        let mut chems = empty_chems();
        chems[CHEM_GLU] = 5.0;
        chems[CHEM_MIN] = 5.0;
        chems[CHEM_MRNA] = 1.0;
        chems[CHEM_ATP] = BIOSYNTH_ATP_FLOOR as f32; // exactly the floor
        chems[CHEM_ADP] = 0.0;
        let mut store = make_cell(chems);
        let aa0 = store.chems[CHEM_AA][0];
        run_cell_reactions(&mut store, 0, 1.0, 0.0);
        assert_eq!(store.chems[CHEM_AA][0], aa0, "below-floor ATP should not synth aa");
    }

    #[test]
    fn endergonic_synth_runs_with_headroom() {
        let mut chems = empty_chems();
        chems[CHEM_GLU] = 5.0;
        chems[CHEM_MIN] = 5.0;
        chems[CHEM_MRNA] = 5.0; // = MRNA_REF, full rate
        chems[CHEM_ATP] = 50.0; // well above floor
        let mut store = make_cell(chems);
        run_cell_reactions(&mut store, 0, 1.0, 0.0);
        assert!(store.chems[CHEM_AA][0] > 0.0, "aa should accumulate");
    }

    #[test]
    fn photosynth_needs_light_and_chl() {
        // Slot 3: co2 -> glu+o2 ; chl_scale + light + surface
        let mut chems = empty_chems();
        chems[CHEM_CO2] = 10.0;
        chems[CHEM_ATP] = 10.0; // endergonic -1 ATP
        chems[CHEM_ADP] = 5.0;
        chems[CHEM_CHL] = 2.0; // = CHL_REF
        let mut store = make_cell(chems);

        // Dark: should not run.
        let glu0 = store.chems[CHEM_GLU][0];
        run_cell_reactions(&mut store, 0, 1.0, 0.0);
        assert_eq!(store.chems[CHEM_GLU][0], glu0);

        // Light: should run.
        run_cell_reactions(&mut store, 0, 1.0, 1.0);
        assert!(store.chems[CHEM_GLU][0] > glu0, "photosynth should make glu");
    }

    #[test]
    fn biosynth_catalyst_consumes_substrate_and_atp() {
        let mut chems = empty_chems();
        chems[CHEM_AA] = 10.0;
        chems[CHEM_MIN] = 10.0;
        chems[CHEM_MRNA] = 5.0;
        chems[CHEM_ATP] = 50.0;
        chems[CHEM_ADP] = 0.0;
        let mut store = make_cell(chems);
        let aa0 = store.chems[CHEM_AA][0];
        let atp0 = store.chems[CHEM_ATP][0];
        let cat0 = store.catalyst[7][0];
        let amount = biosynth_catalyst(&mut store, 7, 0, 1.0);
        assert!(amount > 0.0);
        // AA + MIN consumed, ATP spent, ADP rose, catalyst slot grew.
        assert!(store.chems[CHEM_AA][0] < aa0);
        assert!(store.chems[CHEM_ATP][0] < atp0);
        assert!(store.chems[CHEM_ADP][0] > 0.0);
        assert!(store.catalyst[7][0] > cat0);
    }

    #[test]
    fn biosynth_catalyst_refuses_without_mrna() {
        let mut chems = empty_chems();
        chems[CHEM_AA] = 10.0;
        chems[CHEM_MIN] = 10.0;
        // No mRNA -> no biosynth.
        chems[CHEM_ATP] = 50.0;
        let mut store = make_cell(chems);
        let amount = biosynth_catalyst(&mut store, 7, 0, 1.0);
        assert_eq!(amount, 0.0);
        assert_eq!(store.catalyst[7][0], 0.0);
    }

    #[test]
    fn biosynth_inhibitor_uses_inhibitor_pool() {
        let mut chems = empty_chems();
        chems[CHEM_AA] = 10.0;
        chems[CHEM_MIN] = 10.0;
        chems[CHEM_MRNA] = 5.0;
        chems[CHEM_ATP] = 50.0;
        let mut store = make_cell(chems);
        let amount = biosynth_inhibitor(&mut store, 7, 0, 1.0);
        assert!(amount > 0.0);
        assert!(store.inhibitor[7][0] > 0.0);
        // The catalyst pool stays empty.
        assert_eq!(store.catalyst[7][0], 0.0);
    }

    #[test]
    fn synth_membrane_uses_aa_and_fa() {
        // Slot 9: aa+fa -> membrane, mrnaScale, atpFloor.
        let mut chems = empty_chems();
        chems[CHEM_AA] = 5.0;
        chems[crate::chem_ids::CHEM_FA] = 5.0;
        chems[CHEM_MRNA] = 5.0;
        chems[CHEM_ATP] = 50.0;
        let mut store = make_cell(chems);
        run_cell_reactions(&mut store, 0, 1.0, 0.0);
        assert!(store.chems[CHEM_MEMBRANE][0] > 0.0);
    }
}
