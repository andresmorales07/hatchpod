import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { writeFile, mkdir, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// We test the module's functions directly
let listSessionHistory: typeof import("../src/session-history.js").listSessionHistory;
let cwdToProjectDir: typeof import("../src/session-history.js").cwdToProjectDir;
let clearHistoryCache: typeof import("../src/session-history.js").clearHistoryCache;
let findSessionFile: typeof import("../src/session-history.js").findSessionFile;

const testDir = join(tmpdir(), `hatchpod-history-test-${Date.now()}`);
const fakeClaudeDir = join(testDir, ".claude", "projects");
const fakeCwd = "/home/user/workspace/myproject";
const fakeProjectDir = join(fakeClaudeDir, "-home-user-workspace-myproject");

beforeAll(async () => {
  // Override HOME so cwdToProjectDir resolves to our test directory
  process.env.CLAUDE_PROJECTS_DIR = fakeClaudeDir;

  // Import after setting env
  const mod = await import("../src/session-history.js");
  listSessionHistory = mod.listSessionHistory;
  cwdToProjectDir = mod.cwdToProjectDir;
  clearHistoryCache = mod.clearHistoryCache;
  findSessionFile = mod.findSessionFile;

  await mkdir(fakeProjectDir, { recursive: true });
});

afterAll(async () => {
  delete process.env.CLAUDE_PROJECTS_DIR;
  await rm(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  clearHistoryCache();
});

function makeJsonl(sessionId: string, opts: {
  slug?: string;
  userMessage?: string;
  timestamp?: string;
  cwd?: string;
}): string {
  const ts = opts.timestamp ?? "2026-02-20T10:00:00.000Z";
  const lines: string[] = [];
  // Progress line with slug
  lines.push(JSON.stringify({
    type: "progress",
    sessionId,
    slug: opts.slug ?? null,
    cwd: opts.cwd ?? fakeCwd,
    timestamp: ts,
  }));
  // User message
  if (opts.userMessage) {
    lines.push(JSON.stringify({
      type: "user",
      sessionId,
      slug: opts.slug ?? null,
      cwd: opts.cwd ?? fakeCwd,
      timestamp: ts,
      message: { role: "user", content: opts.userMessage },
    }));
  }
  return lines.join("\n") + "\n";
}

describe("session-history", () => {
  describe("cwdToProjectDir", () => {
    it("mangles CWD path correctly", () => {
      const dir = cwdToProjectDir("/home/user/workspace/myproject");
      expect(dir).toContain("-home-user-workspace-myproject");
    });
  });

  describe("listSessionHistory", () => {
    it("returns empty array when project dir does not exist", async () => {
      const result = await listSessionHistory("/nonexistent/path");
      expect(result).toEqual([]);
    });

    it("discovers sessions from JSONL files", async () => {
      const sid = randomUUID();
      const content = makeJsonl(sid, {
        slug: "happy-dancing-cat",
        userMessage: "Hello world",
        timestamp: "2026-02-20T12:00:00.000Z",
      });
      await writeFile(join(fakeProjectDir, `${sid}.jsonl`), content);

      const result = await listSessionHistory(fakeCwd);
      const found = result.find((s) => s.id === sid);
      expect(found).toBeDefined();
      expect(found!.slug).toBe("happy-dancing-cat");
      expect(found!.summary).toBe("Hello world");
    });

    it("uses file mtime as lastModified", async () => {
      const sid = randomUUID();
      const content = makeJsonl(sid, { slug: "test-slug" });
      const filePath = join(fakeProjectDir, `${sid}.jsonl`);
      await writeFile(filePath, content);

      // Set a known mtime
      const knownDate = new Date("2026-01-15T08:00:00.000Z");
      await utimes(filePath, knownDate, knownDate);

      const result = await listSessionHistory(fakeCwd);
      const found = result.find((s) => s.id === sid);
      expect(found).toBeDefined();
      expect(found!.lastModified.getTime()).toBe(knownDate.getTime());
    });

    it("truncates long user messages to 80 chars", async () => {
      const sid = randomUUID();
      const longMsg = "A".repeat(200);
      const content = makeJsonl(sid, { userMessage: longMsg });
      await writeFile(join(fakeProjectDir, `${sid}.jsonl`), content);

      const result = await listSessionHistory(fakeCwd);
      const found = result.find((s) => s.id === sid);
      expect(found!.summary!.length).toBeLessThanOrEqual(80);
    });

    it("caches results and reuses on same mtime", async () => {
      const sid = randomUUID();
      const content = makeJsonl(sid, { slug: "cached-slug" });
      const filePath = join(fakeProjectDir, `${sid}.jsonl`);
      await writeFile(filePath, content);

      const result1 = await listSessionHistory(fakeCwd);
      const result2 = await listSessionHistory(fakeCwd);
      // Both should return the same data
      expect(result1.find((s) => s.id === sid)!.slug).toBe("cached-slug");
      expect(result2.find((s) => s.id === sid)!.slug).toBe("cached-slug");
    });

    it("skips non-JSONL files and directories", async () => {
      await writeFile(join(fakeProjectDir, "not-a-session.txt"), "hello");
      await mkdir(join(fakeProjectDir, "some-subdir"), { recursive: true });

      // Should not throw
      const result = await listSessionHistory(fakeCwd);
      // No entry for the txt file or subdir
      expect(result.every((s) => s.id !== "not-a-session")).toBe(true);
    });
  });

  describe("findSessionFile", () => {
    it("finds a session file by ID across project directories", async () => {
      const sid = randomUUID();
      const content = makeJsonl(sid, { slug: "findable-session" });
      await writeFile(join(fakeProjectDir, `${sid}.jsonl`), content);

      const result = await findSessionFile(sid);
      expect(result).toBe(join(fakeProjectDir, `${sid}.jsonl`));
    });

    it("returns null for nonexistent session ID", async () => {
      const result = await findSessionFile(randomUUID());
      expect(result).toBeNull();
    });
  });
});
