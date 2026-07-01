//! Headless perf probe. Connects to evosim-server, records perf
//! samples from every snapshot for N seconds, prints summary stats
//! (mean / p50 / p95 / p99 of tick_ms, particle / creature counts,
//! per-pass total cost). Used to quantify perf-related changes
//! before/after.
//!
//! Run:
//!   cargo run --release -p evosim-tui --bin evosim-bench -- \
//!     --url ws://127.0.0.1:8080/sim --secs 60
//!
//! Optional `--csv path` writes one row per snapshot for plotting.

use anyhow::{Context, Result};
use clap::Parser;
use evosim_protocol::{
    decode_server, encode_client, ClientMessage, PerfReport, ServerMessage,
};
use futures_util::{SinkExt, StreamExt};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::time::{Duration, Instant};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

#[derive(Parser, Debug)]
#[command(
    name = "evosim-bench",
    about = "Headless perf probe for the evosim engine"
)]
struct Cli {
    /// WebSocket URL of the running server.
    #[arg(long, default_value = "ws://127.0.0.1:8080/sim")]
    url: String,
    /// Admin bearer token. Reads from `EVOSIM_ADMIN_TOKEN` env when unset.
    #[arg(long, env = "EVOSIM_ADMIN_TOKEN")]
    token: Option<String>,
    /// How many sim-seconds to record. Wall-clock approximate (the
    /// engine ticks at its configured rate); 60 is a reasonable default.
    #[arg(long, default_value_t = 60)]
    secs: u64,
    /// Optional CSV output -- one row per snapshot, columns
    /// `t,tick,particles,creatures,tick_ms,<pass>_ms...`.
    #[arg(long)]
    csv: Option<String>,
    /// Label to print at the top of the summary so multiple runs are
    /// easy to compare.
    #[arg(long, default_value = "")]
    label: String,
    /// Reset the engine before sampling. Requires `--token`.
    #[arg(long, default_value_t = false)]
    reset: bool,
    /// Warmup window in wall-clock seconds before counting samples.
    /// Lets the engine settle from cold start (EMA filter convergence,
    /// CPU caches, JIT path, etc.) so the recorded numbers reflect
    /// steady-state behaviour.
    #[arg(long, default_value_t = 5)]
    warmup_secs: u64,
}

#[derive(Default)]
struct Series {
    tick_ms: Vec<f32>,
    particles: Vec<u32>,
    creatures: Vec<u32>,
    perf_sum: PerfReport,
    perf_n: usize,
}

impl Series {
    fn push(&mut self, p: &PerfReport) {
        self.tick_ms.push(p.tick_ms);
        self.particles.push(p.particle_count);
        self.creatures.push(p.creature_count);
        // Sum per-pass values for a true ms-total report. Means come
        // out as sum / count.
        add(&mut self.perf_sum, p);
        self.perf_n += 1;
    }

    fn report(&self, label: &str) {
        if self.tick_ms.is_empty() {
            eprintln!("no samples collected");
            return;
        }
        let mut sorted = self.tick_ms.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let mean = sorted.iter().sum::<f32>() / sorted.len() as f32;
        let pct = |q: f32| sorted[((sorted.len() as f32 - 1.0) * q) as usize];
        let particles_mean =
            self.particles.iter().map(|v| *v as f64).sum::<f64>() / self.particles.len() as f64;
        let particles_max = *self.particles.iter().max().unwrap_or(&0);
        let creatures_mean =
            self.creatures.iter().map(|v| *v as f64).sum::<f64>() / self.creatures.len() as f64;
        let creatures_max = *self.creatures.iter().max().unwrap_or(&0);
        let banner = if label.is_empty() {
            "perf report".to_string()
        } else {
            format!("perf report [{label}]")
        };
        println!("=== {banner} ===");
        println!("samples           {}", self.tick_ms.len());
        println!(
            "tick_ms           mean {:.2}  p50 {:.2}  p95 {:.2}  p99 {:.2}  max {:.2}",
            mean,
            pct(0.50),
            pct(0.95),
            pct(0.99),
            sorted[sorted.len() - 1],
        );
        println!(
            "particles         mean {:.0}  max {}",
            particles_mean, particles_max
        );
        println!(
            "creatures         mean {:.0}  max {}",
            creatures_mean, creatures_max
        );
        println!("--- per-pass mean ms (top 10) ---");
        let mut pairs = report_pairs(&self.perf_sum, self.perf_n);
        pairs.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        for (name, ms) in pairs.iter().take(10) {
            let share = if mean > 0.0 { ms / mean * 100.0 } else { 0.0 };
            println!("  {name:<18} {ms:>7.3}  {share:>5.1}%");
        }
    }
}

fn add(acc: &mut PerfReport, p: &PerfReport) {
    acc.tick_ms += p.tick_ms;
    acc.forces_ms += p.forces_ms;
    acc.collision_ms += p.collision_ms;
    acc.particle_decay_ms += p.particle_decay_ms;
    acc.vm_ms += p.vm_ms;
    acc.creature_collision_ms += p.creature_collision_ms;
    acc.obstacle_collision_ms += p.obstacle_collision_ms;
    acc.cell_reactions_ms += p.cell_reactions_ms;
    acc.transport_ms += p.transport_ms;
    acc.ambient_ms += p.ambient_ms;
    acc.diffuse_ms += p.diffuse_ms;
    acc.precipitation_ms += p.precipitation_ms;
    acc.region_temp_ms += p.region_temp_ms;
    acc.vent_ms += p.vent_ms;
    acc.predate_ms += p.predate_ms;
    acc.ingest_ms += p.ingest_ms;
    acc.reproduction_ms += p.reproduction_ms;
    acc.death_ms += p.death_ms;
    acc.maintenance_ms += p.maintenance_ms;
    acc.bonding_ms += p.bonding_ms;
    acc.activation_ms += p.activation_ms;
    acc.snapshot_ms += p.snapshot_ms;
}

fn report_pairs(sum: &PerfReport, n: usize) -> Vec<(&'static str, f32)> {
    let n = n.max(1) as f32;
    vec![
        ("forces", sum.forces_ms / n),
        ("collision", sum.collision_ms / n),
        ("particle_decay", sum.particle_decay_ms / n),
        ("vm", sum.vm_ms / n),
        ("creature_collision", sum.creature_collision_ms / n),
        ("obstacle_collision", sum.obstacle_collision_ms / n),
        ("cell_reactions", sum.cell_reactions_ms / n),
        ("transport", sum.transport_ms / n),
        ("ambient", sum.ambient_ms / n),
        ("diffuse", sum.diffuse_ms / n),
        ("precipitation", sum.precipitation_ms / n),
        ("region_temp", sum.region_temp_ms / n),
        ("vent", sum.vent_ms / n),
        ("predate", sum.predate_ms / n),
        ("ingest", sum.ingest_ms / n),
        ("reproduction", sum.reproduction_ms / n),
        ("death", sum.death_ms / n),
        ("maintenance", sum.maintenance_ms / n),
        ("bonding", sum.bonding_ms / n),
        ("activation", sum.activation_ms / n),
        ("snapshot", sum.snapshot_ms / n),
    ]
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let (ws, _) = connect_async(&cli.url)
        .await
        .with_context(|| format!("connecting to {}", cli.url))?;
    let (mut write, mut read) = ws.split();

    if let Some(token) = cli.token.as_deref() {
        let auth = ClientMessage::Auth {
            token: Some(token.to_string()),
        };
        write
            .send(Message::Binary(encode_client(&auth)?))
            .await
            .context("send auth")?;
        if cli.reset {
            let reset = ClientMessage::Admin {
                command: evosim_protocol::AdminCommand::Reset,
            };
            write
                .send(Message::Binary(encode_client(&reset)?))
                .await
                .context("send reset")?;
        }
    } else if cli.reset {
        anyhow::bail!("--reset requires --token");
    }

    let mut csv_writer = match cli.csv.as_deref() {
        Some(p) => {
            let f = File::create(p).with_context(|| format!("create csv {p}"))?;
            let mut w = BufWriter::new(f);
            writeln!(
                w,
                "t,tick,particles,creatures,tick_ms,forces_ms,collision_ms,particle_decay_ms,\
vm_ms,creature_collision_ms,obstacle_collision_ms,cell_reactions_ms,transport_ms,ambient_ms,\
diffuse_ms,precipitation_ms,region_temp_ms,vent_ms,predate_ms,ingest_ms,reproduction_ms,\
death_ms,maintenance_ms,bonding_ms,activation_ms,snapshot_ms"
            )?;
            Some(w)
        }
        None => None,
    };

    let mut series = Series::default();
    let warmup = Duration::from_secs(cli.warmup_secs);
    let run_for = Duration::from_secs(cli.secs);
    let start = Instant::now();
    let mut samples_warming = 0_u32;
    let mut samples_kept = 0_u32;
    while let Some(msg) = read.next().await {
        let bytes = match msg {
            Ok(Message::Binary(b)) => b,
            Ok(Message::Close(_)) | Err(_) => break,
            _ => continue,
        };
        let Ok(decoded) = decode_server(&bytes) else {
            continue;
        };
        if let ServerMessage::Snapshot(s) = decoded {
            let elapsed = start.elapsed();
            if elapsed < warmup {
                samples_warming += 1;
                continue;
            }
            series.push(&s.perf);
            samples_kept += 1;
            if let Some(w) = csv_writer.as_mut() {
                let p = &s.perf;
                writeln!(
                    w,
                    "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}",
                    s.t,
                    s.tick,
                    p.particle_count,
                    p.creature_count,
                    p.tick_ms,
                    p.forces_ms,
                    p.collision_ms,
                    p.particle_decay_ms,
                    p.vm_ms,
                    p.creature_collision_ms,
                    p.obstacle_collision_ms,
                    p.cell_reactions_ms,
                    p.transport_ms,
                    p.ambient_ms,
                    p.diffuse_ms,
                    p.precipitation_ms,
                    p.region_temp_ms,
                    p.vent_ms,
                    p.predate_ms,
                    p.ingest_ms,
                    p.reproduction_ms,
                    p.death_ms,
                    p.maintenance_ms,
                    p.bonding_ms,
                    p.activation_ms,
                    p.snapshot_ms,
                )?;
            }
            if elapsed > warmup + run_for {
                break;
            }
        }
    }
    if let Some(mut w) = csv_writer {
        w.flush()?;
    }
    eprintln!(
        "warmup samples discarded: {samples_warming}; counted samples: {samples_kept}"
    );
    series.report(&cli.label);
    Ok(())
}
