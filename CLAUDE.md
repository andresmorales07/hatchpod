# Claude Box - Project Guide

## Overview

Claude Box is a Dockerized Claude Code environment with multi-machine access via SSH (port 2222) and a web terminal (port 7681, ttyd). It uses s6-overlay for process supervision and supports Docker-in-Docker via Sysbox runtime for secure container builds inside the sandbox.

## Architecture Overview

The container is built on Debian bookworm-slim and layers in three main subsystems:

1. **Process supervision (s6-overlay v3)** — the container entrypoint is `/init`, which boots the s6 service tree. Services are declared under `rootfs/etc/s6-overlay/s6-rc.d/`:
   - `init` (oneshot) — generates SSH host keys, sets the `claude` user password, fixes volume ownership.
   - `sshd` (longrun) — OpenSSH daemon on port 2222.
   - `ttyd` (longrun) — web terminal on port 7681 (basic-auth via `TTYD_USERNAME`/`TTYD_PASSWORD`).
   - `dockerd` (longrun) — Docker daemon for DinD (requires Sysbox runtime on host).
   - `user` (bundle) — depends on all of the above; ensures correct startup order.

2. **Claude Code** — installed via the native installer (`curl -fsSL https://claude.ai/install.sh | bash`) as the `claude` user, with a symlink at `/usr/local/bin/claude`. Users authenticate interactively via `claude` (login link flow); credentials persist in the `claude-config` volume. Node.js 20 LTS is included for MCP server support.

3. **Networking** — two exposed ports:
   - `2222` — SSH access (`ssh -p 2222 claude@<host>`)
   - `7681` — ttyd web terminal (`http://<host>:7681`)

Three Docker volumes persist state across container restarts:
- `claude-config` → `/home/claude/.claude`
- `workspace` → `/home/claude/workspace`
- `docker-data` → `/var/lib/docker` (Docker images, containers, layers)

## Project Structure

```
├── Dockerfile              # Debian bookworm-slim, Node.js 20, Docker Engine, s6-overlay, ttyd, Claude Code
├── docker-compose.yml      # Service definition (pulls from GHCR), volumes, env vars
├── Makefile                # build, up, down, logs, shell, ssh, clean
├── .env.example            # Template for SSH and ttyd passwords
├── package.json            # Dev dependency: @playwright/test
├── playwright.config.ts    # Playwright config (baseURL: localhost:7681, Chromium only)
├── tests/                  # Playwright e2e tests
│   └── ttyd.spec.ts        # ttyd web terminal tests
└── rootfs/                 # Files copied into the container at /
    └── etc/
        ├── ssh/sshd_config
        └── s6-overlay/
            ├── scripts/init.sh          # Oneshot: SSH keys, user password, volume ownership
            └── s6-rc.d/
                ├── init/                # Oneshot service (runs init.sh)
                ├── sshd/                # Long-running SSH daemon
                ├── ttyd/                # Long-running web terminal
                ├── dockerd/             # Long-running Docker daemon (DinD)
                └── user/                # Bundle: init + sshd + ttyd + dockerd
```

## Common Commands

```bash
# Build & lifecycle
make build    # Build the Docker image locally (for development)
make up       # Start the container (detached, pulls from GHCR by default)
make down     # Stop the container
make clean        # Stop, remove volumes and image
make docker-test  # Run hello-world inside the container (DinD smoke test)

# Access
make shell    # Exec into the running container as `claude` user
make ssh      # SSH into the container (port 2222)
make logs     # Tail container logs (s6 + services)

# Inside the container
claude        # Launch Claude Code CLI
```

## Authentication

Users authenticate interactively by running `claude` inside the container and following the login link. Credentials are stored in `~/.claude/` which is backed by the `claude-config` Docker volume, so they persist across container restarts.

## Key Conventions

- Container runs as `claude` user (uid 1000) with passwordless sudo
- Three Docker volumes: `claude-config` (~/.claude), `workspace` (~/workspace), and `docker-data` (/var/lib/docker)
- s6-overlay v3 service types: `oneshot` for init, `longrun` for sshd/ttyd, `bundle` for user
- `S6_KEEP_ENV=1` ensures environment variables propagate to all services

## Testing Strategy

### Automated tests (Playwright)

Playwright e2e tests verify the ttyd web terminal. The config (`playwright.config.ts`) targets `http://localhost:7681` with basic-auth credentials and runs Chromium only.

```bash
# Prerequisites: container must be running (make up / docker build + run)
npm install          # install @playwright/test
npx playwright test  # run all tests
```

Tests in `tests/ttyd.spec.ts`:
- **ttyd web terminal loads** — xterm.js container is visible
- **ttyd terminal has a canvas renderer** — canvas element is rendering
- **ttyd terminal is interactive** — terminal accepts keyboard input (requires `-W` flag)
- **ttyd returns correct auth challenge** — HTTP 200 with valid credentials

### Manual verification

1. **Build** — `make build` must complete without errors.
2. **Startup** — `make up` then `docker compose ps` should show the container as healthy (healthcheck curls `http://localhost:7681`).
3. **SSH access** — `make ssh` (or `ssh -p 2222 claude@localhost`) should connect and drop into a bash shell.
4. **Web terminal** — open `http://localhost:7681` in a browser, authenticate with `TTYD_USERNAME`/`TTYD_PASSWORD`.
5. **Claude Code** — run `claude` inside the container and follow the login link to authenticate.
6. **Volume persistence** — `make down && make up`, then verify files in `~/workspace` and `~/.claude` survived the restart.
7. **Docker-in-Docker** — `make docker-test` runs `docker run hello-world` inside the container (requires Sysbox on host).
8. **CI** — GitHub Actions runs `docker compose build` and verifies the image starts and passes its healthcheck. Note: Sysbox is not available in CI, so dockerd will not start there.
