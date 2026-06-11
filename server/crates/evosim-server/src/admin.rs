//! Admin command handling. Token check, dispatcher, and the
//! restart/update plumbing. Everything in here assumes the bearer
//! token has already been validated against `AppState`; per-connection
//! `is_admin` is the only gate.
//!
//! Restart and update both lean on a supervisor process: this binary
//! exits cleanly with code 0 (restart) or code 75 = EX_TEMPFAIL
//! (update failed) / 0 (update succeeded). The wrapper script /
//! systemd unit is responsible for relaunching the binary. See
//! `server/scripts/run.sh` and `server/README.md` for the operator
//! contract.

use std::sync::Arc;

use evosim_protocol::{AdminCommand, ServerMessage};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};
use tracing::{info, warn};

use crate::app::AppState;
use crate::engine_task::EngineCmd;

/// Process exit codes the supervisor wrapper inspects.
const EXIT_RESTART: i32 = 0;
const EXIT_UPDATE_OK: i32 = 0;
const EXIT_UPDATE_FAIL: i32 = 75; // EX_TEMPFAIL; supervisor should relaunch the OLD binary.

pub async fn handle(
    cmd: AdminCommand,
    state: Arc<AppState>,
    engine_cmd: mpsc::Sender<EngineCmd>,
    reply: mpsc::Sender<ServerMessage>,
) {
    let label = command_label(&cmd);
    let result = match cmd {
        AdminCommand::Restart => restart(state.clone(), &reply).await,
        AdminCommand::Update { branch } => update(state.clone(), branch, &reply).await,
        AdminCommand::Snapshot => snapshot_now(engine_cmd).await,
        AdminCommand::Reset => reset(engine_cmd).await,
        AdminCommand::Status => status(state.clone()).await,
    };
    let msg = match result {
        Ok(ack) => ServerMessage::AdminAck { command: label.into(), message: ack },
        Err(e) => ServerMessage::AdminNack { command: label.into(), reason: e.to_string() },
    };
    let _ = reply.send(msg).await;
}

fn command_label(cmd: &AdminCommand) -> &'static str {
    match cmd {
        AdminCommand::Restart => "restart",
        AdminCommand::Update { .. } => "update",
        AdminCommand::Snapshot => "snapshot",
        AdminCommand::Reset => "reset",
        AdminCommand::Status => "status",
    }
}

async fn restart(
    state: Arc<AppState>,
    reply: &mpsc::Sender<ServerMessage>,
) -> anyhow::Result<Option<String>> {
    info!("admin restart requested");
    // Tell the client the ack landed before we drop everything.
    let _ = reply.send(ServerMessage::AdminAck {
        command: "restart".into(),
        message: Some("restart scheduled".into()),
    }).await;
    // Tiny grace period for any pending Goodbye frames the WS task
    // wants to flush before the listener closes.
    let _ = reply.send(ServerMessage::Goodbye { reason: "restart".into() }).await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    state.request_shutdown(EXIT_RESTART);
    Ok(None)
}

async fn update(
    state: Arc<AppState>,
    branch: Option<String>,
    reply: &mpsc::Sender<ServerMessage>,
) -> anyhow::Result<Option<String>> {
    let cfg = state.cfg();
    let target = branch.unwrap_or_else(|| cfg.default_update_ref.clone());
    info!(target = %target, "admin update requested");
    let _ = reply.send(progress("update", &format!("fetching {target}"))).await;

    let fetch = run_cmd(&cfg.repo_root, "git", &["fetch", "--prune", "origin"]).await?;
    if !fetch.success {
        return Err(anyhow::anyhow!("git fetch failed: {}", fetch.tail()));
    }

    let _ = reply.send(progress("update", &format!("checking out {target}"))).await;
    let reset = run_cmd(&cfg.repo_root, "git", &["reset", "--hard", &target]).await?;
    if !reset.success {
        return Err(anyhow::anyhow!("git reset failed: {}", reset.tail()));
    }

    let _ = reply.send(progress("update", "cargo build --release")).await;
    let server_dir = cfg.repo_root.join("server");
    let build = run_cmd(&server_dir, "cargo", &["build", "--release", "--locked"]).await?;
    if !build.success {
        // Build failed: we stay alive on the OLD binary. Surface
        // enough for the operator to debug from the client.
        warn!(target = %target, "build failed; staying on current binary");
        return Err(anyhow::anyhow!("cargo build failed: {}", build.tail()));
    }

    info!(target = %target, "build ok; restarting into new binary");
    let _ = reply.send(ServerMessage::Goodbye { reason: "update".into() }).await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    state.request_shutdown(EXIT_UPDATE_OK);
    Ok(Some(format!("updated to {target}")))
}

async fn snapshot_now(engine_cmd: mpsc::Sender<EngineCmd>) -> anyhow::Result<Option<String>> {
    let (tx, rx) = oneshot::channel();
    engine_cmd.send(EngineCmd::SnapshotNow(tx)).await
        .map_err(|_| anyhow::anyhow!("engine task is gone"))?;
    rx.await.map_err(|_| anyhow::anyhow!("engine did not respond"))?;
    Ok(Some("snapshot broadcast".into()))
}

async fn reset(engine_cmd: mpsc::Sender<EngineCmd>) -> anyhow::Result<Option<String>> {
    engine_cmd.send(EngineCmd::Reset).await
        .map_err(|_| anyhow::anyhow!("engine task is gone"))?;
    Ok(Some("engine reset".into()))
}

async fn status(state: Arc<AppState>) -> anyhow::Result<Option<String>> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let uptime_s = now.saturating_sub(state.started_at);
    let conns = state.connections.load(std::sync::atomic::Ordering::Relaxed);
    let json = format!(
        r#"{{"build":{{"version":"{}","commit":"{}","builtAt":{}}},"uptimeSec":{},"connections":{}}}"#,
        state.build.version, state.build.commit, state.build.built_at, uptime_s, conns
    );
    Ok(Some(json))
}

fn progress(command: &str, msg: &str) -> ServerMessage {
    ServerMessage::AdminAck {
        command: command.into(),
        message: Some(msg.into()),
    }
}

struct CmdOut {
    success: bool,
    stdout: String,
    stderr: String,
}

impl CmdOut {
    fn tail(&self) -> String {
        // Last ~400 chars of the combined stream; tunnels nicely
        // through a single AdminNack `reason` field.
        let mut combined = self.stderr.clone();
        if combined.is_empty() {
            combined = self.stdout.clone();
        }
        if combined.len() > 400 {
            combined = format!("...{}", &combined[combined.len() - 400..]);
        }
        combined
    }
}

async fn run_cmd(
    cwd: &std::path::Path,
    bin: &str,
    args: &[&str],
) -> anyhow::Result<CmdOut> {
    let out = Command::new(bin)
        .args(args)
        .current_dir(cwd)
        .output()
        .await?;
    Ok(CmdOut {
        success: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// Public helper used by `main` if a build-fail path ever wants to
/// signal the supervisor explicitly. Kept here so the exit-code policy
/// lives in one file.
#[allow(dead_code)]
pub fn exit_update_fail() -> i32 {
    EXIT_UPDATE_FAIL
}
