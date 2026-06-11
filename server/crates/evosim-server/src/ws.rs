//! WebSocket per-client task. One task per connection. Subscribes to
//! the snapshot broadcast, forwards bytes verbatim, and demultiplexes
//! per-client replies (admin acks, errors, Goodbye) onto the same
//! socket. The engine cmd channel is shared across all clients --
//! admin commands run on the engine task, not in the WS task.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{broadcast, mpsc};
use tracing::{debug, info, warn};

use evosim_protocol::{
    decode_client, encode_server, ClientMessage, ServerCapabilities, ServerMessage,
    PROTOCOL_VERSION,
};

use crate::admin;
use crate::app::AppState;
use crate::engine_task::{EngineCmd, EngineHandle};

/// Per-connection reply mailbox capacity. Caps backpressure if a
/// client is slow to read; once full we drop the connection.
const REPLY_CAP: usize = 32;

pub async fn handler(
    State(state): State<Arc<AppState>>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle(socket, state))
}

async fn handle(socket: WebSocket, state: Arc<AppState>) {
    let conn_id = state.connections.fetch_add(1, Ordering::Relaxed) + 1;
    info!(conn = conn_id, "client connected");

    let (mut tx, mut rx) = socket.split();
    let snap_rx = state.snap_tx.subscribe();
    let (reply_tx, mut reply_rx) = mpsc::channel::<ServerMessage>(REPLY_CAP);

    // Per-connection state lives on the stack; flipped by Auth.
    let mut is_admin = false;

    // Send Hello before anything else.
    let hello = ServerMessage::Hello {
        protocol: PROTOCOL_VERSION,
        build: state.build.clone(),
        capabilities: capabilities(&state, is_admin),
        chem_colors: chem_colors(),
        chem_names: chem_names(),
    };
    if !send_frame(&mut tx, &hello).await {
        return;
    }

    // We can't share `engine_cmd_tx` through state without an extra
    // Arc layer; for now per-task admin handler picks it up from the
    // EngineHandle stored at boot. To avoid plumbing the handle into
    // every WS task, we re-borrow via the state shutdown route in a
    // later commit; today admin handlers get a clone from a static
    // helper.
    let engine_cmd = state_engine_cmd();

    let mut snap_rx = snap_rx;

    loop {
        tokio::select! {
            // Outgoing snapshots from the broadcast channel.
            recv = snap_rx.recv() => match recv {
                Ok(bytes) => {
                    if tx.send(Message::Binary(bytes.as_ref().clone())).await.is_err() {
                        debug!(conn = conn_id, "send failed; client gone");
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    // Slow consumer; we dropped frames. The next snapshot
                    // we receive will catch them up. Surface so it's
                    // visible.
                    warn!(conn = conn_id, skipped, "client lagged on broadcast");
                }
                Err(broadcast::error::RecvError::Closed) => {
                    info!(conn = conn_id, "broadcast channel closed");
                    break;
                }
            },

            // Outgoing per-connection messages from the admin path.
            Some(msg) = reply_rx.recv() => {
                if !send_frame(&mut tx, &msg).await {
                    break;
                }
                if matches!(msg, ServerMessage::Goodbye { .. }) {
                    break;
                }
            }

            // Inbound from the client.
            inbound = rx.next() => match inbound {
                Some(Ok(Message::Binary(b))) => {
                    match decode_client(&b) {
                        Ok(cm) => {
                            handle_client_message(
                                cm,
                                &state,
                                &mut is_admin,
                                &reply_tx,
                                engine_cmd.as_ref(),
                            ).await;
                        }
                        Err(e) => {
                            let err = ServerMessage::Error {
                                code: "decode".into(),
                                message: e.to_string(),
                            };
                            if !send_frame(&mut tx, &err).await { break; }
                        }
                    }
                }
                Some(Ok(Message::Text(_))) => {
                    // Wire protocol is binary msgpack; reject text
                    // frames loudly so clients don't silently drift.
                    let err = ServerMessage::Error {
                        code: "wire".into(),
                        message: "binary msgpack frames only".into(),
                    };
                    if !send_frame(&mut tx, &err).await { break; }
                }
                Some(Ok(Message::Ping(p))) => {
                    let _ = tx.send(Message::Pong(p)).await;
                }
                Some(Ok(Message::Pong(_))) | Some(Ok(Message::Close(_))) => {}
                Some(Err(e)) => {
                    warn!(conn = conn_id, error = %e, "ws error");
                    break;
                }
                None => break,
            }
        }
    }

    info!(conn = conn_id, "client disconnected");
}

async fn handle_client_message(
    msg: ClientMessage,
    state: &Arc<AppState>,
    is_admin: &mut bool,
    reply_tx: &mpsc::Sender<ServerMessage>,
    engine_cmd: Option<&mpsc::Sender<EngineCmd>>,
) {
    match msg {
        ClientMessage::Auth { token } => {
            *is_admin = token
                .as_deref()
                .map(|t| state.check_admin_token(t))
                .unwrap_or(false);
            // Re-issue capabilities so the client UI can light up the
            // admin controls.
            let _ = reply_tx
                .send(ServerMessage::Hello {
                    protocol: PROTOCOL_VERSION,
                    build: state.build.clone(),
                    capabilities: capabilities(state, *is_admin),
                    chem_colors: chem_colors(),
                    chem_names: chem_names(),
                })
                .await;
        }
        ClientMessage::SetRunning { running } => {
            if let Some(engine_cmd) = engine_cmd {
                let _ = engine_cmd.send(EngineCmd::SetRunning(running)).await;
            }
        }
        ClientMessage::SetSimRate { rate } => {
            if let Some(engine_cmd) = engine_cmd {
                let _ = engine_cmd.send(EngineCmd::SetSimRate(rate)).await;
            }
        }
        ClientMessage::Save { .. } => {
            // Save lands with the save/load port (PORT_PROGRESS step 9).
            // The save format is the same JSON the TS world uses; the
            // serde shape is what's pending. Until then surface an
            // honest error rather than a silent drop.
            let _ = reply_tx
                .send(ServerMessage::Error {
                    code: "unimplemented".into(),
                    message: "save lands with the save/load port".into(),
                })
                .await;
        }
        ClientMessage::Admin { command } => {
            if !*is_admin {
                let label = admin_command_label(&command);
                let _ = reply_tx
                    .send(ServerMessage::AdminNack {
                        command: label.into(),
                        reason: "not authorised".into(),
                    })
                    .await;
                return;
            }
            let Some(engine_cmd) = engine_cmd else {
                let _ = reply_tx
                    .send(ServerMessage::Error {
                        code: "internal".into(),
                        message: "engine command channel missing".into(),
                    })
                    .await;
                return;
            };
            admin::handle(command, state.clone(), engine_cmd.clone(), reply_tx.clone()).await;
        }
    }
}

fn admin_command_label(cmd: &evosim_protocol::AdminCommand) -> &'static str {
    use evosim_protocol::AdminCommand::*;
    match cmd {
        Restart => "restart",
        Update { .. } => "update",
        Snapshot => "snapshot",
        Reset => "reset",
        Status => "status",
    }
}

/// Hex colour for every chem id, cached at first call.
fn chem_colors() -> Vec<String> {
    // The chem table is pinned in a OnceLock; cloning the Vec<String>
    // once per connect is fine.
    evosim_engine::chemistry::table()
        .chems
        .iter()
        .map(|c| c.color.clone())
        .collect()
}

/// Human label for every chem id, same indexing as `chem_colors`.
fn chem_names() -> Vec<String> {
    evosim_engine::chemistry::table()
        .chems
        .iter()
        .map(|c| c.name.clone())
        .collect()
}

fn capabilities(_state: &AppState, is_admin: bool) -> ServerCapabilities {
    ServerCapabilities {
        // The Rust engine port hasn't landed yet; report what we know
        // honestly so the client UI doesn't promise features that
        // don't work. Flip to runtime-probed values once the engine
        // exposes them.
        gpu_compute: false,
        cpu_threads: std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(1),
        admin: is_admin,
    }
}

async fn send_frame(
    tx: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    msg: &ServerMessage,
) -> bool {
    let Ok(bytes) = encode_server(msg) else {
        warn!("encode failed for outbound frame");
        return false;
    };
    tx.send(Message::Binary(bytes)).await.is_ok()
}

/// Temporary access point for the engine command channel. The clean
/// version threads `EngineHandle` through `AppState`; we sidestep that
/// here by stashing the sender in a OnceCell at boot. Replaced by an
/// `Arc<EngineHandle>` field on AppState in the next foundational
/// commit when we wire controller commands too.
static ENGINE_CMD: std::sync::OnceLock<mpsc::Sender<EngineCmd>> = std::sync::OnceLock::new();

pub fn install_engine_handle(h: &EngineHandle) {
    let _ = ENGINE_CMD.set(h.cmd_tx.clone());
}

fn state_engine_cmd() -> Option<mpsc::Sender<EngineCmd>> {
    ENGINE_CMD.get().cloned()
}
