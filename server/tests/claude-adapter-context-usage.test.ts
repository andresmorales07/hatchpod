import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProviderSessionOptions } from "../src/providers/types.js";

const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { ClaudeAdapter } = await import("../src/providers/claude-adapter.js");

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

async function drainAdapter(adapter: InstanceType<typeof ClaudeAdapter>, options: ProviderSessionOptions) {
  const gen = adapter.run(options);
  while (!(await gen.next()).done) { /* exhaust */ }
}

describe("ClaudeAdapter context usage reporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes cache tokens in onContextUsage from result message", async () => {
    // Real sessions have tiny input_tokens (3) but large cache tokens (22k+).
    // The percentage must sum all three to reflect actual context window fill.
    const usageCalls: Array<{ inputTokens: number; contextWindow: number }> = [];

    mockQuery.mockReturnValue(
      createMockHandle([
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Hello." }],
            usage: {
              input_tokens: 3,
              cache_creation_input_tokens: 22804,
              cache_read_input_tokens: 13754,
              output_tokens: 10,
            },
          },
        },
        {
          type: "result",
          total_cost_usd: 0.01,
          num_turns: 1,
          session_id: "test-session",
          modelUsage: {
            "claude-opus-4-6": {
              inputTokens: 3,
              cacheReadInputTokens: 13754,
              cacheCreationInputTokens: 22804,
              outputTokens: 10,
              contextWindow: 200000,
              maxOutputTokens: 32000,
              webSearchRequests: 0,
              costUSD: 0.01,
            },
          },
        },
      ]),
    );

    const adapter = new ClaudeAdapter();
    await drainAdapter(adapter, makeOptions({
      onContextUsage: (usage) => usageCalls.push(usage),
    }));

    // Should receive exactly one call from the result message
    expect(usageCalls).toHaveLength(1);

    // inputTokens must be the SUM of uncached + cache_creation + cache_read
    // 3 + 22804 + 13754 = 36561
    expect(usageCalls[0].inputTokens).toBe(36561);
    expect(usageCalls[0].contextWindow).toBe(200000);
  });

  it("includes cache tokens in onContextUsage from assistant message on turn 2+", async () => {
    // On turn 2+, cachedContextWindow is populated from the previous result,
    // so assistant messages fire onContextUsage with live token counts.
    const usageCalls: Array<{ inputTokens: number; contextWindow: number }> = [];

    mockQuery.mockReturnValue(
      createMockHandle([
        // Turn 1 result: establishes cachedContextWindow = 200000
        // (no assistant message with usage in turn 1 for simplicity)
        {
          type: "result",
          total_cost_usd: 0.005,
          num_turns: 1,
          session_id: "test-session",
          modelUsage: {
            "claude-opus-4-6": {
              inputTokens: 100,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 5000,
              outputTokens: 50,
              contextWindow: 200000,
              maxOutputTokens: 32000,
              webSearchRequests: 0,
              costUSD: 0.005,
            },
          },
        },
        // Turn 2 assistant message — fires mid-turn because cachedContextWindow > 0
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Turn 2 reply." }],
            usage: {
              input_tokens: 5,
              cache_creation_input_tokens: 1000,
              cache_read_input_tokens: 4500,
              output_tokens: 20,
            },
          },
        },
        {
          type: "result",
          total_cost_usd: 0.01,
          num_turns: 2,
          session_id: "test-session",
          modelUsage: {
            "claude-opus-4-6": {
              inputTokens: 5,
              cacheReadInputTokens: 4500,
              cacheCreationInputTokens: 1000,
              outputTokens: 20,
              contextWindow: 200000,
              maxOutputTokens: 32000,
              webSearchRequests: 0,
              costUSD: 0.01,
            },
          },
        },
      ]),
    );

    const adapter = new ClaudeAdapter();
    await drainAdapter(adapter, makeOptions({
      onContextUsage: (usage) => usageCalls.push(usage),
    }));

    // First call: from turn 1 result (100 + 0 + 5000 = 5100)
    // Second call: from turn 2 assistant message live (5 + 1000 + 4500 = 5505)
    // Third call: from turn 2 result (5 + 4500 + 1000 = 5505)
    expect(usageCalls.length).toBeGreaterThanOrEqual(2);

    // The turn 2 assistant live-update call should include cache tokens
    const assistantLiveCall = usageCalls[1];
    expect(assistantLiveCall.inputTokens).toBe(5505); // 5 + 1000 + 4500
    expect(assistantLiveCall.contextWindow).toBe(200000);
  });

  it("uses per-call tokens not cumulative modelUsage in multi-call agentic turns", async () => {
    // In an agentic turn with multiple tool-use iterations, each API call includes
    // the full conversation. modelUsage.inputTokens sums across ALL calls (cumulative),
    // which overstates context usage. The fix uses the last assistant message's per-call
    // usage instead.
    const usageCalls: Array<{ inputTokens: number; contextWindow: number }> = [];

    mockQuery.mockReturnValue(
      createMockHandle([
        // Agentic turn: 3 API calls with growing context
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Let me search." }],
            usage: { input_tokens: 10000, output_tokens: 500 },
          },
        },
        // (tool result would go here in real flow)
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Found it, reading file." }],
            usage: { input_tokens: 18000, output_tokens: 300 },
          },
        },
        // (tool result would go here)
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Here's the answer." }],
            usage: { input_tokens: 25000, output_tokens: 200 },
          },
        },
        {
          type: "result",
          total_cost_usd: 0.05,
          num_turns: 1,
          session_id: "test-session",
          modelUsage: {
            "claude-opus-4-6": {
              // Cumulative: 10000 + 18000 + 25000 = 53000 (NOT the current context size!)
              inputTokens: 53000,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              outputTokens: 1000,
              contextWindow: 200000,
              maxOutputTokens: 32000,
              webSearchRequests: 0,
              costUSD: 0.05,
            },
          },
        },
      ]),
    );

    const adapter = new ClaudeAdapter();
    await drainAdapter(adapter, makeOptions({
      onContextUsage: (usage) => usageCalls.push(usage),
    }));

    // Only 1 call: from result (turn 1, no cachedContextWindow for mid-turn updates)
    expect(usageCalls).toHaveLength(1);

    // Must use the last assistant's per-call tokens (25000), NOT the cumulative 53000
    expect(usageCalls[0].inputTokens).toBe(25000);
    expect(usageCalls[0].contextWindow).toBe(200000);
  });

  it("excludes sidechain (subagent) assistant messages from context tracking", async () => {
    // Sidechain messages have parent_tool_use_id set — they represent a subagent's
    // context, not the parent session's. They must not pollute lastCallInputTokens.
    const usageCalls: Array<{ inputTokens: number; contextWindow: number }> = [];

    mockQuery.mockReturnValue(
      createMockHandle([
        // Parent assistant message
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Let me delegate." }],
            usage: { input_tokens: 15000, output_tokens: 100 },
          },
        },
        // Sidechain assistant message (subagent) — should be ignored for context tracking
        {
          type: "assistant",
          parent_tool_use_id: "tool-abc-123",
          message: {
            content: [{ type: "text", text: "Subagent working." }],
            usage: { input_tokens: 5000, output_tokens: 50 },
          },
        },
        {
          type: "result",
          total_cost_usd: 0.03,
          num_turns: 1,
          session_id: "test-session",
          modelUsage: {
            "claude-opus-4-6": {
              inputTokens: 20000,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              outputTokens: 150,
              contextWindow: 200000,
              maxOutputTokens: 32000,
              webSearchRequests: 0,
              costUSD: 0.03,
            },
          },
        },
      ]),
    );

    const adapter = new ClaudeAdapter();
    await drainAdapter(adapter, makeOptions({
      onContextUsage: (usage) => usageCalls.push(usage),
    }));

    expect(usageCalls).toHaveLength(1);
    // Must use parent's 15000, not the sidechain's 5000
    expect(usageCalls[0].inputTokens).toBe(15000);
    expect(usageCalls[0].contextWindow).toBe(200000);
  });
});
