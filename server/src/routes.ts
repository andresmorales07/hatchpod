import type { IncomingMessage, ServerResponse } from "node:http";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { authenticateRequest, sendUnauthorized, sendRateLimited } from "./auth.js";
import {
  listSessionsWithHistory,
  getActiveSession,
  getSessionCount,
  createSession,
  deleteSession,
} from "./sessions.js";
import { listProviders, getProvider } from "./providers/index.js";
import { getCachedModels } from "./providers/claude-adapter.js";
import { CreateSessionRequestSchema, UuidSchema, isPathContained, openApiDocument, PatchSettingsSchema, CreateWebhookSchema, PatchWebhookSchema, HookConfigSchema } from "./schemas/index.js";
import { computeGitDiffStat } from "./git-status.js";
import { SERVER_VERSION } from "./version.js";
import { readSettings, writeSettings } from "./settings.js";
import { getCachedRateLimits } from "./rate-limits.js";
import { getWebhookRegistry, getWebhookDispatcher, getClaudeHooksService } from "./index.js";

const startTime = Date.now();

const SESSION_ID_RE = /^\/api\/sessions\/([0-9a-f-]{36})$/;
const SESSION_HISTORY_RE = /^\/api\/sessions\/([0-9a-f-]{36})\/history$/;
const SESSION_MESSAGES_RE = /^\/api\/sessions\/([0-9a-f-]{36})\/messages$/;

const WEBHOOK_RE = /^\/api\/webhooks$/;
const WEBHOOK_ID_RE = /^\/api\/webhooks\/([0-9a-f-]{36})$/;
const WEBHOOK_TEST_RE = /^\/api\/webhooks\/([0-9a-f-]{36})\/test$/;

const CLAUDE_HOOKS_USER_RE = /^\/api\/claude-hooks\/user$/;
const CLAUDE_HOOKS_WORKSPACE_RE = /^\/api\/claude-hooks\/workspace$/;
const WORKSPACES_RE = /^\/api\/workspaces$/;

const BROWSE_ROOT = process.env.BROWSE_ROOT ?? process.cwd();
const HOME_DIR = homedir();
const ALLOW_BYPASS_PERMISSIONS = process.env.ALLOW_BYPASS_PERMISSIONS === "1";

const SCALAR_HTML = `<!doctype html>
<html>
<head>
  <title>Hatchpod API Docs</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <script id="api-reference" data-url="/api/openapi.json"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;

  // Health check — no auth required
  if (pathname === "/healthz" && method === "GET") {
    const counts = getSessionCount();
    json(res, 200, {
      status: "ok",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      sessions: { active: counts.active, total: counts.total },
    });
    return;
  }

  // OpenAPI spec — no auth required
  if (pathname === "/api/openapi.json" && method === "GET") {
    json(res, 200, openApiDocument);
    return;
  }

  // API docs UI (Scalar) — no auth required
  if (pathname === "/api/docs" && method === "GET") {
    // Override CSP to allow Scalar CDN resources
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
      "img-src 'self' data: https://cdn.jsdelivr.net; " +
      "font-src 'self' https://cdn.jsdelivr.net; " +
      "connect-src 'self'; frame-ancestors 'none'",
    );
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(SCALAR_HTML);
    return;
  }

  // All other /api/* routes require auth
  if (pathname.startsWith("/api/")) {
    const authResult = authenticateRequest(req);
    if (authResult === "rate_limited") {
      sendRateLimited(res);
      return;
    }
    if (!authResult) {
      sendUnauthorized(res);
      return;
    }
  }

  // POST /api/sessions — create session
  if (pathname === "/api/sessions" && method === "POST") {
    let raw: unknown;
    try {
      const body = await readBody(req);
      raw = JSON.parse(body);
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        json(res, 400, { error: "invalid request body" });
        return;
      }
    } catch (err) {
      const msg = err instanceof Error && err.message === "request body too large"
        ? "request body too large"
        : "invalid request body";
      json(res, 400, { error: msg });
      return;
    }

    const result = CreateSessionRequestSchema.safeParse(raw);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      json(res, 400, { error: firstIssue.message });
      return;
    }
    const parsed = result.data;

    // Read persisted defaults; fill in any missing model/effort from the request body.
    // model: undefined means "Auto" — the SDK uses its own default (respects ~/.claude/settings.json).
    // effort: always has a value (defaults to "high" per Settings) — unlike model, there is no
    // "let the SDK decide" option for effort; the stored default is always applied.
    const savedSettings = await readSettings();
    const sessionRequest = {
      ...parsed,
      model: parsed.model ?? savedSettings.claudeModel ?? undefined,
      effort: parsed.effort ?? savedSettings.claudeEffort,
    };

    // Imperative checks that depend on runtime config (not expressible in a static schema)
    if (sessionRequest.effort === "max" && sessionRequest.model !== "claude-opus-4-6") {
      json(res, 400, { error: "effort 'max' is only available with the Opus model" });
      return;
    }
    if (parsed.permissionMode === "bypassPermissions" && !ALLOW_BYPASS_PERMISSIONS) {
      json(res, 403, { error: "bypassPermissions is disabled; set ALLOW_BYPASS_PERMISSIONS=1 to enable" });
      return;
    }
    if (parsed.cwd !== undefined && !isPathContained(BROWSE_ROOT, parsed.cwd)) {
      json(res, 400, { error: "cwd must be within the workspace" });
      return;
    }

    try {
      const sessionResult = await createSession(sessionRequest);
      json(res, 201, { id: sessionResult.id, status: sessionResult.status });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("maximum session limit")) {
        json(res, 409, { error: message });
      } else {
        console.error("Failed to create session:", err);
        json(res, 500, { error: "internal server error" });
      }
    }
    return;
  }

  // GET /api/sessions — list sessions (optionally filtered by CWD for history)
  if (pathname === "/api/sessions" && method === "GET") {
    const cwd = url.searchParams.get("cwd") ?? undefined;
    if (cwd !== undefined) {
      if (cwd.includes("\0")) {
        json(res, 400, { error: "invalid cwd" });
        return;
      }
      if (!isPathContained(BROWSE_ROOT, cwd)) {
        json(res, 400, { error: "cwd must be within the workspace" });
        return;
      }
    }
    try {
      const sessions = await listSessionsWithHistory(cwd);
      json(res, 200, sessions);
    } catch (err) {
      console.error("Failed to list sessions:", err);
      json(res, 500, { error: "internal server error" });
    }
    return;
  }

  // GET /api/sessions/:id/history — session message history from provider storage
  const historyMatch = pathname.match(SESSION_HISTORY_RE);
  if (historyMatch && method === "GET") {
    const sessionId = historyMatch[1];
    if (!UuidSchema.safeParse(sessionId).success) {
      json(res, 400, { error: "invalid session ID" });
      return;
    }
    const provider = url.searchParams.get("provider") ?? "claude";
    let adapter;
    try {
      adapter = getProvider(provider);
    } catch (err) {
      console.warn(`History endpoint: unknown provider "${provider}":`, err);
      json(res, 400, { error: "unknown provider" });
      return;
    }
    try {
      const messages = await adapter.getSessionHistory(sessionId);
      json(res, 200, messages);
    } catch (err) {
      if (err instanceof Error && err.name === "SessionNotFound") {
        json(res, 404, { error: "session history not found" });
        return;
      }
      console.error(`Failed to get session history for ${sessionId}:`, err);
      json(res, 500, { error: "internal server error" });
    }
    return;
  }

  // GET /api/sessions/:id/messages — paginated messages for scroll-up loading
  const messagesMatch = pathname.match(SESSION_MESSAGES_RE);
  if (messagesMatch && method === "GET") {
    const sessionId = messagesMatch[1];
    if (!UuidSchema.safeParse(sessionId).success) {
      json(res, 400, { error: "invalid session ID" });
      return;
    }
    const provider = url.searchParams.get("provider") ?? "claude";
    let adapter;
    try {
      adapter = getProvider(provider);
    } catch (err) {
      console.warn(`Messages endpoint: unknown provider "${provider}":`, err);
      json(res, 400, { error: "unknown provider" });
      return;
    }

    const beforeParam = url.searchParams.get("before");
    const limitParam = url.searchParams.get("limit");
    const before = beforeParam != null ? parseInt(beforeParam, 10) : undefined;
    if (before !== undefined && Number.isNaN(before)) {
      json(res, 400, { error: "before must be a number" });
      return;
    }
    const limit = limitParam != null ? parseInt(limitParam, 10) || 30 : undefined;

    try {
      const result = await adapter.getMessages(sessionId, { before, limit });
      json(res, 200, result);
    } catch (err) {
      if (err instanceof Error && err.name === "SessionNotFound") {
        json(res, 404, { error: "session not found" });
        return;
      }
      console.error(`Failed to get messages for ${sessionId}:`, err);
      json(res, 500, { error: "internal server error" });
    }
    return;
  }

  // GET /api/sessions/:id — session details (API sessions only)
  const idMatch = pathname.match(SESSION_ID_RE);
  if (idMatch && method === "GET") {
    const session = getActiveSession(idMatch[1]);
    if (!session) {
      json(res, 404, { error: "session not found" });
      return;
    }
    json(res, 200, {
      id: session.sessionId,
      status: session.status,
      cwd: session.cwd,
      lastError: session.lastError,
      pendingApproval: session.pendingApproval ? {
        toolName: session.pendingApproval.toolName,
        toolUseId: session.pendingApproval.toolUseId,
        input: session.pendingApproval.input,
      } : null,
      source: "api" as const,
    });
    return;
  }

  // DELETE /api/sessions/:id — delete session (interrupts if running, then removes)
  if (idMatch && method === "DELETE") {
    const found = deleteSession(idMatch[1]);
    if (!found) {
      json(res, 404, { error: "session not found" });
      return;
    }
    json(res, 200, { status: "deleted" });
    return;
  }

  // GET /api/config — server configuration for the UI
  if (pathname === "/api/config" && method === "GET") {
    const defaultCwd = process.env.DEFAULT_CWD ?? process.cwd();
    json(res, 200, { browseRoot: BROWSE_ROOT, defaultCwd, version: SERVER_VERSION, supportedModels: getCachedModels() });
    return;
  }

  // GET /api/providers — list registered providers
  if (pathname === "/api/providers" && method === "GET") {
    json(res, 200, listProviders());
    return;
  }

  // GET /api/git/status — git diff stat for a directory
  if (pathname === "/api/git/status" && method === "GET") {
    const cwd = url.searchParams.get("cwd");
    if (!cwd) {
      json(res, 400, { error: "cwd query parameter is required" });
      return;
    }
    if (cwd.includes("\0") || !isPathContained(BROWSE_ROOT, cwd)) {
      json(res, 400, { error: "cwd must be within the workspace" });
      return;
    }
    try {
      const stat = await computeGitDiffStat(cwd);
      if (!stat) {
        json(res, 404, { error: "not a git repository" });
        return;
      }
      json(res, 200, stat);
    } catch (err) {
      console.error("git status error:", err);
      json(res, 500, { error: "internal server error" });
    }
    return;
  }

  // GET /api/browse — list subdirectories for folder picker
  if (pathname === "/api/browse" && method === "GET") {
    const relPath = url.searchParams.get("path") ?? "";

    if (relPath.includes("\0") || !isPathContained(BROWSE_ROOT, relPath)) {
      json(res, 400, { error: "invalid path" });
      return;
    }

    const absPath = resolve(BROWSE_ROOT, relPath);

    try {
      const entries = await readdir(absPath, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
      json(res, 200, { path: relPath, dirs });
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        json(res, 404, { error: "directory not found" });
      } else if (code === "EACCES") {
        json(res, 403, { error: "permission denied" });
      } else {
        console.error("browse error:", err);
        json(res, 500, { error: "internal server error" });
      }
    }
    return;
  }

  // GET /api/rate-limits — cached subscription rate limit info
  if (pathname === "/api/rate-limits" && method === "GET") {
    const cached = getCachedRateLimits();
    if (!cached) {
      res.writeHead(204);
      res.end();
    } else {
      json(res, 200, cached);
    }
    return;
  }

  // GET /api/settings — read user settings
  if (pathname === "/api/settings" && method === "GET") {
    try {
      const settings = await readSettings();
      json(res, 200, settings);
    } catch (err) {
      console.error("Failed to read settings:", err);
      json(res, 500, { error: "internal server error" });
    }
    return;
  }

  // PATCH /api/settings — update user settings (partial)
  if (pathname === "/api/settings" && method === "PATCH") {
    let raw: unknown;
    try {
      const body = await readBody(req);
      raw = JSON.parse(body);
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        json(res, 400, { error: "invalid request body" });
        return;
      }
    } catch (err) {
      const msg = err instanceof Error && err.message === "request body too large"
        ? "request body too large"
        : "invalid request body";
      json(res, 400, { error: msg });
      return;
    }

    const result = PatchSettingsSchema.safeParse(raw);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      json(res, 400, { error: firstIssue.message });
      return;
    }

    try {
      const updated = await writeSettings(result.data);
      json(res, 200, updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("Invalid settings")) {
        json(res, 400, { error: message });
      } else {
        console.error("Failed to write settings:", err);
        json(res, 500, { error: "internal server error" });
      }
    }
    return;
  }

  // --- Webhooks ---

  // GET /api/webhooks
  if (WEBHOOK_RE.test(pathname) && method === "GET") {
    const registry = getWebhookRegistry();
    json(res, 200, await registry.list());
    return;
  }

  // POST /api/webhooks
  if (WEBHOOK_RE.test(pathname) && method === "POST") {
    let raw: unknown;
    try {
      const body = await readBody(req);
      raw = JSON.parse(body);
    } catch (err) {
      const msg = err instanceof Error && err.message === "request body too large"
        ? "request body too large"
        : "invalid request body";
      json(res, 400, { error: msg });
      return;
    }
    const parsed = CreateWebhookSchema.safeParse(raw);
    if (!parsed.success) {
      json(res, 400, { error: parsed.error.issues[0].message });
      return;
    }
    const registry = getWebhookRegistry();
    const webhook = await registry.create(parsed.data);
    json(res, 201, webhook);
    return;
  }

  // PATCH /api/webhooks/:id
  const webhookIdMatch = pathname.match(WEBHOOK_ID_RE);
  if (webhookIdMatch && method === "PATCH") {
    let raw: unknown;
    try {
      const body = await readBody(req);
      raw = JSON.parse(body);
    } catch (err) {
      const msg = err instanceof Error && err.message === "request body too large"
        ? "request body too large"
        : "invalid request body";
      json(res, 400, { error: msg });
      return;
    }
    const parsed = PatchWebhookSchema.safeParse(raw);
    if (!parsed.success) {
      json(res, 400, { error: parsed.error.issues[0].message });
      return;
    }
    const registry = getWebhookRegistry();
    try {
      const updated = await registry.update(webhookIdMatch[1], parsed.data);
      json(res, 200, updated);
    } catch {
      json(res, 404, { error: "webhook not found" });
    }
    return;
  }

  // DELETE /api/webhooks/:id
  if (webhookIdMatch && method === "DELETE") {
    const registry = getWebhookRegistry();
    try {
      await registry.remove(webhookIdMatch[1]);
      res.writeHead(204);
      res.end();
    } catch {
      json(res, 404, { error: "webhook not found" });
    }
    return;
  }

  // POST /api/webhooks/:id/test
  const webhookTestMatch = pathname.match(WEBHOOK_TEST_RE);
  if (webhookTestMatch && method === "POST") {
    const webhookId = webhookTestMatch[1];
    const exists = await getWebhookRegistry().getById(webhookId);
    if (!exists) {
      json(res, 404, { error: "webhook not found" });
      return;
    }
    try {
      await getWebhookDispatcher().sendTest(webhookId);
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 502, { error: (err as Error).message });
    }
    return;
  }

  // --- Claude Hooks ---

  // GET /api/claude-hooks/user
  if (CLAUDE_HOOKS_USER_RE.test(pathname) && method === "GET") {
    try {
      const hooks = await getClaudeHooksService().readHooks("user");
      json(res, 200, hooks);
    } catch (err) {
      console.error("Failed to read user hooks:", err);
      json(res, 500, { error: "internal server error" });
    }
    return;
  }

  // PUT /api/claude-hooks/user
  if (CLAUDE_HOOKS_USER_RE.test(pathname) && method === "PUT") {
    let raw: unknown;
    try {
      const body = await readBody(req);
      raw = JSON.parse(body);
    } catch (err) {
      const msg = err instanceof Error && err.message === "request body too large"
        ? "request body too large"
        : "invalid request body";
      json(res, 400, { error: msg });
      return;
    }
    const parsed = HookConfigSchema.safeParse(raw);
    if (!parsed.success) {
      json(res, 400, { error: parsed.error.issues[0].message });
      return;
    }
    try {
      await getClaudeHooksService().writeHooks("user", parsed.data);
      json(res, 200, parsed.data);
    } catch (err) {
      console.error("Failed to write user hooks:", err);
      json(res, 500, { error: "internal server error" });
    }
    return;
  }

  // GET /api/claude-hooks/workspace?path=X
  if (CLAUDE_HOOKS_WORKSPACE_RE.test(pathname) && method === "GET") {
    const path = url.searchParams.get("path");
    if (!path) {
      json(res, 400, { error: "path query parameter is required" });
      return;
    }
    if (!isPathContained(HOME_DIR, path)) {
      json(res, 403, { error: "path traversal denied" });
      return;
    }
    try {
      const hooks = await getClaudeHooksService().readHooks("workspace", path);
      json(res, 200, hooks);
    } catch (err) {
      console.error("Failed to read workspace hooks:", err);
      json(res, 500, { error: "internal server error" });
    }
    return;
  }

  // PUT /api/claude-hooks/workspace?path=X
  if (CLAUDE_HOOKS_WORKSPACE_RE.test(pathname) && method === "PUT") {
    const path = url.searchParams.get("path");
    if (!path) {
      json(res, 400, { error: "path query parameter is required" });
      return;
    }
    if (!isPathContained(HOME_DIR, path)) {
      json(res, 403, { error: "path traversal denied" });
      return;
    }
    let raw: unknown;
    try {
      const body = await readBody(req);
      raw = JSON.parse(body);
    } catch (err) {
      const msg = err instanceof Error && err.message === "request body too large"
        ? "request body too large"
        : "invalid request body";
      json(res, 400, { error: msg });
      return;
    }
    const parsed = HookConfigSchema.safeParse(raw);
    if (!parsed.success) {
      json(res, 400, { error: parsed.error.issues[0].message });
      return;
    }
    try {
      await getClaudeHooksService().writeHooks("workspace", parsed.data, path);
      json(res, 200, parsed.data);
    } catch (err) {
      console.error("Failed to write workspace hooks:", err);
      json(res, 500, { error: "internal server error" });
    }
    return;
  }

  // GET /api/workspaces
  if (WORKSPACES_RE.test(pathname) && method === "GET") {
    try {
      const workspaces = await getClaudeHooksService().listWorkspaces();
      json(res, 200, workspaces);
    } catch (err) {
      console.error("Failed to list workspaces:", err);
      json(res, 500, { error: "internal server error" });
    }
    return;
  }

  // 404 for unknown API paths
  if (pathname.startsWith("/api/")) {
    json(res, 404, { error: "not found" });
    return;
  }

  // Non-API paths fall through (handled by index.ts for static files)
  json(res, 404, { error: "not found" });
}
