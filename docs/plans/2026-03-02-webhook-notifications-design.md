# Webhook Notifications Design

**Date:** 2026-03-02

## Problem

Hatchpod has no mechanism to notify external systems about session events. Users want to integrate with monitoring dashboards (Slack), CI/CD pipelines, and mobile notification services (Pushover, Ntfy). The current WebSocket-only broadcast model tightly couples "something happened" to "send it to a browser client."

## Decisions

- **EventBus architecture** over direct SessionWatcher hooks — decouples event emission from consumer delivery. Known future consumers: WebSocket broadcast, webhook dispatch, mobile push notifications.
- **Dedicated webhook registry** (`~/.config/hatchpod/webhooks.json`) with CRUD REST API — supports multiple webhooks with independent URLs, secrets, and event filters.
- **Fire-and-forget delivery** — best-effort HTTP POST, log failures, no retries in v1. Keeps the system simple and non-blocking.
- **Payload templates** — customizable body/header templates with `{{variable}}` interpolation. Enables integration with Pushover, Ntfy, Slack incoming webhooks, and any service with an HTTP API, without hardcoding adapters.
- **Full Settings UI** — webhook management section in the Settings page with list, create/edit dialog, and test button.

## Architecture

### EventBus

Typed event bus following the Observer pattern. Synchronous emit, async consumers.

```
runSession() → watcher.pushMessage() → stores message → eventBus.emit()
runSession() → watcher.pushEvent()  → buffers state  → eventBus.emit()
                                                             ↓
                                             ┌───────────────┼───────────────┐
                                             ↓               ↓               ↓
                                       WsBroadcaster   WebhookDispatcher   (future consumers)
```

**New file:** `server/src/event-bus.ts`

```typescript
type SessionEvent =
  | { type: "session.created"; sessionId: string; cwd: string; model?: string }
  | { type: "session.status"; sessionId: string; status: SessionStatus; error?: string }
  | { type: "message"; sessionId: string; message: NormalizedMessage }
  | { type: "ephemeral"; sessionId: string; event: ServerMessage }
  // ... other event types mapped from existing ServerMessage union

type EventListener = (event: SessionEvent) => void | Promise<void>;

class EventBus {
  private listeners = new Set<EventListener>();
  on(listener: EventListener): () => void;  // returns unsubscribe fn
  emit(event: SessionEvent): void;          // sync, fire-and-forget to listeners
}

export const eventBus = new EventBus();
```

- Singleton instance — one bus per server process
- `emit()` is synchronous — catches listener errors individually, never blocks the emitter
- Listeners can be async — bus calls them but doesn't await; errors are logged

### SessionWatcher Refactor

**Before:** SessionWatcher stores messages AND broadcasts to WS clients via a private `broadcast()` method that iterates a `clients` Set.

**After:** SessionWatcher stores messages and emits events on the bus. A new `WsBroadcaster` consumer handles WS delivery.

**What stays in SessionWatcher:**
- Message storage (`watched.messages[]`)
- Mode management (push/poll/idle)
- Ephemeral state buffering (`pendingThinkingText`, `lastContextUsage`, etc.)
- Poll loop (JSONL tailing) — polled messages also emit to the bus
- Replay logic (`replayFromMemory`, `replayFromFile`) — replays send directly to a specific WS client, not through the bus

**What moves out:**
- `broadcast()` private method → `WsBroadcaster` EventBus consumer
- `clients` Set management → `WsBroadcaster`

**New file:** `server/src/ws-broadcaster.ts` — subscribes to EventBus, maintains per-session WS client sets, delivers ServerMessage JSON to connected clients.

This is a behavioral no-op for existing WebSocket clients — they receive identical messages in identical order.

### Webhook Registry

**Storage:** `~/.config/hatchpod/webhooks.json` — separate from `settings.json`.

**Schema:**

```typescript
{
  id: string;              // UUID
  name: string;            // human-readable label
  url: string;             // target endpoint
  secret?: string;         // HMAC-SHA256 signing key
  events: string[];        // event type filter, [] = wildcard (all events)
  enabled: boolean;        // toggle without deleting
  createdAt: string;       // ISO 8601

  template?: {
    headers?: Record<string, string>;  // custom HTTP headers
    body: string;                      // template string with {{variable}} interpolation
  };
}
```

**REST API:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/webhooks` | List all webhooks |
| `POST` | `/api/webhooks` | Create webhook |
| `PATCH` | `/api/webhooks/:id` | Update webhook |
| `DELETE` | `/api/webhooks/:id` | Delete webhook |
| `POST` | `/api/webhooks/:id/test` | Send test event |

All endpoints require bearer token auth.

**New files:** `server/src/schemas/webhooks.ts` (Zod schema + OpenAPI), `server/src/webhooks.ts` (CRUD + file persistence)

### Webhook Dispatcher

EventBus consumer that dispatches HTTP POSTs to matching webhooks.

**New file:** `server/src/webhook-dispatcher.ts`

**Default payload** (when no template configured):

```
POST <webhook.url>
Content-Type: application/json
X-Hatchpod-Event: session.status
X-Hatchpod-Signature: sha256=<hex-hmac>
X-Hatchpod-Delivery: <unique-delivery-uuid>
X-Hatchpod-Timestamp: <unix-seconds>

{
  "event": "session.status",
  "timestamp": "2026-03-02T12:00:00Z",
  "deliveryId": "<uuid>",
  "data": { ...event-specific fields }
}
```

**Signature:** `HMAC-SHA256(secret, timestamp + "." + JSON.stringify(body))` — includes timestamp to prevent replay attacks.

**Filtering:** `webhook.events = []` matches all events; non-empty array matches only listed types; `enabled: false` skips entirely.

### Payload Templates

When `template` is present on a webhook, the dispatcher uses it instead of the default format.

**Template variables** available in `{{...}}` interpolation:

| Variable | Description | Example |
|----------|-------------|---------|
| `{{event}}` | Event type | `session.status` |
| `{{timestamp}}` | ISO 8601 | `2026-03-02T12:00:00Z` |
| `{{sessionId}}` | Session ID | `abc-123` |
| `{{status}}` | Session status | `completed` |
| `{{message}}` | Human-readable summary | `Session completed successfully` |
| `{{data}}` | Full event data as JSON | `{"sessionId":"..."}` |
| `{{error}}` | Error text | `Process exited with code 1` |

**Pushover example:**

```json
{
  "name": "Pushover alerts",
  "url": "https://api.pushover.net/1/messages.json",
  "events": ["session.status"],
  "enabled": true,
  "template": {
    "headers": { "Content-Type": "application/json" },
    "body": "{\"token\":\"<app-token>\",\"user\":\"<user-key>\",\"title\":\"Hatchpod\",\"message\":\"{{message}}\"}"
  }
}
```

**Ntfy example:**

```json
{
  "name": "Ntfy channel",
  "url": "https://ntfy.sh/my-hatchpod",
  "events": ["session.status", "message"],
  "enabled": true,
  "template": {
    "headers": { "Title": "Hatchpod: {{event}}", "Priority": "default", "Tags": "robot" },
    "body": "{{message}}"
  }
}
```

### Event Types

```
session.created      — new session started
session.status       — status change (running, completed, error, interrupted)
message              — new stored message (user or assistant)
tool.approval        — tool approval requested
subagent.started     — subagent invoked
subagent.completed   — subagent finished
context.usage        — context window usage update
mode.changed         — permission mode change
```

### Settings UI

New "Webhooks" section in the Settings page.

**Components:**
- `WebhookList.tsx` — cards showing each webhook with name, URL, enabled toggle, event badges, edit/delete/test buttons
- `WebhookForm.tsx` — create/edit dialog with name, URL, secret, event multi-select, optional template editor (headers + body textarea)

**State:** `stores/webhooks.ts` — CRUD operations against `/api/webhooks` endpoints.

## File Summary

**New files:**

| File | Purpose |
|------|---------|
| `server/src/event-bus.ts` | Typed EventBus singleton |
| `server/src/schemas/webhooks.ts` | Webhook Zod schema + OpenAPI |
| `server/src/webhooks.ts` | Webhook registry (CRUD, file persistence) |
| `server/src/webhook-dispatcher.ts` | EventBus consumer, HTTP dispatch + templates |
| `server/src/ws-broadcaster.ts` | EventBus consumer, WS broadcast (extracted from SessionWatcher) |
| `server/ui/src/stores/webhooks.ts` | UI state for webhook management |
| `server/ui/src/components/WebhookList.tsx` | Webhook list cards |
| `server/ui/src/components/WebhookForm.tsx` | Create/edit dialog |

**Modified files:**

| File | Change |
|------|--------|
| `server/src/session-watcher.ts` | Remove `broadcast()` + `clients`, add `eventBus.emit()` |
| `server/src/ws.ts` | Wire `WsBroadcaster` subscription |
| `server/src/routes.ts` | Add webhook CRUD endpoints |
| `server/src/index.ts` | Initialize webhook dispatcher + WS broadcaster on startup |
| `server/src/schemas/index.ts` | Export webhook schemas |
| `server/src/schemas/registry.ts` | Add webhook OpenAPI paths |
| `server/ui/src/pages/SettingsPage.tsx` | Add webhooks section |
