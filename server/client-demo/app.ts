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
  | { type: "snapshot"; tick: number; t: number; width: number; height: number;
      particles: Soa; creatures: Soa;
      force_source: "gpu" | "cpu" | "serial";
      cpu_pool_workers: number; gpu_last_ms: number;
      surface_y?: number; sim_rate?: number; running?: boolean; auto_reseeds?: number }
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
const speciesPanel = document.getElementById("species-panel") as HTMLElement;
const speciesList = document.getElementById("species-list") as HTMLOListElement;
const disasmEl = document.getElementById("disasm") as HTMLElement;
const ambientPanel = document.getElementById("ambient-panel") as HTMLElement;
const ambientList = document.getElementById("ambient-list") as HTMLOListElement;
let selectedSpeciesKey: string | null = null;
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
    resetBtn.disabled = true;
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
      resetBtn.disabled = !isAdmin;
      updateServerBtn.disabled = !isAdmin;
      updateClientBtn.disabled = !isAdmin;
      updateHeaderStatus();
      break;
    case "snapshot":
      snapshot = msg;
      const now = performance.now();
      lastSnapshotAt = now;
      snapAccum++;
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
  if (top.length === 0 || !showSpecies) {
    speciesPanel.style.display = "none";
    return;
  }
  speciesPanel.style.display = "block";
  speciesList.innerHTML = "";
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
  ctx.fillStyle = "#050b14";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (snapshot) {
    const cw = canvas.width, ch = canvas.height;
    const wW = snapshot.width, wH = snapshot.height;
    // Fit world into canvas preserving aspect.
    const scale = Math.min(cw / wW, ch / wH);
    const offX = (cw - wW * scale) / 2;
    const offY = (ch - wH * scale) / 2;
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

    // Static terrain: fill each rock polygon with a dark rust tone so
    // the water/rock distinction is visible. Stroke too so thin
    // outcroppings still read at small scales. Drawn AFTER the
    // water tint and BEFORE particles + cells so cells visually sit
    // in the open water above rock.
    if (terrain.length > 0) {
      ctx.fillStyle = "#2a1810";
      ctx.strokeStyle = "#3a261a";
      ctx.lineWidth = 1;
      for (const poly of terrain) {
        if (poly.length < 6) continue;
        ctx.beginPath();
        ctx.moveTo(offX + poly[0] * scale, offY + poly[1] * scale);
        for (let i = 2; i < poly.length; i += 2) {
          ctx.lineTo(offX + poly[i] * scale, offY + poly[i + 1] * scale);
        }
        ctx.closePath();
        ctx.fill();
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
      const speciesIdx = cBlobs.speciesIdx ? cBlobs.speciesIdx.data : null;
      const topSpecies = snapshot.top_species ?? [];
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
