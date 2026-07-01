// Find reactions involving chem46 as substrate or product.
import { REACTIONS } from "../src/sim/reactions";

const CHEM_ID = 46;
const out: { slot: number; role: string; rxn: any }[] = [];
for (let i = 0; i < REACTIONS.length; i++) {
  const r = REACTIONS[i];
  const sIdx = Array.from(r.sChem).indexOf(CHEM_ID);
  const pIdx = Array.from(r.pChem).indexOf(CHEM_ID);
  if (sIdx >= 0) out.push({ slot: i, role: `substrate(${r.sCount[sIdx]})`, rxn: r });
  if (pIdx >= 0) out.push({ slot: i, role: `product(${r.pCount[pIdx]})`, rxn: r });
}
for (const o of out) {
  const r = o.rxn;
  const sStr = Array.from(r.sChem as Uint8Array).map((c: number, j: number) => `${r.sCount[j].toFixed(2)}*c${c}`).join(" + ");
  const pStr = Array.from(r.pChem as Uint8Array).map((c: number, j: number) => `${r.pCount[j].toFixed(2)}*c${c}`).join(" + ");
  console.log(`slot ${o.slot} (${o.role}): ${sStr} -> ${pStr}  atpΔ=${r.atpDelta.toFixed(3)} vmax=${r.vmax.toFixed(3)} uncat=${r.uncatRate.toFixed(4)} light=${r.lightIn}`);
}
