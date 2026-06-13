// Minimal evosim-server client. Connects via WebSocket, decodes
// msgpack frames, renders particles to a canvas. Designed to exercise
// the wire end-to-end before the full TS app integration lands; this
// file deliberately mirrors the protocol crate's type shape and
// nothing else.

import { decode, encode } from "@msgpack/msgpack";

interface BuildInfo { version: string; commit: string; built_at: number; }
interface ServerCaps { gpu_compute: boolean; cpu_threads: number; admin: boolean; }
interface NamedBlob { name: string; stride: number; data: Uint8Array; }
interface Soa { count: number; blobs: NamedBlob[]; }
interface SpeciesSummary {
  coding_key: string;
  count: number;
  color: string;
  genome?: Uint8Array;
  description?: string;
  biomass?: number;
  atp?: number;
}
// Minimal op-name lookup so the client can render a basic disasm. Not
// exhaustive -- enough for the demo. Mirrors src/genome.rs.
const OP_NAMES: Record<number, string> = {
  0x00: "NOP",
  0x01: "PUSH8",
  0x02: "POP",
  0x03: "DUP",
  0x04: "SWAP",
  0x05: "OVER",
  0x06: "ROT",
  0x07: "LOAD",
  0x08: "STORE",
  0x10: "ADD",
  0x11: "SUB",
  0x12: "MUL",
  0x13: "DIV",
  0x14: "NEG",
  0x15: "ABS",
  0x16: "MIN",
  0x17: "MAX",
  0x18: "MOD",
  0x19: "SIGN",
  0x20: "LT",
  0x21: "GT",
  0x22: "EQ",
  0x23: "NOT",
  0x24: "AND",
  0x25: "OR",
  0x30: "JMP",
  0x31: "JZ",
  0x32: "JNZ",
  0x40: "SELF_ENERGY",
  0x41: "SELF_MASS",
  0x42: "SELF_MEMBRANE",
  0x43: "SENSE_CHEMICAL",
  0x44: "SENSE_OUT",
  0x45: "SYNTH",
  0x46: "SENSE_AMP",
  0x47: "POKE_BYTE",
  0x48: "PEEK_BYTE",
  0x49: "SPLICE_DUP",
  0x4a: "SPLICE_DEL",
  0x4b: "PARTITION",
  0x50: "THRUST",
  0x51: "EMIT",
  0x52: "EXCRETE",
  0x53: "TRANSPORT",
  0x54: "REPRODUCE",
  0x55: "PREDATE",
  0x56: "ENGULF",
  0x57: "INGEST",
  0x58: "TURN",
  0x6a: "GENE",
  0x6b: "END",
};
const OPS_WITH_OPERAND = new Set([0x01, 0x07, 0x08, 0x30, 0x31, 0x32, 0x43, 0x44, 0x46, 0x4b, 0x51, 0x52, 0x53]);
const OPS_WITH_TWO_OPERANDS = new Set([0x45]); // SYNTH

function disassemble(genome: Uint8Array): string {
  const lines: string[] = [];
  let pc = 0;
  while (pc < genome.length) {
    const op = genome[pc];
    const name = OP_NAMES[op] ?? `0x${op.toString(16).padStart(2, "0")}`;
    if (OPS_WITH_TWO_OPERANDS.has(op)) {
      const a = genome[pc + 1] ?? 0;
      const b = genome[pc + 2] ?? 0;
      lines.push(`${pc.toString().padStart(3)}: ${name} ${a} ${b}`);
      pc += 3;
    } else if (OPS_WITH_OPERAND.has(op)) {
      const a = genome[pc + 1] ?? 0;
      lines.push(`${pc.toString().padStart(3)}: ${name} ${a}`);
      pc += 2;
    } else {
      lines.push(`${pc.toString().padStart(3)}: ${name}`);
      pc += 1;
    }
  }
  return lines.join("\n");
}
interface Snapshot {
  tick: number; t: number; width: number; height: number;
  surface_y?: number;
  sim_rate?: number;
  running?: boolean;
  auto_reseeds?: number;
  particles: Soa; creatures: Soa;
  force_source: "gpu" | "cpu" | "serial";
  cpu_pool_workers: number;
  gpu_last_ms: number;
  species_count?: number;
  deaths_this_window?: number;
  day_period_s?: number;
  ambient_light?: number;
  top_species?: SpeciesSummary[];
  bonds?: number[];
  ambient_chems?: number[];
  mass?: { cell_chems: number; cell_catalysts: number; particles: number; ambient: number; total: number };
}
type ServerMessage =
  | { type: "hello"; protocol: number; build: BuildInfo; capabilities: ServerCaps;
      chem_colors: string[]; chem_names: string[];
      // Each inner array is one rock as alternating x,y pairs flattened.
      terrain?: number[][] }
  | ({ type: "snapshot" } & Snapshot)
  | { type: "error"; code: string; message: string }
  | { type: "goodbye"; reason: string }
  | { type: "admin-ack"; command: string; message: string | null }
  | { type: "admin-nack"; command: string; reason: string };

// --- DOM
const urlInput = document.getElementById("url") as HTMLInputElement;
const tokenInput = document.getElementById("token") as HTMLInputElement;
const connectBtn = document.getElementById("connect") as HTMLButtonElement;
const disconnectBtn = document.getElementById("disconnect") as HTMLButtonElement;
const pauseBtn = document.getElementById("pause") as HTMLButtonElement;
const resumeBtn = document.getElementById("resume") as HTMLButtonElement;
const speedSlider = document.getElementById("speed") as HTMLInputElement;
const speedReadout = document.getElementById("speedReadout") as HTMLSpanElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const resetBtn = document.getElementById("reset") as HTMLButtonElement;
const updateServerBtn = document.getElementById("update-server") as HTMLButtonElement;
const updateClientBtn = document.getElementById("update-client") as HTMLButtonElement;
const toggleAmbientBtn = document.getElementById("toggle-ambient") as HTMLButtonElement;
const toggleSpeciesBtn = document.getElementById("toggle-species") as HTMLButtonElement;
const ambientCloseBtn = document.getElementById("ambient-close") as HTMLButtonElement;
const speciesCloseBtn = document.getElementById("species-close") as HTMLButtonElement;
const stepBtn = document.getElementById("step") as HTMLButtonElement;
const speedMaxBtn = document.getElementById("speedMax") as HTMLButtonElement;
const pausedOverlay = document.getElementById("paused-overlay") as HTMLDivElement;
const configureBtn = document.getElementById("configure") as HTMLButtonElement;
const resetViewBtn = document.getElementById("reset-view") as HTMLButtonElement;
const configureDialog = document.getElementById("configure-dialog") as HTMLDialogElement;
const loadBtn = document.getElementById("load") as HTMLButtonElement;
const loadDialog = document.getElementById("load-dialog") as HTMLDialogElement;
const loadList = document.getElementById("load-list") as HTMLDivElement;
const helpBtn = document.getElementById("help") as HTMLButtonElement;
const helpDialog = document.getElementById("help-dialog") as HTMLDialogElement;
helpBtn.onclick = () => helpDialog.showModal();
window.addEventListener("keydown", (ev) => {
  if (ev.target instanceof HTMLInputElement) return;
  if (ev.key === "?") helpDialog.showModal();
});
loadBtn.onclick = async () => {
  loadList.innerHTML = "<div class='dim'>loading…</div>";
  loadDialog.showModal();
  // Saves list comes back as a JSON string in AdminAck.message; we
  // poll a oneshot via a per-call await pattern.
  const reply = await sendAdminAwait({ kind: "saves" });
  if (!reply || reply.type === "admin-nack") {
    loadList.innerHTML = `<div class='err'>${reply ? reply.reason : "no reply"}</div>`;
    return;
  }
  try {
    const names: string[] = JSON.parse(reply.message ?? "[]");
    if (names.length === 0) {
      loadList.innerHTML = "<div class='dim'>(no saves)</div>";
      return;
    }
    loadList.innerHTML = "";
    for (const name of names) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex; justify-content:space-between; align-items:center; padding:3px 0; border-bottom:1px solid #1a3340;";
      row.innerHTML = `<span>${name}</span><button style="background:#0d1c26; border:1px solid #2a4d62; color:#cef; padding:2px 8px; cursor:pointer; font:inherit;">Load</button>`;
      const btn = row.querySelector("button") as HTMLButtonElement;
      btn.onclick = () => {
        send({ type: "admin", command: { kind: "load", name } });
        loadDialog.close();
      };
      loadList.appendChild(row);
    }
  } catch (e) {
    loadList.innerHTML = `<div class='err'>parse: ${e}</div>`;
  }
};
// Promise-based admin RPC: send, then wait for the matching ack/nack.
// We hook a one-shot resolver onto the next handle() call for the
// matching command kind. Multiple pending awaits queue in arrival
// order.
type AdminReply = { type: "admin-ack"; command: string; message: string | null }
  | { type: "admin-nack"; command: string; reason: string };
const pendingAdminAwaits: Map<string, ((r: AdminReply) => void)[]> = new Map();
function sendAdminAwait(cmd: Record<string, unknown>): Promise<AdminReply | null> {
  const kind = cmd.kind as string;
  return new Promise((resolve) => {
    const list = pendingAdminAwaits.get(kind) ?? [];
    list.push(resolve);
    pendingAdminAwaits.set(kind, list);
    send({ type: "admin", command: cmd });
    // Bail if no reply arrives within 8s.
    setTimeout(() => {
      const cur = pendingAdminAwaits.get(kind) ?? [];
      const idx = cur.indexOf(resolve);
      if (idx >= 0) {
        cur.splice(idx, 1);
        resolve(null);
      }
    }, 8000);
  });
}
const overlaySelect = document.getElementById("overlay-mode") as HTMLSelectElement;
const speciesPanel = document.getElementById("species-panel") as HTMLElement;
const speciesList = document.getElementById("species-list") as HTMLOListElement;
const disasmEl = document.getElementById("disasm") as HTMLElement;
const ambientPanel = document.getElementById("ambient-panel") as HTMLElement;
const ambientList = document.getElementById("ambient-list") as HTMLOListElement;
const inspectorPanel = document.getElementById("inspector-panel") as HTMLElement;
const inspectorBody = document.getElementById("inspector-body") as HTMLElement;
const inspectorCloseBtn = document.getElementById("inspector-close") as HTMLButtonElement;
let selectedSpeciesKey: string | null = null;
let followSelectedCell = false;
// Species pinned by the user. Pinned entries persist across
// snapshots even if they fall out of the top-N roster -- they're
// rendered at the top of the species list with their last-known
// summary frozen, so an extinction-on-the-edge case still appears in
// the panel.
const pinnedSpecies: Map<string, SpeciesSummary & { lastSeen: number }> = new Map();
type OverlayMode = "none" | "density" | "light" | "mass" | "perf" | "history";
// Rolling population history -- one sample per received snapshot, kept
// for ~120s at 30 Hz. Drawn as a stacked sparkline overlay when the
// 'history' mode is active so the operator can see the population
// trajectory without leaving the canvas.
interface HistorySample { t: number; cells: number; species: number; mass: number }
const POP_HISTORY: HistorySample[] = [];
const POP_HISTORY_MAX = 3600;
let overlayMode: OverlayMode =
  (localStorage.getItem("evosim:overlay") as OverlayMode | null) ?? "none";
overlaySelect.value = overlayMode;
overlaySelect.onchange = () => {
  overlayMode = overlaySelect.value as OverlayMode;
  localStorage.setItem("evosim:overlay", overlayMode);
};
// Tracked cell selection. Stored as a world-coordinate "memo" so the
// inspector follows the cell across snapshots even when its SoA index
// shifts (death + reproduction reshuffle indices). On each frame we
// re-resolve to the nearest live cell within SELECT_FOLLOW_R px.
interface SelectedCellMemo { x: number; y: number; r: number }
let selectedCell: SelectedCellMemo | null = null;
const SELECT_FOLLOW_R = 30;
const statusEl = document.getElementById("status") as HTMLDivElement;
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("no 2d context");

// --- State
let ws: WebSocket | null = null;
let snapshot: Snapshot | null = null;
let lastSnapshotAt = 0;
let snapsPerSec = 0;
let snapAccum = 0;
let snapWindowStart = performance.now();
let isAdmin = false;
let build: BuildInfo | null = null;
let chemColors: string[] = [];
let chemNames: string[] = [];
// Static terrain polygons from the Hello frame. One Float32Array per
// rock, alternating x,y. Empty until Hello lands; rendered every frame.
let terrain: Float32Array[] = [];
// Panel visibility -- defaults to CLOSED so the canvas is the
// focal point on first load; toolbar buttons A and S open them on
// demand. Restored from localStorage so the operator's choice
// persists across reloads.
let showAmbient = localStorage.getItem("evosim:ambient") === "1";
let showSpecies = localStorage.getItem("evosim:species") === "1";

// Default the URL field to a ws/wss URL on the same host the page was
// served from, with the configured server port. So a phone that loaded
// http://192.168.1.13:5174/ gets ws://192.168.1.13:8080/sim prefilled
// instead of ws://127.0.0.1... (which only worked from the host itself).
// Use wss:// when the page was served over https so mixed-content
// blocking doesn't kill the connection.
function defaultServerUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  // Allow ?serverPort=8080 to override; otherwise hardcoded to the
  // up.sh default. If the page itself is served from the same port as
  // the server (unusual but possible), point at it explicitly.
  const portFromUrl = new URLSearchParams(window.location.search).get("serverPort");
  const port = portFromUrl ?? "8080";
  const host = window.location.hostname || "127.0.0.1";
  return `${proto}://${host}:${port}/sim`;
}

/// Sun / moon position. Returns canvas pixel coords + which body to
/// render. Day phase 0..0.5 -> sun arcs left to right across the sky;
/// night phase 0.5..1 -> moon does the same. The arc peaks at the
/// midpoint of each half-cycle (high noon / high midnight).
///
/// `surfaceCanvasY` is where the sky ends; the body's horizon line
/// sits just above it.
function sunMoonPos(
  t: number,
  periodS: number,
  canvasW: number,
  surfaceCanvasY: number,
): { x: number; y: number; isDay: boolean } | null {
  if (!periodS || periodS <= 0) return null;
  const phase = ((t / periodS) % 1 + 1) % 1; // robust mod for negative t
  const isDay = phase < 0.5;
  const halfProgress = isDay ? phase * 2 : (phase - 0.5) * 2; // 0..1
  const x = canvasW * halfProgress;
  // Arc peaks at halfProgress=0.5; horizon at 0 and 1.
  const horizonY = Math.max(20, surfaceCanvasY - 8);
  const peakY = Math.max(20, surfaceCanvasY * 0.15);
  const arcDepth = horizonY - peakY;
  const y = horizonY - Math.sin(halfProgress * Math.PI) * arcDepth;
  return { x, y, isDay };
}

/// Force a saved URL into the ws://host:port/sim canonical shape. Old
/// saved entries occasionally lacked the /sim path; without it the
/// server hits the catch-all 404. Idempotent.
function normaliseServerUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.pathname === "/" || u.pathname === "") u.pathname = "/sim";
    return u.toString();
  } catch {
    return raw;
  }
}

// Save the URL + token in localStorage so a reload doesn't re-type.
// The URL precedence is:
//   1. ?server=... query string (one-shot override -- handy for phones
//      pinning a specific LAN IP via QR code)
//   2. localStorage (last successful URL the user connected with)
//   3. defaultServerUrl() built from window.location
{
  const overrideUrl = new URLSearchParams(window.location.search).get("server");
  const savedUrl = localStorage.getItem("evosim:url");
  urlInput.value = normaliseServerUrl(overrideUrl ?? savedUrl ?? defaultServerUrl());
  const savedTok = localStorage.getItem("evosim:token");
  if (savedTok) tokenInput.value = savedTok;
  // Restore pinned species (keyed by coding_key).
  try {
    const raw = localStorage.getItem("evosim:pinned");
    if (raw) {
      const arr = JSON.parse(raw) as Array<SpeciesSummary & { lastSeen: number }>;
      for (const sp of arr) pinnedSpecies.set(sp.coding_key, sp);
    }
  } catch (_) { /* ignore corrupted */ }
}

function persistPinnedSpecies(): void {
  try {
    const arr = Array.from(pinnedSpecies.values()).map((sp) => ({
      ...sp,
      // Strip Uint8Array genome -- localStorage stores JSON, so the
      // disasm only renders for currently-roster species. The
      // coding_key + color + last-known count is what matters across
      // reloads.
      genome: undefined,
    }));
    localStorage.setItem("evosim:pinned", JSON.stringify(arr));
  } catch (_) { /* ignore quota */ }
}

function startConnect(): void {
  urlInput.value = normaliseServerUrl(urlInput.value);
  localStorage.setItem("evosim:url", urlInput.value);
  localStorage.setItem("evosim:token", tokenInput.value);
  userIntendsConnection = true;
  connect(urlInput.value, tokenInput.value || null);
}
connectBtn.onclick = startConnect;
// Enter from the URL or token input fires Connect, matching the form
// affordance the bare <input>s don't provide on their own.
for (const el of [urlInput, tokenInput]) {
  el.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !connectBtn.disabled) startConnect();
  });
}
disconnectBtn.onclick = () => {
  userIntendsConnection = false;
  ws?.close();
};

// Auto-reconnect: if the user has connected at least once this
// session and the socket dies (mobile background, network hiccup,
// laptop sleep, admin "Update server"), reattach using the same URL +
// token whenever the document becomes visible again. The manual
// Disconnect button clears the intent flag so users who explicitly
// went idle stay idle.
//
// Backoff schedule is exponential and capped at 8s so the page stays
// responsive while the server rebuilds (cargo build --release tends to
// take 30-120s). The window of "page came back to the foreground" and
// "network came back online" resets the backoff so a fresh attempt is
// fast.
let userIntendsConnection = false;
let reconnectTimer: number | null = null;
let reconnectDelay = 500;
const RECONNECT_DELAY_MIN = 500;
const RECONNECT_DELAY_MAX = 8000;
function scheduleReconnect(delayMs?: number): void {
  if (reconnectTimer !== null) return;
  const d = delayMs ?? reconnectDelay;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    if (!userIntendsConnection) return;
    if (ws && ws.readyState <= WebSocket.OPEN) return;
    // Grow for the NEXT attempt; success resets via ws.onopen below.
    reconnectDelay = Math.min(RECONNECT_DELAY_MAX, Math.max(RECONNECT_DELAY_MIN, reconnectDelay * 2));
    connect(urlInput.value, tokenInput.value || null);
  }, d);
}
function resetReconnectBackoff(): void {
  reconnectDelay = RECONNECT_DELAY_MIN;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}
function onMaybeForeground(): void {
  if (!userIntendsConnection) return;
  resetReconnectBackoff();
  // iOS Safari / Brave keep `ws.readyState === OPEN` after a long
  // background even when the TCP connection is already dead. Always
  // recycle on foreground -- the cost is one fresh handshake (~50 ms)
  // versus staying stuck on a zombie socket. If we recently saw a
  // snapshot the socket is probably fine, but recycling is still
  // cheaper than the alternative for the user.
  if (ws) {
    try { ws.close(); } catch (_) { /* nothing */ }
  }
  scheduleReconnect(200);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") onMaybeForeground();
});
// pageshow fires when iOS restores from bfcache (back / forward
// navigation, swipe-back, app switcher return). visibilitychange
// doesn't reliably cover those.
window.addEventListener("pageshow", () => {
  if (document.visibilityState === "visible") onMaybeForeground();
});
// focus catches desktop case (tab switch return); harmless on mobile.
window.addEventListener("focus", () => {
  if (document.visibilityState === "visible") onMaybeForeground();
});
window.addEventListener("online", () => {
  if (userIntendsConnection) {
    resetReconnectBackoff();
    scheduleReconnect(200);
  }
});
pauseBtn.onclick = () => send({ type: "set-running", running: false });
resumeBtn.onclick = () => send({ type: "set-running", running: true });
stepBtn.onclick = () => send({ type: "step" });
// Local input draws ground-truth slider position out from under the
// server snapshot; suppress the server-driven reset for a short
// window so the user's drag isn't fought.
let speedLocalUntil = 0;
speedSlider.oninput = () => {
  const rate = parseFloat(speedSlider.value);
  speedReadout.textContent = rate + "x";
  speedLocalUntil = performance.now() + 1500;
  send({ type: "set-sim-rate", rate });
};
speedMaxBtn.onclick = () => {
  speedSlider.value = "32";
  speedReadout.textContent = "32x";
  speedLocalUntil = performance.now() + 1500;
  send({ type: "set-sim-rate", rate: 32 });
};
saveBtn.onclick = () => {
  const name = prompt("Save name (alphanumeric, leave blank for auto):", "");
  send({ type: "save", name: name && name.trim() ? name.trim() : null });
};
resetBtn.onclick = () => send({ type: "admin", command: { kind: "reset" } });
resetViewBtn.onclick = () => resetView();
configureBtn.onclick = () => configureDialog.showModal();
configureDialog.addEventListener("close", () => {
  if (configureDialog.returnValue !== "apply") return;
  // Build the AdminCommand::Configure payload. Empty fields stay
  // unset so they keep their current server-side value.
  const num = (id: string): number | null => {
    const el = document.getElementById(id) as HTMLInputElement;
    const v = el.value.trim();
    if (v === "") return null;
    const parsed = parseFloat(v);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const cmd: Record<string, unknown> = { kind: "configure" };
  const width = num("cfg-width");
  const height = num("cfg-height");
  const seed = num("cfg-seed");
  const day = num("cfg-day");
  const founders = num("cfg-founders");
  if (width != null) cmd.width = width;
  if (height != null) cmd.height = height;
  if (seed != null) cmd.seed = Math.floor(seed);
  if (day != null) cmd.day_period_s = day;
  if (founders != null) cmd.founders_per_strategy = Math.floor(founders);
  send({ type: "admin", command: cmd });
});
updateServerBtn.onclick = () => {
  if (!confirm("Pull, rebuild, and restart the server? Takes ~1-2 min; the page will auto-reconnect when the new binary comes up.")) return;
  pendingReload = false;
  send({ type: "admin", command: { kind: "update", branch: null } });
};
updateClientBtn.onclick = () => {
  if (!confirm("Pull the repo and rebuild the client bundle? The page will reload when the build completes.")) return;
  pendingReload = true;
  send({ type: "admin", command: { kind: "update-client", pull: true } });
};
/// Set true while an update-client is in flight so the AdminAck
/// handler knows to reload the page on success rather than just
/// echoing the path.
let pendingReload = false;

function applyPanelVisibility(): void {
  // The render*Panel functions force-show their aside when data is
  // available; respect the toggle here by hiding them again on the
  // next frame. Cheap and idempotent.
  ambientPanel.style.display = showAmbient ? "block" : "none";
  speciesPanel.style.display = showSpecies ? "block" : "none";
  toggleAmbientBtn.style.background = showAmbient ? "#0d1c26" : "#07111a";
  toggleSpeciesBtn.style.background = showSpecies ? "#0d1c26" : "#07111a";
}
toggleAmbientBtn.onclick = () => {
  showAmbient = !showAmbient;
  localStorage.setItem("evosim:ambient", showAmbient ? "1" : "0");
  applyPanelVisibility();
};
toggleSpeciesBtn.onclick = () => {
  showSpecies = !showSpecies;
  localStorage.setItem("evosim:species", showSpecies ? "1" : "0");
  applyPanelVisibility();
};
ambientCloseBtn.onclick = () => toggleAmbientBtn.click();
speciesCloseBtn.onclick = () => toggleSpeciesBtn.click();
inspectorCloseBtn.onclick = () => {
  selectedCell = null;
  inspectorPanel.style.display = "none";
};
// Keyboard shortcut: 'i' toggles the inspector. Lets a phone user
// dismiss without aiming for the tiny x.
window.addEventListener("keydown", (ev) => {
  if (ev.target instanceof HTMLInputElement) return;
  if (ev.key === "i" || ev.key === "I") {
    if (selectedCell) {
      selectedCell = null;
      inspectorPanel.style.display = "none";
    }
  }
});
applyPanelVisibility();

function setStatus(html: string): void {
  statusEl.innerHTML = html;
}

function connect(url: string, token: string | null): void {
  setStatus(`<span class="dim">connecting to ${url}…</span>`);
  connectBtn.disabled = true;
  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    resetReconnectBackoff();
    setStatus(`<span class="ok">connected</span> <span class="dim">— awaiting hello</span>`);
    disconnectBtn.disabled = false;
    if (token) send({ type: "auth", token });
  };
  ws.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    const msg = decode(new Uint8Array(e.data)) as ServerMessage;
    handle(msg);
  };
  ws.onclose = () => {
    setStatus(`<span class="dim">disconnected</span>`);
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    pauseBtn.disabled = true;
    resumeBtn.disabled = true;
    stepBtn.disabled = true;
    speedSlider.disabled = true;
    speedMaxBtn.disabled = true;
    saveBtn.disabled = true;
    loadBtn.disabled = true;
    resetBtn.disabled = true;
    configureBtn.disabled = true;
    updateServerBtn.disabled = true;
    updateClientBtn.disabled = true;
    pausedOverlay.style.display = "none";
    snapshot = null;
    ws = null;
    // If the user didn't click Disconnect (e.g. mobile backgrounded,
    // wifi dropped, laptop slept, admin update-server in progress),
    // keep trying with exponential backoff up to 8 s.
    if (userIntendsConnection && document.visibilityState === "visible") {
      scheduleReconnect();
    }
  };
  ws.onerror = () => {
    setStatus(`<span class="err">connection error</span>`);
  };
}

function send(msg: unknown): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(encode(msg));
}

function handle(msg: ServerMessage): void {
  switch (msg.type) {
    case "hello":
      build = msg.build;
      isAdmin = msg.capabilities.admin;
      chemColors = msg.chem_colors;
      chemNames = msg.chem_names;
      // Terrain only ships on the initial handshake (the post-auth
      // re-Hello sends an empty array); keep what we have when the
      // server tells us nothing new.
      if (msg.terrain && msg.terrain.length > 0) {
        terrain = msg.terrain.map((flat) => Float32Array.from(flat));
      }
      pauseBtn.disabled = false;
      resumeBtn.disabled = false;
      stepBtn.disabled = false;
      speedSlider.disabled = false;
      speedMaxBtn.disabled = false;
      saveBtn.disabled = !isAdmin;
      loadBtn.disabled = !isAdmin;
      resetBtn.disabled = !isAdmin;
      configureBtn.disabled = !isAdmin;
      updateServerBtn.disabled = !isAdmin;
      updateClientBtn.disabled = !isAdmin;
      updateHeaderStatus();
      break;
    case "snapshot":
      snapshot = msg;
      const now = performance.now();
      lastSnapshotAt = now;
      snapAccum++;
      // Append to the rolling population history so the operator can
      // see the trajectory on the 'history' overlay even when sim
      // time is jumping.
      POP_HISTORY.push({
        t: msg.t,
        cells: msg.creatures.count,
        species: (msg as { species_count?: number }).species_count ?? 0,
        mass: msg.mass?.total ?? 0,
      });
      if (POP_HISTORY.length > POP_HISTORY_MAX) POP_HISTORY.shift();
      if (now - snapWindowStart > 1000) {
        snapsPerSec = snapAccum * 1000 / (now - snapWindowStart);
        snapAccum = 0;
        snapWindowStart = now;
      }
      // Sync UI controls to the server-wide ground truth so multiple
      // clients agree on speed / running state. Skip the slider sync
      // while the user is actively dragging.
      if (typeof msg.sim_rate === "number" && now > speedLocalUntil) {
        speedSlider.value = String(msg.sim_rate);
        speedReadout.textContent = msg.sim_rate + "x";
      }
      if (typeof msg.running === "boolean") {
        pausedOverlay.style.display = msg.running ? "none" : "flex";
        pauseBtn.disabled = !msg.running;
        resumeBtn.disabled = msg.running;
        stepBtn.disabled = msg.running;
      }
      break;
    case "error":
      setStatus(`<span class="err">${msg.code}: ${msg.message}</span>`);
      break;
    case "goodbye":
      setStatus(`<span class="err">server goodbye: ${msg.reason}</span>`);
      break;
    case "admin-ack":
      setStatus(`<span class="ok">${msg.command}: ${msg.message ?? "ok"}</span>`);
      // Drain any pending sendAdminAwait waiter for this command kind.
      {
        const waiters = pendingAdminAwaits.get(msg.command);
        if (waiters && waiters.length > 0) {
          const w = waiters.shift();
          if (w) w(msg);
        }
      }
      // update-client final ack lands as a terminal AdminAck (the
      // server sends progress AdminAcks while it's working, then this
      // one with the dist path). Reload to pull the fresh bundle.
      if (msg.command === "update-client" && pendingReload) {
        // Distinguish progress acks (no path) from the terminal one --
        // the terminal ack carries "rebuilt ..." in the message.
        if (msg.message && msg.message.startsWith("rebuilt ")) {
          pendingReload = false;
          setStatus(`<span class="ok">update-client: rebuilt; reloading…</span>`);
          // Give the operator a moment to see the message before reload.
          setTimeout(() => location.reload(), 500);
        }
      }
      break;
    case "admin-nack":
      setStatus(`<span class="err">${msg.command} rejected: ${msg.reason}</span>`);
      {
        const waiters = pendingAdminAwaits.get(msg.command);
        if (waiters && waiters.length > 0) {
          const w = waiters.shift();
          if (w) w(msg);
        }
      }
      break;
  }
}

function updateHeaderStatus(): void {
  if (!build) return;
  const adminTag = isAdmin ? `<span class="ok">admin</span>` : `<span class="dim">observer</span>`;
  setStatus(
    `<span class="ok">connected</span> — ` +
    `build <code>${build.commit}</code> v${build.version} | ${adminTag} | ` +
    `snaps/s <span id="sps">--</span>`
  );
}

/// Wrap a serialised f32 blob as a Float32Array view.
/// msgpack's bin payload can land at any byte offset inside the
/// frame buffer; Float32Array requires a 4-byte-aligned start
/// offset, so we copy when alignment isn't satisfied. The fast
/// path (already aligned) is a zero-copy view.
function f32(bytes: Uint8Array, n: number): Float32Array {
  if (bytes.byteOffset % 4 === 0) {
    return new Float32Array(bytes.buffer, bytes.byteOffset, n);
  }
  const aligned = new ArrayBuffer(n * 4);
  new Uint8Array(aligned).set(bytes.subarray(0, n * 4));
  return new Float32Array(aligned);
}

// --- View state. zoom is a multiplier on top of the aspect-fit
// scale; pan is a translation in canvas pixels added after centring.
// Together with the world's aspect-fit they form the affine transform
// the renderer + pointer handlers share.
let zoom = 1.0;
let panX = 0;
let panY = 0;
function resetView(): void {
  zoom = 1.0;
  panX = 0;
  panY = 0;
}

// --- Renderer transform cache. Populated each frame so click + touch
// handlers can convert pointer coords back into world coords without
// recomputing.
let lastScale = 1;
let lastOffX = 0;
let lastOffY = 0;

/// Convert a pointer event (in CSS px relative to the viewport) into
/// world coordinates (the same units the engine stores). Used by
/// click-to-select and the future zoom/pan implementation.
function pointerToWorld(ev: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const cx = (ev.clientX - rect.left) * dpr;
  const cy = (ev.clientY - rect.top) * dpr;
  return {
    x: (cx - lastOffX) / lastScale,
    y: (cy - lastOffY) / lastScale,
  };
}

// Pointer state for distinguishing tap (=cell select) from drag
// (=pan) and pinch (=zoom). Active pointers tracked by pointerId so
// touch + mouse + pencil all flow through the same handler.
const activePointers = new Map<number, { x: number; y: number }>();
let dragStart: { x: number; y: number; panX: number; panY: number } | null = null;
let pinchStartDist: number | null = null;
let pinchStartZoom: number | null = null;

function tapHitTest(ev: PointerEvent): void {
  if (!snapshot) return;
  const world = pointerToWorld(ev);
  const cBlobs: Record<string, NamedBlob> = {};
  for (const b of snapshot.creatures.blobs) cBlobs[b.name] = b;
  const cN = snapshot.creatures.count;
  if (cN === 0 || !cBlobs.x || !cBlobs.y || !cBlobs.r) return;
  const cx = f32(cBlobs.x.data, cN);
  const cy = f32(cBlobs.y.data, cN);
  const cr = f32(cBlobs.r.data, cN);
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < cN; i++) {
    const d = Math.hypot(cx[i] - world.x, cy[i] - world.y);
    if (d < Math.max(20, cr[i] * 3) && d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best >= 0) {
    selectedCell = { x: cx[best], y: cy[best], r: cr[best] };
  } else {
    selectedCell = null;
    inspectorPanel.style.display = "none";
  }
}

canvas.addEventListener("pointerdown", (ev) => {
  canvas.setPointerCapture(ev.pointerId);
  activePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (activePointers.size === 1) {
    dragStart = { x: ev.clientX, y: ev.clientY, panX, panY };
    pinchStartDist = null;
  } else if (activePointers.size === 2) {
    const pts = Array.from(activePointers.values());
    pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    pinchStartZoom = zoom;
    dragStart = null;
  }
});

canvas.addEventListener("pointermove", (ev) => {
  if (!activePointers.has(ev.pointerId)) return;
  activePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (activePointers.size === 1 && dragStart) {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    panX = dragStart.panX + (ev.clientX - dragStart.x) * dpr;
    panY = dragStart.panY + (ev.clientY - dragStart.y) * dpr;
  } else if (activePointers.size === 2 && pinchStartDist != null && pinchStartZoom != null) {
    const pts = Array.from(activePointers.values());
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (dist > 5) {
      const newZoom = clamp(pinchStartZoom * (dist / pinchStartDist), 0.25, 16);
      // Zoom around the midpoint between fingers so the world doesn't
      // slide out from under the touch.
      const cxM = (pts[0].x + pts[1].x) / 2;
      const cyM = (pts[0].y + pts[1].y) / 2;
      zoomAround(newZoom, cxM, cyM);
    }
  }
});

function endPointer(ev: PointerEvent): void {
  const down = activePointers.get(ev.pointerId);
  activePointers.delete(ev.pointerId);
  if (dragStart && down) {
    const dx = ev.clientX - dragStart.x;
    const dy = ev.clientY - dragStart.y;
    if (Math.hypot(dx, dy) < 6) {
      tapHitTest(ev);
    }
  }
  if (activePointers.size === 0) {
    dragStart = null;
    pinchStartDist = null;
    pinchStartZoom = null;
  }
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);

// Mouse wheel zoom centered on the cursor.
canvas.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  const factor = ev.deltaY > 0 ? 0.9 : 1.1;
  const newZoom = clamp(zoom * factor, 0.25, 16);
  zoomAround(newZoom, ev.clientX, ev.clientY);
}, { passive: false });

// Double-click resets zoom + pan.
canvas.addEventListener("dblclick", () => {
  resetView();
});

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/// Zoom such that the world point at the given client coords stays
/// under the pointer. The math: world_at_pointer is invariant, so
/// adjusting pan + scale together keeps it pinned.
function zoomAround(newZoom: number, clientX: number, clientY: number): void {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const cx = (clientX - rect.left) * dpr;
  const cy = (clientY - rect.top) * dpr;
  // World point currently under the pointer.
  const wx = (cx - lastOffX) / lastScale;
  const wy = (cy - lastOffY) / lastScale;
  zoom = newZoom;
  // Solve for pan so the same world point ends up under the pointer
  // after the new zoom takes effect on the next frame.
  if (snapshot) {
    const cwd = canvas.width, chd = canvas.height;
    const fitScale = Math.min(cwd / snapshot.width, chd / snapshot.height);
    const newScale = fitScale * zoom;
    const centeredOffX = (cwd - snapshot.width * newScale) / 2;
    const centeredOffY = (chd - snapshot.height * newScale) / 2;
    panX = cx - wx * newScale - centeredOffX;
    panY = cy - wy * newScale - centeredOffY;
  }
}

// --- Render loop.
// Canvas pixel size has to track clientWidth/Height * devicePixelRatio
// every time the layout shifts. The single `window.addEventListener
// ("resize", ...)` we used to have wasn't enough on mobile -- the
// canvas-wrap container can resize without firing window resize (header
// rows wrapping after orientation change, on-screen keyboard appearing,
// iOS Safari address-bar shrink/expand, etc.) leaving the canvas at 0x0
// pixels and the world rendered into nothing. ResizeObserver + a
// per-frame size check fix both cases.
function resize(): void {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  const targetW = Math.floor(w * dpr);
  const targetH = Math.floor(h * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
}
window.addEventListener("resize", resize);
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(resize).observe(canvas);
}
resize();

function renderAmbientPanel(stocks: number[]): void {
  if (stocks.length === 0 || !showAmbient) {
    ambientPanel.style.display = "none";
    return;
  }
  ambientPanel.style.display = "block";
  // Take top 10 chems by mass.
  const sorted = stocks
    .map((v, i) => ({ id: i, v }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 10);
  ambientList.innerHTML = "";
  for (const row of sorted) {
    if (row.v <= 0) continue;
    const li = document.createElement("li");
    li.style.padding = "1px 0";
    const name = chemNames[row.id] ?? `chem ${row.id}`;
    const color = chemColors[row.id] ?? "#9ee";
    li.innerHTML = `<span style="display:inline-block;width:8px;height:8px;background:${color};margin-right:4px;vertical-align:-1px"></span>${name}: ${row.v.toFixed(1)}`;
    ambientList.appendChild(li);
  }
}

function renderSpeciesPanel(top: SpeciesSummary[]): void {
  // Refresh pinned summaries from the current top-N so the pinned
  // list shows current counts when the species is still alive.
  if (snapshot) {
    for (const s of top) {
      if (pinnedSpecies.has(s.coding_key)) {
        pinnedSpecies.set(s.coding_key, { ...s, lastSeen: snapshot.t });
      }
    }
  }
  if ((top.length === 0 && pinnedSpecies.size === 0) || !showSpecies) {
    speciesPanel.style.display = "none";
    return;
  }
  speciesPanel.style.display = "block";
  speciesList.innerHTML = "";
  // Pinned first.
  const topKeys = new Set(top.map((s) => s.coding_key));
  for (const s of pinnedSpecies.values()) {
    if (topKeys.has(s.coding_key)) continue;
    const li = document.createElement("li");
    li.style.padding = "2px 0";
    li.style.opacity = "0.7";
    const ageS = snapshot ? Math.max(0, snapshot.t - s.lastSeen) : 0;
    li.innerHTML = `<span style="display:inline-block;width:10px;height:10px;background:${s.color};border:1px solid #333;margin-right:4px;vertical-align:-1px"></span><span class="dim">extinct (${ageS.toFixed(0)}s)</span> ${s.coding_key.slice(0, 12)} <button data-unpin="${s.coding_key}" style="background:transparent; border:1px solid #1a3340; color:#fc6; padding:0 4px; cursor:pointer; font:inherit;">★</button>`;
    speciesList.appendChild(li);
  }
  // Bind the unpin buttons.
  speciesList.querySelectorAll<HTMLButtonElement>("button[data-unpin]").forEach((btn) => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const key = btn.getAttribute("data-unpin");
      if (key) pinnedSpecies.delete(key);
      persistPinnedSpecies();
    };
  });
  for (const s of top) {
    const li = document.createElement("li");
    li.style.cursor = "pointer";
    li.style.padding = "2px 0";
    const biomass = s.biomass !== undefined ? ` <span class="dim">m=${s.biomass.toFixed(0)}</span>` : "";
    const atp = s.atp !== undefined ? ` <span class="dim">atp=${s.atp.toFixed(0)}</span>` : "";
    li.innerHTML = `<span style="display:inline-block;width:10px;height:10px;background:${s.color};border:1px solid #333;margin-right:4px;vertical-align:-1px"></span>${s.count}${biomass}${atp} <span class="dim" style="margin-left:4px;">${s.coding_key.slice(0, 16)}</span>`;
    if (s.coding_key === selectedSpeciesKey) {
      li.style.background = "#0d1c26";
    }
    li.onclick = () => {
      selectedSpeciesKey = s.coding_key;
      const parts: string[] = [];
      if (s.description) parts.push(s.description);
      const genome = s.genome;
      if (genome && genome.length > 0) {
        parts.push("");
        parts.push(disassemble(genome instanceof Uint8Array ? genome : new Uint8Array(genome)));
      }
      disasmEl.textContent = parts.length > 0 ? parts.join("\n") : "(no genome bytes)";
    };
    speciesList.appendChild(li);
  }
}

function frame(): void {
  if (!ctx) return;
  // Defensive: catch any size change the observer missed (e.g. iOS
  // Safari's first frame after the address-bar height changes).
  resize();
  if (canvas.width === 0 || canvas.height === 0) {
    requestAnimationFrame(frame);
    return;
  }
  // Crisp particles + cells over blurred ones for the small-radius
  // demo scale. Anti-aliasing on shapes happens automatically; this
  // line only affects scaled bitmap blits, but turning it off costs
  // nothing.
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#050b14";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (snapshot) {
    const cw = canvas.width, ch = canvas.height;
    const wW = snapshot.width, wH = snapshot.height;
    // Fit world into canvas preserving aspect, then layer the user's
    // zoom + pan on top.
    const fitScale = Math.min(cw / wW, ch / wH);
    const scale = fitScale * zoom;
    const offX = (cw - wW * scale) / 2 + panX;
    const offY = (ch - wH * scale) / 2 + panY;
    // Cache for the pointer handlers.
    lastScale = scale;
    lastOffX = offX;
    lastOffY = offY;
    const surfaceWorldY = snapshot.surface_y ?? (wH * 0.10);
    const surfaceCanvasY = offY + surfaceWorldY * scale;

    // Sky + water bands span the WHOLE canvas width (not just the
    // world rect), so the letterbox bars to the side read as sky
    // above the surface and water below it. Otherwise on portrait
    // phones the black letterbox dominates and the "air" portion
    // looks enormous even though it's only ~10% of the world. Day /
    // night light tweaks the sky much more than the water -- the
    // ocean stays dim regardless of time of day.
    const light = snapshot.ambient_light ?? 1.0;
    const skyR = Math.round(10 + 70 * light);
    const skyG = Math.round(20 + 90 * light);
    const skyB = Math.round(45 + 90 * light);
    const wR = Math.round(8 + 22 * light);
    const wG = Math.round(24 + 36 * light);
    const wB = Math.round(48 + 40 * light);
    ctx.fillStyle = `rgb(${skyR}, ${skyG}, ${skyB})`;
    ctx.fillRect(0, 0, cw, Math.max(0, surfaceCanvasY));
    ctx.fillStyle = `rgb(${wR}, ${wG}, ${wB})`;
    ctx.fillRect(0, Math.max(0, surfaceCanvasY), cw, ch - Math.max(0, surfaceCanvasY));

    // Static terrain. Each rock is drawn as a vertical gradient with
    // a darker base and a slightly-lit crown so the silhouette has
    // some depth even at small scales. Mineral-blue rim stroke gives
    // a visible edge in dim light. Drawn AFTER the water tint and
    // BEFORE particles + cells so cells visually sit in the open
    // water above rock.
    if (terrain.length > 0) {
      ctx.lineWidth = 1;
      for (const poly of terrain) {
        if (poly.length < 6) continue;
        // Build the path once + reuse for fill + stroke.
        ctx.beginPath();
        ctx.moveTo(offX + poly[0] * scale, offY + poly[1] * scale);
        let minY = poly[1], maxY = poly[1];
        for (let i = 2; i < poly.length; i += 2) {
          const px = offX + poly[i] * scale;
          const py = offY + poly[i + 1] * scale;
          ctx.lineTo(px, py);
          if (poly[i + 1] < minY) minY = poly[i + 1];
          if (poly[i + 1] > maxY) maxY = poly[i + 1];
        }
        ctx.closePath();
        // Vertical gradient: lighter at the top, darker at the
        // bottom. Light multiplies the highlight so daytime rocks
        // read warm and nighttime rocks read cool.
        const yTop = offY + minY * scale;
        const yBot = offY + maxY * scale;
        const grd = ctx.createLinearGradient(0, yTop, 0, yBot);
        const tR = Math.round(40 + 40 * light);
        const tG = Math.round(28 + 22 * light);
        const tB = Math.round(20 + 16 * light);
        grd.addColorStop(0, `rgb(${tR}, ${tG}, ${tB})`);
        grd.addColorStop(0.4, "#241612");
        grd.addColorStop(1, "#100805");
        ctx.fillStyle = grd;
        ctx.fill();
        ctx.strokeStyle = light > 0.05 ? "#4a382a" : "#234055";
        ctx.stroke();
      }
    }

    // Pull X/Y/R/chemId blobs.
    const blobs: Record<string, NamedBlob> = {};
    for (const b of snapshot.particles.blobs) blobs[b.name] = b;
    const n = snapshot.particles.count;
    const x = f32(blobs.x.data, n);
    const y = f32(blobs.y.data, n);
    const r = f32(blobs.r.data, n);
    const chemId = blobs.chemId.data;

    // Use the server's chem table (sent in Hello). Fall back to the
    // cheap chem-id -> hue mapping when an id is out of range or the
    // table hasn't arrived yet (race on first frame).
    for (let i = 0; i < n; i++) {
      const cid = chemId[i];
      ctx.fillStyle = chemColors[cid] ?? `hsl(${(cid * 33) % 360} 70% 60%)`;
      ctx.beginPath();
      ctx.arc(offX + x[i] * scale, offY + y[i] * scale, Math.max(1, r[i] * scale), 0, Math.PI * 2);
      ctx.fill();
    }

    // Overlay (optional). Drawn between particles + cells so cells
    // stay readable. Density = per-grid-cell particle count heatmap;
    // light = ambient_light read out as a single bar at the top of
    // the world rect; mass = canvas-corner text readout of the mass
    // ledger components.
    if (overlayMode === "density") {
      const GRID = 24;
      const cols = Math.max(1, Math.floor(wW / GRID));
      const rows = Math.max(1, Math.floor(wH / GRID));
      const counts = new Uint32Array(cols * rows);
      const px = f32(blobs.x.data, n);
      const py = f32(blobs.y.data, n);
      for (let i = 0; i < n; i++) {
        const gx = Math.min(cols - 1, Math.max(0, (px[i] / wW * cols) | 0));
        const gy = Math.min(rows - 1, Math.max(0, (py[i] / wH * rows) | 0));
        counts[gy * cols + gx]++;
      }
      let maxC = 1;
      for (const c of counts) if (c > maxC) maxC = c;
      const cellW = GRID * scale;
      const cellH = GRID * scale;
      for (let gy = 0; gy < rows; gy++) {
        for (let gx = 0; gx < cols; gx++) {
          const c = counts[gy * cols + gx];
          if (c === 0) continue;
          const a = 0.15 + 0.65 * (c / maxC);
          ctx.fillStyle = `rgba(120, 200, 255, ${a})`;
          ctx.fillRect(
            offX + gx * GRID * scale,
            offY + gy * GRID * scale,
            cellW + 1,
            cellH + 1,
          );
        }
      }
    } else if (overlayMode === "light") {
      const bar = Math.max(2, 6 * (window.devicePixelRatio || 1));
      ctx.fillStyle = `rgba(255, 230, 120, ${0.2 + 0.6 * light})`;
      ctx.fillRect(offX, offY, wW * scale * light, bar);
    }

    // Creatures: rendered after particles so cells sit visually on top
    // of the particle field. Color by species (from top_species[])
    // when available; fall back to a synthetic per-id hue for cells
    // outside the top-N. Heading shown as a short whisker.
    const cBlobs: Record<string, NamedBlob> = {};
    for (const b of snapshot.creatures.blobs) cBlobs[b.name] = b;
    const cN = snapshot.creatures.count;

    // Draw bonds first so cells overlay the line endpoints.
    if (snapshot.bonds && snapshot.bonds.length > 0 && cBlobs.x && cBlobs.y) {
      const cx = f32(cBlobs.x.data, cN);
      const cy = f32(cBlobs.y.data, cN);
      ctx.strokeStyle = "#79f";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let k = 0; k < snapshot.bonds.length; k += 2) {
        const i = snapshot.bonds[k];
        const j = snapshot.bonds[k + 1];
        if (i >= cN || j >= cN) continue;
        ctx.moveTo(offX + cx[i] * scale, offY + cy[i] * scale);
        ctx.lineTo(offX + cx[j] * scale, offY + cy[j] * scale);
      }
      ctx.stroke();
    }
    if (cN > 0 && cBlobs.x && cBlobs.y && cBlobs.r) {
      const cx = f32(cBlobs.x.data, cN);
      const cy = f32(cBlobs.y.data, cN);
      const cr = f32(cBlobs.r.data, cN);
      const heading = cBlobs.heading ? f32(cBlobs.heading.data, cN) : null;
      const mass = cBlobs.mass ? f32(cBlobs.mass.data, cN) : null;
      const energy = cBlobs.energy ? f32(cBlobs.energy.data, cN) : null;
      const speciesIdx = cBlobs.speciesIdx ? cBlobs.speciesIdx.data : null;
      const topSpecies = snapshot.top_species ?? [];
      // Re-resolve the cell-selection memo. If the selected cell is
      // still alive (closest cell within SELECT_FOLLOW_R px of the
      // remembered position), follow it; otherwise drop the selection
      // so the inspector closes itself.
      let selectedIdx = -1;
      if (selectedCell) {
        let bestD = Infinity;
        for (let i = 0; i < cN; i++) {
          const d = Math.hypot(cx[i] - selectedCell.x, cy[i] - selectedCell.y);
          if (d < SELECT_FOLLOW_R && d < bestD) {
            bestD = d;
            selectedIdx = i;
          }
        }
        if (selectedIdx >= 0) {
          selectedCell = { x: cx[selectedIdx], y: cy[selectedIdx], r: cr[selectedIdx] };
          // Follow: lerp the pan so the cell stays near the canvas
          // center. Smooth rather than snap so the user can still
          // pinch + drag without fighting the camera.
          if (followSelectedCell) {
            const targetPanX = cw / 2 - (cx[selectedIdx] * scale + (cw - wW * scale) / 2);
            const targetPanY = ch / 2 - (cy[selectedIdx] * scale + (ch - wH * scale) / 2);
            const lerp = 0.12;
            panX += (targetPanX - panX) * lerp;
            panY += (targetPanY - panY) * lerp;
          }
        } else {
          selectedCell = null;
          followSelectedCell = false;
        }
      }
      for (let i = 0; i < cN; i++) {
        const px = offX + cx[i] * scale;
        const py = offY + cy[i] * scale;
        const pr = Math.max(2, cr[i] * scale);
        let color = "hsl(140 65% 55%)";
        if (speciesIdx) {
          const sid = speciesIdx[i];
          if (sid !== 0xFF && topSpecies[sid]) {
            color = topSpecies[sid].color;
          } else {
            color = `hsl(${(sid * 47) % 360} 50% 45%)`;
          }
        }
        ctx.fillStyle = color;
        ctx.strokeStyle = "#cfe";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(px, py, pr, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (heading) {
          const a = heading[i];
          const wx = px + Math.cos(a) * (pr + 4);
          const wy = py + Math.sin(a) * (pr + 4);
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(wx, wy);
          ctx.strokeStyle = "#9ee";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      // Selection ring on top of all cells, pulsing slightly so it's
      // visible against any species color.
      if (selectedIdx >= 0) {
        const i = selectedIdx;
        const px = offX + cx[i] * scale;
        const py = offY + cy[i] * scale;
        const pr = Math.max(2, cr[i] * scale);
        const pulse = 0.7 + 0.3 * Math.sin(performance.now() / 250);
        ctx.beginPath();
        ctx.arc(px, py, pr + 4, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 240, 140, ${pulse})`;
        ctx.lineWidth = 2;
        ctx.stroke();
        // Inspector body. Built from the snapshot fields available
        // (mass, energy, heading, species) plus the species genome /
        // description when the cell sits inside the top-N row table.
        const sidVal = speciesIdx ? speciesIdx[i] : 0xFF;
        const sp = sidVal !== 0xFF ? topSpecies[sidVal] : undefined;
        const parts: string[] = [];
        parts.push(`<div><span class="dim">pos</span> ${cx[i].toFixed(0)}, ${cy[i].toFixed(0)} <span class="dim">r</span> ${cr[i].toFixed(1)}</div>`);
        if (mass) parts.push(`<div><span class="dim">mass</span> ${mass[i].toFixed(0)}</div>`);
        if (energy) parts.push(`<div><span class="dim">atp</span> ${energy[i].toFixed(0)}</div>`);
        if (heading) parts.push(`<div><span class="dim">heading</span> ${(heading[i] * 180 / Math.PI).toFixed(0)}°</div>`);
        const followClass = followSelectedCell ? "ok" : "dim";
        parts.push(`<div style="display:flex; gap:6px; margin-top:6px;">
          <button id="insp-follow" style="background:#07111a; border:1px solid #1a3340; color:#9ee; padding:2px 8px; cursor:pointer; font:inherit;" class="${followClass}">${followSelectedCell ? "✓ Follow" : "Follow"}</button>
          ${isAdmin ? `<button id="insp-kill" title="Admin: mark this cell unviable" style="background:#1a0a0a; border:1px solid #4a1818; color:#f99; padding:2px 8px; cursor:pointer; font:inherit;">Kill</button>` : ""}
        </div>`);
        if (sp) {
          const pinned = pinnedSpecies.has(sp.coding_key);
          parts.push(`<div style="margin-top:6px;"><span style="display:inline-block;width:10px;height:10px;background:${sp.color};border:1px solid #333;margin-right:4px;vertical-align:-1px"></span>species <span class="dim">${sp.coding_key.slice(0, 12)}</span> · count <b>${sp.count}</b> <button id="insp-pin" style="background:transparent; border:1px solid #1a3340; color:${pinned ? "#fc6" : "#9ee"}; padding:0 6px; cursor:pointer; font:inherit; margin-left:4px;">${pinned ? "★ pinned" : "☆ pin"}</button></div>`);
          if (sp.description) {
            parts.push(`<div style="margin-top:4px; white-space:pre-wrap;">${sp.description}</div>`);
          }
          if (sp.genome && sp.genome.length > 0) {
            const genome = sp.genome instanceof Uint8Array ? sp.genome : new Uint8Array(sp.genome);
            parts.push(`<details style="margin-top:6px;"><summary>genome disasm</summary><pre style="white-space:pre; margin:4px 0 0; max-height:30vh; overflow:auto;">${disassemble(genome)}</pre></details>`);
          }
        } else if (sidVal !== 0xFF) {
          parts.push(`<div class="dim" style="margin-top:6px;">species idx ${sidVal} -- outside top-N roster</div>`);
        }
        inspectorBody.innerHTML = parts.join("");
        inspectorPanel.style.display = "block";
        // Re-bind the per-frame buttons since innerHTML rebuilds them.
        const followBtn = document.getElementById("insp-follow") as HTMLButtonElement | null;
        if (followBtn) {
          followBtn.onclick = () => {
            followSelectedCell = !followSelectedCell;
          };
        }
        const killBtn = document.getElementById("insp-kill") as HTMLButtonElement | null;
        if (killBtn && selectedCell) {
          const targetX = selectedCell.x;
          const targetY = selectedCell.y;
          killBtn.onclick = () => {
            send({ type: "admin", command: { kind: "kill-cell", x: targetX, y: targetY } });
          };
        }
        const pinBtn = document.getElementById("insp-pin") as HTMLButtonElement | null;
        if (pinBtn && sp) {
          pinBtn.onclick = () => {
            if (pinnedSpecies.has(sp.coding_key)) {
              pinnedSpecies.delete(sp.coding_key);
            } else {
              pinnedSpecies.set(sp.coding_key, { ...sp, lastSeen: snapshot ? snapshot.t : 0 });
            }
            persistPinnedSpecies();
          };
        }
      } else if (!selectedCell) {
        inspectorPanel.style.display = "none";
      }
    }

    // Perf overlay: per-pass mean ms, sorted descending. Reads
    // snapshot.perf which the server ships every snapshot.
    if (overlayMode === "perf" && (snapshot as any).perf) {
      const p = (snapshot as any).perf as Record<string, number>;
      const passes: Array<[string, number]> = [];
      for (const [k, v] of Object.entries(p)) {
        if (typeof v === "number" && k.endsWith("_ms")) {
          passes.push([k.replace(/_ms$/, ""), v]);
        }
      }
      passes.sort((a, b) => b[1] - a[1]);
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const fs = Math.round(11 * dpr);
      ctx.font = `${fs}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      const lh = fs + 4;
      const top = passes.slice(0, 10);
      const rows: string[] = [
        `tick     ${(p.tick_ms ?? 0).toFixed(2)} ms`,
        `particles ${(p.particle_count ?? 0).toString().padStart(5)}`,
        "",
      ];
      for (const [name, ms] of top) {
        if (ms <= 0.0001) continue;
        rows.push(`${name.padEnd(18)} ${ms.toFixed(3)} ms`);
      }
      const pad = 8 * dpr;
      const w = 30 * fs * 0.6;
      ctx.fillStyle = "rgba(2, 8, 14, 0.7)";
      ctx.fillRect(pad - 4, ch - rows.length * lh - pad - 4, w, rows.length * lh + 8);
      ctx.fillStyle = "rgba(204, 224, 240, 0.95)";
      ctx.textBaseline = "top";
      for (let i = 0; i < rows.length; i++) {
        ctx.fillText(rows[i], pad, ch - (rows.length - i) * lh - pad);
      }
    }

    // History overlay: stacked sparklines of population, species,
    // and total mass across the rolling POP_HISTORY buffer (~120 s
    // at 30 Hz). Drawn as a translucent strip across the bottom of
    // the canvas so the trajectory is always one glance away.
    if (overlayMode === "history" && POP_HISTORY.length > 1) {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const pad = 8 * dpr;
      const stripH = Math.round(140 * dpr);
      const stripW = cw - 2 * pad;
      const x0 = pad;
      const y0 = ch - stripH - pad;
      ctx.fillStyle = "rgba(2, 8, 14, 0.7)";
      ctx.fillRect(x0 - 4, y0 - 4, stripW + 8, stripH + 8);
      const rowH = stripH / 3;
      const samples = POP_HISTORY;
      const n = samples.length;
      let maxCells = 1, maxSpecies = 1, maxMass = 1;
      for (const s of samples) {
        if (s.cells > maxCells) maxCells = s.cells;
        if (s.species > maxSpecies) maxSpecies = s.species;
        if (s.mass > maxMass) maxMass = s.mass;
      }
      const drawSpark = (
        key: "cells" | "species" | "mass",
        max: number,
        color: string,
        rowIdx: number,
        label: string,
      ) => {
        const rowY = y0 + rowIdx * rowH;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const xv = x0 + (i / (n - 1)) * stripW;
          const v = samples[i][key];
          const yv = rowY + rowH - 4 - (v / max) * (rowH - 8);
          if (i === 0) ctx.moveTo(xv, yv); else ctx.lineTo(xv, yv);
        }
        ctx.stroke();
        const fs = Math.round(10 * dpr);
        ctx.font = `${fs}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.fillStyle = "rgba(204, 224, 240, 0.85)";
        ctx.textBaseline = "top";
        const last = samples[n - 1][key];
        ctx.fillText(`${label} ${last.toFixed(0)} (peak ${max.toFixed(0)})`, x0 + 4, rowY + 2);
      };
      drawSpark("cells", maxCells, "#9efba8", 0, "cells");
      drawSpark("species", maxSpecies, "#9ee", 1, "species");
      drawSpark("mass", maxMass, "#fc6", 2, "mass");
    }

    // Mass overlay: render the snapshot.mass ledger as bottom-left
    // canvas text. Cheap, doesn't disturb world rendering.
    if (overlayMode === "mass" && snapshot.mass) {
      const m = snapshot.mass;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const fs = Math.round(11 * dpr);
      ctx.font = `${fs}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.fillStyle = "rgba(204, 224, 240, 0.95)";
      ctx.textBaseline = "top";
      const rows = [
        `mass total       ${m.total.toFixed(0)}`,
        `cell chems       ${m.cell_chems.toFixed(0)}`,
        `cell catalysts   ${m.cell_catalysts.toFixed(0)}`,
        `particles        ${m.particles.toFixed(0)}`,
        `ambient          ${m.ambient.toFixed(0)}`,
      ];
      const pad = 8 * dpr;
      const lh = fs + 4;
      ctx.fillStyle = "rgba(2, 8, 14, 0.7)";
      ctx.fillRect(pad - 4, ch - rows.length * lh - pad - 4, 32 * fs * 0.65, rows.length * lh + 8);
      ctx.fillStyle = "rgba(204, 224, 240, 0.95)";
      for (let i = 0; i < rows.length; i++) {
        ctx.fillText(rows[i], pad, ch - (rows.length - i) * lh - pad);
      }
    }

    // Sun / moon, animated. Arc traces left -> right -> left across
    // the sky as the day phase advances. The TS client did the same;
    // the previous Rust port reduced this to a static corner badge,
    // so a user looking at the page rarely caught the moment of
    // sunrise. The position function lives separately for unit-
    // testability (see sunMoonPos below).
    const pmoon = sunMoonPos(snapshot.t, snapshot.day_period_s ?? 300, cw, surfaceCanvasY);
    if (pmoon) {
      const { x: sx, y: sy, isDay } = pmoon;
      ctx.beginPath();
      ctx.arc(sx, sy, 14, 0, Math.PI * 2);
      ctx.fillStyle = isDay
        ? `rgba(255, ${200 + Math.round(50 * light)}, 80, ${0.5 + 0.5 * light})`
        : `rgba(220, 230, 250, 0.85)`;
      ctx.fill();
      ctx.strokeStyle = isDay ? "#fc6" : "#cdf";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (!isDay) {
        // Crater shadow gives the moon a recognisable shape.
        ctx.beginPath();
        ctx.arc(sx + 4, sy - 2, 11, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(2, 12, 18, 0.35)";
        ctx.fill();
      }
    }

    // Overlay world bbox.
    ctx.strokeStyle = "#1a3340";
    ctx.lineWidth = 1;
    ctx.strokeRect(offX, offY, wW * scale, wH * scale);

    // FPS / tick / lag readouts.
    const sps = snapsPerSec.toFixed(1);
    const el = document.getElementById("sps");
    void lastSnapshotAt;
    const species = (snapshot as { species_count?: number }).species_count ?? 0;
    const deaths = (snapshot as { deaths_this_window?: number }).deaths_this_window ?? 0;
    const massStr = snapshot.mass ? ` mass=${snapshot.mass.total.toFixed(0)}` : "";
    if (el) el.textContent = `${sps} (tick ${snapshot.tick}, particles=${n}, creatures=${cN}, species=${species}, deaths/window=${deaths}${massStr})`;
    renderSpeciesPanel(snapshot.top_species ?? []);
    renderAmbientPanel(snapshot.ambient_chems ?? []);
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
