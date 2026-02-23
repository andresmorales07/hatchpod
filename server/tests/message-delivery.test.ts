import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, stopServer, resetSessions, api, connectWs, collectMessages, waitForStatus } from "./helpers.js";
import type { ServerMessage } from "../src/types.js";

beforeAll(async () => {
  await startServer();
  await resetSessions();
});

afterAll(async () => {
  await stopServer();
});

describe("Message Delivery", () => {
  it("echoes a message via WebSocket", async () => {
    // Create idle session, then send prompt via WS
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test" }),
    });
    const { id } = await createRes.json();

    const ws = await connectWs(id);
    await collectMessages(ws, (m) => m.type === "replay_complete");

    ws.send(JSON.stringify({ type: "prompt", text: "Hello world" }));

    const messages = await collectMessages(ws, (m) =>
      m.type === "status" && (m as ServerMessage & { status: string }).status === "completed",
    );

    const msgEvents = messages.filter((m) => m.type === "message") as Array<{
      type: string;
      message: { role: string; parts: Array<{ type: string; text?: string }> };
    }>;
    expect(msgEvents.length).toBeGreaterThanOrEqual(1);
    const assistantMsg = msgEvents.find((m) => m.message.role === "assistant");
    expect(assistantMsg).toBeDefined();
    const textPart = assistantMsg!.message.parts.find((p) => p.type === "text");
    expect(textPart?.text).toBe("Echo: Hello world");

    ws.close();
  });

  it("delivers multi-turn sequence via WebSocket", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test" }),
    });
    const { id } = await createRes.json();

    const ws = await connectWs(id);
    await collectMessages(ws, (m) => m.type === "replay_complete");

    ws.send(JSON.stringify({ type: "prompt", text: "[multi-turn] go" }));

    const messages = await collectMessages(ws, (m) =>
      m.type === "status" && (m as ServerMessage & { status: string }).status === "completed",
    );

    // Should have 4 message events: assistant text, tool_use, tool_result, assistant text
    const msgEvents = messages.filter((m) => m.type === "message") as Array<{
      type: string;
      message: { role: string };
    }>;
    expect(msgEvents.length).toBe(4);
    expect(msgEvents[0].message.role).toBe("assistant");
    expect(msgEvents[1].message.role).toBe("assistant"); // tool_use comes from assistant
    expect(msgEvents[2].message.role).toBe("user"); // tool_result
    expect(msgEvents[3].message.role).toBe("assistant");

    ws.close();
  });

  it("sets error status on provider error", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test" }),
    });
    const { id } = await createRes.json();

    const ws = await connectWs(id);
    await collectMessages(ws, (m) => m.type === "replay_complete");

    ws.send(JSON.stringify({ type: "prompt", text: "[error] oops" }));

    const messages = await collectMessages(ws, (m) =>
      m.type === "status" && (m as ServerMessage & { status: string }).status === "error",
    );

    // Verify error status via REST
    const session = await waitForStatus(id, "error") as { status: string; lastError: string };
    expect(session.status).toBe("error");
    expect(session.lastError).toContain("Simulated provider error");

    // Should have at least one message delivered before the error
    const msgEvents = messages.filter((m) => m.type === "message");
    expect(msgEvents.length).toBeGreaterThanOrEqual(1);

    ws.close();
  });
});
