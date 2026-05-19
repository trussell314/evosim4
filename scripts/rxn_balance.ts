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

interface Bal { supply: number; demand: number; prodRx: number[]; consRx: number[] }

// Core/known chemistry = the bootstrap reactions every cell gets free
// (uncatRate > 0). Generic procedural slots (uncatRate 0, only fire
// once a catalyst is built) and transport slots are reported as counts
// only -- their balance is per-genome, not a universal property.
function analyze(modeMask: number | null, label: string): void {
  const bal = new Map<number, Bal>();
  const get = (id: number): Bal => {
    let b = bal.get(id);
    if (!b) { b = { supply: 0, demand: 0, prodRx: [], consRx: [] }; bal.set(id, b); }
    return b;
  };
  let coreN = 0, genN = 0, transN = 0, gatedOut = 0;
  for (let s = 0; s < REACTIONS.length; s++) {
    const r = REACTIONS[s];
    if (r.transport !== undefined) { transN++; continue; }
    if (r.uncatRate <= 0) { genN++; continue; } // generic/procedural
    coreN++;
    if (modeMask !== null && r.gateMask !== 0 && (modeMask & r.gateMask) === 0) {
      gatedOut++; continue; // not expressible by this trophic mode
    }
    for (let j = 0; j < r.pChem.length; j++) {
      const b = get(r.pChem[j]);
      b.supply += r.pCount[j] * r.vmax;
      b.prodRx.push(s);
    }
    for (let j = 0; j < r.sChem.length; j++) {
      const b = get(r.sChem[j]);
      b.demand += r.sCount[j] * r.vmax;
      b.consRx.push(s);
    }
  }
  console.log(`\n=== ${label} ===`);
  console.log(
    `core(uncat>0)=${coreN}${modeMask !== null ? ` (gated-out ${gatedOut})` : ""} ` +
      `generic=${genN} transport=${transN}`,
  );
  console.log("chem            supply   demand   S/D   verdict   (prod<-/->cons rx slots)");
  const ids = [...bal.keys()].sort((a, b) => a - b);
  for (const id of ids) {
    const b = bal.get(id)!;
    if (b.supply === 0 && b.demand === 0) continue;
    const sd = b.demand === 0 ? Infinity : b.supply / b.demand;
    const verdict =
      b.supply === 0 ? "NO SOURCE" :
      b.demand === 0 ? "(no sink)" :
      sd < 0.67 ? "DEFICIT" :
      sd < 1.0 ? "tight" : "ok";
    console.log(
      `${chemName(id).padEnd(14)} ${b.supply.toFixed(2).padStart(7)} ` +
        `${b.demand.toFixed(2).padStart(7)} ${(sd === Infinity ? "inf" : sd.toFixed(2)).padStart(6)}  ` +
        `${verdict.padEnd(9)} [${b.prodRx.join(",")}] <- -> [${b.consRx.join(",")}]`,
    );
  }
  // ATP balance over the eligible core set.
  let atpSup = 0, atpDem = 0;
  for (let s = 0; s < REACTIONS.length; s++) {
    const r = REACTIONS[s];
    if (r.transport !== undefined || r.uncatRate <= 0) continue;
    if (modeMask !== null && r.gateMask !== 0 && (modeMask & r.gateMask) === 0) continue;
    if (r.atpDelta > 0) atpSup += r.atpDelta * r.vmax;
    else if (r.atpDelta < 0) atpDem += -r.atpDelta * r.vmax;
  }
  console.log(
    `ATP@vmax  supply=${atpSup.toFixed(2)} demand=${atpDem.toFixed(2)} ` +
      `S/D=${atpDem === 0 ? "inf" : (atpSup / atpDem).toFixed(2)}`,
  );
}

console.log(
  "# Reaction-balance (FIRST-ORDER vmax-ceiling). DEFICIT = supply/demand\n" +
    "# < 0.67, tight = < 1.0. Sum(stoich*vmax) over sinks is an UPPER\n" +
    "# bound (not all sinks max at once) and shared multipliers only\n" +
    "# ~cancel, so flag = candidate to validate empirically, not proof.\n" +
    "# rx slots: 0-3 energy/photosynth, 4-9 biosynth, 10 digest,\n" +
    "# 11 memb, 12-21 receptors, 22 bond, 23 repair, 24 glu->biop,\n" +
    "# 25 photophos.",
);
analyze(null, "ALL core reactions (unconditional, no trophic gate)");
analyze(AUTOTROPH, "AUTOTROPH-expressible (CHL/BIO/MRNA/FA/AA/PHOTO/MAG)");
analyze(HETEROTROPH, "HETEROTROPH-expressible (BIO/MRNA/FA/ENZ/AA/CHEMO)");
