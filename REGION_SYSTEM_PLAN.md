# Regional dissolved / reserve chemical system — implementation plan

Status: in progress. Phases land independently; each is gated by the
mass-conservation invariant test, the reproducibility test, and the
≤10% per-phase perf bar from `CHEMISTRY_OVERHAUL.md`.

## Locked parameters

- **Region**: 50×50 px footprint, treated as a 50×50×`world.depth`
  box. `REGION_PX` constant ("someday adjustable"). Counts derive
  from world dims (~16×12 landscape / 12×16 portrait).
- **Three buckets per (chem, region)**: ① dissolved (mass),
  ② rendered particles (real, 2px), ③ reserve (invisible mass,
  positionless, region-resolved).
- **Solubility**:
  `capacity(chem,region) = S_molar(chem) · f_T(T_region) · V_region(L) · N_A / M`.
  `M` = molecules represented by one sim particle — the single
  fitted knob, chosen so insoluble food chems (biopolymer / minerals
  / fattyAcid) get ≈0 dissolved capacity (stay particulate) and
  soluble byproducts (glucose / aminoAcid / waste) dissolve readily.
  Named chems get realistic relative molar solubilities; generics
  reuse their deterministic procedural roll, reinterpreted through M.
- **Temperature**: analytic, sampled per region per tick (no
  diffusing field, no thermodiffusion). Local T only scales
  solubility (`f_T`) + the diffusion coefficient. 10 m vertical
  scale calibrates rate only — zero rendering/dynamics impact.
- **Diffusion**: Jacobi (double-buffered), cross-region, for
  dissolved *and* reserve. Coefficient set so a sharp gradient has a
  ~10-minute half-life across the world.
- **Particles**: all render 2px (cells excepted). Render size
  decoupled from physics — buoyancy = density vs local density;
  drag uses density + logical mass, not render radius. Legacy
  varied-size spawn retired (the field carries mass now).
- **Per-tick precedence**: (1) diffuse dissolved+reserve →
  (2) dissolve as much as possible into capacity → (3) render the
  remainder if under the global particle cap → (4) reserve = last
  pass. Hysteresis deadband (precipitate >100%, re-dissolve <90%)
  to prevent dissolve/precipitate thrash.
- **Reserve**: per-(chem,region); demote/promote mass-local;
  promotion selects the chem by global prevalence but draws/spawns
  from a region that holds that reserve.
- **Persist** dissolved + reserve in the save blob (sparse).

## Phases

### Phase 0 — Scaffolding & invariants (no behavior change)
Region grid constants + `V_region` (px³→L via the 10 m scale) +
per-region analytic temperature sampler. `M` constant + real/generic
molar-solubility table + `capacity()` helper. Calibration unit test
fits `M` (biopolymer cap ≈0, glucose cap large). Extend the
mass-conservation test to sum cells + buckets + atmosphere (still
global ambient). Risk ≈ 0 (pure additions).

### Phase 1 — Regional dissolved field replaces global ambient
`dissolved[region·chem]` flat array supplants scalar `world.ambient`.
Migrate `diffuseAmbient` / `dissolveParticles` / `aerateAmbient` to
the local region. Jacobi cross-region diffusion, T-scaled, 10-min
half-life. HIGH risk (hottest paths + trophic loop). Exit:
conservation + reproducibility green; ≤+10% perf.

### Phase 2 — Particle render unification + physics decouple
All particles render r=2px; logical mass / effective radius for
drag/buoyancy/collision independent of render radius. Retire
varied-size spawn. Exit: settling/mixing qualitatively unchanged.

### Phase 3 — Precipitation / dissolution with precedence + hysteresis
Per-tick op order with the deadband; precipitate excess as 2px
particles under the global cap. Exit: no dissolve/precip oscillation
in a saturated-region stress test.

### Phase 4 — Reserve bucket + cap enforcement + promotion
`reserve[region·chem]` + shared Jacobi diffusion. Over-cap rendered
→ local reserve; reserve→rendered promotion by global-prevalence
chem pick, mass-local spawn. Sparse save encoding. Exit: 60-min
scenario — particle count bounded at cap, `meanX` stays ~centred
through +50–60m (definitive regression of the original bug).

## Cross-cutting

- **Determinism**: Jacobi + fixed iteration order everywhere (no
  in-place sweeps — that was the root of the rightward-bias bug).
- **Perf**: flat typed arrays + per-region active-chem sparse set;
  never dense-loop 96 chems × all regions. Profile every phase.
- **Save**: sparse regional encoding; hard-reset acceptable on
  schema bump.

## Open (do not block Phase 0)

- Exact `M` — fitted in Phase 0 against the behavior target.
- Hysteresis %s — proposed 100/90, confirm in Phase 3.
