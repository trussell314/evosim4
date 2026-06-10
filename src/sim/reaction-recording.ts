// Reaction / ATP accounting -- the World-coupled recording hot path.
//
// Raw occurrence counts for every chemical transformation (the 256-slot
// REACTIONS table run in cells/organelles, catalyst synthesis, plus the
// non-table conversions: maintenance decay, toxify, death catalyst
// denature, waste denature), split by location (in a cell vs in a
// field) and whether a catalyst was present. Plus a separate ATP
// ledger: how much ATP each source consumed/produced. Bucketed into
// 60-second windows; windows older than 1h compact to 5-minute
// buckets. Persisted with the save.
//
// Reaction-id space + ATP-ledger labels live in ./rxn-ids; the RxnStats
// data model + (de)serialization live in ./rxn-stats. Only the
// World-coupled recording entry points live here.

import { rxIdx } from "./rxn-ids";
import type { RxnWindow } from "./rxn-stats";
import type { World } from "./core";

// Set once per step() (chemistry is single-threaded in the sim worker)
// so the deep reaction/decay/spendATP paths can record without
// threading `world` through five hot signatures.
let RXN_STATS_WORLD: World | undefined;
export function setRxnStatsWorld(world: World): void {
  RXN_STATS_WORLD = world;
}
export function recordRxn(id: number, loc: number, cat: number): void {
  const rs = RXN_STATS_WORLD && RXN_STATS_WORLD.rxnStats;
  if (rs) rs.curRxn[rxIdx(id, loc, cat)]++;
}
export function recordAtp(label: number, consumed: number, produced: number): void {
  const rs = RXN_STATS_WORLD && RXN_STATS_WORLD.rxnStats;
  if (!rs) return;
  if (consumed) rs.curAtp[label * 2] += consumed;
  if (produced) rs.curAtp[label * 2 + 1] += produced;
}
const RXN_WINDOW_SEC = 60;
const RXN_FINE_RETAIN_SEC = 3600; // keep 60s windows for the last hour
const RXN_COARSE_SEC = 300;       // older windows compact to 5-minute buckets
export function rollReactionWindow(world: World): void {
  const rs = world.rxnStats;
  if (!rs) return;
  while (world.t - rs.windowStart >= RXN_WINDOW_SEC) {
    rs.fine.push({ t0: rs.windowStart, rxn: rs.curRxn.slice(), atp: rs.curAtp.slice() });
    rs.curRxn.fill(0);
    rs.curAtp.fill(0);
    rs.windowStart += RXN_WINDOW_SEC;
  }
  const cutoff = world.t - RXN_FINE_RETAIN_SEC;
  while (rs.fine.length > 0 && rs.fine[0].t0 < cutoff) {
    const w = rs.fine.shift() as RxnWindow;
    const bucket = Math.floor(w.t0 / RXN_COARSE_SEC) * RXN_COARSE_SEC;
    const last = rs.coarse.length > 0 ? rs.coarse[rs.coarse.length - 1] : undefined;
    if (last && last.t0 === bucket) {
      for (let i = 0; i < w.rxn.length; i++) last.rxn[i] += w.rxn[i];
      for (let i = 0; i < w.atp.length; i++) last.atp[i] += w.atp[i];
    } else {
      rs.coarse.push({ t0: bucket, rxn: w.rxn, atp: w.atp });
    }
  }
}
