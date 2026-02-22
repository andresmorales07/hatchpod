# UI Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite the Hatchpod web UI as a modern, mobile-friendly, installable PWA with Zustand state management and React Router navigation.

**Architecture:** Zustand stores replace local state for auth, sessions, and messages/WebSocket. React Router v7 hash router provides deep-linkable routes — full-page navigation on mobile, persistent sidebar on desktop. The server API, WebSocket protocol, and `types.ts` remain unchanged.

**Tech Stack:** React 19, Zustand, React Router v7, Tailwind CSS v4, shadcn/ui, vite-plugin-pwa

**Design doc:** `docs/plans/2026-02-21-ui-redesign-design.md`

**Branch:** `feature/ui-redesign`

---

## Task 1: Install New Dependencies

**Files:**
- Modify: `server/ui/package.json`

**Step 1: Install zustand, react-router-dom, vite-plugin-pwa**

```bash
cd server/ui && npm install zustand react-router-dom && npm install -D vite-plugin-pwa
```

**Step 2: Verify installation**

```bash
cd server/ui && npx tsc --noEmit
```

Expected: No errors (new deps are installed but not yet imported).

**Step 3: Commit**

```bash
git add server/ui/package.json server/ui/package-lock.json
git commit -m "chore(ui): add zustand, react-router-dom, vite-plugin-pwa"
```

---

## Task 2: Zustand Auth Store

**Files:**
- Create: `server/ui/src/stores/auth.ts`
- Test: Manual — login flow still works after integration

**Step 1: Create auth store**

Create `server/ui/src/stores/auth.ts`:

```typescript
import { create } from "zustand";

interface AuthState {
  token: string;
  authenticated: boolean;
  setToken: (token: string) => void;
  login: () => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: localStorage.getItem("api_token") ?? "",
  authenticated: false,
  setToken: (token) => set({ token }),
  login: () => {
    const token = useAuthStore.getState().token;
    localStorage.setItem("api_token", token);
    set({ authenticated: true });
  },
  logout: () => {
    localStorage.removeItem("api_token");
    set({ token: "", authenticated: false });
  },
}));
```

**Step 2: Verify types compile**

```bash
cd server/ui && npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add server/ui/src/stores/auth.ts
git commit -m "feat(ui): add Zustand auth store"
```

---

## Task 3: Zustand Sessions Store

**Files:**
- Create: `server/ui/src/stores/sessions.ts`

**Step 1: Create sessions store**

Create `server/ui/src/stores/sessions.ts`. This replaces the session fetching logic from `SessionList.tsx` and the `startSession`/`resumeSession` callbacks from `App.tsx`:

```typescript
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
```

**Step 2: Verify types compile**

```bash
cd server/ui && npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add server/ui/src/stores/sessions.ts
git commit -m "feat(ui): add Zustand sessions store"
```

---

## Task 4: Zustand Messages Store + WebSocket

**Files:**
- Create: `server/ui/src/stores/messages.ts`

**Step 1: Create messages store**

Create `server/ui/src/stores/messages.ts`. This refactors the logic from `hooks/useSession.ts` into a Zustand store with imperative WebSocket management:

```typescript
import { create } from "zustand";
import { useAuthStore } from "./auth";
import type { NormalizedMessage, SlashCommand } from "../types";

type ServerMessage =
  | { type: "message"; message: NormalizedMessage }
  | { type: "tool_approval_request"; toolName: string; toolUseId: string; input: unknown }
  | { type: "status"; status: string; error?: string }
  | { type: "slash_commands"; commands: SlashCommand[] }
  | { type: "thinking_delta"; text: string }
  | { type: "replay_complete" }
  | { type: "ping" }
  | { type: "error"; message: string; error?: string };

interface PendingApproval {
  toolName: string;
  toolUseId: string;
  input: unknown;
}

interface MessagesState {
  messages: NormalizedMessage[];
  status: string;
  connected: boolean;
  pendingApproval: PendingApproval | null;
  slashCommands: SlashCommand[];
  thinkingText: string;
  thinkingStartTime: number | null;
  thinkingDurations: Record<number, number>;

  // Actions
  connect: (sessionId: string) => void;
  disconnect: () => void;
  sendPrompt: (text: string) => void;
  approve: (toolUseId: string, answers?: Record<string, string>) => void;
  approveAlways: (toolUseId: string) => void;
  deny: (toolUseId: string, message?: string) => void;
  interrupt: () => void;
}

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_MS = 1000;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempts = 0;
let thinkingStart: number | null = null;
let messageCount = 0;
let currentSessionId: string | null = null;

function send(msg: unknown) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export const useMessagesStore = create<MessagesState>((set, get) => ({
  messages: [],
  status: "starting",
  connected: false,
  pendingApproval: null,
  slashCommands: [],
  thinkingText: "",
  thinkingStartTime: null,
  thinkingDurations: {},

  connect: (sessionId: string) => {
    // Clean up previous connection
    get().disconnect();
    currentSessionId = sessionId;
    messageCount = 0;
    thinkingStart = null;
    set({
      messages: [],
      status: "starting",
      connected: false,
      pendingApproval: null,
      slashCommands: [],
      thinkingText: "",
      thinkingStartTime: null,
      thinkingDurations: {},
    });

    const doConnect = () => {
      if (currentSessionId !== sessionId) return;
      const { token } = useAuthStore.getState();
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${location.host}/api/sessions/${sessionId}/stream`);

      socket.onopen = () => {
        socket.send(JSON.stringify({ type: "auth", token }));
        set({ connected: true });
        reconnectAttempts = 0;
      };

      socket.onmessage = (event) => {
        let msg: ServerMessage;
        try { msg = JSON.parse(event.data); } catch { return; }

        switch (msg.type) {
          case "message": {
            const m = msg.message;
            const msgIdx = messageCount;
            messageCount++;
            if (m.role === "assistant" && m.parts.some((p) => p.type === "reasoning")) {
              if (thinkingStart != null) {
                const duration = Date.now() - thinkingStart;
                set((s) => ({ thinkingDurations: { ...s.thinkingDurations, [msgIdx]: duration } }));
              }
              thinkingStart = null;
              set({ thinkingText: "", thinkingStartTime: null });
            }
            set((s) => ({ messages: [...s.messages, m] }));
            break;
          }
          case "status":
            set({ status: msg.status });
            if (msg.status !== "running") {
              thinkingStart = null;
              set({ thinkingText: "", thinkingStartTime: null });
            }
            break;
          case "thinking_delta":
            set((s) => ({ thinkingText: s.thinkingText + msg.text }));
            if (thinkingStart == null) thinkingStart = Date.now();
            set({ thinkingStartTime: thinkingStart });
            break;
          case "tool_approval_request":
            set({ pendingApproval: { toolName: msg.toolName, toolUseId: msg.toolUseId, input: msg.input } });
            break;
          case "slash_commands":
            if (Array.isArray(msg.commands)) set({ slashCommands: msg.commands });
            break;
          case "error":
            console.error("Server error:", msg.message);
            break;
        }
      };

      socket.onclose = () => {
        set({ connected: false });
        if (currentSessionId === sessionId && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          const delay = BASE_RECONNECT_MS * Math.pow(2, reconnectAttempts);
          reconnectAttempts++;
          reconnectTimer = setTimeout(doConnect, delay);
        }
      };

      socket.onerror = () => socket.close();
      ws = socket;
    };

    doConnect();
  },

  disconnect: () => {
    currentSessionId = null;
    clearTimeout(reconnectTimer);
    reconnectAttempts = 0;
    ws?.close();
    ws = null;
  },

  sendPrompt: (text) => send({ type: "prompt", text }),

  approve: (toolUseId, answers) => {
    send({ type: "approve", toolUseId, ...(answers ? { answers } : {}) });
    set({ pendingApproval: null });
  },

  approveAlways: (toolUseId) => {
    send({ type: "approve", toolUseId, alwaysAllow: true });
    set({ pendingApproval: null });
  },

  deny: (toolUseId, message) => {
    send({ type: "deny", toolUseId, message });
    set({ pendingApproval: null });
  },

  interrupt: () => send({ type: "interrupt" }),
}));
```

**Step 2: Verify types compile**

```bash
cd server/ui && npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add server/ui/src/stores/messages.ts
git commit -m "feat(ui): add Zustand messages store with WebSocket"
```

---

## Task 5: Update Theme (globals.css)

**Files:**
- Modify: `server/ui/src/globals.css`

**Step 1: Update the dark theme tokens**

Replace the `.dark { ... }` block in `globals.css` with the new neutral zinc-based palette from the design doc. Keep the `:root` (light) tokens and `@theme inline` block unchanged. The dark theme changes:

| Token | Old | New |
|-------|-----|-----|
| `--background` | `#1a1a2e` | `#0f0f17` |
| `--foreground` | `#e0e0e0` | `#fafafa` |
| `--card` | `#16213e` | `#18181b` |
| `--card-foreground` | `#e0e0e0` | `#fafafa` |
| `--popover` | `#16213e` | `#18181b` |
| `--popover-foreground` | `#e0e0e0` | `#fafafa` |
| `--primary` | `#e94560` | `#e94560` (kept) |
| `--primary-foreground` | `#ffffff` | `#ffffff` (kept) |
| `--secondary` | `#0f3460` | `#27272a` |
| `--secondary-foreground` | `#e0e0e0` | `#fafafa` |
| `--muted` | `#16213e` | `#18181b` |
| `--muted-foreground` | `#8892a4` | `#a1a1aa` |
| `--accent` | `#0f3460` | `#27272a` |
| `--accent-foreground` | `#e0e0e0` | `#fafafa` |
| `--destructive` | `#f87171` | `#f87171` (kept) |
| `--border` | `#1a3a5c` | `#27272a` |
| `--input` | `#0f3460` | `#18181b` |
| `--ring` | `#e94560` | `#e94560` (kept) |
| sidebar tokens | navy-based | match new card/border values |

**Step 2: Verify the build still works**

```bash
cd server/ui && npx vite build
```

**Step 3: Commit**

```bash
git add server/ui/src/globals.css
git commit -m "feat(ui): update dark theme to neutral zinc palette"
```

---

## Task 6: PWA Configuration

**Files:**
- Modify: `server/ui/vite.config.ts`
- Modify: `server/ui/index.html`
- Create: `server/ui/public/icons/icon-192.png`
- Create: `server/ui/public/icons/icon-512.png`

**Step 1: Configure vite-plugin-pwa**

Update `vite.config.ts` to add the PWA plugin:

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Hatchpod",
        short_name: "Hatchpod",
        display: "standalone",
        theme_color: "#0f0f17",
        background_color: "#0f0f17",
        start_url: "/",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
        navigateFallback: "/index.html",
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: "NetworkFirst",
            options: { cacheName: "api-cache", expiration: { maxEntries: 50, maxAgeSeconds: 300 } },
          },
        ],
      },
    }),
  ],
  root: ".",
  build: {
    outDir: "../public",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          "syntax-highlight": ["react-syntax-highlighter"],
          "markdown": ["react-markdown", "remark-gfm"],
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/healthz": "http://localhost:8080",
    },
  },
});
```

**Step 2: Update index.html meta tags**

Add to `<head>`:
```html
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="theme-color" content="#0f0f17" />
<link rel="apple-touch-icon" href="/icons/icon-192.png" />
```

**Step 3: Generate placeholder icons**

Use a simple SVG-to-PNG approach or create minimal placeholder icons. These can be replaced with proper branding later. For now, create simple solid-color icons with "H" text:

```bash
# Create icons directory
mkdir -p server/ui/public/icons

# Generate simple placeholder icons using a canvas script or just copy placeholders
# For now, create minimal SVG-based icons that Vite will serve
```

Create `server/ui/public/icons/icon.svg` as the source:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#0f0f17"/>
  <text x="256" y="340" text-anchor="middle" font-family="system-ui" font-size="320" font-weight="bold" fill="#e94560">H</text>
</svg>
```

Then use this SVG as both icon sizes (browsers handle SVG scaling). Update manifest to reference SVG or convert to PNG using a tool.

**Step 4: Verify build**

```bash
cd server/ui && npx vite build
```

Verify `server/public/` contains `manifest.webmanifest` and service worker files.

**Step 5: Commit**

```bash
git add server/ui/vite.config.ts server/ui/index.html server/ui/public/icons/
git commit -m "feat(ui): add PWA manifest, service worker, and app icons"
```

---

## Task 7: useMediaQuery Hook

**Files:**
- Create: `server/ui/src/hooks/useMediaQuery.ts`

**Step 1: Create the hook**

```typescript
import { useState, useEffect } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", handler);
    setMatches(mql.matches);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return matches;
}

export function useIsDesktop(): boolean {
  return useMediaQuery("(min-width: 768px)");
}
```

**Step 2: Commit**

```bash
git add server/ui/src/hooks/useMediaQuery.ts
git commit -m "feat(ui): add useMediaQuery and useIsDesktop hooks"
```

---

## Task 8: LoginPage Component

**Files:**
- Create: `server/ui/src/pages/LoginPage.tsx`

**Step 1: Create LoginPage**

This extracts and enhances the login form from `App.tsx`. It uses the auth store and navigates on success:

```typescript
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "@/stores/auth";
import { useSessionsStore } from "@/stores/sessions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function LoginPage() {
  const { token, setToken, login } = useAuthStore();
  const fetchConfig = useSessionsStore((s) => s.fetchConfig);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch("/api/sessions", { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        login();
        await fetchConfig();
        navigate("/");
      } else if (res.status === 401) {
        setError("Invalid password");
      } else {
        setError(`Server error (${res.status})`);
      }
    } catch {
      setError("Unable to reach server — check your connection");
    }
  };

  return (
    <div className="flex items-center justify-center h-dvh p-4">
      <form
        className="bg-card p-8 rounded-xl border border-border w-full max-w-[360px] flex flex-col gap-4 shadow-lg"
        onSubmit={handleSubmit}
      >
        <h1 className="text-2xl font-bold text-center text-primary">Hatchpod</h1>
        <p className="text-sm text-muted-foreground text-center">Enter your API password to connect</p>
        <Input
          type="password"
          placeholder="API Password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoFocus
        />
        <Button type="submit" className="w-full">Connect</Button>
        {error && <p className="text-destructive text-sm text-center">{error}</p>}
      </form>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add server/ui/src/pages/LoginPage.tsx
git commit -m "feat(ui): add LoginPage with auth store integration"
```

---

## Task 9: SessionCard Component

**Files:**
- Create: `server/ui/src/components/SessionCard.tsx`

**Step 1: Create SessionCard**

Individual session item with status dot, date grouping support, and proper touch targets:

```typescript
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

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

interface Props {
  session: SessionSummary;
  isActive: boolean;
  onClick: () => void;
}

const statusDot: Record<string, string> = {
  idle: "bg-emerald-400",
  running: "bg-amber-400 animate-pulse",
  starting: "bg-amber-400 animate-pulse",
  error: "bg-red-400",
  completed: "bg-zinc-500",
  history: "border border-zinc-500 bg-transparent",
};

function relativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function sessionDisplayName(s: SessionSummary): string {
  if (s.slug) return s.slug;
  if (s.summary) return s.summary;
  return s.id.slice(0, 8);
}

export function SessionCard({ session, isActive, onClick }: Props) {
  return (
    <button
      className={cn(
        "w-full flex items-center gap-3 px-4 py-3 text-left transition-colors",
        "hover:bg-accent/50 active:bg-accent",
        isActive && "bg-accent border-l-2 border-l-primary"
      )}
      onClick={onClick}
    >
      <span className={cn("w-2 h-2 rounded-full shrink-0", statusDot[session.status] ?? "bg-zinc-500")} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{sessionDisplayName(session)}</div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {relativeTime(session.lastModified || session.createdAt)}
          {session.numTurns > 0 && ` · ${session.numTurns} turns`}
        </div>
      </div>
      {session.hasPendingApproval && (
        <Badge variant="destructive" className="text-[0.625rem] px-1.5 py-0 shrink-0">!</Badge>
      )}
    </button>
  );
}
```

**Step 2: Commit**

```bash
git add server/ui/src/components/SessionCard.tsx
git commit -m "feat(ui): add SessionCard component with status dots"
```

---

## Task 10: Sidebar Component (Desktop)

**Files:**
- Create: `server/ui/src/components/Sidebar.tsx`

**Step 1: Create Sidebar**

Desktop sidebar with search, date-grouped sessions, folder picker, and new session button:

```typescript
import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useSessionsStore } from "@/stores/sessions";
import { SessionCard } from "./SessionCard";
import { FolderPicker } from "./FolderPicker";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search } from "lucide-react";

function groupByDate(sessions: { id: string; lastModified: string; createdAt: string }[]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86400000;
  const weekAgo = today - 7 * 86400000;

  const groups: { label: string; items: typeof sessions }[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "This Week", items: [] },
    { label: "Older", items: [] },
  ];

  for (const s of sessions) {
    const t = new Date(s.lastModified || s.createdAt).getTime();
    if (t >= today) groups[0].items.push(s);
    else if (t >= yesterday) groups[1].items.push(s);
    else if (t >= weekAgo) groups[2].items.push(s);
    else groups[3].items.push(s);
  }

  return groups.filter((g) => g.items.length > 0);
}

export function Sidebar() {
  const { sessions, activeSessionId, searchQuery, setActiveSession, setSearchQuery, fetchSessions, cwd, browseRoot, setCwd } = useSessionsStore();
  const navigate = useNavigate();

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 5000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return sessions;
    const q = searchQuery.toLowerCase();
    return sessions.filter((s) => {
      const name = s.slug || s.summary || s.id;
      return name.toLowerCase().includes(q);
    });
  }, [sessions, searchQuery]);

  const groups = useMemo(() => groupByDate(filtered), [filtered]);

  const handleSelect = (id: string, status: string) => {
    if (status === "history") {
      useSessionsStore.getState().resumeSession(id).then((newId) => {
        if (newId) navigate(`/session/${newId}`);
      });
    } else {
      setActiveSession(id);
      navigate(`/session/${id}`);
    }
  };

  return (
    <div className="flex flex-col h-full w-[280px] border-r border-border bg-card">
      <FolderPicker cwd={cwd} browseRoot={browseRoot} onCwdChange={setCwd} />
      <div className="px-3 py-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Search sessions..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-8 text-sm"
          />
        </div>
      </div>
      <ScrollArea className="flex-1">
        {groups.map((group) => (
          <div key={group.label}>
            <div className="px-4 py-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
              {group.label}
            </div>
            {group.items.map((s) => (
              <SessionCard
                key={s.id}
                session={s as any}
                isActive={s.id === activeSessionId}
                onClick={() => handleSelect(s.id, (s as any).status)}
              />
            ))}
          </div>
        ))}
        {sessions.length === 0 && (
          <p className="px-4 py-8 text-sm text-muted-foreground text-center">No sessions yet</p>
        )}
      </ScrollArea>
      <div className="p-3 border-t border-border">
        <Button className="w-full" size="sm" onClick={() => navigate("/new")}>
          <Plus className="size-4 mr-2" /> New Session
        </Button>
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add server/ui/src/components/Sidebar.tsx
git commit -m "feat(ui): add Sidebar with search and date-grouped sessions"
```

---

## Task 11: Rewrite FolderPicker

**Files:**
- Modify: `server/ui/src/components/FolderPicker.tsx`

**Step 1: Rewrite FolderPicker**

Simplified version that uses the auth store for the token and works as a dropdown in both sidebar and header contexts:

```typescript
import { useState, useEffect, useCallback } from "react";
import { useAuthStore } from "@/stores/auth";
import { cn } from "@/lib/utils";
import { ChevronRight, FolderOpen } from "lucide-react";

interface Props {
  cwd: string;
  browseRoot: string;
  onCwdChange: (cwd: string) => void;
}

export function FolderPicker({ cwd, browseRoot, onCwdChange }: Props) {
  const token = useAuthStore((s) => s.token);
  const [open, setOpen] = useState(false);
  const [dirs, setDirs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const rootName = browseRoot.split("/").filter(Boolean).pop() ?? "root";
  const relPath = cwd.startsWith(browseRoot) ? cwd.slice(browseRoot.length).replace(/^\//, "") : "";
  const segments = relPath ? relPath.split("/") : [];

  const fetchDirs = useCallback(async (rel: string) => {
    setLoading(true);
    try {
      const params = rel ? `?path=${encodeURIComponent(rel)}` : "";
      const res = await fetch(`/api/browse${params}`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const body = await res.json();
        setDirs(body.dirs);
      } else {
        setDirs([]);
      }
    } catch {
      setDirs([]);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (open) fetchDirs(relPath);
  }, [open, relPath, fetchDirs]);

  const navigateTo = (rel: string) => {
    onCwdChange(rel ? `${browseRoot}/${rel}` : browseRoot);
  };

  if (!browseRoot) return null;

  return (
    <div className="border-b border-border">
      <button
        className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left hover:bg-accent/50 transition-colors"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <FolderOpen className="size-4 text-muted-foreground shrink-0" />
        <span className="flex items-center gap-0.5 min-w-0 overflow-hidden font-mono text-xs">
          <span
            className={cn("cursor-pointer hover:text-primary", segments.length === 0 ? "text-foreground" : "text-muted-foreground")}
            onClick={(e) => { e.stopPropagation(); navigateTo(""); }}
          >
            {rootName}
          </span>
          {segments.map((seg, i) => (
            <span key={i} className="flex items-center">
              <ChevronRight className="size-3 text-muted-foreground mx-0.5" />
              <span
                className={cn("cursor-pointer hover:text-primary", i === segments.length - 1 ? "text-foreground" : "text-muted-foreground")}
                onClick={(e) => { e.stopPropagation(); navigateTo(segments.slice(0, i + 1).join("/")); }}
              >
                {seg}
              </span>
            </span>
          ))}
        </span>
      </button>
      {open && (
        <div className="max-h-[200px] overflow-y-auto border-t border-border">
          {loading && <div className="px-3 py-2 text-xs text-muted-foreground">Loading...</div>}
          {!loading && dirs.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">No subdirectories</div>}
          {!loading && dirs.map((dir) => (
            <button
              key={dir}
              className="w-full flex items-center gap-2 px-3 py-1.5 pl-8 text-sm font-mono text-left hover:bg-accent/50 hover:text-primary transition-colors"
              onClick={() => navigateTo(relPath ? `${relPath}/${dir}` : dir)}
              type="button"
            >
              {dir}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add server/ui/src/components/FolderPicker.tsx
git commit -m "refactor(ui): rewrite FolderPicker to use auth store and lucide icons"
```

---

## Task 12: Rewrite MessageBubble

**Files:**
- Modify: `server/ui/src/components/MessageBubble.tsx`

**Step 1: Rewrite MessageBubble**

New clean layout: no borders on assistant text, collapsible tool cards, centered column:

```typescript
import { useState } from "react";
import type { NormalizedMessage, MessagePart } from "../types";
import { ThinkingBlock } from "./ThinkingBlock";
import { Markdown } from "./Markdown";
import { cn } from "@/lib/utils";
import { ChevronDown, Wrench, AlertCircle } from "lucide-react";

interface Props {
  message: NormalizedMessage;
  thinkingDurationMs: number | null;
}

function ToolCard({ part }: { part: { type: "tool_use"; toolName: string; input: unknown } | { type: "tool_result"; output: string } }) {
  const [expanded, setExpanded] = useState(false);
  const isUse = part.type === "tool_use";
  const label = isUse ? part.toolName : "Result";
  const content = isUse ? JSON.stringify(part.input, null, 2) : part.output;
  const preview = content.length > 120 ? content.slice(0, 117) + "..." : content;

  return (
    <div className="rounded-lg border border-border bg-card/50 overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <Wrench className="size-3.5 text-amber-400 shrink-0" />
        <span className="text-sm font-medium text-amber-400">{label}</span>
        <ChevronDown className={cn("size-3.5 text-muted-foreground ml-auto transition-transform", expanded && "rotate-180")} />
      </button>
      <div className="px-3 pb-2">
        <pre className="whitespace-pre-wrap font-mono text-xs leading-snug text-muted-foreground max-h-[300px] overflow-y-auto">
          {expanded ? content : preview}
        </pre>
      </div>
    </div>
  );
}

function renderPart(part: MessagePart, i: number, thinkingDurationMs: number | null) {
  switch (part.type) {
    case "text":
      return (
        <div key={i} className="text-sm leading-relaxed">
          <Markdown>{part.text}</Markdown>
        </div>
      );
    case "tool_use":
      return <ToolCard key={i} part={part} />;
    case "tool_result":
      return <ToolCard key={i} part={part} />;
    case "reasoning":
      return <ThinkingBlock key={i} text={part.text} durationMs={thinkingDurationMs} />;
    case "error":
      return (
        <div key={i} className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm">
          <AlertCircle className="size-4 shrink-0 mt-0.5" />
          {part.message}
        </div>
      );
    default:
      return null;
  }
}

export function MessageBubble({ message, thinkingDurationMs }: Props) {
  if (message.role === "user") {
    const text = message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    if (!text) return null;
    return (
      <div className="flex justify-end">
        <div className="px-4 py-2.5 rounded-2xl rounded-br-md bg-secondary text-sm max-w-[85%] md:max-w-[70%] break-words">
          {text}
        </div>
      </div>
    );
  }

  if (message.role === "assistant") {
    return (
      <div className="flex flex-col gap-2 max-w-[85%] md:max-w-[70%]">
        {message.parts.map((part, i) => renderPart(part, i, thinkingDurationMs))}
      </div>
    );
  }

  if (message.role === "system" && message.event.type === "session_result") {
    return (
      <div className="flex justify-center">
        <div className="text-xs text-muted-foreground bg-card/50 border border-border rounded-full px-4 py-1.5">
          Session completed · ${message.event.totalCostUsd.toFixed(4)} · {message.event.numTurns} turns
        </div>
      </div>
    );
  }

  return null;
}
```

**Step 2: Commit**

```bash
git add server/ui/src/components/MessageBubble.tsx
git commit -m "refactor(ui): rewrite MessageBubble with collapsible tool cards"
```

---

## Task 13: Composer Component

**Files:**
- Create: `server/ui/src/components/Composer.tsx`

**Step 1: Create Composer**

Floating input area with slash commands, extracted from ChatView:

```typescript
import { useState, useCallback, useMemo } from "react";
import TextareaAutosize from "react-textarea-autosize";
import { SlashCommandDropdown, getFilteredCommands } from "./SlashCommandDropdown";
import { Button } from "@/components/ui/button";
import { Send, Square } from "lucide-react";
import type { SlashCommand } from "../types";

interface Props {
  slashCommands: SlashCommand[];
  isDisabled: boolean;
  isRunning: boolean;
  onSend: (text: string) => void;
  onInterrupt: () => void;
}

export function Composer({ slashCommands, isDisabled, isRunning, onSend, onInterrupt }: Props) {
  const [input, setInput] = useState("");
  const [dropdownIndex, setDropdownIndex] = useState(0);

  const filtered = useMemo(
    () => slashCommands.length > 0 ? getFilteredCommands(slashCommands, input) : [],
    [slashCommands, input],
  );
  const dropdownVisible = filtered.length > 0;

  const selectCommand = useCallback((cmd: SlashCommand) => {
    setInput(`/${cmd.name} `);
  }, []);

  const handleSubmit = () => {
    if (!input.trim()) return;
    onSend(input.trim());
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (dropdownVisible) {
      if (e.key === "ArrowDown") { e.preventDefault(); setDropdownIndex((p) => Math.min(p + 1, filtered.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setDropdownIndex((p) => Math.max(p - 1, 0)); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        if (filtered[dropdownIndex]) selectCommand(filtered[dropdownIndex]);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); setInput(""); return; }
    } else {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
    }
  };

  return (
    <div className="relative shrink-0 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
      {dropdownVisible && (
        <SlashCommandDropdown commands={filtered} activeIndex={dropdownIndex} onSelect={selectCommand} />
      )}
      <div className="flex items-end gap-2 rounded-xl border border-border bg-card p-2 shadow-lg">
        <TextareaAutosize
          value={input}
          onChange={(e) => { setInput(e.target.value); setDropdownIndex(0); }}
          onKeyDown={handleKeyDown}
          placeholder="Send a message..."
          minRows={1}
          maxRows={8}
          disabled={isDisabled}
          className="flex-1 px-2 py-1.5 bg-transparent text-foreground text-sm font-[inherit] resize-none outline-none leading-snug placeholder:text-muted-foreground disabled:opacity-50"
        />
        {isRunning ? (
          <Button size="icon-sm" variant="destructive" onClick={onInterrupt} className="rounded-lg shrink-0">
            <Square className="size-4" />
          </Button>
        ) : (
          <Button size="icon-sm" onClick={handleSubmit} disabled={!input.trim()} className="rounded-lg shrink-0">
            <Send className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add server/ui/src/components/Composer.tsx
git commit -m "feat(ui): add Composer component with floating input design"
```

---

## Task 14: Rewrite ToolApproval

**Files:**
- Modify: `server/ui/src/components/ToolApproval.tsx`

**Step 1: Rewrite ToolApproval**

Keep the existing AskUserQuestion logic but update the visual design to match the new theme. The main changes are styling — the functional logic stays the same. Update the wrapper styling:

- Tool approval: sticky bar with rounded card, above composer
- AskUserQuestion: same card treatment with updated colors
- Use lucide icons for visual indicators
- Better mobile touch targets (min 44px height buttons)

The existing code is well-structured — the main changes are:
1. Replace `border-2 border-amber-400` with `border border-border shadow-lg`
2. Use `rounded-xl` for card consistency
3. Increase button sizes for mobile touch targets
4. Add `Shield` icon from lucide for tool approval header

**Step 2: Commit**

```bash
git add server/ui/src/components/ToolApproval.tsx
git commit -m "refactor(ui): update ToolApproval styling for new design"
```

---

## Task 15: ChatPage Component

**Files:**
- Create: `server/ui/src/pages/ChatPage.tsx`

**Step 1: Create ChatPage**

This replaces `ChatView.tsx` as the main chat view page. It connects to the messages store and composes MessageBubble, Composer, ToolApproval, and ThinkingIndicator:

```typescript
import { useEffect, useRef, useCallback, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useMessagesStore } from "@/stores/messages";
import { useSessionsStore } from "@/stores/sessions";
import { useIsDesktop } from "@/hooks/useMediaQuery";
import { MessageBubble } from "@/components/MessageBubble";
import { ToolApproval } from "@/components/ToolApproval";
import { ThinkingIndicator } from "@/components/ThinkingIndicator";
import { Composer } from "@/components/Composer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowDown, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

const statusStyles: Record<string, string> = {
  idle: "bg-emerald-500/15 text-emerald-400 border-transparent",
  running: "bg-amber-500/15 text-amber-400 border-transparent",
  starting: "bg-amber-500/15 text-amber-400 border-transparent",
  error: "bg-red-400/15 text-red-400 border-transparent",
  disconnected: "bg-red-400/15 text-red-400 border-transparent",
  completed: "bg-muted-foreground/15 text-muted-foreground border-transparent",
  history: "bg-muted-foreground/10 text-muted-foreground italic border-transparent",
};

const SCROLL_THRESHOLD = 100;

export function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  const {
    messages, slashCommands, status, connected, pendingApproval,
    thinkingText, thinkingStartTime, thinkingDurations,
    connect, disconnect, sendPrompt, approve, approveAlways, deny, interrupt,
  } = useMessagesStore();
  const activeSession = useSessionsStore((s) => s.sessions.find((sess) => sess.id === id));

  const [isAtBottom, setIsAtBottom] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (id) {
      useSessionsStore.getState().setActiveSession(id);
      connect(id);
    }
    return () => disconnect();
  }, [id, connect, disconnect]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (isAtBottom) scrollToBottom();
  }, [messages, thinkingText, isAtBottom, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setIsAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD);
  }, []);

  const isThinkingActive = thinkingText.length > 0 && thinkingStartTime != null;
  const isRunning = status === "running" || status === "starting";
  const sessionName = activeSession?.slug || activeSession?.summary || id?.slice(0, 8) || "Chat";

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
        {!isDesktop && (
          <Button variant="ghost" size="icon-sm" onClick={() => navigate("/")}>
            <ArrowLeft className="size-5" />
          </Button>
        )}
        <span className="text-sm font-medium truncate flex-1">{sessionName}</span>
        <Badge variant="outline" className={cn("text-xs font-semibold uppercase tracking-wide", statusStyles[status])}>
          {status}
        </Badge>
        {!connected && (
          <Badge variant="outline" className={cn("text-xs font-semibold uppercase tracking-wide", statusStyles.disconnected)}>
            offline
          </Badge>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-hidden relative">
        <div ref={scrollContainerRef} onScroll={handleScroll} className="h-full overflow-y-auto">
          <div className="max-w-3xl mx-auto px-4 py-4 flex flex-col gap-4">
            {messages.map((msg, i) => (
              <MessageBubble key={i} message={msg} thinkingDurationMs={thinkingDurations[i] ?? null} />
            ))}
            {isThinkingActive && <ThinkingIndicator thinkingText={thinkingText} startTime={thinkingStartTime!} />}
            <div ref={messagesEndRef} />
          </div>
        </div>
        {!isAtBottom && (
          <Button
            variant="secondary"
            size="icon-sm"
            className="absolute bottom-4 right-4 rounded-full shadow-lg opacity-80 hover:opacity-100"
            onClick={() => { scrollToBottom(); setIsAtBottom(true); }}
          >
            <ArrowDown className="size-4" />
          </Button>
        )}
      </div>

      {/* Tool approval */}
      {pendingApproval && (
        <ToolApproval
          toolName={pendingApproval.toolName}
          toolUseId={pendingApproval.toolUseId}
          input={pendingApproval.input}
          onApprove={approve}
          onApproveAlways={approveAlways}
          onDeny={deny}
        />
      )}

      {/* Composer */}
      <Composer
        slashCommands={slashCommands}
        isDisabled={isRunning}
        isRunning={isRunning}
        onSend={(text) => { sendPrompt(text); setIsAtBottom(true); }}
        onInterrupt={interrupt}
      />
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add server/ui/src/pages/ChatPage.tsx
git commit -m "feat(ui): add ChatPage with messages store integration"
```

---

## Task 16: SessionListPage (Mobile)

**Files:**
- Create: `server/ui/src/pages/SessionListPage.tsx`

**Step 1: Create SessionListPage**

Full-page session list for mobile, reuses SessionCard and date grouping logic:

```typescript
import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useSessionsStore } from "@/stores/sessions";
import { SessionCard } from "@/components/SessionCard";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Plus, Search } from "lucide-react";

function groupByDate(sessions: { id: string; lastModified: string; createdAt: string }[]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86400000;
  const weekAgo = today - 7 * 86400000;
  const groups: { label: string; items: typeof sessions }[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "This Week", items: [] },
    { label: "Older", items: [] },
  ];
  for (const s of sessions) {
    const t = new Date(s.lastModified || s.createdAt).getTime();
    if (t >= today) groups[0].items.push(s);
    else if (t >= yesterday) groups[1].items.push(s);
    else if (t >= weekAgo) groups[2].items.push(s);
    else groups[3].items.push(s);
  }
  return groups.filter((g) => g.items.length > 0);
}

export function SessionListPage() {
  const { sessions, activeSessionId, searchQuery, setActiveSession, setSearchQuery, fetchSessions } = useSessionsStore();
  const navigate = useNavigate();

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 5000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return sessions;
    const q = searchQuery.toLowerCase();
    return sessions.filter((s) => {
      const name = s.slug || s.summary || s.id;
      return name.toLowerCase().includes(q);
    });
  }, [sessions, searchQuery]);

  const groups = useMemo(() => groupByDate(filtered), [filtered]);

  const handleSelect = (id: string, status: string) => {
    if (status === "history") {
      useSessionsStore.getState().resumeSession(id).then((newId) => {
        if (newId) navigate(`/session/${newId}`);
      });
    } else {
      setActiveSession(id);
      navigate(`/session/${id}`);
    }
  };

  return (
    <div className="flex flex-col h-dvh">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
        <h1 className="text-lg font-bold text-primary flex-1">Hatchpod</h1>
        <Button size="icon-sm" onClick={() => navigate("/new")}>
          <Plus className="size-5" />
        </Button>
      </header>
      <div className="px-4 py-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Search sessions..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {groups.map((group) => (
          <div key={group.label}>
            <div className="px-4 py-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
              {group.label}
            </div>
            {group.items.map((s) => (
              <SessionCard
                key={s.id}
                session={s as any}
                isActive={s.id === activeSessionId}
                onClick={() => handleSelect(s.id, (s as any).status)}
              />
            ))}
          </div>
        ))}
        {sessions.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <p className="text-sm">No sessions yet</p>
            <Button className="mt-4" onClick={() => navigate("/new")}>
              <Plus className="size-4 mr-2" /> Create your first session
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add server/ui/src/pages/SessionListPage.tsx
git commit -m "feat(ui): add SessionListPage for mobile full-page navigation"
```

---

## Task 17: NewSessionPage

**Files:**
- Create: `server/ui/src/pages/NewSessionPage.tsx`

**Step 1: Create NewSessionPage**

Full-page (mobile) or dialog-style (desktop) new session form:

```typescript
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSessionsStore } from "@/stores/sessions";
import { FolderPicker } from "@/components/FolderPicker";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import TextareaAutosize from "react-textarea-autosize";

export function NewSessionPage() {
  const { cwd, browseRoot, setCwd, createSession } = useSessionsStore();
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const sessionId = await createSession({ prompt: prompt.trim() || undefined, cwd });
      if (sessionId) navigate(`/session/${sessionId}`, { replace: true });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-col h-dvh">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
        <Button variant="ghost" size="icon-sm" onClick={() => navigate(-1)}>
          <ArrowLeft className="size-5" />
        </Button>
        <h1 className="text-lg font-medium">New Session</h1>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto px-4 py-6 flex flex-col gap-6">
          <div>
            <label className="text-sm font-medium text-foreground mb-2 block">Working Directory</label>
            <div className="rounded-lg border border-border overflow-hidden">
              <FolderPicker cwd={cwd} browseRoot={browseRoot} onCwdChange={setCwd} />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium text-foreground mb-2 block">Initial Prompt (optional)</label>
            <TextareaAutosize
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What would you like to work on?"
              minRows={3}
              maxRows={10}
              className="w-full px-3 py-2 rounded-lg border border-border bg-card text-foreground text-sm font-[inherit] resize-none outline-none leading-snug focus:border-ring placeholder:text-muted-foreground"
            />
          </div>
          <Button onClick={handleCreate} disabled={creating} className="w-full" size="lg">
            {creating ? "Creating..." : "Create Session"}
          </Button>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add server/ui/src/pages/NewSessionPage.tsx
git commit -m "feat(ui): add NewSessionPage with folder picker and prompt"
```

---

## Task 18: AppShell (Desktop Layout)

**Files:**
- Create: `server/ui/src/components/AppShell.tsx`

**Step 1: Create AppShell**

Desktop layout wrapper with persistent sidebar:

```typescript
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";

export function AppShell() {
  return (
    <div className="flex h-dvh">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add server/ui/src/components/AppShell.tsx
git commit -m "feat(ui): add AppShell desktop layout wrapper"
```

---

## Task 19: Router Setup & main.tsx Rewrite

**Files:**
- Modify: `server/ui/src/main.tsx`
- Modify (replace): `server/ui/src/App.tsx`

**Step 1: Rewrite main.tsx with router**

```typescript
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { App } from "./App";
import "./globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
```

**Step 2: Rewrite App.tsx as route orchestrator**

```typescript
import { useEffect } from "react";
import { Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuthStore } from "@/stores/auth";
import { useSessionsStore } from "@/stores/sessions";
import { useIsDesktop } from "@/hooks/useMediaQuery";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/AppShell";
import { LoginPage } from "@/pages/LoginPage";
import { SessionListPage } from "@/pages/SessionListPage";
import { ChatPage } from "@/pages/ChatPage";
import { NewSessionPage } from "@/pages/NewSessionPage";

function AuthGuard({ children }: { children: React.ReactNode }) {
  const authenticated = useAuthStore((s) => s.authenticated);
  const location = useLocation();
  if (!authenticated) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}

function EmptyState() {
  return (
    <div className="flex items-center justify-center h-full text-muted-foreground">
      <p className="text-sm">Select a session or create a new one</p>
    </div>
  );
}

function DesktopRoutes() {
  return (
    <AppShell>
      <Routes>
        <Route index element={<EmptyState />} />
        <Route path="session/:id" element={<ChatPage />} />
        <Route path="new" element={<NewSessionPage />} />
      </Routes>
    </AppShell>
  );
}

function MobileRoutes() {
  return (
    <Routes>
      <Route index element={<SessionListPage />} />
      <Route path="session/:id" element={<ChatPage />} />
      <Route path="new" element={<NewSessionPage />} />
    </Routes>
  );
}

export function App() {
  const authenticated = useAuthStore((s) => s.authenticated);
  const fetchConfig = useSessionsStore((s) => s.fetchConfig);
  const isDesktop = useIsDesktop();

  useEffect(() => {
    if (authenticated) fetchConfig();
  }, [authenticated, fetchConfig]);

  return (
    <TooltipProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/*"
          element={
            <AuthGuard>
              {isDesktop ? <DesktopRoutes /> : <MobileRoutes />}
            </AuthGuard>
          }
        />
      </Routes>
    </TooltipProvider>
  );
}
```

**Step 3: Remove the globals.css import from old App.tsx** (it's now in main.tsx)

**Step 4: Verify the build compiles**

```bash
cd server/ui && npx tsc --noEmit
```

**Step 5: Commit**

```bash
git add server/ui/src/main.tsx server/ui/src/App.tsx
git commit -m "feat(ui): rewrite App with React Router and responsive layout switching"
```

---

## Task 20: Clean Up Old Files

**Files:**
- Delete: `server/ui/src/components/ChatView.tsx`
- Delete: `server/ui/src/components/SessionList.tsx`
- Delete: `server/ui/src/hooks/useSession.ts`

**Step 1: Remove replaced files**

These are fully replaced by the new stores and page components:
- `ChatView.tsx` → replaced by `pages/ChatPage.tsx`
- `SessionList.tsx` → replaced by `components/Sidebar.tsx` + `pages/SessionListPage.tsx`
- `hooks/useSession.ts` → replaced by `stores/messages.ts`

```bash
git rm server/ui/src/components/ChatView.tsx server/ui/src/components/SessionList.tsx server/ui/src/hooks/useSession.ts
```

**Step 2: Verify build**

```bash
cd server/ui && npx tsc --noEmit
```

Fix any remaining import references if the compiler reports errors.

**Step 3: Commit**

```bash
git commit -m "chore(ui): remove old ChatView, SessionList, useSession (replaced)"
```

---

## Task 21: Build & Visual Test

**Files:**
- Modify: `server/dist/` (rebuilt)

**Step 1: Build the UI**

```bash
cd server/ui && npm run build
```

**Step 2: Build the server**

```bash
cd server && npm run build
```

**Step 3: Start dev server and visually verify**

```bash
cd server/ui && npx vite --open
```

Verify:
1. Login page renders with updated theme
2. After login, desktop shows sidebar + empty state
3. Creating a new session navigates to chat view
4. Messages render with new bubble styles
5. Mobile viewport (resize to <768px) shows full-page session list
6. Back button works from chat to session list on mobile
7. PWA manifest is served (check DevTools → Application → Manifest)

**Step 4: Rebuild dist and commit**

```bash
cd server && npm run build
git add server/ui/ server/dist/ server/public/
git commit -m "feat(ui): complete UI redesign build"
```

---

## Task 22: Update Playwright Tests

**Files:**
- Modify: `tests/web-ui.spec.ts`
- Modify: `tests/static.spec.ts`

**Step 1: Update selectors in web-ui tests**

The login page structure is similar but may have new classes/text. Update any selectors that reference old classes. Key changes:
- Login form now has `<p>` subtitle text
- Hash router means URLs are `/#/login`, `/#/session/...`
- Session list page has different structure on mobile viewport

**Step 2: Update static tests**

Add check for PWA manifest file:
```typescript
test("serves PWA manifest", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.ok()).toBeTruthy();
  const manifest = await res.json();
  expect(manifest.name).toBe("Hatchpod");
});
```

**Step 3: Run tests to verify**

```bash
npx playwright test tests/web-ui.spec.ts tests/static.spec.ts
```

**Step 4: Commit**

```bash
git add tests/
git commit -m "test: update Playwright tests for redesigned UI"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Install dependencies | package.json |
| 2 | Auth store | stores/auth.ts |
| 3 | Sessions store | stores/sessions.ts |
| 4 | Messages store + WS | stores/messages.ts |
| 5 | Theme update | globals.css |
| 6 | PWA config | vite.config.ts, index.html, icons |
| 7 | useMediaQuery hook | hooks/useMediaQuery.ts |
| 8 | LoginPage | pages/LoginPage.tsx |
| 9 | SessionCard | components/SessionCard.tsx |
| 10 | Sidebar (desktop) | components/Sidebar.tsx |
| 11 | FolderPicker rewrite | components/FolderPicker.tsx |
| 12 | MessageBubble rewrite | components/MessageBubble.tsx |
| 13 | Composer | components/Composer.tsx |
| 14 | ToolApproval update | components/ToolApproval.tsx |
| 15 | ChatPage | pages/ChatPage.tsx |
| 16 | SessionListPage | pages/SessionListPage.tsx |
| 17 | NewSessionPage | pages/NewSessionPage.tsx |
| 18 | AppShell | components/AppShell.tsx |
| 19 | Router + App rewrite | main.tsx, App.tsx |
| 20 | Clean up old files | remove 3 files |
| 21 | Build & visual test | dist rebuild |
| 22 | Update Playwright tests | tests/ |
