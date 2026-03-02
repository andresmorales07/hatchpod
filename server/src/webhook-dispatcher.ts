import { createHmac, randomUUID } from "node:crypto";
import type { EventBus, SessionEvent } from "./event-bus.js";
import type { WebhookRegistry } from "./webhooks.js";
import type { Webhook } from "./schemas/webhooks.js";

/** Build a human-readable summary for the event. */
function buildMessage(event: SessionEvent): string {
  switch (event.type) {
    case "session.created":
      return `Session created in ${event.cwd}`;
    case "session.status":
      return event.error
        ? `Session ${event.status}: ${event.error}`
        : `Session ${event.status}`;
    case "message":
      return `New ${event.message.role} message`;
    case "ephemeral":
      return `Event: ${event.event.type}`;
  }
}

/** Map a SessionEvent to the webhook event type string for filtering. */
function eventType(event: SessionEvent): string {
  if (event.type === "ephemeral") {
    const t = event.event.type;
    if (t === "status") return "session.status";
    if (t === "tool_approval_request") return "tool.approval";
    if (t === "subagent_started") return "subagent.started";
    if (t === "subagent_completed") return "subagent.completed";
    if (t === "context_usage") return "context.usage";
    if (t === "mode_changed") return "mode.changed";
    return t;
  }
  return event.type === "message" ? "message" : event.type;
}

/**
 * Interpolate {{variable}} placeholders in a template string.
 * - String values are JSON-escaped (safe for embedding inside quoted JSON strings: "{{var}}")
 * - Non-string values (objects, arrays) are serialized as raw JSON (safe for embedding unquoted: {{var}})
 */
function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key] ?? "";
    if (typeof value === "string") {
      return JSON.stringify(value).slice(1, -1);
    }
    return JSON.stringify(value);
  });
}

export class WebhookDispatcher {
  private unsub: (() => void) | null = null;

  constructor(
    bus: EventBus,
    private readonly registry: WebhookRegistry,
    private readonly fetchFn: typeof fetch = globalThis.fetch,
  ) {
    this.unsub = bus.on((event) => this.dispatch(event));
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
  }

  /** Send a test event to a specific webhook by ID. */
  async sendTest(webhookId: string): Promise<void> {
    const webhook = await this.registry.getById(webhookId);
    if (!webhook) throw new Error(`Webhook ${webhookId} not found`);
    const testEvent: SessionEvent = {
      type: "session.status",
      sessionId: "test-" + randomUUID().slice(0, 8),
      status: "completed" as const,
    };
    await this.deliver(webhook, testEvent, "test");
  }

  private async dispatch(event: SessionEvent): Promise<void> {
    const webhooks = await this.registry.list();
    const type = eventType(event);
    for (const wh of webhooks) {
      if (!wh.enabled) continue;
      if (wh.events.length > 0 && !wh.events.includes(type as never)) continue;
      this.deliver(wh, event, type).catch((err) => {
        console.error(`[WebhookDispatcher] delivery failed for "${wh.name}":`, err);
      });
    }
  }

  private async deliver(webhook: Webhook, event: SessionEvent, type: string): Promise<void> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const deliveryId = randomUUID();

    // For ephemeral events, status/error live on the inner event, not the outer bus envelope.
    const inner = event.type === "ephemeral" ? event.event : null;
    const innerStatus = inner && "status" in inner ? String((inner as { status: string }).status) : "";
    const innerError = inner && "error" in inner && (inner as { error?: string }).error
      ? String((inner as { error: string }).error) : "";

    const vars: Record<string, unknown> = {
      event: type,
      timestamp: new Date().toISOString(),
      sessionId: "sessionId" in event ? event.sessionId : "",
      status: event.type === "session.status" ? event.status : innerStatus,
      message: buildMessage(event),
      data: event,
      error: event.type === "session.status" ? (event.error ?? "") : innerError,
    };

    let body: string;
    let headers: Record<string, string>;

    if (webhook.template) {
      body = interpolate(webhook.template.body, vars);
      headers = {
        "X-Hatchpod-Event": type,
        "X-Hatchpod-Delivery": deliveryId,
      };
      if (webhook.template.headers) {
        for (const [key, value] of Object.entries(webhook.template.headers)) {
          headers[key] = interpolate(value, vars);
        }
      }
    } else {
      body = JSON.stringify({
        event: type,
        timestamp: vars.timestamp,
        deliveryId,
        data: event,
      });
      headers = {
        "Content-Type": "application/json",
        "X-Hatchpod-Event": type,
        "X-Hatchpod-Delivery": deliveryId,
      };
    }

    if (webhook.secret) {
      const signature = createHmac("sha256", webhook.secret)
        .update(timestamp + "." + body)
        .digest("hex");
      headers["X-Hatchpod-Signature"] = `sha256=${signature}`;
      headers["X-Hatchpod-Timestamp"] = timestamp;
    }

    await this.fetchFn(webhook.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
  }
}
