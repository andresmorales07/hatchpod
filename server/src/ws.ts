import type { WebSocket } from "ws";
import { authenticateToken } from "./auth.js";

import { getActiveSession, handleApproval, sendFollowUp, interruptSession, getWatcher } from "./sessions.js";
import type { ClientMessage, ServerMessage } from "./types.js";

const WS_PATH_RE = /^\/api\/sessions\/([0-9a-f-]{36})\/stream$/;

const AUTH_TIMEOUT_MS = 10_000;

export function extractSessionIdFromPath(pathname: string): string | null {
  const match = pathname.match(WS_PATH_RE);
  return match ? match[1] : null;
}

export function handleWsConnection(ws: WebSocket, sessionId: string, ip: string): void {
  // First message must be { type: "auth", token: "..." }
  // This avoids leaking the token in the URL / query string.
  const authTimeout = setTimeout(() => {
    const msg: ServerMessage = { type: "error", message: "auth timeout" };
    ws.send(JSON.stringify(msg));
    ws.close(4001, "auth timeout");
  }, AUTH_TIMEOUT_MS);

  ws.once("message", (data: Buffer | string) => {
    clearTimeout(authTimeout);

    let parsed: { type: string; token?: string; messageLimit?: number };
    try {
      parsed = JSON.parse(typeof data === "string" ? data : data.toString());
    } catch (err) {
      console.error("WebSocket auth: failed to parse JSON:", err);
      const msg: ServerMessage = { type: "error", message: "invalid JSON" };
      ws.send(JSON.stringify(msg));
      ws.close(4002, "invalid JSON");
      return;
    }

    if (parsed.type !== "auth" || !parsed.token) {
      const msg: ServerMessage = { type: "error", message: "unauthorized" };
      ws.send(JSON.stringify(msg));
      ws.close(4001, "unauthorized");
      return;
    }

    const authResult = authenticateToken(parsed.token, ip);
    if (authResult !== true) {
      const message = authResult === "rate_limited" ? "too many failed attempts" : "unauthorized";
      const msg: ServerMessage = { type: "error", message };
      ws.send(JSON.stringify(msg));
      ws.close(4001, message);
      return;
    }

    // Auth succeeded — set up the session connection
    const messageLimit = typeof parsed.messageLimit === "number" && parsed.messageLimit > 0
      ? parsed.messageLimit
      : undefined;
    setupSessionConnection(ws, sessionId, messageLimit);
  });

  // Clean up auth timeout on early close
  ws.on("close", () => clearTimeout(authTimeout));
  ws.on("error", () => clearTimeout(authTimeout));
}

function setupSessionConnection(ws: WebSocket, sessionId: string, messageLimit?: number): void {
  const watcher = getWatcher();
  const activeSession = getActiveSession(sessionId);

  // For new API sessions, the SDK doesn't yield the initial user prompt as a
  // message, and the JSONL file isn't findable yet (temp UUID). Send the stored
  // prompt as a synthetic user message so the UI shows it immediately.
  if (activeSession?.initialPrompt) {
    const promptMsg: ServerMessage = {
      type: "message",
      message: { role: "user", parts: [{ type: "text", text: activeSession.initialPrompt }], index: 0 },
    };
    ws.send(JSON.stringify(promptMsg));
    // Clear so subsequent WS connections (reconnects) get it from the JSONL replay instead
    activeSession.initialPrompt = null;
  }

  // Subscribe to watcher for message replay + live streaming.
  // This works for BOTH API sessions and CLI sessions.
  watcher.subscribe(sessionId, ws, messageLimit).catch((err) => {
    console.error(`SessionWatcher subscribe failed for ${sessionId}:`, err);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "error", message: "failed to load message history" } satisfies ServerMessage));
      ws.send(JSON.stringify({ type: "replay_complete", totalMessages: 0, oldestIndex: 0 } satisfies ServerMessage));
    }
  });

  // Send source and status info
  const source: "api" | "cli" = activeSession ? "api" : "cli";
  const status = activeSession?.status ?? "history";
  ws.send(JSON.stringify({
    type: "status",
    status,
    source,
    ...(activeSession?.lastError ? { error: activeSession.lastError } : {}),
  } satisfies ServerMessage));

  // Send pending approval for API sessions
  if (activeSession?.pendingApproval) {
    ws.send(JSON.stringify({
      type: "tool_approval_request",
      toolName: activeSession.pendingApproval.toolName,
      toolUseId: activeSession.pendingApproval.toolUseId,
      input: activeSession.pendingApproval.input,
    } satisfies ServerMessage));
  }

  // Ping keepalive every 30s
  const pingInterval = setInterval(() => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "ping" } satisfies ServerMessage));
    }
  }, 30_000);

  // Handle incoming messages
  ws.on("message", async (data: Buffer | string) => {
    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(typeof data === "string" ? data : data.toString()) as ClientMessage;
    } catch (err) {
      console.error(`WebSocket session ${sessionId}: failed to parse JSON:`, err);
      ws.send(JSON.stringify({ type: "error", message: "invalid JSON" } satisfies ServerMessage));
      return;
    }

    // All actions require an active API session
    const session = getActiveSession(sessionId);
    if (!session) {
      ws.send(JSON.stringify({ type: "error", message: "no active session (CLI sessions are read-only)" } satisfies ServerMessage));
      return;
    }

    switch (parsed.type) {
      case "prompt": {
        const accepted = await sendFollowUp(session, parsed.text);
        if (!accepted) {
          ws.send(JSON.stringify({ type: "error", message: "session is busy" } satisfies ServerMessage));
        }
        break;
      }

      case "approve": {
        let answers: Record<string, string> | undefined = parsed.answers;
        if (answers !== undefined) {
          if (typeof answers !== "object" || answers === null || Array.isArray(answers) ||
              !Object.values(answers).every((v) => typeof v === "string")) {
            answers = undefined;
          }
        }
        const alwaysAllow = parsed.alwaysAllow === true;
        if (!handleApproval(session, parsed.toolUseId, true, undefined, answers, alwaysAllow)) {
          ws.send(JSON.stringify({ type: "error", message: "no matching pending approval" } satisfies ServerMessage));
        }
        break;
      }

      case "deny":
        if (!handleApproval(session, parsed.toolUseId, false, parsed.message)) {
          ws.send(JSON.stringify({ type: "error", message: "no matching pending approval" } satisfies ServerMessage));
        }
        break;

      case "interrupt":
        interruptSession(session.sessionId);
        break;

      default: {
        ws.send(JSON.stringify({ type: "error", message: "unknown message type" } satisfies ServerMessage));
      }
    }
  });

  // Cleanup on close
  ws.on("close", () => {
    clearInterval(pingInterval);
    watcher.unsubscribe(sessionId, ws);
  });

  ws.on("error", (err) => {
    console.error(`WebSocket error for session ${sessionId}:`, err.message);
    clearInterval(pingInterval);
    watcher.unsubscribe(sessionId, ws);
  });
}
