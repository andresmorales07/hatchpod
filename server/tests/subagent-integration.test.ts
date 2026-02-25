import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, stopServer, resetSessions, api, connectWs, collectMessages } from "./helpers.js";
import type { ServerMessage } from "../src/types.js";

type SubagentStartedMsg = Extract<ServerMessage, { type: "subagent_started" }>;
type SubagentToolCallMsg = Extract<ServerMessage, { type: "subagent_tool_call" }>;
type SubagentCompletedMsg = Extract<ServerMessage, { type: "subagent_completed" }>;

beforeAll(async () => {
  await startServer();
  await resetSessions();
});
afterAll(async () => { await stopServer(); });

describe("Subagent live summary integration", () => {
  it("broadcasts subagent_started, subagent_tool_call, subagent_completed via WebSocket", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test" }),
    });
    const { id } = await createRes.json();

    const ws = await connectWs(id);
    await collectMessages(ws, (m) => m.type === "replay_complete");

    ws.send(JSON.stringify({ type: "prompt", text: "[subagent] test" }));

    const messages = await collectMessages(ws, (m) =>
      m.type === "status" && (m as Extract<ServerMessage, { type: "status" }>).status === "completed",
    );

    const started = messages.filter((m): m is SubagentStartedMsg => m.type === "subagent_started");
    const toolCalls = messages.filter((m): m is SubagentToolCallMsg => m.type === "subagent_tool_call");
    const completed = messages.filter((m): m is SubagentCompletedMsg => m.type === "subagent_completed");

    expect(started).toHaveLength(1);
    expect(started[0].toolUseId).toBeTruthy();
    expect(started[0].agentType).toBe("Explore");
    expect(started[0].startedAt).toBeTypeOf("number");

    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(toolCalls[0].toolName).toBeTruthy();

    expect(completed).toHaveLength(1);
    expect(completed[0].status).toBe("completed");

    // Verify subagent_completed arrives before status: completed
    const completedIdx = messages.findIndex((m) => m.type === "subagent_completed");
    const statusCompletedIdx = messages.findIndex(
      (m) => m.type === "status" && (m as Extract<ServerMessage, { type: "status" }>).status === "completed",
    );
    expect(completedIdx).toBeLessThan(statusCompletedIdx);

    ws.close();
  });

  it("replays active subagent state with correct startedAt to late-connecting subscriber", async () => {
    const beforeCreate = Date.now();

    // Create session with immediate prompt — subagent events fire before WS connects
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test", prompt: "[subagent-slow] test" }),
    });
    const { id } = await createRes.json();

    // Wait long enough for subagent_started to be buffered but before session completes
    // (subagent-slow fires started immediately, then waits 200ms for first tool call,
    // total ~300ms for session completion)
    await new Promise((r) => setTimeout(r, 150));

    const ws = await connectWs(id);
    const messages = await collectMessages(ws, (m) =>
      m.type === "status" && (m as Extract<ServerMessage, { type: "status" }>).status === "completed",
    );

    // Should receive replayed subagent_started with correct server-assigned timestamp
    const started = messages.filter((m): m is SubagentStartedMsg => m.type === "subagent_started");
    expect(started.length).toBeGreaterThanOrEqual(1);
    // startedAt should be close to when the session was created, not when we connected
    expect(started[0].startedAt).toBeGreaterThanOrEqual(beforeCreate);
    expect(started[0].startedAt).toBeLessThanOrEqual(Date.now());

    ws.close();
  });
});
