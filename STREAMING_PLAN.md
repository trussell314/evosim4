# Streaming server plan — headless sim + thin streaming client

Goal: move the simulation off the viewing device. Run the sim **headless on a
server** (a Mac mini), and turn the browser into a **thin streaming viewer**
that just draws frames it receives. The phone (or any client) does no
chemistry/collision/VM work, so it stops draining battery. The view is
**publicly accessible with no login (read-only)**; **control stays private**.

This is purely an architecture/transport change — **no simulation logic
changes**. Determinism, mass conservation, the golden test, etc. are untouched.

---

## 1. What we build on (current architecture)

The seam already exists:

- **The sim runs in a Web Worker** (`src/sim.worker.ts`); `src/main.ts` consumes
  per-frame **snapshots** over `postMessage` (`takeSnapshot` →
  `CreatureSnapshot` / `InnerCreatureSnapshot` / `SpeciesSnapshot`). The renderer
  never touches sim internals — it draws from a snapshot.
- **`scripts/headless.ts`** is already a server-side `step(world, dt)` loop with
  no DOM.
- **`vite build` → `dist/`** is the static client bundle.

So "stream the sim from a server" = **replace the local worker with a remote
one**: run `step()` on the server, push snapshots over WebSocket instead of
`postMessage`, and have the client draw them with the existing render code.

---

## 2. Target architecture

```
  Mac mini (private)                          Internet            Clients
  ┌─────────────────────────────┐                               ┌──────────────┐
  │ sim server (Node)           │   cloudflared (outbound) ───► │ phone/laptop │
  │  • step() loop @ fixed dt   │   Cloudflare edge (TLS,       │  thin viewer │
  │  • WS broadcast (snapshots) │   DDoS, rate-limit) ────────► │  (draws only)│
  │  • static serve (dist/)     │                               └──────────────┘
  │  • control channel (token)  │ ◄── private: LAN / Tailscale / token only
  └─────────────────────────────┘
```

**Server (Node, on the Mac mini):**
- **Sim loop:** `step(world, dt)` at a fixed cadence. Decouple sim rate from
  stream rate (sim can run faster or "as fast as CPU allows"; stream throttled).
- **WS broadcast (PUBLIC, read-only, one-directional):** every N ticks emit a
  compact binary **render snapshot** to all connected viewers. Viewers cannot
  send anything the server acts on.
- **Control channel (PRIVATE):** command messages (overlay, founder cap,
  seeding, spawn, pause, save, …) accepted **only with a valid token**. Reject
  unauthenticated commands. Ideally bind this so it's reachable only over
  LAN/Tailscale/localhost and is NOT published on the public tunnel.
- **Static serve:** serve `dist/` (the client bundle). One process can do HTTP +
  WS-upgrade + static.

**Client (browser):**
- New **"remote" mode**: connect to the WS, receive snapshots, draw with the
  existing renderer; do **not** instantiate the local sim worker.
- **View-only public build/flag:** no control UI rendered. A separate
  authenticated control surface (token in hand) is the only thing that emits
  commands.
- Static terrain/HUD-scale data received once on connect; per-frame entity data
  streamed.

**Transport (Cloudflare Tunnel):** `cloudflared` makes an **outbound-only**
tunnel from the Mac mini to Cloudflare and maps a public hostname →
`http://127.0.0.1:PORT`. No router ports opened. TLS (so WSS) is automatic.
**Cloudflare Access is intentionally NOT used** (public, no login) — safety
comes from the read-only/control split below, plus Cloudflare rate-limiting.

---

## 3. Security model (why public + no-auth is OK here)

The transport tunnel secures the wire; the application split keeps a stranger
from doing harm:

- **PUBLIC, no auth = the spectator stream only.** Server → client snapshots,
  strictly one-directional. It's just positions/colors — read-only pixels.
  Nothing a viewer can send is acted on. Safe to expose to anyone.
- **PRIVATE = the control plane.** Every command requires the shared token (or
  arrives on a channel the public tunnel doesn't expose). The world stays
  single-owner (you control; everyone watches).
- **Belt-and-suspenders:** the public client build has **no control UI at all**,
  and the server **drops any inbound message lacking the token**.

Operational must-dos regardless of tunnel:
- **Bind `127.0.0.1`** (not `0.0.0.0`); the tunnel reaches it locally.
- **Cap concurrent connections.** One sim broadcasting to N viewers is cheap
  (same frames to all), but bound the socket count; let Cloudflare absorb floods.
- **Cloudflare:** enable a **rate-limiting rule** + optional bot/WAF (no login
  required). You still get TLS + DDoS mitigation for free.
- **Stream the render snapshot, not the save.** Never serve the full genome
  export (MBs) over the public path.
- Run the Node process as a **non-admin user**; keep macOS + Node patched;
  process manager auto-restarts it.

---

## 4. Render-snapshot protocol (keep it cheap)

Do **not** ship the 4.8 MB save. Send a minimal, binary, render-only payload.

**Sent once (on connect / on change):**
- world dims, `surfaceY`, day-cycle params
- terrain/obstacles (polygons) — static after generation

**Per frame (binary, typed arrays):**
- **cells:** `Float32 [x, y, r]` + packed color (RGB or palette index) + flag
  byte (host / bonded / etc.) per cell
- **particles:** `Float32 [x, y]` (+ `r` or fixed) + color/chemId per particle
- **scalars/HUD:** `dayPhase`, pop, parts, species counts, ms/tick, etc.
- **overlay field:** only when a viewer requests one — a coarse grid of values

**Bandwidth controls:**
- Stream at **15–30 fps** even if the sim runs faster (throttle the broadcast).
- Prefer **binary** over JSON; consider **delta frames** between keyframes.
- Later: **viewport culling** — client sends its view rect; server sends only
  visible entities. (Big win once entity counts grow.)

At current scales (~hundreds of cells, ~1000 particles) a full binary frame is
tens of KB — trivial bandwidth at 20 fps.

---

## 5. Implementation phases

**Phase 1 — server WS stream.** Extend `scripts/headless.ts` (or a new
`scripts/server.ts`) into a server: `step()` loop + a `ws` WebSocket server that
broadcasts the render snapshot + serves `dist/`. Validate **locally** by
pointing the *current* in-browser renderer at `ws://localhost:PORT` — proves the
protocol + bandwidth before any deployment.

**Phase 2 — thin client.** Add a "remote" mode to `main.ts`: consume the WS
snapshot feed instead of the local sim worker; gate it behind a flag/URL param.
Add the **view-only** vs **control** distinction (hide control UI in view-only;
control commands go out on the token-gated channel).

**Phase 3 — deploy + tunnel.** `npm run build` → `dist/`; run the server under
**launchd** (native, survives reboot) or **pm2**; set up the **cloudflared named
tunnel** + domain; add a Cloudflare rate-limit rule; verify public read-only
access from the phone and private control from your authenticated client.

Suggested order keeps each step shippable and low-risk; Phase 1 can run on the
LAN before anything is exposed.

---

## 6. Deployment runbook (Mac mini)

Prereqs: Node, this repo, `npm run build` (→ `dist/`), `cloudflared`
(`brew install cloudflared`), and a domain on Cloudflare (free plan).

**Run the server**
- Start the server entry (e.g. `node`/`tsx scripts/server.ts`), binding
  `127.0.0.1:PORT`.
- Keep it alive with a **launchd** plist (auto-start on boot + restart on crash)
  or `pm2 start … && pm2 startup && pm2 save`.

**Cloudflare named tunnel** (standard flow — check current `cloudflared` docs for
exact syntax):
1. `cloudflared tunnel login`
2. `cloudflared tunnel create evosim`
3. config (`~/.cloudflared/config.yml`): ingress rule mapping
   `evosim.<yourdomain>` → `http://127.0.0.1:PORT` (WebSockets pass through).
4. `cloudflared tunnel route dns evosim evosim.<yourdomain>`
5. `cloudflared tunnel run evosim` — also under launchd so it persists.
6. **Do NOT add Cloudflare Access** (public). Add a **rate-limiting rule** in the
   Cloudflare dashboard instead, and optionally bot/WAF rules.

**Verify**
- Public URL on the phone → read-only view, no login, no control UI.
- Control only from your authenticated/LAN client (token), or via Tailscale.

---

## 7. Open decisions

- **Snapshot encoding:** binary typed-arrays vs JSON; full frames vs deltas.
- **Sim-rate vs stream-rate** decoupling (target stream fps; sim cadence).
- **Control auth:** shared token in the WS first-message/header; how to rotate;
  whether control is token-gated-on-public vs LAN/Tailscale-only.
- **View-only vs control:** separate client builds, or one build with a runtime
  flag + token.
- **Multi-viewer scaling:** broadcast to all; cap N; optional per-viewer overlay
  requests vs a single shared overlay.
- **Reconnect/resume:** client re-handshakes (re-fetch static terrain) on drop.

---

## 8. Non-goals (for now)

- Server-side pixel/video encoding (WebRTC/MJPEG). Heavier infra; only revisit if
  snapshot bandwidth becomes a problem (it shouldn't at these scales).
- Public **control** (shared sandbox). If ever wanted, gate expensive/destructive
  commands and rate-limit hard — start view-only.
- Multi-world / multi-tenant hosting. Single shared world, broadcast to viewers.
