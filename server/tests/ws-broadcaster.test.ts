import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventBus } from "../src/event-bus.js";
import { WsBroadcaster } from "../src/ws-broadcaster.js";
import type { ServerMessage } from "../src/types.js";

/** Minimal mock WebSocket. */
function createMockWs(): any {
  const messages: unknown[] = [];
  return {
    readyState: 1,
    send: vi.fn((data: string) => messages.push(JSON.parse(data))),
    _messages: messages,
  };
}

describe("WsBroadcaster", () => {
  let bus: EventBus;
  let broadcaster: WsBroadcaster;

  beforeEach(() => {
    bus = new EventBus();
    broadcaster = new WsBroadcaster(bus);
  });

  it("delivers message events to subscribed clients", () => {
    const ws = createMockWs();
    broadcaster.addClient("s1", ws);

    bus.emit({
      type: "message",
      sessionId: "s1",
      message: { role: "assistant", parts: [{ type: "text", text: "hello" }], index: 0 },
    });

    expect(ws._messages).toHaveLength(1);
    expect(ws._messages[0]).toMatchObject({
      type: "message",
      message: { role: "assistant", parts: [{ type: "text", text: "hello" }] },
    });
  });

  it("does not deliver events to clients of other sessions", () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    broadcaster.addClient("s1", ws1);
    broadcaster.addClient("s2", ws2);

    bus.emit({
      type: "message",
      sessionId: "s1",
      message: { role: "assistant", parts: [{ type: "text", text: "for s1" }], index: 0 },
    });

    expect(ws1._messages).toHaveLength(1);
    expect(ws2._messages).toHaveLength(0);
  });

  it("removes clients on unsubscribe", () => {
    const ws = createMockWs();
    broadcaster.addClient("s1", ws);
    broadcaster.removeClient("s1", ws);

    bus.emit({
      type: "message",
      sessionId: "s1",
      message: { role: "assistant", parts: [{ type: "text", text: "hello" }], index: 0 },
    });

    expect(ws._messages).toHaveLength(0);
    expect(broadcaster.clientCount("s1")).toBe(0);
  });

  it("delivers ephemeral events to subscribed clients", () => {
    const ws = createMockWs();
    broadcaster.addClient("s1", ws);

    bus.emit({
      type: "ephemeral",
      sessionId: "s1",
      event: { type: "status", status: "running" },
    });

    expect(ws._messages).toHaveLength(1);
    expect(ws._messages[0]).toMatchObject({ type: "status", status: "running" });
  });

  it("skips closed connections and removes them", () => {
    const ws = createMockWs();
    ws.readyState = 3; // CLOSED
    broadcaster.addClient("s1", ws);

    bus.emit({
      type: "message",
      sessionId: "s1",
      message: { role: "assistant", parts: [{ type: "text", text: "hello" }], index: 0 },
    });

    expect(ws.send).not.toHaveBeenCalled();
    expect(broadcaster.clientCount("s1")).toBe(0);
  });

  it("remaps session clients", () => {
    const ws = createMockWs();
    broadcaster.addClient("old-id", ws);

    broadcaster.remapSession("old-id", "new-id");

    // Should deliver under new ID
    bus.emit({
      type: "message",
      sessionId: "new-id",
      message: { role: "assistant", parts: [{ type: "text", text: "after remap" }], index: 0 },
    });

    expect(ws._messages).toHaveLength(1);
    expect(broadcaster.clientCount("old-id")).toBe(0);
    expect(broadcaster.clientCount("new-id")).toBe(1);
  });

  it("sendToClient delivers to individual clients", () => {
    const ws = createMockWs();
    const msg: ServerMessage = { type: "replay_complete", totalMessages: 5, oldestIndex: 0 };

    broadcaster.sendToClient(ws, msg);

    expect(ws._messages).toHaveLength(1);
    expect(ws._messages[0]).toMatchObject({ type: "replay_complete", totalMessages: 5 });
  });

  it("sendToClient skips closed connections", () => {
    const ws = createMockWs();
    ws.readyState = 3; // CLOSED

    broadcaster.sendToClient(ws, { type: "ping" });

    expect(ws.send).not.toHaveBeenCalled();
  });

  it("removeClientFromAny removes client without knowing session ID", () => {
    const ws = createMockWs();
    broadcaster.addClient("s1", ws);

    broadcaster.removeClientFromAny(ws);

    expect(broadcaster.clientCount("s1")).toBe(0);

    // Should not receive events anymore
    bus.emit({
      type: "message",
      sessionId: "s1",
      message: { role: "assistant", parts: [{ type: "text", text: "hello" }], index: 0 },
    });

    expect(ws._messages).toHaveLength(0);
  });

  it("does not deliver session.created events to WS clients", () => {
    const ws = createMockWs();
    broadcaster.addClient("s1", ws);

    bus.emit({
      type: "session.created",
      sessionId: "s1",
      cwd: "/tmp",
    });

    expect(ws._messages).toHaveLength(0);
  });

  it("stop() unsubscribes from EventBus", () => {
    const ws = createMockWs();
    broadcaster.addClient("s1", ws);
    broadcaster.stop();

    bus.emit({
      type: "message",
      sessionId: "s1",
      message: { role: "assistant", parts: [{ type: "text", text: "hello" }], index: 0 },
    });

    // After stop, no events should be delivered
    expect(ws._messages).toHaveLength(0);
  });
});
