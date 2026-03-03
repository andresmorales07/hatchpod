import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { HookConfigSchema } from "./schemas/claude-hooks.js";
import type { HookConfig, WorkspaceInfo } from "./schemas/claude-hooks.js";
import { listAllSessionHistory } from "./session-history.js";

export class ClaudeHooksService {
  private watchers = new Map<string, FSWatcher>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly homeDir: string = homedir()) {}

  /**
   * Resolve the settings file path for a given scope.
   * - "user" scope: ~/.claude/settings.json
   * - "workspace" scope: <path>/.claude/settings.json
   */
  private resolveSettingsPath(scope: "user" | "workspace", path?: string): string {
    if (scope === "user") {
      return join(this.homeDir, ".claude", "settings.json");
    }
    if (!path) {
      throw new Error("Workspace scope requires a path");
    }
    return join(path, ".claude", "settings.json");
  }

  /**
   * Read hooks configuration from a settings file.
   * Returns {} if the file doesn't exist, has no hooks field, or has invalid hooks.
   */
  async readHooks(scope: "user" | "workspace", path?: string): Promise<HookConfig> {
    const filePath = this.resolveSettingsPath(scope, path);

    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch {
      return {};
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }

    if (!parsed.hooks || typeof parsed.hooks !== "object") {
      return {};
    }

    const result = HookConfigSchema.safeParse(parsed.hooks);
    return result.success ? result.data : {};
  }

  /**
   * Write hooks configuration to a settings file.
   * Preserves all non-hook fields in the existing file.
   * Uses atomic write (temp file + rename) to prevent corruption.
   */
  async writeHooks(scope: "user" | "workspace", hooks: HookConfig, path?: string): Promise<void> {
    const filePath = this.resolveSettingsPath(scope, path);

    // Read existing file content to preserve non-hook fields
    let existing: Record<string, unknown> = {};
    try {
      const raw = await readFile(filePath, "utf-8");
      try {
        existing = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new Error(`Settings file contains invalid JSON: ${filePath}`);
      }
    } catch (err) {
      // If the error is our own invalid-JSON error, re-throw it
      if (err instanceof Error && err.message.startsWith("Settings file contains invalid JSON")) {
        throw err;
      }
      // File doesn't exist — that's fine, we'll create it
    }

    // Merge: preserve existing fields, set hooks
    const merged = { ...existing, hooks };

    // Ensure the directory exists
    const dir = dirname(filePath);
    await mkdir(dir, { recursive: true });

    // Atomic write: temp file + rename
    const tmp = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(merged, null, 2));
    await rename(tmp, filePath);
  }

  /**
   * List workspaces derived from Claude Code session history.
   * Returns unique working directories with session counts, sorted by count descending.
   */
  async listWorkspaces(): Promise<WorkspaceInfo[]> {
    const sessions = await listAllSessionHistory();

    const counts = new Map<string, number>();
    for (const session of sessions) {
      if (session.cwd) {
        counts.set(session.cwd, (counts.get(session.cwd) ?? 0) + 1);
      }
    }

    const workspaces: WorkspaceInfo[] = [];
    for (const [cwdPath, sessionCount] of counts) {
      workspaces.push({ path: cwdPath, sessionCount });
    }

    workspaces.sort((a, b) => b.sessionCount - a.sessionCount);
    return workspaces;
  }

  /**
   * Watch a settings file for changes.
   * Calls the callback when the file is modified, debounced by 500ms.
   * Handles ENOENT gracefully (file might be deleted).
   * Returns an unsubscribe function that stops watching.
   */
  watchFile(filePath: string, callback: () => void): () => void {
    // If already watching this file, close the existing watcher first
    const existingWatcher = this.watchers.get(filePath);
    if (existingWatcher) {
      existingWatcher.close();
      this.watchers.delete(filePath);
    }

    const existingTimer = this.debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.debounceTimers.delete(filePath);
    }

    let watcher: FSWatcher;
    try {
      watcher = watch(filePath, () => {
        // Debounce by 500ms
        const existing = this.debounceTimers.get(filePath);
        if (existing) {
          clearTimeout(existing);
        }
        const timer = setTimeout(() => {
          this.debounceTimers.delete(filePath);
          callback();
        }, 500);
        this.debounceTimers.set(filePath, timer);
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        // File doesn't exist — return a no-op unsubscribe
        return () => {};
      }
      throw err;
    }

    watcher.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        // File was deleted — clean up silently
        watcher.close();
        this.watchers.delete(filePath);
        const timer = this.debounceTimers.get(filePath);
        if (timer) {
          clearTimeout(timer);
          this.debounceTimers.delete(filePath);
        }
        return;
      }
      console.warn(`File watcher error for ${filePath}:`, err);
    });

    this.watchers.set(filePath, watcher);

    return () => {
      watcher.close();
      this.watchers.delete(filePath);
      const timer = this.debounceTimers.get(filePath);
      if (timer) {
        clearTimeout(timer);
        this.debounceTimers.delete(filePath);
      }
    };
  }

  /**
   * Close all active file watchers and clear debounce timers.
   */
  unwatchAll(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}
