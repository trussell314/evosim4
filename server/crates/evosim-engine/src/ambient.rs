//! Regional dissolved field. Phase 1 of the regions port: replaces the
//! flat single-stock `Vec<f32>[chem]` with a per-region grid sized off
//! `regions::REGION_PX`, so dissolution / leakage / aeration / transport
//! all act on the LOCAL region instead of a single global stock.
//!
//! Layout: `dissolved[region * CHEMICAL_COUNT + chem]` flat array. Read /
//! write through `at`, `deposit_at`, `take_at` -- they look up the cell's
//! / particle's region from the (x, y) the caller hands them.
//!
//! Cells exchange with the field through three channels:
//!   - **autolysis dump**: when a cell dies, a fraction of each emitted
//!     chem dissolves into the local region instead of being released
//!     as a particle. Models dissolution of small molecules at death.
//!   - **passive leak**: each tick every cell loses a tiny fraction of
//!     each chem to its region's dissolved field
//!   - **passive uptake**: each tick every cell pulls a tiny fraction
//!     of its region's dissolved field inward
//!
//! What's NOT here yet (kept honest):
//!   - per-chem permeability gating (TS reads from the chem table; we
//!     use a flat low rate until the permeability pass lands)
//!   - solubility-capped dissolved capacity + dissolve/precipitate
//!     hysteresis (Phase 3)
//!   - reserve bucket (Phase 4) -- depends on terrain solid mask
//!   - vent/atmosphere relaxation toward `AMBIENT_TARGET` -- depends on
//!     vent/terrain landing
//!   - regional temperature scaling on the Jacobi diffusion coefficient
//!     (depends on `regionTemp` field which needs the vent port)
//!   - rock barrier on diffusion (depends on terrain)

use crate::chem_ids::{CHEMICAL_COUNT, NAMED_CHEMICAL_COUNT};
use crate::creatures::CreatureStore;
use crate::regions::{
    ambient_target, region_cols, region_index_at, region_rows, REGION_PX,
};
use serde::{Deserialize, Serialize};

/// Per-region dissolved field. Flat layout: dissolved[region * CHEMICAL_COUNT + chem].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AmbientField {
    pub width: f32,
    pub height: f32,
    pub cols: usize,
    pub rows: usize,
    /// Length = `cols * rows * CHEMICAL_COUNT`. Indexed
    /// `[region * CHEMICAL_COUNT + chem]`.
    pub dissolved: Vec<f32>,
    /// Per-region solid flag: 1 if the region center sits inside rock.
    /// Solid regions are no-flux barriers for the diffusion pass and
    /// don't precipitate. Rebuilt by `World::rebuild_terrain_derivatives`
    /// after the obstacle list changes; otherwise stays all-zero (the
    /// "no terrain" default) and every diffusion / precip call takes
    /// the fast path.
    #[serde(default)]
    pub solid_mask: Vec<u8>,
    /// Sticky per-chem activity flag. `true` for any chem that has ever
    /// been deposited anywhere (or was seeded at construction). The
    /// diffusion + precipitation passes iterate only flagged chems
    /// instead of all 96 -- since most generic chems stay 0 in the
    /// typical demo, this collapses the dissolved hot loop's inner
    /// iteration count from ~96 to ~15. Sticky (never cleared on drain
    /// to zero) so the optimisation is safe under any access pattern;
    /// false positives are just an unnecessary scan cycle.
    #[serde(default = "default_chem_active")]
    pub chem_active: Vec<u8>,
}

fn default_chem_active() -> Vec<u8> {
    vec![1; CHEMICAL_COUNT]
}

/// Stride between successive regions' chem blocks. Always equals
/// `CHEMICAL_COUNT`. Exposed so the diffusion pass can iterate per-chem
/// without recomputing.
pub const AMBIENT_STRIDE: usize = CHEMICAL_COUNT;

impl AmbientField {
    /// Empty single-region grid (no AMBIENT_TARGET seed). Suitable
    /// for tests that compare against absolute mass totals.
    /// Production code calls `new_for_world` which seeds the
    /// per-region O2/CO2 equilibrium floors.
    pub fn new() -> Self {
        Self {
            width: REGION_PX,
            height: REGION_PX,
            cols: 1,
            rows: 1,
            dissolved: vec![0.0; AMBIENT_STRIDE],
            solid_mask: vec![0_u8; 1],
            chem_active: vec![0_u8; CHEMICAL_COUNT],
        }
    }

    /// True if the region at `region_idx` is flagged solid (rock).
    /// Fast path: empty mask means "no terrain", every region treated
    /// as water.
    #[inline]
    pub fn is_solid(&self, region_idx: usize) -> bool {
        self.solid_mask.get(region_idx).copied().unwrap_or(0) != 0
    }

    /// Per-region grid sized for the world, seeded with `AMBIENT_TARGET`
    /// per region (O2 + CO2 floors; everything else 0). This is the
    /// "every region starts at the equilibrium target" seed that keeps
    /// the first ticks from being dominated by ambient transients.
    pub fn new_for_world(width: f32, height: f32) -> Self {
        let cols = region_cols(width);
        let rows = region_rows(height);
        let n = cols * rows;
        let target = ambient_target();
        let mut dissolved = vec![0.0; n * AMBIENT_STRIDE];
        let mut chem_active = vec![0_u8; CHEMICAL_COUNT];
        for r in 0..n {
            let base = r * AMBIENT_STRIDE;
            for (k, &v) in target.iter().enumerate().take(AMBIENT_STRIDE) {
                dissolved[base + k] = v;
                if v != 0.0 {
                    chem_active[k] = 1;
                }
            }
        }
        Self {
            width,
            height,
            cols,
            rows,
            dissolved,
            solid_mask: vec![0_u8; n],
            chem_active,
        }
    }

    /// Region index for (x, y), clamped to bounds.
    #[inline]
    fn region_idx(&self, x: f32, y: f32) -> usize {
        region_index_at(self.width, self.height, x, y)
    }

    /// Base offset into `dissolved` for the region containing (x, y).
    #[inline]
    fn base_at(&self, x: f32, y: f32) -> usize {
        self.region_idx(x, y) * AMBIENT_STRIDE
    }

    /// Read dissolved mass of `chem` at (x, y).
    pub fn at(&self, chem: usize, x: f32, y: f32) -> f32 {
        self.dissolved[self.base_at(x, y) + chem]
    }

    /// Deposit `mass` of `chem` into the region containing (x, y).
    pub fn deposit_at(&mut self, chem: usize, mass: f32, x: f32, y: f32) {
        if mass <= 0.0 {
            return;
        }
        let base = self.base_at(x, y);
        self.dissolved[base + chem] += mass;
        // Flip the sticky activity flag so diffuse / precipitation
        // iterate this chem from here on.
        if let Some(slot) = self.chem_active.get_mut(chem) {
            *slot = 1;
        }
    }

    /// Withdraw at most `want` of `chem` from the region containing
    /// (x, y); returns the actual amount taken (bounded by what the
    /// region holds). Mass-conserving with the caller adding the
    /// return value somewhere else.
    pub fn take_at(&mut self, chem: usize, want: f32, x: f32, y: f32) -> f32 {
        if want <= 0.0 {
            return 0.0;
        }
        let base = self.base_at(x, y);
        let slot = &mut self.dissolved[base + chem];
        let taken = want.min(*slot);
        *slot -= taken;
        taken
    }

    /// Sum across all regions of all chems. Snapshot stat.
    pub fn total(&self) -> f32 {
        self.dissolved.iter().sum()
    }

    /// Sum across all regions of a single chem.
    pub fn total_per_chem(&self, chem: usize) -> f32 {
        let n = self.cols * self.rows;
        let mut s = 0.0;
        for r in 0..n {
            s += self.dissolved[r * AMBIENT_STRIDE + chem];
        }
        s
    }

    /// Per-chem total vector (length = CHEMICAL_COUNT). Used by the
    /// snapshot's `ambient_chems` so clients can show the world-wide
    /// dissolved roster without iterating regions.
    pub fn totals_per_chem(&self) -> Vec<f32> {
        let mut out = vec![0.0; AMBIENT_STRIDE];
        let n = self.cols * self.rows;
        for r in 0..n {
            let b = r * AMBIENT_STRIDE;
            for (k, slot) in out.iter_mut().enumerate().take(AMBIENT_STRIDE) {
                *slot += self.dissolved[b + k];
            }
        }
        out
    }
}

impl Default for AmbientField {
    fn default() -> Self {
        Self::new()
    }
}

/// Fraction of a cell's named-chem pool that leaks into the ambient
/// per second. Small enough that a healthy cell barely notices.
const LEAK_PER_S: f32 = 0.005;
/// Fraction of the ambient stock a cell pulls inward per second.
/// Passive uptake rate. Bumped 0.005 -> 0.02: at the old rate a cell
/// sitting in a glucose-rich region pulled only 0.5%/s, so even when
/// the dissolved field was flooded with food the non-osmotroph
/// founders couldn't draw enough to cover metabolism and starved.
/// 2%/s gives every cell a usable passive feeding path while still
/// being far slower than active TRANSPORT (the osmotroph advantage
/// survives).
const UPTAKE_PER_S: f32 = 0.02;

/// Run leak + uptake against every cell at its local region.
/// Mass-conservingly. Skips signal chems (activation pool slots that
/// carry signed amplitudes, not physical mass).
pub fn run_ambient_exchange(creatures: &mut CreatureStore, ambient: &mut AmbientField, dt: f32) {
    let leak_frac = (LEAK_PER_S * dt).min(1.0);
    let uptake_frac = (UPTAKE_PER_S * dt).min(1.0);
    let n = creatures.n;
    for i in 0..n {
        let x = creatures.x[i];
        let y = creatures.y[i];
        for chem in 0..NAMED_CHEMICAL_COUNT {
            if crate::chem_ids::is_signal(chem) {
                continue;
            }
            let cell_amount = creatures.chems[chem][i];
            // Leak cell -> ambient.
            let leak = cell_amount * leak_frac;
            creatures.chems[chem][i] -= leak;
            ambient.deposit_at(chem, leak, x, y);
            // Uptake ambient -> cell. Compute desired against current
            // slot, then take_at honours availability (idempotent if
            // another cell drained the slot earlier this pass).
            let desired = ambient.at(chem, x, y) * uptake_frac;
            let taken = ambient.take_at(chem, desired, x, y);
            creatures.chems[chem][i] += taken;
        }
    }
}

/// Jacobi cross-region diffusion of the dissolved field. Smears out
/// per-region gradients toward a uniform world value with a
/// ~60-second half-life across the longest wavelength. No temperature
/// scaling yet (depends on regionTemp), no solid-rock barrier yet
/// (depends on terrain). Mass-conserving: each pair-wise exchange
/// adds and removes the same amount, scratch-buffered so order /
/// direction don't matter.
pub fn diffuse_dissolved(ambient: &mut AmbientField, dt: f32) {
    let cols = ambient.cols;
    let rows = ambient.rows;
    let n = cols * rows;
    if n < 2 {
        return;
    }
    // Per-edge exchange fraction. Lambda = ln(2) / ticks_to_halflife;
    // alpha solves lambda = alpha * (pi/N)^2 for the longest-wavelength
    // mode (small-mode approximation). Clamped to 0.1 well under the
    // 2-D explicit stability ceiling.
    const HALFLIFE_S: f32 = 60.0;
    let n_max = cols.max(rows) as f32;
    let ticks = HALFLIFE_S / dt.max(1e-6);
    let wmode = std::f32::consts::PI / n_max;
    let mut alpha = std::f32::consts::LN_2 / (ticks * wmode * wmode);
    if alpha > 0.1 {
        alpha = 0.1;
    }
    let old = ambient.dissolved.clone();
    // Collect the active-chem indices once so the inner loop walks a
    // dense list instead of iterating all CHEMICAL_COUNT slots and
    // testing each. Most generic chems stay at zero in the default
    // demo, so this typically drops the inner from 96 to ~15.
    let active_chems: Vec<usize> = ambient
        .chem_active
        .iter()
        .enumerate()
        .filter_map(|(k, &v)| if v != 0 { Some(k) } else { None })
        .collect();
    for ry in 0..rows {
        for rx in 0..cols {
            let ri = ry * cols + rx;
            // Rock: no-flux barrier. Solid regions never exchange.
            if ambient.is_solid(ri) {
                continue;
            }
            let base = ri * AMBIENT_STRIDE;
            // Four neighbour indices (or -1 = none).
            let nbs: [Option<usize>; 4] = [
                if rx > 0 { Some(ri - 1) } else { None },
                if rx < cols - 1 { Some(ri + 1) } else { None },
                if ry > 0 { Some(ri - cols) } else { None },
                if ry < rows - 1 { Some(ri + cols) } else { None },
            ];
            for nb in nbs.iter().flatten() {
                if ambient.is_solid(*nb) {
                    continue;
                }
                let jb = nb * AMBIENT_STRIDE;
                for &k in &active_chems {
                    let oi = old[base + k];
                    let oj = old[jb + k];
                    if oi != oj {
                        ambient.dissolved[base + k] += alpha * (oj - oi);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::{CHEM_GLU, NAMED_CHEMICAL_COUNT};
    use crate::creatures::CreatureInit;

    fn make_cell_at(glu: f32, x: f32, y: f32) -> CreatureStore {
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[CHEM_GLU] = glu;
        let mut s = CreatureStore::new();
        s.push(CreatureInit {
            x,
            y,
            r: 8.0,
            chems: Some(chems),
            ..CreatureInit::default()
        });
        s
    }

    #[test]
    fn high_cell_leaks_into_empty_ambient() {
        let mut cs = make_cell_at(100.0, 25.0, 25.0);
        let mut amb = AmbientField::new();
        run_ambient_exchange(&mut cs, &mut amb, 1.0);
        assert!(cs.chems[CHEM_GLU][0] < 100.0, "cell should leak");
        assert!(amb.at(CHEM_GLU, 25.0, 25.0) > 0.0, "ambient should gain");
    }

    #[test]
    fn high_ambient_seeps_into_empty_cell() {
        let mut cs = make_cell_at(0.0, 25.0, 25.0);
        let mut amb = AmbientField::new();
        amb.deposit_at(CHEM_GLU, 100.0, 25.0, 25.0);
        run_ambient_exchange(&mut cs, &mut amb, 1.0);
        assert!(cs.chems[CHEM_GLU][0] > 0.0, "cell should take up");
        assert!(amb.at(CHEM_GLU, 25.0, 25.0) < 100.0, "ambient should drop");
    }

    #[test]
    fn mass_is_conserved_per_chem() {
        let mut cs = make_cell_at(60.0, 25.0, 25.0);
        let mut amb = AmbientField::new();
        amb.deposit_at(CHEM_GLU, 40.0, 25.0, 25.0);
        let total0 = cs.chems[CHEM_GLU][0] + amb.total_per_chem(CHEM_GLU);
        run_ambient_exchange(&mut cs, &mut amb, 1.0);
        let total1 = cs.chems[CHEM_GLU][0] + amb.total_per_chem(CHEM_GLU);
        assert!(
            (total1 - total0).abs() < 1e-3,
            "mass should be conserved: {total0} -> {total1}"
        );
    }

    #[test]
    fn signal_chems_are_skipped() {
        let mut chems = vec![0.0; NAMED_CHEMICAL_COUNT];
        chems[crate::chem_ids::CHEM_ACT_PHOTO_VISIBLE] = 7.0;
        let mut cs = CreatureStore::new();
        cs.push(CreatureInit {
            x: 25.0,
            y: 25.0,
            r: 8.0,
            chems: Some(chems),
            ..CreatureInit::default()
        });
        let mut amb = AmbientField::new();
        run_ambient_exchange(&mut cs, &mut amb, 1.0);
        assert_eq!(cs.chems[crate::chem_ids::CHEM_ACT_PHOTO_VISIBLE][0], 7.0);
        assert_eq!(
            amb.at(crate::chem_ids::CHEM_ACT_PHOTO_VISIBLE, 25.0, 25.0),
            0.0
        );
    }

    #[test]
    fn region_isolation_keeps_local_deposits_local() {
        // 200x200 world -> 4x4 = 16 regions. Depositing in the corner
        // shouldn't immediately appear in the far corner.
        let mut amb = AmbientField::new_for_world(200.0, 200.0);
        amb.deposit_at(CHEM_GLU, 100.0, 10.0, 10.0);
        assert!(amb.at(CHEM_GLU, 10.0, 10.0) >= 100.0);
        // Far corner only carries the seeded AMBIENT_TARGET (0 for GLU).
        assert_eq!(amb.at(CHEM_GLU, 190.0, 190.0), 0.0);
    }

    #[test]
    fn jacobi_diffusion_spreads_gradient_and_conserves_mass() {
        let mut amb = AmbientField::new_for_world(200.0, 200.0);
        amb.deposit_at(CHEM_GLU, 100.0, 10.0, 10.0);
        let before = amb.total_per_chem(CHEM_GLU);
        // Run a handful of diffusion ticks; mass leaks into neighbours.
        for _ in 0..60 {
            diffuse_dissolved(&mut amb, 1.0);
        }
        let after = amb.total_per_chem(CHEM_GLU);
        assert!(
            (after - before).abs() < 1e-2,
            "diffusion should conserve mass: {before} -> {after}"
        );
        // The far corner should now hold some of the originally-corner
        // mass.
        assert!(
            amb.at(CHEM_GLU, 190.0, 190.0) > 0.0,
            "gradient should have spread to the far corner"
        );
    }

    #[test]
    fn solid_mask_blocks_diffusion() {
        // 200x200 -> 4x4 = 16 regions. Mark region 1 (column 1, row 0)
        // solid so the chem in region 0 can't diffuse east. It can
        // still diffuse south.
        let mut amb = AmbientField::new_for_world(200.0, 200.0);
        amb.solid_mask[1] = 1;
        amb.deposit_at(CHEM_GLU, 100.0, 10.0, 10.0);
        for _ in 0..100 {
            diffuse_dissolved(&mut amb, 1.0);
        }
        // Region east of region 0 (which is region 1) should still
        // hold 0 GLU because the diffusion was blocked.
        // region 1 corner is at x=50, y=0.
        assert_eq!(amb.at(CHEM_GLU, 55.0, 10.0), 0.0);
        // Region south of region 0 (region 4 at y=50) should have
        // received some.
        assert!(amb.at(CHEM_GLU, 10.0, 55.0) > 0.0);
    }

    #[test]
    fn totals_per_chem_sums_across_regions() {
        let mut amb = AmbientField::new_for_world(200.0, 200.0);
        amb.deposit_at(CHEM_GLU, 10.0, 10.0, 10.0);
        amb.deposit_at(CHEM_GLU, 20.0, 110.0, 10.0);
        amb.deposit_at(CHEM_GLU, 30.0, 110.0, 110.0);
        let totals = amb.totals_per_chem();
        assert!((totals[CHEM_GLU] - 60.0).abs() < 1e-3);
    }
}
