import { describe, it, expect } from "vitest";
import { createWorld, step, type World } from "../sim";

// Golden behavior fingerprint. The determinism test only proves two
// runs in the SAME build agree; it cannot catch a refactor that
// changes behavior consistently. This pins a hash of full world state
// after a fixed seeded run, so ANY behavior drift from the modular
// decomposition (CLAUDE.md: behavior-preserving) fails CI immediately.
//
// If a change is *intended* to alter simulation behavior, recompute and
// update GOLDEN deliberately in the same commit -- never reflexively.

const SEED = 0x1234abcd;
const TICKS = 60 * 4;

// Quantize to 1e-6 so a refactor that re-associates mathematically
// equivalent float expressions doesn't trip it, while any real
// behavior change (different path, count, ordering) still does.
function q(v: number): number {
  return Math.round(v * 1e6);
}

function fingerprint(w: World): string {
  let h = 0x811c9dc5 >>> 0;
  const mix = (n: number): void => {
    h ^= n | 0;
    h = Math.imul(h, 0x01000193);
    h >>>= 0;
  };
  mix(q(w.t));
  mix(w.creatures.length);
  mix(w.particles.length);
  for (const c of w.creatures) {
    mix(q(c.energy));
    mix(q(c.x));
    mix(q(c.y));
    mix(q(c.r));
    mix(c.genome.length);
    for (let i = 0; i < c.genome.length; i++) mix(c.genome[i]);
    for (const k of Object.keys(c.molecules).sort()) {
      mix(q((c.molecules as unknown as Record<string, number>)[k]));
    }
  }
  const store = w.particleStore;
  for (let i = 0; i < w.particles.length; i++) {
    mix(store.chemId[i]);
    mix(q(store.x[i]));
    mix(q(store.y[i]));
    mix(q(store.r[i]));
  }
  for (let i = 0; i < w.ambient.length; i++) mix(q(w.ambient[i]));
  for (let i = 0; i < w.reserve.length; i++) mix(q(w.reserve[i]));
  return (h >>> 0).toString(16).padStart(8, "0");
}

describe("golden: seeded run produces a pinned state fingerprint", () => {
  it("matches the committed GOLDEN hash", () => {
    const w = createWorld(800, 600, { seed: SEED });
    for (let i = 0; i < TICKS; i++) step(w, 1 / 60);
    const fp = fingerprint(w);
    // Recompute & update only when a behavior change is intended.
    // Bumped: PARTITION op (0x68) is now a reachable opcode, so random
    // genomes that previously NOP'd on that byte now register an
    // asymmetric-division bias -- an intended behavior change.
    // Bumped again: SYNTH_KIND.COMPETENCE added (SYNTH_KIND_COUNT
    // 14 -> 15 shifts the kindByte modulo) and competent cells now
    // take up eDNA fragments -- both intended behavior changes.
    // Bumped again: SYNTH_KIND.PACKAGE added (SYNTH_KIND_COUNT
    // 15 -> 16) and cells expressing it now actively shed self
    // fragments -- both intended behavior changes.
    // Bumped again: synth_aa reaction vmax 0.4 -> 1.2 (reactions.ts
    // out[4]) so a pure photoautotroph can close its own amino-acid
    // budget from photosynthate + minerals (biological realism --
    // de-novo aa synthesis is not a growth bottleneck in real
    // primary producers). Global, intended behavior change;
    // determinism + mass-conservation re-verified green.
    // Bumped again: photosynth reaction vmax 1.2 -> 5.0 (reactions.ts
    // out[3]), derived from the glu mass balance (sink sum ~2.69 /
    // 0.5 glu-per-unit ~= 5.4) -- carbon fixation was the binding
    // constraint once synth_aa was relieved (mGLU pinned ~0 in every
    // autotroph run). Global, intended; determinism + mass green.
    // Bumped again: Path 1 -- ATP is now a first-class chemical
    // (CHEM_ATP, named id 45; `energy` aliases the m_atp column).
    // NAMED_CHEMICAL_COUNT 45->46, GENERIC 51->50 so one fewer
    // procedural generic chemical is rolled by the seeded chem-table
    // build -> generic chem properties shift (intended). genome ABI
    // unchanged (CHEMICAL_COUNT stays 96); determinism byte-identical
    // + mass-conservation re-verified green; SAVE_SCHEMA bumped.
    // Bumped (Phase 2b, op redesign): INGEST is now a zero-operand
    // bond-energy-threshold engulf (pops a stack value) instead of a
    // 6-bin material mask. Op arity + VM_OUT shape + every archetype's
    // INGEST encoding changed -> seeded run diverges (intended). The
    // sensor-bin gate + biopolymer generic-catch fallback are gone;
    // selectivity is now an evolvable scalar. SAVE_SCHEMA 13->14.
    // (prev) Bumped (Phase 2a-i, op redesign): added the TRANSPORT opcode
    // (0x56). OP_BYTES auto-derives from Object.values(OP), so a new
    // opcode shifts randMutByte's op/noop draw distribution -> every
    // seeded lineage's mutated bytes change (intended, the whole
    // point of the new op being reachable by mutation). genome ABI
    // grows by one op + a VM_OUT.transport field; CHEMICAL_COUNT
    // unchanged. Determinism (same-seed-identical) still green;
    // mass-conservation green; SAVE_SCHEMA bumped 11->12.
    // Bumped (Phase 5 cleanup): the 4 chemoreceptor-synth bootstrap
    // reactions (slots 15-18) inertized (rate set to 0) -- the chems
    // they produced were inputs to the retired chemo activation
    // branch, so making them was pure waste of AA+MIN every tick.
    // Slot indices kept stable; uncatRate now 0; named labels
    // preserved for disasm/inspector clarity.
    // (prev) Bumped (Phase 5, op redesign): chemo activation branch retired
    // (CHEMO receptor + activated-chemo signal chems no longer
    // written by runActivation; SYNTH CHEMO is a no-op kept for
    // SYNTH_KIND_COUNT stability). Archetypes' SYNTH CHEMO +
    // SENSE_CHEMICAL CHEM_ACT_CHEMO_*_X/Y patterns migrated to a
    // direct SENSE_OUT <CHEM_BIOPOLYMER> particle-gradient read
    // (via the new climbParticleGradient helper). SAVE_SCHEMA
    // 17->18; mass-conservation green.
    // (prev) Bumped (Phase 4a, op redesign): the synthMask enable-gate path
    // is retired. Named bootstrap reactions ran only when the genome
    // had set the corresponding SYNTH_BIT_* via a SYNTH op; now they
    // run unconditionally on their existing uncatRate floor. Every
    // cell metabolizes at baseline; named SYNTH biomass/receptor ops
    // become no-ops (their synthMask bits are no longer consulted
    // by the reaction loop). Intended behavior change; SAVE_SCHEMA
    // 15->16; mass-conservation green.
    // Bumped: hand-authored static terrain (4 rock polygons) + a
    // hydrothermal vent now ship with every fresh world. The new
    // obstacles change the seeded layout (founder spawn rejects rock
    // overlap, particles bounce off rock) and the vent's eruption
    // schedule consumes RNG draws -- both shift the fingerprint
    // deterministically. Determinism + mass-conservation still green.
    // Bumped: evacuator now requires a polygon-inside hit (not just
    // a bitmap-flagged border cell) before dissolving a particle.
    // The over-aggressive ~12 px death halo around rock is gone --
    // particles settle ON rock surfaces instead of vanishing on
    // approach. Mass-conservation + determinism still green.
    // Bumped: dropped the redundant after-applyWalls evacuator call.
    // One end-of-tick pass is enough now that the evacuator is
    // polygon-gated and rare. The skipped intra-tick pass shifts a
    // few particles' lifetime by 1 tick; deterministic, mass-conserving.
    // Bumped: topSpawnPos no longer retries 32x against the heightmap;
    // a single uniform-x roll either spawns or skips. The previous
    // retry loop biased the long-run x distribution toward whichever
    // clear columns won the retry race; the single-roll form is
    // uniform across all clear columns (rocky columns just generate
    // no spawn on that call -- the next call gets a fresh sample).
    // Bumped: brownian decay constant 200 -> 400. Deep-water sediment
    // now drifts visibly instead of looking glued to the rock; mid-
    // water mixing also up a little. Determinism + mass-conservation
    // still green.
    // Bumped: regional temperature is now a state-bearing field
    // (diffuse between neighbouring regions + slow relax toward the
    // analytical baseline + vent source term) instead of a per-tick
    // resample of the analytical function. Q10 + THERMO reads route
    // through the regional cache, so they sample at region centres
    // rather than the creature's exact x,y -- with the patch wave
    // active that shifts rates by a small per-tick amount. Vent's
    // contribution also moved out of temperatureAt and into the
    // stepper as a source. Deterministic, mass-OK.
    // Bumped: tempPatchAmp default 3 -> 0. The patch sine wave was a
    // hangover from the pre-rework wave coupling -- the analytical
    // term still showed up on the temperature overlay as wavy stripes
    // unrelated to anything physical. Zeroed by default.
    const GOLDEN = "8245be01";
    expect(fp).toBe(GOLDEN);
  }, 20_000);
});
