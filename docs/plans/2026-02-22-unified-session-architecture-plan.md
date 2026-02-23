# Unified Session Architecture — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the in-memory session manager with a JSONL file watcher + WebSocket relay so CLI sessions appear live in the web UI and all state reads from disk.

**Architecture:** A polling-based `SessionWatcher` tails JSONL files and broadcasts normalized messages to subscribed WebSocket clients. The in-memory `Session` object is slimmed to a runtime handle (`ActiveSession`) that only holds abort controller, pending tool approval, and always-allowed tools — no messages, no cost, no client tracking. Provider adapters gain `getSessionFilePath()` and `normalizeFileLine()` methods.

**Tech Stack:** Node.js fs (stat, open, read), TypeScript, vitest, WebSocket (ws)

---

### Task 1: Add `getSessionFilePath()` and `normalizeFileLine()` to provider adapter interface

**Files:**
- Modify: `server/src/providers/types.ts:117-124` (ProviderAdapter interface)
- Modify: `server/src/providers/claude-adapter.ts` (implement new methods)
- Modify: `server/src/providers/test-adapter.ts` (implement new methods)

**Step 1: Add new methods to ProviderAdapter interface**

In `server/src/providers/types.ts`, extend the `ProviderAdapter` interface:

```typescript
export interface ProviderAdapter {
  readonly name: string;
  readonly id: string;
  run(
    options: ProviderSessionOptions,
  ): AsyncGenerator<NormalizedMessage, ProviderSessionResult, undefined>;
  getSessionHistory?(sessionId: string): Promise<NormalizedMessage[]>;

  // New: resolve a session ID to its JSONL file path on disk
  getSessionFilePath(sessionId: string): Promise<string | null>;

  // New: parse a single raw JSONL line into a normalized message.
  // Returns null for lines that don't produce a visible message (e.g. system/init, unknown types).
  // `index` is the caller-maintained message counter.
  normalizeFileLine(line: string, index: number): NormalizedMessage | null;
}
```

**Step 2: Implement `getSessionFilePath()` in Claude adapter**

This already exists as `findSessionFile()` in `server/src/session-history.ts`. Delegate to it:

```typescript
// In ClaudeAdapter class
async getSessionFilePath(sessionId: string): Promise<string | null> {
  const { findSessionFile } = await import("../session-history.js");
  return findSessionFile(sessionId);
}
```

**Step 3: Extract `normalizeFileLine()` from existing `getSessionHistory()` logic**

The `getSessionHistory()` method in `claude-adapter.ts` (lines 330-401) already parses JSONL lines and normalizes them. Extract the per-line logic into `normalizeFileLine()`:

```typescript
// In ClaudeAdapter class
normalizeFileLine(line: string, index: number): NormalizedMessage | null {
  if (!line.trim()) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  const type = parsed.type;
  if (type !== "user" && type !== "assistant") return null;

  const msg = parsed.message as Record<string, unknown> | undefined;
  if (!msg) return null;

  if (type === "assistant") {
    return normalizeAssistant(
      { type: "assistant", message: msg } as unknown as SDKAssistantMessage,
      index,
    );
  }
  if (type === "user") {
    return normalizeUser(
      { type: "user", message: msg } as unknown as SDKUserMessage,
      index,
    );
  }
  return null;
}
```

Note: Thinking duration computation from timestamps (`thinkingDurationMs`) currently lives in `getSessionHistory()`. Move it to the caller (session watcher) by tracking `prevTimestampMs` there instead. `normalizeFileLine` should remain stateless.

**Step 4: Implement stubs in TestAdapter**

```typescript
// In TestAdapter class
async getSessionFilePath(_sessionId: string): Promise<string | null> {
  return null; // Test adapter doesn't write to disk
}

normalizeFileLine(_line: string, _index: number): NormalizedMessage | null {
  return null; // Test adapter doesn't use file-based messages
}
```

**Step 5: Run type-check**

Run: `cd server && npx tsc --noEmit`
Expected: PASS (no type errors)

**Step 6: Commit**

```bash
git add server/src/providers/types.ts server/src/providers/claude-adapter.ts server/src/providers/test-adapter.ts
git commit -m "feat: add getSessionFilePath() and normalizeFileLine() to provider adapter"
```

---

### Task 2: Build the SessionWatcher module

**Files:**
- Create: `server/src/session-watcher.ts`
- Test: `server/tests/session-watcher.test.ts`

**Step 1: Write the failing test — basic subscribe/replay**

Create `server/tests/session-watcher.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionWatcher } from "../src/session-watcher.js";

// Minimal mock adapter that parses simple JSON lines
const mockAdapter = {
  name: "mock",
  id: "mock",
  async getSessionFilePath(sessionId: string) {
    return (mockAdapter as any)._filePaths?.get(sessionId) ?? null;
  },
  normalizeFileLine(line: string, index: number) {
    if (!line.trim()) return null;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "text") {
        return { role: "assistant" as const, parts: [{ type: "text" as const, text: parsed.text }], index };
      }
    } catch {}
    return null;
  },
  // Helper to register file paths for tests
  _filePaths: new Map<string, string>(),
  run: async function* () { return { totalCostUsd: 0, numTurns: 0 }; },
};

// Minimal WebSocket mock
function createMockWs() {
  const sent: string[] = [];
  return {
    readyState: 1, // OPEN
    send(data: string) { sent.push(data); },
    sent,
    terminate() {},
  };
}

describe("SessionWatcher", () => {
  let tmpDir: string;
  let watcher: SessionWatcher;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "sw-test-"));
    mockAdapter._filePaths.clear();
    watcher = new SessionWatcher(mockAdapter as any);
  });

  afterEach(async () => {
    watcher.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("replays existing lines on subscribe", async () => {
    const filePath = join(tmpDir, "session-1.jsonl");
    await writeFile(filePath, '{"type":"text","text":"hello"}\n{"type":"text","text":"world"}\n');
    mockAdapter._filePaths.set("session-1", filePath);

    const ws = createMockWs();
    await watcher.subscribe("session-1", ws as any);

    const messages = ws.sent.map((s) => JSON.parse(s));
    const textMsgs = messages.filter((m: any) => m.type === "message");
    expect(textMsgs).toHaveLength(2);
    expect(textMsgs[0].message.parts[0].text).toBe("hello");
    expect(textMsgs[1].message.parts[0].text).toBe("world");
  });

  it("broadcasts new lines after subscribe", async () => {
    const filePath = join(tmpDir, "session-2.jsonl");
    await writeFile(filePath, '{"type":"text","text":"initial"}\n');
    mockAdapter._filePaths.set("session-2", filePath);

    const ws = createMockWs();
    await watcher.subscribe("session-2", ws as any);
    watcher.start(50); // 50ms poll for fast tests

    // Clear replay messages
    ws.sent.length = 0;

    // Append a new line
    await appendFile(filePath, '{"type":"text","text":"new msg"}\n');

    // Wait for poll to pick it up
    await new Promise((r) => setTimeout(r, 150));

    const messages = ws.sent.map((s) => JSON.parse(s));
    const textMsgs = messages.filter((m: any) => m.type === "message");
    expect(textMsgs).toHaveLength(1);
    expect(textMsgs[0].message.parts[0].text).toBe("new msg");
  });

  it("stops polling session when last client unsubscribes", async () => {
    const filePath = join(tmpDir, "session-3.jsonl");
    await writeFile(filePath, '{"type":"text","text":"hi"}\n');
    mockAdapter._filePaths.set("session-3", filePath);

    const ws = createMockWs();
    await watcher.subscribe("session-3", ws as any);
    expect(watcher.watchedCount).toBe(1);

    watcher.unsubscribe("session-3", ws as any);
    expect(watcher.watchedCount).toBe(0);
  });

  it("handles partial lines across poll cycles", async () => {
    const filePath = join(tmpDir, "session-4.jsonl");
    await writeFile(filePath, "");
    mockAdapter._filePaths.set("session-4", filePath);

    const ws = createMockWs();
    await watcher.subscribe("session-4", ws as any);
    watcher.start(50);

    // Write a partial line (no newline)
    await appendFile(filePath, '{"type":"text","text":"par');
    await new Promise((r) => setTimeout(r, 100));
    expect(ws.sent.filter((s) => JSON.parse(s).type === "message")).toHaveLength(0);

    // Complete the line
    await appendFile(filePath, 'tial"}\n');
    await new Promise((r) => setTimeout(r, 100));

    const messages = ws.sent.map((s) => JSON.parse(s));
    const textMsgs = messages.filter((m: any) => m.type === "message");
    expect(textMsgs).toHaveLength(1);
    expect(textMsgs[0].message.parts[0].text).toBe("partial");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/session-watcher.test.ts`
Expected: FAIL — `session-watcher.ts` doesn't exist

**Step 3: Implement SessionWatcher**

Create `server/src/session-watcher.ts`:

```typescript
import { stat as fsStat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { WebSocket } from "ws";
import type { ProviderAdapter, NormalizedMessage } from "./providers/types.js";
import type { ServerMessage } from "./types.js";

interface WatchedSession {
  filePath: string;
  byteOffset: number;
  lineBuffer: string;
  messageIndex: number;
  clients: Set<WebSocket>;
}

export class SessionWatcher {
  private watched = new Map<string, WatchedSession>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private adapter: ProviderAdapter;

  constructor(adapter: ProviderAdapter) {
    this.adapter = adapter;
  }

  get watchedCount(): number {
    return this.watched.size;
  }

  /** Subscribe a WebSocket client to a session. Replays existing messages, then streams new ones. */
  async subscribe(sessionId: string, client: WebSocket): Promise<void> {
    let entry = this.watched.get(sessionId);

    if (!entry) {
      const filePath = await this.adapter.getSessionFilePath(sessionId);
      if (!filePath) {
        const msg: ServerMessage = { type: "error", message: "session file not found" };
        client.send(JSON.stringify(msg));
        return;
      }
      entry = {
        filePath,
        byteOffset: 0,
        lineBuffer: "",
        messageIndex: 0,
        clients: new Set(),
      };
      this.watched.set(sessionId, entry);
    }

    entry.clients.add(client);

    // Replay: read from offset 0 (if new entry) or current offset (if existing)
    // For a new subscriber joining an existing watch, replay from start
    await this.replayForClient(entry, client);
  }

  /** Unsubscribe a client. Removes the session watch if no clients remain. */
  unsubscribe(sessionId: string, client: WebSocket): void {
    const entry = this.watched.get(sessionId);
    if (!entry) return;
    entry.clients.delete(client);
    if (entry.clients.size === 0) {
      this.watched.delete(sessionId);
    }
  }

  /** Start the global poll loop. */
  start(intervalMs = 200): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.poll(), intervalMs);
    this.pollTimer.unref();
  }

  /** Stop the poll loop. */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Read the full file and send all messages to a single client. */
  private async replayForClient(entry: WatchedSession, client: WebSocket): Promise<void> {
    let fh: FileHandle | null = null;
    try {
      const fileStat = await fsStat(entry.filePath);
      if (fileStat.size === 0) return;

      fh = await open(entry.filePath, "r");
      const buf = Buffer.alloc(fileStat.size);
      await fh.read(buf, 0, fileStat.size, 0);
      const content = buf.toString("utf-8");
      const lines = content.split("\n");

      let replayIndex = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        const normalized = this.adapter.normalizeFileLine(line, replayIndex);
        if (normalized) {
          const msg: ServerMessage = { type: "message", message: normalized };
          if (client.readyState === 1) {
            client.send(JSON.stringify(msg));
          }
          replayIndex++;
        }
      }

      // Update entry to track current end-of-file if this is the first subscriber
      if (entry.byteOffset === 0) {
        entry.byteOffset = fileStat.size;
        entry.messageIndex = replayIndex;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        console.error(`SessionWatcher: replay error for ${entry.filePath}:`, err);
      }
    } finally {
      await fh?.close();
    }

    // Signal replay complete
    const replayDone: ServerMessage = { type: "replay_complete" };
    if (client.readyState === 1) {
      client.send(JSON.stringify(replayDone));
    }
  }

  /** Single poll iteration: check all watched sessions for new data. */
  private async poll(): Promise<void> {
    for (const [sessionId, entry] of this.watched) {
      try {
        const fileStat = await fsStat(entry.filePath);
        if (fileStat.size <= entry.byteOffset) continue;

        // Read only new bytes
        const bytesToRead = fileStat.size - entry.byteOffset;
        const fh = await open(entry.filePath, "r");
        try {
          const buf = Buffer.alloc(bytesToRead);
          await fh.read(buf, 0, bytesToRead, entry.byteOffset);
          entry.byteOffset = fileStat.size;

          const newData = buf.toString("utf-8");
          const lines = (entry.lineBuffer + newData).split("\n");
          entry.lineBuffer = lines.pop()!; // incomplete last line

          for (const line of lines) {
            if (!line.trim()) continue;
            const normalized = this.adapter.normalizeFileLine(line, entry.messageIndex);
            if (normalized) {
              entry.messageIndex++;
              const msg: ServerMessage = { type: "message", message: normalized };
              this.broadcast(entry, msg);
            }
          }
        } finally {
          await fh.close();
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT") {
          // File deleted — notify and clean up
          this.broadcast(entry, { type: "error", message: "session file removed" });
          this.watched.delete(sessionId);
        } else {
          console.error(`SessionWatcher: poll error for ${sessionId}:`, err);
        }
      }
    }
  }

  private broadcast(entry: WatchedSession, msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const client of entry.clients) {
      try {
        if (client.readyState === 1) {
          client.send(data);
        }
      } catch (err) {
        console.error("SessionWatcher: broadcast send error:", err);
        entry.clients.delete(client);
      }
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/session-watcher.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add server/src/session-watcher.ts server/tests/session-watcher.test.ts
git commit -m "feat: add SessionWatcher with polling-based JSONL tailing"
```

---

### Task 3: Slim the Session type to ActiveSession

**Files:**
- Modify: `server/src/types.ts:8-27` (Session interface)
- Modify: `server/src/types.ts:30-43` (SessionDTO interface)

**Step 1: Define ActiveSession alongside Session**

Add the slimmed `ActiveSession` type to `server/src/types.ts`. Keep `Session` temporarily (for backward compat during migration) but add the new type:

```typescript
/** Runtime handle for API-driven sessions only. No message storage. */
export interface ActiveSession {
  sessionId: string;              // CLI session ID (from provider)
  provider: string;
  cwd: string;
  abortController: AbortController;
  pendingApproval: PendingApproval | null;
  alwaysAllowedTools: Set<string>;
  status: SessionStatus;
  lastError: string | null;
}
```

**Step 2: Update SessionDTO to not include messages**

Remove `messages` from `SessionDTO` (they come from the watcher/history endpoint):

```typescript
export interface SessionDTO {
  id: string;
  status: SessionStatus;
  createdAt: string;
  cwd: string;
  numTurns: number;
  totalCostUsd: number;
  lastError: string | null;
  slashCommands: SlashCommand[];
  pendingApproval: { toolName: string; toolUseId: string; input: unknown } | null;
  source: "api" | "cli";
}
```

**Step 3: Add `source` field to status ServerMessage**

In `ServerMessage` type, update the status variant:

```typescript
| { type: "status"; status: SessionStatus; error?: string; source?: "api" | "cli" }
```

**Step 4: Run type-check**

Run: `cd server && npx tsc --noEmit`
Expected: FAIL — many references to old Session fields. This is expected; we fix them in subsequent tasks.

**Step 5: Commit (types only)**

```bash
git add server/src/types.ts
git commit -m "feat: add ActiveSession type, remove messages from SessionDTO"
```

---

### Task 4: Rewrite sessions.ts to use ActiveSession + SessionWatcher

**Files:**
- Modify: `server/src/sessions.ts` (full rewrite of session manager)
- Modify: `server/src/index.ts` (start watcher on boot)

This is the largest task. The session manager shrinks dramatically:

**Step 1: Rewrite `server/src/sessions.ts`**

Key changes:
- `const sessions = new Map<string, ActiveSession>()` (not `Session`)
- `createSession()` blocks until the SDK emits the first event to capture the CLI session ID, then returns it
- `runSession()` no longer stores messages — the SDK writes to JSONL, the watcher tails it
- Remove `broadcast()` for messages — the watcher handles it
- Keep broadcast for tool approval and status changes (these are runtime-only)
- Remove TTL eviction (no data to evict)
- Remove `clearSessions()` message buffer clearing
- `listSessions()` → delegates entirely to `listSessionsWithHistory()` (no in-memory sessions to merge)
- `getSession()` returns `ActiveSession | undefined` (for API sessions only)
- `sessionToDTO()` no longer includes messages
- Export `getWatcher()` for ws.ts to access

**Step 2: Update `server/src/index.ts`**

Import and start the watcher:

```typescript
import { initWatcher } from "./sessions.js";
// In createApp():
initWatcher();
```

**Step 3: Run type-check**

Run: `cd server && npx tsc --noEmit`
Expected: Errors in `ws.ts` and `routes.ts` (fixed in next tasks)

**Step 4: Commit**

```bash
git add server/src/sessions.ts server/src/index.ts
git commit -m "refactor: rewrite sessions.ts to use ActiveSession + SessionWatcher"
```

---

### Task 5: Update WebSocket handler to use SessionWatcher

**Files:**
- Modify: `server/src/ws.ts` (use watcher for subscribe/replay instead of session.messages)

**Step 1: Rewrite `setupSessionConnection()`**

Key changes:
- On connect: call `watcher.subscribe(sessionId, ws)` instead of replaying from `session.messages`
- On close: call `watcher.unsubscribe(sessionId, ws)` instead of `session.clients.delete(ws)`
- The watcher handles message replay and live streaming
- Tool approval and status are still sent directly (they don't go through JSONL)
- For CLI sessions (no ActiveSession), the WS is subscribe-only (no prompt/approve/deny)

```typescript
function setupSessionConnection(ws: WebSocket, sessionId: string): void {
  const watcher = getWatcher();
  const activeSession = getActiveSession(sessionId);

  // Subscribe to file watcher for message replay + live streaming
  watcher.subscribe(sessionId, ws).catch((err) => {
    console.error(`SessionWatcher subscribe failed for ${sessionId}:`, err);
    ws.close(4004, "session not found");
  });

  // Send source info
  const source = activeSession ? "api" : "cli";
  ws.send(JSON.stringify({ type: "status", status: activeSession?.status ?? "history", source }));

  // ... tool approval / prompt handling only if activeSession exists ...
}
```

**Step 2: Run type-check**

Run: `cd server && npx tsc --noEmit`
Expected: Errors in `routes.ts` (fixed in next task)

**Step 3: Commit**

```bash
git add server/src/ws.ts
git commit -m "refactor: WebSocket handler uses SessionWatcher for message delivery"
```

---

### Task 6: Update REST routes

**Files:**
- Modify: `server/src/routes.ts`

**Step 1: Update route handlers**

Key changes:
- `GET /api/sessions` — already calls `listSessionsWithHistory()`, keep as-is
- `GET /api/sessions/:id` — return slimmed DTO (no messages). If no ActiveSession, return metadata from history.
- `POST /api/sessions` — response no longer returns immediately. Block until CLI session ID is known (await first SDK event).
- `DELETE /api/sessions/:id` — only works for ActiveSessions (can't delete a CLI session)
- Remove messages from sessionToDTO

**Step 2: Run type-check**

Run: `cd server && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add server/src/routes.ts
git commit -m "refactor: update REST routes for ActiveSession + SessionWatcher"
```

---

### Task 7: Update UI stores for new session model

**Files:**
- Modify: `server/ui/src/stores/messages.ts` (remove in-memory history mode, use watcher)
- Modify: `server/ui/src/stores/sessions.ts` (minor: session IDs are now CLI UUIDs)
- Modify: `server/ui/src/types.ts` (remove session_result from SystemEvent)

**Step 1: Simplify messages store**

Key changes:
- `loadHistory()` → no longer needs a separate code path. All sessions (live and history) use the WebSocket stream. Connect to `/:id/stream` and the watcher replays + streams.
- Remove `historySessionId` / `historySessionCwd` state
- The `sendPrompt()` resume flow creates a new API session via POST, then reconnects the WebSocket

**Step 2: Handle `source` field from status message**

Add `source: "api" | "cli" | null` to the store. When `source === "cli"`, the Composer component disables input (viewer mode) unless the user explicitly wants to resume.

**Step 3: Commit**

```bash
git add server/ui/src/stores/messages.ts server/ui/src/stores/sessions.ts server/ui/src/types.ts
git commit -m "refactor: update UI stores for unified session model"
```

---

### Task 8: Update UI components for viewer/interactive modes

**Files:**
- Modify: `server/ui/src/pages/ChatPage.tsx` (handle viewer mode)
- Modify: `server/ui/src/components/Composer.tsx` (disable in viewer mode)
- Modify: `server/ui/src/pages/SessionListPage.tsx` (all sessions use same navigation)

**Step 1: ChatPage changes**

- When status is "history" or source is "cli", show a "Viewing CLI session" indicator
- The Composer shows a "Resume this session" prompt instead of the normal input
- Clicking resume triggers `POST /api/sessions` with `resumeSessionId`

**Step 2: Composer changes**

- Accept a `viewerMode` prop
- In viewer mode: show disabled input with "Type to resume this session..." placeholder
- On submit in viewer mode: trigger the resume flow

**Step 3: SessionListPage changes**

- All sessions navigate the same way (no separate history vs live paths)
- Remove the `loadHistory` code path — just set `activeSessionId` and connect WS

**Step 4: Commit**

```bash
git add server/ui/src/pages/ChatPage.tsx server/ui/src/components/Composer.tsx server/ui/src/pages/SessionListPage.tsx
git commit -m "feat: viewer mode for CLI sessions, unified session navigation"
```

---

### Task 9: Update existing tests

**Files:**
- Modify: `server/tests/helpers.ts` (update for new session model)
- Modify: `server/tests/session-crud.test.ts`
- Modify: `server/tests/websocket-flow.test.ts`
- Modify: `server/tests/message-delivery.test.ts`
- Modify: `server/tests/follow-up.test.ts`
- Modify: `server/tests/interruption.test.ts`
- Modify: `server/tests/tool-approval.test.ts`

**Step 1: Update test helpers**

- `resetSessions()` now also resets the watcher
- `waitForStatus()` may need adjustment since session IDs are now CLI UUIDs (for test adapter, they're still generated)

**Step 2: Update tests to match new API contracts**

Key changes:
- `GET /api/sessions/:id` no longer includes `messages` — tests that check `body.messages` should use WebSocket replay or `/history` endpoint instead
- Session creation may take slightly longer (blocks for first SDK event)
- WebSocket replay comes from the watcher, not in-memory buffer

**Step 3: Run full test suite**

Run: `cd server && npx vitest run`
Expected: All tests pass

**Step 4: Commit**

```bash
git add server/tests/
git commit -m "test: update tests for unified session architecture"
```

---

### Task 10: Build, rebuild dist, clean up

**Files:**
- Modify: `server/dist/` (rebuild)
- Delete dead code from old Session type if any remains

**Step 1: Build server**

Run: `cd server && npm run build`
Expected: Clean build

**Step 2: Run full test suite one last time**

Run: `cd server && npx vitest run`
Expected: All tests pass

**Step 3: Stage rebuilt dist**

```bash
git add -f server/dist/
git commit -m "build: rebuild dist for unified session architecture"
```

**Step 4: Verify dev server works**

Run: `cd server && API_PASSWORD=test node dist/index.js`
Expected: Server starts, healthcheck passes, WebSocket connections work

---

### Task Summary

| Task | Description | Est. Complexity |
|------|-------------|----------------|
| 1 | Provider adapter interface extensions | Small |
| 2 | SessionWatcher module + tests | Medium |
| 3 | ActiveSession type definition | Small |
| 4 | Rewrite sessions.ts | Large |
| 5 | Update WebSocket handler | Medium |
| 6 | Update REST routes | Medium |
| 7 | Update UI stores | Medium |
| 8 | Update UI components (viewer mode) | Medium |
| 9 | Update existing tests | Large |
| 10 | Build + cleanup | Small |
