//! Regional dissolved + reserve substrate -- foundational layer.
//!
//! Phase 0 of the regions port (`src/sim/regions.ts`): pure geometry
//! and the solubility table the dissolution / precipitation passes
//! will key off in later phases. No state, no behavior change yet --
//! every helper here is a pure function of world dimensions and the
//! chemistry table.
//!
//! What still lives elsewhere until later phases land:
//!   - the regional `dissolved` + `reserve` arrays on the World (still
//!     a flat global `AmbientField`)
//!   - Jacobi cross-region diffusion of the dissolved field
//!   - the temperature field (`regionTemp`/`regionTempNext`)
//!   - the solid-region mask + `depositRegionBase` rock redirection
//!     (depends on terrain, which isn't ported yet)
//!   - vent injection into the temperature field
//!
//! See `REGION_SYSTEM_PLAN.md` for the phased plan.

use crate::chem_ids::{
    CHEMICAL_COUNT, CHEM_ADP, CHEM_AA, CHEM_BIOPOLYMER, CHEM_CHL, CHEM_CO2, CHEM_ENZ, CHEM_FA,
    CHEM_GLU, CHEM_MEMBRANE, CHEM_MIN, CHEM_MRNA, CHEM_O2, CHEM_WASTE, NAMED_CHEMICAL_COUNT,
};
use crate::chemistry::{table as chem_table, ChemPhase};

/// World temperature baseline in °C. `solubility_temp_factor` returns
/// 1.0 here so a baseline world's capacity matches the molar table
/// untouched.
pub const TEMP_BASELINE: f32 = 15.0;

/// Region footprint in pixels. A region is a `REGION_PX x REGION_PX x
/// world.depth` box. Everything keyed off this so a future tweak
/// propagates.
pub const REGION_PX: f32 = 50.0;

/// Physical radius of a particle precipitated out of a supersaturated
/// region; also the particle-equivalent unit dissolved capacity is
/// measured in.
pub const PRECIP_R: f32 = 2.0;

/// The full vertical extent of the world maps to this many meters.
/// Used ONLY to turn px volumes into litres for the molar-solubility
/// capacity formula. Zero rendering / dynamics impact.
const WORLD_HEIGHT_METERS: f32 = 10.0;

/// Avogadro. Capacity is expressed in particle-equivalents:
///
///   capacity = S_molar [mol/L] * f_T(T) * V_region [L] * N_A / M
///
/// M (`PARTICLE_MOLECULE_MULTIPLIER`) is the real molecules represented
/// by one sim particle. It's the single fitted knob, chosen so insoluble
/// food chems (membrane / biopolymer / mineral / fatty acid) get
/// effectively zero particle-equivalent capacity (they stay particulate
/// and edible) while soluble byproducts (glucose / amino acid / waste /
/// ADP) and gases get large capacity (they dissolve into the regional
/// field).
const AVOGADRO: f32 = 6.022e23;
const PARTICLE_MOLECULE_MULTIPLIER: f32 = 2.0e22;

/// Per-chem molar solubility table (mol/L), realistic-ish for the 13
/// bootstrap chems. Absolute values are loose; the ORDERING and
/// relative spread is what drives behaviour, and the multiplier above
/// absorbs the global scale. Procedural generics keep their per-chem
/// roll from the chemistry table, scaled into the same realistic band.
pub static CHEM_MOLAR_SOLUBILITY: std::sync::OnceLock<Vec<f32>> = std::sync::OnceLock::new();

/// Generic chems' rolled solubility was never calibrated against the
/// N_A/M*V capacity formula -- at the rolled scale every generic is
/// effectively infinitely soluble. This factor moves the generic band
/// into the same realistic range as the bootstrap food chems, preserving
/// the relative spread (so some generics still dissolve readily and most
/// behave as particulate matter).
const GENERIC_SOLUBILITY_SCALE: f32 = 1.0e-3;

/// Per-chem atmospheric / equilibrium target the dissolved field seeds
/// to and the aerate pass relaxes toward. Only O2 and CO2 have non-zero
/// targets -- water in contact with air equilibrates dissolved gases
/// toward Henry's-law-ish values, but everything else enters solely as
/// particles or biomass.
pub static AMBIENT_TARGET: std::sync::OnceLock<Vec<f32>> = std::sync::OnceLock::new();

fn build_molar_solubility() -> Vec<f32> {
    let table = chem_table();
    let mut s = vec![0.0_f32; CHEMICAL_COUNT];
    for (i, c) in table.chems.iter().enumerate().take(CHEMICAL_COUNT) {
        s[i] = c.solubility;
    }
    // Bootstrap chems: hand-tuned realistic-ish molar solubilities so
    // the relative ordering (gases sparingly soluble, sugars / waste
    // freely soluble, structural chems near-insoluble) survives the
    // capacity formula.
    s[CHEM_O2] = 1.3e-3;
    s[CHEM_CO2] = 3.3e-2;
    s[CHEM_GLU] = 5.0;
    s[CHEM_AA] = 3.0;
    s[CHEM_FA] = 1.0e-4;
    s[CHEM_MIN] = 1.0e-5;
    s[CHEM_ADP] = 0.5;
    s[CHEM_WASTE] = 5.0;
    s[CHEM_CHL] = 1.0e-5;
    s[CHEM_ENZ] = 1.0e-3;
    s[CHEM_MRNA] = 1.0e-3;
    s[CHEM_BIOPOLYMER] = 1.0e-6;
    s[CHEM_MEMBRANE] = 1.0e-7;
    for v in s.iter_mut().take(CHEMICAL_COUNT).skip(NAMED_CHEMICAL_COUNT) {
        *v *= GENERIC_SOLUBILITY_SCALE;
    }
    s
}

fn build_ambient_target() -> Vec<f32> {
    let mut t = vec![0.0_f32; CHEMICAL_COUNT];
    t[CHEM_O2] = 12.0;
    t[CHEM_CO2] = 1.0;
    t
}

pub fn molar_solubility() -> &'static [f32] {
    CHEM_MOLAR_SOLUBILITY.get_or_init(build_molar_solubility)
}

pub fn ambient_target() -> &'static [f32] {
    AMBIENT_TARGET.get_or_init(build_ambient_target)
}

/// Width of the world in regions. Always at least 1 -- a world
/// narrower than `REGION_PX` still gets a single region.
pub fn region_cols(width: f32) -> usize {
    ((width / REGION_PX).ceil() as usize).max(1)
}

/// Height of the world in regions. Always at least 1.
pub fn region_rows(height: f32) -> usize {
    ((height / REGION_PX).ceil() as usize).max(1)
}

/// Total number of regions in a world of the given dimensions.
pub fn region_count(width: f32, height: f32) -> usize {
    region_cols(width) * region_rows(height)
}

/// Region volume in litres, derived from `REGION_PX^2 * depth`
/// converted through the `WORLD_HEIGHT_METERS / world.height` scale.
/// Used by the capacity formula and nothing else.
pub fn region_volume_l(height: f32, depth: f32) -> f32 {
    let m_per_px = WORLD_HEIGHT_METERS / height.max(1.0);
    let vol_m3 = (REGION_PX * m_per_px) * (REGION_PX * m_per_px) * (depth * m_per_px);
    vol_m3 * 1000.0
}

/// Region index for a world position. Clamped to `[0, region_count)`
/// so an out-of-bounds particle reads its nearest region instead of
/// going OOB.
pub fn region_index_at(width: f32, height: f32, x: f32, y: f32) -> usize {
    let cols = region_cols(width);
    let rows = region_rows(height);
    let rx = (x / REGION_PX).floor().clamp(0.0, (cols - 1) as f32) as usize;
    let ry = (y / REGION_PX).floor().clamp(0.0, (rows - 1) as f32) as usize;
    ry * cols + rx
}

/// Gas chems lose solubility with warming (Henry's law); condensed
/// phases gain. Identity at `TEMP_BASELINE` so a baseline world's
/// capacity is unchanged. Clamped to `[0.05, 3]` so an extreme
/// vent / arctic region can't push capacity to zero or infinity.
fn solubility_temp_factor(chem_id: usize, temp_c: f32) -> f32 {
    let table = chem_table();
    let d_rel = (temp_c - TEMP_BASELINE) / TEMP_BASELINE;
    let is_gas = matches!(table.chems[chem_id].default_phase, ChemPhase::Gas);
    let k = 0.4_f32;
    let f = if is_gas { 1.0 - k * d_rel } else { 1.0 + k * d_rel };
    f.clamp(0.05, 3.0)
}

/// Dissolved capacity of a region for a chem in particle-equivalents.
/// Returns 0 for chems with no molar solubility (e.g. the always-zero
/// activation / signal slots).
pub fn region_dissolved_capacity(chem_id: usize, height: f32, depth: f32, temp_c: f32) -> f32 {
    let s_molar = molar_solubility()[chem_id];
    if s_molar <= 0.0 {
        return 0.0;
    }
    let v_l = region_volume_l(height, depth);
    s_molar * solubility_temp_factor(chem_id, temp_c) * v_l * AVOGADRO
        / PARTICLE_MOLECULE_MULTIPLIER
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn region_grid_dims_match_ts() {
        // TS: 1600x1200 -> 32 cols, 24 rows.
        assert_eq!(region_cols(1600.0), 32);
        assert_eq!(region_rows(1200.0), 24);
        // Narrow worlds clamp up to one region.
        assert_eq!(region_cols(10.0), 1);
        assert_eq!(region_rows(10.0), 1);
        // Off-by-one: REGION_PX exactly produces one region, REGION_PX+1
        // bumps to two.
        assert_eq!(region_cols(REGION_PX), 1);
        assert_eq!(region_cols(REGION_PX + 1.0), 2);
    }

    #[test]
    fn region_index_clamps_oob() {
        let w = 200.0;
        let h = 200.0;
        // 200/50 = 4 cols x 4 rows; index range 0..16.
        assert_eq!(region_index_at(w, h, 0.0, 0.0), 0);
        assert_eq!(region_index_at(w, h, 199.0, 199.0), 15);
        // OOB clamps.
        assert_eq!(region_index_at(w, h, -10.0, -10.0), 0);
        assert_eq!(region_index_at(w, h, 1000.0, 1000.0), 15);
    }

    #[test]
    fn dissolved_capacity_orders_correctly() {
        // The whole point of the molar solubility table: gases and
        // soluble byproducts get large dissolved capacity, structural
        // chems get ~zero. This is what makes membrane particles stay
        // edible while CO2 dissolves freely.
        let h = 1200.0;
        let d = 50.0;
        let t = TEMP_BASELINE;
        let glu = region_dissolved_capacity(CHEM_GLU, h, d, t);
        let co2 = region_dissolved_capacity(CHEM_CO2, h, d, t);
        let mem = region_dissolved_capacity(CHEM_MEMBRANE, h, d, t);
        let bio = region_dissolved_capacity(CHEM_BIOPOLYMER, h, d, t);
        assert!(glu > 1.0, "glucose should dissolve readily: got {glu}");
        assert!(co2 > 1.0, "CO2 should dissolve: got {co2}");
        assert!(mem < 1.0, "membrane should ~ not dissolve: got {mem}");
        assert!(bio < 1.0, "biopolymer should ~ not dissolve: got {bio}");
    }

    #[test]
    fn temp_factor_is_identity_at_baseline() {
        assert!((solubility_temp_factor(CHEM_O2, TEMP_BASELINE) - 1.0).abs() < 1e-6);
        assert!((solubility_temp_factor(CHEM_GLU, TEMP_BASELINE) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn temp_factor_inverts_gases() {
        // Gases lose solubility when warm (Henry); condensed phases
        // gain. Verify both directions.
        let o2_warm = solubility_temp_factor(CHEM_O2, TEMP_BASELINE + 10.0);
        let glu_warm = solubility_temp_factor(CHEM_GLU, TEMP_BASELINE + 10.0);
        assert!(o2_warm < 1.0, "gas should lose solubility warm: {o2_warm}");
        assert!(glu_warm > 1.0, "aqueous should gain solubility warm: {glu_warm}");
    }

    #[test]
    fn ambient_target_has_only_o2_co2() {
        let t = ambient_target();
        assert_eq!(t[CHEM_O2], 12.0);
        assert_eq!(t[CHEM_CO2], 1.0);
        assert_eq!(t[CHEM_GLU], 0.0);
        assert_eq!(t[CHEM_MEMBRANE], 0.0);
    }
}
