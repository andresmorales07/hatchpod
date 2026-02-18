import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { WebSocket } from "ws";

export interface Session {
  id: string;
  status: "starting" | "running" | "waiting_for_approval"
        | "completed" | "interrupted" | "error";
  createdAt: Date;
  permissionMode: PermissionMode;
  model: string | undefined;
  cwd: string;
  abortController: AbortController;
  messages: unknown[];
  totalCostUsd: number;
  numTurns: number;
  lastError: string | null;
  pendingApproval: PendingApproval | null;
  clients: Set<WebSocket>;
}

export interface PendingApproval {
  toolName: string;
  toolUseId: string;
  input: unknown;
  resolve: (decision: { behavior: "allow" | "deny"; message?: string }) => void;
}

export type ClientMessage =
  | { type: "prompt"; text: string }
  | { type: "approve"; toolUseId: string }
  | { type: "deny"; toolUseId: string; message?: string }
  | { type: "interrupt" };

export type ServerMessage =
  | { type: "sdk_message"; message: unknown }
  | { type: "tool_approval_request"; toolName: string; toolUseId: string; input: unknown }
  | { type: "status"; status: Session["status"]; error?: string }
  | { type: "replay_complete" }
  | { type: "ping" }
  | { type: "error"; message: string };

export interface CreateSessionRequest {
  prompt: string;
  permissionMode?: PermissionMode;
  model?: string;
  cwd?: string;
  allowedTools?: string[];
}
