import { create } from "zustand";
import { useAuthStore } from "./auth";

interface SessionSummary {
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
}

interface SessionsState {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  cwd: string;
  browseRoot: string;
  searchQuery: string;

  setActiveSession: (id: string | null) => void;
  setCwd: (cwd: string) => void;
  setBrowseRoot: (root: string) => void;
  setSearchQuery: (query: string) => void;
  fetchConfig: () => Promise<void>;
  fetchSessions: () => Promise<void>;
  createSession: (opts: { prompt?: string; cwd: string }) => Promise<string | null>;
  resumeSession: (historySessionId: string) => Promise<string | null>;
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  cwd: "",
  browseRoot: "",
  searchQuery: "",

  setActiveSession: (id) => set({ activeSessionId: id }),
  setCwd: (cwd) => set({ cwd }),
  setBrowseRoot: (root) => set({ browseRoot: root }),
  setSearchQuery: (query) => set({ searchQuery: query }),

  fetchConfig: async () => {
    const { token } = useAuthStore.getState();
    try {
      const res = await fetch("/api/config", { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const config = await res.json();
      if (config?.browseRoot) {
        set({ browseRoot: config.browseRoot });
        if (!get().cwd) set({ cwd: config.defaultCwd ?? config.browseRoot });
      }
    } catch {}
  },

  fetchSessions: async () => {
    const { token } = useAuthStore.getState();
    const { cwd } = get();
    try {
      const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
      const res = await fetch(`/api/sessions${params}`, { headers: { Authorization: `Bearer ${token}` } });
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
      if (res.ok) {
        const session = await res.json();
        set({ activeSessionId: session.id });
        get().fetchSessions();
        return session.id as string;
      }
    } catch (err) {
      console.error("Failed to create session:", err);
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
      if (res.ok) {
        const session = await res.json();
        set({ activeSessionId: session.id });
        get().fetchSessions();
        return session.id as string;
      }
    } catch (err) {
      console.error("Failed to resume session:", err);
    }
    return null;
  },
}));
