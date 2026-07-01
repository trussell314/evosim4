# Endosymbiosis / host↔organelle membrane notes

Exploration doc. Captures the conceptual analysis of the host↔organelle
relationship and the "transporter" question, for further iteration.
Nothing here is implemented unless it also appears in code.

> **RESOLVED (transporter-as-reaction substrate).** The "transporter
> question" (§3) and the control fork (§2) are now implemented as one
> substrate: a transporter is a SYNTH'd catalyst on a reaction slot,
> applied by a cross-compartment MM applier at *every* membrane the
> cell owns — outer (cell↔world) and vacuolar (host↔organelle, with
> both the organelle's and the host's catalysts acting). Model "C+"
> (both sides act, summed; facilitated v1, ATP/uphill hook reserved).
> See TODO.md "Standing transporters + dual/contested membrane (DONE)".
> The sections below are kept as the original design reasoning.

## 1. Current model (as implemented)

Every cell — free or engulfed — is a full cell: its own per-cell chem
pool, `runGenericReactions`, maintenance, VM, somatic drift, internal
division. A host is just a free cell that also carries `contents` (its
engulfed cells). The host↔organelle coupling is **one shared
cytoplasm pool**, reached through these channels:

- **Passive diffusion** (diffusable chems only): bidirectional,
  permeability-driven, *uncontrolled by either genome* — the exact
  analog of a free cell's membrane to the world dissolved field.
- **Active transport across the organelle's outer membrane**:
  organelle-initiated only. Its INGEST pulls opted chems from the host
  pool; its EXCRETE / autoExcrete (CO2/waste) push chems into the host
  pool. ATP-costed, cooldown-rate-limited.
- **Sibling engulf/predate**: an organelle may engulf/predate other
  organelles in the same host (canBreach + predationCost gates).
- **ATP does not free-diffuse** between organelle and host (energy is
  intracellular, mirroring a free cell's ATP not bleeding to water).
- **Penetrating physical fields** (PHOTO/THERMO/MAGNETO/MECH) reach
  the organelle through the host's position. CHEMO is the exception:
  an organelle senses the host cytoplasm's *concentration* of each
  target chem (option 1), since there is no spatial gradient inside a
  host.

### Who controls the membrane today

The **organelle** controls the host↔organelle membrane (it owns the
active transport across its own outer membrane; passive diffusion is
just permeability). The host has **no organelle-directed effector and
no organelle sensor**. From the host VM's perspective organelles are
invisible — they only perturb the shared cytoplasm pool.

### What the host *can* do about organelles (indirect levers)

1. What it synthesizes / retains — raising a cytoplasmic chem makes it
   available to organelles.
2. **What it withholds from world-excretion** — a host that stops
   dumping chem X to the world keeps X in cytoplasm, where an
   endosymbiont can harvest it. This is already an emergent "farming"
   primitive with no dedicated channel: pure shared chemistry.
3. The host can "notice" an organelle only as an anomaly in its own
   pool (e.g. glucose rising ⇒ a phototroph inside). Footprint-based,
   indirect "knowing" — arguably the most substrate-pure form.

### The hard limit

A host **cannot** deliver a chemical to organelles but not the world.
Everything is broadcast through the shared pool; the world drains it
via the host's own diffusion/excretion, and *every* organelle sees the
same pool — the host cannot address one symbiont vs another. So
multi-organelle division of labor is hard to evolve.

## 2. The control fork

Three coherent positions, each gating a different class of emergent
dynamics:

- **A. Organelle-controlled / shared-pool (current).** Minimal,
  maximally emergent. Favors organelle *autonomy*: parasites,
  escapees, footprint-based host adaptation. No addressed delivery;
  weak multi-organelle differentiation.
- **B. Host-controlled vacuolar membrane (the "flip").** More
  biologically faithful: the vacuole/phagosome membrane is
  host-derived, and in real mitochondria/chloroplasts the host
  nuclear genome encodes most transporters (the ADP/ATP translocase
  is host-encoded). Give the host a generic, ATP-costed transport
  *bias* across a specific vacuole (push/pull chem X ±) — NOT a "feed
  organelle" verb. Enables emergent domestication, selective
  feeding/starving, per-organelle specialization.
- **C. Dual / contested membrane.** Net flux = passive diffusion +
  organelle-initiated active + host-initiated active. Richest:
  cooperation *and* conflict can both emerge (host extracts, symbiont
  withholds; or mutualistic exchange). Closest to real endosymbiosis
  as a negotiated interface. Most machinery.

Guidance leaning: do **C as generic primitives** (no "feed" verb,
no organelle sensor — the host must still act on cytoplasmic
footprints, keeping recognition emergent). Net flux is the sum of both
parties' active transport plus passive diffusion. Parasitism,
mutualism, domestication, and specialization all become *reachable*
but none *forced*.

Longest-horizon target: let membrane **control shift over evolutionary
time** — an organelle starts autonomous (its membrane); a host lineage
can gradually evolve transporters that take the membrane over,
mirroring how real organelle control migrated to the host genome. Big
design; C is the natural first step.

## 3. The "transporter" question

Are we missing a dedicated **transporter** primitive — one gated to
certain chemicals (or signatures)? Or is that already INGEST/EXCRETE?

Partial overlap, but a true transporter would add three things not
currently expressible:

1. **Standing, gradient-driven flux vs. imperative pulses.**
   INGEST/EXCRETE are per-tick VM *acts* ("gulp this tick"). A
   transporter is a *standing capability* the genome builds (like a
   receptor or catalyst) that then continuously mediates flux as a
   function of the concentration gradient — facilitated diffusion
   (down-gradient, ~free) or active (up-gradient, ATP). This is the
   difference between "the VM decides to ingest this tick" and "the
   cell expresses a GLUT1-like channel and glucose flows whenever a
   gradient exists." Currently inexpressible.
2. **Selectivity by signature, not just chem id.** EXCRETE is already
   per-chem-id selective and amount-controlled; INGEST is coarse (6
   material classes). Neither can gate on a *marker / surface
   fingerprint*. A transporter gated on a partner signature is exactly
   the missing "addressed delivery" capability from §1 — e.g. a host
   transporter that moves chem X only into organelles bearing a
   compatible marker. This is the single most load-bearing missing
   piece for emergent organelle integration and division of labor.
3. **Transport-as-membrane-reaction (kinetic unification).** Transport
   today is flat-rate. Modeling a transporter as a "reaction" whose
   product is the same chem on the other side of a membrane would
   unify it with the existing Michaelis–Menten / catalyst kinetics
   (Km/Vmax, saturable, catalyst-boostable). Substrate-pure: a
   transporter becomes just another evolvable, tunable reaction the
   genome can SYNTH and catalyze, rather than a special-cased op.

Biology hook: real organelle integration *is* fundamentally the
evolution of selective transporters (translocases), mostly
host-encoded. So a transporter primitive is arguably the keystone for
the whole endosymbiosis arc — more so than any new op.

Distinction worth keeping in mind: INGEST/EXCRETE act only on "my
outer membrane ↔ immediate environment" (self / not-self at the
outermost boundary). A transporter generalizes both *which membrane*
it acts on (internal/compartmental, or a specific partner) and *which
partner* it selects. That generalization — not the raw moving of
matter — is what's missing.

## 4. Open questions / directions

- Should a transporter be a new SYNTH kind (a built, decaying protein
  like a receptor/catalyst) whose presence + gradient drives flux,
  with selectivity = chem id and optionally a marker tolerance band
  (reuse the bond-marker greenbeard machinery)?
- If transport becomes a membrane-reaction, what is the "other side"
  addressed by — world dissolved field, host pool, a specific
  organelle's pool? A generic `(chem, sideA, sideB, ATP?)` shape might
  subsume INGEST, EXCRETE, autoExcrete, organelle uptake, and the
  host-side vacuolar channel all at once.
- Does collapsing INGEST/EXCRETE into transporters reduce the op set
  (good — fewer prescribed verbs, more emergent) or remove a useful
  coarse bootstrap path founders rely on? Possibly keep a coarse
  bootstrap and let fine transporters evolve on top.
- Control migration: a mechanism by which, over generations, a
  host-encoded transporter can supersede an organelle-encoded one on
  the shared membrane (the real evolutionary story).
- Cheating/conflict metrics: with dual control, what observable would
  show parasitism vs mutualism emerging (net ATP/material flux sign
  across the membrane, per lineage)?

## 5. Mitochondrial precedent: how host control arose without permission

Q: if a mitochondrion founder was once enveloped by a host founder,
how did the host come to control the membrane/transport layer? Did the
symbiont "allow" it?

A: it never required permission. It is not negotiation — it is
selection plus a mechanistic, one-way gene-flow ratchet.

**Two membranes.** A mitochondrion has an inner membrane (the original
α-proteobacterial symbiont's own plasma membrane — ETC / ATP synthase
live here) and an outer membrane (host-derived in origin, the
phagosomal wrap). Ownership ended up split and asymmetric: the
symbiont kept a minimal inner shell; the host took over the interface
and the supply chain. Human mito retains ~37 genes; the host nucleus
encodes ~99% of mitochondrial proteins, including the membrane
transporters and the TOM/TIM protein-import translocases.

**The no-permission mechanism (endosymbiotic gene transfer, EGT):**

1. Many symbionts; some die inside the host constantly (hundreds–
   thousands of mitochondria; routine lysis). A dead symbiont spills
   its DNA into the host cytoplasm.
2. That DNA is incorporated into the host nuclear genome by ordinary
   repair/recombination — passive, no agency, no consent. Still
   observed today (NUMTs).
3. Effectively irreversible (a ratchet): once a working copy sits in
   the host nucleus the organelle copy is redundant and lost to
   drift; the symbiont has no mechanism to take it back, and tiny
   asexual organelle genomes degrade under Muller's ratchet anyway.
4. The unit of selection shifts: a symbiont replicating only
   vertically inside a host lineage has its fitness fused with the
   host's. "Resisting" host control is not selectable once autonomy
   is gone — the symbiont can't survive/propagate outside the
   collective.

So host takeover is death-triggered, mechanistic DNA escape
(asymmetric + ratchet-like) plus selection on the fused collective.
The symbiont's "consent" never enters the model. "Doesn't require
permission" is the accurate framing.

**Implication for the sim — the missing primitive.** The substrate
currently lacks the one thing that makes host-takeover *emergent
rather than scripted*: a death-triggered capability/gene transfer.
Today inner death → `digestInnerIntoHost` moves the symbiont's
*chems* but none of its *capability* (genome fragment / catalyst /
synth competence). Add a mechanistic, no-permission EGT analog — on
inner death, some probability the host absorbs a fragment of the
symbiont's genome or a catalyst/synth capability — and host control of
the interface can evolve on its own: selection on the collective plus
an asymmetric, irreversible transfer, with no consent term anywhere.
Combined with the contested-membrane model (C, §2), membrane control
can then migrate hostward over generations as an emergent outcome,
mirroring the real evolutionary story.

Open sub-questions:
- Transfer granularity: raw genome bytes spliced into the host genome
  (lets the host's VM eventually express symbiont ops) vs. transfer of
  a built capability (a catalyst pool / synth competence)? Bytes are
  the more substrate-pure, more emergent choice.
- Rate/gating: per-inner-death probability, scaled by how many
  symbionts of that lineage the host carries (more copies → more
  chances), to reproduce the ratchet without hard-coding directionality.
- Reverse transfer should be possible but vanishingly likely (don't
  forbid it — let the asymmetry be statistical, not a rule).
- Does EGT plus internal division collapse the inner lineage's
  autonomy too fast (instant domestication) or is there a parasite/
  mutualist transient first? Needs a probe.

_Status: notes only. Not scheduled, not implemented._
