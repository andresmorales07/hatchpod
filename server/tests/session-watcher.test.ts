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
  describe("subscribe — replay", () => {
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

  describe("polling — broadcast new lines", () => {
    it("broadcasts new lines after subscribe", async () => {
      const sessionId = "sess-live";
      const filePath = join(subDir, `${sessionId}.jsonl`);
      // Start with one line
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

      // Clear sent and append new lines
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
  });

  describe("unsubscribe", () => {
    it("stops watching when last client unsubscribes", async () => {
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
      expect(watcher.watchedCount).toBe(0);

      // Append data after unsub — should NOT be delivered
      sent.length = 0;
      await appendFile(filePath, jsonlLine("after-unsub"));
      await delay(200);

      expect(parseMessages(sent)).toHaveLength(0);

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
      const filePath1 = join(subDir, "s1.jsonl");
      const filePath2 = join(subDir, "s2.jsonl");
      await writeFile(filePath1, jsonlLine("a"));
      await writeFile(filePath2, jsonlLine("b"));

      const fileMap = new Map([["s1", filePath1], ["s2", filePath2]]);
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
});
