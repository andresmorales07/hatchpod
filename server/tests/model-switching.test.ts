import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startServer, stopServer, resetSessions, api, connectWs, collectMessages } from "./helpers.js";
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

describe("set_model — idle session", () => {
  it("sends model_changed when set_model is sent to an idle/completed session", async () => {
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

    // Now send set_model on the idle/completed session
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
