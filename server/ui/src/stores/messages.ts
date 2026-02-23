import { create } from "zustand";
import { useAuthStore } from "./auth";
import { useSessionsStore } from "./sessions";
import type { NormalizedMessage, SlashCommand, TaskItem } from "../types";

type ServerMessage =
  | { type: "message"; message: NormalizedMessage }
  | { type: "tool_approval_request"; toolName: string; toolUseId: string; input: unknown }
  | { type: "status"; status: string; error?: string; source?: "api" | "cli" }
  | { type: "session_redirected"; newSessionId: string }
  | { type: "slash_commands"; commands: SlashCommand[] }
  | { type: "thinking_delta"; text: string }
  | { type: "replay_complete"; totalMessages?: number; oldestIndex?: number }
  | { type: "tasks"; tasks: Array<{ id: string; subject: string; activeForm?: string; status: string }> }
  | { type: "ping" }
  | { type: "error"; message: string; error?: string };

interface PendingApproval {
  toolName: string;
  toolUseId: string;
  input: unknown;
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
  thinkingDurations: Record<number, number>;
  lastError: string | null;

  // Pagination state
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  oldestLoadedIndex: number;
  totalMessageCount: number;

  // Server-extracted tasks (from full message scan)
  serverTasks: TaskItem[];

  connect: (sessionId: string) => void;
  disconnect: () => void;
  sendPrompt: (text: string) => boolean;
  approve: (toolUseId: string, answers?: Record<string, string>) => void;
  approveAlways: (toolUseId: string) => void;
  deny: (toolUseId: string, message?: string) => void;
  interrupt: () => void;
  loadOlderMessages: () => void;
}

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_MS = 1000;
const MESSAGE_LIMIT = 50;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempts = 0;
let thinkingStart: number | null = null;
let currentSessionId: string | null = null;
// Explicit flag to prevent connect() from wiping pre-seeded history messages
let _resuming = false;
// Set during session ID remap to prevent disconnect/connect from tearing down
// the still-valid WebSocket connection during React navigation
let _redirectingTo: string | null = null;
let _redirectTimeout: ReturnType<typeof setTimeout> | undefined;

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
  thinkingDurations: {},
  lastError: null,
  hasOlderMessages: false,
  loadingOlderMessages: false,
  oldestLoadedIndex: 0,
  totalMessageCount: 0,
  serverTasks: [],

  connect: (sessionId: string) => {
    // After a session redirect, the WebSocket is already connected to the
    // new session ID (watcher remapped it). Skip the disconnect/reconnect cycle.
    if (_redirectingTo === sessionId && ws?.readyState === WebSocket.OPEN) {
      _redirectingTo = null;
      clearTimeout(_redirectTimeout);
      return;
    }
    _redirectingTo = null;
    clearTimeout(_redirectTimeout);

    const shouldPreserve = _resuming;
    _resuming = false;
    get().disconnect();
    currentSessionId = sessionId;

    if (!shouldPreserve) {
      thinkingStart = null;
      set({
        messages: [],
        status: "starting",
        source: null,
        connected: false,
        pendingApproval: null,
        slashCommands: [],
        thinkingText: "",
        thinkingStartTime: null,
        thinkingDurations: {},
        lastError: null,
        hasOlderMessages: false,
        loadingOlderMessages: false,
        oldestLoadedIndex: 0,
        totalMessageCount: 0,
        serverTasks: [],
      });
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
      };

      socket.onmessage = (event) => {
        let msg: ServerMessage;
        try { msg = JSON.parse(event.data); } catch (err) {
          console.error("Failed to parse WebSocket message:", err);
          return;
        }

        switch (msg.type) {
          case "message": {
            const m = msg.message;
            if (m.role === "assistant" && m.parts.some((p) => p.type === "reasoning")) {
              if (thinkingStart != null) {
                const duration = Date.now() - thinkingStart;
                set((s) => ({ thinkingDurations: { ...s.thinkingDurations, [m.index]: duration } }));
              }
              thinkingStart = null;
              set({ thinkingText: "", thinkingStartTime: null });
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
            break;
          }
          case "tasks": {
            if (Array.isArray(msg.tasks)) {
              set({ serverTasks: msg.tasks as TaskItem[] });
            }
            break;
          }
          case "status":
            set({
              status: msg.status,
              ...(msg.source ? { source: msg.source } : {}),
            });
            if (msg.status !== "running") {
              thinkingStart = null;
              set({ thinkingText: "", thinkingStartTime: null });
            }
            // Re-fetch sessions on terminal states so the session list
            // picks up slug/summary from the now-finalized JSONL file.
            if (msg.status === "completed" || msg.status === "error" || msg.status === "idle") {
              useSessionsStore.getState().fetchSessions();
            }
            break;
          case "session_redirected": {
            // Server remapped our temp session ID to the real provider ID.
            // Update our reference and navigate the UI — the WebSocket is
            // already remapped by the watcher so we don't need to reconnect.
            const newId = msg.newSessionId;
            currentSessionId = newId;
            clearTimeout(_redirectTimeout);
            _redirectingTo = newId;
            // Safety: clear the redirect flag after 5s if connect() hasn't consumed it
            _redirectTimeout = setTimeout(() => {
              if (_redirectingTo === newId) _redirectingTo = null;
            }, 5000);
            const sessStore = useSessionsStore.getState();
            sessStore.setActiveSession(newId);
            sessStore.fetchSessions();
            break;
          }
          case "thinking_delta":
            set((s) => ({ thinkingText: s.thinkingText + msg.text }));
            if (thinkingStart == null) thinkingStart = Date.now();
            set({ thinkingStartTime: thinkingStart });
            break;
          case "tool_approval_request":
            set({ pendingApproval: { toolName: msg.toolName, toolUseId: msg.toolUseId, input: msg.input } });
            break;
          case "slash_commands":
            if (Array.isArray(msg.commands)) set({ slashCommands: msg.commands });
            break;
          case "error":
            console.error("Server error:", msg.message);
            set({ lastError: msg.message });
            break;
        }
      };

      socket.onclose = () => {
        ws = null;
        _redirectingTo = null;
        // Only update state if this socket belongs to the current session
        if (currentSessionId !== sessionId) return;
        set({ connected: false });
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          const delay = BASE_RECONNECT_MS * Math.pow(2, reconnectAttempts);
          reconnectAttempts++;
          set({ lastError: `Reconnecting (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…` });
          reconnectTimer = setTimeout(doConnect, delay);
        } else {
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
    if (_redirectingTo !== null) return;
    currentSessionId = null;
    clearTimeout(reconnectTimer);
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
        const olderMessages: NormalizedMessage[] = data.messages ?? [];
        const hasMore: boolean = data.hasMore ?? false;
        const oldestIndex: number = data.oldestIndex ?? 0;

        // Update server tasks if returned
        if (Array.isArray(data.tasks) && data.tasks.length > 0) {
          set({ serverTasks: data.tasks as TaskItem[] });
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
    // CLI/history sessions — resume via REST then reconnect WS
    if (state.source === "cli" && currentSessionId) {
      const { token } = useAuthStore.getState();
      const sessStore = useSessionsStore.getState();
      const cwd = sessStore.sessions.find(s => s.id === currentSessionId)?.cwd || sessStore.cwd;
      const historyMessages = [...state.messages];
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
            const session = await res.json();
            set({ source: "api" }); // Now interactive
            sessStore.setActiveSession(session.id);
            sessStore.fetchSessions();
            // Pre-seed with history messages, then connect WS for new messages
            _resuming = true;
            set({ messages: historyMessages, status: "starting" });
            currentSessionId = session.id;
            get().connect(session.id);
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
    return send({ type: "prompt", text });
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

}));
