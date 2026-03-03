// server/ui/src/stores/claude-hooks.ts
import { create } from "zustand";
import { useAuthStore } from "./auth";

// This list must match server/src/schemas/claude-hooks.ts HOOK_EVENT_NAMES.
// The UI bundle cannot import from the server schema directly (different package).
export const HOOK_EVENT_NAMES = [
  "SessionStart", "UserPromptSubmit", "PreToolUse",
  "PermissionRequest", "PostToolUse", "PostToolUseFailure",
  "Notification", "SubagentStart", "SubagentStop",
  "Stop", "TeammateIdle", "TaskCompleted", "ConfigChange",
  "WorktreeCreate", "WorktreeRemove", "PreCompact", "SessionEnd",
] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

export interface CommandHook {
  type: "command";
  command: string;
  timeout?: number;
  async?: boolean;
  statusMessage?: string;
}

export interface HttpHook {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  timeout?: number;
  statusMessage?: string;
}

export type HookHandler = CommandHook | HttpHook;

export interface MatcherGroup {
  matcher?: string;
  hooks: HookHandler[];
}

export type HookConfig = Partial<Record<HookEventName, MatcherGroup[]>>;

export interface WorkspaceInfo {
  path: string;
  sessionCount: number;
}

interface ClaudeHooksState {
  // Scope selection
  scope: "user" | "workspace";
  workspacePath: string | null;

  // Data
  hooks: HookConfig;
  knownWorkspaces: WorkspaceInfo[];

  // Loading/error
  loading: boolean;
  error: string | null;

  // Actions
  setScope: (scope: "user" | "workspace", path?: string) => void;
  fetchHooks: () => Promise<void>;
  saveHooks: (hooks: HookConfig) => Promise<void>;
  fetchWorkspaces: () => Promise<void>;

  // Granular mutations
  addHandler: (event: HookEventName, matcher: string | undefined, handler: HookHandler) => Promise<void>;
  updateHandler: (event: HookEventName, groupIdx: number, handlerIdx: number, handler: HookHandler) => Promise<void>;
  removeHandler: (event: HookEventName, groupIdx: number, handlerIdx: number) => Promise<void>;
}

function getHeaders(): Record<string, string> {
  const token = useAuthStore.getState().token;
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function buildUrl(scope: "user" | "workspace", workspacePath: string | null): string {
  if (scope === "workspace" && workspacePath) {
    return `/api/claude-hooks/workspace?path=${encodeURIComponent(workspacePath)}`;
  }
  return "/api/claude-hooks/user";
}

export const useClaudeHooksStore = create<ClaudeHooksState>((set, get) => ({
  scope: "user",
  workspacePath: null,
  hooks: {},
  knownWorkspaces: [],
  loading: false,
  error: null,

  setScope: (scope, path) => {
    set({ scope, workspacePath: path ?? null });
    get().fetchHooks();
  },

  fetchHooks: async () => {
    const { scope, workspacePath } = get();
    set({ loading: true, error: null });
    try {
      const res = await fetch(buildUrl(scope, workspacePath), { headers: getHeaders() });
      if (res.status === 401) { useAuthStore.getState().logout(); return; }
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? res.statusText);
      }
      const hooks: HookConfig = await res.json();
      set({ hooks, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  saveHooks: async (hooks) => {
    const { scope, workspacePath } = get();
    set({ loading: true });
    try {
      const res = await fetch(buildUrl(scope, workspacePath), {
        method: "PUT",
        headers: getHeaders(),
        body: JSON.stringify(hooks),
      });
      if (res.status === 401) { useAuthStore.getState().logout(); return; }
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? res.statusText);
      }
      const saved: HookConfig = await res.json();
      set({ hooks: saved, error: null, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  fetchWorkspaces: async () => {
    // Workspace list is a secondary concern — errors go to console, not the shared error slot.
    try {
      const res = await fetch("/api/workspaces", { headers: getHeaders() });
      if (res.status === 401) { useAuthStore.getState().logout(); return; }
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? res.statusText);
      }
      const knownWorkspaces: WorkspaceInfo[] = await res.json();
      set({ knownWorkspaces });
    } catch (err) {
      console.warn("fetchWorkspaces:", (err as Error).message);
    }
  },

  addHandler: async (event, matcher, handler) => {
    const hooks = structuredClone(get().hooks);
    const groups = hooks[event] ?? [];
    // `g.matcher ?? undefined` normalizes null→undefined so strict equality
    // works correctly when matcher is undefined (no-matcher group).
    const existing = groups.find(
      (g) => (g.matcher ?? undefined) === matcher,
    );
    if (existing) {
      existing.hooks.push(handler);
    } else {
      groups.push({ matcher, hooks: [handler] });
    }
    hooks[event] = groups;
    await get().saveHooks(hooks);
  },

  updateHandler: async (event, groupIdx, handlerIdx, handler) => {
    const hooks = structuredClone(get().hooks);
    const groups = hooks[event];
    if (!groups?.[groupIdx]?.hooks[handlerIdx]) return;
    groups[groupIdx].hooks[handlerIdx] = handler;
    await get().saveHooks(hooks);
  },

  removeHandler: async (event, groupIdx, handlerIdx) => {
    const hooks = structuredClone(get().hooks);
    const groups = hooks[event];
    if (!groups?.[groupIdx]?.hooks[handlerIdx]) return;
    groups[groupIdx].hooks.splice(handlerIdx, 1);
    // Remove empty groups
    if (groups[groupIdx].hooks.length === 0) {
      groups.splice(groupIdx, 1);
    }
    // Remove empty event key
    if (groups.length === 0) {
      delete hooks[event];
    }
    await get().saveHooks(hooks);
  },
}));
