import { open, stat, readFile } from "node:fs/promises";
import type { WebSocket } from "ws";
import type { ProviderAdapter, NormalizedMessage } from "./providers/types.js";
import type { ServerMessage } from "./types.js";
import { extractTasks } from "./task-extractor.js";

/** Internal tracking state for a single watched session. */
interface WatchedSession {
  filePath: string | null;
  byteOffset: number;
  lineBuffer: string;
  messageIndex: number;
  clients: Set<WebSocket>;
  /** When true, pollSession() skips this session. Used by runSession() to
   *  prevent the watcher from broadcasting messages that are already being
   *  delivered directly via broadcastToSession(). */
  pollingSuppressed: boolean;
}

/**
 * Tails JSONL session files on disk and broadcasts normalized messages
 * to subscribed WebSocket clients. A single polling interval checks all
 * watched sessions — no per-session timers.
 */
export class SessionWatcher {
  private adapter: ProviderAdapter;
  private sessions = new Map<string, WatchedSession>();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  /** Session IDs whose polling is suppressed (runSession broadcasts directly). */
  private suppressedIds = new Set<string>();

  constructor(adapter: ProviderAdapter) {
    this.adapter = adapter;
  }

  /** Number of sessions currently being watched. */
  get watchedCount(): number {
    return this.sessions.size;
  }

  /**
   * Subscribe a WebSocket client to a session.
   * Replays existing messages from the JSONL file, then streams new ones.
   */
  async subscribe(sessionId: string, client: WebSocket, messageLimit?: number): Promise<void> {
    let watched = this.sessions.get(sessionId);

    if (watched) {
      // Session already being watched — add client and replay from file
      watched.clients.add(client);
      // Re-resolve file path if it was null at initial subscribe time
      // (e.g., session was created with a temp UUID then remapped)
      if (!watched.filePath) {
        const filePath = await this.adapter.getSessionFilePath(sessionId);
        if (filePath) {
          watched.filePath = filePath;
        }
      }
      await this.replayToClient(watched, client, messageLimit);
      return;
    }

    // Create the entry IMMEDIATELY (before any await) to prevent race
    // conditions when multiple clients subscribe concurrently. Without
    // this, both calls see sessions.get() as undefined, both take this
    // branch, and the second overwrites the first — losing a client.
    watched = {
      filePath: null,
      byteOffset: 0,
      lineBuffer: "",
      messageIndex: 0,
      clients: new Set([client]),
      pollingSuppressed: this.suppressedIds.has(sessionId),
    };
    this.sessions.set(sessionId, watched);

    // Resolve file path via adapter (async)
    const filePath = await this.adapter.getSessionFilePath(sessionId);
    if (!filePath) {
      this.send(client, { type: "replay_complete", totalMessages: 0, oldestIndex: 0 });
      return;
    }

    // Got a file path — update the entry and replay existing content
    watched.filePath = filePath;
    await this.replayToClient(watched, client, messageLimit);
  }

  /**
   * Unsubscribe a client from a session.
   * Removes the session watch entirely if no clients remain.
   */
  unsubscribe(sessionId: string, client: WebSocket): void {
    let watched = this.sessions.get(sessionId);
    if (!watched) {
      // sessionId may be the old (pre-remap) ID — find by client reference
      for (const w of this.sessions.values()) {
        if (w.clients.has(client)) { watched = w; break; }
      }
    }
    if (!watched) return;

    watched.clients.delete(client);
    if (watched.clients.size === 0) {
      for (const [key, w] of this.sessions) {
        if (w === watched) { this.sessions.delete(key); break; }
      }
    }
  }

  /**
   * Remap a session from one ID to another. Moves all subscribers
   * so broadcasts under the new ID reach existing clients.
   */
  remap(oldId: string, newId: string): void {
    const watched = this.sessions.get(oldId);
    if (!watched) return;
    this.sessions.delete(oldId);
    this.sessions.set(newId, watched);
  }

  /**
   * Suppress file-based polling for a session. Used by runSession() to
   * prevent the watcher from delivering messages that are already being
   * broadcast directly. The session entry is created if it doesn't exist.
   */
  suppressPolling(sessionId: string): void {
    const watched = this.sessions.get(sessionId);
    if (watched) {
      watched.pollingSuppressed = true;
    }
    // If no entry yet, it'll be created when subscribe() is called —
    // we store the flag for later in case subscribe comes after this call.
    this.suppressedIds.add(sessionId);
  }

  /**
   * Re-enable file-based polling for a session.
   */
  unsuppressPolling(sessionId: string): void {
    this.suppressedIds.delete(sessionId);
    const watched = this.sessions.get(sessionId);
    if (watched) {
      watched.pollingSuppressed = false;
    }
  }

  /**
   * Advance a session's byteOffset to the current file size so the next
   * poll doesn't replay already-delivered messages. Called after runSession()
   * completes and the session is remapped to its provider ID.
   */
  async syncOffsetToEnd(sessionId: string): Promise<void> {
    const watched = this.sessions.get(sessionId);
    if (!watched) return;

    // Resolve file path if needed
    if (!watched.filePath) {
      const filePath = await this.adapter.getSessionFilePath(sessionId);
      if (filePath) watched.filePath = filePath;
    }
    if (!watched.filePath) return;

    try {
      // Read the full file to count normalized messages (for correct messageIndex)
      // and advance byteOffset to EOF so future polls only see new data.
      const content = await readFile(watched.filePath, "utf-8");
      watched.byteOffset = Buffer.byteLength(content, "utf-8");
      watched.lineBuffer = "";

      let idx = 0;
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        if (this.adapter.normalizeFileLine(line, idx)) idx++;
      }
      if (idx > watched.messageIndex) watched.messageIndex = idx;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  /** Start the global poll loop. Call once at server startup. */
  start(intervalMs = 200): void {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => {
      this.poll().catch((err) => {
        console.error("SessionWatcher poll error:", err);
      });
    }, intervalMs);
  }

  /** Stop polling. Call on server shutdown. */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  // ── Private methods ──

  /**
   * Replay the full file content to a single client, then send replay_complete.
   * Updates the watched session's byteOffset and messageIndex to the end of file.
   * For the first subscriber, this reads the file and sets the offset.
   * For subsequent subscribers, we re-read from byte 0 up to the current offset
   * so they get a full replay without interfering with the shared state.
   */
  private async replayToClient(watched: WatchedSession, client: WebSocket, messageLimit?: number): Promise<void> {
    // No file to replay (e.g., test adapter) — just signal replay is done
    if (!watched.filePath) {
      this.send(client, { type: "replay_complete", totalMessages: 0, oldestIndex: 0 });
      return;
    }

    let content: string;
    try {
      content = await readFile(watched.filePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // File doesn't exist yet — send replay_complete, leave byteOffset at 0
        this.send(client, { type: "replay_complete", totalMessages: 0, oldestIndex: 0 });
        return;
      }
      // Non-ENOENT error — send error + replay_complete so the client doesn't hang
      this.send(client, { type: "error", message: "failed to load message history" });
      this.send(client, { type: "replay_complete", totalMessages: 0, oldestIndex: 0 });
      throw err;
    }

    const contentBytes = Buffer.byteLength(content, "utf-8");
    const lines = content.split("\n");

    // 1. Normalize ALL lines to get the full message list
    const allMessages: NormalizedMessage[] = [];
    let replayIndex = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      const normalized = this.adapter.normalizeFileLine(line, replayIndex);
      if (normalized) {
        allMessages.push(normalized);
        replayIndex++;
      }
    }

    // 2. Extract task state from the full message set
    const tasks = extractTasks(allMessages);

    // 3. Determine which messages to send
    const totalMessages = allMessages.length;
    const toSend = messageLimit && messageLimit < totalMessages
      ? allMessages.slice(-messageLimit)
      : allMessages;

    // 4. Send only the selected messages to the client
    for (const msg of toSend) {
      this.send(client, { type: "message", message: msg });
    }

    // 5. Update shared state to the furthest point we've read.
    // Only advance — never go backwards (another subscriber may have
    // already advanced it further via a concurrent replay).
    if (contentBytes > watched.byteOffset) {
      watched.byteOffset = contentBytes;
    }
    if (replayIndex > watched.messageIndex) {
      watched.messageIndex = replayIndex;
    }

    // Check if the file ends with an incomplete line (no trailing newline on last segment)
    // Only set lineBuffer for the first subscriber (when it was empty)
    const lastSegment = lines[lines.length - 1];
    if (lastSegment && lastSegment.trim() && !content.endsWith("\n")) {
      if (!watched.lineBuffer) {
        watched.lineBuffer = lastSegment;
      }
    }

    // 6. Send tasks if any non-completed tasks exist
    if (tasks.length > 0 && tasks.some((t) => t.status !== "completed")) {
      this.send(client, { type: "tasks", tasks });
    }

    // 7. Send replay_complete with pagination metadata
    const oldestIndex = toSend.length > 0 ? toSend[0].index : 0;
    this.send(client, { type: "replay_complete", totalMessages, oldestIndex });
  }

  /** Single poll cycle: check all watched sessions for new data. */
  private async poll(): Promise<void> {
    for (const [sessionId, watched] of this.sessions) {
      try {
        await this.pollSession(sessionId, watched);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
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
  private async pollSession(sessionId: string, watched: WatchedSession): Promise<void> {
    // Skip polling for sessions where runSession() broadcasts directly.
    if (watched.pollingSuppressed) return;

    if (!watched.filePath) {
      // File path wasn't available at subscribe time (e.g., session created
      // via API with a temp UUID, then remapped to the CLI session ID).
      // Try to resolve it now — the JSONL file may exist under the new ID.
      const filePath = await this.adapter.getSessionFilePath(sessionId);
      if (filePath) {
        watched.filePath = filePath;
      } else {
        return;
      }
    }

    let fileSize: number;
    try {
      const fileStat = await stat(watched.filePath);
      fileSize = fileStat.size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // File doesn't exist yet — nothing to do
        return;
      }
      throw err;
    }

    // No new data
    if (fileSize <= watched.byteOffset) return;

    // Read only the new bytes
    const bytesToRead = fileSize - watched.byteOffset;
    const buffer = Buffer.alloc(bytesToRead);

    const fh = await open(watched.filePath, "r");
    try {
      await fh.read(buffer, 0, bytesToRead, watched.byteOffset);
    } finally {
      await fh.close().catch((err) => console.warn("SessionWatcher: failed to close file handle:", (err as Error).message));
    }

    watched.byteOffset = fileSize;

    const chunk = buffer.toString("utf-8");

    // Prepend any leftover partial line from previous poll
    const data = watched.lineBuffer + chunk;
    const segments = data.split("\n");

    // Last segment is either empty (if chunk ended with \n) or an incomplete line
    watched.lineBuffer = segments.pop()!;

    // Process complete lines
    for (const line of segments) {
      if (!line.trim()) continue;
      const normalized = this.adapter.normalizeFileLine(line, watched.messageIndex);
      if (normalized) {
        watched.messageIndex++;
        this.broadcast(watched, { type: "message", message: normalized });
      }
    }
  }

  /** Send a message to a single WebSocket client. */
  private send(client: WebSocket, msg: ServerMessage): void {
    if (client.readyState !== 1) return;
    try {
      client.send(JSON.stringify(msg));
    } catch (err) {
      console.warn("SessionWatcher: failed to send to client:", (err as Error).message);
    }
  }

  /**
   * Broadcast a ServerMessage to all subscribed clients of a session.
   * Used by sessions.ts to push status/approval updates through the
   * watcher's centralized client tracking.
   */
  broadcastToSubscribers(sessionId: string, msg: ServerMessage): void {
    const watched = this.sessions.get(sessionId);
    if (!watched) return;
    this.broadcast(watched, msg);
  }

  /** Broadcast a message to all clients of a watched session. */
  private broadcast(watched: WatchedSession, msg: ServerMessage): void {
    const payload = JSON.stringify(msg);
    for (const client of watched.clients) {
      if (client.readyState === 1) {
        try {
          client.send(payload);
        } catch (err) {
          console.warn("SessionWatcher: broadcast send failed, removing client:", (err as Error).message);
          watched.clients.delete(client);
        }
      } else {
        watched.clients.delete(client);
      }
    }
  }
}
