// Reaction-accounting id space and ATP-ledger labels. Foundational and
// ownerless: referenced by the reaction engine, the regional/field
// passes, creature metabolism, and the rxn-stats (de)serializer. Kept
// in its own leaf module (depends only on genome's N_REACTIONS) so
// those domains can import it without forming a value-import cycle
// back through sim.ts.

import { N_REACTIONS } from "../genome";

// The 256-slot REACTIONS table occupies ids [0, N_REACTIONS). The
// non-table conversions get synthetic ids appended after it so the
// accounting ledger can count them uniformly.
export const RX_BASE = N_REACTIONS;
export const RX_MAINT_MEMBRANE = RX_BASE + 0;
export const RX_MAINT_ENZ = RX_BASE + 1;
export const RX_MAINT_CHL = RX_BASE + 2;
export const RX_MAINT_MRNA = RX_BASE + 3;
export const RX_MAINT_RECEPTOR = RX_BASE + 4;
export const RX_MAINT_CATALYST = RX_BASE + 5;
export const RX_TOXIFY = RX_BASE + 6;
export const RX_DEATH_CATDENATURE = RX_BASE + 7;
export const RX_DENATURE_WASTE = RX_BASE + 8;
export const RX_SYNTH_CATALYST = RX_BASE + 9;
// Founder biogenesis: a new cell's fixed seed (membrane/adp/mrna/glu/
// aa + its ATP) is matter. The world reserve is debited to pay for it
// (mass-conserving); only the uncovered remainder is a genuine
// external input -- recorded here so ATP/materials are never silently
// conjured.
export const RX_BIOGENESIS = RX_BASE + 10;
// Thermal denaturation: water hotter than the cell's tolerance ceiling
// breaks down membrane lipid (-> waste). Mirrors toxify, keyed on heat.
export const RX_THERMAL_DENATURE = RX_BASE + 11;
export const RX_SYNTH_COUNT = 12;
export const NREACT = N_REACTIONS + RX_SYNTH_COUNT;

// rxn buckets: [id][loc 0=cell 1=field][cat 0=uncat 1=catalyzed]
export const RX_LOC_CELL = 0;
export const RX_LOC_FIELD = 1;
export function rxIdx(id: number, loc: number, cat: number): number {
  return (id * 2 + loc) * 2 + cat;
}

// ATP ledger labels (consumed/produced amounts).
export const ATP_IDLE = 0;
export const ATP_VM = 1;
export const ATP_THRUST = 2;
export const ATP_EXCRETE = 3;
export const ATP_INGEST = 4;
export const ATP_ENGULF = 5;
export const ATP_PREDATE = 6;
export const ATP_REPRODUCE = 7;
export const ATP_RXN_ENDO = 8;
export const ATP_RXN_EXO = 9;
export const ATP_OTHER = 10;
export const ATP_LABEL_COUNT = 11;
