# Streaming server plan — headless sim + thin streaming client

Goal: move the simulation off the viewing device. Run the sim **headless on a
server** (a Mac mini), and turn the browser into a **thin streaming viewer**
that just draws frames it receives. The phone (or any client) does no
chemistry/collision/VM work, so it stops draining battery.

**Access model (this iteration).** Single operator (you), watching from
multiple devices. Anyone with the URL + token can connect AND control —
there is no view-only/control split. Concurrent-connection cap of 5 keeps
the surface bounded. A static query-string token (`?token=...`) checked at
WS upgrade is the only gate; you can rotate it via env var.

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
- **Command surface already exists.** `src/sim.worker.ts` handles ~20 message
  types (`killCell`, `cullNow`, `setAutoCull`, `setFoundersEnabled`,
  `setSeeding`, `setFounderTarget`, `setFounderCapEnabled`, `setMutationRate`,
  `setGeologySeed`, `setDensityChem`, `spawnSpecies`, `spawnComposite`,
  `setParticleCap`, `setParallelMin`, `setTurbo`, `setPinnedSpecies`,
  `toggleProfile`, …). These map 1:1 onto the network command channel.

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
  │  • WS broadcast (snapshots) │   DDoS, rate-limit) ────────► │  + controls  │
  │  • static serve (dist/)     │                               └──────────────┘
  │  • command channel (token)  │
  └─────────────────────────────┘
```

**Server (Node, on the Mac mini):**
- **Sim loop:** `step(world, dt)` at a fixed cadence. Decouple sim rate from
  stream rate (sim can run faster or "as fast as CPU allows"; stream throttled).
- **WS bidirectional channel:** every connected socket can both receive
  snapshots and send commands. Snapshots are broadcast every 1/20s (binary
  typed-arrays per §4).
- **Token gate at upgrade.** The HTTP upgrade handler reads `?token=...` from
  the WS URL and compares against `EVOSIM_TOKEN` (env var). Mismatch → close
  with code 4401. Token never logged.
- **Concurrent cap of 5 sockets globally.** 6th gets `4429 Too Many
  Connections`. Render snapshots + commands share the socket, so 5 = 5
  humans-worth of presence.
- **Per-connection rate limit on inbound commands** (e.g. 5/sec, burst 20)
  as belt-and-suspenders; not a security mechanism (token is the gate), just a
  guard against runaway clients.
- **Static serve:** serve `dist/` (the client bundle). One process can do HTTP +
  WS-upgrade + static.

**Client (browser):**
- New **"remote" mode**: connect to the WS with the token in the query string,
  receive snapshots, draw with the existing renderer; do **not** instantiate
  the local sim worker.
- All existing UI controls work — they emit the same message types they
  always did, but on a WebSocket instead of `postMessage`.
- Per-frame entity data streamed; static terrain/HUD-scale data received once
  on connect.

**Transport (Cloudflare Tunnel):** `cloudflared` makes an **outbound-only**
tunnel from the Mac mini to Cloudflare and maps a public hostname →
`http://127.0.0.1:PORT`. No router ports opened. TLS (so WSS) is automatic.
**Cloudflare Access is intentionally NOT used** — the static token in the WS
URL is the gate. Add a Cloudflare rate-limit rule + bot/WAF.

---

## 3. Security model

Single owner; the static token + 5-connection cap is the whole policy.

- **Token in query string.** `?token=...` checked at WS upgrade. Token lives in
  `EVOSIM_TOKEN` env var on the server; rotate by restarting the server with a
  new value.
- **5 concurrent sockets max.** Anyone past that is refused.
- **Per-connection inbound rate-limit.** 5 commands/sec, burst 20.
  Per-command payload size cap (e.g. spawn genomes ≤ 4 KB, world dims
  sanity-checked).
- **Audit log.** Append every accepted command to a JSONL log (socket id, t,
  op, payload-bytes). Cheap accountability when something weird happens.

Operational must-dos:
- **Bind `127.0.0.1`** (not `0.0.0.0`); the tunnel reaches it locally.
- Run the Node process as a **non-admin user**; keep macOS + Node patched.
- The token is the only fence — if it leaks, rotate it (env var + restart).
  Treat the URL as a password.

---

## 4. Render-snapshot protocol (keep it cheap)

Do **not** ship the 4.8 MB save. Send a minimal, binary, render-only payload.

**Sent once (on connect / on change):**
- world dims, `surfaceY`, day-cycle params
- terrain/obstacles (polygons) — static after generation
- **server build hash** (for version-skew detection; see §6)

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
  visible entities.

At current scales (~hundreds of cells, ~1000 particles) a full binary frame is
tens of KB — trivial bandwidth at 20 fps.

---

## 5. Deploy story — pull and restart

Four reasonable shapes; the recommendation is **D as the default, with B as
an optional safety net.**

| Shape | When it triggers | Pro | Con |
|---|---|---|---|
| **A. In-process git poll** | Every N min, server forks `git fetch && rebuild && exec` | Self-contained | Server has to know about npm/build; harder to debug |
| **B. External cron** (launchd timer or `pm2 reload --cron`) | Every N min, outside script | Clean separation | Two pieces to maintain |
| **C. GitHub webhook → server endpoint** | On push | Instant deploy | Webhook signature plumbing; overkill for solo |
| **D. `/deploy` command on control channel + crash-respawn** | When you type it | Trivial; same auth as everything else | Manual |

**The shared primitive** — `deploy.sh`:

```sh
set -e
cd /path/to/evosim4
git fetch origin claude/develop
git diff --quiet origin/claude/develop HEAD && exit 0   # nothing new
# State handoff: server's SIGTERM handler writes /tmp/evosim-handoff.json
git pull
npm ci
npm run build
pm2 restart evosim   # or launchctl kickstart -k
```

`/deploy` (token-gated WS command) just spawns this script and returns the
result. After `pm2 restart`, the WS server is briefly down — clients
auto-reconnect with backoff and the new server restores from the handoff JSON.

**Process manager.** `pm2` for ease (`pm2 start scripts/server.ts --name evosim
&& pm2 startup && pm2 save`). launchd is the native option if you want one
less moving piece. Either gives crash-respawn + boot-survival.

**State handoff across restart.** Save world to `/tmp/evosim-handoff.json` on
shutdown signal (`SIGTERM`); on startup, if the handoff file exists AND
`saved.schema === SAVE_SCHEMA`, restore from it; else fresh world. A schema
bump means the world starts over — that's the trade for not maintaining
migrations.

**Client / server version skew.** Server includes a build hash in its hello
message; client compares against its own (baked at build time). On mismatch,
banner: "Server updated — refresh to load new client." Doesn't auto-refresh
(mid-edit users get to choose).

---

## 6. Implementation phases

**Phase 1 — server WS stream + control.** Extend `scripts/headless.ts` (or a
new `scripts/server.ts`) into a server:
- `step()` loop at fixed cadence + a `ws` WebSocket server that broadcasts
  the render snapshot + serves `dist/`.
- Token check + 5-connection cap at upgrade.
- Inbound command channel (envelope: `{type:"cmd", op:"setAutoCull",
  payload:{on:true}}`) funnelled through a single `dispatchCommand(world, op,
  payload)` switch.
- Per-connection inbound rate limit; per-command size cap.
- Audit log (JSONL).
- `SIGTERM` handler writes `/tmp/evosim-handoff.json` before exit.
- Startup: if handoff file exists AND schema matches, restore from it.
- `/deploy` command handler (token-gated, spawns `deploy.sh`).

Validate **locally** by pointing the *current* in-browser renderer at
`ws://localhost:PORT` — proves the protocol + bandwidth before any deployment.

**Phase 2 — thin client.** Add a "remote" mode to `main.ts`:
- WorkerLike shim: the existing send-site (`simWorker.postMessage`) routes
  either to the real local worker OR to a remote-worker shim that translates
  `send → WS-send` and `WS-recv → message`. Either backend; the rest of
  `main.ts` is unchanged.
- Reconnect-with-backoff on socket close.
- Build-hash mismatch banner.
- Mode selected by `?remote=ws://...&token=...` URL param.

**Phase 3 — operator visibility / safety net.**
- Top-bar banner: "shared world — N operators connected — last command: <op>".
- Periodic snapshot rotation to disk (already in `headless.ts`; preserve it).
  Lets you roll back if a command trashes the world.
- Optional: `/undo` command that restores the last N-minute snapshot.

**Phase 4 — deploy.** §5 runbook applies (Mac mini, launchd or pm2, cloudflared
tunnel). Add Cloudflare rate-limit rule. Drop the "no Cloudflare Access"
guidance — the token in the URL is the gate.

**UI + docs (every phase, in the same change-set):** the viewer's control UI
remains the same; both viewer and controller use one code path. Both show a
clear **connection/streaming status** (connected / reconnecting / token
invalid / cap reached). Update `README.md` and `CLAUDE.md` to document the
headless-server + streaming-viewer architecture, the token + connection-cap
gate, the render-snapshot protocol, and to point at the §7 deployment runbook.

**Estimated scope.**
- Phase 1: ~300 lines (Node WS server, command dispatch, rate-limiter, audit
  log) + ~30 lines for token + cap + ~40 lines for `/deploy` handler + ~25
  lines for handoff JSON in/out.
- Phase 2: ~150 lines (WorkerLike shim + remote-mode plumbing in main.ts) +
  ~30 lines reconnect-with-backoff + ~20 lines build-hash banner.
- Phase 3: ~80 lines.
- Phase 4: `deploy.sh` + `ecosystem.config.js` (pm2) or `.plist` (launchd) —
  pick one.

Total well under 500 lines net new code, no engine changes.

---

## 7. Deployment runbook (Mac mini)

Prereqs: Node, this repo, `npm run build` (→ `dist/`), `cloudflared`
(`brew install cloudflared`), and a domain on Cloudflare (free plan).

**Run the server**
- Start the server entry (e.g. `pm2 start scripts/server.ts --name evosim`),
  binding `127.0.0.1:PORT`. Set `EVOSIM_TOKEN` in the env (e.g. via the pm2
  ecosystem file).
- Keep it alive: `pm2 startup && pm2 save`, or a **launchd** plist with
  `KeepAlive=true`.

**Cloudflare named tunnel** (standard flow — check current `cloudflared` docs
for exact syntax):
1. `cloudflared tunnel login`
2. `cloudflared tunnel create evosim`
3. config (`~/.cloudflared/config.yml`): ingress rule mapping
   `evosim.<yourdomain>` → `http://127.0.0.1:PORT` (WebSockets pass through).
4. `cloudflared tunnel route dns evosim evosim.<yourdomain>`
5. `cloudflared tunnel run evosim` — also under launchd so it persists.
6. **Add a Cloudflare rate-limiting rule** in the dashboard; optionally
   bot/WAF rules.

**Verify**
- `https://evosim.<yourdomain>/?token=<TOKEN>` from phone/laptop → connects,
  renders, controls work.
- 6th connection refused with code 4429.
- Invalid token refused with code 4401.

---

## 8. Open questions

These are the live design choices left:

1. **Destructive-command guardrail in open mode?** Even with the token, a
   typo in `setGeologySeed` or scenario-rebuild instantly regenerates the
   world. Two options: (a) treat all commands equally (the user IS the
   operator, trust them); (b) add a per-command "type the word DESTROY to
   confirm" client-side guard for the obliterators. **Lean: (a)** — simpler,
   and the snapshot rotation in Phase 3 is the safety net.
2. **Bind on LAN vs only behind tunnel?** Binding `127.0.0.1` is the right
   default (tunnel-only). If you want direct LAN access for low-latency
   control from devices in the house, bind `0.0.0.0` with a firewall rule —
   skip for now.
3. **Snapshot retention.** Keep how many auto-snapshots? Rolling 24 × 1-hour
   feels right; configurable.
4. **Stream framerate.** Default 20 fps. Bandwidth headroom for 30; battery
   impact on mobile if you push higher.

## 9. Non-goals (for now)

- Server-side pixel/video encoding (WebRTC/MJPEG). Heavier infra; only revisit
  if snapshot bandwidth becomes a problem.
- View-only public sharing (the v0 of STREAMING_PLAN). Out of scope for the
  single-operator + token model.
- Multi-world / multi-tenant hosting. Single shared world, broadcast to viewers.
