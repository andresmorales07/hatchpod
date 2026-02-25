import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProviderSessionOptions } from "../src/providers/types.js";

/**
 * Mock the Claude Agent SDK so ClaudeAdapter.run() processes our
 * synthetic stream_event / assistant messages instead of hitting the real API.
 */
const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

// Import adapter AFTER the mock is in place
const { ClaudeAdapter } = await import("../src/providers/claude-adapter.js");

/** Create a mock query handle (async iterable + supportedCommands). */
function createMockHandle(messages: Record<string, unknown>[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const msg of messages) {
        yield msg;
      }
    },
    supportedCommands: () => Promise.resolve([]),
  };
}

/** Minimal ProviderSessionOptions for testing. */
function makeOptions(overrides: Partial<ProviderSessionOptions> = {}): ProviderSessionOptions {
  return {
    prompt: "test prompt",
    cwd: "/tmp",
    permissionMode: "default",
    abortSignal: new AbortController().signal,
    onToolApproval: () => Promise.resolve({ allow: true as const }),
    ...overrides,
  };
}

describe("ClaudeAdapter stream_event thinking extraction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls onThinkingDelta for content_block_delta with thinking_delta type", async () => {
    const thinkingDeltas: string[] = [];

    mockQuery.mockReturnValue(
      createMockHandle([
        // stream_event: thinking delta
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "Let me " },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "think about this." },
          },
        },
        // Final assistant message WITHOUT native thinking block
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Here is my answer." }],
          },
        },
        // Result
        {
          type: "result",
          total_cost_usd: 0.01,
          num_turns: 1,
          session_id: "test-session-id",
        },
      ]),
    );

    const adapter = new ClaudeAdapter();
    const gen = adapter.run(
      makeOptions({
        onThinkingDelta: (text: string) => thinkingDeltas.push(text),
      }),
    );

    const messages = [];
    let result;
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        result = next.value;
        break;
      }
      messages.push(next.value);
    }

    // onThinkingDelta should have been called twice
    expect(thinkingDeltas).toEqual(["Let me ", "think about this."]);

    // The assistant message should have accumulated thinking injected as reasoning part
    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    const reasoningPart = assistantMsg!.parts.find((p) => p.type === "reasoning");
    expect(reasoningPart).toBeDefined();
    expect(reasoningPart!.text).toBe("Let me think about this.");

    // Text part should also be present
    const textPart = assistantMsg!.parts.find((p) => p.type === "text");
    expect(textPart).toBeDefined();
    expect(textPart!.text).toBe("Here is my answer.");

    expect(result).toMatchObject({ providerSessionId: "test-session-id" });
  });

  it("does NOT call onThinkingDelta for text_delta stream events", async () => {
    const thinkingDeltas: string[] = [];

    mockQuery.mockReturnValue(
      createMockHandle([
        // stream_event: text delta (not thinking)
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Hello world" },
          },
        },
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Hello world" }],
          },
        },
        { type: "result", total_cost_usd: 0, num_turns: 1 },
      ]),
    );

    const adapter = new ClaudeAdapter();
    const gen = adapter.run(
      makeOptions({
        onThinkingDelta: (text: string) => thinkingDeltas.push(text),
      }),
    );

    // Drain generator
    while (!(await gen.next()).done) { /* exhaust */ }

    expect(thinkingDeltas).toHaveLength(0);
  });

  it("does NOT duplicate thinking when assistant has native thinking block", async () => {
    const thinkingDeltas: string[] = [];

    mockQuery.mockReturnValue(
      createMockHandle([
        // stream_event: thinking delta
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "Deep thought." },
          },
        },
        // Assistant message WITH native thinking block (SDK already included it)
        {
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "Deep thought." },
              { type: "text", text: "My answer." },
            ],
          },
        },
        { type: "result", total_cost_usd: 0, num_turns: 1 },
      ]),
    );

    const adapter = new ClaudeAdapter();
    const gen = adapter.run(
      makeOptions({
        onThinkingDelta: (text: string) => thinkingDeltas.push(text),
      }),
    );

    const messages = [];
    for (;;) {
      const next = await gen.next();
      if (next.done) break;
      messages.push(next.value);
    }

    // onThinkingDelta should still have been called (live streaming)
    expect(thinkingDeltas).toEqual(["Deep thought."]);

    // But the finalized message should only have ONE reasoning part (native, not duplicated)
    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    const reasoningParts = assistantMsg!.parts.filter((p) => p.type === "reasoning");
    expect(reasoningParts).toHaveLength(1);
    expect(reasoningParts[0].text).toBe("Deep thought.");
  });

  it("resets accumulated thinking between consecutive assistant messages", async () => {
    const thinkingDeltas: string[] = [];

    mockQuery.mockReturnValue(
      createMockHandle([
        // First thinking + assistant
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "First thought." },
          },
        },
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "First answer." }],
          },
        },
        // Second assistant with NO thinking deltas preceding it
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Second answer." }],
          },
        },
        { type: "result", total_cost_usd: 0, num_turns: 2 },
      ]),
    );

    const adapter = new ClaudeAdapter();
    const gen = adapter.run(
      makeOptions({
        onThinkingDelta: (text: string) => thinkingDeltas.push(text),
      }),
    );

    const messages = [];
    for (;;) {
      const next = await gen.next();
      if (next.done) break;
      messages.push(next.value);
    }

    const assistantMsgs = messages.filter((m) => m.role === "assistant");
    expect(assistantMsgs).toHaveLength(2);

    // First should have injected reasoning
    expect(assistantMsgs[0].parts.some((p) => p.type === "reasoning")).toBe(true);
    expect(assistantMsgs[0].parts.find((p) => p.type === "reasoning")?.text).toBe("First thought.");

    // Second should NOT have reasoning (accumulated thinking was already consumed)
    expect(assistantMsgs[1].parts.some((p) => p.type === "reasoning")).toBe(false);
  });
});
