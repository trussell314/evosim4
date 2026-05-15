// Diagnostic: spin up a real world and watch what happens.
import { createWorld, step } from "../sim";

const w = createWorld(800, 600);
const seed = w.creatures[0];
console.log(`t=0  pop=${w.creatures.length}  parts=${w.particles.length}  seedR=${seed.r.toFixed(1)}  ATP=${seed.energy.toFixed(1)}`);

const dt = 1 / 60;
const totalSec = 60;
const sampleEverySec = 5;
let nextSample = sampleEverySec;
let births = 0;
let deaths = 0;
let prevPop = 1;

for (let i = 0; i < totalSec * 60; i++) {
  step(w, dt);
  const t = (i + 1) / 60;
  if (w.creatures.length > prevPop) births += (w.creatures.length - prevPop);
  if (w.creatures.length < prevPop) deaths += (prevPop - w.creatures.length);
  prevPop = w.creatures.length;
  if (t >= nextSample) {
    const c = w.creatures[0];
    const m = c ? c.molecules : null;
    const reserves = c ? c.molecules.biopolymer : 0;
    console.log(
      `t=${t.toFixed(0)}s  pop=${w.creatures.length}` +
      `  parts=${w.particles.length}` +
      `  extinct=${w.extinctionCount}` +
      `  species=${w.species.size}` +
      `  births=${births}  deaths=${deaths}` +
      (c ? `  | sample: ATP=${c.energy.toFixed(0)} reserves=${reserves.toFixed(0)} aa=${m!.aminoAcid.toFixed(0)} fa=${m!.fattyAcid.toFixed(0)} min=${m!.minerals.toFixed(0)} bio=${m!.membrane.toFixed(0)}` : "  | dead")
    );
    nextSample += sampleEverySec;
  }
}

console.log("---");
console.log(`final pop=${w.creatures.length} species=${w.species.size} extinctions=${w.extinctionCount} births=${births} deaths=${deaths}`);
