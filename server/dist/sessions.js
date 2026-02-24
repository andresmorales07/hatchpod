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
/**
 * Broadcast a ServerMessage to all WebSocket subscribers of a session
 * via the SessionWatcher. Used for status changes, approval requests,
 * and other runtime-only events that don't come from the JSONL file.
 */
export function broadcastToSession(sessionId, msg) {
    if (!watcher) {
        console.error(`broadcastToSession(${sessionId}): watcher not initialized — message dropped`);
        return;
    }
    watcher.broadcastToSubscribers(sessionId, msg);
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
        initialPrompt: hasPrompt && !req.resumeSessionId ? req.prompt : null,
    };
    sessions.set(id, session);
    if (hasPrompt) {
        runSession(session, req.prompt, req.permissionMode ?? "default", req.model, req.allowedTools, req.resumeSessionId);
    }
    return { id, status: session.status };
}
// ── Session execution ──
async function runSession(session, prompt, permissionMode, model, allowedTools, resumeSessionId) {
    try {
        session.status = "running";
        broadcastToSession(session.sessionId, { type: "status", status: "running" });
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
                    broadcastToSession(session.sessionId, {
                        type: "status",
                        status: "waiting_for_approval",
                    });
                    broadcastToSession(session.sessionId, {
                        type: "tool_approval_request",
                        toolName: request.toolName,
                        toolUseId: request.toolUseId,
                        input: request.input,
                    });
                });
            },
            onThinkingDelta: (text) => {
                broadcastToSession(session.sessionId, { type: "thinking_delta", text });
            },
        });
        // Suppress file-based polling for this session while we're running.
        // We broadcast messages directly below (lower latency than the 200ms poll).
        // Without this, the watcher would also pick up the same messages from the
        // JSONL file and broadcast them a second time → duplicate messages.
        if (watcher)
            watcher.suppressPolling(session.sessionId);
        // The SDK doesn't yield the initial user prompt back from the iterator —
        // it's the input to sdkQuery(). Broadcast a synthetic user message so
        // connected clients see the prompt in the chat immediately. This covers
        // the sendFollowUp(idle) path where the WS client is already connected.
        // For sessions created with a prompt from the REST API (NewSessionPage),
        // the client hasn't connected yet so ws.ts sends the prompt on connect.
        if (!resumeSessionId) {
            broadcastToSession(session.sessionId, {
                type: "message",
                message: { role: "user", parts: [{ type: "text", text: prompt }], index: 0 },
            });
        }
        // Manual iteration: we need the generator's return value (ProviderSessionResult)
        // which for-await discards.
        let result;
        while (!(result = await generator.next()).done) {
            // Intercept system_init messages — broadcast slash commands separately.
            // These are runtime-only events that don't appear in the JSONL file.
            if (result.value.role === "system" && "event" in result.value && result.value.event.type === "system_init") {
                broadcastToSession(session.sessionId, { type: "slash_commands", commands: result.value.event.slashCommands });
                continue;
            }
            // Broadcast the message directly for live WebSocket clients.
            broadcastToSession(session.sessionId, { type: "message", message: result.value });
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
            if (!watcher) {
                console.error(`Session remap: watcher not initialized, clients will not receive updates`);
            }
            else {
                // Remap the watcher entry, sync offset to EOF, THEN unsuppress polling.
                // Order matters: syncOffsetToEnd must complete before polling resumes,
                // otherwise the watcher re-reads the JSONL from offset 0 and broadcasts
                // every message that was already delivered directly → duplicates.
                watcher.remap(oldId, session.sessionId);
                try {
                    await watcher.syncOffsetToEnd(session.sessionId);
                }
                catch (err) {
                    console.warn(`Failed to sync watcher offset for ${session.sessionId}:`, err);
                }
                watcher.unsuppressPolling(session.sessionId);
            }
            broadcastToSession(session.sessionId, {
                type: "session_redirected",
                newSessionId: session.sessionId,
            });
        }
        else if (watcher) {
            // No remap needed (e.g., resumed session) — sync offset to EOF first,
            // THEN unsuppress polling. Without this ordering, the watcher can poll
            // before the offset is advanced and re-broadcast already-delivered messages.
            try {
                await watcher.syncOffsetToEnd(session.sessionId);
            }
            catch (err) {
                console.warn(`Failed to sync watcher offset for ${session.sessionId}:`, err);
            }
            watcher.unsuppressPolling(session.sessionId);
        }
        // Status may have been mutated externally by interruptSession()
        const currentStatus = session.status;
        if (currentStatus !== "interrupted") {
            session.status = "completed";
        }
    }
    catch (err) {
        // Ensure polling is unsuppressed on error so the watcher can take over.
        // Sync offset first to prevent re-broadcast of already-delivered messages.
        if (watcher) {
            try {
                await watcher.syncOffsetToEnd(session.sessionId);
            }
            catch { /* best-effort on error path */ }
            watcher.unsuppressPolling(session.sessionId);
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
    broadcastToSession(session.sessionId, {
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
    broadcastToSession(session.sessionId, { type: "status", status: "interrupted" });
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
    broadcastToSession(session.sessionId, { type: "status", status: "running" });
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
