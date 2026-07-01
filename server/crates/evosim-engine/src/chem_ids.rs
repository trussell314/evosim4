//! Chemical identity layer ported from `src/sim/chem-ids.ts`. Pure
//! declarations -- the molecular-pool shape, the locked chem-slot id
//! space, and the slot/role count constants. No engine state, no rng,
//! no table build. Every other engine module that names a chemical
//! imports these constants so the id space stays single-sourced.
//!
//! Order must match `NAMED_CHEMICALS` exactly; reordering would break
//! the bond-projection LUT and the genome ABI's `%CHEMICAL_COUNT`
//! arithmetic.

/// Total chemical slots (named + procedurally generated generics).
pub const CHEMICAL_COUNT: usize = 96;

/// Named slots at the head of the chem table. Generics live at
/// `NAMED_CHEMICAL_COUNT..CHEMICAL_COUNT`.
pub const NAMED_CHEMICAL_COUNT: usize = 46;

pub const GENERIC_CHEMICAL_COUNT: usize = CHEMICAL_COUNT - NAMED_CHEMICAL_COUNT;

// Named-chem slot constants. Order matches `NAMED_CHEMICALS` (and the
// TS file's CHEM_* exports). Don't renumber.

pub const CHEM_O2: usize = 0;
pub const CHEM_CO2: usize = 1;
pub const CHEM_GLU: usize = 2;
pub const CHEM_AA: usize = 3;
pub const CHEM_FA: usize = 4;
pub const CHEM_MIN: usize = 5;
pub const CHEM_ADP: usize = 6;
pub const CHEM_WASTE: usize = 7;
pub const CHEM_CHL: usize = 8;
pub const CHEM_ENZ: usize = 9;
pub const CHEM_MRNA: usize = 10;
pub const CHEM_BIOPOLYMER: usize = 11;
pub const CHEM_MEMBRANE: usize = 12;
pub const CHEM_PHOTORECEPTOR_VISIBLE: usize = 13;
pub const CHEM_PHOTORECEPTOR_LONG: usize = 14;
pub const CHEM_PHOTORECEPTOR_SURFACE: usize = 15;
pub const CHEM_ACT_PHOTO_VISIBLE: usize = 16;
pub const CHEM_ACT_PHOTO_LONG: usize = 17;
pub const CHEM_ACT_PHOTO_SURFACE: usize = 18;
pub const CHEM_ELECTRORECEPTOR: usize = 19;
pub const CHEM_VIBRORECEPTOR: usize = 20;
pub const CHEM_PHRECEPTOR: usize = 21;
pub const CHEM_CHEMORECEPTOR_MARKER0: usize = 22;
pub const CHEM_ACT_ELECTRO_X: usize = 23;
pub const CHEM_ACT_ELECTRO_Y: usize = 24;
pub const CHEM_ACT_VIB_X: usize = 25;
pub const CHEM_ACT_VIB_Y: usize = 26;
pub const CHEM_ACT_PH: usize = 27;
pub const CHEM_ACT_CHEMO_FA_Y: usize = 28;
pub const CHEM_ACT_LIGHT_X: usize = 29;
pub const CHEM_ACT_LIGHT_Y: usize = 30;
pub const CHEM_MECHANORECEPTOR: usize = 31;
pub const CHEM_ACT_MECH_X: usize = 32;
pub const CHEM_ACT_MECH_Y: usize = 33;
pub const CHEM_THERMORECEPTOR: usize = 34;
pub const CHEM_ACT_THERMO: usize = 35;
pub const CHEM_MAGNETORECEPTOR: usize = 36;
pub const CHEM_ACT_MAG_X: usize = 37;
pub const CHEM_ACT_MAG_Y: usize = 38;
pub const CHEM_BOND: usize = 39;
pub const CHEM_REPAIR: usize = 40;
pub const CHEM_MARKER0: usize = 41;
// Markers occupy 41..44; only marker0 has a constant since the
// chemoreceptor system targets it specifically.
pub const CHEM_ATP: usize = 45;

/// Mandatory-multiplier reference levels for the three role chems.
/// See `src/sim/chem-ids.ts` for the long-form comment on why CHL_REF
/// was lowered from 5 to 2.
pub const MRNA_REF: f32 = 5.0;
pub const CHL_REF: f32 = 2.0;
pub const ENZ_REF: f32 = 5.0;

/// Names indexed by chem slot. Single source of truth for the chem
/// label; nothing else in the engine should hard-code "o2" etc.
/// Mirrors the TS `NAMED_CHEMICALS` list but as a `match` so the
/// compiler refuses to silently let a slot drift.
pub fn slot_name(slot: usize) -> &'static str {
    match slot {
        CHEM_O2 => "o2",
        CHEM_CO2 => "co2",
        CHEM_GLU => "glucose",
        CHEM_AA => "aminoAcid",
        CHEM_FA => "fattyAcid",
        CHEM_MIN => "minerals",
        CHEM_ADP => "adp",
        CHEM_WASTE => "waste",
        CHEM_CHL => "chlorophyll",
        CHEM_ENZ => "enzyme",
        CHEM_MRNA => "mrna",
        CHEM_BIOPOLYMER => "biopolymer",
        CHEM_MEMBRANE => "membrane",
        CHEM_PHOTORECEPTOR_VISIBLE => "photoreceptorVisible",
        CHEM_PHOTORECEPTOR_LONG => "photoreceptorLong",
        CHEM_PHOTORECEPTOR_SURFACE => "photoreceptorSurface",
        CHEM_ACT_PHOTO_VISIBLE => "activatedPhotoVisible",
        CHEM_ACT_PHOTO_LONG => "activatedPhotoLong",
        CHEM_ACT_PHOTO_SURFACE => "activatedPhotoSurface",
        CHEM_ELECTRORECEPTOR => "electroreceptor",
        CHEM_VIBRORECEPTOR => "vibroreceptor",
        CHEM_PHRECEPTOR => "phreceptor",
        CHEM_CHEMORECEPTOR_MARKER0 => "chemoreceptorMarker0",
        CHEM_ACT_ELECTRO_X => "activatedElectroX",
        CHEM_ACT_ELECTRO_Y => "activatedElectroY",
        CHEM_ACT_VIB_X => "activatedVibX",
        CHEM_ACT_VIB_Y => "activatedVibY",
        CHEM_ACT_PH => "activatedPh",
        CHEM_ACT_CHEMO_FA_Y => "activatedChemoFaY",
        CHEM_ACT_LIGHT_X => "activatedLightX",
        CHEM_ACT_LIGHT_Y => "activatedLightY",
        CHEM_MECHANORECEPTOR => "mechanoreceptor",
        CHEM_ACT_MECH_X => "activatedMechX",
        CHEM_ACT_MECH_Y => "activatedMechY",
        CHEM_THERMORECEPTOR => "thermoreceptor",
        CHEM_ACT_THERMO => "activatedThermo",
        CHEM_MAGNETORECEPTOR => "magnetoreceptor",
        CHEM_ACT_MAG_X => "activatedMagX",
        CHEM_ACT_MAG_Y => "activatedMagY",
        CHEM_BOND => "bondChem",
        CHEM_REPAIR => "repairChem",
        CHEM_MARKER0 => "marker0",
        42 => "marker1",
        43 => "marker2",
        44 => "marker3",
        CHEM_ATP => "atp",
        _ => "generic", // 46..96 share a label; the chem table carries the real one
    }
}

/// True iff the chem at this slot is a *signal* chem (signed scalar
/// activation, not physical mass). Sensor activation chems are stored
/// in the same molecule pool but excluded from mass conservation.
pub fn is_signal(slot: usize) -> bool {
    matches!(
        slot,
        CHEM_ACT_PHOTO_VISIBLE
            | CHEM_ACT_PHOTO_LONG
            | CHEM_ACT_PHOTO_SURFACE
            | CHEM_ACT_ELECTRO_X
            | CHEM_ACT_ELECTRO_Y
            | CHEM_ACT_VIB_X
            | CHEM_ACT_VIB_Y
            | CHEM_ACT_PH
            | CHEM_ACT_CHEMO_FA_Y
            | CHEM_ACT_LIGHT_X
            | CHEM_ACT_LIGHT_Y
            | CHEM_ACT_MECH_X
            | CHEM_ACT_MECH_Y
            | CHEM_ACT_THERMO
            | CHEM_ACT_MAG_X
            | CHEM_ACT_MAG_Y
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slot_names_align_with_constants() {
        assert_eq!(slot_name(CHEM_O2), "o2");
        assert_eq!(slot_name(CHEM_ATP), "atp");
        assert_eq!(slot_name(CHEM_PHRECEPTOR), "phreceptor");
        assert_eq!(slot_name(CHEM_ACT_MAG_X), "activatedMagX");
    }

    #[test]
    fn slot_counts_match_ts() {
        assert_eq!(CHEMICAL_COUNT, 96);
        assert_eq!(NAMED_CHEMICAL_COUNT, 46);
        assert_eq!(GENERIC_CHEMICAL_COUNT, 50);
    }

    #[test]
    fn signal_chems_excluded_from_mass() {
        // Every CHEM_ACT_* should report as signal; nothing else
        // should.
        assert!(is_signal(CHEM_ACT_LIGHT_X));
        assert!(!is_signal(CHEM_GLU));
        assert!(!is_signal(CHEM_ATP));
    }
}
