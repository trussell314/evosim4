//! Reaction table ported from `src/sim/reactions.ts`. The TS code
//! builds a 256-slot table in this order:
//!   1. `buildReactionTable` draws **every slot** procedurally from
//!      `mulberry32(0xE2C4_BEEF)` so the RNG state at the end of that
//!      loop is fixed regardless of which slots get overwritten later.
//!   2. `installNamedReactions` overwrites slots 0..26 with the 26
//!      hand-tuned reactions (respiration, ferment, photosynth, the
//!      synth-* family, biopolymer digest, photophosphorylation).
//!   3. `installTransporters` overwrites the tail
//!      `[N_REACTIONS - TRANSPORT_TARGETS.len() .. N_REACTIONS]` with
//!      facilitated transporters.
//!   4. `installCarbonFixReactions` overwrites the 8 lowest-interest
//!      generic slots with the carbon-fixation tiers. The same `rng`
//!      that built the procedural region is threaded in for jitter;
//!      because we only call it after the full procedural loop and
//!      before any other consumer, the call count is deterministic.
//!
//! All this needs to be byte-for-byte equivalent to the TS source so
//! the same seed produces the same table. Tests at the bottom pin
//! several slots against captured TS goldens.

use std::sync::OnceLock;

use crate::chem_ids::{
    CHEMICAL_COUNT, CHEM_AA, CHEM_ADP, CHEM_ATP, CHEM_BIOPOLYMER, CHEM_BOND,
    CHEM_CHEMORECEPTOR_MARKER0, CHEM_CHL, CHEM_CO2, CHEM_ELECTRORECEPTOR, CHEM_ENZ, CHEM_FA,
    CHEM_GLU, CHEM_MAGNETORECEPTOR, CHEM_MECHANORECEPTOR, CHEM_MEMBRANE, CHEM_MIN, CHEM_MRNA,
    CHEM_O2, CHEM_PHOTORECEPTOR_LONG, CHEM_PHOTORECEPTOR_SURFACE, CHEM_PHOTORECEPTOR_VISIBLE,
    CHEM_PHRECEPTOR, CHEM_REPAIR, CHEM_THERMORECEPTOR, CHEM_VIBRORECEPTOR, CHEM_WASTE,
    NAMED_CHEMICAL_COUNT,
};
use crate::chemistry::table as chem_table;
use crate::genome_consts::N_REACTIONS;
use crate::rng::Mulberry32;

/// One reaction. Substrate/product arrays carry 0..=3 entries. The
/// stoichiometric counts are floats because mass-balancing the
/// procedural reactions doesn't land on integers in general.
#[derive(Debug, Clone)]
pub struct Reaction {
    pub s_chem: Vec<u8>,
    pub s_count: Vec<f32>,
    pub p_chem: Vec<u8>,
    pub p_count: Vec<f32>,
    /// Signed energy delta per unit reaction (>0 = exergonic).
    pub atp_delta: f32,
    /// Ambient light units required per unit reaction; 0 if not light-
    /// driven.
    pub light_in: f32,
    /// Rate added on top of `uncat_rate` per (pool / CAT_REF).
    pub vmax: f32,
    /// Baseline rate at zero catalyst pool. Named reactions set this >
    /// 0 (the bootstrap chemistry every cell gets free); generic
    /// reactions leave it at 0.
    pub uncat_rate: f32,
    pub surface_scale: bool,
    pub atp_floor: bool,
    pub mrna_scale: bool,
    pub chl_scale: bool,
    pub enz_scale: bool,
    /// `Some(chemId)` iff this slot is a transporter for that chem,
    /// not an intra-pool reaction.
    pub transport: Option<u8>,
}

impl Reaction {
    fn empty_transport(chem: u8, vmax: f32) -> Self {
        Self {
            s_chem: Vec::new(),
            s_count: Vec::new(),
            p_chem: Vec::new(),
            p_count: Vec::new(),
            atp_delta: 0.0,
            light_in: 0.0,
            vmax,
            uncat_rate: 0.0,
            surface_scale: false,
            atp_floor: false,
            mrna_scale: false,
            chl_scale: false,
            enz_scale: false,
            transport: Some(chem),
        }
    }
}

// ----- Locked slot constants (re-exported in the obvious places).

pub const NAMED_REACTION_COUNT: usize = 26;

pub const RX_SLOT_RESPIRATION: usize = 0;
pub const RX_SLOT_FERMENT: usize = 1;
pub const RX_SLOT_BETA_OX: usize = 2;
pub const RX_SLOT_PHOTOSYNTH: usize = 3;
pub const RX_SLOT_SYNTH_AA: usize = 4;
pub const RX_SLOT_SYNTH_FA: usize = 5;
pub const RX_SLOT_SYNTH_CHL: usize = 6;
pub const RX_SLOT_SYNTH_ENZ: usize = 7;
pub const RX_SLOT_SYNTH_MRNA: usize = 8;
pub const RX_SLOT_SYNTH_MEM_AAFA: usize = 9;
pub const RX_SLOT_DIGEST_BIOP: usize = 10;
pub const RX_SLOT_SYNTH_MEM_FA: usize = 11;
pub const RX_SLOT_SYNTH_PHOTO_V: usize = 12;
pub const RX_SLOT_SYNTH_PHOTO_L: usize = 13;
pub const RX_SLOT_SYNTH_PHOTO_S: usize = 14;
pub const RX_SLOT_SYNTH_ELECTRO: usize = 15;
pub const RX_SLOT_SYNTH_VIBRO: usize = 16;
pub const RX_SLOT_SYNTH_PHRECEPTOR: usize = 17;
pub const RX_SLOT_SYNTH_MECH: usize = 19;
pub const RX_SLOT_SYNTH_THERMO: usize = 20;
pub const RX_SLOT_SYNTH_MAGNETO: usize = 21;
pub const RX_SLOT_SYNTH_BOND: usize = 22;
pub const RX_SLOT_SYNTH_REPAIR: usize = 23;

// ----- Transport band.

const TRANSPORT_CHEM_IDS: [u8; 8] = [
    CHEM_O2 as u8,
    CHEM_CO2 as u8,
    CHEM_GLU as u8,
    CHEM_AA as u8,
    CHEM_FA as u8,
    CHEM_MIN as u8,
    CHEM_ADP as u8,
    CHEM_WASTE as u8,
];

pub const GENERIC_TRANSPORT_COUNT: usize = 16;

/// Length of the full transport band: 8 named + 16 generic + 1 ATP.
const TRANSPORT_COUNT: usize = TRANSPORT_CHEM_IDS.len() + GENERIC_TRANSPORT_COUNT + 1;

/// First reaction slot occupied by the transport band.
pub const TRANSPORT_SLOT_BASE: usize = N_REACTIONS - TRANSPORT_COUNT;
/// Last transport slot, used by the ATP translocase.
pub const TRANSPORT_ATP_SLOT: usize = TRANSPORT_SLOT_BASE + TRANSPORT_COUNT - 1;
/// Glucose transport slot (vacuolar import for an engulfed organelle).
pub const TRANSPORT_GLU_SLOT: usize = TRANSPORT_SLOT_BASE + 2;

const TRANSPORT_VMAX: f32 = 0.6;

fn transport_targets() -> [u8; TRANSPORT_COUNT] {
    let mut out = [0u8; TRANSPORT_COUNT];
    let n_named = TRANSPORT_CHEM_IDS.len();
    out[..n_named].copy_from_slice(&TRANSPORT_CHEM_IDS);
    for i in 0..GENERIC_TRANSPORT_COUNT {
        out[n_named + i] = (NAMED_CHEMICAL_COUNT + i) as u8;
    }
    out[TRANSPORT_COUNT - 1] = CHEM_ATP as u8;
    out
}

// ----- Carbon-fixation tiers.

const CARBON_FIX_COUNT: usize = 8;

#[derive(Clone)]
struct CarbonFixTier {
    extra: Vec<u8>,
    glu_share: f32,
    vmax_lo: f32,
    vmax_hi: f32,
    byproduct: u8,
    light: f32,
    co2: u8,
}

fn carbon_fix_tiers() -> Vec<CarbonFixTier> {
    let order = &chem_table().generic_spawn_order;
    let cf_rare = order.len() - 1;
    vec![
        CarbonFixTier {
            extra: vec![],
            glu_share: 0.35,
            vmax_lo: 1.1,
            vmax_hi: 1.6,
            byproduct: CHEM_O2 as u8,
            light: 0.0,
            co2: 1,
        },
        CarbonFixTier {
            extra: vec![CHEM_MIN as u8],
            glu_share: 0.42,
            vmax_lo: 0.9,
            vmax_hi: 1.3,
            byproduct: CHEM_WASTE as u8,
            light: 0.0,
            co2: 1,
        },
        CarbonFixTier {
            extra: vec![order[0] as u8],
            glu_share: 0.48,
            vmax_lo: 0.8,
            vmax_hi: 1.1,
            byproduct: CHEM_O2 as u8,
            light: 0.8,
            co2: 1,
        },
        CarbonFixTier {
            extra: vec![order[12] as u8],
            glu_share: 0.60,
            vmax_lo: 0.60,
            vmax_hi: 0.90,
            byproduct: CHEM_WASTE as u8,
            light: 0.0,
            co2: 1,
        },
        CarbonFixTier {
            extra: vec![CHEM_MIN as u8, order[18] as u8],
            glu_share: 0.66,
            vmax_lo: 0.55,
            vmax_hi: 0.80,
            byproduct: CHEM_WASTE as u8,
            light: 0.0,
            co2: 2,
        },
        CarbonFixTier {
            extra: vec![order[cf_rare] as u8],
            glu_share: 0.80,
            vmax_lo: 0.40,
            vmax_hi: 0.60,
            byproduct: CHEM_WASTE as u8,
            light: 0.0,
            co2: 2,
        },
        CarbonFixTier {
            extra: vec![order[cf_rare - 1] as u8, order[12] as u8],
            glu_share: 0.88,
            vmax_lo: 0.40,
            vmax_hi: 0.55,
            byproduct: CHEM_WASTE as u8,
            light: 0.0,
            co2: 2,
        },
        CarbonFixTier {
            extra: vec![order[cf_rare - 2] as u8, CHEM_FA as u8],
            glu_share: 0.95,
            vmax_lo: 0.35,
            vmax_hi: 0.50,
            byproduct: CHEM_WASTE as u8,
            light: 0.0,
            co2: 3,
        },
    ]
}

fn build_carbon_fix(tier: &CarbonFixTier, rng: &mut Mulberry32) -> Reaction {
    let mut s_chem = vec![CHEM_CO2 as u8];
    s_chem.extend_from_slice(&tier.extra);
    let mut s_count = Vec::with_capacity(s_chem.len());
    for (i, _) in s_chem.iter().enumerate() {
        if i == 0 {
            s_count.push(tier.co2 as f32);
        } else {
            // 1 + (rng()<0.5 ? 0 : 1)  =>  1 or 2
            let bump = if rng.next_f64() < 0.5 { 0.0 } else { 1.0 };
            s_count.push(1.0 + bump);
        }
    }
    let chem = chem_table();
    let mut s_mass = 0.0f32;
    for (i, &c) in s_chem.iter().enumerate() {
        s_mass += s_count[i] * chem.molar_mass[c as usize];
    }
    let share = (tier.glu_share + (rng.next_f64() as f32 - 0.5) * 0.04)
        .clamp(0.2, 0.98);
    let glu_mass = share * s_mass;
    let bp_mass = s_mass - glu_mass;
    let mut p_chem = vec![CHEM_GLU as u8];
    let mut p_count = vec![glu_mass / chem.molar_mass[CHEM_GLU]];
    if bp_mass > 1e-3 {
        p_chem.push(tier.byproduct);
        p_count.push(bp_mass / chem.molar_mass[tier.byproduct as usize]);
    }
    let mut s_bond_e = 0.0f32;
    for (i, &c) in s_chem.iter().enumerate() {
        s_bond_e += s_count[i] * chem.bond_potential[c as usize];
    }
    let mut p_bond_e = 0.0f32;
    for (i, &c) in p_chem.iter().enumerate() {
        p_bond_e += p_count[i] * chem.bond_potential[c as usize];
    }
    let vmax = (tier.vmax_lo.ln()
        + rng.next_f64() as f32 * (tier.vmax_hi.ln() - tier.vmax_lo.ln()))
    .exp();
    Reaction {
        s_chem,
        s_count,
        p_chem,
        p_count,
        atp_delta: s_bond_e - p_bond_e,
        light_in: tier.light,
        vmax,
        uncat_rate: 0.0,
        surface_scale: false,
        atp_floor: true,
        mrna_scale: false,
        chl_scale: false,
        enz_scale: false,
        transport: None,
    }
}

// ----- Procedural-region generator.

const COUNT_POOL: [f32; 9] = [1.0, 1.0, 1.0, 1.0, 2.0, 2.0, 3.0, 5.0, 10.0];

fn pick_int(rng: &mut Mulberry32, n: usize) -> usize {
    (rng.next_f64() * n as f64).floor() as usize
}

fn pick_from(rng: &mut Mulberry32, arr: &[f32]) -> f32 {
    arr[pick_int(rng, arr.len())]
}

fn build_procedural(out: &mut Vec<Reaction>, rng: &mut Mulberry32) {
    let chem = chem_table();
    for _ in 0..N_REACTIONS {
        let n_s = 1 + pick_int(rng, 3);
        let n_p = 1 + pick_int(rng, 3);
        // Substrates -- unique chems via a small inline set.
        let mut s_chem = Vec::with_capacity(n_s);
        for _ in 0..n_s {
            loop {
                let id = pick_int(rng, CHEMICAL_COUNT) as u8;
                if !s_chem.contains(&id) {
                    s_chem.push(id);
                    break;
                }
            }
        }
        // Products -- unique AND disjoint from substrates.
        let mut p_chem = Vec::with_capacity(n_p);
        for _ in 0..n_p {
            loop {
                let id = pick_int(rng, CHEMICAL_COUNT) as u8;
                if !s_chem.contains(&id) && !p_chem.contains(&id) {
                    p_chem.push(id);
                    break;
                }
            }
        }
        // Substrate counts (raw).
        let mut s_count = Vec::with_capacity(n_s);
        let mut s_mass = 0.0f32;
        for &c in &s_chem {
            let cnt = pick_from(rng, &COUNT_POOL);
            s_count.push(cnt);
            s_mass += cnt * chem.molar_mass[c as usize];
        }
        // Product counts (raw, then scaled for mass balance).
        let mut p_count_raw = Vec::with_capacity(n_p);
        let mut p_mass_raw = 0.0f32;
        for &c in &p_chem {
            let cnt = pick_from(rng, &COUNT_POOL);
            p_count_raw.push(cnt);
            p_mass_raw += cnt * chem.molar_mass[c as usize];
        }
        let scale = s_mass / p_mass_raw;
        let p_count: Vec<f32> = p_count_raw.iter().map(|c| c * scale).collect();
        // The three TS rng draws that USED TO be atpDelta are still
        // consumed (and discarded) so every later draw stays bit-
        // identical to before that refactor.
        rng.next_f64();
        rng.next_f64();
        rng.next_f64();
        let mut s_bond_e = 0.0f32;
        for (i, &c) in s_chem.iter().enumerate() {
            s_bond_e += s_count[i] * chem.bond_potential[c as usize];
        }
        let mut p_bond_e = 0.0f32;
        for (i, &c) in p_chem.iter().enumerate() {
            p_bond_e += p_count[i] * chem.bond_potential[c as usize];
        }
        let atp_delta = s_bond_e - p_bond_e;
        // Light-driven? ~15% of reactions.
        let light_in = if rng.next_f64() < 0.15 {
            0.2 + (rng.next_f64() as f32) * 1.3
        } else {
            0.0
        };
        // vmax log-uniform 0.05..1.5.
        let vmax = (f64::ln(0.05) + rng.next_f64() * (f64::ln(1.5) - f64::ln(0.05))).exp()
            as f32;
        out.push(Reaction {
            s_chem,
            s_count,
            p_chem,
            p_count,
            atp_delta,
            light_in,
            vmax,
            uncat_rate: 0.0,
            surface_scale: false,
            atp_floor: false,
            mrna_scale: false,
            chl_scale: false,
            enz_scale: false,
            transport: None,
        });
    }
}

// ----- Named reactions (hand-tuned head).

struct NamedOpts {
    light_in: f32,
    surface_scale: bool,
    atp_floor: bool,
    mrna_scale: bool,
    chl_scale: bool,
    enz_scale: bool,
}
impl Default for NamedOpts {
    fn default() -> Self {
        Self {
            light_in: 0.0,
            surface_scale: false,
            atp_floor: false,
            mrna_scale: false,
            chl_scale: false,
            enz_scale: false,
        }
    }
}

fn mk(
    s_chem: &[usize],
    s_count: &[f32],
    p_chem: &[usize],
    p_count: &[f32],
    atp_delta: f32,
    rate: f32,
    opts: NamedOpts,
) -> Reaction {
    Reaction {
        s_chem: s_chem.iter().map(|&c| c as u8).collect(),
        s_count: s_count.to_vec(),
        p_chem: p_chem.iter().map(|&c| c as u8).collect(),
        p_count: p_count.to_vec(),
        atp_delta,
        light_in: opts.light_in,
        vmax: rate,
        uncat_rate: rate,
        surface_scale: opts.surface_scale,
        atp_floor: opts.atp_floor,
        mrna_scale: opts.mrna_scale,
        chl_scale: opts.chl_scale,
        enz_scale: opts.enz_scale,
        transport: None,
    }
}

fn install_named(out: &mut [Reaction]) {
    // Aerobic: glu + o2 -> 2 co2 + 10 atp.
    out[0] = mk(&[CHEM_GLU, CHEM_O2], &[1.0, 1.0], &[CHEM_CO2], &[2.0], 10.0, 16.0, NamedOpts::default());
    out[1] = mk(&[CHEM_GLU], &[1.0], &[CHEM_CO2, CHEM_WASTE], &[0.5, 0.5], 2.0, 1.5, NamedOpts::default());
    out[2] = mk(&[CHEM_FA, CHEM_O2], &[1.0, 1.0], &[CHEM_CO2], &[2.0], 14.0, 1.5, NamedOpts::default());
    out[3] = mk(
        &[CHEM_CO2], &[1.0], &[CHEM_GLU, CHEM_O2], &[0.5, 0.5], -1.0, 6.5,
        NamedOpts { light_in: 1.0, surface_scale: true, chl_scale: true, ..NamedOpts::default() },
    );
    out[4] = mk(&[CHEM_GLU, CHEM_MIN], &[0.7, 0.3], &[CHEM_AA], &[1.0], -2.0, 1.2,
        NamedOpts { atp_floor: true, mrna_scale: true, ..NamedOpts::default() });
    out[5] = mk(&[CHEM_GLU, CHEM_MIN], &[0.9, 0.1], &[CHEM_FA], &[1.0], -3.0, 1.5,
        NamedOpts { atp_floor: true, mrna_scale: true, ..NamedOpts::default() });
    out[6] = mk(&[CHEM_AA, CHEM_MIN], &[0.5, 0.5], &[CHEM_CHL], &[1.0], -8.0, 0.2,
        NamedOpts { atp_floor: true, mrna_scale: true, ..NamedOpts::default() });
    out[7] = mk(&[CHEM_AA, CHEM_MIN], &[0.5, 0.5], &[CHEM_ENZ], &[1.0], -4.0, 0.4,
        NamedOpts { atp_floor: true, mrna_scale: true, ..NamedOpts::default() });
    out[8] = mk(&[CHEM_AA, CHEM_MIN], &[0.5, 0.5], &[CHEM_MRNA], &[1.0], -10.0, 0.15,
        NamedOpts { atp_floor: true, mrna_scale: true, ..NamedOpts::default() });
    out[9] = mk(&[CHEM_AA, CHEM_FA], &[0.5, 0.5], &[CHEM_MEMBRANE], &[1.0], -1.0, 0.8,
        NamedOpts { atp_floor: true, mrna_scale: true, ..NamedOpts::default() });
    out[10] = mk(&[CHEM_BIOPOLYMER], &[1.0], &[CHEM_GLU, CHEM_AA, CHEM_FA], &[0.5, 0.3, 0.2], 1.0, 6.0,
        NamedOpts { enz_scale: true, ..NamedOpts::default() });
    out[11] = mk(&[CHEM_FA], &[1.0], &[CHEM_MEMBRANE], &[1.0], -2.0, 0.6,
        NamedOpts { atp_floor: true, mrna_scale: true, ..NamedOpts::default() });
    out[12] = mk(&[CHEM_AA, CHEM_MIN], &[0.5, 0.5], &[CHEM_PHOTORECEPTOR_VISIBLE], &[1.0], -3.0, 0.15,
        NamedOpts { atp_floor: true, mrna_scale: true, ..NamedOpts::default() });
    out[13] = mk(&[CHEM_AA, CHEM_MIN], &[0.5, 0.5], &[CHEM_PHOTORECEPTOR_LONG], &[1.0], -3.0, 0.15,
        NamedOpts { atp_floor: true, mrna_scale: true, ..NamedOpts::default() });
    out[14] = mk(&[CHEM_AA, CHEM_MIN], &[0.5, 0.5], &[CHEM_PHOTORECEPTOR_SURFACE], &[1.0], -3.0, 0.15,
        NamedOpts { atp_floor: true, mrna_scale: true, ..NamedOpts::default() });
    out[15] = mk(&[CHEM_AA, CHEM_MIN], &[0.5, 0.5], &[CHEM_ELECTRORECEPTOR], &[1.0], -3.0, 0.15,
        NamedOpts { atp_floor: true, mrna_scale: true, ..NamedOpts::default() });
    out[16] = mk(&[CHEM_AA, CHEM_MIN], &[0.5, 0.5], &[CHEM_VIBRORECEPTOR], &[1.0], -3.0, 0.15,
        NamedOpts { atp_floor: true, mrna_scale: true, ..NamedOpts::default() });
    out[17] = mk(&[CHEM_AA, CHEM_MIN], &[0.5, 0.5], &[CHEM_PHRECEPTOR], &[1.0], -3.0, 0.15,
        NamedOpts { atp_floor: true, mrna_scale: true, ..NamedOpts::default() });
    out[18] = mk(&[CHEM_AA, CHEM_MIN], &[0.5, 0.5], &[CHEM_CHEMORECEPTOR_MARKER0], &[1.0], -3.0, 0.0,
        NamedOpts { atp_floor: true, mrna_scale: true, ..NamedOpts::default() });
    out[19] = mk(&[CHEM_AA, CHEM_MIN], &[0.5, 0.5], &[CHEM_MECHANORECEPTOR], &[1.0], -3.0, 0.15,
        NamedOpts { atp_floor: true, mrna_scale: true, ..NamedOpts::default() });
    out[20] = mk(&[CHEM_AA, CHEM_MIN], &[0.5, 0.5], &[CHEM_THERMORECEPTOR], &[1.0], -3.0, 0.15,
        NamedOpts { atp_floor: true, mrna_scale: true, ..NamedOpts::default() });
    out[21] = mk(&[CHEM_AA, CHEM_MIN], &[0.5, 0.5], &[CHEM_MAGNETORECEPTOR], &[1.0], -3.0, 0.15,
        NamedOpts { atp_floor: true, mrna_scale: true, ..NamedOpts::default() });
    out[22] = mk(&[CHEM_AA, CHEM_FA], &[0.5, 0.5], &[CHEM_BOND], &[1.0], -2.0, 0.3,
        NamedOpts { atp_floor: true, mrna_scale: true, ..NamedOpts::default() });
    out[23] = mk(&[CHEM_AA, CHEM_MIN], &[0.5, 0.5], &[CHEM_REPAIR], &[1.0], -3.0, 0.2,
        NamedOpts { atp_floor: true, mrna_scale: true, ..NamedOpts::default() });
    out[24] = mk(&[CHEM_GLU], &[1.0], &[CHEM_BIOPOLYMER], &[1.0], -2.0, 0.5,
        NamedOpts { atp_floor: true, mrna_scale: true, ..NamedOpts::default() });
    out[25] = mk(&[], &[], &[], &[], 6.0, 16.0,
        NamedOpts { light_in: 1.0, surface_scale: true, chl_scale: true, ..NamedOpts::default() });
}

fn install_transporters(out: &mut [Reaction]) {
    let targets = transport_targets();
    for (n, &t) in targets.iter().enumerate() {
        out[TRANSPORT_SLOT_BASE + n] = Reaction::empty_transport(t, TRANSPORT_VMAX);
    }
}

fn install_carbon_fix(out: &mut [Reaction], rng: &mut Mulberry32) {
    // Acquirable set: world-fed chems + every generic (any of them
    // can spawn as particles).
    let mut acquirable = [false; CHEMICAL_COUNT];
    for &c in &[CHEM_CO2, CHEM_O2, CHEM_MIN, CHEM_FA, CHEM_ADP, CHEM_BIOPOLYMER, CHEM_GLU, CHEM_AA, CHEM_WASTE] {
        acquirable[c] = true;
    }
    for &g in &chem_table().generic_spawn_order {
        acquirable[g] = true;
    }
    let mut valuable = [false; CHEMICAL_COUNT];
    for &c in &[CHEM_GLU, CHEM_AA, CHEM_FA, CHEM_ATP, CHEM_MEMBRANE, CHEM_BIOPOLYMER, CHEM_CHL, CHEM_ENZ, CHEM_MRNA] {
        valuable[c] = true;
    }

    // Slot interest score; lower = retire first.
    let interest = |r: &Reaction| -> f64 {
        let mut runnable = true;
        for &s in &r.s_chem {
            if !acquirable[s as usize] {
                runnable = false;
            }
        }
        let mut makes_value = false;
        let mut makes_glu = false;
        for &p in &r.p_chem {
            if valuable[p as usize] {
                makes_value = true;
            }
            if p as usize == CHEM_GLU {
                makes_glu = true;
            }
        }
        // Retire first: circular GLU routes a free cell can't run.
        if makes_glu && !runnable {
            return -1.0;
        }
        (if runnable { 2.0 } else { 0.0 })
            + (if makes_value { 2.0 } else { 0.0 })
            + (r.atp_delta.abs() * 3.0).min(2.0) as f64
            + (r.vmax as f64).min(1.0)
    };

    // Rank slots in the generic region by interest, ascending; ties
    // break by slot index (matches the TS `a - b` secondary sort).
    let mut slots: Vec<usize> = (NAMED_REACTION_COUNT..TRANSPORT_SLOT_BASE).collect();
    slots.sort_by(|&a, &b| {
        let ia = interest(&out[a]);
        let ib = interest(&out[b]);
        match ia.partial_cmp(&ib).unwrap_or(std::cmp::Ordering::Equal) {
            std::cmp::Ordering::Equal => a.cmp(&b),
            other => other,
        }
    });
    let tiers = carbon_fix_tiers();
    for k in 0..CARBON_FIX_COUNT {
        out[slots[k]] = build_carbon_fix(&tiers[k], rng);
    }
}

fn build_table() -> Vec<Reaction> {
    let mut rng = Mulberry32::new(0xE2C4_BEEF);
    let mut out = Vec::with_capacity(N_REACTIONS);
    build_procedural(&mut out, &mut rng);
    install_named(&mut out);
    install_transporters(&mut out);
    install_carbon_fix(&mut out, &mut rng);
    out
}

/// One-shot accessor; the table is built on first call and pinned.
pub fn table() -> &'static [Reaction] {
    static T: OnceLock<Vec<Reaction>> = OnceLock::new();
    T.get_or_init(build_table)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32, eps: f32) -> bool {
        (a - b).abs() <= eps
    }

    #[test]
    fn count_matches_n_reactions() {
        assert_eq!(table().len(), N_REACTIONS);
    }

    #[test]
    fn named_slot_constants_locked() {
        // RX_SLOT_RESPIRATION is the aerobic respiration row; the
        // engine relies on this layout for the disassembler and the
        // archetype builders.
        let r = &table()[RX_SLOT_RESPIRATION];
        assert_eq!(r.s_chem, vec![CHEM_GLU as u8, CHEM_O2 as u8]);
        assert_eq!(r.p_chem, vec![CHEM_CO2 as u8]);
        assert_eq!(r.atp_delta, 10.0);
        assert_eq!(r.vmax, 16.0);
        assert_eq!(r.uncat_rate, 16.0);
    }

    #[test]
    fn photosynth_slot_matches_ts() {
        let r = &table()[RX_SLOT_PHOTOSYNTH];
        assert_eq!(r.s_chem, vec![CHEM_CO2 as u8]);
        assert_eq!(r.p_chem, vec![CHEM_GLU as u8, CHEM_O2 as u8]);
        assert_eq!(r.atp_delta, -1.0);
        assert!(approx(r.vmax, 6.5, 1e-5));
        assert!(approx(r.light_in, 1.0, 1e-5));
        assert!(r.surface_scale && r.chl_scale);
    }

    #[test]
    fn digest_biop_has_enz_scale() {
        let r = &table()[RX_SLOT_DIGEST_BIOP];
        assert_eq!(r.s_chem, vec![CHEM_BIOPOLYMER as u8]);
        assert_eq!(r.p_chem, vec![CHEM_GLU as u8, CHEM_AA as u8, CHEM_FA as u8]);
        assert!(approx(r.p_count[0], 0.5, 1e-5));
        assert!(approx(r.p_count[1], 0.3, 1e-5));
        assert!(approx(r.p_count[2], 0.2, 1e-5));
        assert!(r.enz_scale);
    }

    #[test]
    fn photophosphorylation_is_pure_light() {
        // Slot 25: light + chl -> +6 ATP, no substrates/products.
        let r = &table()[25];
        assert!(r.s_chem.is_empty());
        assert!(r.p_chem.is_empty());
        assert_eq!(r.atp_delta, 6.0);
        assert!(r.chl_scale && r.surface_scale);
        assert_eq!(r.light_in, 1.0);
    }

    #[test]
    fn transport_band_layout() {
        assert_eq!(TRANSPORT_SLOT_BASE, 231);
        assert_eq!(TRANSPORT_GLU_SLOT, 233);
        assert_eq!(TRANSPORT_ATP_SLOT, 255);
        let glu = &table()[TRANSPORT_GLU_SLOT];
        assert_eq!(glu.transport, Some(CHEM_GLU as u8));
        assert_eq!(glu.vmax, TRANSPORT_VMAX);
        let atp = &table()[TRANSPORT_ATP_SLOT];
        assert_eq!(atp.transport, Some(CHEM_ATP as u8));
    }

    // Procedural slot 100 -- pure generic, captured from the TS impl.
    #[test]
    fn procedural_slot_100_matches_ts() {
        let r = &table()[100];
        assert_eq!(r.s_chem, vec![4]);
        assert_eq!(r.s_count, vec![1.0]);
        assert_eq!(r.p_chem, vec![7, 70, 27]);
        assert!(approx(r.p_count[0], 0.611_854_6, 1e-5));
        assert!(approx(r.p_count[1], 0.122_370_92, 1e-5));
        assert!(approx(r.p_count[2], 0.122_370_92, 1e-5));
        assert!(approx(r.atp_delta, 0.919_307_5, 1e-4));
        assert!(approx(r.vmax, 0.878_537_3, 1e-5));
        assert_eq!(r.light_in, 0.0);
        assert_eq!(r.uncat_rate, 0.0);
        assert!(!r.atp_floor);
    }

    #[test]
    fn procedural_slot_150_matches_ts() {
        let r = &table()[150];
        assert_eq!(r.s_chem, vec![55, 71, 8]);
        assert_eq!(r.s_count, vec![1.0, 1.0, 5.0]);
        assert_eq!(r.p_chem, vec![48, 87, 86]);
        assert!(approx(r.p_count[0], 4.165_108, 1e-4));
        assert!(approx(r.atp_delta, -2.668_479_7, 1e-3));
    }

    #[test]
    fn carbon_fix_slot_39_matches_ts() {
        // Slot 39 was overwritten by CF tier 1 (substrate = CO2 + MIN
        // pattern with byproduct WASTE -- but the specific tier
        // depends on which generic was lowest-interest).
        let r = &table()[39];
        // Carbon-fix slots always make GLU and have atp_floor=true.
        assert!(r.p_chem.contains(&(CHEM_GLU as u8)));
        assert!(r.atp_floor);
        assert!(r.transport.is_none());
        // Specific TS golden: substrates [1, 61, 60], counts [2,1,2]
        assert_eq!(r.s_chem, vec![1, 61, 60]);
        assert_eq!(r.s_count, vec![2.0, 1.0, 2.0]);
        assert_eq!(r.p_chem, vec![2, 7]);
        assert!(approx(r.p_count[0], 7.055_46, 1e-3));
        assert!(approx(r.atp_delta, -1.758_708_8, 1e-3));
    }
}
