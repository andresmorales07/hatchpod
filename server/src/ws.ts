import type { WebSocket } from "ws";
import { authenticateToken } from "./auth.js";

import { getActiveSession, handleApproval, sendFollowUp, interruptSession, getWatcher, createSession } from "./sessions.js";
import type { ClientMessage, ServerMessage } from "./types.js";
import type { PermissionModeCommon } from "./providers/types.js";
import { PermissionModeCommonSchema } from "./schemas/providers.js";
import { getCachedModels } from "./providers/claude-adapter.js";

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

  // Subscribe to watcher for message replay + live streaming.
  // The watcher replays from in-memory messages[] (push-mode sessions)
  // or from JSONL files (CLI/history sessions).
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
    const { toolName, toolUseId, input, targetMode } = activeSession.pendingApproval;
    ws.send(JSON.stringify({
      type: "tool_approval_request",
      toolName,
      toolUseId,
      input,
      ...(targetMode ? { targetMode } : {}),
    } satisfies ServerMessage));
  }

  // Send current model to late-joining/reconnecting WS clients.
  // For new sessions, the model arrives asynchronously via onModelResolved.
  if (activeSession?.model) {
    ws.send(JSON.stringify({ type: "model_changed", model: activeSession.model } satisfies ServerMessage));
  }

  // Heartbeat: protocol-level ping detects dead clients, JSON ping keeps client watchdog alive.
  // The `ws` library auto-replies with pong when it receives a protocol ping from the browser,
  // and the browser auto-replies with pong when it receives our protocol ping.
  let isAlive = true;
  ws.on("pong", () => { isAlive = true; });

  const pingInterval = setInterval(() => {
    if (!isAlive) {
      // No pong received since last ping — connection is dead
      ws.terminate();
      return;
    }
    isAlive = false;
    if (ws.readyState === 1) {
      ws.ping();  // Protocol-level ping (browser auto-replies with pong)
      ws.send(JSON.stringify({ type: "ping" } satisfies ServerMessage));  // Application-level for client watchdog
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
        const clearContext = parsed.clearContext === true;
        const rawTargetMode = parsed.targetMode;
        const targetMode: PermissionModeCommon | undefined =
          rawTargetMode !== undefined && (PermissionModeCommonSchema.options as readonly string[]).includes(rawTargetMode)
            ? rawTargetMode as PermissionModeCommon
            : undefined;
        const approvalResult = handleApproval(session, parsed.toolUseId, true, {
          alwaysAllow,
          answers,
          targetMode,
          clearContext,
        });
        if (!approvalResult) {
          ws.send(JSON.stringify({ type: "error", message: "no matching pending approval" } satisfies ServerMessage));
        } else if (typeof approvalResult === "object" && approvalResult.clearContext) {
          try {
            const newSession = await createSession({ cwd: approvalResult.cwd, permissionMode: approvalResult.newMode });
            watcher.pushEvent(session.sessionId, { type: "session_redirected", newSessionId: newSession.id, fresh: true });
            // Deny (not allow) was resolved in handleApproval so the SDK can write the
            // denial to the subprocess stdin via its normal permission stream path.
            // setImmediate defers the interrupt to the Node.js "check" phase, which runs
            // after the current I/O (poll) phase where that stdin write completes. By the
            // time SIGTERM fires, the subprocess has already received the denial and exited
            // the permission-wait state — no "Tool permission stream closed" error.
            const oldSessionId = session.sessionId;
            setImmediate(() => interruptSession(oldSessionId));
          } catch (err) {
            console.error(`Failed to create session for clearContext redirect:`, err);
            ws.send(JSON.stringify({ type: "error", message: "failed to create new session for context clear" } satisfies ServerMessage));
          }
        }
        break;
      }

      case "deny":
        if (!handleApproval(session, parsed.toolUseId, false, { message: parsed.message })) {
          ws.send(JSON.stringify({ type: "error", message: "no matching pending approval" } satisfies ServerMessage));
        }
        break;

      case "set_mode": {
        if (!(PermissionModeCommonSchema.options as readonly string[]).includes(parsed.mode)) {
          // ignore invalid mode
          break;
        }
        if (session.status !== "idle" && session.status !== "completed" && session.status !== "interrupted") {
          ws.send(JSON.stringify({ type: "error", message: "cannot change mode while session is running" } satisfies ServerMessage));
          break;
        }
        if (parsed.mode === "bypassPermissions" && process.env.ALLOW_BYPASS_PERMISSIONS !== "1") {
          ws.send(JSON.stringify({ type: "error", message: "bypassPermissions mode is disabled on this server" } satisfies ServerMessage));
          break;
        }
        session.currentPermissionMode = parsed.mode as PermissionModeCommon;
        watcher.pushEvent(session.sessionId, { type: "mode_changed", mode: parsed.mode as PermissionModeCommon });
        break;
      }

      case "set_model": {
        const model = parsed.model;
        if (typeof model !== "string" || model.length === 0) {
          ws.send(JSON.stringify({ type: "error", message: "model must be a non-empty string" } satisfies ServerMessage));
          break;
        }
        const models = getCachedModels();
        if (models && !models.some((m) => m.id === model)) {
          ws.send(JSON.stringify({ type: "error", message: `unsupported model: ${model}` } satisfies ServerMessage));
          break;
        }
        if (session.queryHandle?.setModel) {
          // Live SDK process — defer broadcast until SDK confirms
          const previousModel = session.model;
          session.model = model;
          session.queryHandle.setModel(model).then(
            () => {
              watcher.pushEvent(session.sessionId, { type: "model_changed", model });
            },
            (err) => {
              console.error(`setModel failed for session ${session.sessionId}:`, err);
              session.model = previousModel;
              ws.send(JSON.stringify({ type: "error", message: `Failed to switch model: ${err instanceof Error ? err.message : String(err)}` } satisfies ServerMessage));
              if (previousModel) {
                watcher.pushEvent(session.sessionId, { type: "model_changed", model: previousModel });
              }
            },
          );
        } else {
          // No live query — store for next run and broadcast immediately
          session.model = model;
          watcher.pushEvent(session.sessionId, { type: "model_changed", model });
        }
        break;
      }

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
