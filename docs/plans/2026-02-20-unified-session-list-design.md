# Unified Session List with CLI History & Provider Labels

## Problem

The web UI sidebar only shows sessions created within the current hatchpod server process (in-memory). Users cannot see or resume historical Claude Code CLI sessions. There is no provider label, no session name, and no way to sort by recency.

## Requirements

1. **CLI session discovery** — scan `~/.claude/projects/<project-dir>/*.jsonl` files to discover historical Claude Code sessions
2. **CWD-aware** — session list reflects the current workspace CWD (as changed via FolderPicker)
3. **Fully resumable** — clicking a historical session creates a new hatchpod session with `resumeSessionId`, enabling follow-up messages
4. **Provider badge** — small text label next to the status pill showing the provider (e.g., "Claude", "Test")
5. **Session naming** — display the `slug` from the JSONL file (e.g., "greedy-inventing-pond"), falling back to truncated first user message, then session ID prefix
6. **Sort by recency** — flat list sorted by `lastModified` descending
7. **Deduplication** — if a live hatchpod session matches a historical JSONL (same `providerSessionId`), the live version wins

## Architecture

### New module: `server/src/session-history.ts`

Scans a Claude Code project directory for `*.jsonl` files. For each file:
1. Stats the file for `mtime` (used as `lastModified` and for cache invalidation)
2. Reads the first ~30 lines to extract: `sessionId`, `slug`, `cwd`, first non-system user message content (truncated to 80 chars), `firstTimestamp`
3. Caches results keyed by `(filePath, mtime)` — only re-parses when mtime changes

**Project directory derivation:**
```
CWD: /home/hatchpod/workspace/repos/hatchpod
  → ~/.claude/projects/-home-hatchpod-workspace-repos-hatchpod/
```

Rule: replace `/` with `-`, prepend `-`, prefix with `~/.claude/projects/`.

**Exported function:**
```typescript
interface HistorySession {
  id: string;           // sessionId from JSONL
  slug: string | null;  // e.g., "greedy-inventing-pond"
  summary: string | null; // first user message, truncated
  cwd: string;
  lastModified: Date;   // file mtime
  createdAt: Date;      // first timestamp in JSONL
}

function listSessionHistory(cwd: string): Promise<HistorySession[]>
```

### Modified: `GET /api/sessions`

Accepts optional query parameter: `?cwd=/path/to/workspace`

Response merges:
1. **Live sessions** from the in-memory `Map` (existing behavior)
2. **History sessions** from `listSessionHistory(cwd)` for the resolved CWD

Deduplication: if a live session's `providerSessionId` matches a history session's `id`, the live version wins (inheriting `slug` and `summary` from history if not already set).

Sorting: all entries sorted by `lastModified` descending.

### Modified: `SessionSummaryDTO`

```typescript
interface SessionSummaryDTO {
  id: string;
  status: SessionStatus;       // gains "history" value for historical-only sessions
  createdAt: string;
  lastModified: string;        // ISO timestamp (for sort order)
  numTurns: number;
  totalCostUsd: number;
  hasPendingApproval: boolean;
  provider: string;            // "claude" | "test" | etc.
  slug: string | null;
  summary: string | null;      // first user message, truncated
}
```

### New: `GET /api/providers`

Returns the list of registered providers:
```json
[{ "id": "claude", "name": "Claude Code" }, { "id": "test", "name": "Test Provider" }]
```

### Resume flow

When the user clicks a history session in the sidebar:
1. UI calls `POST /api/sessions` with `{ resumeSessionId: historyId, cwd, provider: "claude" }`
2. Session manager creates a new hatchpod session in `"idle"` status
3. The first follow-up message triggers `runSession()` with `resumeSessionId`
4. Claude adapter passes `resume: resumeSessionId` to the SDK

### Modified: `CreateSessionRequest`

```typescript
interface CreateSessionRequest {
  prompt?: string;
  permissionMode?: PermissionModeCommon;
  provider?: string;
  model?: string;
  cwd?: string;
  allowedTools?: string[];
  resumeSessionId?: string;  // NEW: resume a historical session
}
```

### Modified: `SessionStatus`

Add `"history"` to the union:
```typescript
type SessionStatus =
  | "idle" | "starting" | "running" | "waiting_for_approval"
  | "completed" | "interrupted" | "error" | "history";
```

## UI Changes

### `SessionList.tsx`

- Passes `cwd` to the polling endpoint: `GET /api/sessions?cwd=${encodeURIComponent(cwd)}`
- Displays each session with:
  - **Name**: `slug || summary || id.slice(0, 8)`
  - **Provider badge**: small text pill next to status (e.g., "Claude")
  - **Status pill**: existing color-coded status
  - **Time**: relative time from `lastModified` (e.g., "2h ago")
- Clicking a `"history"` session calls `onResumeSession(id)` instead of `onSelectSession(id)`
- New prop: `onResumeSession: (historySessionId: string) => void`

### `App.tsx`

- `startSession()` gains an optional `resumeSessionId` parameter
- Passes `cwd` to `SessionList` for CWD-aware polling
- `resumeSession(historyId)` handler: calls `POST /api/sessions` with `{ resumeSessionId: historyId, cwd, provider: "claude" }`

### `styles.css`

Provider badge:
```css
.provider-badge {
  font-size: 0.625rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 0.0625rem 0.375rem;
  border-radius: 999px;
  background: rgba(136, 146, 164, 0.15);
  color: var(--text-muted);
}
```

Session name styling — truncated with ellipsis, replacing the truncated UUID display.

## What Does NOT Change

- WebSocket protocol — no new message types
- Provider adapter interface — `resumeSessionId` already supported
- Tool approval flow — unaffected
- Message normalization — unaffected

## Files to Change

| # | File | Change |
|---|------|--------|
| 1 | `server/src/session-history.ts` | **New** — JSONL scanner with mtime cache |
| 2 | `server/src/types.ts` | Add `"history"` to `SessionStatus`, add fields to `SessionSummaryDTO`, add `resumeSessionId` to `CreateSessionRequest` |
| 3 | `server/src/sessions.ts` | Merge history into `listSessions()`, handle `resumeSessionId` in `createSession()` |
| 4 | `server/src/routes.ts` | Parse `cwd` query param on `GET /api/sessions`, add `GET /api/providers` |
| 5 | `server/ui/src/components/SessionList.tsx` | CWD-aware polling, session name display, provider badge, resume click handler |
| 6 | `server/ui/src/App.tsx` | Pass cwd to SessionList, add resume handler |
| 7 | `server/ui/src/styles.css` | Provider badge, session name styles |
| 8 | `server/src/providers/test-adapter.ts` | Add `[history]` test scenario (optional) |
| 9 | `server/tests/session-history.test.ts` | **New** — test JSONL scanning and merge |

## Verification

1. `cd server && npx tsc --noEmit` — type check
2. `cd server && npm run build` — rebuild dist
3. `cd server && npm test` — all tests pass
4. Manual: start server, verify sidebar shows CLI sessions with slugs, click one to resume, verify provider badges appear
