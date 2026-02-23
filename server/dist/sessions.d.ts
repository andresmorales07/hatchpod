import type { ProviderAdapter } from "./providers/types.js";
import type { ActiveSession, CreateSessionRequest, ServerMessage, SessionSummaryDTO } from "./types.js";
import { SessionWatcher } from "./session-watcher.js";
/**
 * Initialize the SessionWatcher singleton. Call once at server startup.
 * The adapter is used to resolve JSONL file paths and normalize lines.
 */
export declare function initWatcher(adapter: ProviderAdapter): SessionWatcher;
/**
 * Return the SessionWatcher singleton.
 * Throws if initWatcher() hasn't been called yet.
 */
export declare function getWatcher(): SessionWatcher;
export declare function listSessions(): SessionSummaryDTO[];
export declare function listSessionsWithHistory(cwd?: string): Promise<SessionSummaryDTO[]>;
export declare function getActiveSession(id: string): ActiveSession | undefined;
export declare function getSessionCount(): {
    active: number;
    total: number;
};
/**
 * Broadcast a ServerMessage to all WebSocket subscribers of a session
 * via the SessionWatcher. Used for status changes, approval requests,
 * and other runtime-only events that don't come from the JSONL file.
 */
export declare function broadcastToSession(sessionId: string, msg: ServerMessage): void;
export declare function createSession(req: CreateSessionRequest): Promise<{
    id: string;
    status: ActiveSession["status"];
}>;
export declare function interruptSession(id: string): boolean;
export declare function clearSessions(): void;
export declare function deleteSession(id: string): boolean;
export declare function handleApproval(session: ActiveSession, toolUseId: string, allow: boolean, message?: string, answers?: Record<string, string>, alwaysAllow?: boolean): boolean;
export declare function sendFollowUp(session: ActiveSession, text: string): Promise<boolean>;
