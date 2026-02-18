import type { WebSocket } from "ws";
import { getSession, broadcast, handleApproval, sendFollowUp, interruptSession } from "./sessions.js";
import type { ClientMessage, ServerMessage } from "./types.js";

const WS_PATH_RE = /^\/api\/sessions\/([0-9a-f-]{36})\/stream$/;

export function extractSessionIdFromPath(pathname: string): string | null {
  const match = pathname.match(WS_PATH_RE);
  return match ? match[1] : null;
}

export function handleWsConnection(ws: WebSocket, sessionId: string): void {
  const session = getSession(sessionId);
  if (!session) {
    const msg: ServerMessage = { type: "error", message: "session not found" };
    ws.send(JSON.stringify(msg));
    ws.close(4004, "session not found");
    return;
  }

  // Add client to session
  session.clients.add(ws);

  // Replay buffered messages
  for (const message of session.messages) {
    const msg = { type: "sdk_message", message } satisfies ServerMessage;
    ws.send(JSON.stringify(msg));
  }

  // Signal replay complete
  const replayDone = { type: "replay_complete" } satisfies ServerMessage;
  ws.send(JSON.stringify(replayDone));

  // Send current status
  const statusMsg = {
    type: "status",
    status: session.status,
    ...(session.lastError ? { error: session.lastError } : {}),
  } satisfies ServerMessage;
  ws.send(JSON.stringify(statusMsg));

  // Send pending approval if any
  if (session.pendingApproval) {
    const approvalMsg = {
      type: "tool_approval_request",
      toolName: session.pendingApproval.toolName,
      toolUseId: session.pendingApproval.toolUseId,
      input: session.pendingApproval.input,
    } satisfies ServerMessage;
    ws.send(JSON.stringify(approvalMsg));
  }

  // Ping keepalive every 30s
  const pingInterval = setInterval(() => {
    if (ws.readyState === 1) {
      const ping = { type: "ping" } satisfies ServerMessage;
      ws.send(JSON.stringify(ping));
    }
  }, 30_000);

  // Handle incoming messages
  ws.on("message", (data: Buffer | string) => {
    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(typeof data === "string" ? data : data.toString()) as ClientMessage;
    } catch {
      const errMsg = { type: "error", message: "invalid JSON" } satisfies ServerMessage;
      ws.send(JSON.stringify(errMsg));
      return;
    }

    switch (parsed.type) {
      case "prompt":
        sendFollowUp(session, parsed.text);
        break;

      case "approve":
        handleApproval(session, parsed.toolUseId, true);
        break;

      case "deny":
        handleApproval(session, parsed.toolUseId, false, parsed.message);
        break;

      case "interrupt":
        interruptSession(session.id);
        break;

      default: {
        const errMsg = { type: "error", message: "unknown message type" } satisfies ServerMessage;
        ws.send(JSON.stringify(errMsg));
      }
    }
  });

  // Cleanup on close
  ws.on("close", () => {
    clearInterval(pingInterval);
    session.clients.delete(ws);
  });

  ws.on("error", (err) => {
    console.error(`WebSocket error for session ${sessionId}:`, err.message);
    clearInterval(pingInterval);
    session.clients.delete(ws);
  });
}
