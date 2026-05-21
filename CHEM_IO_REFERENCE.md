# Chemical I/O & catalysis reference

What a genome can sense, ingest, excrete, use as a marker, and
catalyze, as of the current engine. Reference doc; reflects code, not
aspiration. Update if the ABI changes.

## Sensable chemicals

Two distinct channels:

- **Internal pool — any of the 96.** `SENSE_CHEMICAL <id>` reads
  `chemConc[id mod 96]`, the cell's *own* pool of that chem. So a
  genome can sense the internal concentration of **every** chemical —
  all 45 named + all 51 generic — including the `activated_*` signal
  chems. Plus three direct self readouts: `SELF_ENERGY` (ATP),
  `SELF_MASS` (sum of named pool), `SELF_MEMBRANE`.
- **External / environmental — only via receptors, fixed set.** The
  activation pass writes a signal into the pool only if the cell has
  `SYNTH`'d the matching receptor. Externally-sensable modalities are
  exactly: PHOTO ×3 bands (visible / long / surface); CHEMO ×4
  *targets only* — `biopolymer`, `minerals`, `fa`, `marker0` (X/Y
  gradient each); MECH (X/Y); THERMO; MAGNETO (X/Y). Spatial gradient
  sensing of the world is limited to those 4 CHEMO target chems;
  everything else is internal-pool only.

## Ingestable chemicals

`INGEST <op mod 6>` opts into 6 material slots = `SENSOR_CHEMS`:
**minerals, biopolymer, fa, O₂, CO₂, glucose**. Additionally,
**generic chems (ids 45–95) and waste** are eaten under the
*biopolymer* slot (their fallback). Molecule-tagged corpse/excretion
particles deposit their full molecule payload directly when ingested.
Everything else — aa, chl, enz, mrna, membrane, receptors, bondChem,
repairChem, marker0 — is **not** directly ingestible as a free
particle (no sensor slot, not generic, not waste). Organelle uptake
uses the same 6 `SENSOR_CHEMS` against the host pool.

## Excretable chemicals

`EXCRETE <op mod 96>` can emit **any of the 96 chemicals** the cell
holds (amount = min(requested, held), must clear `EXCRETE_MIN_AMOUNT`).
Excretion is fully general. The passive `autoExcrete` path is the only
restricted one — it vents **CO₂ and waste only**, over their
thresholds. Organelle EXCRETE deposits any chem into the host pool;
organelle autoExcrete = CO₂/waste to host.

## Markers

Two different "marker" notions:

- **Greenbeard bond marker — not a chemical.** It's the 1-byte param
  of `SYNTH BOND` (0–255), stored as `c.bondMarker`; recognition is
  `|markerA − markerB| ≤ BOND_MARKER_TOL`, and bonding only happens
  while the cell holds `CHEM_BOND` above threshold. The marker is an
  evolvable numeric tag (256 values); `CHEM_BOND` is the enabling
  chemical.
- **Scent / positional marker chemical — only `CHEM_MARKER0`.** The
  one chem that is both freely excretable *and* a universal-gradient
  sense target, so a cell can `EXCRETE marker0` and others can sense
  its spatial gradient via `SENSE_OUT CHEM_MARKER0` (Phase 3
  universal gradient sense — no receptor required). Exactly one such
  channel — no marker1/2. Any other chem can carry information via
  internal sensing or local ambient, but only marker0 is the canonical
  spatially-gradient-sensable signal.
- Surface fingerprint exists but is engine-internal and **not
  VM-addressable**.

## Catalysts for reactions (including generic)

**Yes, for every reaction slot.** `SYNTH CAT <param>` with
`param mod 256` targets catalyst slot k, and **catalyst slot k *is*
reaction k** of the 256-entry table:

- Slots **0–25** are the named bootstrap reactions: `uncatRate > 0`
  (fire for free every cell); a catalyst just *boosts* them (adds up
  to `vmax` more).
- Slots **26–255** are procedurally-generated generics with
  `uncatRate = 0` — they **only ever fire if the cell expresses that
  catalyst**. For generics, `SYNTH CAT k` is the sole on-switch for
  reaction k.

Cost/maintenance: `biosynthCatalyst` consumes aa+min
(`CAT_SUBSTRATE_CHEM`) + ATP (`CAT_ATP_COST`) to build the pool
(`CAT_SYNTH_VMAX`), and it decays (`CAT_DECAY_PER_SEC`) — a
continuously-paid protein, not a one-time unlock. The slot→reaction
mapping is deterministic (seeded table), fixed across runs, so a
lineage can evolve to discover and lock in whichever generic
reactions are profitable for its niche.

## Temperature & thermal stress

Local water temperature (the diffused regional field: depth gradient
12 °C floor → 28 °C surface, plus the always-on hydrothermal vent's hot
zone) affects cells two ways:

- **Metabolic rate (Q10).** Reaction rates scale by
  `2^((T−20)/10)`, hard-clamped to **0.25×–4.0×**. The 4× ceiling is
  reached at **40 °C**; above that there is no further rate gain.
- **Thermal denaturation.** Above a per-cell **tolerance ceiling**,
  membrane lipid denatures to waste (`RX_THERMAL_DENATURE`,
  mass-conserving) at `(T − ceiling) × 0.08`/s, eroding the cell toward
  the `MIN_VIABLE_MEMBRANE` death floor. Ceiling =
  **42 °C + 30 °C × `CHEM_REPAIR` pool** (capped at +45 °C). So
  `CHEM_REPAIR` is dual-purpose — the stress-chaperone protein that
  both suppresses somatic mutation *and* raises the heat ceiling
  (real heat-shock proteins are general chaperones). Heat tolerance is
  therefore an evolvable, synthesized, graded trait: only the vent
  core (>42 °C) applies pressure, and a cell survives it by investing
  in `SYNTH CAT 23` (the repair-chem reaction). Nowhere else in a
  default world exceeds 42 °C, so thermal stress is a vent-local
  selective filter.

_Status: reference. Reflects engine as implemented._
