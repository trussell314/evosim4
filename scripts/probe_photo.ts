// Confirm photosynthesis is net-positive in perfect conditions:
// a cell at the lit surface, full chlorophyll, ample CO2, daylight.
// out[3] has no gateMask + uncatRate>0 so it runs for any cell with
// chl>0 / light>0 / CO2>0 / energy>0 -- no genome needed.
import { createWorld, step, regionCols, regionRows, CHEM_IDS } from "../src/sim";

const w = createWorld(800, 600) as any;
w.dayPhase = 0.25; // solarLight() = sin(pi/2) = 1 (max)
const STRIDE = w.ambient.length / (regionCols(w) * regionRows(w));
const floodCO2 = (): void => {
  for (let b = 0; b + CHEM_IDS.co2 < w.ambient.length; b += STRIDE) w.ambient[b + CHEM_IDS.co2] = 50;
};
floodCO2();

const c = w.creatures[0];
const s = c.store, i = c.idx;
c.x = w.width * 0.5;
s.m_chlorophyll[i] = 5; // == CHL_REF -> full photosynthesis rate
s.m_mrna[i] = 5;        // == MRNA_REF
s.energy[i] = 20;
s.m_glucose[i] = 0;
s.m_o2[i] = 0;
s.m_co2[i] = 50;

const rd = (): string =>
  `glu=${s.m_glucose[i].toFixed(2)} o2=${s.m_o2[i].toFixed(2)} ` +
  `co2cell=${s.m_co2[i].toFixed(2)} E=${s.energy[i].toFixed(2)} chl=${s.m_chlorophyll[i].toFixed(2)}`;
console.log("t0   ", rd());
for (let n = 0; n < 6; n++) {
  for (let k = 0; k < 60; k++) {
    c.y = w.surfaceY + 5; // keep it lit (no drifting down)
    s.m_co2[i] = 50;      // isolate photosynthesis from CO2 limitation
    step(w, 1 / 60);
  }
  console.log(`t${n + 1}s  `, rd());
}
