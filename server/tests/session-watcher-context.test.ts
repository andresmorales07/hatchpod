import { describe, it, expect, beforeEach } from "vitest";
import type { NormalizedMessage, ProviderAdapter, PaginatedMessages } from "../src/providers/types.js";
import { SessionWatcher } from "../src/session-watcher.js";

// ── Helpers ──

/** Minimal mock adapter (no file-based features needed for these tests). */
function createMockAdapter(): ProviderAdapter {
  return {
    name: "MockAdapter",
    id: "mock",
    async *run(): AsyncGenerator<NormalizedMessage, { providerSessionId?: string; totalCostUsd: number; numTurns: number }, undefined> {
      return { totalCostUsd: 0, numTurns: 0 };
    },
    async getSessionHistory(): Promise<NormalizedMessage[]> {
      return [];
    },
    async getMessages(): Promise<PaginatedMessages> {
      return { messages: [], tasks: [], totalMessages: 0, hasMore: false, oldestIndex: 0 };
    },
    async listSessions() {
      return [];
    },
    async getSessionFilePath(): Promise<string | null> {
      return null;
    },
    normalizeFileLine(): NormalizedMessage | null {
      return null;
    },
  };
}

type MockWs = { readyState: number; send: (data: string) => void };

function createMockWs(): { ws: MockWs; sent: string[] } {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    send(data: string) { sent.push(data); },
  } as MockWs;
  return { ws, sent };
}

/** Parse events of a given type from recorded sends. */
function parseEvents<T>(sent: string[], type: string): T[] {
  return sent
    .map((s) => JSON.parse(s))
    .filter((e: { type: string }) => e.type === type);
}

describe("SessionWatcher context state buffering", () => {
  let watcher: SessionWatcher;

  beforeEach(() => {
    watcher = new SessionWatcher(createMockAdapter());
  });

  it("buffers isCompacting and sends to late subscriber", async () => {
    const sessionId = "ctx-1";
    watcher.setMode(sessionId, "push");

    // Push compacting event
    watcher.pushEvent(sessionId, { type: "compacting", isCompacting: true });

    // Late subscriber connects
    const { ws, sent } = createMockWs();
    await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);

    const compactingEvents = parseEvents<{ type: string; isCompacting: boolean }>(sent, "compacting");
    expect(compactingEvents).toHaveLength(1);
    expect(compactingEvents[0].isCompacting).toBe(true);
  });

  it("does not send isCompacting to late subscriber after compacting ends", async () => {
    const sessionId = "ctx-2";
    watcher.setMode(sessionId, "push");

    watcher.pushEvent(sessionId, { type: "compacting", isCompacting: true });
    watcher.pushEvent(sessionId, { type: "compacting", isCompacting: false });

    const { ws, sent } = createMockWs();
    await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);

    const compactingEvents = parseEvents<{ type: string; isCompacting: boolean }>(sent, "compacting");
    // isCompacting is false, so it should NOT be sent during replay
    expect(compactingEvents).toHaveLength(0);
  });

  it("buffers lastContextUsage and sends to late subscriber", async () => {
    const sessionId = "ctx-3";
    watcher.setMode(sessionId, "push");

    watcher.pushEvent(sessionId, {
      type: "context_usage",
      inputTokens: 45000,
      contextWindow: 200000,
      percentUsed: 23,
    });

    const { ws, sent } = createMockWs();
    await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);

    const usageEvents = parseEvents<{ type: string; inputTokens: number; contextWindow: number; percentUsed: number }>(sent, "context_usage");
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      inputTokens: 45000,
      contextWindow: 200000,
      percentUsed: 23,
    });
  });

  it("updates lastContextUsage on subsequent pushEvent calls", async () => {
    const sessionId = "ctx-4";
    watcher.setMode(sessionId, "push");

    watcher.pushEvent(sessionId, {
      type: "context_usage",
      inputTokens: 10000,
      contextWindow: 200000,
      percentUsed: 5,
    });
    watcher.pushEvent(sessionId, {
      type: "context_usage",
      inputTokens: 80000,
      contextWindow: 200000,
      percentUsed: 40,
    });

    const { ws, sent } = createMockWs();
    await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);

    const usageEvents = parseEvents<{ type: string; percentUsed: number }>(sent, "context_usage");
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].percentUsed).toBe(40); // Last value wins
  });

  it("clears isCompacting on terminal status but keeps lastContextUsage", async () => {
    const sessionId = "ctx-5";
    watcher.setMode(sessionId, "push");

    watcher.pushEvent(sessionId, { type: "compacting", isCompacting: true });
    watcher.pushEvent(sessionId, {
      type: "context_usage",
      inputTokens: 90000,
      contextWindow: 200000,
      percentUsed: 45,
    });

    // Terminal status clears isCompacting but keeps contextUsage
    watcher.pushEvent(sessionId, { type: "status", status: "completed" });

    const { ws, sent } = createMockWs();
    await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);

    const compactingEvents = parseEvents<{ type: string; isCompacting: boolean }>(sent, "compacting");
    expect(compactingEvents).toHaveLength(0); // Cleared by terminal status

    const usageEvents = parseEvents<{ type: string; percentUsed: number }>(sent, "context_usage");
    expect(usageEvents).toHaveLength(1); // Kept
    expect(usageEvents[0].percentUsed).toBe(45);
  });

  it("compact_boundary messages flow through pushMessage and are stored", () => {
    const sessionId = "ctx-6";
    watcher.setMode(sessionId, "push");

    const { ws, sent } = createMockWs();
    // Subscribe first so we see the broadcast
    watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);

    // Clear the replay_complete from subscribe
    sent.length = 0;

    // Push a compact_boundary message
    watcher.pushMessage(sessionId, {
      role: "system",
      event: { type: "compact_boundary", trigger: "auto", preTokens: 45000 },
      index: 0,
    });

    const messages = sent
      .map((s) => JSON.parse(s))
      .filter((e: { type: string }) => e.type === "message")
      .map((e: { message: NormalizedMessage }) => e.message);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("system");
    if (messages[0].role === "system" && "event" in messages[0]) {
      expect(messages[0].event.type).toBe("compact_boundary");
    }
  });

  it("broadcasts compacting and context_usage events to connected clients", () => {
    const sessionId = "ctx-7";
    watcher.setMode(sessionId, "push");

    const { ws: ws1, sent: sent1 } = createMockWs();
    const { ws: ws2, sent: sent2 } = createMockWs();
    watcher.subscribe(sessionId, ws1 as unknown as import("ws").WebSocket);
    watcher.subscribe(sessionId, ws2 as unknown as import("ws").WebSocket);

    // Clear replay_complete events
    sent1.length = 0;
    sent2.length = 0;

    watcher.pushEvent(sessionId, { type: "compacting", isCompacting: true });
    watcher.pushEvent(sessionId, {
      type: "context_usage",
      inputTokens: 50000,
      contextWindow: 200000,
      percentUsed: 25,
    });

    // Both clients should receive both events
    for (const sent of [sent1, sent2]) {
      const compacting = parseEvents<{ isCompacting: boolean }>(sent, "compacting");
      expect(compacting).toHaveLength(1);
      expect(compacting[0].isCompacting).toBe(true);

      const usage = parseEvents<{ percentUsed: number }>(sent, "context_usage");
      expect(usage).toHaveLength(1);
      expect(usage[0].percentUsed).toBe(25);
    }
  });
});
