import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, stopServer, resetSessions, api, connectWs, collectMessages, waitForStatus } from "./helpers.js";
import type { ServerMessage } from "../src/types.js";

beforeAll(async () => {
  await startServer();
  await resetSessions();
});

afterAll(async () => {
  await stopServer();
});

describe("Interruption", () => {
  it("interrupts a slow session via REST DELETE", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt: "[slow] take your time", provider: "test" }),
    });
    const { id } = await createRes.json();

    // Wait briefly for it to start running
    await waitForStatus(id, "running");

    // Delete via REST (interrupts running session, then removes it from the map)
    const deleteRes = await api(`/api/sessions/${id}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(200);
    const body = await deleteRes.json();
    expect((body as { status: string }).status).toBe("deleted");

    // Verify session is gone (deleted from map → 404)
    const checkRes = await api(`/api/sessions/${id}`);
    expect(checkRes.status).toBe(404);
  });

  it("interrupts via WebSocket", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt: "[slow] ws interrupt", provider: "test" }),
    });
    const { id } = await createRes.json();

    const ws = await connectWs(id);

    // Wait for replay_complete first (session may still be running)
    await collectMessages(ws, (m) => m.type === "replay_complete");

    // Send interrupt
    ws.send(JSON.stringify({ type: "interrupt" }));

    // Wait for interrupted status
    const statusMsgs = await collectMessages(ws, (msg) =>
      msg.type === "status" && (msg as ServerMessage & { status: string }).status === "interrupted",
    );

    const interruptedStatus = statusMsgs.find(
      (m) => m.type === "status" && (m as ServerMessage & { status: string }).status === "interrupted",
    );
    expect(interruptedStatus).toBeDefined();

    ws.close();
  });

  it("returns 404 when interrupting unknown session", async () => {
    const res = await api("/api/sessions/00000000-0000-0000-0000-000000000000", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});
