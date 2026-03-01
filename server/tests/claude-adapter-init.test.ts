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
      for (const msg of messages) yield msg;
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

describe("ClaudeAdapter init message handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls onSessionIdResolved with session_id from init system message", async () => {
    const resolved: string[] = [];

    mockQuery.mockReturnValue(
      createMockHandle([
        { type: "system", subtype: "init", session_id: "real-session-abc" },
        { type: "assistant", message: { content: [{ type: "text", text: "Hello!" }] } },
        { type: "result", total_cost_usd: 0, num_turns: 1, session_id: "real-session-abc" },
      ]),
    );

    const adapter = new ClaudeAdapter();
    const gen = adapter.run(makeOptions({
      onSessionIdResolved: (id) => resolved.push(id),
    }));

    while (!(await gen.next()).done) { /* exhaust */ }

    expect(resolved).toEqual(["real-session-abc"]);
  });

  it("calls onSessionIdResolved before yielding any messages", async () => {
    const events: string[] = [];

    mockQuery.mockReturnValue(
      createMockHandle([
        { type: "system", subtype: "init", session_id: "real-session-xyz" },
        { type: "assistant", message: { content: [{ type: "text", text: "Hello!" }] } },
        { type: "result", total_cost_usd: 0, num_turns: 1, session_id: "real-session-xyz" },
      ]),
    );

    const adapter = new ClaudeAdapter();
    const gen = adapter.run(makeOptions({
      onSessionIdResolved: () => events.push("resolved"),
    }));

    for (;;) {
      const next = await gen.next();
      if (next.done) break;
      events.push("message");
    }

    // "resolved" must precede any yielded messages — this is the early-remap guarantee.
    // Without it, listSessionsWithHistory() would briefly see the live session under
    // a temp UUID and the JSONL file under the real ID, creating a duplicate history entry.
    expect(events[0]).toBe("resolved");
    expect(events).toContain("message");
  });

  it("does not call onSessionIdResolved when init message has no session_id", async () => {
    const resolved: string[] = [];

    mockQuery.mockReturnValue(
      createMockHandle([
        { type: "system", subtype: "init" /* no session_id */ },
        { type: "result", total_cost_usd: 0, num_turns: 0 },
      ]),
    );

    const adapter = new ClaudeAdapter();
    const gen = adapter.run(makeOptions({
      onSessionIdResolved: (id) => resolved.push(id),
    }));

    while (!(await gen.next()).done) { /* exhaust */ }

    expect(resolved).toHaveLength(0);
  });

  it("calls onModelResolved with model from init system message", async () => {
    const models: string[] = [];

    mockQuery.mockReturnValue(
      createMockHandle([
        { type: "system", subtype: "init", session_id: "sess-1", model: "claude-opus-4-6-20250514" },
        { type: "assistant", message: { content: [{ type: "text", text: "Hello!" }] } },
        { type: "result", total_cost_usd: 0, num_turns: 1, session_id: "sess-1" },
      ]),
    );

    const adapter = new ClaudeAdapter();
    const gen = adapter.run(makeOptions({
      onModelResolved: (m) => models.push(m),
    }));

    while (!(await gen.next()).done) { /* exhaust */ }

    expect(models).toEqual(["claude-opus-4-6-20250514"]);
  });

  it("does not call onModelResolved when init message has no model", async () => {
    const models: string[] = [];

    mockQuery.mockReturnValue(
      createMockHandle([
        { type: "system", subtype: "init", session_id: "sess-2" /* no model */ },
        { type: "result", total_cost_usd: 0, num_turns: 0 },
      ]),
    );

    const adapter = new ClaudeAdapter();
    const gen = adapter.run(makeOptions({
      onModelResolved: (m) => models.push(m),
    }));

    while (!(await gen.next()).done) { /* exhaust */ }

    expect(models).toHaveLength(0);
  });
});
