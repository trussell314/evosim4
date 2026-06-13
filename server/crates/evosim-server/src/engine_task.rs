//! The engine lives in a single dedicated tokio task. It owns the
//! `Engine` and ticks on a fixed cadence; admin commands (Reset,
//! Snapshot) reach it via [`EngineCmd`] over a tokio channel. The
//! task encodes each snapshot exactly once and pushes the
//! `Arc<Vec<u8>>` through the broadcast channel; per-client tasks
//! ship the bytes verbatim.
//!
//! The engine is single-threaded for now; the real port will use
//! rayon for CPU parallelism inside the same task and wgpu for GPU
//! compute. The task boundary doesn't change as those land.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{broadcast, mpsc, oneshot};
use tracing::{error, info, warn};

use evosim_engine::Engine;
use evosim_protocol::{encode_server, ServerMessage};

use crate::app::AppState;

/// Tick cadence target. Stays fixed for now; later this is driven by
/// `ClientMessage::SetSimRate` from a controller connection.
const TICK_DT: f64 = 1.0 / 60.0;
/// Snapshot broadcast cadence. 30 Hz keeps mobile rendering smooth
/// without doubling the per-tick serialization cost; override via
/// `EVOSIM_SNAPSHOT_HZ` (1..240). 60 matches the engine tick rate
/// and gives the smoothest playback at the cost of ~2x bandwidth.
const DEFAULT_SNAPSHOT_HZ: u32 = 30;
fn snapshot_interval() -> Duration {
    let hz = std::env::var("EVOSIM_SNAPSHOT_HZ")
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .filter(|h| (1..=240).contains(h))
        .unwrap_or(DEFAULT_SNAPSHOT_HZ);
    Duration::from_micros((1_000_000 / hz as u64).max(1))
}

/// Out-of-band commands the engine task handles between ticks.
#[derive(Debug)]
pub enum EngineCmd {
    Reset,
    /// Take a snapshot right now (out-of-cadence), encode, broadcast,
    /// and reply with `()` so the caller knows it landed.
    SnapshotNow(oneshot::Sender<()>),
    /// Pause or resume the engine. When paused, the tick timer keeps
    /// firing but step() is skipped so the world stops advancing;
    /// snapshots continue so a paused world is still observable.
    SetRunning(bool),
    /// Advance one tick regardless of running flag. No-op when the
    /// engine is currently running -- step is only meaningful while
    /// paused.
    Step,
    /// Multiplier on the wall-clock tick cadence. 1.0 = real time,
    /// 0.5 = half speed, 2.0 = double speed. Clamped to a sane band
    /// server-side.
    SetSimRate(f32),
    /// Serialise the world and reply with the JSON. The WS handler
    /// writes it to the save directory; doing IO here would block
    /// the tick loop.
    SaveJson(oneshot::Sender<Result<String, String>>),
    /// Load a saved JSON. Replies with the load outcome so the
    /// caller can report success / failure on the wire.
    LoadJson(String, oneshot::Sender<Result<(), String>>),
    /// Reconfigure the world. Any None field keeps its current value.
    Configure {
        width: Option<f32>,
        height: Option<f32>,
        seed: Option<u32>,
        day_period_s: Option<f64>,
        founders_per_strategy: Option<u32>,
        reply: oneshot::Sender<()>,
    },
    /// Return the static terrain polygons. Each inner Vec is a single
    /// rock as alternating (x, y) f32 pairs flattened. Used by the WS
    /// handler to populate the Hello frame so the client can render
    /// the terrain silhouette.
    GetTerrain(oneshot::Sender<Vec<Vec<f32>>>),
    /// Mark the cell nearest (x, y) as unviable. Replies with the SoA
    /// index of the killed cell, or None if no cell was close enough.
    KillCell {
        x: f32,
        y: f32,
        reply: oneshot::Sender<Option<usize>>,
    },
}

pub struct EngineHandle {
    pub cmd_tx: mpsc::Sender<EngineCmd>,
    _join: tokio::task::JoinHandle<()>,
}

pub fn spawn(
    state: Arc<AppState>,
    snap_tx: broadcast::Sender<Arc<Vec<u8>>>,
) -> EngineHandle {
    let (cmd_tx, cmd_rx) = mpsc::channel::<EngineCmd>(32);
    let join = tokio::spawn(async move {
        run(state, snap_tx, cmd_rx).await;
    });
    EngineHandle { cmd_tx, _join: join }
}

/// Min/max sim-rate the server honours. A rate of 0 effectively
/// pauses; the server-side pause path uses `SetRunning(false)` for
/// the same effect. We don't accept negative rates (time would run
/// backwards) and we cap at 8x so a rogue controller can't melt the
/// engine task.
const SIM_RATE_MIN: f32 = 0.05;
/// Was 8.0; bumped to 32.0 so operators can blast through the
/// early-extinction window without staring at a paused-looking canvas.
const SIM_RATE_MAX: f32 = 32.0;

async fn run(
    _state: Arc<AppState>,
    snap_tx: broadcast::Sender<Arc<Vec<u8>>>,
    mut cmd_rx: mpsc::Receiver<EngineCmd>,
) {
    let mut engine = Engine::new();
    // Optional EVOSIM_PARTICLE_CAP env override. Lets the operator
    // dial the cap without recompiling (bench harness, A/B testing).
    // Integer values are taken literally (0 = no particles can spawn
    // from cap-honoring passes -- the field drains as decay ages
    // existing particles out). To opt out of the cap entirely, set
    // the var to "none" / "off" / "unbounded".
    if let Ok(s) = std::env::var("EVOSIM_PARTICLE_CAP") {
        let trimmed = s.trim();
        match trimmed {
            "" => {}
            "none" | "off" | "unbounded" => engine.set_particle_cap(None),
            _ => match trimmed.parse::<usize>() {
                Ok(n) => engine.set_particle_cap(Some(n)),
                Err(e) => tracing::warn!("EVOSIM_PARTICLE_CAP parse error: {e}"),
            },
        }
    }
    // EVOSIM_GPU_FORCES=1 opts in to the wgpu compute force kernel.
    // Falls back to CPU silently if no compute-capable adapter is
    // present (sandboxed CI, headless servers without a GPU).
    if matches!(
        std::env::var("EVOSIM_GPU_FORCES").as_deref(),
        Ok("1") | Ok("on") | Ok("true")
    ) {
        let ok = engine.enable_gpu_forces();
        tracing::info!("EVOSIM_GPU_FORCES requested; installed={ok}");
    }
    let mut running = true;
    let mut sim_rate: f32 = 1.0;
    let mut tick_timer = make_tick_timer(sim_rate);

    let snap_interval = snapshot_interval();
    tracing::info!(
        "snapshot cadence: {:.1} Hz",
        1_000_000.0 / snap_interval.as_micros() as f64
    );
    let mut snap_timer = tokio::time::interval(snap_interval);
    snap_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    info!("engine task running");
    loop {
        tokio::select! {
            // Bias the engine tick so a flood of admin commands can't
            // starve the simulation.
            biased;

            _ = tick_timer.tick() => {
                if running {
                    engine.step(TICK_DT);
                }
            }

            _ = snap_timer.tick() => {
                // Mirror server-wide state into the engine so the
                // outgoing snapshot tells clients the truth.
                engine.mirror_sim_rate = sim_rate;
                engine.mirror_running = running;
                // Auto-reseed when the population crashes. <= 0 cells
                // for >= 3 sim seconds repopulates founders so the
                // canvas isn't permanently blank after an extinction.
                let snap_dt = snap_interval.as_secs_f64();
                let reseeded = engine.auto_reseed_if_extinct(0, 3.0, snap_dt);
                if reseeded {
                    info!(
                        count = engine.auto_reseeds,
                        "population extinct -- auto-reseeded founders"
                    );
                }
                if let Err(e) = broadcast_snapshot(&mut engine, &snap_tx) {
                    warn!(error = %e, "snapshot encode failed");
                }
            }

            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(EngineCmd::Reset) => {
                        info!("engine reset");
                        engine.reset();
                    }
                    Some(EngineCmd::Step) => {
                        // Step is meaningful only while paused; if
                        // the engine is already running the next
                        // tick is one TICK_DT away anyway.
                        if !running {
                            engine.step(TICK_DT);
                        }
                    }
                    Some(EngineCmd::SetRunning(r)) => {
                        info!(running = r, "engine running flag changed");
                        running = r;
                    }
                    Some(EngineCmd::SetSimRate(rate)) => {
                        let clamped = rate.clamp(SIM_RATE_MIN, SIM_RATE_MAX);
                        if (clamped - sim_rate).abs() > f32::EPSILON {
                            info!(rate = clamped, "sim rate changed");
                            sim_rate = clamped;
                            tick_timer = make_tick_timer(sim_rate);
                        }
                    }
                    Some(EngineCmd::SnapshotNow(reply)) => {
                        if let Err(e) = broadcast_snapshot(&mut engine, &snap_tx) {
                            warn!(error = %e, "snapshot encode failed");
                        }
                        let _ = reply.send(());
                    }
                    Some(EngineCmd::SaveJson(reply)) => {
                        let r = engine.save_json().map_err(|e| e.to_string());
                        let _ = reply.send(r);
                    }
                    Some(EngineCmd::LoadJson(json, reply)) => {
                        let r = engine.load_json(&json).map_err(|e| e.to_string());
                        let _ = reply.send(r);
                    }
                    Some(EngineCmd::Configure {
                        width,
                        height,
                        seed,
                        day_period_s,
                        founders_per_strategy,
                        reply,
                    }) => {
                        info!(
                            width = ?width,
                            height = ?height,
                            seed = ?seed,
                            day_period_s = ?day_period_s,
                            founders_per_strategy = ?founders_per_strategy,
                            "engine reconfigure",
                        );
                        engine.configure(width, height, seed, day_period_s, founders_per_strategy);
                        let _ = reply.send(());
                    }
                    Some(EngineCmd::KillCell { x, y, reply }) => {
                        let idx = engine.kill_cell_nearest(x, y, 60.0);
                        let _ = reply.send(idx);
                    }
                    Some(EngineCmd::GetTerrain(reply)) => {
                        // Flatten polygons to alternating (x, y) pairs
                        // so the wire shape is one Vec<f32> per rock.
                        let polys: Vec<Vec<f32>> = engine
                            .world()
                            .obstacles
                            .iter()
                            .filter_map(|ob| ob.polygon.as_ref())
                            .map(|poly| {
                                let mut flat = Vec::with_capacity(poly.len() * 2);
                                for v in poly {
                                    flat.push(v.x);
                                    flat.push(v.y);
                                }
                                flat
                            })
                            .collect();
                        let _ = reply.send(polys);
                    }
                    None => {
                        // Sender dropped -- the binary is exiting.
                        info!("engine command channel closed");
                        return;
                    }
                }
            }
        }
    }
}

/// Build a fresh tick `Interval` for the given rate. We can't change
/// `Interval::period` after construction (tokio API), so a rate
/// change drops and rebuilds.
fn make_tick_timer(rate: f32) -> tokio::time::Interval {
    let dt = TICK_DT / rate as f64;
    let mut timer = tokio::time::interval(Duration::from_secs_f64(dt));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    timer
}

fn broadcast_snapshot(
    engine: &mut Engine,
    snap_tx: &broadcast::Sender<Arc<Vec<u8>>>,
) -> Result<(), rmp_serde::encode::Error> {
    if snap_tx.receiver_count() == 0 {
        // Nobody listening; skip the encode. The engine still ticks.
        return Ok(());
    }
    let snap = engine.snapshot();
    let bytes = encode_server(&ServerMessage::Snapshot(Box::new(snap)))?;
    // `send` errors only when there are no receivers; we just checked
    // above. Treat any other failure as fatal.
    if let Err(e) = snap_tx.send(Arc::new(bytes)) {
        error!(error = %e, "snapshot broadcast failed");
    }
    Ok(())
}
