import type { WebSocket } from "ws";
import type { ProviderAdapter, NormalizedMessage } from "./providers/types.js";
import type { ServerMessage } from "./types.js";
/**
 * Session delivery mode.
 * - "push": runSession() pushes messages via pushMessage(). No file polling.
 * - "poll": File-based JSONL tailing. Used for CLI/external sessions.
 * - "idle": Default state. No active delivery mechanism.
 */
type SessionMode = "push" | "poll" | "idle";
/**
 * Central message router for all session types. Stores messages in-memory,
 * replays to new subscribers, and broadcasts live updates.
 *
 * Two delivery modes:
 * - **Push mode** — `runSession()` calls `pushMessage()` for each SDK-yielded
 *   message. Messages are stored in `messages[]` and broadcast to clients.
 * - **Poll mode** — A 200ms interval tails JSONL files on disk for CLI/external
 *   sessions. Discovered messages are stored in `messages[]` and broadcast.
 *
 * Subscribers always receive history from in-memory `messages[]` first,
 * falling back to JSONL file replay only when no in-memory data exists.
 */
export declare class SessionWatcher {
    private adapter;
    private sessions;
    private intervalHandle;
    constructor(adapter: ProviderAdapter);
    /** Number of sessions currently being watched. */
    get watchedCount(): number;
    /**
     * Subscribe a WebSocket client to a session.
     * Replays existing messages (from memory or JSONL file), then streams new ones.
     */
    subscribe(sessionId: string, client: WebSocket, messageLimit?: number): Promise<void>;
    /**
     * Unsubscribe a client from a session.
     * Removes the session entry if no clients remain AND no in-memory messages
     * exist. Sessions with messages are preserved for reconnect replay.
     */
    unsubscribe(sessionId: string, client: WebSocket): void;
    /**
     * Remap a session from one ID to another. Moves all subscribers
     * so broadcasts under the new ID reach existing clients.
     */
    remap(oldId: string, newId: string): boolean;
    /**
     * Forcefully remove a session entry regardless of messages or clients.
     * Called during TTL eviction to prevent unbounded memory growth.
     */
    forceRemove(sessionId: string): void;
    /**
     * Push a message into a session's in-memory store and broadcast to all
     * subscribed clients. The message index is derived from `messages.length`
     * — the single authority for indexing.
     *
     * Only operates in "push" mode. No-ops if the session doesn't exist or
     * isn't in push mode.
     */
    pushMessage(sessionId: string, message: NormalizedMessage): void;
    /**
     * Broadcast an ephemeral event to all subscribers of a session.
     * Unlike pushMessage(), this does NOT store the event in messages[] —
     * used for status changes, thinking deltas, approval requests, etc.
     */
    pushEvent(sessionId: string, event: ServerMessage): void;
    /**
     * Set the delivery mode for a session. Creates the WatchedSession entry
     * if it doesn't exist yet (needed when runSession starts before WS connects).
     */
    setMode(sessionId: string, mode: SessionMode): void;
    /**
     * Transition a session from push mode to poll mode. Resolves the JSONL file
     * path and advances the byte offset to EOF so polling only picks up new data
     * written after this point.
     *
     * This is a single atomic operation that replaces the old 3-step dance of
     * suppressPolling → syncOffsetToEnd → unsuppressPolling.
     */
    transitionToPoll(sessionId: string): Promise<void>;
    /** Start the global poll loop. Call once at server startup. */
    start(intervalMs?: number): void;
    /** Stop polling. Call on server shutdown. */
    stop(): void;
    /**
     * Replay messages from in-memory store to a single client. Supports
     * pagination via messageLimit (returns the most recent N messages).
     */
    private replayFromMemory;
    /**
     * Replay messages from JSONL file via adapter.getMessages(), then
     * sync watcher state and send replay_complete.
     */
    private replayFromFile;
    /** Single poll cycle: check all watched sessions for new data. */
    private poll;
    /** Poll a single session for new data. */
    private pollSession;
    /** Send a message to a single WebSocket client. */
    private send;
    /** Broadcast a message to all clients of a watched session. */
    private broadcast;
}
export {};
