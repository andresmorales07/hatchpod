import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, stopServer, resetSessions, api, waitForStatus } from "./helpers.js";

beforeAll(async () => {
  await startServer();
  await resetSessions();
});

afterAll(async () => {
  await stopServer();
});

describe("Message Delivery", () => {
  it("echoes a message via REST polling", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt: "Hello world", provider: "test" }),
    });
    const { id } = await createRes.json();

    const session = await waitForStatus(id, "completed") as {
      messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>;
    };

    expect(session.messages.length).toBeGreaterThanOrEqual(1);
    const assistantMsg = session.messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    const textPart = assistantMsg!.parts.find((p) => p.type === "text");
    expect(textPart?.text).toBe("Echo: Hello world");
  });

  it("delivers multi-turn sequence", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt: "[multi-turn] go", provider: "test" }),
    });
    const { id } = await createRes.json();

    const session = await waitForStatus(id, "completed") as {
      messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>;
    };

    // Should have 4 messages: assistant text, tool_use, tool_result, assistant text
    expect(session.messages.length).toBe(4);
    expect(session.messages[0].role).toBe("assistant");
    expect(session.messages[1].role).toBe("assistant"); // tool_use comes from assistant
    expect(session.messages[2].role).toBe("user"); // tool_result
    expect(session.messages[3].role).toBe("assistant");
  });

  it("sets error status with partial messages on provider error", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt: "[error] oops", provider: "test" }),
    });
    const { id } = await createRes.json();

    const session = await waitForStatus(id, "error") as {
      status: string;
      lastError: string;
      messages: Array<{ role: string }>;
    };

    expect(session.status).toBe("error");
    expect(session.lastError).toContain("Simulated provider error");
    // Should have the partial message that was yielded before the error
    expect(session.messages.length).toBeGreaterThanOrEqual(1);
  });

  it("returns cost and turns in completed session", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt: "cost test", provider: "test" }),
    });
    const { id } = await createRes.json();

    const session = await waitForStatus(id, "completed") as {
      totalCostUsd: number;
      numTurns: number;
    };

    expect(session.totalCostUsd).toBe(0.001);
    expect(session.numTurns).toBeGreaterThanOrEqual(1);
  });
});
