// Parallel-creature-chemistry pool: dispatcher contract + per-slice
// worker entry point. Modeled on collision.ts's setCollisionPhaseDispatcher
// pattern -- sim.ts's updateCreatures asks the live dispatcher (null when
// not pooled) to dispatch a chemistry phase over a slice of cells; the
// dispatcher returns a barrier closure the caller awaits.
//
// What runs inside a worker slice:
//   - runGenericReactions on each cell  (per-cell chem cols, SAB)
//
// Strict per-cell writes only. Activation, transport (writes
// world.ambient), engulf/predate/ingest, division all stay on the
// sim worker. Biosynth + maintenance + toxify can land in a follow-up.


// SAB-backed scratch the pool exposes. The caller (updateCreatures)
// writes:
//   idxs[k]        = world.creatures[k].idx (CreatureStore slot)
//   scratch[k*2]   = dtT for that cell
//   scratch[k*2+1] = ambientLight for that cell
// for k in [0, n) BEFORE calling the dispatcher with n.
let creatureChemBuffers: { idxs: Int32Array; scratch: Float32Array } | null = null;
export function setCreatureChemBuffers(b: { idxs: Int32Array; scratch: Float32Array } | null): void {
  creatureChemBuffers = b;
}
export function getCreatureChemBuffers(): { idxs: Int32Array; scratch: Float32Array } | null {
  return creatureChemBuffers;
}

// Returns a barrier closure -- await it before reading any column the
// workers wrote (chemCols, catalystCols, inhibitorCols of cells in the
// idxs[0..n) slice).
export type CreatureChemistryDispatcher = (n: number) => () => void;

let creatureChemistryDispatcher: CreatureChemistryDispatcher | null = null;
export function setCreatureChemistryDispatcher(d: CreatureChemistryDispatcher | null): void {
  creatureChemistryDispatcher = d;
}
export function getCreatureChemistryDispatcher(): CreatureChemistryDispatcher | null {
  return creatureChemistryDispatcher;
}

