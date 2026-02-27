import { open, stat } from "node:fs/promises";
import type { WebSocket } from "ws";
import type { ProviderAdapter, NormalizedMessage, ToolSummary, PermissionModeCommon } from "./providers/types.js";
import type { ServerMessage, ContextUsage } from "./types.js";
import type { GitDiffStat } from "./schemas/git.js";
import { computeGitDiffStat } from "./git-status.js";

/**
 * Session delivery mode.
 * - "push": runSession() pushes messages via pushMessage(). No file polling.
 * - "poll": File-based JSONL tailing. Used for CLI/external sessions.
 * - "idle": Default state. No active delivery mechanism.
 */
type SessionMode = "push" | "poll" | "idle";

/** Statuses that clear transient buffers (thinking, subagents, compacting, git diff). */
const TERMINAL_STATUSES = new Set(["completed", "error", "interrupted"]);

/** Buffered state for a single active subagent (keyed by toolUseId). */
interface SubagentEntry {
  taskId: string;
  description: string;
  agentType?: string;
  toolCalls: Array<{ toolName: string; summary: ToolSummary }>;
  /** Wall-clock ms when the subagent_started event was first received. */
  startedAt: number;
}

/** Internal tracking state for a single watched session. */
interface WatchedSession {
  /** In-memory message log — single source of truth for message history. */
  messages: NormalizedMessage[];
  /** Subscribed WebSocket clients. */
  clients: Set<WebSocket>;
  /** Delivery mode. */
  mode: SessionMode;

  // File polling state (used only when mode === "poll")
  filePath: string | null;
  byteOffset: number;
  lineBuffer: string;

  /**
   * Accumulated thinking text from thinking_delta events.
   * Buffers text for late-connecting subscribers so they see the
   * ThinkingIndicator even if they miss the live stream. Cleared when:
   * - An assistant message with a `reasoning` part arrives via pushMessage()
   * - A terminal status event (completed/error/interrupted) arrives via pushEvent()
   * Assistant messages without a reasoning part do NOT clear the buffer.
   */
  pendingThinkingText: string;

  /** Active subagent states — keyed by toolUseId (parent Task tool_use_id). */
  activeSubagents: Map<string, SubagentEntry>;

  /** Whether the session is currently compacting. Cleared on terminal status. */
  isCompacting: boolean;

  /** Last known context usage. Kept on terminal status (useful final state). */
  lastContextUsage: ContextUsage | null;

  /** Last known git diff stat. Sent to late subscribers. Cleared on terminal status. */
  lastGitDiffStat: GitDiffStat | null;

  /** Session working directory — needed for triggering git diff from poll mode. */
  cwd: string | null;

  /**
   * Last known permission mode from a mode_changed event.
   * Sent to late-connecting subscribers so they see the correct mode badge
   * even if they missed the live mode_changed event. Null until first transition.
   */
  lastMode: PermissionModeCommon | null;
}

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

  // ── Client management ──

  /**
   * Subscribe a WebSocket client to a session.
   * Replays existing messages (from memory or JSONL file), then streams new ones.
   */
  async subscribe(sessionId: string, client: WebSocket, messageLimit?: number): Promise<void> {
    let watched = this.sessions.get(sessionId);

    if (watched) {
      watched.clients.add(client);
      // Snapshot all buffers before any await — concurrent pushMessage() or
      // pushEvent() calls can mutate these during replayFromFile() suspension.
      const thinkingSnapshot = watched.pendingThinkingText;
      const subagentsSnapshot = new Map(watched.activeSubagents);
      const compactingSnapshot = watched.isCompacting;
      const contextUsageSnapshot = watched.lastContextUsage;
      const gitDiffStatSnapshot = watched.lastGitDiffStat;
      const lastModeSnapshot = watched.lastMode;
      // Replay from best available source (buffered events are sent before
      // replay_complete inside the replay methods)
      if (watched.messages.length > 0) {
        this.replayFromMemory(watched, client, messageLimit, thinkingSnapshot, subagentsSnapshot, compactingSnapshot, contextUsageSnapshot, gitDiffStatSnapshot, lastModeSnapshot);
      } else {
        // Re-resolve file path if it was null at initial subscribe time
        if (!watched.filePath) {
          const filePath = await this.adapter.getSessionFilePath(sessionId);
          if (filePath) watched.filePath = filePath;
        }
        await this.replayFromFile(sessionId, watched, client, messageLimit, thinkingSnapshot, subagentsSnapshot, compactingSnapshot, contextUsageSnapshot, gitDiffStatSnapshot, lastModeSnapshot);
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
      pendingThinkingText: "",
      activeSubagents: new Map(),
      isCompacting: false,
      lastContextUsage: null,
      lastGitDiffStat: null,
      cwd: null,
      lastMode: null,
    };
    this.sessions.set(sessionId, watched);

    // Resolve file path via adapter (async)
    const filePath = await this.adapter.getSessionFilePath(sessionId);
    if (!filePath) {
      this.send(client, { type: "replay_complete", totalMessages: 0, oldestIndex: 0 });
      return;
    }

    watched.filePath = filePath;

    // Resolve cwd for poll-mode git diff support
    try {
      const sessions = await this.adapter.listSessions();
      const match = sessions.find((s) => s.id === sessionId);
      if (match) watched.cwd = match.cwd;
    } catch {
      // Non-critical
    }

    await this.replayFromFile(sessionId, watched, client, messageLimit);
  }

  /**
   * Unsubscribe a client from a session.
   * Removes the session entry if no clients remain AND no in-memory messages
   * exist. Sessions with messages are preserved for reconnect replay.
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
    if (watched.clients.size === 0 && watched.messages.length === 0) {
      for (const [key, w] of this.sessions) {
        if (w === watched) { this.sessions.delete(key); break; }
      }
    }
  }

  /**
   * Remap a session from one ID to another. Moves all subscribers
   * so broadcasts under the new ID reach existing clients.
   */
  remap(oldId: string, newId: string): boolean {
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
  forceRemove(sessionId: string): void {
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
  pushMessage(sessionId: string, message: NormalizedMessage): void {
    const watched = this.sessions.get(sessionId);
    if (!watched) return;
    if (watched.mode !== "push") {
      console.warn(
        `SessionWatcher.pushMessage(${sessionId}): dropped — mode is "${watched.mode}", expected "push"`,
      );
      return;
    }
    // Clear thinking buffer when the finalized assistant message arrives
    // (it contains the complete reasoning as a part, so the buffer is redundant)
    if (message.role === "assistant" && message.parts.some((p) => p.type === "reasoning")) {
      watched.pendingThinkingText = "";
    }

    const indexed = { ...message, index: watched.messages.length };
    watched.messages.push(indexed);
    this.broadcast(watched, { type: "message", message: indexed });
  }

  /**
   * Broadcast an ephemeral event to all subscribers of a session.
   * Unlike pushMessage(), this does NOT store the event in messages[] —
   * used for status changes, thinking deltas, approval requests, etc.
   *
   * Several event types are buffered in WatchedSession fields so that
   * late-connecting subscribers receive current state on subscribe():
   *   - thinking_delta  → pendingThinkingText
   *   - compacting      → isCompacting
   *   - context_usage   → lastContextUsage
   *   - git_diff_stat   → lastGitDiffStat
   *   - subagent_*      → activeSubagents
   */
  pushEvent(sessionId: string, event: ServerMessage): void {
    const watched = this.sessions.get(sessionId);
    if (!watched) {
      if ("status" in event) {
        console.warn(
          `SessionWatcher.pushEvent(${sessionId}): status "${(event as { status: string }).status}" dropped — session not tracked`,
        );
      }
      return;
    }

    // Buffer thinking text so late-connecting subscribers can catch up
    if (event.type === "thinking_delta") {
      watched.pendingThinkingText += event.text;
    }

    // Buffer permission mode transitions for late subscribers
    if (event.type === "mode_changed") {
      watched.lastMode = (event as { type: "mode_changed"; mode: PermissionModeCommon }).mode;
    }

    // Buffer compacting and context usage state for late subscribers
    if (event.type === "compacting") {
      watched.isCompacting = event.isCompacting;
    } else if (event.type === "context_usage") {
      watched.lastContextUsage = { inputTokens: event.inputTokens, contextWindow: event.contextWindow, percentUsed: event.percentUsed };
    }

    if (event.type === "git_diff_stat") {
      const e = event as ServerMessage & { type: "git_diff_stat" };
      watched.lastGitDiffStat = { files: e.files, totalInsertions: e.totalInsertions, totalDeletions: e.totalDeletions, ...(e.branch !== undefined ? { branch: e.branch } : {}) };
    }

    // Buffer subagent state for late subscribers
    if (event.type === "subagent_started") {
      const e = event as { type: string; taskId: string; toolUseId: string; description: string; agentType?: string; startedAt: number };
      watched.activeSubagents.set(e.toolUseId, {
        taskId: e.taskId,
        description: e.description,
        agentType: e.agentType,
        toolCalls: [],
        startedAt: e.startedAt,
      });
    } else if (event.type === "subagent_tool_call") {
      const e = event as { type: string; toolUseId: string; toolName: string; summary: ToolSummary };
      const entry = watched.activeSubagents.get(e.toolUseId);
      if (entry) {
        entry.toolCalls.push({ toolName: e.toolName, summary: e.summary });
      } else {
        console.warn(
          `SessionWatcher.pushEvent: subagent_tool_call for unknown toolUseId "${e.toolUseId}" — subagent_started may not have been received`,
        );
      }
    } else if (event.type === "subagent_completed") {
      const e = event as { type: string; toolUseId: string };
      watched.activeSubagents.delete(e.toolUseId);
    }

    // Clear transient buffers on terminal status — prevents stale data from
    // being replayed after session completion or error. lastContextUsage is
    // intentionally kept (useful final state for the header badge).
    if (event.type === "status" && TERMINAL_STATUSES.has(event.status)) {
      watched.pendingThinkingText = "";
      watched.activeSubagents.clear();
      watched.isCompacting = false;
      watched.lastGitDiffStat = null;
    }

    this.broadcast(watched, event);
  }

  /**
   * Set the delivery mode for a session. Creates the WatchedSession entry
   * if it doesn't exist yet (needed when runSession starts before WS connects).
   */
  setMode(sessionId: string, mode: SessionMode, cwd?: string): void {
    let watched = this.sessions.get(sessionId);
    if (!watched) {
      watched = {
        messages: [],
        clients: new Set(),
        mode,
        filePath: null,
        byteOffset: 0,
        lineBuffer: "",
        pendingThinkingText: "",
        activeSubagents: new Map(),
        isCompacting: false,
        lastContextUsage: null,
        lastGitDiffStat: null,
        cwd: cwd ?? null,
        lastMode: null,
      };
      this.sessions.set(sessionId, watched);
    } else {
      watched.mode = mode;
      watched.cwd = cwd ?? watched.cwd ?? null;
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
  async transitionToPoll(sessionId: string): Promise<void> {
    const watched = this.sessions.get(sessionId);
    if (!watched) {
      console.warn(`SessionWatcher.transitionToPoll(${sessionId}): session not tracked — skipping`);
      return;
    }

    // Resolve file path if needed
    if (!watched.filePath) {
      const filePath = await this.adapter.getSessionFilePath(sessionId);
      if (filePath) watched.filePath = filePath;
    }

    // Advance byteOffset to EOF so polling only sees new data
    if (watched.filePath) {
      try {
        const fileStat = await stat(watched.filePath);
        watched.byteOffset = fileStat.size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    watched.lineBuffer = "";
    watched.mode = "poll";
  }

  // ── Lifecycle ──

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

  /** Buffered ephemeral state to replay to late-connecting subscribers. */
  private sendBufferedState(
    client: WebSocket,
    watched: WatchedSession,
    overrides?: {
      pendingThinking?: string;
      subagents?: Map<string, SubagentEntry>;
      isCompacting?: boolean;
      contextUsage?: ContextUsage | null;
      gitDiffStat?: GitDiffStat | null;
      lastMode?: PermissionModeCommon | null;
    },
  ): void {
    const thinking = overrides?.pendingThinking ?? watched.pendingThinkingText;
    const subagents = overrides?.subagents ?? watched.activeSubagents;
    const compacting = overrides?.isCompacting ?? watched.isCompacting;
    const usage = overrides?.contextUsage !== undefined ? overrides.contextUsage : watched.lastContextUsage;
    const diff = overrides?.gitDiffStat !== undefined ? overrides.gitDiffStat : watched.lastGitDiffStat;
    const mode = overrides?.lastMode !== undefined ? overrides.lastMode : watched.lastMode;

    if (thinking) {
      this.send(client, { type: "thinking_delta", text: thinking });
    }
    this.replaySubagentState(subagents, client);
    if (compacting) {
      this.send(client, { type: "compacting", isCompacting: true });
    }
    if (usage) {
      this.send(client, { type: "context_usage", ...usage });
    }
    if (diff) {
      this.send(client, { type: "git_diff_stat", ...diff });
    }
    if (mode) {
      this.send(client, { type: "mode_changed", mode });
    }
  }

  /**
   * Replay messages from in-memory store to a single client. Supports
   * pagination via messageLimit (returns the most recent N messages).
   * Buffered ephemeral state is sent before replay_complete.
   */
  private replayFromMemory(
    watched: WatchedSession,
    client: WebSocket,
    messageLimit?: number,
    pendingThinking?: string,
    subagentsSnapshot?: Map<string, SubagentEntry>,
    isCompacting?: boolean,
    contextUsage?: ContextUsage | null,
    gitDiffStat?: GitDiffStat | null,
    lastMode?: PermissionModeCommon | null,
  ): void {
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

    this.sendBufferedState(client, watched, {
      pendingThinking,
      subagents: subagentsSnapshot,
      isCompacting,
      contextUsage,
      gitDiffStat,
      lastMode,
    });
    this.send(client, {
      type: "replay_complete",
      totalMessages: total,
      oldestIndex,
    });
  }

  /**
   * Replay messages from JSONL file via adapter.getMessages(), then
   * sync watcher state and send replay_complete.
   * Buffered ephemeral state is sent before replay_complete.
   */
  private async replayFromFile(
    sessionId: string,
    watched: WatchedSession,
    client: WebSocket,
    messageLimit?: number,
    pendingThinking?: string,
    subagentsSnapshot?: Map<string, SubagentEntry>,
    isCompacting?: boolean,
    contextUsage?: ContextUsage | null,
    gitDiffStat?: GitDiffStat | null,
    lastMode?: PermissionModeCommon | null,
  ): Promise<void> {
    // Helper to send buffered state + replay_complete for early-exit paths
    const finishReplay = (totalMessages = 0, oldestIndex = 0) => {
      this.sendBufferedState(client, watched, {
        pendingThinking,
        subagents: subagentsSnapshot,
        isCompacting,
        contextUsage,
        gitDiffStat,
        lastMode,
      });
      this.send(client, { type: "replay_complete", totalMessages, oldestIndex });
    };

    // No file to replay (e.g., test adapter) — just signal replay is done
    if (!watched.filePath) {
      finishReplay();
      return;
    }

    // Snapshot file size BEFORE reading so the byte offset stays aligned
    // with what _parseAllMessages actually consumed (avoids TOCTOU race).
    let preReplaySize = 0;
    try {
      const fileStat = await stat(watched.filePath);
      preReplaySize = fileStat.size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    let result: import("./providers/types.js").PaginatedMessages;
    try {
      result = await this.adapter.getMessages(sessionId, {
        limit: messageLimit,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "SessionNotFound") {
        finishReplay();
        return;
      }
      this.send(client, { type: "error", message: "failed to load message history" });
      finishReplay();
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

    // 4. Send buffered ephemeral state, then replay_complete
    finishReplay(result.totalMessages, result.oldestIndex);
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
    // Only poll sessions in poll mode
    if (watched.mode !== "poll") return;

    if (!watched.filePath) {
      // File path wasn't available at subscribe time — try to resolve now
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
      const normalized = this.adapter.normalizeFileLine(line, watched.messages.length);
      if (normalized) {
        const indexed = { ...normalized, index: watched.messages.length };
        watched.messages.push(indexed);
        this.broadcast(watched, { type: "message", message: indexed });

        // Trigger git diff after tool_result messages (file may have changed)
        if (normalized.role === "user" && normalized.parts.some((p) => p.type === "tool_result")) {
          if (watched.cwd) {
            computeGitDiffStat(watched.cwd).then((gitStat) => {
              if (gitStat) {
                this.pushEvent(sessionId, {
                  type: "git_diff_stat",
                  ...gitStat,
                } as ServerMessage);
              }
            }).catch(() => {});
          }
        }
      }
    }
  }

  /**
   * Replay buffered active subagent state to a single client.
   * Accepts a snapshot of activeSubagents taken before any awaits to avoid
   * race conditions with concurrent pushEvent() calls.
   */
  private replaySubagentState(subagentsSnapshot: ReadonlyMap<string, SubagentEntry>, client: WebSocket): void {
    for (const [toolUseId, sub] of subagentsSnapshot) {
      this.send(client, {
        type: "subagent_started",
        taskId: sub.taskId,
        toolUseId,
        description: sub.description,
        startedAt: sub.startedAt,
        ...(sub.agentType ? { agentType: sub.agentType } : {}),
      } as ServerMessage);
      for (const tc of sub.toolCalls) {
        this.send(client, {
          type: "subagent_tool_call",
          toolUseId,
          toolName: tc.toolName,
          summary: tc.summary,
        } as ServerMessage);
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
