# Project directions

Permanent guidance for working in this repo. Read before making
changes.

## Design philosophy (non-negotiable)

This sim is a **substrate, not a script**. Provide only the basic
environment and primitive tools; never hand-code organelles,
multicellularity, signaling, specialization, or any
metabolic/behavioral strategy. Those must be *emergent outcomes* of
selection over the genome, not engine rules that assume them. When
adding a mechanism the test is "does this open a door?", never "does
this make X happen?". See `README.md` → Design philosophy and
`COLONY_GAPS.md` for known places the engine still forces what should
be evolvable.

## Engineering standards

- **File size.** Files over ~1000 lines are discouraged (not banned).
  Prefer cohesive, single-responsibility modules. If a file grows past
  ~1kloc, that is a signal to split along a real seam, not to keep
  appending. New functionality should land in an appropriately scoped
  module, not be bolted onto an existing monolith.
- **Module boundaries.** Group by domain responsibility (chemistry,
  reactions, regions/ambient, particles, creatures/VM integration,
  world/step/snapshot, rendering/UI). Keep cross-module coupling
  explicit via imports; avoid grab-bag "utils" dumping grounds.
  Watch for import cycles.
- **Modern TS practices.** Strict typing (no implicit `any`), narrow
  exports (export what's used, not everything), pure functions where
  practical, no dead code or backwards-compat shims, comments explain
  *why* not *what*.
- **Behavior-preserving refactors.** Refactoring must not change
  simulation behavior. The guardrails are the test suite — especially
  **determinism** (`src/__tests__/determinism.test.ts`: same seed →
  byte-identical) and the **mass-conservation invariant**
  (`sim.test.ts`: "total mass is preserved across many ticks"). Both
  must stay green after every refactor step. Preserve module
  top-level execution order and RNG draw order (the reaction/chemistry
  tables build from fixed seeds at import time; the world RNG draws at
  runtime — moving code must not reorder either).
- **Validate every step.** `npx tsc --noEmit`, `npx vitest run`, and
  `npx vite build` must all pass before a commit. Refactor in small,
  individually-green commits, not one big-bang change.
- **No semantic drift between code and its dependents.** When you
  change an op's semantics, a chemistry rule, or any other interface
  cells consume, you MUST in the same change-set:
    1. Update every consumer in `src/` (archetypes, founder builder,
       VM viability checks, summary/disasm helpers, tests).
    2. Update every doc that names the changed thing
       (`GENOME_ARCHETYPES.md`, `CHEM_IO_REFERENCE.md`,
       `OP_REDESIGN_PLAN.md`, `README.md`, `CLAUDE.md`, plus any
       `*_PLAN.md` whose claims you've invalidated).
    3. Delete the dead surface entirely -- no inert enum members,
       no no-op switch cases "kept for mutation-byte stability", no
       stale comments that mislead the next reader. If determinism /
       save-schema implications block deletion, do the deletion +
       schema bump anyway and document the migration.
  A migration "Phase N" commit that retires a mechanism without
  also retiring its references is incomplete and must not be merged.
  This rule is permanent and applies even when the inert surface
  "still compiles." Compiles is not enough; the catalogue of dead
  references is the bug.

## Workflow

- Develop on the branch in use for the session; commit in small,
  descriptive units; push without opening PRs unless asked.
- Save-state compatibility is a convenience, not a requirement — do
  what is right for the model; bump `SAVE_SCHEMA` when structure
  changes.
- Throwaway probe scripts (`scripts/probe_*.ts`) are not part of the
  shipped surface; keep `scripts/headless.ts`.
