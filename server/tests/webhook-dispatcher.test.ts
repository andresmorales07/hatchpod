// server/tests/webhook-dispatcher.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventBus } from "../src/event-bus.js";
import { WebhookRegistry } from "../src/webhooks.js";
import { WebhookDispatcher } from "../src/webhook-dispatcher.js";

describe("WebhookDispatcher", () => {
  let dir: string;
  let bus: EventBus;
  let registry: WebhookRegistry;
  let dispatcher: WebhookDispatcher;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wh-dispatch-"));
    bus = new EventBus();
    registry = new WebhookRegistry(join(dir, "webhooks.json"));
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    dispatcher = new WebhookDispatcher(bus, registry, fetchSpy as typeof fetch);
  });

  afterEach(async () => {
    dispatcher.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("dispatches to matching webhooks", async () => {
    await registry.create({ name: "All", url: "https://example.com/hook", events: [] });
    bus.emit({ type: "session.status", sessionId: "s1", status: "completed" });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://example.com/hook");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.event).toBe("session.status");
    expect(body.data.sessionId).toBe("s1");
  });

  it("skips disabled webhooks", async () => {
    const wh = await registry.create({ name: "Off", url: "https://example.com/hook", events: [] });
    await registry.update(wh.id, { enabled: false });
    bus.emit({ type: "session.status", sessionId: "s1", status: "completed" });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("filters by event type", async () => {
    await registry.create({ name: "Msg only", url: "https://example.com/hook", events: ["message"] });
    bus.emit({ type: "session.status", sessionId: "s1", status: "completed" });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses template when configured", async () => {
    await registry.create({
      name: "Pushover",
      url: "https://api.pushover.net/1/messages.json",
      events: ["session.status"],
      template: {
        headers: { "Content-Type": "application/json" },
        body: '{"token":"abc","user":"xyz","message":"{{message}}"}',
      },
    });
    bus.emit({ type: "session.status", sessionId: "s1", status: "completed" });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.token).toBe("abc");
    expect(body.message).toContain("completed");
  });

  it("includes HMAC signature when secret is set", async () => {
    await registry.create({
      name: "Signed",
      url: "https://example.com/hook",
      events: [],
      secret: "test-secret",
    });
    bus.emit({ type: "session.status", sessionId: "s1", status: "completed" });
    await new Promise((r) => setTimeout(r, 10));
    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers["X-Hatchpod-Signature"]).toMatch(/^sha256=/);
    expect(opts.headers["X-Hatchpod-Timestamp"]).toBeDefined();
  });

  it("logs errors but does not throw on fetch failure", async () => {
    fetchSpy.mockRejectedValue(new Error("network error"));
    await registry.create({ name: "Fail", url: "https://example.com/hook", events: [] });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    bus.emit({ type: "session.status", sessionId: "s1", status: "completed" });
    await new Promise((r) => setTimeout(r, 10));
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("interpolates template headers", async () => {
    await registry.create({
      name: "Ntfy",
      url: "https://ntfy.sh/my-topic",
      events: ["session.status"],
      template: {
        headers: { "Title": "Hatchpod: {{event}}", "Priority": "default" },
        body: "{{message}}",
      },
    });
    bus.emit({ type: "session.status", sessionId: "s1", status: "completed" });
    await new Promise((r) => setTimeout(r, 10));
    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers["Title"]).toBe("Hatchpod: session.status");
    expect(opts.headers["Priority"]).toBe("default");
  });

  it("escapes values containing quotes in template interpolation", async () => {
    await registry.create({
      name: "Escape test",
      url: "https://example.com/hook",
      events: ["session.status"],
      template: {
        body: '{"message":"{{message}}"}',
      },
    });
    bus.emit({ type: "session.status", sessionId: "s1", status: "error", error: 'unexpected "quote' });
    await new Promise((r) => setTimeout(r, 10));
    const [, opts] = fetchSpy.mock.calls[0];
    // Should produce valid JSON despite quotes in the error message
    expect(() => JSON.parse(opts.body)).not.toThrow();
    const body = JSON.parse(opts.body);
    expect(body.message).toContain("unexpected");
  });

  it("sendTest sends a test event to a specific webhook", async () => {
    const wh = await registry.create({ name: "Test", url: "https://example.com/hook", events: [] });
    await dispatcher.sendTest(wh.id);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.event).toBe("test");
  });
});
