// One-off headless profile. Skipped in the regular test suite (it
// takes 30+ seconds even on fast machines). Run it on demand with
//   npx vitest run -t "profile under load"
// or change the .skip below to .only when iterating.
import { test } from "vitest";
import { createWorld, step, makeProfile, type Creature } from "../sim";

test.skip("profile under load", () => {
  const FIXED_DT = 1 / 60;
  const w = createWorld(800, 600);
  const WARMUP_TICKS = 3_000; // 50 sim-sec
  for (let i = 0; i < WARMUP_TICKS; i++) step(w, FIXED_DT);

  w.profile = makeProfile();
  const MEASURE_TICKS = 1_500; // 25 sim-sec
  const t0 = Date.now();
  for (let i = 0; i < MEASURE_TICKS; i++) step(w, FIXED_DT);
  const wallMs = Date.now() - t0;

  const p = w.profile;
  const n = p.ticks;
  const rows: { name: string; ms: number }[] = [
    { name: "creatures (VM+chem)", ms: p.creatures / n },
    { name: "particle coll",       ms: p.particleColl / n },
    { name: "forces",              ms: p.forces / n },
    { name: "walls",               ms: p.walls / n },
    { name: "creature coll",       ms: p.creatureColl / n },
    { name: "sediment coll",       ms: p.sedimentColl / n },
    { name: "obstacle coll",       ms: p.obstacleColl / n },
    { name: "bonds",               ms: p.bonds / n },
    { name: "pheromone",           ms: p.pheromone / n },
    { name: "aerate",              ms: p.aerate / n },
    { name: "replenish",           ms: p.replenish / n },
    { name: "prune",               ms: p.prune / n },
  ];
  rows.sort((a, b) => b.ms - a.ms);
  const total = rows.reduce((s, r) => s + r.ms, 0);

  console.log(
    `\n[profile] warmup=${WARMUP_TICKS}t  measured=${n}t  wall=${wallMs}ms  ` +
    `pop=${w.creatures.length}  particles=${w.particles.length}  ` +
    `total=${total.toFixed(3)}ms/tick  sim/wall=${(MEASURE_TICKS * FIXED_DT * 1000 / wallMs).toFixed(2)}x`,
  );
  for (const r of rows) {
    const pct = total > 0 ? (100 * r.ms / total).toFixed(1) : "0.0";
    console.log(`  ${r.name.padEnd(24)} ${r.ms.toFixed(3)} ms  ${pct}%`);
  }
}, 600_000);

// Behavioral profile: track lineage establishment over a long sim run
// AND log per-tick state for a sample of cells so we can see exactly
// what's happening to them molecule-by-molecule. Run with:
//   npx vitest run -t "lineage establishment"
test.skip("lineage establishment", () => {
  const FIXED_DT = 1 / 60;
  const w = createWorld(800, 600);

  type CellRecord = {
    bornAt: number;
    diedAt: number | null;
    parentKey: string | undefined;
    speciesKey: string;
    everReproduced: boolean;
    deathBiomass: number;
    deathATP: number;
    deathGlucose: number;
  };
  const records = new Map<Creature, CellRecord>();
  // Cells we're logging per-tick details for: the seed, then the first
  // few children that appear. Track previous-tick state to compute
  // per-tick flows.
  const TRACE_MAX = 6;
  type TraceState = {
    label: string;
    cell: Creature;
    bornAt: number;
    prev: { atp: number; bio: number; glu: number; fa: number; aa: number; min: number; o2: number; co2: number; chl: number; enz: number; adp: number; waste: number };
    logBuf: string[];
  };
  const traces: TraceState[] = [];
  const snap = (c: Creature) => ({
    atp: c.energy,
    bio: c.molecules.biomass,
    glu: c.molecules.glucose,
    fa:  c.molecules.fattyAcid,
    aa:  c.molecules.aminoAcid,
    min: c.molecules.minerals,
    o2:  c.molecules.o2,
    co2: c.molecules.co2,
    chl: c.molecules.chlorophyll,
    enz: c.molecules.enzyme,
    adp: c.molecules.adp,
    waste: c.molecules.waste,
  });
  function startTrace(c: Creature, label: string): void {
    if (traces.length >= TRACE_MAX) return;
    traces.push({ label, cell: c, bornAt: w.t, prev: snap(c), logBuf: [] });
  }
  // Header for the per-tick log. Compact, fixed-width.
  const header = "label    age    atp   d/s   bio  d/s   glu  d/s    fa   aa  min   chl  enz   o2  co2 adp waste";
  for (const c of w.creatures) {
    records.set(c, {
      bornAt: w.t, diedAt: null, parentKey: undefined,
      speciesKey: c.speciesKey, everReproduced: false,
      deathBiomass: 0, deathATP: 0, deathGlucose: 0,
    });
    startTrace(c, "seed");
  }

  const SIM_SEC = 300; // five sim-minutes
  const TICKS = Math.round(SIM_SEC / FIXED_DT);
  const SNAPSHOT_EVERY = 30;
  const TRACE_EVERY = 60; // log per-cell state once a sim-second (60 ticks)
  const snapshots: Array<{ t: number; pop: number; species: number; extinctions: number; avgAge: number }> = [];
  let nextSnapshot = SNAPSHOT_EVERY;

  let prev = new Set(w.creatures);
  let childCounter = 0;
  for (let i = 0; i < TICKS; i++) {
    step(w, FIXED_DT);
    const now = new Set(w.creatures);
    // Detect births
    for (const c of now) {
      if (!prev.has(c) && !records.has(c)) {
        records.set(c, {
          bornAt: w.t, diedAt: null,
          parentKey: undefined,
          speciesKey: c.speciesKey, everReproduced: false,
          deathBiomass: 0, deathATP: 0, deathGlucose: 0,
        });
        // Start tracing the first few newborns.
        if (traces.length < TRACE_MAX) {
          childCounter++;
          startTrace(c, `child${childCounter}`);
        }
      }
    }
    // Detect deaths
    for (const c of prev) {
      if (!now.has(c)) {
        const r = records.get(c);
        if (r && r.diedAt === null) {
          r.diedAt = w.t;
          r.deathBiomass = c.molecules.biomass;
          r.deathATP = c.energy;
          r.deathGlucose = c.molecules.glucose;
        }
        // Mark traced cell as dead so we stop logging.
        for (const tr of traces) {
          if (tr.cell === c) tr.logBuf.push(`  ** died at age ${(w.t - tr.bornAt).toFixed(1)}s: atp=${c.energy.toFixed(2)} bio=${c.molecules.biomass.toFixed(2)} glu=${c.molecules.glucose.toFixed(2)} **`);
        }
      }
    }
    for (const c of now) {
      if (c.division) {
        const r = records.get(c);
        if (r) r.everReproduced = true;
      }
    }
    prev = now;

    // Per-cell trace lines.
    if (i % TRACE_EVERY === 0) {
      for (const tr of traces) {
        if (tr.cell.molecules.biomass <= 0 && tr.cell.energy <= 0) continue; // dead
        const s = snap(tr.cell);
        const dt = TRACE_EVERY * FIXED_DT;
        const dAtp = (s.atp - tr.prev.atp) / dt;
        const dBio = (s.bio - tr.prev.bio) / dt;
        const dGlu = (s.glu - tr.prev.glu) / dt;
        tr.logBuf.push(
          `${tr.label.padEnd(8)} ` +
          `${(w.t - tr.bornAt).toFixed(0).padStart(3)}s` +
          ` ${s.atp.toFixed(1).padStart(5)} ${dAtp.toFixed(1).padStart(5)}` +
          ` ${s.bio.toFixed(1).padStart(5)} ${dBio.toFixed(2).padStart(5)}` +
          ` ${s.glu.toFixed(1).padStart(5)} ${dGlu.toFixed(2).padStart(5)}` +
          ` ${s.fa.toFixed(1).padStart(5)} ${s.aa.toFixed(1).padStart(4)} ${s.min.toFixed(1).padStart(4)}` +
          ` ${s.chl.toFixed(2).padStart(5)} ${s.enz.toFixed(2).padStart(4)}` +
          ` ${s.o2.toFixed(1).padStart(4)} ${s.co2.toFixed(1).padStart(4)}` +
          ` ${s.adp.toFixed(1).padStart(3)} ${s.waste.toFixed(1).padStart(5)}`
        );
        tr.prev = s;
      }
    }

    if (w.t >= nextSnapshot) {
      let ageSum = 0;
      for (const c of w.creatures) ageSum += (w.t - c.bornAt);
      const avgAge = w.creatures.length > 0 ? ageSum / w.creatures.length : 0;
      snapshots.push({
        t: w.t,
        pop: w.creatures.length,
        species: w.species.size,
        extinctions: w.extinctionCount,
        avgAge,
      });
      nextSnapshot += SNAPSHOT_EVERY;
    }
  }

  const parentByChildKey = new Map<string, string>();
  for (const ev of w.phylogenyEvents) parentByChildKey.set(ev.to, ev.from);

  const all = Array.from(records.values());
  const seeds = all.filter((r) => r.parentKey === undefined && r.bornAt === 0);
  const seedKey = seeds.length > 0 ? seeds[0].speciesKey : "";
  const children = all.filter((r) => parentByChildKey.get(r.speciesKey) === seedKey);
  const grandchildren = all.filter((r) => {
    const p = parentByChildKey.get(r.speciesKey);
    return p !== undefined && p !== seedKey && parentByChildKey.get(p) === seedKey;
  });

  const dead = all.filter((r) => r.diedAt !== null);
  const liveAtEnd = all.filter((r) => r.diedAt === null);
  const ages = dead.map((r) => r.diedAt! - r.bornAt).sort((a, b) => a - b);
  const median = ages.length > 0 ? ages[Math.floor(ages.length / 2)] : 0;
  const p10 = ages.length > 0 ? ages[Math.floor(ages.length * 0.1)] : 0;
  const p90 = ages.length > 0 ? ages[Math.floor(ages.length * 0.9)] : 0;

  const biomassDeaths = dead.filter((r) => r.deathBiomass < 1).length;
  const atpDeaths = dead.filter((r) => r.deathBiomass >= 1 && r.deathATP <= 0).length;
  const otherDeaths = dead.length - biomassDeaths - atpDeaths;

  console.log(`\n[lineage] over ${SIM_SEC}s of sim time:`);
  console.log(`  total births: ${all.length}, deaths: ${dead.length}, alive at end: ${liveAtEnd.length}`);
  console.log(`  extinctions (reseeds): ${w.extinctionCount}`);
  console.log(`  age-at-death p10/p50/p90: ${p10.toFixed(1)}s / ${median.toFixed(1)}s / ${p90.toFixed(1)}s`);
  console.log(`  death state:  biomass-bled=${biomassDeaths}  atp-starve=${atpDeaths}  other=${otherDeaths}`);
  console.log(`  ever-reproduced: ${all.filter((r) => r.everReproduced).length} / ${all.length}`);
  console.log(`  children of seed: ${children.length}, of which reproduced: ${children.filter((r) => r.everReproduced).length}`);
  console.log(`  grandchildren (2-deep): ${grandchildren.length}, of which reproduced: ${grandchildren.filter((r) => r.everReproduced).length}`);
  console.log(`\n  pop trajectory (every ${SNAPSHOT_EVERY}s):`);
  for (const s of snapshots) {
    console.log(`    t=${s.t.toFixed(0).padStart(4)}s  pop=${String(s.pop).padStart(3)}  species=${String(s.species).padStart(3)}  reseeds=${s.extinctions}  avgAge=${s.avgAge.toFixed(1)}s`);
  }

  console.log(`\n  per-cell traces (sampled every ${TRACE_EVERY} ticks = ${(TRACE_EVERY * FIXED_DT).toFixed(1)}s):`);
  console.log(`  ${header}`);
  for (const tr of traces) {
    console.log(`  --- ${tr.label} ---`);
    for (const ln of tr.logBuf.slice(0, 30)) console.log(`  ${ln}`);
    if (tr.logBuf.length > 30) console.log(`  ... ${tr.logBuf.length - 30} more lines`);
  }
}, 600_000);

// Long-run particle-count audit. Watches whether particle count
// stays near world.particleTarget or creeps over time. Reports
// snapshots and ingest/birth/death/excretion rates between snapshots.
test.skip("particle count trajectory", () => {
  const FIXED_DT = 1 / 60;
  const w = createWorld(800, 600);
  const SIM_SEC = 1800; // 30 sim-minutes
  const TICKS = Math.round(SIM_SEC / FIXED_DT);
  const SNAP = 60; // snapshot every 60 sim-sec

  let lastParts = w.particles.length;
  let lastBirths = 0;
  let lastDeaths = 0;
  const records: Array<{ t: number; pop: number; parts: number; cap: number; deltaParts: number; ext: number; species: number; lineages: number }> = [];
  let nextSnap = 0;
  let lastExt = w.extinctionCount;

  for (let i = 0; i < TICKS; i++) {
    const popBefore = w.creatures.length;
    step(w, FIXED_DT);
    const popAfter = w.creatures.length;
    if (popAfter > popBefore) lastBirths += popAfter - popBefore;
    else if (popAfter < popBefore) lastDeaths += popBefore - popAfter;

    if (w.t >= nextSnap) {
      const liveSpecies = new Set<string>();
      const liveLineages = new Set<number>();
      for (const c of w.creatures) {
        liveSpecies.add(c.speciesKey);
        liveLineages.add(c.lineageRoot);
      }
      records.push({
        t: w.t,
        pop: w.creatures.length,
        parts: w.particles.length,
        cap: w.particleTarget,
        deltaParts: w.particles.length - lastParts,
        ext: w.extinctionCount - lastExt,
        species: liveSpecies.size,
        lineages: liveLineages.size,
      });
      lastParts = w.particles.length;
      lastExt = w.extinctionCount;
      nextSnap += SNAP;
    }
  }

  console.log(`\n[parts] ${SIM_SEC}s sim, cap=${w.particleTarget}, total births=${lastBirths} deaths=${lastDeaths}`);
  console.log(`  t=    pop  parts  /cap   d(parts)  ext  sp/li`);
  for (const r of records) {
    const ratio = (r.parts / r.cap).toFixed(2);
    const d = r.deltaParts >= 0 ? `+${r.deltaParts}` : `${r.deltaParts}`;
    console.log(
      `  ${r.t.toFixed(0).padStart(5)}s ${String(r.pop).padStart(4)} ${String(r.parts).padStart(6)}  ${ratio.padStart(4)}x  ${d.padStart(7)}  ${String(r.ext).padStart(3)}  ${r.species}/${r.lineages}`,
    );
  }
}, 600_000);
