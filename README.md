# Claude Box

A persistent, self-hosted Claude Code environment you can access from any machine. Run it on a server, VPS, or homelab — then connect via SSH, Mosh, web browser, or Tailscale VPN from wherever you are.

Unlike ephemeral sandboxes (like [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/claude-code/)) that spin up for a single task and disappear, Claude Box is a **long-lived workstation**. Your files, Claude credentials, MCP servers, dotfiles, and Docker images all persist across restarts. Think of it as your personal cloud dev machine with Claude Code built in.

## Why Claude Box?

| | Ephemeral sandboxes | Claude Box |
|---|---|---|
| **Lifecycle** | Task-scoped, disposable | Persistent — pick up where you left off |
| **Access** | Local only | SSH, Mosh, web terminal, Tailscale VPN |
| **Customization** | Pre-set image | Full Linux env with sudo, dotfiles, any tooling |
| **Docker-in-Docker** | Limited or none | Full DinD via [Sysbox](https://github.com/nestybox/sysbox) |
| **Requires** | Docker Desktop | Any Linux host with Docker Engine |

**Use Claude Box when** you want a stable, remotely-accessible Claude Code environment. **Use ephemeral sandboxes when** you need fire-and-forget agent runs with strong isolation for untrusted code.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (with Compose v2)

## Quick Start

```bash
# 1. Clone and configure
git clone https://github.com/andresmorales07/claude-box.git
cd claude-box
cp .env.example .env            # edit .env to set your passwords

# 2. Start (pulls the prebuilt image — no build step needed)
docker compose up -d

# 3. Connect
ssh -p 2222 claude@localhost    # password is CLAUDE_USER_PASSWORD from .env
# — or open http://localhost:7681 in a browser (TTYD_USERNAME / TTYD_PASSWORD)

# 4. Authenticate Claude Code (first time only)
claude                          # follow the login link that appears
```

> **No Sysbox?** The default `docker-compose.yml` sets `runtime: sysbox-runc` for Docker-in-Docker. If you don't have [Sysbox](https://github.com/nestybox/sysbox) installed, create a one-line override to use the default runtime:
>
> ```bash
> echo 'services: { claude-box: { runtime: runc } }' > docker-compose.override.yml
> docker compose up -d
> ```
>
> Everything except `docker` commands inside the container will work without Sysbox.

## What's Included

The container comes pre-installed with:

| Category | Software | Purpose |
|----------|----------|---------|
| **AI** | Claude Code | Anthropic's CLI agent |
| | Web UI + API | Claude Code web interface and REST/WebSocket API (port 8080) |
| **Runtimes** | Node.js 20 LTS | MCP servers (npx) |
| | Python 3 + venv | MCP servers (uvx) |
| | .NET SDK 8.0, 9.0, 10.0 | Side-by-side; selected via `global.json` |
| **Package managers** | npm | Node packages (global prefix persisted) |
| | uv / uvx | Python packages and tool runner |
| **Containers** | Docker Engine + Compose | Docker-in-Docker (requires Sysbox on host) |
| **Access** | OpenSSH server | Remote access (port 2222) |
| | ttyd | Web terminal (port 7681) |
| | mosh | Resilient mobile shell (UDP 60000-60003) |
| | Tailscale | VPN access (opt-in, set `TS_AUTHKEY`) |
| **Dev tools** | git | Version control |
| | GitHub CLI (gh) | GitHub operations |
| | curl, jq | HTTP requests and JSON processing |
| **System** | s6-overlay v3 | Process supervision |
| | sudo (passwordless) | Root access for `claude` user |

## Access Methods

Connect from any machine — all access methods work both locally and remotely (via Tailscale or any network route to the host).

### SSH (port 2222)

```bash
ssh -p 2222 claude@localhost
```

Use your `CLAUDE_USER_PASSWORD` to authenticate, or add your public key to the container:

```bash
ssh-copy-id -p 2222 claude@localhost
```

### Web Terminal (port 7681)

Open `http://localhost:7681` in your browser. Authenticate with `TTYD_USERNAME` / `TTYD_PASSWORD` from your `.env`.

### Web UI + API (port 8080)

Mobile-friendly web interface for Claude Code. Open `http://localhost:8080` in any browser — works on phones, tablets, and desktops.

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
mosh --ssh='ssh -p 2222' claude@localhost
```

### Direct Shell

```bash
make shell
```

### Tailscale VPN (Optional)

Connect to your claude-box from anywhere without exposing ports publicly. Set `TS_AUTHKEY` in your `.env` to enable.

1. Generate an auth key at [Tailscale Admin → Settings → Keys](https://login.tailscale.com/admin/settings/keys)
2. Add to `.env`:
   ```
   TS_AUTHKEY=tskey-auth-xxxxx
   ```
3. Restart the container: `make down && make up`
4. Connect via your Tailscale IP:
   ```bash
   ssh -p 2222 claude@<tailscale-ip>
   ```

**Networking mode:** The container auto-detects TUN device availability at startup:
- **Kernel TUN mode** (default with `docker-compose.yml`): Transparent routing — all apps can reach Tailscale peers without any proxy configuration. Requires `cap_add: NET_ADMIN` and `/dev/net/tun` device (both provided in `docker-compose.yml`).
- **Userspace fallback** (no TUN device): Apps must use the SOCKS5 proxy at `localhost:1055` explicitly. A `TAILSCALE_PROXY` variable is written to `/etc/profile.d/tailscale-proxy.sh` for convenience, but is **not exported** to avoid breaking general internet connectivity. Use per-command: `ALL_PROXY=socks5h://localhost:1055 curl http://tailscale-peer/...`

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAUDE_USER_PASSWORD` | SSH password for `claude` user | `changeme` |
| `TTYD_USERNAME` | Web terminal username | `claude` |
| `TTYD_PASSWORD` | Web terminal password | `changeme` |
| `TS_AUTHKEY` | Tailscale auth key (enables VPN) | _(disabled)_ |
| `TS_HOSTNAME` | Tailscale node name | `claude-box` |
| `DOTFILES_REPO` | Git URL for dotfiles repo | _(disabled)_ |
| `API_PASSWORD` | API server + Web UI password | `changeme` |
| `DOTFILES_BRANCH` | Branch to checkout | _(default)_ |

## Authentication

Claude Box uses the interactive login flow. After starting the container, run `claude` and follow the login link to authenticate with your Claude account. Credentials are stored in `~/.claude/` which is backed by the `claude-config` Docker volume, so they persist across container restarts.

## MCP Server Configuration

MCP servers configured inside the container persist across restarts via the `claude-config` volume:

```bash
# SSH in and add an MCP server
ssh -p 2222 claude@localhost
claude mcp add my-server -- npx some-mcp-server
```

The configuration is stored in `~/.claude/` which is backed by a Docker volume.

## Dotfiles (Optional)

Automatically clone and install your dotfiles on first boot. Set `DOTFILES_REPO` in your `.env`:

```
DOTFILES_REPO=https://github.com/youruser/dotfiles.git
```

On first boot, the repo is cloned to `~/dotfiles`. If an install script (`install.sh`, `setup.sh`, or `bootstrap.sh`) is found, it runs automatically. Otherwise, if a `Makefile` is present, `make` is run.

Dotfiles persist across container restarts via the `claude-home` volume.

## Volumes

| Volume | Container Path | Purpose |
|--------|---------------|---------|
| `claude-config` | `/home/claude/.claude` | Claude settings, MCP config |
| `workspace` | `/home/claude/workspace` | Project files |
| `docker-data` | `/var/lib/docker` | Docker images, containers, layers |

## Make Targets

| Target | Description |
|--------|-------------|
| `make build` | Build the Docker image |
| `make up` | Start the container |
| `make down` | Stop the container |
| `make logs` | Follow container logs |
| `make shell` | Open a shell in the container |
| `make ssh` | SSH into the container |
| `make mosh` | Connect via mosh (resilient mobile shell) |
| `make clean` | Stop container, remove volumes and image |
| `make docker-test` | Run hello-world inside the container (DinD smoke test) |

## Security Notes

- Change all default passwords in `.env` before exposing to a network
- The `.env` file is excluded from git via `.gitignore`
- SSH root login is disabled
- For remote access, use SSH tunneling or put behind a reverse proxy with TLS
- The `claude` user has passwordless sudo inside the container

## Backup and Restore

```bash
# Backup Claude config
docker run --rm -v claude-box_claude-config:/data -v $(pwd):/backup alpine \
    tar czf /backup/claude-config-backup.tar.gz -C /data .

# Restore
docker run --rm -v claude-box_claude-config:/data -v $(pwd):/backup alpine \
    tar xzf /backup/claude-config-backup.tar.gz -C /data
```

## Docker-in-Docker

Claude Box includes Docker Engine inside the container. With [Sysbox](https://github.com/nestybox/sysbox) installed on the host, agents can build and run Docker containers securely without `--privileged`.

**Prerequisites:** Sysbox must be installed on the Docker host. See the [Sysbox installation guide](https://github.com/nestybox/sysbox/blob/master/docs/user-guide/install-package.md).

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
│            claude-box container (sysbox-runc)            │
│                                                          │
│  ┌────────┐ ┌─────────┐ ┌───────┐ ┌──────┐ ┌──────────┐ │
│  │  api   │ │  sshd   │ │ ttyd  │ │dockerd│ │tailscaled│ │
│  │ :8080  │ │  :2222  │ │ :7681 │ │ DinD  │ │(opt-in)  │ │
│  └────┬───┘ └────┬────┘ └───┬───┘ └───┬──┘ └────┬─────┘ │
│       └──────┬───┘──────────┘─────────┘──────────┘       │
│           Claude Code CLI                                │
│       Node.js 20 · Python 3 (MCP)                       │
│                                                          │
│  Volumes:                                                │
│   ~/.claude/     → claude-config vol                     │
│   ~/workspace/   → workspace vol                         │
│   /var/lib/docker → docker-data vol                      │
└──────────────────────────────────────────────────────────┘
```

Process supervision by [s6-overlay](https://github.com/just-containers/s6-overlay). Web terminal by [ttyd](https://github.com/tsl0922/ttyd).
