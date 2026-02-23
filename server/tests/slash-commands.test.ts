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

describe("Slash Commands", () => {
  it("receives slash_commands event via WebSocket during session", async () => {
    // Create idle session, connect WS, then send prompt
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test" }),
    });
    const { id } = await createRes.json();

    const ws = await connectWs(id);
    await collectMessages(ws, (m) => m.type === "replay_complete");

    ws.send(JSON.stringify({ type: "prompt", text: "[slash-commands] init" }));

    const messages = await collectMessages(ws, (m) =>
      m.type === "status" && (m as ServerMessage & { status: string }).status === "completed",
    );

    const slashMsg = messages.find((m) => m.type === "slash_commands") as ServerMessage & {
      commands: Array<{ name: string; description: string; argumentHint?: string }>;
    };
    expect(slashMsg).toBeDefined();
    expect(slashMsg.commands.length).toBe(2);
    expect(slashMsg.commands[0].name).toBe("/test");
    expect(slashMsg.commands[1].name).toBe("/help");
    expect(slashMsg.commands[1].argumentHint).toBe("[topic]");

    ws.close();
  });
});
