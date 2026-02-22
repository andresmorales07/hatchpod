# CLI Session History in Web UI — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix chat header display (slug vs summary) and allow viewing CLI session message history in the web UI with lazy-resume.

**Architecture:** Add `getSessionHistory()` to `ProviderAdapter` interface. `ClaudeAdapter` implements it by parsing JSONL files from `~/.claude/projects/`. A new REST endpoint `GET /api/sessions/:id/history` serves the messages. The frontend loads history on page visit and only starts the SDK when the user sends a follow-up message.

**Tech Stack:** TypeScript, Node.js (server), React + Zustand (UI), Vitest (tests)

---

### Task 1: Fix chat header display priority

**Files:**
- Modify: `server/ui/src/pages/ChatPage.tsx:67`

**Step 1: Fix the display name priority**

In `ChatPage.tsx:67`, change:
```typescript
const sessionName = activeSession?.slug || activeSession?.summary || id?.slice(0, 8) || "Chat";
```
to:
```typescript
const sessionName = activeSession?.summary || activeSession?.slug || id?.slice(0, 8) || "Chat";
```

**Step 2: Verify TypeScript compiles**

Run: `cd server/ui && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add server/ui/src/pages/ChatPage.tsx
git commit -m "fix: chat header shows summary instead of slug"
```

---

### Task 2: Add `getSessionHistory` to ProviderAdapter interface

**Files:**
- Modify: `server/src/providers/types.ts:116-122`

**Step 1: Add the optional method to ProviderAdapter**

In `server/src/providers/types.ts`, add `getSessionHistory` to the `ProviderAdapter` interface:

```typescript
export interface ProviderAdapter {
  readonly name: string;
  readonly id: string;
  run(
    options: ProviderSessionOptions,
  ): AsyncGenerator<NormalizedMessage, ProviderSessionResult, undefined>;
  getSessionHistory?(sessionId: string): Promise<NormalizedMessage[]>;
}
```

**Step 2: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit`
Expected: No errors (method is optional, existing adapters don't need to implement it)

**Step 3: Commit**

```bash
git add server/src/providers/types.ts
git commit -m "feat: add getSessionHistory to ProviderAdapter interface"
```

---

### Task 3: Add `findSessionFile` helper to session-history.ts

The `getSessionHistory` implementation in the Claude adapter needs to find the JSONL file for a given session ID across all project directories. Add a shared helper.

**Files:**
- Modify: `server/src/session-history.ts`
- Test: `server/tests/session-history.test.ts`

**Step 1: Write the failing test**

Add to `server/tests/session-history.test.ts`, inside the `"session-history"` describe block:

```typescript
describe("findSessionFile", () => {
  it("finds a session file by ID across project directories", async () => {
    const sid = randomUUID();
    const content = makeJsonl(sid, { slug: "findable-session" });
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), content);

    const result = await findSessionFile(sid);
    expect(result).toBe(join(fakeProjectDir, `${sid}.jsonl`));
  });

  it("returns null for nonexistent session ID", async () => {
    const result = await findSessionFile(randomUUID());
    expect(result).toBeNull();
  });
});
```

Also import `findSessionFile` at the top alongside the other imports:

```typescript
let findSessionFile: typeof import("../src/session-history.js").findSessionFile;
```

And in `beforeAll`, after the module import:
```typescript
findSessionFile = mod.findSessionFile;
```

**Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/session-history.test.ts`
Expected: FAIL — `findSessionFile` is not exported

**Step 3: Implement findSessionFile**

Add to `server/src/session-history.ts`:

```typescript
/** Find the JSONL file path for a given session ID across all project directories. */
export async function findSessionFile(sessionId: string): Promise<string | null> {
  if (!UUID_RE.test(sessionId)) return null;

  const base = process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
  let entries: Dirent[];
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const e of entries.filter((e) => e.isDirectory())) {
    const filePath = join(base, e.name, `${sessionId}.jsonl`);
    try {
      await stat(filePath);
      return filePath;
    } catch {
      continue;
    }
  }
  return null;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/session-history.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add server/src/session-history.ts server/tests/session-history.test.ts
git commit -m "feat: add findSessionFile helper for JSONL lookup"
```

---

### Task 4: Implement `getSessionHistory` in ClaudeAdapter

**Files:**
- Modify: `server/src/providers/claude-adapter.ts`
- Test: `server/tests/session-history-messages.test.ts` (new)

**Step 1: Write the failing test**

Create `server/tests/session-history-messages.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { NormalizedMessage } from "../src/providers/types.js";

const testDir = join(tmpdir(), `hatchpod-history-msg-test-${Date.now()}`);
const fakeClaudeDir = join(testDir, ".claude", "projects");
const fakeProjectDir = join(fakeClaudeDir, "-home-user-workspace");

let ClaudeAdapter: typeof import("../src/providers/claude-adapter.js").ClaudeAdapter;

beforeAll(async () => {
  process.env.CLAUDE_PROJECTS_DIR = fakeClaudeDir;
  await mkdir(fakeProjectDir, { recursive: true });
  const mod = await import("../src/providers/claude-adapter.js");
  ClaudeAdapter = mod.ClaudeAdapter;
});

afterAll(async () => {
  delete process.env.CLAUDE_PROJECTS_DIR;
  await rm(testDir, { recursive: true, force: true });
});

function makeFullJsonl(sessionId: string): string {
  const lines: string[] = [];
  // Progress line (should be skipped)
  lines.push(JSON.stringify({
    type: "progress",
    sessionId,
    cwd: "/home/user/workspace",
    timestamp: "2026-02-20T10:00:00.000Z",
  }));
  // User message
  lines.push(JSON.stringify({
    type: "user",
    sessionId,
    message: {
      role: "user",
      content: "Hello, how are you?",
    },
    timestamp: "2026-02-20T10:00:01.000Z",
  }));
  // Assistant message with text
  lines.push(JSON.stringify({
    type: "assistant",
    sessionId,
    message: {
      role: "assistant",
      type: "message",
      content: [
        { type: "text", text: "I'm doing well, thanks!" },
      ],
    },
    timestamp: "2026-02-20T10:00:02.000Z",
  }));
  // User message with tool_result content
  lines.push(JSON.stringify({
    type: "user",
    sessionId,
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_123", content: "file content here", is_error: false },
      ],
    },
    timestamp: "2026-02-20T10:00:03.000Z",
  }));
  // Assistant with tool_use
  lines.push(JSON.stringify({
    type: "assistant",
    sessionId,
    message: {
      role: "assistant",
      type: "message",
      content: [
        { type: "tool_use", id: "tu_456", name: "Read", input: { path: "/tmp/test" } },
      ],
    },
    timestamp: "2026-02-20T10:00:04.000Z",
  }));
  // file-history-snapshot (should be skipped)
  lines.push(JSON.stringify({
    type: "file-history-snapshot",
    sessionId,
  }));
  return lines.join("\n") + "\n";
}

describe("ClaudeAdapter.getSessionHistory", () => {
  it("parses user and assistant messages from JSONL", async () => {
    const sid = randomUUID();
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), makeFullJsonl(sid));

    const adapter = new ClaudeAdapter();
    const messages = await adapter.getSessionHistory!(sid);

    // Should have 4 messages: user text, assistant text, user tool_result, assistant tool_use
    expect(messages).toHaveLength(4);

    // First: user text
    expect(messages[0].role).toBe("user");
    expect(messages[0].parts).toEqual([{ type: "text", text: "Hello, how are you?" }]);

    // Second: assistant text
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].parts).toEqual([{ type: "text", text: "I'm doing well, thanks!" }]);

    // Third: user tool_result
    expect(messages[2].role).toBe("user");
    expect(messages[2].parts[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "tu_123",
      output: "file content here",
      isError: false,
    });

    // Fourth: assistant tool_use
    expect(messages[3].role).toBe("assistant");
    expect(messages[3].parts[0]).toMatchObject({
      type: "tool_use",
      toolUseId: "tu_456",
      toolName: "Read",
    });
  });

  it("returns empty array for nonexistent session", async () => {
    const adapter = new ClaudeAdapter();
    const messages = await adapter.getSessionHistory!(randomUUID());
    expect(messages).toEqual([]);
  });

  it("indexes messages sequentially", async () => {
    const sid = randomUUID();
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), makeFullJsonl(sid));

    const adapter = new ClaudeAdapter();
    const messages = await adapter.getSessionHistory!(sid);
    messages.forEach((m, i) => expect(m.index).toBe(i));
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/session-history-messages.test.ts`
Expected: FAIL — `getSessionHistory` is not implemented

**Step 3: Implement getSessionHistory in ClaudeAdapter**

The JSONL `message` field for `type: "user"` and `type: "assistant"` has the same structure as SDK messages. Extract the normalization helpers (`normalizeAssistant`, `normalizeUser`) to be reusable, then call them from `getSessionHistory`.

In `server/src/providers/claude-adapter.ts`, add the method to the `ClaudeAdapter` class:

```typescript
async getSessionHistory(sessionId: string): Promise<NormalizedMessage[]> {
  const { findSessionFile } = await import("../session-history.js");
  const filePath = await findSessionFile(sessionId);
  if (!filePath) return [];

  const { createReadStream } = await import("node:fs");
  const { createInterface } = await import("node:readline");

  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const messages: NormalizedMessage[] = [];
  let messageIndex = 0;

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const type = parsed.type;
      if (type !== "user" && type !== "assistant") continue;

      const msg = parsed.message as Record<string, unknown> | undefined;
      if (!msg) continue;

      let normalized: NormalizedMessage | null = null;
      if (type === "assistant") {
        normalized = normalizeAssistant(
          { type: "assistant", message: msg } as unknown as SDKAssistantMessage,
          messageIndex,
        );
      } else if (type === "user") {
        normalized = normalizeUser(
          { type: "user", message: msg } as unknown as SDKUserMessage,
          messageIndex,
        );
      }

      if (normalized) {
        messages.push(normalized);
        messageIndex++;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return messages;
}
```

Note: `normalizeAssistant` and `normalizeUser` are already module-level functions in `claude-adapter.ts`, so they're accessible from the method body without any refactoring.

**Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/session-history-messages.test.ts`
Expected: All PASS

**Step 5: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: No errors

**Step 6: Commit**

```bash
git add server/src/providers/claude-adapter.ts server/tests/session-history-messages.test.ts
git commit -m "feat: implement getSessionHistory in ClaudeAdapter"
```

---

### Task 5: Add GET /api/sessions/:id/history endpoint

**Files:**
- Modify: `server/src/routes.ts`

**Step 1: Add the history endpoint**

In `server/src/routes.ts`, add a new route handler after the existing `GET /api/sessions/:id` block (after line 185). Use a new regex for the history path:

```typescript
const SESSION_HISTORY_RE = /^\/api\/sessions\/([0-9a-f-]{36})\/history$/;
```

Add the route handler (insert before the `DELETE /api/sessions/:id` handler):

```typescript
// GET /api/sessions/:id/history — session message history from provider storage
const historyMatch = pathname.match(SESSION_HISTORY_RE);
if (historyMatch && method === "GET") {
  const sessionId = historyMatch[1];
  const provider = url.searchParams.get("provider") ?? "claude";
  try {
    const adapter = getProvider(provider);
    if (!adapter.getSessionHistory) {
      json(res, 404, { error: "provider does not support session history" });
      return;
    }
    const messages = await adapter.getSessionHistory(sessionId);
    json(res, 200, messages);
  } catch (err) {
    console.error(`Failed to get session history for ${sessionId}:`, err);
    json(res, 500, { error: "internal server error" });
  }
  return;
}
```

Also import `getProvider` from `./providers/index.js` (it's already imported via `listProviders`, but `getProvider` also needs to be imported):

Add `getProvider` to the imports from `./providers/index.js`:
```typescript
import { listProviders, getProvider } from "./providers/index.js";
```

**Step 2: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: No errors

**Step 3: Run all server tests**

Run: `cd server && npx vitest run`
Expected: All PASS

**Step 4: Commit**

```bash
git add server/src/routes.ts
git commit -m "feat: add GET /api/sessions/:id/history endpoint"
```

---

### Task 6: Update frontend — history session navigation

Change history session clicks to navigate to `/session/:id` instead of calling `resumeSession()`.

**Files:**
- Modify: `server/ui/src/components/Sidebar.tsx:38-47`
- Modify: `server/ui/src/pages/SessionListPage.tsx:32-41`

**Step 1: Update Sidebar.tsx handleSelect**

Replace the `handleSelect` function in `Sidebar.tsx`:

```typescript
const handleSelect = (id: string, status: string) => {
  setActiveSession(id);
  navigate(`/session/${id}`);
};
```

History sessions now navigate directly. The resume logic moves to the message store (Task 7).

**Step 2: Update SessionListPage.tsx handleSelect**

Same change in `SessionListPage.tsx`:

```typescript
const handleSelect = (id: string, status: string) => {
  setActiveSession(id);
  navigate(`/session/${id}`);
};
```

**Step 3: Remove unused `resumeSession` import usage**

In both `Sidebar.tsx` and `SessionListPage.tsx`, `useSessionsStore.getState().resumeSession` is no longer called inline. Keep `resumeSession` in the store (it's still needed by the message store later), but verify there are no unused references.

**Step 4: Type-check**

Run: `cd server/ui && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add server/ui/src/components/Sidebar.tsx server/ui/src/pages/SessionListPage.tsx
git commit -m "feat: navigate to history sessions instead of immediate resume"
```

---

### Task 7: Update message store — loadHistory and resume-on-send

This is the core frontend change. Add `loadHistory()` to fetch and display history messages, and modify `sendPrompt()` to handle the resume flow when in history mode.

**Files:**
- Modify: `server/ui/src/stores/messages.ts`

**Step 1: Add loadHistory action and history mode state**

Add `historySessionId` to the state (tracks which history session is being viewed) and `loadHistory` action:

```typescript
interface MessagesState {
  // ... existing fields ...
  historySessionId: string | null;
  historySessionCwd: string | null;
  loadHistory: (sessionId: string, cwd: string) => Promise<void>;
  // ... existing actions ...
}
```

Initialize in the store:
```typescript
historySessionId: null,
historySessionCwd: null,
```

Implement `loadHistory`:
```typescript
loadHistory: async (sessionId: string, cwd: string) => {
  get().disconnect();
  currentSessionId = null;
  messageCount = 0;
  set({
    messages: [],
    status: "history",
    connected: false,
    pendingApproval: null,
    slashCommands: [],
    thinkingText: "",
    thinkingStartTime: null,
    thinkingDurations: {},
    lastError: null,
    historySessionId: sessionId,
    historySessionCwd: cwd,
  });
  const { token } = useAuthStore.getState();
  try {
    const res = await fetch(`/api/sessions/${sessionId}/history`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) { useAuthStore.getState().logout(); return; }
    if (res.ok) {
      const msgs = await res.json();
      messageCount = msgs.length;
      set({ messages: msgs, status: "history" });
    } else {
      set({ lastError: "Failed to load session history" });
    }
  } catch (err) {
    console.error("Failed to load history:", err);
    set({ lastError: "Unable to reach server" });
  }
},
```

**Step 2: Modify sendPrompt to handle history mode resume**

When `status === "history"`, the user is viewing a history session and wants to continue. Instead of sending via WebSocket (no connection yet), create a new session with resume, then connect:

Replace the existing `sendPrompt` with:
```typescript
sendPrompt: (text) => {
  const state = get();
  // History mode — resume session and send first message
  if (state.historySessionId) {
    const { token } = useAuthStore.getState();
    const sessStore = useSessionsStore.getState();
    const cwd = state.historySessionCwd || sessStore.cwd;
    const historyMessages = [...state.messages];
    const historyId = state.historySessionId;

    set({ historySessionId: null, historySessionCwd: null, lastError: null });

    fetch("/api/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        resumeSessionId: historyId,
        prompt: text,
        cwd,
        provider: "claude",
      }),
    })
      .then(async (res) => {
        if (res.status === 401) { useAuthStore.getState().logout(); return; }
        if (res.ok) {
          const session = await res.json();
          sessStore.setActiveSession(session.id);
          sessStore.fetchSessions();
          // Pre-seed with history messages, then connect WS for new messages
          messageCount = historyMessages.length;
          set({ messages: historyMessages, status: "starting" });
          currentSessionId = session.id;

          // Kick off WebSocket connection (reusing connect logic)
          get().connect(session.id);
        } else {
          set({ lastError: "Failed to resume session" });
        }
      })
      .catch((err) => {
        console.error("Failed to resume session:", err);
        set({ lastError: "Unable to reach server" });
      });

    return true;
  }

  // Normal mode — send via WebSocket
  set({ lastError: null });
  return send({ type: "prompt", text });
},
```

**Step 3: Update connect to preserve existing messages**

Modify `connect` so it doesn't wipe messages if they were pre-seeded from history. Change the state reset at the top of `connect`:

```typescript
connect: (sessionId: string) => {
  // If we already have this session connected, skip
  if (currentSessionId === sessionId && ws?.readyState === WebSocket.OPEN) return;

  // Disconnect any existing connection (but don't wipe if resuming from history)
  const preserveMessages = get().messages.length > 0 && get().status === "starting";
  get().disconnect();
  currentSessionId = sessionId;

  if (!preserveMessages) {
    messageCount = 0;
    thinkingStart = null;
    set({
      messages: [],
      status: "starting",
      connected: false,
      pendingApproval: null,
      slashCommands: [],
      thinkingText: "",
      thinkingStartTime: null,
      thinkingDurations: {},
      lastError: null,
      historySessionId: null,
      historySessionCwd: null,
    });
  }

  // ... rest of doConnect unchanged ...
```

Also reset `historySessionId`/`historySessionCwd` in `disconnect`:
```typescript
disconnect: () => {
  currentSessionId = null;
  clearTimeout(reconnectTimer);
  reconnectAttempts = 0;
  ws?.close();
  ws = null;
},
```

**Step 4: Add import for useSessionsStore**

Add at the top of `messages.ts`:
```typescript
import { useSessionsStore } from "./sessions";
```

**Step 5: Type-check**

Run: `cd server/ui && npx tsc --noEmit`
Expected: No errors

**Step 6: Commit**

```bash
git add server/ui/src/stores/messages.ts
git commit -m "feat: add loadHistory and resume-on-send to message store"
```

---

### Task 8: Update ChatPage to handle history mode

**Files:**
- Modify: `server/ui/src/pages/ChatPage.tsx`

**Step 1: Add history detection and loading**

When `ChatPage` mounts with a session ID that has no live in-memory session AND is found in the sessions list with status "history", call `loadHistory` instead of `connect`.

Update the `useEffect` that connects:

```typescript
useEffect(() => {
  if (!id) return;
  useSessionsStore.getState().setActiveSession(id);

  const sessions = useSessionsStore.getState().sessions;
  const session = sessions.find((s) => s.id === id);

  if (session?.status === "history") {
    // Load history messages from disk instead of connecting via WebSocket
    loadHistory(id, session.cwd);
  } else {
    connect(id);
  }
  return () => disconnect();
}, [id, connect, disconnect, loadHistory]);
```

Import `loadHistory` from the messages store:
```typescript
const {
  messages, slashCommands, status, connected, pendingApproval, lastError,
  thinkingText, thinkingStartTime, thinkingDurations,
  connect, disconnect, sendPrompt, approve, approveAlways, deny, interrupt,
  loadHistory,
} = useMessagesStore();
```

**Step 2: Enable Composer for history mode**

Currently the Composer is disabled when `isRunning`. For history mode, the Composer should be enabled so the user can type a follow-up. Change:

```typescript
const isRunning = status === "running" || status === "starting";
```

The Composer is already enabled when `isRunning` is false, and `status === "history"` means `isRunning` is false. No change needed here.

**Step 3: Handle the URL change after resume**

When `sendPrompt` creates a new session (resume flow), it calls `setActiveSession(newId)`. The ChatPage needs to navigate to the new session URL. Add this logic.

After the resume call in `sendPrompt` returns a new session ID, use React Router to navigate. Since the store doesn't have access to the router, handle this in ChatPage by watching for session ID changes.

Actually, looking at the flow more carefully: after `sendPrompt` resumes, the store updates `activeSessionId` in the sessions store. We need ChatPage to navigate to the new URL. Add a `useEffect` that watches for the active session changing:

```typescript
const activeSessionId = useSessionsStore((s) => s.activeSessionId);

useEffect(() => {
  // If the active session changed (e.g., after resume), navigate to it
  if (activeSessionId && activeSessionId !== id) {
    navigate(`/session/${activeSessionId}`, { replace: true });
  }
}, [activeSessionId, id, navigate]);
```

**Step 4: Type-check**

Run: `cd server/ui && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add server/ui/src/pages/ChatPage.tsx
git commit -m "feat: ChatPage loads history for CLI sessions and handles resume navigation"
```

---

### Task 9: Build server dist and verify

**Files:**
- Modify: `server/dist/` (rebuilt)

**Step 1: Build server**

Run: `cd server && npm run build`
Expected: Clean build, no errors

**Step 2: Build UI**

Run: `cd server/ui && npm run build`
Expected: Clean build, no errors

**Step 3: Run all server tests**

Run: `cd server && npx vitest run`
Expected: All PASS

**Step 4: Commit dist**

```bash
git add server/dist/
git commit -m "chore: rebuild server dist"
```

---

### Task 10: Verify end-to-end with manual testing

**Step 1: Start the server**

Run: `cd server && API_PASSWORD=test node dist/index.js`

**Step 2: In another terminal, verify the history endpoint**

Find a session ID from `~/.claude/projects/`:
```bash
ls ~/.claude/projects/-Users-andres-Repos-Personal-hatchpod/ | head -1
```

Then test the endpoint:
```bash
curl -s -H "Authorization: Bearer test" http://localhost:8080/api/sessions/<SESSION_ID>/history | python3 -m json.tool | head -30
```

Expected: JSON array of normalized messages with `role`, `parts`, `index` fields.

**Step 3: Open the web UI**

Navigate to `http://localhost:8080`, log in, and click a history session. Verify:
- Messages are displayed
- The Composer is active
- Typing a message resumes the session and transitions to real-time mode

**Step 4: Verify the chat header**

For any session with a summary, the header should show the summary (not the slug).
