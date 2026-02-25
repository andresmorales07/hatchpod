import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const testDir = join(tmpdir(), `hatchpod-pagination-test-${Date.now()}`);
const fakeClaudeDir = join(testDir, ".claude", "projects");
const fakeProjectDir = join(fakeClaudeDir, "-home-user-workspace");

let startServer: typeof import("./helpers.js").startServer;
let stopServer: typeof import("./helpers.js").stopServer;
let api: typeof import("./helpers.js").api;
let clearHistoryCache: typeof import("../src/session-history.js").clearHistoryCache;

/**
 * Write a test JSONL session file with N user/assistant message pairs.
 * Returns the session UUID.
 */
function writeTestSession(sessionId: string, messageCount: number, extraLines?: string[]): string {
  const lines: string[] = [];

  // Progress line (skipped by normalizeFileLine)
  lines.push(JSON.stringify({
    type: "progress",
    sessionId,
    cwd: "/home/user/workspace",
    timestamp: "2026-02-20T10:00:00.000Z",
  }));

  for (let i = 0; i < messageCount; i++) {
    // User message
    lines.push(JSON.stringify({
      type: "user",
      sessionId,
      message: { role: "user", content: `User message ${i}` },
      timestamp: `2026-02-20T10:${String(i).padStart(2, "0")}:01.000Z`,
    }));
    // Assistant response
    lines.push(JSON.stringify({
      type: "assistant",
      sessionId,
      message: {
        role: "assistant",
        type: "message",
        content: [{ type: "text", text: `Assistant response ${i}` }],
      },
      timestamp: `2026-02-20T10:${String(i).padStart(2, "0")}:02.000Z`,
    }));
  }

  if (extraLines) lines.push(...extraLines);

  return lines.join("\n") + "\n";
}

beforeAll(async () => {
  process.env.CLAUDE_PROJECTS_DIR = fakeClaudeDir;
  await mkdir(fakeProjectDir, { recursive: true });

  // Import helpers and cache module after setting env
  const helpers = await import("./helpers.js");
  startServer = helpers.startServer;
  stopServer = helpers.stopServer;
  api = helpers.api;

  const historyMod = await import("../src/session-history.js");
  clearHistoryCache = historyMod.clearHistoryCache;

  await startServer();
});

afterAll(async () => {
  await stopServer();
  delete process.env.CLAUDE_PROJECTS_DIR;
  await rm(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  clearHistoryCache();
});

describe("GET /api/sessions/:id/messages — pagination", () => {
  it("returns all messages when no query params", async () => {
    const sid = randomUUID();
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), writeTestSession(sid, 3));

    const res = await api(`/api/sessions/${sid}/messages`);
    expect(res.status).toBe(200);
    const body = await res.json() as { messages: unknown[]; hasMore: boolean; oldestIndex: number };
    // 3 user + 3 assistant = 6 messages
    expect(body.messages).toHaveLength(6);
    expect(body.hasMore).toBe(false);
  });

  it("respects ?limit=N to return last N messages", async () => {
    const sid = randomUUID();
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), writeTestSession(sid, 5));

    const res = await api(`/api/sessions/${sid}/messages?limit=3`);
    expect(res.status).toBe(200);
    const body = await res.json() as { messages: Array<{ index: number }>; hasMore: boolean };
    expect(body.messages).toHaveLength(3);
    expect(body.hasMore).toBe(true);
    // Should be the last 3 messages (indices 7, 8, 9)
    expect(body.messages[0].index).toBe(7);
    expect(body.messages[2].index).toBe(9);
  });

  it("respects ?before=N&limit=M for scroll-back pagination", async () => {
    const sid = randomUUID();
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), writeTestSession(sid, 5));

    const res = await api(`/api/sessions/${sid}/messages?before=5&limit=3`);
    expect(res.status).toBe(200);
    const body = await res.json() as { messages: Array<{ index: number }>; hasMore: boolean; oldestIndex: number };
    expect(body.messages).toHaveLength(3);
    // Messages with index < 5, last 3 of those = indices 2, 3, 4
    expect(body.messages[0].index).toBe(2);
    expect(body.messages[2].index).toBe(4);
    expect(body.oldestIndex).toBe(2);
  });

  it("returns correct oldestIndex", async () => {
    const sid = randomUUID();
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), writeTestSession(sid, 3));

    const res = await api(`/api/sessions/${sid}/messages?limit=2`);
    const body = await res.json() as { messages: Array<{ index: number }>; oldestIndex: number };
    expect(body.oldestIndex).toBe(body.messages[0].index);
  });

  it("sets hasMore=false when all eligible messages fit in limit", async () => {
    const sid = randomUUID();
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), writeTestSession(sid, 2));

    const res = await api(`/api/sessions/${sid}/messages?limit=100`);
    const body = await res.json() as { hasMore: boolean; messages: unknown[] };
    expect(body.hasMore).toBe(false);
    expect(body.messages).toHaveLength(4); // 2 pairs
  });

  it("clamps limit: 0 → default 30", async () => {
    const sid = randomUUID();
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), writeTestSession(sid, 2));

    const res = await api(`/api/sessions/${sid}/messages?limit=0`);
    expect(res.status).toBe(200);
    // With 4 messages and default limit 30, should get all
    const body = await res.json() as { messages: unknown[] };
    expect(body.messages).toHaveLength(4);
  });

  it("clamps limit: 200 → max 100", async () => {
    const sid = randomUUID();
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), writeTestSession(sid, 2));

    const res = await api(`/api/sessions/${sid}/messages?limit=200`);
    expect(res.status).toBe(200);
    // Should still succeed (just clamped)
    const body = await res.json() as { messages: unknown[] };
    expect(body.messages).toHaveLength(4);
  });

  it("clamps limit: negative → min 1", async () => {
    const sid = randomUUID();
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), writeTestSession(sid, 2));

    const res = await api(`/api/sessions/${sid}/messages?limit=-5`);
    expect(res.status).toBe(200);
    // parseInt("-5") || 30 → -5, Math.max(-5, 1) → 1
    const body = await res.json() as { messages: unknown[] };
    expect(body.messages).toHaveLength(1);
  });

  it("extracts tasks from FULL message set, not just the page", async () => {
    const sid = randomUUID();
    // Create a session with a TodoWrite in early messages
    const todoWriteLine = JSON.stringify({
      type: "assistant",
      sessionId: sid,
      message: {
        role: "assistant",
        type: "message",
        content: [
          {
            type: "tool_use",
            id: "tu_todo1",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "Implement auth", status: "in_progress", activeForm: "Implementing auth" },
              ],
            },
          },
        ],
      },
      timestamp: "2026-02-20T10:00:01.000Z",
    });

    // Then add enough later messages that pagination excludes the task messages
    const laterLines: string[] = [];
    for (let i = 0; i < 5; i++) {
      laterLines.push(JSON.stringify({
        type: "user",
        sessionId: sid,
        message: { role: "user", content: `Later message ${i}` },
        timestamp: `2026-02-20T10:1${i}:00.000Z`,
      }));
      laterLines.push(JSON.stringify({
        type: "assistant",
        sessionId: sid,
        message: {
          role: "assistant",
          type: "message",
          content: [{ type: "text", text: `Later response ${i}` }],
        },
        timestamp: `2026-02-20T10:1${i}:01.000Z`,
      }));
    }

    const content = [
      JSON.stringify({ type: "progress", sessionId: sid, cwd: "/home/user/workspace", timestamp: "2026-02-20T10:00:00.000Z" }),
      todoWriteLine,
      ...laterLines,
    ].join("\n") + "\n";
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), content);

    // Paginate to last 3 messages only
    const res = await api(`/api/sessions/${sid}/messages?limit=3`);
    expect(res.status).toBe(200);
    const body = await res.json() as { messages: unknown[]; tasks: Array<{ id: string; subject: string }> };
    expect(body.messages).toHaveLength(3);
    // Tasks should be extracted from ALL messages, not just the page
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]).toMatchObject({ id: "1", subject: "Implement auth" });
  });

  it("returns 404 for random UUID with no JSONL", async () => {
    const res = await api(`/api/sessions/${randomUUID()}/messages`);
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid UUID format (matching route regex)", async () => {
    // "not-a-uuid" doesn't match the route regex [0-9a-f-]{36}, so use
    // a 36-char hex string that matches the route but fails UUID_RE
    const fakeId = "abcdef0123456789abcdef0123456789abcd";
    const res = await api(`/api/sessions/${fakeId}/messages`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid session ID");
  });

  it("returns 400 for unknown provider", async () => {
    const sid = randomUUID();
    const res = await api(`/api/sessions/${sid}/messages?provider=nonexistent`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unknown provider");
  });

  it("returns 400 for non-numeric before parameter", async () => {
    const sid = randomUUID();
    const res = await api(`/api/sessions/${sid}/messages?before=abc`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("before must be a number");
  });
});
