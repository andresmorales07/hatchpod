import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

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
  // User message with string content
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

  it("throws SessionNotFound for nonexistent session", async () => {
    const adapter = new ClaudeAdapter();
    await expect(adapter.getSessionHistory!(randomUUID())).rejects.toThrow(/Session file not found/);
  });

  it("indexes messages sequentially", async () => {
    const sid = randomUUID();
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), makeFullJsonl(sid));

    const adapter = new ClaudeAdapter();
    const messages = await adapter.getSessionHistory!(sid);
    messages.forEach((m, i) => expect(m.index).toBe(i));
  });
});
