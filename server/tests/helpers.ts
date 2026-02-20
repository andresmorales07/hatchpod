import type { Server } from "node:http";
import type { WebSocketServer } from "ws";
import { WebSocket } from "ws";
import type { ServerMessage } from "../src/types.js";

const TEST_PASSWORD = "test-secret";

interface TestServer {
  server: Server;
  wss: WebSocketServer;
  baseUrl: string;
  port: number;
}

let activeServer: TestServer | null = null;

export async function startServer(): Promise<TestServer> {
  if (activeServer) return activeServer;

  // Set env before importing server module
  process.env.API_PASSWORD = TEST_PASSWORD;
  process.env.NODE_ENV = "test";

  const { createApp } = await import("../src/index.js");
  const { clearSessions } = await import("../src/sessions.js");

  // Clear any leftover state from previous tests
  clearSessions();

  const { server, wss } = createApp();

  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve(addr.port);
    });
  });

  activeServer = {
    server,
    wss,
    baseUrl: `http://127.0.0.1:${port}`,
    port,
  };
  return activeServer;
}

export async function stopServer(): Promise<void> {
  if (!activeServer) return;
  const { server, wss } = activeServer;

  const { clearSessions } = await import("../src/sessions.js");
  clearSessions();

  // Close all WS clients
  for (const client of wss.clients) {
    client.terminate();
  }
  wss.close();

  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

  activeServer = null;
}

/** Clear all sessions without stopping the server. Call in beforeAll for test isolation. */
export async function resetSessions(): Promise<void> {
  const { clearSessions } = await import("../src/sessions.js");
  clearSessions();
}

export function getBaseUrl(): string {
  if (!activeServer) throw new Error("Server not started");
  return activeServer.baseUrl;
}

export function getPassword(): string {
  return TEST_PASSWORD;
}

/** HTTP fetch helper with auth header */
export async function api(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `${getBaseUrl()}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${TEST_PASSWORD}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
}

/** Raw fetch without auth header — for testing auth rejection */
export async function rawFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `${getBaseUrl()}${path}`;
  return fetch(url, options);
}

/** Connect WebSocket, send auth, return connected ws */
export async function connectWs(sessionId: string): Promise<WebSocket> {
  if (!activeServer) throw new Error("Server not started — call startServer() before connectWs()");
  const wsUrl = `ws://127.0.0.1:${activeServer.port}/api/sessions/${sessionId}/stream`;
  const ws = new WebSocket(wsUrl);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error(`WebSocket connection to ${wsUrl} timed out after 5000ms`));
    }, 5_000);
    ws.once("open", () => { clearTimeout(timeout); resolve(); });
    ws.once("error", (err) => { clearTimeout(timeout); reject(err); });
  });

  // Authenticate
  ws.send(JSON.stringify({ type: "auth", token: TEST_PASSWORD }));

  return ws;
}

/** Collect WS messages until a predicate matches */
export async function collectMessages(
  ws: WebSocket,
  predicate: (msg: ServerMessage) => boolean,
  timeoutMs = 10_000,
): Promise<ServerMessage[]> {
  const messages: ServerMessage[] = [];

  return new Promise<ServerMessage[]>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`collectMessages timed out after ${timeoutMs}ms. Collected: ${JSON.stringify(messages)}`));
    }, timeoutMs);

    function onMessage(data: Buffer | string) {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(typeof data === "string" ? data : data.toString()) as ServerMessage;
      } catch (err) {
        cleanup();
        reject(new Error(`Failed to parse WebSocket message: ${String(data).slice(0, 200)}`));
        return;
      }
      messages.push(msg);
      if (predicate(msg)) {
        cleanup();
        resolve(messages);
      }
    }

    function onClose(code: number, reason: Buffer) {
      cleanup();
      reject(new Error(
        `WebSocket closed (code=${code}, reason=${reason.toString()}) before predicate matched. ` +
        `Collected: ${JSON.stringify(messages)}`,
      ));
    }

    function onError(err: Error) {
      cleanup();
      reject(new Error(`WebSocket error before predicate matched: ${err.message}`));
    }

    function cleanup() {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
    }

    ws.on("message", onMessage);
    ws.on("close", onClose);
    ws.on("error", onError);
  });
}

/** Poll REST endpoint until session reaches target status */
export async function waitForStatus(
  sessionId: string,
  targetStatus: string | string[],
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const targets = Array.isArray(targetStatus) ? targetStatus : [targetStatus];
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const res = await api(`/api/sessions/${sessionId}`);
    const body = (await res.json()) as Record<string, unknown>;
    if (targets.includes(body.status as string)) {
      return body;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitForStatus timed out waiting for ${targets.join("|")} on session ${sessionId}`);
}
