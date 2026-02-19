<div align="center">

<h1>📦 Hatchpod</h1>

<p><strong>A persistent, self-hosted Claude Code workstation you can access from anywhere.</strong></p>

<p>
  <a href="https://github.com/andresmorales07/hatchpod/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/andresmorales07/hatchpod/ci.yml?branch=main&label=CI&logo=github" alt="CI"></a>
  <a href="https://github.com/andresmorales07/hatchpod/releases/latest"><img src="https://img.shields.io/github/v/release/andresmorales07/hatchpod?logo=github" alt="Release"></a>
  <a href="https://github.com/andresmorales07/hatchpod/pkgs/container/hatchpod"><img src="https://img.shields.io/badge/ghcr.io-hatchpod-blue?logo=docker" alt="Container"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/andresmorales07/hatchpod" alt="License"></a>
</p>

</div>

Run Claude Code on a server, VPS, or homelab — then connect via **SSH**, **web browser**, **Mosh**, or **Tailscale VPN** from wherever you are. Your files, credentials, MCP servers, dotfiles, and Docker images all persist across restarts.

Think of it as your personal cloud dev machine with Claude Code built in.

## Why Hatchpod?

Unlike ephemeral sandboxes (like [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/claude-code/)) that spin up for a single task and disappear, Hatchpod is a **long-lived workstation**.

| | Ephemeral Sandboxes | Hatchpod |
|---|---|---|
| **Lifecycle** | Task-scoped, disposable | Persistent — pick up where you left off |
| **Access** | Local only | SSH, Mosh, web terminal, Tailscale VPN |
| **Customization** | Pre-set image | Full Linux env with sudo, dotfiles, any tooling |
| **Docker-in-Docker** | Limited or none | Full DinD via [Sysbox](https://github.com/nestybox/sysbox) |
| **Requires** | Docker Desktop | Any Linux host with Docker Engine |

## Quick Start

```bash
# 1. Clone and configure
git clone https://github.com/andresmorales07/hatchpod.git
cd hatchpod
cp .env.example .env            # edit .env to set your passwords

# 2. Start (pulls the prebuilt image — no build step needed)
docker compose up -d

# 3. Connect
ssh -p 2222 hatchpod@localhost    # password is SSH_PASSWORD from .env

# 4. Authenticate Claude Code (first time only)
claude                          # follow the login link that appears
```

> **No Sysbox?** The default `docker-compose.yml` sets `runtime: sysbox-runc` for Docker-in-Docker. If you don't have [Sysbox](https://github.com/nestybox/sysbox) installed, create a one-line override:
>
> ```bash
> echo 'services: { hatchpod: { runtime: runc } }' > docker-compose.override.yml
> docker compose up -d
> ```
>
> Everything except `docker` commands inside the container will work without Sysbox.

## What's Included

<table>
<tr><td><strong>Category</strong></td><td><strong>Software</strong></td><td><strong>Purpose</strong></td></tr>
<tr><td rowspan="2">🤖 <strong>AI</strong></td><td>Claude Code</td><td>Anthropic's CLI agent</td></tr>
<tr><td>Web UI + API</td><td>Claude Code web interface and REST/WebSocket API (port 8080)</td></tr>
<tr><td rowspan="2">⚡ <strong>Runtimes</strong></td><td>Node.js 20 LTS</td><td>MCP servers (npx)</td></tr>
<tr><td>Python 3 + venv</td><td>MCP servers (uvx)</td></tr>
<tr><td rowspan="2">📦 <strong>Package Mgrs</strong></td><td>npm</td><td>Node packages (global prefix persisted)</td></tr>
<tr><td>uv / uvx</td><td>Python packages and tool runner</td></tr>
<tr><td>🐳 <strong>Containers</strong></td><td>Docker Engine + Compose</td><td>Docker-in-Docker (requires Sysbox on host)</td></tr>
<tr><td rowspan="4">🌐 <strong>Access</strong></td><td>OpenSSH server</td><td>Remote access (port 2222)</td></tr>
<tr><td>ttyd</td><td>Web terminal (port 7681)</td></tr>
<tr><td>mosh</td><td>Resilient mobile shell (UDP 60000-60003)</td></tr>
<tr><td>Tailscale</td><td>VPN access (opt-in, set <code>TS_AUTHKEY</code>)</td></tr>
<tr><td rowspan="3">🔧 <strong>Dev Tools</strong></td><td>git</td><td>Version control</td></tr>
<tr><td>GitHub CLI (gh)</td><td>GitHub operations</td></tr>
<tr><td>curl, jq</td><td>HTTP requests and JSON processing</td></tr>
<tr><td rowspan="2">🖥️ <strong>System</strong></td><td>s6-overlay v3</td><td>Process supervision</td></tr>
<tr><td>sudo (passwordless)</td><td>Root access for <code>hatchpod</code> user</td></tr>
</table>

## Access Methods

Connect from any machine — all access methods work both locally and remotely.

### SSH (port 2222)

```bash
ssh -p 2222 hatchpod@localhost
```

Use your `SSH_PASSWORD` to authenticate, or add your public key:

```bash
ssh-copy-id -p 2222 hatchpod@localhost
```

### Web Terminal (port 7681)

Open `http://localhost:7681` in your browser. Authenticate with `TTYD_USERNAME` / `TTYD_PASSWORD` from your `.env`.

### Web UI + API (port 8080)

Mobile-friendly web interface for Claude Code. Works on phones, tablets, and desktops.

```bash
# Web UI
open http://localhost:8080

# REST API
curl -H "Authorization: Bearer $API_PASSWORD" http://localhost:8080/api/sessions

# Create a session
curl -X POST -H "Authorization: Bearer $API_PASSWORD" \
     -H "Content-Type: application/json" \
     -d '{"prompt":"What files are in the workspace?"}' \
     http://localhost:8080/api/sessions
```

API endpoints: `GET /healthz`, `POST /api/sessions`, `GET /api/sessions`, `GET /api/sessions/:id`, `DELETE /api/sessions/:id`. WebSocket streaming at `WS /api/sessions/:id/stream?token=<password>`.

### Mosh (UDP 60000-60003)

Resilient connection that survives WiFi switches, VPN reconnects, and laptop sleep/wake:

```bash
mosh --ssh='ssh -p 2222' hatchpod@localhost
```

### Tailscale VPN (Optional)

Connect from anywhere without exposing ports publicly. Set `TS_AUTHKEY` in your `.env`:

1. Generate an auth key at [Tailscale Admin → Settings → Keys](https://login.tailscale.com/admin/settings/keys)
2. Add to `.env`:
   ```
   TS_AUTHKEY=tskey-auth-xxxxx
   ```
3. Restart: `make down && make up`
4. Connect via your Tailscale IP:
   ```bash
   ssh -p 2222 hatchpod@<tailscale-ip>
   ```

**Networking mode:** The container auto-detects TUN device availability at startup:
- **Kernel TUN mode** (default with `docker-compose.yml`): Transparent routing — all apps can reach Tailscale peers without any proxy configuration. Requires `cap_add: NET_ADMIN` and `/dev/net/tun` device (both provided in `docker-compose.yml`).
- **Userspace fallback** (no TUN device): Apps must use the SOCKS5 proxy at `localhost:1055` explicitly. A `TAILSCALE_PROXY` variable is written to `/etc/profile.d/tailscale-proxy.sh` for convenience, but is **not exported** to avoid breaking general internet connectivity.

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SSH_PASSWORD` | SSH password for `hatchpod` user | `changeme` |
| `TTYD_USERNAME` | Web terminal username | `hatchpod` |
| `TTYD_PASSWORD` | Web terminal password | `changeme` |
| `API_PASSWORD` | API server + Web UI password | `changeme` |
| `TS_AUTHKEY` | Tailscale auth key (enables VPN) | _(disabled)_ |
| `TS_HOSTNAME` | Tailscale node name | `hatchpod` |
| `DOTFILES_REPO` | Git URL for dotfiles repo | _(disabled)_ |
| `DOTFILES_BRANCH` | Branch to checkout | _(default)_ |

### Authentication

Hatchpod uses the interactive login flow. Run `claude` inside the container and follow the login link. Credentials are stored in `~/.claude/` which is backed by the `home` Docker volume, so they persist across restarts.

### MCP Servers

MCP servers configured inside the container persist across restarts:

```bash
ssh -p 2222 hatchpod@localhost
claude mcp add my-server -- npx some-mcp-server
```

### Dotfiles (Optional)

Set `DOTFILES_REPO` in your `.env` to automatically clone and install dotfiles on first boot:

```
DOTFILES_REPO=https://github.com/youruser/dotfiles.git
```

On first boot, the repo is cloned to `~/dotfiles`. If an install script (`install.sh`, `setup.sh`, or `bootstrap.sh`) is found, it runs automatically. Otherwise, if a `Makefile` is present, `make` is run.

### Volumes

| Volume | Container Path | Purpose |
|--------|---------------|---------|
| `home` | `/home/hatchpod` | Claude config, workspace, dotfiles, npm globals |
| `docker-data` | `/var/lib/docker` | Docker images, containers, layers |

## Docker-in-Docker

Hatchpod includes Docker Engine inside the container. With [Sysbox](https://github.com/nestybox/sysbox) installed on the host, agents can build and run Docker containers securely without `--privileged`.

```bash
# Verify DinD works
make docker-test

# Use Docker inside the container
make shell
docker run --rm alpine echo "Hello from nested container"
docker build -t myapp .
```

The `docker-data` volume persists pulled images and build cache across container restarts.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│            hatchpod container (sysbox-runc)               │
│                                                          │
│  ┌────────┐ ┌─────────┐ ┌───────┐ ┌──────┐ ┌──────────┐ │
│  │  api   │ │  sshd   │ │ ttyd  │ │dockerd│ │tailscaled│ │
│  │ :8080  │ │  :2222  │ │ :7681 │ │ DinD  │ │(opt-in)  │ │
│  └────┬───┘ └────┬────┘ └───┬───┘ └───┬──┘ └────┬─────┘ │
│       │          │          │         │          │       │
│  ┌────┴──────────┴──────────┴─────────┴──────────┘       │
│  │  Provider Abstraction Layer (NormalizedMessage)        │
│  │  └─ ClaudeAdapter → Claude Code CLI                   │
│  └───────────────────────────────────────────────────────┘│
│       Node.js 20 · Python 3 · uv/uvx (MCP)              │
│                                                          │
│  Volumes:                                                │
│   /home/hatchpod   → home vol                            │
│   /var/lib/docker  → docker-data vol                     │
└──────────────────────────────────────────────────────────┘
```

Process supervision by [s6-overlay](https://github.com/just-containers/s6-overlay). Web terminal by [ttyd](https://github.com/tsl0922/ttyd).

## Make Targets

| Target | Description |
|--------|-------------|
| `make build` | Build the Docker image |
| `make up` | Start the container |
| `make down` | Stop the container |
| `make logs` | Follow container logs |
| `make shell` | Open a shell in the container |
| `make ssh` | SSH into the container |
| `make mosh` | Connect via mosh |
| `make clean` | Stop container, remove volumes and image |
| `make docker-test` | Run hello-world inside the container (DinD smoke test) |

## Upgrading from claude-box

If you're upgrading from an earlier version named "claude-box", there are three breaking changes:

**1. Volume name changed** (`claude-home` → `home`). Migrate your data before starting:

```bash
# Stop the old container
docker compose down

# Create the new volume and copy data
docker volume create hatchpod_home
docker run --rm \
  -v claude-box_claude-home:/from \
  -v hatchpod_home:/to \
  alpine sh -c "cp -a /from/. /to/"
```

**2. Linux user changed** (`claude` → `hatchpod`). The migration above copies the files, but internal paths shift from `/home/claude/` to `/home/hatchpod/`. The container's init script automatically fixes ownership on boot.

**3. Env var renamed** (`CLAUDE_USER_PASSWORD` → `SSH_PASSWORD`). Update your `.env` file. The old name still works temporarily but prints a deprecation warning.

## Security Notes

- Change all default passwords in `.env` before exposing to a network
- The `.env` file is excluded from git via `.gitignore`
- SSH root login is disabled
- For remote access, use SSH tunneling or put behind a reverse proxy with TLS
- The `hatchpod` user has passwordless sudo inside the container

## Backup and Restore

```bash
# Backup
docker run --rm -v hatchpod_home:/data -v $(pwd):/backup alpine \
    tar czf /backup/home-backup.tar.gz -C /data .

# Restore
docker run --rm -v hatchpod_home:/data -v $(pwd):/backup alpine \
    tar xzf /backup/home-backup.tar.gz -C /data
```

---

<div align="center">

<sub>Built with <a href="https://github.com/just-containers/s6-overlay">s6-overlay</a> · <a href="https://github.com/tsl0922/ttyd">ttyd</a> · <a href="https://github.com/nestybox/sysbox">Sysbox</a></sub>

</div>
