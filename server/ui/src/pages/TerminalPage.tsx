import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useAuthStore } from "@/stores/auth";
import { useSettingsStore } from "@/stores/settings";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

type ConnectionStatus = "connecting" | "attached" | "disconnected" | "error";

const STATUS_COLOR: Record<ConnectionStatus, string> = {
  connecting: "bg-yellow-400 animate-pulse",
  attached: "bg-green-400",
  disconnected: "bg-zinc-500",
  error: "bg-red-400",
};

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  attached: "Connected",
  disconnected: "Disconnected",
  error: "Error",
};

// xterm.js theme matching the Hatchpod dark palette from globals.css
const XTERM_THEME = {
  background: "#0f0f17",
  foreground: "#fafafa",
  cursor: "#e94560",
  cursorAccent: "#0f0f17",
  black: "#18181b",
  red: "#e94560",
  green: "#4ade80",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#a78bfa",
  cyan: "#34d399",
  white: "#fafafa",
  brightBlack: "#27272a",
  brightRed: "#f87171",
  brightGreen: "#86efac",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#c4b5fd",
  brightCyan: "#6ee7b7",
  brightWhite: "#ffffff",
};

export function TerminalPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [sessionId, setSessionId] = useState<string | null>(null);

  const token = useAuthStore((s) => s.token);
  const { terminalFontSize, terminalScrollback, terminalShell } = useSettingsStore();

  const resetWatchdog = useCallback((ws: WebSocket) => {
    clearTimeout(watchdogTimerRef.current ?? undefined);
    watchdogTimerRef.current = setTimeout(() => {
      if (mountedRef.current) ws.close();
    }, 45_000);
  }, []);

  const connectWs = useCallback((reattachId: string | null) => {
    if (!mountedRef.current) return;

    // Close any existing connection without triggering auto-reconnect
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    const wsUrl = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/terminal/stream`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    setStatus("connecting");

    ws.onopen = () => {
      // Step 1: auth
      ws.send(JSON.stringify({ type: "auth", token }));
      // Step 2: attach (sent immediately — server's once("message") handles auth
      // synchronously before processing subsequent messages)
      ws.send(JSON.stringify({
        type: "attach",
        ...(reattachId ? { sessionId: reattachId } : { shell: terminalShell }),
      }));
      resetWatchdog(ws);
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      const msg = JSON.parse(event.data as string) as Record<string, unknown>;
      resetWatchdog(ws);

      switch (msg.type) {
        case "attached": {
          const id = msg.sessionId as string;
          const fresh = msg.fresh as boolean;
          sessionIdRef.current = id;
          setSessionId(id);
          setStatus("attached");
          // Send initial dimensions
          if (fitRef.current && ws.readyState === 1) {
            const dims = fitRef.current.proposeDimensions();
            if (dims) {
              ws.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
            }
          }
          if (fresh) {
            termRef.current?.clear();
          }
          break;
        }
        case "output":
          termRef.current?.write(msg.data as string);
          break;
        case "exit":
          setStatus("disconnected");
          termRef.current?.writeln(`\r\n\x1b[33m[shell exited with code ${msg.exitCode as number}]\x1b[0m`);
          break;
        case "error":
          setStatus("error");
          termRef.current?.writeln(`\r\n\x1b[31m[error: ${msg.message as string}]\x1b[0m`);
          break;
        case "ping":
          // watchdog already reset above
          break;
      }
    };

    ws.onerror = () => {
      if (mountedRef.current) setStatus("error");
    };

    ws.onclose = () => {
      clearTimeout(watchdogTimerRef.current ?? undefined);
      if (!mountedRef.current) return;
      setStatus("disconnected");
      reconnectTimerRef.current = setTimeout(() => {
        connectWs(sessionIdRef.current);
      }, 2_000);
    };
  }, [token, terminalShell, resetWatchdog]);

  // Initialize terminal once on mount
  useEffect(() => {
    if (!containerRef.current) return;
    mountedRef.current = true;

    const term = new Terminal({
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", monospace',
      fontSize: terminalFontSize,
      scrollback: terminalScrollback,
      cursorBlink: true,
      allowTransparency: false,
      theme: XTERM_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    // Send keyboard input to PTY
    const inputDisposable = term.onData((data) => {
      if (wsRef.current?.readyState === 1) {
        wsRef.current.send(JSON.stringify({ type: "input", data }));
      }
    });

    // Resize terminal when container changes size
    const observer = new ResizeObserver(() => {
      if (!fitRef.current) return;
      fitRef.current.fit();
      const dims = fitRef.current.proposeDimensions();
      if (dims && wsRef.current?.readyState === 1) {
        wsRef.current.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
      }
    });
    observer.observe(containerRef.current);

    connectWs(null);

    return () => {
      mountedRef.current = false;
      inputDisposable.dispose();
      observer.disconnect();
      clearTimeout(reconnectTimerRef.current ?? undefined);
      clearTimeout(watchdogTimerRef.current ?? undefined);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live-update font size when settings change
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = terminalFontSize;
      fitRef.current?.fit();
    }
  }, [terminalFontSize]);

  // Live-update scrollback when settings change
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.scrollback = terminalScrollback;
    }
  }, [terminalScrollback]);

  const handleNewSession = () => {
    sessionIdRef.current = null;
    setSessionId(null);
    connectWs(null);
  };

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-card shrink-0">
        <div className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLOR[status]}`} />
        <span className="text-xs font-medium text-muted-foreground">{STATUS_LABEL[status]}</span>
        {sessionId && (
          <>
            <span className="text-muted-foreground/40 text-xs">·</span>
            <span className="text-xs text-muted-foreground font-mono truncate max-w-[200px]">
              {sessionId}
            </span>
          </>
        )}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs gap-1.5"
          onClick={handleNewSession}
          title="Open a new shell session"
        >
          <Plus className="size-3" />
          New Session
        </Button>
      </div>

      {/* Terminal container */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-hidden"
        style={{ padding: "8px" }}
      />
    </div>
  );
}
