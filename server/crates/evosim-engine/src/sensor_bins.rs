//! Spatial sensor bins, ported from `rebuildSensorBins` +
//! `chemGradient` in `src/sim/collision.ts`. Builds a 40px grid over
//! the world every tick, binning every particle by its chem id; a
//! per-chem lookup then computes a weighted gradient vector at any
//! query position, which is what the VM's SENSE_OUT op pushes onto
//! the stack.
//!
//! The TS implementation has reserve-field blending (it adds region
//! ambient stocks into the bins as particle-equivalents) so cells
//! can sense dissolved chems too; that lands when regions / reserves
//! port. The particle-side gradient is what makes the world feel
//! navigable to evolved seekers, so wiring it now -- even without
//! reserve blending -- already makes SENSE_OUT a real signal.

use crate::chem_ids::CHEMICAL_COUNT;
use crate::particles::ParticleStore;

/// Bin pitch in world pixels, matching TS `SENSOR_BIN = 40`.
pub const SENSOR_BIN: f32 = 40.0;

/// Per-chem 2D histogram + centroid sums. One entry per (chem, bin).
/// Bins are laid out row-major: `bin = by * cols + bx`.
#[derive(Default)]
pub struct SensorBins {
    pub cols: usize,
    pub rows: usize,
    /// Length `CHEMICAL_COUNT`. Each inner Vec is `cols * rows`.
    pub count: Vec<Vec<i32>>,
    pub sum_x: Vec<Vec<f32>>,
    pub sum_y: Vec<Vec<f32>>,
}

impl SensorBins {
    pub fn new() -> Self {
        Self::default()
    }

    /// Rebuild every tick. Resizes the inner vecs as the world or
    /// chem count changes; otherwise reuses the allocation.
    pub fn rebuild(&mut self, store: &ParticleStore, width: f32, height: f32) {
        let cols = ((width / SENSOR_BIN).ceil() as usize).max(1);
        let rows = ((height / SENSOR_BIN).ceil() as usize).max(1);
        let n = cols * rows;
        let resize = self.cols != cols || self.rows != rows || self.count.len() != CHEMICAL_COUNT;
        if resize {
            self.cols = cols;
            self.rows = rows;
            self.count = (0..CHEMICAL_COUNT).map(|_| vec![0; n]).collect();
            self.sum_x = (0..CHEMICAL_COUNT).map(|_| vec![0.0; n]).collect();
            self.sum_y = (0..CHEMICAL_COUNT).map(|_| vec![0.0; n]).collect();
        } else {
            for c in &mut self.count {
                c.iter_mut().for_each(|v| *v = 0);
            }
            for c in &mut self.sum_x {
                c.iter_mut().for_each(|v| *v = 0.0);
            }
            for c in &mut self.sum_y {
                c.iter_mut().for_each(|v| *v = 0.0);
            }
        }
        let cols_i = cols as i32;
        let rows_i = rows as i32;
        let np = store.len();
        for i in 0..np {
            let chem = store.chem_id[i] as usize;
            let x = store.x[i];
            let y = store.y[i];
            let mut bx = (x / SENSOR_BIN).floor() as i32;
            let mut by = (y / SENSOR_BIN).floor() as i32;
            if bx < 0 {
                bx = 0;
            } else if bx >= cols_i {
                bx = cols_i - 1;
            }
            if by < 0 {
                by = 0;
            } else if by >= rows_i {
                by = rows_i - 1;
            }
            let bin = (by as usize) * cols + (bx as usize);
            self.count[chem][bin] += 1;
            self.sum_x[chem][bin] += x;
            self.sum_y[chem][bin] += y;
        }
    }

    /// Weighted local-gradient vector for chem `chem_id` at point
    /// `(cx, cy)` over radius `range`. The weight is `range / dsq`
    /// (further bins matter less, scaled by population so a dense
    /// bin pulls more than a sparse one of equal distance). Matches
    /// the TS `chemGradient` formula.
    pub fn gradient(&self, cx: f32, cy: f32, range: f32, chem_id: usize) -> [f32; 2] {
        if chem_id >= CHEMICAL_COUNT || self.count.is_empty() {
            return [0.0, 0.0];
        }
        let cols_i = self.cols as i32;
        let rows_i = self.rows as i32;
        let range_sq = range * range;
        let span = (range / SENSOR_BIN).ceil() as i32;
        let mut cbx = (cx / SENSOR_BIN).floor() as i32;
        let mut cby = (cy / SENSOR_BIN).floor() as i32;
        if cbx < 0 {
            cbx = 0;
        } else if cbx >= cols_i {
            cbx = cols_i - 1;
        }
        if cby < 0 {
            cby = 0;
        } else if cby >= rows_i {
            cby = rows_i - 1;
        }
        let x0 = (cbx - span).max(0);
        let x1 = (cbx + span).min(cols_i - 1);
        let y0 = (cby - span).max(0);
        let y1 = (cby + span).min(rows_i - 1);
        let cnt = &self.count[chem_id];
        let sx = &self.sum_x[chem_id];
        let sy = &self.sum_y[chem_id];
        let mut gx = 0.0_f32;
        let mut gy = 0.0_f32;
        for by in y0..=y1 {
            let row = (by as usize) * self.cols;
            for bx in x0..=x1 {
                let bin = row + bx as usize;
                let n = cnt[bin];
                if n == 0 {
                    continue;
                }
                let nf = n as f32;
                let cx_bin = sx[bin] / nf;
                let cy_bin = sy[bin] / nf;
                let dx = cx_bin - cx;
                let dy = cy_bin - cy;
                let dsq = dx * dx + dy * dy;
                if dsq >= range_sq || dsq < 1.0 {
                    continue;
                }
                let w = range / dsq;
                gx += dx * w * nf;
                gy += dy * w * nf;
            }
        }
        [gx, gy]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::particles::ParticleInit;

    fn store_with_particles(positions: &[(f32, f32, u8)]) -> ParticleStore {
        let mut s = ParticleStore::new();
        for &(x, y, chem_id) in positions {
            s.push(ParticleInit {
                x,
                y,
                chem_id,
                r: 1.0,
                ..ParticleInit::default()
            });
        }
        s
    }

    #[test]
    fn empty_world_zero_gradient() {
        let mut bins = SensorBins::new();
        let store = ParticleStore::new();
        bins.rebuild(&store, 100.0, 100.0);
        assert_eq!(bins.gradient(50.0, 50.0, 80.0, 3), [0.0, 0.0]);
    }

    #[test]
    fn single_particle_points_toward_it() {
        // Particle far to the +x side; gradient at origin should be +x.
        let mut bins = SensorBins::new();
        let store = store_with_particles(&[(200.0, 50.0, 3)]);
        bins.rebuild(&store, 400.0, 100.0);
        let g = bins.gradient(50.0, 50.0, 400.0, 3);
        assert!(g[0] > 0.0, "gradient x should be positive, got {:?}", g);
        assert!(g[1].abs() < 1e-3, "gradient y should be ~0, got {:?}", g);
    }

    #[test]
    fn wrong_chem_no_gradient() {
        let mut bins = SensorBins::new();
        let store = store_with_particles(&[(200.0, 50.0, 7)]);
        bins.rebuild(&store, 400.0, 100.0);
        // Querying for chem 3 -- no particles -- returns zero.
        assert_eq!(bins.gradient(50.0, 50.0, 400.0, 3), [0.0, 0.0]);
    }

    #[test]
    fn out_of_range_particle_ignored() {
        let mut bins = SensorBins::new();
        let store = store_with_particles(&[(2000.0, 50.0, 3)]);
        bins.rebuild(&store, 4000.0, 100.0);
        // Range 100; particle is way past it.
        let g = bins.gradient(50.0, 50.0, 100.0, 3);
        assert_eq!(g, [0.0, 0.0]);
    }

    #[test]
    fn two_particles_average_centroid() {
        // Two particles at +x and -y; gradient should have both
        // components non-zero with the right signs.
        let mut bins = SensorBins::new();
        let store = store_with_particles(&[(200.0, 100.0, 3), (100.0, 20.0, 3)]);
        bins.rebuild(&store, 400.0, 200.0);
        let g = bins.gradient(100.0, 100.0, 400.0, 3);
        assert!(g[0] > 0.0, "x should be +ve toward 200, got {:?}", g);
        assert!(g[1] < 0.0, "y should be -ve toward 20, got {:?}", g);
    }

    #[test]
    fn rebuild_resets_counts_between_ticks() {
        let mut bins = SensorBins::new();
        let store1 = store_with_particles(&[(200.0, 50.0, 3)]);
        bins.rebuild(&store1, 400.0, 100.0);
        let g1 = bins.gradient(50.0, 50.0, 400.0, 3);
        assert!(g1[0] > 0.0);
        // Next tick: empty world. Old data must not leak.
        let store2 = ParticleStore::new();
        bins.rebuild(&store2, 400.0, 100.0);
        assert_eq!(bins.gradient(50.0, 50.0, 400.0, 3), [0.0, 0.0]);
    }
}
