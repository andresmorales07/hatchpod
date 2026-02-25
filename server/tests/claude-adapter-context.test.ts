import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProviderSessionOptions, NormalizedMessage } from "../src/providers/types.js";

/**
 * Mock the Claude Agent SDK so ClaudeAdapter.run() processes our
 * synthetic messages instead of hitting the real API.
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

/** Drain the generator and collect messages + return value. */
async function drainGenerator(gen: AsyncGenerator<NormalizedMessage, unknown, undefined>) {
  const messages: NormalizedMessage[] = [];
  let result;
  for (;;) {
    const next = await gen.next();
    if (next.done) {
      result = next.value;
      break;
    }
    messages.push(next.value);
  }
  return { messages, result };
}

describe("ClaudeAdapter compacting and context usage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls onCompacting(true) then onCompacting(false) for SDKStatusMessage compacting events", async () => {
    const compactingStates: boolean[] = [];

    mockQuery.mockReturnValue(
      createMockHandle([
        // SDKStatusMessage: compacting start
        { type: "system", subtype: "status", status: "compacting", uuid: "u1", session_id: "s1" },
        // SDKStatusMessage: compacting end
        { type: "system", subtype: "status", status: null, uuid: "u2", session_id: "s1" },
        // Final assistant message
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "After compacting." }] },
        },
        { type: "result", total_cost_usd: 0.01, num_turns: 1, session_id: "s1" },
      ]),
    );

    const adapter = new ClaudeAdapter();
    const { messages } = await drainGenerator(
      adapter.run(
        makeOptions({
          onCompacting: (isCompacting) => compactingStates.push(isCompacting),
        }),
      ),
    );

    expect(compactingStates).toEqual([true, false]);
    // System messages should not produce normalized messages
    const assistantMsgs = messages.filter((m) => m.role === "assistant");
    expect(assistantMsgs).toHaveLength(1);
  });

  it("yields a compact_boundary NormalizedMessage for SDKCompactBoundaryMessage", async () => {
    mockQuery.mockReturnValue(
      createMockHandle([
        // SDKCompactBoundaryMessage
        {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 45000 },
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "After boundary." }] },
        },
        { type: "result", total_cost_usd: 0.01, num_turns: 1, session_id: "s1" },
      ]),
    );

    const adapter = new ClaudeAdapter();
    const { messages } = await drainGenerator(adapter.run(makeOptions()));

    const boundaryMsg = messages.find(
      (m) => m.role === "system" && "event" in m && m.event.type === "compact_boundary",
    );
    expect(boundaryMsg).toBeDefined();
    if (boundaryMsg?.role === "system" && "event" in boundaryMsg) {
      expect(boundaryMsg.event).toEqual({
        type: "compact_boundary",
        trigger: "auto",
        preTokens: 45000,
      });
    }

    // compact_boundary should get a unique index
    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(boundaryMsg!.index).toBeLessThan(assistantMsg!.index);
  });

  it("yields compact_boundary with manual trigger", async () => {
    mockQuery.mockReturnValue(
      createMockHandle([
        {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "manual", pre_tokens: 12000 },
        },
        { type: "result", total_cost_usd: 0, num_turns: 0, session_id: "s1" },
      ]),
    );

    const adapter = new ClaudeAdapter();
    const { messages } = await drainGenerator(adapter.run(makeOptions()));

    const boundaryMsg = messages.find(
      (m) => m.role === "system" && "event" in m && m.event.type === "compact_boundary",
    );
    expect(boundaryMsg).toBeDefined();
    if (boundaryMsg?.role === "system" && "event" in boundaryMsg) {
      expect(boundaryMsg.event.trigger).toBe("manual");
      expect(boundaryMsg.event.preTokens).toBe(12000);
    }
  });

  it("calls onContextUsage from SDKResultMessage modelUsage", async () => {
    const usageUpdates: Array<{ inputTokens: number; contextWindow: number }> = [];

    mockQuery.mockReturnValue(
      createMockHandle([
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Hello." }] },
        },
        {
          type: "result",
          total_cost_usd: 0.05,
          num_turns: 1,
          session_id: "s1",
          modelUsage: {
            "claude-opus-4-6": {
              inputTokens: 30000,
              outputTokens: 500,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              webSearchRequests: 0,
              costUSD: 0.05,
              contextWindow: 200000,
              maxOutputTokens: 16384,
            },
          },
        },
      ]),
    );

    const adapter = new ClaudeAdapter();
    await drainGenerator(
      adapter.run(
        makeOptions({
          onContextUsage: (usage) => usageUpdates.push(usage),
        }),
      ),
    );

    expect(usageUpdates).toHaveLength(1);
    expect(usageUpdates[0]).toEqual({ inputTokens: 30000, contextWindow: 200000 });
  });

  it("calls onContextUsage from assistant message usage after contextWindow is cached", async () => {
    const usageUpdates: Array<{ inputTokens: number; contextWindow: number }> = [];

    mockQuery.mockReturnValue(
      createMockHandle([
        // First turn
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "First." }],
            usage: { input_tokens: 10000 },
          },
        },
        {
          type: "result",
          total_cost_usd: 0.01,
          num_turns: 1,
          session_id: "s1",
          modelUsage: {
            "claude-opus-4-6": {
              inputTokens: 10000,
              outputTokens: 200,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              webSearchRequests: 0,
              costUSD: 0.01,
              contextWindow: 200000,
              maxOutputTokens: 16384,
            },
          },
        },
        // Second turn (assistant message with usage)
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Second." }],
            usage: { input_tokens: 25000 },
          },
        },
        {
          type: "result",
          total_cost_usd: 0.02,
          num_turns: 2,
          session_id: "s1",
          modelUsage: {
            "claude-opus-4-6": {
              inputTokens: 25000,
              outputTokens: 300,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              webSearchRequests: 0,
              costUSD: 0.02,
              contextWindow: 200000,
              maxOutputTokens: 16384,
            },
          },
        },
      ]),
    );

    const adapter = new ClaudeAdapter();
    await drainGenerator(
      adapter.run(
        makeOptions({
          onContextUsage: (usage) => usageUpdates.push(usage),
        }),
      ),
    );

    // First result → onContextUsage from modelUsage
    // Second assistant → onContextUsage from assistant.message.usage (cachedContextWindow is set)
    // Second result → onContextUsage from modelUsage
    expect(usageUpdates.length).toBeGreaterThanOrEqual(2);
    // The second assistant call should use the cached context window
    const secondAssistantCall = usageUpdates.find((u) => u.inputTokens === 25000);
    expect(secondAssistantCall).toBeDefined();
    expect(secondAssistantCall!.contextWindow).toBe(200000);
  });

  it("does not call onContextUsage for assistant messages before contextWindow is cached", async () => {
    const usageUpdates: Array<{ inputTokens: number; contextWindow: number }> = [];

    mockQuery.mockReturnValue(
      createMockHandle([
        // Assistant message with usage but NO preceding result (contextWindow not cached)
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "First." }],
            usage: { input_tokens: 10000 },
          },
        },
        {
          type: "result",
          total_cost_usd: 0.01,
          num_turns: 1,
          session_id: "s1",
          modelUsage: {
            "claude-opus-4-6": {
              inputTokens: 10000,
              outputTokens: 200,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              webSearchRequests: 0,
              costUSD: 0.01,
              contextWindow: 200000,
              maxOutputTokens: 16384,
            },
          },
        },
      ]),
    );

    const adapter = new ClaudeAdapter();
    await drainGenerator(
      adapter.run(
        makeOptions({
          onContextUsage: (usage) => usageUpdates.push(usage),
        }),
      ),
    );

    // Only the result message should trigger onContextUsage, not the first assistant
    expect(usageUpdates).toHaveLength(1);
    expect(usageUpdates[0].inputTokens).toBe(10000);
  });
});

describe("ClaudeAdapter JSONL compact_boundary parsing", () => {
  it("normalizeFileLine parses compact_boundary lines", () => {
    const adapter = new ClaudeAdapter();
    const line = JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 50000 },
      timestamp: "2025-01-01T00:00:00.000Z",
    });

    const result = adapter.normalizeFileLine(line, 5);
    expect(result).not.toBeNull();
    expect(result!.role).toBe("system");
    if (result!.role === "system" && "event" in result!) {
      expect(result!.event).toEqual({
        type: "compact_boundary",
        trigger: "auto",
        preTokens: 50000,
      });
      expect(result!.index).toBe(5);
    }
  });

  it("normalizeFileLine parses manual trigger compact_boundary", () => {
    const adapter = new ClaudeAdapter();
    const line = JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 0 },
    });

    const result = adapter.normalizeFileLine(line, 0);
    expect(result).not.toBeNull();
    if (result!.role === "system" && "event" in result!) {
      expect(result!.event.trigger).toBe("manual");
      expect(result!.event.preTokens).toBe(0);
    }
  });

  it("normalizeFileLine returns null for non-compact_boundary system lines", () => {
    const adapter = new ClaudeAdapter();
    const line = JSON.stringify({
      type: "system",
      subtype: "status",
      status: "compacting",
    });

    const result = adapter.normalizeFileLine(line, 0);
    expect(result).toBeNull();
  });
});
