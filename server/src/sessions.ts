import { getProvider } from "./providers/index.js";
import type { ProviderAdapter, NormalizedMessage, ProviderSessionResult, PermissionModeCommon } from "./providers/types.js";
import type { ActiveSession, CreateSessionRequest, SessionSummaryDTO, ServerMessage } from "./types.js";
import { SessionWatcher } from "./session-watcher.js";
import { computeGitDiffStat } from "./git-status.js";
import { randomUUID } from "node:crypto";

// ── ActiveSession map (runtime handles for API-driven sessions) ──

const sessions = new Map<string, ActiveSession>();

// Maps old (temp) session IDs to their remapped (provider) session IDs.
// Allows WebSocket handlers that captured the old ID to still find the session.
const sessionAliases = new Map<string, string>();

const MAX_SESSIONS = 50;
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Evict completed/errored/interrupted sessions older than TTL
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (
      (s.status === "completed" || s.status === "error" || s.status === "interrupted") &&
      now - s.createdAt.getTime() > SESSION_TTL_MS
    ) {
      sessions.delete(id);
      // Also clean up watcher entries to prevent unbounded memory growth
      watcher?.forceRemove(id);
    }
  }
  // Clean up stale aliases whose targets no longer exist
  for (const [alias, target] of sessionAliases) {
    if (!sessions.has(target)) sessionAliases.delete(alias);
  }
}, CLEANUP_INTERVAL_MS).unref();

// ── SessionWatcher singleton ──

let watcher: SessionWatcher | null = null;

/**
 * Initialize the SessionWatcher singleton. Call once at server startup.
 * The adapter is used to resolve JSONL file paths and normalize lines.
 */
export function initWatcher(adapter: ProviderAdapter): SessionWatcher {
  if (watcher) return watcher;
  watcher = new SessionWatcher(adapter);
  watcher.start();
  return watcher;
}

/**
 * Return the SessionWatcher singleton.
 * Throws if initWatcher() hasn't been called yet.
 */
export function getWatcher(): SessionWatcher {
  if (!watcher) throw new Error("SessionWatcher not initialized — call initWatcher() first");
  return watcher;
}

// ── Session listing ──

export function listSessions(): SessionSummaryDTO[] {
  return Array.from(sessions.values()).map((s) => ({
    id: s.sessionId,
    status: s.status,
    createdAt: s.createdAt.toISOString(),
    lastModified: s.createdAt.toISOString(),
    numTurns: 0,
    totalCostUsd: 0,
    hasPendingApproval: s.pendingApproval !== null,
    provider: s.provider,
    slug: null,
    summary: null,
    cwd: s.cwd,
    permissionMode: s.currentPermissionMode,
  }));
}

export async function listSessionsWithHistory(cwd?: string): Promise<SessionSummaryDTO[]> {
  const liveSessions = listSessions();

  let history: import("./providers/types.js").SessionListItem[];
  try {
    const adapter = getProvider("claude");
    history = await adapter.listSessions(cwd);
  } catch (err) {
    console.warn("Failed to list session history:", err);
    return liveSessions;
  }

  // Build set of provider session IDs that are already live
  const liveProviderIds = new Set<string>();
  for (const s of sessions.values()) {
    if (s.sessionId) liveProviderIds.add(s.sessionId);
  }

  // Enrich live sessions with slug/summary/cwd from history
  for (const live of liveSessions) {
    const histMatch = history.find((h) => h.id === live.id);
    if (histMatch) {
      live.slug = histMatch.slug;
      live.summary = histMatch.summary;
      live.lastModified = histMatch.lastModified;
      live.cwd = histMatch.cwd;
    }
  }

  // Add history-only sessions (not already live, dedup across project dirs)
  const seenIds = new Set(liveProviderIds);
  for (const h of history) {
    if (seenIds.has(h.id)) continue;
    seenIds.add(h.id);
    liveSessions.push({
      id: h.id,
      status: "history",
      createdAt: h.createdAt,
      lastModified: h.lastModified,
      numTurns: 0,
      totalCostUsd: 0,
      hasPendingApproval: false,
      provider: "claude",
      slug: h.slug,
      summary: h.summary,
      cwd: h.cwd,
      // History sessions were created outside the API; their original permission mode is not
      // stored in the JSONL file. Default to "default" as a conservative fallback.
      permissionMode: "default",
    });
  }

  // Sort by lastModified descending
  liveSessions.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());

  return liveSessions;
}

// ── Session CRUD ──

export function getActiveSession(id: string): ActiveSession | undefined {
  return sessions.get(id) ?? sessions.get(sessionAliases.get(id) ?? "");
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

export async function createSession(
  req: CreateSessionRequest,
): Promise<{ id: string; status: ActiveSession["status"] }> {
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error(`maximum session limit reached (${MAX_SESSIONS})`);
  }

  const hasPrompt = typeof req.prompt === "string" && req.prompt.length > 0;

  // For resumed sessions, use the provided session ID as our key so
  // the watcher can subscribe using the same ID.
  // For new sessions, the SDK will create a CLI session ID that we
  // capture from the result — until then we use a temp UUID.
  const id = req.resumeSessionId ?? randomUUID();

  const session: ActiveSession = {
    sessionId: id,
    provider: req.provider ?? "claude",
    cwd: req.cwd ?? (process.env.DEFAULT_CWD ?? process.cwd()),
    createdAt: new Date(),
    permissionMode: req.permissionMode ?? "default",
    currentPermissionMode: req.permissionMode ?? "default",
    model: req.model,
    effort: req.effort,
    abortController: new AbortController(),
    pendingApproval: null,
    alwaysAllowedTools: new Set<string>(),
    status: hasPrompt ? "starting" : "idle",
    lastError: null,
  };

  sessions.set(id, session);

  if (hasPrompt) {
    runSession(session, req.prompt!, req.permissionMode ?? "default", req.model, req.allowedTools, req.resumeSessionId);
  }

  return { id, status: session.status };
}

// ── Session execution ──

/** Transition watcher to poll mode, logging but not throwing on failure. */
async function safeTransitionToPoll(sessionId: string): Promise<void> {
  if (!watcher) return;
  try {
    await watcher.transitionToPoll(sessionId);
  } catch (err) {
    console.warn(`Failed to transition watcher to poll for ${sessionId}:`, err);
  }
}

async function runSession(
  session: ActiveSession,
  prompt: string,
  permissionMode: PermissionModeCommon,
  model: string | undefined,
  allowedTools?: string[],
  resumeSessionId?: string,
): Promise<void> {
  if (!watcher) {
    console.error(`runSession(${session.sessionId}): watcher not initialized`);
    session.status = "error";
    session.lastError = "Internal error: message delivery system not initialized";
    return;
  }

  try {
    session.status = "running";

    // Enter push mode — the watcher stores messages and broadcasts to WS clients.
    // Creates the WatchedSession entry if no client has subscribed yet.
    watcher.setMode(session.sessionId, "push", session.cwd);
    watcher.pushEvent(session.sessionId, { type: "status", status: "running" });
    watcher.pushEvent(session.sessionId, { type: "mode_changed", mode: session.currentPermissionMode });

    const adapter = getProvider(session.provider);
    const generator = adapter.run({
      prompt,
      cwd: session.cwd,
      permissionMode,
      model,
      effort: session.effort,
      allowedTools,
      maxTurns: 50,
      abortSignal: session.abortController.signal,
      resumeSessionId,
      onToolApproval: (request) => {
        if (session.alwaysAllowedTools.has(request.toolName)) {
          return Promise.resolve({ allow: true as const });
        }
        return new Promise((resolve) => {
          const targetMode = adapter.modeTransitionTools?.get(request.toolName);
          session.pendingApproval = {
            toolName: request.toolName,
            toolUseId: request.toolUseId,
            input: request.input,
            ...(targetMode ? { targetMode } : {}),
            resolve,
          };
          session.status = "waiting_for_approval";
          watcher!.pushEvent(session.sessionId, {
            type: "status",
            status: "waiting_for_approval",
          });
          watcher!.pushEvent(session.sessionId, {
            type: "tool_approval_request",
            toolName: request.toolName,
            toolUseId: request.toolUseId,
            input: request.input,
            ...(targetMode ? { targetMode } : {}),
          });
        });
      },
      onThinkingDelta: (text: string) => {
        watcher!.pushEvent(session.sessionId, { type: "thinking_delta", text });
      },
      onSubagentStarted: (info) => {
        watcher!.pushEvent(session.sessionId, {
          type: "subagent_started",
          taskId: info.taskId,
          toolUseId: info.toolUseId,
          description: info.description,
          startedAt: Date.now(),
          ...(info.agentType ? { agentType: info.agentType } : {}),
        });
      },
      onSubagentToolCall: (info) => {
        watcher!.pushEvent(session.sessionId, {
          type: "subagent_tool_call",
          toolUseId: info.toolUseId,
          toolName: info.toolName,
          summary: info.summary,
        });
      },
      onSubagentCompleted: (info) => {
        watcher!.pushEvent(session.sessionId, {
          type: "subagent_completed",
          taskId: info.taskId,
          toolUseId: info.toolUseId,
          status: info.status,
          summary: info.summary,
        });
      },
      onModeChanged: (newMode: PermissionModeCommon) => {
        session.currentPermissionMode = newMode;
        watcher!.pushEvent(session.sessionId, { type: "mode_changed", mode: newMode });
      },
      onCompacting: (isCompacting) => {
        watcher!.pushEvent(session.sessionId, { type: "compacting", isCompacting });
      },
      onContextUsage: (usage) => {
        const percentUsed = Math.min(100, Math.round((usage.inputTokens / usage.contextWindow) * 100));
        watcher!.pushEvent(session.sessionId, {
          type: "context_usage",
          inputTokens: usage.inputTokens,
          contextWindow: usage.contextWindow,
          percentUsed,
        });
      },
      onToolProgress: (info) => {
        watcher!.pushEvent(session.sessionId, {
          type: "tool_progress",
          toolUseId: info.toolUseId,
          toolName: info.toolName,
          elapsedSeconds: info.elapsedSeconds,
        });
      },
      onQueryCreated: (q) => {
        session.queryHandle = q;
      },
      onSessionIdResolved: (realId: string) => {
        // Remap the session to the real CLI session ID as soon as it's known
        // (from the SDK's init message, before any visible messages arrive).
        // This eliminates the window where listSessionsWithHistory() would see
        // the live session under a temp UUID and the JSONL file under the real ID,
        // causing a spurious duplicate "history" entry in the session list.
        if (realId === session.sessionId) return;
        const oldId = session.sessionId;
        session.sessionId = realId;
        sessions.delete(oldId);
        sessions.set(session.sessionId, session);
        sessionAliases.set(oldId, session.sessionId);
        watcher!.remap(oldId, session.sessionId);
        // session_redirected lets connected clients update their session ID.
        // transitionToPoll() is NOT called here — the session is still running
        // in push mode; that transition happens at the end of runSession().
        watcher!.pushEvent(session.sessionId, {
          type: "session_redirected",
          newSessionId: session.sessionId,
        });
      },
    });

    // Push the user prompt as a message. The watcher stores it in messages[]
    // so it's available for replay when the WS client connects (no initialPrompt needed).
    watcher.pushMessage(session.sessionId, {
      role: "user",
      parts: [{ type: "text", text: prompt }],
      index: 0, // Will be overwritten by pushMessage() to messages.length
    });

    // Manual iteration: we need the generator's return value (ProviderSessionResult)
    // which for-await discards.
    let result: IteratorResult<NormalizedMessage, ProviderSessionResult>;
    while (!(result = await generator.next()).done) {
      // Intercept system_init messages — broadcast slash commands separately, not stored.
      if (result.value.role === "system" && "event" in result.value && result.value.event.type === "system_init") {
        watcher.pushEvent(session.sessionId, { type: "slash_commands", commands: result.value.event.slashCommands });
        continue;
      }
      // Intercept session_result mid-stream — marks idle between turns when streaming input is active.
      // The generator stays alive waiting for the next streamInput() call; not stored (like system_init).
      if (
        session.queryHandle &&
        result.value.role === "system" &&
        "event" in result.value &&
        result.value.event.type === "session_result"
      ) {
        session.status = "idle";
        watcher.pushEvent(session.sessionId, { type: "status", status: "idle" });
        continue;
      }
      // Store + broadcast each SDK message via the watcher.
      watcher.pushMessage(session.sessionId, result.value);

      // Trigger async git diff after tool results (file changes may have occurred)
      if (result.value.role === "user" && result.value.parts.some((p) => p.type === "tool_result")) {
        computeGitDiffStat(session.cwd).then((stat) => {
          if (stat && watcher) {
            watcher.pushEvent(session.sessionId, {
              type: "git_diff_stat",
              ...stat,
            } as ServerMessage);
          }
        }).catch(() => {}); // Non-critical
      }
    }

    const sessionResult = result.value;

    // Capture the CLI session ID from the provider result.
    // If it differs from our temp UUID, remap the session in the map
    // and notify connected WebSocket clients of the new session ID.
    if (sessionResult.providerSessionId && sessionResult.providerSessionId !== session.sessionId) {
      const oldId = session.sessionId;
      session.sessionId = sessionResult.providerSessionId;
      sessions.delete(oldId);
      sessions.set(session.sessionId, session);
      sessionAliases.set(oldId, session.sessionId);
      // Remap the watcher entry then transition to poll mode (one atomic step
      // replaces the old remap → syncOffset → unsuppress dance).
      watcher.remap(oldId, session.sessionId);
      await safeTransitionToPoll(session.sessionId);
      watcher.pushEvent(session.sessionId, {
        type: "session_redirected",
        newSessionId: session.sessionId,
      });
    } else {
      // No remap needed (e.g., resumed session) — transition to poll.
      await safeTransitionToPoll(session.sessionId);
    }

    // Status may have been mutated externally by interruptSession()
    const currentStatus = session.status as ActiveSession["status"];
    if (currentStatus !== "interrupted") {
      session.status = "completed";
    }
  } catch (err) {
    // Transition to poll on error so the watcher can take over.
    await safeTransitionToPoll(session.sessionId);

    const currentStatus = session.status as ActiveSession["status"];
    const isAbortError = session.abortController.signal.aborted;

    if (currentStatus === "interrupted" && isAbortError) {
      // Expected abort from interruption — not an error
    } else if (currentStatus === "interrupted") {
      console.error(`Session ${session.sessionId} unexpected error during interruption:`, err);
    } else {
      session.status = "error";
      session.lastError = String(err);
      console.error(`Session ${session.sessionId} error:`, err);
    }
  }

  // Clear the live query handle — the generator is done.
  session.queryHandle = undefined;

  watcher.pushEvent(session.sessionId, {
    type: "status",
    status: session.status,
    ...(session.lastError ? { error: session.lastError } : {}),
  });
}

// ── Session actions ──

export function interruptSession(id: string): boolean {
  const session = getActiveSession(id);
  if (!session) return false;
  session.status = "interrupted";
  session.abortController.abort();
  if (watcher) {
    watcher.pushEvent(session.sessionId, { type: "status", status: "interrupted" });
  } else {
    console.error(`interruptSession(${id}): watcher not initialized — status update not sent`);
  }
  return true;
}

export function clearSessions(): void {
  for (const s of sessions.values()) {
    s.abortController.abort();
  }
  sessions.clear();
  sessionAliases.clear();
}

export function deleteSession(id: string): boolean {
  const session = getActiveSession(id);
  if (!session) return false;
  interruptSession(session.sessionId);
  sessions.delete(session.sessionId);
  // Clean up any aliases pointing to this session
  for (const [alias, target] of sessionAliases) {
    if (target === session.sessionId) sessionAliases.delete(alias);
  }
  return true;
}

export interface HandleApprovalOptions {
  message?: string;
  answers?: Record<string, string>;
  alwaysAllow?: boolean;
  targetMode?: PermissionModeCommon;
  clearContext?: boolean;
}

export function handleApproval(
  session: ActiveSession,
  toolUseId: string,
  allow: boolean,
  options?: HandleApprovalOptions,
): boolean | { clearContext: true; newMode: PermissionModeCommon; cwd: string } {
  if (
    !session.pendingApproval ||
    session.pendingApproval.toolUseId !== toolUseId
  )
    return false;

  const approval = session.pendingApproval;
  session.pendingApproval = null;
  session.status = "running";
  if (watcher) {
    watcher.pushEvent(session.sessionId, { type: "status", status: "running" });
  } else {
    console.error(`handleApproval(${session.sessionId}): watcher not initialized — status update not sent`);
  }

  if (allow) {
    const { alwaysAllow, answers, targetMode, clearContext } = options ?? {};
    if (alwaysAllow) {
      session.alwaysAllowedTools.add(approval.toolName);
    }
    let updatedInput: Record<string, unknown> | undefined;
    if (answers) {
      if (approval.input && typeof approval.input === "object" && !Array.isArray(approval.input)) {
        updatedInput = { ...(approval.input as Record<string, unknown>), answers };
      } else {
        updatedInput = { answers };
      }
    }
    if (clearContext && targetMode) {
      // Deny the tool so the SDK delivers the denial to the subprocess cleanly.
      // Allowing and then immediately aborting races with the permission stream write,
      // causing "Tool permission stream closed before response received". By denying,
      // the SDK sends the denial through the permission stream (no abort needed), and
      // the old session winds down naturally after one more Claude turn.
      approval.resolve({ allow: false, message: "Context cleared — continuing in a fresh session" });
      return { clearContext: true, newMode: targetMode, cwd: session.cwd };
    }
    approval.resolve({ allow: true, updatedInput, alwaysAllow });
  } else {
    approval.resolve({ allow: false, message: options?.message ?? "Denied by user" });
  }
  return true;
}

/** Yields a single user message in the format the SDK's streamInput() expects. */
async function* streamUserMessage(sessionId: string, text: string) {
  yield {
    type: "user" as const,
    message: { role: "user" as const, content: text },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

export async function sendFollowUp(
  session: ActiveSession,
  text: string,
): Promise<boolean> {
  if (session.status === "running" || session.status === "starting" || session.status === "waiting_for_approval") {
    return false;
  }

  // Streaming path: the SDK query is still alive — stream input directly into it.
  // This avoids spawning a new CLI process; the same process handles the next turn.
  if (session.queryHandle) {
    session.status = "running";
    watcher?.setMode(session.sessionId, "push", session.cwd);
    watcher?.pushEvent(session.sessionId, { type: "status", status: "running" });
    watcher?.pushMessage(session.sessionId, {
      role: "user",
      parts: [{ type: "text", text }],
      index: 0, // overwritten by pushMessage()
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await session.queryHandle.streamInput(streamUserMessage(session.sessionId, text) as any);
    return true;
  }

  // Fallback path: start a new session (resume-based, for reconnected/history sessions).
  session.abortController = new AbortController();
  const isFirstMessage = session.status === "idle";
  runSession(
    session,
    text,
    session.currentPermissionMode,
    session.model,
    undefined,
    isFirstMessage ? undefined : session.sessionId,
  );
  return true;
}
