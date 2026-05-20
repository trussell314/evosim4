// Per-archetype "perfect scenario" probe. Founder spawns OFF; the
// world is hand-seeded with the resources/biota that maximally favour
// ONE archetype, which is then run 10 sim-min. Reports only measured
// numbers (population trajectory, mean body state, births, the
// tracked death-cause counters, ambient levels). No causal claims.
//
//   npx tsx scripts/scenario.ts <archetypeId> [observeMin]
//
// Throwaway probe.

import {
  createWorld,
  step,
  spawnSpeciesInstance,
  type World,
} from "../src/sim";
import { ARCHETYPES } from "../src/genome-archetypes";
import { asm, type Instr } from "../src/genome-asm";
import { pushParticle } from "../src/sim/core";
import { genomeSynthMask } from "../src/genome";
import { REACTIONS } from "../src/sim/reactions";
import { CHEM_BOND_POTENTIAL } from "../src/sim/chemistry";
import {
  CHEM_CO2,
  CHEM_ADP,
  CHEM_GLU,
  CHEM_CHL,
  CHEM_MEMBRANE,
  CHEM_MIN,
  CHEM_AA,
  CHEM_O2,
  CHEM_ATP,
  CHEM_BIOPOLYMER,
  NAMED_CHEMICAL_COUNT,
  CHEM_ACT_PHOTO_VISIBLE,
  CHEM_ACT_THERMO,
} from "../src/sim/chem-ids";

// === Phase 1: abiotic energy landscape =============================
// Scan the import-time-fixed, seeded generic reaction table for the
// strongest catalyst-gated exergonic reaction whose substrates are
// all either GENERIC (a discoverable chem the vent can emit) or
// ambient inorganics (O2/CO2/MIN). Nothing is hand-tuned: the
// engine's own seeded chemistry picks the slot, its fuel cocktail,
// and the yield. The energetic pathways need SEVERAL generic
// substrates at once -- so a realistic abiotic source is a
// multi-component "vent fluid", not one chem. This proves the
// substrate ALREADY expresses chemolithotrophy once the world emits
// such a fluid; the cell only evolves `SYNTH CAT <slot>`.
const AMBIENT_INORGANIC = new Set([CHEM_O2, CHEM_CO2, CHEM_MIN, CHEM_AA]);
// substrate is acquirable if it's a generic (the vent can emit it /
// it rides the biopolymer INGEST gate) or an ambient inorganic.
function acquirable(c: number): boolean {
  return c >= NAMED_CHEMICAL_COUNT || AMBIENT_INORGANIC.has(c);
}
function genericSubs(slot: number): number[] {
  return [...REACTIONS[slot].sChem].filter((c) => c >= NAMED_CHEMICAL_COUNT);
}
// Energy module: strongest (atpDelta*vmax) exergonic catalyst-gated
// reaction with all-acquirable substrates and >=1 generic fuel.
function pickEnergySlot(): number {
  let best = -1, bestScore = 0;
  for (let k = 0; k < REACTIONS.length; k++) {
    const r = REACTIONS[k];
    if (r.uncatRate !== 0 || r.atpDelta <= 0 || r.lightIn !== 0) continue;
    if (r.sChem.length === 0 || ![...r.sChem].every(acquirable)) continue;
    if (genericSubs(k).length === 0) continue;
    const score = r.atpDelta * r.vmax;
    if (score > bestScore) { bestScore = score; best = k; }
  }
  if (best < 0) throw new Error("no acquirable exergonic energy reaction");
  return best;
}
// Carbon-fixation module: a catalyst-gated reaction that PRODUCES the
// heterotroph carbon staple (GLU) from acquirable inputs -- the cell
// pays for it with the energy module's ATP. Prefer the cheapest
// (least endergonic) and fastest.
function pickCarbonSlot(): number {
  let best = -1, bestScore = -Infinity;
  for (let k = 0; k < REACTIONS.length; k++) {
    const r = REACTIONS[k];
    if (r.uncatRate !== 0 || r.lightIn !== 0) continue;
    if (![...r.pChem].includes(CHEM_GLU)) continue;
    if (r.sChem.length === 0 || ![...r.sChem].every(acquirable)) continue;
    const score = -r.atpDelta + r.vmax; // cheap (low ATP cost) + fast
    if (score > bestScore) { bestScore = score; best = k; }
  }
  if (best < 0) throw new Error("no acquirable GLU-producing reaction");
  return best;
}
const VENT = (() => {
  const energy = pickEnergySlot();
  const carbon = pickCarbonSlot();
  const fuels = [...new Set([...genericSubs(energy), ...genericSubs(carbon)])];
  return {
    energy, carbon, fuels,
    atp: REACTIONS[energy].atpDelta, vmax: REACTIONS[energy].vmax,
    cAtp: REACTIONS[carbon].atpDelta,
  };
})();

// Premise-proof focal genome: the heterotroph viability kit PLUS one
// evolved-style catalyst for the abiotic-fuel reaction, eating the
// vent fuel as particles (generic chems ride the biopolymer INGEST
// gate). NOT a shipped archetype -- a scenario probe demonstrating
// the substrate already expresses chemolithotrophy.
const ventProbeGenome = asm([
  ["SYNTH", "CAT", 7],  // boost synth_enz (formerly SYNTH ENZ)
  ["SYNTH", "CAT", 10], // boost biopolymer digestion (heterotroph kit)
  ["SYNTH", "CAT", 9],  // boost synth_membrane(aa+fa)
  ["SYNTH", "CAT", VENT.energy], // abiotic-fuel -> ATP (energy module)
  ["SYNTH", "CAT", VENT.carbon], // acquirable -> GLU (carbon-fix module)
  ["PUSH8", 1], ["INGEST"], // low bond-energy threshold: eats the vent cocktail
  ["SELF_MEMBRANE"],
  ["PUSH8", 30],
  ["GT"],
  ["JZ", "np"],
  ["REPRODUCE"],
  ["LABEL", "np"],
] as Instr[]);

// Bounded, accounted abiotic source: a sea-floor seep refilled to a
// fixed standing count (a chemostat -> the influx is bounded, never
// runaway). Mirrors topUpBiopolymer but emits the vent fuel at the
// floor band.
function ventEmit(w: World, fuels: number[], target: number): void {
  const ww = w as unknown as {
    particles: { chemId: number }[];
    width: number; height: number; depth: number;
  };
  const fuelSet = new Set(fuels);
  let have = 0;
  for (const p of ww.particles) if (fuelSet.has(p.chemId)) have++;
  let need = target - have;
  let rot = have;
  while (need-- > 0) {
    const r = 1 + Math.random() * 1.2;
    pushParticle(w, {
      x: Math.random() * ww.width,
      y: ww.height * 0.88 + Math.random() * (ww.height * 0.1),
      z: r + Math.random() * (ww.depth - 2 * r),
      vx: 0, vy: 0, vz: 0,
      r,
      chemId: fuels[rot++ % fuels.length], // even cocktail mix
    });
  }
}

// Ad-hoc genome: the `forager` archetype with its reproduce gate set
// to an arbitrary threshold (the catalogue forager is fixed at 30).
// Reconstructed here, not exported from genome-archetypes, because
// this is a throwaway probe. ING_BIOPOLYMER = 1 (module-local const
// in genome-archetypes). Correctness is GUARANTEED by the byte-equal
// assertion below: foragerProg(30) must asm() to the exact bytes of
// the real forager, so foragerProg(80) is provably "forager with
// only the reproduce gate changed -- nothing else".
function foragerProg(gate: number): Instr[] {
  return [
    ["SYNTH", "CAT", 7],  // boost synth_enz
    ["SYNTH", "CAT", 10], // boost biopolymer digestion
    ["PUSH8", 1], ["INGEST"],
    // climbParticleGradient(CHEM_BIOPOLYMER, 30) expansion
    ["SENSE_OUT", CHEM_BIOPOLYMER],
    ["PUSH8", 30], ["MUL"],
    ["SWAP"],
    ["PUSH8", 30], ["MUL"],
    ["SWAP"],
    ["THRUST"],
    ["SELF_MEMBRANE"],
    ["PUSH8", gate],
    ["GT"],
    ["JZ", "np"],
    ["REPRODUCE"],
    ["LABEL", "np"],
  ];
}
const FORAGER80 = asm(foragerProg(80));
{
  const real = ARCHETYPES.find((a) => a.id === "forager")!.genome;
  const mine = asm(foragerProg(30));
  const same =
    real.length === mine.length && real.every((b, i) => b === mine[i]);
  if (!same) {
    console.error(
      "forager@30 reconstruction does NOT byte-match the catalogue " +
        "forager -- the foragerProg replica has drifted from " +
        "genome-archetypes; refusing to run a misleading probe.",
    );
    process.exit(1);
  }
}

type Cre = {
  id: number;
  lineageRoot: number;
  x: number;
  y: number;
  energy: number;
  idx: number;
  store: { chemCols: Float32Array[] };
};

interface Scenario {
  id: string;
  count: number;
  describe: string;
  // mutate world + freshly spawned cells before the run. `cells` =
  // focal archetype instances; `coStock` = the co-stocked creatures
  // (in spawn order) for scenarios that need to pair them (e.g.
  // pre-engulfing a symbiont into a host).
  setup: (w: World, cells: Cre[], coStock: Cre[]) => void;
  // optional extra per-sample / END columns (scenario-specific
  // measurements, e.g. endosymbiosis counts that must recurse into
  // host.contents since engulfed cells leave world.creatures).
  report?: (w: World) => string;
  // optional per-SAMPLE top-up (ambient chems: don't deplete fast,
  // so 30s cadence is fine). "perfect" = non-depleting medium.
  replenish?: (w: World) => void;
  // optional per-STEP maintenance. Required for particle food: a
  // fast-eating heterotroph bloom strips a fixed stock to ~0 between
  // 30s samples, so the food chemostat must run every tick or it
  // isn't a chemostat (predator run: overshoot->starvation collapse).
  perStep?: (w: World) => void;
  coStock: { id: string; count: number }[];
  // optional ad-hoc focal genome, overriding the `id` archetype's
  // genome (the `id` is still used for labels/report wiring).
  genome?: Uint8Array;
}

const AMB_STRIDE = 96;
function setAmbientAll(w: World, chem: number, v: number): void {
  const A = (w as unknown as { ambient: Float32Array }).ambient;
  for (let b = 0; b + chem < A.length; b += AMB_STRIDE) A[b + chem] = v;
}
function ambientMean(w: World, chem: number): number {
  const A = (w as unknown as { ambient: Float32Array }).ambient;
  let s = 0, n = 0;
  for (let b = 0; b + chem < A.length; b += AMB_STRIDE) { s += A[b + chem]; n++; }
  return n ? s / n : 0;
}
// Food chemostat: keep total particle count topped up to `target`
// with biopolymer particles (the forager's INGEST substrate). Uses a
// probe-local rng for placement (determinism irrelevant here).
function topUpBiopolymer(w: World, target: number): void {
  const ww = w as unknown as {
    particles: unknown[]; width: number; height: number;
    depth: number; surfaceY: number;
  };
  let need = target - ww.particles.length;
  while (need-- > 0) {
    const r = 1 + Math.random() * 1.5;
    pushParticle(w, {
      x: Math.random() * ww.width,
      y: ww.surfaceY + Math.random() * (ww.height - ww.surfaceY),
      z: r + Math.random() * (ww.depth - 2 * r),
      vx: 0, vy: 0, vz: 0,
      r,
      chemId: CHEM_BIOPOLYMER,
    });
  }
}

const SCENARIOS: Record<string, Scenario> = {
  photoautotroph: {
    id: "photoautotroph",
    count: 30,
    coStock: [],
    describe:
      "Near-surface (max light exp(-y/250)), permanent midday " +
      "(dayPhase=0.25, dayPeriod=1e9, no night). NUTRIENT-REPLETE " +
      "broth: aa source synth_aa is vmax-limited (0.4) below the aa " +
      "sinks (synth_membrane vmax 0.8 + chl/ribo/receptor), and aa " +
      "(perm 0.5) + min (perm 0.1) diffuse, so ambient CO2=50 / " +
      "MIN=50 / AA=30 seeded and re-topped every sample (chemostat); " +
      "cells primed CO2=20 ADP=30 MIN=30 AA=5. No co-stock. Founder " +
      "spawns off.",
    setup: (w, cells) => {
      w.dayPhase = 0.25;
      w.dayPeriod = 1e9;
      setAmbientAll(w, CHEM_CO2, 50);
      setAmbientAll(w, CHEM_MIN, 50);
      setAmbientAll(w, CHEM_AA, 30);
      const surfaceY = (w as unknown as { surfaceY: number }).surfaceY;
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        // pin just below the surface for maximal light
        c.y = surfaceY + 5 + (k % 6) * 3;
        c.x = w.width * (0.06 + 0.88 * ((k + 0.5) / cells.length));
        c.store.chemCols[CHEM_CO2][c.idx] = 20;
        c.store.chemCols[CHEM_ADP][c.idx] = 30;
        c.store.chemCols[CHEM_MIN][c.idx] = 30;
        c.store.chemCols[CHEM_AA][c.idx] = 5;
      }
    },
    replenish: (w) => {
      // Keep the medium nutrient-replete (non-depleting). aa + min
      // diffuse in (perm 0.5 / 0.1); CO2 too. No per-cell injection
      // -- uptake is via the medium so it stays a fair test.
      setAmbientAll(w, CHEM_CO2, 50);
      setAmbientAll(w, CHEM_MIN, 50);
      setAmbientAll(w, CHEM_AA, 30);
    },
  },

  // Controlled test of the synth_aa vmax 0.4->1.2 engine change:
  // EXACTLY the conditions of photoautotroph "run 2" (CO2+MIN replete
  // chemostat, NO amino-acid feeding, near-surface, permanent midday)
  // so the only variable vs that 30->19 decline is the vmax change.
  "photoautotroph-natural": {
    id: "photoautotroph",
    count: 30,
    coStock: [],
    describe:
      "NO aa feeding (natural). CO2=50/MIN=50 chemostat only; cells " +
      "primed CO2=20 ADP=30 MIN=30 (NO aa prime). Near-surface, " +
      "permanent midday, founders off. Identical to photoautotroph " +
      "run 2 (which declined 30->19); the sole difference is the " +
      "engine synth_aa vmax 0.4->1.2, isolating that change.",
    setup: (w, cells) => {
      w.dayPhase = 0.25;
      w.dayPeriod = 1e9;
      setAmbientAll(w, CHEM_CO2, 50);
      setAmbientAll(w, CHEM_MIN, 50);
      const surfaceY = (w as unknown as { surfaceY: number }).surfaceY;
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        c.y = surfaceY + 5 + (k % 6) * 3;
        c.x = w.width * (0.06 + 0.88 * ((k + 0.5) / cells.length));
        c.store.chemCols[CHEM_CO2][c.idx] = 20;
        c.store.chemCols[CHEM_ADP][c.idx] = 30;
        c.store.chemCols[CHEM_MIN][c.idx] = 30;
      }
    },
    replenish: (w) => {
      setAmbientAll(w, CHEM_CO2, 50);
      setAmbientAll(w, CHEM_MIN, 50);
    },
  },

  phototaxis: {
    id: "phototaxis",
    count: 30,
    coStock: [],
    describe:
      "Metabolically a photoautotroph (AUTO_SYNTH, no INGEST) PLUS " +
      "two extra aa-sinks (PHOTO+MAGNETO receptor synth) and a " +
      "conditional THRUST. Same proven recipe as photoautotroph: " +
      "near-surface (max light), permanent midday, CO2=50/MIN=50/" +
      "AA=30 chemostat, cells primed CO2=20 ADP=30 MIN=30 AA=5. No " +
      "co-stock. Founders off. Defining behavior is the genome's " +
      "'act_photo_visible < 6 -> climb magnetic axis' branch; we " +
      "MEASURE how many cells are in that dark/migrating branch " +
      "(nDark) rather than assume.",
    setup: (w, cells) => {
      w.dayPhase = 0.25;
      w.dayPeriod = 1e9;
      setAmbientAll(w, CHEM_CO2, 50);
      setAmbientAll(w, CHEM_MIN, 50);
      setAmbientAll(w, CHEM_AA, 30);
      const surfaceY = (w as unknown as { surfaceY: number }).surfaceY;
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        c.y = surfaceY + 5 + (k % 6) * 3;
        c.x = w.width * (0.06 + 0.88 * ((k + 0.5) / cells.length));
        c.store.chemCols[CHEM_CO2][c.idx] = 20;
        c.store.chemCols[CHEM_ADP][c.idx] = 30;
        c.store.chemCols[CHEM_MIN][c.idx] = 30;
        c.store.chemCols[CHEM_AA][c.idx] = 5;
      }
    },
    replenish: (w) => {
      setAmbientAll(w, CHEM_CO2, 50);
      setAmbientAll(w, CHEM_MIN, 50);
      setAmbientAll(w, CHEM_AA, 30);
    },
  },

  // Same controlled "natural" test for phototaxis: no aa feeding,
  // CO2+MIN replete chemostat only, near-surface, permanent midday.
  // Harder case than photoautotroph-natural -- phototaxis carries two
  // extra aa-sink receptor synths (PHOTO+MAGNETO) and a continuous
  // THRUST. Tests whether the synth_aa vmax 1.2 lets it self-supply
  // aa with NO exogenous source.
  "phototaxis-natural": {
    id: "phototaxis",
    count: 30,
    coStock: [],
    describe:
      "NO aa feeding (natural). CO2=50/MIN=50 chemostat only; cells " +
      "primed CO2=20 ADP=30 MIN=30 (NO aa prime). Near-surface, " +
      "permanent midday, founders off. Same recipe as " +
      "photoautotroph-natural; phototaxis adds PHOTO+MAGNETO receptor " +
      "aa-sinks and continuous THRUST (nDark measured).",
    setup: (w, cells) => {
      w.dayPhase = 0.25;
      w.dayPeriod = 1e9;
      setAmbientAll(w, CHEM_CO2, 50);
      setAmbientAll(w, CHEM_MIN, 50);
      const surfaceY = (w as unknown as { surfaceY: number }).surfaceY;
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        c.y = surfaceY + 5 + (k % 6) * 3;
        c.x = w.width * (0.06 + 0.88 * ((k + 0.5) / cells.length));
        c.store.chemCols[CHEM_CO2][c.idx] = 20;
        c.store.chemCols[CHEM_ADP][c.idx] = 30;
        c.store.chemCols[CHEM_MIN][c.idx] = 30;
      }
    },
    replenish: (w) => {
      setAmbientAll(w, CHEM_CO2, 50);
      setAmbientAll(w, CHEM_MIN, 50);
    },
  },

  // Phototaxis in an environment where its behavior is ADAPTIVE: a
  // real depth-attenuated light gradient (light = exp(-y/250)). Cells
  // start DEEP (not surface-pinned) so they're in the dark
  // (act_photo<6) -> the genome climbs the mag axis, and since
  // MAG_FIELD_Y=-1 that thrust is UPWARD toward the surface/light ->
  // emergent depth-keeping. No aa feeding; CO2+MIN chemostat; permanent
  // midday (the gradient is depth, not day/night). mY tracks whether
  // they actually migrate up.
  "phototaxis-gradient": {
    id: "phototaxis",
    count: 30,
    coStock: [],
    describe:
      "NO aa feeding. Depth light gradient (cells start DEEP, y in " +
      "[0.40,0.85]*H, not surface-pinned): dark -> climb mag axis -> " +
      "MAG_FIELD_Y=-1 = thrust UP toward light = adaptive depth-" +
      "keeping. CO2=50/MIN=50 chemostat, permanent midday (gradient " +
      "is depth). mY measures upward migration.",
    setup: (w, cells) => {
      w.dayPhase = 0.25;
      w.dayPeriod = 1e9;
      setAmbientAll(w, CHEM_CO2, 50);
      setAmbientAll(w, CHEM_MIN, 50);
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        // Mid + spread: low light so the migrate branch engages,
        // but shallow enough that photosynthesis can fund the climb.
        // Tightened from y 0.40-0.85 -> 0.20-0.55 after the catalyst
        // bitmask fix exposed that the old depth was unwinnable with
        // 1x (not 8x phantom) catalyst-synth rate.
        c.y = w.height * (0.2 + 0.35 * ((k + 0.5) / cells.length));
        c.x = w.width * (0.06 + 0.88 * (((k * 7) % cells.length) / cells.length));
        c.store.chemCols[CHEM_CO2][c.idx] = 20;
        c.store.chemCols[CHEM_ADP][c.idx] = 30;
        c.store.chemCols[CHEM_MIN][c.idx] = 30;
      }
    },
    replenish: (w) => {
      setAmbientAll(w, CHEM_CO2, 50);
      setAmbientAll(w, CHEM_MIN, 50);
    },
  },

  // #3 thermophile baseline: the proven autotroph recipe + DEFAULT
  // temp field (surface 28C, bottom 12C). The genome nulls act_thermo
  // = self-sorts to the 15C isotherm, which at default temps is
  // y~493 (deep, light ~exp(-1.97)~0.14). Prediction: thermo-thrust
  // drives cells DOWN out of the light (analogous to phototaxis-
  // natural's futile thrust) -> underperforms the plain autotroph.
  "thermophile-natural": {
    id: "thermophile",
    count: 30,
    coStock: [],
    describe:
      "NO aa feeding. Proven autotroph recipe (near-surface start, " +
      "permanent midday, CO2=50/MIN=50 chemostat) + DEFAULT temp " +
      "(surf 28C/bot 12C). Genome nulls act_thermo -> targets the " +
      "15C isotherm ~ y493 (dark). Baseline showing the autotroph-vs-" +
      "thermotaxis conflict. mActTh -> 0 iff it reaches its isotherm.",
    setup: (w, cells) => {
      w.dayPhase = 0.25;
      w.dayPeriod = 1e9;
      setAmbientAll(w, CHEM_CO2, 50);
      setAmbientAll(w, CHEM_MIN, 50);
      const surfaceY = (w as unknown as { surfaceY: number }).surfaceY;
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        c.y = surfaceY + 5 + (k % 6) * 3;
        c.x = w.width * (0.06 + 0.88 * ((k + 0.5) / cells.length));
        c.store.chemCols[CHEM_CO2][c.idx] = 20;
        c.store.chemCols[CHEM_ADP][c.idx] = 30;
        c.store.chemCols[CHEM_MIN][c.idx] = 30;
      }
    },
    replenish: (w) => {
      setAmbientAll(w, CHEM_CO2, 50);
      setAmbientAll(w, CHEM_MIN, 50);
    },
  },

  // #3 thermophile, behavior made ADAPTIVE: temperature field set so
  // the 15C isotherm (where the genome nulls act_thermo) sits in a
  // LIT shallow layer. tempSurface=17, tempBottom=1, patch off:
  // T=15 at depthFrac (17-15)/(17-1)=0.125 -> y ~= 30+0.125*570 ~=
  // 101, light exp(-101/250) ~= 0.67. Cells spread in depth, sort to
  // the lit isotherm. CO2/MIN chemostat, no aa, permanent midday.
  "thermophile-gradient": {
    id: "thermophile",
    count: 30,
    coStock: [],
    describe:
      "NO aa feeding. Temp field tuned so the 15C isotherm (genome's " +
      "act_thermo null) is at a LIT depth: tempSurface=17 bottom=1 " +
      "patch=0 -> T=15 at y~=101 (light ~0.67). Cells spread in " +
      "depth; should self-sort to ~y101 and self-sustain. CO2=50/" +
      "MIN=50 chemostat, permanent midday. mActTh->0 + mY->~101 if " +
      "thermal sorting works.",
    setup: (w, cells) => {
      w.dayPhase = 0.25;
      w.dayPeriod = 1e9;
      const wEnv = w as unknown as {
        tempSurface: number; tempBottom: number; tempPatchAmp: number;
        surfaceY: number;
      };
      wEnv.tempSurface = 17;
      wEnv.tempBottom = 1;
      wEnv.tempPatchAmp = 0; // clean horizontal isotherm
      setAmbientAll(w, CHEM_CO2, 50);
      setAmbientAll(w, CHEM_MIN, 50);
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        c.y = w.height * (0.2 + 0.6 * ((k + 0.5) / cells.length));
        c.x = w.width * (0.06 + 0.88 * (((k * 7) % cells.length) / cells.length));
        c.store.chemCols[CHEM_CO2][c.idx] = 20;
        c.store.chemCols[CHEM_ADP][c.idx] = 30;
        c.store.chemCols[CHEM_MIN][c.idx] = 30;
      }
    },
    replenish: (w) => {
      setAmbientAll(w, CHEM_CO2, 50);
      setAmbientAll(w, CHEM_MIN, 50);
    },
  },

  // #4 forager: heterotroph, no chemistry deficit (analyzer
  // heterotroph view: glucose 1.12 / aa 4.0 / fa 2.7 ok). Its
  // binding constraint is FOOD (biopolymer particles to INGEST +
  // digest via out[10]) and O2/MIN for respiration+biosynth, not the
  // reaction table. Perfect scenario = food-replete: ~1500 biopolymer
  // particles maintained (chemostat), ambient O2+MIN replete, no
  // predators, founders off. Isolates "does it find+digest food and
  // self-sustain". Reproduce gate SELF_MEMBRANE>30.
  forager: {
    id: "forager",
    count: 30,
    coStock: [],
    describe:
      "Food-replete: ~1500 biopolymer particles maintained every " +
      "sample (chemostat), ambient O2=30/MIN=50 replete, no " +
      "predators, founders off. Cells spread mid-column. Tests " +
      "whether the honest-baseline heterotroph finds + digests food " +
      "and self-sustains given abundant food.",
    setup: (w, cells) => {
      w.dayPhase = 0.25;
      w.dayPeriod = 1e9;
      setAmbientAll(w, CHEM_O2, 30);
      setAmbientAll(w, CHEM_MIN, 50);
      topUpBiopolymer(w, 1500);
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        c.y = w.height * (0.15 + 0.7 * ((k + 0.5) / cells.length));
        c.x = w.width * (0.06 + 0.88 * (((k * 7) % cells.length) / cells.length));
        c.store.chemCols[CHEM_O2][c.idx] = 10;
        c.store.chemCols[CHEM_MIN][c.idx] = 30;
      }
    },
    perStep: (w) => {
      // continuous: fast eaters strip a fixed stock between samples
      setAmbientAll(w, CHEM_O2, 30);
      setAmbientAll(w, CHEM_MIN, 50);
      topUpBiopolymer(w, 1500);
    },
  },

  // #5 predator (size-bully): heterotroph that INGESTs biopolymer to
  // bulk past the predation gate (attacker.r >= 1.14*target.r) and
  // PREDATEs on contact. Pre-screen: no chemistry deficit (het mode).
  // Perfect scenario = its food replete (biopolymer chemostat, so it
  // bulks AND can forage-survive) + abundant renewable PREY
  // (co-stocked foragers, validated self-sustaining on the same
  // chemostat) + no counter-predators, founders off. focal= column
  // tracks predator lineages vs prey.
  // #9 farmer SOLO: validate the host standalone (no mito), same
  // recipe forager #4 was nailed on. forager (= farmer minus ENGULF)
  // self-sustained 30->110 here; this isolates whether conditional
  // ENGULF lets farmer self-sustain too (vs the prior collapse).
  "farmer-solo": {
    id: "farmer",
    count: 30,
    coStock: [],
    describe:
      "Farmer host validated standalone: ~1500 biopolymer chemostat, " +
      "ambient O2=30/MIN=50, no mito, no predators, founders off. " +
      "Same scenario forager #4 nailed (30->110). Tests whether " +
      "conditional ENGULF (SELF_ENERGY>50 gate) lets the host " +
      "self-sustain instead of cannibalising to collapse.",
    setup: (w, cells) => {
      w.dayPhase = 0.25;
      w.dayPeriod = 1e9;
      setAmbientAll(w, CHEM_O2, 30);
      setAmbientAll(w, CHEM_MIN, 50);
      topUpBiopolymer(w, 1500);
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        c.y = w.height * (0.15 + 0.7 * ((k + 0.5) / cells.length));
        c.x = w.width * (0.06 + 0.88 * (((k * 7) % cells.length) / cells.length));
        c.store.chemCols[CHEM_O2][c.idx] = 10;
        c.store.chemCols[CHEM_MIN][c.idx] = 30;
      }
    },
    perStep: (w) => {
      setAmbientAll(w, CHEM_O2, 30);
      setAmbientAll(w, CHEM_MIN, 50);
      topUpBiopolymer(w, 1500);
    },
  },

  predator: {
    id: "predator",
    count: 30,
    coStock: [{ id: "forager", count: 80 }],
    describe:
      "Biopolymer chemostat ~1800 (feeds predator + co-stocked prey), " +
      "ambient O2=30/MIN=50, 80 forager prey co-stocked, no counter-" +
      "predators, founders off. focal=predator lineages only. Tests " +
      "whether the size-bully bulks past the 1.14x radius gate and " +
      "self-sustains by predation + foraging.",
    setup: (w, cells) => {
      w.dayPhase = 0.25;
      w.dayPeriod = 1e9;
      setAmbientAll(w, CHEM_O2, 30);
      setAmbientAll(w, CHEM_MIN, 50);
      topUpBiopolymer(w, 1800);
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        c.y = w.height * (0.15 + 0.7 * ((k + 0.5) / cells.length));
        c.x = w.width * (0.06 + 0.88 * (((k * 7) % cells.length) / cells.length));
        c.store.chemCols[CHEM_O2][c.idx] = 10;
        c.store.chemCols[CHEM_MIN][c.idx] = 30;
      }
    },
    perStep: (w) => {
      // continuous: a predator+prey bloom strips a fixed stock to ~0
      // between 30s samples -> overshoot starvation collapse.
      setAmbientAll(w, CHEM_O2, 30);
      setAmbientAll(w, CHEM_MIN, 50);
      topUpBiopolymer(w, 1800);
    },
  },

  // #11 mitochondria, scenario A: SEPARATE entities. Mito (focal) +
  // farmer hosts (the ENGULF archetype) co-stocked free; food
  // chemostat lets hosts bulk past the 1.14x breach gate and engulf
  // the small low-membrane mito. Watches engulfment + endosymbiosis
  // + tandem (eng:host ratio) arise on their own.
  "mito-symbiosis": {
    id: "mitochondria",
    count: 40,
    coStock: [{ id: "farmer", count: 40 }],
    describe:
      "SEPARATE: 60 free mito + 40 farmer hosts (ENGULF archetype), " +
      "biopolymer chemostat ~1500 + ambient O2=30/MIN=50. Hosts bulk " +
      "on food, engulf small mito. report: hosts / freeMito / " +
      "engMito(recursed) / hosts-carrying / eng:host ratio.",
    setup: (w) => {
      w.dayPhase = 0.25;
      w.dayPeriod = 1e9;
      setAmbientAll(w, CHEM_O2, 30);
      setAmbientAll(w, CHEM_MIN, 50);
      topUpBiopolymer(w, 1500);
    },
    perStep: (w) => {
      setAmbientAll(w, CHEM_O2, 30);
      setAmbientAll(w, CHEM_MIN, 50);
      topUpBiopolymer(w, 1500);
    },
    report: () => symReport(),
  },

  // #8 chloroplast SEPARATE-spawn symbiosis: 40 free chloroplasts +
  // 40 farmer hosts, NEAR-SURFACE + permanent midday so light reaches
  // both free chloroplasts AND engulfed plastids (runInnerCell uses
  // the host's depth-light). Ambient CO2/MIN replete (chloroplast
  // photosynthesis substrate) + biopolymer chemostat (the heterotroph
  // farmer host's food). Glucose is a native transferable chem, so an
  // engulfed chloroplast's leaked glu enters the shared host pool with
  // no ATP-translocase analog. Watches whether the host engulfs the
  // plastid + gains carbon + sustains tandem while it stays lit.
  "chloro-symbiosis": {
    id: "chloroplast",
    count: 40,
    coStock: [{ id: "farmer", count: 40 }],
    describe:
      "SEPARATE: 40 free chloroplasts + 40 farmer hosts, NEAR-SURFACE " +
      "(lit) + permanent midday, ambient CO2=50/MIN=50 + biopolymer " +
      "chemostat ~1500 (farmer food). Engulfed chloroplast photo-" +
      "synthesises on host depth-light and leaks glu to the shared " +
      "pool (native transfer, no translocase). report: symReport.",
    setup: (w, cells, coStock) => {
      w.dayPhase = 0.25;
      w.dayPeriod = 1e9;
      setAmbientAll(w, CHEM_CO2, 50);
      setAmbientAll(w, CHEM_MIN, 50);
      topUpBiopolymer(w, 1500);
      const surfaceY = (w as unknown as { surfaceY: number }).surfaceY;
      // keep BOTH lineages in the lit near-surface band so the
      // plastid (free or engulfed-via-host-depth) actually fixes C.
      const place = (arr: Cre[], spread: number): void => {
        for (let k = 0; k < arr.length; k++) {
          arr[k].y = surfaceY + 5 + (k % spread) * 3;
          arr[k].x = w.width * (0.06 + 0.88 * ((k + 0.5) / arr.length));
        }
      };
      place(cells, 8);
      place(coStock, 8);
    },
    perStep: (w) => {
      setAmbientAll(w, CHEM_CO2, 50);
      setAmbientAll(w, CHEM_MIN, 50);
      topUpBiopolymer(w, 1500);
    },
    report: () => symReport(),
  },

  // #11 mitochondria, scenario B: PRE-ENGULFED. Each host starts with
  // 2 mitos already in its contents (replicating the engine's engulf
  // invariant: pushed to host.contents, organelleSynthMask set,
  // removed from world.creatures). Tests whether an already-formed
  // symbiosis persists + reproduces in tandem (host fission
  // partitions contents to daughters; mito internal division).
  "mito-engulfed": {
    id: "mitochondria",
    count: 40,
    coStock: [{ id: "farmer", count: 40 }],
    describe:
      "PRE-ENGULFED: 40 farmer hosts each pre-loaded with 2 mito in " +
      "contents (engine engulf invariant). biopolymer chemostat " +
      "~1500 + ambient O2=30/MIN=50. Tests persistence + tandem " +
      "reproduction of an existing symbiosis.",
    setup: (w, mito, hosts) => {
      w.dayPhase = 0.25;
      w.dayPeriod = 1e9;
      setAmbientAll(w, CHEM_O2, 30);
      setAmbientAll(w, CHEM_MIN, 50);
      topUpBiopolymer(w, 1500);
      const creatures = (w as unknown as { creatures: unknown[] }).creatures;
      let mi = 0;
      for (const h of hosts) {
        const host = h as unknown as { contents: unknown[] };
        for (let j = 0; j < 1 && mi < mito.length; j++, mi++) {
          const m = mito[mi] as unknown as {
            genome: Uint8Array; organelleSynthMask: number;
          };
          // engine engulf invariant: alive in host.contents, masked,
          // and NOT in the free world.creatures list.
          m.organelleSynthMask = genomeSynthMask(m.genome);
          host.contents.push(m);
          const idx = creatures.indexOf(mito[mi]);
          if (idx >= 0) creatures.splice(idx, 1);
        }
      }
    },
    perStep: (w) => {
      setAmbientAll(w, CHEM_O2, 30);
      setAmbientAll(w, CHEM_MIN, 50);
      topUpBiopolymer(w, 1500);
    },
    report: () => symReport(),
  },

  // #6 armored: indigestible-prey strategy. Ideal conditions = a
  // food-replete world under sustained predator pressure (size-bully
  // co-stocked). Armor only matters if there is something to defend
  // against, so predators are essential to the test, not optional.
  // Success: the armored focal lineage persists/co-exists under
  // predation by out-growing the 1.14x breach gate and raising the
  // per-membrane breach cost -- contrast with armored-control (soft
  // forager focal, identical predator pressure) which should be
  // culled. Single variable between the two: the focal genome.
  armored: {
    id: "armored",
    count: 40,
    coStock: [{ id: "predator", count: 30 }],
    describe:
      "Biopolymer chemostat ~1800 (feeds armored grazers + the " +
      "co-stocked size-bully predators), ambient O2=30/MIN=50, " +
      "near-surface, permanent midday, founders off. focal=armored " +
      "lineages only; pop includes predators. Tests whether the " +
      "membrane-tank survives sustained predation (size refuge + " +
      "breach-cost) where a soft control does not.",
    setup: (w, cells) => {
      w.dayPhase = 0.25;
      w.dayPeriod = 1e9;
      setAmbientAll(w, CHEM_O2, 30);
      setAmbientAll(w, CHEM_MIN, 50);
      topUpBiopolymer(w, 1800);
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        c.y = w.height * (0.15 + 0.7 * ((k + 0.5) / cells.length));
        c.x = w.width * (0.06 + 0.88 * (((k * 7) % cells.length) / cells.length));
        c.store.chemCols[CHEM_O2][c.idx] = 10;
        c.store.chemCols[CHEM_MIN][c.idx] = 30;
      }
    },
    perStep: (w) => {
      setAmbientAll(w, CHEM_O2, 30);
      setAmbientAll(w, CHEM_MIN, 50);
      topUpBiopolymer(w, 1800);
    },
    report: (w) => armorReport(w),
  },

  // Soft-bodied control: identical predator pressure + food, focal is
  // the forager (no membrane investment). The only variable vs the
  // `armored` run is the focal genome, so a divergence in focal
  // survival isolates the armor strategy.
  "armored-control": {
    id: "forager",
    count: 40,
    coStock: [{ id: "predator", count: 30 }],
    describe:
      "Control for #6 armored: focal=forager (soft-bodied), same " +
      "biopolymer chemostat ~1800, O2=30/MIN=50, near-surface, " +
      "permanent midday, founders off, same 30 size-bully predators. " +
      "Single variable vs `armored`: the focal genome.",
    setup: (w, cells) => {
      w.dayPhase = 0.25;
      w.dayPeriod = 1e9;
      setAmbientAll(w, CHEM_O2, 30);
      setAmbientAll(w, CHEM_MIN, 50);
      topUpBiopolymer(w, 1800);
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        c.y = w.height * (0.15 + 0.7 * ((k + 0.5) / cells.length));
        c.x = w.width * (0.06 + 0.88 * (((k * 7) % cells.length) / cells.length));
        c.store.chemCols[CHEM_O2][c.idx] = 10;
        c.store.chemCols[CHEM_MIN][c.idx] = 30;
      }
    },
    perStep: (w) => {
      setAmbientAll(w, CHEM_O2, 30);
      setAmbientAll(w, CHEM_MIN, 50);
      topUpBiopolymer(w, 1800);
    },
    report: (w) => armorReport(w),
  },

  // Gate isolation: SOFT-bodied forager but reproduce gate = 80
  // (the catalogue forager is 30). Same predator pressure + food as
  // `armored`/`armored-control`. Completes the 2x2 (armor x gate):
  // forager@30 (armored-control), forager@80 (this), armored@30,
  // armored@80 -- isolating whether the original armored@80 edge was
  // the deferred-division size refuge (the gate) rather than the
  // membrane investment (the armor).
  forager80: {
    id: "forager",
    count: 40,
    genome: FORAGER80,
    coStock: [{ id: "predator", count: 30 }],
    describe:
      "Soft forager with reproduce gate 80 (vs catalogue 30), same " +
      "biopolymer chemostat ~1800, O2=30/MIN=50, near-surface, " +
      "permanent midday, founders off, same 30 size-bully predators. " +
      "Single variable vs armored-control: the reproduce gate.",
    setup: (w, cells) => {
      w.dayPhase = 0.25;
      w.dayPeriod = 1e9;
      setAmbientAll(w, CHEM_O2, 30);
      setAmbientAll(w, CHEM_MIN, 50);
      topUpBiopolymer(w, 1800);
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        c.y = w.height * (0.15 + 0.7 * ((k + 0.5) / cells.length));
        c.x = w.width * (0.06 + 0.88 * (((k * 7) % cells.length) / cells.length));
        c.store.chemCols[CHEM_O2][c.idx] = 10;
        c.store.chemCols[CHEM_MIN][c.idx] = 30;
      }
    },
    perStep: (w) => {
      setAmbientAll(w, CHEM_O2, 30);
      setAmbientAll(w, CHEM_MIN, 50);
      topUpBiopolymer(w, 1800);
    },
    report: (w) => armorReport(w),
  },

  // #16 benthic detritivore. Shared benthic niche scenario (the
  // future #17 cross-feeder, once a chemolithotroph path exists,
  // would co-stock here). Floor-fed biopolymer chemostat ~1500;
  // light is irrelevant to a heterotroph so the day setting is
  // cosmetic. Validates: (a) self-sustains on settled detritus,
  // (b) benthic position EMERGES (focal mean y -> floor as it
  // follows sinking food, with no scripted descent), (c) it emits
  // CO2 (co2P / ambCO2 rise) -- the seed for a future chemocline.
  benthic: {
    id: "benthic-detritivore",
    count: 40,
    coStock: [],
    describe:
      "Sea-floor detritivore solo: biopolymer chemostat ~1500, " +
      "ambient O2=30/MIN=50, founders off. Cells spawn spread " +
      "through the column; benthic settling must EMERGE from " +
      "detritus-tropism (biopolymer sinks), not a scripted descent. " +
      "Watches sustain + mean depth + CO2 emission.",
    setup: (w, cells) => {
      w.dayPhase = 0.25;
      w.dayPeriod = 1e9;
      setAmbientAll(w, CHEM_O2, 30);
      setAmbientAll(w, CHEM_MIN, 50);
      topUpBiopolymer(w, 1500);
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        c.y = w.height * (0.1 + 0.8 * ((k + 0.5) / cells.length));
        c.x = w.width * (0.06 + 0.88 * (((k * 7) % cells.length) / cells.length));
        c.store.chemCols[CHEM_O2][c.idx] = 10;
        c.store.chemCols[CHEM_MIN][c.idx] = 30;
      }
    },
    perStep: (w) => {
      setAmbientAll(w, CHEM_O2, 30);
      setAmbientAll(w, CHEM_MIN, 50);
      topUpBiopolymer(w, 1500);
    },
    report: (w) => benthicReport(w),
  },

  // Phase 1 premise proof: NO organic energy anywhere (no glu, no
  // biopolymer/detritus). The only energy input is the abiotic vent
  // fuel emitted at the floor; ambient AA/MIN supply biomass
  // precursors so the test isolates ENERGY. If the focal lineage
  // sustains a positive ATP pool here, the substrate already
  // expresses chemolithotrophy (energy from a non-living source via
  // an evolved catalyst) -- no engine change needed for Phase 1.
  vent: {
    id: "forager",
    genome: ventProbeGenome,
    count: 40,
    coStock: [],
    describe:
      "Abiotic vent: floor seep emits generic fuel chem to a fixed " +
      "standing count (~1200, bounded/accounted). NO glu, NO " +
      "biopolymer. Ambient AA=20/MIN=50/O2=30 for biomass only. " +
      "Focal = HET viability kit + SYNTH CAT(exergonic vent-fuel " +
      "slot) + INGEST. Sustained +ATP => chemolithotrophy is " +
      "already substrate-expressible.",
    setup: (w, cells) => {
      w.dayPhase = 0.25;
      w.dayPeriod = 1e9;
      setAmbientAll(w, CHEM_O2, 30);
      setAmbientAll(w, CHEM_CO2, 20);
      setAmbientAll(w, CHEM_MIN, 50);
      setAmbientAll(w, CHEM_AA, 20);
      ventEmit(w, VENT.fuels, 1200);
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        c.y = w.height * (0.86 + 0.1 * ((k + 0.5) / cells.length));
        c.x = w.width * (0.06 + 0.88 * (((k * 7) % cells.length) / cells.length));
        c.store.chemCols[CHEM_O2][c.idx] = 10;
        c.store.chemCols[CHEM_AA][c.idx] = 5;
      }
    },
    perStep: (w) => {
      setAmbientAll(w, CHEM_O2, 30);
      setAmbientAll(w, CHEM_CO2, 20);
      setAmbientAll(w, CHEM_MIN, 50);
      setAmbientAll(w, CHEM_AA, 20);
      ventEmit(w, VENT.fuels, 1200);
    },
    report: (w) => ventReport(w),
  },
};

const id = process.argv[2] ?? "photoautotroph";
const OBSERVE_MIN = Number(process.argv[3] ?? 10);
const sc = SCENARIOS[id];
if (!sc) {
  console.error(`no scenario for "${id}". have: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(1);
}
const arch = ARCHETYPES.find((a) => a.id === sc.id);
if (!arch) {
  console.error(`scenario "${id}" targets unknown archetype "${sc.id}"`);
  process.exit(1);
}

const DT = 1 / 60;
const OBSERVE_T = OBSERVE_MIN * 60;
const SAMPLE = 30;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const w = createWorld(800, 600, { delayedSpawn: true, seed: 4242 }) as any;
w.foundersEnabled = false;

// co-stock first (so the focal archetype's setup can see them)
const coStockCres: Cre[] = [];
for (const cs of sc.coStock) {
  const g = ARCHETYPES.find((a) => a.id === cs.id)!.genome;
  for (let i = 0; i < cs.count; i++) {
    const c = spawnSpeciesInstance(w, g);
    if (c) coStockCres.push(c as unknown as Cre);
  }
}
const coStockRoots = new Set<number>(coStockCres.map((c) => c.lineageRoot));
const focalGenome = sc.genome ?? arch.genome;
const focal: Cre[] = [];
for (let i = 0; i < sc.count; i++) {
  const c = spawnSpeciesInstance(w, focalGenome);
  if (c) focal.push(c as unknown as Cre);
}
sc.setup(w, focal, coStockCres);

// Focal-lineage attribution: spawnSpeciesInstance assigns a fresh
// lineageRoot per spawn, inherited by descendants. With co-stocked
// prey present, total pop conflates predator + prey, so count the
// focal archetype's own lineages separately.
const focalRoots = new Set<number>(focal.map((c) => c.lineageRoot));
function nFocal(): number {
  let n = 0;
  for (const c of w.creatures) {
    if (focalRoots.has((c as unknown as Cre).lineageRoot)) n++;
  }
  return n;
}

// Endosymbiosis-aware counters: engulfed cells live in host.contents
// (recursively), NOT world.creatures, so plain counts miss them.
type WithContents = Cre & { contents: WithContents[] };
function rootOf(c: unknown): number {
  return (c as Cre).lineageRoot;
}
// free = top-level world.creatures only.
function nFree(roots: Set<number>): number {
  let n = 0;
  for (const c of w.creatures) if (roots.has(rootOf(c))) n++;
  return n;
}
// engulfed = anywhere inside some host's contents tree.
function nEngulfed(roots: Set<number>): number {
  let n = 0;
  const walk = (list: WithContents[]): void => {
    for (const inner of list) {
      if (roots.has(rootOf(inner))) n++;
      if (inner.contents && inner.contents.length) walk(inner.contents);
    }
  };
  for (const c of w.creatures) {
    walk((c as unknown as WithContents).contents ?? []);
  }
  return n;
}
// hosts (free, lineage in hostRoots) that carry >=1 symbiont
// (lineage in symRoots) anywhere in their contents tree.
function nHostsCarrying(hostRoots: Set<number>, symRoots: Set<number>): number {
  let n = 0;
  const has = (list: WithContents[]): boolean => {
    for (const inner of list) {
      if (symRoots.has(rootOf(inner))) return true;
      if (inner.contents && inner.contents.length && has(inner.contents)) return true;
    }
    return false;
  };
  for (const c of w.creatures) {
    if (!hostRoots.has(rootOf(c))) continue;
    if (has((c as unknown as WithContents).contents ?? [])) n++;
  }
  return n;
}

// Endosymbiosis report: hosts (free farmer lineages), free mito,
// engulfed mito (recursed), hosts carrying >=1 mito, and the
// engulfed-mito : host ratio (the "tandem" indicator -- stable/
// growing ratio = symbiosis persisting + co-reproducing).
// Classify every engulfed mito by the lineage of its DIRECT enclosing
// cell, to resolve the earlier engMito>0 / hosts=0 anomaly: is the
// mito inside a host (farmer), inside another mito, or inside some
// other lineage? Walk world.creatures and recurse contents, tracking
// the immediate parent.
function engMitoEnclosure(): { inHost: number; inMito: number; inOther: number } {
  let inHost = 0, inMito = 0, inOther = 0;
  const walk = (list: WithContents[], parentRoot: number): void => {
    for (const inner of list) {
      if (focalRoots.has(rootOf(inner))) {
        if (coStockRoots.has(parentRoot)) inHost++;
        else if (focalRoots.has(parentRoot)) inMito++;
        else inOther++;
      }
      if (inner.contents && inner.contents.length) {
        walk(inner.contents, rootOf(inner));
      }
    }
  };
  for (const c of w.creatures) {
    const cc = c as unknown as WithContents;
    if (cc.contents && cc.contents.length) walk(cc.contents, rootOf(c));
  }
  return { inHost, inMito, inOther };
}

// Generic symbiosis report (works for any focal symbiont +
// co-stocked host -- mito or chloroplast). "Sym" not "Mito" for
// accuracy. inSym = symbiont enclosed by a symbiont-lineage cell
// (the post-host-extinction contents-promotion edge, flagged).
function symReport(): string {
  const hosts = nFree(coStockRoots);
  const freeM = nFree(focalRoots);
  const engM = nEngulfed(focalRoots);
  const hostsW = nHostsCarrying(coStockRoots, focalRoots);
  const ratio = hosts > 0 ? (engM / hosts).toFixed(2) : "-";
  const e = engMitoEnclosure();
  return (
    `hosts=${String(hosts).padStart(3)} ` +
    `freeSym=${String(freeM).padStart(4)} ` +
    `engSym=${String(engM).padStart(4)} ` +
    `[inHost=${e.inHost} inSym=${e.inMito} inOther=${e.inOther}] ` +
    `hostsW/Sym=${String(hostsW).padStart(3)} ` +
    `eng:host=${ratio}`
  );
}

// #6 armored report: focal (armored) survivors + their mean membrane
// and radius (the armor signal), against the co-stocked predator
// count. A persisting focal with rising membrane/radius while
// predators are present = the size-refuge + breach-cost strategy
// working. fMem/fR are over FREE focal creatures only.
function armorReport(w: World): string {
  let fn = 0, fMem = 0, fR = 0;
  for (const c of w.creatures) {
    const cc = c as unknown as Cre & { r: number };
    if (!focalRoots.has(cc.lineageRoot)) continue;
    fn++;
    fMem += cc.store.chemCols[CHEM_MEMBRANE][cc.idx];
    fR += cc.r;
  }
  const preds = nFree(coStockRoots);
  return (
    `armored=${String(fn).padStart(3)} ` +
    `fMem=${(fn ? fMem / fn : 0).toFixed(1).padStart(6)} ` +
    `fR=${(fn ? fR / fn : 0).toFixed(2).padStart(5)} ` +
    `preds=${String(preds).padStart(3)}`
  );
}

// #16 benthic detritivore report: focal survivors, their mean depth
// vs the floor (is benthic position emerging?), ambient CO2 mean and
// the count of free CO2 particles (the niche-defining emission), and
// the standing biopolymer (detritus) particle pool.
function benthicReport(w: World): string {
  let fn = 0, fy = 0;
  for (const c of w.creatures) {
    const cc = c as unknown as Cre & { lineageRoot: number };
    if (!focalRoots.has(cc.lineageRoot)) continue;
    fn++;
    fy += cc.y;
  }
  const ww = w as unknown as {
    height: number;
    particles: { chemId: number }[];
  };
  let co2P = 0, bioP = 0;
  for (const p of ww.particles) {
    if (p.chemId === CHEM_CO2) co2P++;
    else if (p.chemId === CHEM_BIOPOLYMER) bioP++;
  }
  return (
    `bd=${String(fn).padStart(3)} ` +
    `fY=${(fn ? fy / fn : 0).toFixed(0).padStart(3)}/${ww.height} ` +
    `ambCO2=${ambientMean(w, CHEM_CO2).toFixed(1).padStart(6)} ` +
    `co2P=${String(co2P).padStart(4)} ` +
    `bioP=${String(bioP).padStart(4)}`
  );
}

// Phase 1 premise check: focal survivors + their mean ATP (energy
// must be POSITIVE and sustained when the ONLY energy input is the
// abiotic vent fuel) + standing vent-particle count.
function ventReport(w: World): string {
  let fn = 0, fAtp = 0;
  for (const c of w.creatures) {
    const cc = c as unknown as Cre & {
      lineageRoot: number;
      store: { chemCols: Float32Array[] };
      idx: number;
    };
    if (!focalRoots.has(cc.lineageRoot)) continue;
    fn++;
    fAtp += cc.store.chemCols[CHEM_ATP][cc.idx];
  }
  const ww = w as unknown as { particles: { chemId: number }[] };
  const fuelSet = new Set(VENT.fuels);
  let vp = 0;
  for (const p of ww.particles) if (fuelSet.has(p.chemId)) vp++;
  return (
    `vent=${String(fn).padStart(3)} ` +
    `fATP=${(fn ? fAtp / fn : 0).toFixed(1).padStart(7)} ` +
    `E:s${VENT.energy}(+${VENT.atp.toFixed(1)}x${VENT.vmax.toFixed(2)}) ` +
    `C:s${VENT.carbon}(${VENT.cAtp.toFixed(2)}) ` +
    `fuels=${VENT.fuels.map((c) => "c" + c.toString(16)).join("+")} ` +
    `ventP=${String(vp).padStart(4)}`
  );
}

interface St { births: number; dStarve: number; dMembrane: number; dAa: number; dMrna: number; dOld: number }
function snap(): St {
  const s = w.stats ?? {};
  return {
    births: s.births ?? 0, dStarve: s.dStarve ?? 0, dMembrane: s.dMembrane ?? 0,
    dAa: s.dAa ?? 0, dMrna: s.dMrna ?? 0, dOld: s.dOld ?? 0,
  };
}
function meanCell(chem: number): number {
  const cs = w.creatures;
  if (!cs.length) return 0;
  let s = 0;
  for (const c of cs) s += c.store.chemCols[chem][c.idx];
  return s / cs.length;
}
function meanEnergy(): number {
  const cs = w.creatures;
  if (!cs.length) return 0;
  let s = 0;
  for (const c of cs) s += c.energy;
  return s / cs.length;
}
function nAboveMembrane(thresh: number): number {
  let n = 0;
  for (const c of w.creatures) if (c.store.chemCols[CHEM_MEMBRANE][c.idx] > thresh) n++;
  return n;
}
// Cells whose sensed visible light is below the phototaxis genome's
// threshold of 6 -- i.e. in the "dark, swim the magnetic axis"
// branch. Measured, not assumed.
// Cells whose sensed visible light is below the phototaxis genome's
// migrate threshold (KEEP IN SYNC with the PUSH8 constant in the
// phototaxis archetype -- currently 2). Below it the genome runs the
// "dark, swim the magnetic axis" branch. Measured, not assumed.
const PHOTOTAXIS_DARK_THRESH = 2;
function nDark(): number {
  let n = 0;
  for (const c of w.creatures) if (c.store.chemCols[CHEM_ACT_PHOTO_VISIBLE][c.idx] < PHOTOTAXIS_DARK_THRESH) n++;
  return n;
}
function meanY(): number {
  const cs = w.creatures;
  if (!cs.length) return 0;
  let s = 0;
  for (const c of cs) s += c.y;
  return s / cs.length;
}
// Mean activated-thermo. The thermophile genome nulls this (thrust
// proportional to it), so it -> ~0 if the cell has reached its
// preferred 15C isotherm. Measures whether thermal sorting works.
function meanActTh(): number {
  const cs = w.creatures;
  if (!cs.length) return 0;
  let s = 0;
  for (const c of cs) s += c.store.chemCols[CHEM_ACT_THERMO][c.idx];
  return s / cs.length;
}

console.log(`# scenario: ${id}  (x${focal.length} spawned${sc.coStock.length ? ", co-stock " + sc.coStock.map(c => c.id + ":" + c.count).join(",") : ", no co-stock"})`);
console.log(`# ${sc.describe}`);
console.log(
  `# reproduce gate: SELF_MEMBRANE > per-archetype threshold ` +
    `(photoauto/phototaxis/thermophile 40, forager/colony 30, ...)`,
);
console.log(
  `# t=0  pop=${w.creatures.length} ambCO2=${ambientMean(w, CHEM_CO2).toFixed(1)} ` +
    `meanMembrane=${meanCell(CHEM_MEMBRANE).toFixed(2)} meanATP=${meanEnergy().toFixed(1)} ` +
    `meanCHL=${meanCell(CHEM_CHL).toFixed(2)} meanGLU=${meanCell(CHEM_GLU).toFixed(2)}`,
);
const base = snap();
const t0 = Date.now();
let nextSample = SAMPLE;
let peak = w.creatures.length;
const endT = OBSERVE_T;

// Exact, mechanism-agnostic accounting by creature id (c.id is stable
// and never recycled): a new id = a birth, a vanished id = a death.
// Independent of the SimStats counters, so start + births - deaths
// closes by construction and any divergence from SimStats is visible.
let live = new Set<number>();
for (const c of w.creatures) live.add(c.id);
// True starting total (focal + any co-stock) -- the close-check must
// use this, not focal.length, or co-stocked scenarios never close.
const startTotal = live.size;
let idBirths = 0;
let idDeaths = 0;
console.log(
  `# maintenance: ${sc.replenish ? "ambient every-sample" : ""}` +
    `${sc.perStep ? (sc.replenish ? " + " : "") + "food every-STEP (continuous)" : ""}` +
    `${!sc.replenish && !sc.perStep ? "none" : ""}`,
);

while (w.t < endT) {
  step(w, DT);
  if (sc.perStep) sc.perStep(w);
  if (w.creatures.length > peak) peak = w.creatures.length;
  const now = new Set<number>();
  for (const c of w.creatures) {
    now.add(c.id);
    if (!live.has(c.id)) idBirths++;
  }
  for (const oldId of live) if (!now.has(oldId)) idDeaths++;
  live = now;
  if (w.t >= nextSample) {
    nextSample += SAMPLE;
    if (sc.replenish) sc.replenish(w);
    console.log(
      `t=${String(Math.round(w.t)).padStart(3)}s pop=${String(w.creatures.length).padStart(4)} ` +
        `focal=${String(nFocal()).padStart(4)} ` +
        `nMem>40=${String(nAboveMembrane(40)).padStart(3)} ` +
        `nDark=${String(nDark()).padStart(3)} ` +
        `mY=${meanY().toFixed(0).padStart(3)} ` +
        `mActTh=${meanActTh().toFixed(1).padStart(6)} ` +
        `mActPh=${meanCell(CHEM_ACT_PHOTO_VISIBLE).toFixed(1).padStart(5)} ` +
        `mMem=${meanCell(CHEM_MEMBRANE).toFixed(2).padStart(6)} ` +
        `mATP=${meanEnergy().toFixed(1).padStart(7)} ` +
        `mCHL=${meanCell(CHEM_CHL).toFixed(2).padStart(6)} ` +
        `mAA=${meanCell(CHEM_AA).toFixed(2).padStart(6)} ` +
        `mGLU=${meanCell(CHEM_GLU).toFixed(2).padStart(6)} ` +
        `ambAA=${ambientMean(w, CHEM_AA).toFixed(1).padStart(5)} ` +
        `ambMIN=${ambientMean(w, CHEM_MIN).toFixed(1).padStart(5)}` +
        (sc.report ? "  " + sc.report(w) : ""),
    );
  }
}
const e = snap();
const idClose = startTotal + idBirths - idDeaths;
console.log(
  `# END  pop=${w.creatures.length} focal=${nFocal()} peak=${peak}` +
    (sc.report ? "  " + sc.report(w) : ""),
);
console.log(
  `# id-accounting (exact, FREE creatures only -- engulfed cells ` +
    `live in host.contents and are tracked by the scenario report): ` +
    `start=${startTotal} free (spawned: focal ${focal.length}, ` +
    `coStock ${coStockCres.length}) births=${idBirths} deaths=${idDeaths} ` +
    `-> expected=${idClose} actual=${w.creatures.length} ` +
    `(closes: ${idClose === w.creatures.length})`,
);
console.log(
  `# SimStats deltas: births=${e.births - base.births} ` +
    `deaths{starve=${e.dStarve - base.dStarve} mem=${e.dMembrane - base.dMembrane} ` +
    `aa=${e.dAa - base.dAa} mrna=${e.dMrna - base.dMrna} old=${e.dOld - base.dOld}} ` +
    `(sum=${(e.dStarve - base.dStarve) + (e.dMembrane - base.dMembrane) + (e.dAa - base.dAa) + (e.dMrna - base.dMrna) + (e.dOld - base.dOld)})`,
);
console.log(
  `# ambient end: CO2=${ambientMean(w, CHEM_CO2).toFixed(1)} MIN=${ambientMean(w, CHEM_MIN).toFixed(1)}`,
);
console.log(`# done in ${((Date.now() - t0) / 1000).toFixed(0)}s wall`);
