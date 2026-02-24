import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const testDir = join(tmpdir(), `hatchpod-history-ep-test-${Date.now()}`);
const fakeClaudeDir = join(testDir, ".claude", "projects");
const fakeProjectDir = join(fakeClaudeDir, "-home-user-workspace");

let startServer: typeof import("./helpers.js").startServer;
let stopServer: typeof import("./helpers.js").stopServer;
let api: typeof import("./helpers.js").api;
let clearHistoryCache: typeof import("../src/session-history.js").clearHistoryCache;

beforeAll(async () => {
  process.env.CLAUDE_PROJECTS_DIR = fakeClaudeDir;
  await mkdir(fakeProjectDir, { recursive: true });

  const helpers = await import("./helpers.js");
  startServer = helpers.startServer;
  stopServer = helpers.stopServer;
  api = helpers.api;

  const historyMod = await import("../src/session-history.js");
  clearHistoryCache = historyMod.clearHistoryCache;

  await startServer();
});

afterAll(async () => {
  await stopServer();
  delete process.env.CLAUDE_PROJECTS_DIR;
  await rm(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  clearHistoryCache();
});

function makeJsonl(sessionId: string): string {
  return [
    JSON.stringify({
      type: "progress",
      sessionId,
      cwd: "/home/user/workspace",
      timestamp: "2026-02-20T10:00:00.000Z",
    }),
    JSON.stringify({
      type: "user",
      sessionId,
      message: { role: "user", content: "Hello there" },
      timestamp: "2026-02-20T10:00:01.000Z",
    }),
    JSON.stringify({
      type: "assistant",
      sessionId,
      message: {
        role: "assistant",
        type: "message",
        content: [{ type: "text", text: "Hi! How can I help?" }],
      },
      timestamp: "2026-02-20T10:00:02.000Z",
    }),
  ].join("\n") + "\n";
}

describe("GET /api/sessions/:id/history", () => {
  it("returns normalized messages for a valid session", async () => {
    const sid = randomUUID();
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), makeJsonl(sid));

    const res = await api(`/api/sessions/${sid}/history`);
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ role: string; parts: unknown[]; index: number }>;
    expect(body).toHaveLength(2); // user + assistant (progress skipped)
    expect(body[0].role).toBe("user");
    expect(body[1].role).toBe("assistant");
    expect(body[0].index).toBe(0);
    expect(body[1].index).toBe(1);
  });

  it("returns 404 for nonexistent session (SessionNotFound)", async () => {
    const res = await api(`/api/sessions/${randomUUID()}/history`);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("session history not found");
  });

  it("returns 400 for invalid UUID format (matching route regex)", async () => {
    // Use a 36-char hex string that matches the route regex but fails UUID_RE
    const fakeId = "abcdef0123456789abcdef0123456789abcd";
    const res = await api(`/api/sessions/${fakeId}/history`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid session ID");
  });

  it("returns 400 for unknown provider", async () => {
    const sid = randomUUID();
    const res = await api(`/api/sessions/${sid}/history?provider=nonexistent`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unknown provider");
  });

  it("returns empty array for test provider (no JSONL files)", async () => {
    const sid = randomUUID();
    const res = await api(`/api/sessions/${sid}/history?provider=test`);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(body).toEqual([]);
  });

  it("defaults to claude provider when no ?provider= param", async () => {
    const sid = randomUUID();
    await writeFile(join(fakeProjectDir, `${sid}.jsonl`), makeJsonl(sid));

    // No provider param → defaults to claude
    const res = await api(`/api/sessions/${sid}/history`);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(body).toHaveLength(2);
  });
});
