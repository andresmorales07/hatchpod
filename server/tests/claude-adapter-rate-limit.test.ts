import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProviderSessionOptions, RateLimitInfo } from "../src/providers/types.js";

const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { ClaudeAdapter } = await import("../src/providers/claude-adapter.js");

function createMockHandle(messages: Record<string, unknown>[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const msg of messages) yield msg;
    },
    supportedCommands: () => Promise.resolve([]),
  };
}

function makeOptions(overrides: Partial<ProviderSessionOptions> = {}): ProviderSessionOptions {
  return {
    prompt: "test",
    cwd: "/tmp",
    permissionMode: "default",
    abortSignal: new AbortController().signal,
    onToolApproval: () => Promise.resolve({ allow: true as const }),
    ...overrides,
  };
}

describe("ClaudeAdapter rate_limit_event handling", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("calls onRateLimit when rate_limit_event is received", async () => {
    const rateLimits: RateLimitInfo[] = [];

    mockQuery.mockReturnValue(createMockHandle([
      {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed_warning",
          rateLimitType: "five_hour",
          utilization: 0.82,
          resetsAt: 1735689600,
        },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }], usage: {} },
        parent_tool_use_id: null,
        uuid: "test-uuid",
        session_id: "test-session",
      },
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.01,
        num_turns: 1,
        result: "done",
        session_id: "test-session",
        modelUsage: {},
        permission_denials: [],
        uuid: "result-uuid",
      },
    ]));

    const adapter = new ClaudeAdapter();
    const gen = adapter.run(makeOptions({
      onRateLimit: (info) => rateLimits.push(info),
    }));

    const messages = [];
    while (true) {
      const next = await gen.next();
      if (next.done) break;
      messages.push(next.value);
    }

    expect(rateLimits).toHaveLength(1);
    expect(rateLimits[0]).toEqual({
      status: "allowed_warning",
      rateLimitType: "five_hour",
      utilization: 0.82,
      resetsAt: 1735689600,
    });
  });

  it("does not crash when onRateLimit is not provided", async () => {
    mockQuery.mockReturnValue(createMockHandle([
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed" },
      },
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0,
        num_turns: 0,
        result: "",
        session_id: "s",
        modelUsage: {},
        permission_denials: [],
        uuid: "u",
      },
    ]));

    const adapter = new ClaudeAdapter();
    const gen = adapter.run(makeOptions());
    while (true) {
      const next = await gen.next();
      if (next.done) break;
    }
    // No error thrown = pass
  });
});
