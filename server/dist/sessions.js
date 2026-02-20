import { getProvider } from "./providers/index.js";
import { randomUUID } from "node:crypto";
const sessions = new Map();
const MAX_SESSIONS = 50;
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // run every 5 minutes
// Periodically evict finished sessions older than SESSION_TTL_MS
setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
        const isFinished = s.status === "completed" || s.status === "error" || s.status === "interrupted";
        const isAbandonedIdle = s.status === "idle" && s.clients.size === 0;
        if ((isFinished || isAbandonedIdle) && s.clients.size === 0 && now - s.createdAt.getTime() > SESSION_TTL_MS) {
            sessions.delete(id);
        }
    }
}, CLEANUP_INTERVAL_MS).unref();
export function listSessions() {
    return Array.from(sessions.values()).map((s) => ({
        id: s.id,
        status: s.status,
        createdAt: s.createdAt.toISOString(),
        numTurns: s.numTurns,
        totalCostUsd: s.totalCostUsd,
        hasPendingApproval: s.pendingApproval !== null,
    }));
}
export function sessionToDTO(session) {
    return {
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
        slashCommands: session.slashCommands,
        pendingApproval: session.pendingApproval
            ? {
                toolName: session.pendingApproval.toolName,
                toolUseId: session.pendingApproval.toolUseId,
                input: session.pendingApproval.input,
            }
            : null,
    };
}
export function getSession(id) {
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
export function broadcast(session, msg) {
    const data = JSON.stringify(msg);
    for (const client of session.clients) {
        try {
            if (client.readyState === 1) {
                client.send(data);
            }
        }
        catch (err) {
            console.error(`WebSocket send failed for session ${session.id}:`, err);
            session.clients.delete(client);
        }
    }
}
export async function createSession(req) {
    if (sessions.size >= MAX_SESSIONS) {
        throw new Error(`maximum session limit reached (${MAX_SESSIONS})`);
    }
    const hasPrompt = typeof req.prompt === "string" && req.prompt.length > 0;
    const id = randomUUID();
    const session = {
        id,
        provider: req.provider ?? "claude",
        status: hasPrompt ? "starting" : "idle",
        createdAt: new Date(),
        permissionMode: req.permissionMode ?? "default",
        model: req.model,
        cwd: req.cwd ?? (process.env.DEFAULT_CWD ?? process.cwd()),
        abortController: new AbortController(),
        messages: [],
        slashCommands: [],
        totalCostUsd: 0,
        numTurns: 0,
        lastError: null,
        pendingApproval: null,
        clients: new Set(),
    };
    sessions.set(id, session);
    // Fire and forget -- the async generator runs in the background
    if (hasPrompt) {
        runSession(session, req.prompt, req.allowedTools);
    }
    return session;
}
async function runSession(session, prompt, allowedTools, resumeSessionId) {
    try {
        session.status = "running";
        broadcast(session, { type: "status", status: "running" });
        const adapter = getProvider(session.provider);
        const generator = adapter.run({
            prompt,
            cwd: session.cwd,
            permissionMode: session.permissionMode,
            model: session.model,
            allowedTools,
            maxTurns: 50,
            abortSignal: session.abortController.signal,
            resumeSessionId,
            onToolApproval: (request) => new Promise((resolve) => {
                session.pendingApproval = {
                    toolName: request.toolName,
                    toolUseId: request.toolUseId,
                    input: request.input,
                    resolve,
                };
                session.status = "waiting_for_approval";
                broadcast(session, {
                    type: "status",
                    status: "waiting_for_approval",
                });
                broadcast(session, {
                    type: "tool_approval_request",
                    toolName: request.toolName,
                    toolUseId: request.toolUseId,
                    input: request.input,
                });
            }),
        });
        // Manual iteration instead of for-await because we need the generator's
        // return value (ProviderSessionResult with cost/turns), which for-await discards.
        let result;
        while (!(result = await generator.next()).done) {
            // Intercept system_init messages — store slash commands, broadcast separately
            if (result.value.role === "system" && "event" in result.value && result.value.event.type === "system_init") {
                session.slashCommands = result.value.event.slashCommands;
                broadcast(session, { type: "slash_commands", commands: session.slashCommands });
                continue;
            }
            session.messages.push(result.value);
            broadcast(session, { type: "message", message: result.value });
        }
        const sessionResult = result.value;
        session.totalCostUsd = sessionResult.totalCostUsd;
        session.numTurns = sessionResult.numTurns;
        if (sessionResult.providerSessionId) {
            session.providerSessionId = sessionResult.providerSessionId;
        }
        // Status may have been mutated externally by interruptSession()
        const currentStatus = session.status;
        if (currentStatus !== "interrupted") {
            session.status = "completed";
        }
    }
    catch (err) {
        const currentStatus = session.status;
        const isAbortError = err instanceof Error &&
            (err.name === "AbortError" || err.message === "aborted" || err.message.includes("abort"));
        if (currentStatus === "interrupted" && isAbortError) {
            // Expected abort from interruption — not an error
        }
        else if (currentStatus === "interrupted") {
            // Interrupted, but the error is NOT an abort error — log it
            console.error(`Session ${session.id} unexpected error during interruption:`, err);
        }
        else {
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
export function interruptSession(id) {
    const session = sessions.get(id);
    if (!session)
        return false;
    session.status = "interrupted";
    session.abortController.abort();
    broadcast(session, { type: "status", status: "interrupted" });
    return true;
}
export function handleApproval(session, toolUseId, allow, message) {
    if (!session.pendingApproval ||
        session.pendingApproval.toolUseId !== toolUseId)
        return false;
    const approval = session.pendingApproval;
    session.pendingApproval = null;
    session.status = "running";
    broadcast(session, { type: "status", status: "running" });
    if (allow) {
        approval.resolve({ allow: true });
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
    runSession(session, text, undefined, isFirstMessage ? undefined : (session.providerSessionId ?? session.id));
    return true;
}
/** Abort all sessions, terminate WS clients, and clear the session map. For tests. */
export function clearSessions() {
    for (const session of sessions.values()) {
        session.abortController.abort();
        for (const client of session.clients) {
            try {
                client.terminate();
            }
            catch (err) {
                console.error(`Failed to terminate WS client in session ${session.id}:`, err);
            }
        }
        session.clients.clear();
    }
    sessions.clear();
}
