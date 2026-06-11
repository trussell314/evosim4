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
interface SpeciesSummary { coding_key: string; count: number; color: string; genome?: Uint8Array; description?: string; }
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
  particles: Soa; creatures: Soa;
  force_source: "gpu" | "cpu" | "serial";
  cpu_pool_workers: number;
  gpu_last_ms: number;
  species_count?: number;
  deaths_this_window?: number;
  day_period_s?: number;
  ambient_light?: number;
  top_species?: SpeciesSummary[];
}
type ServerMessage =
  | { type: "hello"; protocol: number; build: BuildInfo; capabilities: ServerCaps;
      chem_colors: string[]; chem_names: string[] }
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
const speedSlider = document.getElementById("speed") as HTMLInputElement;
const speedReadout = document.getElementById("speedReadout") as HTMLSpanElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const resetBtn = document.getElementById("reset") as HTMLButtonElement;
const speciesPanel = document.getElementById("species-panel") as HTMLElement;
const speciesList = document.getElementById("species-list") as HTMLOListElement;
const disasmEl = document.getElementById("disasm") as HTMLElement;
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
speedSlider.oninput = () => {
  const rate = parseFloat(speedSlider.value);
  speedReadout.textContent = rate + "x";
  send({ type: "set-sim-rate", rate });
};
saveBtn.onclick = () => {
  const name = prompt("Save name (alphanumeric, leave blank for auto):", "");
  send({ type: "save", name: name && name.trim() ? name.trim() : null });
};
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
    speedSlider.disabled = true;
    saveBtn.disabled = true;
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
      chemColors = msg.chem_colors;
      pauseBtn.disabled = false;
      resumeBtn.disabled = false;
      speedSlider.disabled = false;
      saveBtn.disabled = !isAdmin;
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

function renderSpeciesPanel(top: SpeciesSummary[]): void {
  if (top.length === 0) {
    speciesPanel.style.display = "none";
    return;
  }
  speciesPanel.style.display = "block";
  speciesList.innerHTML = "";
  for (const s of top) {
    const li = document.createElement("li");
    li.style.cursor = "pointer";
    li.style.padding = "2px 0";
    li.innerHTML = `<span style="display:inline-block;width:10px;height:10px;background:${s.color};border:1px solid #333;margin-right:4px;vertical-align:-1px"></span>${s.count} <span class="dim" style="margin-left:4px;">${s.coding_key.slice(0, 24)}</span>`;
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
    if (el) el.textContent = `${sps} (tick ${snapshot.tick}, particles=${n}, creatures=${cN}, species=${species}, deaths/window=${deaths})`;
    renderSpeciesPanel(snapshot.top_species ?? []);
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
