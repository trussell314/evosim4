// One-off headless profile. Skipped in the regular test suite (it
// takes 30+ seconds even on fast machines). Run it on demand with
//   npx vitest run -t "profile under load"
// or change the .skip below to .only when iterating.
import { test } from "vitest";
import { createWorld, step, makeProfile } from "../sim";

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
