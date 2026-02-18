# Claude Box API Server + Web UI — Design Document

## Overview

Add a programmatic API server wrapping the Claude Code Agent SDK, with a built-in minimal React web UI. The server runs as an s6 longrun service on port 8080 alongside existing services (SSH, ttyd, dockerd). It enables mobile apps, web frontends, and any HTTP client to interact with Claude Code sessions over REST and WebSocket — without requiring a terminal.

**Primary success criteria:** Rock-solid, well-documented REST + WebSocket API. The web UI is a minimal demo proving the API works.

## Architecture

```
┌──────────────────┐   HTTPS/WSS    ┌──────────────────────────────────┐
│  Browser / App   │ ◄────────────► │  claude-box                      │
│                  │  (Tailscale)    │                                  │
│  React UI (demo) │                │  ┌────────────────────────────┐  │
│  or any client   │                │  │  API server (:8080)        │  │
│                  │                │  │                            │  │
│  REST ──────────►│                │  │  GET  /healthz             │  │
│  WS   ◄────────►│                │  │  POST /api/sessions        │  │
│                  │                │  │  GET  /api/sessions        │  │
│                  │                │  │  GET  /api/sessions/:id    │  │
│                  │                │  │  DEL  /api/sessions/:id    │  │
│                  │                │  │  WS   /api/sessions/:id/ws │  │
│                  │                │  │                            │  │
│                  │                │  │  Static: /  → React UI     │  │
│                  │                │  │  SDK: query() per session  │  │
└──────────────────┘                │  └────────────────────────────┘  │
                                    │                                  │
                                    │  ┌───────┐ ┌──────┐ ┌────────┐  │
                                    │  │ sshd  │ │ ttyd │ │dockerd │  │
                                    │  │ :2222 │ │:7681 │ │  DinD  │  │
                                    │  └───────┘ └──────┘ └────────┘  │
                                    └──────────────────────────────────┘
```

- Node.js server using `http` + `ws` (no framework — 5 endpoints don't need one)
- Serves the React UI as static files at `/`
- REST API under `/api/`
- WebSocket per session at `/api/sessions/:id/ws`
- Auth: Bearer token from `API_PASSWORD` env var
- s6 longrun service, always on, depends on `init`
- Sits alongside ttyd (does not replace it)

## SDK Integration

Uses the stable V1 `query()` async generator from `@anthropic-ai/claude-agent-sdk`.

- Each session is a running `query()` call with `includePartialMessages: true`
- `canUseTool` callback bridges to WebSocket tool approval flow
- Session resume via `options.resume = sessionId` for multi-turn
- Default `permissionMode: "bypassPermissions"` (container is already sandboxed)

V2 preview API (`unstable_v2_createSession`) was considered but rejected — it's marked unstable, missing `canUseTool`, and could break on any SDK update.

CLI wrapper (`claude -p`) was considered but rejected — no programmatic tool approval, fragile JSON parsing, no type safety.

## API Contract

### REST Endpoints

| Method | Path | Auth | Request | Response |
|--------|------|------|---------|----------|
| `GET` | `/healthz` | No | — | `{ status, uptime, sessions: { active, total } }` |
| `POST` | `/api/sessions` | Yes | `{ prompt, permissionMode?, model?, cwd?, allowedTools? }` | `201` with session info |
| `GET` | `/api/sessions` | Yes | — | Array of session summaries |
| `GET` | `/api/sessions/:id` | Yes | — | Full session with message history |
| `DELETE` | `/api/sessions/:id` | Yes | — | Interrupts session, returns status |

Defaults: `permissionMode: "bypassPermissions"`, `cwd: "/home/claude/workspace"`.

### WebSocket Protocol (`/api/sessions/:id/ws`)

Auth via `?token=<password>` query param.

**Client to server:**

| Message | Purpose |
|---------|---------|
| `{ type: "prompt", text: "..." }` | Send follow-up prompt |
| `{ type: "approve", toolUseId: "..." }` | Approve tool use |
| `{ type: "deny", toolUseId: "...", message: "..." }` | Deny tool use |
| `{ type: "interrupt" }` | Cancel session |

**Server to client:**

| Message | Purpose |
|---------|---------|
| `{ type: "sdk_message", message: SDKMessage }` | Streamed SDK events |
| `{ type: "tool_approval_request", toolName, toolUseId, input }` | Needs approval |
| `{ type: "status", status, error? }` | Session state change |
| `{ type: "replay_complete" }` | Done replaying buffered messages |
| `{ type: "ping" }` | 30s keepalive |
| `{ type: "error", message: "..." }` | Client error |

### Reconnection

When a WS connects, all buffered `session.messages[]` are replayed as `sdk_message` events, followed by a `replay_complete` marker. If there's a pending approval, it's sent immediately after. Sessions persist across WS disconnects.

## Session State Management

In-memory `Map<string, Session>`:

```typescript
interface Session {
  id: string;                    // SDK session_id
  status: "starting" | "running" | "waiting_for_approval"
        | "completed" | "interrupted" | "error";
  createdAt: Date;
  permissionMode: PermissionMode;
  query: Query | null;
  abortController: AbortController;
  messages: SDKMessage[];        // Full history for reconnection replay
  totalCostUsd: number;
  numTurns: number;
  lastError: string | null;
  pendingApproval: PendingApproval | null;
  clients: Set<WebSocket>;      // Multiple clients supported
}
```

**No persistence across restarts.** Sessions are inherently tied to the SDK subprocess. This is acceptable for v1.

**Multi-turn:** Follow-up prompts create a new `query()` call with `options.resume = sessionId`. The ~12s startup per turn is a known trade-off of V1.

**Tool approval flow:**
1. `canUseTool` callback fires → creates `PendingApproval` with a Promise
2. Broadcasts `tool_approval_request` to all WS clients
3. Callback blocks until a client sends `approve` or `deny`
4. Promise resolves → SDK continues

## Web UI (Minimal Demo)

React + Vite. Proves the API works, not a polished product.

**Components:**

```
App.tsx                  — router: login vs main view
├── LoginPage.tsx        — password input, stores token in localStorage
├── SessionList.tsx      — list sessions, "New Session" button + prompt input
└── ChatView.tsx         — streaming message display for active session
    └── ToolApproval.tsx — approve/deny banner when pending
```

**In scope:** Login, session list, create session, streaming messages, tool approval banner, basic responsive CSS.

**Out of scope (v1):** File browser, git view, syntax highlighting, push notifications, session forking, animations.

**Build:** Vite outputs to `server/public/`. API server serves as static files at `/`.

## Testing Strategy

**API tests** (`tests/api.spec.ts`) — Playwright `request` context, pure HTTP:
- healthz returns 200 (unauthenticated)
- Rejects unauthenticated requests (401)
- Accepts authenticated requests (200)
- Creates a session (201 + session ID)
- Lists sessions
- Gets session details
- Interrupts a session
- Returns 404 for unknown session

**Web UI tests** (`tests/web-ui.spec.ts`) — Playwright browser automation:
- Login page loads (password input visible)
- Authenticates with correct password
- Rejects incorrect password

**Existing ttyd tests** — unchanged. Playwright config gets a new project for port 8080.

**Not tested in CI:** Real Claude sessions (require API key, cost money). End-to-end agent tests are manual verification.

## Infrastructure

**s6 service:** `rootfs/etc/s6-overlay/s6-rc.d/api/` — longrun, depends on `init`, added to `user` bundle. Run script: `exec s6-setuidgid claude node /opt/api-server/dist/index.js`.

**Dockerfile:** Two build stages after `COPY rootfs/ /`:
1. Build React UI (Vite) → `/tmp/ui/dist/`
2. Build API server (TypeScript) → `/opt/api-server/dist/`, copy UI into `public/`

**docker-compose.yml:** Port `8080:8080`, env `API_PASSWORD`, healthcheck adds `/healthz`.

**Dependencies:**
- Server: `@anthropic-ai/claude-agent-sdk`, `ws`
- UI: `react`, `react-dom`, `vite`, `@vitejs/plugin-react`
- Dev: `typescript`, `@types/node`, `@types/ws`, `@types/react`, `@types/react-dom`

## Risks

- **SDK startup latency:** ~12s per `query()` call. Acceptable for session creation, but follow-up prompts also incur this cost with V1.
- **SDK stability:** Claude Code releases every ~2 days. Pin SDK version.
- **Memory:** Each session holds a subprocess + message buffer. No limit enforced in v1.
- **No persistence:** Sessions lost on restart. Inherent to SDK architecture.
