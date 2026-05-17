// 20-minute instrumented long-run. No DOM/renderer. Captures, per
// 60s window: full named-chem totals, cell/founder accounting, deaths
// by cause, per-chemical net reaction flux (mol), per-named-reaction
// execution counts, the ATP ledger, and the founder "biogenesis"
// matter injection. Auto-disables founders once they stop establishing
// lineages (i.e. fresh founders are only being consumed as food), then
// keeps running so we can see whether the population self-sustains.
//
//   npx tsx scripts/instrument20.ts [minutes] [outPrefix]
//
// defaults: 20 minutes, /tmp/instrument20

import {
  createWorld, step, serializeWorld,
  CHEM_BASE_DENSITY, CHEM_MOLAR_MASS,
  NAMED_CHEMICAL_COUNT, CHEM_SHORT_LABELS,
  reactionCatalog, reactionTotals, serializeRxnStats,
  NAMED_REACTION_NAMES,
} from "../src/sim";
import { writeFileSync } from "node:fs";

const minutes = Number(process.argv[2] ?? 20);
const outPrefix = process.argv[3] ?? "/tmp/instrument20";
const DT = 1 / 60;
const RUN_T = minutes * 60;
const SAMPLE = 60; // aligns with the sim's 60s reaction window
const STRIDE = CHEM_MOLAR_MASS.length;

const w = createWorld(800, 600, { delayedSpawn: true }) as any;
const cat = reactionCatalog();
const bioId = cat.findIndex((r) => r.external);

function chemTotal(k: number): number {
  let s = 0;
  for (const c of w.creatures) s += c.store.chemCols[k][c.idx];
  const A = w.ambient, R = w.reserve;
  for (let b = 0; b < A.length; b += STRIDE) s += A[b + k] + R[b + k];
  const ps = w.particleStore;
  for (let i = 0; i < w.particles.length; i++) {
    if (ps.chemId[i] !== k) continue;
    const r = ps.r[i];
    const d = ps.density[i] || (CHEM_BASE_DENSITY[k] || 1);
    s += (d * (4 / 3) * Math.PI * r * r * r) / (CHEM_MOLAR_MASS[k] || 1);
  }
  return s;
}

// Cumulative ATP ledger (label -> [consumed, produced]) read from the
// serialized rxnStats (cur + every retained window).
function atpCumulative(): { cons: number[]; prod: number[] } {
  const s = serializeRxnStats(w.rxnStats);
  const cons: number[] = [], prod: number[] = [];
  const add = (a: [number, number][] | undefined): void => {
    if (!a) return;
    for (const [idx, v] of a) {
      const label = idx >> 1;
      if (idx & 1) prod[label] = (prod[label] ?? 0) + v;
      else cons[label] = (cons[label] ?? 0) + v;
    }
  };
  add(s.cur && s.cur.a);
  for (const win of s.fine || []) add(win.a);
  for (const win of s.coarse || []) add(win.a);
  return { cons, prod };
}
const ATP_LABELS = ["idle", "vm", "thrust", "excrete", "ingest",
  "engulf", "predate", "reproduce", "rxnEndo", "rxnExo", "other"];

// Per-step founder accounting --------------------------------------
const seenFounderIds = new Set<number>();   // every id ever in founderIds
const everReproduced = new Set<number>();   // every id ever in founderReproduced
function pollFounders(): void {
  for (const id of w.founderIds) seenFounderIds.add(id);
  for (const id of w.founderReproduced) everReproduced.add(id);
}

const t0 = Date.now();
let prevTotals = reactionTotals(w).slice();
let prevSpawned = 0, prevEstab = 0;
let prevStats = { ...(w.stats) };
let prevAtp = atpCumulative();
let prevExt = w.extinctionCount;
let lowEffStreak = 0;
let foundersDisabledAt: number | null = null;

interface Sample {
  t: number;
  cells: number; foundersAlive: number; nonFounder: number;
  estLineages: number;        // distinct lineageRoot among non-founder cells
  liveLineages: number;       // distinct lineageRoot among all cells
  spawnedDelta: number; estabDelta: number; estabEff: number;
  births: number; dStarve: number; dMembrane: number; dMrna: number; dAa: number; dOld: number;
  extDelta: number;
  chem: Record<string, number>;
  chemFlux: Record<string, number>;     // net mol this window (prod - cons), reactions only
  rxn: Record<string, number>;          // named-reaction executions this window
  bioInject: Record<string, number>;    // founder biogenesis matter injected this window (mol)
  atpProd: Record<string, number>; atpCons: Record<string, number>;
  foundersEnabled: boolean;
}
const samples: Sample[] = [];

let nextSample = 0;
for (let i = 0; w.t < RUN_T; i++) {
  step(w, DT);
  pollFounders();
  if (w.t >= nextSample) {
    nextSample += SAMPLE;

    // Per-reaction executions this window (cumulative delta).
    const totals = reactionTotals(w);
    const chemFlux: number[] = new Array(NAMED_CHEMICAL_COUNT).fill(0);
    const rxn: Record<string, number> = {};
    const bioInject: Record<string, number> = {};
    for (let id = 0; id < totals.length; id++) {
      const d = totals[id] - (prevTotals[id] ?? 0);
      if (d === 0) continue;
      const info = cat[id];
      if (!info) continue;
      if (info.external) {
        for (const p of info.produces) {
          if (p.chem < NAMED_CHEMICAL_COUNT)
            bioInject[CHEM_SHORT_LABELS[p.chem]] = (bioInject[CHEM_SHORT_LABELS[p.chem]] ?? 0) + d * p.coef;
        }
        continue; // excluded from net flux (external input)
      }
      if (id < NAMED_REACTION_NAMES.length && d > 0)
        rxn[NAMED_REACTION_NAMES[id]] = (rxn[NAMED_REACTION_NAMES[id]] ?? 0) + d;
      for (const p of info.produces) if (p.chem < NAMED_CHEMICAL_COUNT) chemFlux[p.chem] += d * p.coef;
      for (const c of info.consumes) if (c.chem < NAMED_CHEMICAL_COUNT) chemFlux[c.chem] -= d * c.coef;
    }
    prevTotals = totals.slice();

    const chem: Record<string, number> = {};
    for (let k = 0; k < NAMED_CHEMICAL_COUNT; k++) chem[CHEM_SHORT_LABELS[k]] = chemTotal(k);
    const fluxObj: Record<string, number> = {};
    for (let k = 0; k < NAMED_CHEMICAL_COUNT; k++)
      if (Math.abs(chemFlux[k]) > 1e-6) fluxObj[CHEM_SHORT_LABELS[k]] = chemFlux[k];

    let foundersAlive = 0;
    const estRoots = new Set<number>(), allRoots = new Set<number>();
    for (const c of w.creatures) {
      allRoots.add(c.lineageRoot);
      if (w.founderIds.has(c.id)) foundersAlive++;
      else estRoots.add(c.lineageRoot);
    }
    const cells = w.creatures.length;

    const spawnedDelta = seenFounderIds.size - prevSpawned;
    const estabDelta = everReproduced.size - prevEstab;
    prevSpawned = seenFounderIds.size; prevEstab = everReproduced.size;
    const estabEff = spawnedDelta > 0 ? estabDelta / spawnedDelta : (estabDelta > 0 ? 1 : 0);

    const st = w.stats;
    const dB = st.births - prevStats.births;
    const dSt = st.dStarve - prevStats.dStarve;
    const dMe = st.dMembrane - prevStats.dMembrane;
    const dMr = st.dMrna - prevStats.dMrna;
    const dAa = st.dAa - prevStats.dAa;
    const dOl = st.dOld - prevStats.dOld;
    prevStats = { ...st };
    const extDelta = w.extinctionCount - prevExt;
    prevExt = w.extinctionCount;

    const atp = atpCumulative();
    const atpProd: Record<string, number> = {}, atpCons: Record<string, number> = {};
    for (let l = 0; l < ATP_LABELS.length; l++) {
      const p = (atp.prod[l] ?? 0) - (prevAtp.prod[l] ?? 0);
      const c = (atp.cons[l] ?? 0) - (prevAtp.cons[l] ?? 0);
      if (p > 1e-6) atpProd[ATP_LABELS[l]] = p;
      if (c > 1e-6) atpCons[ATP_LABELS[l]] = c;
    }
    prevAtp = atp;

    // Founder-as-food trigger: after warmup, if fresh founders stop
    // establishing lineages (efficiency near zero) for 3 consecutive
    // minutes while the world is NOT extinction-threatened, founders
    // are only feeding the incumbent churn -> disable + observe.
    if (foundersDisabledAt === null && w.t >= 360 && w.initialSeedDone) {
      if (estabEff < 0.05 && cells >= 30 && spawnedDelta > 0) lowEffStreak++;
      else lowEffStreak = 0;
      if (lowEffStreak >= 3) {
        w.foundersEnabled = false;
        foundersDisabledAt = w.t;
        console.log(`>>> founders DISABLED at t=${w.t.toFixed(0)}s (estabEff~${estabEff.toFixed(3)}, cells=${cells})`);
      }
    }

    samples.push({
      t: w.t, cells, foundersAlive, nonFounder: cells - foundersAlive,
      estLineages: estRoots.size, liveLineages: allRoots.size,
      spawnedDelta, estabDelta, estabEff,
      births: dB, dStarve: dSt, dMembrane: dMe, dMrna: dMr, dAa: dAa, dOld: dOl,
      extDelta,
      chem, chemFlux: fluxObj, rxn, bioInject, atpProd, atpCons,
      foundersEnabled: w.foundersEnabled !== false,
    });

    const wall = ((Date.now() - t0) / 1000).toFixed(0);
    const topFlux = Object.entries(fluxObj).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 4)
      .map(([k, v]) => `${k}${v >= 0 ? "+" : ""}${v.toFixed(0)}`).join(" ");
    console.log(
      `t=${String(w.t.toFixed(0)).padStart(4)}s wall=${wall}s ` +
      `cells=${String(cells).padStart(4)} fnd=${String(foundersAlive).padStart(3)} ` +
      `estLin=${String(estRoots.size).padStart(3)} eff=${estabEff.toFixed(2)} ` +
      `B=${String(dB).padStart(4)} dStrv=${String(dSt).padStart(4)} dMem=${String(dMe).padStart(3)} ` +
      `dMrna=${String(dMr).padStart(3)} dAa=${String(dAa).padStart(3)} ext=${extDelta} | flux ${topFlux}`,
    );
    try { writeFileSync(`${outPrefix}-save.json`, serializeWorld(w)); } catch { /* ignore */ }
  }
}

writeFileSync(`${outPrefix}.json`, JSON.stringify({
  minutes, runT: RUN_T, foundersDisabledAt, bioReactionId: bioId,
  wallSec: (Date.now() - t0) / 1000, samples,
}, null, 2));
try { writeFileSync(`${outPrefix}-save.json`, serializeWorld(w)); } catch { /* ignore */ }
console.log(`done: ${minutes} sim-min in ${((Date.now() - t0) / 1000).toFixed(0)}s wall.`);
console.log(`report -> ${outPrefix}.json ; save -> ${outPrefix}-save.json`);
console.log(`foundersDisabledAt=${foundersDisabledAt}`);
