import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm, appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { NormalizedMessage, ProviderAdapter, PaginatedMessages } from "../src/providers/types.js";
import { SessionWatcher } from "../src/session-watcher.js";

// ── Helpers ──

const testDir = join(tmpdir(), `hatchpod-watcher-test-${Date.now()}`);

/** Minimal mock adapter that parses `{"type":"text","text":"..."}` JSONL lines. */
function createMockAdapter(filePathMap: Map<string, string>): ProviderAdapter {
  function normalizeLine(line: string, index: number): NormalizedMessage | null {
    if (!line.trim()) return null;
    let parsed: { type?: string; text?: string };
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
    if (parsed.type !== "text" || !parsed.text) return null;
    return {
      role: "assistant",
      parts: [{ type: "text", text: parsed.text }],
      index,
    };
  }

  return {
    name: "MockAdapter",
    id: "mock",
    async *run(): AsyncGenerator<NormalizedMessage, { providerSessionId?: string; totalCostUsd: number; numTurns: number }, undefined> {
      return { totalCostUsd: 0, numTurns: 0 };
    },
    async getSessionHistory(_sessionId: string): Promise<NormalizedMessage[]> {
      return [];
    },
    async getMessages(sessionId: string, options?: { before?: number; limit?: number }): Promise<PaginatedMessages> {
      const filePath = filePathMap.get(sessionId);
      if (!filePath) {
        const err = new Error(`Session file not found for ${sessionId}`);
        err.name = "SessionNotFound";
        throw err;
      }
      let content: string;
      try {
        content = await readFile(filePath, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return { messages: [], tasks: [], totalMessages: 0, hasMore: false, oldestIndex: 0 };
        }
        throw err;
      }
      const allMessages: NormalizedMessage[] = [];
      let idx = 0;
      for (const line of content.split("\n")) {
        const msg = normalizeLine(line, idx);
        if (msg) { allMessages.push(msg); idx++; }
      }
      const before = options?.before ?? allMessages.length;
      const limit = Math.min(Math.max(options?.limit ?? 30, 1), 100);
      const eligible = allMessages.filter((m) => m.index < before);
      const page = eligible.slice(-limit);
      const oldestIndex = page.length > 0 ? page[0].index : 0;
      const hasMore = eligible.length > page.length;
      return { messages: page, tasks: [], totalMessages: allMessages.length, hasMore, oldestIndex };
    },
    async listSessions() {
      return [];
    },
    async getSessionFilePath(sessionId: string): Promise<string | null> {
      return filePathMap.get(sessionId) ?? null;
    },
    normalizeFileLine: normalizeLine,
  };
}

/** Mock WebSocket with readyState and send() that records data. */
function createMockWs(): { ws: MockWs; sent: string[] } {
  const sent: string[] = [];
  const ws = {
    readyState: 1, // OPEN
    send(data: string) {
      sent.push(data);
    },
  } as MockWs;
  return { ws, sent };
}

type MockWs = { readyState: number; send: (data: string) => void };

function jsonlLine(text: string): string {
  return JSON.stringify({ type: "text", text }) + "\n";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse all `{ type: "message" }` events from recorded sends. */
function parseMessages(sent: string[]): NormalizedMessage[] {
  return sent
    .map((s) => JSON.parse(s))
    .filter((e: { type: string }) => e.type === "message")
    .map((e: { message: NormalizedMessage }) => e.message);
}

/** Check if a replay_complete event was sent. */
function hasReplayComplete(sent: string[]): boolean {
  return sent.some((s) => {
    const parsed = JSON.parse(s);
    return parsed.type === "replay_complete";
  });
}

// ── Tests ──

let subDir: string;
let subDirCounter = 0;

beforeEach(async () => {
  subDir = join(testDir, `run-${++subDirCounter}`);
  await mkdir(subDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true }).catch(() => {});
});

describe("SessionWatcher", () => {
  describe("subscribe — file-based replay", () => {
    it("replays existing lines on subscribe", async () => {
      const sessionId = "sess-1";
      const filePath = join(subDir, `${sessionId}.jsonl`);
      await writeFile(filePath, jsonlLine("hello") + jsonlLine("world"));

      const fileMap = new Map([[sessionId, filePath]]);
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      const { ws, sent } = createMockWs();
      await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);

      const messages = parseMessages(sent);
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("assistant");
      expect((messages[0] as { parts: Array<{ text?: string }> }).parts[0].text).toBe("hello");
      expect((messages[1] as { parts: Array<{ text?: string }> }).parts[0].text).toBe("world");

      expect(hasReplayComplete(sent)).toBe(true);

      // replay_complete should come after all message events
      const replayIdx = sent.findIndex((s) => JSON.parse(s).type === "replay_complete");
      const lastMsgIdx = sent.length - 1 - [...sent].reverse().findIndex((s) => JSON.parse(s).type === "message");
      expect(replayIdx).toBeGreaterThan(lastMsgIdx);

      watcher.stop();
    });

    it("sends replay_complete even when file is empty", async () => {
      const sessionId = "sess-empty";
      const filePath = join(subDir, `${sessionId}.jsonl`);
      await writeFile(filePath, "");

      const fileMap = new Map([[sessionId, filePath]]);
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      const { ws, sent } = createMockWs();
      await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);

      expect(parseMessages(sent)).toHaveLength(0);
      expect(hasReplayComplete(sent)).toBe(true);

      watcher.stop();
    });

    it("sends replay_complete when file path is not found", async () => {
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      const { ws, sent } = createMockWs();
      await watcher.subscribe("nonexistent", ws as unknown as import("ws").WebSocket);

      expect(sent).toHaveLength(1);
      const parsed = JSON.parse(sent[0]);
      expect(parsed.type).toBe("replay_complete");

      watcher.stop();
    });
  });

  describe("subscribe — in-memory replay", () => {
    it("replays from memory when messages exist", async () => {
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      const sessionId = "sess-mem";
      watcher.setMode(sessionId, "push");

      // Push some messages
      watcher.pushMessage(sessionId, { role: "user", parts: [{ type: "text", text: "hello" }], index: 0 });
      watcher.pushMessage(sessionId, { role: "assistant", parts: [{ type: "text", text: "hi" }], index: 0 });

      // Subscribe a client — should get in-memory replay
      const { ws, sent } = createMockWs();
      await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);

      const messages = parseMessages(sent);
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[0].index).toBe(0);
      expect(messages[1].role).toBe("assistant");
      expect(messages[1].index).toBe(1);

      expect(hasReplayComplete(sent)).toBe(true);

      watcher.stop();
    });

    it("respects messageLimit for in-memory replay", async () => {
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      const sessionId = "sess-limit";
      watcher.setMode(sessionId, "push");

      // Push 5 messages
      for (let i = 0; i < 5; i++) {
        watcher.pushMessage(sessionId, { role: "assistant", parts: [{ type: "text", text: `msg-${i}` }], index: 0 });
      }

      // Subscribe with limit of 2 — should get last 2 messages
      const { ws, sent } = createMockWs();
      await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket, 2);

      const messages = parseMessages(sent);
      expect(messages).toHaveLength(2);
      expect(messages[0].index).toBe(3);
      expect(messages[1].index).toBe(4);

      // replay_complete should report correct total and oldest
      const replayComplete = sent.map((s) => JSON.parse(s)).find((e: { type: string }) => e.type === "replay_complete");
      expect(replayComplete.totalMessages).toBe(5);
      expect(replayComplete.oldestIndex).toBe(3);

      watcher.stop();
    });
  });

  describe("pushMessage", () => {
    it("stores and broadcasts messages in push mode", () => {
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      const sessionId = "sess-push";
      watcher.setMode(sessionId, "push");

      // Subscribe a client
      const { ws, sent } = createMockWs();
      // Manually add to session (bypass async subscribe)
      watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);

      sent.length = 0; // Clear replay
      watcher.pushMessage(sessionId, { role: "assistant", parts: [{ type: "text", text: "hello" }], index: 0 });

      const messages = parseMessages(sent);
      expect(messages).toHaveLength(1);
      expect(messages[0].index).toBe(0);
      expect((messages[0] as { parts: Array<{ text?: string }> }).parts[0].text).toBe("hello");

      watcher.stop();
    });

    it("assigns sequential indices from messages.length", () => {
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      const sessionId = "sess-idx";
      watcher.setMode(sessionId, "push");

      const { ws, sent } = createMockWs();
      watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);
      sent.length = 0;

      // Push 3 messages — indices should be 0, 1, 2
      watcher.pushMessage(sessionId, { role: "user", parts: [{ type: "text", text: "a" }], index: 99 }); // input index ignored
      watcher.pushMessage(sessionId, { role: "assistant", parts: [{ type: "text", text: "b" }], index: 0 });
      watcher.pushMessage(sessionId, { role: "user", parts: [{ type: "text", text: "c" }], index: 0 });

      const messages = parseMessages(sent);
      expect(messages[0].index).toBe(0);
      expect(messages[1].index).toBe(1);
      expect(messages[2].index).toBe(2);

      watcher.stop();
    });

    it("no-ops when session is not in push mode", () => {
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      const sessionId = "sess-nopush";
      watcher.setMode(sessionId, "idle");

      const { ws, sent } = createMockWs();
      watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);
      sent.length = 0;

      watcher.pushMessage(sessionId, { role: "assistant", parts: [{ type: "text", text: "ignored" }], index: 0 });
      expect(parseMessages(sent)).toHaveLength(0);

      watcher.stop();
    });

    it("no-ops for nonexistent session", () => {
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      // Should not throw
      watcher.pushMessage("nonexistent", { role: "assistant", parts: [{ type: "text", text: "hello" }], index: 0 });
      watcher.stop();
    });
  });

  describe("pushEvent", () => {
    it("broadcasts ephemeral events without storing", async () => {
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      const sessionId = "sess-event";
      watcher.setMode(sessionId, "push");

      const { ws, sent } = createMockWs();
      await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);
      sent.length = 0;

      watcher.pushEvent(sessionId, { type: "status", status: "running" });
      watcher.pushEvent(sessionId, { type: "thinking_delta", text: "thinking..." });

      // Events should be sent
      expect(sent).toHaveLength(2);
      expect(JSON.parse(sent[0]).type).toBe("status");
      expect(JSON.parse(sent[1]).type).toBe("thinking_delta");

      // But not stored in messages
      watcher.pushMessage(sessionId, { role: "assistant", parts: [{ type: "text", text: "first real msg" }], index: 0 });
      const messages = parseMessages(sent);
      expect(messages).toHaveLength(1);
      expect(messages[0].index).toBe(0); // Index 0, not 2

      watcher.stop();
    });

    it("no-ops for nonexistent session without throwing", () => {
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      // Should not throw
      watcher.pushEvent("nonexistent", { type: "status", status: "completed" });
      watcher.stop();
    });

    it("works regardless of mode", async () => {
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      const sessionId = "sess-event-idle";
      watcher.setMode(sessionId, "idle");

      const { ws, sent } = createMockWs();
      await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);
      sent.length = 0;

      // pushEvent should work in idle mode (used for status updates after completion)
      watcher.pushEvent(sessionId, { type: "status", status: "completed" });
      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0]).type).toBe("status");

      watcher.stop();
    });
  });

  describe("setMode", () => {
    it("creates session entry if it does not exist", () => {
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      watcher.setMode("new-sess", "push");
      expect(watcher.watchedCount).toBe(1);

      watcher.stop();
    });

    it("updates mode on existing session", async () => {
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      const sessionId = "sess-mode";
      watcher.setMode(sessionId, "push");

      const { ws, sent } = createMockWs();
      await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);
      sent.length = 0;

      // Push should work in push mode
      watcher.pushMessage(sessionId, { role: "assistant", parts: [{ type: "text", text: "a" }], index: 0 });
      expect(parseMessages(sent)).toHaveLength(1);

      // Switch to idle — push should stop working
      watcher.setMode(sessionId, "idle");
      sent.length = 0;
      watcher.pushMessage(sessionId, { role: "assistant", parts: [{ type: "text", text: "b" }], index: 0 });
      expect(parseMessages(sent)).toHaveLength(0);

      watcher.stop();
    });
  });

  describe("transitionToPoll", () => {
    it("resolves file path and sets mode to poll", async () => {
      const sessionId = "sess-transition";
      const filePath = join(subDir, `${sessionId}.jsonl`);
      await writeFile(filePath, jsonlLine("msg1") + jsonlLine("msg2"));

      const fileMap = new Map([[sessionId, filePath]]);
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);
      watcher.start(50);

      // Start in push mode
      watcher.setMode(sessionId, "push");
      watcher.pushMessage(sessionId, { role: "user", parts: [{ type: "text", text: "hello" }], index: 0 });

      // Transition to poll
      await watcher.transitionToPoll(sessionId);

      // Subscribe a client and verify they can see pushed messages from memory
      const { ws, sent } = createMockWs();
      await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);

      const messages = parseMessages(sent);
      expect(messages).toHaveLength(1);
      expect((messages[0] as { parts: Array<{ text?: string }> }).parts[0].text).toBe("hello");

      // New data appended to file should be picked up by polling
      sent.length = 0;
      await appendFile(filePath, jsonlLine("polled-msg"));
      await delay(200);

      const polledMsgs = parseMessages(sent);
      expect(polledMsgs).toHaveLength(1);
      expect((polledMsgs[0] as { parts: Array<{ text?: string }> }).parts[0].text).toBe("polled-msg");

      watcher.stop();
    });

    it("skips pre-existing file data written during push mode", async () => {
      const sessionId = "sess-skip-existing";
      const filePath = join(subDir, `${sessionId}.jsonl`);
      // File has data that was written by the SDK during push mode
      await writeFile(filePath, jsonlLine("pushed-via-sdk-1") + jsonlLine("pushed-via-sdk-2"));

      const fileMap = new Map([[sessionId, filePath]]);
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);
      watcher.start(50);

      // Start in push mode with messages already in memory
      watcher.setMode(sessionId, "push");
      watcher.pushMessage(sessionId, { role: "user", parts: [{ type: "text", text: "hello" }], index: 0 });
      watcher.pushMessage(sessionId, { role: "assistant", parts: [{ type: "text", text: "world" }], index: 0 });

      // Transition to poll — should advance byteOffset to EOF
      await watcher.transitionToPoll(sessionId);

      // Subscribe a client — should get in-memory messages only
      const { ws, sent } = createMockWs();
      await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);

      const replayed = parseMessages(sent);
      expect(replayed).toHaveLength(2);
      expect((replayed[0] as { parts: Array<{ text?: string }> }).parts[0].text).toBe("hello");
      expect((replayed[1] as { parts: Array<{ text?: string }> }).parts[0].text).toBe("world");

      // Now append NEW data after the transition — only this should be polled
      sent.length = 0;
      await appendFile(filePath, jsonlLine("new-after-transition"));
      await delay(200);

      const polledMsgs = parseMessages(sent);
      expect(polledMsgs).toHaveLength(1);
      expect((polledMsgs[0] as { parts: Array<{ text?: string }> }).parts[0].text).toBe("new-after-transition");
      // Index should continue from in-memory messages (0, 1 → next is 2)
      expect(polledMsgs[0].index).toBe(2);

      watcher.stop();
    });

    it("handles nonexistent session gracefully", async () => {
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      // Should not throw
      await watcher.transitionToPoll("nonexistent");
      watcher.stop();
    });
  });

  describe("polling — broadcast new lines", () => {
    it("subscribe defaults to poll mode so CLI sessions get live updates", async () => {
      const sessionId = "sess-default-poll";
      const filePath = join(subDir, `${sessionId}.jsonl`);
      await writeFile(filePath, "");

      const fileMap = new Map([[sessionId, filePath]]);
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);
      watcher.start(50);

      const { ws, sent } = createMockWs();
      await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);
      sent.length = 0;

      // Append data — should be picked up automatically (poll mode is the default)
      await appendFile(filePath, jsonlLine("live-update"));
      await delay(200);

      expect(parseMessages(sent)).toHaveLength(1);
      expect((parseMessages(sent)[0] as { parts: Array<{ text?: string }> }).parts[0].text).toBe("live-update");

      watcher.stop();
    });

    it("broadcasts new lines after subscribe when in poll mode", async () => {
      const sessionId = "sess-live";
      const filePath = join(subDir, `${sessionId}.jsonl`);
      await writeFile(filePath, jsonlLine("initial"));

      const fileMap = new Map([[sessionId, filePath]]);
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);
      watcher.start(50); // fast poll

      const { ws, sent } = createMockWs();
      await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);

      // Verify replay
      const replayMessages = parseMessages(sent);
      expect(replayMessages).toHaveLength(1);
      expect((replayMessages[0] as { parts: Array<{ text?: string }> }).parts[0].text).toBe("initial");

      // Session defaults to poll mode after subscribe — clear and append new lines
      sent.length = 0;
      await appendFile(filePath, jsonlLine("update-1") + jsonlLine("update-2"));

      // Wait for polling to pick it up
      await delay(200);

      const newMessages = parseMessages(sent);
      expect(newMessages).toHaveLength(2);
      expect((newMessages[0] as { parts: Array<{ text?: string }> }).parts[0].text).toBe("update-1");
      expect((newMessages[1] as { parts: Array<{ text?: string }> }).parts[0].text).toBe("update-2");

      watcher.stop();
    });

    it("does not poll sessions in push mode", async () => {
      const sessionId = "sess-nopoll";
      const filePath = join(subDir, `${sessionId}.jsonl`);
      await writeFile(filePath, "");

      const fileMap = new Map([[sessionId, filePath]]);
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);
      watcher.start(50);

      watcher.setMode(sessionId, "push");

      const { ws, sent } = createMockWs();
      await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);
      sent.length = 0;

      // Append data — should NOT be picked up (push mode, not poll)
      await appendFile(filePath, jsonlLine("should-not-appear"));
      await delay(200);

      expect(parseMessages(sent)).toHaveLength(0);

      watcher.stop();
    });

    it("handles partial lines across poll cycles", async () => {
      const sessionId = "sess-partial";
      const filePath = join(subDir, `${sessionId}.jsonl`);
      await writeFile(filePath, "");

      const fileMap = new Map([[sessionId, filePath]]);
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);
      watcher.start(50);

      const { ws, sent } = createMockWs();
      await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);
      // subscribe defaults to poll mode — no need to set explicitly
      sent.length = 0;

      // Write a partial line (no newline terminator)
      const partialJson = '{"type":"text","text":"partial"';
      await appendFile(filePath, partialJson);
      await delay(200);

      // No message should have been sent yet (incomplete line)
      expect(parseMessages(sent)).toHaveLength(0);

      // Now complete the line
      await appendFile(filePath, '}\n');
      await delay(200);

      // Now we should see the message
      const messages = parseMessages(sent);
      expect(messages).toHaveLength(1);
      expect((messages[0] as { parts: Array<{ text?: string }> }).parts[0].text).toBe("partial");

      watcher.stop();
    });

    it("broadcasts to multiple clients on the same session", async () => {
      const sessionId = "sess-multi";
      const filePath = join(subDir, `${sessionId}.jsonl`);
      await writeFile(filePath, jsonlLine("existing"));

      const fileMap = new Map([[sessionId, filePath]]);
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);
      watcher.start(50);

      const client1 = createMockWs();
      const client2 = createMockWs();
      await watcher.subscribe(sessionId, client1.ws as unknown as import("ws").WebSocket);
      await watcher.subscribe(sessionId, client2.ws as unknown as import("ws").WebSocket);
      // subscribe defaults to poll mode

      // Clear replay data
      client1.sent.length = 0;
      client2.sent.length = 0;

      // Append a new line
      await appendFile(filePath, jsonlLine("broadcast"));
      await delay(200);

      // Both clients should receive the new message
      expect(parseMessages(client1.sent)).toHaveLength(1);
      expect(parseMessages(client2.sent)).toHaveLength(1);
      expect((parseMessages(client1.sent)[0] as { parts: Array<{ text?: string }> }).parts[0].text).toBe("broadcast");
      expect((parseMessages(client2.sent)[0] as { parts: Array<{ text?: string }> }).parts[0].text).toBe("broadcast");

      watcher.stop();
    });

    it("stores polled messages in memory for reconnect replay", async () => {
      const sessionId = "sess-poll-memory";
      const filePath = join(subDir, `${sessionId}.jsonl`);
      await writeFile(filePath, jsonlLine("initial"));

      const fileMap = new Map([[sessionId, filePath]]);
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);
      watcher.start(50);

      // First client connects and receives replay (subscribe defaults to poll mode)
      const client1 = createMockWs();
      await watcher.subscribe(sessionId, client1.ws as unknown as import("ws").WebSocket);

      // Poll picks up new data
      await appendFile(filePath, jsonlLine("polled"));
      await delay(200);

      // Second client subscribes — should get in-memory replay (initial + polled)
      const client2 = createMockWs();
      await watcher.subscribe(sessionId, client2.ws as unknown as import("ws").WebSocket);

      const messages = parseMessages(client2.sent);
      // Should have 2 messages: initial (from file replay) + polled (stored in memory)
      expect(messages).toHaveLength(2);
      expect((messages[0] as { parts: Array<{ text?: string }> }).parts[0].text).toBe("initial");
      expect((messages[1] as { parts: Array<{ text?: string }> }).parts[0].text).toBe("polled");

      watcher.stop();
    });
  });

  describe("unsubscribe", () => {
    it("preserves entry with messages for reconnect replay", async () => {
      const sessionId = "sess-unsub";
      const filePath = join(subDir, `${sessionId}.jsonl`);
      await writeFile(filePath, jsonlLine("line1"));

      const fileMap = new Map([[sessionId, filePath]]);
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);
      watcher.start(50);

      const { ws, sent } = createMockWs();
      await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);
      expect(watcher.watchedCount).toBe(1);

      watcher.unsubscribe(sessionId, ws as unknown as import("ws").WebSocket);
      // Entry preserved because it has messages from replay
      expect(watcher.watchedCount).toBe(1);

      // Append data after unsub — not delivered to disconnected client
      sent.length = 0;
      await appendFile(filePath, jsonlLine("after-unsub"));
      await delay(200);
      expect(parseMessages(sent)).toHaveLength(0);

      // But reconnecting should replay ALL stored messages — both the original
      // replay and data polled while no clients were connected
      const client2 = createMockWs();
      await watcher.subscribe(sessionId, client2.ws as unknown as import("ws").WebSocket);
      const replayed = parseMessages(client2.sent);
      expect(replayed).toHaveLength(2);
      expect((replayed[0] as { parts: Array<{ text?: string }> }).parts[0].text).toBe("line1");
      expect((replayed[1] as { parts: Array<{ text?: string }> }).parts[0].text).toBe("after-unsub");

      watcher.stop();
    });

    it("removes entry when last client leaves and no messages exist", async () => {
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      const { ws } = createMockWs();
      await watcher.subscribe("empty-sess", ws as unknown as import("ws").WebSocket);
      expect(watcher.watchedCount).toBe(1);

      watcher.unsubscribe("empty-sess", ws as unknown as import("ws").WebSocket);
      expect(watcher.watchedCount).toBe(0);

      watcher.stop();
    });

    it("keeps watching when other clients remain", async () => {
      const sessionId = "sess-partial-unsub";
      const filePath = join(subDir, `${sessionId}.jsonl`);
      await writeFile(filePath, jsonlLine("initial"));

      const fileMap = new Map([[sessionId, filePath]]);
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);
      watcher.start(50);

      const client1 = createMockWs();
      const client2 = createMockWs();
      await watcher.subscribe(sessionId, client1.ws as unknown as import("ws").WebSocket);
      await watcher.subscribe(sessionId, client2.ws as unknown as import("ws").WebSocket);
      // subscribe defaults to poll mode
      expect(watcher.watchedCount).toBe(1);

      // Unsub client1 — client2 still subscribed
      watcher.unsubscribe(sessionId, client1.ws as unknown as import("ws").WebSocket);
      expect(watcher.watchedCount).toBe(1);

      // Append data — client2 should still get it
      client2.sent.length = 0;
      await appendFile(filePath, jsonlLine("still-watching"));
      await delay(200);

      expect(parseMessages(client2.sent)).toHaveLength(1);

      watcher.stop();
    });
  });

  describe("remap", () => {
    it("returns true on successful remap", async () => {
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      watcher.setMode("old-id", "push");
      const result = watcher.remap("old-id", "new-id");
      expect(result).toBe(true);
      expect(watcher.watchedCount).toBe(1);

      // Push to new ID should work
      const { ws, sent } = createMockWs();
      await watcher.subscribe("new-id", ws as unknown as import("ws").WebSocket);
      sent.length = 0;
      watcher.pushMessage("new-id", { role: "assistant", parts: [{ type: "text", text: "test" }], index: 0 });
      expect(parseMessages(sent)).toHaveLength(1);

      watcher.stop();
    });

    it("returns false when old session does not exist", () => {
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      const result = watcher.remap("nonexistent", "new-id");
      expect(result).toBe(false);
      expect(watcher.watchedCount).toBe(0);

      watcher.stop();
    });
  });

  describe("forceRemove", () => {
    it("removes session entry regardless of messages", async () => {
      const sessionId = "sess-force";
      const filePath = join(subDir, `${sessionId}.jsonl`);
      await writeFile(filePath, jsonlLine("data"));

      const fileMap = new Map([[sessionId, filePath]]);
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      const { ws } = createMockWs();
      await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);
      expect(watcher.watchedCount).toBe(1);

      // Unsubscribe — entry preserved because it has messages
      watcher.unsubscribe(sessionId, ws as unknown as import("ws").WebSocket);
      expect(watcher.watchedCount).toBe(1);

      // forceRemove — entry deleted regardless
      watcher.forceRemove(sessionId);
      expect(watcher.watchedCount).toBe(0);

      watcher.stop();
    });

    it("no-ops for nonexistent session", () => {
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      // Should not throw
      watcher.forceRemove("nonexistent");
      expect(watcher.watchedCount).toBe(0);

      watcher.stop();
    });
  });

  describe("contiguous indices across mode transitions", () => {
    it("maintains contiguous indices across push → poll → push (follow-up)", async () => {
      const sessionId = "sess-followup-idx";
      const filePath = join(subDir, `${sessionId}.jsonl`);
      await writeFile(filePath, "");

      const fileMap = new Map([[sessionId, filePath]]);
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);
      watcher.start(50);

      // First run: push mode
      watcher.setMode(sessionId, "push");
      watcher.pushMessage(sessionId, { role: "user", parts: [{ type: "text", text: "first" }], index: 0 });
      watcher.pushMessage(sessionId, { role: "assistant", parts: [{ type: "text", text: "response-1" }], index: 0 });
      // Indices should be 0, 1

      // Complete and transition to poll
      await watcher.transitionToPoll(sessionId);

      // Follow-up: switch back to push
      watcher.setMode(sessionId, "push");
      watcher.pushMessage(sessionId, { role: "user", parts: [{ type: "text", text: "follow-up" }], index: 0 });
      watcher.pushMessage(sessionId, { role: "assistant", parts: [{ type: "text", text: "response-2" }], index: 0 });
      // Indices should continue at 2, 3

      // Subscribe a client — should see all 4 messages with contiguous indices
      const { ws, sent } = createMockWs();
      await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);

      const messages = parseMessages(sent);
      expect(messages).toHaveLength(4);
      expect(messages[0].index).toBe(0);
      expect(messages[1].index).toBe(1);
      expect(messages[2].index).toBe(2);
      expect(messages[3].index).toBe(3);
      expect((messages[0] as { parts: Array<{ text?: string }> }).parts[0].text).toBe("first");
      expect((messages[2] as { parts: Array<{ text?: string }> }).parts[0].text).toBe("follow-up");

      watcher.stop();
    });
  });

  describe("edge cases", () => {
    it("skips lines that normalize to null", async () => {
      const sessionId = "sess-skip";
      const filePath = join(subDir, `${sessionId}.jsonl`);
      // Line that the mock adapter returns null for (no "type":"text")
      await writeFile(filePath, '{"type":"system","data":"ignored"}\n' + jsonlLine("visible"));

      const fileMap = new Map([[sessionId, filePath]]);
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      const { ws, sent } = createMockWs();
      await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);

      const messages = parseMessages(sent);
      expect(messages).toHaveLength(1);
      expect((messages[0] as { parts: Array<{ text?: string }> }).parts[0].text).toBe("visible");

      watcher.stop();
    });

    it("handles file that does not exist yet at subscribe time (ENOENT on replay)", async () => {
      const sessionId = "sess-nofile";
      // Point to a path that doesn't exist on disk yet
      const filePath = join(subDir, `${sessionId}.jsonl`);

      const fileMap = new Map([[sessionId, filePath]]);
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);
      watcher.start(50);

      const { ws, sent } = createMockWs();
      await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);
      // subscribe defaults to poll mode

      // Should get replay_complete (no messages, file doesn't exist)
      expect(hasReplayComplete(sent)).toBe(true);
      expect(parseMessages(sent)).toHaveLength(0);

      // Now create the file — polling should pick it up
      sent.length = 0;
      await writeFile(filePath, jsonlLine("appeared"));
      await delay(200);

      expect(parseMessages(sent)).toHaveLength(1);
      expect((parseMessages(sent)[0] as { parts: Array<{ text?: string }> }).parts[0].text).toBe("appeared");

      watcher.stop();
    });

    it("skips closed WebSocket clients during broadcast", async () => {
      const sessionId = "sess-closed-ws";
      const filePath = join(subDir, `${sessionId}.jsonl`);
      await writeFile(filePath, jsonlLine("init"));

      const fileMap = new Map([[sessionId, filePath]]);
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);
      watcher.start(50);

      const client1 = createMockWs();
      const client2 = createMockWs();
      await watcher.subscribe(sessionId, client1.ws as unknown as import("ws").WebSocket);
      await watcher.subscribe(sessionId, client2.ws as unknown as import("ws").WebSocket);
      // subscribe defaults to poll mode

      // Simulate client1 closing
      client1.ws.readyState = 3; // CLOSED
      client1.sent.length = 0;
      client2.sent.length = 0;

      await appendFile(filePath, jsonlLine("after-close"));
      await delay(200);

      // client1 should NOT receive (closed)
      expect(parseMessages(client1.sent)).toHaveLength(0);
      // client2 should receive
      expect(parseMessages(client2.sent)).toHaveLength(1);

      watcher.stop();
    });

    it("maintains correct message indices across replay and live updates", async () => {
      const sessionId = "sess-idx";
      const filePath = join(subDir, `${sessionId}.jsonl`);
      await writeFile(filePath, jsonlLine("msg-0") + jsonlLine("msg-1"));

      const fileMap = new Map([[sessionId, filePath]]);
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);
      watcher.start(50);

      const { ws, sent } = createMockWs();
      await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);
      // subscribe defaults to poll mode

      // Replay: indices 0, 1
      const replayMsgs = parseMessages(sent);
      expect(replayMsgs[0].index).toBe(0);
      expect(replayMsgs[1].index).toBe(1);

      sent.length = 0;
      await appendFile(filePath, jsonlLine("msg-2"));
      await delay(200);

      // Live update: index 2
      const liveMsgs = parseMessages(sent);
      expect(liveMsgs[0].index).toBe(2);

      watcher.stop();
    });
  });

  describe("start / stop", () => {
    it("stop clears the interval", async () => {
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);
      watcher.start(50);
      watcher.stop();
      // Should be safe to call stop again
      watcher.stop();
    });

    it("watchedCount reflects active sessions", async () => {
      // Use sessions without files — entries are cleaned up on last unsubscribe
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      const c1 = createMockWs();
      const c2 = createMockWs();
      await watcher.subscribe("s1", c1.ws as unknown as import("ws").WebSocket);
      await watcher.subscribe("s2", c2.ws as unknown as import("ws").WebSocket);
      expect(watcher.watchedCount).toBe(2);

      watcher.unsubscribe("s1", c1.ws as unknown as import("ws").WebSocket);
      expect(watcher.watchedCount).toBe(1);

      watcher.unsubscribe("s2", c2.ws as unknown as import("ws").WebSocket);
      expect(watcher.watchedCount).toBe(0);

      watcher.stop();
    });
  });

  describe("pendingThinkingText buffer", () => {
    it("accumulates thinking_delta text and replays to late-connecting subscriber", async () => {
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      const sessionId = "sess-thinking-buffer";
      watcher.setMode(sessionId, "push");

      // Push thinking deltas with NO clients connected
      watcher.pushEvent(sessionId, { type: "thinking_delta", text: "First " });
      watcher.pushEvent(sessionId, { type: "thinking_delta", text: "thought." });

      // Late-connecting subscriber should receive concatenated buffer
      const { ws, sent } = createMockWs();
      await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);

      const thinkingEvents = sent.map((s) => JSON.parse(s)).filter((e: { type: string }) => e.type === "thinking_delta");
      expect(thinkingEvents).toHaveLength(1);
      expect(thinkingEvents[0].text).toBe("First thought.");

      watcher.stop();
    });

    it("sends thinking_delta before replay_complete", async () => {
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      const sessionId = "sess-thinking-order";
      watcher.setMode(sessionId, "push");

      watcher.pushEvent(sessionId, { type: "thinking_delta", text: "buffered" });

      const { ws, sent } = createMockWs();
      await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);

      const parsed = sent.map((s) => JSON.parse(s));
      const thinkingIdx = parsed.findIndex((e: { type: string }) => e.type === "thinking_delta");
      const replayIdx = parsed.findIndex((e: { type: string }) => e.type === "replay_complete");
      expect(thinkingIdx).toBeGreaterThanOrEqual(0);
      expect(replayIdx).toBeGreaterThan(thinkingIdx);

      watcher.stop();
    });

    it("clears buffer when pushMessage receives assistant with reasoning part", async () => {
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      const sessionId = "sess-clear-thinking";
      watcher.setMode(sessionId, "push");

      // Accumulate thinking deltas (no clients)
      watcher.pushEvent(sessionId, { type: "thinking_delta", text: "accumulated" });

      // Push assistant message WITH reasoning part — buffer should clear
      watcher.pushMessage(sessionId, {
        role: "assistant",
        parts: [
          { type: "reasoning", text: "accumulated" },
          { type: "text", text: "answer" },
        ],
        index: 0,
      });

      // Late subscriber should NOT receive a thinking_delta replay
      const { ws, sent } = createMockWs();
      await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);

      const thinkingEvents = sent.map((s) => JSON.parse(s)).filter((e: { type: string }) => e.type === "thinking_delta");
      expect(thinkingEvents).toHaveLength(0);

      watcher.stop();
    });

    it("does NOT clear buffer when assistant message lacks reasoning part", async () => {
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      const sessionId = "sess-no-clear";
      watcher.setMode(sessionId, "push");

      watcher.pushEvent(sessionId, { type: "thinking_delta", text: "still buffered" });

      // Push assistant message WITHOUT reasoning part
      watcher.pushMessage(sessionId, {
        role: "assistant",
        parts: [{ type: "text", text: "partial answer" }],
        index: 0,
      });

      // Buffer should remain — late subscriber still gets the thinking delta
      const { ws, sent } = createMockWs();
      await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);

      const thinkingEvents = sent.map((s) => JSON.parse(s)).filter((e: { type: string }) => e.type === "thinking_delta");
      expect(thinkingEvents).toHaveLength(1);
      expect(thinkingEvents[0].text).toBe("still buffered");

      watcher.stop();
    });

    it("clears buffer on terminal status event (completed)", async () => {
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      const sessionId = "sess-clear-on-complete";
      watcher.setMode(sessionId, "push");

      watcher.pushEvent(sessionId, { type: "thinking_delta", text: "stale thinking" });
      watcher.pushEvent(sessionId, { type: "status", status: "completed" });

      // Late subscriber should NOT get stale thinking text
      const { ws, sent } = createMockWs();
      await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);

      const thinkingEvents = sent.map((s) => JSON.parse(s)).filter((e: { type: string }) => e.type === "thinking_delta");
      expect(thinkingEvents).toHaveLength(0);

      watcher.stop();
    });

    it("clears buffer on terminal status event (error)", async () => {
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      const sessionId = "sess-clear-on-error";
      watcher.setMode(sessionId, "push");

      watcher.pushEvent(sessionId, { type: "thinking_delta", text: "failed thinking" });
      watcher.pushEvent(sessionId, { type: "status", status: "error" });

      const { ws, sent } = createMockWs();
      await watcher.subscribe(sessionId, ws as unknown as import("ws").WebSocket);

      const thinkingEvents = sent.map((s) => JSON.parse(s)).filter((e: { type: string }) => e.type === "thinking_delta");
      expect(thinkingEvents).toHaveLength(0);

      watcher.stop();
    });

    it("does not send thinking_delta to already-connected clients via replay", async () => {
      const fileMap = new Map<string, string>();
      const adapter = createMockAdapter(fileMap);
      const watcher = new SessionWatcher(adapter);

      const sessionId = "sess-no-dup";
      watcher.setMode(sessionId, "push");

      // Client A connects before thinking starts — receives live broadcasts
      const clientA = createMockWs();
      await watcher.subscribe(sessionId, clientA.ws as unknown as import("ws").WebSocket);
      clientA.sent.length = 0;

      // Push thinking deltas — client A gets them via broadcast
      watcher.pushEvent(sessionId, { type: "thinking_delta", text: "live delta" });
      expect(clientA.sent.map((s) => JSON.parse(s)).filter((e: { type: string }) => e.type === "thinking_delta")).toHaveLength(1);

      // Client B connects late — should get consolidated buffer via replay only
      const clientB = createMockWs();
      clientA.sent.length = 0;
      await watcher.subscribe(sessionId, clientB.ws as unknown as import("ws").WebSocket);

      // Client B gets the buffered thinking_delta
      const clientBThinking = clientB.sent.map((s) => JSON.parse(s)).filter((e: { type: string }) => e.type === "thinking_delta");
      expect(clientBThinking).toHaveLength(1);
      expect(clientBThinking[0].text).toBe("live delta");

      // Client A should NOT have received a duplicate thinking_delta from the replay
      const clientAThinking = clientA.sent.map((s) => JSON.parse(s)).filter((e: { type: string }) => e.type === "thinking_delta");
      expect(clientAThinking).toHaveLength(0);

      watcher.stop();
    });
  });
});
