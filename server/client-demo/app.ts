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
interface Snapshot {
  tick: number; t: number; width: number; height: number;
  particles: Soa; creatures: Soa;
  force_source: "gpu" | "cpu" | "serial";
  cpu_pool_workers: number;
  gpu_last_ms: number;
}
type ServerMessage =
  | { type: "hello"; protocol: number; build: BuildInfo; capabilities: ServerCaps }
  | { type: "snapshot"; tick: number; t: number; width: number; height: number;
      particles: Soa; creatures: Soa;
      force_source: "gpu" | "cpu" | "serial";
      cpu_pool_workers: number; gpu_last_ms: number }
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
const resetBtn = document.getElementById("reset") as HTMLButtonElement;
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

// Save the URL + token in localStorage so a reload doesn't re-type.
{
  const savedUrl = localStorage.getItem("evosim:url");
  if (savedUrl) urlInput.value = savedUrl;
  const savedTok = localStorage.getItem("evosim:token");
  if (savedTok) tokenInput.value = savedTok;
}

connectBtn.onclick = () => {
  localStorage.setItem("evosim:url", urlInput.value);
  localStorage.setItem("evosim:token", tokenInput.value);
  connect(urlInput.value, tokenInput.value || null);
};
disconnectBtn.onclick = () => {
  ws?.close();
};
pauseBtn.onclick = () => send({ type: "set-running", running: false });
resumeBtn.onclick = () => send({ type: "set-running", running: true });
resetBtn.onclick = () => send({ type: "admin", command: { kind: "reset" } });

function setStatus(html: string): void {
  statusEl.innerHTML = html;
}

function connect(url: string, token: string | null): void {
  setStatus(`<span class="dim">connecting to ${url}…</span>`);
  connectBtn.disabled = true;
  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
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
    resetBtn.disabled = true;
    snapshot = null;
    ws = null;
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
      pauseBtn.disabled = false;
      resumeBtn.disabled = false;
      resetBtn.disabled = !isAdmin;
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
      break;
    case "error":
      setStatus(`<span class="err">${msg.code}: ${msg.message}</span>`);
      break;
    case "goodbye":
      setStatus(`<span class="err">server goodbye: ${msg.reason}</span>`);
      break;
    case "admin-ack":
      setStatus(`<span class="ok">${msg.command}: ${msg.message ?? "ok"}</span>`);
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

// --- Render loop
function resize(): void {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
}
window.addEventListener("resize", resize);
resize();

function frame(): void {
  if (!ctx) return;
  ctx.fillStyle = "#050b14";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (snapshot) {
    const cw = canvas.width, ch = canvas.height;
    const wW = snapshot.width, wH = snapshot.height;
    // Fit world into canvas preserving aspect.
    const scale = Math.min(cw / wW, ch / wH);
    const offX = (cw - wW * scale) / 2;
    const offY = (ch - wH * scale) / 2;

    // Pull X/Y/R/chemId blobs.
    const blobs: Record<string, NamedBlob> = {};
    for (const b of snapshot.particles.blobs) blobs[b.name] = b;
    const n = snapshot.particles.count;
    const x = f32(blobs.x.data, n);
    const y = f32(blobs.y.data, n);
    const r = f32(blobs.r.data, n);
    const chemId = blobs.chemId.data;

    // Cheap chem-id -> hue mapping. Until the chemistry color table
    // crosses the wire we just bucket by id; gives some visible
    // separation without lying about specific chems.
    for (let i = 0; i < n; i++) {
      const hue = (chemId[i] * 33) % 360;
      ctx.fillStyle = `hsl(${hue} 70% 60%)`;
      ctx.beginPath();
      ctx.arc(offX + x[i] * scale, offY + y[i] * scale, Math.max(1, r[i] * scale), 0, Math.PI * 2);
      ctx.fill();
    }

    // Overlay world bbox.
    ctx.strokeStyle = "#1a3340";
    ctx.lineWidth = 1;
    ctx.strokeRect(offX, offY, wW * scale, wH * scale);

    // FPS / tick / lag readouts.
    const sps = snapsPerSec.toFixed(1);
    const lag = ((performance.now() - lastSnapshotAt) | 0).toString();
    const el = document.getElementById("sps");
    if (el) el.textContent = `${sps} (last ${lag}ms ago, tick ${snapshot.tick})`;
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
