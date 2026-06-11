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
/// Snapshot broadcast cadence. ~10 Hz matches the TS sim worker.
const SNAPSHOT_INTERVAL: Duration = Duration::from_millis(100);

/// Out-of-band commands the engine task handles between ticks.
#[derive(Debug)]
pub enum EngineCmd {
    Reset,
    /// Take a snapshot right now (out-of-cadence), encode, broadcast,
    /// and reply with `()` so the caller knows it landed.
    SnapshotNow(oneshot::Sender<()>),
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

async fn run(
    _state: Arc<AppState>,
    snap_tx: broadcast::Sender<Arc<Vec<u8>>>,
    mut cmd_rx: mpsc::Receiver<EngineCmd>,
) {
    let mut engine = Engine::new();
    let mut tick_timer = tokio::time::interval(Duration::from_secs_f64(TICK_DT));
    tick_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut snap_timer = tokio::time::interval(SNAPSHOT_INTERVAL);
    snap_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    info!("engine task running");
    loop {
        tokio::select! {
            // Bias the engine tick so a flood of admin commands can't
            // starve the simulation.
            biased;

            _ = tick_timer.tick() => {
                engine.step(TICK_DT);
            }

            _ = snap_timer.tick() => {
                if let Err(e) = broadcast_snapshot(&engine, &snap_tx) {
                    warn!(error = %e, "snapshot encode failed");
                }
            }

            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(EngineCmd::Reset) => {
                        info!("engine reset");
                        engine.reset();
                    }
                    Some(EngineCmd::SnapshotNow(reply)) => {
                        if let Err(e) = broadcast_snapshot(&engine, &snap_tx) {
                            warn!(error = %e, "snapshot encode failed");
                        }
                        let _ = reply.send(());
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

fn broadcast_snapshot(
    engine: &Engine,
    snap_tx: &broadcast::Sender<Arc<Vec<u8>>>,
) -> Result<(), rmp_serde::encode::Error> {
    if snap_tx.receiver_count() == 0 {
        // Nobody listening; skip the encode. The engine still ticks.
        return Ok(());
    }
    let snap = engine.snapshot();
    let bytes = encode_server(&ServerMessage::Snapshot(snap))?;
    // `send` errors only when there are no receivers; we just checked
    // above. Treat any other failure as fatal.
    if let Err(e) = snap_tx.send(Arc::new(bytes)) {
        error!(error = %e, "snapshot broadcast failed");
    }
    Ok(())
}
