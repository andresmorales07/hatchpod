# Webhook Notifications Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add webhook notification support with an EventBus architecture, dedicated webhook registry with CRUD API, payload templates, and a Settings UI for managing webhooks.

**Architecture:** EventBus decouples event emission from consumer delivery. SessionWatcher emits typed events on the bus; WsBroadcaster (extracted from SessionWatcher) and WebhookDispatcher are independent consumers. Webhook config is stored in `~/.config/hatchpod/webhooks.json` with full CRUD REST API.

**Tech Stack:** TypeScript, Zod (schemas), Zustand (UI state), Node.js crypto (HMAC-SHA256), native fetch (HTTP dispatch), Vitest (testing), React + shadcn/ui (webhook management UI)

**Design doc:** `docs/plans/2026-03-02-webhook-notifications-design.md`

---

### Task 1: EventBus Core

**Files:**
- Create: `server/src/event-bus.ts`
- Test: `server/tests/event-bus.test.ts`

**Step 1: Write the failing test**

```typescript
// server/tests/event-bus.test.ts
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
    bus.on(() => { throw new Error("boom"); });
    const good = vi.fn();
    bus.on(good);
    expect(() =>
      bus.emit({ type: "session.status", sessionId: "s1", status: "running" })
    ).not.toThrow();
    expect(good).toHaveBeenCalled();
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
```

**Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/event-bus.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// server/src/event-bus.ts
import type { SessionStatus } from "./schemas/sessions.js";
import type { NormalizedMessage, ToolSummary, PermissionModeCommon } from "./providers/types.js";
import type { ServerMessage, ContextUsage } from "./types.js";

/** Typed events emitted through the bus. */
export type SessionEvent =
  | { type: "session.created"; sessionId: string; cwd: string; model?: string }
  | { type: "session.status"; sessionId: string; status: SessionStatus; error?: string }
  | { type: "message"; sessionId: string; message: NormalizedMessage }
  | { type: "ephemeral"; sessionId: string; event: ServerMessage };

export type EventListener = (event: SessionEvent) => void | Promise<void>;

export class EventBus {
  private listeners = new Set<EventListener>();

  /** Register a listener. Returns an unsubscribe function. */
  on(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Emit an event to all listeners. Synchronous — async listeners are fire-and-forget. */
  emit(event: SessionEvent): void {
    for (const listener of this.listeners) {
      try {
        const result = listener(event);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch((err) => {
            console.error("[EventBus] async listener error:", err);
          });
        }
      } catch (err) {
        console.error("[EventBus] listener error:", err);
      }
    }
  }
}

/** Singleton event bus instance for the server process. */
export const eventBus = new EventBus();
```

**Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/event-bus.test.ts`
Expected: 4 tests PASS

**Step 5: Commit**

```bash
git add server/src/event-bus.ts server/tests/event-bus.test.ts
git commit -m "feat: add typed EventBus for decoupled event delivery"
```

---

### Task 2: Webhook Zod Schema

**Files:**
- Create: `server/src/schemas/webhooks.ts`
- Modify: `server/src/schemas/index.ts` (add re-exports)
- Test: `server/tests/webhook-schema.test.ts`

**Step 1: Write the failing test**

```typescript
// server/tests/webhook-schema.test.ts
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
```

**Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/webhook-schema.test.ts`
Expected: FAIL — module not found

**Step 3: Write the schema**

```typescript
// server/src/schemas/webhooks.ts
import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
extendZodWithOpenApi(z);

/** Valid webhook event types. */
export const WEBHOOK_EVENT_TYPES = [
  "session.created",
  "session.status",
  "message",
  "tool.approval",
  "subagent.started",
  "subagent.completed",
  "context.usage",
  "mode.changed",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

const WebhookTemplateSchema = z.object({
  headers: z.record(z.string()).optional().openapi({ description: "Custom HTTP headers" }),
  body: z.string().min(1).openapi({ description: "Template body with {{variable}} interpolation" }),
}).openapi("WebhookTemplate");

export const WebhookSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  url: z.string().url(),
  secret: z.string().optional(),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).openapi({ description: "Event filter. Empty array = all events." }),
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
  template: WebhookTemplateSchema.optional(),
}).openapi("Webhook");

export const CreateWebhookSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url(),
  secret: z.string().optional(),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).default([]),
  enabled: z.boolean().default(true),
  template: WebhookTemplateSchema.optional(),
}).openapi("CreateWebhook");

export const PatchWebhookSchema = CreateWebhookSchema.partial().openapi("PatchWebhook");

export type Webhook = z.infer<typeof WebhookSchema>;
export type CreateWebhook = z.infer<typeof CreateWebhookSchema>;
export type PatchWebhook = z.infer<typeof PatchWebhookSchema>;
```

**Step 4: Add exports to barrel file**

Modify `server/src/schemas/index.ts` — add at end, before the `openApiDocument` export:

```typescript
export {
  WebhookSchema, CreateWebhookSchema, PatchWebhookSchema,
  WEBHOOK_EVENT_TYPES,
  type Webhook, type CreateWebhook, type PatchWebhook, type WebhookEventType,
} from "./webhooks.js";
```

**Step 5: Run test to verify it passes**

Run: `cd server && npx vitest run tests/webhook-schema.test.ts`
Expected: 5 tests PASS

**Step 6: Commit**

```bash
git add server/src/schemas/webhooks.ts server/src/schemas/index.ts server/tests/webhook-schema.test.ts
git commit -m "feat: add webhook Zod schemas with OpenAPI metadata"
```

---

### Task 3: Webhook Registry (CRUD + File Persistence)

**Files:**
- Create: `server/src/webhooks.ts`
- Test: `server/tests/webhook-registry.test.ts`

**Step 1: Write the failing test**

```typescript
// server/tests/webhook-registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebhookRegistry } from "../src/webhooks.js";

describe("WebhookRegistry", () => {
  let dir: string;
  let registry: WebhookRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "webhooks-"));
    registry = new WebhookRegistry(join(dir, "webhooks.json"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("starts with empty list", async () => {
    const all = await registry.list();
    expect(all).toEqual([]);
  });

  it("creates a webhook and assigns id + createdAt", async () => {
    const wh = await registry.create({ name: "Test", url: "https://example.com/hook", events: [] });
    expect(wh.id).toBeDefined();
    expect(wh.createdAt).toBeDefined();
    expect(wh.enabled).toBe(true);
    const all = await registry.list();
    expect(all).toHaveLength(1);
  });

  it("updates a webhook", async () => {
    const wh = await registry.create({ name: "Test", url: "https://example.com/hook", events: [] });
    const updated = await registry.update(wh.id, { name: "Updated" });
    expect(updated.name).toBe("Updated");
    expect(updated.url).toBe("https://example.com/hook");
  });

  it("deletes a webhook", async () => {
    const wh = await registry.create({ name: "Test", url: "https://example.com/hook", events: [] });
    await registry.remove(wh.id);
    expect(await registry.list()).toHaveLength(0);
  });

  it("throws on update of nonexistent webhook", async () => {
    await expect(registry.update("nonexistent", { name: "Nope" })).rejects.toThrow();
  });

  it("throws on delete of nonexistent webhook", async () => {
    await expect(registry.remove("nonexistent")).rejects.toThrow();
  });

  it("persists across instances", async () => {
    const path = join(dir, "webhooks.json");
    const r1 = new WebhookRegistry(path);
    await r1.create({ name: "Persist", url: "https://example.com/hook", events: [] });
    const r2 = new WebhookRegistry(path);
    const all = await r2.list();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Persist");
  });

  it("getById returns webhook or undefined", async () => {
    const wh = await registry.create({ name: "Find me", url: "https://example.com/hook", events: [] });
    expect(await registry.getById(wh.id)).toEqual(wh);
    expect(await registry.getById("nonexistent")).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/webhook-registry.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// server/src/webhooks.ts
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { WebhookSchema, type Webhook, type CreateWebhook, type PatchWebhook } from "./schemas/webhooks.js";
import { z } from "zod";

const DEFAULT_PATH = join(homedir(), ".config", "hatchpod", "webhooks.json");

export class WebhookRegistry {
  constructor(private readonly path: string = DEFAULT_PATH) {}

  async list(): Promise<Webhook[]> {
    try {
      const raw = await readFile(this.path, "utf-8");
      const parsed = z.array(WebhookSchema).safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  async getById(id: string): Promise<Webhook | undefined> {
    const all = await this.list();
    return all.find((w) => w.id === id);
  }

  async create(input: CreateWebhook): Promise<Webhook> {
    const all = await this.list();
    const webhook: Webhook = {
      ...input,
      id: randomUUID(),
      enabled: input.enabled ?? true,
      events: input.events ?? [],
      createdAt: new Date().toISOString(),
    };
    all.push(webhook);
    await this.save(all);
    return webhook;
  }

  async update(id: string, patch: PatchWebhook): Promise<Webhook> {
    const all = await this.list();
    const idx = all.findIndex((w) => w.id === id);
    if (idx === -1) throw new Error(`Webhook ${id} not found`);
    const merged = WebhookSchema.parse({ ...all[idx], ...patch });
    all[idx] = merged;
    await this.save(all);
    return merged;
  }

  async remove(id: string): Promise<void> {
    const all = await this.list();
    const idx = all.findIndex((w) => w.id === id);
    if (idx === -1) throw new Error(`Webhook ${id} not found`);
    all.splice(idx, 1);
    await this.save(all);
  }

  private async save(webhooks: Webhook[]): Promise<void> {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true });
    const tmp = this.path + ".tmp";
    await writeFile(tmp, JSON.stringify(webhooks, null, 2));
    await rename(tmp, this.path);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/webhook-registry.test.ts`
Expected: 8 tests PASS

**Step 5: Commit**

```bash
git add server/src/webhooks.ts server/tests/webhook-registry.test.ts
git commit -m "feat: add WebhookRegistry with CRUD and file persistence"
```

---

### Task 4: Webhook Dispatcher (EventBus Consumer)

**Files:**
- Create: `server/src/webhook-dispatcher.ts`
- Test: `server/tests/webhook-dispatcher.test.ts`

**Step 1: Write the failing test**

```typescript
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
    // Allow microtask queue to flush
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
    const wh = await registry.create({ name: "Off", url: "https://example.com/hook", events: [], enabled: false });
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

  it("sendTest sends a test event to a specific webhook", async () => {
    const wh = await registry.create({ name: "Test", url: "https://example.com/hook", events: [] });
    await dispatcher.sendTest(wh.id);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.event).toBe("test");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/webhook-dispatcher.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// server/src/webhook-dispatcher.ts
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

/** Interpolate {{variable}} placeholders in a template string. */
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

export class WebhookDispatcher {
  private unsub: (() => void) | null = null;

  constructor(
    private readonly bus: EventBus,
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

    const vars: Record<string, string> = {
      event: type,
      timestamp: new Date().toISOString(),
      sessionId: "sessionId" in event ? event.sessionId : "",
      status: "status" in event ? String(event.status) : "",
      message: buildMessage(event),
      data: JSON.stringify(event),
      error: "error" in event && event.error ? String(event.error) : "",
    };

    let body: string;
    let headers: Record<string, string>;

    if (webhook.template) {
      body = interpolate(webhook.template.body, vars);
      headers = { ...webhook.template.headers };
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
```

**Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/webhook-dispatcher.test.ts`
Expected: 7 tests PASS

**Step 5: Commit**

```bash
git add server/src/webhook-dispatcher.ts server/tests/webhook-dispatcher.test.ts
git commit -m "feat: add WebhookDispatcher with template interpolation and HMAC signing"
```

---

### Task 5: WsBroadcaster — Extract Broadcast from SessionWatcher

**Files:**
- Create: `server/src/ws-broadcaster.ts`
- Modify: `server/src/session-watcher.ts` (remove broadcast, add emit, expose client management for WsBroadcaster)
- Test: `server/tests/ws-broadcaster.test.ts`

**Context:** This is the most delicate refactor. SessionWatcher currently has a `broadcast()` method (lines 728-742) and a `send()` method (lines 718-725) that iterate `watched.clients`. We need to:
1. Extract client management + broadcast into `WsBroadcaster`
2. Have SessionWatcher emit events on the EventBus instead of calling broadcast
3. WsBroadcaster subscribes to the bus and delivers to WS clients
4. Replay logic stays in SessionWatcher — replays send to a single client, not through the bus

**Step 1: Write the failing test for WsBroadcaster**

```typescript
// server/tests/ws-broadcaster.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventBus } from "../src/event-bus.js";
import { WsBroadcaster } from "../src/ws-broadcaster.js";
import type { WebSocket } from "ws";

function mockWs(): WebSocket {
  return {
    readyState: 1, // WebSocket.OPEN
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
}

describe("WsBroadcaster", () => {
  let bus: EventBus;
  let broadcaster: WsBroadcaster;

  beforeEach(() => {
    bus = new EventBus();
    broadcaster = new WsBroadcaster(bus);
  });

  it("delivers events to subscribed clients", () => {
    const ws = mockWs();
    broadcaster.addClient("s1", ws);
    bus.emit({ type: "session.status", sessionId: "s1", status: "running" });
    expect(ws.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(payload.type).toBe("status");
    expect(payload.status).toBe("running");
  });

  it("does not deliver events to clients of other sessions", () => {
    const ws = mockWs();
    broadcaster.addClient("s2", ws);
    bus.emit({ type: "session.status", sessionId: "s1", status: "running" });
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("removes clients on unsubscribe", () => {
    const ws = mockWs();
    broadcaster.addClient("s1", ws);
    broadcaster.removeClient("s1", ws);
    bus.emit({ type: "session.status", sessionId: "s1", status: "running" });
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("handles message events", () => {
    const ws = mockWs();
    broadcaster.addClient("s1", ws);
    bus.emit({
      type: "message",
      sessionId: "s1",
      message: { role: "assistant", parts: [{ type: "text", text: "Hello" }], index: 0 },
    } as any);
    expect(ws.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(payload.type).toBe("message");
  });

  it("skips closed connections and removes them", () => {
    const ws = mockWs();
    (ws as any).readyState = 3; // CLOSED
    broadcaster.addClient("s1", ws);
    bus.emit({ type: "session.status", sessionId: "s1", status: "running" });
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("remaps session clients", () => {
    const ws = mockWs();
    broadcaster.addClient("old-id", ws);
    broadcaster.remapSession("old-id", "new-id");
    bus.emit({ type: "session.status", sessionId: "new-id", status: "running" });
    expect(ws.send).toHaveBeenCalledTimes(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/ws-broadcaster.test.ts`
Expected: FAIL — module not found

**Step 3: Write WsBroadcaster**

```typescript
// server/src/ws-broadcaster.ts
import type { WebSocket } from "ws";
import type { EventBus, SessionEvent } from "./event-bus.js";
import type { ServerMessage } from "./types.js";

/** Convert a SessionEvent to the ServerMessage format expected by WS clients. */
function toServerMessage(event: SessionEvent): ServerMessage | null {
  switch (event.type) {
    case "session.status":
      return { type: "status", status: event.status, ...(event.error ? { error: event.error } : {}) };
    case "message":
      return { type: "message", message: event.message };
    case "ephemeral":
      return event.event;
    case "session.created":
      return null; // Not sent to WS clients directly
  }
}

export class WsBroadcaster {
  private clients = new Map<string, Set<WebSocket>>();
  private unsub: (() => void) | null = null;

  constructor(bus: EventBus) {
    this.unsub = bus.on((event) => this.onEvent(event));
  }

  addClient(sessionId: string, ws: WebSocket): void {
    let set = this.clients.get(sessionId);
    if (!set) {
      set = new Set();
      this.clients.set(sessionId, set);
    }
    set.add(ws);
  }

  removeClient(sessionId: string, ws: WebSocket): void {
    const set = this.clients.get(sessionId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.clients.delete(sessionId);
  }

  remapSession(oldId: string, newId: string): void {
    const set = this.clients.get(oldId);
    if (!set) return;
    this.clients.delete(oldId);
    const existing = this.clients.get(newId);
    if (existing) {
      for (const ws of set) existing.add(ws);
    } else {
      this.clients.set(newId, set);
    }
  }

  /** Get client count for a session (used by SessionWatcher cleanup). */
  clientCount(sessionId: string): number {
    return this.clients.get(sessionId)?.size ?? 0;
  }

  /** Send a message directly to a specific client (used for replay, not through bus). */
  sendToClient(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
  }

  private onEvent(event: SessionEvent): void {
    const sessionId = "sessionId" in event ? event.sessionId : null;
    if (!sessionId) return;

    const msg = toServerMessage(event);
    if (!msg) return;

    const set = this.clients.get(sessionId);
    if (!set) return;

    const json = JSON.stringify(msg);
    for (const ws of set) {
      if (ws.readyState !== 1) {
        set.delete(ws);
        continue;
      }
      try {
        ws.send(json);
      } catch {
        set.delete(ws);
      }
    }
    if (set.size === 0) this.clients.delete(sessionId);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/ws-broadcaster.test.ts`
Expected: 6 tests PASS

**Step 5: Refactor SessionWatcher**

Modify `server/src/session-watcher.ts`:

1. **Add EventBus import and constructor parameter** (line 2 area):
   ```typescript
   import type { EventBus } from "./event-bus.js";
   ```

2. **Update constructor** (line ~91) — accept `EventBus` and store it:
   ```typescript
   constructor(
     private readonly adapter: ProviderAdapter,
     private readonly bus: EventBus,
   ) { ... }
   ```

3. **In `pushMessage()`** (line ~252) — replace `this.broadcast(watched, ...)` with `this.bus.emit()`:
   ```typescript
   // Replace: this.broadcast(watched, { type: "message", message: stored });
   // With:
   this.bus.emit({ type: "message", sessionId, message: stored });
   ```

4. **In `pushEvent()`** (line ~336) — replace `this.broadcast(watched, event)` with `this.bus.emit()`:
   ```typescript
   // Replace: this.broadcast(watched, event);
   // With:
   this.bus.emit({ type: "ephemeral", sessionId, event });
   ```

5. **In `pollSession()`** (line ~672 area) — replace broadcast of polled messages with bus emit:
   ```typescript
   // Replace: this.broadcast(watched, { type: "message", message: stored });
   // With:
   this.bus.emit({ type: "message", sessionId, message: stored });
   ```

6. **Remove `broadcast()` and `send()` private methods** (lines 718-742). `send()` is still used by replay methods — keep `send()` but delegate to WsBroadcaster's `sendToClient()` instead, or accept a WsBroadcaster reference for replay.

7. **Remove `clients` Set from WatchedSession interface** — client tracking moves to WsBroadcaster. However, `subscribe()` and `unsubscribe()` still need to coordinate with WsBroadcaster, so either:
   - SessionWatcher accepts WsBroadcaster as a dependency, or
   - `subscribe()`/`unsubscribe()` return/accept callbacks

   Recommended: SessionWatcher gets a `broadcaster: WsBroadcaster` constructor param for replay sends and client coordination.

**Step 6: Update `sessions.ts` and `index.ts`** to pass EventBus and WsBroadcaster to SessionWatcher:

In `server/src/sessions.ts`, `initWatcher()` (the function that creates the SessionWatcher) must accept and forward EventBus + WsBroadcaster.

In `server/src/index.ts`, initialization becomes:
```typescript
import { eventBus } from "./event-bus.js";
import { WsBroadcaster } from "./ws-broadcaster.js";
import { WebhookDispatcher } from "./webhook-dispatcher.js";
import { WebhookRegistry } from "./webhooks.js";

// In createApp():
const broadcaster = new WsBroadcaster(eventBus);
const webhookRegistry = new WebhookRegistry();
const webhookDispatcher = new WebhookDispatcher(eventBus, webhookRegistry);
initWatcher(getProvider("claude"), eventBus, broadcaster);
```

**Step 7: Run full test suite**

Run: `cd server && npx vitest run`
Expected: All existing tests pass (behavioral no-op for WS clients)

**Step 8: Commit**

```bash
git add server/src/ws-broadcaster.ts server/src/session-watcher.ts server/src/sessions.ts server/src/index.ts server/tests/ws-broadcaster.test.ts
git commit -m "refactor: extract WsBroadcaster from SessionWatcher, emit via EventBus"
```

---

### Task 6: Webhook CRUD REST Endpoints

**Files:**
- Modify: `server/src/routes.ts` (add webhook endpoints)
- Modify: `server/src/index.ts` (export registry for routes)
- Test: `server/tests/webhook-api.test.ts`

**Step 1: Write the failing test**

```typescript
// server/tests/webhook-api.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, stopServer, api } from "./helpers.js";

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
    // Will get 200 (success) or 502 (delivery failed) — both are valid API responses
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
    const res = await api("/api/webhooks/nonexistent-id", {
      method: "PATCH",
      body: JSON.stringify({ name: "Nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("requires auth", async () => {
    const res = await fetch(`http://127.0.0.1:${(globalThis as any).__TEST_PORT__}/api/webhooks`);
    expect(res.status).toBe(401);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/webhook-api.test.ts`
Expected: FAIL — 404 on all webhook endpoints

**Step 3: Add routes**

Modify `server/src/routes.ts`:

1. Add imports at top:
   ```typescript
   import { CreateWebhookSchema, PatchWebhookSchema } from "./schemas/webhooks.js";
   import { getWebhookRegistry, getWebhookDispatcher } from "./index.js"; // or wherever they're exported
   ```

2. Add route patterns:
   ```typescript
   const WEBHOOK_RE = /^\/api\/webhooks$/;
   const WEBHOOK_ID_RE = /^\/api\/webhooks\/([0-9a-f-]{36})$/;
   const WEBHOOK_TEST_RE = /^\/api\/webhooks\/([0-9a-f-]{36})\/test$/;
   ```

3. Add endpoint handlers inside `handleRequest()`, after the settings endpoints (line ~449):

   ```typescript
   // GET /api/webhooks
   if (method === "GET" && WEBHOOK_RE.test(pathname)) {
     const registry = getWebhookRegistry();
     return json(res, await registry.list());
   }

   // POST /api/webhooks
   if (method === "POST" && WEBHOOK_RE.test(pathname)) {
     const body = await readBody(req);
     const parsed = CreateWebhookSchema.safeParse(JSON.parse(body));
     if (!parsed.success) return json(res, { error: parsed.error.format() }, 400);
     const registry = getWebhookRegistry();
     const webhook = await registry.create(parsed.data);
     return json(res, webhook, 201);
   }

   // PATCH /api/webhooks/:id
   const webhookIdMatch = pathname.match(WEBHOOK_ID_RE);
   if (method === "PATCH" && webhookIdMatch) {
     const id = webhookIdMatch[1];
     const body = await readBody(req);
     const parsed = PatchWebhookSchema.safeParse(JSON.parse(body));
     if (!parsed.success) return json(res, { error: parsed.error.format() }, 400);
     const registry = getWebhookRegistry();
     try {
       const updated = await registry.update(id, parsed.data);
       return json(res, updated);
     } catch { return json(res, { error: "Webhook not found" }, 404); }
   }

   // DELETE /api/webhooks/:id
   if (method === "DELETE" && webhookIdMatch) {
     const id = webhookIdMatch[1];
     const registry = getWebhookRegistry();
     try {
       await registry.remove(id);
       res.writeHead(204).end();
     } catch { return json(res, { error: "Webhook not found" }, 404); }
     return;
   }

   // POST /api/webhooks/:id/test
   const webhookTestMatch = pathname.match(WEBHOOK_TEST_RE);
   if (method === "POST" && webhookTestMatch) {
     const id = webhookTestMatch[1];
     const dispatcher = getWebhookDispatcher();
     try {
       await dispatcher.sendTest(id);
       return json(res, { ok: true });
     } catch (err) {
       return json(res, { error: (err as Error).message }, 502);
     }
   }
   ```

**Step 4: Export registry/dispatcher getters from index.ts**

```typescript
let webhookRegistry: WebhookRegistry;
let webhookDispatcher: WebhookDispatcher;

export function getWebhookRegistry(): WebhookRegistry { return webhookRegistry; }
export function getWebhookDispatcher(): WebhookDispatcher { return webhookDispatcher; }
```

**Step 5: Run test to verify it passes**

Run: `cd server && npx vitest run tests/webhook-api.test.ts`
Expected: 8 tests PASS

**Step 6: Commit**

```bash
git add server/src/routes.ts server/src/index.ts server/tests/webhook-api.test.ts
git commit -m "feat: add webhook CRUD REST endpoints"
```

---

### Task 7: OpenAPI Registration for Webhook Endpoints

**Files:**
- Modify: `server/src/schemas/registry.ts` (add webhook paths)

**Step 1: Add webhook endpoint registrations**

Add after the settings paths (line ~437) in `server/src/schemas/registry.ts`:

```typescript
// --- Webhooks ---

registry.registerPath({
  method: "get",
  path: "/api/webhooks",
  security: [{ bearerAuth: [] }],
  summary: "List all webhooks",
  responses: {
    200: { description: "Webhook list", content: { "application/json": { schema: z.array(WebhookSchema) } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/webhooks",
  security: [{ bearerAuth: [] }],
  summary: "Create a webhook",
  request: { body: { content: { "application/json": { schema: CreateWebhookSchema } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: WebhookSchema } } },
    400: { description: "Invalid input", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/webhooks/{id}",
  security: [{ bearerAuth: [] }],
  summary: "Update a webhook",
  request: {
    params: z.object({ id: UuidSchema }),
    body: { content: { "application/json": { schema: PatchWebhookSchema } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: WebhookSchema } } },
    400: { description: "Invalid input", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/webhooks/{id}",
  security: [{ bearerAuth: [] }],
  summary: "Delete a webhook",
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    204: { description: "Deleted" },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/webhooks/{id}/test",
  security: [{ bearerAuth: [] }],
  summary: "Send a test event to a webhook",
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    200: { description: "Test sent", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
    502: { description: "Delivery failed", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});
```

**Step 2: Add imports at top of registry.ts**

```typescript
import { WebhookSchema, CreateWebhookSchema, PatchWebhookSchema } from "./webhooks.js";
```

**Step 3: Run type check + existing schema tests**

Run: `cd server && npx tsc --noEmit && npx vitest run tests/schemas.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add server/src/schemas/registry.ts
git commit -m "docs: add webhook endpoints to OpenAPI specification"
```

---

### Task 8: Webhook UI Store

**Files:**
- Create: `server/ui/src/stores/webhooks.ts`

**Step 1: Write the store**

Follow the exact same pattern as `server/ui/src/stores/settings.ts` — Zustand store with fetch helpers, auth from `useAuthStore`.

```typescript
// server/ui/src/stores/webhooks.ts
import { create } from "zustand";
import { useAuthStore } from "./auth";

export const WEBHOOK_EVENT_TYPES = [
  "session.created",
  "session.status",
  "message",
  "tool.approval",
  "subagent.started",
  "subagent.completed",
  "context.usage",
  "mode.changed",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface WebhookTemplate {
  headers?: Record<string, string>;
  body: string;
}

export interface Webhook {
  id: string;
  name: string;
  url: string;
  secret?: string;
  events: WebhookEventType[];
  enabled: boolean;
  createdAt: string;
  template?: WebhookTemplate;
}

interface CreateWebhookInput {
  name: string;
  url: string;
  secret?: string;
  events?: WebhookEventType[];
  enabled?: boolean;
  template?: WebhookTemplate;
}

interface WebhookStore {
  webhooks: Webhook[];
  loading: boolean;
  error: string | null;
  testingId: string | null;
  testResult: { id: string; ok: boolean; error?: string } | null;

  fetchWebhooks: () => Promise<void>;
  createWebhook: (input: CreateWebhookInput) => Promise<Webhook | null>;
  updateWebhook: (id: string, patch: Partial<CreateWebhookInput>) => Promise<Webhook | null>;
  deleteWebhook: (id: string) => Promise<boolean>;
  testWebhook: (id: string) => Promise<void>;
  clearTestResult: () => void;
}

function getHeaders(): Record<string, string> {
  const token = useAuthStore.getState().token;
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export const useWebhookStore = create<WebhookStore>((set, get) => ({
  webhooks: [],
  loading: false,
  error: null,
  testingId: null,
  testResult: null,

  fetchWebhooks: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetch("/api/webhooks", { headers: getHeaders() });
      if (!res.ok) throw new Error(`${res.status}`);
      const webhooks = await res.json();
      set({ webhooks, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  createWebhook: async (input) => {
    try {
      const res = await fetch("/api/webhooks", {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const webhook = await res.json();
      await get().fetchWebhooks();
      return webhook;
    } catch (err) {
      set({ error: (err as Error).message });
      return null;
    }
  },

  updateWebhook: async (id, patch) => {
    try {
      const res = await fetch(`/api/webhooks/${id}`, {
        method: "PATCH",
        headers: getHeaders(),
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const webhook = await res.json();
      await get().fetchWebhooks();
      return webhook;
    } catch (err) {
      set({ error: (err as Error).message });
      return null;
    }
  },

  deleteWebhook: async (id) => {
    try {
      const res = await fetch(`/api/webhooks/${id}`, {
        method: "DELETE",
        headers: getHeaders(),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      await get().fetchWebhooks();
      return true;
    } catch (err) {
      set({ error: (err as Error).message });
      return false;
    }
  },

  testWebhook: async (id) => {
    set({ testingId: id, testResult: null });
    try {
      const res = await fetch(`/api/webhooks/${id}/test`, {
        method: "POST",
        headers: getHeaders(),
      });
      const body = await res.json().catch(() => ({}));
      set({
        testingId: null,
        testResult: { id, ok: res.ok, error: body.error },
      });
    } catch (err) {
      set({
        testingId: null,
        testResult: { id, ok: false, error: (err as Error).message },
      });
    }
  },

  clearTestResult: () => set({ testResult: null }),
}));
```

**Step 2: Verify types**

Run: `cd server/ui && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add server/ui/src/stores/webhooks.ts
git commit -m "feat: add Zustand webhook store with CRUD operations"
```

---

### Task 9: Webhook UI Components

**Files:**
- Create: `server/ui/src/components/WebhookList.tsx`
- Create: `server/ui/src/components/WebhookForm.tsx`
- Modify: `server/ui/src/pages/SettingsPage.tsx` (add webhooks section)

**Step 1: Create WebhookList component**

Card-based list following the same pattern as the existing Settings cards. Each webhook shows:
- Name + enabled toggle
- URL (truncated)
- Event filter badges
- Edit, Test, Delete buttons

```typescript
// server/ui/src/components/WebhookList.tsx
import { useEffect } from "react";
import { useWebhookStore, type Webhook } from "@/stores/webhooks";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Pencil, Trash2, Zap, Loader2 } from "lucide-react";

function WebhookCard({
  webhook,
  onEdit,
}: {
  webhook: Webhook;
  onEdit: (wh: Webhook) => void;
}) {
  const { updateWebhook, deleteWebhook, testWebhook, testingId, testResult } =
    useWebhookStore();

  const isTesting = testingId === webhook.id;
  const result =
    testResult?.id === webhook.id ? testResult : null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{webhook.name}</span>
          <Badge variant={webhook.enabled ? "default" : "secondary"}>
            {webhook.enabled ? "Active" : "Disabled"}
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            updateWebhook(webhook.id, { enabled: !webhook.enabled })
          }
        >
          {webhook.enabled ? "Disable" : "Enable"}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground truncate font-mono">
        {webhook.url}
      </p>

      {webhook.events.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {webhook.events.map((e) => (
            <Badge key={e} variant="outline" className="text-xs">
              {e}
            </Badge>
          ))}
        </div>
      )}
      {webhook.events.length === 0 && (
        <Badge variant="outline" className="text-xs w-fit">
          All events
        </Badge>
      )}

      {webhook.template && (
        <Badge variant="secondary" className="text-xs w-fit">
          Custom template
        </Badge>
      )}

      <div className="flex gap-1 pt-1">
        <Button variant="ghost" size="sm" onClick={() => onEdit(webhook)}>
          <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => testWebhook(webhook.id)}
          disabled={isTesting}
        >
          {isTesting ? (
            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          ) : (
            <Zap className="h-3.5 w-3.5 mr-1" />
          )}
          Test
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => deleteWebhook(webhook.id)}
        >
          <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
        </Button>
      </div>

      {result && (
        <p
          className={`text-xs ${result.ok ? "text-green-500" : "text-destructive"}`}
        >
          {result.ok ? "Test delivered successfully" : `Failed: ${result.error}`}
        </p>
      )}
    </div>
  );
}

export function WebhookList({ onEdit, onAdd }: { onEdit: (wh: Webhook) => void; onAdd: () => void }) {
  const { webhooks, loading, fetchWebhooks } = useWebhookStore();

  useEffect(() => {
    fetchWebhooks();
  }, [fetchWebhooks]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          <Zap className="h-4 w-4" /> Webhooks
        </CardTitle>
        <Button size="sm" onClick={onAdd}>
          Add Webhook
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && webhooks.length === 0 && (
          <p className="text-sm text-muted-foreground">Loading...</p>
        )}
        {!loading && webhooks.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No webhooks configured. Add one to receive notifications.
          </p>
        )}
        {webhooks.map((wh) => (
          <WebhookCard key={wh.id} webhook={wh} onEdit={onEdit} />
        ))}
      </CardContent>
    </Card>
  );
}
```

**Step 2: Create WebhookForm dialog**

```typescript
// server/ui/src/components/WebhookForm.tsx
import { useState, useEffect } from "react";
import { useWebhookStore, WEBHOOK_EVENT_TYPES, type Webhook, type WebhookEventType } from "@/stores/webhooks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

interface Props {
  open: boolean;
  onClose: () => void;
  editing?: Webhook | null;
}

export function WebhookForm({ open, onClose, editing }: Props) {
  const { createWebhook, updateWebhook } = useWebhookStore();

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [events, setEvents] = useState<WebhookEventType[]>([]);
  const [useTemplate, setUseTemplate] = useState(false);
  const [templateHeaders, setTemplateHeaders] = useState("");
  const [templateBody, setTemplateBody] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editing) {
      setName(editing.name);
      setUrl(editing.url);
      setSecret(editing.secret ?? "");
      setEvents([...editing.events]);
      setUseTemplate(!!editing.template);
      setTemplateHeaders(
        editing.template?.headers
          ? JSON.stringify(editing.template.headers, null, 2)
          : ""
      );
      setTemplateBody(editing.template?.body ?? "");
    } else {
      setName("");
      setUrl("");
      setSecret("");
      setEvents([]);
      setUseTemplate(false);
      setTemplateHeaders("");
      setTemplateBody("");
    }
  }, [editing, open]);

  const toggleEvent = (e: WebhookEventType) => {
    setEvents((prev) =>
      prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]
    );
  };

  const handleSave = async () => {
    setSaving(true);
    const input: any = { name, url, events };
    if (secret) input.secret = secret;
    if (useTemplate && templateBody) {
      input.template = { body: templateBody };
      try {
        const parsed = JSON.parse(templateHeaders);
        if (typeof parsed === "object") input.template.headers = parsed;
      } catch { /* ignore invalid JSON for headers */ }
    }

    if (editing) {
      await updateWebhook(editing.id, input);
    } else {
      await createWebhook(input);
    }
    setSaving(false);
    onClose();
  };

  const isValid = name.trim().length > 0 && url.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Webhook" : "Add Webhook"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Slack alerts" />
          </div>

          <div>
            <label className="text-sm font-medium">URL</label>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." />
          </div>

          <div>
            <label className="text-sm font-medium">Secret (optional)</label>
            <Input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="HMAC signing key"
            />
          </div>

          <div>
            <label className="text-sm font-medium block mb-1">Events (empty = all)</label>
            <div className="flex flex-wrap gap-1.5">
              {WEBHOOK_EVENT_TYPES.map((e) => (
                <Badge
                  key={e}
                  variant={events.includes(e) ? "default" : "outline"}
                  className="cursor-pointer"
                  onClick={() => toggleEvent(e)}
                >
                  {e}
                </Badge>
              ))}
            </div>
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={useTemplate}
                onChange={(e) => setUseTemplate(e.target.checked)}
              />
              Custom payload template
            </label>
          </div>

          {useTemplate && (
            <>
              <div>
                <label className="text-sm font-medium">
                  Headers (JSON object, optional)
                </label>
                <textarea
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
                  rows={3}
                  value={templateHeaders}
                  onChange={(e) => setTemplateHeaders(e.target.value)}
                  placeholder='{"Content-Type": "application/json"}'
                />
              </div>
              <div>
                <label className="text-sm font-medium">Body template</label>
                <textarea
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
                  rows={5}
                  value={templateBody}
                  onChange={(e) => setTemplateBody(e.target.value)}
                  placeholder='{"message": "{{message}}"}'
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Variables: {"{{event}}"}, {"{{sessionId}}"}, {"{{status}}"}, {"{{message}}"}, {"{{data}}"}, {"{{error}}"}, {"{{timestamp}}"}
                </p>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!isValid || saving}>
            {saving ? "Saving..." : editing ? "Update" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

**Step 3: Add webhooks section to SettingsPage**

Modify `server/ui/src/pages/SettingsPage.tsx`:

1. Add imports:
   ```typescript
   import { useState } from "react";
   import { WebhookList } from "@/components/WebhookList";
   import { WebhookForm } from "@/components/WebhookForm";
   import type { Webhook } from "@/stores/webhooks";
   ```

2. Add state inside the component:
   ```typescript
   const [webhookFormOpen, setWebhookFormOpen] = useState(false);
   const [editingWebhook, setEditingWebhook] = useState<Webhook | null>(null);
   ```

3. Add the webhooks section after the Terminal card and before the About card:
   ```tsx
   <WebhookList
     onEdit={(wh) => { setEditingWebhook(wh); setWebhookFormOpen(true); }}
     onAdd={() => { setEditingWebhook(null); setWebhookFormOpen(true); }}
   />
   <WebhookForm
     open={webhookFormOpen}
     onClose={() => { setWebhookFormOpen(false); setEditingWebhook(null); }}
     editing={editingWebhook}
   />
   ```

**Step 4: Verify types**

Run: `cd server/ui && npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add server/ui/src/components/WebhookList.tsx server/ui/src/components/WebhookForm.tsx server/ui/src/pages/SettingsPage.tsx
git commit -m "feat: add webhook management UI in Settings page"
```

---

### Task 10: Integration Test + Final Verification

**Step 1: Run full server test suite**

Run: `cd server && npx vitest run`
Expected: All tests pass (existing + new)

**Step 2: Run type check on server and UI**

Run: `cd server && npx tsc --noEmit && cd ui && npx tsc --noEmit`
Expected: No errors

**Step 3: Build dist**

Run: `cd server && npm run build`
Expected: Clean build

**Step 4: Run lint**

Run: `cd server && npx eslint src/ && cd ui && npx eslint src/`
Expected: No errors

**Step 5: Manual smoke test (if running)**

Start dev server and verify:
1. Settings page shows Webhooks section
2. Can add a webhook with name + URL
3. Can toggle events
4. Can enable/disable template editor
5. Can test webhook delivery
6. Can edit and delete webhooks

**Step 6: Final commit with dist**

```bash
git add -A
git commit -m "feat: webhook notifications with EventBus, registry, dispatcher, and Settings UI"
```
