// server/ui/src/stores/webhooks.ts
import { create } from "zustand";
import { useAuthStore } from "./auth";

// NOTE: This list must match server/src/schemas/webhooks.ts WEBHOOK_EVENT_TYPES.
// The UI bundle cannot import from the server schema directly (different package).
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

export interface CreateWebhookInput {
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
      if (res.status === 401) { useAuthStore.getState().logout(); return; }
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
      if (res.status === 401) { useAuthStore.getState().logout(); return null; }
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
      if (res.status === 401) { useAuthStore.getState().logout(); return null; }
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
      if (res.status === 401) { useAuthStore.getState().logout(); return false; }
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
      if (res.status === 401) { useAuthStore.getState().logout(); return; }
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
