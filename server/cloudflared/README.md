# Cloudflare Tunnel for evosim-server

Three layered choices, in order of "easiest" to "most production-grade":

## 1. Quick tunnel (ephemeral, no Cloudflare account)

```sh
./server/scripts/tunnel.sh quick
```

Cloudflare prints a randomized `https://*.trycloudflare.com` URL on
stdout; that URL talks to your local `evosim-server` via the tunnel.
Goes away when the process dies. No DNS, no account, no Access. Good
for "show this to one person right now."

Security in this mode is *only* the evosim-server bearer token. Anyone
who guesses the random URL can hit `/health` (returns "ok"), and try
to connect to `/sim` (their `Auth { token: ... }` had better be wrong
or admin is theirs). Pick a 32-byte random `EVOSIM_ADMIN_TOKEN`.

## 2. Named tunnel with Cloudflare Access (recommended)

This is the path that gives you double-gating: Cloudflare Access
challenges the connection (your email, your Google, your GitHub --
your choice) BEFORE the request reaches `evosim-server`, then the
admin token gates privileged commands.

### One-time setup

1. `cloudflared tunnel login` -- opens a browser, authorizes the host
   to your Cloudflare account.
2. `cloudflared tunnel create evosim` -- generates a UUID and writes
   a credentials JSON (note the path; you'll need it).
3. `cloudflared tunnel route dns evosim sim.YOURDOMAIN.com` -- adds
   a CNAME pointing the hostname at the tunnel.
4. Copy `config.example.yml` to `config.yml` and edit:
   - replace `sim.example.com` with your hostname (both ingress rules)
   - replace the `credentials-file` path
5. In the **Cloudflare Zero Trust dashboard** (free for up to 50
   users):
   - **Access -> Applications -> Add an application -> Self-hosted**.
   - Application domain: `sim.YOURDOMAIN.com`.
   - Path: leave blank (covers `/sim` and `/health`).
   - Identity provider: "One-time PIN" works without setup; add
     Google / GitHub / etc. for SSO.
   - Policy: "Allow", include rule = your email address. Save.

### Running

```sh
./server/scripts/tunnel.sh named ./server/cloudflared/config.yml
```

This runs `evosim-server` under its supervisor wrapper and
`cloudflared` in parallel; ctrl-c takes both down.

### What this gets you

- **No router config.** All Cloudflare traffic is outbound from your
  box; no port forward, no static IP.
- **TLS at the edge.** Cloudflare terminates TLS; your origin sees
  HTTP. Don't expose the loopback port outside the box.
- **Two independent gates.** Cloudflare Access blocks connections
  before they reach evosim. The admin token is the second gate; an
  attacker would need both to trigger restart/update.
- **Free for personal use.** The tunnel itself is free; Zero Trust
  free tier covers up to 50 users.

### Operational notes

- `EVOSIM_BIND=127.0.0.1:8080` -- the script defaults to loopback;
  don't change this when running under the tunnel.
- The bottom HUD's "build=" token shows the server's commit. After an
  admin `Update`, reconnect and check that the build changed.
- Access policies and cloudflared restart are independent of evosim:
  an admin `Restart` only re-exec's the server, the tunnel stays up.

## 3. Persistent named tunnel as a service

For a home box you leave running:

```sh
sudo cloudflared service install
# uses the config in /etc/cloudflared/config.yml
```

cloudflared installs a systemd unit that survives reboots. Pair it
with a systemd unit for `evosim-server` (or run `tunnel.sh` from
your own unit) and the whole pipeline is supervised:

```
# /etc/systemd/system/evosim.service
[Unit]
Description=evosim-server
After=network-online.target cloudflared.service
Wants=network-online.target

[Service]
User=evosim
WorkingDirectory=/srv/evosim4/server
Environment=EVOSIM_BIND=127.0.0.1:8080
Environment=EVOSIM_ADMIN_TOKEN_FILE=/etc/evosim/admin-token
ExecStartPre=/bin/sh -c 'export EVOSIM_ADMIN_TOKEN=$(cat /etc/evosim/admin-token)'
ExecStart=/srv/evosim4/server/scripts/run.sh
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

(`EVOSIM_ADMIN_TOKEN_FILE` is read by a future commit; for now keep the
token in the unit's `Environment=` and `chmod 600` the unit file.)

## When NOT to use Cloudflare Tunnel

- You don't trust Cloudflare to see your traffic metadata.
  (Encrypted at TLS, but Cloudflare terminates TLS at the edge.)
- You want sub-50ms ping from a controller; the tunnel adds ~20-40ms
  round-trip depending on routing.
- You're on a residential ISP that throttles outbound TLS to
  Cloudflare. Rare but seen.

In those cases see `server/README.md` for the Caddy + Let's Encrypt
and WireGuard-via-VPS alternatives.
