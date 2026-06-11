//! Shared application state. Held in an `Arc` and handed to the
//! WebSocket handler + engine task. Owns the broadcast sender, a
//! shutdown notifier (so admin restarts can drop the server),
//! connection bookkeeping, and an atomic exit code.

use std::sync::atomic::{AtomicI32, AtomicU64, Ordering};
use std::sync::Arc;

use tokio::sync::{broadcast, Notify};

use evosim_protocol::BuildInfo;

use crate::Config;

pub struct AppState {
    cfg: Config,
    /// Broadcast channel for snapshot frames (msgpack-encoded).
    /// `Arc<Vec<u8>>` so the engine encodes once and N clients clone
    /// only the Arc.
    pub snap_tx: broadcast::Sender<Arc<Vec<u8>>>,
    /// Fires when an admin restart/update has cleared its checks and
    /// the server should drop the listening socket. Used to drive
    /// `axum::serve(..).with_graceful_shutdown(..)`.
    shutdown: Notify,
    /// Process exit code. Set by the admin handler before triggering
    /// shutdown so the wrapper script knows whether to relaunch.
    exit_code: AtomicI32,
    /// Connection counter for observability. Read by `AdminCommand::Status`.
    pub connections: AtomicU64,
    /// Process start time (unix epoch seconds). Reported in Status.
    pub started_at: u64,
    /// Build identity sent in the Hello frame.
    pub build: BuildInfo,
}

impl AppState {
    pub fn new(cfg: Config, snap_tx: broadcast::Sender<Arc<Vec<u8>>>) -> Self {
        let started_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let build = BuildInfo {
            version: env!("CARGO_PKG_VERSION").into(),
            commit: env!("EVOSIM_BUILD_COMMIT").into(),
            built_at: env!("EVOSIM_BUILD_AT").parse().unwrap_or(0),
        };
        Self {
            cfg,
            snap_tx,
            shutdown: Notify::new(),
            exit_code: AtomicI32::new(0),
            connections: AtomicU64::new(0),
            started_at,
            build,
        }
    }

    pub fn cfg(&self) -> &Config {
        &self.cfg
    }

    /// Test the supplied bearer token in constant time against the
    /// configured admin token. Returns false when admin is disabled.
    pub fn check_admin_token(&self, presented: &str) -> bool {
        let Some(expected) = self.cfg.admin_token.as_deref() else {
            return false;
        };
        // Differing lengths short-circuit publicly, so pad to the
        // expected length first. Combined with constant_time_eq we
        // give nothing away beyond "token had the right length."
        let a = presented.as_bytes();
        let b = expected.as_bytes();
        if a.len() != b.len() {
            return false;
        }
        constant_time_eq::constant_time_eq(a, b)
    }

    /// Block-until-fired hook for the listening loop.
    pub async fn shutdown_signal(&self) {
        self.shutdown.notified().await;
    }

    /// Trigger graceful shutdown with the given exit code. Idempotent;
    /// repeated calls clobber the exit code, last writer wins.
    pub fn request_shutdown(&self, code: i32) {
        self.exit_code.store(code, Ordering::SeqCst);
        self.shutdown.notify_waiters();
    }

    pub fn exit_code(&self) -> i32 {
        self.exit_code.load(Ordering::SeqCst)
    }
}
