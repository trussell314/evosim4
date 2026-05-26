// Per-cell reaction kinetics: the intra-pool reaction runner, the
// cell<->world transporter applier, and the catalyst/inhibitor synthesis
// helpers. These read/write a single cell's SoA pools (and, for
// transport, the region ambient field) and record into the reaction/ATP
// ledger. Leaf module: called by the creature update loop in sim.ts,
// depends only on the chem tables, the reaction catalog, the region
// ambient indexer, and the recording hooks -- never back on sim.ts.

import { recordRxn, recordAtp } from "./reaction-recording";
import { ambientBaseAt } from "./regions";
import { type Creature, type World, MIN_CREATURE_R } from "./core";
import {
  CHEM_ADP, CHEM_MRNA, CHEM_CHL, CHEM_ENZ, MRNA_REF, CHL_REF, ENZ_REF,
} from "./chem-ids";
import {
  REACTIONS, TRANSPORT_TARGETS, TRANSPORT_ATP, TRANSPORT_SLOT_BASE,
} from "./reactions";
import { RX_LOC_CELL, RX_SYNTH_CATALYST, ATP_RXN_ENDO, ATP_RXN_EXO } from "./rxn-ids";
import { N_REACTIONS } from "../genome";

// Reaction kinetics. Michaelis-Menten saturation so each reaction runs
// at most VMAX per second and gracefully slows as substrates deplete.
const KM_DEFAULT = 1;
// Catalyst reference pool: a reaction's rate scales with pool/CAT_REF.
const CAT_REF = 5;
// Allosteric inhibitor strength: inhPool/CAT_REF = 1 zeros the slot.
const INH_K = 1;
// Endergonic reactions keep this much ATP in reserve (atpFloor slots)
// so newborns don't drain themselves dry growing.
const BIOSYNTH_ATP_FLOOR = 4;

export function runGenericReactions(c: Creature, dt: number, ambientLight: number): void {
  const s = c.store; const i = c.idx;
  const KM = KM_DEFAULT;
  for (let slot = 0; slot < N_REACTIONS; slot++) {
    const rxn = REACTIONS[slot];
    // Transport-flavored slots are not intra-pool reactions; the
    // cross-compartment applier (runTransportReactions) handles them.
    if (rxn.transport !== undefined) continue;
    const pool = s.catalystCols[slot][i];
    if (rxn.uncatRate <= 0 && pool <= 0) continue;
    // Light gate
    let lightMult = 1;
    if (rxn.lightIn > 0) {
      if (ambientLight <= 0) continue;
      lightMult = ambientLight / rxn.lightIn;
      if (lightMult > 1) lightMult = 1;
    }
    // Substrate gate + MM saturation
    let limit = Infinity;
    let satProduct = 1;
    const sChem = rxn.sChem;
    const sCount = rxn.sCount;
    for (let j = 0; j < sChem.length; j++) {
      const have = s.chemCols[sChem[j]][i];
      const need = sCount[j];
      const ratio = have / need;
      if (ratio < limit) limit = ratio;
      satProduct *= ratio / (ratio + KM);
    }
    if (limit <= 0) continue;
    // ATP / ADP handling.
    const atpD = rxn.atpDelta;
    if (atpD < 0) {
      // Endergonic: pulls from cell energy. atpFloor reactions keep
      // BIOSYNTH_ATP_FLOOR ATP in reserve so newborns don't drain
      // themselves dry growing.
      const floor = rxn.atpFloor ? BIOSYNTH_ATP_FLOOR : 0;
      const eAvail = (s.energy[i] - floor) / -atpD;
      if (eAvail <= 0) continue;
      if (eAvail < limit) limit = eAvail;
      satProduct *= eAvail / (eAvail + KM);
    } else if (atpD > 0) {
      // Exergonic: phosphorylates ADP back to ATP. Need ADP available.
      const adpAvail = s.chemCols[CHEM_ADP][i] / atpD;
      if (adpAvail <= 0) continue;
      if (adpAvail < limit) limit = adpAvail;
      satProduct *= adpAvail / (adpAvail + KM);
    }
    const surface = rxn.surfaceScale ? (s.r[i] / MIN_CREATURE_R) : 1;
    // Named-molecule multipliers: mRNA are the cell's protein-
    // synthesis machinery (mandatory on every biosynth reaction);
    // chlorophyll is the photosynth pigment (mandatory on slot 3).
    // Both gate hard at zero -- no pigment, no photosynth; no
    // mRNA, no biosynthesis. cells must build these molecules
    // via SYNTH_MRNA / SYNTH_CHL to actually grow / fix carbon.
    let machineryMult = 1;
    if (rxn.mrnaScale) {
      const r = s.chemCols[CHEM_MRNA][i];
      if (r <= 0) continue;
      machineryMult *= r / MRNA_REF;
    }
    if (rxn.chlScale) {
      const ch = s.chemCols[CHEM_CHL][i];
      if (ch <= 0) continue;
      // Saturating, not linear: per-cell light harvesting is capped by
      // finite incident photons. An unbounded chl/CHL_REF made the
      // light reaction (out[25]) autocatalytic without diminishing
      // returns -- cells hoarded carbon as excess chlorophyll (chl
      // ran away to 4000+) instead of building fa/membranes/dividing.
      // Flat above CHL_REF removes that incentive; identical below.
      machineryMult *= Math.min(1, ch / CHL_REF);
    }
    if (rxn.enzScale) {
      const en = s.chemCols[CHEM_ENZ][i];
      if (en <= 0) continue;
      machineryMult *= en / ENZ_REF;
    }
    // Allosteric inhibitor dampens the effective rate (Phase 4b).
    // inhPool/CAT_REF = 1 with INH_K=1 zeros the slot; below that
    // it linearly scales the (uncat + catalyzed) rate down.
    const inhPool = s.inhibitorCols[slot][i];
    let inhMult = 1;
    if (inhPool > 0) {
      inhMult = 1 - INH_K * (inhPool / CAT_REF);
      if (inhMult <= 0) continue;
    }
    const rate = (rxn.uncatRate + rxn.vmax * (pool / CAT_REF)) * satProduct * lightMult * surface * machineryMult * inhMult;
    let amt = rate * dt;
    if (amt > limit) amt = limit;
    if (amt <= 0) continue;
    // Apply substrates
    for (let j = 0; j < sChem.length; j++) {
      s.chemCols[sChem[j]][i] -= sCount[j] * amt;
    }
    // Apply products
    const pChem = rxn.pChem;
    const pCount = rxn.pCount;
    for (let j = 0; j < pChem.length; j++) {
      s.chemCols[pChem[j]][i] += pCount[j] * amt;
    }
    // ATP / ADP conversion (mass-conserving)
    if (atpD !== 0) {
      s.energy[i] += atpD * amt;
      s.chemCols[CHEM_ADP][i] -= atpD * amt;
    }
    // Accounting: one firing of this slot (cell), catalyzed iff a
    // catalyst pool actually boosted it. ATP flux into the ledger.
    recordRxn(slot, RX_LOC_CELL, (pool > 0 && rxn.vmax > 0) ? 1 : 0);
    if (atpD < 0) recordAtp(ATP_RXN_ENDO, -atpD * amt, 0);
    else if (atpD > 0) recordAtp(ATP_RXN_EXO, 0, atpD * amt);
  }
}

// Standing transporters across the cell's OUTER membrane (cell<->world).
// A transporter is the existing enzyme machinery: catalystCols[slot]
// (built by SYNTH CAT param=slot) facilitates movement of one chem
// across the membrane, MM-saturated on the source side and scaled by
// the catalyst pool + cell surface -- the same kinetic shape as
// metabolism, just cross-compartment. v1 is facilitated (down-gradient,
// no ATP); the Reaction.atpDelta hook is reserved for future active
// pumping. Mass-exact (chem moves 1:1 between the cell pool and the
// region ambient field, which is in the mass ledger -- same surface
// diffuseAmbient uses) and deterministic (no simRng). The vacuolar
// (host<->organelle) membrane is wired in a following sub-commit.
export function runTransportReactions(c: Creature, world: World, dt: number): void {
  const s = c.store; const i = c.idx;
  const cols = s.chemCols;
  const cats = s.catalystCols;
  const ambient = world.ambient;
  const ab = ambientBaseAt(world, s.x[i], s.y[i]);
  const surface = s.r[i] / MIN_CREATURE_R;
  for (let n = 0; n < TRANSPORT_TARGETS.length; n++) {
    const k = TRANSPORT_TARGETS[n];
    // ATP translocase (ANT) is inner-membrane only: there is no
    // ambient ATP, so it does not act at the cell<->world membrane.
    if (k === TRANSPORT_ATP) continue;
    const slot = TRANSPORT_SLOT_BASE + n;
    const pool = cats[slot][i];
    if (pool <= 0) continue; // no transporter protein -> no facilitated flux
    const ak = ab + k;
    const inside = cols[k][i];
    const outside = ambient[ak];
    const gap = outside - inside; // >0 net import, <0 net export
    if (gap === 0) continue;
    // MM-saturate on the SOURCE concentration so a carrier saturates
    // like a real transporter instead of growing unbounded with the
    // gradient.
    const src = gap > 0 ? outside : inside;
    const sat = src / (src + KM_DEFAULT);
    let flow = REACTIONS[slot].vmax * (pool / CAT_REF) * surface * sat * gap * dt;
    // Strict mass conservation: never move more than the source holds.
    if (flow > 0) { if (flow > outside) flow = outside; }
    else { if (-flow > inside) flow = -inside; }
    if (flow === 0) continue;
    cols[k][i] += flow;
    ambient[ak] -= flow;
  }
}

// Generic reaction runner for paths outside the REACTIONS table -- the
// engine itself inlines the same logic for perf, but for one-off
// reactions where the product lives somewhere other than chemCols
// (catalystCols, or a future "atmosphere", etc.) this shares the
// substrate gate + MM saturation + ATP/ADP bookkeeping so we don't
// drift from the engine's math. Caller's writeProduct(amt) sees the
// final reaction extent and handles wherever the product belongs.
export function runSyntheticReaction(
  c: Creature, dt: number,
  sChem: ArrayLike<number>, sCount: ArrayLike<number>,
  atpDelta: number, vmax: number, atpFloor: boolean,
  writeProduct: (amt: number) => void,
): void {
  const s = c.store; const i = c.idx;
  const KM = KM_DEFAULT;
  let limit = Infinity;
  let satProduct = 1;
  for (let j = 0; j < sChem.length; j++) {
    const have = s.chemCols[sChem[j]][i];
    const need = sCount[j];
    const ratio = have / need;
    if (ratio < limit) limit = ratio;
    satProduct *= ratio / (ratio + KM);
  }
  if (limit <= 0) return;
  if (atpDelta < 0) {
    const floor = atpFloor ? BIOSYNTH_ATP_FLOOR : 0;
    const eAvail = (s.energy[i] - floor) / -atpDelta;
    if (eAvail <= 0) return;
    if (eAvail < limit) limit = eAvail;
    satProduct *= eAvail / (eAvail + KM);
  } else if (atpDelta > 0) {
    const adpAvail = s.chemCols[CHEM_ADP][i] / atpDelta;
    if (adpAvail <= 0) return;
    if (adpAvail < limit) limit = adpAvail;
    satProduct *= adpAvail / (adpAvail + KM);
  }
  const rate = vmax * satProduct;
  let amt = rate * dt;
  if (amt > limit) amt = limit;
  if (amt <= 0) return;
  for (let j = 0; j < sChem.length; j++) {
    s.chemCols[sChem[j]][i] -= sCount[j] * amt;
  }
  if (atpDelta !== 0) {
    s.energy[i] += atpDelta * amt;
    s.chemCols[CHEM_ADP][i] -= atpDelta * amt;
  }
  writeProduct(amt);
}

// Catalyst synthesis. Catalysts live in catalystCols[slot] rather
// than in chemCols, so this can't be a REACTIONS-table entry; but
// the substrate / ATP / saturation math is the same as every biosynth
// reaction, so we delegate to runSyntheticReaction. Substrate fixed
// at 0.5 aa + 0.5 min (same as enzymes / chlorophyll / mRNA).
const CAT_SUBSTRATE_CHEM = new Uint8Array([3, 5]); // aa, min in chemCols
const CAT_SUBSTRATE_COUNT = new Float32Array([0.5, 0.5]);
export function biosynthCatalyst(
  c: Creature,
  dt: number,
  vmax: number,
  atpCost: number,
  slot: number,
): void {
  const col = c.store.catalystCols[slot];
  const i = c.idx;
  runSyntheticReaction(
    c, dt, CAT_SUBSTRATE_CHEM, CAT_SUBSTRATE_COUNT,
    -atpCost, vmax, /* atpFloor */ true,
    (amt) => {
      col[i] += amt;
      recordRxn(RX_SYNTH_CATALYST, RX_LOC_CELL, 0);
      recordAtp(ATP_RXN_ENDO, atpCost * amt, 0);
    },
  );
}
// Dual of biosynthCatalyst: same substrate (AA+MIN) and ATP cost,
// but the synthesized pool LIVES in inhibitorCols and DAMPENS its
// target slot's effective rate. Recorded under the same RX as
// catalyst maintenance/synth since the bookkeeping shape is
// identical (mass-conserving recycle through aaMin on decay).
export function biosynthInhibitor(
  c: Creature,
  dt: number,
  vmax: number,
  atpCost: number,
  slot: number,
): void {
  const col = c.store.inhibitorCols[slot];
  const i = c.idx;
  runSyntheticReaction(
    c, dt, CAT_SUBSTRATE_CHEM, CAT_SUBSTRATE_COUNT,
    -atpCost, vmax, true,
    (amt) => {
      col[i] += amt;
      recordRxn(RX_SYNTH_CATALYST, RX_LOC_CELL, 0);
      recordAtp(ATP_RXN_ENDO, atpCost * amt, 0);
    },
  );
}

// Rate-law constants other modules need (the staying inner/vacuolar
// transport applier in sim.ts reads these).
export { KM_DEFAULT, CAT_REF };
