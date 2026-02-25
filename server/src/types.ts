import type { NormalizedMessage, PermissionModeCommon, SlashCommand, ToolSummary } from "./providers/types.js";
import type { ApprovalDecision } from "./providers/types.js";

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
  model: string | undefined;
  abortController: AbortController;
  pendingApproval: PendingApproval | null;
  alwaysAllowedTools: Set<string>;
  status: SessionStatus;
  lastError: string | null;
}

export interface PendingApproval {
  toolName: string;
  toolUseId: string;
  input: unknown;
  resolve: (decision: ApprovalDecision) => void;
}

export type ClientMessage =
  | { type: "prompt"; text: string }
  | { type: "approve"; toolUseId: string; alwaysAllow?: boolean; answers?: Record<string, string> }
  | { type: "deny"; toolUseId: string; message?: string }
  | { type: "interrupt" };

export type ServerMessage =
  | { type: "message"; message: NormalizedMessage }
  | { type: "tool_approval_request"; toolName: string; toolUseId: string; input: unknown }
  | { type: "status"; status: SessionStatus; error?: string; source?: "api" | "cli" }
  | { type: "session_redirected"; newSessionId: string }
  | { type: "slash_commands"; commands: SlashCommand[] }
  | { type: "thinking_delta"; text: string }
  | { type: "replay_complete"; totalMessages?: number; oldestIndex?: number }
  | { type: "tasks"; tasks: Array<{ id: string; subject: string; activeForm?: string; status: string }> }
  | { type: "subagent_started"; taskId: string; toolUseId: string; description: string; agentType?: string; startedAt: number }
  | { type: "subagent_tool_call"; toolUseId: string; toolName: string; summary: ToolSummary }
  | { type: "subagent_completed"; taskId: string; toolUseId: string; status: "completed" | "failed" | "stopped"; summary: string }
  | { type: "ping" }
  | { type: "error"; message: string };
