import { getProvider } from "./providers/index.js";
import { SessionWatcher } from "./session-watcher.js";
import { randomUUID } from "node:crypto";
// ── ActiveSession map (runtime handles for API-driven sessions) ──
const sessions = new Map();
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
    const { listSessionHistory, listAllSessionHistory } = await import("./session-history.js");
    let history;
    try {
        history = await (cwd ? listSessionHistory(cwd) : listAllSessionHistory());
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
            live.lastModified = histMatch.lastModified.toISOString();
            live.cwd = histMatch.cwd;
        }
    }
    // Add history-only sessions (not already live)
    for (const h of history) {
        if (liveProviderIds.has(h.id))
            continue;
        liveSessions.push({
            id: h.id,
            status: "history",
            createdAt: h.createdAt.toISOString(),
            lastModified: h.lastModified.toISOString(),
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
    return sessions.get(id);
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
                if (session.status === "running") {
                    broadcastToSession(session.sessionId, { type: "thinking_delta", text });
                }
            },
        });
        // Manual iteration: we need the generator's return value (ProviderSessionResult)
        // which for-await discards.
        let result;
        while (!(result = await generator.next()).done) {
            // Intercept system_init messages — broadcast slash commands separately.
            // Messages are NOT stored; the watcher streams them from the JSONL file.
            if (result.value.role === "system" && "event" in result.value && result.value.event.type === "system_init") {
                broadcastToSession(session.sessionId, { type: "slash_commands", commands: result.value.event.slashCommands });
                continue;
            }
            // Broadcast the message directly for live WebSocket clients.
            // The watcher handles replay for late-connecting clients.
            broadcastToSession(session.sessionId, { type: "message", message: result.value });
        }
        const sessionResult = result.value;
        // Capture the CLI session ID from the provider result.
        // If it differs from our temp UUID, remap the session in the map.
        if (sessionResult.providerSessionId && sessionResult.providerSessionId !== session.sessionId) {
            const oldId = session.sessionId;
            session.sessionId = sessionResult.providerSessionId;
            sessions.delete(oldId);
            sessions.set(session.sessionId, session);
            watcher?.remap(oldId, session.sessionId);
        }
        // Status may have been mutated externally by interruptSession()
        const currentStatus = session.status;
        if (currentStatus !== "interrupted") {
            session.status = "completed";
        }
    }
    catch (err) {
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
    const session = sessions.get(id);
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
}
export function deleteSession(id) {
    const session = sessions.get(id);
    if (!session)
        return false;
    interruptSession(id);
    sessions.delete(id);
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
