import type { WebSocket } from "ws";
import { authenticateToken } from "./auth.js";
import {
  createPtySession,
  attachPtySession,
  detachPtySession,
  onPtyExit,
  writeToPty,
  resizePty,
} from "./terminal.js";

const AUTH_TIMEOUT_MS = 10_000;

type TerminalClientMessage =
  | { type: "attach"; sessionId?: string; shell?: string; cwd?: string }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

type TerminalServerMessage =
  | { type: "attached"; sessionId: string; fresh: boolean }
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number }
  | { type: "ping" }
  | { type: "error"; message: string };

function send(ws: WebSocket, msg: TerminalServerMessage): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

export function handleTerminalWsConnection(ws: WebSocket, ip: string): void {
  // First message must be { type: "auth", token: "..." } — same pattern as ws.ts
  const authTimeout = setTimeout(() => {
    send(ws, { type: "error", message: "auth timeout" });
    ws.close(4001, "auth timeout");
  }, AUTH_TIMEOUT_MS);

  ws.once("message", (data: Buffer | string) => {
    clearTimeout(authTimeout);

    let parsed: { type: string; token?: string };
    try {
      parsed = JSON.parse(typeof data === "string" ? data : data.toString());
    } catch {
      send(ws, { type: "error", message: "invalid JSON" });
      ws.close(4002, "invalid JSON");
      return;
    }

    if (parsed.type !== "auth" || !parsed.token) {
      send(ws, { type: "error", message: "unauthorized" });
      ws.close(4001, "unauthorized");
      return;
    }

    const authResult = authenticateToken(parsed.token, ip);
    if (authResult !== true) {
      const message = authResult === "rate_limited" ? "too many failed attempts" : "unauthorized";
      send(ws, { type: "error", message });
      ws.close(4001, message);
      return;
    }

    setupTerminalConnection(ws);
  });

  ws.on("close", () => clearTimeout(authTimeout));
  ws.on("error", () => clearTimeout(authTimeout));
}

function setupTerminalConnection(ws: WebSocket): void {
  let sessionId: string | null = null;
  let dataCallback: ((data: string) => void) | null = null;
  let cleanupExit: (() => void) | null = null;

  // Heartbeat — 30 s ping, same as session WS
  let isAlive = true;
  ws.on("pong", () => { isAlive = true; });

  const pingInterval = setInterval(() => {
    if (!isAlive) { ws.terminate(); return; }
    isAlive = false;
    if (ws.readyState === 1) {
      ws.ping();
      send(ws, { type: "ping" });
    }
  }, 30_000);

  ws.on("message", (raw: Buffer | string) => {
    let msg: TerminalClientMessage;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as TerminalClientMessage;
    } catch {
      send(ws, { type: "error", message: "invalid JSON" });
      return;
    }

    switch (msg.type) {
      case "attach": {
        // Detach from any existing session first
        if (sessionId !== null && dataCallback !== null) {
          detachPtySession(sessionId, dataCallback);
          cleanupExit?.();
        }

        const callback = (data: string) => send(ws, { type: "output", data });

        const requestedId = msg.sessionId;
        let attached: { outputBuffer: string[] } | null = null;
        let fresh = false;

        if (requestedId) {
          attached = attachPtySession(requestedId, callback);
          if (attached) sessionId = requestedId;
        }

        if (!attached) {
          // Create a fresh PTY session
          const shell = msg.shell ?? process.env.SHELL ?? "/bin/bash";
          const cwd = msg.cwd ?? process.env.HOME ?? "/home/hatchpod";
          sessionId = createPtySession(shell, cwd);
          attached = attachPtySession(sessionId, callback)!;
          fresh = true;
        }

        dataCallback = callback;

        // Notify client of the session ID
        send(ws, { type: "attached", sessionId: sessionId!, fresh });

        // Replay buffered output for reconnecting clients
        if (!fresh && attached.outputBuffer.length > 0) {
          send(ws, { type: "output", data: attached.outputBuffer.join("") });
        }

        // Listen for PTY exit
        cleanupExit = onPtyExit(sessionId!, (exitCode) => {
          send(ws, { type: "exit", exitCode });
          ws.close(1000, "shell exited");
        });
        break;
      }

      case "input": {
        if (!sessionId) {
          send(ws, { type: "error", message: "not attached to a session" });
          return;
        }
        if (typeof msg.data !== "string") {
          send(ws, { type: "error", message: "input data must be a string" });
          return;
        }
        writeToPty(sessionId, msg.data);
        break;
      }

      case "resize": {
        if (!sessionId) return;
        const cols = Math.max(1, Math.min(500, Math.trunc(Number(msg.cols))));
        const rows = Math.max(1, Math.min(200, Math.trunc(Number(msg.rows))));
        resizePty(sessionId, cols, rows);
        break;
      }

      default:
        send(ws, { type: "error", message: "unknown message type" });
    }
  });

  const cleanup = () => {
    clearInterval(pingInterval);
    if (sessionId !== null && dataCallback !== null) {
      detachPtySession(sessionId, dataCallback);
    }
    cleanupExit?.();
  };

  ws.on("close", cleanup);
  ws.on("error", (err) => {
    console.error("Terminal WebSocket error:", err.message);
    cleanup();
  });
}
