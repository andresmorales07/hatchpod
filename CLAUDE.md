# Hatchpod - Project Guide

## Overview

Hatchpod is a Dockerized Claude Code environment with multi-machine access via SSH (port 2222) and a web UI (port 8080). It uses s6-overlay for process supervision and supports Docker-in-Docker via Sysbox runtime for secure container builds inside the sandbox.

**North Star: self-hosted Claude Code.** Hatchpod's purpose is specifically to run Claude Code in a containerized, remotely accessible environment — not to be a generic multi-provider coding agent host. The `ProviderAdapter` abstraction exists for testability (enabling `TestAdapter` and the `session-delivery` test suite), not to support other providers. Do not suggest adding opencode, Codex, or other provider adapters as a feature direction.

## Architecture Overview

The container is built on Debian bookworm-slim and layers in three main subsystems:

1. **Process supervision (s6-overlay v3)** — the container entrypoint is `/init`, which boots the s6 service tree. Services are declared under `rootfs/etc/s6-overlay/s6-rc.d/`:
   - `init` (oneshot) — generates SSH host keys, sets the `hatchpod` user password, fixes volume ownership.
   - `sshd` (longrun) — OpenSSH daemon on port 2222.
   - `dockerd` (longrun) — Docker daemon for DinD (requires Sysbox runtime on host).
   - `api` (longrun) — REST + WebSocket API server on port 8080, serves React web UI. Uses a provider abstraction layer (`server/src/providers/`) so the SDK is isolated behind a `ProviderAdapter` interface — only `claude-adapter.ts` imports from `@anthropic-ai/claude-agent-sdk`.
   - `user` (bundle) — depends on all of the above; ensures correct startup order.

2. **Claude Code** — installed via the native installer (`curl -fsSL https://claude.ai/install.sh | bash`) as the `hatchpod` user, with a symlink at `/usr/local/bin/claude`. Users authenticate interactively via `claude` (login link flow); credentials persist in the `home` volume. Node.js 20 LTS is included for MCP server support. Python 3, uv, and uvx are included for Python-based MCP servers.

3. **Networking** — three exposed ports:
   - `2222` — SSH access (`ssh -p 2222 hatchpod@<host>`)
   - `8080` — API server + web UI (`http://<host>:8080`)
   - `60000-60003/udp` — mosh (Mobile Shell) for resilient remote access

4. **Tailscale VPN (optional)** — when `TS_AUTHKEY` is set, `tailscaled` auto-detects TUN device availability. With `/dev/net/tun` and `NET_ADMIN` (provided by `docker-compose.yml`), it uses kernel TUN mode for transparent routing — apps reach Tailscale peers without proxy config. Without TUN, it falls back to userspace networking and sets `TAILSCALE_PROXY` (not exported) in `/etc/profile.d/tailscale-proxy.sh` for opt-in use. State is persisted under `~/.tailscale/` in the `home` volume.

Two Docker volumes persist state across container restarts:
- `home` → `/home/hatchpod` (Claude config, workspace, npm globals, GPG keys, etc.)
- `docker-data` → `/var/lib/docker` (Docker images, containers, layers)

## Project Structure

```
├── Dockerfile              # Debian bookworm-slim, Node.js 20, Docker Engine, s6-overlay, Claude Code
├── docker-compose.yml      # Service definition (pulls from GHCR), volumes, env vars
├── Makefile                # build, up, down, logs, shell, ssh, clean
├── .env.example            # Template for SSH and API passwords
├── LICENSE
├── package.json            # Dev dependency: @playwright/test
├── playwright.config.ts    # Playwright config (Chromium only)
├── .claude/
│   ├── settings.json       # Hooks (TypeScript type-check on edit)
│   ├── skills/
│   │   ├── build-and-test/SKILL.md  # /build-and-test — rebuild dist, vitest
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
│   ├── api.spec.ts         # API endpoint tests (healthz, auth, sessions, browse)
│   ├── web-ui.spec.ts      # Web UI login/auth tests
│   ├── ws.spec.ts          # WebSocket connection tests
│   ├── static.spec.ts      # Static file serving tests
│   ├── terminal.spec.ts    # Embedded terminal WebSocket tests
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
│   │   ├── routes.ts       # REST route handlers (sessions, browse, history, settings, OpenAPI docs)
│   │   ├── ws.ts           # WebSocket handler (chat sessions)
│   │   ├── terminal.ts     # Terminal session manager (pty processes)
│   │   ├── terminal-ws.ts  # WebSocket handler for embedded terminal
│   │   ├── git-status.ts   # Git diff stat computation (GET /api/git/status)
│   │   ├── settings.ts     # Persistent user settings read/write
│   │   ├── version.ts      # SERVER_VERSION constant
│   │   ├── types.ts        # Shared TypeScript interfaces (re-exports serializable types from schemas/)
│   │   ├── task-extractor.ts  # Server-side task extraction from messages
│   │   ├── schemas/        # Zod schemas — single source of truth for API types + validation
│   │   │   ├── common.ts   # Shared primitives (UuidSchema, ErrorResponseSchema, isPathContained)
│   │   │   ├── providers.ts # Message parts, NormalizedMessage, tasks, session listing
│   │   │   ├── sessions.ts # SessionStatus, CreateSessionRequest, SessionSummaryDTO
│   │   │   ├── browse.ts   # BrowseResponse
│   │   │   ├── config.ts   # ConfigResponse, ProviderInfo
│   │   │   ├── health.ts   # HealthResponse
│   │   │   ├── git.ts      # GitDiffStat schema
│   │   │   ├── settings.ts # Settings schema (theme, model, effort, terminal prefs)
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
│           │   ├── SessionListPage.tsx  # Session list/history view
│           │   ├── SettingsPage.tsx     # App settings (theme, model, terminal prefs)
│           │   └── TerminalPage.tsx     # Embedded terminal (xterm.js over WebSocket)
│           ├── stores/             # State management
│           │   ├── auth.ts         # Auth state
│           │   ├── messages.ts     # Message/WebSocket state
│           │   ├── sessions.ts     # Session list state
│           │   └── settings.ts     # Persisted user settings (theme, model, effort, terminal)
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
│               ├── CompactingIndicator.tsx  # Context compaction animation
│               ├── ContextUsageBadge.tsx    # Token context usage indicator
│               ├── GitDiffBar.tsx           # Git diff stat bar (changed files count)
│               ├── MobileNavBar.tsx         # Bottom nav bar for mobile viewports
│               ├── ModelPicker.tsx          # Model/effort selection dropdown
│               ├── SessionInfoSheet.tsx     # Session detail sheet (cwd, model, git status)
│               ├── SubagentCard.tsx         # Subagent invocation display
│               ├── ToolSummaryCard.tsx      # Compact tool call summary card
│               ├── WorkspaceFilter.tsx      # Workspace filter dropdown
│               └── ui/                      # shadcn/ui primitives
│                   ├── badge.tsx
│                   ├── button.tsx
│                   ├── card.tsx
│                   ├── dialog.tsx
│                   ├── input.tsx
│                   ├── scroll-area.tsx
│                   └── tooltip.tsx
├── server/tests/               # Vitest unit tests (37 test files + helpers.ts)
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
                ├── dockerd/             # Long-running Docker daemon (DinD)
                ├── api/                 # Long-running API server
                ├── tailscaled/          # Long-running Tailscale daemon (opt-in)
                ├── tailscaled-up/       # Oneshot: authenticate with tailnet
                └── user/                # Bundle: init + sshd + dockerd + api + tailscaled-up
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

Note: Without Sysbox, Docker-in-Docker will not work inside the nested container (dockerd requires Sysbox's enhanced isolation). SSH and Claude Code will function normally.

## Authentication

- **Claude Code** — users authenticate interactively by running `claude` inside the container and following the login link. Credentials are stored in `~/.claude/` which is backed by the `home` Docker volume, so they persist across container restarts.
- **API server** — the REST API and web UI require a bearer token set via the `API_PASSWORD` environment variable. The web UI prompts for it on the login page; API clients pass it as `Authorization: Bearer <password>`. Failed auth attempts are rate-limited per IP (10 attempts / 15 min sliding window). Additional security env vars:
  - `TRUST_PROXY=1` — trust `X-Forwarded-For` header for client IP resolution (required when behind a reverse proxy; without this, the rate limiter uses `req.socket.remoteAddress`)
  - `ALLOW_BYPASS_PERMISSIONS=1` — allow sessions to use `bypassPermissions` mode (disabled by default for safety)

## Key Conventions

- Feature branches must use the `feature/<branch-name>` naming convention
- Version tags follow SemVer with a `v` prefix: `v<major>.<minor>.<patch>`. Bump MAJOR for breaking changes, MINOR for new features, PATCH for bug fixes. Use the `/release` skill to cut a release — it handles the full sequence: bumping `server/package.json` and `server/package-lock.json`, rebuilding dist, committing, tagging, and pushing.
- Container runs as `hatchpod` user (uid 1000) with passwordless sudo
- Two Docker volumes: `home` (/home/hatchpod) and `docker-data` (/var/lib/docker)
- s6-overlay v3 service types: `oneshot` for init, `longrun` for sshd/dockerd/api, `bundle` for user
- `S6_KEEP_ENV=1` ensures environment variables propagate to all services
- When adding or removing software from the Dockerfile, update the "What's Included" table in README.md to match
- **Login shell PATH additions** — `/etc/profile` resets `PATH` before sourcing `/etc/profile.d/`, discarding any Docker `ENV PATH`. System-wide PATH additions (npm-global, custom tools) must go in `rootfs/etc/profile.d/` to be visible in all login shells (web terminal, SSH). `.bashrc` is for interactive non-login shells only — it early-returns if not interactive and is never sourced by a login shell unless `~/.profile` explicitly sources it.
- **Dockerfile skel ordering** — `useradd -m` (Dockerfile line ~110) copies `/etc/skel` into the home dir at user-creation time. `COPY rootfs/ /` runs after — so custom dotfiles in `rootfs/etc/skel/` are NOT applied to `/home/hatchpod/` at build time (only to `/etc/skel/` for future volumes). `init.sh` only seeds skel files when they don't exist (volume-persistence semantics). Prefer `rootfs/etc/profile.d/` for changes that must be in place from the first container start.
- Tailscale and dotfiles are opt-in features controlled by env vars (`TS_AUTHKEY`, `DOTFILES_REPO`)
- `docker-compose.yml` includes `cap_add: NET_ADMIN` and `/dev/net/tun` device for Tailscale kernel TUN mode; harmless when Tailscale is not enabled
- **Future-proof implementations over workarounds** — Always prefer the architecturally correct, future-proof approach even when it's more complex. Do not suggest a simpler workaround just because the proper solution requires more effort. This project has zero users, so breaking changes are free — leverage this to iterate toward the right architecture without backwards-compatibility constraints.

## Agent Workflow Conventions

- **Always check for relevant skills and MCP servers** before planning or implementing features. Use the `Skill` tool to invoke skills (e.g., `brainstorming` before design work, `writing-plans` before implementation, `frontend-design` for UI work, `systematic-debugging` for bug fixes).
- **Use Context7 MCP** (`mcp__plugin_context7_context7__resolve-library-id` and `query-docs`) for up-to-date library documentation instead of relying on web searches or cached knowledge.
- **Use Context7 + WebSearch/WebFetch for external SDK questions** — never answer questions about third-party SDKs (opencode, Codex, etc.) from training knowledge. Try Context7 first (`resolve-library-id` → `query-docs`); fall back to WebSearch + WebFetch if the library isn't indexed. Always fetch current docs before assessing fit or compatibility.
- **Use Serena MCP** for semantic code exploration (symbol overview, find references) when navigating the codebase efficiently.
- **Use `agent-sdk-dev` skills** when working with `@anthropic-ai/claude-agent-sdk` — use `agent-sdk-dev:new-sdk-app` when creating a new SDK application and `agent-sdk-dev:agent-sdk-verifier-ts` to verify SDK configuration and best practices after modifying `server/src/providers/claude-adapter.ts` or any SDK integration code.
- **Follow the brainstorming → writing-plans → implementation pipeline** for any non-trivial feature work. Design docs go in `docs/plans/YYYY-MM-DD-<topic>-design.md`.

### Skills

User-invokable skills in `.claude/skills/`:

- **`/dev-server`** — Start the Vite dev server + API server for UI development. Use this instead of rebuilding `server/public/` when working on UI files.
- **`/build-and-test`** — After modifying `server/src/` files: rebuilds `server/dist/` via `npm run build`, runs vitest unit tests, and stages the rebuilt dist files. Stops on failure.
- **`/docker-e2e`** — Full e2e test cycle: builds Docker image, starts a container on offset ports (12222/18080), waits for healthy, runs Playwright tests, and cleans up. Safe to run inside hatchpod itself.
- **`/release`** — Cut a release: asks for bump type (patch/minor/major), updates version, rebuilds dist, runs tests, commits, tags, and pushes. Use instead of doing version tags manually.

### Subagents

Specialized review agents in `.claude/agents/`:

- **`security-reviewer`** — Reviews auth (bearer token, WebSocket, SSH), path traversal (browse endpoint, session cwd), container security (Dockerfile, s6 scripts), and info disclosure. Reports findings with severity and file:line references.
- **`ui-reviewer`** — Reviews the React frontend for WCAG 2.1 AA accessibility (keyboard nav, ARIA, contrast), UX states (loading, error, empty), responsive layout, and React patterns (effect cleanup, re-renders, stale closures).

### Hooks

Configured in `.claude/settings.json`:

- **TypeScript type-check + ESLint** (PostToolUse) — Runs `tsc --noEmit` followed by `eslint` after any Edit/Write to files under `server/src/` or `server/ui/src/`. Catches type errors and lint issues immediately after edits. ESLint only runs if type-checking passes.
