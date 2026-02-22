import type { NormalizedMessage, PermissionModeCommon, ApprovalDecision, SlashCommand } from "./providers/types.js";
import type { WebSocket } from "ws";

export type SessionStatus =
  | "idle" | "starting" | "running" | "waiting_for_approval"
  | "completed" | "interrupted" | "error" | "history";

export interface Session {
  id: string;
  provider: string;
  providerSessionId?: string;
  status: SessionStatus;
  createdAt: Date;
  lastActivityAt: Date;
  permissionMode: PermissionModeCommon;
  model: string | undefined;
  cwd: string;
  abortController: AbortController;
  messages: NormalizedMessage[];
  slashCommands: SlashCommand[];
  totalCostUsd: number;
  numTurns: number;
  lastError: string | null;
  pendingApproval: PendingApproval | null;
  alwaysAllowedTools: Set<string>;
  clients: Set<WebSocket>;
}

/** Serializable session representation for API responses (no internal handles). */
export interface SessionDTO {
  id: string;
  status: SessionStatus;
  createdAt: string;
  permissionMode: PermissionModeCommon;
  model: string | undefined;
  cwd: string;
  numTurns: number;
  totalCostUsd: number;
  lastError: string | null;
  messages: NormalizedMessage[];
  slashCommands: SlashCommand[];
  pendingApproval: { toolName: string; toolUseId: string; input: unknown } | null;
}

/** Summary returned by GET /api/sessions (list endpoint). */
export interface SessionSummaryDTO {
  id: string;
  status: SessionStatus;
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
  | { type: "status"; status: SessionStatus; error?: string }
  | { type: "slash_commands"; commands: SlashCommand[] }
  | { type: "thinking_delta"; text: string }
  | { type: "replay_complete" }
  | { type: "ping" }
  | { type: "error"; message: string };

export interface CreateSessionRequest {
  prompt?: string;
  permissionMode?: PermissionModeCommon;
  provider?: string;
  model?: string;
  cwd?: string;
  allowedTools?: string[];
  resumeSessionId?: string;
}
