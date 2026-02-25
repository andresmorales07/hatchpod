import { getProvider } from "./providers/index.js";
import { SessionWatcher } from "./session-watcher.js";
import { randomUUID } from "node:crypto";
// ── ActiveSession map (runtime handles for API-driven sessions) ──
const sessions = new Map();
// Maps old (temp) session IDs to their remapped (provider) session IDs.
// Allows WebSocket handlers that captured the old ID to still find the session.
const sessionAliases = new Map();
const MAX_SESSIONS = 50;
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
// Evict completed/errored/interrupted sessions older than TTL
setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
        if ((s.status === "completed" || s.status === "error" || s.status === "interrupted") &&
            now - s.createdAt.getTime() > SESSION_TTL_MS) {
            sessions.delete(id);
            // Also clean up watcher entries to prevent unbounded memory growth
            watcher?.forceRemove(id);
        }
    }
    // Clean up stale aliases whose targets no longer exist
    for (const [alias, target] of sessionAliases) {
        if (!sessions.has(target))
            sessionAliases.delete(alias);
    }
}, CLEANUP_INTERVAL_MS).unref();
// ── SessionWatcher singleton ──
let watcher = null;
/**
 * Initialize the SessionWatcher singleton. Call once at server startup.
 * The adapter is used to resolve JSONL file paths and normalize lines.
 */
export function initWatcher(adapter) {
    if (watcher)
        return watcher;
    watcher = new SessionWatcher(adapter);
    watcher.start();
    return watcher;
}
/**
 * Return the SessionWatcher singleton.
 * Throws if initWatcher() hasn't been called yet.
 */
export function getWatcher() {
    if (!watcher)
        throw new Error("SessionWatcher not initialized — call initWatcher() first");
    return watcher;
}
// ── Session listing ──
export function listSessions() {
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
    }));
}
export async function listSessionsWithHistory(cwd) {
    const liveSessions = listSessions();
    let history;
    try {
        const adapter = getProvider("claude");
        history = await adapter.listSessions(cwd);
    }
    catch (err) {
        console.warn("Failed to list session history:", err);
        return liveSessions;
    }
    // Build set of provider session IDs that are already live
    const liveProviderIds = new Set();
    for (const s of sessions.values()) {
        if (s.sessionId)
            liveProviderIds.add(s.sessionId);
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
        if (seenIds.has(h.id))
            continue;
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
        });
    }
    // Sort by lastModified descending
    liveSessions.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
    return liveSessions;
}
// ── Session CRUD ──
export function getActiveSession(id) {
    return sessions.get(id) ?? sessions.get(sessionAliases.get(id) ?? "");
}
export function getSessionCount() {
    let active = 0;
    for (const s of sessions.values()) {
        if (s.status === "running" ||
            s.status === "starting" ||
            s.status === "waiting_for_approval") {
            active++;
        }
    }
    return { active, total: sessions.size };
}
export async function createSession(req) {
    if (sessions.size >= MAX_SESSIONS) {
        throw new Error(`maximum session limit reached (${MAX_SESSIONS})`);
    }
    const hasPrompt = typeof req.prompt === "string" && req.prompt.length > 0;
    // For resumed sessions, use the provided session ID as our key so
    // the watcher can subscribe using the same ID.
    // For new sessions, the SDK will create a CLI session ID that we
    // capture from the result — until then we use a temp UUID.
    const id = req.resumeSessionId ?? randomUUID();
    const session = {
        sessionId: id,
        provider: req.provider ?? "claude",
        cwd: req.cwd ?? (process.env.DEFAULT_CWD ?? process.cwd()),
        createdAt: new Date(),
        permissionMode: req.permissionMode ?? "default",
        model: req.model,
        abortController: new AbortController(),
        pendingApproval: null,
        alwaysAllowedTools: new Set(),
        status: hasPrompt ? "starting" : "idle",
        lastError: null,
    };
    sessions.set(id, session);
    if (hasPrompt) {
        runSession(session, req.prompt, req.permissionMode ?? "default", req.model, req.allowedTools, req.resumeSessionId);
    }
    return { id, status: session.status };
}
// ── Session execution ──
async function runSession(session, prompt, permissionMode, model, allowedTools, resumeSessionId) {
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
        watcher.setMode(session.sessionId, "push");
        watcher.pushEvent(session.sessionId, { type: "status", status: "running" });
        const adapter = getProvider(session.provider);
        const generator = adapter.run({
            prompt,
            cwd: session.cwd,
            permissionMode,
            model,
            allowedTools,
            maxTurns: 50,
            abortSignal: session.abortController.signal,
            resumeSessionId,
            onToolApproval: (request) => {
                if (session.alwaysAllowedTools.has(request.toolName)) {
                    return Promise.resolve({ allow: true });
                }
                return new Promise((resolve) => {
                    session.pendingApproval = {
                        toolName: request.toolName,
                        toolUseId: request.toolUseId,
                        input: request.input,
                        resolve,
                    };
                    session.status = "waiting_for_approval";
                    watcher.pushEvent(session.sessionId, {
                        type: "status",
                        status: "waiting_for_approval",
                    });
                    watcher.pushEvent(session.sessionId, {
                        type: "tool_approval_request",
                        toolName: request.toolName,
                        toolUseId: request.toolUseId,
                        input: request.input,
                    });
                });
            },
            onThinkingDelta: (text) => {
                watcher.pushEvent(session.sessionId, { type: "thinking_delta", text });
            },
            onSubagentStarted: (info) => {
                watcher.pushEvent(session.sessionId, {
                    type: "subagent_started",
                    taskId: info.taskId,
                    toolUseId: info.toolUseId,
                    description: info.description,
                    startedAt: Date.now(),
                    ...(info.agentType ? { agentType: info.agentType } : {}),
                });
            },
            onSubagentToolCall: (info) => {
                watcher.pushEvent(session.sessionId, {
                    type: "subagent_tool_call",
                    toolUseId: info.toolUseId,
                    toolName: info.toolName,
                    summary: info.summary,
                });
            },
            onSubagentCompleted: (info) => {
                watcher.pushEvent(session.sessionId, {
                    type: "subagent_completed",
                    taskId: info.taskId,
                    toolUseId: info.toolUseId,
                    status: info.status,
                    summary: info.summary,
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
        let result;
        while (!(result = await generator.next()).done) {
            // Intercept system_init messages — broadcast slash commands separately.
            if (result.value.role === "system" && "event" in result.value && result.value.event.type === "system_init") {
                watcher.pushEvent(session.sessionId, { type: "slash_commands", commands: result.value.event.slashCommands });
                continue;
            }
            // Store + broadcast each SDK message via the watcher.
            watcher.pushMessage(session.sessionId, result.value);
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
            try {
                await watcher.transitionToPoll(session.sessionId);
            }
            catch (err) {
                console.warn(`Failed to transition watcher to poll for ${session.sessionId}:`, err);
            }
            watcher.pushEvent(session.sessionId, {
                type: "session_redirected",
                newSessionId: session.sessionId,
            });
        }
        else {
            // No remap needed (e.g., resumed session) — transition to poll.
            try {
                await watcher.transitionToPoll(session.sessionId);
            }
            catch (err) {
                console.warn(`Failed to transition watcher to poll for ${session.sessionId}:`, err);
            }
        }
        // Status may have been mutated externally by interruptSession()
        const currentStatus = session.status;
        if (currentStatus !== "interrupted") {
            session.status = "completed";
        }
    }
    catch (err) {
        // Transition to poll on error so the watcher can take over.
        try {
            await watcher.transitionToPoll(session.sessionId);
        }
        catch (pollErr) {
            console.warn(`runSession(${session.sessionId}): failed to transition to poll on error path:`, pollErr);
        }
        const currentStatus = session.status;
        const isAbortError = session.abortController.signal.aborted;
        if (currentStatus === "interrupted" && isAbortError) {
            // Expected abort from interruption — not an error
        }
        else if (currentStatus === "interrupted") {
            console.error(`Session ${session.sessionId} unexpected error during interruption:`, err);
        }
        else {
            session.status = "error";
            session.lastError = String(err);
            console.error(`Session ${session.sessionId} error:`, err);
        }
    }
    watcher.pushEvent(session.sessionId, {
        type: "status",
        status: session.status,
        ...(session.lastError ? { error: session.lastError } : {}),
    });
}
// ── Session actions ──
export function interruptSession(id) {
    const session = getActiveSession(id);
    if (!session)
        return false;
    session.status = "interrupted";
    session.abortController.abort();
    if (watcher) {
        watcher.pushEvent(session.sessionId, { type: "status", status: "interrupted" });
    }
    else {
        console.error(`interruptSession(${id}): watcher not initialized — status update not sent`);
    }
    return true;
}
export function clearSessions() {
    for (const s of sessions.values()) {
        s.abortController.abort();
    }
    sessions.clear();
    sessionAliases.clear();
}
export function deleteSession(id) {
    const session = getActiveSession(id);
    if (!session)
        return false;
    interruptSession(session.sessionId);
    sessions.delete(session.sessionId);
    // Clean up any aliases pointing to this session
    for (const [alias, target] of sessionAliases) {
        if (target === session.sessionId)
            sessionAliases.delete(alias);
    }
    return true;
}
export function handleApproval(session, toolUseId, allow, message, answers, alwaysAllow) {
    if (!session.pendingApproval ||
        session.pendingApproval.toolUseId !== toolUseId)
        return false;
    const approval = session.pendingApproval;
    session.pendingApproval = null;
    session.status = "running";
    if (watcher) {
        watcher.pushEvent(session.sessionId, { type: "status", status: "running" });
    }
    else {
        console.error(`handleApproval(${session.sessionId}): watcher not initialized — status update not sent`);
    }
    if (allow) {
        if (alwaysAllow) {
            session.alwaysAllowedTools.add(approval.toolName);
        }
        let updatedInput;
        if (answers) {
            if (approval.input && typeof approval.input === "object" && !Array.isArray(approval.input)) {
                updatedInput = { ...approval.input, answers };
            }
            else {
                updatedInput = { answers };
            }
        }
        approval.resolve({ allow: true, updatedInput, alwaysAllow });
    }
    else {
        approval.resolve({ allow: false, message: message ?? "Denied by user" });
    }
    return true;
}
export async function sendFollowUp(session, text) {
    if (session.status === "running" || session.status === "starting") {
        return false;
    }
    session.abortController = new AbortController();
    const isFirstMessage = session.status === "idle";
    runSession(session, text, session.permissionMode, session.model, undefined, isFirstMessage ? undefined : session.sessionId);
    return true;
}
