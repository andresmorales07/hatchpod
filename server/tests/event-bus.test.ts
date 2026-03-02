import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../src/event-bus.js";

describe("EventBus", () => {
  it("delivers events to listeners", () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.on(listener);
    bus.emit({ type: "session.status", sessionId: "s1", status: "running" });
    expect(listener).toHaveBeenCalledWith({
      type: "session.status",
      sessionId: "s1",
      status: "running",
    });
  });

  it("returns unsubscribe function", () => {
    const bus = new EventBus();
    const listener = vi.fn();
    const unsub = bus.on(listener);
    unsub();
    bus.emit({ type: "session.status", sessionId: "s1", status: "running" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not throw when listener throws", () => {
    const bus = new EventBus();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    bus.on(() => { throw new Error("boom"); });
    const good = vi.fn();
    bus.on(good);
    expect(() =>
      bus.emit({ type: "session.status", sessionId: "s1", status: "running" })
    ).not.toThrow();
    expect(good).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  it("logs async listener rejections without crashing", async () => {
    const bus = new EventBus();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    bus.on(async () => { throw new Error("async boom"); });
    bus.emit({ type: "session.status", sessionId: "s1", status: "running" });
    await new Promise((r) => setTimeout(r, 10));
    expect(errorSpy).toHaveBeenCalledWith(
      "[EventBus] async listener error:",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it("handles async listeners without blocking", () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.on(async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push("async");
    });
    bus.emit({ type: "session.status", sessionId: "s1", status: "running" });
    order.push("after-emit");
    expect(order).toEqual(["after-emit"]);
  });
});
