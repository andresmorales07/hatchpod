import { create } from "zustand";
import { useAuthStore } from "./auth";
import { useSessionsStore } from "./sessions";
import type { NormalizedMessage, SlashCommand, ExtractedTask, ToolSummary, PermissionModeCommon } from "@shared/types";

type ServerMessage =
  | { type: "message"; message: NormalizedMessage }
  | { type: "tool_approval_request"; toolName: string; toolUseId: string; input: unknown; targetMode?: string }
  | { type: "status"; status: string; error?: string; source?: "api" | "cli" }
  | { type: "session_redirected"; newSessionId: string; fresh?: boolean }
  | { type: "mode_changed"; mode: PermissionModeCommon }
  | { type: "slash_commands"; commands: SlashCommand[] }
  | { type: "thinking_delta"; text: string }
  | { type: "replay_complete"; totalMessages?: number; oldestIndex?: number }
  | { type: "tasks"; tasks: Array<{ id: string; subject: string; activeForm?: string; status: string }> }
  | { type: "subagent_started"; taskId: string; toolUseId: string; description: string; agentType?: string; startedAt: number }
  | { type: "subagent_tool_call"; toolUseId: string; toolName: string; summary: ToolSummary }
  | { type: "subagent_completed"; taskId: string; toolUseId: string; status: "completed" | "failed" | "stopped"; summary: string }
  | { type: "compacting"; isCompacting: boolean }
  | { type: "context_usage"; inputTokens: number; contextWindow: number; percentUsed: number }
  | { type: "git_diff_stat"; files: GitFileStat[]; totalInsertions: number; totalDeletions: number; branch?: string }
  | { type: "ping" }
  | { type: "error"; message: string; error?: string };

type ContextUsage = { inputTokens: number; contextWindow: number; percentUsed: number };

interface GitFileStat {
  path: string;
  insertions: number;
  deletions: number;
  binary: boolean;
  untracked: boolean;
  staged: boolean;
}

interface GitDiffStat {
  files: GitFileStat[];
  totalInsertions: number;
  totalDeletions: number;
  branch?: string;
}

export interface SubagentState {
  taskId: string;
  description: string;
  agentType?: string;
  toolCalls: Array<{ toolName: string; summary: ToolSummary }>;
  status: "running" | "completed" | "failed" | "stopped";
  summary?: string;
  startedAt: number;
}

interface PendingApproval {
  toolName: string;
  toolUseId: string;
  input: unknown;
  targetMode?: string;
}

interface MessagesState {
  messages: NormalizedMessage[];
  status: string;
  source: "api" | "cli" | null;
  connected: boolean;
  pendingApproval: PendingApproval | null;
  slashCommands: SlashCommand[];
  thinkingText: string;
  thinkingStartTime: number | null;
  lastError: string | null;

  // Pagination state
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  oldestLoadedIndex: number;
  totalMessageCount: number;

  // Server-extracted tasks (from full message scan)
  serverTasks: ExtractedTask[];

  // Active and recently completed subagent states — keyed by toolUseId
  activeSubagents: Map<string, SubagentState>;

  // Context window state
  isCompacting: boolean;
  contextUsage: ContextUsage | null;

  // Git diff stats
  gitDiffStat: GitDiffStat | null;

  // Current permission mode
  currentMode: PermissionModeCommon | null;

  connect: (sessionId: string) => void;
  disconnect: () => void;
  sendPrompt: (text: string) => boolean;
  approve: (toolUseId: string, answers?: Record<string, string>) => void;
  approveAlways: (toolUseId: string) => void;
  deny: (toolUseId: string, message?: string) => void;
  interrupt: () => void;
  loadOlderMessages: () => void;
  setMode: (mode: PermissionModeCommon) => void;
  approvePlan: (toolUseId: string, opts: { targetMode: string; clearContext: boolean; answers?: Record<string, string> }) => void;
}

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_MS = 1000;
const MESSAGE_LIMIT = 50;
// If no message (including server pings) arrives within this window, assume connection is dead.
// Server pings every 30s, so 45s gives 1.5× tolerance for network jitter.
const HEARTBEAT_TIMEOUT_MS = 45_000;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempts = 0;
let thinkingStart: number | null = null;
let currentSessionId: string | null = null;
// Track seen message indices to deduplicate on reconnect replay
let seenIndices = new Set<number>();
// Set during session ID remap to prevent disconnect/connect from tearing down
// the still-valid WebSocket connection during React navigation
let _redirectingTo: string | null = null;
let _redirectTimeout: ReturnType<typeof setTimeout> | undefined;

function resetHeartbeat(): void {
  clearTimeout(heartbeatTimer);
  heartbeatTimer = setTimeout(() => {
    // No message received within the timeout window — connection is likely dead.
    // Closing the socket triggers onclose → reconnect logic.
    console.warn("WebSocket heartbeat timeout — closing connection");
    ws?.close();
  }, HEARTBEAT_TIMEOUT_MS);
}

function send(msg: unknown): boolean {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

export const useMessagesStore = create<MessagesState>((set, get) => ({
  messages: [],
  status: "starting",
  source: null,
  connected: false,
  pendingApproval: null,
  slashCommands: [],
  thinkingText: "",
  thinkingStartTime: null,
  lastError: null,
  hasOlderMessages: false,
  loadingOlderMessages: false,
  oldestLoadedIndex: 0,
  totalMessageCount: 0,
  serverTasks: [],
  activeSubagents: new Map(),
  isCompacting: false,
  contextUsage: null,
  gitDiffStat: null,
  currentMode: null,

  connect: (sessionId: string) => {
    // Capture remap state BEFORE clearing _redirectingTo — the guard below
    // needs it, and so does the reset-path decision further down.
    const isRemap = _redirectingTo === sessionId;
    console.debug(`[WS] connect(${sessionId.slice(0, 8)}) isRemap=${isRemap} readyState=${ws?.readyState ?? "null"} attempts=${reconnectAttempts}`);

    // After a session redirect, the WebSocket is already connected to the
    // new session ID (watcher remapped it). Skip the disconnect/reconnect cycle.
    if (isRemap && ws?.readyState === WebSocket.OPEN) {
      _redirectingTo = null;
      clearTimeout(_redirectTimeout);
      return;
    }
    _redirectingTo = null;
    clearTimeout(_redirectTimeout);

    get().disconnect();
    currentSessionId = sessionId;
    thinkingStart = null;

    if (isRemap) {
      // Socket dropped in the remap window — soft reset: preserve messages and
      // seenIndices so reconnect replay deduplicates without a blank-screen flash.
      set({ connected: false, lastError: null });
    } else {
      seenIndices = new Set();
      set({
        messages: [],
        status: "starting",
        source: null,
        connected: false,
        pendingApproval: null,
        slashCommands: [],
        thinkingText: "",
        thinkingStartTime: null,
        lastError: null,
        hasOlderMessages: false,
        loadingOlderMessages: false,
        oldestLoadedIndex: 0,
        totalMessageCount: 0,
        serverTasks: [],
        activeSubagents: new Map(),
        isCompacting: false,
        contextUsage: null,
        gitDiffStat: null,
        currentMode: null,
      });

      // Initialize currentMode from session DTO before WS events arrive
      const sessStore = useSessionsStore.getState();
      const initialSession = sessStore.sessions.find((s) => s.id === sessionId);
      if (initialSession?.permissionMode) {
        set({ currentMode: initialSession.permissionMode });
      }
    }

    const doConnect = () => {
      if (currentSessionId !== sessionId) return;
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${location.host}/api/sessions/${sessionId}/stream`);

      socket.onopen = () => {
        const { token } = useAuthStore.getState();
        socket.send(JSON.stringify({ type: "auth", token, messageLimit: MESSAGE_LIMIT }));
        set({ connected: true, lastError: null });
        reconnectAttempts = 0;
        resetHeartbeat();
      };

      socket.onmessage = (event) => {
        resetHeartbeat();
        let msg: ServerMessage;
        try { msg = JSON.parse(event.data); } catch (err) {
          console.error("Failed to parse WebSocket message:", err);
          return;
        }

        switch (msg.type) {
          case "message": {
            const m = msg.message;
            // Deduplicate by index — reconnect replays may resend messages
            if (seenIndices.has(m.index)) break;
            seenIndices.add(m.index);
            if (m.role === "assistant" && m.parts.some((p) => p.type === "reasoning")) {
              // Clear thinking TEXT but keep thinkingStartTime — the indicator
              // stays visible with "Thinking" while status is still "running".
              set({ thinkingText: "" });
            }
            set((s) => ({ messages: [...s.messages, m] }));
            break;
          }
          case "replay_complete": {
            const totalMessages = msg.totalMessages ?? 0;
            const oldestIndex = msg.oldestIndex ?? 0;
            set({
              totalMessageCount: totalMessages,
              oldestLoadedIndex: oldestIndex,
              hasOlderMessages: oldestIndex > 0,
            });
            // Fetch initial git status
            const sessStore = useSessionsStore.getState();
            const sess = sessStore.sessions.find((s) => s.id === sessionId);
            const sessionCwd = sess?.cwd;
            if (sessionCwd) {
              const { token: authToken } = useAuthStore.getState();
              fetch(`/api/git/status?cwd=${encodeURIComponent(sessionCwd)}`, {
                headers: { Authorization: `Bearer ${authToken}` },
              })
                .then(async (gitRes) => {
                  if (currentSessionId !== sessionId) return;
                  if (gitRes.ok) {
                    const gitData = await gitRes.json();
                    set({ gitDiffStat: gitData });
                  }
                })
                .catch(() => {}); // Non-critical
            }
            break;
          }
          case "tasks": {
            if (Array.isArray(msg.tasks)) {
              set({ serverTasks: msg.tasks as ExtractedTask[] });
            }
            break;
          }
          case "status": {
            const isTerminal = msg.status === "completed" || msg.status === "error"
              || msg.status === "idle" || msg.status === "interrupted"
              || msg.status === "disconnected" || msg.status === "history";
            const isRunningStatus = msg.status === "running" || msg.status === "starting";
            if (isTerminal) {
              thinkingStart = null;
              set({
                status: msg.status,
                ...(msg.source ? { source: msg.source } : {}),
                thinkingText: "",
                thinkingStartTime: null,
                activeSubagents: new Map(),
                isCompacting: false,
              });
            } else if (isRunningStatus) {
              // Entering/re-entering running state — start the processing timer.
              // This makes the thinking indicator visible for the entire "running"
              // phase, not just when thinking_delta events stream in.
              thinkingStart = Date.now();
              set({
                status: msg.status,
                ...(msg.source ? { source: msg.source } : {}),
                thinkingStartTime: thinkingStart,
                thinkingText: "",
              });
            } else {
              set({
                status: msg.status,
                ...(msg.source ? { source: msg.source } : {}),
              });
            }
            // Re-fetch sessions on terminal states so the session list
            // picks up slug/summary from the now-finalized JSONL file.
            if (msg.status === "completed" || msg.status === "error" || msg.status === "idle") {
              useSessionsStore.getState().fetchSessions();
            }
            break;
          }
          case "session_redirected": {
            const newId = msg.newSessionId;
            currentSessionId = newId;
            clearTimeout(_redirectTimeout);
            if (!msg.fresh) {
              // Session ID remap (CLI→API): WS is already connected to the new ID internally.
              // Prevent disconnect/reconnect during React navigation.
              _redirectingTo = newId;
              _redirectTimeout = setTimeout(() => {
                if (_redirectingTo === newId) _redirectingTo = null;
              }, 5000);
            }
            const sessStore = useSessionsStore.getState();
            sessStore.setActiveSession(newId);
            sessStore.fetchSessions();
            break;
          }
          case "thinking_delta":
            if (thinkingStart == null) thinkingStart = Date.now();
            set((s) => ({
              thinkingText: s.thinkingText + msg.text,
              thinkingStartTime: thinkingStart,
            }));
            break;
          case "mode_changed":
            set({ currentMode: msg.mode });
            break;
          case "tool_approval_request":
            set({ pendingApproval: {
              toolName: msg.toolName,
              toolUseId: msg.toolUseId,
              input: msg.input,
              ...(msg.targetMode ? { targetMode: msg.targetMode } : {}),
            }});
            break;
          case "slash_commands":
            if (Array.isArray(msg.commands)) set({ slashCommands: msg.commands });
            break;
          case "subagent_started":
            set((s) => {
              const map = new Map(s.activeSubagents);
              map.set(msg.toolUseId, {
                taskId: msg.taskId,
                description: msg.description,
                agentType: msg.agentType,
                toolCalls: [],
                status: "running",
                startedAt: msg.startedAt,
              });
              return { activeSubagents: map };
            });
            break;
          case "subagent_tool_call":
            set((s) => {
              const map = new Map(s.activeSubagents);
              const entry = map.get(msg.toolUseId);
              if (entry) {
                map.set(msg.toolUseId, {
                  ...entry,
                  toolCalls: [...entry.toolCalls, { toolName: msg.toolName, summary: msg.summary }],
                });
              } else {
                console.warn(`subagent_tool_call for unknown toolUseId "${msg.toolUseId}" — possible ordering issue`);
              }
              return { activeSubagents: map };
            });
            break;
          case "subagent_completed":
            set((s) => {
              const map = new Map(s.activeSubagents);
              const entry = map.get(msg.toolUseId);
              if (entry) {
                map.set(msg.toolUseId, {
                  ...entry,
                  status: msg.status,
                  summary: msg.summary,
                });
              } else {
                console.warn(`subagent_completed for unknown toolUseId "${msg.toolUseId}" — possible ordering issue`);
              }
              return { activeSubagents: map };
            });
            break;
          case "compacting": {
            const currentStatus = get().status;
            const isTerminalStatus = currentStatus === "completed" || currentStatus === "error"
              || currentStatus === "interrupted" || currentStatus === "history";
            if (!isTerminalStatus) {
              set({ isCompacting: msg.isCompacting });
            }
            break;
          }
          case "context_usage":
            set({ contextUsage: { inputTokens: msg.inputTokens, contextWindow: msg.contextWindow, percentUsed: msg.percentUsed } });
            break;
          case "git_diff_stat":
            set({
              gitDiffStat: {
                files: msg.files,
                totalInsertions: msg.totalInsertions,
                totalDeletions: msg.totalDeletions,
                ...(msg.branch !== undefined ? { branch: msg.branch } : {}),
              },
            });
            break;
          case "error":
            console.error("Server error:", msg.message);
            set({ lastError: msg.message });
            break;
        }
      };

      socket.onclose = () => {
        // Capture whether this was the active socket BEFORE nulling ws.
        // After a session remap, connect() returns early without replacing ws,
        // so the remapped socket is still the active one even though its closure
        // sessionId is now stale (old pre-remap ID).
        const wasActive = ws === socket;
        ws = null;
        // Preserve the remap guard if the socket closed while we are still
        // navigating to the remapped session. The upcoming connect() call uses
        // _redirectingTo to choose the soft-reset path (no message wipe).
        if (_redirectingTo !== currentSessionId) {
          _redirectingTo = null;
        }
        clearTimeout(heartbeatTimer);
        // Stale socket (already replaced by a newer connect()) — ignore.
        if (!wasActive) return;
        set({ connected: false });
        // Determine which session ID to reconnect to. After a session remap the
        // closure's sessionId is the old temp UUID; currentSessionId is the real one.
        const reconnectId = currentSessionId;
        console.warn(`[WS] onclose: closureId=${sessionId.slice(0, 8)} reconnectId=${reconnectId?.slice(0, 8) ?? "null"} attempts=${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} _redirectingTo=${_redirectingTo?.slice(0, 8) ?? "null"}`);
        if (!reconnectId) return; // Navigated away entirely — no reconnect needed.
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          const delay = BASE_RECONNECT_MS * Math.pow(2, reconnectAttempts);
          reconnectAttempts++;
          set({ lastError: `Reconnecting (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…` });
          if (reconnectId === sessionId) {
            // Same session ID — reuse doConnect() (avoids state reset).
            reconnectTimer = setTimeout(doConnect, delay);
          } else {
            // Session was remapped — must reconnect under the new ID.
            reconnectTimer = setTimeout(() => {
              if (currentSessionId === reconnectId) get().connect(reconnectId);
            }, delay);
          }
        } else {
          console.error(`[WS] max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached for ${reconnectId.slice(0, 8)}`);
          set({ status: "disconnected", lastError: "Connection lost — reload to reconnect" });
        }
      };

      socket.onerror = (ev) => {
        console.error("WebSocket error:", ev);
        socket.close();
      };
      ws = socket;
    };

    doConnect();
  },

  disconnect: () => {
    // During a session redirect, the WebSocket is still valid (watcher remapped it).
    // Skip teardown so the connection survives React's effect cleanup cycle.
    if (_redirectingTo !== null) {
      console.debug(`[WS] disconnect() skipped — redirecting to ${_redirectingTo.slice(0, 8)}`);
      return;
    }
    currentSessionId = null;
    clearTimeout(reconnectTimer);
    clearTimeout(heartbeatTimer);
    reconnectAttempts = 0;
    ws?.close();
    ws = null;
  },

  loadOlderMessages: () => {
    const state = get();
    if (state.loadingOlderMessages || !state.hasOlderMessages || !currentSessionId) return;

    set({ loadingOlderMessages: true });
    const { token } = useAuthStore.getState();
    const sessionId = currentSessionId;

    fetch(`/api/sessions/${sessionId}/messages?before=${state.oldestLoadedIndex}&limit=30`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (currentSessionId !== sessionId) return; // User navigated away
        if (res.status === 401) { useAuthStore.getState().logout(); return; }
        if (!res.ok) {
          set({ loadingOlderMessages: false });
          return;
        }
        const data = await res.json();
        const olderMessages: NormalizedMessage[] = (data.messages ?? []).filter(
          (m: NormalizedMessage) => !seenIndices.has(m.index),
        );
        for (const m of olderMessages) seenIndices.add(m.index);
        const hasMore: boolean = data.hasMore ?? false;
        const oldestIndex: number = data.oldestIndex ?? 0;

        // Update server tasks if returned
        if (Array.isArray(data.tasks) && data.tasks.length > 0) {
          set({ serverTasks: data.tasks as ExtractedTask[] });
        }

        set((s) => ({
          messages: [...olderMessages, ...s.messages],
          hasOlderMessages: hasMore,
          oldestLoadedIndex: oldestIndex,
          loadingOlderMessages: false,
        }));
      })
      .catch((err) => {
        console.error("Failed to load older messages:", err);
        set({ loadingOlderMessages: false });
      });
  },

  sendPrompt: (text) => {
    const state = get();
    // CLI/history sessions — resume via REST, server switches watcher to push mode
    if (state.source === "cli" && currentSessionId) {
      const { token } = useAuthStore.getState();
      const sessStore = useSessionsStore.getState();
      const cwd = sessStore.sessions.find(s => s.id === currentSessionId)?.cwd || sessStore.cwd;
      const historyId = currentSessionId;
      const expectedSessionId = currentSessionId;

      set({ lastError: null });

      fetch("/api/sessions", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          resumeSessionId: historyId,
          prompt: text,
          cwd,
          provider: "claude",
        }),
      })
        .then(async (res) => {
          // Stale closure guard: user switched sessions while fetch was in-flight
          if (currentSessionId !== expectedSessionId && currentSessionId !== null) {
            // Clean up the orphaned session so it doesn't linger on the server
            if (res.ok) {
              const orphan = await res.json().catch(() => null);
              if (orphan?.id) {
                fetch(`/api/sessions/${orphan.id}`, {
                  method: "DELETE",
                  headers: { Authorization: `Bearer ${token}` },
                }).catch(() => {});
              }
            }
            return;
          }
          if (res.status === 401) { useAuthStore.getState().logout(); return; }
          if (res.ok) {
            // Server creates the session with the same ID (resumeSessionId),
            // switches the watcher to push mode, and pushes messages through
            // the existing WS subscription. Just update source to interactive.
            set({ source: "api" });
            sessStore.fetchSessions();
          } else {
            const errBody = await res.json().catch(() => null);
            set({ lastError: errBody?.error ?? `Failed to resume session (${res.status})`, status: "error" });
          }
        })
        .catch((err) => {
          console.error("Failed to resume session:", err);
          set({ lastError: "Unable to reach server" });
        });

      return true;
    }

    // Normal mode — send via WebSocket
    set({ lastError: null });
    const sent = send({ type: "prompt", text });
    if (!sent) {
      console.warn(`[WS] sendPrompt failed: readyState=${ws?.readyState ?? "null"} currentSessionId=${currentSessionId?.slice(0, 8) ?? "null"}`);
    }
    return sent;
  },

  approve: (toolUseId, answers) => {
    if (!send({ type: "approve", toolUseId, ...(answers ? { answers } : {}) })) {
      set({ lastError: "Failed to send approval — not connected" });
      return;
    }
    set({ pendingApproval: null });
  },

  approveAlways: (toolUseId) => {
    if (!send({ type: "approve", toolUseId, alwaysAllow: true })) {
      set({ lastError: "Failed to send approval — not connected" });
      return;
    }
    set({ pendingApproval: null });
  },

  deny: (toolUseId, message) => {
    if (!send({ type: "deny", toolUseId, message })) {
      set({ lastError: "Failed to send denial — not connected" });
      return;
    }
    set({ pendingApproval: null });
  },

  interrupt: () => send({ type: "interrupt" }),

  setMode: (mode: PermissionModeCommon) => {
    if (!send({ type: "set_mode", mode })) {
      set({ lastError: "Failed to set mode — not connected" });
      return;
    }
    set({ currentMode: mode }); // optimistic update
  },

  approvePlan: (toolUseId, { targetMode, clearContext, answers }) => {
    if (!send({ type: "approve", toolUseId, targetMode, clearContext, ...(answers ? { answers } : {}) })) {
      set({ lastError: "Failed to send approval — not connected" });
      return;
    }
    set({ pendingApproval: null });
  },

}));
