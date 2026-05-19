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

## #9 farmer + #11 mitochondria -- post Path 1/2 (ATP first-class + ANT)

ATP is now a first-class chemical (CHEM_ATP) and the mito is a true
ANT-style ATP-exporter (digest->respire->translocase, vacuolar-only,
mass-exact). Controlled run (farmer-solo + mito-symbiosis +
mito-engulfed; ENGULF>90 farmer):

- farmer-solo (control, no mito): 30 -> ends 9 (peak 50). ENGULF>90
  did NOT fix it (>50 was 30->19; >90 is 30->9). Farmer is NOT a
  viable standalone heterotroph -- the controlled proof.
- mito-symbiosis: endosymbiosis forms cleanly + persists ~500s
  (engMito 5..22, ALL inHost, hostsW..13, eng:host ~1-2, host
  reproduction co-occurs early) -- then erodes with the host
  (37->3 hosts, pop 77->4). NO measurable host rescue: host-with-mito
  (~3) does not beat host-alone (~9).
- mito-engulfed: perfect start (39/39 inHost) -> hosts 0 by t120
  (unchanged); post-extinction inMito anomaly recurs (flagged).

Verdict: (a) endosymbiosis forms+persists for a window but not
sustained; (b) tandem brief then erodes. The ATP-export MECHANISM is
done & correct and is NOT the blocker. The blocker is singular and
isolated: farmer (#9) is intrinsically non-viable standalone
(30->9 solo even at ENGULF>90) while near-identical forager (#4)
nailed 30->110. A symbiont can't sustain a symbiosis with a host
that dies on its own; the ATP subsidy showed no rescue because the
host failure is unrelated to ATP supply. NEXT: fix farmer standalone
viability (diagnose farmer-vs-forager; conditional ENGULF reduced
but didn't eliminate the self-harm) -- not more ATP/mito work.

## #9 farmer + #11 mito -- rarity-gated ENGULF (reg0%64), post Path1/2

Diagnosis confirmed: SELF_ENERGY gate ineffective (ATP ~165-250 >> any
threshold); kin-only ENGULF = self-cannibalising population sink
(farmer == forager metabolically; forager 30->110 has no engulf).
Fix: reg0-counter, ENGULF only when reg0%64==0 (~1/64 passes,
ATP-independent). Genome-only.

Result (controlled vs prior collapse):
- farmer-solo: 30 -> peak 73, sustains 25-48 ~480s, late decline ->11
  (was 30->9 monotonic). Major improvement; viable most of the run.
- mito-symbiosis: pop 77->23, hosts 37->12, engMito sustained 4-11
  (ALL inHost), eng:host ~0.2-0.7 stable ~400s, host+symbiont
  co-reproduce (was pop 77->4, hosts 37->3). (a) sustained
  endosymbiosis SUBSTANTIALLY met; (b) tandem met for ~400s window.
- mito-engulfed: hosts 0 by t90 (still fails -- pre-engulfed host
  starts already-burdened before it can establish; inherently hard).

Residual: slow LATE decline (~t480+) in BOTH farmer-solo and the
tandem -- same root, 1/64 engulf still a marginal net drain over
10min. Next single-variable: rarity period 64->128.

## farmer + chloroplast -- internal-division gate tune (36 -> 45)

chloro-symbiosis scenario (40 free chloroplasts + 40 farmer hosts,
near-surface lit + permanent midday, CO2/MIN replete, biopolymer
chemostat; engulfed chloroplast photosynthesises on host depth-light,
leaks glucose to shared pool -- native transfer, no translocase).

Pre-tune (chloroplast reproduceWhenGrown 36): engulfed-chloroplast
bloom-and-kill. engSym up to 406, eng:host ~2.3-4.7 (runaway),
mGLU 1500-11000 sustained flood, host pop violent thrash
(peak 481 -> 200).

Fix (genome-only): raise chloroplast internal-division gate to the
mito-validated band, reproduceWhenGrown 36 -> 45.

Result (controlled, identical scenario, single variable):
- engSym peak 406 -> 136; eng:host runaway ~2.3-4.7 -> stable
  ~1.4-1.8 (vs mito's ~0.2-0.7 -- still the eagerest plastid but no
  longer blooming).
- pop: crash to 9 by t180 -> steady recovery -> 125 (peak 170),
  sustained through 600s (was violent peak-481->200 oscillation).
- (a) sustained endosymbiosis MET: engSym persists continuously
  t90->600 (83 inHost end, 33 hosts carrying); free chloroplast
  also recovers (focal 67 end).
- (b) tandem reproduction MET in stable phase (t>=240s): hosts and
  engSym co-grow at steady ~1.4-1.8 ratio (hosts 9->58, engSym
  16->83), no longer over-dividing.

Residual (transient, not the targeted bloom): early overshoot --
engulfed chloroplasts flood glucose t90-150 (mGLU ->8700, pop dips
80->9) before host/symbiont ratio settles; from ~t240 it is a
sustained tandem regime. The gate raise damped bloom-and-kill into
a recover-and-sustain trajectory.

## #6 armored -- ideal conditions + soft control (NOT validated)

Scenarios `armored` (focal armored 40, coStock size-bully 30,
biopolymer chemostat ~1800, O2=30/MIN=50, near-surface, perm midday,
founders off) and `armored-control` (identical, focal=forager). One
variable between them: the focal genome.

Measured (10 min each, seed 4242):
- armored focal: 40 ->27(60s) ->14(150s) ->4(240s) ->1(390s) ->0
  (extinct ~t420). fMem 12 ->~60-76, fR 4.1 ->7.5 (membrane/size
  investment real). predation-attributable deaths ~244
  (idDeaths 383 - tracked 139; tracked = starve7 mem132).
- soft control focal: 40 ->34(60s) ->17(150s) ->7(240s) ->1(330s)
  ->0 (extinct ~t360). predation-attributable deaths ~338
  (idDeaths 490 - tracked 152).
- both runs: whole arena collapses (preds 30 -> peak ~67 -> 2,
  pop -> 2) -- the same closed-arena predator boom-bust documented
  for #5 predator, not an armor-specific failure.

Verdict: the armor MECHANISM works directionally -- armored cells
build a real size refuge + raise breach cost, cutting predation
mortality (~244 vs ~338) and extending focal persistence ~60s vs
the soft control. But the ARCHETYPE is not a self-sustaining
population under sustained predation: it still goes extinct,
marginally outlasting the control inside a total trophic collapse.
Likely throttle: reproduceWhenGrown(80) is the catalogue's highest
gate; under predation in a collapsing food web the cell rarely
reaches SELF_MEMBRANE>80, so durable individuals can't convert
survival into replacement-rate reproduction. NEXT (single variable,
not yet applied -- awaiting direction): lower the armored reproduce
gate (e.g. 80 -> ~45-50, still well above forager's 30 so it stays
a tank) and re-run the same controlled pair; that isolates whether
the armor STRATEGY is viable once reproduction isn't over-throttled,
without propping the population by changing the environment.

### follow-up: gate matched to forager (30) -- armor isolated

Re-ran the controlled pair with armored's reproduce gate set to 30
(== forager), so the ONLY variable is the 4x SYNTH BIO membrane
investment.

Measured (10 min, seed 4242):
- armored (gate 30): focal 40 ->31(60s) ->19(120s) ->6(180s) ->0
  (~t270). predation deaths ~466 (idDeaths 637 - mem171). fMem
  stayed ~11-22, fR ~4-6 -- NO tank accumulates.
- soft control (gate 30): focal 40 ->32(60s) ->22(120s) ->15(180s)
  ->0 (~t270). predation deaths ~359 (idDeaths 757 - mem395).
- both extinct ~t270; armored took MORE predation, not less.

Decisive conclusion: with the gate matched, the armor genome is
indistinguishable from (marginally worse than) the soft forager.
The defensive value seen in the gate-80 run was NOT membrane
investment per se -- it was deferred division -> larger cells ->
size refuge past the predator's 1.14x breach gate. Armor in this
engine is inseparable from a high reproduce gate: at forager
cadence the cell divides at SELF_MEMBRANE>30 and never accumulates
a tank, so the 4x SYNTH BIO is wasted (spent then split at
division). In all three configs (gate 80/47/30) #6 is non-viable
as a population -- the closed arena boom-busts regardless. The
experimental gate change (80->47->30) is degenerate at 30 (armor
inert) and should be reverted to the catalogued 80 to preserve the
intended-if-weak design; the finding stands as documented.

### 2x2 closeout: forager@80 (ad-hoc genome) -- gate isolated

Added probe scenario `forager80`: the catalogue forager with its
reproduce gate forced to 80 (ad-hoc genome built in-script, guarded
by a byte-equality assertion vs the real forager so it is provably
forager-with-only-the-gate-changed). Same predator pressure/food as
all the armored runs. Completes the 2x2 (armor x gate):

| config              | gate | armor | focal extinct | predation deaths |
|---------------------|------|-------|---------------|------------------|
| armored@80 (orig.)  |  80  |  yes  | ~t420         | ~244             |
| forager@80          |  80  |  no   | ~t390-420     | ~245             |
| armored@30 (matched)|  30  |  yes  | ~t270         | ~466             |
| forager@30 (control)|  30  |  no   | ~t270         | ~359             |

(predation deaths = exact idDeaths - SimStats tracked; forager@80
idDeaths 463 - tracked 218.)

Decisive: the original armored@80 edge was the REPRODUCE GATE, not
the armor. Holding armor constant and varying the gate buys ~120s
persistence and ~halves predation mortality (forager 30->80:
t270/359 -> t390+/245; armored 30->80: t270/466 -> t420/244).
Holding the gate constant and varying armor changes essentially
nothing: at gate 80 armored (~t420, ~244) ~= forager (~t390-420,
~245). The 4x SYNTH BIO membrane investment adds no measurable
benefit; the working mechanism is deferred division -> larger
non-dividing cells -> size refuge past the predator's 1.14x breach
gate, which ANY genome gets from a high gate (a high-gate forager
incidentally reaches fMem 36-75 via its normal SYNTH BIO, so
"armored" is not even a distinct phenotype here). The
membrane-breach-cost mechanic #6 was designed around produces no
distinct selective signal in this setup. Caveat: all four still go
extinct (closed-arena boom-bust), so this is relative persistence,
not viability -- a non-collapsing arena could still expose a
membrane-specific benefit the collapse masks. Candidate
COLONY_GAPS / substrate note: predation resistance currently
collapses onto body size (the 1.14x gate), so a dedicated "armor"
axis is not separately selectable from "grow big / divide late".
