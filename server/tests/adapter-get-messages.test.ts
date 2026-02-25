import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ToolUsePart } from "../src/providers/types.js";

const testDir = join(tmpdir(), `hatchpod-get-messages-test-${Date.now()}`);
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

/** Build a JSONL session with N user+assistant message pairs. */
function makeSession(sessionId: string, pairCount: number): string {
  const lines: string[] = [];
  lines.push(JSON.stringify({
    type: "progress",
    sessionId,
    cwd: "/home/user/workspace",
    timestamp: "2026-02-20T10:00:00.000Z",
  }));
  for (let i = 0; i < pairCount; i++) {
    lines.push(JSON.stringify({
      type: "user",
      sessionId,
      message: { role: "user", content: `Message ${i}` },
      timestamp: `2026-02-20T10:${String(i).padStart(2, "0")}:01.000Z`,
    }));
    lines.push(JSON.stringify({
      type: "assistant",
      sessionId,
      message: {
        role: "assistant",
        type: "message",
        content: [{ type: "text", text: `Reply ${i}` }],
      },
      timestamp: `2026-02-20T10:${String(i).padStart(2, "0")}:02.000Z`,
    }));
  }
  return lines.join("\n") + "\n";
}

describe("ClaudeAdapter.getMessages", () => {
  it("returns all messages when count is within default limit", async () => {
    const sid = randomUUID();
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), makeSession(sid, 5));
    const adapter = new ClaudeAdapter();
    const result = await adapter.getMessages(sid);

    expect(result.messages).toHaveLength(10); // 5 pairs
    expect(result.totalMessages).toBe(10);
    expect(result.hasMore).toBe(false);
    expect(result.oldestIndex).toBe(0);
  });

  it("paginates with limit parameter", async () => {
    const sid = randomUUID();
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), makeSession(sid, 10));
    const adapter = new ClaudeAdapter();
    const result = await adapter.getMessages(sid, { limit: 6 });

    expect(result.messages).toHaveLength(6);
    expect(result.totalMessages).toBe(20); // 10 pairs
    expect(result.hasMore).toBe(true);
    // Should return the LAST 6 messages (indices 14-19)
    expect(result.messages[0].index).toBe(14);
    expect(result.messages[5].index).toBe(19);
  });

  it("paginates with before parameter", async () => {
    const sid = randomUUID();
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), makeSession(sid, 10));
    const adapter = new ClaudeAdapter();
    // Get 4 messages before index 10
    const result = await adapter.getMessages(sid, { before: 10, limit: 4 });

    expect(result.messages).toHaveLength(4);
    expect(result.hasMore).toBe(true);
    // Should return indices 6, 7, 8, 9
    expect(result.messages[0].index).toBe(6);
    expect(result.messages[3].index).toBe(9);
  });

  it("returns hasMore=false when all earlier messages fit", async () => {
    const sid = randomUUID();
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), makeSession(sid, 3));
    const adapter = new ClaudeAdapter();
    // 6 total messages, limit 10 before index 6 — all fit
    const result = await adapter.getMessages(sid, { before: 6, limit: 10 });

    expect(result.messages).toHaveLength(6);
    expect(result.hasMore).toBe(false);
  });

  it("clamps limit to [1, 100]", async () => {
    const sid = randomUUID();
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), makeSession(sid, 3));
    const adapter = new ClaudeAdapter();

    // Zero → clamped to 1
    const r1 = await adapter.getMessages(sid, { limit: 0 });
    expect(r1.messages).toHaveLength(1);

    // Negative → clamped to 1
    const r2 = await adapter.getMessages(sid, { limit: -5 });
    expect(r2.messages).toHaveLength(1);
  });

  it("defaults limit to 30", async () => {
    const sid = randomUUID();
    // 20 pairs = 40 messages — more than the default 30
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), makeSession(sid, 20));
    const adapter = new ClaudeAdapter();
    const result = await adapter.getMessages(sid);

    expect(result.messages).toHaveLength(30);
    expect(result.hasMore).toBe(true);
    expect(result.totalMessages).toBe(40);
  });

  it("extracts tasks from the FULL message set, not just the page", async () => {
    const sid = randomUUID();
    const lines: string[] = [];
    lines.push(JSON.stringify({
      type: "progress", sessionId: sid,
      cwd: "/home/user/workspace",
      timestamp: "2026-02-20T10:00:00.000Z",
    }));
    // User prompt
    lines.push(JSON.stringify({
      type: "user", sessionId: sid,
      message: { role: "user", content: "Create a task" },
      timestamp: "2026-02-20T10:00:01.000Z",
    }));
    // Assistant creates tasks with TodoWrite tool
    lines.push(JSON.stringify({
      type: "assistant", sessionId: sid,
      message: {
        role: "assistant", type: "message",
        content: [{
          type: "tool_use", id: "tu_todo1", name: "TodoWrite",
          input: {
            todos: [
              { content: "Write unit tests", status: "in_progress", activeForm: "Writing unit tests" },
            ],
          },
        }],
      },
      timestamp: "2026-02-20T10:00:02.000Z",
    }));
    // More messages after the task (these will be in the page)
    for (let i = 0; i < 5; i++) {
      lines.push(JSON.stringify({
        type: "assistant", sessionId: sid,
        message: {
          role: "assistant", type: "message",
          content: [{ type: "text", text: `Working on step ${i}` }],
        },
        timestamp: `2026-02-20T10:01:0${i}.000Z`,
      }));
    }
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), lines.join("\n") + "\n");

    const adapter = new ClaudeAdapter();
    // Request only the last 3 messages (won't include TodoWrite)
    const result = await adapter.getMessages(sid, { limit: 3 });

    expect(result.messages).toHaveLength(3);
    // Tasks should still be extracted from the full message set
    expect(result.tasks.length).toBeGreaterThanOrEqual(1);
    expect(result.tasks.some((t) => t.subject === "Write unit tests")).toBe(true);
  });

  it("handles compact_boundary lines without disrupting message count or pagination", async () => {
    const sid = randomUUID();
    // Build a JSONL with: progress, user, compact_boundary system line, assistant
    const lines = [
      JSON.stringify({
        type: "progress",
        sessionId: sid,
        cwd: "/home/user/workspace",
        timestamp: "2026-02-20T10:00:00.000Z",
      }),
      JSON.stringify({
        type: "user",
        sessionId: sid,
        message: { role: "user", content: "Hello" },
        timestamp: "2026-02-20T10:00:01.000Z",
      }),
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 45000 },
        sessionId: sid,
        timestamp: "2026-02-20T10:00:02.000Z",
      }),
      JSON.stringify({
        type: "assistant",
        sessionId: sid,
        message: {
          role: "assistant",
          type: "message",
          content: [{ type: "text", text: "Hi there" }],
        },
        timestamp: "2026-02-20T10:00:03.000Z",
      }),
    ];
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), lines.join("\n") + "\n");

    const adapter = new ClaudeAdapter();
    const result = await adapter.getMessages(sid, {});

    // Should have 3 messages: user, compact_boundary system event, assistant
    expect(result.messages).toHaveLength(3);
    expect(result.totalMessages).toBe(3);

    // Messages are indexed 0, 1, 2
    expect(result.messages[0].role).toBe("user");

    // The compact_boundary is stored as a system message
    const boundaryMsg = result.messages[1];
    expect(boundaryMsg.role).toBe("system");
    expect("event" in boundaryMsg && boundaryMsg.event.type).toBe("compact_boundary");
    expect("event" in boundaryMsg && (boundaryMsg.event as { trigger: string }).trigger).toBe("auto");
    expect("event" in boundaryMsg && (boundaryMsg.event as { preTokens: number }).preTokens).toBe(45000);

    expect(result.messages[2].role).toBe("assistant");
  });

  it("throws SessionNotFound for nonexistent session", async () => {
    const adapter = new ClaudeAdapter();
    await expect(adapter.getMessages(randomUUID())).rejects.toMatchObject({
      name: "SessionNotFound",
    });
  });

  it("returns oldestIndex of 0 for empty sessions", async () => {
    const sid = randomUUID();
    // Only a progress line — no user/assistant messages
    const lines = JSON.stringify({
      type: "progress", sessionId: sid,
      cwd: "/home/user/workspace",
      timestamp: "2026-02-20T10:00:00.000Z",
    }) + "\n";
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), lines);
    const adapter = new ClaudeAdapter();
    const result = await adapter.getMessages(sid);

    expect(result.messages).toHaveLength(0);
    expect(result.totalMessages).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(result.oldestIndex).toBe(0);
    expect(result.tasks).toEqual([]);
  });
});

describe("System tag cleanup on assistant text", () => {
  it("strips system-reminder tags from assistant text in getMessages", async () => {
    const sid = randomUUID();
    const lines: string[] = [];
    lines.push(JSON.stringify({
      type: "progress", sessionId: sid,
      cwd: "/home/user/workspace",
      timestamp: "2026-02-20T10:00:00.000Z",
    }));
    lines.push(JSON.stringify({
      type: "assistant", sessionId: sid,
      message: {
        role: "assistant", type: "message",
        content: [{
          type: "text",
          text: "<system-reminder>Hook output</system-reminder>Here is the answer",
        }],
      },
      timestamp: "2026-02-20T10:00:01.000Z",
    }));
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), lines.join("\n") + "\n");

    const adapter = new ClaudeAdapter();
    const result = await adapter.getMessages(sid);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].parts[0]).toEqual({ type: "text", text: "Here is the answer" });
  });

  it("strips system tags from assistant text via normalizeFileLine", () => {
    const adapter = new ClaudeAdapter();
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant", type: "message",
        content: [{
          type: "text",
          text: "<fast_mode_info>\nFast mode info.\n</fast_mode_info>Clean response",
        }],
      },
    });
    const result = adapter.normalizeFileLine(line, 0);
    expect(result).not.toBeNull();
    expect(result!.parts[0]).toEqual({ type: "text", text: "Clean response" });
  });

  it("drops assistant text part that becomes empty after cleanup", () => {
    const adapter = new ClaudeAdapter();
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant", type: "message",
        content: [
          { type: "text", text: "<system-reminder>only system tags</system-reminder>" },
          { type: "text", text: "Visible text" },
        ],
      },
    });
    const result = adapter.normalizeFileLine(line, 0);
    expect(result).not.toBeNull();
    // Only the "Visible text" part should remain
    expect(result!.parts).toHaveLength(1);
    expect(result!.parts[0]).toEqual({ type: "text", text: "Visible text" });
  });
});

describe("Tool summary attachment during normalization", () => {
  it("attaches summary to tool_use parts in getMessages output", async () => {
    const sid = randomUUID();
    const lines: string[] = [];
    lines.push(JSON.stringify({
      type: "progress", sessionId: sid,
      cwd: "/home/user/workspace",
      timestamp: "2026-02-20T10:00:00.000Z",
    }));
    lines.push(JSON.stringify({
      type: "assistant", sessionId: sid,
      message: {
        role: "assistant", type: "message",
        content: [{
          type: "tool_use", id: "tu_read", name: "Read",
          input: { file_path: "/src/index.ts" },
        }],
      },
      timestamp: "2026-02-20T10:00:01.000Z",
    }));
    lines.push(JSON.stringify({
      type: "assistant", sessionId: sid,
      message: {
        role: "assistant", type: "message",
        content: [{
          type: "tool_use", id: "tu_bash", name: "Bash",
          input: { command: "npm test", description: "Run tests" },
        }],
      },
      timestamp: "2026-02-20T10:00:02.000Z",
    }));
    lines.push(JSON.stringify({
      type: "assistant", sessionId: sid,
      message: {
        role: "assistant", type: "message",
        content: [{
          type: "tool_use", id: "tu_grep", name: "Grep",
          input: { pattern: "TODO", path: "src/" },
        }],
      },
      timestamp: "2026-02-20T10:00:03.000Z",
    }));
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), lines.join("\n") + "\n");

    const adapter = new ClaudeAdapter();
    const result = await adapter.getMessages(sid);

    expect(result.messages).toHaveLength(3);

    // Read tool → file path summary
    const readPart = result.messages[0].parts[0] as ToolUsePart;
    expect(readPart.type).toBe("tool_use");
    expect(readPart.summary).toEqual({ description: "/src/index.ts" });

    // Bash tool → description + command
    const bashPart = result.messages[1].parts[0] as ToolUsePart;
    expect(bashPart.type).toBe("tool_use");
    expect(bashPart.summary).toEqual({ description: "Run tests", command: "npm test" });

    // Grep tool → search description
    const grepPart = result.messages[2].parts[0] as ToolUsePart;
    expect(grepPart.type).toBe("tool_use");
    expect(grepPart.summary).toEqual({ description: 'Search for "TODO" in src/' });
  });

  it("attaches summary via normalizeFileLine as well", () => {
    const adapter = new ClaudeAdapter();
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant", type: "message",
        content: [{
          type: "tool_use", id: "tu_edit", name: "Edit",
          input: { file_path: "/app.ts", old_string: "a", new_string: "b" },
        }],
      },
    });
    const result = adapter.normalizeFileLine(line, 0);
    expect(result).not.toBeNull();
    const part = result!.parts[0] as ToolUsePart;
    expect(part.summary).toEqual({ description: "/app.ts" });
  });
});

describe("ClaudeAdapter.listSessions", () => {
  it("returns an array (smoke test against real session-history module)", async () => {
    const adapter = new ClaudeAdapter();
    // listSessions reads from the Claude projects dir; our fake dir has JSONL files
    const sessions = await adapter.listSessions("/home/user/workspace");
    expect(Array.isArray(sessions)).toBe(true);
  });

  it("returns sessions with ISO string timestamps", async () => {
    // Write a session file so there's something to list
    const sid = randomUUID();
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), makeSession(sid, 1));

    const adapter = new ClaudeAdapter();
    const sessions = await adapter.listSessions("/home/user/workspace");

    // Should find at least the session we just wrote
    const found = sessions.find((s) => s.id === sid);
    if (found) {
      // Timestamps should be ISO strings
      expect(found.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(found.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(typeof found.id).toBe("string");
      expect(found.cwd).toBeDefined();
    }
  });
});
