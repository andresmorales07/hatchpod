import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, stopServer, api, rawFetch } from "./helpers.js";

describe("Webhook API", () => {
  beforeAll(async () => { await startServer(); });
  afterAll(async () => { await stopServer(); });

  let webhookId: string;

  it("POST /api/webhooks creates a webhook", async () => {
    const res = await api("/api/webhooks", {
      method: "POST",
      body: JSON.stringify({
        name: "Test hook",
        url: "https://example.com/webhook",
        events: ["session.status"],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.name).toBe("Test hook");
    expect(body.enabled).toBe(true);
    webhookId = body.id;
  });

  it("GET /api/webhooks lists webhooks", async () => {
    const res = await api("/api/webhooks");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  it("PATCH /api/webhooks/:id updates a webhook", async () => {
    const res = await api(`/api/webhooks/${webhookId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Updated hook" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Updated hook");
  });

  it("POST /api/webhooks/:id/test sends test event", async () => {
    const res = await api(`/api/webhooks/${webhookId}/test`, { method: "POST" });
    // 200 (success) or 502 (delivery failed — expected since URL is fake)
    expect([200, 502]).toContain(res.status);
  });

  it("DELETE /api/webhooks/:id removes a webhook", async () => {
    const res = await api(`/api/webhooks/${webhookId}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    const list = await api("/api/webhooks");
    const body = await list.json();
    expect(body.find((w: any) => w.id === webhookId)).toBeUndefined();
  });

  it("POST /api/webhooks rejects invalid input", async () => {
    const res = await api("/api/webhooks", {
      method: "POST",
      body: JSON.stringify({ name: "", url: "not-a-url", events: ["invalid"] }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH /api/webhooks/:id returns 404 for unknown id", async () => {
    const res = await api("/api/webhooks/00000000-0000-0000-0000-000000000000", {
      method: "PATCH",
      body: JSON.stringify({ name: "Nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /api/webhooks/:id returns 404 for unknown id", async () => {
    const res = await api("/api/webhooks/00000000-0000-0000-0000-000000000000", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("requires auth", async () => {
    const res = await rawFetch("/api/webhooks");
    expect(res.status).toBe(401);
  });
});
