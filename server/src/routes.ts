import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticateRequest, sendUnauthorized } from "./auth.js";
import {
  listSessions,
  getSession,
  getSessionCount,
  createSession,
  interruptSession,
} from "./sessions.js";
import type { CreateSessionRequest } from "./types.js";

const startTime = Date.now();

const SESSION_ID_RE = /^\/api\/sessions\/([0-9a-f-]{36})$/;

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...corsHeaders(),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
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

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

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
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body) as CreateSessionRequest;
      if (!parsed.prompt || typeof parsed.prompt !== "string") {
        json(res, 400, { error: "prompt is required" });
        return;
      }
      const session = await createSession(parsed);
      json(res, 201, {
        id: session.id,
        status: session.status,
        createdAt: session.createdAt.toISOString(),
      });
    } catch (err) {
      json(res, 400, { error: "invalid request body" });
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
    json(res, 200, {
      id: session.id,
      status: session.status,
      createdAt: session.createdAt.toISOString(),
      permissionMode: session.permissionMode,
      model: session.model,
      cwd: session.cwd,
      numTurns: session.numTurns,
      totalCostUsd: session.totalCostUsd,
      lastError: session.lastError,
      messages: session.messages,
      pendingApproval: session.pendingApproval
        ? {
            toolName: session.pendingApproval.toolName,
            toolUseId: session.pendingApproval.toolUseId,
            input: session.pendingApproval.input,
          }
        : null,
    });
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

  // 404 for unknown API paths
  if (pathname.startsWith("/api/")) {
    json(res, 404, { error: "not found" });
    return;
  }

  // Non-API paths fall through (handled by index.ts for static files)
  json(res, 404, { error: "not found" });
}
