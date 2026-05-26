# Chemical I/O & catalysis reference

What a genome can sense, ingest, excrete, use as a marker, and
catalyze, as of the current engine. Reference doc; reflects code, not
aspiration. Update if the ABI changes.

## Sensable chemicals

Three distinct channels:

- **Internal pool — any of the 96.** `SENSE_CHEMICAL <id>` reads
  `chemConc[id mod 96]`, the cell's *own* pool of that chem. So a
  genome can sense the internal concentration of **every** chemical —
  all 46 named + all 50 generic — including the `activated_*` signal
  chems the activation pass writes. Plus three direct self readouts:
  `SELF_ENERGY` (ATP), `SELF_MASS` (sum of named pool), `SELF_MEMBRANE`.
- **Spatial gradient — any chem, no receptor.** `SENSE_OUT <chemId>`
  pushes the local ambient-field gradient `[gx, gy]` of *any* chemical
  at the cell's position (so `SENSE_OUT c; THRUST` climbs/descends the
  `c` plume). This is universal — it needs no synthesized receptor and
  folds in the retired `SENSE_GRAD_X/Y/DENSITY` ops.
- **External modalities — via a synthesized receptor.** The activation
  pass writes an `activated_*` signal into the pool (read back with
  `SENSE_CHEMICAL`) only if the cell has `SYNTH`'d the matching
  receptor: PHOTO ×3 bands (visible / long / surface); ELECTRO (X/Y,
  bioelectric glow of metabolizing cells); VIBRATION (X/Y, motion
  wakes at range); pH (scalar acidity); LIGHT (X/Y, reflected +
  emitted cell-light); MECH (X/Y, contact force); THERMO (scalar);
  MAGNETO (X/Y, positional field map). The old CHEMO ×4 gradient
  targets were **retired** — chemical-plume gradients are now sensed
  universally through `SENSE_OUT`, and the freed receptor slots carry
  the electric / vibration / pH senses.

## Ingestable chemicals

`INGEST` is **zero-operand**: it pops a bond-energy *threshold* off the
stack (scaled by `INGEST_TH_SCALE`). The cell then eats — from food
particles on contact and from its region's dissolved reserve — the
**most abundant** chemical whose per-chem bond potential
(`CHEM_BOND_POTENTIAL[chem]`) clears that threshold. So a low threshold
grazes low-energy detritus while a high one is selective for rich food;
chems with bond potential 0 are never ingestible. There is no fixed
6-material selector anymore. Molecule-tagged corpse/excretion particles
deposit their full molecule payload when ingested. Organelle uptake
uses the same threshold against the host pool.

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
  universal gradient sense — no receptor required). Markers 1–3 exist
  as plain chems (ids 42–44) and any chem is gradient-sensable via
  `SENSE_OUT`, but only `marker0` has the canonical constant + special
  handling as the designated scent channel.
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
