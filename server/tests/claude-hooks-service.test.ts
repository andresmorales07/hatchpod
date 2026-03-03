import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeHooksService } from "../src/claude-hooks.js";
import type { HookConfig } from "../src/schemas/claude-hooks.js";

vi.mock("../src/session-history.js");

describe("ClaudeHooksService", () => {
  let tmpDir: string;
  let service: ClaudeHooksService;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "claude-hooks-"));
    service = new ClaudeHooksService(tmpDir);
  });

  afterEach(async () => {
    service.unwatchAll();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("readHooks", () => {
    it("returns {} when file doesn't exist", async () => {
      const result = await service.readHooks("user");
      expect(result).toEqual({});
    });

    it("extracts only hooks from file with other settings", async () => {
      const settingsDir = join(tmpDir, ".claude");
      await mkdir(settingsDir, { recursive: true });
      await writeFile(
        join(settingsDir, "settings.json"),
        JSON.stringify({
          permissions: { allow: ["Bash"] },
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "echo done" }] }],
          },
        }),
      );

      const result = await service.readHooks("user");
      expect(result).toEqual({
        Stop: [{ hooks: [{ type: "command", command: "echo done" }] }],
      });
    });

    it("returns {} when file has no hooks field", async () => {
      const settingsDir = join(tmpDir, ".claude");
      await mkdir(settingsDir, { recursive: true });
      await writeFile(
        join(settingsDir, "settings.json"),
        JSON.stringify({ model: "sonnet" }),
      );

      const result = await service.readHooks("user");
      expect(result).toEqual({});
    });

    it("returns {} when hooks field is invalid", async () => {
      const settingsDir = join(tmpDir, ".claude");
      await mkdir(settingsDir, { recursive: true });
      await writeFile(
        join(settingsDir, "settings.json"),
        JSON.stringify({
          hooks: {
            InvalidEvent: [{ hooks: [{ type: "command", command: "echo" }] }],
          },
        }),
      );

      const result = await service.readHooks("user");
      expect(result).toEqual({});
    });

    it("returns {} when file contains invalid JSON", async () => {
      const settingsDir = join(tmpDir, ".claude");
      await mkdir(settingsDir, { recursive: true });
      await writeFile(join(settingsDir, "settings.json"), "not json");

      const result = await service.readHooks("user");
      expect(result).toEqual({});
    });

    it("throws on unexpected I/O errors (non-ENOENT)", async () => {
      // Simulate an EACCES-style error by making the .claude dir a file
      await writeFile(join(tmpDir, ".claude"), "not-a-directory");

      await expect(service.readHooks("user")).rejects.toThrow();
    });

    it("reads workspace-scoped hooks", async () => {
      const workspaceDir = join(tmpDir, "my-project");
      const settingsDir = join(workspaceDir, ".claude");
      await mkdir(settingsDir, { recursive: true });
      await writeFile(
        join(settingsDir, "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: "echo pre-tool" }],
              },
            ],
          },
        }),
      );

      const result = await service.readHooks("workspace", workspaceDir);
      expect(result).toEqual({
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "echo pre-tool" }],
          },
        ],
      });
    });

    it("throws when workspace scope is missing path", async () => {
      await expect(service.readHooks("workspace")).rejects.toThrow(
        "Workspace scope requires a path",
      );
    });
  });

  describe("writeHooks", () => {
    it("creates file and .claude/ dir when they don't exist", async () => {
      const hooks: HookConfig = {
        Stop: [{ hooks: [{ type: "command", command: "echo stopped" }] }],
      };

      await service.writeHooks("user", hooks);

      const filePath = join(tmpDir, ".claude", "settings.json");
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed.hooks).toEqual(hooks);
    });

    it("preserves non-hook fields", async () => {
      const settingsDir = join(tmpDir, ".claude");
      await mkdir(settingsDir, { recursive: true });
      await writeFile(
        join(settingsDir, "settings.json"),
        JSON.stringify({
          permissions: { allow: ["Bash"] },
          model: "sonnet",
        }),
      );

      const hooks: HookConfig = {
        SessionStart: [
          { hooks: [{ type: "command", command: "echo hello" }] },
        ],
      };

      await service.writeHooks("user", hooks);

      const raw = await readFile(
        join(settingsDir, "settings.json"),
        "utf-8",
      );
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed.permissions).toEqual({ allow: ["Bash"] });
      expect(parsed.model).toBe("sonnet");
      expect(parsed.hooks).toEqual(hooks);
    });

    it("throws on corrupt JSON in existing file", async () => {
      const settingsDir = join(tmpDir, ".claude");
      await mkdir(settingsDir, { recursive: true });
      await writeFile(join(settingsDir, "settings.json"), "not json");

      const hooks: HookConfig = {
        Stop: [{ hooks: [{ type: "command", command: "echo" }] }],
      };

      await expect(service.writeHooks("user", hooks)).rejects.toThrow(
        "Settings file contains invalid JSON",
      );
    });

    it("overwrites existing hooks field", async () => {
      const settingsDir = join(tmpDir, ".claude");
      await mkdir(settingsDir, { recursive: true });
      await writeFile(
        join(settingsDir, "settings.json"),
        JSON.stringify({
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "echo old" }] }],
          },
        }),
      );

      const newHooks: HookConfig = {
        SessionStart: [
          { hooks: [{ type: "command", command: "echo new" }] },
        ],
      };

      await service.writeHooks("user", newHooks);

      const raw = await readFile(
        join(settingsDir, "settings.json"),
        "utf-8",
      );
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed.hooks).toEqual(newHooks);
    });

    it("writes to workspace scope", async () => {
      const workspaceDir = join(tmpDir, "my-project");
      const hooks: HookConfig = {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "echo pre" }],
          },
        ],
      };

      await service.writeHooks("workspace", hooks, workspaceDir);

      const filePath = join(workspaceDir, ".claude", "settings.json");
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed.hooks).toEqual(hooks);
    });

    it("performs atomic write (temp file + rename)", async () => {
      const hooks: HookConfig = {
        Stop: [{ hooks: [{ type: "command", command: "echo" }] }],
      };

      await service.writeHooks("user", hooks);

      // Verify no leftover .tmp files
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(join(tmpDir, ".claude"));
      const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe("listWorkspaces", () => {
    it("returns unique cwds with counts sorted by count descending", async () => {
      const { listAllSessionHistory } = await import(
        "../src/session-history.js"
      );
      const mockListAll = vi.mocked(listAllSessionHistory);

      mockListAll.mockResolvedValue([
        {
          id: "a",
          slug: null,
          summary: null,
          cwd: "/home/user/project-a",
          lastModified: new Date(),
          createdAt: new Date(),
        },
        {
          id: "b",
          slug: null,
          summary: null,
          cwd: "/home/user/project-b",
          lastModified: new Date(),
          createdAt: new Date(),
        },
        {
          id: "c",
          slug: null,
          summary: null,
          cwd: "/home/user/project-a",
          lastModified: new Date(),
          createdAt: new Date(),
        },
        {
          id: "d",
          slug: null,
          summary: null,
          cwd: "/home/user/project-a",
          lastModified: new Date(),
          createdAt: new Date(),
        },
        {
          id: "e",
          slug: null,
          summary: null,
          cwd: "/home/user/project-b",
          lastModified: new Date(),
          createdAt: new Date(),
        },
      ]);

      const result = await service.listWorkspaces();

      expect(result).toEqual([
        { path: "/home/user/project-a", sessionCount: 3 },
        { path: "/home/user/project-b", sessionCount: 2 },
      ]);
    });

    it("returns empty array when no sessions exist", async () => {
      const { listAllSessionHistory } = await import(
        "../src/session-history.js"
      );
      const mockListAll = vi.mocked(listAllSessionHistory);
      mockListAll.mockResolvedValue([]);

      const result = await service.listWorkspaces();
      expect(result).toEqual([]);
    });

    it("skips sessions with empty cwd", async () => {
      const { listAllSessionHistory } = await import(
        "../src/session-history.js"
      );
      const mockListAll = vi.mocked(listAllSessionHistory);

      mockListAll.mockResolvedValue([
        {
          id: "a",
          slug: null,
          summary: null,
          cwd: "",
          lastModified: new Date(),
          createdAt: new Date(),
        },
        {
          id: "b",
          slug: null,
          summary: null,
          cwd: "/home/user/project",
          lastModified: new Date(),
          createdAt: new Date(),
        },
      ]);

      const result = await service.listWorkspaces();
      expect(result).toEqual([
        { path: "/home/user/project", sessionCount: 1 },
      ]);
    });
  });

  describe("watchFile", () => {
    it("returns an unsubscribe function", () => {
      const settingsDir = join(tmpDir, ".claude");
      // watchFile on a non-existent file should return a no-op unsubscribe
      const unsub = service.watchFile(
        join(settingsDir, "settings.json"),
        () => {},
      );
      expect(typeof unsub).toBe("function");
      unsub();
    });

    it("calls callback on file change with debounce", async () => {
      const settingsDir = join(tmpDir, ".claude");
      await mkdir(settingsDir, { recursive: true });
      const filePath = join(settingsDir, "settings.json");
      await writeFile(filePath, JSON.stringify({ hooks: {} }));

      const callback = vi.fn();
      const unsub = service.watchFile(filePath, callback);

      try {
        // Modify the file
        await writeFile(filePath, JSON.stringify({ hooks: { Stop: [] } }));

        // Wait for debounce (500ms) + buffer
        await new Promise((r) => setTimeout(r, 800));

        expect(callback).toHaveBeenCalled();
      } finally {
        unsub();
      }
    });

    it("calling watchFile twice on the same path replaces the first watcher", async () => {
      const settingsDir = join(tmpDir, ".claude");
      await mkdir(settingsDir, { recursive: true });
      const filePath = join(settingsDir, "settings.json");
      await writeFile(filePath, "{}");

      const cb1 = vi.fn();
      const cb2 = vi.fn();
      service.watchFile(filePath, cb1);
      service.watchFile(filePath, cb2); // replaces cb1's watcher

      await writeFile(filePath, JSON.stringify({ v: 1 }));
      await new Promise((r) => setTimeout(r, 800));

      // Only cb2 should fire — cb1's watcher was replaced
      expect(cb2).toHaveBeenCalled();
      expect(cb1).not.toHaveBeenCalled();
    });

    it("debounces rapid changes into single callback", async () => {
      const settingsDir = join(tmpDir, ".claude");
      await mkdir(settingsDir, { recursive: true });
      const filePath = join(settingsDir, "settings.json");
      await writeFile(filePath, JSON.stringify({ hooks: {} }));

      const callback = vi.fn();
      const unsub = service.watchFile(filePath, callback);

      try {
        // Rapid writes within the debounce window
        await writeFile(filePath, JSON.stringify({ v: 1 }));
        await writeFile(filePath, JSON.stringify({ v: 2 }));
        await writeFile(filePath, JSON.stringify({ v: 3 }));

        // Wait for debounce
        await new Promise((r) => setTimeout(r, 800));

        // Should have debounced into one (or very few) calls
        expect(callback.mock.calls.length).toBeLessThanOrEqual(2);
        expect(callback.mock.calls.length).toBeGreaterThanOrEqual(1);
      } finally {
        unsub();
      }
    });
  });

  describe("unwatchAll", () => {
    it("stops callbacks from firing after unwatchAll", async () => {
      const settingsDir = join(tmpDir, ".claude");
      await mkdir(settingsDir, { recursive: true });
      const filePath = join(settingsDir, "settings.json");
      await writeFile(filePath, "{}");

      const cb = vi.fn();
      service.watchFile(filePath, cb);
      service.unwatchAll();

      // Write after unwatchAll — callback must not fire
      await writeFile(filePath, JSON.stringify({ v: 1 }));
      await new Promise((r) => setTimeout(r, 800));

      expect(cb).not.toHaveBeenCalled();
    });
  });
});
