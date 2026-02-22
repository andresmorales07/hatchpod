import { create } from "zustand";
import { useAuthStore } from "./auth";

export interface SessionSummary {
  id: string;
  status: string;
  createdAt: string;
  lastModified: string;
  numTurns: number;
  totalCostUsd: number;
  hasPendingApproval: boolean;
  provider: string;
  slug: string | null;
  summary: string | null;
  cwd: string;
}

interface SessionsState {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  cwd: string;
  browseRoot: string;
  searchQuery: string;
  lastError: string | null;
  workspaceFilter: string | null;

  setActiveSession: (id: string | null) => void;
  setCwd: (cwd: string) => void;
  setBrowseRoot: (root: string) => void;
  setSearchQuery: (query: string) => void;
  setLastError: (error: string | null) => void;
  setWorkspaceFilter: (filter: string | null) => void;
  fetchConfig: () => Promise<void>;
  fetchSessions: () => Promise<void>;
  createSession: (opts: { prompt?: string; cwd: string }) => Promise<string | null>;
  resumeSession: (historySessionId: string) => Promise<string | null>;
  deleteSession: (id: string) => Promise<boolean>;
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  cwd: "",
  browseRoot: "",
  searchQuery: "",
  lastError: null,
  workspaceFilter: null,

  setActiveSession: (id) => set({ activeSessionId: id }),
  setCwd: (cwd) => set({ cwd }),
  setBrowseRoot: (root) => set({ browseRoot: root }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setLastError: (error) => set({ lastError: error }),
  setWorkspaceFilter: (filter) => set({ workspaceFilter: filter }),

  fetchConfig: async () => {
    const { token } = useAuthStore.getState();
    try {
      const res = await fetch("/api/config", { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) { useAuthStore.getState().logout(); return; }
      if (!res.ok) return;
      const config = await res.json();
      if (config?.browseRoot) {
        set({ browseRoot: config.browseRoot });
        if (!get().cwd) set({ cwd: config.defaultCwd ?? config.browseRoot });
      }
    } catch (err) {
      console.error("Failed to fetch config:", err);
    }
  },

  fetchSessions: async () => {
    const { token } = useAuthStore.getState();
    const { workspaceFilter } = get();
    try {
      const params = workspaceFilter ? `?cwd=${encodeURIComponent(workspaceFilter)}` : "";
      const res = await fetch(`/api/sessions${params}`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) { useAuthStore.getState().logout(); return; }
      if (res.ok) set({ sessions: await res.json() });
    } catch (err) {
      console.error("Failed to fetch sessions:", err);
    }
  },

  createSession: async ({ prompt, cwd }) => {
    const { token } = useAuthStore.getState();
    try {
      const body: Record<string, string> = { cwd };
      if (prompt) body.prompt = prompt;
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 401) { useAuthStore.getState().logout(); return null; }
      if (res.ok) {
        const session = await res.json();
        set({ activeSessionId: session.id, lastError: null });
        get().fetchSessions();
        return session.id as string;
      }
      const errBody = await res.json().catch(() => null);
      set({ lastError: errBody?.error ?? `Failed to create session (${res.status})` });
    } catch (err) {
      console.error("Failed to create session:", err);
      set({ lastError: "Unable to reach server" });
    }
    return null;
  },

  resumeSession: async (historySessionId) => {
    const { token } = useAuthStore.getState();
    const { cwd } = get();
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ resumeSessionId: historySessionId, cwd, provider: "claude" }),
      });
      if (res.status === 401) { useAuthStore.getState().logout(); return null; }
      if (res.ok) {
        const session = await res.json();
        set({ activeSessionId: session.id, lastError: null });
        get().fetchSessions();
        return session.id as string;
      }
      const errBody = await res.json().catch(() => null);
      set({ lastError: errBody?.error ?? `Failed to resume session (${res.status})` });
    } catch (err) {
      console.error("Failed to resume session:", err);
      set({ lastError: "Unable to reach server" });
    }
    return null;
  },

  deleteSession: async (id) => {
    const { token } = useAuthStore.getState();
    try {
      const res = await fetch(`/api/sessions/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) { useAuthStore.getState().logout(); return false; }
      if (res.ok) {
        get().fetchSessions();
        return true;
      }
    } catch (err) {
      console.error("Failed to delete session:", err);
    }
    return false;
  },
}));
