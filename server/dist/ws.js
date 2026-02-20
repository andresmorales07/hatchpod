import { authenticateToken } from "./auth.js";
import { getSession, handleApproval, sendFollowUp, interruptSession } from "./sessions.js";
const WS_PATH_RE = /^\/api\/sessions\/([0-9a-f-]{36})\/stream$/;
const AUTH_TIMEOUT_MS = 10_000;
export function extractSessionIdFromPath(pathname) {
    const match = pathname.match(WS_PATH_RE);
    return match ? match[1] : null;
}
export function handleWsConnection(ws, sessionId, ip) {
    // First message must be { type: "auth", token: "..." }
    // This avoids leaking the token in the URL / query string.
    const authTimeout = setTimeout(() => {
        const msg = { type: "error", message: "auth timeout" };
        ws.send(JSON.stringify(msg));
        ws.close(4001, "auth timeout");
    }, AUTH_TIMEOUT_MS);
    ws.once("message", (data) => {
        clearTimeout(authTimeout);
        let parsed;
        try {
            parsed = JSON.parse(typeof data === "string" ? data : data.toString());
        }
        catch {
            const msg = { type: "error", message: "invalid JSON" };
            ws.send(JSON.stringify(msg));
            ws.close(4002, "invalid JSON");
            return;
        }
        if (parsed.type !== "auth" || !parsed.token) {
            const msg = { type: "error", message: "unauthorized" };
            ws.send(JSON.stringify(msg));
            ws.close(4001, "unauthorized");
            return;
        }
        const authResult = authenticateToken(parsed.token, ip);
        if (authResult !== true) {
            const message = authResult === "rate_limited" ? "too many failed attempts" : "unauthorized";
            const msg = { type: "error", message };
            ws.send(JSON.stringify(msg));
            ws.close(4001, message);
            return;
        }
        // Auth succeeded — set up the session connection
        setupSessionConnection(ws, sessionId);
    });
    // Clean up auth timeout on early close
    ws.on("close", () => clearTimeout(authTimeout));
    ws.on("error", () => clearTimeout(authTimeout));
}
function setupSessionConnection(ws, sessionId) {
    const session = getSession(sessionId);
    if (!session) {
        const msg = { type: "error", message: "session not found" };
        ws.send(JSON.stringify(msg));
        ws.close(4004, "session not found");
        return;
    }
    // Add client to session
    session.clients.add(ws);
    // Replay buffered messages
    for (const message of session.messages) {
        const msg = { type: "message", message };
        ws.send(JSON.stringify(msg));
    }
    // Replay slash commands if available
    if (session.slashCommands.length > 0) {
        const cmdMsg = { type: "slash_commands", commands: session.slashCommands };
        ws.send(JSON.stringify(cmdMsg));
    }
    // Signal replay complete
    const replayDone = { type: "replay_complete" };
    ws.send(JSON.stringify(replayDone));
    // Send current status
    const statusMsg = {
        type: "status",
        status: session.status,
        ...(session.lastError ? { error: session.lastError } : {}),
    };
    ws.send(JSON.stringify(statusMsg));
    // Send pending approval if any
    if (session.pendingApproval) {
        const approvalMsg = {
            type: "tool_approval_request",
            toolName: session.pendingApproval.toolName,
            toolUseId: session.pendingApproval.toolUseId,
            input: session.pendingApproval.input,
        };
        ws.send(JSON.stringify(approvalMsg));
    }
    // Ping keepalive every 30s
    const pingInterval = setInterval(() => {
        if (ws.readyState === 1) {
            const ping = { type: "ping" };
            ws.send(JSON.stringify(ping));
        }
    }, 30_000);
    // Handle incoming messages
    ws.on("message", (data) => {
        let parsed;
        try {
            parsed = JSON.parse(typeof data === "string" ? data : data.toString());
        }
        catch {
            const errMsg = { type: "error", message: "invalid JSON" };
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
                const errMsg = { type: "error", message: "unknown message type" };
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
