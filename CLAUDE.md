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
   - `api` (longrun) — REST + WebSocket API server on port 8080, serves React web UI. Uses a provider abstraction layer (`server/src/providers/`) so the SDK is isolated behind a `ProviderAdapter` interface — only `claude-adapter.ts` imports from `@anthropic-ai/claude-agent-sdk`.
   - `user` (bundle) — depends on all of the above; ensures correct startup order.

2. **Claude Code** — installed via the native installer (`curl -fsSL https://claude.ai/install.sh | bash`) as the `claude` user, with a symlink at `/usr/local/bin/claude`. Users authenticate interactively via `claude` (login link flow); credentials persist in the `claude-home` volume. Node.js 20 LTS is included for MCP server support. Python 3, uv, and uvx are included for Python-based MCP servers.

3. **Networking** — four exposed ports:
   - `2222` — SSH access (`ssh -p 2222 claude@<host>`)
   - `7681` — ttyd web terminal (`http://<host>:7681`)
   - `8080` — API server + web UI (`http://<host>:8080`)
   - `60000-60003/udp` — mosh (Mobile Shell) for resilient remote access

4. **Tailscale VPN (optional)** — when `TS_AUTHKEY` is set, `tailscaled` auto-detects TUN device availability. With `/dev/net/tun` and `NET_ADMIN` (provided by `docker-compose.yml`), it uses kernel TUN mode for transparent routing — apps reach Tailscale peers without proxy config. Without TUN, it falls back to userspace networking and sets `TAILSCALE_PROXY` (not exported) in `/etc/profile.d/tailscale-proxy.sh` for opt-in use. State is persisted under `~/.tailscale/` in the `claude-home` volume.

Two Docker volumes persist state across container restarts:
- `claude-home` → `/home/claude` (Claude config, workspace, npm globals, GPG keys, etc.)
- `docker-data` → `/var/lib/docker` (Docker images, containers, layers)

## Project Structure

```
├── Dockerfile              # Debian bookworm-slim, Node.js 20, Docker Engine, s6-overlay, ttyd, Claude Code
├── docker-compose.yml      # Service definition (pulls from GHCR), volumes, env vars
├── Makefile                # build, up, down, logs, shell, ssh, clean
├── .env.example            # Template for SSH, ttyd, and API passwords
├── LICENSE
├── package.json            # Dev dependency: @playwright/test
├── playwright.config.ts    # Playwright config (Chromium only)
├── .github/workflows/
│   ├── ci.yml              # Build + healthcheck CI
│   └── playwright.yml      # Playwright test CI
├── tests/                  # Playwright e2e tests
│   ├── ttyd.spec.ts        # ttyd web terminal tests
│   ├── api.spec.ts         # API endpoint tests (healthz, auth, sessions, browse)
│   ├── web-ui.spec.ts      # Web UI login/auth tests
│   ├── ws.spec.ts          # WebSocket connection tests
│   └── static.spec.ts      # Static file serving tests
├── docs/plans/             # Design docs and implementation plans
├── server/                 # API server + web UI
│   ├── package.json        # Server dependencies
│   ├── tsconfig.json       # Server TypeScript config
│   ├── src/                # Server source (TypeScript)
│   │   ├── index.ts        # Entry point: HTTP + WS server
│   │   ├── auth.ts         # Bearer token auth (API_PASSWORD)
│   │   ├── sessions.ts     # Session manager (provider-agnostic)
│   │   ├── routes.ts       # REST route handlers (sessions, browse)
│   │   ├── ws.ts           # WebSocket handler
│   │   ├── types.ts        # Shared TypeScript interfaces
│   │   └── providers/      # Provider abstraction layer
│   │       ├── types.ts    # NormalizedMessage, ProviderAdapter interface
│   │       ├── claude-adapter.ts  # Claude SDK adapter (sole SDK import)
│   │       └── index.ts    # Provider registry
│   └── ui/                 # React web UI (Vite)
│       ├── package.json    # UI dependencies
│       ├── vite.config.ts  # Vite config (builds to ../public/)
│       └── src/
│           ├── main.tsx            # React entry point
│           ├── App.tsx             # App shell, login, sidebar layout
│           ├── styles.css          # All styles (dark theme)
│           ├── types.ts            # UI-side normalized message types
│           ├── hooks/
│           │   └── useSession.ts   # WebSocket session hook
│           └── components/
│               ├── SessionList.tsx  # Session list + new session form
│               ├── ChatView.tsx     # Chat message view
│               ├── MessageBubble.tsx # Message rendering
│               ├── ToolApproval.tsx  # Tool approval UI
│               └── FolderPicker.tsx  # Breadcrumb folder picker
└── rootfs/                 # Files copied into the container at /
    └── etc/
        ├── ssh/sshd_config
        ├── skel/
        │   ├── .bashrc             # Default shell config
        │   └── .tmux.conf          # tmux config (mosh scrollback)
        └── s6-overlay/
            ├── scripts/init.sh          # Oneshot: SSH keys, user password, volume ownership, dotfiles
            ├── scripts/tailscaled-up.sh # Oneshot: authenticate with tailnet
            └── s6-rc.d/
                ├── init/                # Oneshot service (runs init.sh)
                ├── sshd/                # Long-running SSH daemon
                ├── ttyd/                # Long-running web terminal
                ├── dockerd/             # Long-running Docker daemon (DinD)
                ├── api/                 # Long-running API server
                ├── tailscaled/          # Long-running Tailscale daemon (opt-in)
                ├── tailscaled-up/       # Oneshot: authenticate with tailnet
                └── user/                # Bundle: init + sshd + ttyd + dockerd + api + tailscaled-up
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
make mosh     # Connect via mosh (resilient mobile shell, port 2222 + UDP 60000-60003)
make logs     # Tail container logs (s6 + services)

# Inside the container
claude        # Launch Claude Code CLI
```

## Sysbox Runtime Detection

The `docker-compose.yml` specifies `runtime: sysbox-runc`, which is only available on the Docker host — not inside a Sysbox container. When building or running claude-box from inside an existing Sysbox container (i.e., when Claude Code is running inside claude-box itself), you must override the runtime to avoid `unknown or invalid runtime name` errors:

```bash
# Check if running inside a Sysbox container (sysboxfs FUSE mounts are the reliable indicator)
if mount | grep -q sysboxfs 2>/dev/null; then
  # Inside Sysbox — sysbox-runc runtime is not available here, override to default runc
  docker compose build
  docker compose up -d --runtime runc
else
  # On a host with Sysbox installed — use docker-compose.yml as-is
  make build && make up
fi
```

Note: Without Sysbox, Docker-in-Docker will not work inside the nested container (dockerd requires Sysbox's enhanced isolation). SSH, ttyd, and Claude Code will function normally.

## Authentication

- **Claude Code** — users authenticate interactively by running `claude` inside the container and following the login link. Credentials are stored in `~/.claude/` which is backed by the `claude-home` Docker volume, so they persist across container restarts.
- **API server** — the REST API and web UI require a bearer token set via the `API_PASSWORD` environment variable. The web UI prompts for it on the login page; API clients pass it as `Authorization: Bearer <password>`.

## Key Conventions

- Feature branches must use the `feature/<branch-name>` naming convention
- Version tags follow SemVer with a `v` prefix: `v<major>.<minor>.<patch>`. Bump MAJOR for breaking changes, MINOR for new features, PATCH for bug fixes.
- Container runs as `claude` user (uid 1000) with passwordless sudo
- Two Docker volumes: `claude-home` (/home/claude) and `docker-data` (/var/lib/docker)
- s6-overlay v3 service types: `oneshot` for init, `longrun` for sshd/ttyd, `bundle` for user
- `S6_KEEP_ENV=1` ensures environment variables propagate to all services
- When adding or removing software from the Dockerfile, update the "What's Included" table in README.md to match
- Tailscale and dotfiles are opt-in features controlled by env vars (`TS_AUTHKEY`, `DOTFILES_REPO`)
- `docker-compose.yml` includes `cap_add: NET_ADMIN` and `/dev/net/tun` device for Tailscale kernel TUN mode; harmless when Tailscale is not enabled
- The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) must only be imported in `server/src/providers/claude-adapter.ts`. All other server and UI code uses the normalized `NormalizedMessage` / `ProviderAdapter` types from `providers/types.ts`. The WebSocket protocol sends `{ type: "message" }` events with normalized payloads.
- `server/dist/` is tracked in git. After modifying any file under `server/src/`, rebuild with `cd server && npm run build` and commit the updated `server/dist/` files alongside the source changes.

## Testing Strategy

### Automated tests (Playwright)

Playwright e2e tests cover the ttyd terminal, API endpoints, web UI, WebSocket connections, and static file serving. The config (`playwright.config.ts`) runs Chromium only. Five test projects target different services:

- `ttyd-chromium` → `http://localhost:7681` (basic-auth)
- `api` → `http://localhost:8080` (bearer token)
- `web-ui` → `http://localhost:8080` (browser)
- `ws` → `http://localhost:8080` (WebSocket)
- `static` → `http://localhost:8080` (static files)

**Important:** Always run tests by building and running the Docker container first — do not run them against an externally running instance. The tests depend on the container's ttyd configuration (writable mode, auth credentials, ping interval).

```bash
# 1. Build and run the container
docker build -t claude-box:latest .
docker run -d --name claude-box-test \
  -p 7681:7681 -p 2222:2222 -p 8080:8080 \
  -e TTYD_USERNAME=claude \
  -e TTYD_PASSWORD=changeme \
  -e API_PASSWORD=changeme \
  claude-box:latest

# 2. Run tests (credentials must match the container's env vars)
npm install
npx playwright test

# 3. Clean up
docker rm -f claude-box-test
```

### Test files

- **`tests/ttyd.spec.ts`** — ttyd web terminal: loads xterm.js, renders, accepts input, WebSocket stays alive, auth challenge
- **`tests/api.spec.ts`** — REST API: healthz, auth, session CRUD, browse endpoint (directory listing, path traversal rejection, auth)
- **`tests/web-ui.spec.ts`** — Web UI: login page rendering, authentication flow
- **`tests/ws.spec.ts`** — WebSocket: connection lifecycle, message exchange
- **`tests/static.spec.ts`** — Static file serving: index.html, assets, SPA fallback

### Manual verification

1. **Build** — `make build` must complete without errors.
2. **Startup** — `make up` then `docker compose ps` should show the container as healthy (healthcheck curls `http://localhost:7681`).
3. **SSH access** — `make ssh` (or `ssh -p 2222 claude@localhost`) should connect and drop into a bash shell.
4. **Mosh access** — `make mosh` (or `mosh --ssh='ssh -p 2222' claude@localhost`) should connect and drop into a bash shell. Verify the session survives a brief network interruption (e.g., sleep/wake laptop).
5. **Web terminal** — open `http://localhost:7681` in a browser, authenticate with `TTYD_USERNAME`/`TTYD_PASSWORD`.
6. **Claude Code** — run `claude` inside the container and follow the login link to authenticate.
7. **Volume persistence** — `make down && make up`, then verify files in `~/workspace` and `~/.claude` survived the restart.
8. **Docker-in-Docker** — `make docker-test` runs `docker run hello-world` inside the container (requires Sysbox on host).
9. **CI** — GitHub Actions runs `docker compose build` and verifies the image starts and passes its healthcheck. Note: Sysbox is not available in CI, so dockerd will not start there.
10. **Tailscale VPN** — set `TS_AUTHKEY` in `.env`, restart, verify `tailscale status` shows the node connected to the tailnet.
11. **Dotfiles** — set `DOTFILES_REPO` in `.env`, start a fresh container (no existing `claude-home` volume), verify `~/dotfiles` is cloned and install script was run.

## Agent Workflow Conventions

- **Always check for relevant skills and MCP servers** before planning or implementing features. Use the `Skill` tool to invoke skills (e.g., `brainstorming` before design work, `writing-plans` before implementation, `frontend-design` for UI work, `systematic-debugging` for bug fixes).
- **Use Context7 MCP** (`mcp__plugin_context7_context7__resolve-library-id` and `query-docs`) for up-to-date library documentation instead of relying on web searches or cached knowledge.
- **Use Serena MCP** for semantic code exploration (symbol overview, find references) when navigating the codebase efficiently.
- **Follow the brainstorming → writing-plans → implementation pipeline** for any non-trivial feature work. Design docs go in `docs/plans/YYYY-MM-DD-<topic>-design.md`.
