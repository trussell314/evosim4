# Organelle biogenesis — where do new organelles come from?

Exploration doc. Answers a recurring question — *"can a cell create an
organelle, the way a cell spawns mitochondria?"* — by separating what
the engine does today, what nature actually does, and which substrate
doors (not scripts) would let organelle biogenesis emerge. Nothing here
is implemented unless it also appears in code.

Companion to `ENDOSYMBIOSIS_NOTES.md`, which covers the *interface*
(host↔organelle membrane control, the transporter primitive, and the
EGT/host-takeover mechanism). This doc is about *creation* — where new
organelles come from — and where the two questions converge.

---

## 1. The engine today: organelles are acquired, never built

There is **no de-novo organelle biogenesis**. A cell cannot fabricate
an organelle from its own material, and there is no op that does so
(the only SYNTH kinds are CAT / INH / BOND / COMPETENCE / PACKAGE —
`src/genome.ts:119`). Organelles enter and persist by exactly three
routes:

1. **Acquisition by engulfment — the only genome-reachable origin.**
   `ENGULF` (`0x55`) wraps a *separate, already-living* free cell, and
   it is **not digested**: it becomes an endosymbiont in the vacuole
   (`host.contents`), staying fully alive — its own VM, chemistry,
   maintenance, somatic drift, and internal division all run each tick
   (`src/sim.ts:6533`, comment at `:6551`). An organelle may itself
   engulf sibling organelles in the same host (`src/sim.ts:5005`).
2. **Fission of an existing organelle.** An inner cell that issues
   `REPRODUCE` divides via `divideInner` (`src/sim.ts:4721`), building
   a daughter from *its own* genome and mass — not from the host. The
   symbiont population grows by the symbiont reproducing.
3. **Inheritance at host division.** When a host carrying organelles
   divides, its `contents` are partitioned between mother and daughter
   (`src/sim.ts:7107`). A newborn host can already carry organelles.

`spawnCompositeInstance` (`src/sim.ts:3119`) *does* create a pre-made
host+symbiont pair, but it is **operator/seed scaffolding** — invoked
only from the worker spawn command (`src/sim.worker.ts:201`) and tests,
never from a cell's genome. It is not a biogenesis path.

So: **acquire by engulfment, then keep / divide / inherit.** No cell
makes an organelle from scratch.

---

## 2. How nature does it

Two things must be separated, because the engine already handles one.

**Origin (already modeled).** Mitochondria and chloroplasts began as
free-living bacteria that a host engulfed *and did not digest*
(~1.5–2 Gya). That is exactly `ENGULF`-without-digest + the inner cell
staying alive.

**Ongoing biogenesis — the key fact.** Cells never build a
mitochondrion (or chloroplast) de novo. New ones arise **only by growth
and fission of pre-existing organelles**, and a cell inherits its
starting set (maternally, in animals). "Omnis mitochondrion e
mitochondrion." The de-novo route does not exist in biology either —
the sim already mirrors this with `divideInner` + inheritance.
(Peroxisomes can form both by fission and de novo from the ER, but
those are *not* endosymbiotic organelles; the comparison here is to the
endosymbiont-derived ones.)

**What makes it an organelle rather than a permanent lodger** is
*integration*, and this is the part nature does that the sim does not:

- **Endosymbiotic gene transfer (EGT).** Most of the symbiont's genome
  migrated into the host nucleus. A human mitochondrion keeps ~37
  genes; the other ~1,500 of its proteins are host-encoded, made in the
  host cytosol, and **imported back in** (TOM/TIM translocases,
  N-terminal targeting tags). The organelle becomes genetically
  dependent on — and controlled by — the host.
- **Host-coordinated division.** Fission is driven partly by
  host-encoded machinery (dynamin/Drp1), timed to host demand.
- **Reciprocal metabolite exchange + loss of autonomy.** The symbiont
  reductively loses the genes for free living; the host feeds it and
  harvests its output. Obligate mutual dependence is the end state.

The EGT mechanism is "no-permission" and one-way-ratcheted; that arc is
analysed in detail in `ENDOSYMBIOSIS_NOTES.md` §5.

---

## 3. What the model needs — doors, not a script

Design rule (`CLAUDE.md`): never add a "make mitochondria" op or a
discrete "organelle" type. The endosymbiont→organelle slide must
*emerge* as a **continuum of dependence** under selection, not be
flagged. The sim already has the origin (engulf), the maintenance
(fission), the inheritance, and the metabolite channels (inner↔host
chem exchange + the ATP translocase). The ablation finding that today's
symbionts are **parasitic freeloaders** (hosts did *better* without
them) is the tell that the *integration* doors are not open yet.

Two doors are missing; both are substrate primitives, not outcomes:

1. **Living-symbiont gene transfer (the EGT door) — the load-bearing
   one.** Today genes move organelle→host only at *digestion*:
   `digestInnerIntoHost` sheds the dead symbiont's genome into the host
   eDNA buffer (`src/sim.ts:5166`), uptake-able via `COMPETENCE` /
   `eDnaUptakePass`. For real organellogenesis you want a low-rate
   transfer of a fragment from a *living* organelle's genome into the
   host's **heritable** genome, while the symbiont keeps living. This is
   where this question converges with the multi-genome work
   (`GENETICS_PLAN.md`): a transferred fragment lands naturally as a
   **host plasmid / chromosome element** (Phase 2 plasmids + HGT). Host
   expression of captured genes + reductive loss in the organelle
   (already possible via unguarded organelle somatic drift) then
   produce dependence — the actual mechanism, nothing hard-coded.
2. **Directed host→organelle provisioning.** EGT only pays off if the
   host can *feed* the symbiont the products of the genes it captured
   (real hosts import ~99% of mitochondrial proteins). Much of this may
   already be expressible via `TRANSPORT` against the host pool, but the
   open question (see `ENDOSYMBIOSIS_NOTES.md` §1, "the hard limit") is
   whether a host can preferentially provision a *specific* organelle
   rather than broadcast into one shared cytoplasm pool — i.e. the
   *addressed-delivery* / signature-gated transporter primitive.

Explicit non-goals (would be scripting the outcome):

- No "create organelle" / "differentiate into organelle" op.
- No discrete organelle entity type. An organelle is just an
  endosymbiont whose dependence (genome reduction + reliance on host
  provisioning) has risen — a measurable continuum, exactly as in life.
- No engine-side "this is now mutualistic" flag; mutualism vs.
  parasitism must remain an emergent, measurable property of net
  cross-membrane flux (see `ENDOSYMBIOSIS_NOTES.md` §4).

---

## 4. Summary

| Stage | Nature | Engine today | Gap |
| --- | --- | --- | --- |
| Origin | engulf a free-living cell, don't digest | `ENGULF` w/o digest | — (covered) |
| Maintenance | grow + fission existing organelles; inherit | `divideInner` + host-division partition | — (covered) |
| De-novo creation | does not happen | does not happen | — (correctly absent) |
| Integration | EGT + protein import + host-controlled division → obligate dependence | none (symbionts stay autonomous parasites) | **living-symbiont EGT + directed provisioning** |

The headline: organelle *creation* is already faithfully modeled
(acquire, divide, inherit — never de novo). What is missing is organelle
*integration* — the genetic + metabolic coupling that converts a
captured lodger into an obligate organelle — and the substrate-pure way
to open it is a living-symbiont EGT primitive (riding the plasmid/HGT
machinery the genetics plan already designs) plus a host-directed,
signature-addressable provisioning channel. Then *let* obligate
organelles emerge, or not.

_Status: notes only. Not scheduled, not implemented._
