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
});
