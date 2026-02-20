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

describe("Slash Commands", () => {
  it("receives slash_commands event via WebSocket", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt: "[slash-commands] init", provider: "test" }),
    });
    const { id } = await createRes.json();

    // Wait for completion
    await waitForStatus(id, "completed");

    // Connect and check replay
    const ws = await connectWs(id);
    const messages = await collectMessages(ws, (m) => m.type === "replay_complete");

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

  it("includes slash commands in REST response", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt: "[slash-commands] rest", provider: "test" }),
    });
    const { id } = await createRes.json();

    const session = await waitForStatus(id, "completed") as {
      slashCommands: Array<{ name: string; description: string }>;
    };

    expect(session.slashCommands).toBeDefined();
    expect(session.slashCommands.length).toBe(2);
    expect(session.slashCommands[0].name).toBe("/test");
  });

  it("replays slash commands on reconnect", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt: "[slash-commands] reconnect", provider: "test" }),
    });
    const { id } = await createRes.json();

    await waitForStatus(id, "completed");

    // First connection
    const ws1 = await connectWs(id);
    const msgs1 = await collectMessages(ws1, (m) => m.type === "replay_complete");
    const slash1 = msgs1.find((m) => m.type === "slash_commands");
    expect(slash1).toBeDefined();
    ws1.close();

    // Second connection — should also replay
    const ws2 = await connectWs(id);
    const msgs2 = await collectMessages(ws2, (m) => m.type === "replay_complete");
    const slash2 = msgs2.find((m) => m.type === "slash_commands");
    expect(slash2).toBeDefined();
    ws2.close();
  });
});
