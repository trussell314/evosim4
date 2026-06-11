//! Wire types shared by the Rust server and any client. Tagged unions
//! map directly to TypeScript discriminated unions on the client side,
//! and msgpack encoding gives us native TypedArray payloads for the
//! per-particle / per-creature blobs without inflating to JSON.
//!
//! Two top-level enums: `ServerMessage` (server -> client) and
//! `ClientMessage` (client -> server). The `Admin*` variants are gated
//! by a bearer token in [`ClientMessage::Admin`] and dropped silently
//! otherwise; see `server/README.md` for the operator-facing contract.
//!
//! Versioning: a single integer in the `Hello` frame. Servers refuse
//! clients with a mismatched major. We bump on any breaking change
//! and document the migration in the same commit.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

/// Protocol-major. Bump on any breaking change to either enum.
///
/// History:
///   1 -- initial release (foundation commit `f95c438`)
///   2 -- Hello carries chem_colors + chem_names so the client can
///        render with the server's chemistry table instead of a
///        synthetic hue-by-id
///   3 -- AdminCommand grows Load { name } + Saves; ClientMessage
///        Save semantics are real (the engine ports save/load JSON)
pub const PROTOCOL_VERSION: u32 = 3;

/// Lightweight build identity sent in [`ServerMessage::Hello`]. The
/// client surfaces these in the bottom HUD so it's obvious which
/// binary is talking back, and so an admin restart that swaps in a
/// new build is observable from the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildInfo {
    /// Cargo package version of `evosim-server`.
    pub version: String,
    /// Short git commit (build-time env, "unknown" outside CI/local).
    pub commit: String,
    /// Unix epoch seconds at build time.
    pub built_at: u64,
}

/// Capability flags negotiated at handshake. The client adapts its UI
/// from these (e.g. hide the GPU controls if the server reports no
/// GPU). Honest "no GPU" beats a wired control that silently no-ops.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerCapabilities {
    /// True iff the server engine can dispatch the per-particle force
    /// pass to a GPU compute kernel.
    pub gpu_compute: bool,
    /// Logical CPU count the server reports for its parallel pools.
    /// The client surfaces this as `cpu pool/M` in the HUD.
    pub cpu_threads: u32,
    /// True iff this connection is authorised for admin commands. A
    /// caller without the bearer token sees `false` here and any
    /// admin commands it sends will be ignored.
    pub admin: bool,
}

/// Compact tick summary the server pushes at the snapshot cadence.
/// Field names mirror the TS `RenderSnapshot` interface so a port of
/// the existing renderer stays straightforward. Specialised binary
/// blobs (particle SoA, creature SoA) come in as `Vec<u8>` and the
/// client unpacks with typed-array views.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub tick: u64,
    /// Sim time, seconds.
    pub t: f64,
    pub width: f32,
    pub height: f32,
    /// SoA blobs. Layout described in `server/PROTOCOL.md`; each block
    /// is a contiguous TypedArray-compatible buffer.
    pub particles: Soa,
    pub creatures: Soa,
    /// Force dispatch indicator -- mirrors the TS field one-for-one
    /// so the existing bottom-HUD code can light up the same tokens.
    pub force_source: ForceSource,
    /// Live count of CPU pool workers (0 if no pool spun up).
    pub cpu_pool_workers: u32,
    /// EMA of the GPU dispatch round-trip in ms; 0 if no GPU dispatch
    /// has happened yet.
    pub gpu_last_ms: f32,
    /// Distinct coding-key count across live creatures (intron-stripped
    /// species fingerprint). The TS HUD shows this as
    /// `species/genomes`. Defaults to 0 on builds that haven't ported
    /// the species pass yet.
    #[serde(default)]
    pub species_count: u32,
    /// Cells dead since the last snapshot. Lets the client surface a
    /// per-window mortality rate without keeping its own history.
    #[serde(default)]
    pub deaths_this_window: u32,
    /// Sim-second period of one day/night cycle. The client uses this
    /// to render a sun position, schedule UI animations, etc.
    /// 0 means daylight is constant (no cycle).
    #[serde(default)]
    pub day_period_s: f64,
    /// Current ambient light in `[0, 1]`. Sampled by the engine from
    /// the day/night cycle.
    #[serde(default)]
    pub ambient_light: f32,
    /// Top species summary -- up to N entries -- with their
    /// population, coding key fingerprint, and a small color the
    /// client can paint cells with. Sorted by population descending.
    /// Empty before the species pass populates it.
    #[serde(default)]
    pub top_species: Vec<SpeciesSummary>,
    /// Flat list of (cell_i, cell_j) bonded pairs, i < j. Lets the
    /// client render bonds as line segments without per-cell
    /// variable-length blobs. Each u32 pair is 8 bytes; a typical
    /// bonded population of ~20 cells with ~3 bonds each ships ~240
    /// bytes total.
    #[serde(default)]
    pub bonds: Vec<u32>,
}

/// One row of the per-snapshot species summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeciesSummary {
    /// Stable coding-key fingerprint (intron-stripped genome string).
    pub coding_key: String,
    /// Live cell count of this species at snapshot time.
    pub count: u32,
    /// Hex color the client can use to paint cells of this species.
    /// Deterministic from the coding_key so the same genome looks
    /// the same across reconnects.
    pub color: String,
    /// Representative genome bytes -- the genome of the first live
    /// cell encountered for this coding key. Lets the client show a
    /// disassembly without an extra round trip; trivially small (< 2 KB
    /// across all top species).
    #[serde(default)]
    #[serde(with = "serde_bytes")]
    pub genome: Vec<u8>,
    /// Server-rendered plain-English summary of what this genome
    /// does. Multi-line. Lets the client show a description without
    /// shipping the opcode table or duplicating the describer.
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Soa {
    /// Number of records in the SoA. Each named blob has exactly this
    /// many elements at its declared element size.
    pub count: u32,
    /// Column-major payload. Key = column name, value = packed bytes.
    /// The protocol doc lists which columns exist and at what stride.
    pub blobs: Vec<NamedBlob>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NamedBlob {
    pub name: String,
    /// Bytes per element. The client uses this to pick the right
    /// TypedArray view (4 = Float32Array / Int32Array, 1 = Uint8Array).
    pub stride: u8,
    #[serde(with = "serde_bytes")]
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ForceSource {
    Gpu,
    Cpu,
    Serial,
}

/// Messages flowing server -> client.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ServerMessage {
    /// First frame after handshake; tells the client what it's talking
    /// to and whether its admin token (if any) was accepted.
    Hello {
        protocol: u32,
        build: BuildInfo,
        capabilities: ServerCapabilities,
        /// Per-chem hex color and human label, indexed by chem id.
        /// Sent once at handshake so the client renderer can colour
        /// particles by their actual chemistry table -- avoids
        /// shipping a duplicate static table on every snapshot.
        /// Length matches the server's chem table; clients should
        /// fall back to a synthetic colour when an index exceeds
        /// the array length.
        chem_colors: Vec<String>,
        chem_names: Vec<String>,
    },
    /// Recurring snapshot. Push cadence ~10 Hz, matches TS sim worker.
    Snapshot(Snapshot),
    /// Server-side error surfaced for client display. Non-fatal: the
    /// connection stays open. Fatal errors close the socket.
    Error { code: String, message: String },
    /// Server is going down (admin restart / update). Client should
    /// schedule a reconnect with backoff.
    Goodbye { reason: String },
    /// Acknowledgement of an admin command (success). Carries an
    /// optional message useful for the operator UI.
    AdminAck { command: String, message: Option<String> },
    /// Acknowledgement of an admin command (failure).
    AdminNack { command: String, reason: String },
}

/// Messages flowing client -> server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ClientMessage {
    /// Optional first frame from the client. Carries the bearer token
    /// when present. Sending it after Hello is allowed and triggers a
    /// re-issue of capabilities reflecting the new admin status.
    Auth { token: Option<String> },
    /// Pause / resume the simulation. Read-only observers see the
    /// command and ignore it; controllers honour it.
    SetRunning { running: bool },
    /// Adjust the per-tick wall-clock pacing (1.0 = real-time,
    /// 0.0 = paused, <0 forbidden). Snaps to nearest supported speed
    /// server-side; the snapshot's force_source / cpu_pool_workers
    /// fields are unaffected.
    SetSimRate { rate: f32 },
    /// Save the current world to the server's save directory.
    Save { name: Option<String> },
    /// Admin gate. Carries one of the [`AdminCommand`] variants; the
    /// server rejects with [`ServerMessage::AdminNack`] when the
    /// connection isn't authorised.
    Admin { command: AdminCommand },
}

/// Privileged commands the server only honours from an authenticated
/// connection. Designed so that the operator UI on the client side can
/// trigger a code update + restart without shelling into the box.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AdminCommand {
    /// Restart the engine subprocess. The supervisor (or a wrapping
    /// systemd unit) relaunches a fresh worker. Current connections
    /// receive [`ServerMessage::Goodbye`] before the socket closes.
    Restart,
    /// Pull the latest from the configured git remote+ref, rebuild
    /// the server binary, then restart. The server reports progress
    /// via a sequence of [`ServerMessage::AdminAck`] frames before
    /// the final [`ServerMessage::Goodbye`].
    Update { branch: Option<String> },
    /// Snapshot the engine state and persist it to disk. Useful as a
    /// "save before risky thing" call.
    Snapshot,
    /// Drop the world and start a fresh one from defaults.
    Reset,
    /// Report engine + supervisor health. The reply carries a JSON
    /// blob in [`ServerMessage::AdminAck::message`].
    Status,
    /// Load a previously-saved world JSON by file name (relative to
    /// the server's save directory). Restricted to admin because
    /// reading arbitrary state into the running engine is more
    /// invasive than `SetRunning` / `SetSimRate`.
    Load { name: String },
    /// List the saves currently on disk. Reply message is a JSON
    /// array of file names.
    Saves,
}

/// Helper: encode a server message as msgpack. Keeps the binary frame
/// shape in one place so the server and an in-process test agree.
pub fn encode_server(msg: &ServerMessage) -> Result<Vec<u8>, rmp_serde::encode::Error> {
    rmp_serde::to_vec_named(msg)
}

/// Helper: decode a client message from a msgpack frame.
pub fn decode_client(bytes: &[u8]) -> Result<ClientMessage, rmp_serde::decode::Error> {
    rmp_serde::from_slice(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_hello() {
        let msg = ServerMessage::Hello {
            protocol: PROTOCOL_VERSION,
            build: BuildInfo {
                version: "0.1.0".into(),
                commit: "abcdef0".into(),
                built_at: 0,
            },
            capabilities: ServerCapabilities {
                gpu_compute: true,
                cpu_threads: 8,
                admin: false,
            },
            chem_colors: vec!["#ff0000".into()],
            chem_names: vec!["test".into()],
        };
        let bytes = encode_server(&msg).unwrap();
        let back: ServerMessage = rmp_serde::from_slice(&bytes).unwrap();
        match back {
            ServerMessage::Hello { protocol, capabilities, .. } => {
                assert_eq!(protocol, PROTOCOL_VERSION);
                assert!(capabilities.gpu_compute);
            }
            _ => panic!("unexpected variant"),
        }
    }

    #[test]
    fn admin_command_round_trip() {
        let msg = ClientMessage::Admin {
            command: AdminCommand::Update { branch: Some("main".into()) },
        };
        let bytes = rmp_serde::to_vec_named(&msg).unwrap();
        let back = decode_client(&bytes).unwrap();
        assert!(matches!(
            back,
            ClientMessage::Admin {
                command: AdminCommand::Update { branch: Some(_) }
            }
        ));
    }
}
