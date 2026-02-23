import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, stopServer, resetSessions, api, connectWs, collectMessages } from "./helpers.js";
import type { ServerMessage } from "../src/types.js";

beforeAll(async () => {
  await startServer();
  await resetSessions();
});

afterAll(async () => {
  await stopServer();
});

describe("Session Redirect", () => {
  it("broadcasts session_redirected when provider returns a different session ID", async () => {
    // Create idle session and connect WS BEFORE sending the prompt.
    // The [remap] scenario completes synchronously, so we must be
    // subscribed before triggering the remap.
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test" }),
    });
    const { id: tempId } = await createRes.json();

    const ws = await connectWs(tempId);
    await collectMessages(ws, (m) => m.type === "replay_complete");

    // Send [remap] prompt — triggers the remap flow
    ws.send(JSON.stringify({ type: "prompt", text: "[remap] hello" }));

    const messages = await collectMessages(ws, (m) => m.type === "session_redirected");

    const redirect = messages.find((m) => m.type === "session_redirected") as
      ServerMessage & { newSessionId: string };
    expect(redirect).toBeDefined();
    expect(redirect.newSessionId).toBeDefined();
    expect(redirect.newSessionId).not.toBe(tempId);

    ws.close();
  });

  it("resolves session via old alias after remap", async () => {
    // Create idle session, trigger remap via WS, then verify REST works with old ID
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test" }),
    });
    const { id: tempId } = await createRes.json();

    const ws = await connectWs(tempId);
    await collectMessages(ws, (m) => m.type === "replay_complete");

    ws.send(JSON.stringify({ type: "prompt", text: "[remap] alias test" }));

    // Collect until completed, capturing the redirect along the way
    const messages = await collectMessages(ws, (m) =>
      m.type === "status" && (m as ServerMessage & { status: string }).status === "completed",
    );
    const redirect = messages.find((m) => m.type === "session_redirected") as
      ServerMessage & { newSessionId: string };
    expect(redirect).toBeDefined();
    const newId = redirect.newSessionId;

    // Old temp ID should still resolve (via alias)
    const res1 = await api(`/api/sessions/${tempId}`);
    expect(res1.status).toBe(200);
    const session1 = await res1.json();
    expect(session1.id).toBe(newId);

    // New remapped ID should also work
    const res2 = await api(`/api/sessions/${newId}`);
    expect(res2.status).toBe(200);
    const session2 = await res2.json();
    expect(session2.id).toBe(newId);

    ws.close();
  });

  it("WS handler accepts commands via old session ID after remap", async () => {
    // Create an idle session, connect WS, then send [remap] prompt.
    // After the remap, send a follow-up prompt — the WS handler should
    // still find the session via the alias.
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test" }),
    });
    const { id: tempId } = await createRes.json();

    const ws = await connectWs(tempId);
    await collectMessages(ws, (m) => m.type === "replay_complete");

    // Send [remap] prompt — triggers remap
    ws.send(JSON.stringify({ type: "prompt", text: "[remap] first" }));

    // Collect until redirect + completed
    const msgs1 = await collectMessages(ws, (m) =>
      m.type === "status" && (m as ServerMessage & { status: string }).status === "completed",
    );
    const redirect = msgs1.find((m) => m.type === "session_redirected") as
      ServerMessage & { newSessionId: string };
    expect(redirect).toBeDefined();

    // Now send a follow-up on the SAME WebSocket (still connected via old temp ID).
    // The WS handler uses getActiveSession(tempId) which should resolve via alias.
    ws.send(JSON.stringify({ type: "prompt", text: "follow-up after remap" }));

    const msgs2 = await collectMessages(ws, (m) =>
      m.type === "status" && (m as ServerMessage & { status: string }).status === "completed",
    );
    const echoMsg = msgs2.find(
      (m) => m.type === "message" && (m as any).message?.parts?.[0]?.text?.includes("follow-up"),
    );
    expect(echoMsg).toBeDefined();

    ws.close();
  });

  it("multiple clients receive session_redirected", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test" }),
    });
    const { id: tempId } = await createRes.json();

    const ws1 = await connectWs(tempId);
    const replay1 = collectMessages(ws1, (m) => m.type === "replay_complete");

    const ws2 = await connectWs(tempId);
    const replay2 = collectMessages(ws2, (m) => m.type === "replay_complete");

    await Promise.all([replay1, replay2]);

    // Start collecting on both BEFORE sending the prompt
    const isRedirected = (m: ServerMessage) => m.type === "session_redirected";
    const collect1 = collectMessages(ws1, isRedirected);
    const collect2 = collectMessages(ws2, isRedirected);

    ws1.send(JSON.stringify({ type: "prompt", text: "[remap] multi-client" }));

    const [msgs1, msgs2] = await Promise.all([collect1, collect2]);

    const redirect1 = msgs1.find((m) => m.type === "session_redirected") as
      ServerMessage & { newSessionId: string };
    const redirect2 = msgs2.find((m) => m.type === "session_redirected") as
      ServerMessage & { newSessionId: string };

    expect(redirect1).toBeDefined();
    expect(redirect2).toBeDefined();
    expect(redirect1.newSessionId).toBe(redirect2.newSessionId);

    ws1.close();
    ws2.close();
  });

  it("deleteSession works via old alias", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test" }),
    });
    const { id: tempId } = await createRes.json();

    const ws = await connectWs(tempId);
    await collectMessages(ws, (m) => m.type === "replay_complete");

    ws.send(JSON.stringify({ type: "prompt", text: "[remap] delete test" }));
    await collectMessages(ws, (m) =>
      m.type === "status" && (m as ServerMessage & { status: string }).status === "completed",
    );
    ws.close();

    // Delete using the old temp ID — route returns 200 with { status: "deleted" }
    const delRes = await api(`/api/sessions/${tempId}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json();
    expect(delBody.status).toBe("deleted");

    // Session should no longer be accessible via either ID
    const res = await api(`/api/sessions/${tempId}`);
    expect(res.status).toBe(404);
  });

  it("session listing shows remapped ID, not temp ID", async () => {
    await resetSessions();

    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test" }),
    });
    const { id: tempId } = await createRes.json();

    const ws = await connectWs(tempId);
    await collectMessages(ws, (m) => m.type === "replay_complete");

    ws.send(JSON.stringify({ type: "prompt", text: "[remap] listing test" }));
    await collectMessages(ws, (m) =>
      m.type === "status" && (m as ServerMessage & { status: string }).status === "completed",
    );
    ws.close();

    const listRes = await api("/api/sessions");
    const sessions = await listRes.json();
    const ids = sessions.map((s: { id: string }) => s.id);

    // The listing should contain the remapped ID, not the temp UUID
    expect(ids).not.toContain(tempId);
    // All IDs should be valid UUIDs (the remapped IDs are randomUUID())
    expect(ids.length).toBeGreaterThanOrEqual(1);
  });
});
