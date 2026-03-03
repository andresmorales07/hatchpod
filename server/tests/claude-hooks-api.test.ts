import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { startServer, stopServer, api, rawFetch } from "./helpers.js";
import type { ClaudeHooksService } from "../src/claude-hooks.js";
import type { HookConfig, WorkspaceInfo } from "../src/schemas/claude-hooks.js";

let service: ClaudeHooksService;

describe("Claude Hooks API", () => {
  beforeAll(async () => {
    await startServer();
    const { getClaudeHooksService } = await import("../src/index.js");
    service = getClaudeHooksService();
  });
  afterAll(async () => { await stopServer(); });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // --- GET /api/claude-hooks/user ---

  it("GET /api/claude-hooks/user returns hooks from user settings", async () => {
    const mockHooks: HookConfig = {
      PreToolUse: [{ hooks: [{ type: "command", command: "echo pre" }] }],
    };
    vi.spyOn(service, "readHooks").mockResolvedValue(mockHooks);

    const res = await api("/api/claude-hooks/user");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(mockHooks);
    expect(service.readHooks).toHaveBeenCalledWith("user");
  });

  // --- PUT /api/claude-hooks/user ---

  it("PUT /api/claude-hooks/user saves hooks and returns updated config", async () => {
    const hookConfig: HookConfig = {
      PostToolUse: [{ hooks: [{ type: "command", command: "npm test" }] }],
    };
    vi.spyOn(service, "writeHooks").mockResolvedValue(undefined);

    const res = await api("/api/claude-hooks/user", {
      method: "PUT",
      body: JSON.stringify(hookConfig),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(hookConfig);
    expect(service.writeHooks).toHaveBeenCalledWith("user", hookConfig);
  });

  it("PUT /api/claude-hooks/user rejects invalid hook config", async () => {
    const res = await api("/api/claude-hooks/user", {
      method: "PUT",
      body: JSON.stringify({
        InvalidEvent: [{ hooks: [{ type: "command", command: "echo" }] }],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  // --- GET /api/claude-hooks/workspace ---

  it("GET /api/claude-hooks/workspace?path=X returns workspace hooks", async () => {
    const mockHooks: HookConfig = {
      SessionStart: [{ hooks: [{ type: "command", command: "echo start" }] }],
    };
    vi.spyOn(service, "readHooks").mockResolvedValue(mockHooks);

    const workspacePath = `${process.env.HOME ?? "/home/hatchpod"}/workspace/myproject`;
    const res = await api(`/api/claude-hooks/workspace?path=${encodeURIComponent(workspacePath)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(mockHooks);
    expect(service.readHooks).toHaveBeenCalledWith("workspace", workspacePath);
  });

  it("GET /api/claude-hooks/workspace without path returns 400", async () => {
    const res = await api("/api/claude-hooks/workspace");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("path");
  });

  it("GET /api/claude-hooks/workspace with path traversal returns 403", async () => {
    const res = await api("/api/claude-hooks/workspace?path=../../etc");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("traversal");
  });

  // --- PUT /api/claude-hooks/workspace ---

  it("PUT /api/claude-hooks/workspace?path=X saves workspace hooks", async () => {
    const hookConfig: HookConfig = {
      Stop: [{ hooks: [{ type: "command", command: "echo done" }] }],
    };
    vi.spyOn(service, "writeHooks").mockResolvedValue(undefined);

    const workspacePath = `${process.env.HOME ?? "/home/hatchpod"}/workspace/myproject`;
    const res = await api(`/api/claude-hooks/workspace?path=${encodeURIComponent(workspacePath)}`, {
      method: "PUT",
      body: JSON.stringify(hookConfig),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(hookConfig);
    expect(service.writeHooks).toHaveBeenCalledWith("workspace", hookConfig, workspacePath);
  });

  it("PUT /api/claude-hooks/workspace without path returns 400", async () => {
    const res = await api("/api/claude-hooks/workspace", {
      method: "PUT",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("path");
  });

  it("PUT /api/claude-hooks/workspace with path traversal returns 403", async () => {
    const res = await api("/api/claude-hooks/workspace?path=../../etc", {
      method: "PUT",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("traversal");
  });

  // --- GET /api/workspaces ---

  it("GET /api/workspaces returns workspace list", async () => {
    const mockWorkspaces: WorkspaceInfo[] = [
      { path: "/home/hatchpod/workspace/project-a", sessionCount: 5 },
      { path: "/home/hatchpod/workspace/project-b", sessionCount: 2 },
    ];
    vi.spyOn(service, "listWorkspaces").mockResolvedValue(mockWorkspaces);

    const res = await api("/api/workspaces");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(mockWorkspaces);
  });

  // --- Auth ---

  it("GET /api/claude-hooks/user returns 401 without auth", async () => {
    const res = await rawFetch("/api/claude-hooks/user");
    expect(res.status).toBe(401);
  });

  it("PUT /api/claude-hooks/user returns 401 without auth", async () => {
    const res = await rawFetch("/api/claude-hooks/user", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/claude-hooks/workspace returns 401 without auth", async () => {
    const res = await rawFetch("/api/claude-hooks/workspace?path=/tmp");
    expect(res.status).toBe(401);
  });

  it("PUT /api/claude-hooks/workspace returns 401 without auth", async () => {
    const res = await rawFetch("/api/claude-hooks/workspace?path=/tmp", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/workspaces returns 401 without auth", async () => {
    const res = await rawFetch("/api/workspaces");
    expect(res.status).toBe(401);
  });

  // --- Error handling ---

  it("GET /api/claude-hooks/user returns 500 on service error", async () => {
    vi.spyOn(service, "readHooks").mockRejectedValue(new Error("disk failure"));

    const res = await api("/api/claude-hooks/user");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal server error");
  });

  it("PUT /api/claude-hooks/user returns 500 on service error", async () => {
    vi.spyOn(service, "writeHooks").mockRejectedValue(new Error("disk failure"));

    const res = await api("/api/claude-hooks/user", {
      method: "PUT",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal server error");
  });
});
