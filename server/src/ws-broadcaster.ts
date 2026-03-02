import type { WebSocket } from "ws";
import type { EventBus, SessionEvent } from "./event-bus.js";
import type { ServerMessage } from "./types.js";

/**
 * Convert a SessionEvent to the ServerMessage format expected by WS clients.
 *
 * Note: `session.status` is currently unused — status changes flow through
 * `pushEvent()` as ephemeral ServerMessages. This mapping exists for when
 * `sessions.ts` emits structured `session.status` events directly on the bus.
 */
function toServerMessage(event: SessionEvent): ServerMessage | null {
  switch (event.type) {
    case "session.status":
      return {
        type: "status",
        status: event.status,
        ...(event.error ? { error: event.error } : {}),
      };
    case "message":
      return { type: "message", message: event.message };
    case "ephemeral":
      return event.event;
    case "session.created":
      return null; // Not sent to WS clients directly
  }
}

/**
 * EventBus consumer that manages per-session WebSocket client Sets and delivers
 * messages. Replaces the broadcast() and send() methods formerly in SessionWatcher.
 *
 * This is a behavioral no-op refactor — WS clients receive identical messages
 * in identical order. The only change is the internal delivery path: instead of
 * SessionWatcher.broadcast() iterating its own client Sets, events flow through
 * the EventBus and are picked up here.
 */
export class WsBroadcaster {
  /** Per-session client sets. */
  private clients = new Map<string, Set<WebSocket>>();
  /** Reverse map: WebSocket → sessionId, for removeClientFromAny(). */
  private clientToSession = new Map<WebSocket, string>();
  /** EventBus unsubscribe function. */
  private unsub: (() => void) | null = null;

  constructor(bus: EventBus) {
    this.unsub = bus.on((event) => this.onEvent(event));
  }

  /** Register a WebSocket client for a session. */
  addClient(sessionId: string, ws: WebSocket): void {
    let set = this.clients.get(sessionId);
    if (!set) {
      set = new Set();
      this.clients.set(sessionId, set);
    }
    set.add(ws);
    this.clientToSession.set(ws, sessionId);
  }

  /** Remove a specific client from a specific session. */
  removeClient(sessionId: string, ws: WebSocket): void {
    const set = this.clients.get(sessionId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) this.clients.delete(sessionId);
    }
    this.clientToSession.delete(ws);
  }

  /**
   * Remove a client from whichever session it belongs to.
   * Used when the caller doesn't know the current session ID
   * (e.g., after a session remap).
   */
  removeClientFromAny(ws: WebSocket): void {
    const sessionId = this.clientToSession.get(ws);
    if (sessionId) {
      this.removeClient(sessionId, ws);
    }
  }

  /**
   * Remove all client references for a session (called during TTL eviction).
   * Does not close the WebSocket connections — clients remain connected but
   * will no longer receive events for this session.
   */
  removeSession(sessionId: string): void {
    const set = this.clients.get(sessionId);
    if (!set) return;
    for (const ws of set) {
      this.clientToSession.delete(ws);
    }
    this.clients.delete(sessionId);
  }

  /** Move all clients from oldId to newId (session remap). */
  remapSession(oldId: string, newId: string): void {
    const set = this.clients.get(oldId);
    if (!set) return;
    this.clients.delete(oldId);
    // Merge into existing set for newId if it already exists
    const existing = this.clients.get(newId);
    if (existing) {
      for (const ws of set) {
        existing.add(ws);
        this.clientToSession.set(ws, newId);
      }
    } else {
      this.clients.set(newId, set);
      for (const ws of set) {
        this.clientToSession.set(ws, newId);
      }
    }
  }

  /** Number of connected clients for a session. */
  clientCount(sessionId: string): number {
    return this.clients.get(sessionId)?.size ?? 0;
  }

  /** Send a message to a single WebSocket client (used for replay). */
  sendToClient(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(message));
    } catch (err) {
      console.warn("WsBroadcaster: failed to send to client:", (err as Error).message);
    }
  }

  /** Stop listening to the EventBus and release all client references. */
  stop(): void {
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
    this.clients.clear();
    this.clientToSession.clear();
  }

  /** Handle an event from the EventBus — broadcast to the correct session's clients. */
  private onEvent(event: SessionEvent): void {
    const msg = toServerMessage(event);
    if (!msg) return;

    const { sessionId } = event;

    const set = this.clients.get(sessionId);
    if (!set || set.size === 0) return;

    const payload = JSON.stringify(msg);
    for (const client of set) {
      if (client.readyState === 1) {
        try {
          client.send(payload);
        } catch (err) {
          console.warn("WsBroadcaster: broadcast send failed, removing client:", (err as Error).message);
          set.delete(client);
          this.clientToSession.delete(client);
        }
      } else {
        set.delete(client);
        this.clientToSession.delete(client);
      }
    }

    if (set.size === 0) this.clients.delete(sessionId);
  }
}
