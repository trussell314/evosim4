//! In-process headless runner for the evosim engine. No network, no
//! TUI, no client -- just a CLI you can point at a fresh world (or
//! a saved JSON) and run for N ticks while it prints periodic stats.
//! Equivalent of the TS `scripts/headless.ts`.
//!
//! Examples
//!   # Fresh world, 60_000 ticks, stats every 1000:
//!   cargo run --release -p evosim-headless -- --ticks 60000 --report-every 1000
//!
//!   # Load a saved JSON, run 5000 ticks, dump the final state:
//!   cargo run --release -p evosim-headless -- \
//!       --load saves/run42.json --ticks 5000 --out final.json

use anyhow::{Context, Result};
use clap::Parser;
use evosim_engine::Engine;
use std::collections::HashMap;
use std::fs;
use std::time::Instant;

/// Fixed engine dt -- matches what `evosim-server` uses.
const TICK_DT: f64 = 1.0 / 60.0;

#[derive(Parser, Debug)]
#[command(
    name = "evosim-headless",
    about = "In-process headless evosim runner. No network, no UI."
)]
struct Cli {
    /// Number of ticks to advance.
    #[arg(long, default_value_t = 60_000u64)]
    ticks: u64,
    /// Print stats every N ticks. 0 disables periodic output.
    #[arg(long, default_value_t = 1_000u64)]
    report_every: u64,
    /// Optional saved JSON to load before stepping. Schema r4 / r5
    /// both accepted via the engine's `accepted_legacy_schemas`.
    #[arg(long)]
    load: Option<String>,
    /// World width / height (only used when --load is omitted).
    #[arg(long)]
    width: Option<f32>,
    #[arg(long)]
    height: Option<f32>,
    /// Seed override (only used when --load is omitted).
    #[arg(long)]
    seed: Option<u32>,
    /// Day period seconds (only used when --load is omitted).
    #[arg(long)]
    day_period_s: Option<f64>,
    /// Founders per strategy (only used when --load is omitted).
    #[arg(long)]
    founders_per_strategy: Option<u32>,
    /// Mutation-rate scale. 1.0 = engine default.
    #[arg(long, default_value_t = 1.0f32)]
    mutation_rate: f32,
    /// Particle cap (omit for engine default).
    #[arg(long)]
    particle_cap: Option<usize>,
    /// Write final world JSON to this path.
    #[arg(long)]
    out: Option<String>,
    /// Quiet -- suppress periodic reports, only print the final summary.
    #[arg(long)]
    quiet: bool,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let mut engine = Engine::new();

    if cli.width.is_some()
        || cli.height.is_some()
        || cli.seed.is_some()
        || cli.day_period_s.is_some()
        || cli.founders_per_strategy.is_some()
    {
        engine.configure(
            cli.width,
            cli.height,
            cli.seed,
            cli.day_period_s,
            cli.founders_per_strategy,
        );
    }
    if let Some(path) = cli.load.as_deref() {
        let json = fs::read_to_string(path)
            .with_context(|| format!("read {path}"))?;
        engine
            .load_json(&json)
            .map_err(|e| anyhow::anyhow!("load: {e}"))?;
    }
    engine.mutation_rate_scale = cli.mutation_rate.clamp(0.0, 16.0) as f64;
    engine.set_particle_cap(cli.particle_cap);

    let started = Instant::now();
    let mut last_report = Instant::now();
    if !cli.quiet {
        print_header();
    }
    let mut window_start_tick = 0u64;
    for tick in 1..=cli.ticks {
        engine.step(TICK_DT);
        if cli.report_every > 0 && !cli.quiet && tick % cli.report_every == 0 {
            let elapsed = last_report.elapsed().as_secs_f64();
            let dticks = (tick - window_start_tick).max(1) as f64;
            print_row(&mut engine, tick, elapsed * 1000.0 / dticks);
            last_report = Instant::now();
            window_start_tick = tick;
        }
    }
    let elapsed = started.elapsed();

    // Final summary always prints, even with --quiet, so a script
    // piping our stdout gets one row at the end.
    println!();
    println!("--- final ---");
    let snap = engine.snapshot();
    let species = species_breakdown(&engine);
    println!(
        "wall_clock_s={:.2}  ticks={}  tps={:.1}",
        elapsed.as_secs_f64(),
        cli.ticks,
        cli.ticks as f64 / elapsed.as_secs_f64().max(1e-9),
    );
    println!(
        "cells={}  species={}  particles={}  mass_total={:.0}",
        snap.creatures.count,
        snap.top_species.len(),
        snap.particles.count,
        snap.mass.total,
    );
    if !species.is_empty() {
        println!("top species:");
        for (key, count) in species.iter().take(5) {
            println!("  {count:>5}  {key}");
        }
    }

    if let Some(out) = cli.out {
        let json = engine
            .save_json()
            .map_err(|e| anyhow::anyhow!("save: {e}"))?;
        fs::write(&out, json).with_context(|| format!("write {out}"))?;
        println!("wrote final world to {out}");
    }
    Ok(())
}

fn print_header() {
    println!(
        "{:>8}  {:>6}  {:>5}  {:>6}  {:>9}  {:>7}  {:>7}",
        "tick", "cells", "spec", "parts", "mass", "ms/tick", "atp_tot",
    );
}

fn print_row(engine: &mut Engine, tick: u64, ms_per_tick: f64) {
    let snap = engine.snapshot();
    let atp_total: f64 = snap.top_species.iter().map(|s| s.atp as f64).sum();
    println!(
        "{:>8}  {:>6}  {:>5}  {:>6}  {:>9.0}  {:>7.3}  {:>7.0}",
        tick,
        snap.creatures.count,
        snap.top_species.len(),
        snap.particles.count,
        snap.mass.total,
        ms_per_tick,
        atp_total,
    );
}

fn species_breakdown(engine: &Engine) -> Vec<(String, u32)> {
    let cs = &engine.world().creature_store;
    let mut counts: HashMap<String, u32> = HashMap::new();
    for g in &cs.genome {
        let k = evosim_engine::genome::coding_key(g);
        *counts.entry(k).or_insert(0) += 1;
    }
    let mut ranked: Vec<(String, u32)> = counts.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1));
    ranked
}
