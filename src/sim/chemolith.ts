// Abiotic chemolithotrophy wiring. Derives, from the import-time-fixed
// seeded reaction table, (a) the reduced-fuel cocktail a hydrothermal
// vent must emit and (b) the catalyst slots a chemolithoautotroph
// evolves to live on it. Everything here is deterministic, so the engine
// vent's fuel and the shipped archetype's `SYNTH CAT` targets agree by
// construction -- no hand-tuning, the seeded chemistry picks the niche.
//
// Energy comes from a catalyst-gated exergonic reaction whose fuel is the
// vent's reduced generics; carbon from a catalyst-gated GLU route on
// acquirable inputs (ambient CO2 + vent generics). The cell pays the
// carbon route's ATP cost out of the energy module -- real
// chemolithoautotrophy: chemical energy drives carbon fixation.

import { REACTIONS } from "./reactions";
import { NAMED_CHEMICAL_COUNT, CHEM_O2, CHEM_CO2, CHEM_MIN, CHEM_GLU } from "./chem-ids";

// Inorganics the open world already supplies everywhere (so a reaction
// needing only these + vent generics is runnable at the vent).
const AMBIENT_INORGANIC = new Set<number>([CHEM_O2, CHEM_CO2, CHEM_MIN]);

function acquirable(chem: number): boolean {
  return chem >= NAMED_CHEMICAL_COUNT || AMBIENT_INORGANIC.has(chem);
}
function genericSubs(slot: number): number[] {
  return [...REACTIONS[slot].sChem].filter((c) => c >= NAMED_CHEMICAL_COUNT);
}
function allAcquirable(slot: number): boolean {
  const s = REACTIONS[slot].sChem;
  if (s.length === 0) return false;
  for (const c of s) if (!acquirable(c)) return false;
  return true;
}

// Energy module: the dark, catalyst-gated exergonic reaction with the
// highest ATP throughput (atpDelta * vmax) whose substrates are all
// acquirable and include at least one generic (so it genuinely depends
// on vent fuel rather than ambient inorganics alone).
function pickEnergySlot(): number {
  let best = -1, score = 0;
  for (let k = 0; k < REACTIONS.length; k++) {
    const r = REACTIONS[k];
    if (r.uncatRate !== 0 || r.atpDelta <= 0 || r.lightIn !== 0) continue;
    if (!allAcquirable(k) || genericSubs(k).length === 0) continue;
    const s = r.atpDelta * r.vmax;
    if (s > score) { score = s; best = k; }
  }
  return best;
}

// Carbon module: the dark, catalyst-gated reaction producing the most
// glucose per second (yield * vmax) from acquirable inputs.
function pickCarbonSlot(): number {
  let best = -1, score = -1;
  for (let k = 0; k < REACTIONS.length; k++) {
    const r = REACTIONS[k];
    if (r.uncatRate !== 0 || r.lightIn !== 0) continue;
    if (!allAcquirable(k)) continue;
    let gi = -1;
    for (let j = 0; j < r.pChem.length; j++) if (r.pChem[j] === CHEM_GLU) gi = j;
    if (gi < 0) continue;
    const s = r.pCount[gi] * r.vmax;
    if (s > score) { score = s; best = k; }
  }
  return best;
}

export const CHEMOLITH_ENERGY_SLOT = pickEnergySlot();
export const CHEMOLITH_CARBON_SLOT = pickCarbonSlot();

// The reduced generics the vent must emit: the union of the energy and
// carbon modules' generic substrates. Ambient inorganics (CO2/O2/MIN)
// are supplied by the world, not the vent.
export const VENT_FUEL_CHEMS: number[] = (() => {
  const s = new Set<number>();
  if (CHEMOLITH_ENERGY_SLOT >= 0) for (const c of genericSubs(CHEMOLITH_ENERGY_SLOT)) s.add(c);
  if (CHEMOLITH_CARBON_SLOT >= 0) for (const c of genericSubs(CHEMOLITH_CARBON_SLOT)) s.add(c);
  return [...s];
})();
