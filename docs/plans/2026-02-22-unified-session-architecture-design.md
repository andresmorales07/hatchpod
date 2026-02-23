# Unified Session Architecture

## Problem

The API server maintains an in-memory session manager (`Map<string, Session>`) that duplicates data already persisted by the Claude CLI in JSONL files. Sessions started via the CLI are invisible to the web UI until they complete and appear in history. The dual identity system (hatchpod UUID vs CLI session ID) adds unnecessary complexity.

## Goals

1. **CLI sessions visible live in the web UI** — messages appear as the CLI writes them
2. **Multi-device sync** — all WebSocket clients see the same live session data
3. **CLI JSONL files are the single source of truth** — no in-memory message buffer
4. **Provider-extensible** — works with Codex CLI or other providers that write session files
5. **Unified session identity** — the CLI session UUID is the only identifier

## Architecture

### Core Principle

The JSONL file is the single source of truth for all session messages. The API server is a file watcher and WebSocket relay. It never stores messages in memory.

### Data Flow

```
Message Sources                          File System
─────────────────                        ──────────────
CLI terminal ──▶ SDK ──writes──▶         JSONL file
Web UI ────────▶ SDK ──writes──▶         JSONL file
                                              │
                                        fs.watch / poll
                                              │
                                              ▼
                                     Session Watcher
                                   (tail + normalize)
                                              │
                                      WebSocket broadcast
                                              │
                              ┌────────────────┼────────────────┐
                              ▼                ▼                ▼
                           Device 1         Device 2         Device 3
```

### Session Identity

The CLI session UUID is the primary and only identifier. No hatchpod-generated UUIDs.

- `GET /api/sessions` — scans JSONL files (cached metadata, existing logic)
- `GET /api/sessions/:id/stream` — WebSocket: subscribes to live updates
- `POST /api/sessions` — starts a session via the SDK, blocks until the CLI session ID is available (~1s), returns it synchronously
- `DELETE /api/sessions/:id` — interrupts if running, cleans up runtime handle

### Components

#### 1. Session Watcher (new module: `server/src/session-watcher.ts`)

Replaces the in-memory message buffer. Watches JSONL files for changes and broadcasts normalized messages to subscribed WebSocket clients.

```typescript
interface SessionWatcher {
  // Subscribe a WebSocket client — replays existing messages, then streams new
  subscribe(sessionId: string, client: WebSocket): Promise<void>;

  // Unsubscribe on disconnect
  unsubscribe(sessionId: string, client: WebSocket): void;

  // Start the global poll loop (called once at server startup)
  start(): void;

  // Stop polling (called on server shutdown)
  stop(): void;
}
```

**Polling mechanics (no OS-level file watchers):**

A single `setInterval` loop (200ms) iterates over all subscribed sessions:

```typescript
// Internal state per subscribed session
interface WatchedSession {
  filePath: string;
  byteOffset: number;
  lineBuffer: string;          // incomplete line from previous read
  clients: Set<WebSocket>;
}

// The poll loop (single timer, not one per session)
setInterval(() => {
  for (const [sessionId, watched] of subscribed) {
    const size = stat(watched.filePath).size;
    if (size > watched.byteOffset) {
      // Read only new bytes
      const newData = read(watched.filePath, watched.byteOffset, size);
      watched.byteOffset = size;
      // Parse complete lines, normalize, broadcast
      const lines = (watched.lineBuffer + newData).split('\n');
      watched.lineBuffer = lines.pop()!; // save incomplete line
      for (const line of lines) {
        const msg = adapter.normalizeFileLine(line);
        if (msg) broadcast(watched.clients, msg);
      }
    }
  }
}, 200);
```

1. On `subscribe()`: read the full JSONL file, normalize all lines, send as replay. Record byte offset. Add client to the session's subscriber set.
2. The global poll loop checks `stat().size` for each subscribed session (cheap syscall, no disk read).
3. When size increases: read only the new bytes, parse complete lines, normalize, broadcast.
4. On `unsubscribe()`: remove client. If no subscribers remain, remove the session from the poll set.

**Why polling over fs.watch:**
- Zero OS-level watchers (no inotify/kqueue limits)
- Single timer regardless of session count
- `stat()` is a single syscall with no disk read
- Cross-platform: identical behavior on macOS, Linux, Docker, NFS
- No fs.watch edge cases (duplicate events, missing events, platform quirks)
- ~100ms average latency (acceptable per design decision)

**Edge cases:**
- File doesn't exist yet (session just created, SDK hasn't written first line): poll with stat until file appears.
- File is deleted: detect via stat ENOENT, notify subscribers, clean up.
- Partial line at end of read: buffered in `lineBuffer`, completed on next poll cycle.

#### 2. Runtime Handle (slimmed `ActiveSession`)

Only exists for sessions the API server is actively driving (interactive web UI sessions). Not needed for CLI-started sessions (viewer mode).

```typescript
interface ActiveSession {
  sessionId: string;              // CLI session ID
  cwd: string;
  abortController: AbortController;
  pendingApproval: PendingApproval | null;
  alwaysAllowedTools: Set<string>;
}
```

Removed from Session: `messages`, `clients`, `totalCostUsd`, `numTurns`, `slashCommands`, `lastError`, `createdAt`, `lastActivityAt`, `provider`, `model`, `permissionMode`.

The watcher handles message delivery and client tracking. The runtime handle only manages the SDK interaction (abort, tool approval).

#### 3. Session Status Inference

For CLI sessions (no runtime handle), status is inferred from the JSONL file:
- File has a `result` line → `completed`
- File is being actively modified (mtime changed recently) → `running`
- File exists but hasn't been modified → `completed` (or `idle`)

For API sessions (has runtime handle), status is tracked directly (starting → running → waiting_for_approval → completed/interrupted/error).

Both are unified in the WebSocket `status` message sent to clients.

#### 4. Provider Adapter Extensions

The `ProviderAdapter` interface gains file-related methods:

```typescript
interface ProviderAdapter {
  // Existing
  run(options: ProviderSessionOptions): AsyncGenerator<NormalizedMessage, ProviderSessionResult>;

  // New: resolve a session ID to its JSONL file path
  getSessionFilePath(sessionId: string): Promise<string | null>;

  // New: parse a single raw JSONL line into a normalized message
  normalizeFileLine(line: string): NormalizedMessage | null;

  // Existing
  getSessionHistory?(sessionId: string): Promise<NormalizedMessage[]>;
}
```

**Claude adapter:**
- `getSessionFilePath()` → searches `~/.claude/projects/*/` for `<uuid>.jsonl`
- `normalizeFileLine()` → parses Claude SDK JSONL format, applies existing normalization logic

**Future Codex adapter:**
- `getSessionFilePath()` → searches `~/.codex/sessions/*/` for session files
- `normalizeFileLine()` → parses Codex JSONL format

**Other providers (no native CLI):**
- The API server writes normalized JSONL as the generator yields messages
- `normalizeFileLine()` reads hatchpod's own JSONL format (passthrough)

#### 5. API Changes

**`POST /api/sessions`** — blocks until the SDK emits its first event (to capture the CLI session ID). Returns:
```json
{ "id": "<cli-session-uuid>", "status": "running" }
```

**`GET /api/sessions`** — unchanged (already merges live + history). Returns CLI session IDs.

**`GET /api/sessions/:id`** — returns session metadata. Messages are NOT included in the REST response (they come via WebSocket stream only, or via the existing `/history` endpoint).

**`GET /api/sessions/:id/stream`** (WebSocket) — subscribes to the session watcher. On connect:
1. Full message replay from JSONL
2. Live streaming of new messages
3. Status updates
4. Tool approval requests (API sessions only)

**`GET /api/sessions/:id/history`** — unchanged (reads full JSONL, normalizes).

#### 6. WebSocket Protocol Changes

Mostly unchanged. New additions:
- Status message includes a `source` field: `"api"` (interactive) or `"cli"` (viewer)
- Tool approval messages only sent for API sessions
- Composer is disabled in the UI for CLI sessions (viewer mode) unless resuming

### Session Lifecycle

**CLI session (viewer mode):**
```
User opens session in web UI
  → WS connect → watcher.subscribe()
  → Replay existing JSONL lines
  → fs.watch for new lines → broadcast
  → CLI finishes → result line appears → status: completed
  → User disconnects → watcher.unsubscribe()
  → No subscribers left → watcher.unwatch()
```

**API session (interactive mode):**
```
POST /api/sessions { prompt, cwd }
  → SDK starts → writes JSONL → first event yields CLI session ID
  → Return 200 { id }
  → Client connects WS → watcher.subscribe()
  → watcher tails JSONL → broadcasts messages
  → Tool approval: SDK pauses → runtime handle stores promise
    → WS sends approval request → client responds → resolve promise
  → SDK finishes → result line → status: completed
  → Runtime handle cleaned up
```

**Resume CLI session from web UI:**
```
User views CLI session (viewer mode)
  → Types a follow-up message
  → POST /api/sessions { prompt, resumeSessionId }
  → SDK resumes the CLI session, appends to same JSONL
  → Session transitions from viewer → interactive mode
  → Runtime handle created
```

## What Gets Deleted

- `session.messages: NormalizedMessage[]` — replaced by JSONL tailing
- `session.clients: Set<WebSocket>` — moved to session watcher
- `session.totalCostUsd`, `session.numTurns` — read from JSONL result line
- `session.slashCommands` — re-fetched or read from JSONL
- Hatchpod-generated session UUIDs — use CLI session IDs
- In-memory TTL eviction logic — no in-memory data to evict
- `session_result` message type in the normalized protocol — already removed from UI

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Poll interval adds latency | 200ms interval = ~100ms avg latency; acceptable per design decision |
| JSONL not flushed immediately by SDK | Combined with poll interval, worst case ~300ms. Still feels instant. |
| Partial line at file boundary | Buffer incomplete lines in `lineBuffer`, completed on next poll cycle |
| Race condition: subscribe during write | Read full file first (atomic snapshot), then start polling from that offset. Any bytes written during the read are caught on next poll. |
| Session file not yet created | `stat()` returns ENOENT; keep polling until file appears |
| Many subscribed sessions slow the poll | `stat()` is O(1) syscall per session. 100 sessions = 100 stat calls per 200ms = negligible CPU. Only sessions with changes trigger disk reads. |
