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
    // Bumped: evacuateRocks was adding particle PHYSICAL MASS directly
    // into the ambient MOLES field for non-molecule particles. For any
    // chem with molarMass != 1 (every generic chem) this inflated the
    // amount by a factor of molarMass per evacuation, and combined
    // with precipitate's particle-spawning created an autocatalytic
    // mass source. Generic chems were climbing into the hundreds of
    // millions of moles over a long run. Divide by molar mass on the
    // way in.
    // Bumped: dead SYNTH kinds (BIO/AA/FA/ENZ/CHL/MRNA/PHOTO/MECH/
    // THERMO/MAGNETO/REPAIR/CHEMO) removed from genome.ts;
    // SYNTH_KIND_COUNT 17 -> 5. The modulo applied to genome kind
    // bytes shifts -- every existing SYNTH op in every test/founder
    // genome decodes to a different live kind (CAT/INH/BOND/
    // COMPETENCE/PACKAGE). viableGenome relaxed to just require
    // REPRODUCE + sense + (heterotroph -> THRUST). Founders now use
    // SYNTH CAT for differentiation. makeRandomViableGenome rebuilt
    // around CAT boosts instead of dead SYNTH biosynth ops. Every
    // archetype migrated. Determinism + mass-conservation green.
    // Bumped again: catSynthMask / inhSynthMask converted from packed
    // JS bitmasks to Uint8Array(CATALYST_COUNT). The bitmask form
    // silently aliased high slots into low ones (JS 1<<k uses low 5
    // bits of k -- slot 37 collided with slot 5, and the consumer
    // loop fired 8 phantom syntheses per expressed slot). Fixing it
    // removes the phantom AA/MIN/ATP drain.
    // Bumped again: founder spawn now seeds 0.5 of each receptor
    // (photo/mech/thermo/magneto). The post-fix catalyst tax was
    // bankrupting sense-dependent archetypes before they could grow
    // receptors from substrate; the chicken-and-egg (need photoreceptor
    // to sense light to migrate to light to photosynth) had no entry
    // point with zero starting receptors.
    // Bumped again: founder glucose 10 -> 50 and adp 5 -> 30. The
    // smaller starter funded ~5-15 ATP of work, not enough for
    // sense-archetypes to run the sense->thrust->migrate->photosynth
    // loop before ATP exhaustion (thermophile-gradient cells reached
    // the isotherm but died there; phototaxis-gradient survived
    // only after a population bottleneck). Larger ADP pool means
    // the founder can hold more ATP at a time; larger glucose pool
    // means it can keep respiring for longer before relying on
    // photosynthate or external sugar.
    // Bumped again: founder reserves grown a second step (glucose
    // 50 -> 100, adp 30 -> 60) to widen the migration bootstrap
    // window further; sense-archetypes still lost most of their
    // founders before reaching the lit zone at glu=50/adp=30.
    // Bumped again: CHEM_GLUCOSE membrane permeability 0.6 -> 0.05.
    // The old value let glucose passively diffuse symmetrically
    // across both outer and vacuolar membranes, so an engulfed
    // chloroplast's gift to its host immediately leaked to ambient
    // and any free cell could free-ride -- the public-goods failure
    // that broke chloro-symbiosis + chloro-engulfed. 0.05 makes
    // glucose mostly internal (mirroring ATP's perm=0 + ANT
    // translocase asymmetry) while still permitting slow equilibration.
    // Bumped again: 0.05 -> 0. The "soft asymmetry" wasn't enough --
    // even 12x slower diffusion still let hosts overshoot their
    // food base and the resulting carrying-capacity crash flushed
    // the engulfed chloros to the free pool. Biologically faithful:
    // pure-lipid-bilayer glucose permeability is ~10^-7 cm/s vs
    // O2/CO2 ~10^-1, so 0 (i.e. transport-only via EXCRETE/INGEST)
    // matches the literature -- glucose doesn't passively cross
    // membranes, it moves via dedicated transporters (which the
    // substrate models as EXCRETE for active export and INGEST for
    // particle uptake).
    // Bumped for gene framing: founders are now laid out as
    // intron-gene-intron-...-gene-intron (each functional token wrapped
    // in a GENE..END span, separated by random 0-20b introns), the VM
    // only executes inside genes and clears the stack at each gene
    // boundary, the instr budget rose 8 -> 16, and the genome
    // replication tax fell 0.02 -> 0.01/byte. All of that changes the
    // seeded run's trajectory, so the fingerprint moves.
    // Bumped again: founder immigration switched from "rare rescue
    // below a floor, one at a time, every 15s" to "active top-up of
    // 20% of the remaining deficit toward founderTarget every 7.5s,
    // no particle cap". More founders spawn within the seeded window,
    // moving the fingerprint.
    // Bumped again: founder-foothold seed changes -- FOUNDER_SEED_ATP
    // 40 -> 80, starter mrna 5 -> 8, chlorophyll/enzyme 0.5 -> 1.0, and
    // a buoyant O2=8 seed -- shift the seeded run's trajectory.
    // Bumped again: VM instr budget reverted 16 -> 8.
    // Bumped again: founders no longer scoop / draw-reserve chems denser
    // than FOUNDER_SCOOP_MAX_DENSITY (buoyancy), changing seed composition.
    // Bumped again: founder seed glucose 100 -> 50 (buoyancy).
    // Bumped again: INGEST + founder scoop now use the particle bucket
    // grid (forParticlesNear); the bin/order scan eats a different
    // particle when several are in range, shifting the trajectory.
    // Bumped again: the vent is now an always-on heat source (persistent
    // base intensity + eruption spikes) and runs hotter, so the regional
    // temperature field is warm near the vent from t=0 instead of cold
    // until the first eruption -- Q10 metabolism + dissolution capacity
    // near the floor shift from tick 0. Intended behavior change;
    // determinism + mass-conservation re-verified green.
    // Bumped again: the vent now seeps a bounded standing pool of reduced
    // generic fuel + a marker0 beacon near the mouth from t=0 (the
    // chemolithoautotroph niche), adding particles the seeded run didn't
    // have. Intended; determinism + mass-conservation green.
    // Bumped again: founders now splice 2-5 archetype-derived genes and
    // use a wider per-founder intron budget (larger, more varied founder
    // genomes), so the seeded run's founder lineages differ. Intended.
    const GOLDEN = "ad67ef90";
    expect(fp).toBe(GOLDEN);
  }, 20_000);
});
