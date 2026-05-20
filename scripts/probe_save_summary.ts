// Probe: summarize a saved headless world. Reports particle count by
// chem, total mass, creature population breakdown.
import { readFileSync } from "node:fs";

const path = process.argv[2] ?? "/tmp/headless-run.json";
const save = JSON.parse(readFileSync(path, "utf8"));
const w = save.world ?? save;
console.log(`t=${(w.t ?? 0).toFixed(0)}s`);
console.log(`particles=${w.particles?.length ?? 0}  creatures=${w.creatures?.length ?? 0}`);
if (w.particles) {
  const byChem: Record<number, number> = {};
  for (const p of w.particles) byChem[p.chemId] = (byChem[p.chemId] ?? 0) + 1;
  console.log("particle count by chemId:");
  for (const [k, v] of Object.entries(byChem).sort((a, b) => Number(b[1]) - Number(a[1]))) {
    console.log(`  chem ${k.toString().padStart(2)}: ${v.toString().padStart(5)}`);
  }
}
if (w.atmosphere) {
  let totalAtm = 0;
  for (const k in w.atmosphere) totalAtm += w.atmosphere[k];
  console.log(`atmosphere total: ${totalAtm.toFixed(0)}`);
}
if (w.creatures && w.creatures.length > 0) {
  // Quick read of how many cells have which chems above threshold.
  let withChl = 0, withMem = 0, withFa = 0;
  for (const c of w.creatures) {
    const m = c.molecules ?? c.chems ?? c;
    if ((m.chlorophyll ?? 0) > 0.01) withChl++;
    if ((m.membrane ?? 0) > 0.01) withMem++;
    if ((m.fattyAcid ?? 0) > 0.01) withFa++;
  }
  console.log(`creatures with: chl=${withChl}/${w.creatures.length} mem=${withMem} fa=${withFa}`);
}
if (w.stats) {
  console.log(`stats: ${JSON.stringify(w.stats)}`);
}
if (w.extinctionCount !== undefined) {
  console.log(`extinctions=${w.extinctionCount} liveLineages=${w.liveLineageRoots?.length ?? "?"}`);
}
