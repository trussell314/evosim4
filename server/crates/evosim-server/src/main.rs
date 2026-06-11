//! `evosim-server` entry point. Boots tokio, parses environment, owns
//! the engine in its own task, and serves an axum router with a single
//! WebSocket endpoint at `/sim`. See `server/README.md` for the
//! operator-facing contract.

#![forbid(unsafe_code)]

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Result;
use axum::{routing::get, Router};
use tokio::sync::broadcast;
use tracing::{info, warn};

mod admin;
mod app;
mod engine_task;
mod ws;

use app::AppState;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    init_tracing();
    let cfg = Config::from_env();
    info!(
        bind = %cfg.bind,
        commit = %env!("EVOSIM_BUILD_COMMIT"),
        "starting evosim-server"
    );

    // Snapshot fan-out. Capacity is small intentionally: the engine
    // emits at ~10 Hz, slow clients drop frames rather than queue
    // unbounded memory. `broadcast::Receiver::recv` returns `Lagged`
    // when a client falls behind by more than `capacity` frames; the
    // per-client task surfaces that as a dropped snapshot, not an
    // error.
    let (snap_tx, _snap_rx) = broadcast::channel::<Arc<Vec<u8>>>(8);

    let state = Arc::new(AppState::new(cfg.clone(), snap_tx.clone()));

    // Engine task owns the engine; never accessible from request
    // handlers. Admin commands flow over a sender stashed in
    // `ws::install_engine_handle` (a OnceLock today; tied to
    // AppState in a later commit).
    let engine_handle = engine_task::spawn(state.clone(), snap_tx.clone());
    ws::install_engine_handle(&engine_handle);

    let app = Router::new()
        .route("/sim", get(ws::handler))
        .route("/health", get(health))
        .with_state(state.clone());

    let listener = tokio::net::TcpListener::bind(cfg.bind).await?;
    info!(addr = %cfg.bind, "listening");

    // Shutdown story: ctrl-c, SIGTERM, or an admin restart signal
    // from state.shutdown_rx. Whichever fires first wins; the engine
    // task is dropped, in-flight WebSocket handlers see their next
    // recv() fail and close the socket with a Goodbye.
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(state.clone()))
        .await?;

    drop(engine_handle);
    info!(exit_code = state.exit_code(), "evosim-server exiting");
    std::process::exit(state.exit_code());
}

#[derive(Clone)]
pub struct Config {
    pub bind: SocketAddr,
    /// Bearer token required for any admin command. `None` disables
    /// admin entirely (any AdminCommand is nacked). Set via
    /// `EVOSIM_ADMIN_TOKEN`; we deliberately don't print it.
    pub admin_token: Option<String>,
    /// Repository root for `update`. `git pull && cargo build` runs
    /// here. Defaults to the cwd, which is the repo root in
    /// development and the deploy dir in production.
    pub repo_root: std::path::PathBuf,
    /// Default git remote ref used by `update` when the command
    /// doesn't specify a branch. "origin/claude/native-engine"
    /// during the port; flip to the release branch later.
    pub default_update_ref: String,
}

impl Config {
    fn from_env() -> Self {
        let bind = std::env::var("EVOSIM_BIND")
            .unwrap_or_else(|_| "0.0.0.0:8080".into())
            .parse()
            .expect("EVOSIM_BIND must be host:port");
        let admin_token = std::env::var("EVOSIM_ADMIN_TOKEN").ok().filter(|s| !s.is_empty());
        if admin_token.is_none() {
            warn!("EVOSIM_ADMIN_TOKEN unset; admin commands disabled");
        }
        let repo_root = std::env::var("EVOSIM_REPO_ROOT")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::env::current_dir().expect("cwd"));
        let default_update_ref = std::env::var("EVOSIM_UPDATE_REF")
            .unwrap_or_else(|_| "origin/claude/native-engine".into());
        Self { bind, admin_token, repo_root, default_update_ref }
    }
}

async fn health() -> &'static str {
    "ok"
}

async fn shutdown_signal(state: Arc<AppState>) {
    // tokio::signal handles ctrl-c portably and SIGTERM on unix.
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        let mut sig = tokio::signal::unix::signal(
            tokio::signal::unix::SignalKind::terminate(),
        )
        .expect("install SIGTERM handler");
        let _ = sig.recv().await;
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();

    let admin = async {
        let _ = state.shutdown_signal().await;
    };

    tokio::select! {
        _ = ctrl_c => info!("ctrl-c received"),
        _ = term => info!("SIGTERM received"),
        _ = admin => info!("admin shutdown signal"),
    }
}

fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};
    let filter = EnvFilter::try_from_env("EVOSIM_LOG")
        .unwrap_or_else(|_| EnvFilter::new("info,evosim_server=debug"));
    fmt().with_env_filter(filter).with_target(true).init();
}
