import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionWatcher } from "../src/session-watcher.js";
import type { ProviderAdapter } from "../src/providers/types.js";

/** Minimal mock adapter. */
function createMockAdapter(): ProviderAdapter {
  return {
    name: "test", id: "test",
    run: vi.fn() as any,
    getSessionHistory: vi.fn().mockResolvedValue([]),
    getMessages: vi.fn().mockResolvedValue({ messages: [], tasks: [], totalMessages: 0, hasMore: false, oldestIndex: 0 }),
    listSessions: vi.fn().mockResolvedValue([]),
    getSessionFilePath: vi.fn().mockResolvedValue(null),
    normalizeFileLine: vi.fn().mockReturnValue(null),
  };
}

/** Minimal mock WebSocket. */
function createMockWs(): any {
  const messages: unknown[] = [];
  return {
    readyState: 1,
    send: vi.fn((data: string) => messages.push(JSON.parse(data))),
    _messages: messages,
  };
}

describe("SessionWatcher subagent buffering", () => {
  let watcher: SessionWatcher;

  beforeEach(() => {
    watcher = new SessionWatcher(createMockAdapter());
  });

  it("buffers subagent_started and broadcasts to clients", () => {
    const ws = createMockWs();
    watcher.setMode("s1", "push");
    (watcher as any).sessions.get("s1")!.clients.add(ws);

    watcher.pushEvent("s1", {
      type: "subagent_started",
      taskId: "t1",
      toolUseId: "tu1",
      description: "Find files",
      agentType: "Explore",
    });

    // Should broadcast
    expect(ws._messages).toHaveLength(1);
    expect(ws._messages[0]).toMatchObject({ type: "subagent_started", toolUseId: "tu1" });

    // Should buffer
    const watched = (watcher as any).sessions.get("s1")!;
    expect(watched.activeSubagents.size).toBe(1);
    expect(watched.activeSubagents.get("tu1")).toMatchObject({
      taskId: "t1", description: "Find files",
    });
  });

  it("appends tool calls to buffered subagent and broadcasts", () => {
    watcher.setMode("s1", "push");
    const watched = (watcher as any).sessions.get("s1")!;
    watched.activeSubagents = new Map([
      ["tu1", { taskId: "t1", description: "Find files", toolCalls: [], startedAt: Date.now() }],
    ]);

    const ws = createMockWs();
    watched.clients.add(ws);

    watcher.pushEvent("s1", {
      type: "subagent_tool_call",
      toolUseId: "tu1",
      toolName: "Grep",
      summary: { description: "Search for pattern" },
    });

    expect(ws._messages).toHaveLength(1);
    expect(watched.activeSubagents.get("tu1")!.toolCalls).toHaveLength(1);
    expect(watched.activeSubagents.get("tu1")!.toolCalls[0].toolName).toBe("Grep");
  });

  it("removes buffer on subagent_completed and broadcasts", () => {
    watcher.setMode("s1", "push");
    const watched = (watcher as any).sessions.get("s1")!;
    watched.activeSubagents = new Map([
      ["tu1", { taskId: "t1", description: "Find files", toolCalls: [], startedAt: Date.now() }],
    ]);

    const ws = createMockWs();
    watched.clients.add(ws);

    watcher.pushEvent("s1", {
      type: "subagent_completed",
      taskId: "t1",
      toolUseId: "tu1",
      status: "completed",
      summary: "Found 3 files",
    });

    expect(ws._messages).toHaveLength(1);
    expect(watched.activeSubagents.size).toBe(0);
  });

  it("clears all subagent buffers on terminal session status (completed)", () => {
    watcher.setMode("s1", "push");
    const watched = (watcher as any).sessions.get("s1")!;
    watched.activeSubagents = new Map([
      ["tu1", { taskId: "t1", description: "Find files", toolCalls: [], startedAt: Date.now() }],
      ["tu2", { taskId: "t2", description: "Read code", toolCalls: [], startedAt: Date.now() }],
    ]);

    watcher.pushEvent("s1", { type: "status", status: "completed" } as any);

    expect(watched.activeSubagents.size).toBe(0);
  });

  it("clears all subagent buffers on terminal session status (error)", () => {
    watcher.setMode("s1", "push");
    const watched = (watcher as any).sessions.get("s1")!;
    watched.activeSubagents = new Map([
      ["tu1", { taskId: "t1", description: "Find files", toolCalls: [], startedAt: Date.now() }],
    ]);

    watcher.pushEvent("s1", { type: "status", status: "error" } as any);

    expect(watched.activeSubagents.size).toBe(0);
  });

  it("clears all subagent buffers on terminal session status (interrupted)", () => {
    watcher.setMode("s1", "push");
    const watched = (watcher as any).sessions.get("s1")!;
    watched.activeSubagents = new Map([
      ["tu1", { taskId: "t1", description: "Find files", toolCalls: [], startedAt: Date.now() }],
    ]);

    watcher.pushEvent("s1", { type: "status", status: "interrupted" } as any);

    expect(watched.activeSubagents.size).toBe(0);
  });

  it("warns and no-ops for subagent_tool_call with unknown toolUseId", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    watcher.setMode("s1", "push");

    watcher.pushEvent("s1", {
      type: "subagent_tool_call",
      toolUseId: "tu-unknown",
      toolName: "Grep",
      summary: { description: "Search for pattern" },
    });

    const watched = (watcher as any).sessions.get("s1")!;
    expect(watched.activeSubagents.size).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unknown toolUseId"));
    warnSpy.mockRestore();
  });

  it("replays active subagent state to new subscribers", async () => {
    watcher.setMode("s1", "push");
    const watched = (watcher as any).sessions.get("s1")!;
    const startedAt = Date.now() - 5000; // 5 seconds ago
    watched.activeSubagents = new Map([
      ["tu1", {
        taskId: "t1", description: "Find files", agentType: "Explore",
        toolCalls: [
          { toolName: "Grep", summary: { description: "Search for auth" } },
          { toolName: "Read", summary: { description: "/src/auth.ts" } },
        ],
        startedAt,
      }],
    ]);

    const ws = createMockWs();
    await watcher.subscribe("s1", ws);

    // Should receive: subagent_started, 2x subagent_tool_call, replay_complete
    const types = ws._messages.map((m: any) => m.type);
    expect(types).toContain("subagent_started");
    expect(types.filter((t: string) => t === "subagent_tool_call")).toHaveLength(2);
    expect(types[types.length - 1]).toBe("replay_complete");

    // Replayed subagent_started must include the original startedAt (not current time)
    const startedMsg = ws._messages.find((m: any) => m.type === "subagent_started");
    expect(startedMsg).toBeDefined();
    expect((startedMsg as any).startedAt).toBe(startedAt);
  });

  it("does not replay subagent state after completion", async () => {
    watcher.setMode("s1", "push");
    const watched = (watcher as any).sessions.get("s1")!;
    // Empty activeSubagents — already completed
    watched.activeSubagents = new Map();

    const ws = createMockWs();
    await watcher.subscribe("s1", ws);

    const types = ws._messages.map((m: any) => m.type);
    expect(types).not.toContain("subagent_started");
    expect(types).not.toContain("subagent_tool_call");
    expect(types[types.length - 1]).toBe("replay_complete");
  });

  it("handles parallel subagents independently", () => {
    watcher.setMode("s1", "push");
    const ws = createMockWs();
    (watcher as any).sessions.get("s1")!.clients.add(ws);

    // Start two subagents
    watcher.pushEvent("s1", { type: "subagent_started", taskId: "t1", toolUseId: "tu1", description: "Agent 1" });
    watcher.pushEvent("s1", { type: "subagent_started", taskId: "t2", toolUseId: "tu2", description: "Agent 2" });

    const watched = (watcher as any).sessions.get("s1")!;
    expect(watched.activeSubagents.size).toBe(2);

    // Complete one
    watcher.pushEvent("s1", { type: "subagent_completed", taskId: "t1", toolUseId: "tu1", status: "completed", summary: "Done 1" });
    expect(watched.activeSubagents.size).toBe(1);
    expect(watched.activeSubagents.has("tu2")).toBe(true);
  });
});
