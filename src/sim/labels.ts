// Presentational labels for chems / reactions (disassembler, HUD,
// genome describer). Pure: depends only on CHEMICAL_COUNT.

import { CHEMICAL_COUNT } from "./chem-ids";

// Pretty-print labels for the 6 SENSOR_CHEMS slots. Index matches
// SENSOR_CHEMS slot order.
export const SENSOR_CHEM_LABELS: ReadonlyArray<string> = [
  "min", "biop", "fa", "o2", "co2", "glu",
];

// Short HUD-friendly labels for every named chem id 0..44 -- the
// abbreviations the genome describer + inspector use to keep prose
// lines tight (distinct from the verbose Molecules-key CHEM_NAMES).
export const CHEM_SHORT_LABELS: ReadonlyArray<string> = [
  "o2", "co2", "glu", "aa", "fa", "min", "adp", "waste",
  "chl", "enz", "mrna", "biop", "memb",
  "photoR-V", "photoR-L", "photoR-S",
  "actPhoto-V", "actPhoto-L", "actPhoto-S",
  // ids 19-30: retired chemoreceptor band, REPURPOSED into the new senses
  // (electro/vibro/pH/light). id 22 + id 28 stay unused spares.
  "electroR", "vibroR", "phR", "chemoR-0",
  "actElec-x", "actElec-y",
  "actVib-x", "actVib-y",
  "actPh", "spare28",
  "actLight-x", "actLight-y",
  "mechR", "actMech-x", "actMech-y",
  "thermoR", "actThermo",
  "magR", "actMag-x", "actMag-y",
  "bond", "repair",
  "marker0", "marker1", "marker2", "marker3",
];
export function chemName(id: number): string {
  if (id < 0 || id >= CHEMICAL_COUNT) return `chem${id}`;
  return id < CHEM_SHORT_LABELS.length ? CHEM_SHORT_LABELS[id] : `chem${id}`;
}

// Short labels for the first NAMED_REACTION_COUNT reaction slots
// installed by installNamedReactions(). Index matches the slot;
// anything beyond is a procedural / generic reaction ("rxnN").
export const NAMED_REACTION_NAMES: ReadonlyArray<string> = [
  "aerobic", "ferment", "betaOx", "photosynth",
  "synthAA", "synthFA", "synthCHL", "synthENZ", "synthMRNA",
  "synthMEMB(aa+fa)", "digestBiop", "synthMEMB(fa)",
  "synthPhoto-V", "synthPhoto-L", "synthPhoto-S",
  "synthElectroR", "synthVibroR", "synthPhR", "synthChemo-0",
  "synthMech", "synthThermo", "synthMag",
  "synthBond", "synthRepair", "synthBiop",
  "lightRxn",
];
export function reactionName(slot: number): string {
  return slot < NAMED_REACTION_NAMES.length ? NAMED_REACTION_NAMES[slot] : `rxn${slot}`;
}
