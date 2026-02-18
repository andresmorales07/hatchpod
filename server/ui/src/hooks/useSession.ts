import { useState, useEffect, useRef, useCallback } from "react";
import type { NormalizedMessage } from "../types";

type ServerMessage =
  | { type: "message"; message: NormalizedMessage }
  | { type: "tool_approval_request"; toolName: string; toolUseId: string; input: unknown }
  | { type: "status"; status: string; error?: string }
  | { type: "replay_complete" }
  | { type: "ping" }
  | { type: "error"; message: string; error?: string };

interface SessionHook {
  messages: NormalizedMessage[];
  status: string;
  connected: boolean;
  pendingApproval: { toolName: string; toolUseId: string; input: unknown } | null;
  sendPrompt: (text: string) => void;
  approve: (toolUseId: string) => void;
  deny: (toolUseId: string, message?: string) => void;
  interrupt: () => void;
}

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_MS = 1000;

export function useSession(sessionId: string | null, token: string): SessionHook {
  const [messages, setMessages] = useState<NormalizedMessage[]>([]);
  const [status, setStatus] = useState("starting");
  const [connected, setConnected] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<SessionHook["pendingApproval"]>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reconnectAttempts = useRef(0);

  const connect = useCallback(() => {
    if (!sessionId || !token) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/api/sessions/${sessionId}/stream`);
    ws.onopen = () => {
      // Authenticate via first message (avoids token in URL / logs)
      ws.send(JSON.stringify({ type: "auth", token }));
      setConnected(true);
      reconnectAttempts.current = 0;
    };
    ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data);
      } catch {
        console.error("Malformed WebSocket message:", event.data);
        return;
      }
      switch (msg.type) {
        case "message": setMessages((prev) => [...prev, msg.message]); break;
        case "status": setStatus(msg.status); break;
        case "tool_approval_request": setPendingApproval({ toolName: msg.toolName, toolUseId: msg.toolUseId, input: msg.input }); break;
        case "replay_complete": break;
        case "error": console.error("Server error:", msg.message); break;
        case "ping": break;
      }
    };
    ws.onclose = () => {
      setConnected(false);
      if (reconnectAttempts.current < MAX_RECONNECT_ATTEMPTS) {
        const delay = BASE_RECONNECT_MS * Math.pow(2, reconnectAttempts.current);
        reconnectAttempts.current++;
        reconnectTimer.current = setTimeout(connect, delay);
      }
    };
    ws.onerror = () => ws.close();
    wsRef.current = ws;
  }, [sessionId, token]);

  useEffect(() => {
    setMessages([]); setStatus("starting"); setPendingApproval(null);
    connect();
    return () => { clearTimeout(reconnectTimer.current); wsRef.current?.close(); };
  }, [connect]);

  const send = useCallback((msg: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(msg));
  }, []);

  return {
    messages, status, connected, pendingApproval,
    sendPrompt: (text: string) => send({ type: "prompt", text }),
    approve: (toolUseId: string) => { send({ type: "approve", toolUseId }); setPendingApproval(null); },
    deny: (toolUseId: string, message?: string) => { send({ type: "deny", toolUseId, message }); setPendingApproval(null); },
    interrupt: () => send({ type: "interrupt" }),
  };
}
