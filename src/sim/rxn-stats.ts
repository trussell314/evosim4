// Reaction / ATP accounting data model + (de)serialization. Pure:
// depends only on the rxn-id space (NREACT / ATP_LABEL_COUNT). The
// World-coupled recording hot path (recordRxn/recordAtp,
// rollReactionWindow, reactionTotals) stays in sim.ts.

import { NREACT, ATP_LABEL_COUNT } from "./rxn-ids";

export interface RxnWindow { t0: number; rxn: Int32Array; atp: Float64Array; }
export interface RxnStats {
  windowStart: number;
  curRxn: Int32Array;   // NREACT*2*2
  curAtp: Float64Array; // ATP_LABEL_COUNT*2 (k0 consumed, k1 produced)
  fine: RxnWindow[];    // 60s windows, < 1h old
  coarse: RxnWindow[];  // 300s aggregates, >= 1h old
}
export function newRxnStats(): RxnStats {
  return {
    windowStart: 0,
    curRxn: new Int32Array(NREACT * 4),
    curAtp: new Float64Array(ATP_LABEL_COUNT * 2),
    fine: [],
    coarse: [],
  };
}

// Sparse (idx,value) encoding so the save stays small -- most generic
// reaction slots never fire.
type RxnSparse = [number, number][];
interface SavedRxnWindow { t0: number; r: RxnSparse; a: RxnSparse; }
export interface SavedRxnStats {
  windowStart: number;
  cur: SavedRxnWindow;
  fine: SavedRxnWindow[];
  coarse: SavedRxnWindow[];
}
function sparseInt(a: Int32Array): RxnSparse {
  const o: RxnSparse = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== 0) o.push([i, a[i]]);
  return o;
}
function sparseFloat(a: Float64Array): RxnSparse {
  const o: RxnSparse = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== 0) o.push([i, a[i]]);
  return o;
}
function denseInt(len: number, p: RxnSparse | undefined): Int32Array {
  const a = new Int32Array(len);
  if (p) for (const [i, v] of p) if (i >= 0 && i < len) a[i] = v;
  return a;
}
function denseFloat(len: number, p: RxnSparse | undefined): Float64Array {
  const a = new Float64Array(len);
  if (p) for (const [i, v] of p) if (i >= 0 && i < len) a[i] = v;
  return a;
}
function snapToSaved(w: RxnWindow): SavedRxnWindow {
  return { t0: w.t0, r: sparseInt(w.rxn), a: sparseFloat(w.atp) };
}
function savedToSnap(s: SavedRxnWindow): RxnWindow {
  return {
    t0: s.t0,
    rxn: denseInt(NREACT * 4, s.r),
    atp: denseFloat(ATP_LABEL_COUNT * 2, s.a),
  };
}
export function serializeRxnStats(rs: RxnStats): SavedRxnStats {
  return {
    windowStart: rs.windowStart,
    cur: { t0: rs.windowStart, r: sparseInt(rs.curRxn), a: sparseFloat(rs.curAtp) },
    fine: rs.fine.map(snapToSaved),
    coarse: rs.coarse.map(snapToSaved),
  };
}
export function deserializeRxnStats(s: SavedRxnStats): RxnStats {
  return {
    windowStart: s.windowStart,
    curRxn: denseInt(NREACT * 4, s.cur && s.cur.r),
    curAtp: denseFloat(ATP_LABEL_COUNT * 2, s.cur && s.cur.a),
    fine: (s.fine || []).map(savedToSnap),
    coarse: (s.coarse || []).map(savedToSnap),
  };
}
// Per-window reaction counts (id -> total executions in that window,
// loc+catalyzed summed), ordered oldest..newest (coarse, fine, then
// the in-progress window). Drives the reaction-detail time graph.
export function reactionWindowSeries(s: SavedRxnStats): { t0: number; counts: Int32Array }[] {
  const mk = (w: SavedRxnWindow): { t0: number; counts: Int32Array } => {
    const dense = denseInt(NREACT * 4, w.r);
    const counts = new Int32Array(NREACT);
    for (let id = 0; id < NREACT; id++) {
      const b = id * 4;
      counts[id] = dense[b] + dense[b + 1] + dense[b + 2] + dense[b + 3];
    }
    return { t0: w.t0, counts };
  };
  const out = [...(s.coarse || []), ...(s.fine || [])].map(mk);
  if (s.cur) out.push(mk(s.cur));
  return out;
}
