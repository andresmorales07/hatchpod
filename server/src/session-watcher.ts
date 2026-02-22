import { open, stat, readFile } from "node:fs/promises";
import type { WebSocket } from "ws";
import type { ProviderAdapter } from "./providers/types.js";
import type { ServerMessage } from "./types.js";

/** Internal tracking state for a single watched session. */
interface WatchedSession {
  filePath: string;
  byteOffset: number;
  lineBuffer: string;
  messageIndex: number;
  clients: Set<WebSocket>;
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
  async subscribe(sessionId: string, client: WebSocket): Promise<void> {
    // Check if we already have a watch for this session
    let watched = this.sessions.get(sessionId);

    if (watched) {
      // Session already being watched — add client and replay from file
      watched.clients.add(client);
      await this.replayToClient(watched, client);
      return;
    }

    // Resolve file path via adapter
    const filePath = await this.adapter.getSessionFilePath(sessionId);
    if (!filePath) {
      this.send(client, { type: "error", message: `Session file not found for ${sessionId}` });
      return;
    }

    // Create new watch entry
    watched = {
      filePath,
      byteOffset: 0,
      lineBuffer: "",
      messageIndex: 0,
      clients: new Set([client]),
    };
    this.sessions.set(sessionId, watched);

    // Replay existing content
    await this.replayToClient(watched, client);
  }

  /**
   * Unsubscribe a client from a session.
   * Removes the session watch entirely if no clients remain.
   */
  unsubscribe(sessionId: string, client: WebSocket): void {
    const watched = this.sessions.get(sessionId);
    if (!watched) return;

    watched.clients.delete(client);
    if (watched.clients.size === 0) {
      this.sessions.delete(sessionId);
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
  private async replayToClient(watched: WatchedSession, client: WebSocket): Promise<void> {
    let content: string;
    try {
      content = await readFile(watched.filePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // File doesn't exist yet — send replay_complete, leave byteOffset at 0
        this.send(client, { type: "replay_complete" });
        return;
      }
      throw err;
    }

    const contentBytes = Buffer.byteLength(content, "utf-8");
    const lines = content.split("\n");

    // Track a local index for this replay. We need to replay all messages
    // from index 0 to the client, but we must also ensure the shared
    // messageIndex is at least as high as the count of normalized messages.
    let replayIndex = 0;

    for (const line of lines) {
      if (!line.trim()) continue;
      const normalized = this.adapter.normalizeFileLine(line, replayIndex);
      if (normalized) {
        this.send(client, { type: "message", message: normalized });
        replayIndex++;
      }
    }

    // Update shared state to the furthest point we've read.
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
      // There's an incomplete line at the end
      if (!watched.lineBuffer) {
        watched.lineBuffer = lastSegment;
        // Re-adjust: the incomplete line's bytes shouldn't be counted
        // as "consumed" — we'll re-read them on the next poll.
        // Actually, since byteOffset points to end of file, and the
        // partial line is already buffered, we leave byteOffset as-is
        // because the next poll uses stat().size > byteOffset to detect
        // new data beyond what we've already read.
      }
    }

    this.send(client, { type: "replay_complete" });
  }

  /** Single poll cycle: check all watched sessions for new data. */
  private async poll(): Promise<void> {
    for (const [sessionId, watched] of this.sessions) {
      try {
        await this.pollSession(sessionId, watched);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          // File doesn't exist (yet, or was deleted) — skip silently
          continue;
        }
        console.error(`SessionWatcher: error polling session ${sessionId}:`, err);
      }
    }
  }

  /** Poll a single session for new data. */
  private async pollSession(_sessionId: string, watched: WatchedSession): Promise<void> {
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
      await fh.close();
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
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(JSON.stringify(msg));
    }
  }

  /** Broadcast a message to all clients of a watched session. */
  private broadcast(watched: WatchedSession, msg: ServerMessage): void {
    const payload = JSON.stringify(msg);
    for (const client of watched.clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(payload);
      }
    }
  }
}
