# UI Redesign — Design Document

**Date:** 2026-02-21
**Goal:** Complete mobile-friendly redesign of the Hatchpod web UI as an installable PWA with modern chat-app aesthetics.

## Context

The current UI was built as an MVP: a sidebar + chat layout with minimal mobile support (hamburger toggle), no PWA capabilities, and functional but basic message rendering. This redesign targets full mobile interaction parity, improved visual hierarchy, and installability.

## Architecture

### State Management: Zustand

- `useAuthStore` — token, authenticated state, login/logout actions
- `useSessionStore` — session list, active session ID, CRUD operations, polling
- `useMessageStore` — per-session messages, thinking state, pending approvals, WebSocket connection

The existing `useSession` WebSocket hook gets refactored to write into Zustand stores. The WebSocket protocol and server API remain unchanged.

### Routing: React Router v7 (Hash Router)

| Route | Desktop | Mobile |
|-------|---------|--------|
| `/login` | Login page | Login page |
| `/` | Sidebar + empty state | Session list (full page) |
| `/session/:id` | Sidebar + chat | Chat (full page, back button) |
| `/new` | New session dialog | New session (full page) |

Hash router avoids server-side routing configuration. Sessions are deep-linkable.

### Dependencies Added

- `zustand` — state management (~1.1kB)
- `react-router-dom` — client-side routing
- `vite-plugin-pwa` — service worker generation + manifest

## Layout

### Desktop (≥768px)

```
┌──────────────────────────────────────────────────┐
│  [≡ Hatchpod]              [cwd: ~/workspace ▾]  │
├─────────────┬────────────────────────────────────┤
│  Sessions   │                                    │
│  ─────────  │     Conversation area              │
│  🔍 Search  │     (centered, max-w ~48rem)       │
│             │                                    │
│  Today      │     Messages scroll here           │
│   Session 1 │                                    │
│  ★Session 2 │                                    │
│             │                                    │
│  Yesterday  │                                    │
│   Session 3 │                                    │
│             │                                    │
│             ├────────────────────────────────────┤
│  [+ New]    │  [Composer input area]       [Send]│
└─────────────┴────────────────────────────────────┘
```

- Sidebar: 280px, collapsible via header toggle
- Sessions grouped by date (Today, Yesterday, This Week, Older)
- Folder picker in header as dropdown

### Mobile (<768px)

Full-page navigation between views (no drawer overlay):

- **Session list**: full-page, search bar, date-grouped sessions, "+ New" button in header
- **Chat view**: full-page, back button, session name in header
- **New session**: full-page form with folder picker + prompt textarea
- Bottom-safe padding for iOS home indicator (`env(safe-area-inset-bottom)`)

## Chat Experience

### Message Rendering

- **Centered column** (max-width ~48rem) — no edge-to-edge bubbles
- **User messages**: right-aligned with subtle secondary background, rounded corners
- **Assistant text**: left-aligned, no bubble border — clean text on main background
- **Tool use**: collapsible card with tool name header, collapsed JSON input (expandable)
- **Tool results**: collapsible within same card, truncated with "Show more"
- **Thinking/reasoning**: collapsible block with animated gradient border, duration display
- **Errors**: inline red alert card
- **Code blocks**: syntax highlighted with copy button, language label
- **Session result**: subtle info card with cost/turn summary

### Composer

- Auto-growing textarea styled as floating card at bottom
- Slash command dropdown (existing functionality preserved)
- Shift+Enter for newline, Enter to send
- Mobile: grows up to 50vh, sticks above keyboard
- Stop button replaces Send when session is running

### Tool Approval

- Sticky bar above composer with tool info
- Three buttons: Approve (green), Always Allow (amber), Deny (red)
- AskUserQuestion: modal dialog on mobile, inline card on desktop
- Swipe right to approve, swipe left to deny (mobile)

## Session Management

### Session List

- Date-grouped: Today, Yesterday, This Week, Older
- Each card: name/slug, relative time, status dot + badge, provider, turn count
- History sessions show "resume" icon
- Search bar filters by name/slug
- Swipe-to-delete on mobile (with confirmation dialog)

### Status Indicators

| Status | Visual |
|--------|--------|
| Running | Pulsing amber dot |
| Idle | Solid green dot |
| Error | Solid red dot |
| Completed | Gray dot |
| History | Dashed outline dot |
| Pending approval | Orange badge with count |

### New Session Flow

- Folder picker (browse API, tree/breadcrumb style)
- Initial prompt textarea
- "Create" button

## PWA Configuration

### Web App Manifest

```json
{
  "name": "Hatchpod",
  "short_name": "Hatchpod",
  "display": "standalone",
  "theme_color": "#0f0f17",
  "background_color": "#0f0f17",
  "start_url": "/",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

### Service Worker (via vite-plugin-pwa)

- Precache app shell (HTML, JS, CSS)
- Network-first for API calls (no offline data caching)
- Cache-first for static assets (icons, fonts)

### iOS Meta Tags

- `apple-mobile-web-app-capable: yes`
- `apple-mobile-web-app-status-bar-style: black-translucent`
- Apple touch icon
- `viewport-fit=cover` for safe area insets

## Visual Design

Evolving from the current Hatchpod palette toward a modern chat-app feel:

| Token | Current | New |
|-------|---------|-----|
| Background | `#1a1a2e` | `#0f0f17` |
| Card/sidebar | `#16213e` | `#18181b` |
| Primary accent | `#e94560` | `#e94560` (kept) |
| Text primary | `#e0e0e0` | `#fafafa` |
| Text muted | `#8892a4` | `#a1a1aa` |
| Borders | `#1a3a5c` | `#27272a` |
| Secondary | `#0f3460` | `#27272a` |
| Input bg | `#0f3460` | `#18181b` |

Design goals:
- Softer, more neutral dark theme (zinc-based instead of navy-based)
- Higher text contrast for readability
- Hatchpod identity preserved through `#e94560` red accent used sparingly
- Assistant messages without borders/backgrounds for cleaner reading
- Closer to Claude.ai/ChatGPT dark mode aesthetics

## File Structure (New)

```
server/ui/src/
├── main.tsx                    # Entry + router setup
├── globals.css                 # Updated theme tokens
├── types.ts                    # Existing types (unchanged)
├── lib/
│   └── utils.ts                # cn() utility (unchanged)
├── stores/
│   ├── auth.ts                 # useAuthStore
│   ├── sessions.ts             # useSessionStore
│   └── messages.ts             # useMessageStore + WS logic
├── hooks/
│   └── useMediaQuery.ts        # Responsive breakpoint hook
├── pages/
│   ├── LoginPage.tsx           # Login form
│   ├── SessionListPage.tsx     # Mobile: full-page session list
│   ├── ChatPage.tsx            # Chat view (desktop + mobile)
│   └── NewSessionPage.tsx      # New session form
├── components/
│   ├── AppShell.tsx            # Desktop layout wrapper (sidebar + main)
│   ├── Sidebar.tsx             # Session list sidebar (desktop)
│   ├── SessionCard.tsx         # Individual session item
│   ├── MessageList.tsx         # Scrollable message container
│   ├── MessageBubble.tsx       # Message rendering (rewritten)
│   ├── Composer.tsx            # Input area with slash commands
│   ├── ToolApproval.tsx        # Tool approval bar (rewritten)
│   ├── FolderPicker.tsx        # Folder selection (rewritten)
│   ├── ThinkingBlock.tsx       # Thinking display (kept)
│   ├── ThinkingIndicator.tsx   # Thinking spinner (kept)
│   ├── Markdown.tsx            # Markdown rendering (kept)
│   ├── SlashCommandDropdown.tsx # Slash commands (kept)
│   └── ui/                     # shadcn/ui primitives (kept)
```

## What Stays the Same

- WebSocket protocol (server ↔ client message format)
- REST API endpoints
- TypeScript types (`types.ts`)
- `cn()` utility
- shadcn/ui primitives
- Markdown + syntax highlighting
- Thinking block rendering
- Server-side code (zero changes)
