import type { NormalizedMessage, PermissionModeCommon, SlashCommand, ToolSummary, ApprovalDecision, ProviderQueryHandle } from "./providers/types.js";

// ── Serializable types — re-exported from Zod schemas ──

export type { SessionStatus, CreateSessionRequest, SessionSummaryDTO } from "./schemas/sessions.js";

import type { SessionStatus } from "./schemas/sessions.js";

// ── Non-serializable types (contain functions, AbortController, Set, callbacks) ──

/**
 * Runtime handle for API-driven sessions only.
 * No message storage — messages come from JSONL via SessionWatcher.
 * No client tracking — the watcher handles WebSocket subscriptions.
 */
export interface ActiveSession {
  sessionId: string;              // CLI session ID (from provider)
  provider: string;
  cwd: string;
  createdAt: Date;
  permissionMode: PermissionModeCommon;
  currentPermissionMode: PermissionModeCommon;
  model: string | undefined;
  effort: "low" | "medium" | "high" | "max" | undefined;
  abortController: AbortController;
  pendingApproval: PendingApproval | null;
  alwaysAllowedTools: Set<string>;
  status: SessionStatus;
  lastError: string | null;
  /** Live query handle, present while the session process is running. Used for streaming follow-up input. */
  queryHandle?: ProviderQueryHandle;
}

export interface PendingApproval {
  toolName: string;
  toolUseId: string;
  input: unknown;
  targetMode?: PermissionModeCommon;
  resolve: (decision: ApprovalDecision) => void;
}

export type ClientMessage =
  | { type: "prompt"; text: string }
  | { type: "approve"; toolUseId: string; alwaysAllow?: boolean; answers?: Record<string, string>; targetMode?: string; clearContext?: boolean }
  | { type: "deny"; toolUseId: string; message?: string }
  | { type: "interrupt" }
  | { type: "set_mode"; mode: string };

export type ServerMessage =
  | { type: "message"; message: NormalizedMessage }
  | { type: "tool_approval_request"; toolName: string; toolUseId: string; input: unknown; targetMode?: string }
  | { type: "mode_changed"; mode: PermissionModeCommon }
  | { type: "status"; status: SessionStatus; error?: string; source?: "api" | "cli" }
  | { type: "session_redirected"; newSessionId: string; fresh?: boolean }
  | { type: "slash_commands"; commands: SlashCommand[] }
  | { type: "thinking_delta"; text: string }
  | { type: "replay_complete"; totalMessages?: number; oldestIndex?: number }
  | { type: "tasks"; tasks: Array<{ id: string; subject: string; activeForm?: string; status: string }> }
  | { type: "subagent_started"; taskId: string; toolUseId: string; description: string; agentType?: string; startedAt: number }
  | { type: "subagent_tool_call"; toolUseId: string; toolName: string; summary: ToolSummary }
  | { type: "subagent_completed"; taskId: string; toolUseId: string; status: "completed" | "failed" | "stopped"; summary: string }
  | { type: "compacting"; isCompacting: boolean }
  | { type: "context_usage"; inputTokens: number; contextWindow: number; percentUsed: number }
  | { type: "tool_progress"; toolUseId: string; toolName: string; elapsedSeconds: number }
  | { type: "git_diff_stat"; files: Array<{ path: string; insertions: number; deletions: number; binary: boolean; untracked: boolean; staged: boolean }>; totalInsertions: number; totalDeletions: number; branch?: string }
  | { type: "ping" }
  | { type: "error"; message: string };

/** Shared type for context window usage data, used in both server-side watcher state and WS events. */
export type ContextUsage = { inputTokens: number; contextWindow: number; percentUsed: number };
