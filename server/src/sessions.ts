import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Query, SDKMessage, SDKResultMessage, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { Session, PendingApproval, CreateSessionRequest, ServerMessage } from "./types.js";
import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";

const sessions = new Map<string, Session>();

export function listSessions(): Array<{
  id: string;
  status: Session["status"];
  createdAt: string;
  numTurns: number;
  totalCostUsd: number;
  hasPendingApproval: boolean;
}> {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    status: s.status,
    createdAt: s.createdAt.toISOString(),
    numTurns: s.numTurns,
    totalCostUsd: s.totalCostUsd,
    hasPendingApproval: s.pendingApproval !== null,
  }));
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function getSessionCount(): { active: number; total: number } {
  let active = 0;
  for (const s of sessions.values()) {
    if (
      s.status === "running" ||
      s.status === "starting" ||
      s.status === "waiting_for_approval"
    ) {
      active++;
    }
  }
  return { active, total: sessions.size };
}

export function broadcast(session: Session, msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const client of session.clients) {
    try {
      if (client.readyState === 1) {
        client.send(data);
      }
    } catch {
      session.clients.delete(client);
    }
  }
}

export async function createSession(
  req: CreateSessionRequest,
): Promise<Session> {
  const id = randomUUID();
  const session: Session = {
    id,
    status: "starting",
    createdAt: new Date(),
    permissionMode: req.permissionMode ?? "default",
    model: req.model,
    cwd: req.cwd ?? "/home/claude/workspace",
    abortController: new AbortController(),
    messages: [],
    totalCostUsd: 0,
    numTurns: 0,
    lastError: null,
    pendingApproval: null,
    clients: new Set<WebSocket>(),
  };
  sessions.set(id, session);
  // Fire and forget -- the async generator runs in the background
  runSession(session, req.prompt, req.allowedTools);
  return session;
}

async function runSession(
  session: Session,
  prompt: string,
  allowedTools?: string[],
  resumeSessionId?: string,
): Promise<void> {
  let queryHandle: Query | undefined;
  try {
    session.status = "running";
    broadcast(session, { type: "status", status: "running" });

    queryHandle = sdkQuery({
      prompt,
      options: {
        abortController: session.abortController,
        maxTurns: 50,
        cwd: session.cwd,
        permissionMode: session.permissionMode,
        ...(session.permissionMode === "bypassPermissions"
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        ...(session.model ? { model: session.model } : {}),
        ...(allowedTools?.length ? { allowedTools } : {}),
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        includePartialMessages: true,
        canUseTool:
          session.permissionMode === "bypassPermissions"
            ? undefined
            : async (
                toolName: string,
                _input: Record<string, unknown>,
                options: { toolUseID: string },
              ): Promise<PermissionResult> => {
                return new Promise((resolve) => {
                  session.pendingApproval = {
                    toolName,
                    toolUseId: options.toolUseID,
                    input: _input,
                    resolve,
                  };
                  session.status = "waiting_for_approval";
                  broadcast(session, {
                    type: "status",
                    status: "waiting_for_approval",
                  });
                  broadcast(session, {
                    type: "tool_approval_request",
                    toolName,
                    toolUseId: options.toolUseID,
                    input: _input,
                  });
                });
              },
      },
    });

    for await (const message of queryHandle) {
      session.messages.push(message);
      broadcast(session, { type: "sdk_message", message });

      // Extract cost and turn info from result messages
      if (isResultMessage(message)) {
        session.totalCostUsd = message.total_cost_usd;
        session.numTurns = message.num_turns;
        // Capture the SDK session ID for resume support (stored separately
        // so the Map key — session.id — remains the original UUID)
        if (message.session_id) {
          session.sdkSessionId = message.session_id;
        }
      }
    }

    // Status may have been mutated externally by interruptSession()
    const currentStatus = session.status as Session["status"];
    if (currentStatus !== "interrupted") {
      session.status = "completed";
    }
  } catch (err) {
    const currentStatus = session.status as Session["status"];
    if (currentStatus !== "interrupted") {
      session.status = "error";
      session.lastError = String(err);
      console.error(`Session ${session.id} error:`, err);
    }
  }
  broadcast(session, {
    type: "status",
    status: session.status,
    ...(session.lastError ? { error: session.lastError } : {}),
  });
}

function isResultMessage(msg: SDKMessage): msg is SDKResultMessage {
  return msg.type === "result";
}

export function interruptSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  session.status = "interrupted";
  session.abortController.abort();
  broadcast(session, { type: "status", status: "interrupted" });
  return true;
}

export function handleApproval(
  session: Session,
  toolUseId: string,
  allow: boolean,
  message?: string,
): boolean {
  if (
    !session.pendingApproval ||
    session.pendingApproval.toolUseId !== toolUseId
  )
    return false;

  const approval = session.pendingApproval;
  session.pendingApproval = null;
  session.status = "running";
  broadcast(session, { type: "status", status: "running" });

  if (allow) {
    approval.resolve({ behavior: "allow" });
  } else {
    approval.resolve({ behavior: "deny", message: message ?? "Denied by user" });
  }
  return true;
}

export async function sendFollowUp(
  session: Session,
  text: string,
): Promise<boolean> {
  if (session.status === "running" || session.status === "starting") {
    return false;
  }
  session.abortController = new AbortController();
  runSession(session, text, undefined, session.sdkSessionId ?? session.id);
  return true;
}
