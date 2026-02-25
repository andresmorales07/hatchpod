import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, stopServer, resetSessions, api, connectWs, collectMessages } from "./helpers.js";
import type { ServerMessage } from "../src/types.js";

beforeAll(async () => {
  await startServer();
  await resetSessions();
});

afterAll(async () => {
  await stopServer();
});

describe("Thinking Deltas", () => {
  it("broadcasts thinking_delta frames via WebSocket with correct ordering and content", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test" }),
    });
    const { id } = await createRes.json();

    const ws = await connectWs(id);
    await collectMessages(ws, (m) => m.type === "replay_complete");

    ws.send(JSON.stringify({ type: "prompt", text: "[thinking] test" }));

    const messages = await collectMessages(ws, (m) =>
      m.type === "status" && (m as ServerMessage & { status: string }).status === "completed",
    );

    // Should have exactly 3 thinking_delta frames (one per test adapter emission)
    const thinkingDeltas = messages.filter((m) => m.type === "thinking_delta") as Array<{ type: string; text: string }>;
    expect(thinkingDeltas).toHaveLength(3);

    // Every delta should have a non-empty text field
    expect(thinkingDeltas.every((d) => d.text.length > 0)).toBe(true);

    // Concatenated deltas should exactly match the final reasoning part
    const allDeltaText = thinkingDeltas.map((d) => d.text).join("");
    expect(allDeltaText).toBe("I need to analyze this request carefully.");

    // All thinking_delta frames must arrive before the assistant message
    const lastDeltaIndex = messages.reduce(
      (max, m, i) => (m.type === "thinking_delta" ? i : max), -1,
    );
    const firstMsgIndex = messages.findIndex(
      (m) => m.type === "message" && (m as { message: { role: string } }).message.role === "assistant",
    );
    expect(lastDeltaIndex).toBeLessThan(firstMsgIndex);

    // The complete message should contain a reasoning part with matching text
    const msgEvents = messages.filter((m) => m.type === "message") as Array<{ type: string; message: { role: string; parts: Array<{ type: string; text?: string }> } }>;
    const assistantMsg = msgEvents.find((m) => m.message.role === "assistant");
    expect(assistantMsg).toBeDefined();
    const reasoningPart = assistantMsg!.message.parts.find((p) => p.type === "reasoning");
    expect(reasoningPart).toBeDefined();
    expect(reasoningPart!.text).toBe(allDeltaText);

    ws.close();
  });

  it("does not emit thinking_delta frames for non-thinking prompts", async () => {
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

    const thinkingDeltas = messages.filter((m) => m.type === "thinking_delta");
    expect(thinkingDeltas).toHaveLength(0);

    // Should still have a normal assistant message
    const msgEvents = messages.filter((m) => m.type === "message") as Array<{ type: string; message: { role: string } }>;
    expect(msgEvents.some((m) => m.message.role === "assistant")).toBe(true);

    ws.close();
  });

  it("buffers thinking_delta for late-connecting subscribers (new session with prompt)", async () => {
    // Create session WITH a thinking prompt — runSession() starts immediately
    // and begins emitting thinking_delta events before any WS client connects.
    // Whether or not deltas fired before WS connected, the buffer guarantees
    // we receive the complete concatenated text. This test validates that
    // guarantee under real async scheduling.
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test", prompt: "[thinking] buffered test" }),
    });
    const { id } = await createRes.json();

    // Connect WS after creation returns — by this point, some thinking_delta
    // events may have already been pushed (and buffered by the watcher).
    const ws = await connectWs(id);

    // Collect everything until session completes
    const messages = await collectMessages(ws, (m) =>
      m.type === "status" && (m as ServerMessage & { status: string }).status === "completed",
    );

    // The buffer ensures we receive ALL thinking text, regardless of how many
    // deltas fired before we subscribed. The concatenated text must be complete.
    const thinkingDeltas = messages.filter((m) => m.type === "thinking_delta") as Array<{ type: string; text: string }>;
    const allText = thinkingDeltas.map((d) => d.text).join("");
    expect(allText).toBe("I need to analyze this request carefully.");

    // thinking_delta must arrive before replay_complete (ordering guarantee)
    const firstThinkingIdx = messages.findIndex((m) => m.type === "thinking_delta");
    const replayCompleteIdx = messages.findIndex((m) => m.type === "replay_complete");
    if (firstThinkingIdx >= 0 && replayCompleteIdx >= 0) {
      expect(firstThinkingIdx).toBeLessThan(replayCompleteIdx);
    }

    ws.close();
  });

  it("does not replay thinking_delta on late WebSocket connection", async () => {
    // Create idle session, send prompt via WS, wait for completion, then reconnect
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test" }),
    });
    const { id } = await createRes.json();

    const ws1 = await connectWs(id);
    await collectMessages(ws1, (m) => m.type === "replay_complete");

    ws1.send(JSON.stringify({ type: "prompt", text: "[thinking] test" }));

    await collectMessages(ws1, (m) =>
      m.type === "status" && (m as ServerMessage & { status: string }).status === "completed",
    );
    ws1.close();

    // Reconnect — should NOT get thinking_delta frames in replay
    // (test adapter has no JSONL, so there's nothing to replay at all)
    const ws2 = await connectWs(id);
    const messages = await collectMessages(ws2, (m) => m.type === "replay_complete");

    const thinkingDeltas = messages.filter((m) => m.type === "thinking_delta");
    expect(thinkingDeltas).toHaveLength(0);

    ws2.close();
  });
});
