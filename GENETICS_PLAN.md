# Genetics plan — multiple genomes (chromosomes), sexual reproduction, plasmid HGT

The unifying idea: stop treating a cell as having **one flat genome**, and instead
give it a **set of genetic elements**. Two kinds:

- **Chromosomes** — the essential, vertically-inherited genome. Carrying ≥2
  homologous copies = **diploidy/polyploidy** → dominance/recessivity, and
  masking of recessive deleterious mutations.
- **Plasmids** — small, non-essential, independently-replicating elements that
  can be transferred **horizontally** (conjugation) between cells.

This one abstraction delivers all three asks at once:
- **Multiple genomes / chromosomes** = the element set with ploidy ≥ 1.
- **Sexual reproduction** = meiosis (recombine homologous chromosomes → haploid
  gamete) + syngamy (two gametes fuse → diploid offspring).
- **Plasmid exchange** = a plasmid is just a transferable element; conjugation
  copies it to a contacting partner.

It's design-philosophy clean: the substrate provides the *elements* and the
*mechanisms* (expression, meiosis, conjugation); **selection decides** ploidy,
whether to reproduce sexually, and whether to carry plasmids. Nothing forces a
strategy.

---

## 1. Why (motivation)

- **Mutation robustness.** Diploidy masks recessive knockouts — a broken gene on
  one chromosome is covered by the working homolog. This directly attacks the
  fragility we hit earlier (fission dilution / "bum cells" / lineages dying to a
  single bad mutation). A diploid lineage is far more forgiving.
- **Faster adaptation.** Recombination (sex) reshuffles alleles, decoupling good
  mutations from bad and accelerating selection.
- **Horizontal spread.** Plasmids let a beneficial gene (a useful catalyst,
  toxin resistance, heat-shock chaperone) sweep a population faster than vertical
  descent — and across lineages.
- All **emergent**: ploidy, sex, and plasmid-carrying are evolvable traits with
  costs and benefits, not engine rules.

---

## 2. What already exists (build on, don't reinvent)

- **Recombination:** `crossoverGenomes(a, b)` (`src/sim.ts`) and the bonded-
  crossover path in `tryReproduce` — *a reproducing cell with a bond partner
  already produces a single-crossover recombinant child.* That's the genetic
  core of meiosis, haploid-style; diploidy + true meiosis/syngamy extend it.
- **Horizontal transfer (transformation):** `SYNTH PACKAGE` sheds genome
  fragments as eDNA carriers; `SYNTH COMPETENCE` takes them up (`eDnaBuffer`,
  `eDnaCarriers`, `eDnaUptakePass`, `GENE_FRAGMENT_CAP=32`, splice ops). Plasmid
  conjugation reuses this payload machinery + the **bond** system for contact.
- **VM scratch/state:** 16 persistent registers (`LOAD`/`STORE`) and per-chem
  signaling — useful if homologous chromosomes need to regulate each other.
- **Genome identity/util:** `genomeCodingKey`, `genomeKey`, `genomeColor`,
  `genomeDistance` (`src/genome-id.ts`), `mutateGenome`, `somaticMutateOnce`,
  `makeRandomViableGenome` (`src/genome.ts`). All currently assume one flat
  `Uint8Array` — these are the main refactor surface.

---

## 3. Core data model

```ts
const enum ElementKind { CHROMOSOME, PLASMID }
interface GenomeElement { kind: ElementKind; bytes: Uint8Array; /* + origin/copy tag? */ }
// Creature.genome: Uint8Array   ->   Creature.genomes: GenomeElement[]
```

- **Ploidy** = number of CHROMOSOME elements (1 = haploid, 2 = diploid, …).
- **Plasmids** = 0+ PLASMID elements.
- **Back-compat:** today's single genome ≡ `[{ CHROMOSOME, bytes }]` (ploidy 1,
  no plasmids). The whole Phase 0 refactor must keep that case **byte-identical**.

---

## 4. The central design decision: how multiple elements are EXPRESSED

Each tick, run the VM over **all** elements and **combine** their outputs. The
combine rule *is* the genetics, so it's the key call. Recommendation:

- **Catalyst/inhibitor synthesis, excrete, transport (continuous outputs):**
  **additive / union** across elements. A working allele on *either* homolog
  expresses the catalyst → recessive knockouts are masked (the robustness win).
  Co-dominant by default; mutation can tune relative strength.
- **Discrete action ops (`REPRODUCE`, `ENGULF`, `PREDATE`, `THRUST`, …):**
  **OR / max** — if any element fires it, it fires. A working copy rescues a
  broken one. (Some, like `THRUST`/`TURN`, may prefer averaging — decide per-op.)
- **Cost (so ploidy isn't free):** the per-tick VM instruction budget and its ATP
  cost scale with the number of elements expressed (shared budget split across
  elements, or N× cost). Carrying more genome costs more to run + replicate →
  selection prices ploidy and plasmid load. This is what keeps the feature a
  *trade-off*, not a strict upgrade.

**Critical invariant:** with exactly one chromosome and no plasmids, expression
must be **identical to today** (additive/OR of a single element = the element).
That keeps the carefully-tuned single-genome balance intact and lets us
introduce multi-element behavior gradually, behind founder prevalence.

---

## 5. Reproduction

- **Asexual (mitosis):** copy *all* elements to the daughter, each mutated
  independently. Diploid → diploid; plasmids segregate/copy (see §6).
- **Sexual (meiosis + syngamy):**
  - **Meiosis:** recombine homologous chromosomes (`crossoverGenomes`, already
    present) → a **haploid gamete** (one chromosome set).
  - **Syngamy:** two gametes (from two parents) **fuse** → a diploid offspring.
  - **Mating channel:** start by extending the existing **bonded-crossover** path
    (parent + bond partner already recombine at fission); evolve toward explicit
    gametes (release/fuse on bonded contact) if we want free-swimming gametes.
- **Plasmid inheritance:** copied to daughters with a **segregation/loss
  probability** (so plasmids can be lost, creating selection to keep useful ones).

---

## 6. Plasmid exchange (conjugation)

- **Element:** a PLASMID is small, replicates independently of the chromosome(s),
  is expressed like a chromosome (additive/OR), but is **non-essential** and
  carries a small **carriage cost**.
- **Transfer:** a `CONJUGATE` op (or a 6th `SYNTH_KIND`) copies one plasmid into a
  **bonded/contacting** partner — donor needs the gene, gated on contact + ATP.
  Reuse the eDNA payload buffer + the bond system.
- **Dynamics to expect:** a plasmid carrying a beneficial catalyst spreads
  horizontally faster than descent; useless plasmids are shed via the loss
  probability + carriage cost. Founders rarely seed a plasmid (mirroring the
  current rare `COMPETENCE`/`PACKAGE` prevalence).

---

## 7. Phasing (incremental — each phase shippable + all tests green)

The genome touches *everything*, so the plan is dominated by a behavior-
preserving refactor first, then additive features behind prevalence flags.

**Phase 0 — refactor `genome` → `genomes[]`, ZERO behavior change.** Internally
store `[{ CHROMOSOME, bytes }]`; expression/mutation/reproduction/identity all
behave exactly as today for the single-element case. Update every consumer
(§8). **Acceptance: golden byte-identical, determinism + mass green.** This is
the big, risky-surface step done safely (no semantics change).

**Phase 1 — multi-element expression + cost.** Allow >1 element; implement the
combine rule (§4) and the per-element budget/ATP cost. With one element it stays
identical (golden unchanged). Validate the combine semantics + recessive-masking
on **hand-constructed** diploid cells (unit tests) before any are spawned.

**Phase 2 — plasmids + conjugation.** Add the PLASMID kind, the `CONJUGATE` op,
inheritance with segregation/loss, and carriage cost. A small fraction of
founders seed a plasmid. Validate: a tagged plasmid spreads horizontally through
a bonded population.

**Phase 3 — diploidy + sexual reproduction.** A fraction of founders are diploid;
implement meiosis + syngamy + the mating channel. Validate: diploid lineages
tolerate knockouts that kill haploids (the robustness payoff), and recombination
shows up in descendants.

**Phase 4 — make ploidy itself evolvable + tune.** Mutations can duplicate a
chromosome (→ polyploidy) or lose one (→ haploid); plasmid copy-number drifts.
Observe what evolves; tune costs so haploid/diploid/sexual/asexual coexist as
genuine strategies rather than one dominating trivially.

Golden re-baselines at the end of each *behavior-changing* phase (1–4); Phase 0
must not move it.

**Every phase ships its affected UI surfaces and documentation in the same
change-set** (see §8). A phase isn't done until the inspector/HUD/overlays
reflect the new genome shape and the docs naming "the genome" are updated —
these are acceptance criteria, not later cleanup. Even Phase 0 (no behavior
change) must update the inspector/disassembly to render the element set and the
docs that describe the genome as a single array.

---

## 8. Consumer / semantic-drift checklist (per CLAUDE.md)

Changing the genome's shape means updating **every** dependent in the same
change-set:

- **Genome ops:** `mutateGenome`, `somaticMutateOnce`, `crossoverGenomes`
  (`genome.ts`/`sim.ts`) — operate per-element.
- **Identity:** `genomeCodingKey`, `genomeKey`, `genomeColor`, `genomeDistance`
  (`genome-id.ts`) — define over the element set (e.g., coding key = sorted set
  of per-element coding keys; color from the chromosome set).
- **VM:** `runTick` (`genome.ts`) + its caller in `updateCreatures` — express the
  element set + combine outputs + scale budget/ATP.
- **Founder builder:** `makeRandomViableGenome` — emits a `GenomeElement[]`
  (ploidy + optional plasmid by prevalence).
- **Archetypes:** `genome-archetypes.ts`.
- **Reproduction:** `tryReproduce` / `divideInner` (mitosis copy-all; sexual
  meiosis/syngamy).
- **Save/load:** `serializeWorld` / `applySavedWorld` (`SavedCreature.genome` →
  `genomes[]`); **bump `SAVE_SCHEMA`** + document migration (old saves load as
  ploidy-1).
- **Tests:** `determinism`, `golden`, `sim`, `genome-asm` — update fixtures;
  Phase 0 must keep golden byte-identical.

**UI surfaces (`src/main.ts`) — every genome-shape-dependent element.** These
are acceptance criteria for the phase that changes the underlying behavior, not
follow-ups:

- **HUD stats line** (`hudStats`, currently
  `pop/engulfed … species/engulfed … lineages/extinct … parts`): add genetics
  readouts as features land — **ploidy distribution** (haploid/diploid/poly),
  **plasmid prevalence**, **sexual-vs-asexual birth counts**, **conjugation
  events/min**.
- **Inspector** (`inspector` pre + `inspectorProse` + `inspectorMeters` + the
  disasm bar in the Inspector tab): render the selected cell as its **element
  set** — per-element disassembly (each chromosome + plasmid labeled), ploidy +
  plasmid count, and (Phase 1+) which alleles are **expressed vs masked** under
  the combine rule. `describeGenomeProse` summarizes the multi-element genome;
  `cellHealth` / `reproduceReadiness` evaluate over the set (a diploid's
  reproduce gate may be satisfied on either homolog).
- **Field overlays** (`HeatmapMode` + `drawHeatmap` + the overlay `<select>`):
  add optional modes — **ploidy**, **heterozygosity**, **plasmid presence** —
  each with a render branch + legend, mirroring the existing temp/light/health
  overlays.
- **Cell rendering / coloring:** `genomeColor` computed over the element set;
  consider a visual marker (ring/badge) distinguishing **diploid** and
  **plasmid-carrying** cells so the new genetics is visible at a glance.
- **Spawn / archetype UI** (`ARCHETYPES`, inject/clump spawn): if cells are
  user-spawnable, expose **ploidy / plasmid** options (or default sensibly so the
  control still works).
- **Other `main.ts` genome consumers:** `disassemble`, `walkGenome`,
  `genomeCodingKey` usages — operate per element.

**Docs — update every doc that names "the genome" or describes the genetics
model, in the same change-set (CLAUDE.md no-drift rule):**

- `README.md` (design philosophy + how the genome is described), `CLAUDE.md`
  (engineering-standards/determinism text that references the genome),
  `GENOME_ARCHETYPES.md`, `CHEM_IO_REFERENCE.md`, `OP_REDESIGN_PLAN.md`,
  `MUTATION_FIDELITY_PLAN.md`, `REGION_SYSTEM_PLAN.md` — anything still
  describing a single flat `Uint8Array` genome.
- This `GENETICS_PLAN.md` — tick off phases as they land.
- **Add a genetics reference** (new `GENETICS_REFERENCE.md`, or a section in an
  existing doc) covering: the element model (chromosomes + plasmids), the
  expression/combine + dominance rule, meiosis/syngamy, conjugation, the new ops
  (e.g. `CONJUGATE`), and the **`SAVE_SCHEMA` migration** (old saves load as
  ploidy-1, no plasmids).
- Any **new op/sensor** is documented in `CHEM_IO_REFERENCE.md` and named in the
  disassembler + `describeGenomeProse`.

Delete dead surface (no inert single-genome shims kept "for compatibility");
bump the schema and migrate instead.

---

## 9. Open decisions

- **Combine rule** (§4): additive vs explicit dominance flags; per-op behavior
  for discrete actions. *The make-or-break call — prototype it first.*
- **Ploidy cost:** how steeply the budget/ATP scales per element.
- **Mating mechanism:** extend bonded-crossover vs explicit free gametes.
- **Plasmid replication control:** copy number, incompatibility groups, loss rate.
- **How ploidy mutates:** chromosome duplication/loss rates; cap on ploidy.
- **Coding-key/species identity** under multiple elements (how diploids cluster
  into species; how the founder gate's distinct-coding-genome count behaves).
- **Determinism:** every new RNG draw (meiosis crossover points, plasmid loss,
  conjugation target) must preserve draw order (CLAUDE.md determinism rule).

---

## 10. Risks

- **Refactor blast radius** — `genome` is referenced everywhere. Mitigated by
  Phase 0 (behavior-preserving) landing as its own green commit before any
  semantics change.
- **Balance disruption** — multi-element expression could upset the tuned
  single-genome economy. Mitigated by the "1 element = identical" invariant and
  introducing ploidy/plasmids behind low founder prevalence, ramping via tuning.
- **Performance** — expressing N elements is N× VM cost per cell; with large
  endosymbiont populations that compounds. Cap ploidy, price it, and re-profile.
- **Golden churn** — expected at each behavior-changing phase; keep phases small
  and individually green.

---

## 11. Suggested entry point

Start with **Phase 0** as a standalone PR/commit series: introduce
`GenomeElement[]` and route every consumer through it while asserting **golden
byte-identical**. That single step is most of the risk; everything after is
additive features guarded by the "one element behaves like today" invariant.
Then prototype the **combine rule** (§4) on hand-built diploids before spawning
any — it's the decision the rest hinges on.
