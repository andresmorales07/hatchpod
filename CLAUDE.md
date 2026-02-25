# Hatchpod - Project Guide

## Overview

Hatchpod is a Dockerized Claude Code environment with multi-machine access via SSH (port 2222) and a web terminal (port 7681, ttyd). It uses s6-overlay for process supervision and supports Docker-in-Docker via Sysbox runtime for secure container builds inside the sandbox.

## Architecture Overview

The container is built on Debian bookworm-slim and layers in three main subsystems:

1. **Process supervision (s6-overlay v3)** — the container entrypoint is `/init`, which boots the s6 service tree. Services are declared under `rootfs/etc/s6-overlay/s6-rc.d/`:
   - `init` (oneshot) — generates SSH host keys, sets the `hatchpod` user password, fixes volume ownership.
   - `sshd` (longrun) — OpenSSH daemon on port 2222.
   - `ttyd` (longrun) — web terminal on port 7681 (basic-auth via `TTYD_USERNAME`/`TTYD_PASSWORD`).
   - `dockerd` (longrun) — Docker daemon for DinD (requires Sysbox runtime on host).
   - `api` (longrun) — REST + WebSocket API server on port 8080, serves React web UI. Uses a provider abstraction layer (`server/src/providers/`) so the SDK is isolated behind a `ProviderAdapter` interface — only `claude-adapter.ts` imports from `@anthropic-ai/claude-agent-sdk`.
   - `user` (bundle) — depends on all of the above; ensures correct startup order.

2. **Claude Code** — installed via the native installer (`curl -fsSL https://claude.ai/install.sh | bash`) as the `hatchpod` user, with a symlink at `/usr/local/bin/claude`. Users authenticate interactively via `claude` (login link flow); credentials persist in the `home` volume. Node.js 20 LTS is included for MCP server support. Python 3, uv, and uvx are included for Python-based MCP servers.

3. **Networking** — four exposed ports:
   - `2222` — SSH access (`ssh -p 2222 hatchpod@<host>`)
   - `7681` — ttyd web terminal (`http://<host>:7681`)
   - `8080` — API server + web UI (`http://<host>:8080`)
   - `60000-60003/udp` — mosh (Mobile Shell) for resilient remote access

4. **Tailscale VPN (optional)** — when `TS_AUTHKEY` is set, `tailscaled` auto-detects TUN device availability. With `/dev/net/tun` and `NET_ADMIN` (provided by `docker-compose.yml`), it uses kernel TUN mode for transparent routing — apps reach Tailscale peers without proxy config. Without TUN, it falls back to userspace networking and sets `TAILSCALE_PROXY` (not exported) in `/etc/profile.d/tailscale-proxy.sh` for opt-in use. State is persisted under `~/.tailscale/` in the `home` volume.

Two Docker volumes persist state across container restarts:
- `home` → `/home/hatchpod` (Claude config, workspace, npm globals, GPG keys, etc.)
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
├── .claude/
│   ├── settings.json       # Hooks (TypeScript type-check on edit)
│   ├── skills/
│   │   ├── build-and-test/SKILL.md  # /build-and-test — rebuild dist, vitest, stage
│   │   ├── dev-server/SKILL.md      # /dev-server — Vite dev server + API server
│   │   ├── docker-e2e/SKILL.md      # /docker-e2e — Docker build + Playwright e2e
│   │   └── release/SKILL.md         # /release — bump version, rebuild, commit, tag, push
│   └── agents/
│       ├── security-reviewer.md     # Auth, path traversal, container security review
│       └── ui-reviewer.md           # Accessibility, UX, React patterns review
├── .github/workflows/
│   ├── ci.yml              # Build + healthcheck CI
│   ├── playwright.yml      # Playwright test CI
│   └── security.yml        # Security scanning (Hadolint, npm audit, Gitleaks, Trivy)
├── tests/                  # Playwright e2e tests
│   ├── ttyd.spec.ts        # ttyd web terminal tests
│   ├── api.spec.ts         # API endpoint tests (healthz, auth, sessions, browse)
│   ├── web-ui.spec.ts      # Web UI login/auth tests
│   ├── ws.spec.ts          # WebSocket connection tests
│   ├── static.spec.ts      # Static file serving tests
│   └── session-delivery.spec.ts # Session message delivery pipeline (requires ENABLE_TEST_PROVIDER=1)
├── docs/plans/             # Design docs and implementation plans
├── server/                 # API server + web UI
│   ├── package.json        # Server dependencies
│   ├── tsconfig.json       # Server TypeScript config
│   ├── src/                # Server source (TypeScript)
│   │   ├── index.ts        # Entry point: HTTP + WS server
│   │   ├── auth.ts         # Bearer token auth, rate limiting (API_PASSWORD, TRUST_PROXY)
│   │   ├── session-history.ts # CLI session history reader
│   │   ├── session-watcher.ts # Central message router (push/poll/idle modes → WS)
│   │   ├── sessions.ts     # Session manager (provider-agnostic)
│   │   ├── routes.ts       # REST route handlers (sessions, browse, history, OpenAPI docs)
│   │   ├── ws.ts           # WebSocket handler
│   │   ├── types.ts        # Shared TypeScript interfaces (re-exports serializable types from schemas/)
│   │   ├── task-extractor.ts  # Server-side task extraction from messages
│   │   ├── schemas/        # Zod schemas — single source of truth for API types + validation
│   │   │   ├── common.ts   # Shared primitives (UuidSchema, ErrorResponseSchema, isPathContained)
│   │   │   ├── providers.ts # Message parts, NormalizedMessage, tasks, session listing
│   │   │   ├── sessions.ts # SessionStatus, CreateSessionRequest, SessionSummaryDTO
│   │   │   ├── browse.ts   # BrowseResponse
│   │   │   ├── config.ts   # ConfigResponse, ProviderInfo
│   │   │   ├── health.ts   # HealthResponse
│   │   │   ├── registry.ts # OpenAPI 3.1 document assembly (all paths + security)
│   │   │   └── index.ts    # Barrel export of all schemas and inferred types
│   │   └── providers/      # Provider abstraction layer
│   │       ├── types.ts    # Re-exports serializable types from schemas/; ProviderAdapter interface
│   │       ├── claude-adapter.ts  # Claude SDK adapter (sole SDK import)
│   │       ├── test-adapter.ts    # Test/mock adapter for development
│   │       ├── message-cleanup.ts # Message text cleanup utilities
│   │       ├── tool-summary.ts    # Tool summary extraction from messages
│   │       └── index.ts    # Provider registry
│   └── ui/                 # React web UI (Vite + Tailwind CSS v4 + shadcn/ui)
│       ├── package.json    # UI dependencies
│       ├── components.json # shadcn/ui config (new-york style, neutral base)
│       ├── vite.config.ts  # Vite config (builds to ../public/, @/ path alias)
│       └── src/
│           ├── main.tsx            # React entry point
│           ├── App.tsx             # Router and auth gate
│           ├── globals.css         # Tailwind imports + shadcn theme tokens (dark theme)
│           ├── lib/
│           │   ├── utils.ts        # cn() class merge utility (tailwind-merge + clsx)
│           │   ├── sessions.ts     # Session API helpers
│           │   └── syntax.ts       # Shared PrismLight language registration
│           ├── hooks/
│           │   ├── useMediaQuery.ts # Responsive breakpoint hook
│           │   └── useSwipe.ts     # Touch swipe gesture hook
│           ├── pages/              # Page-level components
│           │   ├── ChatPage.tsx         # Active chat session view
│           │   ├── LoginPage.tsx        # Authentication page
│           │   ├── NewSessionPage.tsx   # New session creation
│           │   └── SessionListPage.tsx  # Session list/history view
│           ├── stores/             # State management
│           │   ├── auth.ts         # Auth state
│           │   ├── messages.ts     # Message/WebSocket state
│           │   └── sessions.ts     # Session list state
│           └── components/
│               ├── AppShell.tsx             # Layout shell (sidebar + content)
│               ├── Composer.tsx             # Message input composer
│               ├── MessageBubble.tsx        # Message rendering
│               ├── Markdown.tsx             # Markdown rendering (react-markdown + PrismLight)
│               ├── ToolApproval.tsx         # Tool approval UI
│               ├── FolderPicker.tsx         # Breadcrumb folder picker
│               ├── SessionCard.tsx          # Session list item card
│               ├── Sidebar.tsx              # Navigation sidebar
│               ├── SlashCommandDropdown.tsx # Slash command autocomplete
│               ├── FileDiffCard.tsx         # Syntax-highlighted file diffs for Write/Edit
│               ├── TaskList.tsx             # Persistent task list display
│               ├── ThinkingIndicator.tsx    # Animated thinking spinner
│               ├── WorkspaceFilter.tsx      # Workspace filter dropdown
│               └── ui/                      # shadcn/ui primitives
│                   ├── badge.tsx
│                   ├── button.tsx
│                   ├── card.tsx
│                   ├── dialog.tsx
│                   ├── input.tsx
│                   ├── scroll-area.tsx
│                   └── tooltip.tsx
├── server/tests/               # Vitest unit tests (24 test files + helpers.ts)
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
make shell    # Exec into the running container as `hatchpod` user
make ssh      # SSH into the container (port 2222)
make mosh     # Connect via mosh (resilient mobile shell, port 2222 + UDP 60000-60003)
make logs     # Tail container logs (s6 + services)

# Inside the container
claude        # Launch Claude Code CLI
```

## Sysbox Runtime Detection

The `docker-compose.yml` specifies `runtime: sysbox-runc`, which is only available on the Docker host — not inside a Sysbox container. When building or running hatchpod from inside an existing Sysbox container (i.e., when Claude Code is running inside hatchpod itself), you must override the runtime to avoid `unknown or invalid runtime name` errors:

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

- **Claude Code** — users authenticate interactively by running `claude` inside the container and following the login link. Credentials are stored in `~/.claude/` which is backed by the `home` Docker volume, so they persist across container restarts.
- **API server** — the REST API and web UI require a bearer token set via the `API_PASSWORD` environment variable. The web UI prompts for it on the login page; API clients pass it as `Authorization: Bearer <password>`. Failed auth attempts are rate-limited per IP (10 attempts / 15 min sliding window). Additional security env vars:
  - `TRUST_PROXY=1` — trust `X-Forwarded-For` header for client IP resolution (required when behind a reverse proxy; without this, the rate limiter uses `req.socket.remoteAddress`)
  - `ALLOW_BYPASS_PERMISSIONS=1` — allow sessions to use `bypassPermissions` mode (disabled by default for safety)

## Standalone Usage (without Docker)

The `server/` directory is a publishable npm package. Users with Claude Code installed locally can run:

```bash
npx hatchpod-api --password mysecret
```

This starts the API server and web UI on `http://localhost:8080`. The `--root` flag sets the file browser root (defaults to cwd). See `npx hatchpod-api --help` for all options.

The container sets `BROWSE_ROOT` and `DEFAULT_CWD` env vars explicitly to `/home/hatchpod/workspace`. When running standalone, these default to `process.cwd()`.

## UI Development Workflow

**When modifying `server/ui/src/` files, use the Vite dev server instead of rebuilding `server/public/`.** The production build pipeline (`vite build` → `server/public/`) plus the PWA service worker causes stale cached assets that require hard-refresh and cache clearing. The Vite dev server avoids this entirely with hot module replacement.

```bash
# Terminal 1: API server (backend)
cd server && API_PASSWORD=<password> npm start

# Terminal 2: Vite dev server (frontend with HMR)
cd server/ui && npm run dev
```

Open `http://localhost:5173` (NOT port 8080). UI changes hot-reload instantly — no build step, no cache clearing. The Vite proxy forwards `/api`, `/ws` (WebSocket), and `/healthz` to the API server on port 8080.

**When to rebuild:** Only rebuild `server/dist/` when `server/src/` (backend TypeScript) changes. Only rebuild `server/public/` before committing (use `/build-and-test` skill).

### Developing Inside Hatchpod Itself

When Claude Code runs inside the hatchpod container, the s6-managed API server is already running on port 8080 with its own `API_PASSWORD` (inherited from the container environment). To test changes to `server/src/` or `server/ui/src/` without interfering with the production server:

```bash
# Detect: check if s6 API server is already on port 8080
curl -s http://localhost:8080/healthz | grep -q '"status":"ok"'

# Start a separate API server on a different port with a known password
cd server && npm run build && API_PASSWORD=test PORT=9080 node dist/index.js &

# Open http://localhost:9080 to test (password: "test")
# Or use Vite dev server pointed at the test API:
cd server/ui && VITE_API_PORT=9080 npx vite --host &
```

The test server on port 9080 can serve CLI session history and test-provider sessions, but **cannot run Claude sessions** (it lacks the Claude API credentials that the s6-managed server inherits from the container environment). To test live Claude sessions, use the s6-managed server on port 8080.

## Key Conventions

- Feature branches must use the `feature/<branch-name>` naming convention
- Version tags follow SemVer with a `v` prefix: `v<major>.<minor>.<patch>`. Bump MAJOR for breaking changes, MINOR for new features, PATCH for bug fixes. Use the `/release` skill to cut a release — it handles the full sequence: bumping `server/package.json` and `server/package-lock.json`, rebuilding dist, committing, tagging, and pushing.
- Container runs as `hatchpod` user (uid 1000) with passwordless sudo
- Two Docker volumes: `home` (/home/hatchpod) and `docker-data` (/var/lib/docker)
- s6-overlay v3 service types: `oneshot` for init, `longrun` for sshd/ttyd, `bundle` for user
- `S6_KEEP_ENV=1` ensures environment variables propagate to all services
- When adding or removing software from the Dockerfile, update the "What's Included" table in README.md to match
- Tailscale and dotfiles are opt-in features controlled by env vars (`TS_AUTHKEY`, `DOTFILES_REPO`)
- `docker-compose.yml` includes `cap_add: NET_ADMIN` and `/dev/net/tun` device for Tailscale kernel TUN mode; harmless when Tailscale is not enabled
- The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) must only be imported in `server/src/providers/claude-adapter.ts`. All other server and UI code uses the normalized `NormalizedMessage` / `ProviderAdapter` types from `providers/types.ts`. The WebSocket protocol sends `{ type: "message" }` events with normalized payloads.
- **SDK live stream sidechain filtering** — the SDK streams subagent-internal messages (prompt, tool calls, tool results) into the parent session iterator with `parent_tool_use_id != null`. These must be filtered in `normalizeMessage` before the type switch — they are never written to the parent JSONL (only to `/subagents/agent-<id>.jsonl`), so dropping them keeps the live stream consistent with history replay. The JSONL equivalent field is `isSidechain: true`.
- **Zod schemas are the single source of truth** for all serializable API types. Define new request/response types in `server/src/schemas/`, then re-export the `z.infer<>` types from `providers/types.ts` or `types.ts`. Non-serializable types (containing functions, AbortController, Set, callbacks) stay as manual interfaces. Register new endpoints in `schemas/registry.ts` to keep the OpenAPI spec in sync.
- **API docs** are served at `/api/docs` (Scalar UI, CDN) and `/api/openapi.json` (OpenAPI 3.1 spec). Both are unauthenticated, like `/healthz`.
- `server/dist/` is tracked in git. After modifying any file under `server/src/`, rebuild with `cd server && npm run build` and commit the updated `server/dist/` files alongside the source changes.
- **Claude adapter unit testing** — To test `claude-adapter.ts` without the real SDK, use `vi.mock("@anthropic-ai/claude-agent-sdk")` and return a mock `query()` that yields an async iterable of synthetic SDK messages. See `server/tests/claude-adapter-thinking.test.ts` for the pattern.
- **ESLint** is configured in both `server/` and `server/ui/` using ESLint v9 flat config with typescript-eslint. Run `npm run lint` to check and `npm run lint:fix` to auto-fix. The UI config includes `eslint-plugin-react-hooks` and `eslint-plugin-react-refresh`.
- **SessionWatcher is the single message authority** — All messages flow through `SessionWatcher` via `pushMessage()` (stores + broadcasts) or `pushEvent()` (broadcasts only, ephemeral). `runSession()` sets mode to `"push"` and pushes messages into the watcher; it never broadcasts directly to WebSocket clients. New subscribers default to `"poll"` mode for CLI/history live updates; `runSession()` overrides to `"push"` immediately. Do not introduce alternate delivery paths.
- **Thinking delta buffering** — `WatchedSession.pendingThinkingText` accumulates thinking text from `pushEvent()` thinking_delta events. Late-connecting WS subscribers receive the buffered text in `subscribe()`, sent before `replay_complete` to maintain correct event ordering. The buffer is cleared when: (1) `pushMessage()` receives an assistant message with a `reasoning` part, or (2) a terminal status event (completed/error/interrupted) arrives via `pushEvent()`. Assistant messages without a reasoning part do NOT clear the buffer. `subscribe()` snapshots the buffer before any `await` to prevent race conditions with concurrent `pushMessage()` calls.
- **Future-proof implementations over workarounds** — Always prefer the architecturally correct, future-proof approach even when it's more complex. Do not suggest a simpler workaround just because the proper solution requires more effort. This project has zero users, so breaking changes are free — leverage this to iterate toward the right architecture without backwards-compatibility constraints.

## Testing Strategy

### Automated tests (Playwright)

Playwright e2e tests cover the ttyd terminal, API endpoints, web UI, WebSocket connections, static file serving, and session message delivery. The config (`playwright.config.ts`) defines eight test projects:

- `ttyd-chromium` → `http://localhost:7681` (basic-auth)
- `ttyd-firefox` → `http://localhost:7681` (basic-auth)
- `api` → `http://localhost:8080` (bearer token)
- `web-ui` → `http://localhost:8080` (browser)
- `web-ui-firefox` → `http://localhost:8080` (browser)
- `ws` → `http://localhost:8080` (WebSocket)
- `static` → `http://localhost:8080` (static files)
- `session-delivery` → `http://localhost:8080` (test provider, requires `ENABLE_TEST_PROVIDER=1`)

Ports are configurable via `TTYD_PORT` and `API_PORT` env vars (default to 7681/8080). When running tests inside hatchpod itself, use offset ports to avoid conflicts with the host services (e.g., `TTYD_PORT=17681 API_PORT=18080`).

**Important:** Always run tests by building and running the Docker container first — do not run them against an externally running instance. The tests depend on the container's ttyd configuration (writable mode, auth credentials, ping interval).

```bash
# 1. Build and run the container (use offset ports when running inside hatchpod)
docker build -t hatchpod:latest .
docker run -d --name hatchpod-test \
  -p 17681:7681 -p 12222:2222 -p 18080:8080 \
  -e TTYD_USERNAME=hatchpod \
  -e TTYD_PASSWORD=changeme \
  -e API_PASSWORD=changeme \
  -e ENABLE_TEST_PROVIDER=1 \
  hatchpod:latest

# 2. Run tests (pass offset ports via env vars)
npm install
TTYD_PORT=17681 API_PORT=18080 npx playwright test

# 3. Clean up
docker rm -f hatchpod-test
```

### Test files

- **`tests/ttyd.spec.ts`** — ttyd web terminal: loads xterm.js, renders, accepts input, WebSocket stays alive, auth challenge
- **`tests/api.spec.ts`** — REST API: healthz, auth, session CRUD, browse endpoint (directory listing, path traversal rejection, auth)
- **`tests/web-ui.spec.ts`** — Web UI: login page rendering, authentication flow
- **`tests/ws.spec.ts`** — WebSocket: connection lifecycle, message exchange
- **`tests/static.spec.ts`** — Static file serving: index.html, assets, SPA fallback
- **`tests/session-delivery.spec.ts`** — Session message delivery pipeline: push-mode flow, lifecycle transitions, follow-up messages, reconnect replay, multi-client broadcast, session ID remap, interrupt, tool approval, thinking deltas, slash commands. Requires `ENABLE_TEST_PROVIDER=1`

### Manual verification

1. **Build** — `make build` must complete without errors.
2. **Startup** — `make up` then `docker compose ps` should show the container as healthy (healthcheck curls `http://localhost:7681`).
3. **SSH access** — `make ssh` (or `ssh -p 2222 hatchpod@localhost`) should connect and drop into a bash shell.
4. **Mosh access** — `make mosh` (or `mosh --ssh='ssh -p 2222' hatchpod@localhost`) should connect and drop into a bash shell. Verify the session survives a brief network interruption (e.g., sleep/wake laptop).
5. **Web terminal** — open `http://localhost:7681` in a browser, authenticate with `TTYD_USERNAME`/`TTYD_PASSWORD`.
6. **Claude Code** — run `claude` inside the container and follow the login link to authenticate.
7. **Volume persistence** — `make down && make up`, then verify files in `~/workspace` and `~/.claude` survived the restart.
8. **Docker-in-Docker** — `make docker-test` runs `docker run hello-world` inside the container (requires Sysbox on host).
9. **CI** — GitHub Actions runs `docker compose build` and verifies the image starts and passes its healthcheck. Note: Sysbox is not available in CI, so dockerd will not start there.
10. **Tailscale VPN** — set `TS_AUTHKEY` in `.env`, restart, verify `tailscale status` shows the node connected to the tailnet.
11. **Dotfiles** — set `DOTFILES_REPO` in `.env`, start a fresh container (no existing `home` volume), verify `~/dotfiles` is cloned and install script was run.

## Agent Workflow Conventions

- **Always check for relevant skills and MCP servers** before planning or implementing features. Use the `Skill` tool to invoke skills (e.g., `brainstorming` before design work, `writing-plans` before implementation, `frontend-design` for UI work, `systematic-debugging` for bug fixes).
- **Use Context7 MCP** (`mcp__plugin_context7_context7__resolve-library-id` and `query-docs`) for up-to-date library documentation instead of relying on web searches or cached knowledge.
- **Use Serena MCP** for semantic code exploration (symbol overview, find references) when navigating the codebase efficiently.
- **Use the `frontend-design` skill** (invoke via `Skill` tool) whenever creating or modifying UI components, pages, or layouts in `server/ui/src/` (web UI) or any mobile app directory. This applies to visual changes, new screens, component redesigns, and responsive layout work — not backend-only API changes.
- **Follow the brainstorming → writing-plans → implementation pipeline** for any non-trivial feature work. Design docs go in `docs/plans/YYYY-MM-DD-<topic>-design.md`.

### Skills

User-invokable skills in `.claude/skills/`:

- **`/dev-server`** — Start the Vite dev server + API server for UI development. Use this instead of rebuilding `server/public/` when working on UI files.
- **`/build-and-test`** — After modifying `server/src/` files: rebuilds `server/dist/` via `npm run build`, runs vitest unit tests, and stages the rebuilt dist files. Stops on failure.
- **`/docker-e2e`** — Full e2e test cycle: builds Docker image, starts a container on offset ports (17681/12222/18080), waits for healthy, runs Playwright tests, and cleans up. Safe to run inside hatchpod itself.
- **`/release`** — Cut a release: asks for bump type (patch/minor/major), updates version, rebuilds dist, runs tests, commits, tags, and pushes. Use instead of doing version tags manually.

### Subagents

Specialized review agents in `.claude/agents/`:

- **`security-reviewer`** — Reviews auth (bearer token, WebSocket, SSH, ttyd), path traversal (browse endpoint, session cwd), container security (Dockerfile, s6 scripts), and info disclosure. Reports findings with severity and file:line references.
- **`ui-reviewer`** — Reviews the React frontend for WCAG 2.1 AA accessibility (keyboard nav, ARIA, contrast), UX states (loading, error, empty), responsive layout, and React patterns (effect cleanup, re-renders, stale closures).

### Hooks

Configured in `.claude/settings.json`:

- **TypeScript type-check + ESLint** (PostToolUse) — Runs `tsc --noEmit` followed by `eslint` after any Edit/Write to files under `server/src/` or `server/ui/src/`. Catches type errors and lint issues immediately after edits. ESLint only runs if type-checking passes.
