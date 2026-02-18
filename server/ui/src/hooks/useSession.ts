import { useState, useEffect, useRef, useCallback } from "react";

interface ServerMessage {
  type: string;
  message?: unknown;
  status?: string;
  error?: string;
  toolName?: string;
  toolUseId?: string;
  input?: unknown;
}

interface SessionHook {
  messages: unknown[];
  status: string;
  connected: boolean;
  pendingApproval: { toolName: string; toolUseId: string; input: unknown } | null;
  sendPrompt: (text: string) => void;
  approve: (toolUseId: string) => void;
  deny: (toolUseId: string, message?: string) => void;
  interrupt: () => void;
}

export function useSession(sessionId: string | null, token: string): SessionHook {
  const [messages, setMessages] = useState<unknown[]>([]);
  const [status, setStatus] = useState("starting");
  const [connected, setConnected] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<SessionHook["pendingApproval"]>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();

  const connect = useCallback(() => {
    if (!sessionId || !token) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/api/sessions/${sessionId}/stream?token=${encodeURIComponent(token)}`);
    ws.onopen = () => setConnected(true);
    ws.onmessage = (event) => {
      const msg: ServerMessage = JSON.parse(event.data);
      switch (msg.type) {
        case "sdk_message": setMessages((prev) => [...prev, msg.message]); break;
        case "status": setStatus(msg.status!); break;
        case "tool_approval_request": setPendingApproval({ toolName: msg.toolName!, toolUseId: msg.toolUseId!, input: msg.input }); break;
        case "replay_complete": break;
        case "error": console.error("Server error:", msg.error ?? msg.message); break;
        case "ping": break;
      }
    };
    ws.onclose = () => { setConnected(false); reconnectTimer.current = setTimeout(connect, 2000); };
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
