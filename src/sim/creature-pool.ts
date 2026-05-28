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

import type { Creature } from "./core";
import { runGenericReactions } from "./cell-reactions";

// The dispatcher takes the slice of live cells, the per-tick dtT, and
// ambient light. Returns a barrier closure -- await it before reading
// any column the workers wrote.
export type CreatureChemistryDispatcher = (
  cells: Creature[], dtT: number, ambientLight: number,
) => () => void;

let creatureChemistryDispatcher: CreatureChemistryDispatcher | null = null;
export function setCreatureChemistryDispatcher(d: CreatureChemistryDispatcher | null): void {
  creatureChemistryDispatcher = d;
}
export function getCreatureChemistryDispatcher(): CreatureChemistryDispatcher | null {
  return creatureChemistryDispatcher;
}

// Per-slice executor the subworker calls on [start, end). Each cell
// only touches its own SAB columns, so different workers can't race.
export function applyCreatureChemistryRange(
  cells: Creature[], start: number, end: number,
  dtT: number, ambientLight: number,
): void {
  for (let k = start; k < end; k++) {
    const c = cells[k];
    if (!c) continue;
    runGenericReactions(c, dtT, ambientLight);
  }
}
