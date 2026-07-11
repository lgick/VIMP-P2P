# Deployment

A guide to preparing a clean VPS, configuring the environment, and running
the **master server** (lobby + signaling; matches run on browser hosts,
there are no server-side game instances) via GitHub Actions CI/CD. Setup
scripts live in [.github/deployment/](../../.github/deployment/).

**How it works**: a push to `main` →
[.github/workflows/deploy.yml](../../.github/workflows/deploy.yml) builds a
Docker image and publishes it to GHCR → SSHes into every server in
`SERVERS_MATRIX`, generates `.env`, and restarts the `vimp-<domain>`
container. On the VPS, Nginx terminates HTTPS and proxies to the app port
(the master listens on `3002` inside the container).

> **Rust toolchain in the build.** The browser host's Worker loads the
> WASM core (`core/pkg-web/`), so [Dockerfile](../../Dockerfile) builds it
> in a separate `core-builder` stage (`rust:slim` + `wasm-pack`), and the
> node stage runs `npm run build:app` (audio + Vite) with `pkg-web`
> already in place. A local `npm run build` does the same in one command
> and requires the Rust toolchain (see
> [getting-started.md](getting-started.md#rust-toolchain-the-core-core)).

## 📋 Prerequisites

1. A **VPS** running Ubuntu 20.04, 22.04, or 24.04.
2. A **domain name** pointed at your server's IP.
3. **SSH access** to the server (sudo preferred).
4. **Git** installed locally and the project repo cloned.

## Step 1: DNS (domain setup)

Before configuring the server, create an **A record** with your domain
registrar:

- **Type:** `A`
- **Name (Host):** `game` (for example, for game.example.com)
- **Value:** `YOUR_SERVER_IP`

## Step 2: Initial system setup (once)

Runs **once** on a new server. The script installs Nginx, Docker,
Fail2Ban, and configures the firewall.

1. Upload the scripts to the server:

   ```bash
   scp .github/deployment/*.sh root@YOUR_SERVER_IP:~/vimp-deployment-scripts/
   ```

2. SSH in and make the scripts executable:

   ```bash
   ssh root@YOUR_SERVER_IP

   cd ~/vimp-deployment-scripts
   chmod +x *.sh
   ```

3. Prepare the VPS:

   ```bash
   ./install-system.sh
   ```

**What happens:**

- required packages are installed;
- ports are opened (the script asks for confirmation);
- the root projects directory `~/vimp_projects` is created;
- Nginx security keys are generated.

## Step 3: Adding a master server

Run this whenever you need to stand up a new master instance on a new
domain (e.g. `game.example.com`).

1. On the server, run:

   ```bash
   cd ~/vimp-deployment-scripts
   ./add-server.sh
   ```

2. Follow the setup wizard:
   - enter the **domain** (e.g. `game.example.com`);
   - enter the **port** (e.g. `3005`) — **remember it**;
   - enter an email (for SSL notifications).

**Result:**

- the project folder `~/vimp_projects/game.example.com` is created;
- an SSL certificate is obtained (Let's Encrypt);
- Nginx is configured (HTTPS proxying to the chosen port).

> ⚠️ The server is configured but **empty** — the game won't run until
> the next step is done.

## Step 4: Configuration and launch (CI/CD)

The server list is configured through GitHub repository variables.

1. Open **Settings → Secrets and variables → Actions → the Variables
   tab**.
2. Create (or edit) the `SERVERS_MATRIX` variable:

   ```json
   [
     {
       "ip": "YOUR_SERVER_IP",
       "domain": "game.example.com",
       "port": 3005
     }
   ]
   ```

   _(`domain` and `port` must exactly match Step 3. Game parameters aren't
   set in the matrix: room creators configure them in the lobby — see
   [configuration.md](configuration.md#environment-variables-env))._

3. In the **Secrets** tab there must be deployment SSH secrets:
   `SERVER_USER` (the VPS user) and `SERVER_SSH_KEY` (the private key).
4. Go to the **Actions** tab and re-run the pipeline manually (Re-run
   jobs) or `git push` to `main` — the system deploys the master to every
   server in the list.

## 🔒 Security headers and CSP

Environment hygiene: it filters out "street" attackers — not a cheating
host, since it physically runs the simulation in its own process and its
WASM memory is reachable from its own JS, bypassing the core's logic;
CSP doesn't prevent that. In production, client static assets and
`.wasm` are served by **Nginx**, so the authoritative
Content-Security-Policy point is the Nginx `server` block for the
domain. The policy string's single source of truth is
[src/config/master.js](../../src/config/master.js) (`security.csp`); the
master applies it to its own responses, but HTML/`.wasm` go through
Nginx.

The `install-system.sh` template already includes these headers; when
configuring manually, add them to the Nginx `server` block (or a shared
snippet):

```nginx
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
add_header X-Frame-Options "DENY" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' wss: data:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" always;
```

Key directives: `script-src ... 'wasm-unsafe-eval'` (compiling the WASM
core in the browser), `worker-src 'self' blob:` (the host's Web Worker),
`connect-src 'self' wss: data:` (the master's signaling WebSocket;
`data:` — PixiJS checks `ImageBitmap` support by fetching a test
`data:` URL; CSP doesn't gate WebRTC data channels). In **dev**, CSP
isn't applied — ViteExpress + HMR need `'unsafe-inline'` and the HMR
WebSocket.

CSP deliberately omits `'unsafe-eval'` — PixiJS throws `Current
environment does not allow unsafe-eval` without it, so
`src/client/main.js` imports `pixi.js/unsafe-eval` (before creating the
`Application`) — this switches PixiJS to a safe-eval path without
weakening the policy.

Minifying the JS shell is standard for `vite build`. Heavier obfuscation
is deliberately out of scope: it's useless against a cheating host.

## 🛠 Maintenance and removal

### Changing server settings

Edit `SERVERS_MATRIX` in GitHub settings and re-run the Action.

### Updating the game

Just `git push` to `main` — GitHub Actions automatically updates every
server in `SERVERS_MATRIX`. Client static assets and the WASM core are
baked into the image. Already-open rooms pick up the new code version on
their own (the Worker handoff): a master restart drops hosts' signaling
WS → reconnect → re-register brings a new `codeVersion` → the host tab
downloads the new worker bundle (`GET /worker/manifest.json`) and
replaces the Worker at the nearest round boundary without dropping P2P
connections (score and participants carry over, clients see a normal
round start). Client pages stay on the old build until reloaded — the
client↔host protocol must stay compatible across a deploy (the client
drops an incompatible binary frame by format version). Details —
[host.md](host.md#worker-handoff).

### Removing a server

On the VPS, use `./delete-server.sh` — it removes the Nginx configs, the
project folder, and stops the container.

> ⚠️ Afterward, remove that server's entry from `SERVERS_MATRIX` on
> GitHub!

### Viewing logs on the VPS

| Action | Docker command |
| --- | --- |
| Tail logs (node.js) | `docker logs -f vimp-<domain>` |
| List processes | `docker ps -a` |
| Restart | `docker restart vimp-<domain>` |
| Stop | `docker stop vimp-<domain>` |
| Resource usage | `docker stats` |

---

[← Previous: Extending the Game](extending.md)
