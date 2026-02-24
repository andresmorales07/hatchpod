import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { authenticateRequest, sendUnauthorized, sendRateLimited } from "./auth.js";
import { listSessionsWithHistory, getActiveSession, getSessionCount, createSession, deleteSession, } from "./sessions.js";
import { listProviders, getProvider } from "./providers/index.js";
import { CreateSessionRequestSchema, UuidSchema, isPathContained, openApiDocument } from "./schemas/index.js";
const startTime = Date.now();
const SESSION_ID_RE = /^\/api\/sessions\/([0-9a-f-]{36})$/;
const SESSION_HISTORY_RE = /^\/api\/sessions\/([0-9a-f-]{36})\/history$/;
const SESSION_MESSAGES_RE = /^\/api\/sessions\/([0-9a-f-]{36})\/messages$/;
const BROWSE_ROOT = process.env.BROWSE_ROOT ?? process.cwd();
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
function json(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(payload);
}
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalBytes = 0;
        req.on("data", (chunk) => {
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
export async function handleRequest(req, res) {
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
        res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
            "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
            "img-src 'self' data: https://cdn.jsdelivr.net; " +
            "font-src 'self' https://cdn.jsdelivr.net; " +
            "connect-src 'self'; frame-ancestors 'none'");
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
        let raw;
        try {
            const body = await readBody(req);
            raw = JSON.parse(body);
            if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
                json(res, 400, { error: "invalid request body" });
                return;
            }
        }
        catch (err) {
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
        // Imperative checks that depend on runtime config (not expressible in a static schema)
        if (parsed.permissionMode === "bypassPermissions" && !ALLOW_BYPASS_PERMISSIONS) {
            json(res, 403, { error: "bypassPermissions is disabled; set ALLOW_BYPASS_PERMISSIONS=1 to enable" });
            return;
        }
        if (parsed.cwd !== undefined && !isPathContained(BROWSE_ROOT, parsed.cwd)) {
            json(res, 400, { error: "cwd must be within the workspace" });
            return;
        }
        try {
            const sessionResult = await createSession(parsed);
            json(res, 201, { id: sessionResult.id, status: sessionResult.status });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes("maximum session limit")) {
                json(res, 409, { error: message });
            }
            else {
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
        }
        catch (err) {
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
        }
        catch (err) {
            console.warn(`History endpoint: unknown provider "${provider}":`, err);
            json(res, 400, { error: "unknown provider" });
            return;
        }
        try {
            const messages = await adapter.getSessionHistory(sessionId);
            json(res, 200, messages);
        }
        catch (err) {
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
        }
        catch (err) {
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
        }
        catch (err) {
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
            source: "api",
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
        json(res, 200, { browseRoot: BROWSE_ROOT, defaultCwd });
        return;
    }
    // GET /api/providers — list registered providers
    if (pathname === "/api/providers" && method === "GET") {
        json(res, 200, listProviders());
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
        }
        catch (err) {
            const code = err.code;
            if (code === "ENOENT" || code === "ENOTDIR") {
                json(res, 404, { error: "directory not found" });
            }
            else if (code === "EACCES") {
                json(res, 403, { error: "permission denied" });
            }
            else {
                console.error("browse error:", err);
                json(res, 500, { error: "internal server error" });
            }
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
