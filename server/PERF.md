# Engine perf

Per-tick wall-clock metrics are first-class state on the `Engine`.
`PerfCollector` instruments every major pass in `step()` and ships
EMA-smoothed numbers in every snapshot (`Snapshot::perf`). The TUI
exposes them under `m`; the `evosim-bench` headless probe records
them over time.

## What's measured

21 per-pass buckets and the total tick time:

  forces, collision, particle_decay, vm, creature_collision,
  obstacle_collision, cell_reactions, transport, ambient, diffuse,
  precipitation, region_temp, vent, predate, ingest, reproduction,
  death, maintenance, bonding, activation, snapshot

Plus live counts (particle store length, creature count). EMA alpha
is 0.1; cold-start jumps straight to the first sample so the report
isn't all zeros for the first ~50 ticks.

## Watching metrics live

`m` in the TUI toggles between the population history (cells /
species / mass) and the perf view (tick wall-time + particles
sparklines + top-N most expensive passes).

## Benchmarking changes

`evosim-bench` is the headless probe. Connects to a running server,
drains snapshots for `--secs` seconds (after a `--warmup-secs`
window), reports mean / p50 / p95 / p99 / max for tick_ms plus
mean / max for particles + creatures, plus the top-10 most expensive
passes by mean ms.

```sh
# start a server
EVOSIM_PARTICLE_CAP=500 ./target/release/evosim-server &
SP=$!
sleep 4

# record a benchmark
./target/release/evosim-bench \
  --url ws://127.0.0.1:8080/sim \
  --secs 60 --warmup-secs 5 \
  --label "cap=500" \
  --csv /tmp/cap500.csv

kill $SP
```

`--csv` writes one row per snapshot for plotting / regression
tracking.

## Knobs

- `EVOSIM_PARTICLE_CAP=<n>` env var sets the global rendered-particle
  cap before `Engine` startup. `0` is a literal cap of 0 -- the
  field drains as decay ages existing particles out. To opt out of
  the cap entirely, set the var to `none` / `off` / `unbounded`.
  Default in code is 3000.
- `EVOSIM_BIND`, `EVOSIM_ADMIN_TOKEN` -- see `server/README.md`.

## Baseline (default scene, sim_rate=1, 60 sim seconds, release)

### Uncapped (`EVOSIM_PARTICLE_CAP=none`)

```
tick_ms          mean 2.43  p50 2.39  p95 3.28  p99 3.72  max 3.74
particles        mean 1047  max 1212
creatures        mean 84    max 84
per-pass top:
  obstacle_collision   0.762   31.4%
  collision            0.350   14.4%
  vm                   0.332   13.7%
  diffuse              0.250   10.3%
  activation           0.193    7.9%
```

### cap=500 (60-second run)

```
tick_ms          mean 1.38  p50 1.32  p95 1.60  p99 1.69  max 1.77
particles        mean 500   max 500
creatures        mean 55    max 81
per-pass top:
  obstacle_collision   0.285   20.6%
  diffuse              0.239   17.3%
  vm                   0.236   17.1%
  collision            0.210   15.2%
```

Net: **-43% tick_ms**, particles bound at the cap, per-particle
passes (obstacle_collision / collision / forces) scale linearly with
the cap. Per-cell passes (vm) and per-region passes (diffuse,
region_temp) are unaffected.

## Methodology notes for future regression tracking

- **Warmup matters.** EMA convergence + CPU cache effects make the
  first few seconds noisy. `--warmup-secs 5` is the default; bump
  for tighter measurements.
- **Snapshot cadence is 10 Hz.** Per-snapshot perf is an EMA of the
  ticks that ran since the previous snapshot, not a single tick.
  So 60s of sampling = ~600 samples = good convergence.
- **Watch the per-pass percentages, not just total.** A regression
  that lifts diffuse from 10% to 25% but drops tick_ms slightly
  could mask a structural issue (e.g. broken solid-mask reject).
- **Use the CSV for plotting.** One row per snapshot; the `t` column
  is sim seconds. `tick_ms` and `particles` columns trace cleanly
  through gnuplot / python.
