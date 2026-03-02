import type { SessionStatus } from "./schemas/sessions.js";
import type { NormalizedMessage } from "./providers/types.js";
import type { ServerMessage } from "./types.js";

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
