// Static reaction-balance analysis over the WHOLE known reaction
// table. For every chemical, sums production vs consumption capacity
// at vmax and flags structural deficits (supply < demand) -- the same
// steady-state mass-balance relation used to derive the synth_aa and
// photosynth vmax fixes, applied to all named reactions at once so
// remaining flaws are computed, not discovered one scenario at a time.
//
//   npx tsx scripts/rxn_balance.ts
//
// FIRST-ORDER CEILING ANALYSIS -- caveats (printed in the report too):
//  - uses vmax (the catalyzed ceiling); realized rate also depends on
//    uncatRate, catalyst pool, substrate saturation, and the shared
//    multipliers (mrna/light/enz/surface) which only ~cancel between
//    a producer and its consumers.
//  - Sum(stoich*vmax) over sinks is an UPPER bound (sinks are rarely
//    all at vmax simultaneously), so a small deficit may be benign.
//  => it finds CANDIDATE flaws to validate empirically, not proof.

import { REACTIONS } from "../src/sim/reactions";
import {
  NAMED_CHEMICALS,
  NAMED_CHEMICAL_COUNT,
} from "../src/sim/chem-ids";
import {
  SYNTH_BIT_BIO,
  SYNTH_BIT_AA,
  SYNTH_BIT_FA,
  SYNTH_BIT_ENZ,
  SYNTH_BIT_CHL,
  SYNTH_BIT_MRNA,
  SYNTH_BIT_PHOTO_BASE,
  SYNTH_BIT_CHEMO_BASE,
  SYNTH_BIT_MAGNETO,
} from "../src/genome";

function chemName(id: number): string {
  if (id < NAMED_CHEMICAL_COUNT) return NAMED_CHEMICALS[id] as string;
  return `gen${id}`;
}

// Trophic-mode synthMasks: which SYNTH bits the archetype expresses.
// A reaction is eligible for a mode iff gateMask==0 (always) or the
// mode's mask intersects gateMask.
const AUTOTROPH =
  (1 << SYNTH_BIT_CHL) | (1 << SYNTH_BIT_BIO) | (1 << SYNTH_BIT_MRNA) |
  (1 << SYNTH_BIT_FA) | (1 << SYNTH_BIT_AA) |
  (1 << SYNTH_BIT_PHOTO_BASE) | (1 << SYNTH_BIT_MAGNETO);
const HETEROTROPH =
  (1 << SYNTH_BIT_BIO) | (1 << SYNTH_BIT_MRNA) | (1 << SYNTH_BIT_FA) |
  (1 << SYNTH_BIT_ENZ) | (1 << SYNTH_BIT_AA) | (1 << SYNTH_BIT_CHEMO_BASE);

// demandStruct = always-on biosynth/structural draw (endergonic
// consumers, atpDelta<=0). demandEnergy = demand-driven catabolic
// draw (exergonic consumers, atpDelta>0: aerobic/ferment/betaOx --
// only fire when ATP is needed). The binding verdict uses STRUCTURAL
// demand; energy demand is shown separately so the static tool stops
// flagging fuel chems as deficits just because catabolism *could*
// run at vmax.
interface Bal {
  supply: number;
  demandStruct: number;
  demandEnergy: number;
  prodRx: number[];
  consRx: number[];
}

// Core/known chemistry = the bootstrap reactions every cell gets free
// (uncatRate > 0). Generic procedural slots (uncatRate 0, only fire
// once a catalyst is built) and transport slots are reported as counts
// only -- their balance is per-genome, not a universal property.
function analyze(modeMask: number | null, label: string): void {
  const bal = new Map<number, Bal>();
  const get = (id: number): Bal => {
    let b = bal.get(id);
    if (!b) { b = { supply: 0, demandStruct: 0, demandEnergy: 0, prodRx: [], consRx: [] }; bal.set(id, b); }
    return b;
  };
  let coreN = 0, genN = 0, transN = 0, gatedOut = 0;
  const hasBit = (bit: number): boolean =>
    modeMask !== null && (modeMask & (1 << bit)) !== 0;
  for (let s = 0; s < REACTIONS.length; s++) {
    const r = REACTIONS[s];
    if (r.transport !== undefined) { transN++; continue; }
    if (r.uncatRate <= 0) { genN++; continue; } // generic/procedural
    coreN++;
    if (modeMask !== null) {
      // gateMask: needs the matching SYNTH bit. enzScale/chlScale are
      // de-facto gates too -- the reaction is dead without an enzyme/
      // chlorophyll pool, which only exists if the mode SYNTHs it.
      const gatedBySynth =
        r.gateMask !== 0 && (modeMask & r.gateMask) === 0;
      const needsEnz = r.enzScale && !hasBit(SYNTH_BIT_ENZ);
      const needsChl = r.chlScale && !hasBit(SYNTH_BIT_CHL);
      if (gatedBySynth || needsEnz || needsChl) { gatedOut++; continue; }
    }
    for (let j = 0; j < r.pChem.length; j++) {
      const b = get(r.pChem[j]);
      b.supply += r.pCount[j] * r.vmax;
      b.prodRx.push(s);
    }
    const energyDriven = r.atpDelta > 0; // catabolic ATP-maker
    for (let j = 0; j < r.sChem.length; j++) {
      const b = get(r.sChem[j]);
      if (energyDriven) b.demandEnergy += r.sCount[j] * r.vmax;
      else b.demandStruct += r.sCount[j] * r.vmax;
      b.consRx.push(s);
    }
  }
  console.log(`\n=== ${label} ===`);
  console.log(
    `core(uncat>0)=${coreN}${modeMask !== null ? ` (gated-out ${gatedOut})` : ""} ` +
      `generic=${genN} transport=${transN}`,
  );
  console.log("chem            supply  dStruct  dEnergy  S/Dstr  verdict   (prod / cons rx)");
  const ids = [...bal.keys()].sort((a, b) => a - b);
  for (const id of ids) {
    const b = bal.get(id)!;
    if (b.supply === 0 && b.demandStruct === 0 && b.demandEnergy === 0) continue;
    // Verdict on STRUCTURAL (always-on) demand only.
    const sd = b.demandStruct === 0 ? Infinity : b.supply / b.demandStruct;
    const verdict =
      b.supply === 0 ? "NO SOURCE" :
      b.demandStruct === 0 ? "(no struct sink)" :
      sd < 0.67 ? "DEFICIT" :
      sd < 1.0 ? "tight" : "ok";
    console.log(
      `${chemName(id).padEnd(14)} ${b.supply.toFixed(2).padStart(7)} ` +
        `${b.demandStruct.toFixed(2).padStart(7)} ${b.demandEnergy.toFixed(2).padStart(8)} ` +
        `${(sd === Infinity ? "inf" : sd.toFixed(2)).padStart(6)}  ` +
        `${verdict.padEnd(16)} [${b.prodRx.join(",")}] / [${b.consRx.join(",")}]`,
    );
  }
  // ATP balance over the eligible core set.
  let atpSup = 0, atpDem = 0;
  for (let s = 0; s < REACTIONS.length; s++) {
    const r = REACTIONS[s];
    if (r.transport !== undefined || r.uncatRate <= 0) continue;
    if (modeMask !== null) {
      const gatedBySynth = r.gateMask !== 0 && (modeMask & r.gateMask) === 0;
      const needsEnz = r.enzScale && !hasBit(SYNTH_BIT_ENZ);
      const needsChl = r.chlScale && !hasBit(SYNTH_BIT_CHL);
      if (gatedBySynth || needsEnz || needsChl) continue;
    }
    if (r.atpDelta > 0) atpSup += r.atpDelta * r.vmax;
    else if (r.atpDelta < 0) atpDem += -r.atpDelta * r.vmax;
  }
  console.log(
    `ATP@vmax  supply=${atpSup.toFixed(2)} demand=${atpDem.toFixed(2)} ` +
      `S/D=${atpDem === 0 ? "inf" : (atpSup / atpDem).toFixed(2)}`,
  );
}

console.log(
  "# Reaction-balance (FIRST-ORDER vmax-ceiling). Verdict uses\n" +
    "# S/Dstr = supply / STRUCTURAL demand (always-on biosynth);\n" +
    "# dEnergy (demand-driven catabolism: aerobic/ferment/betaOx) is\n" +
    "# shown but NOT in the verdict -- it only fires when ATP is low.\n" +
    "# DEFICIT < 0.67, tight < 1.0. Sum(stoich*vmax) is an UPPER bound\n" +
    "# and shared multipliers only ~cancel: flag = candidate to\n" +
    "# validate empirically, not proof. Mode views exclude reactions\n" +
    "# gated by SYNTH bit / enzScale / chlScale the mode doesn't make.\n" +
    "# rx slots: 0-3 energy/photosynth, 4-9 biosynth, 10 digest,\n" +
    "# 11 memb, 12-21 receptors, 22 bond, 23 repair, 24 glu->biop,\n" +
    "# 25 photophos.",
);
analyze(null, "ALL core reactions (unconditional, no trophic gate)");
analyze(AUTOTROPH, "AUTOTROPH-expressible (CHL/BIO/MRNA/FA/AA/PHOTO/MAG)");
analyze(HETEROTROPH, "HETEROTROPH-expressible (BIO/MRNA/FA/ENZ/AA/CHEMO)");
