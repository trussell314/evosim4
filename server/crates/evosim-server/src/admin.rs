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
        AdminCommand::UpdateClient { pull } => update_client(state.clone(), pull, &reply).await,
        AdminCommand::Snapshot => snapshot_now(engine_cmd).await,
        AdminCommand::Reset => reset(engine_cmd).await,
        AdminCommand::KillCell { x, y } => kill_cell(engine_cmd, x, y).await,
        AdminCommand::Status => status(state.clone()).await,
        AdminCommand::Load { name } => load_from_disk(name, state.clone(), engine_cmd).await,
        AdminCommand::Saves => list_saves(state.clone()).await,
        AdminCommand::Configure {
            width,
            height,
            seed,
            day_period_s,
            founders_per_strategy,
        } => configure(width, height, seed, day_period_s, founders_per_strategy, engine_cmd).await,
        AdminCommand::SetParticleCap { cap } => {
            set_particle_cap(engine_cmd, cap.map(|n| n as usize)).await
        }
        AdminCommand::SetMutationRate { scale } => set_mutation_rate(engine_cmd, scale).await,
        AdminCommand::SetEcology {
            immigration_enabled,
            immigration_target_species,
            sterile_cull_enabled,
            replenish_enabled,
        } => {
            set_ecology(
                engine_cmd,
                immigration_enabled,
                immigration_target_species,
                sterile_cull_enabled,
                replenish_enabled,
            )
            .await
        }
        AdminCommand::Export => export_world(engine_cmd).await,
        AdminCommand::Import { json } => import_world(engine_cmd, json).await,
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
        AdminCommand::UpdateClient { .. } => "update-client",
        AdminCommand::Snapshot => "snapshot",
        AdminCommand::Reset => "reset",
        AdminCommand::KillCell { .. } => "kill-cell",
        AdminCommand::Status => "status",
        AdminCommand::Load { .. } => "load",
        AdminCommand::Saves => "saves",
        AdminCommand::Configure { .. } => "configure",
        AdminCommand::SetParticleCap { .. } => "set-particle-cap",
        AdminCommand::SetMutationRate { .. } => "set-mutation-rate",
        AdminCommand::SetEcology { .. } => "set-ecology",
        AdminCommand::Export => "export",
        AdminCommand::Import { .. } => "import",
    }
}

async fn set_ecology(
    engine_cmd: mpsc::Sender<EngineCmd>,
    immigration_enabled: Option<bool>,
    immigration_target_species: Option<u32>,
    sterile_cull_enabled: Option<bool>,
    replenish_enabled: Option<bool>,
) -> anyhow::Result<Option<String>> {
    let (tx, rx) = oneshot::channel();
    engine_cmd
        .send(EngineCmd::SetEcology {
            immigration_enabled,
            immigration_target_species,
            sterile_cull_enabled,
            replenish_enabled,
            reply: tx,
        })
        .await
        .map_err(|e| anyhow::anyhow!("engine offline: {e}"))?;
    rx.await
        .map_err(|e| anyhow::anyhow!("engine reply lost: {e}"))?;
    Ok(Some(format!(
        "ecology updated: immigration={immigration_enabled:?} target={immigration_target_species:?} cull={sterile_cull_enabled:?} replenish={replenish_enabled:?}"
    )))
}

async fn set_mutation_rate(
    engine_cmd: mpsc::Sender<EngineCmd>,
    scale: f32,
) -> anyhow::Result<Option<String>> {
    let (tx, rx) = oneshot::channel();
    engine_cmd
        .send(EngineCmd::SetMutationRate { scale, reply: tx })
        .await
        .map_err(|e| anyhow::anyhow!("engine offline: {e}"))?;
    rx.await
        .map_err(|e| anyhow::anyhow!("engine reply lost: {e}"))?;
    Ok(Some(format!("mutation_rate_scale={:.3}", scale.clamp(0.0, 16.0))))
}

async fn import_world(
    engine_cmd: mpsc::Sender<EngineCmd>,
    json: String,
) -> anyhow::Result<Option<String>> {
    let (tx, rx) = oneshot::channel();
    engine_cmd
        .send(EngineCmd::LoadJson(json, tx))
        .await
        .map_err(|e| anyhow::anyhow!("engine offline: {e}"))?;
    rx.await
        .map_err(|e| anyhow::anyhow!("engine reply lost: {e}"))?
        .map_err(|e| anyhow::anyhow!("load_json failed: {e}"))?;
    Ok(Some("imported".into()))
}

async fn export_world(
    engine_cmd: mpsc::Sender<EngineCmd>,
) -> anyhow::Result<Option<String>> {
    let (tx, rx) = oneshot::channel();
    engine_cmd
        .send(EngineCmd::SaveJson(tx))
        .await
        .map_err(|e| anyhow::anyhow!("engine offline: {e}"))?;
    let json = rx
        .await
        .map_err(|e| anyhow::anyhow!("engine reply lost: {e}"))?
        .map_err(|e| anyhow::anyhow!("save_json failed: {e}"))?;
    Ok(Some(json))
}

async fn set_particle_cap(
    engine_cmd: mpsc::Sender<EngineCmd>,
    cap: Option<usize>,
) -> anyhow::Result<Option<String>> {
    let (tx, rx) = oneshot::channel();
    engine_cmd
        .send(EngineCmd::SetParticleCap { cap, reply: tx })
        .await
        .map_err(|e| anyhow::anyhow!("engine offline: {e}"))?;
    rx.await.map_err(|e| anyhow::anyhow!("engine reply lost: {e}"))?;
    Ok(Some(match cap {
        Some(n) => format!("particle_cap={n}"),
        None => "particle_cap=unbounded".to_string(),
    }))
}

async fn configure(
    width: Option<f32>,
    height: Option<f32>,
    seed: Option<u32>,
    day_period_s: Option<f64>,
    founders_per_strategy: Option<u32>,
    engine_cmd: mpsc::Sender<EngineCmd>,
) -> anyhow::Result<Option<String>> {
    let (tx, rx) = oneshot::channel();
    engine_cmd
        .send(EngineCmd::Configure {
            width,
            height,
            seed,
            day_period_s,
            founders_per_strategy,
            reply: tx,
        })
        .await
        .map_err(|_| anyhow::anyhow!("engine task is gone"))?;
    rx.await
        .map_err(|_| anyhow::anyhow!("engine did not respond"))?;
    Ok(Some(format!(
        "configured w={:?} h={:?} seed={:?} day_period_s={:?} founders_per_strategy={:?}",
        width, height, seed, day_period_s, founders_per_strategy
    )))
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

async fn update_client(
    state: Arc<AppState>,
    pull: bool,
    reply: &mpsc::Sender<ServerMessage>,
) -> anyhow::Result<Option<String>> {
    let cfg = state.cfg();
    let client_dir = cfg.repo_root.join("server").join("client-demo");
    if !client_dir.exists() {
        return Err(anyhow::anyhow!(
            "client-demo dir not found: {}",
            client_dir.display()
        ));
    }
    info!(dir = %client_dir.display(), pull, "admin update-client requested");

    if pull {
        let _ = reply
            .send(progress("update-client", "git fetch origin"))
            .await;
        let fetch = run_cmd(&cfg.repo_root, "git", &["fetch", "--prune", "origin"]).await?;
        if !fetch.success {
            return Err(anyhow::anyhow!("git fetch failed: {}", fetch.tail()));
        }
        let _ = reply
            .send(progress(
                "update-client",
                &format!("git reset --hard {}", cfg.default_update_ref),
            ))
            .await;
        let reset = run_cmd(
            &cfg.repo_root,
            "git",
            &["reset", "--hard", &cfg.default_update_ref],
        )
        .await?;
        if !reset.success {
            return Err(anyhow::anyhow!("git reset failed: {}", reset.tail()));
        }
    }

    let _ = reply
        .send(progress("update-client", "npm ci"))
        .await;
    let install = run_cmd(&client_dir, "npm", &["ci"]).await?;
    if !install.success {
        // `npm ci` is strict about the lockfile; fall back to `npm
        // install` so a missing lock or post-pull mismatch doesn't
        // wedge the operator UI.
        let _ = reply
            .send(progress(
                "update-client",
                "npm ci failed; falling back to npm install",
            ))
            .await;
        let install2 = run_cmd(&client_dir, "npm", &["install"]).await?;
        if !install2.success {
            return Err(anyhow::anyhow!(
                "npm install failed: {}",
                install2.tail()
            ));
        }
    }

    let _ = reply
        .send(progress("update-client", "npm run build"))
        .await;
    let build = run_cmd(&client_dir, "npm", &["run", "build"]).await?;
    if !build.success {
        return Err(anyhow::anyhow!("npm run build failed: {}", build.tail()));
    }
    let dist = client_dir.join("dist");
    info!(dist = %dist.display(), "client-demo rebuilt");
    Ok(Some(format!("rebuilt {}", dist.display())))
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

async fn kill_cell(
    engine_cmd: mpsc::Sender<EngineCmd>,
    x: f32,
    y: f32,
) -> anyhow::Result<Option<String>> {
    let (tx, rx) = oneshot::channel();
    engine_cmd
        .send(EngineCmd::KillCell { x, y, reply: tx })
        .await
        .map_err(|_| anyhow::anyhow!("engine task is gone"))?;
    let outcome = rx
        .await
        .map_err(|_| anyhow::anyhow!("engine did not respond"))?;
    match outcome {
        Some(idx) => Ok(Some(format!("killed cell idx={idx}"))),
        None => Err(anyhow::anyhow!("no cell within tolerance")),
    }
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

/// Sanitise a user-supplied save name. Strips path separators and any
/// leading dots; refuses an empty name. Returns the cleaned name
/// (without an `.json` suffix). Keeps the save directory flat -- one
/// flat folder per server, no nesting -- so a malicious or careless
/// name can't escape into `/etc/passwd` or up the tree.
fn sanitise_save_name(raw: &str) -> Result<String, anyhow::Error> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        anyhow::bail!("save name is empty");
    }
    let cleaned: String = trimmed
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(*c, '-' | '_' | '.'))
        .collect();
    let cleaned = cleaned.trim_start_matches('.').trim_end_matches('.');
    let cleaned = cleaned.strip_suffix(".json").unwrap_or(cleaned);
    if cleaned.is_empty() {
        anyhow::bail!("save name reduces to empty after sanitisation");
    }
    Ok(cleaned.to_string())
}

/// Save the current world to the configured save directory.
/// Triggered by `ClientMessage::Save { name }`. The directory is
/// created on demand. Replies through the per-connection
/// `reply_tx` so the operator sees an ack with the resolved path.
pub async fn save_to_disk(
    name: Option<String>,
    state: Arc<AppState>,
    engine_cmd: mpsc::Sender<EngineCmd>,
    reply: mpsc::Sender<ServerMessage>,
) {
    let cfg = state.cfg();
    let raw = name.unwrap_or_else(|| {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("save-{secs}")
    });
    let cleaned = match sanitise_save_name(&raw) {
        Ok(c) => c,
        Err(e) => {
            let _ = reply
                .send(ServerMessage::Error {
                    code: "save".into(),
                    message: e.to_string(),
                })
                .await;
            return;
        }
    };
    // Pull the JSON from the engine task.
    let (tx, rx) = oneshot::channel();
    if engine_cmd.send(EngineCmd::SaveJson(tx)).await.is_err() {
        let _ = reply
            .send(ServerMessage::Error {
                code: "save".into(),
                message: "engine task is gone".into(),
            })
            .await;
        return;
    }
    let json = match rx.await {
        Ok(Ok(json)) => json,
        Ok(Err(e)) => {
            let _ = reply
                .send(ServerMessage::Error {
                    code: "save".into(),
                    message: format!("serialise: {e}"),
                })
                .await;
            return;
        }
        Err(_) => {
            let _ = reply
                .send(ServerMessage::Error {
                    code: "save".into(),
                    message: "engine did not respond".into(),
                })
                .await;
            return;
        }
    };
    // Write atomically: write to <name>.tmp then rename.
    let path = cfg.save_dir.join(format!("{cleaned}.json"));
    let tmp = cfg.save_dir.join(format!("{cleaned}.json.tmp"));
    if let Err(e) = tokio::fs::create_dir_all(&cfg.save_dir).await {
        let _ = reply
            .send(ServerMessage::Error {
                code: "save".into(),
                message: format!("mkdir {}: {e}", cfg.save_dir.display()),
            })
            .await;
        return;
    }
    if let Err(e) = tokio::fs::write(&tmp, json.as_bytes()).await {
        let _ = reply
            .send(ServerMessage::Error {
                code: "save".into(),
                message: format!("write {}: {e}", tmp.display()),
            })
            .await;
        return;
    }
    if let Err(e) = tokio::fs::rename(&tmp, &path).await {
        let _ = reply
            .send(ServerMessage::Error {
                code: "save".into(),
                message: format!("rename to {}: {e}", path.display()),
            })
            .await;
        return;
    }
    info!(path = %path.display(), "saved");
    let _ = reply
        .send(ServerMessage::AdminAck {
            command: "save".into(),
            message: Some(format!("wrote {}", path.display())),
        })
        .await;
}

async fn load_from_disk(
    name: String,
    state: Arc<AppState>,
    engine_cmd: mpsc::Sender<EngineCmd>,
) -> anyhow::Result<Option<String>> {
    let cfg = state.cfg();
    let cleaned = sanitise_save_name(&name)?;
    let path = cfg.save_dir.join(format!("{cleaned}.json"));
    let json = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| anyhow::anyhow!("read {}: {e}", path.display()))?;
    let (tx, rx) = oneshot::channel();
    engine_cmd
        .send(EngineCmd::LoadJson(json, tx))
        .await
        .map_err(|_| anyhow::anyhow!("engine task is gone"))?;
    rx.await
        .map_err(|_| anyhow::anyhow!("engine did not respond"))?
        .map_err(|e| anyhow::anyhow!("load: {e}"))?;
    Ok(Some(format!("loaded {}", path.display())))
}

async fn list_saves(state: Arc<AppState>) -> anyhow::Result<Option<String>> {
    let cfg = state.cfg();
    let mut names = Vec::new();
    if let Ok(mut rd) = tokio::fs::read_dir(&cfg.save_dir).await {
        while let Ok(Some(e)) = rd.next_entry().await {
            if let Some(n) = e.file_name().to_str() {
                if let Some(stem) = n.strip_suffix(".json") {
                    names.push(stem.to_string());
                }
            }
        }
    }
    names.sort();
    // Inline JSON array; no serde_json dep just for this one shape.
    let body: Vec<String> = names
        .iter()
        .map(|n| format!("\"{}\"", n.replace('"', "\\\"")))
        .collect();
    Ok(Some(format!("[{}]", body.join(","))))
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
