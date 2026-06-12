//! End-to-end wire conformance smoke test. Spawns the actual server
//! binary against a random localhost port, opens a WebSocket, asserts
//! the handshake handshake + a couple of snapshots arrive in the
//! expected shape, and shuts it down. Catches:
//!
//! - protocol struct drift (encode -> decode round-trip)
//! - Hello frame missing fields (e.g. terrain / chem_colors)
//! - tick clock not advancing
//! - snapshot cadence regression (we get at least N snapshots in T sec)
//!
//! Doesn't replace the unit tests; this is the "did we wire it up at
//! all" gate. ~2 s runtime; run via `cargo test --workspace`.

use std::time::Duration;

use evosim_protocol::{decode_server, ServerMessage};
use futures_util::StreamExt;
use tokio_tungstenite::tungstenite::Message;

/// Spin up the release binary. The build is cached so subsequent runs
/// are quick; the first run from a clean checkout adds a one-time
/// cargo build cost.
async fn spawn_server(port: u16) -> tokio::process::Child {
    // The test binary is built into the same target dir as the
    // package. Walking up from CARGO_MANIFEST_DIR to find target/
    // works for both release + debug profiles.
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let server_dir = std::path::PathBuf::from(&manifest_dir);
    let workspace_dir = server_dir.parent().unwrap().parent().unwrap();
    let bin = workspace_dir.join("target/release/evosim-server");
    if !bin.exists() {
        // Build on demand. Release so the binary matches what the
        // bench / production user runs.
        let status = std::process::Command::new("cargo")
            .args(["build", "--release", "--locked", "-p", "evosim-server"])
            .current_dir(workspace_dir)
            .status()
            .expect("cargo build failed to invoke");
        assert!(status.success(), "cargo build failed");
    }
    tokio::process::Command::new(&bin)
        .env("EVOSIM_BIND", format!("127.0.0.1:{port}"))
        // No admin token -- this test only exercises observer-level
        // commands.
        .env_remove("EVOSIM_ADMIN_TOKEN")
        // Skip the per-test particle inflation so tick budget stays low.
        .env("EVOSIM_PARTICLE_CAP", "200")
        .env("RUST_LOG", "warn")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn evosim-server")
}

async fn wait_for_listening(port: u16) -> bool {
    for _ in 0..50 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

#[tokio::test]
async fn hello_and_two_snapshots_round_trip() {
    // Random ephemeral port. The OS picks one for us via bind(0); we
    // close that and let the server reuse it on the next bind() --
    // racy in theory but very rarely flakes on a single test machine.
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let mut server = spawn_server(port).await;
    let ok = wait_for_listening(port).await;
    if !ok {
        let _ = server.kill().await;
        panic!("server never opened {port}");
    }
    let url = format!("ws://127.0.0.1:{port}/sim");
    let (mut ws, _resp) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("ws connect");

    // First frame: Hello.
    let frame = ws
        .next()
        .await
        .expect("hello frame missing")
        .expect("ws err");
    let Message::Binary(bytes) = frame else {
        panic!("expected binary Hello, got {frame:?}");
    };
    let msg = decode_server(&bytes).expect("decode hello");
    let (chem_names_len, terrain_len) = match msg {
        ServerMessage::Hello {
            chem_names,
            terrain,
            ..
        } => (chem_names.len(), terrain.len()),
        other => panic!("expected Hello, got {other:?}"),
    };
    assert!(chem_names_len >= 13, "chem_names short: {chem_names_len}");
    // Terrain may be empty if the default world doesn't install
    // obstacles, but the field must exist and be sane.
    assert!(terrain_len < 1000, "implausible terrain count: {terrain_len}");

    // Subsequent snapshots. We require at least 2 within 2 seconds at
    // the default 30 Hz cadence; this catches a regressed tick loop.
    let mut snapshots = 0;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    let mut last_tick = 0_u64;
    let mut first_tick: Option<u64> = None;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        let next = tokio::time::timeout(remaining, ws.next()).await;
        let Ok(Some(Ok(Message::Binary(bytes)))) = next else {
            continue;
        };
        let Ok(decoded) = decode_server(&bytes) else {
            continue;
        };
        if let ServerMessage::Snapshot(s) = decoded {
            first_tick.get_or_insert(s.tick);
            assert!(
                s.tick >= last_tick,
                "tick went backwards: {last_tick} -> {}",
                s.tick
            );
            last_tick = s.tick;
            assert!(s.width > 0.0 && s.height > 0.0, "world dims zero");
            assert!(
                s.surface_y >= 0.0 && s.surface_y < s.height,
                "surface_y out of range: {}",
                s.surface_y
            );
            snapshots += 1;
            if snapshots >= 2 {
                break;
            }
        }
    }
    assert!(snapshots >= 2, "expected >=2 snapshots, got {snapshots}");
    assert!(
        last_tick > first_tick.unwrap_or(0),
        "tick clock not advancing: first={:?} last={last_tick}",
        first_tick
    );

    let _ = ws.close(None).await;
    let _ = server.kill().await;
}
