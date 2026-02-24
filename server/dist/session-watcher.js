import { open, stat } from "node:fs/promises";
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
export class SessionWatcher {
    adapter;
    sessions = new Map();
    intervalHandle = null;
    constructor(adapter) {
        this.adapter = adapter;
    }
    /** Number of sessions currently being watched. */
    get watchedCount() {
        return this.sessions.size;
    }
    // ── Client management ──
    /**
     * Subscribe a WebSocket client to a session.
     * Replays existing messages (from memory or JSONL file), then streams new ones.
     */
    async subscribe(sessionId, client, messageLimit) {
        let watched = this.sessions.get(sessionId);
        if (watched) {
            watched.clients.add(client);
            // Replay from best available source
            if (watched.messages.length > 0) {
                this.replayFromMemory(watched, client, messageLimit);
            }
            else {
                // Re-resolve file path if it was null at initial subscribe time
                if (!watched.filePath) {
                    const filePath = await this.adapter.getSessionFilePath(sessionId);
                    if (filePath)
                        watched.filePath = filePath;
                }
                await this.replayFromFile(sessionId, watched, client, messageLimit);
            }
            return;
        }
        // Create the entry IMMEDIATELY (before any await) to prevent race
        // conditions when multiple clients subscribe concurrently.
        // Default to "poll" mode so CLI/history sessions get live JSONL updates.
        // API sessions override this immediately via setMode("push") in runSession().
        watched = {
            messages: [],
            clients: new Set([client]),
            mode: "poll",
            filePath: null,
            byteOffset: 0,
            lineBuffer: "",
        };
        this.sessions.set(sessionId, watched);
        // Resolve file path via adapter (async)
        const filePath = await this.adapter.getSessionFilePath(sessionId);
        if (!filePath) {
            this.send(client, { type: "replay_complete", totalMessages: 0, oldestIndex: 0 });
            return;
        }
        watched.filePath = filePath;
        await this.replayFromFile(sessionId, watched, client, messageLimit);
    }
    /**
     * Unsubscribe a client from a session.
     * Removes the session entry if no clients remain AND no in-memory messages
     * exist. Sessions with messages are preserved for reconnect replay.
     */
    unsubscribe(sessionId, client) {
        let watched = this.sessions.get(sessionId);
        if (!watched) {
            // sessionId may be the old (pre-remap) ID — find by client reference
            for (const w of this.sessions.values()) {
                if (w.clients.has(client)) {
                    watched = w;
                    break;
                }
            }
        }
        if (!watched)
            return;
        watched.clients.delete(client);
        if (watched.clients.size === 0 && watched.messages.length === 0) {
            for (const [key, w] of this.sessions) {
                if (w === watched) {
                    this.sessions.delete(key);
                    break;
                }
            }
        }
    }
    /**
     * Remap a session from one ID to another. Moves all subscribers
     * so broadcasts under the new ID reach existing clients.
     */
    remap(oldId, newId) {
        const watched = this.sessions.get(oldId);
        if (!watched) {
            console.warn(`SessionWatcher.remap(${oldId} → ${newId}): old session not found`);
            return false;
        }
        this.sessions.delete(oldId);
        this.sessions.set(newId, watched);
        return true;
    }
    /**
     * Forcefully remove a session entry regardless of messages or clients.
     * Called during TTL eviction to prevent unbounded memory growth.
     */
    forceRemove(sessionId) {
        this.sessions.delete(sessionId);
    }
    // ── Message production ──
    /**
     * Push a message into a session's in-memory store and broadcast to all
     * subscribed clients. The message index is derived from `messages.length`
     * — the single authority for indexing.
     *
     * Only operates in "push" mode. No-ops if the session doesn't exist or
     * isn't in push mode.
     */
    pushMessage(sessionId, message) {
        const watched = this.sessions.get(sessionId);
        if (!watched)
            return;
        if (watched.mode !== "push") {
            console.warn(`SessionWatcher.pushMessage(${sessionId}): dropped — mode is "${watched.mode}", expected "push"`);
            return;
        }
        const indexed = { ...message, index: watched.messages.length };
        watched.messages.push(indexed);
        this.broadcast(watched, { type: "message", message: indexed });
    }
    /**
     * Broadcast an ephemeral event to all subscribers of a session.
     * Unlike pushMessage(), this does NOT store the event in messages[] —
     * used for status changes, thinking deltas, approval requests, etc.
     */
    pushEvent(sessionId, event) {
        const watched = this.sessions.get(sessionId);
        if (!watched) {
            if ("status" in event) {
                console.warn(`SessionWatcher.pushEvent(${sessionId}): status "${event.status}" dropped — session not tracked`);
            }
            return;
        }
        this.broadcast(watched, event);
    }
    /**
     * Set the delivery mode for a session. Creates the WatchedSession entry
     * if it doesn't exist yet (needed when runSession starts before WS connects).
     */
    setMode(sessionId, mode) {
        let watched = this.sessions.get(sessionId);
        if (!watched) {
            watched = {
                messages: [],
                clients: new Set(),
                mode,
                filePath: null,
                byteOffset: 0,
                lineBuffer: "",
            };
            this.sessions.set(sessionId, watched);
        }
        else {
            watched.mode = mode;
        }
    }
    /**
     * Transition a session from push mode to poll mode. Resolves the JSONL file
     * path and advances the byte offset to EOF so polling only picks up new data
     * written after this point.
     *
     * This is a single atomic operation that replaces the old 3-step dance of
     * suppressPolling → syncOffsetToEnd → unsuppressPolling.
     */
    async transitionToPoll(sessionId) {
        const watched = this.sessions.get(sessionId);
        if (!watched) {
            console.warn(`SessionWatcher.transitionToPoll(${sessionId}): session not tracked — skipping`);
            return;
        }
        // Resolve file path if needed
        if (!watched.filePath) {
            const filePath = await this.adapter.getSessionFilePath(sessionId);
            if (filePath)
                watched.filePath = filePath;
        }
        // Advance byteOffset to EOF so polling only sees new data
        if (watched.filePath) {
            try {
                const fileStat = await stat(watched.filePath);
                watched.byteOffset = fileStat.size;
            }
            catch (err) {
                if (err.code !== "ENOENT")
                    throw err;
            }
        }
        watched.lineBuffer = "";
        watched.mode = "poll";
    }
    // ── Lifecycle ──
    /** Start the global poll loop. Call once at server startup. */
    start(intervalMs = 200) {
        if (this.intervalHandle)
            return;
        this.intervalHandle = setInterval(() => {
            this.poll().catch((err) => {
                console.error("SessionWatcher poll error:", err);
            });
        }, intervalMs);
    }
    /** Stop polling. Call on server shutdown. */
    stop() {
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }
    }
    // ── Private methods ──
    /**
     * Replay messages from in-memory store to a single client. Supports
     * pagination via messageLimit (returns the most recent N messages).
     */
    replayFromMemory(watched, client, messageLimit) {
        const allMessages = watched.messages;
        const total = allMessages.length;
        // Apply limit: take the most recent N messages
        const limit = messageLimit && messageLimit > 0 ? messageLimit : total;
        const startIdx = Math.max(0, total - limit);
        const page = allMessages.slice(startIdx);
        const oldestIndex = page.length > 0 ? page[0].index : 0;
        for (const msg of page) {
            this.send(client, { type: "message", message: msg });
        }
        this.send(client, {
            type: "replay_complete",
            totalMessages: total,
            oldestIndex,
        });
    }
    /**
     * Replay messages from JSONL file via adapter.getMessages(), then
     * sync watcher state and send replay_complete.
     */
    async replayFromFile(sessionId, watched, client, messageLimit) {
        // No file to replay (e.g., test adapter) — just signal replay is done
        if (!watched.filePath) {
            this.send(client, { type: "replay_complete", totalMessages: 0, oldestIndex: 0 });
            return;
        }
        // Snapshot file size BEFORE reading so the byte offset stays aligned
        // with what _parseAllMessages actually consumed (avoids TOCTOU race).
        let preReplaySize = 0;
        try {
            const fileStat = await stat(watched.filePath);
            preReplaySize = fileStat.size;
        }
        catch (err) {
            if (err.code !== "ENOENT")
                throw err;
        }
        let result;
        try {
            result = await this.adapter.getMessages(sessionId, {
                limit: messageLimit,
            });
        }
        catch (err) {
            if (err instanceof Error && err.name === "SessionNotFound") {
                this.send(client, { type: "replay_complete", totalMessages: 0, oldestIndex: 0 });
                return;
            }
            this.send(client, { type: "error", message: "failed to load message history" });
            this.send(client, { type: "replay_complete", totalMessages: 0, oldestIndex: 0 });
            throw err;
        }
        // 1. Send messages to the client and populate in-memory store
        for (const msg of result.messages) {
            this.send(client, { type: "message", message: msg });
            // Populate messages[] for future reconnects (only if empty to avoid duplication)
            if (watched.messages.length === 0 || watched.messages[watched.messages.length - 1].index < msg.index) {
                watched.messages.push(msg);
            }
        }
        // 2. Sync watcher state — advance byteOffset using the snapshot captured
        //    before getMessages() read the file, so we don't skip bytes written
        //    between the adapter read and this point.
        if (preReplaySize > watched.byteOffset) {
            watched.byteOffset = preReplaySize;
        }
        watched.lineBuffer = "";
        // 3. Send tasks if any non-completed tasks exist
        if (result.tasks.length > 0 && result.tasks.some((t) => t.status !== "completed")) {
            this.send(client, { type: "tasks", tasks: result.tasks });
        }
        // 4. Send replay_complete with pagination metadata
        this.send(client, {
            type: "replay_complete",
            totalMessages: result.totalMessages,
            oldestIndex: result.oldestIndex,
        });
    }
    /** Single poll cycle: check all watched sessions for new data. */
    async poll() {
        for (const [sessionId, watched] of this.sessions) {
            try {
                await this.pollSession(sessionId, watched);
            }
            catch (err) {
                if (err.code === "ENOENT") {
                    // File was deleted after we started tracking it — reset offset
                    // so we re-read from the beginning if it reappears.
                    if (watched.byteOffset > 0) {
                        console.warn(`SessionWatcher: file disappeared for session ${sessionId}, resetting offset`);
                        watched.byteOffset = 0;
                        watched.lineBuffer = "";
                    }
                    continue;
                }
                console.error(`SessionWatcher: error polling session ${sessionId}:`, err);
            }
        }
    }
    /** Poll a single session for new data. */
    async pollSession(sessionId, watched) {
        // Only poll sessions in poll mode
        if (watched.mode !== "poll")
            return;
        if (!watched.filePath) {
            // File path wasn't available at subscribe time — try to resolve now
            const filePath = await this.adapter.getSessionFilePath(sessionId);
            if (filePath) {
                watched.filePath = filePath;
            }
            else {
                return;
            }
        }
        let fileSize;
        try {
            const fileStat = await stat(watched.filePath);
            fileSize = fileStat.size;
        }
        catch (err) {
            if (err.code === "ENOENT") {
                return;
            }
            throw err;
        }
        // No new data
        if (fileSize <= watched.byteOffset)
            return;
        // Read only the new bytes
        const bytesToRead = fileSize - watched.byteOffset;
        const buffer = Buffer.alloc(bytesToRead);
        const fh = await open(watched.filePath, "r");
        try {
            await fh.read(buffer, 0, bytesToRead, watched.byteOffset);
        }
        finally {
            await fh.close().catch((err) => console.warn("SessionWatcher: failed to close file handle:", err.message));
        }
        watched.byteOffset = fileSize;
        const chunk = buffer.toString("utf-8");
        // Prepend any leftover partial line from previous poll
        const data = watched.lineBuffer + chunk;
        const segments = data.split("\n");
        // Last segment is either empty (if chunk ended with \n) or an incomplete line
        watched.lineBuffer = segments.pop();
        // Process complete lines
        for (const line of segments) {
            if (!line.trim())
                continue;
            const normalized = this.adapter.normalizeFileLine(line, watched.messages.length);
            if (normalized) {
                const indexed = { ...normalized, index: watched.messages.length };
                watched.messages.push(indexed);
                this.broadcast(watched, { type: "message", message: indexed });
            }
        }
    }
    /** Send a message to a single WebSocket client. */
    send(client, msg) {
        if (client.readyState !== 1)
            return;
        try {
            client.send(JSON.stringify(msg));
        }
        catch (err) {
            console.warn("SessionWatcher: failed to send to client:", err.message);
        }
    }
    /** Broadcast a message to all clients of a watched session. */
    broadcast(watched, msg) {
        const payload = JSON.stringify(msg);
        for (const client of watched.clients) {
            if (client.readyState === 1) {
                try {
                    client.send(payload);
                }
                catch (err) {
                    console.warn("SessionWatcher: broadcast send failed, removing client:", err.message);
                    watched.clients.delete(client);
                }
            }
            else {
                watched.clients.delete(client);
            }
        }
    }
}
