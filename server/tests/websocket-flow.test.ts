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
  it("authenticates and receives replay + live messages", async () => {
    // Create a session that will complete quickly
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt: "ws test", provider: "test" }),
    });
    const { id } = await createRes.json();

    // Wait for completion so all messages are buffered
    await waitForStatus(id, "completed");

    // Now connect WS — should get replay
    const ws = await connectWs(id);
    const messages = await collectMessages(ws, (msg) => msg.type === "replay_complete");

    // Should have at least: message(s) + replay_complete
    const messageEvents = messages.filter((m) => m.type === "message");
    expect(messageEvents.length).toBeGreaterThanOrEqual(1);

    const replayComplete = messages.find((m) => m.type === "replay_complete");
    expect(replayComplete).toBeDefined();

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

  it("closes with error when connecting to non-existent session", async () => {
    const wsUrl = `ws://127.0.0.1:${port}/api/sessions/00000000-0000-0000-0000-000000000000/stream`;
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve) => {
      ws.once("open", () => {
        ws.send(JSON.stringify({ type: "auth", token: getPassword() }));
      });
      ws.once("close", () => resolve());
    });
    // Server should have closed the connection with "session not found"
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
