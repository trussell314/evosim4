# Per-archetype "perfect scenario" results

Measured facts only. Method: analyzer pre-screen (`scripts/rxn_balance.ts`)
→ design scenario from engine mechanics → controlled single-variable
runs (`scripts/scenario.ts`) → root-cause flaws (fix engine/genome,
not scenario) → re-validate. Population figures use exact id-based
accounting (`spawned + births − deaths`, closes by construction);
SimStats death counters undercount (gap reported per run).

## Engine fixes applied (each derived, not guessed; controlled-validated)

- **`synth_aa` vmax 0.4 → 1.2** (`reactions.ts` out[4]). At 0.4 a pure
  photoautotroph's de-novo aa rate was below its own aa-sink demand
  (~0.65 at vmax) → could not self-sustain unfed. Derived from the aa
  mass balance. Golden re-baselined `c50314cd → 3f43094f`.
- **`photosynth` vmax 1.2 → 5.0** (`reactions.ts` out[3]). Derived from
  the glu mass balance (sink sum ~2.69 / 0.5 glu-per-unit ≈ 5.4).
  Carbon fixation was the binding constraint once aa was relieved
  (mGLU ≈0 in every autotroph run). Golden re-baselined
  `3f43094f → a11f6a54`.
- Both: determinism byte-identical, mass conservation green, full
  suite 346 pass. Global, intended behavior changes.

## Genome fixes

- **phototaxis light threshold 6 → 2.** Engine's realized
  `act_photo_visible` ≤ ~3.4 even at the surface, so `act_photo < 6`
  was unreachable → "lit, stop migrating" branch never fired →
  perpetual thrust. Per-archetype, no golden impact.

## Archetype outcomes (unfed = no aa feeding; CO₂/MIN chemostat)

| # | archetype | scenario | 30 → end | status |
|---|-----------|----------|----------|--------|
| 1 | photoautotroph | near-surface, midday, replete | **30 → 168** | nailed (self-sufficient post both engine fixes) |
| 2 | phototaxis | depth light gradient | **30 → 120** | nailed (depth-keeping adaptive; threshold fix needed) |
| 3 | thermophile | warm autotroph recipe (default temp) | **30 → 175** | metabolically nailed; behavior flaw noted (below) |

### #3 thermophile — open noted flaw (not fixed, by direction)

The genome nulls `act_thermo`, targeting the **15°C isotherm**
(`TEMP_BASELINE`). But the Q10 metabolic multiplier rewards the
*warmest* water (28°C ≈ 1.74×, 15°C ≈ 0.71×). So the archetype is a
**"15°C-seeker," not a thermophile** — its signature behavior pulls
it away from metabolically optimal warm water. It thrives anyway
(30 → 175 in warm water) because the photosynth/aa fixes made
production strong enough to absorb the handicap; the controlled
"adaptive gradient" run in cold water grew *less* (30 → 103),
confirming Q10 warmth dominates the sorting behavior. Logged as a
genome/semantics mismatch; left unfixed per instruction.

## Caveats carried forward

- SimStats death-cause counters undercount vs exact id-deaths
  (gap scales with turnover; per-run figures in the scenario logs).
  Population totals are trustworthy (id-accounting closes exactly).
- Runs use CO₂/MIN chemostats; a fully-natural world (no mineral
  replenishment; `minerals` = NO SOURCE, env-uptake only at perm 0.1)
  is an untested open item for the no-INGEST autotrophs.

## #4 forager (heterotroph) — nailed

Scenario: biopolymer food chemostat (~1500 particles), ambient O2/MIN
replete, no predators, founders off.

- **30 → 110** (peak 208, then settled ~100 plateau), 655 births,
  id-accounting closes exactly. Self-sustains + grows on replete food.
- Not food/aa limited: with food replete, digestion produced an aa
  *surplus* (mAA → 33, ambAA → ~60 excreted). Growth ceiling is
  membrane-synthesis throughput (out[9]+out[11] vmax ≈1.4): mMem
  stuck ~20, rarely past the 30 gate; mem-death dominant (323/551).
- Watch item (not a survival flaw — it grows): membrane-synth is a
  decay-driven-demand bottleneck the static analyzer can't size
  (same class as mRNA). No engine change (non-fatal); logged only.
- SimStats undercounts deaths by 24 here (id-accounting authoritative).

## #5 predator — validated (predation functions; closed-arena boom-bust is correct)

Biopolymer chemostat + 80 co-stocked forager prey. Predation works:
focal (predator) lineages grew 30→310 by predating+foraging. The
subsequent overshoot-collapse (peak 548→4) is correct closed-arena
predator-prey dynamics (Gause), not a genome flaw; per direction,
goal = genome validated, not population propped. Harness fix made en
route: continuous (per-step) food chemostat (per-sample stripping
caused a false collapse). Validated.

## #9 farmer + #11 mitochondria — tandem endosymbiosis (in progress)

Treated as one tandem exercise. Engine supports the arc (host fission
partitions contents to daughter; engulfed REPRODUCE adds organelle).

Measured progression (controlled, single-variable each step):
- Unconditional ENGULF, mito gate 18: host collapsed to 0, mito
  bloomed free. Tandem fails.
- mito reworked (gate 18→45, drop INGEST glu): mito stops runaway
  bloom + glucose-parasitism; host still collapsed → host is the
  blocker.
- farmer ENGULF gated on SELF_ENERGY>50 + mito gate 45:
  **endosymbiosis demonstrably emerges and is cleanly measured** —
  mito-symbiosis run reached engMito 31 (peak), all `inHost`,
  hostsW/Mito 6, eng:host up to 2.38, with host reproduction (36→45)
  co-occurring. Empirically resolves the size question: farmers DO
  bulk past the 1.14× breach gate; engulfment is not size-blocked.
  But host declined 45→8 (farmer-solo 30→19, still sub-forager) so
  the symbiosis erodes rather than stabilising. Pre-engulfed variant
  still fails fast (hosts 0 by t120).

Verdict vs success criteria: (a) sustained endosymbiosis — largely
met in the separate scenario (real, persisting, cleanly-measured);
(b) tandem reproduction — partial (co-reproduction for a ~400s
window, then erodes with the host). Residual blocker: farmer
standalone viability is sub-forager.

STAGED, NOT YET VALIDATED: farmer ENGULF gate raised 50→90 (engulf
only on strong surplus, to close the host-viability gap vs forager
while still permitting symbiosis). tsc + 34 archetype tests green;
no scenario run performed yet (per instruction). Next run should
re-check farmer-solo + mito-symbiosis with the >90 gate.
