import { create } from "zustand";
import { useAuthStore } from "./auth";
import { useSessionsStore } from "./sessions";
import type { NormalizedMessage, SlashCommand } from "../types";

type ServerMessage =
  | { type: "message"; message: NormalizedMessage }
  | { type: "tool_approval_request"; toolName: string; toolUseId: string; input: unknown }
  | { type: "status"; status: string; error?: string }
  | { type: "slash_commands"; commands: SlashCommand[] }
  | { type: "thinking_delta"; text: string }
  | { type: "replay_complete" }
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
  connected: boolean;
  pendingApproval: PendingApproval | null;
  slashCommands: SlashCommand[];
  thinkingText: string;
  thinkingStartTime: number | null;
  thinkingDurations: Record<number, number>;
  lastError: string | null;
  historySessionId: string | null;
  historySessionCwd: string | null;

  connect: (sessionId: string) => void;
  disconnect: () => void;
  sendPrompt: (text: string) => boolean;
  approve: (toolUseId: string, answers?: Record<string, string>) => void;
  approveAlways: (toolUseId: string) => void;
  deny: (toolUseId: string, message?: string) => void;
  interrupt: () => void;
  loadHistory: (sessionId: string, cwd: string) => Promise<void>;
}

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_MS = 1000;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempts = 0;
let thinkingStart: number | null = null;
let messageCount = 0;
let currentSessionId: string | null = null;
// Explicit flag to prevent connect() from wiping pre-seeded history messages
let _resuming = false;

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
  connected: false,
  pendingApproval: null,
  slashCommands: [],
  thinkingText: "",
  thinkingStartTime: null,
  thinkingDurations: {},
  lastError: null,
  historySessionId: null,
  historySessionCwd: null,

  connect: (sessionId: string) => {
    const shouldPreserve = _resuming;
    _resuming = false;
    get().disconnect();
    currentSessionId = sessionId;

    if (!shouldPreserve) {
      messageCount = 0;
      thinkingStart = null;
      set({
        messages: [],
        status: "starting",
        connected: false,
        pendingApproval: null,
        slashCommands: [],
        thinkingText: "",
        thinkingStartTime: null,
        thinkingDurations: {},
        lastError: null,
        historySessionId: null,
        historySessionCwd: null,
      });
    }

    const doConnect = () => {
      if (currentSessionId !== sessionId) return;
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${location.host}/api/sessions/${sessionId}/stream`);

      socket.onopen = () => {
        const { token } = useAuthStore.getState();
        socket.send(JSON.stringify({ type: "auth", token }));
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
            const msgIdx = messageCount;
            messageCount++;
            if (m.role === "assistant" && m.parts.some((p) => p.type === "reasoning")) {
              if (thinkingStart != null) {
                const duration = Date.now() - thinkingStart;
                set((s) => ({ thinkingDurations: { ...s.thinkingDurations, [msgIdx]: duration } }));
              }
              thinkingStart = null;
              set({ thinkingText: "", thinkingStartTime: null });
            }
            set((s) => ({ messages: [...s.messages, m] }));
            break;
          }
          case "status":
            set({ status: msg.status });
            if (msg.status !== "running") {
              thinkingStart = null;
              set({ thinkingText: "", thinkingStartTime: null });
            }
            break;
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
        // Only update state if this socket belongs to the current session
        if (currentSessionId !== sessionId) return;
        set({ connected: false });
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          const delay = BASE_RECONNECT_MS * Math.pow(2, reconnectAttempts);
          reconnectAttempts++;
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
    currentSessionId = null;
    clearTimeout(reconnectTimer);
    reconnectAttempts = 0;
    ws?.close();
    ws = null;
  },

  sendPrompt: (text) => {
    const state = get();
    // History mode — resume session and send first message
    if (state.historySessionId) {
      const { token } = useAuthStore.getState();
      const sessStore = useSessionsStore.getState();
      const cwd = state.historySessionCwd || sessStore.cwd;
      const historyMessages = [...state.messages];
      const historyId = state.historySessionId;
      // Capture to detect if user navigated away before fetch completes
      const expectedSessionId = currentSessionId;

      // Clear error but keep historySessionId so retry works on failure
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
          if (currentSessionId !== expectedSessionId && currentSessionId !== null) return;
          if (res.status === 401) { useAuthStore.getState().logout(); return; }
          if (res.ok) {
            const session = await res.json();
            // Clear history state now that resume succeeded
            set({ historySessionId: null, historySessionCwd: null });
            sessStore.setActiveSession(session.id);
            sessStore.fetchSessions();
            // Pre-seed with history messages, then connect WS for new messages
            messageCount = historyMessages.length;
            _resuming = true;
            set({ messages: historyMessages, status: "starting" });
            currentSessionId = session.id;
            get().connect(session.id);
          } else {
            const errBody = await res.json().catch(() => null);
            set({ lastError: errBody?.error ?? `Failed to resume session (${res.status})` });
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
    if (send({ type: "approve", toolUseId, ...(answers ? { answers } : {}) })) {
      set({ pendingApproval: null });
    }
  },

  approveAlways: (toolUseId) => {
    if (send({ type: "approve", toolUseId, alwaysAllow: true })) {
      set({ pendingApproval: null });
    }
  },

  deny: (toolUseId, message) => {
    if (send({ type: "deny", toolUseId, message })) {
      set({ pendingApproval: null });
    }
  },

  interrupt: () => send({ type: "interrupt" }),

  loadHistory: async (sessionId: string, cwd: string) => {
    get().disconnect();
    currentSessionId = null;
    messageCount = 0;
    set({
      messages: [],
      status: "history",
      connected: false,
      pendingApproval: null,
      slashCommands: [],
      thinkingText: "",
      thinkingStartTime: null,
      thinkingDurations: {},
      lastError: null,
      historySessionId: sessionId,
      historySessionCwd: cwd,
    });
    const { token } = useAuthStore.getState();
    try {
      const res = await fetch(`/api/sessions/${sessionId}/history`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) { useAuthStore.getState().logout(); return; }
      if (res.ok) {
        const msgs = await res.json();
        if (!Array.isArray(msgs)) {
          set({ lastError: "Unexpected response from server" });
          return;
        }
        messageCount = msgs.length;
        set({ messages: msgs, status: "history" });
      } else {
        const errBody = await res.json().catch(() => null);
        set({ lastError: errBody?.error ?? `Failed to load session history (${res.status})` });
      }
    } catch (err) {
      console.error("Failed to load history:", err);
      set({ lastError: "Unable to reach server" });
    }
  },
}));
