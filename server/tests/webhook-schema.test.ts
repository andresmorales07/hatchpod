import { describe, it, expect } from "vitest";
import { WebhookSchema, CreateWebhookSchema, PatchWebhookSchema } from "../src/schemas/webhooks.js";

describe("WebhookSchema", () => {
  it("validates a complete webhook", () => {
    const result = WebhookSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Slack alerts",
      url: "https://hooks.slack.com/services/T00/B00/xxx",
      secret: "my-secret",
      events: ["session.status"],
      enabled: true,
      createdAt: "2026-03-02T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("validates webhook with template", () => {
    const result = WebhookSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Pushover",
      url: "https://api.pushover.net/1/messages.json",
      events: [],
      enabled: true,
      createdAt: "2026-03-02T00:00:00Z",
      template: {
        headers: { "Content-Type": "application/json" },
        body: "{\"token\":\"abc\",\"user\":\"xyz\",\"message\":\"{{message}}\"}",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid URL", () => {
    const result = CreateWebhookSchema.safeParse({
      name: "Bad",
      url: "not-a-url",
      events: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid event types", () => {
    const result = CreateWebhookSchema.safeParse({
      name: "Bad",
      url: "https://example.com/hook",
      events: ["invalid.event"],
    });
    expect(result.success).toBe(false);
  });

  it("PatchWebhookSchema allows partial updates", () => {
    const result = PatchWebhookSchema.safeParse({ enabled: false });
    expect(result.success).toBe(true);
  });
});
