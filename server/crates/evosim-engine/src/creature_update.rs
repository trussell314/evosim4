//! Per-tick creature update, the minimal slice. Runs the VM
//! interpreter against each cell, then applies the subset of
//! `VmOutputs` we can act on today:
//!
//!   - `thrust_x / thrust_y` -> velocity (acceleration over `dt`)
//!   - `turn` -> heading (then heading is re-projected onto velocity
//!     so a cell that turns ends up facing a new direction)
//!   - `cat_synth_list` entries -> bump the cell's catalyst pool
//!     for those slots (small per-tick increment for now; the real
//!     biosynth pass spends ATP and pulls aa+min, which lands with
//!     the reaction-driver port)
//!   - position update from velocity
//!
//! Outputs not yet acted on (kept honest; documented for the next
//! commit that hooks them up): excrete, transport, reproduce,
//! predate, engulf, splice, partition, emit, inh_synth_list, bond
//! marker. These still get written into `VmOutputs` so the
//! interpreter behaviour is unchanged; they're just not consumed.
//!
//! Sensors are built per-cell as a stack struct that holds a
//! reference to the cell's chem pool. The gradient callback returns
//! `[0, 0]` until the particle grid is consulted -- a real local
//! gradient over the particle field lands with the spatial-bins port.

use crate::cell_reactions::{biosynth_catalyst, biosynth_inhibitor, run_cell_reactions};
use crate::creatures::CreatureStore;
use crate::sensor_bins::SensorBins;
use crate::vm::{run_tick, Sensors, VmSelf};

/// Per-tick instruction budget per cell. Matches the TS default.
pub const VM_INSTRUCTION_BUDGET: u32 = 64;

// Catalyst pool growth used to be a flat linear bump; now we call
// the real biosynth_catalyst / biosynth_inhibitor pass that consumes
// AA + MIN + ATP per unit grown.

/// Sensors implementation that closes over a single cell's chem pool
/// plus the world-level spatial sensor bins. SENSE_CHEMICAL reads the
/// cell's pool; SENSE_OUT queries the bins for a particle-field
/// gradient at the cell's position over `sense_range`.
struct CellSensors<'a> {
    chems: &'a [&'a Vec<f32>],
    cell: usize,
    bins: &'a SensorBins,
    cx: f32,
    cy: f32,
    sense_range: f32,
}

impl Sensors for CellSensors<'_> {
    fn chem_conc(&self, chem_id: usize) -> f64 {
        self.chems
            .get(chem_id)
            .map(|col| col[self.cell] as f64)
            .unwrap_or(0.0)
    }

    fn gradient(&self, chem_id: usize) -> [f64; 2] {
        let g = self.bins.gradient(self.cx, self.cy, self.sense_range, chem_id);
        [g[0] as f64, g[1] as f64]
    }
}

/// Velocity damping per tick. Without a creature drag model the
/// thrust accumulators would run away; this is a placeholder until
/// the real drag pass lands. Matches the rough scale of the TS
/// per-tick velocity decay (`(1 - dt * drag)` with drag ~= 0.3).
const CREATURE_DRAG_PER_S: f32 = 0.3;

/// World context the per-tick pass reads. We pull the few scalars out
/// rather than borrowing the whole World so the caller can keep its
/// `&mut World` borrow on `creature_store` without juggling unsafe.
#[derive(Debug, Clone, Copy)]
pub struct UpdateCtx {
    pub t: f64,
    pub width: f32,
    pub height: f32,
    /// Local ambient light, 0..1. The TS engine reads this off the
    /// region/atmosphere field; until those land we pass a flat
    /// scalar. Photosynth gates on it being > 0.
    pub ambient_light: f32,
}

// (Per-cell sense range now lives on CreatureStore.sense_range,
// computed from SENSE_AMP count at push and refreshed when the
// genome mutates. Old DEFAULT_SENSE_RANGE retired.)

/// Run the per-tick VM pass over every creature in `store`. `bins`
/// is the spatial sensor grid the SENSE_OUT op queries.
pub fn update_creatures(
    ctx: UpdateCtx,
    store: &mut CreatureStore,
    bins: &SensorBins,
    dt: f32,
) {
    let n = store.n;
    if n == 0 {
        return;
    }
    let t = ctx.t;
    let dt64 = dt as f64;

    for i in 0..n {
        let me = VmSelf {
            energy: store.energy(i) as f64,
            mass: store.total_mass(i) as f64,
            membrane: store.chems[crate::chem_ids::CHEM_MEMBRANE][i] as f64,
        };
        // Sensor borrow is scoped to the VM call; the reaction
        // kernel below needs &mut store and the two borrows would
        // otherwise collide.
        let chem_refs: Vec<&Vec<f32>> = store.chems.iter().collect();
        let cx = store.x[i];
        let cy = store.y[i];
        let sensors = CellSensors {
            chems: &chem_refs,
            cell: i,
            bins,
            cx,
            cy,
            sense_range: store.sense_range[i],
        };

        // SAFETY-free: we split the &mut store into the disjoint
        // pieces the interpreter needs (genome bytes, vm state, vm
        // out) using std::mem::take / replace patterns would let us
        // avoid the index-borrow back-and-forth, but for the
        // initial port the straightforward swap-out / call / swap-in
        // sequence keeps the code obvious and the perf
        // good-enough.
        let mut state = std::mem::take(&mut store.vm_state[i]);
        let mut out = std::mem::take(&mut store.vm_out[i]);
        let mut genome = std::mem::take(&mut store.genome[i]);

        run_tick(
            &mut genome,
            &mut state,
            &sensors,
            &me,
            VM_INSTRUCTION_BUDGET,
            &mut out,
            None,
        );

        // ----- Apply outputs.
        store.vx[i] += out.thrust_x as f32 * dt;
        store.vy[i] += out.thrust_y as f32 * dt;
        store.heading[i] += out.turn as f32 * dt;

        // Track REPRODUCE intent (sterile-cull signal); the actual
        // fission pass lands later.
        if out.reproduce {
            store.last_reproduce_fire_t[i] = t;
        }

        // Snapshot the expressed slot lists before we swap out vm_out
        // -- biosynth_* mutate store.chems and store.catalyst, which
        // would alias the &mut vm_out borrow we'd otherwise hold.
        let cat_slots: Vec<usize> = (0..out.cat_synth_count)
            .map(|k| out.cat_synth_list[k] as usize)
            .collect();
        let inh_slots: Vec<usize> = (0..out.inh_synth_count)
            .map(|k| out.inh_synth_list[k] as usize)
            .collect();

        // If the VM just mutated the genome (POKE / SPLICE) the
        // SENSE_AMP byte count may have changed; recompute. Cheap
        // (linear scan over the genome) and only fires when needed.
        if out.poke_fired || out.splice_mode != 0 {
            store.sense_range[i] = crate::genome::compute_sense_range(&genome);
        }

        // Restore the swapped-out fields.
        store.vm_state[i] = state;
        store.vm_out[i] = out;
        store.genome[i] = genome;

        // Biosynth: real substrate-consuming, ATP-paying, mRNA-gated
        // growth of the catalyst / inhibitor pools.
        for slot in cat_slots {
            biosynth_catalyst(store, slot, i, dt);
        }
        for slot in inh_slots {
            biosynth_inhibitor(store, slot, i, dt);
        }

        // Reaction kinetics: walk every catalyst-bearing reaction
        // slot and fire substrates -> products under MM saturation.
        // Runs AFTER the VM so any catalyst the cell just expressed
        // gets its growth-tick the next frame, matching TS order.
        run_cell_reactions(store, i, dt, ctx.ambient_light);

        // ----- Movement integrator. Damp then advect.
        let damp = 1.0 - (CREATURE_DRAG_PER_S * dt).min(1.0);
        store.vx[i] *= damp;
        store.vy[i] *= damp;
        store.x[i] += store.vx[i] * dt;
        store.y[i] += store.vy[i] * dt;

        // World horizontal wrap so a cell that drifts off the side
        // reappears on the other -- the world is conceptually a
        // cylinder along x. Vertically we CLAMP instead: a cell that
        // would sink below the seafloor (or float above the air-water
        // boundary) is held at the boundary with its inward velocity
        // killed. Wrapping y, as the prior pass did, sent cells that
        // fell through rock all the way back to the top of the world,
        // which is the bug that surfaced in the live demo.
        let w = ctx.width;
        let h = ctx.height;
        let r = store.r[i];
        if store.x[i] < 0.0 {
            store.x[i] += w;
        } else if store.x[i] >= w {
            store.x[i] -= w;
        }
        if store.y[i] < r {
            store.y[i] = r;
            if store.vy[i] < 0.0 {
                store.vy[i] = 0.0;
            }
        } else if store.y[i] > h - r {
            store.y[i] = h - r;
            if store.vy[i] > 0.0 {
                store.vy[i] = 0.0;
            }
        }

        // Age the cell by the tick. Pure bookkeeping.
        let _ = dt64;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chem_ids::CHEM_ATP;
    use crate::creatures::CreatureInit;
    use crate::genome::*;

    fn one_cell_world() -> (UpdateCtx, CreatureStore) {
        let ctx = UpdateCtx { t: 0.0, width: 1600.0, height: 1200.0, ambient_light: 0.5 };
        let store = CreatureStore::new();
        (ctx, store)
    }

    #[test]
    fn empty_store_is_noop() {
        let (ctx, mut store) = one_cell_world();
        update_creatures(ctx, &mut store, &SensorBins::new(), 1.0 / 60.0);
        assert_eq!(store.len(), 0);
    }

    /// Common-sense invariant: a cell pushed downward at any speed
    /// must NEVER tunnel through the seafloor and reappear at the top
    /// of the world. The previous wrap-y logic did exactly that and
    /// surfaced as "cells fall through rock and wrap around" in the
    /// live demo.
    #[test]
    fn cell_does_not_wrap_through_floor() {
        let (ctx, mut store) = one_cell_world();
        store.push(CreatureInit {
            x: 800.0,
            y: ctx.height - 5.0, // already at the floor
            r: 8.0,
            vy: 5000.0, // hard downward kick
            ..CreatureInit::default()
        });
        update_creatures(ctx, &mut store, &SensorBins::new(), 1.0 / 60.0);
        // The cell must be clamped at the floor minus its radius, not
        // wrap to a Y near zero.
        let y_after = store.y[0];
        assert!(
            y_after > ctx.height * 0.5,
            "cell with downward kick should stay near floor, got y={}",
            y_after
        );
        // The clamp also kills inward velocity so the next tick
        // doesn't accumulate energy at the wall.
        assert!(store.vy[0] <= 0.0, "vy at floor should be <= 0");
    }

    /// Mirror of the above: a cell flung upward stops at the top of
    /// the world (above the surface_y line if it's high enough). It
    /// must not tunnel up and reappear at the bottom.
    #[test]
    fn cell_does_not_wrap_through_ceiling() {
        let (ctx, mut store) = one_cell_world();
        store.push(CreatureInit {
            x: 800.0,
            y: 5.0,
            r: 8.0,
            vy: -5000.0,
            ..CreatureInit::default()
        });
        update_creatures(ctx, &mut store, &SensorBins::new(), 1.0 / 60.0);
        let y_after = store.y[0];
        assert!(y_after < ctx.height * 0.5, "got y={}", y_after);
        assert!(store.vy[0] >= 0.0, "vy at ceiling should be >= 0");
    }

    /// Horizontal wrap-around is still desired (the world is a
    /// cylinder along x). A cell pushed off the right edge must
    /// reappear on the left.
    #[test]
    fn cell_wraps_horizontally() {
        let (ctx, mut store) = one_cell_world();
        store.push(CreatureInit {
            x: ctx.width - 1.0,
            y: 600.0,
            r: 8.0,
            vx: 1000.0,
            ..CreatureInit::default()
        });
        update_creatures(ctx, &mut store, &SensorBins::new(), 1.0 / 60.0);
        assert!(
            store.x[0] < ctx.width * 0.5,
            "expected wrap to left, got x={}",
            store.x[0]
        );
    }

    #[test]
    fn thrust_op_moves_the_cell() {
        let (ctx, mut store) = one_cell_world();
        let mut chems = vec![0.0; crate::chem_ids::NAMED_CHEMICAL_COUNT];
        chems[CHEM_ATP] = 100.0;
        // GENE PUSH8 0 PUSH8 8 THRUST END   (ax=0, ay=8)
        let genome = vec![OP_GENE, OP_PUSH8, 0, OP_PUSH8, 8, OP_THRUST, OP_END];
        store.push(CreatureInit {
            x: 800.0,
            y: 600.0,
            r: 8.0,
            genome,
            chems: Some(chems),
            ..CreatureInit::default()
        });
        let y0 = store.y[0];
        for _ in 0..30 {
            update_creatures(ctx, &mut store, &SensorBins::new(), 1.0 / 60.0);
        }
        assert!(
            store.y[0] - y0 > 0.05,
            "cell should drift downward under +y thrust (got {} -> {})",
            y0,
            store.y[0]
        );
    }

    #[test]
    fn synth_cat_grows_catalyst_pool() {
        let (ctx, mut store) = one_cell_world();
        let mut chems = vec![0.0; crate::chem_ids::NAMED_CHEMICAL_COUNT];
        // Biosynth needs substrate (aa + min), mRNA, and ATP above
        // the BIOSYNTH_ATP_FLOOR to fire.
        chems[crate::chem_ids::CHEM_AA] = 50.0;
        chems[crate::chem_ids::CHEM_MIN] = 50.0;
        chems[crate::chem_ids::CHEM_MRNA] = 5.0;
        chems[crate::chem_ids::CHEM_ATP] = 50.0;
        chems[crate::chem_ids::CHEM_ADP] = 10.0;
        // GENE SYNTH CAT 3 END  -- expresses catalyst slot 3.
        let genome = vec![OP_GENE, OP_SYNTH, SYNTH_KIND_CAT, 3, OP_END];
        store.push(CreatureInit {
            genome,
            chems: Some(chems),
            ..CreatureInit::default()
        });
        assert_eq!(store.catalyst[3][0], 0.0);
        for _ in 0..120 {
            update_creatures(ctx, &mut store, &SensorBins::new(), 1.0 / 60.0);
        }
        assert!(
            store.catalyst[3][0] > 0.1,
            "catalyst slot 3 should have grown (got {})",
            store.catalyst[3][0]
        );
        // Other slots stay at 0.
        assert_eq!(store.catalyst[4][0], 0.0);
    }

    #[test]
    fn gene_less_genome_does_not_move() {
        let (ctx, mut store) = one_cell_world();
        let chems = vec![0.0; crate::chem_ids::NAMED_CHEMICAL_COUNT];
        store.push(CreatureInit {
            x: 800.0,
            y: 600.0,
            r: 8.0,
            genome: vec![OP_NOP, OP_NOP], // no GENE codon
            chems: Some(chems),
            ..CreatureInit::default()
        });
        for _ in 0..30 {
            update_creatures(ctx, &mut store, &SensorBins::new(), 1.0 / 60.0);
        }
        assert_eq!(store.x[0], 800.0);
        assert_eq!(store.y[0], 600.0);
    }

    #[test]
    fn sense_out_drives_seeker_toward_particle() {
        use crate::particles::{ParticleInit, ParticleStore};
        let (ctx, mut store) = one_cell_world();
        let chems = vec![0.0; crate::chem_ids::NAMED_CHEMICAL_COUNT];
        // GENE SENSE_OUT 3 THRUST END
        //   SENSE_OUT 3 pushes (gx, gy)
        //   THRUST pops ay (gy), ax (gx)
        // -> swims up the chem-3 gradient.
        let genome = vec![OP_GENE, OP_SENSE_OUT, 3, OP_THRUST, OP_END];
        store.push(CreatureInit {
            x: 100.0,
            y: 100.0,
            r: 8.0,
            genome,
            chems: Some(chems),
            ..CreatureInit::default()
        });
        // Bait pile 50px to the right -- inside the SENSE_BASE
        // (80) range so a genome with zero SENSE_AMP can still
        // detect the gradient.
        let mut particles = ParticleStore::new();
        for _ in 0..20 {
            particles.push(ParticleInit {
                x: 150.0,
                y: 100.0,
                chem_id: 3,
                r: 1.0,
                ..ParticleInit::default()
            });
        }
        let mut bins = SensorBins::new();
        bins.rebuild(&particles, ctx.width, ctx.height);
        let x0 = store.x[0];
        for _ in 0..30 {
            update_creatures(ctx, &mut store, &bins, 1.0 / 60.0);
        }
        assert!(
            store.x[0] > x0 + 0.2,
            "cell should swim +x toward the bait, got {} -> {}",
            x0,
            store.x[0]
        );
    }

    #[test]
    fn reproduce_op_stamps_fire_t() {
        let (mut ctx, mut store) = one_cell_world();
        let mut chems = vec![0.0; crate::chem_ids::NAMED_CHEMICAL_COUNT];
        chems[CHEM_ATP] = 10.0;
        // GENE PUSH8 5 REPRODUCE END   (5 -> fraction 0.5 default)
        let genome = vec![OP_GENE, OP_PUSH8, 5, OP_REPRODUCE, OP_END];
        store.push(CreatureInit {
            genome,
            chems: Some(chems),
            ..CreatureInit::default()
        });
        ctx.t = 7.5;
        update_creatures(ctx, &mut store, &SensorBins::new(), 1.0 / 60.0);
        assert_eq!(store.last_reproduce_fire_t[0], 7.5);
    }
}
