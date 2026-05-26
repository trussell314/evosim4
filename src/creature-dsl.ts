// Higher-level creature DSL: a declarative `CreatureSpec` compiled to
// genome bytes, one level above the raw assembler (`genome-asm`). Lets a
// cell be authored by *describing* it -- trophic mode, senses, tropisms,
// signalling, life-history -- instead of hand-writing op tuples. Backs
// the in-app cell-builder dialog and is reusable by scenarios/tests.
//
// Substrate stance unchanged: a compiled genome is a SEED, not an engine
// rule. The spawned cell gets no special treatment; selection keeps or
// discards it. The compiler is pure + RNG-free (deterministic), importing
// no engine state, so it has zero determinism impact.

import { asm, assertWellFormed, type Instr } from "./genome-asm";
import {
  RX_SLOT_PHOTOSYNTH,
  RX_SLOT_SYNTH_AA,
  RX_SLOT_SYNTH_ENZ,
  RX_SLOT_DIGEST_BIOP,
  RX_SLOT_SYNTH_BOND,
  RX_SLOT_SYNTH_REPAIR,
  RX_SLOT_SYNTH_PHOTO_V,
  RX_SLOT_SYNTH_ELECTRO,
  RX_SLOT_SYNTH_VIBRO,
  RX_SLOT_SYNTH_PHRECEPTOR,
  RX_SLOT_SYNTH_MECH,
  RX_SLOT_SYNTH_THERMO,
  RX_SLOT_SYNTH_MAGNETO,
} from "./sim/reactions";
import { CHEMOLITH_ENERGY_SLOT, CHEMOLITH_CARBON_SLOT } from "./sim/chemolith";
import {
  CHEM_BIOPOLYMER, CHEM_WASTE, CHEM_GLU,
  CHEM_ACT_LIGHT_X, CHEM_ACT_LIGHT_Y,
  CHEM_ACT_ELECTRO_X, CHEM_ACT_ELECTRO_Y,
  CHEM_ACT_VIB_X, CHEM_ACT_VIB_Y,
  CHEM_ACT_MAG_X, CHEM_ACT_MAG_Y,
  CHEM_ACT_MECH_X, CHEM_ACT_MECH_Y,
} from "./sim/chem-ids";

// ---- spec ---------------------------------------------------------------

export type TrophicMode = "photoautotroph" | "heterotroph" | "chemolithoautotroph";

// Senses with a 2D bearing (X/Y activated chems) support a tropism; the
// scalar senses (pH, thermal) only gate, so they are offered as senses but
// drive no THRUST here.
export type VectorSense = "light" | "electric" | "vibration" | "magnetic" | "mechanical";
export type ScalarSense = "ph" | "thermal";
export type SenseChannel = VectorSense | ScalarSense;
export type EmitChannel = "electric" | "light" | "vibration" | "magnetic";

export interface SenseSpec {
  channel: SenseChannel;
  // For vector senses: swim toward ("seek") or away from ("flee") the
  // bearing. Ignored for scalar senses. Default "seek".
  response?: "seek" | "flee";
}

export interface CreatureSpec {
  // Short label for the spawn button / archetype list.
  name: string;
  trophic: TrophicMode;
  // 0-3 senses; each builds the matching receptor and (for vector senses)
  // a tropism toward/away its bearing.
  senses?: SenseSpec[];
  // Particle-gradient foraging.
  seekFood?: boolean;     // climb the detritus (biopolymer) gradient + INGEST
  fleeWaste?: boolean;    // flee the waste gradient (avoid toxins / dead zones)
  // Predation: strike contacted prey (needs to out-size the target).
  predator?: boolean;
  // Active emission: spend ATP to broadcast on each listed channel.
  emit?: EmitChannel[];
  // Greenbeard adhesion: when set (0-255), build CHEM_BOND + tag clones so
  // kin stick together.
  bondTag?: number;
  // Shed surplus glucose to the medium once structurally healthy (leaky
  // sharing / mutualism seed).
  leakGlucose?: boolean;
  // Build the heat-shock / repair chaperone (acid + heat tolerance).
  stressTolerant?: boolean;
  // Membrane reserve a cell must reach before it divides (default 40).
  reproduceAt?: number;
  // THRUST gain applied to every tropism (default 25).
  thrustGain?: number;
}

// ---- helpers (small, local; the genome-archetypes kits are private) -----

const DEFAULT_GAIN = 25;
const INGEST_DETRITUS = 1; // bond-energy threshold byte -> eats detritus

// Frame a prog as a single explicit gene with intron margins (mirrors
// genome-archetypes.frameProg; replicated to avoid a module dependency).
function frame(prog: Instr[]): Instr[] {
  return [["NOP"], ["NOP"], ["GENE"], ...prog, ["END"], ["NOP"], ["NOP"]];
}

// THRUST pops ay then ax, so push x-component then y-component.
function climbVec(xChem: number, yChem: number, gain: number, flee: boolean): Instr[] {
  const sign: Instr[] = flee ? [["NEG"]] : [];
  return [
    ["SENSE_CHEMICAL", xChem], ["PUSH8", gain], ["MUL"], ...sign,
    ["SENSE_CHEMICAL", yChem], ["PUSH8", gain], ["MUL"], ...sign,
    ["THRUST"],
  ];
}

function climbParticle(chem: number, gain: number, flee: boolean): Instr[] {
  const sign: Instr[] = flee ? [["NEG"]] : [];
  return [
    ["SENSE_OUT", chem],            // [gx, gy]
    ["PUSH8", gain], ["MUL"], ...sign, // [gx, gy*g(±)]
    ["SWAP"],                       // [gy*, gx]
    ["PUSH8", gain], ["MUL"], ...sign, // [gy*, gx*]
    ["SWAP"],                       // [gx*, gy*]
    ["THRUST"],
  ];
}

const VECTOR_SENSE: Record<VectorSense, { synth: number; x: number; y: number }> = {
  light:      { synth: RX_SLOT_SYNTH_PHOTO_V,  x: CHEM_ACT_LIGHT_X,   y: CHEM_ACT_LIGHT_Y },
  electric:   { synth: RX_SLOT_SYNTH_ELECTRO,  x: CHEM_ACT_ELECTRO_X, y: CHEM_ACT_ELECTRO_Y },
  vibration:  { synth: RX_SLOT_SYNTH_VIBRO,    x: CHEM_ACT_VIB_X,     y: CHEM_ACT_VIB_Y },
  magnetic:   { synth: RX_SLOT_SYNTH_MAGNETO,  x: CHEM_ACT_MAG_X,     y: CHEM_ACT_MAG_Y },
  mechanical: { synth: RX_SLOT_SYNTH_MECH,     x: CHEM_ACT_MECH_X,    y: CHEM_ACT_MECH_Y },
};
const SCALAR_SENSE_SYNTH: Record<ScalarSense, number> = {
  ph:      RX_SLOT_SYNTH_PHRECEPTOR,
  thermal: RX_SLOT_SYNTH_THERMO,
};
const EMIT_OPERAND: Record<EmitChannel, number> = {
  electric: 0, light: 1, vibration: 2, magnetic: 3,
};

function metabolismKit(trophic: TrophicMode): Instr[] {
  switch (trophic) {
    case "photoautotroph":
      return [["SYNTH", "CAT", RX_SLOT_PHOTOSYNTH], ["SYNTH", "CAT", RX_SLOT_SYNTH_AA]];
    case "heterotroph":
      return [["SYNTH", "CAT", RX_SLOT_SYNTH_ENZ], ["SYNTH", "CAT", RX_SLOT_DIGEST_BIOP]];
    case "chemolithoautotroph":
      return [["SYNTH", "CAT", CHEMOLITH_ENERGY_SLOT], ["SYNTH", "CAT", CHEMOLITH_CARBON_SLOT]];
  }
}

// ---- compiler -----------------------------------------------------------

export function specToProg(spec: CreatureSpec): Instr[] {
  const prog: Instr[] = [];
  const gain = spec.thrustGain ?? DEFAULT_GAIN;

  // 1. Cohesion (greenbeard) -- first so the tag is set every tick.
  if (spec.bondTag !== undefined) {
    prog.push(["SYNTH", "CAT", RX_SLOT_SYNTH_BOND]);
    prog.push(["SYNTH", "BOND", spec.bondTag & 0xff]);
  }
  // 2. Metabolism identity.
  prog.push(...metabolismKit(spec.trophic));
  // 3. Stress tolerance (heat-shock / repair chaperone).
  if (spec.stressTolerant) prog.push(["SYNTH", "CAT", RX_SLOT_SYNTH_REPAIR]);

  // 4. Senses: build each receptor; vector senses add a tropism.
  const senses = (spec.senses ?? []).slice(0, 3);
  for (const s of senses) {
    if (s.channel in VECTOR_SENSE) {
      const v = VECTOR_SENSE[s.channel as VectorSense];
      prog.push(["SYNTH", "CAT", v.synth]);
      prog.push(...climbVec(v.x, v.y, gain, s.response === "flee"));
    } else {
      prog.push(["SYNTH", "CAT", SCALAR_SENSE_SYNTH[s.channel as ScalarSense]]);
    }
  }

  // 5. Foraging tropisms.
  if (spec.seekFood) prog.push(...climbParticle(CHEM_BIOPOLYMER, gain, false));
  if (spec.fleeWaste) prog.push(...climbParticle(CHEM_WASTE, gain, true));

  // 6. Active emission (spend ATP to broadcast).
  for (const ch of spec.emit ?? []) {
    prog.push(["PUSH8", 20]); // emit magnitude (ATP-costed by the engine)
    prog.push(["EMIT", EMIT_OPERAND[ch]]);
  }

  // 7. Ingest / predate.
  if (spec.seekFood || spec.predator) {
    prog.push(["PUSH8", INGEST_DETRITUS], ["INGEST"]);
  }
  if (spec.predator) prog.push(["PREDATE"]);

  // 8. Leaky glucose sharing (only when structurally healthy).
  if (spec.leakGlucose) {
    prog.push(["SELF_MEMBRANE"], ["PUSH8", 3], ["GT"], ["JZ", "noLeak"]);
    prog.push(["PUSH8", 4], ["EXCRETE", CHEM_GLU]);
    prog.push(["LABEL", "noLeak"]);
  }

  // 9. Life history: divide on structural reserve.
  const thresh = spec.reproduceAt ?? 40;
  prog.push(
    ["SELF_MEMBRANE"], ["PUSH8", thresh], ["GT"], ["JZ", "noRepro"],
    ["REPRODUCE"], ["LABEL", "noRepro"],
  );
  return prog;
}

export interface CompiledCreature {
  name: string;
  genome: Uint8Array;
}

// Compile a spec to a validated genome. Throws (via assertWellFormed) if
// the assembled bytes are malformed -- so a bad spec fails loudly at build
// time rather than spawning a broken cell.
export function compileCreature(spec: CreatureSpec): CompiledCreature {
  const genome = asm(frame(specToProg(spec)));
  assertWellFormed(genome);
  return { name: spec.name.slice(0, 40) || "custom", genome };
}
