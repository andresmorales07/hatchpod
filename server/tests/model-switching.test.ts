import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startServer, stopServer, resetSessions, api, connectWs, collectMessages, waitForStatus } from "./helpers.js";
import { randomUUID } from "node:crypto";
import type { ServerMessage } from "../src/types.js";

type StatusMsg = ServerMessage & { status: string };
type ModelMsg = ServerMessage & { model: string };
type ErrMsg = ServerMessage & { message: string };

const isTerminalStatus = (m: ServerMessage) =>
  m.type === "status" && ["idle", "completed", "interrupted", "error"].includes((m as StatusMsg).status);

beforeAll(async () => {
  await startServer();
});

afterAll(async () => {
  await stopServer();
});

beforeEach(async () => {
  await resetSessions();
});

describe("model_changed — from onModelResolved", () => {
  it("receives model_changed event when provider resolves the model", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test" }),
    });
    const { id } = await createRes.json() as { id: string };

    const ws = await connectWs(id);
    await collectMessages(ws, (m) => m.type === "replay_complete");

    // Send prompt with [model-changed] scenario tag — triggers onModelResolved("test-model-v1")
    ws.send(JSON.stringify({ type: "prompt", text: "[model-changed] hello" }));

    // Collect until terminal status, which comes after the model_changed event
    const messages = await collectMessages(ws, isTerminalStatus);

    const modelMsg = messages.find((m) => m.type === "model_changed") as ModelMsg | undefined;
    expect(modelMsg).toBeDefined();
    expect(modelMsg!.model).toBe("test-model-v1");

    ws.close();
  });
});

describe("set_model — completed session", () => {
  it("broadcasts model_changed after set_model on a completed session", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test" }),
    });
    const { id } = await createRes.json() as { id: string };

    const ws = await connectWs(id);
    await collectMessages(ws, (m) => m.type === "replay_complete");

    // Run a prompt to completion so the session reaches a terminal state
    ws.send(JSON.stringify({ type: "prompt", text: "hello" }));
    await collectMessages(ws, isTerminalStatus);

    // Now send set_model on the completed session
    ws.send(JSON.stringify({ type: "set_model", model: "claude-sonnet-4-6" }));

    const messages = await collectMessages(ws, (m) => m.type === "model_changed" && (m as ModelMsg).model === "claude-sonnet-4-6");
    const modelMsg = messages.find((m) => m.type === "model_changed" && (m as ModelMsg).model === "claude-sonnet-4-6") as ModelMsg;
    expect(modelMsg).toBeDefined();
    expect(modelMsg.model).toBe("claude-sonnet-4-6");

    ws.close();
  });
});

describe("set_model — no active session", () => {
  it("returns error when sent to a non-existent session", async () => {
    const fakeId = randomUUID();
    const ws = await connectWs(fakeId);

    // Wait for replay_complete (watcher subscribe will complete with empty history)
    await collectMessages(ws, (m) => m.type === "replay_complete");

    // Send set_model to a session that has no active API session
    ws.send(JSON.stringify({ type: "set_model", model: "claude-sonnet-4-6" }));

    const messages = await collectMessages(ws, (m) => m.type === "error");
    const errMsg = messages.find((m) => m.type === "error") as ErrMsg;
    expect(errMsg).toBeDefined();
    expect(errMsg.message).toMatch(/no active session/);

    ws.close();
  });
});

describe("set_model — validation", () => {
  it("returns error when model is an empty string", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test" }),
    });
    const { id } = await createRes.json() as { id: string };

    const ws = await connectWs(id);
    await collectMessages(ws, (m) => m.type === "replay_complete");

    // Run a prompt to completion so the session is active
    ws.send(JSON.stringify({ type: "prompt", text: "hello" }));
    await collectMessages(ws, isTerminalStatus);

    // Send set_model with empty string
    ws.send(JSON.stringify({ type: "set_model", model: "" }));

    const messages = await collectMessages(ws, (m) => m.type === "error");
    const errMsg = messages.find((m) => m.type === "error") as ErrMsg;
    expect(errMsg).toBeDefined();
    expect(errMsg.message).toBe("model must be a non-empty string");

    ws.close();
  });
});

describe("model push on reconnect", () => {
  it("sends model_changed to a newly connecting WS client", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test" }),
    });
    const { id } = await createRes.json() as { id: string };

    const ws1 = await connectWs(id);
    await collectMessages(ws1, (m) => m.type === "replay_complete");

    // Run a prompt to completion, then set model via set_model
    ws1.send(JSON.stringify({ type: "prompt", text: "hello" }));
    await collectMessages(ws1, isTerminalStatus);

    // Set model on the completed session — this stores session.model
    ws1.send(JSON.stringify({ type: "set_model", model: "test-model-v1" }));
    await collectMessages(ws1, (m) => m.type === "model_changed");
    ws1.close();

    // Connect a NEW WebSocket to the same session.
    // The model_changed is sent AFTER replay_complete (status + model are sent
    // synchronously after the subscribe() call which already emitted replay_complete),
    // so we collect until we see model_changed specifically.
    const ws2 = await connectWs(id);
    const messages = await collectMessages(ws2, (m) => m.type === "model_changed");

    const modelMsg = messages.find((m) => m.type === "model_changed") as ModelMsg | undefined;
    expect(modelMsg).toBeDefined();
    expect(modelMsg!.model).toBe("test-model-v1");

    ws2.close();
  });
});

describe("set_model — multi-client broadcast", () => {
  it("broadcasts model_changed to all connected clients", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test" }),
    });
    const { id } = await createRes.json() as { id: string };

    // Connect first client and run to completion
    const ws1 = await connectWs(id);
    await collectMessages(ws1, (m) => m.type === "replay_complete");

    ws1.send(JSON.stringify({ type: "prompt", text: "hello" }));
    await collectMessages(ws1, isTerminalStatus);

    // Connect second client
    const ws2 = await connectWs(id);
    await collectMessages(ws2, (m) => m.type === "replay_complete");

    // Set up collection promises for both clients BEFORE sending set_model
    const ws1Promise = collectMessages(ws1, (m) => m.type === "model_changed" && (m as ModelMsg).model === "claude-sonnet-4-6");
    const ws2Promise = collectMessages(ws2, (m) => m.type === "model_changed" && (m as ModelMsg).model === "claude-sonnet-4-6");

    // ws1 sends set_model
    ws1.send(JSON.stringify({ type: "set_model", model: "claude-sonnet-4-6" }));

    // Both clients should receive model_changed
    const [ws1Messages, ws2Messages] = await Promise.all([ws1Promise, ws2Promise]);

    const ws1ModelMsg = ws1Messages.find((m) => m.type === "model_changed") as ModelMsg;
    const ws2ModelMsg = ws2Messages.find((m) => m.type === "model_changed") as ModelMsg;
    expect(ws1ModelMsg).toBeDefined();
    expect(ws1ModelMsg.model).toBe("claude-sonnet-4-6");
    expect(ws2ModelMsg).toBeDefined();
    expect(ws2ModelMsg.model).toBe("claude-sonnet-4-6");

    ws1.close();
    ws2.close();
  });
});

describe("set_model — during running session", () => {
  it("accepts set_model while session is running", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test" }),
    });
    const { id } = await createRes.json() as { id: string };

    const ws = await connectWs(id);
    await collectMessages(ws, (m) => m.type === "replay_complete");

    // Send [slow] prompt (5 messages with 100ms delays)
    ws.send(JSON.stringify({ type: "prompt", text: "[slow] working on it" }));

    // Wait for status to become "running"
    await waitForStatus(id, "running");

    // While running, send set_model — should NOT get an error, should get model_changed
    // Set up collection: expect model_changed (no status gate blocks it)
    const modelPromise = collectMessages(ws, (m) => m.type === "model_changed" && (m as ModelMsg).model === "claude-sonnet-4-6");
    ws.send(JSON.stringify({ type: "set_model", model: "claude-sonnet-4-6" }));

    const modelMessages = await modelPromise;
    const modelMsg = modelMessages.find((m) => m.type === "model_changed") as ModelMsg;
    expect(modelMsg).toBeDefined();
    expect(modelMsg.model).toBe("claude-sonnet-4-6");

    // Wait for session to complete (don't leave it dangling)
    await collectMessages(ws, isTerminalStatus);

    ws.close();
  });
});
