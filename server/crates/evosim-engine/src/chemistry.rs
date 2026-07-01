//! Chemical property table + derived LUTs, ported from
//! `src/sim/chemistry.ts`. Pure: depends only on the RNG seed and the
//! chem-id layer, no engine state. Built lazily on first access (TS
//! does it at module load; Rust builds on first `table()` call) and
//! pinned thereafter for the lifetime of the process.
//!
//! Every constant and procedure here is byte-for-byte equivalent to
//! its TS source so the generated 96-chem table matches exactly. The
//! integration test at the bottom of this file pins a handful of
//! generic-chem fields against captured TS goldens; any drift in the
//! RNG or the roll-pipeline gets caught at `cargo test`.

use std::sync::OnceLock;

use crate::chem_ids::{
    is_signal, slot_name, CHEMICAL_COUNT, CHEM_BIOPOLYMER, CHEM_CO2, CHEM_FA, CHEM_GLU,
    CHEM_MIN, CHEM_O2, NAMED_CHEMICAL_COUNT,
};
use crate::rng::Mulberry32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChemPhase {
    Solid,
    Liquid,
    Gas,
    Aqueous,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChemRole {
    None,
    EnergyCarrier,
    EnergyEmpty,
    Membrane,
    Mrna,
    Pigment,
    Digester,
    Marker,
}

#[derive(Debug, Clone)]
pub struct ChemicalDef {
    pub name: String,
    pub molar_mass: f32,
    pub density: f32,
    pub default_phase: ChemPhase,
    pub solubility: f32,
    pub vapor_pressure: f32,
    pub melting_point: f32,
    pub permeability: f32,
    pub bond_energy: f32,
    pub role: ChemRole,
    /// Hex string, e.g. "#3fa9f5"; the renderer reads this directly.
    pub color: String,
    pub is_signal: bool,
}

/// The 96-row table + the hot-path LUTs derived from it. Held in a
/// OnceLock so every caller shares the same `&'static ChemTable`.
pub struct ChemTable {
    pub chems: Vec<ChemicalDef>,
    pub base_density: [f32; CHEMICAL_COUNT],
    pub molar_mass: [f32; CHEMICAL_COUNT],
    pub bond_potential: [f32; CHEMICAL_COUNT],
    pub is_signal: [bool; CHEMICAL_COUNT],
    /// `generic_spawn_order[rank] = chemId` for the 50 generic chems.
    pub generic_spawn_order: [usize; CHEMICAL_COUNT - NAMED_CHEMICAL_COUNT],
    /// `generic_spawn_rank[chemId]` for all 96 chems (0 outside the
    /// generic range; only the generic indices have meaningful values).
    pub generic_spawn_rank: [u32; CHEMICAL_COUNT],
    /// Which 6 chems the legacy SENSE_GRAD_X/Y/DENSITY ops bin to.
    pub sensor_chems: [usize; 6],
    /// `sensor_bin_by_chem[chemId]` = bin index in 0..6 or -1.
    pub sensor_bin_by_chem: [i8; CHEMICAL_COUNT],
}

/// `mass * bondEnergy * BOND_ENERGY_TO_ATP` -- the scalar that turns
/// the chemical-potential table into ATP-unit-of-account.
const BOND_ENERGY_TO_ATP: f32 = 0.012;

/// Mirror of `NAMED_CHEM_SPECS` in TS. Hand-rolled inline so the
/// constants live in one place and the compiler refuses to let the
/// length drift from `NAMED_CHEMICAL_COUNT`.
fn build_named_chems() -> Vec<ChemicalDef> {
    // Bases shared by the receptor / signal rows so we don't repeat
    // every column 16 times.
    let receptor_base = ChemicalDef {
        name: String::new(),
        molar_mass: 1.0,
        density: 1.1,
        default_phase: ChemPhase::Aqueous,
        solubility: 0.2,
        vapor_pressure: 0.0,
        melting_point: 60.0,
        permeability: 0.0,
        bond_energy: 5.0,
        role: ChemRole::None,
        color: String::new(),
        is_signal: false,
    };
    let signal_base = ChemicalDef {
        name: String::new(),
        molar_mass: 1.0,
        density: 1.0,
        default_phase: ChemPhase::Aqueous,
        solubility: 0.0,
        vapor_pressure: 0.0,
        melting_point: 100.0,
        permeability: 0.0,
        bond_energy: 0.0,
        role: ChemRole::None,
        color: String::new(),
        is_signal: true,
    };
    // Helper: stamp a color onto a base row.
    let receptor = |color: &str| ChemicalDef { color: color.into(), ..receptor_base.clone() };
    let signal = |color: &str| ChemicalDef { color: color.into(), ..signal_base.clone() };

    // Order MUST match `NAMED_CHEMICALS` exactly; we set `name` after
    // the row is built so a typo in the order is caught by the slot-
    // alignment test.
    let mut out: Vec<ChemicalDef> = vec![
        // o2
        ChemicalDef { name: "".into(), molar_mass: 1.0, density: 0.14, default_phase: ChemPhase::Gas,     solubility: 0.5,  vapor_pressure: 10.0, melting_point: -200.0, permeability: 1.0, bond_energy: 0.0,  role: ChemRole::None,         color: "#3fa9f5".into(), is_signal: false },
        // co2
        ChemicalDef { name: "".into(), molar_mass: 1.0, density: 0.20, default_phase: ChemPhase::Gas,     solubility: 1.8,  vapor_pressure: 9.0,  melting_point: -80.0,  permeability: 1.0, bond_energy: 0.0,  role: ChemRole::None,         color: "#c4d4e6".into(), is_signal: false },
        // glucose
        ChemicalDef { name: "".into(), molar_mass: 1.0, density: 1.5,  default_phase: ChemPhase::Aqueous, solubility: 4.0,  vapor_pressure: 0.0,  melting_point: 150.0,  permeability: 0.0, bond_energy: 30.0, role: ChemRole::None,         color: "#dbe09c".into(), is_signal: false },
        // aminoAcid
        ChemicalDef { name: "".into(), molar_mass: 1.0, density: 1.2,  default_phase: ChemPhase::Aqueous, solubility: 3.0,  vapor_pressure: 0.0,  melting_point: 200.0,  permeability: 0.5, bond_energy: 20.0, role: ChemRole::None,         color: "#c9c075".into(), is_signal: false },
        // fattyAcid
        ChemicalDef { name: "".into(), molar_mass: 1.0, density: 0.9,  default_phase: ChemPhase::Liquid,  solubility: 0.1,  vapor_pressure: 0.0,  melting_point: 40.0,   permeability: 0.3, bond_energy: 80.0, role: ChemRole::None,         color: "#f0d264".into(), is_signal: false },
        // minerals
        ChemicalDef { name: "".into(), molar_mass: 1.0, density: 2.4,  default_phase: ChemPhase::Solid,   solubility: 0.02, vapor_pressure: 0.0,  melting_point: 1200.0, permeability: 0.1, bond_energy: 0.0,  role: ChemRole::None,         color: "#8c8175".into(), is_signal: false },
        // adp
        ChemicalDef { name: "".into(), molar_mass: 1.0, density: 1.0,  default_phase: ChemPhase::Aqueous, solubility: 3.0,  vapor_pressure: 0.0,  melting_point: 200.0,  permeability: 0.5, bond_energy: 0.0,  role: ChemRole::EnergyEmpty,  color: "#a8d8ea".into(), is_signal: false },
        // waste
        ChemicalDef { name: "".into(), molar_mass: 1.0, density: 1.0,  default_phase: ChemPhase::Aqueous, solubility: 4.0,  vapor_pressure: 0.0,  melting_point: 100.0,  permeability: 0.6, bond_energy: 2.0,  role: ChemRole::None,         color: "#a89878".into(), is_signal: false },
        // chlorophyll
        ChemicalDef { name: "".into(), molar_mass: 1.0, density: 1.1,  default_phase: ChemPhase::Aqueous, solubility: 0.2,  vapor_pressure: 0.0,  melting_point: 200.0,  permeability: 0.0, bond_energy: 5.0,  role: ChemRole::Pigment,      color: "#5fa850".into(), is_signal: false },
        // enzyme
        ChemicalDef { name: "".into(), molar_mass: 1.0, density: 1.1,  default_phase: ChemPhase::Aqueous, solubility: 0.5,  vapor_pressure: 0.0,  melting_point: 90.0,   permeability: 0.0, bond_energy: 5.0,  role: ChemRole::Digester,     color: "#e0a070".into(), is_signal: false },
        // mrna
        ChemicalDef { name: "".into(), molar_mass: 1.0, density: 1.1,  default_phase: ChemPhase::Aqueous, solubility: 0.3,  vapor_pressure: 0.0,  melting_point: 70.0,   permeability: 0.0, bond_energy: 5.0,  role: ChemRole::Mrna,         color: "#c8a4dc".into(), is_signal: false },
        // biopolymer
        ChemicalDef { name: "".into(), molar_mass: 1.0, density: 1.05, default_phase: ChemPhase::Solid,   solubility: 0.05, vapor_pressure: 0.0,  melting_point: 250.0,  permeability: 0.0, bond_energy: 25.0, role: ChemRole::None,         color: "#7fb069".into(), is_signal: false },
        // membrane
        ChemicalDef { name: "".into(), molar_mass: 1.0, density: 0.8,  default_phase: ChemPhase::Liquid,  solubility: 0.01, vapor_pressure: 0.0,  melting_point: 50.0,   permeability: 0.0, bond_energy: 40.0, role: ChemRole::Membrane,     color: "#f0d264".into(), is_signal: false },
        receptor("#d864c8"), // photoVisible
        receptor("#b04ca0"), // photoLong
        receptor("#e890d0"), // photoSurface
        signal("#f0c0e8"),   // actPhotoVis
        signal("#c890c0"),   // actPhotoLong
        signal("#ffe0f0"),   // actPhotoSurf
        receptor("#f0e040"), // electroreceptor
        receptor("#64b0e0"), // vibroreceptor
        receptor("#a8d840"), // phreceptor
        receptor("#a8ecf0"), // chemoMark0
        signal("#fff080"),   // actElectroX
        signal("#fff080"),   // actElectroY
        signal("#a0d0f0"),   // actVibX
        signal("#a0d0f0"),   // actVibY
        signal("#d0f088"),   // activatedPh
        signal("#d0f0f8"),   // actChemoFaY
        signal("#fff8c0"),   // actLightX
        signal("#fff8c0"),   // actLightY
        receptor("#c8d864"), // mech
        signal("#e0e8a0"),   // actMechX
        signal("#e0e8a0"),   // actMechY
        receptor("#d8a064"), // thermo
        signal("#f0c890"),   // actThermo
        receptor("#9090d8"), // magneto
        signal("#b0b0e8"),   // actMagX
        signal("#b0b0e8"),   // actMagY
        // bondChem
        ChemicalDef { name: "".into(), molar_mass: 1.0, density: 1.05, default_phase: ChemPhase::Aqueous, solubility: 0.5, vapor_pressure: 0.0, melting_point: 80.0, permeability: 0.0, bond_energy: 8.0, role: ChemRole::None, color: "#d8c0a0".into(), is_signal: false },
        // repairChem
        ChemicalDef { name: "".into(), molar_mass: 1.0, density: 1.1,  default_phase: ChemPhase::Aqueous, solubility: 0.3, vapor_pressure: 0.0, melting_point: 70.0, permeability: 0.0, bond_energy: 8.0, role: ChemRole::None, color: "#b0c0d8".into(), is_signal: false },
        // mark0..3
        ChemicalDef { name: "".into(), molar_mass: 1.0, density: 1.0,  default_phase: ChemPhase::Aqueous, solubility: 4.0, vapor_pressure: 0.0, melting_point: 100.0, permeability: 0.5, bond_energy: 5.0, role: ChemRole::Marker, color: "#e84a4a".into(), is_signal: false },
        ChemicalDef { name: "".into(), molar_mass: 1.0, density: 1.0,  default_phase: ChemPhase::Aqueous, solubility: 4.0, vapor_pressure: 0.0, melting_point: 100.0, permeability: 0.5, bond_energy: 5.0, role: ChemRole::Marker, color: "#4ae84a".into(), is_signal: false },
        ChemicalDef { name: "".into(), molar_mass: 1.0, density: 1.0,  default_phase: ChemPhase::Aqueous, solubility: 4.0, vapor_pressure: 0.0, melting_point: 100.0, permeability: 0.5, bond_energy: 5.0, role: ChemRole::Marker, color: "#4a4ae8".into(), is_signal: false },
        ChemicalDef { name: "".into(), molar_mass: 1.0, density: 1.0,  default_phase: ChemPhase::Aqueous, solubility: 4.0, vapor_pressure: 0.0, melting_point: 100.0, permeability: 0.5, bond_energy: 5.0, role: ChemRole::Marker, color: "#e8e84a".into(), is_signal: false },
        // atp -- index 45
        ChemicalDef { name: "".into(), molar_mass: 1.0, density: 1.0,  default_phase: ChemPhase::Aqueous, solubility: 0.0, vapor_pressure: 0.0, melting_point: 200.0, permeability: 0.0, bond_energy: 0.0, role: ChemRole::None, color: "#ffe066".into(), is_signal: false },
    ];

    assert_eq!(
        out.len(),
        NAMED_CHEMICAL_COUNT,
        "named-chem table length drifted from NAMED_CHEMICAL_COUNT"
    );
    for (i, c) in out.iter_mut().enumerate() {
        c.name = slot_name(i).into();
    }
    out
}

/// Builds the deterministic generic-chem spawn order. Matches the TS
/// IIFE at the top of chemistry.ts exactly: mulberry32(0x5EED9A1C),
/// Fisher-Yates over indices [46..96).
fn build_generic_spawn_order() -> [usize; CHEMICAL_COUNT - NAMED_CHEMICAL_COUNT] {
    let mut g: [usize; CHEMICAL_COUNT - NAMED_CHEMICAL_COUNT] = std::array::from_fn(|i| NAMED_CHEMICAL_COUNT + i);
    let mut rng = Mulberry32::new(0x5EED9A1C);
    let mut i = g.len() - 1;
    while i > 0 {
        let j = (rng.next_f64() * (i as f64 + 1.0)) as usize;
        g.swap(i, j);
        i -= 1;
    }
    g
}

fn gray_to_orange(t: f64) -> String {
    let t = t.clamp(0.0, 1.0);
    let r = (128.0 + t * 127.0).round() as u32;
    let b = (128.0 - t * 128.0).round() as u32;
    format!("#{:02x}80{:02x}", r, b)
}

fn classify_phase(roll: f64) -> ChemPhase {
    if roll < 0.15 { ChemPhase::Gas }
    else if roll < 0.40 { ChemPhase::Solid }
    else if roll < 0.75 { ChemPhase::Liquid }
    else { ChemPhase::Aqueous }
}

/// Build the full 96-chem table. Public for one-shot use by the
/// OnceLock initializer below.
fn build_table() -> ChemTable {
    let mut chems = build_named_chems();

    let order = build_generic_spawn_order();
    let mut rank = [0u32; CHEMICAL_COUNT];
    for (r, chem) in order.iter().enumerate() {
        rank[*chem] = r as u32;
    }

    let mut rng = Mulberry32::new(0xC8E3_15CA);
    #[allow(clippy::needless_range_loop)] // index used for name/rank
    for i in NAMED_CHEMICAL_COUNT..CHEMICAL_COUNT {
        let u = rng.next_f64();
        let molar_mass = 0.5 + u * u * 4.5;
        let phase_roll = rng.next_f64();
        let default_phase = classify_phase(phase_roll);
        let density = match default_phase {
            ChemPhase::Gas => 0.1 + rng.next_f64() * 0.3,
            ChemPhase::Solid => 1.5 + rng.next_f64() * 2.0,
            ChemPhase::Liquid => 0.7 + rng.next_f64() * 0.8,
            ChemPhase::Aqueous => 0.9 + rng.next_f64() * 0.4,
        };
        let sol_base = (f64::ln(0.01) + rng.next_f64() * (f64::ln(5.0) - f64::ln(0.01))).exp();
        let solubility = match default_phase {
            ChemPhase::Aqueous => sol_base.max(0.5),
            ChemPhase::Solid => sol_base * 0.2,
            _ => sol_base,
        };
        let vapor_pressure = match default_phase {
            ChemPhase::Gas => 5.0 + rng.next_f64() * 8.0,
            _ => rng.next_f64() * 2.0,
        };
        let melting_point = match default_phase {
            ChemPhase::Solid => 200.0 + rng.next_f64() * 1000.0,
            ChemPhase::Gas => -200.0 + rng.next_f64() * 100.0,
            _ => rng.next_f64() * 200.0,
        };
        let perm_base = 1.0 / (1.0 + molar_mass * 0.5);
        let permeability = match default_phase {
            ChemPhase::Solid => 0.0,
            _ => perm_base * (0.4 + rng.next_f64() * 0.6),
        };
        let bond_energy = if rng.next_f64() < 0.2 {
            30.0 + rng.next_f64() * 60.0
        } else {
            rng.next_f64() * 20.0
        };
        let rank_norm =
            rank[i] as f64 / (CHEMICAL_COUNT - NAMED_CHEMICAL_COUNT - 1) as f64;
        chems.push(ChemicalDef {
            name: format!("c{:02x}", i),
            molar_mass: molar_mass as f32,
            density: density as f32,
            default_phase,
            solubility: solubility as f32,
            vapor_pressure: vapor_pressure as f32,
            melting_point: melting_point as f32,
            permeability: permeability as f32,
            bond_energy: bond_energy as f32,
            role: ChemRole::None,
            color: gray_to_orange(rank_norm),
            is_signal: false,
        });
    }
    assert_eq!(chems.len(), CHEMICAL_COUNT);

    // Hot-path LUTs.
    let mut base_density = [0f32; CHEMICAL_COUNT];
    let mut molar_mass = [0f32; CHEMICAL_COUNT];
    let mut bond_potential = [0f32; CHEMICAL_COUNT];
    let mut is_signal_flags = [false; CHEMICAL_COUNT];
    for (i, c) in chems.iter().enumerate() {
        base_density[i] = c.density;
        molar_mass[i] = c.molar_mass;
        bond_potential[i] = c.molar_mass * c.bond_energy * BOND_ENERGY_TO_ATP;
        // Inherit from the per-chem flag for named rows; the slot
        // table is the contract for sensor activations. Generic rows
        // are never signal chems.
        is_signal_flags[i] = c.is_signal || is_signal(i);
    }

    let sensor_chems = [CHEM_MIN, CHEM_BIOPOLYMER, CHEM_FA, CHEM_O2, CHEM_CO2, CHEM_GLU];
    let mut sensor_bin_by_chem = [-1i8; CHEMICAL_COUNT];
    for (bin, chem) in sensor_chems.iter().enumerate() {
        sensor_bin_by_chem[*chem] = bin as i8;
    }

    ChemTable {
        chems,
        base_density,
        molar_mass,
        bond_potential,
        is_signal: is_signal_flags,
        generic_spawn_order: order,
        generic_spawn_rank: rank,
        sensor_chems,
        sensor_bin_by_chem,
    }
}

/// One-shot accessor; the table is built on first call and pinned.
pub fn table() -> &'static ChemTable {
    static T: OnceLock<ChemTable> = OnceLock::new();
    T.get_or_init(build_table)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn count_and_named_slot_zero() {
        let t = table();
        assert_eq!(t.chems.len(), CHEMICAL_COUNT);
        let o2 = &t.chems[CHEM_O2];
        assert_eq!(o2.name, "o2");
        assert!((o2.density - 0.14).abs() < 1e-5);
        assert!((o2.solubility - 0.5).abs() < 1e-5);
        assert_eq!(o2.default_phase, ChemPhase::Gas);
    }

    #[test]
    fn atp_slot_matches_ts() {
        let atp = &table().chems[CHEM_O2 + 45];
        assert_eq!(atp.name, "atp");
        assert!((atp.density - 1.0).abs() < 1e-5);
        assert_eq!(atp.solubility, 0.0);
        assert_eq!(atp.permeability, 0.0);
    }

    // Generic-chem fields are the real determinism test: any drift in
    // RNG / phase classification / density formulas would show here.

    #[test]
    fn generic_chem_46_matches_ts_golden() {
        let c = &table().chems[46];
        assert_eq!(c.name, "c2e");
        assert!((c.molar_mass - 2.324_459_7).abs() < 1e-5);
        assert!((c.density - 1.191_038_9).abs() < 1e-5);
        assert_eq!(c.default_phase, ChemPhase::Aqueous);
        assert!((c.solubility - 0.5).abs() < 1e-5);
        assert!((c.vapor_pressure - 1.424_347_2).abs() < 1e-5);
        assert!((c.bond_energy - 77.509_46).abs() < 1e-3);
    }

    #[test]
    fn generic_chem_95_matches_ts_golden() {
        let c = &table().chems[95];
        assert_eq!(c.name, "c5f");
        assert!((c.density - 1.064_196_2).abs() < 1e-5);
        assert_eq!(c.default_phase, ChemPhase::Aqueous);
        assert!((c.solubility - 0.5).abs() < 1e-5);
    }

    #[test]
    fn spawn_order_matches_ts_golden() {
        let order = &table().generic_spawn_order;
        // First and last five entries captured from the TS shuffle.
        assert_eq!(&order[0..5], &[71, 81, 47, 82, 69]);
        assert_eq!(&order[45..50], &[85, 87, 90, 61, 65]);
    }

    #[test]
    fn bond_potential_uses_mass_times_bond_energy() {
        let t = table();
        // glucose: m=1, bondEnergy=30 -> 1 * 30 * 0.012 = 0.36
        assert!((t.bond_potential[CHEM_GLU] - 0.36).abs() < 1e-5);
        // fatty acid: m=1, bondEnergy=80 -> 0.96
        assert!((t.bond_potential[CHEM_FA] - 0.96).abs() < 1e-5);
        // ATP: bondEnergy=0 so potential is 0
        assert_eq!(t.bond_potential[CHEM_O2 + 45], 0.0);
    }

    #[test]
    fn signal_flags_match_slot_table() {
        let t = table();
        // CHEM_ACT_PHOTO_VISIBLE = 16 is a signal chem per is_signal()
        assert!(t.is_signal[16]);
        // CHEM_O2 isn't.
        assert!(!t.is_signal[CHEM_O2]);
    }

    #[test]
    fn sensor_chems_in_expected_order() {
        let t = table();
        assert_eq!(t.sensor_chems, [5, 11, 4, 0, 1, 2]);
        // The lookup table is the inverse.
        assert_eq!(t.sensor_bin_by_chem[CHEM_MIN], 0);
        assert_eq!(t.sensor_bin_by_chem[CHEM_GLU], 5);
        // Off-list chems stay -1.
        assert_eq!(t.sensor_bin_by_chem[10 /* mrna */], -1);
    }
}
