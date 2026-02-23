import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import { startServer, stopServer, resetSessions, api, connectWs, collectMessages, waitForStatus, getPassword } from "./helpers.js";
import type { ServerMessage } from "../src/types.js";

let port: number;

beforeAll(async () => {
  const srv = await startServer();
  port = srv.port;
  await resetSessions();
});

afterAll(async () => {
  await stopServer();
});

describe("WebSocket Flow", () => {
  it("authenticates and receives live messages via WebSocket", async () => {
    // Create idle session, connect WS, then send prompt
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test" }),
    });
    const { id } = await createRes.json();

    const ws = await connectWs(id);
    const replayMsgs = await collectMessages(ws, (msg) => msg.type === "replay_complete");

    const replayComplete = replayMsgs.find((m) => m.type === "replay_complete");
    expect(replayComplete).toBeDefined();

    // Send prompt and collect live messages
    ws.send(JSON.stringify({ type: "prompt", text: "ws test" }));

    const messages = await collectMessages(ws, (m) =>
      m.type === "status" && (m as ServerMessage & { status: string }).status === "completed",
    );

    const messageEvents = messages.filter((m) => m.type === "message");
    expect(messageEvents.length).toBeGreaterThanOrEqual(1);

    ws.close();
  });

  it("sends status events after replay_complete", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt: "status test", provider: "test" }),
    });
    const { id } = await createRes.json();

    await waitForStatus(id, "completed");

    const ws = await connectWs(id);
    const messages = await collectMessages(ws, (msg) => msg.type === "status");

    const statusMsg = messages.find((m) => m.type === "status") as ServerMessage & { status: string };
    expect(statusMsg).toBeDefined();
    expect(statusMsg.status).toBe("completed");

    ws.close();
  });

  it("multiple clients receive messages", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test" }),
    });
    const { id } = await createRes.json();

    const ws1 = await connectWs(id);
    // Start collecting on ws1 before connecting ws2
    const msgs1Promise = collectMessages(ws1, (m) => m.type === "replay_complete");

    const ws2 = await connectWs(id);
    // Collect concurrently
    const msgs2Promise = collectMessages(ws2, (m) => m.type === "replay_complete");

    const [msgs1, msgs2] = await Promise.all([msgs1Promise, msgs2Promise]);

    expect(msgs1.find((m) => m.type === "replay_complete")).toBeDefined();
    expect(msgs2.find((m) => m.type === "replay_complete")).toBeDefined();

    ws1.close();
    ws2.close();
  });

  it("rejects unauthenticated WS connections", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test" }),
    });
    const { id } = await createRes.json();

    const wsUrl = `ws://127.0.0.1:${port}/api/sessions/${id}/stream`;
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve) => {
      ws.once("open", () => {
        // Send wrong token
        ws.send(JSON.stringify({ type: "auth", token: "wrong" }));
      });
      ws.once("close", () => resolve());
    });
  });

  it("handles invalid JSON gracefully after auth", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test" }),
    });
    const { id } = await createRes.json();

    const ws = await connectWs(id);

    // Wait for replay_complete first
    await collectMessages(ws, (m) => m.type === "replay_complete");

    // Send invalid JSON
    ws.send("not json at all");

    // Should get an error message, not a disconnection
    const errorMsgs = await collectMessages(ws, (m) => m.type === "error");
    const errMsg = errorMsgs.find((m) => m.type === "error") as ServerMessage & { message: string };
    expect(errMsg).toBeDefined();
    expect(errMsg.message).toBe("invalid JSON");

    ws.close();
  });

  it("treats non-existent session as CLI/history session", async () => {
    // Non-existent sessions are treated as potential CLI sessions (read-only).
    // The server sends replay_complete + status: history without closing.
    // These may arrive in either order, so collect until we have both.
    const ws = await connectWs("00000000-0000-0000-0000-000000000000");

    let hasReplayComplete = false;
    let hasStatus = false;
    const messages = await collectMessages(ws, (m) => {
      if (m.type === "replay_complete") hasReplayComplete = true;
      if (m.type === "status") hasStatus = true;
      return hasReplayComplete && hasStatus;
    });

    const replayComplete = messages.find((m) => m.type === "replay_complete");
    expect(replayComplete).toBeDefined();

    const statusMsg = messages.find((m) => m.type === "status") as ServerMessage & { status: string; source: string };
    expect(statusMsg).toBeDefined();
    expect(statusMsg.status).toBe("history");
    expect(statusMsg.source).toBe("cli");

    // Sending a prompt should return an error (no active session)
    ws.send(JSON.stringify({ type: "prompt", text: "test" }));
    const errorMsgs = await collectMessages(ws, (m) => m.type === "error");
    const errMsg = errorMsgs.find((m) => m.type === "error") as ServerMessage & { message: string };
    expect(errMsg.message).toContain("read-only");

    ws.close();
  });

  it("returns error for unknown message type", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test" }),
    });
    const { id } = await createRes.json();

    const ws = await connectWs(id);
    await collectMessages(ws, (m) => m.type === "replay_complete");

    ws.send(JSON.stringify({ type: "nonexistent" }));

    const msgs = await collectMessages(ws, (m) => m.type === "error");
    const errMsg = msgs.find((m) => m.type === "error") as ServerMessage & { message: string };
    expect(errMsg).toBeDefined();
    expect(errMsg.message).toBe("unknown message type");

    ws.close();
  });
});
