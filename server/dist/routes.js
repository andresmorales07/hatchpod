import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { authenticateRequest, sendUnauthorized } from "./auth.js";
import { listSessions, getSession, sessionToDTO, getSessionCount, createSession, interruptSession, } from "./sessions.js";
const startTime = Date.now();
const SESSION_ID_RE = /^\/api\/sessions\/([0-9a-f-]{36})$/;
const BROWSE_ROOT = "/home/claude/workspace";
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
    // All /api/* routes require auth
    if (pathname.startsWith("/api/")) {
        if (!authenticateRequest(req)) {
            sendUnauthorized(res);
            return;
        }
    }
    // POST /api/sessions — create session
    if (pathname === "/api/sessions" && method === "POST") {
        let parsed;
        try {
            const body = await readBody(req);
            const raw = JSON.parse(body);
            if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
                json(res, 400, { error: "invalid request body" });
                return;
            }
            parsed = raw;
        }
        catch (err) {
            const msg = err instanceof Error && err.message === "request body too large"
                ? "request body too large"
                : "invalid request body";
            json(res, 400, { error: msg });
            return;
        }
        if (!parsed.prompt || typeof parsed.prompt !== "string") {
            json(res, 400, { error: "prompt is required" });
            return;
        }
        try {
            const session = await createSession(parsed);
            json(res, 201, {
                id: session.id,
                status: session.status,
                createdAt: session.createdAt.toISOString(),
            });
        }
        catch (err) {
            console.error("Failed to create session:", err);
            json(res, 500, { error: "internal server error" });
        }
        return;
    }
    // GET /api/sessions — list sessions
    if (pathname === "/api/sessions" && method === "GET") {
        json(res, 200, listSessions());
        return;
    }
    // GET /api/sessions/:id — session details
    const idMatch = pathname.match(SESSION_ID_RE);
    if (idMatch && method === "GET") {
        const session = getSession(idMatch[1]);
        if (!session) {
            json(res, 404, { error: "session not found" });
            return;
        }
        json(res, 200, sessionToDTO(session));
        return;
    }
    // DELETE /api/sessions/:id — interrupt session
    if (idMatch && method === "DELETE") {
        const found = interruptSession(idMatch[1]);
        if (!found) {
            json(res, 404, { error: "session not found" });
            return;
        }
        json(res, 200, { status: "interrupted" });
        return;
    }
    // GET /api/browse — list subdirectories for folder picker
    if (pathname === "/api/browse" && method === "GET") {
        const relPath = url.searchParams.get("path") ?? "";
        if (relPath.includes("\0")) {
            json(res, 400, { error: "invalid path" });
            return;
        }
        const absPath = resolve(BROWSE_ROOT, relPath);
        if (absPath !== BROWSE_ROOT && !absPath.startsWith(BROWSE_ROOT + "/")) {
            json(res, 400, { error: "invalid path" });
            return;
        }
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
