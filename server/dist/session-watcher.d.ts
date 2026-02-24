import type { WebSocket } from "ws";
import type { ProviderAdapter } from "./providers/types.js";
import type { ServerMessage } from "./types.js";
/**
 * Tails JSONL session files on disk and broadcasts normalized messages
 * to subscribed WebSocket clients. A single polling interval checks all
 * watched sessions — no per-session timers.
 */
export declare class SessionWatcher {
    private adapter;
    private sessions;
    private intervalHandle;
    /** Session IDs whose polling is suppressed (runSession broadcasts directly). */
    private suppressedIds;
    constructor(adapter: ProviderAdapter);
    /** Number of sessions currently being watched. */
    get watchedCount(): number;
    /**
     * Subscribe a WebSocket client to a session.
     * Replays existing messages from the JSONL file, then streams new ones.
     */
    subscribe(sessionId: string, client: WebSocket, messageLimit?: number): Promise<void>;
    /**
     * Unsubscribe a client from a session.
     * Removes the session watch entirely if no clients remain.
     */
    unsubscribe(sessionId: string, client: WebSocket): void;
    /**
     * Remap a session from one ID to another. Moves all subscribers
     * so broadcasts under the new ID reach existing clients.
     */
    remap(oldId: string, newId: string): void;
    /**
     * Suppress file-based polling for a session. Used by runSession() to
     * prevent the watcher from delivering messages that are already being
     * broadcast directly. The session entry is created if it doesn't exist.
     */
    suppressPolling(sessionId: string): void;
    /**
     * Re-enable file-based polling for a session.
     */
    unsuppressPolling(sessionId: string): void;
    /**
     * Advance a session's byteOffset to the current file size so the next
     * poll doesn't replay already-delivered messages. Called after runSession()
     * completes and the session is remapped to its provider ID.
     */
    syncOffsetToEnd(sessionId: string): Promise<void>;
    /** Start the global poll loop. Call once at server startup. */
    start(intervalMs?: number): void;
    /** Stop polling. Call on server shutdown. */
    stop(): void;
    /**
     * Replay messages to a single client via adapter.getMessages(), then
     * sync watcher state and send replay_complete.
     */
    private replayToClient;
    /** Single poll cycle: check all watched sessions for new data. */
    private poll;
    /** Poll a single session for new data. */
    private pollSession;
    /** Send a message to a single WebSocket client. */
    private send;
    /**
     * Broadcast a ServerMessage to all subscribed clients of a session.
     * Used by sessions.ts to push status/approval updates through the
     * watcher's centralized client tracking.
     */
    broadcastToSubscribers(sessionId: string, msg: ServerMessage): void;
    /** Broadcast a message to all clients of a watched session. */
    private broadcast;
}
